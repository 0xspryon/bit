/**
 * The scope importer's conversation, cut into groups, as plain functions.
 *
 * ## One group per operator message
 *
 * A group opens when the operator sends something and holds everything the agent did in
 * reply — its prose and its tool calls — until the next operator message. That is the whole
 * rule, and it is the importer's own: the planner groups by a durable round and a goal
 * conversation is one stretch, but an importer session has neither. What it has is turns,
 * and a turn is exactly "what the operator asked, and what the agent did about it".
 *
 * {@link Chat} takes the group's subject as a type parameter it never looks inside, so this
 * file declares {@link ThreadTurn} and `ImporterChat.svelte` renders its separator from
 * it. Nothing here borrows a round's vocabulary.
 *
 * ## Where the groups come from, and why there are two cuts
 *
 * A session reaches the browser two ways and they cut differently:
 *
 * - **The harness's copy** (`history`), a flat list of `user` and `assistant` messages. A
 *   turn opens at each `user` entry. Reduced, so no tool calls: the agent's words are all
 *   there is. Replayed prose, labelled as the harness's, which it may have deleted.
 * - **The live feed** (`items`), where the operator's own message is a minted
 *   `turn.operator` row (see {@link operatorTurn}) and a turn opens at each of those. The
 *   importer's replies, thinking, tool calls and their results arrive here as narration,
 *   and the records its writes produced (`scope.entry.added`, `asset.imported`) as
 *   records, all filed by import id ({@link conversationFeed}). `rowsFor` folds each write call
 *   into its record, so a call and its receipt are one row (S5).
 *
 * Replayed turns come first, then live ones, and the floor between them is
 * {@link ConversationSession.historyFloor} — the activity publish order this tab had seen when
 * the replay was asked for, held against each live entry by {@link conversationFeed}. That is the
 * same job `buildGoalConversation`'s `narrationFloor` does and it is what makes "no message
 * appears twice" structural rather than hopeful: everything the server's answer contains was
 * published at or below the floor, and everything after it is only live.
 *
 * The operator's own rows need no text match, unlike the goal chat's, and the reason is the
 * arrangement rather than luck: the replay is asked for when a session is **opened**, so
 * every `turn.operator` row this tab mints is minted after the answer it could have collided
 * with. It is read **again** in one case only (A6 U4 review): a `turn.taken` naming a
 * message this tab has no row for — one sent from another tab ({@link takesUnknownMessage}).
 * That read is joined to this tab's rows **by message id** ({@link withReplay}, A6 U4 review
 * 2): the server's answer holds every steer it accepted before the read began exactly once,
 * in the transcript (a `turn.operator` naming it in `messageIds`) or beside it (`queued`), so
 * a row of this tab's is dropped for the transcript's copy, kept for a held one, and kept
 * when the answer does not have it at all.
 *
 * ## What is not joined, and says so
 *
 * A **record** (an entry the importer wrote, an asset it recorded) survives a reload and
 * the harness's message does not necessarily, but nothing on the wire says which message a
 * record answered. So records that arrive with no operator row before them land in the
 * leading group, "earlier in this session", rather than under a turn they may not belong
 * to. Placing them by timestamp would be a guess, and `LiveItem.at` is documented as not an
 * ordering key. This is the honest degradation, and the group's own note says it.
 *
 * **This is decided, not pending** (the importer conversation design, S5.2): no turn ordinal
 * is carried on the wire to place them. That would be a durable column on `scope_entries`
 * and `asset_imports`, or a side table, for a cosmetic grouping on a screen whose durable
 * half is reviewed on the Assets list anyway. Live records are placed by the narration
 * around them, which needs no ordinal; only a reload's records go to the leading group.
 *
 * ## The notes are the server's now, except the two that are about this page
 *
 * They used to be stand-ins written here, because there was no endpoint to write them. There
 * is one (S6): `ConversationReplayView.note` carries a sentence for every one of the five
 * answers, and {@link ConversationHistory} passes it through untouched. What is still written
 * here is the handful that are **not** about the harness's copy — the leading group's "nothing
 * on the record says which message each one answered", {@link ENDED_NOTE} and
 * {@link strandedNote} — each of which is a fact about this screen or about a row the page
 * already holds, not an answer only the server could give.
 */
import {
  CONVERSATION_MESSAGE_MAX_CHARS,
  type ConversationModelSwitched,
  type ConversationQueuedMessage,
  type ConversationSource,
  type LiveItem,
  type ModelOptionSelection,
  type PendingQuestion,
} from "@bit/contracts";

import {
  CARRIED_KIND,
  OPERATOR_TURN_KIND,
  REPLY_KIND,
  TAKEN_KIND,
  THINKING_KIND,
  activityOrder,
  claimedRecords,
  foldSubagents,
  isPartial,
  operatorTurn,
  rowsFor,
  type ChatGroup,
  type RoundProse,
} from "./chat";
import {
  parkedMark,
  parkedStart,
  type ParkedMessage,
} from "./conversationParked";
import type { ThreadTurn } from "./chatShell";
import { proseRuns } from "./markdown";

/**
 * What a session's next message would be refused with, as the server words it: the owner's
 * reason (the importer's `import_ended`, `agent_unavailable`) and its sentence.
 */
export interface ConversationRefusalView {
  readonly reason: string;
  readonly detail: string;
}

/**
 * One period's replay as any owner's server answers it (`conversationViewFields` and the
 * continuation): what {@link historyOf} and {@link withReplay} read. The importer's
 * `ImporterConversationView` is one.
 */
export type ConversationReplayView = {
  readonly source: ConversationSource;
  readonly note: string;
  readonly truncated: boolean;
  readonly items: readonly LiveItem[];
  readonly queued: readonly ConversationQueuedMessage[];
  readonly question: PendingQuestion | null;
  /** When the server built the answer, on its clock. */
  readonly at: number;
} & (
  | { readonly continuation: "live" | "resume" | "fresh" }
  | {
      readonly continuation: "refused";
      readonly refusal: ConversationRefusalView;
    }
);

/**
 * What a session's row says it holds, for the picker: `messages` alone, `0` for the empty
 * thread the operator types into and `null` for every other session (what was said is the
 * harness's). An owner's tally adds its own figures (the importer's entries and assets).
 */
export interface ConversationTally {
  readonly messages: 0 | null;
}

/**
 * What an importer group's separator needs, and the whole of what the chat is given.
 *
 * `message` is `null` for the leading group, which has no operator message because it is
 * what came before the first one this tab can see. The shape is the chat shell's
 * ({@link ThreadTurn}): nothing in it is the importer's, and the goal, planner and worker
 * chats draw the same turns.
 */

/**
 * The note on a turn the page was reloaded into part way through a block ({@link
 * ThreadTurn.midBlock}).
 */
export const MID_BLOCK_NOTE =
  "This reply is still being written; it shows here with its next words, or once the block is finished.";

/**
 * The note on a turn the harness ended before it wrote anything and sent on with the next
 * message (A6 U6 review 2, a `turn.carried` item in the turn). What a Claude Code turn a
 * Send now cut that early reads, live and after a reload, in place of an error or "no
 * reply". **It promises no reply** (review 3): a Stop pressed just after the Send now ends
 * the next turn too, before it answers, and that turn says so itself ({@link STOPPED_NOTE}).
 */
export const CARRIED_NOTE =
  "Went on with the next message: the harness sent the two on together.";

/**
 * The note on a turn a Stop ended before the importer wrote anything in it (A6 U6 review 3):
 * the turn holds only the harness's interrupt marker ({@link isInterruptMarker}), live as
 * after a reload, in place of "not answered yet" — which a turn that is over never is — or
 * the marker's bare `[Request interrupted by user]`.
 */
export const stoppedNote = (agent: string): string =>
  `Stopped before the ${agent} wrote anything in reply.`;

/** One importer turn as a chat group. */
export type ConversationGroup = ChatGroup<ThreadTurn>;

/**
 * What the harness answered when asked for this session's messages.
 *
 * The server's five answers (`ImporterConversationSource`) plus one of the page's own:
 * `loading`, which is "this tab has asked and has no answer yet" and is therefore not a fact
 * about the session at all. `none` is the harness holding nothing under a session it still
 * knows; `absent` is nothing ever having been said in the import, which is a different fact
 * and gets a different sentence.
 */
export interface ConversationHistory {
  readonly source:
    "loading" | "none" | "absent" | "harness" | "pending" | "forgotten";
  /** A sentence for the operator. Empty when `source` is `none` or `loading`. */
  readonly note: string;
  /** True when the harness holds more than it returned — and it stopped short of the oldest. */
  readonly truncated: boolean;
  /**
   * The replay, oldest first, as the live stream's own items (A6 F10): the operator's
   * `turn.operator` rows and the importer's replies, thinking and tool calls. Empty unless
   * `source` is `harness`.
   */
  readonly items: readonly LiveItem[];
  /**
   * What the server will do with the next message, in its words rather than this page's.
   *
   * **The field the composer is enabled from**, and it is the server's because only the
   * server can know it: whether this process still holds the session, and — for one it does
   * not — whether the harness will continue it, which is a round trip to the harness. A page
   * that guessed would offer a composer for a message the server then refuses, which is a
   * message the operator writes and loses.
   *
   * Absent until the server has answered, which is the `loading` case: a composer is offered
   * meanwhile, because an unknown is not a refusal and the server's own refusal is the one
   * that counts. A union, as the server's view is, so a `refused` answer always carries
   * which refusal it is and its sentence, and nothing else carries one: the page words an
   * end from `import_ended` and shows the server's sentence for any other refusal, and never
   * reads `refused` alone as an end.
   */
  readonly standing?: ConversationStanding;
  /**
   * The question the session's agent is waiting on (A7-Q): the replay's, then moved by the
   * live `question` frames. `null` for none; absent where the server has not said.
   */
  readonly question?: PendingQuestion | null;
}

/** What the next message will do: the server's answer, with a refusal only on `refused`. */
export type ConversationStanding =
  | { readonly continuation: "live" | "resume" | "fresh" }
  | {
      readonly continuation: "refused";
      readonly refusal: ConversationRefusalView;
    };

export const NO_HISTORY: ConversationHistory = {
  source: "none",
  note: "",
  truncated: false,
  items: [],
};

/**
 * The server's answer as the page holds it (S6).
 *
 * A straight reduction: the view carries two things this type does not keep — `live` and
 * `harnessSessionId` — because {@link ConversationHistory.continuation} already answers the only
 * question the screen asks of them, and a page holding both would start deriving its own
 * answer from them beside the server's.
 */
export const historyOf = (
  view: ConversationReplayView,
): ConversationHistory => ({
  source: view.source,
  note: view.note,
  truncated: view.truncated,
  items: view.items,
  question: view.question,
  standing:
    view.continuation === "refused"
      ? { continuation: "refused", refusal: view.refusal }
      : { continuation: view.continuation },
});

/**
 * One importer session as the page holds it.
 *
 * **Two kinds, told apart by {@link indexed}.** An *indexed* session is one the server
 * lists (`GET .../importer-sessions`): its identity, model, harness, time, whether it is
 * running and its tally are real, and its `items` are empty and its `history` says so,
 * because nothing that was said in it is stored here. Every other session is the page's own
 * — the empty one the operator types into, and the declared ones the state picker loads
 * (`mockImporter.ts`) — and all of it is mock.
 *
 * `tally` is the server's count of what the session wrote, kept apart from `items` on
 * purpose: a reloaded tab holds records but not the calls that made them, so a figure
 * derived from what is on screen would disagree with the Assets page.
 */
export interface ConversationSession<
  Tally extends ConversationTally = ConversationTally,
> {
  readonly id: string;
  readonly startedAt: number;
  /**
   * What the harness calls the session (S9), one line of at most 120 characters, or absent
   * where it has no name to give: before its first turn is over, once the harness has swept
   * it, or when it could not be asked in time. Read through on every list and never kept, so
   * a retitle shows on the next read. Agent-authored text: drawn as a plain, bidi-isolated
   * label, never as markup. {@link startedAt} is always shown beside it ({@link sessionLabel}).
   */
  readonly title?: string;
  /** `provider/model`, shown and not editable: changing harness starts a new session. */
  readonly model: string;
  /** The harness it ran on, by display name: the glyph on the composer's model chip. */
  readonly harness: string;
  readonly history: ConversationHistory;
  /**
   * What this page holds of the session itself, oldest first: the operator's own rows
   * (minted here, see `operatorTurn`), and in the state picker's declared sessions every
   * row. **Not** what the importer said on a real target — that is the target's live feed,
   * filed by {@link importId} and merged in by {@link conversationFeed}, so an entry is held in
   * one place and never copied into a session.
   */
  readonly items: readonly LiveItem[];
  /**
   * The activity publish order this tab had seen when each of the operator's rows in
   * {@link items} was sent, keyed by the row's id.
   *
   * What places the importer's words under the message they answer: `SentTurn.after` on
   * the goal path, and the same join. Absent on a row the page did not send against a
   * server — the declared sessions' — which then sorts before every live entry.
   */
  readonly floors?: Readonly<Record<string, number>>;
  readonly working: boolean;
  readonly tally: Tally;
  /** Opened from the picker and not written to since: read-only until the operator types. */
  readonly reading: boolean;
  /** True when the server lists this session. Absent on the page's own. */
  readonly indexed?: boolean;
  /**
   * True once the server has answered about this session's messages (S6).
   *
   * **What separates "its thread is empty" from "its thread has not arrived".** A re-read of
   * the session list replaces an untouched indexed session wholesale, which would otherwise
   * put the `loading` history back over an answer that had already come — and then ask for it
   * again, for ever. A loaded session is kept the way a typed-into one is.
   */
  readonly loaded?: boolean;
  /**
   * The activity publish order this tab had seen when the replay was **asked for**.
   *
   * The replay/live boundary, and the caller's to hold:
   * {@link conversationFeed} drops live narration at or below it, because the server's answer
   * already contains it. `buildGoalConversation`'s `narrationFloor` exactly, and a count of
   * publish order rather than a time for its reason — the browser's clock and the server's
   * are different clocks.
   *
   * Absent on a session whose replay was never asked for, which takes nothing away: the
   * page's own empty session has no history to double up with.
   */
  readonly historyFloor?: number;
  /**
   * The harness instance this session was minted by when this server **does not run it**,
   * and absent otherwise.
   *
   * The session may be alive on that harness elsewhere, and the harness this server does
   * have would answer "no such session" about it: so it must not be asked, and a message
   * typed into it must not be sent. Only an indexed session can carry it, and only once the
   * harness listing has arrived: before that an unknown instance is unknown, not gone.
   */
  readonly strandedOn?: string;
  /**
   * The import a message to this session is addressed to, as the server answered it. Absent
   * on the page's own empty session until its first message is accepted, which is what
   * makes that message open a conversation rather than continue one.
   */
  readonly importId?: string;
  /**
   * True when the operator ended this session (`ended_reason = 'operator'`). Its authority is
   * over and the server refuses a message to it, so the composer is disabled rather than
   * offered. A session the *server* let go of — shut down, a refused prompt — is not this:
   * a message to it opens a fresh session, and the server says so.
   */
  readonly ended?: boolean;
  /**
   * The agent this session runs as (`AgentView.id`). On a session the server lists, the one
   * its row pinned at the first message. On the page's own empty session, the one the
   * operator picked on the agent chip for its first message, or absent for the server's
   * default (`AgentsView.defaultAgentId`). Never changed once the session has a message.
   */
  readonly agentId?: string;
  /**
   * The harness instance the session is pinned to (`HarnessInstanceView.instanceId`), when
   * the server named it: the index row's, or the instance an accepted first message opened
   * on. What a model switch is offered within — another instance is a new session.
   */
  readonly harnessInstanceId?: string;
  /**
   * What the session's model is set to, when this tab knows: the options its opening
   * message sent, or what the server answered a switch with. Absent when unknown.
   *
   * V2(chat): the index row does not carry a session's model options, so after a reload the
   * picker's Reasoning column starts on the model's default rather than the session's own
   * setting — which is still what a switch from there sends, since the server sets exactly
   * the options a switch names. V2 puts `modelOptions` on `ImporterSessionView`.
   */
  readonly modelOptions?: readonly ModelOptionSelection[];
  /**
   * The operator rows in {@link items} that were sent while a turn was running and were
   * delivered as steers (they carry `messageIds`), by row id (A6 U4). Such a row is queued
   * until a `turn.taken` item names its message: see {@link conversationFeed} for where it is
   * placed meanwhile and {@link ThreadTurn.queued} for how it is drawn.
   */
  readonly midTurn?: readonly string[];
  /**
   * The messages sent with "Send now" (A6 U6) — `preemptive` steers — by the id the server
   * delivered each under (`ImporterTurnAccepted.messageId`). By message rather than by row,
   * so the mark survives the replay read again at the turn's end, which draws the harness's
   * copy of the message (carrying the same id) in place of this tab's row.
   *
   * V2(chat): this tab's knowledge only, as {@link midTurn} is. The server's queued messages
   * (`ConversationReplayView.queued`) do not carry the urgency they were sent at, so after
   * a reload a "Send now" message the harness has not taken yet is drawn as queued, and one it
   * took as an ordinary turn. V2 records the urgency on the server's held steer
   * (`ImporterQueuedMessage.urgency`) and reads it back here.
   */
  readonly sentNow?: readonly string[];
  /**
   * True while work the agent started in the background — a background subagent or shell —
   * is still running outside any turn, as the turn watch last heard from the server (A6 U6).
   * Stop is offered for it: a Stop with no turn running stops it (`background_stopped`).
   */
  readonly background?: boolean;
  /**
   * Each `turn.taken` item this tab has seen for this session, by the message it names,
   * kept from the first sighting (A6 U4 review) — as {@link floors} are, and for their
   * reason: the live feed is a sliding window (`App.LIVE_KEPT`), and a take that slid out
   * of it would put its message back in the queue, and its turn's work back under the turn
   * before. Recorded by `ImporterSessions.noteTaken`.
   */
  readonly taken?: Readonly<Record<string, LiveItem>>;
  /**
   * True when the replay on screen was read while the session was working (A6 U5 review 3):
   * it can lack the finished blocks of the model call that was running, which
   * {@link conversationFeed} then keeps from the live feed until a replay read idle replaces it.
   */
  readonly replayMidTurn?: boolean;
}

export { TAKEN_KIND };

/**
 * Each `turn.taken` item by the message it names: those this session recorded
 * ({@link ConversationSession.taken}), and any in `items` it has not.
 */
const takenByMessage = (
  items: readonly LiveItem[],
  recorded?: Readonly<Record<string, LiveItem>>,
): ReadonlyMap<string, LiveItem> => {
  const taken = new Map<string, LiveItem>(Object.entries(recorded ?? {}));
  for (const item of items) {
    if (item.kind !== TAKEN_KIND) continue;
    for (const id of item.messageIds ?? []) {
      if (!taken.has(id)) taken.set(id, item);
    }
  }
  return taken;
};

/** The messages an item is about ({@link LiveItem.messageIds}), none when it names none. */
export const messagesOf = (item: LiveItem): readonly string[] =>
  item.messageIds ?? [];

/** The take that took a row's messages, if this session has seen one. */
const takeOf = (
  row: LiveItem,
  taken: ReadonlyMap<string, LiveItem>,
): LiveItem | undefined =>
  messagesOf(row)
    .map((id) => taken.get(id))
    .find((take) => take !== undefined);

/**
 * The rows a replay's held messages are drawn as (A6 U4 review): each the operator's row for
 * its message, carrying the message's id so its `turn.taken` finds it, at the time the
 * server accepted it. Ids of their own (`operator:queued:<id>`), so no row this tab mints
 * later can share one.
 *
 * Messages the harness took as one (`takenTogether`, A6 U4 review 3) are **one** row: their
 * words in the order they were sent, a line apart — as the harness stored them — under the
 * first one's time, naming all of them. One message, one turn, one reply.
 */
export const queuedRows = (
  queued: ConversationReplayView["queued"],
  floor: number,
): readonly LiveItem[] => {
  const rows: LiveItem[] = [];
  const grouped = new Map<string, number>();
  for (const message of queued) {
    const together = message.takenTogether;
    const at =
      together === undefined
        ? undefined
        : together
            .map((id) => grouped.get(id))
            .find((index) => index !== undefined);
    const joined = at === undefined ? undefined : rows[at];
    if (at !== undefined && joined !== undefined) {
      rows[at] = {
        ...joined,
        body: `${joined.body}\n${message.text}`,
        messageIds: [...messagesOf(joined), message.messageId],
      };
      grouped.set(message.messageId, at);
      continue;
    }
    grouped.set(message.messageId, rows.length);
    rows.push({
      ...operatorTurn({
        index: 0,
        text: message.text,
        at: message.acceptedAt,
        after: floor,
      }),
      id: `operator:queued:${message.messageId}`,
      messageIds: [message.messageId],
    });
  }
  return rows;
};

/**
 * The conversation with the operator rows the harness took **as one** made one row (A6 U4
 * review 3): Claude Code takes every steer waiting behind a turn at once and stores them as
 * one message, answered by one reply, so they are one turn here too — live as after a
 * reload, which draws the stored entry. The rows a take naming several messages finds are
 * joined into the first of them, their words a line apart in the order they came, and the
 * later ones removed; what followed each stays where it was, now in the one turn. A take of
 * one message, and a row no take names, are left alone.
 */
/**
 * What one take is known by when rows are joined: the messages it names, sorted (A6 U4
 * step 0). Not its `id` — an activity item's id is this process's publish order
 * (`activity:<n>`), which restarts at zero with the server, so a take recorded before a
 * restart and one seen after it can share one. A message is taken once, so two takes
 * never name the same messages.
 */
const takeKey = (take: LiveItem): string =>
  [...messagesOf(take)].sort().join("\n");

const joinedByTake = (
  items: readonly LiveItem[],
  taken: ReadonlyMap<string, LiveItem>,
): readonly LiveItem[] => {
  const first = new Map<string, number>();
  const joined: LiveItem[] = [];
  for (const item of items) {
    const take =
      item.kind === OPERATOR_TURN_KIND ? takeOf(item, taken) : undefined;
    if (take === undefined || messagesOf(take).length < 2) {
      joined.push(item);
      continue;
    }
    const key = takeKey(take);
    const at = first.get(key);
    const into = at === undefined ? undefined : joined[at];
    if (at === undefined || into === undefined) {
      first.set(key, joined.length);
      joined.push(item);
      continue;
    }
    joined[at] = {
      ...into,
      body: `${into.body}\n${item.body}`,
      messageIds: [...messagesOf(into), ...messagesOf(item)],
      ...(into.attachments === undefined && item.attachments === undefined
        ? {}
        : {
            attachments: [
              ...(into.attachments ?? []),
              ...(item.attachments ?? []),
            ],
          }),
    };
  }
  return joined;
};

/**
 * The message ids a replay's transcript holds: its `turn.operator` items' (A6 U4 review 2),
 * several on an entry the harness stored for messages it took as one (review 3).
 */
const writtenIds = (items: readonly LiveItem[]): ReadonlySet<string> =>
  new Set(
    items.flatMap((item) =>
      item.kind === OPERATOR_TURN_KIND ? messagesOf(item) : [],
    ),
  );

/**
 * A session with the server's replay installed (S6), and the messages it holds outside the
 * transcript drawn as rows at the end (A6 U4 review).
 *
 * `answered.floor` is the activity publish order this tab had seen when the read was asked
 * for: the replay/live boundary ({@link ConversationSession.historyFloor}). `held` is the ids of
 * the rows this session held when the read was asked for — by default every row it holds
 * now, which is the first read's case (it is asked only for a session with none).
 *
 * **Joined by message id, never by time** (A6 U4 review 2). The server reads what it holds
 * outside the transcript (`queued`) before the transcript, so every message it accepted
 * before the read began is in exactly one of the two: the transcript (a `turn.operator`
 * naming it in `messageIds`) or `queued`. So:
 *
 * - a row this tab holds whose message the **transcript** has is dropped: the transcript's
 *   copy is drawn, where the harness put it;
 * - a row whose message is in `queued` is kept — its send floor and its queued state are
 *   this tab's own, and better than any the answer could give — unless the server says the
 *   harness took it and this tab never saw the take: then the answer's row, which says so;
 * - a row with no message id this tab held when it asked is dropped: it opened or reopened
 *   the session, which the harness wrote before any steer could be taken, and the take that
 *   asked for this read is of such a steer;
 * - a row minted **after** the read was asked for, and not in the answer by id, is kept.
 *
 * A row names its messages as a list (A6 U4 review 3): it goes if the transcript has **any**
 * of them — a message the harness took with others is in their one entry — and the held
 * messages taken together are added as one row ({@link queuedRows}).
 *
 * A clock comparison could not do this: the server stamps the answer after reading the
 * transcript, so a message accepted during the read was either dropped (it was older than
 * the stamp and in neither half) or drawn twice.
 */
export const withReplay = <S extends ConversationSession>(
  session: S,
  answered: { readonly view: ConversationReplayView; readonly floor: number },
  held: ReadonlySet<string> = new Set(session.items.map((item) => item.id)),
): S => {
  const { view, floor } = answered;
  const written = writtenIds(view.items);
  const waiting = new Map(
    view.queued
      .filter((message) => !written.has(message.messageId))
      .map((message) => [message.messageId, message] as const),
  );
  /** Whether this tab's own row for a held message is better than the answer's. */
  const ownWins = (messageId: string): boolean => {
    const message = waiting.get(messageId);
    return (
      message !== undefined &&
      (!message.taken || session.taken?.[messageId] !== undefined)
    );
  };
  const kept = session.items.filter((item) => {
    const ids = messagesOf(item);
    if (ids.length === 0) return !held.has(item.id);
    return (
      !ids.some((id) => written.has(id)) &&
      (ids.every(ownWins) ||
        (!held.has(item.id) && !ids.some((id) => waiting.has(id))))
    );
  });
  const keptMessages = new Set(kept.flatMap(messagesOf));
  const added = [...waiting.values()].filter(
    (message) => !keptMessages.has(message.messageId),
  );
  const rows = queuedRows(added, floor);
  const keptIds = new Set(kept.map((item) => item.id));
  const floors: Record<string, number> = {};
  for (const [id, at] of Object.entries(session.floors ?? {})) {
    if (keptIds.has(id)) floors[id] = at;
  }
  for (const row of rows) floors[row.id] = floor;
  // Only a message still waiting is queued: one the harness took is an ordinary turn.
  const midTurn = [
    ...rows
      .filter((row) =>
        messagesOf(row).every((id) => waiting.get(id)?.taken === false),
      )
      .map((row) => row.id),
    ...(session.midTurn ?? []).filter((id) => keptIds.has(id)),
  ];
  return {
    ...session,
    history: historyOf(view),
    historyFloor: floor,
    loaded: true,
    // In the order the server accepted them (`at` is its `acceptedAt` on both kinds).
    items: [...rows, ...kept].sort((left, right) => left.at - right.at),
    floors,
    midTurn,
  };
};

/**
 * Whether a `turn.taken` item names a message this session has no row for — one sent from
 * another tab — so the replay must be read again to draw it (A6 U4 review). Only a take the
 * session's replay cannot already hold (published after its floor), only for a session
 * whose replay has been read, and not when the replay's transcript already holds the
 * message by id (A6 U4 review 2).
 */
export const takesUnknownMessage = (
  session: ConversationSession,
  take: LiveItem,
): boolean =>
  take.kind === TAKEN_KIND &&
  session.loaded === true &&
  (session.historyFloor === undefined ||
    (activityOrder(take) ?? Number.POSITIVE_INFINITY) > session.historyFloor) &&
  messagesOf(take).some(
    (id) =>
      !session.items.some((item) => messagesOf(item).includes(id)) &&
      !session.history.items.some((item) => messagesOf(item).includes(id)),
  );

/** What a message waiting behind the running turn says, under its bubble. */
export const queuedNote = (agent: string): string =>
  `Queued: the ${agent} reads this once it reaches a break in the work it is doing.`;

/**
 * When a "Send now" message is read, by the harness the session runs on (A6 U6 review).
 *
 * Both harnesses take a `preemptive` steer ahead of every message queued before it, and
 * differ on what it cuts (measured, U6): **Claude Code** (`priority: "now"`) reads it at its
 * next step, cutting the reply in flight mid-sentence (~0.3 s on haiku); **OpenCode 2.2.5**
 * (`delivery: "steer"`) reads it only once the message it is writing ends — a long reply has
 * no step inside it, and GLM finished a 77 s one in full first. `unknown` is a harness this
 * page cannot name, which is told only what both do.
 *
 * Chosen from the harness's `driver`, which `HarnessInstanceView` says is shown and never
 * routed by: this is wording, and the server delivers the same urgency to either.
 *
 * V2(chat): Send now on OpenCode should cut in as it does on Claude Code. V2 interrupts and
 * then sends, but only when no tool call is in flight: an OpenCode abort kills a running
 * tool, and holds the messages queued behind the turn (`queuedOnInterrupt: "held"`), so V2
 * must also re-sequence a queued message ahead of or behind the one sent now, and close the
 * race between the abort settling and the send landing (an abort that lands after the send
 * would stop the very turn the message opened).
 */
export type SendNowTiming = "next_step" | "message_end" | "unknown";

/** {@link SendNowTiming} for a harness driver (`HarnessInstanceView.driver`). */
export const sendNowTiming = (driver: string | undefined): SendNowTiming =>
  driver === "claude-code"
    ? "next_step"
    : driver === "opencode"
      ? "message_end"
      : "unknown";

/**
 * What a message sent with "Send now" says while the harness has yet to take it (A6 U6),
 * by when the harness reads one ({@link SendNowTiming}).
 */
export const sendingNowNote = (timing: SendNowTiming, agent: string): string =>
  timing === "next_step"
    ? `Sending now: the ${agent} reads this at its next step, ahead of any queued message. A tool call already running finishes first; the rest of what it was doing is dropped.`
    : timing === "message_end"
      ? `Sending now: on OpenCode the ${agent} reads this once the message it is writing ends, ahead of any queued message. The message in flight is finished, not cut short.`
      : `Sending now: the ${agent} reads this ahead of any queued message, as soon as its harness lets it in.`;

/** What a "Send now" message the harness took says of it, beside its bubble. */
export const sentNowTitle = (timing: SendNowTiming, agent: string): string =>
  timing === "next_step"
    ? `Sent now: the ${agent} took this at its next step and dropped the rest of what it was doing.`
    : timing === "message_end"
      ? `Sent now: the ${agent} took this once the message it was writing ended, ahead of any queued message.`
      : `Sent now: the ${agent} took this ahead of any queued message.`;

/** What the Send now button says it does, on the session's harness. */
export const sendNowButtonTitle = (
  timing: SendNowTiming,
  agent: string,
): string =>
  timing === "next_step"
    ? `Send now: the ${agent} reads this at its next step, ahead of any queued message. A tool call already running finishes first; the rest of what it was doing is dropped.`
    : timing === "message_end"
      ? `Send now: on OpenCode the ${agent} reads this once the message it is writing ends, ahead of any queued message. The message in flight is finished, not cut short.`
      : `Send now: the ${agent} reads this ahead of any queued message, as soon as its harness lets it in.`;

/**
 * One session's rows: its own, with the importer's narration from the target's live feed
 * placed among them (the importer conversation design, S4).
 *
 * **Filed by the owner's route and nothing else** (`routeOf`): for the importer `importId`,
 * the one id the server sets on an importer's narration and on nothing else's
 * (`LiveItem.importId`), so a goal agent's or a worker's words on the same target cannot land
 * here, and a session with no period yet — the empty one the operator is typing into — takes
 * nothing.
 *
 * **Placed by publish order, not by time.** An entry goes after the latest operator row that
 * was sent before it was published: the row's floor ({@link ConversationSession.floors}) against
 * the entry's own `activity:<n>`. That is `buildGoalConversation`'s join, and for its reason:
 * the browser's clock and the server's are different clocks, and the importer can start
 * answering before the browser has been told the message was accepted — so arrival order
 * against the row, which is minted on acceptance, would put the start of a reply above the
 * message it answers.
 */
/** A tool call or its result: what a replay names by `callId` rather than by `blockId`. */
const isToolItem = (item: LiveItem): boolean =>
  item.kind === "tool.call" || item.kind === "tool.result";

export const conversationFeed = (input: {
  readonly own: readonly LiveItem[];
  readonly floors: Readonly<Record<string, number>> | undefined;
  readonly live: readonly LiveItem[];
  /**
   * The period the session is addressed by ({@link ConversationSession.conversationId}), or
   * `undefined` for a session with none yet, which takes nothing from the live feed.
   */
  readonly conversationId: string | undefined;
  /**
   * Which period a live item belongs to, by the owner's subject id: the importer's
   * `importId`, a worker attempt's `attemptId`. Only items whose route is
   * {@link conversationId} are this session's.
   */
  readonly routeOf: (item: LiveItem) => string | null;
  /**
   * The replay's floor, if a replay has been asked for. See
   * {@link ConversationSession.historyFloor}.
   */
  readonly historyFloor?: number | undefined;
  /**
   * The replay's items ({@link ConversationHistory.items}), for the one thing the floor cannot
   * decide alone: whether a block still being written is in it (A6 U5 review).
   */
  readonly replayed?: readonly LiveItem[] | undefined;
  /** {@link ConversationSession.midTurn}: rows sent as steers while a turn ran. */
  readonly midTurn?: readonly string[] | undefined;
  /** Whether the session is working: a steer can only wait behind a turn that is. */
  readonly working?: boolean | undefined;
  /** {@link ConversationSession.taken}: the takes recorded, whether or not still in `live`. */
  readonly taken?: Readonly<Record<string, LiveItem>> | undefined;
  /**
   * Whether the replay may still lack a finished block because the model call it belongs to
   * had not ended when the replay was read: the session is working, or its replay was read
   * while it was ({@link ConversationSession.replayMidTurn}). Below the floor, a finished block
   * the replay lacks is kept only then. `false` when omitted.
   */
  readonly callInFlight?: boolean | undefined;
}): readonly LiveItem[] => {
  const { conversationId, routeOf } = input;
  if (conversationId === undefined) return input.own;
  /*
   * Everything this import published, minus what the replay already holds.
   *
   * **This is the replay/live boundary, and it is one comparison.** The server's answer
   * contains every word the harness held when it answered, so narration published at or
   * below the floor is on screen twice unless it is dropped here — and it is dropped here
   * rather than in `buildConversationChat` because that function is given one list and cuts it,
   * and a filter in there would need a floor for a list that no longer knows its order.
   *
   * A record (`scope.entry.added`, `asset.imported`) carries no activity order and is kept
   * whatever the floor: it is durable, the replay never contains one, and dropping it would
   * lose the half of the screen that survives a reload.
   *
   * **A block is kept whatever the floor while the replay does not hold it** (A6 U5 review,
   * and its second round for a finished one). A reply or a thought names its block
   * (`blockId`), and the replay names the blocks it holds the same way, so whether the
   * replay has it is a lookup, not a guess from the floor. Two blocks sit below the floor
   * and are not in the replay:
   *
   * - a **partial**: each keeps the id of its block's first one (`withBlock`), so a block that
   *   began before the replay was asked for sits below the floor for as long as it is
   *   written — and no harness stores a block before it is finished;
   * - a **finished** block of a model call still running: **both harnesses** store a call's
   *   blocks only once the whole call ends — Claude Code writes them to its transcript then,
   *   and OpenCode 2.2.5's message list held only the operator's row for the whole of a 20 s
   *   GLM message (measured, U5 review 3) — so a thought finished live 2 s in was in no
   *   replay until the reply after it ended, 10 s later (measured on Claude Code). Dropped by
   *   the floor, a reload or a return mid-reply lost the thought above it for good. Kept
   *   only while that call can still be running ({@link callInFlight}).
   *
   * V2(chat): after a **reload** mid-call the live feed starts afresh and holds no frame
   * from before it, so the call's earlier finished thought or reply is in neither the feed
   * nor the replay until the turn settles and the replay is read again
   * (`ImporterSessions.#readMidTurn`): the turn shows its later blocks only, for up to the
   * rest of the call. V2 keeps a per-import tail of the finished reply and thinking items
   * narrated during the running turn, beside the queued steers in `import/scopeImporter.ts`
   * — bounded to about the last 32 blocks / 256 KB, cleared at turn end, at a Stop's settle
   * and at session end — and `import/importerHistory.ts` appends, after the transcript read,
   * the tail's blocks whose `blockId` the transcript lacks. It is lost on a server restart,
   * which ends the turn too.
   *
   * Once the replay holds the block, its copy there is the block. **Only a block published
   * after everything the replay is known to hold is kept** (`heldUpTo`: its blocks, and its
   * tool calls and results by `callId`): the blocks a harness has not stored yet are its
   * newest. An older one the replay lacks is missing for another reason
   * — cut by the replay's window (`truncated`), or named differently by a transcript that
   * holds part of a call — and drawing it would put words from before the window under the
   * turn the replay ends on.
   */
  const inReplay = new Set<string>();
  const callsInReplay = new Set<string>();
  for (const item of input.replayed ?? []) {
    if (item.blockId !== undefined) inReplay.add(item.blockId);
    if (isToolItem(item) && item.callId !== null)
      callsInReplay.add(item.callId);
  }
  const isBlock = (item: LiveItem): boolean =>
    item.blockId !== undefined &&
    (item.kind === REPLY_KIND || item.kind === THINKING_KIND);
  const ours = input.live.filter((item) => routeOf(item) === conversationId);
  /*
   * The newest thing published live that the replay is known to hold: a block it names, or
   * a tool call or result whose call it names (A6 U5 review 3). Tool items count because a
   * write-heavy run is mostly them: two hundred calls with no prose between fill the
   * replay's newest four hundred items with tool rows alone, and a watermark read off blocks
   * only would stay at −∞ and let every older reply in the live window back under the floor.
   */
  let heldUpTo = Number.NEGATIVE_INFINITY;
  for (const item of ours) {
    const order = activityOrder(item);
    if (order === undefined) continue;
    const held = isBlock(item)
      ? inReplay.has(item.blockId ?? "")
      : isToolItem(item) &&
        item.callId !== null &&
        callsInReplay.has(item.callId);
    if (held) heldUpTo = Math.max(heldUpTo, order);
  }
  /**
   * Whether a block below the floor is one the replay cannot have yet.
   *
   * A partial always: no harness stores a block before it ends. A finished one only while
   * its turn can still be running — the session is working, or the replay on screen was read
   * while it was ({@link ConversationSession.replayMidTurn}) and its settled re-read has not
   * landed: both harnesses store a model call's blocks once the whole call ends, so a replay
   * read with the session idle holds every finished block, and one it lacks is missing for
   * another reason.
   */
  const notYetStored = (item: LiveItem): boolean =>
    isBlock(item) &&
    !inReplay.has(item.blockId ?? "") &&
    (isPartial(item) ||
      (input.callInFlight === true &&
        (activityOrder(item) ?? Number.POSITIVE_INFINITY) > heldUpTo));
  /*
   * A carry (A6 U6 review 2) below the floor that the replay cannot show yet: Claude Code
   * writes the message that carried it on to its transcript 30–130 ms after taking it, and a
   * take asks for a re-read, so a replay read in that gap ends on the carried message alone
   * — no `turn.carried` of its own — while the live one is under its floor. Kept while the
   * call can still be running, as a finished block is, when the replay holds the message
   * it names and no carry naming it: `buildConversationChat` finds that message's turn by id.
   * The settled re-read holds both messages and its own carry.
   *
   * V2(chat): a **reload** inside that 30–130 ms gap starts a feed that holds no carry, so
   * the carried message reads "The harness holds this message and no reply to it." until
   * the turn settles and the replay is read again. The per-import tail the V2 note above
   * describes would keep the carry beside the blocks, and close this too.
   */
  const carriedInReplay = new Set<string>();
  const writtenInReplay = new Set<string>();
  for (const item of input.replayed ?? []) {
    if (item.kind === CARRIED_KIND) {
      for (const id of messagesOf(item)) carriedInReplay.add(id);
    } else if (item.kind === OPERATOR_TURN_KIND) {
      for (const id of messagesOf(item)) writtenInReplay.add(id);
    }
  }
  const carryNotYetStored = (item: LiveItem): boolean =>
    item.kind === CARRIED_KIND &&
    input.callInFlight === true &&
    messagesOf(item).some((id) => writtenInReplay.has(id)) &&
    !messagesOf(item).some((id) => carriedInReplay.has(id));
  const mine = ours.filter((item) => {
    // A block the replay holds is the replay's, above the floor too (A6 U5 review 3): the
    // turn watch can answer, and the settled re-read land, before the block's last live
    // frame reaches this tab, and that frame is then published after the floor.
    if (isBlock(item) && inReplay.has(item.blockId ?? "")) return false;
    return (
      input.historyFloor === undefined ||
      (activityOrder(item) ?? Number.POSITIVE_INFINITY) > input.historyFloor ||
      notYetStored(item) ||
      carryNotYetStored(item)
    );
  });
  /*
   * Where an operator row goes among the importer's words: after everything published
   * before its floor.
   *
   * **A steer sent mid-turn is placed where the harness took it** (A6 U4). Until then the
   * importer is still on the turn before it, and everything it publishes is that turn's: so
   * a row still queued sorts after all of it (an infinite floor), and once a `turn.taken`
   * item names its message, the take's own publish order is its floor — what follows the
   * take is the steer's work. A row the harness never said it took is placed by its send
   * floor once the session is idle, as every row was before: the take may have been dropped
   * from the lossy activity channel, and an idle session has nothing left to keep apart.
   */
  const taken = takenByMessage(mine, input.taken);
  if (mine.length === 0) return input.own;
  const floorOf = (row: LiveItem): number => {
    const sent = input.floors?.[row.id] ?? -1;
    const take = takeOf(row, taken);
    if (take !== undefined) return activityOrder(take) ?? sent;
    if (input.working === true && input.midTurn?.includes(row.id) === true) {
      return Number.POSITIVE_INFINITY;
    }
    return sent;
  };

  // The page's own rows in runs, each opened by an operator row and carrying its floor.
  const runs: { floor: number; items: LiveItem[] }[] = [];
  for (const item of input.own) {
    if (item.kind === OPERATOR_TURN_KIND || runs.length === 0) {
      runs.push({
        floor: item.kind === OPERATOR_TURN_KIND ? floorOf(item) : -1,
        items: [],
      });
    }
    runs.at(-1)?.items.push(item);
  }
  /*
   * **In the order the harness took them, not the order they were sent** (A6 U6 review).
   * A "Send now" sent after a queued message is taken before it (both harnesses jump a
   * preemptive steer ahead of queued ones), so its take floor is the lower one; walked in
   * send order, the merge below would stop at the queued row's higher floor and put the
   * Send-now reply under the turn before. A stable sort keeps rows with equal floors — two
   * still queued (both infinite), or taken together — in the order they were sent.
   */
  runs.sort((a, b) => (a.floor < b.floor ? -1 : a.floor > b.floor ? 1 : 0));

  const merged: LiveItem[] = [];
  let next = 0;
  for (const item of mine) {
    const order = activityOrder(item);
    if (order !== undefined) {
      while (next < runs.length && (runs[next]?.floor ?? -1) < order) {
        merged.push(...(runs[next]?.items ?? []));
        next += 1;
      }
    }
    merged.push(item);
  }
  for (; next < runs.length; next += 1)
    merged.push(...(runs[next]?.items ?? []));
  return merged;
};

/** What a session is built from. */
export interface ConversationChatInput {
  readonly history: ConversationHistory;
  /** The live feed for this session, in arrival order. */
  readonly items: readonly LiveItem[];
  /**
   * Whether the importer is still working on the **latest** operator message.
   *
   * It is what separates a write that is `pending` from one that is `unresolved`: with
   * nothing more to arrive, a call that never produced a record is the state the chat is
   * never allowed to be quiet about.
   */
  readonly working: boolean;
  /**
   * How many of the target's committed events the record feed did not send
   * (`LiveOpened.skipped`). Non-zero means the records on screen start part way back, so
   * the oldest replayed write calls may have no record here: see {@link placedByCall}.
   * `0` when omitted.
   */
  readonly recordsSkipped?: number;
  /** {@link ConversationSession.midTurn}. Empty when omitted. */
  readonly midTurn?: readonly string[];
  /** {@link ConversationSession.sentNow}. Empty when omitted. */
  readonly sentNow?: readonly string[];
  /** When the session's harness reads a "Send now" message. `unknown` when omitted. */
  readonly sendNow?: SendNowTiming;
  /** {@link ConversationSession.taken}. Only `items`' own takes when omitted. */
  readonly taken?: Readonly<Record<string, LiveItem>>;
  /** The agent, by role, as the turns' notes name it: `importer`. */
  readonly agent: string;
}

/**
 * Each tool result moved to sit right after the call it answers, when that call is earlier
 * in the list (A6 U4).
 *
 * A result can land after an operator row that came between it and its call — a call still
 * running when a steer was taken, a reply that took a while — and cut at that row, it would
 * be a row of its own under the wrong message while its call's row waited for it. Beside
 * its call it is folded into that row, in the call's turn, as it would have been had it
 * arrived first. A result whose call is not here stays where it is.
 */
const besideCalls = (items: readonly LiveItem[]): readonly LiveItem[] => {
  const calls = new Set<string>();
  const late = new Map<string, LiveItem[]>();
  const moved = new Set<string>();
  for (const item of items) {
    if (item.callId === null) continue;
    if (item.kind === "tool.call") calls.add(item.callId);
    else if (item.kind === "tool.result" && calls.has(item.callId)) {
      const list = late.get(item.callId);
      if (list === undefined) late.set(item.callId, [item]);
      else list.push(item);
      moved.add(item.id);
    }
  }
  if (moved.size === 0) return items;
  const placed: LiveItem[] = [];
  for (const item of items) {
    if (moved.has(item.id)) continue;
    placed.push(item);
    if (item.kind === "tool.call" && item.callId !== null) {
      placed.push(...(late.get(item.callId) ?? []));
      late.delete(item.callId);
    }
  }
  return placed;
};

/** A conversation cut at each operator row. */
interface Cut {
  readonly leading: readonly LiveItem[];
  readonly turns: readonly {
    readonly operator: LiveItem;
    readonly items: readonly LiveItem[];
  }[];
}

const cutAtOperator = (items: readonly LiveItem[]): Cut => {
  const leading: LiveItem[] = [];
  const turns: { operator: LiveItem; items: LiveItem[] }[] = [];
  for (const item of items) {
    if (item.kind === OPERATOR_TURN_KIND) {
      turns.push({ operator: item, items: [] });
      continue;
    }
    (turns.at(-1)?.items ?? leading).push(item);
  }
  return { leading, turns };
};

/** Whether an item came from the server's replay rather than this tab's feed. */
const fromReplay = (item: LiveItem): boolean => item.id.startsWith("replay:");

/** A session's items in the order they are drawn, and which call each record pairs with. */
interface Placed {
  readonly items: readonly LiveItem[];
  /** {@link claimedRecords}' answer for the whole session, by call item id. */
  readonly pairing: ReadonlyMap<string, LiveItem>;
}

/**
 * The conversation with each record moved to sit right after the write call it pairs with,
 * and every record nothing claims, from before this tab's first message, moved to the front.
 *
 * A reload's records come from the record channel, in the store's order and with no operator
 * row before them, while the calls that wrote them come back in the replay under the turns
 * they were made in (A6 F10). Paired across the **whole** session ({@link claimedRecords})
 * and placed beside their calls, each record lands in its call's turn, and each turn is
 * drawn with this same pairing, so `rowsFor` folds the two into one `recorded` row as it
 * does live and never re-pairs a turn on its own.
 *
 * **By the write's id first, and by order only where nothing has been cut** (A6 F10
 * review). The replay keeps the newest items (`truncated`) and the record feed opens part
 * way back across the whole target (`recordsSkipped`), each cut on its own, so in a long
 * session the k-th call left on screen is not the k-th record's writer: pairing them by
 * position put `b.com`'s call on `a.com`'s receipt and left the last calls `unresolved`.
 * When either side is cut, order pairs only what follows this tab's first message — the
 * live stretch, which this tab saw whole — and before it a call pairs by id or not at all.
 *
 * A record no call claims is placed by nothing, so it goes to the front, where the cut puts
 * it in the leading "earlier in this session" group with the sentence that says why — not
 * under whichever replayed turn happens to be last, which would be a claim about which
 * message it answered. A record that arrived after one of this tab's own messages keeps its
 * place, as it always has: it is live, and placed by the narration around it.
 */
const placedByCall = (
  replay: readonly LiveItem[],
  feed: readonly LiveItem[],
  cut: boolean,
): Placed => {
  const all = [...replay, ...feed];
  const firstSent = feed.findIndex((item) => item.kind === OPERATOR_TURN_KIND);
  const orderFrom = !cut
    ? 0
    : firstSent < 0
      ? all.length
      : replay.length + firstSent;
  const claimed = claimedRecords(all, orderFrom);
  const moved = new Set([...claimed.values()].map((record) => record.id));
  // Only beside a replay: with none, there is no turn for such a record to be misfiled
  // under, and the feed's own order stands.
  const stray =
    replay.length === 0
      ? []
      : (firstSent < 0 ? feed : feed.slice(0, firstSent)).filter(
          (item) => item.origin === "record" && !moved.has(item.id),
        );
  const strayIds = new Set(stray.map((record) => record.id));
  const placed: LiveItem[] = [...stray];
  for (const item of all) {
    if (moved.has(item.id) || strayIds.has(item.id)) continue;
    placed.push(item);
    const record = claimed.get(item.id);
    if (record !== undefined) placed.push(record);
  }
  return { items: placed, pairing: claimed };
};

/**
 * What the leading group says when it has no replayed words of its own.
 *
 * Only reached for a group that exists because of records or because the harness answered
 * with an absence. `other` is whether the session has turns of its own: with turns, the
 * leading group is just records, and the sentence is about why they are up here.
 */
const leadingProse = (
  history: ConversationHistory,
  other: boolean,
): RoundProse => {
  // Said whether or not the session has turns of its own: see `buildConversationChat`.
  if (history.source === "pending") {
    return { _tag: "pending", note: history.note };
  }
  if (other) {
    return {
      _tag: "none",
      note: "Recorded earlier in this session. Nothing on the record says which message each one answered, so they are not placed under one.",
    };
  }
  switch (history.source) {
    case "loading":
      return { _tag: "loading" };
    case "forgotten":
      return { _tag: "forgotten", note: history.note };
    case "absent":
      // Nothing was ever said in this import, which is not an absence of words but an
      // absence of a conversation — so the server's own sentence, in the slot that says
      // "there is nothing here" rather than the one that says "the words are gone".
      return { _tag: "none", note: history.note };
    case "none":
    case "harness":
      return {
        _tag: "none",
        note: "Recorded in this session. The words that went with them are not held anywhere this page can read.",
      };
  }
};

/**
 * Cuts one importer session into groups, one per operator message.
 *
 * **One list, one cut, replay and live alike** (A6 F10). The replay's items — its own
 * `turn.operator` rows among the importer's — come first, then the live feed, and the whole
 * is cut at each operator row. A replayed turn and a live one are therefore the same kind of
 * group made of the same kind of row, drawn by `ChatItem`; what differs is only the group's
 * prose state, `replayed` (with the server's note) or `live`. Live narration published
 * after the replay was read for a turn the replay caught mid-way joins that turn.
 *
 * Oldest first, with the leading "earlier in this session" group (if there is one) before
 * all of them. No groups at all is the empty session, which {@link Chat} says in its own
 * words.
 */
/** Not a block still being written: what a turn the importer is not on draws. */
const settled = (item: LiveItem): boolean => !isPartial(item);

/** A `turn.carried` item: its turn's message went on with the next (A6 U6 review 2). */
const isCarried = (item: LiveItem): boolean => item.kind === CARRIED_KIND;

/**
 * The harness's interrupt marker (A6 U6 review 3): Claude Code's `[Request interrupted by
 * user]`, a `turn.other` item headed `interrupted` — narrated live where a Stop landed, and
 * drawn from the stored entry on replay. A row in a turn that wrote something, showing where
 * the Stop landed; alone in a turn, said as {@link STOPPED_NOTE} instead.
 *
 * V2(chat): told by its headline, the server's `MessageEntry.marker`, because the contract
 * has no kind for a harness's own marker. OpenCode's Stop is a `turn.other` **error**
 * ("Step interrupted") and is not read as stopped here, so an OpenCode turn a Stop ended
 * before it wrote anything still shows that error row. A `turn.stopped` kind both harnesses
 * narrate would make this one rule.
 */
export const isInterruptMarker = (item: LiveItem): boolean =>
  item.kind === "turn.other" && item.headline === "interrupted";

export const buildConversationChat = (
  input: ConversationChatInput,
): readonly ConversationGroup[] => {
  const { history } = input;
  // A take is never drawn: it only says which operator row is no longer queued (A6 U4).
  const taken = takenByMessage(input.items, input.taken);
  const placed = placedByCall(
    history.items,
    input.items.filter((item) => item.kind !== TAKEN_KIND),
    history.truncated || (input.recordsSkipped ?? 0) > 0,
  );
  // Folded before the cut: a background sub-agent can end turns after it started, and is
  // still one entry, where it started (A6 U14). A late result joins its call likewise, and
  // messages the harness took as one are one turn (A6 U4 review 3).
  const cut = cutAtOperator(
    besideCalls(foldSubagents(joinedByTake(placed.items, taken))),
  );
  const turnCount = cut.turns.length;
  const carriedIds = new Set(
    [...history.items, ...input.items].filter(isCarried).flatMap(messagesOf),
  );
  const midTurn = new Set(input.midTurn ?? []);
  const urgent = new Set(input.sentNow ?? []);
  const sentNow = (operator: LiveItem): boolean =>
    messagesOf(operator).some((id) => urgent.has(id));
  /** Whether a turn's message still waits behind the turn running before it. */
  const waiting = (operator: LiveItem): boolean =>
    input.working &&
    midTurn.has(operator.id) &&
    messagesOf(operator).length > 0 &&
    takeOf(operator, taken) === undefined;
  // The turn the importer is on: the newest whose message is not still waiting.
  const active = cut.turns.findLastIndex((turn) => !waiting(turn.operator));

  const groups: ConversationGroup[] = [];
  /*
   * The harness's note on its copy ("From Claude Code, which may delete it…") is said once
   * a thread, on the first replayed group, and not under every replayed turn (A6 U4 review
   * 2): it is about the copy, and the copy is one. Later groups keep the `replayed` state
   * with no sentence.
   */
  let noted = false;
  const replayNote = (): string => {
    if (noted) return "";
    noted = true;
    return history.note;
  };

  /*
   * The leading group exists for four reasons and no others: replayed words before the
   * first operator message, records with no operator row before them, a session whose history
   * the harness answered with an absence while nothing else is on screen (the group is the
   * only place the absence can be said), and a history this page cannot read at all, which
   * stays said above every message typed into it.
   */
  const absent =
    turnCount === 0 &&
    cut.leading.length === 0 &&
    (history.source === "loading" ||
      history.source === "pending" ||
      history.source === "absent" ||
      history.source === "forgotten");
  if (cut.leading.length > 0 || absent) {
    const prose: RoundProse = cut.leading.some(fromReplay)
      ? {
          _tag: "replayed",
          note: replayNote(),
          ephemeral: true,
          truncated: history.truncated,
        }
      : leadingProse(history, turnCount > 0);
    groups.push({
      key: "earlier",
      subject: {
        message: null,
        number: null,
        at: null,
        working: false,
        queued: false,
        sentNow: false,
        startedAt: null,
        midBlock: false,
      },
      prose,
      // A block left partial before the turn the importer is on is never finished now.
      rows: rowsFor(
        cut.leading.filter((item) => settled(item) && !isCarried(item)),
        false,
        placed.pairing,
      ),
    });
  }

  cut.turns.forEach((turn, position) => {
    const number = position + 1;
    const queued = waiting(turn.operator);
    // "Latest" is the turn the importer is on, which a queued message after it is not.
    const latest = position === active;
    const working = latest && input.working;
    /*
     * A partial is drawn only in the turn the importer is working on (A6 U5). Once the turn
     * is over — the session idle, or a later message's turn begun — a block that never got
     * its finished copy was left: the first attempt of a retried model call, which the
     * server's turn-end flush leaves partial, or one cut off with nothing to close it.
     */
    /*
     * The harness ended this turn before it wrote anything and sent its message on with the
     * next (A6 U6 review 2): said in the turn's note, never drawn as a row. Found by the
     * message it names, wherever it sorted — a live carry kept under a replay's floor sorts
     * after the replay, and so after a message the server holds outside it — and by place
     * only when it names none (a session's opening prompt).
     */
    const carried =
      messagesOf(turn.operator).some((id) => carriedIds.has(id)) ||
      turn.items.some(
        (item) => isCarried(item) && messagesOf(item).length === 0,
      );
    const kept = (working ? turn.items : turn.items.filter(settled)).filter(
      (item) => !isCarried(item),
    );
    /*
     * A turn a Stop ended before it wrote anything holds the harness's interrupt marker and
     * nothing the importer said (A6 U6 review 3): said in the turn's note, not as a row. A
     * turn that wrote something keeps the marker as its row, where the Stop landed.
     */
    const spoke = kept.some(
      (item) => item.origin === "activity" && !isInterruptMarker(item),
    );
    const stopped = !spoke && kept.some(isInterruptMarker);
    const items = stopped
      ? kept.filter((item) => !isInterruptMarker(item))
      : kept;
    const replayed = fromReplay(turn.operator);
    const midBlock = replayed && !spoke && working;
    const take = takeOf(turn.operator, taken);
    groups.push({
      key: `turn:${String(number)}`,
      subject: {
        message: turn.operator.body,
        ...(turn.operator.attachments === undefined
          ? {}
          : { attachments: turn.operator.attachments }),
        number,
        at: turn.operator.at,
        working,
        queued,
        sentNow: sentNow(turn.operator),
        startedAt: take?.at ?? turn.operator.at,
        midBlock,
      },
      prose: queued
        ? {
            _tag: "pending",
            note: sentNow(turn.operator)
              ? sendingNowNote(input.sendNow ?? "unknown", input.agent)
              : queuedNote(input.agent),
          }
        : carried && !spoke
          ? { _tag: "none", note: CARRIED_NOTE }
          : stopped
            ? { _tag: "none", note: stoppedNote(input.agent) }
            : midBlock
              ? { _tag: "pending", note: MID_BLOCK_NOTE }
              : replayed
                ? spoke
                  ? {
                      _tag: "replayed",
                      note: replayNote(),
                      ephemeral: true,
                      // Said once, on the first turn: the answer stopped short of the oldest items.
                      truncated:
                        history.truncated &&
                        position === 0 &&
                        cut.leading.length === 0,
                    }
                  : {
                      _tag: "none",
                      note: "The harness holds this message and no reply to it.",
                    }
                : spoke
                  ? { _tag: "live" }
                  : latest
                    ? {
                        _tag: "pending",
                        note: "Sent. The importer has not answered yet.",
                      }
                    : {
                        _tag: "none",
                        note: "The importer wrote nothing in reply to this message.",
                      },
      rows: rowsFor(items, working, placed.pairing),
    });
  });

  return groups;
};

/**
 * When a session started, as the picker words it: the time today, the date and time before.
 *
 * `now` is a parameter so the same instant is "Today" on one render and a date on the next
 * without reading a clock inside a function that is meant to be pure.
 */
export const sessionWhen = (at: number, now: number): string => {
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = new Date(at);
  const today = new Date(now);
  const same =
    day.getFullYear() === today.getFullYear() &&
    day.getMonth() === today.getMonth() &&
    day.getDate() === today.getDate();
  if (same) return `Today ${time}`;
  const date = day.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date}, ${time}`;
};

/**
 * Why a message over the importer's limit is not sent (U8 review 5), with both figures: the
 * composer refuses it before any request, and the client refuses one that reaches it, so
 * the operator is never told "whether it was sent is not known" of a message that never
 * left the browser. A pasted statement of work is this page's main use, so the count is
 * what tells the operator how much to cut.
 */
export const messageTooLong = (length: number): string =>
  `This message is ${length.toLocaleString("en-US")} characters; the limit is ${CONVERSATION_MESSAGE_MAX_CHARS.toLocaleString("en-US")}. Nothing was sent: shorten it, or send it in parts.`;

/**
 * When a session started, as a sentence says it (U8 review 5): "today at 12:25", or "on
 * 5 Nov at 12:25" before today. {@link sessionWhen}'s instant in running words, for a
 * notice that names a session: a notice outlives the moment it was written, so it names a
 * session by what does not change — not by a label the harness may replace with a title
 * seconds later.
 */
export const sessionStarted = (at: number, now: number): string => {
  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = new Date(at);
  const today = new Date(now);
  const same =
    day.getFullYear() === today.getFullYear() &&
    day.getMonth() === today.getMonth() &&
    day.getDate() === today.getDate();
  if (same) return `today at ${time}`;
  const date = day.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `on ${date} at ${time}`;
};

/**
 * A session's name (S9, D5): the harness's title, or — where the harness has none to give —
 * "Session 18:02" from bit's own clock, and "New session" before a word is said — or, for
 * the page's own session whose first message's words are parked on it (`conversationParked.ts`),
 * "Not sent" or "Not confirmed" ({@link parkedMark}). A session with words of its own keeps
 * its name, and its row is marked beside it.
 *
 * The date is never replaced, only moved: under a title it is the picker row's subtitle and
 * the tooltip's second half ({@link sessionHover}), so a session the harness has forgotten,
 * or two the harness named alike, are still told apart.
 */
export const sessionLabel = <Tally extends ConversationTally>(
  session: Pick<ConversationSession<Tally>, "startedAt" | "tally" | "title">,
  parked?: Pick<ParkedMessage, "outcome">,
): string => {
  if (session.tally.messages === 0) {
    return parked === undefined ? "New session" : parkedMark(parked);
  }
  const title = session.title?.trim() ?? "";
  if (title !== "") return title;
  return `Session ${new Date(session.startedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
};

/** U+2068 FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE. */
const FSI = "\u2068";
const PDI = "\u2069";

/**
 * Untrusted text for a plain string bit's own words sit beside — a `title` attribute, a
 * notice — isolated from them (U8 review): between FSI and PDI, every bidi control in it
 * written out as its code point, prose's rule ({@link proseRuns}). A plain string has no
 * element to isolate on, so a right-to-left override in it would reverse bit's words after
 * it, and a PDI of its own would close the isolate early and let an override reach them.
 */
export const isolated = (text: string): string =>
  `${FSI}${proseRuns(text)
    .map((run) => run.text)
    .join("")}${PDI}`;

/**
 * The tooltip over a session's row and crumb: the whole name — the row cuts a long one at its
 * width — and when it started, which a title alone would hide; and, on a session holding
 * parked words, the start of them, which tells two such rows apart.
 *
 * **The title and the words are the harness's and the operator's, so each is isolated from
 * bit's words** ({@link isolated}): a right-to-left override in a title would otherwise
 * reverse "started 5 Nov, 18:02" after it, and right-to-left letters ending a title would
 * pull the separator and the digits into their run.
 */
export const sessionHover = <Tally extends ConversationTally>(
  session: Pick<ConversationSession<Tally>, "startedAt" | "tally" | "title">,
  now: number,
  parked?: Pick<ParkedMessage, "outcome" | "text">,
): string => {
  const when = sessionWhen(session.startedAt, now);
  const title = session.title?.trim() ?? "";
  const name =
    session.tally.messages === 0 || title === ""
      ? sessionLabel(session, parked)
      : isolated(title);
  const words =
    parked === undefined
      ? ""
      : ` · ${session.tally.messages === 0 ? "words" : parkedMark(parked)}: ${isolated(parkedStart(parked.text))}`;
  return `${name} · started ${when}${words}`;
};

/**
 * What the page holds for a session it has asked the server about and not heard back on.
 *
 * `loading` and not `pending`: `pending` is the server's answer about a session that exists
 * and has not spoken, and this is the page having no answer at all. The distinction is the
 * one this type's comment on `loading` makes — one is a fact about the session, the other is
 * a fact about this tab — and it matters because the empty thread, a session that said
 * nothing, and a session whose words are still in flight read as three different things.
 *
 * It carries **no note**, deliberately. Every other sentence on this screen is the server's
 * ({@link ConversationHistory.note}), and "still loading" is drawn rather than written.
 */
export const LOADING_HISTORY: ConversationHistory = {
  source: "loading",
  note: "",
  truncated: false,
  items: [],
};

/** A model and its options as one phrase: `claude-sonnet-4-5 (effort: high)`. */
const modelPhrase = (
  model: string,
  options: readonly ModelOptionSelection[],
): string =>
  options.length === 0
    ? model
    : `${model} (${options.map((each) => `${each.id}: ${each.value}`).join(", ")})`;

/**
 * What the composer says once a model switch was accepted (A6 F4, U3), honest about when
 * it applies.
 *
 * - **Live, mid-turn**: the harness takes it from its **next model call**. The step already
 *   running finishes on the old model — measured on both harnesses (F3/F4): a turn sent
 *   before the switch still answered on the old model — so the sentence says so rather than
 *   implying the reply being written has moved. Once that turn has ended the line is put
 *   in the past (`turnEnded`), since the step it named is no longer "on now".
 * - **Live, between turns**: the next message runs on it.
 * - **Recorded**: this server does not hold the session, so only its record changed; the
 *   next message reopens it on the new model.
 * - **Unchanged**: the session was already on exactly this; nothing moved.
 *
 * Options the new model does not offer were dropped by the server, never sent, and are
 * named by their ids — the ids the Reasoning column shows beside each setting.
 */
export const switchedNotice = (input: {
  readonly switched: ConversationModelSwitched;
  /** The model the session was on before, as this tab showed it. */
  readonly previous: string;
  /** Whether a turn was running when the switch was answered. */
  readonly working: boolean;
  /**
   * Whether that turn has since ended: the same confirmation in the past tense, since the
   * step it named as running no longer is.
   */
  readonly turnEnded?: boolean;
  /** The agent, by role, as a sentence names it: `importer`. */
  readonly agent?: string;
}): string => {
  const { switched, previous, working } = input;
  const now = modelPhrase(switched.model, switched.modelOptions);
  const dropped = switched.droppedModelOptionIds;
  const droppedLine =
    dropped.length === 0
      ? ""
      : ` ${switched.model} does not offer ${dropped.join(", ")}, so ${
          dropped.length === 1 ? "that setting was" : "those settings were"
        } not sent.`;
  if (!switched.changed) {
    return `This session was already on ${now}, so nothing changed.${droppedLine}`;
  }
  const head = `Now on ${now}.`;
  if (switched.applied === "recorded") {
    return `${head} This session is not running on this server, so the change is recorded and your next message reopens it on ${switched.model}.${droppedLine}`;
  }
  if (working) {
    const before =
      previous === switched.model ? "its earlier settings" : previous;
    if (input.turnEnded === true) {
      return `${head} The turn that was running finished its step on ${before} and used the new model for any model call after it. Your next message runs on it.${droppedLine}`;
    }
    return `${head} The ${input.agent ?? "agent"} takes it from its next model call: the step it is on now finishes on ${before}.${droppedLine}`;
  }
  return `${head} Your next message runs on it.${droppedLine}`;
};
