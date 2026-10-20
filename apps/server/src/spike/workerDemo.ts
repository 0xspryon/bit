/**
 * Sprint 1 checkpoints 1-3, end to end against a real subscription-authenticated
 * OpenCode worker.
 *
 * Run with `bun run src/spike/workerDemo.ts` from `apps/server`. It prints a
 * provenance report and leaves durable observations behind for the briefing demo.
 *
 * What this proves, and nothing more:
 * 1. We spawn `opencode serve`, create a host-controlled session, submit a task and
 *    read its terminal status.
 * 2. The worker investigates the local fixture inside a bounded request budget.
 * 3. It records observations through our own MCP tool, authenticated and bound to the
 *    attempt, which survive in SQLite.
 *
 * Lifetime: the whole program runs in one `Effect.scoped` region under
 * {@link runMain}. The harness process, the MCP endpoint, the fixture, the database
 * connection and the worker's credential all come down together on success, on
 * failure, and on Ctrl-C.
 */
import { Effect, Redacted } from "effect";

import {
  finalAssistantText,
  firstError,
  OpenCodeClient,
} from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { FixtureEndpoint } from "../fixture/server";
import { McpCredentials } from "../mcp/credentials";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { ObservationStore, type AttemptStatus } from "../persistence/store";
import { runMain } from "./main";
import { workerPrompt } from "./prompts";
import { openWorkerSession, spikeLayer, WORKER_MODEL } from "./runtime";

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

/**
 * Prints what actually landed in the database.
 *
 * The two record formats are reported differently on purpose: a summary row has one
 * prose identity and one total request count, and printing it under the same headings as
 * a case-based row would misrepresent it.
 */
const report = Effect.fn("report")(function* () {
  const store = yield* ObservationStore;
  const observations = yield* store.observationsForIntent(BINDING.intentId);
  console.log(`\n-- durable observations (${observations.length}) --`);
  for (const observation of observations) {
    const lines = [
      ``,
      `${observation.observationId}  seq=${observation.sequence}  outcome=${observation.outcome}`,
      `  claim:          ${observation.testedClaim}`,
    ];
    if (observation._tag === "caseBased") {
      lines.push(`  setup:          ${observation.setup}`);
      for (const testCase of observation.cases) {
        lines.push(
          `  case ${testCase.id}: ${testCase.purpose}`,
          `    actors:       ${testCase.actors
            .map(
              (actor) =>
                `${actor.id}(account=${actor.account ?? "none"}, ${actor.clientIdentity})`,
            )
            .join(" | ")}`,
        );
        testCase.actions.forEach((action, index) => {
          lines.push(
            `    ${index + 1}. [${action.actorId}] ${action.method} ${action.endpoint}` +
              ` x${action.requestCount} -> ${action.observedBehavior}`,
          );
        });
      }
    } else {
      lines.push(
        `  format:         SUMMARY (one prose record, not case-based)`,
        `  client identity:${observation.conditions.clientIdentity}`,
        `  requests total: ${observation.conditions.requestCount}`,
        `  observed:       ${observation.observedBehavior}`,
      );
    }
    lines.push(
      `  interpretation: ${observation.interpretation}`,
      `  limitations:    ${observation.limitations.join("; ")}`,
      `  untested:       ${observation.untestedDimensions.join("; ")}`,
      `  provenance:     attempt=${observation.provenance.attemptId} session=${observation.provenance.harnessSessionId}`,
    );
    console.log(lines.join("\n"));
  }
  const outcomes = observations.map((item) => item.outcome);
  console.log(
    `\noutcome mix: ${JSON.stringify({
      positive: outcomes.filter((o) => o === "positive").length,
      negative: outcomes.filter((o) => o === "negative").length,
      inconclusive: outcomes.filter((o) => o === "inconclusive").length,
    })}`,
  );
  console.log(
    `record formats: ${JSON.stringify({
      caseBased: observations.filter((o) => o._tag === "caseBased").length,
      summary: observations.filter((o) => o._tag === "summary").length,
    })}`,
  );
});

const program = Effect.gen(function* () {
  const store = yield* ObservationStore;

  const { server, diagnostics } = yield* OpenCodeServer;
  const client = yield* OpenCodeClient;
  const fixture = yield* FixtureEndpoint;
  const mcp = yield* ControlPlaneEndpoint;
  const credentials = yield* McpCredentials;

  line("opencode version", server.version);
  line("harness base url", server.baseUrl);
  line("fixture url", fixture.url);
  line("fixture limits", JSON.stringify(fixture.fixture.limits));
  line("mcp url", mcp.mcpUrl);
  line("model", `${WORKER_MODEL.providerID}/${WORKER_MODEL.id}`);

  const { session, credential } = yield* openWorkerSession(
    BINDING,
    "bit worker: per-client limiter",
  );
  line("session id", session.id);
  line("attempt id", BINDING.attemptId);
  // Prove the credential is bound to this session, without printing the token.
  line("credential bound to", credential.grant.harnessSessionId);
  line("credential scope", credential.grant.callerScope);
  line("live credentials", yield* credentials.size);

  console.log("\n-- submitting task --");
  yield* client.prompt(
    session.id,
    workerPrompt({
      fixtureUrl: fixture.url,
      account: ACCOUNT,
      requestBudget: REQUEST_BUDGET,
      toolName: "record_observation",
    }),
  );

  /**
   * A failed wait means the outcome is uncertain, not that execution stopped. We
   * reconcile against the harness's own session state rather than inferring
   * (DECISIONS.md §15 "Recovery"), and we never resubmit the prompt.
   */
  const waited = yield* Effect.result(client.waitForIdle(session.id));
  if (waited._tag === "Failure") {
    console.log(`wait failed: ${waited.failure.message}`);
    console.log(
      "outcome is UNCERTAIN; reconciling against harness state instead",
    );
  }

  const status = yield* client.sessionStatus(session.id);
  const entries = yield* client.messages(session.id);
  const failure = firstError(entries);

  console.log("\n-- terminal status --");
  line("session outcome", status.outcome ?? "unknown");
  line("cost (usd)", status.cost ?? 0);
  line("tokens", JSON.stringify(status.tokens));
  if (failure !== undefined) line("harness error", failure);

  const attemptStatus: AttemptStatus =
    waited._tag === "Failure" && status.outcome === undefined
      ? "uncertain"
      : status.outcome === "succeeded"
        ? "succeeded"
        : status.outcome === "interrupted"
          ? "interrupted"
          : "failed";
  yield* store.settleAttempt(BINDING.attemptId, attemptStatus);
  line("attempt settled as", attemptStatus);

  console.log("\n-- worker final message --");
  console.log(finalAssistantText(entries).trim() || "(none)");

  console.log("\n-- fixture traffic actually seen --");
  console.log(JSON.stringify(fixture.fixture.state(), null, 2));
  line("mcp requests served", yield* mcp.callCount);

  /**
   * Revoke early and prove it, which is the checkpoint-3 claim: a later call on this
   * token fails closed. The scope finalizer would do this anyway — and does, on the
   * failure and interruption paths that never reach this line — so `revoke` is
   * idempotent by design rather than by luck.
   */
  yield* credentials.revoke(credential.token);
  line(
    "credential revoked",
    (yield* credentials.resolve(Redacted.value(credential.token))) ===
      undefined,
  );
  line("live credentials", yield* credentials.size);

  const seen = yield* diagnostics;
  if (seen.stderr.length > 0) {
    console.log("\n-- harness stderr (bounded tail) --");
    console.log(seen.stderr.slice(-10).join("\n"));
  }

  yield* report();
  return attemptStatus;
});

/**
 * The credential is revoked by the scope that issued it, so nothing here has to
 * remember to do it — including on the paths where remembering would be hardest.
 */
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
