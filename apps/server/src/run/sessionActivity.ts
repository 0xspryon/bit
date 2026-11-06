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
import {
  type AgentSessionActivity,
  BIT_MCP_SERVER_PREFIX,
} from "@bit/contracts";

import type {
  HarnessNarration,
  HarnessQuestion,
} from "../harness/agentHarness";
import type { NarrationSubject } from "./narration";

/** The most characters of a reply the summary keeps: one line on the list. */
export const ACTIVITY_TEXT_MAX = 160;

/** The most characters of a failed turn's error the summary keeps: one line on the list. */
export const ACTIVITY_FAILURE_MAX = 160;

/** How many sub-agents one summary tracks as running; more are counted as running anyway. */
export const ACTIVITY_SUBAGENTS_KEPT = 16;

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
 * A tool's name as the list says it: an MCP tool without its server's namespacing.
 *
 * Claude Code names an MCP tool `mcp__<server>__<tool>`, and every server bit registers is
 * bit's own per-session one (`bit-<id>`), so "Running mcp__bit-imp_4f…__read_scope" said the
 * session's id and buried the tool. Any Claude Code server prefix is dropped — a line on a
 * list names the tool, and the transcript keeps the full name. OpenCode's form,
 * `<server>.<tool>`, is dropped only for bit's own servers: a harness's own dotted tool name
 * is not to be renamed on a guess (`bareToolName`'s rule).
 */
export const listedToolName = (raw: string): string => {
  const claude = /^mcp__.+?__(.+)$/su.exec(raw);
  if (claude?.[1] !== undefined) return claude[1];
  if (raw.startsWith(BIT_MCP_SERVER_PREFIX)) {
    const dot = raw.indexOf(".");
    if (dot > BIT_MCP_SERVER_PREFIX.length && dot < raw.length - 1)
      return raw.slice(dot + 1);
  }
  return raw;
};

/**
 * A harness's error as one line on the list: the first non-empty line, whitespace
 * collapsed, every control and bidi-formatting character dropped, capped at
 * {@link ACTIVITY_FAILURE_MAX}. It is a provider's sentence and can quote anything; the
 * browser isolates it as well, so this is about keeping it one short line.
 */
export const failureLine = (message: string): string => {
  const line =
    message
      .split("\n")
      .map((each) =>
        each
          // A control is a gap; a bidi mark, embedding, override or isolate is nothing.
          .replace(/\p{Cc}/gu, " ")
          .replace(/\p{Bidi_Control}/gu, "")
          .replace(/\s+/gu, " ")
          .trim(),
      )
      .find((each) => each !== "") ?? "";
  if (line === "") return "the harness gave no reason";
  return line.length <= ACTIVITY_FAILURE_MAX
    ? line
    : `${line.slice(0, ACTIVITY_FAILURE_MAX - 1)}…`;
};

/**
 * A subject's summary as it is kept: the list's {@link AgentSessionActivity}, and the
 * sub-agents running in the turn by their call id, which the view's one name is read from.
 */
export interface ActivityState {
  readonly view: AgentSessionActivity;
  /** Running sub-agents, oldest first, each by its call id and the name the list shows. */
  readonly subagents: readonly (readonly [callId: string, name: string])[];
}

/** The name a running sub-agent is shown by: its type, else its task's description. */
const subagentName = (detail: {
  readonly agentType: string | undefined;
  readonly description: string;
}): string => {
  const type = detail.agentType?.trim() ?? "";
  const words = type === "" ? detail.description : type;
  const line = words.replace(/\s+/gu, " ").trim();
  if (line === "") return "a sub-agent";
  return line.length <= ACTIVITY_TEXT_MAX
    ? line
    : `${line.slice(0, ACTIVITY_TEXT_MAX - 1)}…`;
};

const EMPTY_VIEW = (at: number): AgentSessionActivity => ({
  running: false,
  calls: 0,
  lastTool: null,
  subagent: null,
  text: null,
  failure: null,
  at,
});

/**
 * One entry folded into a subject's summary. Pure: the store below is the only state.
 *
 * A tool call counts and names the tool; a reply — finished, or a partial of one while it
 * streams — sets the text; a sub-agent's states say which is running; an `error` is the
 * failure the turn ended with, kept until the next turn starts; thinking, results and the
 * rest only move `at`. The entry that carries an outcome ends the turn.
 */
export const foldActivityState = (
  before: ActivityState | undefined,
  entry: HarnessNarration,
): ActivityState => {
  const detail = entry.detail;
  const idle = before === undefined || !before.view.running;
  // Bookkeeping a harness can write after a turn's outcome — usage, a marker — is not the
  // agent doing something, so it does not start a turn. An error after the outcome is the
  // turn's failure restated, and is kept as it.
  if (idle && !STARTS_A_TURN.has(detail._tag)) {
    const view =
      before === undefined
        ? EMPTY_VIEW(entry.at)
        : { ...before.view, at: Math.max(before.view.at, entry.at) };
    return {
      view:
        detail._tag === "error"
          ? { ...view, failure: failureLine(detail.message) }
          : view,
      subagents: before?.subagents ?? [],
    };
  }
  // A new turn starts with the first thing the agent does after the last one ended, and
  // the last turn's failure goes with it.
  const base: ActivityState = idle
    ? {
        view: { ...EMPTY_VIEW(entry.at), running: true },
        subagents: [],
      }
    : before;
  let view: AgentSessionActivity = {
    ...base.view,
    at: Math.max(base.view.at, entry.at),
  };
  let subagents = base.subagents;
  if (detail._tag === "toolCall") {
    view = {
      ...view,
      calls: view.calls + 1,
      lastTool:
        detail.tool === undefined ? view.lastTool : listedToolName(detail.tool),
    };
  } else if (
    detail._tag === "reply" ||
    (detail._tag === "partial" && detail.channel === "reply")
  ) {
    view = { ...view, text: lastLine(detail.text) ?? view.text };
  } else if (detail._tag === "subagent") {
    const others = subagents.filter(([callId]) => callId !== detail.callId);
    subagents =
      detail.status === "running"
        ? [...others, [detail.callId, subagentName(detail)] as const].slice(
            -ACTIVITY_SUBAGENTS_KEPT,
          )
        : others;
  } else if (detail._tag === "error") {
    view = { ...view, failure: failureLine(detail.message) };
  }
  if (entry.outcome !== undefined) {
    view = { ...view, running: false };
    // A sub-agent is the turn's; the turn is over. A background one that finishes later
    // narrates its own state.
    subagents = [];
  }
  return {
    view: { ...view, subagent: subagents.at(-1)?.[1] ?? null },
    subagents,
  };
};

/** {@link foldActivityState} on the list's view alone, for a caller with no sub-agent state. */
export const foldActivity = (
  before: AgentSessionActivity | undefined,
  entry: HarnessNarration,
): AgentSessionActivity =>
  foldActivityState(
    before === undefined
      ? undefined
      : {
          view: before,
          subagents:
            before.subagent === null ? [] : [["", before.subagent] as const],
        },
    entry,
  ).view;

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
  readonly #kept = new Map<string, ActivityState>();
  /**
   * The questions each subject's agent is waiting on the operator for (A7-Q), by question
   * id, in the order asked: a `question` entry adds one, a `questionSettled` takes it away,
   * and the narration's `closed` — the surface let the session go, and a request it held
   * went with it — or `lost` takes them all (see {@link #question}). Bounded with the
   * summaries: a subject dropped from {@link #kept} is dropped here too.
   */
  readonly #waiting = new Map<string, Map<string, HarnessQuestion>>();

  constructor(readonly limit: number = ACTIVITY_SUBJECTS_KEPT) {}

  record(subject: NarrationSubject, entry: HarnessNarration): void {
    const key = activityKey(subject);
    this.#question(key, entry);
    const next = foldActivityState(this.#kept.get(key), entry);
    // Re-inserted, so it moves to the newest end.
    this.#kept.delete(key);
    this.#kept.set(key, next);
    while (this.#kept.size > this.limit) {
      const oldest = this.#kept.keys().next().value;
      if (oldest === undefined) break;
      this.#kept.delete(oldest);
      this.#waiting.delete(oldest);
    }
  }

  #question(key: string, entry: HarnessNarration): void {
    const detail = entry.detail;
    if (detail._tag === "question") {
      const held = this.#waiting.get(key) ?? new Map<string, HarnessQuestion>();
      held.set(detail.question.questionId, detail.question);
      this.#waiting.set(key, held);
    } else if (detail._tag === "questionSettled") {
      const held = this.#waiting.get(key);
      held?.delete(detail.questionId);
      if (held?.size === 0) this.#waiting.delete(key);
    } else if (
      detail._tag === "connection" &&
      (detail.state === "closed" || detail.state === "lost")
    ) {
      // `closed`: the session's requests went with it. `lost`: the harness has been
      // unreachable long enough that nothing waiting on it can be answered through it — an
      // OpenCode process killed for good never comes back, and its question would count in
      // Needs you until bit restarted (A7-Q review 1). Should it come back after all, the
      // driver's re-listing on `restored` brings back what is still real.
      //
      // **Not `restored`** (A7-Q review 2): the set is the driver's to correct then. It
      // re-lists what is pending straight after (OpenCode's `form.list` on every
      // connection) and narrates a `questionSettled` for each it knew of that the list no
      // longer holds — and when that list fails, nothing, so a question still real is not
      // dropped from Needs you by a list that could not be read.
      //
      // V2(chat): between a break and its `lost` (about half a minute) a question settled
      // in the gap still counts in Needs you.
      this.#waiting.delete(key);
    }
  }

  get(subject: NarrationSubject): AgentSessionActivity | undefined {
    return this.#kept.get(activityKey(subject))?.view;
  }

  /** The newest question `subject`'s agent is waiting on the operator for, if any (A7-Q). */
  waiting(subject: NarrationSubject): HarnessQuestion | undefined {
    const held = this.#waiting.get(activityKey(subject));
    return held === undefined ? undefined : [...held.values()].at(-1);
  }

  get size(): number {
    return this.#kept.size;
  }
}
