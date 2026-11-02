/**
 * Real-SQLite tests for the two reads the "Agent sessions" list adds
 * (`goalSessionsForTarget`, `workerSessionsForTarget`).
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

import { ObservationStore, type SeedInput } from "./store";

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
