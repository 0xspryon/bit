/**
 * The importer's own parts of its chat: what only an import has (the entries and assets a
 * session wrote, the pages a message made citable, the Scope tab and the Estate), its words
 * for the generic turn notes, and its binding of the generic turn builder.
 *
 * Everything else a chat does — the turns, the replay/live merge, the queued, taken and
 * carried marks, the session labels — is the generic chat's (`conversationChat.ts`), which a
 * goal, planner or worker chat uses as it is.
 */
import type { ImporterSessionView, ImporterTurnAccepted } from "@bit/contracts";

import {
  LOADING_HISTORY,
  buildConversationChat,
  conversationFeed,
  queuedNote,
  sendNowButtonTitle as sendNowButtonTitleFor,
  sendingNowNote as sendingNowNoteFor,
  sentNowTitle as sentNowTitleFor,
  stoppedNote,
  type ConversationChatInput,
  type ConversationGroup,
  type ConversationSession,
  type SendNowTiming,
} from "./conversationChat";
import type { ConversationTurnAccepted } from "./conversationSessions.svelte";

/** The importer, as the generic turn notes name their agent. */
export const IMPORTER_AGENT_NOUN = "importer";

/** One importer session as the page holds it: a conversation session with the import's tally. */
export type ImporterSession = ConversationSession<ImporterTally>;

/** One importer turn as a chat group. */
export type ImporterGroup = ConversationGroup;

/** {@link queuedNote}, in the importer's words. */
export const QUEUED_NOTE = queuedNote(IMPORTER_AGENT_NOUN);
/** {@link stoppedNote}, in the importer's words. */
export const STOPPED_NOTE = stoppedNote(IMPORTER_AGENT_NOUN);
/** What a Send now message says while it waits, in the importer's words. */
export const sendingNowNote = (timing: SendNowTiming): string =>
  sendingNowNoteFor(timing, IMPORTER_AGENT_NOUN);
/** What a Send now message the harness took says, in the importer's words. */
export const sentNowTitle = (timing: SendNowTiming): string =>
  sentNowTitleFor(timing, IMPORTER_AGENT_NOUN);
/** What the Send now button says, in the importer's words. */
export const sendNowButtonTitle = (timing: SendNowTiming): string =>
  sendNowButtonTitleFor(timing, IMPORTER_AGENT_NOUN);

/** The generic turn builder, with the importer as its agent. */
export const buildImporterChat = (
  input: Omit<ConversationChatInput, "agent">,
): readonly ConversationGroup[] =>
  buildConversationChat({ ...input, agent: IMPORTER_AGENT_NOUN });

/**
 * The generic replay/live merge, addressed by import id: the importer's live frames carry
 * the period id as `importId` (`LiveItem.importId`).
 */
export const importerFeed = (
  input: Omit<
    Parameters<typeof conversationFeed>[0],
    "conversationId" | "routeOf"
  > & {
    readonly importId: string | undefined;
  },
): ReturnType<typeof conversationFeed> => {
  const { importId, ...rest } = input;
  return conversationFeed({
    ...rest,
    conversationId: importId,
    routeOf: (item) => item.importId,
  });
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
 * What the page says above a session the operator is reading and has not typed into, by what
 * the next message will do (S6) and by whether the session is an *earlier* one (U8).
 *
 * **Never "earlier" for the conversation that is still going.** A session is earlier only when
 * nothing runs in it and a newer session exists on the target: a reload of the session that is
 * running — or of the newest one, idle — is the operator's conversation, not one they went
 * back to (found in U5's live runs). The server decides the rest: `live` is a session this
 * process holds, and the next message simply carries it on, so the newest one needs no note at
 * all; `resume` and `fresh` say what happens to a session it let go of, which matters newest
 * or not. While the server's answer is out (`standing` absent) the newest session says
 * nothing rather than guess.
 */
export const readingNote = (
  session:
    | Pick<ImporterSession, "reading" | "working" | "background" | "history">
    | undefined,
  newest: boolean,
): string => {
  if (session === undefined || !session.reading) return "";
  if (session.working || session.background === true) return "";
  const continuation = session.history.standing?.continuation;
  if (newest) {
    switch (continuation) {
      case "resume":
        return "This session is no longer held by the server. Your next message takes it back over: the importer keeps everything above, and works against the scope as it stands now.";
      case "fresh":
        return "This session cannot be carried on. Your next message starts a new one, and the importer in it will not have read any of this — what this session wrote is on the Scope tab and in the Estate.";
      default:
        return "";
    }
  }
  switch (continuation) {
    case "resume":
      return "You are reading an earlier session. Your next message takes it back over: the importer keeps everything above, and works against the scope as it stands now, not as it stood then.";
    case "fresh":
      return "You are reading an earlier session that cannot be carried on. Your next message starts a new one, and the importer in it will not have read any of this — what this session wrote is on the Scope tab and in the Estate.";
    default:
      return "You are reading an earlier session. Your next message continues it, with the scope as it stands now, not as it stood then.";
  }
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
  ...(view.title === null || view.title.trim() === ""
    ? {}
    : { title: view.title }),
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
  conversationId: view.importId,
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

/**
 * The importer's accepted message as the chat needs it: the import id as the period, and
 * the server's note with the pages the message made citable ({@link acceptedNotice}).
 */
export const importerTurnAccepted = (
  turn: ImporterTurnAccepted,
): ConversationTurnAccepted => ({
  conversationId: turn.importId,
  harnessSessionId: turn.harnessSessionId,
  harnessInstanceId: turn.harnessInstanceId,
  model: turn.model,
  conversation: turn.conversation,
  notice: acceptedNotice(turn),
  acceptedAt: turn.acceptedAt,
  ...(turn.messageId === undefined ? {} : { messageId: turn.messageId }),
  ...(turn.attachments === undefined ? {} : { attachments: turn.attachments }),
});
