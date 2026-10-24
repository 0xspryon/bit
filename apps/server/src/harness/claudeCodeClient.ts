/**
 * The Claude Code implementation of {@link AgentHarness}, over the Claude Agent SDK.
 *
 * The SDK, deliberately, and not the `claude` CLI as a subprocess: this is a Bun
 * TypeScript server, the SDK gives a caller-supplied `sessionId`, `getSessionMessages` and
 * an MCP registration channel as supported surface, and spawning and parsing a CLI would
 * be re-implementing what the SDK already owns — including the process cleanup
 * `harness/openCodeServer.ts` needed 300 lines for.
 *
 * It is the second implementation of a seam the first one defined, so this file is mostly
 * a record of where the two harnesses genuinely disagree. Five disagreements, each of
 * which forced something.
 *
 * ## 1. There is no session, then a prompt. There is one `query()` call.
 *
 * OpenCode's API is six independent HTTP routes. The SDK's is one function that creates
 * the session, sends the prompt, streams the narration and reports the outcome. The
 * supervisor needs those apart, because a credential is minted between create and prompt
 * and the narration subscription is opened before the prompt.
 *
 * So `createSession` here starts **nothing**. It records what the session will be — id,
 * model, directory, title — in {@link sessions}, and `prompt` is what launches `query()`
 * with all of it. Everything in between (`registerMcpServer`, `sessionEvents`) attaches to
 * that record. The interface's shape is preserved exactly; what moved is where the work
 * happens.
 *
 * The consequence worth stating: a session that is created and never prompted costs
 * nothing and leaves nothing behind, where OpenCode's leaves a real session on a real
 * server. Both are honest answers to "the run broke before it started".
 *
 * ## 2. The MCP credential must not go in the `mcpServers` option
 *
 * The SDK's `mcpServers` option is serialised onto the CLI's **argv** as
 * `--mcp-config <json>` (`core.mjs`: `R.push(...ot("--mcp-config", t({mcpServers: Ie})))`).
 * Our bearer in there would be readable from `/proc/<pid>/cmdline` and from a plain
 * `ps aux` run by the agent's own shell, which is exactly what DECISIONS.md §6
 * ("credentials off argv") forbids. The option is therefore never used.
 *
 * `Query.setMcpServers()` is a `mcp_set_servers` **control request** over the already-open
 * stream, so the credential travels in a message body, like OpenCode's registration does.
 * That is why {@link launch} holds the prompt back behind a gate: the query starts with no
 * servers, the registration is pushed over the control channel, and only then is the
 * prompt released. A prompt that reached the model before the registration would be a
 * worker whose `record_observation` tool silently did not exist yet.
 *
 * ## 3. The session id is a UUID, not `ses_…`
 *
 * The SDK documents `sessionId` as "must be a valid UUID". OpenCode's is its own
 * `ses_`-prefixed descending id. Neither is ours, which is why minting one is on the
 * interface ({@link AgentHarness.newSessionId}) rather than a shared helper.
 *
 * ## 4. Nothing to ask about a session, so we remember
 *
 * OpenCode has a server with a session store, so `session.get` and `session.wait` are real
 * questions with live answers. Claude Code has a transcript on disk and a subprocess that
 * exits. So `sessionStatus` answers from {@link SessionRecord} while this process holds
 * the session, and falls back to `getSessionInfo` — the on-disk transcript — for a session
 * it does not. The fallback is what makes the two harnesses give recovery the *same three
 * answers*: an id the store knows but we do not is "exists, nothing definite"; an id
 * nobody knows is `missing`, reported with the taxonomy's own
 * {@link SESSION_NOT_FOUND_TAG} so `recovery/harnessStatus.ts` needs no branch.
 *
 * ## 5. The narration stream has no startup race, and the interface still promises one
 *
 * OpenCode's `event.subscribe()` is live-only: an event published between prompting and
 * the subscription being established is gone. This implementation buffers into a sliding
 * queue created with the session, so narration published before anybody subscribes is
 * still delivered. That is strictly better and it is *not* promised by the interface, on
 * purpose — a consumer that relied on it would break on the next harness. The supervisor
 * is written to the weaker guarantee and gets the stronger one for free here.
 *
 * ## What is pinned, and why
 *
 * - `permissionMode: "dontAsk"` — denies anything not pre-approved. There is no operator
 *   at a prompt, so `default` would stall on the first tool call, and `bypassPermissions`
 *   would make the gate advisory. Under `dontAsk` an allow from our `PreToolUse` gate is
 *   what pre-approves a call, so the gate is the authority and a gate that cannot answer
 *   is a worker that cannot act. See `policy/claudeCodeGate.ts`.
 * - `settingSources: ["user", "project", "local"]` — stated rather than defaulted, because
 *   `.claude/settings.local.json` is where the gate lives and a future default of `[]`
 *   would silently un-gate every run.
 * - `forwardSubagentText: true` — without it a subagent's text and thinking never reach the
 *   stream and narration shows only tool-call heartbeats (`--forward-subagent-text`,
 *   Claude Code 2.1.211+).
 */
import {
  MODEL_OPTION_DEFAULT_CHOICE,
  type HarnessModelView,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
} from "@bit/contracts";
import {
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  query as sdkQuery,
  type EffortLevel,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Deferred,
  Effect,
  Layer,
  Queue,
  Redacted,
  Stream,
  type Cause,
  type Duration,
} from "effect";

import {
  CLAUDE_CODE_MINIMUM,
  compareVersions,
  installClaudeCodeGate,
} from "../policy/claudeCodeGate";
import {
  AgentHarness,
  SESSION_NOT_FOUND_TAG,
  type HarnessFailure,
  type HarnessNarration,
  type McpRegistration,
  type MessageEntry,
  type TerminalOutcome,
} from "./agentHarness";
import { HarnessProcessError, HarnessTransportError } from "./errors";
import {
  CLAUDE_CODE_DRIVER,
  defaultInstanceIdForDriver,
  type HarnessInstance,
  type ModelProvenance,
} from "./identity";

/**
 * The model a Claude Code worker runs on when nothing names one.
 *
 * The *default*, now that an operator can pick: what a run gets when it names no model.
 * Checked against the installed build's own catalogue rather than taken from a document.
 */
export const CLAUDE_CODE_DEFAULT_MODEL = "claude-sonnet-5";

/**
 * The option id a run carries for Claude Code's reasoning choice: the SDK's own word.
 *
 * `effort` because that is the option's name on the SDK's `Options` —
 * `effort?: EffortLevel` — and the id a selection names is the harness's rather than ours
 * (`@bit/contracts`'s `modelOption.ts`). Deliberately **not** `maxThinkingTokens`: the SDK
 * deprecates it in favour of `thinking`, treats it as on/off on current models, and a
 * token count is a number rather than a level, so it would not fit a `select` descriptor
 * honestly. If a budget ever has to be settable, it wants a numeric descriptor type and
 * not this one stretched.
 */
export const CLAUDE_CODE_EFFORT_OPTION = "effort";

/**
 * The reasoning levels this harness offers, and the one caveat worth stating.
 *
 * The five are the SDK's own `EffortLevel` union verbatim, so the ladder moves when the
 * dependency does. **Which models accept one is written down rather than observed**, for
 * the same reason the model list itself is: the SDK reports `supportsEffort` and
 * `supportedEffortLevels` on a *live query*'s model descriptor, so reading it at
 * layer-build time would mean starting a CLI session and prompting nothing to ask. The
 * honest consequence is recorded instead of hidden — the Claude 5 models carry this
 * descriptor and the 4-5 models carry none, and an operator who needs effort on a model
 * not listed with it can still get it from the harness's own configuration rather than
 * from a control this server offered on a guess.
 */
const CLAUDE_CODE_EFFORT: ModelOptionDescriptor = {
  id: CLAUDE_CODE_EFFORT_OPTION,
  label: "Reasoning",
  type: "select",
  options: [
    // Absence is how the SDK is told "your default", so this choice is dropped at the
    // edge rather than sent — see {@link claudeCodeEffortOf}.
    { id: MODEL_OPTION_DEFAULT_CHOICE, label: "Default", isDefault: true },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra high" },
    { id: "max", label: "Maximum" },
  ],
};

/**
 * The `effort` one session runs at, from the resolved selections.
 *
 * `undefined` for the default choice as well as for no choice at all, because the SDK has
 * no value meaning "your default" — absence *is* that value. The cast is confined to this
 * function: the ids above are the SDK's union members, and this is the one place where
 * that correspondence is asserted rather than inferred.
 */
const claudeCodeEffortOf = (
  options: readonly ModelOptionSelection[] | undefined,
): EffortLevel | undefined => {
  const value = options?.find(
    (option) => option.id === CLAUDE_CODE_EFFORT_OPTION,
  )?.value;
  if (value === undefined || value === MODEL_OPTION_DEFAULT_CHOICE)
    return undefined;
  return CLAUDE_CODE_EFFORT.options.some((choice) => choice.id === value)
    ? (value as EffortLevel)
    : undefined;
};

/**
 * The models this harness offers the picker.
 *
 * **Written down, and that is the honest shape here.** The SDK's own listing —
 * `supportedModels()` — hangs off a *live query* object, exactly like `accountInfo()`
 * does, so reading it at layer-build time would mean spawning a CLI session and prompting
 * nothing just to ask what models exist. `identity.ts` already refuses to probe `auth` for
 * that reason and this is the same obstacle, so it gets the same answer: state what is
 * known, do not invent a probe.
 *
 * Every id here appears in the installed `@anthropic-ai/claude-agent-sdk` build, so the
 * list moves when the dependency does rather than when somebody remembers to edit it.
 *
 * **Ids rather than the `sonnet`/`opus`/`haiku` aliases the SDK also accepts.** An alias
 * resolves inside the harness, so an attempt row that recorded one would say which family
 * ran and not which build — and `model_id` is provenance. An operator who wants an alias
 * can still name one: the list is what the picker offers, never what the harness accepts.
 */
export const CLAUDE_CODE_MODELS: readonly HarnessModelView[] = [
  { id: CLAUDE_CODE_DEFAULT_MODEL, optionDescriptors: [CLAUDE_CODE_EFFORT] },
  { id: "claude-opus-5", optionDescriptors: [CLAUDE_CODE_EFFORT] },
  // No descriptor on the 4-5 models: see {@link CLAUDE_CODE_EFFORT} on why that is a
  // written-down answer rather than an observed one.
  { id: "claude-sonnet-4-5" },
  { id: "claude-haiku-4-5" },
];

/**
 * The provider every Claude Code model runs on.
 *
 * One constant rather than a split, which is the whole of difference (3) in the file
 * header reduced to a line: OpenCode routes models through named providers of its own and
 * Claude Code has exactly one, so `modelProvenance` is a different function per harness
 * and not a shared parser.
 */
const CLAUDE_CODE_PROVIDER = "anthropic";

export const claudeCodeModelProvenance = (model: string): ModelProvenance => ({
  providerId: CLAUDE_CODE_PROVIDER,
  modelId: model,
});

/**
 * How many narration entries one session holds for a subscriber that is behind.
 *
 * Sliding, so a slow reader drops the *oldest* entry rather than back-pressuring the
 * stream that is reading the harness — the reasoning on `run/narration.ts` applies
 * identically one layer down. Dropped narration is an accepted loss; nothing reconciles
 * against it.
 */
const NARRATION_BUFFER = 512;

/**
 * The part of the SDK's `Query` this harness uses.
 *
 * Narrow on purpose. The real `Query` has forty methods and is structurally assignable to
 * this, so the production path passes the SDK's own object while a test can supply three
 * lines. Iterating it, interrupting it and closing it is the whole of what a run needs.
 */
export interface HarnessQuery extends AsyncIterable<SDKMessage> {
  /**
   * Registers MCP servers over the control channel.
   *
   * On this interface rather than only in the `query()` options because the options path
   * puts them on argv; see difference (2) in the file header.
   */
  setMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<{ readonly errors?: unknown }>;
  interrupt(): Promise<unknown>;
  close(): void;
}

/**
 * The three SDK entry points this harness calls, as one injectable seam.
 *
 * Bundled rather than three options because they are one dependency — "the Claude Agent
 * SDK" — and a test that replaced one and forgot another would be testing a chimera.
 */
export interface ClaudeCodeSdk {
  readonly query: (params: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => HarnessQuery;
  readonly sessionMessages: (
    sessionId: string,
    options: { readonly dir?: string },
  ) => Promise<readonly SessionMessage[]>;
  readonly sessionInfo: (
    sessionId: string,
    options: { readonly dir?: string },
  ) => Promise<SDKSessionInfo | undefined>;
}

/** The real SDK. The default, and the only thing the server passes. */
export const liveClaudeCodeSdk: ClaudeCodeSdk = {
  query: (params) => sdkQuery(params) satisfies Query,
  sessionMessages: (sessionId, options) =>
    sdkGetSessionMessages(sessionId, options),
  sessionInfo: (sessionId, options) => sdkGetSessionInfo(sessionId, options),
};

/** Everything one session is, before and after it is running. */
interface SessionRecord {
  readonly sessionId: string;
  readonly title: string;
  readonly model: string;
  /**
   * The reasoning level this session runs at, or nothing for the model's own.
   *
   * Held with the rest of the session's configuration rather than applied on creation,
   * because `createSession` here starts nothing: the SDK's `query()` is what takes it, and
   * that call does not happen until the prompt arrives. Same reason `model` is here.
   */
  readonly effort: EffortLevel | undefined;
  readonly directory: string;
  /** Per-attempt MCP registrations. One session's, never another's. */
  readonly mcpServers: Record<string, McpServerConfig>;
  /**
   * Where the pump publishes. Created with the record, so nothing races a subscriber.
   *
   * Typed with `Cause.Done` in its error channel so the pump can *end* it when the session
   * stops: `Stream.fromQueue` then completes, and a subscriber learns the session is over
   * without having to be interrupted. OpenCode's stream has no such signal — it stays open
   * until the consuming fiber is cancelled — so the supervisor is written for the weaker
   * case and simply finishes earlier here.
   */
  readonly narration: Queue.Queue<HarnessNarration, Cause.Done>;
  /** Completed by the pump when the session stops running, however it stopped. */
  readonly idle: Deferred.Deferred<void, HarnessFailure>;
  /** The live query, once {@link prompt} has launched one. */
  query: HarnessQuery | undefined;
  /** Releases the held-back prompt once the MCP registration is in place. */
  release: (() => void) | undefined;
  /** The harness's own terminal answer, as the pump read it off a `result` message. */
  outcome: TerminalOutcome | undefined;
  /** Estimated cost in USD, from the last `result`. Reported, never acted on. */
  cost: number | undefined;
  tokens: Record<string, unknown> | undefined;
  /** Set by {@link interruptSession}, so the outcome is `interrupted` and not `failed`. */
  interrupted: boolean;
  /** The query has been closed; nothing more will arrive. */
  closed: boolean;
}

/** What a caller may vary about this harness. */
export interface ClaudeCodeHarnessOptions {
  /** The model a run gets when it names none. */
  readonly defaultModel?: string;
  /** Swapped out by tests. Defaults to {@link liveClaudeCodeSdk}. */
  readonly sdk?: ClaudeCodeSdk;
  /**
   * How long a control request to a live session may take.
   *
   * Bounds *our* ask, not the worker. It covers `setMcpServers` and `interrupt`, both of
   * which are round trips to a subprocess that may be wedged; neither ever decides an
   * outcome.
   */
  readonly controlTimeout?: Duration.Input;
}

const DEFAULT_CONTROL_TIMEOUT: Duration.Input = "30 seconds";

/**
 * Which Claude Code build this harness will actually run.
 *
 * Read from the SDK package's own manifest rather than written down here, so an upgrade
 * cannot leave the instance reporting a version somebody noted once. `claudeCodeVersion`
 * is the CLI build the SDK carries and spawns, which is the thing that runs the session —
 * the SDK's own `version` is a different number and would be the wrong answer to "which
 * build ran this".
 *
 * `import.meta.resolve` rather than importing the manifest: the package's `exports` map
 * does not publish `./package.json`, so a direct import would not resolve. A failure here
 * is reported as `unknown`, because a version string is diagnostics and must not be able
 * to stop a harness from being built.
 */
const sdkClaudeCodeVersion = Effect.gen(function* () {
  const read = yield* Effect.result(
    Effect.tryPromise(() =>
      Bun.file(
        new URL(
          "package.json",
          import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
        ),
      ).json(),
    ),
  );
  if (read._tag === "Failure") return "unknown";
  const manifest = (read.success ?? {}) as { claudeCodeVersion?: unknown };
  return typeof manifest.claudeCodeVersion === "string"
    ? manifest.claudeCodeVersion
    : "unknown";
});

const transport = (
  operation: string,
  detail: string,
  options?: { readonly tag?: string; readonly status?: number },
): HarnessTransportError =>
  new HarnessTransportError({
    operation,
    status: options?.status,
    tag: options?.tag ?? "ClaudeCodeError",
    detail,
    cause: detail,
  });

/**
 * Reduces one SDK message to {@link HarnessNarration}.
 *
 * `type` is the SDK's own message type, verbatim and unmapped, for the reason the
 * interface gives: the vocabulary belongs to the harness. It is coarser than OpenCode's —
 * `assistant`, `user`, `result`, `system` against twenty-odd `session.*` names — and that
 * is a real difference the seam absorbs by not promising a vocabulary at all.
 *
 * `sequence` is `undefined` because there is no cursor to carry: the SDK's stream is not
 * resumable from a position, which is exactly why that field is optional on the interface.
 *
 * `at` is receipt time. The SDK messages carry no timestamp of their own, so this is when
 * *we* saw it — stated rather than implied, because a consumer comparing it against
 * OpenCode's `created` is comparing two different clocks.
 */
const narrate = (
  message: SDKMessage,
  outcome: TerminalOutcome | undefined,
): HarnessNarration => ({
  type: message.type,
  sequence: undefined,
  at: Date.now(),
  outcome,
});

/**
 * The outcome a `result` message states, or `undefined` for every other message.
 *
 * `interrupted` wins over whatever the result says, and only when we are the ones who
 * interrupted: the SDK reports an interrupted turn as `error_during_execution`, which is
 * indistinguishable from a genuine failure on the wire. We know which it was, so saying
 * `failed` there would be recording a claim about the work that we know to be wrong.
 */
const outcomeOf = (
  message: SDKMessage,
  interrupted: boolean,
): TerminalOutcome | undefined => {
  if (message.type !== "result") return undefined;
  if (interrupted) return "interrupted";
  return message.subtype === "success" ? "succeeded" : "failed";
};

/** Reduces one stored transcript entry to the three fields a caller uses. */
const flatten = (entry: SessionMessage): MessageEntry => {
  const message = (entry.message ?? {}) as {
    content?: unknown;
    text?: unknown;
  };
  const parts = Array.isArray(message.content) ? message.content : [];
  return {
    type: entry.type,
    text:
      typeof message.content === "string"
        ? message.content
        : parts
            .filter(
              (part): part is { type: string; text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
            )
            .map((part) => part.text)
            .join("\n"),
    // The stored transcript carries no error channel of its own; a failure arrives as a
    // `result` message on the live stream and is settled from there. Reporting
    // `undefined` is the honest answer rather than scraping text for the word "error".
    error: undefined,
  };
};

export const claudeCodeHarness = (
  options: ClaudeCodeHarnessOptions = {},
): Layer.Layer<AgentHarness, HarnessProcessError> =>
  Layer.effect(
    AgentHarness,
    Effect.gen(function* () {
      const sdk = options.sdk ?? liveClaudeCodeSdk;
      const defaultModel = options.defaultModel ?? CLAUDE_CODE_DEFAULT_MODEL;
      const controlTimeout = options.controlTimeout ?? DEFAULT_CONTROL_TIMEOUT;

      /** The layer's own scope, so the pump below outlives the fiber that started it. */
      const harnessScope = yield* Effect.scope;

      /**
       * The build floor, enforced before anything else in this layer.
       *
       * The gate's outer fail-closed guarantee is `onFailure: "block"` on the hook entry,
       * which an older Claude Code **silently ignores** — so a hook that could not start
       * would let its tool call through, and the only trace would be an audit file missing
       * a line nobody knew to look for. A guarantee that silently is not there is worse
       * than one that was never claimed, so this refuses the harness instead of offering a
       * quietly weaker one. `main.ts` catches it, says so at startup, and serves without
       * an agent — the same disposition as a `HARNESS` nobody recognises.
       *
       * An unreadable version refuses too. `version` is otherwise a diagnostic and would
       * degrade to `"unknown"`, but here it is the evidence for a safety property, and
       * "we could not tell" is not a basis for claiming it.
       *
       * The version is the CLI build the SDK carries and spawns — we never set
       * `pathToClaudeCodeExecutable` — so this is deterministic rather than a guess about
       * whatever `claude` happens to be on the PATH.
       */
      const version = yield* sdkClaudeCodeVersion;
      if (version === "unknown") {
        return yield* new HarnessProcessError({
          operation: "version",
          detail: `could not read which Claude Code build the Agent SDK carries, so it cannot be established that this one honours 'onFailure' on a PreToolUse hook (${CLAUDE_CODE_MINIMUM} or newer); refusing to offer a harness whose policy gate might fail open`,
          diagnostics: "",
        });
      }
      if (compareVersions(version, CLAUDE_CODE_MINIMUM) < 0) {
        return yield* new HarnessProcessError({
          operation: "version",
          detail: `the Claude Agent SDK carries Claude Code ${version}, which silently ignores 'onFailure' on a PreToolUse hook; the policy gate needs ${CLAUDE_CODE_MINIMUM} or newer to fail closed when the hook itself cannot run. Upgrade @anthropic-ai/claude-agent-sdk, or run with HARNESS=opencode.`,
          diagnostics: "",
        });
      }

      const instance: HarnessInstance = {
        instanceId: defaultInstanceIdForDriver(CLAUDE_CODE_DRIVER),
        driver: CLAUDE_CODE_DRIVER,
        displayName: "Claude Code",
        version,
        installed: true,
        // See `identity.ts`: `accountInfo()` needs a live session, so probing it here would
        // mean starting one per process just to ask.
        auth: "unknown",
        defaultModel,
        // The default first and never twice, so a caller that configured its own default
        // gets a pickable list rather than one that omits the model it will actually use.
        models: [
          CLAUDE_CODE_MODELS.find((model) => model.id === defaultModel) ?? {
            id: defaultModel,
          },
          ...CLAUDE_CODE_MODELS.filter((model) => model.id !== defaultModel),
        ],
      };

      /**
       * Every session this process has created, running or not.
       *
       * Retained after settlement on purpose: `sessionStatus` is asked during the
       * supervisor's finalizer, *after* the session has stopped, and a record dropped at
       * close would turn every clean run into "the harness does not know this session".
       * Bounded by the process's lifetime, which is the same bound `run/supervisor.ts`
       * puts on its own settlement memory.
       */
      const sessions = new Map<string, SessionRecord>();

      /**
       * Closes one session's query and ends its narration.
       *
       * Called when the pump sees a terminal `result`, and again from this layer's
       * finalizer for anything still open. Idempotent, because those two can race on a
       * shutdown that lands while a run is settling.
       *
       * **The harness closes its own sessions**, rather than the interface growing a
       * `closeSession` the supervisor would have to remember to call. OpenCode's sessions
       * outlive the run by design — its server keeps them — so a close on the interface
       * would be a method one implementation ignored, and a leaked CLI subprocess per run
       * if anybody forgot it.
       */
      const closeSession = (record: SessionRecord): Effect.Effect<void> =>
        Effect.sync(() => {
          if (record.closed) return;
          record.closed = true;
          record.release?.();
          try {
            record.query?.close();
          } catch {
            // Closing a query that has already exited throws in some SDK paths. The
            // session is over either way and this must not become the run's failure.
          }
        }).pipe(Effect.andThen(Queue.end(record.narration)));

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...sessions.values()],
          (record) => closeSession(record),
          { discard: true },
        ),
      );

      const recordFor = (
        operation: string,
        sessionId: string,
      ): Effect.Effect<SessionRecord, HarnessTransportError> => {
        const record = sessions.get(sessionId);
        return record === undefined
          ? Effect.fail(
              transport(
                operation,
                `this process holds no session ${sessionId}`,
                { tag: SESSION_NOT_FOUND_TAG, status: 404 },
              ),
            )
          : Effect.succeed(record);
      };

      /**
       * Drains one query into its session's narration, and settles it.
       *
       * Runs as a detached fiber for the life of the session. It is **not** what decides
       * the run's outcome — the supervisor ranks `sessionStatus` first — but it is where
       * the outcome comes *from*, because `result` is the only place the SDK states one.
       *
       * A failure from the generator completes `idle` as a failure, which the supervisor
       * reads as `waitFailed`: our stream losing its answer says nothing about what the
       * session did (DECISIONS.md §15), and the prompt is never resubmitted.
       */
      const pump = (record: SessionRecord): Effect.Effect<void> =>
        Effect.gen(function* () {
          const live = record.query;
          if (live === undefined) return;
          const drained = yield* Effect.result(
            Effect.tryPromise({
              try: async () => {
                for await (const message of live) {
                  const outcome = outcomeOf(message, record.interrupted);
                  if (message.type === "result") {
                    record.outcome = outcome;
                    record.cost = message.total_cost_usd;
                    record.tokens = message.usage as unknown as Record<
                      string,
                      unknown
                    >;
                  }
                  Queue.offerUnsafe(
                    record.narration,
                    narrate(message, outcome),
                  );
                  // One prompt, one turn: the first result is the end of the run. Reading
                  // on would mean waiting for input that will never be sent.
                  if (message.type === "result") break;
                }
              },
              catch: (cause) =>
                transport(
                  "query.stream",
                  `the Claude Code stream ended in failure: ${String(cause)}`,
                ),
            }),
          );
          yield* drained._tag === "Failure"
            ? Deferred.fail(record.idle, drained.failure)
            : Deferred.succeed(record.idle, undefined);
          yield* closeSession(record);
        });

      /**
       * Launches the query for one session, with the prompt held back.
       *
       * The gate is the point. `query()` starts with no MCP servers — see difference (2) in
       * the file header — so the registration has to go over the control channel before
       * the model sees the prompt. The input iterable therefore awaits `release` before
       * yielding, and `release` is called after `setMcpServers` has answered.
       *
       * The iterable never completes on its own. Ending it would close the CLI's stdin,
       * and a session whose input has ended is one `interrupt()` has nothing to reach; the
       * query is ended by {@link closeSession} instead, which is the one place a session's
       * lifetime is decided.
       */
      const launch = (
        record: SessionRecord,
        text: string,
      ): Effect.Effect<void, HarnessTransportError> =>
        Effect.gen(function* () {
          const released = Promise.withResolvers<void>();
          record.release = released.resolve;

          const input = async function* (): AsyncGenerator<SDKUserMessage> {
            await released.promise;
            if (record.closed) return;
            yield {
              type: "user",
              message: { role: "user", content: text },
              parent_tool_use_id: null,
              session_id: record.sessionId,
            } as SDKUserMessage;
            // Held open deliberately; see this function's header.
            await new Promise<void>((resolve) => {
              const previous = record.release;
              record.release = () => {
                previous?.();
                resolve();
              };
            });
          };

          const started = yield* Effect.try({
            try: () =>
              sdk.query({
                prompt: input(),
                options: {
                  cwd: record.directory,
                  model: record.model,
                  sessionId: record.sessionId,
                  // Spread rather than passed as `undefined`: the SDK reads an absent
                  // `effort` as "whatever this model does", and an explicit `undefined`
                  // is the same thing said less clearly.
                  ...(record.effort === undefined
                    ? {}
                    : { effort: record.effort }),
                  // The gate lives in `.claude/settings.local.json` in `cwd`; stated
                  // rather than defaulted so a future default cannot un-gate a run.
                  settingSources: ["user", "project", "local"],
                  // Our `PreToolUse` gate is the permission authority; see the header.
                  permissionMode: "dontAsk",
                  // Without this, a subagent's text never reaches the stream.
                  forwardSubagentText: true,
                  // Needed for `messages` to have anything to read later.
                  persistSession: true,
                  stderr: (data) => {
                    // Diagnostics only. A line on the CLI's stderr is not an outcome, and
                    // this must not be able to fail the run.
                    void Effect.runPromise(
                      Effect.logDebug("claude code stderr", {
                        sessionId: record.sessionId,
                        data,
                      }),
                    ).catch(() => undefined);
                  },
                },
              }),
            catch: (cause) =>
              transport(
                "query.start",
                `the Claude Agent SDK would not start a session: ${String(cause)}`,
              ),
          });
          record.query = started;

          // Forked into the *layer's* scope and not the caller's. The caller is the
          // supervisor's `prompt` call, which returns as soon as the prompt is accepted,
          // and a pump that died with it would leave `idle` uncompleted — a run that hangs
          // instead of settling. The layer's scope is also what interrupts it on shutdown,
          // so there is no fiber to leak either way.
          yield* Effect.forkIn(pump(record), harnessScope);

          if (Object.keys(record.mcpServers).length > 0) {
            const registered = yield* Effect.result(
              Effect.timeout(
                Effect.tryPromise({
                  try: () => started.setMcpServers(record.mcpServers),
                  catch: (cause) =>
                    transport(
                      "mcp_set_servers",
                      `the session would not accept its MCP registration: ${String(cause)}`,
                    ),
                }),
                controlTimeout,
              ),
            );
            if (registered._tag === "Failure") {
              // Nothing has been prompted yet, so this refuses the prompt rather than
              // starting a worker with no tools — which is the failure mode that is
              // silent, because a worker with no `record_observation` simply records
              // nothing.
              yield* closeSession(record);
              return yield* registered.failure._tag === "TimeoutError"
                ? transport(
                    "mcp_set_servers",
                    "the session did not acknowledge its MCP registration within the control bound",
                    { tag: "TimeoutError" },
                  )
                : registered.failure;
            }
          }

          released.resolve();
        });

      const createSession: AgentHarness["Service"]["createSession"] = Effect.fn(
        "claudeCodeHarness.createSession",
      )(function* (input) {
        const sessionId = input.sessionId ?? newClaudeCodeSessionId();
        const narration = yield* Queue.sliding<HarnessNarration, Cause.Done>(
          NARRATION_BUFFER,
        );
        const idle = yield* Deferred.make<void, HarnessFailure>();
        sessions.set(sessionId, {
          sessionId,
          title: input.title,
          model: input.model,
          effort: claudeCodeEffortOf(input.options),
          directory: input.directory,
          mcpServers: {},
          narration,
          idle,
          query: undefined,
          release: undefined,
          outcome: undefined,
          cost: undefined,
          tokens: undefined,
          interrupted: false,
          closed: false,
        });
        // `parentSessionId` is ignored: Claude Code has no lineage concept to route prompt
        // caching through, and nothing in this application passes it for a worker session.
        return { id: sessionId };
      });

      const registerMcpServer: AgentHarness["Service"]["registerMcpServer"] =
        Effect.fn("claudeCodeHarness.registerMcpServer")(function* (
          sessionId,
          name,
          config: McpRegistration,
        ) {
          const record = yield* recordFor("mcp.add", sessionId);
          // Keyed by name on this session's own record, so one attempt's credential is
          // not reachable from another's session even in memory.
          record.mcpServers[name] = {
            type: "http",
            url: config.url,
            // Unwrapped only here, into the object that will travel in a control
            // request body. It never reaches argv; see the file header.
            headers: Object.fromEntries(
              Object.entries(config.headers).map(([key, value]) => [
                key,
                Redacted.value(value),
              ]),
            ),
            // Blocks session startup until the server is connected, so the turn-1 prompt
            // is built with our tools present rather than without them.
            alwaysLoad: true,
          };
        });

      const prompt: AgentHarness["Service"]["prompt"] = Effect.fn(
        "claudeCodeHarness.prompt",
      )(function* (sessionId, text) {
        const record = yield* recordFor("session.prompt", sessionId);
        if (record.query !== undefined) {
          return yield* transport(
            "session.prompt",
            `session ${sessionId} has already been prompted; carrying work on means a new attempt identity`,
          );
        }
        yield* launch(record, text);
      });

      const waitForIdle: AgentHarness["Service"]["waitForIdle"] = Effect.fn(
        "claudeCodeHarness.waitForIdle",
      )(function* (sessionId) {
        const record = yield* recordFor("session.wait", sessionId);
        yield* Deferred.await(record.idle);
      });

      const sessionStatus: AgentHarness["Service"]["sessionStatus"] = Effect.fn(
        "claudeCodeHarness.sessionStatus",
      )(function* (sessionId) {
        const record = sessions.get(sessionId);
        if (record !== undefined) {
          return {
            outcome: record.outcome,
            cost: record.cost,
            tokens: record.tokens,
          };
        }
        /**
         * Not ours, so there is nothing that can be asked — and that is a *definite*
         * fact here, which is the one place this harness could not copy OpenCode's
         * answer.
         *
         * A Claude Code session is run by a CLI subprocess the SDK owns. It does not
         * outlive the process that spawned it, so a session id this process does not hold
         * is a session that is **not running**, whatever the transcript on disk says.
         *
         * Reporting `{}` here — "exists, nothing definite", which is what the transcript
         * literally supports — was wrong, and a live crash-and-restart is what showed it:
         * recovery read `{}` as `running`, recorded `still_running`, left the row
         * `running` and bumped no fence. Nothing would ever have refined it, because the
         * transcript will never gain an outcome. That is exactly the pile of stuck
         * `running` rows recovery exists to prevent.
         *
         * So both branches fail, and the failure is honest in both: we could not ask.
         * `recovery/harnessStatus.ts` maps them to `missing` and `unreachable`, which are
         * both `uncertain` — the right answer, reached for the right reason. The
         * transcript lookup is still worth doing, because "we have this session's
         * transcript" and "we have never heard of this id" are different facts to an
         * operator, and the detail says which.
         *
         * OpenCode lands in the same place by a different route: a restart spawns a new
         * `opencode serve` that has never heard of the old session, so it answers
         * `SessionNotFoundError` → `missing` → `uncertain`.
         */
        const info = yield* Effect.tryPromise({
          try: () => sdk.sessionInfo(sessionId, {}),
          catch: (cause) =>
            transport(
              "session.get",
              `could not read the Claude Code session store: ${String(cause)}`,
            ),
        });
        return yield* info === undefined
          ? transport(
              "session.get",
              `the Claude Code session store holds no session ${sessionId}`,
              { tag: SESSION_NOT_FOUND_TAG, status: 404 },
            )
          : transport(
              "session.get",
              `session ${sessionId} has a transcript on disk but is not running in this process, and a Claude Code session does not outlive the process that spawned it; how it ended cannot be established from here`,
            );
      });

      const messages: AgentHarness["Service"]["messages"] = Effect.fn(
        "claudeCodeHarness.messages",
      )(function* (sessionId) {
        const directory = sessions.get(sessionId)?.directory;
        const entries = yield* Effect.tryPromise({
          try: () =>
            sdk.sessionMessages(
              sessionId,
              directory === undefined ? {} : { dir: directory },
            ),
          catch: (cause) =>
            transport(
              "message.list",
              `could not read session ${sessionId}'s transcript: ${String(cause)}`,
            ),
        });
        return entries.map(flatten);
      });

      const interruptSession: AgentHarness["Service"]["interruptSession"] =
        Effect.fn("claudeCodeHarness.interruptSession")(function* (sessionId) {
          const record = sessions.get(sessionId);
          // A session we do not hold, or one that never started or has already finished,
          // is not a failure: `false` means "there was nothing running to interrupt",
          // which is a different fact from "we could not reach the harness".
          if (
            record === undefined ||
            record.query === undefined ||
            record.closed
          ) {
            return false;
          }
          // Set before asking, so a `result` arriving mid-interrupt is read as
          // `interrupted` rather than as the `error_during_execution` the SDK reports.
          record.interrupted = true;
          const live = record.query;
          const asked = yield* Effect.result(
            Effect.timeout(
              Effect.tryPromise({
                try: () => live.interrupt(),
                catch: (cause) =>
                  transport(
                    "session.interrupt",
                    `the session would not acknowledge an interrupt: ${String(cause)}`,
                  ),
              }),
              controlTimeout,
            ),
          );
          // Closed either way: the attempt is over, and a CLI subprocess left behind by a
          // refused interrupt is the one leak worth paying a forced close for.
          yield* closeSession(record);
          if (asked._tag === "Failure") {
            yield* Effect.logWarning(
              "a Claude Code session would not acknowledge an interrupt; its query was closed anyway",
              { sessionId, detail: String(asked.failure) },
            );
            return false;
          }
          return true;
        });

      const sessionEvents: AgentHarness["Service"]["sessionEvents"] = (
        sessionId,
      ) =>
        Stream.unwrap(
          Effect.map(recordFor("event.subscribe", sessionId), (record) =>
            Stream.fromQueue(record.narration),
          ),
        );

      return AgentHarness.of({
        instance,
        newSessionId: newClaudeCodeSessionId,
        modelProvenance: claudeCodeModelProvenance,
        installGate: installClaudeCodeGate,
        createSession,
        registerMcpServer,
        prompt,
        waitForIdle,
        sessionStatus,
        messages,
        interruptSession,
        sessionEvents,
      });
    }),
  );

/**
 * A session id this application mints, in Claude Code's own format.
 *
 * A UUID, because the SDK documents `sessionId` as "Must be a valid UUID" and rejects
 * anything else — which is the whole reason minting is on the harness interface rather
 * than a shared helper. `crypto.randomUUID` rather than a formatted random string: the
 * format is somebody else's and a value built by hand would be our guess at it.
 */
export const newClaudeCodeSessionId = (): string => crypto.randomUUID();
