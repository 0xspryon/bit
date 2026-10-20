import { describe, expect, test } from "bun:test";
import { API_PREFIX } from "@bit/contracts";
import { Effect, Layer } from "effect";

import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import {
  POLICY_DECIDE_PATH,
  PolicyDecisions,
  decide,
  type PolicyConfig,
} from "./service";

const CONFIG: PolicyConfig = {
  forbiddenPathFragments: ["out-of-scope-secret.txt", "out-of-scope/"],
  allowedHosts: ["127.0.0.1", "localhost"],
};

const request = (tool: string, input: unknown) => ({
  sessionId: "ses_test",
  tool,
  input,
});

describe("policy decisions", () => {
  test("allows ordinary work by default", () => {
    // Permissive with explicit boundaries: autonomy is the posture, not an exception.
    expect(
      decide(CONFIG, request("read", { filePath: "in-scope.txt" })),
    ).toEqual({
      effect: "allow",
    });
    expect(decide(CONFIG, request("shell", { command: "ls -la" }))).toEqual({
      effect: "allow",
    });
  });

  test("denies a forbidden path named in tool input", () => {
    const decision = decide(
      CONFIG,
      request("read", { filePath: "out-of-scope-secret.txt" }),
    );
    expect(decision.effect).toBe("deny");
    expect(decision).toHaveProperty("reason");
  });

  test("matches a forbidden path case-insensitively and inside longer strings", () => {
    expect(
      decide(
        CONFIG,
        request("shell", { command: "cat ./OUT-OF-SCOPE-SECRET.TXT" }),
      ).effect,
    ).toBe("deny");
    expect(
      decide(CONFIG, request("shell", { command: "ls out-of-scope/nested" }))
        .effect,
    ).toBe("deny");
  });

  test("denies a host outside the engagement scope", () => {
    const decision = decide(
      CONFIG,
      request("shell", { command: "curl https://example.com/" }),
    );
    expect(decision.effect).toBe("deny");
  });

  test("allows the loopback fixture, including a port", () => {
    expect(
      decide(
        CONFIG,
        request("shell", { command: "curl http://127.0.0.1:8080/login" }),
      ).effect,
    ).toBe("allow");
  });

  test("an IPv6 loopback literal is recognised", () => {
    const config: PolicyConfig = { ...CONFIG, allowedHosts: ["::1"] };
    expect(
      decide(
        config,
        request("shell", { command: "curl http://[::1]:8080/login" }),
      ).effect,
    ).toBe("allow");
  });

  test("a host that merely contains an allowed host is still denied", () => {
    // `127.0.0.1.evil.test` must not pass as `127.0.0.1`.
    expect(
      decide(
        CONFIG,
        request("shell", { command: "curl http://127.0.0.1.evil.test/" }),
      ).effect,
    ).toBe("deny");
  });

  test("inspects nested input, not just top-level strings", () => {
    expect(
      decide(
        CONFIG,
        request("edit", {
          edits: [{ path: "nested/out-of-scope-secret.txt" }],
        }),
      ).effect,
    ).toBe("deny");
  });

  test("a path assembled at runtime is NOT covered, by construction", () => {
    // This is the documented limit of input inspection, asserted so a future change
    // that claims broader coverage has to confront it rather than inherit it quietly.
    const decision = decide(
      CONFIG,
      request("shell", {
        command: 'f="out-of-scope"; g="-secret.txt"; cat "$f$g"',
      }),
    );
    expect(decision.effect).toBe("allow");
  });

  test("empty and null inputs are handled without throwing", () => {
    expect(decide(CONFIG, request("read", null)).effect).toBe("allow");
    expect(decide(CONFIG, request("read", undefined)).effect).toBe("allow");
  });
});

describe("the policy HTTP boundary", () => {
  /**
   * The control-plane listener, which carries the policy route and the MCP route.
   *
   * An in-memory store because these tests never touch a tool; the MCP services are
   * here only because one listener means one application layer.
   */
  const endpointLayer = ControlPlaneEndpoint.layer({ policy: CONFIG }).pipe(
    Layer.provideMerge(McpCredentials.layer),
    Layer.provideMerge(McpCallCounter.layer),
    Layer.provideMerge(PolicyDecisions.layer),
    Layer.provide(ObservationStore.layer(":memory:")),
  );

  /** Runs the real endpoint in a scope and posts raw bodies at it. */
  const post = (body: BodyInit | null, contentType = "application/json") =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* ControlPlaneEndpoint;
          const answered = yield* Effect.promise(async () => {
            const response = await fetch(endpoint.policyUrl, {
              method: "POST",
              headers: { "content-type": contentType },
              body,
            });
            return {
              status: response.status,
              body: (await response.json()) as {
                effect?: string;
                reason?: string;
              },
            };
          });
          // Read after the request, not before: the count is the assertion.
          const recorded = yield* endpoint.decisions;
          return { ...answered, decisions: recorded.length };
        }).pipe(Effect.provide(endpointLayer)),
      ),
    );

  test("the endpoint is served under the versioned API prefix, and only there", async () => {
    // The published URL is what the harness-side hook is configured with, so asserting
    // the constant alone would not catch a handler that still matched the old path.
    expect(POLICY_DECIDE_PATH).toBe(`${API_PREFIX}/policy/decide`);

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* ControlPlaneEndpoint;
          const origin = new URL(endpoint.policyUrl).origin;
          return yield* Effect.promise(async () => {
            const body = JSON.stringify(
              request("read", { filePath: "in-scope.txt" }),
            );
            const prefixed = await fetch(endpoint.policyUrl, {
              method: "POST",
              body,
            });
            const unprefixed = await fetch(`${origin}/policy/decide`, {
              method: "POST",
              body,
            });
            return {
              url: endpoint.policyUrl,
              prefixed: prefixed.status,
              unprefixed: unprefixed.status,
            };
          });
        }).pipe(Effect.provide(endpointLayer)),
      ),
    );

    expect(new URL(outcome.url).pathname).toBe(POLICY_DECIDE_PATH);
    expect(outcome.prefixed).toBe(200);
    // Nothing is served off the prefix: there is no unversioned alias to drift.
    expect(outcome.unprefixed).toBe(404);
  });

  test("a well-formed request is decided", async () => {
    const response = await post(
      JSON.stringify(request("read", { filePath: "in-scope.txt" })),
    );
    expect(response.status).toBe(200);
    expect(response.body.effect).toBe("allow");
    expect(response.decisions).toBe(1);
  });

  test("a body missing required fields is denied, not cast into a decision", async () => {
    // The previous handler did `(await request.json()) as PolicyRequest`, so a body
    // with no `tool` reached `decide` with `undefined` fields. A gate that accepts
    // malformed requests is not a gate.
    const response = await post(JSON.stringify({ sessionId: "ses_test" }));
    expect(response.status).toBe(400);
    expect(response.body.effect).toBe("deny");
    expect(response.body.reason).toContain("undecodable");
    // And nothing was recorded as a decision about a request we never understood.
    expect(response.decisions).toBe(0);
  });

  test("a body with the wrong field types is denied", async () => {
    const response = await post(
      JSON.stringify({ sessionId: 1, tool: ["read"], input: {} }),
    );
    expect(response.status).toBe(400);
    expect(response.body.effect).toBe("deny");
  });

  test("a body that is not JSON at all is denied", async () => {
    const response = await post("<html>not json</html>");
    expect(response.status).toBe(400);
    expect(response.body.effect).toBe("deny");
  });
});
