/**
 * The continuation summary, read off a real harness transcript.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/continuationSummaryProbe.ts --session ses_… --model zai-coding-plan/glm-5.3-flash
 * bun run src/spike/continuationSummaryProbe.ts --session ses_… --instance nothing-configured
 * ```
 *
 * S7.4's first question is how a continued worker is told what the attempt it replaces got
 * to, and the answer this build gives is **mechanically, from the harness's own
 * `messages()`, and non-fatally** (`recovery/continuation.ts`). Everything about that
 * decision is cheap to test except the one thing that matters: what the reduction actually
 * produces from a real conversation, on a real driver, for a session this process did not
 * open. So this spawns an `opencode serve` of its own, asks it about a session id you give
 * it, and prints both the summary and the block a continued worker would receive.
 *
 * It **writes nothing and prompts nothing**: two reads of the harness, no model call, no
 * database. The session can be one left behind by any earlier run — the ids are in
 * `import_sessions`, `goal_sessions` and `attempts`, and `--no-harness` is not offered
 * because a probe with no harness would be asserting against the stub.
 *
 * `--instance` names an instance id to ask *as*, which is how the two failure paths are
 * shown on purpose rather than waited for: an id this process does not configure, and an
 * id that is not a session. Both answer `undefined`, and the block then says the
 * transcript could not be read — which is the whole of "a continuation with no summary is
 * better than no continuation".
 *
 * **Nothing may import this module.** `runMain` is called at module scope.
 */
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  OPENCODE_DEFAULT_MODEL,
  openCodeHarness,
} from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { HarnessResolver } from "../harness/resolver";
import {
  attemptContinuationNote,
  readTranscriptSummary,
} from "../recovery/continuation";
import { runMain } from "./main";
import { prepareWorkspace, RUNTIME_DIR } from "./runtime";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const SESSION = argument("session");
const MODEL = argument("model") ?? OPENCODE_DEFAULT_MODEL;
const INSTANCE = argument("instance");
const WORKSPACE = join(RUNTIME_DIR, "continuation-summary-probe");

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

const program = Effect.gen(function* () {
  if (SESSION === undefined) {
    console.error(
      "give it a session: --session ses_… (any id this installation's harness still holds)",
    );
    return 1;
  }
  const resolver = yield* HarnessResolver;
  line("session", SESSION);
  line("asked as instance", INSTANCE ?? "(this server's default)");

  const summary = yield* readTranscriptSummary({
    resolver,
    harnessSessionId: SESSION,
    harnessInstanceId: INSTANCE ?? null,
  });

  console.log("\n-- the summary, as the reduction produced it --");
  console.log(summary ?? "(none: the transcript could not be read)");

  console.log(
    "\n-- the block a continued worker would be given above its question --",
  );
  console.log(
    attemptContinuationNote({
      replacesAttemptId: "att_the_interrupted_one",
      ...(summary === undefined ? { summary: undefined } : { summary }),
    }),
  );
  return 0;
});

runMain(
  Effect.scoped(
    program.pipe(
      Effect.provide(
        HarnessResolver.single.pipe(
          Layer.provide(
            openCodeHarness({ defaultModel: MODEL }).pipe(
              Layer.provideMerge(OpenCodeServer.layer({ cwd: WORKSPACE })),
              Layer.provide(
                Layer.effectDiscard(
                  prepareWorkspace({ workspace: WORKSPACE, files: {} }),
                ),
              ),
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
        ),
      ),
    ),
  ),
);
