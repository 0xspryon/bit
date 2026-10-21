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
 * What this entrypoint owns, in one scope, released in reverse on every exit including
 * `SIGINT`:
 *
 * 1. The store, which opens the database and brings the schema up to date before
 *    anything can read it.
 * 2. The listener.
 * 3. **Startup reconciliation**, before any work is dispatched. Attempts left `running`
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
 * The MCP route is served here with no credentials issued, which is correct and worth
 * being explicit about: credentials are minted per attempt by whatever dispatches work,
 * so until something does, every MCP request to this process is a `401`. An empty
 * credential registry is a closed door, not an open one.
 */
import { Effect, Layer } from "effect";

import { ControlPlaneEndpoint } from "./http/controlPlane";
import { McpCredentials } from "./mcp/credentials";
import { McpCallCounter } from "./mcp/server";
import { ObservationStore } from "./persistence/store";
import { DEFAULT_POLICY, PolicyDecisions } from "./policy/service";
import { HarnessSessionStatus } from "./recovery/harnessStatus";
import {
  reconcileUnsettledAttempts,
  renderReconciliation,
} from "./recovery/reconcile";

const DATABASE_PATH = process.env["DATABASE_PATH"] ?? ":memory:";
const PORT = Number(process.env["PORT"] ?? 3000);

const store = ObservationStore.layer(DATABASE_PATH);

const endpoint = ControlPlaneEndpoint.layer({
  policy: DEFAULT_POLICY,
  port: PORT,
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

await Effect.runPromise(
  Effect.scoped(
    program.pipe(
      Effect.provide(Layer.mergeAll(endpoint, store, harnessStatus)),
    ),
  ),
);
