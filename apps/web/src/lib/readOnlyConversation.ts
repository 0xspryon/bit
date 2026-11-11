/**
 * One session's transcript, read-only, from its replay plus live frames (A6 chat
 * generalisation, slice 2): the mount a planner stage (A9 H3/H3b) and a worker attempt's
 * "Worker transcript" (A9 H4b) need.
 *
 * **A function, not a mode of `ConversationSessions`.** Such a transcript has one session,
 * no composer, no picker and no parked words, so the multi-session state would be dead weight
 * around it. What it shares with the interactive chat is where the hard part lives: the
 * replay/live merge (`conversationFeed`, joined at the floor taken before the replay was
 * asked for, so nothing shows twice) and the turn builder (`buildConversationChat`).
 *
 * The caller holds the replay, its floor and whether the session is working; this turns them
 * into the {@link ChatSession} `ChatShell` draws, with a **closed** composer whose sentence
 * says why it cannot be prompted (the planner's "ask the goal agent in Chat"), an optional
 * marker over the thread (what the stage was given), and Stop when the owner offers one.
 */
import type { LiveItem } from "@bit/contracts";

import type {
  ChatSession,
  ChatTurnState,
  ChatWords,
  ThreadTurn,
  TurnFooterSource,
} from "./chatShell";
import {
  LOADING_HISTORY,
  buildConversationChat,
  conversationFeed,
  historyOf,
  type ConversationGroup,
  type ConversationReplayView,
} from "./conversationChat";
import type { AttachmentLoader } from "./attachmentFiles";

/** The transcript's sources: the replay, if it has answered, and the live feed. */
export interface ReadOnlySource {
  /**
   * The server's replay of the session, with the activity publish order this tab had seen
   * when it was asked for. `undefined` while it has not answered: the thread is `loading`.
   */
  readonly replay:
    | { readonly view: ConversationReplayView; readonly floor: number }
    | undefined;
  /** The target's live feed. Only items whose {@link routeOf} is the period are this one's. */
  readonly live: readonly LiveItem[];
  /** The period the transcript is of: the attempt id, the stage's period. */
  readonly conversationId: string;
  /** Which period a live item belongs to: a worker attempt's `attemptId`. */
  readonly routeOf: (item: LiveItem) => string | null;
  /** Whether the session is working now: the streaming cursor, and pending writes. */
  readonly working: boolean;
  /** The agent, as the turns' notes name it: `planner`, `worker`. */
  readonly agent: string;
  /** How many of the target's events the record feed did not send. `0` when omitted. */
  readonly recordsSkipped?: number;
}

/** The turns of one read-only session: replayed, then live, joined at the replay's floor. */
export const readOnlyGroups = (
  source: ReadOnlySource,
): readonly ConversationGroup[] => {
  const history =
    source.replay === undefined
      ? LOADING_HISTORY
      : historyOf(source.replay.view);
  return buildConversationChat({
    agent: source.agent,
    history,
    items: conversationFeed({
      own: [],
      floors: undefined,
      live: source.live,
      conversationId: source.conversationId,
      routeOf: source.routeOf,
      historyFloor: source.replay?.floor,
      replayed: history.items,
      working: source.working,
      callInFlight: source.working,
    }),
    working: source.working,
    recordsSkipped: source.recordsSkipped ?? 0,
  });
};

/** What a read-only chat says, beside its turns. */
export interface ReadOnlyChatInput {
  /** The turns, read when the shell draws: usually {@link readOnlyGroups} over live state. */
  readonly groups: () => readonly ConversationGroup[];
  readonly label: string;
  readonly empty: string;
  /** Why the box is closed: "The planner can't be prompted. To redirect it, ask …". */
  readonly closed: string;
  /** A sentence over the thread — what the stage was given — or `""`. */
  readonly marker?: () => string;
  /** The narration connection's notice (`connectionNote`), or `""`. */
  readonly connection?: () => string;
  readonly turn: () => ChatTurnState;
  /** Stops the session's turn (Stop round, Stop run). Absent: no Stop. */
  readonly stop?: () => void;
  readonly words: ChatWords;
  readonly footer: () => TurnFooterSource;
  readonly loadFile?: AttachmentLoader;
}

/** The {@link ChatSession} for a read-only transcript: no composer of its own, ever. */
export const readOnlyChat = (
  input: ReadOnlyChatInput,
): ChatSession<ThreadTurn> => ({
  label: input.label,
  empty: input.empty,
  get groups() {
    return input.groups();
  },
  get note() {
    return input.marker?.() ?? "";
  },
  get connection() {
    return input.connection?.() ?? "";
  },
  get turn() {
    return input.turn();
  },
  ...(input.stop === undefined ? {} : { stop: input.stop }),
  composer: { closed: input.closed },
  words: input.words,
  get footer() {
    return input.footer();
  },
  // Nothing in a read-only transcript is sent now: no bubble carries the mark.
  sentNowTitle: "",
  ...(input.loadFile === undefined ? {} : { loadFile: input.loadFile }),
});
