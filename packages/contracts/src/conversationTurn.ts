/**
 * The two things an operator can do to a conversation's turn besides talking into it (A6 F5):
 * say how urgently a message should land, and stop the turn that is running.
 *
 * One shape for both kinds of conversation — an importer session and a goal's agent — as
 * `conversationModel.ts` is, because both run on the same session spine on the server and
 * mean the same thing on each.
 *
 * Browser-safe: Effect Schema only. No server, Bun, Node or persistence imports.
 */
import { Schema } from "effect";

/**
 * When a message sent while a turn runs should reach the agent.
 *
 * - `queued` — the default. The work in flight finishes, then the message runs: the harness
 *   holds it until the turn reaches its end.
 * - `preemptive` — "send now". The message lands at the harness's next step boundary, so a
 *   tool call already running finishes first and the rest of the work in flight is thrown
 *   away (measured on both harnesses; DECISIONS.md §24.1).
 *
 * To a session with no turn running the two are the same: the message starts the next one.
 */
export const SteerUrgency = Schema.Literals(["queued", "preemptive"]);
export type SteerUrgency = typeof SteerUrgency.Type;

/**
 * What a Stop came to.
 *
 * - `interrupted` — this server held the session, a turn was running, and the harness
 *   stopped it. The conversation stays open: the next message continues the same session.
 * - `background_stopped` — no turn was running, but work the agent had started in the
 *   background (a background subagent or shell, which outlives the turn that started it)
 *   was, and the harness was told to stop it. `working` says whether any of it was still
 *   running when the Stop was answered.
 * - `idle` — this server holds the session and nothing was running in it, so there was
 *   nothing to stop.
 * - `not_live` — this server holds no session for the conversation (it was never opened
 *   here, it was closed, or the server restarted), so nothing of it can be running here.
 */
export const ConversationStopOutcome = Schema.Literals([
  "interrupted",
  "background_stopped",
  "idle",
  "not_live",
]);
export type ConversationStopOutcome = typeof ConversationStopOutcome.Type;

/** A Stop, answered. */
export const ConversationStopped = Schema.Struct({
  /**
   * The conversation the Stop landed on. For an importer, the import id holding the session
   * now — the one addressed unless this server has since carried the conversation on under a
   * successor (then the successor's). For a goal, the goal id.
   */
  conversationId: Schema.String,
  outcome: ConversationStopOutcome,
  /**
   * Whether the conversation is still working once the Stop has been answered.
   *
   * `false` for `idle` and `not_live`, and for an `interrupted` turn that settled. `true`
   * when it had not gone quiet shortly after the stop: either the harness went straight on to
   * a message the operator had sent behind the turn it stopped (Claude Code runs one as soon
   * as the turn ahead of it is interrupted), or the stopped turn is still finishing. For
   * `background_stopped`, `true` when the harness still reported background work running.
   * {@link detail} says which. A screen keeps its working state on `true` and clears it on
   * `false`, and a sentence it shows from a `true` answer is over once the conversation is
   * idle.
   */
  working: Schema.Boolean,
  /**
   * Whether work the agent started in the background — a background subagent or shell — is
   * still running once the Stop has been answered (A6 U6 review), as the harness reported it
   * after the Stop. A Stop of a running turn stops that work too, so a screen that offered
   * Stop for it clears it on `false` at once rather than at its next activity read. `true`
   * when the harness could not be asked: "may still be running", never "stopped". `false`
   * for `idle` and `not_live`, and from a harness that does not report background work
   * (OpenCode). For `background_stopped` it is {@link working}.
   */
  background: Schema.Boolean,
  /** A sentence for the operator about what happened, in the server's words. */
  detail: Schema.String,
});
export type ConversationStopped = typeof ConversationStopped.Type;

/**
 * Whether a turn is running in a conversation, as this server holds it (A6 U6).
 *
 * - `running` — a turn is in flight: a message the operator sent is being answered, or the
 *   harness opened a turn by itself (Claude Code does on a background task's notification).
 * - `idle` — this server holds the session and no turn is running in it.
 * - `not_live` — this server holds no session for the conversation, so nothing of it runs
 *   here.
 */
export const ConversationTurnActivity = Schema.Literals([
  "running",
  "idle",
  "not_live",
]);
export type ConversationTurnActivity = typeof ConversationTurnActivity.Type;

/**
 * What a conversation is doing right now (A6 U6): what a screen reads to decide whether to
 * offer Stop. Read from the harness, so it covers the turns no message of the operator's
 * started, which a screen counting its own messages cannot see.
 */
export const ConversationActivity = Schema.Struct({
  /**
   * The conversation the answer is about: for an importer, the import holding the session
   * now — the one addressed unless this server has carried the conversation on under a
   * successor.
   */
  conversationId: Schema.String,
  turn: ConversationTurnActivity,
  /**
   * Whether work the agent started in the background — a background subagent or shell,
   * which outlives the turn that started it — is still running. A Stop with no turn running
   * stops it and answers `background_stopped`. `false` from a harness that does not report
   * background work (OpenCode), and when the harness could not be asked.
   */
  background: Schema.Boolean,
});
export type ConversationActivity = typeof ConversationActivity.Type;

/**
 * Why a Stop could not be carried out. Each `detail` is a sentence for the error dialog.
 *
 * - `harness_unreachable` — the harness was asked to stop the turn and did not acknowledge
 *   it, so whether the turn stopped is **uncertain**. This server lets go of the session
 *   either way — its credential is revoked, so it can record nothing more — and the next
 *   message carries the conversation on in a session it holds again.
 * - `store_unavailable` — the conversation's record could not be read.
 *
 * `409`, for the other conversation refusals' reason.
 */
export class ConversationStopRefused extends Schema.TaggedError<ConversationStopRefused>()(
  "ConversationStopRefused",
  {
    reason: Schema.Literals(["harness_unreachable", "store_unavailable"]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}
