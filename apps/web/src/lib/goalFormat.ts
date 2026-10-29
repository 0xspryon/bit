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

/** "2 intents · 1 attempt · 5 observations", always all three, zero included. */
export const countsLine = (counts: GoalView["counts"]): string =>
  [
    plural(counts.intents, "intent", "intents"),
    plural(counts.attempts, "attempt", "attempts"),
    plural(counts.observations, "observation", "observations"),
  ].join(" · ");

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
): string | null => {
  const parts = [suggestion.instanceId, suggestion.model].filter(
    (part): part is string => part !== null,
  );
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
