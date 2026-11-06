/**
 * Inspecting, signalling and *outliving* the OS processes this server owns.
 *
 * `harness/openCodeServer.ts` owns one `opencode serve` for the lifetime of a scope, and
 * does it correctly: it spawns `detached` so the child leads its own process group,
 * terminates that group after verifying against the kernel that it is the child's own,
 * waits, escalates, waits again. Every exit that closes the scope cleans up — `SIGINT`
 * and `SIGTERM` included, because `runMain` turns those into an interrupt of the main
 * fiber.
 *
 * This file exists because **`bun --watch` does not close the scope.** That was measured,
 * not assumed, and the measurement is the reason everything below has the shape it has:
 *
 * - A watch restart reuses the *same* process. The pid never changes; `bun` resets the
 *   module registry and re-evaluates the entrypoint in place.
 * - Before it does, it delivers `SIGTERM` to itself, so a `process.on("SIGTERM")` handler
 *   is genuinely invoked.
 * - It then tears the old JavaScript context down in the same tick. A handler's
 *   *synchronous* body runs to completion; after it returns, **nothing asynchronous ever
 *   runs again** — not a `setTimeout(…, 0)`, not a `process.nextTick`, not a
 *   `queueMicrotask`, not a resolved promise's `.then`.
 *
 * So the signal arrives and cannot be acted on. Effect's finalizers are asynchronous by
 * construction: an interrupt is delivered to the main fiber, which then has to step
 * through the finalizer chain, and the chain here awaits `child.exited` under a timeout.
 * None of that gets a turn. Fixing the *handling* is not available at any price — which is
 * why this is a reaper rather than a better signal handler. The orphan is created by a
 * parent that cannot cooperate, so it is cleaned up by the boot that follows instead.
 *
 * The record is a directory of one small JSON file per owned process, named for its pid.
 * That naming is the concurrency design: a pid is held by at most one live process, so
 * writing a record for a pid can only ever overwrite a stale one, and two servers never
 * contend for the same file. Nothing is appended, nothing is rewritten, so there is no
 * read-modify-write to lose.
 *
 * Three properties, each of which is a way this could be worse than the leak it fixes:
 *
 * 1. **It must not kill the wrong process.** A recorded pid is not an identity — pids are
 *    recycled — so every record carries the kernel's own start-time stamp for that pid,
 *    and nothing is signalled unless the stamp still matches. {@link processIdentity} is
 *    that check; a pid whose stamp has changed is reported `recycled` and left alone.
 * 2. **It must not kill another installation's child.** The directory lives under the
 *    fleet root ({@link ownedProcessDirectory}), so two servers on two `HUNT_ROOT`s record
 *    into two places and neither can see the other's processes.
 * 3. **It must not refuse to boot.** Every filesystem and signalling step is fallible and
 *    every one of them is contained: a missing directory reaps nothing, an unreadable
 *    record is reported and dropped, a process that will not die is reported and its
 *    record kept for the next boot. This is housekeeping, not a safety property.
 *
 * The process-inspection primitives live here rather than in `openCodeServer.ts` because
 * both callers need exactly the same kernel checks and a safety check that exists twice
 * is a safety check that can drift. `processGroupOf` and `signalGroup` are as they were,
 * including their debt to T3Code's `packages/provider-core/src/server/processGroup.ts`
 * (MIT) for the `kill(-pid)` guard.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Effect, Schema } from "effect";

/**
 * Where an installation's owned-process records live.
 *
 * Under the fleet root, which is what scopes the reap: a server on another `HUNT_ROOT`
 * records elsewhere and so cannot be reaped by this one. The fleet root is also already
 * gitignored and already the place this installation's mutable state goes.
 */
export const ownedProcessDirectory = (huntRoot: string): string =>
  join(huntRoot, "harness", "owned-processes");

/**
 * The numeric fields of `/proc/<pid>/stat`, counted from after `comm`.
 *
 * `comm` is parenthesised and may itself contain spaces and parentheses, so the fields
 * are taken from after the *last* `")"`. Index 0 is then `state`, which is field 3 of the
 * documented layout; the named offsets below are all relative to that.
 */
const procFields = (pid: number): readonly string[] | undefined => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return undefined;
  }
};

/** `state`, field 3. */
const PROC_STATE = 0;
/** `ppid`, field 4. */
const PROC_PARENT = 1;
/** `pgrp`, field 5. */
const PROC_GROUP = 2;
/** `starttime`, field 22: clock ticks since boot, and so fixed for a process's life. */
const PROC_START_TIME = 19;

/**
 * The same three facts from `ps`, for a system with no procfs.
 *
 * `lstart` is a date with spaces in it, so it is asked for last and reassembled from
 * whatever is left after the two fixed fields.
 */
const psFields = (pid: number): readonly string[] | undefined => {
  try {
    const probe = Bun.spawnSync([
      "ps",
      "-o",
      "state=,pgid=,lstart=",
      "-p",
      String(pid),
    ]);
    if (!probe.success) return undefined;
    const fields = probe.stdout.toString().trim().split(/\s+/);
    return fields.length >= 3 ? fields : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The POSIX process group a pid belongs to, or `undefined` if we cannot tell.
 *
 * `detached: true` *asks* for `setsid()`, and asking is not evidence. We read the
 * kernel's answer, because the cost of being wrong is signalling a group we do not own
 * — which on a shared group id would include this process and everything else the user
 * is running in it.
 */
const processGroupOf = (pid: number): number | undefined => {
  const parse = (pgid: number): number | undefined =>
    Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
  const proc = procFields(pid);
  if (proc !== undefined) return parse(Number(proc[PROC_GROUP]));
  const ps = psFields(pid);
  return ps === undefined ? undefined : parse(Number(ps[1]));
};

/** Whether `pid` leads its own process group, so `kill(-pid)` reaches only our tree. */
export const leadsOwnGroup = (pid: number): boolean =>
  Number.isSafeInteger(pid) && pid > 1 && processGroupOf(pid) === pid;

/**
 * A token that identifies *which* process currently holds `pid`, or `undefined` if none
 * does.
 *
 * This is the whole basis on which the reaper is allowed to signal anything. A pid on its
 * own identifies nothing durable — the kernel recycles them, and a dev loop that spawns a
 * process per restart is a machine that churns through them — so a record pairs the pid
 * with the kernel's start-time stamp for it. Comparing the stamp turns "something is
 * alive at pid 4211" into "the process we spawned is alive at pid 4211".
 *
 * Two details that are load-bearing rather than incidental:
 *
 * - The token is **tagged with its source**. A stamp read from procfs is clock ticks since
 *   boot and a stamp read from `ps` is a wall-clock date; comparing one with the other
 *   would be comparing unrelated numbers, and the tag makes that impossible instead of
 *   unlikely.
 * - A **zombie is reported as gone**. It is a wait status rather than a process: it holds
 *   no port, no pipe and no CPU, and no signal will move it. Calling it live would make
 *   the reaper escalate to `SIGKILL` and then report a process that survived it — which is
 *   exactly what a watch restart produces, since the restarted process is still the
 *   orphan's parent and nothing in the new context will ever `wait()` for it.
 */
export const processIdentity = (pid: number): string | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const proc = procFields(pid);
  if (proc !== undefined) {
    const state = proc[PROC_STATE];
    const startTime = proc[PROC_START_TIME];
    if (state === undefined || startTime === undefined || startTime === "") {
      return undefined;
    }
    return state.startsWith("Z") ? undefined : `starttime:${startTime}`;
  }
  const ps = psFields(pid);
  if (ps === undefined) return undefined;
  if (ps[0]?.startsWith("Z") !== false) return undefined;
  const started = ps.slice(2).join(" ");
  return started === "" ? undefined : `lstart:${started}`;
};

/**
 * Signals the owned process group, as T3Code's `signalProcessGroup`
 * (`packages/provider-core/src/server/processGroup.ts`) does.
 *
 * Guarded twice over: callers only reach here for a child verified to lead its own
 * group, and a pid of 0 or 1 is refused outright, because `kill(-0)` signals *this*
 * process's group and `kill(-1)` every process the user owns. Returns whether the
 * group was there to be signalled, so `0` doubles as a liveness probe.
 */
export const signalGroup = (
  pid: number,
  signal: NodeJS.Signals | 0,
): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH: every member has already gone.
    return false;
  }
};

/**
 * One live process as procfs reports it: who its parent is, which group it is in, and the
 * {@link processIdentity} token that tells it from a later holder of the same pid.
 */
interface ProcEntry {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly identity: string;
}

/** Every live, non-zombie process in `/proc`, or `undefined` on a system without procfs. */
const listProcesses = (): readonly ProcEntry[] | undefined => {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const entries: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const fields = procFields(pid);
    if (fields === undefined) continue; // Exited between the listing and the read.
    const state = fields[PROC_STATE];
    const startTime = fields[PROC_START_TIME];
    if (state === undefined || state.startsWith("Z")) continue;
    if (startTime === undefined || startTime === "") continue;
    entries.push({
      pid,
      parent: Number(fields[PROC_PARENT]),
      group: Number(fields[PROC_GROUP]),
      identity: `starttime:${startTime}`,
    });
  }
  return entries;
};

/**
 * Sends `signal` to `pid` only if it is still the process `identity` names.
 *
 * The check and the `kill` are two system calls, so this narrows the reuse window to the
 * gap between them rather than closing it; a pidfd would close it, and Bun offers none.
 */
const signalVerified = (
  pid: number,
  identity: string,
  signal: NodeJS.Signals,
): void => {
  if (processIdentity(pid) !== identity) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Raced with its own exit.
  }
};

/**
 * A spawned process and everything it started, followed through procfs by identity.
 *
 * **Why a group is not enough.** A child spawned `detached` leads a process group, and
 * `kill(-pid)` reaches everything in it — but not what moved itself out. Claude Code
 * 2.1.310 starts every Bash tool in a session of its own (`pid = pgid = sid`), so on the
 * path a stop exists for — a CLI that would not go on `SIGTERM` and is `SIGKILL`ed — its
 * tools were reparented and ran on (A6 F5's third review: a `sleep 8; curl` reached its
 * listener 8 s after the CLI's group was killed). The CLI's own `SIGTERM` handler kills its
 * tools, which is why an ordinary end looked clean.
 *
 * So a tree is tracked, as pid *and* start time ({@link processIdentity}), and every
 * {@link ProcessTree.refresh} adds what has appeared under it:
 *
 * - every live process whose parent is a tracked process still holding its identity, and
 * - every member of a group led by a tracked process, while a tracked member is still in
 *   it — a live member keeps the group's id from being handed to a new process, so the id
 *   still names the group our process made.
 *
 * Nothing is signalled on the strength of a pid alone. A tracked pid whose identity has
 * changed was recycled and is dropped; a group is signalled only through a verified live
 * member of it, and never this server's own group. That is the PID-reuse guard the reaper
 * has always had ({@link processIdentity}), applied to every signal (A6 F5's third review:
 * a CLI that had already exited was probed with `kill(-pid, 0)` and its recycled pid's
 * group signalled).
 *
 * Linux only in full. Without procfs the tree is the root alone, checked through `ps`, and
 * its own group while the root is alive — what this did before.
 *
 * Known limit: a process that leaves the tree *and* has no tracked parent when it is first
 * looked for — reparented before a refresh saw it, say — is not reached. A cgroup per CLI
 * would contain everything; that is an operator decision, not this file's.
 */
export interface ProcessTree {
  /** Re-reads procfs: drops what has gone or been recycled, adds what appeared under it. */
  readonly refresh: () => void;
  /** Refreshes, then signals every verified group and every verified process in the tree. */
  readonly signal: (signal: NodeJS.Signals) => void;
  /** Refreshes, and says whether anything in the tree is still alive. */
  readonly alive: () => boolean;
  /**
   * Refreshes **once**, and answers both of the questions a stop asks on every poll from
   * that one read: whether anything is alive, and — if it goes on to ask — a signal to what
   * that read found. {@link alive} then {@link signal} would read procfs twice, and one read
   * is every `/proc/<pid>/stat` on the machine: a few milliseconds of blocked event loop
   * per read with a few hundred processes (A6 F5's fourth review).
   */
  readonly look: () => TreeLook;
  /**
   * Takes in the members of the root's own group once the root has exited, so that tools it
   * left running in its group are still reached.
   *
   * Only call this **straight after** the runtime has reported the root's exit, and only
   * for a root that led its group. The group's id is the root's pid, and a group that still
   * has members cannot have that id reused; but once the group is empty the pid is free, so
   * a late call could take in a stranger that came to lead a group under the same number.
   */
  readonly adoptOrphanedGroup: () => void;
}

/** One procfs read of a {@link ProcessTree}: see {@link ProcessTree.look}. */
export interface TreeLook {
  readonly alive: boolean;
  /** Signals the tree as this read found it, re-verifying each target at the last moment. */
  readonly signal: (signal: NodeJS.Signals) => void;
}

/*
 * V2(chat): an agent CLI and its tools are contained by tracking its process tree through
 * `/proc` (descendants, and members of groups they lead, by pid + start time) and
 * signalling what is found. A tool that detaches itself before the tree is next read — its
 * own session via `setsid`, a plugin's sync process, anything reparented within the 1 s
 * refresh — can escape, and nothing here limits what an escaped process does. Proper V2: a
 * cgroup per CLI, so everything it starts is contained and killed together.
 */
/**
 * Starts tracking `root`, which must have just been spawned by this process: its identity
 * is read now, so a root that has already exited gives an empty tree. `identity` is for a
 * caller that read it earlier — and for a test that needs a stale one.
 */
export const trackProcessTree = (
  root: number,
  ownsGroup: boolean,
  identity: string | undefined = processIdentity(root),
): ProcessTree => {
  /** Tracked pid → the identity it had when it was taken in. */
  const tracked = new Map<number, string>();
  /** Every pid ever tracked, with its identity: who may lead a group we signal. */
  const ever = new Map<number, string>();
  const ownGroup = processGroupOf(process.pid);
  const signallable = (group: number): boolean =>
    Number.isSafeInteger(group) && group > 1 && group !== ownGroup;

  const take = (pid: number, identity: string) => {
    tracked.set(pid, identity);
    ever.set(pid, identity);
  };
  // Verified, not assumed: a stale identity is a tree with nothing in it, whose root's
  // group is never adopted.
  const rootVerified =
    identity !== undefined && processIdentity(root) === identity;
  let adopted = false;
  if (rootVerified) take(root, identity);

  /** The groups a tracked, still-verified process is in, led by one of ours. */
  const groupsOf = (byPid: ReadonlyMap<number, ProcEntry>): Set<number> => {
    const groups = new Set<number>();
    for (const pid of tracked.keys()) {
      const entry = byPid.get(pid);
      if (entry === undefined) continue;
      if (!signallable(entry.group) || !ever.has(entry.group)) continue;
      // The root's group is only ours if the kernel said so at spawn.
      if (entry.group === root && !ownsGroup) continue;
      groups.add(entry.group);
    }
    return groups;
  };

  const snapshot = (): ReadonlyMap<number, ProcEntry> | undefined => {
    const listed = listProcesses();
    if (listed === undefined) return undefined;
    return new Map(listed.map((entry) => [entry.pid, entry]));
  };

  /** Drops the gone and the recycled; with procfs, adds what appeared under the tree. */
  const refreshWith = (byPid: ReadonlyMap<number, ProcEntry> | undefined) => {
    if (byPid === undefined) {
      for (const [pid, identity] of tracked) {
        if (processIdentity(pid) !== identity) tracked.delete(pid);
      }
      return;
    }
    for (const [pid, identity] of tracked) {
      if (byPid.get(pid)?.identity !== identity) tracked.delete(pid);
    }
    // To a fixed point: a grandchild is found through a child found in the same pass.
    for (let grew = true; grew;) {
      grew = false;
      const groups = groupsOf(byPid);
      for (const entry of byPid.values()) {
        if (tracked.has(entry.pid) || entry.pid === process.pid) continue;
        if (tracked.has(entry.parent) || groups.has(entry.group)) {
          take(entry.pid, entry.identity);
          grew = true;
        }
      }
    }
  };

  const refresh = () => refreshWith(snapshot());

  /**
   * Signals the tree as `byPid` — already folded in by {@link refreshWith} — found it.
   *
   * The read is taken before anything is signalled: a process killed first cannot then be
   * followed to the children it leaves behind.
   */
  const signalWith = (
    byPid: ReadonlyMap<number, ProcEntry> | undefined,
    signal: NodeJS.Signals,
  ) => {
    if (byPid === undefined) {
      // No procfs: the root's group while the root is verifiably alive, as before.
      const identity = tracked.get(root);
      if (ownsGroup && identity !== undefined) {
        if (processIdentity(root) === identity) signalGroup(root, signal);
      }
    } else {
      for (const group of groupsOf(byPid)) {
        // Re-verified at the last moment: a member must still be in the group, as the
        // identity it was taken in with, for the group's id to still be ours.
        const member = [...tracked].find(
          ([pid, identity]) =>
            processIdentity(pid) === identity && processGroupOf(pid) === group,
        );
        if (member !== undefined) signalGroup(group, signal);
      }
    }
    for (const [pid, identity] of tracked) {
      signalVerified(pid, identity, signal);
    }
  };

  const look = (): TreeLook => {
    const byPid = snapshot();
    refreshWith(byPid);
    return {
      alive: tracked.size > 0,
      signal: (signal) => {
        signalWith(byPid, signal);
      },
    };
  };

  return {
    refresh,
    look,
    alive: () => look().alive,
    signal: (signal) => {
      look().signal(signal);
    },
    adoptOrphanedGroup: () => {
      if (!ownsGroup || !rootVerified || adopted) return;
      adopted = true;
      const byPid = snapshot();
      if (byPid === undefined) return;
      for (const entry of byPid.values()) {
        if (
          entry.group === root &&
          entry.pid !== root &&
          !tracked.has(entry.pid)
        ) {
          take(entry.pid, entry.identity);
        }
      }
      refreshWith(byPid);
    },
  };
};

/**
 * A child this process spawned, as {@link stopOwnedChild} needs to see it.
 *
 * `pid` is `undefined` for a spawn that never produced a process. `tree` is what it
 * started, tracked since spawn ({@link trackProcessTree}); `undefined` when there was
 * nothing to track. `exited` reads the runtime's own record of the direct child, which is
 * the only exit this process can `wait()` for.
 */
export interface StoppableChild {
  readonly pid: number | undefined;
  readonly tree: ProcessTree | undefined;
  readonly exited: () => boolean;
  readonly kill: (signal: NodeJS.Signals) => void;
}

/** How long a child is given after `SIGTERM`, then after `SIGKILL`, and how often it is looked at. */
export interface StopBounds {
  readonly terminateGrace: number;
  readonly killGrace: number;
  readonly poll: number;
}

/**
 * What became of a stop: `already_gone` — nothing was running; `terminated` — gone within
 * the `SIGTERM` grace; `killed` — gone after `SIGKILL`; `survived` — still there after both
 * bounds, which the caller reports, because it cannot do more.
 */
export type StopOutcome = "already_gone" | "terminated" | "killed" | "survived";

/**
 * Stops a child **and everything it started**, now, and waits for them, bounded.
 *
 * `SIGTERM` to the whole tree at once, then `SIGKILL` once the grace is spent. "Gone"
 * means the direct child has exited *and* nothing in its {@link ProcessTree} is left,
 * because the child exiting first is the ordinary case and a process it started — a shell
 * command, a tool in a session of its own — is exactly what must not be left behind. The
 * tree is re-read on every look, so a process started during the grace is caught too.
 *
 * Every signal goes through the tree's identity checks, so a child that exited long ago
 * signals nothing, whatever now holds its pid.
 */
export const stopOwnedChild = Effect.fnUntraced(function* (
  child: StoppableChild,
  bounds: StopBounds,
) {
  if (child.pid === undefined) return "already_gone" as StopOutcome;
  const tree = child.tree;
  /*
   * **One procfs read per look**, whatever is then decided from it (A6 F5's fourth
   * review): a read is every `/proc/<pid>/stat` on the machine, and taking one to ask
   * whether the tree is alive and another to signal it held the event loop for most of
   * every poll on the `SIGKILL` leg. Taken while the child is still alive too, so a tool
   * it starts in its own session while it winds down is tracked before it is reparented.
   */
  const lookAt = () => {
    const seen = tree?.look();
    return {
      gone: child.exited() && !(seen?.alive ?? false),
      signal: (signal: NodeJS.Signals) => seen?.signal(signal),
    };
  };
  /** Signals the tree as `seen` found it, and the direct child while it has not exited. */
  const send = (seen: ReturnType<typeof lookAt>, signal: NodeJS.Signals) => {
    seen.signal(signal);
    if (!child.exited()) {
      try {
        child.kill(signal);
      } catch {
        // Raced with its own exit; `gone` is the real answer.
      }
    }
  };
  let seen = lookAt();
  if (seen.gone) return "already_gone" as StopOutcome;
  send(seen, "SIGTERM");
  const termDeadline = Date.now() + bounds.terminateGrace;
  for (;;) {
    yield* Effect.sleep(bounds.poll);
    // Each look takes in what appeared since the last, so a process started after the
    // `SIGTERM` went out is in the tree the `SIGKILL` reaches.
    seen = lookAt();
    if (seen.gone) return "terminated" as StopOutcome;
    if (Date.now() >= termDeadline) break;
  }
  send(seen, "SIGKILL");
  const killDeadline = Date.now() + bounds.killGrace;
  for (;;) {
    yield* Effect.sleep(bounds.poll);
    seen = lookAt();
    if (seen.gone) return "killed" as StopOutcome;
    if (Date.now() >= killDeadline) return "survived" as StopOutcome;
    // A tool started in the instant before the kill is killed on this look.
    seen.signal("SIGKILL");
  }
});

/**
 * What one record holds.
 *
 * `command` is for the operator reading the log line that says what was killed; nothing
 * decides anything from it, because a command string is not evidence about a pid.
 * `ownsGroup` is deliberately *not* recorded: whether the process leads its own group is
 * re-read from the kernel at reap time, since a stored answer would be a claim about a
 * process we have not looked at yet.
 */
const OwnedProcessRecord = Schema.Struct({
  pid: Schema.Number,
  identity: Schema.String,
  command: Schema.String,
  recordedAt: Schema.String,
});

const decodeRecord = Schema.decodeUnknownResult(
  Schema.fromJsonString(OwnedProcessRecord),
);

/**
 * Records a spawned process, returning the record's path or `undefined`.
 *
 * Synchronous, and called from inside the spawn's uninterruptible acquire, because the
 * teardown this guards against gives the process no asynchronous turn: a record written
 * from a promise continuation would be a record that is sometimes never written.
 *
 * `undefined` means nothing was recorded — the pid was already gone, or the directory
 * could not be written. Both leave the old behaviour (an orphan on watch restart) rather
 * than failing a spawn that is otherwise fine.
 */
export const recordOwnedProcess = (
  directory: string,
  input: { readonly pid: number; readonly command: string },
): string | undefined => {
  const identity = processIdentity(input.pid);
  if (identity === undefined) return undefined;
  const path = join(directory, `${String(input.pid)}.json`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        pid: input.pid,
        identity,
        command: input.command,
        recordedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    return path;
  } catch {
    return undefined;
  }
};

/** Drops a record, because the process it describes has been dealt with. */
export const forgetOwnedProcess = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never written. Either way there is nothing left to forget.
  }
};

/** How long the reap gives a process to go before escalating, and then giving up. */
export interface ReapBounds {
  readonly terminateGrace: number;
  readonly killGrace: number;
  /** Interval between liveness checks while waiting. */
  readonly poll: number;
}

export const DEFAULT_REAP_BOUNDS: ReapBounds = {
  terminateGrace: 3_000,
  killGrace: 2_000,
  poll: 25,
};

/**
 * What became of one record.
 *
 * Shaped like `persistence/fleet.ts`'s sweep outcome — a state and a sentence — because
 * it is read the same way: printed at startup, one line each, by an operator working out
 * what the previous process left behind.
 */
export interface ReapOutcome {
  readonly record: string;
  readonly pid: number | undefined;
  readonly state:
    "stale" | "recycled" | "terminated" | "killed" | "survived" | "unreadable";
  readonly detail: string;
}

/** Whether an operator needs to know about this outcome. */
export const reapNeedsAttention = (outcome: ReapOutcome): boolean =>
  outcome.state === "survived" ||
  outcome.state === "recycled" ||
  outcome.state === "unreadable";

export const renderReapOutcome = (outcome: ReapOutcome): string =>
  `${outcome.pid === undefined ? outcome.record : `pid ${String(outcome.pid)}`}: ${outcome.state} — ${outcome.detail}`;

/**
 * Waits for the process identified by `identity` to leave `pid`, bounded.
 *
 * The wait is on *identity*, not liveness, for the same reason the signalling is: a pid
 * that has been recycled mid-wait is holding a different process, and treating that as
 * "ours is still running" would make the next step escalate against a stranger.
 */
const awaitGone = Effect.fnUntraced(function* (
  pid: number,
  identity: string,
  within: number,
  poll: number,
) {
  const deadline = Date.now() + within;
  for (;;) {
    if (processIdentity(pid) !== identity) return true;
    if (Date.now() >= deadline) return false;
    yield* Effect.sleep(poll);
  }
});

const reapRecord = Effect.fnUntraced(function* (
  path: string,
  bounds: ReapBounds,
) {
  const text = yield* Effect.sync(() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  });
  if (text === undefined) {
    // Listed a moment ago and unreadable now. Nothing to act on and nothing to clean.
    return {
      record: path,
      pid: undefined,
      state: "stale",
      detail: "the record was gone before it could be read",
    } satisfies ReapOutcome;
  }

  const decoded = decodeRecord(text);
  if (decoded._tag === "Failure") {
    // An unparseable record can never be acted on, so keeping it would only make every
    // future boot repeat this complaint. It is dropped, loudly: it may have been the only
    // trace of a process we can no longer identify, and that is worth one line.
    yield* Effect.sync(() => forgetOwnedProcess(path));
    return {
      record: path,
      pid: undefined,
      state: "unreadable",
      detail: `dropped an undecodable record: ${decoded.failure.message}`,
    } satisfies ReapOutcome;
  }
  const record = decoded.success;

  const identity = yield* Effect.sync(() => processIdentity(record.pid));
  if (identity === undefined) {
    yield* Effect.sync(() => forgetOwnedProcess(path));
    return {
      record: path,
      pid: record.pid,
      state: "stale",
      detail: "nothing live holds this pid any more",
    } satisfies ReapOutcome;
  }
  if (identity !== record.identity) {
    // The one outcome this whole mechanism exists to get right. Something is alive at
    // that pid and it is not what we spawned, so it is none of our business.
    yield* Effect.sync(() => forgetOwnedProcess(path));
    return {
      record: path,
      pid: record.pid,
      state: "recycled",
      detail:
        "the pid has been reused by an unrelated process; nothing was signalled",
    } satisfies ReapOutcome;
  }

  // Verified: the process we spawned is still alive, and it outlived the scope that was
  // supposed to own it. Whether it leads its own group is the kernel's answer now, not
  // the one taken at spawn time.
  const ownsGroup = yield* Effect.sync(() => leadsOwnGroup(record.pid));
  const send = (signal: "SIGTERM" | "SIGKILL") =>
    Effect.sync(() => {
      if (ownsGroup) signalGroup(record.pid, signal);
      try {
        process.kill(record.pid, signal);
      } catch {
        // Raced with its own exit; the identity check below is the real answer.
      }
    });

  yield* send("SIGTERM");
  let escalated = false;
  let gone = yield* awaitGone(
    record.pid,
    identity,
    bounds.terminateGrace,
    bounds.poll,
  );
  if (!gone) {
    escalated = true;
    yield* send("SIGKILL");
    gone = yield* awaitGone(
      record.pid,
      identity,
      bounds.killGrace,
      bounds.poll,
    );
  }

  if (!gone) {
    // Kept, not dropped: a process in uninterruptible sleep may yet die, and the identity
    // check makes retrying this record at the next boot safe rather than reckless.
    return {
      record: path,
      pid: record.pid,
      state: "survived",
      detail: `${record.command} did not die; its record is kept for the next boot`,
    } satisfies ReapOutcome;
  }

  // The leader is gone; the shells it started may not be. Signalling the group is still
  // safe at this point: the kernel will not hand that pid to a new process while a
  // process group still carries it as its id, so `kill(-pid)` cannot reach a stranger.
  if (ownsGroup && signalGroup(record.pid, 0)) {
    signalGroup(record.pid, "SIGKILL");
  }
  yield* Effect.sync(() => forgetOwnedProcess(path));
  return {
    record: path,
    pid: record.pid,
    state: escalated ? "killed" : "terminated",
    detail: escalated
      ? `${record.command} ignored SIGTERM and was killed`
      : `${record.command} was terminated`,
  } satisfies ReapOutcome;
});

/**
 * Terminates every recorded process in `directory` that is still alive, and tidies the
 * records of those that are not.
 *
 * Call it at startup, **before anything of this process's own is spawned**: the record is
 * scoped to the installation rather than to a process, so a sweep that ran after a spawn
 * would see our own live child and could not tell it from an orphan.
 *
 * Cannot fail. A missing directory is the ordinary first-boot case and reaps nothing.
 */
export const reapOwnedProcesses = Effect.fnUntraced(function* (
  directory: string,
  bounds: ReapBounds = DEFAULT_REAP_BOUNDS,
) {
  const records = yield* Effect.sync(() => {
    try {
      return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      // No directory: nothing has ever been recorded against this fleet root.
      return [] as string[];
    }
  });
  const outcomes: ReapOutcome[] = [];
  for (const name of records) {
    const outcome = yield* reapRecord(join(directory, name), bounds).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logError("failed to reap a recorded harness process", cause),
          {
            record: join(directory, name),
            pid: undefined,
            state: "survived",
            detail:
              "the reap itself failed; its record is kept for the next boot",
          } satisfies ReapOutcome,
        ),
      ),
    );
    outcomes.push(outcome);
  }
  return outcomes;
});
