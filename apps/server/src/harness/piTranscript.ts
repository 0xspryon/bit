/**
 * Pi's own records, read: the session file (JSONL v3) as a replay, and the RPC event stream
 * as live narration. Pure: no process, no file system beyond the caller's text.
 *
 * Both readers turn Pi's vocabulary into the seam's (`agentHarness.ts`): a stored message
 * becomes a {@link MessageEntry} whose parts are the same {@link NarrationDetail} cases the
 * live stream narrates, so a reloaded conversation renders as the watched one did.
 *
 * ## The session file (`docs/session-format.md`, Pi 1.5.2)
 *
 * A header line (`{"type":"session","version":3,"id","cwd",…}`), then entries in a tree by
 * `id`/`parentId`. Read here:
 *
 * - **The active branch only**: the path from the last entry back to the root. bit never
 *   branches a session (no `/tree` over RPC), so this is every entry in practice; it is
 *   still the path, because that is what Pi itself replays.
 * - **Version 3 only**, refused loudly otherwise ({@link PiTranscriptError}): Pi migrates
 *   older files when it *loads* them, and a newer one is a format this build has not read.
 * - **A retried call's error is left out.** Pi stores each failed attempt as an assistant
 *   message with `stopReason: "error"` and then a `context_edit` taking it out of the model's
 *   context (measured, a 429 retried three times). Live, those attempts are `retry` status
 *   lines and only the last one's error is a row; the replay keeps that shape.
 * - **An aborted message is the interrupt marker**: Pi stores a cut turn as an assistant
 *   message with `stopReason: "aborted"`. Live it reads {@link PI_INTERRUPT_MARKER_TEXT};
 *   replayed, {@link PI_STOPPED_REPLAY_TEXT}, because the file does not say who cut it.
 *
 * ## The event stream (`docs/json.md`)
 *
 * {@link PiNarrator} holds what one session's stream needs across events: the model call a
 * block belongs to, which blocks have finished, the error a run will end with.
 */
import { Schema } from "effect";

import {
  NARRATION_FIELD_MAX,
  truncateNarration,
  truncateReply,
  type HarnessNarration,
  type MessageEntry,
  type MessagePart,
  type NarrationDetail,
  type TerminalOutcome,
} from "./agentHarness";
import type { AttachmentReader } from "./attachments";

/** The session-file version this build reads. */
export const PI_SESSION_VERSION = 3;

/**
 * How much of a model's window Pi keeps free before it compacts on its own: its default
 * `compaction.reserveTokens` (`docs/compaction.md`: compaction starts when
 * `contextTokens > contextWindow - reserveTokens`, 16 384 by default). The operator's
 * `settings.json` can move it, which bit does not read; see `SessionWindow.compactionAt`.
 */
export const PI_COMPACTION_RESERVE = 16_384;

/** Where Pi compacts on its own for a window of `contextWindow`, by its default. */
export const piCompactionAt = (contextWindow: number): number | undefined =>
  contextWindow > PI_COMPACTION_RESERVE
    ? contextWindow - PI_COMPACTION_RESERVE
    : undefined;

/** The words a Stop leaves in a Pi conversation, live and replayed. */
export const PI_INTERRUPT_MARKER_TEXT = "The operator stopped this turn.";

/**
 * The same marker in a replay, where the cause is not known: Pi stores a turn cut by bit's
 * Stop and a turn cut by its process ending (a server shutdown, or Pi seeing its input
 * close after a server SIGKILL) the same way, as `stopReason: "aborted"` (slice 2 review,
 * M2). Only the live stream, where the driver sent the `abort`, can say the operator did.
 */
export const PI_STOPPED_REPLAY_TEXT =
  "This turn was stopped before it finished.";

/** The marker a Stop is drawn as: Claude Code's interrupt marker's (`MessageEntry.marker`). */
const INTERRUPTED = "interrupted";

/** A file Pi wrote that this build cannot read as a v3 session. */
export class PiTranscriptError extends Schema.TaggedError<PiTranscriptError>()(
  "PiTranscriptError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.optionalKey(Schema.Number),
  id: Schema.String,
  cwd: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
});
export type PiSessionHeader = typeof Header.Type;

const Entry = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  message: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  targetId: Schema.optionalKey(Schema.String),
  replacement: Schema.optionalKey(Schema.Unknown),
});
export type PiEntry = typeof Entry.Type;

const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.optionalKey(Schema.Number),
  cacheWrite: Schema.optionalKey(Schema.Number),
});
export type PiUsage = typeof Usage.Type;

const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  timestamp: Schema.optionalKey(Schema.Number),
});

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
  provider: Schema.String,
  model: Schema.String,
  usage: Schema.optionalKey(Usage),
  stopReason: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
  timestamp: Schema.optionalKey(Schema.Number),
});
export type PiAssistantMessage = typeof AssistantMessage.Type;

const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Unknown),
  isError: Schema.Boolean,
  timestamp: Schema.optionalKey(Schema.Number),
});

const decodeHeader = Schema.decodeUnknownResult(Header);
const decodeEntry = Schema.decodeUnknownResult(Entry);
const decodeUser = Schema.decodeUnknownResult(UserMessage);
const decodeAssistant = Schema.decodeUnknownResult(AssistantMessage);
const decodeToolResult = Schema.decodeUnknownResult(ToolResultMessage);

/** One parsed session file: its header and its entries in append order. */
export interface PiSessionFile {
  readonly header: PiSessionHeader;
  readonly entries: readonly PiEntry[];
}

/**
 * Parses one session file's text.
 *
 * A line that does not parse is skipped only when it is the **last** one: Pi appends a line
 * per entry, so a process killed mid-write can leave a partial last line, and that is the
 * one place a broken line is expected. Anywhere else it is a file this build does not
 * understand, and the read fails rather than replays half a conversation.
 */
export const parsePiSession = (
  text: string,
  source: string,
): PiSessionFile | PiTranscriptError => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const first = lines[0];
  if (first === undefined) {
    return new PiTranscriptError({
      detail: `${source} is empty: Pi has written no session header`,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(first);
  } catch {
    return new PiTranscriptError({
      detail: `${source} does not start with a JSON session header`,
    });
  }
  const header = decodeHeader(raw);
  if (header._tag === "Failure") {
    return new PiTranscriptError({
      detail: `${source} does not start with a Pi session header`,
    });
  }
  const version = header.success.version ?? 1;
  if (version !== PI_SESSION_VERSION) {
    return new PiTranscriptError({
      detail: `${source} is a version ${String(version)} Pi session; this build reads version ${String(PI_SESSION_VERSION)} only (open it once with this Pi to migrate it, or update bit)`,
    });
  }
  const entries: PiEntry[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const last = index === lines.length - 2;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (last) break;
      return new PiTranscriptError({
        detail: `${source} line ${String(index + 2)} is not JSON`,
      });
    }
    const entry = decodeEntry(value);
    if (entry._tag === "Failure") {
      if (last) break;
      return new PiTranscriptError({
        detail: `${source} line ${String(index + 2)} is not a Pi session entry`,
      });
    }
    entries.push(entry.success);
  }
  return { header: header.success, entries };
};

/** The entries on the active branch: from the last one back to the root, oldest first. */
export const activeBranch = (entries: readonly PiEntry[]): PiEntry[] => {
  const last = entries.at(-1);
  if (last === undefined) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const onPath = new Set<string>();
  let at: PiEntry | undefined = last;
  while (at !== undefined && !onPath.has(at.id)) {
    onPath.add(at.id);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return entries.filter((entry) => onPath.has(entry.id));
};

/** The session's display name, as its newest `session_info` entry gives it. */
export const sessionName = (
  entries: readonly PiEntry[],
): string | undefined => {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") name = entry.name;
  }
  return name;
};

/** Whether the session holds a message anybody sent: what makes it worth resuming. */
export const hasUserMessage = (entries: readonly PiEntry[]): boolean =>
  entries.some(
    (entry) =>
      entry.type === "message" && decodeUser(entry.message)._tag === "Success",
  );

/** A block of Pi content, as far as this build reads one. */
type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | { readonly type: "image" }
  | { readonly type: "other" };

const blockOf = (value: unknown): Block => {
  if (typeof value !== "object" || value === null) return { type: "other" };
  const block = value as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string")
    return { type: "text", text: block.text };
  if (block.type === "thinking" && typeof block.thinking === "string")
    return { type: "thinking", thinking: block.thinking };
  if (
    block.type === "toolCall" &&
    typeof block.id === "string" &&
    typeof block.name === "string"
  )
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    };
  if (block.type === "image") return { type: "image" };
  return { type: "other" };
};

/** The words of a content value: a string, or its text blocks joined. */
export const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map(blockOf)
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
      : "";

/** A tool call's arguments as the JSON a `toolCall` part carries, capped. */
export const toolInput = (args: unknown): string => {
  try {
    return truncateNarration(JSON.stringify(args ?? {}) ?? "{}");
  } catch {
    return "{}";
  }
};

/** A tool result's content as its output text, capped. */
export const toolOutput = (content: unknown): string =>
  truncateNarration(contentText(content));

/** A model's spelling in this harness's catalogue: `provider/model`. */
export const piModelId = (provider: string, model: string): string =>
  `${provider}/${model}`;

/** Tokens sent on one call: uncached input, cache read and cache write. */
export const promptTokensOf = (usage: PiUsage): number =>
  usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

/** Whether a usage reports a call at all: Pi zeroes an aborted or failed one. */
export const usageMeasured = (usage: PiUsage | undefined): usage is PiUsage =>
  usage !== undefined && promptTokensOf(usage) + usage.output > 0;

/** An assistant message's blocks as replay parts, in order. */
const assistantParts = (message: PiAssistantMessage): MessagePart[] => {
  const model = piModelId(message.provider, message.model);
  return message.content.map(blockOf).flatMap((block): MessagePart[] => {
    switch (block.type) {
      case "text":
        return block.text.trim() === ""
          ? []
          : [{ _tag: "reply", text: truncateReply(block.text), model }];
      case "thinking":
        return [
          {
            _tag: "thinking",
            text: block.thinking.slice(0, NARRATION_FIELD_MAX),
            model,
          },
        ];
      case "toolCall":
        return [
          {
            _tag: "toolCall",
            callId: block.id,
            tool: block.name,
            input: toolInput(block.arguments),
            model,
          },
        ];
      default:
        return [];
    }
  });
};

/** What a replay is told beside the file. */
export interface PiReplay {
  /** Takes the files a user message's words list off them; see `attachmentReader`. */
  readonly reader: AttachmentReader;
  /**
   * The application's ids for the steers a user message holds, oldest first, or
   * `undefined` for one this process did not deliver. Asked once per user message, in
   * order: the driver joins by the words it sent (`piClient.ts`).
   */
  readonly steerIds: (text: string) => readonly string[] | undefined;
}

/**
 * The active branch of one session as the seam's message log: oldest first, and all of it.
 */
export const piMessageEntries = (
  file: PiSessionFile,
  replay: PiReplay,
): MessageEntry[] => {
  const branch = activeBranch(file.entries);
  // A retried call's failed attempts: taken out of the model's context by Pi itself.
  const retried = new Set<string>();
  for (const entry of branch) {
    if (
      entry.type === "context_edit" &&
      entry.replacement === null &&
      entry.targetId !== undefined
    )
      retried.add(entry.targetId);
  }
  const out: MessageEntry[] = [];
  for (const entry of branch) {
    const endedAt = Date.parse(entry.timestamp);
    const stored = Number.isFinite(endedAt) ? endedAt : undefined;
    if (entry.type === "compaction") {
      out.push({
        type: "user",
        text: entry.summary ?? "",
        error: undefined,
        parts: [],
        model: undefined,
        at: stored,
        marker: "compacted",
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const user = decodeUser(entry.message);
    if (user._tag === "Success") {
      const words = contentText(user.success.content);
      const split = replay.reader(words);
      const ids = replay.steerIds(words);
      out.push({
        type: "user",
        text: split.text,
        error: undefined,
        parts: [],
        model: undefined,
        at: user.success.timestamp ?? stored,
        ...(split.attachments.length === 0
          ? {}
          : { attachments: split.attachments }),
        ...(ids === undefined || ids.length === 0 ? {} : { messageIds: ids }),
      });
      continue;
    }
    const assistant = decodeAssistant(entry.message);
    if (assistant._tag === "Success") {
      const message = assistant.success;
      if (message.stopReason === "error" && retried.has(entry.id)) continue;
      const parts = assistantParts(message);
      const text = message.content
        .map(blockOf)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      const failed = message.stopReason === "error";
      out.push({
        type: "assistant",
        text,
        error: failed
          ? (message.errorMessage ??
            "the provider ended the call with an error")
          : undefined,
        parts,
        model: piModelId(message.provider, message.model),
        at: message.timestamp ?? stored,
        ...(stored === undefined ? {} : { endedAt: stored }),
      });
      if (message.stopReason === "aborted") {
        out.push({
          type: "user",
          text: PI_STOPPED_REPLAY_TEXT,
          error: undefined,
          parts: [],
          model: undefined,
          at: stored,
          marker: INTERRUPTED,
        });
      }
      continue;
    }
    const result = decodeToolResult(entry.message);
    if (result._tag === "Success") {
      out.push({
        type: "toolResult",
        text: "",
        error: undefined,
        parts: [
          {
            _tag: "toolResult",
            callId: result.success.toolCallId,
            tool: result.success.toolName,
            output: toolOutput(result.success.content),
            failed: result.success.isError,
          },
        ],
        model: undefined,
        at: result.success.timestamp ?? stored,
      });
    }
    // `system`, `bashExecution`, `custom` and anything newer: nothing a chat draws.
  }
  return out;
};

/** The newest assistant call with a measured usage on the active branch, if any. */
export const lastMeasuredCall = (
  file: PiSessionFile,
):
  | { readonly usage: PiUsage; readonly model: string; readonly after: boolean }
  | undefined => {
  const branch = activeBranch(file.entries);
  for (let at = branch.length - 1; at >= 0; at -= 1) {
    const entry = branch[at];
    if (entry?.type === "compaction")
      return { usage: { input: 0, output: 0 }, model: "", after: true };
    if (entry?.type !== "message") continue;
    const assistant = decodeAssistant(entry.message);
    if (assistant._tag !== "Success") continue;
    if (!usageMeasured(assistant.success.usage)) continue;
    return {
      usage: assistant.success.usage,
      model: piModelId(assistant.success.provider, assistant.success.model),
      after: false,
    };
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------
// Live narration
// ---------------------------------------------------------------------------------------

/** A category for a provider's refusal, from the status a retry's message starts with. */
export const retryCategory = (status: number | null): string =>
  status === null
    ? "unknown"
    : status === 429
      ? "rate_limit"
      : status >= 500
        ? "server_error"
        : status === 401 || status === 403
          ? "authentication_failed"
          : "unknown";

/** The HTTP status Pi's retry message opens with (`429: {…}`), or `null`. */
export const retryStatus = (message: unknown): number | null => {
  if (typeof message !== "string") return null;
  const found = /^\s*(\d{3})\b/.exec(message);
  return found?.[1] === undefined ? null : Number(found[1]);
};

/** What {@link PiNarrator} asks of the session it narrates. */
export interface PiNarratorHooks {
  /** The application's ids for a user message the session just took, if it was a steer. */
  readonly taken: (text: string) => readonly string[] | undefined;
  /** The model's window, for a usage entry, by `provider/model`. */
  readonly window: (model: string) => number | undefined;
}

/** One RPC record, as far as the narrator reads one. */
export type PiEvent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

interface CallState {
  readonly key: string;
  readonly finished: Set<number>;
  model: string | undefined;
}

/**
 * Turns one Pi session's RPC events into narration, in order.
 *
 * Stateful, one per session: block ids are `<call>:<contentIndex>`, and `<call>` is this
 * narrator's own count of assistant messages under a prefix unique to the process, because
 * Pi's stream names no message id. Unique within a session across restarts, since a new
 * process gets a new prefix.
 *
 * What a run ends with is decided here too, at `agent_settled` — the only "Pi will not go on
 * on its own" signal (`agent_end` is not: a retry or a queued message can follow it):
 * `interrupted` when Pi says the run was aborted, `failed` when its last call ended in an
 * error Pi did not retry, `succeeded` otherwise.
 */
export class PiNarrator {
  private calls = 0;
  private call: CallState | undefined;
  /** The error the run's last call ended with, until `agent_end` says whether it is retried. */
  private lastError: string | undefined;
  /** The run ended on an error nothing retried. */
  private failed = false;

  constructor(
    private readonly prefix: string,
    private readonly hooks: PiNarratorHooks,
  ) {}

  /** The narration for one event; empty for an event nothing reads. */
  narrate(event: PiEvent, now: number = Date.now()): HarnessNarration[] {
    const out: HarnessNarration[] = [];
    const say = (
      detail: NarrationDetail,
      outcome: TerminalOutcome | undefined = undefined,
    ) =>
      out.push({
        type: event.type,
        sequence: undefined,
        at: now,
        outcome,
        detail,
      });
    switch (event.type) {
      case "agent_start":
        this.failed = false;
        this.lastError = undefined;
        break;
      case "message_start": {
        const message = event.message as { role?: unknown } | undefined;
        if (message?.role === "assistant") {
          this.calls += 1;
          this.call = {
            key: `${this.prefix}-${String(this.calls)}`,
            finished: new Set(),
            model: undefined,
          };
        }
        break;
      }
      case "message_update": {
        const call = this.call;
        const update = event.assistantMessageEvent as
          Record<string, unknown> | undefined;
        if (call === undefined || update === undefined) break;
        const index =
          typeof update.contentIndex === "number" ? update.contentIndex : 0;
        const blockId = `${call.key}:${String(index)}`;
        switch (update.type) {
          case "text_delta":
          case "thinking_delta":
            if (typeof update.delta === "string" && update.delta !== "")
              say({
                _tag: "delta",
                blockId,
                call: call.key,
                channel: update.type === "text_delta" ? "reply" : "thinking",
                text: update.delta,
              });
            break;
          case "text_end":
            call.finished.add(index);
            say({
              _tag: "reply",
              text: truncateReply(
                typeof update.content === "string" ? update.content : "",
              ),
              blockId,
              call: call.key,
              ...(call.model === undefined ? {} : { model: call.model }),
            });
            break;
          case "thinking_end":
            call.finished.add(index);
            say({
              _tag: "thinking",
              text: (typeof update.content === "string"
                ? update.content
                : ""
              ).slice(0, NARRATION_FIELD_MAX),
              blockId,
              call: call.key,
              ...(call.model === undefined ? {} : { model: call.model }),
            });
            break;
          case "toolcall_end": {
            const block = blockOf(update.toolCall);
            if (block.type !== "toolCall") break;
            call.finished.add(index);
            say({
              _tag: "toolCall",
              callId: block.id,
              tool: block.name,
              input: toolInput(block.arguments),
              ...(call.model === undefined ? {} : { model: call.model }),
            });
            break;
          }
        }
        break;
      }
      case "message_end": {
        const role = (event.message as { role?: unknown } | undefined)?.role;
        if (role === "user") {
          const ids = this.hooks.taken(
            contentText((event.message as { content?: unknown }).content),
          );
          if (ids !== undefined && ids.length > 0)
            say({ _tag: "taken", messageIds: ids });
          break;
        }
        if (role !== "assistant") break;
        const decoded = decodeAssistant(event.message);
        const call = this.call;
        this.call = undefined;
        if (decoded._tag === "Failure" || call === undefined) break;
        const message = decoded.success;
        const model = piModelId(message.provider, message.model);
        // Blocks the stream never finished — a Stop mid-block — are finished from the
        // message Pi stored, so each streamed block still gets its end.
        message.content.forEach((value, index) => {
          if (call.finished.has(index)) return;
          const blockId = `${call.key}:${String(index)}`;
          const block = blockOf(value);
          if (block.type === "text" && block.text !== "")
            say({
              _tag: "reply",
              text: truncateReply(block.text),
              blockId,
              call: call.key,
              model,
            });
          else if (block.type === "thinking")
            say({
              _tag: "thinking",
              text: block.thinking.slice(0, NARRATION_FIELD_MAX),
              blockId,
              call: call.key,
              model,
            });
          else if (block.type === "toolCall")
            say({
              _tag: "toolCall",
              callId: block.id,
              tool: block.name,
              input: toolInput(block.arguments),
              model,
            });
        });
        if (usageMeasured(message.usage)) {
          const window = this.hooks.window(model);
          say({
            _tag: "usage",
            callId: call.key,
            promptTokens: promptTokensOf(message.usage),
            outputTokens: message.usage.output,
            contextLimit: window,
            model,
            compactionAt:
              window === undefined ? undefined : piCompactionAt(window),
          });
        }
        if (message.stopReason === "error") {
          this.lastError =
            message.errorMessage ?? "the provider ended the call with an error";
        }
        break;
      }
      case "tool_execution_end":
        if (typeof event.toolCallId === "string")
          say({
            _tag: "toolResult",
            callId: event.toolCallId,
            tool:
              typeof event.toolName === "string" ? event.toolName : undefined,
            output: toolOutput(
              (event.result as { content?: unknown } | undefined)?.content,
            ),
            failed: event.isError === true,
          });
        break;
      case "auto_retry_start": {
        const status = retryStatus(event.errorMessage);
        say({
          _tag: "retry",
          attempt: typeof event.attempt === "number" ? event.attempt : 1,
          maxRetries:
            typeof event.maxAttempts === "number" ? event.maxAttempts : 0,
          delayMs: typeof event.delayMs === "number" ? event.delayMs : 0,
          status,
          error: retryCategory(status),
        });
        // The attempt that failed is retried: its error is not the run's.
        this.lastError = undefined;
        break;
      }
      case "agent_end":
        if (event.willRetry === true) {
          this.lastError = undefined;
          break;
        }
        if (this.lastError !== undefined) {
          this.failed = true;
          say({ _tag: "error", message: truncateNarration(this.lastError) });
          this.lastError = undefined;
        }
        break;
      case "compaction_end": {
        const result = event.result as { summary?: unknown } | undefined;
        if (typeof result?.summary === "string")
          say({
            _tag: "marker",
            marker: "compacted",
            text: truncateNarration(result.summary),
          });
        break;
      }
      case "agent_settled": {
        const aborted = event.aborted === true;
        if (aborted)
          say({
            _tag: "marker",
            marker: INTERRUPTED,
            text: PI_INTERRUPT_MARKER_TEXT,
          });
        say(
          { _tag: "opaque" },
          aborted ? "interrupted" : this.failed ? "failed" : "succeeded",
        );
        break;
      }
    }
    return out;
  }
}
