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
 * `0008` — an untested dimension is a row with its own identity, and a link points at it.
 *
 * §22 recorded the limit this removes: a dimension address is positional, which "is only
 * sound while observations are immutable", and anything that ever edits, merges or
 * rewords a recorded dimension "needs its own identity scheme rather than this one
 * stretched to fit". So the dimensions stored as a JSON array inside each observation
 * become rows, each with an id that does not encode where it sits.
 *
 * **The backfill is an unnest, not a parse.** `json_each` is available in the SQLite
 * that `bun:sqlite` links (3.53.4 here), and its `key` column is the array index as an
 * integer, so one `INSERT ... SELECT` reproduces exactly the positions every address
 * already implied. Ordering by `(sequence, key)` is cosmetic — the `rowid`s then run in
 * graph order — because `(observation_id, position)` is what anything reads by.
 *
 * Three ways this refuses to lose data quietly rather than three ways it could:
 *
 * - An observation whose `untested_dimensions` is a JSON scalar rather than an array
 *   yields a row with a `NULL` key, which the `NOT NULL` on `position` aborts on.
 *   Malformed JSON makes `json_each` itself raise. Either way the migration fails, rolls
 *   back and fails startup, which is what a corrupt list deserves.
 * - The links rebuild joins with a **`LEFT JOIN` into a `NOT NULL` column**. A link whose
 *   `(source_observation_id, dimension_index)` has no dimension row produces a `NULL`
 *   `dimension_id` and aborts the whole migration. An `INNER JOIN` would have dropped
 *   that link silently, which is the one outcome a repoint must not have. No such link
 *   can exist — `0005`'s write boundary bounds-checked the index against the stored list
 *   — so this is a guard against what we have not thought of rather than against a known
 *   case, and `migrations.test.ts` manufactures one to prove the guard fires.
 * - `UNIQUE (observation_id, position)` means the same position cannot be unnested twice.
 *
 * The ids are random rather than derived from `(observation_id, position)`, and that is
 * the point of the whole migration: an id spelled `obs_x#u1` would make position the
 * identity again and the table would be decoration. `<observationId>#u<index>` survives
 * as the **wire alias** — it is what a briefing prints and what a worker copies — and is
 * resolved to a `dimension_id` at the write boundary. Nothing worker-facing changes.
 *
 * `created_at` is the raising observation's own `recorded_at`, not the migration's clock:
 * the dimension was recorded when its observation was, and stamping it "now" would make
 * every backfilled row claim to have been created during an upgrade.
 *
 * The links table is rebuilt rather than altered because SQLite cannot change a foreign
 * key in place, in the manner of `0006`. It drops `source_observation_id` and
 * `dimension_index`, which are now the dimension row's own columns: duplicating them here
 * would be a second answer to a question that already has one, exactly as `0005` argued
 * about the intent column. `address` stays, verbatim as the worker submitted it, because
 * that is a fact about the request rather than derived state.
 */
const addObservationDimensionRows = statements(
  `CREATE TABLE observation_dimensions (
    id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES observations(id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (observation_id, position),
    CHECK (position >= 0)
  )`,
  `INSERT INTO observation_dimensions (id, observation_id, position, text, created_at)
   SELECT 'dim_' || lower(hex(randomblob(16))), o.id, j.key, j.value, o.recorded_at
   FROM observations AS o, json_each(o.untested_dimensions) AS j
   ORDER BY o.sequence, j.key`,
  `CREATE TABLE observation_dimension_links_by_id (
    observation_id TEXT NOT NULL REFERENCES observations(id),
    dimension_id TEXT NOT NULL REFERENCES observation_dimensions(id),
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (observation_id, dimension_id)
  )`,
  `INSERT INTO observation_dimension_links_by_id
     (observation_id, dimension_id, address, created_at)
   SELECT links.observation_id, dimensions.id, links.address, links.created_at
   FROM observation_dimension_links AS links
   LEFT JOIN observation_dimensions AS dimensions
     ON dimensions.observation_id = links.source_observation_id
    AND dimensions.position = links.dimension_index
   ORDER BY links.rowid`,
  `DROP TABLE observation_dimension_links`,
  `ALTER TABLE observation_dimension_links_by_id
     RENAME TO observation_dimension_links`,
  `CREATE INDEX IF NOT EXISTS observation_dimension_links_dimension_idx
     ON observation_dimension_links(dimension_id)`,
);

/**
 * `0009` — an intent may declare which dimension it addresses.
 *
 * One nullable column, added rather than rebuilt: a foreign key whose default is `NULL`
 * is the one kind `ALTER TABLE ADD COLUMN` accepts, and no `CHECK` is involved.
 *
 * It buys three things (DECISIONS.md §17, "one derivation, not a stored flag"). The
 * briefing state `scheduled` becomes *derivable* — a later round can tell "nobody has
 * looked at this" from "work is out for this" — rather than being a flag somebody has to
 * remember to clear. Duplicate-intent detection becomes a join rather than the prose
 * matching §4 warns against. And it is the recorded lineage that lets the write boundary
 * relax its same-intent rule to *same goal, when the caller's own intent declares that
 * dimension*, so a planner can answer a dimension with a new intent — which is a path no
 * worker could close before.
 *
 * `NULL` is the ordinary case and means only that the intent did not say; it is never
 * "this intent addresses nothing".
 *
 * **This id was `0010` while `0009` was reserved for dispositions, and was moved down.**
 * §17's plan reserved `0009_dimension_dispositions`, which waits for Sprint 07 because a
 * planner round has no attempt to authenticate with. Leaving the hole would have burned
 * the id: the migrator reads the highest id *this database's* journal holds and skips
 * everything at or below it, so a `0009` added later applies to a fresh database and
 * never to one already past it — the two then disagree about their schema and nothing
 * says so. The chain is contiguous instead, and dispositions take the next free id.
 */
const addIntentDimensionProvenance = statements(
  `ALTER TABLE intents ADD COLUMN addresses_dimension TEXT
     REFERENCES observation_dimensions(id)`,
  `CREATE INDEX IF NOT EXISTS intents_addresses_dimension_idx
     ON intents(addresses_dimension)`,
);

/**
 * `0010` — assets, with type-specific identity and every discovery kept.
 *
 * This is §6's **domain identity**, which is the third of the three questions at the
 * mutation boundary and the one the other two cannot answer: two distinct operations may
 * discover the same canonical asset, and the right outcome is one asset with two
 * discovery records — not two assets, and not one discovery silently overwriting the
 * other.
 *
 * So `assets` is the merged identity and `asset_discoveries` is append-only provenance.
 * `UNIQUE (target_id, kind, identity)` is where the merge happens, in the schema rather
 * than in a handler that might forget: a second discovery of the same canonical identity
 * cannot create a second row even if a caller tries.
 *
 * **Identity is type-specific and deliberately small** (DECISIONS.md §17, "concrete asset
 * identity rules"), covering only the two kinds the fixture presents:
 *
 * - `host` — `host:port`, lowercased, with the scheme's default port made explicit so
 *   `http://x` and `http://x:80` are one host rather than two.
 * - `endpoint` — `METHOD scheme://host:port/path`. Query and fragment are **excluded**:
 *   including them mints a new asset per parameter value and turns a surface inventory
 *   into a request log. The full submission is kept verbatim on every discovery row, so
 *   nothing is lost — it is just not identity.
 *
 * **Role is not part of endpoint identity, and that is a decision with a reason.** The
 * same URL and method tested as an administrator and as an anonymous caller is one
 * endpoint; splitting it by role would make the coverage denominator §17 warns about
 * lie — two assets where one exists — and would mean "we probed /admin unauthenticated"
 * never counted as having touched `/admin` at all. Role is a property of the test, not of
 * the thing tested, and it is already recorded where it belongs: on an observation's
 * actors. The cost is stated as a limitation: an endpoint that is genuinely two different
 * endpoints depending on who calls it is one row here, and only its observations
 * distinguish them.
 *
 * The columns are nullable per kind and paired by a `CHECK`, the way `0003` pairs the two
 * observation formats, so a row cannot claim to be a host and carry a method. `identity`
 * is stored rather than computed on read because it is what the unique index is on, and a
 * normalisation rule that changed would otherwise silently re-partition existing rows.
 *
 * `asset_discoveries` is keyed `(asset_id, operation_id)`: one discovery per operation, so
 * a replayed command adds nothing and two genuinely different operations that found the
 * same asset both survive. It records the intent and attempt that found it, which is the
 * provenance §6 requires retaining through a merge.
 */
const addAssets = statements(
  `CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    identity TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    scheme TEXT,
    method TEXT,
    path TEXT,
    first_seen_at INTEGER NOT NULL,
    UNIQUE (target_id, kind, identity),
    CHECK (
      (kind = 'host'
        AND scheme IS NULL AND method IS NULL AND path IS NULL)
      OR
      (kind = 'endpoint'
        AND scheme IS NOT NULL AND method IS NOT NULL AND path IS NOT NULL)
    )
  )`,
  `CREATE TABLE asset_discoveries (
    asset_id TEXT NOT NULL REFERENCES assets(id),
    operation_id TEXT NOT NULL,
    caller_scope TEXT NOT NULL,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    discovered_as TEXT NOT NULL,
    note TEXT NOT NULL,
    discovered_at INTEGER NOT NULL,
    PRIMARY KEY (asset_id, operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS asset_discoveries_intent_idx
     ON asset_discoveries(intent_id)`,
);

/**
 * `0011` — an intent anchors to the observations it came out of.
 *
 * §4 calls intent anchoring "the single most valuable idea here" and says to implement it
 * before anything else that writes to the graph: an intent may anchor only to existing
 * recorded evidence, never to another intent, a goal or a hint. That is what keeps a
 * multi-week hunt from drifting into speculation, and T3Code has no equivalent.
 *
 * An anchor is an edge, so it is a table with real foreign keys both ways rather than a
 * column holding a list. `position` keeps the order the caller gave, because a first
 * parent is usually the one the direction came from and the rest qualify it.
 *
 * **What this schema can and cannot enforce.** The foreign key is to `observations(id)`,
 * so an anchor *cannot* name an intent or a goal — those ids are in other tables and the
 * constraint refuses them outright. What it cannot check is the same-goal rule, which
 * needs a two-table join; that is enforced in the write transaction, with the instructive
 * refusal §4 asks for.
 *
 * ScopeWeaver's rule reserves anchoring for `confirmed` fact and finding nodes. We have
 * no dismissal state and no finding subsystem, so every stored observation is recorded
 * evidence and anchorable — including an `inconclusive` one, which is a real result about
 * a real test and a legitimate thing to build a direction on. **If a dismissal state is
 * ever added, this check must gain it**, or a dismissed observation would keep anchoring
 * new work.
 */
const addIntentAnchors = statements(
  `CREATE TABLE intent_anchors (
    intent_id TEXT NOT NULL REFERENCES intents(id),
    observation_id TEXT NOT NULL REFERENCES observations(id),
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (intent_id, observation_id),
    CHECK (position >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS intent_anchors_observation_idx
     ON intent_anchors(observation_id)`,
);

/**
 * `0012` — the append-only event log, with its own per-target sequence.
 *
 * §3 says immutable rows, stable ids and a store-assigned monotonic sequence, "decided at
 * schema time, not later", because retrofitting append-only onto a mutable store is
 * painful and it costs nothing now. §8 says what the sequence is *for*: a consumer reads
 * committed events in ascending sequence order after its cursor, and a PubSub wake-up is
 * advisory rather than the delivery guarantee. Sprint 02 writes these rows; Sprint 03
 * reads them.
 *
 * **The sequence is per target because the file is per target.** It is allocated from this
 * file's own `sequence_cursor`, under the name `events`, inside the writing transaction.
 * §8 is explicit that "cursors belong to a particular target event log, not a global
 * sequence across independent target files", and that also removes the coupling §22
 * flagged, where one global counter meant a write anywhere moved every briefing's
 * `preparedAtSequence`.
 *
 * **The observation sequence is a different counter and is not renumbered.** An
 * observation's id is `obs_<sequence>_<attemptId>` and dimension aliases are built from
 * it, so renumbering per target would rewrite primary keys and every address a briefing
 * has already printed. Each file keeps the counter it has; `events` starts at 1 in each
 * file because nothing has ever written one.
 *
 * **The three identities are three sets of columns, not one `actor` string** (§6):
 *
 * - *Caller authority* — `caller_scope`, plus `attempt_id` and `intent_id` when the write
 *   came from an authenticated worker. All three are `NULL` for a host-originated
 *   mutation, which is an honest answer rather than a fabricated attempt.
 * - *Operation identity* — `operation` and `operation_id`, the same pair the receipt is
 *   keyed on, so an event can be matched to the command that produced it.
 * - *Domain identity* — `subject_id`, the row the event is about. Not a foreign key: it
 *   names rows in several tables, and a column that pointed at one of them would be
 *   wrong for the others.
 *
 * `payload` is JSON and readers are expected to tolerate fields they do not know
 * (§6, `unknownField`). Nothing here reads it.
 *
 * **Immutability is enforced by the database.** Two triggers raise on `UPDATE` and on
 * `DELETE`, so "the rows are immutable" is a constraint a confused handler cannot get
 * round rather than a property of the statements we happen to have written — the same
 * argument §4 makes for putting the per-kind state machine in a `CHECK`. Note the one
 * thing they do not stop: a future migration that rebuilds the table the way `0006` did
 * would have to drop and recreate them, and should say so loudly.
 */
const addEventLog = statements(
  `CREATE TABLE events (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    caller_scope TEXT,
    intent_id TEXT REFERENCES intents(id),
    attempt_id TEXT REFERENCES attempts(id),
    operation TEXT NOT NULL,
    operation_id TEXT,
    subject_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX events_sequence_idx ON events(sequence)`,
  `CREATE INDEX events_kind_idx ON events(kind)`,
  `CREATE TRIGGER events_are_immutable BEFORE UPDATE ON events
   BEGIN
     SELECT RAISE(ABORT, 'events are immutable: record a new event instead');
   END`,
  `CREATE TRIGGER events_are_append_only BEFORE DELETE ON events
   BEGIN
     SELECT RAISE(ABORT, 'events are append-only: a recorded event is never deleted');
   END`,
);

/**
 * `0013` — the transactional outbox: a durable queue of side-effect requests.
 *
 * §6 is precise about what this is and is not. It is a queue of *side-effect requests*
 * with execution metadata, committed in the same transaction as the domain change that
 * implies them, so a committed finding cannot lose its notification obligation merely
 * because the process died before dispatch. It is **not** the store of all commands and
 * their results — receipts deduplicate commands and the domain tables hold state — and it
 * does **not** provide exactly-once remote execution: if a remote action succeeds and we
 * crash before recording that, the outcome is ambiguous and no local row fixes it.
 *
 * That is why `recovery_policy` is a column and not a default. §6 requires an explicit
 * policy per effect type, and the four it names are the four values allowed here:
 * `safe_to_retry`, `idempotency_key`, `reconcile_first`, `do_not_repeat`. A dispatcher
 * that cannot tell them apart would either lose work or repeat an unrepeatable action.
 *
 * **Sprint 02 writes `pending` rows and nothing moves them.** The execution columns —
 * `status`, `attempts`, the lease pair, `next_attempt_at`, `last_error` — are declared
 * now because §3's append-only-at-schema-time argument applies to them too and because a
 * dispatcher that had to add a lease column later would have to rebuild the table. They
 * are inert in this sprint: claiming, leasing, retry scheduling and delivery state are
 * Sprint 03, which is also where the `in_flight` and terminal statuses first get written.
 *
 * `caused_by_event_id` is a real foreign key to `events(id)`. Every request exists because
 * something was recorded, and a request with no event behind it would be an obligation
 * nobody can explain. `sequence` gives the queue a deterministic order from the same
 * per-target counter the events use, so "oldest pending first" is well defined without
 * relying on a timestamp two commits can share.
 */
const addOutbox = statements(
  `CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    request_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    recovery_policy TEXT NOT NULL,
    caused_by_event_id TEXT NOT NULL REFERENCES events(id),
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    next_attempt_at INTEGER,
    last_error TEXT,
    enqueued_at INTEGER NOT NULL,
    completed_at INTEGER,
    CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed', 'cancelled')),
    CHECK (recovery_policy IN ('safe_to_retry', 'idempotency_key',
                               'reconcile_first', 'do_not_repeat')),
    CHECK (attempts >= 0)
  )`,
  `CREATE UNIQUE INDEX outbox_sequence_idx ON outbox(sequence)`,
  `CREATE INDEX outbox_pending_idx ON outbox(status, sequence)
     WHERE status = 'pending'`,
  `CREATE INDEX outbox_event_idx ON outbox(caused_by_event_id)`,
);

/**
 * `0014` — which configured harness ran an attempt.
 *
 * A second harness made "which agent ran this" a real question. Until now there was one,
 * so `provider_id` and `model_id` were the whole of a run's provenance and they described
 * the *model*: `openai` and `gpt-5.6-sol`, as OpenCode names them. They still do. What
 * they never said is whether the thing driving that model was `opencode serve` or the
 * Claude Agent SDK — and from a row holding `anthropic` / `claude-sonnet-5` there is no
 * way to tell, because OpenCode can route Anthropic models too.
 *
 * So one column: the **instance**, which is the identity everything routes by
 * (`harness/identity.ts`). An attempt is pinned to it the moment it starts; changing
 * harness is a new attempt, not a retarget, which is why nothing ever updates this.
 *
 * **The driver is deliberately not a column.** It is derivable from the instance in the
 * process's current configuration, and a stored copy would be a second version of the same
 * fact, free to disagree with the first after an operator reconfigures. The cost is stated
 * rather than hidden: an attempt whose instance this process does not configure has no
 * derivable driver, and `recovery/harnessStatus.ts` answers "we cannot tell" there instead
 * of asking the wrong harness. That is the honest answer, and a `driver` column would have
 * replaced it with a confident one about a harness nobody can reach.
 *
 * **Nullable, with no backfill.** Every row written before this migration was written by a
 * process that had exactly one harness — but *which* one is not recorded anywhere, so
 * filling in `opencode` would be inventing provenance. `NULL` means "written before
 * instances existed", which recovery and the API both read as unknown rather than as a
 * default.
 *
 * The index exists because the one query that will want it is "what did this instance
 * run", which is how a quota or a rate-limit sweep finds its attempts; it is partial so an
 * installation that never records an instance pays nothing for it.
 */
const addAttemptHarnessInstance = statements(
  `ALTER TABLE attempts ADD COLUMN harness_instance_id TEXT`,
  `CREATE INDEX IF NOT EXISTS attempts_harness_instance_idx
     ON attempts(harness_instance_id)
     WHERE harness_instance_id IS NOT NULL`,
);

/**
 * `0015` — what was chosen *of* the model an attempt ran on.
 *
 * `0014` answered "which harness" and `provider_id`/`model_id` answer "which model". What
 * none of them answer is how hard that model was asked to think — and reasoning depth
 * changes what a run does, so leaving it out puts a hole in the one thing an attempt row
 * exists for. "The same prompt at a different effort" is a plausible explanation for two
 * attempts disagreeing, and until now nobody could check it.
 *
 * **One column, holding what was dispatched.** The canonical JSON of the selections the
 * run actually carried — `[{"id":"effort","value":"high"}]` — sorted by id so two
 * identical choices are byte-identical and comparable. Not a side table: the ids are the
 * *harness's* (`variant` on OpenCode, `effort` on Claude Code, and whatever a third
 * brings), so a schema that named them would be a schema that had to change with every
 * harness release, and nothing in this application queries by one.
 *
 * **What was dispatched, never what the picker displayed.** A descriptor's default is
 * shown to an operator and deliberately not sent (`@bit/contracts`'s `modelOption.ts`,
 * rule 3), so a row reading `effort: medium` because that is the catalogue default would
 * be a fabricated answer to a question nobody asked. `NULL` is the honest value for "the
 * operator set nothing, and the harness applied its own default" — which is also the
 * common case.
 *
 * **Nullable, with no backfill**, for `0014`'s reason exactly: every row written before
 * this migration was written by a process that could not dispatch an option at all, and
 * `NULL` says "this was not recorded" rather than "nothing was chosen". The two are
 * indistinguishable here, and that is the honest degradation — an invented `[]` would
 * have made an old row claim an answer it never had.
 *
 * No index. The column is read off a row somebody already found, and a partial index on
 * a JSON blob nothing filters by would be a cost with no reader.
 */
const addAttemptModelOptions = statements(
  `ALTER TABLE attempts ADD COLUMN model_options TEXT`,
);

/**
 * `0016` — a goal becomes something with a lifecycle.
 *
 * Until now a goal was a row `seedAttempt` minted as a side effect of starting a run: an
 * id, a target, a description and a time, with no way to say it was over. This adds the
 * columns that let an operator create one on purpose and end it on purpose.
 *
 * - **`name`** is the short label a list row shows. The objective is not a new column: it
 *   is `description`, which has always held the text a goal was created with, and a
 *   second field for the same thing would be a schema that disagrees with itself the first
 *   time the two differ. `NOT NULL DEFAULT ''` — an empty name means none was given, which
 *   is a statement about the operator and not a missing value.
 * - **`status`** is `active`, `met` or `abandoned`. `NOT NULL DEFAULT 'active'`, because
 *   every goal that exists when this runs is a real objective somebody was working
 *   towards, and "still open" is the only claim about it that is true. Defaulting to
 *   anything else would have retired work the operator never ended.
 * - **`ended_at`, `ended_by`, `end_reason`** are the record of an ending: when, by whom
 *   (`planner` or `operator`) and why. All three are nullable and are null exactly while
 *   the goal is `active`. They are not defaulted to a placeholder because a placeholder
 *   ("unknown", `0`) would read as a recorded ending of an open goal; null is the honest
 *   absence. `end_reason` may be the empty string for a goal ended with no reason, which
 *   is a different fact from null.
 *
 * No `CHECK` on the vocabularies, for the reason `attempts.status` has none: the contract
 * (`contracts/goal.ts`) owns the set, every read decodes through it, and a stored value
 * outside it surfaces as a `StoredRowError` naming the row rather than as an `INSERT`
 * failing for a reason the writer cannot see.
 *
 * **What an existing row looks like afterwards:** `name = ''`, `status = 'active'`, the
 * three ending columns null. A goal minted by `seedAttempt` before this migration is
 * therefore listed as an open, unnamed goal whose objective is its description — correct,
 * intended, and not rewritten by anything here. It has no `goal.added` event, since the
 * log did not exist to witness it.
 *
 * The index serves the one question a list asks, "this target's goals, by state". A goal
 * table is small and the index is cheap; it is there so that "active goals of a target",
 * which a dispatcher will ask on every wake-up, never becomes a scan of every goal ever
 * created.
 */
const addGoalLifecycle = statements(
  `ALTER TABLE goals ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE goals ADD COLUMN ended_at INTEGER`,
  `ALTER TABLE goals ADD COLUMN ended_by TEXT`,
  `ALTER TABLE goals ADD COLUMN end_reason TEXT`,
  `CREATE INDEX IF NOT EXISTS goals_target_status_idx ON goals(target_id, status)`,
);

/**
 * `0017` — an intent becomes something with a lifecycle, and something a run can claim.
 *
 * Until now an intent was a row `seedAttempt` minted beside a goal and an attempt, one of
 * each per run, and nothing could say whether it was being worked, had been answered, or
 * had been dropped. This adds the state that lets an intent exist *before* a run does and
 * be taken by one.
 *
 * - **`status`** is `proposed`, `open`, `claimed`, `answered` or `abandoned`.
 *   `NOT NULL DEFAULT 'open'`: every intent that exists when this runs is a direction
 *   somebody could still run, and "available" is the only claim about it that is true.
 *   `proposed` is in the vocabulary (`contracts/intent.ts`) and nothing writes it yet; it
 *   is reserved for a planner, which does not exist. No `CHECK`, for the reason `0016`
 *   gives: the contract owns the set, every read decodes through it, and a stored value
 *   outside it surfaces as a `StoredRowError` naming the row.
 * - **`claimed_by_attempt_id`** names the attempt holding the claim while `status` is
 *   `claimed`, and is null otherwise. It is deliberately **not** a foreign key: the claim
 *   is taken before the attempt row is written (so a refused run leaves no attempt to
 *   point at), and a reference that had to exist first would force the order the other
 *   way round. It exists so a second claim can be refused *by name*.
 * - **`suggested_instance_id`, `suggested_model`, `suggested_model_options`** are
 *   **advisory**: a suggestion for how to run this intent, nothing more. Nothing is ever
 *   pinned to them. `attempts` remains the only provenance record — it stores the
 *   instance, model and options a run actually carried, and a suggestion that was
 *   ignored, overridden or unresolvable leaves no trace there, which is correct. A reader
 *   asking "what ran this?" must read the attempt and never these columns. All three are
 *   nullable, and null means *no suggestion*, which is different from a suggestion of an
 *   empty option list (`suggested_model_options` is the JSON of the selections, or null).
 *
 * **What an existing row looks like afterwards:** `status = 'open'`, no claim, no
 * suggestion. That includes a legacy intent whose attempt already settled, which is
 * deliberately *not* back-filled to `answered`: whether a past run answered its question
 * is a judgement the settlement rule makes at the moment of settling, and applying it
 * retroactively to rows it never saw would be inventing a conclusion.
 *
 * The index serves the two questions asked of it: "this goal's intents, by state", and,
 * for a dispatcher, "what is open under it".
 */
const addIntentLifecycle = statements(
  `ALTER TABLE intents ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`,
  `ALTER TABLE intents ADD COLUMN claimed_by_attempt_id TEXT`,
  `ALTER TABLE intents ADD COLUMN suggested_instance_id TEXT`,
  `ALTER TABLE intents ADD COLUMN suggested_model TEXT`,
  `ALTER TABLE intents ADD COLUMN suggested_model_options TEXT`,
  `CREATE INDEX IF NOT EXISTS intents_goal_status_idx ON intents(goal_id, status)`,
);

/**
 * The ordered chain. Append only; never edit an entry that has shipped.
 *
 * The key's numeric prefix is the id the journal records, and the rest is its name, so
 * renaming a key changes what the journal reports for an already-applied migration.
 *
 * **The ids must increase, and leaving a gap is worse than it looks.** `Migrator.run`
 * reads the highest id *this database's* journal holds (`effect/src/sql/Migrator.ts`,
 * `latestMigrationId`, resolved once per run) and skips every resolved id at or below it,
 * while the loader sorts by id (`fromRecord`, `Arr.sort(migrationOrder)`). So an id
 * dropped into a gap later runs on a fresh database, in the right order, and never on a
 * database already past it: the two diverge and the journal reports both as current.
 * There is no gap here. Append with a number above every key.
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
  "0008_observation_dimensions": addObservationDimensionRows,
  "0009_intent_dimension_provenance": addIntentDimensionProvenance,
  "0010_assets": addAssets,
  "0011_intent_anchors": addIntentAnchors,
  "0012_event_log": addEventLog,
  "0013_outbox": addOutbox,
  "0014_attempt_harness_instance": addAttemptHarnessInstance,
  "0015_attempt_model_options": addAttemptModelOptions,
  "0016_goal_lifecycle": addGoalLifecycle,
  "0017_intent_lifecycle": addIntentLifecycle,
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
