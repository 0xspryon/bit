/**
 * The one HTTP endpoint this control plane serves.
 *
 * There were two listeners: the MCP endpoint the worker calls back into, and the policy
 * endpoint the harness-side hook consults before a tool runs. They answered on separate
 * ports, with separate `Bun.serve` instances, separate scopes and separately hand-rolled
 * request handling. They are one listener now — one port, one origin policy, one
 * shutdown path, one base URL to hand out.
 *
 * **The routes keep their own postures, and that is the point of merging on a router
 * rather than in a `fetch` handler.** `McpServer.layerHttp` applies its bearer
 * middleware to the MCP protocol layer, not to the router, so:
 *
 * - `/api/v1/mcp` fails closed. No credential, an unknown one or an expired one is a
 *   `401` before any protocol handling, tool list or dispatch.
 * - `/api/v1/policy/decide` is deliberately unauthenticated, at the operator's
 *   direction. The reasoning and its cost are recorded on `policyRoutes` itself.
 *
 * Sharing a port does not blur that: a request is routed by path first, and each route
 * carries whatever admission its own layer declared.
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
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { McpCredentials } from "../mcp/credentials";
import { MCP_PATH, McpApplicationLayer, McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import {
  POLICY_DECIDE_PATH,
  PolicyDecisions,
  policyRoutes,
  type PolicyConfig,
  type PolicyDecision,
  type PolicyRequest,
} from "../policy/service";

export interface ControlPlaneHandle {
  /** Where the worker's MCP client connects. */
  readonly mcpUrl: string;
  /** Where the harness-side policy hook posts. */
  readonly policyUrl: string;
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
  }) =>
    Layer.effect(
      ControlPlaneEndpoint,
      Effect.gen(function* () {
        const counter = yield* McpCallCounter;
        const store = yield* ObservationStore;
        const credentials = yield* McpCredentials;
        const decisions = yield* PolicyDecisions;

        // Both route sets are built into one router, so `toWebHandler` returns a single
        // handler for the single listener below. Services are passed in rather than
        // rebuilt: the store's connection and the credential registry are the ones the
        // rest of the program already holds.
        const application = Layer.mergeAll(
          McpApplicationLayer,
          policyRoutes(options.policy),
        ).pipe(
          Layer.provideMerge(Layer.succeed(ObservationStore, store)),
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
              fetch: (request) => web.handler(request),
            }),
          ),
          (running) => Effect.promise(() => running.stop(true)),
        );

        const origin = `http://127.0.0.1:${server.port}`;
        return ControlPlaneEndpoint.of({
          mcpUrl: `${origin}${MCP_PATH}`,
          policyUrl: `${origin}${POLICY_DECIDE_PATH}`,
          callCount: counter.count,
          decisions: decisions.all,
        });
      }),
    );
}
