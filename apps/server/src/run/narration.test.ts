/**
 * The narration bus's one rule beyond publishing (slice 3 fix, M1): when a question settles
 * and the subject's agent still waits on another, that one is published again, so a chat
 * that docks the newest question it heard of docks the next without a reload.
 */
import { describe, expect, test } from "bun:test";

import { Effect, Fiber, Stream } from "effect";

import type {
  HarnessNarration,
  HarnessQuestion,
} from "../harness/agentHarness";
import { RunNarrations, type NarrationSubject } from "./narration";

const SUBJECT: NarrationSubject = { _tag: "import", importId: "imp_1" };
const OTHER: NarrationSubject = { _tag: "import", importId: "imp_2" };

const question = (questionId: string): HarnessQuestion => ({
  questionId,
  fields: [
    {
      key: "q0",
      header: null,
      question: `Which ${questionId}?`,
      kind: "text",
      options: [],
      custom: true,
      required: false,
    },
  ],
  askedAt: 1,
  callId: questionId,
});

const asked = (questionId: string): HarnessNarration => ({
  type: "question",
  sequence: undefined,
  at: 1,
  outcome: undefined,
  detail: { _tag: "question", question: question(questionId) },
});

const settled = (
  questionId: string,
  how: "answered" | "dismissed" | "withdrawn",
): HarnessNarration => ({
  type: "question",
  sequence: undefined,
  at: 2,
  outcome: undefined,
  detail: { _tag: "questionSettled", questionId, settled: how },
});

/** Publishes `entries` in order and reads back what a subscriber saw, as short lines. */
const through = (
  entries: readonly (readonly [NarrationSubject, HarnessNarration])[],
  expected: number,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* RunNarrations;
        const seen = yield* Effect.forkScoped(
          bus
            .subscribe({ targetId: "t1" })
            .pipe(
              Stream.take(expected),
              Stream.runCollect,
              Effect.timeout("2 seconds"),
            ),
        );
        while ((yield* bus.subscriberCount) === 0) yield* Effect.yieldNow;
        for (const [subject, entry] of entries) {
          yield* bus.publish({
            targetId: "t1",
            subject,
            harnessSessionId: "ses_1",
            entry,
          });
        }
        const collected = yield* Fiber.join(seen);
        const waiting = yield* bus.waiting(SUBJECT);
        return {
          lines: [...collected].map((item) => {
            const who =
              item.subject._tag === "import" ? item.subject.importId : "";
            const detail = item.entry.detail;
            return detail._tag === "question"
              ? `${who} asked ${detail.question.questionId}`
              : detail._tag === "questionSettled"
                ? `${who} ${detail.settled} ${detail.questionId}`
                : detail._tag;
          }),
          ids: [...collected].map((item) => item.id),
          waiting: waiting?.questionId,
        };
      }).pipe(Effect.provide(RunNarrations.layer)),
    ),
  );

describe("RunNarrations: the next question after a settle (slice 3 fix, M1)", () => {
  test("settling the newest of two says the other again, under the same subject; settling the last says nothing more", async () => {
    const outcome = await through(
      [
        [SUBJECT, asked("a")],
        [SUBJECT, asked("b")],
        [SUBJECT, settled("b", "answered")],
        [SUBJECT, settled("a", "dismissed")],
      ],
      5,
    );
    expect(outcome.lines).toEqual([
      "imp_1 asked a",
      "imp_1 asked b",
      "imp_1 answered b",
      "imp_1 asked a",
      "imp_1 dismissed a",
    ]);
    // Each its own id, in publish order.
    expect(outcome.ids).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.waiting).toBeUndefined();
  });

  test("a withdrawal says the next too, and another subject's questions are not this one's", async () => {
    const outcome = await through(
      [
        [OTHER, asked("x")],
        [SUBJECT, asked("a")],
        [SUBJECT, asked("b")],
        [SUBJECT, settled("a", "withdrawn")],
        [OTHER, settled("x", "answered")],
      ],
      6,
    );
    expect(outcome.lines).toEqual([
      "imp_2 asked x",
      "imp_1 asked a",
      "imp_1 asked b",
      "imp_1 withdrawn a",
      "imp_1 asked b",
      "imp_2 answered x",
    ]);
    // Still waiting on one: Needs you counts the subject once.
    expect(outcome.waiting).toBe("b");
  });
});
