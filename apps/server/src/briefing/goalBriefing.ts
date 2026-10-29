/**
 * The goal briefing: one planner round's whole input, at 100%.
 *
 * `briefing.ts` builds the **intent**-scoped briefing a worker session gets, and its
 * header is the reasoning this file inherits: everything is read from the store at a
 * recorded sequence and nothing from a previous transcript; omissions are disclosed by id
 * so a reader can tell "the graph does not know this" from "this briefing left it out";
 * the two record formats are rendered differently rather than smoothed together, because
 * manufacturing actors and per-action counts out of summary prose would be fabrication.
 * An observation is rendered here by that file's own {@link observationBody}, so the two
 * briefings show one observation one way.
 *
 * **What is deliberately not inherited is the selection.** An intent briefing is bounded:
 * it takes the newest `limit` observations, lists what it dropped and sets `truncated`. A
 * goal briefing selects nothing (the spec's decision 11). Every intent of the goal and
 * every observation under all of them is here in full, and above the configured ceiling
 * the build **refuses** rather than returning a shorter brief — a planner reasoning from a
 * gap it cannot see is the one failure a briefing cannot disclose its way out of. So this
 * is a sibling of that module rather than a mode of it: one function answering both would
 * hide that their selection rules are opposites.
 *
 * **The stable prefix holds unconditionally here.** `briefing.ts` documents the property
 * with a caveat — it holds only while the truncation window has room, because the oldest
 * included observation drops out past the limit and rewrites the stable part from its
 * first block. Nothing is ever evicted from a goal briefing, so that caveat is gone. Two
 * things make it hold from the empty goal onward, and both are load-bearing:
 *
 * - Observations are rendered ascending by sequence, and a new observation always takes a
 *   higher sequence than every existing one, so a block is only ever appended.
 * - Everything that changes — the graph sequence, the counts, the completeness claim, the
 *   intents and their statuses, the open questions and theirs — sits below
 *   {@link PREPARATION_HEADING}. **The intent list is in that tail on purpose**, even
 *   though an intent reads like part of the goal's framing: an intent's status moves
 *   `open` → `claimed` → `answered`, and a status printed above the observations would
 *   rewrite every byte after it each time a run started.
 *
 * The one thing the empty case does *not* do is say "none recorded yet" under the
 * observations heading, which is what the intent briefing does there. That line would be
 * replaced by the first observation's block and so would break the property at exactly
 * the transition a new goal makes first. The emptiness is reported in the tail instead,
 * where the counts already live.
 *
 * The property's value is `briefing.ts`'s: a reader diffing two briefings sees only what
 * was added, and a provider that does prefix caching can reuse what it has already been
 * sent. And it says nothing about the tail, which is *supposed* to change — an intent
 * being claimed, or a question moving from `uninvestigated` to addressed, is exactly what
 * a planner is reading for.
 */
import {
  type GoalBriefing,
  type GoalBriefingIntent,
  type Observation,
} from "@bit/contracts";
import { Effect, Schema } from "effect";

import {
  PREPARATION_HEADING,
  observationBody,
  openQuestionsOf,
  renderOpenQuestions,
} from "./briefing";
import { ObservationStore, type StoredIntent } from "../persistence/store";

/**
 * The default ceiling on a rendered goal briefing, in characters.
 *
 * `main.ts` reads `GOAL_BRIEFING_MAX_CHARS` over it, with the default documented beside
 * that read. 320 000 characters is a starting point rather than a finding: it is roughly
 * the order of a long-context window once a character is taken as a fraction of a token,
 * and it is set where a brief that large is a signal about the goal rather than a limit
 * anybody is expected to hit.
 *
 * **Characters, not tokens, and that is an approximation stated as one.** No tokenizer is
 * available on this seam — the brief is built here and tokenised inside whichever provider
 * the round's harness is pointed at, under a vocabulary this process does not have. A
 * character budget is honest about being an estimate; a "token" count computed from a
 * guessed ratio would be an estimate wearing a precise name.
 */
export const DEFAULT_GOAL_BRIEFING_MAX_CHARS = 320_000;

/**
 * No goal to build a briefing for.
 *
 * Tagged and distinct from the store's own failures, for `BriefingError`'s reason: "this
 * goal does not exist" is a different thing for a caller to handle than "SQLite is
 * unavailable" or "a stored row no longer decodes". One reason today, in a literal union
 * so a second one is an additive change.
 */
export class GoalBriefingError extends Schema.TaggedError<GoalBriefingError>()(
  "GoalBriefingError",
  { reason: Schema.Literals(["unknown_goal"]), goalId: Schema.String },
) {
  override get message(): string {
    return `${this.reason}: ${this.goalId}`;
  }
}

/**
 * The goal's briefing would exceed the ceiling, so none was built.
 *
 * Its own error rather than a reason on {@link GoalBriefingError} because it carries two
 * numbers that the other has no meaning for. Both are on it deliberately: a refusal that
 * said only "too large" would leave an operator with no way to tell a goal that is twice
 * the ceiling from one that is a hundred characters over.
 *
 * **Nothing partial comes back with it.** The briefing was rendered in full to measure it
 * and is then discarded; a caller cannot reach a shortened version of it through this
 * error, because a shortened brief is the thing ruling 3 exists to prevent.
 */
export class GoalBriefingTooLarge extends Schema.TaggedError<GoalBriefingTooLarge>()(
  "GoalBriefingTooLarge",
  {
    goalId: Schema.String,
    /** The rendered length, in characters. */
    sizeChars: Schema.Int,
    /** The ceiling in force when it was measured. */
    maxChars: Schema.Int,
  },
) {
  override get message(): string {
    return `goal briefing for ${this.goalId} is ${String(this.sizeChars)} characters, over the ${String(this.maxChars)}-character ceiling`;
  }
}

/**
 * A built briefing and the exact text it renders to.
 *
 * Both, because rendering 300 000 characters a second time to recover either half would be
 * wasteful: a planner round is prompted with `rendered`, and the structure is what a
 * host-side reader takes its scalars and provenance from. **The browser is not one of those
 * readers** — `GoalBriefingView` deliberately does not put the structured briefing on the
 * wire, so the route maps the few fields a panel has to check and ships `rendered`.
 *
 * The two halves cannot disagree: `rendered.length === briefing.sizeChars` and
 * `renderGoalBriefing(briefing) === rendered`, both asserted in this module's tests.
 */
export interface PreparedGoalBriefing {
  readonly briefing: GoalBriefing;
  /** The text a planner round receives, rendered once. */
  readonly rendered: string;
}

const briefingIntent = (intent: StoredIntent): GoalBriefingIntent => ({
  intentId: intent.intentId,
  question: intent.question,
  status: intent.status,
  anchoredTo: intent.anchoredTo,
  addressesDimension: intent.addressesDimension,
});

/**
 * Builds the briefing for one goal, or refuses.
 *
 * `maxChars` is the ceiling, defaulting to {@link DEFAULT_GOAL_BRIEFING_MAX_CHARS};
 * `main.ts` passes what `GOAL_BRIEFING_MAX_CHARS` says. The order of operations is the
 * ruling: assemble everything, render it, measure the text, and only then decide whether
 * to hand it over. There is no path on which a brief over the ceiling is shortened and
 * returned, and no path on which one under it is missing an observation.
 *
 * The four goal-scoped store reads are each one statement over the whole goal rather than
 * the `*ForIntent` reads in a loop. **That is an assembly choice, not a correctness one**:
 * those siblings select by the raising side too, so concatenating them over a goal would
 * find the same rows, including a dimension declared by a sibling intent. What this buys is
 * four statements instead of N + 1, one ascending sequence instead of N groups, and one
 * `openQuestionsOf` pass over a complete set instead of a merge in the caller — the block
 * comment above those reads in `persistence/store.ts` sets it out.
 *
 * **It does not check which target the goal belongs to, and does not claim to.** A goal id
 * is resolved against whichever file the `ObservationStore` in context has open, and the
 * briefing reports the `target_id` the row carries. Deciding that a request may read this
 * goal is the caller's: `http/browserApi.ts` compares the row's target against the one it
 * opened and answers `GoalNotFound` otherwise, which is what the sibling goal routes do.
 *
 * `openQuestionsOf` is shared with the intent briefing and needs nothing special here:
 * its `includedIds` defaults to every observation it was handed, which for a goal briefing
 * is every observation the goal has. So `includedInBriefing` is true for all of them, and
 * false only for an addressing observation from outside the goal — which is the honest
 * answer, since that observation's record genuinely is not below.
 */
export const buildGoalBriefing = Effect.fn("buildGoalBriefing")(function* (
  goalId: string,
  maxChars = DEFAULT_GOAL_BRIEFING_MAX_CHARS,
) {
  const store = yield* ObservationStore;
  const goal = yield* store.loadGoal(goalId);
  if (goal === undefined) {
    return yield* new GoalBriefingError({ reason: "unknown_goal", goalId });
  }
  const intents = yield* store.intentsForGoal(goalId);
  const all = yield* store.observationsForGoal(goalId);
  const dimensions = yield* store.dimensionsForGoal(goalId);
  const links = yield* store.dimensionLinksForGoal(goalId);
  const schedules = yield* store.dimensionSchedulesForGoal(goalId);
  const sequence = yield* store.currentSequence;

  // The query already orders by sequence; sorted again here so that "ascending by
  // sequence", which is what makes a later briefing an extension of an earlier one, is a
  // property of this module rather than of a statement somebody could reorder.
  const observations = [...all].sort(
    (a: Observation, b: Observation) => a.sequence - b.sequence,
  );

  const draft: GoalBriefing = {
    targetId: goal.targetId,
    goalId: goal.goalId,
    name: goal.name,
    description: goal.description,
    preparedAtSequence: sequence,
    intents: intents.map(briefingIntent),
    observations,
    // Constant, and kept as a checkable claim rather than dropped. See the contract.
    omittedObservationIds: [],
    truncated: false,
    openQuestions: openQuestionsOf(observations, dimensions, links, schedules),
    // Replaced below with the measured length. `renderGoalBriefing` does not read it —
    // see its note — so rendering the draft gives the same text as rendering the result.
    sizeChars: 0,
  };

  const rendered = renderGoalBriefing(draft);
  const sizeChars = rendered.length;
  if (sizeChars > maxChars) {
    return yield* new GoalBriefingTooLarge({ goalId, sizeChars, maxChars });
  }
  return {
    briefing: { ...draft, sizeChars },
    rendered,
  } satisfies PreparedGoalBriefing;
});

/**
 * Renders a goal briefing as the text a planner round receives.
 *
 * **`sizeChars` is not read.** A number describing the length of the text it sits inside
 * would be its own fixed point, and it would also move every byte after it on each write,
 * which is the whole of what prefix stability costs to lose. The size travels beside the
 * text — on the briefing and in the panel — rather than in it. The consequence worth
 * stating: this function is a pure function of everything *except* `sizeChars`, so
 * `renderGoalBriefing(draft).length` is the size of the finished briefing.
 *
 * Counts are not summarised into a verdict, for `renderBriefing`'s reason: one negative
 * observation must not read as "this goal is settled" (DECISIONS.md §4).
 */
export const renderGoalBriefing = (briefing: GoalBriefing): string => {
  // Nothing above the first observation block may depend on how much has been recorded.
  // The four values printed here are the goal's own and are never updated after it is
  // created; a count or a sequence number here would change on every write.
  const lines: string[] = [
    `# Planner briefing`,
    ``,
    `This is the complete record of one goal: every intent created under it and every`,
    `observation recorded under those intents, in full. There is no prior conversation to`,
    `consult, and nothing below the ceiling has been left out — see the preparation status`,
    `for the claim in a form you can check.`,
    ``,
    `Target: ${briefing.targetId}`,
    `Goal: ${briefing.goalId}`,
    `Name: ${briefing.name === "" ? "(none given)" : briefing.name}`,
    `Objective (the broad aim, NOT settled by any single observation below):`,
    `  ${briefing.description}`,
    ``,
    `## Recorded observations across this goal, oldest first`,
  ];

  // No "none recorded yet" line here, deliberately: see this module's header. An empty
  // goal says so in the tail, where a statement about how much exists belongs.
  for (const observation of briefing.observations) {
    lines.push(
      ``,
      `### ${observation.observationId} (sequence ${observation.sequence}, under intent ${observation.provenance.intentId})`,
      ...observationBody(observation),
    );
  }

  // Everything from here down restates the whole record, or a status that moves, and
  // therefore changes whenever anything happens. It is last so that what precedes it does
  // not.
  lines.push(
    ``,
    PREPARATION_HEADING,
    `Prepared from control-plane state at graph sequence ${briefing.preparedAtSequence}.`,
    `This is a provenance marker, not a snapshot: the graph can be read again and may`,
    `have moved on.`,
    ``,
    `Observations above: ${String(briefing.observations.length)}. Omitted: ${String(
      briefing.omittedObservationIds.length,
    )}. Truncated: ${briefing.truncated ? "yes" : "no"}.`,
    `A goal briefing omits nothing, so the omitted count is zero and the omission list is`,
    `empty. That empty list is the checkable form of the claim that nothing was dropped.`,
  );

  if (briefing.observations.length === 0) {
    lines.push(
      ``,
      `Nothing has been recorded under this goal yet. The graph knows the objective and`,
      `${briefing.intents.length === 0 ? "no intents" : "the intents listed below"}, and`,
      `no evidence at all: there is no earlier finding to build on, so anything proposed`,
      `here is a first direction rather than a follow-up.`,
    );
  }

  lines.push(``, ...renderIntents(briefing.intents));
  lines.push(``, ...renderOpenQuestions(briefing.openQuestions));

  return lines.join("\n");
};

const INTENT_STATUS_NOTES: Readonly<
  Record<GoalBriefingIntent["status"], string>
> = {
  proposed: "suggested and not yet accepted",
  open: "nothing is working it; a run may claim it",
  claimed: "a run holds it right now",
  answered: "an attempt succeeded and left at least one observation under it",
  abandoned: "an operator dropped it",
};

/**
 * Renders the goal's intents, each with the state of its own work.
 *
 * In the volatile tail rather than above the observations, because a status moves — see
 * this module's header for what that would cost.
 *
 * The statuses are spelled out rather than listed as bare words. An intent that is
 * `answered` is not a question that is settled: it means one attempt succeeded and
 * recorded something, and whether that something answers the question is a judgement
 * nothing here makes. The same distinction `addressedWithEvidence` carries in the open
 * questions below.
 */
const renderIntents = (
  intents: readonly GoalBriefingIntent[],
): readonly string[] => {
  if (intents.length === 0) {
    return [`## Intents already under this goal`, ``, `- none created yet`];
  }
  const lines: string[] = [
    `## Intents already under this goal (${String(intents.length)})`,
    ``,
    `Every direction that has already been created here, oldest first, including the ones`,
    `that are finished or were dropped. A terminal status is not a settled question: an`,
    `\`answered\` intent is one whose attempt succeeded and recorded something, and whether`,
    `that something answers it is a judgement nothing in this system makes.`,
  ];
  for (const intent of intents) {
    lines.push(
      ``,
      `- [${intent.status}] ${intent.intentId} — ${INTENT_STATUS_NOTES[intent.status]}`,
      `  ${intent.question}`,
      `  anchored to: ${intent.anchoredTo.length === 0 ? "nothing (a top-level direction)" : intent.anchoredTo.join(", ")}`,
      `  addresses: ${intent.addressesDimension ?? "no recorded dimension"}`,
    );
  }
  return lines;
};
