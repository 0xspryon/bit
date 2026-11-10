/**
 * The history worker (`claudeHistory.ts`): a read in a child process started with the
 * instance's config folder, bounded in time and memory, failing as a typed error.
 *
 * The success case runs the real worker and the real SDK against a transcript laid out in a
 * throwaway config folder — the only proof that the folder, and not this process's, is what
 * the read sees. The failure cases swap the command for a stand-in that hangs, grows, prints
 * nonsense or dies.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import {
  ClaudeHistoryError,
  readHistory,
  workerHistorySdk,
  type HistoryWorkerOptions,
} from "./claudeHistory";
import type { ClaudeCodeSdk } from "./claudeCodeClient";

const scratch = mkdtempSync(join(tmpdir(), "bit-history-worker-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A session stored under a config folder, as the CLI lays it out. */
const SESSION = "00000000-0000-4000-8000-0000000000f4";
const configDir = join(scratch, "config");
const project = join(configDir, "projects", "-tmp-ws");
mkdirSync(project, { recursive: true });
copyFileSync(
  join(
    import.meta.dir,
    "testdata",
    "claude-code-transcript",
    "compaction.cli.jsonl",
  ),
  join(project, `${SESSION}.jsonl`),
);

const unused: ClaudeCodeSdk["query"] = () => {
  throw new Error("not in these tests");
};
const base = {
  query: unused,
  sessionInfo: () => Promise.reject(new Error("in-process read")),
  sessionMessages: () => Promise.reject(new Error("in-process read")),
  subagentMessages: () => Promise.reject(new Error("in-process read")),
  listSubagents: () => Promise.reject(new Error("in-process read")),
} satisfies ClaudeCodeSdk;

/** A stand-in worker: `bun -e <script>`, given the request as its last argument. */
const standIn = (script: string): readonly string[] => [
  process.execPath,
  "-e",
  script,
];

const failure = async (
  options: HistoryWorkerOptions,
): Promise<ClaudeHistoryError> => {
  const result = await Effect.runPromise(
    Effect.result(
      readHistory({ op: "sessionMessages", sessionId: SESSION }, options),
    ),
  );
  if (result._tag !== "Failure") throw new Error("expected the read to fail");
  return result.failure;
};

describe("a read in the instance's folder", () => {
  test("finds the session there, decoded with every stored field kept", async () => {
    const sdk = workerHistorySdk(base, { configDir });
    const messages = await sdk.sessionMessages(SESSION, {});
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((entry) => entry.session_id === SESSION)).toBe(true);
    // A field the SDK's type does not name, which the replay reads: kept, not stripped.
    expect(
      messages.some(
        (entry) =>
          typeof (entry as { timestamp?: unknown }).timestamp === "string",
      ),
    ).toBe(true);
    const info = await sdk.sessionInfo(SESSION, {});
    expect(info?.sessionId).toBe(SESSION);
    expect(info?.firstPrompt).toBe("Reply with the single word before.");
    expect(await sdk.listSubagents(SESSION, {})).toEqual([]);
  }, 20_000);

  test("a session the folder does not hold is no session, not a failure", async () => {
    const sdk = workerHistorySdk(base, { configDir });
    expect(
      await sdk.sessionInfo("00000000-0000-4000-8000-00000000dead", {}),
    ).toBeUndefined();
  }, 20_000);

  test("another folder does not see it", async () => {
    const empty = join(scratch, "empty-config");
    mkdirSync(empty, { recursive: true });
    const sdk = workerHistorySdk(base, { configDir: empty });
    expect(await sdk.sessionInfo(SESSION, {})).toBeUndefined();
  }, 20_000);
});

describe("a read that does not answer is a typed failure, never a hang", () => {
  test("too slow: killed at the bound", async () => {
    const started = Date.now();
    const error = await failure({
      configDir,
      timeoutMillis: 300,
      command: standIn("await new Promise(() => setInterval(() => {}, 1000));"),
    });
    expect(error).toBeInstanceOf(ClaudeHistoryError);
    expect(error.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("too big: killed past the memory cap", async () => {
    const error = await failure({
      configDir,
      timeoutMillis: 10_000,
      memoryMaxBytes: 64 * 1024 * 1024,
      command: standIn(
        "const held = []; for (;;) { held.push(Buffer.alloc(8 * 1024 * 1024, 1)); await Bun.sleep(5); }",
      ),
    });
    expect(error.reason).toBe("memory");
    expect(error.message).toContain("grew past 64 MiB");
  });

  test("nonsense on stdout", async () => {
    const error = await failure({
      configDir,
      command: standIn("console.log('hello');"),
    });
    expect(error.reason).toBe("output");
  });

  test("an answer of the wrong shape", async () => {
    const sdk = workerHistorySdk(base, {
      configDir,
      command: standIn(
        "console.log(JSON.stringify({ ok: true, value: [{ uuid: 1 }] }));",
      ),
    });
    const thrown = await sdk.sessionMessages(SESSION, {}).catch((e) => e);
    expect(thrown).toBeInstanceOf(ClaudeHistoryError);
    expect((thrown as ClaudeHistoryError).reason).toBe("output");
  });

  test("a crash", async () => {
    const error = await failure({
      configDir,
      command: standIn("console.error('boom'); process.exit(3);"),
    });
    expect(error.reason).toBe("exit");
    expect(error.detail).toContain("code 3: boom");
  });

  test("the SDK's own refusal, from inside the worker", async () => {
    const error = await failure({
      configDir,
      command: standIn(
        "console.log(JSON.stringify({ ok: false, error: 'EACCES' }));",
      ),
    });
    expect(error.reason).toBe("sdk");
    expect(error.message).toContain("EACCES");
  });

  test("the child is given the folder, and none of bit's settings", async () => {
    const sdk = workerHistorySdk(base, {
      configDir,
      environment: { HUNT_ROOT: "/secret/hunt", KEEP: "kept" },
      command: standIn(
        "console.log(JSON.stringify({ ok: true, value: [process.env.CLAUDE_CONFIG_DIR, process.env.HUNT_ROOT ?? 'none', process.env.KEEP] }));",
      ),
    });
    expect(await sdk.listSubagents(SESSION, {})).toEqual([
      configDir,
      "none",
      "kept",
    ]);
  });

  /** Whether a process with this pid is still running (signal 0 tests, sends nothing). */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const waitFor = async (check: () => boolean, millis: number) => {
    const until = Date.now() + millis;
    while (!check() && Date.now() < until) await Bun.sleep(20);
    return check();
  };

  test("an abandoned read kills its child", async () => {
    // The production seam: the client's call sites hand `Effect.tryPromise`'s signal to the
    // reader, so a caller that gives up (a title's budget, a closed request) aborts it.
    const pidFile = join(scratch, "abandoned.pid");
    const sdk = workerHistorySdk(base, {
      configDir,
      timeoutMillis: 30_000,
      command: standIn(
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000));`,
      ),
    });
    const abort = new AbortController();
    const reading = sdk
      .sessionMessages(SESSION, { signal: abort.signal })
      .catch((error: unknown) => error);
    expect(await waitFor(() => Bun.file(pidFile).size > 0, 5_000)).toBe(true);
    const pid = Number(await Bun.file(pidFile).text());
    expect(alive(pid)).toBe(true);
    const started = Date.now();
    abort.abort();
    const error = await reading;
    expect(error).toBeInstanceOf(ClaudeHistoryError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await waitFor(() => !alive(pid), 2_000)).toBe(true);
  });

  test("a read asked for after its caller gave up starts nothing that lingers", async () => {
    const abort = new AbortController();
    abort.abort();
    const sdk = workerHistorySdk(base, {
      configDir,
      timeoutMillis: 30_000,
      command: standIn("await new Promise(() => setInterval(() => {}, 1000));"),
    });
    const started = Date.now();
    const error = await sdk
      .sessionMessages(SESSION, { signal: abort.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeHistoryError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("readHistory's own interruption kills its child", async () => {
    const started = Date.now();
    const result = await Effect.runPromise(
      Effect.result(
        readHistory(
          { op: "sessionMessages", sessionId: SESSION },
          {
            configDir,
            timeoutMillis: 30_000,
            command: standIn(
              "await new Promise(() => setInterval(() => {}, 1000));",
            ),
          },
        ).pipe(Effect.timeout("200 millis")),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("too big: killed past the memory cap", async () => {
    const error = await failure({
      configDir,
      timeoutMillis: 10_000,
      memoryMaxBytes: 64 * 1024 * 1024,
      command: standIn(
        "const held = []; for (;;) { held.push(Buffer.alloc(8 * 1024 * 1024, 1)); await Bun.sleep(5); }",
      ),
    });
    expect(error.reason).toBe("memory");
    expect(error.message).toContain("grew past 64 MiB");
  });

  test("nonsense on stdout", async () => {
    const error = await failure({
      configDir,
      command: standIn("console.log('hello');"),
    });
    expect(error.reason).toBe("output");
  });

  test("an answer of the wrong shape", async () => {
    const sdk = workerHistorySdk(base, {
      configDir,
      command: standIn(
        "console.log(JSON.stringify({ ok: true, value: [{ uuid: 1 }] }));",
      ),
    });
    const thrown = await sdk.sessionMessages(SESSION, {}).catch((e) => e);
    expect(thrown).toBeInstanceOf(ClaudeHistoryError);
    expect((thrown as ClaudeHistoryError).reason).toBe("output");
  });

  test("a crash", async () => {
    const error = await failure({
      configDir,
      command: standIn("console.error('boom'); process.exit(3);"),
    });
    expect(error.reason).toBe("exit");
    expect(error.detail).toContain("code 3: boom");
  });

  test("the SDK's own refusal, from inside the worker", async () => {
    const error = await failure({
      configDir,
      command: standIn(
        "console.log(JSON.stringify({ ok: false, error: 'EACCES' }));",
      ),
    });
    expect(error.reason).toBe("sdk");
    expect(error.message).toContain("EACCES");
  });

  test("the child is given the folder, and none of bit's settings", async () => {
    const sdk = workerHistorySdk(base, {
      configDir,
      environment: { HUNT_ROOT: "/secret/hunt", KEEP: "kept" },
      command: standIn(
        "console.log(JSON.stringify({ ok: true, value: [process.env.CLAUDE_CONFIG_DIR, process.env.HUNT_ROOT ?? 'none', process.env.KEEP] }));",
      ),
    });
    expect(await sdk.listSubagents(SESSION, {})).toEqual([
      configDir,
      "none",
      "kept",
    ]);
  });

  test("an interrupted read kills its child", async () => {
    const started = Date.now();
    const result = await Effect.runPromise(
      Effect.result(
        readHistory(
          { op: "sessionMessages", sessionId: SESSION },
          {
            configDir,
            timeoutMillis: 30_000,
            command: standIn(
              "await new Promise(() => setInterval(() => {}, 1000));",
            ),
          },
        ).pipe(Effect.timeout("200 millis")),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
