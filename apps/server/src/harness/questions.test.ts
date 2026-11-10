/**
 * The question dock's shared server half (A7-Q): reading a question tool's input, finding
 * the question a transcript ends on, the contract's answer check and the message fallback,
 * and the live frame a narrated question becomes.
 */
import { describe, expect, test } from "bun:test";
import {
  LiveFrame,
  questionAnswersAsMessage,
  questionAnswersProblem,
  type LiveItem,
  type QuestionField,
} from "@bit/contracts";
import { Schema } from "effect";

import {
  QUESTION_DISMISSED_MESSAGE,
  questionAnswersForAgent,
  questionFieldsOfInput,
  unansweredQuestion,
  waitingWords,
} from "./questions";
import { projectNarration } from "../run/liveTranscript";
import { SessionActivities } from "../run/sessionActivity";

const ASK = {
  questions: [
    {
      question: "Which colour?",
      header: "Colour",
      multiSelect: false,
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "" },
      ],
    },
    {
      question: "Which sizes?",
      header: "Sizes",
      multiSelect: true,
      multiple: true,
      options: [{ label: "S" }, { label: "L" }],
    },
    { question: "Anything else?", header: "", options: [] },
  ],
};

describe("a question tool's input", () => {
  test("Claude Code's keys are the question's text; OpenCode's are q0…qN; kinds from the options and the multi flag", () => {
    const cc = questionFieldsOfInput("claude-code", ASK);
    expect(cc?.map((field) => `${field.key}|${field.kind}`)).toEqual([
      "Which colour?|one",
      "Which sizes?|any",
      "Anything else?|text",
    ]);
    expect(cc?.[0].options[1]?.description).toBeNull();
    expect(cc?.[2]?.header).toBeNull();
    expect(cc?.every((field) => field.custom && !field.required)).toBe(true);
    const oc = questionFieldsOfInput("opencode", ASK);
    expect(oc?.map((field) => `${field.key}|${field.kind}`)).toEqual([
      "q0|one",
      "q1|any",
      "q2|text",
    ]);
  });

  test("bit's Pi tool takes Claude Code's shape and OpenCode's keys, so same-worded questions stay apart", () => {
    const pi = questionFieldsOfInput("pi", ASK);
    expect(pi?.map((field) => `${field.key}|${field.kind}`)).toEqual([
      "q0|one",
      "q1|any",
      "q2|text",
    ]);
    // `multiple` is OpenCode's flag, not this tool's.
    expect(
      questionFieldsOfInput("pi", {
        questions: [
          { question: "Which?", options: [{ label: "a" }], multiple: true },
        ],
      })?.[0].kind,
    ).toBe("one");
    expect(
      questionFieldsOfInput("pi", {
        questions: [{ question: "Same?" }, { question: "Same?" }],
      })?.map((field) => field.key),
    ).toEqual(["q0", "q1"]);
  });

  test("nothing to ask is no question: no list, an empty one, or questions without text", () => {
    expect(questionFieldsOfInput("claude-code", {})).toBeUndefined();
    expect(
      questionFieldsOfInput("claude-code", { questions: [] }),
    ).toBeUndefined();
    expect(
      questionFieldsOfInput("opencode", { questions: [{ question: " " }] }),
    ).toBeUndefined();
    // Two identical questions would share one answer on Claude Code; the second is dropped.
    expect(
      questionFieldsOfInput("claude-code", {
        questions: [{ question: "Same?" }, { question: "Same?" }],
      })?.length,
    ).toBe(1);
  });
});

describe("the question a transcript ends on (the `message` fallback's source)", () => {
  let n = 0;
  const item = (overrides: Partial<LiveItem>): LiveItem => {
    n += 1;
    return {
      _tag: "item",
      id: `replay:${String(n)}`,
      origin: "activity",
      sequence: null,
      kind: "turn.reply",
      at: 1_000 + n,
      attemptId: null,
      roundId: null,
      goalId: null,
      importId: "imp_1",
      headline: "",
      body: "",
      tool: null,
      toolName: null,
      input: null,
      output: null,
      callId: null,
      outcome: null,
      ...overrides,
    } as LiveItem;
  };
  const call = (tool = "AskUserQuestion", callId = "toolu_1") =>
    item({
      kind: "tool.call",
      tool,
      callId,
      input: JSON.stringify(ASK),
    });
  const result = (
    outcome: "ok" | "failed",
    output: string,
    callId = "toolu_1",
  ) => item({ kind: "tool.result", callId, outcome, output });
  const operator = () => item({ kind: "turn.operator", body: "hello" });

  test("a call with no result (a restart took the CLI) is unanswered", () => {
    const found = unansweredQuestion([operator(), call()]);
    expect(found?.callId).toBe("toolu_1");
    expect(found?.fields).toHaveLength(3);
  });

  test("a Stop's refusal is unanswered; bit's own dismissal and an answer are not", () => {
    expect(
      unansweredQuestion([
        call(),
        result(
          "failed",
          "The user doesn't want to proceed with this tool use.",
        ),
      ])?.callId,
    ).toBe("toolu_1");
    expect(
      unansweredQuestion([
        call(),
        result(
          "failed",
          `PreToolUse:AskUserQuestion hook error: ${QUESTION_DISMISSED_MESSAGE}`,
        ),
      ]),
    ).toBeUndefined();
    expect(
      unansweredQuestion([
        call(),
        result(
          "ok",
          'Your questions have been answered: "Which colour?"="Red"',
        ),
      ]),
    ).toBeUndefined();
  });

  test("an operator message after it moves the conversation past it; OpenCode's tool is read too, others are not", () => {
    expect(unansweredQuestion([call(), operator()])).toBeUndefined();
    expect(
      unansweredQuestion([call("question", "call_1")])?.fields[0].key,
    ).toBe("q0");
    expect(unansweredQuestion([call("Bash")])).toBeUndefined();
  });

  test("bit's Pi tool is read too: a Stop's withdrawal is unanswered, its dismissal is not", () => {
    expect(
      unansweredQuestion([
        call("ask_user_question", "call_7"),
        result(
          "failed",
          "The questions were withdrawn: the turn was stopped before the operator answered.",
          "call_7",
        ),
      ])?.fields.map((field) => field.key),
    ).toEqual(["q0", "q1", "q2"]);
    expect(
      unansweredQuestion([
        call("ask_user_question", "call_7"),
        result("failed", QUESTION_DISMISSED_MESSAGE, "call_7"),
      ]),
    ).toBeUndefined();
  });

  test("an input cut by the narration cap cannot be read back, and offers nothing", () => {
    expect(
      unansweredQuestion([
        item({
          kind: "tool.call",
          tool: "AskUserQuestion",
          callId: "toolu_1",
          input: `${JSON.stringify(ASK).slice(0, 40)}\n… (shortened)`,
        }),
      ]),
    ).toBeUndefined();
  });
});

describe("answers, checked once for the dock and the server", () => {
  const fields = questionFieldsOfInput("claude-code", ASK) ?? [];
  const required: QuestionField = { ...fields[0]!, key: "r", required: true };
  const closed: QuestionField = { ...fields[0]!, key: "c", custom: false };

  test("fitting answers pass; a skipped optional question is fine", () => {
    expect(
      questionAnswersProblem(fields, {
        "Which colour?": ["Red"],
        "Which sizes?": ["S", "L", "XL"],
      }),
    ).toBeNull();
  });

  test("each way an answer can not fit is a sentence", () => {
    expect(questionAnswersProblem(fields, { nope: ["x"] })).toContain(
      "no question",
    );
    expect(
      questionAnswersProblem(fields, { "Which colour?": ["Red", "Blue"] }),
    ).toContain("takes one answer");
    expect(
      questionAnswersProblem(fields, { "Which colour?": [" "] }),
    ).toContain("empty");
    expect(questionAnswersProblem([required], {})).toContain("needs an answer");
    expect(questionAnswersProblem([closed], { c: ["Green"] })).toContain(
      "only the answers it offers",
    );
    expect(
      questionAnswersProblem(fields, { "Which sizes?": ["mine", "yours"] }),
    ).toContain("one answer in your own words");
    expect(
      questionAnswersProblem(fields, { "Anything else?": ["x".repeat(4_001)] }),
    ).toContain("longer than");
  });

  test("as bit's Pi tool tells the model: every question in order, chosen, written or skipped", () => {
    const fields = questionFieldsOfInput("pi", ASK) ?? [];
    expect(
      questionAnswersForAgent(fields, {
        q0: ["Red"],
        q1: ["S", "XL please"],
      }),
    ).toBe(
      [
        "The operator answered your questions:",
        "1. [Colour] Which colour?",
        "   Chose: Red",
        "2. [Sizes] Which sizes?",
        "   Chose: S",
        "   In their own words: XL please",
        "3. Anything else?",
        "   Not answered.",
      ].join("\n"),
    );
  });

  test("as a message: one line per answered question, and a plain no when none was", () => {
    expect(
      questionAnswersAsMessage(fields, {
        "Which colour?": ["Blue"],
        "Which sizes?": ["S", "L"],
      }),
    ).toBe(
      "My answers to your questions:\n- Which colour? — Blue\n- Which sizes? — S, L",
    );
    expect(questionAnswersAsMessage(fields, {})).toBe(
      "I am not answering your questions.",
    );
  });
});

describe("a narrated question on the live stream and the sessions list", () => {
  const question = {
    questionId: "toolu_9",
    fields: questionFieldsOfInput("claude-code", ASK)!,
    askedAt: 5,
    callId: "toolu_9",
  };
  const narration = (
    detail: Parameters<typeof projectNarration>[0]["entry"]["detail"],
  ) => ({
    id: 1,
    targetId: "t",
    subject: { _tag: "import" as const, importId: "imp_1" },
    harnessSessionId: "ses_1",
    entry: {
      type: "x",
      sequence: undefined,
      at: 9,
      outcome: undefined,
      detail,
    },
  });

  test("asked is a `question` frame carrying the question as live; settled carries how; both decode", () => {
    const asked = projectNarration(narration({ _tag: "question", question }));
    expect(asked).toMatchObject({
      _tag: "question",
      questionId: "toolu_9",
      settled: null,
      importId: "imp_1",
      question: {
        answerability: "live",
        harnessSessionId: "ses_1",
        importId: "imp_1",
        askedAt: 5,
      },
    });
    const settled = projectNarration(
      narration({
        _tag: "questionSettled",
        questionId: "toolu_9",
        settled: "withdrawn",
      }),
    );
    expect(settled).toMatchObject({
      _tag: "question",
      question: null,
      settled: "withdrawn",
    });
    const decode = Schema.decodeUnknownSync(LiveFrame);
    expect(decode(JSON.parse(JSON.stringify(asked)))._tag).toBe("question");
    expect(decode(JSON.parse(JSON.stringify(settled)))._tag).toBe("question");
  });

  test("the activity store says who waits until the question is settled or the session closed", () => {
    const store = new SessionActivities();
    const subject = { _tag: "import" as const, importId: "imp_1" };
    const record = (
      detail: Parameters<typeof projectNarration>[0]["entry"]["detail"],
    ) => store.record(subject, narration(detail).entry);
    record({ _tag: "question", question });
    expect(store.waiting(subject)?.questionId).toBe("toolu_9");
    expect(waitingWords(question)).toBe("3 questions — Colour");
    record({
      _tag: "questionSettled",
      questionId: "toolu_9",
      settled: "answered",
    });
    expect(store.waiting(subject)).toBeUndefined();
    record({ _tag: "question", question });
    record({ _tag: "connection", state: "closed", reason: "" });
    expect(store.waiting(subject)).toBeUndefined();
    // A connection back keeps it (A7-Q review 2): the driver's re-list corrects the set,
    // with a `questionSettled` for each the list no longer holds and nothing when the list
    // could not be read, so a list that failed does not drop a real question.
    record({ _tag: "question", question });
    record({ _tag: "connection", state: "restored", reason: "" });
    expect(store.waiting(subject)?.questionId).toBe("toolu_9");
    record({ _tag: "question", question });
    expect(store.waiting(subject)?.questionId).toBe("toolu_9");
    // A break alone keeps it: the stream may be back in a moment.
    record({ _tag: "connection", state: "reconnecting", reason: "socket" });
    expect(store.waiting(subject)?.questionId).toBe("toolu_9");
    // Lost: the harness cannot be answered through, so it no longer counts in Needs you
    // (an OpenCode process killed for good never says `restored`)…
    record({ _tag: "connection", state: "lost", reason: "socket" });
    expect(store.waiting(subject)).toBeUndefined();
    // …and if it does come back, the driver's re-listing brings a still-real one back.
    record({ _tag: "connection", state: "restored", reason: "" });
    record({ _tag: "question", question });
    expect(store.waiting(subject)?.questionId).toBe("toolu_9");
    // A question is not the agent at work: it does not start a turn on the summary.
    expect(store.get(subject)?.running).toBe(false);
  });
});
