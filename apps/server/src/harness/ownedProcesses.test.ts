/**
 * Regression tests for the startup reap of orphaned harness processes.
 *
 * They run against **real spawned processes**, because every property under test is a
 * property of the kernel's bookkeeping — pid identity, process groups, signal escalation
 * — and a double cannot have any of them. The processes are small detached `sh` loops
 * that this file spawns and tracks by pid, never matched globally: a `pgrep` would pick up
 * a concurrent test's processes and would also make these tests claim things about
 * processes they do not own.
 *
 * The test that matters most is the one asserting a *refusal*: a record whose pid is now
 * held by an unrelated process must leave that process alone. The leak this module fixes
 * is an annoyance; killing a stranger because it inherited a number would not be.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import {
  forgetOwnedProcess,
  leadsOwnGroup,
  ownedProcessDirectory,
  processIdentity,
  reapOwnedProcesses,
  recordOwnedProcess,
  renderReapOutcome,
  stopOwnedChild,
  trackProcessTree,
  type ProcessTree,
  type ReapBounds,
  type StopBounds,
} from "./ownedProcesses";

/** The approved scratch root for harness probes. */
const SCRATCH_ROOT = "/tmp/opencode/bit-harness";
mkdirSync(SCRATCH_ROOT, { recursive: true });

/** Short enough that escalation is exercised in well under a second. */
const BOUNDS: ReapBounds = { terminateGrace: 400, killGrace: 1_500, poll: 10 };

const scratches: string[] = [];
/**
 * What each test spawned, with its identity (`processIdentity`) as first seen: the teardown
 * signals a pid only while it is still that process (A7-S review 2), never a later one that
 * got the number.
 */
let spawned: { readonly pid: number; readonly identity: string | undefined }[] =
  [];
const own = (pid: number): void => {
  spawned.push({ pid, identity: processIdentity(pid) });
};

/**
 * A stand-in's endless loop, **for as long as this test process lives** (A7-S review 1):
 * the teardown SIGKILLs what was spawned, but a run killed from outside (`timeout`, an OOM
 * kill) runs no teardown, and every stand-in is detached into a group of its own, so it ran
 * on for hours. Polling the runner ends it within 0.2 s of the run's end instead.
 */
const LOOP_WHILE_RUNNER = `while kill -0 ${String(process.pid)} 2>/dev/null; do sleep 0.2; done`;
/** A tool stand-in (a CLI's Bash) that runs for as long, rather than a fixed `sleep 30`. */
const TOOL_WHILE_RUNNER = `sh -c '${LOOP_WHILE_RUNNER}'`;

const scratch = (): string => {
  const directory = mkdtempSync(join(SCRATCH_ROOT, "reap-"));
  scratches.push(directory);
  return directory;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (
  predicate: () => boolean,
  within = 3_000,
): Promise<boolean> => {
  const deadline = Date.now() + within;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(20);
  }
};

/**
 * A detached `sh` loop that leads its own process group, standing in for an orphaned
 * `opencode serve`.
 *
 * `detached` is the point: the thing being reaped is a group leader, so the reap has to
 * reach a group rather than a pid. `ignoresTerm` produces the escalation case, and
 * `withChild` gives the group a second member so "the group was swept" is observable.
 *
 * It is **awaited until it says it is set up**, and that is not fussiness. A pid exists
 * from the moment of the fork, well before the shell has run its `trap` or spawned its
 * child, so a reap fired immediately after spawning would signal a process whose
 * disposition for `SIGTERM` is still the default — and the escalation test would quietly
 * pass through the non-escalating path instead. The marker turns an ordering that
 * happened to hold into one that does.
 */
const sleeper = async (
  options: { ignoresTerm?: boolean; withChild?: boolean } = {},
): Promise<{ pid: number; childPidFile: string }> => {
  const directory = scratch();
  const childPidFile = join(directory, "child-pid");
  const readyFile = join(directory, "ready");
  const trap = options.ignoresTerm === true ? "trap '' TERM; " : "";
  const child =
    options.withChild === true
      ? `sh -c '${LOOP_WHILE_RUNNER}' & echo $! > ${childPidFile}; `
      : "";
  const process_ = Bun.spawn({
    cmd: [
      "sh",
      "-c",
      `${trap}${child}echo ready > ${readyFile}; ${LOOP_WHILE_RUNNER}`,
    ],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  own(process_.pid);
  const ready = await waitUntil(() => existsSync(readyFile));
  expect(ready).toBe(true);
  return { pid: process_.pid, childPidFile };
};

const recordedChildPid = (file: string): number | undefined => {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/** A pid nothing holds: taken from a process spawned only to be waited out. */
const recycledPid = async (): Promise<number> => {
  const process_ = Bun.spawn({
    cmd: ["sh", "-c", "exit 0"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const { pid } = process_;
  await process_.exited;
  await waitUntil(() => processIdentity(pid) === undefined);
  return pid;
};

const reap = (directory: string) =>
  Effect.runPromise(reapOwnedProcesses(directory, BOUNDS));

afterEach(async () => {
  for (const { pid, identity } of spawned) {
    const now = processIdentity(pid);
    // Alive as another process: the number was handed on, and that one is not ours.
    if (now !== undefined && identity !== undefined && now !== identity)
      continue;
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
  spawned = [];
  await Bun.sleep(25);
  for (const directory of scratches.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ownedProcessDirectory", () => {
  test("is derived from the fleet root, so two installations cannot collide", () => {
    const one = ownedProcessDirectory("/fleets/alpha");
    const two = ownedProcessDirectory("/fleets/beta");
    expect(one).not.toBe(two);
    expect(one.startsWith("/fleets/alpha")).toBe(true);
    expect(two.startsWith("/fleets/beta")).toBe(true);
  });
});

describe("processIdentity", () => {
  test("answers for a live process and is stable across reads", () => {
    const first = processIdentity(process.pid);
    expect(first).toBeString();
    expect(processIdentity(process.pid)).toBe(first as string);
  });

  test("distinguishes two live processes", async () => {
    const one = await sleeper();
    const two = await sleeper();
    expect(processIdentity(one.pid)).toBeString();
    expect(processIdentity(two.pid)).toBeString();
    // Start times can collide at tick resolution, so the pair, not the stamp, is the
    // identity. What must never happen is a record matching a *different* pid.
    expect(one.pid).not.toBe(two.pid);
  });

  test("reports a pid nothing holds as gone", async () => {
    expect(processIdentity(await recycledPid())).toBeUndefined();
  });

  test("refuses the pids whose signals would reach everything", () => {
    // `kill(-0)` signals this process's group and `kill(-1)` every process the user
    // owns, so neither may ever be treated as an identifiable process.
    expect(processIdentity(0)).toBeUndefined();
    expect(processIdentity(1)).toBeUndefined();
    expect(processIdentity(-5)).toBeUndefined();
    expect(processIdentity(1.5)).toBeUndefined();
  });
});

describe("recordOwnedProcess", () => {
  test("writes one record per pid and forgets it again", async () => {
    const directory = join(scratch(), "nested", "records");
    const probe = await sleeper();
    const path = recordOwnedProcess(directory, {
      pid: probe.pid,
      command: "opencode serve --port=1",
    });
    expect(path).toBe(join(directory, `${String(probe.pid)}.json`));
    expect(existsSync(path as string)).toBe(true);
    forgetOwnedProcess(path as string);
    expect(existsSync(path as string)).toBe(false);
  });

  test("records nothing for a pid that is already gone", async () => {
    const directory = scratch();
    expect(
      recordOwnedProcess(directory, {
        pid: await recycledPid(),
        command: "opencode serve --port=1",
      }),
    ).toBeUndefined();
  });

  test("forgetting a record that is not there is not an error", () => {
    expect(() =>
      forgetOwnedProcess(join(scratch(), "never-written.json")),
    ).not.toThrow();
  });
});

describe("reapOwnedProcesses", () => {
  test("a directory that was never written reaps nothing", async () => {
    expect(await reap(join(scratch(), "absent"))).toEqual([]);
  });

  test("terminates a recorded process that outlived its scope", async () => {
    const directory = scratch();
    const probe = await sleeper();
    const path = recordOwnedProcess(directory, {
      pid: probe.pid,
      command: "opencode serve --port=1",
    });

    const outcomes = await reap(directory);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.state).toBe("terminated");
    expect(outcomes[0]?.pid).toBe(probe.pid);
    expect(await waitUntil(() => !alive(probe.pid))).toBe(true);
    // The record goes with the process: a second boot must not find it again.
    expect(existsSync(path as string)).toBe(false);
  });

  test("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const directory = scratch();
    const probe = await sleeper({ ignoresTerm: true });
    recordOwnedProcess(directory, {
      pid: probe.pid,
      command: "opencode serve --port=1",
    });

    const outcomes = await reap(directory);

    expect(outcomes[0]?.state).toBe("killed");
    expect(await waitUntil(() => !alive(probe.pid))).toBe(true);
  });

  test("reaches the processes the orphan started, not just the orphan", async () => {
    const directory = scratch();
    const probe = await sleeper({ withChild: true });
    expect(
      await waitUntil(() => recordedChildPid(probe.childPidFile) !== undefined),
    ).toBe(true);
    const child = recordedChildPid(probe.childPidFile) as number;
    expect(leadsOwnGroup(probe.pid)).toBe(true);
    recordOwnedProcess(directory, {
      pid: probe.pid,
      command: "opencode serve --port=1",
    });
    own(child);

    await reap(directory);

    // The leak is the whole owned tree, not the leader: a shell the server started holds
    // the port and the pipes just as effectively as the server does.
    expect(await waitUntil(() => !alive(child))).toBe(true);
  });

  test("does not signal a process that merely inherited the recorded pid", async () => {
    const directory = scratch();
    const stranger = await sleeper();
    // A record for a live pid, carrying an identity that is not that process's: exactly
    // the shape a recycled pid produces. Nothing may be signalled.
    writeFileSync(
      join(directory, `${String(stranger.pid)}.json`),
      JSON.stringify({
        pid: stranger.pid,
        identity: "starttime:1",
        command: "opencode serve --port=1",
        recordedAt: new Date().toISOString(),
      }),
    );

    const outcomes = await reap(directory);

    expect(outcomes[0]?.state).toBe("recycled");
    expect(outcomes[0]?.detail).toContain("nothing was signalled");
    await Bun.sleep(200);
    expect(alive(stranger.pid)).toBe(true);
    expect(existsSync(join(directory, `${String(stranger.pid)}.json`))).toBe(
      false,
    );
  });

  test("tidies a record whose process is already gone", async () => {
    const directory = scratch();
    const pid = await recycledPid();
    writeFileSync(
      join(directory, `${String(pid)}.json`),
      JSON.stringify({
        pid,
        identity: "starttime:1",
        command: "opencode serve --port=1",
        recordedAt: new Date().toISOString(),
      }),
    );

    const outcomes = await reap(directory);

    expect(outcomes[0]?.state).toBe("stale");
    expect(existsSync(join(directory, `${String(pid)}.json`))).toBe(false);
  });

  test("an undecodable record is reported and does not stop the sweep", async () => {
    const directory = scratch();
    writeFileSync(join(directory, "0000.json"), "{ not json at all");
    const probe = await sleeper();
    recordOwnedProcess(directory, {
      pid: probe.pid,
      command: "opencode serve --port=1",
    });

    const outcomes = await reap(directory);

    const states = outcomes.map((outcome) => outcome.state).sort();
    expect(states).toEqual(["terminated", "unreadable"]);
    // The point of the test: the good record was still acted on.
    expect(await waitUntil(() => !alive(probe.pid))).toBe(true);
    expect(existsSync(join(directory, "0000.json"))).toBe(false);
  });

  test("ignores files that are not records", async () => {
    const directory = scratch();
    writeFileSync(join(directory, "notes.txt"), "not a record");
    expect(await reap(directory)).toEqual([]);
    expect(existsSync(join(directory, "notes.txt"))).toBe(true);
  });

  test("one installation's sweep cannot reach another's child", async () => {
    const mine = scratch();
    const theirs = scratch();
    const myProbe = await sleeper();
    const theirProbe = await sleeper();
    recordOwnedProcess(mine, {
      pid: myProbe.pid,
      command: "opencode serve --port=1",
    });
    const theirRecord = recordOwnedProcess(theirs, {
      pid: theirProbe.pid,
      command: "opencode serve --port=2",
    });

    const outcomes = await reap(mine);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.pid).toBe(myProbe.pid);
    expect(await waitUntil(() => !alive(myProbe.pid))).toBe(true);
    // The other fleet root's server is untouched, record and process alike.
    expect(alive(theirProbe.pid)).toBe(true);
    expect(existsSync(theirRecord as string)).toBe(true);
  });

  test("a second sweep over the same directory has nothing left to do", async () => {
    const directory = scratch();
    const probe = await sleeper();
    recordOwnedProcess(directory, {
      pid: probe.pid,
      command: "opencode serve --port=1",
    });

    await reap(directory);
    expect(await reap(directory)).toEqual([]);
  });
});

describe("renderReapOutcome", () => {
  test("names the pid when there is one and the record when there is not", () => {
    expect(
      renderReapOutcome({
        record: "/fleet/harness/owned-processes/42.json",
        pid: 42,
        state: "terminated",
        detail: "opencode serve --port=1 was terminated",
      }),
    ).toBe("pid 42: terminated — opencode serve --port=1 was terminated");
    expect(
      renderReapOutcome({
        record: "/fleet/harness/owned-processes/bad.json",
        pid: undefined,
        state: "unreadable",
        detail: "dropped an undecodable record",
      }),
    ).toBe(
      "/fleet/harness/owned-processes/bad.json: unreadable — dropped an undecodable record",
    );
  });
});

/* ── Stopping a spawned child and everything it started ──────────────────────── */

describe("stopOwnedChild", () => {
  const STOP: StopBounds = { terminateGrace: 300, killGrace: 1_000, poll: 10 };

  /**
   * A detached `sh` running `body`, standing in for a Claude Code CLI, and the stop's view
   * of it. Waits for the `ready` marker, for the reason {@link sleeper} gives.
   */
  const standIn = async (body: (directory: string) => string) => {
    const directory = scratch();
    const readyFile = join(directory, "ready");
    const child = Bun.spawn({
      cmd: [
        "sh",
        "-c",
        `${body(directory)}; echo ready > ${readyFile}; ${LOOP_WHILE_RUNNER}`,
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    own(child.pid);
    const tree = trackProcessTree(child.pid, leadsOwnGroup(child.pid));
    expect(await waitUntil(() => existsSync(readyFile))).toBe(true);
    const stoppable = {
      pid: child.pid,
      tree,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      kill: (signal: NodeJS.Signals) => {
        child.kill(signal);
      },
    };
    return { child, directory, stoppable };
  };

  const pidIn = async (file: string): Promise<number> => {
    expect(await waitUntil(() => recordedChildPid(file) !== undefined)).toBe(
      true,
    );
    const pid = recordedChildPid(file) as number;
    own(pid);
    return pid;
  };

  test("reaches a tool in a session of its own when the CLI has to be killed", async () => {
    /*
     * Claude Code 2.1.310 starts each Bash tool with `setsid`, out of the CLI's group, so a
     * group kill alone leaves it running (A6 F5's third review). `trap '' TERM` is inherited
     * through `setsid` and `exec`, so neither goes on `SIGTERM` and this is the kill path.
     */
    const { directory, stoppable } = await standIn(
      (dir) =>
        `trap '' TERM; setsid ${TOOL_WHILE_RUNNER} & echo $! > ${join(dir, "tool")}`,
    );
    const tool = await pidIn(join(directory, "tool"));
    expect(processIdentity(tool)).toBeDefined();

    const outcome = await Effect.runPromise(stopOwnedChild(stoppable, STOP));

    expect(outcome).toBe("killed");
    expect(alive(stoppable.pid)).toBe(false);
    expect(processIdentity(tool)).toBeUndefined();
  });

  test("a tool started while the stop waits is caught and killed too", async () => {
    // On `SIGTERM` the stand-in starts a fresh tool in its own session, as a CLI mid-step
    // can; only a tree read again while waiting knows it exists.
    const { directory, stoppable } = await standIn(
      (dir) =>
        `trap 'setsid sh -c "${LOOP_WHILE_RUNNER}" & echo $! > ${join(dir, "late")}' TERM`,
    );

    const outcome = await Effect.runPromise(stopOwnedChild(stoppable, STOP));
    const late = recordedChildPid(join(directory, "late"));

    expect(outcome).toBe("killed");
    expect(late).toBeDefined();
    if (late !== undefined) own(late);
    expect(
      late === undefined ? undefined : processIdentity(late),
    ).toBeUndefined();
  });

  test("what a CLI that died on its own left in its group is still stopped", async () => {
    const directory = scratch();
    const toolFile = join(directory, "tool");
    const child = Bun.spawn({
      cmd: ["sh", "-c", `${TOOL_WHILE_RUNNER} & echo $! > ${toolFile}; exit 3`],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    own(child.pid);
    const tree = trackProcessTree(child.pid, leadsOwnGroup(child.pid));
    const tool = await pidIn(toolFile);
    await child.exited;
    // What the harness does straight after the runtime reports the exit.
    tree.adoptOrphanedGroup();

    const outcome = await Effect.runPromise(
      stopOwnedChild(
        { pid: child.pid, tree, exited: () => true, kill: () => undefined },
        STOP,
      ),
    );

    expect(outcome).toBe("terminated");
    expect(processIdentity(tool)).toBeUndefined();
  });

  test("each poll reads procfs once, on the SIGKILL leg too", async () => {
    /*
     * A6 F5's fourth review: a read is every `/proc/<pid>/stat` on the machine, ~3.6 ms
     * with ~430 processes, and the `SIGKILL` leg asked "alive?" then signalled — two reads
     * a poll, ~70% of the event loop for up to a second per CLI. A tree that never dies,
     * under a child that has exited, holds the stop on that leg for the whole bound.
     */
    let reads = 0;
    let kills = 0;
    const read = () => {
      reads += 1;
    };
    const tree: ProcessTree = {
      refresh: read,
      alive: () => {
        read();
        return true;
      },
      signal: (signal) => {
        read();
        if (signal === "SIGKILL") kills += 1;
      },
      look: () => {
        read();
        return {
          alive: true,
          signal: (signal) => {
            if (signal === "SIGKILL") kills += 1;
          },
        };
      },
      adoptOrphanedGroup: () => undefined,
    };

    const outcome = await Effect.runPromise(
      stopOwnedChild(
        { pid: 1, tree, exited: () => true, kill: () => undefined },
        { terminateGrace: 50, killGrace: 250, poll: 25 },
      ),
    );

    expect(outcome).toBe("survived");
    // Each SIGKILL rode on a read the poll had already taken; the rest are the SIGTERM
    // leg's looks (one before the signal, about two per 50 ms grace) and the final look
    // that found the bound spent.
    expect(kills).toBeGreaterThanOrEqual(5);
    expect(reads).toBeLessThanOrEqual(kills + 5);
  });

  test("a stop for a child whose pid now leads a stranger's group signals nothing", async () => {
    /*
     * A6 F5's third review: a CLI that had exited was probed with `kill(-pid, 0)` and, if
     * something held the group, signalled — at a recycled pid, that is a stranger. The
     * stranger here leads its own group, and the tree was taken with an identity that is
     * not its own: exactly what a recycled pid looks like.
     */
    const stranger = await sleeper({ withChild: true });
    expect(leadsOwnGroup(stranger.pid)).toBe(true);
    const strangerChild = await pidIn(stranger.childPidFile);
    let killed = 0;
    // Built as a value, not a literal, so the shape the stop used to take — `ownsGroup` —
    // can ride along: it is what the stop decided from before identities were checked.
    const child = {
      pid: stranger.pid,
      ownsGroup: true,
      tree: trackProcessTree(stranger.pid, true, "starttime:1"),
      exited: () => true,
      kill: () => {
        killed += 1;
      },
    };

    const outcome = await Effect.runPromise(stopOwnedChild(child, STOP));

    expect(outcome).toBe("already_gone");
    expect(killed).toBe(0);
    await Bun.sleep(100);
    expect(alive(stranger.pid)).toBe(true);
    expect(alive(strangerChild)).toBe(true);
  });
});
