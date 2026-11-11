/**
 * Pi sessions contained in systemd user scopes (`userScopes.ts`), against a real
 * `pi --mode rpc` with the model scripted (`piFakeModel.ts`) and the real user manager.
 *
 * What these prove is what the process-tree tracker could not do (slice 2 review, M1): a job
 * the agent puts in the background — `nohup … &`, and a `setsid` double fork that leaves
 * every process group and session Pi made — is gone after End, after Pi is killed, and after
 * the server closes the harness; the startup reaper stops a scope a killed server left and
 * leaves another server's alone; the credential still arrives on fd 3 and nowhere a scope
 * shows it; a scope over its memory cap ends as a death that says so.
 *
 * Every scope here is named with a prefix unique to this run, and every one still listed
 * under it is stopped after each test, pass or fail. Skipped with `pi` missing (as in
 * `piClient.test.ts`); a user manager that cannot be reached fails them unless
 * `BIT_SKIP_SCOPE_TESTS=1` says the skip is meant.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Exit, Layer, Redacted, Scope, Stream } from "effect";

import {
  AgentHarness,
  SESSION_PROCESS_GONE_TAG,
  type HarnessNarration,
} from "./agentHarness";
import { InstanceId } from "./identity";
import { fakeModelsJson, startFakeModel, type FakeModel } from "./piFakeModel";
import { piHarness, type PiHarnessOptions } from "./piClient";
import {
  piScopePrefix,
  probeUserScopes,
  reapUserScopes,
  type ScopeAvailability,
} from "./userScopes";

const hasPi = spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;
const hasUserManager =
  spawnSync("systemctl", ["--user", "is-system-running"], { stdio: "ignore" })
    .error === undefined;

/** This run's own prefix: `bit-pi-pcgt<hex>-`, so nothing here touches another's scope. */
const SERVER = `pcgt${randomBytes(3).toString("hex")}`;
const PREFIX = piScopePrefix(SERVER);

let model: FakeModel;
let root: string;
let agentDir: string;
let containment: ScopeAvailability;

const systemctl = (...args: string[]) =>
  spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });

/** The scopes listed under a prefix, with their active state. */
const listed = (prefix: string): { unit: string; active: string }[] =>
  (
    systemctl(
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "--full",
      `${prefix}*`,
    ).stdout ?? ""
  )
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([unit]) => unit?.startsWith(prefix) === true)
    .map(([unit, , active]) => ({ unit: unit ?? "", active: active ?? "" }));

/** Stops and clears every scope still listed under a prefix. */
const sweep = (prefix: string) => {
  const units = listed(prefix).map((entry) => entry.unit);
  if (units.length === 0) return;
  systemctl("stop", ...units);
  systemctl("reset-failed", ...units);
};

beforeAll(async () => {
  model = startFakeModel();
  root = mkdtempSync(join(tmpdir(), "bit-pi-scope-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), fakeModelsJson(model.url));
  containment = await Effect.runPromise(probeUserScopes(PREFIX));
});

afterEach(() => {
  sweep(PREFIX);
});

afterAll(async () => {
  sweep(PREFIX);
  await model.stop();
  rmSync(root, { recursive: true, force: true });
});

const S = (steps: readonly unknown[]): string =>
  `SCRIPT:${JSON.stringify(steps)}`;

interface Fixture {
  readonly harness: AgentHarness["Service"];
  readonly scope: Scope.Closeable;
  readonly records: string;
  readonly work: string;
}

let counter = 0;

const fixture = async (
  overrides: Partial<PiHarnessOptions> = {},
): Promise<Fixture> => {
  counter += 1;
  const base = join(root, `f${String(counter)}`);
  const records = join(base, "records");
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      piHarness({
        instanceId: InstanceId.make("pi-scope-test"),
        displayName: "Pi scope test",
        agentDir,
        recordDirectory: records,
        stopBounds: { terminateGrace: 1_000, killGrace: 1_000, poll: 25 },
        containment,
        ...overrides,
      }),
      scope,
    ),
  );
  return {
    harness: Context.get(context, AgentHarness),
    scope,
    records,
    work,
  };
};

const close = (f: Fixture) =>
  Effect.runPromise(Scope.close(f.scope, Exit.void));

const listen = (
  harness: AgentHarness["Service"],
  sessionId: string,
  scope: Scope.Closeable,
) => {
  const seen: HarnessNarration[] = [];
  void Effect.runPromise(
    Effect.forkIn(
      Stream.runForEach(harness.sessionEvents(sessionId), (entry) =>
        Effect.sync(() => {
          seen.push(entry);
        }),
      ),
      scope,
    ),
  );
  return seen;
};

const until = async (
  check: () => boolean,
  what: string,
  ms = 20_000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const open = (harness: AgentHarness["Service"], work: string) =>
  Effect.runPromise(
    harness.createSession({
      title: "bit scope test $HOME `x`",
      model: "fake/fake-1",
      directory: work,
      sessionId: harness.newSessionId(),
      multiTurn: true,
    }),
  );

/** Live and not a zombie: `kill(pid, 0)` would call a zombie alive. */
const running = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
};

const cgroupOf = (pid: number): string =>
  readFileSync(`/proc/${String(pid)}/cgroup`, "utf8").trim();

/** The pid of the one Pi process a fixture recorded. */
const recordedPid = (records: string): number => {
  const [name] = readdirSync(records).filter((file) => file.endsWith(".json"));
  if (name === undefined) throw new Error("no Pi process was recorded");
  return Number(name.replace(/\.json$/, ""));
};

/**
 * A bash call that only starts background jobs and returns: a `nohup … &` (reparented the
 * moment the call's shell exits) and a `setsid` double fork (a session of its own, its
 * parent gone at once). Each writes its pid, then becomes a `sleep`.
 */
const backgroundJobs = (folder: string) =>
  [
    `nohup bash -c 'echo $$ > ${folder}/nohup.pid; exec sleep 7771' >/dev/null 2>&1 &`,
    `setsid bash -c '(echo $BASHPID > ${folder}/setsid.pid; exec sleep 7772) &' >/dev/null 2>&1 &`,
    "echo started",
  ].join("\n");

/** Waits for both jobs to write their pids, and checks they run in `unit`. */
const jobsIn = async (folder: string, unit: string): Promise<number[]> => {
  const files = ["nohup.pid", "setsid.pid"].map((name) => join(folder, name));
  await until(
    () =>
      files.every(
        (file) => existsSync(file) && readFileSync(file, "utf8").trim() !== "",
      ),
    "the background jobs' pids",
  );
  const pids = files.map((file) => Number(readFileSync(file, "utf8").trim()));
  for (const pid of pids) {
    expect(running(pid)).toBe(true);
    expect(cgroupOf(pid).endsWith(`/${unit}`)).toBe(true);
  }
  return pids;
};

/** The one scope a session's process runs in. */
const unitOf = (sessionId: string): string => {
  const units = listed(`${PREFIX}${sessionId}-`).filter(
    (entry) => entry.active === "active",
  );
  expect(units.length).toBe(1);
  return units[0]?.unit ?? "";
};

/** Starts a session whose first turn leaves the two jobs running, and waits for them. */
const withJobs = async (f: Fixture) => {
  const ref = await open(f.harness, f.work);
  await Effect.runPromise(
    f.harness.prompt(
      ref.id,
      S([
        { tool: "bash", args: { command: backgroundJobs(f.work) } },
        { text: "jobs started" },
      ]),
    ),
  );
  await Effect.runPromise(f.harness.waitForIdle(ref.id));
  const unit = unitOf(ref.id);
  const pi = recordedPid(f.records);
  expect(cgroupOf(pi).endsWith(`/${unit}`)).toBe(true);
  const jobs = await jobsIn(f.work, unit);
  return { ref, unit, pi, jobs };
};

const gone = (unit: string) =>
  !listed(unit).some((entry) => entry.unit === unit);

const skipScopes = !hasUserManager || process.env.BIT_SKIP_SCOPE_TESTS === "1";

test.skipIf(!hasPi || skipScopes)(
  "the user manager can give this run a scope",
  () => {
    expect(containment).toMatchObject({ _tag: "available" });
  },
);

describe.skipIf(!hasPi || skipScopes)(
  "a Pi session in a scope of its own",
  () => {
    test("End stops the background jobs the agent left, a setsid double fork included, and the scope", async () => {
      const f = await fixture();
      try {
        const { ref, unit, pi, jobs } = await withJobs(f);
        // A turn that ended long ago: the tree tracker would have lost both jobs by now.
        await Bun.sleep(1_200);
        expect(jobs.every(running)).toBe(true);
        await Effect.runPromise(f.harness.endSession(ref));
        expect(running(pi)).toBe(false);
        expect(jobs.filter(running)).toEqual([]);
        expect(gone(unit)).toBe(true);
        expect(readdirSync(f.records)).toEqual([]);
      } finally {
        await close(f);
      }
    }, 30_000);

    test("a Pi process killed between turns takes its background jobs and scope with it", async () => {
      const f = await fixture();
      try {
        const { unit, pi, jobs } = await withJobs(f);
        process.kill(pi, "SIGKILL");
        await until(() => jobs.every((pid) => !running(pid)), "the jobs to go");
        await until(() => gone(unit), "the scope to go");
      } finally {
        await close(f);
      }
    }, 30_000);

    test("a server killed with SIGKILL leaves no background job and no scope: the scope ends when Pi does, before any reaper", async () => {
      // A server of its own, in a child process: the only way to kill one without any
      // finalizer of its running, which is the case the scope's watcher is for.
      counter += 1;
      const base = join(root, `killed${String(counter)}`);
      const records = join(base, "records");
      const work = join(base, "work");
      mkdirSync(work, { recursive: true });
      const server = join(base, "server.ts");
      const here = import.meta.dir;
      writeFileSync(
        server,
        [
          'import { Context, Effect, Layer, Scope } from "effect";',
          `import { AgentHarness } from ${JSON.stringify(join(here, "agentHarness.ts"))};`,
          `import { InstanceId } from ${JSON.stringify(join(here, "identity.ts"))};`,
          `import { piHarness } from ${JSON.stringify(join(here, "piClient.ts"))};`,
          `import { probeUserScopes } from ${JSON.stringify(join(here, "userScopes.ts"))};`,
          "const [agentDir, records, work, prefix, script] = process.argv.slice(2);",
          "const containment = await Effect.runPromise(probeUserScopes(prefix));",
          "const scope = await Effect.runPromise(Scope.make());",
          "const context = await Effect.runPromise(Layer.buildWithScope(piHarness({",
          '  instanceId: InstanceId.make("pi-killed-test"), displayName: "Pi killed test",',
          "  agentDir, recordDirectory: records, containment,",
          "}), scope));",
          "const harness = Context.get(context, AgentHarness);",
          "const ref = await Effect.runPromise(harness.createSession({",
          '  title: "killed", model: "fake/fake-1", directory: work,',
          "  sessionId: harness.newSessionId(), multiTurn: true,",
          "}));",
          "await Effect.runPromise(harness.prompt(ref.id, script));",
          "await Effect.runPromise(harness.waitForIdle(ref.id));",
          "console.log(JSON.stringify({ sessionId: ref.id }));",
          "setInterval(() => undefined, 60_000);",
        ].join("\n"),
      );
      const child = spawn(
        "bun",
        [
          server,
          agentDir,
          records,
          work,
          PREFIX,
          S([
            { tool: "bash", args: { command: backgroundJobs(work) } },
            { text: "jobs started" },
          ]),
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      try {
        let out = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (data: string) => {
          out += data;
        });
        await until(() => out.includes("\n"), "the child server's session");
        const { sessionId } = JSON.parse(out.trim()) as { sessionId: string };
        const unit = unitOf(sessionId);
        const pi = recordedPid(records);
        const jobs = await jobsIn(work, unit);
        child.kill("SIGKILL");
        // Pi exits on its stdin's EOF; the watcher then ends everything else in the scope.
        await until(() => !running(pi), "Pi to exit on its stdin's end");
        await until(
          () => jobs.every((pid) => !running(pid)),
          "the background jobs to go",
          10_000,
        );
        await until(() => gone(unit), "the scope to go", 10_000);
        // Nothing left for the next boot's reaper.
        expect(await Effect.runPromise(reapUserScopes(PREFIX))).toEqual([]);
      } finally {
        child.kill("SIGKILL");
      }
    }, 40_000);

    test("a short-lived Pi of the server's — the default-level probe — runs in a scope too", async () => {
      const f = await fixture();
      try {
        const sessionId = f.harness.newSessionId();
        await Effect.runPromise(
          f.harness.createSession({
            title: "probe test",
            model: "fake/fake-think",
            directory: f.work,
            sessionId,
            multiTurn: true,
            options: [{ id: "thinkingLevel", value: "low" }],
          }),
        );
        await Effect.runPromise(
          f.harness.prompt(sessionId, S([{ text: "one" }])),
        );
        await Effect.runPromise(f.harness.waitForIdle(sessionId));
        // Watch for the probe's scope while the switch back to the default asks Pi.
        const seen = new Set<string>();
        let watching = true;
        const watcher = (async () => {
          while (watching) {
            for (const entry of listed(`${PREFIX}thinking-probe-`))
              seen.add(entry.unit);
            await Bun.sleep(20);
          }
        })();
        await Effect.runPromise(
          f.harness.switchModel(sessionId, "fake/fake-think", [
            { id: "thinkingLevel", value: "default" },
          ]),
        );
        watching = false;
        await watcher;
        expect(seen.size).toBe(1);
        const [probeUnit] = [...seen];
        await until(() => gone(probeUnit ?? ""), "the probe's scope to go");
        await Effect.runPromise(f.harness.endSession({ id: sessionId }));
      } finally {
        await close(f);
      }
    }, 30_000);

    test("closing the harness (server shutdown) stops every scope it started", async () => {
      const f = await fixture();
      const { unit, pi, jobs } = await withJobs(f);
      await close(f);
      expect(running(pi)).toBe(false);
      expect(jobs.filter(running)).toEqual([]);
      expect(gone(unit)).toBe(true);
    }, 30_000);

    test("a Stop ends the running call and leaves the session's background jobs, which End then stops", async () => {
      const f = await fixture();
      try {
        const { ref, unit, jobs } = await withJobs(f);
        const call = join(f.work, "call.pid");
        await Effect.runPromise(
          f.harness.prompt(
            ref.id,
            S([
              {
                tool: "bash",
                args: { command: `echo $$ > ${call}; exec sleep 7773` },
              },
              { text: "never" },
            ]),
            { _tag: "steer", urgency: "queued", messageId: "m-call" },
          ),
        );
        await until(
          () => existsSync(call) && readFileSync(call, "utf8").trim() !== "",
          "the running call's pid",
        );
        const callPid = Number(readFileSync(call, "utf8").trim());
        expect(running(callPid)).toBe(true);
        expect(
          await Effect.runPromise(f.harness.interruptSession(ref.id)),
        ).toBe(true);
        await until(() => !running(callPid), "the running call to stop");
        expect(jobs.every(running)).toBe(true);
        expect(gone(unit)).toBe(false);
        await Effect.runPromise(f.harness.endSession(ref));
        expect(jobs.filter(running)).toEqual([]);
        expect(gone(unit)).toBe(true);
      } finally {
        await close(f);
      }
    }, 30_000);

    test("the credential still arrives on fd 3, and neither the scope nor any shell shows it", async () => {
      const calls: string[] = [];
      const mcp = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const body = (await request.json()) as { method: string };
          calls.push(
            `${body.method} ${request.headers.get("authorization") ?? ""}`,
          );
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result:
              body.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "echo",
                        description: "echo",
                        inputSchema: { type: "object", properties: {} },
                      },
                    ],
                  }
                : { content: [{ type: "text", text: "echoed" }] },
          });
        },
      });
      const token = `scope-secret-${randomBytes(6).toString("hex")}`;
      const f = await fixture();
      try {
        const ref = await open(f.harness, f.work);
        await Effect.runPromise(
          f.harness.registerMcpServer(ref.id, "bit-test", {
            url: `http://127.0.0.1:${String(mcp.port)}/`,
            headers: { authorization: Redacted.make(`Bearer ${token}`) },
            directory: f.work,
          }),
        );
        const seen = listen(f.harness, ref.id, f.scope);
        const probe = [
          `env | grep -c ${token} || true`,
          `tr '\\0' '\\n' < /proc/$PPID/environ | grep -c ${token} || true`,
          `tr '\\0' ' ' < /proc/$PPID/cmdline | grep -c ${token} || true`,
        ].join("; ");
        await Effect.runPromise(
          f.harness.prompt(
            ref.id,
            S([
              { tool: "bit_echo", args: {} },
              { tool: "bash", args: { command: probe } },
              { text: "done" },
            ]),
          ),
        );
        await Effect.runPromise(f.harness.waitForIdle(ref.id));
        expect(calls).toEqual([
          `tools/list Bearer ${token}`,
          `tools/call Bearer ${token}`,
        ]);
        const results = seen.flatMap((entry) =>
          entry.detail._tag === "toolResult" ? [entry.detail.output] : [],
        );
        expect(results[1]?.trim().split("\n")).toEqual(["0", "0", "0"]);
        const unit = unitOf(ref.id);
        const shown = systemctl("show", unit).stdout ?? "";
        expect(shown).toContain(`Description=bit Pi session ${ref.id}`);
        expect(shown.includes(token)).toBe(false);
        const pi = recordedPid(f.records);
        for (const file of ["environ", "cmdline"]) {
          expect(
            readFileSync(`/proc/${String(pi)}/${file}`, "utf8").includes(token),
          ).toBe(false);
        }
        // The title's `$HOME` reached Pi as written: systemd-run expanded nothing.
        expect(await Effect.runPromise(f.harness.sessionTitle(ref.id))).toEqual(
          {
            _tag: "titled",
            title: "bit scope test $HOME `x`",
          },
        );
      } finally {
        await close(f);
        await mcp.stop(true);
      }
    }, 30_000);

    test("a session over its memory limit is stopped whole and ends as a death that says so", async () => {
      const f = await fixture({ memoryMax: "300M" });
      try {
        const ref = await open(f.harness, f.work);
        const seen = listen(f.harness, ref.id, f.scope);
        await Effect.runPromise(
          f.harness.prompt(ref.id, S([{ text: "ready" }])),
        );
        await Effect.runPromise(f.harness.waitForIdle(ref.id));
        const unit = unitOf(ref.id);
        expect(
          systemctl("show", "-p", "MemoryMax", "--value", unit).stdout?.trim(),
        ).toBe(String(300 * 1024 * 1024));
        await Effect.runPromise(
          f.harness.prompt(
            ref.id,
            S([
              {
                tool: "bash",
                args: {
                  command: `${backgroundJobs(f.work)}\nsleep 0.5; head -c 2000M /dev/zero | python3 -c "import sys; d = sys.stdin.buffer.read()"`,
                },
              },
              { text: "never" },
            ]),
            { _tag: "steer", urgency: "queued", messageId: "m-hog" },
          ),
        );
        const waited = await Effect.runPromise(
          Effect.result(f.harness.waitForIdle(ref.id)),
        );
        expect(waited._tag).toBe("Failure");
        if (waited._tag === "Failure") {
          expect(
            waited.failure._tag === "HarnessTransportError"
              ? waited.failure.tag
              : waited.failure._tag,
          ).toBe(SESSION_PROCESS_GONE_TAG);
        }
        const notice = () =>
          seen.flatMap((entry) =>
            entry.detail._tag === "error" &&
            entry.detail.message.includes("memory")
              ? [entry.detail.message]
              : [],
          )[0];
        await until(() => notice() !== undefined, "the death's notice");
        const said = notice() ?? "";
        expect(said).toContain("ran out of its memory limit (300M)");
        expect(said).toContain("while a turn was in flight");
        expect(
          seen.flatMap((entry) =>
            entry.detail._tag === "error" ? [entry.detail.processExit] : [],
          ),
        ).toEqual([{ duringTurn: true }]);
        // The scope, failed for memory, is cleared, and nothing it held is left.
        await until(() => gone(unit), "the failed scope to be cleared");
        const pids = ["nohup.pid", "setsid.pid"]
          .map((name) => join(f.work, name))
          .filter(existsSync)
          .map((file) => Number(readFileSync(file, "utf8").trim()));
        expect(pids.filter(running)).toEqual([]);
        // The replay says it too.
        const replay = await Effect.runPromise(f.harness.messages(ref.id));
        expect(replay.some((entry) => entry.error === said)).toBe(true);
      } finally {
        await close(f);
      }
    }, 60_000);

    test("a memory stop between turns is said as an exit with no turn running, live and replayed", async () => {
      const f = await fixture({ memoryMax: "300M" });
      try {
        const ref = await open(f.harness, f.work);
        const seen = listen(f.harness, ref.id, f.scope);
        // The turn leaves a job that eats memory a second after the turn has ended.
        await Effect.runPromise(
          f.harness.prompt(
            ref.id,
            S([
              {
                tool: "bash",
                args: {
                  command: `nohup bash -c 'sleep 1; head -c 2000M /dev/zero | python3 -c "import sys; d = sys.stdin.buffer.read()"' >/dev/null 2>&1 &\necho started`,
                },
              },
              { text: "the job is running" },
            ]),
          ),
        );
        await Effect.runPromise(f.harness.waitForIdle(ref.id));
        const exits = () =>
          seen.flatMap((entry) =>
            entry.detail._tag === "error" &&
            entry.detail.processExit !== undefined
              ? [entry.detail]
              : [],
          );
        await until(() => exits().length > 0, "the exit's notice");
        const [exit] = exits();
        expect(exit?.processExit).toEqual({ duringTurn: false });
        expect(exit?.message).toContain("ran out of its memory limit (300M)");
        expect(exit?.message).not.toContain("while a turn was in flight");
        const replay = await Effect.runPromise(f.harness.messages(ref.id));
        const replayed = replay.filter(
          (entry) => entry.processExit !== undefined,
        );
        expect(
          replayed.map((entry) => [entry.error, entry.processExit]),
        ).toEqual([[exit?.message, { duringTurn: false }]]);
      } finally {
        await close(f);
      }
    }, 60_000);

    test("without a user manager a session runs as before, and the instance says what that leaves", async () => {
      const f = await fixture({
        containment: { _tag: "unavailable", reason: "no user manager here" },
        memoryMax: "1G",
      });
      try {
        expect(f.harness.instance.notice).toContain("no user manager here");
        expect(f.harness.instance.notice).toContain(
          "memoryMax 1G is not applied",
        );
        const ref = await open(f.harness, f.work);
        await Effect.runPromise(f.harness.prompt(ref.id, S([{ text: "hi" }])));
        await Effect.runPromise(f.harness.waitForIdle(ref.id));
        expect(listed(`${PREFIX}${ref.id}-`)).toEqual([]);
        const pi = recordedPid(f.records);
        expect(cgroupOf(pi).includes(PREFIX)).toBe(false);
        await Effect.runPromise(f.harness.endSession(ref));
        expect(running(pi)).toBe(false);
      } finally {
        await close(f);
      }
    }, 30_000);
  },
);

describe.skipIf(skipScopes)("the startup reaper", () => {
  test("stops a scope this server left, with what ran in it, and leaves another server's alone", async () => {
    const other = piScopePrefix(`pcgo${randomBytes(3).toString("hex")}`);
    const start = (unit: string) => {
      const child = spawn(
        "systemd-run",
        [
          "--user",
          "--scope",
          "--quiet",
          `--unit=${unit}`,
          "--",
          "bash",
          "-c",
          "nohup sleep 7774 >/dev/null 2>&1 & exec sleep 7775",
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    };
    const mine = `${PREFIX}leftover-1.scope`;
    const theirs = `${other}leftover-1.scope`;
    try {
      start(mine);
      start(theirs);
      await until(
        () =>
          listed(mine).some((entry) => entry.active === "active") &&
          listed(theirs).some((entry) => entry.active === "active"),
        "both scopes",
      );
      await Bun.sleep(200);
      const outcomes = await Effect.runPromise(reapUserScopes(PREFIX));
      expect(outcomes.map((outcome) => [outcome.unit, outcome.state])).toEqual([
        [mine, "stopped"],
      ]);
      expect(outcomes[0]?.detail).toContain("sleep");
      expect(gone(mine)).toBe(true);
      expect(listed(theirs).map((entry) => entry.active)).toEqual(["active"]);
      // Nothing left to reap a second time.
      expect(await Effect.runPromise(reapUserScopes(PREFIX))).toEqual([]);
    } finally {
      sweep(other);
    }
  }, 30_000);
});
