/**
 * Schema migrations, run by `effect/sql`'s migrator (DECISIONS.md §3 "migrations").
 *
 * Each migration is an Effect keyed `<id>_<name>` in {@link MIGRATIONS}. They are
 * **static imports in a literal record**, not a filesystem scan: `Migrator.fromRecord`
 * (`effect/src/sql/Migrator.ts:410-423`) sorts them by id and the bundler sees every one
 * of them, so `bun build` cannot drop a migration the way a glob loader would.
 *
 * What the migrator gives us, verified against the installed 4.0.5 and the driver:
 *
 * - A journal table, `effect_sql_migrations (migration_id, name, created_at)`, created
 *   on demand.
 * - **Pending-only application.** It reads the highest applied `migration_id` and skips
 *   everything at or below it, so a repeated startup re-runs nothing. An `ALTER TABLE`
 *   that would fail on a second run therefore does not get a second run.
 * - **Transactional failure.** The whole run — journal inserts and migration bodies
 *   alike — happens inside one `sql.withTransaction` (`Migrator.ts:321`), and SQLite
 *   makes DDL transactional, so a migration that throws leaves neither its schema change
 *   nor its journal row behind.
 *
 * What it does **not** give us, stated plainly: there is no `down`, no `redo` and no
 * `undo`. `MigratorOptions` has a loader and nothing else, and `ResolvedMigration` is
 * `[id, name, load]` with a single effect — there is no reverse direction anywhere in
 * the module. Nor is one being built here. The way to retract a migration is a new
 * forward migration that corrects it; the way to check a chain still builds from nothing
 * is to replay it into a throwaway file, which `migrations.test.ts` does.
 *
 * A second honest note: a failing migration arrives as a **defect**, not a typed error.
 * `Migrator.runMigration` wraps the body in `Effect.die(new MigrationError(...))`
 * (`Migrator.ts:221-233`), so a caller that only handles the error channel will see the
 * fiber die. {@link migrate} converts that back into a typed {@link DatabaseError}.
 *
 * **Never edit an applied migration.** `0001` reproduces the superseded `CREATE TABLE IF
 * NOT EXISTS` bootstrap byte for byte, because that is what makes an existing database
 * adoptable: a file created by that bootstrap has these tables but no journal, so `0001`
 * runs against it as a no-op and only the later entries do real work. Replaying the same
 * chain into an empty file produces the same schema.
 *
 * That rule is why `0002` below still names the columns it originally created, which the
 * naming cleanup in `0003` renamed. `0002` has been applied to a development database,
 * so its body is frozen; the identifiers in it are a historical record of how that file
 * reached its current state, not the names anything reads or writes today. After `0003`
 * no database — fresh or upgraded — has a column by those names, and the active schema
 * is the one `0003` leaves behind.
 *
 * **Migration ids are not contract versions.** This chain numbers schema changes made
 * during development. The observation contract is at version 1 and has never been
 * published (`packages/contracts/src/observation.ts` `OBSERVATION_CONTRACT_VERSION`);
 * the length of this chain does not imply a release history.
 */
import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Cause, Effect } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { DatabaseError, asDatabaseError } from "./sql";

/**
 * Runs statements in order, leaving the driver's `SqlError` in the error channel.
 *
 * It is deliberately not `orDie`'d. `Migrator.runMigration` catches a *typed* failure
 * and replaces it with `MigrationError{ kind: "Failed", message: 'Migration "2_x"
 * failed' }` (`effect/src/sql/Migrator.ts:221-233`); a migration that dies instead
 * bypasses that and reports only SQLite's own message, with no indication of which
 * migration produced it.
 */
const statements = (
  ...sql: ReadonlyArray<string>
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    for (const statement of sql) {
      yield* client.unsafe(statement);
    }
  });

/**
 * `0001` — the delegation-and-memory slice as it was first created.
 *
 * Reproduced unchanged from the superseded bootstrap so that the adoption path works:
 * on a database the old code already created, every statement here is a no-op.
 */
const createSlice = statements(
  `CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    target_id TEXT NOT NULL,
    question TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS intents_goal_idx ON intents(goal_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    target_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    harness_session_id TEXT,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS attempts_intent_idx ON attempts(intent_id)`,
  `CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    harness_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    tested_claim TEXT NOT NULL,
    outcome TEXT NOT NULL,
    conditions TEXT NOT NULL,
    observed_behavior TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    evidence_refs TEXT NOT NULL,
    limitations TEXT NOT NULL,
    untested_dimensions TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
  `CREATE TABLE IF NOT EXISTS command_receipts (
    key TEXT PRIMARY KEY,
    caller_scope TEXT NOT NULL,
    operation TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS command_receipts_scope_idx ON command_receipts(caller_scope)`,
  `CREATE TABLE IF NOT EXISTS sequence_cursor (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )`,
);

/**
 * `0002` — observations carry several cases, and older rows stay what they are.
 *
 * Rebuilds `observations` rather than altering it in place. `ALTER TABLE ADD COLUMN`
 * cannot express what is needed: the summary columns have to become nullable (a
 * case-based row has no singular `conditions`), the case columns have to be nullable too
 * (a summary row has no `cases`), and the pairing between them has to be enforced. A
 * `CHECK` is the only thing that stops a row claiming to be both or neither, and SQLite
 * can only add one by rebuilding.
 *
 * Existing rows are carried across with their `conditions`, `observed_behavior` and
 * `evidence_refs` verbatim. Nothing is parsed, re-split or re-attributed: the stored
 * prose describes several identities in one string and a single total request count, so
 * inventing per-actor actions out of it would be fabrication (DECISIONS.md §21). The rows
 * keep their ids, sequences, outcomes and provenance, so every receipt that names them
 * still resolves.
 *
 * **Frozen.** The column and table identifiers in the statements below are the ones this
 * migration created in an already-migrated development database, and `0003` renames them
 * to the active schema. They are left spelled as applied because re-spelling them here
 * would change what a replay produces without changing what that database contains.
 */
const addObservationCases = statements(
  `CREATE TABLE observations_v2 (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    harness_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    tested_claim TEXT NOT NULL,
    outcome TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    limitations TEXT NOT NULL,
    untested_dimensions TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    setup TEXT,
    cases TEXT,
    legacy_conditions TEXT,
    legacy_observed_behavior TEXT,
    legacy_evidence_refs TEXT,
    CHECK (
      (schema_version = 2
        AND setup IS NOT NULL
        AND cases IS NOT NULL
        AND legacy_conditions IS NULL
        AND legacy_observed_behavior IS NULL
        AND legacy_evidence_refs IS NULL)
      OR
      (schema_version = 1
        AND setup IS NULL
        AND cases IS NULL
        AND legacy_conditions IS NOT NULL
        AND legacy_observed_behavior IS NOT NULL
        AND legacy_evidence_refs IS NOT NULL)
    )
  )`,
  `INSERT INTO observations_v2 (
    id, sequence, schema_version, target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    setup, cases,
    legacy_conditions, legacy_observed_behavior, legacy_evidence_refs
  )
  SELECT
    id, sequence, 1, target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    NULL, NULL,
    conditions, observed_behavior, evidence_refs
  FROM observations`,
  `DROP TABLE observations`,
  `ALTER TABLE observations_v2 RENAME TO observations`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
  `CREATE INDEX IF NOT EXISTS observations_version_idx ON observations(schema_version)`,
);

/**
 * `0003` — the stored schema says which record *format* a row is, not a version number.
 *
 * `0002` left two things that read as released version history and are not. The column
 * `schema_version` held `1` or `2`, and three columns were named for being superseded
 * rather than for what they hold. Nothing has ever been published: the observation
 * contract is at version 1, and `caseBased` and `summary` are two formats of it
 * (`packages/contracts/src/observation.ts`). So the column becomes `record_format` with
 * the format name in it, and the three columns are named after the format they belong to.
 *
 * This is a development rename, not a compatibility layer. It is a forward migration
 * because `0002` has already been applied to a development database and the append-only
 * rule holds; it carries every row, receipt and cursor across unchanged, and it is the
 * last place the old identifiers appear.
 *
 * A rebuild rather than `ALTER TABLE RENAME COLUMN` for one reason: the `CHECK` that
 * enforces the format/columns pairing names `schema_version`, and SQLite has no way to
 * replace a `CHECK` on an existing table. Renaming the column would leave a constraint
 * written in the old vocabulary behind it.
 */
const nameObservationRecordFormat = statements(
  `CREATE TABLE observations_normalized (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    record_format TEXT NOT NULL,
    target_id TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    harness_session_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    tested_claim TEXT NOT NULL,
    outcome TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    limitations TEXT NOT NULL,
    untested_dimensions TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    setup TEXT,
    cases TEXT,
    summary_conditions TEXT,
    summary_observed_behavior TEXT,
    summary_evidence_refs TEXT,
    CHECK (
      (record_format = 'case_based'
        AND setup IS NOT NULL
        AND cases IS NOT NULL
        AND summary_conditions IS NULL
        AND summary_observed_behavior IS NULL
        AND summary_evidence_refs IS NULL)
      OR
      (record_format = 'summary'
        AND setup IS NULL
        AND cases IS NULL
        AND summary_conditions IS NOT NULL
        AND summary_observed_behavior IS NOT NULL
        AND summary_evidence_refs IS NOT NULL)
    )
  )`,
  // The two source values `0002` could have written map one-to-one onto the two format
  // names. A row holding anything else is left for the `CHECK` to refuse, rather than
  // silently filed under one of them.
  `INSERT INTO observations_normalized (
    id, sequence, record_format, target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    setup, cases,
    summary_conditions, summary_observed_behavior, summary_evidence_refs
  )
  SELECT
    id, sequence,
    CASE schema_version
      WHEN 2 THEN 'case_based'
      WHEN 1 THEN 'summary'
      ELSE 'unknown_format_' || CAST(schema_version AS TEXT)
    END,
    target_id, intent_id, attempt_id,
    harness_session_id, worker_id, tested_claim, outcome, interpretation,
    limitations, untested_dimensions, recorded_at,
    setup, cases,
    legacy_conditions, legacy_observed_behavior, legacy_evidence_refs
  FROM observations`,
  `DROP TABLE observations`,
  `ALTER TABLE observations_normalized RENAME TO observations`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX IF NOT EXISTS observations_intent_idx ON observations(intent_id)`,
  `CREATE INDEX IF NOT EXISTS observations_record_format_idx ON observations(record_format)`,
);

/**
 * `0004` — attempts carry durable recovery state and a write fence.
 *
 * Four columns and one table, added rather than rebuilt: no `CHECK` is involved, so
 * `ALTER TABLE ADD COLUMN` is sufficient and leaves every existing row and index alone.
 *
 * - `write_fence` is the attempt's write authority epoch. A credential is issued
 *   against the value the attempt had at the time, and a write presenting a superseded
 *   fence is refused. Recovery bumps it, which is what makes "the old authority is
 *   revoked" a durable fact rather than an in-memory one that a restart forgets.
 *   Existing rows default to `0`, which is the fence their credentials would have
 *   carried, so no already-settled attempt is retroactively fenced out.
 * - `recovery_disposition` and `recovered_at` say *how* an attempt reached its status
 *   when reconciliation decided it, as opposed to the worker's own settlement. Null
 *   means reconciliation never touched it.
 * - `replaces_attempt_id` points at the attempt a replacement was opened for. Work is
 *   never resumed under an abandoned attempt's identity, so the link has to live
 *   somewhere; this is it.
 *
 * `attempt_recoveries` is the append-only-in-spirit record of what the harness said
 * and what we did about it. The primary key created here is
 * `(attempt_id, observed_status, resulting_status)`, the intent being that reconciling
 * twice with the same answer updates one row instead of writing a second: repeating a
 * reconciliation must not manufacture history. `times` and `last_reconciled_at` keep the
 * repeat visible rather than hiding it.
 *
 * **That key was too narrow, and `0006` replaces it.** Those three columns do not
 * identify a reconciliation: a pass that settles a running attempt and a later pass that
 * finds it already final can agree on the observed and the resulting status while
 * deciding different things, and the second would then land on the first's row. This
 * body stays as applied; `0006` rebuilds the table with the disposition, the prior
 * status and both fence values in the key.
 *
 * It keeps its implicit `rowid` deliberately — not `WITHOUT ROWID` — because insertion
 * order is the only stable way to read "in the order first seen": two reconciliations in
 * the same millisecond are ordinary, and a timestamp cannot order them.
 *
 * `observations_at_recovery` is recorded as a fact about our own store at that instant
 * and is **never** an input to the disposition. A session that wrote no observation may
 * still have changed the target; inferring "nothing happened" from "we hold nothing"
 * is precisely the mistake this column must not be used to make.
 */
const addAttemptRecovery = statements(
  `ALTER TABLE attempts ADD COLUMN write_fence INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE attempts ADD COLUMN recovery_disposition TEXT`,
  `ALTER TABLE attempts ADD COLUMN recovered_at INTEGER`,
  `ALTER TABLE attempts ADD COLUMN replaces_attempt_id TEXT REFERENCES attempts(id)`,
  `CREATE INDEX IF NOT EXISTS attempts_status_idx ON attempts(status)`,
  `CREATE TABLE attempt_recoveries (
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    observed_status TEXT NOT NULL,
    resulting_status TEXT NOT NULL,
    disposition TEXT NOT NULL,
    detail TEXT NOT NULL,
    harness_session_id TEXT,
    fence_before INTEGER NOT NULL,
    fence_after INTEGER NOT NULL,
    observations_at_recovery INTEGER NOT NULL,
    first_reconciled_at INTEGER NOT NULL,
    last_reconciled_at INTEGER NOT NULL,
    times INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, observed_status, resulting_status)
  )`,
  `CREATE INDEX IF NOT EXISTS attempt_recoveries_attempt_idx
     ON attempt_recoveries(attempt_id)`,
);

/**
 * `0005` — an observation can say which earlier untested dimension it took on.
 *
 * One row per (addressing observation, address) pair, which is the primary key: the
 * same observation naming the same address twice is one link, not two, and a retry that
 * replays a receipt writes no link at all because it writes nothing.
 *
 * Both sides are real foreign keys to `observations(id)`, so a link cannot name a row
 * that does not exist, and `address` keeps the exact text the worker submitted so the
 * stored link reads the same way the briefing printed it. The `dimension_index` is the
 * parsed half of that address, stored because that is what the validity check resolved
 * it to — a reader does not have to re-parse to see which position was meant.
 *
 * There is deliberately **no** intent column. Which intent a link belongs to is its
 * addressing observation's intent, and duplicating it here would be a second answer to
 * a question that already has one. The same-intent rule is enforced at the write
 * boundary and read back through a join.
 *
 * Note for any future rebuild of `observations`: SQLite rewrites `REFERENCES` clauses on
 * `ALTER TABLE ... RENAME TO`, so the rebuild-and-rename pattern `0002` and `0003` use
 * keeps these two foreign keys pointing at the surviving table. A rebuild that drops the
 * old table *before* renaming the new one would not.
 */
const addDimensionFollowUps = statements(
  `CREATE TABLE observation_dimension_links (
    observation_id TEXT NOT NULL REFERENCES observations(id),
    address TEXT NOT NULL,
    source_observation_id TEXT NOT NULL REFERENCES observations(id),
    dimension_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (observation_id, address)
  )`,
  `CREATE INDEX IF NOT EXISTS observation_dimension_links_source_idx
     ON observation_dimension_links(source_observation_id)`,
);

/**
 * `0006` — a recovery record is identified by the whole reconciliation state.
 *
 * `0004`'s key was `(attempt_id, observed_status, resulting_status)`. Those three
 * columns conflate dispositions. Reconcile a running attempt whose harness says
 * `succeeded` and the pass is `settled`, `running -> succeeded`, fence `0 -> 1`; ask
 * again and the pass is `already_final`, `succeeded -> succeeded`, fence `1 -> 1`. Same
 * attempt, same observed status, same resulting status — so the second upsert landed on
 * the first row, left `disposition = 'settled'` standing over a `detail` text that said
 * `already_final`, and handed the caller back the first pass's fence movement as though
 * it were its own.
 *
 * The key becomes `(attempt_id, observed_status, prior_status, resulting_status,
 * disposition, fence_before, fence_after)`: the complete state of one reconciliation.
 * Repeating that exact state still increments `times` — which is the property the
 * original key was reaching for — while a pass that decided anything different gets its
 * own row. Because the fences are in the key, no column outside it can disagree with the
 * pass that wrote it, so what `recordRecovery` returns and what the table holds are the
 * same values.
 *
 * A rebuild rather than `ALTER TABLE`: SQLite cannot add a column to a primary key, and
 * cannot replace one.
 *
 * **Every existing row is carried across with its `times`, its timestamps and its
 * disposition.** `prior_status` did not exist, so it is derived from what each row
 * already records, and the derivation is exact rather than a guess:
 *
 * - `already_final` can only have been decided about an attempt already in its
 *   resulting status, so the prior status *is* `resulting_status`;
 * - `refined` and `unresumable` are only reachable from `uncertain`;
 * - `still_running` and `settled` are only reachable from `running`;
 * - a disposition of `uncertain` is reachable from both, and the fence tells which: the
 *   fence is bumped exactly when an attempt leaves `running`, so `fence_after >
 *   fence_before` means the prior status was `running` and an unchanged fence means it
 *   was already `uncertain`.
 *
 * Any other disposition — nothing writes one, but an adopted database is not something
 * we get to assume about — is carried across with `prior_status = 'unrecorded'` rather
 * than filed under a status it may not have held.
 *
 * **What this migration cannot reconstruct.** A row the old key already conflated has
 * lost the distinction: a `settled` row with `times = 2` whose second pass was really
 * `already_final` arrives here as one row saying the settle was seen twice. Splitting it
 * would mean inventing a `first_reconciled_at` for a pass whose timestamp the upsert
 * overwrote, so such a row is carried across as recorded. The new key stops it happening
 * again; it does not rewrite what the old one already lost. No database in this
 * repository holds one — the development file's two rows are single settles, and the one
 * repeated row in the proof evidence is a `still_running` repeat, which the new key
 * keeps as one row anyway — so that path is exercised by `migrations.test.ts` rather
 * than by live data.
 *
 * Rows are copied in `rowid` order so that "in the order first seen" — which is what
 * `recoveriesForAttempt` reads — survives the rebuild.
 */
const keyRecoveriesByState = statements(
  `CREATE TABLE attempt_recoveries_by_state (
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    observed_status TEXT NOT NULL,
    prior_status TEXT NOT NULL,
    resulting_status TEXT NOT NULL,
    disposition TEXT NOT NULL,
    detail TEXT NOT NULL,
    harness_session_id TEXT,
    fence_before INTEGER NOT NULL,
    fence_after INTEGER NOT NULL,
    observations_at_recovery INTEGER NOT NULL,
    first_reconciled_at INTEGER NOT NULL,
    last_reconciled_at INTEGER NOT NULL,
    times INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, observed_status, prior_status, resulting_status,
                 disposition, fence_before, fence_after)
  )`,
  `INSERT INTO attempt_recoveries_by_state (
    attempt_id, observed_status, prior_status, resulting_status, disposition, detail,
    harness_session_id, fence_before, fence_after, observations_at_recovery,
    first_reconciled_at, last_reconciled_at, times
  )
  SELECT
    attempt_id, observed_status,
    CASE disposition
      WHEN 'already_final' THEN resulting_status
      WHEN 'refined' THEN 'uncertain'
      WHEN 'unresumable' THEN 'uncertain'
      WHEN 'still_running' THEN 'running'
      WHEN 'settled' THEN 'running'
      WHEN 'uncertain' THEN
        CASE WHEN fence_after > fence_before THEN 'running' ELSE 'uncertain' END
      ELSE 'unrecorded'
    END,
    resulting_status, disposition, detail,
    harness_session_id, fence_before, fence_after, observations_at_recovery,
    first_reconciled_at, last_reconciled_at, times
  FROM attempt_recoveries
  ORDER BY rowid`,
  `DROP TABLE attempt_recoveries`,
  `ALTER TABLE attempt_recoveries_by_state RENAME TO attempt_recoveries`,
  `CREATE INDEX IF NOT EXISTS attempt_recoveries_attempt_idx
     ON attempt_recoveries(attempt_id)`,
);

/**
 * `0007` — one planner session lineage per target, so planner rounds share a cache key.
 *
 * This table holds no knowledge. It records which harness session later planner rounds
 * on a target should be opened under, and it exists because OpenCode derives a provider
 * cache key per session lineage (`parentID ?? fork.sessionID ?? id`): rounds that name
 * the same parent reuse the prefix they have already sent, and separately created
 * top-level sessions never do, however identical their briefings. Without a row to come
 * back to, that only works within one process, and a hunt is not one process.
 *
 * `target_id` is the key rather than `intent_id` deliberately. A briefing's stable part
 * is per intent, so two rounds on one intent reuse the most; but two rounds on different
 * intents of the same target still share the system prompt and the tool definitions,
 * which is worth more than nothing and costs nothing to have.
 *
 * The session id is **not** a foreign key to anything, because it names a row in
 * OpenCode's storage rather than ours, and that storage can be cleared without our
 * knowing. A caller is therefore expected to treat a recorded lineage as a hint it must
 * confirm, and to record a new one when it cannot — see `runPlannerPhase`.
 *
 * Nothing reads this to answer a question about the investigation. If the table were
 * dropped, every briefing and every observation would be unchanged and the next planner
 * round would simply pay for its own prefix.
 */
const addPlannerLineages = statements(
  `CREATE TABLE planner_lineages (
    target_id TEXT PRIMARY KEY,
    harness_session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
);

/**
 * The ordered chain. Append only; never edit an entry that has shipped.
 *
 * The key's numeric prefix is the id the journal records, and the rest is its name, so
 * renaming a key changes what the journal reports for an already-applied migration.
 */
export const MIGRATIONS: Record<
  string,
  Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
> = {
  "0001_delegation_memory_slice": createSlice,
  "0002_observation_cases": addObservationCases,
  "0003_observation_record_format": nameObservationRecordFormat,
  "0004_attempt_recovery": addAttemptRecovery,
  "0005_dimension_followups": addDimensionFollowUps,
  "0006_recovery_state_key": keyRecoveriesByState,
  "0007_planner_lineage": addPlannerLineages,
};

/** The migrator's loader over {@link MIGRATIONS}. */
export const migrationLoader = SqliteMigrator.fromRecord(MIGRATIONS);

/**
 * Applies pending migrations, returning the `[id, name]` pairs this call applied.
 *
 * An empty array means the database was already current — which is the normal result of
 * every startup after the first, and what proves nothing re-ran.
 *
 * The defect-to-failure conversion is the point of this wrapper. `Migrator` dies on a
 * failed migration, so without it a bad migration would tear down the fiber with no
 * typed error for a caller to report or a test to assert on.
 */
export const migrate: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  DatabaseError,
  SqlClient.SqlClient
> = runMigrations({ loader: migrationLoader });

/**
 * Runs an arbitrary migration chain with the typed-failure conversion.
 *
 * Exported for the tests, which need to drive deliberately broken and deliberately
 * partial chains through exactly the same code path the real one uses — a rollback
 * assertion against a different runner would prove nothing about this one.
 */
export function runMigrations<R = never>(
  options: SqliteMigrator.MigratorOptions<R>,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  DatabaseError,
  SqlClient.SqlClient | R
> {
  return SqliteMigrator.run(options).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(migrationFailure(cause as Cause.Cause<unknown>)),
    ),
  );
}

/** Renders whichever channel the migrator actually used as one typed failure. */
const migrationFailure = (cause: Cause.Cause<unknown>): DatabaseError => {
  for (const reason of cause.reasons) {
    const value = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    if (value === undefined) continue;
    if (value instanceof DatabaseError) return value;
    const tagged = value as { _tag?: string; kind?: string; message?: string };
    if (tagged._tag === "MigrationError") {
      return new DatabaseError({
        operation: "migrate",
        reason: `${tagged.kind}: ${tagged.message}`,
        cause: value,
      });
    }
    if (tagged._tag === "SqlError") {
      return asDatabaseError("migrate")(value as never);
    }
  }
  return new DatabaseError({
    operation: "migrate",
    reason: Cause.pretty(cause),
    cause,
  });
};
