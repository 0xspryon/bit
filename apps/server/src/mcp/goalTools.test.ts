/**
 * The goal agent's tool surface, over real HTTP against a real SQLite file.
 *
 * Shaped on `mcp/plannerTools.test.ts` and asserting the same two kinds of thing, because
 * the ruling it exists for is the same ruling one role along.
 *
 * **The toolkit this role is actually given.** The slice's first ruling is that the goal
 * agent never gets `add_intent`, and the brief is explicit that the assertion has to be on
 * the toolkit **served** rather than on the store's refusal: a store refusal would pass
 * whether or not the tool was advertised, and a tool a model can see is one it will tell
 * the operator is available. So the first `describe` reads `tools/list` off the live goal
 * endpoint and checks the whole list, both ways.
 *
 * **The two writes, and the ordering inside the one that is not atomic.** `steer_planner`
 * delivers a directive and then records that it happened, and the record carries no
 * directive text — which is the only reason a steered round's conclusion can be read
 * correctly later (DECISIONS.md §24.1, consequence 6). `end_goal` ends the caller's own
 * goal and nothing else, as `goal_agent`.
 *
 * The planning half is a stub ({@link planning}) and the store half is real, which is the
 * split that matters here: what this file is about is the **tool's** branching — steer a
 * live round, or open one carrying the directive — and driving a real `PlanSupervisor`
 * would need a harness and would test the supervisor's own claims, which
 * `plan/planSupervisor.test.ts` owns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";

import { PlanRefused } from "@bit/contracts";

import { multiCaseInput } from "../persistence/fixtures";
import {
  ObservationStore,
  operatorScope,
  type AttemptCaller,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { McpCredentials } from "./credentials";
import { GoalBriefingCeiling, GoalPlanning } from "./goalTools";
import { McpCallCounter } from "./server";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { DEFAULT_POLICY, PolicyDecisions } from "../policy/service";

const directory = mkdtempSync(join(tmpdir(), "bit-goal-tools-"));
const databaseFile = join(directory, "hunt.sqlite");

const TARGET = "target-1";
/** The goal this suite's agent is the agent for. */
const GOAL = "goal-1";
/** A second goal, so `end_goal` can be driven without ending the one everything reads. */
const GOAL_TO_END = "goal-to-end";
const ROUND = "rnd-1";
/** The round the `openRound` stub answers with, which the store also holds a row for. */
const OPENED_ROUND = "rnd-opened";
/** A third goal, whose objective alone renders a briefing over this suite's ceiling. */
const GOAL_TOO_BIG = "goal-too-big";

/**
 * The briefing ceiling this suite configures, which is deliberately **not** the default.
 *
 * 6 000, against `DEFAULT_GOAL_BRIEFING_MAX_CHARS`'s 320 000, and both numbers matter: it
 * is above {@link GOAL}'s own briefing (4 872 characters, so every other read here still
 * succeeds) and far below {@link GOAL_TOO_BIG}'s. `get_goal_briefing` built its briefing
 * with the default regardless of configuration until a review found it, so a suite that
 * configured nothing could not tell the two apart — the agent's own read and
 * `wake_planner` disagreed about the same goal in both directions.
 */
const SUITE_BRIEFING_CEILING = 6_000;

/**
 * An objective long enough to carry a briefing past the ceiling on its own.
 *
 * The description is rendered into the briefing verbatim, so this needs no intents and no
 * observations behind it: the point under test is which *number* the ceiling check uses,
 * not what a large goal is made of.
 */
const OVERSIZED_OBJECTIVE = `Determine whether the limiter can be bypassed. ${"Background on the engagement. ".repeat(300)}`;

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
 * What the planning stub was asked to do, in order.
 *
 * Module level because {@link planning} is built once and handed across the listener's own
 * memo-map boundary as a value — which is the arrangement the real server uses for exactly
 * this service, so a stub that could not be observed from here would be testing a different
 * wiring from the one that ships.
 */
const asked: {
  steers: {
    goalId: string;
    directive: string;
    urgency: string;
    messageId: string;
  }[];
  opened: { goalId: string; directive: string | undefined }[];
} = { steers: [], opened: [] };

/** What the stub should answer next. Set per test. */
const script: {
  live: boolean;
  /** Which round the stub reports as live, so a second steer can land on another one. */
  roundId: string;
  /** When set, `openRound` refuses with this instead of succeeding. */
  openRefusal: PlanRefused | undefined;
  /**
   * When set, `openRound` parks on this promise after signalling {@link openEntered}.
   *
   * The only way to reproduce the in-flight window a re-review found: a round becomes
   * steerable before `openRound` returns, so a retry arriving in that gap used to find no
   * receipt and a live round. Without a suspension point inside `openRound` the first call
   * runs to completion before the second starts and the race cannot happen in a test.
   */
  openGate: Promise<void> | undefined;
  /** Resolved the first time `openRound` is entered, before it parks. */
  openEntered: (() => void) | undefined;
} = {
  live: true,
  roundId: ROUND,
  openRefusal: undefined,
  openGate: undefined,
  openEntered: undefined,
};

/**
 * The message ids the stub has already accepted, so it keeps the seam's own promise.
 *
 * `AgentHarness.prompt` promises that the same derived message id is delivered **at most
 * once** per session, and `PlanSupervisor.steer` passes that answer straight through. A
 * stub that always reported `delivered: true` would let this suite assert a behaviour the
 * real seam does not have — so the dedupe is modelled here rather than scripted, and the
 * retry test asserts the consequence instead of a flag.
 */
const deliveredIds = new Set<string>();

/**
 * The two planning operations, stubbed and recorded.
 *
 * `GoalPlanning` is the whole of what the goal agent may do to planning — two function
 * types and no access to the fiber map, the harness or a stop control — so a stub of it is
 * a complete stand-in rather than a partial one.
 */
const planning = Layer.succeed(
  GoalPlanning,
  GoalPlanning.of({
    steer: (input) =>
      Effect.sync(() => {
        if (!script.live) return { _tag: "noLiveRound" as const };
        asked.steers.push({
          goalId: input.goalId,
          directive: input.directive,
          urgency: input.urgency,
          messageId: input.messageId,
        });
        const fresh = !deliveredIds.has(input.messageId);
        deliveredIds.add(input.messageId);
        return {
          _tag: "steered" as const,
          roundId: script.roundId,
          targetId: TARGET,
          goalId: input.goalId,
          harnessSessionId: "ses_planner",
          urgency: input.urgency,
          delivered: fresh,
        };
      }),
    openRound: (request) =>
      Effect.gen(function* () {
        script.openEntered?.();
        if (script.openGate !== undefined) {
          yield* Effect.promise(() => script.openGate ?? Promise.resolve());
        }
        asked.opened.push({
          goalId: request.goalId,
          directive: request.directive,
        });
        return yield* script.openRefusal === undefined
          ? Effect.succeed({
              roundId: OPENED_ROUND,
              targetId: TARGET,
              goalId: request.goalId,
              harnessSessionId: "ses_opened",
              instanceId: "opencode",
              providerId: "openai",
              modelId: "gpt-5.6-sol",
              budget: 3,
              startedAtSequence: 7,
              lineage: "opened" as const,
              briefingChars: 1_200,
              promptChars: 3_400,
              startedAt: 1_700_000_000_000,
            })
          : Effect.fail(script.openRefusal);
      }),
  }),
);

/**
 * Everything this suite needs in the target's file, plus the three credentials.
 *
 * One layer rather than a `beforeAll`, for `plannerTools.test.ts`'s reason: `issue` is an
 * `acquireRelease`, so a credential minted inside a bare effect is revoked the moment that
 * effect ends.
 */
class Seeded extends Context.Service<
  Seeded,
  {
    readonly goalToken: string;
    readonly endableGoalToken: string;
    readonly oversizedGoalToken: string;
    readonly roundToken: string;
    readonly observationId: string;
  }
>()("test/GoalSeeded") {
  static readonly layer = Layer.effect(
    Seeded,
    Effect.gen(function* () {
      const store = yield* ObservationStore;
      const credentials = yield* McpCredentials;

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
        operationId: "op-open-endable",
        goalId: GOAL_TO_END,
        name: "Endable",
        description: "A goal the agent will end.",
      });
      yield* store.openGoal(HOST, {
        operationId: "op-open-oversized",
        goalId: GOAL_TOO_BIG,
        name: "Oversized",
        description: OVERSIZED_OBJECTIVE,
      });
      /*
       * The round the `opened` branch's stub answers with, as a real row.
       *
       * `GoalPlanning`'s stub invents an id; the **store** does not, and
       * `recordRoundSteer` checks the round it is recording against belongs to the
       * caller's goal. Without a row there is no receipt, which is the one path that still
       * double-delivers on a retry (reported as `recorded: false` and logged) — so a test
       * about the retry being safe has to seed the row the production path would really
       * have written. Opened and settled before `ROUND`, because one round works a goal at
       * a time.
       */
      yield* store.openRound(HOST, {
        goalId: GOAL,
        roundId: OPENED_ROUND,
        budget: 3,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        harnessSessionId: "ses_opened",
      });
      yield* store.settleRound(OPENED_ROUND, "settled", {
        _tag: "supervisor",
      });

      const planned = yield* store.openRound(HOST, {
        goalId: GOAL,
        roundId: ROUND,
        budget: 3,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        harnessSessionId: "ses_planner",
      });

      const goal = yield* credentials.issueWithoutExpiry({
        _tag: "goal",
        targetId: TARGET,
        goalId: GOAL,
      });
      const endable = yield* credentials.issueWithoutExpiry({
        _tag: "goal",
        targetId: TARGET,
        goalId: GOAL_TO_END,
      });
      const oversized = yield* credentials.issueWithoutExpiry({
        _tag: "goal",
        targetId: TARGET,
        goalId: GOAL_TOO_BIG,
      });
      const round = yield* credentials.issue({
        _tag: "round",
        targetId: TARGET,
        goalId: GOAL,
        roundId: ROUND,
        roundFence: planned.writeFence,
      });

      return Seeded.of({
        goalToken: Redacted.value(goal.token),
        endableGoalToken: Redacted.value(endable.token),
        oversizedGoalToken: Redacted.value(oversized.token),
        roundToken: Redacted.value(round.token),
        observationId: recorded.observationId,
      });
    }),
  );
}

const testLayer = Layer.mergeAll(
  ControlPlaneEndpoint.layer({
    policy: DEFAULT_POLICY,
    planning,
    // The configured ceiling, which is what `main.ts` passes and what this suite exists to
    // check reaches the toolkit at all. See {@link SUITE_BRIEFING_CEILING}.
    briefingCeiling: GoalBriefingCeiling.at(SUITE_BRIEFING_CEILING),
  }),
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

let goalUrl = "";
let plannerUrl = "";
let goalToken = "";
let endableGoalToken = "";
let oversizedGoalToken = "";
let roundToken = "";

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const endpoint = yield* ControlPlaneEndpoint;
      const seeded = yield* Seeded;
      goalUrl = endpoint.goalMcpUrl;
      plannerUrl = endpoint.plannerMcpUrl;
      goalToken = seeded.goalToken;
      endableGoalToken = seeded.endableGoalToken;
      oversizedGoalToken = seeded.oversizedGoalToken;
      roundToken = seeded.roundToken;
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
};

/** `plannerTools.test.ts`'s envelope: the served revision is stateless. */
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

const callGoal = async (
  name: string,
  args: Record<string, unknown> = {},
  bearer: string = goalToken,
) =>
  outcomeOf(
    (await rpc(goalUrl, "tools/call", { name, arguments: args }, bearer)).body,
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

const readStore = <A>(
  body: (store: ObservationStore["Service"]) => Effect.Effect<A, unknown>,
): Promise<A> =>
  runtime.runPromise(
    Effect.flatMap(ObservationStore, (store) => body(store)).pipe(
      Effect.orDie,
    ) as Effect.Effect<A, never, ObservationStore>,
  );

/* ── The toolkit this role is actually given ─────────────────────────────────── */

describe("the goal agent's tool surface", () => {
  test("it is offered its eight tools and neither write the other roles have", async () => {
    const names = await toolNames(goalUrl, goalToken);
    expect(names).toEqual([
      "end_goal",
      "get_goal_briefing",
      "list_attempts",
      "list_intents",
      "list_observations",
      "list_open_questions",
      "steer_planner",
      "wake_planner",
    ]);
    /*
     * The slice's first ruling, asserted the way the brief requires: on the toolkit
     * **served**, not on the store's refusal.
     *
     * A store refusal would pass whether or not the tool was advertised — that is how the
     * planner's own equivalent gap survived a whole slice — and a tool the model can see is
     * one it will describe to the operator as available before trying it.
     */
    expect(names).not.toContain("add_intent");
    expect(names).not.toContain("record_observation");
    expect(names).not.toContain("record_round_disposition");
    /*
     * `record_asset` is a worker's too, for the schema reason the target-scope design's
     * D9 gives: a goal conversation has no intent and no attempt to hang a discovery's
     * provenance on. The goal agent reads the estate; it never writes to it.
     *
     * `list_assets` is a worker's for a weaker reason — a read needs no attempt — and it
     * is still not here, because the goal agent's own asset read belongs with the scope
     * query tool (slice 6) where it can answer "is this in scope" rather than only "what
     * is there".
     */
    expect(names).not.toContain("record_asset");
    expect(names).not.toContain("list_assets");
  });

  test("a goal credential at the planner endpoint is refused before any tool list", async () => {
    // The grant half of the boundary: knowing the planner URL buys nothing. If this ever
    // answered `200`, the goal agent would be offered `add_intent` — which is the exact
    // failure the three endpoints exist to prevent.
    const listed = await rpc(plannerUrl, "tools/list", {}, goalToken);
    expect(listed.status).toBe(401);
    const called = await rpc(
      plannerUrl,
      "tools/call",
      { name: "add_intent", arguments: {} },
      goalToken,
    );
    expect(called.status).toBe(401);
  });

  test("a round credential at the goal endpoint gets no tool list, not the wrong one", async () => {
    const listed = await rpc(goalUrl, "tools/list", {}, roundToken);
    expect(listed.status).toBe(401);
  });

  test("an unknown bearer is refused and a missing one never reaches a tool", async () => {
    expect((await rpc(goalUrl, "tools/list", {}, "not-a-token")).status).toBe(
      401,
    );
    expect((await rpc(goalUrl, "tools/list", {}, null)).status).toBe(401);
  });
});

/* ── steer_planner ───────────────────────────────────────────────────────────── */

describe("steering the planner", () => {
  test("a steer into a live round reaches it and is recorded without its text", async () => {
    script.live = true;
    asked.steers.length = 0;
    const before = await readStore((store) => store.currentEventSequence);

    const outcome = await callGoal("steer_planner", {
      operation_id: "op-steer-1",
      directive: "The operator says the admin console is out of scope.",
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.data["how"]).toBe("steered");
    expect(outcome.data["round_id"]).toBe(ROUND);
    expect(outcome.data["delivered"]).toBe(true);
    expect(outcome.data["recorded"]).toBe(true);
    // Queued by default: the round finishes what it is doing. Ruling 5.
    expect(outcome.data["urgency"]).toBe("queued");
    expect(asked.steers).toHaveLength(1);
    expect(asked.steers[0]?.directive).toContain("admin console");

    const events = await readStore((store) => store.eventsAfter(before));
    const steered = events.filter(
      (event) => event.kind === "plan.round.steered",
    );
    expect(steered).toHaveLength(1);
    const event = steered[0];
    expect(event?.subjectId).toBe(ROUND);
    // The goal agent's own scope, which is what puts the item in the goal's conversation
    // as well as under the round.
    expect(event?.callerScope).toBe(`${TARGET}/goal/${GOAL}`);
    /*
     * The directive is **not** in the record, and this is the assertion that keeps it out.
     *
     * The event exists so a steered round's disposition is not read as answering the
     * question it opened with; it is not a transcript. This build stores no conversation at
     * all, and a log holding the one sentence that redirected a round while holding none of
     * the words around it would be the most misleading possible half of the record.
     */
    expect(JSON.stringify(event?.payload)).not.toContain("admin console");
    expect(JSON.stringify(event?.payload)).toContain("queued");
  });

  test("an explicit preemptive steer says so in the record", async () => {
    script.live = true;
    asked.steers.length = 0;
    const before = await readStore((store) => store.currentEventSequence);

    const outcome = await callGoal("steer_planner", {
      operation_id: "op-steer-redirect",
      directive: "Stop what you are doing and look at the lockout path.",
      urgency: "preemptive",
    });

    expect(outcome.data["urgency"]).toBe("preemptive");
    expect(asked.steers[0]?.urgency).toBe("preemptive");
    const events = await readStore((store) => store.eventsAfter(before));
    expect(
      JSON.stringify(
        events.find((event) => event.kind === "plan.round.steered")?.payload,
      ),
    ).toContain("preemptive");
  });

  test("a retried steer delivers nothing twice and appends one event", async () => {
    script.live = true;
    script.roundId = ROUND;
    asked.steers.length = 0;
    const before = await readStore((store) => store.currentEventSequence);
    const args = {
      operation_id: "op-steer-retry",
      directive: "Prefer the password reset flow.",
    };

    const first = await callGoal("steer_planner", args);
    const second = await callGoal("steer_planner", args);

    expect(first.data["delivered"]).toBe(true);
    expect(second.data["delivered"]).toBe(false);
    /*
     * **The retry never reaches the harness at all**, which is stronger than the claim this
     * test used to make.
     *
     * It used to assert two deliveries with one derived id and let the seam's own dedupe
     * answer `delivered: false`. That was true and it was not enough: the receipt is now
     * read before either branch is chosen, so the second call is answered from the record
     * and nothing is offered to a session. The seam's dedupe is still there and is still
     * asserted where it belongs (`claudeCodeClient.test.ts`, `openCodeClient.test.ts`);
     * what this file asserts is that the *tool* stops before it.
     */
    expect(asked.steers).toHaveLength(1);
    // The replay answers with what the id already did, not with a fresh outcome.
    expect(second.data["how"]).toBe("steered");
    expect(second.data["round_id"]).toBe(first.data["round_id"]);
    expect(second.data["recorded"]).toBe(true);

    const events = await readStore((store) => store.eventsAfter(before));
    expect(
      events.filter((event) => event.kind === "plan.round.steered"),
    ).toHaveLength(1);
  });

  test("an operation that opened a round does not then steer it on retry", async () => {
    /*
     * Important finding 1, measured by the reviewer with a scratch probe and now a test.
     *
     * `steer_planner` has two ways of reaching the planner, and before this fix only one of
     * them wrote a receipt. So an operation that fell down the `opened` branch — directive
     * in the round's opening prompt — and was retried a moment later, when that very round
     * was live, delivered the **same directive a second time as a steer** and wrote a
     * `plan.round.steered` event claiming the round had changed direction when it had
     * started that way. The derived message id cannot help: the new round's session has
     * never been offered that id.
     *
     * The fix is that the receipt is the operation's identity on both branches, read before
     * either is chosen. The retry replays `opened`, offers nothing, and writes nothing.
     */
    asked.steers.length = 0;
    asked.opened.length = 0;
    const before = await readStore((store) => store.currentEventSequence);
    const args = {
      operation_id: "op-steer-opened-then-retried",
      directive: "The operator says to start with the lockout path.",
    };

    script.live = false;
    const opened = await callGoal("steer_planner", args);
    // The round it opened is now the live one, which is exactly the shape of the defect.
    script.live = true;
    script.roundId = OPENED_ROUND;
    const retry = await callGoal("steer_planner", args);
    script.roundId = ROUND;

    expect(opened.data["how"]).toBe("opened");
    expect(opened.data["delivered"]).toBe(true);

    // The retry: the first call's answer, replayed.
    expect(retry.isError).toBe(false);
    expect(retry.data["how"]).toBe("opened");
    expect(retry.data["round_id"]).toBe(OPENED_ROUND);
    expect(retry.data["delivered"]).toBe(false);
    // Nothing was steered and no second round was opened.
    expect(asked.steers).toEqual([]);
    expect(asked.opened).toHaveLength(1);
    // And no event claims a redirect: the round started with the directive in its prompt.
    const events = await readStore((store) => store.eventsAfter(before));
    expect(
      events.filter((event) => event.kind === "plan.round.steered"),
    ).toHaveLength(0);
  });

  test("two concurrent calls with one operation id deliver once", async () => {
    /*
     * The in-flight window a re-review found, closed and now covered.
     *
     * A receipt makes a **sequential** retry safe and cannot make a concurrent one safe: a
     * round is published as steerable before `openRound` returns, so from that moment until
     * the first call's receipt commits a second call with the same id would pass the receipt
     * read, find a live round, and steer the directive into the session that already has it
     * in its opening prompt. The harness's dedupe cannot help — that session has never been
     * offered the id.
     *
     * The race is **forced**: the stub parks inside `openRound` until this test releases it,
     * and the live round is switched on while the first call is parked, which is exactly the
     * state the window describes. The permit per `(caller scope, operation id)` is what makes
     * the second call wait, read the receipt the first one wrote, and replay it.
     */
    asked.steers.length = 0;
    asked.opened.length = 0;
    const before = await readStore((store) => store.currentEventSequence);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    script.live = false;
    script.roundId = OPENED_ROUND;
    script.openEntered = entered.resolve;
    script.openGate = release.promise;

    const args = {
      operation_id: "op-steer-concurrent",
      directive: "The operator says to start with the lockout path.",
    };
    const first = callGoal("steer_planner", args);
    // The first call is inside `openRound`; the round it is opening is now live, which is
    // the gap the window is about.
    await entered.promise;
    script.live = true;
    const second = callGoal("steer_planner", args);
    // Long enough that an unguarded second call would have steered by now.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release.resolve();
    const [opened, retry] = await Promise.all([first, second]);

    script.openEntered = undefined;
    script.openGate = undefined;
    script.live = true;
    script.roundId = ROUND;

    expect(opened.data["how"]).toBe("opened");
    expect(opened.data["delivered"]).toBe(true);
    // The second call waited, found the receipt, and replayed it.
    expect(retry.isError).toBe(false);
    expect(retry.data["how"]).toBe("opened");
    expect(retry.data["round_id"]).toBe(OPENED_ROUND);
    expect(retry.data["delivered"]).toBe(false);
    // Delivered once, by one route, with no event claiming a redirect.
    expect(asked.steers).toEqual([]);
    expect(asked.opened).toHaveLength(1);
    const events = await readStore((store) => store.eventsAfter(before));
    expect(
      events.filter((event) => event.kind === "plan.round.steered"),
    ).toHaveLength(0);
  });

  test("a reused operation id with new words delivers nothing, and says so rather than lying", async () => {
    /*
     * The honest consequence of a record that holds no directive text.
     *
     * The derived message id is a function of the operation id alone, so a second call
     * under one id cannot reach the round whatever its words are — and the receipt cannot
     * tell the two apart either, because the directive is deliberately not in the hashed
     * input. So this is **not** a conflict: it is a retry as far as everything durable can
     * see, and the one true thing to report is that nothing was delivered. The tool's own
     * description is what tells an agent the rule: a new directive needs a new
     * `operation_id`.
     */
    script.live = true;
    script.roundId = ROUND;
    await callGoal("steer_planner", {
      operation_id: "op-steer-reused",
      directive: "One thing.",
    });
    const second = await callGoal("steer_planner", {
      operation_id: "op-steer-reused",
      directive: "A different thing entirely.",
    });

    expect(second.isError).toBe(false);
    expect(second.data["delivered"]).toBe(false);
  });

  test("one operation id cannot steer a second round once it has steered one", async () => {
    /*
     * The case this test used to assert was a `conflict`, and the honest answer is a replay.
     *
     * The round a goal has live changes over time, so a retried operation id can arrive
     * while a *different* round is running. Refusing it as a conflict was defensible only
     * while the receipt was consulted inside the write — after the directive had already
     * been delivered to the new round, which made the refusal's own sentence ("nothing was
     * recorded") false about the thing that mattered. Reading the receipt first makes the
     * answer simple and true: this operation has already reached the planner, here is where
     * it reached, and nothing was sent.
     */
    asked.steers.length = 0;
    script.live = true;
    script.roundId = ROUND;
    const first = await callGoal("steer_planner", {
      operation_id: "op-steer-two-rounds",
      directive: "Same words, different round.",
    });
    script.roundId = "rnd-later";
    const second = await callGoal("steer_planner", {
      operation_id: "op-steer-two-rounds",
      directive: "Same words, different round.",
    });
    script.roundId = ROUND;

    expect(first.data["round_id"]).toBe(ROUND);
    expect(second.isError).toBe(false);
    // The *first* round, which is where this operation's directive actually went — not the
    // one that happens to be live now.
    expect(second.data["round_id"]).toBe(ROUND);
    expect(second.data["delivered"]).toBe(false);
    // And `rnd-later` was never touched.
    expect(asked.steers).toHaveLength(1);
    expect(asked.steers[0]?.messageId).toBeTruthy();
  });

  test("a steer with no live round opens one carrying the directive", async () => {
    /*
     * Decision 12's second clause, and the branch DECISIONS.md §24.1 consequence 5 makes
     * mandatory: on OpenCode a late steer does not fail, it starts unsupervised work — so
     * the supervisor answers `noLiveRound` rather than delivering, and the directive has to
     * reach the model some other way. It reaches it in the opening prompt of a new round.
     */
    script.live = false;
    asked.opened.length = 0;
    asked.steers.length = 0;
    const before = await readStore((store) => store.currentEventSequence);

    const outcome = await callGoal("steer_planner", {
      operation_id: "op-steer-opens",
      directive: "Look at the lockout path next.",
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.data["how"]).toBe("opened");
    expect(outcome.data["round_id"]).toBe(OPENED_ROUND);
    expect(asked.steers).toHaveLength(0);
    expect(asked.opened).toHaveLength(1);
    expect(asked.opened[0]?.directive).toBe("Look at the lockout path next.");

    // And no steer record: this round was never redirected, it started this way. An event
    // here would claim a change of direction that did not happen.
    const events = await readStore((store) => store.eventsAfter(before));
    expect(
      events.filter((event) => event.kind === "plan.round.steered"),
    ).toHaveLength(0);
  });

  test("a refusal to open the fallback round is reported in the planner's own words", async () => {
    script.live = false;
    script.openRefusal = new PlanRefused({
      reason: "goal_busy",
      detail: "round rnd-other is already planning this goal",
    });
    const outcome = await callGoal("steer_planner", {
      operation_id: "op-steer-busy",
      directive: "Anything at all.",
    });
    script.openRefusal = undefined;

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("planner_busy");
    expect(outcome.text).toContain("rnd-other");
  });
});

/* ── wake_planner ────────────────────────────────────────────────────────────── */

describe("waking the planner", () => {
  test("it opens a round with no directive at all", async () => {
    asked.opened.length = 0;
    const outcome = await callGoal("wake_planner");

    expect(outcome.isError).toBe(false);
    expect(outcome.data["round_id"]).toBe(OPENED_ROUND);
    expect(outcome.data["budget"]).toBe(3);
    expect(asked.opened).toHaveLength(1);
    // Absent rather than empty: a round an operator or a bare wake-up opened reads exactly
    // as it did before this slice, with no directive section in its prompt.
    expect(asked.opened[0]?.directive).toBeUndefined();
  });

  test("a goal that already has a round is refused planner_busy, not retried", async () => {
    script.openRefusal = new PlanRefused({
      reason: "goal_busy",
      detail: "round rnd-live is already planning goal goal-1",
    });
    const outcome = await callGoal("wake_planner");
    script.openRefusal = undefined;

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("planner_busy");
  });
});

/* ── end_goal ────────────────────────────────────────────────────────────────── */

describe("ending the goal", () => {
  test("it ends the caller's own goal as goal_agent, with the reason it gave", async () => {
    const outcome = await callGoal(
      "end_goal",
      {
        operation_id: "op-end-1",
        status: "met",
        reason: "The operator agreed the objective is established.",
      },
      endableGoalToken,
    );

    expect(outcome.isError).toBe(false);
    /*
     * `goal_agent`, not `planner`, and the third literal exists for this.
     *
     * A planner round records `objective_met` on its disposition and that ends the goal as
     * `planner`; this is a different writer with different authority and no `add_intent` at
     * all. Reusing `planner` would make the goal page say "ended by the planner" for an
     * ending no planner round reached, which is the one claim about an ending a later
     * reader cannot check against anything else.
     */
    expect(outcome.data["ended_by"]).toBe("goal_agent");
    expect(outcome.data["status"]).toBe("met");

    const goal = await readStore((store) => store.loadGoal(GOAL_TO_END));
    expect(goal?.status).toBe("met");
    expect(goal?.endedBy).toBe("goal_agent");
    expect(goal?.endReason).toContain("objective is established");
  });

  test("ending again is refused as a conflict naming what ended it", async () => {
    const outcome = await callGoal(
      "end_goal",
      {
        operation_id: "op-end-2",
        status: "abandoned",
        reason: "Changed my mind.",
      },
      endableGoalToken,
    );

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("conflict");
    expect(outcome.text).toContain("goal_agent");
  });

  test("an exact retry replays and does not end it twice", async () => {
    const outcome = await callGoal(
      "end_goal",
      {
        operation_id: "op-end-1",
        status: "met",
        reason: "The operator agreed the objective is established.",
      },
      endableGoalToken,
    );

    expect(outcome.isError).toBe(false);
    expect(outcome.data["replayed"]).toBe(true);
  });

  test("the goal id is the credential's, so there is no argument that reaches another", async () => {
    // `end_goal`'s parameters carry no goal id at all. The assertion is on the schema the
    // endpoint advertises, because that is what a model reads before it tries anything.
    const response = await rpc(goalUrl, "tools/list", {}, goalToken);
    const tools = (
      response.body?.["result"] as
        { tools?: Array<{ name: string; inputSchema?: unknown }> } | undefined
    )?.tools;
    const endGoal = tools?.find((tool) => tool.name === "end_goal");
    expect(JSON.stringify(endGoal?.inputSchema)).not.toContain("goal_id");
  });
});

/* ── The reads ───────────────────────────────────────────────────────────────── */

describe("what the agent can read", () => {
  test("list_intents answers every intent, finished ones included", async () => {
    const outcome = await callGoal("list_intents");

    expect(outcome.isError).toBe(false);
    const intents = outcome.data["intents"] as Array<Record<string, unknown>>;
    expect(intents).toHaveLength(1);
    expect(intents[0]?.["intent_id"]).toBe(ATTEMPT.intentId);
    // No `include_finished` parameter here, unlike the planner's: an operator asking what
    // has been tried needs the answered and abandoned ones most of all.
    expect(intents[0]?.["attempts"]).toBe(1);
  });

  test("list_attempts answers what has actually been run, with provenance", async () => {
    const outcome = await callGoal("list_attempts");

    const attempts = outcome.data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.["attempt_id"]).toBe(ATTEMPT.attemptId);
    expect(attempts[0]?.["intent_id"]).toBe(ATTEMPT.intentId);
    expect(attempts[0]?.["model_id"]).toBe("gpt-5.6-sol");
  });

  test("list_observations answers the digest with dimension addresses", async () => {
    const outcome = await callGoal("list_observations");

    const observations = outcome.data["observations"] as Array<
      Record<string, unknown>
    >;
    expect(observations).toHaveLength(1);
    expect(observations[0]?.["tested_claim"]).toBeTruthy();
    expect(
      (observations[0]?.["untested_dimensions"] as unknown[]).length,
    ).toBeGreaterThan(0);
  });

  test("list_open_questions answers the frontier, de-duplicated across intents", async () => {
    const outcome = await callGoal("list_open_questions");

    const questions = outcome.data["questions"] as Array<
      Record<string, unknown>
    >;
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0]?.["address"]).toBeTruthy();
    expect(questions[0]?.["status"]).toBe("uninvestigated");
  });

  test("get_goal_briefing refuses by the ceiling the server was configured with", async () => {
    /*
     * Important finding 2: three of the four briefing call sites threaded
     * `GOAL_BRIEFING_MAX_CHARS` and this one was hardcoded to the default, with no path for
     * the number to reach it at all.
     *
     * So the assertion is about **which figure** refuses. This suite configures 6 000; the
     * goal below renders well over that and nowhere near the default 320 000, so before the
     * fix this call succeeded and handed the agent a briefing no round could have been
     * opened on — which is decision 11's second failure direction exactly.
     */
    const outcome = await callGoal("get_goal_briefing", {}, oversizedGoalToken);

    expect(outcome.isError).toBe(true);
    expect(outcome.data["reason"]).toBe("briefing_too_large");
    const detail = String(outcome.data["detail"]);
    // Both numbers, and the ceiling is the configured one rather than the default — a
    // figure the operator never set and could not find in their environment.
    expect(detail).toContain(String(SUITE_BRIEFING_CEILING));
    expect(detail).not.toContain("320000");
    expect(detail).toContain(GOAL_TOO_BIG);
  });

  test("get_goal_briefing answers the same text a round is prompted with", async () => {
    const outcome = await callGoal("get_goal_briefing");

    expect(outcome.isError).toBe(false);
    const rendered = outcome.data["rendered"] as string;
    expect(rendered).toContain("rate limits");
    expect(outcome.data["size_chars"]).toBe(rendered.length);
    expect(outcome.data["objective"]).toContain("rate limits");
  });
});
