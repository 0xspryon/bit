/**
 * Tests `record_asset` over real HTTP against a real SQLite file.
 *
 * The tool is the first slice of the target-scope design, and it is a precondition for
 * the rest of it: without a way to record a discovered artefact there is nothing to
 * label, and the design's second stated goal — that the operator can watch the client's
 * estate accumulate — is unreachable. `store.recordAsset` and the `RecordAssetInput`
 * contract already existed and were exercised only by `spike/persistenceProof.ts`; what
 * is new is the tool, so what is tested here is the tool's own boundary.
 *
 * Four properties, and the last two are the ones a reader should look for first:
 *
 * - A host and an endpoint both land, in `assets`, with their discovery rows.
 * - **An exact retry under one `operation_id` returns the first result and writes
 *   nothing.** That is the receipt, and it is what makes a lost HTTP response safe.
 * - **A different `operation_id` that finds the same canonical asset is new provenance
 *   about a known thing**, not a duplicate and not a replay. The two flags that say so
 *   are different flags and this asserts them apart, because conflating them is how a
 *   reader comes to believe a retry created something.
 * - An asset no scope entry would cover is still recorded. The design's Non-goals say
 *   recording is never gated, because recording an out-of-scope discovery is how the
 *   operator comes to know it exists — so there is nothing here that refuses one, and
 *   this file asserts that absence rather than leaving it to be inferred.
 *
 * The harness follows `mcp/server.test.ts`: one `ManagedRuntime` owning the layer stack,
 * a real credential issued into the layer's scope, and the stateless 2026-07-28 envelope
 * built once rather than per test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect";

import {
  ObservationStore,
  operatorScope,
  type StoredAsset,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { McpCredentials, type IssuedCredential } from "./credentials";
import { McpCallCounter } from "./server";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { DEFAULT_POLICY, PolicyDecisions } from "../policy/service";
import { RecordAsset } from "./tools";

const directory = mkdtempSync(join(tmpdir(), "bit-record-asset-"));
const databaseFile = join(directory, "hunt.sqlite");

const BINDING = {
  _tag: "attempt",
  targetId: "target-1",
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_test",
  workerId: "worker-1",
} as const;

/** `0` is the fence a freshly seeded attempt carries, so this is the live authority. */
const CREDENTIAL = { ...BINDING, attemptFence: 0 } as const;

class TestCredential extends Context.Service<
  TestCredential,
  IssuedCredential
>()("test/RecordAssetCredential") {
  static readonly layer = Layer.effect(
    TestCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue(CREDENTIAL),
    ),
  );
}

const testLayer = Layer.mergeAll(
  ControlPlaneEndpoint.layer({ policy: DEFAULT_POLICY }),
  TestCredential.layer,
).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provideMerge(
    TargetStores.ofStore(BINDING.targetId).pipe(
      Layer.provide(ObservationStore.layer(databaseFile)),
    ),
  ),
  Layer.provideMerge(ObservationStore.layer(databaseFile)),
);

const runtime = ManagedRuntime.make(testLayer);

let url = "";
let token = "";

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* ObservationStore;
      // The attempt has to exist and be running: `checkAttemptAuthority` reads the row,
      // and `asset_discoveries` has real foreign keys to `intents` and `attempts`.
      yield* store.seedAttempt({
        ...BINDING,
        goalId: "goal-1",
        goal: "Map the client's externally reachable estate.",
        question: "What hosts and endpoints answer on the authorized ranges?",
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        modelOptions: null,
      });
      const endpoint = yield* ControlPlaneEndpoint;
      url = endpoint.mcpUrl;
      token = Redacted.value((yield* TestCredential).token);
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

let nextId = 1;

const PROTOCOL_VERSION = "2026-07-28";

/**
 * The stateless revision's envelope.
 *
 * There is no handshake and no session id, so every request carries its own protocol
 * claim and `Mcp-Method`; `tools/call` additionally routes on `params.name`, which is why
 * `Mcp-Name` is set from the tool being called rather than hard-coded.
 */
const rpc = async (method: string, params: Record<string, unknown>) => {
  const routedName = params["name"];
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(typeof routedName === "string" ? { "mcp-name": routedName } : {}),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
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

interface ToolOutcome {
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
  readonly text: string;
}

/**
 * Reads a tool response without assuming which channel carried a refusal.
 *
 * This revision reports a schema-invalid payload as a tool error rather than a JSON-RPC
 * one, and a `failureMode: "return"` refusal comes back as prose in the first text block.
 * Either way the call was refused and nothing was written, so this reads both and the
 * tests do not care which channel the protocol chose. The text block is parsed as JSON
 * only when it looks like JSON, because a refusal message is prose.
 */
const outcomeOf = (body: Record<string, unknown> | null): ToolOutcome => {
  const result = body?.["result"] as
    | {
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }
    | undefined;
  const text = result?.content?.[0]?.text ?? "";
  const rpcError = (body?.["error"] as { message?: string } | undefined)
    ?.message;
  return {
    isError: result?.isError === true || rpcError !== undefined,
    data:
      result?.structuredContent ??
      (text.startsWith("{")
        ? (JSON.parse(text) as Record<string, unknown>)
        : {}),
    text: rpcError ?? text,
  };
};

const record = async (args: Record<string, unknown>): Promise<ToolOutcome> =>
  outcomeOf(
    (await rpc("tools/call", { name: "record_asset", arguments: args })).body,
  );

/** Every asset in the file, which is the only target these credentials name. */
const storedAssets = (): Promise<readonly StoredAsset[]> =>
  runtime.runPromise(
    Effect.flatMap(ObservationStore, (store) => store.assets()),
  );

const discoveriesOf = (assetId: string) =>
  runtime.runPromise(
    Effect.flatMap(ObservationStore, (store) =>
      store.discoveriesOfAsset(assetId),
    ),
  );

/* ── The tool is on this endpoint, and its schema is the contract's ──────────────── */

describe("the advertised tool", () => {
  test("record_asset is offered to a worker, in snake_case", async () => {
    const tools = (
      (await rpc("tools/list", {})).body?.["result"] as {
        tools?: Array<{
          name: string;
          description: string;
          inputSchema: { properties: Record<string, unknown> };
        }>;
      }
    )?.tools;
    const tool = tools?.find((listed) => listed.name === "record_asset");
    expect(tool).toBeDefined();

    // Every advertised key must be a key the decoder accepts, and vice versa — the
    // property the single wire schema exists to give.
    const advertised = Object.keys(tool?.inputSchema.properties ?? {}).sort();
    const decoded = Object.keys(
      Schema.toJsonSchemaDocument(RecordAsset.parametersSchema).schema
        .properties ?? {},
    ).sort();
    expect(advertised).toEqual(decoded);
    expect(advertised).toEqual([
      "kind",
      "method",
      "note",
      "operation_id",
      "url",
    ]);
    // `operationId` would mean the advertised name and the decoded one had drifted.
    expect(advertised).not.toContain("operationId");
  });

  test("the description tells a worker to record what is out of scope too", async () => {
    const tools = (
      (await rpc("tools/list", {})).body?.["result"] as {
        tools?: Array<{ name: string; description: string }>;
      }
    )?.tools;
    const description =
      tools?.find((listed) => listed.name === "record_asset")?.description ??
      "";
    // The design's Non-goals: recording is never gated, because recording an
    // out-of-scope discovery is how the operator comes to know about it. A worker that
    // believed otherwise would silently drop the discoveries that matter most.
    expect(description).toContain("whether or not it is in scope");
    expect(description).toContain("Recording is not a claim of authorization");
  });
});

/* ── What a recorded asset looks like in the file ────────────────────────────────── */

describe("recording a host and an endpoint", () => {
  test("a host lands with its discovery row", async () => {
    const outcome = await record({
      operation_id: "op-host-1",
      kind: "host",
      url: "https://app.acme.test:443/",
      method: null,
      note: "Answered a TLS handshake on the authorized range.",
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.data["kind"]).toBe("host");
    // Identity is `host:port`, with the default port made explicit from the scheme.
    expect(outcome.data["identity"]).toBe("app.acme.test:443");
    expect(outcome.data["created"]).toBe(true);
    expect(outcome.data["replayed"]).toBe(false);
    expect(outcome.data["discoveries"]).toBe(1);

    const assetId = String(outcome.data["asset_id"]);
    const assets = await storedAssets();
    const stored = assets.find((asset) => asset.id === assetId);
    expect(stored?.kind).toBe("host");
    expect(stored?.host).toBe("app.acme.test");
    expect(stored?.port).toBe(443);
    // A host has no method, scheme or path, and the table's CHECK enforces it.
    expect(stored?.method).toBeNull();
    expect(stored?.scheme).toBeNull();
    expect(stored?.path).toBeNull();

    const discoveries = await discoveriesOf(assetId);
    expect(discoveries).toHaveLength(1);
    // The provenance migration `0010` makes `NOT NULL`, carried from the credential and
    // not from any argument the model sent.
    expect(discoveries[0]?.intent_id).toBe(BINDING.intentId);
    expect(discoveries[0]?.attempt_id).toBe(BINDING.attemptId);
    expect(discoveries[0]?.operation_id).toBe("op-host-1");
    // The URL as submitted is kept verbatim, so nothing about how it was found is lost
    // to normalisation.
    expect(discoveries[0]?.discovered_as).toBe("https://app.acme.test:443/");
    expect(discoveries[0]?.note).toContain("TLS handshake");
  });

  test("an endpoint lands with its method, scheme and path", async () => {
    const outcome = await record({
      operation_id: "op-endpoint-1",
      kind: "endpoint",
      url: "https://app.acme.test/v1/orders?page=2#top",
      method: "get",
      note: "Linked from the dashboard; returned a tenant-scoped list.",
    });

    expect(outcome.isError).toBe(false);
    // Method upper-cased, scheme lower-cased, port explicit — and the query and fragment
    // are deliberately NOT part of identity, so `?page=2` does not mint a second asset.
    expect(outcome.data["identity"]).toBe(
      "GET https://app.acme.test:443/v1/orders",
    );
    expect(outcome.data["created"]).toBe(true);

    const assetId = String(outcome.data["asset_id"]);
    const stored = (await storedAssets()).find((asset) => asset.id === assetId);
    expect(stored?.kind).toBe("endpoint");
    expect(stored?.method).toBe("GET");
    expect(stored?.scheme).toBe("https:");
    expect(stored?.path).toBe("/v1/orders");
    expect(stored?.host).toBe("app.acme.test");

    // The full URL, query string and all, survives on the discovery record.
    const discoveries = await discoveriesOf(assetId);
    expect(discoveries[0]?.discovered_as).toBe(
      "https://app.acme.test/v1/orders?page=2#top",
    );
  });

  test("an asset no in-scope entry would cover is recorded all the same", async () => {
    // The design's Non-goals, as a test rather than a sentence: ScopeWeaver refuses to
    // insert an out-of-scope asset, and that is deliberately not ported. There is no
    // scope authored on this target at all, so by the default-is-out rule this host is
    // covered by nothing — and it still lands.
    const outcome = await record({
      operation_id: "op-uncovered-1",
      kind: "host",
      url: "http://api.acme-cdn.test:80/",
      method: null,
      note: "Named in a CORS header on an in-scope host.",
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.data["created"]).toBe(true);
    const identities = (await storedAssets()).map((asset) => asset.identity);
    expect(identities).toContain("api.acme-cdn.test:80");
  });
});

/* ── The receipt, and the thing it is not ────────────────────────────────────────── */

describe("one operation, recorded once", () => {
  test("an exact retry returns the first result and writes nothing", async () => {
    const first = await record({
      operation_id: "op-retry",
      kind: "host",
      url: "https://retry.acme.test/",
      method: null,
      note: "Found in a certificate transparency log.",
    });
    expect(first.data["replayed"]).toBe(false);
    const assetId = String(first.data["asset_id"]);
    const before = await discoveriesOf(assetId);

    const retry = await record({
      operation_id: "op-retry",
      kind: "host",
      url: "https://retry.acme.test/",
      method: null,
      note: "Found in a certificate transparency log.",
    });

    expect(retry.isError).toBe(false);
    // The original result, byte for byte, with the one flag that says it is a replay.
    expect(retry.data["asset_id"]).toBe(assetId);
    expect(retry.data["identity"]).toBe(first.data["identity"]);
    expect(retry.data["created"]).toBe(first.data["created"]);
    expect(retry.data["discoveries"]).toBe(first.data["discoveries"]);
    expect(retry.data["replayed"]).toBe(true);

    // Nothing was written: `asset_discoveries` is keyed `(asset_id, operation_id)`, so a
    // replay that did write would be invisible here — which is why the count is read
    // rather than the row.
    expect(await discoveriesOf(assetId)).toHaveLength(before.length);
  });

  test("the same operation_id with different input is a conflict, and writes nothing", async () => {
    await record({
      operation_id: "op-conflict",
      kind: "host",
      url: "https://conflict.acme.test/",
      method: null,
      note: "First claim about this id.",
    });
    const before = (await storedAssets()).length;

    const second = await record({
      operation_id: "op-conflict",
      kind: "host",
      url: "https://other.acme.test/",
      method: null,
      note: "A different asset under the id already spent.",
    });

    // `failureMode: "return"` keeps it a tool result the worker can read and act on,
    // rather than an error that costs it the turn.
    expect(second.isError).toBe(true);
    expect(second.data["reason"]).toBe("conflict");
    expect(String(second.data["detail"])).toContain("op-conflict");
    // The transaction rolled back, so the second asset does not exist.
    expect((await storedAssets()).length).toBe(before);
    expect((await storedAssets()).map((asset) => asset.identity)).not.toContain(
      "other.acme.test:443",
    );
  });

  test("a new operation finding a known asset is provenance, not a replay", async () => {
    const first = await record({
      operation_id: "op-shared-1",
      kind: "host",
      url: "https://shared.acme.test/",
      method: null,
      note: "Seen in DNS.",
    });
    expect(first.data["created"]).toBe(true);
    expect(first.data["discoveries"]).toBe(1);

    // The same canonical asset, written three ways: a trailing dot and an explicit
    // default port both normalise onto the row above.
    const second = await record({
      operation_id: "op-shared-2",
      kind: "host",
      url: "https://SHARED.acme.test.:443/",
      method: null,
      note: "Seen again in a TLS SAN list.",
    });

    expect(second.isError).toBe(false);
    expect(second.data["asset_id"]).toBe(first.data["asset_id"]);
    // Neither created nor replayed: a different operation found a known thing, and both
    // facts are kept. Collapsing these two flags is how a reader comes to believe a
    // retry created something.
    expect(second.data["created"]).toBe(false);
    expect(second.data["replayed"]).toBe(false);
    expect(second.data["discoveries"]).toBe(2);

    const discoveries = await discoveriesOf(String(first.data["asset_id"]));
    expect(discoveries.map((row) => row.operation_id).sort()).toEqual([
      "op-shared-1",
      "op-shared-2",
    ]);
  });
});

/* ── Refusals a worker is meant to read ──────────────────────────────────────────── */

describe("what is refused", () => {
  test("a url that is not absolute is refused instructively, and nothing is written", async () => {
    const before = (await storedAssets()).length;
    const outcome = await record({
      operation_id: "op-bad-url",
      kind: "host",
      url: "app.acme.test",
      method: null,
      note: "A bare host name rather than a URL.",
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.data["reason"]).toBe("invalid");
    // `assetIdentityOf`'s own sentence, which names the remedy rather than the rule.
    expect(String(outcome.data["detail"])).toContain("is not an absolute URL");
    expect(String(outcome.data["detail"])).toContain(
      "http://127.0.0.1:8080/login",
    );
    expect((await storedAssets()).length).toBe(before);
  });

  test("a host with a method is refused by the contract, before the store", async () => {
    const before = (await storedAssets()).length;
    const outcome = await record({
      operation_id: "op-host-with-method",
      kind: "host",
      url: "https://method.acme.test/",
      method: "GET",
      note: "A host cannot carry a method.",
    });

    expect(outcome.isError).toBe(true);
    // The cross-field check is on the wire schema, so this never reaches the store: the
    // text is the decoder's, not a refusal reason of ours.
    expect(outcome.text).toContain("method");
    expect((await storedAssets()).length).toBe(before);
  });

  test("an endpoint without a method is refused by the contract too", async () => {
    const outcome = await record({
      operation_id: "op-endpoint-no-method",
      kind: "endpoint",
      url: "https://method.acme.test/admin",
      method: null,
      note: "An endpoint needs a method.",
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("method");
  });

  test("an unknown kind is refused by the contract schema", async () => {
    // `AssetKind` stays `host | endpoint`. An early mockup raised a `service` kind and
    // the operator withdrew it, so a worker sending one should be told rather than have
    // it quietly coerced.
    const outcome = await record({
      operation_id: "op-service-kind",
      kind: "service",
      url: "https://service.acme.test:8443/",
      method: null,
      note: "Not a kind this build knows.",
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("kind");
  });
});

/* ── Reading back what the hunt has found ────────────────────────────────────────── */

/* ── What the tool tells the agent about scope ───────────────────────────────────── */

/**
 * D9's last sentence: "the tool reports the asset's scope state in its result, so an
 * agent that records an out-of-scope host is told so immediately rather than finding out
 * never."
 *
 * Nothing asserted it on the tool path. `RecordAssetResult` carries `scopeState` and
 * `scopeDetail` for exactly this, and a handler that returned the constants `out` and
 * "not covered by any in-scope entry" passed the whole suite — which would tell every
 * agent that everything it records is outside the client's estate, on every target,
 * forever. So both directions are asserted here, through HTTP, against a real scope
 * authored by the only writer that may author one.
 */
describe("the scope state in the result", () => {
  beforeAll(async () => {
    await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        Effect.gen(function* () {
          const operator = {
            callerScope: operatorScope(BINDING.targetId),
            targetId: BINDING.targetId,
          };
          yield* store.addScopeEntry(operator, {
            effect: "in",
            kind: "subtree",
            value: "acme.test",
            source: "operator",
          });
          yield* store.addScopeEntry(operator, {
            effect: "out",
            kind: "host",
            value: "blog.acme.test",
            source: "operator",
          });
        }),
      ),
    );
  });

  test("an asset an entry covers comes back in scope, naming the entry", async () => {
    const outcome = await record({
      operation_id: "op-scope-in",
      kind: "host",
      url: "https://portal.acme.test:443/",
      method: null,
      note: "A subdomain of the authorized apex.",
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.data["scope_state"]).toBe("in");
    // The sentence, from the same renderer the prompt block and the screen use, so the
    // agent is told *what* decided it rather than one word.
    expect(outcome.data["scope_detail"]).toBe(
      "in scope: acme.test and every subdomain",
    );
  });

  test("an asset an out entry names comes back out, and is still recorded", async () => {
    const outcome = await record({
      operation_id: "op-scope-out",
      kind: "endpoint",
      url: "https://blog.acme.test/wp-login.php",
      method: "get",
      note: "A login form on the host the programme excludes.",
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.data["scope_state"]).toBe("out");
    expect(outcome.data["scope_detail"]).toBe(
      "explicitly out of scope: blog.acme.test (that host only)",
    );
    // Out is a label and never a gate: the row is in the file.
    const identities = (await storedAssets()).map((asset) => asset.identity);
    expect(identities).toContain("GET https://blog.acme.test:443/wp-login.php");
  });

  test("an asset nothing covers says so, and does not say it was denied", async () => {
    const outcome = await record({
      operation_id: "op-scope-uncovered",
      kind: "host",
      url: "https://partner-cdn.test:443/",
      method: null,
      note: "Named in a CORS header.",
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.data["scope_state"]).toBe("out");
    /*
     * The wording is load-bearing. "Nothing covers this yet" is a fact about the scope;
     * "you were denied" would be a fact about the call, and this call succeeded. An agent
     * that read the second would stop recording the discoveries the operator most needs.
     */
    expect(outcome.data["scope_detail"]).toBe(
      "not covered by any in-scope entry; recorded for the operator to review",
    );
    expect(String(outcome.data["scope_detail"])).not.toContain("denied");
  });

  test("a hand label beats the entries here too, from the one ladder", async () => {
    // Promotion is an operator act over the browser API; what is asserted here is that
    // the tool's answer comes off the same ladder, so the agent and the screen cannot
    // disagree about one asset.
    await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        store.setHostScopeLabel(
          {
            callerScope: operatorScope(BINDING.targetId),
            targetId: BINDING.targetId,
          },
          { host: "blog.acme.test", state: "in", reason: "carved out by hand" },
        ),
      ),
    );
    const outcome = await record({
      operation_id: "op-scope-promoted",
      kind: "endpoint",
      url: "https://blog.acme.test/xmlrpc.php",
      method: "post",
      note: "Found after the operator promoted the host.",
    });
    expect(outcome.data["scope_state"]).toBe("in");
    expect(outcome.data["scope_detail"]).toContain(
      "in scope, set by hand on blog.acme.test",
    );
    // And it says which typed entry the label beat, which is what `overrode` is for.
    expect(outcome.data["scope_detail"]).toContain(
      "overriding blog.acme.test (that host only)",
    );
  });
});

describe("list_assets", () => {
  const list = async (): Promise<ToolOutcome> =>
    outcomeOf(
      (await rpc("tools/call", { name: "list_assets", arguments: {} })).body,
    );

  const rowsOf = (
    outcome: ToolOutcome,
  ): ReadonlyArray<Record<string, unknown>> =>
    outcome.data["assets"] as ReadonlyArray<Record<string, unknown>>;

  test("it is offered to a worker and takes no arguments", async () => {
    const tools = (
      (await rpc("tools/list", {})).body?.["result"] as {
        tools?: Array<{
          name: string;
          description: string;
          inputSchema: { properties?: Record<string, unknown> };
        }>;
      }
    )?.tools;
    const tool = tools?.find((listed) => listed.name === "list_assets");
    expect(tool).toBeDefined();
    // `Tool.EmptyParams`: there is no filter and no cursor, so there is nothing to send.
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([]);
    // D10, in the words the agent reads.
    expect(tool?.description).toContain("Nothing is withheld from this list");
  });

  test("a worker reads back everything recorded, including what no entry covers", async () => {
    const outcome = await list();
    expect(outcome.isError).toBe(false);
    const assets = rowsOf(outcome);

    // `total` is the length of the list beside it, not a separate count that could drift.
    expect(outcome.data["total"]).toBe(assets.length);
    expect(assets.length).toBe((await storedAssets()).length);

    const identities = assets.map((asset) => String(asset["identity"]));
    /*
     * Recorded earlier in this file: a host, an endpoint, and the host that no in-scope
     * entry covers.
     *
     * D10 is that the third is returned like the others rather than silently dropped.
     * ScopeWeaver's `GetByIDsInScope` removes out-of-scope ids from a read so "an agent
     * cannot reach out-of-scope assets by id", and *silently* is the problem: an agent
     * that cannot see a host it already found will find it again, and again, because
     * nothing tells it the host is known.
     */
    expect(identities).toContain("app.acme.test:443");
    expect(identities).toContain("GET https://app.acme.test:443/v1/orders");
    expect(identities).toContain("api.acme-cdn.test:80");
  });

  test("each row carries the identity's parts and how it came to be known", async () => {
    const assets = rowsOf(await list());
    const endpoint = assets.find(
      (asset) =>
        asset["identity"] === "GET https://app.acme.test:443/v1/orders",
    );
    expect(endpoint?.["kind"]).toBe("endpoint");
    // The parts sit beside the identity rather than being re-parsed from it, so a reader
    // never has to split a string to answer "which host is this".
    expect(endpoint?.["host"]).toBe("app.acme.test");
    expect(endpoint?.["port"]).toBe(443);
    expect(endpoint?.["method"]).toBe("GET");
    expect(endpoint?.["path"]).toBe("/v1/orders");
    // The provenance aggregate: the attempt that found it first, taken from the
    // credential and not from anything the model sent.
    expect(endpoint?.["first_attempt_id"]).toBe(BINDING.attemptId);
    expect(endpoint?.["discoveries"]).toBe(1);

    const host = assets.find(
      (asset) => asset["identity"] === "app.acme.test:443",
    );
    expect(host?.["kind"]).toBe("host");
    // A host has no method and no path, and the row says so rather than omitting them.
    expect(host?.["method"]).toBeNull();
    expect(host?.["path"]).toBeNull();
  });

  test("every row says whether the scope covers it, and what decided it", async () => {
    /*
     * The other half of D10, and the half that was missing.
     *
     * "Returning the row with its label costs one field and removes the rediscovery
     * loop" — and without the label the read is worse than the silent filter it argues
     * against: an agent can see the host, cannot see that the operator excluded it, and
     * goes on to test it. The wire shape carried no scope field at all, so this is the
     * assertion that keeps it there.
     *
     * The three states come from the scope authored above: an entry, an `out` entry
     * beaten by a hand label, and nothing at all.
     */
    const assets = rowsOf(await list());
    const stateOf = (identity: string) =>
      assets.find((asset) => asset["identity"] === identity);

    const covered = stateOf("portal.acme.test:443");
    expect(covered?.["scope_state"]).toBe("in");
    expect(covered?.["scope_detail"]).toBe(
      "in scope: acme.test and every subdomain",
    );

    const uncovered = stateOf("api.acme-cdn.test:80");
    expect(uncovered?.["scope_state"]).toBe("out");
    expect(uncovered?.["scope_detail"]).toContain(
      "not covered by any in-scope entry",
    );

    // The hand label outranks the typed entry here exactly as it does on the write and
    // on the screen, because all three read the one ladder.
    const promoted = stateOf("GET https://blog.acme.test:443/wp-login.php");
    expect(promoted?.["scope_state"]).toBe("in");
    expect(promoted?.["scope_detail"]).toContain(
      "in scope, set by hand on blog.acme.test",
    );

    // Nothing is withheld on account of any of it: every stored asset is in the answer.
    expect(assets).toHaveLength((await storedAssets()).length);
  });

  test("an asset two operations found is one row carrying both discoveries", async () => {
    const assets = rowsOf(await list());
    const shared = assets.filter(
      (asset) => asset["identity"] === "shared.acme.test:443",
    );
    // One row, two discoveries — not two rows. The merge is what canonical identity is
    // for, and the count is what keeps the merge visible rather than lossy.
    expect(shared).toHaveLength(1);
    expect(shared[0]?.["discoveries"]).toBe(2);
  });

  test("a rolled-back operation left nothing for the list to show", async () => {
    const identities = rowsOf(await list()).map((asset) =>
      String(asset["identity"]),
    );
    // The reused operation id earlier in this file was refused as a conflict, and its
    // transaction rolled back. The asset it would have created is not here.
    expect(identities).not.toContain("other.acme.test:443");
    // Nor is the one whose URL could not be parsed into an identity at all.
    expect(
      identities.filter((identity) => identity.startsWith("app.acme.test:443")),
    ).toHaveLength(1);
  });
});
