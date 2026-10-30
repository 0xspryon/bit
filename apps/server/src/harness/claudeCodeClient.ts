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
  OPEN_PROMPT,
  SESSION_NOT_FOUND_TAG,
  truncateNarration,
  type HarnessFailure,
  type HarnessNarration,
  type McpRegistration,
  type MessageEntry,
  type NarrationDetail,
  type PromptDelivery,
  type TerminalOutcome,
} from "./agentHarness";
import { HarnessProcessError, HarnessTransportError } from "./errors";
import { claudeCodeMessageId } from "./messageId";
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
 *
 * **No `contextLimit` on any entry, and that is the same refusal.** `ModelInfo` carries no
 * context-window field at all, so there is nothing here to read one from; the only figure
 * this driver states is `getContextUsage().maxTokens`, which belongs to a *session* and to
 * the account that opened it (DECISIONS.md §24.4 saw 1 000 000 for `claude-sonnet-5` on
 * this account). Writing that into this list would turn one observation into a constant
 * every future deployment would inherit, so the limit rides the session instead and the
 * picker says nothing about a window it cannot know.
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
  /**
   * What this session's model takes, as a control request.
   *
   * **The only honest source of a Claude Code context limit, and it is session-time.**
   * `supportedModels()` carries no window at all and `CLAUDE_CODE_MODELS` is a written-down
   * list, so there is nothing to read a limit from before a session exists; this answers
   * from `system/init` onward, before any model response (DECISIONS.md §24.4). The figure
   * is this account's, for the model as this session resolved it — which is exactly why it
   * must not be copied into a constant.
   *
   * Narrowed to the one field read, like `setMcpServers`' return: the SDK's own response is
   * a dozen fields of category breakdown, and `totalTokens` among them is a *category
   * estimate* that did not move between two turns whose real contexts differed. The meter's
   * numerator comes from the stream; only the denominator comes from here.
   */
  getContextUsage(): Promise<{ readonly maxTokens?: number }>;
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
  /**
   * Whether this session survives going idle and may be prompted again.
   *
   * From `createSession`'s `multiTurn`. A worker attempt and a planner round are `false`:
   * one prompt, one turn, and the pump closes the query when that turn's `result` arrives.
   * A goal conversation is `true` and the query is held open across turns, because the
   * operator may say something else at any time and a closed query cannot be prompted.
   */
  readonly multiTurn: boolean;
  /**
   * Completed by the pump when every accepted message has produced its `result`.
   *
   * **Replaced, not reused, when an idle session accepts another message.** A `Deferred`
   * completes once, and a conversation's second turn needs a fresh one — otherwise
   * `waitForIdle` on turn two would return instantly with turn one's answer. Mutable for
   * that reason and no other; `waitForIdle` reads it at the moment it is called.
   */
  idle: Deferred.Deferred<void, HarnessFailure>;
  /**
   * How many messages this session has accepted, and how many have completed.
   *
   * The pair is what makes `waitForIdle` mean "idle after the last accepted message"
   * (DECISIONS.md §24.1, consequence 4). The SDK emits one `result` per turn and a steered
   * session has two turns, so a pump that stopped at the first `result` would end the
   * session while the directive's own turn was still queued. Counted here rather than
   * inferred from the stream, because the only thing that knows a second message was
   * accepted is the call that accepted it.
   */
  accepted: number;
  completed: number;
  /**
   * The pump has decided this session is over and is on its way out.
   *
   * Set **synchronously**, in the same microtask as the check that decided it, and read
   * synchronously by `prompt` before it accepts a steer. That is what closes the one
   * window the supervisor's own claim cannot: between the pump reading
   * `completed >= accepted` and `closeSession` running there is an Effect boundary, and a
   * steer that landed in it would be queued into a session that is about to close and
   * reported as delivered.
   *
   * **Both sides have to be yield-free for that to be true**, which is a requirement on
   * `prompt` rather than on this field: a review found a `yield* Deferred.isDone(...)`
   * between the read and the `accepted += 1`, which is a fiber suspension point and left
   * the window open. `prompt` now uses `Deferred.isDoneUnsafe` and carries the reasoning at
   * the line. Nothing but those two places touches this.
   */
  settling: boolean;
  /** The application message ids this session has accepted, so a retry delivers once. */
  readonly deliveredIds: Set<string>;
  /** The live query, once {@link prompt} has launched one. */
  query: HarnessQuery | undefined;
  /** Releases the held-back prompt once the MCP registration is in place. */
  release: (() => void) | undefined;
  /** Pushes one more message into the live input iterable. Set by `launch`. */
  offer: ((message: SDKUserMessage) => void) | undefined;
  /** Wakes the input iterable when it is parked on an empty queue. Set by `launch`. */
  wake: (() => void) | undefined;
  /** The harness's own terminal answer, as the pump read it off a `result` message. */
  outcome: TerminalOutcome | undefined;
  /** Estimated cost in USD, from the last `result`. Reported, never acted on. */
  cost: number | undefined;
  tokens: Record<string, unknown> | undefined;
  /**
   * What this session's model takes, once the control request has answered.
   *
   * On the session and not on the model view, because that is where the fact lives: see
   * {@link HarnessQuery.getContextUsage}. `undefined` until it answers, and `undefined`
   * forever if it does not — the meter then shows tokens with no percentage, which is the
   * accurate rendering of "we do not know the window".
   */
  contextLimit: number | undefined;
  /**
   * The id of the last model call seen on this stream.
   *
   * **The join between a call and its own output count.** An `assistant` frame's
   * `output_tokens` is the `message_start` snapshot and is stale; the true figure arrives
   * at turn end in `result.usage.iterations[0]`, which carries **no message id at all**
   * (checked against the probe's raw frames). So the only thing that can attribute that
   * figure to a call is the stream's own order, which is what this remembers.
   *
   * Nothing is guessed when it is absent: a `result` on a stream that produced no
   * `assistant` frame states no usage rather than inventing a call to hang it on.
   */
  lastCallId: string | undefined;
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

/** `JSON.stringify` that answers with something for a value it cannot serialise. */
const asJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // A tool input the SDK handed us that will not serialise. The call still happened and
    // still has to appear, so it appears with its arguments unavailable rather than not.
    return "";
  }
};

/**
 * One `tool_result` block's content, as one string.
 *
 * The Messages API allows the block's `content` to be a bare string or a list of blocks,
 * so both are read. A block kind with no text — an image result — is named rather than
 * dropped, because "the tool answered with an image" is not "the tool answered nothing".
 */
const resultText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = (part ?? {}) as { type?: unknown; text?: unknown };
      if (typeof record.text === "string") return record.text;
      return typeof record.type === "string" ? `[${record.type}]` : "";
    })
    .filter((text) => text !== "")
    .join("\n");
};

/**
 * What this application reads one SDK message as — zero, one or several entries.
 *
 * **Several, because one SDK message is several moments.** An `assistant` message's
 * `message.content` is a list of blocks, and a turn that says something and then calls two
 * tools arrives as one message holding a `text` block and two `tool_use` blocks
 * (`@anthropic-ai/claude-agent-sdk@0.3.310`'s `SDKAssistantMessage.message: BetaMessage`).
 * Reducing that to one entry would mean choosing which of the three to show, so this
 * returns a list and the caller offers each.
 *
 * The block kinds read, and where each comes from:
 *
 * - `assistant` → `text` blocks become `reply`, `tool_use` blocks (`{ id, name, input }`)
 *   become `toolCall`, `thinking` blocks become `thinking`. All three are complete when
 *   they arrive; the SDK streams partial content as `stream_event` messages, which this
 *   build does not ask for.
 * - `assistant` → one `usage` entry as well, from `message.usage`. See
 *   {@link usageOfAssistant} for why its output count is omitted rather than reported, and
 *   why several frames of one call carrying the same figures is correct here.
 * - `result` → one `usage` entry from `usage.iterations[0]`, which is the last call alone
 *   and is the only exact output count that needs neither partial messages nor a second
 *   request. The `result`'s own `usage` is a **per-turn sum** and is never read for this.
 * - `user` → `tool_result` blocks (`{ tool_use_id, content, is_error }`) become
 *   `toolResult`. A tool's output comes back as a *user* message because that is how the
 *   Messages API carries it, which reads oddly and is the SDK's shape rather than ours.
 * - everything else → one `opaque` entry, so the stream's shape and the supervisor's
 *   outcome watch are unchanged by this mapping.
 *
 * **`toolResult.tool` is `undefined` here, and it is not an oversight.** A `tool_result`
 * block names the call it answers (`tool_use_id`) and not the tool, and the id is enough
 * for a reader to pair it with the `toolCall` entry that *does* carry the name. Keeping a
 * map from id to name across the stream, as the OpenCode client must, would buy nothing:
 * there the arguments and the name arrive on different events, and here they arrive
 * together.
 *
 * `type` is the SDK's own message type, verbatim and unmapped, for the reason the
 * interface gives: the vocabulary belongs to the harness. It is coarser than OpenCode's —
 * `assistant`, `user`, `result`, `system` against twenty-odd `session.*` names — and that
 * is a real difference the seam absorbs by not promising a vocabulary at all. Every entry
 * derived from one message carries that one `type`.
 *
 * `sequence` is `undefined` because there is no cursor to carry: the SDK's stream is not
 * resumable from a position, which is exactly why that field is optional on the interface.
 *
 * `at` is receipt time. The SDK messages carry no timestamp of their own, so this is when
 * *we* saw it — stated rather than implied, because a consumer comparing it against
 * OpenCode's `created` is comparing two different clocks.
 *
 * The `outcome` is carried on the **last** entry of the list, and only `result` messages
 * have one, so the question of which of several entries states it does not arise.
 */
/** A finite number, or zero for anything else. The usage fields read defensively. */
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * The prompt side of one call, from either an `assistant` frame's usage or an iteration.
 *
 * The three fields are disjoint parts of what was sent, so this is their sum: the uncached
 * remainder, the cached prefix that was read, and whatever was written to the cache. The
 * input side of an `assistant` frame is **exact** — it is only the output side that is a
 * snapshot — which is what makes a meter possible without partial messages.
 */
const promptTokensOf = (usage: unknown): number => {
  const record = (usage ?? {}) as Record<string, unknown>;
  return (
    count(record["input_tokens"]) +
    count(record["cache_read_input_tokens"]) +
    count(record["cache_creation_input_tokens"])
  );
};

/**
 * Whether this frame came from a **subagent** rather than from the session's own loop.
 *
 * `parent_tool_use_id` is the `Task` call a forwarded subagent frame is nested under; it is
 * `null` on every frame of the main loop (`null` on all eight of DECISIONS.md §24.4's
 * captures, which ran no subagent).
 *
 * **Read from the SDK's documentation, not from a measurement, and that is the whole of the
 * evidence.** `sdk.d.ts:3686` states it in as many words — "`parent_tool_use_id` is non-null
 * when the message was produced inside a subagent started by that tool_use" — and no run in
 * this repository has ever produced one: §24.4's probe started no subagent, so **nothing
 * here has observed a forwarded frame at all**, and whether such a frame even carries
 * `message.usage` is unknown. The guard is written so that it does not need to know: it
 * excludes the frame *before* any usage is read, so the unmeasured case costs a measurement
 * this build would rather not have than produce a wrong one. What would change if the
 * documented meaning turned out to be narrower is that a subagent's context could reach a
 * pane's meter again, which is the defect this exists to prevent.
 *
 * **It matters because this build pins `forwardSubagentText: true`** — without it a
 * subagent's text and thinking never reach the stream — and the policy gate's default
 * answer is `allow`, so a `Task` call is reachable on any run. A subagent has its own
 * context: its prompt size is not this session's, and a meter that took its newest frame
 * would change subject without saying so, which is the one defect this meter is not allowed
 * to have.
 */
const fromSubagent = (message: SDKMessage): boolean =>
  (message as { parent_tool_use_id?: unknown }).parent_tool_use_id != null;

/**
 * One `assistant` frame's usage entry, or nothing if it is not a measurement of this
 * session.
 *
 * **`outputTokens` is deliberately `undefined` here.** The usage on an `assistant` frame is
 * the `message_start` snapshot: DECISIONS.md §24.4 measured a call that produced 16 output
 * tokens reporting `output_tokens: 1`, and one that produced 153 reporting 2, with partial
 * messages both on and off. Publishing that would be a precise-looking number that is wrong
 * by two orders of magnitude, so the field is left unstated until the `result` states it.
 *
 * Several frames of one call each produce one of these, with the same id and the same
 * figures, because one API call arrives as one frame per content block. That is not
 * de-duplicated here — this function is called from a stateless mapping and a reader keys
 * the latest per `callId` — and it is harmless precisely because nothing sums them.
 *
 * **A subagent's frame produces no entry at all** ({@link fromSubagent}), and the harness's
 * own accounting agrees that this is the right unit: the SDK documents `result.usage` as
 * "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls", so
 * the `iterations` this driver's output count comes from describe main-loop calls. Letting a
 * subagent's frame set {@link SessionRecord.lastCallId} would hang that output count on a
 * call it is not about. The subagent's *text and thinking still narrate* — they are what the
 * forwarding option exists for, and they are transcript content rather than a measurement.
 */
const usageOfAssistant = (
  message: SDKMessage,
  contextLimit: number | undefined,
): NarrationDetail | undefined => {
  if (fromSubagent(message)) return undefined;
  const envelope = (message as { message?: { id?: unknown; usage?: unknown } })
    .message;
  const callId = envelope?.id;
  if (typeof callId !== "string") return undefined;
  return {
    _tag: "usage",
    callId,
    promptTokens: promptTokensOf(envelope?.usage),
    outputTokens: undefined,
    contextLimit,
    // Claude Code states no compaction threshold this build has measured. Its context
    // breakdown carries `autocompact_buffer` and `compact_buffer` categories, so one
    // exists; deriving a number from a policy nobody measured is what
    // `HarnessModelView.compactionAt` forbids.
    compactionAt: undefined,
  };
};

/**
 * The last call's exact figures from a `result`, or nothing when they cannot be attributed.
 *
 * `usage.iterations[0]` is that call alone — input, output, cache read and cache write —
 * and its output count is the true one. The `result`'s own `usage` beside it is the turn's
 * **sum** over its calls: all four of its fields together came to 90 784 against a real
 * context of 23 179, 3.9 times too many, because the cached prefix is re-counted per call.
 * It is not read here, and {@link SessionRecord.tokens} keeps it only as the diagnostic
 * `sessionStatus` already reported.
 *
 * The id comes from {@link SessionRecord.lastCallId} because the iteration carries none.
 * With no last call there is nothing to attribute this to and nothing is emitted.
 */
const usageOfResult = (
  message: SDKMessage,
  lastCallId: string | undefined,
  contextLimit: number | undefined,
): NarrationDetail | undefined => {
  if (lastCallId === undefined) return undefined;
  const usage = (message as { usage?: unknown }).usage;
  const iterations = (usage as { iterations?: unknown } | undefined)
    ?.iterations;
  const last = Array.isArray(iterations) ? iterations[0] : undefined;
  if (last === undefined || typeof last !== "object") return undefined;
  const record = last as Record<string, unknown>;
  return {
    _tag: "usage",
    callId: lastCallId,
    promptTokens: promptTokensOf(record),
    // Thinking is already inside this figure — `output_tokens_details.thinking_tokens` is
    // a breakdown of it, not an addition to it, which is the opposite of OpenCode's shape.
    outputTokens: count(record["output_tokens"]),
    contextLimit,
    // See `usageOfAssistant`: this driver states no threshold this build has measured.
    compactionAt: undefined,
  };
};

const narrate = (
  message: SDKMessage,
  outcome: TerminalOutcome | undefined,
  /**
   * The session's own usage state: its window, and the last call seen on this stream.
   *
   * Passed in and mutated here for the reason `openCodeNarration` takes a name map: the
   * two facts a usage entry needs are not on the frame that needs them. It is one object
   * per session, so one session's call ids can never be read for another's.
   */
  session: Pick<SessionRecord, "contextLimit" | "lastCallId">,
): readonly HarnessNarration[] => {
  const at = Date.now();
  const frame = (detail: NarrationDetail): HarnessNarration => ({
    type: message.type,
    sequence: undefined,
    at,
    outcome,
    detail,
  });

  // Read off an `unknown` view of the message rather than narrowing the SDK's own union:
  // `BetaMessage`'s content blocks are a wide, version-specific union, and asserting a
  // shape the SDK has already built would add a second place for it to be wrong.
  const content = (
    (message as { message?: { content?: unknown } }).message ?? {}
  ).content;
  const blocks = Array.isArray(content) ? content : [];
  const details: NarrationDetail[] = [];

  if (message.type === "assistant") {
    for (const block of blocks) {
      const record = (block ?? {}) as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (record.type === "text" && typeof record.text === "string") {
        details.push({ _tag: "reply", text: truncateNarration(record.text) });
      } else if (
        record.type === "thinking" &&
        typeof record.thinking === "string"
      ) {
        // The field is `thinking`, not `text`. An empty one is reachable and is carried as
        // it is: the probe's own run produced `{ type: "thinking", thinking: "" }`, and
        // whether a block with nothing in it is worth a row is the transcript's decision,
        // not this mapping's.
        details.push({
          _tag: "thinking",
          text: truncateNarration(record.thinking),
        });
      } else if (record.type === "tool_use" && typeof record.id === "string") {
        details.push({
          _tag: "toolCall",
          callId: record.id,
          tool: typeof record.name === "string" ? record.name : undefined,
          input: truncateNarration(asJson(record.input)),
        });
      }
    }
  } else if (message.type === "user") {
    for (const block of blocks) {
      const record = (block ?? {}) as {
        type?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };
      if (
        record.type === "tool_result" &&
        typeof record.tool_use_id === "string"
      ) {
        details.push({
          _tag: "toolResult",
          callId: record.tool_use_id,
          tool: undefined,
          output: truncateNarration(resultText(record.content)),
          failed: record.is_error === true,
        });
      }
    }
  }

  /*
   * The usage entry, last, so the blocks of a message are narrated before the measurement
   * of the call that produced them.
   *
   * On an `assistant` frame the call's id is also remembered here, which is what lets the
   * turn's `result` attribute its exact output count to it — see
   * {@link SessionRecord.lastCallId}. It is set from the frame's own `message.id` rather
   * than from the entry, so a frame this build narrates nothing else from still advances
   * the join.
   */
  if (message.type === "assistant") {
    const usage = usageOfAssistant(message, session.contextLimit);
    if (usage !== undefined) {
      session.lastCallId = usage._tag === "usage" ? usage.callId : undefined;
      details.push(usage);
    }
  } else if (message.type === "result") {
    const usage = usageOfResult(
      message,
      session.lastCallId,
      session.contextLimit,
    );
    if (usage !== undefined) details.push(usage);
  }

  // A `user` message that is a plain prompt echo, or a `system` frame, lands here: one
  // `opaque` entry, so the stream still has an entry per message and nothing downstream has
  // to cope with a message that narrated nothing.
  return details.length === 0
    ? [frame({ _tag: "opaque" })]
    : details.map(frame);
};

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

/**
 * One message for the SDK's input iterable, with the two fields a steer needs.
 *
 * `uuid` and `priority` are **cast on**, exactly as DECISIONS.md §24.1's probe does: the
 * SDK's published `SDKUserMessage` type does not declare either, and both were measured
 * working against `@anthropic-ai/claude-agent-sdk@0.3.310` — `priority: "now"` cut the
 * running turn off at 1 of 60 lines, `priority: "later"` let it finish all 60, and the
 * directive's own `uuid` appeared on the second `result`'s `user_message_uuids` and only
 * there. A cast is the honest form of "the driver takes this and its types do not say so";
 * inventing a declaration for somebody else's interface would read as though it did.
 *
 * `undefined` delivery is the session's opening prompt: no uuid and no priority, which is
 * what every worker and round session has always sent.
 */
const userMessage = (
  record: SessionRecord,
  text: string,
  delivery: Extract<PromptDelivery, { _tag: "steer" }> | undefined,
): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: record.sessionId,
    ...(delivery === undefined
      ? {}
      : {
          uuid: claudeCodeMessageId(delivery.messageId),
          // `later` lets the work in flight finish; `now` cuts it off. The mapping is in
          // one place so a caller never names a driver's word.
          priority: delivery.urgency === "preemptive" ? "now" : "later",
        }),
  }) as SDKUserMessage;

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
          // Wakes the input iterable, which may be parked on an empty queue: it checks
          // `closed` when it wakes and returns, which ends the generator. Without this the
          // generator stays parked on a promise nothing will resolve, which leaks nothing
          // the process cares about and makes a shutdown wait for a timeout.
          record.wake?.();
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
                    record.completed += 1;
                  }
                  for (const entry of narrate(message, outcome, record)) {
                    Queue.offerUnsafe(record.narration, entry);
                  }
                  if (message.type !== "result") continue;
                  /*
                   * One `result` per turn, and a steered session has two of them.
                   *
                   * DECISIONS.md §24.1 measured this directly: the SDK answers a second
                   * accepted message with its own `result`, `num_turns: 1` and its own
                   * `user_message_uuids` — nothing folds. This loop used to `break` here
                   * unconditionally ("one prompt, one turn"), and under a steer that first
                   * `result` belongs to the turn the steer took over from: breaking ended
                   * narration, completed `idle` and closed the query while the directive's
                   * own turn was still to run, so the supervisor would settle a round that
                   * was about to produce its real answer.
                   *
                   * So the session is only finished when every message it has accepted has
                   * been answered.
                   */
                  if (record.completed < record.accepted) continue;
                  if (record.multiTurn) {
                    /*
                     * A conversation: the turn is over and the session is not.
                     *
                     * `doneUnsafe` rather than yielding `Deferred.succeed`, because this is
                     * inside a plain `async` callback and there is nowhere to yield — and
                     * because the alternative, breaking out to complete it in Effect and
                     * re-entering the loop, would **close the query**: leaving a
                     * `for await` calls the iterator's own `return()`, which finishes the
                     * SDK's generator. That is right for a round and would make the
                     * operator's second message unanswerable.
                     */
                    Deferred.doneUnsafe(record.idle, Effect.void);
                    continue;
                  }
                  // One prompt, one turn: closing the generator here is the intent, and
                  // `settling` is set in the same microtask so a steer cannot be accepted
                  // into the gap before `closeSession` runs.
                  record.settling = true;
                  break;
                }
              },
              catch: (cause) =>
                transport(
                  "query.stream",
                  `the Claude Code stream ended in failure: ${String(cause)}`,
                ),
            }),
          );
          // A stream that died takes the session with it, conversation or not: there is no
          // query left to prompt, and `idle` must not be left uncompleted.
          if (drained._tag === "Failure") record.settling = true;
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

          /**
           * Messages waiting to be handed to the SDK, oldest first.
           *
           * **A queue rather than one message and a parked promise**, which is what this
           * was. The old shape could yield exactly once, so a second accepted message had
           * nowhere to go; `AgentHarness.prompt`'s `steer` and a multi-turn conversation
           * both need "yield again, whenever", and DECISIONS.md §24.1's probe drives the
           * SDK with this same arrangement.
           */
          const pending: SDKUserMessage[] = [];
          record.offer = (message) => {
            pending.push(message);
            const waiting = record.wake;
            record.wake = undefined;
            waiting?.();
          };
          // The opening prompt is message one. Counted here rather than in `prompt`, so
          // that `accepted` is true from the moment anything can be read from it.
          record.accepted = 1;
          record.offer(userMessage(record, text, undefined));

          const input = async function* (): AsyncGenerator<SDKUserMessage> {
            await released.promise;
            for (;;) {
              if (record.closed) return;
              const next = pending.shift();
              if (next !== undefined) {
                yield next;
                continue;
              }
              // Held open deliberately; see this function's header. `record.wake` is what
              // `offer` and `closeSession` use to get this loop moving again, so the
              // generator parks here between turns rather than ending.
              await new Promise<void>((resolve) => {
                record.wake = resolve;
              });
            }
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

          /*
           * The session's context window, read once, beside the run rather than in it.
           *
           * Forked for two reasons. It is a control round trip to a subprocess that has
           * just started, so awaiting it here would delay the moment the prompt is accepted
           * — and the caller of this is the supervisor, which has a run to get going. And a
           * window is a *denominator*: a read that does not answer costs a percentage on a
           * meter, which must never be allowed to cost a run. So it is bounded, its failure
           * is logged at debug and discarded, and `contextLimit` simply stays unset.
           *
           * Into the layer's scope, like the pump above, so it is not interrupted by the
           * caller returning and is interrupted on shutdown.
           */
          yield* Effect.forkIn(
            Effect.ignore(
              Effect.timeout(
                Effect.tap(
                  Effect.tryPromise({
                    try: () => started.getContextUsage(),
                    catch: (cause) =>
                      transport(
                        "context_usage",
                        `the session would not report its context window: ${String(cause)}`,
                      ),
                  }),
                  (usage) =>
                    Effect.sync(() => {
                      const max = usage.maxTokens;
                      record.contextLimit =
                        max !== undefined && Number.isFinite(max)
                          ? max
                          : undefined;
                    }),
                ),
                controlTimeout,
              ),
              {
                log: "Debug",
                message:
                  "could not read this Claude Code session's context window; its meter will show tokens and no percentage",
              },
            ),
            harnessScope,
          );

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
          multiTurn: input.multiTurn === true,
          idle,
          accepted: 0,
          completed: 0,
          settling: false,
          deliveredIds: new Set<string>(),
          query: undefined,
          release: undefined,
          offer: undefined,
          wake: undefined,
          outcome: undefined,
          cost: undefined,
          tokens: undefined,
          contextLimit: undefined,
          lastCallId: undefined,
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

      /**
       * Takes a registration off this session's record, and off the live session when
       * there is one.
       *
       * Two cases, and they are not equally well established:
       *
       * - **Before the prompt**, this is complete: the record is the only place the
       *   registration exists, and `launch` reads it to build the one
       *   `mcp_set_servers` request the session ever receives. A name removed here never
       *   reaches the CLI at all.
       * - **After the prompt**, this pushes the remaining set over the same control
       *   channel `launch` used. That is the capability not being foreclosed, and it is
       *   **not** something Spike B measured. What §24.2 (question 2) did measure is
       *   narrower: a *late* `registerMcpServer` through this seam reaches the CLI not at
       *   all, because the seam writes the record and nothing re-pushes it. Whether the
       *   CLI drops an already-connected server when a later `mcp_set_servers` omits it
       *   was not tested, so this is written to be harmless either way: the credential is
       *   revoked by the caller regardless, and a Claude Code registration is
       *   session-scoped (§24.2 question 3), so the entry dies with the session even if
       *   the request changes nothing.
       *
       * A name that was never registered, or a session this process does not hold, is a
       * no-op: there is nothing of ours to remove, and reporting a failure would make
       * tidy-up an outcome.
       */
      const unregisterMcpServer: AgentHarness["Service"]["unregisterMcpServer"] =
        Effect.fn("claudeCodeHarness.unregisterMcpServer")(
          function* (sessionId, name) {
            const record = sessions.get(sessionId);
            if (record === undefined) return;
            if (!(name in record.mcpServers)) return;
            delete record.mcpServers[name];
            const live = record.query;
            if (live === undefined || record.closed) return;
            const pushed = yield* Effect.result(
              Effect.timeout(
                Effect.tryPromise({
                  // A copy: the SDK is handed a snapshot of what the session should have,
                  // not the live record it would then see every later change to.
                  try: () => live.setMcpServers({ ...record.mcpServers }),
                  catch: (cause) =>
                    transport(
                      "mcp_set_servers",
                      `the session would not accept the removal of its MCP registration: ${String(cause)}`,
                    ),
                }),
                controlTimeout,
              ),
            );
            if (pushed._tag === "Failure") {
              // Logged, not raised. The record no longer carries the registration and the
              // credential behind it is revoked by the caller; a control request the CLI
              // would not take is worth knowing about and is not worth failing a settled
              // run over.
              yield* Effect.logWarning(
                "a Claude Code session would not take the removal of its MCP registration; the credential is revoked either way",
                { sessionId, name },
              );
            }
          },
        );

      /**
       * The session's first prompt, or another message into one that is already running.
       *
       * ## The `open` half is unchanged, and its refusal is still bit's own rule
       *
       * A second `open` on a prompted session is refused with the sentence
       * DECISIONS.md §24.1 quotes verbatim: carrying work on means a new attempt identity.
       * That has nothing to do with the driver — there is no second call to make on the SDK
       * — and a steer is exactly the case that is *not* carrying work on under a new
       * identity, which is why it is a different tag rather than a flag on this one.
       *
       * ## The `steer` half, and the three ways it declines
       *
       * - **Nothing has been prompted yet.** There is no query, so there is no turn to
       *   steer and nothing would receive the message.
       * - **This id has already been accepted.** Answered successfully with
       *   `delivered: false`, nothing sent. The id is the application's own and derived
       *   (`harness/messageId.ts`), so this is what makes a retried `steer_planner` safe.
       * - **The session is settling or closed.** Refused, and this is the backstop
       *   DECISIONS.md §24.1 consequence 5 asks for: a steer that lost the race against
       *   settlement must not start fresh work. On this driver it cannot — a closed query
       *   takes nothing — and the refusal is what makes that a stated answer rather than a
       *   message dropped into a generator nobody is reading.
       *
       * A steer into an **idle** multi-turn session is accepted and gets a fresh `idle`
       * deferred first, so `waitForIdle` called afterwards waits for the new turn instead
       * of returning the previous one's answer.
       */
      const prompt: AgentHarness["Service"]["prompt"] = Effect.fn(
        "claudeCodeHarness.prompt",
      )(function* (sessionId, text, delivery = OPEN_PROMPT) {
        const record = yield* recordFor("session.prompt", sessionId);
        if (delivery._tag === "open") {
          if (record.query !== undefined) {
            return yield* transport(
              "session.prompt",
              `session ${sessionId} has already been prompted; carrying work on means a new attempt identity`,
            );
          }
          yield* launch(record, text);
          return { delivered: true };
        }
        if (record.query === undefined) {
          return yield* transport(
            "session.prompt",
            `session ${sessionId} has not been prompted yet, so there is no turn to steer; nothing was delivered`,
          );
        }
        if (record.deliveredIds.has(delivery.messageId)) {
          return { delivered: false };
        }
        if (record.settling || record.closed) {
          return yield* transport(
            "session.prompt",
            `session ${sessionId} has already finished the work it accepted, so a message sent now would be new work nothing is supervising; nothing was delivered`,
          );
        }
        const offer = record.offer;
        if (offer === undefined) {
          return yield* transport(
            "session.prompt",
            `session ${sessionId} has a query but no input channel, which this process cannot explain; nothing was delivered`,
          );
        }
        /*
         * Accepted, and from the `settling` read above to the `offer` below there is **no
         * yield**.
         *
         * That is what makes {@link SessionRecord.settling}'s claim true, and it was not
         * before: this sequence used `yield* Deferred.isDone(...)`, which is a fiber
         * suspension point — so the pump, which is where `settling = true` and
         * `closeSession` live, could interleave between the check and the `accepted += 1`
         * that stops the pump settling. The outcome would be a steer reported
         * `delivered: true` into a query that is closing: on this driver the message is
         * dropped rather than becoming unsupervised work, so the harm is a lying receipt
         * rather than a rogue execution, but the comment stated the window was closed and
         * it was open.
         *
         * `Deferred.isDoneUnsafe` is the synchronous read (`effect@4.0.5`'s
         * `Deferred.d.ts`), and `makeUnsafe` was already synchronous — so the whole of
         * "decide, claim, offer" is now one microtask. The `offer === undefined` guard moved
         * **above** it for a second reason: `accepted` must not be incremented on a path
         * that then refuses, or `waitForIdle` would wait for a turn nobody started.
         */
        if (Deferred.isDoneUnsafe(record.idle)) {
          record.idle = Deferred.makeUnsafe<void, HarnessFailure>();
        }
        record.deliveredIds.add(delivery.messageId);
        record.accepted += 1;
        offer(userMessage(record, text, delivery));
        return { delivered: true };
      });

      /**
       * Blocks until every message this session has accepted has been answered.
       *
       * The deferred is read when this is called rather than captured once, because a
       * multi-turn session replaces it per turn — see {@link SessionRecord.idle}. For a
       * worker or a round there is only ever one.
       */
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
        unregisterMcpServer,
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
