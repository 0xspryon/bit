/**
 * The MCP write boundary dispatches to the target its credential names.
 *
 * `server.test.ts` covers the boundary's admission and schema parity against one target.
 * This covers the thing that one target cannot show: that **two** credentials, naming two
 * targets, served by **one** endpoint on **one** port, write into two separate
 * `hunt.sqlite` files — and that neither observation is reachable from the other's.
 *
 * It is a separate file rather than more cases in that suite because the world is
 * different in the one way that matters: a real `FleetStore` with two registered,
 * migrated targets and a real `TargetStores` over it. Nothing is stubbed on the path a
 * write takes. The resolver has to pick between two files, which is exactly what a
 * resolver holding one entry could not get wrong.
 *
 * ## What this replaces
 *
 * `DomainToolkitLayer` used to yield `ObservationStore` once at layer construction, and
 * `main.ts` resolved `TARGET_ID` to satisfy it. That single yield *was* the pin: every
 * authenticated write in the process went to one file whatever the credential said, so an
 * installation could serve one engagement's writes at a time. The third test below is the
 * one that would have passed under the pin and means nothing — both writes landing — and
 * the fourth is the one that would have failed: each landing in its own file.
 *
 * ## Why over HTTP
 *
 * Because the thing being checked is that provenance comes from the *presented bearer*.
 * Calling the handler directly would mean choosing a `McpInvocation` by hand, which is
 * choosing the answer. Here the only input is a token, the auth middleware resolves it,
 * and which file is written is downstream of that and of nothing else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Stream,
} from "effect";

import { AgentHarness } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness } from "../harness/stubHarness";
import { RunNarrations } from "../run/narration";
import { RunSupervisor, WorkerEndpoints } from "../run/supervisor";

import { multiCaseWireArgs } from "../persistence/fixtures";
import { FleetStore } from "../persistence/fleet";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { DEFAULT_POLICY, PolicyDecisions } from "../policy/service";
import {
  McpCredentials,
  type AttemptBinding,
  type IssuedCredential,
} from "./credentials";
import { McpCallCounter } from "./server";

const directory = mkdtempSync(join(tmpdir(), "bit-mcp-dispatch-"));
const fleetRoot = join(directory, "fleet");

/** A scratch workspace per target, created on demand and removed with `directory`. */
const workspaceFor = (targetId: string): string => {
  const workspace = join(directory, "work", targetId);
  mkdirSync(workspace, { recursive: true });
  return workspace;
};

/** Two engagements, each with its own attempt, intent and goal in its own file. */
const TARGETS = ["alpha", "beta"] as const;

const bindingFor = (targetId: string): AttemptBinding => ({
  _tag: "attempt",
  targetId,
  intentId: `intent-${targetId}`,
  attemptId: `attempt-${targetId}`,
  harnessSessionId: `ses_${targetId}`,
  workerId: `worker-${targetId}`,
  attemptFence: 0,
});

const fleet = FleetStore.layer(fleetRoot);
const stores = TargetStores.layer.pipe(Layer.provide(fleet));

/**
 * A credential per target, issued into the layer's scope.
 *
 * `issue` puts the grant in the caller's scope, so issuing inside a bare effect would
 * revoke it before any request went out. Two separate services rather than one holding a
 * pair, so the layer graph says plainly that these are two independent grants.
 */
class AlphaCredential extends Context.Service<
  AlphaCredential,
  IssuedCredential
>()("test/AlphaCredential") {
  static readonly layer = Layer.effect(
    AlphaCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue(bindingFor("alpha")),
    ),
  );
}

class BetaCredential extends Context.Service<
  BetaCredential,
  IssuedCredential
>()("test/BetaCredential") {
  static readonly layer = Layer.effect(
    BetaCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue(bindingFor("beta")),
    ),
  );
}

/**
 * A credential for a target that is not registered.
 *
 * The failure dispatch-by-credential adds and the pin could not have: a grant whose
 * `targetId` names nothing this server can open. It has to be refused with the resolver's
 * own words rather than written somewhere, and it must not be able to fall back to
 * whichever target happens to be at hand.
 */
class GhostCredential extends Context.Service<
  GhostCredential,
  IssuedCredential
>()("test/GhostCredential") {
  static readonly layer = Layer.effect(
    GhostCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue(bindingFor("gamma")),
    ),
  );
}

const credentials = McpCredentials.layer;

/**
 * A harness that does one thing: keep the bearer it is handed.
 *
 * The supervisor below exists to check *wiring*, not agency, so the only part of a harness
 * this needs is the side that receives the MCP registration. `waitForIdle` never returns,
 * which keeps the run — and therefore its credential — live for the length of the test.
 */
const minted: { token?: string } = {};
const fakeHarness = Layer.succeed(
  AgentHarness,
  stubHarness({
    // The one member this file is about: the side that receives the MCP registration.
    registerMcpServer: (_sessionId, _name, config) =>
      Effect.sync(() => {
        minted.token = Redacted.value(
          config.headers["authorization"] ?? Redacted.make(""),
        ).replace(/^Bearer /, "");
      }),
    // Never returns, which keeps the run — and therefore its credential — live for the
    // length of the test.
    waitForIdle: () => Effect.never,
    interruptSession: () => Effect.succeed(true),
    sessionEvents: () => Stream.never,
  }),
);

/**
 * The supervisor, in the same graph as the listener.
 *
 * `credentials` and `stores` are the same *layer values* the listener is built from, so
 * layer memoisation gives this the same instances — which is the property the last test in
 * this file checks, and the one a composition root can get wrong. `WorkerEndpoints` comes
 * from the endpoint directly: there is no cycle here, because this listener serves no
 * browser routes.
 */
const supervisorLayer = RunSupervisor.layer.pipe(
  // One instance, so the resolver in front of the seam is a wrapper here and not a choice.
  Layer.provide(HarnessResolver.single),
  Layer.provide(fakeHarness),
  Layer.provide(RunNarrations.layer),
  Layer.provide(WorkerEndpoints.fromEndpoint),
);

const base = Layer.mergeAll(
  fleet,
  stores,
  credentials,
  AlphaCredential.layer,
  BetaCredential.layer,
  GhostCredential.layer,
  ControlPlaneEndpoint.layer({ policy: DEFAULT_POLICY }),
).pipe(
  Layer.provideMerge(credentials),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  // The real resolver over the real registry. This is the whole point of the suite: a
  // single endpoint whose store is chosen per request, from the credential.
  Layer.provideMerge(stores),
  Layer.provideMerge(fleet),
);

/**
 * The supervisor on top of the built listener.
 *
 * `provideMerge` in this direction so the supervisor is handed `base`'s *instances* — the
 * credential registry the MCP route's middleware resolves against and the resolver it
 * writes through — rather than building its own. That is the arrangement the last test in
 * this file exists to protect, and the one a composition root can get wrong silently.
 */
const testLayer = Layer.provideMerge(supervisorLayer, base);

const runtime = ManagedRuntime.make(testLayer);

let url = "";
const tokens: Record<string, string> = {};

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const registry = yield* FleetStore;
      for (const targetId of TARGETS) {
        yield* registry.register({
          targetId,
          name: targetId,
          scopeNote: "the local fixture only",
        });
      }
      yield* registry.migrateFleet();

      // Each target's own attempt, seeded in its own file through the resolver — which is
      // also the first thing in this suite that proves the resolver reaches two files.
      const resolver = yield* TargetStores;
      for (const targetId of TARGETS) {
        yield* withTargetStore(resolver, targetId, (store) =>
          store.seedAttempt({
            ...bindingFor(targetId),
            harnessSessionId: `ses_${targetId}`,
            goalId: `goal-${targetId}`,
            goal: "Determine whether authentication rate limits can be bypassed.",
            question: "Probe the per-client limiter on POST /login.",
            harnessInstanceId: "opencode",
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            modelOptions: null,
          }),
        );
      }

      const endpoint = yield* ControlPlaneEndpoint;
      url = endpoint.mcpUrl;
      tokens["alpha"] = Redacted.value((yield* AlphaCredential).token);
      tokens["beta"] = Redacted.value((yield* BetaCredential).token);
      tokens["gamma"] = Redacted.value((yield* GhostCredential).token);
    }).pipe(Effect.orDie),
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

/* ── The stateless envelope, as `server.test.ts` documents it ────────────────── */

const PROTOCOL_VERSION = "2026-07-28";
let nextId = 1;

const callTool = async (bearer: string, toolArgs: Record<string, unknown>) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": "record_observation",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "record_observation",
        arguments: toolArgs,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  const body =
    text.length > 0 && text.startsWith("{")
      ? (JSON.parse(text) as Record<string, unknown>)
      : null;
  const result = body?.["result"] as
    | { isError?: boolean; content?: ReadonlyArray<{ text?: string }> }
    | undefined;
  const first = result?.content?.[0]?.text ?? "";
  let decoded: Record<string, unknown> = {};
  try {
    decoded = JSON.parse(first) as Record<string, unknown>;
  } catch {
    /* a refusal's text is prose, not JSON. */
  }
  return {
    status: response.status,
    isError: result?.isError === true,
    text: first,
    data: decoded,
  };
};

/** The wire arguments, with a claim naming whose write this is so a read can tell. */
const argsFor = (targetId: string, operationId: string) =>
  multiCaseWireArgs({
    operation_id: operationId,
    tested_claim: `Header rotation evades ${targetId}'s per-client limit on POST /login.`,
  });

const readTarget = <A, E>(
  targetId: string,
  use: (
    store: Parameters<Parameters<typeof withTargetStore>[2]>[0],
  ) => Effect.Effect<A, E>,
): Promise<A> =>
  runtime.runPromise(
    Effect.flatMap(TargetStores, (resolver) =>
      withTargetStore(resolver, targetId, use),
    ).pipe(Effect.orDie),
  );

/* ── The claims ──────────────────────────────────────────────────────────────── */

describe("one endpoint, two targets", () => {
  test("a write lands in the target its own credential names", async () => {
    const alpha = await callTool(
      tokens["alpha"] ?? "",
      argsFor("alpha", "alpha-1"),
    );
    expect(alpha.status).toBe(200);
    expect(alpha.isError).toBe(false);
    expect(alpha.data["observation_id"]).toBe("obs_000001_attempt-alpha");

    const inAlpha = await readTarget("alpha", (store) =>
      store.observationsForIntent("intent-alpha"),
    );
    expect(inAlpha.map((row) => row.observationId)).toEqual([
      "obs_000001_attempt-alpha",
    ]);
    // Provenance is the credential's, not the payload's: the arguments above carry no
    // target, intent, attempt or session, and these are the ones the bearer resolved to.
    expect(inAlpha[0]?.provenance).toMatchObject({
      targetId: "alpha",
      intentId: "intent-alpha",
      attemptId: "attempt-alpha",
      harnessSessionId: "ses_alpha",
    });

    // And beta's file is untouched.
    const inBeta = await readTarget("beta", (store) => store.counts());
    expect(inBeta.observations).toBe(0);
  });

  test("the other credential writes to the other file, through the same endpoint", async () => {
    const beta = await callTool(
      tokens["beta"] ?? "",
      argsFor("beta", "beta-1"),
    );
    expect(beta.status).toBe(200);
    expect(beta.isError).toBe(false);
    // Sequence 1 in beta's own file, not 2 — two files, two counters. An id colliding
    // across targets is correct: an observation id is unique within the file it lives in.
    expect(beta.data["observation_id"]).toBe("obs_000001_attempt-beta");
    expect(beta.data["sequence"]).toBe(1);

    const counts = await Promise.all([
      readTarget("alpha", (store) => store.counts()),
      readTarget("beta", (store) => store.counts()),
    ]);
    expect(counts.map((entry) => entry.observations)).toEqual([1, 1]);

    // Neither file can see the other's intent at all. Not "a WHERE clause filtered it
    // out" — there is no row to filter, because it is in another database.
    const betaSeesAlpha = await readTarget("beta", (store) =>
      store.loadIntent("intent-alpha"),
    );
    const alphaSeesBeta = await readTarget("alpha", (store) =>
      store.loadIntent("intent-beta"),
    );
    expect(betaSeesAlpha).toBeUndefined();
    expect(alphaSeesBeta).toBeUndefined();
  });

  test("the same operation id under two credentials is two writes, not a conflict", async () => {
    // Receipts are keyed on `callerScope`, which the credential registry derives as
    // `<targetId>/<attemptId>` — so two targets cannot collide on, or replay, each
    // other's operation ids. Under the pin both of these would have gone to one file and
    // the second would have been refused as a conflict.
    const shared = "same-operation-id";
    const first = await callTool(
      tokens["alpha"] ?? "",
      multiCaseWireArgs({
        operation_id: shared,
        tested_claim: "A claim recorded under a shared operation id.",
      }),
    );
    const second = await callTool(
      tokens["beta"] ?? "",
      multiCaseWireArgs({
        operation_id: shared,
        tested_claim: "A claim recorded under a shared operation id.",
      }),
    );

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(first.data["replayed"]).toBe(false);
    expect(second.data["replayed"]).toBe(false);

    const counts = await Promise.all([
      readTarget("alpha", (store) => store.counts()),
      readTarget("beta", (store) => store.counts()),
    ]);
    expect(counts.map((entry) => entry.observations)).toEqual([2, 2]);
  });

  test("a credential naming a target this server has no file for is refused", async () => {
    const ghost = await callTool(
      tokens["gamma"] ?? "",
      argsFor("gamma", "gamma-1"),
    );

    // Authenticated — the registry resolves the token — and refused at the resolver. A
    // returned refusal rather than a transport error, because a worker that cannot tell
    // its observation was not stored is a worker that carries on as though it had.
    expect(ghost.status).toBe(200);
    expect(ghost.isError).toBe(true);
    expect(ghost.text).toContain("gamma");
    expect(ghost.text).toContain("NOT recorded");

    // And nothing leaked into a target that *is* openable.
    const counts = await Promise.all([
      readTarget("alpha", (store) => store.counts()),
      readTarget("beta", (store) => store.counts()),
    ]);
    expect(counts.map((entry) => entry.observations)).toEqual([2, 2]);
  });

  test("a credential the supervisor minted is accepted by the MCP route on this listener", async () => {
    /**
     * The regression test for a bug that had no symptom.
     *
     * The compose box starts a run through {@link RunSupervisor}, which mints a credential
     * and hands it to the harness; the harness presents it to `/api/v1/mcp`, whose auth
     * middleware resolves it against {@link McpCredentials}. Those two have to be the same
     * registry — and against a live server they were not, because the browser API's routes
     * were provided their services as *layers* and `HttpRouter.toWebHandler` builds the
     * router's application layer in its own memo map, so a second `McpCredentials` was
     * built inside it. The harness connected with a valid token and was told
     * `unknown_or_expired`; the worker simply had no tools, and nothing failed.
     *
     * So the claim here is not about dispatch at all: it is that a credential minted by
     * the supervisor **in this graph** opens the MCP route **on this listener**. A
     * duplicated registry fails it, which is exactly what a wiring mistake in a
     * composition root needs — a test that notices, rather than a silent `401` in a log.
     *
     * The supervisor is given a harness that does nothing but hand back the token it was
     * handed, which is all this needs: what is under test is the wiring, not the agent.
     */
    const observed = await runtime.runPromise(
      Effect.gen(function* () {
        const supervisor = yield* RunSupervisor;
        // A run claims an intent that already exists, so one is made first.
        const opened = yield* TargetStores;
        yield* withTargetStore(opened, "alpha", (store) =>
          Effect.gen(function* () {
            const host = { callerScope: "alpha/operator", targetId: "alpha" };
            yield* store.openGoal(host, {
              operationId: "op-goal-supervised",
              goalId: "goal-supervised",
              name: "",
              description: "Work out what alpha does under load.",
            });
            yield* store.addIntent(host, {
              operationId: "op-intent-supervised",
              goalId: "goal-supervised",
              intentId: "intent-supervised",
              question: "probe it",
              anchorObservationIds: [],
              addressesDimension: null,
            });
          }),
        );
        const started = yield* supervisor.start({
          targetId: "alpha",
          intentId: "intent-supervised",
          // A scratch workspace of its own, because starting a run installs the
          // pre-execution policy gate into it before creating the session.
          workspace: workspaceFor("alpha"),
          auditPath: join(directory, "alpha-policy-audit.log"),
          title: "bit: alpha",
        });
        return { started, supervisor };
      }).pipe(Effect.orDie),
    );

    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    // Presented exactly as the harness presents it, verified against a live `opencode`:
    // `Authorization: Bearer <token>` on a POST to the MCP path.
    const accepted = await callTool(
      minted.token ?? "",
      multiCaseWireArgs({
        operation_id: "from-the-supervisor",
        tested_claim: "A credential the supervisor minted opens this route.",
      }),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.isError).toBe(false);
    // And the write landed under the attempt the supervisor opened, in that target's file.
    const stored = await readTarget("alpha", (store) =>
      store.observationsForIntent(observed.started.intentId),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.provenance).toMatchObject({
      targetId: "alpha",
      attemptId: observed.started.attemptId,
      harnessSessionId: observed.started.harnessSessionId,
    });

    await runtime.runPromise(
      Effect.result(observed.supervisor.stop(observed.started.attemptId)),
    );
  });

  test("both targets' writes went through one listener on one port", async () => {
    // Stated rather than assumed, because the whole claim is about one endpoint: every
    // call above went to the same URL, and the endpoint counted each as an authenticated
    // MCP request it served.
    const served = await runtime.runPromise(
      Effect.flatMap(ControlPlaneEndpoint, (endpoint) => endpoint.callCount),
    );
    expect(served).toBe(6);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/mcp$/);
  });
});
