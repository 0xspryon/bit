/**
 * Real-SQLite tests for the importer's session index (`0024_import_sessions`).
 *
 * The decision this file defends is that a session's tally is **counted from the rows its
 * writes left and stored nowhere**. That can only fail against a real file: the count joins
 * `events` (whose `effect` is inside a JSON payload) and `asset_imports` to `import_sessions`
 * on a caller-scope string, and a misspelled column, a wrong `json_extract` path or a scope
 * built one way on write and another on read all compile and count zero.
 *
 * Every figure below is produced by the **real write path** — `addScopeEntry` and
 * `importAsset` under the scope `callerScopeOf` gives an importer — and none by inserting
 * rows, because the claim is that the tally agrees with what those functions leave behind.
 *
 * What is asserted, and why each one earns its place:
 *
 * - A session's tally counts its own entries by effect and its own assets, and **not** the
 *   operator's entries, another session's, or another target's.
 * - **A session continued under a second import id keeps one row and one tally.** This is the
 *   case the table's shape exists for, and the one a per-run count would get wrong: a host
 *   both runs recorded is one asset.
 * - **The tally is what the session wrote, not what is still there.** Removing an entry does
 *   not take it off a session that wrote it.
 * - Recording is idempotent on the import id.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import {
  callerScopeOf,
  ObservationStore,
  operatorScope,
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
  const directory = mkdtempSync(join(tmpdir(), "bit-import-sessions-"));
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

const TARGET = "target-1";
const PAGE = "https://hackerone.test/acme/policy_scopes";

/** An importer's authority, exactly as the importer's tools build it. */
const importerOf = (importId: string, targetId = TARGET): HostContext => ({
  callerScope: callerScopeOf({ _tag: "importer", targetId, importId }),
  targetId,
});

/**
 * Records a run and, unless told otherwise, confirms the harness created its session.
 *
 * Confirmed by default because that is the shape of every session worth listing; the
 * unconfirmed one is the exception a test asks for by name.
 */
const open = (
  store: Store,
  importId: string,
  over: {
    readonly session?: string;
    readonly targetId?: string;
    readonly confirmed?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    yield* store.recordImportSession({
      importId,
      targetId: over.targetId ?? TARGET,
      harnessSessionId: over.session ?? `ses_${importId}`,
      harnessInstanceId: "opencode",
      model: "openai/gpt-5.6-sol",
    });
    if (over.confirmed !== false) yield* store.confirmImportSession(importId);
  });

const addEntry = (
  store: Store,
  caller: HostContext,
  effect: "in" | "out",
  value: string,
) =>
  store.addScopeEntry(caller, {
    effect,
    kind: "subtree",
    value,
    source: caller.callerScope.includes("/import/") ? "imported" : "operator",
  });

let operation = 0;
const importHost = (store: Store, caller: HostContext, url: string) =>
  store.importAsset(caller, {
    operationId: `op-${String((operation += 1))}`,
    kind: "host",
    url,
    method: null,
    sourceUrl: PAGE,
    note: "row 1",
  });

describe("an import session's tally", () => {
  test("counts its own entries by effect and its own assets, and nobody else's", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a");
        yield* Effect.sleep("5 millis");
        yield* open(store, "imp_b");
        const a = importerOf("imp_a");
        const b = importerOf("imp_b");
        yield* addEntry(store, a, "in", "acme.com");
        yield* addEntry(store, a, "in", "acmelabs.io");
        yield* addEntry(store, a, "out", "status.acme.com");
        yield* importHost(store, a, "https://app.acme.com/");
        yield* importHost(store, a, "https://api.acme.com/");
        yield* addEntry(store, b, "in", "other.example");
        // The operator's own entry is on the same target and in neither tally.
        yield* addEntry(
          store,
          { callerScope: operatorScope(TARGET), targetId: TARGET },
          "out",
          "legacy.acme.com",
        );
        return yield* store.importSessions(TARGET);
      }),
    );

    // Newest first: `imp_b` opened second.
    expect(sessions.map((session) => session.harnessSessionId)).toEqual([
      "ses_imp_b",
      "ses_imp_a",
    ]);
    const [second, first] = sessions;
    expect(first).toMatchObject({
      entriesIn: 2,
      entriesOut: 1,
      assets: 2,
      model: "openai/gpt-5.6-sol",
      harnessInstanceId: "opencode",
      importIds: ["imp_a"],
    });
    expect(second).toMatchObject({ entriesIn: 1, entriesOut: 0, assets: 0 });
  });

  test("a session that wrote nothing is listed with zeros", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_quiet");
        return yield* store.importSessions(TARGET);
      }),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      entriesIn: 0,
      entriesOut: 0,
      assets: 0,
    });
  });

  test("a session continued under a second import id is one session with one tally", async () => {
    const path = newDatabasePath();
    let opened = -1;
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_first", { session: "ses_shared" });
        opened = (yield* store.importSessions(TARGET))[0]?.openedAt ?? -1;
        yield* Effect.sleep("5 millis");
        yield* open(store, "imp_again", { session: "ses_shared" });
        const first = importerOf("imp_first");
        const again = importerOf("imp_again");
        yield* addEntry(store, first, "in", "acme.com");
        yield* addEntry(store, again, "in", "acmelabs.io");
        yield* addEntry(store, again, "out", "status.acme.com");
        // The same host, recorded by both runs: one asset, not two.
        yield* importHost(store, first, "https://app.acme.com/");
        yield* importHost(store, again, "https://app.acme.com/");
        yield* importHost(store, again, "https://api.acme.com/");
        return yield* store.importSessions(TARGET);
      }),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      harnessSessionId: "ses_shared",
      entriesIn: 2,
      entriesOut: 1,
      assets: 2,
    });
    expect([...(sessions[0]?.importIds ?? [])].sort()).toEqual([
      "imp_again",
      "imp_first",
    ]);
    // The run that opened it supplies the time, so a continuation does not move it up.
    expect(sessions[0]?.openedAt).toBe(opened);
  });

  test("counts what the session wrote, not what is still in the scope", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a");
        const written = yield* addEntry(
          store,
          importerOf("imp_a"),
          "in",
          "acme.com",
        );
        yield* store.removeScopeEntry(
          { callerScope: operatorScope(TARGET), targetId: TARGET },
          written.entry.entryId,
        );
        const scope = yield* store.targetScope(TARGET);
        expect(scope.entries).toHaveLength(0);
        return yield* store.importSessions(TARGET);
      }),
    );
    expect(sessions[0]).toMatchObject({ entriesIn: 1 });
  });

  test("a run whose session the harness never confirmed is not listed, a quiet confirmed one is", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        // Opened first and confirmed, having written nothing: a real session that has not
        // yet written. Zero writes must not hide it.
        yield* open(store, "imp_quiet");
        yield* Effect.sleep("5 millis");
        // The newest row, and the one that never opened.
        yield* open(store, "imp_ghost", { confirmed: false });
        return yield* store.importSessions(TARGET);
      }),
    );
    expect(sessions.map((session) => session.harnessSessionId)).toEqual([
      "ses_imp_quiet",
    ]);
  });

  test("confirming twice, or an import that has no row, changes nothing and fails nothing", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a");
        yield* store.confirmImportSession("imp_a");
        yield* store.confirmImportSession("imp_not_there");
        return yield* store.importSessions(TARGET);
      }),
    );
    expect(sessions.map((session) => session.harnessSessionId)).toEqual([
      "ses_imp_a",
    ]);
  });

  test("lists only the target it was asked about", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_mine");
        yield* open(store, "imp_theirs", { targetId: "target-2" });
        return yield* store.importSessions(TARGET);
      }),
    );
    expect(sessions.map((session) => session.importIds)).toEqual([
      ["imp_mine"],
    ]);
  });

  test("recording the same import twice keeps the first row", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a", { session: "ses_one" });
        yield* open(store, "imp_a", { session: "ses_two" });
        return yield* store.importSessions(TARGET);
      }),
    );
    expect(sessions.map((session) => session.harnessSessionId)).toEqual([
      "ses_one",
    ]);
  });
});

describe("an import session's end (0026)", () => {
  test("an open session reads not-ended, and ending it is recorded once", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a");
        const before = {
          ended: yield* store.importSessionEnded("imp_a"),
          listed: yield* store.importSessions(TARGET),
        };
        yield* store.endImportSession("imp_a");
        const first = (yield* store.importSessions(TARGET))[0]?.endedAt;
        yield* Effect.sleep("5 millis");
        // A stop then the layer's finalizer: the second close must not move the instant.
        yield* store.endImportSession("imp_a");
        return {
          before,
          first,
          ended: yield* store.importSessionEnded("imp_a"),
          second: (yield* store.importSessions(TARGET))[0]?.endedAt,
        };
      }),
    );
    expect(outcome.before.ended).toBe(false);
    expect(outcome.before.listed[0]?.endedAt).toBeNull();
    expect(typeof outcome.first).toBe("number");
    expect(outcome.ended).toBe(true);
    expect(outcome.second).toBe(outcome.first);
  });

  test("an import with no row is not ended, and ending it fails nothing", async () => {
    // The index is advisory: a failed `recordImportSession` must not turn into refused
    // writes for an import that is still running.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.endImportSession("imp_not_there");
        return yield* store.importSessionEnded("imp_not_there");
      }),
    );
    expect(outcome).toBe(false);
  });

  test("a session is ended only once every run of it has ended", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a", { session: "ses_shared" });
        yield* Effect.sleep("5 millis");
        yield* open(store, "imp_b", { session: "ses_shared" });
        yield* store.endImportSession("imp_a");
        const partly = (yield* store.importSessions(TARGET))[0]?.endedAt;
        yield* Effect.sleep("5 millis");
        yield* store.endImportSession("imp_b");
        const fully = (yield* store.importSessions(TARGET))[0]?.endedAt;
        return { partly, fully };
      }),
    );
    expect(outcome.partly).toBeNull();
    expect(typeof outcome.fully).toBe("number");
  });
});
