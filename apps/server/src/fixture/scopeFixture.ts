/**
 * Seeds one target with a discovered estate and an authored scope, so the Assets screen
 * has something to show.
 *
 * ```sh
 * cd apps/server
 * bun run src/fixture/scopeFixture.ts
 * # then, from the repository root:
 * bun run dev
 * ```
 *
 * Open the target it names, then **Assets** in the rail. The Estate tab shows the three
 * scope states — in scope, excluded on purpose, covered by nothing — and the Scope tab
 * shows the two authored lists beside the block an agent would actually be given.
 *
 * ## Why a fixture and not a test
 *
 * Every property this seeds is already asserted somewhere — `scopeStore.test.ts` for the
 * ladder, `browserApi.test.ts` for the routes, `assets.test.ts` for the screen's state.
 * What none of those can give is a **screen a person can look at**: a reviewer needs to
 * see that the three chips read differently, that the sentence under each one says who
 * decided it, and that the preview panel's text is the text the agent gets. So this writes
 * through the real paths — `FleetStore.register`, `store.recordAsset` under a real
 * attempt, `store.addScopeEntry` as the operator — rather than inserting rows, because a
 * fixture that bypassed the write paths could show a screen the application cannot
 * actually produce.
 *
 * ## It is idempotent, and it is not destructive
 *
 * Running it twice registers nothing twice and adds no duplicate entries: the target
 * registration is skipped if the row is there, `recordAsset` is keyed by `operationId`,
 * and `addScopeEntry` is a no-op on an entry that already exists. It deletes nothing and
 * touches no other target. To start over, remove the target's own directory —
 * `.runtime/hunt/targets/scope-demo/` — which is the whole of its state.
 *
 * `HUNT_ROOT` is resolved exactly as `main.ts` resolves it, so the server started by
 * `bun run dev` reads the file this writes. Point both at the same place with the
 * environment variable if you keep your fleet elsewhere.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { FleetStore } from "../persistence/fleet";
import { operatorScope } from "../persistence/store";
import { TargetStores, withTargetStore } from "../persistence/targetStores";
import { runMain } from "../spike/main";

/** The same default `main.ts` uses, so the server and this agree without being told. */
const HUNT_ROOT =
  process.env["HUNT_ROOT"] ?? join(process.cwd(), ".runtime", "hunt");

const TARGET_ID = "scope-demo";
const GOAL_ID = "goal_scope_demo";
const INTENT_ID = "int_scope_demo";
const ATTEMPT_ID = "att_scope_demo";

/**
 * The workspace folder the registration records.
 *
 * Created because the New target dialog would have chosen an existing one, and a row
 * pointing at a folder that is not there makes the rail mark the target unavailable.
 */
const WORKSPACE = join(HUNT_ROOT, "workspaces", TARGET_ID);

/**
 * What the agent "found", as the URLs it would have submitted.
 *
 * Chosen to produce all three states against the entries below, because a fixture where
 * everything lands in one state would let a screen that ignores the state look right:
 *
 * - `app.acme.test` and its endpoints — in scope, by the `acme.test` subtree entry.
 * - `blog.acme.test` — excluded on purpose, by an `out` host entry.
 * - `x.labs.acme.test` — under an `out` subtree, and promoted by hand, so it is in scope
 *   *overriding* that exclusion. This is the row that proves `overrode` reaches the view.
 * - `api.acme-cdn.test` — covered by nothing, which is the group that asks the operator
 *   for a decision and the only one carrying an action on its header.
 * - `203.0.113.44` — in scope by the CIDR entry, which is the path a name never takes.
 */
const DISCOVERIES: ReadonlyArray<{
  readonly kind: "host" | "endpoint";
  readonly url: string;
  readonly method: string | null;
  readonly note: string;
}> = [
  {
    kind: "host",
    url: "https://app.acme.test/",
    method: null,
    note: "Answered a TLS handshake; certificate names the apex.",
  },
  {
    kind: "endpoint",
    url: "https://app.acme.test/v1/orders?page=2",
    method: "GET",
    note: "Linked from the dashboard; returned a tenant-scoped list.",
  },
  {
    kind: "endpoint",
    url: "https://app.acme.test/graphql",
    method: "POST",
    note: "Introspection was enabled; the schema is large.",
  },
  {
    kind: "endpoint",
    url: "https://app.acme.test/internal/metrics",
    method: "GET",
    note: "Reachable without authentication. Looks like an operations endpoint.",
  },
  {
    kind: "host",
    url: "https://blog.acme.test/",
    method: null,
    note: "WordPress, on the marketing stack rather than the product.",
  },
  {
    kind: "endpoint",
    url: "https://blog.acme.test/wp-login.php",
    method: "GET",
    note: "Standard login form.",
  },
  {
    kind: "host",
    url: "https://x.labs.acme.test/",
    method: null,
    note: "Named in a CORS header on an in-scope host.",
  },
  {
    kind: "host",
    url: "https://api.acme-cdn.test/",
    method: null,
    note: "Named in a CORS header on an in-scope host. Different registration.",
  },
  {
    kind: "endpoint",
    url: "https://api.acme-cdn.test/graphql",
    method: "POST",
    note: "Same shape as the product's GraphQL endpoint.",
  },
  {
    kind: "host",
    url: "https://203.0.113.44:8443/",
    method: null,
    note: "Open TLS port inside the authorized range.",
  },
];

const ENTRIES: ReadonlyArray<{
  readonly effect: "in" | "out";
  readonly kind: "subtree" | "host" | "cidr";
  readonly value: string;
}> = [
  { effect: "in", kind: "subtree", value: "acme.test" },
  { effect: "in", kind: "host", value: "app.partner.test" },
  { effect: "in", kind: "cidr", value: "203.0.113.0/24" },
  { effect: "out", kind: "subtree", value: "labs.acme.test" },
  { effect: "out", kind: "host", value: "blog.acme.test" },
];

const seed = Effect.gen(function* () {
  const fleet = yield* FleetStore;

  const existing = yield* fleet.target(TARGET_ID);
  if (existing === undefined) {
    mkdirSync(WORKSPACE, { recursive: true });
    yield* fleet.register({
      targetId: TARGET_ID,
      name: "Acme Corp (scope demo)",
      // Still here, still prose, and no longer presented as machine-readable: the
      // structured scope below is what anything actually reads.
      scopeNote: "See the Scope tab. This note is for a human.",
      workspacePath: WORKSPACE,
    });
    yield* Effect.logInfo(`registered target ${TARGET_ID}`);
  } else {
    yield* Effect.logInfo(`target ${TARGET_ID} is already registered`);
  }
  // Brings the file up to the current chain, including `0022`, whether it was just
  // created or predates the migration.
  const migrated = yield* fleet.migrateTarget(TARGET_ID);
  yield* Effect.logInfo(
    `schema: applied through ${String(migrated.appliedThrough)}`,
  );

  const stores = yield* TargetStores;
  yield* withTargetStore(stores, TARGET_ID, (store) =>
    Effect.gen(function* () {
      const host = {
        callerScope: operatorScope(TARGET_ID),
        targetId: TARGET_ID,
      };

      /*
       * A goal, an intent and a running attempt, because `asset_discoveries` has real
       * foreign keys to the last two and `recordAsset` opens with `attemptCallerOrFail`.
       * A discovery that cannot say which attempt found it is not provenance, which is
       * exactly why `record_asset` is a worker's tool and why this fixture needs one.
       */
      yield* store.openGoal(host, {
        operationId: `op_${GOAL_ID}`,
        goalId: GOAL_ID,
        name: "Map the estate",
        description:
          "Work out what Acme exposes on the authorized ranges, and what belongs to somebody else.",
      });
      yield* store.addIntent(host, {
        operationId: `op_${INTENT_ID}`,
        goalId: GOAL_ID,
        intentId: INTENT_ID,
        question: "Which hosts and endpoints answer on the authorized ranges?",
        anchorObservationIds: [],
        addressesDimension: null,
      });
      yield* store.seedAttempt({
        targetId: TARGET_ID,
        goalId: GOAL_ID,
        goal: "Map the estate",
        intentId: INTENT_ID,
        question: "Which hosts and endpoints answer on the authorized ranges?",
        attemptId: ATTEMPT_ID,
        workerId: "worker_scope_demo",
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        modelOptions: null,
        harnessSessionId: "ses_scope_demo",
      });

      const worker = {
        _tag: "attempt" as const,
        callerScope: `${TARGET_ID}/${ATTEMPT_ID}`,
        targetId: TARGET_ID,
        intentId: INTENT_ID,
        attemptId: ATTEMPT_ID,
        harnessSessionId: "ses_scope_demo",
        workerId: "worker_scope_demo",
        attemptFence: 0,
      };

      // The entries first, so the scope states the assets come back with are the ones the
      // screen will show rather than "covered by nothing" for everything.
      for (const entry of ENTRIES) {
        const added = yield* store.addScopeEntry(host, {
          ...entry,
          source: "operator",
        });
        yield* Effect.logInfo(
          `entry ${entry.effect}/${entry.kind}/${entry.value}: ${added.created ? "added" : "already there"}`,
        );
      }

      const recorded = new Map<string, string>();
      for (const [index, discovery] of DISCOVERIES.entries()) {
        const result = yield* store.recordAsset(worker, {
          // Stable, so a second run of this fixture replays rather than writing again.
          operationId: `op_demo_${String(index).padStart(2, "0")}`,
          kind: discovery.kind,
          url: discovery.url,
          method: discovery.method,
          note: discovery.note,
        });
        recorded.set(result.identity, result.assetId);
        yield* Effect.logInfo(
          `asset ${result.identity}: ${result.scopeState} — ${result.scopeDetail}`,
        );
      }

      /*
       * Two hand labels, which are what the Estate tab's controls write.
       *
       * The first is D8's promotion out from under the operator's own exclusion: it puts
       * `x.labs.acme.test` in scope while `out`/`subtree`/`labs.acme.test` stays in the
       * typed list, so the row reads "in scope, set by hand, overriding labs.acme.test
       * and every subdomain". That sentence is the one worth looking at.
       *
       * The second excludes a single endpoint while its host stays in scope, which is the
       * asset layer beating the host layer — and it is why the metrics row reads
       * differently from the other three under `app.acme.test`.
       */
      yield* store.setHostScopeLabel(host, {
        host: "x.labs.acme.test",
        state: "in",
        reason:
          "The client confirmed this one host is in scope for this engagement.",
      });
      const metrics = recorded.get(
        "GET https://app.acme.test:443/internal/metrics",
      );
      if (metrics !== undefined) {
        yield* store.setAssetScopeLabel(host, {
          assetId: metrics,
          state: "out",
          reason: "Operations endpoint; the client asked us to leave it alone.",
        });
      }

      const scope = yield* store.targetScope(TARGET_ID);
      const assets = yield* store.assetsWithScope(TARGET_ID);
      const tally = { in: 0, out: 0, uncovered: 0 };
      for (const row of assets) {
        if (row.scope.state === "in") tally.in += 1;
        else if (row.scope.by._tag === "default") tally.uncovered += 1;
        else tally.out += 1;
      }
      yield* Effect.logInfo(
        `seeded: ${String(assets.length)} assets (${String(tally.in)} in scope, ${String(tally.out)} excluded, ${String(tally.uncovered)} not covered), ${String(scope.entries.length)} entries, ${String(scope.hostLabels.length)} host label(s), ${String(scope.assetLabels.length)} asset label(s)`,
      );
    }),
  );

  yield* Effect.logInfo(
    `done. Start the app with \`bun run dev\` from the repository root, open "${TARGET_ID}", then Assets.`,
  );
}).pipe(
  // `TargetStores` resolves a store per target id and needs the registry to do it, so the
  // fleet layer is provided to it as well as being merged in for this script's own use.
  Effect.provide(
    TargetStores.layer.pipe(Layer.provideMerge(FleetStore.layer(HUNT_ROOT))),
  ),
);

/*
 * The same entrypoint the spike demos use, for the reasons its own header records: the
 * program's real exit survives, and Ctrl-C interrupts rather than kills, so the scope
 * closes and the SQLite connections are released instead of being abandoned mid-write.
 */
runMain(seed);
