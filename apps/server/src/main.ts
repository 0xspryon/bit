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
import { Effect, Latch, Layer } from "effect";

import { browserApiRoutes } from "./http/browserApi";
import {
  BrowserSessions,
  PASSWORD_ENV_VAR,
  ensureServerPassword,
  takeConfiguredPassword,
} from "./http/browserSessions";
import { ControlPlaneEndpoint } from "./http/controlPlane";
import { resolveRoot } from "./http/folders";
import { AgentHarness } from "./harness/agentHarness";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  claudeCodeHarness,
} from "./harness/claudeCodeClient";
import type { HarnessProcessError } from "./harness/errors";
import {
  CLAUDE_CODE_DRIVER,
  OPENCODE_DRIVER,
  defaultInstanceIdForDriver,
} from "./harness/identity";
import {
  OPENCODE_DEFAULT_MODEL,
  openCodeHarness,
} from "./harness/openCodeClient";
import { OpenCodeServer } from "./harness/openCodeServer";
import {
  ownedProcessDirectory,
  reapNeedsAttention,
  reapOwnedProcesses,
  renderReapOutcome,
} from "./harness/ownedProcesses";
import {
  HarnessResolver,
  harnessResolverLayer,
  type HarnessCandidate,
} from "./harness/resolver";
import { McpCredentials } from "./mcp/credentials";
import { McpCallCounter } from "./mcp/server";
import { FleetStore } from "./persistence/fleet";
import { ObservationStore } from "./persistence/store";
import { TargetStores } from "./persistence/targetStores";
import { PERMISSIVE_POLICY, PolicyDecisions } from "./policy/service";
import { harnessSelection, renderSelection, KNOWN_DRIVERS } from "./run/model";
import { RunNarrations } from "./run/narration";
import { RunSupervisor, WorkerEndpoints } from "./run/supervisor";
import { HarnessSessionStatus } from "./recovery/harnessStatus";
import {
  reconcileUnsettledAttempts,
  releaseOrphanedClaims,
  renderReleasedClaim,
  renderReconciliation,
} from "./recovery/reconcile";

/**
 * Opened when this process is asked to stop. Armed **at module scope**, before any of the
 * slow work starts.
 *
 * The registration used to sit at the end of {@link program}, after the migrations, the
 * harness resolution and the startup reconciliation — so for that whole window there was
 * no handler of ours and a signal was answered by the platform's default, which
 * terminates the process without running a single finalizer in this file. Measured, that
 * is survivable today: a `SIGINT` during boot leaves no `opencode serve` behind, because
 * the child dies with the process that spawned it. What it is not is *this file's*
 * shutdown path. Arming here means one mechanism answers a stop at every moment of the
 * process's life — the scope unwinds, the listener closes, the harness child is killed by
 * the finalizer that owns it — rather than two, one of which bypasses all of that and
 * happens to get away with it.
 *
 * **A latch rather than a callback, because a latch remembers.** A signal that arrives
 * while the layer graph is still building opens it, and the `await` at the end of
 * {@link program} then returns at once instead of waiting for a second signal the
 * operator has no reason to think is needed. A one-shot `process.once` handler had
 * nowhere to hold that fact.
 *
 * `makeUnsafe` and `openUnsafe` are the synchronous pair, which is what lets this live
 * outside an effect: a signal handler runs on the platform's stack rather than in a
 * fiber, so opening the latch has to be something a plain function can do.
 *
 * **Listeners do not pile up across a watch restart**, which is worth stating because
 * `bun --watch` reuses the pid — `reapOrphanedHarnesses` below exists because of that, so
 * the assumption is not free here. Measured: a restarted context reads
 * `process.listenerCount("SIGINT") === 0` before it registers, so Bun drops them with the
 * old context and every boot starts from none.
 */
const shutdownRequested = Latch.makeUnsafe(false);
const requestShutdown = () => {
  shutdownRequested.openUnsafe();
};
process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);

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
 * The configured server password, read and **removed from this process's environment**
 * at module scope.
 *
 * Deliberately the first thing this file does with the environment, and deliberately not
 * inside an effect: it has to happen before anything can spawn a child, and a child
 * inherits what is in `process.env` at the moment it is spawned. The reasoning is on
 * `http/browserSessions.ts`; the short version is that the child here is an agent running
 * model-chosen shell commands, and `env` is a command.
 */
const CONFIGURED_PASSWORD = takeConfiguredPassword();

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
 * Where this installation records the OS processes it owns.
 *
 * Derived from {@link HUNT_ROOT} rather than fixed, which is the whole of the scoping
 * property: two servers on two fleet roots record into two directories, so neither
 * installation's startup sweep can see — let alone kill — the other's children.
 */
const OWNED_PROCESSES = ownedProcessDirectory(HUNT_ROOT);

/**
 * Ends `opencode serve` processes a previous run of this process left behind.
 *
 * It exists because of one measured fact: `bun --watch` restarts us *in place*, reusing
 * the pid, and tears the old JavaScript context down in the same tick as the `SIGTERM` it
 * sends itself. The handler's synchronous body runs and then nothing asynchronous ever
 * does — no timer, no microtask — so the scope finalizer that owns the harness child never
 * gets a turn, and every edit under `apps/server/src` used to leave a live
 * `opencode serve` behind. They accumulated until a fresh one could not answer
 * `/api/info` inside its readiness bound, at which point the model picker degraded to a
 * single entry: a symptom nowhere near its cause. The reasoning, the measurement and the
 * identity check that keeps this from being worse than the leak are on
 * `harness/ownedProcesses.ts`.
 *
 * **Before anything of ours is spawned**, because the record is scoped to the installation
 * rather than to a process: a sweep running after the harness layer was built would find
 * our own live child and have no way to tell it from an orphan.
 *
 * Quiet when there is nothing to do, and never fatal. A boot that cannot tidy up is
 * untidy; a boot that refuses because it could not tidy up is unusable.
 */
const reapOrphanedHarnesses = Effect.gen(function* () {
  const outcomes = yield* reapOwnedProcesses(OWNED_PROCESSES);
  if (outcomes.length === 0) return;
  console.log(
    `harness processes: ${String(outcomes.length)} record(s) left by a previous run of this process`,
  );
  for (const outcome of outcomes) {
    const line = `  ${renderReapOutcome(outcome)}`;
    if (reapNeedsAttention(outcome)) console.error(line);
    else console.log(line);
  }
});

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

  // The server password, before anything is served. `BIT_PASSWORD` wins if it is set;
  // otherwise one is generated on the first boot against this fleet root, stored in
  // `control.sqlite` as an argon2id hash, and printed here exactly once — nothing keeps
  // the plaintext, so nothing can print it again. Why the variable is read and deleted
  // before anything spawns a child is on `http/browserSessions.ts`.
  const password = yield* ensureServerPassword(CONFIGURED_PASSWORD);
  if (CONFIGURED_PASSWORD !== undefined) {
    console.log(`server password: taken from ${PASSWORD_ENV_VAR}`);
  }
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
 * The mapping — including why an unset variable now means *every* driver this build has,
 * and why a typo is still not a fallback — is on `run/model.ts`.
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
const openCode: Layer.Layer<AgentHarness, HarnessProcessError> =
  openCodeHarness().pipe(
    Layer.provide(
      OpenCodeServer.layer({
        cwd: WORKSPACE_ROOT,
        recordDirectory: OWNED_PROCESSES,
      }),
    ),
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
const claudeCode: Layer.Layer<AgentHarness, HarnessProcessError> =
  claudeCodeHarness();

/**
 * Everything this build can be asked to drive, as resolver candidates.
 *
 * **This is the only place in the process where a driver is named.** The resolver takes
 * the list, brings each one up, and nothing downstream can enumerate them: the supervisor
 * asks it for one harness per run and the recovery adapter asks it for one per attempt.
 *
 * `placeholder` is the row an operator reads when the candidate does not build — a harness
 * that failed never got far enough to report its own `HarnessInstance`, and it still has to
 * be visible with a reason rather than silently missing. `setup` is what to do about it,
 * and it lives here because only this module knows which binary or which package a
 * candidate came from.
 */
const CANDIDATES: readonly HarnessCandidate[] = [
  {
    driver: OPENCODE_DRIVER,
    displayName: "OpenCode",
    layer: openCode,
    setup:
      "Install `opencode` and make sure it is on this server's PATH, then log into a provider with `opencode auth login`.",
    placeholder: {
      instanceId: defaultInstanceIdForDriver(OPENCODE_DRIVER),
      driver: OPENCODE_DRIVER,
      displayName: "OpenCode",
      version: "unknown",
      // The one place `installed: false` is ever reported: the harness did not come up, so
      // this process is not holding one. Everything that *does* come up reports `true`.
      installed: false,
      auth: "unknown",
      defaultModel: OPENCODE_DEFAULT_MODEL,
      // One entry and no option descriptors: a harness that never came up reported no
      // catalogue, so there is nothing it can be asked about either.
      models: [{ id: OPENCODE_DEFAULT_MODEL }],
    },
  },
  {
    driver: CLAUDE_CODE_DRIVER,
    displayName: "Claude Code",
    layer: claudeCode,
    setup:
      "Install or upgrade `@anthropic-ai/claude-agent-sdk` in this server, and log in with `claude` once so it has a session to read.",
    placeholder: {
      instanceId: defaultInstanceIdForDriver(CLAUDE_CODE_DRIVER),
      driver: CLAUDE_CODE_DRIVER,
      displayName: "Claude Code",
      version: "unknown",
      installed: false,
      auth: "unknown",
      defaultModel: CLAUDE_CODE_DEFAULT_MODEL,
      models: [{ id: CLAUDE_CODE_DEFAULT_MODEL }],
    },
  },
];

/** The candidates `HARNESS` asked for, in the order it asked for them. */
const configured: readonly HarnessCandidate[] =
  SELECTED_HARNESS.drivers.flatMap((driver) => {
    const candidate = CANDIDATES.find((entry) => entry.driver === driver);
    return candidate === undefined ? [] : [candidate];
  });

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
  // An empty resolver rather than no resolver, so the shape of this graph does not depend
  // on whether a harness was configured: the browser's picker asks the same service either
  // way and gets an empty list, which is the true answer.
  HarnessResolver.empty,
  // Same reasoning one service along: the live transcript subscribes to this bus whether or
  // not anything can publish to it, and a graph whose *shape* changed with `HARNESS` would
  // make a watcher on a harness-less server a compile-time special case rather than a
  // stream that is simply quiet.
  RunNarrations.layer,
);

/**
 * The resolver, the supervisor and the recovery adapter.
 *
 * **A harness that will not start is not fatal — now per instance rather than per
 * process.** `opencode` may be missing, the wrong version or unauthenticated, and the
 * Claude Agent SDK may carry a build too old to fail its policy hook closed; on any of
 * those this process still has a job: serving the browser the evidence earlier runs
 * recorded, sweeping the fleet, and reconciling attempts a previous process left unsettled.
 * Refusing to boot would make a missing agent into an inability to read what the agent
 * already found.
 *
 * What is new is that one failing candidate no longer takes the other down with it, and no
 * longer leaves the server looking harness-less. `harness/resolver.ts` builds each
 * candidate, keeps the ones that worked, and keeps the rest **visible in the picker with
 * the reason they gave** — which is the only way a two-instance installation is usable on a
 * machine that has one of the two installed. That module also owns the rule about defects:
 * a typed `HarnessProcessError` becomes a reason, and a defect still takes the process
 * down, because it is a bug in our spawn path rather than something an operator can fix.
 *
 * `RunSupervisor.unavailable` is still here for the one case it is right for: `HARNESS=0`,
 * or a `HARNESS` naming only drivers this build does not have. Those are *no instances*
 * rather than unusable ones, and `no_harness` with "name one in HARNESS" is the honest
 * refusal. A server with configured-but-broken instances builds the real supervisor
 * instead, so each start is refused `harness_not_ready` naming the instance and what it
 * said — which is more use than "this server has no agent harness".
 *
 * **Nothing below this line knows which harness it got**, and that is still the point.
 * `RunSupervisor.layer` and `HarnessSessionStatus.layer` require `HarnessResolver`, the
 * candidate list above is the only place a driver is named, and neither the supervisor nor
 * recovery can reach an implementation to branch on it: the supervisor is handed one
 * `AgentHarness` per run and the recovery adapter one per attempt.
 */
const agent =
  configured.length === 0
    ? Layer.effectDiscard(
        SELECTED_HARNESS.off
          ? Effect.logInfo(
              "no agent harness (HARNESS=0): this server will serve and reconcile but will refuse to start runs",
            )
          : Effect.logError(
              "HARNESS names no harness this build has, so this server will serve and reconcile but will refuse to start runs",
              {
                asked: SELECTED_HARNESS.unknown.join(", "),
                known: [...KNOWN_DRIVERS, "0"].join(", "),
              },
            ),
      ).pipe(Layer.merge(withoutHarness))
    : Layer.mergeAll(RunSupervisor.layer, HarnessSessionStatus.layer).pipe(
        // One resolver for the process, provided to both: a second would be a second set
        // of built harnesses, which for OpenCode means a second child process.
        Layer.provideMerge(harnessResolverLayer(configured)),
        Layer.provide(targetStores),
        Layer.provide(credentials),
        // `provideMerge`, so the bus the supervisor publishes to is also in this graph's
        // context and can be handed to the browser API below. With `provide` it was the
        // supervisor's private dependency, which was right while nothing subscribed.
        Layer.provideMerge(RunNarrations.layer),
        Layer.provide(workerEndpoints.layer),
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
    Effect.context<
      | FleetStore
      | TargetStores
      | RunSupervisor
      | HarnessResolver
      // The narration bus, for the same reason as the four above and with the same
      // consequence if it were rebuilt instead: the supervisor would publish into one
      // `PubSub` and the live transcript would subscribe to another, so a run would narrate
      // to nobody and the transcript would show the record and never the activity.
      | RunNarrations
    >(),
    (shared) =>
      ControlPlaneEndpoint.layer({
        policy: PERMISSIVE_POLICY,
        port: PORT,
        extraRoutes: browserApiRoutes({
          workspaceRoot: WORKSPACE_ROOT,
        }).pipe(
          Layer.provide(
            CONFIGURED_PASSWORD === undefined
              ? BrowserSessions.layer
              : BrowserSessions.layerWithPassword(CONFIGURED_PASSWORD),
          ),
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

/**
 * Gives back intent claims a dead process left with no attempt to settle them.
 *
 * Fleet-wide and with the attempt sweep's partial-failure policy: a target that will not open
 * is logged by name and the rest are still done. **It runs before the worker endpoints are
 * published, and that ordering is the whole safety argument.** A live claim and an orphan
 * look alike to it (a claim with no attempt row), and `RunSupervisor.start` waits for these
 * endpoints *before* it claims an intent, so until they are published no start in this
 * process holds a claim for it to take. Publish them earlier, or run this later, and a
 * start's claim can be returned to `open` from under it. Requests that arrive in the
 * meantime are held, not refused.
 */
const releaseOrphans = Effect.gen(function* () {
  if (process.env["RECONCILE_ON_START"] === "0") return;
  const registry = yield* FleetStore;
  const stores = yield* TargetStores;
  const rows = yield* registry.targets();
  let total = 0;
  for (const row of rows) {
    if (row.archivedAt !== undefined) continue;
    const outcome = yield* Effect.result(
      Effect.scoped(
        Effect.flatMap(stores.open(row.targetId), (store) =>
          releaseOrphanedClaims().pipe(
            Effect.provideService(ObservationStore, store),
          ),
        ),
      ),
    );
    if (outcome._tag === "Failure") {
      console.error(
        `startup reconciliation: ${row.targetId} intent claims could not be reconciled — ${outcome.failure.message}`,
      );
      continue;
    }
    total += outcome.success.length;
    for (const claim of outcome.success)
      console.log(`  ${row.targetId}: ${renderReleasedClaim(claim)}`);
  }
  if (total > 0) {
    console.log(
      `startup reconciliation: ${String(total)} intent claim(s) released`,
    );
  }
});

const program = Effect.gen(function* () {
  const control = yield* ControlPlaneEndpoint;
  // First, and before the URL below is published; see `releaseOrphans`.
  yield* releaseOrphans;
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
  console.log(`  harness (HARNESS): ${renderSelection(SELECTED_HARNESS)}`);
  // What an operator actually gets, which is not the same list: a configured instance that
  // would not start is reported here with its reason rather than left to be discovered by
  // a refused run.
  const resolver = yield* HarnessResolver;
  for (const listing of resolver.instances) {
    console.log(
      `    ${listing.instance.instanceId}: ${
        listing.status === "ready"
          ? `ready, ${listing.instance.version}, ${String(listing.instance.models.length)} model(s), default ${listing.instance.defaultModel}${listing.isDefault ? " — this server's default instance" : ""}`
          : `unusable — ${listing.reason ?? "no reason given"}`
      }`,
    );
  }
  if (resolver.defaultInstanceId === undefined) {
    console.log(
      "    no harness instance is usable, so every run is refused by name",
    );
  }
  const supervisor = yield* RunSupervisor;
  const alreadyRunning = yield* supervisor.running;
  console.log(
    `  runs supervised right now: ${String(alreadyRunning.length)} (a fresh process supervises none; rows left by an old one are the sweep's)`,
  );
  // Already open if the signal landed while we were still booting, in which case this
  // returns straight away. See `shutdownRequested`.
  yield* shutdownRequested.await;
});

// Three steps, in an order that is load-bearing at both joints.
//
// Orphaned harness processes go **first**, before anything of ours is spawned: the record
// they are found in is scoped to the installation, not to a process, so a sweep running
// any later would see this process's own child and be unable to tell it from a leak.
//
// The fleet is then prepared *before* the layer graph that opens a target's store is
// built, because `targetStoreLayer` asks the registry whether that target migrated and
// refuses it when nothing has swept it. Running the sweep as part of the same layer would
// make that ordering a matter of luck.
await Effect.runPromise(
  Effect.scoped(
    // `raceFirst`, so a signal arriving mid-boot interrupts the boot instead of being
    // acted on once it finishes: the loser is interrupted either way, and the scope this
    // sits inside still releases in reverse, so the listener closes and the harness child
    // is killed exactly as they are on a settled exit. `raceFirst` rather than `race`
    // because a boot that *fails* has to surface now — `race` would wait for the other
    // side, and the other side is a latch that nothing is going to open.
    Effect.raceFirst(
      Effect.andThen(
        Effect.andThen(
          reapOrphanedHarnesses,
          prepareFleet.pipe(Effect.provide(fleet)),
        ),
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
      shutdownRequested.await,
    ),
  ),
);

/**
 * Ends the process, because finishing the work is not the same thing as finishing. **This
 * line is the one that fixes the reported hang**; the latch above is what makes the path
 * into it the same at every moment of a boot.
 *
 * **The scope is already released by the time this runs** — the listener is closed, the
 * harness child is killed, the databases are shut. Measured after a `SIGINT` under
 * `bun --watch`: the health route refuses the connection and the `opencode serve` child is
 * gone, while the process itself is still there, indefinitely. So this is not a way of
 * skipping cleanup; cleanup has already happened and nobody has left.
 *
 * What keeps it there is `bun --watch`, which holds the process open after the module
 * settles so it can re-run it on the next edit — measured on its own: a script that merely
 * logs and returns exits under `bun` and lingers under `bun --watch`. That is exactly what
 * a watcher is for, and it is wrong once we have been asked to stop. `turbo` is waiting on
 * this task to end, so a server that had shut down but never exited is a `dev` task that
 * never finishes: what the operator sees is `turbo` re-printing `1 task shutting down`
 * until a second `Ctrl+C` makes it force-kill us. The hang was a completed shutdown that
 * nobody had exited.
 *
 * Unconditional rather than `if (watching)`, because there is nothing to detect and nothing
 * to lose: under plain `bun` the process was going to exit here anyway, and this only says
 * so. `0` because arriving here *is* the successful path — the only way out of the race
 * above is a signal we asked for or a boot that failed, and a failed boot rejects the
 * promise rather than reaching this line.
 */
console.log("bit control plane: stopped");
process.exit(0);

/** Re-exported so the entrypoint's own dependencies are visible to a reader. */
export type { ObservationStore };
