/**
 * Tests the deterministic briefing against real stored rows.
 *
 * A briefing is the only thing a fresh session gets, so the properties that matter are
 * about what it must not quietly lose: an unknown intent must be a named failure rather
 * than an empty briefing, and truncation must be disclosed rather than silent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RecordObservationInput } from "@bit/contracts";
import { Effect } from "effect";

import {
  SUMMARY_CONDITIONS,
  SUMMARY_OBSERVATION_ID,
  multiCaseInput,
  writeFirstSliceDatabase,
} from "../persistence/fixtures";
import { ObservationStore, type CallerContext } from "../persistence/store";
import { BriefingError, buildBriefing, renderBriefing } from "./briefing";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-briefing-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const CALLER: CallerContext = {
  callerScope: "target-1/attempt-1",
  targetId: "target-1",
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_abc",
  workerId: "worker-1",
};

const input = multiCaseInput;

const withSeeded = <A, E>(
  use: (
    store: ObservationStore["Service"],
  ) => Effect.Effect<A, E, ObservationStore>,
  writes: readonly RecordObservationInput[] = [input()],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ObservationStore;
        yield* store.seedAttempt({
          targetId: "target-1",
          goalId: "goal-1",
          goal: "Determine whether authentication rate limits can be bypassed.",
          intentId: "intent-1",
          question: "Probe the per-client limiter on POST /login.",
          attemptId: "attempt-1",
          workerId: "worker-1",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          harnessSessionId: "ses_abc",
        });
        for (const write of writes) {
          yield* store.recordObservation(CALLER, write);
        }
        return yield* use(store);
      }).pipe(Effect.provide(ObservationStore.layer(newDatabasePath()))),
    ),
  );

describe("buildBriefing", () => {
  test("renders stored observations with their cases and bounds intact", async () => {
    const rendered = await withSeeded(() =>
      Effect.map(buildBriefing("intent-1"), renderBriefing),
    );

    expect(rendered).toContain("Probe the per-client limiter");
    expect(rendered).toContain("relative to the tested claim only");
    // Interpretation must stay labelled as the worker's, not as fact.
    expect(rendered).toContain("worker interpretation (not established fact)");
    expect(rendered).toContain("per-account limit was never approached");
  });

  test("every case's actors, ownership facts and ordered actions reach the page", async () => {
    // This is the whole point of the multi-case shape: a fresh session has to be able
    // to see which identity got which response, not a single flattened sentence.
    const rendered = await withSeeded(() =>
      Effect.map(buildBriefing("intent-1"), renderBriefing),
    );

    expect(rendered).toContain("cases (2)");
    expect(rendered).toContain("case case-saturate:");
    expect(rendered).toContain("case case-rotate:");
    // Actor, endpoint, method, count and response stay associated, in order.
    expect(rendered).toContain(
      "1. [fixed] POST http://127.0.0.1:9/login (11 requests)",
    );
    expect(rendered).toContain(
      "1. [rotated] POST http://127.0.0.1:9/login (1 request)",
    );
    expect(rendered).toContain("2. [anonymous-probe] POST");
    expect(rendered).toContain("429 rate_limited");
    // Null account and role are rendered as the facts they are, not as blanks.
    expect(rendered).toContain("account=none (unauthenticated)");
    expect(rendered).toContain("role=unknown/not applicable");
    expect(rendered).toContain("alice --owns--> session-fixed-a");
    // Per-case bounds and limitations survive alongside the overall ones.
    expect(rendered).toContain("test bounds: 11 requests, one identity");
    expect(rendered).toContain("case limitations: Single short window");
    // Concurrency is stated rather than implied by the list order.
    expect(rendered).toContain("concurrently");
  });

  test("an unknown intent is a tagged BriefingError, not an empty briefing", async () => {
    // `Effect<Briefing, Error>` used to erase this into the same channel as a SQLite
    // failure, which left a caller nothing to branch on.
    const failure = await withSeeded(() =>
      Effect.result(buildBriefing("intent-does-not-exist")),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(failure.failure).toBeInstanceOf(BriefingError);
      expect(failure.failure._tag).toBe("BriefingError");
      if (failure.failure._tag === "BriefingError") {
        expect(failure.failure.reason).toBe("unknown_intent");
        expect(failure.failure.intentId).toBe("intent-does-not-exist");
      }
    }
  });

  test("truncation is disclosed by ID rather than silently dropping evidence", async () => {
    const writes = [0, 1, 2].map((index) =>
      input({ operationId: `op-${index}`, testedClaim: `claim ${index}` }),
    );
    const briefing = await withSeeded(
      () => buildBriefing("intent-1", 2),
      writes,
    );

    expect(briefing.truncated).toBe(true);
    expect(briefing.observations).toHaveLength(2);
    expect(briefing.omittedObservationIds).toHaveLength(1);
    // Most recent first: a later observation qualifies an earlier one.
    expect(briefing.observations[0]?.sequence).toBe(3);
    expect(renderBriefing(briefing)).toContain(
      "Their absence above does not mean the graph lacks them",
    );
  });

  test("open questions are the recorded untested dimensions, deduplicated", async () => {
    const briefing = await withSeeded(
      () => buildBriefing("intent-1"),
      [
        input({ operationId: "a", untestedDimensions: ["x", "y"] }),
        input({ operationId: "b", untestedDimensions: ["y", "z"] }),
      ],
    );
    expect([...briefing.openQuestions]).toEqual(["y", "z", "x"]);
  });

  test("the briefing records the sequence it was prepared at", async () => {
    const briefing = await withSeeded(() => buildBriefing("intent-1"));
    expect(briefing.preparedAtSequence).toBe(1);
    expect(renderBriefing(briefing)).toContain("graph sequence 1");
  });
});

describe("briefings over an upgraded database", () => {
  const upgraded = <A, E>(
    use: (
      store: ObservationStore["Service"],
    ) => Effect.Effect<A, E, ObservationStore>,
  ) => {
    const path = newDatabasePath();
    return writeFirstSliceDatabase(path).then(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* ObservationStore;
            return yield* use(store);
          }).pipe(Effect.provide(ObservationStore.layer(path))),
        ),
      ),
    );
  };

  test("a summary observation is rendered, labelled, and not dressed up as cases", async () => {
    const rendered = await upgraded(() =>
      Effect.map(buildBriefing("intent-per-client-limiter"), renderBriefing),
    );

    expect(rendered).toContain(SUMMARY_OBSERVATION_ID);
    expect(rendered).toContain("RECORD FORMAT: summary (one prose record");
    // The reader is told why the single prose identity must not be read as one actor.
    expect(rendered).toContain("may cover more than one");
    expect(rendered).toContain("has not been");
    expect(rendered).toContain(SUMMARY_CONDITIONS.clientIdentity);
    expect(rendered).toContain("requests issued (total): 14");
    // No invented structure.
    expect(rendered).not.toContain("cases (");
    expect(rendered).not.toContain("actions, in the order performed");
    // Its claim, outcome and limits are still carried forward in full.
    expect(rendered).toContain("outcome: positive");
    expect(rendered).toContain("Per-account limiting was out of scope.");
  });

  test("both record formats appear side by side, each in its own shape", async () => {
    const rendered = await upgraded((store) =>
      Effect.gen(function* () {
        yield* store.recordObservation(
          {
            callerScope: "fixture-local/attempt-summary",
            targetId: "fixture-local",
            intentId: "intent-per-client-limiter",
            attemptId: "attempt-summary",
            harnessSessionId: "ses_new",
            workerId: "worker-1",
          },
          input({ operationId: "op-after-upgrade" }),
        );
        return yield* Effect.map(
          buildBriefing("intent-per-client-limiter"),
          renderBriefing,
        );
      }),
    );

    expect(rendered).toContain("Recorded observations (2)");
    expect(rendered).toContain("RECORD FORMAT: summary");
    expect(rendered).toContain("cases (2)");
    // Newest first, so the case-based one leads and the summary one follows.
    expect(rendered.indexOf("cases (2)")).toBeLessThan(
      rendered.indexOf("RECORD FORMAT: summary"),
    );
  });
});
