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
 * ## The session's narration is never read, and its final report is (D16)
 *
 * There is no `sessionEvents` subscription here, and its absence is D16's implementation
 * of the *call list*. The panel lists tool calls, which the importer's own toolkit records
 * as they cross our MCP boundary (`import/progress.ts`). Narration is not filtered out of
 * that list — it is never captured, so putting it there would mean building something new.
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
  ImporterConversationRefused,
  SCOPE_IMPORT_MAX_LINKS,
  ScopeImportNotFound,
  type ImporterTurnAccepted,
  type ImportModelDraft,
  type ModelOptionSelection,
  type ScopeImportView,
} from "@bit/contracts";
import { Context, Deferred, Effect, Fiber, Layer, Semaphore } from "effect";

import { resolveImporterModel } from "./importerModel";
import {
  assembleImporterFollowUpPrompt,
  assembleImporterPrompt,
  operatorPages,
} from "./importerPrompt";
import { ScopeImportProgress } from "./progress";
import { lastAssistantText, type AgentHarness } from "../harness/agentHarness";
import {
  makeLiveAgentSessions,
  type LiveAgentSession,
  type LiveSessionCloseReason,
  type LiveSessionOpenFailure,
} from "../harness/liveAgentSessions";
import { resolveSessionModelOptions } from "../harness/modelOptions";
import { HarnessResolver } from "../harness/resolver";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { newImportId } from "../persistence/identifier";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { WorkerEndpoints } from "../run/supervisor";

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
    }
  /** Links were given and this server cannot read them. The target is created regardless. */
  | {
      readonly _tag: "refused";
      /** Which of the two: no harness at all, or the chosen one cannot take a session. */
      readonly reason: "no_harness" | "harness_not_ready";
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

/** Where an import's first turn says how its open went, for a caller that waits on it. */
type Opening = Deferred.Deferred<
  LiveAgentSession<undefined>,
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
   */
  readonly choice?: ImportModelDraft | undefined;
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
      input: Omit<ScopeImportRequest, "links" | "message"> & {
        readonly text: string;
      },
    ) => Effect.Effect<ImporterTurnAccepted, ImporterConversationRefused>;
    /**
     * Gives one operator message to an import (S3).
     *
     * Live in this process: delivered into its session as a queued steer, under the **same**
     * import id, so its writes count toward the same tally. Ended by the operator: refused.
     * Anything else — closed after a refused prompt, lost to a restart — opens a fresh
     * session under a **new** import id, because an import id names one authority period
     * and an ended one is never revived (`0027`).
     */
    readonly send: (input: {
      readonly targetId: string;
      readonly importId: string;
      readonly text: string;
    }) => Effect.Effect<
      ImporterTurnAccepted,
      ImporterConversationRefused | ScopeImportNotFound
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
  > = Layer.effect(
    ScopeImporter,
    Effect.gen(function* () {
      const resolver = yield* HarnessResolver;
      const fleet = yield* FleetStore;
      const credentials = yield* McpCredentials;
      const endpoints = yield* WorkerEndpoints;
      const progress = yield* ScopeImportProgress;
      const stores = yield* TargetStores;
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
      const sessions = yield* makeLiveAgentSessions<undefined>(
        { fleet, endpoints },
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
              _tag: "importer",
              targetId: input.targetId,
              importId: input.id,
            }),
          revokeStray: credentials.revokeImport,
          afterClose: (entry, reason) =>
            markEnded(entry.targetId, entry.id, reason),
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
        readonly harness: AgentHarness["Service"];
        readonly model: string;
        readonly options: readonly ModelOptionSelection[] | undefined;
        readonly links: readonly string[];
        readonly sessionId: string;
        /** The operator's first message, for a conversation. See `ScopeImportRequest`. */
        readonly message: string | undefined;
        /** Completed once the open is known, for a caller that waits on it (`converse`). */
        readonly opening: Opening | undefined;
      }) {
        const harness = input.harness;
        const opened = yield* Effect.result(
          sessions.open<
            LiveAgentSession<undefined> | undefined,
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
              title: `bit scope importer: ${input.request.targetName}`,
              ensureDirectory: fleet.ensureImportDirectory(
                input.request.targetId,
                input.importId,
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
              // No narrator. D16: the importer's narration is never captured, and S4 is
              // the slice that changes that.
              openingPrompt: () =>
                assembleImporterPrompt({
                  targetName: input.request.targetName,
                  links: input.links,
                  message: input.message,
                }),
              meta: undefined,
            }),
            opened: (entry) => Effect.succeed(entry),
          }),
        );

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
       */
      const settleTurn = Effect.fnUntraced(function* (
        importId: string,
        harness: AgentHarness["Service"],
        sessionId: string,
      ) {
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
         * `messages` rather than `sessionEvents`, and that distinction is D16's: this is
         * one message, pulled after the fact, not a stream subscribed to while the session
         * talks. No narration is captured, nothing intermediate is kept, and the call list
         * is untouched — what this produces is a single status line.
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

        yield* progress.settle({
          importId: importId,
          status: "finished",
          detail:
            settled._tag === "Failure"
              ? `the importer's session ended early: ${settled.failure.message}. Anything it had already written is kept.${report === null ? "" : ` It reported: ${report}`}`
              : report,
        });
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
        const sessionId = harness.newSessionId();

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
          urls: links,
          droppedLinks,
          harnessInstanceId: harness.instance.instanceId,
          model: choice.model,
        });
        // A page the operator typed into their message is one this import may cite, exactly
        // as a pasted link is. See `progress.addLinks`.
        if (request.message !== undefined) {
          yield* progress.addLinks(importId, operatorPages(request.message));
        }

        /*
         * The first turn, forked into this layer's scope so `start` answers without it.
         *
         * **Its exit no longer closes anything.** The session's scope is the spine's, made
         * there with `Scope.make` rather than the caller's for the reason it always was —
         * the caller is an HTTP handler about to answer, and a credential acquired in the
         * request's scope would be revoked the instant the target was created — and closed
         * only by what this module's header lists. The fiber ending is the end of a turn.
         */
        const fiber = yield* Effect.forkIn(
          run({
            importId,
            request,
            harness,
            model: choice.model,
            options,
            links,
            sessionId,
            message: request.message,
            opening,
          }).pipe(
            Effect.ensuring(Effect.sync(() => turns.delete(importId))),
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
        if (entry !== undefined) {
          yield* entry.harness
            .interruptSession(entry.sessionId)
            .pipe(
              Effect.catch((failure) =>
                Effect.as(
                  Effect.logWarning(
                    "a harness would not interrupt a scope import; its credential is revoked and its session is closed either way",
                    { importId, detail: failure.message },
                  ),
                  false,
                ),
              ),
            );
        }
        // An interrupt mid-open is the spine's to clean up: it closes a scope in no map,
        // and an entry it had published but not yet prompted.
        if (turn !== undefined) yield* Fiber.interrupt(turn);
        yield* sessions.close(importId, "operator");
        return view;
      });

      const start: ScopeImporter["Service"]["start"] = (request) =>
        startWith(request);

      /** What an accepted message answers with. */
      const accepted = (
        entry: LiveAgentSession<undefined>,
        conversation: ImporterTurnAccepted["conversation"],
        note: string,
      ): ImporterTurnAccepted => ({
        targetId: entry.targetId,
        importId: entry.id,
        harnessSessionId: entry.sessionId,
        harnessInstanceId: entry.instanceId,
        model: entry.model,
        conversation,
        note,
        acceptedAt: Date.now(),
      });

      /**
       * Gives one message to an import whose session is live and preambled.
       *
       * Delivery is the spine's (`LiveAgentSessions.deliver`): a `steer` at `queued` urgency,
       * the goal conversation's seam and reasoning (DECISIONS.md §24.1), and a refusal closes
       * the session as `refused`. **The import id does not change**: this is the same
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
        entry: LiveAgentSession<undefined>,
        text: string,
      ) {
        yield* progress.addLinks(entry.id, operatorPages(text));
        const delivered = yield* Effect.result(
          sessions.deliver(
            entry,
            assembleImporterFollowUpPrompt({ message: text }),
          ),
        );
        if (delivered._tag === "Failure") {
          return yield* new ImporterConversationRefused({
            reason: "harness_unreachable",
            detail: `${delivered.failure.message}. The harness would not take the message, so this import's session has been closed; your next message opens a fresh one under a new import.`,
          });
        }
        if ((yield* progress.resume(entry.id)) && !turns.has(entry.id)) {
          const fiber = yield* Effect.forkIn(
            settleTurn(entry.id, entry.harness, entry.sessionId).pipe(
              Effect.ensuring(Effect.sync(() => turns.delete(entry.id))),
            ),
            own,
          );
          turns.set(entry.id, fiber);
        }
        return accepted(entry, "continued", "");
      });

      /**
       * Starts an import with the operator's message as its first turn, and waits for the
       * open to be known.
       */
      const openWith = Effect.fnUntraced(function* (
        request: ScopeImportRequest,
      ) {
        const opening: Opening = yield* Deferred.make<
          LiveAgentSession<undefined>,
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
        return yield* Deferred.await(opening);
      });

      const converse: ScopeImporter["Service"]["converse"] = Effect.fn(
        "ScopeImporter.converse",
      )(function* (input) {
        const entry = yield* openWith({
          targetId: input.targetId,
          targetName: input.targetName,
          workspacePath: input.workspacePath,
          links: [],
          message: input.text,
          ...(input.choice === undefined ? {} : { choice: input.choice }),
        });
        return accepted(
          entry,
          "opened",
          "A new importer session was opened for this message: the importer has its rules and its three tools, and has read nothing else yet.",
        );
      });

      /**
       * Which import took over from one whose session this process no longer held.
       *
       * Written when a message to a dead import opens a fresh session under a new id, and
       * read by the next message to the old id, which goes to the new one rather than
       * opening a third. Bounded by the number of reopenings an operator causes, and not
       * swept, for `liveAgentSessions.ts`'s `opening` map's reason.
       */
      const successors = new Map<string, string>();

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

      const send: ScopeImporter["Service"]["send"] = Effect.fn(
        "ScopeImporter.send",
      )(function* (input) {
        // The fast path: live, preambled, and this target's.
        const live = sessions.ready(input.importId);
        if (live !== undefined && live.targetId === input.targetId) {
          return yield* deliverTurn(live, input.text);
        }

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

        /*
         * Still opening: join it, under the spine's permit. `prepare` refuses rather than
         * builds, because **nothing is ever built under an import id that has been opened
         * before** — a fresh session is a new authority period and gets a new id (S3.3). So a
         * joiner that finds the opener's session gone falls through to the reopen below.
         */
        if (sessions.get(input.importId) !== undefined) {
          const joined = yield* Effect.result(
            sessions.open<
              ImporterTurnAccepted,
              ImporterConversationRefused | typeof NOT_LIVE,
              never
            >({
              id: input.importId,
              joined: (entry) => deliverTurn(entry, input.text),
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
            const target = yield* fleet
              .target(input.targetId)
              .pipe(Effect.mapError(refusal));
            if (target === undefined) {
              return yield* new ImporterConversationRefused({
                reason: "target_unavailable",
                detail: `no target '${input.targetId}' is registered on this server`,
              });
            }
            const entry = yield* openWith({
              targetId: input.targetId,
              targetName: target.name,
              workspacePath: target.workspacePath ?? null,
              links: [],
              message: input.text,
              // The same harness and model the earlier session ran on, so the conversation
              // does not quietly change models under the operator. A row from before
              // instances were recorded has nothing to pin, and D15's rule applies.
              ...(row.harnessInstanceId === null
                ? {}
                : {
                    choice: {
                      instanceId: row.harnessInstanceId,
                      model: row.model,
                    },
                  }),
            });
            successors.set(input.importId, entry.id);
            return accepted(
              entry,
              "opened",
              `Import ${input.importId}'s session is not held by this server — ${notHeldBecause(row.endedReason)} — so this message opened a new session, under import ${entry.id}. The importer in it has not read the earlier session; what that session wrote is on the Scope tab and in the Estate.`,
            );
          }),
        );
      });

      return ScopeImporter.of({
        start,
        stop,
        view: progress.view,
        converse,
        send,
      });
    }),
  );

  /**
   * An importer for a server with no harness.
   *
   * `start` refuses with links and answers `none` without them, which is the same shape the
   * real one produces — so `createTarget` has one code path and a server configured with
   * `HARNESS=0` still creates targets. It does not pretend an import happened.
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
      converse: () => Effect.fail(noHarness),
      send: () => Effect.fail(noHarness),
    }),
  );
}

/** What a server with no harness answers every message with. */
const noHarness = new ImporterConversationRefused({
  reason: "no_harness",
  detail:
    "this server is configured with no agent harness, so there is no importer to talk to. Author the scope by hand on the Assets screen.",
});
