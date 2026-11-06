/**
 * A question an agent is waiting on the operator for (A7-Q), whichever harness asked it.
 *
 * Each harness has its own native mechanism and this is the one shape they all map onto,
 * as T3 Code does (`live` / `message` / `not_resumable`):
 *
 * - **Claude Code** — the model's `AskUserQuestion` tool. At most four questions with two to
 *   four options each, a choose-one or choose-any list, a written answer always allowed, no
 *   required flag, and **answers keyed by the question's text**.
 * - **OpenCode 2.2.5** — a *form* (`metadata.kind: "question"`) its `question` tool opens,
 *   one field per question keyed `q0…qN`: a `string` field (choose one) or a `multiselect`
 *   (choose any), each with `custom: true`. Forms are held in the OpenCode server's memory.
 *
 * The field is what the dock draws, the key is what the answer goes back under. Nothing here
 * is a promise that the harness will accept an answer: {@link QuestionAnswerability} is.
 *
 * Browser-safe: Effect Schema and plain functions only.
 */
import { Schema } from "effect";

const EpochMillis = Schema.Finite;

/**
 * What kind of answer a question takes (E3/E4's tags): `one` — choose one (CHOOSE ONE),
 * `any` — choose any number (CHOOSE ANY), `text` — the operator's own words (YOUR WORDS).
 */
export const QuestionKind = Schema.Literals(["one", "any", "text"]);
export type QuestionKind = typeof QuestionKind.Type;

export const QuestionOption = Schema.Struct({
  /** The choice as the agent wrote it; also what is sent back when it is chosen. */
  label: Schema.String,
  /** What choosing it means, in the agent's words, or null. */
  description: Schema.NullOr(Schema.String),
});
export type QuestionOption = typeof QuestionOption.Type;

/** One question of a {@link PendingQuestion}. All of its text is the agent's: plain text, never markup. */
export const QuestionField = Schema.Struct({
  /**
   * What the answer goes back under: Claude Code's question text, OpenCode's field key
   * (`q0`). Unique within its question.
   */
  key: Schema.String,
  /** A short label for the question (Claude Code's `header`, OpenCode's field `title`), or null. */
  header: Schema.NullOr(Schema.String),
  /** The question itself. */
  question: Schema.String,
  kind: QuestionKind,
  /** The choices, in the agent's order. Empty for a `text` question. */
  options: Schema.Array(QuestionOption),
  /**
   * Whether a written answer is taken besides the options — E3's "Something else — in your
   * own words…". Always true on both harnesses today; a `text` question is nothing else.
   */
  custom: Schema.Boolean,
  /**
   * Whether it must be answered before the set can be sent. Claude Code has no such flag
   * (false: any question may be skipped); an OpenCode form field says so itself.
   */
  required: Schema.Boolean,
});
export type QuestionField = typeof QuestionField.Type;

/**
 * Whether an answer can still reach the agent the way it asked for one (T3 Code's model).
 *
 * - `live` — the harness is waiting on this very request: an answer or a dismissal goes to
 *   it, and the agent carries on from there.
 * - `message` — the request is gone (a Stop withdrew it, the harness restarted and forgot
 *   it), but the session can be carried on: the dock offers to send the answers as an
 *   ordinary message, which the agent reads as the operator's next turn.
 * - `not_resumable` — the request is gone and so is any way to carry the session on (the
 *   operator ended it, or its harness forgot it): the dock says so and offers nothing to send.
 */
export const QuestionAnswerability = Schema.Literals([
  "live",
  "message",
  "not_resumable",
]);
export type QuestionAnswerability = typeof QuestionAnswerability.Type;

/**
 * A set of questions one agent asked at once, and whether it can still be answered.
 *
 * Whose session it is is said exactly as the live frames say it (`LiveUsage`): one of the
 * four ids, the others null.
 */
export const PendingQuestion = Schema.Struct({
  /**
   * The harness's own id for the request: Claude Code's tool-use id (`toolu_…`), OpenCode's
   * form id (`frm_…`). A question read back from a transcript, whose native request is gone,
   * is named by its tool call instead (`call:<id>`).
   */
  questionId: Schema.String,
  harnessSessionId: Schema.String,
  /** The questions, in the agent's order, never empty. */
  fields: Schema.NonEmptyArray(QuestionField),
  /** When the agent asked, on the server's clock, when known. */
  askedAt: Schema.NullOr(EpochMillis),
  answerability: QuestionAnswerability,
  attemptId: Schema.NullOr(Schema.String),
  roundId: Schema.NullOr(Schema.String),
  goalId: Schema.NullOr(Schema.String),
  importId: Schema.NullOr(Schema.String),
});
export type PendingQuestion = typeof PendingQuestion.Type;

/**
 * How a question stopped waiting, as the live frame says it:
 *
 * - `answered` — the operator answered it here;
 * - `dismissed` — the operator dismissed it here, and the agent was told they declined;
 * - `withdrawn` — it went without either: a Stop, the session ending, the harness forgetting
 *   it. The session may still be carried on, and a dock may offer the answers as a message.
 */
export const QuestionSettlement = Schema.Literals([
  "answered",
  "dismissed",
  "withdrawn",
]);
export type QuestionSettlement = typeof QuestionSettlement.Type;

/**
 * A question was asked, or stopped waiting (A7-Q).
 *
 * `question` is set while it waits (its `answerability` is `live`) and null once it is
 * settled, when `settled` says how. Activity-channel and lossy, like `LiveTurnEnded`: a tab
 * that misses one is corrected by its next read of the session's replay, which re-reads what
 * the harness holds. The cost of a new `_tag` is the one `LiveUsage` states: a tab a deploy
 * behind cannot decode it and reconnects until it is reloaded.
 */
export const LiveQuestion = Schema.Struct({
  _tag: Schema.Literal("question"),
  questionId: Schema.String,
  question: Schema.NullOr(PendingQuestion),
  settled: Schema.NullOr(QuestionSettlement),
  attemptId: Schema.NullOr(Schema.String),
  roundId: Schema.NullOr(Schema.String),
  goalId: Schema.NullOr(Schema.String),
  importId: Schema.NullOr(Schema.String),
  at: EpochMillis,
});
export type LiveQuestion = typeof LiveQuestion.Type;

/**
 * The operator's answers, by {@link QuestionField.key}: the options chosen, by label, and a
 * written answer as one more string. An empty list, or a key left out, is a question skipped.
 */
export const QuestionAnswers = Schema.Record(
  Schema.String,
  Schema.Array(Schema.String),
);
export type QuestionAnswers = typeof QuestionAnswers.Type;

/** `POST …/questions/:questionId/answer`'s body. */
export const QuestionAnswerRequest = Schema.Struct({
  answers: QuestionAnswers,
});
export type QuestionAnswerRequest = typeof QuestionAnswerRequest.Type;

/** What an answer or a dismissal did. */
export const QuestionSettled = Schema.Struct({
  questionId: Schema.String,
  settled: Schema.Literals(["answered", "dismissed"]),
});
export type QuestionSettled = typeof QuestionSettled.Type;

/**
 * Why an answer or a dismissal was refused, beside the server's sentence (a `409`):
 *
 * - `settled` — the request is no longer waiting: answered elsewhere, dismissed, withdrawn
 *   by a Stop, or forgotten by the harness. The dock reads the session again.
 * - `invalid` — the answers do not fit the questions (a required one skipped, a choice that
 *   is not offered, two choices for a choose-one). Also a `400` when the body itself is bad.
 */
export const QuestionRefusalReason = Schema.Literals(["settled", "invalid"]);
export type QuestionRefusalReason = typeof QuestionRefusalReason.Type;

/**
 * An answer or a dismissal the server did not pass on (a `409`), with the server's sentence.
 *
 * - `settled` and `invalid` — {@link QuestionRefusalReason};
 * - `harness_unreachable` — the harness did not answer, so whether it took the answer is not
 *   known; the dock keeps the answers and the operator can try again.
 */
export class QuestionRefused extends Schema.TaggedError<QuestionRefused>()(
  "QuestionRefused",
  {
    questionId: Schema.String,
    reason: Schema.Literals(["settled", "invalid", "harness_unreachable"]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/** The most characters one written answer may carry. */
export const QUESTION_ANSWER_MAX_CHARS = 4_000;

/**
 * What is wrong with `answers` for `fields`, as a sentence, or null when they fit.
 *
 * The one check, used by the dock before it sends and by the server before it answers a
 * harness, so the two never disagree about what a valid answer is.
 */
export const questionAnswersProblem = (
  fields: readonly QuestionField[],
  answers: QuestionAnswers,
): string | null => {
  const keys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(answers)) {
    if (!keys.has(key)) return `There is no question "${key}" to answer.`;
  }
  for (const field of fields) {
    const given = (answers[field.key] ?? []).map((value) => value.trim());
    const name = field.header ?? field.question;
    if (given.some((value) => value === "")) {
      return `An answer to "${name}" is empty.`;
    }
    if (given.length === 0) {
      if (field.required) return `"${name}" needs an answer.`;
      continue;
    }
    if (given.some((value) => value.length > QUESTION_ANSWER_MAX_CHARS)) {
      return `An answer to "${name}" is longer than ${String(QUESTION_ANSWER_MAX_CHARS)} characters.`;
    }
    if (field.kind !== "any" && given.length > 1) {
      return `"${name}" takes one answer.`;
    }
    const labels = new Set(field.options.map((option) => option.label));
    const written = given.filter((value) => !labels.has(value));
    if (written.length > 0 && !field.custom) {
      return `"${name}" takes only the answers it offers.`;
    }
    if (written.length > 1) {
      return `"${name}" takes one answer in your own words.`;
    }
  }
  return null;
};

/**
 * The answers as one ordinary message (the `message` fallback): one line per question
 * answered, "question — answer", so the agent reads them as the operator's next turn.
 */
export const questionAnswersAsMessage = (
  fields: readonly QuestionField[],
  answers: QuestionAnswers,
): string => {
  const lines = fields.flatMap((field) => {
    const given = (answers[field.key] ?? [])
      .map((value) => value.trim())
      .filter((value) => value !== "");
    return given.length === 0
      ? []
      : [`- ${field.question} — ${given.join(", ")}`];
  });
  return lines.length === 0
    ? "I am not answering your questions."
    : ["My answers to your questions:", ...lines].join("\n");
};
