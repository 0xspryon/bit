/**
 * Tests the MCP mutation boundary over real HTTP against a real SQLite file.
 *
 * Two things are the point. First, authorization: the tool surface must not exist at
 * all for an unauthenticated caller, and a caller must not be able to talk its way into
 * different provenance. Second, schema parity: the advertised `inputSchema` and the
 * decoder are now derived from one wire schema, and these tests fail if they ever stop
 * agreeing.
 *
 * `ManagedRuntime` is the documented bridge from Effect to a non-Effect host like
 * `bun:test`: one runtime owns the layer stack's scope, `dispose()` closes it, and no
 * `Scope.make`/`Scope.close(..., Effect.void as never)` pair is involved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Context,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect";

import { API_PREFIX } from "@bit/contracts";

import { multiCaseWireArgs } from "../persistence/fixtures";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { McpCredentials, type IssuedCredential } from "./credentials";
import { MCP_PATH, McpCallCounter } from "./server";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { DEFAULT_POLICY, PolicyDecisions } from "../policy/service";
import { RecordObservation } from "./tools";

const directory = mkdtempSync(join(tmpdir(), "bit-mcp-"));
const databaseFile = join(directory, "hunt.sqlite");

const BINDING = {
  _tag: "attempt",
  targetId: "target-1",
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_test",
  workerId: "worker-1",
} as const;

/**
 * What a credential is minted against: the binding plus the attempt's write fence.
 *
 * `0` is the fence a freshly seeded attempt carries, so this is the live authority for
 * `attempt-1` throughout this suite.
 */
const CREDENTIAL = { ...BINDING, attemptFence: 0 } as const;

/**
 * The suite's credential, issued into the *layer's* scope.
 *
 * That is not a convenience: it is the behaviour under test in
 * "credential lifetime", below. `dispose()` revokes it.
 */
class TestCredential extends Context.Service<
  TestCredential,
  IssuedCredential
>()("test/TestCredential") {
  static readonly layer = Layer.effect(
    TestCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue(CREDENTIAL),
    ),
  );
}

/**
 * A credential for an attempt that has already been settled.
 *
 * Issued from a layer for the same reason {@link TestCredential} is — `issue` puts the
 * grant in the caller's scope, so issuing it inside a bare effect would revoke it before
 * the request goes out. The attempt is seeded and settled here too, so the credential is
 * genuinely valid-but-superseded rather than simply unknown: the registry resolves it,
 * and the store is what refuses the write.
 */
class StaleCredential extends Context.Service<
  StaleCredential,
  IssuedCredential
>()("test/StaleCredential") {
  static readonly layer = Layer.effect(
    StaleCredential,
    Effect.gen(function* () {
      const store = yield* ObservationStore;
      yield* store.seedAttempt({
        ...BINDING,
        attemptId: "attempt-settled",
        goalId: "goal-1",
        goal: "Determine whether authentication rate limits can be bypassed.",
        question: "Probe the per-client limiter.",
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        modelOptions: null,
      });
      yield* store.settleAttempt("attempt-settled", "interrupted");
      const credentials = yield* McpCredentials;
      return yield* credentials.issue({
        ...BINDING,
        attemptId: "attempt-settled",
        attemptFence: 0,
      });
    }),
  );
}

/**
 * A planner round's credential, and a goal agent's.
 *
 * Both are genuinely valid — the registry resolves them and the request reaches the
 * toolkit — which is the point: what refuses them is the *authority path*, not the auth
 * middleware. The round row deliberately does not exist, because the kind check happens
 * before any read and a test that seeded one could not show that.
 *
 * The goal credential is issued with **no expiry** (`issueWithoutExpiry`), so the
 * no-expiry path is exercised over real HTTP rather than only against the registry.
 */
class RoundCredential extends Context.Service<
  RoundCredential,
  IssuedCredential
>()("test/RoundCredential") {
  static readonly layer = Layer.effect(
    RoundCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue({
        _tag: "round",
        targetId: "target-1",
        goalId: "goal-1",
        roundId: "rnd-1",
        roundFence: 0,
      }),
    ),
  );
}

class GoalCredential extends Context.Service<
  GoalCredential,
  IssuedCredential
>()("test/GoalCredential") {
  static readonly layer = Layer.effect(
    GoalCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issueWithoutExpiry({
        _tag: "goal",
        targetId: "target-1",
        goalId: "goal-1",
      }),
    ),
  );
}

const testLayer = Layer.mergeAll(
  ControlPlaneEndpoint.layer({ policy: DEFAULT_POLICY }),
  TestCredential.layer,
  StaleCredential.layer,
  RoundCredential.layer,
  GoalCredential.layer,
  McpCredentials.layer,
  McpCallCounter.layer,
  PolicyDecisions.layer,
  ObservationStore.layer(databaseFile),
).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provideMerge(ObservationStore.layer(databaseFile)),
  // The MCP write boundary resolves a store by the target id its credential carries, so
  // what the endpoint needs is a resolver. One entry over the file above, which is the
  // whole truth here: `BINDING.targetId` is the only target these credentials name.
  Layer.provideMerge(
    TargetStores.ofStore(BINDING.targetId).pipe(
      Layer.provide(ObservationStore.layer(databaseFile)),
    ),
  ),
);

const runtime = ManagedRuntime.make(testLayer);

let url = "";
let token = "";
let staleToken = "";
let roundToken = "";
let goalToken = "";

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* ObservationStore;
      yield* store.seedAttempt({
        ...BINDING,
        goalId: "goal-1",
        goal: "Determine whether authentication rate limits can be bypassed.",
        question: "Probe the per-client limiter.",
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        modelOptions: null,
      });
      const endpoint = yield* ControlPlaneEndpoint;
      const credential = yield* TestCredential;
      url = endpoint.mcpUrl;
      token = Redacted.value(credential.token);
      staleToken = Redacted.value((yield* StaleCredential).token);
      roundToken = Redacted.value((yield* RoundCredential).token);
      goalToken = Redacted.value((yield* GoalCredential).token);
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

let nextId = 1;

/**
 * The 2026-07-28 revision is stateless, so there is no handshake and no session id.
 * Each request instead has to carry its own envelope, and the runtime refuses every
 * omission with its own 400 (`effect/src/ai/internal/mcpRuntime.ts:280-320`):
 *
 * - `MCP-Protocol-Version`, matching the `_meta` protocol-version claim exactly.
 * - `params._meta["io.modelcontextprotocol/protocolVersion"]` and
 *   `["io.modelcontextprotocol/clientCapabilities"]`.
 * - `Mcp-Method`, matching the JSON-RPC method.
 * - `Mcp-Name` for the routed methods — `tools/call` and `prompts/get` route on
 *   `params.name`, `resources/read` on `params.uri`.
 *
 * Building it here rather than per test is deliberate: a test that hand-rolled part of
 * the envelope would be asserting against its own mistake.
 */
const PROTOCOL_VERSION = "2026-07-28";

const ROUTING_KEY: Record<string, "name" | "uri" | undefined> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

const envelope = (params: unknown): unknown => {
  const base = (params ?? {}) as Record<string, unknown>;
  const meta = (base["_meta"] ?? {}) as Record<string, unknown>;
  return {
    ...base,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      ...meta,
    },
  };
};

/** `bearer: null` sends no Authorization header at all; omitting it uses the grant. */
const rpc = async (
  method: string,
  params: unknown,
  bearer: string | null = token,
  overrides: {
    readonly headers?: Record<string, string>;
    readonly rawParams?: unknown;
    readonly omit?: ReadonlyArray<string>;
  } = {},
) => {
  const body = overrides.rawParams !== undefined ? overrides.rawParams : params;
  const sent = overrides.rawParams !== undefined ? body : envelope(params);
  const routingKey = ROUTING_KEY[method];
  const routedName =
    routingKey === undefined
      ? undefined
      : (params as Record<string, unknown> | undefined)?.[routingKey];

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
    ...(typeof routedName === "string" ? { "mcp-name": routedName } : {}),
    ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    ...overrides.headers,
  };
  for (const key of overrides.omit ?? []) delete headers[key];

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: sent,
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body:
      text.length > 0 && text.startsWith("{")
        ? (JSON.parse(text) as Record<string, unknown>)
        : null,
  };
};

const args = multiCaseWireArgs;

const callTool = (
  toolArgs: Record<string, unknown>,
  bearer: string | null = token,
) =>
  rpc(
    "tools/call",
    { name: "record_observation", arguments: toolArgs },
    bearer,
  );

interface ToolResult {
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
  /** The refusal reason, from whichever channel carried it. */
  readonly rpcError: string | undefined;
  /** The raw first text block, refusal message or encoded result alike. */
  readonly text: string;
}

/**
 * Reads a tool response without assuming which channel a refusal arrived on.
 *
 * **This revision reports an invalid payload as a tool error, not a JSON-RPC error.**
 * A schema-invalid `tools/call` comes back `200` with
 * `result.isError: true` and the reason in `result.content[0].text`
 * ("Invalid parameters for tool 'record_observation': Missing key at [\"cases\"][0]"),
 * where the stateful revisions put it in a top-level `error` object. Either way the call
 * is refused and nothing is written — the assertion that matters — so this reads both
 * and the tests do not care which one the protocol chose.
 *
 * The text block is only parsed as JSON when it actually looks like JSON; a refusal
 * message is prose, and parsing it unconditionally is what made this helper throw.
 */
const payloadOf = (body: Record<string, unknown> | null): ToolResult => {
  const rpcError = (body?.["error"] as { message?: string } | undefined)
    ?.message;
  const result = body?.["result"] as
    | {
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }
    | undefined;
  const text = result?.content?.[0]?.text ?? "";
  const isError = result?.isError === true;
  return {
    isError,
    data:
      result?.structuredContent ??
      (text.startsWith("{")
        ? (JSON.parse(text) as Record<string, unknown>)
        : {}),
    rpcError: rpcError ?? (isError ? text : undefined),
    text,
  };
};

describe("the stateless protocol envelope", () => {
  // Each of these is a rule the runtime enforces per request, with its own refusal
  // (`effect/src/ai/internal/mcpRuntime.ts:280-320`). They are asserted because this
  // revision has no handshake: if the envelope stops being built correctly there is no
  // connection-setup step that would fail first and make it obvious.
  const listed = () => rpc("tools/list", {});

  test("a complete envelope is accepted and issues no session", async () => {
    const response = await listed();
    expect(response.status).toBe(200);
    // Nothing to resume, expire or reconcile: the revision has no protocol session.
    expect(response.body?.["result"]).toBeDefined();
  });

  test("a missing MCP-Protocol-Version header is refused", async () => {
    const response = await rpc("tools/list", {}, token, {
      omit: ["mcp-protocol-version"],
    });
    expect(response.status).toBe(400);
  });

  test("an unsupported protocol version is refused", async () => {
    // The revisions this endpoint used to serve are now simply not served.
    const response = await rpc("tools/list", {}, token, {
      headers: { "mcp-protocol-version": "2025-06-18" },
    });
    expect(response.status).toBe(400);
  });

  test("a request with no _meta envelope is refused", async () => {
    const response = await rpc("tools/list", {}, token, { rawParams: {} });
    expect(response.status).toBe(400);
  });

  test("a protocol version in _meta that contradicts the header is refused", async () => {
    const response = await rpc("tools/list", {}, token, {
      rawParams: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2025-11-25",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    expect(response.status).toBe(400);
  });

  test("a Mcp-Method header that disagrees with the body is refused", async () => {
    const response = await rpc("tools/list", {}, token, {
      headers: { "mcp-method": "tools/call" },
    });
    expect(response.status).toBe(400);
  });

  test("a Mcp-Name header that disagrees with the called tool is refused", async () => {
    // The routed name is part of the envelope for `tools/call`, so a header naming a
    // different tool than the body cannot be allowed to reach dispatch.
    const response = await rpc(
      "tools/call",
      { name: "record_observation", arguments: args() },
      token,
      { headers: { "mcp-name": "something_else" } },
    );
    expect(response.status).toBe(400);
  });
});

describe("the served path", () => {
  test("the endpoint is under the versioned API prefix, and nothing answers off it", async () => {
    expect(MCP_PATH).toBe(`${API_PREFIX}/mcp`);
    expect(new URL(url).pathname).toBe(MCP_PATH);

    // A fully valid request, aimed at the unversioned path. A 404 here is what proves
    // the prefix is the route and not just a label on the published URL.
    const origin = new URL(url).origin;
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/list",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9999,
        method: "tools/list",
        params: envelope({}),
      }),
    });
    expect(response.status).toBe(404);
  });
});

describe("MCP authorization", () => {
  test("a request with no bearer token is rejected before any tool runs", async () => {
    const response = await callTool(args(), null);
    expect(response.status).toBe(401);
  });

  test("an unknown bearer token is rejected", async () => {
    const response = await callTool(args(), "deadbeef");
    expect(response.status).toBe(401);
  });

  test("tools/list is unavailable without a credential", async () => {
    const response = await rpc("tools/list", {}, null);
    expect(response.status).toBe(401);
  });

  test("the auth boundary refuses before any protocol handling", async () => {
    // Fail closed means closed. `initialize` is not a method this revision implements,
    // but an anonymous caller must not learn even that: the middleware answers 401
    // before the request reaches protocol dispatch at all.
    const response = await rpc("initialize", {}, null);
    expect(response.status).toBe(401);
  });

  test("a round credential is refused at the worker endpoint, before any tool", async () => {
    // **This changed in slice 7 and the change is the point.** It used to be a `200` with
    // a tool refusal: the credential was valid, the request reached the global toolkit, and
    // `store.recordObservation`'s authority path refused it by name. The authority boundary
    // held and the tool *list* disagreed with it — a round's session could see
    // `record_observation`.
    //
    // Now the worker endpoint serves one role. A resolved grant of another kind is refused
    // `401` before protocol dispatch, so a round does not reach the tool, does not get a
    // tool list, and does not learn that this path exists. The store's refusal is still
    // there and still tested — `store.test.ts` drives it directly — it is simply no longer
    // reachable from here, which is what "the tool surface matches the authority" means.
    const response = await callTool(
      args({ operation_id: "op-round-credential" }),
      roundToken,
    );
    expect(response.status).toBe(401);
  });

  test("a goal credential with no expiry is refused at the worker endpoint too", async () => {
    const response = await callTool(
      args({ operation_id: "op-goal-credential" }),
      goalToken,
    );
    expect(response.status).toBe(401);
  });

  test("the refusal is indistinguishable from an unknown token, deliberately", async () => {
    // A distinct status or body for "valid credential, wrong endpoint" would tell a caller
    // at the wrong door that the credential it holds is real. Both answers are the same
    // `401` with the same body; the distinction is in the log, where the operator is.
    const wrongKind = await rpc("tools/list", {}, roundToken);
    const unknown = await rpc("tools/list", {}, "deadbeef");
    expect(wrongKind.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongKind.body).toEqual(unknown.body);
  });

  test("neither credential of the wrong kind wrote anything", async () => {
    // The refusals above are only worth having if they are also writes that did not
    // happen. The attempt's own observations are the ones the tests below record; what
    // is asserted here is that no observation exists under the round's or the goal's
    // scope, which is checked by the receipt keys they would have written.
    const sqlite = new (await import("bun:sqlite")).Database(databaseFile, {
      readonly: true,
    });
    const receipts = sqlite
      .query(
        `SELECT key FROM command_receipts
         WHERE caller_scope LIKE 'target-1/round/%' OR caller_scope LIKE 'target-1/goal/%'`,
      )
      .all();
    const observations = sqlite
      .query(
        `SELECT id FROM observations WHERE attempt_id NOT IN ('attempt-1')`,
      )
      .all();
    sqlite.close();
    expect(receipts).toEqual([]);
    expect(observations).toEqual([]);
  });
});

describe("credential lifetime", () => {
  test("an expired grant fails closed", async () => {
    const resolved = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const credentials = yield* McpCredentials;
          const issued = yield* credentials.issue(CREDENTIAL, 1_000);
          const raw = Redacted.value(issued.token);
          const live = yield* credentials.resolve(raw);
          yield* Effect.sleep(1_100);
          const expired = yield* credentials.resolve(raw);
          return { live, expired };
        }).pipe(Effect.provide(McpCredentials.layer)),
      ),
    );
    expect(resolved.live).toBeDefined();
    expect(resolved.expired).toBeUndefined();
  });

  test("a grant does not outlive its scope, even when the scope fails", async () => {
    // The old code revoked only on the success path, so a failure between issuing the
    // credential and finishing the attempt left a live credential behind.
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* McpCredentials;
        let raw = "";
        yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const issued = yield* credentials.issue(CREDENTIAL);
              raw = Redacted.value(issued.token);
              return yield* Effect.fail("registration blew up");
            }),
          ),
        );
        return {
          afterFailure: yield* credentials.resolve(raw),
          live: yield* credentials.size,
        };
      }).pipe(Effect.provide(McpCredentials.layer)),
    );
    expect(outcome.afterFailure).toBeUndefined();
    expect(outcome.live).toBe(0);
  });

  test("a grant does not outlive its scope when the fiber is interrupted", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* McpCredentials;
        let raw = "";
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const issued = yield* credentials.issue(CREDENTIAL);
              raw = Redacted.value(issued.token);
              yield* Effect.never;
            }),
          ),
        );
        // Let the fork reach `Effect.never` before interrupting it.
        yield* Effect.sleep(20);
        yield* Fiber.interrupt(fiber);
        return {
          afterInterrupt: yield* credentials.resolve(raw),
          live: yield* credentials.size,
        };
      }).pipe(Effect.provide(McpCredentials.layer)),
    );
    expect(outcome.afterInterrupt).toBeUndefined();
    expect(outcome.live).toBe(0);
  });

  test("the registry holds no raw token", async () => {
    const leaked = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const credentials = yield* McpCredentials;
          const issued = yield* credentials.issue(CREDENTIAL);
          // `Redacted` also keeps it out of any accidental rendering.
          return {
            raw: Redacted.value(issued.token),
            rendered: String(issued.token),
            serialised: JSON.stringify(credentials),
          };
        }).pipe(Effect.provide(McpCredentials.layer)),
      ),
    );
    expect(leaked.rendered).not.toContain(leaked.raw);
    expect(leaked.serialised).not.toContain(leaked.raw);
  });
});

describe("advertised schema parity", () => {
  test("the advertised inputSchema is the wire schema, snake_case and complete", async () => {
    const response = await rpc("tools/list", {});
    const tools = (
      response.body?.["result"] as {
        tools?: Array<{
          name: string;
          description: string;
          inputSchema: {
            properties: Record<string, unknown>;
            required: string[];
          };
        }>;
      }
    )?.tools;
    // Looked up by name rather than taken at index 0: the worker endpoint advertises
    // `record_asset` beside this one, and a positional read would start asserting
    // whichever tool `Toolkit.make` happened to list first.
    const tool = tools?.find((listed) => listed.name === "record_observation");
    expect(tool?.name).toBe("record_observation");
    expect(tool?.description).toContain("inconclusive, not negative");

    // Every advertised key must be a key the decoder accepts, and vice versa. This is
    // what makes the single wire schema worth having: the two cannot drift.
    const advertised = Object.keys(tool?.inputSchema.properties ?? {}).sort();
    const decoded = Object.keys(
      Schema.toJsonSchemaDocument(RecordObservation.parametersSchema).schema
        .properties ?? {},
    ).sort();
    expect(advertised).toEqual(decoded);
    expect(advertised).toContain("operation_id");
    expect(advertised).toContain("untested_dimensions");
    expect(advertised).toContain("addresses_dimensions");
    expect(advertised).toContain("setup");
    expect(advertised).toContain("cases");
    // The fields the multi-case shape replaced must be gone from the advertised schema,
    // not merely unused: a worker that still sends them should be told.
    expect(advertised).not.toContain("conditions");
    expect(advertised).not.toContain("observed_behavior");
    expect(advertised).not.toContain("evidence_refs");
    expect(tool?.inputSchema.required.sort()).toEqual(advertised);
  });

  test("field descriptions reach the advertised schema", async () => {
    const response = await rpc("tools/list", {});
    const tool = (
      response.body?.["result"] as {
        tools?: Array<{
          name: string;
          inputSchema: {
            properties: Record<string, { description?: string }>;
          };
        }>;
      }
    )?.tools?.find((listed) => listed.name === "record_observation");
    expect(tool?.inputSchema.properties["operation_id"]?.description).toContain(
      "exact retry",
    );
  });

  test("the nested case schema is advertised in snake_case too", async () => {
    // `Schema.encodeKeys` renames one struct's own keys and does not recurse, so the
    // nested wire schemas are substituted by hand in `@bit/contracts`. If that is ever
    // missed, the advertised case would be camelCase while the decoder expects
    // snake_case — which is exactly the drift the single-schema approach exists to stop.
    const document = Schema.toJsonSchemaDocument(
      RecordObservation.parametersSchema,
    );
    const text = JSON.stringify(document);
    for (const key of [
      "test_bounds",
      "window_start",
      "window_end",
      "actor_id",
      "request_count",
      "observed_behavior",
      "evidence_refs",
      "client_identity",
    ]) {
      expect(text).toContain(`"${key}"`);
    }
    for (const camel of [
      "testBounds",
      "windowStart",
      "actorId",
      "requestCount",
      "observedBehavior",
      "clientIdentity",
    ]) {
      expect(text).not.toContain(`"${camel}"`);
    }
  });
});

describe("record_observation over MCP", () => {
  test("records an observation and derives provenance from the credential", async () => {
    const { isError, data } = payloadOf((await callTool(args())).body);
    expect(isError).toBe(false);
    expect(data["replayed"]).toBe(false);
    const provenance = data["provenance"] as Record<string, unknown>;
    expect(provenance["intent_id"]).toBe("intent-1");
    expect(provenance["attempt_id"]).toBe("attempt-1");
    expect(provenance["harness_session_id"]).toBe("ses_test");
  });

  test("ignores provenance a caller tries to assert in the payload", async () => {
    const { data } = payloadOf(
      (
        await callTool(
          args({
            operation_id: "op-http-spoof",
            intent_id: "intent-999",
            attempt_id: "attempt-999",
            target_id: "someone-elses-target",
          }),
        )
      ).body,
    );
    const provenance = data["provenance"] as Record<string, unknown>;
    expect(provenance["intent_id"]).toBe("intent-1");
    expect(provenance["attempt_id"]).toBe("attempt-1");
    expect(provenance["target_id"]).toBe("target-1");
  });

  test("an exact retry replays rather than writing twice", async () => {
    const first = payloadOf(
      (await callTool(args({ operation_id: "op-retry" }))).body,
    );
    const second = payloadOf(
      (await callTool(args({ operation_id: "op-retry" }))).body,
    );

    expect(first.data["replayed"]).toBe(false);
    expect(second.data["replayed"]).toBe(true);
    expect(second.data["observation_id"]).toBe(first.data["observation_id"]);
    expect(second.data["sequence"]).toBe(first.data["sequence"]);
  });

  test("an operation ID reused with different content is returned as a refusal", async () => {
    await callTool(args({ operation_id: "op-conflict" }));
    const { isError, data } = payloadOf(
      (
        await callTool(
          args({ operation_id: "op-conflict", outcome: "negative" }),
        )
      ).body,
    );

    // `failureMode: "return"` keeps this a tool result the worker can read and act on,
    // rather than an error that costs it the turn.
    expect(isError).toBe(true);
    expect(data["reason"]).toBe("conflict");
    expect(String(data["detail"])).toContain("op-conflict");
  });

  test("an unknown outcome value is refused by the contract schema", async () => {
    const { rpcError } = payloadOf(
      (await callTool(args({ operation_id: "op-bad", outcome: "vulnerable" })))
        .body,
    );
    expect(rpcError).toContain("Invalid parameters");
    expect(rpcError).toContain("outcome");
  });

  test("a missing required field is refused", async () => {
    const incomplete = args({ operation_id: "op-missing" }) as Record<
      string,
      unknown
    >;
    delete incomplete["limitations"];
    const { rpcError } = payloadOf((await callTool(incomplete)).body);
    expect(rpcError).toContain("limitations");
  });

  test("a non-finite epoch is refused rather than stored", async () => {
    // `Schema.Finite` exists on these fields precisely so a NaN window cannot be
    // persisted and then read back as a time.
    const cases = args()["cases"] as Array<Record<string, unknown>>;
    const { rpcError } = payloadOf(
      (
        await callTool(
          args({
            operation_id: "op-nan",
            cases: [{ ...cases[0], window_start: "NaN" }],
          }),
        )
      ).body,
    );
    expect(rpcError).toContain("window_start");
  });

  test("an action naming an actor the case never declared is refused", async () => {
    // A cross-field rule, enforced on the wire schema as well as the domain one: the
    // checks are shared, so the boundary cannot be laxer than the store.
    const cases = args()["cases"] as Array<Record<string, unknown>>;
    const actions = cases[0]?.["actions"] as Array<Record<string, unknown>>;
    const { rpcError } = payloadOf(
      (
        await callTool(
          args({
            operation_id: "op-ghost-actor",
            cases: [
              {
                ...cases[0],
                actions: [{ ...actions[0], actor_id: "ghost" }],
              },
            ],
          }),
        )
      ).body,
    );
    expect(rpcError).toContain("Invalid parameters");
  });

  test("an empty cases list is refused", async () => {
    const { rpcError } = payloadOf(
      (await callTool(args({ operation_id: "op-no-cases", cases: [] }))).body,
    );
    expect(rpcError).toContain("cases");
  });

  test("a follow-up address that does not resolve is returned as a refusal", async () => {
    // The worker is told exactly what was wrong, because the address is the one thing
    // it cannot derive: it has to have come from a briefing.
    const { isError, data } = payloadOf(
      (
        await callTool(
          args({
            operation_id: "op-bad-address",
            addresses_dimensions: ["obs_999999_attempt-1#u0"],
          }),
        )
      ).body,
    );

    expect(isError).toBe(true);
    expect(data["reason"]).toBe("invalid");
    expect(String(data["detail"])).toContain("obs_999999_attempt-1#u0");
  });

  test("a real follow-up address is accepted and recorded", async () => {
    const first = payloadOf(
      (
        await callTool(
          args({
            operation_id: "op-raises",
            untested_dimensions: ["a gap worth addressing"],
          }),
        )
      ).body,
    );
    const raiser = String(first.data["observation_id"]);

    const { isError } = payloadOf(
      (
        await callTool(
          args({
            operation_id: "op-addresses",
            addresses_dimensions: [`${raiser}#u0`],
          }),
        )
      ).body,
    );
    const links = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        store.dimensionLinksForIntent("intent-1"),
      ),
    );

    expect(isError).toBe(false);
    expect(links.map((link) => link.address)).toContain(`${raiser}#u0`);
  });

  test("an observation under a settled attempt is refused as stale over the wire", async () => {
    // The refusal a worker has to be able to act on: its attempt is no longer the live
    // one, so nothing further will be recorded — and what it already recorded is safe.
    const { isError, data } = payloadOf(
      (await callTool(args({ operation_id: "op-stale" }), staleToken)).body,
    );

    // The credential itself is still live: the 401 boundary let it through, and the
    // store refused the write. Those are different failures and must stay so.
    expect(isError).toBe(true);
    expect(data["reason"]).toBe("stale");
    expect(String(data["detail"])).toContain("interrupted");
  });

  test("an unknown tool name is refused", async () => {
    const response = await rpc("tools/call", {
      name: "drop_everything",
      arguments: {},
    });
    const error = response.body?.["error"] as { message?: string } | undefined;
    expect(error?.message).toContain("drop_everything");
  });

  test("only the accepted writes reached the database", async () => {
    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        store.observationsForIntent("intent-1"),
      ),
    );
    // op-http-1, op-http-spoof, op-retry, op-conflict, op-raises, op-addresses:
    // six accepted operations, all under the one live attempt.
    expect(stored).toHaveLength(6);
    expect(stored.every((o) => o.provenance.attemptId === "attempt-1")).toBe(
      true,
    );
    // Everything written through the tool is in the current record format.
    expect(stored.every((o) => o._tag === "caseBased")).toBe(true);
  });

  test("a case submitted in snake_case reads back as the camelCase domain value", async () => {
    // The full round trip: wire decode, storage, stored decode. Nothing in between is
    // allowed to lose the association between an actor and what it saw.
    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        store.observationsForIntent("intent-1"),
      ),
    );
    const first = stored.find((o) => o.observationId.endsWith("attempt-1"));
    expect(first?._tag).toBe("caseBased");
    if (first?._tag !== "caseBased") return;
    expect(first.cases[0].id).toBe("case-saturate");
    expect(first.cases[0].actors[0]?.clientIdentity).toContain("fixed-a");
    expect(first.cases[0].actions[0]?.actorId).toBe("fixed");
    expect(first.cases[0].actions[0]?.requestCount).toBe(11);
    expect(first.cases[0].testBounds).toContain("11 requests");
  });

  test("the endpoint counted the authenticated requests it served", async () => {
    const served = await runtime.runPromise(
      Effect.flatMap(ControlPlaneEndpoint, (endpoint) => endpoint.callCount),
    );
    expect(served).toBeGreaterThan(0);
  });
});
