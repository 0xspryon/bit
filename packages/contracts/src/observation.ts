/**
 * The observation domain contract (DECISIONS.md §4 "observations are scoped evidence",
 * §15 "lifecycle semantics", §21 "multi-case observations").
 *
 * An observation is scoped evidence, never an intent-wide verdict. It speaks to exactly
 * one narrow `testedClaim` and carries one `outcome` relative to that claim alone: a
 * timeout or broken test is `inconclusive`, never `negative`, and successful execution
 * is not itself a positive result.
 *
 * **One claim, several cases.** A real test of one claim usually needs more than one
 * identity, endpoint or ordering — "the owner reads it, a second tenant does not" is one
 * claim and two cases. So `cases` is a non-empty list of {@link ObservationTestCase},
 * each with its own actors, relationships, ordered actions, window and bounds. What was
 * *seen* lives on the action that produced it, so an endpoint, a method, an actor and a
 * response can never drift apart into separate prose fields.
 *
 * What stays at the top level is what genuinely spans the cases: the claim, the outcome,
 * the worker's interpretation, overall limitations and untested dimensions. There is
 * deliberately no top-level `observedBehavior` or `evidenceRefs` duplicating the
 * actions' own.
 *
 * Two encodings of one model live here. The domain schemas are camelCase, which is what
 * the rest of the codebase works in. The `*Wire` schemas are the *same* fields and the
 * *same* checks with snake_case encoded keys, which is the shape tools and JSON payloads
 * use. They are derived with `Schema.encodeKeys`, not written twice, so the advertised
 * JSON Schema and the decoder cannot drift apart (DECISIONS.md §2 "one canonical wire
 * schema").
 *
 * Browser-safe: Effect Schema only, no server, Bun, Node or persistence imports.
 */
import { Schema } from "effect";

/**
 * Outcome relative to the recorded `testedClaim` only.
 *
 * - `positive` — the observation supports that narrow claim under the recorded cases.
 * - `negative` — the test did not support it under those cases. Never an unbounded
 *   absence claim; "not reproduced here", not "not vulnerable".
 * - `inconclusive` — the test cannot decide the claim. Technical failures, timeouts and
 *   harness errors land here.
 */
export const ObservationOutcome = Schema.Literals([
  "positive",
  "negative",
  "inconclusive",
]).annotate({ description: "Relative to tested_claim only." });
export type ObservationOutcome = typeof ObservationOutcome.Type;

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are rejected, not stored. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/** A string a reader needs in order to interpret the record at all. */
const required = (description: string) =>
  Schema.NonEmptyString.annotate({ description });

const stringList = (description: string) =>
  Schema.Array(Schema.String).annotate({ description });

/**
 * One identity a case acted as.
 *
 * `account` is `null` for an unauthenticated actor, and `role` is `null` when the role
 * is unknown or does not apply. Both are deliberately nullable rather than defaulted to
 * an empty string: "signed in as nobody" and "we did not record who" are different
 * facts, and a briefing has to be able to say which. No credential, token or password
 * ever belongs in here.
 */
export const ObservationActor = Schema.Struct({
  /** Referenced by this case's actions. Unique within the case. */
  id: required("Short id for this actor, referenced by this case's actions."),
  account: Schema.NullOr(Schema.String).annotate({
    description:
      "Account this actor acted as, or null when unauthenticated. Never a credential.",
  }),
  role: Schema.NullOr(Schema.String).annotate({
    description:
      "Role or privilege level, or null when unknown or not applicable.",
  }),
  /**
   * How this actor's client identified itself to the target. Label simulated
   * identities honestly; a spoofed header is not network-level address rotation.
   */
  clientIdentity: required(
    "How this actor's client identified itself. Label simulated identities honestly: a spoofed header is not address rotation.",
  ),
});
export type ObservationActor = typeof ObservationActor.Type;

/** The snake_case encoding of {@link ObservationActor}. */
export const ObservationActorWire = ObservationActor.pipe(
  Schema.encodeKeys({ clientIdentity: "client_identity" }),
);

/**
 * An ownership or tenancy fact the case depends on, as a plain triple.
 *
 * This is how "document-1 belongs to tenant-a" is recorded without introducing a graph
 * subsystem: three strings a reader can check, not entities the planner must resolve.
 */
export const ObservationRelationship = Schema.Struct({
  subject: required(
    "The owning or containing side, e.g. an account or tenant.",
  ),
  relation: required("How subject relates to object, e.g. owns or belongs-to."),
  object: required("The owned or contained side, e.g. a resource id."),
});
export type ObservationRelationship = typeof ObservationRelationship.Type;

/**
 * One step a case performed, by one actor against one endpoint.
 *
 * Actions are an ordered list, and the order is the order they were performed in. That
 * is the whole reason behavior is recorded here rather than once per observation: the
 * association between *who* acted, *where*, *how* and *what came back* survives.
 * Genuinely concurrent work is described as such in `description`, since a list cannot
 * express it.
 */
export const ObservationAction = Schema.Struct({
  /** Must match one of this case's `actors[].id`. */
  actorId: required("Which of this case's actors performed this step."),
  endpoint: required(
    "The endpoint, host or other addressable subject acted on.",
  ),
  method: required(
    "Method or technique applied, e.g. POST or header rotation.",
  ),
  description: required(
    "What this step did. If requests overlapped in time, say so here: the list order cannot express concurrency.",
  ),
  /** Requests this step rests on. 0 is legitimate for a step that sent none. */
  requestCount: Schema.Natural.annotate({
    description: "How many requests this step issued. Never negative.",
  }),
  /** What came back, free of interpretation. */
  observedBehavior: required(
    "What was actually seen for this step: status codes, counts, bodies. No interpretation.",
  ),
  evidenceRefs: stringList(
    "References to evidence for this step, held elsewhere.",
  ),
});
export type ObservationAction = typeof ObservationAction.Type;

/** The snake_case encoding of {@link ObservationAction}. */
export const ObservationActionWire = ObservationAction.pipe(
  Schema.encodeKeys({
    actorId: "actor_id",
    requestCount: "request_count",
    observedBehavior: "observed_behavior",
    evidenceRefs: "evidence_refs",
  }),
);

/**
 * The structural rules a case must satisfy, independent of how its keys are encoded.
 *
 * These are cross-field checks, which is why they live on the case rather than on its
 * members: an action naming an actor that the case never declared is only detectable
 * here. `Filter` is contravariant in its input (`effect/src/SchemaAST.ts:4078`), so one
 * set of checks declared against the structural shape applies to both the domain and
 * the wire schema, and the rules cannot be enforced on one encoding but not the other.
 */
interface TestCaseShape {
  readonly actors: ReadonlyArray<{ readonly id: string }>;
  readonly actions: ReadonlyArray<{ readonly actorId: string }>;
  readonly windowStart: number;
  readonly windowEnd: number;
}

const testCaseChecks = [
  Schema.makeFilter<TestCaseShape>(
    (value) => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const actor of value.actors) {
        if (seen.has(actor.id)) duplicates.add(actor.id);
        seen.add(actor.id);
      }
      if (duplicates.size > 0) {
        return {
          path: ["actors"],
          issue: `duplicate actor ids within this case: ${[...duplicates].join(", ")}`,
        };
      }
      return undefined;
    },
    { expected: "a case whose actor ids are unique" },
  ),
  Schema.makeFilter<TestCaseShape>(
    (value) => {
      const declared = new Set(value.actors.map((actor) => actor.id));
      const dangling = value.actions
        .map((action, index) => [index, action.actorId] as const)
        .filter(([, actorId]) => !declared.has(actorId));
      if (dangling.length > 0) {
        return dangling.map(([index, actorId]) => ({
          path: ["actions", index, "actorId"],
          issue: `no actor with id "${actorId}" is declared in this case`,
        }));
      }
      return undefined;
    },
    { expected: "a case whose actions reference declared actors" },
  ),
  Schema.makeFilter<TestCaseShape>(
    (value) =>
      value.windowEnd >= value.windowStart
        ? undefined
        : {
            path: ["windowEnd"],
            issue: "the observation window must not end before it starts",
          },
    { expected: "a case whose window ends at or after it starts" },
  ),
] as const;

/**
 * One case under the observation's single tested claim.
 *
 * A case is self-contained: the identities it used, the ownership facts it relied on,
 * the ordered steps it performed, the configuration it ran against, the window it
 * occupied, and what it could not reach. Two cases can disagree, and both are kept.
 */
const testCaseFields = {
  /** Unique within this observation, so a briefing can refer to one case. */
  id: required("Short id for this case, unique within this observation."),
  purpose: required(
    "What this specific case tests about the claim, and why it is separate.",
  ),
  actors: Schema.Array(ObservationActor).annotate({
    description:
      "The identities this case acted as. Every action must name one of them.",
  }),
  relationships: Schema.Array(ObservationRelationship).annotate({
    description:
      "Ownership or tenancy facts this case relies on, as subject/relation/object triples.",
  }),
  actions: Schema.NonEmptyArray(ObservationAction).annotate({
    description:
      "The steps performed, in the order performed. At least one is required.",
  }),
  configuration: required(
    "Relevant configuration of the subject or of the test for this case.",
  ),
  windowStart: EpochMillis,
  windowEnd: EpochMillis,
  testBounds: required(
    "What bounded this case: budgets, durations, scope limits you worked within.",
  ),
  limitations: stringList("Known limitations of this case specifically."),
};

export const ObservationTestCase = Schema.Struct(testCaseFields).check(
  ...testCaseChecks,
);
export type ObservationTestCase = typeof ObservationTestCase.Type;

/**
 * The snake_case encoding of {@link ObservationTestCase}.
 *
 * Same fields, same checks; only the two nested member schemas are substituted for
 * their wire encodings, because `Schema.encodeKeys` renames one struct's own keys and
 * does not recurse.
 */
export const ObservationTestCaseWire = Schema.Struct({
  ...testCaseFields,
  actors: Schema.Array(ObservationActorWire),
  actions: Schema.NonEmptyArray(ObservationActionWire),
})
  .check(...testCaseChecks)
  .pipe(
    Schema.encodeKeys({
      testBounds: "test_bounds",
      windowStart: "window_start",
      windowEnd: "window_end",
    }),
  );

/** Cross-case rule: a briefing must be able to name one case unambiguously. */
const uniqueCaseIds = Schema.makeFilter<{
  readonly cases: ReadonlyArray<{ readonly id: string }>;
}>(
  (value) => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const testCase of value.cases) {
      if (seen.has(testCase.id)) duplicates.add(testCase.id);
      seen.add(testCase.id);
    }
    return duplicates.size > 0
      ? {
          path: ["cases"],
          issue: `duplicate case ids: ${[...duplicates].join(", ")}`,
        }
      : undefined;
  },
  { expected: "an observation whose case ids are unique" },
);

/**
 * What a worker submits.
 *
 * Provenance is deliberately absent: caller target, intent, attempt and session are
 * derived from the authenticated invocation context at the mutation boundary, never
 * from model assertions (DECISIONS.md §6 "session-scoped MCP credentials").
 */
const recordObservationInputFields = {
  /**
   * Caller-owned stable operation identity. An exact retry under the same ID returns
   * the original result; reuse with conflicting input is rejected.
   */
  operationId: required(
    "Stable ID for this record operation. An exact retry returns the original result; reusing it with different content is rejected.",
  ),
  /** The single narrow claim this observation speaks to. */
  testedClaim: required("The single narrow claim this observation speaks to."),
  outcome: ObservationOutcome,
  /** The shared arrangement every case ran against. */
  setup: required(
    "The shared arrangement all cases below ran against: the system, accounts and state you started from.",
  ),
  cases: Schema.NonEmptyArray(ObservationTestCase).annotate({
    description:
      "The cases that together test the claim. At least one is required; use several when one claim needs more than one identity, endpoint or ordering.",
  }),
  /** The worker's reading across the cases, kept separate from what was seen. */
  interpretation: required(
    "Your reading across the cases, kept separate from what each action observed.",
  ),
  /** Limitations of the observation as a whole; per-case limits live on the case. */
  limitations: stringList(
    "Limitations of this observation as a whole. Per-case limits belong on the case.",
  ),
  /** Dimensions deliberately not covered, which remain open for follow-up work. */
  untestedDimensions: stringList(
    "Dimensions no case covered, left open for follow-up.",
  ),
};

export const RecordObservationInput = Schema.Struct(
  recordObservationInputFields,
).check(uniqueCaseIds);
export type RecordObservationInput = typeof RecordObservationInput.Type;

/**
 * The canonical wire encoding of {@link RecordObservationInput}.
 *
 * This single schema is both the decoder for incoming tool arguments and the source of
 * the advertised JSON Schema, so an advertised field name is by construction the field
 * name the decoder accepts.
 */
export const RecordObservationInputWire = Schema.Struct({
  ...recordObservationInputFields,
  cases: Schema.NonEmptyArray(ObservationTestCaseWire),
})
  .check(uniqueCaseIds)
  .pipe(
    Schema.encodeKeys({
      operationId: "operation_id",
      testedClaim: "tested_claim",
      untestedDimensions: "untested_dimensions",
    }),
  );

/** Server-derived provenance, bound to the authenticated caller. */
export const ObservationProvenance = Schema.Struct({
  targetId: Schema.String,
  intentId: Schema.String,
  attemptId: Schema.String,
  /** The harness session the authenticated credential was issued to. */
  harnessSessionId: Schema.String,
  workerId: Schema.String,
  recordedAt: EpochMillis,
});
export type ObservationProvenance = typeof ObservationProvenance.Type;

/** Fields every stored observation has, whatever format its evidence was recorded in. */
const observationCommonFields = {
  observationId: Schema.String,
  sequence: Schema.Int,
  testedClaim: Schema.String,
  outcome: ObservationOutcome,
  interpretation: Schema.String,
  limitations: Schema.Array(Schema.String),
  untestedDimensions: Schema.Array(Schema.String),
  provenance: ObservationProvenance,
};

/**
 * The version of this contract. There is exactly one, and it has not been released.
 *
 * It is here so the number has a single home and a stated meaning, not so that a
 * consumer can branch on it: nothing has ever been published under a different value,
 * so no code should have a "version 1" path and a "version 2" path. The two record
 * formats below are both shapes of **this** version — they are a format distinction,
 * not a version history (see {@link ObservationRecordFormat}).
 *
 * Persistence migration ids are a separate, unrelated sequence. `0002` in the migration
 * chain is the second schema change made during development; it is not evidence that a
 * second contract version was ever published.
 */
export const OBSERVATION_CONTRACT_VERSION = 1;

/**
 * How an observation's evidence is laid out.
 *
 * - `caseBased` — `setup` plus one or more {@link ObservationTestCase}, each with its own
 *   actors, ownership facts and ordered actions. This is what everything writes, and the
 *   only format `RecordObservationInput` can express.
 * - `summary` — one flattened `conditions` struct and one prose `observedBehavior`,
 *   recorded during early development before cases existed. Read-only.
 *
 * Both are v1 observations of the same claim-scoped kind. They differ in how much of the
 * arrangement survived as structure rather than prose, which is why a reader is always
 * told which one they are looking at.
 */
export const ObservationRecordFormat = Schema.Literals([
  "caseBased",
  "summary",
]);
export type ObservationRecordFormat = typeof ObservationRecordFormat.Type;

/** The format every new write uses. Nothing can write {@link SummaryObservation}. */
export const OBSERVATION_WRITE_FORMAT =
  "caseBased" as const satisfies ObservationRecordFormat;

/** An observation whose evidence is laid out as cases. The format new writes use. */
export const CaseBasedObservation = Schema.Struct({
  _tag: Schema.tag("caseBased"),
  ...observationCommonFields,
  setup: Schema.String,
  cases: Schema.NonEmptyArray(ObservationTestCase),
});
export type CaseBasedObservation = typeof CaseBasedObservation.Type;

/**
 * The flattened conditions a summary-format observation carries.
 *
 * Read-only. Nothing writes this shape, and it is not reachable from
 * {@link RecordObservationInput}.
 */
export const SummaryObservationConditions = Schema.Struct({
  endpoint: Schema.String,
  account: Schema.String,
  clientIdentity: Schema.String,
  method: Schema.String,
  configuration: Schema.String,
  windowStart: EpochMillis,
  windowEnd: EpochMillis,
  requestCount: Schema.Int,
});
export type SummaryObservationConditions =
  typeof SummaryObservationConditions.Type;

/**
 * An observation recorded as one summary rather than as cases, preserved verbatim.
 *
 * **Why this is a separate member of the union rather than a conversion.** The stored
 * `conditions` of real rows describe several identities in one prose string — one row
 * records an identity "held at claim1-fixed through refusal, then changed to
 * claim1-rotated", and its `requestCount` is a single total across all of that.
 * Splitting that into actors, ordered actions and per-action counts would mean
 * inventing an allocation nobody observed. So these rows keep their original fields,
 * are labelled as summary-format wherever they are rendered, and sit alongside
 * case-based ones instead of being silently rewritten (DECISIONS.md §21 "summary-format
 * observations keep their shape").
 */
export const SummaryObservation = Schema.Struct({
  _tag: Schema.tag("summary"),
  ...observationCommonFields,
  conditions: SummaryObservationConditions,
  observedBehavior: Schema.String,
  evidenceRefs: Schema.Array(Schema.String),
});
export type SummaryObservation = typeof SummaryObservation.Type;

/**
 * A stored observation, in whichever format it was recorded.
 *
 * Consumers discriminate on `_tag`, which is the {@link ObservationRecordFormat}. There
 * is no accessor that papers over the difference, because every such accessor would
 * have to make something up for one of the two formats.
 */
export const Observation = Schema.Union([
  CaseBasedObservation,
  SummaryObservation,
]);
export type Observation = typeof Observation.Type;

/** What `record_observation` returns to the worker. */
export const RecordObservationResult = Schema.Struct({
  observationId: Schema.String,
  sequence: Schema.Int,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
  provenance: ObservationProvenance,
});
export type RecordObservationResult = typeof RecordObservationResult.Type;

/** The snake_case encoding of {@link RecordObservationResult}, for tool output. */
export const RecordObservationResultWire = Schema.Struct({
  ...RecordObservationResult.fields,
  provenance: ObservationProvenance.pipe(
    Schema.encodeKeys({
      targetId: "target_id",
      intentId: "intent_id",
      attemptId: "attempt_id",
      harnessSessionId: "harness_session_id",
      workerId: "worker_id",
      recordedAt: "recorded_at",
    }),
  ),
}).pipe(Schema.encodeKeys({ observationId: "observation_id" }));
