/**
 * A conversation with an agent, as every chat in bit reads it: the shapes the importer's
 * chat has carried since S3, said once so the goal chat, a planner stage and a worker
 * attempt read the same ones (A6, the chat generalisation, slice 2).
 *
 * ## Owner, session, period
 *
 * - The **owner** is what a conversation belongs to: the target's Auto-load chat, a goal, a
 *   planner stage, a worker attempt. It decides the routes, the rows, the credential and the
 *   prompts, and none of that is here.
 * - A **session** is one harness session (`harnessSessionId`): a picker row, and the key a
 *   session index groups by.
 * - A **period** is one authority period on a session: one credential, one MCP registration,
 *   one row. A period's id is what a route, a live frame and a browser address — the
 *   `conversationId` of {@link ConversationStopped} and its siblings. Every reopen or resume
 *   mints a new period under a new id; the old row keeps why it ended.
 *
 * **The period id is the owner's to name.** The field sets below leave it out, and an
 * owner's schema spreads them beside its own id (`importId` for the importer), so the wire
 * says what the id is.
 */
import { Schema } from "effect";

import { SteerUrgency } from "./conversationTurn";
import { LiveItem } from "./live";
import { MessageAttachmentView } from "./messageUpload";
import { PendingQuestion } from "./question";

const EpochMillis = Schema.Finite.annotate({
  description: "Milliseconds since the Unix epoch.",
});

/**
 * The longest message a conversation takes, in characters.
 *
 * A bound so a request body cannot carry an unbounded prompt into a harness session, set
 * well above what an operator types or pastes from one program page: a long policy page's
 * scope section, pasted whole, is a few thousand characters. A message over it is refused by
 * the decoder before anything is opened for it.
 */
export const CONVERSATION_MESSAGE_MAX_CHARS = 32_000;

/**
 * What a browser sends to say something to an agent in a conversation.
 *
 * The operator's words, and how urgently they should land, and nothing else, for
 * `GoalMessageDraft`'s reason: the session is the server's, and a browser that could name its
 * harness, directory or credential would be choosing where an agent runs and what it may
 * reach. Trimmed and never empty, so an empty composer submit is refused by the decoder
 * before a session is opened for it.
 */
export const ConversationMessageDraft = Schema.Struct({
  text: Schema.Trim.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(CONVERSATION_MESSAGE_MAX_CHARS),
  ).annotate({
    description: `What to say to the agent. Trimmed, never empty, and at most ${String(CONVERSATION_MESSAGE_MAX_CHARS)} characters.`,
  }),
  /**
   * How a message sent while a turn runs should land: `queued` (the default, when absent)
   * or `preemptive` ("send now"). See {@link SteerUrgency}. It says nothing about the
   * session the message goes to, which stays the server's.
   */
  urgency: Schema.optional(SteerUrgency),
});
export type ConversationMessageDraft = typeof ConversationMessageDraft.Type;

/**
 * Whether a message opened a session, resumed one, or was given to one already live.
 *
 * - `opened` — a session was **created** for this message: the first message of a new
 *   conversation, or a message to a period whose session cannot be carried on at all (the
 *   harness swept its transcript, or holds one that was killed before its first prompt was
 *   saved). The agent in it has read nothing of what came before.
 * - `resumed` — the session this process no longer held was **continued** (S6): a fresh
 *   `query({ resume })` on Claude Code, an ordinary prompt on OpenCode. The conversation
 *   keeps its identity — `harnessSessionId` is the same session id as before — and the agent
 *   in it has its own history back.
 * - `continued` — the session was live in this process and the message was delivered into
 *   it, queued behind whatever it was doing.
 *
 * **`opened` and `resumed` both mint a new period id**, because a period is one credential
 * and a new credential is a new period (`0027`). `continued` keeps the id it was addressed
 * with. The distinction between the first two is therefore not about the id: it is about
 * whether the conversation survived, which is the only part an operator can see.
 */
export const ConversationStart = Schema.Literals([
  "opened",
  "resumed",
  "continued",
]);
export type ConversationStart = typeof ConversationStart.Type;

/**
 * One operator message, accepted: every field but the period id, which the owner's schema
 * names beside these.
 *
 * **Accepted, not answered**: the route returns once the session has the message, and the
 * turn is the model's to take.
 */
export const conversationTurnAcceptedFields = {
  targetId: Schema.String,
  /** The harness's own session id: the join to the session index. */
  harnessSessionId: Schema.String,
  harnessInstanceId: Schema.String,
  /** As `provider/model`. */
  model: Schema.String,
  conversation: ConversationStart,
  /**
   * A sentence for the operator about the session this landed in, in the server's words.
   * Empty on an ordinary `continued` turn.
   */
  note: Schema.String,
  acceptedAt: EpochMillis,
  /**
   * The id the message was delivered under, on a `continued` turn: the steer the live
   * session was given. A `turn.taken` item carrying the same id says the harness has taken
   * it off its queue (A6 U4), which is how a chat tells a message sent mid-turn that is
   * still waiting from one the agent is working on. Absent on `opened` and `resumed`,
   * whose message opens the turn it is in.
   */
  messageId: Schema.optionalKey(Schema.String),
  /**
   * The files the message carried, as the server stored them (A6 U13): the operator's turn
   * shows each with its path before any replay could. Absent on a message with none.
   */
  attachments: Schema.optionalKey(Schema.Array(MessageAttachmentView)),
};

/**
 * Where a conversation's prose came from, or why there is none.
 *
 * - `harness` — the harness answered with messages. Ephemeral: it may delete them.
 * - `pending` — this process holds the session and the harness holds nothing under it yet.
 *   The first second of the first message.
 * - `forgotten` — the harness no longer holds the session, or cannot be asked about it.
 *   **A note, never an error**: Claude Code sweeps its transcripts on `cleanupPeriodDays`
 *   and OpenCode's retention is its own, so for a session opened weeks ago this is the
 *   expected answer. What the session *wrote* is unaffected (DECISIONS.md §8).
 * - `none` — the harness still knows the session and holds nothing under it. The session
 *   really produced nothing.
 * - `absent` — nothing has ever been said in this period: its row was written before the
 *   session existed (`0025`) and the session was never created, so there is no conversation
 *   rather than no prose. Reporting that with the harness's "I no longer hold that session"
 *   sentence would tell an operator their message had been lost.
 */
export const ConversationSource = Schema.Literals([
  "harness",
  "pending",
  "forgotten",
  "none",
  "absent",
]);
export type ConversationSource = typeof ConversationSource.Type;

/**
 * What the next message to a period will do, decided by the server and never guessed by a
 * browser.
 *
 * **This is the field that stops a composer being offered for a message that will fail.**
 *
 * - `live` — this process holds the session: the message is delivered into it as a steer,
 *   under this same period id.
 * - `resume` — this process does not hold it and the harness can continue it. The
 *   conversation keeps its identity and the agent keeps its own history; what changes is the
 *   period id.
 * - `fresh` — the conversation cannot be continued, so the next message opens a **new
 *   session**. The note says why, and what is carried forward.
 * - `refused` — no message is accepted, and a new session is the way on. **Not only the
 *   operator's end**: the owner's refusal says which, and a screen must word it from that
 *   rather than read every `refused` as an end.
 */
export const ConversationContinuation = Schema.Literals([
  "live",
  "resume",
  "fresh",
  "refused",
]);
export type ConversationContinuation = typeof ConversationContinuation.Type;

/**
 * A message the operator sent into a live session that the harness's transcript does **not
 * yet hold**: delivered as a steer, and either still queued behind the turn running, or
 * taken and not yet written (A6 U4 review, review 2).
 *
 * The harness's transcript does not hold such a message until it takes it — and Claude Code
 * narrates the take 30–130 ms before it writes the entry — so a replay of the transcript
 * alone loses it on a reload, and the reply to it then reads as part of the turn before.
 * The server holds it from the moment the send is accepted until a replay has read it in the
 * transcript, or the session settles or closes (review 3), and the replay carries it beside
 * the transcript for as long as the transcript does not hold its id
 * (`LiveItem.messageIds` on the replayed `turn.operator`), so a reloaded tab draws it once:
 * queued while it waits, as its own turn once taken.
 */
export const ConversationQueuedMessage = Schema.Struct({
  /** The id the send was answered with (`messageId` on the accepted turn). */
  messageId: Schema.String,
  /** The operator's own words, as sent. Untrusted text, as every message is. */
  text: Schema.String,
  /** When the server accepted it (`acceptedAt` on the accepted turn). */
  acceptedAt: EpochMillis,
  /**
   * Whether the harness has said it took the message (`turn.taken`): it is being worked on,
   * not waiting, and is drawn as its own turn rather than queued. A take is narrated only
   * on the lossy live channel, so a tab reloaded after it has no other way to know.
   */
  taken: Schema.Boolean,
  /**
   * When the harness took this message **together with others** in one take (A6 U4 review
   * 3), every message of that take, this one included, oldest first — Claude Code stores
   * such a take as one entry, and a chat draws it as one turn. Absent on a message taken
   * alone and on one still waiting.
   */
  takenTogether: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The harness's process ended before it took the message (harness-instances slice 3
   * fix): it lived in that process's queue and **was never delivered**, nor will it be. A
   * chat draws it as not delivered, never as sent. Absent on every other message.
   */
  lost: Schema.optionalKey(Schema.Literal(true)),
});
export type ConversationQueuedMessage = typeof ConversationQueuedMessage.Type;

/**
 * One period as a reloaded tab replays it (S6): every field but the period id and the
 * continuation, which the owner's schema adds (the continuation as a union, so a refusal
 * exists only where it is true).
 *
 * **The harness's copy, and nothing of ours.** This build stores no word of a conversation
 * (DECISIONS.md §8), so this is the only thing a refresh can show and the harness decides
 * how long it lasts.
 */
export const conversationViewFields = {
  targetId: Schema.String,
  /** The session this was read from, or null when the period never got one. */
  harnessSessionId: Schema.NullOr(Schema.String),
  /**
   * Whether **this process** is holding that session.
   *
   * False with a non-null session id is the restart case: the id is ours, the prose may
   * still come back, and the in-memory grant that let the agent act is gone. Whether the
   * conversation can be carried on from there is a *separate* question, and the
   * continuation is the one that answers it.
   */
  live: Schema.Boolean,
  source: ConversationSource,
  /** True only for `harness`: what is shown can disappear. */
  ephemeral: Schema.Boolean,
  /** A sentence for the operator, set on every source including a successful read. */
  note: Schema.String,
  /**
   * The conversation as the **same items the live stream carries** (A6 F10), oldest first
   * and all of them up to the limit, each with the owner's subject id set. A `user` entry is
   * **the operator's own words**: the server trims its own framing off at the delimiter it
   * wrote itself, an exact split rather than a guess. Ids are `replay:<n>`: a render key,
   * not a cursor.
   */
  items: Schema.Array(LiveItem),
  /**
   * The operator's messages this process delivered into the live session that {@link items}
   * does not hold, oldest first (A6 U4 review). **The one exception to "nothing of ours"**:
   * held in memory by this process only, never stored, and empty on any session this process
   * does not hold (`live` false). Joined to {@link items} by id, never by time (review 2).
   */
  queued: Schema.Array(ConversationQueuedMessage),
  /**
   * The question the session's agent is waiting on, or null (A7-Q): from the harness when
   * this process holds the session, `live` then; otherwise from the transcript, as `message`
   * or `not_resumable`.
   */
  question: Schema.NullOr(PendingQuestion),
  /** Messages this answer stopped short of. */
  truncated: Schema.Boolean,
  /** How many harness entries produced no item. See `RoundNarration.omittedBlank`. */
  omittedBlank: Schema.Int,
  /**
   * When this answer was built, on the server's clock. **Not the replay/live floor**: the
   * floor is an activity publish order the browser takes before the request leaves.
   */
  at: EpochMillis,
};

/**
 * Why a period ended (`0027`).
 *
 * Only `operator` means the authority is over: the operator ended the conversation, its
 * tools refuse every write under it, and a message to it is refused. The others are the
 * server letting go — `shutdown` on the way down, `refused` for a prompt the harness would
 * not take, `process_gone` for a session whose harness process had ended on its own (found
 * by the next message or Stop), `open_failed` for a session that never opened — and a
 * message to such a period opens a fresh session under a new period id rather than being
 * refused.
 */
export const ConversationEndReason = Schema.Literals([
  "operator",
  "shutdown",
  "refused",
  "process_gone",
  "open_failed",
]);
export type ConversationEndReason = typeof ConversationEndReason.Type;

/**
 * One harness session of an owner, as a session picker reads it: every field but the period
 * a message goes to and the owner's own figures, which the owner's schema adds.
 *
 * **A pointer, not a conversation.** `sessionId` is the harness's own id; nothing about what
 * was said is on this view, and a row here never means the harness still holds the session.
 * Several periods on one session are one view.
 */
export const conversationSessionFields = {
  /** The harness's session id. Unique within the list. */
  sessionId: Schema.String,
  /**
   * The harness instance that minted it, or null for a row written before instances were
   * recorded. A session recorded against an instance this server does not run must not be
   * asked about — the harness we do have would answer "no such session" for a session that
   * may be alive elsewhere.
   */
  harnessInstanceId: Schema.NullOr(Schema.String),
  /** The model it ran on, as `provider/model`. */
  model: Schema.String,
  /**
   * When the session was opened, in epoch milliseconds, from bit's own durable row: what
   * identifies a session when {@link title} cannot.
   */
  openedAt: Schema.Int,
  /**
   * What the harness calls this session, as one line of at most 120 characters, or null.
   * Read from the harness on every list and never stored; agent-authored text, so a plain
   * label, never markup. Null means the screen labels the session by {@link openedAt}.
   */
  title: Schema.NullOr(Schema.String),
  /**
   * Whether a period on this session is going **right now, in this server process**. Read
   * from the live registry and not stored: a restart forgets it.
   */
  running: Schema.Boolean,
  /**
   * When the session's latest period ended, in epoch milliseconds, or null while it has not
   * (`0026`). Stored and never cleared. **Null is not "live"**: a session open when the
   * server died reads null and is unreachable through this process all the same.
   */
  endedAt: Schema.NullOr(Schema.Int),
  /** Why, beside {@link endedAt}. `operator` is the one a composer is disabled on. */
  endedReason: Schema.NullOr(ConversationEndReason),
  /**
   * The agent this session runs as (`AgentView.id`), pinned when its first message was sent:
   * a reopen reads it back off the row rather than choosing again.
   */
  agentId: Schema.String,
};
