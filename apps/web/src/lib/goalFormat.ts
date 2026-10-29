/**
 * How a goal is worded on screen. Pure, so the wording is one place and testable alone.
 *
 * Shared by the goals list and the single-goal page because the two have to agree about
 * what a goal is *called*: a list row that read one way and the page it opens that read
 * another would be two names for one record.
 */
import type { GoalStatus, GoalView } from "@bit/contracts";

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
