/**
 * Claude Code history reads for an instance with its own config folder, each in a
 * short-lived child process.
 *
 * ## Why a process per read
 *
 * The SDK's history readers (`getSessionInfo`, `getSessionMessages`, `listSubagents`,
 * `getSubagentMessages`) take a project folder and **no config folder**: they find the
 * transcripts under the `CLAUDE_CONFIG_DIR` of the process they run in. bit's process has
 * one environment and drives several instances, so an in-process read can only ever see
 * the operator's default folder. Measured (`spike/ccInstancesProbe.ts`): a z.ai session was
 * "not found" in-process and read in full by a child started with the z.ai folder. T3 Code
 * reads history the same way (`claudeHistoryWorker.ts`, read for the shape only).
 *
 * Setting this process's own `CLAUDE_CONFIG_DIR` around a read is not an option: reads run
 * concurrently with each other and with session launches, and the SDK reads the variable
 * lazily, so one instance's read would see the other's folder.
 *
 * ## The bounds
 *
 * A read that does not answer is a typed {@link ClaudeHistoryError}, never a hang:
 *
 * - **Time**: the child is killed when the bound runs out (`timeout`).
 * - **Memory**: its resident set is read from `/proc/<pid>/status` every
 *   {@link MEMORY_POLL_MILLIS} and the child is killed past the cap (`memory`). A 35 MB
 *   sub-agent transcript cost ~100 MB of RSS in-process (A7-S review 1), so the default cap
 *   is generous for a real transcript and still stops a runaway.
 * - **Output**: stdout is decoded with Schema; anything that is not the worker's one JSON
 *   line is `output`, and a non-zero exit with nothing decodable is `exit`.
 * - **Interruption**: the caller's fiber being interrupted kills the child.
 *
 * The child's environment is this server's with bit's own settings taken out
 * ({@link agentEnvironment}), plus the instance's folder.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";

import { agentEnvironment } from "./agentEnvironment";
import type { ClaudeCodeSdk } from "./claudeCodeClient";

/** What one read asks. */
export type HistoryRequest =
  | {
      readonly op: "sessionInfo" | "sessionMessages" | "listSubagents";
      readonly sessionId: string;
      readonly dir?: string;
    }
  | {
      readonly op: "subagentMessages";
      readonly sessionId: string;
      readonly agentId: string;
      readonly dir?: string;
    };

export class ClaudeHistoryError extends Schema.TaggedError<ClaudeHistoryError>()(
  "ClaudeHistoryError",
  {
    op: Schema.String,
    sessionId: Schema.String,
    /** Which bound or step failed. `sdk` is the SDK's own refusal, from inside the child. */
    reason: Schema.Literals([
      "spawn",
      "timeout",
      "memory",
      "exit",
      "output",
      "sdk",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `the Claude Code history read '${this.op}' for session ${this.sessionId} failed (${this.reason}): ${this.detail}`;
  }
}

export interface HistoryWorkerOptions {
  /** The instance's `CLAUDE_CONFIG_DIR`. */
  readonly configDir: string;
  /** Kill after this long. */
  readonly timeoutMillis?: number;
  /** Kill past this resident set, in bytes. */
  readonly memoryMaxBytes?: number;
  /**
   * The command to run, before the request argument. Defaults to this runtime running
   * {@link WORKER_ENTRY}; tests swap in a stand-in that hangs, grows or prints nonsense.
   */
  readonly command?: readonly string[];
  /** The environment the child starts from. Defaults to this process's. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export const DEFAULT_HISTORY_TIMEOUT_MILLIS = 30_000;
export const DEFAULT_HISTORY_MEMORY_MAX_BYTES = 512 * 1024 * 1024;
const MEMORY_POLL_MILLIS = 50;

/**
 * The worker's file. Beside this module when run from source; beside the bundle
 * (`dist/claudeHistoryWorker.js`) when built, since the server's build emits it as a second
 * entry point of the same folder.
 */
export const WORKER_ENTRY = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./claudeHistoryWorker.ts"
      : "./claudeHistoryWorker.js",
    import.meta.url,
  ),
);

/* ── Decoding what the child printed ─────────────────────────────────────────── */

/** Every field a reader may look at is kept: the rest of a stored entry rides along. */
const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const StoredMessage = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    uuid: Schema.String,
    session_id: Schema.String,
    message: Schema.Unknown,
  }),
  Rest,
);

const StoredSessionInfo = Schema.StructWithRest(
  Schema.Struct({
    sessionId: Schema.String,
    summary: Schema.String,
    lastModified: Schema.Finite,
  }),
  Rest,
);

const WorkerAnswer = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  ]),
);

const decodeAnswer = Schema.decodeUnknownSync(WorkerAnswer);
const decodeMessages = Schema.decodeUnknownSync(Schema.Array(StoredMessage));
const decodeInfo = Schema.decodeUnknownSync(Schema.NullOr(StoredSessionInfo));
const decodeIds = Schema.decodeUnknownSync(Schema.Array(Schema.String));

/* ── Running one read ─────────────────────────────────────────────────────────── */

/** The resident set of a live pid, in bytes, or `undefined` once it is gone. */
const residentBytes = (pid: number): number | undefined => {
  try {
    const status = readFileSync(`/proc/${String(pid)}/status`, "utf8");
    const kilobytes = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
    return kilobytes === undefined ? undefined : Number(kilobytes) * 1024;
  } catch {
    return undefined;
  }
};

/**
 * Runs one read and answers the worker's `value`, undecoded past the envelope.
 *
 * A Promise rather than an Effect at its core, because the seam it serves
 * (`ClaudeCodeSdk`) is Promise-shaped; {@link readHistory} is the Effect over it. Rejects
 * only with a {@link ClaudeHistoryError}.
 */
const runWorker = async (
  request: HistoryRequest,
  options: HistoryWorkerOptions,
  signal?: AbortSignal,
): Promise<unknown> => {
  const fail = (reason: ClaudeHistoryError["reason"], detail: string) =>
    new ClaudeHistoryError({
      op: request.op,
      sessionId: request.sessionId,
      reason,
      detail,
    });
  const timeoutMillis = options.timeoutMillis ?? DEFAULT_HISTORY_TIMEOUT_MILLIS;
  const memoryMax = options.memoryMaxBytes ?? DEFAULT_HISTORY_MEMORY_MAX_BYTES;
  const command = options.command ?? [process.execPath, "--smol", WORKER_ENTRY];
  const environment = Object.fromEntries(
    Object.entries({
      ...agentEnvironment(options.environment ?? process.env),
      CLAUDE_CONFIG_DIR: options.configDir,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    child = Bun.spawn([...command, JSON.stringify(request)], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw fail("spawn", error instanceof Error ? error.message : String(error));
  }

  let killed: "timeout" | "memory" | "interrupted" | undefined;
  const kill = (why: NonNullable<typeof killed>) => {
    if (killed !== undefined) return;
    killed = why;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(() => kill("timeout"), timeoutMillis);
  let peak = 0;
  const watch = setInterval(() => {
    const bytes = residentBytes(child.pid);
    if (bytes === undefined) return;
    peak = Math.max(peak, bytes);
    if (bytes > memoryMax) kill("memory");
  }, MEMORY_POLL_MILLIS);
  const onAbort = () => kill("interrupted");
  signal?.addEventListener("abort", onAbort, { once: true });
  // A caller that gave up before the child started has no abort event left to send.
  if (signal?.aborted === true) kill("interrupted");

  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
    signal?.removeEventListener("abort", onAbort);
  }

  if (killed === "timeout") {
    throw fail(
      "timeout",
      `the history worker did not answer within ${String(timeoutMillis)} ms and was killed`,
    );
  }
  if (killed === "memory") {
    throw fail(
      "memory",
      `the history worker grew past ${String(Math.round(memoryMax / 1048576))} MiB (${String(Math.round(peak / 1048576))} MiB seen) and was killed`,
    );
  }
  if (killed === "interrupted") {
    throw fail("exit", "the read was abandoned and the worker killed");
  }
  let answer: typeof WorkerAnswer.Type;
  try {
    answer = decodeAnswer(stdout.trim());
  } catch (error) {
    const tail = stderr.trim().slice(-400);
    throw code !== 0
      ? fail(
          "exit",
          `the history worker exited with code ${String(code)}${tail === "" ? "" : `: ${tail}`}`,
        )
      : fail(
          "output",
          `the history worker printed something other than its answer: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
  }
  if (!answer.ok) throw fail("sdk", answer.error);
  return answer.value;
};

const decodeValue = <A>(
  request: HistoryRequest,
  decode: (value: unknown) => A,
  value: unknown,
): A => {
  try {
    return decode(value);
  } catch (error) {
    throw new ClaudeHistoryError({
      op: request.op,
      sessionId: request.sessionId,
      reason: "output",
      detail: `the history worker's answer is not the shape '${request.op}' answers: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
    });
  }
};

/** One read as an Effect, for a caller that is not behind the Promise seam. */
export const readHistory = (
  request: HistoryRequest,
  options: HistoryWorkerOptions,
): Effect.Effect<unknown, ClaudeHistoryError> =>
  Effect.tryPromise({
    try: (signal) => runWorker(request, options, signal),
    catch: (error) =>
      error instanceof ClaudeHistoryError
        ? error
        : new ClaudeHistoryError({
            op: request.op,
            sessionId: request.sessionId,
            reason: "exit",
            detail: String(error),
          }),
  });

/**
 * `base` with its four history readers moved into a child process started with
 * `options.configDir`. `query` is `base`'s: a session's CLI gets the folder through its own
 * environment (`claudeCodeClient.ts`).
 */
export const workerHistorySdk = (
  base: ClaudeCodeSdk,
  options: HistoryWorkerOptions,
): ClaudeCodeSdk => {
  const read = async <A>(
    request: HistoryRequest,
    decode: (value: unknown) => A,
    signal: AbortSignal | undefined,
  ): Promise<A> =>
    decodeValue(request, decode, await runWorker(request, options, signal));
  return {
    query: base.query,
    sessionInfo: (sessionId, { dir, signal }) =>
      read(
        { op: "sessionInfo", sessionId, ...(dir === undefined ? {} : { dir }) },
        (value) =>
          (decodeInfo(value) ?? undefined) as SDKSessionInfo | undefined,
        signal,
      ),
    sessionMessages: (sessionId, { dir, signal }) =>
      read(
        {
          op: "sessionMessages",
          sessionId,
          ...(dir === undefined ? {} : { dir }),
        },
        (value) => decodeMessages(value) as readonly SessionMessage[],
        signal,
      ),
    subagentMessages: (sessionId, agentId, { dir, signal }) =>
      read(
        {
          op: "subagentMessages",
          sessionId,
          agentId,
          ...(dir === undefined ? {} : { dir }),
        },
        (value) => decodeMessages(value) as readonly SessionMessage[],
        signal,
      ),
    listSubagents: (sessionId, { dir, signal }) =>
      read(
        {
          op: "listSubagents",
          sessionId,
          ...(dir === undefined ? {} : { dir }),
        },
        decodeIds,
        signal,
      ),
  };
};
