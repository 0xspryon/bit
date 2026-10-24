/**
 * The SQLite connection, as an `effect/sql` client.
 *
 * `effect/sql`'s `SqlClient` is a service, not a library you call: it needs a driver to
 * exist at all. The driver here is `@effect/sql-sqlite-bun@4.0.5`, the official Effect
 * v4 Bun binding (`peerDependencies: { effect: "^4.0.5" }`, zero runtime dependencies,
 * MIT), which wraps `bun:sqlite` directly. It replaces Drizzle entirely: there is no ORM
 * in this codebase any more, and no second description of the schema in TypeScript
 * (DECISIONS.md §3 "`FIX` — effect/sql replaces Drizzle").
 *
 * **What the driver already does, and what it does not.** `SqliteClient.layer` opens the
 * file into the layer's scope and closes it when that scope ends, sets
 * `busy_timeout = 5000`, enables WAL, and serialises every statement behind a semaphore
 * of one (`@effect/sql-sqlite-bun/src/SqliteClient.ts:140-299`). It does **not** set
 * `foreign_keys` or `journal_size_limit`, so {@link pragmaLayer} does, and then reads
 * them back — a pragma that silently failed to apply is exactly the kind of thing that
 * only shows up as a missing constraint months later.
 *
 * Transactions are `sql.withTransaction(effect)`. Unlike the Drizzle arrangement this
 * replaces, the body is an ordinary Effect and may yield: the transaction is held on one
 * connection for the duration (`effect/src/sql/SqlClient.ts:394-491`), and SQLite's
 * `BEGIN IMMEDIATE` takes the write lock up front. What must still never appear inside a
 * transaction body is a harness call, an HTTP request or filesystem work — not because
 * the type system forbids it, but because holding SQLite's single write lock across a
 * network round trip is how you get a wedged database.
 */
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Context, Effect, Layer, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, type SqlError } from "effect/sql";

/**
 * A SQLite or driver-level failure, named by the operation that provoked it.
 *
 * `effect/sql` surfaces everything as one `SqlError` carrying a classified `reason`
 * (`UniqueViolation`, `ConstraintError`, `LockTimeoutError`, …). That is the right
 * taxonomy for a driver and the wrong one for a caller: a tool handler needs to know
 * "the store could not be written", and `operation` is the part it can report. The
 * driver's own reason is kept on `reason` rather than flattened to a string, so a log
 * line can still say which SQLite condition it was.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    operation: Schema.Literals(["open", "query", "transaction", "migrate"]),
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.operation} failed: ${this.reason}`;
  }
}

/** Wraps a driver failure as a {@link DatabaseError} for one named operation. */
export const asDatabaseError =
  (operation: typeof DatabaseError.Type.operation) =>
  (cause: SqlError.SqlError): DatabaseError =>
    new DatabaseError({ operation, reason: cause.reason._tag, cause });

/** The pragmas the driver does not set, and the ones it does, verified on the live connection. */
export interface PragmaState {
  readonly foreignKeys: number;
  readonly journalMode: string;
  readonly busyTimeout: number;
  readonly journalSizeLimit: number;
}

const readPragmas = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  const one = <K extends string>(name: K) =>
    Effect.map(
      sql.unsafe<Record<K, number | string>>(`PRAGMA ${name}`),
      (rows) => rows[0]?.[name],
    );
  return {
    foreignKeys: Number(yield* one("foreign_keys")),
    journalMode: String(yield* one("journal_mode")),
    // `PRAGMA busy_timeout` reports its value in a column called `timeout`, not
    // `busy_timeout`. Reading the obvious name back gives `undefined`.
    busyTimeout: Number(
      yield* Effect.map(
        sql.unsafe<{ timeout: number }>("PRAGMA busy_timeout"),
        (rows) => rows[0]?.timeout,
      ),
    ),
    journalSizeLimit: Number(yield* one("journal_size_limit")),
  } satisfies PragmaState;
});

/**
 * Reads the connection's pragma state. Exported so a test can assert it rather than
 * trust this file's comments.
 */
export const currentPragmas: Effect.Effect<
  PragmaState,
  DatabaseError,
  SqlClient.SqlClient
> = Effect.flatMap(SqlClient.SqlClient, readPragmas).pipe(
  Effect.mapError(asDatabaseError("query")),
);

/**
 * Applies the pragmas `COPY`'d from T3Code `apps/server/src/persistence/Sqlite.ts:19-24`
 * that the driver leaves alone, then fails if they did not take.
 *
 * `foreign_keys` matters most: with it off, every `REFERENCES` clause in the migrations
 * is decoration. It is a per-connection setting, so it is applied once per connection at
 * layer construction and covers every later statement on that connection. It is applied
 * *before* the migrator runs, so the migrations' own inserts are checked too.
 *
 * **A function, and it must stay one.** This used to be a module-level `Layer` constant,
 * which was correct while one process opened one file and became silently wrong the
 * moment several files were opened through a *shared* `Layer.MemoMap` — which is exactly
 * what `persistence/targetStores.ts` does, because that is how `LayerMap` builds its
 * entries. A `MemoMap` memoizes by layer **object identity**
 * (`effect/src/Layer.ts:414` and `MemoMapImpl.map`), so one constant appearing in two
 * composed graphs is built once: the first file got `foreign_keys = ON` and every
 * subsequent file got `0`, with no failure anywhere, because this layer's output is
 * `never` and there was nothing for the second build to produce. Measured, not reasoned
 * about — the probe read `PRAGMA foreign_keys` back as `1` then `0`, and
 * `targetStores.test.ts` now asserts it on two live target stores.
 *
 * The filename is a parameter only so the refusal can name the file it is about; the
 * reason it is a function is the identity above.
 */
export const pragmaLayer = (
  filename: string,
): Layer.Layer<never, DatabaseError, SqlClient.SqlClient> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA foreign_keys = ON");
      yield* sql.unsafe("PRAGMA journal_size_limit = 33554432");
      const state = yield* readPragmas(sql);
      if (state.foreignKeys !== 1) {
        return yield* new DatabaseError({
          operation: "open",
          reason: `foreign_keys did not take effect on ${filename}`,
          cause: state,
        });
      }
      return state;
    }).pipe(
      Effect.mapError((error) =>
        error instanceof DatabaseError ? error : asDatabaseError("open")(error),
      ),
    ),
  );

/**
 * The configured SQLite client for one database file, owned by the surrounding scope.
 *
 * Provides both `SqlClient` (what the store and the migrator depend on) and the driver's
 * own `SqliteClient`. The pragmas are part of the layer, so there is no way to obtain a
 * client that has not had them applied.
 *
 * Every layer in the returned graph is a fresh object, so two calls share nothing even
 * when they are built through one `MemoMap`. See {@link pragmaLayer} for what sharing one
 * did.
 */
export const sqliteLayer = (
  filename: string,
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  DatabaseError
> => pragmaLayer(filename).pipe(Layer.provideMerge(clientLayer(filename)));

/**
 * The driver's client as a layer whose failure is a {@link DatabaseError}.
 *
 * This is `SqliteClient.layer` with two changes: the driver's own layer leaves `SqlError`
 * in the error channel, and `Layer` has no `mapError`, so the layer is assembled from
 * `SqliteClient.make` here in order to map it. Everything else — the two service tags it
 * provides, the `Reactivity` dependency, the scope that owns the open file — is the
 * driver's (`@effect/sql-sqlite-bun/src/SqliteClient.ts:329-337`).
 *
 * The second change is that `Reactivity` is built per connection rather than taken from
 * the module-level `Reactivity.layer`. `Reactivity` is keyed invalidation — "process-local
 * invalidation for connecting writes to dependent reads" — and its keys are table names,
 * which are *identical* in every target's file. One shared instance would therefore let a
 * write to one target invalidate a reactive read on another, which is the one thing the
 * file-per-target layout exists to make impossible (`persistence/fleet.ts`). Nothing calls
 * `sql.reactive` today; this keeps that from becoming a cross-target leak the day
 * something does. It is also the same object-identity hazard as {@link pragmaLayer}: a
 * shared `MemoMap` builds a module-level constant once.
 */
const clientLayer = (
  filename: string,
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  DatabaseError
> =>
  Layer.effectContext(
    SqliteClient.make({ filename }).pipe(
      Effect.map((client) =>
        Context.make(SqliteClient.SqliteClient, client).pipe(
          Context.add(SqlClient.SqlClient, client),
        ),
      ),
      Effect.mapError(asDatabaseError("open")),
    ),
  ).pipe(Layer.provide(Layer.effect(Reactivity.Reactivity, Reactivity.make)));
