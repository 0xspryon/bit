/**
 * The live reproduction of the OpenCode recovery defect, and of its fix.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/restartStatusProbe.ts
 * bun run src/spike/restartStatusProbe.ts --model zai-coding-plan/glm-5.3-flash
 * bun run src/spike/restartStatusProbe.ts --no-turn      # no model call at all
 * ```
 *
 * ## What it does
 *
 * Spawns a real `opencode serve --stdio`, opens a session in it, sends a prompt, and then
 * **closes that server's scope while the turn is still in flight** — which is a graceful
 * shutdown, the same one `main.ts` performs on every restart. Then it spawns a *second*
 * server over the same database and asks both questions about the old session:
 *
 * - `GET /api/session/:id` — the `outcome` field `sessionStatus` used to read alone; and
 * - `GET /api/session/active` — the drains the new process owns, which is none.
 *
 * Both are printed raw as well as through `AgentHarness.sessionStatus`, and the old
 * one-field reading is printed beside the new one so the difference is visible rather
 * than asserted.
 *
 * ## Why a graceful shutdown is the interesting case
 *
 * `core/src/session/projector.ts`'s `projectIdle` **returns early** for
 * `Execution.Interrupted` when `reason === "shutdown"`, writing neither `idle_outcome`
 * nor `time_idle` — deliberately, to support OpenCode's own restart continuity. A
 * server whose scope closes interrupts its executions with the reason defaulted to
 * `"shutdown"` (`core/src/session/execution.ts`'s `terminal`, `reason ?? "shutdown"`),
 * so the clean path records nothing. An unclean death records nothing either, for the
 * duller reason that no event is published at all. Either way the row is left with no
 * outcome, and reading that as `running` is what left attempt rows `running` for ever.
 *
 * `--no-turn` skips the prompt entirely and so costs nothing: a session created and never
 * prompted has the same observable shape — exists, no outcome, not active — and shows the
 * mapping without depending on a provider being reachable. The default sends a prompt,
 * because "a turn really was in flight" is the case the defect is about.
 *
 * **Nothing may import this module.** `runMain` is called at module scope.
 */
import { Effect, Layer, Redacted, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { AgentHarness } from "../harness/agentHarness";
import { newOpenCodeSessionId } from "../harness/openCodeClient";
import { openCodeHarness } from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { runMain } from "./main";
import { prepareWorkspace, RUNTIME_DIR } from "./runtime";
import { join } from "node:path";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const MODEL = argument("model") ?? "opencode/glm-5.3-flash-free";
const WITH_TURN = !process.argv.includes("--no-turn");
const WORKSPACE = join(RUNTIME_DIR, "restart-status-probe");

const line = (label: string, value: unknown) =>
  console.log(`${label.padEnd(30)} ${String(value)}`);

/** One server, built into its own scope so it can be closed on command. */
const serverIn = (scope: Scope.Scope) =>
  Layer.buildWithScope(
    openCodeHarness({ defaultModel: MODEL }).pipe(
      Layer.provideMerge(OpenCodeServer.layer({ cwd: WORKSPACE })),
      Layer.provide(FetchHttpClient.layer),
    ),
    scope,
  );

/** The two reads, straight off the wire, so nothing in our own decode can hide them. */
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
  line("turn sent", WITH_TURN);
  line("session", sessionId);

  /* ── The first server: open a session, start a turn, then die gracefully ───── */
  const firstScope = yield* Scope.make();
  const first = yield* serverIn(firstScope);
  yield* Effect.gen(function* () {
    const harness = yield* AgentHarness;
    yield* harness.createSession({
      title: "bit restart-status probe",
      model: MODEL,
      directory: WORKSPACE,
      sessionId,
    });
    line("created in server A", "yes");
    if (!WITH_TURN) return;
    yield* harness.prompt(
      sessionId,
      "Count slowly from one to forty, one number per line, with a short sentence " +
        "about each number. Do not stop early.",
    );
    line("prompt accepted", "yes");
    // Long enough for `Execution.Started` to have been projected and the drain to be
    // genuinely in flight; short enough that it cannot have finished.
    yield* Effect.sleep("6 seconds");
    const during = yield* Effect.result(harness.sessionStatus(sessionId));
    line(
      "status while live (A)",
      during._tag === "Success"
        ? JSON.stringify(during.success)
        : `could not ask: ${during.failure.message}`,
    );
  }).pipe(Effect.provide(first));

  // The graceful shutdown. This is what `main.ts` does on a restart: the scope closes,
  // the harness child is signalled, and OpenCode interrupts its own executions with the
  // reason defaulted to "shutdown".
  yield* Scope.close(firstScope, Effect.void as never);
  line("server A closed", "gracefully, mid-turn");
  yield* Effect.sleep("2 seconds");

  /* ── The second server: a fresh process over the same database ─────────────── */
  const secondScope = yield* Scope.make();
  const second = yield* serverIn(secondScope);
  yield* Effect.gen(function* () {
    const harness = yield* AgentHarness;
    const { server } = yield* OpenCodeServer;
    const row = yield* Effect.result(
      raw(server, `/api/session/${encodeURIComponent(sessionId)}`),
    );
    const active = yield* Effect.result(raw(server, "/api/session/active"));
    console.log("\n-- what server B sees, raw --");
    line(
      "GET /api/session/:id",
      row._tag === "Success" ? row.success.slice(0, 400) : "failed",
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
    console.log("\n-- what recovery would conclude --");
    line(
      "before this slice",
      asked.success.outcome === undefined
        ? "running  ->  attempt stays 'running', fence unmoved, still_running filed"
        : `${asked.success.outcome}  ->  settled`,
    );
    line(
      "after this slice",
      asked.success.activity === "running"
        ? "running  ->  left alone"
        : asked.success.outcome === undefined
          ? "abandoned  ->  uncertain, fence bumped, credential revoked"
          : `${asked.success.outcome}  ->  settled`,
    );
    // The conversation is still there, which is the fact S7's continuation rests on and
    // the reason `abandoned` is not `missing`.
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
      "messages still readable",
      messages._tag === "Success" ? messages.success.length : "failed",
    );
  }).pipe(Effect.provide(second));
  yield* Scope.close(secondScope, Effect.void as never);
});

runMain(Effect.scoped(program.pipe(Effect.provide(FetchHttpClient.layer))));
