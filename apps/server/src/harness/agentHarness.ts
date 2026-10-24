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
 * One narrated moment of a session, reduced to what this application reads.
 *
 * **Deliberately four fields and no content.** A transcript needs the text of a reply, the
 * arguments of a tool call and a shape to render them in; choosing that shape is a later
 * slice's work, and a field invented here would be the format that slice inherits without
 * having decided it.
 *
 * `type` is a plain `string` and carries the harness's own event name verbatim — OpenCode's
 * `session.text.delta`, Claude Code's `assistant`. Which names exist is the harness's
 * business and the set grows with its releases; a union here would make an upgrade a
 * compile error in a module that only forwards the value, and would make the two harnesses
 * have to agree on a vocabulary neither of them owns.
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
    readonly prompt: (
      sessionId: string,
      text: string,
    ) => Effect.Effect<void, HarnessFailure>;
    /**
     * Blocks until the session is no longer running.
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

/** The first error any entry reported, used to explain a `failed` outcome. */
export const firstError = (
  entries: readonly MessageEntry[],
): string | undefined =>
  entries.find((entry) => entry.error !== undefined)?.error;
