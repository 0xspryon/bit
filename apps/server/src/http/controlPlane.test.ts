/**
 * The merged listener: one port, two routes, two different admission postures.
 *
 * Each route has its own suite for its own behaviour — `mcp/server.test.ts` for the
 * protocol and the credential, `policy/service.test.ts` for the decision boundary. What
 * is asserted here is only what merging them created, and it is the part a later edit
 * could silently undo: that they really are one listener, and that sharing it did not
 * leak one route's posture onto the other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";

import { ControlPlaneEndpoint, HEALTH_PATH } from "./controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import { PolicyDecisions } from "../policy/service";

const directory = mkdtempSync(join(tmpdir(), "bit-control-plane-"));

const POLICY = {
  forbiddenPathFragments: ["out-of-scope/"],
  allowedHosts: ["127.0.0.1"],
};

/**
 * One grant, issued into the runtime's scope.
 *
 * `issue` puts the credential in the *caller's* scope, so issuing it inside a bare
 * effect would revoke it the moment that effect finished. A layer is what gives it the
 * runtime's lifetime, the same way `mcp/server.test.ts` does.
 */
class TestCredential extends Context.Service<
  TestCredential,
  { readonly token: Redacted.Redacted<string> }
>()("bit/http/TestCredential") {
  static readonly layer = Layer.effect(
    TestCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue({
        targetId: "t",
        intentId: "i",
        attemptId: "a",
        workerId: "w",
        harnessSessionId: "ses_cp",
        attemptFence: 0,
      }),
    ),
  );
}

const testLayer = Layer.mergeAll(
  TestCredential.layer,
  ControlPlaneEndpoint.layer({ policy: POLICY }),
  McpCredentials.layer,
  McpCallCounter.layer,
  PolicyDecisions.layer,
).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provide(ObservationStore.layer(join(directory, "cp.sqlite"))),
);

const runtime = ManagedRuntime.make(testLayer);

let mcpUrl = "";
let policyUrl = "";
let healthUrl = "";
let token = "";

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const endpoint = yield* ControlPlaneEndpoint;
      const credential = yield* TestCredential;
      mcpUrl = endpoint.mcpUrl;
      policyUrl = endpoint.policyUrl;
      healthUrl = endpoint.healthUrl;
      token = Redacted.value(credential.token);
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

const postPolicy = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(policyUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const callMcp = (headers: Record<string, string> = {}) =>
  fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

describe("one listener", () => {
  test("all three routes are served from the same origin", () => {
    // The whole point of the merge. Two origins here means two listeners again.
    expect(new URL(mcpUrl).origin).toBe(new URL(policyUrl).origin);
    expect(new URL(healthUrl).origin).toBe(new URL(mcpUrl).origin);
    expect(new URL(mcpUrl).pathname).toBe("/api/v1/mcp");
    expect(new URL(policyUrl).pathname).toBe("/api/v1/policy/decide");
    expect(new URL(healthUrl).pathname).toBe("/api/v1/health");
    expect(HEALTH_PATH).toBe("/api/v1/health");
  });

  test("an unrouted path on the shared port is a 404, not either route", async () => {
    const response = await fetch(new URL("/api/v1/nothing", mcpUrl), {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });
});

describe("the postures stay separate on the shared port", () => {
  test("the MCP route still fails closed without a credential", async () => {
    const response = await callMcp();
    expect(response.status).toBe(401);
  });

  test("the MCP route still serves a valid credential", async () => {
    const response = await callMcp({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
  });

  test("the policy route answers without a credential, by design", async () => {
    // Deliberately unauthenticated, at the operator's direction: the hook that calls it
    // is a plugin inside the harness and stays credential-free. Sharing a port with a
    // fail-closed route must not quietly change that either way.
    const response = await postPolicy({
      sessionId: "ses_cp",
      tool: "read",
      input: { filePath: "in-scope.txt" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ effect: "allow" });
  });

  test("the policy route still denies on its own boundaries", async () => {
    const response = await postPolicy({
      sessionId: "ses_cp",
      tool: "read",
      input: { filePath: "out-of-scope/secret.txt" },
    });
    const body = (await response.json()) as { effect: string; reason?: string };
    expect(body.effect).toBe("deny");
    expect(body.reason).toContain("out-of-scope/");
  });

  test("an MCP credential does not become a policy credential, or the reverse", async () => {
    // A bearer on the policy route is simply ignored rather than required or rejected,
    // and the policy route's openness does not reach the MCP route: asserted together
    // because "shares a port" must not come to mean "shares an identity".
    const withBearer = await postPolicy(
      { sessionId: "ses_cp", tool: "read", input: {} },
      { authorization: `Bearer ${token}` },
    );
    expect(withBearer.status).toBe(200);

    const mcpWithoutBearer = await callMcp();
    expect(mcpWithoutBearer.status).toBe(401);
  });
});

describe("the health route", () => {
  test("answers the contract's shape, with no credential", async () => {
    // `main.ts` used to serve this from its own `Bun.serve` with a hand-written `fetch`.
    // It is a route on the one router now, so it gets the same method, content-type and
    // origin handling as everything else on the port.
    const response = await fetch(healthUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("a bearer token is neither required nor rejected", async () => {
    const response = await fetch(healthUrl, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  test("the wrong method on the health path is refused by the router", async () => {
    // The replaced hand-written handler answered any method that matched the path.
    const response = await fetch(healthUrl, { method: "POST" });
    expect(response.status).not.toBe(200);
  });

  test("health says nothing about the store, the harness or any attempt", async () => {
    // A liveness answer that reports internal state is a reconnaissance surface, and
    // one that fails when a subsystem is slow cannot be used for liveness at all.
    const body = await (await fetch(healthUrl)).text();
    expect(Object.keys(JSON.parse(body) as Record<string, unknown>)).toEqual([
      "status",
    ]);
  });
});

describe("accounting", () => {
  test("policy requests are recorded, and are not counted as MCP calls", async () => {
    const before = await runtime.runPromise(
      Effect.flatMap(ControlPlaneEndpoint, (endpoint) => endpoint.callCount),
    );
    await postPolicy({ sessionId: "ses_cp", tool: "shell", input: "ls" });
    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const endpoint = yield* ControlPlaneEndpoint;
        return {
          calls: yield* endpoint.callCount,
          decisions: yield* endpoint.decisions,
        };
      }),
    );

    // The MCP counter exists to prove the worker reached our tools; a policy decision
    // is not that, and inflating it would make the demo's report a lie.
    expect(after.calls).toBe(before);
    // Neither is a health check, which anything on loopback can send at any rate.
    await fetch(healthUrl);
    expect(
      await runtime.runPromise(
        Effect.flatMap(ControlPlaneEndpoint, (endpoint) => endpoint.callCount),
      ),
    ).toBe(before);
    expect(after.decisions.length).toBeGreaterThan(0);
    expect(after.decisions.at(-1)?.tool).toBe("shell");
  });
});
