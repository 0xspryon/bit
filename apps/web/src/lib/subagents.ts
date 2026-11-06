/**
 * Sub-agents as a chat draws them (A7-S, E7/E8): the card's words, the panel's groups and
 * the chip's counts, from the server's `SubagentView` on each `subagent` item.
 *
 * **Nothing here computes anything about a sub-agent's work.** The server built the view
 * from what the harness said — its lines, its count, what it returned — and this file only
 * words it: a clock, a count, a group, the reason a Stop is not offered. E7: "the UI computes
 * nothing about its results".
 *
 * Harness-neutral and chat-neutral: the importer is the first caller, and the goal, planner
 * and worker chats get the same cards by passing the same snippets to `ChatShell`.
 */
import type { LiveItem, SubagentView } from "@bit/contracts";

import { durationLabel, SUBAGENT_KIND, type ChatGroup } from "./chat";

/** One sub-agent on screen: its newest item (the card's row) and the server's view of it. */
export interface SubagentEntry {
  readonly item: LiveItem;
  readonly view: SubagentView;
}

/**
 * Every sub-agent of a conversation, in the order they were started: one per call, its
 * newest view. The chat's rows are already folded (`foldSubagents`), so each row is one
 * sub-agent; a row from a server older than A7-S carries no view and is left out.
 */
export const subagentsIn = <Subject>(
  groups: readonly ChatGroup<Subject>[],
): readonly SubagentEntry[] => {
  const newest = new Map<string, SubagentEntry>();
  for (const group of groups) {
    for (const row of group.rows) {
      const view = row.item.subagent;
      if (row.item.kind !== SUBAGENT_KIND || view === undefined) continue;
      newest.set(view.callId, { item: row.item, view });
    }
  }
  return [...newest.values()];
};

/** E8's groups: Running, Failed, Finished — a stopped one is finished, not failed. */
export interface SubagentGroups {
  readonly running: readonly SubagentEntry[];
  readonly failed: readonly SubagentEntry[];
  readonly finished: readonly SubagentEntry[];
}

export const subagentGroups = (
  entries: readonly SubagentEntry[],
): SubagentGroups => ({
  running: entries.filter((entry) => entry.view.status === "running"),
  failed: entries.filter((entry) => entry.view.status === "failed"),
  finished: entries.filter(
    (entry) =>
      entry.view.status === "finished" || entry.view.status === "stopped",
  ),
});

/** The card's name: the calling agent's label for it, else its type. */
export const subagentName = (view: SubagentView): string =>
  view.description !== "" ? view.description : (view.agentType ?? "Sub-agent");

/**
 * How long it has run, or ran: from its start to `now` while it runs, to its end once
 * ended. `""` when the harness gave no start, or no end for one that ended.
 */
export const subagentClock = (view: SubagentView, now: number): string => {
  if (view.startedAt === null) return "";
  const end = view.status === "running" ? now : view.endedAt;
  return end === null ? "" : durationLabel(Math.max(0, end - view.startedAt));
};

/** "1 call", "9 calls"; `""` when nobody counted. */
export const callsLabel = (calls: number | null): string =>
  calls === null ? "" : `${String(calls)} ${calls === 1 ? "call" : "calls"}`;

/**
 * The card's right-hand line, E7's: `1m 12s · 9 calls` while running or finished,
 * `failed at 0m 58s` for a failed one, `stopped at …` for a stopped one.
 */
export const subagentMeta = (view: SubagentView, now: number): string => {
  const clock = subagentClock(view, now);
  if (view.status === "failed" || view.status === "stopped") {
    return clock === "" ? view.status : `${view.status} at ${clock}`;
  }
  return [clock, callsLabel(view.calls)]
    .filter((part) => part !== "")
    .join(" · ");
};

/**
 * Why a running sub-agent has no Stop of its own, in a sentence the card shows where the
 * button would be — or `undefined` when it has one, or has ended. `agent` is the chat's word
 * for the agent that started it ("the importer").
 */
export const stopWithheld = (
  view: SubagentView,
  agent: string,
): string | undefined => {
  if (view.status !== "running" || view.stop === "own") return undefined;
  return view.stop === "with_turn"
    ? `No Stop of its own: it runs inside ${agent}'s turn, and Stop all stops the turn with it.`
    : "No Stop of its own: bit cannot reach it from here. Stop all stops the turn and what it started.";
};

/**
 * The element id a card carries, so the panel can scroll to it. Derived from the call id,
 * with anything an id should not hold replaced: harness call ids are word characters
 * (`toolu_…`, `call_…`), but the id is the harness's.
 */
export const subagentCardId = (callId: string): string =>
  `subagent-${callId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * A finished card's quote longer than this — in lines, or in characters for a quote that
 * wraps — is drawn to {@link QUOTE_CLAMP_LINES} lines with a way to read the rest (A7-S
 * review 1): a report of a few screens otherwise pushed the transcript away. Counted from
 * the text rather than measured, so the card knows before it is laid out.
 */
export const QUOTE_CLAMP_LINES = 8;
export const QUOTE_CLAMP_CHARS = 600;
export const quoteIsLong = (text: string): boolean =>
  text.length > QUOTE_CLAMP_CHARS ||
  text.split("\n").length > QUOTE_CLAMP_LINES;

/** What finds a card's element, or the card an element is in (`closest`). */
export const SUBAGENT_CARD_SELECTOR = "[data-subagent-card]";

/**
 * The chip's words (E8): "5 sub-agents", the running and failed counts beside it.
 */
export const subagentChipLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? "sub-agent" : "sub-agents"}`;

/** The chip's accessible name: the count and both live counts in words. */
export const subagentChipName = (groups: SubagentGroups): string => {
  const total =
    groups.running.length + groups.failed.length + groups.finished.length;
  return [
    subagentChipLabel(total),
    `${String(groups.running.length)} running`,
    `${String(groups.failed.length)} failed`,
  ].join(", ");
};

/**
 * Whether the rail should give way while the panel is open (decided in the chat-shell
 * prep, 2026-11-06): the chat column would otherwise be under 560px. `shellWidth` is the
 * width the shell has now, and `railWidth` what the rail takes while it shows.
 */
export const PANEL_WIDTH = 400;
export const COLUMN_MIN_WITH_PANEL = 560;
export const railGivesWay = (shellWidth: number): boolean =>
  shellWidth - PANEL_WIDTH < COLUMN_MIN_WITH_PANEL;
