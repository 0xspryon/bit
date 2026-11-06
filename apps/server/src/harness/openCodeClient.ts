/**
 * The OpenCode implementation of {@link AgentHarness}: a typed client over the OpenCode 2
 * HTTP API, plus the identity and the gate installer that go with it.
 *
 * This used to *be* the harness seam. It declared `OpenCodeClient` as the service the
 * supervisor required, and so OpenCode's vocabulary — a `{ providerID, id }` model pair, a
 * `ses_`-prefixed session id, a remote-MCP registration body with headers — was the
 * application's vocabulary too. A second harness moved the seam to
 * `harness/agentHarness.ts` and left this as one implementation of it. Nothing about the
 * wire changed; what changed is that none of the three shapes above is visible above this
 * file any more.
 *
 * Built on Effect's own `HttpClient` (`effect/http`), not on bare `fetch`. That is what
 * makes two properties true rather than aspirational:
 *
 * - **Cancellation reaches the socket.** `FetchHttpClient` passes the fiber's
 *   `AbortSignal` into `fetch`, so interrupting a client fiber — or letting a timeout
 *   interrupt it — aborts the in-flight request. Cancelling *our* request still says
 *   nothing about whether the harness stopped working; see `waitForIdle`.
 * - **The typed boundary is real.** Every response body is decoded through an Effect
 *   Schema. A 2xx answer in an unexpected shape is a typed {@link HarnessDecodeError}, not
 *   a cast that lies about what we have and dies somewhere downstream.
 *
 * **Routes and payload shapes are the generated client's, not ours.**
 * `@opencode/client/effect` is the Effect client OpenCode publishes from the same source
 * as the server, and it is what T3Code uses
 * (`packages/provider-opencode/src/server/v2/OpenCode2Client.ts:1-15`). The six routes
 * this service needs are `api.session.create`, `api.session.prompt`, `api.session.wait`,
 * `api.session.get`, `api.message.list` and `api.mcp.add`. Pinning a URL or re-deriving a
 * response shape is no longer our job, so it can no longer drift from the server we are
 * talking to.
 *
 * What stays ours is everything above the wire:
 *
 * - **The authenticated, bounded transport.** We build the `HttpClient` the generated
 *   client runs on, so the Basic credential, the base URL and the per-operation timeouts
 *   below apply to every call it makes — including any we have not wrapped.
 * - **Our error taxonomy.** The client's failures are its own tagged errors; `fail` below
 *   collapses them into {@link HarnessTransportError} and {@link HarnessDecodeError},
 *   keeping "the transport broke" distinct from "the answer was not the shape we were
 *   promised". Callers and tests depend on that distinction.
 * - **The narrow surface.** Nine operations with domain-shaped results, not 200 routes.
 *
 * One dependency note, because it cost an afternoon to find: the package pins Effect
 * **exactly** (`@opencode/client@2.2.5` declares `effect: "4.0.6"` as a peer, and
 * `@opencode/schema@2.2.5` depends on it outright). Without intervention bun installs a
 * second copy of Effect, and Schema internals from two instances interleave and throw
 * (`s.startsWith is not a function` out of `SchemaAST`). The workspace therefore runs on
 * the client's own Effect, 4.0.6, and the root `package.json` pins
 * `overrides: { effect: "4.0.6" }` so one copy is resolved for the whole workspace.
 * Check that override on any Effect or client upgrade: the client follows the `opencode`
 * server's release (2.2.5), and its exact Effect pin moves with it.
 *
 * `POST /api/experimental/mcp/{server}` — `api.mcp.add` — is how our bearer credential
 * reaches the harness: in a request body, never in the server's argv and never in the
 * environment the agent's own shell commands inherit (DECISIONS.md §6 "credentials off
 * argv").
 */
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MODEL_OPTION_DEFAULT_CHOICE,
  type HarnessModelView,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
  type QuestionAnswers,
  type QuestionField,
  type QuestionKind,
  type QuestionSettlement,
  SUBAGENT_ERROR_MAX,
  SUBAGENT_LINE_MAX,
  SUBAGENT_LINES_KEPT,
  SUBAGENT_RESULT_MAX,
  type SubagentFailure,
  type SubagentToolLine,
} from "@bit/contracts";
import { OpenCode } from "@opencode/client/effect";
import type { Form } from "@opencode/schema/form";
import { Mcp } from "@opencode/schema/mcp";
import {
  ID as ModelID,
  VariantID as ModelVariantID,
} from "@opencode/schema/model";
import { ID as ProviderID } from "@opencode/schema/provider";
import { AbsolutePath } from "@opencode/schema/schema";
import { ID as SessionID, type Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import {
  Effect,
  Layer,
  Redacted,
  Result,
  Schema,
  Semaphore,
  Stream,
  type Duration,
} from "effect";
import { Filter } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { installOpenCodeGate } from "../policy/install";
import {
  AgentHarness,
  OPEN_PROMPT,
  SUBAGENT_DESCRIPTION_MAX,
  TerminalOutcome,
  capped,
  firstLine,
  newestSubagents,
  subagentDescription,
  toolInputLine,
  truncateNarration,
  truncateReply,
  type BlockChannel,
  type HarnessContextUsage,
  type HarnessNarration,
  type HarnessQuestion,
  type MessageEntry,
  type MessagePart,
  type NarrationDetail,
  type SessionRef,
  type SessionTitle,
  type SessionWindow,
  type SubagentState,
  type SubagentStatus,
} from "./agentHarness";
import {
  inlinesOnOpenCode,
  attachmentReader,
  withAttachmentLines,
  type AttachmentReader,
} from "./attachments";
import { isDerivedMessageId, openCodeMessageId } from "./messageId";
import {
  HarnessDecodeError,
  HarnessTransportError,
  QuestionNotPending,
} from "./errors";
import { QUESTION_DISMISSED_MESSAGE } from "./questions";
import {
  defaultInstanceIdForDriver,
  OPENCODE_DRIVER,
  type HarnessInstance,
  type ModelProvenance,
} from "./identity";
import {
  openCodeVersionSkew,
  resubscribing,
  subscribeOpenCodeEvents,
  type Resubscribed,
} from "./openCodeEvents";
import { OpenCodeServer } from "./openCodeServer";

/**
 * The two execution timestamps that say whether a recorded outcome is the *last* turn's.
 *
 * ## Why this is read outside the generated client
 *
 * `session_v2.idle_outcome` — the `outcome` field — is written by `projectIdle` **together
 * with `time_idle`**, and `Execution.Started` writes `time_busy` and clears neither. Both
 * verified against OpenCode's own projector (`core/src/session/projector.ts`), and its
 * schema states the consequence in as many words: *"Start of the most recent execution.
 * While it runs, `idle` still holds the previous execution's end."* So one comparison
 * answers the question exactly:
 *
 * - `idle >= busy` — the most recent execution recorded its own terminal. The outcome is
 *   that execution's and is current.
 * - `busy > idle`, or `idle` absent with `busy` set — the most recent execution recorded
 *   nothing. Any outcome on the row belongs to an **earlier** turn.
 *
 * The second case is what a restart leaves behind on turn two or later, and believing the
 * column there is what limited S7's continuation to conversations interrupted on their
 * *first* turn: the row read `succeeded`, so nothing looked half-finished, and the
 * interrupted turn was left alone.
 *
 * **`@opencode/schema@2.1.0`, pinned when this was written, did not declare `time.busy`**,
 * though the live server (2.2.5) sends it. 2.2.5's schema declares it (as a `DateTime`), so
 * this read could now move onto the generated decode; it stays as it is because it is
 * tested and right, and moving it is no part of the client upgrade. Effect Schema
 * strips excess properties, so a `busy` read off `api.session.get`'s decoded answer is
 * always `undefined` — the unknown-field read S7a warned against, and it would have
 * silently done nothing. Hence this: the same route, over the same authenticated
 * transport, decoded through a schema that declares the one field the pinned one is
 * missing. Nothing else is re-derived — `outcome`, `cost` and `tokens` still come from the
 * generated client's published decode — and the moment a pinned upgrade carries `busy`,
 * this can be deleted in favour of reading it there.
 *
 * Raw milliseconds rather than `DateTime`, because the only thing done with them is `>=`
 * against each other. They are OpenCode's own clock on both sides of the comparison.
 */
const ExecutionTimes = Schema.Struct({
  data: Schema.Struct({
    time: Schema.Struct({
      busy: Schema.optionalKey(Schema.Finite),
      idle: Schema.optionalKey(Schema.Finite),
    }),
  }),
});

/**
 * Whether a recorded outcome describes the session's most recent execution.
 *
 * Pure, and exported so the comparison can be tested without a server.
 *
 * **Absence believes the outcome**, in both directions, and that is the safe direction
 * rather than the convenient one. No `busy` at all means either a session that has never
 * executed — in which case there is no outcome to doubt — or a server that does not send
 * the field, in which case this is back to the behaviour before the fix: under-continuing
 * rather than prompting a model about work that may have finished.
 *
 * One edge, stated because it is a real inequality and not a rounding worry: `time_idle`
 * is written as `max(event.created, time_idle + 1)` so that every terminal advances the
 * column even inside one millisecond. A turn that *started* in the same millisecond its
 * predecessor terminalised therefore reads `idle >= busy` and its predecessor's outcome is
 * believed. The window is a millisecond or two and it errs towards under-continuing.
 */
export const outcomeIsLastTurns = (times: {
  readonly busy?: number | undefined;
  readonly idle?: number | undefined;
}): boolean =>
  times.busy === undefined
    ? true
    : times.idle !== undefined && times.idle >= times.busy;

/**
 * The model a worker runs on when nothing names one.
 *
 * `openai` here is OpenCode's OAuth-authenticated ChatGPT subscription provider, which the
 * spawned server reads from the user's own stored credentials. No API key is read, passed
 * or held by this process (DECISIONS.md §12).
 *
 * Verified on 2026-10-19 against opencode v2.0.32, and again on 2026-10-24 against v2.1.2:
 * `gpt-5.6-sol` and `gpt-6-astra` complete; `gpt-5.5` and `gpt-5.3-codex-spark` are
 * refused by the provider with "not supported when using Codex with a ChatGPT account", so
 * model availability is narrower than the catalogue suggests.
 *
 * Written in OpenCode's own `provider/model` form, which is the form its configuration
 * files use, so that one string is the whole of what a caller has to name — the harness
 * splits it for the wire and for provenance (see {@link openCodeModelProvenance}).
 */
export const OPENCODE_DEFAULT_MODEL = "openai/gpt-5.6-sol";

/**
 * Splits OpenCode's `provider/model` into the two columns an attempt row records.
 *
 * On the first slash, not the last: a model id may contain slashes and a provider id may
 * not. A string with no slash has no provider to name, and `unknown` is recorded rather
 * than an empty string, because an empty provider column reads as a bug and this is a
 * configuration mistake with a name.
 */
export const openCodeModelProvenance = (model: string): ModelProvenance => {
  const slash = model.indexOf("/");
  return slash === -1
    ? { providerId: "unknown", modelId: model }
    : { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

/**
 * The option id a run carries for OpenCode's reasoning choice: OpenCode's own word.
 *
 * `variant` and not `reasoningEffort`, because that is what the API field is called
 * (`Model.Ref.variant`) and the id a selection names is the harness's rather than ours —
 * see `@bit/contracts`'s `modelOption.ts`. The value is a variant id and nothing else:
 * OpenCode keeps the settings overlay server-side and merges it per request
 * (`core/src/model-resolver.ts`'s `withVariant`), so sending the overlay would be sending
 * it the thing it is about to look up.
 */
export const OPENCODE_VARIANT_OPTION = "variant";

/**
 * What the picker shows for each variant id.
 *
 * OpenCode's own composer labels a variant with its raw id, and the ids are minted from
 * provider *reasoning* support (`core/src/variant.ts` builds them out of
 * `ConfigProvider.Reasoning`: the effort ladder, or a `none`/`thinking` toggle), which is
 * what makes "Reasoning" an honest label for the descriptor rather than an interpretation.
 *
 * An id this map does not know is shown **verbatim**. A provider that mints a variant for
 * something other than reasoning would therefore read as itself rather than being dressed
 * up as a level — and that is the signal to revisit the descriptor's label, not something
 * to paper over here.
 */
const OPENCODE_VARIANT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  thinking: "Thinking",
};

/**
 * What a model's `limit` is, as much of it as this file reads.
 *
 * Declared rather than inlined because two different numbers are taken out of it and they
 * are taken from **different fields on purpose** — see {@link openCodeModelView} and
 * {@link openCodeCompactionAt}.
 */
export interface OpenCodeModelLimit {
  readonly context: number;
  readonly input?: number | undefined;
}

/**
 * Share of the window OpenCode keeps free before it compacts, and the floor under it.
 *
 * `RESERVE_SHARE` and `RESERVE_MIN` from `opencode` 2.2.2's
 * `packages/core/src/session/compaction.ts` (lines 95 and 101). Copied rather than guessed,
 * and copied **with** the file and line so the next reader can check whether they still
 * hold — these are the two numbers an upgrade can move under us.
 */
const OPENCODE_RESERVE_SHARE = 0.15;
const OPENCODE_RESERVE_MIN = 16_000;

/**
 * Where OpenCode will summarise a session of this model on its own, by its own default.
 *
 * **This is the number the meter needs so that it does not imply nothing happens before the
 * window fills.** bit never calls compaction; OpenCode compacts anyway. Its
 * `SessionCompaction` state starts `{ auto: true }` (`compaction.ts:200`) and the only thing
 * that turns it off is a `compaction.auto` config key, which bit never writes — the gate
 * install writes a plugin registration into `.opencode/opencode.json` and nothing else. So
 * on bit's own default model, `openai/gpt-5.6-sol` (400 000 context, 272 000 input), the
 * harness rewrites the session at about 231 200 tokens: **58 % of the figure the meter
 * divides by.**
 *
 * The expression is `calculateCeiling`'s (`compaction.ts:849`), reproduced:
 * `(limit.input || limit.context) − max(15 % of it, 16 000)`. Three details are the
 * harness's rather than our preference, and each is kept:
 *
 * - **`||`, not `??`.** OpenCode reports an unknown limit as `0`, and `||` is what makes a
 *   zero `input` fall back to the context window. `??` would divide by the zero.
 * - **`RESERVE_MIN` only applies to a window at least twice its size**, so a small window
 *   gives up the share instead of being floored to nothing.
 * - **A window of zero never triggers compaction at all** — OpenCode returns an infinite
 *   ceiling there — which is `undefined` here, because "it will never act" and "it will act
 *   at a number we can show" are different answers and only one of them is a number.
 *
 * `buffer` is deliberately not a parameter. A config may set `compaction.buffer` and replace
 * the whole reserve calculation, and `HarnessModelView.compactionAt` says so: this is an
 * estimate of the harness's default threshold, and a configuration at or above the session's
 * directory can move it without moving this.
 *
 * Exported for its test, which is the honest reason: the two constants above and the
 * `input`-before-`context` precedence are exactly what an `opencode` upgrade breaks
 * silently, and a direct test is what notices.
 *
 * V2(chat): compaction is left to each harness's own automatic default. Both compact by
 * default and bit disables neither, but nothing detects a configuration that turns it off
 * (an `opencode.json` in an ancestor directory, the user's Claude Code settings), and
 * nothing warns when a model switch lands on a model whose window the current context
 * will not fit. Proper V2: read the effective compaction policy per session, and warn —
 * or refuse — a switch to a smaller window before it is made.
 */
export const openCodeCompactionAt = (
  limit: OpenCodeModelLimit,
): number | undefined => {
  // OpenCode's own `||`: an unknown limit is reported as 0 and must fall through to the
  // context window rather than being taken as a window of nothing.
  const window =
    limit.input === undefined ? limit.context : limit.input || limit.context;
  if (window <= 0) return undefined;
  const reserve = Math.max(
    Math.floor(window * OPENCODE_RESERVE_SHARE),
    window >= 2 * OPENCODE_RESERVE_MIN ? OPENCODE_RESERVE_MIN : 0,
  );
  return window - reserve;
};

/**
 * One model's catalogue entry, as the picker reads it.
 *
 * A model with no variants gets no descriptor at all rather than a descriptor with one
 * choice: "this model offers nothing to choose" and "this model offers only its default"
 * are the same fact, and the second spelling would put an inert control on the screen.
 *
 * **Two numbers come out of one `limit`, from two different fields, and that is the point.**
 * The window the meter is a fraction of is `limit.context` — what the provider accepts, and
 * what OpenCode's own TUI meter divides by. The point at which the harness rewrites the
 * session is derived from `limit.input` where there is one ({@link openCodeCompactionAt}).
 * Taking either from the other field would be a different claim: `limit.input` as the
 * denominator reads high, and `limit.context` as the compaction base puts the threshold
 * where OpenCode will not act.
 */
const openCodeModelView = (
  id: string,
  variants: readonly { readonly id: string }[],
  limitOf: OpenCodeModelLimit | undefined,
): HarnessModelView => {
  const compactionAt =
    limitOf === undefined ? undefined : openCodeCompactionAt(limitOf);
  const limit =
    limitOf === undefined
      ? {}
      : {
          contextLimit: limitOf.context,
          ...(compactionAt === undefined ? {} : { compactionAt }),
        };
  if (variants.length === 0) return { id, ...limit };
  const descriptor: ModelOptionDescriptor = {
    id: OPENCODE_VARIANT_OPTION,
    label: "Reasoning",
    type: "select",
    options: [
      // The way back to the model's own behaviour, and OpenCode's own spelling for it:
      // `withVariant` reads `"default"` as "no variant" (`core/src/model-resolver.ts`).
      { id: MODEL_OPTION_DEFAULT_CHOICE, label: "Default", isDefault: true },
      ...variants.map((variant) => ({
        id: variant.id,
        label: OPENCODE_VARIANT_LABELS[variant.id] ?? variant.id,
      })),
    ],
  };
  return { id, optionDescriptors: [descriptor], ...limit };
};

/**
 * The variant a session should be created on, from the resolved selections.
 *
 * Returns nothing for the default choice rather than passing it through. OpenCode would
 * accept `"default"` and read it as "no variant", but a request that names no variant is
 * the honest expression of "the operator did not pin one", and it is also what keeps the
 * session's stored `ModelRef` free of a value an operator never chose.
 */
const openCodeVariantOf = (
  options: readonly ModelOptionSelection[] | undefined,
): { variant?: typeof ModelVariantID.Type } => {
  const value = options?.find(
    (option) => option.id === OPENCODE_VARIANT_OPTION,
  )?.value;
  return value === undefined || value === MODEL_OPTION_DEFAULT_CHOICE
    ? {}
    : // Branded here rather than cast, like every other id this client puts on the wire:
      // whatever validation the brand carries now or later actually runs, and a bad value
      // fails with the value in the message instead of inside a request body.
      { variant: Schema.decodeUnknownSync(ModelVariantID)(value) };
};

/**
 * The three log entries that state an outcome, mapped to this application's vocabulary.
 *
 * A table rather than string surgery on the entry type, so adding a fourth is a change
 * here and a `session.execution.something_else` we have not met stays `undefined` — which
 * is the honest answer, and leaves the consumer reconciling against the harness's own
 * session state instead of guessing from a name.
 */
const EXECUTION_OUTCOMES: Readonly<Record<string, TerminalOutcome>> = {
  "session.execution.succeeded": "succeeded",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
};

/**
 * The session an event belongs to, or `undefined` if it names none.
 *
 * Two fields are read because the harness provides both and they agree: every `session.*`
 * event in `@opencode/schema`'s manifest carries `data.sessionID`, and every event carries
 * `durable.aggregateID`, which for a session event is that same id. Reading the first and
 * falling back to the second costs nothing and means a build that stops populating one of
 * them is a dropped event rather than a misattributed one.
 *
 * `undefined` is returned rather than a guess for anything that names no session — the
 * stream also carries `server.connected`, `provider.updated`, `mcp.status.changed` and a
 * dozen other process-wide events, none of which belong to anybody's run.
 */
const sessionOf = (event: unknown): string | undefined => {
  const record = (event ?? {}) as {
    data?:
      | { sessionID?: unknown; form?: { sessionID?: unknown } | undefined }
      | undefined;
    durable?: { aggregateID?: unknown } | undefined;
  };
  const fromData = record.data?.sessionID;
  if (typeof fromData === "string") return fromData;
  // `form.created` names its session inside the form it carries (A7-Q); the other two form
  // events name it beside the form's id, as a session event does.
  const fromForm = record.data?.form?.sessionID;
  if (typeof fromForm === "string") return fromForm;
  const fromDurable = record.durable?.aggregateID;
  return typeof fromDurable === "string" ? fromDurable : undefined;
};

/**
 * One `{ type: "text", text }` / `{ type: "file", uri }` list, as one string.
 *
 * `session.tool.success` carries its output as that union
 * (`@opencode/protocol@2.1.0`'s `event.d.ts`), and a file part has no text to show — so it
 * is named by its uri rather than dropped, because "the tool answered with a file" and
 * "the tool answered with nothing" are different results.
 */
const partsText = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = (part ?? {}) as {
        type?: unknown;
        text?: unknown;
        uri?: unknown;
      };
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "file" && typeof record.uri === "string") {
        return `[file ${record.uri}]`;
      }
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
};

/** `JSON.stringify` that answers with something for a value it cannot serialise. */
const asJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // A cyclic or non-serialisable argument object. The call still happened and still has
    // to appear, so it appears with its arguments unavailable rather than not at all.
    return "";
  }
};

/**
 * One OpenCode text or reasoning block's id, from any of its events: `started`, a `delta`
 * or `ended`. `undefined` for an event missing either half, whose block cannot be named.
 *
 * The channel is part of it because OpenCode counts the `ordinal` separately for text and
 * for reasoning in one assistant message — the first thinking block and the first reply
 * are both ordinal 0. See {@link openCodeNarration}.
 */
export const openCodeBlockId = (
  channel: BlockChannel,
  data: Record<string, unknown>,
): string | undefined => {
  const message = data["assistantMessageID"];
  const ordinal = data["ordinal"];
  return typeof message === "string" &&
    typeof ordinal === "number" &&
    Number.isInteger(ordinal)
    ? `${message}:${channel === "reply" ? "text" : "reasoning"}:${String(ordinal)}`
    : undefined;
};

/** A text or reasoning delta as a {@link BlockDelta}, or `opaque` if it names no block. */
const blockDelta = (
  channel: BlockChannel,
  data: Record<string, unknown>,
): NarrationDetail => {
  const key = blockKey(channel, data);
  const text = data["delta"];
  return key.blockId === undefined || typeof text !== "string"
    ? { _tag: "opaque" }
    : { _tag: "delta", blockId: key.blockId, call: key.call, channel, text };
};

/**
 * `blockId`, and the call it is a block of — the `assistantMessageID` it is made from, on
 * its own (A6 U5 review) — as keys to spread, absent when the block cannot be named.
 */
const blockKey = (
  channel: BlockChannel,
  data: Record<string, unknown>,
): { readonly blockId?: string; readonly call?: string } => {
  const blockId = openCodeBlockId(channel, data);
  const call = data["assistantMessageID"];
  return blockId === undefined || typeof call !== "string"
    ? {}
    : { blockId, call };
};

/**
 * What this application reads one OpenCode event as.
 *
 * ## The tool name arrives on a different event from the arguments
 *
 * Verified against `@opencode/protocol@2.1.0`'s generated event union: a call is five
 * events, keyed by `data.id`, and only the first of them carries the tool's name.
 *
 * | event                        | `data` carries                        |
 * | ---------------------------- | ------------------------------------- |
 * | `session.tool.input.started` | `id`, **`name`**                      |
 * | `session.tool.input.delta`   | `id`, `delta`                         |
 * | `session.tool.input.ended`   | `id`, `text`                          |
 * | `session.tool.called`        | `id`, **`input`**, `executed`         |
 * | `session.tool.success`       | `id`, **`content`**, `metadata`       |
 * | `session.tool.failed`        | `id`, **`error`**, `content`          |
 *
 * So `names` is a join table for the length of one session's stream: the name is remembered
 * when it is seen and read when the arguments or the result arrive. It is **per stream**,
 * created by the caller, which is what keeps one run's tool names out of another's — and
 * entries are deleted when the call resolves, so the map is bounded by the calls in flight
 * rather than by the length of the run.
 *
 * A name that was never seen stays `undefined` and is carried as such. Guessing one from
 * the arguments, or reusing the last name seen, would put the wrong tool next to a real
 * set of arguments, which is worse than an unnamed call.
 *
 * ## A finished block comes from `ended`; its deltas only stream it
 *
 * `session.text.ended` carries the whole block once (`data.text`), so the `reply` is taken
 * from there: one entry per block, with no reassembly to get wrong. `session.text.delta`
 * — one event per ~100 ms batch of tokens, which OpenCode itself coalesces — is a
 * {@link BlockDelta} (A6 F7): a piece of the block while it is being written, which the
 * importer and goal conversations coalesce into live partials
 * (`run/streamingCoalescer.ts`) and the worker and planner supervisors keep off the
 * narration bus (`narratesOnSharedBus`). Neither reads a delta for the outcome: that is on
 * `session.execution.*`, and a delta carries none.
 *
 * Verified against `@opencode/protocol@2.1.0`'s event union and the 2.2.5 server's
 * publisher (`packages/core/src/session/runner/publish-llm-event.ts`): no event of a
 * block carries a part id. A block is named by **`assistantMessageID` and `ordinal`**,
 * which `started`, every `delta` and `ended` all carry — and the ordinal is counted
 * **separately** for text and for reasoning within one message, both from 0. So the
 * `blockId` is {@link openCodeBlockId}: the message, the channel and the ordinal, the same
 * on every event of the block, which is what lets the finished block replace its partials.
 * Its uniqueness rests on one 2.2.5 behaviour: a retried step (`Retry`, `RecoverFull`, an
 * overflow `Compacted`) reuses the `assistantMessageID` and restarts the ordinals at 0, which
 * is safe only because those retries happen before any output has started
 * (`runner/step.ts`, `!outputStarted`) — an OpenCode upgrade must re-check this.
 * The publisher sends a block's last batched delta before its `ended`, on the one ordered
 * stream, so no delta follows its block's end.
 *
 * Reads defensively off an already-decoded value, for the same reason {@link flatten}
 * does: the entry union is wide and version-specific, and re-asserting a shape the
 * generated client has already validated would only add a second place for it to be wrong.
 *
 * ## Reasoning, and usage, come from the `ended` events too
 *
 * `session.reasoning.ended` carries the whole block as `data.text`, exactly as
 * `session.text.ended` does for a reply, so thinking is one entry per block, and
 * `session.reasoning.delta` streams it exactly as text deltas stream a reply.
 *
 * `session.step.ended` is the per-call usage, and **`session.usage.updated` is not**: the
 * two fire in the same millisecond with the same field shape, and the second is a session
 * lifetime total that re-counts the cached prefix on every call — 65 838 against a real
 * context of 13 753, measured (DECISIONS.md §24.4). It is also ephemeral, so a stream that
 * reconnects loses it silently, where `step.ended` has a `durable.seq`. It stays `opaque`.
 *
 * **Exported for the tests, and that is the honest reason.** Driving this through
 * `sessionEvents` would mean stubbing an SSE transport to assert a mapping that has nothing
 * to do with transport — and the five-event tool sequence above is the part most likely to
 * be wrong on an `opencode` upgrade, so it is the part that wants a direct test.
 */
export const openCodeNarration = (
  entry: unknown,
  names: Map<string, string>,
  /**
   * What the model this session was created on takes, when this process knows it.
   *
   * Passed in rather than read off the event, because no event carries either number: both
   * are properties of the *model* and arrive in the catalogue, before any session exists.
   * `undefined` for a session this process did not create — a recovery sweep's read of
   * somebody else's session — and a consumer then draws no percentage and no threshold.
   */
  window?: SessionWindow | undefined,
  /**
   * The model of each step this stream has seen open, by `assistantMessageID` (A6 F10), so a
   * block or call can say which model wrote it. `session.step.started` is the only event
   * that names the model; the blocks of that step carry only the message id. An entry is
   * dropped when its step ends or fails, which bounds this by the steps in flight. A block
   * of a step this stream joined after it started carries no model.
   */
  models: Map<string, string> = new Map(),
  /**
   * The sub-agents this stream has seen started (A6 U14), so a call's settling and a
   * background one's notice narrate as its state. See {@link OpenCodeSubagents}.
   */
  subagents: OpenCodeSubagents = openCodeSubagents(),
  /**
   * How this process settled the forms it answered or dismissed (A7-Q), by form id, so a
   * `form.cancelled` reads as the operator's dismissal and any other as a withdrawal. A
   * cancel event says nothing of who cancelled.
   */
  settledHere: ReadonlyMap<string, QuestionSettlement> = new Map(),
): HarnessNarration => {
  const record = (entry ?? {}) as {
    type?: unknown;
    created?: unknown;
    durable?: { seq?: unknown } | undefined;
    data?: Record<string, unknown> | undefined;
  };
  const type = typeof record.type === "string" ? record.type : "unknown";
  const sequence = record.durable?.seq;
  const data = record.data ?? {};
  const callId = typeof data["id"] === "string" ? data["id"] : undefined;
  const eventAt =
    typeof record.created === "number" ? record.created : Date.now();
  const step = data["assistantMessageID"];
  const stepModel = typeof step === "string" ? models.get(step) : undefined;
  const named = stepModel === undefined ? {} : { model: stepModel };

  const detail = ((): NarrationDetail => {
    switch (type) {
      case "session.step.started": {
        const model = modelRefName(data["model"]);
        if (typeof step === "string" && model !== undefined) {
          models.set(step, model);
        }
        return { _tag: "opaque" };
      }
      case "session.step.failed":
        if (typeof step === "string") models.delete(step);
        return { _tag: "opaque" };
      case "session.text.delta":
        return blockDelta("reply", data);
      case "session.reasoning.delta":
        return blockDelta("thinking", data);
      case "session.text.ended":
        return typeof data["text"] === "string"
          ? {
              _tag: "reply",
              text: truncateReply(data["text"]),
              ...blockKey("reply", data),
              ...named,
            }
          : { _tag: "opaque" };
      case "session.reasoning.ended":
        return typeof data["text"] === "string"
          ? {
              _tag: "thinking",
              text: truncateNarration(data["text"]),
              ...blockKey("thinking", data),
              ...named,
            }
          : { _tag: "opaque" };
      case "session.step.ended": {
        /*
         * One model call's figures, and the only per-call carrier on this driver.
         *
         * `assistantMessageID` is the call: it is what de-duplicates this entry and what a
         * reader keys the latest figure by. Without it there is nothing to attribute the
         * numbers to, so the entry is dropped rather than carried under an invented id.
         *
         * `input` is the **uncached** remainder and `cache.read` the cached prefix — they
         * are disjoint — so the prompt side is the sum of the three. `reasoning` is *not*
         * inside `output` on the provider measured (a call reported `output 14, reasoning
         * 57`), so they are added to mean "everything generated", which is what the field
         * means on the other driver too.
         */
        const callId = data["assistantMessageID"];
        if (typeof callId !== "string") return { _tag: "opaque" };
        models.delete(callId);
        const tokens = (data["tokens"] ?? {}) as {
          input?: unknown;
          output?: unknown;
          reasoning?: unknown;
          cache?: { read?: unknown; write?: unknown } | undefined;
        };
        const count = (value: unknown): number =>
          typeof value === "number" && Number.isFinite(value) ? value : 0;
        return {
          _tag: "usage",
          callId,
          promptTokens:
            count(tokens.input) +
            count(tokens.cache?.read) +
            count(tokens.cache?.write),
          outputTokens: count(tokens.output) + count(tokens.reasoning),
          contextLimit: window?.contextLimit,
          // The step's own model, from its `session.step.started`: a step running when a
          // switch lands finishes on the model it started on.
          model: stepModel,
          compactionAt: window?.compactionAt,
        };
      }
      case "session.tool.input.started": {
        if (callId !== undefined && typeof data["name"] === "string") {
          names.set(callId, data["name"]);
        }
        return { _tag: "opaque" };
      }
      case "session.tool.called": {
        if (callId === undefined) return { _tag: "opaque" };
        // A sub-agent: its entry, not its call (A6 U14).
        const subagent = openCodeSubagentCall(
          names.get(callId),
          data["input"],
          stepModel,
          eventAt,
        );
        if (subagent !== undefined) {
          subagents.calls.set(callId, subagent);
          return openCodeSubagentState(callId, subagent);
        }
        return {
          _tag: "toolCall",
          callId,
          tool: names.get(callId),
          input: truncateNarration(asJson(data["input"])),
          ...named,
        };
      }
      case "session.tool.success": {
        if (callId === undefined) return { _tag: "opaque" };
        const tool = names.get(callId);
        names.delete(callId);
        const subagent = subagents.calls.get(callId);
        if (subagent !== undefined) {
          return openCodeSubagentSettled(
            subagents,
            callId,
            subagent,
            {
              ok: true,
              metadata: data["metadata"],
              content: partsText(data["content"]),
            },
            eventAt,
          );
        }
        return {
          _tag: "toolResult",
          callId,
          tool,
          output: truncateNarration(partsText(data["content"])),
          failed: false,
        };
      }
      case "session.tool.failed": {
        if (callId === undefined) return { _tag: "opaque" };
        const tool = names.get(callId);
        names.delete(callId);
        const error = (data["error"] ?? {}) as { message?: unknown };
        const subagent = subagents.calls.get(callId);
        if (subagent !== undefined) {
          return openCodeSubagentSettled(
            subagents,
            callId,
            subagent,
            {
              ok: false,
              message: typeof error.message === "string" ? error.message : "",
              metadata: data["metadata"],
            },
            eventAt,
          );
        }
        const content = partsText(data["content"]);
        const message =
          typeof error.message === "string" ? error.message : "the tool failed";
        return {
          _tag: "toolResult",
          callId,
          tool,
          output: truncateNarration(
            content === "" ? message : `${message}\n${content}`,
          ),
          failed: true,
        };
      }
      case "session.inbox.delivered": {
        /*
         * A message taken off the session's inbox into its transcript (A6 U4): the steer
         * that was queued behind the work in flight is now being read. The inbox id is the
         * message id in OpenCode's space (`openCodeMessageId`), so the application's id is
         * that without its prefix; an id not in that shape is not one this server sent.
         */
        const inbox = data["inboxID"];
        const messageId =
          typeof inbox === "string" && inbox.startsWith("msg_")
            ? inbox.slice(4)
            : undefined;
        return messageId !== undefined && isDerivedMessageId(messageId)
          ? { _tag: "taken", messageIds: [messageId] }
          : { _tag: "opaque" };
      }
      case "session.execution.failed": {
        // The turn ended in the harness's own error — a provider refusing the call, say
        // ("Free usage limit reached") — and the sentence is the harness's (A6 U4).
        const error = (data["error"] ?? {}) as { message?: unknown };
        return typeof error.message === "string" && error.message.trim() !== ""
          ? { _tag: "error", message: truncateNarration(error.message) }
          : { _tag: "opaque" };
      }
      case "form.created": {
        // The agent asked the operator something (A7-Q). A form of any other kind is not a
        // question this build draws; see `openCodeQuestionOf`.
        const question = openCodeQuestionOf(data["form"]);
        return question === undefined
          ? { _tag: "opaque" }
          : { _tag: "question", question };
      }
      case "form.replied":
      case "form.cancelled": {
        const id = data["id"];
        if (typeof id !== "string") return { _tag: "opaque" };
        return {
          _tag: "questionSettled",
          questionId: id,
          settled:
            type === "form.replied"
              ? "answered"
              : settledHere.get(id) === "dismissed"
                ? "dismissed"
                : "withdrawn",
        };
      }
      case "session.tool.progress": {
        /*
         * A running tool's metadata, replaced as it goes (A7-S). For a `subagent` call it is
         * `{ sessionID, status: "running" }` the moment its child session exists (measured
         * on 2.2.5), which is what lets the child's own events be read for its card and the
         * child be interrupted on its own. Anything else stays `opaque`.
         */
        const subagent =
          callId === undefined ? undefined : subagents.calls.get(callId);
        const metadata = (data["metadata"] ?? {}) as { sessionID?: unknown };
        return subagent !== undefined &&
          callId !== undefined &&
          adoptChild(subagents, callId, subagent, metadata.sessionID)
          ? openCodeSubagentState(callId, subagent)
          : { _tag: "opaque" };
      }
      case "session.synthetic":
        // A background sub-agent's end; any other notice stays `opaque`, as it was.
        return (
          openCodeSubagentNotice(
            subagents,
            data["metadata"],
            typeof data["text"] === "string" ? data["text"] : "",
            eventAt,
          ) ?? {
            _tag: "opaque",
          }
        );
      default:
        return { _tag: "opaque" };
    }
  })();

  return {
    type,
    sequence: typeof sequence === "number" ? sequence : undefined,
    at: typeof record.created === "number" ? record.created : 0,
    outcome: EXECUTION_OUTCOMES[type],
    detail,
  };
};

/**
 * A form as the question it asks, or `undefined` for a form that is not one (A7-Q).
 *
 * OpenCode 2.2.5's `question` tool asks through a form whose `metadata.kind` is
 * `"question"`, one field per question keyed `q0…qN`: a `string` field with the options
 * (choose one), or a `multiselect` (choose any), each with `custom: true`
 * (`core/src/tool/plugin/question.ts`, `toField`). Its field `title` is the question's
 * `header` and its `description` the question.
 *
 * V2(chat): only question forms are drawn. OpenCode also asks through forms for an MCP
 * server's elicitation and a provider's sign-in (`number`, `boolean`, `external` fields), and
 * such a form waits with nothing on bit's screen. Proper V2 maps every field type onto the
 * dock — a number as words checked against its bounds, a boolean as a choose-one, an
 * external link opened — or tells the operator the agent is waiting on something bit cannot
 * show.
 */
export const openCodeQuestionOf = (
  form: unknown,
): HarnessQuestion | undefined => {
  const info = (form ?? {}) as {
    id?: unknown;
    metadata?: { kind?: unknown; tool?: { id?: unknown } } | undefined;
    fields?: unknown;
  };
  if (typeof info.id !== "string" || info.metadata?.kind !== "question") {
    return undefined;
  }
  if (!Array.isArray(info.fields)) return undefined;
  const fields = info.fields.flatMap((value: unknown): QuestionField[] => {
    const field = (value ?? {}) as {
      key?: unknown;
      type?: unknown;
      title?: unknown;
      description?: unknown;
      required?: unknown;
      options?: unknown;
      custom?: unknown;
    };
    if (typeof field.key !== "string") return [];
    if (field.type !== "string" && field.type !== "multiselect") return [];
    const options = Array.isArray(field.options)
      ? field.options.flatMap((option: unknown) => {
          const entry = (option ?? {}) as {
            value?: unknown;
            label?: unknown;
            description?: unknown;
          };
          // The value is what goes back; the tool sets it to the label.
          return typeof entry.value === "string" && entry.value.trim() !== ""
            ? [
                {
                  label: entry.value,
                  description:
                    typeof entry.description === "string" &&
                    entry.description.trim() !== ""
                      ? entry.description
                      : null,
                },
              ]
            : [];
        })
      : [];
    const kind: QuestionKind =
      field.type === "multiselect"
        ? "any"
        : options.length === 0
          ? "text"
          : "one";
    const title =
      typeof field.title === "string" && field.title.trim() !== ""
        ? field.title.trim()
        : null;
    const question =
      typeof field.description === "string" && field.description.trim() !== ""
        ? field.description.trim()
        : (title ?? field.key);
    return [
      {
        key: field.key,
        header: title,
        question,
        kind,
        options,
        custom: kind === "text" || field.custom === true,
        required: field.required === true,
      },
    ];
  });
  const [first, ...rest] = fields;
  if (first === undefined) return undefined;
  const call = info.metadata.tool?.id;
  return {
    questionId: info.id,
    fields: [first, ...rest],
    askedAt: undefined,
    callId: typeof call === "string" ? call : undefined,
  };
};

/**
 * The operator's answers as an OpenCode form's answer: a choose-any field's as a list, any
 * other's as its one string (`Form.Value`), a skipped one left out.
 */
export const openCodeFormAnswer = (
  question: HarnessQuestion,
  answers: QuestionAnswers,
): Form.Answer =>
  Object.fromEntries(
    question.fields.flatMap((field): [string, string | string[]][] => {
      const given = answers[field.key] ?? [];
      if (given.length === 0) return [];
      return [
        [field.key, field.kind === "any" ? [...given] : (given[0] ?? "")],
      ];
    }),
  );

/**
 * A change in the event stream's connection as a narration entry (U13 review 5): no
 * sequence, no outcome, `at` this process's clock, since no harness event carries it.
 * Exported for the tests.
 */
export const connectionNarration = (
  item: Extract<Resubscribed, { _tag: "connection" }>,
  at: number,
): HarnessNarration => ({
  type: `bit.connection.${item.state}`,
  sequence: undefined,
  at,
  outcome: undefined,
  detail: { _tag: "connection", state: item.state, reason: item.reason },
});

/** A `Model.Ref` (`{ id, providerID }`) as the `provider/model` this build names it by. */
const modelRefName = (value: unknown): string | undefined => {
  const ref = (value ?? {}) as { id?: unknown; providerID?: unknown };
  return typeof ref.id === "string" && typeof ref.providerID === "string"
    ? `${ref.providerID}/${ref.id}`
    : undefined;
};

/**
 * Epoch milliseconds from a time the client decoded: `@opencode/schema` declares message
 * times as `DateTimeUtcFromMillis`, so a decoded one is a `DateTime.Utc`
 * (`epochMilliseconds`); a raw number is taken as it is.
 */
const millisOf = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  const millis = (value as { epochMilliseconds?: unknown } | null | undefined)
    ?.epochMilliseconds;
  return typeof millis === "number" && Number.isFinite(millis)
    ? millis
    : value instanceof Date
      ? value.getTime()
      : undefined;
};

/**
 * OpenCode's sub-agent tools: `subagent`, and `task`, its name before 2.2 renamed it
 * (`database/v1-migration.bun.ts`'s `RENAMED_TOOLS`). A tool from an MCP server is
 * namespaced (`bit-<id>.…`), so neither name can be somebody else's.
 */
const OPENCODE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "subagent",
  "task",
]);

/**
 * One sub-agent call, as this stream or read has seen it so far (A6 U14; A7-S): what the
 * call said about itself, its child session, and what the child's own events have said
 * since. Mutable, and snapshotted as a {@link SubagentState} each time it changes.
 */
interface OpenCodeSubagentCall {
  readonly tool: string;
  readonly agentType: string | null;
  readonly description: string;
  readonly task: string;
  readonly model: string | undefined;
  /** The call returned at once (`background: true`, or its result said `running`). */
  background: boolean;
  /** Its child session, from the parent's `session.tool.progress` or its result's metadata. */
  child: string | undefined;
  status: SubagentStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** The tool calls its child has made, counted from its events or messages. */
  seen: number;
  /** Its child's last {@link SUBAGENT_LINES_KEPT} tool calls, with their call ids. */
  lines: { id: string; line: SubagentToolLine }[];
  /** The child's tool names by call id, until the call settles (as `names` is for a session). */
  readonly names: Map<string, string>;
  /** Its child's newest thought's or sentence's first line, while it runs. */
  activity: string | null;
  /** Its child's newest reply: what it returns. */
  lastText: string | null;
  result: string | null;
  failure: SubagentFailure | null;
}

/**
 * The sub-agents one stream or one read has seen (A6 U14): each call by its id, and each
 * child session by its id, which is all a child's events and OpenCode's completion notice
 * name. Created per stream and per read, like the tool-name map, and bounded by the
 * sub-agent calls a session makes.
 */
export interface OpenCodeSubagents {
  readonly calls: Map<string, OpenCodeSubagentCall>;
  readonly children: Map<string, string>;
  /**
   * For a read: whether this process holds the session, which is what says a running
   * sub-agent can be stopped from here. A stream is always live.
   */
  readonly live?: boolean;
}

export const openCodeSubagents = (live?: boolean): OpenCodeSubagents => ({
  calls: new Map(),
  children: new Map(),
  ...(live === undefined ? {} : { live }),
});

/**
 * A `subagent` call's input as the call it is (`tool/plugin/subagent.ts`: `agent`,
 * `description`, `prompt`, `background`; `subagent_type` from before 2.2), or `undefined`
 * for any other tool.
 */
const openCodeSubagentCall = (
  tool: string | undefined,
  input: unknown,
  model: string | undefined,
  at: number | null,
): OpenCodeSubagentCall | undefined => {
  if (tool === undefined || !OPENCODE_SUBAGENT_TOOLS.has(tool))
    return undefined;
  const fields = (input ?? {}) as {
    agent?: unknown;
    subagent_type?: unknown;
    description?: unknown;
    prompt?: unknown;
    background?: unknown;
    sessionID?: unknown;
  };
  const agent =
    typeof fields.agent === "string" && fields.agent.trim() !== ""
      ? fields.agent
      : fields.subagent_type;
  return {
    tool,
    agentType:
      typeof agent === "string" && agent.trim() !== ""
        ? subagentDescription(agent, undefined)
        : null,
    description: subagentDescription(fields.description, fields.prompt),
    task:
      typeof fields.prompt === "string"
        ? firstLine(fields.prompt, SUBAGENT_DESCRIPTION_MAX)
        : "",
    model,
    background: fields.background === true,
    child: undefined,
    status: "running",
    startedAt: at,
    endedAt: null,
    seen: 0,
    lines: [],
    names: new Map(),
    activity: null,
    lastText: null,
    result: null,
    failure: null,
  };
};

/**
 * The state of a sub-agent call as its card draws it. A running one whose child session is
 * known can be stopped on its own (`session.interrupt` of the child, measured in A7-S Step 0
 * for foreground and background alike), from a stream or a read of a session this process
 * holds (`live`).
 */
const openCodeSubagentState = (
  callId: string,
  call: OpenCodeSubagentCall,
  live = true,
): SubagentState => ({
  _tag: "subagent",
  callId,
  tool: call.tool,
  agentType: call.agentType,
  description: call.description,
  task: call.task,
  background: call.background,
  status: call.status,
  startedAt: call.startedAt,
  endedAt: call.endedAt,
  calls: call.seen > 0 || call.child !== undefined ? call.seen : null,
  lines: call.lines.map((each) => each.line),
  activity: call.status === "running" ? call.activity : null,
  result: call.status === "finished" ? call.result : null,
  failure: call.status === "failed" ? call.failure : null,
  stop:
    call.status === "running" && call.child !== undefined && live
      ? "own"
      : "none",
  ...(call.model === undefined ? {} : { model: call.model }),
});

/**
 * Remembers a call's child session, under both maps.
 *
 * V2(chat): a `subagent` call that continues an existing child (`sessionID` in its input,
 * "send a follow-up to an existing subagent, running or finished") takes the child's
 * events over from the call that started it, so the earlier card stops moving. Once the
 * earlier call has ended that is right — the follow-up is a new card for new work — but a
 * follow-up steered into a **running** background child joins the same job, and the
 * earlier card then stays `running` until a replay reads the child's `idle` marker. V2 could
 * keep every call per child and move each, or draw a follow-up as part of its first card.
 * The default `general`/`explore` agents can send follow-ups; none was seen in A7-S.
 */
const adoptChild = (
  subagents: OpenCodeSubagents,
  callId: string,
  call: OpenCodeSubagentCall,
  child: unknown,
): boolean => {
  if (typeof child !== "string" || call.child === child) return false;
  call.child = child;
  subagents.children.set(child, callId);
  return true;
};

/** Ends a sub-agent: its status, when, and the activity it no longer has. */
const endOpenCodeSubagent = (
  call: OpenCodeSubagentCall,
  status: SubagentStatus,
  at: number | null,
): void => {
  call.status = status;
  call.endedAt = at;
  call.activity = null;
  call.lines = call.lines.map((each) =>
    each.line.result === null && status !== "finished"
      ? { ...each, line: { ...each.line, result: "stopped", failed: true } }
      : each,
  );
};

/**
 * What a sub-agent returned, out of the text OpenCode hands its parent: the `<subagent
 * sessionID=… state=…>` wrapper (`tool/plugin/subagent.ts`, `subagent-completion.ts`) taken
 * off, or the text as it stands.
 */
const subagentReturned = (text: string): string => {
  const match = /^\s*<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/.exec(
    text,
  );
  return (match?.[1] ?? text).trim();
};

/**
 * A settled `subagent` call as its state, from the tool's own result (`{ sessionID, status }`
 * metadata, content): `running` there is a **background** launch — the call returned at once
 * and the child session goes on, so nothing ends yet and the child is remembered for what
 * ends it; anything else is `finished`, quoting what it returned. A failed call is `failed`
 * with the harness's error, or `stopped` when OpenCode says it was cancelled.
 */
const openCodeSubagentSettled = (
  subagents: OpenCodeSubagents,
  callId: string,
  call: OpenCodeSubagentCall,
  settled:
    | {
        readonly ok: true;
        readonly metadata: unknown;
        readonly content: string;
      }
    | {
        readonly ok: false;
        readonly message: string;
        readonly metadata: unknown;
      },
  at: number | null,
  live = true,
): SubagentState => {
  const metadata = (settled.metadata ?? {}) as {
    sessionID?: unknown;
    status?: unknown;
  };
  adoptChild(subagents, callId, call, metadata.sessionID);
  if (!settled.ok) {
    if (settled.message.startsWith("Subagent cancelled")) {
      endOpenCodeSubagent(call, "stopped", at);
    } else {
      call.failure = {
        reason: "The sub-agent call failed",
        error: capped(
          settled.message === "" ? "OpenCode gave no reason." : settled.message,
          SUBAGENT_ERROR_MAX,
        ),
      };
      endOpenCodeSubagent(call, "failed", at);
    }
    return openCodeSubagentState(callId, call, live);
  }
  if (metadata.status === "running") {
    call.background = true;
    return openCodeSubagentState(callId, call, live);
  }
  const returned = subagentReturned(settled.content);
  call.result = capped(
    returned === "" ? (call.lastText ?? "") : returned,
    SUBAGENT_RESULT_MAX,
  );
  endOpenCodeSubagent(call, "finished", at);
  return openCodeSubagentState(callId, call, live);
};

/**
 * A background sub-agent's end, from the `synthetic` notice OpenCode adds to the parent
 * when its child session ends (`session/subagent-completion.ts`: metadata
 * `{ source: "subagent", childID, state }`, `state` `completed`, `error` or `cancelled`, and
 * the child's words in its text), or `undefined` when the notice is not one, or names a
 * child this stream or read did not see launched.
 *
 * Read on a **replay**. Live, OpenCode 2.2.5 sends no `session.synthetic` for it (A7-S
 * Step 0): the notice arrives inside `session.inbox.enqueued`, which this driver does not
 * subscribe to, so the child's own `session.execution.*` is what ends it live
 * ({@link openCodeChildNarration}).
 */
const openCodeSubagentNotice = (
  subagents: OpenCodeSubagents,
  metadata: unknown,
  text: string,
  at: number | null,
  live = true,
): SubagentState | undefined => {
  const fields = (metadata ?? {}) as {
    source?: unknown;
    childID?: unknown;
    state?: unknown;
  };
  if (fields.source !== "subagent" || typeof fields.childID !== "string") {
    return undefined;
  }
  const callId = subagents.children.get(fields.childID);
  const call = callId === undefined ? undefined : subagents.calls.get(callId);
  if (callId === undefined || call === undefined) return undefined;
  const status: SubagentStatus | undefined =
    fields.state === "completed"
      ? "finished"
      : fields.state === "error"
        ? "failed"
        : fields.state === "cancelled"
          ? "stopped"
          : undefined;
  if (status === undefined) return undefined;
  const said = subagentReturned(text);
  if (status === "finished") {
    call.result = capped(call.lastText ?? said, SUBAGENT_RESULT_MAX);
  } else if (status === "failed") {
    call.failure = {
      reason: "The sub-agent failed",
      error: capped(said === "" ? "Subagent failed" : said, SUBAGENT_ERROR_MAX),
    };
  }
  endOpenCodeSubagent(call, status, at);
  return openCodeSubagentState(callId, call, live);
};

/**
 * One event of a sub-agent's **child session**, read into its call (A7-S): a tool call adds
 * a line, its success or failure closes it, a thought or a sentence is what it is doing now,
 * and — for a background one, which no parent tool result ends — its execution's end is its
 * end. Answers the new state when the card moved, else `undefined`, so an event that moves
 * nothing takes no slot on the narration bus.
 *
 * Measured on 2.2.5 (A7-S Step 0): the child's `session.tool.*`, `session.text.ended`,
 * `session.reasoning.ended` and `session.execution.{succeeded,failed,interrupted}` arrive on
 * the same event stream as the parent's, under the child's `sessionID`.
 */
export const openCodeChildNarration = (
  entry: unknown,
  subagents: OpenCodeSubagents,
): HarnessNarration | undefined => {
  const record = (entry ?? {}) as {
    type?: unknown;
    created?: unknown;
    data?: Record<string, unknown> | undefined;
  };
  const type = typeof record.type === "string" ? record.type : "unknown";
  const data = record.data ?? {};
  const child = data["sessionID"];
  const callId =
    typeof child === "string" ? subagents.children.get(child) : undefined;
  const call = callId === undefined ? undefined : subagents.calls.get(callId);
  if (call === undefined || callId === undefined || call.status !== "running") {
    return undefined;
  }
  const at = typeof record.created === "number" ? record.created : Date.now();
  const toolId = typeof data["id"] === "string" ? data["id"] : undefined;
  const moved = ((): boolean => {
    switch (type) {
      case "session.tool.input.started":
        if (toolId !== undefined && typeof data["name"] === "string") {
          call.names.set(toolId, data["name"]);
        }
        return false;
      case "session.tool.called": {
        if (toolId === undefined) return false;
        call.seen += 1;
        call.lines = [
          ...call.lines,
          {
            id: toolId,
            line: {
              tool: call.names.get(toolId) ?? "tool",
              input: toolInputLine(data["input"], SUBAGENT_LINE_MAX),
              result: null,
              failed: false,
            },
          },
        ].slice(-SUBAGENT_LINES_KEPT);
        return true;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        if (toolId === undefined) return false;
        call.names.delete(toolId);
        const failed = type === "session.tool.failed";
        const error = (data["error"] ?? {}) as { message?: unknown };
        const said = failed
          ? typeof error.message === "string"
            ? error.message
            : "the tool failed"
          : partsText(data["content"]);
        const before = call.lines;
        call.lines = call.lines.map((each) =>
          each.id === toolId
            ? {
                ...each,
                line: {
                  ...each.line,
                  result: firstLine(said, SUBAGENT_LINE_MAX),
                  failed,
                },
              }
            : each,
        );
        return call.lines.some((each, at) => each !== before[at]);
      }
      case "session.reasoning.ended":
      case "session.text.ended": {
        const text = data["text"];
        if (typeof text !== "string" || text.trim() === "") return false;
        if (type === "session.text.ended") call.lastText = text;
        const activity = firstLine(text, SUBAGENT_LINE_MAX);
        if (activity === call.activity) return false;
        call.activity = activity;
        return true;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        // A foreground call's end is its result on the parent, which comes next.
        if (!call.background) return false;
        if (type === "session.execution.succeeded") {
          call.result = capped(call.lastText ?? "", SUBAGENT_RESULT_MAX);
          endOpenCodeSubagent(call, "finished", at);
        } else if (type === "session.execution.failed") {
          const error = (data["error"] ?? {}) as { message?: unknown };
          call.failure = {
            reason: "The sub-agent failed",
            error: capped(
              typeof error.message === "string" && error.message !== ""
                ? error.message
                : "OpenCode gave no reason.",
              SUBAGENT_ERROR_MAX,
            ),
          };
          endOpenCodeSubagent(call, "failed", at);
        } else {
          endOpenCodeSubagent(call, "stopped", at);
        }
        return true;
      }
      default:
        return false;
    }
  })();
  return moved
    ? {
        type,
        sequence: undefined,
        at,
        outcome: undefined,
        detail: openCodeSubagentState(callId, call),
      }
    : undefined;
};

/**
 * A child session's stored messages read into its call on a replay (A7-S): its tool calls
 * counted and its last ones as lines, its newest reply, and when it started and last wrote.
 *
 * **A child whose newest entry is an `idle` marker has ended** (A7-S review 1), whatever
 * the parent's messages say: OpenCode writes one each time a session goes quiet, with the
 * outcome (`Session.Message.Idle`). That is the one record of a background child stopped
 * at its session's end, whose notice was cancelled with the parent's inbox; read without
 * it, the card said `running` for ever. `interrupted` reads as stopped, `failed` as failed
 * with the harness's error, `succeeded` as finished with its last reply.
 */
const readChildMessages = (
  call: OpenCodeSubagentCall,
  entries: readonly unknown[],
): void => {
  let seen = 0;
  const lines: { id: string; line: SubagentToolLine }[] = [];
  let lastText: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let quiet:
    | { readonly outcome: unknown; readonly at: number | null; error: unknown }
    | undefined;
  for (const entry of entries) {
    const record = (entry ?? {}) as {
      type?: unknown;
      time?: { created?: unknown; completed?: unknown } | undefined;
      content?: unknown;
      outcome?: unknown;
      error?: unknown;
    };
    const created = millisOf(record.time?.created);
    const completed = millisOf(record.time?.completed);
    if (created !== undefined) first ??= created;
    if (completed !== undefined || created !== undefined) {
      last = completed ?? created ?? last;
    }
    // Only the newest entry's: anything after a marker is the child working again.
    quiet =
      record.type === "idle"
        ? { outcome: record.outcome, at: created ?? null, error: record.error }
        : undefined;
    if (record.type !== "assistant" || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      const item = (part ?? {}) as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        text?: unknown;
        state?: {
          status?: unknown;
          input?: unknown;
          content?: unknown;
          error?: { message?: unknown } | undefined;
        };
      };
      if (
        item.type === "text" &&
        typeof item.text === "string" &&
        item.text.trim() !== ""
      ) {
        lastText = item.text;
      } else if (item.type === "tool" && typeof item.id === "string") {
        seen += 1;
        const state = item.state ?? {};
        const failed = state.status === "error";
        const result =
          state.status === "completed"
            ? firstLine(partsText(state.content), SUBAGENT_LINE_MAX)
            : failed
              ? firstLine(
                  typeof state.error?.message === "string"
                    ? state.error.message
                    : "the tool failed",
                  SUBAGENT_LINE_MAX,
                )
              : null;
        lines.push({
          id: item.id,
          line: {
            tool: typeof item.name === "string" ? item.name : "tool",
            input: toolInputLine(state.input, SUBAGENT_LINE_MAX),
            result,
            failed,
          },
        });
      }
    }
  }
  call.seen = seen;
  if (call.status === "running" && quiet !== undefined) {
    if (quiet.outcome === "succeeded") {
      call.status = "finished";
    } else if (quiet.outcome === "failed") {
      const said = (quiet.error as { message?: unknown } | undefined)?.message;
      call.status = "failed";
      call.failure = {
        reason: "The sub-agent failed",
        error: capped(
          typeof said === "string" && said.trim() !== ""
            ? said
            : "its session ended failed",
          SUBAGENT_ERROR_MAX,
        ),
      };
    } else if (quiet.outcome === "interrupted") {
      call.status = "stopped";
    }
    if (call.status !== "running") {
      call.activity = null;
      call.endedAt = quiet.at;
    }
  }
  // A call still open when it ended reads as stopped, as `endSubagent` has it live.
  call.lines = lines
    .slice(-SUBAGENT_LINES_KEPT)
    .map((each) =>
      each.line.result === null &&
      call.status !== "running" &&
      call.status !== "finished"
        ? { ...each, line: { ...each.line, result: "stopped", failed: true } }
        : each,
    );
  if (lastText !== null) call.lastText = lastText;
  if (call.startedAt === null) call.startedAt = first;
  if (call.status !== "running" && call.endedAt === null) call.endedAt = last;
  if (call.status === "finished" && (call.result ?? "") === "") {
    call.result =
      lastText === null ? null : capped(lastText, SUBAGENT_RESULT_MAX);
  }
};

/** Whether a `synthetic` entry's metadata is a sub-agent's completion notice at all. */
const isSubagentNotice = (metadata: unknown): boolean =>
  (metadata as { source?: unknown } | undefined)?.source === "subagent";

/**
 * The child a sub-agent notice is about (`SubagentCompletion.deliver`'s `{ source:
 * "subagent", childID, state }`), or `undefined` for any other entry: what an end waits for
 * after stopping a background child. Any state counts — a child stopped as it finished
 * tells its parent `completed` — so the caller says which notices are new enough.
 */
const noticeChild = (metadata: unknown): string | undefined => {
  if (!isSubagentNotice(metadata)) return undefined;
  const child = (metadata as { childID?: unknown }).childID;
  return typeof child === "string" ? child : undefined;
};

/**
 * How much earlier than an end's start a delivered notice may be stamped and still count
 * as one its stops caused: OpenCode's clock is this machine's, read in another process.
 */
const NOTICE_CLOCK_SLACK = 1_000;

/**
 * One stored assistant message's content as parts, in the live stream's vocabulary (A6 F10).
 *
 * `@opencode/schema`'s `Session.Message.Assistant.content` is a list of `text`, `reasoning`
 * and `tool` parts. Text and reasoning become `reply` and `thinking` with the `blockId` their
 * stream used — {@link openCodeBlockId} from the message id and the part's ordinal, counted
 * separately per channel as the events count it — so a replayed block is the one the live
 * stream finished. A `tool` part is **richer than the stream**: its call and its outcome are
 * one stored part, so it becomes a `toolCall` and, once the call has settled (`completed`
 * or `error`), its `toolResult` — with the tool's name on both, which the live stream can
 * only give a result whose call it saw. A call still `streaming` or `running` has no result
 * yet, as live.
 */
const assistantContentParts = (
  messageId: string | undefined,
  content: readonly unknown[],
  model: string | undefined,
  subagents: OpenCodeSubagents,
): MessagePart[] => {
  const ordinals = { reply: 0, thinking: 0 };
  const named = model === undefined ? {} : { model };
  const keyed = (channel: BlockChannel) => {
    const ordinal = ordinals[channel];
    ordinals[channel] += 1;
    return messageId === undefined
      ? {}
      : blockKey(channel, { assistantMessageID: messageId, ordinal });
  };
  return content.flatMap((part): MessagePart[] => {
    const record = (part ?? {}) as {
      type?: unknown;
      text?: unknown;
      id?: unknown;
      name?: unknown;
      time?: { created?: unknown; completed?: unknown } | undefined;
      state?: {
        status?: unknown;
        input?: unknown;
        content?: unknown;
        metadata?: unknown;
        error?: { message?: unknown } | undefined;
      };
    };
    if (record.type === "text" && typeof record.text === "string") {
      return [
        {
          _tag: "reply",
          text: truncateReply(record.text),
          ...keyed("reply"),
          ...named,
        },
      ];
    }
    if (record.type === "reasoning" && typeof record.text === "string") {
      return [
        {
          _tag: "thinking",
          text: truncateNarration(record.text),
          ...keyed("thinking"),
          ...named,
        },
      ];
    }
    if (record.type !== "tool" || typeof record.id !== "string") return [];
    const tool = typeof record.name === "string" ? record.name : undefined;
    const state = record.state ?? {};
    // A `streaming` call's input is still the JSON text being written; the others hold
    // the parsed object.
    // A sub-agent: its entry and its state, not its call and result (A6 U14).
    const subagent = openCodeSubagentCall(
      tool,
      state.input,
      model,
      millisOf(record.time?.created) ?? null,
    );
    if (subagent !== undefined) {
      subagents.calls.set(record.id, subagent);
      const live = subagents.live ?? false;
      const running = openCodeSubagentState(record.id, subagent, live);
      const ended = millisOf(record.time?.completed) ?? null;
      const settled =
        state.status === "completed"
          ? openCodeSubagentSettled(
              subagents,
              record.id,
              subagent,
              {
                ok: true,
                metadata: state.metadata,
                content: partsText(state.content),
              },
              ended,
              live,
            )
          : state.status === "error"
            ? openCodeSubagentSettled(
                subagents,
                record.id,
                subagent,
                {
                  ok: false,
                  message:
                    typeof state.error?.message === "string"
                      ? state.error.message
                      : "",
                  metadata: state.metadata,
                },
                ended,
                live,
              )
            : (() => {
                // Still running when stored: its child, if the progress named one.
                adoptChild(
                  subagents,
                  record.id,
                  subagent,
                  (state.metadata as { sessionID?: unknown } | undefined)
                    ?.sessionID,
                );
                return undefined;
              })();
      return settled === undefined ? [running] : [running, settled];
    }
    const input =
      typeof state.input === "string" ? state.input : asJson(state.input);
    const call: MessagePart = {
      _tag: "toolCall",
      callId: record.id,
      tool,
      input: truncateNarration(input),
      ...named,
    };
    if (state.status === "completed") {
      return [
        call,
        {
          _tag: "toolResult",
          callId: record.id,
          tool,
          output: truncateNarration(partsText(state.content)),
          failed: false,
        },
      ];
    }
    if (state.status === "error") {
      // Worded as the live `session.tool.failed` is: the error's message, then any output.
      const message =
        typeof state.error?.message === "string"
          ? state.error.message
          : "the tool failed";
      const output = partsText(state.content);
      return [
        call,
        {
          _tag: "toolResult",
          callId: record.id,
          tool,
          output: truncateNarration(
            output === "" ? message : `${message}\n${output}`,
          ),
          failed: true,
        },
      ];
    }
    return [call];
  });
};

/**
 * Reduces one stored message to what a caller uses, its blocks as parts (A6 F10).
 *
 * The entry union is wide and version-specific (`Session.Message.Info`: `user`,
 * `assistant`, `shell`, `synthetic`, `idle`, `model-switched` …), so this reads defensively
 * off an already-decoded value rather than re-asserting a shape the client has validated.
 * `text` falls back to concatenating the entry's text parts, which is where an assistant's
 * reply actually lives. Only an `assistant` entry has parts or a model; `at` is
 * `time.created` on every kind.
 */
const flatten = (
  entry: unknown,
  /** This read's attachment reader: where the session's uploads are stored (`attachmentReader`). */
  readAttachments: AttachmentReader,
  subagents: OpenCodeSubagents = openCodeSubagents(),
): MessageEntry => {
  const record = (entry ?? {}) as {
    id?: unknown;
    type?: unknown;
    text?: unknown;
    metadata?: unknown;
    description?: unknown;
    model?: unknown;
    time?: { created?: unknown; completed?: unknown } | undefined;
    error?: { message?: unknown } | undefined;
    content?: ReadonlyArray<{ type?: unknown; text?: unknown }> | undefined;
    files?: ReadonlyArray<{
      mime?: unknown;
      source?: { type?: unknown; uri?: unknown };
    }>;
  };
  const type = typeof record.type === "string" ? record.type : "unknown";
  const content = Array.isArray(record.content) ? record.content : [];
  const model = type === "assistant" ? modelRefName(record.model) : undefined;
  /*
   * A background sub-agent's completion notice (A6 U14): its end, as its state, and never
   * its words, which are the sub-agent's own reply. Dropped as words even when it names a
   * child this read did not see launched, for the same reason.
   */
  if (type === "synthetic" && isSubagentNotice(record.metadata)) {
    const ended = openCodeSubagentNotice(
      subagents,
      record.metadata,
      typeof record.text === "string" ? record.text : "",
      millisOf(record.time?.created) ?? null,
      subagents.live ?? false,
    );
    return {
      type,
      text: "",
      error: undefined,
      parts: ended === undefined ? [] : [ended],
      model: undefined,
      at: millisOf(record.time?.created),
    };
  }
  /*
   * A `system` entry's `text` is what the **model** was told — measured on 2.2.5, a whole
   * "the tool catalog has changed" listing every tool — and `@opencode/schema` gives it a
   * `description`, "a short human-readable summary for transcript display". A transcript is
   * what this is read for, so the summary is the text when there is one.
   */
  const summary =
    type === "system" &&
    typeof record.description === "string" &&
    record.description.trim() !== ""
      ? record.description
      : undefined;
  const words =
    summary !== undefined
      ? summary
      : typeof record.text === "string"
        ? record.text
        : content
            .filter((part) => part.type === "text")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("\n");
  /*
   * The files an operator's message carried (A6 F9): the `[Attached …]` lines after its words,
   * naming files in the session's own `uploads/` folder, taken out of the words, each
   * file's type from the file part OpenCode stored for it (matched by its `file://` uri,
   * never by position) when it was sent inline.
   */
  const fileTypes = new Map<string, string>();
  for (const file of Array.isArray(record.files) ? record.files : []) {
    const uri = file.source?.type === "uri" ? file.source.uri : undefined;
    if (typeof uri !== "string" || typeof file.mime !== "string") continue;
    try {
      fileTypes.set(fileURLToPath(uri), file.mime);
    } catch {
      // Not a file uri: nothing of ours.
    }
  }
  const split =
    type === "user"
      ? readAttachments(words, (path) => fileTypes.get(path))
      : undefined;
  /*
   * A steer of ours is stored under the id it was delivered with, `msg_` plus our hex
   * (`openCodeMessageId`), so the application's id is that without its prefix (A6 U4 review
   * 2) — the reading `session.inbox.delivered`'s take gets. An id OpenCode minted itself (an
   * opening prompt's) is not in that shape and names nothing.
   */
  const ours =
    type === "user" &&
    typeof record.id === "string" &&
    record.id.startsWith("msg_") &&
    isDerivedMessageId(record.id.slice(4))
      ? record.id.slice(4)
      : undefined;
  return {
    type,
    text: split?.text ?? words,
    ...(ours === undefined ? {} : { messageIds: [ours] }),
    ...(split === undefined || split.attachments.length === 0
      ? {}
      : { attachments: split.attachments }),
    error:
      typeof record.error?.message === "string"
        ? record.error.message
        : undefined,
    parts:
      type === "assistant"
        ? assistantContentParts(
            typeof record.id === "string" ? record.id : undefined,
            content,
            model,
            subagents,
          )
        : [],
    model,
    at: millisOf(record.time?.created),
    /*
     * When the model finished the message (A6 U4 review). Its parts are all stored with the
     * message's `time.created`, when it started, so that alone made a 3 s turn replay as
     * 0 s; `time.completed` (`Session.Message.Assistant`'s optional `time.completed`, in the
     * schema since 2.1, and on every finished message 2.2.5 lists) is when they were done.
     * `null` for an assistant message with none: its end is unknown, and said so.
     */
    ...(type === "assistant"
      ? { endedAt: millisOf(record.time?.completed) ?? null }
      : {}),
  };
};

/**
 * How full the window was on the session's newest stored model call (A6 U9), from
 * `message.list` entries **newest first**.
 *
 * The newest `assistant` message with tokens, summed as OpenCode's own meter sums it
 * (`packages/tui/src/util/session.ts` `contextUsage`): `input + output + reasoning +
 * cache.read + cache.write` — `input` is the uncached remainder and `reasoning` sits beside
 * `output` on this harness (DECISIONS.md §24.4). A **completed** `compaction` message met
 * first means the conversation was summarised after that call, and the call's size no
 * longer describes the window: `compacted`, measured again by the next call. A running or
 * failed compaction changed nothing yet. `undefined` when this page holds neither, for the
 * caller to read on.
 */
const tokenCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const openCodeContext = (
  newestFirst: readonly unknown[],
): Pick<HarnessContextUsage, "used" | "usedModel" | "reading"> | undefined => {
  for (const entry of newestFirst) {
    const message = (entry ?? {}) as {
      readonly type?: unknown;
      readonly status?: unknown;
      readonly tokens?: {
        readonly input?: unknown;
        readonly output?: unknown;
        readonly reasoning?: unknown;
        readonly cache?: { readonly read?: unknown; readonly write?: unknown };
      };
    };
    if (message.type === "compaction" && message.status === "completed") {
      return { used: null, usedModel: null, reading: "compacted" };
    }
    if (message.type !== "assistant" || message.tokens === undefined) continue;
    const used =
      tokenCount(message.tokens.input) +
      tokenCount(message.tokens.output) +
      tokenCount(message.tokens.reasoning) +
      tokenCount(message.tokens.cache?.read) +
      tokenCount(message.tokens.cache?.write);
    // The call's own model (`Model.Ref`, `provider/model` as the catalogue names it), which
    // after a switch may not be the one the window is read for.
    if (used > 0) {
      return {
        used,
        usedModel: modelRefName((entry as { model?: unknown }).model) ?? null,
        reading: "measured",
      };
    }
  }
  return undefined;
};

/**
 * Messages asked for per `message.list` page: the server's own maximum
 * (`SessionMessagesQuery`: `limit` is 1..200), so a long session costs the fewest requests.
 */
const MESSAGE_PAGE_SIZE = 200;

/** Pages walked before `messages` gives up loudly. See that function for why it fails. */
const MESSAGE_PAGE_CEILING = 500;

/**
 * The child sessions an end lists (`GET /api/session?parentID=`): one page, the server's
 * own maximum. A session's agent starts a handful of sub-agents; past this many, the rest
 * are the ones the stream or a replay saw (`endSession`).
 */
const CHILD_LIST_LIMIT = 200;

/**
 * How long an end waits for the notices of the background children it stopped to reach
 * their parent, and how often it looks (A7-S review 1). OpenCode admits a stopped
 * background child's `Subagent cancelled` notice into the parent's inbox once the child's
 * job settles, after the interrupt has answered, and the notice **wakes the parent**
 * (`SubagentCompletion.deliver` → `Session.synthetic`, which nothing can hold back). So an
 * end that interrupted the parent first, or before the notice was in, would leave a turn
 * that runs on the notice after the operator ended the import.
 */
const CHILD_NOTICE_SETTLE = 1_500;
const CHILD_NOTICE_POLL: Duration.Input = "50 millis";

/**
 * Per-operation request bounds.
 *
 * These bound *our* transport, nothing else. `wait` is deliberately absent from the
 * defaults as a deadline on the worker: settlement is the harness's to decide
 * (DECISIONS.md §5 "no deadline-triggered worker settlement"). It carries a generous
 * ceiling only so a dead socket cannot wedge the process forever, and exceeding it is
 * reported as an *uncertain* outcome rather than a failed one.
 */
export interface ClientTimeouts {
  /** Short control-plane calls: create, prompt, status, messages, mcp registration. */
  readonly control: Duration.Input;
  /** The long poll that blocks until a session settles. */
  readonly wait: Duration.Input;
}

export const DEFAULT_TIMEOUTS: ClientTimeouts = {
  control: "30 seconds",
  wait: "30 minutes",
};

/**
 * OpenCode's stand-in for a session that has no title yet: its kind and creation time.
 *
 * Copied from `@opencode/util`'s `session-title-fallback.ts`, which is how OpenCode itself
 * recognises one, rather than imported: the package is not a dependency of this server, and
 * a placeholder is the one title `openCodeHarness.sessionTitle` must not report as a name.
 */
export const OPENCODE_PLACEHOLDER_TITLE =
  /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A session id this application mints, in OpenCode's own format.
 *
 * `@opencode/schema`'s `Session.ID.create()` rather than a string of our own: the format is
 * `ses_` plus the harness's descending identifier, the brand's check enforces the prefix,
 * and a value built by hand would be our guess at someone else's id scheme. This is the
 * only place it is called, so if the scheme changes there is one line to follow.
 *
 * Minting an id here is only useful because the harness honours it. `SessionCreateInput.id`
 * is `Session.ID | undefined` in `@opencode/client@2.1.0`, and `opencode` 2.1.2 returning
 * the id it is handed was checked against a live `opencode serve` rather than inferred
 * from the type.
 */
export const newOpenCodeSessionId = (): string => SessionID.create();

/** What a caller may vary about this harness. */
export interface OpenCodeHarnessOptions {
  readonly timeouts?: ClientTimeouts;
  /** The model a run gets when it names none. OpenCode's `provider/model` form. */
  readonly defaultModel?: string;
}

/**
 * The OpenCode harness over an already-running `opencode serve`.
 *
 * Requires {@link OpenCodeServer}, which is what makes "this deployment can start runs" a
 * layer question rather than a runtime one: a process whose harness will not spawn never
 * builds this, and `main.ts` serves without it.
 */
export const openCodeHarness = (
  options: OpenCodeHarnessOptions = {},
): Layer.Layer<AgentHarness, never, OpenCodeServer> => {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const defaultModel = options.defaultModel ?? OPENCODE_DEFAULT_MODEL;
  return Layer.effect(
    AgentHarness,
    Effect.gen(function* () {
      const { server } = yield* OpenCodeServer;
      // A server a version apart may refuse the event stream's types (U13 review 6).
      const skew = openCodeVersionSkew(server.version);
      if (skew !== undefined) yield* Effect.logWarning(skew);

      /**
       * The transport every generated call runs on.
       *
       * The credential is attached here, once, rather than per call: the generated client
       * builds its own requests, so an operation we have not wrapped is authenticated too.
       * `filterStatusOk` is deliberately **not** applied — the client reads non-2xx bodies
       * to produce its own tagged errors, and discarding them here would flatten
       * `UnauthorizedError` and friends into a bare status.
       */
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.setHeader(
              "authorization",
              Redacted.value(server.authorization),
            ),
            HttpClientRequest.acceptJson,
          ),
        ),
      );

      const api = yield* OpenCode.make({ baseUrl: server.baseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );

      /**
       * Collapses the client's failures into this application's two.
       *
       * The distinction that has to survive is transport versus shape, because they mean
       * different things to a caller: a transport failure leaves the harness's state
       * *uncertain*, while a decode failure means we are talking to something that does not
       * answer the way this build expects. A `SchemaError` — raised directly or wrapped in
       * the client's `ClientError` — is the second kind; everything else is the first.
       */
      const fail = (operation: string) => (cause: unknown) => {
        // The client wraps a transport or schema failure in its own `ClientError`, so the
        // useful one is a level down. Unwrap exactly one level — more would be guessing at
        // a chain whose shape is not ours.
        const outer = cause as { readonly cause?: unknown };
        const inner = outer.cause ?? cause;
        const status = HttpClientError.isHttpClientError(inner)
          ? inner.response?.status
          : undefined;
        const tag = (inner as { _tag?: string })._tag ?? "error";
        const detail = (inner as { message?: string }).message ?? String(inner);

        // Official predicates rather than tag strings: a decode failure is whatever Effect
        // calls a decode failure, in this version and the next.
        return Schema.isSchemaError(inner)
          ? new HarnessDecodeError({ operation, status, detail, cause })
          : new HarnessTransportError({
              operation,
              status,
              tag,
              detail: `${tag}: ${detail}`,
              cause,
            });
      };

      /** Applies this application's transport bound to one generated call. */
      const bounded = <A>(
        operation: string,
        timeout: Duration.Input,
        effect: Effect.Effect<A, unknown>,
      ): Effect.Effect<A, HarnessTransportError | HarnessDecodeError> =>
        effect.pipe(
          Effect.mapError(fail(operation)),
          Effect.timeout(timeout),
          Effect.catchTag(
            "TimeoutError",
            (cause) =>
              new HarnessTransportError({
                operation,
                status: undefined,
                tag: "TimeoutError",
                detail:
                  "request exceeded its transport bound and was aborted; " +
                  "this does not mean the harness stopped working",
                cause,
              }),
          ),
        );

      /**
       * The catalogue, read once, as the strings a run actually names a model with.
       *
       * `api.model.list()` answers every model this server's configured providers expose,
       * and `providerID/id` is the one form that is also what `createSession` is handed
       * and what `openCodeModelProvenance` splits — so the picker, the attempt row and the
       * wire all agree on one spelling with nothing in between to get it wrong.
       *
       * **A failure degrades to the default model and does not refuse the harness.** A
       * catalogue is for choosing with; being unable to read it is a reason the picker has
       * one entry, not a reason this deployment cannot run anything. Contrast
       * `claudeCodeClient.ts`'s version read, which *does* refuse — because that one is the
       * evidence for a safety property rather than a convenience.
       *
       * The default is kept at the front and deduplicated into the list, so the model a
       * run gets when it names none is always pickable and never listed twice.
       */
      const listed = yield* Effect.result(
        bounded("model.list", timeouts.control, api.model.list()),
      );
      if (listed._tag === "Failure") {
        yield* Effect.logWarning(
          "could not read OpenCode's model catalogue; the picker will offer this instance's default model only",
          { detail: listed.failure.message },
        );
      }
      const catalogue =
        listed._tag === "Success"
          ? listed.success.data.map((model) =>
              openCodeModelView(
                `${model.providerID}/${model.id}`,
                model.variants,
                // Survives the generated client's decode: `@opencode/schema` 2.1.0 types
                // `limit` as `{ context: Int, input?: Int, output: Int }` and it arrived
                // intact on all 27 entries of a 2.2.2 server (DECISIONS.md §24.4). No new
                // request, and nothing here falls back to a written-down number.
                //
                // The whole `limit` and not one field of it: the meter's denominator and
                // the harness's own compaction point come out of different fields of it.
                model.limit,
              ),
            )
          : [];
      // The default's own entry when the catalogue has one, so the model a run gets when
      // it names none carries its variants like any other; a bare entry when the
      // catalogue could not be read, which offers nothing rather than guessing.
      const models: readonly HarnessModelView[] = [
        catalogue.find((model) => model.id === defaultModel) ?? {
          id: defaultModel,
        },
        ...catalogue
          .filter((model) => model.id !== defaultModel)
          .sort((left, right) => left.id.localeCompare(right.id)),
      ];

      const instance: HarnessInstance = {
        instanceId: defaultInstanceIdForDriver(OPENCODE_DRIVER),
        driver: OPENCODE_DRIVER,
        displayName: "OpenCode",
        // Read off `/api/info` during readiness, so it is the build that answered rather
        // than the one on the PATH when somebody last looked.
        version: server.version,
        installed: true,
        // See `identity.ts` on why this is not probed: `opencode serve` starts without
        // provider credentials and only fails at prompt time, so anything else here would
        // be a guess.
        auth: "unknown",
        defaultModel,
        models,
      };

      /**
       * Brands a directory as the absolute path the client's types require.
       *
       * `AbsolutePath` is a branded string, so this is the one place the brand is applied;
       * `decodeUnknownSync` rather than a cast so that whatever validation the brand
       * carries now or later actually runs, and a bad path fails here with the path in the
       * message instead of somewhere inside a request body.
       */
      const directoryOf = (directory: string) =>
        Schema.decodeUnknownSync(AbsolutePath)(directory);

      /**
       * Brands a `provider/model` string as the pair the wire wants.
       *
       * `decodeUnknownSync` dies on a malformed id rather than failing, and that is
       * correct here: the model is *configuration*, not a request payload, so a bad one is
       * a deployment mistake to be surfaced loudly and not a condition a run should report
       * as "the harness is unreachable".
       */
      const modelOf = (model: string) => {
        const { providerId, modelId } = openCodeModelProvenance(model);
        return {
          providerID: Schema.decodeUnknownSync(ProviderID)(providerId),
          id: Schema.decodeUnknownSync(ModelID)(modelId),
        };
      };

      /**
       * Which directory each `(sessionId, name)` was registered into.
       *
       * Kept so {@link unregisterMcpServer} needs no directory parameter — see the seam
       * on why that is the caller's business to not know. Layer-scoped, like the server
       * child process it talks to: a registration cannot outlive the OpenCode server, so
       * neither does this map, and a key that is missing means there is nothing of ours
       * in any registry to remove.
       */
      const registeredIn = new Map<string, string>();
      const registrationKey = (sessionId: string, name: string): string =>
        `${sessionId}\u0000${name}`;
      /**
       * One lock per directory, held across a registration's `mcp.add` and across a
       * release's `mcp.remove`, its check of {@link registeredIn} and its eviction (A6 U6
       * review). A resume runs in its predecessor's directory, so a session closed
       * `refused` or `open_failed` and opened again at once can register in the very
       * directory whose Location the close is letting go of: unserialised, the eviction's
       * check could run before the new `mcp.add` was recorded, or its request land after
       * that add — and dispose of the Location the add went into, so the resumed agent would
       * run on with none of bit's tools and nothing said. With the lock, an add waits for an
       * eviction in flight and goes into the fresh Location, and an eviction waits for an add
       * in flight and then sees it. Kept per directory ever registered in, bounded by the
       * sessions this process opened, as {@link registeredIn} is.
       */
      const directoryLocks = new Map<string, Semaphore.Semaphore>();
      const inDirectory = (directory: string) => {
        let lock = directoryLocks.get(directory);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          directoryLocks.set(directory, lock);
        }
        return Semaphore.withPermit(lock);
      };

      const registerMcpServer: AgentHarness["Service"]["registerMcpServer"] =
        Effect.fn("openCodeHarness.registerMcpServer")(
          // The session id reaches no OpenCode call here, and that is the whole point of
          // the parameter: OpenCode registers an MCP server into a *directory* and has no
          // per-session channel, so the session the credential is for is implicit in the
          // registry. The interface takes it anyway because Claude Code cannot register
          // without it; see `AgentHarness.registerMcpServer` for what this implementation
          // is therefore wider than. It is used below only as half of the key that
          // remembers where to remove the entry from.
          function* (sessionId, name, config) {
            const key = registrationKey(sessionId, name);
            /*
             * Recorded **before** the add, and taken back if it fails (A6 U6 review): an add
             * in flight is a registration a release must not evict under, and the lock
             * below is what keeps a release from reading the map between the two.
             */
            registeredIn.set(key, config.directory);
            const add = bounded(
              "mcp.add",
              timeouts.control,
              api.experimental.mcp.add({
                server: name,
                location: { directory: directoryOf(config.directory) },
                config: new Mcp.RemoteConfig({
                  type: "remote",
                  url: config.url,
                  // Pinned, not negotiated: our endpoint serves only the stateless
                  // 2026-07-28 revision, and this field's default value would open with an
                  // `initialize` handshake the server does not implement. "auto" would
                  // probe and silently fall back; there is nothing to fall back to. Typed
                  // by the schema, so a typo here is a compile error rather than a
                  // connection failure at run time.
                  protocol: "2026-07-28",
                  // Unwrapped only here, at the one call that delivers it.
                  headers: Object.fromEntries(
                    Object.entries(config.headers).map(([key, value]) => [
                      key,
                      Redacted.value(value),
                    ]),
                  ),
                  timeout: new Mcp.TimeoutConfig({
                    startup: 20_000,
                    catalog: 20_000,
                    execution: 60_000,
                  }),
                }),
              }),
            ).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  if (registeredIn.get(key) === config.directory) {
                    registeredIn.delete(key);
                  }
                }),
              ),
            );
            yield* inDirectory(config.directory)(add);
          },
        );

      /**
       * Removes the registration from the directory it was added to.
       *
       * `mcp.remove` is real here and does what the name says: OpenCode sets an in-memory
       * override for the server and reloads, so the entry leaves the directory's registry
       * for the life of its own process (`packages/core/src/mcp/index.ts`, `MCP.remove`).
       * It does **not** edit the operator's `opencode.json`; the override is held in
       * memory, which is what makes this safe to call against a directory whose config we
       * did not write.
       *
       * Two honest limits:
       *
       * - A name this process never registered is a no-op with no request made. The
       *   directory is not ours to guess, and OpenCode answers `404` for a server it does
       *   not hold, so asking would turn tidy-up into a failure for no gain.
       * - The entry was *directory*-scoped while it existed, so removing it removes it for
       *   every session in that directory — which is the same width `registerMcpServer`
       *   already has, and is recorded there and in DECISIONS.md §24.2.
       */
      const unregisterMcpServer: AgentHarness["Service"]["unregisterMcpServer"] =
        Effect.fn("openCodeHarness.unregisterMcpServer")(
          function* (sessionId, name) {
            const key = registrationKey(sessionId, name);
            const directory = registeredIn.get(key);
            if (directory === undefined) return;
            registeredIn.delete(key);
            /*
             * The remove, the check and the eviction under the directory's lock: see
             * `directoryLocks`. The eviction runs **whether or not the remove did** (A6 U6
             * review 2): the key is already gone, so nothing would ever release this
             * directory again, and a remove that failed or timed out left its Location —
             * and the ~500 MB of MCP servers in it — running for the server's life.
             * Evicting it drops the registration the remove could not, so the remove's
             * failure is still the caller's to see, and the release never adds one.
             */
            yield* inDirectory(directory)(
              bounded(
                "mcp.remove",
                timeouts.control,
                api.experimental.mcp.remove({
                  server: name,
                  location: { directory: directoryOf(directory) },
                }),
              ).pipe(Effect.ensuring(releaseLocation(directory))),
            );
          },
        );

      /**
       * Lets go of a directory's OpenCode **Location** once nothing of ours is left in it
       * (A6 U6, from U5's review 3).
       *
       * OpenCode keeps one Location per directory it is asked about — a whole copy of its
       * services, **including every MCP server the operator's global config names, each its
       * own process** — and never lets one go by itself (`idleTimeToLive: infinity` in
       * 2.2.5's `location-services.ts`). bit gives every import, goal, round and attempt a
       * directory of its own, so each session left one full set behind after it ended:
       * measured on a throwaway server, ~500 MB per set (sequential-thinking,
       * browser-control-mcp, svelte-mcp), three sets after two GLM sessions, 1.95 GB in a
       * 2 GB scope with nothing running.
       *
       * `DELETE /api/debug/location` (`debug.location.evict`) disposes exactly the
       * requested Location; its next use boots it fresh from config, so a later resume in
       * the same directory gets its MCP servers back. Asked only when this process holds
       * no other registration in the directory: a session still registered there is still
       * ours, and an eviction would drop its in-memory registration with the Location.
       * **Cleanup, so it never fails the caller**: a server that does not have the route
       * (it is OpenCode's debug group) or does not answer leaves the Location as it was,
       * which is the state before this existed, and says so in the log.
       */
      const releaseLocation = (directory: string) =>
        Effect.suspend(() =>
          [...registeredIn.values()].includes(directory)
            ? Effect.void
            : bounded(
                "debug.location.evict",
                timeouts.control,
                api.debug.location.evict({
                  location: { directory: directoryOf(directory) },
                }),
              ).pipe(
                Effect.catch((failure) =>
                  Effect.logWarning(
                    "opencode would not let go of a directory's location; its MCP servers keep running until opencode serve exits",
                    { directory, detail: failure.message },
                  ),
                ),
              ),
        );

      /**
       * The context window of each session's model, for the sessions this process opened.
       *
       * The catalogue states a limit per *model* and the narration states usage per
       * *session*, so something has to join them, and this is the smallest thing that can:
       * the model is known at `createSession` and at every `switchModel`, and is not on any
       * event in between. Reading it back off `GET /api/session/:id` per usage event would be a
       * request per model call to learn something that changes only when we change it.
       *
       * Per session and unbounded for the life of the process, like {@link delivered} and
       * for the same reason: one number per session this process has opened or switched,
       * bounded by the work actually done. A session this process did neither to is simply
       * absent, and its narration carries no limit — which is the honest answer rather than
       * the default model's window applied to somebody else's session.
       *
       * A switch made mid-step replaces the entry at once, while the step already running
       * finishes on the old model; that one step's usage is drawn against the new window.
       * Accepted: the meter is a picture of the session from now on, and the step after it
       * is the new model's.
       */
      const contextLimits = new Map<string, SessionWindow>();

      /**
       * Each watched session's sub-agents, as its event stream follows them (A7-S): what
       * {@link stopSubagent} finds a sub-agent's child session in. Set when a stream starts,
       * replaced by a later stream for the same session, **dropped when that stream ends**
       * and when the session is ended (A7-S review 1: an entry outliving its stream made a
       * replay offer a Stop the server then refused, and froze the card at the stream's last
       * state). A replay's read (`replayedSubagents`) is the fallback for a sub-agent started
       * before the stream.
       */
      const streamedSubagents = new Map<string, OpenCodeSubagents>();
      /**
       * The newest replay's read of each session's sub-agents, for the same use; dropped
       * when the session is ended.
       *
       * V2(chat): kept for a session read but never held (another process's), one entry
       * per such session, each bounded by the sub-agent calls that session made.
       */
      const replayedSubagents = new Map<string, OpenCodeSubagents>();

      /**
       * The latest {@link SessionRef} this process handed out for each session id.
       *
       * What `endSession` checks a ref against. A resume opens an id that may already have
       * been opened here, and OpenCode runs one execution per session, so once a later
       * opening exists the execution is its, and an earlier opening's close must not empty
       * or interrupt it (A6 F5 review). One entry per id ever opened, bounded by what an
       * operator has opened, like the spine's own per-id permits.
       */
      const latestRef = new Map<string, SessionRef>();
      const handOut = (id: string): SessionRef => {
        const ref: SessionRef = { id };
        latestRef.set(id, ref);
        return ref;
      };

      const createSession: AgentHarness["Service"]["createSession"] = Effect.fn(
        "openCodeHarness.createSession",
      )(function* (input) {
        /*
         * A resume creates nothing, because there is nothing to create.
         *
         * An OpenCode session is a row in one SQLite file under the user's XDG data
         * directory, and a freshly spawned server finds it by primary key — so "continue the
         * conversation" is an ordinary `session.prompt`, and this call has no work to do but
         * name the session the rest of the acquire order will register and prompt. Calling
         * `session.create` with the existing id would be asking the server to create
         * something it already has.
         *
         * **The model and its variant are not re-pinned**, and that is a statement rather
         * than an omission: OpenCode keeps both on the session's own model reference, set at
         * creation, with `session.switchModel` as the only other way in. A resumed session
         * therefore runs on what it was opened with — which is what the caller wants, since
         * a reopen passes the earlier session's model and options back. The context limit is
         * not noted either: this process never saw this session created, and the honest
         * answer for its window is no answer rather than the catalogue's figure for a model
         * reference we are guessing at.
         */
        if (input.resume !== undefined) return handOut(input.resume);
        const session = yield* bounded(
          "session.create",
          timeouts.control,
          api.session.create({
            title: input.title,
            // The variant rides on the session's model reference, which is where OpenCode
            // keeps it: `session.create` takes it here and `session.switchModel` is the
            // only other way in. A prompt carries no model at all, so there is nothing
            // per-turn to set and nothing to re-send before each prompt.
            model: {
              ...modelOf(input.model),
              ...openCodeVariantOf(input.options),
            },
            location: { directory: directoryOf(input.directory) },
            // Spread rather than passed as `undefined` so the call site reads as "no
            // parent" rather than "parent: nothing". On the wire both are the same: the
            // generated client encodes an absent optional as an explicit `null`, which is
            // what the server reads as parentless.
            //
            // `parentSessionId` exists for provider prompt caching: OpenCode derives one
            // cache key per lineage — `parentID ?? fork.sessionID ?? id`
            // (`core/src/session/affinity.ts`) — so sessions naming the same parent reach
            // the same cached prefix. A child is *not* a fork: only the fork path copies
            // messages across, so the new session starts empty.
            ...(input.parentSessionId === undefined
              ? {}
              : { parentID: input.parentSessionId as Session.ID }),
            ...(input.sessionId === undefined
              ? {}
              : { id: input.sessionId as Session.ID }),
          }),
        );
        // Noted here because this is the one moment the session's model is known; see
        // `contextLimits`. A model the catalogue could not be read for states no limit.
        const view = models.find((model) => model.id === input.model);
        if (view?.contextLimit !== undefined) {
          contextLimits.set(session.id, {
            contextLimit: view.contextLimit,
            compactionAt: view.compactionAt,
          });
        }
        return handOut(session.id);
      });

      /**
       * Moves the session's stored model reference, variant and all.
       *
       * `session.switchModel` is the one other way into the reference `session.create` set,
       * and a prompt carries no model, so this is the whole of a switch on this driver: no
       * live state of ours to update but the context window below. OpenCode reads the
       * reference at each step, so the switch reaches a turn already running at its next
       * model call — see `AgentHarness.switchModel` for what was measured.
       *
       * **The variant is replaced, never kept.** `Model.Ref.variant` is optional and the
       * whole reference is sent, so a switch that names no variant (nothing chosen, or the
       * default) leaves the session on the new model with no variant at all — not on the old
       * model's variant, which may not exist on the new one.
       *
       * Idempotent on the server's own terms: the reference is set, not toggled, so the
       * same request twice leaves the session where the first one put it. Nothing is
       * remembered here to skip a repeat, because this process is not the only writer —
       * OpenCode's own UI can move the reference too — and skipping on a stale memory would
       * be the one way to make a retry not apply.
       */
      const switchModel: AgentHarness["Service"]["switchModel"] = Effect.fn(
        "openCodeHarness.switchModel",
      )(function* (sessionId, model, options) {
        yield* bounded(
          "session.switchModel",
          timeouts.control,
          api.session.switchModel({
            sessionID: sessionId as Session.ID,
            model: { ...modelOf(model), ...openCodeVariantOf(options) },
          }),
        );
        // After the server took it, never before: a refused switch leaves the session on
        // its old model, and the meter must not move to a window it is not running in.
        const view = models.find((entry) => entry.id === model);
        if (view?.contextLimit === undefined) contextLimits.delete(sessionId);
        else {
          contextLimits.set(sessionId, {
            contextLimit: view.contextLimit,
            compactionAt: view.compactionAt,
          });
        }
      });

      /**
       * The ids this process has already sent into each session, so a retry sends once.
       *
       * **The dedupe is ours and not OpenCode's**, which is the opposite of what the `id`
       * on the wire suggests. The id is passed — T3 Code derives one for exactly this
       * reason (DECISIONS.md §24.1) — and what the server does with a repeat of it is not
       * something this build has measured. `AgentHarness.prompt` promises "the same message
       * id is delivered at most once", so the promise is kept where it can be checked.
       *
       * Per session and unbounded for the life of the process, like the credential
       * registry: a conversation's worth of derived ids, bounded by the work actually done.
       */
      const delivered = new Map<string, Set<string>>();

      /**
       * Gives a session its opening prompt, or a second message into a live one.
       *
       * ## What a steer does here, and the one thing this driver cannot tell us
       *
       * `delivery` is OpenCode's own field (`SessionPromptInput.delivery`, the literals
       * `steer | queue`), and DECISIONS.md §24.1 measured both: the directive arrives as a
       * second `session.inbox.enqueued` **inside the same `session.execution`**, promoted
       * at a step boundary — after step 1 of 2 for `steer`, after step 9 of 10 for `queue`.
       * One `session.wait` covers both turns, which is why `waitForIdle` needs no change on
       * this driver.
       *
       * **What it cannot do is refuse a steer that arrived too late.** The same spike:
       * OpenCode never refuses a prompt for being busy or for being finished — prompting an
       * idle session starts a **new execution** — so a steer that lost the race against
       * settlement would silently become unsupervised work. There is nothing to check here:
       * this process holds no live-session state for an OpenCode session, and asking
       * `session.get` first would be a read that is stale by the time the prompt lands. The
       * claim that makes the window small is `plan/planSupervisor.ts`'s, taken before the
       * prompt and released only by the round's own finalizer, and that is the only
       * protection on this driver. It is stated here because this is where a reader would
       * look for it.
       */
      const prompt: AgentHarness["Service"]["prompt"] = Effect.fn(
        "openCodeHarness.prompt",
      )(function* (sessionId, text, delivery = OPEN_PROMPT, attached) {
        /*
         * The files (A6 F9): a path line each on the text, and an image or PDF also as a
         * file part, which OpenCode reads off disk itself (a `file://` uri, its own
         * composer's form) and stores in the message with its type.
         */
        const words =
          attached === undefined
            ? text
            : withAttachmentLines(
                text,
                attached.attachments,
                attached.uploadsFolder,
              );
        const files = (attached?.attachments ?? [])
          .filter(inlinesOnOpenCode)
          .map((file) => ({
            uri: pathToFileURL(file.path).href,
            name: file.name,
          }));
        if (delivery._tag === "steer") {
          const sent = delivered.get(sessionId) ?? new Set<string>();
          if (sent.has(delivery.messageId)) return { delivered: false };
          sent.add(delivery.messageId);
          delivered.set(sessionId, sent);
        }
        yield* bounded(
          "session.prompt",
          timeouts.control,
          api.session.prompt({
            sessionID: sessionId as Session.ID,
            text: words,
            ...(files.length === 0 ? {} : { files }),
            // Spread rather than passed as `undefined` for `parentID`'s reason: an absent
            // field is the server's own default, and the opening prompt deliberately takes
            // it. §24.1 reports that the server resolved an omitted `delivery` to `steer`
            // and said so on the inbox record it answered with — which is harmless for a
            // first prompt, since there is nothing in flight to cut off.
            ...(delivery._tag === "open"
              ? {}
              : {
                  // A `steer` is read once the message being written ends, not mid-reply
                  // (measured, A6 U6 review): see `SendNowTiming` in the web app for what
                  // the operator is told, and its V2(chat) note for cutting in.
                  delivery:
                    delivery.urgency === "preemptive" ? "steer" : "queue",
                  // The derived id in OpenCode's own space: `msg_` plus the hex. The brand
                  // checks only that prefix.
                  id: openCodeMessageId(
                    delivery.messageId,
                  ) as SessionMessage.ID,
                }),
          }),
        );
        return { delivered: true };
      });

      /**
       * Blocks until the session settles.
       *
       * A failure here means the outcome is **uncertain**, not that execution stopped: the
       * wait call losing its connection, or being interrupted, says nothing about the
       * harness (DECISIONS.md §15 "Recovery"). Callers must reconcile against
       * `sessionStatus` and must never resubmit the prompt.
       */
      const waitForIdle: AgentHarness["Service"]["waitForIdle"] = Effect.fn(
        "openCodeHarness.waitForIdle",
      )(function* (sessionId) {
        yield* bounded(
          "session.wait",
          timeouts.wait,
          api.experimental.session.wait({ sessionID: sessionId as Session.ID }),
        );
      });

      /**
       * Whether the session's recorded outcome is its most recent execution's.
       *
       * {@link ExecutionTimes} carries the reasoning and why this does not go through the
       * generated client. What is decided here is the **failure direction**, and it is the
       * one thing about this read that a caller depends on:
       *
       * **Every failure answers `true` — believe the outcome.** A transport failure, a
       * non-2xx, a body in a shape this does not understand: each leaves this back at the
       * behaviour before the fix, which under-continues. The alternative — treating an
       * unreadable timestamp as evidence that a recorded outcome is stale — would let one
       * flaky GET turn a settled attempt into `uncertain`, bump its fence and revoke its
       * credential, and on the continuation path prompt a model about work that finished.
       * That is the direction this whole file refuses to fail in.
       *
       * So it is `Effect.Effect<boolean>` with no error channel, and it is **advisory**:
       * {@link sessionStatus}'s existing answers cannot be made worse by it, only
       * narrowed. A failure is logged rather than swallowed, because a build whose every
       * status read silently reverted to the defect should be visible in a log.
       *
       * Not bounded by `timeouts.control` through `bounded`, which maps into the harness
       * error taxonomy this has no channel for — the timeout is applied directly and joins
       * the other failures at `true`.
       */
      const outcomeIsCurrent = (sessionId: string): Effect.Effect<boolean> =>
        http
          .get(`${server.baseUrl}/api/session/${encodeURIComponent(sessionId)}`)
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionTimes)),
            Effect.map((body) => outcomeIsLastTurns(body.data.time)),
            Effect.timeout(timeouts.control),
            Effect.tapError((cause) =>
              Effect.logWarning(
                "could not read a session's execution timestamps, so its recorded outcome is being read as its last turn's",
                {
                  sessionId,
                  detail:
                    cause instanceof Error ? cause.message : String(cause),
                },
              ),
            ),
            Effect.orElseSucceed(() => true),
          );

      /**
       * Whether a turn is in flight, and how the last completed one ended.
       *
       * ## Why this asks twice, and why `session.active` is asked first
       *
       * `session.get`'s `outcome` is `session_v2.idle_outcome`, and **two different
       * states leave it unset or stale**, both verified against OpenCode's own projector
       * (`core/src/session/projector.ts`):
       *
       * - `projectIdle` returns early for `Execution.Interrupted` with
       *   `reason === "shutdown"`, writing neither the outcome nor `time_idle`. That is the
       *   *graceful* path: `coordinator.interrupt` defaults its reason to `"shutdown"`, so
       *   a server whose scope closes — ours, on every clean restart — tears its executions
       *   down and records nothing. (An interrupt through the API is tagged `"user"` and
       *   does write an outcome.) An unclean death writes nothing either, for the duller
       *   reason that no event is ever published.
       * - `Execution.Started` sets `time_busy` and **does not clear `idle_outcome`**, so a
       *   session in its second turn reports the first turn's outcome.
       *
       * Reading `outcome` alone therefore answers "running" for a session nothing is
       * running, and answers turn one for turn two. This used to do exactly that, and
       * `recovery/harnessStatus.ts` turned the first of those into a `still_running`
       * attempt row that nothing would ever settle.
       *
       * **Each of those two states needs its own question, and that is why there are two
       * reads beside `session.get`.** `session.active` answers the first. The second —
       * which turn the column's outcome belongs to — is `time.busy` against `time.idle`,
       * read through {@link outcomeIsCurrent} because the pinned schema does not declare
       * `busy`; {@link ExecutionTimes} carries that reasoning. Dropping the outcome while
       * `activity` is `running` covers only the in-flight half of the staleness, and after
       * a restart nothing is running, which is how an interrupted second turn came to
       * report turn one's `succeeded` and be left alone.
       *
       * `GET /api/session/active` is the fix and it is the server's own answer rather than
       * an inference: *"foreground Session drains currently owned by this OpenCode
       * process. Sessions absent from the result are inactive"*, backed by
       * `SessionExecution.active`, which snapshots the coordinator's live executions. A
       * session the server is not executing is not running, whatever its row says — and a
       * restarted server is executing nothing, because the sweep that would resume
       * suspended sessions is attached only under `--service` (`server/src/process.ts`
       * gates `installRestartContinuity` on a `lifecycle`, and `cli/src/server-process.ts`
       * passes one only in service mode). We spawn `serve --stdio`.
       *
       * **The order is load-bearing.** `active` is read *before* `get`, so a turn that
       * terminalises between the two reads is reported as still running rather than as a
       * session with no outcome and nothing running it. That errs towards "ask again",
       * which recovery is built for; the other order errs towards "abandoned", which
       * fences a live attempt. The normal settle path is unaffected either way:
       * `waitForIdle` is `session.wait`, which resolves on `awaitIdle` — "resolves once
       * this process owns no active execution" — so by the time the supervisor asks, the
       * session has already left `active` and the outcome it reads is the real one. The
       * timestamp read does not move that either: the terminal that wrote the outcome
       * advanced `time_idle` past `time_busy` in the same transition, so a turn that
       * completed normally reads as the current one.
       *
       * Each read is bounded on its own; a caller that wants the set bounded wraps the
       * call, as `run/supervisor.ts`'s settle does. The third one is asked only when it
       * can change the answer — an outcome is recorded and nothing is running — so a
       * session that never recorded anything still costs two.
       *
       * One limit, stated because it is the honest reading of "owned by this OpenCode
       * process": the sessions live in one SQLite file under the user's data directory, so
       * a *different* opencode process could in principle be executing a session of ours
       * and this server would not see it in `active`. The answer would then be "idle with
       * no outcome", which reaches `uncertain` — our authority revoked over work that may
       * continue. That is the same disposition as an unreachable harness and the right
       * direction to fail in; the opposite assumption is the defect above.
       */
      const sessionStatus: AgentHarness["Service"]["sessionStatus"] = Effect.fn(
        "openCodeHarness.sessionStatus",
      )(function* (sessionId) {
        const active = yield* bounded(
          "session.active",
          timeouts.control,
          api.session.active(),
        );
        // `Object.hasOwn` and not a property read: the answer is a record keyed by session
        // id, and a decoded object still inherits `Object.prototype`, so a plain lookup
        // would answer for a key like `constructor`. Session ids are `ses_`-prefixed and
        // cannot collide today — this is the check that does not depend on that staying
        // true. Presence *is* the answer: "sessions absent from the result are inactive".
        const running = Object.hasOwn(active, sessionId);
        const session = yield* bounded(
          "session.get",
          timeouts.control,
          api.session.get({ sessionID: sessionId as Session.ID }),
        );
        const recorded = (session as { outcome?: unknown }).outcome;
        const outcome = Schema.is(TerminalOutcome)(recorded)
          ? recorded
          : undefined;
        /*
         * Reported only when it is the *last* turn's, which takes two checks rather than
         * one and neither covers the other.
         *
         * `running` is the in-flight half: `Execution.Started` leaves the column alone, so
         * whatever is in it belongs to a turn that has already finished and reporting it
         * would answer about the wrong turn.
         *
         * `outcomeIsLastTurns` is the half that only shows **after a restart**, when
         * nothing is running and the in-flight check therefore passes. A session
         * interrupted on its second turn reports turn one's `succeeded`, which read as "the
         * harness stated how this session's last turn ended" and left the interrupted turn
         * alone — the single thing that narrowed S7's continuation to first-turn
         * interruptions.
         *
         * Asked **only when it can change the answer**: no outcome to doubt, or a turn in
         * flight, and nothing is read. So the extra round trip is one bounded GET on
         * loopback, skipped entirely for a session that never recorded anything.
         *
         * **`sessionStatus` is polled** (A6 U6): a chat watching its session asks the
         * activity route about once a second (`IMPORT_POLL_MS` in the web app) while a turn
         * or background work runs, and each ask is a `session.active` and a `session.get`
         * here. This third read is not among them: a running session skips it, and the
         * watch stops at the first answer that says nothing runs, so it is paid about once
         * per watched turn — plus the settle and recovery paths, which ask as before.
         */
        const current =
          running || outcome === undefined
            ? true
            : yield* outcomeIsCurrent(sessionId);
        return {
          activity: running ? "running" : "idle",
          outcome: running || !current ? undefined : outcome,
          cost: session.cost,
          tokens: session.tokens as Record<string, unknown> | undefined,
        };
      });

      /**
       * Whether the server still has this session to prompt, and the directory it runs in.
       *
       * **`session.get`, reading `location.directory` and deliberately not `outcome`.**
       * Nothing here touches the outcome, and that separation is still the right one even
       * now that {@link sessionStatus} reads it honestly: "how did this session's last turn
       * end" and "is this conversation still there to talk to" are two questions, and this
       * one needs no active-sessions read at all. The question asked is only whether the row
       * is there, which is the question `session.prompt` will put to the same server a
       * moment later. (It used to be the *only* safe question, because `sessionStatus`
       * answered "running" for a restarted server's idle session; that is fixed, and this
       * is unchanged by the fix.)
       *
       * The directory is reported because it is the one thing that can make a resume fail
       * after the lookup succeeds: OpenCode resolves a prompt through the session's *stored*
       * directory and answers `LocationNotFoundError` for one that no longer exists. The
       * caller is the only thing that knows whether that path is a directory it is prepared
       * to gate and to recreate, so it gets the path rather than a verdict.
       *
       * A `404` is an answer — the session is gone, and on this driver that means the
       * database no longer holds it — while any other failure is a failure: "we could not
       * ask" must not read as "it is not there".
       */
      const sessionContinuation: AgentHarness["Service"]["sessionContinuation"] =
        Effect.fn("openCodeHarness.sessionContinuation")(function* (sessionId) {
          const asked = yield* Effect.result(
            bounded(
              "session.get",
              timeouts.control,
              api.session.get({ sessionID: sessionId as Session.ID }),
            ),
          );
          if (asked._tag === "Failure") {
            if (asked.failure.status === 404) {
              return {
                _tag: "unresumable",
                detail: `this OpenCode server holds no session ${sessionId}; its sessions live in one database under the user's data directory, so a session it cannot find has been deleted rather than merely not loaded`,
              };
            }
            return yield* Effect.fail(asked.failure);
          }
          return {
            _tag: "resumable",
            directory: asked.success.location.directory,
            detail: `OpenCode still holds session ${sessionId}, so the conversation can be carried on with an ordinary prompt`,
          };
        });

      /**
       * What OpenCode calls a session: the row's `title`, read by `session.get`.
       *
       * One bounded read per id, not `session.list`: that endpoint pages over every session
       * the server holds, newest first, and is not a lookup — see the seam.
       *
       * A `404` is `forgotten`, as in {@link sessionContinuation}, and any other failure is
       * a failure. An absent or blank `title` is `untitled`, and so is **OpenCode's own
       * placeholder**: a session created without a title is shown as `New session - <ISO
       * time>` (`Child session - …` under a parent) until its first turn earns a generated
       * one. That string is OpenCode's date, not a name, and `@opencode/util`'s
       * `session-title-fallback.ts` recognises it with exactly this pattern.
       *
       * **What this does not filter is the title the caller gave the session.** OpenCode
       * keeps a `title` passed to `session.create` and only generates one for a session that
       * has none (`SessionTitle.isUntitled` in `packages/core/src/session/runner/llm.ts`), so
       * a session this server named answers with that name for ever. It is reported as
       * `titled` because it *is* the session's title; recognising it as the caller's own
       * words is the caller's business, and `import/importerTitle.ts` does it for the
       * importer.
       */
      const sessionTitle: AgentHarness["Service"]["sessionTitle"] = Effect.fn(
        "openCodeHarness.sessionTitle",
      )(function* (sessionId) {
        const asked = yield* Effect.result(
          bounded(
            "session.get",
            timeouts.control,
            api.session.get({ sessionID: sessionId as Session.ID }),
          ),
        );
        if (asked._tag === "Failure") {
          if (asked.failure.status === 404) {
            return {
              _tag: "forgotten",
              detail: `this OpenCode server holds no session ${sessionId}`,
            } satisfies SessionTitle;
          }
          return yield* Effect.fail(asked.failure);
        }
        const title = asked.success.title;
        return title === undefined ||
          title.trim() === "" ||
          OPENCODE_PLACEHOLDER_TITLE.test(title)
          ? ({ _tag: "untitled" } satisfies SessionTitle)
          : ({ _tag: "titled", title } satisfies SessionTitle);
      });

      /**
       * The session's messages, oldest first, all of them.
       *
       * ## Why this asks for an order and walks the cursor
       *
       * `message.list` with no arguments answers **the newest 50, newest first**
       * (`packages/server/src/handlers/message.ts`: `order ?? "desc"`, `limit ?? 50`).
       * This used to call it bare and map the one page it got back, so for any session
       * past 50 messages the seam returned a silently truncated, reversed list - and
       * `lastAssistantText`, which scans from the end, read the *oldest* reply it was
       * given. Confirmed against a live `opencode` 2.2.5 on 2026-11-02: a session of 246
       * messages answered 50, newest first, and the scope importer's helper named an
       * earlier reply than the last one.
       *
       * - **`order: "asc"` is sent, not assumed.** The default has already changed once
       *   (commit `fe0c4f8c74`, 2026-06-06), and a default is not a promise.
       * - **The cursor is followed to the end, inside this function.** The seam promises
       *   `readonly MessageEntry[]`, and every caller - the transcript, both narrations,
       *   the importer's report - reads that as the whole log. Putting the cursor on the
       *   seam would make each of them page, and Claude Code has no cursor to offer. The
       *   cost of doing it here is that a very long session is buffered whole before any
       *   caller sees a byte, which `run/transcript.ts` already states as true of the
       *   fetch, and which each caller bounds on its own side.
       * - **Only the first page carries `order`.** The server refuses a request that has
       *   both a `cursor` and an `order` (`InvalidCursorError`): the order is encoded in
       *   the cursor, so every later page inherits it.
       * - **The end is an empty page, not a short one.** A server is free to cap `limit`
       *   below what was asked, and a short page would then be mistaken for the last. It
       *   costs one extra request.
       * - **A ceiling that fails, rather than a cap that truncates.** A cursor that never
       *   runs dry would otherwise loop for ever. Past {@link MESSAGE_PAGE_CEILING} pages
       *   this reports a decode failure, because a silent stop is exactly the defect this
       *   replaces.
       *
       * Each page is bounded by the control timeout on its own; a caller that wants the
       * whole walk bounded wraps the call, as the transcript and narration paths do.
       */
      const messages: AgentHarness["Service"]["messages"] = Effect.fn(
        "openCodeHarness.messages",
      )(function* (sessionId, read) {
        const entries: MessageEntry[] = [];
        // One read's sub-agents, across its pages: a notice names its child, not its call.
        // Stoppable from here only for a session this process watches (A7-S).
        const subagents = openCodeSubagents(streamedSubagents.has(sessionId));
        // One reader across the pages too: each folder's realpath is asked once.
        const readAttachments = attachmentReader({
          uploadsFolder: read?.uploadsFolder,
        });
        let cursor: string | undefined;
        for (let page = 0; page < MESSAGE_PAGE_CEILING; page += 1) {
          const listed = yield* bounded(
            "message.list",
            timeouts.control,
            api.message.list({
              sessionID: sessionId as Session.ID,
              limit: MESSAGE_PAGE_SIZE,
              ...(cursor === undefined ? { order: "asc" } : { cursor }),
            }),
          );
          if (listed.data.length === 0) {
            return yield* withChildren(sessionId, entries, subagents);
          }
          for (const entry of listed.data) {
            entries.push(flatten(entry, readAttachments, subagents));
          }
          const next = listed.cursor.next;
          if (typeof next !== "string") {
            return yield* withChildren(sessionId, entries, subagents);
          }
          cursor = next;
        }
        return yield* new HarnessDecodeError({
          operation: "message.list",
          status: undefined,
          detail: `the cursor did not run out in ${String(MESSAGE_PAGE_CEILING)} pages of ${String(MESSAGE_PAGE_SIZE)}; stopped rather than return a truncated list`,
          cause: undefined,
        });
      });

      /**
       * A replay's sub-agents filled in from their child sessions (A7-S): each child's
       * messages read for its card's lines, count and words, and every state of a sub-agent
       * drawn as what is known of it now — the session's stream's, for one still running
       * when the page reloads. A child that cannot be read leaves its card as the parent's
       * messages drew it.
       */
      const withChildren = (
        sessionId: string,
        entries: readonly MessageEntry[],
        subagents: OpenCodeSubagents,
      ): Effect.Effect<MessageEntry[]> =>
        Effect.gen(function* () {
          if (subagents.calls.size === 0) return [...entries];
          replayedSubagents.set(sessionId, subagents);
          const streamed = streamedSubagents.get(sessionId);
          yield* Effect.forEach(
            [...subagents.calls].filter(
              ([callId, call]) =>
                call.child !== undefined &&
                streamed?.calls.get(callId)?.seen === undefined,
            ),
            ([, call]) =>
              Effect.matchEffect(
                bounded(
                  "message.list",
                  timeouts.control,
                  api.message.list({
                    sessionID: call.child as Session.ID,
                    limit: MESSAGE_PAGE_SIZE,
                    order: "asc",
                  }),
                ),
                {
                  onFailure: (failure) =>
                    Effect.logWarning(
                      "a sub-agent's child session could not be read; its card shows what the parent's messages hold",
                      { sessionId, child: call.child, detail: failure.message },
                    ),
                  onSuccess: (listed) =>
                    Effect.sync(() => readChildMessages(call, listed.data)),
                },
              ),
            { concurrency: 4, discard: true },
          );
          const live = subagents.live ?? false;
          return newestSubagents(entries, (callId) => {
            const call =
              streamed?.calls.get(callId) ?? subagents.calls.get(callId);
            return call === undefined
              ? undefined
              : openCodeSubagentState(callId, call, live);
          });
        });

      /**
       * How full one session's window is (A6 U9). See `AgentHarness.contextUsage`.
       *
       * The newest stored call, read newest first a page at a time until one is found
       * ({@link openCodeContext}) — one request for any session that has run — and the
       * catalogue's window for the model the caller says the session is on now, so a switch
       * moves the window before the next call is made. OpenCode stores every session, so a
       * session this process does not hold answers the same. No categories: OpenCode
       * publishes none.
       *
       * V2(chat): OpenCode gives tokens per call and a window per model, and nothing per
       * category, so V1's meter shows the total and the window with a line saying the
       * harness gives no breakdown. V2 could estimate one from the session's own parts
       * (system prompt, tool schemas, messages by role), labelled as bit's estimate.
       */
      const contextUsage: AgentHarness["Service"]["contextUsage"] = Effect.fn(
        "openCodeHarness.contextUsage",
      )(function* (sessionId, read) {
        const window =
          models.find((model) => model.id === read.model)?.contextLimit ??
          contextLimits.get(sessionId)?.contextLimit ??
          null;
        const breakdown = {
          _tag: "none",
          reason: "harness_gives_none",
        } as const;
        let cursor: string | undefined;
        for (let page = 0; page < MESSAGE_PAGE_CEILING; page += 1) {
          const listed = yield* bounded(
            "message.list",
            timeouts.control,
            api.message.list({
              sessionID: sessionId as Session.ID,
              limit: MESSAGE_PAGE_SIZE,
              ...(cursor === undefined ? { order: "desc" } : { cursor }),
            }),
          );
          const found = openCodeContext(listed.data);
          if (found !== undefined) return { ...found, window, breakdown };
          const next = listed.cursor.next;
          if (listed.data.length === 0 || typeof next !== "string") break;
          cursor = next;
        }
        return {
          used: null,
          usedModel: null,
          window,
          reading: "no_call_yet",
          breakdown,
        };
      });

      const interruptSession: AgentHarness["Service"]["interruptSession"] =
        Effect.fn("openCodeHarness.interruptSession")(function* (sessionId) {
          const result = yield* bounded(
            "session.interrupt",
            timeouts.control,
            api.session.interrupt({ sessionID: sessionId as Session.ID }),
          );
          return result.interrupted;
        });

      /**
       * Interrupts one sub-agent's child session (A7-S). Measured on 2.2.5 (Step 0):
       * `interrupted: true` in ~10 ms; a foreground call then fails `Subagent cancelled
       * (sessionID: …)` and the parent's turn goes on, a background one's `cancelled` notice
       * wakes the parent. So the agent is told by the harness, as on Claude Code.
       */
      const stopSubagent: AgentHarness["Service"]["stopSubagent"] = Effect.fn(
        "openCodeHarness.stopSubagent",
      )(function* (sessionId, callId) {
        const call =
          streamedSubagents.get(sessionId)?.calls.get(callId) ??
          replayedSubagents.get(sessionId)?.calls.get(callId);
        if (
          call === undefined ||
          call.status !== "running" ||
          call.child === undefined
        ) {
          return "not_running" as const;
        }
        const result = yield* bounded(
          "session.interrupt",
          timeouts.control,
          api.session.interrupt({ sessionID: call.child as Session.ID }),
        );
        return result.interrupted
          ? ("stopped" as const)
          : ("not_running" as const);
      });

      /**
       * Interrupts every running sub-agent's child session (E7's Stop all), before the
       * parent's own Stop. The parent's interrupt reaches a foreground child too (the tool's
       * `onInterrupt` interrupts it), but **not a background one**, which runs as an
       * execution of its own; so each is asked here. A child that will not answer fails the
       * whole: Stop all says so rather than claim everything stopped.
       */
      const stopSubagents: AgentHarness["Service"]["stopSubagents"] = Effect.fn(
        "openCodeHarness.stopSubagents",
      )(function* (sessionId) {
        const known =
          streamedSubagents.get(sessionId) ?? replayedSubagents.get(sessionId);
        const running = [...(known?.calls ?? new Map())].filter(
          ([, call]) => call.status === "running" && call.child !== undefined,
        );
        const stopped = yield* Effect.forEach(
          running,
          ([callId]) =>
            Effect.map(stopSubagent(sessionId, callId), (answer) =>
              answer === "stopped" ? [callId] : [],
            ),
          { concurrency: "unbounded" },
        );
        return stopped.flat();
      });

      /**
       * The forms this process answered or dismissed, by id, so the event that follows
       * narrates who settled it (`openCodeNarration`'s `settledHere`). Bounded by the
       * questions the operator settles in this process's life.
       *
       * V2(chat): never trimmed. One entry per settled question is a few bytes; a process
       * that lived for years would still hold them all.
       */
      const settledHere = new Map<string, QuestionSettlement>();

      /**
       * A form call refused because the form is no longer waiting, as the seam's refusal:
       * `FormAlreadySettledError` and `FormNotFoundError` are settled — answered, cancelled,
       * or gone with an OpenCode restart, since forms live in its memory — and
       * `FormInvalidAnswerError` is the server refusing the answers themselves.
       */
      const formRefusal =
        (questionId: string) =>
        (
          failure: HarnessTransportError | HarnessDecodeError,
        ): Effect.Effect<
          never,
          HarnessTransportError | HarnessDecodeError | QuestionNotPending
        > => {
          const tag =
            failure._tag === "HarnessTransportError" ? failure.tag : undefined;
          if (
            tag === "FormAlreadySettledError" ||
            tag === "FormNotFoundError" ||
            tag === "SessionNotFoundError"
          ) {
            return Effect.fail(
              new QuestionNotPending({
                questionId,
                reason: "settled",
                detail: `OpenCode is not waiting on form ${questionId} any more: it was answered or cancelled, or OpenCode restarted and forgot it (${tag}).`,
              }),
            );
          }
          if (tag === "FormInvalidAnswerError") {
            return Effect.fail(
              new QuestionNotPending({
                questionId,
                reason: "invalid",
                detail: `OpenCode refused the answers to form ${questionId}: ${failure.message}`,
              }),
            );
          }
          return Effect.fail(failure);
        };

      const pendingQuestions: AgentHarness["Service"]["pendingQuestions"] =
        Effect.fn("openCodeHarness.pendingQuestions")(function* (sessionId) {
          const forms = yield* bounded(
            "session.form.list",
            timeouts.control,
            api.session.form.list({ sessionID: sessionId }),
          ).pipe(
            // A session the server does not have waits on nothing.
            Effect.catchIf(
              (failure) =>
                failure._tag === "HarnessTransportError" &&
                (failure.tag === "SessionNotFoundError" ||
                  failure.status === 404),
              () => Effect.succeed([] as readonly unknown[]),
            ),
          );
          return forms.flatMap((form) => {
            const question = openCodeQuestionOf(form);
            return question === undefined ? [] : [question];
          });
        });

      /** One pending question form of this session, read back, or the seam's refusal. */
      const pendingForm = (sessionId: string, questionId: string) =>
        Effect.flatMap(pendingQuestions(sessionId), (questions) => {
          const question = questions.find(
            (candidate) => candidate.questionId === questionId,
          );
          return question === undefined
            ? Effect.fail(
                new QuestionNotPending({
                  questionId,
                  reason: "settled",
                  detail: `OpenCode is not waiting on question ${questionId} in session ${sessionId}: it was answered or cancelled, or OpenCode restarted and forgot it.`,
                }),
              )
            : Effect.succeed(question);
        });

      const answerQuestion: AgentHarness["Service"]["answerQuestion"] =
        Effect.fn("openCodeHarness.answerQuestion")(
          function* (sessionId, questionId, answers) {
            const question = yield* pendingForm(sessionId, questionId);
            settledHere.set(questionId, "answered");
            yield* bounded(
              "session.form.reply",
              timeouts.control,
              api.session.form.reply({
                sessionID: sessionId,
                formID: questionId as Form.ID,
                answer: openCodeFormAnswer(question, answers),
              }),
            ).pipe(Effect.catch(formRefusal(questionId)));
          },
        );

      /**
       * Cancels the form **with a message**, which is what makes it a dismissal the agent is
       * told about: OpenCode 2.2.5's question tool fails with the message as model-facing
       * feedback and the model carries on, where a cancel without one ends the step
       * (`core/src/tool/plugin/question.ts`).
       */
      const dismissQuestion: AgentHarness["Service"]["dismissQuestion"] =
        Effect.fn("openCodeHarness.dismissQuestion")(
          function* (sessionId, questionId) {
            settledHere.set(questionId, "dismissed");
            yield* bounded(
              "session.form.cancel",
              timeouts.control,
              api.session.form.cancel({
                sessionID: sessionId,
                formID: questionId as Form.ID,
                message: QUESTION_DISMISSED_MESSAGE,
              }),
            ).pipe(
              Effect.catch(formRefusal(questionId)),
              Effect.tapError(() =>
                Effect.sync(() => {
                  settledHere.delete(questionId);
                }),
              ),
            );
          },
        );

      /**
       * Whether an operator message is waiting in the session's inbox, which is where
       * OpenCode keeps one held across an interrupt (`AgentHarness.holding`).
       *
       * The inbox lists what has been admitted and not yet delivered into the transcript;
       * a message that started running is no longer in it. Only `user` items count: a
       * `synthetic`, `compaction` or `move` item is OpenCode's own and not something the
       * operator sent.
       */
      const holding: AgentHarness["Service"]["holding"] = Effect.fn(
        "openCodeHarness.holding",
      )(function* (sessionId) {
        const waiting = yield* bounded(
          "session.inbox.list",
          timeouts.control,
          api.session.inbox.list({ sessionID: sessionId as Session.ID }),
        );
        return waiting.some((item) => item.type === "user");
      });

      /**
       * Empties the session, then stops it: every inbox item still waiting is cancelled, and
       * the execution in flight is interrupted (A6 F5).
       *
       * OpenCode keeps a session in its own database whether or not bit holds it, so a
       * conversation bit has let go of is not over until it is emptied. **Cancelled before
       * interrupted**: an interrupt leaves a queued message held in the inbox (measured;
       * `AgentHarness.interruptSession`), and a turn that finished on its own between the
       * two calls would go straight on to one. Listing what is waiting and cancelling each is
       * the server's own API (`session.inbox.cancel` is documented as a no-op for an item
       * already delivered), so a race with delivery costs nothing.
       *
       * A session the server does not have (404) is already ended: nothing of it can run.
       *
       * **A superseded ref ends nothing.** When a later `createSession` has handed out a ref
       * for the same id — a resume that opened while this opening was closing — the
       * session's one execution belongs to that later opening, and emptying it here would
       * cancel the operator's newer messages. A ref this process never handed out (a session
       * opened by a process before it) is ended as asked: nothing newer here can hold it.
       *
       * **Its running children are stopped first** (A7-S review 1). The parent's interrupt
       * reaches a foreground child, not a background one, which runs as an execution of its
       * own and went on making calls after the import ended. So every child session the
       * server lists for this one (`session.list` by `parentID`, which covers a child the
       * stream never saw) that `session.active` says is running is interrupted, and the end
       * then waits, at most {@link CHILD_NOTICE_SETTLE}, for each stopped background child's
       * notice to be in: a notice that came after the parent's interrupt would wake it for a
       * turn of its own ({@link CHILD_NOTICE_SETTLE}). Only then is the inbox emptied and the
       * parent interrupted, which cancels the notices or stops the turn they woke. A child
       * list or a child's interrupt that fails is logged and the end goes on: the parent
       * still has to be stopped.
       */
      const endSession: AgentHarness["Service"]["endSession"] = Effect.fn(
        "openCodeHarness.endSession",
      )(function* (session) {
        const latest = latestRef.get(session.id);
        if (latest !== undefined && latest !== session) return;
        const sessionID = session.id as Session.ID;
        const first = yield* Effect.result(
          bounded(
            "session.inbox.list",
            timeouts.control,
            api.session.inbox.list({ sessionID }),
          ),
        );
        if (first._tag === "Failure") {
          if (first.failure.status === 404) return;
          return yield* Effect.fail(first.failure);
        }
        const since = Date.now();
        const stopped = yield* stopRunningChildren(session.id);
        const missing =
          stopped.length === 0
            ? []
            : yield* awaitChildNotices(session.id, stopped, since);
        if (missing.length > 0) {
          yield* Effect.logWarning(
            "a background sub-agent stopped at the end of its session had not told its parent yet; the parent is interrupted anyway, and may wake once more for that notice",
            { sessionId: session.id, children: missing },
          );
        }
        const waiting =
          stopped.length === 0
            ? first.success
            : yield* bounded(
                "session.inbox.list",
                timeouts.control,
                api.session.inbox.list({ sessionID }),
              );
        yield* Effect.forEach(
          waiting,
          (item) =>
            bounded(
              "session.inbox.cancel",
              timeouts.control,
              api.session.inbox.cancel({ sessionID, inboxID: item.id }),
            ),
          { discard: true },
        );
        yield* bounded(
          "session.interrupt",
          timeouts.control,
          api.session.interrupt({ sessionID }),
        );
        // Nothing of this session runs here now, so nothing of its sub-agents is live.
        streamedSubagents.delete(session.id);
        replayedSubagents.delete(session.id);
      });

      /**
       * Interrupts every child session of `sessionId` that is running now, and answers the
       * ones that were, less those known to be foreground (whose end tells no one: the
       * parent's call fails instead). See {@link endSession}.
       */
      const stopRunningChildren = (
        sessionId: string,
      ): Effect.Effect<string[]> =>
        Effect.gen(function* () {
          const known = [
            streamedSubagents.get(sessionId),
            replayedSubagents.get(sessionId),
          ].flatMap((subagents) => [...(subagents?.calls.values() ?? [])]);
          const foreground = new Set(
            known.flatMap((call) =>
              call.child !== undefined && !call.background ? [call.child] : [],
            ),
          );
          const children = new Set(
            known.flatMap((call) =>
              call.child === undefined ? [] : [call.child],
            ),
          );
          const listed = yield* Effect.result(
            bounded(
              "session.list",
              timeouts.control,
              api.session.list({
                parentID: sessionId as Session.ID,
                limit: CHILD_LIST_LIMIT,
              }),
            ),
          );
          if (listed._tag === "Success") {
            for (const child of listed.success.data) children.add(child.id);
          } else {
            yield* Effect.logWarning(
              "an ending session's child sessions could not be listed; only the sub-agents bit saw are stopped",
              { sessionId, detail: listed.failure.message },
            );
          }
          if (children.size === 0) return [];
          const active = yield* Effect.result(
            bounded("session.active", timeouts.control, api.session.active()),
          );
          // Not knowing which run, each is asked: an interrupt of an idle session is a no-op.
          const running = [...children].filter(
            (child) =>
              active._tag === "Failure" || Object.hasOwn(active.success, child),
          );
          const answered = yield* Effect.forEach(
            running,
            (child) =>
              bounded(
                "session.interrupt",
                timeouts.control,
                api.session.interrupt({ sessionID: child as Session.ID }),
              ).pipe(
                Effect.map((result) =>
                  result.interrupted && !foreground.has(child) ? [child] : [],
                ),
                Effect.catch((failure) =>
                  Effect.as(
                    Effect.logWarning(
                      "a running sub-agent of an ending session would not stop; it may still be running",
                      { sessionId, child, detail: failure.message },
                    ),
                    [],
                  ),
                ),
              ),
            { concurrency: "unbounded" },
          );
          return answered.flat();
        });

      /**
       * Waits, at most {@link CHILD_NOTICE_SETTLE}, until the parent holds a notice for each
       * stopped child: in its inbox, or already delivered into its newest messages (a notice
       * that woke an idle parent is taken off the inbox at once). Answers the children whose
       * notice never came. A read that fails counts as not yet.
       */
      const awaitChildNotices = (
        sessionId: string,
        children: readonly string[],
        since: number,
      ): Effect.Effect<string[]> =>
        Effect.gen(function* () {
          const sessionID = sessionId as Session.ID;
          const deadline = since + CHILD_NOTICE_SETTLE;
          let missing = [...children];
          for (;;) {
            const seen = new Set<string>();
            const inbox = yield* Effect.result(
              bounded(
                "session.inbox.list",
                timeouts.control,
                api.session.inbox.list({ sessionID }),
              ),
            );
            if (inbox._tag === "Success") {
              for (const item of inbox.success) {
                if (item.type !== "synthetic") continue;
                const child = noticeChild(item.payload.metadata);
                if (child !== undefined) seen.add(child);
              }
            }
            if (missing.some((child) => !seen.has(child))) {
              const recent = yield* Effect.result(
                bounded(
                  "message.list",
                  timeouts.control,
                  api.message.list({ sessionID, limit: 20, order: "desc" }),
                ),
              );
              if (recent._tag === "Success") {
                for (const entry of recent.success.data) {
                  const record = entry as {
                    type?: unknown;
                    metadata?: unknown;
                    time?: { created?: unknown };
                  };
                  const created = millisOf(record.time?.created);
                  if (
                    record.type !== "synthetic" ||
                    created === undefined ||
                    created < since - NOTICE_CLOCK_SLACK
                  ) {
                    continue;
                  }
                  const child = noticeChild(record.metadata);
                  if (child !== undefined) seen.add(child);
                }
              }
            }
            missing = missing.filter((child) => !seen.has(child));
            if (missing.length === 0 || Date.now() >= deadline) return missing;
            yield* Effect.sleep(CHILD_NOTICE_POLL);
          }
        });

      /**
       * The session's narration: OpenCode's event stream, filtered and reduced, re-made
       * whenever it breaks (`harness/openCodeEvents.ts`).
       *
       * ## Why the event stream and not `session.log`
       *
       * Both calls exist on the generated client; `session.log({ sessionID, follow: true })`
       * is per session by construction and replays a durable log, which on paper makes it
       * the unambiguous choice. Against a live `opencode` 2.1.2 it carries **no narration
       * at all**: a session that was prompted, ran, replied and settled `succeeded`
       * produced exactly one entry, `log.synced`, both while following and on a
       * non-following replay afterwards. That build's durable per-session log is simply not
       * where execution is written. Checked on 2026-10-24.
       *
       * `event.subscribe()` carries all of it — `session.execution.started`,
       * `session.inbox.*`, `session.step.*`, `session.text.*`, `session.tool.*`,
       * `session.usage.updated` and the terminal
       * `session.execution.{succeeded,failed,interrupted}`.
       *
       * It is one stream for the whole server, so events have to be attributed, but the
       * attribution is a single field read at the same position in every event; see
       * {@link sessionOf}. An event carrying neither field is dropped rather than guessed
       * at — a misattributed entry would publish one target's narration under another's
       * key, which is the one failure worth being strict about.
       *
       * **One subscription per watched session, not one shared and demultiplexed.** N
       * concurrent runs open N streams to a local server, which is a cost worth paying for
       * the lifetime it buys: each belongs to one supervisor fiber and is cancelled at the
       * socket when that fiber is interrupted. Since `@opencode/client` 2.2.5 the generated
       * `event.subscribe()` is one shared subscription, so it is no longer called; the
       * request is this driver's own (`subscribeOpenCodeEvents`), and a failure is one
       * session's, made again for it with a `connection` entry each way (U13 review 5).
       *
       * Not through the `bounded` helper the others use: `bounded` applies
       * `Effect.timeout`, which is the one thing a followed stream must not have. It does
       * not fail at all now; the connection's own failures are what `connection` narrates.
       *
       * `filterMap` rather than `filter` then `map`: an event belonging to another session
       * and an event with no session on it are both dropped by the same step that reads the
       * id, so there is no second place for the two to disagree.
       */
      const sessionEvents: AgentHarness["Service"]["sessionEvents"] = (
        sessionId,
      ) => {
        /**
         * The tool-name join table for this stream, and nothing wider.
         *
         * Created per call, so N concurrent runs have N maps and one run's tool names can
         * never be read for another's call id. {@link openCodeNarration} deletes an entry when the
         * call succeeds or fails, which bounds this by the calls in flight.
         */
        const names = new Map<string, string>();
        /** Each open step's model, for the same stream. See {@link openCodeNarration}. */
        const models = new Map<string, string>();
        /**
         * The sub-agents this stream saw started. See {@link openCodeNarration}. Also what
         * {@link stopSubagent} finds a sub-agent's child session in, and what says which
         * other sessions' events are this one's children's ({@link openCodeChildNarration}).
         */
        const subagents = openCodeSubagents();
        /**
         * The question ids this stream has narrated as waiting and not yet as settled: what
         * a re-list after a break is compared with (A7-Q review 2).
         */
        const waitingHere = new Set<string>();
        const asked = (question: HarnessQuestion): HarnessNarration => ({
          type: "form.created",
          sequence: undefined,
          at: Date.now(),
          outcome: undefined,
          detail: { _tag: "question", question },
        });
        /**
         * The questions the session waits on, as `question` entries, read when the stream
         * is first asked for: a form made before it was. A list that fails here says
         * nothing — this stream knows of nothing yet to keep or drop.
         */
        const pendingFirst = Effect.map(
          Effect.orElseSucceed(pendingQuestions(sessionId), () => []),
          (questions): HarnessNarration[] => questions.map(asked),
        );
        /**
         * The same list read again when a connection comes back (`restored`), for a form
         * made while it was down, **and** a `questionSettled` (`withdrawn`) for each this
         * stream knew waiting that the list no longer holds: settled in the gap, whose own
         * event was never seen. The chat reads the replay on `restored` as well.
         *
         * **A list that fails says nothing** (A7-Q review 2): readers keep what they had,
         * since a list that could not be read is no evidence the agent stopped waiting —
         * Needs you used to restart from it and lose a question still real.
         */
        const pendingAgain = Effect.flatMap(
          Effect.result(pendingQuestions(sessionId)),
          (listed): Effect.Effect<HarnessNarration[]> => {
            if (listed._tag === "Failure") {
              return Effect.as(
                Effect.logWarning(
                  "an OpenCode session's narration is back but its pending questions could not be re-read; what was waiting is kept",
                  { sessionId, detail: listed.failure.message },
                ),
                [],
              );
            }
            const now = new Set(
              listed.success.map((question) => question.questionId),
            );
            const gone = [...waitingHere]
              .filter((id) => !now.has(id))
              .map((questionId): HarnessNarration => ({
                type: "form.relisted",
                sequence: undefined,
                at: Date.now(),
                outcome: undefined,
                detail: {
                  _tag: "questionSettled",
                  questionId,
                  settled: "withdrawn",
                },
              }));
            return Effect.succeed([...gone, ...listed.success.map(asked)]);
          },
        );
        return resubscribing(() =>
          subscribeOpenCodeEvents(http, server.baseUrl),
        ).pipe(
          // Said in the server's log too: the chat is not the only reader that should know
          // a session's narration was cut off.
          Stream.tap((item) =>
            item._tag !== "connection"
              ? Effect.void
              : item.state === "restored"
                ? Effect.logInfo(
                    "an OpenCode session's narration stream is back; what it said meanwhile is in its replay",
                    { sessionId },
                  )
                : Effect.logWarning(
                    item.state === "lost"
                      ? "an OpenCode session's narration stream keeps failing; still trying"
                      : "an OpenCode session's narration stream broke; reconnecting",
                    { sessionId, detail: item.reason },
                  ),
          ),
          Stream.filterMap(
            Filter.make((item: Resubscribed) => {
              if (item._tag === "connection") {
                return Result.succeed(connectionNarration(item, Date.now()));
              }
              const of = sessionOf(item.event);
              if (of !== sessionId) {
                // A child session of a sub-agent this stream saw started (A7-S): read into
                // its card, and nothing else of it narrated.
                const child =
                  of !== undefined && subagents.children.has(of)
                    ? openCodeChildNarration(item.event, subagents)
                    : undefined;
                return child === undefined
                  ? Result.fail(item)
                  : Result.succeed(child);
              }
              return Result.succeed(
                // Read per event rather than once per stream: `switchModel` can
                // move a live session onto a model with another window, and a
                // stream opened before the switch would otherwise draw every later
                // call against the old model's limit. One map lookup per event.
                openCodeNarration(
                  item.event,
                  names,
                  contextLimits.get(sessionId),
                  models,
                  subagents,
                  settledHere,
                ),
              );
            }),
          ),
          // A connection's first event (`server.connected`) is not a session's, so it was
          // filtered out above; a `restored` or the stream's first entry stands for it.
          Stream.flatMap(
            (entry) =>
              entry.detail._tag === "connection" &&
              entry.detail.state === "restored"
                ? Stream.concat(
                    Stream.make(entry),
                    Stream.fromIterableEffect(pendingAgain),
                  )
                : Stream.make(entry),
            { concurrency: 1 },
          ),
          (narrated) =>
            Stream.concat(Stream.fromIterableEffect(pendingFirst), narrated),
          // Last, so it sees every entry as a reader does, the listed ones included.
          Stream.tap((entry) =>
            Effect.sync(() => {
              if (entry.detail._tag === "question") {
                waitingHere.add(entry.detail.question.questionId);
              } else if (entry.detail._tag === "questionSettled") {
                waitingHere.delete(entry.detail.questionId);
              }
            }),
          ),
          /*
           * This stream's sub-agents are the session's live ones **while it runs**, and no
           * longer (A7-S review 1): a replay after it reads each child afresh and offers no
           * Stop, since the stream was what said a call is still running. The stream is the
           * narrator of a session this process holds, interrupted as the session closes; a
           * later stream for the same session replaces the entry, and this one's end leaves
           * that one's alone.
           */
          Stream.onStart(
            Effect.sync(() => {
              streamedSubagents.set(sessionId, subagents);
            }),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              if (streamedSubagents.get(sessionId) === subagents) {
                streamedSubagents.delete(sessionId);
              }
            }),
          ),
        );
      };

      return AgentHarness.of({
        instance,
        newSessionId: newOpenCodeSessionId,
        modelProvenance: openCodeModelProvenance,
        installGate: installOpenCodeGate,
        registerMcpServer,
        unregisterMcpServer,
        createSession,
        switchModel,
        contextUsage,
        prompt,
        waitForIdle,
        sessionStatus,
        sessionContinuation,
        sessionTitle,
        messages,
        interruptSession,
        stopSubagent,
        stopSubagents,
        queuedOnInterrupt: "held",
        holding,
        pendingQuestions,
        answerQuestion,
        dismissQuestion,
        endSession,
        sessionEvents,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
};
