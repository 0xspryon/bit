import { Schema } from "effect";

import { ImporterSessionTally } from "./scopeImport";

/**
 * Which surface a long-running agent session belongs to.
 *
 * A planner round is a fourth session-shaped thing and is **not** here: the first list is the
 * three kinds the importer-conversation design's S8 names. It is derivable the same way a
 * worker attempt is (`planner_rounds` carries the session, instance, model and a status), so
 * adding it is a new literal and a new read, not a change of shape.
 */
export const AgentSessionKind = Schema.Literals(["goal", "importer", "worker"]);
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
});
export type AgentSessionView = typeof AgentSessionView.Type;

export const AgentSessionsView = Schema.Struct({
  /** Newest first, across kinds. */
  sessions: Schema.Array(AgentSessionView),
  /**
   * How many worker sessions the target has beyond those listed. Worker attempts accumulate
   * with every intent the hunt runs, so they are bounded and the other kinds are not; the
   * number is here so a truncated list says so rather than looking complete.
   */
  workersOmitted: Schema.Int,
});
export type AgentSessionsView = typeof AgentSessionsView.Type;
