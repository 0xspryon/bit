/**
 * Switching the model of a conversation that already has a session (A6 F4).
 *
 * **The harness is pinned and the model is not.** A conversation's harness instance is
 * fixed by its first message — another harness is a new session — while its model and that
 * model's options may change at any time, including while a turn is running. The switch is
 * applied at once and the harness takes it from its next model call (measured on both
 * harnesses; see `AgentHarness.switchModel` on the server). So nothing here names a harness:
 * the server reads the conversation's own instance from its row and refuses a model that
 * instance's catalogue does not list.
 *
 * One shape for both kinds of conversation — an importer session and a goal's agent — since
 * a switch means the same thing on each, and the picker that sends it is one component.
 */
import { Schema } from "effect";

import { ModelOptionSelection } from "./modelOption";

/**
 * What a picker sends to move a conversation onto another model of its harness.
 *
 * `model` is a name from the conversation's harness instance's catalogue
 * (`HarnessModelView.id`), as `RunDraft.model` is. `modelOptions` is what the operator set
 * **of that model**, exactly as `RunDraft.modelOptions` means it: absent or empty is
 * "nothing chosen", and the server resolves the list against the new model's descriptors,
 * answering which ids it dropped. A reasoning level chosen for the previous model is not
 * carried across by the server; a picker that wants to keep it sends it again.
 */
export const ConversationModelDraft = Schema.Struct({
  model: Schema.Trim.check(Schema.isNonEmpty()).annotate({
    description:
      "A model name from the conversation's own harness instance's catalogue.",
  }),
  modelOptions: Schema.optional(Schema.Array(ModelOptionSelection)),
});
export type ConversationModelDraft = typeof ConversationModelDraft.Type;

/**
 * Where a switch took effect.
 *
 * - `live` — this server holds the session and the harness accepted the switch: it runs
 *   from the harness's next model call, mid-turn included.
 * - `recorded` — the session is not live (this server does not hold it, or the harness no
 *   longer has it running), so only the conversation's record changed. The next message
 *   that resumes or reopens the conversation opens it on this model.
 */
export const ConversationModelApplied = Schema.Literals(["live", "recorded"]);
export type ConversationModelApplied = typeof ConversationModelApplied.Type;

/** A model switch, accepted. */
export const ConversationModelSwitched = Schema.Struct({
  /**
   * The conversation the switch landed on. For an importer, the import id it is on now —
   * which is the one addressed unless that import has since been taken over by a successor
   * in this server (then the successor's). For a goal, the goal id.
   */
  conversationId: Schema.String,
  /** The conversation's pinned harness instance, unchanged by a switch. */
  harnessInstanceId: Schema.String,
  /** The model the conversation is on now. */
  model: Schema.String,
  /**
   * What the model is set to now: the request's options resolved against the model's
   * descriptors, sorted by id. Empty for nothing chosen, so the harness's own default.
   */
  modelOptions: Schema.Array(ModelOptionSelection),
  /**
   * Option ids the request set that this model does not offer, so they were dropped rather
   * than forwarded. The picker says "this model does not offer X" from it. Empty usually.
   */
  droppedModelOptionIds: Schema.Array(Schema.String),
  applied: ConversationModelApplied,
  /**
   * Whether the record changed. `false` when the conversation was already on exactly this
   * model and options — a repeat is a success, not a refusal. A live session is still told
   * (harmlessly: both harnesses treat a repeat as a no-op), because asking again is what
   * settles an earlier switch whose outcome was uncertain.
   */
  changed: Schema.Boolean,
});
export type ConversationModelSwitched = typeof ConversationModelSwitched.Type;

/**
 * Why a conversation's model could not be switched. Each `detail` is a sentence for the
 * error dialog, in the server's words.
 *
 * - `no_session` — nothing has been said in this conversation yet, or its record predates
 *   recording a harness instance, so there is no pinned harness to switch within. The first
 *   message decides the harness and model.
 * - `conversation_ended` — the operator ended the import, or the goal is no longer active.
 *   There is nothing to run on a new model.
 * - `harness_not_ready` — the conversation's own harness instance is not usable on this
 *   server, so its catalogue cannot be checked and nothing could run on it.
 * - `model_unavailable` — that model is not in the conversation's harness instance's
 *   catalogue. A model of another harness is always this: the harness is pinned.
 * - `switch_in_flight` — another switch of this conversation has not answered yet. Switches
 *   are not queued: wait for it, then pick again.
 * - `harness_unreachable` — the harness was asked and did not clearly answer, so whether the
 *   session moved is **uncertain**. The record is unchanged; switching again settles it.
 * - `store_unavailable` — the conversation's record could not be read or written. When the
 *   harness had already taken the switch, the sentence says so, and switching again records
 *   it.
 *
 * `409`: a conflict with the state of the conversation or the server, never a malformed
 * request — that is the decoder's.
 */
export class ConversationModelRefused extends Schema.TaggedError<ConversationModelRefused>()(
  "ConversationModelRefused",
  {
    reason: Schema.Literals([
      "no_session",
      "conversation_ended",
      "harness_not_ready",
      "model_unavailable",
      "switch_in_flight",
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
