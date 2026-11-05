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
 * at all: no ready harness, a session that would not open, a policy gate that would not
 * install, an MCP registration the harness refused. Those are the operator's to fix and
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
  SCOPE_IMPORT_MAX_LINKS,
  ScopeImportNotFound,
  type ConversationModelDraft,
  type ConversationModelSwitched,
  type ConversationActivity,
  type ConversationContext,
  type ConversationStopped,
  type ImporterConversationView,
  type ImporterQueuedMessage,
  type ImporterTurnAccepted,
  type ImportModelDraft,
  type ModelOptionSelection,
  type ScopeImportView,
  type SteerUrgency,
} from "@bit/contracts";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Semaphore,
  type Duration,
} from "effect";

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
  lastAssistantText,
  truncateNarration,
  type AgentHarness,
} from "../harness/agentHarness";
import {
  makeLiveAgentSessions,
  type LiveAgentSession,
  type LiveSessionCloseReason,
  type LiveSessionOpenFailure,
} from "../harness/liveAgentSessions";
import { resolveSessionModelOptions } from "../harness/modelOptions";
import {
  checkModelSwitch,
  type CheckedModelSwitch,
  modelSwitched,
  modelSwitchRefusal,
  recordRefusal,
  sameModelChoice,
} from "../harness/modelSwitch";
import { HarnessResolver } from "../harness/resolver";
import { turnStopped, turnStopRefusal } from "../harness/turnStop";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { newImportId } from "../persistence/identifier";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { PolicyDecisions } from "../policy/service";
import { RunNarrations } from "../run/narration";
import { narrateCoalesced } from "../run/streamingCoalescer";
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
       * No harness at all, the chosen one cannot take a session, or the agent asked for is
       * granted an authority this service does not mint (see `startWith`).
       */
      readonly reason: "no_harness" | "harness_not_ready" | "agent_unavailable";
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
type Opening = Deferred.Deferred<
  LiveAgentSession<ImportSessionMeta>,
  ImporterConversationRefused
>;

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
    case "PolicyHookNotInstalled":
      return new ImporterConversationRefused({
        reason: "import_ungated",
        detail:
          failure.message ??
          "the pre-execution policy gate could not be installed into this import's directory, so no session was opened",
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

/** A join attempt that found nothing to join. Never leaves this module. */
const NOT_LIVE = { _tag: "NotLive" } as const;

export interface ScopeImportRequest {
  readonly targetId: string;
  readonly targetName: string;
  /** The engagement folder, for the gate's containment check. `null` when there is none. */
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
   * session's directory once the spine has gated it, before the opening prompt.
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
   * rather continued — in that directory, so the gate is installed there, which is the only
   * place it can be: the hook lives in the directory the agent runs commands in.
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
    | PolicyDecisions
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

      /**
       * Every import session this process holds, on the shared spine
       * (`harness/liveAgentSessions.ts`), keyed by import id.
       *
       * **This is the line that makes a session outlive its first turn.** The import used to
       * own its scope inside the fiber that ran it and close it on the fiber's exit, so the
       * credential and the registration went the moment `waitForIdle` returned — there was
       * nothing to send a second message to. The scope now lives here, and only the three
       * things this module's header lists close it.
       *
       * The importer's half of the descriptor: the importer endpoint, an importer
       * credential with no clock, `revokeImport` as the belt-and-braces check, and `ended_at`
       * with its reason recorded once the session is closed.
       */
      const sessions = yield* makeLiveAgentSessions<ImportSessionMeta>(
        { fleet, endpoints, gate: yield* PolicyDecisions },
        {
          // The **importer** endpoint. The path selects the toolkit and the grant decides
          // whether the request is served at all: an importer credential at the worker URL
          // is a `401` before any tool list is produced, and a worker's credential here is
          // the same — which is what makes "three tools, and nowhere else" a property of
          // the registration rather than of a filter.
          endpoint: (urls) => urls.importerMcp,
          // No clock, as a goal's has none (S2.3). A fourth caller kind is still what
          // makes this session's three tools unreachable from a worker, a planner or a goal
          // agent: each endpoint refuses a grant whose tag is not the role it serves. What
          // stands behind the missing clock is an `operator` end (`0026`, `0027`), which the
          // toolkit reads before every write.
          issue: (input) =>
            credentials.issueWithoutExpiry({
              _tag: IMPORT_SESSION_ROLE,
              targetId: input.targetId,
              importId: input.id,
            }),
          revokeStray: credentials.revokeImport,
          afterClose: (entry, reason) =>
            Effect.andThen(
              // What the session held queued went with it, and is not this process's to
              // replay (`steers`). Not on the narrator's exit: a narration stream can end
              // while the session lives on.
              Effect.sync(() => {
                steers.delete(entry.id);
                deliveries.delete(entry.id);
              }),
              markEnded(entry.targetId, entry.id, reason),
            ),
          words: {
            unregisterRefused:
              "a harness would not take back the scope importer's MCP registration; the credential behind it is revoked either way",
            strayCredential:
              "a scope importer's credential outlived its session's scope and had to be revoked explicitly; the scope that acquired it should have done that",
            closed: "a scope import's session was closed",
            idKey: "importId",
          },
        },
      );

      /**
       * The first turn of each import still running, so a stop can reach the fiber a route
       * does not hold. Separate from {@link sessions}: the turn ends when the session goes
       * idle, and the session does not.
       */
      const turns = new Map<string, Fiber.Fiber<void>>();

      /**
       * The operator's messages each live import's harness transcript does not hold yet, by
       * import id and then by message id (A6 U4 review, review 2), and the message ids the
       * harness has said it took.
       *
       * **Why this process keeps them at all**, when it keeps no other word of a
       * conversation (DECISIONS.md §8): a steer delivered while a turn runs is queued in the
       * harness, and neither harness's transcript holds it until it is taken — so a reload in
       * that window lost the message, and the reply to it then read as part of the turn
       * before. {@link replay} carries these beside the transcript, and a reloaded tab draws
       * them.
       *
       * **A take does not remove one** (review 2). Claude Code narrates the take 30–130 ms
       * before its transcript holds the message, so a replay read in that gap — which is when
       * a tab that saw the take of a message it had no row for reads it — found it in neither
       * half. A take only marks the message `taken`; {@link replay} leaves out whatever its
       * transcript holds, by id. Removed when a replay finds it **written** (review 3:
       * anywhere in the transcript, so a copy older than the replay's window or later
       * compacted away is not put back at the end), when the turn settles idle (everything
       * delivered before its wait began is in the transcript by then), and with the session
       * when it closes (`afterClose`). Never on a take alone, nor by a replay that has not
       * found it written: two tabs reading at once on the same take would otherwise race,
       * one read taking the message off while the other's transcript was read before it was
       * written.
       *
       * `taken` is there for the race the other way round: the harness can take a steer
       * before `deliver` has returned to say it was delivered, and a take seen first must
       * still mark the message taken when it is added — with the messages taken with it,
       * when the harness took several as one (review 3). Memory only, bounded by the messages
       * an operator sends to a session this process holds.
       *
       * V2(chat): queued steers live in memory only; a server restart loses a steer that was
       * still queued (and the harness session that held it), and nothing tells the operator
       * it was never read. Proper V2: persist queued messages with the app-owned queue.
       */
      const steers = new Map<
        string,
        {
          readonly queued: Map<string, ImporterQueuedMessage>;
          /** Each message taken, to the messages taken with it when there were several. */
          readonly taken: Map<string, readonly string[] | undefined>;
        }
      >();
      const steersOf = (importId: string) => {
        const held = steers.get(importId);
        if (held !== undefined) return held;
        const fresh = {
          queued: new Map<string, ImporterQueuedMessage>(),
          taken: new Map<string, readonly string[] | undefined>(),
        };
        steers.set(importId, fresh);
        return fresh;
      };
      /** A held message, marked taken — with the messages taken with it, if any. */
      const tookIt = (
        message: ImporterQueuedMessage,
        together: readonly string[] | undefined,
      ): ImporterQueuedMessage => ({
        messageId: message.messageId,
        text: message.text,
        acceptedAt: message.acceptedAt,
        taken: true,
        ...(together === undefined ? {} : { takenTogether: [...together] }),
      });
      /**
       * How many messages have been accepted into each import's live session, ever (A6 U4
       * review 3): what lets {@link settleTurn} tell that a message arrived while it was
       * finishing — after the session's idle point, during the closing report's read —
       * which `turns` alone cannot, since the settling fiber is still in it then. Counted in
       * {@link deliverTurn} **before** it asks whether the import is working again.
       */
      const deliveries = new Map<string, number>();
      const deliveriesTo = (importId: string): number =>
        deliveries.get(importId) ?? 0;
      /**
       * Takes an import's fiber out of {@link turns}, only if it is the calling fiber's own:
       * a fiber that has finished settling may already have been followed by a fresh one
       * for the next message, which must stay findable by `stop`.
       */
      const releaseTurn = (importId: string) =>
        Effect.withFiber((fiber) =>
          Effect.sync(() => {
            if (turns.get(importId) === fiber) turns.delete(importId);
          }),
        );

      /**
       * Every import whose first turn has not yet learned how its open went, by import id.
       *
       * **What makes "still opening" visible before the spine publishes anything.** The
       * spine puts an entry in its map only once the credential and the MCP registration
       * exist, but the index row is written — and confirmed, so the picker lists it — before
       * either. A message to the import in that window found no entry, read a row that was
       * neither live nor ended, and took the reopen path: a second session under a new id,
       * answered with a note claiming the server had restarted. A message now waits on this
       * instead, and then asks again, by which time the open is known either way.
       *
       * Set the instant the id is minted and released by the first of: the open being known
       * (`run`), the turn ending, or `startWith` failing before it forked the turn. Releasing
       * twice is a no-op.
       */
      const inFlight = new Map<
        string,
        { readonly targetId: string; readonly known: Deferred.Deferred<void> }
      >();
      const releaseOpening = (importId: string) =>
        Effect.suspend(() => {
          const held = inFlight.get(importId);
          if (held === undefined) return Effect.void;
          inFlight.delete(importId);
          return Deferred.succeed(held.known, undefined);
        });

      /**
       * Which import took over from one whose session this process no longer held.
       *
       * Written **the moment the successor's id is minted** (`startWith`), not once its
       * session has opened: a message whose request is dropped while the fresh session opens
       * would otherwise skip the write — the session itself is forked into this layer's scope
       * and opens regardless — and the next message to the old id would open a third. A
       * message that follows the link to a successor still opening waits on {@link inFlight}.
       * Taken back if that open fails, so the next message reopens from the id the operator
       * knows. Bounded by the number of reopenings an operator causes, and not swept, for
       * `liveAgentSessions.ts`'s `opening` map's reason.
       */
      const successors = new Map<string, string>();

      /**
       * Publishes one import session's narration under its import, for as long as the
       * session lives.
       *
       * `plan/goalConversation.ts`'s `narrate`, with the subject changed and nothing else: an
       * importer conversation has no terminal outcome to read off the stream either, because
       * it does not settle — a turn settles, and that is read from `waitForIdle`, not from
       * here. The spine forks this into the session's own scope and interrupts it **first**
       * on every close (`harness/liveAgentSessions.ts`, `closeSession`), so it needs no
       * lifecycle of its own: the operator's stop, a refused prompt, a failed open and the
       * layer's finalizer all end it, before the credential goes.
       *
       * **A stream that ends does not end the conversation.** It is logged and nothing more:
       * the stream breaking says nothing about the session, and the next message still
       * reaches it through `deliverTurn`, which does not look at this fiber at all. What is
       * lost is what the chat would have shown until a reload replays from the harness.
       *
       * **Publishing is not persisting.** With nobody on the Auto-load page — which is
       * always the case for an import started from the create-target form — every entry is
       * published to no subscriber and kept nowhere (`run/narration.ts`'s header). That path's
       * closing report is still read from `messages` after `waitForIdle`; see
       * {@link settleTurn}.
       */
      const narrate = Effect.fnUntraced(function* (input: {
        readonly harness: AgentHarness["Service"];
        readonly targetId: string;
        readonly importId: string;
        readonly sessionId: string;
      }) {
        // Block deltas coalesced into partial updates for the live chat, and published
        // nowhere else (`run/streamingCoalescer.ts`).
        const outcome = yield* Effect.result(
          narrateCoalesced({
            events: input.harness.sessionEvents(input.sessionId),
            publish: (entry) => {
              // The harness took queued messages: they are being worked on, and stay this
              // process's to replay until the transcript holds them (`steers`). Several
              // taken as one are one turn, and are held saying so (A6 U4 review 3).
              if (entry.detail._tag === "taken") {
                const held = steersOf(input.importId);
                const ids = entry.detail.messageIds;
                const together = ids.length > 1 ? [...ids] : undefined;
                for (const id of ids) {
                  held.taken.set(id, together);
                  const message = held.queued.get(id);
                  if (message !== undefined) {
                    held.queued.set(id, tookIt(message, together));
                  }
                }
              }
              return narrations.publish({
                targetId: input.targetId,
                subject: { _tag: "import", importId: input.importId },
                harnessSessionId: input.sessionId,
                entry,
              });
            },
          }),
        );
        if (outcome._tag === "Failure") {
          yield* Effect.logWarning(
            "a scope import's narration stream ended; this says nothing about the session, and the next message still reaches it",
            {
              importId: input.importId,
              sessionId: input.sessionId,
              detail: outcome.failure.message,
            },
          );
        }
      });

      /**
       * The first turn of one import: open the session, let it work, settle the view.
       *
       * The acquire order is the spine's, and each step rules out the next step's
       * ambiguity: the gated directory before the session, so a session is never created
       * in a directory nothing is auditing; the credential before the registration, so
       * there is something to register; the registration before the prompt, so turn one has
       * the tools. A failure at any step closes the scope, which revokes the credential and
       * unregisters the server — including the case where the *next* step is the thing that
       * failed.
       *
       * **When this returns the session is still open**, which is the only observable
       * difference from before: the entries, the settle and the closing report are exactly
       * what they were.
       */
      const run = Effect.fnUntraced(function* (input: {
        readonly importId: string;
        readonly request: ScopeImportRequest;
        /** The agent the session runs as, as `startWith` recorded it on the row. */
        readonly agent: AgentDefinition<ImporterPromptInput>;
        readonly harness: AgentHarness["Service"];
        readonly model: string;
        readonly options: readonly ModelOptionSelection[] | undefined;
        readonly links: readonly string[];
        readonly sessionId: string;
        /** The operator's first message, for a conversation. See `ScopeImportRequest`. */
        readonly message: string | undefined;
        /** Completed once the open is known, for a caller that waits on it (`converse`). */
        readonly opening: Opening | undefined;
        /** The import this one takes over from, if any. See `ScopeImportRequest`. */
        readonly predecessor: string | undefined;
        /** The earlier session's pages, for the opener. See `ScopeImportRequest`. */
        readonly earlierPages: readonly string[];
      }) {
        /*
         * A resume continues a conversation; everything else about this function is the same.
         *
         * Two things change and they are both in `prepare`: the directory is the one the
         * harness resolves the session in (so the gate goes where the agent runs), and the
         * opening prompt is the short reconnection note rather than the whole opener, because
         * the rules and the pages are already in the session's own history.
         */
        const resume = input.request.resume;
        const harness = input.harness;
        const opened = yield* Effect.result(
          sessions.open<
            LiveAgentSession<ImportSessionMeta> | undefined,
            LiveSessionOpenFailure,
            never
          >({
            id: input.importId,
            // Unreachable: every `start` mints a fresh import id, so nothing can have
            // opened this one first. Answered rather than died on, and without touching a
            // session this run did not open.
            joined: () => Effect.succeed(undefined),
            refuse: (failure) => failure,
            prepare: Effect.succeed({
              targetId: input.request.targetId,
              harness,
              model: input.model,
              ...(input.options === undefined
                ? {}
                : { options: input.options }),
              sessionId: input.sessionId,
              // `importerTitle.ts` recognises this name when a harness hands it back.
              // V2(chat): V1 opens every session under this name, and OpenCode titles only a
              // session created without one, so an OpenCode importer session is never named
              // in D5's list — it is labelled by its date alone (seen live in U8 on
              // zai-coding-plan/glm-5.3-flash, after three turns). V2 should open OpenCode
              // sessions with no title, so OpenCode names them from the first turn, once
              // nothing else is found to rely on this name.
              title: importerSessionTitle(input.request.targetName),
              ...(resume === undefined ? {} : { resume: resume.sessionId }),
              /*
               * The session's directory, which on a resume is **not** this import's.
               *
               * Both drivers resolve a conversation through the directory it was created in,
               * and the gate lives in that directory — so a resumed session is gated and run
               * where the harness will actually resolve it (`importerReopen` checked that the
               * path is one of this target's own). `ensureImportDirectory` recreates it if it
               * was swept, which is also the answer to OpenCode's `LocationNotFoundError`.
               */
              ensureDirectory: fleet.ensureImportDirectory(
                input.request.targetId,
                resume?.directoryImportId ?? input.importId,
              ),
              // The engagement folder, so the containment check can refuse an import
              // directory inside it. `undefined` says this target has none.
              workspace: input.request.workspacePath ?? undefined,
              /*
               * The session now exists, and the index is told so. Until this lands the row
               * `start` wrote names an id the harness may never have minted, and the session
               * list does not show it (`0025`). Advisory like the row itself: a failure is
               * logged with the id and the import carries on, and the session is merely not
               * listed.
               */
              afterCreate: () =>
                withTargetStore(stores, input.request.targetId, (store) =>
                  store.confirmImportSession(input.importId),
                ).pipe(
                  Effect.catch((failure) =>
                    Effect.logWarning(
                      "a scope import's session was created but could not be marked as such; the session will not appear in the target's list",
                      {
                        targetId: input.request.targetId,
                        importId: input.importId,
                        sessionId: input.sessionId,
                        detail: failure.message,
                      },
                    ),
                  ),
                ),
              // The narrator, forked by the spine into this session's scope. D16 as
              // amended: the panel keeps its call list, and the chat shows this.
              narrate: (sessionId: string) =>
                narrate({
                  harness,
                  targetId: input.request.targetId,
                  importId: input.importId,
                  sessionId,
                }),
              // The agent's own prompts, and only through it: the agent is what decides what a
              // conversation is told, and this is the one place an opener is written.
              openingPrompt: () =>
                resume !== undefined && input.message !== undefined
                  ? input.agent.prompt.resume({ message: input.message })
                  : input.agent.prompt.opening({
                      targetName: input.request.targetName,
                      links: input.links,
                      message: input.message,
                      earlierPages: input.earlierPages,
                    }),
              // Pinned to the entry, so every later message into this session is framed by
              // the agent that opened it (`deliverTurn`).
              meta: { agent: input.agent },
              // The first message's files, stored by the spine in the gated directory.
              ...(input.request.uploads === undefined
                ? {}
                : { uploads: input.request.uploads }),
            }),
            opened: (entry) => Effect.succeed(entry),
          }),
        );

        // A successor that could not open is not one: the next message to the import it was
        // to replace reopens from there, under the id the operator knows.
        if (
          (opened._tag === "Failure" || opened.success === undefined) &&
          input.predecessor !== undefined &&
          successors.get(input.predecessor) === input.importId
        ) {
          successors.delete(input.predecessor);
        }
        // The open is known: a message that arrived while it was in flight may now ask again.
        yield* releaseOpening(input.importId);
        if (input.opening !== undefined) {
          yield* opened._tag === "Failure"
            ? Deferred.fail(input.opening, refusal(opened.failure))
            : opened.success === undefined
              ? Deferred.fail(
                  input.opening,
                  new ImporterConversationRefused({
                    reason: "store_unavailable",
                    detail:
                      "this import already had a session open in this process, so a second was not opened",
                  }),
                )
              : Deferred.succeed(input.opening, opened.success);
        }
        if (opened._tag === "Failure" || opened.success === undefined) {
          const detail =
            opened._tag === "Failure"
              ? opened.failure.message
              : "this import already has a session open in this process, so a second was not opened";
          yield* progress.settle({
            importId: input.importId,
            status: "failed",
            detail,
          });
          yield* Effect.logWarning("a scope import could not be opened", {
            targetId: input.request.targetId,
            importId: input.importId,
            detail,
          });
          // Whatever was built is gone — the spine closed it — so the import is over. A
          // session the harness created and then could not be given tools is a session
          // this process will never prompt again.
          // `open_failed` unless the spine already recorded `refused` for a prompt the
          // harness would not take: the first end wins.
          if (opened._tag === "Failure") {
            yield* markEnded(
              input.request.targetId,
              input.importId,
              "open_failed",
            );
          }
          return;
        }
        yield* settleTurn(input.importId, harness, opened.success.sessionId);
      });

      /**
       * Waits for one turn of an import's session to go idle, then settles its view.
       *
       * The first turn's tail, and a later turn's whole fiber: a message delivered into a
       * session marks the import `running` again (`progress.resume`) and this is what settles
       * it once the session has finished with it.
       *
       * **A loop, until no message arrived since its wait began** (A6 U4 review 3). A message
       * delivered while this fiber is finishing — after the idle point, during the closing
       * report's read — finds it still in `turns` and starts no fiber of its own; this one
       * used to settle over it, leaving the import `finished` while the message's turn ran
       * and the message held in `steers` until the session closed. Now it waits again for any
       * message delivered since its wait began ({@link deliveries}), and takes itself out of
       * `turns` in the same synchronous step as its last check, so a message delivered after
       * that check starts a fiber of its own.
       */
      const settleTurn = Effect.fnUntraced(function* (
        importId: string,
        harness: AgentHarness["Service"],
        sessionId: string,
      ) {
        for (;;) {
          // Where this wait starts: the messages delivered so far, and when.
          const mark = { delivered: deliveriesTo(importId), at: Date.now() };
          /** Whether a message was delivered since this wait began. */
          const more = () => deliveriesTo(importId) !== mark.delivered;
          /*
           * Wait for the session to go idle, then settle.
           *
           * `waitForIdle` rather than a poll, and nothing is read out of the result: what
           * the import *did* is already in `scope_entries`, in `asset_imports` and on the
           * panel, written call by call as it went. The only thing this adds is "it is no
           * longer going to write anything", which is what turns the last link's `reading`
           * into `read`.
           *
           * A failure here is still `finished`, not `failed`, and that is D15 rather than
           * carelessness: the session ending badly says nothing about whether the pages it
           * already read produced entries. Those entries are written and are the operator's
           * to review. The detail carries what went wrong so the panel can say so.
           */
          const settled = yield* Effect.result(harness.waitForIdle(sessionId));
          /*
           * Idle: whatever was delivered before the wait began has been taken, whether or
           * not the take was seen. Only that: a message delivered after it may have arrived
           * after the idle point this wait saw — the next turn's to take — and is dropped by
           * the next pass, whose wait begins after it.
           */
          for (const [id, message] of steers.get(importId)?.queued ?? []) {
            if (message.acceptedAt <= mark.at)
              steers.get(importId)?.queued.delete(id);
          }
          // A session that ended has nothing more to wait for, whatever was sent to it.
          const ended = settled._tag === "Failure";
          if (!ended && more()) continue;
          if (yield* progress.stopped(importId)) return;

          /*
           * The session's closing report, read once, after it has settled.
           *
           * **This is the only account anything in this process has of why an import wrote
           * what it wrote.** The prompt asks for it in as many words, and the most common
           * outcome of a real import needs it: a client-rendered program page answers `200`
           * with no scope in it, so every step here succeeds, nothing is written, and
           * without this the operator is told "nothing could be read" and no more.
           *
           * `messages` rather than the narration bus, and that distinction is D16's: this is
           * one message, pulled after the fact, for a panel and a toast that have no browser
           * subscribed to anything — the create-target path, where an import is still a batch
           * job. The session's narration *is* drained now (`narrate`), but onto a bus that
           * keeps nothing for a reader who is not there, so it cannot stand in for this. The
           * call list is untouched; what this produces is a single status line.
           *
           * A failure to read it is not a failure of the import. The entries are written and
           * are the operator's to review; the report is an explanation, and an explanation
           * that could not be fetched leaves the import exactly as `finished` as it was.
           */
          const report = yield* Effect.map(
            Effect.result(harness.messages(sessionId)),
            (read) =>
              read._tag === "Failure"
                ? null
                : importReport(lastAssistantText(read.success)),
          );
          // Delivered while the report was read: that message's turn is the one to settle.
          if (!ended && more()) continue;

          yield* progress.settle({
            importId: importId,
            status: "finished",
            detail:
              settled._tag === "Failure"
                ? `the importer's session ended early: ${settled.failure.message}. Anything it had already written is kept.${report === null ? "" : ` It reported: ${report}`}`
                : report,
          });
          /*
           * The last check and the release in one synchronous step: a message delivered
           * before it is waited for here; one delivered after it finds no fiber in `turns`
           * and starts its own.
           */
          const done = yield* Effect.withFiber((fiber) =>
            Effect.sync(() => {
              if (!ended && more()) return false;
              if (turns.get(importId) === fiber) turns.delete(importId);
              return true;
            }),
          );
          if (done) return;
          // Delivered between the settle and the check: the import is working again.
          yield* progress.resume(importId);
        }
      });

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
        // Against the model this import resolved to, not the one the browser was showing:
        // the run path's resolver, so the two cannot disagree about what is forwarded.
        const options = yield* resolveSessionModelOptions(
          harness,
          choice.model,
          pickedOptions,
          "a scope import",
        );
        const importId = newImportId();
        // A resume names the session it continues: minting a fresh id would start a second
        // conversation and leave the session index showing one as two (S3.3).
        const sessionId = request.resume?.sessionId ?? harness.newSessionId();
        /*
         * Still opening, from this instant: see `inFlight`. And, for a reopen, the old id's
         * successor — written here rather than once the session opens, so a caller that stops
         * waiting cannot lose it. Both synchronous with the mint, so no interrupt can land
         * between an id existing and these knowing about it.
         */
        inFlight.set(importId, {
          targetId: request.targetId,
          known: Deferred.makeUnsafe<void>(),
        });
        if (request.predecessor !== undefined) {
          successors.set(request.predecessor, importId);
        }

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

        const fiber = yield* Effect.gen(function* () {
          /*
           * The index entry, written before the session exists.
           *
           * That is the attempt rows' arrangement and for their reason: the harness holds
           * every session of every project and cannot be asked which were ours, so the
           * index is the only way an operator finds this one again, and an id recorded first
           * cannot be lost to a crash between creating the session and writing the row. The
           * price is an entry for a session that never opened (a gate that would not
           * install). That entry is not listed: it is marked once `createSession` returns
           * (`confirmImportSession`, `0025`), and the session list reads only marked ones, so
           * an id the harness never minted cannot be offered for a resume.
           *
           * **A failure to write it does not refuse the import.** The index is a way of
           * finding a session and is advisory in the way `ScopeImportView` is: the import's
           * work is its entries and assets, and they land whether or not this row does. It is
           * logged with the id, which is what recovers it by hand.
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

          /*
           * The first turn, forked into this layer's scope so `start` answers without it.
           *
           * **Its exit no longer closes anything.** The session's scope is the spine's, made
           * there with `Scope.make` rather than the caller's for the reason it always was —
           * the caller is an HTTP handler about to answer, and a credential acquired in the
           * request's scope would be revoked the instant the target was created — and closed
           * only by what this module's header lists. The fiber ending is the end of a turn.
           */
          return yield* Effect.forkIn(
            run({
              importId,
              request,
              agent,
              harness,
              model: choice.model,
              options: dispatchedOptions,
              links,
              sessionId,
              message: request.message,
              opening,
              predecessor: request.predecessor,
              earlierPages: carried.added,
            }).pipe(
              Effect.ensuring(releaseTurn(importId)),
              Effect.ensuring(releaseOpening(importId)),
              // A turn stopped before its open was known still answers whoever is waiting on
              // it. A no-op when the open already completed the deferred.
              Effect.ensuring(
                opening === undefined
                  ? Effect.void
                  : Deferred.fail(
                      opening,
                      new ImporterConversationRefused({
                        reason: "import_ended",
                        detail: `import ${importId} was stopped before its session had opened, so nothing was said to it`,
                      }),
                    ),
              ),
            ),
            own,
          );
        }).pipe(
          // Failed or interrupted before the turn existed — a dropped request lands here —
          // so nothing will learn how an open went: release whoever waits, and take back a
          // successor link to an import that will never open.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.andThen(
                  Effect.sync(() => {
                    if (
                      request.predecessor !== undefined &&
                      successors.get(request.predecessor) === importId
                    ) {
                      successors.delete(request.predecessor);
                    }
                  }),
                  releaseOpening(importId),
                ),
          ),
        );
        turns.set(importId, fiber);

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
         * The registry first, the session second, and the order is the point.
         *
         * Marking it stopped settles the view and revokes nothing, so the route can answer
         * immediately with the receipt for what landed. Then the credential goes — before
         * the interrupt is waited on, so a session mid-call finds its next call refused at
         * the door rather than having however long the harness takes to come back. Then
         * the harness is told to stop, the first turn's fiber is interrupted if it is still
         * running, and the session is closed: the operator ending it is the one intentional
         * close on this module's list, and the one end the toolkit refuses writes on.
         *
         * Everything written before this stays. That is what makes stopping early a
         * decision rather than a loss, and it is true because the session wrote as it read.
         */
        const view = yield* progress.stop(
          importId,
          "stopped by the operator. Everything written up to this point is kept.",
        );
        if (view === undefined) return undefined;

        const entry = sessions.get(importId);
        const turn = turns.get(importId);
        if (entry === undefined && turn === undefined) return view;

        yield* credentials.revokeImport(importId);
        /*
         * The end is recorded as the operator's **here**, after the revoke and before
         * anything is interrupted, and the order is what makes the reason true. Interrupting
         * a first turn that is still opening makes the spine close what it built as
         * `open_failed`, and the first recorded end wins — so recorded after the interrupt,
         * an operator's stop mid-open would read as a failed open, and the toolkit would not
         * refuse on it. Also covers the stop that landed before any entry was published:
         * there was no session to close, and the import is over all the same.
         */
        yield* markEnded(view.targetId, importId, "operator");
        /*
         * No interrupt first. The close ends the harness session (`AgentHarness.endSession`),
         * which stops the turn in flight and drops anything queued behind it; an interrupt
         * would only stop the turn, and on Claude Code it is what makes the CLI go straight
         * on to a queued message — which it then ran after the operator had ended the import.
         * An interrupt mid-open is the spine's to clean up: it closes a scope in no map
         * (ending the session it built), and an entry it had published but not yet prompted.
         */
        if (turn !== undefined) yield* Fiber.interrupt(turn);
        yield* sessions.close(importId, "operator");
        return view;
      });

      const start: ScopeImporter["Service"]["start"] = (request) =>
        startWith(request);

      /** What an accepted message answers with. */
      const accepted = (
        entry: LiveAgentSession<ImportSessionMeta>,
        conversation: ImporterTurnAccepted["conversation"],
        note: string,
        pages: {
          readonly added: readonly string[];
          readonly notAdded: readonly string[];
        },
        /** The steer's id, on a `continued` turn: see `ImporterTurnAccepted.messageId`. */
        messageId?: string,
      ): ImporterTurnAccepted => ({
        targetId: entry.targetId,
        importId: entry.id,
        harnessSessionId: entry.sessionId,
        harnessInstanceId: entry.instanceId,
        model: entry.model,
        conversation,
        note,
        pagesAdded: [...pages.added],
        pagesNotAdded: [...pages.notAdded],
        acceptedAt: Date.now(),
        ...(messageId === undefined ? {} : { messageId }),
      });

      /**
       * Gives one message to an import whose session is live and preambled.
       *
       * Delivery is the spine's (`LiveAgentSessions.deliver`): a `steer` at the operator's
       * urgency, `queued` by default — the goal conversation's seam and reasoning
       * (DECISIONS.md §24.1) — and a refusal closes the session as `refused`. **The import id does not change**: this is the same
       * authority period, so the writes this turn makes are filed under the same
       * `caller_scope` and the session's tally keeps counting (S3.3).
       *
       * Two things are the importer's own. A page the operator typed is added to the pages
       * this import may cite, **before** the message is delivered, so a write citing it is
       * never refused for a page the operator has just given. And the import is marked
       * working again, with a fiber to settle it once the session goes idle — unless a turn's
       * fiber is already waiting, which will.
       */
      const deliverTurn = Effect.fnUntraced(function* (
        entry: LiveAgentSession<ImportSessionMeta>,
        text: string,
        urgency: SteerUrgency,
        uploads?: readonly ReadUpload[],
      ) {
        const widened = yield* progress.addLinks(entry.id, operatorPages(text));
        // The durable copy (`0029`), so a session reopened after a restart can carry these
        // forward. Advisory like the row it lives on: the in-memory list is what the toolkit
        // checks while this process holds the import.
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
        const delivered = yield* Effect.result(
          sessions.deliver(
            entry,
            entry.meta.agent.prompt.followUp({ message: text }),
            urgency,
            uploads,
          ),
        );
        if (
          delivered._tag === "Failure" &&
          delivered.failure._tag === "UploadWriteFailed"
        ) {
          // Nothing was asked of the harness, so the session is kept.
          return yield* new ImporterConversationRefused({
            reason: "upload_unwritable",
            detail: `${delivered.failure.message}. The session is still open; send the message again.`,
          });
        }
        if (delivered._tag === "Failure") {
          return yield* new ImporterConversationRefused({
            reason: "harness_unreachable",
            detail: `${delivered.failure.message}. The harness would not take the message, so this import's session has been closed; your next message opens a fresh one under a new import.`,
          });
        }
        const turn = accepted(
          entry,
          "continued",
          "",
          widened ?? { added: [], notAdded: [] },
          delivered.success.messageId,
        );
        /*
         * Held until the transcript has it (`steers`), marked taken if the take came first.
         * Only while this process still holds this very session: a close that ran while the
         * message was out has already dropped the session's `steers`, and a fresh entry made
         * now would outlive it with nothing left to remove it. No yield from this check to
         * the write, so a close cannot land between them.
         */
        if (sessions.get(entry.id) === entry) {
          const held = steersOf(entry.id);
          const waiting: ImporterQueuedMessage = {
            messageId: delivered.success.messageId,
            text: truncateNarration(text),
            acceptedAt: turn.acceptedAt,
            taken: false,
          };
          held.queued.set(
            delivered.success.messageId,
            held.taken.has(delivered.success.messageId)
              ? tookIt(waiting, held.taken.get(delivered.success.messageId))
              : waiting,
          );
        }
        /*
         * Counted before the import is marked working, so a settling fiber still in `turns`
         * — which this send will not start another beside — sees it on its next check, and
         * waits for this message's turn rather than settling over it (`settleTurn`).
         */
        deliveries.set(entry.id, deliveriesTo(entry.id) + 1);
        if ((yield* progress.resume(entry.id)) && !turns.has(entry.id)) {
          const fiber = yield* Effect.forkIn(
            settleTurn(entry.id, entry.harness, entry.sessionId).pipe(
              Effect.ensuring(releaseTurn(entry.id)),
            ),
            own,
          );
          turns.set(entry.id, fiber);
        }
        return turn;
      });

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
          // Unreachable: a request with a message is never `none`. Answered rather than died
          // on, in the same words a reader of the code would use.
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
        return accepted(
          entry,
          "opened",
          "A new importer session was opened for this message: the importer has its rules, the three tools that let it write, and whatever its harness gives it for reading a page — all inside its own gated directory. It has read nothing else yet.",
          { added: started.pagesAdded, notAdded: started.pagesNotAdded },
        );
      });

      /**
       * One permit per dead import id, held while a fresh session is opened in its place.
       *
       * The spine's per-id permit does not cover this: the fresh session is opened under a
       * **new** id, so two concurrent messages to one dead import would each take a
       * different permit and open two sessions — the goal path's measured double-open bug in
       * a new shape. This permit is on the *old* id, and the successor is re-read inside it.
       */
      const reopening = new Map<string, Semaphore.Semaphore>();
      const reopenLock = (importId: string): Semaphore.Semaphore => {
        const held = reopening.get(importId);
        if (held !== undefined) return held;
        const made = Semaphore.makeUnsafe(1);
        reopening.set(importId, made);
        return made;
      };

      /**
       * The index row a message to an import acts on, refused when there is nothing to say
       * it to: unknown on this target, or ended by the operator.
       */
      const recordedImport = (input: {
        readonly targetId: string;
        readonly importId: string;
      }) =>
        Effect.gen(function* () {
          const row = yield* withTargetStore(stores, input.targetId, (store) =>
            store.importSession(input.importId),
          ).pipe(Effect.mapError(refusal));
          if (row === undefined || row.targetId !== input.targetId) {
            return yield* new ScopeImportNotFound({
              reason: "unknown_import",
              importId: input.importId,
              detail: `no scope import '${input.importId}' is recorded on target '${input.targetId}', so there is no session to say this to`,
            });
          }
          // The one end that is final, and the one the importer's tools refuse writes on.
          if (row.endedReason === "operator") {
            return yield* new ImporterConversationRefused({
              reason: "import_ended",
              detail: `import ${input.importId} was ended by the operator, so its session's authority has ended with it and its tools refuse every write. An ended import is not reopened; start a new session to carry on.`,
            });
          }
          return row;
        });

      /**
       * The run a message or a switch addressed to `importId` belongs to instead, when that is
       * not `importId` itself: its harness session's newest confirmed run (A6 F5, from F4's
       * review).
       *
       * In-process, {@link successors} already follows a reopen to the import it minted. A
       * restart forgets that map and the rows do not: I1 → I2 → I3 is three rows naming one
       * harness session, and an old tab still holding I1 would otherwise reopen from I1's
       * row — resuming the same Claude Code session a second time while I3 holds it — or
       * switch a model on a row nothing reads. `latest_import_id` is the session list's own
       * answer to "which run is the conversation now", so following it agrees with the
       * picker. `undefined` when the row is the newest, or when no run was ever confirmed.
       */
      const newerRun = (
        importId: string,
        row: { readonly latestImportId: string | null },
      ): string | undefined =>
        row.latestImportId !== null && row.latestImportId !== importId
          ? row.latestImportId
          : undefined;

      const send: ScopeImporter["Service"]["send"] = Effect.fn(
        "ScopeImporter.send",
      )(function* (input) {
        const urgency = input.urgency ?? "queued";
        // The fast path: live, preambled, and this target's.
        const live = sessions.ready(input.importId);
        if (live !== undefined && live.targetId === input.targetId) {
          return yield* deliverTurn(live, input.text, urgency, input.uploads);
        }

        /*
         * Still opening: wait until the open is known, then ask again (see `inFlight`).
         *
         * Before the index row, because that row exists — and is confirmed, so the picker
         * lists it — before the spine has published anything, and a row that is neither live
         * nor ended is what the reopen below acts on. Asked again rather than continued
         * from here, because what the open became decides everything after: live, so the
         * fast path delivers; refused or stopped, so the row says which.
         */
        const opening = inFlight.get(input.importId);
        if (opening !== undefined && opening.targetId === input.targetId) {
          yield* Deferred.await(opening.known);
          return yield* send(input);
        }

        const addressed = yield* recordedImport(input);
        const newest = newerRun(input.importId, addressed);
        if (newest !== undefined) {
          return yield* send({ ...input, importId: newest });
        }

        /*
         * Published but not yet preambled: join it, under the spine's permit. `prepare`
         * refuses rather than builds, because **nothing is ever built under an import id that
         * has been opened before** — a fresh session is a new authority period and gets a new
         * id (S3.3). So a joiner that finds the opener's session gone falls through to the
         * reopen below. (An import still opening *before* it was published waited above.)
         */
        if (sessions.get(input.importId) !== undefined) {
          const joined = yield* Effect.result(
            sessions.open<
              ImporterTurnAccepted,
              ImporterConversationRefused | typeof NOT_LIVE,
              never
            >({
              id: input.importId,
              joined: (entry) =>
                deliverTurn(entry, input.text, urgency, input.uploads),
              prepare: Effect.fail(NOT_LIVE),
              refuse: refusal,
              opened: () => Effect.fail(NOT_LIVE),
            }),
          );
          if (joined._tag === "Success") return joined.success;
          const failure = joined.failure;
          if (failure._tag !== "NotLive") return yield* Effect.fail(failure);
        }

        /*
         * Not live in this process and not ended by the operator: closed after a refused
         * prompt, shut down, never opened, or lost to a restart. A fresh session, under a
         * **new** import id — `ended_at` is never cleared, and a session under the old id
         * would be a second authority period wearing the first one's name.
         */
        return yield* Semaphore.withPermit(reopenLock(input.importId))(
          Effect.gen(function* () {
            const successor = successors.get(input.importId);
            if (successor !== undefined) {
              return yield* send({ ...input, importId: successor });
            }
            /*
             * The row again, inside the permit. A model switch to this import writes the row
             * under this same permit (`switchModel`), so the model the successor opens on
             * below is the one the last switch left — never the one read above, before a
             * switch that landed while this message waited for the permit.
             */
            const row = yield* recordedImport(input);
            // Again inside the permit, for the reason the row is read again: a reopen under
            // another id's permit can have made a newer run since the read above.
            const newer = newerRun(input.importId, row);
            if (newer !== undefined) {
              return yield* send({ ...input, importId: newer });
            }
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
             * rather than defaulted when this server does not define it, because opening the
             * conversation as some other agent is a substitution nobody chose.
             */
            const agent = importSessionAgent(row.agentId);
            if (agent === undefined) {
              return yield* new ImporterConversationRefused({
                reason: "agent_unavailable",
                // The replay's sentence for the same row (`importerHistory.ts`), so the
                // composer was already disabled on it with these words.
                detail: agentUnavailableDetail(input.importId, row.agentId),
              });
            }
            /*
             * The earlier session's pages, carried forward: they were the operator's, and
             * this is the same conversation. From memory when this process still holds the
             * old import's list (a refused prompt), and from the row (`0029`) when it does
             * not (a restart). Bounded by the shared cap in `startWith`.
             */
            const earlierPages = widenPages(
              (yield* progress.linksOf(input.importId)) ?? [],
              row.pages ?? [],
            ).pages;
            /*
             * Resume the conversation, or open a new one, according to what the harness
             * actually still holds (S6).
             *
             * The same function the replay route answers `continuation` with, so what the
             * composer was told and what happens here cannot disagree — which is the whole
             * point of it being a function rather than a branch in each place. It never
             * fails: a harness that cannot be asked, a transcript that was swept, a session
             * killed before its first prompt, a directory this server does not gate — all
             * four are a fresh session, with the reason in the sentence.
             */
            const reopen = yield* importerReopenFor({
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
              ...(input.uploads === undefined
                ? {}
                : { uploads: input.uploads }),
              earlierPages,
              predecessor: input.importId,
              agent,
              ...(reopen._tag === "resume"
                ? {
                    resume: {
                      sessionId: reopen.sessionId,
                      directoryImportId: reopen.directoryImportId,
                    },
                  }
                : {}),
              // The same harness the earlier session ran on, and the model it is on now —
              // the last `switchModel`'s, or the one it opened with — so the conversation
              // does not quietly change models under the operator. A row from before
              // instances were recorded has nothing to pin, and D15's rule applies.
              //
              // V2(chat): the row holds only the session's *current* model and options.
              // V1 model switching (within the pinned harness) overwrites them in place and
              // records no history of when a switch happened, so a reload knows the model a
              // session ended on and nothing about the turns before. Proper V2: an
              // append-only switch log keyed by session, so the transcript can mark each
              // switch, plus cross-harness handoff that carries the graph, the agent
              // definition and a summary of the conversation into a new harness session.
              ...(row.harnessInstanceId === null
                ? {}
                : {
                    choice: {
                      instanceId: row.harnessInstanceId,
                      model: row.model,
                      // And the same setting of it (`0028`): a reopen that dropped the
                      // operator's reasoning choice would be a silent downgrade.
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
            return accepted(
              entry,
              reopen._tag === "resume" ? "resumed" : "opened",
              reopen._tag === "resume"
                ? // One conversation, a second authority period. The session id is the same
                  // one — which is why the session list still shows one row — and the import
                  // id is not, because an import id names one authority period (`0027`).
                  `Import ${input.importId}'s authority is not held by this server — ${notHeldBecause(row.endedReason)} — so this message took the conversation back over under import ${entry.id}. The session itself is the same one: ${reopen.detail}, and the importer in it has its own history${pages}.`
                : `Import ${input.importId}'s session is not held by this server — ${notHeldBecause(row.endedReason)} — and could not be carried on: ${reopen.detail}. So this message opened a new session, under import ${entry.id}. The importer in it has not read the earlier session; what that session wrote is on the Scope tab and in the Estate${pages}.`,
              { added: started.pagesAdded, notAdded: started.pagesNotAdded },
            );
          }),
        );
      });

      /**
       * The replay: this process's answer to `live`, and the harness's to everything else.
       *
       * `sessions.get` rather than `ready`: an entry that is published and not yet preambled
       * is still a session **this process holds**, which is what `live` means, and this
       * describes a session rather than delivering into one.
       */
      const replay: ScopeImporter["Service"]["replay"] = Effect.fn(
        "ScopeImporter.replay",
      )(function* (input) {
        const held = sessions.get(input.importId);
        /*
         * What this process holds of the session's steers, read **before** the transcript
         * (A6 U4 review 2): a message accepted before this read is here, and stays here
         * until a read has found it written, or the session idles or closes — so whether the
         * transcript below has written it yet or not, it is in one of the two. Which one is
         * decided by id, not by when.
         */
        const pending = [
          ...(steers.get(input.importId)?.queued.values() ?? []),
        ];
        /*
         * The ids the **whole** transcript holds, not only the newest `limit` items this
         * answer keeps (A6 U4 review 3): a steer whose copy is older than the window is
         * written all the same, and joined to the window alone it was put back at the end.
         */
        let written: ReadonlySet<string> = new Set();
        const view = yield* importerConversation({
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
          onTranscript: (ids) => {
            written = ids;
          },
        });
        /*
         * A message a read has found written is no longer this process's to hold (review 3):
         * the transcript has it, and a compaction that later summarises it away must not put
         * it back at the end. Race-free where review 2's removal was not: a read that then
         * misses it in `pending` read `steers` after this removal, which came after this
         * transcript held it — so its own transcript read, later still, holds it too, unless
         * the harness has since dropped it, which is the case this is for.
         */
        if (view.live) {
          const holding = steers.get(input.importId)?.queued;
          for (const id of written) holding?.delete(id);
        }
        return {
          ...view,
          queued: view.live
            ? pending
                .filter((message) => !written.has(message.messageId))
                .sort((left, right) => left.acceptedAt - right.acceptedAt)
            : [],
        };
      });

      /** The import ids a switch has claimed (`switchFrom`). */
      const switchingImports = new Set<string>();

      /**
       * The import a switch addressed to `importId` lands on, decided under that id's reopen
       * permit.
       *
       * **The permit is the point.** A message to an import that is not live reopens it
       * under this permit, reading the row's model and opening a successor on it — under
       * the successor's opening permit, not this id's, so the spine's claim does not cover
       * it. A switch that wrote this row while the message held the permit would answer
       * success and be lost: the successor would open on the model read before it. So a
       * switch takes the same permit, and the reopen re-reads the row inside it (`send`).
       * Lock order is reopen → opening, as `send`'s; along a chain, predecessor before
       * successor, as `send` follows it.
       *
       * Inside the permit no successor can be added to this id — only a reopen under it
       * mints one — but one can be taken back, when its open fails. So a successor still
       * opening is waited on, and followed only if it is still the successor once its open
       * is known; taken back, the next message reopens from this id's row, which is the one
       * to switch.
       */
      const switchFrom = (
        importId: string,
        input: Parameters<ScopeImporter["Service"]["switchModel"]>[0],
      ): ReturnType<ScopeImporter["Service"]["switchModel"]> =>
        /*
         * Claimed before the permit, and refused when another switch holds it: the permit
         * makes a switch wait for a reopen, and must not make it queue behind another
         * switch, which the spine refuses rather than queues (`LiveAgentSessions.switchModel`
         * says why). Claimed on every id along the chain, so a switch addressed to the
         * predecessor and one addressed to its successor meet on the successor's claim.
         */
        Effect.acquireUseRelease(
          Effect.sync(() => {
            if (switchingImports.has(importId)) return false;
            switchingImports.add(importId);
            return true;
          }),
          (claimed) =>
            claimed
              ? Semaphore.withPermit(reopenLock(importId))(
                  Effect.gen(function* () {
                    const successor = successors.get(importId);
                    if (successor !== undefined) {
                      const following = inFlight.get(successor);
                      if (following !== undefined) {
                        yield* Deferred.await(following.known);
                      }
                      if (successors.get(importId) === successor) {
                        return yield* switchFrom(successor, input);
                      }
                    }
                    // The newest run after a restart, which `successors` no longer knows
                    // (`newerRun`). A row of another target, or none, is `switchOne`'s to
                    // refuse as not found.
                    const row = yield* withTargetStore(
                      stores,
                      input.targetId,
                      (store) => store.importSession(importId),
                    ).pipe(
                      Effect.mapError(
                        (failure) =>
                          new ConversationModelRefused({
                            reason: "store_unavailable",
                            detail: `import ${importId}'s record could not be read (${failure.message}), so nothing was switched.`,
                          }),
                      ),
                    );
                    const newer =
                      row === undefined || row.targetId !== input.targetId
                        ? undefined
                        : newerRun(importId, row);
                    if (newer !== undefined) {
                      return yield* switchFrom(newer, input);
                    }
                    return yield* switchOne(importId, input);
                  }),
                )
              : Effect.fail(
                  modelSwitchRefusal(
                    { _tag: "ModelSwitchInFlight" },
                    {
                      what: `import ${importId}`,
                      model: input.model,
                      previous: null,
                    },
                  ),
                ),
          (claimed) =>
            claimed
              ? Effect.sync(() => {
                  switchingImports.delete(importId);
                })
              : Effect.void,
        );

      const switchModel: ScopeImporter["Service"]["switchModel"] = Effect.fn(
        "ScopeImporter.switchModel",
      )(function* (input) {
        return yield* switchFrom(input.importId, input);
      });

      /** One import's switch, once {@link switchFrom} has decided it is this one. */
      const switchOne = Effect.fn("ScopeImporter.switchOne")(function* (
        importId: string,
        input: Parameters<ScopeImporter["Service"]["switchModel"]>[0],
      ) {
        /*
         * Still opening: wait until the open is known (`inFlight`), as a message does. The
         * opener wrote the row with the model it is opening on and does not read it again,
         * so a row switched in that window would be a change the session never saw.
         */
        const opening = inFlight.get(importId);
        if (opening !== undefined && opening.targetId === input.targetId) {
          yield* Deferred.await(opening.known);
        }
        const what = `import ${importId}`;
        // Read inside the claim, for the answer and for the uncertain answer's sentence. A
        // holder rather than two `let`s, which narrowing would read as never assigned.
        const decided: {
          previous: string | null;
          answer:
            | {
                readonly checked: CheckedModelSwitch;
                readonly changed: boolean;
              }
            | undefined;
        } = { previous: null, answer: undefined };
        const applied = yield* Effect.result(
          sessions.switchModel({
            id: importId,
            prepare: Effect.gen(function* () {
              const row = yield* withTargetStore(
                stores,
                input.targetId,
                (store) => store.importSession(importId),
              ).pipe(
                Effect.mapError(
                  (failure) =>
                    new ConversationModelRefused({
                      reason: "store_unavailable",
                      detail: `${what}'s record could not be read (${failure.message}), so nothing was switched.`,
                    }),
                ),
              );
              if (row === undefined || row.targetId !== input.targetId) {
                return yield* new ScopeImportNotFound({
                  reason: "unknown_import",
                  importId: input.importId,
                  detail: `no scope import '${input.importId}' is recorded on target '${input.targetId}', so there is no session to switch`,
                });
              }
              if (row.endedReason === "operator") {
                return yield* new ConversationModelRefused({
                  reason: "conversation_ended",
                  detail: `${what} was ended by the operator, so nothing will run on it again and there is no model to switch. Start a new session to carry on.`,
                });
              }
              if (row.harnessInstanceId === null) {
                return yield* new ConversationModelRefused({
                  reason: "no_session",
                  detail: `${what} was recorded before its harness instance was, so there is no pinned harness to switch within.`,
                });
              }
              decided.previous = row.model;
              const checked = yield* checkModelSwitch({
                resolver,
                instanceId: row.harnessInstanceId,
                model: input.model,
                requested: input.modelOptions,
                what,
              });
              const changed = !sameModelChoice(row, checked);
              decided.answer = { checked, changed };
              return {
                instanceId: checked.instanceId,
                model: checked.model,
                options: checked.options,
                // The importer's meta is the agent it runs as, which a switch does not touch.
                meta: (meta: ImportSessionMeta) => meta,
                record: (
                  entry: LiveAgentSession<ImportSessionMeta> | undefined,
                ) =>
                  Effect.gen(function* () {
                    // The panel names the model the session runs, so it follows a live
                    // switch; with no live session it already shows the one it ran on.
                    if (entry !== undefined) {
                      yield* progress.switchModel(importId, checked.model);
                    }
                    if (!changed) return;
                    yield* withTargetStore(stores, input.targetId, (store) =>
                      store.recordImportSessionModel({
                        importId,
                        model: checked.model,
                        modelOptions: checked.options,
                      }),
                    ).pipe(
                      Effect.mapError((failure) =>
                        recordRefusal({
                          what,
                          model: checked.model,
                          harnessMoved: entry !== undefined,
                          detail: failure.message,
                        }),
                      ),
                      // Nothing written is not a switch recorded: the row `prepare` read is
                      // gone from this target's file, so a reopen would not open on it.
                      Effect.flatMap((written) =>
                        written
                          ? Effect.void
                          : Effect.fail(
                              recordRefusal({
                                what,
                                model: checked.model,
                                harnessMoved: entry !== undefined,
                                detail: `this target's file no longer holds ${what}'s record`,
                              }),
                            ),
                      ),
                    );
                  }),
              };
            }),
          }),
        );
        if (applied._tag === "Failure") {
          const failure = applied.failure;
          return yield* failure._tag === "ModelSwitchInFlight" ||
          failure._tag === "ModelSwitchUncertain" ||
          failure._tag === "ModelSwitchStale"
            ? Effect.fail(
                modelSwitchRefusal(failure, {
                  what,
                  model: input.model,
                  previous: decided.previous,
                }),
              )
            : Effect.fail(failure);
        }
        const answer = decided.answer;
        if (answer === undefined) {
          // Unreachable: a switch that succeeded ran `prepare`.
          return yield* new ConversationModelRefused({
            reason: "store_unavailable",
            detail: `${what}'s switch answered without a plan, so nothing is known to have changed.`,
          });
        }
        return modelSwitched({
          conversationId: importId,
          checked: answer.checked,
          applied: applied.success,
          changed: answer.changed,
        });
      });

      /**
       * The import holding the session now, from the newest run the rows know of: whatever
       * this process has opened after it. An open still in flight is waited for, so a Stop
       * pressed as a reopen lands reaches the session it opened rather than finding none.
       * The chain only ever runs forward (a successor is minted after its predecessor), so
       * this ends.
       */
      const holdingNow = Effect.fnUntraced(function* (from: string) {
        let importId = from;
        for (;;) {
          const opening = inFlight.get(importId);
          if (opening !== undefined) yield* Deferred.await(opening.known);
          const next = successors.get(importId);
          if (next === undefined) break;
          importId = next;
        }
        return importId;
      });

      const activity: ScopeImporter["Service"]["activity"] = Effect.fn(
        "ScopeImporter.activity",
      )(function* (input) {
        const read = yield* Effect.result(
          withTargetStore(stores, input.targetId, (store) =>
            store.importSession(input.importId),
          ),
        );
        if (read._tag === "Failure") {
          yield* Effect.logWarning(
            "an import's record could not be read for its activity; answering for the import addressed",
            { importId: input.importId, detail: read.failure.message },
          );
        }
        const row = read._tag === "Success" ? read.success : undefined;
        if (
          read._tag === "Success" &&
          (row === undefined || row.targetId !== input.targetId)
        ) {
          return yield* new ScopeImportNotFound({
            reason: "unknown_import",
            importId: input.importId,
            detail: `no scope import '${input.importId}' is recorded on target '${input.targetId}', so nothing of it is running`,
          });
        }
        const importId = yield* holdingNow(
          (row === undefined ? undefined : newerRun(input.importId, row)) ??
            input.importId,
        );
        const found = yield* sessions.status(importId);
        if (found._tag === "not_live") {
          return {
            conversationId: importId,
            turn: "not_live",
            background: false,
          };
        }
        /*
         * Running while the import is, too: from a message's acceptance until its settle has
         * read the closing report, which the session list's `running` reports. So this answer
         * says "running" whenever the list does, and a screen reading both never sees the
         * list call a turn running that this calls over.
         */
        const view = yield* progress.view(importId);
        return {
          conversationId: importId,
          turn:
            found.running || view?.status === "running" ? "running" : "idle",
          background: found.background,
        };
      });

      const context: ScopeImporter["Service"]["context"] = Effect.fn(
        "ScopeImporter.context",
      )(function* (input) {
        const readRow = (importId: string) =>
          Effect.result(
            withTargetStore(stores, input.targetId, (store) =>
              store.importSession(importId),
            ),
          );
        const read = yield* readRow(input.importId);
        const addressed = read._tag === "Success" ? read.success : undefined;
        if (
          read._tag === "Success" &&
          (addressed === undefined || addressed.targetId !== input.targetId)
        ) {
          return yield* new ScopeImportNotFound({
            reason: "unknown_import",
            importId: input.importId,
            detail: `no scope import '${input.importId}' is recorded on target '${input.targetId}', so there is no context to measure`,
          });
        }
        const importId = yield* holdingNow(
          (addressed === undefined
            ? undefined
            : newerRun(input.importId, addressed)) ?? input.importId,
        );
        // The successor's own row: its harness session and model are the conversation's now.
        const row =
          importId === input.importId
            ? addressed
            : yield* Effect.map(readRow(importId), (again) =>
                again._tag === "Success" &&
                again.success?.targetId === input.targetId
                  ? again.success
                  : addressed,
              );
        /*
         * Stamped once the harness has answered, not when it was asked (A6 U9 review): a
         * `full` count takes about a second, and stamped at the asking, one asked mid-turn
         * would read as older than the turn-end reading that overtook it, though it saw at
         * least as much.
         */
        const unread = (model: string) =>
          Effect.map(
            Clock.currentTimeMillis,
            (measuredAt): ConversationContext => ({
              conversationId: importId,
              model,
              used: null,
              usedModel: null,
              window: null,
              reading: "unread",
              breakdown: { _tag: "none", reason: "unanswered" },
              measuredAt,
            }),
          );
        if (row === undefined) return yield* unread("");
        const answered = yield* Effect.result(
          Effect.flatMap(
            resolver.resolve(row.harnessInstanceId ?? undefined),
            ({ harness }) =>
              harness.contextUsage(row.harnessSessionId, {
                model: row.model,
                breakdown: input.breakdown,
              }),
          ),
        );
        if (answered._tag === "Failure") {
          yield* Effect.logDebug(
            "an import's harness could not report its context; answering unread",
            { importId, detail: answered.failure.message },
          );
          return yield* unread(row.model);
        }
        // The window's model as the harness answered it, where it said (A6 U9 review 2):
        // the row is written only once a switch has returned.
        const { model, ...usage } = answered.success;
        return {
          conversationId: importId,
          model: model ?? row.model,
          ...usage,
          measuredAt: yield* Clock.currentTimeMillis,
        };
      });

      const stopTurn: ScopeImporter["Service"]["stopTurn"] = Effect.fn(
        "ScopeImporter.stopTurn",
      )(function* (input) {
        const row = yield* withTargetStore(stores, input.targetId, (store) =>
          store.importSession(input.importId),
        ).pipe(
          Effect.mapError(
            (failure) =>
              new ConversationStopRefused({
                reason: "store_unavailable",
                detail: `import ${input.importId}'s record could not be read (${failure.message}), so nothing was stopped.`,
              }),
          ),
        );
        if (row === undefined || row.targetId !== input.targetId) {
          return yield* new ScopeImportNotFound({
            reason: "unknown_import",
            importId: input.importId,
            detail: `no scope import '${input.importId}' is recorded on target '${input.targetId}', so there is no turn to stop`,
          });
        }
        const importId = yield* holdingNow(
          newerRun(input.importId, row) ?? input.importId,
        );
        // Named as the operator sees it from its own chat, never by its id (A6 U6 review).
        const what = "this session";
        const found = yield* sessions
          .interrupt(importId)
          .pipe(Effect.mapError((failure) => turnStopRefusal(failure, what)));
        return turnStopped({ found, conversationId: importId, what });
      });

      return ScopeImporter.of({
        start,
        stop,
        view: progress.view,
        converse,
        send,
        replay,
        switchModel,
        stopTurn,
        activity,
        context,
        holds: (importId) =>
          Effect.sync(() => sessions.get(importId) !== undefined),
        heldSteers: (importId) =>
          Effect.sync(() => steers.get(importId)?.queued.size ?? 0),
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
      // No harness, so no session this server could hold: nothing of any import runs here.
      stopTurn: (input) =>
        Effect.succeed(
          turnStopped({
            found: { _tag: "not_live" },
            conversationId: input.importId,
            what: "this session",
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
