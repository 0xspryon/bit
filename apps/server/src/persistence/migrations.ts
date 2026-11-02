/**
 * Schema migrations, run by `effect/sql`'s migrator (DECISIONS.md §3 "migrations").
 *
 * # This file was collapsed to a baseline once, and must never be again
 *
 * `MIGRATIONS` held 31 entries and 37 `ALTER TABLE`s, almost all of it the shape of a
 * chain that had grown append-only against development databases. **This application has
 * never been deployed and holds no production data**, so on the operator's decision the
 * chain was replaced by a single entry that creates today's schema directly. The schema
 * is byte-for-byte what the 31 entries produced; `migrations.test.ts` holds the committed
 * dump that proves it.
 *
 * **That reset was a one-off, justified only by there being nothing deployed.** It is not
 * a precedent. `AGENTS.md`'s rule governs everything from here: *append, never edit an
 * applied one*. Entry two of this chain is the first real migration, and the moment any
 * database outside this repository has run this baseline, editing it becomes the same
 * mistake collapsing it was permitted to fix.
 *
 * The cost of breaking that rule is not hypothetical — it is why `0031` existed. `0014`
 * was inserted into the *middle* of the old list after databases had already recorded
 * id 14 as something else; the migrator skips every entry at or below the highest applied
 * id, so on those databases `0014` never ran and `attempts` never got
 * `harness_instance_id`. Nothing noticed until a route selected the column months later
 * and answered `500` while startup reconciliation logged `query failed` on every target.
 * The remedy was a forward repair migration, because there is no `down` and no `redo`.
 * **Append with an id above every key here, and never renumber.**
 *
 * # What the migrator gives us, verified against the installed 4.0.5 and the driver
 *
 * Each migration is an Effect keyed `<id>_<name>` in {@link MIGRATIONS}. They are
 * **static imports in a literal record**, not a filesystem scan: `Migrator.fromRecord`
 * (`effect/src/sql/Migrator.ts:410-423`) sorts them by id and the bundler sees every one
 * of them, so `bun build` cannot drop a migration the way a glob loader would.
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
 * **Migration ids are not contract versions.** This chain numbers schema changes. The
 * observation contract is at version 1 and has never been published
 * (`packages/contracts/src/observation.ts` `OBSERVATION_CONTRACT_VERSION`); the length of
 * this chain implies nothing about a release history, which is also why an observation's
 * two shapes are named `case_based` and `summary` — record *formats* of one contract —
 * rather than numbered.
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
 * ## The graph: goals, intents, attempts, observations
 *
 * ### `goals` — an objective with a lifecycle
 *
 * - **`name`** is the short label a list row shows. The objective is not a second column:
 *   it is `description`, which holds the text a goal was created with, and a separate
 *   field for the same thing would be a schema that disagrees with itself the first time
 *   the two differ. `NOT NULL DEFAULT ''` — an empty name means none was given, which is
 *   a statement about the operator and not a missing value.
 * - **`status`** is `active`, `met` or `abandoned`.
 * - **`ended_at`, `ended_by`, `end_reason`** are the record of an ending: when, by whom
 *   (`planner` or `operator`) and why. All three are nullable and are null exactly while
 *   the goal is `active`. They are not defaulted to a placeholder because a placeholder
 *   ("unknown", `0`) would read as a recorded ending of an open goal; null is the honest
 *   absence. `end_reason` may be the empty string for a goal ended with no reason, which
 *   is a different fact from null.
 *
 * **No `CHECK` on any of the status vocabularies in this file**, and that is a decision
 * rather than an omission: the contract owns the set (`contracts/goal.ts`,
 * `contracts/intent.ts`, and the store for a planner round), every read decodes through
 * it, and a stored value outside it surfaces as a `StoredRowError` naming the row rather
 * than as an `INSERT` failing for a reason the writer cannot see. The `CHECK`s that *are*
 * here are the ones no decoder could enforce — pairings between columns, and vocabularies
 * a confused handler could otherwise write past.
 *
 * ### `intents` — a direction, with provenance, a lifecycle and a claim
 *
 * - **`addresses_dimension`** is which earlier untested dimension this intent takes on,
 *   and it buys three things (DECISIONS.md §17, "one derivation, not a stored flag"). The
 *   briefing state `scheduled` becomes *derivable* — a later round can tell "nobody has
 *   looked at this" from "work is out for this" — rather than being a flag somebody has
 *   to remember to clear. Duplicate-intent detection becomes a join rather than the prose
 *   matching §4 warns against. And it is the recorded lineage that lets the write
 *   boundary relax its same-intent rule to *same goal, when the caller's own intent
 *   declares that dimension*, so a planner can answer a dimension with a new intent.
 *   `NULL` is the ordinary case and means only that the intent did not say; it is never
 *   "this intent addresses nothing".
 *
 *   It is a **forward reference**: `observation_dimensions` is created further down this
 *   same baseline, below `observations`, which references `intents`. SQLite resolves a
 *   foreign key at DML time rather than at `CREATE TABLE`, so the cycle is legal and the
 *   constraint is live — `migrations.test.ts` proves it by having an unknown dimension id
 *   refused.
 * - **`status`** is `proposed`, `open`, `claimed`, `answered` or `abandoned`, defaulting
 *   to `open`. `proposed` is in the vocabulary and nothing writes it yet; it is reserved
 *   for a planner.
 * - **`claimed_by_attempt_id`** names the attempt holding the claim while `status` is
 *   `claimed`, and is null otherwise. It is deliberately **not** a foreign key: the claim
 *   is taken before the attempt row is written (so a refused run leaves no attempt to
 *   point at), and a reference that had to exist first would force the order the other way
 *   round. It exists so a second claim can be refused *by name*.
 * - **`suggested_instance_id`, `suggested_model`, `suggested_model_options`** are
 *   **advisory**: a suggestion for how to run this intent, nothing more. Nothing is ever
 *   pinned to them. `attempts` remains the only provenance record — it stores the
 *   instance, model and options a run actually carried, and a suggestion that was ignored,
 *   overridden or unresolvable leaves no trace there, which is correct. A reader asking
 *   "what ran this?" must read the attempt and never these columns. Null means *no
 *   suggestion*, which differs from a suggestion of an empty option list.
 *
 * `target_id` is carried on `intents` and `attempts` rather than reached through the goal
 * because every authority check compares the caller's target with the row's, and a check
 * that had to join to do that would be a check that reads two tables to answer "is this
 * yours".
 *
 * ### `attempts` — one run, its provenance, and its write authority
 *
 * - **`write_fence`** is the attempt's write authority epoch. A credential is issued
 *   against the value the attempt had at the time, and a write presenting a superseded
 *   fence is refused. Recovery bumps it, which is what makes "the old authority is
 *   revoked" a durable fact rather than an in-memory one that a restart forgets.
 * - **`recovery_disposition` and `recovered_at`** say *how* an attempt reached its status
 *   when reconciliation decided it, as opposed to the worker's own settlement. Null means
 *   reconciliation never touched it.
 * - **`replaces_attempt_id`** points at the attempt a replacement was opened for. Work is
 *   never resumed under an abandoned attempt's identity, so the link has to live
 *   somewhere; this is it.
 * - **`harness_instance_id`** is which configured harness ran it. `provider_id` and
 *   `model_id` describe the *model* — `openai` and `gpt-5.6-sol`, as OpenCode names them —
 *   and never said whether the thing driving it was `opencode serve` or the Claude Agent
 *   SDK, which a row holding `anthropic` / `claude-sonnet-5` cannot distinguish because
 *   OpenCode can route Anthropic models too. The instance is the identity everything
 *   routes by (`harness/identity.ts`). An attempt is pinned to it the moment it starts;
 *   changing harness is a new attempt, not a retarget, which is why nothing updates it.
 *
 *   **The driver is deliberately not a column.** It is derivable from the instance in the
 *   process's current configuration, and a stored copy would be a second version of the
 *   same fact, free to disagree with the first after an operator reconfigures. The cost is
 *   stated rather than hidden: an attempt whose instance this process does not configure
 *   has no derivable driver, and `recovery/harnessStatus.ts` answers "we cannot tell"
 *   there instead of asking the wrong harness.
 *
 *   Nullable, because a row may predate instances; `NULL` reads as unknown, not as a
 *   default. The index is partial so an installation that never records an instance pays
 *   nothing for it, and serves the one query that wants it — "what did this instance run",
 *   which is how a quota or rate-limit sweep finds its attempts.
 * - **`model_options`** is what was chosen *of* that model: the canonical JSON of the
 *   selections the run actually carried — `[{"id":"effort","value":"high"}]` — sorted by
 *   id so two identical choices are byte-identical and comparable. Reasoning depth changes
 *   what a run does, so "the same prompt at a different effort" is a plausible explanation
 *   for two attempts disagreeing, and this is what lets anyone check it.
 *
 *   Not a side table: the ids are the *harness's* (`variant` on OpenCode, `effort` on
 *   Claude Code, and whatever a third brings), so a schema that named them would have to
 *   change with every harness release, and nothing here queries by one. **What was
 *   dispatched, never what the picker displayed** — a descriptor's default is shown to an
 *   operator and deliberately not sent (`@bit/contracts`'s `modelOption.ts`, rule 3), so a
 *   row reading `effort: medium` because that is the catalogue default would be a
 *   fabricated answer to a question nobody asked. `NULL` is the honest value for "the
 *   operator set nothing, and the harness applied its own default", which is also the
 *   common case. No index: the column is read off a row somebody already found.
 *
 * ### `observations` — a record in one of two formats, with the pairing enforced
 *
 * An observation is `case_based` (a setup plus several cases, each with its own actors and
 * actions) or `summary` (one prose record of conditions and behaviour). Both are formats
 * of contract version 1; neither supersedes the other, and `record_format` holds the
 * format name rather than a version number.
 *
 * **The `CHECK` is the point of the shape.** The summary columns have to be nullable (a
 * case-based row has no singular `conditions`), the case columns have to be nullable too
 * (a summary row has no `cases`), and nothing but a `CHECK` stops a row claiming to be
 * both or neither. SQLite can only add or replace one by rebuilding a table, so getting it
 * right here is worth more than it looks.
 *
 * `untested_dimensions` stays `NOT NULL` and holds the JSON array as the worker submitted
 * it, even though the dimensions are also rows in `observation_dimensions`. It is the
 * submission, not the derived state; the rows are what anything reads by.
 *
 * ### `command_receipts` and `sequence_cursor`
 *
 * A receipt deduplicates one command: `caller_scope` is *whose authority wrote this*, and
 * the key is what a retry presents. `sequence_cursor` is this file's own set of counters,
 * allocated inside the writing transaction — `observations` and `events` each have one,
 * and both are per target because the file is per target.
 */
const graph = [
  `CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    ended_at INTEGER,
    ended_by TEXT,
    end_reason TEXT
  )`,
  // The one question a goal list asks: "this target's goals, by state". A goal table is
  // small and the index is cheap; it is here so that "active goals of a target", which a
  // dispatcher asks on every wake-up, never becomes a scan of every goal ever created.
  `CREATE INDEX goals_target_status_idx ON goals(target_id, status)`,
  `CREATE TABLE intents (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    target_id TEXT NOT NULL,
    question TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    addresses_dimension TEXT REFERENCES observation_dimensions(id),
    status TEXT NOT NULL DEFAULT 'open',
    claimed_by_attempt_id TEXT,
    suggested_instance_id TEXT,
    suggested_model TEXT,
    suggested_model_options TEXT
  )`,
  `CREATE INDEX intents_goal_idx ON intents(goal_id)`,
  `CREATE INDEX intents_addresses_dimension_idx ON intents(addresses_dimension)`,
  // "This goal's intents, by state", and, for a dispatcher, "what is open under it".
  `CREATE INDEX intents_goal_status_idx ON intents(goal_id, status)`,
  `CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES intents(id),
    target_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    harness_session_id TEXT,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    write_fence INTEGER NOT NULL DEFAULT 0,
    recovery_disposition TEXT,
    recovered_at INTEGER,
    replaces_attempt_id TEXT REFERENCES attempts(id),
    harness_instance_id TEXT,
    model_options TEXT
  )`,
  `CREATE INDEX attempts_intent_idx ON attempts(intent_id)`,
  `CREATE INDEX attempts_status_idx ON attempts(status)`,
  `CREATE INDEX attempts_harness_instance_idx
     ON attempts(harness_instance_id)
     WHERE harness_instance_id IS NOT NULL`,
  `CREATE TABLE observations (
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
  `CREATE UNIQUE INDEX observations_sequence_idx ON observations(sequence)`,
  `CREATE INDEX observations_intent_idx ON observations(intent_id)`,
  `CREATE INDEX observations_record_format_idx ON observations(record_format)`,
  `CREATE TABLE command_receipts (
    key TEXT PRIMARY KEY,
    caller_scope TEXT NOT NULL,
    operation TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX command_receipts_scope_idx ON command_receipts(caller_scope)`,
  `CREATE TABLE sequence_cursor (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )`,
];

/**
 * ## Recovery: what reconciliation decided about an attempt
 *
 * `attempt_recoveries` is the append-only-in-spirit record of what the harness said and
 * what we did about it.
 *
 * **The key is the whole reconciliation state**: `(attempt_id, observed_status,
 * prior_status, resulting_status, disposition, fence_before, fence_after)`. A narrower key
 * conflates dispositions, and the chain this baseline replaces learned that the hard way.
 * Reconcile a running attempt whose harness says `succeeded` and the pass is `settled`,
 * `running -> succeeded`, fence `0 -> 1`; ask again and the pass is `already_final`,
 * `succeeded -> succeeded`, fence `1 -> 1`. Same attempt, same observed status, same
 * resulting status — so under a three-column key the second upsert landed on the first
 * row, left `disposition = 'settled'` standing over a `detail` text that said
 * `already_final`, and handed the caller back the first pass's fence movement as though it
 * were its own.
 *
 * Repeating that exact state still increments `times` — which is the property a narrow key
 * was reaching for — while a pass that decided anything different gets its own row.
 * Because the fences are in the key, no column outside it can disagree with the pass that
 * wrote it, so what `recordRecovery` returns and what the table holds are the same values.
 * `times` and `last_reconciled_at` keep a repeat visible rather than hiding it:
 * reconciling twice with the same answer must not manufacture history.
 *
 * It keeps its implicit `rowid` deliberately — not `WITHOUT ROWID` — because insertion
 * order is the only stable way to read "in the order first seen", which is what
 * `recoveriesForAttempt` reads: two reconciliations in the same millisecond are ordinary,
 * and a timestamp cannot order them.
 *
 * `observations_at_recovery` is recorded as a fact about our own store at that instant and
 * is **never** an input to the disposition. A session that wrote no observation may still
 * have changed the target; inferring "nothing happened" from "we hold nothing" is
 * precisely the mistake this column must not be used to make.
 *
 * **`attempt_recoveries_attempt_idx` is redundant and kept deliberately.** The primary key
 * already leads with `attempt_id`, so SQLite can serve "this attempt's recoveries" from it
 * without this index. It is here because the schema this baseline reproduces has it, and
 * dropping an index is a schema change that belongs in its own appended migration with its
 * own reasoning, not in a collapse that is supposed to change nothing.
 */
const recovery = [
  `CREATE TABLE attempt_recoveries (
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
  `CREATE INDEX attempt_recoveries_attempt_idx
     ON attempt_recoveries(attempt_id)`,
];

/**
 * ## Untested dimensions, and the links that take them on
 *
 * §22 recorded the limit this shape removes: a dimension address is positional, which "is
 * only sound while observations are immutable", and anything that ever edits, merges or
 * rewords a recorded dimension "needs its own identity scheme rather than this one
 * stretched to fit". So a dimension is a row with an id that **does not encode where it
 * sits**. An id spelled `obs_x#u1` would make position the identity again and the table
 * would be decoration. `<observationId>#u<index>` survives as the **wire alias** — it is
 * what a briefing prints and what a worker copies — and is resolved to a `dimension_id` at
 * the write boundary. Nothing worker-facing depends on the storage shape.
 *
 * `UNIQUE (observation_id, position)` means the same position cannot exist twice, and
 * `CHECK (position >= 0)` keeps an address parseable.
 *
 * `observation_dimension_links` is one row per (addressing observation, dimension) pair,
 * which is the primary key: the same observation naming the same dimension twice is one
 * link, not two, and a retry that replays a receipt writes no link at all because it writes
 * nothing. Both sides are real foreign keys, so a link cannot name a row that does not
 * exist. `address` keeps the **exact text the worker submitted**, because that is a fact
 * about the request rather than derived state, and it makes the stored link read the way
 * the briefing printed it.
 *
 * There is deliberately **no** intent column and no `source_observation_id`. Which intent a
 * link belongs to is its addressing observation's intent, and which observation raised the
 * dimension is the dimension row's own column; duplicating either here would be a second
 * answer to a question that already has one. The same-intent rule is enforced at the write
 * boundary and read back through a join.
 */
const dimensions = [
  `CREATE TABLE observation_dimensions (
    id TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL REFERENCES observations(id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (observation_id, position),
    CHECK (position >= 0)
  )`,
  `CREATE TABLE observation_dimension_links (
    observation_id TEXT NOT NULL REFERENCES observations(id),
    dimension_id TEXT NOT NULL REFERENCES observation_dimensions(id),
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (observation_id, dimension_id)
  )`,
  `CREATE INDEX observation_dimension_links_dimension_idx
     ON observation_dimension_links(dimension_id)`,
];

/**
 * ## `intent_anchors` — an intent anchors to the observations it came out of
 *
 * §4 calls intent anchoring "the single most valuable idea here" and says to implement it
 * before anything else that writes to the graph: an intent may anchor only to existing
 * recorded evidence, never to another intent, a goal or a hint. That is what keeps a
 * multi-week hunt from drifting into speculation, and T3Code has no equivalent.
 *
 * An anchor is an edge, so it is a table with real foreign keys both ways rather than a
 * column holding a list. `position` keeps the order the caller gave, because a first parent
 * is usually the one the direction came from and the rest qualify it.
 *
 * **What this schema can and cannot enforce.** The foreign key is to `observations(id)`, so
 * an anchor *cannot* name an intent or a goal — those ids are in other tables and the
 * constraint refuses them outright. What it cannot check is the same-goal rule, which needs
 * a two-table join; that is enforced in the write transaction, with the instructive refusal
 * §4 asks for.
 *
 * ScopeWeaver's rule reserves anchoring for `confirmed` fact and finding nodes. We have no
 * dismissal state and no finding subsystem, so every stored observation is recorded
 * evidence and anchorable — including an `inconclusive` one, which is a real result about a
 * real test and a legitimate thing to build a direction on. **If a dismissal state is ever
 * added, this check must gain it**, or a dismissed observation would keep anchoring new
 * work.
 */
const anchors = [
  `CREATE TABLE intent_anchors (
    intent_id TEXT NOT NULL REFERENCES intents(id),
    observation_id TEXT NOT NULL REFERENCES observations(id),
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (intent_id, observation_id),
    CHECK (position >= 0)
  )`,
  `CREATE INDEX intent_anchors_observation_idx
     ON intent_anchors(observation_id)`,
];

/**
 * ## The append-only event log and the transactional outbox
 *
 * ### `events`
 *
 * §3 says immutable rows, stable ids and a store-assigned monotonic sequence, "decided at
 * schema time, not later", because retrofitting append-only onto a mutable store is painful
 * and it costs nothing now. §8 says what the sequence is *for*: a consumer reads committed
 * events in ascending sequence order after its cursor, and a PubSub wake-up is advisory
 * rather than the delivery guarantee.
 *
 * **The sequence is per target because the file is per target.** It is allocated from this
 * file's own `sequence_cursor`, under the name `events`, inside the writing transaction.
 * §8 is explicit that "cursors belong to a particular target event log, not a global
 * sequence across independent target files", and that also removes the coupling §22
 * flagged, where one global counter meant a write anywhere moved every briefing's
 * `preparedAtSequence`. The observation sequence is a **different counter** and is not
 * renumbered: an observation's id is `obs_<sequence>_<attemptId>` and dimension aliases are
 * built from it, so renumbering would rewrite primary keys and every address a briefing has
 * already printed.
 *
 * **The three identities are three sets of columns, not one `actor` string** (§6):
 *
 * - *Caller authority* — `caller_scope`, plus `attempt_id` and `intent_id` when the write
 *   came from an authenticated worker. All three are `NULL` for a host-originated mutation,
 *   which is an honest answer rather than a fabricated attempt.
 * - *Operation identity* — `operation` and `operation_id`, the same pair the receipt is
 *   keyed on, so an event can be matched to the command that produced it.
 * - *Domain identity* — `subject_id`, the row the event is about. Not a foreign key: it
 *   names rows in several tables, and a column that pointed at one of them would be wrong
 *   for the others.
 *
 * `payload` is JSON and readers are expected to tolerate fields they do not know
 * (§6, `unknownField`).
 *
 * **Immutability is enforced by the database.** Two triggers raise on `UPDATE` and on
 * `DELETE`, so "the rows are immutable" is a constraint a confused handler cannot get round
 * rather than a property of the statements we happen to have written. Note the one thing
 * they do not stop: a future migration that rebuilt this table would have to drop and
 * recreate them, and should say so loudly.
 *
 * ### `outbox`
 *
 * §6 is precise about what this is and is not. It is a queue of *side-effect requests* with
 * execution metadata, committed in the same transaction as the domain change that implies
 * them, so a committed finding cannot lose its notification obligation merely because the
 * process died before dispatch. It is **not** the store of all commands and their results —
 * receipts deduplicate commands and the domain tables hold state — and it does **not**
 * provide exactly-once remote execution: if a remote action succeeds and we crash before
 * recording that, the outcome is ambiguous and no local row fixes it.
 *
 * That is why `recovery_policy` is a column and not a default. §6 requires an explicit
 * policy per effect type, and the four it names are the four values the `CHECK` allows: a
 * dispatcher that cannot tell them apart would either lose work or repeat an unrepeatable
 * action.
 *
 * The execution columns — `status`, `attempts`, the lease pair, `next_attempt_at`,
 * `last_error` — are declared here because §3's append-only-at-schema-time argument applies
 * to them too, and because a dispatcher that had to add a lease column later would have to
 * rebuild the table.
 *
 * `caused_by_event_id` is a real foreign key to `events(id)`. Every request exists because
 * something was recorded, and a request with no event behind it would be an obligation
 * nobody can explain. `sequence` gives the queue a deterministic order from the same
 * per-target counter the events use, so "oldest pending first" is well defined without
 * relying on a timestamp two commits can share.
 */
const eventsAndOutbox = [
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
];

/**
 * ## The planner: rounds, and the session lineage they share
 *
 * ### `planner_rounds` — a round with an identity and an authority epoch
 *
 * This is the table the round-scoped credential points at — the spec's decisions 1 to 5
 * (`docs/design/goal-and-planner-flow.md`) — and the reason `CallerContext` is a tagged
 * union: a round is something a write can be attributed to.
 *
 * - **`goal_id`** is a real foreign key, and the round's parent. One planner works one
 *   goal; a round is a bounded unit of work on it.
 * - **`status`** is `running`, `settled`, `uncertain` or `interrupted` — the attempt
 *   vocabulary minus `succeeded`/`failed`, because a round does not pass or fail. It
 *   produces a disposition or it does not.
 * - **`write_fence`** is the same mechanism `attempts` has, for the same reason: a round
 *   outlives the individual tool calls made under it, and recovery may supersede one while
 *   its credential is still out. The in-memory grant map forgets on restart; the column
 *   does not.
 * - **`started_at_sequence`** is **provenance, not a snapshot**. The planner reads the
 *   graph live and will see its own writes within the round (decision 9), so this records
 *   where the graph stood when the round opened and nothing more. It is not "the state this
 *   round saw" and must never be read as a consistency boundary.
 * - **`budget`** is how many intents this round may add. Enforced inside `add_intent`
 *   (decision 10), stored here so the limit a round was opened under is a fact about the
 *   round rather than a parameter of whoever happened to call the tool.
 * - **`disposition`** holds `actionable`, `waiting`, `no_useful_next_action` or
 *   `objective_met` once the round records one. Null means it has not, which is a different
 *   fact from any of the four — including from `no_useful_next_action`, which is a planner's
 *   considered answer and not an absence.
 * - **`disposition_rationale`** is the reasoning that goes with it. Four words is the whole
 *   of what a round concluded and it is not enough to read: `waiting` does not say what it
 *   is waiting for, and `no_useful_next_action` — the one disposition that is a judgement
 *   rather than an observation — does not say what was considered and ruled out. The two
 *   columns move together: `record_round_disposition` writes both in one statement and
 *   nothing else writes either, so a row with one and not the other is not a state this
 *   store can produce. No `CHECK` enforcing that pairing, for the reason the status
 *   vocabularies have none.
 * - **`harness_session_id`, `harness_instance_id`, `provider_id`, `model_id`** are all
 *   nullable, unlike `attempts`', because a round row exists *before* a session does: the
 *   row is what a credential is minted against, and the credential is minted before the
 *   session is prompted. A round that never reached a harness therefore holds nulls, which
 *   is the honest record of what happened.
 *
 * The index serves the one question the lifecycle asks: "this goal's rounds, by state",
 * which is both the one-round-per-goal claim (decision 7) and the startup sweep's "what was
 * left running".
 *
 * ### `planner_lineages` — one lineage per goal
 *
 * This table holds no knowledge. It records which harness session later planner rounds on a
 * goal should be opened under, and it exists because OpenCode derives a provider cache key
 * per session lineage (`parentID ?? fork.sessionID ?? id`): rounds that name the same parent
 * reuse the prefix they have already sent, and separately created top-level sessions never
 * do, however identical their briefings. Without a row to come back to, that only works
 * within one process, and a hunt is not one process.
 *
 * **Keyed by goal**, because a planner works a goal (decision 7, one round per goal at a
 * time). `goal_id` is a real foreign key where a target id would have been a bare column,
 * because a goal is ours and a target folder is not. The *session* id is deliberately not a
 * foreign key to anything, because it names a row in OpenCode's storage rather than ours,
 * and that storage can be cleared without our knowing. A caller is therefore expected to
 * treat a recorded lineage as a hint it must confirm, and to record a new one when it
 * cannot — see `runPlannerPhase`.
 *
 * If this table were dropped, every briefing and every observation would be unchanged and
 * the next planner round would simply pay for its own prefix.
 */
const planner = [
  `CREATE TABLE planner_rounds (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id),
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,
    write_fence INTEGER NOT NULL DEFAULT 0,
    harness_session_id TEXT,
    harness_instance_id TEXT,
    provider_id TEXT,
    model_id TEXT,
    started_at_sequence INTEGER NOT NULL,
    budget INTEGER NOT NULL,
    disposition TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    disposition_rationale TEXT
  )`,
  `CREATE INDEX planner_rounds_goal_idx ON planner_rounds(goal_id, status)`,
  `CREATE TABLE planner_lineages (
    goal_id TEXT PRIMARY KEY REFERENCES goals(id),
    harness_session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

/**
 * ## Assets: type-specific identity, and every discovery kept
 *
 * This is §6's **domain identity**, which is the third of the three questions at the
 * mutation boundary and the one the other two cannot answer: two distinct operations may
 * discover the same canonical asset, and the right outcome is one asset with two discovery
 * records — not two assets, and not one discovery silently overwriting the other.
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
 *   including them mints a new asset per parameter value and turns a surface inventory into
 *   a request log. The full submission is kept verbatim on every discovery row, so nothing
 *   is lost — it is just not identity.
 *
 * **Role is not part of endpoint identity, and that is a decision with a reason.** The same
 * URL and method tested as an administrator and as an anonymous caller is one endpoint;
 * splitting it by role would make the coverage denominator §17 warns about lie — two assets
 * where one exists — and would mean "we probed /admin unauthenticated" never counted as
 * having touched `/admin` at all. Role is a property of the test, not of the thing tested,
 * and it is already recorded where it belongs: on an observation's actors. The cost is
 * stated as a limitation: an endpoint that is genuinely two different endpoints depending on
 * who calls it is one row here, and only its observations distinguish them.
 *
 * The columns are nullable per kind and paired by a `CHECK`, the way `observations` pairs
 * its two formats, so a row cannot claim to be a host and carry a method. `identity` is
 * stored rather than computed on read because it is what the unique index is on, and a
 * normalisation rule that changed would otherwise silently re-partition existing rows.
 *
 * ### Two provenance tables, because the importer has no attempt
 *
 * `asset_discoveries` is keyed `(asset_id, operation_id)`: one discovery per operation, so a
 * replayed command adds nothing and two genuinely different operations that found the same
 * asset both survive. It records the intent and attempt that found it, which is the
 * provenance §6 requires retaining through a merge, and both are `NOT NULL` with real
 * foreign keys.
 *
 * `asset_imports` exists because the scope importer (D13) cannot satisfy that: it has an
 * operator behind it and no intent, no attempt and no goal — those rows do not exist yet and
 * will not until the operator creates one. D14 decides the shape, and the decision is **this
 * table, not a nullable `intent_id` on the other one.** Relaxing `asset_discoveries` would
 * weaken the invariant for every row in it, including every row a worker writes, so that one
 * caller with genuinely different provenance could share a shape it does not fit. Every
 * reader would then have to handle a null attempt, and "which attempt found this?" would stop
 * having an answer for reasons that have nothing to do with the asset.
 *
 * **The `assets` row is the same row either way.** A host the importer reads and the same
 * host a worker later discovers are *one* asset under §17's identity rules, in either order,
 * with one provenance row in each table — which is the whole point of having identity rules.
 * `UNIQUE (target_id, kind, identity)` is what makes that true in the schema rather than in a
 * handler, and both write paths reduce their submission with the same `assetIdentityOf`. The
 * cost is honest and small: "how did this asset come to be known" is a read over two tables
 * rather than one, and a view over the union is the obvious shape if more than one caller
 * ever wants it.
 *
 * `caller_scope` on both is *whose authority wrote this*, recorded rather than implied,
 * because a provenance row whose author is a convention is a row that cannot be audited.
 * `discovered_as` and `imported_as` are siblings: `identity` is normalised, so the submission
 * as it was actually made is kept verbatim there or it is lost. `source_url` cannot stand in
 * for `imported_as` — that is the page, not the asset read off it.
 *
 * Nothing here references a target: the file *is* the target (§3).
 *
 * The indexes are each table's non-key axis. A discovery is read by the intent that produced
 * it; an import by the page it came off, which is what D15 wants — one link with parseable
 * scope is enough and a link that yields nothing does not fail the import, so "what did
 * *this* page give us" is a per-link fact the intake screen reports. **Nothing reads
 * `asset_imports_source_idx` today**, which is stated rather than hidden. The per-asset read
 * on either table needs no index: both primary keys lead with `asset_id`.
 */
const assets = [
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
  `CREATE INDEX asset_discoveries_intent_idx
     ON asset_discoveries(intent_id)`,
  `CREATE TABLE asset_imports (
    asset_id TEXT NOT NULL REFERENCES assets(id),
    operation_id TEXT NOT NULL,
    caller_scope TEXT NOT NULL,
    source_url TEXT NOT NULL,
    imported_as TEXT NOT NULL,
    note TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (asset_id, operation_id),
    CHECK (length(source_url) > 0)
  )`,
  `CREATE INDEX asset_imports_source_idx
     ON asset_imports(source_url)`,
];

/**
 * ## Scope: the structured estate, and the operator's labels over it
 *
 * A target used to carry one free-text `scope_note` that **nothing read**. These three
 * tables are the machine-readable answer to "what is this client's estate", and they do two
 * jobs: they are what the agent is told it may test, and they are the frame the discovered
 * estate is displayed in. `scope_note` stays in the control-tier registry, unchanged, as
 * the target card's human description; it is simply not something a machine reads.
 *
 * **Here and not in `controlMigrations.ts`.** Entries describe one target's client estate
 * and are read on the same paths as that target's assets, so keeping them in
 * `targets/<id>/hunt.sqlite` means one store, one connection and one read to answer "what is
 * the scope here". It also keeps §3's deletion property intact: removing a target is still
 * `rm -rf targets/<id>/`, with no scope rows orphaned in the registry.
 *
 * ### `scope_entries` — two axes, and `UNIQUE` on all three identifying columns
 *
 * `effect` crossed with `kind` is six combinations, and the three-way kind split is the
 * point: an entry reading `acme.com` that silently means "and every subdomain" is the misread
 * the whole model exists to prevent, so the reach is a column rather than a convention.
 * `value` is stored **normalised** — `normaliseScopeEntry` runs on write — so the stored form
 * is the matched form and no read has to normalise anything.
 *
 * The unique index makes authoring idempotent: adding an entry that already exists is a
 * no-op rather than a duplicate row the matcher would evaluate twice. It is **per effect**,
 * which is deliberate and is why the store also refuses a direct contradiction at the write
 * boundary: this constraint would otherwise permit `in`/`host`/`blog.acme.com` beside
 * `out`/`host`/`blog.acme.com`. The matcher handles that pair fine — out wins — but the
 * screen cannot show it coherently and an operator who authored both did not mean to. That
 * check needs a read of the opposite effect, so it is a transaction rule rather than a
 * constraint.
 *
 * `source` is what makes the operator's review a real step rather than a wish. An imported
 * entry and a typed one are identical to the matcher and must be distinguishable on screen,
 * because "read this list before you start" only means something if the rows that need
 * reading are the ones a machine wrote. There is no `agent` source and there will not be
 * one: no agent that tests may write an entry.
 *
 * ### Two label tables, because an exclusion has to reach differently in each case
 *
 * `host_scope_labels` is keyed `(target_id, host)` and therefore covers **every asset on
 * that host, present and future.** That closes a real hole: with labels keyed only by asset,
 * excluding `legacy.acme.com` today would mark that one row, and `legacy.acme.com/login`
 * found tomorrow would be a different row with no label, would derive from the entries, and
 * would come back in scope. The operator's exclusion would silently fail to cover the thing
 * they meant by it. Keying on the host is what makes an exclusion mean what it says.
 *
 * `asset_scope_labels` is keyed by asset and beats its host's label for that one row, so a
 * single endpoint can be excluded without excluding its host, or kept while its host is
 * excluded. Specificity inside the label layer is fine: every row in both tables is an
 * explicit act by the same person, and the more specific act is the later, narrower decision.
 *
 * **Both hold current state, not history.** Every set and clear writes to the event log,
 * which is append-only and is where the history lives. That follows this codebase's existing
 * split rather than inventing two more append-only tables, and it is what lets a clear be a
 * plain `DELETE`.
 *
 * ### What the `CHECK`s are for, and what they cannot do
 *
 * The three enumerations are checked in the database, so "effect is in or out" is a
 * constraint a confused handler cannot get round rather than a property of the statements we
 * happen to have written — the same argument the event triggers make. What a `CHECK` cannot
 * express is the contradiction rule, which needs a second row, and the normalisation rule,
 * which needs the normaliser.
 *
 * **No foreign key from `host_scope_labels.host` to anything**, and that is required rather
 * than an oversight: the operator must be able to exclude a host *before* anything on it has
 * been discovered, and a host is not a row in this schema in the first place. An
 * `asset_scope_labels` row does reference `assets(id)`, because an asset label is about a row
 * that necessarily exists.
 *
 * Indexes: `scope_entries` is read whole, per target, on every derivation, so it is indexed
 * by `target_id`. The label tables are read by their primary keys and by target, and
 * `host_scope_labels`' primary key already leads with `target_id`.
 */
const scope = [
  `CREATE TABLE scope_entries (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    effect TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (target_id, effect, kind, value),
    CHECK (effect IN ('in', 'out')),
    CHECK (kind IN ('subtree', 'host', 'cidr')),
    CHECK (source IN ('operator', 'imported')),
    CHECK (length(value) > 0)
  )`,
  `CREATE INDEX scope_entries_target_idx ON scope_entries(target_id)`,
  `CREATE TABLE host_scope_labels (
    target_id TEXT NOT NULL,
    host TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (target_id, host),
    CHECK (state IN ('in', 'out')),
    CHECK (length(host) > 0)
  )`,
  `CREATE TABLE asset_scope_labels (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id),
    state TEXT NOT NULL,
    reason TEXT,
    set_by TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    CHECK (state IN ('in', 'out'))
  )`,
];

/**
 * ## Harness session indexes: which of the harness's sessions were ours
 *
 * **Pointers, not records of a conversation.** `DECISIONS.md` §8 is explicit that this build
 * persists no prose and reads it from the harness. What a harness cannot tell us is *which of
 * its sessions were ours*: it holds every session of every project, and a page that wants
 * "the importer sessions on this target" has nothing to ask it with. These two tables are
 * that index.
 *
 * ### `goal_sessions` — one row per goal, holding what cannot be re-derived
 *
 * The goal agent's session is created on the operator's first message and lives in this
 * process's memory along with its credential; nothing about the conversation is stored (the
 * goal and planner flow's decision 15). What is stored is the **session id**, for two things
 * a process cannot do without it:
 *
 * 1. **Replay after a reload.** The conversation's prose only exists in the harness, and
 *    asking for it needs the session id. Without a row, a reloaded tab could show a live
 *    conversation only while the process that opened it was still running.
 * 2. **Telling a restart from a fresh start.** The grant dies with the process and the row
 *    does not, so a goal with a row and no live session is one whose conversation this
 *    process cannot reach — which is exactly the state the next message must report as
 *    `priorUnavailable` rather than silently opening a second conversation. With no row there
 *    is nothing to say: nobody has talked to this goal.
 *
 * Shaped on `planner_lineages` deliberately, down to the upsert: there is exactly one current
 * answer per goal and a session the harness has forgotten is replaced by the next message, so
 * `goal_id` is the primary key rather than a row per session. The history of which sessions a
 * goal has had is not kept, because nothing reads it and keeping it would be the beginning of
 * storing the conversation. No index: one row per goal, read by its primary key.
 *
 * ### `import_sessions` — one row per import run, many runs per session
 *
 * `goal_sessions`' sibling, with one difference: a goal has one current session and a target
 * has a history of them. `import_id` is the key and `harness_session_id` is **deliberately
 * not unique.** Today an import is one run on one session and the two are 1:1. A session that
 * is continued later writes under a credential, and a credential is bound to an import id, so
 * a continuation is either the same id again or a new one — and this table is the same shape
 * either way. If it is a new one, the continuation inserts a second row naming the same
 * session, and the reader groups by session. Making the session the key instead would have
 * forced a rebuild at exactly that point.
 *
 * **There are no tallies on the row, and that is the decision.** The picker prints what a
 * session wrote (`7 in · 3 out · 14 assets`). Storing those three numbers here would mean
 * keeping them current: bumped by every importer write, by something other than the
 * transaction that made the write, and bumped again by every write a continued session makes.
 * A crash between the write and the bump leaves a count that is wrong for good, and nothing
 * detects it. They are **derived** instead, from rows that already say who wrote them and are
 * written in the same transaction as the thing they describe: `scope.entry.added` events and
 * `asset_imports` rows, both carrying `caller_scope`. `caller_scope` here is that exact
 * string — the importer's scope, `<targetId>/import/<importId>`, as `callerScopeOf({ _tag:
 * "importer" })` spells it — recorded rather than rebuilt in SQL, so the join is on the value
 * the writes were made under. What the derivation counts is what the session **wrote**, not
 * what is still there: an entry the operator later removes was still written by the session,
 * and the event log it is counted from is append-only.
 *
 * - **`session_created_at`** is whether the harness confirmed it created the session this row
 *   names, and the instant it answered `createSession`. The row is written **before** the
 *   session exists, for the attempt rows' reason: an id recorded first cannot be lost to a
 *   crash between creating the session and writing the row. The price is a row for a session
 *   that was never created (a gate that would not install, a harness that refused), and such
 *   a session wrote nothing, so its target is in exactly the empty-scope state the Assets
 *   screen offers "Continue that session" in. **A column rather than a heuristic**: preferring
 *   sessions with a non-zero tally is wrong in the direction that matters, because a session
 *   that was really created and has so far written nothing (the operator is mid-conversation,
 *   or the agent asked a question and stopped) has the same tally as one that never opened.
 *   `NULL` means "not confirmed", and the reader lists only confirmed rows.
 * - **`ended_at` and `ended_reason`** describe one *authority period*: the span in which one
 *   process held one credential and one registration for this import's session. Both are
 *   written together, by the first close, and never cleared. A harness session may have
 *   several authority periods; **the import id is what changes between them** — a later
 *   opening gets a new import id and a new row rather than reviving this one, and the index
 *   still reads as one session because it groups by `harness_session_id` and tallies across
 *   every `caller_scope` of the session.
 *
 *   The reasons, which are the whole list of things that close a session, are held to four by
 *   a `CHECK` that `NULL` passes:
 *
 *   - `operator` — the operator ended it. **The only reason the importer toolkit refuses a
 *     write on**, because it is the only one where the authority is genuinely over.
 *   - `shutdown` — this process's layer finalizer, on its way down.
 *   - `refused` — the harness refused a prompt, so the session was given up on.
 *   - `open_failed` — the open never got as far as a working session.
 *
 *   The last three are this process letting go. The credential behind them is already gone
 *   with the in-memory grant, so there is nothing left to gate, and gating would be the thing
 *   that stops a later period from continuing the session. `ended_at` alone would conflate
 *   them: every close stamps it, the finalizer included, so a graceful shutdown would end
 *   every open import while a crash ended none, and a gracefully restarted import could then
 *   never be continued (S7).
 * - **`model_options`** is `attempts.model_options` for an import's session, in the same
 *   encoding and for a sharper reason: a message to an import whose session this process no
 *   longer holds opens a fresh session on the **same** harness and model read back from this
 *   row, and without this column it would do so silently at the harness's default effort
 *   rather than the one the operator chose. A quiet downgrade of a setting someone chose is
 *   the same class of lie as a quiet harness substitution, which `RunDraft.instanceId`
 *   already refuses.
 * - **`pages`** is the list of pages this import's entries may name as their `source_url`,
 *   which the importer toolkit checks every write against. It was in process memory, which
 *   was right while an import was one turn; it is a conversation now, and a message to an
 *   import whose session a restart took away opens a fresh one under a new import id — whose
 *   list then held only what that one message named, so "continue" could not cite a page the
 *   operator had already given. JSON, an array of URLs in the operator's spelling and the
 *   order given, bounded by the same cap the in-memory list is
 *   (`SCOPE_IMPORT_MAX_LINKS`). **Only ever the operator's text**: nothing a model said or a
 *   page contained reaches it, which is what makes carrying it forward to a successor safe.
 *
 * `harness_instance_id` is nullable on both tables for `attempts`' reason: a session recorded
 * against an instance this server does not configure must not be *asked about* — the harness
 * we do have would answer a confident "no such session" for a session that may be alive
 * elsewhere — and that check needs the instance on the row. `model` is `provider/model` as the
 * live registry reports it; it is `NOT NULL` on an import, which always knows it at open time,
 * and nullable on a goal session, where a row may predate the column.
 *
 * No foreign key from `target_id` (the file *is* the target, §3). `import_sessions_target_idx`
 * serves the one read that scans: a target's sessions, newest first. The dedup `NOT EXISTS`
 * and the tally subqueries in `importSessions` probe `(target_id, harness_session_id)`, which
 * this index does not serve; they run per session over a handful of rows, so it is a scan of a
 * small table and not a cost worth a second index — but it is not covered either.
 */
const harnessSessions = [
  `CREATE TABLE goal_sessions (
    goal_id TEXT PRIMARY KEY REFERENCES goals(id),
    target_id TEXT NOT NULL,
    harness_session_id TEXT NOT NULL,
    harness_instance_id TEXT,
    opened_at INTEGER NOT NULL,
    model TEXT
  )`,
  `CREATE TABLE import_sessions (
    import_id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    harness_session_id TEXT NOT NULL,
    harness_instance_id TEXT,
    model TEXT NOT NULL,
    caller_scope TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    session_created_at INTEGER,
    ended_at INTEGER,
    ended_reason TEXT
      CHECK (ended_reason IN ('operator', 'shutdown', 'refused', 'open_failed')),
    model_options TEXT,
    pages TEXT,
    CHECK (length(harness_session_id) > 0)
  )`,
  `CREATE INDEX import_sessions_target_idx
     ON import_sessions(target_id, opened_at)`,
];

/**
 * `0001` — the whole hunt-tier schema, created in one entry.
 *
 * Grouped by domain above, in creation order. The only ordering constraint SQLite imposes
 * here is that a table referenced by a `REFERENCES` clause should exist before anything
 * inserts into the referring table; `intents.addresses_dimension` is a deliberate forward
 * reference, because `observations` and `observation_dimensions` reference `intents` in
 * turn and something has to be declared first.
 */
const baseline = statements(
  ...graph,
  ...recovery,
  ...dimensions,
  ...anchors,
  ...eventsAndOutbox,
  ...planner,
  ...assets,
  ...scope,
  ...harnessSessions,
);

/**
 * The ordered chain. **Append only; never edit an applied entry.**
 *
 * The key's numeric prefix is the id the journal records, and the rest is its name, so
 * renaming a key changes what the journal reports for an already-applied migration.
 *
 * **The ids must increase, and leaving a gap is worse than it looks.** `Migrator.run` reads
 * the highest id *this database's* journal holds (`effect/src/sql/Migrator.ts`,
 * `latestMigrationId`, resolved once per run) and skips every resolved id at or below it,
 * while the loader sorts by id (`fromRecord`, `Arr.sort(migrationOrder)`). So an id dropped
 * into a gap later runs on a fresh database, in the right order, and never on a database
 * already past it: the two diverge and the journal reports both as current. That is not a
 * hypothesis — it is what happened to `0014` of the chain this baseline replaces, and the
 * cost was a `500` in production-shaped code. Append with a number above every key here.
 */
export const MIGRATIONS: Record<
  string,
  Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
> = {
  "0001_baseline": baseline,
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
