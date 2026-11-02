/**
 * The live reproduction of the stale-outcome defect on a **second** turn, and of its fix.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/secondTurnStatusProbe.ts --model zai-coding-plan/glm-5.3-flash
 * ```
 *
 * ## What it does, and why `restartStatusProbe.ts` could not show this
 *
 * That probe interrupts a session's **first** turn, so the row it leaves behind has no
 * `idle_outcome` at all and the only question is whether "no outcome" reads as `running`.
 * This one sends a turn, **lets it finish**, sends a second, and closes the server's scope
 * while the second is in flight. The row then has turn one's `idle_outcome` on it and
 * turn two's `time_busy` after turn one's `time_idle` — which is exactly what S7's live
 * demonstration found the second time it was run, and the reason the continuation only ever
 * fired for conversations interrupted on their first turn.
 *
 * Printed in four layers, so nothing in the middle can hide a step:
 *
 * 1. `GET /api/session/:id` raw, with `time.busy`, `time.idle` and `outcome` picked out of
 *    it — the three columns the whole argument is about.
 * 2. `AgentHarness.sessionStatus`, which is the seam.
 * 3. `HarnessSessionStatus.of`, which is recovery's own vocabulary.
 * 4. `continuationTrigger`, which is the decision S7b takes and the thing that has to move
 *    from `none` to `owed` for this feature to have widened.
 *
 * It also prints what each layer *would* have said before the fix, computed from the same
 * raw row rather than from memory, so the before and after are one run apart and not one
 * build apart.
 *
 * **It spends a model call**, twice: the first turn has to really complete. `--model` is
 * worth passing — the default is the free OpenCode plan entry, which is slow enough that
 * the first turn's wait can be long.
 *
 * **Nothing may import this module.** `runMain` is called at module scope.
 */
import { join } from "node:path";

import { Effect, Layer, Redacted, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { AgentHarness } from "../harness/agentHarness";
import {
  newOpenCodeSessionId,
  openCodeHarness,
} from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { HarnessResolver } from "../harness/resolver";
import { continuationTrigger } from "../recovery/continuation";
import { HarnessSessionStatus } from "../recovery/harnessStatus";
import { runMain } from "./main";
import { prepareWorkspace, RUNTIME_DIR } from "./runtime";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const MODEL = argument("model") ?? "opencode/glm-5.3-flash-free";
const WORKSPACE = join(RUNTIME_DIR, "second-turn-status-probe");

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(26)} ${String(value)}`);

/** One server, built into its own scope so it can be closed on command. */
const serverIn = (scope: Scope.Scope) =>
  Layer.buildWithScope(
    openCodeHarness({ defaultModel: MODEL }).pipe(
      Layer.provideMerge(OpenCodeServer.layer({ cwd: WORKSPACE })),
      Layer.provide(FetchHttpClient.layer),
    ),
    scope,
  );

/** The row straight off the wire, so nothing in our own decode can hide a field. */
const raw = Effect.fn("raw")(function* (
  server: {
    readonly baseUrl: string;
    readonly authorization: Redacted.Redacted;
  },
  path: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(`${server.baseUrl}${path}`).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        Redacted.value(server.authorization),
      ),
    ),
  );
  return yield* response.text;
});

const program = Effect.gen(function* () {
  yield* prepareWorkspace({ workspace: WORKSPACE, files: {} });
  const sessionId = newOpenCodeSessionId();
  line("model", MODEL);
  line("session", sessionId);

  /* ── Server A: one completed turn, then a second left in flight ────────────── */
  const firstScope = yield* Scope.make();
  const first = yield* serverIn(firstScope);
  yield* Effect.gen(function* () {
    const harness = yield* AgentHarness;
    yield* harness.createSession({
      title: "bit second-turn probe",
      model: MODEL,
      directory: WORKSPACE,
      sessionId,
    });
    line("created in server A", "yes");

    yield* harness.prompt(sessionId, "Reply with exactly the word: one.");
    line("turn one", "prompted");
    // The whole point of this probe: turn one must reach a terminal, so the row carries
    // its `idle_outcome` and its `time_idle` before turn two starts.
    yield* harness.waitForIdle(sessionId);
    const afterOne = yield* Effect.result(harness.sessionStatus(sessionId));
    line(
      "status after turn one",
      afterOne._tag === "Success"
        ? JSON.stringify(afterOne.success)
        : `could not ask: ${afterOne.failure.message}`,
    );

    yield* harness.prompt(
      sessionId,
      "Now count slowly from one to forty, one number per line, with a short " +
        "sentence about each number. Do not stop early.",
      { _tag: "steer", urgency: "queued", messageId: "secondturnprobe0001" },
    );
    line("turn two", "prompted");
    // Long enough for `Execution.Started` to have been projected and `time_busy` written;
    // short enough that the turn cannot have finished.
    yield* Effect.sleep("8 seconds");
    const during = yield* Effect.result(harness.sessionStatus(sessionId));
    line(
      "status during turn two",
      during._tag === "Success"
        ? JSON.stringify(during.success)
        : `could not ask: ${during.failure.message}`,
    );
  }).pipe(Effect.provide(first));

  // The graceful shutdown `main.ts` performs on every restart.
  yield* Scope.close(firstScope, Effect.void as never);
  line("server A closed", "gracefully, mid turn two");
  yield* Effect.sleep("2 seconds");

  /* ── Server B: a fresh process over the same database ──────────────────────── */
  const secondScope = yield* Scope.make();
  const second = yield* serverIn(secondScope);
  yield* Effect.gen(function* () {
    const harness = yield* AgentHarness;
    const { server } = yield* OpenCodeServer;

    const row = yield* Effect.result(
      raw(server, `/api/session/${encodeURIComponent(sessionId)}`),
    );
    const active = yield* Effect.result(raw(server, "/api/session/active"));
    console.log("\n-- the row server B holds, raw --");
    if (row._tag === "Failure") {
      line("GET /api/session/:id", "failed");
      return;
    }
    const parsed = JSON.parse(row.success) as {
      readonly data?: {
        readonly outcome?: string;
        readonly time?: { readonly busy?: number; readonly idle?: number };
      };
    };
    const times = parsed.data?.time;
    line("time.idle", times?.idle ?? "(absent)");
    line("time.busy", times?.busy ?? "(absent)");
    line("outcome", parsed.data?.outcome ?? "(absent)");
    line(
      "busy > idle",
      times?.busy !== undefined &&
        (times.idle === undefined || times.busy > times.idle)
        ? "yes — turn two started after turn one's terminal and recorded none of its own"
        : "no",
    );
    line(
      "GET /api/session/active",
      active._tag === "Success" ? active.success : "failed",
    );

    const asked = yield* Effect.result(harness.sessionStatus(sessionId));
    console.log("\n-- what sessionStatus answers --");
    if (asked._tag === "Failure") {
      line("sessionStatus", `failed: ${asked.failure.message}`);
      return;
    }
    line("sessionStatus", JSON.stringify(asked.success));

    // Recovery's own vocabulary, through the real adapter rather than by hand.
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
    line("trigger", continuationTrigger(report.observed, "…")._tag);

    // The same three layers as they would have read before the fix, computed from the row
    // above rather than remembered: the outcome believed because nothing is running.
    const stale = parsed.data?.outcome;
    console.log("\n-- and what each said before the fix --");
    line(
      "sessionStatus",
      JSON.stringify({ activity: "idle", outcome: stale ?? undefined }),
    );
    line("observed", stale ?? "abandoned");
    line(
      "trigger",
      continuationTrigger(
        (stale ?? "abandoned") as Parameters<typeof continuationTrigger>[0],
        "…",
      )._tag,
    );

    const continuation = yield* Effect.result(
      harness.sessionContinuation(sessionId),
    );
    console.log("\n-- and the conversation itself --");
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
  }).pipe(Effect.provide(second));
  yield* Scope.close(secondScope, Effect.void as never);
});

runMain(Effect.scoped(program.pipe(Effect.provide(FetchHttpClient.layer))));
