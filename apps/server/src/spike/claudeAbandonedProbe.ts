/**
 * Claude Code's `abandoned` answer, against a real transcript.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/claudeAbandonedProbe.ts
 * bun run src/spike/claudeAbandonedProbe.ts --model claude-sonnet-5
 * ```
 *
 * ## What it does, and why no restart is needed
 *
 * S7's live demonstration found that nothing on this driver was continued after a restart:
 * `sessionStatus` *failed* for any session the process did not hold, so recovery answered
 * `missing` or `unreachable` — both refusals. The condition is "this process does not hold
 * the session", and on this driver that does not need a new process: the live `Query`
 * handles live in a `Map` built with the harness layer, so a **second harness layer** in
 * the same process holds none of the first one's sessions while the CLI's transcript stays
 * on disk. That is the same state a restart leaves, reached without one.
 *
 * So: build one harness, open a session, send one cheap turn so a transcript really
 * exists, let it finish. Then build a *fresh* harness and ask it the three questions in
 * order — the seam, recovery's vocabulary, and the continuation decision.
 *
 * It costs one short model call. `--model` is honoured; the default is the driver's own.
 *
 * **Nothing may import this module.** `runMain` is called at module scope.
 */
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { AgentHarness } from "../harness/agentHarness";
import {
  CLAUDE_CODE_DEFAULT_MODEL,
  claudeCodeHarness,
} from "../harness/claudeCodeClient";
import { HarnessResolver } from "../harness/resolver";
import { continuationTrigger } from "../recovery/continuation";
import { HarnessSessionStatus } from "../recovery/harnessStatus";
import { runMain } from "./main";
import { prepareWorkspace, RUNTIME_DIR } from "./runtime";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const MODEL = argument("model") ?? CLAUDE_CODE_DEFAULT_MODEL;
const WORKSPACE = join(RUNTIME_DIR, "claude-abandoned-probe");

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

const program = Effect.gen(function* () {
  yield* prepareWorkspace({ workspace: WORKSPACE, files: {} });
  line("model", MODEL);

  /* ── Harness A: a session with a real transcript ───────────────────────────── */
  const sessionId = yield* Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* AgentHarness;
      const session = yield* harness.createSession({
        title: "bit claude abandoned probe",
        model: MODEL,
        directory: WORKSPACE,
      });
      line("session", session.id);
      yield* harness.prompt(session.id, "Reply with exactly the word: one.");
      yield* harness.waitForIdle(session.id);
      const held = yield* Effect.result(harness.sessionStatus(session.id));
      line(
        "status while held (A)",
        held._tag === "Success"
          ? JSON.stringify(held.success)
          : `could not ask: ${held.failure.message}`,
      );
      return session.id;
    }).pipe(Effect.provide(claudeCodeHarness({ defaultModel: MODEL }))),
  );
  line("harness A closed", "its query map is gone; the transcript is not");

  /* ── Harness B: a process that holds nothing ───────────────────────────────── */
  yield* Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* AgentHarness;
      const asked = yield* Effect.result(harness.sessionStatus(sessionId));
      console.log("\n-- what sessionStatus answers --");
      line(
        "sessionStatus",
        asked._tag === "Success"
          ? JSON.stringify(asked.success)
          : `failed: ${asked.failure.message}`,
      );

      const report = yield* Effect.provide(
        Effect.flatMap(HarnessSessionStatus, (service) =>
          service.of(sessionId, harness.instance.instanceId),
        ),
        HarnessSessionStatus.layer.pipe(
          Layer.provide(HarnessResolver.fromHarnesses([harness])),
        ),
      );
      console.log("\n-- what recovery concludes --");
      line("observed", report.observed);
      line("detail", report.detail);
      line("trigger", continuationTrigger(report.observed, "…")._tag);

      // An id nothing has ever heard of, for the distinction the fix had to keep: a
      // session with a transcript is `abandoned`, one without is `missing`, and only the
      // first asserts the conversation is still there.
      const unknown = yield* Effect.provide(
        Effect.flatMap(HarnessSessionStatus, (service) =>
          service.of(
            "11111111-0000-4000-8000-000000000099",
            harness.instance.instanceId,
          ),
        ),
        HarnessSessionStatus.layer.pipe(
          Layer.provide(HarnessResolver.fromHarnesses([harness])),
        ),
      );
      console.log("\n-- an id nobody has, for contrast --");
      line("observed", unknown.observed);

      console.log("\n-- and the conversation itself --");
      const continuation = yield* Effect.result(
        harness.sessionContinuation(sessionId),
      );
      line(
        "sessionContinuation",
        continuation._tag === "Success"
          ? continuation.success._tag
          : `failed: ${continuation.failure.message}`,
      );
      const messages = yield* Effect.result(harness.messages(sessionId));
      line(
        "messages readable",
        messages._tag === "Success" ? messages.success.length : "failed",
      );
    }).pipe(Effect.provide(claudeCodeHarness({ defaultModel: MODEL }))),
  );
});

runMain(program);
