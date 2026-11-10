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
 * - **An asset counts on the session that created it, as an entry does.** A second session
 *   recording the same hosts again added nothing, and its row says so (U8 review).
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
import { SqlClient } from "effect/sql";
import { SqliteMigrator } from "@effect/sql-sqlite-bun";

import { MIGRATIONS, runMigrations } from "./migrations";
import { sqliteLayer } from "./sql";
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
      agentId: "importer",
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

  test("two sessions recording the same assets: only the one that created them counts them (U8 review)", async () => {
    const path = newDatabasePath();
    const sessions = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_first");
        yield* Effect.sleep("5 millis");
        yield* open(store, "imp_second");
        const first = importerOf("imp_first");
        const second = importerOf("imp_second");
        for (const host of ["app", "api", "www"]) {
          yield* importHost(store, first, `https://${host}.acme.com/`);
        }
        // The second session reads the same page and records the same three again, plus
        // one of its own.
        for (const host of ["app", "api", "www", "status"]) {
          yield* importHost(store, second, `https://${host}.acme.com/`);
        }
        return yield* store.importSessions(TARGET);
      }),
    );

    expect(
      sessions.map((session) => [session.harnessSessionId, session.assets]),
    ).toEqual([
      ["ses_imp_second", 1],
      ["ses_imp_first", 3],
    ]);
    // Nothing in, nothing out, and the assets it re-recorded are not its own either: the
    // row of a session that added nothing reads as one.
    expect(sessions[0]).toMatchObject({ entriesIn: 0, entriesOut: 0 });
  });

  test("a no-op add leaves a record and does not count as an entry", async () => {
    // `addScopeEntry` writes a `scope.entry.added` with `created: false` for an entry that
    // already exists, so a chat can pair each call with its record by position. The tally
    // counts entries added, so that record must not count — and an event written before
    // the field existed (no `created` at all) still must.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_dup");
        const caller = importerOf("imp_dup");
        yield* addEntry(store, caller, "in", "acme.com");
        const again = yield* addEntry(store, caller, "in", "acme.com");
        yield* addEntry(store, caller, "out", "status.acme.com");
        yield* addEntry(store, caller, "out", "status.acme.com");
        const events = yield* store.eventsAfter(0, 100);
        const sessions = yield* store.importSessions(TARGET);
        return { again, events, sessions };
      }),
    );
    expect(outcome.again.created).toBe(false);
    const added = outcome.events.filter(
      (event) => event.kind === "scope.entry.added",
    );
    expect(
      added.map((event) => (event.payload as { created: boolean }).created),
    ).toEqual([true, false, true, false]);
    expect(outcome.sessions[0]).toMatchObject({ entriesIn: 1, entriesOut: 1 });
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

describe("an import session's end (0026, 0027)", () => {
  test("an open session reads not-ended, and the first end is recorded with its reason", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a");
        const before = {
          ended: yield* store.importSessionEnd("imp_a"),
          listed: yield* store.importSessions(TARGET),
        };
        yield* store.endImportSession("imp_a", "operator");
        const first = (yield* store.importSessions(TARGET))[0]?.endedAt;
        yield* Effect.sleep("5 millis");
        // A stop then the layer's finalizer: the second close must move neither the instant
        // nor the reason, or an operator's stop would read as a shutdown and stop gating.
        yield* store.endImportSession("imp_a", "shutdown");
        return {
          before,
          first,
          ended: yield* store.importSessionEnd("imp_a"),
          second: (yield* store.importSessions(TARGET))[0]?.endedAt,
        };
      }),
    );
    expect(outcome.before.ended).toBeUndefined();
    expect(outcome.before.listed[0]?.endedAt).toBeNull();
    expect(typeof outcome.first).toBe("number");
    expect(outcome.ended?.endedAt).toBe(outcome.first ?? -1);
    expect(outcome.ended?.reason).toBe("operator");
    expect(outcome.second).toBe(outcome.first);
  });

  test.each([
    "operator",
    "shutdown",
    "refused",
    "process_gone",
    "open_failed",
  ] as const)(
    "a %s end round-trips through the column's check",
    async (reason) => {
      const path = newDatabasePath();
      const outcome = await withStore(path, (store) =>
        Effect.gen(function* () {
          yield* open(store, "imp_a");
          yield* store.endImportSession("imp_a", reason);
          return yield* store.importSessionEnd("imp_a");
        }),
      );
      expect(outcome?.reason).toBe(reason);
    },
  );

  test("an import with no row is not ended, and ending it fails nothing", async () => {
    // The index is advisory: a failed `recordImportSession` must not turn into refused
    // writes for an import that is still running.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.endImportSession("imp_not_there", "operator");
        return yield* store.importSessionEnd("imp_not_there");
      }),
    );
    expect(outcome).toBeUndefined();
  });

  test("a session is ended only once every run of it has ended", async () => {
    // Several authority periods on one harness session, each its own import id: the index
    // reads them as one session, ended once the last period is.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_a", { session: "ses_shared" });
        yield* Effect.sleep("5 millis");
        yield* open(store, "imp_b", { session: "ses_shared" });
        yield* store.endImportSession("imp_a", "shutdown");
        const partly = (yield* store.importSessions(TARGET))[0]?.endedAt;
        yield* Effect.sleep("5 millis");
        yield* store.endImportSession("imp_b", "operator");
        const fully = (yield* store.importSessions(TARGET))[0]?.endedAt;
        return { partly, fully };
      }),
    );
    expect(outcome.partly).toBeNull();
    expect(typeof outcome.fully).toBe("number");
  });
});

describe("what an import's session was opened with, and may cite (0028, 0029)", () => {
  test("model options are stored canonically and read back; none reads null", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordImportSession({
          importId: "imp_effort",
          targetId: TARGET,
          harnessSessionId: "ses_effort",
          harnessInstanceId: "claude",
          model: "anthropic/claude-sonnet-5",
          agentId: "importer",
          // Out of order on purpose: the row holds `0015`'s sorted encoding.
          modelOptions: [
            { id: "thinking", value: "on" },
            { id: "effort", value: "high" },
          ],
          pages: [PAGE],
        });
        yield* store.recordImportSession({
          importId: "imp_default",
          targetId: TARGET,
          harnessSessionId: "ses_default",
          harnessInstanceId: "claude",
          model: "anthropic/claude-sonnet-5",
          agentId: "importer",
          modelOptions: [],
        });
        return {
          effort: yield* store.importSession("imp_effort"),
          plain: yield* store.importSession("imp_default"),
        };
      }),
    );
    expect(outcome.effort?.modelOptions).toEqual([
      { id: "effort", value: "high" },
      { id: "thinking", value: "on" },
    ]);
    expect(outcome.effort?.pages).toEqual([PAGE]);
    // An empty list would claim an opinion; nothing set is `null`, as on an attempt.
    expect(outcome.plain?.modelOptions).toBeNull();
    // A row written without pages says "not recorded", not "none".
    expect(outcome.plain?.pages).toBeNull();
  });

  test("a widened page list is rewritten whole; an unknown import changes nothing", async () => {
    const path = newDatabasePath();
    const later = "https://hackerone.test/acme/scope-update";
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.recordImportSession({
          importId: "imp_pages",
          targetId: TARGET,
          harnessSessionId: "ses_pages",
          harnessInstanceId: "opencode",
          model: "openai/gpt-5.6-sol",
          agentId: "importer",
          pages: [PAGE],
        });
        yield* store.recordImportPages("imp_pages", [PAGE, later]);
        yield* store.recordImportPages("imp_not_there", [later]);
        return {
          widened: yield* store.importSession("imp_pages"),
          missing: yield* store.importSession("imp_not_there"),
        };
      }),
    );
    expect(outcome.widened?.pages).toEqual([PAGE, later]);
    expect(outcome.missing).toBeUndefined();
  });

  test("a model switch rewrites the model and its options in place, and only on that row (A6 F4)", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const base = {
          targetId: TARGET,
          harnessInstanceId: "claude",
          model: "anthropic/claude-sonnet-5",
          agentId: "importer",
          modelOptions: [{ id: "effort", value: "low" }],
        };
        yield* store.recordImportSession({
          ...base,
          importId: "imp_switch",
          harnessSessionId: "ses_switch",
        });
        yield* store.recordImportSession({
          ...base,
          importId: "imp_beside",
          harnessSessionId: "ses_beside",
        });
        const switched = yield* store.recordImportSessionModel({
          importId: "imp_switch",
          model: "anthropic/claude-opus-5-5",
          // Out of order on purpose: the same canonical encoding as the insert.
          modelOptions: [
            { id: "thinking", value: "on" },
            { id: "effort", value: "high" },
          ],
        });
        const afterSwitch = yield* store.importSession("imp_switch");
        // Nothing chosen for the new model is `null`, never `[]`.
        const cleared = yield* store.recordImportSessionModel({
          importId: "imp_switch",
          model: "anthropic/claude-haiku-4-5",
          modelOptions: undefined,
        });
        const missing = yield* store.recordImportSessionModel({
          importId: "imp_not_there",
          model: "anthropic/claude-opus-5-5",
          modelOptions: undefined,
        });
        return {
          switched,
          afterSwitch,
          cleared,
          afterClear: yield* store.importSession("imp_switch"),
          beside: yield* store.importSession("imp_beside"),
          missing,
        };
      }),
    );
    expect(outcome.switched).toBe(true);
    expect(outcome.afterSwitch?.model).toBe("anthropic/claude-opus-5-5");
    expect(outcome.afterSwitch?.modelOptions).toEqual([
      { id: "effort", value: "high" },
      { id: "thinking", value: "on" },
    ]);
    expect(outcome.cleared).toBe(true);
    expect(outcome.afterClear?.model).toBe("anthropic/claude-haiku-4-5");
    expect(outcome.afterClear?.modelOptions).toBeNull();
    // The harness instance and the session are pinned; a switch never touches them.
    expect(outcome.afterClear?.harnessInstanceId).toBe("claude");
    expect(outcome.afterClear?.harnessSessionId).toBe("ses_switch");
    expect(outcome.beside?.model).toBe("anthropic/claude-sonnet-5");
    expect(outcome.beside?.modelOptions).toEqual([
      { id: "effort", value: "low" },
    ]);
    expect(outcome.missing).toBe(false);
  });

  test("the session list names the model of the run a reopen continues, not the run that opened it (A6 F4)", async () => {
    const path = newDatabasePath();
    const listed = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* open(store, "imp_opened", { session: "ses_chain" });
        yield* Effect.sleep("5 millis");
        // The reopen, opened on its predecessor's model, then switched.
        yield* open(store, "imp_reopened", { session: "ses_chain" });
        yield* store.recordImportSessionModel({
          importId: "imp_reopened",
          model: "anthropic/claude-haiku-4-5",
          modelOptions: undefined,
        });
        const afterSwitch = yield* store.importSessions(TARGET);
        yield* Effect.sleep("5 millis");
        // A later run the harness never confirmed is not the session's latest run, so its
        // model is not the session's either — the same rule as `latestImportId`.
        yield* store.recordImportSession({
          importId: "imp_unconfirmed",
          targetId: TARGET,
          harnessSessionId: "ses_chain",
          harnessInstanceId: "opencode",
          model: "anthropic/claude-opus-5-5",
          agentId: "importer",
        });
        return {
          afterSwitch,
          afterUnconfirmed: yield* store.importSessions(TARGET),
        };
      }),
    );
    expect(listed.afterSwitch).toHaveLength(1);
    expect(listed.afterSwitch[0]).toMatchObject({
      harnessSessionId: "ses_chain",
      latestImportId: "imp_reopened",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(listed.afterUnconfirmed[0]).toMatchObject({
      latestImportId: "imp_reopened",
      model: "anthropic/claude-haiku-4-5",
    });
  });

  test("the row says whether its session was ever created, which is what a replay needs (S6)", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        for (const importId of ["imp_opened", "imp_never"]) {
          yield* store.recordImportSession({
            importId,
            targetId: TARGET,
            harnessSessionId: `ses_${importId}`,
            harnessInstanceId: "opencode",
            model: "openai/gpt-5.6-sol",
            agentId: "importer",
          });
        }
        yield* store.confirmImportSession("imp_opened");
        return {
          opened: yield* store.importSession("imp_opened"),
          never: yield* store.importSession("imp_never"),
        };
      }),
    );
    expect(outcome.opened?.confirmedAt).toBeGreaterThan(0);
    /*
     * `null`, and it is the one fact that separates "nothing was ever said in this import"
     * from every other kind of silence. The row is written before the session exists
     * (`0025`), so an unconfirmed row names an id the harness may never have minted — and a
     * replay of it has to answer "nobody has talked to this yet" rather than the harness's
     * "I no longer hold that session", which would tell an operator their message was lost.
     */
    expect(outcome.never?.confirmedAt).toBeNull();
  });
});

describe("the agent a session runs as (0002)", () => {
  test("is stored as written and read back by both reads, from the run that opened it", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        // An id the registry does not define, so a default could not pass for a write.
        yield* store.recordImportSession({
          importId: "imp_pinned",
          targetId: TARGET,
          harnessSessionId: "ses_pinned",
          harnessInstanceId: "opencode",
          model: "openai/gpt-5.6-sol",
          agentId: "retired_agent",
        });
        yield* store.confirmImportSession("imp_pinned");
        return {
          row: yield* store.importSession("imp_pinned"),
          index: yield* store.importSessions(TARGET),
        };
      }),
    );
    expect(outcome.row?.agentId).toBe("retired_agent");
    expect(outcome.index.map((session) => session.agentId)).toEqual([
      "retired_agent",
    ]);
  });

  test("a row written before the column existed reads as the importer", async () => {
    const path = newDatabasePath();
    const baseline = MIGRATIONS["0001_baseline"];
    if (baseline === undefined) throw new Error("the baseline is missing");
    // The file as a build before `0002` left it: the baseline only, and a row on it.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations({
            loader: SqliteMigrator.fromRecord({ "0001_baseline": baseline }),
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO import_sessions (
              import_id, target_id, harness_session_id, harness_instance_id, model,
              caller_scope, opened_at, session_created_at
            ) VALUES (
              'imp_old', ${TARGET}, 'ses_old', 'opencode', 'openai/gpt-5.6-sol',
              ${callerScopeOf({ _tag: "importer", targetId: TARGET, importId: "imp_old" })},
              1, 2
            )`;
        }).pipe(Effect.provide(sqliteLayer(path))),
      ),
    );

    // Opening the store migrates the rest of the chain over it.
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        return {
          row: yield* store.importSession("imp_old"),
          index: yield* store.importSessions(TARGET),
        };
      }),
    );
    expect(outcome.row?.agentId).toBe("importer");
    expect(outcome.index.map((session) => session.agentId)).toEqual([
      "importer",
    ]);
  });
});
