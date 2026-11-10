/**
 * The question dock's server half that is no single harness's (A7-Q): what a question tool's
 * input means, how a transcript says a question went unanswered, and the one sentence an
 * agent is told when the operator dismisses its questions.
 *
 * Each driver maps its own native request onto `HarnessQuestion` (`agentHarness.ts`); this
 * is what both share, and what a replay — which has no native request any more, only the
 * tool call in the transcript — reads a question back from.
 */
import type {
  LiveItem,
  PendingQuestion,
  QuestionAnswerability,
  QuestionField,
  QuestionKind,
  QuestionOption,
} from "@bit/contracts";

import type { HarnessQuestion } from "./agentHarness";

/**
 * What an agent is told when the operator dismisses its questions without answering.
 *
 * Claude Code shows it as the tool's error (`PreToolUse:AskUserQuestion hook error: …`,
 * measured on 2.1.310); OpenCode as the `question` tool's failure, because a form cancelled
 * **with a message** is "ordinary model-facing feedback: the model continues instead of the
 * step ending" (`core/src/tool/plugin/question.ts` at 2.2.5), where one cancelled without
 * one ends the step. A replay also recognises a dismissal by it.
 */
export const QUESTION_DISMISSED_MESSAGE =
  "The operator dismissed these questions without answering them. Carry on without the answers, or ask in your reply instead.";

/** Claude Code's question tool. */
export const CLAUDE_CODE_QUESTION_TOOL = "AskUserQuestion";

/** OpenCode's question tool, whose request is a form (`metadata.kind: "question"`). */
export const OPENCODE_QUESTION_TOOL = "question";

/**
 * bit's question tool for Pi, which has none of its own (harness-instances slice 3): offered
 * by `piBitTools.extension.ts` and answered through Pi's extension-UI channel (`piClient.ts`).
 * Its input is Claude Code's `AskUserQuestion` shape, so a model that knows one knows both.
 */
export const PI_QUESTION_TOOL = "ask_user_question";

/** Which harness's question tool shape a call is read with. */
export type QuestionTool = "claude-code" | "opencode" | "pi";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const optionsOf = (value: unknown): QuestionOption[] =>
  Array.isArray(value)
    ? value.flatMap((option: unknown): QuestionOption[] => {
        if (typeof option !== "object" || option === null) return [];
        const record = option as Record<string, unknown>;
        const label = text(record.label);
        return label === undefined
          ? []
          : [{ label, description: text(record.description) ?? null }];
      })
    : [];

const nonEmpty = (
  fields: readonly QuestionField[],
): readonly [QuestionField, ...QuestionField[]] | undefined => {
  const [first, ...rest] = fields;
  return first === undefined ? undefined : [first, ...rest];
};

/**
 * The questions of one question tool call's input, or `undefined` when it holds none.
 *
 * Both tools take `{ questions: [{ question, header, options: [{ label, description }] }] }`
 * and say "choose any" differently — Claude Code's `multiSelect`, OpenCode's `multiple`. The
 * keys an answer goes back under differ too: Claude Code keys answers by the question's
 * text, OpenCode's form by field position (`q0`, `q1`, …, `toField` in its question tool).
 * Neither has a required flag on the tool, and both always take a written answer.
 *
 * bit's Pi tool takes Claude Code's shape (`multiSelect`) and is keyed by position, as
 * OpenCode is: bit chooses the keys, and position keeps two questions of the same words
 * apart.
 */
export const questionFieldsOfInput = (
  tool: QuestionTool,
  input: unknown,
): readonly [QuestionField, ...QuestionField[]] | undefined => {
  const questions =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).questions
      : undefined;
  if (!Array.isArray(questions)) return undefined;
  const seen = new Set<string>();
  const fields = questions.flatMap(
    (value: unknown, index: number): QuestionField[] => {
      if (typeof value !== "object" || value === null) return [];
      const record = value as Record<string, unknown>;
      const question = text(record.question);
      if (question === undefined) return [];
      const key = tool === "claude-code" ? question : `q${String(index)}`;
      // Claude Code keys by text, so two identical questions would share one answer.
      if (seen.has(key)) return [];
      seen.add(key);
      const options = optionsOf(record.options);
      const many =
        tool === "opencode"
          ? record.multiple === true
          : record.multiSelect === true;
      const kind: QuestionKind =
        options.length === 0 ? "text" : many ? "any" : "one";
      return [
        {
          key,
          header: text(record.header) ?? null,
          question,
          kind,
          options,
          custom: true,
          required: false,
        },
      ];
    },
  );
  return nonEmpty(fields);
};

/** Which harness's question tool a tool name is, if any. */
const questionToolOf = (tool: string | null): QuestionTool | undefined =>
  tool === CLAUDE_CODE_QUESTION_TOOL
    ? "claude-code"
    : tool === OPENCODE_QUESTION_TOOL
      ? "opencode"
      : tool === PI_QUESTION_TOOL
        ? "pi"
        : undefined;

/**
 * The question a transcript ends on without an answer, or `undefined` (A7-Q).
 *
 * What a replay offers when no native request is held: the **last** question call, when
 *
 * - no successful result answers it — the harness never gave the agent answers;
 * - its result, if any, is not bit's own dismissal ({@link QUESTION_DISMISSED_MESSAGE}):
 *   the operator already said no;
 * - and no message of the operator's came after it: once the operator has written again,
 *   the conversation has moved past the question.
 *
 * Claude Code's Stop while a question waits stores the call, a refused result ("The user
 * doesn't want to proceed with this tool use…") and the interrupt marker; a restarted bit
 * server leaves the call with no result at all. Both read here as unanswered.
 *
 * V2(chat): read from the replay's capped items, so a question whose input is longer than
 * `NARRATION_FIELD_MAX` (4,000 characters of JSON) cannot be parsed back and is not offered
 * after its native request is gone. Proper V2 reads the call's input from the harness
 * uncapped, or keeps what was asked beside the import.
 */
export const unansweredQuestion = (
  items: readonly LiveItem[],
):
  | {
      readonly callId: string;
      readonly fields: readonly [QuestionField, ...QuestionField[]];
      readonly at: number;
    }
  | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.kind === "turn.operator") return undefined;
    if (item.kind !== "tool.call" || item.callId === null) continue;
    const tool = questionToolOf(item.tool);
    if (tool === undefined) continue;
    const callId = item.callId;
    const result = items
      .slice(index + 1)
      .find((later) => later.kind === "tool.result" && later.callId === callId);
    if (result !== undefined) {
      if (result.outcome !== "failed") return undefined;
      if ((result.output ?? "").includes(QUESTION_DISMISSED_MESSAGE)) {
        return undefined;
      }
    }
    if (item.input === null) return undefined;
    const input = ((): unknown => {
      try {
        return JSON.parse(item.input) as unknown;
      } catch {
        return undefined;
      }
    })();
    const fields = questionFieldsOfInput(tool, input);
    return fields === undefined ? undefined : { callId, fields, at: item.at };
  }
  return undefined;
};

/**
 * The operator's answers as bit's Pi question tool returns them to the model: every
 * question in the agent's order, each with what was chosen, what was written, or that it
 * was skipped. Claude Code's tool answers `"<question>"="<answer>"` pairs; this says the
 * same in lines a model reads without unquoting, and says which answers are the operator's
 * own words rather than one of the offered options.
 */
export const questionAnswersForAgent = (
  fields: readonly QuestionField[],
  answers: Readonly<Record<string, readonly string[]>>,
): string => {
  const lines = fields.flatMap((field, index) => {
    const given = (answers[field.key] ?? [])
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const labels = new Set(field.options.map((option) => option.label));
    const chosen = given.filter((value) => labels.has(value));
    const written = given.filter((value) => !labels.has(value));
    const head = `${String(index + 1)}. ${field.header === null ? "" : `[${field.header}] `}${field.question}`;
    if (given.length === 0) return [head, "   Not answered."];
    return [
      head,
      ...(chosen.length === 0 ? [] : [`   Chose: ${chosen.join("; ")}`]),
      ...written.map((value) => `   In their own words: ${value}`),
    ];
  });
  return ["The operator answered your questions:", ...lines].join("\n");
};

/** Whose session a question is in, as the contract's ids say it. */
export interface QuestionSubjectIds {
  readonly attemptId: string | null;
  readonly roundId: string | null;
  readonly goalId: string | null;
  readonly importId: string | null;
}

/** A driver's question as the contract's, with whose it is and whether it can be answered. */
export const pendingQuestionView = (input: {
  readonly question: HarnessQuestion;
  readonly harnessSessionId: string;
  readonly subject: QuestionSubjectIds;
  readonly answerability: QuestionAnswerability;
}): PendingQuestion => ({
  questionId: input.question.questionId,
  harnessSessionId: input.harnessSessionId,
  fields: input.question.fields,
  askedAt: input.question.askedAt ?? null,
  answerability: input.answerability,
  ...input.subject,
});

/** The id a question read back from a transcript is named by: its tool call. */
export const transcriptQuestionId = (callId: string): string =>
  `call:${callId}`;

/**
 * What a session's agent waits on, in a list's words (Agent sessions' second line, A7 E1):
 * "question 1 of 3 — how far the WordPress rule reaches", shortened to fit one line.
 */
export const waitingWords = (question: HarnessQuestion): string => {
  const [first] = question.fields;
  const count = question.fields.length;
  const lead = count === 1 ? "a question" : `${String(count)} questions`;
  const about = first.header ?? first.question;
  const words = `${lead} — ${about}`;
  return words.length > 160 ? `${words.slice(0, 159)}…` : words;
};
