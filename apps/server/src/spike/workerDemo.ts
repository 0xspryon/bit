/**
 * Sprint 1 checkpoints 1-3, end to end against a real subscription-authenticated
 * OpenCode worker.
 *
 * Run with `bun run src/spike/workerDemo.ts` from `apps/server`. It prints a provenance
 * report and leaves durable observations behind for the briefing demo.
 *
 * What this proves, and nothing more:
 * 1. We spawn `opencode serve`, create a host-controlled session, submit a task and
 *    read its terminal status.
 * 2. The worker investigates the local fixture inside a bounded request budget. (Until
 *    2026-11-06 with the pre-execution policy hook loaded; the gate was removed at the
 *    operator's request.)
 * 3. It records observations through our own MCP tool, authenticated and bound to the
 *    attempt, which survive in SQLite.
 *
 * The work itself is {@link runWorkerPhase}; this file is the binding, the boundaries and
 * the printing.
 *
 * **Nothing may import this module.** `runMain` is called at module scope, so an import
 * *runs the demo* — which is how a first attempt at `milestoneProof.ts` silently ran a
 * worker against the development database instead of its own. Everything reusable lives
 * in `phases.ts`, which has no top-level effects; the same rule applies to every other
 * entrypoint in this directory.
 *
 * Lifetime: the whole program runs in one `Effect.scoped` region under {@link runMain}.
 * The harness process, the control-plane listener, the fixture, the database connection
 * and the worker's credential all come down together on success, on failure, and on
 * Ctrl-C.
 */
import { Effect } from "effect";

import { FixtureEndpoint } from "../fixture/server";
import { runMain } from "./main";
import { reportObservations, runWorkerPhase } from "./phases";
import { workerPrompt } from "./prompts";
import { spikeLayer, WORKER_MODEL } from "./runtime";

const BINDING = {
  targetId: "fixture-local",
  goalId: "goal-ratelimit",
  goal: "Determine whether authentication rate limits on the fixture can be bypassed, and with what impact.",
  intentId: "intent-per-client-limiter",
  question:
    "Probe the per-client request limiter on POST /login; leave any per-account limit untested.",
  attemptId: `attempt-${Date.now()}`,
  workerId: "worker-1",
} as const;

const REQUEST_BUDGET = 60;
const ACCOUNT = "alice";

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

const program = Effect.gen(function* () {
  const fixture = yield* FixtureEndpoint;
  const result = yield* runWorkerPhase({
    binding: BINDING,
    title: "bit worker: per-client limiter",
    task: workerPrompt({
      fixtureUrl: fixture.url,
      account: ACCOUNT,
      requestBudget: REQUEST_BUDGET,
      toolName: "record_observation",
    }),
  });

  line("opencode version", result.harnessVersion);
  line("health route", `${String(result.health.status)} ${result.health.body}`);
  line("fixture url", result.fixtureUrl);
  line("model", WORKER_MODEL);
  line("session id", result.sessionId);
  line("attempt id", result.attemptId);
  line("write fence", result.writeFence);
  line("session outcome", result.sessionOutcome);
  line("wait call failed", result.waitFailed);
  line("attempt settled as", result.settlement.effective ?? "no such attempt");
  line("settlement changed it", result.settlement.changed);
  line("mcp requests served", result.mcpCallsServed);
  line("credential revoked", result.credentialRevoked);
  line("live credentials", result.liveCredentials);
  if (result.harnessError !== undefined) {
    line("harness error", result.harnessError);
  }

  console.log("\n-- worker final message --");
  console.log(result.finalMessage || "(none)");

  console.log("\n-- fixture traffic actually seen --");
  console.log(JSON.stringify(result.fixtureTraffic, null, 2));

  reportObservations(result);

  if (result.harnessStderrTail.length > 0) {
    console.log("\n-- harness stderr (bounded tail) --");
    console.log(result.harnessStderrTail.join("\n"));
  }
  return result.settlement.effective ?? "unknown";
});

runMain(
  Effect.scoped(
    program.pipe(
      Effect.provide(spikeLayer()),
      Effect.tap((status) =>
        Effect.sync(() => {
          console.log(`\nattempt terminal status: ${status}`);
        }),
      ),
    ),
  ),
);
