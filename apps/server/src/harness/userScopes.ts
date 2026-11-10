/**
 * One systemd **user scope** per agent process: a cgroup that holds the process and
 * everything it ever starts, so ending the session can end all of it (operator decision,
 * 2026-11-10, for Pi; slice 2 review M1).
 *
 * ## Why a cgroup, and why this one
 *
 * `ownedProcesses.ts` follows an agent's process tree through `/proc`, by parent and by
 * process group. A tool that detaches itself before the next look — Pi runs every bash call
 * as its own `bash -c` in a session of its own, and a call that only backgrounds a job
 * (`nohup sleep 777 &`) returns at once, its job reparented to the user's systemd — is not
 * reached, and survived End, server shutdown and the startup reaper (measured on Pi 1.5.2).
 * A cgroup is inherited by every child at `fork`, whatever it does to its parent, group or
 * session afterwards, so membership is the kernel's fact rather than a tracker's guess.
 *
 * **`systemd-run --user --scope`**, rather than asking the user manager over D-Bus
 * ourselves. In scope mode `systemd-run` asks the manager for a transient scope holding its
 * *own* pid, waits for the job, and then `exec`s the command in place. So:
 *
 * - the process this server spawned *is* the agent from the first instruction it runs: same
 *   pid (the owned-process record and its start-time identity stay true), same stdin, stdout
 *   and stderr pipes, **the same fd 3** (nothing is closed across the `exec`; measured), the
 *   agent's own process title, and its own exit code or signal;
 * - there is no window in which the agent runs outside the scope: it is moved before it
 *   starts, where a D-Bus `StartTransientUnit` naming an already-running pid would race its
 *   first `fork`. And Bun has no D-Bus client; this costs one `exec` (~25 ms, measured).
 * - the scope is the user manager's, not this server's: it lives in the user's `app.slice`,
 *   **outside the server's own cgroup**. A memory cap on the server's unit no longer covers
 *   the agent (that is what {@link scopedCommand}'s `memoryMax` is for), and stopping the
 *   server's unit no longer kills its agents — the server's finalizers do on a `SIGTERM`, and
 *   the startup reaper ({@link reapUserScopes}) does after a `SIGKILL`.
 *
 * `--expand-environment=no` is load-bearing: by default `systemd-run` expands `$NAME` in the
 * command line (measured: `$$` became `$`), and an agent's arguments carry operator text.
 *
 * Nothing secret goes through here. The agent's credential is on fd 3, which `systemd-run`
 * passes on untouched and never reads; a scope has no `Environment=`, and the unit's
 * description is set, so `systemctl --user show` shows neither the environment nor the
 * command line.
 *
 * ## Stopping, and what is ours
 *
 * Unit names are `bit-pi-<server>-<session>-<nonce>.scope`. `<server>` is a short hash of
 * this installation's fleet root ({@link serverScopeId}), so the several bit servers on one
 * machine (worktrees, data folders) never list or stop each other's scopes; `<nonce>` is per
 * process, so a session resumed while its previous process is still being stopped never
 * collides with it.
 *
 * A live scope is stopped through its cgroup files, not `systemctl`: `cgroup.procs` for a
 * `SIGTERM` to every member and `cgroup.kill` for the `SIGKILL` (the kernel kills the whole
 * subtree atomically, a process forking meanwhile included), `cgroup.events`'s `populated`
 * for "is anything left". All synchronous and spawn-free, so they fit `stopOwnedChild`'s
 * poll loop as a {@link ProcessTree}. Once empty, the user manager unloads the scope by
 * itself; one that ended `failed` (an OOM kill) is cleared with `reset-failed`.
 *
 * **Not a sandbox.** The user owns the cgroup tree the user manager delegates, so a process
 * that means to can move itself out (`echo $$ > …/app.slice/cgroup.procs`). This contains
 * what an agent leaves running by accident, as the tree tracker did, without its gaps.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Duration, Effect } from "effect";

import type { ProcessTree, TreeLook } from "./ownedProcesses";

/** Where the unified cgroup hierarchy is mounted. */
const CGROUP_ROOT = "/sys/fs/cgroup";

/** Every Pi scope of every bit server starts with this: `systemctl --user list-units 'bit-pi-*'`. */
export const PI_SCOPE_PREFIX = "bit-pi-";

/**
 * How long the user manager gives a scope's processes after `SIGTERM` when *it* stops the
 * scope (the reaper's `systemctl stop`), before `SIGKILL`. Its default is 90 s.
 */
const STOP_TIMEOUT = "3s";

/** How long one `systemctl`/`systemd-run` call may take. */
const COMMAND_TIMEOUT: Duration.Input = "15 seconds";

/**
 * A short, stable id for one installation: the first 12 hex digits of the SHA-256 of its
 * fleet root, resolved. Two servers on two `HUNT_ROOT`s get two ids; the same root after a
 * restart gets the same one, which is what lets the reaper find what a killed run left.
 */
export const serverScopeId = (huntRoot: string): string => {
  let path: string;
  try {
    path = realpathSync(huntRoot);
  } catch {
    // Not created yet: the resolved spelling is what the first boot will create.
    path = resolve(huntRoot);
  }
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
};

/** The prefix of every Pi scope one installation starts: `bit-pi-<server>-`. */
export const piScopePrefix = (serverId: string): string =>
  `${PI_SCOPE_PREFIX}${serverId}-`;

/** What a working probe found: everything a scope needs, decided once at startup. */
export interface UserScopes {
  /** Every unit this server starts begins with it, and no other server's does. */
  readonly prefix: string;
  /**
   * The cgroup the user manager makes scopes in, relative to the cgroup root (measured:
   * `/user.slice/user-<uid>.slice/user@<uid>.service/app.slice`). A scope's own cgroup is
   * this plus its unit name.
   */
  readonly slice: string;
  /** Whether the memory controller can be given to a scope, so `MemoryMax` is enforced. */
  readonly memoryController: boolean;
}

/** Whether this server can contain its agents, and if not, why not in one sentence. */
export type ScopeAvailability =
  | { readonly _tag: "available"; readonly scopes: UserScopes }
  | { readonly _tag: "unavailable"; readonly reason: string };

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one short command to completion, bounded; fails with a sentence. */
const run = (
  file: string,
  args: readonly string[],
): Effect.Effect<Ran, string> =>
  Effect.callback<Ran, string>((resume) => {
    let child: ChildProcess;
    let done = false;
    const finish = (result: Effect.Effect<Ran, string>) => {
      if (done) return;
      done = true;
      resume(result);
    };
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      finish(Effect.fail(`could not run ${file}: ${String(cause)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      stdout += data;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => {
      stderr = (stderr + data).slice(-2_048);
    });
    child.once("error", (cause) =>
      finish(
        Effect.fail(
          (cause as NodeJS.ErrnoException).code === "ENOENT"
            ? `${file} is not installed`
            : `could not run ${file}: ${cause.message}`,
        ),
      ),
    );
    child.once("close", (code) =>
      finish(Effect.succeed({ code, stdout, stderr })),
    );
    return Effect.sync(() => {
      done = true;
      child.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: COMMAND_TIMEOUT,
      orElse: () => Effect.fail(`${file} did not finish in time`),
    }),
  );

const nonce = (): string => randomBytes(3).toString("hex");

/** A file's text, or `undefined` when it cannot be read. */
const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The flags every scope is started with, the probe's included, so the probe proves them. */
const scopeFlags = (
  unit: string,
  description: string,
  properties: readonly string[],
): string[] => [
  "--user",
  "--scope",
  "--quiet",
  "--expand-environment=no",
  `--unit=${unit}`,
  `--description=${description}`,
  "-p",
  `TimeoutStopSec=${STOP_TIMEOUT}`,
  ...properties.flatMap((property) => ["-p", property]),
];

/**
 * Asks the user manager for one throwaway scope (`cat /proc/self/cgroup` in it) and reads
 * where it ran: the same flags every real scope uses, so a `systemd-run` too old for one of
 * them, a user manager that cannot be reached, or a cgroup v1 system all answer
 * `unavailable` here, once, instead of failing a session later. ~25 ms.
 */
export const probeUserScopes = (
  prefix: string,
): Effect.Effect<ScopeAvailability> =>
  Effect.gen(function* () {
    const unavailable = (reason: string): ScopeAvailability => ({
      _tag: "unavailable",
      reason,
    });
    if (process.platform !== "linux") {
      return unavailable("systemd user scopes exist only on Linux");
    }
    const unit = `${prefix}probe-${nonce()}.scope`;
    const ran = yield* Effect.result(
      run("systemd-run", [
        ...scopeFlags(unit, "bit: can Pi sessions be contained", []),
        "--",
        "cat",
        "/proc/self/cgroup",
      ]),
    );
    if (ran._tag === "Failure") return unavailable(ran.failure);
    if (ran.success.code !== 0) {
      const said = ran.success.stderr.trim().split("\n").at(-1) ?? "";
      return unavailable(
        `systemd-run --user --scope failed: ${said === "" ? `exit ${String(ran.success.code)}` : said}`,
      );
    }
    const line = ran.success.stdout
      .split("\n")
      .find((each) => each.startsWith("0::"));
    if (line === undefined) {
      return unavailable(
        "the scope did not run on the unified (v2) cgroup hierarchy",
      );
    }
    const path = line.slice(3).trim();
    if (!path.endsWith(`/${unit}`)) {
      return unavailable(
        `a probe scope ran in ${path}, not in its own cgroup ${unit}`,
      );
    }
    const slice = dirname(path);
    const controllers = readText(
      join(CGROUP_ROOT, slice, "cgroup.controllers"),
    );
    if (controllers === undefined) {
      return unavailable(
        `the scopes' cgroup ${join(CGROUP_ROOT, slice)} cannot be read`,
      );
    }
    return {
      _tag: "available",
      scopes: {
        prefix,
        slice,
        memoryController: controllers.split(/\s+/).includes("memory"),
      },
    } satisfies ScopeAvailability;
  });

/** A fresh unit name for one process of `sessionId`. */
export const scopeUnitFor = (scopes: UserScopes, sessionId: string): string =>
  `${scopes.prefix}${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}-${nonce()}.scope`;

/**
 * The command that runs `file args…` in a new scope `unit`. With `memoryMax` (systemd's
 * syntax: `2G`), the scope is capped there with no swap, and **stopped whole** when the
 * kernel kills anything in it for memory (`OOMPolicy=stop`): an agent whose shell was
 * killed under it would otherwise carry on, its tool failing for a reason nobody is told.
 */
export const scopedCommand = (
  unit: string,
  input: {
    readonly description: string;
    readonly memoryMax: string | undefined;
    readonly file: string;
    readonly args: readonly string[];
  },
): { readonly file: string; readonly args: readonly string[] } => ({
  file: "systemd-run",
  args: [
    ...scopeFlags(
      unit,
      input.description,
      input.memoryMax === undefined
        ? []
        : [`MemoryMax=${input.memoryMax}`, "MemorySwapMax=0", "OOMPolicy=stop"],
    ),
    "--",
    input.file,
    ...input.args,
  ],
});

/** Every pid in a cgroup and the cgroups under it. */
const membersOf = (directory: string): number[] => {
  const pids: number[] = [];
  const visit = (path: string) => {
    try {
      for (const line of readFileSync(join(path, "cgroup.procs"), "utf8").split(
        "\n",
      )) {
        const pid = Number(line);
        if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid);
      }
    } catch {
      return; // Gone, or never made.
    }
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(path, entry.name));
      }
    } catch {
      // Gone between the two reads.
    }
  };
  visit(directory);
  return pids;
};

/** One `key value` line of a cgroup's flat-keyed file, as a number. */
const cgroupCount = (
  directory: string,
  file: string,
  key: string,
): number | undefined => {
  try {
    const match = new RegExp(`^${key} (\\d+)$`, "m").exec(
      readFileSync(join(directory, file), "utf8"),
    );
    return match === null ? undefined : Number(match[1]);
  } catch {
    return undefined;
  }
};

/**
 * One scope, seen through its cgroup: a {@link ProcessTree} for `stopOwnedChild`, and what
 * the process's death needs to be told apart from a crash.
 */
export interface ScopeHandle extends ProcessTree {
  readonly unit: string;
  /** The scope's cgroup directory. */
  readonly directory: string;
  /**
   * Whether the kernel killed anything in the scope for memory: the cgroup's own
   * `oom_kill` count while the cgroup lasts (or as last seen by a refresh), else the user
   * manager's verdict on the unit (`Result=oom-kill`).
   */
  readonly outOfMemory: Effect.Effect<boolean>;
  /** Clears a scope that ended `failed` from the user manager. Never fails. */
  readonly release: Effect.Effect<void>;
}

export const scopeHandle = (scopes: UserScopes, unit: string): ScopeHandle => {
  const directory = join(CGROUP_ROOT, scopes.slice, unit);
  /** The scope's cgroup (subtree included) still holds a process. */
  const populated = (): boolean => {
    try {
      return /^populated 1$/m.test(
        readFileSync(join(directory, "cgroup.events"), "utf8"),
      );
    } catch {
      return false; // No cgroup: never made, or emptied and removed.
    }
  };
  const signal = (sig: NodeJS.Signals) => {
    if (sig === "SIGKILL") {
      try {
        // The whole subtree, atomically: nothing forks its way past it.
        writeFileSync(join(directory, "cgroup.kill"), "1");
        return;
      } catch {
        // A kernel before 5.14, or the cgroup is gone: one by one below.
      }
    }
    for (const pid of membersOf(directory)) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, sig);
      } catch {
        // Exited between the read and the signal.
      }
    }
  };
  let sawOom = false;
  const noteOom = () => {
    if ((cgroupCount(directory, "memory.events", "oom_kill") ?? 0) > 0)
      sawOom = true;
    return sawOom;
  };
  const look = (): TreeLook => ({ alive: populated(), signal });
  return {
    unit,
    directory,
    refresh: () => {
      noteOom();
    },
    look,
    alive: populated,
    signal,
    // A scope holds everything already; there is no group to adopt.
    adoptOrphanedGroup: () => undefined,
    outOfMemory: Effect.suspend(() =>
      noteOom()
        ? Effect.succeed(true)
        : run("systemctl", [
            "--user",
            "show",
            "--property=Result",
            "--value",
            unit,
          ]).pipe(
            Effect.map((ran) => ran.stdout.trim() === "oom-kill"),
            Effect.orElseSucceed(() => false),
          ),
    ),
    release: Effect.ignore(run("systemctl", ["--user", "reset-failed", unit])),
  };
};

/** What the startup reaper did with one leftover scope. */
export interface ScopeReapOutcome {
  readonly unit: string;
  readonly state: "stopped" | "cleared" | "survived";
  readonly detail: string;
}

export const renderScopeReapOutcome = (outcome: ScopeReapOutcome): string =>
  `${outcome.unit}: ${outcome.state} — ${outcome.detail}`;

/** The processes in a cgroup, named, for the reaper's line: `sleep (4211), bash (4210)`. */
const describeMembers = (directory: string): string => {
  const named = membersOf(directory).map((pid) => {
    let comm = "?";
    try {
      comm = readFileSync(`/proc/${String(pid)}/comm`, "utf8").trim();
    } catch {
      // Exited meanwhile.
    }
    return `${comm} (${String(pid)})`;
  });
  return named.length === 0 ? "no process" : named.join(", ");
};

/** `key=value` lines of `systemctl show`. */
const properties = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split("\n").flatMap((line) => {
      const at = line.indexOf("=");
      return at <= 0 ? [] : [[line.slice(0, at), line.slice(at + 1)] as const];
    }),
  );

/**
 * Stops every scope whose name starts with `prefix` — at startup, all of them were left by
 * an earlier run of this installation (a `SIGKILL`ed server, a `bun --watch` restart): its
 * Pi exited on its stdin's EOF, but what Pi's agent left running in the background is still
 * there. Failed scopes (an OOM kill nobody cleared) are cleared.
 *
 * **Before anything of this run's is spawned**, as for the owned-process records: a scope
 * of this run's own would be indistinguishable from a leftover.
 *
 * Only ever the units `systemctl --user list-units '<prefix>*'` lists *and* whose names
 * start with `prefix`, which holds this server's id: never another server's. Cannot fail:
 * no user manager means nothing to reap.
 */
export const reapUserScopes = (
  prefix: string,
): Effect.Effect<readonly ScopeReapOutcome[]> =>
  Effect.gen(function* () {
    if (process.platform !== "linux") return [];
    const listed = yield* Effect.result(
      run("systemctl", [
        "--user",
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--full",
        `${prefix}*`,
      ]),
    );
    if (listed._tag === "Failure" || listed.success.code !== 0) return [];
    const units = listed.success.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((unit) => unit.startsWith(prefix) && unit.endsWith(".scope"));
    const outcomes: ScopeReapOutcome[] = [];
    for (const unit of units) {
      const shown = yield* Effect.result(
        run("systemctl", [
          "--user",
          "show",
          "--property=ActiveState,ControlGroup,Result",
          unit,
        ]),
      );
      const props =
        shown._tag === "Success"
          ? properties(shown.success.stdout)
          : new Map<string, string>();
      const state = props.get("ActiveState") ?? "unknown";
      const group = props.get("ControlGroup") ?? "";
      if (state === "failed" || state === "inactive") {
        yield* Effect.ignore(
          run("systemctl", ["--user", "reset-failed", unit]),
        );
        outcomes.push({
          unit,
          state: "cleared",
          detail: `it had already ended (${props.get("Result") ?? state}); its record was cleared`,
        });
        continue;
      }
      const held =
        group === ""
          ? "its processes"
          : describeMembers(join(CGROUP_ROOT, group));
      const stopped = yield* Effect.result(
        run("systemctl", ["--user", "stop", unit]),
      );
      yield* Effect.ignore(run("systemctl", ["--user", "reset-failed", unit]));
      const after = yield* Effect.result(
        run("systemctl", [
          "--user",
          "show",
          "--property=ActiveState",
          "--value",
          unit,
        ]),
      );
      const still =
        after._tag === "Success" &&
        ["active", "activating", "deactivating"].includes(
          after.success.stdout.trim(),
        );
      outcomes.push(
        stopped._tag === "Success" && stopped.success.code === 0 && !still
          ? { unit, state: "stopped", detail: `stopped ${held}` }
          : {
              unit,
              state: "survived",
              detail: `could not stop ${held}: ${
                stopped._tag === "Failure"
                  ? stopped.failure
                  : stopped.success.stderr.trim() ||
                    `exit ${String(stopped.success.code)}`
              }`,
            },
      );
    }
    return outcomes;
  });
