/**
 * The event log and the outbox, as contracts (DECISIONS.md §3 "append-only message
 * storage", §6 "the outbox pattern", "outbox meaning and delivery guarantees", §8
 * "durable ordered reads").
 *
 * **What an event is here.** One immutable record that a mutation happened, carrying a
 * store-assigned per-target `sequence`. §8 is what the sequence is for: a consumer reads
 * committed events from SQLite in ascending sequence order after its cursor, and a PubSub
 * wake-up is advisory rather than the delivery guarantee — so a crash between commit and
 * notification cannot strand committed work. Sprint 02 writes these; Sprint 03 reads
 * them. Nothing here is event sourcing: the domain tables hold current state, and an
 * event is a record that it changed, not the only copy of it.
 *
 * **What an outbox request is here.** A durable *side-effect request*, committed in the
 * same transaction as the domain change that implies it. §6: an autonomous tool runs for
 * weeks and will crash mid-operation, so state and the actions it implies commit
 * atomically. It explicitly does **not** give exactly-once remote execution — if a remote
 * action succeeds and the process dies before recording that, the outcome is ambiguous —
 * which is why every request type carries a stated {@link OutboxRecoveryPolicy}.
 *
 * Browser-safe: Effect Schema only.
 */
import { Schema } from "effect";

/**
 * The event kinds this build writes.
 *
 * One per mutation, named `<subject>.<what happened>` in the past tense, because an event
 * records something that is already true. A reader must tolerate a kind it does not know
 * rather than failing: the set only grows, and a Sprint 03 consumer will meet events
 * written by a later build.
 */
export const EventKind = Schema.Literals([
  "asset.recorded",
  "intent.added",
  "observation.recorded",
]);
export type EventKind = typeof EventKind.Type;

/**
 * One recorded event.
 *
 * The three identities are three separate fields and are never collapsed into one
 * "actor" (§6). `callerScope`, `intentId` and `attemptId` are caller authority and are
 * all absent together for a host-originated mutation — an honest absence rather than a
 * fabricated attempt. `operation` with `operationId` is operation identity, the same pair
 * the command receipt is keyed on, so an event can be matched to the command that wrote
 * it. `subjectId` is domain identity: the row this event is about.
 */
export const RecordedEvent = Schema.Struct({
  eventId: Schema.String,
  sequence: Schema.Int,
  targetId: Schema.String,
  kind: Schema.String,
  /** Decoded JSON. Readers tolerate fields they do not declare; see `unknownField`. */
  payload: Schema.Unknown,
  callerScope: Schema.NullOr(Schema.String),
  intentId: Schema.NullOr(Schema.String),
  attemptId: Schema.NullOr(Schema.String),
  operation: Schema.String,
  operationId: Schema.NullOr(Schema.String),
  subjectId: Schema.String,
  recordedAt: Schema.Finite,
});
export type RecordedEvent = typeof RecordedEvent.Type;

/**
 * What a dispatcher may do about a request whose outcome it cannot establish (§6).
 *
 * Assigning one of these per effect type is a requirement, not a nicety: the four are
 * genuinely different, and a dispatcher with one blanket policy either loses work or
 * repeats something unrepeatable.
 *
 * - `safe_to_retry` — repeating it has no additional effect worth worrying about.
 * - `idempotency_key` — repeat it, under a stable key the receiver honours.
 * - `reconcile_first` — read the external state before deciding whether to repeat.
 * - `do_not_repeat` — the outcome is unknown and must not be guessed at. Persist the
 *   uncertainty and schedule a reconciliation; this does not mean prompt a human.
 */
export const OutboxRecoveryPolicy = Schema.Literals([
  "safe_to_retry",
  "idempotency_key",
  "reconcile_first",
  "do_not_repeat",
]);
export type OutboxRecoveryPolicy = typeof OutboxRecoveryPolicy.Type;

/**
 * The side-effect request types this build enqueues.
 *
 * Two, and the shortfall is deliberate. §18's accepted entries are what makes each one a
 * real obligation rather than a decorative row: `asset.enrich` is "deterministic asset
 * enrichment with explicit policy", and `notification.deliver` is the notification
 * subsystem, which §18 says to build "using the existing transactional outbox".
 *
 * **Adding an intent writes no request, and that is the honest answer.** A new intent
 * implies no action outside this database — the queue of intents *is* the database (§4's
 * atomic claim), not the outbox — so inventing one would make the mechanism look more
 * exercised than it is. A mutation that was obliged to write an outbox row would be a
 * design error, and this is what proves it is not.
 */
export const OutboxRequestType = Schema.Literals([
  "asset.enrich",
  "notification.deliver",
]);
export type OutboxRequestType = typeof OutboxRequestType.Type;

/**
 * The recovery policy each request type carries, declared once.
 *
 * `asset.enrich` is `safe_to_retry` because enrichment is a read of external state —
 * resolving a name, fingerprinting a service — and doing it twice costs one extra lookup.
 *
 * `notification.deliver` is `reconcile_first` rather than `safe_to_retry`. A notification
 * is visible to a person, and a crash between sending and recording the send leaves it
 * genuinely unknown whether it arrived; the right move is to read the channel before
 * repeating, not to repeat and hope. It is not `idempotency_key` because no receiver is
 * wired, and claiming a key the other side honours would be a claim about a system that
 * does not exist here yet.
 */
export const OUTBOX_RECOVERY_POLICIES = {
  "asset.enrich": "safe_to_retry",
  "notification.deliver": "reconcile_first",
} as const satisfies Record<OutboxRequestType, OutboxRecoveryPolicy>;

/** The delivery states an outbox row can hold. Sprint 02 writes only `pending`. */
export const OutboxStatus = Schema.Literals([
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OutboxStatus = typeof OutboxStatus.Type;

/**
 * One queued side-effect request as stored.
 *
 * The execution metadata is declared because §6 requires it and because a dispatcher that
 * had to add a lease column later would have to rebuild the table. In this sprint every
 * row is `pending` with `attempts: 0` and no lease: claiming, leasing, retry scheduling
 * and delivery state are Sprint 03.
 */
export const OutboxEntry = Schema.Struct({
  outboxId: Schema.String,
  sequence: Schema.Int,
  targetId: Schema.String,
  requestType: Schema.String,
  payload: Schema.Unknown,
  recoveryPolicy: Schema.String,
  /** The event that made this obligation exist. Never absent. */
  causedByEventId: Schema.String,
  status: Schema.String,
  attempts: Schema.Int,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(Schema.Finite),
  nextAttemptAt: Schema.NullOr(Schema.Finite),
  lastError: Schema.NullOr(Schema.String),
  enqueuedAt: Schema.Finite,
  completedAt: Schema.NullOr(Schema.Finite),
});
export type OutboxEntry = typeof OutboxEntry.Type;
