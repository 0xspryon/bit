/**
 * Deterministic briefing rendering (DECISIONS.md §17 "deterministic briefing selection").
 *
 * Everything here is read from the store at a recorded sequence. No part of a previous
 * session's transcript, and no model-generated digest, is involved — the point of the
 * fresh-session proof is that knowledge survives in the graph, not in a conversation.
 *
 * Omissions are disclosed by ID so a reader can distinguish "the graph does not know
 * this" from "this briefing did not include it".
 *
 * Two record formats are rendered, and the difference is shown rather than smoothed
 * over. A case-based observation renders its cases, each with its actors, ownership facts
 * and ordered actions. A summary-format observation renders its flattened conditions and
 * prose under an explicit format heading, because manufacturing actors and per-action
 * counts out of that prose would be fabrication (DECISIONS.md §21). A reader is told
 * which they are looking at.
 */
import type {
  Briefing,
  CaseBasedObservation,
  Observation,
  ObservationTestCase,
  SummaryObservation,
} from "@bit/contracts";
import { Effect, Schema } from "effect";

import { ObservationStore } from "../persistence/store";

/**
 * A briefing that cannot be built.
 *
 * Tagged, and distinct from the store's own failures: "this intent does not exist" is
 * a different thing for a caller to handle than "SQLite is unavailable" or "a stored
 * row no longer decodes". The previous `Effect<Briefing, Error>` erased all three into
 * one unusable channel.
 */
export class BriefingError extends Schema.TaggedError<BriefingError>()(
  "BriefingError",
  { reason: Schema.Literals(["unknown_intent"]), intentId: Schema.String },
) {
  override get message(): string {
    return `${this.reason}: ${this.intentId}`;
  }
}

/**
 * Builds a briefing for one intent.
 *
 * `limit` caps included observations; anything dropped is listed in
 * `omittedObservationIds` and flips `truncated`.
 */
export const buildBriefing = Effect.fn("buildBriefing")(function* (
  intentId: string,
  limit = 20,
) {
  const store = yield* ObservationStore;
  const intent = yield* store.loadIntent(intentId);
  if (intent === undefined) {
    return yield* new BriefingError({ reason: "unknown_intent", intentId });
  }
  const all = yield* store.observationsForIntent(intentId);
  const sequence = yield* store.currentSequence;

  // Most recent first: a later observation qualifies an earlier one, so when a
  // briefing must truncate, the qualifying evidence is what a planner needs most.
  const ordered = [...all].sort((a, b) => b.sequence - a.sequence);
  const included = ordered.slice(0, limit);
  const omitted = ordered.slice(limit);

  return {
    targetId: intent.targetId,
    intentId: intent.intentId,
    goal: intent.goal,
    intent: intent.question,
    preparedAtSequence: sequence,
    observations: included,
    omittedObservationIds: omitted.map((item) => item.observationId),
    truncated: omitted.length > 0,
    openQuestions: openQuestionsOf(included),
  } satisfies Briefing;
});

/** Untested dimensions across the included observations, deduplicated, order stable. */
export const openQuestionsOf = (
  observations: readonly Observation[],
): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const observation of observations) {
    for (const dimension of observation.untestedDimensions) {
      if (seen.has(dimension)) continue;
      seen.add(dimension);
      result.push(dimension);
    }
  }
  return result;
};

const list = (values: readonly string[], fallback = "none recorded"): string =>
  values.length > 0 ? values.join("; ") : fallback;

const window = (start: number, end: number): string =>
  `${new Date(start).toISOString()} .. ${new Date(end).toISOString()}`;

/**
 * Renders one case: who acted, what they owned, and what each step actually saw.
 *
 * Actions are numbered in the order they were performed and each names its actor, so
 * the association between an identity, an endpoint and a response cannot be lost the
 * way it was when one observation had a single `clientIdentity` string.
 */
const renderTestCase = (testCase: ObservationTestCase): readonly string[] => {
  const lines: string[] = [
    ``,
    `  case ${testCase.id}: ${testCase.purpose}`,
    `    configuration: ${testCase.configuration}`,
    `    window: ${window(testCase.windowStart, testCase.windowEnd)}`,
    `    test bounds: ${testCase.testBounds}`,
    `    actors:`,
  ];
  for (const actor of testCase.actors) {
    lines.push(
      `      ${actor.id}: account=${actor.account ?? "none (unauthenticated)"}` +
        ` role=${actor.role ?? "unknown/not applicable"}` +
        ` identified by ${actor.clientIdentity}`,
    );
  }
  if (testCase.relationships.length > 0) {
    lines.push(`    relationships:`);
    for (const relationship of testCase.relationships) {
      lines.push(
        `      ${relationship.subject} --${relationship.relation}--> ${relationship.object}`,
      );
    }
  }
  lines.push(`    actions, in the order performed:`);
  testCase.actions.forEach((action, index) => {
    lines.push(
      `      ${index + 1}. [${action.actorId}] ${action.method} ${action.endpoint}` +
        ` (${action.requestCount} request${action.requestCount === 1 ? "" : "s"})`,
      `         did: ${action.description}`,
      `         observed: ${action.observedBehavior}`,
    );
    if (action.evidenceRefs.length > 0) {
      lines.push(`         evidence: ${action.evidenceRefs.join(", ")}`);
    }
  });
  lines.push(`    case limitations: ${list(testCase.limitations)}`);
  return lines;
};

/**
 * Renders a case-based observation: the arrangement its cases share, then each case.
 *
 * This is the `caseBased` arm of the union, paired with {@link renderSummary}; the two
 * are what `renderBriefing` dispatches between. Only `setup` and the case count live
 * here, because they are the observation's, not any one case's — the interior of a case
 * is {@link renderTestCase}.
 */
const renderCaseBased = (
  observation: CaseBasedObservation,
): readonly string[] => [
  `- setup: ${observation.setup}`,
  `- cases (${observation.cases.length}), each a distinct test of the one claim above:`,
  ...observation.cases.flatMap(renderTestCase),
];

/**
 * Renders a summary-format observation, labelled as such.
 *
 * The label is not decoration. These rows have one `clientIdentity` string that may
 * describe several identities in sequence and one `requestCount` that is a total across
 * all of them, so a reader must not read them as if they were a single-actor case.
 */
const renderSummary = (observation: SummaryObservation): readonly string[] => [
  `- RECORD FORMAT: summary (one prose record, recorded before observations carried cases).`,
  `  Its conditions are a single prose description, which may cover more than one`,
  `  identity, and its request count is one total across all of them. It has not been`,
  `  split into actors or per-step counts, because that allocation was never recorded.`,
  `- conditions:`,
  `    endpoint: ${observation.conditions.endpoint}`,
  `    account: ${observation.conditions.account}`,
  `    client identity: ${observation.conditions.clientIdentity}`,
  `    method: ${observation.conditions.method}`,
  `    configuration: ${observation.conditions.configuration}`,
  `    requests issued (total): ${observation.conditions.requestCount}`,
  `    window: ${window(observation.conditions.windowStart, observation.conditions.windowEnd)}`,
  `- observed behavior: ${observation.observedBehavior}`,
  ...(observation.evidenceRefs.length > 0
    ? [`- evidence refs: ${observation.evidenceRefs.join(", ")}`]
    : []),
];

/**
 * Renders a briefing as the text a fresh session receives.
 *
 * Each observation keeps its tested claim, outcome, cases, bounds and limitations side
 * by side. Counts are deliberately not summarised into a verdict: one negative
 * observation must not read as "this intent is settled" (DECISIONS.md §4).
 */
export const renderBriefing = (briefing: Briefing): string => {
  const lines: string[] = [
    `# Investigation briefing`,
    ``,
    `Prepared from control-plane state at graph sequence ${briefing.preparedAtSequence}.`,
    `This is the complete record for this intent; there is no prior conversation to consult.`,
    ``,
    `Target: ${briefing.targetId}`,
    `Goal (broad objective, NOT settled by any single observation below):`,
    `  ${briefing.goal}`,
    `Intent (the actionable direction): ${briefing.intentId}`,
    `  ${briefing.intent}`,
    ``,
    `## Recorded observations (${briefing.observations.length})`,
  ];

  if (briefing.observations.length === 0) {
    lines.push(``, `None recorded yet.`);
  }

  for (const observation of briefing.observations) {
    lines.push(
      ``,
      `### ${observation.observationId} (sequence ${observation.sequence})`,
      `- outcome: ${observation.outcome} — relative to the tested claim only`,
      `- tested claim: ${observation.testedClaim}`,
      ...(observation._tag === "caseBased"
        ? renderCaseBased(observation)
        : renderSummary(observation)),
      `- worker interpretation (not established fact): ${observation.interpretation}`,
      `- limitations: ${list(observation.limitations)}`,
      `- untested dimensions: ${list(observation.untestedDimensions)}`,
    );
  }

  if (briefing.truncated) {
    lines.push(
      ``,
      `## Disclosed omissions`,
      `This briefing was truncated. The graph also holds these observations, omitted here:`,
      ...briefing.omittedObservationIds.map((id) => `- ${id}`),
      `Their absence above does not mean the graph lacks them.`,
    );
  }

  lines.push(
    ``,
    `## Open questions carried forward`,
    ...(briefing.openQuestions.length > 0
      ? briefing.openQuestions.map((question) => `- ${question}`)
      : [`- none recorded`]),
  );

  return lines.join("\n");
};
