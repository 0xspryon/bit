/**
 * The two halves of the single-worker loop, as functions rather than as scripts.
 *
 * `workerDemo.ts` and `briefingDemo.ts` drive the same code (as `milestoneProof.ts` did,
 * until it went with the policy gate it proved, 2026-11-06)
 * from here. That is the point: a proof that re-implemented the worker leg would be
 * proving its own copy, and the three entrypoints would drift until the demo and the
 * proof disagreed about what the system does.
 *
 * Each phase returns what it observed rather than printing it, so a caller can assert on
 * it. Everything a phase reads is read from the control plane or the database — the
 * harness's own view of the session, our MCP call counter, the fixture's own traffic
 * counters, the stored rows — and never
 * from the model's account of what it did.
 */
import type { Observation, OpenQuestion } from "@bit/contracts";
import { Effect, Redacted } from "effect";

import { buildBriefing, renderBriefing } from "../briefing/briefing";
import { FixtureEndpoint } from "../fixture/server";
import {
  AgentHarness,
  finalAssistantText,
  firstError,
} from "../harness/agentHarness";
import { OpenCodeServer } from "../harness/openCodeServer";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { ObservationStore, type AttemptSettlement } from "../persistence/store";
import { plannerPrompt } from "./prompts";
import {
  openWorkerSession,
  SpikePaths,
  WORKER_MODEL,
  type AttemptBinding,
} from "./runtime";

export interface WorkerPhaseInput {
  readonly binding: AttemptBinding;
  readonly title: string;
  /** The prompt text. Built by `prompts.ts`; never contains a credential. */
  readonly task: string;
}

export interface WorkerPhaseResult {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly harnessVersion: string;
  readonly fixtureUrl: string;
  /** Liveness, from the same origin that serves MCP. */
  readonly health: { readonly status: number; readonly body: string };
  readonly writeFence: number;
  /** Authenticated MCP requests this endpoint served during the phase. */
  readonly mcpCallsServed: number;
  readonly sessionOutcome: string;
  /** True when our `wait` call failed, which makes the outcome uncertain, not failed. */
  readonly waitFailed: boolean;
  readonly settlement: AttemptSettlement;
  readonly observations: readonly Observation[];
  readonly openQuestions: readonly OpenQuestion[];
  readonly fixtureTraffic: unknown;
  readonly finalMessage: string;
  readonly harnessError: string | undefined;
  readonly credentialRevoked: boolean;
  readonly liveCredentials: number;
  readonly harnessStderrTail: readonly string[];
}

const probe = (url: string) =>
  Effect.result(
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, { signal });
        return {
          status: response.status,
          body: (await response.text()).trim(),
        };
      },
      catch: (cause) => cause,
    }),
  ).pipe(
    Effect.map((result) =>
      result._tag === "Success"
        ? result.success
        : { status: 0, body: `unreachable: ${String(result.failure)}` },
    ),
  );

/**
 * One worker attempt, start to settlement.
 *
 * The sequence is the one that has to hold: seed the attempt, create the session, mint a
 * credential bound to it, register our MCP endpoint carrying that credential in a request
 * body, prompt, wait, reconcile the wait's own failure against the harness's view, settle,
 * revoke.
 *
 * A failed `wait` is not a failed attempt. It means our long poll lost its answer, and
 * the attempt's status is then taken from the harness's own session state or recorded as
 * `uncertain` — never inferred, and the prompt is never resubmitted (DECISIONS.md §15).
 */
export const runWorkerPhase = Effect.fn("runWorkerPhase")(function* (
  input: WorkerPhaseInput,
) {
  const store = yield* ObservationStore;
  const { server, diagnostics } = yield* OpenCodeServer;
  const client = yield* AgentHarness;
  const fixture = yield* FixtureEndpoint;
  const control = yield* ControlPlaneEndpoint;
  const credentials = yield* McpCredentials;

  const health = yield* probe(control.healthUrl);
  const callsBefore = yield* control.callCount;

  const { session, credential, authority } = yield* openWorkerSession(
    input.binding,
    input.title,
  );

  yield* client.prompt(session.id, input.task);

  const waited = yield* Effect.result(client.waitForIdle(session.id));
  const status = yield* client.sessionStatus(session.id);
  const entries = yield* client.messages(session.id);

  const settlement = yield* store.settleAttempt(
    input.binding.attemptId,
    waited._tag === "Failure" && status.outcome === undefined
      ? "uncertain"
      : status.outcome === "succeeded"
        ? "succeeded"
        : status.outcome === "interrupted"
          ? "interrupted"
          : "failed",
  );

  // Revoked here as well as by the scope finalizer, so the "a later call fails closed"
  // claim is checked on the happy path too rather than only argued.
  yield* credentials.revoke(credential.token);
  const stillResolves =
    (yield* credentials.resolve(Redacted.value(credential.token))) !==
    undefined;

  const observations = yield* store.observationsForIntent(
    input.binding.intentId,
  );
  const briefing = yield* buildBriefing(input.binding.intentId);
  const seen = yield* diagnostics;

  return {
    attemptId: input.binding.attemptId,
    sessionId: session.id,
    harnessVersion: server.version,
    fixtureUrl: fixture.url,
    health,
    writeFence: authority.writeFence,
    mcpCallsServed: (yield* control.callCount) - callsBefore,
    sessionOutcome: status.outcome ?? "unknown",
    waitFailed: waited._tag === "Failure",
    settlement,
    observations,
    openQuestions: briefing.openQuestions,
    fixtureTraffic: fixture.fixture.state(),
    finalMessage: finalAssistantText(entries).trim(),
    harnessError: firstError(entries),
    credentialRevoked: !stillResolves,
    liveCredentials: yield* credentials.size,
    harnessStderrTail: seen.stderr.slice(-10),
  } satisfies WorkerPhaseResult;
});

export interface PlannerPhaseResult {
  readonly sessionId: string;
  /** The session this round was opened under, which is its provider cache key. */
  readonly lineageSessionId: string;
  /** False when this round had to open the lineage, true when it joined one. */
  readonly lineageReused: boolean;
  readonly briefing: string;
  readonly preparedAtSequence: number;
  readonly answer: string;
  readonly outcome: string;
  readonly waitFailed: boolean;
  readonly harnessError: string | undefined;
  /** Observation IDs it quoted that really exist in the database. */
  readonly citedObservationIds: readonly string[];
  /** Open-question addresses it quoted that really exist. */
  readonly citedAddresses: readonly string[];
  /**
   * Address-shaped strings in its answer that do **not** exist.
   *
   * Reported rather than ignored: an invented address is the failure mode the
   * exact-address rule exists to catch, and it would be refused at the write boundary.
   */
  readonly inventedAddresses: readonly string[];
  readonly sections: readonly string[];
  readonly openQuestions: readonly OpenQuestion[];
  readonly observationIds: readonly string[];
}

/** Address-shaped tokens, so an invented one can be told from a real one. */
const ADDRESS_PATTERN = /obs_[0-9]+_[A-Za-z0-9_-]+#u[0-9]+/g;

const SECTION_MARKERS = [
  "NEXT:",
  "CITES:",
  "GAP:",
  "ADDRESSES:",
  "WHY:",
] as const;

/**
 * The session this **goal**'s planner rounds are opened under, opening one if needed.
 *
 * Keyed by goal since migration `0019`: one planner works one goal, which is what the
 * lineage table now records. Every round is still a fresh session with no transcript —
 * this only decides whose lineage it joins, and a lineage is what OpenCode turns into a
 * provider cache key. The anchor session is created and never prompted, so there is
 * nothing in it for a round to inherit even in principle.
 *
 * A recorded lineage is confirmed before it is used, because it names a session in
 * OpenCode's storage rather than a row in ours: a cleared harness leaves our row
 * pointing at nothing, and a parent that does not exist is not something to hand to
 * `session.create`. An unconfirmable lineage is replaced, which costs one uncached round
 * and is invisible to the investigation either way.
 */
const plannerLineage = Effect.fnUntraced(function* (goalId: string) {
  const store = yield* ObservationStore;
  const client = yield* AgentHarness;
  const paths = yield* SpikePaths;

  const recorded = yield* store.plannerLineage(goalId);
  if (recorded !== undefined) {
    const confirmed = yield* Effect.result(client.sessionStatus(recorded));
    if (confirmed._tag === "Success") {
      return { sessionId: recorded, reused: true };
    }
  }

  const anchor = yield* client.createSession({
    title: `bit planner lineage: ${goalId}`,
    model: WORKER_MODEL,
    directory: paths.workspace,
  });
  yield* store.recordPlannerLineage(goalId, anchor.id);
  return { sessionId: anchor.id, reused: false };
});

/**
 * A fresh session reading a database-derived briefing and choosing what comes next.
 *
 * It gets the rendered briefing and nothing else: no transcript, no summary written by
 * the worker, no list of candidate follow-ups. What is checked here is only what can be
 * checked exactly — that it finished, that the IDs and addresses it quoted exist in our
 * database, and that it answered every section. Whether its proposal is *sensible* is a
 * judgement for a human reading the printed answer, and is deliberately not scored.
 */
export const runPlannerPhase = Effect.fn("runPlannerPhase")(function* (
  intentId: string,
) {
  const store = yield* ObservationStore;
  const client = yield* AgentHarness;
  const paths = yield* SpikePaths;

  const briefing = yield* buildBriefing(intentId);
  const rendered = renderBriefing(briefing);
  const stored = yield* store.observationsForIntent(intentId);

  // The goal is read from the intent rather than taken from the briefing, which carries a
  // target and not a goal: migration `0019` keys a lineage by goal, and passing a target
  // id here would record one goal's session under another's key.
  const intent = yield* store.intent(intentId);
  if (intent === undefined) {
    return yield* Effect.die(
      new Error(
        `intent ${intentId} has no row, so it has no goal to plan under`,
      ),
    );
  }
  const lineage = yield* plannerLineage(intent.goalId);
  const session = yield* client.createSession({
    title: "bit planner: fresh session",
    model: WORKER_MODEL,
    directory: paths.workspace,
    parentSessionId: lineage.sessionId,
  });
  yield* client.prompt(session.id, plannerPrompt({ briefing: rendered }));
  const waited = yield* Effect.result(client.waitForIdle(session.id));
  const status = yield* client.sessionStatus(session.id);
  const entries = yield* client.messages(session.id);
  const answer = finalAssistantText(entries).trim();

  const known = new Set(briefing.openQuestions.map((item) => item.address));
  const quoted = [...new Set(answer.match(ADDRESS_PATTERN) ?? [])];

  return {
    sessionId: session.id,
    lineageSessionId: lineage.sessionId,
    lineageReused: lineage.reused,
    briefing: rendered,
    preparedAtSequence: briefing.preparedAtSequence,
    answer,
    outcome: status.outcome ?? "unknown",
    waitFailed: waited._tag === "Failure",
    harnessError: firstError(entries),
    citedObservationIds: stored
      .map((item) => item.observationId)
      .filter((id) => answer.includes(id)),
    citedAddresses: quoted.filter((address) => known.has(address)),
    inventedAddresses: quoted.filter((address) => !known.has(address)),
    sections: SECTION_MARKERS.filter((marker) => answer.includes(marker)),
    openQuestions: briefing.openQuestions,
    observationIds: stored.map((item) => item.observationId),
  } satisfies PlannerPhaseResult;
});

/**
 * Prints what actually landed in the database.
 *
 * The two record formats are reported differently on purpose: a summary row has one
 * prose identity and one total request count, and printing it under the same headings as
 * a case-based row would misrepresent it.
 */
export const reportObservations = (result: WorkerPhaseResult): void => {
  console.log(`\n-- durable observations (${result.observations.length}) --`);
  for (const observation of result.observations) {
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
      `  provenance:     attempt=${observation.provenance.attemptId} session=${observation.provenance.harnessSessionId}`,
    );
    console.log(lines.join("\n"));
  }

  const outcomes = result.observations.map((item) => item.outcome);
  console.log(
    `\noutcome mix: ${JSON.stringify({
      positive: outcomes.filter((o) => o === "positive").length,
      negative: outcomes.filter((o) => o === "negative").length,
      inconclusive: outcomes.filter((o) => o === "inconclusive").length,
    })}`,
  );
  console.log(
    `record formats: ${JSON.stringify({
      caseBased: result.observations.filter((o) => o._tag === "caseBased")
        .length,
      summary: result.observations.filter((o) => o._tag === "summary").length,
    })}`,
  );

  console.log(
    `\n-- open questions now addressable (${result.openQuestions.length}) --`,
  );
  for (const question of result.openQuestions) {
    console.log(
      `  [${question.status}] ${question.address}  ${question.dimension}`,
    );
  }
};

/**
 * The fixture binds to a free port, so its URL is only known once it is listening: the
 * prompt is built inside the layer's scope rather than at module level.
 */
