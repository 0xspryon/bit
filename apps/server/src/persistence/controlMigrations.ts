/**
 * The control database's schema chain (DECISIONS.md §3 "two tiers").
 *
 * `control.sqlite` holds what is true across an installation: operator settings and the
 * **target registry**. It holds no graph, no observation, no event and no evidence. A
 * target's knowledge lives in `targets/<id>/hunt.sqlite`, and the reason is stated in §3
 * rather than being a layout preference: `rm -rf targets/<id>/` is provable deletion,
 * scope isolation becomes a filesystem guarantee instead of a `WHERE` clause somebody
 * might forget, and traffic capture is heavy.
 *
 * **This is a second, independent chain.** It has its own journal in its own file, so its
 * ids are numbered from `0001` again and have nothing to do with the hunt chain's. The
 * two must never be run against the same file: `MIGRATIONS` assumes the graph tables and
 * this one assumes the registry, and a file that had both would be a third thing neither
 * is written for. {@link FleetStore} is what keeps them apart, by construction — it is
 * the only thing that opens either.
 *
 * **Collapsed to a baseline once, on the same one-off licence `migrations.ts` explains:**
 * nothing is deployed, there is no production data, and the two entries this replaces were
 * a `CREATE TABLE` set plus one `ALTER TABLE` that belonged in it. The schema is
 * byte-for-byte what they produced. From here the rule is `AGENTS.md`'s and nothing else:
 * append only, ids must strictly increase, a gap is permanent because the migrator applies
 * only ids above the highest already applied, and there is no `down`, no `redo` and no
 * `undo` in `effect/sql`'s migrator to walk one back with.
 */
import { SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { runMigrations } from "./migrations";
import type { DatabaseError } from "./sql";

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
 * `0001` — the registry, its per-target schema state, and settings.
 *
 * **`targets` is the operator's record and only grows.** A target is registered once and
 * keeps its id for ever, because that id is a directory name: renaming it would orphan a
 * directory full of evidence, and reusing it would silently adopt somebody else's. The
 * id's shape is enforced above this table (`isTargetId`), because a registry row is what
 * a path is built from and a value that can escape `targets/` must never reach one.
 *
 * `archived_at` retires a target without deleting it. Deleting the row is not how a
 * target is removed — §3's answer to that is `rm -rf targets/<id>/`, and a registry row
 * whose directory is gone is a fact worth keeping rather than a dangling pointer, since
 * it is the only remaining record that the engagement happened at all.
 *
 * **`workspace_path` is not where a target's data lives.** A target's data has always
 * been at `<root>/targets/<id>/`. This is the folder on the operator's machine that the
 * engagement is *about*: the one chosen in the New target dialog, the one shown in the
 * target rail, and the one whose absence is a reason to dim a row. The two are separate
 * because they have separate lifetimes — `rm -rf targets/<id>/` destroys the recorded
 * evidence, while deleting the workspace folder destroys nothing we hold and must not
 * remove a target from the list.
 *
 * It is nullable rather than `NOT NULL DEFAULT ''` so that "no folder was recorded" is a
 * value a reader can test for, which is the honest state of a target with no
 * operator-chosen folder at all — including the one `main.ts` registers at startup to
 * serve a fixture. Nothing enforces uniqueness in the schema: registering two targets
 * against one folder is refused above this table, where the refusal can name the target
 * already holding it, and a `UNIQUE` constraint would surface the same mistake as a
 * driver fault with nothing useful to tell the operator — besides forbidding the several
 * legitimate `NULL`s.
 *
 * **`target_schema_state` is derived, and is the one table here that is rewritten.** It
 * records what the last fleet migration found out about one target's file: whether it is
 * `ready` to be opened, or `unavailable` because its migration failed and the reason. It
 * is per-process-start knowledge, upserted on every sweep, which is exactly why it is not
 * a column on `targets`: the registry says what the operator declared and this says what
 * the filesystem last agreed to.
 *
 * `applied_through` is the highest hunt-chain id that file holds, read from its own
 * journal rather than assumed from the chain this build ships. Two targets can legitimately
 * sit at different ids — one migrated cleanly and one failed half way up — and a single
 * global "schema version" would be a lie about a fleet.
 *
 * `settings` is a key/value table with no schema over the values on purpose. Nothing reads
 * a setting for behaviour yet; it exists because §3 names settings as control-tier content,
 * and giving it a home costs one table and avoids a migration when the first real setting
 * arrives. A value is TEXT and its meaning belongs to whatever writes it.
 */
const createRegistry = statements(
  `CREATE TABLE targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope_note TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    workspace_path TEXT
  )`,
  `CREATE TABLE target_schema_state (
    target_id TEXT PRIMARY KEY REFERENCES targets(id),
    state TEXT NOT NULL,
    applied_through INTEGER,
    detail TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    CHECK (state IN ('ready', 'unavailable'))
  )`,
  `CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
);

/** The ordered control chain. Append only; ids must increase and a gap is permanent. */
export const CONTROL_MIGRATIONS: Record<
  string,
  Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>
> = {
  "0001_control_baseline": createRegistry,
};

export const controlMigrationLoader =
  SqliteMigrator.fromRecord(CONTROL_MIGRATIONS);

/**
 * Applies pending control migrations, returning the `[id, name]` pairs this call applied.
 *
 * Shares {@link runMigrations} with the hunt chain, so the defect-to-typed-failure
 * conversion is the same code and not a second copy of it that could drift.
 */
export const migrateControl: Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  DatabaseError,
  SqlClient.SqlClient
> = runMigrations({ loader: controlMigrationLoader });
