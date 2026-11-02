/**
 * The scope importer: one agent session that reads a program's pages and writes its scope.
 *
 * Started by `createTarget` when the operator pasted at least one program link (D13), and
 * by nothing else. It runs once per target creation, finishes before any goal exists, and
 * has three tools — `add_scope_entry`, `record_imported_asset`, `read_scope` — on its own
 * MCP endpoint.
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
  bitMcpServerName,
  SCOPE_IMPORT_MAX_LINKS,
  type ScopeImportView,
} from "@bit/contracts";
import { Context, Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect";

import { resolveImporterModel } from "./importerModel";
import { assembleImporterPrompt } from "./importerPrompt";
import { ScopeImportProgress } from "./progress";
import {
  lastAssistantText,
  OPEN_PROMPT,
  type AgentHarness,
} from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import { newImportId } from "../persistence/identifier";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { gatedRoleDirectory, POLICY_AUDIT_FILE } from "../policy/install";
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
  | { readonly _tag: "refused"; readonly detail: string };

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

export interface ScopeImportRequest {
  readonly targetId: string;
  readonly targetName: string;
  /** The engagement folder, for the gate's containment check. `null` when there is none. */
  readonly workspacePath: string | null;
  readonly links: readonly string[];
  /**
   * The operator's pick, when they touched the picker on the create-target screen.
   *
   * Two fields and not three: there is no `modelOptions` here, and `ImportModelDraft`
   * records why — the field, this one and the `options` argument they reached were plumbing
   * with no caller, and reasoning depth on a single-turn extraction session is a control
   * for nothing.
   */
  readonly choice?:
    | {
        readonly instanceId?: string | undefined;
        readonly model?: string | undefined;
      }
    | undefined;
}

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
   * which interrupts any import still reading and takes its credential and registration
   * with it.
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
      // This layer's own scope, which every import's fiber is forked into. Shutting the
      // server down closes it, which interrupts any import still reading and — through
      // each import's own inner scope — revokes its credential and takes back its MCP
      // registration.
      const own = yield* Effect.scope;

      /** Live imports, so a stop can reach the fiber a route does not hold. */
      const live = new Map<
        string,
        {
          readonly fiber: Fiber.Fiber<void>;
          readonly harness: AgentHarness["Service"];
          readonly sessionId: string;
        }
      >();

      /**
       * The whole life of one import session, inside its own scope.
       *
       * The order is the goal conversation's, and each step rules out the next step's
       * ambiguity: the gated directory before the session, so a session is never created
       * in a directory nothing is auditing; the credential before the registration, so
       * there is something to register; the registration before the prompt, so turn one has
       * the tools. A failure at any step closes the scope, which revokes the credential and
       * unregisters the server — including the case where the *next* step is the thing that
       * failed.
       */
      const run = Effect.fnUntraced(function* (input: {
        readonly importId: string;
        readonly request: ScopeImportRequest;
        readonly harness: AgentHarness["Service"];
        readonly model: string;
        readonly links: readonly string[];
        readonly sessionId: string;
        readonly scope: Scope.Scope;
      }) {
        const urls = yield* endpoints.urls;
        const harness = input.harness;

        const opened = yield* Effect.result(
          Effect.gen(function* () {
            const directory = yield* gatedRoleDirectory({
              ensure: fleet.ensureImportDirectory(
                input.request.targetId,
                input.importId,
              ),
              install: harness.installGate,
              policyUrl: urls.policy,
              // Outside the import's own directory, like a round's and a goal's: a session
              // that can read the gate's record can read the shape of the boundary it is
              // inside. `gatedRoleDirectory` refuses the nesting rather than trusting this
              // call site to get it right.
              auditPath: `${fleet.paths.evidenceDirectory(input.request.targetId)}/${POLICY_AUDIT_FILE}`,
              // The engagement folder, so the containment check can refuse an import
              // directory inside it. `undefined` says this target has none, which is a
              // statement rather than an omission.
              ...(input.request.workspacePath === null
                ? { workspace: undefined }
                : { workspace: input.request.workspacePath }),
            });

            const created = yield* harness.createSession({
              title: `bit scope importer: ${input.request.targetName}`,
              model: input.model,
              directory,
              sessionId: input.sessionId,
              // Single-turn. The importer is prompted once, works through every link, and
              // stops; there is no operator on the other end of it and nothing steers it.
              // That is also why there is no steering path here and no message queue.
              multiTurn: false,
            });

            // `issueImport`, which takes importer bindings and nothing else, and defaults
            // to a lifetime measured in minutes rather than a worker's six hours. A
            // fourth caller kind is what makes this session's three tools unreachable
            // from a worker, a planner or a goal agent: each endpoint refuses a grant
            // whose tag is not the role it serves.
            const credential = yield* credentials.issueImport({
              _tag: "importer",
              targetId: input.request.targetId,
              importId: input.importId,
            });

            const serverName = bitMcpServerName(input.importId);
            yield* Effect.acquireRelease(
              harness.registerMcpServer(created.id, serverName, {
                // The **importer** endpoint. This line is what decides the tool list: the
                // path selects the toolkit and the grant decides whether the request is
                // served at all. An importer credential at the worker URL is a `401`
                // before any tool list is produced, and a worker's credential here is the
                // same — which is what makes "three tools, and nowhere else" a property of
                // the registration rather than of a filter.
                url: urls.importerMcp,
                headers: {
                  authorization: Redacted.make(
                    `Bearer ${Redacted.value(credential.token)}`,
                  ),
                },
                directory,
              }),
              () =>
                harness.unregisterMcpServer(created.id, serverName).pipe(
                  Effect.catch((failure) =>
                    Effect.logWarning(
                      "a harness would not take back the scope importer's MCP registration; the credential behind it is revoked either way",
                      {
                        importId: input.importId,
                        server: serverName,
                        detail: failure.message,
                      },
                    ),
                  ),
                ),
            );
            return created.id;
          }).pipe(Scope.provide(input.scope)),
        );

        if (opened._tag === "Failure") {
          yield* progress.settle({
            importId: input.importId,
            status: "failed",
            detail: opened.failure.message,
          });
          yield* Effect.logWarning("a scope import could not be opened", {
            targetId: input.request.targetId,
            importId: input.importId,
            detail: opened.failure.message,
          });
          return;
        }

        const prompted = yield* Effect.result(
          harness.prompt(
            opened.success,
            assembleImporterPrompt({
              targetName: input.request.targetName,
              links: input.links,
            }),
            OPEN_PROMPT,
          ),
        );
        if (prompted._tag === "Failure") {
          yield* progress.settle({
            importId: input.importId,
            status: "failed",
            detail: prompted.failure.message,
          });
          return;
        }

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
        const settled = yield* Effect.result(
          harness.waitForIdle(opened.success),
        );
        if (yield* progress.stopped(input.importId)) return;

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
          Effect.result(harness.messages(opened.success)),
          (read) =>
            read._tag === "Failure"
              ? null
              : importReport(lastAssistantText(read.success)),
        );

        yield* progress.settle({
          importId: input.importId,
          status: "finished",
          detail:
            settled._tag === "Failure"
              ? `the importer's session ended early: ${settled.failure.message}. Anything it had already written is kept.${report === null ? "" : ` It reported: ${report}`}`
              : report,
        });
      });

      const start: ScopeImporter["Service"]["start"] = Effect.fn(
        "ScopeImporter.start",
      )(function* (request) {
        if (request.links.length === 0) return { _tag: "none" } as const;

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

        const choice = resolveImporterModel({
          listings: resolver.instances,
          ...(request.choice === undefined ? {} : { choice: request.choice }),
        });
        if (choice === undefined) {
          return {
            _tag: "refused",
            detail:
              "no agent harness on this server is ready, so the program pages could not be read. The target is created; author its scope by hand on the Assets screen, or configure a harness and import it later.",
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
            detail: `${resolved.failure.detail} The target is created; author its scope by hand on the Assets screen.`,
          } as const;
        }

        const harness = resolved.success.harness;
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
         * install), which reads as a session that wrote nothing and, asked about, as one
         * the harness does not have. Both are true.
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

        /*
         * The import's own scope, which outlives this request.
         *
         * `Scope.make` rather than the caller's: the caller is an HTTP handler about to
         * answer, and a credential acquired in the request's scope would be revoked the
         * instant the target was created — leaving a session with no tools, which is the
         * failure `main.ts`'s header records having been observed for workers.
         */
        const scope = yield* Scope.make();
        const fiber = yield* Effect.forkIn(
          run({
            importId,
            request,
            harness,
            model: choice.model,
            links,
            sessionId,
            scope,
          }).pipe(
            // The scope closes however the fiber ends — finished, failed or interrupted —
            // so the credential is revoked and the registration taken back on every path.
            Effect.onExit(() => Scope.close(scope, Exit.void)),
            Effect.ensuring(Effect.sync(() => live.delete(importId))),
          ),
          own,
        );
        live.set(importId, { fiber, harness, sessionId });

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
         * the session is interrupted and its fiber killed, which closes its scope.
         *
         * Everything written before this stays. That is what makes stopping early a
         * decision rather than a loss, and it is true because the session wrote as it read.
         */
        const view = yield* progress.stop(
          importId,
          "stopped by the operator. Everything written up to this point is kept.",
        );
        if (view === undefined) return undefined;

        const entry = live.get(importId);
        if (entry === undefined) return view;

        yield* credentials.revokeImport(importId);
        yield* entry.harness
          .interruptSession(entry.sessionId)
          .pipe(
            Effect.catch((failure) =>
              Effect.as(
                Effect.logWarning(
                  "a harness would not interrupt a scope import; its credential is revoked and its fiber is interrupted either way",
                  { importId, detail: failure.message },
                ),
                false,
              ),
            ),
          );
        yield* Fiber.interrupt(entry.fiber);
        return view;
      });

      return ScopeImporter.of({
        start,
        stop,
        view: progress.view,
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
                detail:
                  "this server is configured with no agent harness, so program pages cannot be read. The target is created; author its scope by hand on the Assets screen.",
              },
        ),
      stop: () => Effect.succeed(undefined),
      view: () => Effect.succeed(undefined),
    }),
  );
}
