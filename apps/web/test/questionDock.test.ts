/** The question dock's rules (A7-Q), without a browser. */
import { describe, expect, test } from "bun:test";

import type { PendingQuestion, QuestionField } from "@bit/contracts";

import {
  EMPTY_DRAFT,
  answerabilityNote,
  answeredCounts,
  answeredLine,
  choose,
  draftAnswers,
  kindTag,
  progressBar,
  questionSignature,
  requirementLabel,
  visit,
  write,
} from "../src/lib/questionDock";

const one: QuestionField = {
  key: "host",
  header: "Host",
  question: "Which host?",
  kind: "one",
  options: [
    { label: "a", description: null },
    { label: "b", description: null },
  ],
  custom: true,
  required: false,
};
const any: QuestionField = { ...one, key: "depth", kind: "any" };
const words: QuestionField = {
  ...one,
  key: "why",
  kind: "text",
  options: [],
  required: true,
};

describe("the draft", () => {
  test("a choose-one takes one option, and words replace it; a choose-any toggles and adds words", () => {
    let draft = choose(one, EMPTY_DRAFT, "a");
    draft = choose(one, draft, "b");
    expect(draftAnswers([one], draft)).toEqual({ host: ["b"] });
    draft = write(one, draft, " mine ");
    expect(draftAnswers([one], draft)).toEqual({ host: ["mine"] });
    draft = choose(any, draft, "a");
    draft = choose(any, draft, "b");
    draft = choose(any, draft, "a");
    draft = write(any, draft, "c");
    expect(draftAnswers([any], draft)).toEqual({ depth: ["b", "c"] });
    expect(requirementLabel(any, draft)).toBe("2 selected");
  });

  test("answered and skipped are counted; a skipped one is left out of the answers", () => {
    let draft = choose(one, EMPTY_DRAFT, "a");
    draft = visit(any, draft);
    expect(answeredCounts([one, any, words], draft)).toEqual({
      answered: 1,
      skipped: 1,
    });
    expect(answeredLine({ answered: 1, skipped: 1 })).toBe(
      "1 answered · 1 skipped",
    );
    expect(answeredLine({ answered: 0, skipped: 0 })).toBe("");
    expect(draftAnswers([one, any, words], draft)).toEqual({ host: ["a"] });
  });

  test("tags and requirement", () => {
    expect([one, any, words].map((field) => kindTag(field.kind))).toEqual([
      "Choose one",
      "Choose any",
      "Your words",
    ]);
    expect(requirementLabel(words, EMPTY_DRAFT)).toBe("Required");
    expect(requirementLabel(one, EMPTY_DRAFT)).toBe("Optional");
  });
});

describe("the header's bar", () => {
  test("one segment a question up to twelve, then one run filled to the share answered", () => {
    const twelve = Array.from({ length: 12 }, (_, at) => ({
      ...one,
      key: `k${String(at)}`,
    }));
    const bar = progressBar(twelve, choose(twelve[0]!, EMPTY_DRAFT, "a"), 1);
    expect(bar._tag === "segments" ? bar.segments.slice(0, 3) : []).toEqual([
      "done",
      "current",
      "open",
    ]);
    const thirteen = [...twelve, { ...one, key: "k12" }];
    const run = progressBar(
      thirteen,
      choose(thirteen[0]!, EMPTY_DRAFT, "a"),
      0,
    );
    expect(run).toEqual({ _tag: "continuous", filled: 1 / 13 });
  });
});

describe("what identifies a question set, and the dock's sentence", () => {
  const pending = (over: Partial<PendingQuestion>): PendingQuestion => ({
    questionId: "toolu_1",
    harnessSessionId: "ses",
    fields: [one],
    askedAt: null,
    answerability: "live",
    attemptId: null,
    roundId: null,
    goalId: null,
    importId: "imp",
    ...over,
  });

  test("a question withdrawn and offered back under its call id keeps its draft", () => {
    expect(questionSignature(pending({}))).toBe(
      questionSignature(
        pending({ questionId: "call:toolu_1", answerability: "message" }),
      ),
    );
    expect(questionSignature(pending({}))).not.toBe(
      questionSignature(pending({ harnessSessionId: "other" })),
    );
  });

  test("live says nothing; message offers a message where the chat takes one; otherwise it cannot be answered", () => {
    expect(answerabilityNote(pending({}), "The importer", true)).toBe("");
    expect(
      answerabilityNote(
        pending({ answerability: "message" }),
        "The importer",
        true,
      ),
    ).toContain("ordinary message");
    expect(
      answerabilityNote(
        pending({ answerability: "message" }),
        "The importer",
        false,
      ),
    ).toContain("cannot be carried on");
    expect(
      answerabilityNote(
        pending({ answerability: "not_resumable" }),
        "The importer",
        true,
      ),
    ).toContain("cannot be carried on");
  });
});
