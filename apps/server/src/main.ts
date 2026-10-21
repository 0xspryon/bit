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
 * **This process serves one target at a time**, named by `TARGET_ID` and registered on
 * demand if the registry does not hold it. That is a deliberate stop short of what the
 * layout allows: dispatching an MCP request to the right target's store needs a
 * per-target store resolver at the mutation boundary, and the only reason to build one is
 * to run work against several targets at once — which is concurrency, and is not this
 * sprint. What the layout buys today is real regardless: separate files, provable
 * deletion, a per-target sequence, and no query path from one target's connection to
 * another's rows.
 *
 * What this entrypoint owns, in one scope, released in reverse on every exit including
 * `SIGINT`:
 *
 * 1. The fleet: the control database, migrated, and the registry sweep across targets.
 * 2. The served target's store, which brings its own schema up to date before anything
 *    can read it.
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
import { McpCredentials } from "./mcp/credentials";
import { McpCallCounter } from "./mcp/server";
import { FleetStore, targetStoreLayer } from "./persistence/fleet";
import { ObservationStore } from "./persistence/store";
import { DEFAULT_POLICY, PolicyDecisions } from "./policy/service";
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
const TARGET_ID = process.env["TARGET_ID"] ?? "fixture-local";
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
 * Brings the fleet up to date and makes sure the served target is registered.
 *
 * Registration is idempotent in effect rather than by `ON CONFLICT`: `register` refuses a
 * duplicate id, which is right — an id is a directory of somebody's evidence — so this
 * asks first. The scope note is a placeholder an operator is expected to replace; it is
 * advisory prose and never enforcement (§4's `task_constraints` layer).
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

  const existing = yield* store.target(TARGET_ID);
  if (existing === undefined) {
    yield* store.register({
      targetId: TARGET_ID,
      name: TARGET_ID,
      scopeNote:
        "Registered automatically at startup. Replace this with the engagement's own scope note.",
    });
    console.log(`registered target ${TARGET_ID} in ${HUNT_ROOT}`);
  }
  const swept = yield* store.migrateFleet();
  console.log(`fleet: ${String(swept.length)} target(s) in ${HUNT_ROOT}`);
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

const store = targetStoreLayer(TARGET_ID).pipe(Layer.provide(fleet));

/**
 * The browser API, resolved down to the router it will be registered on.
 *
 * Everything it needs is provided here — the fleet registry it reads targets out of and
 * the browser session registry its guard resolves against — so what reaches the control
 * plane is a layer with one requirement left: `HttpRouter`. That is what lets it share
 * the listener without this entrypoint knowing how the control plane builds its router,
 * and without the control plane knowing what a target is.
 *
 * The session registry is provided to the API and *not* merged outward, so nothing else
 * in this process can reach it. The MCP credentials next to it are a separate service
 * with a separate map; neither resolver can see the other's tokens.
 */
const browserApi = browserApiRoutes({ workspaceRoot: WORKSPACE_ROOT }).pipe(
  Layer.provide(BrowserSessions.layer),
  Layer.provide(fleet),
  // `Layer.orDie` rather than a failure that propagates, and the reason is the ordering
  // below: `prepareFleet` has already opened and migrated `control.sqlite` by the time
  // this layer is built, so a `DatabaseError` here is not "the control database is
  // unmigratable" — that case has already failed startup with its own message. It is the
  // same file failing to open a second time, which nothing in this process can report
  // more usefully than a defect.
  Layer.orDie,
);

const endpoint = ControlPlaneEndpoint.layer({
  policy: DEFAULT_POLICY,
  port: PORT,
  extraRoutes: browserApi,
}).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provide(store),
);

/**
 * The harness this process can ask about an abandoned session: none.
 *
 * `fromAnswers({})` answers `missing` for every session id, which is exactly what a
 * process with no harness knows — and `missing` maps to `uncertain`, never to `failed`.
 * A server that guessed would be worse than one that admits it cannot tell. A deployment
 * that owns a harness provides `HarnessSessionStatus.layer` instead and gets real
 * answers from it.
 */
const harnessStatus = HarnessSessionStatus.fromAnswers({});

const reconcile = Effect.gen(function* () {
  if (process.env["RECONCILE_ON_START"] === "0") {
    console.log("startup reconciliation skipped (RECONCILE_ON_START=0)");
    return;
  }
  const reconciled = yield* reconcileUnsettledAttempts();
  if (reconciled.length === 0) {
    console.log(
      "startup reconciliation: no attempt was left running or uncertain",
    );
    return;
  }
  console.log(
    `startup reconciliation: ${String(reconciled.length)} attempt(s)`,
  );
  for (const entry of reconciled)
    console.log(`  ${renderReconciliation(entry)}`);
});

const program = Effect.gen(function* () {
  yield* reconcile;
  const control = yield* ControlPlaneEndpoint;
  console.log(`bit control plane: ${control.healthUrl}`);
  console.log(`  mcp (bearer required):  ${control.mcpUrl}`);
  console.log(`  policy (unauthenticated): ${control.policyUrl}`);
  console.log(`  browser api (session bearer): ${control.origin}${API_PREFIX}`);
  console.log(`  folder picker root: ${WORKSPACE_ROOT}`);
  console.log(`  serving target: ${TARGET_ID}`);
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
        Effect.provide(Layer.mergeAll(endpoint, store, harnessStatus)),
      ),
    ),
  ),
);

/** Re-exported so the entrypoint's own dependencies are visible to a reader. */
export type { ObservationStore };
