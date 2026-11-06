/**
 * Owns a local `opencode serve` process for the lifetime of a scope.
 *
 * Follows the client/server model T3Code proved rather than embedding the SDK
 * (DECISIONS.md §12 SPIKE-1). The server runs as the user and so reads the user's own
 * stored provider credentials; we never read, copy or pass those ourselves.
 *
 * Approach adapted from T3Code (MIT), `packages/provider-opencode/src/server/v2/
 * OpenCode2Server.ts:30-38,144-198` (service shape, bounded readiness),
 * `packages/provider-opencode/src/server/OpenCodeRuntime.ts:731,761-780` (detached
 * spawn, process-group escalation, scope finalizer) and
 * `packages/provider-core/src/server/processGroup.ts` (the `kill(-pid)` guard).
 * Reimplemented for this stack; no code copied verbatim. T3's cross-process sharing
 * ledger is deliberately **not** carried over: one process owns one server here, so
 * there is nothing to arbitrate.
 *
 * Four properties this file is responsible for, each of which was a defect before:
 *
 * 1. **Both pipes are drained continuously, and retention is bounded in characters.**
 *    `stdout`/`stderr` are piped, so an undrained pipe fills its buffer and blocks the
 *    child. Scope-owned fibers read both to EOF. Retention is bounded by a *character*
 *    budget — per line and per stream — not by a line count, because a line count
 *    bounds nothing when the child writes a megabyte without a newline. Everything
 *    discarded is counted (`dropped`, `droppedCharacters`, `truncatedLines`).
 * 2. **The readers are genuinely interruptible.** They are `Stream.fromReadableStream`
 *    pulls, so the scope that owns them cancels the underlying reader on the way out
 *    (`effect/src/Channel.ts:1943-1976` registers `reader.cancel()` as the pull's
 *    finalizer). Interrupting a fiber does **not** cancel an arbitrary pending promise
 *    or break a `for await` loop, which is what the previous `Effect.promise` drain
 *    assumed; a descendant holding the pipe open is enough to make that assumption
 *    leave a live reader behind a closed scope.
 * 3. **Termination is awaited, escalated, and covers the owned tree.** The child is
 *    spawned `detached`, so it leads its own process group; termination signals that
 *    group — verified against the kernel to be the child's own — then the child, waits,
 *    escalates to `SIGKILL`, and waits again. `kill()` that is never awaited is a
 *    request, not an outcome, and a signal sent only to the direct child leaves the
 *    shell processes OpenCode starts behind.
 * 4. **Readiness is bounded as a whole and per probe.** A hung `GET /api/info` cannot
 *    outlive the readiness deadline, because the probe itself is interruptible and
 *    carries an `AbortSignal`. This bounds *our* transport only; it is not a deadline
 *    on worker settlement (DECISIONS.md §5 "no deadline-triggered settlement").
 *
 * Acquisition is `Effect.acquireRelease`, whose acquire runs inside
 * `uninterruptibleMask` (`effect/src/internal/effect.ts:4143-4158`), so there is no
 * window between `Bun.spawn` returning and the finalizer being registered in which an
 * interrupt could leak the child. The readiness wait sits *outside* that region and
 * stays interruptible.
 *
 * Verified against the installed binary, opencode v2.0.32, and re-verified on v2.1.4:
 * - `OPENCODE_PASSWORD` is the server password in 2.x and takes precedence over the
 *   inherited 1.x `OPENCODE_SERVER_PASSWORD`, which we therefore never set.
 * - `GET /api/info` is the only readiness signal that proves an OpenCode 2 server;
 *   `/doc` answers 200 with the web UI's HTML on any version.
 * - **`serve --stdio` reads the password from the environment and then deletes it**
 *   (`cli/src/server-process.ts:85-89`): `Env.password` is read first, so our generated
 *   password is still the one the server adopts, and the two password variables are gone
 *   from the child's `process.env` before it serves a request. Plain `serve` — which
 *   `commands/handlers/serve.ts:11` maps to `mode: "default"` — does *not* scrub, and a
 *   worker's shell is spawned with `{...process.env, TERM, OPENCODE_TERMINAL}`
 *   (`core/src/shell.ts:268-282`), so under plain `serve` the agent could read the
 *   server password out of its own environment and act as a full client of this API —
 *   every session in every Location, in every workspace this one process serves. Why
 *   that is fixed here rather than per session is on {@link serverEnvironment} and
 *   {@link HARNESS_ENVIRONMENT_ALLOWLIST}; the measured before and after is
 *   `spike/shellEnvironmentProof.ts`.
 * - The cost of `--stdio` is that stdin becomes an ownership lease (EOF ends the
 *   server) and that readiness is announced as `{"url":…}` on stdout instead of a prose
 *   line. We depend on neither: the pipe is held open below, and readiness is still the
 *   `/api/info` probe, which is also what yields the version.
 *
 * Known limit of detaching: a detached child does not receive the terminal's `SIGINT`
 * with us, and does not die if *this* process is `SIGKILL`ed. Cleanup is ours alone.
 * That is the trade for being able to stop the whole owned tree; `runMain` turns
 * `SIGINT`/`SIGTERM` into an interrupt of the main fiber, which runs this scope's
 * finalizer (`spike/main.ts`).
 *
 * The other half of that limit is a parent that restarts us without letting the scope
 * close at all — which is what `bun --watch` does, measured and written up on
 * `harness/ownedProcesses.ts`. Nothing in this file can help there, because the restart
 * grants the dying context no asynchronous turn; what covers it is the durable record
 * written here at spawn ({@link SpawnOptions.recordDirectory}) and swept by the next boot.
 * The kernel checks both paths depend on live in that module, so the two cannot drift.
 */
import type { Subprocess } from "bun";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Scope,
  Stream,
} from "effect";

import { HarnessProcessError } from "./errors";
import {
  forgetOwnedProcess,
  leadsOwnGroup,
  recordOwnedProcess,
  signalGroup,
} from "./ownedProcesses";

/**
 * Process-lifetime bounds.
 *
 * Overridable per spawn so the tests can exercise the escalation and timeout paths in
 * under a second instead of half a minute. Nothing here is a bound on *worker
 * settlement* — these are the lifetime of a local subprocess we own.
 */
export interface ProcessBounds {
  /** How long readiness polling may take in total. */
  readonly readiness: number;
  /** How long one readiness probe may take before it is abandoned and retried. */
  readonly probe: number;
  /** Interval between readiness probes. */
  readonly poll: number;
  /** How long `SIGTERM` is given before escalating to `SIGKILL`. */
  readonly terminateGrace: number;
  /** How long `SIGKILL` is given before we give up waiting. */
  readonly killGrace: number;
  /** Most lines of each stream retained. Older lines are dropped, never buffered. */
  readonly diagnosticLines: number;
  /**
   * Most characters of each stream retained across all of its kept lines.
   *
   * This, not {@link diagnosticLines}, is the real retention bound: a child that
   * writes one 50 MB line would satisfy any line count.
   */
  readonly diagnosticCharacters: number;
  /**
   * Most characters of any one line retained. The head is kept, the rest counted and
   * discarded as it arrives — so an unterminated line neither grows the buffer nor
   * costs a copy of an ever-longer string.
   */
  readonly diagnosticLineCharacters: number;
}

export const DEFAULT_BOUNDS: ProcessBounds = {
  readiness: 30_000,
  probe: 2_000,
  poll: 250,
  terminateGrace: 3_000,
  killGrace: 2_000,
  diagnosticLines: 100,
  diagnosticCharacters: 32_000,
  diagnosticLineCharacters: 2_000,
};

/** The bounded tail of what the owned process printed. */
export interface Diagnostics {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** Whole lines read and then discarded because retention is bounded. */
  readonly dropped: number;
  /**
   * Characters read from the child and not retained: the heads of evicted lines plus
   * the tails of lines too long to keep. Counted, never silently lost.
   */
  readonly droppedCharacters: number;
  /** Lines kept only as a head, with the discarded count written into the text. */
  readonly truncatedLines: number;
  /**
   * Characters held in memory right now across both streams, including truncation
   * markers and the line currently being assembled. Bounded by construction.
   */
  readonly retainedCharacters: number;
}

/** How much of the retained tail an error message carries. */
const RENDER_CHARACTER_LIMIT = 4_000;

const renderDiagnostics = (diagnostics: Diagnostics): string => {
  const body = [
    ...diagnostics.stderr.map((line) => `stderr: ${line}`),
    ...diagnostics.stdout.map((line) => `stdout: ${line}`),
  ]
    .slice(-20)
    .join("\n");
  // An error's own rendering is bounded too: 20 retained lines can still be 20 line
  // budgets wide, and an exception is not the place to paste that.
  const tail =
    body.length <= RENDER_CHARACTER_LIMIT
      ? body
      : `…${body.slice(-RENDER_CHARACTER_LIMIT)}`;
  const accounting =
    diagnostics.dropped === 0 && diagnostics.droppedCharacters === 0
      ? undefined
      : `[diagnostics bounded: ${String(diagnostics.dropped)} lines and ${String(diagnostics.droppedCharacters)} characters dropped, ${String(diagnostics.truncatedLines)} lines truncated]`;
  return [tail === "" ? undefined : tail, accounting]
    .filter((part): part is string => part !== undefined)
    .join("\n");
};

const truncationMarker = (discarded: number): string =>
  ` …[+${String(discarded)} characters truncated]`;

/** Enough room for {@link truncationMarker} on top of a full-length line head. */
const MARKER_BUDGET = 64;

/**
 * A character-budgeted tail of lines.
 *
 * *Reading* is unbounded — every byte the child writes is consumed, so its pipe never
 * fills — but *retention* is bounded three ways: by line count, by total characters
 * held per stream, and by characters per line. The third is what the previous version
 * lacked: it bounded the number of complete lines and nothing else, so a child writing
 * without newlines grew the partial-line buffer without limit (and re-copied it on
 * every chunk), and each retained line was itself unbounded.
 *
 * Discarded characters are counted rather than silently dropped, and a line kept only
 * as a head says so in its own text.
 *
 * Exported for the tests: the bound is the claim this class exists to make, and
 * asserting it through a spawned process alone would leave the arithmetic unexercised.
 */
export class LineRing {
  /** Retained lines, with the characters actually *read* for each kept alongside. */
  private readonly lines: { readonly text: string; readonly read: number }[] =
    [];
  /** Characters held in {@link lines}, markers included. */
  private held = 0;
  /** The line being assembled, as chunks: joined once, on completion. */
  private partial: string[] = [];
  private partialLength = 0;
  private partialDiscarded = 0;

  droppedLines = 0;
  droppedCharacters = 0;
  truncatedLines = 0;

  private readonly maxLineCharacters: number;

  constructor(
    private readonly maxLines: number,
    private readonly maxCharacters: number,
    maxLineCharacters: number,
  ) {
    // One line may never claim the whole stream budget: if it could, a single
    // oversized line would evict every other line and still exceed the bound.
    this.maxLineCharacters = Math.max(
      1,
      Math.min(maxLineCharacters, maxCharacters - MARKER_BUDGET),
    );
  }

  write(chunk: string): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) break;
      this.append(chunk.slice(start, newline));
      this.complete();
      start = newline + 1;
    }
    if (start < chunk.length) this.append(chunk.slice(start));
  }

  /** Flushes a trailing line that never got its newline (common on abrupt exit). */
  end(): void {
    if (this.partialLength === 0 && this.partialDiscarded === 0) return;
    this.complete();
  }

  /**
   * Appends to the line being assembled, keeping at most its first
   * `maxLineCharacters`. Past that, characters are counted and dropped as they arrive.
   */
  private append(text: string): void {
    const room = this.maxLineCharacters - this.partialLength;
    if (room <= 0) {
      this.partialDiscarded += text.length;
      this.droppedCharacters += text.length;
      return;
    }
    if (text.length <= room) {
      this.partial.push(text);
      this.partialLength += text.length;
      return;
    }
    this.partial.push(text.slice(0, room));
    this.partialLength = this.maxLineCharacters;
    const discarded = text.length - room;
    this.partialDiscarded += discarded;
    this.droppedCharacters += discarded;
  }

  private complete(): void {
    const head = this.partial.join("");
    const truncated = this.partialDiscarded > 0;
    const text = truncated
      ? head + truncationMarker(this.partialDiscarded)
      : head;
    if (truncated) this.truncatedLines += 1;
    this.partial = [];
    this.partialLength = 0;
    this.partialDiscarded = 0;

    this.lines.push({ text, read: head.length });
    this.held += text.length;
    while (
      this.lines.length > this.maxLines ||
      (this.held > this.maxCharacters && this.lines.length > 1)
    ) {
      const evicted = this.lines.shift();
      if (evicted === undefined) break;
      this.held -= evicted.text.length;
      this.droppedLines += 1;
      this.droppedCharacters += evicted.read;
    }
  }

  snapshot(): readonly string[] {
    const retained = this.lines.map((line) => line.text);
    if (this.partialLength === 0) return retained;
    // The line still being assembled says it was truncated too. A snapshot read
    // mid-run — which is what a readiness failure reads — must not present a head as
    // the whole line.
    const head = this.partial.join("");
    return [
      ...retained,
      this.partialDiscarded === 0
        ? head
        : head + truncationMarker(this.partialDiscarded),
    ];
  }

  /** Characters held right now, including the line still being assembled. */
  retainedCharacters(): number {
    return this.held + this.partialLength;
  }
}

export interface RunningServer {
  readonly baseUrl: string;
  readonly version: string;
  /**
   * Basic-auth header value for our→server HTTP. Not provider auth.
   *
   * `Redacted` so the generated password cannot reach a log line, a thrown error's
   * rendering or a console dump by accident; `Redacted.value` is needed to use it.
   */
  readonly authorization: Redacted.Redacted<string>;
}

/**
 * The owned harness process.
 *
 * `diagnostics` is an Effect rather than a value because the tail keeps changing while
 * the process runs; reading it is a point-in-time snapshot.
 */
export class OpenCodeServer extends Context.Service<
  OpenCodeServer,
  {
    readonly server: RunningServer;
    readonly diagnostics: Effect.Effect<Diagnostics>;
  }
>()("bit/harness/OpenCodeServer") {
  static readonly layer = (options: SpawnOptions) =>
    Layer.effect(OpenCodeServer, spawnServer(options));
}

const generatePassword = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/**
 * Every variable the harness child is allowed to inherit from this process.
 *
 * This is an **allowlist, not a denylist**, and the reason is a counted one. OpenCode
 * reads roughly sixty provider API keys straight out of the environment —
 * `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`,
 * `GITLAB_TOKEN`, `AZURE_OPENAI_API_KEY`, and so on down a list that grows with every
 * provider it adds (`packages/ai/src/providers/*.ts`, each `Auth.config("…_API_KEY")`).
 * A denylist would have to name all of them, stay ahead of that list, *and* also name
 * whatever the operator exports for their own work — `SSH_AUTH_SOCK`, a company token,
 * the credential a colleague's `.envrc` sets. A list of secrets to remember is a list
 * somebody fails to add to, which is the same argument commit `2ebba0e` made about a
 * list of spawn sites to remember, and it points the same way: scrub once, centrally,
 * by naming what is *needed* rather than what is dangerous.
 *
 * What makes an allowlist affordable here rather than crippling is DECISIONS.md §12:
 * the server runs as the user and reads the user's **own stored credentials**, and we
 * never read, copy or pass those. Model authentication comes out of OpenCode's
 * credential store under `HOME`/`XDG_DATA_HOME`, and the environment keys are only its
 * fallback (`Auth.optional(...).orElse(Auth.config("ANTHROPIC_API_KEY"))` — stored
 * credential first). Before this list, §12's "never pass" was not actually true: we
 * passed every one of those keys by spreading `process.env`. The list is what makes the
 * recorded decision match the code.
 *
 * Each group below is here because something established it, not because it looked
 * plausible:
 *
 * - **`HOME`, `XDG_*`, `TMPDIR`** root every global path, including the credential
 *   store (`@opencode/util/global-roots.ts:4-18` — `os.homedir()`, the four XDG
 *   variables, `os.tmpdir()`). Dropping one of these is exactly the failure mode that
 *   surfaces as a provider refusing to authenticate mid-run rather than as a startup
 *   error, so they come first.
 * - **`PATH`, `SHELL`** resolve the interpreter every shell tool runs through
 *   (`core/src/shell/select.ts:173,182` reads `SHELL`; `PATH` is how `bash`, `git` and
 *   the provider CLIs are found at all).
 * - **Locale, `TZ`, `TERM`, `COLORTERM`, `NO_COLOR`** decide how tool output is
 *   encoded, dated and coloured. Omitting them does not break a run, it silently
 *   changes what the worker reads back from its own commands.
 * - **Proxy and TLS-trust variables** are the operator's egress path. An operator
 *   behind a corporate proxy or a custom CA whose harness cannot reach the provider has
 *   a harness that does not work, and the symptom would be an authentication failure
 *   with no visible cause. A proxy URL can itself carry a credential; that is accepted
 *   here, because it is an egress credential the worker's own HTTP traffic already
 *   travels through, and the alternative is not supporting proxied operators.
 * - **The Windows group** is unverified on this platform and included for the same
 *   reason: without `SystemRoot`, `COMSPEC` and `USERPROFILE` a Windows child cannot
 *   locate its own home or spawn a shell, which would be a total failure rather than a
 *   subtle one. Both spellings of the case-insensitive names are listed because
 *   `process.env` preserves whichever case the parent used.
 *
 * Three deliberate exclusions, because each is a question somebody will ask:
 *
 * - **`SSH_AUTH_SOCK`** is a live credential — a worker holding it can authenticate as
 *   the operator to anything their agent holds a key for. A worker that needs to push
 *   over SSH is a worker that has to be given that explicitly.
 * - **Nothing matching `OPENCODE_*` is inherited**, tempting as a prefix rule is. Some
 *   of those names are secrets (`OPENCODE_API_KEY`, `OPENCODE_SSH_ASKPASS_TOKEN`,
 *   `OPENCODE_SERVER_USERNAME` beside the two passwords), and one of them is worse than
 *   a secret: an inherited `OPENCODE_CONFIG_PROJECT_DISABLE` would stop the server
 *   reading project configuration, changed from outside with no sign in the run. (It
 *   once guarded the policy gate's plugin, removed 2026-11-06.) The operator's own
 *   `opencode.json` is still read: OpenCode finds it under the inherited `HOME`; only a
 *   config chosen by an `OPENCODE_*` variable in the server's shell is not.
 * - **Our own variables** — `HUNT_ROOT`, `PORT`, `WORKSPACE_ROOT`, `HARNESS`,
 *   `TARGET_ID`, the rest of `agentEnvironment.ts`'s `BIT_ENVIRONMENT` — are this
 *   process's configuration and mean nothing to the child, and `PORT` in particular is a
 *   name OpenCode also reads. The Claude Code CLI is given its environment less the same
 *   list (a denylist there, for the reason that module gives), and a test keeps this list
 *   and that one disjoint.
 *
 * Adding a name here is a deliberate act: it says the harness needs it and that a
 * worker reading it out of its own environment is acceptable.
 */
export const HARNESS_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  // Global paths, which is where the credential store lives.
  "HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  // Finding and running programs.
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  // How tool output comes back.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  // Egress and TLS trust: the "fails to authenticate mid-run" class.
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  // Windows: unverified here, and a total failure without them.
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMSPEC",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PUBLIC",
  "Path",
  "PathExt",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "windir",
];

/**
 * The spawned server's environment: {@link HARNESS_ENVIRONMENT_ALLOWLIST} filtered out
 * of what we inherited, plus our generated password.
 *
 * `OPENCODE_PASSWORD` is set here and `OPENCODE_SERVER_PASSWORD` is never set at all, so
 * exactly one credential is live whichever variable the installed version honours. The
 * password still has to reach the child's initial environment — that is the only
 * interface `opencode serve` has for it — which is why the spawn passes `--stdio`: the
 * child deletes both password variables from its own `process.env` before it serves
 * anything, so no shell it later starts can read them. See {@link spawnServer}.
 */
export const serverEnvironment = (
  inherited: Record<string, string | undefined>,
  password: string,
): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const name of HARNESS_ENVIRONMENT_ALLOWLIST) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  environment["OPENCODE_PASSWORD"] = password;
  return environment;
};

export interface SpawnOptions {
  readonly binary?: string;
  readonly hostname?: string;
  readonly port?: number;
  /** Working directory for the server process. */
  readonly cwd: string;
  /** Extra argv after `serve`, used by tests to script a fake binary. */
  readonly extraArgs?: readonly string[];
  readonly bounds?: Partial<ProcessBounds>;
  /**
   * Give the child its own process group so termination can reach the processes it
   * starts. Defaults to `true`; a test that wants to observe the narrower
   * direct-child-only contract sets it to `false`.
   */
  readonly ownProcessGroup?: boolean;
  /**
   * Directory in which to record this process durably, so a boot that follows a restart
   * the scope never got to close can find it again and end it.
   *
   * Scoped to one installation by the caller — `main.ts` derives it from `HUNT_ROOT` —
   * because two servers on two fleet roots must not be able to reap each other's
   * children. Omitted means no record is written and nothing will ever be reaped, which
   * is what a test that is only exercising the in-scope lifetime wants. The mechanism and
   * the measurement that makes it necessary are on `harness/ownedProcesses.ts`.
   */
  readonly recordDirectory?: string;
}

/**
 * Reads one piped stream to EOF, retaining a bounded tail.
 *
 * `Stream.fromReadableStream` acquires the reader inside the pull's own scope and
 * registers `reader.cancel()` as its finalizer (`effect/src/Channel.ts:1943-1976`), so
 * interrupting this fiber — or closing the scope it was forked into — actually ends the
 * read. Verified against Bun 1.4.3: `cancel()` settles and resolves a *pending*
 * `read()` as done, which is what makes a stalled pipe releasable rather than a
 * permanent lock. (`stream.locked` stays `true` afterwards in Bun; the read loop is
 * over regardless, and nothing here reuses the stream.)
 *
 * A read that fails is diagnostic noise about a process we are terminating anyway, so
 * it is logged, not propagated: the owner's exit value is the program's, not the
 * pipe's.
 *
 * Exported for the tests, which hand it a synthetic stalled stream: "the reader was
 * cancelled" is only directly observable on a source whose `cancel` we wrote.
 */
export const drain = (
  stream: Subprocess["stdout"],
  ring: LineRing,
): Effect.Effect<void> => {
  if (typeof stream !== "object" || stream === null) return Effect.void;
  const decoder = new TextDecoder();
  return Stream.runForEach(
    Stream.fromReadableStream<Uint8Array, unknown>({
      evaluate: () => stream,
      onError: (cause) => cause,
    }),
    (chunk) =>
      Effect.sync(() => ring.write(decoder.decode(chunk, { stream: true }))),
  ).pipe(
    // One flush point for every exit — EOF, read failure and interruption alike: the
    // decoder's held bytes first, then the unterminated tail.
    Effect.ensuring(
      Effect.sync(() => {
        ring.write(decoder.decode());
        ring.end();
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logDebug("harness stream read ended in failure", cause),
    ),
  );
};

/** Everything scope close has to undo, captured at acquisition. */
interface OwnedProcess {
  readonly child: Subprocess;
  /** Verified against the kernel, not assumed from the spawn option. */
  readonly ownsGroup: boolean;
  /**
   * Path of the durable record of this process, if one was written. Removed once the
   * process is confirmed gone — and deliberately *not* removed otherwise, so a process we
   * failed to end is still the next boot's to finish.
   */
  readonly record: string | undefined;
  readonly drains: Fiber.Fiber<void>;
  /** Owns the readers, so closing it cancels them even on a stalled pipe. */
  readonly drainScope: Scope.Closeable;
}

/**
 * Spawns a server and owns it until the scope closes.
 *
 * The spawn and the registration of its cleanup are one indivisible step: an interrupt
 * arriving between `Bun.spawn` returning and the finalizer being registered would leave
 * a live `opencode serve` that nothing owns. `Effect.acquireRelease` runs its acquire
 * inside `uninterruptibleMask` (`effect/src/internal/effect.ts:4143-4158`), which is
 * precisely that guarantee — and it covers only acquisition, so the readiness wait
 * below stays interruptible.
 */
export const spawnServer = Effect.fnUntraced(function* (options: SpawnOptions) {
  const password = generatePassword();
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? (yield* freePort);
  const binary = options.binary ?? "opencode";
  const bounds: ProcessBounds = { ...DEFAULT_BOUNDS, ...options.bounds };
  const ring = () =>
    new LineRing(
      bounds.diagnosticLines,
      bounds.diagnosticCharacters,
      bounds.diagnosticLineCharacters,
    );
  const stdout = ring();
  const stderr = ring();
  const diagnostics: Effect.Effect<Diagnostics> = Effect.sync(() => ({
    stdout: stdout.snapshot(),
    stderr: stderr.snapshot(),
    dropped: stdout.droppedLines + stderr.droppedLines,
    droppedCharacters: stdout.droppedCharacters + stderr.droppedCharacters,
    truncatedLines: stdout.truncatedLines + stderr.truncatedLines,
    retainedCharacters:
      stdout.retainedCharacters() + stderr.retainedCharacters(),
  }));

  const owned = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const child: Subprocess = yield* Effect.try({
        try: () =>
          Bun.spawn({
            cmd: [
              binary,
              "serve",
              `--hostname=${hostname}`,
              `--port=${String(port)}`,
              // The password scrub. See the note on `stdin` below.
              "--stdio",
              ...(options.extraArgs ?? []),
            ],
            cwd: options.cwd,
            env: serverEnvironment(process.env, password),
            // `--stdio` makes this pipe the server's ownership lease, so it is piped
            // rather than ignored and then held open, unwritten, for the scope's life.
            // Closing it is a shutdown request; `terminate` below signals instead, and
            // the pipe closing when this process dies is a free second path to the same
            // end — including the `SIGKILL` the module header calls out as beyond our
            // reach. Nothing in `ownedProcesses.ts` is relaxed on the strength of it.
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            // `setsid()`, so the server and the shells it starts form a group we can
            // stop as a unit.
            detached: options.ownProcessGroup !== false,
          }),
        catch: (cause) =>
          new HarnessProcessError({
            operation: "spawn",
            detail: `could not start ${binary}: ${String(cause)}`,
            diagnostics: "",
          }),
      });
      const ownsGroup =
        options.ownProcessGroup !== false && leadsOwnGroup(child.pid);
      // Inside the uninterruptible acquire, and synchronous, for the same reason the
      // finalizer is registered here: the teardown this record guards against — a
      // `bun --watch` restart — grants the dying context no asynchronous turn, so a
      // record written from a continuation would be a record sometimes never written.
      const record =
        options.recordDirectory === undefined
          ? undefined
          : recordOwnedProcess(options.recordDirectory, {
              pid: child.pid,
              command: `${binary} serve --port=${String(port)}`,
            });
      const drainScope = yield* Scope.make();
      const drains = yield* Effect.forkIn(
        Effect.all([drain(child.stdout, stdout), drain(child.stderr, stderr)], {
          concurrency: 2,
          discard: true,
        }),
        drainScope,
      );
      return { child, ownsGroup, record, drains, drainScope };
    }),
    (owned: OwnedProcess) => terminate(owned, bounds),
  );

  if (options.ownProcessGroup !== false && !owned.ownsGroup) {
    // Worth saying out loud: without a verified group of our own, cleanup reaches the
    // direct child only, and a shell the server started can survive it.
    yield* Effect.logWarning(
      "could not verify the harness process leads its own group; cleanup covers the direct child only",
      { pid: owned.child.pid },
    );
  }

  const baseUrl = `http://${hostname}:${String(port)}`;
  const authorization = Redacted.make(`Basic ${btoa(`opencode:${password}`)}`);
  const version = yield* awaitReady({
    baseUrl,
    authorization,
    child: owned.child,
    diagnostics,
    bounds,
  });
  return OpenCodeServer.of({
    server: { baseUrl, version, authorization },
    diagnostics,
  });
});

/**
 * Terminates the owned process tree and waits for it.
 *
 * Order is load-bearing, and it is the reason the readers live in their own scope
 * rather than the caller's: the process has to stop *before* the readers do, so the
 * pipes reach EOF on their own and the final lines land in the diagnostics. Only then
 * is the reader scope closed — which cancels the readers outright, for the case the
 * pipes never did reach EOF because something outside our group still holds them.
 *
 * The group is signalled before the child, because the direct child may already have
 * exited while a shell it started holds the port and the pipes. Both waits are bounded
 * so a wedged child cannot hold the scope open forever.
 *
 * A failure here is swallowed deliberately: it must not replace the program's own exit
 * value. It is logged instead, so a leaked process is visible rather than silent.
 */
const terminate = (
  owned: OwnedProcess,
  bounds: ProcessBounds,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { child, ownsGroup, drains } = owned;
    const pid = child.pid;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const send = (signal: "SIGTERM" | "SIGKILL") =>
      Effect.sync(() => {
        if (ownsGroup) signalGroup(pid, signal);
        if (!exited()) {
          try {
            child.kill(signal);
          } catch {
            // Raced with its own exit; `child.exited` below is the real answer.
          }
        }
      });

    if (!exited()) {
      yield* send("SIGTERM");
      const settled = yield* Effect.timeoutOption(
        Effect.promise(() => child.exited),
        bounds.terminateGrace,
      );
      if (Option.isNone(settled)) {
        yield* Effect.logWarning(
          "opencode serve ignored SIGTERM; escalating to SIGKILL",
          { pid },
        );
        yield* send("SIGKILL");
        const killed = yield* Effect.timeoutOption(
          Effect.promise(() => child.exited),
          bounds.killGrace,
        );
        if (Option.isNone(killed)) {
          yield* Effect.logError(
            "opencode serve survived SIGKILL; the process may be leaked",
            { pid },
          );
        }
      }
    }

    // The direct child can be gone while a process it started is not, and that
    // process is what holds the pipes and the port.
    if (ownsGroup && signalGroup(pid, 0)) {
      yield* Effect.logWarning(
        "processes the harness started outlived it; killing the owned process group",
        { pid },
      );
      signalGroup(pid, "SIGKILL");
      const gone = yield* Effect.timeoutOption(
        Effect.retry(
          Effect.suspend(() =>
            signalGroup(pid, 0) ? Effect.fail("present" as const) : Effect.void,
          ),
          { schedule: Schedule.spaced(25) },
        ),
        bounds.killGrace,
      );
      if (Option.isNone(gone)) {
        yield* Effect.logError(
          "the owned process group survived SIGKILL; processes may be leaked",
          { pid },
        );
      }
    }

    // The pipes should be closed now, so this is a short wait for the tail. If it is
    // not — something outside the group still holds a write end — the reader scope
    // closing below cancels the readers rather than waiting on a stream that will not
    // end.
    yield* Effect.timeoutOption(Fiber.await(drains), bounds.killGrace);

    // Only once the process is actually gone. A record left behind for a child that
    // survived everything above is not litter — it is the one thing that lets the next
    // boot finish the job, and `ownedProcesses.ts` re-verifies identity before it acts on
    // it, so keeping it cannot turn into signalling a stranger.
    if (owned.record !== undefined && exited())
      forgetOwnedProcess(owned.record);
  }).pipe(
    // Unconditional, and after the body: the readers are released even if terminating
    // the process failed, and never before the process has had its chance to close the
    // pipes itself.
    Effect.ensuring(Scope.close(owned.drainScope, Exit.void)),
    Effect.catchCause((cause) =>
      Effect.logError("failed to terminate opencode serve", cause),
    ),
  );

const freePort = Effect.try({
  try: () => {
    const probe = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const { port } = probe;
    probe.stop(true);
    return port;
  },
  catch: (cause) =>
    new HarnessProcessError({
      operation: "port",
      detail: String(cause),
      diagnostics: "",
    }),
});

/**
 * One readiness probe.
 *
 * `Effect.tryPromise` hands the callback the fiber's `AbortSignal`, so interrupting
 * this effect — which the timeout below does — actually aborts the in-flight `fetch`
 * instead of leaving it running behind a fiber that has already moved on.
 */
const probeInfo = (
  baseUrl: string,
  authorization: Redacted.Redacted<string>,
  bounds: ProcessBounds,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${baseUrl}/api/info`, {
        headers: { authorization: Redacted.value(authorization) },
        signal,
      });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      return typeof body === "object" &&
        body !== null &&
        "version" in body &&
        typeof body.version === "string"
        ? body.version
        : undefined;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.timeout(bounds.probe),
    // A refused connection or a slow probe is the normal state while the server boots.
    Effect.catch(() => Effect.succeed(undefined)),
  );

/**
 * Polls `/api/info` until the server answers or the deadline passes.
 *
 * A dead child fails immediately rather than waiting out the full timeout, and the
 * process's own output is attached to the failure — "exited with code 1" on its own has
 * never been enough to diagnose a harness that would not start.
 */
const awaitReady = Effect.fnUntraced(function* (input: {
  readonly baseUrl: string;
  readonly authorization: Redacted.Redacted<string>;
  readonly child: Subprocess;
  readonly diagnostics: Effect.Effect<Diagnostics>;
  readonly bounds: ProcessBounds;
}) {
  const failed = (operation: "readiness", detail: string) =>
    Effect.flatMap(
      input.diagnostics,
      (seen) =>
        new HarnessProcessError({
          operation,
          detail,
          diagnostics: renderDiagnostics(seen),
        }),
    );

  const attempt = Effect.gen(function* () {
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      return yield* failed(
        "readiness",
        `opencode serve exited with code ${String(input.child.exitCode)} signal ${String(input.child.signalCode)} before answering`,
      );
    }
    const version = yield* probeInfo(
      input.baseUrl,
      input.authorization,
      input.bounds,
    );
    if (version === undefined) {
      return yield* failed("readiness", "not ready yet");
    }
    return version;
  });

  const version = yield* attempt.pipe(
    // Retry only while the child is alive; the whole loop is bounded by the deadline.
    Effect.retry({
      schedule: Schedule.spaced(input.bounds.poll),
      while: (error) => error.detail === "not ready yet",
    }),
    Effect.timeout(input.bounds.readiness),
    Effect.catchTag("TimeoutError", () =>
      failed(
        "readiness",
        `timed out after ${String(input.bounds.readiness)}ms waiting for the OpenCode server`,
      ),
    ),
  );
  return version;
});
