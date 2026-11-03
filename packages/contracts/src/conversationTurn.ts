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
 * - `idle` — this server holds the session and nothing was running in it, so there was
 *   nothing to stop.
 * - `not_live` — this server holds no session for the conversation (it was never opened
 *   here, it was closed, or the server restarted), so nothing of it can be running here.
 */
export const ConversationStopOutcome = Schema.Literals([
  "interrupted",
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
   * `false` for `idle` and `not_live`, and for an `interrupted` turn that settled. **`true`
   * when the harness went straight on to a message the operator had queued behind the turn
   * it stopped**: Claude Code runs a queued message as soon as the turn ahead of it is
   * interrupted, so the conversation is answering that message now. A screen keeps its
   * working state on `true` and clears it on `false`.
   */
  working: Schema.Boolean,
  /** A sentence for the operator about what happened, in the server's words. */
  detail: Schema.String,
});
export type ConversationStopped = typeof ConversationStopped.Type;

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
