/**
 * The scope importer: one agent session that reads a program's pages and writes its scope.
 *
 * Started by `createTarget` when the operator pasted at least one program link (D13), and
 * by nothing else. Its first turn runs once per target creation and finishes before any goal
 * exists, and it has three tools — `add_scope_entry`, `record_imported_asset`, `read_scope` —
 * on its own MCP endpoint.
 *
 * ## The session outlives its first turn
 *
 * The importer is becoming a conversation (the importer conversation design, S2), so the
 * session — and the credential and MCP registration its scope holds — no longer ends when
 * the first turn goes idle. It lives in the shared registry `harness/liveAgentSessions.ts`,
 * the same spine the goal conversation runs on, created `multiTurn` and keyed by import id.
 * Three things close it, and they are the whole list:
 *
 * 1. **The operator ends it** — {@link ScopeImporter.stop}, the one intentional close.
 * 2. **This layer's finalizer**, which closes every session still open. A `SIGINT` ends
 *    every importer conversation, which is what makes "no longer than the process" true.
 * 3. **A prompt the harness refuses.** The spine closes a session whose opening prompt
 *    failed, so the next open builds a fresh one rather than failing the same way forever;
 *    on Claude Code that includes a session whose query has closed.
 *
 * Each close records `import_sessions.ended_at` and why (`ended_reason`, `0027`): `operator`
 * for 1, `shutdown` for 2, `refused` for 3, and `open_failed` for an open that never got as
 * far as a working session. The importer's toolkit refuses every write under an import the
 * **operator** ended. That is what stands behind a credential that has no clock: the grant
 * is issued without expiry, as a goal's is, because a conversation the operator leaves and
 * comes back to would otherwise be a live session whose every tool call is a `401` with no
 * cause anyone can see — and a longer clock is the same failure further away.
 *
 * **One row is one authority period, not one session.** The other three reasons are this
 * process letting go — the credential went with the in-memory grant, so there is nothing
 * left to gate — and refusing on them would stop a gracefully restarted import from ever
 * being continued (S7). The row's end is never cleared: a later opening on the same harness
 * session gets a new import id and a new row, and the index still reads it as one session
 * because it groups by `harness_session_id`. `0027`'s header has the rule in full.
 *
 * ## No idle timeout, and that is a decision rather than an omission
 *
 * The goal path's argument, and it transfers without modification. An idle import session
 * costs an entry in a map and, on Claude Code, one parked `query()` whose generator is
 * waiting on a promise; neither accumulates with time, and both die with the process. A
 * timeout would introduce the one failure this design exists to avoid — a conversation that
 * stops working for a reason the operator cannot see — in exchange for releasing memory
 * bounded by the number of imports an operator has open. If a bound is ever wanted it is a
 * count, not a clock.
 *
 * ## It starts no work, and this file is where that is true or false
 *
 * `createTarget` registers a row and returns. What this adds is a session whose entire
 * capability is three writes to one target's scope and estate: no goal row, no intent, no
 * attempt, no run, no supervisor fiber watching for a result to act on. D13 records that
 * the operator's review is the only control on an imported scope, and that the review is a
 * real step only because there is a genuine gap between the import and the first
 * execution. Nothing here closes that gap, and nothing added here should.
 *
 * ## Partial results are results (D15)
 *
 * One link with parseable scope is enough. A link that 404s, needs a login or yields
 * nothing does not fail the import — the entries the other links produced stand, because
 * the session writes as it reads rather than batching to the end. There is no
 * all-or-nothing transaction across links and no "partially imported" state on the target:
 * entries are entries however many pages contributed them, and `source = 'imported'` plus
 * each entry's own note already says where each came from.
 *
 * **Every link failing is not an error state either.** The import settles `finished` with
 * nothing written, the browser shows an error toast, and the operator lands on the
 * target's Assets screen. The target was created and is entirely usable; it simply has no
 * scope yet, which is the same state as a target created with no links at all — and the
 * Assets screen already says what that means. Keeping someone on a dead progress panel to
 * contemplate a failure they cannot fix from there would be worse.
 *
 * So {@link ScopeImporter.start} has `never` on its error channel. Every way an import can
 * fail to start is a *value* ({@link ScopeImportStarted}), because none of them is a
 * reason to refuse the target.
 *
 * ## What `failed` is reserved for
 *
 * Not "the pages did not parse". `failed` is this server being unable to run the importer
 * at all: no ready harness, a session that would not open, a directory it may not use,
 * an MCP registration the harness refused. Those are the operator's to fix and
 * are reported with the refusing component's own sentence.
 *
 * ## The chat reads the session's narration; the panel reads its calls (D16, amended)
 *
 * The session's `sessionEvents` are drained onto the in-process narration bus under an
 * `import` subject, by a narrator the spine forks into the session's scope, and the
 * Auto-load page's chat subscribes through the target's live transcript. That reverses
 * half of D16 on purpose (the importer conversation design, S4): D16 was written for a
 * single-turn batch job with nobody on the other end, which has nothing to narrate to, and
 * a conversation does.
 *
 * **The other half stands.** The progress panel lists tool calls, which the importer's own
 * toolkit records as they cross our MCP boundary (`import/progress.ts`), and nothing else.
 * Narration is not on the panel and is not filtered *out* of it either: the two are
 * separate readers of separate sources, the panel a receipt of writes and the chat a
 * conversation.
 *
 * **One message is read, after the session has settled: the last thing it said.** The
 * prompt asks for it explicitly — "stop and report in a few lines: which pages you could
 * read, what you recorded, and anything you were unsure about" — and until this read, that
 * report was generated and discarded. It is a single status line on the panel and in the
 * toast, which is a different thing from narration in the list, and D16 now draws that
 * line in as many words.
 *
 * The cost this removes was the common case rather than an edge: a client-rendered program
 * page answers `200` with no scope in it, so the import succeeds at every step, writes
 * nothing, and the operator was told only "Nothing could be read from those pages" — with
 * no account of why. The session's own report is the only account anything in this process
 * has, because nothing we own observes the fetch (D13).
 *
 * It is the model's prose and is treated as such: bounded at
 * {@link SCOPE_IMPORT_REPORT_MAX} characters, read once from `messages` rather than
 * streamed, and rendered as text by a browser that escapes it.
 */
import {
  ConversationModelRefused,
  ConversationStopRefused,
  ImporterConversationRefused,
  QUESTION_RECHECK_MS,
  QuestionRefused,
  SCOPE_IMPORT_MAX_LINKS,
  ScopeImportNotFound,
  type ConversationModelDraft,
  type ConversationModelSwitched,
  type ConversationActivity,
  type ConversationContext,
  type ConversationStopped,
  type ImporterConversationView,
  type ImporterTurnAccepted,
  type ImportModelDraft,
  type ModelOptionSelection,
  type QuestionAnswers,
  type QuestionSettled,
  type ScopeImportView,
  type SteerUrgency,
  SubagentStopRefused,
  type SubagentStopped,
} from "@bit/contracts";
import { Clock, Context, Deferred, Effect, Layer, type Duration } from "effect";

import {
  agentUnavailableDetail,
  IMPORT_SESSION_ROLE,
  importerConversation,
  importerReopenFor,
  importSessionAgent,
  type RecordedImportSession,
} from "./importerHistory";
import { resolveImporterModel } from "./importerModel";
import { operatorPages, type ImporterPromptInput } from "./importerPrompt";
import { importerSessionTitle } from "./importerTitle";
import { ScopeImportProgress, widenPages } from "./progress";
import { IMPORTER_AGENT, type AgentDefinition } from "../agent/registry";
import {
  makeConversations,
  type ConversationAccepted,
  type ConversationOpening,
  type ConversationRow,
  type ConversationSend,
  type Conversations,
} from "../conversation/conversations";
import { lastAssistantText } from "../harness/agentHarness";
import type {
  LiveAgentSession,
  LiveSessionCloseReason,
} from "../harness/liveAgentSessions";
import { resolveSessionModelOptions } from "../harness/modelOptions";
import { HarnessResolver } from "../harness/resolver";
import { turnStopped } from "../harness/turnStop";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { newImportId } from "../persistence/identifier";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { RunNarrations } from "../run/narration";
import { WorkerEndpoints } from "../run/supervisor";
import type { ReadUpload } from "../upload/uploads";

/**
 * What became of the attempt to start an import.
 *
 * A value rather than an error channel, for the reason in this module's header: none of
 * these is a reason to refuse the target the operator just created.
 */
export type ScopeImportStarted =
  /** No links were given, so there is nothing to import and nothing to explain. */
  | { readonly _tag: "none" }
  | {
      readonly _tag: "started";
      readonly importId: string;
      /** As resolved. The operator's pick may have been a dead instance. */
      readonly harnessInstanceId: string;
      readonly model: string;
      /** Pages the operator's message made citable. Empty without a message. */
      readonly pagesAdded: readonly string[];
      /** Pages the message gave that did not fit under the cap. */
      readonly pagesNotAdded: readonly string[];
      /** Pages carried forward from the import this one continues. */
      readonly pagesCarried: readonly string[];
    }
  /** Links were given and this server cannot read them. The target is created regardless. */
  | {
      readonly _tag: "refused";
      /**
       * No harness at all, the chosen one cannot take a session, the agent asked for is
       * granted an authority this service does not mint, or the model the operator named is
       * not in its harness's catalogue (see `startWith`).
       */
      readonly reason:
        | "no_harness"
        | "harness_not_ready"
        | "agent_unavailable"
        | "model_unavailable";
      readonly detail: string;
    };

/**
 * How much of the session's closing report the panel's status line carries.
 *
 * A few lines is what the prompt asks for and what an operator reads at a glance. The
 * bound is here rather than trusted to the model, because the field it lands in is
 * `ScopeImportView.detail` — one sentence's worth of screen, polled over a browser
 * connection — and a session that answered with the pages it read instead of a summary
 * would otherwise put a document in it. Cut at a word boundary and marked, because a
 * silently truncated report is a report a reader would misread.
 */
export const SCOPE_IMPORT_REPORT_MAX = 700;

/** The session's closing report, bounded, or `null` when it said nothing. */
export const importReport = (text: string): string | null => {
  // Newlines collapse to spaces: this is a status line, and the model writes in lines.
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  if (flat.length <= SCOPE_IMPORT_REPORT_MAX) return flat;
  const cut = flat.slice(0, SCOPE_IMPORT_REPORT_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SCOPE_IMPORT_REPORT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * What an import session's live entry carries beyond the spine's own fields: the agent it
 * runs as, so a later message is framed by the same agent that opened it.
 */
interface ImportSessionMeta {
  readonly agent: AgentDefinition<ImporterPromptInput>;
}

/** Where an import's first turn says how its open went, for a caller that waits on it. */
type Opening = ConversationOpening<
  ImportSessionMeta,
  ImporterConversationRefused
>;

/** An `import_sessions` row as the conversation core reads it, with the importer's own fields. */
interface ImportRow extends ConversationRow {
  /** The pages the import may cite, durable since `0029`; null before. */
  readonly pages: readonly string[] | null;
  /** The agent the session runs as (`0002`). */
  readonly agentId: string;
}

/** What a message made citable, which an accepted message names. */
interface PagesWidened {
  readonly added: readonly string[];
  readonly notAdded: readonly string[];
}

/**
 * Turns a failure to open an importer session into the refusal a composer prints.
 *
 * `plan/goalConversation.ts`'s `refuse`, for the same failures and in the importer's
 * words: every component's own sentence is kept as the detail.
 */
const refusal = (failure: {
  readonly _tag: string;
  readonly message?: string;
  readonly reason?: string;
}): ImporterConversationRefused => {
  switch (failure._tag) {
    case "FleetError":
      return new ImporterConversationRefused({
        reason:
          failure.reason === "invalid_role_id"
            ? "import_directory_unusable"
            : "target_unavailable",
        detail: failure.message ?? "that target could not be opened",
      });
    case "RoleDirectoryRefused":
      return new ImporterConversationRefused({
        reason: "import_directory_unusable",
        detail:
          failure.message ??
          "this import's directory cannot be used, so no session was opened",
      });
    case "HarnessTransportError":
    case "HarnessDecodeError":
      return new ImporterConversationRefused({
        reason: "harness_unreachable",
        detail: failure.message ?? "the agent harness did not answer",
      });
    case "HarnessNotReady":
      return new ImporterConversationRefused({
        reason: "harness_not_ready",
        detail:
          failure.message ??
          "that harness instance is not usable on this server",
      });
    case "UploadWriteFailed":
      return new ImporterConversationRefused({
        reason: "upload_unwritable",
        detail:
          failure.message ??
          "the message's files could not be stored, so nothing was sent",
      });
    default:
      return new ImporterConversationRefused({
        reason: "store_unavailable",
        detail:
          failure.message ?? "this target's database could not be written to",
      });
  }
};

/**
 * Why an import's session is not live in this process, in a sentence for the note on the
 * fresh session a message to it opens.
 */
const notHeldBecause = (reason: string | null): string => {
  switch (reason) {
    case "refused":
      return "the harness refused a message into it, which closed it";
    case "shutdown":
      return "the server was shut down after it was opened";
    case "open_failed":
      return "it never finished opening";
    default:
      return "the server has restarted since it was opened, and its authority lived only in that process";
  }
};

export interface ScopeImportRequest {
  readonly targetId: string;
  readonly targetName: string;
  /** The engagement folder, for the role directory's containment check. `null` when there is none. */
  readonly workspacePath: string | null;
  readonly links: readonly string[];
  /**
   * The operator's first message, for a conversation opened from the Auto-load page's
   * composer (S3.4). **Present means the operator asked for something**, so zero links is
   * not `none` on this path: `none` belongs to the create-target route, which asked whether
   * there were links to read. Absent for an import started from links alone.
   */
  readonly message?: string | undefined;
  /**
   * The files that first message carried, read and checked (A6 F9). Stored in the
   * session's directory once the spine has checked it, before the opening prompt.
   */
  readonly uploads?: readonly ReadUpload[] | undefined;
  /**
   * Pages an earlier import of the same conversation could cite, carried forward when a
   * message to it opens a fresh session (finding 4 of the S3 review). They were the
   * operator's — pasted links and pages on a line of their own in a message, never a model's
   * or a fetched page's — and the successor is the same conversation, so it may cite them
   * too. Bounded by the same cap as every other page list (`progress.widenPages`).
   */
  readonly earlierPages?: readonly string[] | undefined;
  /**
   * The import this one takes over from, when a message to an import this server no longer
   * holds opens it. Recorded as that import's successor the moment this one's id is minted,
   * so a disconnect while it opens cannot lose the link (see `successors`).
   */
  readonly predecessor?: string | undefined;
  /**
   * The harness session this import **continues** rather than creates (S6).
   *
   * Present when the harness said it still holds the predecessor's session and resolves it
   * in a directory this server gates ({@link importerReopen}). Then the new import is a new
   * *authority period* on the same conversation: a new id, a new row, a new credential and a
   * new registration — and the same `harness_session_id`, which is what makes the session
   * index show one conversation as one row again (S3.3's recorded cost, half paid off).
   *
   * `directoryImportId` is the import whose directory the **harness** resolves the session
   * in, which is the original opening's and not this one's. The session is created — or
   * rather continued — in that directory, which is the one the harness resolves it in.
   *
   * Absent for every other open, including a reopen that could not resume.
   */
  readonly resume?:
    | { readonly sessionId: string; readonly directoryImportId: string }
    | undefined;
  /**
   * The operator's pick, when they touched the importer's picker: `ImportModelDraft` as it
   * arrived.
   *
   * The contract's own type rather than a copy of its fields, and `start` names every one
   * of them when it reads it (see {@link everyFieldRead}), so a field added to the draft is
   * a compile error there until something reads it — instead of arriving decoded and being
   * dropped without a word, which a hand-written shape here could not catch.
   *
   * `modelOptions` is what was set *of* the model, unresolved. It is resolved in `start`
   * against the model the importer actually resolved — which may not be the one the browser
   * was showing — and reaches `createSession` as `options`, absent when nothing survives.
   * A reopen passes back what the earlier session was opened with, read from
   * `import_sessions.model_options` (`0028`), so the operator's setting is not silently
   * dropped with the session that carried it; already resolved, it resolves to itself.
   */
  readonly choice?: ImportModelDraft | undefined;
  /**
   * The agent the session runs as: its prompts and the grant its credential carries.
   *
   * Absent for a new conversation, which opens as {@link IMPORTER_AGENT} — the only agent
   * there is. A reopen passes the one the predecessor's row recorded (`0002`), because the
   * agent is pinned once the first message is sent: a successor session, resumed or fresh,
   * is the same conversation and runs as the same agent. Resolved by the caller rather than
   * named by id here, so an id this server does not define is refused where it was read.
   */
  readonly agent?: AgentDefinition<ImporterPromptInput> | undefined;
}

/**
 * Compiles only when `_rest` has no fields: the remainder of a destructure that named every
 * field it reads. It does nothing at runtime; the check is the parameter's type.
 */
const everyFieldRead = (_rest: Record<string, never>): void => {};

/**
 * How a dismissal the harness did not answer is followed up (A7-Q review 2): the harness is
 * asked again whether the question still waits, first after `first`, then backing off by
 * doubling to at most `most` between asks, for `window` in all. A reference so a test can
 * make it short; the server never changes it.
 */
export const QuestionRecheck = Context.Reference<{
  readonly first: Duration.Input;
  readonly most: Duration.Input;
  readonly window: Duration.Input;
}>("bit/import/QuestionRecheck", {
  defaultValue: () => ({
    first: "1 second",
    most: "15 seconds",
    window: QUESTION_RECHECK_MS,
  }),
});

export class ScopeImporter extends Context.Service<
  ScopeImporter,
  {
    /**
     * Starts one import, and answers without waiting for it.
     *
     * **The response must not wait for the import**, which is the property this exists to
     * have: `createTarget` answers as soon as the row is registered and the session is
     * prompted, and a fiber in this service's own scope owns everything after that. An
     * import reads several pages and takes a minute or more; a creation request that
     * waited for it would be a creation request that timed out.
     */
    readonly start: (
      input: ScopeImportRequest,
    ) => Effect.Effect<ScopeImportStarted>;
    /**
     * Stops one import, keeping everything it has already written.
     *
     * Answers with the import as it stood at the stop, which is the receipt the operator
     * pressed the button to see. `undefined` for an import this process does not know.
     */
    readonly stop: (
      importId: string,
    ) => Effect.Effect<ScopeImportView | undefined>;
    /** One import as the panel reads it. `undefined` when this process forgot it. */
    readonly view: (
      importId: string,
    ) => Effect.Effect<ScopeImportView | undefined>;
    /**
     * Opens a conversation: a new import whose first turn is the operator's message.
     *
     * {@link start} with a message, and answering once the opening prompt has been accepted
     * rather than as soon as the fiber is forked — the operator is at a composer waiting to
     * be told whether it worked, not at a create-target form that must not wait.
     */
    readonly converse: (
      input: Omit<ScopeImportRequest, "links" | "message" | "uploads"> & {
        readonly text: string;
        /** The files the message carried (A6 F9), read and checked by the route. */
        readonly uploads?: readonly ReadUpload[] | undefined;
      },
    ) => Effect.Effect<ImporterTurnAccepted, ImporterConversationRefused>;
    /**
     * Gives one operator message to an import (S3).
     *
     * Live in this process: delivered into its session as a steer at `urgency` (`queued`
     * unless said otherwise), under the **same** import id, so its writes count toward the
     * same tally. Ended by the operator: refused. Anything else — closed after a refused
     * prompt, lost to a restart — opens a fresh session under a **new** import id, because
     * an import id names one authority period and an ended one is never revived (`0027`).
     *
     * **Addressed to an older run, it goes to the newest** (A6 F5): an import id that is not
     * its session's newest confirmed run (`latest_import_id`) — an old tab's, after a reopen
     * — is followed to that run, as an in-memory successor is. Reopening from the old row
     * instead would open the same Claude Code session a second time while the newest run
     * holds it.
     */
    readonly send: (input: {
      readonly targetId: string;
      readonly importId: string;
      readonly text: string;
      readonly urgency?: SteerUrgency | undefined;
      /** The files the message carried (A6 F9), read and checked by the route. */
      readonly uploads?: readonly ReadUpload[] | undefined;
    }) => Effect.Effect<
      ImporterTurnAccepted,
      ImporterConversationRefused | ScopeImportNotFound
    >;
    /**
     * One import session's conversation as a reloaded tab replays it, from the harness (S6).
     *
     * **Cannot fail**, which is `import/importerHistory.ts`'s whole shape: every way of
     * having no prose is one of five answers with a sentence of its own. The row is the
     * caller's to read and to refuse an unknown id on — a stale deep link is a mistake and a
     * swept transcript is not, and only the route knows which store to look in.
     *
     * It also answers what the **next message** will do — deliver, resume, open a fresh
     * session, or be refused — by asking the harness, with the same function {@link send}
     * then acts on. That is what makes a composer offered here one that will work.
     */
    readonly replay: (input: {
      readonly targetId: string;
      readonly importId: string;
      /** The import's own row, read by the caller. See {@link RecordedImportSession}. */
      readonly recorded: RecordedImportSession;
      readonly limit?: number | undefined;
      readonly fetchTimeout?: Duration.Input | undefined;
    }) => Effect.Effect<ImporterConversationView>;
    /**
     * Whether **this process holds** the session under this import id: its scope, credential
     * and MCP registration are live.
     *
     * The honest answer to "is this importer live", which "is a run in flight" never was — a
     * session outlives its turn (S2), so an idle conversation between messages is held and a
     * run-in-flight test calls it "not running". Read-only by design: it asks the registry
     * `sessions.get` does and exposes nothing that could open or close a session. `get`
     * rather than `ready`, so an entry that is published and not yet preambled counts, as it
     * does for {@link replay}'s `live`. A session still *opening*, before it is published, is
     * not held yet; the list is a lower bound there, for a moment, and never an upper one.
     * Asked of an import id, not a session id: a conversation continued under a fresh id is
     * held under the fresh one, which is why the caller asks about each id a session has had.
     */
    readonly holds: (importId: string) => Effect.Effect<boolean>;
    /**
     * How many of the operator's messages this process holds for one import outside its
     * harness's transcript (`ImporterConversationView.queued`), whether or not the session
     * is still held — `0` once it has closed (A6 U4 review 2). Read-only; what a check that
     * a close left nothing behind asks.
     */
    readonly heldSteers: (importId: string) => Effect.Effect<number>;
    /**
     * Stops the turn running in one import's session, and keeps the conversation (A6 F5).
     *
     * **Not {@link stop}**, which ends the import's authority for good. This is the spine's
     * `interrupt`: the harness's turn ends, the session stays held with its credential, and
     * the next message continues it under the same import id. Addressed by import id and
     * applied to the import that holds the session now — the newest run, then any successor
     * this process opened — so an old tab's Stop reaches the session that is running.
     *
     * The turn's settle fiber is left alone: the interrupt makes the session idle, and that
     * fiber settles the import's view from `waitForIdle` exactly as a turn that ended by
     * itself would.
     */
    readonly stopTurn: (input: {
      readonly targetId: string;
      readonly importId: string;
    }) => Effect.Effect<
      ConversationStopped,
      ConversationStopRefused | ScopeImportNotFound
    >;
    /**
     * Stops one sub-agent the import's agent started (A7-S, E7), in the import holding the
     * session now, as {@link stopTurn} finds it: the harness's `stopSubagent`. One that runs
     * inside the turn, has ended, or that this server cannot reach is refused, with a
     * sentence that says which.
     */
    readonly stopSubagent: (input: {
      readonly targetId: string;
      readonly importId: string;
      readonly callId: string;
    }) => Effect.Effect<
      SubagentStopped,
      SubagentStopRefused | ScopeImportNotFound
    >;
    /**
     * E7's Stop all (A7-S): every running sub-agent the harness can stop on its own
     * (`stopSubagents`), then {@link stopTurn}. Sub-agents first, so a background one's end
     * is in the session before the turn's Stop, which then also stops a notification turn
     * it opened. A harness that would not stop a sub-agent fails the whole as
     * `harness_unreachable`: the turn is still stopped, and the sentence says so.
     */
    readonly stopAll: (input: {
      readonly targetId: string;
      readonly importId: string;
    }) => Effect.Effect<
      ConversationStopped,
      ConversationStopRefused | ScopeImportNotFound
    >;
    /**
     * Answers the question one import's agent is waiting on (A7-Q), in the import holding
     * the session now, as {@link stopTurn} finds it. The answers are checked against the
     * question the harness holds first. A question the harness is no longer waiting on —
     * including one read back from the transcript, whose request is gone — is refused
     * `settled`; the dock then offers the answers as a message.
     */
    readonly answerQuestion: (input: {
      readonly targetId: string;
      readonly importId: string;
      readonly questionId: string;
      readonly answers: QuestionAnswers;
    }) => Effect.Effect<QuestionSettled, QuestionRefused | ScopeImportNotFound>;
    /**
     * Dismisses the question one import's agent is waiting on (A7-Q): the harness's request
     * is cancelled, so the agent is told the operator declined. A question read back from
     * the transcript (`call:<id>`) has no request left to cancel, and is put away instead:
     * the replay stops offering it while this process runs.
     */
    readonly dismissQuestion: (input: {
      readonly targetId: string;
      readonly importId: string;
      readonly questionId: string;
    }) => Effect.Effect<QuestionSettled, QuestionRefused | ScopeImportNotFound>;
    /**
     * Whether a turn, or background work, is running in one import's session (A6 U6): the
     * spine's `status`, for the import holding the session now, found as {@link stopTurn}
     * finds it. Never fails but for an import this target does not hold: a record that cannot
     * be read is answered for the import addressed.
     */
    readonly activity: (input: {
      readonly targetId: string;
      readonly importId: string;
    }) => Effect.Effect<ConversationActivity, ScopeImportNotFound>;
    /**
     * How full one import's context window is (A6 U9): the harness's `contextUsage` for the
     * import holding the session now, found as {@link activity} finds it, on the model its
     * row says it is on now — which a switch updates. Never fails but for an import this
     * target does not hold: a harness that cannot be asked answers `unread`.
     */
    readonly context: (input: {
      readonly targetId: string;
      readonly importId: string;
      readonly breakdown: boolean;
    }) => Effect.Effect<ConversationContext, ScopeImportNotFound>;
    /**
     * Moves one import's session onto another model of its harness, or other options of its
     * model (A6 F4). The harness is the row's and is never changed here.
     *
     * Addressed by import id and applied to the import that **is** the conversation now: an
     * import this process has since reopened under a successor is followed to it, as a
     * message is, and one still opening is waited for. Then, under the spine's one-at-a-time
     * claim and opening permit: the row is read, the model checked against the row's harness
     * instance's catalogue, the options resolved against the new model; a live session is
     * switched and its registry entry and the panel follow, and the row is written only after
     * the harness accepted. A session the harness no longer runs, or none held here, has only
     * its row changed, which is what the next reopen opens on (`send`).
     */
    readonly switchModel: (
      input: {
        readonly targetId: string;
        readonly importId: string;
      } & ConversationModelDraft,
    ) => Effect.Effect<
      ConversationModelSwitched,
      ConversationModelRefused | ScopeImportNotFound
    >;
  }
>()("bit/import/ScopeImporter") {
  /**
   * The real importer.
   *
   * `Layer.effect`, whose body runs **in the layer's own scope** — Effect v4 has no
   * `Layer.scoped`, and does not need one: `Layer.effect` takes an effect that may require
   * `Scope.Scope` and excludes it from the layer's requirements. So `Effect.scope` below
   * yields this layer's scope, which is what the forked import fibers are forked into.
   *
   * That lifetime is the one that is correct: longer than the HTTP request that started an
   * import, and no longer than the process. Shutting the server down closes this scope,
   * which interrupts any first turn still reading and then — the session registry's
   * finalizer was registered first, so it runs last — closes every import session, taking
   * its credential and registration with it.
   */
  static readonly layer: Layer.Layer<
    ScopeImporter,
    never,
    | HarnessResolver
    | FleetStore
    | McpCredentials
    | WorkerEndpoints
    | ScopeImportProgress
    | TargetStores
    | RunNarrations
  > = Layer.effect(
    ScopeImporter,
    Effect.gen(function* () {
      const resolver = yield* HarnessResolver;
      const fleet = yield* FleetStore;
      const credentials = yield* McpCredentials;
      const endpoints = yield* WorkerEndpoints;
      const progress = yield* ScopeImportProgress;
      const stores = yield* TargetStores;
      const narrations = yield* RunNarrations;
      const recheck = yield* QuestionRecheck;
      // This layer's own scope, which every import's first turn is forked into. Shutting
      // the server down closes it, which interrupts any turn still reading; the session
      // registry's finalizer then revokes each credential and takes back each MCP
      // registration.
      const own = yield* Effect.scope;

      /**
       * Records that an import's authority period has ended, and why (`0026`, `0027`). An
       * `operator` end is what the importer toolkit refuses writes on. The first recorded
       * end wins, so the order the close sites run in decides the reason. Advisory in the
       * way the row is: a failure is logged and nothing else, because the credential has
       * already gone with the scope and this is the gate *behind* it.
       */
      const markEnded = (
        targetId: string,
        importId: string,
        reason: LiveSessionCloseReason,
      ) =>
        withTargetStore(stores, targetId, (store) =>
          store.endImportSession(importId, reason),
        ).pipe(
          Effect.catch((failure) =>
            Effect.logWarning(
              "a scope import's session ended but the end could not be recorded; its credential is revoked regardless",
              { targetId, importId, reason, detail: failure.message },
            ),
          ),
        );

      /** One import's row, as the conversation core reads it. */
      const importRow = (targetId: string, importId: string) =>
        Effect.map(
          withTargetStore(stores, targetId, (store) =>
            store.importSession(importId),
          ),
          (row): ImportRow | undefined =>
            row === undefined
              ? undefined
              : {
                  targetId: row.targetId,
                  harnessSessionId: row.harnessSessionId,
                  harnessInstanceId: row.harnessInstanceId,
                  model: row.model,
                  modelOptions: row.modelOptions,
                  endedReason: row.endedReason,
                  latestId: row.latestImportId,
                  pages: row.pages,
                  agentId: row.agentId,
                },
        );

      /** An accepted message on the importer's wire: the import's id and its pages. */
      const turnAccepted = (
        base: ConversationAccepted,
        pages: PagesWidened,
      ): ImporterTurnAccepted => {
        const { conversationId, ...rest } = base;
        return {
          ...rest,
          importId: conversationId,
          pagesAdded: [...pages.added],
          pagesNotAdded: [...pages.notAdded],
        };
      };

      /**
       * Every import session this process holds, on the conversation core
       * (`conversation/conversations.ts`) over the shared registry, keyed by import id.
       *
       * **This is the line that makes a session outlive its first turn**: the scope lives in
       * the registry, and only the three things this module's header lists close it.
       *
       * The importer's half of the binding: the importer endpoint, an importer credential
       * with no clock, `revokeImport` as the belt-and-braces check, `import_sessions` as the
       * rows, and the import's progress, pages and closing report as the hooks.
       */
      const conversations: Conversations<
        ImportSessionMeta,
        ScopeImportNotFound,
        ImporterConversationRefused,
        ImporterTurnAccepted
      > = yield* makeConversations<
        ImportSessionMeta,
        ImportRow,
        ScopeImportNotFound,
        ImporterConversationRefused,
        PagesWidened,
        ImporterTurnAccepted
      >(
        { endpoints, narrations, resolver, recheck, scope: own },
        {
          role: {
            // The **importer** endpoint. The path selects the toolkit and the grant decides
            // whether the request is served at all: an importer credential at the worker URL
            // is a `401` before any tool list is produced, and a worker's credential here is
            // the same — which is what makes "three tools, and nowhere else" a property of
            // the registration rather than of a filter.
            endpoint: (urls) => urls.importerMcp,
            // No clock, as a goal's has none (S2.3). A fourth caller kind is still what
            // makes this session's three tools unreachable from a worker, a planner or a goal
            // agent. What stands behind the missing clock is an `operator` end (`0026`,
            // `0027`), which the toolkit reads before every write.
            issue: (period) =>
              credentials.issueWithoutExpiry({
                _tag: IMPORT_SESSION_ROLE,
                targetId: period.targetId,
                importId: period.periodId,
              }),
            // An importer grant is one import's, so revoking by import is by period.
            revokePeriod: (period) => credentials.revokeImport(period.periodId),
            words: {
              unregisterRefused:
                "a harness would not take back the scope importer's MCP registration; the credential behind it is revoked either way",
              strayCredential:
                "a scope importer's credential outlived its session's scope and had to be revoked explicitly; the scope that acquired it should have done that",
              closed: "a scope import's session was closed",
              idKey: "importId",
            },
          },
          // The owner is the target's Auto-load chat: one per target.
          ownerOf: (opened) => opened.targetId,
          subject: (importId) => ({ _tag: "import", importId }),
          questionSubject: (importId) => ({
            attemptId: null,
            roundId: null,
            goalId: null,
            importId,
          }),
          rows: {
            read: importRow,
            markEnded,
            recordModel: (targetId, input) =>
              withTargetStore(stores, targetId, (store) =>
                store.recordImportSessionModel({
                  importId: input.id,
                  model: input.model,
                  modelOptions: input.modelOptions,
                }),
              ),
          },
          notFound: (targetId, importId, clause) =>
            new ScopeImportNotFound({
              reason: "unknown_import",
              importId,
              detail: `no scope import '${importId}' is recorded on target '${targetId}', so ${clause}`,
            }),
          openRefused: refusal,
          refused: (reason, detail) =>
            new ImporterConversationRefused({
              reason: reason === "ended" ? "import_ended" : reason,
              detail,
            }),
          // The agent's own prompts, and only through it: the agent pinned to the entry.
          followUp: (meta, text) =>
            meta.agent.prompt.followUp({ message: text }),
          reopen: ({ send, row }) => reopen(send, row),
          accepted: turnAccepted,
          words: {
            what: (importId) => `import ${importId}`,
            period: "import",
            aPeriod: "an import",
            agent: "importer",
            undelivered: (detail) =>
              `${detail}. The harness would not take the message, so this import's session has been closed; your next message opens a fresh one under a new import.`,
            unwritable: (detail) =>
              `${detail}. The session is still open; send the message again.`,
            narrationFailed:
              "a scope import's narration stream failed; this says nothing about the session, and the next message still reaches it",
            stoppedBeforeOpen: (importId) =>
              `import ${importId} was stopped before its session had opened, so nothing was said to it`,
            ended: (importId) =>
              `import ${importId} was ended by the operator, so its session's authority has ended with it and its tools refuse every write. An ended import is not reopened; start a new session to carry on.`,
          },
          hooks: {
            /*
             * A page the operator typed is added to the pages this import may cite,
             * **before** the message is delivered, so a write citing it is never refused for
             * a page the operator has just given.
             */
            delivering: (entry, text) =>
              Effect.gen(function* () {
                const widened = yield* progress.addLinks(
                  entry.id,
                  operatorPages(text),
                );
                // The durable copy (`0029`), so a session reopened after a restart can carry
                // these forward. Advisory like the row it lives on.
                if (widened !== undefined && widened.added.length > 0) {
                  yield* withTargetStore(stores, entry.targetId, (store) =>
                    store.recordImportPages(entry.id, widened.pages),
                  ).pipe(
                    Effect.catch((failure) =>
                      Effect.logWarning(
                        "the pages a scope import may cite were widened but could not be recorded; a session reopened after a restart will not carry them forward",
                        { importId: entry.id, detail: failure.message },
                      ),
                    ),
                  );
                }
                return widened ?? { added: [], notAdded: [] };
              }),
            // The import is marked working again; the core settles it once it goes idle.
            resumed: (importId) => progress.resume(importId),
            idle: ({ id, harness, sessionId, failure, more }) =>
              Effect.gen(function* () {
                if (yield* progress.stopped(id)) return "stop" as const;
                /*
                 * The session's closing report, read once, after it has settled: the only
                 * account anything in this process has of why an import wrote what it
                 * wrote. `messages` rather than the narration bus (D16): one message, pulled
                 * after the fact, for a panel and a toast that may have no browser
                 * subscribed. A failure to read it is not a failure of the import.
                 *
                 * A failure of the wait is still `finished`, not `failed` (D15): the session
                 * ending badly says nothing about whether the pages it read produced entries.
                 */
                const report = yield* Effect.map(
                  Effect.result(harness.messages(sessionId)),
                  (read) =>
                    read._tag === "Failure"
                      ? null
                      : importReport(lastAssistantText(read.success)),
                );
                // Delivered while the report was read: that message's turn is the one to settle.
                if (more()) return "again" as const;
                yield* progress.settle({
                  importId: id,
                  status: "finished",
                  detail:
                    failure !== undefined
                      ? `the importer's session ended early: ${failure.message}. Anything it had already written is kept.${report === null ? "" : ` It reported: ${report}`}`
                      : report,
                });
                return "settled" as const;
              }),
            /*
             * Running while the import is, too: from a message's acceptance until its settle
             * has read the closing report, which the session list's `running` reports.
             */
            alsoRunning: (importId) =>
              Effect.map(
                progress.view(importId),
                (view) => view?.status === "running",
              ),
            // The panel names the model the session runs, so it follows a live switch.
            switched: (importId, model) =>
              progress.switchModel(importId, model),
          },
        },
      );

      const startWith = Effect.fn("ScopeImporter.start")(function* (
        request: ScopeImportRequest,
        opening?: Opening,
      ) {
        // `none` is the create-target route's answer — it asked whether there were links to
        // read — and a conversation opened from the composer asked something else (S3.4).
        if (request.links.length === 0 && request.message === undefined) {
          return { _tag: "none" } as const;
        }
        // Said to a conversation rather than to the form that created a target.
        const consequence =
          request.message === undefined
            ? " The target is created; author its scope by hand on the Assets screen."
            : "";

        /*
         * The agent, and whether a session can be opened as it at all — **here, where every
         * open passes**, before anything is resolved, minted or written.
         *
         * Its authority is what its credential grants, and this service mints exactly one
         * kind: `issue` below writes `IMPORT_SESSION_ROLE` and registers it at the importer
         * endpoint. An agent granted any other role would be opened with the importer's
         * tools, so it is refused rather than opened under a grant that is not its own —
         * whichever caller built the request (a new conversation, a reopen, a test).
         * Pinned from here: the row records it, the opener is its, and a reopen of this
         * conversation reads it back from the row rather than choosing again (`0002`).
         */
        const agent = request.agent ?? IMPORTER_AGENT;
        if (agent.authority.role !== IMPORT_SESSION_ROLE) {
          return {
            _tag: "refused",
            reason: "agent_unavailable",
            detail: `the agent '${agent.id}' is granted the '${agent.authority.role}' authority, and an import session's credential is only ever an importer's, so no session can be opened as it.${consequence}`,
          } as const;
        }

        /*
         * Bounded here rather than refused in the contract.
         *
         * One session reads every link (D15), so they share one context window, and a
         * ceiling is the honest form of that. Extra links are **dropped with a warning**
         * rather than the import refused: the operator who pasted nine pages wants the
         * first eight read far more than they want to be sent back to the form.
         */
        const links = request.links.slice(0, SCOPE_IMPORT_MAX_LINKS);
        const droppedLinks = request.links.length - links.length;
        if (droppedLinks > 0) {
          // Logged *and* reported. The log is for whoever is reading the server's output;
          // `droppedLinks` on the view is for the operator, who is the one who typed the
          // ninth link and is otherwise shown eight rows with no account of the other.
          yield* Effect.logWarning(
            "a scope import was given more links than one session can read; the extras are ignored",
            {
              targetId: request.targetId,
              given: request.links.length,
              reading: links.length,
            },
          );
        }

        // Every field of the pick by name, so the next one added to the contract does not
        // compile until it is read here (`ScopeImportRequest.choice`).
        const pick: ImportModelDraft = request.choice ?? {};
        const {
          instanceId: pickedInstanceId,
          model: pickedModel,
          modelOptions: pickedOptions,
          ...unread
        } = pick;
        everyFieldRead(unread);
        const choice = resolveImporterModel({
          listings: resolver.instances,
          ...(request.choice === undefined
            ? {}
            : { choice: { instanceId: pickedInstanceId, model: pickedModel } }),
        });
        if (choice === undefined) {
          return {
            _tag: "refused",
            reason: "no_harness",
            detail:
              request.message === undefined
                ? "no agent harness on this server is ready, so the program pages could not be read. The target is created; author its scope by hand on the Assets screen, or configure a harness and import it later."
                : "no agent harness on this server is ready, so there is no importer to talk to. Configure a harness, or author the scope by hand on the Assets screen.",
          } as const;
        }

        const resolved = yield* Effect.result(
          resolver.resolve(choice.instanceId),
        );
        if (resolved._tag === "Failure") {
          // The resolver's own sentence, never a substitution. An explicit pick of a dead
          // instance is refused rather than quietly swapped for a working one, for
          // `RunDraft.instanceId`'s reason: a quiet substitution would make the record of
          // which harness ran this a lie.
          return {
            _tag: "refused",
            reason: "harness_not_ready",
            detail: `${resolved.failure.detail}${consequence}`,
          } as const;
        }

        const harness = resolved.success.harness;
        /*
         * **A model the operator named is one its harness's catalogue lists** (U8 review 5),
         * the check a switch makes (`harness/modelSwitch.ts`, `model_unavailable`) and before
         * anything is minted or spawned. Without it an unknown model was accepted and opened
         * a real session — Claude Code does not check the name it is given, and OpenCode
         * answered 202 and then wrote "Model unavailable" into the transcript — so a refusal
         * the server could have given at once became a live session with nothing to run on.
         *
         * **Only a fresh pick.** A reopen (`predecessor`) opens on the model its row recorded,
         * unchecked as documented at `resolveImporterModel`: the conversation is the
         * operator's, and a model a catalogue has since dropped is the harness's to refuse in
         * its own words, not a reason to strand the conversation here. A model the rule
         * picked (none named) is the catalogue's own, so it needs no check either.
         */
        if (
          request.predecessor === undefined &&
          pickedModel !== undefined &&
          pickedModel !== "" &&
          !harness.instance.models.some((entry) => entry.id === choice.model)
        ) {
          return {
            _tag: "refused",
            reason: "model_unavailable",
            detail: `'${choice.model}' is not in the catalogue of ${harness.instance.displayName} (harness instance '${choice.instanceId}'), so no session was opened. Pick one of its models in the model picker.${consequence}`,
          } as const;
        }
        // Against the model this import resolved to, not the one the browser was showing:
        // the run path's resolver, so the two cannot disagree about what is forwarded.
        const options = yield* resolveSessionModelOptions(
          harness,
          choice.model,
          pickedOptions,
          "a scope import",
        );
        const importId = newImportId();
        const resume = request.resume;
        // A resume names the session it continues: minting a fresh id would start a second
        // conversation and leave the session index showing one as two (S3.3).
        const sessionId = request.resume?.sessionId ?? harness.newSessionId();
        /*
         * The pages this import may cite: the pasted links, then the earlier session's when
         * this continues one, then the pages the operator's message is about — each step
         * under the one shared cap (`widenPages`). Only the operator's text reaches this:
         * `operatorPages` takes a URL standing alone on a line, never one inside prose or a
         * pasted page, and refuses a URL carrying userinfo.
         */
        const carried = widenPages(links, request.earlierPages ?? []);
        const given =
          request.message === undefined
            ? { pages: carried.pages, added: [], notAdded: [] }
            : widenPages(carried.pages, operatorPages(request.message));
        /*
         * What the session is opened with *of* its model, recorded beside the model (`0028`)
         * so a reopen can open the successor the same way: the resolved list, the very value
         * `run` hands `createSession` as `options`, not the operator's unresolved pick. Absent
         * stays absent — `undefined`, so the row stores null rather than `[]` — because a
         * harness told nothing applies its own default, and one told the default has been
         * pinned to it.
         */
        const dispatchedOptions: readonly ModelOptionSelection[] | undefined =
          options;

        /*
         * The first turn, begun on the core: from this instant the import is "still
         * opening" (a message to it waits) and, for a reopen, the old id's successor — both
         * synchronous with the id existing. `before` writes the index entry and opens the
         * panel; the first turn is then forked into this layer's scope, so `start` answers
         * without it.
         */
        yield* conversations.begin({
          id: importId,
          targetId: request.targetId,
          predecessor: request.predecessor,
          opening,
          before: Effect.gen(function* () {
            /*
             * The index entry, written before the session exists: the harness holds every
             * session of every project and cannot be asked which were ours, so the index is
             * the only way an operator finds this one again. It is not listed until
             * `confirmImportSession` (`0025`), so an id the harness never minted cannot be
             * offered for a resume. **A failure to write it does not refuse the import.**
             */
            yield* withTargetStore(stores, request.targetId, (store) =>
              store.recordImportSession({
                importId,
                targetId: request.targetId,
                harnessSessionId: sessionId,
                harnessInstanceId: harness.instance.instanceId,
                model: choice.model,
                modelOptions: dispatchedOptions,
                pages: given.pages,
                agentId: agent.id,
              }),
            ).pipe(
              Effect.catch((failure) =>
                Effect.logWarning(
                  "a scope import's session could not be indexed; the import runs regardless, and the session will not appear in the target's list",
                  {
                    targetId: request.targetId,
                    importId,
                    sessionId,
                    detail: failure.message,
                  },
                ),
              ),
            );
            // Opened before the fiber starts, so the panel's first poll finds an import with
            // every link `waiting` rather than a `404` for the first moment of its life.
            yield* progress.open({
              importId,
              targetId: request.targetId,
              urls: given.pages,
              droppedLinks,
              harnessInstanceId: harness.instance.instanceId,
              model: choice.model,
            });
          }),
          plan: {
            targetId: request.targetId,
            harness,
            model: choice.model,
            ...(dispatchedOptions === undefined
              ? {}
              : { options: dispatchedOptions }),
            sessionId,
            // `importerTitle.ts` recognises this name when a harness hands it back.
            // V2(chat): V1 opens every session under this name, and OpenCode titles only a
            // session created without one, so an OpenCode importer session is never named
            // in D5's list — it is labelled by its date alone. The operator decided (U8,
            // 2026-11-05) to keep the harnesses' names for V1. V2 should author the title in
            // bit from the operator's first message and keep it on the import's row.
            title: importerSessionTitle(request.targetName),
            ...(resume === undefined ? {} : { resume: resume.sessionId }),
            /*
             * The session's directory, which on a resume is **not** this import's: both
             * drivers resolve a conversation through the directory it was created in
             * (`importerReopen` checked that the path is one of this target's own).
             * `ensureImportDirectory` recreates it if it was swept.
             */
            ensureDirectory: fleet.ensureImportDirectory(
              request.targetId,
              resume?.directoryImportId ?? importId,
            ),
            // The importer draws the question dock and answers it (A7-Q).
            operatorQuestions: true,
            // Reading the program's pages is its job: on Claude Code, `WebFetch` is
            // pre-approved for it, whatever the operator's settings allow otherwise.
            fetchesPages: true,
            workspace: request.workspacePath ?? undefined,
            /*
             * The session now exists, and the index is told so (`0025`). Advisory like the
             * row itself: a failure is logged and the session is merely not listed.
             */
            afterCreate: () =>
              withTargetStore(stores, request.targetId, (store) =>
                store.confirmImportSession(importId),
              ).pipe(
                Effect.catch((failure) =>
                  Effect.logWarning(
                    "a scope import's session was created but could not be marked as such; the session will not appear in the target's list",
                    {
                      targetId: request.targetId,
                      importId,
                      sessionId,
                      detail: failure.message,
                    },
                  ),
                ),
              ),
            /*
             * The agent's own prompts, and only through it. A resume continues a
             * conversation: the short reconnection note rather than the whole opener,
             * because the rules and the pages are already in the session's own history.
             */
            openingPrompt: () =>
              resume !== undefined && request.message !== undefined
                ? agent.prompt.resume({ message: request.message })
                : agent.prompt.opening({
                    targetName: request.targetName,
                    links,
                    message: request.message,
                    earlierPages: carried.added,
                  }),
            // Pinned to the entry, so every later message is framed by the agent that
            // opened it.
            meta: { agent },
            ...(request.uploads === undefined
              ? {}
              : { uploads: request.uploads }),
          },
          failed: (detail) =>
            Effect.andThen(
              progress.settle({ importId, status: "failed", detail }),
              Effect.logWarning("a scope import could not be opened", {
                targetId: request.targetId,
                importId,
                detail,
              }),
            ),
        });

        yield* Effect.logInfo("a scope import started", {
          targetId: request.targetId,
          importId,
          links: links.length,
          instanceId: harness.instance.instanceId,
          model: choice.model,
          origin: choice.origin,
        });

        return {
          _tag: "started",
          importId,
          harnessInstanceId: harness.instance.instanceId,
          model: choice.model,
          pagesAdded: given.added,
          pagesNotAdded: given.notAdded,
          pagesCarried: carried.added,
        } as const;
      });

      const stop: ScopeImporter["Service"]["stop"] = Effect.fn(
        "ScopeImporter.stop",
      )(function* (importId) {
        /*
         * The view first, the session second, and the order is the point: marking it
         * stopped settles the view and revokes nothing, so the route can answer at once
         * with the receipt for what landed. Then the core ends the period — the credential
         * before the interrupt, the operator's end recorded before anything is interrupted,
         * and the close. Everything written before this stays.
         */
        const view = yield* progress.stop(
          importId,
          "stopped by the operator. Everything written up to this point is kept.",
        );
        if (view === undefined) return undefined;
        yield* conversations.end(view.targetId, importId);
        return view;
      });

      const start: ScopeImporter["Service"]["start"] = (request) =>
        startWith(request);

      /**
       * Starts an import with the operator's message as its first turn, and waits for the
       * open to be known.
       */
      const openWith = Effect.fnUntraced(function* (
        request: ScopeImportRequest,
      ) {
        const opening: Opening = yield* Deferred.make<
          LiveAgentSession<ImportSessionMeta>,
          ImporterConversationRefused
        >();
        const started = yield* startWith(request, opening);
        if (started._tag === "none") {
          // Unreachable: a request with a message is never `none`.
          return yield* new ImporterConversationRefused({
            reason: "store_unavailable",
            detail: "there was nothing to say to the importer",
          });
        }
        if (started._tag === "refused") {
          return yield* new ImporterConversationRefused({
            reason: started.reason,
            detail: started.detail,
          });
        }
        return { entry: yield* Deferred.await(opening), started };
      });

      const converse: ScopeImporter["Service"]["converse"] = Effect.fn(
        "ScopeImporter.converse",
      )(function* (input) {
        const { entry, started } = yield* openWith({
          targetId: input.targetId,
          targetName: input.targetName,
          workspacePath: input.workspacePath,
          links: [],
          message: input.text,
          ...(input.uploads === undefined ? {} : { uploads: input.uploads }),
          ...(input.choice === undefined ? {} : { choice: input.choice }),
          // Passed on rather than dropped: an agent asked for and not honoured would be a
          // substitution, and `startWith` is where its authority is checked.
          ...(input.agent === undefined ? {} : { agent: input.agent }),
        });
        return turnAccepted(
          conversations.acceptedOf(
            entry,
            "opened",
            "A new importer session was opened for this message: the importer has its rules, the three tools that let it write, and whatever its harness gives it for reading a page — all inside its own directory. It has read nothing else yet.",
          ),
          { added: started.pagesAdded, notAdded: started.pagesNotAdded },
        );
      });

      /**
       * A message to an import this process does not hold and the operator did not end —
       * closed after a refused prompt, shut down, never opened, or lost to a restart — opens
       * its successor under a **new** import id (the core's `send`, under the old id's
       * reopen permit, with the row read inside it).
       */
      const reopen: (
        input: ConversationSend,
        row: ImportRow,
      ) => Effect.Effect<
        ImporterTurnAccepted,
        ImporterConversationRefused | ScopeImportNotFound
      > = Effect.fnUntraced(function* (
        input: ConversationSend,
        row: ImportRow,
      ) {
        const target = yield* fleet
          .target(input.targetId)
          .pipe(Effect.mapError(refusal));
        if (target === undefined) {
          return yield* new ImporterConversationRefused({
            reason: "target_unavailable",
            detail: `no target '${input.targetId}' is registered on this server`,
          });
        }
        /*
         * The agent the conversation runs as, from the row: pinned when its first message
         * was sent, so the successor — resumed or fresh — runs as the same one. Refused
         * rather than defaulted when this server does not define it.
         */
        const agent = importSessionAgent(row.agentId);
        if (agent === undefined) {
          return yield* new ImporterConversationRefused({
            reason: "agent_unavailable",
            // The replay's sentence for the same row (`importerHistory.ts`).
            detail: agentUnavailableDetail(input.conversationId, row.agentId),
          });
        }
        /*
         * The earlier session's pages, carried forward: they were the operator's, and this
         * is the same conversation. From memory when this process still holds the old
         * import's list (a refused prompt), and from the row (`0029`) when it does not.
         */
        const earlierPages = widenPages(
          (yield* progress.linksOf(input.conversationId)) ?? [],
          row.pages ?? [],
        ).pages;
        /*
         * Resume the conversation, or open a new one, according to what the harness
         * actually still holds (S6): the same function the replay route answers
         * `continuation` with, so what the composer was told and what happens here cannot
         * disagree. It never fails.
         */
        const decided = yield* importerReopenFor({
          resolver,
          targetId: input.targetId,
          harnessSessionId: row.harnessSessionId,
          harnessInstanceId: row.harnessInstanceId,
          importDirectory: fleet.paths.importDirectory,
        });
        const { entry, started } = yield* openWith({
          targetId: input.targetId,
          targetName: target.name,
          workspacePath: target.workspacePath ?? null,
          links: [],
          message: input.text,
          ...(input.uploads === undefined ? {} : { uploads: input.uploads }),
          earlierPages,
          predecessor: input.conversationId,
          agent,
          ...(decided._tag === "resume"
            ? {
                resume: {
                  sessionId: decided.sessionId,
                  directoryImportId: decided.directoryImportId,
                },
              }
            : {}),
          // The same harness the earlier session ran on, and the model it is on now — the
          // last switch's, or the one it opened with — and the same setting of it (`0028`).
          //
          // V2(chat): the row holds only the session's *current* model and options, so a
          // reload knows the model a session ended on and nothing about the turns before.
          // Proper V2: an append-only switch log keyed by session, plus cross-harness
          // handoff that carries the graph, the agent and a summary into a new session.
          ...(row.harnessInstanceId === null
            ? {}
            : {
                choice: {
                  instanceId: row.harnessInstanceId,
                  model: row.model,
                  ...(row.modelOptions === null
                    ? {}
                    : { modelOptions: row.modelOptions }),
                },
              }),
        });
        const carried = started.pagesCarried.length;
        const pages =
          carried === 0
            ? ""
            : `, and the ${carried === 1 ? "page" : `${String(carried)} pages`} you gave it ${carried === 1 ? "is" : "are"} carried forward`;
        return turnAccepted(
          conversations.acceptedOf(
            entry,
            decided._tag === "resume" ? "resumed" : "opened",
            decided._tag === "resume"
              ? // One conversation, a second authority period: the same session id, a new
                // import id, because an import id names one authority period (`0027`).
                `Import ${input.conversationId}'s authority is not held by this server — ${notHeldBecause(row.endedReason)} — so this message took the conversation back over under import ${entry.id}. The session itself is the same one: ${decided.detail}, and the importer in it has its own history${pages}.`
              : `Import ${input.conversationId}'s session is not held by this server — ${notHeldBecause(row.endedReason)} — and could not be carried on: ${decided.detail}. So this message opened a new session, under import ${entry.id}. The importer in it has not read the earlier session; what that session wrote is on the Scope tab and in the Estate${pages}.`,
          ),
          { added: started.pagesAdded, notAdded: started.pagesNotAdded },
        );
      });

      /**
       * The replay: the harness's transcript (`importerConversation`), with what the core
       * holds beside it — the messages not yet written, and the question waiting now.
       */
      const replay: ScopeImporter["Service"]["replay"] = Effect.fn(
        "ScopeImporter.replay",
      )(function* (input) {
        const { view, queued, question } = yield* conversations.replay({
          id: input.importId,
          fromTranscript: (read: ImporterConversationView) => read.question,
          read: (held, onTranscript) =>
            importerConversation({
              resolver,
              targetId: input.targetId,
              importId: input.importId,
              recorded: input.recorded,
              liveSessionId: held?.sessionId,
              liveDirectory: held?.directory,
              importDirectory: fleet.paths.importDirectory,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.fetchTimeout === undefined
                ? {}
                : { fetchTimeout: input.fetchTimeout }),
              onTranscript,
            }),
        });
        return { ...view, queued: [...queued], question };
      });

      /** The import addressed, as the core's period. */
      const period = (input: {
        readonly targetId: string;
        readonly importId: string;
      }) => ({ targetId: input.targetId, conversationId: input.importId });

      return ScopeImporter.of({
        start,
        stop,
        view: progress.view,
        converse,
        send: (input) =>
          conversations.send({
            targetId: input.targetId,
            conversationId: input.importId,
            text: input.text,
            urgency: input.urgency,
            uploads: input.uploads,
          }),
        replay,
        switchModel: (input) =>
          conversations.switchModel({
            ...period(input),
            model: input.model,
            ...(input.modelOptions === undefined
              ? {}
              : { modelOptions: input.modelOptions }),
          }),
        stopTurn: (input) => conversations.stopTurn(period(input)),
        stopSubagent: (input) =>
          conversations.stopSubagent({
            ...period(input),
            callId: input.callId,
          }),
        stopAll: (input) => conversations.stopAll(period(input)),
        answerQuestion: (input) =>
          conversations.answerQuestion({
            ...period(input),
            questionId: input.questionId,
            answers: input.answers,
          }),
        dismissQuestion: (input) =>
          conversations.dismissQuestion({
            ...period(input),
            questionId: input.questionId,
          }),
        activity: (input) => conversations.activity(period(input)),
        context: (input) =>
          conversations.context({
            ...period(input),
            breakdown: input.breakdown,
          }),
        holds: conversations.holds,
        heldSteers: conversations.heldSteers,
      });
    }),
  );

  /**
   * An importer for a server with no harness.
   *
   * `start` refuses with links and answers `none` without them, which is the same shape the
   * real one produces — so `createTarget` has one code path and a server configured with
   * `HARNESS=0` still creates targets. It does not pretend an import happened.
   *
   * **`replay` still answers**, with `resolver: undefined`, which is why the reader takes the
   * resolver as a parameter: "this server has no agent harness configured" is a different
   * sentence from "the harness would not answer", and an import whose session was never
   * created still reads as `absent` rather than as a conversation something has forgotten.
   * Those are different facts and a build with no harness has no reason to confuse them.
   */
  static readonly unavailable: Layer.Layer<ScopeImporter> = Layer.succeed(
    ScopeImporter,
    ScopeImporter.of({
      start: (input) =>
        Effect.succeed(
          input.links.length === 0
            ? { _tag: "none" }
            : {
                _tag: "refused",
                reason: "no_harness",
                detail:
                  "this server is configured with no agent harness, so program pages cannot be read. The target is created; author its scope by hand on the Assets screen.",
              },
        ),
      stop: () => Effect.succeed(undefined),
      view: () => Effect.succeed(undefined),
      holds: () => Effect.succeed(false),
      heldSteers: () => Effect.succeed(0),
      converse: () => Effect.fail(noHarness),
      send: () => Effect.fail(noHarness),
      activity: (input) =>
        Effect.succeed({
          conversationId: input.importId,
          turn: "not_live",
          background: false,
        }),
      // No harness, so nothing to ask: the reading claims nothing.
      context: (input) =>
        Effect.map(Clock.currentTimeMillis, (measuredAt) => ({
          conversationId: input.importId,
          model: "",
          used: null,
          usedModel: null,
          window: null,
          reading: "unread" as const,
          breakdown: { _tag: "none" as const, reason: "unanswered" as const },
          measuredAt,
        })),
      // No harness, so no question anything could be waiting on.
      answerQuestion: (input) =>
        Effect.fail(
          new QuestionRefused({
            questionId: input.questionId,
            reason: "settled",
            detail:
              "this server is configured with no agent harness, so no agent is waiting on a question.",
          }),
        ),
      dismissQuestion: (input) =>
        Effect.fail(
          new QuestionRefused({
            questionId: input.questionId,
            reason: "settled",
            detail:
              "this server is configured with no agent harness, so no agent is waiting on a question.",
          }),
        ),
      // No harness, so no session this server could hold: nothing of any import runs here.
      stopTurn: (input) =>
        Effect.succeed(
          turnStopped({
            found: { _tag: "not_live" },
            conversationId: input.importId,
            what: "this session",
          }),
        ),
      stopAll: (input) =>
        Effect.succeed(
          turnStopped({
            found: { _tag: "not_live" },
            conversationId: input.importId,
            what: "this session",
          }),
        ),
      stopSubagent: () =>
        Effect.fail(
          new SubagentStopRefused({
            reason: "not_live",
            detail:
              "this server is configured with no agent harness, so no sub-agent runs here.",
          }),
        ),
      switchModel: () =>
        Effect.fail(
          new ConversationModelRefused({
            reason: "harness_not_ready",
            detail:
              "this server is configured with no agent harness, so no importer session's model can be switched.",
          }),
        ),
      replay: (input) =>
        importerConversation({
          resolver: undefined,
          targetId: input.targetId,
          importId: input.importId,
          recorded: input.recorded,
          liveSessionId: undefined,
          // Never called: with no resolver the reader asks no harness anything, so no
          // directory is ever rebuilt. Passed because the parameter is not optional, and a
          // function that threw would be worse than one that answers.
          importDirectory: (targetId, importId) =>
            `${targetId}/import/${importId}`,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.fetchTimeout === undefined
            ? {}
            : { fetchTimeout: input.fetchTimeout }),
        }),
    }),
  );
}

/** What a server with no harness answers every message with. */
const noHarness = new ImporterConversationRefused({
  reason: "no_harness",
  detail:
    "this server is configured with no agent harness, so there is no importer to talk to. Author the scope by hand on the Assets screen.",
});
