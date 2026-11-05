/**
 * Real-SQLite tests for the reads the "Agent sessions" list adds
 * (`goalSessionsForTarget`, `workerSessionsForTarget`, and A7 U8b's
 * `plannerSessionsForTarget`).
 *
 * Nothing checks a SQL identifier or a placeholder at compile time, so each read is executed
 * against a real migrated file. The rows come from the **real write paths** —
 * `seedAttempt` for goals, intents and attempts, `recordGoalSession` for the goal index —
 * because the claim is that the reads agree with what those functions leave behind: that the
 * join from a session row to the goal or intent it is about lands, and that the target filter
 * and the bound hold.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { ObservationStore, operatorScope, type SeedInput } from "./store";

type Store = ObservationStore["Service"];

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const withStore = <A, E>(
  use: (store: Store) => Effect.Effect<A, E>,
): Promise<A> => {
  const directory = mkdtempSync(join(tmpdir(), "bit-agent-sessions-"));
  directories.push(directory);
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(ObservationStore.layer(join(directory, "hunt.sqlite"))),
      ),
    ),
  );
};

const seed = (tag: string, over: Partial<SeedInput> = {}): SeedInput => ({
  targetId: "target-1",
  goalId: `goal-${tag}`,
  goal: `Objective ${tag}`,
  intentId: `intent-${tag}`,
  question: `Question ${tag}?`,
  attemptId: `attempt-${tag}`,
  workerId: "worker-1",
  harnessInstanceId: "opencode",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  modelOptions: null,
  harnessSessionId: `ses-${tag}`,
  ...over,
});

describe("the goal sessions of a target", () => {
  test("lists a goal conversation with the goal's own words, newest first, for this target only", async () => {
    const rows = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        yield* store.seedAttempt(seed("b"));
        yield* store.seedAttempt(
          seed("c", { targetId: "target-2", goalId: "goal-elsewhere" }),
        );
        yield* store.recordGoalSession({
          goalId: "goal-a",
          targetId: "target-1",
          harnessSessionId: "gses-a",
          harnessInstanceId: "claude-code",
          model: "anthropic/claude-sonnet-5",
        });
        yield* store.recordGoalSession({
          goalId: "goal-elsewhere",
          targetId: "target-2",
          harnessSessionId: "gses-elsewhere",
          harnessInstanceId: null,
          model: "anthropic/claude-sonnet-5",
        });
        return yield* store.goalSessionsForTarget("target-1");
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      goalId: "goal-a",
      // `seedAttempt` mints an unnamed goal, so the objective stands in for the name.
      goalName: "Objective a",
      harnessSessionId: "gses-a",
      harnessInstanceId: "claude-code",
      model: "anthropic/claude-sonnet-5",
    });
  });

  test("re-recording a conversation replaces its model with the new session's", async () => {
    const rows = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        const base = {
          goalId: "goal-a",
          targetId: "target-1",
          harnessInstanceId: "claude-code",
        };
        yield* store.recordGoalSession({
          ...base,
          harnessSessionId: "gses-1",
          model: "anthropic/claude-sonnet-5",
        });
        yield* store.recordGoalSession({
          ...base,
          harnessSessionId: "gses-2",
          model: "anthropic/claude-opus-5-5",
        });
        return {
          list: yield* store.goalSessionsForTarget("target-1"),
          one: yield* store.goalSession("goal-a"),
        };
      }),
    );
    expect(rows.list.map((r) => [r.harnessSessionId, r.model])).toEqual([
      ["gses-2", "anthropic/claude-opus-5-5"],
    ]);
    expect(rows.one?.model).toBe("anthropic/claude-opus-5-5");
  });

  test("records what the model is set to beside it, and a model switch rewrites both for that session only (0003, A6 F4)", async () => {
    const outcome = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        yield* store.recordGoalSession({
          goalId: "goal-a",
          targetId: "target-1",
          harnessSessionId: "gses-1",
          harnessInstanceId: "claude-code",
          model: "anthropic/claude-sonnet-5",
          // Out of order on purpose: the row holds the sorted encoding.
          modelOptions: [
            { id: "thinking", value: "on" },
            { id: "effort", value: "low" },
          ],
        });
        const opened = yield* store.goalSession("goal-a");
        const switched = yield* store.recordGoalSessionModel({
          goalId: "goal-a",
          harnessSessionId: "gses-1",
          model: "anthropic/claude-opus-5-5",
          modelOptions: [{ id: "effort", value: "high" }],
        });
        const afterSwitch = yield* store.goalSession("goal-a");
        // Decided against a session the row no longer names: nothing is written.
        const stale = yield* store.recordGoalSessionModel({
          goalId: "goal-a",
          harnessSessionId: "gses-0",
          model: "anthropic/claude-haiku-4-5",
          modelOptions: undefined,
        });
        const cleared = yield* store.recordGoalSessionModel({
          goalId: "goal-a",
          harnessSessionId: "gses-1",
          model: "anthropic/claude-haiku-4-5",
          modelOptions: undefined,
        });
        const afterClear = yield* store.goalSession("goal-a");
        // A later open on the same goal replaces the options with its own, none included.
        yield* store.recordGoalSession({
          goalId: "goal-a",
          targetId: "target-1",
          harnessSessionId: "gses-2",
          harnessInstanceId: "claude-code",
          model: "anthropic/claude-sonnet-5",
          modelOptions: [{ id: "effort", value: "low" }],
        });
        yield* store.recordGoalSession({
          goalId: "goal-a",
          targetId: "target-1",
          harnessSessionId: "gses-3",
          harnessInstanceId: "claude-code",
          model: "anthropic/claude-sonnet-5",
        });
        return {
          opened,
          switched,
          afterSwitch,
          stale,
          cleared,
          afterClear,
          reopened: yield* store.goalSession("goal-a"),
          list: yield* store.goalSessionsForTarget("target-1"),
        };
      }),
    );
    expect(outcome.opened?.modelOptions).toEqual([
      { id: "effort", value: "low" },
      { id: "thinking", value: "on" },
    ]);
    expect(outcome.switched).toBe(true);
    expect(outcome.afterSwitch).toMatchObject({
      harnessSessionId: "gses-1",
      harnessInstanceId: "claude-code",
      model: "anthropic/claude-opus-5-5",
      modelOptions: [{ id: "effort", value: "high" }],
    });
    expect(outcome.stale).toBe(false);
    expect(outcome.cleared).toBe(true);
    expect(outcome.afterClear?.model).toBe("anthropic/claude-haiku-4-5");
    expect(outcome.afterClear?.modelOptions).toBeNull();
    expect(outcome.reopened?.harnessSessionId).toBe("gses-3");
    expect(outcome.reopened?.modelOptions).toBeNull();
    expect(outcome.list.map((row) => row.model)).toEqual([
      "anthropic/claude-sonnet-5",
    ]);
  });

  test("a goal nobody has talked to is not a session", async () => {
    const rows = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        return yield* store.goalSessionsForTarget("target-1");
      }),
    );
    expect(rows).toEqual([]);
  });
});

describe("the worker sessions of a target", () => {
  test("lists an attempt as a session with the question it was asked and its model", async () => {
    const listed = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        yield* store.seedAttempt(
          seed("b", { targetId: "target-2", goalId: "goal-elsewhere" }),
        );
        return yield* store.workerSessionsForTarget("target-1", 10);
      }),
    );
    expect(listed.total).toBe(1);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      attemptId: "attempt-a",
      question: "Question a?",
      harnessSessionId: "ses-a",
      harnessInstanceId: "opencode",
      model: "openai/gpt-5.6-sol",
      status: "running",
      endedAt: null,
    });
  });

  test("an attempt whose session does not exist yet is neither listed nor counted", async () => {
    const listed = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a", { harnessSessionId: null }));
        return yield* store.workerSessionsForTarget("target-1", 10);
      }),
    );
    expect(listed).toEqual({ sessions: [], total: 0 });
  });

  test("the bound limits the list and the total still counts what it hid", async () => {
    const listed = await withStore((store) =>
      Effect.gen(function* () {
        for (const tag of ["a", "b", "c"]) yield* store.seedAttempt(seed(tag));
        return yield* store.workerSessionsForTarget("target-1", 2);
      }),
    );
    expect(listed.sessions).toHaveLength(2);
    expect(listed.total).toBe(3);
  });
});

describe("the planner sessions of a target (A7 U8b)", () => {
  const host = (targetId: string) =>
    ({ callerScope: operatorScope(targetId), targetId }) as const;

  test("one per goal's lineage, with its latest round's status, model and ending, for this target only", async () => {
    const rows = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        yield* store.seedAttempt(seed("b"));
        yield* store.seedAttempt(
          seed("c", { targetId: "target-2", goalId: "goal-elsewhere" }),
        );
        yield* store.recordPlannerLineage("goal-a", "pses-a");
        yield* store.recordPlannerLineage("goal-b", "pses-b");
        yield* store.recordPlannerLineage("goal-elsewhere", "pses-c");
        // goal-a: an earlier round settled, then a later one still running.
        yield* store.openRound(host("target-1"), {
          goalId: "goal-a",
          roundId: "round-a1",
          budget: 3,
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.5",
          harnessSessionId: "pses-a",
        });
        yield* store.settleRound("round-a1", "settled", {
          _tag: "supervisor",
        });
        yield* Effect.sleep("5 millis");
        yield* store.openRound(host("target-1"), {
          goalId: "goal-a",
          roundId: "round-a2",
          budget: 3,
          harnessInstanceId: "claude-code",
          providerId: "anthropic",
          modelId: "claude-sonnet-5",
          harnessSessionId: "pses-a",
        });
        yield* store.openRound(host("target-2"), {
          goalId: "goal-elsewhere",
          roundId: "round-c1",
          budget: 3,
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.5",
          harnessSessionId: "pses-c",
        });
        return yield* store.plannerSessionsForTarget("target-1");
      }),
    );
    expect(rows.map((row) => row.goalId).sort()).toEqual(["goal-a", "goal-b"]);
    const a = rows.find((row) => row.goalId === "goal-a");
    expect(a).toMatchObject({
      goalName: "Objective a",
      harnessSessionId: "pses-a",
      round: {
        roundId: "round-a2",
        status: "running",
        harnessInstanceId: "claude-code",
        model: "anthropic/claude-sonnet-5",
        endedAt: null,
      },
    });
    // A lineage whose rounds were never recorded reads with no round at all.
    expect(rows.find((row) => row.goalId === "goal-b")?.round).toBeNull();
  });

  test("a settled latest round carries its ending", async () => {
    const rows = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt(seed("a"));
        yield* store.recordPlannerLineage("goal-a", "pses-a");
        yield* store.openRound(host("target-1"), {
          goalId: "goal-a",
          roundId: "round-a1",
          budget: 3,
          harnessInstanceId: "opencode",
          providerId: null,
          modelId: null,
          harnessSessionId: "pses-a",
        });
        yield* store.settleRound("round-a1", "interrupted", {
          _tag: "supervisor",
        });
        return yield* store.plannerSessionsForTarget("target-1");
      }),
    );
    expect(rows[0]?.round).toMatchObject({
      roundId: "round-a1",
      status: "interrupted",
      model: null,
    });
    expect(rows[0]?.round?.endedAt).toBeNumber();
  });
});
