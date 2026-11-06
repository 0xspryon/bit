/**
 * A **sub-agent** an agent started, whichever harness ran it (A7-S, E7/E8): the one shape a
 * card and the sub-agents panel draw.
 *
 * Each harness has its own sub-agent tool and its own way of saying how one goes, and this is
 * what both map onto:
 *
 * - **Claude Code** — the `Agent` tool (formerly `Task`). A sub-agent is a CLI *task*
 *   (`task_type: local_agent`): `system/task_started` names its task id and whether it runs in
 *   the background, `system/task_progress` arrives at each of its tool calls with the CLI's
 *   one-line phrase for it ("Running List files", "Reading notes.txt") and its tool-call
 *   count, and its own frames are forwarded with `parent_tool_use_id` set. On a replay its
 *   transcript is `<session>/subagents/agent-<id>.jsonl`, read with `getSubagentMessages`.
 * - **OpenCode 2.2.5** — the `subagent` tool, which runs a **child session** (`parentID`). The
 *   parent's `session.tool.progress` names the child at once; the child's own events (tool
 *   calls, text, its execution's end) arrive on the same event stream under its id, and its
 *   messages read back like any session's.
 *
 * Measured live in A7-S Step 0 (the plan records it). Everything here is **built by the
 * server from what the harness said**; the page computes nothing about a sub-agent's work.
 *
 * Browser-safe: Effect Schema only.
 */
import { Schema } from "effect";

const EpochMillis = Schema.Finite;

/** How many of a sub-agent's most recent tool calls a {@link SubagentView} carries. */
export const SUBAGENT_LINES_KEPT = 3;

/** The most characters a tool line's input or result carries, as one line. */
export const SUBAGENT_LINE_MAX = 160;

/** The most characters a finished sub-agent's {@link SubagentView.result} carries. */
export const SUBAGENT_RESULT_MAX = 4_000;

/** The most characters a failed sub-agent's raw error carries. */
export const SUBAGENT_ERROR_MAX = 2_000;

/**
 * Where a sub-agent stands.
 *
 * - `running` — from the call until something ends it.
 * - `finished` — it handed back to the agent that started it.
 * - `failed` — the harness said the call, or the sub-agent, failed.
 * - `stopped` — stopped or cancelled before it ended on its own: by the operator's Stop, by
 *   a Stop of the turn it ran in, or by the harness.
 */
export const SubagentStatus = Schema.Literals([
  "running",
  "finished",
  "failed",
  "stopped",
]);
export type SubagentStatus = typeof SubagentStatus.Type;

/**
 * Whether a running sub-agent can be stopped on its own, as this server knows it now.
 *
 * - `own` — it can: `POST …/subagents/:callId/stop`. A Claude Code **background** sub-agent
 *   (`stopTask` on its task), and any OpenCode sub-agent (its child session is interrupted;
 *   measured for foreground and background alike).
 * - `with_turn` — it runs inside the agent's turn, and only the turn's Stop is offered for
 *   it: a Claude Code **foreground** sub-agent (decided by the operator, A7-S; see the
 *   `V2(chat):` note at the Claude Code driver's `subagentStop` for what was measured).
 * - `none` — nothing to stop (it has ended), or this server cannot reach it on its own: a
 *   session it does not hold, or one whose task or child id it never learnt.
 */
export const SubagentStop = Schema.Literals(["own", "with_turn", "none"]);
export type SubagentStop = typeof SubagentStop.Type;

/**
 * One tool call a sub-agent made, as one line: the tool as the harness named it, its input
 * in one line, and its result's first line once it has one. All of it is **the sub-agent's**
 * (agent text): drawn as plain text, never markup.
 */
export const SubagentToolLine = Schema.Struct({
  /** The tool as the harness named it: `Bash`, `Read`, `shell`, an MCP tool's name. */
  tool: Schema.String,
  /** Its input as one line, at most {@link SUBAGENT_LINE_MAX} characters. */
  input: Schema.String,
  /** Its result's first line, at most {@link SUBAGENT_LINE_MAX}; `null` while it runs. */
  result: Schema.NullOr(Schema.String),
  /** The harness said the call failed. */
  failed: Schema.Boolean,
});
export type SubagentToolLine = typeof SubagentToolLine.Type;

/** Why a sub-agent failed: the server's sentence, and the harness's own words verbatim. */
export const SubagentFailure = Schema.Struct({
  /** The server's sentence (`The sub-agent call was refused`), for the card's first words. */
  reason: Schema.String,
  /** The harness's error as it said it, at most {@link SUBAGENT_ERROR_MAX}: drawn in mono. */
  error: Schema.String,
});
export type SubagentFailure = typeof SubagentFailure.Type;

/**
 * A sub-agent as a card draws it (E7), at one moment. A sub-agent is narrated as a sequence of
 * these sharing its {@link callId}; a reader keeps the newest per call.
 */
export const SubagentView = Schema.Struct({
  /** The calling tool call's id: the sub-agent's identity for every state of it. */
  callId: Schema.String,
  /** The calling tool as the harness named it (`Agent`, `subagent`). */
  tool: Schema.String,
  /** Its type as the calling agent asked for it (`general-purpose`, `general`), or null. Agent text. */
  agentType: Schema.NullOr(Schema.String),
  /** The calling agent's short label for it — the card's name. Agent text, one line. */
  description: Schema.String,
  /** The start of the prompt it was given, one line — the card's task. Agent text. */
  task: Schema.String,
  /** It was started in the background: the call returned at once and it runs on. */
  background: Schema.Boolean,
  status: SubagentStatus,
  /** When it was started, on the harness's or this server's clock; null when not known. */
  startedAt: Schema.NullOr(EpochMillis),
  /** When it ended; null while running, or when not known. */
  endedAt: Schema.NullOr(EpochMillis),
  /** How many tool calls it has made; null when the harness did not say and nothing was read. */
  calls: Schema.NullOr(Schema.Int),
  /** Its last {@link SUBAGENT_LINES_KEPT} tool calls, oldest first. */
  lines: Schema.Array(SubagentToolLine),
  /**
   * What it is doing now, in the harness's words when it gives some (Claude Code's
   * `task_progress` phrase), else its newest sentence's first line. Null when neither has
   * come, and once it has ended. Agent or harness text, one line.
   */
  activity: Schema.NullOr(Schema.String),
  /**
   * What it returned to the agent that started it, as it wrote it (finished cards quote this),
   * at most {@link SUBAGENT_RESULT_MAX}. Null until it has finished, and when nothing was read.
   */
  result: Schema.NullOr(Schema.String),
  /** Why it failed; null unless {@link status} is `failed`. */
  failure: Schema.NullOr(SubagentFailure),
  stop: SubagentStop,
});
export type SubagentView = typeof SubagentView.Type;

/** A Stop of one sub-agent, answered. */
export const SubagentStopped = Schema.Struct({
  /** The import (or conversation) whose session the Stop landed on. */
  conversationId: Schema.String,
  callId: Schema.String,
  /** A sentence for the operator about what happened, in the server's words. */
  detail: Schema.String,
});
export type SubagentStopped = typeof SubagentStopped.Type;

/**
 * Why a sub-agent could not be stopped. Each `detail` is a sentence for the error dialog.
 *
 * - `not_running` — the sub-agent has ended, or this session never started it.
 * - `not_stoppable` — it runs inside the agent's turn (`with_turn`): stop the turn instead.
 * - `not_live` — this server holds no session for the conversation now.
 * - `harness_unreachable` — the harness was asked and did not answer: whether it stopped is
 *   not known.
 * - `store_unavailable` — the conversation's record could not be read.
 *
 * `409`, as a Stop's refusals are.
 */
export class SubagentStopRefused extends Schema.TaggedError<SubagentStopRefused>()(
  "SubagentStopRefused",
  {
    reason: Schema.Literals([
      "not_running",
      "not_stoppable",
      "not_live",
      "harness_unreachable",
      "store_unavailable",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}
