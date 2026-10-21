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
  RUNNING_ATTEMPT_ID,
  SUMMARY_CONDITIONS,
  SUMMARY_OBSERVATION_ID,
  multiCaseInput,
  writeFirstSliceDatabase,
} from "../persistence/fixtures";
import { ObservationStore, type CallerContext } from "../persistence/store";
import {
  BriefingError,
  PREPARATION_HEADING,
  buildBriefing,
  renderBriefing,
  stablePrefixOf,
} from "./briefing";

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
  attemptFence: 0,
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
    // Selection keeps the most recent, because a later observation qualifies an earlier
    // one; the kept ones are then listed oldest first.
    expect(briefing.observations.map((item) => item.sequence)).toEqual([2, 3]);
    expect(briefing.omittedObservationIds).toEqual(["obs_000001_attempt-1"]);
    expect(renderBriefing(briefing)).toContain(
      "Their absence above does not mean the graph lacks them",
    );
  });

  test("every recorded dimension is its own addressable question, including repeated wording", async () => {
    // Deliberately not deduplicated by text. Two observations that recorded the same
    // sentence recorded two separate questions, and collapsing them would be the fuzzy
    // matching addresses exist to avoid — it would also mean addressing one silently
    // closed the other.
    const briefing = await withSeeded(
      () => buildBriefing("intent-1"),
      [
        input({ operationId: "a", untestedDimensions: ["x", "y"] }),
        input({ operationId: "b", untestedDimensions: ["y", "z"] }),
      ],
    );

    expect(
      briefing.openQuestions.map((question) => [
        question.address,
        question.dimension,
        question.status,
      ]),
    ).toEqual([
      // Newest raising observation first, then recorded position.
      ["obs_000002_attempt-1#u0", "y", "uninvestigated"],
      ["obs_000002_attempt-1#u1", "z", "uninvestigated"],
      ["obs_000001_attempt-1#u0", "x", "uninvestigated"],
      ["obs_000001_attempt-1#u1", "y", "uninvestigated"],
    ]);
    expect(
      briefing.openQuestions.every(
        (question) => question.addressedBy.length === 0,
      ),
    ).toBe(true);
  });

  test("a later observation that cites an address moves that question, and only that one", async () => {
    const briefing = await withSeeded(
      (store) =>
        Effect.gen(function* () {
          // The first write is already in place from `withSeeded`'s own list.
          yield* store.recordObservation(
            CALLER,
            input({
              operationId: "follow-up",
              outcome: "negative",
              testedClaim: "The per-account limit refuses at 100.",
              untestedDimensions: [],
              addressesDimensions: ["obs_000001_attempt-1#u1"],
            }),
          );
          return yield* buildBriefing("intent-1");
        }),
      [input({ operationId: "raiser", untestedDimensions: ["x", "y"] })],
    );

    const addressed = briefing.openQuestions.find(
      (question) => question.address === "obs_000001_attempt-1#u1",
    );
    const untouched = briefing.openQuestions.find(
      (question) => question.address === "obs_000001_attempt-1#u0",
    );

    // A negative outcome is still evidence relative to its own claim.
    expect(addressed?.status).toBe("addressedWithEvidence");
    expect(addressed?.addressedBy.map((item) => item.observationId)).toEqual([
      "obs_000002_attempt-1",
    ]);
    expect(addressed?.addressedBy[0]?.outcome).toBe("negative");
    // The sibling dimension of the same observation is not swept along with it.
    expect(untouched?.status).toBe("uninvestigated");
    expect(untouched?.addressedBy).toHaveLength(0);
  });

  test("an inconclusive follow-up is addressed but still undecided", async () => {
    const briefing = await withSeeded(
      (store) =>
        Effect.gen(function* () {
          yield* store.recordObservation(
            CALLER,
            input({
              operationId: "inconclusive-follow-up",
              outcome: "inconclusive",
              untestedDimensions: [],
              addressesDimensions: ["obs_000001_attempt-1#u0"],
            }),
          );
          return yield* buildBriefing("intent-1");
        }),
      [input({ operationId: "raiser", untestedDimensions: ["x"] })],
    );

    const question = briefing.openQuestions.find(
      (item) => item.address === "obs_000001_attempt-1#u0",
    );
    // Work happened and decided nothing. That is not progress on the claim, and it is
    // not the same state as untouched.
    expect(question?.status).toBe("addressedInconclusive");
    expect(question?.addressedBy).toHaveLength(1);

    const rendered = renderBriefing(briefing);
    expect(rendered).toContain("Addressed, still undecided");
    expect(rendered).toContain("Nothing in this system closes a question");
  });

  test("a question raised by a truncated observation is still listed, and labelled as omitted", async () => {
    // Truncating the body must not drop the question: the briefing would otherwise
    // forget an open dimension purely because the briefing was full.
    const briefing = await withSeeded(
      () => buildBriefing("intent-1", 1),
      [
        input({ operationId: "old", untestedDimensions: ["from the old one"] }),
        input({ operationId: "new", untestedDimensions: ["from the new one"] }),
      ],
    );

    expect(briefing.truncated).toBe(true);
    expect(briefing.observations).toHaveLength(1);
    const fromOmitted = briefing.openQuestions.find(
      (question) => question.dimension === "from the old one",
    );
    expect(fromOmitted).toBeDefined();
    expect(fromOmitted?.raisedBy.includedInBriefing).toBe(false);
    expect(renderBriefing(briefing)).toContain(
      "it is omitted from this briefing, not absent from the graph",
    );
  });

  test("the rendered briefing prints the address a worker has to cite", async () => {
    const rendered = await withSeeded(
      () => Effect.map(buildBriefing("intent-1"), renderBriefing),
      [
        input({
          operationId: "a",
          untestedDimensions: ["the per-account limit"],
        }),
      ],
    );

    expect(rendered).toContain(
      "[obs_000001_attempt-1#u0] the per-account limit",
    );
    expect(rendered).toContain("addresses_dimensions");
    expect(rendered).toContain("Uninvestigated (1)");
  });

  test("an observation's own block names none of its dimensions, so retiring one cannot rewrite it", async () => {
    // The precondition for disposing of a question at all (§17). A dimension's text is
    // immutable, but its *visibility* is not: addressing or retiring one changes whether
    // it is shown. Printed inside an observation's block, that would rewrite a block
    // earlier briefings already emitted — so every dimension is rendered once, in the
    // volatile tail, and the stable prefix must be able to say nothing about it.
    const rendered = await withSeeded(
      () => Effect.map(buildBriefing("intent-1"), renderBriefing),
      [
        input({
          operationId: "a",
          untestedDimensions: ["the per-account limit", "IPv6 /64 rotation"],
        }),
      ],
    );

    const stable = stablePrefixOf(rendered);
    expect(stable).toContain("### obs_000001_attempt-1");
    for (const address of [
      "obs_000001_attempt-1#u0",
      "obs_000001_attempt-1#u1",
    ]) {
      expect(stable).not.toContain(address);
      expect(rendered).toContain(address);
    }
    // Not an accident of truncation: the evidence's own caveats stay in the block.
    expect(stable).toContain("- limitations:");
  });

  test("a briefing with one more observation extends the previous one byte for byte", async () => {
    // The property the layout exists for: everything above the preparation heading is
    // the intent plus the observations recorded under it, oldest first, so a later
    // briefing starts with the earlier one. A count or a sequence number above that
    // heading would break this, which is why the assertion is on bytes and not on
    // whether the same strings are present somewhere.
    const [before, after] = await withSeeded(
      (store) =>
        Effect.gen(function* () {
          const first = yield* Effect.map(
            buildBriefing("intent-1"),
            renderBriefing,
          );
          yield* store.recordObservation(
            CALLER,
            input({
              operationId: "second",
              testedClaim: "The per-account limit refuses at 100.",
            }),
          );
          const second = yield* Effect.map(
            buildBriefing("intent-1"),
            renderBriefing,
          );
          return [first, second] as const;
        }),
      [input({ operationId: "first" })],
    );

    const stable = stablePrefixOf(before);
    expect(stable).toContain("### obs_000001_attempt-1");
    expect(after.startsWith(stable)).toBe(true);
    // Not vacuous: the second briefing really did grow, and the volatile tail really
    // did change rather than being identical by accident.
    expect(stablePrefixOf(after).length).toBeGreaterThan(stable.length);
    expect(stablePrefixOf(after)).toContain("### obs_000002_attempt-1");
    expect(after).toContain("graph sequence 2");
    expect(before).toContain("graph sequence 1");
  });

  test("nothing above the preparation heading depends on how much was recorded", async () => {
    // Stated as its own check because the failure mode is a well-meaning edit: moving a
    // count or the sequence into a heading reads better and silently costs the property
    // above. Everything that restates the record belongs below the line.
    const rendered = await withSeeded(
      () => Effect.map(buildBriefing("intent-1", 1), renderBriefing),
      [
        input({ operationId: "a", untestedDimensions: ["x"] }),
        input({ operationId: "b", untestedDimensions: ["y"] }),
      ],
    );

    const head = stablePrefixOf(rendered);
    expect(head).not.toContain("graph sequence");
    expect(head).not.toContain("Observations above:");
    expect(head).not.toContain("Disclosed omissions");
    expect(head).not.toContain("Open questions");
    // And the tail still carries all of it, so nothing was dropped on the way down.
    const tail = rendered.slice(rendered.indexOf(PREPARATION_HEADING));
    expect(tail).toContain("graph sequence 2");
    expect(tail).toContain(
      "Observations above: 1 of 2 recorded for this intent.",
    );
    expect(tail).toContain("## Disclosed omissions");
    expect(tail).toContain("Open questions carried forward (2)");
  });

  test("the stable part is rewritten once the truncation window slides, and that is said plainly", async () => {
    // The honest limit of the property. With a window of two, a third observation drops
    // the oldest included one, so the stable part no longer starts where it did. A
    // planner round after that point pays for a full prefix again; nothing is lost from
    // the graph, and the omission is disclosed as always.
    const [twoRows, threeRows] = await withSeeded(
      (store) =>
        Effect.gen(function* () {
          const first = yield* Effect.map(
            buildBriefing("intent-1", 2),
            renderBriefing,
          );
          yield* store.recordObservation(
            CALLER,
            input({ operationId: "third" }),
          );
          const second = yield* Effect.map(
            buildBriefing("intent-1", 2),
            renderBriefing,
          );
          return [first, second] as const;
        }),
      [input({ operationId: "first" }), input({ operationId: "second" })],
    );

    expect(threeRows.startsWith(stablePrefixOf(twoRows))).toBe(false);
    expect(stablePrefixOf(twoRows)).toContain("### obs_000001_attempt-1");
    expect(stablePrefixOf(threeRows)).not.toContain("### obs_000001_attempt-1");
    expect(threeRows).toContain("- obs_000001_attempt-1");
    expect(threeRows).toContain(
      "Their absence above does not mean the graph lacks them",
    );
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
            // The adopted database's running attempt: a settled one has no authority.
            callerScope: `fixture-local/${RUNNING_ATTEMPT_ID}`,
            targetId: "fixture-local",
            intentId: "intent-per-client-limiter",
            attemptId: RUNNING_ATTEMPT_ID,
            harnessSessionId: "ses_new",
            workerId: "worker-1",
            attemptFence: 0,
          },
          input({ operationId: "op-after-upgrade" }),
        );
        return yield* Effect.map(
          buildBriefing("intent-per-client-limiter"),
          renderBriefing,
        );
      }),
    );

    expect(rendered).toContain(
      "Observations above: 2 of 2 recorded for this intent.",
    );
    expect(rendered).toContain("RECORD FORMAT: summary");
    expect(rendered).toContain("cases (2)");
    // Oldest first, so the summary-format row this database was adopted with leads and
    // the case-based one recorded after the upgrade follows it.
    expect(rendered.indexOf("RECORD FORMAT: summary")).toBeLessThan(
      rendered.indexOf("cases (2)"),
    );
  });
});
