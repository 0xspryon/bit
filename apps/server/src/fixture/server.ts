/**
 * The fixture's local HTTP surface. Binds to loopback only: fixture traffic never
 * leaves this machine.
 */
import { Context, Effect, Layer } from "effect";

import {
  DEFAULT_CONFIG,
  RateLimitFixture,
  type RateLimitConfig,
} from "./rateLimit";

export interface FixtureServer {
  readonly url: string;
  readonly fixture: RateLimitFixture;
}

/**
 * The running fixture, as a service so demos can take it from the layer stack rather
 * than threading a handle. The fixture's own logic stays an ordinary class: it is a
 * pure bounded state machine and has no business being an Effect service.
 */
export class FixtureEndpoint extends Context.Service<
  FixtureEndpoint,
  FixtureServer
>()("bit/fixture/FixtureEndpoint") {
  static readonly layer = (config: RateLimitConfig = DEFAULT_CONFIG) =>
    Layer.effect(FixtureEndpoint, serveFixture(config));
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Serves the fixture until the surrounding scope closes.
 *
 * `POST /login` takes `{ account, password }` and reads the simulated client identity
 * from `X-Client-Id`. `POST /__fixture/reset` and `GET /__fixture/state` are the
 * deterministic controls; they are part of the fixture, not of the system under test.
 */
export const serveFixture = (
  config: RateLimitConfig = DEFAULT_CONFIG,
  port = 0,
) =>
  Effect.gen(function* () {
    const fixture = new RateLimitFixture(config);
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          async fetch(request) {
            const url = new URL(request.url);

            if (
              url.pathname === "/__fixture/reset" &&
              request.method === "POST"
            ) {
              fixture.reset();
              return json(200, { reset: true });
            }
            if (url.pathname === "/__fixture/state") {
              return json(200, {
                limits: fixture.limits,
                state: fixture.state(),
              });
            }
            if (url.pathname !== "/login" || request.method !== "POST") {
              return json(404, { error: "not_found" });
            }

            const clientId = request.headers.get("x-client-id") ?? "anonymous";
            const body = (await request.json().catch(() => ({}))) as {
              account?: string;
            };
            const account = body.account ?? "unknown";
            const decision = fixture.attempt({ account, clientId });

            if (decision.status === 429) {
              return json(
                429,
                {
                  error: "rate_limited",
                  limiter: decision.limiter,
                  limit: decision.limit,
                },
                { "retry-after": "60" },
              );
            }
            return json(401, { error: "invalid_credentials" });
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );
    return {
      url: server.url.toString().replace(/\/$/, ""),
      fixture,
    } satisfies FixtureServer;
  });
