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
