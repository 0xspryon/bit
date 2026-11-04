import { describe, expect, test } from "bun:test";
import { API_PREFIX } from "@bit/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import {
  POLICY_DECIDE_PATH,
  PolicyDecisions,
  decide,
  type PolicyConfig,
} from "./service";

const CONFIG: PolicyConfig = {
  forbiddenPathFragments: ["out-of-scope-secret.txt", "out-of-scope/"],
  hostScope: { _tag: "hosts", allowed: ["127.0.0.1", "localhost"] },
};

const request = (tool: string, input: unknown) => ({
  sessionId: "ses_test",
  tool,
  input,
});

describe("policy decisions", () => {
  test("allows ordinary work by default, saying the host rule did not apply", () => {
    // Permissive with explicit boundaries: autonomy is the posture, not an exception.
    // `no_host_named` rather than a bare "allow": neither of these inputs names a host,
    // so the host rule had nothing to decide, and that is a different fact from one whose
    // hosts were checked and matched.
    expect(
      decide(CONFIG, request("read", { filePath: "in-scope.txt" })),
    ).toEqual({
      effect: "allow",
      basis: "no_host_named",
    });
    expect(decide(CONFIG, request("shell", { command: "ls -la" }))).toEqual({
      effect: "allow",
      basis: "no_host_named",
    });
  });

  test("an allowed host is told apart from no host at all", () => {
    expect(
      decide(
        CONFIG,
        request("webfetch", { url: "http://127.0.0.1:41317/login" }),
      ),
    ).toEqual({ effect: "allow", basis: "hosts_allowed" });
  });

  describe("an unrestricted host scope", () => {
    /**
     * The scope a browser-started run is gated by: installed, recorded, permitting.
     *
     * The thing these three tests pin down is that "unrestricted" is a *decision the gate
     * makes*, not the gate being absent — it is reached, it is distinguishable, and it
     * does not switch off the boundary that is not about hosts.
     */
    const unrestricted: PolicyConfig = {
      forbiddenPathFragments: ["hunt.sqlite"],
      hostScope: {
        _tag: "unrestricted",
        because: "no structured scope to derive an allowlist from",
      },
    };

    test("permits a host that a listed scope would refuse, and says why", () => {
      const remote = request("webfetch", { url: "https://example.test/admin" });
      // The same call, under the two scopes, decided differently — which is what makes
      // this a configuration difference rather than a missing check.
      expect(decide(CONFIG, remote).effect).toBe("deny");
      expect(decide(unrestricted, remote)).toEqual({
        effect: "allow",
        basis: "unrestricted",
      });
    });

    test("is told apart from a host that was allowed by matching", () => {
      // Both are `allow`; only the basis says whether anything was actually checked.
      const local = request("webfetch", { url: "http://127.0.0.1:8080/" });
      expect(decide(CONFIG, local)).toEqual({
        effect: "allow",
        basis: "hosts_allowed",
      });
      expect(decide(unrestricted, local)).toEqual({
        effect: "allow",
        basis: "unrestricted",
      });
    });

    test("does not switch off the forbidden-path boundary", () => {
      // Two boundaries, and only one of them is about hosts. A scope that wants neither
      // has to say so twice.
      const decision = decide(
        unrestricted,
        request("read", { filePath: "/var/bit/hunt.sqlite" }),
      );
      expect(decision.effect).toBe("deny");
      expect(decision).toHaveProperty("reason");
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
    const config: PolicyConfig = {
      ...CONFIG,
      hostScope: { _tag: "hosts", allowed: ["::1"] },
    };
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
    // The MCP route takes the per-target resolver now, not one target's store. One entry over
    // the file below: dispatch is still real, and a credential naming another target is
    // refused by name.
    Layer.provide(
      TargetStores.ofStore("t").pipe(
        Layer.provide(ObservationStore.layer(":memory:")),
      ),
    ),
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
  test("a call from a session bit has ended is refused, whatever the scope says, until it is held again", async () => {
    /*
     * The backstop behind `AgentHarness.endSession` (A6 F5 review): an ended conversation's
     * harness may take a moment to stop, or may not answer, and a tool call it makes in the
     * meantime must not be allowed because the scope is permissive. Held again — a resume
     * of the same session — it is decided as before.
     */
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* ControlPlaneEndpoint;
          const decisions = yield* PolicyDecisions;
          const ask = (sessionId: string) =>
            Effect.promise(async () => {
              const response = await fetch(endpoint.policyUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ...request("bash", { command: "ls" }),
                  sessionId,
                }),
              });
              return (await response.json()) as {
                effect?: string;
                reason?: string;
              };
            });
          const first = {};
          const second = {};
          yield* decisions.holdSession("ses_talk", first);
          const held = yield* ask("ses_talk");
          yield* decisions.endSession("ses_talk", first);
          const ended = yield* ask("ses_talk");
          const other = yield* ask("ses_worker");
          yield* decisions.holdSession("ses_talk", second);
          const resumed = yield* ask("ses_talk");
          // An older opening letting go again does not end the newer one's.
          yield* decisions.endSession("ses_talk", first);
          const stillResumed = yield* ask("ses_talk");
          return { held, ended, other, resumed, stillResumed };
        }).pipe(Effect.provide(endpointLayer)),
      ),
    );
    expect(outcome.held.effect).toBe("allow");
    expect(outcome.ended.effect).toBe("deny");
    expect(outcome.ended.reason).toContain("has been ended by bit");
    // A session nobody ended — a worker's — is decided exactly as before.
    expect(outcome.other.effect).toBe("allow");
    expect(outcome.resumed.effect).toBe("allow");
    expect(outcome.stillResumed.effect).toBe("allow");
  });
});

/**
 * The gate's answers as a live feed, which is what a transcript showing a refusal reads.
 *
 * The in-memory list was always here; publishing is new, and the two claims worth checking
 * are that a decision reaches a subscriber at all and that `record` does not *depend* on
 * one. The second is the load-bearing one: this runs on the gate's own response path, with a
 * worker waiting, so a subscriber must not be able to make it slower — hence a sliding
 * `PubSub`, which never blocks and drops the oldest rather than waiting for a reader.
 */
describe("the decision feed", () => {
  const entry = {
    sessionId: "ses_test",
    tool: "shell",
    input: { command: "curl https://out-of-scope.test/" },
    effect: "deny" as const,
    reason: "host 'out-of-scope.test' is not in scope",
  };

  test("a recorded decision reaches a subscriber, with its request and its reason apart", async () => {
    const answered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const decisions = yield* PolicyDecisions;
          const reader = yield* Effect.forkScoped(
            Stream.runHead(decisions.answered),
          );
          // Waited for, not slept through. The bus replays nothing, so a decision answered
          // before the subscription exists is gone — and a fixed delay here would be a test
          // that passes on a fast machine and flakes on a loaded one.
          yield* Effect.timeout(
            Effect.gen(function* () {
              while ((yield* decisions.subscriberCount) === 0) {
                yield* Effect.sleep("2 millis");
              }
            }),
            "10 seconds",
          ).pipe(Effect.orDie);
          yield* decisions.record(entry);
          // `Stream.runHead` answers with an `Option`, and an empty one would mean the feed
          // ended without saying anything — which is a failure, not an absence.
          return Option.getOrUndefined(yield* Fiber.join(reader));
        }).pipe(Effect.provide(PolicyDecisions.layer)),
      ),
    );

    expect(answered?.request.tool).toBe("shell");
    expect(answered?.request.sessionId).toBe("ses_test");
    // The decision is carried apart from the request, so a reader renders the gate's reason
    // rather than having to pick it out of a flattened record.
    expect(answered?.decision).toEqual({
      effect: "deny",
      reason: "host 'out-of-scope.test' is not in scope",
    });
    // In-process answer order: enough for a live reader to say "already shown", and
    // deliberately not a cursor. See `AnsweredDecision`.
    expect(answered?.id).toBe(1);
  });

  /**
   * The count is a readiness signal, so it must not lead the subscription.
   *
   * The test above waits on `subscriberCount` and then answers one decision *once*. That is
   * only sound if the count becoming 1 means the `PubSub` subscription genuinely exists —
   * which is why `answered` takes `PubSub.subscribe` first and counts after. An earlier
   * version incremented beside `Stream.fromPubSub` and returned the stream, which reads as
   * the same thing: the subscription is actually taken when the stream is first *pulled*,
   * so the count could lead it, and the test above would have been relying on a race it
   * happened to win.
   *
   * This asserts the ordering from the other side: nothing is counted until a reader is
   * attached, and the count goes back when the reader's scope closes.
   */
  test("nothing is counted until a reader is attached, and the count is given back", async () => {
    const counts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const decisions = yield* PolicyDecisions;
          const before = yield* decisions.subscriberCount;

          const during = yield* Effect.scoped(
            Effect.gen(function* () {
              const reader = yield* Effect.forkScoped(
                Stream.runHead(decisions.answered),
              );
              yield* Effect.timeout(
                Effect.gen(function* () {
                  while ((yield* decisions.subscriberCount) === 0) {
                    yield* Effect.sleep("2 millis");
                  }
                }),
                "10 seconds",
              ).pipe(Effect.orDie);
              // Read while the reader is still attached. After `Fiber.join` it is already
              // back to zero — `Stream.runHead` closes the stream's scope when it answers,
              // which is the release working rather than a surprise.
              const counted = yield* decisions.subscriberCount;
              // A decision published now reaches it, which is the proof that the count
              // means what the readiness wait takes it to mean.
              yield* decisions.record(entry);
              const seen = Option.getOrUndefined(yield* Fiber.join(reader));
              return { counted, tool: seen?.request.tool };
            }),
          );

          return { before, during, after: yield* decisions.subscriberCount };
        }).pipe(Effect.provide(PolicyDecisions.layer)),
      ),
    );

    expect(counts.before).toBe(0);
    expect(counts.during.counted).toBe(1);
    expect(counts.during.tool).toBe("shell");
    // Released with the reader's scope, so a dropped connection does not leave the count
    // claiming a subscriber that is gone.
    expect(counts.after).toBe(0);
  });

  test("recording does not wait for a subscriber, and still keeps every decision", async () => {
    const all = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const decisions = yield* PolicyDecisions;
          // Nobody is listening. A bus that back-pressured here would mean a browser tab
          // that closed could stall the answer a worker is blocked on.
          yield* decisions.record(entry);
          yield* decisions.record({ ...entry, tool: "read" });
          return yield* decisions.all;
        }).pipe(Effect.provide(PolicyDecisions.layer)),
      ),
    );
    expect(all.map((one) => one.tool)).toEqual(["shell", "read"]);
  });

  /**
   * The split into `request` and `decision` is a split, not a cast.
   *
   * The earlier version destructured the request's keys off and cast the remainder, under a
   * comment claiming that made a new `PolicyDecision` member a compile error. It did not —
   * a cast compiles whatever the union gains. Reconstructing the arm by discriminating on
   * `effect` is what actually does, and this checks that both arms survive the trip with
   * the field each one carries.
   */
  test("both arms of a decision survive the split with their own field", async () => {
    const answered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const decisions = yield* PolicyDecisions;
          const reader = yield* Effect.forkScoped(
            Stream.runCollect(Stream.take(decisions.answered, 2)),
          );
          yield* Effect.timeout(
            Effect.gen(function* () {
              while ((yield* decisions.subscriberCount) === 0) {
                yield* Effect.sleep("2 millis");
              }
            }),
            "10 seconds",
          ).pipe(Effect.orDie);
          yield* decisions.record({
            sessionId: "ses_test",
            tool: "read",
            input: { filePath: "in-scope.txt" },
            effect: "allow",
            basis: "no_host_named",
          });
          yield* decisions.record(entry);
          return yield* Fiber.join(reader);
        }).pipe(Effect.provide(PolicyDecisions.layer)),
      ),
    );

    expect([...answered].map((one) => one.decision)).toEqual([
      { effect: "allow", basis: "no_host_named" },
      { effect: "deny", reason: "host 'out-of-scope.test' is not in scope" },
    ]);
    // Answer order, counting from 1 and contiguous: a request the route refused as
    // undecodable is never recorded and so never consumes a number.
    expect([...answered].map((one) => one.id)).toEqual([1, 2]);
  });
});
