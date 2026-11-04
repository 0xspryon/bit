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
 *   stream (`--forward-subagent-text`, Claude Code 2.1.211+). Since A6 U14 `narrate` drops
 *   every subagent frame and narrates its call as one entry instead, so nothing reads them
 *   today; kept on because they are what a V2 live view of a subagent would read (see
 *   `SubagentState`), and turning it off is a change to the CLI's own stream that this
 *   slice has not measured.
 */
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

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
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Deferred,
  Effect,
  Layer,
  Queue,
  Redacted,
  Semaphore,
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
  subagentDescription,
  truncateNarration,
  type HarnessFailure,
  type HarnessNarration,
  type McpRegistration,
  type MessageEntry,
  type MessagePart,
  type NarrationDetail,
  type PromptDelivery,
  type SessionRef,
  type SessionStatus,
  type SessionTitle,
  type SubagentState,
  type SubagentStatus,
  type TerminalOutcome,
} from "./agentHarness";
import {
  splitAttachmentLines,
  withAttachmentLines,
  type MessageAttachment,
} from "./attachments";
import { HarnessProcessError, HarnessTransportError } from "./errors";
import { claudeCodeMessageId } from "./messageId";
import {
  leadsOwnGroup,
  stopOwnedChild,
  trackProcessTree,
  type ProcessTree,
  type StopBounds,
} from "./ownedProcesses";
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
   * Stops one task the CLI is running — a background shell, say — by the `task_id` its
   * `system/task_started` named. The CLI answers with that task's `task_notification`
   * (`status: "stopped"`). What `interrupt()` does not reach: see `interruptSession`.
   */
  stopTask(taskId: string): Promise<void>;
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
  /**
   * Moves the live session onto another model, from its next response.
   *
   * The SDK's own doc: "Change the model used for subsequent responses. Only available in
   * streaming input mode" — which every query here is, because the input is the held-open
   * iterable `launch` builds. See `AgentHarness.switchModel` for when "subsequent" turned
   * out to be.
   */
  setModel(model?: string): Promise<void>;
  /**
   * Merges settings into the session's flag layer; narrowed to the one key sent.
   *
   * `effortLevel: null` is not "unset and fall back to a settings file": the SDK documents
   * it as one of four keys that reset session state, and "`effortLevel` goes to the model's
   * default effort". That is exactly the meaning of "nothing chosen" for the new model, so
   * `switchModel` sends `null` rather than omitting the key, which would leave the old
   * model's level in place.
   */
  applyFlagSettings(settings: {
    readonly effortLevel: EffortLevel | null;
  }): Promise<void>;
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

/** The main thread's block being streamed. See {@link SessionRecord.streamed}. */
interface StreamedBlock {
  messageId: string | undefined;
  index: number | undefined;
  /** The block's `content_block.type` at its start: `text`, `thinking`, `tool_use`, … */
  kind: string | undefined;
}

/** Everything one session is, before and after it is running. */
interface SessionRecord {
  readonly sessionId: string;
  readonly title: string;
  /**
   * The model this session runs on: what `launch` starts the query with, and, once it is
   * running, what the last `switchModel` the session acknowledged put it on.
   *
   * Mutable for `switchModel` and nothing else. Changed only after the control request
   * answered, so a refused switch leaves this naming the model the session is still on,
   * and a retry sends the request again rather than finding it already "done".
   */
  model: string;
  /**
   * The reasoning level this session runs at, or nothing for the model's own.
   *
   * Held with the rest of the session's configuration rather than applied on creation,
   * because `createSession` here starts nothing: the SDK's `query()` is what takes it, and
   * that call does not happen until the prompt arrives. Same reason `model` is here, and
   * mutable for the same reason too.
   */
  effort: EffortLevel | undefined;
  /**
   * A model switch was started and has not been seen through: a control request failed or
   * timed out after another had been sent, so the CLI may be on something {@link model}
   * and {@link effort} do not say.
   *
   * While it is set, `switchModel` sends both requests whatever the record says, because
   * the record is no longer evidence of what the session runs on. Cleared when a switch
   * completes.
   *
   * Only true because switches on one session never overlap; see {@link switching}.
   */
  switchUnsettled: boolean;
  /**
   * One permit, held by `switchModel` for the whole of a switch.
   *
   * {@link model}, {@link effort} and {@link switchUnsettled} are written one request at a
   * time, and two switches interleaving would write them in an order the CLI never saw: A
   * finishing could clear `switchUnsettled` while B's level was still unanswered, B then
   * timing out would leave the record claiming a settled level the CLI may not be at, and
   * the next switch to that level would be skipped. Taken in turn, the record follows the
   * order the requests reached the CLI, and the last one to fail is the last word.
   */
  readonly switching: Semaphore.Semaphore;
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
   * Whether this record stands for a session the CLI already has, to be **resumed**.
   *
   * From `createSession`'s `resume`. It changes exactly one thing, in `launch`: the query
   * is started with `resume: <id>` instead of `sessionId: <id>`. The SDK documents the two
   * as mutually exclusive unless forking, and refuses `sessionId` for an id that already has
   * turns ("already in use"), so a resumed session that passed both would fail at the one
   * call that matters.
   *
   * Everything else about the record is the same, which is the point: a resumed session gets
   * its MCP registration over the same control channel, publishes to the same narration
   * queue and settles through the same pump.
   */
  readonly resumed: boolean;
  /**
   * Completed by the pump at a `result` that leaves no turn open and no accepted message
   * unanswered (see {@link unanswered}).
   *
   * **Replaced, not reused, when an idle session accepts another message.** A `Deferred`
   * completes once, and a conversation's second turn needs a fresh one — otherwise
   * `waitForIdle` on turn two would return instantly with turn one's answer. Mutable for
   * that reason and no other; `waitForIdle` reads it at the moment it is called.
   */
  idle: Deferred.Deferred<void, HarnessFailure>;
  /**
   * Completed once, by the pump, the moment its `for await` over the query exits — an
   * error, a `break` or the iterator finishing — and by `closeSession`. Never failed.
   *
   * **Not {@link idle}**, which a multi-turn session completes at the end of every turn
   * while its query stays open. This one says the query's stream is over, and the record
   * has been marked {@link settling} by the time it completes.
   *
   * What `switchModel` waits on when a control request fails: SDK 0.3.310 rejects every
   * pending control request *before* the pump sees the stream end, so the request's
   * failure can be seen while the pump still thinks the session is live. See
   * `STREAM_END_GRACE`.
   */
  readonly ended: Deferred.Deferred<void>;
  /**
   * The driver uuids of the messages this session has accepted and no `result` has
   * answered yet, oldest first.
   *
   * With {@link turnOpen}, what "a turn is running" means here (DECISIONS.md §24.1,
   * consequence 4): `waitForIdle` settles, `sessionStatus` reads idle and Stop finds
   * nothing to interrupt only when no turn is open and nothing accepted is unanswered.
   *
   * **Answered by uuid, not counted.** This used to be a pair of counters — messages sent,
   * `result`s seen — and the CLI runs turns nobody sent: when a `run_in_background` task
   * finishes it queues a `<task-notification>` and runs a turn of its own, with its own
   * `result` (A6 F5's third review, seen live). The `result` count then overtook the sent
   * count for good, and every Stop after it answered "nothing was running" while a tool
   * ran. Every message is sent with a uuid, and the CLI lists on a `result` the uuids of
   * the messages that turn consumed (`user_message_uuids`, measured on 2.1.310), so a
   * turn nobody asked for answers nothing and a message folded into a running turn is
   * answered with it.
   */
  readonly unanswered: Set<string>;
  /**
   * The steers this session was sent that no frame has yet said it consumed, by their driver
   * uuid, each with the application's id for it (A6 U4).
   *
   * The CLI stamps its reply frames with `user_message_uuids`, the messages the turn has
   * consumed so far — a queued steer's uuid appears on the first frame of the turn that took
   * it, or of the running turn it was folded into. That first sighting is narrated as
   * `taken` ({@link takenNarration}) and the entry removed, so each is said once.
   */
  readonly untaken: Map<string, string>;
  /**
   * A turn is running on the stream: a turn-opening frame (`system/init`, a main-thread
   * reply or tool result — never a subagent's, see `opensTurn`) has arrived since the last
   * `result`, which closes it. Read off the stream
   * because it is the only place a turn the CLI started itself shows up. See
   * {@link unanswered}.
   */
  turnOpen: boolean;
  /**
   * Whether this CLI has said which messages a turn answers — any frame carrying
   * `user_message_uuid(s)`. Until it has, a `result` naming no uuid answers the oldest
   * unanswered message, which is how a producer that predates the field pairs them; once
   * it has, such a `result` ends a turn nobody sent and answers nothing.
   */
  stamped: boolean;
  /**
   * The pump has decided this session is over and is on its way out.
   *
   * Set **synchronously**, in the same microtask as the check that decided it, and read
   * synchronously by `prompt` before it accepts a steer. That is what closes the one
   * window the supervisor's own claim cannot: between the pump reading
   * {@link unanswered} as empty and `closeSession` running there is an Effect boundary, and a
   * steer that landed in it would be queued into a session that is about to close and
   * reported as delivered.
   *
   * **Both sides have to be yield-free for that to be true**, which is a requirement on
   * `prompt` rather than on this field: a review found a `yield* Deferred.isDone(...)`
   * between the read and the message being added to {@link unanswered}, which is a fiber suspension point and left
   * the window open. `prompt` now uses `Deferred.isDoneUnsafe` and carries the reasoning at
   * the line.
   *
   * Written by the pump only: when it decides a single-turn session is done, before its
   * `break`, and on every exit from its `for await`, before it completes {@link ended}.
   * Read by `prompt`, to refuse a steer, and by `switchModel`'s `gone()`, to answer a
   * switch that lost its query as not found rather than uncertain.
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
  /**
   * The main thread's block being streamed, from its `stream_event` frames (A6 F8).
   *
   * **How a finished block finds its stream index.** A delta's `blockId` is the call's
   * `message.id` and the content block's `index`, but a delta frame carries only the index
   * and the CLI's finished `assistant` frame carries only the message: it splits one call
   * into one frame per block, each holding that block alone at position 0 (measured on
   * 2.1.310). So the stream's own order joins them, as {@link lastCallId} joins a `result`
   * to its call: `message_start` names the message, `content_block_start` the block, and
   * the Messages API streams one block at a time, start to stop. The CLI sends a block's
   * `assistant` frame after its last delta and before its `content_block_stop` — before the
   * next block can start — so the block started last is the one a main-thread `assistant`
   * frame of the same message finishes, whichever side of the stop it lands.
   *
   * Only the main thread sets it ({@link fromSubagent}), and a frame it does not fit — a
   * subagent's, another message's, a block of another kind, a frame holding several blocks
   * — gets no `blockId` rather than a wrong one. Empty on a session that asked for no
   * partial messages, whose finished blocks therefore carry none. Kept until the next
   * `message_start`, never cleared by a stop, so a late `assistant` frame still finds it.
   */
  streamed: StreamedBlock;
  /**
   * The sub-agents this session's agent started, by the calling `Agent` call's id, so a
   * later frame — the call's result, the task's notification — can say which one ended
   * and be narrated as its {@link SubagentState} (A6 U14). See {@link SubagentCalls}.
   */
  readonly subagents: SubagentCalls;
  /**
   * Set by {@link interruptSession}, so the outcome is `interrupted` and not `failed`.
   * Cleared at the next `result` on a multi-turn session, whose query outlives the turn.
   *
   * Set only while {@link turnOpen} or {@link unanswered} says a turn is running, both of
   * which only a `result` ends — so that `result` is always coming, and is the turn's own.
   * A frame that opened a turn no `result` closes would let this outlive it and mark the
   * operator's next turn interrupted (A6 F5's fourth review: a background subagent's).
   */
  interrupted: boolean;
  /**
   * The tasks the CLI has started and not yet said are over, by `task_id`, with their
   * `task_type` (`local_agent`, `local_bash`, …): added at `system/task_started`, removed
   * at that task's `system/task_notification`, whatever its status (A6 F5's fifth review).
   *
   * What makes background work visible. A `run_in_background` subagent or shell outlives
   * the turn that started it, and no `result` covers it, so {@link turnOpen} cannot say it
   * is running — a Stop then answered "nothing was running" while a background agent went
   * on to act. Every task 2.1.310 starts is bracketed by the two frames (measured), so the
   * pair is the whole of it. Ambient tasks (the CLI's own housekeeping, `ambient: true`)
   * are not activity and are not kept.
   *
   * Each entry keeps the `run_id` of the run it was last started as. A resumed task keeps
   * its `task_id` and gets a new `run_id`, and a frame naming a run that sorts before the
   * one held is late (SDK 0.3.310, `SDKTaskNotificationMessage.run_id`): a late
   * notification from an earlier run must not end the run still going, or a Stop would
   * answer "nothing was running" while it acts. See {@link trackTask}.
   */
  readonly tasks: Map<string, TrackedTask>;
  /** The query has been closed; nothing more will arrive. */
  closed: boolean;
  /**
   * The CLI subprocess, once the SDK has had this harness spawn it (`spawnOwnedCli`).
   *
   * Owned here rather than left to the SDK so that ending a session can stop it *now*:
   * `Query.close()` only ends the CLI's stdin and signals it 2 s later, and a CLI given
   * that long finishes the step it is on — a review watched one run a tool 0.93 s after its
   * session was ended (A6 F5). Undefined until the query spawns, and for a session never
   * prompted.
   */
  cli: OwnedCli | undefined;
  /**
   * The last {@link STDERR_TAIL} characters the CLI wrote to stderr.
   *
   * The SDK appends a stderr tail to "process exited with code N" only from a CLI it
   * spawned itself, and this harness spawns it (`spawnOwnedCli`), so the tail is kept here
   * instead: logged when the CLI exits non-zero, and added to the stream's failure.
   */
  stderrTail: string;
  /** The CLI exited with a non-zero code of its own; the stream's failure carries the tail. */
  cliFailed: boolean;
}

/**
 * The CLI process one session runs in, spawned by this harness in a process group of its
 * own, so the tool processes it starts can be stopped with it.
 */
interface OwnedCli {
  readonly child: ChildProcess;
  /** Whether the kernel confirmed at spawn that the child leads its own group. */
  readonly ownsGroup: boolean;
  /**
   * The CLI and everything it started, followed by pid and start time, which is what is
   * signalled to stop it: Claude Code starts each Bash tool in a session of its own, out of
   * the CLI's group (A6 F5's third review). See `trackProcessTree`.
   *
   * **Kept current while the CLI lives**, re-read every `cliTreeRefresh`, not only when a
   * stop starts (A6 F5's fourth review): a tool the CLI starts in a session of its own is
   * reparented the moment the CLI dies, and a tree read only after that — a crash, an OOM
   * kill — could no longer find it. What the last read saw is stopped at the exit.
   */
  readonly tree: ProcessTree;
  /**
   * The stop under way, if one is. A second asker — `endSession` arriving while the exit
   * handler stops what a dead CLI left — waits for it rather than starting another, so
   * "gone when the end returns" still holds and the tree is not read twice per poll.
   */
  stopping: Deferred.Deferred<void> | undefined;
}

/** One entry of {@link SessionRecord.tasks}. */
interface TrackedTask {
  /** The CLI's `task_type` (`local_agent`, `local_bash`, …), or `unknown`. */
  readonly type: string;
  /** The run this entry is, when the CLI named one: absent from CLIs that predate it. */
  readonly runId: string | undefined;
}

/** How much of a CLI's stderr is kept, from the end, for the failure it may explain. */
const STDERR_TAIL = 4_096;

/** What a caller may vary about this harness. */
export interface ClaudeCodeHarnessOptions {
  /** The model a run gets when it names none. */
  readonly defaultModel?: string;
  /** Swapped out by tests. Defaults to {@link liveClaudeCodeSdk}. */
  readonly sdk?: ClaudeCodeSdk;
  /**
   * How long a control request to a live session may take.
   *
   * Bounds *our* ask, not the worker. It covers `setMcpServers` and the other control
   * requests, round trips to a subprocess that may be wedged; none ever decides an outcome.
   * A Stop's `interrupt()` and `stopTask` have shorter bounds of their own
   * ({@link DEFAULT_INTERRUPT_TIMEOUT}, {@link DEFAULT_TASK_STOP_TIMEOUT}).
   */
  readonly controlTimeout?: Duration.Input;
  /**
   * How long an ended session's CLI is given after `SIGTERM`, then after `SIGKILL`, before
   * `endSession` reports it survived. Tests shorten it.
   */
  readonly cliStopBounds?: StopBounds;
  /**
   * How often, in milliseconds, a live CLI's process tree is re-read, so that what it
   * started is known before it can be orphaned. Tests shorten it.
   */
  readonly cliTreeRefresh?: number;
  /**
   * How long one `stopTask` may take when a Stop asks it of a background task. Defaults to
   * {@link DEFAULT_TASK_STOP_TIMEOUT}; tests shorten it.
   */
  readonly taskStopTimeout?: Duration.Input;
  /**
   * How long a Stop waits for the CLI to acknowledge its `interrupt()`. Defaults to
   * {@link DEFAULT_INTERRUPT_TIMEOUT}; tests shorten it.
   */
  readonly interruptTimeout?: Duration.Input;
}

const DEFAULT_CONTROL_TIMEOUT: Duration.Input = "30 seconds";

/**
 * How long a Stop waits for one background task's `stopTask` to be acknowledged.
 *
 * Its own bound, much shorter than {@link DEFAULT_CONTROL_TIMEOUT}, because a Stop asks
 * every listed task at once and waits for all of them: the worker and planner supervisors
 * give the whole `interruptSession` 10 s (`SETTLEMENT_ASK_TIMEOUT`), so one task that never
 * answers must not be allowed 30 s of it. 2.1.310 reports a shell stopped within 10 ms of
 * its `stopTask` (measured, at `interruptSession`), so 3 s is generous; a task whose ask runs out
 * is logged and, still listed, reported as possibly running — never as stopped.
 */
const DEFAULT_TASK_STOP_TIMEOUT: Duration.Input = "3 seconds";

/**
 * How long a Stop waits for the CLI to acknowledge its `interrupt()` before closing the
 * query and stopping the CLI instead.
 *
 * Its own bound, not {@link DEFAULT_CONTROL_TIMEOUT}, for the reason
 * {@link DEFAULT_TASK_STOP_TIMEOUT} has one: the worker and planner supervisors give the
 * whole `interruptSession` 10 s (`SETTLEMENT_ASK_TIMEOUT`) and abandon it after that. Under
 * the 30 s control timeout a CLI that never acknowledged was still being waited on when the
 * supervisor gave up, so the forced close that follows a refused interrupt never ran and
 * the CLI kept going. Both worst cases fit inside those 10 s: an interrupt never
 * acknowledged takes this 3 s, then at most {@link DEFAULT_CLI_STOP_BOUNDS}' 2 s to end the
 * CLI, about 5 s; an acknowledged interrupt followed by `stopTask`s takes this 3 s, plus
 * {@link DEFAULT_TASK_STOP_TIMEOUT}'s 3 s for the asks (made at once), plus
 * {@link TASK_STOP_SETTLE_MILLIS}' 2 s for the tasks to say they are over, 8 s. 2.1.310
 * acknowledges an interrupt in ~20 ms (measured, at `interruptSession`), so a CLI that
 * takes 3 s is one this process can no longer steer.
 */
export const DEFAULT_INTERRUPT_TIMEOUT: Duration.Input = "3 seconds";

/**
 * An ended CLI's bounds: a second after `SIGTERM`, a second after `SIGKILL`.
 *
 * Short, because `endSession` is on the close path of an operator's End and of shutdown,
 * and long enough for a CLI that handles `SIGTERM` to exit on its own — it does in tens of
 * milliseconds. Nothing of it can act on bit in the meantime either way: the policy gate
 * refuses an ended session's tool calls from the moment the spine ends it.
 *
 * Polled every 25 ms, not faster: every look reads all of procfs, a few milliseconds of
 * blocked event loop with a few hundred processes on the machine, and a shutdown stops
 * every CLI at once (A6 F5's fourth review). 25 ms still gives a tool started during the
 * grace dozens of looks to be found in.
 */
export const DEFAULT_CLI_STOP_BOUNDS: StopBounds = {
  terminateGrace: 1_000,
  killGrace: 1_000,
  poll: 25,
};

/**
 * A live CLI's tree is re-read once a second: one procfs read, a few milliseconds, per CLI
 * per second. A tool started and orphaned inside the same second is the window left, and
 * past it only a cgroup per CLI contains everything — the operator decision recorded in
 * the A6 breakdown.
 */
const DEFAULT_CLI_TREE_REFRESH = 1_000;

/**
 * How long `switchModel` waits, after a control request **failed** (not timed out), for
 * the pump to report that the query's stream ended, before deciding whether the failure
 * was the session going away.
 *
 * What the wait covers, in SDK 0.3.310: when the CLI's output ends, `Query.readMessages`
 * finishes the message stream (`inputStream.error(e)`, or `done()` on a clean exit) and
 * calls `cleanup(e)`, whose `performCleanup` rejects every pending control request at
 * once. The pump does not see the end then. It reads through `readSdkMessages`, whose
 * `finally { await this.cleanup() }` holds the end back until `performCleanup` has
 * finished — and that awaits `Promise.race([transport.waitForExit(), 2000 ms])`. For a
 * CLI that has already exited, crashed or not, `waitForExit` settles at once and the
 * pump sees the end milliseconds after the request failed. If cleanup starts while the
 * process is still alive, the pump can be held for up to the full **2 s**, past this
 * bound: the switch then reports a plain transport failure ("uncertain") for a session
 * that is in fact closing. That is rare, and a retry gets the 404.
 *
 * Not raised to cover that 2 s, because the bound is paid in full by a request the CLI
 * refused on a session that stays live, which is reported this much later — 250 ms
 * beside a `setModel` round trip of about a second (the probe's 1.0–1.2 s) is not
 * something a caller notices; 2 s would be. A timeout does not wait: the control bound
 * has already been spent, and a session that does not answer for that long is not one
 * that closed a moment ago.
 */
const STREAM_END_GRACE: Duration.Input = "250 millis";

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
 *   they arrive. A `reply` or `thinking` the stream wrote first carries that stream's
 *   `blockId` ({@link finishedBlockKey}), so it ends and replaces its partials.
 * - `stream_event` → a main-thread `text_delta` or `thinking_delta` becomes a `delta`
 *   ({@link narrateStreamEvent}); every other stream frame narrates **nothing**. Only a
 *   conversation asks for these frames (`includePartialMessages`, A6 F8).
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
 *   outcome watch are unchanged by this mapping. `stream_event` and `system/thinking_tokens`
 *   are the exceptions, narrating nothing. A `stream_event`:
 *   one call streams hundreds of frames — a `tool_use` block's input arrives as
 *   `input_json_delta`s — and an `opaque` entry for each would crowd a conversation's
 *   sliding narration bus (`run/narration.ts`) with entries nothing renders. None of them
 *   carries an outcome; the `result` still does.
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
 * **Read first from the SDK's documentation** — `sdk.d.ts:3686`: "`parent_tool_use_id` is
 * non-null when the message was produced inside a subagent started by that tool_use" — and
 * since **measured** (A6 U14, CLI 2.1.310, `testdata/claude-code-subagents/`): a
 * foreground and a background `Agent` call each had their prompt, thinking and reply
 * forwarded as frames carrying the call's id, those frames carried `message.usage` of their
 * own, and every main-thread frame carried `null`. The guard excludes such a frame before
 * any usage is read, and `narrate` drops it whole.
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
 * call it is not about. Its text and thinking narrate nothing either since A6 U14: the
 * frame is dropped before this is reached, and its call is narrated as one entry
 * (`SubagentState`).
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

/**
 * The `blockId` a Claude Code block streams and finishes under: the call's `message.id` and
 * the content block's index **in the stream**. Unique within a session because a message
 * id is one API call's. See {@link SessionRecord.streamed} for how a finished block, which
 * carries no index, is given the same one.
 */
export const claudeCodeBlockId = (messageId: string, index: number): string =>
  `${messageId}:${String(index)}`;

/**
 * What one `stream_event` narrates: a delta for a main-thread `text_delta` or
 * `thinking_delta`, and nothing for anything else. The block bookkeeping frames update
 * {@link SessionRecord.streamed} on the way.
 *
 * A subagent's frames are skipped whole, before anything is read or remembered: its blocks
 * are not this session's call, and letting its `message_start` replace the main thread's
 * would give the main thread's finished block no id — or the subagent's a wrong one. The
 * CLI 2.1.310 forwarded none in the run the fixtures come from, so this is the documented
 * `parent_tool_use_id` meaning, held to as {@link fromSubagent} holds to it.
 *
 * `input_json_delta` (a tool call's arguments being written), `signature_delta` and
 * `citations_delta` stay out: a tool call narrates once, finished, as before.
 */
const narrateStreamEvent = (
  message: Extract<SDKMessage, { type: "stream_event" }>,
  streamed: StreamedBlock,
): readonly NarrationDetail[] => {
  if (fromSubagent(message)) return [];
  const event = message.event;
  switch (event.type) {
    case "message_start":
      streamed.messageId =
        typeof event.message.id === "string" ? event.message.id : undefined;
      streamed.index = undefined;
      streamed.kind = undefined;
      return [];
    case "content_block_start":
      streamed.index = Number.isInteger(event.index) ? event.index : undefined;
      streamed.kind = event.content_block.type;
      return [];
    case "content_block_delta": {
      if (streamed.messageId === undefined || !Number.isInteger(event.index)) {
        return [];
      }
      const blockId = claudeCodeBlockId(streamed.messageId, event.index);
      const delta = event.delta;
      if (delta.type === "text_delta") {
        return [{ _tag: "delta", blockId, channel: "reply", text: delta.text }];
      }
      if (delta.type === "thinking_delta") {
        return [
          { _tag: "delta", blockId, channel: "thinking", text: delta.thinking },
        ];
      }
      return [];
    }
    default:
      return [];
  }
};

/**
 * The `blockId` key for a finished `text` or `thinking` block, when it is the block the
 * main thread's stream was writing — `{}` otherwise. See {@link SessionRecord.streamed}.
 *
 * Only a frame holding that one block fits: the CLI splits a call into one `assistant`
 * frame per block, so a frame holding several is not one this join can name.
 */
const finishedBlockKey = (
  message: SDKMessage,
  blockCount: number,
  kind: "text" | "thinking",
  streamed: StreamedBlock,
): { readonly blockId?: string } => {
  if (fromSubagent(message) || blockCount !== 1) return {};
  const id = (message as { message?: { id?: unknown } }).message?.id;
  return typeof id === "string" &&
    id === streamed.messageId &&
    streamed.index !== undefined &&
    streamed.kind === kind
    ? { blockId: claudeCodeBlockId(id, streamed.index) }
    : {};
};

/**
 * The tools that start a sub-agent: `Agent`, and `Task`, its name before Claude Code 2.1
 * renamed it. A tool from an MCP server is always namespaced (`mcp__…`), so neither name
 * can be somebody else's.
 */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** What one sub-agent call said about itself, kept for its later states. */
interface SubagentCall {
  readonly tool: string;
  readonly agentType: string | undefined;
  readonly description: string;
  readonly model: string | undefined;
  /**
   * The call returned at once and the sub-agent runs on: its result is a placeholder, and
   * only the task's notification says it ended. Set from the call's `run_in_background`,
   * from the CLI's `task_started`/`task_updated` (`is_backgrounded`, live only) and from
   * the placeholder itself ({@link ASYNC_LAUNCH}), whichever says so first.
   */
  background: boolean;
  /** The CLI's task id for it, from `task_started`, which `task_updated` names it by. */
  taskId?: string;
}

/**
 * The sub-agents a session's agent started, by call id, for one read of the stream or of
 * the transcript. Grows by one per sub-agent call, which an agent makes a handful of times
 * in a session, and goes with the session.
 */
type SubagentCalls = Map<string, SubagentCall>;

/**
 * How Claude Code's `Agent` result opens when the sub-agent was started in the background:
 * `Async agent launched successfully. …` (measured on 2.1.310), a placeholder for a result
 * that arrives later as the task's notification. **The one signal a replay has** when the
 * call did not say `run_in_background: true`: the CLI starts an agent in the background by
 * default (its tool description says so), and `getSessionMessages` keeps neither the
 * `task_started` frame nor the result's `toolUseResult.isAsync`. Should a later CLI word it
 * differently, a background sub-agent that was not asked for by name shows as finished
 * when it was launched, which is the claim a reader can least be misled by.
 */
const ASYNC_LAUNCH = "Async agent launched";

const subagentCall = (
  tool: string,
  input: unknown,
  model: string | undefined,
): SubagentCall => {
  const fields = (input ?? {}) as {
    subagent_type?: unknown;
    description?: unknown;
    prompt?: unknown;
    run_in_background?: unknown;
  };
  return {
    tool,
    agentType:
      typeof fields.subagent_type === "string" &&
      fields.subagent_type.trim() !== ""
        ? subagentDescription(fields.subagent_type, undefined)
        : undefined,
    description: subagentDescription(fields.description, fields.prompt),
    model,
    background: fields.run_in_background === true,
  };
};

const subagentState = (
  callId: string,
  call: SubagentCall,
  status: SubagentStatus,
): SubagentState => ({
  _tag: "subagent",
  callId,
  tool: call.tool,
  agentType: call.agentType,
  description: call.description,
  status,
  ...(call.model === undefined ? {} : { model: call.model }),
});

/**
 * How the CLI words a tool call a Stop cut short: the call's `tool_result` is an error whose
 * text opens with this, followed by a `[Request interrupted by user for tool use]` entry.
 * Measured on 2.1.310 with a Stop during a foreground `Agent` (U14's review): the result was
 * `is_error: true`, `The user doesn't want to proceed with this tool use. The tool use was
 * rejected …`. The same words are stored, so a replay reads them too.
 */
const REJECTED_TOOL_USE = "The user doesn't want to proceed with this tool use";

/**
 * A sub-agent call's result as its state: `finished`; `stopped` when the result is an error
 * a Stop caused — the CLI's {@link REJECTED_TOOL_USE} words, or, live, any error while this
 * session's turn is being interrupted; `failed` for any other error — and **nothing** for a
 * background launch's placeholder, since that sub-agent is still running and its
 * notification will say when it ends. The result's text is never carried: a foreground
 * result is the sub-agent's own final report.
 */
const subagentResult = (
  callId: string,
  call: SubagentCall,
  text: string,
  failed: boolean,
  interrupted: boolean,
): MessagePart[] => {
  if (!failed && text.trimStart().startsWith(ASYNC_LAUNCH)) {
    call.background = true;
  }
  if (call.background) return [];
  const status: SubagentStatus = !failed
    ? "finished"
    : interrupted || text.trimStart().startsWith(REJECTED_TOOL_USE)
      ? "stopped"
      : "failed";
  return [subagentState(callId, call, status)];
};

/**
 * How a task's notification names its end: the SDK's `task_notification.status`
 * (`completed`, `failed`, `stopped`), or the stored `<task-notification>`'s `<status>`,
 * which says `killed` where the frame says `stopped`. Anything else is not an end this
 * reads, and leaves the sub-agent running.
 */
const notifiedStatus = (status: string): SubagentStatus | undefined => {
  switch (status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "stopped":
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
};

/**
 * A background sub-agent's end, from its task's notification, or nothing when the
 * notification is not about one. A foreground sub-agent's task is notified too — just
 * before its result — and is left to the result, so each sub-agent ends once.
 */
const subagentNotified = (
  subagents: SubagentCalls,
  toolUseId: string | undefined,
  status: string,
): MessagePart[] => {
  const call = toolUseId === undefined ? undefined : subagents.get(toolUseId);
  const ended = notifiedStatus(status);
  return call === undefined ||
    toolUseId === undefined ||
    !call.background ||
    ended === undefined
    ? []
    : [subagentState(toolUseId, call, ended)];
};

/**
 * The `<tool-use-id>` and `<status>` of a stored `<task-notification>`, the user entry the
 * CLI writes when a task ends (`testdata/claude-code-transcript/`).
 */
const storedNotification = (
  text: string,
): { readonly toolUseId: string; readonly status: string } | undefined => {
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
  return toolUseId === undefined || status === undefined
    ? undefined
    : { toolUseId: toolUseId.trim(), status: status.trim() };
};

/**
 * A stored task notification as one line: its `<summary>` (`Agent "Say PING later"
 * completed`, `Background command "…" completed (exit code 0)`), else `Task <status>`, else
 * a constant. Never the notification's other text: an agent's carries the sub-agent's
 * final report in `<result>`.
 *
 * Both are read only from the text **before** the first `<result>`, where the CLI writes
 * its own tags. The report is the sub-agent's words and may hold a `<summary>` of its own,
 * and a summary may hold a `<` (`Agent "Compare a<b hosts" completed`), so a read that
 * failed on the real one would otherwise go on to the report's (a second review of U14).
 */
const notificationLine = (text: string): string => {
  const head = text.split("<result>", 1)[0] ?? "";
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(head)?.[1]?.trim();
  if (summary !== undefined && summary !== "") return summary;
  const status = /<status>([^<]+)<\/status>/.exec(head)?.[1]?.trim();
  return status === undefined ? "Task notification" : `Task ${status}`;
};

/** The model an `assistant` message names (`message.model`), or `undefined`. */
const modelOfMessage = (message: unknown): string | undefined => {
  const model = (message as { model?: unknown } | undefined)?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
};

/**
 * An `assistant` message's blocks as parts: `text` → `reply`, `thinking` → `thinking`,
 * `tool_use` (`{ id, name, input }`) → `toolCall`, anything else nothing.
 *
 * **One reading for the live stream and the stored transcript** (A6 F10), so a replayed
 * conversation is made of the same parts its live narration was: {@link narrate} calls it on
 * each `assistant` frame and {@link flattenTranscript} on each stored `assistant` entry,
 * which hold the same `BetaMessage` content. `key` names a `text` or `thinking` block's
 * `blockId` — from the stream on a frame ({@link finishedBlockKey}), from the entry's place
 * in its call on a transcript — and `model` is the message's own.
 */
const assistantParts = (
  blocks: readonly unknown[],
  model: string | undefined,
  key: (
    kind: "text" | "thinking",
    position: number,
  ) => {
    readonly blockId?: string;
  },
  subagents: SubagentCalls,
): MessagePart[] => {
  const parts: MessagePart[] = [];
  const named = model === undefined ? {} : { model };
  blocks.forEach((block, position) => {
    const record = (block ?? {}) as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({
        _tag: "reply",
        text: truncateNarration(record.text),
        ...key("text", position),
        ...named,
      });
    } else if (
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      // The field is `thinking`, not `text`. An empty one is reachable and is carried as
      // it is: the probe's own run produced `{ type: "thinking", thinking: "" }`, and
      // whether a block with nothing in it is worth a row is the transcript's decision,
      // not this mapping's.
      parts.push({
        _tag: "thinking",
        text: truncateNarration(record.thinking),
        ...key("thinking", position),
        ...named,
      });
    } else if (
      record.type === "tool_use" &&
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      SUBAGENT_TOOLS.has(record.name)
    ) {
      // A sub-agent: its entry, not its call (A6 U14).
      const call = subagentCall(record.name, record.input, model);
      subagents.set(record.id, call);
      parts.push(subagentState(record.id, call, "running"));
    } else if (record.type === "tool_use" && typeof record.id === "string") {
      parts.push({
        _tag: "toolCall",
        callId: record.id,
        tool: typeof record.name === "string" ? record.name : undefined,
        input: truncateNarration(asJson(record.input)),
        ...named,
      });
    }
  });
  return parts;
};

/**
 * A `user` message's `tool_result` blocks (`{ tool_use_id, content, is_error }`) as
 * `toolResult` parts. A tool's output comes back as a *user* message because that is how
 * the Messages API carries it. Shared by the stream and the transcript, as
 * {@link assistantParts} is. `interrupted` is the live session's own knowledge that its
 * operator pressed Stop ({@link SessionRecord.interrupted}); a replay has none and passes
 * `false`.
 */
const userParts = (
  blocks: readonly unknown[],
  subagents: SubagentCalls,
  interrupted: boolean,
): MessagePart[] =>
  blocks.flatMap((block): MessagePart[] => {
    const record = (block ?? {}) as {
      type?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };
    const call =
      record.type === "tool_result" && typeof record.tool_use_id === "string"
        ? subagents.get(record.tool_use_id)
        : undefined;
    if (call !== undefined && typeof record.tool_use_id === "string") {
      return subagentResult(
        record.tool_use_id,
        call,
        resultText(record.content),
        record.is_error === true,
        interrupted,
      );
    }
    return record.type === "tool_result" &&
      typeof record.tool_use_id === "string"
      ? [
          {
            _tag: "toolResult",
            callId: record.tool_use_id,
            tool: undefined,
            output: truncateNarration(resultText(record.content)),
            failed: record.is_error === true,
          },
        ]
      : [];
  });

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
  session: Pick<
    SessionRecord,
    "contextLimit" | "lastCallId" | "streamed" | "subagents" | "interrupted"
  >,
): readonly HarnessNarration[] => {
  const at = Date.now();
  const frame = (detail: NarrationDetail): HarnessNarration => ({
    type: message.type,
    sequence: undefined,
    at,
    outcome,
    detail,
  });

  // A stream frame narrates its delta or nothing — never `opaque`; see this function's
  // header. It carries no outcome: only a `result` does.
  if (message.type === "stream_event") {
    return narrateStreamEvent(message, session.streamed).map(frame);
  }
  // A thinking-progress estimate narrates nothing either, for the same reason: the CLI sends
  // about one per thinking delta once a conversation's thinking is summarized (A6 F8's
  // review measured 84 in one run), with or without partial messages, so a worker's too.
  // An `opaque` entry each would take that many of the sliding bus's slots
  // (`run/narration.ts`) for entries nothing renders. It carries no outcome.
  if (message.type === "system" && message.subtype === "thinking_tokens") {
    return [];
  }
  /*
   * A sub-agent's own frames narrate nothing (A6 U14, decided by the operator): its
   * thinking, tool calls, replies and the prompt it was given are not this session's agent
   * speaking, and drawn as this session's rows they read as if the caller wrote them. Its
   * call is narrated instead, as one entry with its state ({@link SubagentState}, which
   * carries the V2 note). Every Claude Code session reads its frames here — a conversation,
   * a worker's attempt, a planner round — and all of them are dropped, for the same reason
   * in each: a worker's transcript is the worker's, and a sub-agent's work in it would be
   * misattributed exactly as in a chat. Its usage was already never read
   * ({@link usageOfAssistant}), and its partial frames are skipped by
   * {@link narrateStreamEvent}. Nothing at all rather than `opaque`: an `opaque` per frame
   * would only take slots on the sliding bus for entries nothing renders.
   */
  if (
    (message.type === "assistant" || message.type === "user") &&
    fromSubagent(message)
  ) {
    return [];
  }
  /*
   * A task's start and end, read for the sub-agents among them: a start or update says
   * whether one runs in the background, which its result alone may not (the CLI starts an
   * agent in the background by default), and a background one's notification is what says
   * it ended. Anything else here is the `opaque` it always was.
   */
  if (message.type === "system") {
    if (message.subtype === "task_started") {
      const call =
        message.tool_use_id === undefined
          ? undefined
          : session.subagents.get(message.tool_use_id);
      if (call !== undefined) {
        call.taskId = message.task_id;
        if (message.is_backgrounded === true) call.background = true;
      }
    } else if (message.subtype === "task_updated") {
      // Names its task only; a sub-agent moved to the background after it started.
      if (message.patch.is_backgrounded === true) {
        for (const call of session.subagents.values()) {
          if (call.taskId === message.task_id) call.background = true;
        }
      }
    } else if (message.subtype === "task_notification") {
      const ended = subagentNotified(
        session.subagents,
        message.tool_use_id,
        message.status,
      );
      if (ended.length > 0) return ended.map(frame);
    }
  }

  // Read off an `unknown` view of the message rather than narrowing the SDK's own union:
  // `BetaMessage`'s content blocks are a wide, version-specific union, and asserting a
  // shape the SDK has already built would add a second place for it to be wrong.
  const content = (
    (message as { message?: { content?: unknown } }).message ?? {}
  ).content;
  const blocks = Array.isArray(content) ? content : [];
  const details: NarrationDetail[] = [];

  const failed = assistantError(message, blocks);
  if (failed !== undefined) {
    details.push(failed);
  } else if (message.type === "assistant") {
    details.push(
      ...assistantParts(
        blocks,
        modelOfMessage(message.message),
        (kind) =>
          finishedBlockKey(message, blocks.length, kind, session.streamed),
        session.subagents,
      ),
    );
  } else if (message.type === "user") {
    details.push(...userParts(blocks, session.subagents, session.interrupted));
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
    const failure = resultError(message, outcome);
    if (failure !== undefined) details.push(failure);
  }

  // A `user` message that is a plain prompt echo, or a `system` frame, lands here: one
  // `opaque` entry, so the stream still has an entry per message and nothing downstream has
  // to cope with a message that narrated nothing.
  return details.length === 0
    ? [frame({ _tag: "opaque" })]
    : details.map(frame);
};

/**
 * The words of a block list's `text` blocks, joined: what the CLI wrote in a message it
 * made itself in the model's place.
 */
const textOfBlocks = (blocks: readonly unknown[]): string =>
  blocks
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");

/**
 * A provider's refusal of a call, as the `error` it is, or `undefined` (A6 U4 review).
 *
 * When the API refuses a call — a rate limit, a billing or authentication failure, an
 * overloaded or erroring server — the CLI does not end the turn with an error `result`
 * alone: it writes an `assistant` message **in the model's place**, its text the CLI's own
 * sentence ("API Error: …", "You've hit your session limit · …"), and flags the frame with
 * `SDKAssistantMessage.error` (`'rate_limit' | 'billing_error' | …`). Narrated as a reply,
 * that sentence read as the importer speaking. So a frame with `error` set is the harness's
 * error: the sentence it wrote, or the error's own word when it wrote none. Capped, and
 * untrusted: a provider's message can quote anything.
 */
export const assistantError = (
  message: SDKMessage,
  blocks: readonly unknown[],
): NarrationDetail | undefined => {
  if (message.type !== "assistant") return undefined;
  const flagged = (message as { readonly error?: unknown }).error;
  if (typeof flagged !== "string" || flagged === "") return undefined;
  const said = textOfBlocks(blocks).trim();
  return {
    _tag: "error",
    message: truncateNarration(said === "" ? flagged : said),
  };
};

/**
 * The model name the CLI gives a message it wrote itself rather than one the model
 * produced: an API error in the model's place, or its `No response requested.` filler.
 */
const CLI_SYNTHETIC_MODEL = "<synthetic>";

/** The CLI's filler for a turn that asked the model nothing. Not an error. */
const CLI_NO_RESPONSE = "No response requested.";

/**
 * The harness's own sentence for a turn it ended in error (A6 U4), or `undefined`.
 *
 * Only a `result` whose outcome is `failed` — so never an interrupt this application asked
 * for, which {@link outcomeOf} calls `interrupted` — and only when the CLI said something:
 * its `errors`, joined. A failed `result` with none narrates nothing, rather than a sentence
 * this server would have to word. A provider refusing a call is an `assistant` frame with
 * `error` set, which {@link assistantError} narrates; this is what that leaves: a turn that
 * ran out of turns or budget, or broke while executing.
 *
 * **Live only.** The CLI's transcript stores no `result` message, so a reload has nothing
 * to read this from: a turn that ended this way shows its error while watched and not after
 * a reload. The provider refusal above is stored, as the assistant message it is, and is
 * drawn either way.
 */
export const resultError = (
  message: SDKMessage,
  outcome: TerminalOutcome | undefined,
): NarrationDetail | undefined => {
  if (message.type !== "result" || outcome !== "failed") return undefined;
  const errors = (message as { readonly errors?: unknown }).errors;
  const said = Array.isArray(errors)
    ? errors.filter(
        (each): each is string =>
          typeof each === "string" && each.trim() !== "",
      )
    : [];
  return said.length === 0
    ? undefined
    : { _tag: "error", message: truncateNarration(said.join("\n")) };
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

/**
 * Whether a stored entry is the CLI's own record of a local slash command rather than
 * anything said in the conversation — which a replay would otherwise show as an operator
 * message the harness holds and never answered.
 *
 * `Query.setModel` is recorded in the transcript as though `/model` had been typed (A6 F4).
 * Measured on the model-switch probe's 2.1.310 transcripts, each switch is a run of three
 * user entries: a `<local-command-caveat>` carrying `isMeta: true` — the only entry of the
 * run that does — then `<command-name>/model</command-name>` with its `<command-message>`
 * and `<command-args>`, then `<local-command-stdout>Set model to …</local-command-stdout>`
 * (`stderr` for a command that failed).
 *
 * **The run is recognised by where it sits, not by what its text looks like.** SDK 0.3.310's
 * `getSessionMessages` drops the `isMeta` caveat itself and marks the entries that follow it
 * as that same command — the first non-meta `<command-name>` record after the caveat, then
 * the stdout/stderr outputs after that record, stopping at anything else — with
 * `isCompletedLocalCommand: true`. That flag is what is read here, and only that. A
 * message this server sent is not part of such a run even when its whole text is one of the
 * wrappers: an importer follow-up is the operator's words unchanged
 * (`assembleImporterFollowUpPrompt`), and so is a goal follow-up without attachments, so an
 * operator who pastes `<local-command-stdout>…</local-command-stdout>` sends exactly that —
 * and the CLI stores it with `promptSource: "sdk"`, which the SDK never counts as part of a
 * run, so it is kept even when it lands directly after a `/model` run's output.
 *
 * The flag is not in the SDK's published `SessionMessage` type, so it is read through a cast
 * — the same honest form as the steer's `uuid` and `priority` below. Should a later SDK stop
 * setting it, these entries reappear in the replay; no operator message can vanish.
 *
 * V2(chat): dropped, not shown. The transcript work marks where a model switch happened;
 * these entries are not that marker and are not turned into one here.
 */
const isLocalCommandEntry = (entry: SessionMessage): boolean =>
  entry.type === "user" &&
  (entry as { readonly isCompletedLocalCommand?: unknown })
    .isCompletedLocalCommand === true;

/**
 * What a `user` entry marks, for an entry the CLI wrote itself; `undefined` for one somebody
 * sent.
 *
 * **Told by the SDK's own markers, never by the content's shape.** Every message this server
 * sends is string content today, but an attachment (U13) makes an operator's message a list
 * of blocks, so "a list is the CLI's" would turn the operator's words into a note. What
 * separates the two is what the CLI stamps on its own entries:
 *
 * - **`origin`.** A `<task-notification>` — a background task that finished, or a
 *   foreground `Bash` a Stop killed after it had run for a few seconds — is a `user` entry
 *   with **string** content and `promptSource: "system"`; the killed one is stored as a
 *   `queued_command` attachment that `getSessionMessages` surfaces as a user entry with
 *   `isQueuedCommand: true`. SDK 0.3.310 keeps `origin: {kind: "task-notification"}` on
 *   both (measured on 2.1.310, `testdata/claude-code-transcript/task-notifications.cli.jsonl`),
 *   and no message this server sends carries an `origin` ({@link userMessage}). Not in the
 *   published `SessionMessage` type, so read through a cast like `isCompletedLocalCommand`.
 *   A task notification is `task`; any other kind but `human` is named by its kind.
 * - **`isCompactSummary` / `is_meta`.** When the CLI compacts a session it stores the
 *   summary (`This session is being continued from a previous conversation…`, several KB
 *   of its own prose) as a `user` entry with **string** content, `isCompactSummary: true`,
 *   `isVisibleInTranscriptOnly: true` and no `origin`. SDK 0.3.310 keeps
 *   `isCompactSummary: true` and adds `is_meta: true`, which it sets for any of `isMeta`,
 *   `isCompactSummary` and `isVisibleInTranscriptOnly` — none of which a message this
 *   server sends carries (`compaction.cli.jsonl`). The summary is `compacted`; any other
 *   `is_meta` entry is `meta`. Neither is declared on `SessionMessage`; read through a cast.
 *   **A replay after a compaction starts at the summary:** `getSessionMessages` follows the
 *   chain back only to the compaction boundary (whose `parentUuid` is null), so nothing
 *   said before it is in the read — the summary is all the replay holds of it.
 * - **The interrupt note**, as a last resort, because nothing else marks it: after a Stop
 *   the CLI writes `[Request interrupted by user for tool use]` (or `… by user]` for a cut
 *   reply) as a `user` entry whose content is exactly one `text` block opening with that text,
 *   with no `origin` and — once the SDK has read it — no `promptSource`
 *   (`interrupted-tool.cli.jsonl`). It is `interrupted`. An operator's message carrying an
 *   attachment has more than one block, and one sent as words is a string.
 *
 * Everything else in the user's role is the operator's (or, in a planner round, a steer).
 * Should a later SDK stop passing `origin` or `is_meta` through, a notification or a
 * compaction summary reads as the operator's again; no operator message can be hidden by
 * this.
 */
const cliMarker = (entry: SessionMessage): string | undefined => {
  if (entry.type !== "user") return undefined;
  const origin = (entry as { readonly origin?: unknown }).origin;
  const kind =
    typeof origin === "object" && origin !== null
      ? (origin as { readonly kind?: unknown }).kind
      : undefined;
  if (typeof kind === "string" && kind !== "human") {
    return kind === "task-notification" ? "task" : kind;
  }
  const flags = entry as {
    readonly isCompactSummary?: unknown;
    readonly is_meta?: unknown;
  };
  if (flags.isCompactSummary === true) return "compacted";
  if (flags.is_meta === true) return "meta";
  const content = (entry.message as { readonly content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const [only] = content as readonly unknown[];
  const text =
    typeof only === "object" &&
    only !== null &&
    (only as { type?: unknown }).type === "text"
      ? (only as { text?: unknown }).text
      : undefined;
  return typeof text === "string" &&
    text.trimStart().startsWith("[Request interrupted by user")
    ? "interrupted"
    : undefined;
};

/**
 * The stored transcript as {@link MessageEntry}s, each with its parts (A6 F10).
 *
 * **Parts as the stream narrated them.** An `assistant` entry's blocks go through
 * {@link assistantParts} and a `user` entry's `tool_result`s through {@link userParts},
 * the two functions {@link narrate} reads live frames with, so a replay is the live
 * conversation's own items. A `user` entry whose content is a string is the words sent —
 * the operator's, under whatever framing the caller trims — and has no parts. One the CLI
 * wrote itself — an interrupt note, a task notification, a compaction summary — carries
 * a `marker` ({@link cliMarker}), whatever its content's shape.
 *
 * **A finished block gets the `blockId` it streamed under**, when the transcript lets this
 * name it: the CLI writes one entry per content block of a call (the split the stream
 * makes, `claude-code-partial-stream-facts`), each repeating the call's `message.id`, so a
 * block's stream index is the number of blocks of that call stored before it plus its
 * place in its entry. The count is per `message.id` across the whole read, so a `user`
 * entry (a tool's result) between two blocks of one call does not reset it. That holds only
 * while every block of a call is stored: a call the transcript holds part of names its
 * later blocks wrongly, which is harmless — a replayed `blockId` is only ever compared
 * with a live one for the same session, and a reload's live tail starts after the replay.
 *
 * `model` is the entry's `message.model`; `at` is its `timestamp`, which SDK 0.3.310's
 * `getSessionMessages` passes through from the CLI's record (an ISO string) without
 * declaring it — read through a cast, like `isCompletedLocalCommand`. Should a later SDK
 * drop it, replayed items carry no time of their own and the caller says so.
 */
const flattenTranscript = (
  entries: readonly SessionMessage[],
  uploadsFolder: string | undefined,
  /**
   * The steers this process delivered into the session, by the UUID each was stored under
   * (`claudeCodeMessageId`) to the application's id for it: what names an operator entry's
   * `messageId`. Empty for a session this process does not hold.
   */
  steers: ReadonlyMap<string, string> = new Map(),
): MessageEntry[] => {
  const blocksSeen = new Map<string, number>();
  const subagents: SubagentCalls = new Map();
  return entries.map((entry): MessageEntry => {
    const message = (entry.message ?? {}) as {
      id?: unknown;
      content?: unknown;
    };
    const blocks = Array.isArray(message.content) ? message.content : [];
    const callId = typeof message.id === "string" ? message.id : undefined;
    const first = callId === undefined ? 0 : (blocksSeen.get(callId) ?? 0);
    if (callId !== undefined) blocksSeen.set(callId, first + blocks.length);
    const stamp = (entry as { readonly timestamp?: unknown }).timestamp;
    const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    const text =
      typeof message.content === "string"
        ? message.content
        : blocks
            .filter(
              (part): part is { type: string; text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
            )
            .map((part) => part.text)
            .join("\n");
    const marker = cliMarker(entry);
    /*
     * A provider's refusal the CLI stored in the model's place (A6 U4 review): the `error`
     * it is live ({@link assistantError}), not a reply. The stored entry carries the same
     * `error` field, but SDK 0.3.310's `getSessionMessages` does not pass it (nor
     * `isApiErrorMessage`) through, so it is told here by what the SDK does keep: the
     * `<synthetic>` model the CLI gives every message it writes itself, which a model's own
     * reply never carries. The one synthetic message that is not an error is the CLI's
     * `No response requested.` filler, which stays what it was.
     */
    if (
      entry.type === "assistant" &&
      modelOfMessage(message) === CLI_SYNTHETIC_MODEL &&
      text.trim() !== "" &&
      text.trim() !== CLI_NO_RESPONSE
    ) {
      return {
        type: entry.type,
        text,
        error: truncateNarration(text),
        parts: [],
        model: undefined,
        at: Number.isFinite(at) ? at : undefined,
      };
    }
    /*
     * A background sub-agent's notification (A6 U14): its end, as the sub-agent's state,
     * and not its words, which carry the sub-agent's own result. Live, the same end comes
     * from the `task_notification` frame and the stored note is never narrated, so the
     * replay drops it too. A notification about anything else is a `task` note, below.
     */
    const notified = marker === "task" ? storedNotification(text) : undefined;
    if (notified !== undefined && subagents.has(notified.toolUseId)) {
      return {
        type: entry.type,
        text: "",
        marker: "task",
        error: undefined,
        parts: subagentNotified(subagents, notified.toolUseId, notified.status),
        model: undefined,
        at: Number.isFinite(at) ? at : undefined,
      };
    }
    /*
     * Any other task notification — a `Bash` task's, or a sub-agent's whose call this read
     * does not hold (it was launched before a compaction) — is a `task` note, drawn as its
     * `<summary>`, or its `<status>` when it has none, and **never** its `<result>`: an
     * agent's notification carries the sub-agent's own final report there, and drawn under
     * `task` it would be a sub-agent's words in the caller's chat.
     */
    if (marker === "task") {
      return {
        type: entry.type,
        text: notificationLine(text),
        marker,
        error: undefined,
        parts: [],
        model: undefined,
        at: Number.isFinite(at) ? at : undefined,
      };
    }
    /*
     * The files an operator's message carried (A6 F9): its trailing `[Attached …]` lines
     * naming files in the session's own `uploads/` folder, taken out of the words. Each is
     * typed by its stored name, not by the message's image blocks: the CLI re-encodes a large
     * image before storing it (measured: a 6.4 MiB PNG came back as `image/jpeg`), and the
     * blocks are not the lines one for one, so neither their types nor their order say which
     * file is which.
     */
    const split =
      entry.type === "user" && marker === undefined
        ? splitAttachmentLines(text, { uploadsFolder })
        : undefined;
    // A steer of ours is stored under the UUID it was delivered with (A6 U4 review 2).
    const steer =
      entry.type === "user" && marker === undefined
        ? steers.get(entry.uuid)
        : undefined;
    return {
      type: entry.type,
      text: split?.text ?? text,
      ...(marker === undefined ? {} : { marker }),
      ...(steer === undefined ? {} : { messageId: steer }),
      ...(split === undefined || split.attachments.length === 0
        ? {}
        : { attachments: split.attachments }),
      // No other error is read from the transcript: a turn's own failure arrives as a
      // `result` message on the live stream only (`resultError`), and the CLI stores none.
      // A provider's refusal is the synthetic entry above.
      error: undefined,
      parts:
        entry.type === "assistant"
          ? assistantParts(
              blocks,
              modelOfMessage(message),
              (_, position) =>
                callId === undefined
                  ? {}
                  : { blockId: claudeCodeBlockId(callId, first + position) },
              subagents,
            )
          : entry.type === "user"
            ? userParts(blocks, subagents, false)
            : [],
      model: entry.type === "assistant" ? modelOfMessage(message) : undefined,
      at: Number.isFinite(at) ? at : undefined,
    };
  });
};

/**
 * A user message's content: the words alone, or image blocks and then the words (A6 F9).
 *
 * A string whenever the message carries no image, which is every message without files and
 * every message whose files are path-only — so nothing about those changed. With images it
 * is a list, and {@link cliMarker} still reads it as the operator's: it keys on the SDK's
 * markers, never on the content's shape.
 */
type UserContent =
  | string
  | ReadonlyArray<
      | {
          readonly type: "image";
          readonly source: {
            readonly type: "base64";
            readonly media_type: string;
            readonly data: string;
          };
        }
      | { readonly type: "text"; readonly text: string }
    >;

/**
 * The content one prompt sends, its files read off disk for the image blocks.
 *
 * Every file gets its path line ({@link withAttachmentLines}); an image also goes inline, as
 * a base64 block **before** the text, the order the Messages API documents for an image the
 * text then talks about. A file that cannot be read fails the prompt before anything is sent.
 *
 * V2(chat): non-image files reach Claude Code as a path only; the agent reads them with its
 * own tools if it decides to. Proper V2: inline text/plain and PDF as document blocks where
 * the SDK accepts them, matching OpenCode.
 */
const userContent = (
  text: string,
  attachments: readonly MessageAttachment[],
): Effect.Effect<UserContent, HarnessTransportError> =>
  Effect.gen(function* () {
    const words = withAttachmentLines(text, attachments);
    const images = attachments.filter((file) => file.kind === "image");
    if (images.length === 0) return words;
    const blocks = yield* Effect.forEach(images, (image) =>
      Effect.try({
        try: () => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mimeType,
            data: readFileSync(image.path).toString("base64"),
          },
        }),
        catch: (cause) =>
          transport(
            "session.prompt",
            `the attached image ${image.path} could not be read (${cause instanceof Error ? cause.message : String(cause)}); nothing was sent`,
          ),
      }),
    );
    return [...blocks, { type: "text" as const, text: words }];
  });

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
  content: UserContent,
  uuid: string,
  delivery: Extract<PromptDelivery, { _tag: "steer" }> | undefined,
): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: record.sessionId,
    // Every message carries one, the opening prompt included, so the `result` that answers
    // it can be told from a turn the CLI ran on its own. See `SessionRecord.unanswered`.
    uuid,
    ...(delivery === undefined
      ? {}
      : {
          // `later` lets the work in flight finish; `now` cuts it off. The mapping is in
          // one place so a caller never names a driver's word.
          priority: delivery.urgency === "preemptive" ? "now" : "later",
        }),
  }) as SDKUserMessage;

/**
 * The frames that mean a turn is under way: the CLI opens every turn with `system/init`
 * (measured on 2.1.310, a task-notification turn included), and a main-thread reply or tool
 * result cannot arrive outside one. A turn opened here is closed only by a `result`, so
 * nothing may open one that a `result` does not follow.
 *
 * **Main thread only** (A6 F5's fourth review). A subagent's frames carry the `Agent` call
 * they belong to in `parent_tool_use_id`, and one started with `run_in_background: true`
 * streams them *after* its parent turn's `result` (measured on 2.1.310). No `result`
 * follows those: an `interrupt()` then stops the background agent (`task_notification
 * status=stopped`) and sends none. Read as a turn, they left the session "running" with
 * nothing to close it, and a Stop in that window marked the operator's next turn
 * interrupted. Everything else the CLI says between turns — task and background-task
 * bookkeeping, rate limits, command lifecycle, partial and progress frames, which carry the
 * same `parent_tool_use_id` and only arrive inside a turn `system/init` already opened — is
 * not a turn either.
 */
const opensTurn = (message: SDKMessage): boolean =>
  ((message.type === "assistant" || message.type === "user") &&
    message.parent_tool_use_id == null) ||
  (message.type === "system" && message.subtype === "init");

/** The uuids of the messages a frame says its turn has consumed, if it says. */
const answeredUuids = (message: SDKMessage): readonly string[] | undefined => {
  const stamp = message as {
    readonly user_message_uuids?: readonly string[];
    readonly user_message_uuid?: string;
  };
  if (
    stamp.user_message_uuids !== undefined &&
    stamp.user_message_uuids.length > 0
  ) {
    return stamp.user_message_uuids;
  }
  return stamp.user_message_uuid === undefined
    ? undefined
    : [stamp.user_message_uuid];
};

/**
 * A `taken` entry for each steer this frame is the first to say was consumed (A6 U4), and
 * nothing for any other frame. Removes each from {@link SessionRecord.untaken}, so a later
 * frame naming it again — every reply frame of that turn does, and its `result` — says
 * nothing more. A uuid this session did not send as a steer (the opening prompt, a turn
 * the CLI ran itself) is not in the map and narrates nothing.
 */
export const takenNarration = (
  record: Pick<SessionRecord, "untaken">,
  message: SDKMessage,
): readonly HarnessNarration[] => {
  const named = answeredUuids(message);
  if (named === undefined || record.untaken.size === 0) return [];
  const at = Date.now();
  const taken: HarnessNarration[] = [];
  for (const uuid of named) {
    const messageId = record.untaken.get(uuid);
    if (messageId === undefined) continue;
    record.untaken.delete(uuid);
    taken.push({
      type: message.type,
      sequence: undefined,
      at,
      outcome: undefined,
      detail: { _tag: "taken", messageId },
    });
  }
  return taken;
};

/**
 * What a `result` answers: the messages it names, or — from a CLI that has never named
 * one on this session — the oldest still waiting. A `result` naming none from a CLI that
 * does name them ended a turn nobody sent, and answers nothing.
 */
const answer = (record: SessionRecord, message: SDKMessage): void => {
  const named = answeredUuids(message);
  if (named !== undefined) {
    record.stamped = true;
    for (const uuid of named) record.unanswered.delete(uuid);
    return;
  }
  if (record.stamped) return;
  const oldest = record.unanswered.values().next();
  if (oldest.done !== true) record.unanswered.delete(oldest.value);
};

/** A turn is running on this session's query, or one it accepted is still to answer. */
const sessionRunning = (record: SessionRecord): boolean =>
  !record.closed && (record.turnOpen || record.unanswered.size > 0);

/** Whether a task the CLI started is still running. See `SessionRecord.tasks`. */
const backgroundRunning = (record: SessionRecord): boolean =>
  !record.closed && record.tasks.size > 0;

/**
 * Whether a frame naming run `runId` is late for the task entry `held`: the SDK promises
 * that one task's run ids sort, by plain string comparison, in the order the runs opened,
 * and that a frame naming a run sorting before the one a reader shows is late (0.3.310,
 * `SDKTaskStartedMessage.run_id`). Without both ids nothing can be late.
 */
const lateRun = (held: TrackedTask | undefined, runId: string | undefined) =>
  held?.runId !== undefined && runId !== undefined && runId < held.runId;

/**
 * Keeps {@link SessionRecord.tasks} in step with one frame: a task starts at
 * `system/task_started` and is over at its `system/task_notification` — unless that frame
 * names an earlier run than the one held ({@link lateRun}), which is a late frame about a
 * run already over, not news about the one going.
 */
const trackTask = (record: SessionRecord, message: SDKMessage): void => {
  if (message.type !== "system") return;
  if (message.subtype === "task_started") {
    if (message.ambient === true) return;
    if (lateRun(record.tasks.get(message.task_id), message.run_id)) return;
    record.tasks.set(message.task_id, {
      type: message.task_type ?? "unknown",
      runId: message.run_id,
    });
  } else if (message.subtype === "task_notification") {
    if (lateRun(record.tasks.get(message.task_id), message.run_id)) return;
    record.tasks.delete(message.task_id);
  }
};

/**
 * How long a Stop waits for the tasks it stopped to say so, with their
 * `task_notification`s. Measured at under 20 ms on 2.1.310 for both an `interrupt()` and a
 * `stopTask`; a task still listed after this is reported as possibly running, never as
 * stopped.
 */
const TASK_STOP_SETTLE_MILLIS = 2_000;

export const claudeCodeHarness = (
  options: ClaudeCodeHarnessOptions = {},
): Layer.Layer<AgentHarness, HarnessProcessError> =>
  Layer.effect(
    AgentHarness,
    Effect.gen(function* () {
      const sdk = options.sdk ?? liveClaudeCodeSdk;
      const defaultModel = options.defaultModel ?? CLAUDE_CODE_DEFAULT_MODEL;
      const controlTimeout = options.controlTimeout ?? DEFAULT_CONTROL_TIMEOUT;
      const cliStopBounds = options.cliStopBounds ?? DEFAULT_CLI_STOP_BOUNDS;
      const cliTreeRefresh = options.cliTreeRefresh ?? DEFAULT_CLI_TREE_REFRESH;
      const taskStopTimeout =
        options.taskStopTimeout ?? DEFAULT_TASK_STOP_TIMEOUT;
      const interruptTimeout =
        options.interruptTimeout ?? DEFAULT_INTERRUPT_TIMEOUT;

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
       * The record each {@link SessionRef} `createSession` handed out stands for.
       *
       * What `endSession` resolves, rather than {@link sessions}: a resume creates a record
       * under an id that may already have one, and `sessions` then names only the newer. An
       * earlier opening's close ends the earlier record — its own CLI — and leaves the newer
       * one running (A6 F5 review).
       */
      const handedOut = new WeakMap<SessionRef, SessionRecord>();

      /**
       * Every record this layer created, superseded ones included, so the finalizer reaches a
       * CLI that {@link sessions} no longer names.
       */
      const records = new Set<SessionRecord>();

      /**
       * Closes one session's query and ends its narration.
       *
       * Called when the pump sees a terminal `result`, and again from this layer's
       * finalizer for anything still open. Idempotent, because those two can race on a
       * shutdown that lands while a run is settling.
       *
       * **A single-turn session closes itself** here, when its turn ends, so a run's
       * supervisor has no close to remember. A conversation's (`multiTurn`) query stays open
       * between turns and across a Stop, so it is closed by `endSession` — which the
       * conversation spine calls on every close (A6 F5) — or by this layer's finalizer.
       */
      const closeSession = (record: SessionRecord): Effect.Effect<void> =>
        Effect.sync(() => {
          if (record.closed) return;
          record.closed = true;
          Deferred.doneUnsafe(record.ended, Effect.void);
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
          forgetIfFinished(record);
        }).pipe(Effect.andThen(Queue.end(record.narration)));

      /**
       * Stops a session's CLI and its process group now, and waits for it, bounded.
       *
       * After {@link closeSession}, never instead of it: the query is closed first, so the
       * SDK has let go of the process and reads its exit as the end it asked for. A CLI that
       * outlives both bounds is logged, since there is nothing further to try; one whose
       * group could not be verified at spawn has only the direct child to stop, which the
       * spawn already warned about.
       */
      const stopCli = (record: SessionRecord): Effect.Effect<void> =>
        Effect.suspend(() => {
          const cli = record.cli;
          if (cli === undefined) return Effect.void;
          const running = cli.stopping;
          if (running !== undefined) return Deferred.await(running);
          const stopping = Deferred.makeUnsafe<void>();
          cli.stopping = stopping;
          return Effect.ensuring(
            stopOnce(record, cli),
            Effect.sync(() => {
              cli.stopping = undefined;
              Deferred.doneUnsafe(stopping, Effect.void);
            }),
          );
        });

      /** One stop of `cli`, the one {@link stopCli} lets run at a time. */
      const stopOnce = (
        record: SessionRecord,
        cli: OwnedCli,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const { child } = cli;
          const outcome = yield* stopOwnedChild(
            {
              pid: child.pid,
              tree: cli.tree,
              exited: () =>
                child.exitCode !== null || child.signalCode !== null,
              kill: (signal) => {
                child.kill(signal);
              },
            },
            cliStopBounds,
          );
          // Nothing of it is left, so nothing is ever signalled for it again — its pid may
          // already be someone else's. A survivor is kept, for the finalizer to try again.
          if (outcome !== "survived" && record.cli === cli) {
            record.cli = undefined;
          }
          forgetIfFinished(record);
          if (outcome === "survived") {
            yield* Effect.logError(
              "an ended Claude Code session's CLI survived SIGKILL; it may still be running",
              { sessionId: record.sessionId, pid: child.pid },
            );
          } else if (outcome === "killed") {
            yield* Effect.logWarning(
              "an ended Claude Code session's CLI ignored SIGTERM and was killed",
              { sessionId: record.sessionId, pid: child.pid },
            );
          }
        });

      /**
       * Drops a record from {@link records} once nothing of it is left to stop: its query is
       * closed and its CLI, and everything the CLI started, are gone. {@link sessions} keeps
       * it, for the reason given there; the finalizer has nothing to do for it.
       */
      const forgetIfFinished = (record: SessionRecord): void => {
        if (record.closed && record.cli === undefined) records.delete(record);
      };

      /** Closes one session's query and stops its CLI: the whole of ending it. */
      const endRecord = (record: SessionRecord): Effect.Effect<void> =>
        Effect.andThen(closeSession(record), stopCli(record));

      // Every CLI goes with the layer, at once rather than one after another: each stop is
      // bounded, but a shutdown waiting on them in turn would wait for the sum.
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...records], endRecord, {
          concurrency: "unbounded",
          discard: true,
        }),
      );

      /**
       * The SDK's `spawnClaudeCodeProcess` for one session: the CLI it was going to start,
       * started by this harness instead, `detached` so that it leads a process group of its
       * own and {@link stopCli} can stop it with every tool process it starts.
       *
       * Everything the SDK decides is unchanged — the binary (the one it carries, which is
       * what the version floor checked), the arguments, the environment, the directory.
       * What moves here is the process, and the one thing the SDK's own spawn did with it
       * that a custom one does not: reading stderr. It is drained here, because an unread
       * pipe fills and stalls the CLI, and logged as before.
       *
       * Known limit of detaching, as for `opencode serve` (`openCodeServer.ts`): the CLI no
       * longer gets the terminal's `SIGINT` with the server, so it is stopped by this layer's
       * finalizer, and if the server is killed outright it sees its stdin close — and its
       * policy gate unreachable, which refuses every tool call.
       */
      const spawnOwnedCli =
        (record: SessionRecord) => (spawnOptions: SpawnOptions) => {
          const child = spawnChild(spawnOptions.command, spawnOptions.args, {
            ...(spawnOptions.cwd === undefined
              ? {}
              : { cwd: spawnOptions.cwd }),
            env: spawnOptions.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
            windowsHide: true,
          });
          const pid = child.pid;
          const ownsGroup = pid !== undefined && leadsOwnGroup(pid);
          const cli: OwnedCli | undefined =
            pid === undefined
              ? undefined
              : {
                  child,
                  ownsGroup,
                  tree: trackProcessTree(pid, ownsGroup),
                  stopping: undefined,
                };
          record.cli = cli;
          // See `OwnedCli.tree`. Unref'd: a CLI's watch must not keep the server alive.
          const watch =
            cli === undefined
              ? undefined
              : setInterval(() => {
                  cli.tree.refresh();
                }, cliTreeRefresh);
          watch?.unref();
          record.stderrTail = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (data: string) => {
            record.stderrTail = (record.stderrTail + data).slice(-STDERR_TAIL);
            // Diagnostics only. A line on the CLI's stderr is not an outcome, and this must
            // not be able to fail the run.
            void Effect.runPromise(
              Effect.logDebug("claude code stderr", {
                sessionId: record.sessionId,
                data,
              }),
            ).catch(() => undefined);
          });
          child.stderr.on("error", () => undefined);
          child.once("exit", (code, signal) => {
            clearInterval(watch);
            if (cli !== undefined) {
              /*
               * Straight after the runtime reaped it, while its group's id cannot have been
               * handed on if anything is left in it: what it left running there is taken in
               * now, and if nothing is left, `record.cli` goes, so a stop asked for later —
               * an end, the finalizer — signals nothing at a pid that may be a stranger's
               * by then (A6 F5's third review).
               *
               * If something is left, it is stopped now rather than at an end that may be
               * a long way off: a CLI that died on its own — crashed, OOM-killed — leaves
               * its tools running with nobody's session over them (A6 F5's fourth review).
               * Not when a stop is already under way: that one is waiting for this exit.
               */
              cli.tree.adoptOrphanedGroup();
              if (record.cli === cli) {
                if (!cli.tree.alive()) {
                  record.cli = undefined;
                  forgetIfFinished(record);
                } else if (cli.stopping === undefined) {
                  void Effect.runPromise(
                    Effect.andThen(
                      Effect.logWarning(
                        "a Claude Code CLI exited and left processes it started running; stopping them",
                        { sessionId: record.sessionId, pid, code, signal },
                      ),
                      stopCli(record),
                    ),
                  ).catch(() => undefined);
                }
              }
            }
            // Not one this harness ended: a CLI that fails on its own says why on stderr.
            if (code !== null && code !== 0 && !record.closed) {
              record.cliFailed = true;
              void Effect.runPromise(
                Effect.logWarning("a Claude Code CLI exited with a failure", {
                  sessionId: record.sessionId,
                  code,
                  signal,
                  stderr: record.stderrTail,
                }),
              ).catch(() => undefined);
            }
          });
          if (pid !== undefined && !ownsGroup) {
            void Effect.runPromise(
              Effect.logWarning(
                "could not verify a Claude Code CLI leads its own process group; ending its session stops the CLI only, not the tools it started",
                { sessionId: record.sessionId, pid },
              ),
            ).catch(() => undefined);
          }
          // Ended while the SDK was still starting it: nothing may run, so it is stopped as
          // soon as it exists.
          if (record.closed) {
            void Effect.runPromise(stopCli(record)).catch(() => undefined);
          }
          return child;
        };

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
                  trackTask(record, message);
                  if (answeredUuids(message) !== undefined) {
                    record.stamped = true;
                  }
                  if (
                    message.type !== "result" &&
                    !record.turnOpen &&
                    opensTurn(message)
                  ) {
                    /*
                     * A turn has begun, the CLI's own included. A conversation that had gone
                     * idle gets a fresh `idle`, as `prompt` gives it for a message it
                     * accepts, so `waitForIdle` asked now waits for this turn.
                     */
                    record.turnOpen = true;
                    if (
                      record.multiTurn &&
                      Deferred.isDoneUnsafe(record.idle)
                    ) {
                      record.idle = Deferred.makeUnsafe<void, HarnessFailure>();
                    }
                  }
                  if (message.type === "result") {
                    record.outcome = outcome;
                    // The interrupt was for this turn. A conversation's query outlives it, and
                    // the next turn — a queued message running straight after, say — has not
                    // been interrupted by anyone.
                    if (record.multiTurn) record.interrupted = false;
                    record.cost = message.total_cost_usd;
                    record.tokens = message.usage as unknown as Record<
                      string,
                      unknown
                    >;
                    record.turnOpen = false;
                    answer(record, message);
                  }
                  // Before the frame's own entries: the turn that took a steer is that
                  // steer's work, so its first words sort after the take.
                  for (const entry of takenNarration(record, message)) {
                    Queue.offerUnsafe(record.narration, entry);
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
                   * been answered — by uuid, so a turn the CLI ran on its own neither
                   * finishes it early nor leaves it waiting. See `SessionRecord.unanswered`.
                   */
                  if (record.unanswered.size > 0) continue;
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
                  `the Claude Code stream ended in failure: ${String(cause)}${
                    !record.cliFailed || record.stderrTail.trim() === ""
                      ? ""
                      : `; the CLI's stderr ended: ${record.stderrTail.trim()}`
                  }`,
                ),
            }),
          );
          // The `for await` is over however it ended — an error, the single-turn `break`, or
          // a conversation's stream finishing because the CLI exited cleanly — and the
          // query with it: there is nothing left to prompt, and `closeSession` follows.
          record.settling = true;
          // After `settling`, so a switch woken by this reads the session as going: it is
          // resumed on this call stack, before `closeSession` runs.
          Deferred.doneUnsafe(record.ended, Effect.void);
          yield* drained._tag === "Failure"
            ? Deferred.fail(record.idle, drained.failure)
            : Deferred.succeed(record.idle, undefined);
          yield* closeSession(record);
        });

      /**
       * Reads the session's context window into its record, in the background.
       *
       * Bounded, its failure logged at debug and discarded, and `contextLimit` simply stays
       * unset: a read that does not answer costs a percentage on a meter and nothing else.
       * Into the layer's scope, like the pump, so it is not interrupted by the caller
       * returning and is interrupted on shutdown.
       *
       * Asked at launch and again after every model switch, because the window is the
       * *model's* as this session resolved it, and a switch can change it.
       */
      const readContextLimit = (
        record: SessionRecord,
        live: HarnessQuery,
      ): Effect.Effect<void> =>
        Effect.asVoid(
          Effect.forkIn(
            Effect.ignore(
              Effect.timeout(
                Effect.tap(
                  Effect.tryPromise({
                    try: () => live.getContextUsage(),
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
          ),
        );

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
        content: UserContent,
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
          // The opening prompt is message one. Recorded here rather than in `prompt`, so
          // that `unanswered` is true from the moment anything can be read from it.
          const opening = crypto.randomUUID();
          record.unanswered.add(opening);
          record.offer(userMessage(record, content, opening, undefined));

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
                  /*
                   * `resume` or `sessionId`, never both.
                   *
                   * The SDK's own doc on `sessionId`: "Cannot be used with `continue` or
                   * `resume` unless `forkSession` is also set", and a `sessionId` naming a
                   * session that already has turns is refused "already in use". So a resumed
                   * session names itself through `resume`, which the SDK documents as
                   * "Loads the conversation history from the specified session" — the same
                   * option `forkSession`'s doc points at as how a session is resumed.
                   *
                   * **No `forkSession` and no `resumeSessionAt`.** A fork would mint a new
                   * session id, which would lose the one thing a resume is for: the session
                   * index groups by `harness_session_id`, and a fork would show one
                   * conversation as two rows again. `resumeSessionAt` truncates a resume to
                   * a chosen point, which is a rewind and is nobody's intent here.
                   *
                   * V2(chat): rewinding a conversation to an earlier message is not offered.
                   * Both harnesses could: `resumeSessionAt` here (same session id, a new
                   * branch in the transcript) and OpenCode's `session.revert.stage`/`commit`.
                   * What neither undoes is what the agent wrote into bit through MCP after
                   * that message, so a rewind would leave the agent believing it had not
                   * written entries the Scope tab still shows. Proper V2: tie each MCP write
                   * to the turn that made it, then rewind conversation and writes together
                   * (or tell the agent what survived), as an in-place rewind so the session
                   * keeps one id and one row.
                   *
                   * **A resume cannot raise a dialog on this transport**, which is worth
                   * stating because the dialog is the caveat S2.5 carries. The CLI emits a
                   * `request_user_dialog` only for a `dialog_kind` the client declared in
                   * `supportedDialogKinds`, fails closed on absence, and the SDK's doc is
                   * explicit that "omitting the option entirely means no dialogs are
                   * emitted, even with `onUserDialog` wired". This query passes neither, so
                   * a dialog-gated flow degrades to its no-dialog behaviour rather than
                   * parking on an answer nothing here would give it.
                   */
                  ...(record.resumed
                    ? { resume: record.sessionId }
                    : { sessionId: record.sessionId }),
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
                  // Without this, a subagent's text never reaches the stream. Narration
                  // drops it (A6 U14); kept for V2 — see the header.
                  forwardSubagentText: true,
                  // Needed for `messages` to have anything to read later.
                  persistSession: true,
                  /*
                   * A block streamed as it is written (A6 F8), for a conversation only.
                   *
                   * Only the importer and goal conversations show partials, and they are
                   * the only `multiTurn` sessions (`harness/liveAgentSessions.ts`). A
                   * worker's attempt and a planner round would have each block's
                   * hundreds of frames serialised by the CLI, parsed by the SDK and
                   * mapped here only for their supervisors to drop the deltas before the
                   * bus (`narratesOnSharedBus`); the option is per `query()`, so they do
                   * not ask. Their finished blocks then carry no `blockId`, as before.
                   */
                  includePartialMessages: record.multiTurn,
                  /*
                   * A conversation's thinking carries words (A6 F8's review). Without this the
                   * API sends a thinking block's text as `""` and the operator sees an empty
                   * "Thinking" row; with it, a summary. A worker or a round shows thinking to
                   * nobody, so it does not ask.
                   *
                   * **The display alone, not the SDK's `thinking` option.** That option always
                   * adds `--thinking=adaptive` as well (unless given a budget), which turns a
                   * thinking *mode* on and is refused by Haiku 4.5; `--thinking-display`
                   * changes only what an existing thinking block shows. Measured on CLI
                   * 2.1.310: haiku-4-5 thinking 0 → 966 characters, sonnet-5 0 → 95, output
                   * tokens about the same.
                   *
                   * Set at launch and never changed for a live session, because the display
                   * mode is part of the request and moving it mid-session would break the
                   * prompt cache. A session resumed by this build from one started before it
                   * pays that break once, on its first turn.
                   *
                   * `extraArgs` is an untyped passthrough onto the CLI's argv: nothing checks
                   * the flag's name or its value. `claude --help` does not list
                   * `--thinking-display` (2.1.310 accepts it in its argument parser without
                   * documenting it), so the only check on a CLI upgrade is a real run: a
                   * multi-turn session's thinking blocks must still carry words.
                   */
                  ...(record.multiTurn
                    ? { extraArgs: { "thinking-display": "summarized" } }
                    : {}),
                  // This harness starts the CLI, so that ending the session can stop it at
                  // once; stderr is read there. See `spawnOwnedCli`.
                  spawnClaudeCodeProcess: spawnOwnedCli(record),
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
           * The session's context window, read beside the run rather than in it.
           *
           * Forked for two reasons. It is a control round trip to a subprocess that has
           * just started, so awaiting it here would delay the moment the prompt is accepted
           * — and the caller of this is the supervisor, which has a run to get going. And a
           * window is a *denominator*: a read that does not answer costs a percentage on a
           * meter, which must never be allowed to cost a run. See `readContextLimit`.
           */
          yield* readContextLimit(record, started);

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
        // A resume names the session it is continuing; `sessionId` is ignored beside it,
        // as the seam says and as the SDK requires. See `SessionRecord.resumed`.
        const sessionId =
          input.resume ?? input.sessionId ?? newClaudeCodeSessionId();
        const narration = yield* Queue.sliding<HarnessNarration, Cause.Done>(
          NARRATION_BUFFER,
        );
        const idle = yield* Deferred.make<void, HarnessFailure>();
        const record: SessionRecord = {
          sessionId,
          title: input.title,
          model: input.model,
          effort: claudeCodeEffortOf(input.options),
          switchUnsettled: false,
          switching: yield* Semaphore.make(1),
          directory: input.directory,
          mcpServers: {},
          narration,
          multiTurn: input.multiTurn === true,
          resumed: input.resume !== undefined,
          idle,
          ended: yield* Deferred.make<void>(),
          unanswered: new Set<string>(),
          untaken: new Map<string, string>(),
          turnOpen: false,
          stamped: false,
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
          streamed: { messageId: undefined, index: undefined, kind: undefined },
          subagents: new Map(),
          interrupted: false,
          tasks: new Map<string, TrackedTask>(),
          closed: false,
          cli: undefined,
          stderrTail: "",
          cliFailed: false,
        };
        sessions.set(sessionId, record);
        records.add(record);
        // `parentSessionId` is ignored: Claude Code has no lineage concept to route prompt
        // caching through, and nothing in this application passes it for a worker session.
        const ref: SessionRef = { id: sessionId };
        handedOut.set(ref, record);
        return ref;
      });

      /** One control request to a live query, bounded and mapped like the others here. */
      const control = (
        operation: string,
        run: () => Promise<unknown>,
        refused: string,
      ): Effect.Effect<void, HarnessTransportError> =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            transport(operation, `${refused}: ${String(cause)}`),
        }).pipe(
          Effect.timeout(controlTimeout),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              transport(
                operation,
                `${refused} within the control bound; whether it took the change is unknown`,
                { tag: "TimeoutError" },
              ),
            ),
          ),
          Effect.asVoid,
        );

      /**
       * Moves a session this process holds onto another model, or another effort.
       *
       * Three states of the record, three answers:
       *
       * - **Created, not yet prompted** — no query exists, so there is nothing to ask. The
       *   record is changed and `launch` starts the query on the new model and effort.
       * - **Live** — `setModel`, then `applyFlagSettings({ effortLevel })`. The model goes
       *   first so the level is applied to the model it is meant for. The record changes
       *   one field at a time, each only after its request answered, which is what makes a
       *   retry after a partial failure send exactly what is still missing.
       * - **Settling, closed, or never held** — refused with `SESSION_NOT_FOUND_TAG`. See
       *   `AgentHarness.switchModel` on why that is a refusal and not a lost switch. That
       *   includes a query that closes **while a request is waiting**: a failure seen once
       *   the record is settling, closed or replaced is reported as not found, whatever the
       *   SDK said, because there is no live query left for the switch to be uncertain about.
       *
       * Switches on one session are taken one at a time, under the record's
       * {@link SessionRecord.switching} permit, so the record's fields follow the order the
       * CLI saw the requests in.
       *
       * **The level is always sent after a model change**, even when it equals the record's:
       * the record says what *we* last set, and whether the CLI keeps a flag-layer effort
       * across `setModel` is its business. Sending it costs one control request; not sending
       * it could leave the new model at a level nobody chose for it. With no model change and
       * the same level, nothing is sent at all, which is the idempotence the seam promises.
       */
      const switchModel: AgentHarness["Service"]["switchModel"] = Effect.fn(
        "claudeCodeHarness.switchModel",
      )(function* (sessionId, model, options) {
        const notLive = (detail: string) =>
          transport(
            "session.switchModel",
            `${detail}; a resume starts on the model it is opened with`,
            { tag: SESSION_NOT_FOUND_TAG, status: 404 },
          );
        const record = sessions.get(sessionId);
        if (record === undefined) {
          return yield* notLive(
            `this process holds no live session ${sessionId}, so there is no query to switch`,
          );
        }
        // `settling` as well as `closed`, for the reason `prompt` refuses a steer on it: the
        // pump has decided the session is over and `closeSession` is one Effect boundary
        // away, so a query that still answers now is one nothing will prompt again. And a
        // record that is no longer the one held for this id was replaced by a resume, whose
        // query took its model from its own `createSession`.
        const gone = (): boolean =>
          record.settling ||
          record.closed ||
          sessions.get(sessionId) !== record;
        /*
         * A request that fails *because the query went away* is the same answer as a
         * switch that arrived a moment later, not an uncertain one. The SDK rejects every
         * pending control request when a query closes (0.3.310's `Query.performCleanup`),
         * and `setModel` is answered in about a second, so an interrupt, a stream failure
         * or a single-turn session ending inside that second is not rare. Reported as a
         * plain transport failure, the caller would keep the row on the old model and the
         * next resume — which reads the row — would start on it. Whatever the CLI did with
         * the request, that query is not coming back.
         *
         * **The rejection can arrive before the record says so.** An interrupt or a turn
         * ending marks the record first and closes the query after, but a stream that
         * fails, or ends because the CLI exited, is closed by the SDK, which rejects the
         * pending requests before the pump sees the stream end: this fiber wakes while the
         * pump has not yet set `settling`. So a failed request waits, up to
         * `STREAM_END_GRACE`, for the pump to say the stream ended before `gone()` is read.
         * A timeout does not wait; see `STREAM_END_GRACE`.
         */
        const send = (
          operation: string,
          run: () => Promise<unknown>,
          refused: string,
        ): Effect.Effect<void, HarnessTransportError> =>
          control(operation, run, refused).pipe(
            Effect.catch((failure) =>
              (failure.tag === "TimeoutError"
                ? Effect.void
                : Effect.asVoid(
                    Effect.timeoutOption(
                      Deferred.await(record.ended),
                      STREAM_END_GRACE,
                    ),
                  )
              ).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    Effect.fail(
                      gone()
                        ? notLive(
                            `session ${sessionId}'s query closed while ${operation} was waiting on its answer`,
                          )
                        : failure,
                    ),
                  ),
                ),
              ),
            ),
          );
        // Read and written only under the permit: see `SessionRecord.switching`. The checks
        // are inside it too, because a switch that waited may find the session closed, or
        // launched, by the one it waited behind.
        return yield* Semaphore.withPermit(
          record.switching,
          Effect.gen(function* () {
            if (gone()) {
              return yield* notLive(
                `this process holds no live session ${sessionId}, so there is no query to switch`,
              );
            }
            const effort = claudeCodeEffortOf(options);
            const live = record.query;
            if (live === undefined) {
              record.model = model;
              record.effort = effort;
              return;
            }
            const unsettled = record.switchUnsettled;
            const modelChanged = unsettled || record.model !== model;
            if (!modelChanged && record.effort === effort) return;
            // Set before the first request and cleared after the last, so any failure
            // between them — including a timeout, where the CLI may have taken the change
            // anyway — leaves the next call unable to skip on the strength of a stale record.
            record.switchUnsettled = true;
            if (modelChanged) {
              yield* send(
                "query.setModel",
                () => live.setModel(model),
                `the session would not move to model ${model}`,
              );
              record.model = model;
              // The window is the model's; until the new one answers, the meter shows no
              // percentage rather than the old model's.
              record.contextLimit = undefined;
              yield* readContextLimit(record, live);
            }
            yield* send(
              "query.applyFlagSettings",
              () => live.applyFlagSettings({ effortLevel: effort ?? null }),
              `the session would not take reasoning level ${effort ?? "default"}`,
            );
            record.effort = effort;
            record.switchUnsettled = false;
          }),
        );
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
      )(function* (sessionId, text, delivery = OPEN_PROMPT, attachments = []) {
        const record = yield* recordFor("session.prompt", sessionId);
        // Read before any state is touched, so an unreadable file sends nothing.
        const content = yield* userContent(text, attachments);
        if (delivery._tag === "open") {
          // Ended before it was ever prompted: launching would start a CLI for a session
          // whose authority is already over.
          if (record.closed) {
            return yield* transport(
              "session.prompt",
              `session ${sessionId} has been ended; nothing was started`,
              { tag: SESSION_NOT_FOUND_TAG, status: 404 },
            );
          }
          if (record.query !== undefined) {
            return yield* transport(
              "session.prompt",
              `session ${sessionId} has already been prompted; carrying work on means a new attempt identity`,
            );
          }
          yield* launch(record, content);
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
         * `closeSession` live, could interleave between the check and the claim on
         * `unanswered` that stops the pump settling. The outcome would be a steer reported
         * `delivered: true` into a query that is closing: on this driver the message is
         * dropped rather than becoming unsupervised work, so the harm is a lying receipt
         * rather than a rogue execution, but the comment stated the window was closed and
         * it was open.
         *
         * `Deferred.isDoneUnsafe` is the synchronous read (`effect@4.0.5`'s
         * `Deferred.d.ts`), and `makeUnsafe` was already synchronous — so the whole of
         * "decide, claim, offer" is now one microtask. The `offer === undefined` guard moved
         * **above** it for a second reason: nothing may be added to `unanswered` on a path
         * that then refuses, or `waitForIdle` would wait for a turn nobody started.
         */
        if (Deferred.isDoneUnsafe(record.idle)) {
          record.idle = Deferred.makeUnsafe<void, HarnessFailure>();
        }
        record.deliveredIds.add(delivery.messageId);
        const uuid = claudeCodeMessageId(delivery.messageId);
        record.unanswered.add(uuid);
        record.untaken.set(uuid, delivery.messageId);
        offer(userMessage(record, content, uuid, delivery));
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
          /*
           * A turn is in flight exactly when one is open on the stream or a message this
           * session accepted has not been answered yet, which is what `waitForIdle`
           * already settles on (DECISIONS.md §24.1, consequence 4) rather than a second
           * notion of liveness. See `SessionRecord.unanswered`.
           *
           * **`record.outcome` is the *last completed* turn's**, set by the pump on every
           * `result`, so a steered session in its second turn holds the first turn's
           * answer while the second one runs. Suppressed here for that reason — the same
           * defect `Execution.Started` leaves on the OpenCode driver, reached from this
           * side by a mutable field rather than a column nobody clears. Nothing read this
           * across turns before worker attempts could be steered, which is why it had not
           * bitten.
           *
           * `closed` is checked too: a query that ended with messages still unanswered is
           * not running, and `unanswered` alone would say it was for ever.
           */
          const running = sessionRunning(record);
          return {
            activity: running ? "running" : "idle",
            outcome: running ? undefined : record.outcome,
            cost: record.cost,
            tokens: record.tokens,
            // Beside `activity`, never in it: see `SessionStatus.background`.
            background: backgroundRunning(record),
          };
        }
        /**
         * Not ours. The session is **not running** — that much is definite here — and
         * since `activity` exists, that is now something this seam can say.
         *
         * A Claude Code session is run by a CLI subprocess the SDK owns, and its live
         * `Query` handle — the open stream that control requests, stream input and close
         * all travel over — does not outlive the process that spawned it. The SDK offers
         * no re-attach to another process's query. So a session id this process does not
         * hold is a session that is not running, whatever the transcript on disk says.
         *
         * **The conversation does outlive it**, and that is a different claim from the
         * one above. The CLI's transcript is on disk, `getSessionMessages` reads it after
         * a restart, and a *fresh* `query({ options: { resume: id } })` continues it —
         * which {@link sessionContinuation} answers and S6 shipped.
         *
         * ## Why this used to fail, and what changed
         *
         * Reporting `{}` here was wrong, and a live crash-and-restart is what showed it:
         * recovery read `{}` as `running`, recorded `still_running`, left the row
         * `running` and bumped no fence, and nothing would ever refine it because the
         * transcript will never gain an outcome. So both branches were made to *fail*,
         * and the argument for that was sound at the time: with only an `outcome` field
         * in the seam there was no way to say "this session exists, nothing is running
         * it, and how its last turn ended is unknown" — `{}` implied `running` and
         * anything else would have invented an outcome. A refusal was the honest answer
         * available.
         *
         * `SessionActivity` is that missing sentence, and it changes the answer rather
         * than the reasoning. **A transcript this process holds now answers
         * `{ activity: "idle", outcome: undefined }`**, which `recovery/harnessStatus.ts`
         * reads as `abandoned`: the session is there, nothing is running it, nothing ever
         * recorded an outcome. That is `uncertain` for an attempt and a round — the same
         * disposition the refusal reached — but it is `uncertain` for the *stated* reason
         * rather than because we could not ask, and `abandoned` is the one answer a
         * continuation can be decided from (the design's S7.5). While the refusal stood,
         * nothing on this driver was ever continued after a restart.
         *
         * No `cost` and no `tokens`: both live on the {@link SessionRecord} this process
         * no longer has, and the transcript read here does not carry them. Absent is what
         * the seam means by "the harness does not know".
         *
         * **A session id the store has never heard of still fails**, with
         * {@link SESSION_NOT_FOUND_TAG} — `missing`, not `abandoned`. That distinction is
         * load-bearing in the other direction: `missing` says nothing about what the
         * session did, while `abandoned` asserts the conversation is still there. Nothing
         * is entitled to the second claim without having seen the transcript.
         *
         * A read that *throws* is still a failure — `unreachable`. "We could not look" is
         * not "it is not running".
         *
         * OpenCode reaches the same `abandoned` answer by a different route: its sessions
         * are rows in one SQLite file (`$XDG_DATA_HOME/opencode/opencode.db`), so a fresh
         * server finds an old session by primary key and reports it idle out of
         * `GET /api/session/active`. The two drivers now agree on what a restart looks
         * like, which they did not before.
         */
        const info = yield* Effect.tryPromise({
          try: () => sdk.sessionInfo(sessionId, {}),
          catch: (cause) =>
            transport(
              "session.get",
              `could not read the Claude Code session store: ${String(cause)}`,
            ),
        });
        if (info === undefined) {
          return yield* transport(
            "session.get",
            `the Claude Code session store holds no session ${sessionId}`,
            { tag: SESSION_NOT_FOUND_TAG, status: 404 },
          );
        }
        return {
          activity: "idle",
          outcome: undefined,
          cost: undefined,
          tokens: undefined,
        } satisfies SessionStatus;
      });

      /**
       * Whether the CLI still has this conversation to continue, read off its transcript.
       *
       * **Not {@link sessionStatus}**, which asks how the last turn ended and answers a
       * failure for every session this process does not hold. This asks the only question a
       * conversation needs and the transcript can answer precisely: is the chain there, and
       * where was it running.
       *
       * Three answers, from the two things `getSessionInfo` carries:
       *
       * - **No info at all** — the id is unknown to the session store. The CLI sweeps
       *   transcripts on `cleanupPeriodDays`, so for anything old enough this is the normal
       *   answer and there is nothing to wait for.
       * - **Info with no `firstPrompt`** — a metadata-only transcript, which is S2.5's
       *   nastiest case: a session killed before its first prompt was saved can be neither
       *   resumed (there is no chain to load) nor created again (the id is taken). The field
       *   is documented as "First meaningful user prompt in the session", so its absence is
       *   exactly that state, and the caller's only way on is a fresh session.
       * - **Info with a `firstPrompt`** — resumable, in `cwd`. The directory is reported
       *   rather than assumed because the caller has to gate it: see
       *   {@link SessionContinuation.directory}.
       *
       * A read that *fails* is a failure, not an answer: "we could not look" and "there is
       * nothing there" are different facts and a caller that conflated them would open a new
       * session every time the disk was busy.
       */
      const sessionContinuation: AgentHarness["Service"]["sessionContinuation"] =
        Effect.fn("claudeCodeHarness.sessionContinuation")(
          function* (sessionId) {
            const info = yield* Effect.tryPromise({
              try: () => sdk.sessionInfo(sessionId, {}),
              catch: (cause) =>
                transport(
                  "session.get",
                  `could not read the Claude Code session store: ${String(cause)}`,
                ),
            });
            if (info === undefined) {
              return {
                _tag: "unresumable",
                detail: `the Claude Code session store holds no transcript for session ${sessionId}; the CLI deletes them on its own retention schedule, so this is the ordinary answer for a conversation left for a while`,
              };
            }
            if (info.firstPrompt === undefined) {
              return {
                _tag: "unresumable",
                detail: `session ${sessionId} has a transcript with no first prompt in it, which is what a session killed before its opening message was saved leaves behind: there is no conversation to load, and the id cannot be created again either`,
              };
            }
            return {
              _tag: "resumable",
              directory: info.cwd,
              detail: `Claude Code still holds session ${sessionId}'s transcript on disk, so the conversation can be carried on`,
            };
          },
        );

      /**
       * What Claude Code calls a session: `customTitle`, and **never `summary`**.
       *
       * `SDKSessionInfo.summary` is documented as "custom title, auto-generated summary, or
       * first prompt", and the SDK builds it as a chain (`sdk.mjs`, 0.3.310): a `/rename`,
       * then the CLI's own `ai-title`, then the transcript's `last-prompt`, then a `summary`
       * entry, then the first prompt. `customTitle` is the first two of those — the SDK
       * folds `aiTitle` into it — and everything after them is a **prompt**. For every
       * session this server opens, a prompt is this server's framing: the importer's opener is
       * `assembleImporterPrompt`'s three kilobytes of rules with the operator's sentence at
       * the bottom, and a reconnected session's is `assembleImporterResumePrompt`'s.
       *
       * **And the framing cannot be trimmed back to the operator's words here**, which is the
       * reason this ignores the fallback rather than splitting it the way the replay does.
       * The SDK flattens every new line to a space and cuts the prompt at 200 characters
       * (`firstPrompt`); the CLI's `last-prompt` entry is cut at about 160. On this machine's
       * real importer transcripts it reads "You are reading the published scope of a bug
       * bounty program so that an operator can review it before any testing begins. The
       * engagement is called Acme Corp.  Th" — the delimiter `operatorTextOf` splits at is
       * two kilobytes further on and has been cut off, and its new lines would no longer
       * match if it had not. A `last-prompt` that *is* an operator's follow-up arrives the
       * same way, with nothing on it to tell it from framing. So the chain past
       * `customTitle` is unusable as a name, and a session without one is `untitled`.
       *
       * That costs little in practice: the CLI writes an `ai-title` after a session's first
       * turn in SDK mode too — every importer transcript on this machine has one ("Acme Corp
       * bug bounty scope review") — so `untitled` is a session that has barely spoken.
       *
       * `undefined` from the SDK is `forgotten`, for the reason {@link sessionContinuation}
       * gives. The SDK also answers `undefined` for a transcript with nothing to summarise,
       * which is a session with no conversation in it; it has no title either way.
       *
       * The directory is passed when this process holds the session, so the SDK reads one
       * project's folder rather than searching all of them; otherwise it searches.
       */
      const sessionTitle: AgentHarness["Service"]["sessionTitle"] = Effect.fn(
        "claudeCodeHarness.sessionTitle",
      )(function* (sessionId) {
        const directory = sessions.get(sessionId)?.directory;
        const info = yield* Effect.tryPromise({
          try: () =>
            sdk.sessionInfo(
              sessionId,
              directory === undefined ? {} : { dir: directory },
            ),
          catch: (cause) =>
            transport(
              "session.get",
              `could not read the Claude Code session store: ${String(cause)}`,
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: controlTimeout,
            orElse: () =>
              Effect.fail(
                transport(
                  "session.get",
                  `the Claude Code session store did not answer about session ${sessionId} in time`,
                ),
              ),
          }),
        );
        if (info === undefined) {
          return {
            _tag: "forgotten",
            detail: `the Claude Code session store holds no transcript for session ${sessionId}`,
          } satisfies SessionTitle;
        }
        const title = info.customTitle;
        return title === undefined || title.trim() === ""
          ? ({ _tag: "untitled" } satisfies SessionTitle)
          : ({ _tag: "titled", title } satisfies SessionTitle);
      });

      const messages: AgentHarness["Service"]["messages"] = Effect.fn(
        "claudeCodeHarness.messages",
      )(function* (sessionId, read) {
        const record = sessions.get(sessionId);
        const directory = record?.directory;
        /*
         * Each steer this session was delivered, by the UUID the CLI stores it under. The
         * derivation is one-way (`claudeCodeMessageId`), so the stored entry is named by
         * matching it against the ids this process delivered, which it holds only while it
         * holds the session.
         */
        const steers = new Map(
          [...(record?.deliveredIds ?? [])].map(
            (id) => [claudeCodeMessageId(id), id] as const,
          ),
        );
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
        return flattenTranscript(
          entries.filter((entry) => !isLocalCommandEntry(entry)),
          read?.uploadsFolder,
          steers,
        );
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
          /*
           * What a Stop has to reach, and with what — measured on 2.1.310 (A6 F5's fifth
           * review; bare SDK 0.3.310, `claude-haiku-4-5`, each task running
           * `sleep 25 && curl <listener>`, the call made 3 s after the parent turn's
           * `result`, so no turn was open):
           *
           * - A `run_in_background` **subagent**, `interrupt()`: `task_notification
           *   status=stopped` ~20 ms after the acknowledgement, its Bash dies with it and
           *   the curl never arrives. No `result` follows and no turn opens.
           * - The same subagent, `stopTask(id)`: stopped too, its own Bash with it — and the
           *   CLI then **opens a turn of its own** to tell the model so, which is more work
           *   started by a Stop. A subagent is stopped with `interrupt()`.
           * - A `run_in_background` **Bash shell**, `interrupt()`: acknowledged, and the
           *   shell runs on. It finished 25 s later, the curl arrived, and the CLI opened a
           *   turn for its notification. **`interrupt()` does not reach a shell.**
           * - The same shell, `stopTask(id)`: `task_notification status=stopped` within
           *   10 ms, no curl, no turn.
           *
           * So a Stop asks `interrupt()` — for the turn, if one runs, and every subagent —
           * then `stopTask` for every other task still listed. Task types not measured here
           * (a workflow, a monitor) are stopped the way a shell is, which is the documented
           * way to stop "a running task".
           */
          // A conversation between turns has no turn to stop, and setting `interrupted`
          // then would mark the *next* turn's `result` interrupted. A single-turn session
          // is never between turns while its query is open, so it is asked as it always
          // was. A turn the CLI started itself — a background task's notification — is a
          // turn, and is stopped like any other.
          const turn = !record.multiTurn || sessionRunning(record);
          if (!turn && !backgroundRunning(record)) return false;
          const stopping = [...record.tasks.keys()];
          // Set before asking, so a `result` arriving mid-interrupt is read as
          // `interrupted` rather than as the `error_during_execution` the SDK reports. A
          // multi-turn session's pump clears it again at that `result`. **Not set for
          // background work alone**: no `result` follows that interrupt (measured above),
          // so nothing would clear it before the operator's next turn. If the CLI opens a
          // turn of its own in the instant between this check and the interrupt reaching
          // it, that turn is stopped too and its `result` reads `failed`; the
          // conversation stays open either way.
          if (turn) record.interrupted = true;
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
              // Its own bound, not `controlTimeout`: see DEFAULT_INTERRUPT_TIMEOUT.
              interruptTimeout,
            ),
          );
          if (asked._tag === "Failure") {
            // Closed: a CLI that will not acknowledge an interrupt is one this process can
            // no longer steer, and a subprocess left behind by it is the one leak worth
            // paying a forced close for. Reported as the failure it is — `false` would say
            // nothing was running, which is the one thing this does not know.
            yield* endRecord(record);
            yield* Effect.logWarning(
              "a Claude Code session would not acknowledge an interrupt; its query was closed anyway",
              { sessionId, detail: String(asked.failure) },
            );
            return yield* transport(
              "session.interrupt",
              asked.failure._tag === "TimeoutError"
                ? "the session would not acknowledge an interrupt in time, so its query was closed"
                : `${asked.failure.detail}; its query was closed`,
            );
          }
          yield* stopTasks(record, stopping);
          /*
           * A single-turn session is over: its attempt or round ends here, so the query is
           * closed rather than left for the pump's `result`.
           *
           * **A conversation's query is kept open** (A6 F5), which is what lets the operator
           * stop a turn and carry on talking. Measured on 2.1.310 (`AgentHarness.
           * interruptSession`): the interrupted turn ends with its own `result`, a message
           * already queued behind it then runs as a turn of its own, and a later message is
           * answered normally. The interrupted turn's `result` names the message it was
           * answering, so nothing else here has to change.
           */
          if (!record.multiTurn) yield* closeSession(record);
          return turn ? true : "background";
        });

      /**
       * Stops what `interrupt()` left of the tasks listed when a Stop began, and waits,
       * bounded by {@link TASK_STOP_SETTLE_MILLIS}, for every one of them to say it is over.
       *
       * The tasks are asked **at once**, each bounded by {@link DEFAULT_TASK_STOP_TIMEOUT}
       * (`taskStopTimeout`), so one that never answers delays neither the others nor the
       * Stop beyond that bound: the whole of this takes at most `taskStopTimeout` plus the
       * settle.
       *
       * A subagent is not asked again: `interrupt()` stopped it, and a `stopTask` would
       * make the CLI open a turn about it (measured, at {@link interruptSession}). A
       * `stopTask` the CLI refuses or does not answer is logged and not acted on — the
       * session is still promptable, and the task, still listed, is reported by
       * `sessionStatus` as running rather than claimed stopped.
       */
      const stopTasks = (
        record: SessionRecord,
        stopping: readonly string[],
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (stopping.length === 0) return;
          const live = record.query;
          yield* Effect.forEach(
            stopping,
            (taskId) =>
              Effect.gen(function* () {
                const type = record.tasks.get(taskId)?.type;
                if (
                  type === undefined ||
                  type === "local_agent" ||
                  live === undefined
                ) {
                  return;
                }
                const stopped = yield* Effect.result(
                  Effect.timeout(
                    Effect.tryPromise(() => live.stopTask(taskId)),
                    taskStopTimeout,
                  ),
                );
                if (stopped._tag === "Failure" && record.tasks.has(taskId)) {
                  yield* Effect.logWarning(
                    "a Claude Code session would not stop a background task; it may still be running",
                    {
                      sessionId: record.sessionId,
                      taskId,
                      taskType: type,
                      detail: String(stopped.failure),
                    },
                  );
                }
              }),
            { concurrency: "unbounded", discard: true },
          );
          const settleBy = Date.now() + TASK_STOP_SETTLE_MILLIS;
          while (
            !record.closed &&
            stopping.some((taskId) => record.tasks.has(taskId)) &&
            Date.now() < settleBy
          ) {
            yield* Effect.sleep("10 millis");
          }
        });

      /*
       * The query is closed, then the CLI and its process group are stopped and waited for:
       * `Query.close()` alone ends the CLI's stdin and leaves it running for 2 s, which is
       * long enough to finish a tool call (A6 F5 review). The CLI goes, and every message
       * queued in it goes with it. Nothing is interrupted first, on purpose: an interrupt is
       * what makes the CLI go straight on to a queued message (measured;
       * `AgentHarness.interruptSession`).
       *
       * By the ref `createSession` returned, so a superseded opening's close ends its own
       * CLI and not the newer one now under the same id. See {@link handedOut}.
       */
      const endSession: AgentHarness["Service"]["endSession"] = Effect.fn(
        "claudeCodeHarness.endSession",
      )(function* (session) {
        const record = handedOut.get(session);
        if (record === undefined) return;
        yield* endRecord(record);
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
        switchModel,
        registerMcpServer,
        unregisterMcpServer,
        prompt,
        waitForIdle,
        sessionStatus,
        sessionContinuation,
        sessionTitle,
        messages,
        interruptSession,
        queuedOnInterrupt: "runs",
        // A queued message runs at once after an interrupt, so nothing is ever held.
        holding: () => Effect.succeed(false),
        endSession,
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
