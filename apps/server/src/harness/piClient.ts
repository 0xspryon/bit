/**
 * The Pi harness: one `pi --mode rpc` process per bit session, owned by bit (slice 2 of the
 * harness-instances work, 2026-11-10).
 *
 * Pi ("pi-coding-agent", 1.5.2 measured) is the generic harness for trying a new model with
 * little configuration: a provider in its `models.json` or a login in its `auth.json`, and
 * every model of it is pickable. This driver implements {@link AgentHarness} as far as the
 * importer chat needs it and the Claude Code driver does; its shapes are that driver's, its
 * transport is Pi's RPC mode (`docs/rpc.md`: JSONL commands on stdin, responses and session
 * events on stdout).
 *
 * ## Session and process identity
 *
 * **bit chooses the session id** ({@link newPiSessionId}, a UUID) and Pi stores the session
 * under it: `--session-id <id>` "opens the current directory's existing session with the ID,
 * or creates it otherwise" (`docs/cli.md`). The same flag is therefore both the create and
 * the resume, and a resume must start in the directory the session was created in, which
 * {@link AgentHarness.sessionContinuation} reports from the file's header.
 *
 * **bit's Pi sessions live in their own folder** (`--session-dir`, one per instance, under
 * the fleet root: `main.ts`), not in the operator's `~/.pi/agent/sessions`. Measured: the
 * folder is flat, one `<timestamp>_<id>.jsonl` per session. The operator can open one with
 * `pi --session <id> --session-dir <that folder>` — **never while bit is running it**: Pi
 * does not lock session files, and two processes appending to one would interleave.
 *
 * **One process per session, started at the session's first prompt**, not at
 * `createSession`, for the reason the Claude Code driver holds its query until then: the
 * MCP credential is minted between the two (`liveAgentSessions.ts`), and it reaches Pi only
 * when the process starts. Each process is recorded in the owned-process directory, so a
 * server that dies without its finalizers (`bun --watch`) has the orphan reaped on its next
 * boot. Measured RSS: 110–140 MB per process.
 *
 * ## Containment: one systemd user scope per process
 *
 * Pi runs every bash call as a `bash -c` in a session of its own, so a job the agent puts in
 * the background (`nohup sleep 777 &`) is reparented to the user's systemd at once and was
 * out of reach of the process-tree tracker: it survived End, shutdown and the reaper (slice
 * 2 review, M1). So, when the user manager can be reached ({@link PiHarnessOptions.containment},
 * probed once at startup), **each process starts in a scope of its own** through
 * `systemd-run --user --scope` (`userScopes.ts`, which says why that and not D-Bus): a
 * cgroup holding Pi and everything it ever starts, detached or not. Ending the session —
 * End, a Stop that ends it, the process dying, the server shutting down — stops the whole
 * cgroup (`SIGTERM`, then `cgroup.kill` after the grace); a scope a killed server left is
 * stopped by the next boot (`reapUserScopes`, `main.ts`). A Stop of a turn is still Pi's
 * `abort`, which ends the running call's process group and leaves the session's background
 * jobs alone, as before. An instance's `memoryMax` caps the scope; a scope killed for memory
 * ends the session as a process death that says so.
 *
 * Without a user manager, each process is its own process group (`detached`) and its tree
 * is followed through `/proc` ({@link stopOwnedChild}), as before, and the instance's
 * notice says what that leaves uncovered.
 *
 * ## bit's tools: an extension, and the credential on a pipe
 *
 * Pi's own MCP client cannot reach bit (it opens with `initialize`, which bit's stateless
 * 2026-07-28 endpoints refuse), so bit's tools arrive through `piBitTools.extension.ts`,
 * loaded with `-e`. The endpoint is `BIT_MCP_URL`; **the bearer is written to the process's
 * fd 3 and nowhere else**, which the extension drains and closes at load. Not the
 * environment: `/proc/<pid>/environ` keeps a process's starting environment for its whole
 * life, readable by any process of the same user — another session's agent included.
 * One credential per process, so one session cannot call another's tools (spike E,
 * `spike/piMcpIsolationProof.ts`).
 *
 * ## Messages into a running session
 *
 * Pi's two queues are bit's two urgencies (`docs/rpc-commands.md`, measured):
 *
 * - `preemptive` (Send now) → `streamingBehavior: "steer"`: delivered **after the current
 *   assistant message and its tool calls finish**, before the next model call. Nothing in
 *   flight is cut short — a long reply is finished first, as on OpenCode.
 * - `queued` → `streamingBehavior: "followUp"`: delivered when the agent would otherwise
 *   stop, one at a time.
 *
 * Pi's stream names no message id, so a delivered message is recognised by its words when
 * Pi takes it (the user `message_end`): the driver's own join of the text it sent to the
 * text Pi echoes, oldest first, never the caller's. The same join names a replayed user
 * message's steer ids, for a session this process holds.
 *
 * ## Stop, and what it holds back
 *
 * `abort` stops the run and answers once Pi is idle (measured: a running `bash` is killed,
 * "Command aborted", in ~10 ms). **A queued message is held, not run** — `queuedOnInterrupt:
 * "held"`: Pi keeps it in its queue and runs it after the next prompt. Pi would run the new
 * message *first*; this driver re-sequences so the held one goes first, as on OpenCode and
 * as the Stop notice tells the operator ({@link sendHeldFirst}).
 *
 * ## Questions for the operator (slice 3)
 *
 * A session opened with `operatorQuestions` (the importer's) is offered bit's
 * `ask_user_question` tool by the extension, which asks through Pi's extension-UI channel:
 * one `input` dialog whose title is `bit-question:<key>`, `key` a random string this driver
 * gives that process alone (`BIT_QUESTION_KEY`), and whose placeholder is the question set as
 * JSON. A dialog with exactly that title is held here and narrated as a `question`; its
 * answer or dismissal is written back as the dialog's value and becomes the tool's result.
 * **Every other dialog is still cancelled at once**: nobody is at a terminal to answer an
 * operator's own extension, and Pi would wait on it. The key is how the two are told apart,
 * never the words on the dialog. **It is not a secret**: an extension of the same process can
 * read it, and so can the agent's own shells, from `/proc/<pid>/environ` (slice 3 review,
 * measured). It is only an id no other extension would choose. Knowing it does not let a
 * shell fake a question: a dialog is a record on Pi's stdout, a socket only this driver
 * reads, and a shell opening `/proc/<pi>/fd/1` to write to it gets ENXIO. An extension the
 * operator installed can open one, and is trusted as the operator's own code is. A second
 * dialog for a call already held is cancelled, never put in the first one's place.
 *
 * A held question is withdrawn when its tool call ends without bit's answer (a Stop aborts
 * the tool's signal, which resolves the dialog empty; Pi's own day-long timeout does the
 * same), when its run settles, when the process dies, and when the session ends. Nothing
 * outlives the process that asked: a restarted server finds the question in the transcript
 * instead, unanswered, and offers it as a message (`questions.ts`, `unansweredQuestion`).
 *
 * ## When the process dies
 *
 * A Pi process that exits on its own mid-turn leaves the turn's outcome **unknown**: the
 * session file holds what was finished (Pi appends one line per entry; measured after a
 * `SIGKILL` mid-call: the user message is there, no reply), and nothing says how the turn
 * would have ended. `waitForIdle` fails, which the spine reads as uncertain, and the session
 * is closed here: nothing can be prompted into a process that is gone. The conversation is
 * carried on by a resume ({@link AgentHarness.sessionContinuation}), as on Claude Code.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessModelView, QuestionAnswers } from "@bit/contracts";
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  Queue,
  Redacted,
  Semaphore,
  Stream,
  type Cause,
} from "effect";

import {
  AgentHarness,
  OPEN_PROMPT,
  SESSION_NOT_FOUND_TAG,
  SESSION_PROCESS_GONE_TAG,
  type HarnessContextUsage,
  type HarnessFailure,
  type HarnessNarration,
  type HarnessQuestion,
  type McpRegistration,
  type SessionRef,
  type SessionStatus,
  type SessionTitle,
  type TerminalOutcome,
} from "./agentHarness";
import { agentEnvironment } from "./agentEnvironment";
import {
  attachmentReader,
  withAttachmentLines,
  type MessageAttachment,
} from "./attachments";
import { PROCESS_EXIT_ENTRY, withExits, type ProcessExit } from "./processExit";
import {
  HarnessDecodeError,
  HarnessProcessError,
  HarnessTransportError,
  QuestionNotPending,
} from "./errors";
import {
  PI_DRIVER,
  defaultInstanceIdForDriver,
  type HarnessInstance,
  type InstanceId,
  type ModelProvenance,
} from "./identity";
import {
  scopeHandle,
  scopeUnitFor,
  scopedCommand,
  type ScopeAvailability,
  type ScopeHandle,
} from "./userScopes";
import {
  forgetOwnedProcess,
  leadsOwnGroup,
  recordOwnedProcess,
  stopOwnedChild,
  trackProcessTree,
  type ProcessTree,
  type StopBounds,
} from "./ownedProcesses";
import {
  QUESTION_DISMISSED_MESSAGE,
  questionAnswersForAgent,
  questionFieldsOfInput,
} from "./questions";
import {
  PiNarrator,
  hasUserMessage,
  lastMeasuredCall,
  parsePiSession,
  piCompactionAt,
  piMessageEntries,
  promptTokensOf,
  sessionName,
  PiTranscriptError,
  type PiEvent,
  type PiSessionFile,
} from "./piTranscript";

/** A model of a configured catalogue. */
export interface PiModelConfig {
  /** `provider/model`, as Pi names it (`zai/glm-5.3-flash`). */
  readonly id: string;
  readonly label?: string | undefined;
}

export interface PiHarnessOptions {
  readonly instanceId?: InstanceId | undefined;
  readonly displayName?: string | undefined;
  /** The `pi` command; `pi` on the server's `PATH` when absent. */
  readonly binary?: string | undefined;
  /**
   * Pi's agent folder (`PI_CODING_AGENT_DIR`): its `auth.json`, `models.json`, settings and
   * extensions. Absent: whatever the server's environment says, which is the operator's
   * `~/.pi/agent`. bit passes it as a path and never opens it.
   */
  readonly agentDir?: string | undefined;
  /** Where this instance's sessions are stored (`--session-dir`). Created if missing. */
  readonly sessionDir: string;
  /**
   * The picker's catalogue. Absent: every model Pi lists for the providers it holds
   * credentials for, read once at startup.
   */
  readonly models?: readonly PiModelConfig[] | undefined;
  readonly defaultModel?: string | undefined;
  /** The owned-process record directory (`ownedProcesses.ts`); none when absent. */
  readonly recordDirectory?: string | undefined;
  /** The extension file; this module's sibling when absent. For tests. */
  readonly extensionPath?: string | undefined;
  /** How long one command may take to be answered. */
  readonly controlTimeout?: Duration.Input | undefined;
  /** How long a new process may take to accept its first prompt. */
  readonly startTimeout?: Duration.Input | undefined;
  /** How long a Stop may take to be acknowledged before the process is killed. */
  readonly interruptTimeout?: Duration.Input | undefined;
  readonly stopBounds?: StopBounds | undefined;
  /**
   * Whether each process starts in a systemd user scope of its own (`userScopes.ts`), as
   * the server's startup probe found it. Absent: no scope, and nothing said about it — for
   * tests of the uncontained path; `main.ts` always passes the probe's answer.
   */
  readonly containment?: ScopeAvailability | undefined;
  /**
   * The cap on one session's scope, Pi and everything it started (systemd's syntax: `2G`),
   * with no swap. Absent: no cap. Applied only when {@link containment} is available.
   */
  readonly memoryMax?: string | undefined;
}

const DEFAULT_CONTROL_TIMEOUT: Duration.Input = "30 seconds";
/** Pi starts in ~0.3 s; the extension's `tools/list` and a cold `jiti` compile add more. */
const DEFAULT_START_TIMEOUT: Duration.Input = "60 seconds";
const DEFAULT_INTERRUPT_TIMEOUT: Duration.Input = "10 seconds";
/** Pi's own shutdown waits for pending work, so a short grace before `SIGKILL`. */
const DEFAULT_STOP_BOUNDS: StopBounds = {
  terminateGrace: 2_000,
  killGrace: 2_000,
  poll: 50,
};
/** How long an end gives Pi to drop its queue and stop its run before the signals. */
const END_ABORT_BOUND: Duration.Input = "3 seconds";
const TREE_REFRESH_MILLIS = 1_000;
const STDERR_TAIL = 4_096;
const NARRATION_BUFFER = 512;

/** The fd the extension reads the credential from. */
const TOKEN_FD = 3;

/**
 * The title prefix of bit's question dialog; the process's key follows it. The extension's
 * `QUESTION_DIALOG`, which cannot import this.
 */
export const PI_QUESTION_DIALOG = "bit-question:";

/** The extension file, beside this module (`.ts` from source, `.js` once built). */
const defaultExtensionPath = (): string =>
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./piBitTools.extension.ts"
      : "./piBitTools.extension.js",
    import.meta.url,
  ).pathname;

const transport = (
  operation: string,
  detail: string,
  options?: { readonly tag?: string; readonly status?: number },
): HarnessTransportError =>
  new HarnessTransportError({
    operation,
    status: options?.status,
    tag: options?.tag ?? "PiError",
    detail,
    cause: detail,
  });

const notFound = (operation: string, detail: string) =>
  transport(operation, detail, { tag: SESSION_NOT_FOUND_TAG, status: 404 });

/** A session id this application mints in Pi's format: a UUID, which Pi's id rule admits. */
export const newPiSessionId = (): string => crypto.randomUUID();

/** `provider/model` → the provider and model an attempt row records. */
export const piModelProvenance = (model: string): ModelProvenance => {
  const slash = model.indexOf("/");
  return slash <= 0
    ? { providerId: "pi", modelId: model }
    : { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

// ---------------------------------------------------------------------------------------
// One RPC process
// ---------------------------------------------------------------------------------------

type Response = {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
};

/** A `pi --mode rpc` this harness started, and the line protocol over it. */
interface RpcProcess {
  readonly child: ChildProcess;
  readonly tree: ProcessTree | undefined;
  /** The process's systemd scope; `undefined` when it runs uncontained. */
  readonly scope: ScopeHandle | undefined;
  readonly record: string | undefined;
  readonly pending: Map<string, (response: Response) => void>;
  next: number;
  exited: boolean;
  stderrTail: string;
  stopping: Deferred.Deferred<void> | undefined;
}

/** Writes one command and waits for its response, bounded. */
const command = (
  rpc: RpcProcess,
  body: Record<string, unknown>,
  timeout: Duration.Input,
): Effect.Effect<Response, HarnessTransportError> => {
  const operation = `pi.${String(body.type)}`;
  return Effect.callback<Response, HarnessTransportError>((resume) => {
    if (rpc.exited) {
      resume(Effect.fail(transport(operation, "the Pi process has exited")));
      return;
    }
    rpc.next += 1;
    const id = `bit-${String(rpc.next)}`;
    rpc.pending.set(id, (response) => resume(Effect.succeed(response)));
    try {
      rpc.child.stdin?.write(`${JSON.stringify({ ...body, id })}\n`);
    } catch (cause) {
      rpc.pending.delete(id);
      resume(
        Effect.fail(
          transport(
            operation,
            `could not write to the Pi process: ${String(cause)}`,
          ),
        ),
      );
    }
    return Effect.sync(() => {
      rpc.pending.delete(id);
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          transport(operation, "the Pi process did not answer in time"),
        ),
    }),
  );
};

/** A response that must have succeeded, as its data. */
const succeeded = (
  operation: string,
  response: Response,
): Effect.Effect<unknown, HarnessTransportError> =>
  response.success
    ? Effect.succeed(response.data)
    : Effect.fail(
        transport(
          operation,
          `Pi refused: ${response.error ?? "no reason given"}`,
        ),
      );

/**
 * Splits a byte stream into records on LF only (`docs/rpc.md`: not `readline`, which also
 * splits on U+2028/U+2029 inside JSON strings), each decoded and handed to `onRecord`.
 */
const lineReader = (onRecord: (record: Record<string, unknown>) => void) => {
  let buffered: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    for (;;) {
      const at = buffered.indexOf(0x0a);
      if (at < 0) return;
      let line = buffered.subarray(0, at).toString("utf8");
      buffered = buffered.subarray(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === "object" && value !== null)
          onRecord(value as Record<string, unknown>);
      } catch {
        // Not a protocol record: stdout is Pi's, and nothing else should be on it.
      }
    }
  };
};

// ---------------------------------------------------------------------------------------
// The catalogue, read once at startup
// ---------------------------------------------------------------------------------------

/** One model as Pi's `get_available_models` lists it, as far as this reads it. */
interface ListedModel {
  readonly id: string;
  readonly name: string | undefined;
  readonly contextWindow: number | undefined;
  readonly images: boolean;
}

const listedModel = (value: unknown): ListedModel | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || typeof model.id !== "string")
    return undefined;
  return {
    id: `${model.provider}/${model.id}`,
    name: typeof model.name === "string" ? model.name : undefined,
    contextWindow:
      typeof model.contextWindow === "number" && model.contextWindow > 0
        ? model.contextWindow
        : undefined,
    images: Array.isArray(model.input) && model.input.includes("image"),
  };
};

/** What the startup read found: Pi's version, its models, and its own default model. */
interface Probe {
  readonly version: string;
  readonly models: readonly ListedModel[];
  readonly defaultModel: string | undefined;
}

const probeFailure = (detail: string, diagnostics = "") =>
  new HarnessProcessError({ operation: "spawn", detail, diagnostics });

/**
 * Asks Pi for its version and catalogue: a short-lived RPC process with no session and
 * nothing loaded (`--offline` too, so no catalogue refresh goes to the network), asked
 * `get_available_models` and `get_state`, then closed.
 *
 * **The RPC command rather than `pi --list-models`**: both list only the providers Pi holds
 * credentials for (measured: 51 models of the operator's two providers, in ~0.3 s), but the
 * command answers JSON with each model's window and input types, which the context meter and
 * the image rule need, where `--list-models` prints a table for people.
 */
const probePi = (
  binary: string,
  env: Record<string, string | undefined>,
  timeout: Duration.Input,
): Effect.Effect<Probe, HarnessProcessError> =>
  Effect.callback<Probe, HarnessProcessError>((resume) => {
    let child: ChildProcess;
    try {
      child = spawn(
        binary,
        [
          "--mode",
          "rpc",
          "--no-session",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
        ],
        { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (cause) {
      resume(
        Effect.fail(
          probeFailure(`could not start ${binary}: ${String(cause)}`),
        ),
      );
      return;
    }
    let stderr = "";
    let done = false;
    const answers: { models?: unknown; state?: unknown; version?: string } = {};
    const finish = (result: Effect.Effect<Probe, HarnessProcessError>) => {
      if (done) return;
      done = true;
      child.stdin?.end();
      child.kill("SIGTERM");
      resume(result);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => {
      stderr = (stderr + data).slice(-STDERR_TAIL);
    });
    child.on("error", (cause) =>
      finish(
        Effect.fail(
          probeFailure(`could not start ${binary}: ${cause.message}`, stderr),
        ),
      ),
    );
    child.on("exit", (code) =>
      finish(
        Effect.fail(
          probeFailure(
            `${binary} exited (code ${String(code)}) before listing its models`,
            stderr,
          ),
        ),
      ),
    );
    child.stdout?.on(
      "data",
      lineReader((record) => {
        if (record.type !== "response") return;
        if (record.success !== true) {
          finish(
            Effect.fail(
              probeFailure(
                `${binary} refused ${String(record.command)}: ${String(record.error)}`,
                stderr,
              ),
            ),
          );
          return;
        }
        if (record.id === "models") answers.models = record.data;
        if (record.id === "state") answers.state = record.data;
        if (answers.models === undefined || answers.state === undefined) return;
        const listed = (answers.models as { models?: unknown } | undefined)
          ?.models as unknown;
        const models = Array.isArray(listed)
          ? listed.flatMap((value) => {
              const model = listedModel(value);
              return model === undefined ? [] : [model];
            })
          : [];
        const current = listedModel(
          (answers.state as { model?: unknown } | undefined)?.model,
        );
        finish(
          Effect.succeed({
            version: "unknown",
            models,
            defaultModel: current?.id,
          }),
        );
      }),
    );
    child.stdin?.write(
      `${JSON.stringify({ id: "models", type: "get_available_models" })}\n${JSON.stringify({ id: "state", type: "get_state" })}\n`,
    );
    return Effect.sync(() => {
      done = true;
      child.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(probeFailure(`${binary} did not list its models in time`)),
    }),
  );

/** `pi --version`, or `unknown`. A diagnostic, like the Claude Code build. */
const piVersion = (
  binary: string,
  env: Record<string, string | undefined>,
): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(binary, ["--version"], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resume(Effect.succeed("unknown"));
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => {
      out += data;
    });
    child.on("error", () => resume(Effect.succeed("unknown")));
    child.on("exit", () => {
      const version = out.trim().split("\n")[0]?.trim() ?? "";
      resume(Effect.succeed(version === "" ? "unknown" : version));
    });
    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.succeed("unknown"),
    }),
  );

// ---------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------

/** One message this driver gave Pi that Pi has not yet taken into the conversation. */
interface Delivery {
  /** The application's id; `undefined` for an opening prompt. */
  readonly messageId: string | undefined;
  readonly text: string;
  readonly images: readonly PiImage[];
  /** Pi's queue for it while a run is in flight; none for an opening prompt. */
  readonly behavior: "steer" | "followUp" | undefined;
}

interface PiImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** One `ask_user_question` dialog this driver holds for the operator. */
interface HeldPiQuestion {
  readonly question: HarnessQuestion;
  /** Pi's id for the dialog, which the answer is written back under. */
  readonly dialogId: string;
  /** The process that asked: an answer goes to it or nowhere. */
  readonly rpc: RpcProcess;
}

/** What the extension reads from the dialog's value (`piBitTools.extension.ts`). */
type QuestionReply =
  | {
      readonly outcome: "answered";
      readonly text: string;
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly outcome: "dismissed"; readonly text: string };

interface SessionRecord {
  readonly sessionId: string;
  readonly title: string;
  readonly directory: string;
  readonly multiTurn: boolean;
  readonly resumed: boolean;
  model: string;
  /** From `createSession`: whether the process is offered bit's question tool. */
  readonly operatorQuestions: boolean;
  /** The key bit's question dialogs carry in their title; see the header. */
  readonly questionKey: string;
  /** The questions this session's process is waiting on, by question id (its tool call). */
  readonly questions: Map<string, HeldPiQuestion>;
  /** The registration the process starts with: one credential, one session. */
  mcp:
    | { readonly name: string; readonly url: string; readonly token: string }
    | undefined;
  readonly narration: Queue.Queue<HarnessNarration, Cause.Done>;
  readonly narrator: PiNarrator;
  /** Replaced per turn of a multi-turn session, as on Claude Code. */
  idle: Deferred.Deferred<void, HarnessFailure>;
  readonly switching: Semaphore.Semaphore;
  /**
   * One permit, held by a delivery from its idle check to its last send (slice 2 review,
   * L5): two messages arriving within one `clear_queue` round trip after a Stop would
   * otherwise both take the held message and send it twice, or reach Pi out of order.
   */
  readonly delivering: Semaphore.Semaphore;
  rpc: RpcProcess | undefined;
  /** The opening prompt has been given; a second is refused. */
  started: boolean;
  /** The opening prompt's user message has not been seen yet. */
  openUnseen: boolean;
  closed: boolean;
  /** A run is in flight: from a prompt Pi started, or `agent_start`, to `agent_settled`. */
  busy: boolean;
  /** Prompt commands sent and not yet answered. */
  pendingPrompts: number;
  /** Messages Pi has queued and not yet taken, oldest first. */
  untaken: Delivery[];
  readonly deliveredIds: Set<string>;
  /** The words of each steer Pi took, with its ids, oldest first: the replay's join. */
  readonly taken: { readonly text: string; readonly ids: readonly string[] }[];
  outcome: TerminalOutcome | undefined;
  /** The session file, once found. */
  file: string | undefined;
}

export const piHarness = (
  options: PiHarnessOptions,
): Layer.Layer<AgentHarness, HarnessProcessError> =>
  Layer.effect(
    AgentHarness,
    Effect.gen(function* () {
      const binary = options.binary ?? "pi";
      const controlTimeout = options.controlTimeout ?? DEFAULT_CONTROL_TIMEOUT;
      const startTimeout = options.startTimeout ?? DEFAULT_START_TIMEOUT;
      const interruptTimeout =
        options.interruptTimeout ?? DEFAULT_INTERRUPT_TIMEOUT;
      const stopBounds = options.stopBounds ?? DEFAULT_STOP_BOUNDS;
      const extensionPath = options.extensionPath ?? defaultExtensionPath();
      const sessionDir = options.sessionDir;
      const memoryMax = options.memoryMax;
      const scopes =
        options.containment?._tag === "available"
          ? options.containment.scopes
          : undefined;
      /** What the operator is told once, at startup and on the instance's row. */
      const notice =
        options.containment?._tag === "unavailable"
          ? `Pi sessions run without a cgroup of their own (${options.containment.reason}), so a job an agent leaves running in the background can outlive its session${memoryMax === undefined ? "" : `, and memoryMax ${memoryMax} is not applied`}.`
          : scopes !== undefined &&
              memoryMax !== undefined &&
              !scopes.memoryController
            ? `memoryMax ${memoryMax} is not enforced: the systemd user manager has no memory controller to give a session's scope.`
            : undefined;
      /** Pi's environment: the server's, without bit's own settings, and the agent folder. */
      const environment = (): Record<string, string | undefined> => ({
        ...agentEnvironment(process.env),
        ...(options.agentDir === undefined
          ? {}
          : { PI_CODING_AGENT_DIR: options.agentDir }),
      });

      try {
        mkdirSync(sessionDir, { recursive: true });
      } catch (cause) {
        return yield* Effect.fail(
          probeFailure(
            `could not create the Pi session folder ${sessionDir}: ${String(cause)}`,
          ),
        );
      }

      const version = yield* piVersion(binary, environment());
      const probe = yield* probePi(binary, environment(), "30 seconds");
      const listed = new Map(probe.models.map((model) => [model.id, model]));
      const view = (
        id: string,
        label: string | undefined,
      ): HarnessModelView => {
        const known = listed.get(id);
        const name = label ?? known?.name;
        const window = known?.contextWindow;
        const compaction =
          window === undefined ? undefined : piCompactionAt(window);
        return {
          id,
          ...(name === undefined || name === "" ? {} : { label: name }),
          ...(window === undefined ? {} : { contextLimit: window }),
          ...(compaction === undefined ? {} : { compactionAt: compaction }),
        };
      };
      const catalogue: readonly HarnessModelView[] =
        options.models === undefined
          ? probe.models.map((model) => view(model.id, undefined))
          : options.models.map((model) => view(model.id, model.label));
      const unlisted = (options.models ?? []).filter(
        (model) => !listed.has(model.id),
      );
      if (unlisted.length > 0) {
        yield* Effect.logWarning(
          "a Pi instance names models Pi does not list for its credentials; they are offered, and Pi will refuse them if it cannot run them",
          {
            instanceId: options.instanceId,
            models: unlisted.map((model) => model.id).join(", "),
          },
        );
      }
      const defaultModel =
        options.defaultModel ??
        options.models?.[0]?.id ??
        (probe.defaultModel !== undefined && listed.has(probe.defaultModel)
          ? probe.defaultModel
          : undefined) ??
        catalogue[0]?.id;
      if (defaultModel === undefined) {
        return yield* Effect.fail(
          probeFailure(
            "Pi lists no model it holds credentials for: log into a provider (`pi`, then `/login`) or add one to the agent folder's models.json",
          ),
        );
      }
      const windowOf = (model: string): number | undefined =>
        listed.get(model)?.contextWindow;

      const instance: HarnessInstance = {
        instanceId: options.instanceId ?? defaultInstanceIdForDriver(PI_DRIVER),
        driver: PI_DRIVER,
        displayName: options.displayName ?? "Pi",
        version,
        installed: true,
        // Pi lists only the providers it holds credentials for, so a model it lists is one
        // it believes it can run; whether the provider accepts the key is a prompt away.
        auth: "unknown",
        defaultModel,
        models: [
          catalogue.find((model) => model.id === defaultModel) ??
            view(defaultModel, undefined),
          ...catalogue.filter((model) => model.id !== defaultModel),
        ],
        ...(notice === undefined ? {} : { notice }),
      };

      const sessions = new Map<string, SessionRecord>();
      /**
       * The process exits seen mid-turn, by session id: drawn in the session's replay where
       * they happened. Outlives the record, so a resumed session still shows its earlier
       * death; memory only, so a restarted server shows none. One entry per death.
       */
      const exits = new Map<string, readonly ProcessExit[]>();
      const handedOut = new WeakMap<SessionRef, SessionRecord>();
      const records = new Set<SessionRecord>();

      /** The session's file in {@link sessionDir}, the newest when several match. */
      const findFile = (sessionId: string): string | undefined => {
        let names: string[];
        try {
          names = readdirSync(sessionDir);
        } catch {
          return undefined;
        }
        const suffix = `_${sessionId}.jsonl`;
        const found = names.filter((name) => name.endsWith(suffix)).sort();
        const last = found.at(-1);
        return last === undefined ? undefined : join(sessionDir, last);
      };

      /** Reads and parses one session's file; `undefined` when it has none. */
      const readSession = (
        operation: string,
        sessionId: string,
      ): Effect.Effect<PiSessionFile | undefined, HarnessFailure> =>
        Effect.suspend(
          (): Effect.Effect<PiSessionFile | undefined, HarnessFailure> => {
            const record = sessions.get(sessionId);
            const path = record?.file ?? findFile(sessionId);
            if (path === undefined) return Effect.succeed(undefined);
            if (record !== undefined) record.file = path;
            let text: string;
            try {
              text = readFileSync(path, "utf8");
            } catch (cause) {
              return Effect.fail(
                transport(
                  operation,
                  `could not read ${path}: ${String(cause)}`,
                ),
              );
            }
            const parsed = parsePiSession(text, path);
            return parsed instanceof PiTranscriptError
              ? Effect.fail(
                  new HarnessDecodeError({
                    operation,
                    status: undefined,
                    detail: parsed.detail,
                    cause: parsed,
                  }),
                )
              : Effect.succeed(parsed);
          },
        );

      const offer = (
        record: SessionRecord,
        entries: readonly HarnessNarration[],
      ) => {
        for (const entry of entries) Queue.offerUnsafe(record.narration, entry);
      };

      /** The idle deferred, made fresh when the last one is done: a new turn begins. */
      const turnBegins = (record: SessionRecord) => {
        if (Deferred.isDoneUnsafe(record.idle))
          record.idle = Deferred.makeUnsafe<void, HarnessFailure>();
      };

      /** Answers `waitForIdle` once nothing is running and nothing is on its way in. */
      const settleIfIdle = (record: SessionRecord) => {
        if (record.busy || record.pendingPrompts > 0) return;
        Deferred.doneUnsafe(record.idle, Effect.void);
        if (!record.multiTurn && !record.closed) {
          void Effect.runPromise(endRecord(record)).catch(() => undefined);
        }
      };

      /** Takes the first queued message whose words are `text`, or the oldest. */
      const take = (
        record: SessionRecord,
        text: string,
      ): Delivery | undefined => {
        const index = record.untaken.findIndex((each) => each.text === text);
        const at = index >= 0 ? index : record.untaken.length > 0 ? 0 : -1;
        if (at < 0) return undefined;
        const [delivery] = record.untaken.splice(at, 1);
        return delivery;
      };

      /** One record from the process: a response, an extension dialog, or an event. */
      const onRecord = (
        record: SessionRecord,
        rpc: RpcProcess,
        value: Record<string, unknown>,
      ) => {
        if (value.type === "response") {
          const id = typeof value.id === "string" ? value.id : undefined;
          const resolve = id === undefined ? undefined : rpc.pending.get(id);
          if (id !== undefined && resolve !== undefined) {
            rpc.pending.delete(id);
            resolve({
              success: value.success === true,
              data: value.data,
              ...(typeof value.error === "string"
                ? { error: value.error }
                : {}),
            });
          }
          return;
        }
        if (value.type === "extension_ui_request") {
          const method = value.method;
          if (typeof value.id !== "string") return;
          if (
            method === "input" &&
            record.operatorQuestions &&
            value.title === `${PI_QUESTION_DIALOG}${record.questionKey}`
          ) {
            holdQuestion(record, rpc, value.id, value.placeholder);
            return;
          }
          // A dialog an extension of the operator's opened: nobody is at a terminal to
          // answer it, and Pi waits for an answer, so it is cancelled at once. Fire-and-
          // forget requests (`notify`, `setStatus`, …) need nothing.
          if (
            method === "select" ||
            method === "confirm" ||
            method === "input" ||
            method === "editor"
          ) {
            dialogResponse(rpc, value.id, { cancelled: true });
          }
          return;
        }
        if (typeof value.type !== "string") return;
        const event = value as PiEvent;
        if (event.type === "agent_start") {
          record.busy = true;
          turnBegins(record);
        }
        const narrated = record.narrator.narrate(event);
        for (const entry of narrated) {
          if (entry.outcome !== undefined) record.outcome = entry.outcome;
        }
        offer(record, narrated);
        // A question call that ended without bit's answer — a Stop aborted it, or Pi's own
        // timeout resolved its dialog — is waiting on nobody any more.
        if (
          event.type === "tool_execution_end" &&
          typeof event.toolCallId === "string"
        ) {
          settleQuestion(record, event.toolCallId, "withdrawn");
        }
        if (event.type === "agent_settled") {
          withdrawQuestions(record);
          record.busy = false;
          settleIfIdle(record);
        }
      };

      /** Writes one answer to an extension dialog; `false` when it could not be written. */
      const dialogResponse = (
        rpc: RpcProcess,
        id: string,
        body: { readonly cancelled: true } | { readonly value: string },
      ): boolean => {
        if (rpc.exited) return false;
        try {
          rpc.child.stdin?.write(
            `${JSON.stringify({ type: "extension_ui_response", id, ...body })}\n`,
          );
          return true;
        } catch {
          // The process is going; nothing waits on this answer any more.
          return false;
        }
      };

      /**
       * Takes one of bit's question dialogs: its set read as the dock's fields, held, and
       * narrated. A set with no question in it is answered at once, so the tool says so.
       */
      const holdQuestion = (
        record: SessionRecord,
        rpc: RpcProcess,
        dialogId: string,
        placeholder: unknown,
      ) => {
        const payload = ((): unknown => {
          try {
            return typeof placeholder === "string"
              ? (JSON.parse(placeholder) as unknown)
              : undefined;
          } catch {
            return undefined;
          }
        })();
        const fields = questionFieldsOfInput("pi", payload);
        const callId =
          typeof payload === "object" &&
          payload !== null &&
          typeof (payload as { callId?: unknown }).callId === "string"
            ? (payload as { callId: string }).callId
            : undefined;
        if (fields === undefined || record.closed) {
          dialogResponse(rpc, dialogId, {
            value: JSON.stringify({
              outcome: "dismissed",
              text: record.closed
                ? "The session is ending, so the questions were not put to the operator."
                : "None of the questions had any text, so nothing was asked. Each needs a `question`.",
            } satisfies QuestionReply),
          });
          return;
        }
        const questionId = callId ?? dialogId;
        // A second dialog for a call already held (an extension of the operator's that
        // knows the key can open one): cancelled, so the first stays the one the operator
        // answers and its dialog is not orphaned under a replaced entry.
        if (record.questions.has(questionId)) {
          dialogResponse(rpc, dialogId, { cancelled: true });
          return;
        }
        const question: HarnessQuestion = {
          questionId,
          fields,
          askedAt: Date.now(),
          callId,
        };
        record.questions.set(questionId, { question, dialogId, rpc });
        offer(record, [
          {
            type: "question",
            sequence: undefined,
            at: question.askedAt ?? Date.now(),
            outcome: undefined,
            detail: { _tag: "question", question },
          },
        ]);
      };

      /** Lets go of one held question, once, and says how it stopped waiting. */
      const settleQuestion = (
        record: SessionRecord,
        questionId: string,
        settled: "answered" | "dismissed" | "withdrawn",
      ): HeldPiQuestion | undefined => {
        const held = record.questions.get(questionId);
        if (held === undefined) return undefined;
        record.questions.delete(questionId);
        offer(record, [
          {
            type: "question",
            sequence: undefined,
            at: Date.now(),
            outcome: undefined,
            detail: { _tag: "questionSettled", questionId, settled },
          },
        ]);
        return held;
      };

      /** Withdraws every question a session still holds: its run or its process is over. */
      const withdrawQuestions = (record: SessionRecord) => {
        for (const questionId of [...record.questions.keys()])
          settleQuestion(record, questionId, "withdrawn");
      };

      /** The narrator's hooks for one record: the steer join, and the model windows. */
      const narratorFor = (record: () => SessionRecord) =>
        new PiNarrator(crypto.randomUUID().slice(0, 8), {
          taken: (text) => {
            const self = record();
            if (self.openUnseen) {
              self.openUnseen = false;
              return undefined;
            }
            const delivery = take(self, text);
            if (delivery?.messageId === undefined) return undefined;
            self.taken.push({ text, ids: [delivery.messageId] });
            return [delivery.messageId];
          },
          window: windowOf,
        });

      /** The process went away without this harness ending it: the turn is uncertain. */
      const died = (
        record: SessionRecord,
        rpc: RpcProcess,
        code: number | null,
        signal: string | null,
        outOfMemory: boolean,
      ) => {
        for (const [, resolve] of rpc.pending)
          resolve({ success: false, error: "the Pi process exited" });
        rpc.pending.clear();
        if (record.rpc === rpc && !record.closed) {
          const running = record.busy || record.pendingPrompts > 0;
          record.closed = true;
          record.busy = false;
          void Effect.runPromise(
            Effect.logWarning(
              outOfMemory
                ? "a Pi session's scope was killed for memory"
                : "a Pi process exited on its own",
              {
                sessionId: record.sessionId,
                code,
                signal,
                running,
                unit: rpc.scope?.unit,
                memoryMax,
                stderr: rpc.stderrTail,
              },
            ),
          ).catch(() => undefined);
          const lost =
            record.untaken.length === 0
              ? ""
              : ` ${record.untaken.length === 1 ? "A message" : `${String(record.untaken.length)} messages`} sent while it ran had not been read yet, and went with it.`;
          // Said even between turns when it was memory: the session ended for a reason the
          // operator can act on, and nothing else would tell them (a crash between turns is
          // only noticed by the next message, which resumes the session).
          if (running || outOfMemory) {
            const when = running ? " while a turn was in flight" : "";
            const what = outOfMemory
              ? `was stopped${when}: ${
                  memoryMax === undefined
                    ? "the machine ran out of memory and the kernel killed a process of this session"
                    : `the session ran out of its memory limit (${memoryMax})`
                }, and everything it had started was stopped with it.`
              : `exited (${signal ?? `code ${String(code)}`})${when}.`;
            const exit: ProcessExit = {
              at: Date.now(),
              message: running
                ? `The Pi process running this session ${what} What it finished is kept; how the turn would have ended is not known.${lost}`
                : `The Pi process running this session ${what} What it finished is kept, and the next message carries the conversation on.`,
            };
            // Kept for the replay (slice 3 fix, L2): Pi's file says nothing of a death, and
            // a thread read again after it would lose the only line saying why the turn
            // stopped.
            exits.set(record.sessionId, [
              ...(exits.get(record.sessionId) ?? []),
              exit,
            ]);
            offer(record, [
              {
                type: PROCESS_EXIT_ENTRY,
                sequence: undefined,
                at: exit.at,
                outcome: undefined,
                detail: { _tag: "error", message: exit.message },
              },
            ]);
          }
          withdrawQuestions(record);
          Deferred.doneUnsafe(
            record.idle,
            running
              ? Effect.fail(
                  transport(
                    "pi.process",
                    outOfMemory
                      ? `the Pi session ran out of ${memoryMax === undefined ? "memory" : `its memory limit (${memoryMax})`} mid-turn and was stopped; the turn's outcome is not known`
                      : `the Pi process exited (${signal ?? `code ${String(code)}`}) mid-turn; the turn's outcome is not known`,
                    // What was queued in it is gone with it (`SESSION_PROCESS_GONE_TAG`).
                    { tag: SESSION_PROCESS_GONE_TAG },
                  ),
                )
              : Effect.void,
          );
          Queue.endUnsafe(record.narration);
        }
      };

      /** Starts the session's process and gives it its opening prompt. */
      const launch = (
        record: SessionRecord,
        delivery: Delivery,
      ): Effect.Effect<void, HarnessFailure> =>
        Effect.gen(function* () {
          const args = [
            "--mode",
            "rpc",
            "--session-dir",
            sessionDir,
            "--session-id",
            record.sessionId,
            "--model",
            record.model,
            // A resume keeps the name it was given; naming it again appends another
            // `session_info` entry (measured).
            ...(record.resumed ? [] : ["--name", record.title]),
            "-e",
            extensionPath,
          ];
          const mcp = record.mcp;
          // In a scope of its own when the user manager can give one: `systemd-run`
          // execs Pi in place, so the pid, the pipes and fd 3 below are Pi's own.
          const unit =
            scopes === undefined
              ? undefined
              : scopeUnitFor(scopes, record.sessionId);
          const launched =
            unit === undefined
              ? { file: binary, args }
              : scopedCommand(unit, {
                  description: `bit Pi session ${record.sessionId}`,
                  memoryMax,
                  file: binary,
                  args,
                });
          let child: ChildProcess;
          try {
            child = spawn(launched.file, launched.args, {
              cwd: record.directory,
              env: {
                ...environment(),
                ...(mcp === undefined
                  ? {}
                  : {
                      BIT_MCP_URL: mcp.url,
                      BIT_MCP_TOKEN_FD: String(TOKEN_FD),
                    }),
                ...(record.operatorQuestions
                  ? { BIT_QUESTION_KEY: record.questionKey }
                  : {}),
              },
              stdio:
                mcp === undefined
                  ? ["pipe", "pipe", "pipe"]
                  : ["pipe", "pipe", "pipe", "pipe"],
              detached: true,
            });
          } catch (cause) {
            return yield* Effect.fail(
              transport(
                "pi.spawn",
                `could not start ${binary}: ${String(cause)}`,
              ),
            );
          }
          // The credential, written once and closed: the extension drains it at load.
          if (mcp !== undefined) {
            const pipe = child.stdio[TOKEN_FD] as NodeJS.WritableStream | null;
            pipe?.end(`${mcp.token}\n`);
          }
          const pid = child.pid;
          const ownsGroup = pid !== undefined && leadsOwnGroup(pid);
          const scope =
            unit === undefined || scopes === undefined || pid === undefined
              ? undefined
              : scopeHandle(scopes, unit);
          const rpc: RpcProcess = {
            child,
            scope,
            // The scope holds everything Pi starts; the tracker is the fallback without it.
            tree:
              scope ??
              (pid === undefined
                ? undefined
                : trackProcessTree(pid, ownsGroup)),
            record:
              pid === undefined || options.recordDirectory === undefined
                ? undefined
                : recordOwnedProcess(options.recordDirectory, {
                    pid,
                    command: `${binary} ${args.join(" ")}`,
                  }),
            pending: new Map(),
            next: 0,
            exited: false,
            stderrTail: "",
            stopping: undefined,
          };
          record.rpc = rpc;
          const watch = setInterval(
            () => rpc.tree?.refresh(),
            TREE_REFRESH_MILLIS,
          );
          watch.unref();
          child.stdout?.on(
            "data",
            lineReader((value) => onRecord(record, rpc, value)),
          );
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (data: string) => {
            rpc.stderrTail = (rpc.stderrTail + data).slice(-STDERR_TAIL);
          });
          child.stdin?.on("error", () => undefined);
          child.once("error", (cause) => {
            rpc.stderrTail = `${rpc.stderrTail}\n${cause.message}`.slice(
              -STDERR_TAIL,
            );
          });
          child.once("exit", (code, signal) => {
            clearInterval(watch);
            rpc.exited = true;
            rpc.tree?.adoptOrphanedGroup();
            if (rpc.stopping === undefined) {
              void Effect.runPromise(
                Effect.gen(function* () {
                  // Asked before the scope is stopped: its own count says whether the
                  // kernel killed anything in it for memory.
                  const outOfMemory =
                    rpc.scope === undefined
                      ? false
                      : yield* rpc.scope.outOfMemory;
                  died(record, rpc, code, signal, outOfMemory);
                  // Whatever it left running — in its scope, or in its group — goes too.
                  yield* stopRpc(rpc);
                }),
              ).catch(() => undefined);
            }
          });
          if (pid !== undefined && !ownsGroup && scope === undefined) {
            yield* Effect.logWarning(
              "could not verify a Pi process leads its own process group; ending its session stops Pi only, not the shells it started",
              { sessionId: record.sessionId, pid },
            );
          }
          const sent = yield* Effect.result(
            sendPrompt(record, delivery, startTimeout),
          );
          if (sent._tag === "Failure") {
            yield* endRecord(record);
            return yield* Effect.fail(
              transport(
                "pi.prompt",
                `${sent.failure.detail}${rpc.stderrTail.trim() === "" ? "" : `; Pi's stderr ended: ${rpc.stderrTail.trim()}`}`,
              ),
            );
          }
        });

      /**
       * One `prompt` command, counted while it is unanswered. The opening prompt is not in
       * `untaken`: it has no id to join.
       */
      const sendPrompt = (
        record: SessionRecord,
        delivery: Delivery,
        timeout: Duration.Input,
        asFollowUp = false,
      ): Effect.Effect<void, HarnessTransportError> =>
        Effect.gen(function* () {
          const rpc = record.rpc;
          if (rpc === undefined) {
            return yield* Effect.fail(
              transport("pi.prompt", "the session has no Pi process"),
            );
          }
          if (delivery.messageId !== undefined) record.untaken.push(delivery);
          record.pendingPrompts += 1;
          const answered = yield* Effect.result(
            command(
              rpc,
              asFollowUp
                ? {
                    type: "follow_up",
                    message: delivery.text,
                    ...(delivery.images.length === 0
                      ? {}
                      : { images: delivery.images }),
                  }
                : {
                    type: "prompt",
                    message: delivery.text,
                    ...(delivery.behavior === undefined
                      ? {}
                      : { streamingBehavior: delivery.behavior }),
                    ...(delivery.images.length === 0
                      ? {}
                      : { images: delivery.images }),
                  },
              timeout,
            ),
          );
          record.pendingPrompts -= 1;
          const forget = () => {
            const at = record.untaken.indexOf(delivery);
            if (at >= 0) record.untaken.splice(at, 1);
          };
          if (answered._tag === "Failure") {
            forget();
            settleIfIdle(record);
            return yield* Effect.fail(answered.failure);
          }
          const response = answered.success;
          if (!response.success) {
            forget();
            settleIfIdle(record);
            return yield* Effect.fail(
              transport(
                "pi.prompt",
                `Pi refused the message: ${response.error ?? "no reason given"}`,
              ),
            );
          }
          const disposition = (
            response.data as { disposition?: unknown } | undefined
          )?.disposition;
          if (disposition === "started") record.busy = true;
          if (disposition === "handled") forget();
          settleIfIdle(record);
        });

      /**
       * A message into a session Pi is holding queued messages for after a Stop: the held
       * ones first, then this one, as the Stop notice says (`turnStop.ts`). Pi would run the
       * new prompt first and the held follow-ups after it (measured), so the queue is taken
       * back (`clear_queue`) and given again in the order bit's records keep it — this
       * driver's own copies, images included, which `clear_queue`'s texts are not.
       */
      const sendHeldFirst = (
        record: SessionRecord,
        delivery: Delivery,
      ): Effect.Effect<void, HarnessTransportError> =>
        Effect.gen(function* () {
          const rpc = record.rpc;
          if (rpc === undefined) {
            return yield* Effect.fail(
              transport("pi.prompt", "the session has no Pi process"),
            );
          }
          yield* Effect.flatMap(
            command(rpc, { type: "clear_queue" }, controlTimeout),
            (response) => succeeded("pi.clear_queue", response),
          );
          const held = record.untaken.splice(0);
          const [first, ...rest] = [...held, delivery];
          if (first === undefined) return;
          yield* sendPrompt(record, first, controlTimeout);
          for (const each of rest)
            yield* sendPrompt(record, each, controlTimeout, true);
        });

      /** Stops a process and everything it started, once at a time, bounded. */
      const stopRpc = (rpc: RpcProcess): Effect.Effect<void> =>
        Effect.suspend(() => {
          const running = rpc.stopping;
          if (running !== undefined) return Deferred.await(running);
          const stopping = Deferred.makeUnsafe<void>();
          rpc.stopping = stopping;
          return Effect.gen(function* () {
            try {
              rpc.child.stdin?.end();
            } catch {
              // Already closed.
            }
            const outcome = yield* stopOwnedChild(
              {
                pid: rpc.child.pid,
                tree: rpc.tree,
                exited: () =>
                  rpc.child.exitCode !== null || rpc.child.signalCode !== null,
                kill: (signal) => {
                  rpc.child.kill(signal);
                },
              },
              stopBounds,
            );
            if (outcome === "survived") {
              yield* Effect.logError(
                "an ended Pi session's process survived SIGKILL; it may still be running",
                { pid: rpc.child.pid, unit: rpc.scope?.unit },
              );
            } else if (rpc.record !== undefined) {
              forgetOwnedProcess(rpc.record);
            }
            // An emptied scope unloads by itself; one that ended `failed` (killed for
            // memory) stays listed until it is cleared.
            if (rpc.scope !== undefined) yield* rpc.scope.release;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => Deferred.doneUnsafe(stopping, Effect.void)),
            ),
          );
        });

      /**
       * Ends one session: its queue dropped and its run stopped, so nothing queued runs on,
       * then the process and its group stopped. Idempotent.
       */
      const endRecord = (record: SessionRecord): Effect.Effect<void> =>
        Effect.gen(function* () {
          const rpc = record.rpc;
          const wasOpen = !record.closed;
          record.closed = true;
          if (rpc !== undefined && !rpc.exited && rpc.stopping === undefined) {
            if (record.busy || record.untaken.length > 0) {
              yield* Effect.ignore(
                command(rpc, { type: "clear_queue" }, END_ABORT_BOUND),
              );
              yield* Effect.ignore(
                command(rpc, { type: "abort" }, END_ABORT_BOUND),
              );
            }
          }
          if (rpc !== undefined) {
            // Marked first, so the exit is not read as a death.
            if (rpc.stopping === undefined && !rpc.exited) {
              yield* stopRpc(rpc);
            } else if (rpc.stopping !== undefined) {
              yield* Deferred.await(rpc.stopping);
            }
          }
          record.busy = false;
          withdrawQuestions(record);
          Deferred.doneUnsafe(record.idle, Effect.void);
          if (wasOpen) Queue.endUnsafe(record.narration);
          if (rpc === undefined || rpc.exited) records.delete(record);
        });

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...records], endRecord, {
          concurrency: "unbounded",
          discard: true,
        }),
      );

      const recordFor = (
        operation: string,
        sessionId: string,
      ): Effect.Effect<SessionRecord, HarnessTransportError> => {
        const record = sessions.get(sessionId);
        return record === undefined
          ? Effect.fail(
              notFound(
                operation,
                `this process holds no Pi session ${sessionId}`,
              ),
            )
          : Effect.succeed(record);
      };

      const imagesOf = (
        model: string,
        attachments: readonly MessageAttachment[],
      ): Effect.Effect<readonly PiImage[], HarnessTransportError> =>
        // Only to a model Pi says takes images: the path line reaches every model anyway.
        listed.get(model)?.images !== true
          ? Effect.succeed([])
          : Effect.forEach(
              attachments.filter((file) => file.kind === "image"),
              (image) =>
                Effect.try({
                  try: () => ({
                    type: "image" as const,
                    data: readFileSync(image.path).toString("base64"),
                    mimeType: image.mimeType,
                  }),
                  catch: (cause) =>
                    transport(
                      "pi.prompt",
                      `the attached image ${image.path} could not be read (${cause instanceof Error ? cause.message : String(cause)}); nothing was sent`,
                    ),
                }),
            );

      const createSession: AgentHarness["Service"]["createSession"] = Effect.fn(
        "piHarness.createSession",
      )(function* (input) {
        const sessionId = input.resume ?? input.sessionId ?? newPiSessionId();
        const narration = yield* Queue.sliding<HarnessNarration, Cause.Done>(
          NARRATION_BUFFER,
        );
        const idle = yield* Deferred.make<void, HarnessFailure>();
        // Idle until something is given: a `waitForIdle` before any prompt answers at once.
        Deferred.doneUnsafe(idle, Effect.void);
        // The narrator's hooks read the record it narrates for, made just below.
        const holder: { record?: SessionRecord } = {};
        const record: SessionRecord = {
          sessionId,
          title: input.title,
          directory: input.directory,
          multiTurn: input.multiTurn === true,
          resumed: input.resume !== undefined,
          model: input.model,
          // As on Claude Code: only a conversation draws questions, and only one that says so.
          operatorQuestions:
            input.multiTurn === true && input.operatorQuestions === true,
          questionKey: crypto.randomUUID(),
          questions: new Map(),
          mcp: undefined,
          narration,
          narrator: narratorFor(() => holder.record as SessionRecord),
          idle,
          switching: yield* Semaphore.make(1),
          delivering: yield* Semaphore.make(1),
          rpc: undefined,
          started: false,
          openUnseen: false,
          closed: false,
          busy: false,
          pendingPrompts: 0,
          untaken: [],
          deliveredIds: new Set(),
          taken: [],
          outcome: undefined,
          file: undefined,
        };
        holder.record = record;
        sessions.set(sessionId, record);
        records.add(record);
        // `options` (reasoning depth) is not translated: this build offers no option
        // descriptors for Pi models, so none can be chosen. `parentSessionId` and
        // `fetchesPages` have nothing to configure on Pi: it has no sub-agents and reads
        // pages with its shell.
        const ref: SessionRef = { id: sessionId };
        handedOut.set(ref, record);
        return ref;
      });

      const switchModel: AgentHarness["Service"]["switchModel"] = Effect.fn(
        "piHarness.switchModel",
      )(function* (sessionId, model) {
        const record = sessions.get(sessionId);
        if (record === undefined || record.closed) {
          return yield* notFound(
            "pi.set_model",
            `this process holds no live Pi session ${sessionId}`,
          );
        }
        return yield* Semaphore.withPermit(record.switching)(
          Effect.gen(function* () {
            if (record.model === model) return;
            const rpc = record.rpc;
            if (rpc === undefined) {
              record.model = model;
              return;
            }
            const { providerId, modelId } = piModelProvenance(model);
            const response = yield* command(
              rpc,
              { type: "set_model", provider: providerId, modelId },
              controlTimeout,
            );
            yield* succeeded("pi.set_model", response);
            record.model = model;
          }),
        );
      });

      const registerMcpServer: AgentHarness["Service"]["registerMcpServer"] =
        Effect.fn("piHarness.registerMcpServer")(function* (
          sessionId,
          name,
          config: McpRegistration,
        ) {
          const record = yield* recordFor("pi.mcp.add", sessionId);
          const header = Object.entries(config.headers).find(
            ([key]) => key.toLowerCase() === "authorization",
          )?.[1];
          if (header === undefined) {
            return yield* transport(
              "pi.mcp.add",
              "the registration carries no authorization header for the extension to present",
            );
          }
          if (record.rpc !== undefined) {
            // The credential reaches Pi only as its process starts. Not an authority
            // problem — the session simply never sees these tools — and nothing in bit
            // registers late today.
            yield* Effect.logWarning(
              "a Pi session was given an MCP registration after its process started; it will not see those tools",
              { sessionId, name },
            );
          }
          // Unwrapped only here, into the record the spawn writes to the process's fd 3.
          const bearer = Redacted.value(header);
          record.mcp = {
            name,
            url: config.url,
            token: bearer.replace(/^Bearer\s+/i, ""),
          };
        });

      /**
       * Takes a registration off the record. A running process keeps the token it read at
       * start in memory: the caller revokes it, so a call with it is refused by bit (401).
       */
      const unregisterMcpServer: AgentHarness["Service"]["unregisterMcpServer"] =
        (sessionId, name) =>
          Effect.sync(() => {
            const record = sessions.get(sessionId);
            if (record?.mcp?.name === name) record.mcp = undefined;
          });

      /**
       * The opening prompt starts the process; a steer goes into Pi's queue for its
       * urgency, or starts a turn in an idle multi-turn session. The refusals are the Claude
       * Code driver's, for its reasons: a second `open`, a steer before any prompt, a steer
       * into a session that has ended or whose process is gone. A repeated message id is
       * answered `delivered: false` with nothing sent.
       */
      const prompt: AgentHarness["Service"]["prompt"] = Effect.fn(
        "piHarness.prompt",
      )(function* (sessionId, text, delivery = OPEN_PROMPT, files) {
        const record = yield* recordFor("pi.prompt", sessionId);
        const words =
          files === undefined
            ? text
            : withAttachmentLines(text, files.attachments, files.uploadsFolder);
        const images = yield* imagesOf(record.model, files?.attachments ?? []);
        if (delivery._tag === "open") {
          if (record.closed) {
            return yield* notFound(
              "pi.prompt",
              `session ${sessionId} has been ended; nothing was started`,
            );
          }
          if (record.started) {
            return yield* transport(
              "pi.prompt",
              `session ${sessionId} has already been prompted; carrying work on means a new attempt identity`,
            );
          }
          record.started = true;
          record.openUnseen = true;
          turnBegins(record);
          yield* launch(record, {
            messageId: undefined,
            text: words,
            images,
            behavior: undefined,
          });
          return { delivered: true };
        }
        if (!record.started) {
          return yield* transport(
            "pi.prompt",
            `session ${sessionId} has not been prompted yet, so there is no turn to steer; nothing was delivered`,
          );
        }
        if (record.deliveredIds.has(delivery.messageId)) {
          return { delivered: false };
        }
        const rpc = record.rpc;
        if (record.closed || rpc === undefined || rpc.exited) {
          // Not found (slice 3 fix, L2): no process here holds this session any more, so
          // the caller opens one from its file — the message is not lost to a refusal.
          return yield* notFound(
            "pi.prompt",
            `session ${sessionId} has ended or its Pi process is gone, so a message sent now would reach nothing; nothing was delivered`,
          );
        }
        const message: Delivery = {
          messageId: delivery.messageId,
          text: words,
          images,
          behavior: delivery.urgency === "preemptive" ? "steer" : "followUp",
        };
        record.deliveredIds.add(delivery.messageId);
        const sent = yield* Effect.result(
          Semaphore.withPermit(record.delivering)(
            Effect.suspend(() => {
              const idle = !record.busy && record.pendingPrompts === 0;
              if (idle) turnBegins(record);
              return idle && record.untaken.length > 0
                ? sendHeldFirst(record, message)
                : sendPrompt(record, message, controlTimeout);
            }),
          ),
        );
        if (sent._tag === "Failure") {
          record.deliveredIds.delete(delivery.messageId);
          return yield* Effect.fail(sent.failure);
        }
        return { delivered: true };
      });

      const waitForIdle: AgentHarness["Service"]["waitForIdle"] = Effect.fn(
        "piHarness.waitForIdle",
      )(function* (sessionId) {
        const record = yield* recordFor("pi.wait", sessionId);
        yield* Deferred.await(record.idle);
      });

      /**
       * Running while a run is in flight or a prompt is on its way in. A session this
       * process does not hold is not running — its process would be this process's — and
       * is `idle` with no outcome when its file is there, which recovery reads as
       * abandoned; one with no file is not found.
       */
      const sessionStatus: AgentHarness["Service"]["sessionStatus"] = Effect.fn(
        "piHarness.sessionStatus",
      )(function* (sessionId) {
        const record = sessions.get(sessionId);
        if (record !== undefined) {
          const running =
            !record.closed && (record.busy || record.pendingPrompts > 0);
          return {
            activity: running ? "running" : "idle",
            outcome: running ? undefined : record.outcome,
          } satisfies SessionStatus;
        }
        if (findFile(sessionId) === undefined) {
          return yield* notFound(
            "pi.session",
            `bit's Pi session folder ${sessionDir} holds no session ${sessionId}`,
          );
        }
        return { activity: "idle", outcome: undefined } satisfies SessionStatus;
      });

      /**
       * From the session's file, live or not: the newest call Pi measured is the reading
       * (`promptTokens` + output, the seam's per-call figure), and the window is the model's
       * as Pi listed it. Not `get_session_stats`'s `contextUsage`, which adds an estimate of
       * what came after that call; the seam's figure is the last call's.
       */
      const contextUsage: AgentHarness["Service"]["contextUsage"] = Effect.fn(
        "piHarness.contextUsage",
      )(function* (sessionId, read) {
        const record = sessions.get(sessionId);
        const model = record?.model ?? read.model;
        const window = windowOf(model) ?? null;
        const breakdown: HarnessContextUsage["breakdown"] = {
          _tag: "none",
          reason: "harness_gives_none",
        };
        const file = yield* Effect.result(readSession("pi.context", sessionId));
        if (file._tag === "Failure") {
          return {
            used: null,
            usedModel: null,
            window,
            reading: "unread",
            breakdown,
          } satisfies HarnessContextUsage;
        }
        const call =
          file.success === undefined
            ? undefined
            : lastMeasuredCall(file.success);
        if (call === undefined) {
          return {
            used: null,
            usedModel: null,
            window,
            reading: "no_call_yet",
            breakdown,
          } satisfies HarnessContextUsage;
        }
        if (call.after) {
          return {
            used: null,
            usedModel: null,
            window,
            reading: "compacted",
            breakdown,
          } satisfies HarnessContextUsage;
        }
        return {
          used: promptTokensOf(call.usage) + call.usage.output,
          usedModel: call.model,
          model,
          window,
          reading: "measured",
          breakdown,
        } satisfies HarnessContextUsage;
      });

      const sessionContinuation: AgentHarness["Service"]["sessionContinuation"] =
        Effect.fn("piHarness.sessionContinuation")(function* (sessionId) {
          const file = yield* readSession("pi.session", sessionId);
          if (file === undefined) {
            return {
              _tag: "unresumable",
              detail: `bit's Pi session folder holds no file for session ${sessionId}`,
            };
          }
          if (!hasUserMessage(file.entries)) {
            return {
              _tag: "unresumable",
              detail: `session ${sessionId}'s file holds no message: it was ended before its opening message was saved, so there is no conversation to carry on`,
            };
          }
          return {
            _tag: "resumable",
            directory: file.header.cwd,
            detail: `Pi still holds session ${sessionId}'s file, so the conversation can be carried on`,
          };
        });

      /**
       * The session's `session_info` name. Pi titles nothing on its own, so it is the name
       * bit gave it at creation (`--name`), which the importer reads as no title
       * (`importerTitle.ts`), as on OpenCode.
       */
      const sessionTitle: AgentHarness["Service"]["sessionTitle"] = Effect.fn(
        "piHarness.sessionTitle",
      )(function* (sessionId) {
        const file = yield* readSession("pi.session", sessionId);
        if (file === undefined) {
          return {
            _tag: "forgotten",
            detail: `bit's Pi session folder holds no file for session ${sessionId}`,
          } satisfies SessionTitle;
        }
        const name = sessionName(file.entries);
        return name === undefined || name.trim() === ""
          ? ({ _tag: "untitled" } satisfies SessionTitle)
          : ({ _tag: "titled", title: name } satisfies SessionTitle);
      });

      /**
       * The session's file, read whether or not a process holds it: Pi appends one line per
       * finished entry, so the file is the record live too, and reading it costs no round
       * trip into a process that may be busy.
       */
      const messages: AgentHarness["Service"]["messages"] = Effect.fn(
        "piHarness.messages",
      )(function* (sessionId, read) {
        const file = yield* readSession("pi.messages", sessionId);
        if (file === undefined) return [];
        const record = sessions.get(sessionId);
        const joined = [...(record?.taken ?? [])];
        const entries = piMessageEntries(file, {
          reader: attachmentReader({ uploadsFolder: read?.uploadsFolder }),
          steerIds: (text) => {
            const at = joined.findIndex((each) => each.text === text);
            if (at < 0) return undefined;
            const [found] = joined.splice(at, 1);
            return found?.ids;
          },
        });
        return withExits(entries, exits.get(sessionId) ?? []);
      });

      const interruptSession: AgentHarness["Service"]["interruptSession"] =
        Effect.fn("piHarness.interruptSession")(function* (sessionId) {
          const record = sessions.get(sessionId);
          const rpc = record?.rpc;
          if (
            record === undefined ||
            rpc === undefined ||
            record.closed ||
            rpc.exited
          ) {
            return false;
          }
          if (!record.busy && record.pendingPrompts === 0) return false;
          /*
           * The questions it holds are withdrawn **before** the `abort` is written (slice 3
           * review, L1). Pi resolves a held dialog empty on `abort` and drops a value written
           * after it, so an answer arriving between the two was reported delivered and
           * lost. Withdrawn first, an answer either was written ahead of the `abort` (Pi
           * reads its input in order, so the tool gets it) or finds nothing pending and is
           * refused (`QuestionNotPending`), and the page offers it as a message, as after
           * any withdrawal.
           */
          withdrawQuestions(record);
          // `abort` answers once Pi is idle, after its `agent_settled` (measured).
          const asked = yield* Effect.result(
            command(rpc, { type: "abort" }, interruptTimeout),
          );
          if (asked._tag === "Failure" || !asked.success.success) {
            yield* endRecord(record);
            const detail =
              asked._tag === "Failure"
                ? asked.failure.detail
                : `Pi refused: ${asked.success.error ?? "no reason given"}`;
            yield* Effect.logWarning(
              "a Pi session would not acknowledge a Stop; its process was stopped",
              { sessionId, detail },
            );
            return yield* transport(
              "pi.abort",
              `${detail}; its process was stopped`,
            );
          }
          if (!record.multiTurn) yield* endRecord(record);
          return true;
        });

      const endSession: AgentHarness["Service"]["endSession"] = (session) =>
        Effect.suspend(() => {
          const record = handedOut.get(session);
          return record === undefined ? Effect.void : endRecord(record);
        });

      const pendingQuestions: AgentHarness["Service"]["pendingQuestions"] = (
        sessionId,
      ) =>
        Effect.sync(() =>
          [...(sessions.get(sessionId)?.questions.values() ?? [])].map(
            (held) => held.question,
          ),
        );

      /**
       * Writes the operator's decision into the held dialog and lets the question go. The
       * question is settled only once the answer is written: a process that cannot be
       * written to took nothing, and the caller says so (`harness_unreachable`).
       */
      const decide = (
        sessionId: string,
        questionId: string,
        reply: (held: HeldPiQuestion) => QuestionReply,
      ): Effect.Effect<void, HarnessFailure | QuestionNotPending> =>
        Effect.suspend(
          (): Effect.Effect<void, HarnessFailure | QuestionNotPending> => {
            const record = sessions.get(sessionId);
            const held = record?.questions.get(questionId);
            if (record === undefined || held === undefined) {
              return Effect.fail(
                new QuestionNotPending({
                  questionId,
                  reason: "settled",
                  detail: `Pi is not waiting on question ${questionId} in session ${sessionId}: it was answered, dismissed or withdrawn, or this server never held it.`,
                }),
              );
            }
            const answer = reply(held);
            if (
              !dialogResponse(held.rpc, held.dialogId, {
                value: JSON.stringify(answer),
              })
            ) {
              return Effect.fail(
                transport(
                  "pi.extension_ui_response",
                  `the Pi process holding question ${questionId} could not be written to`,
                ),
              );
            }
            settleQuestion(record, questionId, answer.outcome);
            return Effect.void;
          },
        );

      const answerQuestion: AgentHarness["Service"]["answerQuestion"] = (
        sessionId,
        questionId,
        answers: QuestionAnswers,
      ) =>
        decide(sessionId, questionId, (held) => ({
          outcome: "answered",
          text: questionAnswersForAgent(held.question.fields, answers),
          // By question text, for the call's details: what a reader of the session file sees.
          answers: Object.fromEntries(
            held.question.fields.map((field) => [
              field.question,
              answers[field.key] ?? [],
            ]),
          ),
        }));

      const dismissQuestion: AgentHarness["Service"]["dismissQuestion"] = (
        sessionId,
        questionId,
      ) =>
        decide(sessionId, questionId, () => ({
          outcome: "dismissed",
          text: QUESTION_DISMISSED_MESSAGE,
        }));

      const sessionEvents: AgentHarness["Service"]["sessionEvents"] = (
        sessionId,
      ) =>
        Stream.unwrap(
          Effect.map(recordFor("pi.events", sessionId), (record) =>
            Stream.fromQueue(record.narration),
          ),
        );

      return AgentHarness.of({
        instance,
        newSessionId: newPiSessionId,
        modelProvenance: piModelProvenance,
        createSession,
        switchModel,
        registerMcpServer,
        unregisterMcpServer,
        prompt,
        waitForIdle,
        sessionStatus,
        contextUsage,
        sessionContinuation,
        sessionTitle,
        messages,
        interruptSession,
        // Pi has no sub-agents of its own.
        stopSubagent: () => Effect.succeed("not_running"),
        stopSubagents: () => Effect.succeed([]),
        queuedOnInterrupt: "held",
        holding: (sessionId) =>
          Effect.sync(() => (sessions.get(sessionId)?.untaken.length ?? 0) > 0),
        pendingQuestions,
        answerQuestion,
        dismissQuestion,
        endSession,
        sessionEvents,
      });
    }),
  );
