/**
 * The reliable-single-worker proof, on the current stack, in one reproducible run.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/milestoneProof.ts 2>&1 | tee .runtime/milestone-proof-$(date +%H%M%S).log
 * ```
 *
 * Four phases, each in **its own `Effect.scoped` region**, which is load-bearing rather
 * than tidy: a phase's scope closing is what stops its `opencode serve`, closes its
 * control-plane listener, releases its database connection and revokes its credentials.
 * So phase 2 genuinely runs on a *new harness process with no transcript*, and "the
 * resources closed" is demonstrated by the next phase working against a file rather than
 * asserted about a scope we never closed.
 *
 * | Phase | What it establishes |
 * | ----- | ------------------- |
 * | 1 | A real subscription-authenticated worker investigates only the local fixture, under live policy decisions, and records observations through our authenticated MCP endpoint into SQLite. |
 * | 2 | A fresh process and session, given only a database-derived briefing, chooses a follow-up and cites a real open-question address. |
 * | 3 | A second worker takes on that recorded open question by address, and the control plane shows the question move from uninvestigated to addressed. |
 * | 4 | An attempt abandoned mid-flight is reconciled honestly after a restart, and nothing already terminal is regressed. |
 *
 * **Exact checks and human checks are reported separately, and the distinction is
 * enforced by what each one reads.** An exact check is a boolean computed from
 * control-plane state: a row in the database, a counter on the listener, a decision the
 * policy route answered, an HTTP status. A human check is prose printed for a reader to
 * judge — whether the worker's claim is a sensible test, whether its interpretation
 * matches what it saw, whether the follow-up really addresses the question it cites.
 * Nothing here scores the second kind, and nothing here treats a model's own account of
 * its work as evidence.
 *
 * Everything it drives lives in `phases.ts`. It deliberately imports nothing from a
 * module that calls `runMain` at its top level: importing `workerDemo.ts` for a shared
 * constant is what made the first run of this file execute the worker demo against the
 * development database instead of the proof's own.
 *
 * **Phase 3 picks the follow-up address itself, from the database.** The planner's
 * citation is *checked* in phase 2; it is not used to drive phase 3, because then the run
 * would only be reproducible when the model formats its answer the same way twice.
 */
import type { OpenQuestion } from "@bit/contracts";
import { Effect } from "effect";

import { FixtureEndpoint } from "../fixture/server";
import { OpenCodeClient } from "../harness/openCodeClient";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { ObservationStore } from "../persistence/store";
import {
  reconcileUnsettledAttempts,
  renderReconciliation,
} from "../recovery/reconcile";
import { runMain } from "./main";
import {
  reportPolicy,
  runPlannerPhase,
  runWorkerPhase,
  WORKER_POLICY,
} from "./phases";
import { followUpPrompt, workerPrompt } from "./prompts";
import { openWorkerSession, spikeLayer, SpikePaths } from "./runtime";

const STAMP = new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14);

const TARGET_ID = "fixture-local";
const GOAL_ID = "goal-ratelimit";
const GOAL =
  "Determine whether authentication rate limits on the fixture can be bypassed, and with what impact.";
const INTENT_ID = "intent-per-client-limiter";
const QUESTION =
  "Probe the per-client request limiter on POST /login; leave any per-account limit untested.";

const FIRST_ATTEMPT = `attempt-proof-${STAMP}-a`;
const FOLLOW_UP_ATTEMPT = `attempt-proof-${STAMP}-b`;
const ABANDONED_ATTEMPT = `attempt-proof-${STAMP}-abandoned`;

const REQUEST_BUDGET = 60;
const ACCOUNT = "alice";

/**
 * A database of this run's own, under the gitignored runtime directory.
 *
 * Not the development database: a proof that wrote into the file holding earlier
 * evidence could not be re-run, and its "two observations" check would be counting
 * someone else's rows.
 */
const DATABASE_NAME = `proof-${STAMP}.sqlite`;
const WORKSPACE_NAME = `proof-${STAMP}`;

const layer = () =>
  spikeLayer({
    databaseName: DATABASE_NAME,
    workspaceName: WORKSPACE_NAME,
    policy: WORKER_POLICY,
    // Four phases build this layer four times, each in its own scope. The audit file is
    // already unique to this run, and emptying it per phase would mean the last phase
    // deleted the record of the three that did the work.
    freshAudit: false,
  });

const banner = (text: string) => {
  console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
};

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(34)} ${String(value)}`);

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly evidence: string;
}

const checks: Check[] = [];
const exact = (name: string, passed: boolean, evidence: string) => {
  checks.push({ name, passed, evidence });
};

const human: string[] = [];
const judge = (text: string) => human.push(text);

/**
 * Phase 1 — the worker leg, with the pre-execution hook loaded.
 *
 * The direct policy probe at the end is not a simulation: it posts to the same route the
 * hook consults, on the same port, while the listener is live. It is here because a run
 * in which nothing is denied cannot distinguish "the boundary held" from "the boundary
 * was never asked anything it would refuse", and asking the worker to attempt something
 * out of scope would be putting words in its mouth.
 */
const phaseOne = Effect.gen(function* () {
  const fixture = yield* FixtureEndpoint;
  const control = yield* ControlPlaneEndpoint;
  const paths = yield* SpikePaths;

  line("database", paths.databaseFile);
  line("workspace", paths.workspace);
  line("policy audit", paths.auditFile);
  line("health url", control.healthUrl);
  line("mcp url", control.mcpUrl);
  line("policy url", control.policyUrl);
  line(
    "same origin for all three",
    new URL(control.healthUrl).origin === new URL(control.mcpUrl).origin &&
      new URL(control.mcpUrl).origin === new URL(control.policyUrl).origin,
  );
  line("fixture url (separate listener)", fixture.url);
  line("fixture limits", JSON.stringify(fixture.fixture.limits));

  const result = yield* runWorkerPhase({
    binding: {
      targetId: TARGET_ID,
      goalId: GOAL_ID,
      goal: GOAL,
      intentId: INTENT_ID,
      question: QUESTION,
      attemptId: FIRST_ATTEMPT,
      workerId: "worker-1",
    },
    title: "bit worker: per-client limiter (proof)",
    task: workerPrompt({
      fixtureUrl: fixture.url,
      account: ACCOUNT,
      requestBudget: REQUEST_BUDGET,
      toolName: "record_observation",
    }),
  });

  line("session id", result.sessionId);
  line("session outcome", result.sessionOutcome);
  line("wait failed", result.waitFailed);
  line("settled as", result.settlement.effective ?? "no such attempt");
  line("mcp calls served", result.mcpCallsServed);
  line("observations in db", result.observations.length);
  line("credential revoked", result.credentialRevoked);
  line("live credentials", result.liveCredentials);

  // A deny the boundary really produced, on the live route.
  const denied = yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(control.policyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: result.sessionId,
          tool: "bash",
          input: { command: "curl http://example.com/login" },
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as { effect?: string; reason?: string },
      };
    },
    catch: (cause) => cause,
  });

  console.log("\n-- worker's final message (human check) --");
  console.log(result.finalMessage || "(none)");
  reportPolicy(result);

  console.log("\n-- fixture traffic actually seen --");
  console.log(JSON.stringify(result.fixtureTraffic, null, 2));

  // `lifetimeRequests`, not the live counters: the worker resets the fixture between
  // claims — it is told to, and told that doing so is not a finding — so `perClient`
  // only describes the last window. The lifetime counter survives reset precisely so
  // traffic can be corroborated afterwards (`fixture/rateLimit.ts:118`).
  const traffic = result.fixtureTraffic as {
    readonly perClient?: Record<string, number>;
    readonly lifetimeRequests?: number;
  };
  const fixtureRequests = traffic.lifetimeRequests ?? 0;

  exact(
    "health route answers on the control-plane origin",
    result.health.status === 200 && result.health.body.includes('"ok"'),
    `${String(result.health.status)} ${result.health.body}`,
  );
  exact(
    "worker reached our authenticated MCP endpoint",
    result.mcpCallsServed > 0,
    `${String(result.mcpCallsServed)} authenticated MCP requests served`,
  );
  exact(
    "observations persisted to SQLite",
    result.observations.length > 0,
    `${String(result.observations.length)} rows for ${INTENT_ID}`,
  );
  exact(
    "every observation is provenance-bound to this attempt",
    result.observations.every(
      (item) => item.provenance.attemptId === FIRST_ATTEMPT,
    ),
    result.observations
      .map((item) => `${item.observationId}<-${item.provenance.attemptId}`)
      .join(", "),
  );
  exact(
    "the attempt was settled, not left running",
    result.settlement.effective !== undefined &&
      result.settlement.effective !== "running",
    `settled as ${String(result.settlement.effective)} (changed=${String(result.settlement.changed)})`,
  );
  exact(
    "policy decided the worker's tool calls before they ran",
    result.policyDecisions.length > 0,
    `${String(result.policyDecisions.length)} decisions answered during the run`,
  );
  exact(
    "the live policy route denies an out-of-scope host",
    denied.body.effect === "deny",
    `${String(denied.status)} ${JSON.stringify(denied.body)}`,
  );
  exact(
    "the fixture itself recorded the worker's traffic",
    fixtureRequests > 0,
    `${String(fixtureRequests)} requests over the fixture's lifetime counter, ` +
      `last window ${JSON.stringify(traffic.perClient ?? {})}`,
  );
  exact(
    "the credential stopped resolving once revoked",
    result.credentialRevoked && result.liveCredentials === 0,
    `revoked=${String(result.credentialRevoked)} live=${String(result.liveCredentials)}`,
  );

  judge(
    `Phase 1: is the worker's tested_claim a real, narrow claim, and does its ` +
      `interpretation follow from what its actions observed? Are its untested_dimensions ` +
      `honest about what it skipped? (${String(result.observations.length)} observation(s) printed above.)`,
  );

  return result;
});

/** Phase 2 — a fresh process and session, with only a database-derived briefing. */
const phaseTwo = Effect.gen(function* () {
  const result = yield* runPlannerPhase(INTENT_ID);

  console.log("\n-- briefing handed to the fresh session --");
  console.log(result.briefing);
  console.log("\n-- fresh session's chosen follow-up (human check) --");
  console.log(result.answer || "(none)");

  line("fresh session id", result.sessionId);
  line(
    "cache lineage",
    `${result.lineageSessionId} (${result.lineageReused ? "reused" : "opened now"})`,
  );
  line("session outcome", result.outcome);
  line("prepared at sequence", result.preparedAtSequence);
  line(
    "cited observation ids",
    result.citedObservationIds.join(", ") || "NONE",
  );
  line("cited real addresses", result.citedAddresses.join(", ") || "NONE");
  line("invented addresses", result.inventedAddresses.join(", ") || "none");
  line("answered sections", `${String(result.sections.length)}/5`);

  exact(
    "a fresh session consumed the briefing and finished",
    result.outcome === "succeeded",
    `outcome=${result.outcome}, wait failed=${String(result.waitFailed)}`,
  );
  exact(
    "it cited observation ids that exist in our database",
    result.citedObservationIds.length > 0,
    result.citedObservationIds.join(", ") || "none cited",
  );
  exact(
    "it cited a real open-question address and invented none",
    result.citedAddresses.length > 0 && result.inventedAddresses.length === 0,
    `real=[${result.citedAddresses.join(", ")}] invented=[${result.inventedAddresses.join(", ")}]`,
  );
  exact(
    "it answered every requested section",
    result.sections.length === 5,
    result.sections.join(" "),
  );

  judge(
    `Phase 2: does the proposed next investigation follow from the recorded evidence, ` +
      `and does the address it cited match the gap it describes? Does it avoid treating ` +
      `one observation as settling the broad objective?`,
  );

  return result;
});

/** The question phase 3 takes on: chosen from the database, not from a model's answer. */
const pickFollowUp = (
  questions: readonly OpenQuestion[],
): OpenQuestion | undefined =>
  questions.find((question) => question.status === "uninvestigated");

/**
 * Phase 3 — a second worker addresses one recorded open question by address.
 *
 * This is where the follow-up mechanism is proven end to end: the address comes out of
 * the database, goes into a prompt, comes back as `addresses_dimensions` on a tool call
 * from a different process, is validated against stored state at the write boundary, and
 * shows up as a link that moves the question's status.
 *
 * It also leaves one attempt deliberately abandoned — a real session, bound, never
 * prompted, never settled — so phase 4 has an honestly interrupted attempt to reconcile
 * instead of a fabricated row.
 */
const phaseThree = (target: OpenQuestion) =>
  Effect.gen(function* () {
    const fixture = yield* FixtureEndpoint;
    const store = yield* ObservationStore;
    const client = yield* OpenCodeClient;

    line("addressing", target.address);
    line("question", target.dimension);
    line("status before", target.status);

    const result = yield* runWorkerPhase({
      binding: {
        targetId: TARGET_ID,
        goalId: GOAL_ID,
        goal: GOAL,
        intentId: INTENT_ID,
        question: QUESTION,
        attemptId: FOLLOW_UP_ATTEMPT,
        workerId: "worker-2",
      },
      title: "bit worker: recorded follow-up (proof)",
      task: followUpPrompt({
        fixtureUrl: fixture.url,
        account: ACCOUNT,
        requestBudget: REQUEST_BUDGET,
        toolName: "record_observation",
        address: target.address,
        dimension: target.dimension,
      }),
    });

    console.log("\n-- follow-up worker's final message (human check) --");
    console.log(result.finalMessage || "(none)");
    reportPolicy(result);

    const links = yield* store.dimensionLinksForIntent(INTENT_ID);
    const addressed = result.openQuestions.find(
      (question) => question.address === target.address,
    );

    console.log(`\n-- recorded follow-up links (${links.length}) --`);
    for (const link of links) {
      console.log(
        `  ${link.observationId} addresses ${link.address} (source ${link.sourceObservationId}#${String(link.dimensionIndex)})`,
      );
    }
    console.log(`\n-- open questions after the follow-up --`);
    for (const question of result.openQuestions) {
      console.log(`  [${question.status}] ${question.address}`);
      console.log(`      ${question.dimension}`);
      for (const addresser of question.addressedBy) {
        console.log(
          `      addressed by ${addresser.observationId} (${addresser.outcome})`,
        );
      }
    }

    line("status after", addressed?.status ?? "question missing");
    line("session outcome", result.sessionOutcome);
    line("settled as", result.settlement.effective ?? "no such attempt");

    exact(
      "a later observation addressed the question by address",
      links.some((link) => link.address === target.address),
      links
        .map((link) => `${link.observationId}->${link.address}`)
        .join(", ") || "no links recorded",
    );
    exact(
      "the addressed question is no longer uninvestigated",
      addressed !== undefined && addressed.status !== "uninvestigated",
      `${target.address}: ${target.status} -> ${addressed?.status ?? "missing"}`,
    );
    exact(
      "the briefing shows which observation addressed it, with its outcome",
      (addressed?.addressedBy.length ?? 0) > 0,
      (addressed?.addressedBy ?? [])
        .map((item) => `${item.observationId}(${item.outcome})`)
        .join(", ") || "none",
    );
    exact(
      "the other recorded questions stay open rather than being swept up",
      result.openQuestions.some(
        (question) => question.status === "uninvestigated",
      ) || result.openQuestions.length === 1,
      result.openQuestions
        .map((question) => `${question.address}=${question.status}`)
        .join(", "),
    );

    judge(
      `Phase 3: does the follow-up observation genuinely investigate the question it ` +
        `cites, or merely claim the address? Compare its tested_claim with the recorded ` +
        `wording of ${target.address}. "Addressed" is not "resolved": decide for yourself ` +
        `whether the question is answered.`,
    );

    // Deliberately abandoned: a real session, bound to a real attempt, never prompted
    // and never settled. This is what a process dying mid-attempt leaves behind.
    const abandoned = yield* openWorkerSession(
      {
        targetId: TARGET_ID,
        goalId: GOAL_ID,
        goal: GOAL,
        intentId: INTENT_ID,
        question: QUESTION,
        attemptId: ABANDONED_ATTEMPT,
        workerId: "worker-3",
      },
      "bit worker: abandoned mid-attempt (proof)",
    );
    const stillRunning = yield* store.unsettledAttempts();
    line("abandoned attempt", ABANDONED_ATTEMPT);
    line("abandoned session", abandoned.session.id);
    line(
      "left unsettled",
      stillRunning.map((item) => `${item.id}:${item.status}`).join(", ") ||
        "none",
    );
    // Proves the session is real before we walk away from it.
    const live = yield* Effect.result(
      client.sessionStatus(abandoned.session.id),
    );
    line(
      "abandoned session resolves now",
      live._tag === "Success" ? "yes" : `no: ${live.failure.message}`,
    );
    exact(
      "an abandoned attempt is left visible as unsettled, not quietly settled",
      stillRunning.some((item) => item.id === ABANDONED_ATTEMPT),
      stillRunning.map((item) => `${item.id}:${item.status}`).join(", "),
    );

    return { result, abandonedSessionId: abandoned.session.id };
  });

/**
 * Phase 4 — reconciliation after a restart.
 *
 * A new process and a new `opencode serve`, asked about a session a previous process
 * created. Whichever way that lands is a real result: if the new server still knows the
 * session the attempt is left running, and if it does not the attempt becomes
 * `uncertain` — which a later startup will ask about again, since the sweep reads
 * `uncertain` rows too. What must hold either way is that the two settled attempts are not
 * touched, and that nothing concludes "no external effect" from holding no observation.
 */
const phaseFour = (abandonedSessionId: string) =>
  Effect.gen(function* () {
    const store = yield* ObservationStore;

    const before = yield* store.unsettledAttempts();
    const firstBefore = yield* store.loadAttempt(FIRST_ATTEMPT, TARGET_ID);
    const followBefore = yield* store.loadAttempt(FOLLOW_UP_ATTEMPT, TARGET_ID);
    line(
      "unsettled before",
      before.map((item) => `${item.id}:${item.status}`).join(", ") || "none",
    );
    line("abandoned session id", abandonedSessionId);

    const reconciled = yield* reconcileUnsettledAttempts();
    console.log(`\n-- reconciliation (${reconciled.length}) --`);
    for (const entry of reconciled) {
      console.log(`  ${renderReconciliation(entry)}`);
      console.log(`      harness said: ${entry.harnessDetail}`);
    }
    const afterFirstSweep =
      yield* store.recoveriesForAttempt(ABANDONED_ATTEMPT);
    const afterFirstSweepStatus = (yield* store.loadAttempt(
      ABANDONED_ATTEMPT,
      TARGET_ID,
    ))?.status;

    // Idempotence: the same sweep again must not duplicate a record or move a status.
    const repeat = yield* reconcileUnsettledAttempts();
    console.log(`\n-- second sweep (${repeat.length}) --`);
    for (const entry of repeat) {
      console.log(`  ${renderReconciliation(entry)}`);
    }

    const first = yield* store.loadAttempt(FIRST_ATTEMPT, TARGET_ID);
    const follow = yield* store.loadAttempt(FOLLOW_UP_ATTEMPT, TARGET_ID);
    const abandoned = yield* store.loadAttempt(ABANDONED_ATTEMPT, TARGET_ID);
    const records = yield* store.recoveriesForAttempt(ABANDONED_ATTEMPT);

    console.log(`\n-- durable recovery records for the abandoned attempt --`);
    for (const record of records) {
      console.log(
        `  observed=${record.observed_status} -> ${record.resulting_status}` +
          ` (${record.disposition}) fence ${String(record.fence_before)}->${String(record.fence_after)}` +
          ` times=${String(record.times)} observationsHeld=${String(record.observations_at_recovery)}`,
      );
      console.log(`      ${record.detail}`);
    }

    line("first attempt status", first?.status ?? "missing");
    line("follow-up attempt status", follow?.status ?? "missing");
    line("abandoned attempt status", abandoned?.status ?? "missing");
    line("abandoned disposition", abandoned?.recovery_disposition ?? "none");
    line("abandoned fence", abandoned?.write_fence ?? "n/a");

    const entry = reconciled.find(
      (item) => item.attempt.id === ABANDONED_ATTEMPT,
    );

    exact(
      "reconciliation found the abandoned attempt and recorded a disposition",
      entry !== undefined && records.length > 0,
      `${String(records.length)} recovery record(s), observed=${entry?.observed ?? "none"}`,
    );
    exact(
      "the abandoned attempt was not reported as failed on missing evidence",
      abandoned?.status !== "failed",
      `status=${abandoned?.status ?? "missing"}, observations held=${String(records[0]?.observations_at_recovery ?? 0)}`,
    );
    exact(
      "settled attempts were not regressed by reconciliation",
      first?.status === firstBefore?.status &&
        follow?.status === followBefore?.status,
      `first ${firstBefore?.status ?? "missing"}->${first?.status ?? "missing"}, ` +
        `follow-up ${followBefore?.status ?? "missing"}->${follow?.status ?? "missing"}`,
    );
    // What must hold is that repeating a sweep manufactures no history. How `times`
    // moves depends on what the harness said: an attempt left `still_running` or
    // `uncertain` is swept again and the repeat lands on a row — the same one if it
    // decided the same thing, its own if it decided differently — while a settled
    // attempt is final and is not swept a second time at all.
    exact(
      "a repeated sweep records no duplicate row and no new status",
      records.length === afterFirstSweep.length &&
        abandoned?.status === afterFirstSweepStatus,
      `rows after one sweep=${String(afterFirstSweep.length)}, after two=${String(records.length)}, ` +
        `status ${afterFirstSweepStatus ?? "missing"}->${abandoned?.status ?? "missing"}, ` +
        `times=[${records.map((r) => String(r.times)).join(",")}]`,
    );
    if (abandoned?.status === "uncertain") {
      exact(
        "an uncertain attempt had its write authority fenced off",
        (abandoned.write_fence ?? 0) > 0,
        `fence=${String(abandoned.write_fence)}`,
      );
    }

    judge(
      `Phase 4: the abandoned attempt's harness answer was ` +
        `'${entry?.observed ?? "none"}'. If the restarted harness still knew the session, ` +
        `leaving the attempt running is correct and no recovery was needed; if it did ` +
        `not, 'uncertain' is correct and the attempt must NOT be read as "did nothing". ` +
        `Check the detail text above says so.`,
    );

    return { abandoned };
  });

const program = Effect.gen(function* () {
  banner("PHASE 1 — worker leg: real worker, live policy, authenticated MCP");
  const first = yield* Effect.scoped(Effect.provide(phaseOne, layer()));

  banner("PHASE 2 — fresh process, fresh session, briefing only");
  yield* Effect.scoped(Effect.provide(phaseTwo, layer()));

  const target = pickFollowUp(first.openQuestions);
  if (target === undefined) {
    banner("PHASE 3 — SKIPPED");
    console.log(
      "The worker recorded no untested dimensions, so there is no open question to " +
        "address. That is a real outcome of this run, not a passing phase: the follow-up " +
        "mechanism is unproven live here and is covered only by the deterministic tests.",
    );
    exact(
      "phase 3 had a recorded open question to address",
      false,
      "the worker recorded no untested dimensions",
    );
  } else {
    banner("PHASE 3 — follow-up leg: a recorded question, taken on by address");
    const third = yield* Effect.scoped(
      Effect.provide(phaseThree(target), layer()),
    );
    banner("PHASE 4 — restart: reconcile the abandoned attempt");
    yield* Effect.scoped(
      Effect.provide(phaseFour(third.abandonedSessionId), layer()),
    );
  }

  banner("EXACT AUTOMATED CHECKS");
  for (const check of checks) {
    console.log(`  ${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
    console.log(`        ${check.evidence}`);
  }
  const failed = checks.filter((check) => !check.passed);
  console.log(
    `\n${String(checks.length - failed.length)}/${String(checks.length)} exact checks passed.`,
  );

  banner("SEMANTIC CHECKS FOR A HUMAN — not scored, not asserted");
  for (const item of human) console.log(`  - ${item}\n`);

  banner("WHAT THIS RUN DOES NOT ESTABLISH");
  for (const limit of [
    "One worker at a time. Nothing here exercises concurrency, and the same-workspace concurrent MCP hazard is unchanged.",
    "The policy hook gates tool INPUT. A shell command that assembles a forbidden path at runtime still reaches it (§19 checkpoint 5 probe 4); that limit is unchanged and is not re-tested here.",
    "Observation outcomes are the worker's readings of its own bounded tests. Nothing validates them, and nothing here produces a finding.",
    "The fixture is a local simulation. No real target, no evidence capture, no proxy.",
    "The policy route is unauthenticated loopback, and its URL is readable by the worker in its own workspace config.",
  ]) {
    console.log(`  - ${limit}`);
  }

  return failed.length === 0;
});

runMain(
  Effect.scoped(
    program.pipe(
      Effect.tap((passed) =>
        Effect.sync(() => {
          console.log(
            `\nmilestone proof: ${passed ? "all exact checks passed" : "SOME EXACT CHECKS FAILED"}`,
          );
        }),
      ),
    ),
  ),
);
