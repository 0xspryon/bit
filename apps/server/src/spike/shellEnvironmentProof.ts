/**
 * The proof for one credential exposure, measured both ways in one run.
 *
 * ```sh
 * cd apps/server
 * bun run src/spike/shellEnvironmentProof.ts 2>&1 | tee .runtime/shell-env-proof-$(date +%H%M%S).log
 * ```
 *
 * **The hole.** A worker's bash tool runs through `Shell.create`, and the environment a
 * shell is given is `{...process.env, TERM, OPENCODE_TERMINAL}` taken from the *server's*
 * process (`core/src/shell.ts:268-282`; the per-session override store it prefers is an
 * in-memory map nothing populates by default, `core/src/session/environment.ts`). So
 * whatever is in the harness child's environment, the agent can print with `env`. Two
 * things were in it:
 *
 * 1. **`OPENCODE_PASSWORD`**, which we put there, and which authenticates `opencode:<it>`
 *    to the local OpenCode API: read of every session in every Location, prompting any
 *    session, creating sessions with a chosen `id` and `parentID`, and adding, removing or
 *    replacing MCP registrations. One server serves this whole process, so that reaches
 *    across workspace boundaries.
 * 2. **Everything the operator's shell exported**, because `serverEnvironment` spread
 *    `process.env` wholesale — any `GITHUB_TOKEN`, cloud key or `SSH_AUTH_SOCK` they
 *    happened to have.
 *
 * **What this file does.** It brings up `opencode serve` twice against the same scratch
 * workspace, runs the same command through the same `POST /api/shell` route a worker's bash
 * tool goes through, and prints what that shell could see:
 *
 * | Column | Server |
 * | ------ | ------ |
 * | `before` | spawned here, by hand, the way `openCodeServer.ts` used to: plain `serve`, environment `{...process.env, OPENCODE_PASSWORD}` |
 * | `after` | spawned through `spawnServer` itself, so the column is the shipped path and not a description of it |
 *
 * The `before` column is a deliberate reconstruction rather than a checkout of the old
 * code: a proof that cannot show the failing state is a proof that cannot tell you the fix
 * worked. It is also the regression check to run after an OpenCode upgrade — the `after`
 * column depends on `serve --stdio` continuing to delete the password from its own
 * `process.env` (`cli/src/server-process.ts:85-89`), which is OpenCode's behaviour and not
 * ours, so it is worth re-measuring rather than assuming.
 *
 * Nothing real is planted and no value is printed. The stand-in for the operator's own
 * secrets is `PROOF_OPERATOR_TOKEN`, exported into this process for the length of the run,
 * and every verdict is `<PRESENT>`/`<ABSENT>`.
 *
 * This proves what a shell can *read*. It is not a claim that a worker cannot reach the
 * harness API at all: `HOME` is still inherited, deliberately, because that is where the
 * credential store it authenticates with lives (DECISIONS.md §12).
 *
 * **Nothing may import this module.** `runMain` is called at module scope; the rule and
 * what it cost to learn are on `workerDemo.ts`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Effect, Redacted } from "effect";

import { OpenCodeServer } from "../harness/openCodeServer";
import { runMain } from "./main";
import { RUNTIME_DIR } from "./runtime";

/** A stand-in for whatever the operator happens to have exported. */
const OPERATOR_SECRET_VAR = "PROOF_OPERATOR_TOKEN";

/**
 * One command, run in the agent's own shell, reporting presence without printing a value.
 *
 * `OPENCODE_SERVER_PASSWORD` is watched alongside the 2.x name because a server honouring
 * the 1.x one would be just as reachable, so "absent" has to cover both. `HOME` and the
 * `PATH` entry count are reported as facts rather than secrets: a run that scrubbed those
 * would be a broken harness, not a secured one, and the count is what makes a silently
 * emptied `PATH` visible.
 */
const PROBE_COMMAND = [
  // Presence is read out of `env` rather than by expanding the variable, so a value can
  // never reach this output by accident — which is the whole reason the probe is safe to
  // run against a real operator's environment and paste into a report.
  `report() { if env | grep -q "^$1="; then echo "$1=<PRESENT>"; else echo "$1=<ABSENT>"; fi; }`,
  `report OPENCODE_PASSWORD`,
  `report OPENCODE_SERVER_PASSWORD`,
  `report ${OPERATOR_SECRET_VAR}`,
  `report SSH_AUTH_SOCK`,
  `echo "HOME=\${HOME:-<ABSENT>}"`,
  `printf %s "PATH_ENTRIES="; printf %s "\${PATH:-}" | tr ':' '\\n' | grep -c .`,
  `printf %s "VARIABLES_VISIBLE="; env | wc -l`,
].join("; ");

interface Probe {
  readonly baseUrl: string;
  readonly authorization: string;
}

const body = (response: Response) =>
  Effect.promise(() => response.json() as Promise<unknown>);

/** A GET that answers `undefined` rather than failing while a server is still starting. */
const get = (probe: Probe, path: string) =>
  Effect.promise(() =>
    fetch(`${probe.baseUrl}${path}`, {
      headers: { authorization: probe.authorization },
    }),
  ).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

/** Readiness, by the one signal that proves an OpenCode 2 server. */
const awaitReady = Effect.fn("awaitReady")(function* (probe: Probe) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = yield* get(probe, "/api/info");
    if (response?.ok === true) {
      const info = (yield* body(response)) as { version: string };
      return info.version;
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(new Error("a probe server never became ready"));
});

/**
 * Runs {@link PROBE_COMMAND} through `POST /api/shell` and returns what it printed.
 *
 * That route is what `Shell.create` serves, which is the same path the agent's bash tool
 * takes; probing it rather than reading `/proc` is the whole point — it measures what the
 * model can actually get at, through the interface it actually has.
 */
const probeShell = Effect.fn("probeShell")(function* (probe: Probe) {
  const created = yield* Effect.promise(() =>
    fetch(`${probe.baseUrl}/api/shell`, {
      method: "POST",
      headers: {
        authorization: probe.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: PROBE_COMMAND, timeout: 30 }),
    }),
  );
  if (!created.ok) {
    const text = yield* Effect.promise(() => created.text());
    return `shell create refused: ${String(created.status)} ${text}`;
  }
  const shell = (yield* body(created)) as { data: { id: string } };
  const id = shell.data.id;

  // The route answers once the shell exists, so its output is polled. Bounded, because a
  // probe that hangs is a probe that tells you nothing.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    yield* Effect.sleep("250 millis");
    const got = yield* get(probe, `/api/shell/${id}`);
    if (got === undefined) continue;
    const info = (yield* body(got)) as { data: { status: string } };
    if (info.data.status === "running") continue;
    const page = yield* get(
      probe,
      `/api/shell/${id}/output?cursor=0&limit=200000`,
    );
    if (page === undefined) break;
    const output = (yield* body(page)) as { data: { output: string } };
    return output.data.output.trim();
  }
  return "(the shell never finished inside the probe's bound)";
});

/** A loopback port nothing is listening on, so neither column collides with a dev server. */
const freePort = Effect.sync(() => {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
});

/**
 * The server as it was spawned before this fix: plain `serve`, and the whole inherited
 * environment with our password added to it.
 *
 * Reconstructed here rather than imported, because the shipped code no longer contains it.
 * Kept to the shape of the old call so that the only differences between the two columns
 * are the two this slice made: the argv and the environment.
 */
const leakyServer = Effect.fnUntraced(function* (cwd: string) {
  const port = yield* freePort;
  const password = `before-${crypto.randomUUID()}`;
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn({
        cmd: [
          "opencode",
          "serve",
          "--hostname=127.0.0.1",
          `--port=${String(port)}`,
        ],
        cwd,
        env: { ...process.env, OPENCODE_PASSWORD: password } as Record<
          string,
          string
        >,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      }),
    ),
    (child) =>
      Effect.sync(() => {
        // Group first: this one starts shells of its own, exactly as the harness does.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* not a group leader, or already gone */
        }
        child.kill("SIGKILL");
      }),
  );
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    authorization: `Basic ${btoa(`opencode:${password}`)}`,
  } satisfies Probe;
});

const report = (column: string, version: string, output: string) => {
  console.log(`\n== ${column} (opencode ${version}) ==`);
  for (const line of output.split("\n")) console.log(`  ${line}`);
};

/**
 * Each column runs in its own `Effect.scoped` region, which is what makes "the first
 * server is gone" a fact rather than an assumption: the scope closing is what kills it,
 * and the second column binds its own port afterwards.
 */
const program = Effect.gen(function* () {
  const workspace = join(RUNTIME_DIR, "shell-env-proof");
  yield* Effect.sync(() => {
    mkdirSync(workspace, { recursive: true });
  });

  // Planted for the length of the run, restored on the way out, and never printed.
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[OPERATOR_SECRET_VAR];
      process.env[OPERATOR_SECRET_VAR] = `planted-${crypto.randomUUID()}`;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[OPERATOR_SECRET_VAR];
        else process.env[OPERATOR_SECRET_VAR] = previous;
      }),
  );

  console.log(`workspace                  ${workspace}`);
  console.log(`operator secret stand-in   ${OPERATOR_SECRET_VAR}`);
  console.log(
    "both columns run the same command through POST /api/shell, the route a worker's",
  );
  console.log("bash tool goes through.");

  yield* Effect.scoped(
    Effect.gen(function* () {
      const probe = yield* leakyServer(workspace);
      const version = yield* awaitReady(probe);
      report(
        "before: plain serve, inherited environment",
        version,
        yield* probeShell(probe),
      );
    }),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* OpenCodeServer;
      const probe: Probe = {
        baseUrl: harness.server.baseUrl,
        authorization: Redacted.value(harness.server.authorization),
      };
      report(
        "after: serve --stdio, allowlisted environment",
        harness.server.version,
        yield* probeShell(probe),
      );
    }).pipe(Effect.provide(OpenCodeServer.layer({ cwd: workspace }))),
  );

  console.log(
    "\nThe server password is absent because `--stdio` makes OpenCode delete it from its",
  );
  console.log(
    "own process.env before serving; the operator's secret is absent because",
  );
  console.log(
    "`serverEnvironment` now passes an allowlist instead of spreading process.env.",
  );
});

runMain(Effect.scoped(program));
