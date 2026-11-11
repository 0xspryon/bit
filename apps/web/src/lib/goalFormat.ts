/**
 * How a goal is worded on screen. Pure, so the wording is one place and testable alone.
 *
 * Shared by the goals list and the single-goal page because the two have to agree about
 * what a goal is *called*: a list row that read one way and the page it opens that read
 * another would be two names for one record.
 */
import type {
  GoalStatus,
  GoalView,
  IntentStatus,
  IntentView,
  PlanRoundView,
  RoundDisposition,
  RoundStatus,
} from "@bit/contracts";

/**
 * What a goal is called: its name, or its objective when it has none.
 *
 * An unnamed goal is ordinary, not an error — goals that predate names read this way, and
 * so does any the operator did not label — so falling back to the objective is the whole
 * rule. It is never a placeholder like "Untitled", which would hide the one thing that
 * identifies the row.
 */
export const goalTitle = (goal: Pick<GoalView, "name" | "description">) =>
  goal.name === "" ? goal.description : goal.name;

/**
 * The words for a status. The stored words are the contract's; these are what a person
 * reads. `met` is "Met" and not "Done" or "Complete": the goal's objective was
 * established, and that is a narrower claim than the work being over.
 */
export const statusLabel = (status: GoalStatus): string =>
  status === "active" ? "Active" : status === "met" ? "Met" : "Abandoned";

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * "2 intents · 5 observations": the facets that have something in them, and only those.
 *
 * A zero is dropped rather than shown, because "0 attempts · 0 observations" teaches the
 * operator nothing the timestamp beside it does not. An empty string when every facet is
 * zero, so a caller can leave the line out entirely.
 */
export const countsLine = (counts: GoalView["counts"]): string =>
  [
    [counts.intents, "intent", "intents"] as const,
    [counts.attempts, "attempt", "attempts"] as const,
    [counts.observations, "observation", "observations"] as const,
  ]
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => plural(count, one, many))
    .join(" · ");

/** A date and time in the reader's own locale, from epoch milliseconds. */
export const whenText = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/**
 * The words for an intent's status.
 *
 * `answered` is the one that asserts evidence: an attempt succeeded and left an observation
 * under it. `proposed` is in the vocabulary for a planner that does not exist yet, and an
 * operator will not see it today, but a stored row must still have a word.
 */
export const intentStatusLabel = (status: IntentStatus): string => {
  switch (status) {
    case "proposed":
      return "Proposed";
    case "open":
      return "Open";
    case "claimed":
      return "Running";
    case "answered":
      return "Answered";
    case "abandoned":
      return "Abandoned";
  }
};

/**
 * What an intent suggests running on, as a phrase, or `null` when it has no opinion.
 *
 * Advisory: the phrase is worded as a suggestion by its callers, never as where the intent
 * runs. What ran is the attempt's, and nothing here reads it.
 */
export const suggestionText = (
  suggestion: IntentView["suggestion"],
  /** What a model of an instance is called on screen (`modelNames.ts`); the id when absent. */
  name: (instanceId: string | null, model: string) => string = (_, model) =>
    model,
): string | null => {
  const parts = [
    suggestion.instanceId,
    suggestion.model === null
      ? null
      : name(suggestion.instanceId, suggestion.model),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
};

/** "3 attempts", "1 attempt", "not run yet". */
export const attemptsText = (attempts: number): string =>
  attempts === 0 ? "not run yet" : plural(attempts, "attempt", "attempts");

/**
 * Why an intent cannot be run, or `null` when it can.
 *
 * One function for the list row and for the run box, so the two cannot disagree about
 * whether an intent is runnable. The goal's status is part of the answer — ending a goal
 * blocks new dispatch under it — and the sentence names it, so a disabled control is never
 * unexplained.
 */
export const notRunnableBecause = (
  intent: Pick<IntentView, "status" | "claimedByAttemptId">,
  goalStatus: GoalStatus | undefined,
): string | null => {
  if (intent.status === "claimed") {
    return `A run is working on it${
      intent.claimedByAttemptId === null
        ? "."
        : ` (attempt ${intent.claimedByAttemptId}).`
    }`;
  }
  if (intent.status === "answered") {
    return "It is answered; a follow-up is a new intent.";
  }
  if (intent.status === "abandoned") return "It was abandoned.";
  if (intent.status === "proposed") return "It is only proposed.";
  if (goalStatus !== undefined && goalStatus !== "active") {
    return `This goal has ${goalStatus === "met" ? "been met" : "been abandoned"}, and nothing new runs under a goal that has ended.`;
  }
  return null;
};

/**
 * The words for a round's execution status.
 *
 * It says how the *round* ended and never what the planning concluded — that is the
 * disposition, and the two are separate on purpose. `uncertain` is "Outcome unknown"
 * rather than "Failed": nobody could tell us how it ended, which is a weaker and truer
 * claim than failure, and a round has no word for failing.
 */
export const roundStatusLabel = (status: RoundStatus): string => {
  switch (status) {
    case "running":
      return "Running";
    case "settled":
      return "Finished";
    case "uncertain":
      return "Outcome unknown";
    case "interrupted":
      return "Stopped";
  }
};

/**
 * The words for what a round concluded.
 *
 * `objective_met` says it ended the goal, because that is the part an operator has to
 * know: it is the one disposition with a consequence beyond the round.
 */
export const dispositionLabel = (disposition: RoundDisposition): string => {
  switch (disposition) {
    case "actionable":
      return "Added work worth running";
    case "waiting":
      return "Waiting on work already out";
    case "no_useful_next_action":
      return "Nothing worth doing here";
    case "objective_met":
      return "Objective met — this ended the goal";
  }
};

/**
 * What a round concluded, as a sentence, including the case where it concluded nothing.
 *
 * **A null disposition is a fact rather than a gap, and it is not the same fact as
 * `no_useful_next_action`.** That one is a planner's considered judgement; null means the
 * round stopped without recording an answer — it was interrupted, it lost its session, or
 * its tools never reached it. The wording says so instead of leaving a blank, because a
 * blank reads as "still thinking" on a round that has finished.
 */
export const roundConclusion = (
  round: Pick<PlanRoundView, "status" | "disposition">,
): string => {
  if (round.disposition !== null) return dispositionLabel(round.disposition);
  if (round.status === "running") return "Still working";
  return "It recorded no conclusion";
};

/** "2 of 5 intents added", always both numbers, zero included. */
export const budgetLine = (
  round: Pick<PlanRoundView, "budget" | "intentsAdded">,
): string =>
  `${String(round.intentsAdded)} of ${String(round.budget)} ${
    round.budget === 1 ? "intent" : "intents"
  } added`;
