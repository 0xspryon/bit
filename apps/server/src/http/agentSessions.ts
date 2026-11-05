/**
 * The "Agent sessions" list: four kinds of session folded into one shape at read time, then
 * filtered, grouped and paged (A7 U8b).
 *
 * **There is no table behind this**, and the reason is the one the importer-conversation
 * design's S8.2 gives: each kind's index row is written inside its own surface's
 * transaction — a goal session with the goal, an import session with the import, an attempt
 * with its attempt, a planner lineage with its goal's first round — so a shared table would
 * make one write path the owner of four surfaces' invariants, and its subject column would
 * be a nullable tuple with a `CHECK` standing in for a type. This is a *read* concern.
 *
 * Pure on purpose: the route does the reading and the asking of this process's registries
 * and of the narration bus's activity summaries, and this module only decides what the
 * answers *mean* — which of `live`, `ended` and `dormant` each kind's evidence supports
 * (`AgentSessionState` says what each claims), how a finished one ended, which group a row
 * is in — and which of them one page shows.
 *
 * ## Paged here, from every row
 *
 * The four reads return every row of the target but workers' (bounded, below), and the page
 * is cut from their union in memory: liveness is a fact about this process, not a column,
 * so neither "Active" nor "Ended" can be a `WHERE` clause. V2(chat): page in SQL — a keyset
 * over the union, with liveness passed in as a list of held ids — once a target's worker
 * attempts number in the thousands; until then the bound is what keeps a read small, and
 * `workersOmitted` says what it hid.
 */
import {
  AGENT_SESSION_AGENT_LABEL,
  AGENT_SESSION_SECTION_LABEL,
  type AgentSessionActivity,
  type AgentSessionGroup,
  type AgentSessionKind,
  type AgentSessionOutcome,
  type AgentSessionsTab,
  type AgentSessionsView,
  type AgentSessionView,
  type ImporterSessionEndReason,
} from "@bit/contracts";

import type { NarrationSubject } from "../run/narration";

/**
 * How many worker sessions are read. Goal, importer and planner sessions grow by an
 * operator's action; worker attempts grow with every intent the hunt runs, so this is the
 * one kind that is bounded, and `workersOmitted` says what the bound hid. Large enough that
 * Ended's pages reach far back; small enough that one read of the list stays small.
 */
export const WORKER_SESSIONS_LISTED = 1_000;

/** What `unionAgentSessions` needs from the four reads and from this process's registries. */
export interface AgentSessionSources {
  readonly goals: readonly {
    readonly goalId: string;
    readonly goalName: string;
    readonly harnessSessionId: string;
    readonly harnessInstanceId: string | null;
    /** What the conversation was recorded as running on, or null (`0030`; older rows). */
    readonly model: string | null;
    readonly openedAt: number;
    /** The goal's status: `met` and `abandoned` say how a conversation not held ended. */
    readonly goalStatus?: string | undefined;
  }[];
  /** The goal conversation registry's answer for one goal, or `undefined` when not held. */
  readonly goalLive: (
    goalId: string,
  ) => { readonly sessionId: string; readonly model: string } | undefined;
  readonly importers: readonly {
    readonly harnessSessionId: string;
    readonly harnessInstanceId: string | null;
    readonly model: string;
    readonly openedAt: number;
    readonly latestImportId: string;
    /** Every import id the session has had, each a subject its narration went out under. */
    readonly importIds?: readonly string[] | undefined;
    /**
     * Whether this process **holds** the session: its scope, credential and MCP registration
     * are live. True between turns too, which is the point — slice 2 made the session outlive
     * a turn. Not "a run is in flight", which is a lower bound that calls an idle conversation
     * "not running".
     */
    readonly held: boolean;
    readonly endedAt: number | null;
    readonly endedReason: ImporterSessionEndReason | null;
    readonly entriesIn: number;
    readonly entriesOut: number;
    readonly assets: number;
  }[];
  readonly workers: {
    readonly sessions: readonly {
      readonly attemptId: string;
      readonly question: string;
      readonly harnessSessionId: string;
      readonly harnessInstanceId: string | null;
      readonly model: string;
      readonly status: string;
      readonly startedAt: number;
      readonly endedAt?: number | null | undefined;
    }[];
    readonly total: number;
  };
  readonly planners?:
    | readonly {
        readonly goalId: string;
        readonly goalName: string;
        readonly harnessSessionId: string;
        readonly createdAt: number;
        readonly round: {
          readonly roundId: string;
          readonly status: string;
          readonly harnessInstanceId: string | null;
          readonly model: string | null;
          readonly startedAt: number;
          readonly endedAt: number | null;
          readonly disposition: string | null;
        } | null;
      }[]
    | undefined;
  /**
   * What a subject has been doing, from the narration bus's summaries
   * (`run/sessionActivity.ts`); never a harness call. Absent: no summaries.
   */
  readonly activity?:
    | ((subject: NarrationSubject) => AgentSessionActivity | undefined)
    | undefined;
}

/** A row before it is placed on a page: everything but its group and its title. */
export type AgentSessionRow = Omit<AgentSessionView, "group" | "title">;

/** The newest of several activity summaries, so a session with several subjects shows its latest. */
const newest = (
  summaries: readonly (AgentSessionActivity | undefined)[],
): AgentSessionActivity | null =>
  summaries.reduce<AgentSessionActivity | null>(
    (best, each) =>
      each !== undefined && (best === null || each.at > best.at) ? each : best,
    null,
  );

const ENDED_IMPORTER_FAILURES: ReadonlySet<ImporterSessionEndReason> = new Set([
  "refused",
  "open_failed",
]);

/**
 * Folds the four reads into rows.
 *
 * V2(chat): every row's `waiting` is null — A7-Q (the question dock) is what learns that a
 * session is waiting on the operator (a pending harness question, a plan to approve) and
 * sets it here. The Needs you group, the toggle, the hidden-line counts and the rail's
 * warning count all turn on `waiting` already, so A7-Q supplies the state and nothing else.
 */
export const unionAgentSessions = (
  sources: AgentSessionSources,
): { readonly rows: AgentSessionRow[]; readonly workersOmitted: number } => {
  const activity = sources.activity ?? (() => undefined);

  const goals = sources.goals.map((goal): AgentSessionRow => {
    const held = sources.goalLive(goal.goalId);
    // The registry holds a session; the index names the one the goal's conversation was last
    // opened on. They agree whenever the registry holds anything (opening records the id), and
    // a mismatch would be a held session that is not the indexed one — not live *as listed*.
    const live = held !== undefined && held.sessionId === goal.harnessSessionId;
    const doing = newest([activity({ _tag: "goal", goalId: goal.goalId })]);
    return {
      kind: "goal",
      key: `goal:${goal.goalId}`,
      sessionId: goal.harnessSessionId,
      subject: goal.goalName,
      subjectId: goal.goalId,
      harnessInstanceId: goal.harnessInstanceId,
      // What the registry holds if it holds this session, else what the row recorded. Null is a
      // row written before `0030`, which stored no model and is not backfilled with a guess.
      model: live ? held.model : goal.model,
      startedAt: goal.openedAt,
      // A goal conversation has no ending of its own: the goal's status is its authority and
      // ending a goal interrupts nothing (`plan/goalConversation.ts`). So a goal row is live
      // or dormant, never ended.
      state: live ? "live" : "dormant",
      detail: null,
      tally: null,
      surface: { section: "goals", place: "Conversation", gone: false },
      lastActivityAt: Math.max(goal.openedAt, doing?.at ?? 0),
      activity: doing,
      waiting: null,
      // A conversation this server does not hold finished its last turn; the goal's own end
      // says more where it has one. An abandoned goal was stopped.
      outcome: live
        ? null
        : goal.goalStatus === "abandoned"
          ? "stopped"
          : "completed",
      resumable: false,
    };
  });

  const importers = sources.importers.map((session): AgentSessionRow => {
    const doing = newest(
      (session.importIds ?? [session.latestImportId]).map((importId) =>
        activity({ _tag: "import", importId }),
      ),
    );
    // Three readings, and `ended` is only the one that is final. An operator's end is the one
    // end that refuses every write and is never reopened (`0027`); a shutdown, a refused
    // prompt or a failed open recorded that *a* period closed, and a message to the session
    // opens a fresh one. So those read `dormant` — this server does not hold it — with the
    // recorded reason beside it, never `ended`. A held session beats a stored ending: the
    // ending is for the session's *latest* authority period and a held one means a newer is open.
    const state = session.held
      ? "live"
      : session.endedReason === "operator"
        ? "ended"
        : "dormant";
    const wrote = session.entriesIn + session.entriesOut + session.assets > 0;
    const failed =
      session.endedReason !== null &&
      ENDED_IMPORTER_FAILURES.has(session.endedReason);
    const outcome: AgentSessionOutcome | null =
      state === "live"
        ? null
        : failed
          ? "failed"
          : !wrote
            ? "empty"
            : session.endedReason === "operator"
              ? "stopped"
              : "completed";
    return {
      kind: "importer",
      key: `importer:${session.latestImportId}`,
      sessionId: session.harnessSessionId,
      subject: "Scope import",
      subjectId: session.latestImportId,
      harnessInstanceId: session.harnessInstanceId,
      model: session.model,
      startedAt: session.openedAt,
      state,
      detail: session.held ? null : session.endedReason,
      tally: {
        entriesIn: session.entriesIn,
        entriesOut: session.entriesOut,
        assets: session.assets,
      },
      surface: { section: "assets", place: "Auto-load", gone: false },
      lastActivityAt: Math.max(
        session.endedAt ?? session.openedAt,
        doing?.at ?? 0,
      ),
      activity: doing,
      waiting: null,
      outcome,
      // Only an operator's end is final; a refused prompt or a failed open is carried on by
      // the next message, in a fresh session.
      resumable: failed,
    };
  });

  const workers = sources.workers.sessions.map((attempt): AgentSessionRow => {
    const doing = newest([
      activity({ _tag: "attempt", attemptId: attempt.attemptId }),
    ]);
    const live = attempt.status === "running";
    return {
      kind: "worker",
      key: `worker:${attempt.attemptId}`,
      sessionId: attempt.harnessSessionId,
      subject: attempt.question,
      subjectId: attempt.attemptId,
      harnessInstanceId: attempt.harnessInstanceId,
      model: attempt.model,
      startedAt: attempt.startedAt,
      // `running` is the only status that still has authority; `uncertain` is terminal for
      // authority too (see `AttemptExecutionStatus`), so it is `ended` with the word beside it.
      state: live ? "live" : "ended",
      detail: attempt.status,
      tally: null,
      surface: { section: "workers", place: "Attempt", gone: false },
      lastActivityAt: Math.max(
        attempt.endedAt ?? attempt.startedAt,
        doing?.at ?? 0,
      ),
      activity: doing,
      waiting: null,
      outcome: live ? null : attemptOutcome(attempt.status),
      // An attempt is prompted once; a failed one is replaced, never carried on.
      resumable: false,
    };
  });

  const planners = (sources.planners ?? []).map((lineage): AgentSessionRow => {
    const round = lineage.round;
    const doing =
      round === null
        ? null
        : newest([activity({ _tag: "round", roundId: round.roundId })]);
    const live = round?.status === "running";
    return {
      kind: "planner",
      key: `planner:${lineage.goalId}`,
      sessionId: lineage.harnessSessionId,
      subject: lineage.goalName,
      subjectId: lineage.goalId,
      harnessInstanceId: round?.harnessInstanceId ?? null,
      model: round?.model ?? null,
      startedAt: lineage.createdAt,
      // The lineage is resumed by the goal's next round, so between rounds it is not running
      // and nothing ended it for good: dormant, with the last round's status beside it.
      state: live ? "live" : "dormant",
      detail: round === null ? null : (round.disposition ?? round.status),
      tally: null,
      surface: { section: "goals", place: "Plan", gone: false },
      lastActivityAt: Math.max(
        round?.endedAt ?? round?.startedAt ?? lineage.createdAt,
        doing?.at ?? 0,
      ),
      activity: doing,
      // V2(chat): a planner waiting for its plan to be approved is A7-Q's to report; no
      // round status says so today, so the planner is never in Needs you yet.
      waiting: null,
      outcome: live
        ? null
        : round === null
          ? "empty"
          : attemptOutcome(round.status),
      resumable: false,
    };
  });

  return {
    rows: [...goals, ...importers, ...workers, ...planners],
    workersOmitted: Math.max(
      0,
      sources.workers.total - sources.workers.sessions.length,
    ),
  };
};

/** How a worker attempt's or a planner round's final status reads as an outcome. */
const attemptOutcome = (status: string): AgentSessionOutcome =>
  status === "succeeded" || status === "settled"
    ? "completed"
    : status === "interrupted"
      ? "stopped"
      : "failed";

/* ── Grouping and paging ──────────────────────────────────────────────────── */

/** What one read asks for, decoded: the route fills the defaults. */
export interface AgentSessionsPageQuery {
  readonly tab: AgentSessionsTab;
  readonly needsYou: boolean;
  readonly agent: AgentSessionKind | undefined;
  readonly q: string;
  readonly page: number;
  readonly pageSize: number;
  readonly timeZone: string;
}

/** The order Active's groups are drawn in (A7 E1): what each needs from the operator. */
const ACTIVE_GROUPS = ["needs_you", "running", "idle"] as const;

/**
 * Which Active group a live row is in. Waiting beats everything; then a turn in flight; a
 * worker attempt or a planner round is one prompt, so a live one with nothing narrated yet
 * is running, while a conversation held between turns is idle.
 */
export const activeGroup = (
  row: AgentSessionRow,
): (typeof ACTIVE_GROUPS)[number] => {
  if (row.waiting !== null) return "needs_you";
  if (row.activity !== null) return row.activity.running ? "running" : "idle";
  return row.kind === "worker" || row.kind === "planner" ? "running" : "idle";
};

/**
 * The calendar day a time falls on in a time zone, as `YYYY-MM-DD`. An unknown zone is
 * read as UTC rather than refused: the grouping is a convenience, the rows are the answer.
 */
export const dayIn = (at: number, timeZone: string): string => {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
};

const matchesText = (row: AgentSessionRow, q: string): boolean => {
  if (q === "") return true;
  const needle = q.toLowerCase();
  // V2(chat): an importer session's harness title is read only for the rows a page shows
  // (`titles=1`), so the text filter does not find one by its title — only by where it
  // lives ("Auto-load", "Assets") and its agent. Searching titles means reading every
  // session's from its harness on each keystroke, or storing them, which S9 refused.
  return [
    row.subject,
    AGENT_SESSION_SECTION_LABEL[row.surface.section],
    row.surface.place,
    AGENT_SESSION_AGENT_LABEL[row.kind],
    row.model ?? "",
  ].some((field) => field.toLowerCase().includes(needle));
};

/**
 * One page of the list: the tab's rows, filtered, in display order, cut to the page, each
 * with its group, and every count the page draws.
 *
 * - **Tab counts and the waiting count are unfiltered** (A7 E2), so no filter makes them jump.
 * - The agent and text filters narrow the tab; the **Needs you** toggle narrows it further,
 *   and what it hides is counted by group for the "N more … hidden" line.
 * - Active is grouped Needs you, Running, Idle and answered whole: it is what is running
 *   now, never long. Ended is grouped by the day of its last activity in the browser's
 *   zone, newest first. All is Active's groups, then Ended's days.
 * - A group's count is over the whole filtered tab, so a day that runs onto the next page
 *   keeps its full count there, and the page names it again.
 */
export const pageAgentSessions = (
  union: {
    readonly rows: readonly AgentSessionRow[];
    readonly workersOmitted: number;
  },
  query: AgentSessionsPageQuery,
): Omit<AgentSessionsView, "sessions"> & {
  readonly sessions: readonly (AgentSessionRow & { readonly group: string })[];
} => {
  const all = union.rows;
  const isActive = (row: AgentSessionRow) => row.state === "live";
  const counts = {
    active: all.filter(isActive).length,
    ended: all.filter((row) => !isActive(row)).length,
    all: all.length,
    needsYou: all.filter((row) => row.waiting !== null).length,
  };
  const inTab = all.filter((row) =>
    query.tab === "active"
      ? isActive(row)
      : query.tab === "ended"
        ? !isActive(row)
        : true,
  );
  const narrowed = inTab.filter(
    (row) =>
      (query.agent === undefined || row.kind === query.agent) &&
      matchesText(row, query.q.trim()),
  );
  const grouped = narrowed.map((row) => ({
    ...row,
    group: isActive(row)
      ? activeGroup(row)
      : `day:${dayIn(row.lastActivityAt, query.timeZone)}`,
  }));
  const shown = query.needsYou
    ? grouped.filter((row) => row.waiting !== null)
    : grouped;
  const hiddenRows = query.needsYou
    ? grouped.filter((row) => row.waiting === null)
    : [];
  const hidden = {
    running: hiddenRows.filter((row) => row.group === "running").length,
    idle: hiddenRows.filter((row) => row.group === "idle").length,
    ended: hiddenRows.filter((row) => row.group.startsWith("day:")).length,
  };
  const rank = (group: string): number => {
    const at = ACTIVE_GROUPS.indexOf(group as (typeof ACTIVE_GROUPS)[number]);
    return at === -1 ? ACTIVE_GROUPS.length : at;
  };
  const ordered = [...shown].sort(
    (a, b) =>
      rank(a.group) - rank(b.group) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.startedAt - a.startedAt ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const total = ordered.length;
  // Active is answered in one piece; Ended and All are paged.
  const pageSize = query.tab === "active" ? Math.max(total, 1) : query.pageSize;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page =
    query.tab === "active"
      ? 1
      : Math.min(pages, Math.max(1, Math.floor(query.page)));
  const sessions = ordered.slice((page - 1) * pageSize, page * pageSize);
  const full = new Map<string, number>();
  for (const row of ordered)
    full.set(row.group, (full.get(row.group) ?? 0) + 1);
  const groups: AgentSessionGroup[] = [];
  for (const row of sessions) {
    if (groups.at(-1)?.key !== row.group) {
      groups.push({ key: row.group, count: full.get(row.group) ?? 0 });
    }
  }
  return {
    sessions,
    groups,
    counts,
    total,
    page,
    pageSize: query.tab === "active" ? query.pageSize : pageSize,
    hidden,
    workersOmitted: union.workersOmitted,
  };
};
