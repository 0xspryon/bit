/**
 * The agent-harness seam: everything the rest of this server may assume about the thing
 * that actually runs a worker.
 *
 * This file is the whole of what a third harness has to provide, and it is deliberately
 * the *consumer's* shape rather than any implementation's. It was extracted from
 * `harness/openCodeClient.ts` when a second harness arrived, and the extraction is what
 * proved which parts of that client were the application's vocabulary and which were
 * OpenCode's: `ModelRef`'s `{ providerID, id }` pair, the `ses_`-prefixed session id and
 * the remote-MCP registration body were all OpenCode's, and none of them survived.
 *
 * ## What this demands
 *
 * Nine operations, and `run/supervisor.ts` is the only consumer that matters — what it
 * calls *is* this interface. In the order a run uses them:
 *
 * 1. {@link AgentHarness.installGate} — put a pre-execution policy gate into the workspace
 *    the session will run in. **Load-bearing: a workspace this cannot gate refuses the
 *    run.** See the section below.
 * 2. {@link AgentHarness.newSessionId} — mint a session id *we* choose, in the harness's
 *    own format, so the attempt row can name the session before the session exists.
 * 3. {@link AgentHarness.modelProvenance} — split a model name into the provider and model
 *    an attempt row records. Needed before the session is created, which is why it is a
 *    pure function here rather than something `createSession` returns.
 * 4. {@link AgentHarness.createSession} — open a session, in a directory, on a model,
 *    under the id from (2).
 * 5. {@link AgentHarness.registerMcpServer} — make our MCP endpoint reachable from that
 *    session, carrying that attempt's credential and no other's.
 * 6. {@link AgentHarness.sessionEvents} — narration, subscribed *before* prompting.
 * 7. {@link AgentHarness.prompt} — give the session its task.
 * 8. {@link AgentHarness.waitForIdle} — block until the session is no longer running.
 * 9. {@link AgentHarness.sessionStatus}, {@link AgentHarness.interruptSession},
 *    {@link AgentHarness.messages} — settle, stop, read back.
 * 10. {@link AgentHarness.unregisterMcpServer} — take the registration away again when
 *    the credential it carried is revoked.
 *
 * Plus {@link AgentHarness.instance}: which configured harness this is, so an attempt can
 * be pinned to it.
 *
 * ## What this deliberately does not demand
 *
 * - **A process.** `harness/openCodeServer.ts` owns an `opencode serve` child; the Claude
 *   Agent SDK needs no long-lived server of ours. Nothing above mentions one, and nothing
 *   above lets a consumer find out.
 * - **A session the harness can be asked about later.** {@link AgentHarness.messages} is
 *   here because both harnesses happen to offer a read-back, and it is *not* built on in
 *   this slice: the two retain transcripts very differently and choosing a transcript
 *   format is a later slice's decision. What this interface promises is that asking is
 *   possible, not that the answer is durable.
 * - **A separate "create" and "prompt".** Nothing here says those are two round trips.
 *   OpenCode's are; Claude Code's `query()` is one call that does session, prompt and
 *   stream together, and its implementation closes that gap by holding the session's
 *   configuration until the prompt arrives. The interface keeps the two apart because the
 *   *supervisor* needs them apart — a credential is minted between them — not because any
 *   harness does.
 * - **A shared session-id format.** OpenCode's is `ses_` plus its own descending id;
 *   Claude Code's must be a UUID. Hence (2): the format belongs to the harness and the
 *   decision to mint one belongs to us.
 * - **An outcome it can always produce.** Every answer here is allowed to be absent.
 *   `undefined` on {@link SessionStatus.outcome} and on {@link HarnessNarration.outcome}
 *   are not holes to be filled in; they are the difference between "the harness says it
 *   failed" and "nobody could tell us", which the supervisor settles differently
 *   (DECISIONS.md §15).
 *
 * ## The gate is part of the seam, not a module beside it
 *
 * `installGate` sits here because the gate is the one thing that *must* be harness-shaped
 * and must not be harness-specific at the call site. OpenCode loads a plugin named in
 * `.opencode/opencode.json`; Claude Code runs a `PreToolUse` command hook named in
 * `.claude/settings.local.json`, with a different payload, a different way of saying
 * "deny", and a different failure default. Those are three incompatible file formats and
 * one identical requirement — consult `policy/service.ts` before the tool runs, fail
 * closed, write an audit line outside the workspace — so the *decision* stays where it
 * was and only the installation varies.
 *
 * Had this been a free function the supervisor chose between, the supervisor would branch
 * on driver kind, which is the one thing this slice is trying to make impossible.
 */
import type { ModelOptionSelection } from "@bit/contracts";
import {
  Context,
  type Effect,
  type Redacted,
  Schema,
  type Stream,
} from "effect";

import type { HarnessDecodeError, HarnessTransportError } from "./errors";
import type { HarnessInstance, ModelProvenance } from "./identity";
import type { GateInstaller } from "../policy/install";

/** Anything an operation on this seam can fail with as an expected condition. */
export type HarnessFailure = HarnessTransportError | HarnessDecodeError;

/**
 * The tag a harness puts on "no such session", so one reconciler covers every harness.
 *
 * It is the generated OpenCode client's own vocabulary
 * (`@opencode/protocol`'s `SessionNotFoundError`, surfaced through
 * `HarnessTransportError.tag`), named here and reused by the Claude Code client
 * deliberately. `recovery/harnessStatus.ts` has to tell "the harness has never heard of
 * this session" — which maps to `missing`, and after a restart is the *expected* answer —
 * from "we could not ask", which maps to `unreachable`. A second harness inventing a
 * second spelling would have meant a second branch there, and a missed one would have
 * silently reported a forgotten session as an unreachable harness.
 *
 * A harness that cannot distinguish the two simply never sets it, and everything it
 * cannot answer is `unreachable` — which is the honest degradation.
 */
export const SESSION_NOT_FOUND_TAG = "SessionNotFoundError";

/**
 * The three outcomes a harness may state about a session.
 *
 * `uncertain` is deliberately absent: it is *our* conclusion when nobody stated one, and a
 * harness is never the source of it.
 */
export const TerminalOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "interrupted",
]);
export type TerminalOutcome = typeof TerminalOutcome.Type;

/**
 * What the harness currently says about one session.
 *
 * Three fields, all optional, because every one of them is something a harness may simply
 * not know. `outcome` absent means "still running, or nothing definite" — never "failed".
 */
export interface SessionStatus {
  readonly outcome?: TerminalOutcome | undefined;
  readonly cost?: number | undefined;
  readonly tokens?: Record<string, unknown> | undefined;
}

export interface SessionRef {
  readonly id: string;
}

/** One entry of a session's message log, reduced to what this application reads. */
export interface MessageEntry {
  readonly type: string;
  readonly text: string;
  readonly error: string | undefined;
}

/**
 * The most characters {@link NarrationDetail} carries in one text field.
 *
 * A tool input can be a whole file and a tool result can be a directory listing, and both
 * travel over a browser connection that is holding the screen for a live run. This is the
 * cap at the point the harness's payload is *read*, so an oversized argument is cut once,
 * here, rather than growing a queue, a PubSub buffer and an SSE frame on the way out.
 *
 * {@link truncateNarration} marks what it cut, in the value itself, because a silently
 * shortened tool argument is a tool argument a reader would misread.
 */
export const NARRATION_FIELD_MAX = 4_000;

/** The marker appended to a field {@link NARRATION_FIELD_MAX} cut short. */
export const NARRATION_TRUNCATED_MARK = "\n… (shortened)";

/** Caps one narration field, saying so in the value when it cuts. */
export const truncateNarration = (value: string): string =>
  value.length <= NARRATION_FIELD_MAX
    ? value
    : `${value.slice(0, NARRATION_FIELD_MAX)}${NARRATION_TRUNCATED_MARK}`;

/**
 * What one narrated moment *is*, in this application's vocabulary.
 *
 * This field used to be absent, and the reason it was absent is worth keeping: a
 * transcript needs the text of a reply, the arguments of a tool call and a shape to render
 * them in, and until something had to render them, any shape invented here would have been
 * the format a later slice inherited without having decided it. The live transcript is
 * that slice, so this is the decision — six cases, chosen because they are the six both
 * harnesses can actually produce.
 *
 * `opaque` is the honest default and most entries are it: a token delta, a step boundary, a
 * *cumulative* usage total. A reader that can render nothing useful from an entry gets
 * `opaque` rather than an empty `reply`, so "the harness said something we do not display"
 * never reads as "the agent replied with nothing".
 *
 * Two of the six arrived later than the others, and the comment they replace is worth
 * keeping: this list used to name "a usage update" among the things that are honestly
 * `opaque`, and that was true of the update both drivers publish most readily. It is not
 * true of the per-call figure underneath it. DECISIONS.md §24.4 measured which event
 * carries which, and `usage` is the one that survived; the cumulative ones are still
 * `opaque` and `openCodeNarration` says so at the line.
 *
 * **`toolResult.output` is the tool's own output, not a verdict about it.** `failed` is set
 * when the harness says the call failed; it says nothing about whether the action was
 * *allowed*, which is the policy gate's answer and arrives on a different channel.
 */
export type NarrationDetail =
  | {
      readonly _tag: "reply";
      /** One complete block of assistant text, never a token delta. */
      readonly text: string;
    }
  | {
      readonly _tag: "toolCall";
      /** The harness's own id for this call, so a result can be matched to it. */
      readonly callId: string;
      /**
       * The tool being called, when the harness has named it by now.
       *
       * `undefined` is reachable for the same reason it is on `toolResult`: OpenCode names
       * a tool on `session.tool.input.started` and the call's arguments arrive on a later
       * event, so a stream joined between the two has an id and no name. Borrowing a name
       * from somewhere would be the one mistake worth refusing here.
       */
      readonly tool: string | undefined;
      /** The arguments, serialised as JSON, capped by {@link NARRATION_FIELD_MAX}. */
      readonly input: string;
    }
  | {
      readonly _tag: "toolResult";
      readonly callId: string;
      /**
       * The tool this result is for, when the harness still remembers.
       *
       * `undefined` is reachable: OpenCode names a tool on `session.tool.input.started`
       * and not on the success or failure event, so a result that arrives for a call whose
       * name was never seen — a reconnected stream, a dropped entry — has no name to carry
       * and must not borrow one.
       */
      readonly tool: string | undefined;
      /** The output, capped by {@link NARRATION_FIELD_MAX}. */
      readonly output: string;
      /** The harness said this call failed. Not a policy decision; see above. */
      readonly failed: boolean;
    }
  | {
      /**
       * What the agent considered, as one complete block.
       *
       * Claude Code's `thinking` content blocks and OpenCode's `session.reasoning.ended`,
       * which carries the whole block's text exactly as `session.text.ended` does for a
       * reply — so this is one entry per block on both drivers, never a delta.
       *
       * **It is a record of what was considered, not of what happened**, and it is
       * streamed and never stored: no durable field, no evidence, no transcript artefact.
       * It lasts as long as the harness's own retention, like the rest of the narration.
       */
      readonly _tag: "thinking";
      /** The block's text, capped by {@link NARRATION_FIELD_MAX}. May be empty. */
      readonly text: string;
    }
  | {
      /**
       * How big the context was on one model call.
       *
       * **The numerator is per call and never a running total**, which is the whole of
       * DECISIONS.md §24.4: the figures both drivers publish most readily —
       * `session.usage.updated` and `session.tokens` on OpenCode, `result.usage`,
       * `modelUsage` and `total_cost_usd` on Claude Code, and {@link SessionStatus.tokens}
       * on either — are **spend totals**, because the cached prefix is re-counted on every
       * call. Measured: 65 838 against a real context of 13 753 on OpenCode, 90 784
       * against 23 179 on Claude Code. A meter fed from one of them reads four to five
       * times high, which is worse than no meter.
       *
       * The two events that are per call, and are what this is built from, are OpenCode's
       * `session.step.ended` — durable, sequenced, carrying `assistantMessageID` — and
       * Claude Code's `assistant` frames, topped up for the output count from the turn's
       * `result.usage.iterations[0]`.
       *
       * Cache read, cache write and reasoning are deliberately **not** fields. They cannot
       * be filled on both drivers with the same meaning (`cache.write` is a constant 0 on
       * the OpenCode provider measured, and `reasoning` sits beside `output` on one driver
       * and inside it on the other), and the seam's rule is that a case exists only where
       * both can fill it honestly.
       */
      readonly _tag: "usage";
      /**
       * One model call: OpenCode's `assistantMessageID`, Claude Code's `message.id`.
       *
       * The de-duplication key, and it is needed: Claude Code delivers one API call as
       * several `assistant` frames, one per content block, each repeating this id and the
       * same usage. `narrate` is stateless, so it emits one entry per frame and **a reader
       * keeps the latest per id rather than summing** — naive counting multiplies one call
       * by two or three.
       */
      readonly callId: string;
      /** Tokens sent on this call: uncached input + cache read + cache write. */
      readonly promptTokens: number;
      /**
       * Tokens generated on this call, thinking included, or `undefined` while unstated.
       *
       * `undefined` rather than a number on Claude Code's `assistant` frames, whose
       * `output_tokens` is the `message_start` snapshot and is stale — the call that
       * produced 16 tokens reported 1. A later entry with the same {@link callId} states
       * it from the turn's `result`. On OpenCode it is `output + reasoning`, so the field
       * means "everything generated" on both.
       */
      readonly outputTokens: number | undefined;
      /**
       * The model's context window, when this driver has stated it by now.
       *
       * Set from the catalogue on OpenCode (`HarnessModelView.contextLimit`) and from
       * `getContextUsage().maxTokens` on Claude Code, which only exists once a session
       * does. `undefined` is reachable on both — an unreadable catalogue, a control request
       * that has not answered yet — and a consumer draws no percentage without it.
       */
      readonly contextLimit: number | undefined;
      /**
       * Where the **harness itself** will summarise this session, when it states a policy.
       *
       * Not a second limit and not a smaller one: {@link contextLimit} is what the provider
       * accepts, and this is the point at which the harness rewrites the conversation
       * without being asked. OpenCode compacts bit's sessions by default at about 58 % of
       * the window on bit's own default model, so a consumer that drew only the window
       * would be implying nothing happens until it reads full.
       *
       * It is **derived from the driver's own source, not reported by it** —
       * `HarnessModelView.compactionAt` has the formula, the file and line it came from, and
       * the three things that can move it without moving this number. A consumer presents it
       * as where the harness says it will act, never as a measurement.
       *
       * `undefined` on Claude Code, which this build has measured no threshold for.
       */
      readonly compactionAt: number | undefined;
    }
  | { readonly _tag: "opaque" };

/**
 * What one session's model takes, as the two numbers a context meter needs.
 *
 * One struct rather than two parameters threaded side by side, because they come from the
 * same catalogue entry at the same moment and a call site that had one and not the other
 * would be a meter drawn against a window with no idea what the harness will do to it.
 * Both are the *model's*, so neither can be read off a narration event — see
 * `openCodeClient.ts`'s per-session map for the join.
 */
export interface SessionWindow {
  /** What the provider accepts. `HarnessModelView.contextLimit`. */
  readonly contextLimit: number;
  /** Where the harness acts on its own. `HarnessModelView.compactionAt`. */
  readonly compactionAt: number | undefined;
}

/**
 * One narrated moment of a session, reduced to what this application reads.
 *
 * `type` is a plain `string` and carries the harness's own event name verbatim — OpenCode's
 * `session.text.delta`, Claude Code's `assistant`. Which names exist is the harness's
 * business and the set grows with its releases; a union here would make an upgrade a
 * compile error in a module that only forwards the value, and would make the two harnesses
 * have to agree on a vocabulary neither of them owns.
 *
 * `detail` is this application's reading of the same moment, and the two are kept side by
 * side on purpose: a screen renders `detail`, and `type` is what an operator compares
 * against the harness's own log when the rendering looks wrong.
 *
 * `outcome` is the exception, and it is the whole reason this is not an opaque blob: a
 * harness stating a terminal outcome is a *definite answer* and must be told apart from
 * the stream merely ending. It is `undefined` on every other entry.
 */
export interface HarnessNarration {
  /** The harness's own event type, unmapped. */
  readonly type: string;
  /** The harness's cursor, where it has one, for resuming a log without replaying it. */
  readonly sequence: number | undefined;
  /** When the harness recorded it, in epoch milliseconds. */
  readonly at: number;
  /** Set only by an entry that states a terminal outcome. Never inferred. */
  readonly outcome: TerminalOutcome | undefined;
  /** What this moment is, as this application reads it. See {@link NarrationDetail}. */
  readonly detail: NarrationDetail;
}

/**
 * Which of the two injection timings a second message asks for.
 *
 * **Both drivers offer exactly two, and the difference is not academic** (DECISIONS.md
 * §24.1, measured on both). `preemptive` is OpenCode's `delivery: "steer"` and Claude
 * Code's `priority: "now"`: the directive is promoted at the next step boundary and the
 * rest of the work in flight is thrown away. In the probe that cost seven of eight file
 * reads on OpenCode and 59 of 60 lines on Claude Code. `queued` is OpenCode's
 * `delivery: "queue"` and Claude Code's `priority: "later"`: the work in flight finishes,
 * then the directive runs.
 *
 * `queued` is the default everywhere in this application, and the spec's ruling 5 says so:
 * a planner round part-way through writing intents should finish them, and `preemptive` is
 * reserved for an explicit redirect. T3 Code's own client default agrees
 * (`followUpBehavior: "queue"`).
 *
 * Named for what the caller wants rather than for either driver's word, because the two
 * drivers spell both of them differently and neither spelling is this application's.
 */
export type SteerUrgency = "queued" | "preemptive";

/**
 * What kind of prompt this is, which decides what a harness does with it.
 *
 * **A tagged union rather than three optional parameters, because the two cases have
 * different recovery rules and the type is where that is checkable.** An `open` prompt is
 * the session's first and **is never resubmitted** on any path (DECISIONS.md §15): a
 * harness therefore refuses a second `open` on a session it has already prompted, which is
 * what stops "carrying work on" from quietly becoming a second attempt under one identity.
 * A `steer` is a message into a session that is already running, it may legitimately
 * arrive many times, and a *retry* of one must not deliver twice — so it carries an
 * application-chosen message id and the harness is required to drop a repeat of it.
 *
 * `messageId` is the application's own, derived deterministically by the caller from the
 * operation it belongs to (`plan/steerId.ts`), and it is **not** in either driver's format:
 * OpenCode wants `msg_…` and Claude Code wants a UUID, so each implementation maps this
 * value into its own id space and the mapping has to be total and stable. The seam's
 * promise is the one the caller needs — *the same message id is delivered at most once* —
 * and it is kept by this layer rather than inherited from a driver.
 */
export type PromptDelivery =
  | {
      readonly _tag: "open";
    }
  | {
      readonly _tag: "steer";
      readonly urgency: SteerUrgency;
      /** Deterministic, per steer. See above: never a driver's own format. */
      readonly messageId: string;
    };

/** The default for every existing caller: one session, one prompt, never resubmitted. */
export const OPEN_PROMPT: PromptDelivery = { _tag: "open" };

/** What a harness says about a prompt it took. */
export interface PromptAccepted {
  /**
   * Whether this call put a new message into the session.
   *
   * `false` only for a `steer` whose `messageId` this session has already accepted: the
   * retry is answered successfully and **nothing is sent again**. A caller that treated
   * this as a failure would retry forever; a caller that ignored it entirely would be
   * correct about the session's state and would merely not know it had retried.
   */
  readonly delivered: boolean;
}

/** Where our MCP endpoint is, and what authority reaches it. */
export interface McpRegistration {
  readonly url: string;
  /**
   * Headers the harness must send, with the bearer among them.
   *
   * `Redacted` so the token cannot reach a log line or an error rendering by accident.
   * Each implementation unwraps it exactly once, at the one call that delivers it
   * (DECISIONS.md §6, "credentials off argv").
   */
  readonly headers: Readonly<Record<string, Redacted.Redacted<string>>>;
  /** The session's directory, for harnesses that scope registrations by it. */
  readonly directory: string;
}

export class AgentHarness extends Context.Service<
  AgentHarness,
  {
    /**
     * Which configured harness this is.
     *
     * A value rather than an effect: it is settled while the layer is built, and a run
     * that could ask for it and be told "not yet" would be a run that could start against
     * an instance it cannot name.
     */
    readonly instance: HarnessInstance;
    /**
     * A session id this application mints, in the harness's own format.
     *
     * This closes a real window. Opening a worker session is `seedAttempt({
     * harnessSessionId: null })` → `createSession` → `bindSessionToAttempt`, and a process
     * that died between the second and third steps left a live harness session that no
     * attempt row pointed at: recovery sweeps attempts, so nothing would ever look at it
     * again. Minting the id first means the row names the session *before* the session
     * exists, and the worst case becomes a recorded id for a session that was never
     * created — which recovery already handles.
     *
     * It is on the harness because the formats differ and neither is ours to invent:
     * OpenCode brands `ses_`-prefixed ids, and the Claude Agent SDK documents `sessionId`
     * as "must be a valid UUID".
     */
    readonly newSessionId: () => string;
    /**
     * Which provider and model an attempt row should record for this model name.
     *
     * Pure, and asked *before* the session is created, because `seedAttempt` runs first.
     * Harness-specific because the split is: OpenCode names a provider per model, Claude
     * Code has exactly one.
     */
    readonly modelProvenance: (model: string) => ModelProvenance;
    /**
     * Installs the pre-execution policy gate into a workspace.
     *
     * A failure **refuses the run**. See this module's header, and
     * `policy/install.ts` for what every implementation of this has to preserve.
     */
    readonly installGate: GateInstaller;
    /**
     * Opens a session, optionally inside an existing session's lineage.
     *
     * `parentSessionId` exists for provider prompt caching and nothing else, and a harness
     * with no such concept may ignore it. It is never passed for worker sessions.
     */
    readonly createSession: (input: {
      readonly title: string;
      /** A model name this instance's catalogue knows. */
      readonly model: string;
      readonly directory: string;
      readonly parentSessionId?: string | undefined;
      /** The id to create the session under, from {@link newSessionId}. */
      readonly sessionId?: string | undefined;
      /**
       * What was chosen *of* that model: reasoning depth, and whatever else it offers.
       *
       * Already resolved against the model's own descriptors by the caller, so an
       * implementation may take each `{ id, value }` at face value: every id here is one
       * this harness reported for this model, and every value is one of that descriptor's
       * choices. What an implementation still owns is the *translation* — which request
       * field the value belongs in, and what to do with
       * `MODEL_OPTION_DEFAULT_CHOICE` — because that is the part the two harnesses do not
       * share: OpenCode carries a variant id on the session's model reference, and the
       * Claude Agent SDK takes an `effort` level in the query's options.
       *
       * Absent means "nothing was chosen", which is **not** the same as the default: a
       * harness that is told nothing applies its own default and may change what that is,
       * and a harness told the default explicitly has been pinned to today's answer.
       */
      readonly options?: readonly ModelOptionSelection[] | undefined;
      /**
       * Whether this session stays open after a turn ends.
       *
       * `false` or absent — a worker attempt or a planner round: one prompt, one turn, and
       * the harness may close the session when it idles. `true` — a goal conversation: the
       * operator may say something else at any time, so the session must survive going
       * idle and be promptable again.
       *
       * **It exists because of what it costs on one driver and nothing on the other.** An
       * OpenCode session lives in the harness's own server and outlives every turn
       * regardless, so this changes nothing there. A Claude Code session *is* an open
       * `query()` held by this process, and the pump closes it when the last accepted
       * message has produced its `result` — which is right for a round and would make a
       * conversation unanswerable from its second message on.
       */
      readonly multiTurn?: boolean | undefined;
    }) => Effect.Effect<SessionRef, HarnessFailure>;
    /**
     * Makes our MCP endpoint reachable from one session, under one credential.
     *
     * **`sessionId` is a parameter because the second harness needed it to be.** OpenCode
     * registers an MCP server into a *directory* — `api.mcp.add({ server, location: {
     * directory } })` — so the session is implicit and the original signature had no room
     * for it. Claude Code registers into a *session*, over that session's own control
     * channel, and has no directory-scoped equivalent. Taking the session id explicitly is
     * the only signature both can honour, and it also makes the narrower guarantee
     * sayable: one attempt's credential reaches one attempt's session.
     *
     * OpenCode's implementation still registers per directory and so is *wider* than this
     * signature promises: two attempts running concurrently in the same workspace would
     * each see the other's `bit-<attemptId>` server. That is a property of the OpenCode
     * API rather than of this seam, it predates this interface, and it is recorded here
     * because the signature is now the place a reader would expect to find it.
     *
     * `name` is unique per attempt, which is what keeps the two registrations
     * distinguishable wherever they land.
     */
    readonly registerMcpServer: (
      sessionId: string,
      name: string,
      config: McpRegistration,
    ) => Effect.Effect<void, HarnessFailure>;
    /**
     * Removes a registration this seam made, so a revoked credential leaves no entry
     * behind.
     *
     * **Why this exists.** DECISIONS.md §24.2 (Spike B, caveat 3) measured that nothing
     * ever calls OpenCode's `mcp.remove`: after a credential is revoked the entry stays
     * in the directory's registry, reported `connected`, until the OpenCode server dies.
     * That is **not an authority leak**: our endpoint refuses the dead token with a 401,
     * which `mcp/server.test.ts` tests directly ("an unknown bearer token is rejected",
     * and the auth middleware runs before any protocol handling). The spike is **not** the
     * evidence for that and says the opposite about its own runs — it saw "no 401" —
     * because it revoked each token before anything presented it. What the spike does say
     * is that the entry stays: it is misleading to anybody reading the registry, and in a
     * shared directory it accumulates one dead entry per attempt.
     *
     * No directory parameter, deliberately. The registration already established which
     * directory the entry is in; making a caller re-state it would put an
     * implementation's own fact in the caller's hands, and a caller that remembered the
     * *wrong* directory would quietly remove nothing. An implementation that needs it
     * remembers it.
     *
     * **Idempotent, and never the reason a run fails.** Removing a name that was never
     * registered, or was already removed, succeeds. It is called from the release side of
     * the registration's scope, where a failure would turn tidy-up into an outcome.
     */
    readonly unregisterMcpServer: (
      sessionId: string,
      name: string,
    ) => Effect.Effect<void, HarnessFailure>;
    /**
     * Gives a session something to do: its first prompt, or a message into a live turn.
     *
     * {@link PromptDelivery} is which, and it defaults to {@link OPEN_PROMPT} so that the
     * two callers who only ever send a first prompt — the run supervisor and the plan
     * supervisor — say nothing about steering at all.
     *
     * **A `steer` into a session that has already settled must fail rather than start
     * fresh work**, and that is the one requirement of this operation that is not obvious
     * from its shape. DECISIONS.md §24.1 measured that OpenCode never refuses a prompt for
     * being busy *or* for being finished: prompting an idle session starts a **new
     * execution**, with no supervisor, no round record and no disposition. So the race a
     * steer can lose — the round settling between the decision to steer and the prompt
     * landing — has to be lost *safely*, and an implementation that cannot tell a live
     * session from a settled one has to refuse rather than guess. `plan/planSupervisor.ts`
     * holds the claim that makes the window small; this is the backstop for the rest of it.
     */
    readonly prompt: (
      sessionId: string,
      text: string,
      delivery?: PromptDelivery,
    ) => Effect.Effect<PromptAccepted, HarnessFailure>;
    /**
     * Blocks until the session is no longer running.
     *
     * **"No longer running" means idle after the *last accepted message*, not after the
     * first turn**, and the distinction is the whole of DECISIONS.md §24.1's consequence 4.
     * Claude Code produces one `result` per turn, so a steered session produces two; a
     * `waitForIdle` that answered at the first one would answer about the turn the steer
     * took over from — the supervisor would settle the round, revoke its credential and
     * close the session while the directive's own turn was still to run. An implementation
     * therefore tracks how many messages it has accepted against how many have completed,
     * and answers when they agree.
     *
     * It is **not** per turn and there is no way to wait for one: a caller holding this
     * wants to know when the session has finished everything it has been given, which for
     * a round is the one thing settlement is allowed to be read from.
     *
     * A failure here means the outcome is **uncertain**, not that execution stopped: our
     * request losing its answer says nothing about the harness (DECISIONS.md §15).
     * Callers reconcile against {@link sessionStatus} and must never resubmit the prompt.
     */
    readonly waitForIdle: (
      sessionId: string,
    ) => Effect.Effect<void, HarnessFailure>;
    readonly sessionStatus: (
      sessionId: string,
    ) => Effect.Effect<SessionStatus, HarnessFailure>;
    /**
     * One session's messages, as the harness retains them.
     *
     * Here so the capability is not foreclosed, not because anything in this slice reads
     * it. The two harnesses retain very differently — OpenCode answers from a running
     * server's store, Claude Code from a transcript on disk that outlives the process —
     * and a consumer that depended on either would be depending on a retention policy
     * neither interface states.
     */
    readonly messages: (
      sessionId: string,
    ) => Effect.Effect<readonly MessageEntry[], HarnessFailure>;
    /**
     * Asks the harness to stop whatever the session is doing.
     *
     * Reports whether the harness says it interrupted something: `false` for a session
     * that was already idle, which is not a failure and is worth being able to tell apart.
     * Resuming is deliberately not on this interface — carrying work on after an
     * interruption means a new attempt identity (DECISIONS.md §15).
     */
    readonly interruptSession: (
      sessionId: string,
    ) => Effect.Effect<boolean, HarnessFailure>;
    /**
     * The harness's narration for one session, from now on.
     *
     * **Live-only, and not the settlement signal.** Both implementations have a window
     * between the subscription being asked for and it being established, so an entry
     * published inside it is gone. Taking settlement from here would mean a run whose
     * terminal entry landed in that window had no terminal entry at all — and because
     * neither stream reliably *ends* when a session settles, the consumer would hang
     * rather than answer wrongly, which is worse. {@link waitForIdle} is what says it is
     * over; this is what says what happened along the way.
     *
     * **No transport bound.** Every other operation here is bounded; this one must not be,
     * because it is meant to stay open for as long as the session runs, which is unbounded
     * by design (DECISIONS.md §5). The consuming fiber owns its lifetime instead.
     *
     * **A stream that ends is not an outcome** (DECISIONS.md §15).
     */
    readonly sessionEvents: (
      sessionId: string,
    ) => Stream.Stream<HarnessNarration, HarnessFailure>;
  }
>()("bit/harness/AgentHarness") {}

/** The assistant's final text, or an empty string when it produced none. */
export const finalAssistantText = (entries: readonly MessageEntry[]): string =>
  entries.find((entry) => entry.type === "assistant")?.text ?? "";

/**
 * The **last** thing the assistant said, or an empty string.
 *
 * Not {@link finalAssistantText}, which takes the first assistant entry and is used by the
 * spikes on sessions that produce exactly one. Both drivers answer `messages` in
 * transcript order, so a session that spoke more than once — and the scope importer works
 * through up to eight pages in one turn — has its report at the *end* of the list.
 *
 * Empty entries are skipped: a harness can record an assistant message whose text is
 * entirely tool calls, and "the last thing it said" means the last thing it said in words.
 */
export const lastAssistantText = (entries: readonly MessageEntry[]): string => {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at];
    if (entry?.type === "assistant" && entry.text.trim() !== "")
      return entry.text;
  }
  return "";
};

/** The first error any entry reported, used to explain a `failed` outcome. */
export const firstError = (
  entries: readonly MessageEntry[],
): string | undefined =>
  entries.find((entry) => entry.error !== undefined)?.error;
