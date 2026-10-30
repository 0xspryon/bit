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
 * Browser-safe: Effect Schema and `effect/http-api` only.
 */
import { Schema } from "effect";

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
  "tool.call",
  "tool.result",
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
 * One frame of the live transcript.
 *
 * Tagged, because a client has to branch on it, and discriminated by `_tag` rather than by
 * the presence of a field so a frame kind added later cannot be mistaken for one of these.
 */
export const LiveFrame = Schema.Union([LiveOpened, LiveItem, LiveCursor]);
export type LiveFrame = typeof LiveFrame.Type;
