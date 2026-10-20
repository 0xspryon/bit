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
 *   name its own next step, citing the observation IDs and the gap it closes.
 * - We then check its answer against the untested dimensions the *database* holds,
 *   which it was never told to target.
 */
import { Effect } from "effect";

import { buildBriefing, renderBriefing } from "../briefing/briefing";
import {
  finalAssistantText,
  firstError,
  OpenCodeClient,
} from "../harness/openCodeClient";
import { ObservationStore } from "../persistence/store";
import { runMain } from "./main";
import { plannerPrompt } from "./prompts";
import { spikeLayer, SpikePaths, WORKER_MODEL } from "./runtime";

const INTENT_ID = "intent-per-client-limiter";

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

const program = Effect.gen(function* () {
  const store = yield* ObservationStore;

  const stored = yield* store.observationsForIntent(INTENT_ID);
  if (stored.length === 0) {
    console.log("No observations found. Run workerDemo.ts first.");
    return "no-data" as const;
  }

  const briefing = yield* buildBriefing(INTENT_ID);
  const rendered = renderBriefing(briefing);

  line("observations in db", stored.length);
  line("prepared at sequence", briefing.preparedAtSequence);
  line("briefing truncated", briefing.truncated);
  line("briefing chars", rendered.length);
  line("open questions", briefing.openQuestions.length);

  console.log("\n-- briefing handed to the fresh session --");
  console.log(rendered);

  // A genuinely fresh session: new process, new session, no shared context.
  const client = yield* OpenCodeClient;
  const paths = yield* SpikePaths;
  const session = yield* client.createSession({
    title: "bit planner: fresh session",
    model: WORKER_MODEL,
    directory: paths.workspace,
  });
  line("\nfresh session id", session.id);

  yield* client.prompt(session.id, plannerPrompt({ briefing: rendered }));
  const waited = yield* Effect.result(client.waitForIdle(session.id));
  if (waited._tag === "Failure") {
    console.log(
      "wait failed; outcome UNCERTAIN, reconciling against harness state",
    );
  }

  const status = yield* client.sessionStatus(session.id);
  const entries = yield* client.messages(session.id);
  const answer = finalAssistantText(entries).trim();
  const failure = firstError(entries);

  line("session outcome", status.outcome ?? "unknown");
  if (failure !== undefined) line("harness error", failure);

  console.log("\n-- fresh session's chosen follow-up --");
  console.log(answer || "(none)");

  console.log("\n-- checks against database state --");
  const citedIds = stored
    .map((item) => item.observationId)
    .filter((id) => answer.includes(id));
  line(
    "cites stored obs ids",
    citedIds.length > 0 ? citedIds.join(", ") : "NONE",
  );

  /**
   * Which untested dimension it picks is its own call, so we do not assert semantic
   * alignment automatically — a keyword matcher here produces false positives (it
   * credits a gap the answer only mentions in order to exclude it). Instead we print
   * the recorded dimensions next to the proposal and score lexical overlap as an
   * indicator for a human reader. The automated pass criterion below rests only on
   * things that can be checked exactly.
   */
  const dimensions = [
    ...new Set(stored.flatMap((item) => item.untestedDimensions)),
  ];
  const keywordsOf = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((word) => word.length > 4),
    );
  const answerWords = keywordsOf(answer);
  console.log(
    "\nrecorded untested dimensions, with lexical overlap (indicator only):",
  );
  for (const dimension of dimensions) {
    const words = [...keywordsOf(dimension)];
    const hits = words.filter((word) => answerWords.has(word));
    const score = words.length === 0 ? 0 : hits.length / words.length;
    console.log(`  [${(score * 100).toFixed(0).padStart(3)}%] ${dimension}`);
  }

  const sections = ["NEXT:", "CITES:", "GAP:", "WHY:"].filter((marker) =>
    answer.includes(marker),
  );
  line("answered sections", `${sections.length}/4`);

  /**
   * Exactly checkable: the session finished, and it cited observation IDs that exist
   * in our database and were never given to it except through the rendered briefing.
   * Whether its proposed follow-up is *sensible* is a judgement left to the printed
   * output above, not asserted here.
   */
  const passed =
    status.outcome === "succeeded" &&
    citedIds.length > 0 &&
    sections.length === 4;
  console.log(
    `\ncheckpoint 4: ${passed ? "PASSED" : "NOT PROVEN"} — a fresh session consumed a ` +
      `database-derived briefing and answered in full, citing stored observation IDs. ` +
      `Read the proposal above to judge whether the follow-up is sensible.`,
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
