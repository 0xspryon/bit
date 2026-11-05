import { Schema } from "effect";

import { ImporterSessionTally } from "./scopeImport";

/**
 * Which agent a long-running session is, and so which surface it belongs to.
 *
 * The planner is the fourth (A7 U8b): one row per goal's planner lineage, the session every
 * planning round of that goal resumes, read with its latest round (`planner_rounds` carries
 * the session, instance, model and a status).
 */
export const AgentSessionKind = Schema.Literals([
  "goal",
  "importer",
  "worker",
  "planner",
]);
export type AgentSessionKind = typeof AgentSessionKind.Type;

/**
 * Three states, because there are three different things an operator can be told, and the
 * composer's disabled states (importer-conversation design, S3) already turn on the difference
 * between the last two.
 *
 * - `live` — this process **holds** the session right now: for a goal conversation, its scope
 *   is open; for an importer, its scope, credential and MCP registration are live — which is
 *   true between turns as well as during one, because the session outlives a turn; for a
 *   worker, its attempt is running.
 * - `dormant` — an index row exists, this process does not hold it, and **nothing recorded
 *   its authority ending for good**. After a restart this is every goal conversation and every
 *   unended importer session; an importer session closed by a shutdown, a refused prompt or a
 *   failed open reads the same, with the reason in `detail`. The harness may still have the
 *   session; nothing here can act through it; **a message to it opens it again**.
 * - `ended` — something recorded that the session's authority is over *for good*: an importer
 *   session the operator ended (its tools refuse every write and a message does not reopen
 *   it), a worker attempt in a final status.
 *
 * `dormant` and `ended` are not two shades of "not running". One is a fact about this
 * server's memory and is undone by a message; the other is a fact about the session's
 * authority and is not.
 */
export const AgentSessionState = Schema.Literals(["live", "ended", "dormant"]);
export type AgentSessionState = typeof AgentSessionState.Type;

/** The rail section a session's surface is under, whose sidebar icon its breadcrumb uses. */
export const AgentSessionSection = Schema.Literals([
  "goals",
  "assets",
  "workers",
]);
export type AgentSessionSection = typeof AgentSessionSection.Type;

/** Each section's name as the rail says it, which a breadcrumb repeats and the text filter matches. */
export const AGENT_SESSION_SECTION_LABEL: Record<AgentSessionSection, string> =
  {
    goals: "Goals",
    assets: "Assets",
    workers: "Workers",
  };

/**
 * Each kind's agent as the list names it (A7 E1): the Agent column, the agent filter, and
 * what the text filter matches. The importer is named for its page, Auto-load.
 */
export const AGENT_SESSION_AGENT_LABEL: Record<AgentSessionKind, string> = {
  goal: "Goal agent",
  importer: "Auto-load",
  worker: "Worker",
  planner: "Planner",
};

export const AgentSessionSurface = Schema.Struct({
  section: AgentSessionSection,
  /** The place within the section: a goal's name, `Auto-load`. */
  place: Schema.String,
  gone: Schema.Boolean,
});
export type AgentSessionSurface = typeof AgentSessionSurface.Type;

/**
 * What a session has been doing, summarised by this process from the narration it
 * published (A7 U8b) — never asked of a harness. Kept in memory, per session, for the
 * sessions this process has narrated since it started; a restart begins with none.
 */
export const AgentSessionActivity = Schema.Struct({
  /** Whether a turn is in flight: something was narrated after the last turn's outcome. */
  running: Schema.Boolean,
  /** Tool calls in the current (or last) turn. */
  calls: Schema.Int,
  /**
   * The last tool it called in that turn, as the list names it: an MCP tool without its
   * `mcp__<server>__` prefix (the server is bit's own, per session, and says nothing).
   */
  lastTool: Schema.NullOr(Schema.String),
  /**
   * The sub-agent running in that turn, by its type or, failing that, its task's short
   * description; null when none is running. Agent text: drawn isolated, as plain text.
   */
  subagent: Schema.NullOr(Schema.String),
  /** The last line of what it last wrote, shortened; null before it wrote anything. */
  text: Schema.NullOr(Schema.String),
  /**
   * Why the last turn failed, in the harness's own words (one line, capped), or null. Set
   * by a turn that ended with an error ("Free usage limit reached"); cleared when the next
   * turn starts. Untrusted text: a provider's error can quote anything.
   */
  failure: Schema.NullOr(Schema.String),
  /** When the last of it was narrated, in epoch milliseconds. */
  at: Schema.Int,
});
export type AgentSessionActivity = typeof AgentSessionActivity.Type;

/**
 * How a session that is no longer running ended (A7 E5): `completed`; `stopped` by the
 * operator or interrupted; `failed`; `empty`, which ended without writing anything; and
 * `unknown`, which ended in a way nobody could tell — a worker attempt or a planner round
 * whose status is `uncertain`. Unknown is not failure: the list draws it neutrally, and
 * failure stays the only outcome in colour.
 *
 * A session this server merely does not hold — a goal conversation after a restart, an
 * importer session a shutdown let go — has **no** outcome: it did not end, and a message
 * carries it on. Its row is `dormant` with `outcome: null`.
 */
export const AgentSessionOutcome = Schema.Literals([
  "completed",
  "stopped",
  "failed",
  "empty",
  "unknown",
]);
export type AgentSessionOutcome = typeof AgentSessionOutcome.Type;

/**
 * One row of the "Agent sessions" list: a session of any kind, in the one shape the list
 * draws.
 *
 * **A read-time union, not a table.** Each kind's index row is written inside its own
 * surface's transaction, and the subjects differ (a goal, an import, an attempt), so there is
 * deliberately no shared store behind this. The route reads the indexes and folds them into
 * this view, and `kind` says which to go to for the real screen.
 */
export const AgentSessionView = Schema.Struct({
  kind: AgentSessionKind,
  /** Unique within one answer: `kind` and the subject's id, never the harness session id. */
  key: Schema.String,
  /** The harness's own id for the session, for display and for a future deep link. */
  sessionId: Schema.String,
  /**
   * What the session is about, in words: the goal's name, the worker's question, and for the
   * importer the fixed `Scope import` — the importer is about the target's scope, and which
   * program pages it read is the importer's own screen's to say.
   */
  subject: Schema.String,
  /**
   * The id of the thing the session is about, in the surface's own terms: the goal id, the
   * import id a message to the session is addressed to, the attempt id.
   */
  subjectId: Schema.String,
  /**
   * The harness instance that minted the session, or null where none was recorded. Resolved
   * to a name — and compared against the instances this server runs, to mark a session whose
   * harness is gone — by the caller, as the importer picker does: the server answering this
   * route is not the one holding the browser's harness listing.
   */
  harnessInstanceId: Schema.NullOr(Schema.String),
  /**
   * The model as `provider/model`, or null when it is not known. Null is a goal conversation
   * whose row was written before `0030` (`goal_sessions` recorded the session and the
   * instance and no model until then) and which this process does not hold; those are not
   * backfilled with a guess.
   */
  model: Schema.NullOr(Schema.String),
  /** When the session was opened, in epoch milliseconds. */
  startedAt: Schema.Int,
  state: AgentSessionState,
  /**
   * One word of why, where the kind has it: a worker attempt's execution status, an importer
   * session's recorded end reason (beside `ended` for an operator's end, beside `dormant` for
   * a shutdown, a refused prompt or a failed open). Null where the kind has nothing to add.
   */
  detail: Schema.NullOr(Schema.String),
  /** What the session wrote, for the one kind that derives it (the importer), else null. */
  tally: Schema.NullOr(ImporterSessionTally),
  /**
   * The harness's title for the session, where it was asked for (`titles=1`) and the kind
   * has one — the importer's, read as the importer's own list reads it (S9) — else null.
   * Never stored: a title is the harness's, read through.
   */
  title: Schema.NullOr(Schema.String),
  /**
   * Where the session lives, as the row's breadcrumb draws it: the rail section (whose icon
   * it borrows) and the place within it. `gone` marks a surface that no longer exists; the
   * row then draws it struck through and still opens.
   */
  surface: AgentSessionSurface,
  /** The latest thing known to have happened in it, in epoch milliseconds. */
  lastActivityAt: Schema.Int,
  /** What it is doing now, from what it narrated through this process; null if nothing. */
  activity: Schema.NullOr(AgentSessionActivity),
  /**
   * What it is waiting on the operator for, in words, or null. **Always null until A7-Q**
   * (the question dock) supplies a pending question; the list's Needs you group, toggle and
   * counts already turn on it.
   */
  waiting: Schema.NullOr(Schema.String),
  /**
   * How a finished session ended; null while it is live, and null for a `dormant` one that
   * did not end — this server let it go, and a message carries it on.
   */
  outcome: Schema.NullOr(AgentSessionOutcome),
  /**
   * Whether a message to it carries it on: a goal conversation of an active goal, or an
   * importer session not ended by the operator whose agent this server still defines and
   * whose harness it still runs (`importerReopen`'s refusals). Always false while live —
   * there is nothing to carry on — and for a worker attempt or a planner round.
   */
  resumable: Schema.Boolean,
  /** The row's group on this page: `needs_you`, `running`, `idle`, or `day:<YYYY-MM-DD>`. */
  group: Schema.String,
});
export type AgentSessionView = typeof AgentSessionView.Type;

/** Which tab the list is on: live sessions, finished ones, or both. */
export const AgentSessionsTab = Schema.Literals(["active", "ended", "all"]);
export type AgentSessionsTab = typeof AgentSessionsTab.Type;

/** Rows per page (A7 E5). */
export const AGENT_SESSION_PAGE_SIZES = [25, 50, 100] as const;
export const AgentSessionsPageSize = Schema.Literals(["25", "50", "100"]);

/**
 * What a read of the list asks for. Every field optional: none is Active, every agent, no
 * text, page 1 of 25, grouped by day in UTC, no titles.
 */
export const AgentSessionsQuery = {
  tab: Schema.optional(AgentSessionsTab),
  /** `1` narrows the tab to sessions waiting on the operator. */
  needsYou: Schema.optional(Schema.Literal("1")),
  /** One kind, or absent for every agent. */
  agent: Schema.optional(AgentSessionKind),
  /** Matched, case-insensitively, against each row's name and where it lives. */
  q: Schema.optional(Schema.String),
  page: Schema.optional(Schema.FiniteFromString),
  pageSize: Schema.optional(AgentSessionsPageSize),
  /** The browser's IANA time zone, which ended rows are grouped into days by. */
  tz: Schema.optional(Schema.String),
  /** `1` asks the harnesses for the titles of the importer rows on this page. */
  titles: Schema.optional(Schema.Literal("1")),
};

/** One group on a page, with its count over the whole filtered list, not just this page. */
export const AgentSessionGroup = Schema.Struct({
  key: Schema.String,
  count: Schema.Int,
});
export type AgentSessionGroup = typeof AgentSessionGroup.Type;

export const AgentSessionsView = Schema.Struct({
  /** This page's rows, in display order: Active by group, Ended by day, newest first. */
  sessions: Schema.Array(AgentSessionView),
  /** The groups this page draws, in order, each with its full count across pages. */
  groups: Schema.Array(AgentSessionGroup),
  /**
   * The tabs' counts and the waiting count, **unfiltered** — by the toggle, the agent and the
   * text alike — so changing a filter never makes the totals jump (A7 E2).
   */
  counts: Schema.Struct({
    active: Schema.Int,
    ended: Schema.Int,
    all: Schema.Int,
    needsYou: Schema.Int,
  }),
  /** How many rows the filtered tab holds, which the range ("1–25 of 123") is out of. */
  total: Schema.Int,
  /** The page answered (clamped into range), and its size. */
  page: Schema.Int,
  pageSize: Schema.Int,
  /**
   * What the Needs you toggle hides from the tab, by group, after the other filters: zero
   * when the toggle is off. Feeds "3 more active sessions are hidden by this filter".
   */
  hidden: Schema.Struct({
    running: Schema.Int,
    idle: Schema.Int,
    ended: Schema.Int,
  }),
  /**
   * How many worker sessions the target has beyond those read. Worker attempts accumulate
   * with every intent the hunt runs, so they are bounded and the other kinds are not; the
   * number is here so a truncated list says so rather than looking complete.
   */
  workersOmitted: Schema.Int,
});
export type AgentSessionsView = typeof AgentSessionsView.Type;
