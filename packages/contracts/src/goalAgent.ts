/**
 * The goal conversation: the surface an operator actually opens.
 *
 * One long-lived agent session per goal, created on the first message and reused after.
 * The operator types, the agent answers, and what the agent *does* about the graph it does
 * through its own tools — it steers the planner, it wakes one, it reads, it can end the
 * goal. **It has no `add_intent`** (the slice's first ruling): an intent is committed by a
 * planner round, where the budget, the anchoring rule and the duplicate join live, and a
 * goal agent that could write one would make all three bypassable by asking politely.
 *
 * ## Nothing here is a transcript, and the shapes say so
 *
 * Operator messages and agent turns are **not stored** (the goal and planner flow's
 * decision 15, and this slice's ruling 4). What survives is the graph: intents, rounds,
 * observations, the goal's own ending. The conversation streams live onto the target's
 * `live` feed as activity, and a reloaded tab replays whatever the *harness* still holds
 * through {@link GoalConversationView}. So this file declares a turn being *accepted*
 * ({@link GoalTurnAccepted}) and a replay that is allowed to be empty in three
 * distinguishable ways ({@link GoalConversationSource}) — and no shape that claims to be
 * the conversation itself.
 *
 * Browser-safe: Effect Schema only. No server, Bun, Node or persistence imports.
 */
import { Schema } from "effect";

import { SteerUrgency } from "./conversationTurn";
import { LiveItem } from "./live";
import { MessageAttachmentView } from "./messageUpload";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/**
 * What a browser sends to say something to a goal's agent.
 *
 * The operator's own words, and how urgently they should land. There is no model, no
 * harness, no session id and no directory here, for {@link PlanRefused}'s reason: the
 * session the message goes to is the server's — it lives in `targets/<id>/goal/<goalId>/` and holds a credential
 * minted before it was created — and a browser that could name any of that would be
 * choosing where an agent runs and what it may reach.
 *
 * `NonEmptyString` after trimming, so an empty composer submit is refused by the decoder
 * before a session is opened for it. A blank first message would otherwise create a
 * long-lived session, a directory and a credential to say nothing to.
 */
export const GoalMessageDraft = Schema.Struct({
  text: Schema.Trim.check(Schema.isNonEmpty()).annotate({
    description: "What to say to this goal's agent. Trimmed, and never empty.",
  }),
  /**
   * How a message sent while a turn runs should land: `queued` (the default, when absent)
   * or `preemptive` ("send now"). See {@link SteerUrgency}. Timing, not authority: it names
   * nothing about where the agent runs.
   */
  urgency: Schema.optional(SteerUrgency),
});
export type GoalMessageDraft = typeof GoalMessageDraft.Type;

/**
 * Whether this message opened the conversation, resumed one, or carried one on.
 *
 * - `opened` — a session was created for this message. The first message on a goal, and
 *   also the first message after a restart whose session could not be carried on; see
 *   {@link GoalTurnAccepted.priorUnavailable} for how those two are told apart.
 * - `resumed` — the harness still held the goal's session and this message **continued
 *   it**: the same session id, a new authority period, and an agent that keeps every word
 *   of what is already on the operator's screen (S7). The importer's own answer carries
 *   the same name for the same thing (`ImporterTurnStart`).
 * - `continued` — the session was already live in this process and the message was
 *   delivered into it.
 *
 * A reader that cares only about "is what is on screen still the truth" treats `resumed`
 * like `opened`: both mean this process did not hold the session when the message arrived,
 * so a replay taken before it is stale. What separates them is whether the agent read it.
 */
export const GoalConversationStart = Schema.Literals([
  "opened",
  "resumed",
  "continued",
]);
export type GoalConversationStart = typeof GoalConversationStart.Type;

/**
 * One operator message, accepted.
 *
 * **Accepted, not answered.** The route returns as soon as the agent's session has the
 * message, exactly as starting a run or opening a round does: a turn takes as long as the
 * model takes, and a request that waited for it would time out. What the agent says
 * arrives on the target's `live` feed.
 */
export const GoalTurnAccepted = Schema.Struct({
  targetId: Schema.String,
  goalId: Schema.String,
  /**
   * The harness session the message went to.
   *
   * Carried because it is the join to the harness's own storage: it is what the replay is
   * read from, and what an operator comparing this screen against the harness's own log
   * needs.
   */
  harnessSessionId: Schema.String,
  /** Which configured harness is running the conversation, and on what. */
  instanceId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  conversation: GoalConversationStart,
  /**
   * Whether a conversation existed on this goal that this process can no longer reach.
   *
   * **True exactly once per restart**, and it is the whole of this slice's answer to "a
   * restart with a goal session live". The goal's session id is recorded durably; the
   * *credential* that made it able to do anything is not — grants live in
   * `mcp/credentials.ts`'s in-memory map and die with the process. So after a restart the
   * recorded session is a session nothing can authorise, and prompting it would produce an
   * agent with no tools talking into a conversation the operator cannot see the start of.
   * A new session is opened instead and this says so.
   *
   * False on every `continued` turn, and false for the first message on a goal that never
   * had a session — which is the distinction a flag that was always true would lose.
   */
  priorUnavailable: Schema.Boolean,
  /**
   * A sentence for the operator about the session this message landed in. Empty when
   * there is nothing to say, which is the ordinary `continued` turn.
   *
   * The server's words rather than the browser's, for {@link LiveItem.body}'s reason: the
   * server knows which session was opened, which one was abandoned and why, and a browser
   * composing that sentence would be inventing wording for states it cannot see.
   */
  note: Schema.String,
  acceptedAt: EpochMillis,
  /**
   * The files the message carried, as the server stored them (A6 U13): the operator's turn
   * shows each with its path before any replay could. Absent on a message with none.
   */
  attachments: Schema.optionalKey(Schema.Array(MessageAttachmentView)),
});
export type GoalTurnAccepted = typeof GoalTurnAccepted.Type;

/**
 * Why a message could not be given to a goal's agent.
 *
 * The planner's {@link PlanRefused} reasons, minus everything about rounds and plus the
 * two a conversation has of its own. Each is a sentence the composer prints beside itself.
 *
 * - `no_harness` — this server configures no agent harness, so there is nothing to talk
 *   to. Not a transport fault: the server answered precisely.
 * - `harness_not_ready`, `harness_unreachable` — the configured harness cannot take a
 *   session, or did not answer.
 * - `goal_not_active` — the goal is `met` or `abandoned`. An ended goal takes no new
 *   conversation: its agent's credential would be refused by every write anyway
 *   (`store.checkGoalAuthority`), so an agent could be talked to and could do nothing.
 * - `goal_directory_unusable` — `targets/<id>/goal/<goalId>/` could not be made.
 * - `goal_ungated` — the directory exists and the pre-execution policy gate would not
 *   install into it. The conversation is refused rather than run ungated, exactly as a
 *   worker and a round are.
 * - `target_unavailable`, `store_unavailable` — the target's database.
 * - `upload_unwritable` — the message carried files and they could not be written into the
 *   goal's `uploads/` folder (A6 F9). Nothing was said to the agent; a live session is kept.
 *
 * `409` for {@link PlanRefused}'s reason: every one of them is a conflict with the state
 * of the goal, the process or the installation rather than a malformed request.
 */
export class GoalConversationRefused extends Schema.TaggedError<GoalConversationRefused>()(
  "GoalConversationRefused",
  {
    reason: Schema.Literals([
      "no_harness",
      "harness_not_ready",
      "harness_unreachable",
      "goal_not_active",
      "goal_directory_unusable",
      "goal_ungated",
      "target_unavailable",
      "store_unavailable",
      "upload_unwritable",
    ]),
    detail: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

/**
 * Where a goal conversation's prose came from, or why there is none.
 *
 * {@link RoundNarrationSource}'s four answers plus one, and the addition is the state a
 * round cannot be in: a goal that has never been talked to at all. A round always has a
 * row saying it happened; a conversation has nothing until the first message.
 *
 * - `harness` — the harness answered with messages. Ephemeral, like a round's.
 * - `pending` — a session is live and the harness holds nothing for it yet. The first
 *   second of the first message.
 * - `forgotten` — the harness no longer holds the session, or cannot be asked about it.
 *   **A note, never an error**: Claude Code deletes transcripts after about thirty days
 *   and an OpenCode session dies with its server, so for a goal last opened weeks ago
 *   this is the expected answer.
 * - `none` — the harness still knows the session and holds nothing under it. The
 *   conversation really produced nothing.
 * - `absent` — no session has ever been recorded for this goal. Nobody has said anything
 *   yet, which is not an absence of prose but an absence of a conversation.
 */
export const GoalConversationSource = Schema.Literals([
  "harness",
  "pending",
  "forgotten",
  "none",
  "absent",
]);
export type GoalConversationSource = typeof GoalConversationSource.Type;

/**
 * A goal conversation as a reloaded tab replays it.
 *
 * **The harness's copy, and nothing of ours.** Nothing in this build stores a word of the
 * conversation, so this is the only thing a refresh can show and the harness decides how
 * long it lasts. The durable half of the same screen is the graph: the rounds the agent
 * woke, the intents those rounds added, the goal's own ending — all of which are rows and
 * are on the page whatever this answers.
 *
 * `200` in every case, including a conversation the harness has entirely forgotten, for
 * the reason the round narration route is a `200`: "gone" is the ordinary end state of
 * anything old enough and an error status would make a browser treat it as a fault.
 */
export const GoalConversationView = Schema.Struct({
  targetId: Schema.String,
  goalId: Schema.String,
  /** The session this was read from, or null when none has ever been recorded. */
  harnessSessionId: Schema.NullOr(Schema.String),
  /**
   * Whether **this process** is holding that session.
   *
   * False with a non-null session id is the restart case: the id is ours, the session may
   * still be readable, and nothing can be said *to* it — the next message opens a new one.
   * The note says so.
   */
  live: Schema.Boolean,
  source: GoalConversationSource,
  /** True only for `harness`: what is shown can disappear. */
  ephemeral: Schema.Boolean,
  /** A sentence for the operator, set on every source including a successful read. */
  note: Schema.String,
  /**
   * The conversation as the **same items the live stream carries** (A6 F10), oldest first,
   * each with `goalId` set: the agent's replies, thinking and tool calls with their results,
   * and the operator's own messages as `turn.operator` items — a `user` entry here is the
   * operator, with this server's framing trimmed off (a round's replay drops its prompt; a
   * conversation keeps every `user` entry, or the agent would be answering questions nobody
   * can see). Ids are `replay:<n>`: a render key, not a cursor.
   */
  items: Schema.Array(LiveItem),
  /** Messages this answer stopped short of. */
  truncated: Schema.Boolean,
  /** How many harness entries produced no item. {@link RoundNarration.omittedBlank}. */
  omittedBlank: Schema.Int,
  /** When this answer was built. The client's join floor for the live tail. */
  at: EpochMillis,
});
export type GoalConversationView = typeof GoalConversationView.Type;
