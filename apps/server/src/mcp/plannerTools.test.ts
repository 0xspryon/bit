/**
 * The planner round's tool surface, over real HTTP against a real SQLite file.
 *
 * Two things are the point, and the first is the one slice 7 exists for.
 *
 * **The toolkit each caller is actually given.** Slice 4 already proved the *store*
 * refuses a caller of the wrong kind, and `store.test.ts` still owns that. What was never
 * true until now is that the tool **list** matches: a round's session could see
 * `record_observation`. So the assertions here are on `tools/list` and on which endpoint
 * answers which bearer, not on a refusal — a store refusal would pass whether or not the
 * tool was advertised, which is exactly how the gap survived slice 5.
 *
 * **The three rules that live inside `add_intent`.** The budget, the duplicate join and
 * the ended-goal check are enforced at write time inside one transaction (the spec's
 * decision 10), and each refusal has to be instructive rather than bare. They are driven
 * through the real MCP endpoint rather than against the store, because the sentence a
 * planner reads is the tool's and because `failureMode: "return"` — a refusal arriving as
 * a torn-down turn instead of a readable result would be a different failure with the same
 * store behaviour.
 *
 * `ManagedRuntime` owns the layer stack's scope, as in `mcp/server.test.ts`, and the
 * envelope helper is that file's: the 2026-07-28 revision is stateless, so every request
 * carries its own protocol metadata and a test that hand-rolled part of it would be
 * asserting against its own mistake.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";

import { dimensionAddress } from "@bit/contracts";

import { multiCaseInput } from "../persistence/fixtures";
import {
  ObservationStore,
  operatorScope,
  type AttemptCaller,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { McpCredentials } from "./credentials";
import { PlannerHarnesses } from "./plannerTools";
import { McpCallCounter } from "./server";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { DEFAULT_POLICY, PolicyDecisions } from "../policy/service";

const directory = mkdtempSync(join(tmpdir(), "bit-planner-tools-"));
const databaseFile = join(directory, "hunt.sqlite");

const TARGET = "target-1";
const GOAL = "goal-1";
const ROUND = "rnd-1";
/**
 * A second goal and its round, for `objective_met`.
 *
 * Separate because that disposition **ends** the goal and `openRound` refuses a round under
 * an ended one: declaring the objective met on the goal this suite also plans would make
 * every later test depend on its order.
 */
const GOAL_MET = "goal-met";
const ROUND_MET = "rnd-met";
const BUDGET = 3;

const HOST = { callerScope: operatorScope(TARGET), targetId: TARGET } as const;

const ATTEMPT: AttemptCaller = {
  _tag: "attempt",
  callerScope: `${TARGET}/attempt-1`,
  targetId: TARGET,
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_worker",
  workerId: "worker-1",
  attemptFence: 0,
};

/**
 * The catalogue `list_harnesses` answers from.
 *
 * Two instances, one unready, because the tool's own description promises an unready one
 * is listed with its reason rather than hidden — and because an all-ready list could not
 * show that.
 */
const HARNESSES = PlannerHarnesses.listing([
  {
    instance_id: "opencode",
    driver: "opencode",
    display_name: "OpenCode",
    ready: true,
    reason: null,
    is_default: true,
    default_model: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "gpt-6.1-terra"],
  },
  {
    instance_id: "claude-code",
    driver: "claude-code",
    display_name: "Claude Code",
    ready: false,
    reason: "the Claude Agent SDK is not installed on this server",
    is_default: false,
    default_model: "claude-sonnet-5",
    models: ["claude-sonnet-5"],
  },
]);

/**
 * Everything this suite needs in the target's file, plus both round credentials.
 *
 * **One layer rather than a `beforeAll`, and the ordering is why.** `issue` is an
 * `acquireRelease`, so a credential minted inside a bare effect is revoked the moment that
 * effect ends; it has to be issued into a scope that outlives the tests, and the layer's is
 * the only one there is. And `openRound` refuses a round whose goal does not exist, so the
 * goals, the intent, the attempt and the observation have to be written *before* the
 * credentials are minted — which in a layer is simply the order of the statements.
 *
 * The two rounds are on two goals on purpose: `objective_met` ends a goal, and `openRound`
 * refuses a round under an ended one, so a suite that declared the objective met on the
 * goal it also plans would make every later test depend on its order.
 */
class Seeded extends Context.Service<
  Seeded,
  {
    /** The address of the one untested dimension the seeded observation left. */
    readonly dimension: string;
    /** The observation that raised it, which is also the only thing worth anchoring to. */
    readonly observationId: string;
    readonly roundToken: string;
    readonly metRoundToken: string;
    readonly workerToken: string;
  }
>()("test/PlannerSeeded") {
  static readonly layer = Layer.effect(
    Seeded,
    Effect.gen(function* () {
      const store = yield* ObservationStore;
      const credentials = yield* McpCredentials;

      // One goal with one intent, one attempt and one observation under it, so there is
      // real evidence to anchor to and a real dimension to address. `seedAttempt` mints the
      // goal and the intent as well, which is what makes this one statement rather than
      // three.
      yield* store.seedAttempt({
        targetId: TARGET,
        goalId: GOAL,
        goal: "Determine whether authentication rate limits can be bypassed.",
        intentId: ATTEMPT.intentId,
        question: "Probe the per-client limiter.",
        attemptId: ATTEMPT.attemptId,
        workerId: ATTEMPT.workerId,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        modelOptions: null,
        harnessSessionId: ATTEMPT.harnessSessionId,
      });
      const recorded = yield* store.recordObservation(
        ATTEMPT,
        multiCaseInput({ operationId: "op-seed-observation" }),
      );
      yield* store.openGoal(HOST, {
        operationId: "op-open-goal-met",
        goalId: GOAL_MET,
        name: "",
        description: "A goal a planner will declare met.",
      });

      const planned = yield* store.openRound(HOST, {
        goalId: GOAL,
        roundId: ROUND,
        budget: BUDGET,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        harnessSessionId: "ses_planner",
      });
      const met = yield* store.openRound(HOST, {
        goalId: GOAL_MET,
        roundId: ROUND_MET,
        budget: BUDGET,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        harnessSessionId: "ses_met",
      });

      const round = yield* credentials.issue({
        _tag: "round",
        targetId: TARGET,
        goalId: GOAL,
        roundId: ROUND,
        roundFence: planned.writeFence,
      });
      const metRound = yield* credentials.issue({
        _tag: "round",
        targetId: TARGET,
        goalId: GOAL_MET,
        roundId: ROUND_MET,
        roundFence: met.writeFence,
      });
      const worker = yield* credentials.issue({
        _tag: "attempt",
        targetId: TARGET,
        intentId: ATTEMPT.intentId,
        attemptId: ATTEMPT.attemptId,
        harnessSessionId: ATTEMPT.harnessSessionId,
        workerId: ATTEMPT.workerId,
        attemptFence: 0,
      });

      return Seeded.of({
        dimension: dimensionAddress(recorded.observationId, 0),
        observationId: recorded.observationId,
        roundToken: Redacted.value(round.token),
        metRoundToken: Redacted.value(metRound.token),
        workerToken: Redacted.value(worker.token),
      });
    }),
  );
}

const testLayer = Layer.mergeAll(
  ControlPlaneEndpoint.layer({ policy: DEFAULT_POLICY, harnesses: HARNESSES }),
  Seeded.layer,
  McpCredentials.layer,
  McpCallCounter.layer,
  PolicyDecisions.layer,
  ObservationStore.layer(databaseFile),
).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provideMerge(ObservationStore.layer(databaseFile)),
  Layer.provideMerge(
    TargetStores.ofStore(TARGET).pipe(
      Layer.provide(ObservationStore.layer(databaseFile)),
    ),
  ),
);

const runtime = ManagedRuntime.make(testLayer);

let plannerUrl = "";
let workerUrl = "";
let roundToken = "";
let metRoundToken = "";
let workerToken = "";
let dimension = "";
let observationId = "";

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const endpoint = yield* ControlPlaneEndpoint;
      const seeded = yield* Seeded;
      plannerUrl = endpoint.plannerMcpUrl;
      workerUrl = endpoint.mcpUrl;
      roundToken = seeded.roundToken;
      metRoundToken = seeded.metRoundToken;
      workerToken = seeded.workerToken;
      dimension = seeded.dimension;
      observationId = seeded.observationId;
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

let nextId = 1;
const PROTOCOL_VERSION = "2026-07-28";

const ROUTING_KEY: Record<string, "name" | "uri" | undefined> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

const envelope = (params: unknown): unknown => {
  const base = (params ?? {}) as Record<string, unknown>;
  return {
    ...base,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
};

const rpc = async (
  url: string,
  method: string,
  params: unknown,
  bearer: string | null,
) => {
  const routingKey = ROUTING_KEY[method];
  const routedName =
    routingKey === undefined
      ? undefined
      : (params as Record<string, unknown> | undefined)?.[routingKey];
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(typeof routedName === "string" ? { "mcp-name": routedName } : {}),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: envelope(params),
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

/** Reads a tool response without assuming which channel carried a refusal. */
const outcomeOf = (body: Record<string, unknown> | null): ToolOutcome => {
  const result = body?.["result"] as
    | {
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }
    | undefined;
  const text = result?.content?.[0]?.text ?? "";
  return {
    isError: result?.isError === true,
    data:
      result?.structuredContent ??
      (text.startsWith("{")
        ? (JSON.parse(text) as Record<string, unknown>)
        : {}),
    text,
  };
};

const callPlanner = async (
  name: string,
  args: Record<string, unknown>,
  bearer: string = roundToken,
) =>
  outcomeOf(
    (await rpc(plannerUrl, "tools/call", { name, arguments: args }, bearer))
      .body,
  );

const toolNames = async (
  url: string,
  bearer: string,
): Promise<readonly string[]> => {
  const response = await rpc(url, "tools/list", {}, bearer);
  expect(response.status).toBe(200);
  const tools = (
    response.body?.["result"] as { tools?: Array<{ name: string }> } | undefined
  )?.tools;
  return (tools ?? []).map((tool) => tool.name).sort();
};

/* ── The toolkit each caller is actually given ───────────────────────────────── */

describe("the tool surface matches the authority", () => {
  test("a planner round is offered the planner tools and not record_observation", async () => {
    const names = await toolNames(plannerUrl, roundToken);
    expect(names).toEqual([
      "add_intent",
      "list_harnesses",
      "list_intents",
      "list_observations",
      "list_open_questions",
      "record_round_disposition",
    ]);
    // The assertion slice 5 could not make. Not "the store refuses it" — that was always
    // true — but that it is not on the list at all.
    expect(names).not.toContain("record_observation");
  });

  test("a worker attempt is offered record_observation and not add_intent", async () => {
    const names = await toolNames(workerUrl, workerToken);
    expect(names).toEqual(["record_observation"]);
    expect(names).not.toContain("add_intent");
    expect(names).not.toContain("record_round_disposition");
  });

  test("a worker credential at the planner endpoint is refused before any tool list", async () => {
    // The grant half of the boundary. Knowing the planner URL buys nothing: the endpoint
    // serves one role and refuses a resolved grant of any other kind with a 401, before
    // protocol dispatch — so a worker does not even learn the path is there.
    const listed = await rpc(plannerUrl, "tools/list", {}, workerToken);
    expect(listed.status).toBe(401);
    const called = await rpc(
      plannerUrl,
      "tools/call",
      { name: "add_intent", arguments: {} },
      workerToken,
    );
    expect(called.status).toBe(401);
  });

  test("a round credential at the worker endpoint gets no tool list, not the wrong one", async () => {
    // The precise claim `planSupervisor.ts` makes at the line that registers
    // `urls.plannerMcp`. An earlier version of that comment said a round at the worker URL
    // "would list `record_observation` and be refused `401` for it", which cannot both
    // happen: the role check runs before protocol dispatch, so the round gets **no** tool
    // list at all rather than the wrong one. Asserted on the body as well as the status,
    // because "refused" and "refused without producing a list" are different claims and
    // the comment makes the second.
    const listed = await rpc(workerUrl, "tools/list", {}, roundToken);
    expect(listed.status).toBe(401);
    expect(listed.body?.["result"]).toBeUndefined();
  });

  test("the planner endpoint has no anonymous path either", async () => {
    expect((await rpc(plannerUrl, "tools/list", {}, null)).status).toBe(401);
    expect((await rpc(plannerUrl, "initialize", {}, null)).status).toBe(401);
  });
});

/* ── list_harnesses ──────────────────────────────────────────────────────────── */

describe("list_harnesses", () => {
  test("names instances and models and carries no credential material", async () => {
    const outcome = await callPlanner("list_harnesses", {});
    expect(outcome.isError).toBe(false);
    const harnesses = outcome.data["harnesses"] as
      Array<Record<string, unknown>> | undefined;
    expect(harnesses).toHaveLength(2);
    expect(harnesses?.[0]?.["instance_id"]).toBe("opencode");
    expect(harnesses?.[0]?.["models"]).toEqual([
      "gpt-5.6-sol",
      "gpt-6.1-terra",
    ]);
    // Listed, not hidden, with the reason it gave.
    expect(harnesses?.[1]?.["ready"]).toBe(false);
    expect(String(harnesses?.[1]?.["reason"])).toContain("not installed");

    // **The claim this test exists for**, asserted over the whole serialised answer rather
    // than field by field: a field added to the mapping cannot smuggle a secret in without
    // failing here. The round's own bearer is in it too, because that is the one secret
    // this process is holding that a planner could plausibly be handed back.
    const serialised = JSON.stringify(outcome.data);
    for (const forbidden of [
      "authorization",
      "Authorization",
      "bearer",
      "Bearer",
      "token",
      "api_key",
      "apiKey",
      "secret",
      "password",
      "auth",
      roundToken,
      workerToken,
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

/* ── The graph reads ─────────────────────────────────────────────────────────── */

describe("the graph reads", () => {
  test("list_observations is a digest carrying the dimension addresses", async () => {
    const outcome = await callPlanner("list_observations", {});
    expect(outcome.isError).toBe(false);
    expect(outcome.data["goal_id"]).toBe(GOAL);
    const observations = outcome.data["observations"] as
      Array<Record<string, unknown>> | undefined;
    expect(observations).toHaveLength(1);
    const first = observations?.[0];
    expect(first?.["intent_id"]).toBe(ATTEMPT.intentId);
    expect(first?.["record_format"]).toBe("caseBased");
    expect(String(first?.["tested_claim"])).toContain("X-Client-Id");
    // A digest: the cases, actors and per-action counts are the briefing's, not this
    // tool's. What is here is what a planner cannot get from prose — the addresses.
    expect(first?.["cases"]).toBeUndefined();
    const dimensions = first?.["untested_dimensions"] as
      Array<Record<string, unknown>> | undefined;
    expect(dimensions?.[0]?.["address"]).toBe(dimension);
  });

  test("list_open_questions is the frontier with its state", async () => {
    const outcome = await callPlanner("list_open_questions", {});
    expect(outcome.isError).toBe(false);
    const questions = outcome.data["questions"] as
      Array<Record<string, unknown>> | undefined;
    expect((questions ?? []).length).toBeGreaterThan(0);
    const found = (questions ?? []).find(
      (question) => question["address"] === dimension,
    );
    expect(found).toBeDefined();
    expect(found?.["status"]).toBe("uninvestigated");
    expect(found?.["raised_by_observation_id"]).toBe(observationId);
  });

  test("list_intents shows live intents and says how many finished ones it hid", async () => {
    const outcome = await callPlanner("list_intents", {});
    expect(outcome.isError).toBe(false);
    const intents = outcome.data["intents"] as
      Array<Record<string, unknown>> | undefined;
    expect(
      intents?.some((intent) => intent["intent_id"] === ATTEMPT.intentId),
    ).toBe(true);
    expect(typeof outcome.data["finished_omitted"]).toBe("number");
  });
});

/* ── add_intent ──────────────────────────────────────────────────────────────── */

describe("add_intent", () => {
  test("a round commits an anchored intent that appears under the goal", async () => {
    const anchor = observationId;
    const outcome = await callPlanner("add_intent", {
      operation_id: "op-anchored",
      question:
        "Does the limiter reset on a new window for a rotated client id?",
      anchor_observation_ids: [anchor],
      addresses_dimension: dimension,
      suggested_instance_id: "opencode",
      suggested_model: "gpt-5.6-sol",
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.data["goal_id"]).toBe(GOAL);
    expect(outcome.data["anchored_to"]).toEqual([anchor]);
    expect(outcome.data["top_level"]).toBe(false);
    expect(outcome.data["addresses_dimension_id"]).not.toBeNull();
    // The budget is reported rather than only enforced, so a planner knows where it
    // stands before it is refused.
    expect(outcome.data["budget"]).toBe(BUDGET);
    expect(outcome.data["intents_added"]).toBe(1);
    expect(outcome.data["intents_remaining"]).toBe(BUDGET - 1);

    // Under the goal, in the store, with the suggestion stored as a suggestion.
    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        store.intent(String(outcome.data["intent_id"])),
      ),
    );
    expect(stored?.goalId).toBe(GOAL);
    expect(stored?.status).toBe("open");
    expect(stored?.anchoredTo).toEqual([anchor]);
    expect(stored?.suggestion.instanceId).toBe("opencode");
  });

  test("the same operation_id replays and does not spend the budget twice", async () => {
    // The whole reason the intent id is **derived** from the caller scope and the
    // operation id rather than minted: a fresh id would hash differently, and the receipt
    // would refuse the retry as a conflict — turning the one mechanism that makes a lost
    // response safe into a refusal.
    const anchor = observationId;
    const again = await callPlanner("add_intent", {
      operation_id: "op-anchored",
      question:
        "Does the limiter reset on a new window for a rotated client id?",
      anchor_observation_ids: [anchor],
      addresses_dimension: dimension,
      suggested_instance_id: "opencode",
      suggested_model: "gpt-5.6-sol",
    });
    expect(again.isError).toBe(false);
    expect(again.data["replayed"]).toBe(true);
    expect(again.data["intents_added"]).toBe(1);
  });

  test("a duplicate is refused naming what it duplicates", async () => {
    const outcome = await callPlanner("add_intent", {
      operation_id: "op-duplicate",
      question:
        "A differently worded question about the same untested dimension.",
      anchor_observation_ids: [],
      addresses_dimension: dimension,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.data["reason"]).toBe("duplicate");
    // Named structurally *and* quoted in the sentence, so the planner can choose
    // differently without having to guess what it collided with.
    expect(String(outcome.data["duplicate_of"])).toMatch(/^int_/);
    expect(String(outcome.data["detail"])).toContain("rotated client id");
    expect(String(outcome.data["detail"])).toContain("NOT created");
  });

  test("an anchor that is not recorded evidence is refused with the store's instruction", async () => {
    const outcome = await callPlanner("add_intent", {
      operation_id: "op-bad-anchor",
      question: "Anchored to an intent, which is not evidence.",
      anchor_observation_ids: [ATTEMPT.intentId],
      addresses_dimension: null,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.data["reason"]).toBe("anchoring");
    expect(String(outcome.data["detail"])).toContain("is an intent");
    expect(String(outcome.data["detail"])).toContain(
      "Leave anchorObservationIds empty",
    );
  });

  test("the budget is spent at N, and the (N+1)th is refused instructively", async () => {
    // One intent is already committed. Two more fill the budget of three.
    for (const index of [2, 3]) {
      const filled = await callPlanner("add_intent", {
        operation_id: `op-fill-${String(index)}`,
        question: `A top-level direction, number ${String(index)}.`,
        anchor_observation_ids: [],
        addresses_dimension: null,
      });
      expect(filled.isError).toBe(false);
      expect(filled.data["intents_added"]).toBe(index);
    }

    const refused = await callPlanner("add_intent", {
      operation_id: "op-over-budget",
      question: "One more than this round may add.",
      anchor_observation_ids: [],
      addresses_dimension: null,
    });
    expect(refused.isError).toBe(true);
    expect(refused.data["reason"]).toBe("budget_spent");
    const detail = String(refused.data["detail"]);
    // Instructive, not bare: it says the budget is spent, what to do instead, and that a
    // new operation id will not help.
    expect(detail).toContain("budget of 3");
    expect(detail).toContain("record this round's disposition");
    expect(detail).toContain("new operation id will not raise it");
    expect(detail).toContain("NOT created");

    // And nothing was written for it.
    const intents = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.intentsForGoal(GOAL)),
    );
    // The seeded intent plus the three the round added.
    expect(intents).toHaveLength(4);
  });
});

/* ── record_round_disposition ────────────────────────────────────────────────── */

describe("record_round_disposition", () => {
  test("a disposition can still be recorded after the budget is spent", async () => {
    // The requirement the budget refusal's own sentence promises. It holds because the
    // budget lives on the `add_intent` path alone and this write consults it nowhere —
    // asserted rather than assumed, because a requirement satisfied by an absence is one a
    // later change can break silently.
    const outcome = await callPlanner("record_round_disposition", {
      disposition: "actionable",
      rationale:
        "Three directions were worth running and the budget stopped me adding more.",
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.data["round_id"]).toBe(ROUND);
    expect(outcome.data["disposition"]).toBe("actionable");
    expect(outcome.data["intents_added"]).toBe(BUDGET);
    // `actionable` is not `objective_met`, so the goal is untouched.
    expect(outcome.data["goal_ended"]).toBe(false);

    const goal = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.loadGoal(GOAL)),
    );
    expect(goal?.status).toBe("active");
  });

  test("a round concludes once; a second call is a conflict naming what was recorded", async () => {
    const outcome = await callPlanner("record_round_disposition", {
      disposition: "waiting",
      rationale: "A change of mind.",
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.data["reason"]).toBe("conflict");
    expect(String(outcome.data["detail"])).toContain(
      "already recorded the disposition 'actionable'",
    );
  });

  test("the rationale is stored on the row beside the disposition", async () => {
    const round = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.loadRound(ROUND)),
    );
    expect(round?.disposition).toBe("actionable");
    expect(round?.dispositionRationale).toContain("Three directions");
  });
});

/* ── The ended-goal gap, and objective_met ───────────────────────────────────── */

describe("objective_met ends the goal, and an ended goal takes no more intents", () => {
  test("objective_met ends the goal with endedBy 'planner' and the rationale as its reason", async () => {
    const outcome = outcomeOf(
      (
        await rpc(
          plannerUrl,
          "tools/call",
          {
            name: "record_round_disposition",
            arguments: {
              disposition: "objective_met",
              rationale:
                "The recorded observations establish the objective; nothing further is needed.",
            },
          },
          metRoundToken,
        )
      ).body,
    );
    expect(outcome.isError).toBe(false);
    expect(outcome.data["goal_ended"]).toBe(true);

    const goal = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.loadGoal(GOAL_MET)),
    );
    expect(goal?.status).toBe("met");
    // The one disposition with a consequence beyond the round, and the record says who.
    expect(goal?.endedBy).toBe("planner");
    expect(goal?.endReason).toContain("establish the objective");
  });

  test("add_intent under the ended goal is refused, naming the status", async () => {
    // Ruling 2: ending a goal interrupts nothing, so this round's credential still works —
    // `checkRoundAuthority` has four checks and no goal-status check, deliberately. What
    // ending a goal stops is dispatch, and `add_intent` is the last dispatch-shaped gap.
    const outcome = outcomeOf(
      (
        await rpc(
          plannerUrl,
          "tools/call",
          {
            name: "add_intent",
            arguments: {
              operation_id: "op-after-met",
              question: "Work under a goal that is over.",
              anchor_observation_ids: [],
              addresses_dimension: null,
            },
          },
          metRoundToken,
        )
      ).body,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.data["reason"]).toBe("goal_ended");
    const detail = String(outcome.data["detail"]);
    expect(detail).toContain("is met");
    expect(detail).toContain("NOT created");
    // Instructive: it says what the round may still do.
    expect(detail).toContain("record this round's disposition");

    const intents = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) =>
        store.intentsForGoal(GOAL_MET),
      ),
    );
    expect(intents).toEqual([]);
  });
});

/* ── Writes stay goal-scoped ─────────────────────────────────────────────────── */

describe("a round's reads may be broad and its writes are not", () => {
  test("every read answers for the credential's goal and takes no goal argument", async () => {
    // There is no `goal_id` parameter on any tool in this file, so this is an assertion
    // about the advertised schema rather than about a refusal: a planner has no way to
    // *ask* about another goal.
    const response = await rpc(plannerUrl, "tools/list", {}, roundToken);
    const tools = response.body?.["result"] as
      | Array<never>
      | { tools?: Array<{ name: string; inputSchema: unknown }> }
      | undefined as
      { tools?: Array<{ name: string; inputSchema: unknown }> } | undefined;
    for (const tool of tools?.tools ?? []) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("goal_id");
    }
  });

  test("the per-scope call tally counts this round's authenticated requests", async () => {
    // The other half of tolerating a first-turn tool absence (DECISIONS.md §24.2 caveat
    // 1): a round that settles with no disposition and **zero** requests under its scope
    // never had its tools, where one with requests had them and chose to say nothing.
    // Without this the two are the same empty round.
    const counted = await runtime.runPromise(
      Effect.flatMap(McpCallCounter, (counter) =>
        Effect.all({
          round: counter.countFor(`${TARGET}/round/${ROUND}`),
          phantom: counter.countFor(`${TARGET}/round/rnd-never-called`),
        }),
      ),
    );
    expect(counted.round).toBeGreaterThan(0);
    expect(counted.phantom).toBe(0);
  });
});
