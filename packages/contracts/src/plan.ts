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
 * `PlanRoundStopped` is still absent, and now for a different reason. The planner view has
 * arrived and brought its stop control with it, and that route answers with the round's
 * own {@link PlanRoundView} — the settled row, re-read — rather than with a shape of its
 * own. The supervisor's `PlanRoundStopped` carries `credentialsRevoked` and
 * `toolCallsSeen`, which are facts about this process's grant bookkeeping and belong in
 * its log; what the browser needs is the row it is about to redraw. So the server shape
 * stays on the server side, and nothing here describes a stop.
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

/**
 * A round this target's rows do not hold.
 *
 * Its own refusal rather than a {@link PlanRefused} with `unknown_round`, because the two
 * are different facts and the planner view does different things about them.
 * `unknown_round` means *this process is not driving it* — which is the ordinary state of
 * every round that has already settled, and of a row a dead process left behind.
 * `RoundNotFound` means the row is not there at all, or belongs to another goal: a request
 * built from the wrong pieces.
 *
 * `404`, for the reason {@link GoalNotFound} is one: the path named something that is not
 * here.
 */
export class RoundNotFound extends Schema.TaggedError<RoundNotFound>()(
  "RoundNotFound",
  {
    targetId: Schema.String,
    goalId: Schema.String,
    roundId: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Where a round's narration came from, or why there is none.
 *
 * **Four answers, and three of them are the ones the planner view must never flatten.**
 * Narration is not persisted (the goal and planner flow's decision 14), so after a refresh
 * the only place a round's prose can come from is the harness's own retention — and "we
 * have not heard anything yet", "the harness has thrown it away" and "this round never
 * said anything" are three different facts about one empty list. A screen that rendered
 * them identically would be reporting a forgotten round as a silent one.
 *
 * - `harness` — the harness answered with messages. Ephemeral: it is the harness's copy
 *   and the harness decides how long to keep it.
 * - `pending` — the round is still `running` and the harness has nothing for it yet. A
 *   normal moment at the start of a round, not an absence.
 * - `forgotten` — the harness no longer holds the session, or cannot be asked about it.
 *   **Not an error**: Claude Code deletes its local transcripts after ~30 days and an
 *   OpenCode session lives in a server process that restarts, so for an older round this
 *   is the expected answer.
 * - `none` — the round genuinely produced no narration: it never reached a harness, or it
 *   settled and the harness still knows the session and holds nothing under it.
 */
export const RoundNarrationSource = Schema.Literals([
  "harness",
  "pending",
  "forgotten",
  "none",
]);
export type RoundNarrationSource = typeof RoundNarrationSource.Type;

/**
 * One replayed message of a round's narration.
 *
 * **The reduced shape, and the reduction is the cost decision 14 accepted.**
 * `AgentHarness.messages` answers `{ type, text, error }` per entry: no call ids, no tool
 * arguments, no pairing between a call and its result. So a replayed round does **not**
 * reconstruct the paired tool blocks a live round shows, and the view has to say so rather
 * than render a thinner transcript as though it were the same thing.
 *
 * `type` is the harness's own word, unmapped — `assistant`, `tool`, `result` — exactly as
 * `TranscriptEntry.type` is, because mapping it would mean inventing a vocabulary over two
 * harnesses that do not share one.
 */
export const RoundNarrationMessage = Schema.Struct({
  /**
   * Position in **this answer**, from zero. A stable key for rendering, and nothing else.
   *
   * **It is not the harness's cursor and it cannot join the live tail**, which an earlier
   * version of this comment claimed and which would have misled anyone building a client
   * against the published shape. `AgentHarness.messages` answers
   * `{ type, text, error }` per entry with no index at all, so the server manufactures this
   * as the array position of what it kept — after the omissions below, which is why it is a
   * position in the answer rather than in the harness's log.
   *
   * The join between a replay and the live tail is therefore **not** by this field. It is by
   * the client's own arrival order: the browser records the in-process narration publish
   * counter before the replay request leaves, and drops live narration at or below it as
   * already replayed (`apps/web/src/lib/app.svelte.ts`). The overlap that leaves is stated
   * rather than hidden — an entry the harness already held when it answered, but which this
   * process published between then and the answer landing, appears in both — and the
   * replayed block is labelled a replay rather than claiming completeness. It cannot be
   * closed from here: `HarnessNarration.sequence` exists on the harness seam and OpenCode
   * populates it from its event store, but that is a different index space from a position
   * in the `messages` array, and Claude Code leaves it unset. There is no index the two
   * channels share.
   */
  index: Schema.Int,
  type: Schema.String,
  text: Schema.String,
  error: Schema.optional(Schema.String),
});
export type RoundNarrationMessage = typeof RoundNarrationMessage.Type;

/**
 * One round's narration as the planner view replays it after a refresh.
 *
 * Paired with the round's own row, never instead of it: the row is where the status and
 * the disposition live, which is the half of a round that *is* durable (decision 16). This
 * is the half that is not.
 */
export const RoundNarration = Schema.Struct({
  roundId: Schema.String,
  /** The harness session this was read from, or null when the round never opened one. */
  harnessSessionId: Schema.NullOr(Schema.String),
  source: RoundNarrationSource,
  /**
   * True only for `harness`: what is shown can disappear.
   *
   * The same flag `AttemptTranscript.ephemeral` carries and for the same reason — a reader
   * must not present a harness's copy and a durable record as the same kind of thing.
   */
  ephemeral: Schema.Boolean,
  /**
   * A sentence for the operator, set on every source including a successful read.
   *
   * Always non-empty. Three of the four sources have no messages at all, and this is the
   * only thing that distinguishes them on screen.
   */
  note: Schema.String,
  messages: Schema.Array(RoundNarrationMessage),
  /** Messages this answer stopped short of. A long round is thousands of entries. */
  truncated: Schema.Boolean,
  /**
   * How many entries were left out because the reduced shape holds nothing to show for them.
   *
   * **A number rather than a row each, and the reason is what a row each actually looked
   * like.** `AgentHarness.messages` reduces every block of a message to `{ type, text,
   * error }`, so a `tool_use` or `tool_result` block becomes an entry with an empty `text`
   * and no error. Rendered as turns, those were 15 of 21 rows on a real settled round: a
   * column of labels saying ASSISTANT and USER with nothing under them, with the round's
   * three actual sentences buried in it. A reader could not tell them from turns in which
   * the planner said nothing, which is a blank presented as content — the opposite of
   * degrading honestly.
   *
   * So they are omitted and counted. The count is what keeps the omission from being
   * silent, and it is also the honest description of what was lost: these are the round's
   * tool calls and results, and the reduced shape has no text, no arguments and no pairing
   * for them. They are in the live rows for a round this tab watched.
   */
  omittedBlank: Schema.Int,
  /**
   * Whether the round's own prompt was left out of the replay.
   *
   * The round's prompt is the goal's objective plus the whole goal briefing, assembled by
   * this server and sent as the session's only user message — thousands of characters. It is
   * both the largest thing on the screen and the one message that is never the planner
   * speaking, and the same bytes are already on the page verbatim in the briefing panel.
   *
   * **Where it appears in a replay is the harness's choice, not a chronology.** Claude Code
   * returns it first; OpenCode returned it *last*, after an `idle` and an `assistant` entry.
   * So the server omits the first `user` entry **wherever it sits** rather than the first
   * entry — which for a round is our prompt by construction, since the operator cannot
   * prompt a round. Only one is dropped, so a steering directive injected later (slice 9)
   * still appears on either driver.
   */
  promptOmitted: Schema.Boolean,
});
export type RoundNarration = typeof RoundNarration.Type;

/**
 * One goal's rounds replayed in a single read, newest round last.
 *
 * **One request for the whole goal rather than one per round, and that is a harness
 * decision rather than a tidiness one.** Each round's prose costs a call into the harness,
 * and a client that fetched them one at a time would either hold a per-round loading state
 * machine — which is a fourth state beside the three above that must stay distinguishable
 * — or leave old rounds in a "not asked yet" limbo that reads exactly like "the harness
 * forgot this". The server asks for all of them and says what each one answered.
 *
 * `skipped` is the honest answer to the budget on that: a goal with a long planning
 * history is not replayed in full, and a view that showed the newest rounds as though they
 * were all of them would be the wrong kind of quiet. The rounds **rows** are not budgeted
 * — they come from `goalRounds` and are cheap — so a skipped round still has its
 * separator, its status and its disposition; only its prose was not asked for.
 */
export const GoalNarrationView = Schema.Struct({
  goalId: Schema.String,
  targetId: Schema.String,
  /** Oldest first, matching the order the chat renders them in. */
  rounds: Schema.Array(RoundNarration),
  /** How many older rounds' narration this answer did not ask the harness for. */
  skipped: Schema.Int,
  at: EpochMillis,
});
export type GoalNarrationView = typeof GoalNarrationView.Type;
