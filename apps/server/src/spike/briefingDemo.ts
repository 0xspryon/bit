/**
 * Sprint 1 checkpoint 4: does the durable knowledge actually serve a fresh session?
 *
 * Run `workerDemo.ts` first, then `bun run src/spike/briefingDemo.ts` from
 * `apps/server`. This process reopens the same SQLite file, renders a briefing purely
 * from stored rows, and hands it to a brand new OpenCode session.
 *
 * What makes this a real test rather than a parroting exercise:
 * - The briefing is built by `buildBriefing` from database rows. No part of the first
 *   session's transcript, and no summary written by it, is available here.
 * - The fresh session is a new OpenCode session on a new server process. It shares no
 *   context with the worker.
 * - It is not given a list of candidate follow-ups. It must read the observations and
 *   name its own next step, citing the observation IDs, the gap it closes, and the
 *   **exact address** of that gap.
 * Nothing may import this module: `runMain` runs at module scope. Reusable code lives in
 * `phases.ts`.
 *
 * - We then check its answer against what the *database* holds: the IDs and addresses it
 *   quoted either exist or do not, and an invented address is reported rather than
 *   quietly tolerated.
 */
import { Effect } from "effect";

import { runMain } from "./main";
import { runPlannerPhase } from "./phases";
import { spikeLayer } from "./runtime";

const INTENT_ID = "intent-per-client-limiter";

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

const program = Effect.gen(function* () {
  const result = yield* runPlannerPhase(INTENT_ID);
  if (result.observationIds.length === 0) {
    console.log("No observations found. Run workerDemo.ts first.");
    return "no-data" as const;
  }

  line("observations in db", result.observationIds.length);
  line("prepared at sequence", result.preparedAtSequence);
  line("briefing chars", result.briefing.length);
  line("open questions", result.openQuestions.length);

  console.log("\n-- briefing handed to the fresh session --");
  console.log(result.briefing);

  line("\nfresh session id", result.sessionId);
  // The lineage is a cache routing fact, not a context one: the round is still a fresh
  // session, and this says whose cache partition it was routed into.
  line(
    "cache lineage",
    `${result.lineageSessionId} (${result.lineageReused ? "reused" : "opened now"})`,
  );
  line("session outcome", result.outcome);
  if (result.harnessError !== undefined) {
    line("harness error", result.harnessError);
  }

  console.log("\n-- fresh session's chosen follow-up --");
  console.log(result.answer || "(none)");

  console.log("\n-- checks against database state --");
  line(
    "cites stored obs ids",
    result.citedObservationIds.length > 0
      ? result.citedObservationIds.join(", ")
      : "NONE",
  );
  line(
    "cites real addresses",
    result.citedAddresses.length > 0
      ? result.citedAddresses.join(", ")
      : "NONE",
  );
  line(
    "invented addresses",
    result.inventedAddresses.length > 0
      ? result.inventedAddresses.join(", ")
      : "none",
  );
  line("answered sections", `${result.sections.length}/5`);

  console.log("\n-- open questions, as the control plane holds them --");
  for (const question of result.openQuestions) {
    console.log(`  [${question.status}] ${question.address}`);
    console.log(`      ${question.dimension}`);
    for (const addresser of question.addressedBy) {
      console.log(
        `      addressed by ${addresser.observationId} (${addresser.outcome})`,
      );
    }
  }

  /**
   * Exactly checkable: the session finished, it cited observation IDs and an address
   * that exist in our database and were never given to it except through the rendered
   * briefing, it invented no address, and it answered in full. Whether its proposed
   * follow-up is *sensible* is a judgement left to the printed output above.
   */
  const passed =
    result.outcome === "succeeded" &&
    result.citedObservationIds.length > 0 &&
    result.citedAddresses.length > 0 &&
    result.inventedAddresses.length === 0 &&
    result.sections.length === 5;
  console.log(
    `\ncheckpoint 4: ${passed ? "PASSED" : "NOT PROVEN"} — a fresh session consumed a ` +
      `database-derived briefing and answered in full, citing stored observation IDs ` +
      `and a real open-question address. Read the proposal above to judge whether the ` +
      `follow-up is sensible.`,
  );
  return passed ? ("passed" as const) : ("not-proven" as const);
});

runMain(
  Effect.scoped(
    program.pipe(
      Effect.provide(spikeLayer()),
      Effect.tap((result) =>
        Effect.sync(() => {
          console.log(`\nresult: ${result}`);
        }),
      ),
    ),
  ),
);
