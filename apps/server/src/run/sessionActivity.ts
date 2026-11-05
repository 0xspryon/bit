/**
 * What each session is doing, in one line's worth, folded from the narration this process
 * publishes (A7 U8b) — the Agent sessions list's second line: the last tool and how many
 * calls the turn has made, or what the agent is writing.
 *
 * ## Why it is folded here and not asked for
 *
 * The list is read whenever the operator looks at it, and refreshed while sessions narrate.
 * Asking each live session's harness what it is doing would be a harness call per row per
 * refresh — a status poll — and the answer is already passing through this process: every
 * entry a supervisor drains goes over the narration bus (`run/narration.ts`). So the bus
 * keeps a running summary per subject at publish, and the list reads that. Nothing here is
 * ever asked of a harness.
 *
 * ## Cheap and bounded
 *
 * One small record per subject, updated in place: two counters and two short strings. The
 * text is the last non-empty line of the latest reply, cut to {@link ACTIVITY_TEXT_MAX}, so
 * a 32,000-character reply costs a line. At most {@link ACTIVITY_SUBJECTS_KEPT} subjects are
 * kept; the one narrated longest ago goes first. Like the bus, it is in memory only: after a
 * restart a session has no summary until it narrates again, and the list says nothing
 * rather than guessing.
 *
 * ## Running and idle, from the narration alone
 *
 * A turn's end is the one entry that carries a terminal `outcome` (both drivers write it
 * only at a turn's end; `HarnessNarration.outcome`). So a subject is running from its first
 * entry after an outcome until the next outcome, and the turn's counters start again with
 * it. V2(chat): a turn whose harness has not narrated yet — the seconds between a message
 * and the first entry — reads idle; the Stop button's status read is the exact answer and is
 * a harness call, which this list does not make.
 */
import type { AgentSessionActivity } from "@bit/contracts";

import type { HarnessNarration } from "../harness/agentHarness";
import type { NarrationSubject } from "./narration";

/** The most characters of a reply the summary keeps: one line on the list. */
export const ACTIVITY_TEXT_MAX = 160;

/** How many subjects' summaries are kept before the oldest is dropped. */
export const ACTIVITY_SUBJECTS_KEPT = 512;

/** The key a subject's summary is kept under. */
export const activityKey = (subject: NarrationSubject): string => {
  switch (subject._tag) {
    case "attempt":
      return `attempt:${subject.attemptId}`;
    case "round":
      return `round:${subject.roundId}`;
    case "goal":
      return `goal:${subject.goalId}`;
    case "import":
      return `import:${subject.importId}`;
  }
};

/**
 * The last non-empty line of a text, as plain words: inline markdown marks and a leading
 * heading, list or quote mark dropped, whitespace collapsed, shortened to a line on the list.
 */
export const lastLine = (text: string): string | null => {
  const lines = text
    .split("\n")
    .map((line) =>
      line
        // Inline markdown would show as its marks on a plain line: the words are kept.
        .replace(/\*\*|__|`/gu, "")
        .replace(/^\s*(?:#{1,6}|[-*+>]|\d+\.)\s+/u, "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined) return null;
  return last.length <= ACTIVITY_TEXT_MAX
    ? last
    : `${last.slice(0, ACTIVITY_TEXT_MAX - 1)}…`;
};

/**
 * One entry folded into a subject's summary. Pure: the store below is the only state.
 *
 * A tool call counts and names the tool; a reply — finished, or a partial of one while it
 * streams — sets the text; thinking, results and the rest only move `at`. The entry that
 * carries an outcome ends the turn.
 */
export const foldActivity = (
  before: AgentSessionActivity | undefined,
  entry: HarnessNarration,
): AgentSessionActivity => {
  const detail = entry.detail;
  const idle = before === undefined || !before.running;
  // Bookkeeping a harness can write after a turn's outcome — usage, a marker, an error
  // restating it — is not the agent doing something, so it does not start a turn.
  if (idle && !STARTS_A_TURN.has(detail._tag)) {
    return before === undefined
      ? {
          running: false,
          calls: 0,
          lastTool: null,
          text: null,
          at: entry.at,
        }
      : { ...before, at: Math.max(before.at, entry.at) };
  }
  // A new turn starts with the first thing the agent does after the last one ended.
  const base: AgentSessionActivity = idle
    ? { running: true, calls: 0, lastTool: null, text: null, at: entry.at }
    : before;
  let next: AgentSessionActivity = { ...base, at: Math.max(base.at, entry.at) };
  if (detail._tag === "toolCall") {
    next = {
      ...next,
      calls: next.calls + 1,
      lastTool: detail.tool ?? next.lastTool,
    };
  } else if (
    detail._tag === "reply" ||
    (detail._tag === "partial" && detail.channel === "reply")
  ) {
    next = { ...next, text: lastLine(detail.text) ?? next.text };
  }
  if (entry.outcome !== undefined) next = { ...next, running: false };
  return next;
};

/** The entries that are the agent at work, which open a turn when none is running. */
const STARTS_A_TURN: ReadonlySet<string> = new Set([
  "reply",
  "partial",
  "delta",
  "thinking",
  "toolCall",
  "toolResult",
  "taken",
  "subagent",
]);

/** The summaries, by subject, bounded. A `Map` keeps insertion order, so the oldest is first. */
export class SessionActivities {
  readonly #kept = new Map<string, AgentSessionActivity>();

  constructor(readonly limit: number = ACTIVITY_SUBJECTS_KEPT) {}

  record(subject: NarrationSubject, entry: HarnessNarration): void {
    const key = activityKey(subject);
    const next = foldActivity(this.#kept.get(key), entry);
    // Re-inserted, so it moves to the newest end.
    this.#kept.delete(key);
    this.#kept.set(key, next);
    while (this.#kept.size > this.limit) {
      const oldest = this.#kept.keys().next().value;
      if (oldest === undefined) break;
      this.#kept.delete(oldest);
    }
  }

  get(subject: NarrationSubject): AgentSessionActivity | undefined {
    return this.#kept.get(activityKey(subject));
  }

  get size(): number {
    return this.#kept.size;
  }
}
