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
 * **A later briefing extends an earlier one.** Observations are selected newest-first
 * and rendered oldest-first, and every line that depends on how much has been recorded
 * — the graph sequence, the counts, the omission list, the open questions and their
 * statuses — sits below {@link PREPARATION_HEADING}. So the text above that heading
 * grows by whole observation blocks and never changes the ones already there: brief
 * `n + 1` starts with brief `n`'s stable part byte for byte ({@link stablePrefixOf}).
 *
 * That is a property worth having for two independent reasons. A reader diffing two
 * briefings sees only what was added, and a harness whose provider does prefix caching
 * can reuse everything it has already sent — which for OpenCode means rounds that share
 * a session lineage, since the lineage is what its cache key is derived from
 * (`SessionAffinity.get` → `promptCacheKey`).
 *
 * Two honest limits. The property holds only while the truncation window has room: once
 * more than `limit` observations exist, the oldest included one drops out and the stable
 * part is rewritten from its first block. And it says nothing about the tail, which is
 * *supposed* to change — a question moving from `uninvestigated` to addressed is exactly
 * what a planner is reading for.
 *
 * Two record formats are rendered, and the difference is shown rather than smoothed
 * over. A case-based observation renders its cases, each with its actors, ownership facts
 * and ordered actions. A summary-format observation renders its flattened conditions and
 * prose under an explicit format heading, because manufacturing actors and per-action
 * counts out of that prose would be fabrication (DECISIONS.md §21). A reader is told
 * which they are looking at.
 */
import {
  dimensionsOf,
  type Briefing,
  type CaseBasedObservation,
  type FollowUpStatus,
  type Observation,
  type ObservationReference,
  type ObservationTestCase,
  type OpenQuestion,
  type SummaryObservation,
} from "@bit/contracts";
import { Effect, Schema } from "effect";

import { ObservationStore, type DimensionLink } from "../persistence/store";

/**
 * The heading that separates the stable part of a rendered briefing from the rest.
 *
 * Named and exported because the separation is a property to be tested, not a layout
 * preference: a count or a sequence number moved above this line silently destroys it.
 */
export const PREPARATION_HEADING = "## Preparation status";

/**
 * The part of a rendered briefing determined only by the intent and the observations
 * already recorded under it.
 *
 * The whole string when the heading is absent, which cannot happen for output of
 * {@link renderBriefing} but keeps this total for any other caller.
 */
export const stablePrefixOf = (rendered: string): string => {
  const index = rendered.indexOf(PREPARATION_HEADING);
  return index === -1 ? rendered : rendered.slice(0, index);
};

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
  const links = yield* store.dimensionLinksForIntent(intentId);
  const sequence = yield* store.currentSequence;

  // Selection is newest-first: a later observation qualifies an earlier one, so when a
  // briefing must truncate, the qualifying evidence is what a planner needs most.
  const newestFirst = [...all].sort((a, b) => b.sequence - a.sequence);
  const selected = newestFirst.slice(0, limit);
  const dropped = newestFirst.slice(limit);
  // Presentation is oldest-first, which is a separate decision from selection. See the
  // prefix-stability note in this module's header: rendering ascending is what makes a
  // later briefing an extension of an earlier one instead of a reshuffle of it.
  const bySequence = (a: Observation, b: Observation) =>
    a.sequence - b.sequence;
  const included = [...selected].sort(bySequence);
  const omitted = [...dropped].sort(bySequence);
  const includedIds = new Set(included.map((item) => item.observationId));

  return {
    targetId: intent.targetId,
    intentId: intent.intentId,
    goal: intent.goal,
    intent: intent.question,
    preparedAtSequence: sequence,
    observations: included,
    omittedObservationIds: omitted.map((item) => item.observationId),
    truncated: omitted.length > 0,
    // Over everything the intent holds, not just what fitted: truncating the body
    // must not drop a question.
    openQuestions: openQuestionsOf(all, links, includedIds),
  } satisfies Briefing;
});

/**
 * Every recorded untested dimension under one intent, with what has been recorded
 * against it.
 *
 * Three properties this has that the string list it replaces did not:
 *
 * - **Each question has an address**, so a later observation can name exactly the one
 *   it took on and the write boundary can check that the address resolves.
 * - **Nothing is matched by wording.** A dimension is addressed when a stored link says
 *   so and never otherwise. Two observations that happened to record the same sentence
 *   recorded two separate questions and stay two, because collapsing them would decide
 *   on a planner's behalf that they mean the same thing.
 * - **Addressed is not resolved.** `addressedWithEvidence` means a later observation
 *   named this address and reached a positive or negative result relative to *its own*
 *   claim. Whether that settles this question is a judgement nothing here makes.
 *
 * Order is graph order — newest raising observation first, then position — and is
 * deliberately independent of status, so the array does not reshuffle as work lands.
 * Grouping for a reader is {@link renderBriefing}'s business.
 */
export const openQuestionsOf = (
  observations: readonly Observation[],
  links: readonly DimensionLink[],
  includedIds: ReadonlySet<string> = new Set(
    observations.map((item) => item.observationId),
  ),
): readonly OpenQuestion[] => {
  const byId = new Map(
    observations.map((item) => [item.observationId, item] as const),
  );
  const reference = (observation: Observation): ObservationReference => ({
    observationId: observation.observationId,
    sequence: observation.sequence,
    outcome: observation.outcome,
    includedInBriefing: includedIds.has(observation.observationId),
  });

  const addressedBy = new Map<string, ObservationReference[]>();
  for (const link of links) {
    const addressing = byId.get(link.observationId);
    // A link whose addressing observation is not in this intent's rows cannot happen —
    // the query joins on exactly that — so a miss here is silently skipped rather than
    // reported as a question nobody raised.
    if (addressing === undefined) continue;
    const existing = addressedBy.get(link.address);
    if (existing === undefined) {
      addressedBy.set(link.address, [reference(addressing)]);
    } else {
      existing.push(reference(addressing));
    }
  }

  const ordered = [...observations].sort((a, b) => b.sequence - a.sequence);
  return ordered.flatMap((observation) =>
    dimensionsOf(observation).map(({ address, dimension }): OpenQuestion => {
      const addressers = [...(addressedBy.get(address) ?? [])].sort(
        (a, b) => a.sequence - b.sequence,
      );
      return {
        address,
        dimension,
        raisedBy: reference(observation),
        status: statusOf(addressers),
        addressedBy: addressers,
      };
    }),
  );
};

/**
 * The status of one question from its addressing observations alone.
 *
 * An `inconclusive` addressing observation is work that happened and decided nothing,
 * which is a different state from untouched and must not be reported as progress on the
 * claim. One addresser with a positive or negative outcome is enough to move the
 * question to `addressedWithEvidence`; several inconclusive ones never are.
 */
const statusOf = (
  addressers: readonly ObservationReference[],
): FollowUpStatus => {
  if (addressers.length === 0) return "uninvestigated";
  return addressers.some((item) => item.outcome !== "inconclusive")
    ? "addressedWithEvidence"
    : "addressedInconclusive";
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
  // Nothing above the first observation may depend on how much has been recorded.
  // A count or a sequence number here would change on every write and move every byte
  // after it, which is the whole of what prefix stability costs to lose.
  const lines: string[] = [
    `# Investigation briefing`,
    ``,
    `This is the complete record for this intent; there is no prior conversation to consult.`,
    ``,
    `Target: ${briefing.targetId}`,
    `Goal (broad objective, NOT settled by any single observation below):`,
    `  ${briefing.goal}`,
    `Intent (the actionable direction): ${briefing.intentId}`,
    `  ${briefing.intent}`,
    ``,
    `## Recorded observations, oldest first`,
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
      // Addresses, not bare prose: the body and the open-questions section below name
      // the same thing the same way, so a reader never has to match them up by wording.
      ...(observation.untestedDimensions.length === 0
        ? [`- untested dimensions: none recorded`]
        : [
            `- untested dimensions, with the address to cite when addressing one:`,
            ...dimensionsOf(observation).map(
              ({ address, dimension }) => `    [${address}] ${dimension}`,
            ),
          ]),
    );
  }

  // Everything from here down restates the whole record and therefore changes whenever
  // anything is recorded. It is last so that what precedes it does not.
  lines.push(
    ``,
    PREPARATION_HEADING,
    `Prepared from control-plane state at graph sequence ${briefing.preparedAtSequence}.`,
    `Observations above: ${briefing.observations.length} of ${String(
      briefing.observations.length + briefing.omittedObservationIds.length,
    )} recorded for this intent.`,
  );

  if (briefing.truncated) {
    lines.push(
      ``,
      `## Disclosed omissions`,
      `This briefing was truncated. The graph also holds these observations, omitted here:`,
      ...briefing.omittedObservationIds.map((id) => `- ${id}`),
      `Their absence above does not mean the graph lacks them.`,
    );
  }

  lines.push(``, ...renderOpenQuestions(briefing.openQuestions));

  return lines.join("\n");
};

const STATUS_HEADINGS: ReadonlyArray<
  readonly [FollowUpStatus, string, string]
> = [
  [
    "uninvestigated",
    "Uninvestigated",
    "nothing has been recorded against these.",
  ],
  [
    "addressedInconclusive",
    "Addressed, still undecided",
    "an observation took these on and could not decide them. Work happened; the question is open.",
  ],
  [
    "addressedWithEvidence",
    "Addressed with evidence",
    "an observation took these on and reached a result relative to its own claim. That is not the same as settled \u2014 read the observation and judge.",
  ],
];

/**
 * Renders the addressable open questions, grouped by how far each has been taken.
 *
 * Every question prints its address, because that address is what a worker has to send
 * back in `addresses_dimensions` to claim it. Guessing is not an option by design: an
 * address that does not resolve is refused at the write boundary, so the briefing is
 * the only place a worker can get one.
 */
const renderOpenQuestions = (
  questions: readonly OpenQuestion[],
): readonly string[] => {
  if (questions.length === 0) {
    return [`## Open questions carried forward`, ``, `- none recorded`];
  }
  const lines: string[] = [
    `## Open questions carried forward (${questions.length})`,
    ``,
    `Each is one dimension an observation recorded as untested, with the address you must`,
    `use to say you are taking it on. To address one, put its exact address in the`,
    `\`addresses_dimensions\` field of the observation you record. An address that does not`,
    `resolve is refused, and nothing is inferred from wording \u2014 if you do not name it,`,
    `it stays open.`,
    ``,
    `Nothing in this system closes a question. These groupings say what has been recorded`,
    `against each one, not whether it is settled.`,
  ];
  for (const [status, heading, note] of STATUS_HEADINGS) {
    const group = questions.filter((question) => question.status === status);
    if (group.length === 0) continue;
    lines.push(``, `### ${heading} (${group.length})`, `${note}`);
    for (const question of group) {
      const raised = question.raisedBy;
      lines.push(
        ``,
        `- [${question.address}] ${question.dimension}`,
        `  raised by ${raised.observationId} (sequence ${String(raised.sequence)}, outcome ${raised.outcome})` +
          `${raised.includedInBriefing ? "" : " \u2014 that observation is NOT included above; it is omitted from this briefing, not absent from the graph"}`,
      );
      for (const addresser of question.addressedBy) {
        lines.push(
          `  addressed by ${addresser.observationId} (sequence ${String(addresser.sequence)}, outcome ${addresser.outcome})` +
            `${addresser.includedInBriefing ? "" : " \u2014 omitted from this briefing"}`,
        );
      }
    }
  }
  return lines;
};
