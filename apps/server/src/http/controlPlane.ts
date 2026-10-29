/**
 * The one HTTP listener this control plane serves.
 *
 * There were two listeners and, in a separate process, a third hand-written one: the MCP
 * endpoint the worker calls back into, the policy endpoint the harness-side hook
 * consults before a tool runs, and `main.ts`'s own `Bun.serve` answering the health
 * route out of a bare `fetch` callback. They are one listener now — one port, one origin
 * policy, one shutdown path, one base URL to hand out — and `main.ts` serves *this*
 * rather than a second composition of its own.
 *
 * **The routes keep their own postures, and that is the point of merging on a router
 * rather than in a `fetch` handler.** `McpServer.layerHttp` applies its bearer
 * middleware to the MCP protocol layer, not to the router, so:
 *
 * - `/api/v1/mcp` fails closed. No credential, an unknown one or an expired one is a
 *   `401` before any protocol handling, tool list or dispatch.
 * - `/api/v1/policy/decide` is deliberately unauthenticated, at the operator's
 *   direction. The reasoning and its cost are recorded on `policyRoutes` itself.
 * - `/api/v1/health` is unauthenticated and says one word. It is a liveness answer for
 *   the browser app and a proxy, and it deliberately reports nothing about the store,
 *   the harness or any attempt: a health endpoint that leaks internal state is a
 *   reconnaissance surface, and one that fails when a subsystem is degraded cannot be
 *   used to tell "the process is up" from "the database is slow".
 *
 * Sharing a port does not blur that: a request is routed by path first, and each route
 * carries whatever admission its own layer declared.
 *
 * **The browser-facing API arrives the same way**, through `extraRoutes`. It is declared
 * once in `@bit/contracts` with `effect/http-api` and implemented in `browserApi.ts`,
 * and it carries its own guard — `HttpApiMiddleware` with `HttpApiSecurity.bearer`,
 * resolved against the browser session registry, which is a *different* registry from the
 * MCP credentials this file's `/api/v1/mcp` route uses. The three routes below are not
 * re-posted through that API and are not wrapped by it: merging happens on the router, so
 * each route still carries only what its own layer declared.
 *
 * **The MCP route no longer carries one target's store.** It takes
 * {@link TargetStores} — the per-target resolver — and the tool handler reaches a store
 * with the target id its credential carries (`mcp/tools.ts`). What this file used to do
 * was yield one `ObservationStore` and provide it to the MCP application layer, which
 * meant every authenticated write in this process landed in whichever database the
 * entrypoint had resolved at startup. A caller with a single database and no fleet builds
 * the resolver over it with `TargetStores.ofStore`.
 *
 * **The fixture is not here, deliberately.** `fixture/server.ts` is the simulated target
 * under test and keeps its own listener. Putting it on this port would mean the worker
 * probing "the target" was probing the control plane's own origin, would collapse the
 * pretence that it is a third party, and would let a fixture fault take down the
 * endpoint the worker needs in order to record what it saw.
 *
 * What the router gives these routes over the two `Bun.serve` callbacks it replaces:
 * method handling, `415` on the wrong content type, `406` on the wrong accept header and
 * origin checks, none of which the hand-written policy handler did.
 */
import { LIVE_HEARTBEAT_SECONDS, apiPath, type Health } from "@bit/contracts";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { McpCredentials } from "../mcp/credentials";
import {
  MCP_PATH,
  PLANNER_MCP_PATH,
  McpCallCounter,
  mcpApplicationLayer,
} from "../mcp/server";
import type { PlannerHarnesses } from "../mcp/plannerTools";
import { TargetStores } from "../persistence/targetStores";
import {
  POLICY_DECIDE_PATH,
  PolicyDecisions,
  policyRoutes,
  type PolicyConfig,
  type PolicyDecision,
  type PolicyRequest,
} from "../policy/service";

/** The one path the health route answers on, under the shared API prefix. */
export const HEALTH_PATH = apiPath("health");

/**
 * Registers `GET {@link HEALTH_PATH}` on the ambient router.
 *
 * Built per request rather than once at registration: a response value is cheap, and a
 * handler that returns a shared instance invites a later edit to start mutating it.
 */
const healthRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      HEALTH_PATH,
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe({ status: "ok" } satisfies Health),
      ),
    );
  }),
);

/**
 * Extra routes to register on the same router.
 *
 * This is how the browser-facing `HttpApi` gets onto this listener: `main.ts` builds
 * `browserApiRoutes(...)`, provides it everything but the router, and hands it in. It is
 * a parameter rather than a merge inside this module for two reasons. The services those
 * routes need — the fleet registry, the browser session map — are not services this
 * endpoint has any other use for, and making them hard requirements would oblige every
 * existing caller (the spike demos, three test suites) to stand up a fleet in order to
 * serve `/api/v1/health`. And a caller that passes nothing gets exactly the three routes
 * this file has always served, which is what keeps the merge from changing what was
 * already here.
 *
 * The layer must already have everything resolved except the router and
 * {@link PolicyDecisions}. Whatever it registers carries its own admission posture;
 * nothing here wraps it, and it cannot wrap the three routes below.
 *
 * **Why {@link PolicyDecisions} is in this requirement and the other three are not.** This
 * endpoint passes four services across the router's own memo-map boundary with
 * `Layer.succeed` — see the body of {@link ControlPlaneEndpoint.layer} and `main.ts` on why
 * that boundary exists at all — and any of them *could* be left unprovided by a caller. Only
 * this one is declared, because only this one a caller has no other way to get: the
 * policy route and the browser API are the two halves of the gate's decisions, the route
 * publishes and the API subscribes, and they must be the same instance or one of them is
 * talking to a bus nobody is listening to. The other three are things a caller holds for
 * its own reasons anyway, and a caller that provides its own gets the one it meant.
 *
 * Anything else a route set needs — the narration bus, for one — is the caller's to hand in
 * the same way, with `Layer.succeedContext` over an instance read out of its own graph.
 * This endpoint does not know about those services and must not grow a list of them.
 */
/**
 * How long this listener lets a connection sit with no traffic before closing it, in
 * seconds.
 *
 * **This is not a tuning knob, it is an invariant, and leaving it unset was a bug a
 * browser found.** `Bun.serve`'s `idleTimeout` defaults to **10 seconds** and closes any
 * connection with no bytes in either direction for that long. A Server-Sent Events stream
 * watching a quiet target is exactly that: the live transcript sends a `LiveCursor` every
 * {@link LIVE_HEARTBEAT_SECONDS} and nothing in between, so the default closed the
 * connection at ten seconds — before the twenty-second heartbeat that was supposed to keep
 * it alive could fire. In a browser the transcript went dead after ten seconds on a target
 * with nothing running, and because the proxy in front of it kept the downstream response
 * open, nothing said so.
 *
 * It is **derived** from the heartbeat rather than written beside it, so the two cannot
 * drift: three times the heartbeat leaves room for a heartbeat to be late without the
 * listener giving up, and `LIVE_HEARTBEAT_SECONDS` is the contract's constant that the
 * stream itself also derives from. The floor of 30 keeps the ordinary request paths —
 * MCP, policy, the browser API — from inheriting a short timeout if the heartbeat is ever
 * shortened, and `Bun.serve` caps `idleTimeout` at 255 seconds, which is the other clamp.
 *
 * The invariant that matters, asserted in `browserApi.test.ts`:
 * `CONTROL_PLANE_IDLE_TIMEOUT > LIVE_HEARTBEAT_SECONDS`.
 */
export const CONTROL_PLANE_IDLE_TIMEOUT = Math.min(
  255,
  Math.max(30, LIVE_HEARTBEAT_SECONDS * 3),
);

export type ControlPlaneRoutes = Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | PolicyDecisions
>;

export interface ControlPlaneHandle {
  /** `http://127.0.0.1:<port>`, the one origin every route below sits on. */
  readonly origin: string;
  /** Where a **worker attempt**'s MCP client connects. `record_observation` is here. */
  readonly mcpUrl: string;
  /**
   * Where a **planner round**'s MCP client connects.
   *
   * A second URL rather than the same one, because the two endpoints advertise different
   * tool lists and each refuses the other's credential. `mcp/server.ts`'s header sets out
   * why the role boundary is a path *and* a grant check rather than a filter over one
   * toolkit.
   */
  readonly plannerMcpUrl: string;
  /** Where the harness-side policy hook posts. */
  readonly policyUrl: string;
  /** Liveness, on the same origin as the other two. */
  readonly healthUrl: string;
  /** Authenticated MCP requests served, for asserting the worker really reached us. */
  readonly callCount: Effect.Effect<number>;
  /** Policy decisions answered, in order. */
  readonly decisions: Effect.Effect<
    readonly (PolicyRequest & PolicyDecision)[]
  >;
}

/**
 * Serves the control plane on loopback until the surrounding scope closes.
 *
 * The web handler and the Bun listener are both scope-owned: `dispose()` tears down the
 * application layer the handler built, and `stop(true)` closes the listener.
 */
export class ControlPlaneEndpoint extends Context.Service<
  ControlPlaneEndpoint,
  ControlPlaneHandle
>()("bit/http/ControlPlaneEndpoint") {
  static readonly layer = (options: {
    readonly policy: PolicyConfig;
    readonly port?: number;
    /** Merged onto the same router. See {@link ControlPlaneRoutes}. */
    readonly extraRoutes?: ControlPlaneRoutes | undefined;
    /**
     * The harness catalogue the planner's `list_harnesses` answers from.
     *
     * Passed as a **layer carrying an already-reduced list** rather than as the
     * `HarnessResolver` itself, for the reason the body below gives about the router's own
     * memo map: a requirement crossing that boundary is built a second time, and a second
     * resolver means a second set of built harnesses. Omitted — which is what every test
     * and every spike does — the planner is told this server configures none, which for a
     * caller that has not passed one is true.
     */
    readonly harnesses?: Layer.Layer<PlannerHarnesses> | undefined;
    /**
     * Seconds a connection may be idle, overriding {@link CONTROL_PLANE_IDLE_TIMEOUT}.
     *
     * For tests, and only for tests: the claim worth checking is that a heartbeat keeps a
     * connection alive *past* the listener's idle timeout, and checking it against the real
     * sixty seconds would be a sixty-second test. Nothing in the server passes this.
     */
    readonly idleTimeout?: number | undefined;
  }) =>
    Layer.effect(
      ControlPlaneEndpoint,
      Effect.gen(function* () {
        const counter = yield* McpCallCounter;
        // The MCP route dispatches each write to the target its credential names, so what
        // this listener carries is the *resolver*, not one target's store. It used to be
        // `ObservationStore` and the swap is the whole point of the change: one yield of a
        // store here was what made this process serve one target.
        const stores = yield* TargetStores;
        const credentials = yield* McpCredentials;
        const decisions = yield* PolicyDecisions;

        // Both route sets are built into one router, so `toWebHandler` returns a single
        // handler for the single listener below. Services are passed in rather than
        // rebuilt: the store's connection and the credential registry are the ones the
        // rest of the program already holds.
        const application = Layer.mergeAll(
          mcpApplicationLayer(
            options.harnesses === undefined
              ? {}
              : { harnesses: options.harnesses },
          ),
          policyRoutes(options.policy),
          healthRoutes,
          options.extraRoutes ?? Layer.empty,
        ).pipe(
          Layer.provideMerge(Layer.succeed(TargetStores, stores)),
          Layer.provideMerge(Layer.succeed(McpCredentials, credentials)),
          Layer.provideMerge(Layer.succeed(McpCallCounter, counter)),
          Layer.provideMerge(Layer.succeed(PolicyDecisions, decisions)),
        );

        const web = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(application, { disableLogger: true }),
          ),
          (handler) => Effect.promise(() => handler.dispose()),
        );

        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: options.port ?? 0,
              // See `CONTROL_PLANE_IDLE_TIMEOUT`. Unset, Bun's ten-second default closes
              // every idle live-transcript connection before its heartbeat can fire.
              idleTimeout: options.idleTimeout ?? CONTROL_PLANE_IDLE_TIMEOUT,
              fetch: (request) => web.handler(request),
            }),
          ),
          (running) => Effect.promise(() => running.stop(true)),
        );

        const origin = `http://127.0.0.1:${server.port}`;
        return ControlPlaneEndpoint.of({
          origin,
          mcpUrl: `${origin}${MCP_PATH}`,
          plannerMcpUrl: `${origin}${PLANNER_MCP_PATH}`,
          policyUrl: `${origin}${POLICY_DECIDE_PATH}`,
          healthUrl: `${origin}${HEALTH_PATH}`,
          callCount: counter.count,
          decisions: decisions.all,
        });
      }),
    );
}
