/**
 * The server process.
 *
 * It serves {@link ControlPlaneEndpoint} and nothing else. There used to be a second
 * HTTP composition here — a `Bun.serve` with a hand-written `fetch` that matched one
 * path and 404'd everything else — which meant the health route was served by different
 * code, with different method and content handling, from the two routes the spike
 * demos bring up. The health route is a route on the control plane now, so there is one
 * router, one port and one shutdown path in this process too.
 *
 * **Two tiers, from here down** (DECISIONS.md §3). `<HUNT_ROOT>/control.sqlite` holds the
 * settings and the target registry; each target's graph is `targets/<id>/hunt.sqlite`.
 * Startup migrates the control database, then **iterates the registry** and migrates
 * every unarchived target's own file. A target whose file does not migrate is marked
 * unavailable and refused by name; its neighbours are served. The reasoning for that
 * policy, and its cost, are recorded on `persistence/fleet.ts`.
 *
 * **This process reads any target on demand.** It used to bind one target's store into
 * the layer graph at startup and serve that target only; what replaces that is
 * `persistence/targetStores.ts`, a resolver that opens `targets/<id>/hunt.sqlite` when
 * something asks for that id, shares one handle between everything holding it, and closes
 * it once nothing has used it for a minute. The browser's `GET /api/v1/targets/:targetId`
 * goes through it per request, which is what makes "open each of two targets in turn" a
 * thing this process can do without a restart.
 *
 * **The last pin is gone, and with it `TARGET_ID`.** `/api/v1/mcp` used to take one
 * target's store as a layer requirement, so this entrypoint resolved one id at startup and
 * every authenticated write in the process went there. The write boundary dispatches by
 * credential now (`mcp/tools.ts`): the route takes the resolver, and the tool handler
 * reaches a store with the `targetId` the presented credential carries — which is derived
 * from the credential and never from anything the model said. Three things went with it:
 * the `TARGET_ID` environment variable, the pinned store, and the startup registration of
 * that target.
 *
 * **Losing the auto-registration is the point, not a side effect.** This process used to
 * register `fixture-local` on first boot if it was not there, which meant a fresh
 * installation never had an empty registry — and the "first run, no targets" screen the
 * design brief specifies was unreachable against a real server. A fresh fleet now has no
 * targets until an operator creates one.
 *
 * **This process can start runs.** It owns an `opencode serve` and a client over it, and
 * `run/supervisor.ts` turns a request into a detached run: the request returns an attempt
 * id as soon as the prompt is accepted, and a fiber in this process's scope owns the rest.
 * A harness that will not start is **not** fatal — see `harness` below — because a server
 * that would not boot without one could not be used to look at what earlier runs recorded.
 *
 * What this entrypoint owns, in one scope, released in reverse on every exit including
 * `SIGINT`:
 *
 * 1. The fleet: the control database, migrated, and the registry sweep across targets.
 * 2. The per-target store resolver, and through it the store the MCP route is pinned to,
 *    which brings its own schema up to date before anything can read it.
 * 3. The listener.
 * 4. **Startup reconciliation**, before any work is dispatched. Attempts left `running`
 *    by a previous process are reconciled against the harness, which revokes their
 *    write authority durably. It needs a harness to ask, and this process does not own
 *    one: with no harness configured every unsettled attempt reconciles to `uncertain`,
 *    which is the honest answer rather than a skipped step. `RECONCILE_ON_START=0` turns
 *    it off for an operator who wants to inspect the rows first.
 *
 * Reconciliation runs after the layer graph is built, so the listener is accepting
 * requests while it works. That is not a window worth closing here, and the reason is
 * worth stating rather than assuming: this process mints no credentials, so every MCP
 * request it can receive during that moment is a `401` regardless of what any attempt
 * row says. Ordering would matter in a process that also dispatched work.
 *
 * **The browser-facing API is served on the same listener**, declared once in
 * `@bit/contracts` and implemented in `http/browserApi.ts`. Its endpoints are guarded by
 * a browser session bearer resolved against `http/browserSessions.ts` — a registry that
 * is deliberately separate from the MCP credentials below, with no shared map and no
 * shared resolver, so neither kind of token can be mistaken for the other. The password
 * those sessions are opened with is generated on first boot, stored as a hash in
 * `control.sqlite`, and printed once by `prepareFleet`.
 *
 * The MCP route is served here with no credentials issued, which is correct and worth
 * being explicit about: credentials are minted per attempt by whatever dispatches work,
 * so until something does, every MCP request to this process is a `401`. An empty
 * credential registry is a closed door, not an open one.
 */
import { join } from "node:path";

import { API_PREFIX } from "@bit/contracts";
import { Effect, Layer } from "effect";

import { browserApiRoutes } from "./http/browserApi";
import { BrowserSessions, ensureServerPassword } from "./http/browserSessions";
import { ControlPlaneEndpoint } from "./http/controlPlane";
import { resolveRoot } from "./http/folders";
import { AgentHarness } from "./harness/agentHarness";
import { claudeCodeHarness } from "./harness/claudeCodeClient";
import type { HarnessProcessError } from "./harness/errors";
import { CLAUDE_CODE_DRIVER, OPENCODE_DRIVER } from "./harness/identity";
import { openCodeHarness } from "./harness/openCodeClient";
import { OpenCodeServer } from "./harness/openCodeServer";
import { McpCredentials } from "./mcp/credentials";
import { McpCallCounter } from "./mcp/server";
import { FleetStore } from "./persistence/fleet";
import { ObservationStore } from "./persistence/store";
import { TargetStores } from "./persistence/targetStores";
import { PERMISSIVE_POLICY, PolicyDecisions } from "./policy/service";
import { harnessSelection, KNOWN_DRIVERS } from "./run/model";
import { RunNarrations } from "./run/narration";
import { RunSupervisor, WorkerEndpoints } from "./run/supervisor";
import { HarnessSessionStatus } from "./recovery/harnessStatus";
import {
  reconcileUnsettledAttempts,
  renderReconciliation,
} from "./recovery/reconcile";

/**
 * Where the fleet lives.
 *
 * A directory, not a file: the control database and every target's directory sit under
 * it. There is deliberately no in-memory default any more — the layout is a filesystem
 * guarantee, and an in-memory fleet would be a different thing wearing the same name.
 * The default is under the gitignored `.runtime/`.
 */
const HUNT_ROOT =
  process.env["HUNT_ROOT"] ?? join(process.cwd(), ".runtime", "hunt");
const PORT = Number(process.env["PORT"] ?? 3000);

/**
 * The only directory the browser's folder picker may look inside.
 *
 * Configuration, and the perimeter of Day 3's boundary: "the folder picker runs
 * server-side. The browser never reads the filesystem." A browser can narrow its view of
 * this root by browsing into it, and can never widen it — every refusal is recorded on
 * `http/folders.ts`. `realpath`'d once here so that a root which is itself a symlink (a
 * bind-mounted home, `/tmp` on some systems) does not make every path inside it look like
 * a link out of the root.
 *
 * The default is the operator's home directory, because that is where the folders a local
 * single-operator tool is pointed at actually live. It is not the fleet root: the fleet
 * root holds what we recorded, and the picker is for choosing what to record *about*.
 */
const WORKSPACE_ROOT = resolveRoot(
  process.env["WORKSPACE_ROOT"] ?? process.env["HOME"] ?? process.cwd(),
);

const fleet = FleetStore.layer(HUNT_ROOT);

/**
 * Brings the fleet up to date.
 *
 * It no longer registers anything. This used to create `TARGET_ID` if the registry did not
 * hold it, which made a first boot against an empty fleet produce a target nobody asked
 * for — and made the designed "first run, no targets" screen unreachable against a real
 * server. Targets are created by an operator through `POST /api/v1/targets`, which is the
 * only path that asks which folder the engagement is about.
 *
 * What is left is the sweep, and its partial-failure policy: a target whose file does not
 * migrate is marked unavailable and refused by name while its neighbours are served. The
 * reasoning and its cost are recorded on `persistence/fleet.ts`.
 */
const prepareFleet = Effect.gen(function* () {
  const store = yield* FleetStore;

  // The server password, before anything is served. Generated on the first boot against
  // this fleet root, stored in `control.sqlite` as an argon2id hash, and printed here
  // exactly once — nothing keeps the plaintext, so nothing can print it again. The
  // reasoning, including why this is not an environment variable, is on
  // `http/browserSessions.ts`.
  const password = yield* ensureServerPassword;
  if (password.generated !== undefined) {
    console.log("");
    console.log(
      "  a server password has been generated for this installation:",
    );
    console.log("");
    console.log(`      ${password.generated}`);
    console.log("");
    console.log(
      "  it is printed once and is not recoverable. the browser app asks for it on connect.",
    );
    console.log("");
  }

  const swept = yield* store.migrateFleet();
  console.log(`fleet: ${String(swept.length)} target(s) in ${HUNT_ROOT}`);
  if (swept.length === 0) {
    console.log(
      "  no targets are registered yet; the browser app's New target dialog is how the first one is created",
    );
  }
  for (const outcome of swept) {
    console.log(
      `  ${outcome.targetId}: ${outcome.state}` +
        ` (schema ${outcome.appliedThrough ?? "unknown"}) — ${outcome.detail}`,
    );
  }
  const unavailable = swept.filter((outcome) => outcome.state !== "ready");
  if (unavailable.length > 0) {
    // Loud, and not fatal. The policy and its cost are recorded on `fleet.ts`: one
    // unreadable file must not stop work on an unrelated engagement, and the targets it
    // does affect are refused by name rather than served as empty graphs.
    console.error(
      `fleet: ${String(unavailable.length)} target(s) unavailable until a forward migration fixes them: ${unavailable
        .map((outcome) => outcome.targetId)
        .join(", ")}`,
    );
  }
});

/**
 * The one per-target store resolver in this process.
 *
 * One instance, because it caches open database handles: a second resolver would be a
 * second set of connections to the same files, and a SQLite file has one write lock to
 * share. Everything that needs a target's store — the browser API per request, the MCP
 * route for the length of the process — takes it from here.
 */
const targetStores = TargetStores.layer.pipe(Layer.provide(fleet));

/**
 * The MCP credential registry, as one layer shared by everything that needs it.
 *
 * It was built inline where the listener was composed, which was fine while the listener
 * was the only thing that touched it. The supervisor mints credentials now and the
 * reconciler revokes them, so a second `McpCredentials.layer` anywhere in this graph would
 * be a second in-memory map — and a token minted in one would be unknown to the other,
 * which is a `401` that no amount of reading the code would explain.
 */
const credentials = McpCredentials.layer;

/**
 * Where a worker calls back into, answered once the listener exists.
 *
 * The cycle this breaks is recorded on {@link WorkerEndpoints}: the browser API needs the
 * supervisor, the supervisor needs these URLs — the MCP endpoint for the credential it
 * hands the harness, and the policy endpoint for the gate it installs into the workspace
 * — and both belong to the listener the browser API is merged onto. `publish` is called
 * in `program` below, before anything else, so the gap between the listener accepting
 * requests and workers being able to be told where to call back is as small as this
 * process can make it.
 */
const workerEndpoints = WorkerEndpoints.pending();

/**
 * Which agent harness this process drives, from `HARNESS`.
 *
 * Read once, here, and reported in the startup log, because a server that silently drove a
 * different agent than the operator named would be writing provenance nobody could trust.
 * The mapping, including why an unset variable still means OpenCode and why a typo is not
 * a fallback, is on `run/model.ts`.
 */
const SELECTED_HARNESS = harnessSelection(process.env["HARNESS"]);

/**
 * The OpenCode harness: an `opencode serve` this process owns, and a client over it.
 *
 * Spawned with `WORKSPACE_ROOT` as its working directory rather than the fleet root,
 * because the fleet root holds what we recorded and the harness should be nowhere near it
 * by default. Which directory a *run* happens in is a per-session decision — the
 * engagement's own folder, from the target's registry row — so this only sets where the
 * server process itself starts and where it discovers its configuration.
 *
 * The server runs as the user and so reads the user's own stored provider credentials; we
 * never read, copy or pass those (DECISIONS.md §12).
 */
const openCode = openCodeHarness().pipe(
  Layer.provideMerge(OpenCodeServer.layer({ cwd: WORKSPACE_ROOT })),
);

/**
 * The Claude Code harness, over the Claude Agent SDK.
 *
 * **No process of ours, and no `cwd` here.** The SDK spawns and owns the CLI per session,
 * and the directory is a per-session argument, so this layer has nothing of
 * `OpenCodeServer`'s shape to set up — which is exactly the asymmetry
 * `harness/agentHarness.ts` refuses to put on the interface. It reads the user's own
 * Claude Code login, the same way `opencode serve` reads theirs.
 */
const claudeCode = claudeCodeHarness();

/**
 * The layer for the selected driver, or `undefined` when there is nothing to build.
 *
 * Annotated rather than inferred: the two branches have different error channels — only
 * OpenCode's can fail, with a `HarnessProcessError` from spawning its child — and the
 * recovery below has to be written against the wider of the two.
 */
const selectedHarness:
  Layer.Layer<AgentHarness, HarnessProcessError> | undefined =
  SELECTED_HARNESS._tag !== "driver"
    ? undefined
    : SELECTED_HARNESS.driver === OPENCODE_DRIVER
      ? openCode
      : SELECTED_HARNESS.driver === CLAUDE_CODE_DRIVER
        ? claudeCode
        : undefined;

/**
 * What this process can do without a harness: serve, sweep, reconcile, and refuse to run.
 *
 * `RunSupervisor.unavailable` refuses every start with `no_harness` and a sentence naming
 * the fix. `HarnessSessionStatus.fromAnswers({})` answers `missing` for every session id,
 * which is exactly what a process with no harness knows — and `missing` maps to
 * `uncertain`, never to `failed`. A server that guessed would be worse than one that
 * admits it cannot tell.
 */
const withoutHarness = Layer.mergeAll(
  RunSupervisor.unavailable,
  HarnessSessionStatus.fromAnswers({}),
);

/**
 * The supervisor and the recovery adapter, over a harness if there is one.
 *
 * **A harness that will not start is not fatal, and that is a decision.** `opencode` may be
 * missing, the wrong version or unauthenticated, and the Claude Agent SDK may be unable to
 * spawn its CLI; on any of those this process still has a job: serving the browser the
 * evidence earlier runs recorded, sweeping the fleet, and reconciling attempts a previous
 * process left unsettled. Refusing to boot would make a missing agent into an inability to
 * read what the agent already found.
 *
 * **The recovery covers the harness build and nothing else**, which is the whole shape of
 * this expression. `Layer.build` is wrapped in `Effect.result` — so a `HarnessProcessError`
 * from spawning or waiting for `opencode serve` is caught, and a failure or defect anywhere
 * *else* in this graph propagates and fails startup the way it should. The arrangement this
 * replaces put `Layer.catchCause` around the whole composed layer, after `targetStores`,
 * `credentials`, the narration bus and the MCP endpoint had been provided to it. A fault in
 * any of those was then reported to the operator as "no agent harness", with "install
 * opencode" as the suggested fix — a confidently wrong diagnosis for a bug in our own code,
 * leaving a server that silently refuses every run while the browser API keeps working
 * through its own path to the same services.
 *
 * Only typed failures are recovered from. A *defect* in the harness build is a bug in our
 * spawn path rather than a missing binary, and it still takes the process down, because
 * there is nothing an operator can usefully do about it and a server that hid it would be
 * harder to diagnose than one that stopped.
 *
 * The built context is handed on with `Layer.succeedContext`, so the harness's lifetime
 * belongs to this layer's scope: `Layer.build` acquires into the ambient build scope, and
 * `Layer.unwrap` satisfies that `Scope` requirement from it. For OpenCode that scope owns a
 * child process; for Claude Code it owns the open sessions' queries. The memo map is forked
 * from the ambient one, so nothing here is built twice.
 *
 * **Nothing below this line knows which harness it got**, and that is the point of the
 * slice. `RunSupervisor.layer` and `HarnessSessionStatus.layer` require `AgentHarness`, the
 * selection above is the only place a driver is named, and neither the supervisor nor
 * recovery can reach the other implementation to branch on it.
 *
 * `HARNESS=0` skips the attempt entirely, for an operator who wants the server without an
 * agent. An unrecognised `HARNESS` does the same and says so by name rather than falling
 * back to a harness the operator did not ask for.
 */
const agent =
  selectedHarness === undefined
    ? Layer.effectDiscard(
        SELECTED_HARNESS._tag === "unknown"
          ? Effect.logError(
              "HARNESS names a harness this build does not have, so this server will serve and reconcile but will refuse to start runs",
              {
                asked: SELECTED_HARNESS.value,
                known: [...KNOWN_DRIVERS, "0"].join(", "),
              },
            )
          : Effect.logInfo(
              "no agent harness (HARNESS=0): this server will serve and reconcile but will refuse to start runs",
            ),
      ).pipe(Layer.merge(withoutHarness))
    : Layer.unwrap(
        Effect.map(Effect.result(Layer.build(selectedHarness)), (built) =>
          built._tag === "Failure"
            ? Layer.effectDiscard(
                Effect.logWarning(
                  "no agent harness: the harness HARNESS names would not start, so this server will serve and reconcile but will refuse to start runs",
                  { detail: built.failure.message },
                ),
              ).pipe(Layer.merge(withoutHarness))
            : Layer.mergeAll(
                RunSupervisor.layer,
                HarnessSessionStatus.layer,
              ).pipe(
                Layer.provide(Layer.succeedContext(built.success)),
                Layer.provide(targetStores),
                Layer.provide(credentials),
                Layer.provide(RunNarrations.layer),
                Layer.provide(workerEndpoints.layer),
              ),
        ),
      );

/**
 * The listener, with the browser API's routes on it and the services it shares with the
 * rest of this process handed in as values rather than as layers.
 *
 * **This indirection fixes a real bug and closes a class of it, so it is worth reading
 * rather than skipping.** `ControlPlaneEndpoint` builds the router's application layer
 * through `HttpRouter.toWebHandler`, which builds it **in its own scope with its own memo
 * map** (`effect/src/http/HttpEffect.ts`, `toWebHandlerLayerWith`: it takes an optional
 * `memoMap` and is given none). So a layer *provided to* `extraRoutes` is built a second
 * time, independently of this graph — layer memoisation does not cross that boundary,
 * because the two builds do not share a memo map.
 *
 * That is why `ControlPlaneEndpoint.layer` yields its own services and re-provides them
 * with `Layer.succeed`: it is passing *instances* across the boundary rather than letting
 * them be rebuilt. Anything the browser API shares with the rest of the process has to
 * arrive the same way, and the failure when it does not is silent and bad.
 *
 * Observed against a live server before this was written. `browserApiRoutes` had
 * `Layer.provide(agent)`, so the supervisor the compose box started runs through was a
 * *second* instance with a *second* `McpCredentials` map. It minted a credential into its
 * own map; the MCP route's auth middleware resolved against this graph's. The harness
 * connected with a perfectly good token and was answered `401 unknown_or_expired`, so the
 * worker had no `record_observation` tool at all — and nothing failed loudly, because a
 * worker with no tools is a worker that simply never records anything. The same mechanism
 * was already giving the browser API its own `TargetStores`, which is a second set of
 * SQLite handles on the same files; the comment on `targetStores` claimed one instance per
 * process and was wrong before this slice touched it.
 *
 * `Layer.unwrap` over `Effect.context` is how the instances get in: the three services the
 * browser API shares are read out of *this* graph and handed to its routes as a context,
 * so there is exactly one of each in the process and the compose box drives the same
 * supervisor whose credentials the MCP route accepts.
 *
 * `BrowserSessions` is deliberately **not** in that set and is still provided inside. It
 * is shared with nothing, and keeping it there is what makes "nothing else in this process
 * can reach the browser session registry" true rather than merely intended; being built in
 * the inner memo map is harmless for a service only the guard uses. The MCP credentials
 * beside it are a separate service with a separate map, and neither resolver can see the
 * other's tokens.
 */
const endpoint = Layer.unwrap(
  Effect.map(
    Effect.context<FleetStore | TargetStores | RunSupervisor>(),
    (shared) =>
      ControlPlaneEndpoint.layer({
        policy: PERMISSIVE_POLICY,
        port: PORT,
        extraRoutes: browserApiRoutes({
          workspaceRoot: WORKSPACE_ROOT,
        }).pipe(
          Layer.provide(BrowserSessions.layer),
          Layer.provide(Layer.succeedContext(shared)),
          // `Layer.orDie` rather than a failure that propagates, and the reason is the
          // ordering below: `prepareFleet` has already opened and migrated
          // `control.sqlite` by the time this is built, so a `DatabaseError` here is not
          // "the control database is unmigratable" — that case has already failed startup
          // with its own message. It is the same file failing to open a second time, which
          // nothing in this process can report more usefully than a defect.
          Layer.orDie,
        ),
      }),
  ),
).pipe(
  Layer.provideMerge(credentials),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provide(targetStores),
);

/**
 * Startup reconciliation, now across the whole fleet rather than one target.
 *
 * This is a consequence of losing the pin, and it is a fix rather than a cost. The sweep
 * reads `attempts` out of a target's own `hunt.sqlite`, and this process used to hold
 * exactly one of those — so a process serving three engagements reconciled one of them and
 * left the other two's rows `running` forever, with their write fences never bumped. There
 * is no single `ObservationStore` to provide any more, so the only way to write this is
 * the right way: ask the registry what targets there are, and sweep each one's file.
 *
 * Archived targets are skipped. An archived engagement is one nobody is working on, so an
 * attempt row inside it is not a question about what is running now; opening its file to
 * ask would also undo the point of archiving it.
 *
 * **One target that will not open does not stop the others.** That is the fleet's
 * partial-failure policy (`persistence/fleet.ts`) applied to recovery: a refusal is logged
 * by name and the sweep carries on, because a missing folder in one engagement must not
 * leave another engagement's attempts unreconciled.
 *
 * It runs after the layer graph is built, so the listener is accepting while it works.
 * That window is narrower than it looks: this process mints credentials only through the
 * supervisor, and the supervisor cannot be asked for one until the MCP URL is published —
 * which happens on the line above the call to this.
 */
const reconcile = Effect.gen(function* () {
  if (process.env["RECONCILE_ON_START"] === "0") {
    console.log("startup reconciliation skipped (RECONCILE_ON_START=0)");
    return;
  }
  const registry = yield* FleetStore;
  const stores = yield* TargetStores;
  const rows = yield* registry.targets();
  let swept = 0;
  let total = 0;
  for (const row of rows) {
    if (row.archivedAt !== undefined) continue;
    const outcome = yield* Effect.result(
      Effect.scoped(
        Effect.flatMap(stores.open(row.targetId), (store) =>
          reconcileUnsettledAttempts().pipe(
            Effect.provideService(ObservationStore, store),
          ),
        ),
      ),
    );
    if (outcome._tag === "Failure") {
      console.error(
        `startup reconciliation: ${row.targetId} could not be reconciled — ${outcome.failure.message}`,
      );
      continue;
    }
    swept += 1;
    total += outcome.success.length;
    for (const entry of outcome.success)
      console.log(`  ${row.targetId}: ${renderReconciliation(entry)}`);
  }
  console.log(
    total === 0
      ? `startup reconciliation: no attempt was left running or uncertain across ${String(swept)} target(s)`
      : `startup reconciliation: ${String(total)} attempt(s) across ${String(swept)} target(s)`,
  );
});

const program = Effect.gen(function* () {
  const control = yield* ControlPlaneEndpoint;
  // Before reconciliation, deliberately. The listener is already accepting by the time
  // this runs, so the sooner the URL is answerable the smaller the window in which a start
  // would have to wait for it. Reconciliation can take as long as the harness takes to
  // answer about every unsettled attempt.
  yield* workerEndpoints.publish({
    mcp: control.mcpUrl,
    policy: control.policyUrl,
  });
  yield* reconcile;
  console.log(`bit control plane: ${control.healthUrl}`);
  console.log(`  mcp (bearer required):  ${control.mcpUrl}`);
  console.log(
    `  policy (unauthenticated): ${control.policyUrl} — gate installed per run, host scope: ${PERMISSIVE_POLICY.hostScope._tag}`,
  );
  console.log(`  browser api (session bearer): ${control.origin}${API_PREFIX}`);
  console.log(`  folder picker root: ${WORKSPACE_ROOT}`);
  // Which agent ran a run is provenance, so which agent this process *can* run is worth
  // one line at startup rather than a guess from the absence of an error.
  console.log(
    SELECTED_HARNESS._tag === "driver"
      ? `  harness: ${SELECTED_HARNESS.driver} (HARNESS)`
      : SELECTED_HARNESS._tag === "none"
        ? "  harness: none (HARNESS=0) — every run is refused"
        : `  harness: none — HARNESS='${SELECTED_HARNESS.value}' is not one of ${[...KNOWN_DRIVERS, "0"].join(", ")}`,
  );
  const supervisor = yield* RunSupervisor;
  const alreadyRunning = yield* supervisor.running;
  console.log(
    `  runs supervised right now: ${String(alreadyRunning.length)} (a fresh process supervises none; rows left by an old one are the sweep's)`,
  );
  yield* Effect.callback<void>((resume) => {
    const stop = () => resume(Effect.void);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return Effect.sync(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  });
});

// The fleet is prepared *before* the layer graph that opens a target's store is built,
// because `targetStoreLayer` asks the registry whether that target migrated and refuses
// it when nothing has swept it. Running the sweep as part of the same layer would make
// that ordering a matter of luck.
await Effect.runPromise(
  Effect.scoped(
    Effect.andThen(
      prepareFleet.pipe(Effect.provide(fleet)),
      program.pipe(
        Effect.provide(
          // The endpoint *requires* the three shared services now, because it hands them
          // to the browser API's routes as values rather than letting the router's own
          // build make its own copies. `provideMerge` satisfies that requirement and keeps
          // them reachable by `program`, which reconciles the fleet through the same
          // instances the browser and the MCP route use.
          Layer.provideMerge(
            endpoint,
            Layer.mergeAll(agent, targetStores, fleet),
          ),
        ),
      ),
    ),
  ),
);

/** Re-exported so the entrypoint's own dependencies are visible to a reader. */
export type { ObservationStore };
