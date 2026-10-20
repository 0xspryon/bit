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
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import {
  drain,
  LineRing,
  OpenCodeServer,
  serverEnvironment,
  spawnServer,
} from "./openCodeServer";

/** The approved scratch root for harness probes. */
const SCRATCH_ROOT = "/tmp/opencode/bit-harness";
mkdirSync(SCRATCH_ROOT, { recursive: true });

const scratches: string[] = [];
/** Pid files written by the probes of the test currently running. */
let pidFiles: string[] = [];

const readPids = (file: string): number[] => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  } catch {
    // The probe never got as far as writing one.
    return [];
  }
};

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
    for (const pid of readPids(file)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Not a group leader, or already gone.
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  pidFiles = [];
};

afterEach(reapProbes);

afterAll(() => {
  reapProbes();
  for (const directory of scratches) {
    rmSync(directory, { recursive: true, force: true });
  }
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
  return { path, cwd, pidFile, extraArgs: [`--pidfile=${pidFile}`] };
};

const PID_PRELUDE = `
import { appendFileSync } from "node:fs";
const pidFile = (Bun.argv.find((a) => a.startsWith("--pidfile=")) ?? "").slice(10);
const recordPid = (pid) => { if (pidFile !== "") appendFileSync(pidFile, pid + "\\n"); };
recordPid(process.pid);
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
  cmd: ["sh", "-c", "trap '' TERM; echo holder $$; while true; do sleep 0.2; done"],
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
  detached: ${String(escape)},
});
recordPid(holder.pid);
`;

const spawn = (options: Parameters<typeof spawnServer>[0]) =>
  spawnServer(options);

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
