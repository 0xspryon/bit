/**
 * The deterministic briefing contract (DECISIONS.md §17 lines 1631-1639).
 *
 * A briefing is rendered from control-plane state at a recorded graph sequence, not
 * from a previous session's transcript. Absent content must never imply absent graph
 * knowledge, so omissions are disclosed explicitly rather than silently truncated.
 *
 * Browser-safe: Effect Schema only.
 */
import { Schema } from "effect";

import { IntentStatus } from "./intent";
import { Observation, ObservationOutcome } from "./observation";

/**
 * How far a recorded untested dimension has actually been taken.
 *
 * - `uninvestigated` — nothing has been recorded against this dimension, and no intent
 *   that declared it still has work outstanding.
 * - `scheduled` — an intent declared this dimension as the one it addresses, and no
 *   addressing observation has landed yet. This says work is *out* for the question, as
 *   distinct from nobody having looked at it.
 * - `addressedInconclusive` — one or more later observations named this dimension, and
 *   every one of them came back `inconclusive`. Work happened; it decided nothing.
 * - `addressedWithEvidence` — at least one later observation named this dimension and
 *   reached `positive` or `negative` relative to its own tested claim.
 *
 * **`scheduled` is not a state a question can enter and never leave.** Once every
 * attempt on every intent that declared it has settled with no addressing observation,
 * it falls back to `uninvestigated` — carrying, in `scheduledBy`, the record that
 * somebody tried (DECISIONS.md §17, "`scheduled` must not become §22's
 * forever-`uncertain`").
 *
 * **`addressedWithEvidence` is not `resolved`, and there is deliberately no such
 * value.** These four say what has been *recorded against* a question. Deciding that a
 * question is settled is a disposition somebody has to take, and nothing in this
 * codebase takes it: there is no finding subsystem, no approval workflow and no
 * closure authority here. A planner reading `addressedWithEvidence` still has to read
 * the observation and judge.
 */
export const FollowUpStatus = Schema.Literals([
  "uninvestigated",
  "scheduled",
  "addressedInconclusive",
  "addressedWithEvidence",
]);
export type FollowUpStatus = typeof FollowUpStatus.Type;

/**
 * An intent that declared it addresses one dimension, and whether its work is done.
 *
 * `addresses_dimension` is stated by whoever creates the intent and recorded as lineage
 * (migration `0009`). It is what makes `scheduled` derivable rather than a stored flag,
 * and it is also what lets a planner answer a dimension with a *new* intent instead of
 * another attempt on the raising one.
 *
 * `attemptsOpen` is the honest half. An intent that declared a dimension and whose every
 * attempt has since settled without recording an addressing observation has *tried*, and
 * the question is open again; this field is how a reader tells that apart from work still
 * running. `attemptsTotal` of zero with `attemptsOpen` true is an intent nothing has been
 * dispatched for yet.
 */
export const DimensionSchedule = Schema.Struct({
  intentId: Schema.String,
  question: Schema.String,
  /**
   * Whether any work on this intent could still produce an addressing observation:
   * true while an attempt is `running` or `uncertain`, and true for an intent that has
   * no attempt yet because nothing has been dispatched for it.
   */
  attemptsOpen: Schema.Boolean,
  attemptsTotal: Schema.Int,
});
export type DimensionSchedule = typeof DimensionSchedule.Type;

/**
 * One observation named in a follow-up relationship, with enough of itself to be
 * judged without a second lookup.
 *
 * `includedInBriefing` is the honest part: a question can be raised or addressed by an
 * observation that this briefing truncated, and a reader has to be able to tell that
 * apart from an observation it can read in full above.
 */
export const ObservationReference = Schema.Struct({
  observationId: Schema.String,
  sequence: Schema.Int,
  outcome: ObservationOutcome,
  /** Whether this briefing carries that observation's full record. */
  includedInBriefing: Schema.Boolean,
});
export type ObservationReference = typeof ObservationReference.Type;

/**
 * One addressable open question: a dimension some observation recorded as untested,
 * plus whatever has since been recorded against it.
 *
 * The `address` is the whole point. Before this, an untested dimension was free text
 * that reappeared in every briefing forever with no way for a later observation to say
 * "this one, I took this on" — so progress on it could only ever be guessed at by
 * matching words. A later observation names the address, the write boundary checks the
 * address exists and belongs to the same intent, and the link is recorded. Nothing is
 * matched fuzzily and nothing is inferred from wording.
 */
export const OpenQuestion = Schema.Struct({
  /** Stable address, built by `dimensionAddress` from the raising row and position. */
  address: Schema.String,
  /** The recorded sentence, verbatim. */
  dimension: Schema.String,
  /** The observation that recorded this dimension as untested. */
  raisedBy: ObservationReference,
  status: FollowUpStatus,
  /** Later observations that explicitly named this address, oldest first. */
  addressedBy: Schema.Array(ObservationReference),
  /**
   * Intents that declared they address this dimension, oldest first.
   *
   * Non-empty with `status: "uninvestigated"` means somebody tried and the question
   * came back open, which is not the same fact as nobody having looked.
   */
  scheduledBy: Schema.Array(DimensionSchedule),
});
export type OpenQuestion = typeof OpenQuestion.Type;

export const Briefing = Schema.Struct({
  targetId: Schema.String,
  intentId: Schema.String,
  /** The broad objective. Finishing a slice does not settle it. */
  goal: Schema.String,
  /** The actionable investigation direction under that goal. */
  intent: Schema.String,
  /** The graph sequence this briefing was prepared at. */
  preparedAtSequence: Schema.Number,
  /**
   * Bounded observations included in full, **oldest first**.
   *
   * Which ones are included is decided newest-first, because a later observation
   * qualifies an earlier one and that is what survives truncation; the order they are
   * then listed in is ascending by sequence, so a briefing built after another
   * observation lands reads as the same record with one more entry rather than as a
   * reshuffled one.
   */
  observations: Schema.Array(Observation),
  /**
   * Observation IDs known to the graph but omitted from this briefing, so a reader
   * can tell truncation from absence of knowledge. Oldest first, like `observations`.
   */
  omittedObservationIds: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  /**
   * Every untested dimension recorded under this intent, addressed or not.
   *
   * Computed across **all** of the intent's observations rather than only the included
   * ones, because truncating the body must not drop a question: an omitted
   * observation's dimensions stay here, marked as raised by an observation this
   * briefing did not carry. They are not deduplicated by text — two observations that
   * record the same sentence recorded two separate questions, and collapsing them
   * would be exactly the fuzzy matching addresses exist to avoid.
   */
  openQuestions: Schema.Array(OpenQuestion),
});
export type Briefing = typeof Briefing.Type;

/* ── The goal briefing ───────────────────────────────────────────────────────── */

/**
 * One intent of the goal, as the briefing carries it.
 *
 * Deliberately not `IntentView`: that one is a screen's row and carries counts, a
 * suggestion and a claim holder. This is what a planner needs to know about a direction
 * that already exists — what it asks, how far it has got, what evidence it hangs off, and
 * which open question it was created to answer — so a round does not propose a direction
 * the goal is already carrying.
 *
 * `addressesDimension` is the wire alias, the same string {@link OpenQuestion.address}
 * prints, so the two can be matched by identity rather than by wording.
 */
export const GoalBriefingIntent = Schema.Struct({
  intentId: Schema.String,
  /** The actionable direction, verbatim. */
  question: Schema.String,
  status: IntentStatus,
  /** Observation ids this intent was anchored to, in the order they were given. */
  anchoredTo: Schema.Array(Schema.String),
  /** The dimension alias this intent declared it addresses, or null for none. */
  addressesDimension: Schema.NullOr(Schema.String),
});
export type GoalBriefingIntent = typeof GoalBriefingIntent.Type;

/**
 * Everything one goal holds, as a planner round's input (the spec's decision 11).
 *
 * **This is not {@link Briefing} with a different key, and the difference is the
 * selection.** An intent briefing is bounded: it selects newest-first up to a limit,
 * lists what it dropped in `omittedObservationIds`, and sets `truncated`. A goal briefing
 * selects nothing. Every intent of the goal and every observation under all of them is
 * here in full, because a planner choosing the goal's next direction is reasoning about
 * the shape of the whole record and a gap it cannot see would be the one thing it could
 * not account for. Above the configured ceiling the server refuses to build one at all
 * rather than shortening it.
 *
 * `omittedObservationIds` and `truncated` are therefore constant — `[]` and `false`. They
 * are kept rather than dropped because a constant is a claim that can be checked: an
 * empty list says "nothing was dropped" in a form a test and a reader can both verify,
 * where an absent field would make completeness unfalsifiable. Nothing in this codebase
 * sets either to anything else.
 */
export const GoalBriefing = Schema.Struct({
  targetId: Schema.String,
  goalId: Schema.String,
  /** The goal's short label, or `""` when the operator gave none. */
  name: Schema.String,
  /** The objective, in the operator's words. Not settled by any observation below. */
  description: Schema.String,
  /** The graph sequence this briefing was prepared at. Provenance, not a snapshot. */
  preparedAtSequence: Schema.Number,
  /** Every intent under the goal, oldest first, including settled and abandoned ones. */
  intents: Schema.Array(GoalBriefingIntent),
  /**
   * Every observation under every intent of the goal, **ascending by sequence**.
   *
   * One ascending list across the goal rather than per-intent groups: the sequence is the
   * target's own write order, so this is the order the evidence was recorded in, and a
   * briefing built after one more observation lands is this list with one entry appended.
   * Which intent each belongs to is on its own provenance.
   */
  observations: Schema.Array(Observation),
  /**
   * Always empty, and kept for that reason.
   *
   * A goal briefing omits nothing below the ceiling, so there is never an id to put here.
   * The field stays because an empty list is a *checkable* claim that nothing was
   * dropped: a reader and a test can both assert it, where an absent field would make
   * "complete" unfalsifiable. Above the ceiling nothing is returned at all, so this is
   * never a partial disclosure of a shortened brief.
   */
  omittedObservationIds: Schema.Array(Schema.String),
  /** Always false, kept for the same reason {@link omittedObservationIds} is. */
  truncated: Schema.Boolean,
  /**
   * Every untested dimension raised anywhere under the goal, with its state derived from
   * the whole goal.
   *
   * One row per dimension *identity*, across every intent of the goal. A dimension raised
   * under one intent and declared by a sibling intent of the same goal is `scheduled` here
   * — as it also is in that intent's own {@link Briefing}, which derives the same answer
   * from the same stored declaration. What is different is the scope of the list: this one
   * holds every dimension the goal has raised, grouped in one pass, where N intent
   * briefings hold N partial lists.
   *
   * Nothing is collapsed by wording: two observations that recorded the same sentence
   * recorded two dimensions and stay two rows, exactly as in
   * {@link Briefing.openQuestions}. The de-duplication is on dimension id and nothing
   * else, which is what `addresses_dimension` exists to make possible.
   */
  openQuestions: Schema.Array(OpenQuestion),
  /**
   * How many characters the rendered briefing is.
   *
   * Carried so the operator watches the brief grow towards the ceiling instead of
   * discovering the wall when a round is refused. It is the length of the rendered text
   * and **not** printed inside it: a number that described the text it sits in would both
   * be its own fixed point and move every byte after it on each write, which is what
   * prefix stability costs to lose.
   *
   * Characters, not tokens, because no tokenizer exists on this seam. A character count is
   * an approximation of what a model will be charged for, and it is the honest kind: it is
   * visibly not a token count rather than a token count that is quietly wrong.
   */
  sizeChars: Schema.Int,
});
export type GoalBriefing = typeof GoalBriefing.Type;
