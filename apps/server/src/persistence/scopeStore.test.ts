/**
 * Real-SQLite tests for the target scope: the entries, both label tables, and the one
 * effective read.
 *
 * `scope.test.ts` proves the derivation. This file proves the *storage* of it, and the
 * two are separable on purpose: the algorithm is a pure function with no database, and
 * what can only fail against a real file is the SQL — a misspelled column, a wrong
 * placeholder count, a `SELECT` that omits a field the result schema needs. None of those
 * is caught by the compiler.
 *
 * Four claims the design names, and each has a test here rather than an argument:
 *
 * - Entries and both label tables round-trip against a file, through a close and reopen.
 * - The effective-state read returns the **D5 ladder**: asset label over host label over
 *   entries.
 * - A **host label covers an endpoint recorded after the label was set.** That is the hole
 *   an asset-keyed label would leave, and it is the reason `host_scope_labels` exists.
 * - **D2's contradiction is refused at the write boundary**, because the unique index is
 *   per effect and cannot catch it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { AWKWARD_TEXT } from "./fixtures";
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
  const directory = mkdtempSync(join(tmpdir(), "bit-scope-"));
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

/** The operator's authority: the host's own, with no credential behind it. */
const OPERATOR: HostContext = {
  callerScope: operatorScope(TARGET),
  targetId: TARGET,
};

/**
 * A second operator authority on the same target.
 *
 * Attribution on a label is the caller's scope rather than a payload field, so proving
 * that a replacement re-attributes needs two of them. One person handing a target to
 * another mid-engagement is the real case.
 */
/** A second target's rows, in this one file, for the cross-target guard. */
const OTHER = "target-2";

const OTHER_WORKER: AttemptCaller = {
  _tag: "attempt",
  callerScope: `${OTHER}/attempt-other`,
  targetId: OTHER,
  intentId: "intent-other",
  attemptId: "attempt-other",
  harnessSessionId: "ses_other",
  workerId: "worker-other",
  attemptFence: 0,
};

const RELIEF_OPERATOR: HostContext = {
  callerScope: `${TARGET}/operator-relief`,
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

const seed = (store: Store) =>
  store.seedAttempt({
    targetId: TARGET,
    goalId: "goal-1",
    goal: `Map the client's externally reachable estate. ${AWKWARD_TEXT}`,
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

let operation = 0;

/** Records one asset through the real write path, so its provenance is real. */
const record = (
  store: Store,
  input: {
    readonly kind: "host" | "endpoint";
    readonly url: string;
    readonly method?: string | null;
  },
) =>
  store.recordAsset(WORKER, {
    operationId: `op-${String((operation += 1))}`,
    kind: input.kind,
    url: input.url,
    method: input.method ?? null,
    note: "recorded by the scope store test",
  });

/* ── Round-tripping the entries ──────────────────────────────────────────────────── */

describe("scope entries", () => {
  test("they round-trip against a file, through a close and reopen", async () => {
    const path = newDatabasePath();

    const written = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "cidr",
          value: "203.0.113.0/24",
          source: "operator",
        });
        return yield* store.addScopeEntry(OPERATOR, {
          effect: "out",
          kind: "host",
          value: "blog.acme.test",
          source: "imported",
          note: "listed under Out of scope on the programme page",
        });
      }),
    );
    expect(written.created).toBe(true);
    expect(written.entry.source).toBe("imported");

    // Reopened, which is what makes this a durability claim rather than a cache one.
    const scope = await withStore(path, (store) => store.targetScope(TARGET));
    expect(
      scope.entries.map((e) => `${e.effect}/${e.kind}/${e.value}`).sort(),
    ).toEqual([
      "in/cidr/203.0.113.0/24",
      "in/subtree/acme.test",
      "out/host/blog.acme.test",
    ]);
    // `source` survives, which is what makes the operator's review of an imported list a
    // real step rather than a wish: the rows that need reading are the ones a machine
    // wrote, and they have to be distinguishable on screen.
    const imported = scope.entries.find((e) => e.value === "blog.acme.test");
    expect(imported?.source).toBe("imported");
    expect(imported?.note).toContain("programme page");
    const typed = scope.entries.find((e) => e.value === "acme.test");
    expect(typed?.source).toBe("operator");
    expect(typed?.note).toBeNull();
  });

  test("the value is stored normalised, so the stored form is the matched form", async () => {
    const path = newDatabasePath();
    const written = await withStore(path, (store) =>
      store.addScopeEntry(OPERATOR, {
        effect: "in",
        kind: "host",
        value: "  HTTPS://App.Acme.Test:8443/login  ",
        source: "operator",
      }),
    );
    // Normalised on write, so no read has to normalise anything.
    expect(written.entry.value).toBe("app.acme.test");
  });

  test("adding the same entry twice writes one row and is not an error", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const first = yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        // The same value written differently, which normalises onto the first.
        const second = yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "ACME.Test.",
          source: "operator",
        });
        const scope = yield* store.targetScope(TARGET);
        return { first, second, count: scope.entries.length };
      }),
    );
    expect(outcome.first.created).toBe(true);
    // Idempotent rather than refused: pressing Add twice is not an error, and a duplicate
    // row would be a second entry the matcher evaluates.
    expect(outcome.second.created).toBe(false);
    expect(outcome.second.entry.entryId).toBe(outcome.first.entry.entryId);
    expect(outcome.count).toBe(1);
  });

  test("a no-op add writes one record saying so, naming the entry already there", async () => {
    // Every add produces exactly one record, so a chat can fold the Nth call into the Nth
    // record (the importer conversation design, S5.1). The no-op's record describes the
    // existing entry — its note and source are the first writer's, not this caller's.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const first = yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
          note: "typed by hand",
        });
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "ACME.test",
          source: "imported",
          note: "a second page",
        });
        const events = yield* store.eventsAfter(0, 100);
        const scope = yield* store.targetScope(TARGET);
        return { first, events, scope };
      }),
    );
    const added = outcome.events.filter(
      (event) => event.kind === "scope.entry.added",
    );
    expect(added).toHaveLength(2);
    expect(added[0]?.payload).toMatchObject({ created: true });
    expect(added[1]?.subjectId).toBe(outcome.first.entry.entryId);
    expect(added[1]?.payload).toEqual({
      entryId: outcome.first.entry.entryId,
      effect: "in",
      kind: "subtree",
      value: "acme.test",
      source: "operator",
      note: "typed by hand",
      created: false,
    });
    // Nothing else changed: one entry, still the first writer's.
    expect(outcome.scope.entries).toHaveLength(1);
    expect(outcome.scope.entries[0]?.note).toBe("typed by hand");
  });

  test("an unnormalisable value is refused and nothing is written", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const refusal = yield* Effect.flip(
          store.addScopeEntry(OPERATOR, {
            effect: "in",
            kind: "subtree",
            value: "localhost",
            source: "operator",
          }),
        );
        const scope = yield* store.targetScope(TARGET);
        return { refusal, count: scope.entries.length };
      }),
    );
    expect(outcome.refusal).toBeInstanceOf(MutationError);
    expect((outcome.refusal as MutationError).reason).toBe("invalid");
    // The normaliser's own sentence, passed through unedited because it names the remedy.
    expect((outcome.refusal as MutationError).detail).toContain(
      "single label with no dot",
    );
    expect(outcome.count).toBe(0);
  });

  /*
   * D2's contradiction refusal.
   *
   * The unique index is `(target_id, effect, kind, value)` — per effect — so the database
   * would happily hold both of these rows. The matcher would cope, because out wins. What
   * cannot cope is the screen, and an operator who authored both did not mean to.
   */
  test("an entry contradicting an existing one is refused, naming it", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const existing = yield* store.addScopeEntry(OPERATOR, {
          effect: "out",
          kind: "host",
          value: "blog.acme.test",
          source: "operator",
        });
        const refusal = yield* Effect.flip(
          store.addScopeEntry(OPERATOR, {
            effect: "in",
            kind: "host",
            value: "blog.acme.test",
            source: "operator",
          }),
        );
        const scope = yield* store.targetScope(TARGET);
        return { existing, refusal, entries: scope.entries };
      }),
    );

    expect(outcome.refusal).toBeInstanceOf(MutationError);
    const refusal = outcome.refusal as MutationError;
    expect(refusal.reason).toBe("conflict");
    // It names the existing row, so the operator can go and deal with that one.
    expect(refusal.detail).toContain(outcome.existing.entry.entryId);
    expect(refusal.detail).toContain("cannot be in and out at once");
    // And it offers the thing they probably meant: a hand label carves one host out
    // without editing the typed list.
    expect(refusal.detail).toContain("label the host by hand");
    // Nothing was written: the out entry is still the only row.
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]?.effect).toBe("out");
  });

  test("the contradiction is refused in the other direction too, and says so", async () => {
    /*
     * The same rule with the effects swapped, and it is not a redundant test.
     *
     * Every other contradiction case in this repo adds `out` first, so the lookup could
     * have been hardcoded to `effect: "out"` and stayed green while `out` on top of an
     * existing `in` was accepted — which is the pair the screen cannot show. It also
     * renders the other half of the refusal's own sentence: the `an in-scope` branch,
     * which nothing exercised.
     */
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const existing = yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "host",
          value: "portal.acme.test",
          source: "operator",
        });
        const refusal = yield* Effect.flip(
          store.addScopeEntry(OPERATOR, {
            effect: "out",
            kind: "host",
            value: "portal.acme.test",
            source: "operator",
          }),
        );
        const scope = yield* store.targetScope(TARGET);
        return { existing, refusal, entries: scope.entries };
      }),
    );
    const refusal = outcome.refusal as MutationError;
    expect(refusal.reason).toBe("conflict");
    expect(refusal.detail).toContain(outcome.existing.entry.entryId);
    expect(refusal.detail).toContain("is already an in-scope host entry");
    // Nothing was written: the in entry is still the only row, and it is still `in`.
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]?.effect).toBe("in");
  });

  test("the contradiction check is per kind, not per value", async () => {
    // `in`/`subtree`/`acme.test` and `out`/`host`/`acme.test` are not a contradiction:
    // "the apex and everything under it, in" beside "that one host, out" is a coherent
    // pair an operator can mean, and the matcher resolves it with out-wins.
    const path = newDatabasePath();
    const count = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* store.addScopeEntry(OPERATOR, {
          effect: "out",
          kind: "host",
          value: "acme.test",
          source: "operator",
        });
        const scope = yield* store.targetScope(TARGET);
        return scope.entries.length;
      }),
    );
    expect(count).toBe(2);
  });

  test("removing an entry removes it, and removing a ghost is refused", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const added = yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        const removed = yield* store.removeScopeEntry(
          OPERATOR,
          added.entry.entryId,
        );
        const after = yield* store.targetScope(TARGET);
        // A button that appears to work and does nothing is a named anti-goal.
        const ghost = yield* Effect.flip(
          store.removeScopeEntry(OPERATOR, "scope_nonexistent"),
        );
        return { removed, count: after.entries.length, ghost };
      }),
    );
    expect(outcome.removed.value).toBe("acme.test");
    expect(outcome.count).toBe(0);
    expect((outcome.ghost as MutationError).reason).toBe("invalid");
    expect((outcome.ghost as MutationError).detail).toContain(
      "nothing was removed",
    );
  });

  test("every entry write and removal lands in the event log", async () => {
    const path = newDatabasePath();
    const kinds = await withStore(path, (store) =>
      Effect.gen(function* () {
        const added = yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* store.removeScopeEntry(OPERATOR, added.entry.entryId);
        const events = yield* store.eventsAfter(0, 100);
        return events
          .filter((event) => event.kind.startsWith("scope."))
          .map((event) => ({
            kind: event.kind,
            scope: event.callerScope,
            subject: event.subjectId,
          }));
      }),
    );
    // The history lives in the append-only log, which is what lets the entries table hold
    // only the current statement of the estate.
    expect(kinds.map((e) => e.kind)).toEqual([
      "scope.entry.added",
      "scope.entry.removed",
    ]);
    // Attributed to the operator, which is the only authority that can write one.
    for (const event of kinds) {
      expect(event.scope).toBe(operatorScope(TARGET));
    }
  });
});

/* ── The labels, and the ladder over a real file ─────────────────────────────────── */

describe("the effective-state read", () => {
  test("it returns the entry verdict when no label is set", async () => {
    const path = newDatabasePath();
    const rows = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* record(store, { kind: "host", url: "https://app.acme.test/" });
        yield* record(store, {
          kind: "host",
          url: "https://api.acme-cdn.test/",
        });
        return yield* store.assetsWithScope(TARGET);
      }),
    );

    const byHost = new Map(rows.map((row) => [row.asset.host, row.scope]));
    expect(byHost.get("app.acme.test")?.state).toBe("in");
    expect(byHost.get("app.acme.test")?.by._tag).toBe("entry");
    // Covered by nothing, and kept. Never hidden, never dropped, never refused.
    expect(byHost.get("api.acme-cdn.test")?.state).toBe("out");
    expect(byHost.get("api.acme-cdn.test")?.by._tag).toBe("default");
  });

  test("a host label beats the entries, and says which entry it beat", async () => {
    const path = newDatabasePath();
    const rows = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* record(store, {
          kind: "host",
          url: "https://legacy.acme.test/",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "legacy.acme.test",
          state: "out",
          reason: "decommissioned; the client asked us to leave it alone",
        });
        return yield* store.assetsWithScope(TARGET);
      }),
    );

    const row = rows.find((entry) => entry.asset.host === "legacy.acme.test");
    expect(row?.scope.state).toBe("out");
    expect(row?.scope.by._tag).toBe("hostLabel");
    // `overrode` is what lets the view say which entry was beaten, so an operator can see
    // that a carve-out was made rather than that their typed list changed.
    expect(row?.scope.overrode?.value).toBe("acme.test");
    if (row?.scope.by._tag === "hostLabel") {
      expect(row.scope.by.label.reason).toContain("decommissioned");
      // The operator authority from the mutation boundary, not a name from a payload.
      expect(row.scope.by.label.setBy).toBe(operatorScope(TARGET));
    }
  });

  test("a host label promotes out from under an exclusion the operator typed", async () => {
    // D8's case, which the design settles against refusing the promotion: a visible,
    // attributed, single-host carve-out is a better record of the decision than an edit
    // to the list that loses the fact a carve-out was made.
    const path = newDatabasePath();
    const row = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "out",
          kind: "subtree",
          value: "labs.acme.test",
          source: "operator",
        });
        yield* record(store, {
          kind: "host",
          url: "https://x.labs.acme.test/",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "x.labs.acme.test",
          state: "in",
          reason: null,
        });
        const rows = yield* store.assetsWithScope(TARGET);
        return rows.find((entry) => entry.asset.host === "x.labs.acme.test");
      }),
    );
    expect(row?.scope.state).toBe("in");
    expect(row?.scope.by._tag).toBe("hostLabel");
    expect(row?.scope.overrode?.value).toBe("labs.acme.test");
    expect(row?.scope.overrode?.effect).toBe("out");
  });

  /*
   * The hole an asset-keyed label would leave, and the reason `host_scope_labels` exists.
   *
   * With labels keyed only by asset, excluding `legacy.acme.test` today would mark that
   * one row, and `legacy.acme.test/login` discovered tomorrow would be a different row
   * with no label, would derive from the entries, and would come back **in scope**. The
   * operator's exclusion would silently fail to cover the thing they meant by it.
   *
   * So the label is set *first* and the endpoint recorded *after*, which is the order that
   * makes the claim real rather than incidental.
   */
  test("a host label covers an endpoint recorded after the label was set", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* record(store, {
          kind: "host",
          url: "https://legacy.acme.test/",
        });

        // The exclusion, set before the endpoint under it exists at all.
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "legacy.acme.test",
          state: "out",
          reason: null,
        });

        // Discovered afterwards. A different row, with no label of its own.
        const later = yield* record(store, {
          kind: "endpoint",
          url: "https://legacy.acme.test/login",
          method: "POST",
        });

        const rows = yield* store.assetsWithScope(TARGET);
        return {
          later,
          endpoint: rows.find((entry) => entry.asset.id === later.assetId),
        };
      }),
    );

    expect(outcome.endpoint?.asset.kind).toBe("endpoint");
    expect(outcome.endpoint?.asset.path).toBe("/login");
    // The point: it inherits the host's label even though it has none of its own, and
    // even though the entries would have put it in.
    expect(outcome.endpoint?.scope.state).toBe("out");
    expect(outcome.endpoint?.scope.by._tag).toBe("hostLabel");

    // And `record_asset` told the worker so on the write itself, rather than never.
    expect(outcome.later.scopeState).toBe("out");
    expect(outcome.later.scopeDetail).toContain("excluded by hand");
  });

  test("an asset label beats its host's label, in both directions", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        const host = yield* record(store, {
          kind: "host",
          url: "https://app.acme.test/",
        });
        const endpoint = yield* record(store, {
          kind: "endpoint",
          url: "https://app.acme.test/internal/metrics",
          method: "GET",
        });

        // The host is excluded wholesale...
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "app.acme.test",
          state: "out",
          reason: null,
        });
        // ...and one row is kept anyway, which is the narrower, later decision.
        yield* store.setAssetScopeLabel(OPERATOR, {
          assetId: endpoint.assetId,
          state: "in",
          reason: "the client asked us to keep testing this one",
        });

        const rows = yield* store.assetsWithScope(TARGET);
        return {
          host: rows.find((row) => row.asset.id === host.assetId),
          endpoint: rows.find((row) => row.asset.id === endpoint.assetId),
        };
      }),
    );

    // The host row follows its own label.
    expect(outcome.host?.scope.state).toBe("out");
    expect(outcome.host?.scope.by._tag).toBe("hostLabel");
    // The endpoint follows its asset label, which outranks it.
    expect(outcome.endpoint?.scope.state).toBe("in");
    expect(outcome.endpoint?.scope.by._tag).toBe("assetLabel");
  });

  test("the other direction: one endpoint excluded while its host stays in", async () => {
    const path = newDatabasePath();
    const row = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        const endpoint = yield* record(store, {
          kind: "endpoint",
          url: "https://app.acme.test/internal/metrics",
          method: "GET",
        });
        yield* store.setAssetScopeLabel(OPERATOR, {
          assetId: endpoint.assetId,
          state: "out",
          reason: null,
        });
        const rows = yield* store.assetsWithScope(TARGET);
        return rows.find((entry) => entry.asset.id === endpoint.assetId);
      }),
    );
    expect(row?.scope.state).toBe("out");
    expect(row?.scope.by._tag).toBe("assetLabel");
    // It overrode the in-scope entry, and the view can say which.
    expect(row?.scope.overrode?.value).toBe("acme.test");
  });

  test("labels survive a close and reopen, and an entry change cannot erase one", async () => {
    const path = newDatabasePath();

    const assetId = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        const recorded = yield* record(store, {
          kind: "host",
          url: "https://legacy.acme.test/",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "legacy.acme.test",
          state: "out",
          reason: null,
        });
        yield* store.setAssetScopeLabel(OPERATOR, {
          assetId: recorded.assetId,
          state: "out",
          reason: null,
        });
        return recorded.assetId;
      }),
    );

    const reopened = await withStore(path, (store) =>
      Effect.gen(function* () {
        const scope = yield* store.targetScope(TARGET);
        /*
         * The anti-goal about an operator's hand label erased by a recompute.
         *
         * Adding entries after the fact cannot touch either label table — a recompute
         * reads entries, and entries have no write path into a label — so the operator's
         * decision stands. ScopeWeaver guards the same property with
         * `company_source ∈ explicit | scope`; this has one more level and the same
         * structure.
         */
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "host",
          value: "legacy.acme.test",
          source: "operator",
        });
        const rows = yield* store.assetsWithScope(TARGET);
        return {
          hostLabels: scope.hostLabels,
          assetLabels: scope.assetLabels,
          row: rows.find((entry) => entry.asset.id === assetId),
        };
      }),
    );

    expect(reopened.hostLabels).toHaveLength(1);
    expect(reopened.hostLabels[0]?.host).toBe("legacy.acme.test");
    expect(reopened.assetLabels).toHaveLength(1);
    // The new in-scope entry on the very same host changed nothing.
    expect(reopened.row?.scope.state).toBe("out");
    expect(reopened.row?.scope.by._tag).toBe("assetLabel");
  });

  test("a label is replaced rather than duplicated, and set_at moves", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        const first = yield* store.setHostScopeLabel(OPERATOR, {
          host: "legacy.acme.test",
          state: "out",
          reason: "first thought",
        });
        // A real gap, because `set_at` comes off the clock and two writes in one
        // millisecond would make the comparison below vacuous. And a different authority,
        // because attribution is the other half of what the upsert replaces.
        yield* Effect.sleep("5 millis");
        const second = yield* store.setHostScopeLabel(RELIEF_OPERATOR, {
          host: "legacy.acme.test",
          state: "in",
          reason: "the client changed their mind",
        });
        const scope = yield* store.targetScope(TARGET);
        return { first, second, labels: scope.hostLabels };
      }),
    );
    const labels = outcome.labels;
    // One current answer per host, which is what the primary key is for.
    expect(labels).toHaveLength(1);
    expect(labels[0]?.state).toBe("in");
    expect(labels[0]?.reason).toContain("changed their mind");
    /*
     * `set_at` and `set_by` move too, which is what the test's name claims and what the
     * upsert's `excluded.set_at` and `excluded.set_by` are for.
     *
     * Without these two lines the clauses can be dropped from the `ON CONFLICT` and every
     * relabel stays attributed and timestamped to the *first* decision — so the Scope tab
     * would show the operator the moment they changed their mind as the moment they first
     * decided, and the event log would be the only place the truth survived.
     */
    expect(labels[0]?.setAt).toBe(outcome.second.setAt);
    expect(outcome.second.setAt).toBeGreaterThan(outcome.first.setAt);
    expect(labels[0]?.setBy).toBe(RELIEF_OPERATOR.callerScope);
    expect(labels[0]?.setBy).not.toBe(OPERATOR.callerScope);
  });

  test("clearing a label hands the subject back to the entries", async () => {
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        const recorded = yield* record(store, {
          kind: "host",
          url: "https://app.acme.test/",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "app.acme.test",
          state: "out",
          reason: null,
        });
        const excluded = yield* store.assetsWithScope(TARGET);
        yield* store.clearHostScopeLabel(OPERATOR, "app.acme.test");
        const restored = yield* store.assetsWithScope(TARGET);
        const ghost = yield* Effect.flip(
          store.clearHostScopeLabel(OPERATOR, "never.labelled.test"),
        );
        return {
          assetId: recorded.assetId,
          excluded: excluded[0]?.scope,
          restored: restored[0]?.scope,
          ghost,
        };
      }),
    );

    expect(outcome.excluded?.state).toBe("out");
    // Cleared, so the entries decide it again — which is what makes a clear a delete
    // rather than a third value for a two-valued column.
    expect(outcome.restored?.state).toBe("in");
    expect(outcome.restored?.by._tag).toBe("entry");
    expect((outcome.ghost as MutationError).detail).toContain(
      "nothing was cleared",
    );
  });

  test("an asset label for another target's asset is refused", async () => {
    /*
     * The guard is `asset.target_id !== caller.targetId`, and reaching it needs a real
     * asset that belongs to somebody else.
     *
     * This test used to pass `asset_nonexistent`, which is refused one line earlier by
     * the row simply not being there — so the branch that matters was never run, and
     * deleting the target check left the suite green. A second target's attempt is seeded
     * into this file and records its own asset, which is the shape a misfiled row or a
     * caller carrying the wrong target id would produce.
     */
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.seedAttempt({
          targetId: OTHER,
          goalId: "goal-other",
          goal: "Another engagement entirely.",
          intentId: "intent-other",
          question: "What answers over there?",
          attemptId: "attempt-other",
          workerId: "worker-other",
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          modelOptions: null,
          harnessSessionId: null,
        });
        const theirs = yield* store.recordAsset(OTHER_WORKER, {
          operationId: "op-other-1",
          kind: "host",
          url: "https://app.other.test/",
          method: null,
          note: "recorded under the other engagement",
        });

        const set = yield* Effect.flip(
          store.setAssetScopeLabel(OPERATOR, {
            assetId: theirs.assetId,
            state: "in",
            reason: null,
          }),
        );
        const cleared = yield* Effect.flip(
          store.clearAssetScopeLabel(OPERATOR, theirs.assetId),
        );
        // And the row really does exist, so neither refusal is the absent-row branch.
        const assets = yield* store.assets();
        const scope = yield* store.targetScope(TARGET);
        return {
          set,
          cleared,
          theirs: assets.find((asset) => asset.id === theirs.assetId),
          assetLabels: scope.assetLabels,
        };
      }),
    );

    expect(outcome.theirs?.target_id).toBe(OTHER);
    // The foreign key catches an id that is nothing at all; it cannot catch another
    // engagement's asset id, and labelling one of those would record a decision against
    // the wrong client.
    for (const refusal of [outcome.set, outcome.cleared]) {
      expect((refusal as MutationError).reason).toBe("invalid");
      expect((refusal as MutationError).detail).toContain("is not an asset of");
      expect((refusal as MutationError).absent).toBe(true);
    }
    // Nothing was written against either target.
    expect(outcome.assetLabels).toHaveLength(0);
  });

  test("a host label is keyed by the normalised host, so it is a label that applies", async () => {
    /*
     * The normaliser on the *write* path, which nothing exercised: every other test in
     * this file hands these two functions an already-normalised host, so removing
     * `normaliseHost` from both of them keeps every gate green and produces exactly the
     * failure the store's own comment names — "a label keyed by `App.Acme.Com:443` would
     * be a label that never applies to anything, and it would look set."
     *
     * So the operator types it the way a person types it, and the label has to decide the
     * asset anyway. This is the anti-goal about an action that appears to work and does
     * nothing, on the one write where it would be invisible.
     */
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        const recorded = yield* record(store, {
          kind: "endpoint",
          url: "https://app.acme.test/v1/orders",
          method: "GET",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "  HTTPS://App.Acme.Test:443/login  ",
          state: "out",
          reason: "typed the way a person types it",
        });
        const scope = yield* store.targetScope(TARGET);
        const labelled = yield* store.assetsWithScope(TARGET);
        // Cleared the same way, which is the other half of the same step.
        yield* store.clearHostScopeLabel(OPERATOR, "APP.Acme.Test.:8443");
        const restored = yield* store.assetsWithScope(TARGET);
        return {
          assetId: recorded.assetId,
          hostLabels: scope.hostLabels,
          labelled: labelled.find((row) => row.asset.id === recorded.assetId),
          restored: restored.find((row) => row.asset.id === recorded.assetId),
        };
      }),
    );

    // Keyed by the matched form, not by what was typed.
    expect(outcome.hostLabels).toHaveLength(1);
    expect(outcome.hostLabels[0]?.host).toBe("app.acme.test");
    // And it decides the asset, which is the part a key that merely looked right would
    // not do.
    expect(outcome.labelled?.scope.state).toBe("out");
    expect(outcome.labelled?.scope.by._tag).toBe("hostLabel");
    // Cleared by a third spelling of the same host, and the entry decides it again.
    expect(outcome.restored?.scope.state).toBe("in");
    expect(outcome.restored?.scope.by._tag).toBe("entry");
  });

  test("every label change lands in the event log, attributed to the operator", async () => {
    const path = newDatabasePath();
    const events = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seed(store);
        const recorded = yield* record(store, {
          kind: "host",
          url: "https://app.acme.test/",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "app.acme.test",
          state: "out",
          reason: null,
        });
        yield* store.setAssetScopeLabel(OPERATOR, {
          assetId: recorded.assetId,
          state: "in",
          reason: null,
        });
        yield* store.clearAssetScopeLabel(OPERATOR, recorded.assetId);
        yield* store.clearHostScopeLabel(OPERATOR, "app.acme.test");
        const log = yield* store.eventsAfter(0, 100);
        return log.filter((event) => event.kind.startsWith("scope."));
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "scope.host.labelled",
      "scope.asset.labelled",
      "scope.asset.label.cleared",
      "scope.host.label.cleared",
    ]);
    // A cleared label is its own kind rather than a labelled event carrying a null state:
    // "the operator withdrew their label" is a recorded fact, not the absence of one.
    for (const event of events) {
      expect(event.callerScope).toBe(operatorScope(TARGET));
      expect(event.attemptId).toBeNull();
      expect(event.intentId).toBeNull();
    }
  });
});

/* ── The host read, where there is no asset row ──────────────────────────────────── */

describe("one host's state", () => {
  test("it answers for a host nothing has been discovered on", async () => {
    // The operator must be able to reason about — and exclude — a host before anything on
    // it is found, which is why `host_scope_labels` has no foreign key to anything.
    const path = newDatabasePath();
    const outcome = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "subtree",
          value: "acme.test",
          source: "operator",
        });
        yield* store.setHostScopeLabel(OPERATOR, {
          host: "future.acme.test",
          state: "out",
          reason: null,
        });
        return {
          covered: yield* store.scopeStateOfHost(TARGET, "app.acme.test"),
          labelled: yield* store.scopeStateOfHost(TARGET, "future.acme.test"),
          uncovered: yield* store.scopeStateOfHost(TARGET, "elsewhere.test"),
        };
      }),
    );
    expect(outcome.covered.state).toBe("in");
    expect(outcome.covered.by._tag).toBe("entry");
    expect(outcome.labelled.state).toBe("out");
    expect(outcome.labelled.by._tag).toBe("hostLabel");
    expect(outcome.uncovered.by._tag).toBe("default");
  });

  test("it normalises what it is asked about", async () => {
    const path = newDatabasePath();
    const state = await withStore(path, (store) =>
      Effect.gen(function* () {
        yield* store.addScopeEntry(OPERATOR, {
          effect: "in",
          kind: "host",
          value: "app.acme.test",
          source: "operator",
        });
        // A URL, with a scheme, a port, a path and mixed case — the form a caller
        // actually has rather than the form the matcher wants.
        return yield* store.scopeStateOfHost(
          TARGET,
          "HTTPS://App.Acme.Test:8443/login",
        );
      }),
    );
    expect(state.state).toBe("in");
  });
});
