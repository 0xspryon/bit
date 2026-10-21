/**
 * The Sprint 02 proof: the investigation survives a restart, and a crash cannot
 * half-write a mutation.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/persistenceProof.ts 2>&1 | tee .runtime/persistence-proof-$(date +%H%M%S).log
 * ```
 *
 * A **sibling** of `milestoneProof.ts` rather than a fifth phase on it, which the brief
 * allows and which is the right choice for one reason: `milestoneProof.ts` needs a real
 * subscription-authenticated OpenCode worker and spends model tokens, so it can be run
 * only where that is available. Everything this sprint claims is about files, transactions
 * and process death, none of which needs a model — so this proof can actually be executed
 * on every machine, and its output is evidence rather than a description of evidence.
 *
 * | Phase | What it establishes |
 * | ----- | ------------------- |
 * | 1 | Two targets are registered in `control.sqlite` and the migration runner iterates the registry, migrating each target's own file. |
 * | 2 | Each mutation writes its domain row, receipt, event and — where one is implied — its outbox entry, in one transaction. An intent anchors only to recorded evidence. |
 * | 3 | A process killed with `SIGKILL` between two mutations loses the second and keeps the first; a process killed `SIGKILL` **inside** an uncommitted transaction loses all of it, including the event and the obligation. |
 * | 4 | After the restart: events read back in sequence order, the obligations are still undispatched, the abandoned attempt is reconciled honestly, and target B is untouched and unreachable from target A's connection. |
 * | 5 | A replayed operation id returns the original result with no second event and no second outbox row; the same id with changed input is refused and writes nothing. |
 * | 6 | A superseded attempt's credential is refused after the fence bump, across the restart. |
 *
 * **Each phase runs in its own `Effect.scoped` region, and the killed steps run in their
 * own processes.** That is load-bearing rather than tidy: a scope closing is what releases
 * the connection, and phase 4 reads a file that the process which wrote it no longer
 * exists to have flushed. "The data is durable" is then demonstrated by a different
 * process reading it, not asserted about a connection we never closed.
 *
 * **Exact checks only.** Unlike `milestoneProof.ts` there is no human-judgement section,
 * because there is no model output to judge: every check here is a boolean computed from a
 * row on disk, a file's existence, or a child process's exit signal.
 *
 * It imports nothing from a module that calls `runMain` at its top level — importing one
 * runs it, which is the hazard §22 records. `crashStep.ts` is spawned as a child process,
 * never imported.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import {
  FleetStore,
  fleetPaths,
  targetStoreLayer,
  type FleetMigrationOutcome,
} from "../persistence/fleet";
import { ObservationStore, type CallerContext } from "../persistence/store";
import { HarnessSessionStatus } from "../recovery/harnessStatus";
import {
  reconcileUnsettledAttempts,
  renderReconciliation,
} from "../recovery/reconcile";
import { RUNTIME_DIR } from "./runtime";
import { runMain } from "./main";

const STAMP = new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14);

/** This run's own fleet, under the gitignored runtime directory. */
const ROOT = join(RUNTIME_DIR, `persistence-proof-${STAMP}`);
const TARGET_A = "proof-a";
const TARGET_B = "proof-b";

const GOAL_ID = "goal-ratelimit";
const INTENT_ID = "intent-per-client-limiter";
const ATTEMPT_ID = "attempt-crash";
const SURVIVING_OPERATION = "op-survives-the-crash";
const LOST_OPERATION = "op-never-committed";
const CRASH_STEP = join(import.meta.dir, "crashStep.ts");

const banner = (text: string) => {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
};
const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(42)} ${String(value)}`);

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly evidence: string;
}
const checks: Check[] = [];
const exact = (name: string, passed: boolean, evidence: string) => {
  checks.push({ name, passed, evidence });
};

const caller = (targetId: string, attemptId = ATTEMPT_ID): CallerContext => ({
  callerScope: `${targetId}/${attemptId}`,
  targetId,
  intentId: INTENT_ID,
  attemptId,
  harnessSessionId: "ses_crash",
  workerId: "worker-crash",
  attemptFence: 0,
});

/** A fleet scope. The control connection is released when it closes. */
const withFleet = <A, E>(
  use: (fleet: FleetStore["Service"]) => Effect.Effect<A, E, FleetStore>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(FleetStore, use).pipe(
        Effect.provide(FleetStore.layer(ROOT)),
      ),
    ),
  );

/** One target's store, reached the only sanctioned way: through the registry. */
const withTarget = <A, E>(
  targetId: string,
  use: (store: ObservationStore["Service"]) => Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(ObservationStore, use).pipe(
        Effect.provide(targetStoreLayer(targetId)),
        Effect.provide(FleetStore.layer(ROOT)),
      ),
    ),
  );

/** Runs `crashStep.ts` as a child and reports how it died. */
const runCrashStep = async (
  targetId: string,
  mode: "write" | "between" | "inside",
) => {
  const child = Bun.spawn(["bun", CRASH_STEP, ROOT, targetId, mode], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  for (const text of [stdout, stderr]) {
    for (const row of text.split("\n")) {
      if (row.trim().length > 0) console.log(`    child: ${row}`);
    }
  }
  return {
    exitCode: child.exitCode,
    signal: child.signalCode,
  };
};

const assetInput = (
  operationId: string,
  path: string,
  method = "POST",
  note = "Observed in the fixture's own route table.",
) => ({
  operationId,
  kind: "endpoint" as const,
  url: `http://127.0.0.1:41317${path}`,
  method,
  note,
});

const observationInput = (operationId: string) => ({
  operationId,
  testedClaim:
    "Varying the X-Client-Id header evades the 10-request per-client limit on POST /login.",
  outcome: "positive" as const,
  setup: "Local rate-limit fixture, counters reset immediately before the run.",
  cases: [
    {
      id: "case-saturate",
      purpose: "Establish the per-client threshold under one fixed identity.",
      actors: [
        {
          id: "fixed",
          account: "alice",
          role: "end-user",
          clientIdentity: "X-Client-Id request header held at 'fixed-a'",
        },
      ],
      relationships: [],
      actions: [
        {
          actorId: "fixed",
          endpoint: "http://127.0.0.1:41317/login",
          method: "POST",
          description:
            "Sequential wrong-password logins until the first refusal.",
          requestCount: 11,
          observedBehavior:
            "Requests 1-10 returned 401 invalid_credentials; request 11 returned 429 rate_limited.",
          evidenceRefs: [],
        },
      ],
      configuration: "per-client limit 10, per-account limit 100, independent",
      windowStart: 1_000,
      windowEnd: 2_000,
      testBounds: "11 requests, one identity, one sequential window",
      limitations: ["Single short window; no window rollover measured."],
    },
  ] as const,
  interpretation:
    "The limiter keys on the header value, so rotating it admits requests the exhausted value no longer gets.",
  limitations: ["A request header is not a network address."],
  untestedDimensions: [
    "The per-account limit was never approached.",
    "No window rollover was measured.",
  ],
  addressesDimensions: [] as readonly string[],
});

/** Phase 1 — two targets in the registry, each migrated into its own file. */
const phaseOne = async () => {
  banner(
    "Phase 1 — two tiers: a registry in control.sqlite, a file per target",
  );
  const paths = fleetPaths(ROOT);
  const swept = await withFleet((fleet) =>
    Effect.gen(function* () {
      yield* fleet.register({
        targetId: TARGET_A,
        name: "Proof target A",
        scopeNote: "Only the local rate-limit fixture is in scope.",
      });
      yield* fleet.register({
        targetId: TARGET_B,
        name: "Proof target B",
        scopeNote: "Registered to prove isolation; nothing is run against it.",
      });
      const outcomes = yield* fleet.migrateFleet();
      const again = yield* fleet.migrateFleet();
      return { outcomes, again };
    }),
  );

  const describe = (outcome: FleetMigrationOutcome) =>
    `${outcome.targetId}: ${outcome.state}, schema ${String(outcome.appliedThrough)}, ${outcome.detail}`;
  line("control database", paths.controlFile);
  for (const outcome of swept.outcomes) line("  migrated", describe(outcome));

  exact(
    "the registry holds two targets and the runner iterated both",
    swept.outcomes.length === 2 &&
      swept.outcomes.every((outcome) => outcome.state === "ready"),
    swept.outcomes.map(describe).join(" | "),
  );
  exact(
    "each target has its own hunt.sqlite and its own evidence directory",
    [TARGET_A, TARGET_B].every(
      (id) =>
        existsSync(paths.huntFile(id)) &&
        existsSync(paths.evidenceDirectory(id)),
    ),
    `${paths.huntFile(TARGET_A)} + ${paths.huntFile(TARGET_B)}`,
  );
  exact(
    "a second sweep applies nothing to either file",
    swept.again.every((outcome) => outcome.applied.length === 0),
    swept.again
      .map((outcome) => `${outcome.targetId}=${outcome.detail}`)
      .join(", "),
  );
};

/** Phase 2 — one transaction per mutation, and anchoring enforced in the store. */
const phaseTwo = async () => {
  banner(
    "Phase 2 — asset, anchored intent and observation, each in one transaction",
  );
  const outcome = await withTarget(TARGET_A, (store) =>
    Effect.gen(function* () {
      yield* store.seedAttempt({
        targetId: TARGET_A,
        goalId: GOAL_ID,
        goal: "Determine whether authentication rate limits on the fixture can be bypassed.",
        intentId: INTENT_ID,
        question:
          "Probe the per-client request limiter on POST /login; leave any per-account limit untested.",
        attemptId: "attempt-phase-two",
        workerId: "worker-proof",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        harnessSessionId: "ses_phase_two",
      });
      const context = caller(TARGET_A, "attempt-phase-two");
      const asset = yield* store.recordAsset(
        context,
        assetInput("op-asset-login", "/login"),
      );
      const observation = yield* store.recordObservation(
        context,
        observationInput("op-observation-one"),
      );
      // Anchored to the observation that produced the direction, which is §4's rule.
      const anchored = yield* store.addIntent(
        { callerScope: `host/${TARGET_A}`, targetId: TARGET_A },
        {
          operationId: "op-intent-account",
          goalId: GOAL_ID,
          intentId: "intent-per-account-limiter",
          question: "Measure the per-account limiter on POST /login directly.",
          anchorObservationIds: [observation.observationId],
          addressesDimension: `${observation.observationId}#u0`,
        },
      );
      // And the refusal, which is the half that proves the rule is enforced rather
      // than merely available.
      const refusedOnIntent = yield* Effect.result(
        store.addIntent(
          { callerScope: `host/${TARGET_A}`, targetId: TARGET_A },
          {
            operationId: "op-intent-bad",
            goalId: GOAL_ID,
            intentId: "intent-speculative",
            question: "A direction anchored to another direction.",
            anchorObservationIds: [INTENT_ID],
            addressesDimension: null,
          },
        ),
      );
      return {
        asset,
        observation,
        anchored,
        refusedOnIntent,
        events: yield* store.eventsAfter(),
        pending: yield* store.pendingRequests(),
        anchors: yield* store.anchorsForIntent("intent-per-account-limiter"),
        speculative: yield* store.loadIntent("intent-speculative"),
      };
    }),
  );

  for (const event of outcome.events)
    line(
      `  event ${String(event.sequence)}`,
      `${event.kind} subject=${event.subjectId} op=${event.operation}/${String(event.operationId)} caller=${String(event.callerScope)} attempt=${String(event.attemptId)}`,
    );
  for (const entry of outcome.pending)
    line(
      `  outbox ${String(entry.sequence)}`,
      `${entry.requestType} policy=${entry.recoveryPolicy} status=${entry.status} from=${entry.causedByEventId}`,
    );

  exact(
    "one event per mutation, in commit order, with a dense sequence",
    outcome.events
      .map((event) => `${String(event.sequence)}:${event.kind}`)
      .join(",") === "1:asset.recorded,2:observation.recorded,3:intent.added",
    outcome.events.map((event) => event.kind).join(", "),
  );
  exact(
    "the three identities stay separate on every event",
    outcome.events[0]?.attemptId === "attempt-phase-two" &&
      outcome.events[0]?.operationId === "op-asset-login" &&
      outcome.events[0]?.subjectId === outcome.asset.assetId &&
      // A host-created intent carries no attempt rather than a fabricated one.
      outcome.events[2]?.attemptId === null &&
      outcome.events[2]?.callerScope === `host/${TARGET_A}`,
    `asset attempt=${String(outcome.events[0]?.attemptId)}, intent attempt=${String(outcome.events[2]?.attemptId)}`,
  );
  exact(
    "two obligations are queued, each naming the event that implies it; the intent queues none",
    outcome.pending.length === 2 &&
      outcome.pending[0]?.requestType === "asset.enrich" &&
      outcome.pending[0]?.recoveryPolicy === "safe_to_retry" &&
      outcome.pending[1]?.requestType === "notification.deliver" &&
      outcome.pending[1]?.recoveryPolicy === "reconcile_first" &&
      outcome.pending.every((entry) => entry.status === "pending") &&
      outcome.pending[0]?.causedByEventId === outcome.events[0]?.eventId,
    outcome.pending
      .map((entry) => `${entry.requestType}/${entry.recoveryPolicy}`)
      .join(", "),
  );
  exact(
    "an intent anchored to recorded evidence is accepted, and keeps its lineage",
    outcome.anchored.topLevel === false &&
      outcome.anchors.length === 1 &&
      outcome.anchors[0] === outcome.observation.observationId &&
      outcome.anchored.addressesDimensionId !== null,
    `anchored to ${String(outcome.anchors[0])}, declares dimension ${String(outcome.anchored.addressesDimensionId)}`,
  );
  exact(
    "an intent anchored to another intent is refused, instructively, and writes nothing",
    outcome.refusedOnIntent._tag === "Failure" &&
      outcome.speculative === undefined &&
      String(
        outcome.refusedOnIntent._tag === "Failure"
          ? outcome.refusedOnIntent.failure.message
          : "",
      ).includes("cannot anchor an intent"),
    outcome.refusedOnIntent._tag === "Failure"
      ? outcome.refusedOnIntent.failure.message
      : "accepted, which is wrong",
  );
};

/** Phase 3 — two processes killed on purpose, in two different places. */
const phaseThree = async () => {
  banner(
    "Phase 3 — SIGKILL between two mutations, and inside an uncommitted one",
  );

  const before = await withTarget(TARGET_A, (store) =>
    Effect.gen(function* () {
      return {
        events: (yield* store.eventsAfter()).length,
        assets: (yield* store.assets()).length,
      };
    }),
  );

  console.log("\n-- killed between two mutations --");
  const between = await runCrashStep(TARGET_A, "between");
  console.log("\n-- killed inside an uncommitted transaction --");
  const inside = await runCrashStep(TARGET_A, "inside");

  const after = await withTarget(TARGET_A, (store) =>
    Effect.gen(function* () {
      const assets = yield* store.assets();
      return {
        assets,
        events: yield* store.eventsAfter(),
        pending: yield* store.pendingRequests(),
        attempt: yield* store.loadAttempt(ATTEMPT_ID, TARGET_A),
        survivor: assets.find((asset) => asset.path === "/login"),
        lost: assets.find((asset) => asset.path === "/reset"),
      };
    }),
  );

  line(
    "killed between: signal",
    `${String(between.signal)} (exit ${String(between.exitCode)})`,
  );
  line(
    "killed inside: signal",
    `${String(inside.signal)} (exit ${String(inside.exitCode)})`,
  );
  line("assets before the two kills", before.assets);
  line("assets after", after.assets.length);
  for (const asset of after.assets) line("  asset", asset.identity);

  exact(
    "both child processes really died by SIGKILL, not by a clean exit",
    between.signal === "SIGKILL" && inside.signal === "SIGKILL",
    `${String(between.signal)} / ${String(inside.signal)}`,
  );
  exact(
    "the mutation that committed before the kill survived it",
    after.survivor !== undefined,
    `POST /login present: ${String(after.survivor !== undefined)}`,
  );
  exact(
    "the mutation inside the uncommitted transaction left no trace at all",
    after.lost === undefined &&
      after.events.every((event) => event.subjectId !== "/reset") &&
      !after.events.some((event) => event.operationId === LOST_OPERATION) &&
      !after.pending.some((entry) =>
        JSON.stringify(entry.payload).includes("/reset"),
      ),
    "no asset, no discovery, no receipt, no event and no outbox row for POST /reset",
  );
  exact(
    "the killed process's attempt is left running, for recovery to settle",
    after.attempt?.status === "running",
    `attempt ${ATTEMPT_ID} is ${String(after.attempt?.status)}`,
  );
};

/** Phase 4 — the restart: ordered reads, undispatched obligations, reconciliation. */
const phaseFour = async () => {
  banner(
    "Phase 4 — after the restart: ordered events, live obligations, honest recovery",
  );

  const reconciled = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* ObservationStore;
        const outcomes = yield* reconcileUnsettledAttempts();
        return {
          outcomes,
          attempt: yield* store.loadAttempt(ATTEMPT_ID, TARGET_A),
          events: yield* store.eventsAfter(),
          fromSecond: yield* store.eventsAfter(1),
          pending: yield* store.pendingRequests(),
          observations: yield* store.observationsForIntent(INTENT_ID),
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            targetStoreLayer(TARGET_A),
            // No harness to ask, so every unsettled attempt reconciles to `uncertain`:
            // the honest answer, never `failed`, and never "it did nothing".
            HarnessSessionStatus.fromAnswers({}),
          ).pipe(Layer.provide(FleetStore.layer(ROOT))),
        ),
      ),
    ),
  );

  for (const entry of reconciled.outcomes)
    line("  reconciled", renderReconciliation(entry));
  line(
    "events, in sequence order",
    reconciled.events.map((e) => e.sequence).join(", "),
  );
  line("obligations still undispatched", reconciled.pending.length);

  const sequences = reconciled.events.map((event) => event.sequence);
  exact(
    "the event log reads back in ascending sequence order, with no gap",
    sequences.every((value, index) => value === index + 1) &&
      sequences.length > 0,
    `sequences: ${sequences.join(", ")}`,
  );
  exact(
    "a cursor read returns only what follows it",
    reconciled.fromSecond.length === reconciled.events.length - 1 &&
      reconciled.fromSecond.every((event) => event.sequence > 1),
    `after 1: ${reconciled.fromSecond.map((e) => e.sequence).join(", ")}`,
  );
  exact(
    "the outbox still holds its obligations, none of them dispatched",
    reconciled.pending.length > 0 &&
      reconciled.pending.every(
        (entry) =>
          entry.status === "pending" &&
          entry.attempts === 0 &&
          entry.leaseOwner === null,
      ),
    `${String(reconciled.pending.length)} pending, 0 attempted`,
  );
  exact(
    "the abandoned attempt is uncertain, not failed, and its authority is revoked",
    reconciled.attempt?.status === "uncertain" &&
      (reconciled.attempt?.write_fence ?? 0) > 0,
    `${String(reconciled.attempt?.status)}, fence ${String(reconciled.attempt?.write_fence)}`,
  );
  exact(
    "the provenance recorded before the crash is intact",
    reconciled.observations.length > 0 &&
      reconciled.observations.every(
        (observation) =>
          observation.provenance.targetId === TARGET_A &&
          observation.provenance.intentId === INTENT_ID,
      ),
    `${String(reconciled.observations.length)} observation(s), all bound to ${TARGET_A}/${INTENT_ID}`,
  );

  // Target B, from its own connection and from A's.
  const isolation = await withTarget(TARGET_B, (store) =>
    Effect.gen(function* () {
      return {
        events: yield* store.eventsAfter(),
        assets: yield* store.assets(),
        aIntent: yield* store.loadIntent(INTENT_ID),
        aObservations: yield* store.observationsForIntent(INTENT_ID),
      };
    }),
  );
  const crossRead = await withTarget(TARGET_A, (store) =>
    store.loadAttempt(ATTEMPT_ID, TARGET_B),
  );

  exact(
    "target B is untouched: no events, no assets, and none of A's rows",
    isolation.events.length === 0 &&
      isolation.assets.length === 0 &&
      isolation.aIntent === undefined &&
      isolation.aObservations.length === 0,
    `B holds ${String(isolation.events.length)} events and ${String(isolation.assets.length)} assets`,
  );
  exact(
    "A's connection cannot reach a row under B's target id",
    crossRead === undefined,
    "loadAttempt(attempt, target B) from A's connection returned nothing",
  );
};

/** Phase 5 — the replay and the conflict, after the crash and the restart. */
const phaseFive = async () => {
  banner("Phase 5 — one result for a retry, none for a conflicting one");
  const outcome = await withTarget(TARGET_A, (store) =>
    Effect.gen(function* () {
      const before = {
        events: (yield* store.eventsAfter()).length,
        pending: (yield* store.pendingRequests()).length,
        assets: (yield* store.assets()).length,
      };
      // The operation the killed process committed, replayed by a different process
      // under the same caller scope and operation id.
      const replay = yield* store.recordAsset(
        caller(TARGET_A),
        assetInput(SURVIVING_OPERATION, "/login"),
      );
      const conflict = yield* Effect.result(
        store.recordAsset(
          caller(TARGET_A),
          assetInput(SURVIVING_OPERATION, "/login", "POST", "a different note"),
        ),
      );
      return {
        before,
        replay,
        conflict,
        events: (yield* store.eventsAfter()).length,
        pending: (yield* store.pendingRequests()).length,
        assets: (yield* store.assets()).length,
      };
    }),
  );

  line(
    "replayed operation",
    `${SURVIVING_OPERATION} -> ${outcome.replay.assetId}`,
  );
  line(
    "events before / after",
    `${String(outcome.before.events)} / ${String(outcome.events)}`,
  );
  line(
    "obligations before / after",
    `${String(outcome.before.pending)} / ${String(outcome.pending)}`,
  );

  exact(
    "a replayed operation id returns the committed result and writes nothing",
    outcome.replay.replayed &&
      outcome.events === outcome.before.events &&
      outcome.pending === outcome.before.pending &&
      outcome.assets === outcome.before.assets,
    `replayed=${String(outcome.replay.replayed)}, no new event, no new obligation, no new asset`,
  );
  exact(
    "the same operation id with changed input is refused, and writes nothing",
    outcome.conflict._tag === "Failure" &&
      outcome.events === outcome.before.events &&
      outcome.pending === outcome.before.pending,
    outcome.conflict._tag === "Failure"
      ? outcome.conflict.failure.message
      : "accepted, which is wrong",
  );
};

/** Phase 6 — the revoked credential, across the restart. */
const phaseSix = async () => {
  banner("Phase 6 — a superseded attempt cannot change anything");
  const outcome = await withTarget(TARGET_A, (store) =>
    Effect.gen(function* () {
      const attempt = yield* store.loadAttempt(ATTEMPT_ID, TARGET_A);
      const stale = yield* Effect.result(
        store.recordAsset(
          caller(TARGET_A),
          assetInput("op-after-the-fence", "/health", "GET"),
        ),
      );
      // The same credential reminted against the *current* fence is still refused: the
      // attempt is no longer running, which is a separate rule from the fence.
      const refreshed = yield* Effect.result(
        store.recordObservation(
          { ...caller(TARGET_A), attemptFence: attempt?.write_fence ?? 0 },
          observationInput("op-after-the-fence-2"),
        ),
      );
      return {
        attempt,
        stale,
        refreshed,
        assets: (yield* store.assets()).length,
        events: (yield* store.eventsAfter()).length,
      };
    }),
  );

  line(
    "attempt status / fence",
    `${String(outcome.attempt?.status)} / ${String(outcome.attempt?.write_fence)}`,
  );
  exact(
    "a credential minted before the fence bump is refused as stale",
    outcome.stale._tag === "Failure" &&
      outcome.stale.failure._tag === "MutationError" &&
      outcome.stale.failure.reason === "stale",
    outcome.stale._tag === "Failure"
      ? outcome.stale.failure.message
      : "accepted, which is wrong",
  );
  exact(
    "reminting against the current fence does not restore authority",
    outcome.refreshed._tag === "Failure",
    outcome.refreshed._tag === "Failure"
      ? outcome.refreshed.failure.message
      : "accepted, which is wrong",
  );
};

const report = () => {
  banner("Exact checks");
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
    console.log(`      ${check.evidence}`);
  }
  const passed = checks.filter((check) => check.passed).length;
  console.log(
    `\n${String(passed)}/${String(checks.length)} exact checks passed`,
  );
  console.log(`fleet left in place for inspection: ${ROOT}`);
  return passed === checks.length;
};

const program = Effect.gen(function* () {
  // A fleet of this run's own. A proof that wrote into a root holding earlier evidence
  // could not be re-run, and its counts would be somebody else's rows.
  yield* Effect.sync(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  yield* Effect.promise(phaseOne);
  yield* Effect.promise(phaseTwo);
  yield* Effect.promise(phaseThree);
  yield* Effect.promise(phaseFour);
  yield* Effect.promise(phaseFive);
  yield* Effect.promise(phaseSix);
  const ok = yield* Effect.sync(report);
  if (!ok) {
    return yield* Effect.sync(() => {
      process.exitCode = 1;
    });
  }
});

runMain(program);
