/**
 * Two tiers on disk, and the migration runner that iterates the registry
 * (DECISIONS.md §3 "two tiers", §13 step 2).
 *
 * ```
 * <root>/
 *   control.sqlite                 settings and the target registry
 *   targets/
 *     <target-id>/
 *       hunt.sqlite                the graph, its events and its outbox
 *       evidence/                  content-hashed blobs, deliberately not in SQLite
 * ```
 *
 * **Why per-target files rather than one database.** §3 gives three reasons and they are
 * not stylistic. Provable deletion: `rm -rf targets/<id>/` is complete and demonstrable
 * where `DELETE` plus `VACUUM` is not, and evidence destruction is something clients
 * require. Scope isolation as a filesystem guarantee rather than a `WHERE` clause we
 * might forget — which matters here more than anywhere, scope drift being the central
 * defect this project exists to avoid. And size, because traffic capture is heavy.
 *
 * **The accepted cost is this file.** Migrations must run against N files, and §3 says to
 * build the runner that iterates the registry from day one because retrofitting it at
 * target #4 is painful. {@link FleetStore.migrateFleet} is that runner.
 *
 * **The partial-failure policy, decided here.** A chain that fails on target 3 leaves 1
 * and 2 migrated, and there is no `down` to undo them. The policy is: **serve the targets
 * that migrated and mark the rest unavailable; fail startup only when the control
 * database itself cannot be migrated.** Four reasons:
 *
 * 1. The alternative couples availability globally, which throws away the isolation the
 *    file split exists to provide: one unreadable file would stop work on every unrelated
 *    engagement.
 * 2. A failed migration is rolled back by the migrator's own transaction, so the file is
 *    left at its last good id. That is a safe state to refuse to open and to retry from.
 * 3. It is recorded rather than tolerated. The registry carries `state = 'unavailable'`
 *    with the failure text, {@link FleetStore.openTarget} refuses that target by name,
 *    and nothing silently returns an empty graph for it.
 * 4. Control is genuinely different. Without the registry there is no list of targets to
 *    serve, so there is nothing to degrade *to* — that case fails layer acquisition.
 *
 * Its cost, stated: nothing retries an unavailable target except another sweep, and a
 * sweep happens at startup. A target that fails to migrate stays out until the process is
 * restarted with a fixed forward migration.
 *
 * **A target id is a directory name**, so it is validated before it reaches a path, not
 * after. {@link isTargetId} is the only gate, and every path in this module is built
 * through {@link fleetPaths} from an id that passed it.
 */
import { mkdirSync } from "node:fs";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

import { migrateControl } from "./controlMigrations";
import { migrate } from "./migrations";
import { ObservationStore } from "./store";
import { DatabaseError, asDatabaseError, sqliteLayer } from "./sql";

/** The control database's file name under the fleet root. */
export const CONTROL_FILE = "control.sqlite";
/** Every target's directory sits under this one. */
export const TARGETS_DIRECTORY = "targets";
/** One target's graph file, inside its own directory. */
export const HUNT_FILE = "hunt.sqlite";
/** Where content-hashed evidence blobs go. Out of SQLite, by §3. */
export const EVIDENCE_DIRECTORY = "evidence";

/**
 * Whether a string may be used as a target id.
 *
 * Lowercase alphanumerics, hyphen and underscore, 1–64 characters, and it must start
 * with an alphanumeric. That excludes `.`, `..`, `/`, `\`, a leading hyphen, a leading
 * dot, whitespace, and anything a case-insensitive filesystem would fold onto an
 * existing id — so an id cannot name a directory outside `targets/`, cannot name the
 * control file, and cannot be two ids on one machine and one on another.
 *
 * Checked at registration and again on every open. The second check is not redundant:
 * a registry row can arrive from a file somebody edited, and the id is about to be
 * concatenated into a path.
 */
export const isTargetId = (value: string): boolean =>
  /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

/** Every path the fleet layout defines, built from a validated id. */
export interface FleetPaths {
  readonly root: string;
  readonly controlFile: string;
  readonly targetDirectory: (targetId: string) => string;
  readonly huntFile: (targetId: string) => string;
  readonly evidenceDirectory: (targetId: string) => string;
}

/**
 * The layout for one root.
 *
 * Joined with `/` rather than through `node:path` so the shape is identical regardless
 * of platform separators, which is what the registry's stored ids assume. The guard is
 * `isTargetId`: every function here throws on an id that did not pass it, because a path
 * built from an unvalidated id is the one defect in this module that would not surface
 * as a failed query.
 */
export const fleetPaths = (root: string): FleetPaths => {
  const checked = (targetId: string): string => {
    if (!isTargetId(targetId)) {
      throw new Error(`refusing to build a path from target id '${targetId}'`);
    }
    return targetId;
  };
  return {
    root,
    controlFile: `${root}/${CONTROL_FILE}`,
    targetDirectory: (targetId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}`,
    huntFile: (targetId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}/${HUNT_FILE}`,
    evidenceDirectory: (targetId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}/${EVIDENCE_DIRECTORY}`,
  };
};

/**
 * A refused fleet operation.
 *
 * Separate from {@link DatabaseError} because every reason here is a decision rather
 * than a driver fault: the id is unusable, the target is not registered, or its file did
 * not migrate. A caller can report any of them to an operator as-is.
 */
export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  reason: Schema.Literals([
    "invalid_target_id",
    "unknown_target",
    "duplicate_target",
    "target_unavailable",
  ]),
  targetId: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.reason} (${this.targetId}): ${this.detail}`;
  }
}

export interface TargetRegistration {
  readonly targetId: string;
  readonly name: string;
  /** Prose the operator wrote about what is in scope. Advisory, never enforcement. */
  readonly scopeNote: string;
}

export interface TargetRow {
  readonly targetId: string;
  readonly name: string;
  readonly scopeNote: string;
  readonly createdAt: number;
  readonly archivedAt: number | undefined;
}

/** What one target's file turned out to be, after the last sweep looked at it. */
export interface TargetSchemaState {
  readonly targetId: string;
  readonly state: "ready" | "unavailable";
  /** Highest hunt-chain id that file holds, from its own journal. */
  readonly appliedThrough: number | undefined;
  readonly detail: string;
  readonly checkedAt: number;
}

/** One target's outcome from a fleet sweep. */
export interface FleetMigrationOutcome {
  readonly targetId: string;
  readonly state: "ready" | "unavailable";
  /** The `[id, name]` pairs this sweep applied to that file. Empty when current. */
  readonly applied: ReadonlyArray<readonly [id: number, name: string]>;
  readonly appliedThrough: number | undefined;
  readonly detail: string;
}

const TargetRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope_note: Schema.String,
  created_at: Schema.Finite,
  archived_at: Schema.NullOr(Schema.Finite),
});

const SchemaStateRecord = Schema.Struct({
  target_id: Schema.String,
  state: Schema.Literals(["ready", "unavailable"]),
  applied_through: Schema.NullOr(Schema.Int),
  detail: Schema.String,
  checked_at: Schema.Finite,
});

const JournalHighWater = Schema.Struct({
  value: Schema.NullOr(Schema.Int),
});

const toTarget = (row: typeof TargetRecord.Type): TargetRow => ({
  targetId: row.id,
  name: row.name,
  scopeNote: row.scope_note,
  createdAt: row.created_at,
  archivedAt: row.archived_at ?? undefined,
});

const toSchemaState = (
  row: typeof SchemaStateRecord.Type,
): TargetSchemaState => ({
  targetId: row.target_id,
  state: row.state,
  appliedThrough: row.applied_through ?? undefined,
  detail: row.detail,
  checkedAt: row.checked_at,
});

/**
 * The control client, with the fleet root created first.
 *
 * `Layer.unwrap` rather than two layers side by side, because the ordering is the whole
 * point: `bun:sqlite` cannot create a file in a directory that does not exist, so the
 * first run against a fresh root failed to open `control.sqlite` before this. An
 * `Effect` that produces a `Layer` is built in that order by construction, where two
 * layers whose dependency is only conventional are built in whatever order the graph
 * settles on.
 */
const controlClientLayer = (root: string) =>
  Layer.unwrap(
    Effect.map(
      Effect.try({
        try: () => mkdirSync(root, { recursive: true }),
        catch: (cause) =>
          new DatabaseError({
            operation: "open",
            reason: `could not create the fleet root ${root}`,
            cause,
          }),
      }),
      () => sqliteLayer(`${root}/${CONTROL_FILE}`),
    ),
  );

const makeFleet = Effect.fnUntraced(function* (root: string) {
  const sql = yield* SqlClient.SqlClient;
  const paths = fleetPaths(root);

  // The control chain, before the service is published. A control database that did not
  // migrate means there is no registry, so there is nothing to serve and nothing to
  // degrade to: this is the one failure in this module that is fatal.
  const appliedControl = yield* migrateControl;
  if (appliedControl.length > 0) {
    yield* Effect.logInfo(
      `control migrations applied: ${appliedControl
        .map(([id, name]) => `${String(id)}_${name}`)
        .join(", ")}`,
    );
  }

  const query = asDatabaseError("query");

  const selectTargets = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TargetRecord,
    execute: () =>
      sql`SELECT id, name, scope_note, created_at, archived_at
          FROM targets ORDER BY created_at, id`,
  });

  const selectTarget = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: TargetRecord,
    execute: (targetId) =>
      sql`SELECT id, name, scope_note, created_at, archived_at
          FROM targets WHERE id = ${targetId}`,
  });

  const selectSchemaState = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SchemaStateRecord,
    execute: (targetId) =>
      sql`SELECT target_id, state, applied_through, detail, checked_at
          FROM target_schema_state WHERE target_id = ${targetId}`,
  });

  const selectSetting = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ value: Schema.String }),
    execute: (key) => sql`SELECT value FROM settings WHERE key = ${key}`,
  });

  /** Lifts a `SqlSchema` failure, whose error channel carries a driver fault or a decode. */
  const lift =
    (table: string, rowId: string) =>
    (error: {
      readonly _tag: string;
      readonly message: string;
    }): DatabaseError =>
      error._tag === "SqlError"
        ? query(error as never)
        : new DatabaseError({
            operation: "query",
            reason: `${table}/${rowId} did not decode: ${error.message}`,
            cause: error,
          });

  /**
   * Creates a directory, outside every transaction.
   *
   * Synchronous and deliberately so: it is called before a connection is opened and
   * never while one holds a write lock, which is the rule §3 states and the reason this
   * is not reachable from inside `withTransaction` anywhere in this module.
   */
  const ensureDirectory = (path: string, targetId: string) =>
    Effect.try({
      try: () => mkdirSync(path, { recursive: true }),
      catch: (cause) =>
        new DatabaseError({
          operation: "open",
          reason: `could not create ${path} for target ${targetId}`,
          cause,
        }),
    });

  /** Every registered target, archived ones included, oldest first. */
  const targets = Effect.fn("FleetStore.targets")(function* () {
    const rows = yield* selectTargets().pipe(
      Effect.mapError(lift("targets", "all")),
    );
    return rows.map(toTarget);
  });

  const target = Effect.fn("FleetStore.target")(function* (targetId: string) {
    const row = yield* selectTarget(targetId).pipe(
      Effect.mapError(lift("targets", targetId)),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: toTarget,
    });
  });

  const schemaState = Effect.fn("FleetStore.schemaState")(function* (
    targetId: string,
  ) {
    const row = yield* selectSchemaState(targetId).pipe(
      Effect.mapError(lift("target_schema_state", targetId)),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: toSchemaState,
    });
  });

  /**
   * Registers a target and creates its directories.
   *
   * The registry row and the directories are two separate commits and that is
   * deliberate: creating a directory is filesystem work, which must not happen inside a
   * SQLite transaction (§3 — the single write lock is held for its duration). The order
   * is directories first, then the row, so the failure mode is a directory with no
   * registry row — which is inert and which a re-registration adopts — rather than a
   * registered target whose file nothing can open.
   *
   * A duplicate id is refused rather than adopted. An id is a directory full of
   * somebody's evidence, and "register" quietly meaning "attach to the existing one"
   * is how two engagements end up sharing a file.
   */
  const register = Effect.fn("FleetStore.register")(function* (
    input: TargetRegistration,
  ) {
    if (!isTargetId(input.targetId)) {
      return yield* new FleetError({
        reason: "invalid_target_id",
        targetId: input.targetId,
        detail:
          "a target id becomes a directory name: use 1-64 characters of lowercase a-z, 0-9, '-' or '_', starting with a letter or digit",
      });
    }
    const existing = yield* target(input.targetId);
    if (existing !== undefined) {
      return yield* new FleetError({
        reason: "duplicate_target",
        targetId: input.targetId,
        detail: `target ${input.targetId} is already registered as '${existing.name}'; an id names a directory of recorded evidence and is never reused`,
      });
    }
    yield* ensureDirectory(
      paths.targetDirectory(input.targetId),
      input.targetId,
    );
    yield* ensureDirectory(
      paths.evidenceDirectory(input.targetId),
      input.targetId,
    );
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO targets (id, name, scope_note, created_at)
      VALUES (${input.targetId}, ${input.name}, ${input.scopeNote}, ${now})`.pipe(
      Effect.mapError(query),
    );
    return {
      targetId: input.targetId,
      name: input.name,
      scopeNote: input.scopeNote,
      createdAt: now,
      archivedAt: undefined,
    } satisfies TargetRow;
  });

  /** Retires a target without deleting anything. Idempotent. */
  const archive = Effect.fn("FleetStore.archive")(function* (targetId: string) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE targets SET archived_at = COALESCE(archived_at, ${now})
      WHERE id = ${targetId}`.pipe(Effect.mapError(query));
  });

  const recordSchemaState = Effect.fnUntraced(function* (
    state: TargetSchemaState,
  ) {
    yield* sql`INSERT INTO target_schema_state
        (target_id, state, applied_through, detail, checked_at)
      VALUES (${state.targetId}, ${state.state}, ${state.appliedThrough ?? null},
              ${state.detail}, ${state.checkedAt})
      ON CONFLICT(target_id) DO UPDATE SET
        state = excluded.state,
        applied_through = excluded.applied_through,
        detail = excluded.detail,
        checked_at = excluded.checked_at`.pipe(Effect.mapError(query));
  });

  /** The highest hunt-chain id one target's own journal holds. */
  const appliedThroughOf = Effect.fnUntraced(function* (targetId: string) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const huntSql = yield* SqlClient.SqlClient;
        const rows = yield* huntSql<{ value: number | null }>`
          SELECT MAX(migration_id) AS value FROM effect_sql_migrations`;
        const decodedRow = yield* Schema.decodeUnknownEffect(JournalHighWater)(
          rows[0] ?? { value: null },
        );
        return decodedRow.value ?? undefined;
      }).pipe(
        Effect.provide(sqliteLayer(paths.huntFile(targetId))),
        Effect.mapError((error) =>
          error instanceof DatabaseError ? error : query(error as never),
        ),
      ),
    );
  });

  /**
   * Migrates one target's file, in its own scope, and records what happened.
   *
   * The file is opened, migrated and **closed** before the state row is written. Nothing
   * here nests a database inside a transaction on another one, and no filesystem work
   * happens inside either: the directory is created first, the hunt connection lives and
   * dies in its own scope, and only then does one statement land in the control file.
   *
   * A failure is caught and turned into an `unavailable` row. That is the whole of the
   * partial-failure policy in one place — the sweep carries on to the next target, and
   * this one is refused by name until a later sweep finds it fixed.
   */
  const migrateTarget = Effect.fn("FleetStore.migrateTarget")(function* (
    targetId: string,
  ): Effect.fn.Return<FleetMigrationOutcome, DatabaseError | FleetError> {
    if (!isTargetId(targetId)) {
      return yield* new FleetError({
        reason: "invalid_target_id",
        targetId,
        detail: `the registry holds an id that cannot be a directory name: '${targetId}'`,
      });
    }
    yield* ensureDirectory(paths.targetDirectory(targetId), targetId);
    const run = Effect.scoped(
      migrate.pipe(Effect.provide(sqliteLayer(paths.huntFile(targetId)))),
    );
    const outcome = yield* Effect.result(run);
    const checkedAt = yield* Clock.currentTimeMillis;
    if (outcome._tag === "Failure") {
      const detail = outcome.failure.message;
      yield* recordSchemaState({
        targetId,
        state: "unavailable",
        // Read from the journal rather than assumed: the migrator rolled its failure
        // back, so the file sits at whatever id it last completed, and that is the
        // number an operator needs. If even this read fails the file is unreadable, and
        // `undefined` says so.
        appliedThrough: yield* appliedThroughOf(targetId).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
        detail,
        checkedAt,
      });
      return {
        targetId,
        state: "unavailable",
        applied: [],
        appliedThrough: undefined,
        detail,
      };
    }
    const appliedThrough = yield* appliedThroughOf(targetId);
    const detail =
      outcome.success.length === 0
        ? "already current"
        : `applied ${outcome.success
            .map(([id, name]) => `${String(id)}_${name}`)
            .join(", ")}`;
    yield* recordSchemaState({
      targetId,
      state: "ready",
      appliedThrough,
      detail,
      checkedAt,
    });
    return {
      targetId,
      state: "ready",
      applied: outcome.success,
      appliedThrough,
      detail,
    };
  });

  /**
   * Migrates every registered, unarchived target, in registration order.
   *
   * One target's failure does not stop the sweep, and that is the recorded policy rather
   * than a swallowed error: the failure becomes an `unavailable` row that
   * {@link openTarget} refuses by name, and the outcome is returned so a caller can log
   * it. An archived target is skipped — its file may legitimately have been deleted with
   * `rm -rf`, and migrating it would recreate an empty one.
   */
  const migrateFleet = Effect.fn("FleetStore.migrateFleet")(function* () {
    const registered = yield* targets();
    const outcomes: FleetMigrationOutcome[] = [];
    for (const row of registered) {
      if (row.archivedAt !== undefined) continue;
      outcomes.push(yield* migrateTarget(row.targetId));
    }
    return outcomes as readonly FleetMigrationOutcome[];
  });

  /**
   * The path of one target's graph file, or a refusal naming why it cannot be opened.
   *
   * Three refusals, each of which a caller can report: the id is unusable, nothing is
   * registered under it, or its last migration failed. The third is the one that makes
   * the partial-failure policy real — a target marked `unavailable` is not quietly served
   * as an empty graph.
   *
   * A target with no schema-state row has never been swept. It is refused too, because
   * opening it would run the chain under a caller that is not expecting to migrate, and
   * the sweep is where that belongs.
   */
  const huntFileFor = Effect.fn("FleetStore.huntFileFor")(function* (
    targetId: string,
  ) {
    if (!isTargetId(targetId)) {
      return yield* new FleetError({
        reason: "invalid_target_id",
        targetId,
        detail: "not a usable target id",
      });
    }
    const row = yield* target(targetId);
    if (row === undefined) {
      return yield* new FleetError({
        reason: "unknown_target",
        targetId,
        detail: `no target ${targetId} is registered in ${CONTROL_FILE}`,
      });
    }
    const state = yield* schemaState(targetId);
    if (state === undefined) {
      return yield* new FleetError({
        reason: "target_unavailable",
        targetId,
        detail: `target ${targetId} has not been migrated in this installation; run the fleet migration before opening it`,
      });
    }
    if (state.state !== "ready") {
      return yield* new FleetError({
        reason: "target_unavailable",
        targetId,
        detail: `target ${targetId} did not migrate: ${state.detail}`,
      });
    }
    return paths.huntFile(targetId);
  });

  const setting = Effect.fn("FleetStore.setting")(function* (key: string) {
    const row = yield* selectSetting(key).pipe(
      Effect.mapError(lift("settings", key)),
    );
    return Option.match(row, {
      onNone: () => undefined,
      onSome: (value) => value.value,
    });
  });

  const setSetting = Effect.fn("FleetStore.setSetting")(function* (
    key: string,
    value: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, ${value}, ${now})
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at`.pipe(
      Effect.mapError(query),
    );
  });

  return FleetStore.of({
    paths,
    targets,
    target,
    register,
    archive,
    schemaState,
    migrateTarget,
    migrateFleet,
    huntFileFor,
    setting,
    setSetting,
  });
});

export class FleetStore extends Context.Service<
  FleetStore,
  {
    readonly paths: FleetPaths;
    readonly targets: () => Effect.Effect<readonly TargetRow[], DatabaseError>;
    readonly target: (
      targetId: string,
    ) => Effect.Effect<TargetRow | undefined, DatabaseError>;
    readonly register: (
      input: TargetRegistration,
    ) => Effect.Effect<TargetRow, FleetError | DatabaseError>;
    readonly archive: (targetId: string) => Effect.Effect<void, DatabaseError>;
    readonly schemaState: (
      targetId: string,
    ) => Effect.Effect<TargetSchemaState | undefined, DatabaseError>;
    readonly migrateTarget: (
      targetId: string,
    ) => Effect.Effect<FleetMigrationOutcome, DatabaseError | FleetError>;
    readonly migrateFleet: () => Effect.Effect<
      readonly FleetMigrationOutcome[],
      DatabaseError | FleetError
    >;
    readonly huntFileFor: (
      targetId: string,
    ) => Effect.Effect<string, FleetError | DatabaseError>;
    readonly setting: (
      key: string,
    ) => Effect.Effect<string | undefined, DatabaseError>;
    readonly setSetting: (
      key: string,
      value: string,
    ) => Effect.Effect<void, DatabaseError>;
  }
>()("bit/persistence/FleetStore") {
  /**
   * Opens and migrates `<root>/control.sqlite` before publishing the service.
   *
   * It does **not** sweep the fleet: migrating N target files at layer construction
   * would make every consumer of the registry pay for it, and the sweep is a startup
   * step a caller decides to take. `main.ts` takes it.
   */
  static readonly layer = (root: string) =>
    Layer.effect(FleetStore, makeFleet(root)).pipe(
      Layer.provide(controlClientLayer(root)),
    );
}

/**
 * One target's store, as a layer, with the registry consulted first.
 *
 * This is the only sanctioned way to reach a target's graph: the id is validated, the
 * registry is asked whether that target exists and migrated, and only then is a file
 * opened. A caller cannot assemble a path itself and get a store, which is what keeps
 * "unavailable" from being advisory.
 *
 * Requires {@link FleetStore}, so a store for target B cannot be obtained from target
 * A's connection — the two files are never both open on one `SqlClient`.
 */
export const targetStoreLayer = (
  targetId: string,
): Layer.Layer<ObservationStore, FleetError | DatabaseError, FleetStore> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fleet = yield* FleetStore;
      const file = yield* fleet.huntFileFor(targetId);
      return ObservationStore.layer(file);
    }),
  );
