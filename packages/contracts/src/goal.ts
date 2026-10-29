/**
 * A goal: an objective within one target's investigation, and the lifecycle it has.
 *
 * A target is the system under test and the hunt is the investigation of it over time —
 * not a row, it _is_ the target. A goal is a durable record inside that investigation:
 * something the operator (and, later, a planner) is trying to establish. Intents hang off
 * a goal and attempts off an intent; `goals.target_id`, `intents.goal_id` and
 * `attempts.intent_id` already say so, and nothing here re-parents them. This slice makes
 * the goal a thing that can be *created and ended on purpose*; before it, `seedAttempt`
 * minted one as a side effect of starting a run, and nothing could say a goal was over.
 *
 * ## One field for the objective, and it is `description`
 *
 * The objective text is {@link OpenGoalInput.description}, the column `goals` has always
 * had. There is no separate `objective` field, because two fields meaning one thing is a
 * schema that disagrees with itself the first time they differ. {@link OpenGoalInput.name}
 * is the short human label and is a different thing: a handle for a list row, not the
 * objective.
 *
 * ## What ending a goal does, and does not
 *
 * A goal ends when the planner records that the objective is met or when the operator ends
 * it (the spec's decision 8). Ending **blocks new dispatch and planner wake-ups**; it does
 * **not** interrupt an attempt that is already running. An attempt is a unit of work an
 * operator may have reasons to let finish, and stopping it is the existing stop control's
 * job, not a side effect of a label changing.
 *
 * Browser-safe: Effect Schema only. No server, Bun, Node or persistence imports.
 */
import { Schema } from "effect";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/**
 * Where a goal is in its life.
 *
 * - `active` — open. Every goal starts here, and so does every goal that existed before
 *   the lifecycle did: `seedAttempt` minted real objectives, and they are still being
 *   worked.
 * - `met` — the objective was established. Terminal.
 * - `abandoned` — ended without being established: out of scope, no longer wanted,
 *   superseded. Terminal, and deliberately not a flavour of `met`, because "we stopped" and
 *   "we got there" are different claims and a later reader must be able to tell them apart.
 *
 * There is no way back from either terminal state. A goal that turns out to need more work
 * is a new goal, so that the record of what was concluded, by whom and when, is never
 * overwritten.
 */
export const GoalStatus = Schema.Literals(["active", "met", "abandoned"]);
export type GoalStatus = typeof GoalStatus.Type;

/** The two statuses a goal can be ended into. */
export const GoalEndStatus = Schema.Literals(["met", "abandoned"]);
export type GoalEndStatus = typeof GoalEndStatus.Type;

/**
 * Who ended a goal.
 *
 * - `operator` — a person, through the browser.
 * - `planner` — the planner recorded that the objective was met. Nothing writes this yet;
 *   the value exists so that when something does, the record already distinguishes a
 *   person's decision from a machine's.
 */
export const GoalEndedBy = Schema.Literals(["planner", "operator"]);
export type GoalEndedBy = typeof GoalEndedBy.Type;

/**
 * What creating one goal needs. Host-facing: the store takes this, a browser does not
 * send it ({@link GoalDraft} is what a browser sends).
 *
 * `goalId` is host-owned, like the one `AddIntentInput` takes: the store checks it and
 * never mints it, because the host is what knows whether this is a new goal or a retry of
 * one it already has an id for.
 */
export const OpenGoalInput = Schema.Struct({
  /** Stable operation identity. An exact retry replays; conflicting reuse is refused. */
  operationId: Schema.NonEmptyString,
  goalId: Schema.NonEmptyString,
  /**
   * A short label for a list row. Empty is legitimate and means the operator gave none —
   * the objective is then what a list shows.
   */
  name: Schema.String,
  /** The objective, in the operator's words. Never empty: a goal with no objective is noise. */
  description: Schema.NonEmptyString,
});
export type OpenGoalInput = typeof OpenGoalInput.Type;

/** What opening a goal returns. */
export const OpenGoalResult = Schema.Struct({
  goalId: Schema.String,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
});
export type OpenGoalResult = typeof OpenGoalResult.Type;

/** What ending one goal needs. Host-facing, like {@link OpenGoalInput}. */
export const EndGoalInput = Schema.Struct({
  /** Stable operation identity. An exact retry replays; conflicting reuse is refused. */
  operationId: Schema.NonEmptyString,
  goalId: Schema.NonEmptyString,
  /** What the goal is ended into. `active` is not an ending and is not accepted. */
  status: GoalEndStatus,
  endedBy: GoalEndedBy,
  /** Why. Empty is legitimate and means none was given; it is stored as given. */
  reason: Schema.String,
});
export type EndGoalInput = typeof EndGoalInput.Type;

/** What ending a goal returns. */
export const EndGoalResult = Schema.Struct({
  goalId: Schema.String,
  status: GoalEndStatus,
  endedBy: GoalEndedBy,
  /** When the ending was recorded. On a replay this is the original time, not now. */
  endedAt: EpochMillis,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
});
export type EndGoalResult = typeof EndGoalResult.Type;

/**
 * How much hangs under one goal, as a snapshot.
 *
 * Counts, not lists: a goal row in a list wants to say "this one has work under it" and a
 * list of every intent would make the list the size of the investigation. A running
 * attempt may add to them between being read and being rendered.
 */
export const GoalCounts = Schema.Struct({
  /** Intents under this goal. Zero is the ordinary state of a goal nothing has planned for. */
  intents: Schema.Int,
  /** Attempts under any of this goal's intents. */
  attempts: Schema.Int,
  /** Observations recorded under any of this goal's intents. */
  observations: Schema.Int,
});
export type GoalCounts = typeof GoalCounts.Type;

/** What a browser reads about one goal. */
export const GoalView = Schema.Struct({
  goalId: Schema.String,
  /** The target this goal belongs to. A goal never moves between targets. */
  targetId: Schema.String,
  /**
   * The short label, or the empty string when the operator gave none. Empty is not
   * "unnamed by mistake": goals that predate names read this way, and a list falls back to
   * the objective for them.
   */
  name: Schema.String,
  /** The objective. */
  description: Schema.String,
  status: GoalStatus,
  createdAt: EpochMillis,
  /** When the goal was ended. Null while it is `active`, and only then. */
  endedAt: Schema.NullOr(EpochMillis),
  /** Who ended it. Null while it is `active`, and only then. */
  endedBy: Schema.NullOr(GoalEndedBy),
  /**
   * Why it was ended, as given. Null while `active`. An ended goal with an empty string
   * here was ended with no reason; null means it has not been ended at all.
   */
  endReason: Schema.NullOr(Schema.String),
  counts: GoalCounts,
});
export type GoalView = typeof GoalView.Type;

/**
 * What the create form submits.
 *
 * **The server mints the goal id and the operation id; a browser never names either.** An
 * id a browser chose is an id a browser could reuse against another target's goal, and an
 * operation id a browser chose would make a double-click and a deliberate second goal
 * indistinguishable. Both are the server's to assign, so a retry the browser makes is a
 * new request, which is what a person pressing the button twice means.
 *
 * Both fields are trimmed on the way in. A description of only whitespace is therefore
 * empty and refused before anything is written.
 */
export const GoalDraft = Schema.Struct({
  /** Optional label. Absent and empty both mean none. */
  name: Schema.optional(Schema.Trim),
  /** The objective. Required, and not blank. */
  description: Schema.Trim.check(Schema.isNonEmpty()),
});
export type GoalDraft = typeof GoalDraft.Type;

/**
 * What the end control submits. The goal is in the path and the ender is not here at all:
 * this route is the operator's, so `endedBy` is `"operator"` by construction, never by the
 * payload's say-so.
 */
export const GoalEndDraft = Schema.Struct({
  status: GoalEndStatus,
  /** Why, in the operator's words. Empty means none given. */
  reason: Schema.String,
});
export type GoalEndDraft = typeof GoalEndDraft.Type;
