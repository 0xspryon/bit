/**
 * The live transcript, as contracts: what a browser watching a run receives.
 *
 * ## Two channels, and the whole design is in keeping them apart
 *
 * A screen that shows a run as it happens is showing two different kinds of thing, and
 * collapsing them is the one mistake this file exists to prevent.
 *
 * - **The record.** The target's own event log: committed rows, each carrying a
 *   store-assigned `sequence` the store decided inside the writing transaction
 *   (DECISIONS.md §3, §8). A consumer reads it in ascending sequence order after a cursor,
 *   so the order on the wire *is* the order the store assigned, every item has a position
 *   that can be resumed from, and an item delivered twice is recognisable because its
 *   sequence is one already seen. {@link LiveOrigin} `record`.
 * - **Live activity.** What the harness is narrating and what the policy gate is deciding,
 *   in this process, right now. Neither is written to the event log — `run/narration.ts`
 *   records why narration is not, and reading the gate's decisions back as a persisted log
 *   is its own later day — so neither has a store-assigned position, and this contract
 *   does not give them one: {@link LiveItem.sequence} is `null` on every activity item.
 *   {@link LiveOrigin} `activity`.
 *
 * **What that costs is stated rather than hidden.** An activity item is not durable, is
 * not resumable, and can be dropped under load: both buses it comes from are sliding
 * buffers, chosen so a slow browser tab cannot slow down a running agent. So a reload does
 * not reconstruct the activity it missed, and nothing in this application reconciles
 * against it — the attempt row and the event log are what say what happened. A screen
 * showing the two channels identically would be promising a durability only one of them
 * has, which is why {@link LiveOrigin} is on every item and not inferred.
 *
 * ## One thing on this stream is neither channel
 *
 * {@link LiveUsage} is a *measurement*, not an item: how big the context was on one model
 * call, for the meter at the top of a chat. It has no id, no sequence and nothing to show
 * twice, because a reader keeps the latest per model call rather than accumulating them —
 * and accumulating them is the one mistake it exists to prevent, since the token figures
 * both drivers publish most readily are spend totals that read four to five times higher
 * than the context (DECISIONS.md §24.4). Its own documentation has the measured numbers and
 * the list of fields a numerator must never come from.
 *
 * ## What "without duplicates" means, exactly
 *
 * Every item carries an {@link LiveItem.id} that is stable for that item, and a client
 * that keeps the ids it has shown will not show one twice. For a `record` item the id is
 * derived from the store's own event id, so it is stable across connections and across a
 * restart — which is what makes a reconnect able to re-read a range without the operator
 * seeing it again. For an `activity` item the id is this process's publish order, which is
 * unique within one server run and meaningless outside it; there is no replay on that
 * channel, so there is nothing for it to collide with.
 *
 * ## Partial items: a block while it is being written
 *
 * A reply or a thinking block can be shown while the agent is still writing it (A6 F6). The
 * server sends **partial** items for it — `turn.reply` or `turn.thinking` like the finished
 * block, with {@link LiveItem.streaming} `true` and the **whole text so far** in `body`,
 * never a piece of it — at most one per block every ~50 ms, and then the finished block,
 * which has no `streaming`. All of them carry the same {@link LiveItem.blockId}.
 *
 * How a client applies them:
 *
 * - A partial **replaces** whatever the client shows for its `blockId`, or is shown new.
 *   Its `id` is that frame's own (`activity:<n>`, like any narration item) and identifies
 *   nothing else, so a client must not let it hide the next partial or the finished block.
 * - The finished block **replaces** the partial with its `blockId`, and no partial for that
 *   block follows it.
 * - Partials are lossy twice over and a client must not mind: the server coalesces, and the
 *   bus drops the oldest frames for a reader that is behind. Each carries all the text so
 *   far, so a missed one costs nothing once the next one, or the finished block, arrives.
 * - **Partials are never stored and never replayed.** They carry `sequence: null` and move
 *   no cursor. A reconnect, or a reload, catches up from finished blocks only, so a block
 *   still being written then shows nothing until it ends. A partial whose finished block
 *   never comes — a turn cut off mid-block — stays as last sent until the client drops it.
 * - **A partial is capped at 4,000 characters, a finished reply at 32,000** (A6 U5 review).
 *   A partial is cut at its cap with **no** mark (A6 U5 review 2) — a client reads a partial
 *   exactly 4,000 characters long as past it — and stops growing while the agent goes on;
 *   the finished reply then replaces it with the whole of it, up to its own cap, where a
 *   cut does end in the server's `… (shortened)` mark. Thinking and every tool field stay at
 *   4,000, finished or not.
 * - {@link LiveItem.blockCall} names a block's model call, so a client that needs "the same
 *   call" compares it rather than reading into `blockId`.
 *
 * **A client asks for partials** (`partials=1` on the live endpoint) and gets none
 * otherwise. That is the forward-compatibility rule for this one feature: a tab one deploy
 * behind deduplicates by `id` and would show every partial as a reply of its own, so it is
 * sent exactly the frames it always was. A tab that receives one anyway still decodes it —
 * both fields are optional keys, and a struct that does not know them ignores them.
 *
 * Browser-safe: Effect Schema and `effect/http-api` only.
 */
import { Schema } from "effect";

import { LiveQuestion } from "./question";

import { MessageAttachmentView } from "./messageUpload";
import { SubagentView } from "./subagent";

/** Epoch milliseconds. `Schema.Finite` so NaN and Infinity are refused, not shipped. */
const EpochMillis = Schema.Finite.annotate({
  description: "Epoch milliseconds.",
});

/**
 * How often an idle connection sends a {@link LiveCursor}, in seconds.
 *
 * **This is in the contract because three independent things have to agree about it, and
 * two of them are not the stream.** It is the number a `LiveCursor` frame's arrival rate is
 * promised at, so:
 *
 * 1. The stream must actually send one this often — `run/liveTranscript.ts`'s
 *    `LIVE_HEARTBEAT` is derived from this value rather than chosen beside it.
 * 2. **The listener's idle timeout must be longer than it.** `Bun.serve` closes a
 *    connection with no traffic in either direction after `idleTimeout`, which defaults to
 *    **10 seconds** — shorter than this — so a quiet SSE connection was being closed by the
 *    server at ~10s, before the heartbeat that would have kept it alive ever fired. The
 *    listener derives its timeout from this constant for that reason
 *    (`http/controlPlane.ts`). Observed in a browser: the transcript went dead after ten
 *    seconds on a quiet target and nothing said so.
 * 3. **A client's patience must be longer than it.** See
 *    {@link LIVE_SILENCE_LIMIT_SECONDS}.
 *
 * Twenty seconds: short enough to sit well inside the ~30s an idle HTTP connection commonly
 * survives behind a proxy, long enough that a watcher on a quiet target costs one frame
 * every twenty seconds rather than one a second.
 */
export const LIVE_HEARTBEAT_SECONDS = 20;

/**
 * How long a client waits for *any* frame before it treats the connection as gone.
 *
 * Twice {@link LIVE_HEARTBEAT_SECONDS}, so one lost or late heartbeat is not read as a dead
 * connection while two in a row is.
 *
 * **It exists because a closed upstream does not always close the downstream.** The stream
 * ending is the obvious signal and it is not a reliable one: through a dev-server proxy —
 * and through any reverse proxy that buffers — the browser's response can stay open after
 * the server's side has gone, so the client is never told anything. Observed in a browser:
 * the transcript kept its `Live` chip and its last cursor indefinitely after the server had
 * closed the connection. Silence is the only signal available in that case, and this is how
 * long silence has to last before it means something.
 *
 * On silence the client stops claiming to be live, closes the stalled stream and reconnects
 * from its last delivered record cursor. It says `Reconnecting` until the committed record
 * has caught up; in-process activity missed during the gap has no cursor and cannot be
 * replayed.
 */
export const LIVE_SILENCE_LIMIT_SECONDS = LIVE_HEARTBEAT_SECONDS * 2;

/**
 * Which channel an item came from. See this module's header; never inferred from the kind.
 *
 * - `record` — a committed event, with a store-assigned {@link LiveItem.sequence}.
 * - `activity` — in-process, advisory, lossy, no position.
 */
export const LiveOrigin = Schema.Literals(["record", "activity"]);
export type LiveOrigin = typeof LiveOrigin.Type;

/**
 * The item kinds this build projects.
 *
 * `kind` on {@link LiveItem} is `Schema.String` rather than this union, for the reason
 * `event.ts` gives for `RecordedEvent.kind`: the set only grows, and a browser tab that is
 * one deploy behind must render an item it does not recognise rather than failing to
 * decode the frame it arrived in. This is what *we* send; a reader tolerates more.
 *
 * `record.other` is not a fallback the server reaches by accident — it is how it says so
 * when it meets a committed event whose kind this build does not render. Such an event
 * still appears, with its sequence, because dropping it would leave a hole in the record
 * and a gap in the sequence a reader would be right to read as a lost item. There is no
 * counterpart on the activity channel: an unrenderable narration entry is simply dropped,
 * which is sound there precisely because that channel makes no completeness claim.
 *
 * ## The policy gate's *allowed* decisions are deliberately not here
 *
 * The gate answers every tool call, allow or deny, and only the denials are projected.
 * That is not an omission, it is the day's "nothing appears twice": a permitted call is
 * already on this stream as `tool.call`, carrying the same tool and the same arguments
 * from the harness's own narration, and adding the gate's agreement beside it would show
 * one tool call as two items. A **denial** is the opposite case — the one thing narration
 * cannot tell you, because the gate refuses before the tool runs, so without the gate's
 * own word a refused action would be invisible. What the allow *basis* says about how
 * little constrains a run today is worth a screen of its own, and that screen is not this
 * one.
 *
 * ## `action.denied` is **not** every refused action, and here is exactly which ones
 *
 * This is worth stating plainly rather than leaving a reader to infer completeness from a
 * kind called `action.denied`. A screen showing no denials means "none of *these*", not
 * "nothing was refused".
 *
 * **What does appear:** a refusal the control plane decided — the host boundary or a
 * forbidden path fragment — for a session this server can place against a running attempt.
 *
 * **What does not, and why each one cannot:**
 *
 * - **A fail-closed denial.** When the policy service cannot be reached, answers badly or
 *   times out, the harness-side hook denies *on its own*, writes `denied_failclosed` to the
 *   engagement's audit file, and never gets an answer from the control plane — so there is
 *   no decision here to project. That is the correct ordering (the gate must not depend on
 *   this feed existing) and it means **the audit file is the only place a fail-closed
 *   denial is recorded.** It is also the case most worth seeing on a screen, which is why
 *   reading that file back is its own day's work rather than something to half-do here.
 * - **A malformed request.** The decide route refuses an undecodable body with a `400` and
 *   deliberately records nothing about a request it never understood, so it cannot reach
 *   this feed either.
 * - **A denial whose session cannot be placed.** The hook sends a harness session id and
 *   nothing else; a decision answered after its attempt has settled and left the
 *   supervisor's map has no attempt to attribute it to, and is dropped rather than guessed
 *   at. The window is small and the audit file still has it.
 *
 * And one more thing an operator has to know about today's deployment specifically: a
 * browser-started run is gated by a config that **records and permits**, so a real run
 * through this screen produces no denials at all. That is the perimeter boundary the
 * compose-box slice accepted on purpose, not a gap in this one.
 */
export const LIVE_ITEM_KINDS = [
  /* The record. */
  "run.started",
  "run.settled",
  "observation.recorded",
  "asset.recorded",
  /**
   * An asset the scope importer read off a program page (D14) — `asset.recorded`'s
   * sibling, and a separate item for the reason it is a separate event (`event.ts`): that
   * one answers "which attempt found this" and this one "which page it was read off".
   *
   * A second rendering of an `asset_imports` row, as `asset.recorded` is of an
   * `asset_discoveries` one, and treated the same way: `outcome` is `new` or `known`,
   * because a host the estate already held is a second provenance row on an existing
   * asset and must not read as a new one. It reaches the importer's chat through
   * {@link LiveItem.importId}, read from the caller scope, where it is the receipt of the
   * `record_imported_asset` call that wrote it.
   *
   * An **exact retry** of that call (`operation_id` reused) replays the stored result and
   * writes nothing, so it has no record — which is correct for an idempotent write and
   * means a reader pairing calls to records must not count a replayed call. The tool's
   * own result says `replayed: true`.
   */
  "asset.imported",
  /**
   * An entry written onto a target's scope: by the importer's `add_scope_entry`, or by the
   * operator in the Scope tab.
   *
   * Here for the importer's chat, which has nothing else durable to show: its prose is the
   * harness's and may be gone after a reload, and these records — with `asset.imported` —
   * are what the session actually did. {@link LiveItem.importId} is set only for the
   * importer's own writes, from the caller scope, so an operator's typing reaches no chat.
   *
   * **Every `add_scope_entry` produces exactly one**, including an add of an entry that
   * already exists, which writes nothing to the scope and a record carrying
   * `created: false` (the importer conversation design, S5.1). That is what lets a chat
   * fold the Nth call into the Nth record: before it, a no-op produced a call and no
   * record and every later receipt named the wrong entry. `outcome` is `new` or `known`,
   * as on the asset kinds, and the body of a no-op says the entry was already in scope.
   * A refused add writes nothing — the transaction rolls back — and its call carries a
   * failed result instead.
   */
  "scope.entry.added",
  "intent.added",
  "goal.added",
  "goal.ended",
  "intent.abandoned",
  "intent.released",
  /**
   * A planner round beginning and ending.
   *
   * **These two carry more weight than the kinds around them.** Every other item here is
   * a second rendering of something durable: an observation, an asset, an intent. A
   * planner round's own content is narration, which this build does not persist at all
   * (`docs/design/goal-and-planner-flow.md` decision 14), so these are the *only* record
   * that a round happened — which is what decision 16 means by round boundaries coming
   * from records. A planner transcript reloaded after a restart is these two items and
   * nothing between them, and that is the honest degradation rather than an empty screen.
   *
   * `attemptId` is null on both, and not because it was unavailable: a round is not an
   * attempt and has no attempt behind it. The round's own id is in
   * {@link LiveItem.roundId}, which the planner chat groups by — and in the item's `body`
   * as well, because the sentence has to read on a screen that does no grouping.
   */
  "plan.round.started",
  "plan.round.settled",
  /**
   * A live round having been steered by the goal agent.
   *
   * Here for the reason the two around it are here and one more: a steer is `opaque` on
   * both drivers' narration (DECISIONS.md §24.1), so this record is the **only** place it
   * is ever visible, live or replayed. It carries no directive text — see `event.ts` — so
   * the item's `body` says that a steer landed and what urgency it was delivered at, and
   * nothing about what was said.
   *
   * It appears in two chats, which is correct rather than a duplication: under the round
   * in the planner view ({@link LiveItem.roundId}, the event's subject) and in the goal
   * conversation ({@link LiveItem.goalId}, from the goal agent's own caller scope), where
   * it is the record half of the `steer_planner` tool call the agent made.
   */
  "plan.round.steered",
  "record.other",
  /* Live activity. */
  "turn.reply",
  /**
   * What the agent considered before it said or did anything.
   *
   * **Streamed and never stored**, which is a stronger statement than the rest of this
   * channel's. Every other activity kind is lossy *by accident* — the buses are sliding
   * buffers — whereas this one is lossy by decision: there is no durable field for it, no
   * evidence, no transcript artefact. A reload reads it back from the **harness's** own copy
   * like the rest of a conversation (A6 F10), so it lives as long as the harness's retention
   * and no longer — bit never holds a copy.
   *
   * It is **a record of what was considered, not of what happened**, and nothing on this
   * stream contradicts that: the thing that happened is the `turn.reply` or the `tool.call`
   * beside it, and those are the rows an operator acts on. A reader that presented thinking
   * as the account of a run would be quoting a draft as a result, which is why it is
   * rendered collapsed and labelled as what it is.
   *
   * Both drivers can fill it: Claude Code's `thinking` content blocks and OpenCode's
   * `session.reasoning.ended` (which carries the whole block's text, exactly as
   * `session.text.ended` does for a reply). The text is in {@link LiveItem.body}. An empty
   * block — Claude Code emits `{ type: "thinking", thinking: "" }` when the provider
   * returns no readable reasoning, observed in DECISIONS.md §24.4's probe — produces no
   * item at all rather than an empty one.
   */
  "turn.thinking",
  "tool.call",
  "tool.result",
  /**
   * The operator's own words in a conversation (A6 F10).
   *
   * Never on the live stream: a tab mints its own for a message it sent (`operatorTurn` in
   * the web's `chat.ts`), because nothing stores what the operator said. The server writes
   * one only in a **replay** — a `user` entry the harness holds for an importer or goal
   * conversation, with this server's framing trimmed off — so a reloaded conversation draws
   * the operator's turns as the live one did.
   */
  "turn.operator",
  /**
   * Something the harness holds for a session that is neither the agent's reply, thinking
   * or tool use nor the operator's words (A6 F10), named in {@link LiveItem.headline} by the
   * harness's own word: an OpenCode `shell` or `synthetic` entry, a steer a planner round
   * was sent (`user`), or an `error` the harness recorded on a turn (`outcome` `failed`).
   * Replay only, except `error`, which is live too (A6 U4): a turn the harness ended with
   * an error of its own — a provider refusing the call — says so as it happens, with the
   * harness's sentence in `body`. Labelled with that word so it never reads as the agent
   * having said it.
   */
  "turn.other",
  /**
   * The harness **took** a message the operator sent while a turn was running (A6 U4): it
   * was queued behind the work in flight and is now in the conversation. Carries
   * {@link LiveItem.messageIds} — the ids the sends' answers named
   * (`ImporterTurnAccepted.messageId`), several when the harness took them as one — and
   * nothing to read. Live only: a replay holds the
   * message itself, where the harness put it. A chat draws the message as queued until
   * this arrives, and never draws this item.
   */
  "turn.taken",
  /**
   * The harness ended a message's turn **before it wrote anything** and sent the message on
   * with the next one, whose turn reads both (A6 U6 review 2) — and whose reply, if a Stop
   * does not end that turn first (review 3), answers both. Lands in that turn, after
   * its take, and carries its {@link LiveItem.messageIds} where the message had ids; nothing
   * to read. A chat draws the turn as gone on with the next message, never this item as a
   * row.
   *
   * Live when Claude Code cuts such a turn for a Send now (`priority: "now"`): it aborts the
   * turn's request before any output and asks the model again with both messages. In a
   * replay, wherever the harness stored one operator message directly before another with
   * nothing between — not after a session's last message, nor before the CLI's interrupt
   * marker.
   */
  "turn.carried",
  /**
   * A **sub-agent** the agent started, in place of everything it did (A6 U14, decided by
   * the operator). One state of it: several items share one {@link LiveItem.callId} — the
   * calling tool call's — as it starts and ends, and a reader keeps the newest per call and
   * draws **one entry** where the first arrived. Live and replayed alike: both drivers
   * narrate their sub-agent tool (Claude Code's `Agent`, OpenCode's `subagent`) as this
   * and the sub-agent's own thinking, tool calls and replies as nothing.
   *
   * - `headline`: its type as the calling agent asked for it (`general-purpose`,
   *   `explore`), or `sub-agent` when the call named none. **Agent text**, plain.
   * - `body`: the calling agent's short description of its task, or the start of the prompt
   *   it gave, one line, at most 200 characters. **Agent text**, plain.
   * - `outcome`: `running`, `finished`, `failed` or `stopped`.
   * - `tool` / `toolName`: the calling tool as the harness named it; `callId` as above.
   *
   * Since A7-S (E7, decided by the operator: cards replace U14's "omit content") the item
   * also carries {@link LiveItem.subagent}: its last tool lines, what it is doing now, and
   * once finished what it returned, as the sub-agent wrote it. Its own thinking and replies
   * are still not rows of the calling agent's. The `turn.other` note (`task`) a Claude Code
   * replay draws for a notification whose call it does not hold (launched before a
   * compaction) still carries the notification's summary or status alone.
   */
  "subagent",
  "action.denied",
] as const;

export const LiveItemKind = Schema.Literals(LIVE_ITEM_KINDS);
export type LiveItemKind = typeof LiveItemKind.Type;

/**
 * One thing to show in a live transcript.
 *
 * One struct rather than a union per kind, and that is a considered trade. A union would
 * make "a tool call has no observation outcome" a type-level fact; what it would also do is
 * make every unknown kind undecodable, which is exactly the property the header says this
 * contract must not have. So the shape is one struct whose optional parts are `null` when
 * they do not apply, and the fields are named for what they hold rather than for one kind
 * that uses them.
 *
 * `headline` and `body` are the server's own words. They are here, rather than being
 * composed in the browser, because the server is where the sentence can be accurate: it
 * has the policy gate's reason, the resolver's words for a harness, and the store's
 * payload. A browser that rephrased them would be inventing wording for states it cannot
 * see.
 */
export const LiveItem = Schema.Struct({
  _tag: Schema.Literal("item"),
  /**
   * Stable identity, for not showing the same item twice.
   *
   * `record:<eventId>` for a committed event — the store's own id, so it is the same
   * string on every connection that reads that event. `activity:<n>` for an activity item,
   * where `n` is this process's publish order. The prefix is part of the id so the two
   * spaces cannot collide.
   */
  id: Schema.String,
  origin: LiveOrigin,
  /**
   * The store-assigned position, or `null`.
   *
   * Set on every `record` item and on no `activity` item. It is the cursor: a client that
   * remembers the highest one it has seen can ask a later connection to resume after it,
   * and the server reads `WHERE sequence > cursor ORDER BY sequence`, so nothing committed
   * between the two connections is skipped.
   */
  sequence: Schema.NullOr(Schema.Int),
  /** One of {@link LIVE_ITEM_KINDS}, or something a later build added. */
  kind: Schema.String,
  /**
   * When it happened, in epoch milliseconds.
   *
   * For a `record` item this is the store's `recordedAt`, written in the same transaction
   * as the row. For an activity item it is when the harness said it or when this process
   * answered the gate. **Not an ordering key**: `sequence` is, and only on the record
   * channel. Two items can share a millisecond and a run's clocks are not all the same
   * clock, which is why ordering is never taken from this field.
   */
  at: EpochMillis,
  /**
   * The attempt this item is **about**, when there is one.
   *
   * About, not "whose authority produced it", and the distinction is load-bearing: the
   * event log keeps caller authority and domain subject in different columns on purpose
   * (`event.ts`), and an attempt's own `started` and `settled` events are host-originated —
   * so they have no caller attempt and carry the attempt as their *subject*. A reader
   * filtering a target's transcript down to one run needs both of those, so this field is
   * the one answer to "which run is this" and the server resolves it.
   *
   * `null` for an item about something with no run behind it at all.
   */
  attemptId: Schema.NullOr(Schema.String),
  /**
   * The planner round this item belongs to, when there is one.
   *
   * **The planner chat's grouping key, and the reason it can exist at all.** A planner
   * round's own content is narration, which this build does not persist (the goal and
   * planner flow's decision 14), so a screen that wants to show one round's turns under
   * one heading has to be told which round each item is. Nothing else on this struct can
   * answer that: `attemptId` is null on everything a round produces, because a round is
   * not an attempt.
   *
   * It is set three ways and each is the server's, never the browser's:
   *
   * - **`plan.round.started` and `plan.round.settled`** — the round is the event's own
   *   subject, so this is that subject.
   * - **A record a round wrote** — `intent.added` from `add_intent`, `goal.ended` from a
   *   planner's `objective_met`. The round is read from the event's caller scope, which
   *   slice 4 namespaced as `<targetId>/round/<roundId>` precisely so attribution of this
   *   kind does not have to be guessed from the payload.
   * - **A round's narration** — the supervisor publishes under the round whose session it
   *   opened, exactly as an attempt's narration is published under its attempt.
   *
   * `null` for everything else, including every item a worker produced. An earlier build
   * put a round's id in {@link body} and said a field would be "designing the planner
   * screen's filter before the screen exists"; the screen exists now, and a sentence is
   * not a filter.
   */
  roundId: Schema.NullOr(Schema.String),
  /**
   * The goal this item belongs to, when it is part of a goal's **conversation**.
   *
   * {@link roundId}'s sibling and the goal conversation's grouping key. It is deliberately
   * **not** "the goal this item is about": an `intent.added` written by a planner round is
   * about a goal and is not part of the conversation, and putting it in both chats would
   * show one write twice on one page.
   *
   * It is set exactly two ways, both the server's:
   *
   * - **The goal agent's own narration** — published under the goal whose session the
   *   conversation service opened, exactly as an attempt's is published under its attempt.
   * - **A record the goal agent wrote** — read from the event's caller scope, which slice
   *   4 namespaced as `<targetId>/goal/<goalId>`. Today that is `goal.ended` from
   *   `end_goal` and `plan.round.steered` from `steer_planner`.
   *
   * `null` for everything else, including every record a round or a worker wrote.
   */
  goalId: Schema.NullOr(Schema.String),
  /**
   * The scope import this item belongs to, when it is part of an importer **conversation**.
   *
   * The fourth sibling, and the importer chat's filter: an importer session is keyed by
   * import id (one authority period, `0027`), so that is the only id that can say which of a
   * target's importer chats an entry belongs in. None of the other three can: an importer
   * session is not an attempt, a round or a goal's agent, so all three are null on
   * everything it says.
   *
   * It is set two ways, as {@link goalId} is:
   *
   * - **The importer's own narration** — published under the import whose session the
   *   importer opened, exactly as a goal agent's is published under its goal.
   * - **A record the importer wrote** — read from the event's caller scope,
   *   `<targetId>/import/<importId>`. That is its `scope.entry.added` and `asset.imported`
   *   (the importer conversation design, S5).
   *
   * `null` for everything else, including the same two kinds written by the operator from
   * the Scope tab, whose scope is `<targetId>/operator`.
   */
  importId: Schema.NullOr(Schema.String),
  /** A short label: the tool's name, `Denied`, `Observation recorded`. */
  headline: Schema.String,
  /** A sentence for the operator. The gate's reason, the store's claim, the reply's text. */
  body: Schema.String,
  /**
   * The tool a `tool.*` or `action.*` item is about, **as the harness named it**.
   *
   * Verbatim, which means namespaced: a tool from an MCP server this application registered
   * arrives as `mcp__bit-<id>__add_intent` under Claude Code and `bit-<id>.add_intent` under
   * OpenCode. That is the string to show a reader who is matching it against a harness's own
   * log, and it is the wrong string to match on in code — see {@link LiveItem.toolName}.
   */
  tool: Schema.NullOr(Schema.String),
  /**
   * The same tool with this application's MCP namespacing removed, for matching on.
   *
   * **Both fields exist because a screen needs one and the code needs the other, and
   * conflating them shipped a broken merge rule.** The planner chat recognises `add_intent`
   * in order to collapse a tool call into the record it produced; keyed on {@link tool} it
   * recognised nothing, because the wire form embeds the round id and differs per driver. So
   * the reduction is done **here, on the server**, where the registration's own name is
   * known — `mcpToolName.ts` has the two observed forms and the evidence for each — rather
   * than guessed at in a browser from a separator.
   *
   * Equal to {@link tool} for anything that is not one of ours: a harness's own `bash` is
   * `bash` in both fields. `null` wherever {@link tool} is null.
   */
  toolName: Schema.NullOr(Schema.String),
  /**
   * The harness's own id for the tool call this item belongs to.
   *
   * **This is what pairs a `tool.result` with its `tool.call`, and nothing else can.** An
   * agent runs tools concurrently — both harnesses do — so results do not arrive in the
   * order the calls were made, and two calls to the same tool are indistinguishable by
   * name. Matching on `tool` would pair a result with whichever call to `bash` happened to
   * be nearest on screen, which is a misattribution of a command's output to the wrong
   * command.
   *
   * Set on `tool.call` and `tool.result`. `null` everywhere else, and `null` on a
   * `tool.result` whose call the harness never named — see `NarrationDetail` on why that is
   * reachable. A reader with no `callId` must not fall back to the tool name; it should
   * leave the item unpaired, which is the honest rendering of "we cannot tell which call
   * this answers".
   *
   * It is **not** an identity for the item: {@link id} is. Several items share a `callId` by
   * design, which is the whole point of it.
   */
  callId: Schema.NullOr(Schema.String),
  /** A tool call's arguments as JSON text, already capped by the server. */
  input: Schema.NullOr(Schema.String),
  /** A tool call's own output, already capped by the server. */
  output: Schema.NullOr(Schema.String),
  /**
   * How it turned out, in the vocabulary of this item's own kind.
   *
   * `positive` / `negative` / `inconclusive` for an observation; the attempt's terminal
   * status for `run.settled`; `failed` or `ok` for a tool result; `denied` for a refused
   * action. Deliberately not normalised into one scale: those are not comparable, and a
   * shared vocabulary would have to flatten "the tool errored" and "the test found
   * nothing" into the same word.
   */
  outcome: Schema.NullOr(Schema.String),
  /**
   * Which block this item is, on a `turn.reply` or `turn.thinking`: shared by the block's
   * partial updates and its finished block, and the key a client replaces by (this module's
   * header). An opaque string — compare it, never parse it. Absent on every other kind.
   *
   * **Its presence does not mean the block streamed.** A replayed block carries the key its
   * stream used whether or not anything streamed it: Claude Code's replay gives every text
   * and thinking block one, from its call's id and its index in that call, and OpenCode's
   * from its message id and its ordinal in its channel. It is absent only where the driver
   * could not name the block — an entry with no call or message id, or one whose words came
   * as plain text rather than as blocks.
   *
   * An optional key rather than a `null` field like the rest, so a frame from a build
   * without it, and a stored fixture, still decode.
   */
  blockId: Schema.optionalKey(Schema.String),
  /**
   * Which **model call** wrote this block, on an item that carries a {@link blockId}: the
   * same on every block of one call — its partials, its finished copy, its replayed copy —
   * and different on any other call's. Opaque, like `blockId`: compare it, never parse it.
   *
   * Set by the server from what the harness names the call by (A6 U5 review): Claude Code's
   * `message.id`, OpenCode's `assistantMessageID`, under the harness session. Two rules need
   * "the same call" and could otherwise only get it by reading into `blockId`: a thought is
   * no longer being written once a reply of its own call has started (GLM closes its
   * reasoning only at the step's end), and a block of a newer call ends an older call's
   * partials. Absent wherever `blockId` is, or where the driver could not name the call; a
   * reader then treats the block as its own call, which makes both rules do nothing.
   */
  blockCall: Schema.optionalKey(Schema.String),
  /**
   * `true` on a **partial** item: the block is still being written and `body` is its text
   * so far. Absent on the finished block and on every other item. See this module's header
   * for how a client applies one; it is never stored and never replayed.
   */
  streaming: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The model that produced this item, as the harness named it, on the agent's own items —
   * a reply, thinking, a tool call — when the harness said (A6 F10). What a turn's footer
   * names, rather than the session's current model, which a switch moves (D6).
   *
   * Claude Code's `message.model` (a dated id, `claude-haiku-4-5-20251001`), live and
   * replayed; OpenCode's `provider/model` of the assistant message, replayed, and live from
   * the step that opened it. Absent wherever the harness did not say: a tool result, an
   * operator turn, a record, a block streamed before its step's model was seen.
   */
  model: Schema.optionalKey(Schema.String),
  /**
   * On a replayed `turn.operator` item, the files the operator's message carried (A6 F9),
   * in the order they were sent: read from the harness's transcript, with the prompt's
   * `[Attached …]` lines taken out of {@link body} so a path is not shown twice. Absent on
   * a message that carried none, and on every other kind.
   */
  attachments: Schema.optionalKey(Schema.Array(MessageAttachmentView)),
  /**
   * On a record a write tool produced, the id the write that produced it is known by, so a
   * client can join the record to its call by content rather than by position (A6 F10
   * review): the entry id on `scope.entry.added` — the `entry_id` its `add_scope_entry`
   * call's result carries — and the operation id on `asset.imported` — the `operation_id`
   * its `record_imported_asset` call was sent with.
   *
   * Pairing by position alone mis-files a record as soon as either side is cut short: a
   * replay that keeps only the newest items and a record feed that opens part way back are
   * cut independently, so the i-th call left on screen is not the i-th record's writer.
   * Absent on every other record and on every activity item, and an optional key like
   * {@link blockId} so a frame from a build without it still decodes.
   */
  writeId: Schema.optionalKey(Schema.String),
  /**
   * The application's ids for operator messages — each the `messageId` its send was answered
   * with — on the items that are about them, oldest first and never empty: a `turn.taken`
   * item, naming the messages the harness took; a **replayed** `turn.operator` item that the
   * harness stored under an id derived from ours (A6 U4 review 2); and an operator row a
   * client drew for a message of its own. A client joins its own row, the take and the
   * transcript's copy by id rather than by words or time.
   *
   * **A list, because a harness can take several messages as one** (A6 U4 review 3). Claude
   * Code dequeues every steer waiting behind a turn at once, names them all on one frame,
   * and stores them as **one** user entry — their words joined by a line break — under the
   * last one's uuid. So one take, and one replayed message, can be several of ours, and a
   * chat draws them as one turn. OpenCode takes them one at a time: always one id there.
   *
   * Absent on every other item — including a replayed message the server cannot name, such
   * as an opening prompt — and an optional key so older frames still decode.
   */
  messageIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * `true` on a **replayed** item whose `at` is when the harness began the entry it came
   * from, and nothing says when that entry ended (A6 U4 review). OpenCode stores times per
   * message, so every part of a message shares one; a replay stamps a finished message's
   * parts with its `time.completed`, which is what a live item's `at` approximates — and a
   * message the harness never marked completed gets its start and this flag. A turn footer
   * measures no length from a turn holding one, rather than a wrong one. Absent everywhere
   * else, and an optional key so older frames still decode.
   */
  endUnknown: Schema.optionalKey(Schema.Literal(true)),
  /**
   * On a `subagent` item, the sub-agent as its card draws it (A7-S, E7): its task, timing,
   * call count, last tool lines, what it is doing now, what it returned, why it failed and
   * whether it can be stopped on its own. The item's own `headline`, `body` and `outcome`
   * still say its type, description and status, as they did before A7-S. Absent on every
   * other kind, and an optional key so older frames still decode.
   */
  subagent: Schema.optionalKey(SubagentView),
});
export type LiveItem = typeof LiveItem.Type;

/**
 * The first frame, sent once, before any item.
 *
 * It exists so the client knows what it is about to be shown rather than inferring it. In
 * particular `skipped` is the honest answer to a replay budget: a target with a long
 * history, opened with no cursor, does not get its whole event log pushed down an SSE
 * connection, and a screen that silently showed the tail as though it were the whole
 * record would be the wrong kind of quiet.
 */
export const LiveOpened = Schema.Struct({
  _tag: Schema.Literal("opened"),
  targetId: Schema.String,
  /**
   * The cursor this connection reads after. The first record item has `sequence > from`.
   *
   * Either what the client asked for, or — when it asked for nothing — far enough back to
   * fill one screen and no further.
   */
  from: Schema.Int,
  /** The highest sequence the target's log held when this connection opened. */
  latest: Schema.Int,
  /**
   * How many committed events before `from` this connection will not send.
   *
   * `0` when the client passed a cursor, or when the whole log fits the replay budget.
   * Non-zero means the record shown here starts part way through, which is a thing an
   * operator has to be told rather than left to notice.
   *
   * **It is `from` itself, which assumes the log's sequences are contiguous from 1**, and
   * that assumption is a real property of the store rather than an approximation: the
   * counter is bumped inside the writing transaction, so a mutation that rolls back leaves
   * no gap for this count to be wrong about (`store.test.ts`, "a refused mutation leaves no
   * event sequence gap for the next one to skip"). Were a gap ever introduced — a future
   * build assigning sequences outside a transaction, or deleting event rows — this would
   * over-count, and the honest reading of it would weaken from "how many" to "the record
   * starts this far in".
   */
  skipped: Schema.Int,
  at: EpochMillis,
});
export type LiveOpened = typeof LiveOpened.Type;

/**
 * Where the record channel has got to.
 *
 * Sent after each catch-up batch and then periodically, which makes it two things at once
 * and both are wanted: the cursor a client stores for its next connection, and the bytes
 * that keep an idle SSE connection from being closed by something in the middle.
 *
 * `caughtUp` is the one bit of state a screen genuinely needs beyond the items: it is the
 * difference between "this is the history arriving" and "this is now", and a spinner that
 * could not tell them apart would spin forever on a target with nothing running.
 */
export const LiveCursor = Schema.Struct({
  _tag: Schema.Literal("cursor"),
  sequence: Schema.Int,
  /** Every committed event up to `sequence` has been sent on this connection. */
  caughtUp: Schema.Boolean,
  at: EpochMillis,
});
export type LiveCursor = typeof LiveCursor.Type;

/**
 * How big the context was on **one model call**, for the meter at the top of a pane.
 *
 * ## Why this is a frame of its own and not a {@link LiveItem}
 *
 * It is not a turn. Nothing about it belongs in a transcript: it has no sentence, it is not
 * something the agent did, and a list that rendered one row per model call would bury the
 * work under its own instrumentation. It is a *measurement about the session*, so it
 * travels beside the items. The numbers are also numbers, and carrying them in
 * {@link LiveItem}'s string fields would mean a browser parsing a figure out of prose.
 *
 * **What that costs, stated rather than discovered later: a tab from a previous deploy
 * cannot decode this frame.** {@link LiveItem.kind} is a plain `String` precisely so a tab
 * one deploy behind renders an unknown *kind* rather than failing on the frame it arrived
 * in; a new `_tag` in {@link LiveFrame} has no such tolerance, and it could not be given one
 * retroactively — the old tab has the old union compiled into it. So such a tab's stream
 * fails on the first model call of any run and reconnects in a loop until the page is
 * reloaded, which cures it.
 *
 * The alternative was a sixteenth {@link LiveItem} field set and a kind the item channel
 * would tolerate, and it was **not** better: that tab would then fill its transcript with a
 * row per model call that it has no rendering for, during exactly the run the operator is
 * watching. Neither shape leaves a stale tab usable, both are cured by a reload, and only
 * one of them puts token counts on the contract every reader of a transcript branches on.
 *
 * ## The one thing that is easy to get wrong here, stated once and loudly
 *
 * **Every figure either driver publishes most readily is a *spend total*, and a meter fed
 * from one reads four to five times too high.** DECISIONS.md §24.4 measured it on both:
 * OpenCode's `session.usage.updated` summed to 65 838 against a real context of 13 753,
 * and Claude Code's `result.usage` to 90 784 against 23 179. The cause is the same on each
 * — the cached prefix is re-counted on every call, which is the right way to bill and the
 * wrong way to measure fullness.
 *
 * So the numerator here is **per model call**, and these are the fields it is never taken
 * from: OpenCode's `session.usage.updated`, `session.tokens` and `GET /api/session/:id`;
 * Claude Code's `result.usage`, `modelUsage` and `total_cost_usd`; and
 * `SessionStatus.tokens`, which is the *session* total on one driver and the *last turn's*
 * on the other and therefore is not even one wrong thing consistently.
 *
 * ## What a reader does with several of these
 *
 * **Keeps the latest per {@link callId} and draws the newest call — it never sums them.**
 * Two frames share a `callId` for two different reasons, and both are ordinary:
 *
 * - Claude Code delivers one API call as several `assistant` frames, one per content block,
 *   each repeating the same `message.id` and the same usage. Counting per frame would
 *   multiply one call by two or three.
 * - That call's output count is **stale** on those frames (a call that produced 16 tokens
 *   reported 1), so {@link outputTokens} is `null` on them and is stated later, once, from
 *   the turn's `result`. That later frame is the same call, topping itself up.
 */
export const LiveUsage = Schema.Struct({
  _tag: Schema.Literal("usage"),
  /**
   * The harness's own id for the model call this measures.
   *
   * OpenCode's `assistantMessageID` from `session.step.ended`; Claude Code's `message.id`.
   * The de-duplication key — see this struct's header — and not an identity for the frame,
   * which has none and needs none: a frame that arrived twice would replace itself with
   * itself.
   */
  callId: Schema.String,
  /**
   * Tokens sent to the model on this call: uncached input, cache reads and cache writes.
   *
   * Exact on both drivers and the bulk of the meter. The three parts are disjoint — on
   * OpenCode `input` is the *uncached* remainder and `cache.read` the cached prefix — so
   * this is a sum and not a maximum.
   *
   * Cache read and cache write are deliberately not separate fields: `cache.write` was a
   * constant 0 on the OpenCode provider measured, so a reader could not tell "nothing was
   * written" from "this provider does not report writes", and the seam's rule is that a
   * field exists only where both drivers can fill it with the same meaning.
   */
  promptTokens: Schema.Int,
  /**
   * Tokens generated on this call, thinking included, or `null` while unstated.
   *
   * `null` is **not** zero and must not be drawn as a precise figure: Claude Code's
   * `assistant` frames carry a stale count, so this build omits it there rather than
   * publishing the 1 or 2 they say, and states it from the turn's `result` instead. Until
   * then the meter runs short by tens to hundreds of tokens against a window of hundreds of
   * thousands, which is worth saying rather than rounding away.
   *
   * "Thinking included" is what makes it mean the same thing on both drivers, and it takes
   * opposite work on each: OpenCode reports `reasoning` *beside* `output`, so they are
   * added, while Claude Code's `output_tokens_details.thinking_tokens` is already inside
   * `output_tokens`.
   */
  outputTokens: Schema.NullOr(Schema.Int),
  /**
   * The model's context window, when this driver has stated it by now, else `null`.
   *
   * Optional because it genuinely is: OpenCode has it in the catalogue before anything runs
   * (`HarnessModelView.contextLimit`), and Claude Code has it only once a session exists.
   * **A percentage is drawn only when this is set.** Where it is `null` the meter shows the
   * token figure alone — an honest "14,870 tokens" rather than a fabricated "7%".
   */
  contextLimit: Schema.NullOr(Schema.Int),
  /**
   * Where the **harness itself** will summarise this session, or `null`.
   *
   * Not a smaller limit: {@link contextLimit} is what the provider accepts, and this is the
   * point at which the harness rewrites the conversation on its own. They are far apart —
   * OpenCode compacts bit's default model at about **58 %** of its window — so a meter that
   * drew only the denominator would be telling an operator that nothing happens until it
   * reads full, which is the opposite of true.
   *
   * **Derived from the driver's own source, not reported by it.**
   * `HarnessModelView.compactionAt` carries the formula, the file and line, and the three
   * things that can move it without moving this number. A consumer draws it as *where the
   * harness says it will act* and never as a measurement.
   *
   * `null` on Claude Code, whose threshold this build has not measured.
   */
  compactionAt: Schema.NullOr(Schema.Int),
  /**
   * The model that made this call, in the harness's own spelling (Claude Code's
   * `message.model`, OpenCode's step `provider/model`), or `null` where the stream did not
   * say. Not always the model the session is on now: a call running when a switch lands
   * finishes on the old one. Compare with `sameModel` (`conversationContext.ts`).
   */
  model: Schema.NullOr(Schema.String),
  /**
   * Whose session this call belongs to, exactly as {@link LiveItem} carries it.
   *
   * One of the four is set. A page showing a planner round and a goal conversation side by
   * side has two meters on it, and nothing but this says which figure is which — the two
   * agents have their own sessions, their own models and their own windows.
   */
  attemptId: Schema.NullOr(Schema.String),
  roundId: Schema.NullOr(Schema.String),
  goalId: Schema.NullOr(Schema.String),
  importId: Schema.NullOr(Schema.String),
  /** When the harness said it, in epoch milliseconds. Not an ordering key. */
  at: EpochMillis,
});
export type LiveUsage = typeof LiveUsage.Type;

/**
 * A session's turn ended (A7 U8b review): its summary on the Agent sessions list has moved
 * from running to idle, and a client showing that list, or the rail's count, reads it again.
 *
 * **Why it is a frame and not inferred from the items.** The entry that ends a turn is
 * often one nothing renders — OpenCode's `session.execution.succeeded` is `opaque`, Claude
 * Code's `result` a `usage` measurement — so a client watching items saw the turn's last
 * reply and then nothing, and a list read between that reply and the turn's end said
 * "Running" until something else narrated (measured: 20 s and more). This is the turn's end
 * itself, sent after the server has folded it, so a read it prompts sees it.
 *
 * Nothing to show and nothing to keep: like {@link LiveUsage} it has no id, no sequence and
 * is not a transcript row, and it carries only whose session it was. Activity-channel, so
 * lossy: a client that misses one is corrected by its next read. The cost is the one
 * {@link LiveUsage} states for a new `_tag`: a tab a deploy behind cannot decode it and
 * reconnects until it is reloaded.
 */
export const LiveTurnEnded = Schema.Struct({
  _tag: Schema.Literal("turnEnded"),
  attemptId: Schema.NullOr(Schema.String),
  roundId: Schema.NullOr(Schema.String),
  goalId: Schema.NullOr(Schema.String),
  importId: Schema.NullOr(Schema.String),
  at: EpochMillis,
});
export type LiveTurnEnded = typeof LiveTurnEnded.Type;

/**
 * The harness's narration of one session stopped reaching this server, or reaches it again
 * (U13 review 5).
 *
 * The server reads a session's narration over a connection to the harness (OpenCode's event
 * stream is an HTTP request), and that connection can break — an oversized event, the
 * harness restarting. The server makes it again with backoff and says where it stands:
 *
 * - `reconnecting` — it broke; nothing the session says is reaching the chat until it is back.
 * - `restored` — it is back. What was said in between is **not** sent again: a client reads
 *   the session's replay, which holds it.
 * - `lost` — it has kept failing (about 30 s). The server goes on trying, and a later
 *   `restored` still comes; until then the chat shows nothing new, and a reload is how to
 *   see what the harness has.
 * - `closed` — the server stopped reading the session's narration for good, because the
 *   session's authority ended here: the operator ended it (in this tab, another, or over the
 *   API), the server is shutting down, or the harness refused a prompt (A7-Q, from the chat
 *   shell's review 2). Nothing more comes for it on this connection, so a notice about the
 *   connection is over; whether the session can be carried on is the session list's answer,
 *   and a client reads it again.
 *
 * `detail` is the transport's own words for the break, `""` on `restored`. Whose session it
 * is, exactly as {@link LiveUsage} says it. Activity-channel and lossy, like
 * {@link LiveTurnEnded}; the cost of a new `_tag` is the one those state.
 */
export const LiveConnection = Schema.Struct({
  _tag: Schema.Literal("connection"),
  state: Schema.Literals(["reconnecting", "restored", "lost", "closed"]),
  detail: Schema.String,
  attemptId: Schema.NullOr(Schema.String),
  roundId: Schema.NullOr(Schema.String),
  goalId: Schema.NullOr(Schema.String),
  importId: Schema.NullOr(Schema.String),
  at: EpochMillis,
});
export type LiveConnection = typeof LiveConnection.Type;

/**
 * One frame of the live transcript.
 *
 * Tagged, because a client has to branch on it, and discriminated by `_tag` rather than by
 * the presence of a field so a frame kind added later cannot be mistaken for one of these.
 */
export const LiveFrame = Schema.Union([
  LiveOpened,
  LiveItem,
  LiveCursor,
  LiveUsage,
  LiveTurnEnded,
  LiveConnection,
  LiveQuestion,
]);
export type LiveFrame = typeof LiveFrame.Type;
