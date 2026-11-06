/**
 * Regression tests for the owned harness process.
 *
 * Every test here corresponds to a defect the implementation had. They run against a
 * **real spawned process** — a small scripted stand-in for `opencode serve`, not a mock
 * — because the things under test (pipe back-pressure, signal handling, process groups,
 * awaited exit) are exactly the things a double cannot have. The two reader-cancellation
 * tests are the exception: a synthetic stalled `ReadableStream` is the only way to
 * observe "the reader was cancelled" directly rather than inferring it.
 *
 * Ownership is asserted against **pids the probes record about themselves**, never a
 * global `pgrep`. A global match would pick up a concurrent test's binary, and would
 * also make these tests claim things about processes they do not own.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import {
  drain,
  HARNESS_ENVIRONMENT_ALLOWLIST,
  LineRing,
  OpenCodeServer,
  serverEnvironment,
  spawnServer,
} from "./openCodeServer";

/** The approved scratch root for harness probes. */
const SCRATCH_ROOT = "/tmp/opencode/bit-harness";
mkdirSync(SCRATCH_ROOT, { recursive: true });

/**
 * Probe folders a run killed from outside left behind, older than a day, are removed before
 * this run makes its own (A7-S review 2: 116 had piled up). A day, so a run still going in
 * another process keeps its own; a folder that will not go is left for the next run.
 */
const STALE_PROBE_AGE = 24 * 60 * 60 * 1000;
for (const name of readdirSync(SCRATCH_ROOT)) {
  if (!name.startsWith("probe-")) continue;
  const folder = join(SCRATCH_ROOT, name);
  try {
    if (Date.now() - statSync(folder).mtimeMs > STALE_PROBE_AGE) {
      rmSync(folder, { recursive: true, force: true });
    }
  } catch {
    // Gone already, or not ours to remove.
  }
}

const scratches: string[] = [];
/** Pid files written by the probes of the test currently running. */
let pidFiles: string[] = [];

/**
 * A process's start time, from `/proc/<pid>/stat` (field 22, clock ticks since boot), or
 * `undefined` when there is no such process. Read after the last `)`, since the command
 * name before it may hold spaces. What tells a recorded pid from a later process that got
 * the same number (A7-S review 2).
 */
const startTimeOf = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
};

/**
 * Each recorded process as `pid starttime`, one a line (see {@link PID_PRELUDE}); the start
 * time `undefined` where the probe could not read one.
 */
const readRecords = (
  file: string,
): { readonly pid: number; readonly started: string | undefined }[] => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => {
        const [pid, started] = line.trim().split(" ");
        return {
          pid: Number(pid),
          started:
            started === undefined || started === "" ? undefined : started,
        };
      })
      .filter(({ pid }) => Number.isSafeInteger(pid) && pid > 1);
  } catch {
    // The probe never got as far as writing one.
    return [];
  }
};

const readPids = (file: string): number[] =>
  readRecords(file).map(({ pid }) => pid);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitAllGone = async (pids: readonly number[], within: number) => {
  const deadline = Date.now() + within;
  for (;;) {
    const survivors = pids.filter(alive);
    if (survivors.length === 0 || Date.now() > deadline) return survivors;
    await Bun.sleep(25);
  }
};

/**
 * Kills everything the current test's probes recorded, assertion failure or not.
 *
 * Group first, then the process: a probe that escaped into its own session is in no
 * group we would otherwise reach. The pid list is cleared afterwards so a later test
 * can never signal a pid that has since been recycled by something else.
 */
const reapProbes = () => {
  for (const file of pidFiles) {
    for (const { pid, started } of readRecords(file)) {
      /*
       * Only a pid that is still the process recorded (A7-S review 2): one alive with
       * another start time is a later process that got the number, and is left alone. One
       * gone may still name its group, whose number cannot be handed out while a member
       * lives, so the group is still signalled.
       */
      const now = startTimeOf(pid);
      if (now !== undefined && started !== undefined && now !== started) {
        continue;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Not a group leader, or already gone.
      }
      if (now === undefined) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  pidFiles = [];
};

/**
 * Each test's probe folders go with the test, not with the file (A7-S review 2): a run
 * killed from outside runs neither, and with the removal at the file's end every folder
 * its finished tests made was left behind, 116 of them. Now only the test in flight at the
 * kill can leave one, and its probe, if alive, removes it ({@link PID_PRELUDE}); the sweep
 * at the top takes any left over a day.
 */
const removeScratches = () => {
  for (const directory of scratches.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
};

afterEach(() => {
  reapProbes();
  removeScratches();
});

afterAll(() => {
  reapProbes();
  removeScratches();
});

/**
 * Writes an executable stand-in for `opencode serve`.
 *
 * It takes the same `--port=` argument the real binary does and is handed the same
 * environment, so the spawn path under test is the real one. `--pidfile=` is a test
 * argument: everything the probe starts appends its own pid to that file, which is how
 * these tests know which processes they own.
 */
const fakeBinary = (
  body: string,
): { path: string; cwd: string; pidFile: string; extraArgs: string[] } => {
  const cwd = mkdtempSync(join(SCRATCH_ROOT, "probe-"));
  scratches.push(cwd);
  const path = join(cwd, "fake-opencode");
  const pidFile = join(cwd, "pids");
  writeFileSync(path, `#!/usr/bin/env bun\n${PID_PRELUDE}\n${body}`);
  chmodSync(path, 0o755);
  pidFiles.push(pidFile);
  return {
    path,
    cwd,
    pidFile,
    extraArgs: [`--pidfile=${pidFile}`, `--runner=${String(process.pid)}`],
  };
};

/*
 * **A probe dies with the test run** (A7-S review 1).
 *
 * Each recorded pid carries its start time (A7-S review 2), and a pid is signalled only
 * while it is still that process: the probe's sweep runs after its runner has gone, by
 * which time a recorded number may belong to something else. The runner is checked the
 * same way, so a test process whose number was handed on is gone. A probe that does sweep
 * then removes its own folder, which no teardown will. The teardown above SIGKILLs every
 * recorded pid, but a run killed from outside (`timeout`, the 1 GB scope's OOM kill) runs no
 * teardown, and each probe is detached into its own group, so nothing else reaches it: a
 * `fake-opencode serve` and its TERM-ignoring holder were found alive two hours after such
 * a run. So `--runner=` names the test process, each probe polls it, and the first probe to
 * find it gone SIGKILLs everything recorded (groups first) and then itself. The poll is
 * `unref`'d, so a probe that would exit on its own still does. A holder that escaped the
 * probe's group polls the runner itself (`holdsPipeOpen`).
 */
const PID_PRELUDE = `
import { appendFileSync, readFileSync as readRecorded, rmSync as removeFolder } from "node:fs";
import { dirname as folderOf } from "node:path";
const pidFile = (Bun.argv.find((a) => a.startsWith("--pidfile=")) ?? "").slice(10);
const startOf = (pid) => {
  try {
    const stat = readRecorded("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
};
const recordPid = (pid) => {
  if (pidFile !== "") appendFileSync(pidFile, pid + " " + (startOf(pid) ?? "") + "\\n");
};
recordPid(process.pid);
const runner = Number(
  (Bun.argv.find((a) => a.startsWith("--runner=")) ?? "--runner=0").slice(9),
);
const runnerStarted = runner > 1 ? startOf(runner) : undefined;
if (runner > 1) {
  setInterval(() => {
    const now = startOf(runner);
    if (now !== undefined && now === runnerStarted) return;
    let recorded = "";
    try { recorded = readRecorded(pidFile, "utf8"); } catch {}
    for (const line of recorded.split("\\n")) {
      const [number, started] = line.trim().split(" ");
      const pid = Number(number);
      if (!(pid > 1) || pid === process.pid) continue;
      const current = startOf(pid);
      if (current !== undefined && (started ?? "") !== "" && current !== started) continue;
      try { process.kill(-pid, "SIGKILL"); } catch {}
      if (current === undefined) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    if (pidFile !== "") {
      try { removeFolder(folderOf(pidFile), { recursive: true, force: true }); } catch {}
    }
    process.kill(process.pid, "SIGKILL");
  }, 200).unref();
}
const port = Number(
  (Bun.argv.find((a) => a.startsWith("--port=")) ?? "--port=0").slice(7),
);
`;

/** A stand-in that becomes ready, after running whatever it is told to run first. */
const readyServer = (preamble = "") =>
  fakeBinary(`${preamble}
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    if (new URL(request.url).pathname === "/api/info") {
      return Response.json({ version: "9.9.9-fake" });
    }
    return new Response("nope", { status: 404 });
  },
});
`);

/**
 * A descendant that holds the inherited stdout open and refuses `SIGTERM`.
 *
 * `escape: true` gives it its own session, which is how a process ends up holding our
 * pipe while sitting *outside* the group we own — the case that used to leave a live
 * reader behind a closed scope.
 */
const holdsPipeOpen = (escape: boolean) => `
const holder = Bun.spawn({
  cmd: [
    "sh",
    "-c",
    "trap '' TERM; echo holder $$; while kill -0 " + runner + " 2>/dev/null; do sleep 0.2; done",
  ],
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
  detached: ${String(escape)},
});
recordPid(holder.pid);
`;

/**
 * Records, beside the pid file, what the spawned child was actually handed: its argv,
 * its own view of the environment, and whether fd 0 is a pipe.
 *
 * `serverEnvironment` can be tested as a function, but *that the spawn uses it* — and
 * that `--stdio`, which is what makes OpenCode scrub the password from its own
 * environment, is really on the command line — is only observable from inside the child.
 */
const RECORDS_ITS_LAUNCH = `
import { fstatSync, writeFileSync } from "node:fs";
writeFileSync(pidFile + ".argv", JSON.stringify(Bun.argv));
writeFileSync(pidFile + ".env", JSON.stringify(process.env));
const zero = fstatSync(0);
writeFileSync(
  pidFile + ".stdin",
  zero.isCharacterDevice() ? "null" : zero.isSocket() || zero.isFIFO() ? "pipe" : "other",
);
`;

const spawn = (options: Parameters<typeof spawnServer>[0]) =>
  spawnServer(options);

describe("a probe outliving its test run (A7-S review 2)", () => {
  test("kills only what is still the process it recorded, then removes its own folder", async () => {
    const loop = (): Bun.Subprocess =>
      Bun.spawn({
        cmd: [
          "sh",
          "-c",
          `while kill -0 ${String(process.pid)} 2>/dev/null; do sleep 0.2; done`,
        ],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    const reused = loop();
    const recorded = loop();
    const runner = Bun.spawn({
      cmd: ["sleep", "0.5"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const fake = readyServer();
    // One recorded under another start time — its number since handed to a new process —
    // and one recorded as it is.
    writeFileSync(
      fake.pidFile,
      `${String(reused.pid)} 1\n${String(recorded.pid)} ${startTimeOf(recorded.pid) ?? ""}\n`,
    );
    const probe = Bun.spawn({
      cmd: [
        fake.path,
        `--pidfile=${fake.pidFile}`,
        `--runner=${String(runner.pid)}`,
        "--port=0",
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await runner.exited;
      const gone = await waitAllGone([probe.pid, recorded.pid], 3_000);
      expect(gone).toEqual([]);
      expect(alive(reused.pid)).toBe(true);
      expect(readdirSync(SCRATCH_ROOT)).not.toContain(
        fake.cwd.slice(SCRATCH_ROOT.length + 1),
      );
    } finally {
      reused.kill("SIGKILL");
      recorded.kill("SIGKILL");
      probe.kill("SIGKILL");
    }
  });
});

describe("the password scrub at the spawn boundary", () => {
  test("the child is launched with --stdio and a piped stdin, and sees only the allowlist", async () => {
    // `--stdio` is the whole fix for the server password: OpenCode reads
    // `OPENCODE_PASSWORD` and then deletes it from its own `process.env`
    // (`cli/src/server-process.ts:85-89`), so the `{...process.env, …}` environment it
    // later hands every shell it spawns no longer carries it. Plain `serve` does not
    // scrub, which is how a worker's bash tool could read the credential to our API.
    // The lease that comes with `--stdio` is why fd 0 has to be a pipe we hold open.
    const fake = readyServer(RECORDS_ITS_LAUNCH);
    const inheritedSecret = `operator-secret-${String(Date.now())}`;
    // Three shapes of inherited secret: a provider key OpenCode itself reads, a live
    // credential handle, and an `OPENCODE_`-prefixed one that a prefix passthrough would
    // have let through.
    process.env["ANTHROPIC_API_KEY"] = inheritedSecret;
    process.env["SSH_AUTH_SOCK"] = inheritedSecret;
    process.env["OPENCODE_API_KEY"] = inheritedSecret;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* spawn({
              binary: fake.path,
              cwd: fake.cwd,
              extraArgs: fake.extraArgs,
            });
          }),
        ),
      );
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["SSH_AUTH_SOCK"];
      delete process.env["OPENCODE_API_KEY"];
    }

    const argv = JSON.parse(
      readFileSync(`${fake.pidFile}.argv`, "utf8"),
    ) as string[];
    expect(argv).toContain("serve");
    expect(argv).toContain("--stdio");
    // Bun implements a piped stdin as a socketpair rather than a FIFO; either way it is
    // a channel whose close the child sees as EOF, which is what the lease needs.
    // `stdin: "ignore"` would hand it `/dev/null`, a character device, and the server
    // would read EOF at once and exit.
    expect(readFileSync(`${fake.pidFile}.stdin`, "utf8")).toBe("pipe");

    const seen = JSON.parse(
      readFileSync(`${fake.pidFile}.env`, "utf8"),
    ) as Record<string, string>;
    // The password has to be in the child's *initial* environment — that is the only
    // interface `serve` has for it — and `--stdio` is what gets it back out again.
    expect(seen["OPENCODE_PASSWORD"]).toBeString();
    expect(seen["OPENCODE_SERVER_PASSWORD"]).toBeUndefined();
    expect(Object.values(seen)).not.toContain(inheritedSecret);
    expect(seen["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(seen["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(seen["OPENCODE_API_KEY"]).toBeUndefined();
    // And the harness can still find its credential store and run a program.
    expect(seen["HOME"]).toBe(process.env["HOME"]);
    expect(seen["PATH"]).toBe(process.env["PATH"]);
  });
});

describe("serverEnvironment", () => {
  test("sets the 2.x password variable", () => {
    const environment = serverEnvironment({ PATH: "/usr/bin" }, "secret");
    expect(environment["OPENCODE_PASSWORD"]).toBe("secret");
    expect(environment["PATH"]).toBe("/usr/bin");
  });

  test("drops an inherited 1.x password so ours is the only one in play", () => {
    // `OPENCODE_PASSWORD` wins in OpenCode 2, but leaving the 1.x variable set means
    // two credentials are live and which one applies depends on the server version.
    const environment = serverEnvironment(
      { OPENCODE_SERVER_PASSWORD: "stale-1x-password" },
      "ours",
    );
    expect("OPENCODE_SERVER_PASSWORD" in environment).toBe(false);
    expect(environment["OPENCODE_PASSWORD"]).toBe("ours");
  });

  test("does not mutate the caller's environment object", () => {
    const inherited = { OPENCODE_SERVER_PASSWORD: "stale" };
    serverEnvironment(inherited, "ours");
    expect(inherited.OPENCODE_SERVER_PASSWORD).toBe("stale");
  });

  test("the password never lands in a variable the agent's shell would inherit for MCP", () => {
    // The server password authenticates us to the harness. The MCP bearer token is a
    // separate credential and must never be placed here (DECISIONS.md §6).
    const environment = serverEnvironment({}, "server-password");
    expect(Object.keys(environment)).toEqual(["OPENCODE_PASSWORD"]);
  });

  test("the operator's own exported secrets are not inherited", () => {
    // The hole this closes is wider than one variable: `process.env` carries whatever
    // the operator's shell exported, and a worker shell inherits all of it.
    const environment = serverEnvironment(
      {
        ANTHROPIC_API_KEY: "sk-ant-operator",
        AWS_SECRET_ACCESS_KEY: "aws-operator",
        GITHUB_TOKEN: "ghp-operator",
        GITLAB_TOKEN: "glpat-operator",
        OPENAI_API_KEY: "sk-operator",
        SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
      },
      "ours",
    );
    expect(Object.keys(environment)).toEqual(["OPENCODE_PASSWORD"]);
  });

  test("what the harness needs to find its credentials and run programs survives", () => {
    // Each of these roots something: the XDG variables and `HOME` locate OpenCode's own
    // credential store, which is where provider authentication comes from
    // (DECISIONS.md §12), and `PATH`/`SHELL` are how a tool call runs at all. An
    // allowlist that lost one of these would surface as a provider failing mid-run.
    const inherited = {
      HOME: "/home/operator",
      LANG: "en_GB.UTF-8",
      PATH: "/usr/bin",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: "/home/operator/.cache",
      XDG_CONFIG_HOME: "/home/operator/.config",
      XDG_DATA_HOME: "/home/operator/.local/share",
      XDG_STATE_HOME: "/home/operator/.local/state",
    };
    const environment = serverEnvironment(inherited, "ours");
    for (const [name, value] of Object.entries(inherited)) {
      expect(environment[name]).toBe(value);
    }
  });

  test("the operator's egress path and TLS trust survive", () => {
    // Dropping these does not fail at startup; it fails when the provider is first
    // called, which is the hardest failure to attribute to an environment change.
    const inherited = {
      HTTPS_PROXY: "http://proxy.corp:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      NO_PROXY: "localhost,127.0.0.1",
    };
    const environment = serverEnvironment(inherited, "ours");
    for (const [name, value] of Object.entries(inherited)) {
      expect(environment[name]).toBe(value);
    }
  });

  test("no inherited OPENCODE_ variable reaches the child, by prefix", () => {
    // Not a prefix passthrough on purpose. Some of these names are secrets, and
    // `OPENCODE_CONFIG_PROJECT_DISABLE` is worse than a secret: it would stop the server
    // reading the project configuration that loads our pre-execution policy gate, so an
    // inherited one turns a boundary off with no sign in the run.
    const environment = serverEnvironment(
      {
        OPENCODE_API_KEY: "oc-operator",
        OPENCODE_CONFIG_DIR: "/home/operator/.config/opencode",
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_SSH_ASKPASS_TOKEN: "askpass-operator",
      },
      "ours",
    );
    const inheritedOpenCode = Object.keys(environment).filter(
      (name) => name.startsWith("OPENCODE_") && name !== "OPENCODE_PASSWORD",
    );
    expect(inheritedOpenCode).toEqual([]);
  });

  test("the allowlist names no variable twice", () => {
    expect(new Set(HARNESS_ENVIRONMENT_ALLOWLIST).size).toBe(
      HARNESS_ENVIRONMENT_ALLOWLIST.length,
    );
  });

  test("the allowlist is a list of what is needed, not of what is a secret", () => {
    // A guard on the list itself rather than on one call: a name added here that carries
    // a credential would be a hole no `serverEnvironment` test would notice.
    const credentialShaped = HARNESS_ENVIRONMENT_ALLOWLIST.filter((name) =>
      /PASSWORD|SECRET|TOKEN|API_KEY|AUTH_SOCK|CREDENTIAL/i.test(name),
    );
    expect(credentialShaped).toEqual([]);
  });
});

describe("readiness", () => {
  test("a server that answers /api/info is reported with its version", async () => {
    const fake = readyServer();
    const version = await Effect.runPromise(
      Effect.scoped(
        Effect.map(
          spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
          }),
          (owned) => owned.server.version,
        ),
      ),
    );
    expect(version).toBe("9.9.9-fake");
  });

  test("a hung /api/info does not outlive the readiness bound", async () => {
    // The original bug: the deadline was only checked *between* requests, and the
    // request itself was an `Effect.promise(() => fetch(...))` with no signal. One
    // request that never answers therefore hung forever regardless of the timeout.
    const fake = fakeBinary(`
Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Never answers. Not a 500, not a close: a request that hangs.
  fetch: () => new Promise(() => {}),
});
`);
    const started = Date.now();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        spawn({
          binary: fake.path,
          cwd: fake.cwd,
          extraArgs: fake.extraArgs,
          bounds: { readiness: 1_200, probe: 200, poll: 50 },
        }),
      ),
    );
    const elapsed = Date.now() - started;

    expect(exit._tag).toBe("Failure");
    // Comfortably inside the real 30s default: the bound is what ended this.
    expect(elapsed).toBeLessThan(6_000);
  }, 20_000);

  test("a process that exits before answering fails immediately, with its own output", async () => {
    const fake = fakeBinary(`
console.error("fatal: port 4096 already in use");
process.exit(3);
`);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        spawn({
          binary: fake.path,
          cwd: fake.cwd,
          extraArgs: fake.extraArgs,
          bounds: { readiness: 5_000, poll: 50 },
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    const rendered = JSON.stringify(exit);
    expect(rendered).toContain("HarnessProcessError");
    // The point of retaining diagnostics: the failure says *why*, not just "code 3".
    expect(rendered).toContain("port 4096 already in use");
  }, 20_000);

  test("a failed readiness still terminates the child it spawned", async () => {
    const fake = fakeBinary(`
Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("", { status: 503 }) });
setInterval(() => {}, 1000);
`);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        spawn({
          binary: fake.path,
          cwd: fake.cwd,
          extraArgs: fake.extraArgs,
          bounds: { readiness: 600, probe: 200, poll: 50 },
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");

    // The processes this probe recorded about itself are gone: the scope cleaned up on
    // the failure path, which is where the previous code leaked a live `opencode serve`.
    const recorded = readPids(fake.pidFile);
    expect(recorded.length).toBeGreaterThan(0);
    expect(await waitAllGone(recorded, 2_000)).toEqual([]);
  }, 20_000);
});

describe("bounded diagnostics", () => {
  test("a line count is not a bound: retention is in characters", () => {
    // The defect this replaces: `LineRing` capped the number of complete lines and
    // nothing else, so an unterminated write grew the partial buffer without limit and
    // every retained line was itself unbounded.
    const ring = new LineRing(10, 400, 100);
    ring.write("x".repeat(500_000));
    expect(ring.retainedCharacters()).toBeLessThanOrEqual(100);
    expect(ring.droppedCharacters).toBeGreaterThan(499_000);
    // Mid-line, before any newline: the snapshot already admits the truncation.
    expect(ring.snapshot()[0]).toContain("characters truncated");

    for (let index = 0; index < 50; index += 1) {
      ring.write(`${"y".repeat(5_000)}\n`);
    }
    // Both bounds hold at once, and the character budget is the one that binds here:
    // ten lines of five thousand characters would be fifty thousand.
    expect(ring.snapshot().length).toBeLessThanOrEqual(10);
    expect(ring.retainedCharacters()).toBeLessThanOrEqual(400);
    for (const line of ring.snapshot()) {
      expect(line.length).toBeLessThanOrEqual(100 + 64);
    }
  });

  test("a truncated line says so, in its own text and in the accounting", () => {
    const ring = new LineRing(10, 4_000, 20);
    ring.write("the beginning of the line and then a great deal more\n");
    const [line] = ring.snapshot();
    expect(line).toContain("the beginning of the");
    expect(line).toContain("characters truncated");
    expect(ring.truncatedLines).toBe(1);
    expect(ring.droppedCharacters).toBe(32);
    expect(ring.droppedLines).toBe(0);
  });

  test("an unterminated line is flushed, and the decoder's tail with it", () => {
    const ring = new LineRing(10, 4_000, 400);
    ring.write("first\nsecond, unterminated");
    expect(ring.snapshot()).toEqual(["first", "second, unterminated"]);
    ring.end();
    expect(ring.snapshot()).toEqual(["first", "second, unterminated"]);
    // `end` is idempotent: a second exit path must not duplicate the tail.
    ring.end();
    expect(ring.snapshot()).toEqual(["first", "second, unterminated"]);
  });

  test("a child writing megabytes without a newline still becomes ready, and retention stays under its bound", async () => {
    // Both halves of finding 1, against a real child: 2 MiB on stdout with no newline
    // at all, and oversized newline-terminated lines on stderr. The old ring bounded
    // neither. Readiness afterwards is the proof that draining continued throughout.
    const fake = readyServer(`
const blob = "x".repeat(65_536);
for (let i = 0; i < 32; i += 1) process.stdout.write(blob);
for (let i = 0; i < 20; i += 1) console.error("oversized " + i + " " + "y".repeat(50_000));
`);
    const lines = 10;
    const characters = 2_000;
    const lineCharacters = 500;

    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owned = yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: {
              readiness: 20_000,
              poll: 50,
              diagnosticLines: lines,
              diagnosticCharacters: characters,
              diagnosticLineCharacters: lineCharacters,
            },
          });
          expect(owned.server.version).toBe("9.9.9-fake");
          // Readiness only proves the writes were issued, so wait for the reader to
          // stop seeing new bytes before measuring what was retained.
          let previous = -1;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const current = yield* owned.diagnostics;
            if (current.droppedCharacters === previous) return current;
            previous = current.droppedCharacters;
            yield* Effect.sleep(100);
          }
          return yield* owned.diagnostics;
        }),
      ),
    );

    // The actual bound, stated: each stream holds at most its character budget plus
    // the line it is still assembling.
    const bound = 2 * (characters + lineCharacters);
    expect(seen.retainedCharacters).toBeLessThanOrEqual(bound);
    // 2 MiB of stdout plus ~1 MB of stderr was read, and almost none of it kept.
    expect(seen.droppedCharacters).toBeGreaterThan(3_000_000);
    expect(seen.truncatedLines).toBeGreaterThan(0);
    expect(seen.stdout.length).toBeLessThanOrEqual(lines + 1);
    expect(seen.stderr.length).toBeLessThanOrEqual(lines + 1);
    for (const line of [...seen.stdout, ...seen.stderr]) {
      expect(line.length).toBeLessThanOrEqual(lineCharacters + 64);
    }
    // The truncation is visible in the text, not inferred from a counter.
    expect([...seen.stdout, ...seen.stderr].join("\n")).toContain(
      "characters truncated",
    );
  }, 60_000);

  test("a noisy process is drained, not blocked, and only a bounded tail is kept", async () => {
    // Piping stdout/stderr without draining them fills the pipe buffer (64 KiB on
    // Linux) and blocks the child's next write — forever. This writes far more than
    // that *before* it starts serving, so a server that only became ready after the
    // writes completed is proof the pipes were being read.
    const fake = readyServer(`
for (let i = 0; i < 4000; i += 1) {
  console.log("stdout noise line " + i + " " + "x".repeat(60));
  console.error("stderr noise line " + i);
}
`);
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owned = yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: {
              readiness: 15_000,
              poll: 50,
              diagnosticLines: 25,
              diagnosticCharacters: 8_000,
            },
          });
          return yield* owned.diagnostics;
        }),
      ),
    );

    // Bounded retention: 25 lines each, not 4000.
    expect(seen.stdout.length).toBeLessThanOrEqual(26);
    expect(seen.stderr.length).toBeLessThanOrEqual(26);
    // And the *newest* lines are what we kept, with the discarding counted.
    expect(seen.stdout.join("\n")).toContain("stdout noise line 3999");
    expect(seen.dropped).toBeGreaterThan(7_000);
    expect(seen.droppedCharacters).toBeGreaterThan(seen.dropped);
  }, 40_000);
});

describe("stream ownership", () => {
  test("an interrupted drain cancels the reader instead of leaving it live", async () => {
    // The claim the previous comment made — that `for await` releases the reader when
    // the surrounding fiber is interrupted — is false. Verified: with the old
    // `Effect.promise` drain this source's `cancel` was never called and the stream
    // stayed locked, while the fiber went away. The reader outlived its owner.
    let cancelled = "not cancelled";
    let pulls = 0;
    const stalled = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull() {
        pulls += 1;
        // Never resolves: a pipe with a writer that has gone quiet.
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = "cancelled";
      },
    });
    const ring = new LineRing(10, 1_000, 100);

    const started = Date.now();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(drain(stalled, ring), {
          startImmediately: true,
        });
        yield* Effect.sleep(50);
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(pulls).toBeGreaterThan(0);
    expect(cancelled).toBe("cancelled");
    // And it did not wait out the stalled read to get there.
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  test("the decoder is flushed and the tail retained when a drain is interrupted", async () => {
    // A multi-byte character split across chunks is held inside the `TextDecoder`
    // until the next chunk or a flush. Interruption is a flush point too.
    const encoded = new TextEncoder().encode("é");
    const stalled = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array([...encoded.subarray(0, 1)]));
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });
    const ring = new LineRing(10, 1_000, 100);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(drain(stalled, ring), {
          startImmediately: true,
        });
        yield* Effect.sleep(50);
        yield* Fiber.interrupt(fiber);
      }),
    );

    // One line, flushed on the way out: the replacement character for the half
    // sequence rather than nothing at all.
    expect(ring.snapshot().length).toBe(1);
    expect(ring.snapshot()[0]?.length).toBeGreaterThan(0);
  }, 10_000);
});

describe("termination", () => {
  test("the child is gone once the scope closes", async () => {
    const fake = readyServer();
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: { readiness: 10_000, poll: 50 },
          });
          return readPids(fake.pidFile);
        }),
      ),
    );
    expect(recorded.length).toBe(1);
    expect(await waitAllGone(recorded, 2_000)).toEqual([]);
  }, 20_000);

  test("a child that ignores SIGTERM is escalated to SIGKILL and awaited", async () => {
    // `kill()` without waiting is a request, not an outcome. This child installs a
    // SIGTERM handler that refuses to die, so only an escalation ends it.
    const fake = readyServer(`
process.on("SIGTERM", () => { console.error("ignoring SIGTERM"); });
`);
    const started = Date.now();
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: {
              readiness: 10_000,
              poll: 50,
              terminateGrace: 300,
              killGrace: 1_000,
            },
          });
          return readPids(fake.pidFile);
        }),
      ),
    );
    const elapsed = Date.now() - started;

    expect(await waitAllGone(recorded, 2_000)).toEqual([]);
    // It waited out the SIGTERM grace before escalating, rather than returning
    // immediately and leaving the process behind.
    expect(elapsed).toBeGreaterThanOrEqual(300);
  }, 20_000);

  test("the processes the harness starts go with it", async () => {
    // OpenCode runs shell commands, so the owned tree is not one process. The child is
    // spawned into its own group and the group is what gets signalled; both the server
    // and the shell it started refuse SIGTERM here, so only the escalation ends them.
    const fake = readyServer(`
process.on("SIGTERM", () => {});
${holdsPipeOpen(false)}
`);
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: {
              readiness: 10_000,
              poll: 50,
              terminateGrace: 300,
              killGrace: 1_500,
            },
          });
          yield* Effect.sleep(300);
          return readPids(fake.pidFile);
        }),
      ),
    );

    // The server, the shell Bun spawned for it, and the `sleep` that shell is running.
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    expect(await waitAllGone(recorded, 3_000)).toEqual([]);
  }, 30_000);

  test("without a group of our own, cleanup reaches the direct child only", async () => {
    // The narrower contract, stated as a test rather than as a hope: this is what the
    // previous implementation did for every spawn. The descendant survives, which is
    // why `ownProcessGroup` defaults to true.
    const fake = readyServer(holdsPipeOpen(false));
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            ownProcessGroup: false,
            bounds: {
              readiness: 10_000,
              poll: 50,
              terminateGrace: 300,
              killGrace: 500,
            },
          });
          yield* Effect.sleep(300);
          return readPids(fake.pidFile);
        }),
      ),
    );

    const survivors = await waitAllGone(recorded, 500);
    // The direct child is the first pid recorded, and it is gone.
    expect(survivors).not.toContain(recorded[0]);
    expect(survivors.length).toBeGreaterThan(0);
    // `afterEach` reaps it; the test owns its probes even when it proves a leak.
  }, 30_000);

  test("a pipe held open from outside the group does not hold the scope open", async () => {
    // The case the old drain could not survive: the direct child dies, the group dies
    // with it, and a process in its own session still holds the write end — so the
    // stream never reaches EOF. The scope must close anyway, by cancelling the reader.
    const fake = readyServer(holdsPipeOpen(true));
    const killGrace = 800;
    const body = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: {
              readiness: 10_000,
              poll: 50,
              terminateGrace: 300,
              killGrace,
            },
          });
          yield* Effect.sleep(300);
          return { recorded: readPids(fake.pidFile), leftAt: Date.now() };
        }),
      ),
    );
    const closing = Date.now() - body.leftAt;
    const [server, holder] = body.recorded;
    expect(server).toBeDefined();
    expect(holder).toBeDefined();

    // Our own tree is gone...
    expect(alive(server as number)).toBe(false);
    // ...and the escaped holder is not, which is what kept the write end open: the
    // stream had not reached EOF when the scope closed. It is reaped below as a test
    // probe, because it is outside the group and so outside what we may claim to own.
    expect(alive(holder as number)).toBe(true);
    // The drain wait spent its grace and then the reader was cancelled, rather than
    // the scope blocking on a stream that will not end.
    expect(closing).toBeGreaterThanOrEqual(killGrace);
    expect(closing).toBeLessThan(6_000);
  }, 30_000);

  test("an interrupt during startup never leaves the child behind", async () => {
    // Acquisition and the registration of its cleanup are one uninterruptible step, so
    // there is no instant at which an interrupt can land between `Bun.spawn` returning
    // and the finalizer existing. That instant is unobservable from outside by
    // construction; what is observable is that interrupting across the whole startup
    // window — randomised, repeatedly — never leaks.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const fake = readyServer();
      const delay = attempt * 2;
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              spawn({
                binary: fake.path,
                cwd: fake.cwd,
                extraArgs: fake.extraArgs,
                bounds: { readiness: 10_000, poll: 25 },
              }),
            ),
            { startImmediately: true },
          );
          yield* Effect.sleep(delay);
          yield* Fiber.interrupt(fiber);
        }),
      );
      const recorded = readPids(fake.pidFile);
      expect(await waitAllGone(recorded, 3_000)).toEqual([]);
    }
  }, 60_000);

  test("the service layer owns the same lifetime", async () => {
    const fake = readyServer();
    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.flatMap(OpenCodeServer, () =>
            Effect.sync(() => readPids(fake.pidFile)),
          ),
          OpenCodeServer.layer({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: { readiness: 10_000, poll: 50 },
          }),
        ),
      ),
    );
    expect(recorded.length).toBe(1);
    expect(await waitAllGone(recorded, 2_000)).toEqual([]);
  }, 20_000);
});

/**
 * The durable record is the half of cleanup that does not depend on this process getting
 * a turn. `harness/ownedProcesses.test.ts` covers the sweep itself; what is asserted here
 * is the pairing — that a real spawn writes a record naming the real child, and that a
 * scope which closes properly leaves nothing for a later boot to act on.
 */
describe("the durable record of an owned process", () => {
  test("names the spawned child while the scope is open, and is gone once it closes", async () => {
    const fake = readyServer();
    const records = mkdtempSync(join(SCRATCH_ROOT, "records-"));
    scratches.push(records);

    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            recordDirectory: records,
            bounds: { readiness: 10_000, poll: 25 },
          }),
          () => Effect.sync(() => readdirSync(records)),
        ),
      ),
    );

    const recorded = readPids(fake.pidFile);
    expect(recorded.length).toBe(1);
    // Named for the pid, which is what makes a record for a pid only ever able to
    // overwrite a stale one.
    expect(seen).toEqual([`${String(recorded[0])}.json`]);
    expect(await waitAllGone(recorded, 3_000)).toEqual([]);
    // A scope that closed properly leaves the next boot nothing to sweep.
    expect(readdirSync(records)).toEqual([]);
  }, 20_000);

  test("records nothing when no directory is given", async () => {
    const fake = readyServer();
    const records = mkdtempSync(join(SCRATCH_ROOT, "records-"));
    scratches.push(records);

    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          spawn({
            binary: fake.path,
            cwd: fake.cwd,
            extraArgs: fake.extraArgs,
            bounds: { readiness: 10_000, poll: 25 },
          }),
          () => Effect.void,
        ),
      ),
    );

    expect(readdirSync(records)).toEqual([]);
    expect(await waitAllGone(readPids(fake.pidFile), 3_000)).toEqual([]);
  }, 20_000);
});
