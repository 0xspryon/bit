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
 *   `turn.operator` row (see {@link operatorTurn}) and a turn opens at each of those. Tool
 *   calls, their results and the records they produced are all here.
 *
 * Replayed turns come first, then live ones; the caller owns the floor between them (the
 * same job `buildGoalConversation`'s `narrationFloor` does), so nothing is shown from both.
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
 * ## The notes in here are stand-ins
 *
 * The sentences on a group with no prose are the server's to write once there is a server
 * (`RoundNarration.note` for a round, `GoalConversationView.note` for a goal). There is no
 * importer endpoint, so they are written here, in the same register.
 */
import type {
  GoalNarrationView,
  ImporterSessionView,
  LiveItem,
} from "@bit/contracts";

import {
  OPERATOR_TURN_KIND,
  rowsFor,
  type ChatGroup,
  type RoundProse,
} from "./chat";

/** One message of the harness's copy, in the reduced shape the replay answers with. */
export type ReplayedMessage =
  GoalNarrationView["rounds"][number]["messages"][number];

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
   * When the operator sent it, in epoch milliseconds, or `null`.
   *
   * `null` on every replayed turn: the harness's reduced entries carry no time, and a
   * time borrowed from somewhere else would be an invention.
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
 * The same five answers a goal conversation has, minus the one that never reaches a group:
 * `none` is "nothing has ever been said here" and renders no group at all.
 */
export interface ImporterHistory {
  readonly source: "loading" | "none" | "harness" | "pending" | "forgotten";
  /** A sentence for the operator. Empty when `source` is `none` or `loading`. */
  readonly note: string;
  /** True when the harness holds more than it returned. */
  readonly truncated: boolean;
  /** Oldest first. Empty unless `source` is `harness`. */
  readonly messages: readonly ReplayedMessage[];
}

export const NO_HISTORY: ImporterHistory = {
  source: "none",
  note: "",
  truncated: false,
  messages: [],
};

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
  /** The harness it ran on, by display name: the avatar letter on its header is this one's. */
  readonly harness: string;
  readonly history: ImporterHistory;
  readonly items: readonly LiveItem[];
  readonly working: boolean;
  readonly tally: ImporterTally;
  /** Opened from the picker and not written to since: read-only until the operator types. */
  readonly reading: boolean;
  /** True when the server lists this session. Absent on the page's own. */
  readonly indexed?: boolean;
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
}

/**
 * What the page says of a session whose harness this server no longer runs, and why it
 * cannot be continued rather than merely not yet.
 */
export const strandedNote = (instanceId: string): string =>
  `This session ran on "${instanceId}", which this server does not run. It may still exist there, and asking another harness about it would only be told there is no such session, so it cannot be continued from here. What it wrote is on the Scope tab and in the Estate.`;

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
}

/** The live feed cut at each operator row. */
interface LiveCut {
  readonly leading: readonly LiveItem[];
  readonly turns: readonly {
    readonly operator: LiveItem;
    readonly items: readonly LiveItem[];
  }[];
}

const cutLive = (items: readonly LiveItem[]): LiveCut => {
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

/** The harness's copy cut at each `user` entry. */
const cutReplay = (
  messages: readonly ReplayedMessage[],
): {
  readonly leading: readonly ReplayedMessage[];
  readonly turns: readonly {
    readonly user: ReplayedMessage;
    readonly replies: readonly ReplayedMessage[];
  }[];
} => {
  const leading: ReplayedMessage[] = [];
  const turns: { user: ReplayedMessage; replies: ReplayedMessage[] }[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      turns.push({ user: message, replies: [] });
      continue;
    }
    (turns.at(-1)?.replies ?? leading).push(message);
  }
  return { leading, turns };
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
 * Oldest first, with the leading "earlier in this session" group (if there is one) before
 * all of them. No groups at all is the empty session, which {@link Chat} says in its own
 * words.
 */
export const buildImporterChat = (
  input: ImporterChatInput,
): readonly ImporterGroup[] => {
  const { history } = input;
  const live = cutLive(input.items);
  const replay = cutReplay(history.messages);
  const turnCount = replay.turns.length + live.turns.length;

  const groups: ImporterGroup[] = [];

  /*
   * The leading group exists for four reasons and no others: replayed words before the
   * first user message, records with no operator row before them, a session whose history
   * the harness answered with an absence while nothing else is on screen (the group is the
   * only place the absence can be said), and a history this page cannot read at all, which
   * stays said above every message typed into it.
   */
  const absent =
    turnCount === 0 &&
    live.leading.length === 0 &&
    (history.source === "loading" ||
      history.source === "pending" ||
      history.source === "forgotten");
  /*
   * A `pending` history is the page saying it cannot read this session's words, and that does
   * not stop being true when the operator types. Without this, one message in an indexed
   * continuation looks exactly like a brand-new session: the note is gone and nothing says
   * the thread above it is missing. The other absences are about arriving (`loading`) or
   * about a session that is gone (`forgotten`), and each is said once, before anything else.
   */
  const unreadable = history.source === "pending";
  if (
    replay.leading.length > 0 ||
    live.leading.length > 0 ||
    absent ||
    unreadable
  ) {
    const prose: RoundProse =
      replay.leading.length > 0
        ? {
            _tag: "replayed",
            note: history.note,
            ephemeral: true,
            truncated: history.truncated && turnCount === 0,
          }
        : leadingProse(history, turnCount > 0);
    groups.push({
      key: "earlier",
      subject: { message: null, number: null, at: null, working: false },
      prose,
      replayed: replay.leading,
      rows: rowsFor(live.leading, false),
    });
  }

  let number = 0;
  replay.turns.forEach((turn, position) => {
    number += 1;
    const last =
      position === replay.turns.length - 1 && live.turns.length === 0;
    groups.push({
      key: `turn:${String(number)}`,
      subject: {
        message: turn.user.text,
        number,
        at: null,
        working: false,
      },
      prose:
        turn.replies.length > 0
          ? {
              _tag: "replayed",
              note: history.note,
              ephemeral: true,
              truncated: history.truncated && last,
            }
          : {
              _tag: "none",
              note: "The harness holds this message and no reply to it.",
            },
      replayed: turn.replies,
      rows: [],
    });
  });

  live.turns.forEach((turn, position) => {
    number += 1;
    const latest = position === live.turns.length - 1;
    const working = latest && input.working;
    const spoke = turn.items.some((item) => item.origin === "activity");
    groups.push({
      key: `turn:${String(number)}`,
      subject: {
        message: turn.operator.body,
        number,
        at: turn.operator.at,
        working,
      },
      prose: spoke
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
      replayed: [],
      rows: rowsFor(turn.items, working),
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
 * What the page says in place of a conversation it cannot read.
 *
 * The harness holds what was said in a session, and reading it back is a later slice's. So
 * an indexed session opens with this, in the `pending` slot, rather than as the empty thread
 * — which would say nothing was ever said — or as `forgotten`, which would claim the harness
 * had been asked and had answered.
 */
export const INDEXED_HISTORY: ImporterHistory = {
  source: "pending",
  note: "This page does not read the session's messages yet; the harness holds them. What the session wrote is on the Scope tab and in the Estate, and its tally is in the session list.",
  truncated: false,
  messages: [],
};

/**
 * A session the server lists, as the page holds it.
 *
 * `harness` is a display name the caller resolves from the harness listing, because the
 * server's row carries the instance id and the avatar letter wants the name. `reading` is
 * true: an indexed session is opened to be read, and the first message the operator types
 * resumes it. `messages` is `null` — see {@link ImporterTally}. `strandedOn` is the caller's
 * to work out from the harness listing, and is set only for a harness this server lacks.
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
  history: INDEXED_HISTORY,
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
