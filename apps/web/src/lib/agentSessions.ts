/**
 * What the Agent sessions list says about a row, as pure functions of the server's view.
 *
 * Kept out of the component so the words are testable and so the component stays a layout:
 * the one decision in here that is not wording is {@link harnessOf}, which is where a session
 * whose harness this server no longer runs is *marked rather than hidden*, and
 * {@link placeOfSession}, which is where a row's destination became an address.
 */
import type {
  AgentSessionKind,
  AgentSessionView,
  HarnessInstanceView,
} from "@bit/contracts";

import type { Place } from "./place";

export const KIND_LABEL: Record<AgentSessionKind, string> = {
  goal: "Goal",
  importer: "Importer",
  worker: "Worker",
  planner: "Planner",
};

/**
 * The state's word, with the kind's own word beside it where the kind has one.
 *
 * Three states, three sentences. **`Not running` is `dormant`, and it is not "ended"**: this
 * server is not holding the session — every goal conversation after a restart, an importer
 * session a shutdown closed — and nothing recorded that its authority was over for good, so a
 * message reopens it. `Ended` is the other fact: the operator ended it and it stays ended.
 * The words differ on purpose; the composer's disabled states rely on the same difference.
 */
export const stateLabel = (
  session: Pick<AgentSessionView, "state" | "detail">,
): string => {
  const reason =
    session.detail === null ? "" : ` · ${session.detail.replaceAll("_", " ")}`;
  switch (session.state) {
    case "live":
      return "Live";
    case "ended":
      return `Ended${reason}`;
    case "dormant":
      return `Not running${reason}`;
  }
};

export const stateTitle = (
  session: Pick<AgentSessionView, "state">,
): string => {
  switch (session.state) {
    case "live":
      return "This server is holding the session right now: its scope and credential are open, whether or not a turn is running.";
    case "ended":
      return "Ended for good: the session's authority is over and its writes are refused. Sending a message does not reopen it.";
    case "dormant":
      return "This server is not holding the session, and nothing recorded the operator ending it. It may still exist in its harness; sending a message reopens it.";
  }
};

/**
 * The harness a row ran on: its name, and whether this server still runs it.
 *
 * **Stranded is decided against a loaded listing only.** Before the harness listing arrives
 * every instance is merely unknown, and calling a live session's harness "gone" for the
 * length of a round trip would be wrong. A row recorded with no instance has nothing to
 * compare, and is named as unrecorded rather than flagged. The same rule the importer's own
 * picker uses (`App.#indexedSessions`).
 */
export const harnessOf = (
  session: Pick<AgentSessionView, "harnessInstanceId">,
  harnesses: readonly Pick<HarnessInstanceView, "instanceId" | "displayName">[],
  loaded: boolean,
): { readonly name: string; readonly strandedOn: string | undefined } => {
  const id = session.harnessInstanceId;
  if (id === null)
    return { name: "Harness not recorded", strandedOn: undefined };
  const listed = harnesses.find((entry) => entry.instanceId === id);
  return {
    name: listed?.displayName ?? id,
    strandedOn: loaded && listed === undefined ? id : undefined,
  };
};

/** "2 in · 1 out · 1 asset", or null for a kind that derives no tally. */
export const tallySentence = (
  tally: AgentSessionView["tally"],
): string | null =>
  tally === null
    ? null
    : `${String(tally.entriesIn)} in · ${String(tally.entriesOut)} out · ${String(tally.assets)} ${tally.assets === 1 ? "asset" : "assets"}`;

/**
 * The place a row leads to, or `null` for a row that leads nowhere.
 *
 * One function rather than a destination name the component then turns into an address: the
 * href a row carries and the place a click applies are the same answer, and two functions
 * could disagree about which id a kind is addressed by. They are different ids —
 * `sessionId` for an importer session, because the chat is addressed by the conversation;
 * `subjectId` for a goal, because the session is about a goal and the goal is the resource —
 * which is precisely the sort of thing that goes wrong twice if it is decided twice.
 *
 * **A worker attempt leads nowhere, and that is not an oversight.** The grammar has a path
 * for one, `/t/<targetId>/attempts/<attemptId>`, and following it opens that transcript. But
 * the Workers section lists nothing yet, so a row here is the only place an attempt could be
 * clicked from, and the design keeps that row inert rather than let this list become half of
 * the attempt list Flow B owns. The path stays inbound-only: a link to an attempt works, and
 * nothing in the app writes one.
 */
export const placeOfSession = (
  session: Pick<AgentSessionView, "kind" | "sessionId" | "subjectId">,
  targetId: string,
): Place | null => {
  switch (session.kind) {
    case "importer":
      return { kind: "chat", targetId, sessionId: session.sessionId };
    // The planner lives on its goal's page, beside the conversation (A7 U8b).
    case "goal":
    case "planner":
      return { kind: "goal", targetId, goalId: session.subjectId };
    case "worker":
      return null;
  }
};

/* ── A7 U8b: the grouped list ─────────────────────────────────────────────── */

/**
 * The session's own name, the bold half of a row's "name · where it lives": the harness's
 * title for an importer session where the page asked for it, else when it started, as the
 * importer's own picker names an untitled one; a goal's or planner's goal; a worker's
 * question.
 */
export const sessionName = (
  session: Pick<AgentSessionView, "kind" | "subject" | "title" | "startedAt">,
): string => {
  if (session.kind !== "importer") return session.subject;
  const title = session.title?.trim() ?? "";
  if (title !== "") return title;
  return `Session ${new Date(session.startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
};

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/**
 * The row's second line (A7 E1, E5): what a live session is doing or waiting on, or how a
 * finished one ended. `warning` on a waiting row, so the dot is never the only cue;
 * `danger` on a failure, the only outcome in colour.
 */
export const doingLine = (
  session: Pick<
    AgentSessionView,
    | "kind"
    | "state"
    | "detail"
    | "tally"
    | "activity"
    | "waiting"
    | "outcome"
    | "resumable"
  >,
): { readonly text: string; readonly tone: "muted" | "warning" | "danger" } => {
  if (session.waiting !== null) {
    return { text: `Waiting on you · ${session.waiting}`, tone: "warning" };
  }
  if (session.state === "live") {
    const doing = session.activity;
    if (doing === null) {
      return session.kind === "worker" || session.kind === "planner"
        ? {
            text: "Running · nothing narrated through this server yet",
            tone: "muted",
          }
        : {
            text: "Open · nothing said since this server took it",
            tone: "muted",
          };
    }
    const calls =
      doing.calls > 0
        ? plural(
            doing.calls,
            doing.running ? "tool call so far" : "tool call in its last turn",
            doing.running ? "tool calls so far" : "tool calls in its last turn",
          )
        : null;
    if (doing.running) {
      const what =
        doing.text ??
        (doing.lastTool === null ? "Working" : `Running ${doing.lastTool}`);
      return {
        text: [what, calls].filter((part) => part !== null).join(" · "),
        tone: "muted",
      };
    }
    return {
      text: [doing.text === null ? "Idle" : `Last reply: ${doing.text}`, calls]
        .filter((part) => part !== null)
        .join(" · "),
      tone: "muted",
    };
  }
  const reason =
    session.detail === null ? null : session.detail.replaceAll("_", " ");
  const tally = tallySentence(session.tally);
  switch (session.outcome) {
    case "failed":
      return {
        text: [
          "Failed",
          session.kind === "importer"
            ? session.detail === "refused"
              ? "the harness would not take the prompt"
              : "the session did not open"
            : session.detail === "uncertain"
              ? "how it ended is not known"
              : // "Failed · failed" says nothing twice.
                reason === "failed"
                ? null
                : reason,
          session.resumable ? "resumable" : null,
        ]
          .filter((part) => part !== null)
          .join(" · "),
        tone: "danger",
      };
    case "empty":
      return {
        text:
          session.kind === "planner"
            ? "Never ran a planning round"
            : "Ended without writing anything",
        tone: "muted",
      };
    case "stopped":
      return {
        text:
          session.kind === "importer"
            ? ["Ended by you", tally]
                .filter((part) => part !== null)
                .join(" · ")
            : session.kind === "goal"
              ? "Stopped · the goal was abandoned"
              : "Stopped · interrupted",
        tone: "muted",
      };
    case "completed":
    case null:
      return {
        text: [
          "Completed",
          session.kind === "importer" ? tally : null,
          session.kind === "planner" ? reason : null,
          // A conversation this server does not hold is carried on by a message.
          session.state === "dormant" &&
          (session.kind === "goal" || session.kind === "importer")
            ? "a message carries it on"
            : null,
        ]
          .filter((part) => part !== null)
          .join(" · "),
        tone: "muted",
      };
  }
};

/** A group's label (A7 E1, E5): Active's three, or a day — Today, Yesterday, then a date. */
export const groupLabel = (key: string, now: number): string => {
  if (key === "needs_you") return "Needs you";
  if (key === "running") return "Running";
  if (key === "idle") return "Idle";
  const day = /^day:(\d{4})-(\d{2})-(\d{2})$/u.exec(key);
  if (day === null) return key;
  const [, year, month, date] = day;
  const at = new Date(Number(year), Number(month) - 1, Number(date));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - at.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
};

/**
 * The Last activity column: relative while a session is live ("now", "12 min", "2 h"),
 * a clock time for one that ended today, a date before that.
 */
export const lastActivityLabel = (
  at: number,
  now: number,
  live: boolean,
): string => {
  const ago = Math.max(0, now - at);
  if (live) {
    if (ago < 60_000) return "now";
    if (ago < 3_600_000) return `${String(Math.floor(ago / 60_000))} min`;
    if (ago < 86_400_000) return `${String(Math.floor(ago / 3_600_000))} h`;
  }
  const when = new Date(at);
  const today = new Date(now);
  if (when.toDateString() === today.toDateString()) {
    return when.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
};

/**
 * The quiet line under a list the Needs you toggle narrowed (A7 E2): how many sessions it
 * hides, by group, so an empty-looking list never reads as a quiet target. Null when it
 * hides none.
 */
export const hiddenLine = (
  hidden: {
    readonly running: number;
    readonly idle: number;
    readonly ended: number;
  },
  tab: "active" | "ended" | "all",
): string | null => {
  const total = hidden.running + hidden.idle + hidden.ended;
  if (total === 0) return null;
  const parts = [
    hidden.running > 0 ? `${String(hidden.running)} running` : null,
    hidden.idle > 0 ? `${String(hidden.idle)} idle` : null,
    hidden.ended > 0 ? `${String(hidden.ended)} ended` : null,
  ].filter((part) => part !== null);
  const what = tab === "active" ? "active sessions" : "sessions";
  return `${String(total)} more ${total === 1 ? what.replace(/s$/u, "") : what} ${total === 1 ? "is" : "are"} hidden by this filter — ${parts.join(", ")}.`;
};

/** "1–25 of 123", with the tab's own word for the waiting-only view (A7 E2). */
export const rangeLabel = (
  page: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
  },
  shown: number,
  waitingOnly: boolean,
): string => {
  const suffix = waitingOnly ? " waiting" : "";
  if (page.total === 0) return `0 of 0${suffix}`;
  const first = (page.page - 1) * page.pageSize + 1;
  return `${String(first)}–${String(first + shown - 1)} of ${String(page.total)}${suffix}`;
};

/**
 * The page numbers a pager shows: all of them up to seven, otherwise the first, the last,
 * and the current one's neighbours, with `null` for a gap ("1 2 3 … 5").
 */
export const pagerPages = (
  page: number,
  pages: number,
): readonly (number | null)[] => {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, 2, pages, page - 1, page, page + 1]);
  const out: (number | null)[] = [];
  for (let each = 1; each <= pages; each += 1) {
    if (keep.has(each)) out.push(each);
    else if (out.at(-1) !== null) out.push(null);
  }
  return out;
};
