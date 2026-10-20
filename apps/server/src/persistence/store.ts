/**
 * The control-plane store for the delegation-and-memory slice.
 *
 * Every statement here is a parameterised `effect/sql` tagged template. There is no ORM
 * and no query builder: the SQL is the SQL, and every value reaches SQLite as a bound
 * parameter rather than as text spliced into a statement (DECISIONS.md §3 "`FIX` —
 * effect/sql replaces Drizzle").
 *
 * **What is and is not checked before runtime.** The result schemas below are real
 * decoders — `SqlSchema.findAll`/`findOne` encode the request and decode each returned
 * row through Effect Schema, so a column that comes back as the wrong type, or JSON that
 * no longer matches the contract, is a typed failure naming the row. What TypeScript
 * does **not** check is the SQL text: a misspelled column or table name, a wrong
 * placeholder count, or a `SELECT` that omits a field the result schema requires are all
 * accepted by the compiler and fail at execution. That is why `store.test.ts` and
 * `migrations.test.ts` execute every statement in this file against a real SQLite file;
 * the type annotations are not a substitute for that and are not claimed to be.
 *
 * **Transactions.** `sql.withTransaction` holds one connection for the body, so the
 * observation row, the monotonic sequence bump and the command receipt commit together
 * or not at all. The body is an ordinary Effect and may yield — that is the real
 * difference from the superseded Drizzle arrangement, which needed a synchronous
 * callback. It still performs no harness call, no HTTP request and no filesystem work:
 * SQLite's write lock is held for the duration.
 *
 * The failure channel names what a caller can act on:
 *
 * - {@link MutationError} — refused on domain grounds (a receipt conflict).
 * - {@link DatabaseError} — SQLite or the driver failed.
 * - {@link StoredRowError} — a persisted row no longer matches the contract. A
 *   data-integrity signal, not a bad request.
 */
import {
  OBSERVATION_WRITE_FORMAT,
  Observation,
  ObservationTestCase,
  RecordObservationResult,
  SummaryObservationConditions,
  type ObservationProvenance,
  type ObservationRecordFormat,
  type RecordObservationInput,
} from "@bit/contracts";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import { migrate } from "./migrations";
import { DatabaseError, asDatabaseError, sqliteLayer } from "./sql";

export { DatabaseError } from "./sql";

/**
 * A rejected mutation. `conflict` means an operation ID was reused with different
 * input — the caller must not retry it as-is, and we must not write a second row.
 */
export class MutationError extends Schema.TaggedError<MutationError>()(
  "MutationError",
  {
    reason: Schema.Literals(["conflict", "unauthorized", "invalid"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/** A persisted row that no longer decodes against the contract. */
export class StoredRowError extends Schema.TaggedError<StoredRowError>()(
  "StoredRowError",
  {
    table: Schema.String,
    rowId: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.table}/${this.rowId} does not match the contract: ${this.detail}`;
  }
}

/**
 * The authenticated caller. Every field is derived from the bearer credential the
 * host issued when it created the session, never from anything the model said. A
 * worker cannot name a different intent, attempt or target by asking.
 */
export interface CallerContext {
  readonly callerScope: string;
  readonly targetId: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly harnessSessionId: string;
  readonly workerId: string;
}

export interface SeedInput {
  readonly targetId: string;
  readonly goalId: string;
  readonly goal: string;
  readonly intentId: string;
  readonly question: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly harnessSessionId: string | null;
}

export type AttemptStatus =
  "succeeded" | "failed" | "interrupted" | "uncertain";

export interface IntentRow {
  readonly intentId: string;
  readonly question: string;
  readonly targetId: string;
  readonly goal: string;
}

const SEQUENCE_NAME = "observations";

/** Stable key ordering so a retry hashes identically to the original call. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

const hashRequest = (
  caller: CallerContext,
  input: RecordObservationInput,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonical({ caller, input }))
    .digest("hex");

/** JSON text columns, declared once so reads and writes cannot disagree. */
const jsonList = Schema.fromJsonString(Schema.Array(Schema.String));
const jsonCases = Schema.fromJsonString(
  Schema.NonEmptyArray(ObservationTestCase),
);
const jsonConditions = Schema.fromJsonString(SummaryObservationConditions);

/**
 * The `record_format` column's values, keyed by the contract's `_tag`.
 *
 * Storage stays snake_case like every other identifier in the schema, and the domain
 * stays camelCase, so the two spellings are mapped here once rather than at each use.
 */
const STORED_FORMAT = {
  caseBased: "case_based",
  summary: "summary",
} as const satisfies Record<ObservationRecordFormat, string>;

/**
 * How an observation row is stored.
 *
 * JSON columns are declared as JSON *codecs*, so reading a row is a decode with a typed
 * failure rather than `JSON.parse(...) as string[]`. The format-specific columns are
 * nullable here because one table holds both formats; {@link toObservation} is what turns
 * `record_format` plus those nullables into the contract's discriminated union, and it
 * fails rather than guess if a row's columns do not match the format it claims. The
 * database enforces the same pairing with a `CHECK`, so this is belt and braces on
 * purpose: the constraint stops bad rows being written, and the decode stops a
 * hand-edited one being believed.
 *
 * `record_format` is read as a plain string rather than a literal union so that an
 * unrecognised value reaches {@link toObservation} and is reported against the row that
 * holds it, instead of failing as an anonymous decode error.
 */
const StoredObservationRow = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Int,
  record_format: Schema.String,
  target_id: Schema.String,
  intent_id: Schema.String,
  attempt_id: Schema.String,
  harness_session_id: Schema.String,
  worker_id: Schema.String,
  tested_claim: Schema.String,
  outcome: Schema.Literals(["positive", "negative", "inconclusive"]),
  interpretation: Schema.String,
  limitations: jsonList,
  untested_dimensions: jsonList,
  recorded_at: Schema.Finite,
  setup: Schema.NullOr(Schema.String),
  cases: Schema.NullOr(jsonCases),
  summary_conditions: Schema.NullOr(jsonConditions),
  summary_observed_behavior: Schema.NullOr(Schema.String),
  summary_evidence_refs: Schema.NullOr(jsonList),
});
type StoredObservationRow = typeof StoredObservationRow.Type;

/**
 * The columns every observation read selects, derived from the row schema itself.
 *
 * `Schema.Struct` exposes its own `fields` (`effect/src/Schema.ts:3511`) and
 * `Object.keys` over them is declaration order, so a column added to
 * {@link StoredObservationRow} is selected without a second edit here. Writing the list
 * out again is the one mistake this file's result schemas cannot catch: a `SELECT` that
 * omits a required column fails at execution, and the compiler is happy either way.
 *
 * Interpolating this into statement text is safe in a way a value never is: every name
 * comes from a literal field record in this module, so there is nothing here a caller
 * can reach. Values still go in as bound parameters.
 *
 * The `INSERT` in `recordObservation` is not derived this way, because a hand-derived
 * column list has to line up positionally with a `VALUES` clause and nothing would check
 * that it still did. The library's own `sql.insert(record)` does keep the two in lockstep
 * — it walks one record's keys to build both (`effect/src/sql/Statement.ts:952`) — and is
 * the right tool if that statement is ever rewritten.
 */
const observationColumns = Object.keys(StoredObservationRow.fields).join(", ");

const StoredReceipt = Schema.Struct({
  key: Schema.String,
  request_hash: Schema.String,
  result: Schema.fromJsonString(RecordObservationResult),
});

const SequenceRow = Schema.Struct({ value: Schema.Int });

const IntentJoinRow = Schema.Struct({
  intent_id: Schema.String,
  question: Schema.String,
  target_id: Schema.String,
  goal: Schema.String,
});

const AttemptRow = Schema.Struct({
  id: Schema.String,
  intent_id: Schema.String,
  target_id: Schema.String,
  worker_id: Schema.String,
  harness_session_id: Schema.NullOr(Schema.String),
  provider_id: Schema.String,
  model_id: Schema.String,
  status: Schema.String,
  started_at: Schema.Finite,
  ended_at: Schema.NullOr(Schema.Finite),
});
export type AttemptRow = typeof AttemptRow.Type;

/**
 * Turns one row into the contract's observation union.
 *
 * A row whose columns contradict its `record_format` is reported, not repaired. There is
 * no fallback that invents a `setup` for a summary row or a `conditions` for a case-based
 * one, because either would be a lie about what was recorded.
 */
const toObservation = (
  row: StoredObservationRow,
): Effect.Effect<Observation, StoredRowError> => {
  const provenance: ObservationProvenance = {
    targetId: row.target_id,
    intentId: row.intent_id,
    attemptId: row.attempt_id,
    harnessSessionId: row.harness_session_id,
    workerId: row.worker_id,
    recordedAt: row.recorded_at,
  };
  const common = {
    observationId: row.id,
    sequence: row.sequence,
    testedClaim: row.tested_claim,
    outcome: row.outcome,
    interpretation: row.interpretation,
    limitations: row.limitations,
    untestedDimensions: row.untested_dimensions,
    provenance,
  };
  const malformed = (detail: string) =>
    Effect.fail(
      new StoredRowError({
        table: "observations",
        rowId: row.id,
        detail,
        cause: { recordFormat: row.record_format },
      }),
    );

  if (row.record_format === STORED_FORMAT.caseBased) {
    if (row.setup === null || row.cases === null) {
      return malformed("a case-based row is missing its setup or cases");
    }
    return Effect.succeed({
      _tag: "caseBased",
      ...common,
      setup: row.setup,
      cases: row.cases,
    });
  }
  if (row.record_format === STORED_FORMAT.summary) {
    if (
      row.summary_conditions === null ||
      row.summary_observed_behavior === null ||
      row.summary_evidence_refs === null
    ) {
      return malformed("a summary row is missing its summary columns");
    }
    return Effect.succeed({
      _tag: "summary",
      ...common,
      conditions: row.summary_conditions,
      observedBehavior: row.summary_observed_behavior,
      evidenceRefs: row.summary_evidence_refs,
    });
  }
  return malformed(`unknown observation record format ${row.record_format}`);
};

/** A decode failure against a known table and row. */
const storedRow =
  (table: string, rowId: string) =>
  (cause: { readonly message: string }): StoredRowError =>
    new StoredRowError({ table, rowId, detail: cause.message, cause });

const makeStore = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Both layer constructors wait for the schema before publishing the service.
  // A failed migration fails layer acquisition instead of exposing a partial store.
  const applied = yield* migrate;
  if (applied.length > 0) {
    yield* Effect.logInfo(
      `applied migrations: ${applied.map(([id, name]) => `${id}_${name}`).join(", ")}`,
    );
  }

  /**
   * Creates the goal, intent and attempt a worker will be bound to.
   *
   * `ON CONFLICT DO NOTHING` keeps re-seeding the same attempt harmless, which is what
   * lets a demo be re-run against an existing database.
   */
  const seedAttempt = Effect.fn("ObservationStore.seedAttempt")(function* (
    input: SeedInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO goals (id, target_id, description, created_at)
            VALUES (${input.goalId}, ${input.targetId}, ${input.goal}, ${now})
            ON CONFLICT(id) DO NOTHING`;
          yield* sql`INSERT INTO intents (id, goal_id, target_id, question, created_at)
            VALUES (${input.intentId}, ${input.goalId}, ${input.targetId},
                    ${input.question}, ${now})
            ON CONFLICT(id) DO NOTHING`;
          yield* sql`INSERT INTO attempts (id, intent_id, target_id, worker_id,
              harness_session_id, provider_id, model_id, status, started_at)
            VALUES (${input.attemptId}, ${input.intentId}, ${input.targetId},
                    ${input.workerId}, ${input.harnessSessionId},
                    ${input.providerId}, ${input.modelId}, 'running', ${now})
            ON CONFLICT(id) DO NOTHING`;
        }),
      )
      .pipe(Effect.mapError(asDatabaseError("transaction")));
    return input.attemptId;
  });

  /**
   * Records the attempt's terminal status. This says only whether execution finished;
   * it never implies anything about what the test established (DECISIONS.md §15).
   */
  const settleAttempt = Effect.fn("ObservationStore.settleAttempt")(function* (
    attemptId: string,
    status: AttemptStatus,
  ) {
    const endedAt = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE attempts SET status = ${status}, ended_at = ${endedAt}
      WHERE id = ${attemptId}`.pipe(Effect.mapError(asDatabaseError("query")));
    return status;
  });

  const bindSessionToAttempt = Effect.fn(
    "ObservationStore.bindSessionToAttempt",
  )(function* (attemptId: string, harnessSessionId: string) {
    yield* sql`UPDATE attempts SET harness_session_id = ${harnessSessionId}
      WHERE id = ${attemptId}`.pipe(Effect.mapError(asDatabaseError("query")));
    return harnessSessionId;
  });

  const findReceipt = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: StoredReceipt,
    execute: (key) =>
      sql`SELECT key, request_hash, result FROM command_receipts WHERE key = ${key}`,
  });

  const bumpSequence = SqlSchema.findOne({
    Request: Schema.String,
    Result: SequenceRow,
    execute: (name) =>
      sql`INSERT INTO sequence_cursor (name, value) VALUES (${name}, 1)
        ON CONFLICT(name) DO UPDATE SET value = value + 1
        RETURNING value`,
  });

  /**
   * Writes one observation under the authenticated caller's identity.
   *
   * Receipt semantics, unchanged by the storage swap: an exact retry of `operationId`
   * returns the original result with `replayed: true` and writes nothing; the same ID
   * with different input fails as a conflict and writes nothing. The receipt key is
   * namespaced to `caller.callerScope`, so one worker's operation IDs can never collide
   * with or address another's.
   *
   * All four effects — the receipt lookup, the sequence bump, the observation insert and
   * the receipt insert — run in one transaction. A conflict short-circuits by failing
   * inside it, which rolls it back; that is why the sequence cannot advance on a refused
   * call.
   *
   * `recordedAt` comes from the `Clock`, not `Date.now()`, so a test can fix it.
   */
  const recordObservation = Effect.fn("ObservationStore.recordObservation")(
    function* (caller: CallerContext, input: RecordObservationInput) {
      const recordedAt = yield* Clock.currentTimeMillis;
      const key = `${caller.callerScope}:record_observation:${input.operationId}`;
      const requestHash = hashRequest(caller, input);

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* findReceipt(key).pipe(
              Effect.mapError((error) =>
                error._tag === "SqlError"
                  ? asDatabaseError("query")(error)
                  : storedRow("command_receipts", key)(error),
              ),
            );

            if (Option.isSome(existing)) {
              const receipt = existing.value;
              if (receipt.request_hash !== requestHash) {
                return yield* new MutationError({
                  reason: "conflict",
                  detail: `operation ${input.operationId} was already used with different input`,
                });
              }
              return { ...receipt.result, replayed: true };
            }

            // Allocated inside the transaction, so a sequence gap cannot outlive a rollback.
            const cursor = yield* bumpSequence(SEQUENCE_NAME).pipe(
              Effect.mapError((error) =>
                error._tag === "SqlError"
                  ? asDatabaseError("query")(error)
                  : storedRow(
                      "sequence_cursor",
                      SEQUENCE_NAME,
                    )({
                      message: String(error),
                    }),
              ),
            );
            const sequence = cursor.value;

            const observationId = `obs_${sequence.toString().padStart(6, "0")}_${caller.attemptId}`;
            const provenance: ObservationProvenance = {
              targetId: caller.targetId,
              intentId: caller.intentId,
              attemptId: caller.attemptId,
              harnessSessionId: caller.harnessSessionId,
              workerId: caller.workerId,
              recordedAt,
            };

            yield* sql`INSERT INTO observations (
              id, sequence, record_format, target_id, intent_id, attempt_id,
              harness_session_id, worker_id, tested_claim, outcome, interpretation,
              limitations, untested_dimensions, recorded_at, setup, cases,
              summary_conditions, summary_observed_behavior, summary_evidence_refs
            ) VALUES (
              ${observationId}, ${sequence}, ${STORED_FORMAT[OBSERVATION_WRITE_FORMAT]},
              ${caller.targetId}, ${caller.intentId}, ${caller.attemptId},
              ${caller.harnessSessionId}, ${caller.workerId},
              ${input.testedClaim}, ${input.outcome}, ${input.interpretation},
              ${JSON.stringify(input.limitations)},
              ${JSON.stringify(input.untestedDimensions)},
              ${recordedAt}, ${input.setup}, ${JSON.stringify(input.cases)},
              NULL, NULL, NULL
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

            const result: RecordObservationResult = {
              observationId,
              sequence,
              replayed: false,
              provenance,
            };

            yield* sql`INSERT INTO command_receipts (
              key, caller_scope, operation, operation_id, request_hash, result, created_at
            ) VALUES (
              ${key}, ${caller.callerScope}, 'record_observation',
              ${input.operationId}, ${requestHash}, ${JSON.stringify(result)},
              ${recordedAt}
            )`.pipe(Effect.mapError(asDatabaseError("transaction")));

            return result;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? asDatabaseError("transaction")(error)
              : error,
          ),
        );
    },
  );

  const selectForIntent = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredObservationRow,
    execute: (intentId) =>
      sql.unsafe(
        `SELECT ${observationColumns} FROM observations WHERE intent_id = ? ORDER BY sequence`,
        [intentId],
      ),
  });

  /** Observations for one intent, in store order, each in the format it was recorded in. */
  const observationsForIntent = Effect.fn(
    "ObservationStore.observationsForIntent",
  )(function* (intentId: string) {
    const rows = yield* selectForIntent(intentId).pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : storedRow("observations", `intent:${intentId}`)(error),
      ),
    );
    return yield* Effect.forEach(rows, toObservation);
  });

  const selectSequence = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SequenceRow,
    execute: (name) =>
      sql`SELECT value FROM sequence_cursor WHERE name = ${name}`,
  });

  const currentSequence = selectSequence(SEQUENCE_NAME).pipe(
    Effect.map(Option.getOrElse(() => ({ value: 0 }))),
    Effect.map((row) => row.value),
    Effect.mapError((error) =>
      error._tag === "SqlError"
        ? asDatabaseError("query")(error)
        : new DatabaseError({
            operation: "query",
            reason: "sequence_cursor did not decode",
            cause: error,
          }),
    ),
  );

  const selectIntent = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IntentJoinRow,
    execute: (intentId) =>
      sql`SELECT intents.id AS intent_id, intents.question AS question,
            intents.target_id AS target_id, goals.description AS goal
          FROM intents
          INNER JOIN goals ON intents.goal_id = goals.id
          WHERE intents.id = ${intentId}`,
  });

  const loadIntent = Effect.fn("ObservationStore.loadIntent")(function* (
    intentId: string,
  ) {
    const row = yield* selectIntent(intentId).pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : new DatabaseError({
              operation: "query",
              reason: "intents row did not decode",
              cause: error,
            }),
      ),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: (value): IntentRow => ({
        intentId: value.intent_id,
        question: value.question,
        targetId: value.target_id,
        goal: value.goal,
      }),
    });
  });

  const selectAttempt = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String, targetId: Schema.String }),
    Result: AttemptRow,
    execute: (request) =>
      sql`SELECT id, intent_id, target_id, worker_id, harness_session_id,
            provider_id, model_id, status, started_at, ended_at
          FROM attempts
          WHERE id = ${request.id} AND target_id = ${request.targetId}`,
  });

  const loadAttempt = Effect.fn("ObservationStore.loadAttempt")(function* (
    attemptId: string,
    targetId: string,
  ) {
    const row = yield* selectAttempt({ id: attemptId, targetId }).pipe(
      Effect.mapError((error) =>
        error._tag === "SqlError"
          ? asDatabaseError("query")(error)
          : storedRow("attempts", attemptId)(error),
      ),
    );
    return Option.getOrUndefined(row);
  });

  return ObservationStore.of({
    seedAttempt,
    settleAttempt,
    bindSessionToAttempt,
    recordObservation,
    observationsForIntent,
    currentSequence,
    loadIntent,
    loadAttempt,
  });
});

export class ObservationStore extends Context.Service<
  ObservationStore,
  {
    readonly seedAttempt: (
      input: SeedInput,
    ) => Effect.Effect<string, DatabaseError>;
    readonly settleAttempt: (
      attemptId: string,
      status: AttemptStatus,
    ) => Effect.Effect<AttemptStatus, DatabaseError>;
    readonly bindSessionToAttempt: (
      attemptId: string,
      harnessSessionId: string,
    ) => Effect.Effect<string, DatabaseError>;
    readonly recordObservation: (
      caller: CallerContext,
      input: RecordObservationInput,
    ) => Effect.Effect<
      RecordObservationResult,
      MutationError | DatabaseError | StoredRowError
    >;
    readonly observationsForIntent: (
      intentId: string,
    ) => Effect.Effect<readonly Observation[], DatabaseError | StoredRowError>;
    readonly currentSequence: Effect.Effect<number, DatabaseError>;
    readonly loadIntent: (
      intentId: string,
    ) => Effect.Effect<IntentRow | undefined, DatabaseError>;
    readonly loadAttempt: (
      attemptId: string,
      targetId: string,
    ) => Effect.Effect<AttemptRow | undefined, DatabaseError | StoredRowError>;
  }
>()("bit/persistence/ObservationStore") {
  /** Opens and migrates the database before exposing the store for this scope. */
  static readonly layer = (filename: string) =>
    Layer.effect(ObservationStore, makeStore()).pipe(
      Layer.provide(sqliteLayer(filename)),
    );

  /** Migrates an already-provided `SqlClient` before exposing the store over it. */
  static readonly layerWithClient = Layer.effect(ObservationStore, makeStore());
}
