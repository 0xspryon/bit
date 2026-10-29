/**
 * Adding an intent, and the anchoring rule that governs it (DECISIONS.md §4 "intent
 * anchoring", §17 "one derivation, not a stored flag").
 *
 * §4 calls anchoring "the single most valuable idea here" and says to implement it before
 * anything else that writes to the graph. The rule: an intent anchors only to existing
 * recorded evidence — never to another intent, a goal or a hint — and an empty parent
 * list means a new top-level direction. That is what stops a long hunt drifting into
 * speculation about speculation.
 *
 * **Who may call this, and why that is not a worker.** Intents are planner-generated, and
 * a planner round has no execution attempt: `CallerContext` requires `attemptId` and
 * `attemptFence`, and the store's authority check validates against a live unsettled
 * attempt. There is nothing for a planner to present. So this sprint enforces anchoring
 * **in the store**, with the host creating intents as it does today, and the
 * planner-facing tool waits for Sprint 07 when there is a planner loop to authenticate.
 * The contract below is therefore host-facing: it has no wire encoding and is not
 * advertised as an MCP tool.
 *
 * Browser-safe: Effect Schema only.
 */
import { Schema } from "effect";

import { ModelOptionSelection } from "./modelOption";
import { ObservationOutcome } from "./observation";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/**
 * Where an intent is in its life.
 *
 * - `proposed` — suggested by a planner and not yet accepted. **Defined and never written
 *   in this build**: there is no planner, and every intent an operator adds is `open`. It
 *   is in the vocabulary now so that adding a planner does not change what the column
 *   means.
 * - `open` — available. Nothing is working it, and a run may claim it.
 * - `claimed` — a run holds it. Exactly one attempt does, named by
 *   {@link IntentView.claimedByAttemptId}; a second claim is refused naming that attempt.
 * - `answered` — an attempt **succeeded and left at least one observation** under it.
 *   Terminal. It is the only status that asserts evidence, which is why the rule that
 *   produces it needs both halves: a `succeeded` attempt that recorded nothing is an
 *   absence of evidence, and treating it as an answer would turn that absence into
 *   evidence.
 * - `abandoned` — an operator dropped it. Terminal, and set only by that explicit act:
 *   a failed run is not a reason to give up a direction, it is a reason it is open again.
 *
 * **What settlement does to a claim.** When the claiming attempt settles, the claim is
 * released and the intent returns to `open`, unless the attempt `succeeded` and at least
 * one observation exists under the intent, in which case it becomes `answered`. A
 * `failed`, `interrupted` or `uncertain` attempt never produces `answered`.
 */
export const IntentStatus = Schema.Literals([
  "proposed",
  "open",
  "claimed",
  "answered",
  "abandoned",
]);
export type IntentStatus = typeof IntentStatus.Type;

/**
 * What creating one intent needs.
 *
 * `goalId` and `intentId` are host-owned, like the ones `seedAttempt` already takes. The
 * store checks them; it does not mint them, because the host is what knows whether this
 * is a new slice of an existing goal or a resumption of one it already has ids for.
 */
export const AddIntentInput = Schema.Struct({
  /** Stable operation identity. An exact retry replays; conflicting reuse is refused. */
  operationId: Schema.NonEmptyString,
  goalId: Schema.NonEmptyString,
  intentId: Schema.NonEmptyString,
  /** The actionable direction, as a question a bounded test could speak to. */
  question: Schema.NonEmptyString,
  /**
   * Observations this direction came out of.
   *
   * **Empty means a new top-level direction**, which is legitimate and is how a hunt
   * starts. A non-empty list must name stored observations under the same goal; an id
   * that names an intent or a goal is refused with a message saying so, because the
   * mistake it describes is a conceptual one and a bare failure teaches nothing.
   */
  anchorObservationIds: Schema.Array(Schema.String),
  /**
   * The untested dimension this intent exists to answer, as the **wire alias** a briefing
   * printed (`<observationId>#u<index>`).
   *
   * Null is the ordinary case and means only that the caller did not say. It never means
   * "this intent addresses nothing in particular".
   *
   * When it is given, three things follow. The dimension's briefing state becomes
   * `scheduled`, so a later round can tell "nobody has looked at this" from "work is out
   * for this". Duplicate-intent detection becomes a join rather than prose matching. And
   * an observation recorded under this intent may address that dimension even though
   * another intent of the same goal raised it — which is a path no worker could close
   * before (DECISIONS.md §17).
   */
  addressesDimension: Schema.NullOr(Schema.String),
  /**
   * Which configured harness instance this intent would like to run on.
   *
   * **Advisory, and never a pin.** It is a suggestion for whoever starts the run: the
   * resolution order is the operator's explicit pick, then this, then the server's
   * default. A suggestion that cannot be honoured (an instance that is not configured or
   * did not come up) is *replaced by the default and the run says so*, where an operator's
   * explicit pick would be refused. The attempt row stores what actually ran; this stores
   * only what was hoped for, and nothing reads it as provenance.
   *
   * Absent means no opinion. The empty string is not a way to say that and is refused.
   */
  suggestedInstanceId: Schema.optional(Schema.NonEmptyString),
  /** A model inside that instance, with the same standing: advisory, absent means none. */
  suggestedModel: Schema.optional(Schema.NonEmptyString),
  /**
   * What would be chosen *of* that model, in the shape `RunDraft.modelOptions` takes.
   *
   * **Absent is not empty.** Absent says the intent has no opinion and the model applies
   * its own defaults; an empty array would say the intent suggested "no options" and
   * claim an opinion that is not there. Only a suggestion somebody made is stored.
   */
  suggestedModelOptions: Schema.optional(Schema.Array(ModelOptionSelection)),
});
export type AddIntentInput = typeof AddIntentInput.Type;

/** What adding an intent returns. */
export const AddIntentResult = Schema.Struct({
  intentId: Schema.String,
  goalId: Schema.String,
  /** The observation ids this intent is anchored to, in the order given. */
  anchoredTo: Schema.Array(Schema.String),
  /** The dimension id the alias resolved to, or null when none was declared. */
  addressesDimensionId: Schema.NullOr(Schema.String),
  /** True when this intent is a new top-level direction rather than anchored work. */
  topLevel: Schema.Boolean,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
});
export type AddIntentResult = typeof AddIntentResult.Type;

/** What abandoning one intent needs. Host-facing, like {@link AddIntentInput}. */
export const AbandonIntentInput = Schema.Struct({
  /** Stable operation identity. An exact retry replays; conflicting reuse is refused. */
  operationId: Schema.NonEmptyString,
  intentId: Schema.NonEmptyString,
  /** Why, in the operator's words. Empty means none given; it is stored as given. */
  reason: Schema.String,
});
export type AbandonIntentInput = typeof AbandonIntentInput.Type;

/** What abandoning an intent returns. */
export const AbandonIntentResult = Schema.Struct({
  intentId: Schema.String,
  /** True when this call replayed an existing receipt rather than writing anew. */
  replayed: Schema.Boolean,
});
export type AbandonIntentResult = typeof AbandonIntentResult.Type;

/**
 * An intent's suggestion for how it would like to be run, as a browser reads it.
 *
 * Each field is null when the intent has no opinion on it. See
 * {@link AddIntentInput.suggestedInstanceId}: these are advisory, never provenance.
 */
export const IntentSuggestion = Schema.Struct({
  instanceId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** Null is no opinion; an empty array would be an opinion of "no options". */
  modelOptions: Schema.NullOr(Schema.Array(ModelOptionSelection)),
});
export type IntentSuggestion = typeof IntentSuggestion.Type;

/** What a browser reads about one intent. */
export const IntentView = Schema.Struct({
  intentId: Schema.String,
  goalId: Schema.String,
  question: Schema.String,
  status: IntentStatus,
  /** The observations this direction came out of, in order. Empty is a top-level direction. */
  anchoredTo: Schema.Array(Schema.String),
  /**
   * The untested dimension it addresses, as the wire alias a briefing prints
   * (`<observationId>#u<index>`), or null when none was declared.
   */
  addressesDimension: Schema.NullOr(Schema.String),
  createdAt: EpochMillis,
  /** The attempt holding the claim. Non-null exactly while `status` is `claimed`. */
  claimedByAttemptId: Schema.NullOr(Schema.String),
  /** What the intent would like to run on. Advisory; the attempt says what ran. */
  suggestion: IntentSuggestion,
  /** Attempts made against it so far, settled or not. A snapshot. */
  attempts: Schema.Int,
});
export type IntentView = typeof IntentView.Type;

/**
 * What the add-intent form submits.
 *
 * As with {@link GoalDraft}, **the server mints the intent id and the operation id**; the
 * goal is in the path. The question is trimmed and must not be blank. Anchors and the
 * dimension are checked by the store's anchoring rule, whose refusals are written to teach
 * and are shown as written.
 *
 * The suggestion fields are {@link AddIntentInput}'s, with the same meaning: advisory,
 * and absent is not empty.
 */
export const IntentDraft = Schema.Struct({
  question: Schema.Trim.check(Schema.isNonEmpty()),
  /** Empty means a new top-level direction. */
  anchorObservationIds: Schema.Array(Schema.String),
  /** Null when the caller did not say which dimension this addresses. */
  addressesDimension: Schema.NullOr(Schema.String),
  suggestedInstanceId: Schema.optional(Schema.NonEmptyString),
  suggestedModel: Schema.optional(Schema.NonEmptyString),
  suggestedModelOptions: Schema.optional(Schema.Array(ModelOptionSelection)),
});
export type IntentDraft = typeof IntentDraft.Type;

/** What the abandon control submits. The ender is the operator by construction. */
export const IntentAbandonDraft = Schema.Struct({
  /** Why, in the operator's words. Empty means none given. */
  reason: Schema.String,
});
export type IntentAbandonDraft = typeof IntentAbandonDraft.Type;

/**
 * One untested dimension an observation recorded, as a picker offers it.
 *
 * `address` is the wire alias a briefing prints (`<observationId>#u<index>`), derived from
 * the observation row and never stored a second time, and it is what
 * {@link IntentDraft.addressesDimension} takes. `text` is the sentence the worker wrote.
 */
export const ObservationDimensionView = Schema.Struct({
  address: Schema.String,
  text: Schema.String,
});
export type ObservationDimensionView = typeof ObservationDimensionView.Type;

/**
 * An observation under a goal, as much of it as choosing an anchor needs.
 *
 * **A digest, not the record.** The add-intent form has to let an operator pick evidence to
 * anchor to and a dimension to address, and both are choices among sentences: the claim
 * that was tested, how it came out, and what it left untested. The case-by-case evidence is
 * not needed to choose and is not here; this is deliberately not a way to read the
 * observation. Its format (`caseBased` or `summary`) does not matter to this choice and so
 * is not carried either.
 */
export const GoalObservationView = Schema.Struct({
  observationId: Schema.String,
  /** The intent it was recorded under, which may be a sibling of the one being added. */
  intentId: Schema.String,
  testedClaim: Schema.String,
  outcome: ObservationOutcome,
  untestedDimensions: Schema.Array(ObservationDimensionView),
});
export type GoalObservationView = typeof GoalObservationView.Type;
