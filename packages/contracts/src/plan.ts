/**
 * A planner round, as a browser reads it and as a route refuses it.
 *
 * These three shapes — {@link PlanRefused}, {@link PlanRoundStarted} and
 * {@link RunningRound} — were declared in `plan/planSupervisor.ts` while nothing a browser
 * could reach used them, and that file said so with an expiry attached: "the planner's
 * `POST /goals/:goalId/plan` arrives in slice 7, which is where this becomes a browser's
 * concern and where it should move". This is that move. The server's own module now
 * imports them from here, so there is one definition of each rather than a server type
 * and a wire type that have to be kept in step by hand.
 *
 * **What is still the server's and is deliberately not here.** `PlanInput` is not a wire
 * shape: a round's directory, its audit path and the engagement folder it must not be
 * inside are facts about this installation's filesystem layout, and a browser that could
 * name any of them would be choosing where an agent runs. The route takes a target and a
 * goal from the path and nothing else at all — there is no payload — and the server
 * supplies the rest from the registry.
 *
 * `PlanRoundStopped` is likewise absent: stopping a round is the planner view's control
 * and arrives with it, and publishing a shape no route answers with would be the mistake
 * this file exists to correct.
 *
 * Browser-safe: Effect Schema only. No server, Bun, Node or persistence imports.
 */
import { Schema } from "effect";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/**
 * Where a planner round is in its life.
 *
 * The attempt vocabulary minus `succeeded` and `failed`, because a round does not pass or
 * fail: it either produced a disposition or it did not, and the disposition is its own
 * field. This says whether *execution* finished and how, and never what the planning
 * concluded.
 *
 * - `running` — live. The only status under which the round's credential writes.
 * - `settled` — it finished normally, whether or not it recorded a disposition.
 * - `uncertain` — nobody could tell us how it ended.
 * - `interrupted` — it was stopped, by the operator or by a shutdown.
 */
export const RoundStatus = Schema.Literals([
  "running",
  "settled",
  "uncertain",
  "interrupted",
]);
export type RoundStatus = typeof RoundStatus.Type;

/**
 * What a round concluded, in the planner's own four answers.
 *
 * - `actionable` — it added intents worth running.
 * - `waiting` — nothing to add until work already out comes back.
 * - `no_useful_next_action` — a considered "there is nothing worth doing here". A
 *   judgement, and deliberately not the same fact as having recorded nothing at all,
 *   which is `disposition: null`.
 * - `objective_met` — the goal's objective is established. The one disposition that also
 *   **ends the goal**, with `endedBy: "planner"`.
 */
export const RoundDisposition = Schema.Literals([
  "actionable",
  "waiting",
  "no_useful_next_action",
  "objective_met",
]);
export type RoundDisposition = typeof RoundDisposition.Type;

/**
 * A round this server will not open.
 *
 * Every reason is a decision an operator can act on, and the ones that look alike are
 * kept apart on purpose:
 *
 * - `no_harness` — this server drives no agent at all. Nothing was asked.
 * - `harness_not_ready` — the instance named is not configured here, or did not come up.
 *   Nothing was asked either, which is why it is not `harness_unreachable`.
 * - `harness_unreachable` — a harness was there and did not answer while the round was
 *   being set up. Nothing was prompted.
 * - `goal_busy` — a round is already running on this goal **in this process**, named in
 *   the detail.
 * - `round_conflict` — the *store* refused: a round is already running on this goal
 *   according to the rows, or the round id already exists. Kept apart from `goal_busy`
 *   because one can be true without the other — a row left by a dead process is
 *   `round_conflict` with nothing running.
 * - `goal_not_found`, `goal_not_active` — the goal is not this target's, or it has ended.
 * - `planning_directory_unusable` — the round's own directory could not be made.
 * - `planning_ungated` — the directory exists and the policy gate would not install into
 *   it. A round is refused rather than run ungated, exactly as a worker is.
 * - `target_unavailable`, `store_unavailable` — the target's database.
 * - `unknown_round` — nothing is running under that id *in this process*.
 *
 * **A briefing over the ceiling is not in this list.** It comes back as the
 * `GoalBriefingRefused` the briefing panel already renders, with the two numbers on it,
 * because "this goal's brief is too large" is one fact and a second spelling of it would
 * be a second thing for a client to learn.
 *
 * `409` because every reason is a conflict with the current state of the goal, the
 * process or the installation rather than a malformed request: the route has no payload
 * to get wrong.
 */
export class PlanRefused extends Schema.TaggedError<PlanRefused>()(
  "PlanRefused",
  {
    reason: Schema.Literals([
      "no_harness",
      "harness_not_ready",
      "harness_unreachable",
      "goal_busy",
      "round_conflict",
      "goal_not_found",
      "goal_not_active",
      "planning_directory_unusable",
      "planning_ungated",
      "target_unavailable",
      "store_unavailable",
      "unknown_round",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/** What a started round answers with. */
export const PlanRoundStarted = Schema.Struct({
  roundId: Schema.String,
  targetId: Schema.String,
  goalId: Schema.String,
  harnessSessionId: Schema.String,
  instanceId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  /** The budget written on the row, which `add_intent` enforces. */
  budget: Schema.Int,
  /** Provenance only; never a snapshot guarantee. */
  startedAtSequence: Schema.Number,
  /**
   * Whether this round opened the goal's planner lineage or joined one.
   *
   * Reported because it is the one thing about a round a caller cannot work out: the
   * lineage is a hint in our own table about a session in the harness's storage, and
   * "this is the goal's first round" and "this round continues an earlier one's session"
   * are different facts about what the model has already seen.
   */
  lineage: Schema.Literals(["opened", "continued"]),
  /**
   * The rendered goal briefing's length, in characters — the number the ceiling bounds.
   *
   * The same figure `GoalBriefingView.sizeChars` carries, repeated here so a client that
   * started a round knows which briefing it was started on without a second read.
   */
  briefingChars: Schema.Int,
  /**
   * The length of the whole prompt actually sent, in characters.
   *
   * **This is larger than {@link briefingChars} and that difference is the point.** The
   * ceiling measures the briefing; the prompt wraps it in the round's framing and the
   * goal's objective, so the number an operator watched against the ceiling is not the
   * size of what the model received. Both are reported so neither has to be inferred.
   */
  promptChars: Schema.Int,
  startedAt: EpochMillis,
});
export type PlanRoundStarted = typeof PlanRoundStarted.Type;

/**
 * One round this process is driving right now.
 *
 * **In this process**, which is the whole reason it is a separate shape from
 * {@link PlanRoundView}. A row that says `running` and a round that is actually being
 * supervised are different claims: a row left behind by a process that died is the first
 * without the second, and it is the startup sweep rather than a stop control that settles
 * it. A client that wants to know whether pressing "Plan next" will be refused
 * `goal_busy` has to ask this; a client that wants to know what a goal's rounds concluded
 * reads the rows.
 */
export const RunningRound = Schema.Struct({
  roundId: Schema.String,
  targetId: Schema.String,
  goalId: Schema.String,
  harnessSessionId: Schema.String,
  startedAt: EpochMillis,
});
export type RunningRound = typeof RunningRound.Type;

/**
 * One planner round as a browser reads it, from the row.
 *
 * `disposition` is null until the round records one, and null is a fact of its own: it
 * means the round concluded nothing, which is different from every one of the four
 * answers — including `no_useful_next_action`, which is a planner's considered judgement
 * rather than an absence.
 *
 * `intentsAdded` is how many intents this round committed, counted from the round's own
 * command receipts. It is what the budget is spent against, so a reader can see a round
 * that stopped because it ran out rather than because it had nothing more to say.
 */
export const PlanRoundView = Schema.Struct({
  roundId: Schema.String,
  goalId: Schema.String,
  targetId: Schema.String,
  status: RoundStatus,
  disposition: Schema.NullOr(RoundDisposition),
  /** Why, in the planner's own words. Null when no disposition was recorded. */
  dispositionRationale: Schema.NullOr(Schema.String),
  /** How many intents this round may add in total. */
  budget: Schema.Int,
  /** How many it has added. Never more than {@link budget}. */
  intentsAdded: Schema.Int,
  /** Null for a round that never reached a harness. */
  harnessSessionId: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.String),
  providerId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  /** Provenance only; never a snapshot guarantee. */
  startedAtSequence: Schema.Number,
  startedAt: EpochMillis,
  /** When it settled. Null while `running`, and only then. */
  endedAt: Schema.NullOr(EpochMillis),
});
export type PlanRoundView = typeof PlanRoundView.Type;
