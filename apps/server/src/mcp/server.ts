/**
 * The application-owned MCP server.
 *
 * Transport, protocol framing and tool dispatch are Effect's
 * (`McpServer.layerHttp`, `effect/src/ai/McpServer.ts:1649`), not ours. The ~200 lines
 * of handwritten JSON-RPC this replaces had to be read against the spec to be trusted;
 * what remains is the part that is actually ours: the auth boundary and the binding of
 * the Bun HTTP server to the Effect router.
 *
 * Shape follows T3Code (MIT) `apps/server/src/mcp/McpHttpServer.ts:183-185,861-867`.
 *
 * **Fails closed.** The auth middleware runs before any protocol handling, so a request
 * with no bearer token, an unknown token or an expired one is refused with `401` and
 * never reaches a tool, a tool list, or even `initialize`. There is no anonymous path
 * and no default caller. The resolved grant is provided as {@link McpInvocation} for the
 * duration of that request only.
 *
 * Streamable HTTP is what OpenCode's remote MCP client speaks. The revision served is
 * **`McpProtocol.v2026_07_28`, and only that one** — the single stateless adapter in
 * `effect/ai` (`effect/src/ai/McpProtocol.ts:211`; every other revision is
 * `StatefulRuntimeDescriptor`). It carries request-scoped metadata instead of an
 * `initialize` handshake and a protocol-level session, so there is no session table to
 * keep, expire or reconcile, and a request either carries everything it needs or is
 * refused.
 *
 * **The client has to be pinned to match.** OpenCode's remote MCP config has a
 * `protocol` field with three accepted values, and its default is the handshake-based
 * one, which opens with `initialize` and speaks revisions only up to 2025-11-25
 * (`@opencode/schema`'s `Mcp.Protocol`). A default-configured client against this
 * endpoint fails, by design: `openCodeClient.ts` sends `protocol: "2026-07-28"` on the
 * remote server config, and the two have to move together. Nothing is served for
 * earlier revisions — there is no fallback path to drift.
 *
 * **This module no longer serves.** It builds {@link McpApplicationLayer} — tools,
 * handlers, protocol and the auth middleware — as routes on an ambient `HttpRouter`.
 * One listener carries those routes together with the policy route
 * (`http/controlPlane.ts`), so there is a single port and a single shutdown path. The
 * auth middleware is attached to the protocol layer rather than to the router, which is
 * what lets the two routes keep different postures on one port.
 */
import { apiPath } from "@bit/contracts";
import { Context, Effect, Layer, type Types } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { McpCredentials } from "./credentials";
import { McpInvocation } from "./invocation";
import { DomainToolkit, DomainToolkitLayer } from "./tools";

export const SERVER_NAME = "bit-control-plane";
export const SERVER_VERSION = "0.1.0";
/** The one path the MCP endpoint is served on, under the shared API prefix. */
export const MCP_PATH = apiPath("mcp");

/**
 * Accepted tool calls, for asserting the worker really reached us.
 *
 * A counter is enough for the spike and is deliberately not a metric export yet.
 */
export class McpCallCounter extends Context.Service<
  McpCallCounter,
  {
    readonly increment: Effect.Effect<void>;
    readonly count: Effect.Effect<number>;
  }
>()("bit/mcp/McpCallCounter") {
  static readonly layer = Layer.sync(McpCallCounter, () => {
    let calls = 0;
    return McpCallCounter.of({
      increment: Effect.sync(() => {
        calls += 1;
      }),
      count: Effect.sync(() => calls),
    });
  });
}

const bearerOf = (header: string | undefined): string =>
  header !== undefined && header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";

/**
 * Resolves the presented credential, or refuses the request outright.
 *
 * Note what this does *not* do: there is no fallback identity, and no path where a
 * missing credential produces an empty tool list instead of a refusal. An agent that
 * silently loses the toolkit is far harder to diagnose than one that gets a 401.
 */
const authMiddleware = HttpRouter.middleware<{ provides: McpInvocation }>()(
  Effect.gen(function* () {
    const credentials = yield* McpCredentials;
    const counter = yield* McpCallCounter;
    return Effect.fnUntraced(function* (
      httpEffect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Types.unhandled,
        McpInvocation
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = bearerOf(request.headers["authorization"]);
      const grant =
        token === "" ? undefined : yield* credentials.resolve(token);
      if (grant === undefined) {
        yield* Effect.logWarning("refused an MCP request", {
          reason: token === "" ? "missing_bearer_token" : "unknown_or_expired",
        });
        return HttpServerResponse.text("unauthorized", { status: 401 });
      }
      yield* counter.increment;
      return yield* Effect.provideService(httpEffect, McpInvocation, grant);
    });
  }),
).layer;

const registration = McpServer.toolkit(DomainToolkit);

/**
 * `McpInvocation` is a per-request service, so it cannot be in the layer's
 * requirements — the auth middleware provides it on each request instead. Same
 * assertion, and the same reason, as T3Code's `toolkitRegistration`
 * (`apps/server/src/mcp/McpHttpServer.ts:777-782`).
 */
const registered = registration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof registration>, McpInvocation>
>;

/** The whole MCP application: tools, handlers, protocol, transport, auth. */
export const McpApplicationLayer = registered.pipe(
  Layer.provide(DomainToolkitLayer),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      path: MCP_PATH,
      protocols: [McpProtocol.v2026_07_28],
    }).pipe(Layer.provide(authMiddleware)),
  ),
);
