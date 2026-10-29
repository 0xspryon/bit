/**
 * The goal briefing against real stored rows, across more than one intent.
 *
 * What is checked here is what the ruling promises and what a planner cannot verify for
 * itself. A briefing that quietly dropped the oldest evidence, that grouped it by intent
 * instead of ordering it, that reported a dimension as untouched when a sibling intent had
 * work out for it, or that collapsed two separately recorded dimensions into one because
 * they read alike, would all look like perfectly good briefings — the failure is invisible
 * from inside the text. So each is pinned: nothing omitted, one ascending order across the
 * goal, one row per dimension identity with its state taken from the whole goal, a refusal
 * rather than a shortened brief at the ceiling, and a stable prefix that holds with no
 * caveat.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Result } from "effect";

import { multiCaseInput } from "../persistence/fixtures";
import {
  ObservationStore,
  operatorScope,
  type AttemptCaller,
} from "../persistence/store";
import { PREPARATION_HEADING, buildBriefing, stablePrefixOf } from "./briefing";
import {
  DEFAULT_GOAL_BRIEFING_MAX_CHARS,
  GoalBriefingError,
  GoalBriefingTooLarge,
  buildGoalBriefing,
  renderGoalBriefing,
} from "./goalBriefing";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-goal-briefing-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const TARGET = "target-1";
const GOAL = "goal-1";
const OBJECTIVE =
  "Determine whether authentication rate limits can be bypassed.";
const HOST = { callerScope: operatorScope(TARGET), targetId: TARGET };

type Store = ObservationStore["Service"];

/** The attempt authority for one worker on one intent. */
const callerFor = (intentId: string, attemptId: string): AttemptCaller => ({
  _tag: "attempt",
  callerScope: `${TARGET}/${attemptId}`,
  targetId: TARGET,
  intentId,
  attemptId,
  harnessSessionId: `ses_${attemptId}`,
  workerId: "worker-1",
  attemptFence: 0,
});

/**
 * Adds one intent of the goal with an attempt of its own, and hands back its caller.
 *
 * `seedAttempt` is `ON CONFLICT(id) DO NOTHING` throughout, so calling it a second time
 * for the same goal writes only the new intent and attempt — which is what makes a
 * multi-intent goal cheap to build here.
 */
const seedIntent = (store: Store, intentId: string, question: string) =>
  Effect.as(
    store.seedAttempt({
      targetId: TARGET,
      goalId: GOAL,
      goal: OBJECTIVE,
      intentId,
      question,
      attemptId: `attempt-${intentId}`,
      workerId: "worker-1",
      harnessInstanceId: "opencode",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      modelOptions: null,
      harnessSessionId: `ses_attempt-${intentId}`,
    }),
    callerFor(intentId, `attempt-${intentId}`),
  );

/**
 * A goal opened by name, so the briefing has a real label and objective to print.
 *
 * `openGoal` runs before any `seedAttempt`, which would otherwise mint an unnamed goal
 * row and win the `ON CONFLICT DO NOTHING`.
 */
const withGoal = <A, E>(
  use: (store: Store) => Effect.Effect<A, E, ObservationStore>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ObservationStore;
        yield* store.openGoal(HOST, {
          operationId: "open-goal-1",
          goalId: GOAL,
          name: "Login limiter",
          description: OBJECTIVE,
        });
        return yield* use(store);
      }).pipe(Effect.provide(ObservationStore.layer(newDatabasePath()))),
    ),
  );

describe("buildGoalBriefing", () => {
  test("an unknown goal is a tagged error, not an empty briefing", async () => {
    const outcome = await withGoal(() =>
      Effect.result(buildGoalBriefing("goal-does-not-exist")),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toBeInstanceOf(GoalBriefingError);
      expect(outcome.failure).toMatchObject({
        _tag: "GoalBriefingError",
        reason: "unknown_goal",
        goalId: "goal-does-not-exist",
      });
    }
  });

  test("an empty goal says the graph knows nothing yet, and is not an error", async () => {
    const prepared = await withGoal(() => buildGoalBriefing(GOAL));

    expect(prepared.briefing.observations).toEqual([]);
    expect(prepared.briefing.intents).toEqual([]);
    expect(prepared.briefing.omittedObservationIds).toEqual([]);
    expect(prepared.briefing.truncated).toBe(false);
    // The objective and the label are the goal's own, printed above anything that moves.
    expect(prepared.rendered).toContain(OBJECTIVE);
    expect(prepared.rendered).toContain("Name: Login limiter");
    expect(prepared.rendered).toContain(
      "Nothing has been recorded under this goal yet",
    );
    expect(prepared.rendered).toContain("no intents");
    expect(prepared.rendered).toContain("- none created yet");
    expect(prepared.rendered).toContain("- none recorded");
  });

  test("a goal whose intents have recorded nothing lists them and says there is no evidence", async () => {
    const prepared = await withGoal((store) =>
      Effect.gen(function* () {
        yield* seedIntent(store, "intent-1", "Probe the per-client limiter.");
        yield* seedIntent(store, "intent-2", "Probe the per-account limiter.");
        return yield* buildGoalBriefing(GOAL);
      }),
    );

    expect(prepared.briefing.observations).toEqual([]);
    expect(prepared.briefing.intents.map((entry) => entry.intentId)).toEqual([
      "intent-1",
      "intent-2",
    ]);
    expect(prepared.rendered).toContain("Intents already under this goal (2)");
    expect(prepared.rendered).toContain("Probe the per-account limiter.");
    expect(prepared.rendered).toContain(
      "Nothing has been recorded under this goal yet",
    );
    expect(prepared.rendered).toContain("the intents listed below");
  });

  test("nothing is dropped: every observation of every intent is rendered in full", async () => {
    const prepared = await withGoal((store) =>
      Effect.gen(function* () {
        const first = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        const second = yield* seedIntent(
          store,
          "intent-2",
          "Per-account limiter.",
        );
        const third = yield* seedIntent(store, "intent-3", "Window rollover.");
        for (const [caller, count] of [
          [first, 4],
          [second, 3],
          [third, 2],
        ] as const) {
          for (let index = 0; index < count; index += 1) {
            yield* store.recordObservation(
              caller,
              multiCaseInput({
                operationId: `${caller.intentId}-${String(index)}`,
                testedClaim: `claim ${caller.intentId} #${String(index)}`,
              }),
            );
          }
        }
        return yield* buildGoalBriefing(GOAL);
      }),
    );

    expect(prepared.briefing.observations).toHaveLength(9);
    expect(prepared.briefing.omittedObservationIds).toEqual([]);
    expect(prepared.briefing.truncated).toBe(false);
    // Each one in full, not as an id: the claim and the per-case detail are both there.
    for (const observation of prepared.briefing.observations) {
      expect(prepared.rendered).toContain(observation.observationId);
      expect(prepared.rendered).toContain(observation.testedClaim);
    }
    expect(prepared.rendered).toContain("Observations above: 9. Omitted: 0.");
    expect(prepared.rendered).toContain("Truncated: no.");
    // Every case's interior still reaches the page, through the shared observation body.
    expect(prepared.rendered).toContain("case case-rotate:");
    expect(prepared.rendered).toContain("account=none (unauthenticated)");
  });

  test("observations are one ascending sequence across the goal, not grouped by intent", async () => {
    const prepared = await withGoal((store) =>
      Effect.gen(function* () {
        const first = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        const second = yield* seedIntent(
          store,
          "intent-2",
          "Per-account limiter.",
        );
        // Interleaved on purpose: grouping by intent would reorder exactly this.
        for (const [caller, tag] of [
          [first, "a"],
          [second, "b"],
          [first, "c"],
          [second, "d"],
        ] as const) {
          yield* store.recordObservation(
            caller,
            multiCaseInput({ operationId: `op-${tag}` }),
          );
        }
        return yield* buildGoalBriefing(GOAL);
      }),
    );

    const sequences = prepared.briefing.observations.map(
      (observation) => observation.sequence,
    );
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(
      prepared.briefing.observations.map(
        (observation) => observation.provenance.intentId,
      ),
    ).toEqual(["intent-1", "intent-2", "intent-1", "intent-2"]);
    // And the text follows the structure rather than re-sorting it. Read from the stable
    // prefix, so the open-questions groupings below the heading cannot be mistaken for
    // observation blocks.
    const headings = [
      ...stablePrefixOf(prepared.rendered).matchAll(/^### .*$/gm),
    ].map((match) => match[0]);
    expect(headings).toHaveLength(4);
    expect(headings[0]).toContain("under intent intent-1");
    expect(headings[1]).toContain("under intent intent-2");
    expect(headings[2]).toContain("under intent intent-1");
    expect(headings[3]).toContain("under intent intent-2");
  });

  test("a dimension declared by a sibling intent is one scheduled row, not two", async () => {
    const outcome = await withGoal((store) =>
      Effect.gen(function* () {
        const first = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        const raiser = yield* store.recordObservation(
          first,
          multiCaseInput({
            operationId: "raise",
            untestedDimensions: ["the per-account limit was never approached"],
          }),
        );
        const address = `${raiser.observationId}#u0`;
        // A second intent of the same goal, declaring that it addresses the dimension the
        // first intent's observation raised. Nothing has been dispatched for it.
        yield* store.addIntent(HOST, {
          operationId: "add-sibling",
          goalId: GOAL,
          intentId: "intent-2",
          question: "Measure the per-account limiter on POST /login.",
          anchorObservationIds: [],
          addressesDimension: address,
        });
        return { address, prepared: yield* buildGoalBriefing(GOAL) };
      }),
    );

    const matching = outcome.prepared.briefing.openQuestions.filter(
      (question) => question.address === outcome.address,
    );
    expect(matching).toHaveLength(1);
    const question = matching[0];
    expect(question?.status).toBe("scheduled");
    expect(question?.scheduledBy.map((entry) => entry.intentId)).toEqual([
      "intent-2",
    ]);
    expect(question?.scheduledBy[0]?.attemptsOpen).toBe(true);
    expect(outcome.prepared.rendered).toContain("### Scheduled (1)");
    expect(outcome.prepared.rendered).toContain(
      "work is out under intent intent-2",
    );
  });

  test("two intents recording the same sentence stay two questions: the join is on identity, not wording", async () => {
    const prepared = await withGoal((store) =>
      Effect.gen(function* () {
        const first = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        const second = yield* seedIntent(
          store,
          "intent-2",
          "Per-account limiter.",
        );
        for (const caller of [first, second]) {
          yield* store.recordObservation(
            caller,
            multiCaseInput({
              operationId: `same-${caller.intentId}`,
              untestedDimensions: ["no window rollover was measured"],
            }),
          );
        }
        return yield* buildGoalBriefing(GOAL);
      }),
    );

    const same = prepared.briefing.openQuestions.filter(
      (question) => question.dimension === "no window rollover was measured",
    );
    // Two rows, two addresses: collapsing them would decide on a planner's behalf that
    // the two observations meant the same thing.
    expect(same).toHaveLength(2);
    expect(new Set(same.map((question) => question.address)).size).toBe(2);
    expect(same.every((question) => question.status === "uninvestigated")).toBe(
      true,
    );
  });

  test("over the ceiling is a refusal naming both numbers, and nothing partial comes back", async () => {
    const outcome = await withGoal((store) =>
      Effect.gen(function* () {
        const caller = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        yield* store.recordObservation(
          caller,
          multiCaseInput({ operationId: "op-1" }),
        );
        const full = yield* buildGoalBriefing(GOAL);
        const refused = yield* Effect.result(
          buildGoalBriefing(GOAL, full.briefing.sizeChars - 1),
        );
        return { full, refused };
      }),
    );

    expect(Result.isFailure(outcome.refused)).toBe(true);
    if (!Result.isFailure(outcome.refused)) return;
    const failure = outcome.refused.failure;
    expect(failure).toBeInstanceOf(GoalBriefingTooLarge);
    expect(failure).toMatchObject({
      _tag: "GoalBriefingTooLarge",
      goalId: GOAL,
      sizeChars: outcome.full.briefing.sizeChars,
      maxChars: outcome.full.briefing.sizeChars - 1,
    });
    // Both figures are in the sentence, not only in the fields.
    expect(failure.message).toContain(String(outcome.full.briefing.sizeChars));
    expect(failure.message).toContain(
      String(outcome.full.briefing.sizeChars - 1),
    );
    // No briefing rode along with the refusal: there is nothing here a caller could
    // mistake for a shortened brief.
    const keys = Object.keys(failure as object);
    for (const forbidden of ["briefing", "rendered", "observations"]) {
      expect(keys).not.toContain(forbidden);
    }
    // Exactly at the ceiling is allowed; the refusal is for exceeding it.
    const exact = await withGoal((store) =>
      Effect.gen(function* () {
        const caller = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        yield* store.recordObservation(
          caller,
          multiCaseInput({ operationId: "op-1" }),
        );
        const full = yield* buildGoalBriefing(GOAL);
        return yield* buildGoalBriefing(GOAL, full.briefing.sizeChars);
      }),
    );
    expect(exact.briefing.sizeChars).toBe(exact.rendered.length);
  });

  test("the size is the rendered length, and the render does not depend on it", async () => {
    const prepared = await withGoal((store) =>
      Effect.gen(function* () {
        const caller = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        yield* store.recordObservation(
          caller,
          multiCaseInput({ operationId: "op-1" }),
        );
        return yield* buildGoalBriefing(GOAL);
      }),
    );

    expect(prepared.briefing.sizeChars).toBe(prepared.rendered.length);
    // Rendering the finished briefing gives the same text the size was measured on, which
    // is only true because `sizeChars` is not printed: see `renderGoalBriefing`.
    expect(renderGoalBriefing(prepared.briefing)).toBe(prepared.rendered);
    // Changing it changes nothing, which is the property: the number cannot move a byte
    // of the text it describes.
    expect(
      renderGoalBriefing({ ...prepared.briefing, sizeChars: 999_999 }),
    ).toBe(prepared.rendered);
  });

  test("the default ceiling is 320000 characters and an ordinary briefing is far under it", async () => {
    expect(DEFAULT_GOAL_BRIEFING_MAX_CHARS).toBe(320_000);
    const prepared = await withGoal((store) =>
      Effect.gen(function* () {
        const caller = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        yield* store.recordObservation(
          caller,
          multiCaseInput({ operationId: "op-1" }),
        );
        return yield* buildGoalBriefing(GOAL);
      }),
    );
    expect(prepared.briefing.sizeChars).toBeLessThan(
      DEFAULT_GOAL_BRIEFING_MAX_CHARS,
    );
  });
});

describe("the stable prefix, with no caveat", () => {
  test("every briefing starts with the previous one, from the empty goal onward", async () => {
    const prefixes = await withGoal((store) =>
      Effect.gen(function* () {
        const held: string[] = [];
        const record = Effect.fnUntraced(function* () {
          const prepared = yield* buildGoalBriefing(GOAL);
          held.push(stablePrefixOf(prepared.rendered));
        });

        // The empty goal is step zero on purpose. The intent briefing prints "None
        // recorded yet" above its heading and so breaks the property at exactly this
        // transition; this one reports emptiness in the tail instead.
        yield* record();
        const first = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        yield* record();
        yield* store.recordObservation(
          first,
          multiCaseInput({ operationId: "a" }),
        );
        yield* record();
        // A second intent: it lands in the tail, so it must not disturb the prefix.
        const second = yield* seedIntent(
          store,
          "intent-2",
          "Per-account limiter.",
        );
        yield* record();
        yield* store.recordObservation(
          second,
          multiCaseInput({ operationId: "b" }),
        );
        yield* record();
        // A run claiming an intent moves its status, which is also tail-only.
        yield* store.claimIntent(HOST, "intent-1", "attempt-intent-1");
        yield* record();
        yield* store.recordObservation(
          first,
          multiCaseInput({ operationId: "c" }),
        );
        yield* record();
        return held;
      }),
    );

    expect(prefixes).toHaveLength(7);
    for (let index = 1; index < prefixes.length; index += 1) {
      const previous = prefixes[index - 1] ?? "";
      const current = prefixes[index] ?? "";
      expect(current.startsWith(previous)).toBe(true);
    }
    // Growth is real, not a prefix that holds because nothing changed.
    expect((prefixes.at(-1) ?? "").length).toBeGreaterThan(
      (prefixes[0] ?? "").length,
    );
  });

  test("it still holds past the point where the intent briefing truncates", async () => {
    // The intent briefing's default limit is 100: past it the oldest included observation
    // drops out and its stable part is rewritten from the first block. The goal briefing
    // evicts nothing, so the same database proves both halves at once.
    const outcome = await withGoal((store) =>
      Effect.gen(function* () {
        const caller = yield* seedIntent(
          store,
          "intent-1",
          "Per-client limiter.",
        );
        const before: string[] = [];
        for (let index = 0; index < 101; index += 1) {
          yield* store.recordObservation(
            caller,
            multiCaseInput({ operationId: `op-${String(index)}` }),
          );
          // Sampled rather than taken every step: 101 full briefings is quadratic work
          // for a property that is transitive, and the samples straddle the limit.
          if (index === 0 || index === 50 || index === 99 || index === 100) {
            const prepared = yield* buildGoalBriefing(GOAL);
            before.push(stablePrefixOf(prepared.rendered));
          }
        }
        return {
          prefixes: before,
          goal: yield* buildGoalBriefing(GOAL),
          intent: yield* buildBriefing("intent-1"),
        };
      }),
    );

    // The old mechanism did fire, so "unconditionally" is being claimed against a real
    // truncation and not against a database that never reached the limit.
    expect(outcome.intent.truncated).toBe(true);
    expect(outcome.intent.omittedObservationIds).toHaveLength(1);

    expect(outcome.goal.briefing.observations).toHaveLength(101);
    expect(outcome.goal.briefing.omittedObservationIds).toEqual([]);
    expect(outcome.goal.briefing.truncated).toBe(false);
    for (let index = 1; index < outcome.prefixes.length; index += 1) {
      const previous = outcome.prefixes[index - 1] ?? "";
      const current = outcome.prefixes[index] ?? "";
      expect(current.startsWith(previous)).toBe(true);
    }
    // Everything that counts sits below the heading, which is what makes that true.
    const prefix = stablePrefixOf(outcome.goal.rendered);
    expect(prefix).not.toContain("Observations above:");
    expect(prefix).not.toContain(PREPARATION_HEADING);
    expect(prefix).not.toContain("Intents already under this goal");
  }, 60_000);
});
