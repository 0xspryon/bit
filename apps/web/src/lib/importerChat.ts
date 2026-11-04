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
 * file declares {@link ImporterTurn} and `ImporterChat.svelte` renders its separator from
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
 *   records, all filed by import id ({@link importerFeed}). `rowsFor` folds each write call
 *   into its record, so a call and its receipt are one row (S5).
 *
 * Replayed turns come first, then live ones, and the floor between them is
 * {@link ImporterSession.historyFloor} — the activity publish order this tab had seen when
 * the replay was asked for, held against each live entry by {@link importerFeed}. That is the
 * same job `buildGoalConversation`'s `narrationFloor` does and it is what makes "no message
 * appears twice" structural rather than hopeful: everything the server's answer contains was
 * published at or below the floor, and everything after it is only live.
 *
 * The operator's own rows need no such cancellation, unlike the goal chat's, and the reason is
 * the arrangement rather than luck: the replay is asked for when a session is **opened** and
 * never again, so every `turn.operator` row this tab mints is minted after the answer it
 * could have collided with. The goal chat re-reads after a send and therefore needs
 * `replayedThrough` and a text match; this does not, and must not start re-reading without
 * building one.
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
 * is one (S6): `ImporterConversationView.note` carries a sentence for every one of the five
 * answers, and {@link ImporterHistory} passes it through untouched. What is still written
 * here is the handful that are **not** about the harness's copy — the leading group's "nothing
 * on the record says which message each one answered", {@link ENDED_NOTE} and
 * {@link strandedNote} — each of which is a fact about this screen or about a row the page
 * already holds, not an answer only the server could give.
 */
import type {
  ConversationModelSwitched,
  ImporterContinuationRefusal,
  ImporterConversationView,
  ImporterSessionView,
  LiveItem,
  ModelOptionSelection,
} from "@bit/contracts";

import {
  OPERATOR_TURN_KIND,
  activityOrder,
  claimedRecords,
  foldSubagents,
  rowsFor,
  type ChatGroup,
  type RoundProse,
} from "./chat";

/**
 * What an importer group's separator needs, and the whole of what the chat is given.
 *
 * `message` is `null` for the leading group, which has no operator message because it is
 * what came before the first one this tab can see.
 */
export interface ImporterTurn {
  /** The operator's words, or `null` on the "earlier in this session" group. */
  readonly message: string | null;
  /** Which operator message this is, from one. `null` on the leading group. */
  readonly number: number | null;
  /**
   * When the operator sent it, in epoch milliseconds, or `null` on the leading group.
   *
   * On a replayed turn it is the harness's own time for the message (A6 F10); on a live one,
   * this tab's clock when it was sent. Shown, never used for ordering.
   */
  readonly at: number | null;
  /** True while the importer is still working on this message. */
  readonly working: boolean;
}

/** One importer turn as a chat group. */
export type ImporterGroup = ChatGroup<ImporterTurn>;

/**
 * What the harness answered when asked for this session's messages.
 *
 * The server's five answers (`ImporterConversationSource`) plus one of the page's own:
 * `loading`, which is "this tab has asked and has no answer yet" and is therefore not a fact
 * about the session at all. `none` is the harness holding nothing under a session it still
 * knows; `absent` is nothing ever having been said in the import, which is a different fact
 * and gets a different sentence.
 */
export interface ImporterHistory {
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
  readonly standing?: ImporterStanding;
}

/** What the next message will do: the server's answer, with a refusal only on `refused`. */
export type ImporterStanding =
  | { readonly continuation: "live" | "resume" | "fresh" }
  | {
      readonly continuation: "refused";
      readonly refusal: ImporterContinuationRefusal;
    };

export const NO_HISTORY: ImporterHistory = {
  source: "none",
  note: "",
  truncated: false,
  items: [],
};

/**
 * The server's answer as the page holds it (S6).
 *
 * A straight reduction: the view carries two things this type does not keep — `live` and
 * `harnessSessionId` — because {@link ImporterHistory.continuation} already answers the only
 * question the screen asks of them, and a page holding both would start deriving its own
 * answer from them beside the server's.
 */
export const historyOf = (view: ImporterConversationView): ImporterHistory => ({
  source: view.source,
  note: view.note,
  truncated: view.truncated,
  items: view.items,
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
export interface ImporterSession {
  readonly id: string;
  readonly startedAt: number;
  /** `provider/model`, shown and not editable: changing harness starts a new session. */
  readonly model: string;
  /** The harness it ran on, by display name: the glyph on the composer's model chip. */
  readonly harness: string;
  readonly history: ImporterHistory;
  /**
   * What this page holds of the session itself, oldest first: the operator's own rows
   * (minted here, see `operatorTurn`), and in the state picker's declared sessions every
   * row. **Not** what the importer said on a real target — that is the target's live feed,
   * filed by {@link importId} and merged in by {@link importerFeed}, so an entry is held in
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
  readonly tally: ImporterTally;
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
   * {@link importerFeed} drops live narration at or below it, because the server's answer
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
}

/**
 * What the composer says under a message the server accepted: the server's own note, then
 * which pages the message made citable.
 *
 * **The pages are said, never left silent.** A page address the operator put on a line of
 * its own becomes one the importer's entries may name as their source, and that includes an
 * address that arrived on its own line inside something pasted. Naming each one is what lets
 * the operator notice a page they did not mean to vouch for; the panel lists them as rows
 * too. Pages refused for the cap are said as well, so a page that was not added is not
 * mistaken for one that was.
 */
export const acceptedNotice = (turn: {
  readonly note: string;
  readonly pagesAdded: readonly string[];
  readonly pagesNotAdded: readonly string[];
}): string =>
  [
    turn.note,
    turn.pagesAdded.length === 0
      ? ""
      : `Added as ${turn.pagesAdded.length === 1 ? "a page" : "pages"} this import may cite: ${turn.pagesAdded.join(", ")}.`,
    turn.pagesNotAdded.length === 0
      ? ""
      : `Not added, because this import already holds as many pages as one session reads: ${turn.pagesNotAdded.join(", ")}.`,
  ]
    .filter((part) => part !== "")
    .join(" ");

/** What the page says of a session the operator ended, and why it cannot be continued. */
export const ENDED_NOTE =
  "This session was ended, so its authority has ended with it: the importer's tools refuse every write under it, and it is not continued. Start a new session to carry on. What it wrote is on the Scope tab and in the Estate.";

/**
 * What the page says of a session whose harness this server no longer runs, and why it
 * cannot be continued rather than merely not yet.
 */
export const strandedNote = (instanceId: string): string =>
  `This session ran on "${instanceId}", which this server does not run. It may still exist there, and asking another harness about it would only be told there is no such session, so it cannot be continued from here. What it wrote is on the Scope tab and in the Estate.`;

/**
 * One session's rows: its own, with the importer's narration from the target's live feed
 * placed among them (the importer conversation design, S4).
 *
 * **Filed by `importId` and nothing else.** That is the one id the server sets on an
 * importer's narration and on nothing else's (`LiveItem.importId`), so a goal agent's or a
 * worker's words on the same target cannot land here, and a session with no import yet —
 * the empty one the operator is typing into — takes nothing.
 *
 * **Placed by publish order, not by time.** An entry goes after the latest operator row that
 * was sent before it was published: the row's floor ({@link ImporterSession.floors}) against
 * the entry's own `activity:<n>`. That is `buildGoalConversation`'s join, and for its reason:
 * the browser's clock and the server's are different clocks, and the importer can start
 * answering before the browser has been told the message was accepted — so arrival order
 * against the row, which is minted on acceptance, would put the start of a reply above the
 * message it answers.
 */
export const importerFeed = (input: {
  readonly own: readonly LiveItem[];
  readonly floors: Readonly<Record<string, number>> | undefined;
  readonly live: readonly LiveItem[];
  readonly importId: string | undefined;
  /**
   * The replay's floor, if a replay has been asked for. See
   * {@link ImporterSession.historyFloor}.
   */
  readonly historyFloor?: number | undefined;
}): readonly LiveItem[] => {
  const { importId } = input;
  if (importId === undefined) return input.own;
  /*
   * Everything this import published, minus what the replay already holds.
   *
   * **This is the replay/live boundary, and it is one comparison.** The server's answer
   * contains every word the harness held when it answered, so narration published at or
   * below the floor is on screen twice unless it is dropped here — and it is dropped here
   * rather than in `buildImporterChat` because that function is given one list and cuts it,
   * and a filter in there would need a floor for a list that no longer knows its order.
   *
   * A record (`scope.entry.added`, `asset.imported`) carries no activity order and is kept
   * whatever the floor: it is durable, the replay never contains one, and dropping it would
   * lose the half of the screen that survives a reload.
   */
  const mine = input.live.filter(
    (item) =>
      item.importId === importId &&
      (input.historyFloor === undefined ||
        (activityOrder(item) ?? Number.POSITIVE_INFINITY) > input.historyFloor),
  );
  if (mine.length === 0) return input.own;

  // The page's own rows in runs, each opened by an operator row and carrying its floor.
  const runs: { floor: number; items: LiveItem[] }[] = [];
  for (const item of input.own) {
    if (item.kind === OPERATOR_TURN_KIND || runs.length === 0) {
      runs.push({
        floor:
          item.kind === OPERATOR_TURN_KIND
            ? (input.floors?.[item.id] ?? -1)
            : -1,
        items: [],
      });
    }
    runs.at(-1)?.items.push(item);
  }

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
export interface ImporterChatInput {
  readonly history: ImporterHistory;
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
}

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
const leadingProse = (history: ImporterHistory, other: boolean): RoundProse => {
  // Said whether or not the session has turns of its own: see `buildImporterChat`.
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
export const buildImporterChat = (
  input: ImporterChatInput,
): readonly ImporterGroup[] => {
  const { history } = input;
  const placed = placedByCall(
    history.items,
    input.items,
    history.truncated || (input.recordsSkipped ?? 0) > 0,
  );
  // Folded before the cut: a background sub-agent can end turns after it started, and is
  // still one entry, where it started (A6 U14).
  const cut = cutAtOperator(foldSubagents(placed.items));
  const turnCount = cut.turns.length;

  const groups: ImporterGroup[] = [];

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
          note: history.note,
          ephemeral: true,
          truncated: history.truncated,
        }
      : leadingProse(history, turnCount > 0);
    groups.push({
      key: "earlier",
      subject: { message: null, number: null, at: null, working: false },
      prose,
      rows: rowsFor(cut.leading, false, placed.pairing),
    });
  }

  cut.turns.forEach((turn, position) => {
    const number = position + 1;
    const latest = position === cut.turns.length - 1;
    const working = latest && input.working;
    const replayed = fromReplay(turn.operator);
    const spoke = turn.items.some((item) => item.origin === "activity");
    groups.push({
      key: `turn:${String(number)}`,
      subject: {
        message: turn.operator.body,
        number,
        at: turn.operator.at,
        working,
      },
      prose: replayed
        ? spoke
          ? {
              _tag: "replayed",
              note: history.note,
              ephemeral: true,
              // Said once, on the first turn: the answer stopped short of the oldest items.
              truncated:
                history.truncated && position === 0 && cut.leading.length === 0,
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
      rows: rowsFor(turn.items, working, placed.pairing),
    });
  });

  return groups;
};

/**
 * What a session wrote, for the picker. Counts of its own, not derived from the feed.
 *
 * **`messages` is `0` or `null`, and cannot be a count.** `0` is the empty thread the operator
 * types into, which is what separates "a thread to type into" from "a session that exists".
 * `null` is every other session: what was said is the harness's and this server keeps none of
 * it, so a number of messages is something only a read of the harness could supply and no
 * session here can claim one. The type is narrow on purpose, so no fixture can put a count in
 * the picker that a real session could never show.
 */
export interface ImporterTally {
  readonly in: number;
  readonly out: number;
  readonly assets: number;
  readonly messages: 0 | null;
}

/**
 * The picker's second line: what the session actually wrote.
 *
 * "Nothing written" is its own sentence rather than three zeros, because "the session where
 * the agent only asked a question" is the one worth recognising at a glance. It says nothing
 * of messages: see {@link ImporterTally}.
 */
export const tallyLine = (tally: ImporterTally): string =>
  tally.in === 0 && tally.out === 0 && tally.assets === 0
    ? "nothing written"
    : `${String(tally.in)} in · ${String(tally.out)} out · ${String(tally.assets)} ${
        tally.assets === 1 ? "asset" : "assets"
      }`;

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

/** The crumb's short label for a session: "Session 18:02", or "New session" before a word. */
export const sessionLabel = (
  session: Pick<ImporterSession, "startedAt" | "tally">,
): string =>
  session.tally.messages === 0
    ? "New session"
    : `Session ${new Date(session.startedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`;

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
 * ({@link ImporterHistory.note}), and "still loading" is drawn rather than written.
 */
export const LOADING_HISTORY: ImporterHistory = {
  source: "loading",
  note: "",
  truncated: false,
  items: [],
};

/**
 * A session the server lists, as the page holds it.
 *
 * `harness` is a display name the caller resolves from the harness listing, because the
 * server's row carries the instance id and the model chip's glyph wants the name. `reading` is
 * true: an indexed session is opened to be read, and the first message the operator types
 * carries it on. `messages` is `null` — see {@link ImporterTally}. `strandedOn` is the
 * caller's to work out from the harness listing, and is set only for a harness this server
 * lacks.
 *
 * `history` is {@link LOADING_HISTORY}: the row says the session exists and says nothing
 * about what was said in it, so the words are a second request (S6) and this is the page
 * waiting for it.
 */
export const indexedSession = (
  view: ImporterSessionView,
  harness: string,
  strandedOn?: string,
): ImporterSession => ({
  id: view.sessionId,
  startedAt: view.openedAt,
  model: view.model,
  harness,
  history: LOADING_HISTORY,
  items: [],
  working: view.running,
  tally: {
    in: view.tally.entriesIn,
    out: view.tally.entriesOut,
    assets: view.tally.assets,
    messages: null,
  },
  reading: true,
  indexed: true,
  importId: view.importId,
  agentId: view.agentId,
  ...(view.harnessInstanceId === null
    ? {}
    : { harnessInstanceId: view.harnessInstanceId }),
  ...(view.endedReason === "operator" ? { ended: true } : {}),
  ...(strandedOn === undefined ? {} : { strandedOn }),
});

/**
 * The Assets screen's strip about the target's last importer session (A6 D1).
 *
 * Three sentences, all about what the session did and none about what it said: still
 * running, wrote nothing, or wrote this much. "Ended" is only said of a session this server
 * does not know to be running; a restart forgets that, so it can read "ended without writing
 * anything" of a session the restart cut off, and the tally is the part that can be trusted.
 */
export const lastSessionSentence = (
  view: Pick<ImporterSessionView, "running" | "tally">,
): string => {
  if (view.running) return "is still running.";
  const { entriesIn, entriesOut, assets } = view.tally;
  if (entriesIn === 0 && entriesOut === 0 && assets === 0) {
    return "ended without writing anything.";
  }
  return `wrote ${tallyLine({ in: entriesIn, out: entriesOut, assets, messages: null })}.`;
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
    return `${head} The importer takes it from its next model call: the step it is on now finishes on ${before}.${droppedLine}`;
  }
  return `${head} Your next message runs on it.${droppedLine}`;
};
