/**
 * Real-SQLite tests for the scope importer's own asset write (D14).
 *
 * The decision this file defends is that import provenance is a **different table** rather
 * than a weakened discovery one, and every claim that rests on it can only fail against a
 * real file: a misspelled column, a wrong placeholder count, a `NOT NULL` that was quietly
 * relaxed, a unique index that split one host into two rows. None of that is caught by the
 * compiler.
 *
 * What is asserted, and why each one earns its place:
 *
 * - An import writes an `assets` row and an `asset_imports` row with **no intent and no
 *   attempt anywhere in the call** — not in the provenance row, not in the event, and not
 *   in the file at all.
 * - A host the importer read and the same host a worker later discovered are **one** asset
 *   with a row in each provenance table, **in either order** and across a different
 *   spelling of the same host. That is §17's identity rule being genuinely shared rather
 *   than reimplemented.
 * - An exact `operationId` retry replays the original result and writes nothing.
 * - The import reports the D5 ladder's verdict for an in-scope host, an excluded one, and
 *   one covered by nothing.
 * - **`asset_discoveries` still refuses a null `intent_id` or `attempt_id`.** The whole of
 *   D14 is the trade that buys this, so the invariant is asserted here rather than assumed
 *   to have survived.
 *
 * Nothing here touches `apps/server/.runtime/`. Every test gets a fresh temporary file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";

import { migrate } from "./migrations";
import { sqliteLayer } from "./sql";
import {
  MutationError,
  ObservationStore,
  operatorScope,
  type AttemptCaller,
  type HostContext,
} from "./store";

type Store = ObservationStore["Service"];

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newDatabasePath = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-import-"));
  directories.push(directory);
  return join(directory, "hunt.sqlite");
};

const withStore = <A, E>(
  path: string,
  use: (store: Store) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(ObservationStore.layer(path)),
      ),
    ),
  );

/** The same file through the raw client, for the constraint assertions. */
const withSql = <A, E>(
  path: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(SqlClient.SqlClient, use).pipe(
        Effect.provide(sqliteLayer(path)),
      ),
    ),
  );

/**
 * A clock that does not move, for the one claim a real clock cannot pin down.
 *
 * An importer records every host off one page in one loop, so two of its writes sharing a
 * millisecond is the normal case rather than a race — and on a real clock whether they do
 * is luck. Freezing it makes "they shared a millisecond" the test's premise instead of its
 * weather.
 */
const FROZEN: Clock.Clock = {
  currentTimeMillisUnsafe: () => 1_700_000_000_000,
  currentTimeMillis: Effect.succeed(1_700_000_000_000),
  currentTimeNanosUnsafe: () => 1_700_000_000_000_000_000n,
  currentTimeNanos: Effect.succeed(1_700_000_000_000_000_000n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void,
};

const withFrozenStore = <A, E>(
  path: string,
  use: (store: Store) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provideService(
      Effect.scoped(
        Effect.flatMap(ObservationStore, use).pipe(
          Effect.provide(ObservationStore.layer(path)),
        ),
      ),
      Clock.Clock,
      FROZEN,
    ),
  );

const TARGET = "target-1";

/** The importer's authority: the operator's own, with no credential behind it. */
const OPERATOR: HostContext = {
  callerScope: operatorScope(TARGET),
  targetId: TARGET,
};

const WORKER: AttemptCaller = {
  _tag: "attempt",
  callerScope: `${TARGET}/attempt-1`,
  targetId: TARGET,
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_abc",
  workerId: "worker-1",
  attemptFence: 0,
};

/**
 * The goal, intent and attempt a *worker* needs, created only where a worker appears.
 *
 * Deliberately not a shared `beforeEach`: the first test's claim is that an import needs
 * none of these rows, and a fixture that created them anyway would make that claim
 * unfalsifiable.
 */
const seed = (store: Store) =>
  store.seedAttempt({
    targetId: TARGET,
    goalId: "goal-1",
    goal: "Map the client's externally reachable estate.",
    intentId: "intent-1",
    question: "What answers on the authorized ranges?",
    attemptId: "attempt-1",
    workerId: "worker-1",
    harnessInstanceId: "opencode",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    modelOptions: null,
    harnessSessionId: null,
  });

const PROGRAM_PAGE = "https://hackerone.test/acme/policy_scopes";

let operation = 0;

/** One import through the real write path. */
const importHost = (
  store: Store,
  url: string,
  overrides: { readonly operationId?: string; readonly note?: string } = {},
) =>
  store.importAsset(OPERATOR, {
    operationId: overrides.operationId ?? `imp-${String((operation += 1))}`,
    kind: "host",
    url,
    method: null,
    sourceUrl: PROGRAM_PAGE,
    note: overrides.note ?? "row 3 of the in-scope table",
  });

/** One worker discovery through the real write path. */
const discoverHost = (store: Store, url: string) =>
  store.recordAsset(WORKER, {
    operationId: `op-${String((operation += 1))}`,
    kind: "host",
    url,
    method: null,
    note: "answered on the authorized range",
  });

/* ── An import with nothing behind it ────────────────────────────────────────────── */

describe("an import", () => {
  test("records a host with no intent and no attempt anywhere in the call", async () => {
    const path = newDatabasePath();
    const written = await withStore(path, (store) =>
      Effect.gen(function* () {
        const result = yield* importHost(store, "https://app.acme.test/");
        return {
          result,
          counts: yield* store.counts(),
          events: yield* store.eventsAfter(0),
          pending: yield* store.pendingRequests(),
        };
      }),
    );

    expect(written.result.created).toBe(true);
    expect(written.result.replayed).toBe(false);
    expect(written.result.imports).toBe(1);
    expect(written.result.kind).toBe("host");
    expect(written.result.identity).toBe("app.acme.test:443");

    // The claim, stated as the file's own census: there is no goal, no intent and no
    // attempt in this database, and an asset was still recorded.
    expect(written.counts.assets).toBe(1);
    expect(written.counts.goals).toBe(0);
    expect(written.counts.intents).toBe(0);
    expect(written.counts.attempts).toBe(0);
    expect(written.counts.observations).toBe(0);

    const event = written.events.find((row) => row.kind === "asset.imported");
    expect(event?.subjectId).toBe(written.result.assetId);
    expect(event?.callerScope).toBe(operatorScope(TARGET));
    // Honest absence rather than a fabricated authority (§6).
    expect(event?.intentId).toBeNull();
    expect(event?.attemptId).toBeNull();
    expect(event?.operation).toBe("import_asset");

    // No enrichment queued: creating a target starts no work, and the operator's review
    // of the imported scope sits in that gap (D13).
    expect(written.pending).toEqual([]);

    // Reopened, because what a `SELECT` omits only shows up on the way back out.
    const reread = await withStore(path, (store) =>
      Effect.gen(function* () {
        const imports = yield* store.importsOfAsset(written.result.assetId);
        return {
          imports,
          discoveries: yield* store.discoveriesOfAsset(written.result.assetId),
        };
      }),
    );

    expect(reread.imports).toHaveLength(1);
    expect(reread.imports[0]?.source_url).toBe(PROGRAM_PAGE);
    expect(reread.imports[0]?.note).toBe("row 3 of the in-scope table");
    expect(reread.imports[0]?.imported_as).toBe("https://app.acme.test/");
    expect(reread.imports[0]?.caller_scope).toBe(operatorScope(TARGET));
    expect(reread.imports[0]?.imported_at).toBeGreaterThan(0);
    // The other provenance table was not written to, and did not have to be.
    expect(reread.discoveries).toEqual([]);
  });

  test("an exact operationId retry returns the original and writes no second row", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const first = yield* importHost(store, "https://app.acme.test/", {
          operationId: "imp-fixed",
        });
        const before = yield* store.counts();
        const again = yield* importHost(store, "https://app.acme.test/", {
          operationId: "imp-fixed",
        });
        return {
          first,
          again,
          before,
          after: yield* store.counts(),
          imports: yield* store.importsOfAsset(first.assetId),
        };
      }),
    );

    expect(outcome.again.assetId).toBe(outcome.first.assetId);
    expect(outcome.again.imports).toBe(1);
    // `created` is replayed as it was, not recomputed: the asset *was* created by this
    // command, and a retry must not report otherwise.
    expect(outcome.again.created).toBe(true);
    expect(outcome.again.replayed).toBe(true);
    expect(outcome.imports).toHaveLength(1);
    // Nothing was written at all — not a second asset, and not a second event.
    expect(outcome.after.assets).toBe(outcome.before.assets);
    expect(outcome.after.events).toBe(outcome.before.events);
  });

  test("the same operationId with different input is refused", async () => {
    const path = newDatabasePath();
    const failure = await withStore(path, (store) =>
      Effect.result(
        Effect.gen(function* () {
          yield* importHost(store, "https://app.acme.test/", {
            operationId: "imp-fixed",
          });
          yield* importHost(store, "https://other.acme.test/", {
            operationId: "imp-fixed",
          });
        }),
      ),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as MutationError;
      expect(error.reason).toBe("conflict");
      expect(error.detail).toContain("imp-fixed");
    }
  });

  test("a submission that is not an absolute URL is refused, by the shared rule", async () => {
    const path = newDatabasePath();
    const failure = await withStore(path, (store) =>
      Effect.result(importHost(store, "app.acme.test")),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as MutationError;
      expect(error.reason).toBe("invalid");
      // `assetIdentityOf`'s own sentence, passed through: one normalisation path, one
      // refusal, whichever caller provoked it.
      expect(error.detail).toContain("is not an absolute URL");
    }
  });
});

/* ── One asset, two provenance rows ──────────────────────────────────────────────── */

describe("an imported host and a discovered host", () => {
  /**
   * The identity claim, with the spellings deliberately different.
   *
   * `HTTPS://App.Acme.Test.:443/` and `https://app.acme.test/` are the same service
   * written two ways — mixed case, a trailing dot, an explicit default port — and they
   * must reduce to one row. If either write path normalised on its own this is the test
   * that fails, which is why it is not written as the same string twice.
   */
  test("are one asset with a row in each provenance table", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const imported = yield* importHost(
          store,
          "HTTPS://App.Acme.Test.:443/",
        );
        yield* seed(store);
        const discovered = yield* discoverHost(store, "https://app.acme.test/");
        return {
          imported,
          discovered,
          assets: yield* store.assets(),
          imports: yield* store.importsOfAsset(imported.assetId),
          discoveries: yield* store.discoveriesOfAsset(imported.assetId),
        };
      }),
    );

    expect(outcome.discovered.assetId).toBe(outcome.imported.assetId);
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.assets[0]?.identity).toBe("app.acme.test:443");
    // One row in each table, and each one answers the question its table is for.
    expect(outcome.imports).toHaveLength(1);
    expect(outcome.imports[0]?.source_url).toBe(PROGRAM_PAGE);
    expect(outcome.discoveries).toHaveLength(1);
    expect(outcome.discoveries[0]?.intent_id).toBe("intent-1");
    expect(outcome.discoveries[0]?.attempt_id).toBe("attempt-1");
    // The worker's count is a count of discoveries and is unaffected by the import.
    expect(outcome.discovered.discoveries).toBe(1);
    expect(outcome.discovered.created).toBe(false);
  });

  test("are one asset in the reverse order too", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        const discovered = yield* discoverHost(store, "https://app.acme.test/");
        const imported = yield* importHost(
          store,
          "HTTPS://App.Acme.Test.:443/",
        );
        return {
          discovered,
          imported,
          assets: yield* store.assets(),
          imports: yield* store.importsOfAsset(discovered.assetId),
          discoveries: yield* store.discoveriesOfAsset(discovered.assetId),
        };
      }),
    );

    expect(outcome.imported.assetId).toBe(outcome.discovered.assetId);
    expect(outcome.assets).toHaveLength(1);
    // The import merged onto the worker's row rather than minting a second one, and says
    // so: new provenance about a known thing.
    expect(outcome.imported.created).toBe(false);
    expect(outcome.imported.imports).toBe(1);
    expect(outcome.imports).toHaveLength(1);
    expect(outcome.discoveries).toHaveLength(1);
  });

  test("two imports of the same host are two import rows on one asset", async () => {
    // Two program pages naming the same host. The page is provenance, not identity.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const first = yield* importHost(store, "https://app.acme.test/");
        const second = yield* importHost(store, "https://app.acme.test:443/", {
          note: "the second program's table names it too",
        });
        return {
          first,
          second,
          assets: yield* store.assets(),
          imports: yield* store.importsOfAsset(first.assetId),
        };
      }),
    );

    expect(outcome.second.assetId).toBe(outcome.first.assetId);
    expect(outcome.second.created).toBe(false);
    expect(outcome.second.imports).toBe(2);
    expect(outcome.assets).toHaveLength(1);
    expect(outcome.imports).toHaveLength(2);
  });

  test("merges rather than reporting a second creation inside one millisecond", async () => {
    // `created` is read off the insert — `ON CONFLICT DO NOTHING RETURNING id` returns a
    // row only when this statement wrote one — and never off a timestamp comparison. On a
    // frozen clock the two writes are indistinguishable by time, so a timestamp-derived
    // `created` calls the second import a creation. The schema's own answer does not.
    const path = newDatabasePath();
    const outcome = await withFrozenStore(path, (store) =>
      Effect.gen(function* () {
        const first = yield* importHost(store, "https://app.acme.test/");
        const second = yield* importHost(store, "https://app.acme.test/");
        return { first, second, assets: yield* store.assets() };
      }),
    );

    expect(outcome.first.created).toBe(true);
    expect(outcome.second.assetId).toBe(outcome.first.assetId);
    expect(outcome.second.created).toBe(false);
    expect(outcome.second.imports).toBe(2);
    expect(outcome.assets).toHaveLength(1);
  });
});

/* ── The scope state the import reports ──────────────────────────────────────────── */

describe("the scope state an import reports", () => {
  test("is in when an entry the importer just wrote covers the host", async () => {
    const path = newDatabasePath();
    const result = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "imported",
        });
        return yield* importHost(store, "https://app.acme.test/");
      }),
    );

    expect(result.scopeState).toBe("in");
    expect(result.scopeDetail).toContain("acme.test");
  });

  test("is out when an entry excludes it, and says which one", async () => {
    const path = newDatabasePath();
    const result = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "imported",
        });
        yield* store.addScopeEntry(OPERATOR, {
          effect: "out",
          kind: "host",
          value: "payments.acme.test",
          source: "imported",
        });
        return yield* importHost(store, "https://payments.acme.test/");
      }),
    );

    // The asset is recorded either way: the state is told, not enforced.
    expect(result.created).toBe(true);
    expect(result.scopeState).toBe("out");
    expect(result.scopeDetail).toContain("payments.acme.test");
  });

  test("is out when a hand label excludes it, beating the entries", async () => {
    const path = newDatabasePath();
    const result = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "imported",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "legacy.acme.test",
          state: "out",
          reason: "decommissioned; the client asked us to leave it alone",
        });
        return yield* importHost(store, "https://legacy.acme.test/");
      }),
    );

    expect(result.scopeState).toBe("out");
    expect(result.scopeDetail).toContain("by hand");
  });

  test("is out, meaning covered by nothing, when no scope is authored", async () => {
    const path = newDatabasePath();
    const result = await withStore(path, (store) =>
      importHost(store, "https://app.acme.test/"),
    );

    expect(result.scopeState).toBe("out");
    // The early case, and the sentence has to say "nothing covers this" rather than
    // reading as a denial — the asset was recorded.
    expect(result.scopeDetail).toContain("not covered by any in-scope entry");
    expect(result.created).toBe(true);
  });

  test("matches what the estate read says about the same asset", async () => {
    // D5 and D3: one ladder. A second implementation would show up as these two
    // disagreeing about a host that is labelled on one axis and entried on another.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "out",
          kind: "subtree",
          value: "labs.acme.test",
          source: "imported",
        });
        const imported = yield* importHost(store, "https://x.labs.acme.test/");
        const rows = yield* store.assetsWithScope(TARGET);
        return { imported, rows };
      }),
    );

    const row = outcome.rows.find(
      (entry) => entry.asset.id === outcome.imported.assetId,
    );
    expect(row?.scope.state).toBe(outcome.imported.scopeState);
    expect(row?.scope.state).toBe("out");
    expect(row?.scope.by._tag).toBe("entry");
    // The imported asset is in the estate read at all, with no discovery row behind it.
    expect(row?.asset.discoveries).toBe(0);
    expect(row?.asset.first_attempt_id).toBeNull();
  });
});

/* ── The invariant D14 is paying for ─────────────────────────────────────────────── */

describe("asset_discoveries", () => {
  /**
   * The whole of D14 is the trade that keeps these two columns `NOT NULL`, so the
   * invariant is asserted rather than assumed to have survived the migration that was
   * appended beside it. A hand-rolled insert is the only way to ask the schema directly:
   * no store path can even attempt a null attempt.
   */
  test("still refuses a discovery with a null intent_id or attempt_id", async () => {
    const path = newDatabasePath();
    const assetId = await withStore(path, (store) =>
      Effect.gen(function* () {
        // The intent and attempt have to *exist*, or every insert below is refused by a
        // foreign key and the test passes without the `NOT NULL` being there at all. That
        // is not hypothetical: it is what this test did before the columns were relaxed
        // experimentally to check it, and it still passed. With the rows present, nullness
        // is the only thing left that can refuse one.
        yield* seed(store);
        const result = yield* importHost(store, "https://app.acme.test/");
        return result.assetId;
      }),
    );

    const outcome = await withSql(path, (sql) =>
      Effect.gen(function* () {
        const nullIntent = yield* Effect.result(
          sql`INSERT INTO asset_discoveries (
              asset_id, operation_id, caller_scope, intent_id, attempt_id,
              discovered_as, note, discovered_at
            ) VALUES (
              ${assetId}, 'op-null-intent', ${operatorScope(TARGET)}, ${null},
              'attempt-1', 'https://app.acme.test/', 'hand-rolled', 1
            )`,
        );
        const nullAttempt = yield* Effect.result(
          sql`INSERT INTO asset_discoveries (
              asset_id, operation_id, caller_scope, intent_id, attempt_id,
              discovered_as, note, discovered_at
            ) VALUES (
              ${assetId}, 'op-null-attempt', ${operatorScope(TARGET)},
              'intent-1', ${null}, 'https://app.acme.test/', 'hand-rolled', 1
            )`,
        );
        // The positive control: the same row with both columns filled in is accepted, so
        // the two refusals above are about the nulls and nothing else.
        const bothPresent = yield* Effect.result(
          sql`INSERT INTO asset_discoveries (
              asset_id, operation_id, caller_scope, intent_id, attempt_id,
              discovered_as, note, discovered_at
            ) VALUES (
              ${assetId}, 'op-both', ${operatorScope(TARGET)}, 'intent-1',
              'attempt-1', 'https://app.acme.test/', 'hand-rolled', 1
            )`,
        );
        return {
          nullIntent,
          nullAttempt,
          bothPresent,
          operations: yield* sql<{
            operation_id: string;
          }>`SELECT operation_id FROM asset_discoveries ORDER BY operation_id`,
        };
      }),
    );

    expect(outcome.nullIntent._tag).toBe("Failure");
    expect(outcome.nullAttempt._tag).toBe("Failure");
    expect(outcome.bothPresent._tag).toBe("Success");
    // Only the row that named both survived.
    expect(outcome.operations.map((row) => row.operation_id)).toEqual([
      "op-both",
    ]);
  });

  /** The import's own key, as the schema rather than as the receipt check. */
  test("the import table refuses a second row under the same operation id", async () => {
    const path = newDatabasePath();
    const assetId = await withStore(path, (store) =>
      Effect.map(
        importHost(store, "https://app.acme.test/", {
          operationId: "imp-fixed",
        }),
        (result) => result.assetId,
      ),
    );

    const duplicate = await withSql(path, (sql) =>
      Effect.result(
        sql`INSERT INTO asset_imports (
            asset_id, operation_id, caller_scope, source_url, imported_as, note,
            imported_at
          ) VALUES (
            ${assetId}, 'imp-fixed', ${operatorScope(TARGET)},
            ${PROGRAM_PAGE}, 'https://app.acme.test/', 'hand-rolled', 1
          )`,
      ),
    );

    expect(duplicate._tag).toBe("Failure");
  });

  /** The migration applies to a file the previous chain already brought up. */
  test("the chain is current after the import table is added", async () => {
    const path = newDatabasePath();
    const applied = await withSql(path, () => migrate);
    const again = await withSql(path, () => migrate);

    expect(applied.map(([, name]) => name)).toContain("asset_imports");
    expect(again).toEqual([]);
  });
});
