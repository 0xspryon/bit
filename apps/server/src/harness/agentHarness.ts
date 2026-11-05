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
 *    {@link AgentHarness.messages} — settle, stop, read back. And
 *    {@link AgentHarness.sessionContinuation} beside them, which asks the one thing a
 *    conversation needs and a run does not: whether a session this process no longer holds
 *    can be talked to again. {@link AgentHarness.sessionTitle} is the third question of that
 *    kind, and the only one a screen asks rather than a run: what the harness calls it.
 * 10. {@link AgentHarness.unregisterMcpServer} — take the registration away again when
 *    the credential it carried is revoked.
 * 11. {@link AgentHarness.endSession} — end a conversation's session, so nothing of it
 *    runs after this process has let go of it.
 *
 * And one a run never calls and a conversation does: {@link AgentHarness.switchModel},
 * which moves a session onto another model of the same harness, mid-turn or between turns.
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
 *   possible, not that the answer is durable. {@link AgentHarness.sessionContinuation} is
 *   the same promise about *continuing* rather than reading, and it answers "no" as a value
 *   rather than as a failure, because "the harness swept it" is the ordinary end state of
 *   anything old enough.
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
import type {
  ContextBreakdown,
  ContextReading,
  ModelOptionSelection,
} from "@bit/contracts";
import {
  Context,
  type Effect,
  type Redacted,
  Schema,
  type Stream,
} from "effect";

import type { MessageAttachment, ReplayedAttachment } from "./attachments";
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
 * Whether a turn is in flight on a session, in the process that would be running it.
 *
 * **This is the field that stops "no outcome" being read as "still running", and that
 * mistake is why it exists.** `idle_outcome` on OpenCode and the pump's `outcome` on
 * Claude Code are both written only when a turn reaches a terminal event, so an absent
 * outcome covers two states that could not be more different: a turn that is running, and
 * a turn whose process died without ever writing one. `recovery/harnessStatus.ts` used to
 * collapse them into `running`, which left the attempt row `running`, the write fence
 * unmoved and the round untouched — exactly the pile of stuck `running` rows recovery
 * exists to prevent.
 *
 * So the two questions are asked separately. This one is "is a turn in flight", answered
 * by whichever process holds the execution; {@link SessionStatus.outcome} is "how did the
 * last completed turn end". A caller may only believe the outcome while this says `idle`.
 *
 * - `running` — a turn is in flight. The outcome, if any, belongs to an *earlier* turn and
 *   must not be read; both drivers suppress it for that reason.
 * - `idle` — no turn is in flight. An outcome here is the last turn's and is current; no
 *   outcome here means no turn ever recorded one, which is **not** a terminal answer.
 *
 * **There is no third member for "cannot tell", deliberately.** A harness that cannot tell
 * answers `idle`, which reaches `uncertain` through `harnessStatus.ts` — not `running`.
 * Failing towards "we do not know" is recoverable; failing towards "still going" is the
 * defect above.
 */
export type SessionActivity = "running" | "idle";

/** What {@link AgentHarness.contextUsage} is asked for (A6 U9). */
export interface ContextRead {
  /**
   * The model the session is on now, by the caller's record — which a model switch
   * updates. OpenCode's window is this model's catalogue entry; Claude Code's comes from
   * the live session and this is not read.
   */
  readonly model: string;
  /**
   * Whether to ask for the categories too. On Claude Code they cost a token count per
   * category (about a second, measured 2026-11-05), so only a screen showing them asks.
   */
  readonly breakdown: boolean;
}

/**
 * One session's context window, as its harness answered (A6 U9): the shape of
 * `ConversationContext` without the identity the caller adds.
 *
 * `used` is **the last model call's** tokens sent plus generated, never a spend total
 * (DECISIONS.md §24.4), and `null` unless `reading` is `measured`.
 */
export interface HarnessContextUsage {
  readonly used: number | null;
  /**
   * The model whose call measured {@link used}, as the harness spells it, or `null` with
   * no figure or where the harness did not say. See `ConversationContext.usedModel`.
   */
  readonly usedModel: string | null;
  /**
   * The model {@link window} is, where the harness said which it answered for (Claude
   * Code's `getContextUsage().model`); absent where the caller's {@link ContextRead.model}
   * is the one.
   */
  readonly model?: string;
  readonly window: number | null;
  readonly reading: ContextReading;
  readonly breakdown: ContextBreakdown;
}

/**
 * What the harness currently says about one session.
 *
 * `activity` is **required** and the other three are optional, and that split is the
 * point: cost, tokens and the outcome are each something a harness may simply not know,
 * while "is a turn in flight" is the one thing the process holding the execution always
 * knows and a reader can never infer. A third harness that forgets it does not compile,
 * which is the only guard that would have caught {@link SessionActivity}'s defect.
 *
 * `outcome` absent means "no turn has recorded one" — never "failed", and never "still
 * running" either: that is `activity`'s to say. An `outcome` reported alongside
 * `activity: "running"` is a *stale* outcome from an earlier turn and callers ignore it.
 */
export interface SessionStatus {
  readonly activity: SessionActivity;
  readonly outcome?: TerminalOutcome | undefined;
  readonly cost?: number | undefined;
  readonly tokens?: Record<string, unknown> | undefined;
  /**
   * Whether work the agent started in the background — a background subagent or shell,
   * which a turn's end does not wait for — is still running (A6 F5's fifth review).
   *
   * **Beside {@link activity}, not part of it**: a turn is what `waitForIdle` and a run's
   * settlement wait for, and a background task can outlive every turn, so folding it in
   * would leave a conversation never idle. A screen that offers Stop reads both. Absent
   * from a harness that does not report background work (OpenCode).
   */
  readonly background?: boolean | undefined;
}

/**
 * What {@link AgentHarness.createSession} answers: the session's id, and — by the object's
 * identity — the one opening it stands for.
 *
 * **Keep the object; it is the handle {@link AgentHarness.endSession} takes.** A resume
 * opens a session under an id that is already in use, so two opens can share one id while
 * only one of them is current, and ending "the session with this id" would end whichever
 * opened last. Ending the object this call returned ends the opening it stands for and no
 * other (A6 F5 review). Nothing is added to the shape for it: a harness recognises its own
 * answers by identity, so a ref rebuilt from the id is one it did not hand out.
 */
export interface SessionRef {
  readonly id: string;
}

/**
 * Whether a session **this process does not hold** can be carried on, and where.
 *
 * Asked because the two drivers keep a conversation after the process that opened it is
 * gone, and neither keeps it unconditionally. S2.5's research settled what each one does;
 * this is the seam that makes the answer a value instead of an assumption, so a composer is
 * never offered for a message that would fail.
 *
 * `_tag: "resumable"` means the harness will continue this conversation if asked —
 * {@link AgentHarness.createSession}'s `resume`. It is **not** a claim that the session is
 * running: it is not, on either driver, and nothing here says otherwise.
 *
 * `directory` is where the harness itself will resolve the session's work, and the caller
 * has to care about it for two reasons rather than one. OpenCode resolves a prompt through
 * the session's *stored* directory and answers `LocationNotFoundError` if it is gone; Claude
 * Code finds a transcript under the project its `cwd` hashes to. And the pre-execution
 * policy gate lives *in* that directory, so a resume into a directory we did not gate is an
 * ungated agent. A caller that cannot match this against the directory it is about to gate
 * must open a fresh session instead of resuming.
 *
 * `undefined` is "the harness did not say", which is not permission to guess.
 */
export type SessionContinuation =
  | {
      readonly _tag: "resumable";
      readonly directory: string | undefined;
      /** The harness's own sentence about what it still holds. */
      readonly detail: string;
    }
  | {
      readonly _tag: "unresumable";
      /** The harness's own sentence about why not: swept, never saved, unknown. */
      readonly detail: string;
    };

/**
 * What a harness calls one session, asked of the harness (S9).
 *
 * **Three answers, because they are three facts and a screen draws each differently.**
 * `forgotten` is the harness no longer holding the session at all — Claude Code sweeps
 * transcripts on `cleanupPeriodDays`, and for anything old enough that is the ordinary
 * answer. `untitled` is a harness that still holds it and has no name for it *yet*: both
 * harnesses title a conversation after its first turn, so this is a session that has said
 * little or nothing, and it may have a title on the next read. `titled` is the name. A fourth
 * fact — "we could not ask" — is the failure channel, as on every other operation here: a
 * harness that did not answer has said nothing about the session.
 *
 * Collapsing `untitled` and `forgotten` into an empty string would lose exactly the
 * distinction the replay keeps between `none` and `forgotten` (`import/importerHistory.ts`):
 * one is a session that is there and quiet, the other is one whose words are gone.
 *
 * **A title is the harness's or a person's name for the session, never a prompt the harness
 * fell back to.** That is the half each implementation has to make true rather than inherit:
 * the Claude Agent SDK's `summary` falls back to the session's prompts when nothing better
 * exists, and those prompts are this server's framing. See `claudeCodeHarness.sessionTitle`.
 *
 * `title` is the harness's text verbatim — not trimmed beyond "is it blank", not capped.
 * Uncapped on purpose: a caller that recognises its own words in a title needs the whole
 * string to do it, and a cut made here could remove the very marker it would look for. The
 * caller caps with {@link capSessionTitle} before the text reaches any screen.
 */
export type SessionTitle =
  | { readonly _tag: "titled"; readonly title: string }
  | { readonly _tag: "untitled" }
  | {
      readonly _tag: "forgotten";
      /** The harness's own sentence about why it has nothing for this id. */
      readonly detail: string;
    };

/**
 * The most characters a session title carries to a screen.
 *
 * **A label, not a field of a transcript, so it is capped on different terms from
 * {@link NARRATION_FIELD_MAX}.** That cap is 4 000 characters and marks its cut with
 * {@link NARRATION_TRUNCATED_MARK}, a new line and a sentence, because a narration field is
 * read in a scrolling transcript where an operator must not mistake a shortened tool argument
 * for the whole one. A title sits on one line of chrome — a crumb, a picker row — where a
 * new line would break the line it sits on and a sentence would be longer than most titles.
 * So this is 120 characters, whitespace collapsed to single spaces, and a single `…` where it
 * cut.
 *
 * 120 is above what either harness writes on its own: OpenCode cuts generated titles at 100
 * (`packages/core/src/session/title.ts`, `MAX_LENGTH`), and the Claude Code `ai-title`s
 * observed on this machine's importer transcripts are four to six words. So it bites on a
 * name nobody's generator wrote — a rename, or a third harness — which is the agent- or
 * person-authored text the cap is for.
 */
export const SESSION_TITLE_MAX = 120;

/**
 * One title as a single line of at most {@link SESSION_TITLE_MAX} characters, or
 * `undefined` when nothing but whitespace was there.
 *
 * Applied by the caller *after* it has recognised any of its own words in the title; see
 * {@link SessionTitle} on why the seam hands it over uncapped.
 */
export const capSessionTitle = (value: string): string | undefined => {
  const line = value.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length <= SESSION_TITLE_MAX
    ? line
    : `${line.slice(0, SESSION_TITLE_MAX - 1).trimEnd()}…`;
};

/**
 * One block of a stored message, in the vocabulary the live stream narrates it in (A6 F10).
 *
 * The same five {@link NarrationDetail} cases a driver produces from its event stream, so a
 * replay is projected into `LiveItem`s by the **same** function as live narration
 * (`run/liveTranscript.ts`, `projectDetail`) and a reloaded conversation renders as the
 * watched one did. A `blockId` is set where the driver can name the block as its stream
 * did; a `toolCall`'s `tool` is the harness's own name, as live.
 */
export type MessagePart = Extract<
  NarrationDetail,
  {
    readonly _tag:
      "reply" | "thinking" | "toolCall" | "toolResult" | "subagent";
  }
>;

/** One entry of a session's message log, reduced to what this application reads. */
export interface MessageEntry {
  /** The harness's own word for the entry — `user`, `assistant`, OpenCode's `shell` … */
  readonly type: string;
  /**
   * The entry's plain text: a `user` entry's words, an assistant's text blocks joined. What
   * the callers that only need words read (`lastAssistantText`, a worker's transcript, the
   * framing trims); {@link parts} is what a replay renders from.
   */
  readonly text: string;
  readonly error: string | undefined;
  /**
   * The entry's blocks, in order, as the live stream narrates them (A6 F10). Empty for a
   * `user` entry that is only words — those are {@link text} — and for an entry with no
   * blocks a renderer could show.
   */
  readonly parts: readonly MessagePart[];
  /**
   * The model that produced an assistant entry, as the harness names it — Claude Code's
   * `message.model`, OpenCode's `provider/model` — or `undefined` where it did not say.
   */
  readonly model: string | undefined;
  /** When the harness recorded the entry, in epoch milliseconds, or `undefined`. */
  readonly at: number | undefined;
  /**
   * When the harness **finished** the entry, for a harness that keeps one time per message
   * rather than per block (A6 U4 review), or absent where {@link at} already is the block's
   * own time.
   *
   * OpenCode stores an assistant message's parts with the message's `time.created`, which is
   * when the model started on it — so a replay that stamped its parts with that drew a turn
   * that took 3 s as one that took 0 s. Its `time.completed` is when the last part was done,
   * which is what a live item's time approximates. `null` is a message the harness never
   * marked completed: its parts' end is unknown, and the replay says so on them
   * (`LiveItem.endUnknown`) rather than give a time that is not one. Claude Code stores one
   * entry per block with its own `timestamp`, and leaves this absent.
   */
  readonly endedAt?: number | null;
  /**
   * Set on a `user` entry the **harness wrote itself** rather than one anybody sent, by what
   * it marks; absent on everything else (A6 F10 review).
   *
   * Claude Code stores its own notes in the user's role. After a Stop that cut a tool call
   * the CLI writes `[Request interrupted by user for tool use]` as a `user` entry, and a
   * replay that read every `user` entry as the operator's words drew it as a message the
   * operator sent. It is `interrupted`. A `<task-notification>` — a background task done, or
   * a foreground `Bash` a Stop killed — is another, and is `task`; a compaction's summary
   * of the conversation before it is `compacted`. Set from the harness's own flags (`origin`,
   * `isCompactSummary`, `is_meta`) where it has them; the interrupt note has none, so it is
   * told by its own fixed text — a single text block opening `[Request interrupted by user`
   * — the same test live narration uses. Never from the content's shape alone (string or
   * list), so an operator's message whose content is a list is not mistaken for one.
   * {@link text} still holds the harness's words.
   */
  readonly marker?: string;
  /**
   * On a `user` entry whose message carried files (A6 F9), the files, read from the
   * harness's own record of it: the prompt's `[Attached …]` lines naming files stored in the
   * folder the caller gave ({@link MessageRead.uploadsFolder}), which are taken out of
   * {@link text}, typed by OpenCode's file part or else by the stored name. Absent when the
   * message carried none, or the caller named no folder.
   */
  readonly attachments?: readonly ReplayedAttachment[];
  /**
   * On a `user` entry that holds steers this application delivered, the application's ids
   * for them (`PromptDelivery.messageId`), oldest first — the same ids the deliveries'
   * answers and their `taken` narration carry — and absent on every other entry (A6 U4
   * review 2). Several when the harness took several steers as one and stored them as one
   * entry (review 3): Claude Code does, under the last one's uuid alone.
   *
   * Read back from the id the harness **stored the entry under**, which each driver derived
   * from ours when it delivered it (`harness/messageId.ts`): OpenCode's `msg_<hex>` is
   * stripped back to the hex, and Claude Code's UUID is matched against the ids the session
   * was delivered — that mapping is one-way, so a session this process no longer holds
   * (a restart) names none of its Claude Code steers. A caller joins a message it holds to
   * the transcript by this and never by its words or its time.
   */
  readonly messageIds?: readonly string[];
}

/** What a caller tells {@link AgentHarness.messages} about the session it reads. */
export interface MessageRead {
  /**
   * The session's own `uploads/` folder, absolute, as the caller knows it — never as the
   * transcript says it. See `harness/attachments.ts`'s `splitAttachmentLines`.
   */
  readonly uploadsFolder?: string | undefined;
}

/*
 * The caps on one narration field, and the mark a cut leaves, live in the contracts
 * (`narrationCaps.ts`, A6 U8 review 5) so the browser can recognise an operator message the
 * server shortened. They are applied here, where a harness's payload is *read*: a tool input
 * can be a whole file and a tool result a directory listing, and both travel over a browser
 * connection that is holding the screen for a live run, so an oversized argument is cut
 * once, here, rather than growing a queue, a PubSub buffer and an SSE frame on the way out.
 * {@link truncateNarration} marks what it cut, in the value itself, because a silently
 * shortened tool argument is a tool argument a reader would misread. A finished reply has
 * its own, larger cap ({@link REPLY_FIELD_MAX}); every partial stays at the field cap, since
 * a partial is resent every ~50 ms with the whole text so far.
 */
export {
  NARRATION_FIELD_MAX,
  NARRATION_TRUNCATED_MARK,
  REPLY_FIELD_MAX,
  truncateNarration,
  truncateReply,
} from "@bit/contracts";

/**
 * What one narrated moment *is*, in this application's vocabulary.
 *
 * This field used to be absent, and the reason it was absent is worth keeping: a
 * transcript needs the text of a reply, the arguments of a tool call and a shape to render
 * them in, and until something had to render them, any shape invented here would have been
 * the format a later slice inherited without having decided it. The live transcript is
 * that slice, so this is the decision — six cases, chosen because they are the six both
 * harnesses can actually produce — and A6 F6 added two for streaming, eight in all:
 * `delta`, a piece of a block while it is being written ({@link BlockDelta}, produced by a
 * driver), and `partial`, a block's whole text so far ({@link BlockPartial}, produced only
 * by `run/streamingCoalescer.ts` from the deltas, never by a driver).
 *
 * `opaque` is the honest default and most entries are it: a step boundary, a *cumulative*
 * usage total. A token delta was one of them until a driver streams it as a `delta`. A
 * reader that can render nothing useful from an entry gets `opaque` rather than an empty
 * `reply`, so "the harness said something we do not display" never reads as "the agent
 * replied with nothing".
 *
 * Two of the first six arrived later than the others, and the comment they replace is worth
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
      /**
       * One complete block of assistant text, never a token delta. Capped by
       * {@link REPLY_FIELD_MAX}, not {@link NARRATION_FIELD_MAX}.
       */
      readonly text: string;
      /** The model that wrote the block, when the harness said. See `LiveItem.model`. */
      readonly model?: string | undefined;
      /**
       * The harness's id for this block, when it streamed the block as {@link BlockDelta}s
       * first. The finished block **ends** that block's partial updates and replaces them on
       * a screen (`run/streamingCoalescer.ts`). Absent on a block nothing streamed; a driver
       * that streams may also put it on a block that happened to get no deltas, since
       * ending a block never opened is harmless.
       */
      readonly blockId?: string | undefined;
      /** The model call that wrote the block, wherever {@link blockId} is ({@link BlockDelta.call}). */
      readonly call?: string | undefined;
    }
  | BlockDelta
  | BlockPartial
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
      /** The model that made the call, when the harness said. See `LiveItem.model`. */
      readonly model?: string | undefined;
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
  | SubagentState
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
      /** As on `reply`: the streamed block this finishes, if it was streamed. */
      readonly blockId?: string | undefined;
      /** As on `reply`. */
      readonly call?: string | undefined;
      /** As on `reply`. */
      readonly model?: string | undefined;
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
       * The model that made this call, as the harness spells it (Claude Code's
       * `message.model`, OpenCode's step `provider/model`), or `undefined` where the stream
       * did not say. A call running when a switch lands finishes on the old model.
       */
      readonly model: string | undefined;
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
  | {
      /**
       * The harness took a message this session was sent as a steer (A6 U4): it is now in
       * the conversation, where until now it was queued behind the work in flight.
       *
       * What lets a chat draw a follow-up sent mid-turn as **queued** until it is read, and
       * keep the rest of the running turn's work above it. Claude Code says so on the first
       * frame whose `user_message_uuids` names the message (the turn that consumed it, or
       * the running turn it was folded into); OpenCode on `session.inbox.delivered`. One
       * entry per take, each message in at most one per session.
       */
      readonly _tag: "taken";
      /**
       * The application's ids for the messages taken, as `PromptDelivery.messageId` gave
       * them, oldest first and never empty. **Several when the harness took them as one**
       * (A6 U4 review 3): Claude Code dequeues every steer waiting behind a turn at once,
       * names them all on the same frame, and stores them as one transcript entry — so they
       * are one message to the agent, answered by one reply, and a chat draws them as one
       * turn. OpenCode takes one at a time.
       */
      readonly messageIds: readonly string[];
    }
  | {
      /**
       * The harness ended a turn with an error of its own (A6 U4): a provider refusing the
       * call ("Free usage limit reached"), a turn that ran out of turns. Not a tool's
       * failure, which is its `toolResult`, and not an interrupt this application asked
       * for. OpenCode's `session.execution.failed`; Claude Code's error `result`.
       *
       * `message` is the **harness's own sentence**, capped, and it is untrusted text: a
       * provider's error can quote anything.
       */
      readonly _tag: "error";
      readonly message: string;
    }
  | {
      /**
       * The harness ended a turn **before it wrote anything** and sent its message on with
       * the next one (A6 U6 review 2): the next turn reads both, and its reply, if it gets
       * one, answers both. A Stop can end that next turn before it replies (review 3).
       *
       * Claude Code, when a message sent with `priority: "now"` (a Send now) lands while the
       * turn that took an earlier message has produced nothing yet: the CLI aborts that
       * turn's request, ends it with an `error_during_execution` `result` whose only errors
       * are its own diagnostics, and asks the model again with both messages (measured, CLI
       * 2.1.310: two `user` entries, then one reply). Not a failure, and not "no reply".
       *
       * `messageIds` are the application's ids for the messages the ended turn held, as
       * `PromptDelivery.messageId` gave them; empty for a session's opening prompt, which
       * has none. A chat finds the turn by where the entry lands, after that turn's take.
       */
      readonly _tag: "carried";
      readonly messageIds: readonly string[];
    }
  | {
      /**
       * Words the harness wrote **in the user's place** to mark where something landed (A6
       * U6 review 3), as a replay reads them from the stored transcript
       * (`MessageEntry.marker` and its text), so a turn reads the same watched and reloaded.
       *
       * Claude Code's interrupt marker, `[Request interrupted by user]` (`… for tool use]`):
       * the CLI sends it live as a main-thread `user` frame where a Stop landed, before that
       * turn's `result`, and stores the same entry. Its `marker` is `interrupted`. Never the
       * operator's words, and never a message.
       */
      readonly _tag: "marker";
      readonly marker: string;
      readonly text: string;
    }
  | { readonly _tag: "opaque" };

/**
 * Where a sub-agent stands, as {@link SubagentState} says it.
 *
 * `running` from the call until something ends it; `finished` when it handed back;
 * `failed` when the harness says the call or the task failed; `stopped` when it was stopped
 * or cancelled before it ended on its own.
 */
export type SubagentStatus = "running" | "finished" | "failed" | "stopped";

/**
 * A **sub-agent** the session's agent started, and where it stands — instead of its call,
 * its result and everything it said (A6 U14, decided by the operator).
 *
 * A harness's sub-agent tool (Claude Code's `Agent`, formerly `Task`; OpenCode's
 * `subagent`, formerly `task`) starts another agent with its own context, and that agent's
 * reasoning, tool calls and replies are not the calling agent's. Narrated as the caller's
 * rows they read as if the caller wrote them, and on Claude Code they also vanished on a
 * reload, since its transcript keeps them elsewhere. So a driver narrates a sub-agent's
 * own frames as nothing, and its call as this: what it is and how it stands. Each driver
 * produces one when the call is made (`running`) and one when it ends, both carrying the
 * same {@link callId} and the same description, live and in a replay, so a reader keeps the
 * newest state per call and draws **one entry** at the place of the first.
 *
 * Its own words never reach this: a finished foreground call's result is the sub-agent's
 * final report, and a background one's completion notice carries it too. Neither is
 * carried here, and a replay drops the notice rather than drawing it.
 *
 * V2(chat): a sub-agent's own transcript is not shown — only one entry per sub-agent.
 * Proper V2: replay its transcript (Claude Code keeps it in a "subagents/" folder beside the
 * session's transcript; OpenCode runs it as a child session) labelled as the sub-agent's.
 */
export interface SubagentState {
  readonly _tag: "subagent";
  /** The calling tool call's id: the sub-agent's identity for every state of it. */
  readonly callId: string;
  /** The calling tool as the harness named it (`Agent`, `subagent`). */
  readonly tool: string;
  /**
   * Its type as the calling agent asked for it — Claude Code's `subagent_type`, OpenCode's
   * `agent` — or `undefined` when the call named none. Agent text: shown as plain text.
   */
  readonly agentType: string | undefined;
  /**
   * The calling agent's short description of the task, or, when it gave none, the start of
   * the prompt; one line, capped at {@link SUBAGENT_DESCRIPTION_MAX}. Agent text.
   */
  readonly description: string;
  readonly status: SubagentStatus;
  /** The model that made the call, when the harness said. See `LiveItem.model`. */
  readonly model?: string | undefined;
}

/** The most characters a {@link SubagentState.description} carries. */
export const SUBAGENT_DESCRIPTION_MAX = 200;

/**
 * A sub-agent's description from what its call said: the `description` when there is one,
 * else the `prompt`, as one line, capped at {@link SUBAGENT_DESCRIPTION_MAX} with an
 * ellipsis when cut.
 */
export const subagentDescription = (
  description: unknown,
  prompt: unknown,
): string => {
  const pick =
    typeof description === "string" && description.trim() !== ""
      ? description
      : typeof prompt === "string"
        ? prompt
        : "";
  const line = pick.replace(/\s+/g, " ").trim();
  return line.length <= SUBAGENT_DESCRIPTION_MAX
    ? line
    : `${line.slice(0, SUBAGENT_DESCRIPTION_MAX - 1).trimEnd()}…`;
};

/** Which kind of block a streamed piece of text belongs to: a reply, or thinking. */
export type BlockChannel = "reply" | "thinking";

/**
 * A piece of a reply or thinking block **while it is being written** — a token delta.
 *
 * Produced by a driver that streams (A6 F7 and F8 make OpenCode's `session.text.delta` /
 * reasoning deltas and Claude Code's `text_delta` / `thinking_delta` into these). It is
 * never shown as it is: the importer and goal conversations hand it to
 * `run/streamingCoalescer.ts`, which turns a block's pieces into at most one
 * {@link BlockPartial} per ~50 ms carrying the block's whole text so far. Anywhere else —
 * a worker's attempt, a planner round — it is dropped before the narration bus
 * (`narratesOnSharedBus` in `run/narration.ts`), so hundreds of them cannot crowd a slow
 * subscriber's buffer.
 *
 * The block ends with the finished `reply` or `thinking` carrying the same
 * {@link blockId}. A delta after that is late and is dropped.
 */
export interface BlockDelta {
  readonly _tag: "delta";
  /**
   * The harness's own id for the block, stable from its first piece to the finished block:
   * an OpenCode block's assistant message id, channel and ordinal (`openCodeBlockId`), a
   * Claude Code call's message id with the block's stream index (`claudeCodeBlockId`).
   * Unique within one session.
   */
  readonly blockId: string;
  /**
   * The model call the block belongs to — Claude Code's `message.id`, OpenCode's
   * `assistantMessageID` — the same on every block of one call (A6 U5 review). What the live
   * item's `blockCall` is made from, so a reader that needs "the same call" never has to
   * read it out of {@link blockId}. Optional only so a driver that cannot name the call
   * still streams.
   */
  readonly call?: string | undefined;
  readonly channel: BlockChannel;
  /** The new text only, appended to what the block already holds. */
  readonly text: string;
}

/**
 * A block's **whole text so far**, as the coalescer publishes it — never produced by a
 * harness driver.
 *
 * The full text rather than the piece, so a reader that missed an update (the bus is a
 * sliding buffer) loses nothing but an intermediate frame: the next one carries all of it.
 * Capped by {@link NARRATION_FIELD_MAX}, as the finished block will be. **Live only**:
 * published on the narration bus for the live stream, never written anywhere, and gone
 * once the finished block replaces it.
 */
export interface BlockPartial {
  readonly _tag: "partial";
  readonly blockId: string;
  /** The block's call, as its deltas named it ({@link BlockDelta.call}). */
  readonly call?: string | undefined;
  readonly channel: BlockChannel;
  readonly text: string;
}

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
      /**
       * Continue this existing session of this harness instead of creating one.
       *
       * **The conversation was never ours and was never in memory** (S2.5): Claude Code
       * keeps a JSONL transcript on disk and OpenCode a row in one SQLite file, so both can
       * be talked to again by a process that did not open them. What died with the old
       * process is the live handle and the credential — so a resume is: this call, then the
       * credential, then the MCP registration, then a prompt. The acquire order is unchanged
       * and `harness/liveAgentSessions.ts` is still the only thing that runs it.
       *
       * The answer's `id` is this same session id: a resume keeps the conversation's
       * identity, which is the point of it.
       *
       * **{@link sessionId} is ignored when this is set**, and that is not a convenience —
       * the Claude Agent SDK refuses `sessionId` for an id that already has turns ("already
       * in use") and documents the two as mutually exclusive unless forking. A caller passes
       * one or the other.
       *
       * {@link directory} must be the directory the harness itself resolves the session in
       * ({@link SessionContinuation.directory}), not a fresh one: see there.
       *
       * Nothing checks here that the session exists. Ask
       * {@link sessionContinuation} first; this call reports the harness's refusal if you
       * did not.
       */
      readonly resume?: string | undefined;
    }) => Effect.Effect<SessionRef, HarnessFailure>;
    /**
     * Moves one session onto another model of **this same harness**, or onto other options
     * of the model it already has.
     *
     * The harness is pinned to a conversation and the model is not: an operator may change
     * model or reasoning at any time, including while a turn is running, and the change is
     * applied at once — the harness takes it from its next model call. Nothing here changes
     * the harness, and nothing here can: a session id belongs to one harness.
     *
     * `model` is a name this instance's catalogue knows, as for {@link createSession}, and
     * `options` follows that operation's rules exactly. It is **already resolved against the
     * new model's descriptors by the caller** (`harness/modelOptions.ts`), so every id here
     * is one this harness reported for `model` and every value is one of that descriptor's
     * choices. What each implementation owns is the translation — OpenCode puts the variant
     * on the session's model reference, the Claude Agent SDK takes an `effortLevel` flag
     * setting — and what to do with `MODEL_OPTION_DEFAULT_CHOICE`. **Absent options mean
     * "nothing chosen" for the new model**: a reasoning level chosen for the old model is
     * not carried across, because it was resolved against the old model's descriptors and
     * the new one may not offer it.
     *
     * **Idempotent.** Switching a session to the model and options it already has succeeds
     * and leaves it as it was, so a caller that lost the answer may simply ask again.
     *
     * **Not the record of the model.** This changes what the harness uses; which model a
     * conversation is on is the session row's, and the caller updates the row only after
     * this has succeeded. A failure leaves the harness on whatever it had — or, for a
     * transport failure, on an *uncertain* model, which asking again settles.
     *
     * ## Per harness
     *
     * - **OpenCode** — `session.switchModel` with the variant on the `Model.Ref`, bounded
     *   like every control call. The session's stored model reference is what changes, so
     *   it applies whether or not this process (or any process) is running a turn on it, and
     *   it outlives this process. A session OpenCode does not have fails with status 404.
     *   The generated client does not put {@link SESSION_NOT_FOUND_TAG} on this route's
     *   404, so a caller tests `tag === SESSION_NOT_FOUND_TAG || status === 404`, as every
     *   other not-found reader on this seam already does.
     * - **Claude Code** — `Query.setModel` and then `Query.applyFlagSettings({ effortLevel })`
     *   on the live query, each bounded by the control timeout. The session's record is
     *   updated after each answer, and it is what makes a repeat send nothing. It is not
     *   what a resume reads: a resume rebuilds the record from {@link createSession}'s
     *   input. The reasoning level is always sent, `null` when nothing (or the default) was chosen,
     *   because the SDK reads `null` as "the model's own default" and leaving it out would
     *   carry the old model's level across. A session that has been created and not yet
     *   prompted has no query: the record is changed and the first prompt starts on it.
     *   Two switches on one session are taken one after the other, never interleaved.
     *
     *   **A Claude Code session this process does not hold live is refused**, with
     *   {@link SESSION_NOT_FOUND_TAG} and status 404. That is a session whose query is gone or
     *   going: a single-turn session that has finished or is finishing, an interrupted one,
     *   or one from a process that has since exited. There is nothing to send a control
     *   request to. **The same answer comes back when the query closes while a switch is
     *   waiting on its control response** — `setModel` takes about a second, so a Stop,
     *   a stream failure or a single-turn session ending inside that second is ordinary —
     *   rather than an uncertain transport failure: the query is gone whatever it did with
     *   the request. A failed stream is the case that needs waiting for, because the SDK
     *   rejects the request before it errors the stream; the harness gives the stream a
     *   short bound to end before it decides. That is not a lost switch. A resume opens a *new* query through {@link createSession}, which takes its
     *   model and options from the caller — that is, from the session row — so a caller
     *   that sees this tag updates the row and the next resume runs on the new model.
     *   Writing it onto a dead record instead would be a change nothing ever reads.
     *
     * ## Measured
     *
     * By `spike/modelSwitchProbe.ts` on 2026-11-03, through this seam's own implementations
     * against the real harnesses. **Both take a switch at the next model call of the turn
     * already running.** Neither holds it until the turn ends, so neither implementation
     * defers anything or refuses mid-turn.
     *
     * - **OpenCode** — `opencode` 2.2.5 server, `@opencode/client` 2.1.0, Z.AI Coding Plan
     *   `glm-5.3-flash` → `glm-5.3`. (The free `opencode/*-free` models were all answering
     *   429 `provider.free-limit` that day, which is a quota and not a switch result.) One
     *   long turn of seven model calls, switched after the first tool result: the switch
     *   was acknowledged in 8 ms, the next step began 28 ms later on `glm-5.3`, and all six
     *   remaining steps ran on it. The step before the switch stayed on `glm-5.3-flash`.
     *   OpenCode writes a `model-switched` entry into the transcript (`model` and
     *   `previous`), publishes `session.model.selected`, and re-sends its instruction
     *   catalogue as a `system` entry before the next step. Sending the same switch again
     *   was acknowledged and wrote **no** second `model-switched` entry. Between turns, the
     *   next turn ran on the new model with variant `high` recorded on its assistant
     *   message. A reference sent with no variant is recorded as `variant: "default"`.
     * - **Claude Code** — CLI 2.1.310, `@anthropic-ai/claude-agent-sdk` 0.3.310,
     *   `claude-haiku-4-5` → `claude-sonnet-4-5` mid-turn, `claude-sonnet-5` and back to
     *   `claude-haiku-4-5` between turns. Three runs. `setModel` took 1.0–1.2 s to be
     *   acknowledged. The model call already in flight when it was sent finished on Haiku
     *   (`message.model`), and every later call of the same turn ran on Sonnet 4.5: five
     *   later calls in two runs. In the third run Haiku ended the turn on the in-flight
     *   call, so the switch first showed on the next turn. Between turns, the next turn's
     *   `system/init` names the new model and its calls run on it. Effort was read back
     *   through the `CLAUDE_EFFORT` the CLI exports to Bash. `low` read `low`. A following
     *   `effortLevel: null` on the same model read `high`, Sonnet 5's default, so `null`
     *   resets the level rather than keeping it. An effort-only change to `high` read
     *   `high`, acknowledged in about 10 ms. Haiku 4.5 after `null` read `high`. A repeat of
     *   the same switch sent nothing and returned in 0–1 ms.
     *
     * What the probe did not measure: an effort change mid-turn, and the context window
     * after a switch. Both run on the same control channels as the model switch above.
     */
    readonly switchModel: (
      sessionId: string,
      model: string,
      options?: readonly ModelOptionSelection[] | undefined,
    ) => Effect.Effect<void, HarnessFailure>;
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
      /**
       * The files this message carried, already stored in the session's own working
       * directory (A6 F9). Every implementation appends one line per file to `text`
       * (`withAttachmentLines`), and gives inline what its harness takes inline — Claude
       * Code an image block per image, OpenCode a file part per image, `text/plain` or PDF
       * (`harness/attachments.ts`). Absent or empty: the prompt is `text` alone, exactly as
       * before.
       */
      attachments?: readonly MessageAttachment[],
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
    /**
     * Whether a turn is in flight on one session, and how the last completed one ended.
     *
     * **Two answers and not one**, which is {@link SessionActivity}'s whole reason for
     * existing: an implementation establishes "is a turn in flight" from the execution it
     * owns, and reports an outcome only when the answer is `idle`. Reporting an outcome
     * beside `activity: "running"` is reporting an earlier turn's answer about the current
     * one, and callers ignore it rather than trust it.
     *
     * An implementation that cannot answer at all fails, and `recovery/harnessStatus.ts`
     * maps the failure to `missing` or `unreachable` — both `uncertain`. It must not
     * invent `activity: "running"` to stand in for not knowing.
     */
    readonly sessionStatus: (
      sessionId: string,
    ) => Effect.Effect<SessionStatus, HarnessFailure>;
    /**
     * How full one session's context window is, and what fills it where the harness can
     * say (A6 U9). A read for a meter, asked when a screen asks — on opening a conversation,
     * after a turn, after a model switch — and never per model call.
     *
     * Claude Code answers a session this process holds from the CLI's own
     * `getContextUsage()`: the last call's exact usage, the model's window, and — when
     * `read.breakdown` — the CLI's category counts. One it does not hold is read from the
     * stored transcript, with no window and no categories. OpenCode answers from the
     * session's newest stored call and the catalogue's window for `read.model`, and has no
     * categories to give. See {@link HarnessContextUsage}.
     */
    readonly contextUsage: (
      sessionId: string,
      read: ContextRead,
    ) => Effect.Effect<HarnessContextUsage, HarnessFailure>;
    /**
     * Whether a session this process no longer holds can be continued (S6).
     *
     * **A different question from {@link sessionStatus}, deliberately asked separately.**
     * That one asks how a session's last turn *ended* and both drivers answer it badly for a
     * session from a dead process — which is a recorded defect in worker and round recovery,
     * and is S7's to fix. This asks only whether the conversation is still there to be
     * talked to, which both drivers answer precisely: Claude Code from the transcript's own
     * metadata, OpenCode from the session row. Nothing here reads an outcome, and a caller
     * of this learns nothing about whether a turn is running.
     *
     * Never used to decide that a session *is* live. A session this process holds is live
     * because this process holds it, and that is the registry's answer, not the harness's.
     */
    readonly sessionContinuation: (
      sessionId: string,
    ) => Effect.Effect<SessionContinuation, HarnessFailure>;
    /**
     * What the harness currently calls one session (S9). See {@link SessionTitle}.
     *
     * **One session per call, on both drivers, and that is the cost shape a caller plans
     * around.** It looks as though OpenCode could answer a whole list at once — `session.list`
     * carries `title` — but that endpoint is a newest-first page over *every* session the
     * server holds, not a lookup by id, so finding a handful of named sessions in it means
     * paging until they turn up. `session.get` is one bounded round trip per id. Claude Code's
     * `getSessionInfo` is one file read per id, and its `listSessions` is per project
     * directory, which for the importer is one per import. So neither driver is cheaper in
     * bulk for the question callers ask, and the seam does not pretend otherwise: a caller
     * listing N sessions makes N calls, concurrently and under its own deadline.
     *
     * **Bounded**, like everything here but {@link sessionEvents}: an implementation holds
     * each call to its control timeout. A caller drawing a list should bound the whole
     * fan-out more tightly than that, because a title is decoration and the list is not.
     *
     * Read-through and never stored: both harnesses retitle a conversation as it develops,
     * so a copy kept by this application would be a second copy of the harness's data with
     * no way to know it had gone stale (DECISIONS.md §8).
     */
    readonly sessionTitle: (
      sessionId: string,
    ) => Effect.Effect<SessionTitle, HarnessFailure>;
    /**
     * One session's messages, as the harness retains them: **oldest first, and all of
     * them.**
     *
     * That order and that completeness are this interface's promise, and each
     * implementation has to make it true rather than inherit it, because neither
     * harness's bare read does:
     *
     * - OpenCode's `message.list` answers the newest 50, newest first, unless told
     *   otherwise. `openCodeHarness` asks for `order: "asc"` and follows `cursor.next`
     *   until a page comes back empty.
     * - Claude Code's `getSessionMessages` returns the conversation chain from its root
     *   to its leaf, which is chronological, and has no default limit; `claudeCodeHarness`
     *   passes none.
     *
     * "All of them" means all the harness *holds*: the two retain very differently —
     * OpenCode answers from a running server's store, Claude Code from a transcript on
     * disk that outlives the process — and what a harness has deleted or never kept is
     * not here. It also means the harness's own notion of a message: Claude Code's list
     * is user and assistant messages only, OpenCode's carries its `idle`, `shell` and
     * `synthetic` entries too, so a caller counts neither as "turns".
     *
     * Callers lean on the order: {@link lastAssistantText} scans from the end, and the
     * transcript and the round and goal narrations replay it as it stands. A new
     * implementation that cannot keep the promise must sort or refuse; it must not
     * return a truncated or reversed list under this type.
     *
     * `read.uploadsFolder` is where the caller stored the files this session's messages
     * carried (A6 F9): `<the session's working directory>/uploads`, from the caller's own
     * record of where the session runs. Only a path line naming a file stored there is read
     * back as {@link MessageEntry.attachments}; without it, every line stays in the words.
     */
    readonly messages: (
      sessionId: string,
      read?: MessageRead,
    ) => Effect.Effect<readonly MessageEntry[], HarnessFailure>;
    /**
     * Asks the harness to stop whatever the session is doing.
     *
     * Reports whether the harness says it interrupted something: `false` for a session
     * that was already idle, which is not a failure and is worth being able to tell apart.
     * `"background"` when no turn was running but background work was ({@link
     * SessionStatus.background}), and that is what was stopped: no turn ends for it, so
     * nothing is marked interrupted, and whether all of it stopped is `sessionStatus`'s to
     * say afterwards. Only Claude Code answers it.
     * A failure means the harness did not acknowledge the interrupt, so whether the turn
     * stopped is uncertain. For a worker attempt or a planner round, carrying work on after
     * an interruption means a new attempt identity (DECISIONS.md §15), and both supervisors
     * revoke the authority whatever this answers.
     *
     * **A `multiTurn` session stays open and promptable after an interrupt** (A6 F5): the
     * turn in flight ends `interrupted`, and the conversation's next message is an ordinary
     * steer into the same session. A single-turn session is over, as it always was.
     *
     * ## What an interrupt does, measured (2026-11-04, `spike/interruptProbe.ts`)
     *
     * One long turn, a `queued` steer sent while it ran, an interrupt half a second later,
     * thirty seconds of quiet, then a third message.
     *
     * - **Claude Code 2.1.310 (Agent SDK 0.3.310), `claude-haiku-4-5`.** `Query.interrupt()`
     *   is acknowledged in ~15 ms; the CLI writes a `[Request interrupted by user]` user
     *   entry and the turn's `result` arrives ~10 ms later as `error_during_execution`
     *   (`outcomeOf` reads it as `interrupted`). **The queued message then runs at once, on
     *   its own**, as a turn of its own with its own `result` — the operator who queued it
     *   and pressed Stop sees the conversation answer it. The query stays open: the third
     *   message, thirty seconds later, was answered normally. Each `result` names the message
     *   it answered, so the driver's count of unanswered messages stays true across an
     *   interrupt, and the implementation only has to keep the query open
     *   rather than close it (it used to close it, which made Stop end the conversation).
     * - **OpenCode 2.2.5, `zai-coding-plan/glm-5.3-flash`.** `session.interrupt` answers
     *   `interrupted: true` in ~20 ms and the session is idle with `outcome: "interrupted"`
     *   ~50 ms after. **The queued message does not run**: OpenCode's run coordinator claims
     *   the interrupted execution's pending wakes, so the message stays in the session's
     *   inbox — not in its transcript — until something wakes the session again. The third
     *   message did, and both then ran in one execution: the queued message first, then the
     *   new one, one `idle` at the end. The session is promptable throughout.
     *
     * The two harnesses disagree about a queued follow-up, and the seam does not hide it:
     * there is no app-owned queue to hold such a message back (`V2(chat):` at
     * `LiveAgentSessions.deliver`).
     */
    readonly interruptSession: (
      sessionId: string,
    ) => Effect.Effect<boolean | "background", HarnessFailure>;
    /**
     * What a `queued` steer still waiting behind a turn does when that turn is interrupted,
     * as measured above: `runs` — the harness runs it at once, as a turn of its own (Claude
     * Code); `held` — the harness keeps it and runs it with the session's next message
     * (OpenCode). A value, because it is a property of the harness rather than of a call,
     * and the Stop answer has to tell the operator which one happened to their message.
     */
    readonly queuedOnInterrupt: "runs" | "held";
    /**
     * Whether the harness is holding an operator message for this session that it will run
     * only with the session's next message — what a Stop has to tell the operator about.
     *
     * Asked after an interrupt, and only of a `held` harness: the spine cannot infer it,
     * because on OpenCode a queued message starts the moment the turn ahead of it finishes,
     * with no idle between, so "delivered while busy and not idle since" also describes the
     * message that *became* the stopped turn (A6 F5 review). OpenCode answers from the
     * session's inbox. A `runs` harness holds nothing after an interrupt by definition — what
     * was queued is already running — and answers `false`.
     */
    readonly holding: (
      sessionId: string,
    ) => Effect.Effect<boolean, HarnessFailure>;
    /**
     * Ends one session, so that **nothing of it runs after this returns**: the turn in
     * flight is stopped, and a message queued behind it is dropped rather than run.
     *
     * The one close a caller has to make, and only for a `multiTurn` session: a worker's or a
     * round's session ends itself when its single turn does, which is why this seam went
     * without one until the conversations (A6 F5). A conversation's session ends only when
     * it is told to, and revoking its credential is not telling it — the agent keeps running
     * on its own authority (its shell, the policy gate's allowances) until the harness is.
     *
     * **Takes the {@link SessionRef} `createSession` returned, not an id**, and ends that
     * opening only: see {@link SessionRef}. A ref this harness did not hand out, or one whose
     * session has already ended, is answered successfully with nothing done, so this is
     * idempotent. A failure means the harness could not be reached, so whether the session
     * is still running is uncertain; the caller has nothing better to do than log it,
     * because its own authority is going either way.
     *
     * - **Claude Code** owns the CLI subprocess — it spawns it, in a process group of its
     *   own — and stops it here: the query is closed, the group is sent `SIGTERM` at once
     *   and `SIGKILL` after a short bound, and this returns once the group is gone. Closing
     *   the query alone is not enough: SDK 0.3.310's `close()` only ends the CLI's stdin and
     *   signals it 2 s later, and a review watched an ended import run a tool in that
     *   window. The tool processes the CLI started are in its group and go with it.
     * - **OpenCode** keeps a session for ever by design, so ending one means emptying it:
     *   every message waiting in the session's inbox is cancelled, then the execution in
     *   flight is interrupted. Cancelled first, so a turn that finishes between the two
     *   calls has nothing to go straight on to. A ref superseded by a later `createSession`
     *   for the same id is left alone: OpenCode runs one execution per session, and that
     *   execution is the later opening's.
     */
    readonly endSession: (
      session: SessionRef,
    ) => Effect.Effect<void, HarnessFailure>;
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
 * spikes on sessions that produce exactly one. {@link AgentHarness.messages} promises
 * oldest first and complete, so a session that spoke more than once — and the scope
 * importer works through up to eight pages in one turn — has its report at the *end* of
 * the list. That is a guarantee each driver makes, not a property of the harnesses:
 * OpenCode's own default is the newest 50 *newest-first*, and this scan read the oldest
 * reply on such a list until `openCodeHarness.messages` asked for `order: "asc"` and
 * followed the cursor. It trusts the order it is given and does not re-sort.
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
