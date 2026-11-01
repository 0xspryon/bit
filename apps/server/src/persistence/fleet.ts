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
 *       planning/<round-id>/       one planner round's directory, made on demand
 *       goal/<goal-id>/            one goal agent's directory, made on demand
 *         uploads/                 files the operator attached to that conversation
 * ```
 *
 * The operator's own folder (`workspace_path`, where workers run) is the fourth place and
 * is not under this tree. `planning/` and `goal/` sit here, and never inside that folder,
 * for the reason given on {@link FleetPaths.planningDirectory}.
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
 * **Ratified for creation, not only for startup** (`sprint-02.md` §4 left this open; it is
 * closed here). `POST /api/v1/targets` registers a target and then migrates that one
 * file. When that migration fails, the registry row **stays**, the target is listed as
 * unavailable with the failure text, and every other target keeps serving. The
 * registration is not rolled back and the request is not an error:
 *
 * - The row is the only record that the operator asked for this engagement, and the
 *   directory it names already exists on disk. Deleting the row would leave an orphaned
 *   directory and no way to find it from the UI, which is worse than a dimmed row that
 *   says exactly what went wrong.
 * - The same policy at startup and at creation means one state machine, not two. A
 *   target created today and swept tomorrow reaches `unavailable` by the same path and is
 *   refused by {@link FleetStore.huntFileFor} by the same check.
 * - Failing the request would tell the operator the target does not exist while its
 *   directory, its registry row and its half-migrated file all do.
 *
 * So the HTTP surface has no "migration failed" error member: it returns the created
 * target with `available: false` and a reason. The UI's migration-failed state is driven
 * by that, which is why the two cannot disagree.
 *
 * **A target id is a directory name**, so it is validated before it reaches a path, not
 * after. {@link isTargetId} is the only gate, and every path in this module is built
 * through {@link fleetPaths} from an id that passed it.
 */
import { mkdirSync } from "node:fs";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

// Type-only, and mutually so: `policy/install.ts` imports `UngatedRoleDirectory` from here
// the same way. Neither module reaches the other at runtime, and this one still knows no
// harness; see {@link FleetStore.ensureGoalUploads} for why the brand is asked for.
import type { GatedDirectory } from "../policy/install";
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
/** Holds one directory per planner round; see {@link FleetPaths.planningDirectory}. */
export const PLANNING_DIRECTORY = "planning";
/** Holds one directory per goal agent; see {@link FleetPaths.goalDirectory}. */
export const GOAL_DIRECTORY = "goal";
/** Holds one directory per scope import; see {@link FleetPaths.importDirectory}. */
export const IMPORT_DIRECTORY = "import";
/**
 * Where a goal conversation's attachments go, **inside** that goal's own directory.
 *
 * Inside rather than beside, and that is the whole point: the goal agent's session runs in
 * `goal/<goal-id>/`, so a file put here is one it can already read with the tools it has,
 * with no path handed to it and nothing else gaining access. The engagement folder is the
 * place it is deliberately *not* — see {@link FleetPaths.goalUploadsDirectory}.
 */
export const UPLOADS_DIRECTORY = "uploads";

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

/**
 * Whether a string may name a planner round's or a goal's directory.
 *
 * The same shape as {@link isTargetId} with one difference: upper case is allowed. These
 * ids are minted (`goal_` plus 26 base62 characters, see `identifier.ts`) rather than
 * typed, and base62 is mixed-case, so refusing upper case would refuse every real id.
 *
 * The cost is stated rather than hidden: on a case-insensitive filesystem two ids that
 * differ only in case would share one directory, and under OpenCode a shared directory is
 * a shared authority (see {@link FleetPaths.planningDirectory}). It is accepted because
 * a minted id begins with fourteen lowercase hex characters of a strictly increasing
 * timestamp-and-counter, so two ids from one process always differ there and never in
 * case alone. An id that did not come from `identifier.ts` is not covered by that.
 */
export const isRoleDirectoryId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);

/**
 * A planner or goal directory that exists and has **not** had the policy gate installed.
 *
 * **Why this is an object and not a string.** The rule is that a session is never created
 * in a role directory the gate is not in, and a comment saying so is not a boundary: a
 * `string` can be handed to `createSession` as readily as any other. So
 * {@link FleetStore.ensurePlanningDirectory} and {@link FleetStore.ensureGoalDirectory}
 * return this instead. It has no string coercion and is not accepted anywhere a path is,
 * so using it as a directory is a type error, and the one thing that turns it into a path
 * is `gatedRoleDirectory` (`policy/install.ts`), which installs the gate first and returns
 * the path branded as gated.
 *
 * What this does not do: {@link UngatedRoleDirectory.unsafePath} exists, because the gate
 * installer and the tests must read the path, and a caller determined to bypass the gate
 * can call it. The guarantee is that bypassing is a visible, greppable act named `unsafe`,
 * and never an accident of passing the return value along. The path can also still be
 * rebuilt from {@link FleetPaths}, as it always could; that is why `FleetPaths` is not
 * handed to session code.
 */
export class UngatedRoleDirectory {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  /** The directory, without the gate. Read by `gatedRoleDirectory` and by tests only. */
  unsafePath(): string {
    return this.#path;
  }
}

/** Every path the fleet layout defines, built from a validated id. */
export interface FleetPaths {
  readonly root: string;
  readonly controlFile: string;
  readonly targetDirectory: (targetId: string) => string;
  readonly huntFile: (targetId: string) => string;
  readonly evidenceDirectory: (targetId: string) => string;
  /**
   * The directory one planner round runs in.
   *
   * **One directory per round, and not under the workspace.** The first rule comes from
   * what Spike B measured (`spike/mcpIsolationProof.ts`, commit `ad4fe94`), and it is
   * security rather than tidiness:
   *
   * Under OpenCode 2.2.1 an MCP registration belongs to a *directory*. Two sessions shared
   * one directory, each registered under its own name and token. The second was asked to
   * call the first's server, did, and the write landed under the **first** session's
   * attempt, carried by the first session's bearer token; the second session's own
   * credential recorded nothing. A third session in a sibling directory was refused by the
   * harness ("Unknown tool"), and the recording proxy saw no request at all. So the
   * directory is the only thing separating one session's tool authority from another's,
   * and two rounds sharing a directory would see each other's registrations exactly as
   * those two sessions did. A round's directory is therefore its own, and a worker's
   * workspace is never also a planner's.
   *
   * The second rule is the one `evidence/` already follows: a worker must not be able to
   * read the machinery that supervises it. The gate, its configuration and the harness's
   * own per-directory state live in the directory a session runs in, so a planner
   * directory inside the workspace would put them where the worker can read them.
   *
   * What the spike did **not** establish: it compared a shared directory with a *sibling*,
   * not with a nested one, and it did not try a symlink or a differently spelled path to
   * the same directory. So no role's directory here is nested inside another's, and
   * `policy/install.ts` refuses a role directory inside the workspace rather than
   * trusting the harness to treat a child as separate. Claude Code, by contrast, kept two
   * live sessions in one directory apart (the second found no tool for the first's
   * server); that is a property of its session-scoped registration, and this layout does
   * not lean on it.
   */
  readonly planningDirectory: (targetId: string, roundId: string) => string;
  /**
   * The directory one goal agent runs in.
   *
   * Outside the workspace and distinct from every round's directory, for the reasons on
   * {@link planningDirectory}. It matters more here: a goal agent's session is long-lived
   * and its credential has no clock expiry (spec decision 4), so what contains it is the
   * directory it is registered in. Process death and explicit revocation end the
   * credential, and a second session placed in this directory would be able to use it
   * for as long as it lived. Spike B is the evidence that this is a real way to lose
   * containment under OpenCode rather than a hypothetical one.
   */
  readonly goalDirectory: (targetId: string, goalId: string) => string;
  /**
   * Where files the operator attached to one goal's conversation are kept.
   *
   * `goal/<goal-id>/uploads/`, and the nesting is deliberate twice over.
   *
   * **Inside the goal's directory**, because that is the directory the goal agent's
   * session runs in: a file here is readable by the one agent the operator is talking to,
   * through the tools it already has, with no path passed to it and no second grant.
   *
   * **Never inside the engagement folder**, which is the rule this path exists to keep.
   * Concurrent worker attempts on one target share `workspace/` (DECISIONS.md §24.2,
   * caveat 2), so an attachment dropped there would be readable by every worker on the
   * target — and a worker silently acquiring the operator's documents is not something
   * attaching a file to a conversation asks for. `gatedRoleDirectory` refuses a goal
   * directory inside the workspace, so this path inherits that refusal rather than
   * restating it.
   *
   * A **path**, not an authority: it is below a role directory, so it must only ever be
   * written to after that role directory has been through `gatedRoleDirectory`. The one
   * function here that creates it, {@link FleetStore.ensureGoalUploads}, takes the gated
   * path as its argument for exactly that reason.
   */
  readonly goalUploadsDirectory: (targetId: string, goalId: string) => string;
  /**
   * The directory one scope import runs in.
   *
   * A fourth sibling, outside the workspace and distinct from every round's and every
   * goal's directory, for the reasons on {@link planningDirectory}. The importer is the
   * role with the least business acting in a directory at all — it fetches a page and
   * calls three tools — and that is exactly why it gets its own gated one: the policy hook
   * lives in the directory a session runs in, so a session with no directory of its own is
   * a session whose tool calls are audited somewhere else or not at all.
   *
   * Under `targets/<id>/` rather than anywhere global, so `DECISIONS.md` §3's deletion
   * property survives: removing a target is still `rm -rf targets/<id>/`, and an import's
   * audit log and harness state go with it.
   */
  readonly importDirectory: (targetId: string, importId: string) => string;
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
  const checkedRole = (kind: string, id: string): string => {
    if (!isRoleDirectoryId(id)) {
      throw new Error(`refusing to build a path from ${kind} id '${id}'`);
    }
    return id;
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
    planningDirectory: (targetId, roundId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}/${PLANNING_DIRECTORY}/${checkedRole("round", roundId)}`,
    goalDirectory: (targetId, goalId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}/${GOAL_DIRECTORY}/${checkedRole("goal", goalId)}`,
    goalUploadsDirectory: (targetId, goalId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}/${GOAL_DIRECTORY}/${checkedRole("goal", goalId)}/${UPLOADS_DIRECTORY}`,
    importDirectory: (targetId, importId) =>
      `${root}/${TARGETS_DIRECTORY}/${checked(targetId)}/${IMPORT_DIRECTORY}/${checkedRole("import", importId)}`,
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
    "invalid_role_id",
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
  /**
   * The folder on the operator's machine this engagement is about.
   *
   * Not where the target's data lives — that is always `targets/<id>/`, built from the
   * id by {@link fleetPaths} and never from anything a caller supplies. This is the
   * folder chosen in the New target dialog, recorded so the rail can show it and so a
   * second registration against the same folder can be refused by name. Optional, and
   * absent for a target registered by a process that has no operator behind it.
   */
  readonly workspacePath?: string | undefined;
}

export interface TargetRow {
  readonly targetId: string;
  readonly name: string;
  readonly scopeNote: string;
  readonly workspacePath: string | undefined;
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
  workspace_path: Schema.NullOr(Schema.String),
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
  workspacePath: row.workspace_path ?? undefined,
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
      sql`SELECT id, name, scope_note, workspace_path, created_at, archived_at
          FROM targets ORDER BY created_at, id`,
  });

  const selectTarget = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: TargetRecord,
    execute: (targetId) =>
      sql`SELECT id, name, scope_note, workspace_path, created_at, archived_at
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
    yield* sql`INSERT INTO targets (id, name, scope_note, workspace_path, created_at)
      VALUES (${input.targetId}, ${input.name}, ${input.scopeNote},
              ${input.workspacePath ?? null}, ${now})`.pipe(
      Effect.mapError(query),
    );
    return {
      targetId: input.targetId,
      name: input.name,
      scopeNote: input.scopeNote,
      workspacePath: input.workspacePath,
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

  /**
   * Creates one role's directory on demand and returns it, ungated.
   *
   * Idempotent: `mkdir -p`, so creating a round's directory twice is not an error and
   * leaves whatever the first creation put there. The registry is consulted first so a
   * typo'd or archived-away id cannot grow a directory tree for a target that does not
   * exist, and the id is checked here so a bad one is a typed refusal where
   * {@link fleetPaths} would throw.
   *
   * **This makes the directory and does nothing else. It does not install the policy
   * gate, and so it does not return a path**: it returns an {@link UngatedRoleDirectory},
   * which nothing that creates a session accepts. The one conversion is
   * `gatedRoleDirectory` (`policy/install.ts`), which installs the gate and only then
   * yields a path. The gate is a harness concern and this module knows no harness.
   *
   * Outside every transaction, like {@link ensureDirectory} it calls.
   */
  const ensureRoleDirectory = Effect.fnUntraced(function* (
    kind: "round" | "goal" | "import",
    targetId: string,
    id: string,
  ) {
    if (!isTargetId(targetId)) {
      return yield* new FleetError({
        reason: "invalid_target_id",
        targetId,
        detail: "not a usable target id",
      });
    }
    if (!isRoleDirectoryId(id)) {
      return yield* new FleetError({
        reason: "invalid_role_id",
        targetId,
        detail: `'${id}' is not usable as a ${kind} directory name: use 1-64 characters of a-z, A-Z, 0-9, '-' or '_', starting with a letter or digit`,
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
    const path =
      kind === "round"
        ? paths.planningDirectory(targetId, id)
        : kind === "goal"
          ? paths.goalDirectory(targetId, id)
          : paths.importDirectory(targetId, id);
    yield* ensureDirectory(path, targetId);
    return new UngatedRoleDirectory(path);
  });

  const ensurePlanningDirectory = Effect.fn(
    "FleetStore.ensurePlanningDirectory",
  )(function* (targetId: string, roundId: string) {
    return yield* ensureRoleDirectory("round", targetId, roundId);
  });

  const ensureGoalDirectory = Effect.fn("FleetStore.ensureGoalDirectory")(
    function* (targetId: string, goalId: string) {
      return yield* ensureRoleDirectory("goal", targetId, goalId);
    },
  );

  const ensureImportDirectory = Effect.fn("FleetStore.ensureImportDirectory")(
    function* (targetId: string, importId: string) {
      return yield* ensureRoleDirectory("import", targetId, importId);
    },
  );

  /**
   * Creates `uploads/` inside a goal directory **that has already been gated**.
   *
   * **The argument is the gate, which is why it is a `GatedDirectory` and not two ids.**
   * This directory sits inside the one a goal agent's session runs in, so writing into it
   * before the pre-execution policy gate is installed would put the operator's files in a
   * directory where nothing is yet watching what an agent does. Taking the branded path
   * makes that ordering a compile-time fact: the only way to obtain one is
   * `gatedRoleDirectory` (`policy/install.ts`), which makes the directory and installs the
   * gate before it hands anything back.
   *
   * It also means the path written to is **derived from the path that was gated** rather
   * than rebuilt from ids beside it. {@link FleetPaths.goalUploadsDirectory} says the same
   * thing and is what a reader and a test use; building the write path from the gated
   * string is what stops the two from ever being different directories.
   *
   * The import of `GatedDirectory` is type-only in both directions — `policy/install.ts`
   * imports {@link UngatedRoleDirectory} the same way — so neither module depends on the
   * other at runtime and this one still knows no harness.
   *
   * Idempotent: `mkdir -p`. Outside every transaction, like {@link ensureDirectory}.
   */
  const ensureGoalUploads = Effect.fn("FleetStore.ensureGoalUploads")(
    function* (goalDirectory: GatedDirectory, targetId: string) {
      const path = `${goalDirectory}/${UPLOADS_DIRECTORY}`;
      yield* ensureDirectory(path, targetId);
      return path;
    },
  );

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
    ensurePlanningDirectory,
    ensureGoalDirectory,
    ensureImportDirectory,
    ensureGoalUploads,
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
    readonly ensurePlanningDirectory: (
      targetId: string,
      roundId: string,
    ) => Effect.Effect<UngatedRoleDirectory, FleetError | DatabaseError>;
    readonly ensureGoalDirectory: (
      targetId: string,
      goalId: string,
    ) => Effect.Effect<UngatedRoleDirectory, FleetError | DatabaseError>;
    /**
     * Makes the directory one scope import will run in, and nothing else.
     *
     * {@link ensureGoalDirectory}'s sibling, and it returns an
     * {@link UngatedRoleDirectory} for the same reason: nothing that creates a session
     * accepts one, so the only way to a usable path is `gatedRoleDirectory`, which
     * installs the policy gate first. The importer's page fetches go through that gate
     * (D13) — it is the only thing auditing them, because the fetch is the harness's tool
     * and not ours.
     */
    readonly ensureImportDirectory: (
      targetId: string,
      importId: string,
    ) => Effect.Effect<UngatedRoleDirectory, FleetError | DatabaseError>;
    readonly ensureGoalUploads: (
      goalDirectory: GatedDirectory,
      targetId: string,
    ) => Effect.Effect<string, DatabaseError>;
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
