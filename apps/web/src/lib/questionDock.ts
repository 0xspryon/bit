/**
 * The question dock's rules (A7-Q, E3/E4), as plain functions: what the operator's draft
 * answers are, which questions are answered or skipped, how the header's bar is cut, and
 * what each question's tag says. `QuestionDock.svelte` draws them; these are tested without
 * a browser.
 */
import type {
  PendingQuestion,
  QuestionAnswers,
  QuestionField,
  QuestionKind,
} from "@bit/contracts";

/** What the operator has put into the dock so far, by question key. */
export interface DockDraft {
  /** The options chosen, by label. */
  readonly chosen: Readonly<Record<string, readonly string[]>>;
  /** The words in "Something else — in your own words…", or a "your words" answer. */
  readonly written: Readonly<Record<string, string>>;
  /** The questions moved past at least once: one moved past with no answer is skipped. */
  readonly visited: readonly string[];
}

export const EMPTY_DRAFT: DockDraft = { chosen: {}, written: {}, visited: [] };

/** One question's answer as the server takes it: the choices, then the written words. */
export const fieldAnswer = (
  field: QuestionField,
  draft: DockDraft,
): readonly string[] => {
  const written = (draft.written[field.key] ?? "").trim();
  return [
    ...(draft.chosen[field.key] ?? []),
    ...(written === "" ? [] : [written]),
  ];
};

/** The draft as the answers to send: every question answered, by key; a skipped one left out. */
export const draftAnswers = (
  fields: readonly QuestionField[],
  draft: DockDraft,
): QuestionAnswers =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const answer = fieldAnswer(field, draft);
      return answer.length === 0 ? [] : [[field.key, answer]];
    }),
  );

/** Whether a question has an answer in the draft. */
export const isAnswered = (field: QuestionField, draft: DockDraft): boolean =>
  fieldAnswer(field, draft).length > 0;

/** E3/E4's answered line: how many are answered, and how many were moved past without one. */
export const answeredCounts = (
  fields: readonly QuestionField[],
  draft: DockDraft,
): { readonly answered: number; readonly skipped: number } => {
  const answered = fields.filter((field) => isAnswered(field, draft)).length;
  const skipped = fields.filter(
    (field) => !isAnswered(field, draft) && draft.visited.includes(field.key),
  ).length;
  return { answered, skipped };
};

/** "3 answered · 1 skipped", or "" when nothing is either. */
export const answeredLine = (counts: {
  readonly answered: number;
  readonly skipped: number;
}): string =>
  [
    counts.answered > 0 ? `${String(counts.answered)} answered` : "",
    counts.skipped > 0 ? `${String(counts.skipped)} skipped` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

/** The most bar segments drawn one per question (E4); past it the bar is one continuous run. */
export const SEGMENTS_MAX = 12;

/**
 * The header's bar: one segment per question up to {@link SEGMENTS_MAX}, each `done`
 * (answered), `current` or `open`; past that, one bar filled to the share answered.
 */
export const progressBar = (
  fields: readonly QuestionField[],
  draft: DockDraft,
  current: number,
):
  | {
      readonly _tag: "segments";
      readonly segments: readonly ("done" | "current" | "open")[];
    }
  | { readonly _tag: "continuous"; readonly filled: number } =>
  fields.length <= SEGMENTS_MAX
    ? {
        _tag: "segments",
        segments: fields.map((field, index) =>
          index === current
            ? "current"
            : isAnswered(field, draft)
              ? "done"
              : "open",
        ),
      }
    : {
        _tag: "continuous",
        filled:
          fields.filter((field) => isAnswered(field, draft)).length /
          fields.length,
      };

/** E3/E4's kind tag. */
export const kindTag = (kind: QuestionKind): string =>
  kind === "one" ? "Choose one" : kind === "any" ? "Choose any" : "Your words";

/**
 * What stands beside the tag: how many are chosen for a choose-any (E4: "says how many are
 * selected instead of Required"), else whether it must be answered.
 */
export const requirementLabel = (
  field: QuestionField,
  draft: DockDraft,
): string => {
  if (field.kind === "any") {
    const count = fieldAnswer(field, draft).length;
    if (count > 0) return `${String(count)} selected`;
  }
  return field.required ? "Required" : "Optional";
};

/** A question's short name, for the answered line and Jump to…: its header, else its words. */
export const fieldName = (field: QuestionField): string =>
  field.header ?? field.question;

/**
 * What identifies one set of questions across its native request and its transcript copy:
 * a question withdrawn by a Stop comes back from the replay under another id (`call:<id>`)
 * with the same questions, and the operator's draft answers go with it.
 */
export const questionSignature = (pending: PendingQuestion): string =>
  JSON.stringify([
    pending.harnessSessionId,
    pending.fields.map((field) => [field.key, field.question]),
  ]);

/** Toggles `label` in a choose-any's choices, or makes it a choose-one's only choice. */
export const choose = (
  field: QuestionField,
  draft: DockDraft,
  label: string,
): DockDraft => {
  const before = draft.chosen[field.key] ?? [];
  if (field.kind === "any") {
    const chosen = before.includes(label)
      ? before.filter((each) => each !== label)
      : [...before, label];
    return { ...draft, chosen: { ...draft.chosen, [field.key]: chosen } };
  }
  // One answer: choosing an option clears the written one.
  return {
    ...draft,
    chosen: { ...draft.chosen, [field.key]: [label] },
    written: { ...draft.written, [field.key]: "" },
  };
};

/** Writes a question's own-words answer; for a choose-one it replaces the option chosen. */
export const write = (
  field: QuestionField,
  draft: DockDraft,
  words: string,
): DockDraft => ({
  ...draft,
  written: { ...draft.written, [field.key]: words },
  ...(field.kind === "one" && words.trim() !== ""
    ? { chosen: { ...draft.chosen, [field.key]: [] } }
    : {}),
});

/** Marks a question moved past, so one left unanswered counts as skipped. */
export const visit = (field: QuestionField, draft: DockDraft): DockDraft =>
  draft.visited.includes(field.key)
    ? draft
    : { ...draft, visited: [...draft.visited, field.key] };

/** The sentence the dock says when the question cannot be answered the way it was asked. */
export const answerabilityNote = (
  pending: PendingQuestion,
  asker: string,
  canMessage: boolean,
): string =>
  pending.answerability === "live"
    ? ""
    : pending.answerability === "message" && canMessage
      ? `${asker} is no longer waiting on these questions: a Stop, a server restart or its process ending withdrew them. Your answers go to it as an ordinary message.`
      : `${asker} is no longer waiting on these questions, and this session cannot be carried on, so they cannot be answered. Dismiss them to get the box back.`;
