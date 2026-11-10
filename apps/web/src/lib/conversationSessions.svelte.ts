/**
 * A chat's sessions with one agent, for any owner: the state the importer's Auto-load chat
 * has run on since S3, with the owner made a binding (A6 chat generalisation, slice 2). The
 * goal chat (A9 H2/H2b) is meant to be the second binding.
 *
 * ## What this holds
 *
 * The owner's sessions — the server's list ({@link ConversationSessions.begin},
 * {@link ConversationSessions.syncIndexed}) and the page's own empty one — the one on screen,
 * and its composer. Opening a listed session reads its conversation back from the harness
 * ({@link ConversationServer.history}), with the server's account of what the next message
 * will do. Sending posts ({@link ConversationServer.open}, {@link ConversationServer.send}),
 * and the draft is cleared **on acceptance**, not on submit, so a refusal leaves the
 * operator's words beside the server's sentence. What comes back decides where the turn
 * lands: `continued` appends; `opened` and `resumed` are a new period, often a new harness
 * session, and the page moves to it.
 *
 * ## What the agent says, live
 *
 * Its replies arrive on the **target's** live feed, which the app holds; {@link groups}
 * files each entry under the session whose period the binding's {@link
 * ConversationBinding.routeOf} names. Nothing is copied into a session. A session is
 * `working` from an accepted message until the server says nothing runs
 * ({@link ConversationServer.watchTurn}) — not when the agent goes quiet.
 *
 * ## What an owner leaves out
 *
 * The server's members are the chat's abilities: an owner whose server has no `context`
 * has no meter, no `switchModel` no picker, no `stopSubagent` no card Stop, no `stopAll`
 * no Stop all, no `answerQuestion` no dock ({@link ConversationAbilities}). Nothing falls
 * back to another action in a missing one's place. The binding
 * names how the owner's frames are routed, what an empty session is, and the agent as
 * sentences name it. The importer's starters, agent registry, mock scenarios and stand-in
 * reply are its own (`importerSessions.svelte.ts`).
 */
import type {
  AgentsView,
  ContextCategory,
  ConversationContext,
  ConversationModelDraft,
  ConversationModelSwitched,
  ConversationStopped,
  ConversationStart,
  MessageAttachmentView,
  LiveConnection,
  LiveItem,
  LiveQuestion,
  LiveUsage,
  ModelOptionSelection,
  PendingQuestion,
  QuestionAnswers,
  SteerUrgency,
} from "@bit/contracts";
import {
  CONVERSATION_MESSAGE_MAX_CHARS,
  QUESTION_RECHECK_MS,
  sameModel,
  sameWindow,
  truncateNarration,
} from "@bit/contracts";

import type { ErrorNotice } from "./components/ErrorDialog.svelte";

import { operatorTurn } from "./chat";
import { ComposerFiles, FILES_WITHOUT_WORDS } from "./composerFiles.svelte";
import {
  NO_HISTORY,
  TAKEN_KIND,
  buildConversationChat,
  conversationFeed,
  sendNowTiming,
  takesUnknownMessage,
  withoutLost,
  withReplay,
  type ConversationGroup,
  type ConversationReplayView,
  type ConversationSession,
  type SendNowTiming,
  isolated,
  messageTooLong,
  sessionStarted,
  switchedNotice,
} from "./conversationChat";
import {
  parkedMark,
  type ParkedMessage,
  type ParkedMessages,
} from "./conversationParked";

/** The `agentId` field a session is pinned with, or nothing when no agent is known yet. */
const pinAgent = (
  agentId: string | undefined,
): { readonly agentId?: string } => (agentId === undefined ? {} : { agentId });

/**
 * One message the server accepted, as the page needs it: the owner's answer with its period
 * id named `conversationId`, and what the composer says under it.
 */
export interface ConversationTurnAccepted {
  /** The period the message landed in: the one to address the next message to. */
  readonly conversationId: string;
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string;
  readonly model: string;
  readonly conversation: ConversationStart;
  /**
   * What the composer says under the message: the server's note, and whatever the owner
   * adds (the importer's citable pages). Empty on an ordinary `continued` turn.
   */
  readonly notice: string;
  readonly acceptedAt: number;
  readonly messageId?: string;
  readonly attachments?: readonly MessageAttachmentView[];
}

/**
 * What an owner is, to a chat's state: how its frames are routed, what an empty session is,
 * and how sentences name its agent.
 */
export interface ConversationBinding<S extends ConversationSession> {
  /**
   * The period a live frame belongs to, by the owner's subject id, or `null`: the
   * importer's `conversationId`. A frame whose route is a session's `conversationId` is that
   * session's.
   */
  readonly routeOf: (frame: {
    readonly attemptId: string | null;
    readonly roundId: string | null;
    readonly goalId: string | null;
    readonly importId: string | null;
  }) => string | null;
  /**
   * The key the app files one period's narration connection and model calls under: what
   * `usageScope` (`chat.ts`) makes of this owner's frames, `import:<id>` for the importer.
   * The `lost` notice is read and forgotten by it, and the context meter's live figure.
   */
  readonly connectionKey: (conversationId: string) => string;
  /** The agent, as the turns' notes and the switch line name it: `importer`. */
  readonly agent: string;
  /** The page's own empty session, to type a first message into. */
  readonly emptySession: (now: number, id?: string) => S;
  /**
   * What a message sent with no server is answered with (a prototype's scenarios), so no
   * one reads it as the agent's own words. Absent: such a message is not answered.
   */
  readonly standIn?: { readonly headline: string; readonly body: string };
}

/**
 * The optional abilities a chat draws a control for (review 1 of slice 2). Leaving one out
 * of the owner's {@link ConversationServer} means the chat cannot do that thing: no
 * `stopAll`, no Stop all pill; no `answerQuestion`, no dock (the question is only the
 * transcript's tool row); no `dismissQuestion`, a dock with no dismissal; no
 * `stopSubagent`, no Stop on a sub-agent's card (the page that draws the cards reads it).
 */
export interface ConversationAbilities {
  readonly stopAll: boolean;
  readonly stopSubagent: boolean;
  readonly answerQuestion: boolean;
  readonly dismissQuestion: boolean;
}

/** What `server` can do; everything, for no server (the prototype draws it all). */
export const abilitiesOf = (
  server: ConversationServer | undefined,
): ConversationAbilities =>
  server === undefined
    ? {
        stopAll: true,
        stopSubagent: true,
        answerQuestion: true,
        dismissQuestion: true,
      }
    : {
        stopAll: server.stopAll !== undefined,
        stopSubagent: server.stopSubagent !== undefined,
        answerQuestion: server.answerQuestion !== undefined,
        dismissQuestion: server.dismissQuestion !== undefined,
      };

/** A binding nothing is routed to, until the constructor installs the real one. */
const UNBOUND: ConversationBinding<ConversationSession> = {
  routeOf: () => null,
  connectionKey: (conversationId) => `unbound:${conversationId}`,
  agent: "agent",
  emptySession: () => {
    throw new Error(
      "a conversation's state was read before its binding was set",
    );
  },
};

/** What the server answered a message with, as the page needs it. */
export type ConversationSent =
  | {
      readonly _tag: "accepted";
      readonly turn: ConversationTurnAccepted;
      /** What an opening message set its model's options to, when it opened one. */
      readonly modelOptions?: readonly ModelOptionSelection[];
    }
  | {
      readonly _tag: "refused";
      readonly detail: string;
      /**
       * The server refused because the import was ended (`import_ended`): its row changed
       * since the list was read, so the list is read again and the composer disables on it.
       */
      readonly ended?: boolean;
      /**
       * The refusal is about the message's files (A6 U13) — one over a cap, a HEIC, too many,
       * a request over what the listener takes, files that could not be stored — and is said
       * in the F2 dialog rather than beside the draft; the words and the files stay put.
       */
      readonly files?: boolean;
    }
  | {
      /**
       * **No answer came back** — no server answered, or the connection failed on the way
       * back (U8 review 4). Not a refusal: the server may have taken the message, and even
       * opened a session for it, before the answer was lost. Whether it was sent is not known.
       */
      readonly _tag: "unanswered";
    };

/** What the server answered a model switch with, as the page needs it (A6 F4). */
export type ConversationSwitchAnswer =
  | { readonly _tag: "switched"; readonly switched: ConversationModelSwitched }
  | { readonly _tag: "refused"; readonly detail: string };

/** A model switch of one session that is with the server and not yet answered. */
export interface ModelSwitchInFlight {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly model: string;
}

/** The line over the composer about a session's last accepted switch. */
export interface SwitchNotice {
  readonly sessionId: string;
  readonly text: string;
  /**
   * The same confirmation in the past tense, for a switch answered while a turn was running:
   * what {@link text} becomes when that turn ends. Absent when there is no turn to end.
   */
  readonly onceIdle?: string;
}

/** A model switch of one session that the server refused, until the operator dismisses it. */
export interface SwitchFailure {
  readonly sessionId: string;
  readonly notice: ErrorNotice;
}

/** A sub-agent's Stop, answered (A7-S): the server's sentence either way. */
export type SubagentStopAnswer =
  | { readonly _tag: "stopped"; readonly detail: string }
  | { readonly _tag: "refused"; readonly detail: string };

/** What the server answered a Stop with, as the page needs it. */
export type ConversationStopAnswer =
  | { readonly _tag: "stopped"; readonly stopped: ConversationStopped }
  | { readonly _tag: "refused"; readonly detail: string };

/**
 * What the server says is running in one import's session (A6 U6), as the turn watch hands
 * it on: a turn — one the operator's message started, or one the harness opened by itself —
 * and work the agent started in the background, which runs outside any turn.
 */
export interface ConversationActivityState {
  readonly running: boolean;
  readonly background: boolean;
}

/** What the server did with an answer or a dismissal (A7-Q). */
export type ConversationQuestionAnswer =
  | { readonly _tag: "settled" }
  | {
      readonly _tag: "refused";
      /** `QuestionRefused.reason`, or `other` for any other refusal. */
      readonly reason: "settled" | "invalid" | "harness_unreachable" | "other";
      readonly detail: string;
    }
  | { readonly _tag: "unanswered" };

/**
 * The page's way to the server, handed in by the app when the page is a real target's.
 *
 * Absent in the state picker's scenarios, which never touch a server and answer with the
 * stand-in reply instead.
 */
export interface ConversationServer {
  /**
   * Opens a conversation whose first turn is `text`, as the agent `agentId` — or as the
   * server's default agent when it is `undefined`, the operator having picked none.
   */
  readonly open: (
    text: string,
    agentId: string | undefined,
    /** The files the message carries, in the same request (A6 U13). */
    files?: readonly File[],
  ) => Promise<ConversationSent>;
  /**
   * Says `text` to one import's session: while a turn runs, `queued` (the default) waits for
   * the work in flight, and `preemptive` ("Send now") lands at the harness's next step.
   */
  readonly send: (
    conversationId: string,
    text: string,
    urgency?: SteerUrgency,
    /** The files the message carries, in the same request (A6 U13). */
    files?: readonly File[],
  ) => Promise<ConversationSent>;
  /**
   * Stops the turn running in one import's session, keeping the conversation (A6 F5): the
   * harness is interrupted and the session stays open for the next message.
   */
  readonly stop: (conversationId: string) => Promise<ConversationStopAnswer>;
  /**
   * E7's Stop all (A7-S): every sub-agent the server can stop on its own, then the turn and
   * background work, answered as {@link stop} is.
   */
  readonly stopAll?: (
    conversationId: string,
  ) => Promise<ConversationStopAnswer>;
  /** Stops one sub-agent of one import's session (A7-S), by its calling tool call's id. */
  readonly stopSubagent?: (
    conversationId: string,
    callId: string,
  ) => Promise<SubagentStopAnswer>;
  /**
   * Answers, or dismisses, the question one import's agent is waiting on (A7-Q), by the
   * harness's id for it. `settled` when the server passed it on; `refused` with the
   * server's reason and sentence; `unanswered` when no server answered.
   */
  readonly answerQuestion?: (
    conversationId: string,
    questionId: string,
    answers: QuestionAnswers,
  ) => Promise<ConversationQuestionAnswer>;
  readonly dismissQuestion?: (
    conversationId: string,
    questionId: string,
  ) => Promise<ConversationQuestionAnswer>;
  /**
   * Moves one import's session onto another model of its pinned harness, or other options
   * of its model (A6 F4). Never another harness: that is a new session.
   */
  readonly switchModel?: (
    conversationId: string,
    draft: ConversationModelDraft,
  ) => Promise<ConversationSwitchAnswer>;
  /**
   * Reads one import's conversation back from the harness (S6), with the activity publish
   * order the read is to be joined at.
   *
   * The floor comes back from here rather than being taken by the caller because it must be
   * taken **before the request leaves**: anything published after that is the live tail and
   * must not be dropped. `undefined` is a read that did not answer, which leaves the session
   * exactly as it was — a thread that will not load is better than one that claims the
   * harness said nothing.
   */
  readonly history: (
    conversationId: string,
  ) => Promise<
    | { readonly view: ConversationReplayView; readonly floor: number }
    | undefined
  >;
  /**
   * Reads the session list again: after an accepted message, so the session it landed in
   * is listed with the server's figures, after an `import_ended` refusal, so the session
   * the operator ended reads as ended and the composer stops offering it, and after a lost
   * answer, to look for the session it may have opened.
   */
  readonly reread: () => Promise<void>;
  /** Resolves after `ms`: the app's countdown, so a test decides when it is up. */
  readonly wait: (ms: number) => Promise<void>;
  /**
   * This tab's parked words for the target (`conversationParked.ts`): read when the page opens
   * on it, written whenever they change, so a return to the page or a reload keeps them.
   */
  readonly parked: {
    readonly read: () => ParkedMessages;
    readonly write: (parked: ParkedMessages) => void;
  };
  /** A harness instance's display name, for the glyph on the composer's model chip. */
  readonly harnessName: (instanceId: string) => string;
  /**
   * A harness instance's driver (`HarnessInstanceView.driver`), or `undefined` for one this
   * server does not list: what "Send now" is worded by (`sendNowTiming`), never routed by.
   */
  readonly harnessDriver: (instanceId: string) => string | undefined;
  /**
   * The highest activity publish order this tab has seen, or `0` for none. Read when a
   * message is sent, so the importer's answer sorts after it: see
   * `ConversationSession.floors`.
   */
  readonly highWater: () => number;
  /**
   * Watches what is running in one import's session (A6 U6), calling `update` with each
   * answer, until an answer says nothing is — no turn and no background work — which is
   * the last call. A refusal, or no server answering, is reported as nothing running.
   *
   * **Asked, because the narration cannot say it.** The bus carries what the agent says and
   * nothing about when it has stopped — a harness's stream has no "idle" entry, and an
   * agent can be silent for a minute while it reads a page. The server does know, from the
   * harness: a turn is running from the moment a message is accepted until the harness goes
   * idle, and also while a turn the harness opened by itself runs, which no message here
   * started. So the turn's cursor and its Stop follow that answer and nothing guessed from
   * the feed. Returns a function that stops watching.
   */
  readonly watchTurn: (
    conversationId: string,
    update: (activity: ConversationActivityState) => void,
  ) => () => void;
  /**
   * How full one import's context window is (A6 U9), `breakdown` asking for the categories
   * too. `undefined` for a read that did not answer, which leaves the meter as it was.
   */
  readonly context?: (
    conversationId: string,
    breakdown: boolean,
  ) => Promise<ConversationContext | undefined>;
}

/**
 * What made this tab read an import's context window (A6 U9), which is what the meter's
 * footer says of the reading: opening the session, a turn's end, a Stop settling, a model
 * switch, the operator opening the meter (`asked`), or the open meter counting a window its
 * rows were not counted on (`recount`, after a switch here or in another tab).
 */
export type ContextReadCause =
  "opened" | "turn" | "stop" | "switch" | "asked" | "recount";

/**
 * What this tab holds of one import's context window (A6 U9): the server's latest reading,
 * the figure before it, and the categories when they were last counted.
 */
export interface ConversationContextState {
  readonly reading: ConversationContext;
  /**
   * The measured figure before {@link reading}'s that differed from it, with the model that
   * measured it, or `null`: what a drop — a compaction — is told against. A reading with
   * the same figure leaves it as it was, so a second read of an unchanged window (the
   * meter's breakdown) does not forget a drop.
   *
   * Kept whatever model measured it: the meter compares two figures only when the server
   * labels them with one model (`sameModel`), because each model counts the same
   * conversation with its own tokenizer (haiku-4-5 about 22 % below sonnet-5, measured). No
   * guess about switches is made here (A6 U9 review 2).
   */
  readonly previous: {
    readonly used: number;
    readonly model: string | null;
  } | null;
  /** What made this tab take {@link reading}; absent where nothing said. */
  readonly cause?: ContextReadCause;
  /**
   * The categories the harness last counted, and when: kept across the cheaper readings
   * that follow a turn, which carry none, so an open breakdown does not empty itself. A
   * screen compares {@link ConversationContext.measuredAt} to say they predate the figure.
   */
  readonly categories?: {
    readonly rows: readonly ContextCategory[];
    readonly measuredAt: number;
    /**
     * The model they were counted on, as the server labelled them. Only shown under a
     * reading of the same window (`crumbMeter`): the free space and the reserve are that
     * model's (A6 U9 review, measured: sonnet-5's 937,064 free read as 469 % of haiku-4-5's
     * window after a switch).
     */
    readonly model: string;
  };
}

export class ConversationSessions<
  S extends ConversationSession = ConversationSession,
> {
  /**
   * The owner. Initialised here and replaced in the constructor, as {@link #live} is: the
   * derived fields below read it, and a field initialiser runs before the constructor body.
   */
  #binding: ConversationBinding<S> =
    UNBOUND as unknown as ConversationBinding<S>;
  readonly #now: () => number;
  /**
   * The target's live feed, read inside {@link groups} so an arrival moves the chat.
   * Initialised here and replaced in the constructor: a field initialiser runs before the
   * constructor body, and {@link groups} is one.
   */
  #live: () => readonly LiveItem[] = () => [];
  /**
   * How many of the target's events the live feed did not send (`LiveOpened.skipped`), read
   * where {@link groups} is derived, for {@link #live}'s reason. Non-zero stops the chat
   * pairing a replayed write with a record by position (`buildImporterChat`).
   */
  #skipped: () => number = () => 0;
  /**
   * Whether the owner says nothing can be sent at all (the importer's "no model to run
   * on"), read where {@link messageBlocked} is derived, for {@link #live}'s reason.
   */
  #unavailable: () => boolean = () => false;
  #sent = 0;
  /**
   * The page's empty session whose first message is with the server, and that message's
   * words; `undefined` when no opening message is out. **That session is not empty any more,
   * though nothing on it says so yet**: the server's answer turns it into the conversation it
   * opened and, if it is on screen then, writes that conversation's id over `/assets/chat`
   * (`becameId`). So "Start a new session" must neither land on it nor stay on it.
   */
  #opening: { readonly sessionId: string; readonly text: string } | undefined;
  /**
   * The imports whose conversation is being read right now, by import id.
   *
   * **One request per session, and this is what makes that true rather than nearly true.**
   * {@link #loadHistory} is reached from two places — opening a session, and the index
   * arriving, because a session can be opened by id before the list naming it has come back
   * — and `loaded` is only set when an answer lands, so without this the two overlap and ask
   * twice. Three times, measured: `openImporter` opens the session and then reads the index,
   * which reads it again.
   */
  readonly #reading = new Set<string>();
  /**
   * The imports whose replay on screen was read while their turn was running, by import id
   * (A6 U5 review 2): read again once the turn settles ({@link #rereadSettled}).
   *
   * **A replay read mid-turn can lack blocks it will never be sent again.** Both harnesses
   * store a model call's blocks only when the whole call ends — Claude Code writes them to
   * its transcript then, and OpenCode 2.2.5's message list held only the operator's row for
   * the whole of a 20 s GLM message (measured, U5 review 3) — so a replay read mid-reply has
   * no thought above the reply, though its finished frame went out live seconds earlier.
   * `importerFeed` keeps that frame while the live feed holds it, but a reload starts a new
   * feed, and the bus no longer holds frames from before it: the thought is in neither, and
   * nothing else reads the replay again. Once the turn has settled, the harness holds every
   * block of it.
   *
   * V2(chat): until then, a reload mid-call shows the turn without the call's earlier
   * finished thought or reply — for up to the rest of the call. V2 holds a per-import tail of
   * the finished reply/thinking items narrated during the running turn on the server, beside
   * the queued steers in `import/scopeImporter.ts` (about the last 32 blocks / 256 KB,
   * cleared at turn end, at a Stop's settle and at session end, lost on a restart, which ends
   * the turn too), and `import/importerHistory.ts` appends the tail's blocks whose `blockId`
   * the transcript lacks after reading it, so the first replay is already whole.
   */
  readonly #readMidTurn = new Set<string>();
  /**
   * The turn watch's last answer for each import it has watched (A6 U6), by import id.
   *
   * **Newer than the list's `running`, and what a reading of the list defers to.** The list
   * reads the import's own status, which is `finished` while a turn the harness opened by
   * itself runs and says nothing of background work; the watch asks the harness. Once an
   * import has been asked about, new work in it is noticed from the live feed
   * ({@link noteActivity}) or from a message this tab sends, either of which watches it again.
   */
  readonly #activityOf = new Map<string, ConversationActivityState>();
  /** Stops watching the turn in flight, if one is being watched. */
  #unwatch: (() => void) | undefined = undefined;
  /** The import {@link #unwatch} is for. */
  #watching: string | undefined = undefined;
  /**
   * A Stop's sentence about a conversation that was still busy when it was answered, and the
   * ids it is about. It describes what the Stop left running, so it is over when that is:
   * the turn watch clears it from {@link notice} when the turn ends (`turn`), or when the
   * background work it may have left running is over (`background`, A6 U6) — not at the end
   * of the next turn.
   */
  #busyStop:
    | {
        readonly ids: readonly string[];
        readonly text: string;
        readonly about: "turn" | "background";
      }
    | undefined = undefined;

  /** Every session on the target, in no particular order. */
  sessions = $state.raw<readonly S[]>([]);
  /**
   * Each import's context reading (A6 U9), by import id: what the crumb bar's meter draws.
   *
   * **Read when something can have changed it, never per model call**: on opening a
   * session, when a turn ends, after a model switch (the window is the model's), and with
   * categories when the operator opens the meter. Between those the meter draws the live
   * feed's per-call frames where they are newer (`crumbMeter`).
   */
  contexts = $state.raw<Readonly<Record<string, ConversationContextState>>>({});
  /** Imports whose categories are being counted: the breakdown says so meanwhile. */
  countingBreakdown = $state.raw<ReadonlySet<string>>(new Set());
  /**
   * Imports whose context is being read, by the number of reads out, so the list's first
   * reading does not ask again.
   */
  readonly #readingContext = new Map<string, number>();
  /**
   * The breakdown read out for each import (A6 U9 review): at most one, which a meter
   * opened again while it is out joins rather than asking the harness to count again.
   * `wanted` goes false when the meter closes or the session on screen changes, and an
   * unwanted read's answer is dropped when it lands.
   */
  readonly #breakdowns = new Map<
    string,
    { wanted: boolean; done: Promise<void> }
  >();
  /**
   * Imports whose meter is open (A6 U9 review 2): the operator is looking at the
   * categories, so a reading of a window they were not counted on is followed by one count
   * of it ({@link #recountIfStale}).
   */
  readonly #meterOpen = new Set<string>();
  /**
   * The window model each import was last re-counted for while its meter stayed open: at
   * most one count per model per opening, so a count that comes back on another model
   * than the reading cannot ask again, and again ({@link #recountIfStale}).
   */
  readonly #recountedFor = new Map<string, string>();
  /** The one on screen. */
  currentId = $state("");
  /**
   * The server's id for the session the page's own empty one became on its first message,
   * until the operator next opens or starts a session (U8): the address bar's
   * `/assets/chat` entry *is* that session from then on, so the route corrects the entry
   * rather than adding one (`placeHistory.historyWrite`), and Back does not land on a blank
   * thread the operator already filled.
   */
  becameId = $state<string | undefined>(undefined);
  /** What is typed in the composer and not yet sent. */
  draft = $state("");
  /**
   * The files the composer holds for the next message (A6 U13), the page's like the draft.
   *
   * V2(chat): they live only in this page, as `File`s, so a message whose answer is lost or
   * that is refused after the operator left its session gives back its words
   * (`conversationParked.ts`) but not its files — a `File` cannot go into `sessionStorage` — and
   * leaving the session drops them. Proper V2 is T3's two-step upload: each file staged on
   * the server as it is added, so a draft (and parked words) can name staged files by id.
   */
  readonly files = new ComposerFiles();
  /** Whether the crumb bar's session list is open. */
  pickerOpen = $state(false);
  /** True while a message is with the server and not yet answered. */
  sending = $state(false);
  /**
   * What the server last said about a message, in its words: a refusal, or the note on an
   * accepted one (a reopened session says why). Empty when there is nothing to say.
   */
  notice = $state("");
  /** Whether {@link notice} is a refusal, which the composer shows as one. */
  refused = $state(false);
  /**
   * The line a dismissal the harness did not answer left above the box, and whose session
   * it is (A7-Q review 2): taken away if the question is offered again.
   */
  #putAwayNotice:
    { readonly sessionId: string; readonly notice: string } | undefined =
    undefined;
  /**
   * The words of messages that did not land where they were sent, by the session they wait
   * on (`conversationParked.ts`): refused, or with no answer, after the operator had left that
   * session. **The one copy, and kept in this tab**: every change is written through to the
   * server's {@link ConversationServer.parked}, and {@link begin} reads them back. A session
   * holding some is listed and marked; opening it gives them back to the composer.
   */
  parked = $state.raw<ParkedMessages>({});
  /** True while a Stop is with the server and not yet answered. */
  stopping = $state(false);
  /**
   * A Stop the server could not carry out, for the error dialog; `undefined` when there is
   * none. Not {@link notice}: that line is about the draft beneath it, and a Stop is not.
   */
  stopFailure = $state<ErrorNotice | undefined>(undefined);
  /** True while an answer or a dismissal of the session's question is with the server (A7-Q). */
  questionBusy = $state(false);
  /**
   * An answer or a dismissal the server refused or did not answer, for the error dialog
   * (A7-Q); `undefined` when there is none.
   */
  questionRefusal = $state<ErrorNotice | undefined>(undefined);
  /**
   * The agents a conversation can run as, for the composer's agent chip: the server's
   * registry when the page is a real target's, the mock one in the state picker's
   * scenarios, and `undefined` while the server's has not been read (or could not be).
   */
  agents = $state.raw<AgentsView | undefined>(undefined);
  /**
   * The model switches with the server and not yet answered (A6 F4), **one per session at
   * most**: the server refuses a second switch of the same import while one is in flight
   * (`switch_in_flight`), so the page does not offer it — but a switch of another session
   * is another import's, and nothing stops it. Read one session's with {@link switchingOf}.
   */
  switches = $state.raw<readonly ModelSwitchInFlight[]>([]);
  /**
   * What the server answered the last accepted switch with, in words ({@link switchedNotice}),
   * and the session it is about. Empty when there is nothing to say.
   *
   * It is about *the next thing to happen*, so it goes when that has happened: the next
   * message this tab sends in the session clears it, and a confirmation worded for a turn
   * that was running is reworded to the past ({@link SwitchNotice.onceIdle}) when that turn
   * ends, rather than going on saying the step "is on now" finishes on the old model.
   */
  switchNotice = $state<SwitchNotice | undefined>(undefined);
  /**
   * The switches the server refused and the operator has not yet dismissed, for the error
   * dialog: **one per session at most, and shown only over its own session.** A refusal
   * answers a pick made in one session's picker; drawn over whatever is on screen when it
   * lands — another session's picker, after browser Back — it reads as a refusal of *that*
   * session's pick. So it waits with its session, and opens when that session is on screen
   * again. Read one session's with {@link switchFailureOf}.
   */
  switchFailures = $state.raw<readonly SwitchFailure[]>([]);
  /**
   * True while a message sent behind an in-flight switch is with the server (F4's review):
   * the server delivers it once the switch has answered, which can take up to ~90 s when
   * the switch has to reopen the session first. The composer says it is waiting.
   */
  waitingForSwitch = $state(false);
  /**
   * The model each import was switched to by this tab, until a reading of the index agrees.
   * A reading that left before the switch answered still names the old model; without this
   * it would put the chip back on a model the session has left.
   */
  readonly #switchedTo = new Map<string, string>();
  /**
   * The model a live frame showed each import moved to, from another client, once this tab
   * has read the list and the window again for it ({@link noteUsage}).
   */
  readonly #movedTo = new Map<string, string>();
  /** The server's registry as last read, kept across visits: it is read once per page load. */
  #serverAgents: AgentsView | undefined = undefined;
  #server: ConversationServer | undefined = undefined;

  /**
   * Which of the server's optional abilities the chat draws (review 1 of slice 2): one the
   * owner's server leaves out is a control that is not drawn, never a quiet fallback to
   * another action. Read from the server when it is installed. Without one — the state
   * picker's scenarios — the prototype draws everything, as it always has.
   */
  abilities = $state<ConversationAbilities>(abilitiesOf(undefined));

  constructor(
    binding: ConversationBinding<S>,
    now: () => number = () => Date.now(),
    live: () => readonly LiveItem[] = () => [],
    skipped: () => number = () => 0,
    unavailable: () => boolean = () => false,
  ) {
    this.#binding = binding;
    this.#now = now;
    this.#live = live;
    this.#skipped = skipped;
    this.#unavailable = unavailable;
    this.reset({ sessions: [binding.emptySession(now())] });
  }

  /** The owner this chat is for. */
  get binding(): ConversationBinding<S> {
    return this.#binding;
  }

  /**
   * Puts the chat into a declared state with no server: `sessions`, the first on screen
   * unless `currentId` says otherwise. Everything this tab held of a server is dropped. What
   * a prototype's scenario loads (`ImporterSessions.load`).
   */
  reset(state: {
    readonly sessions: readonly S[];
    readonly currentId?: string;
    readonly agents?: AgentsView | undefined;
    readonly draft?: string;
    readonly pickerOpen?: boolean;
  }): void {
    this.#stopWatching();
    this.#reading.clear();
    this.#readMidTurn.clear();
    this.#activityOf.clear();
    this.#forgetBreakdowns();
    this.#server = undefined;
    this.abilities = abilitiesOf(undefined);
    this.notice = "";
    this.refused = false;
    this.sending = false;
    this.stopping = false;
    this.switches = [];
    this.switchNotice = undefined;
    this.switchFailures = [];
    this.waitingForSwitch = false;
    this.#switchedTo.clear();
    this.#movedTo.clear();
    this.becameId = undefined;
    this.stopFailure = undefined;
    this.questionBusy = false;
    this.questionRefusal = undefined;
    this.draft = state.draft ?? "";
    this.files.clear();
    this.pickerOpen = state.pickerOpen ?? false;
    this.#sent = 0;
    this.#opening = undefined;
    this.parked = {};
    this.agents = state.agents;
    this.sessions = state.sessions;
    this.currentId = state.currentId ?? state.sessions[0]?.id ?? "";
  }

  current = $derived(
    this.sessions.find((session) => session.id === this.currentId),
  );

  /**
   * When the harness of the session on screen reads a "Send now" message (A6 U6 review),
   * for the words that say so. `unknown` without a server, or before the session names its
   * harness instance.
   */
  sendNow = $derived<SendNowTiming>(
    sendNowTiming(
      this.current?.harnessInstanceId === undefined
        ? undefined
        : this.#server?.harnessDriver(this.current.harnessInstanceId),
    ),
  );

  /** The conversation on screen, one group per operator message. */
  groups = $derived<readonly ConversationGroup[]>(
    this.current === undefined
      ? []
      : buildConversationChat({
          agent: this.#binding.agent,
          history: this.current.history,
          items: conversationFeed({
            routeOf: this.#binding.routeOf,
            own: this.current.items,
            floors: this.current.floors,
            live: this.#live(),
            conversationId: this.current.conversationId,
            // The replay/live boundary. Undefined on a session whose words were never asked
            // for, which takes nothing away: it has no replay to collide with.
            historyFloor: this.current.historyFloor,
            replayed: this.current.history.items,
            midTurn: this.current.midTurn,
            working: this.current.working,
            taken: this.current.taken,
            callInFlight:
              this.current.working || this.current.replayMidTurn === true,
          }),
          working: this.current.working,
          recordsSkipped: this.#skipped(),
          ...(this.current.midTurn === undefined
            ? {}
            : { midTurn: this.current.midTurn }),
          ...(this.current.taken === undefined
            ? {}
            : { taken: this.current.taken }),
          ...(this.current.sentNow === undefined
            ? {}
            : { sentNow: this.current.sentNow }),
          sendNow: this.sendNow,
        }),
  );

  /**
   * The picker's rows, newest first.
   *
   * A session nobody has said anything in is not a *previous* session; it is the empty one
   * the operator is looking at, and listing it would make "Start a new session" appear to
   * have a twin. An indexed session's count is unknown rather than zero, and it is listed:
   * the server says it exists. One holding {@link parked} words is listed too: they are on
   * no other row, and nowhere else.
   */
  listed = $derived(
    this.sessions
      .filter(
        (session) =>
          session.tally.messages !== 0 || this.parked[session.id] !== undefined,
      )
      .toSorted((left, right) => right.startedAt - left.startedAt),
  );

  /**
   * The target's newest session with anything said in it, or `undefined`: the conversation a
   * reload or "Continue that session" comes back to, which the page never calls an earlier
   * one (`readingNote`, U8).
   */
  // V2(chat): V1 takes the newest by when a session was opened (bit's own row), so an older
  // session the operator went back to and carried on is still "earlier" once they leave it
  // and return. V2 could order by last activity once the list carries it.
  newestId = $derived<string | undefined>(
    this.listed.find((session) => session.tally.messages !== 0)?.id,
  );

  /**
   * Opens the page on a target: an empty session to type into, beside the ones the server
   * lists.
   *
   * Replaces everything, including whatever a scenario or an earlier visit left, because the
   * sessions are the target's and a list that kept another visit's local ones would be
   * showing one of them as if the server had it. **Except parked words**, which are this
   * tab's and nowhere else (U8 review 4): read back from the server's store, and a first
   * message's drawn again on a session of its own, ahead of the empty one so that "Start a
   * new session" has to step over it. Words parked on a session the server lists wait for
   * the list to name it.
   */
  begin(indexed: readonly S[], server?: ConversationServer): void {
    const fresh = this.#binding.emptySession(this.#now());
    const parked = server?.parked.read() ?? {};
    const stubs = Object.entries(parked).flatMap(([id, words]) =>
      words.first === undefined
        ? []
        : [
            {
              ...this.#binding.emptySession(words.first.startedAt, id),
              ...pinAgent(words.first.agentId),
            },
          ],
    );
    this.#stopWatching();
    this.#reading.clear();
    this.#readMidTurn.clear();
    this.#activityOf.clear();
    this.#forgetBreakdowns();
    this.#server = server;
    this.abilities = abilitiesOf(server);
    this.draft = "";
    this.files.clear();
    this.notice = "";
    this.refused = false;
    this.sending = false;
    this.stopping = false;
    this.switches = [];
    this.switchNotice = undefined;
    this.switchFailures = [];
    this.waitingForSwitch = false;
    this.#switchedTo.clear();
    this.#movedTo.clear();
    this.becameId = undefined;
    this.stopFailure = undefined;
    this.questionBusy = false;
    this.questionRefusal = undefined;
    this.pickerOpen = false;
    this.#sent = 0;
    this.#opening = undefined;
    this.agents = this.#serverAgents;
    this.parked = parked;
    this.sessions = [...stubs, fresh, ...indexed];
    this.currentId = fresh.id;
  }

  /**
   * The server's agent registry (`GET /agents`), read by the app once per page load. Shown
   * at once when the page is a real target's; kept for the next visit otherwise, so a
   * scenario's mock registry is not replaced under it.
   */
  setServerAgents(view: AgentsView): void {
    this.#serverAgents = view;
    if (this.#server !== undefined) this.agents = view;
  }

  /**
   * Forgets the server's registry, on sign-out: the next sign-in may be to another server,
   * whose agents are its own. A page reached before that server's registry is read names no
   * agent, rather than one this server may not define.
   */
  forgetServerAgents(): void {
    this.#serverAgents = undefined;
    if (this.#server !== undefined) this.agents = undefined;
  }

  /**
   * Picks the agent the empty session's first message opens a conversation as (D7).
   *
   * **Only before that message**: the agent is pinned once a conversation has started, so a
   * session with messages is left as it is, and so is one whose first message is with the
   * server. And only an agent the registry lists: the chip offers nothing else, and the
   * server would refuse an id it does not define.
   */
  pickAgent(agentId: string): void {
    const session = this.current;
    if (session === undefined || session.tally.messages !== 0) return;
    if (this.sending) return;
    if (this.agents?.agents.some((agent) => agent.id === agentId) !== true) {
      return;
    }
    this.#replace(session.id, (before) => ({ ...before, agentId }));
  }

  /**
   * Swaps the server's sessions for a newer reading of them, leaving the page's own alone.
   *
   * What the operator is looking at stays where it is: an indexed session that is still
   * listed keeps its place, and so does the empty one they are typing into. Only an open
   * session the server no longer lists falls back to the empty one, since there is nothing
   * left to show for it.
   *
   * **"Untouched" is "has nothing of the operator's in it", not "was indexed".** An indexed
   * session the operator has typed into is indexed *and* holds their words, which exist
   * nowhere else: replacing it with the server's row would hand back a session whose thread
   * is empty. So a touched session keeps its thread (history, items, whether it is being
   * read) and takes the server's *figures* (model, tally, running), which are the part a
   * newer reading is for. One the server no longer lists is kept too, for the same reason.
   */
  syncIndexed(indexed: readonly S[]): void {
    const onScreen = this.current;
    const ranOnScreen =
      onScreen?.working === true ? onScreen.conversationId : undefined;
    const touched = new Map(
      this.sessions
        .filter(
          (session) =>
            session.indexed === true &&
            // Anything of the operator's in it, **or** a replay that has already arrived
            // (S6). Without the second half a re-read would put the `loading` history back
            // over an answer that had come, and the page would ask for it again for ever —
            // and the floor would go with it, so the live tail would double up against the
            // replay that replaced it.
            (session.items.length > 0 || session.loaded === true),
        )
        .map((session) => [session.id, session]),
    );
    const own = this.sessions.filter((session) => session.indexed !== true);
    const refreshed = indexed.map((listed) => {
      const session = this.#withActivity(this.#withSwitchedModel(listed));
      const kept = touched.get(session.id);
      return kept === undefined
        ? session
        : {
            ...session,
            history: kept.history,
            items: kept.items,
            ...(kept.floors === undefined ? {} : { floors: kept.floors }),
            // Which of those rows were sent mid-turn, and so wait for a take (A6 U4): this
            // tab's knowledge of its own rows, as the floors are.
            ...(kept.midTurn === undefined ? {} : { midTurn: kept.midTurn }),
            ...(kept.sentNow === undefined ? {} : { sentNow: kept.sentNow }),
            // And where the harness took them, once seen: the live window slides on.
            ...(kept.taken === undefined ? {} : { taken: kept.taken }),
            ...(kept.historyFloor === undefined
              ? {}
              : { historyFloor: kept.historyFloor }),
            ...(kept.loaded === undefined ? {} : { loaded: kept.loaded }),
            ...(kept.replayMidTurn === undefined
              ? {}
              : { replayMidTurn: kept.replayMidTurn }),
            // What this tab knows the model is set to, while it is still on that model.
            ...(kept.modelOptions !== undefined && kept.model === session.model
              ? { modelOptions: kept.modelOptions }
              : {}),
            reading: kept.reading,
          };
    });
    const unlisted = [...touched.values()].filter(
      (kept) => !indexed.some((session) => session.id === kept.id),
    );
    this.sessions = [...own, ...refreshed, ...unlisted];
    this.#turnsEnded();
    this.#rereadSettled();
    if (!this.sessions.some((session) => session.id === this.currentId)) {
      // Not one holding parked words: landing there without opening it would leave them off
      // the composer.
      this.currentId =
        own.find((session) => this.parked[session.id] === undefined)?.id ??
        refreshed[0]?.id ??
        own[0]?.id ??
        "";
    }
    // `working` is the server's figure here, so a session it says is running — a turn sent
    // from another tab, say — is watched to its end like one sent from this one.
    const current = this.current;
    if (
      (current?.working === true || current?.background === true) &&
      current.conversationId !== undefined &&
      this.#watching !== current.conversationId
    ) {
      this.#watch(current.conversationId);
    }
    // And its words, if this is the first list that named it: `openImporter` can open a
    // session by id before the index has arrived, so the read cannot only hang off `open`.
    if (current !== undefined) void this.#loadHistory(current);
    // And its meter, on the same first list (A6 U9).
    const conversationId = current?.conversationId;
    if (
      conversationId !== undefined &&
      this.contexts[conversationId] === undefined &&
      !this.#readingContext.has(conversationId)
    ) {
      void this.readContext(conversationId);
    }
    // A turn this reading of the list found over, which the turn watch was not there to see
    // end (A6 U9 review): its calls are what fills the window now.
    if (
      ranOnScreen !== undefined &&
      current?.conversationId === ranOnScreen &&
      current.working !== true
    ) {
      void this.readContext(ranOnScreen, false, "turn");
    }
  }

  /**
   * An index row, with what the turn watch last said is running in it, if it has said.
   *
   * **The row's `running: true` is believed and its `false` is not.** The server's activity
   * answer runs whenever the import does (`ScopeImporter.activity`), so a row that says
   * running is a turn the watch will see too; a row that says not running may be a session
   * whose harness opened a turn by itself, which only the watch can see, and which the watch
   * ends when it is over.
   */
  #withActivity(session: S): S {
    const known =
      session.conversationId === undefined
        ? undefined
        : this.#activityOf.get(session.conversationId);
    return known === undefined
      ? session
      : {
          ...session,
          working: session.working || known.running,
          background: known.background,
        };
  }

  /**
   * An index row, with the model this tab switched its import to if the row still names
   * the old one — a reading that left before the switch answered. Once a reading agrees the
   * entry is dropped, and from then on the server's row is the model, whoever changed it.
   */
  #withSwitchedModel(session: S): S {
    const conversationId = session.conversationId;
    if (conversationId === undefined) return session;
    const switched = this.#switchedTo.get(conversationId);
    if (switched === undefined) return session;
    if (switched === session.model) {
      this.#switchedTo.delete(conversationId);
      return session;
    }
    return { ...session, model: switched };
  }

  #replace(id: string, change: (session: S) => S) {
    this.sessions = this.sessions.map((session) =>
      session.id === id ? change(session) : session,
    );
  }

  /** Opens a session from the picker. An older one is read-only until the operator types. */
  // V2(chat): the draft is the page's, so what the operator typed and did not send is
  // dropped when they open another session or start one — including on the way to a "Not
  // sent" row's words (U8 review 3), which are given back but replace what was in the box.
  // V2 keeps a draft per session, which would also make parked words an ordinary draft.
  open(id: string): void {
    this.pickerOpen = false;
    this.becameId = undefined;
    this.switchNotice = undefined;
    this.notice = "";
    this.refused = false;
    const opened = this.sessions.find((session) => session.id === id);
    if (opened !== undefined) {
      // The meter on screen is the new session's: no breakdown read still out is for it.
      this.leaveBreakdown();
      this.currentId = id;
      this.draft = "";
      this.files.clear();
      // A message that did not land while the operator was elsewhere comes back where it was
      // typed, with what is known of it, as if they had stayed (U8 review 3).
      const words = this.parked[id];
      if (words !== undefined) {
        this.draft = words.text;
        this.notice = words.detail;
        this.refused = true;
        this.#unpark(id);
      }
      // Asked what is running in it (A6 U6), not only when the list says it is: a turn the
      // harness opened by itself, or background work, runs under an import the list calls
      // finished. Watched to its end, so its cursor and its Stop follow the server here too
      // rather than only in the tab that sent the message.
      if (opened.conversationId !== undefined && opened.ended !== true) {
        this.#watch(opened.conversationId);
      }
      // Its meter, whatever state it is in: an ended session is measured from its transcript.
      if (opened.conversationId !== undefined) {
        void this.readContext(opened.conversationId);
      }
      void this.#loadHistory(opened);
    }
  }

  /**
   * Reads one session's conversation back from the harness, once (S6).
   *
   * **Once, and that is what keeps a message off the screen twice.** The replay contains
   * every word the harness held when it answered, and the floor it is joined at is taken
   * before the request leaves — so everything this tab mints or receives afterwards is
   * strictly after it. A second read would need the goal chat's `replayedThrough` machinery
   * to cancel this tab's own rows against it, and there is nothing to gain by it: what the
   * importer says after the read arrives live.
   *
   * Does nothing without a server (the state picker's scenarios declare their own history),
   * for a session with no import to address, or for one that has already been read. A read
   * that fails leaves the session alone, `loading`, rather than claiming an answer.
   *
   * **And nothing for a session this tab has anything of its own in**, which is the other
   * half of "no message appears twice" and the half the floor cannot do. The operator's
   * first message comes back in the replay as a `user` entry — the harness stores it, and
   * the server trims its framing off — so a replay installed over a thread that already
   * holds this tab's own `turn.operator` row for the same sentence shows it twice. The goal
   * chat answers that with `replayedThrough` and a counted text match because it re-reads
   * after every opening send; this reads once, before anything has been typed, so the bound
   * is simply "has anything been typed" — checked again when the answer lands, because the
   * operator may have typed during the round trip, and then the answer is **dropped**. A
   * replay that is not shown is a worse screen than one that is; a sentence shown twice is a
   * screen the operator cannot trust.
   */
  async #loadHistory(session: S): Promise<void> {
    const server = this.#server;
    const conversationId = session.conversationId;
    if (
      server === undefined ||
      conversationId === undefined ||
      session.loaded === true ||
      session.items.length > 0 ||
      this.#reading.has(conversationId)
    ) {
      return;
    }
    this.#reading.add(conversationId);
    const midTurn = this.#asking(conversationId, session.id);
    const answered = await server
      .history(conversationId)
      .catch((error: unknown) => {
        this.#reading.delete(conversationId);
        throw error;
      });
    /*
     * Released in the same synchronous step as the install below, not in a `finally` on the
     * request: a `finally` ran a microtask before this resumed, and a list arriving in that
     * gap (`syncIndexed`) found the session neither reading nor loaded, and asked again.
     */
    this.#reading.delete(conversationId);
    if (answered === undefined) return;
    // The page was left or reset meanwhile: nothing here is the answer's to change.
    if (this.#server !== server) return;
    const installed = this.sessions.find((each) => each.id === session.id);
    if (
      installed === undefined ||
      installed.loaded === true ||
      installed.items.length > 0
    ) {
      return;
    }
    // With the messages the server still holds queued in the live session (A6 U4 review):
    // the transcript does not have them until they are taken, and a reload must not lose one.
    this.#replace(session.id, (before) => ({
      ...withReplay(before, answered),
      replayMidTurn: midTurn,
    }));
    this.#installed(conversationId, midTurn);
  }

  /**
   * Records a `turn.taken` item on the session it is about, the first time this tab sees it
   * (A6 U4 review), and reads the replay again if it names a message this tab has no row for.
   *
   * **Recorded, because the live feed slides.** Whether a message is still queued, and where
   * its turn starts, are read off its take; the feed keeps only the newest
   * `App.LIVE_KEPT` items, and a take that fell out of it would have put its message back
   * in the queue. So the take is kept on the session, as the floors are.
   *
   * **Read again, for a message drawn nowhere**: one sent from another tab. The reply to
   * it would otherwise sit in the turn before under no "You". The answer holds it whether or
   * not the harness has written it yet (Claude Code narrates the take before it writes the
   * message), in the transcript or beside it, by id (`withReplay`). Not while this tab has a message with
   * the server, whose take can outrun the answer that mints its row — and is recorded here
   * for when it lands. Called by the app for every new live item.
   */
  noteTaken(item: LiveItem): void {
    const ids = item.messageIds ?? [];
    if (item.kind !== TAKEN_KIND || ids.length === 0) return;
    const session = this.sessions.find(
      (each) =>
        each.conversationId !== undefined &&
        each.conversationId === this.#binding.routeOf(item),
    );
    if (session === undefined) return;
    // Under each message it names: a take of several is one turn (A6 U4 review 3).
    const unseen = ids.filter((id) => session.taken?.[id] === undefined);
    if (unseen.length > 0) {
      this.#replace(session.id, (before) => ({
        ...before,
        taken: {
          ...before.taken,
          ...Object.fromEntries(unseen.map((id) => [id, item] as const)),
        },
      }));
    }
    if (this.sending || !takesUnknownMessage(session, item)) return;
    void this.#rereadHistory(session.id);
  }

  /**
   * Reads one session's conversation again and installs it over what this tab holds
   * (`withReplay`): rows are joined to the answer by message id, and a row with no id is
   * dropped only if this tab held it when it asked (A6 U4 review 2). One read per import at
   * a time, as {@link #loadHistory}'s; a read that fails, lands after the page moved on, or
   * holds no transcript (a harness that could not be read is no reason to wipe the rows
   * this tab already draws) changes nothing.
   */
  async #rereadHistory(sessionId: string): Promise<void> {
    const server = this.#server;
    const session = this.sessions.find((each) => each.id === sessionId);
    const conversationId = session?.conversationId;
    if (
      server === undefined ||
      conversationId === undefined ||
      this.#reading.has(conversationId)
    ) {
      return;
    }
    // The rows this read can be an answer for: those held when it was asked for.
    const held = new Set(session?.items.map((item) => item.id));
    this.#reading.add(conversationId);
    const midTurn = this.#asking(conversationId, sessionId);
    const answered = await server
      .history(conversationId)
      .finally(() => this.#reading.delete(conversationId));
    if (
      answered === undefined ||
      this.#server !== server ||
      answered.view.source !== "harness"
    ) {
      return;
    }
    this.#replace(sessionId, (before) => ({
      ...withReplay(before, answered, held),
      replayMidTurn: midTurn,
    }));
    this.#installed(conversationId, midTurn);
  }

  /**
   * Whether a read of an import's replay is being asked for mid-turn. One asked while the
   * session is idle is the read {@link #readMidTurn} waits for, so it is crossed off here,
   * when asked, and not when the answer lands: an answer that cannot be installed (no
   * transcript) would otherwise leave it to be asked again on every later reading of the list.
   */
  #asking(conversationId: string, sessionId: string): boolean {
    const working =
      this.sessions.find((each) => each.id === sessionId)?.working === true;
    if (!working) this.#readMidTurn.delete(conversationId);
    return working;
  }

  /**
   * Notes that the replay just installed for an import was read mid-turn
   * ({@link #readMidTurn}), and reads it again at once if that turn has settled while the
   * read was out — the turn watch fired then, and found a read already in flight.
   */
  #installed(conversationId: string, midTurn: boolean): void {
    if (!midTurn) return;
    this.#readMidTurn.add(conversationId);
    this.#rereadSettled();
  }

  /**
   * Reads again the replay of every session whose replay was read mid-turn and whose turn
   * has since settled ({@link #readMidTurn}, A6 U5 review 2). Called wherever a session's
   * `working` can go false. Not while this tab has a message with the server: a turn is
   * starting, and its own settling reads it.
   */
  #rereadSettled(): void {
    if (this.sending) return;
    for (const session of this.sessions) {
      const conversationId = session.conversationId;
      if (
        conversationId === undefined ||
        session.working ||
        !this.#readMidTurn.has(conversationId) ||
        this.#reading.has(conversationId)
      ) {
        continue;
      }
      void this.#rereadHistory(session.id);
    }
  }

  /**
   * Watches one import's turn and marks its session idle once the server says it is.
   * One at a time: a later turn, or another session's, replaces the watch.
   */
  #watch(conversationId: string): void {
    const server = this.#server;
    if (server === undefined) return;
    this.#stopWatching();
    /** Whether anything ran while watched: only then does the list need reading again. */
    let busy = this.sessions.some(
      (session) =>
        session.conversationId === conversationId &&
        (session.working || session.background === true),
    );
    const stop = server.watchTurn(conversationId, (activity) => {
      if (this.#unwatch !== stop) return;
      this.#activityOf.set(conversationId, activity);
      const over = !activity.running && !activity.background;
      if (over) {
        this.#unwatch = undefined;
        this.#watching = undefined;
      }
      if (!over) busy = true;
      // Every session filed under the import: a reopen's fresh thread shares its old one's
      // import id until the list is read again.
      const under = this.sessions.filter(
        (session) => session.conversationId === conversationId,
      );
      const wasWorking = under.some((session) => session.working);
      if (
        under.some(
          (session) =>
            session.working !== activity.running ||
            (session.background === true) !== activity.background,
        )
      ) {
        this.sessions = this.sessions.map((session) =>
          session.conversationId === conversationId
            ? {
                ...session,
                working: activity.running,
                background: activity.background,
              }
            : session,
        );
      }
      // A Stop's "is answering it now" is about the turn it left running, and "may still be
      // running" about the background work: each goes with what it describes rather than
      // outliving it. Only if it is still what the line says.
      const said = this.#busyStop;
      if (
        said !== undefined &&
        said.ids.includes(conversationId) &&
        (said.about === "turn" ? !activity.running : !activity.background)
      ) {
        this.#busyStop = undefined;
        if (this.notice === said.text) this.notice = "";
      }
      if (wasWorking && !activity.running) {
        this.#turnsEnded();
        this.#rereadSettled();
        // A turn ended: its calls are what fills the window now (A6 U9).
        void this.readContext(conversationId, false, "turn");
      }
      // What ran wrote what it wrote: the list's tally is the server's to restate.
      if (over && busy) void server.reread();
    });
    this.#unwatch = stop;
    this.#watching = conversationId;
  }

  /**
   * Starts watching the session on screen when the live feed carries its importer's words
   * while this tab thinks nothing is running in it (A6 U6): a turn the harness opened by
   * itself — Claude Code's, on a background task's notification — which no message of this
   * tab's started. The server is asked rather than the item believed: a late frame of a turn
   * already over answers idle, and costs one request. Called by the app for every live item,
   * partials included.
   */
  noteActivity(item: LiveItem): void {
    const session = this.current;
    const conversationId = session?.conversationId;
    if (
      conversationId === undefined ||
      this.#binding.routeOf(item) !== conversationId ||
      item.origin !== "activity" ||
      this.sending ||
      session?.ended === true ||
      session?.working === true ||
      this.#watching === conversationId
    ) {
      return;
    }
    this.#watch(conversationId);
  }

  /**
   * The server's connection to an import's narration came back (U13 review 5,
   * `LiveConnection`): what the importer said while it was down is not sent again, so the
   * session's replay is read again now, and once more when its turn settles — a replay read
   * mid-turn may lack the block still being written ({@link #readMidTurn}). Not now while
   * this tab has a message with the server; its turn's settling reads it.
   */
  noteConnection(frame: LiveConnection): void {
    const conversationId = this.#binding.routeOf(frame);
    if (conversationId === null) return;
    const session = this.sessions.find(
      (each) => each.conversationId === conversationId,
    );
    if (session === undefined) return;
    if (frame.state === "closed") {
      /*
       * The server let the session go (A7-Q, from the chat shell's review 2): an end from
       * another tab or over the API, a shutdown. The list is read again, so the session
       * reads as ended or dormant and the composer says what the next message will do; and
       * so is the replay, so a question it was waiting on reads as no longer answerable here.
       */
      this.#closedPeriods.add(conversationId);
      void this.#server?.reread();
      void this.#rereadHistory(session.id);
      return;
    }
    if (frame.state !== "restored") return;
    this.#readMidTurn.add(conversationId);
    if (this.sending) return;
    void this.#rereadHistory(session.id);
  }

  /**
   * Reads the list and the window again when a live call frame names a model this tab does
   * not have the session on (A6 U9 review 4): another client switched it, and the chip and
   * the meter's window are still the old model's. Not for a late frame of the call that was
   * running when a switch landed, which is on the model the reading's figure was measured on,
   * nor while this tab's own switch of it is out. Once per import and model, so the frames of
   * one call ask once. Called by the app for every usage frame.
   */
  // V2(chat): V1 learns of another client's switch from the first call on the new model,
  // so the chip is stale until then (a switch made while the session idles shows only at its
  // next call or reload). V2 should put a model switch on the live feed for every tab.
  noteUsage(frame: LiveUsage): void {
    const conversationId = this.#binding.routeOf(frame);
    const model = frame.model;
    const server = this.#server;
    if (
      server === undefined ||
      conversationId === null ||
      model === null ||
      model === ""
    ) {
      return;
    }
    const session = this.sessions.find(
      (each) => each.conversationId === conversationId,
    );
    if (session === undefined || sameModel(model, session.model)) return;
    if (sameModel(model, this.contexts[conversationId]?.reading.usedModel))
      return;
    if (this.switches.some((each) => each.conversationId === conversationId))
      return;
    if (sameModel(model, this.#movedTo.get(conversationId))) return;
    this.#movedTo.set(conversationId, model);
    void server.reread();
    void this.readContext(conversationId, false, "switch");
  }

  #stopWatching(): void {
    this.#unwatch?.();
    this.#unwatch = undefined;
    this.#watching = undefined;
  }

  /**
   * Starts an empty session on the same target.
   *
   * Reuses the empty one the operator is already looking at rather than stacking a second:
   * two blank threads are one choice, not two. **Never the one whose first message is with
   * the server** ({@link #opening}): that is a conversation being opened, and the server's
   * answer would carry the operator into it. From it, this opens a fresh one beside it.
   */
  start(options: { readonly keepDraft?: boolean } = {}): void {
    const opening = this.#opening;
    this.pickerOpen = false;
    this.becameId = undefined;
    // The words of the message on its way are that message's, not a draft for the next
    // session, which would then hold a copy of what was just sent. A refusal gives them
    // back ({@link #undelivered}).
    if (
      options.keepDraft !== true ||
      (opening !== undefined && this.draft.trim() === opening.text)
    ) {
      this.draft = "";
      this.files.clear();
    }
    this.notice = "";
    this.refused = false;
    this.switchNotice = undefined;
    const empty = (session: S): boolean =>
      session.indexed !== true &&
      session.tally.messages === 0 &&
      this.parked[session.id] === undefined &&
      session.id !== opening?.sessionId;
    if (
      this.current?.tally.messages === 0 &&
      this.current.id !== opening?.sessionId
    ) {
      return;
    }
    // An empty one left behind by opening another session — then Back to `/assets/chat`
    // (U8) — is the same choice again, not a second blank thread.
    const left = this.sessions.find(empty);
    if (left !== undefined) {
      this.leaveBreakdown();
      this.currentId = left.id;
      return;
    }
    this.#sent += 1;
    const fresh = this.#binding.emptySession(
      this.#now(),
      `ses_new_${String(this.#sent)}`,
    );
    this.sessions = [...this.sessions, fresh];
    this.currentId = fresh.id;
  }

  /**
   * Sends the draft into the session on screen, resuming it if it was only being read.
   *
   * `urgency` is how a message sent while a turn runs lands (A6 U6): `queued`, the default
   * and what Enter sends, waits for the work in flight; `preemptive` — D3's "Send now" —
   * lands at the harness's next step, and the rest of the work in flight is dropped. To a
   * session with nothing running the two are the same.
   */
  send(urgency: SteerUrgency = "queued"): void {
    const text = this.draft.trim();
    const session = this.current;
    if (session === undefined) return;
    // Files with no words are not sent (A6 U13): what the agent is to do with them is the
    // message. Said in the dialog, and the files stay attached.
    if (text === "" && this.files.items.length > 0) {
      this.files.refuse(FILES_WITHOUT_WORDS);
      return;
    }
    if (text === "") return;
    // A session on a harness this server does not run is not asked, and not typed into:
    // the harness it does have would answer "no such session" for one that may be alive
    // elsewhere. The composer is disabled too; this is the rule, that is its face.
    if (session.strandedOn !== undefined) return;
    // The operator ended it; the server would refuse, and the composer says so instead.
    if (session.ended === true) return;
    // Over the limit the server takes (U8 review 5): refused here, with both figures, and
    // the words stay in the box. Sent, the typed client would refuse to encode it; before
    // this, that read as "No server answered", so the page said it might have been sent.
    if (text.length > CONVERSATION_MESSAGE_MAX_CHARS) {
      this.notice = messageTooLong(text.length);
      this.refused = true;
      return;
    }
    if (this.#server !== undefined) {
      void this.#post(this.#server, session, text, urgency);
      return;
    }
    // The state picker has no server to store files on: they are dropped with the send.
    this.files.clear();
    const at = this.#now();
    const standIn = this.#binding.standIn;
    /** How many this tab's feed already holds: the id's namespace, not the turn's number. */
    const index = session.items.filter(
      (item) => item.kind === "turn.operator",
    ).length;
    this.draft = "";
    if (this.switchNotice?.sessionId === session.id) {
      this.switchNotice = undefined;
    }
    this.#replace(session.id, (before) => ({
      ...before,
      reading: false,
      working: false,
      // Pinned with the first message: the one picked, or the registry's default.
      ...pinAgent(before.agentId ?? this.agents?.defaultAgentId),
      items: [
        ...before.items,
        operatorTurn({ index: index + 1, text, at, after: 0 }),
        ...(standIn === undefined
          ? []
          : [
              {
                _tag: "item" as const,
                id: `activity:stand-in-${String(index + 1)}`,
                origin: "activity" as const,
                sequence: null,
                kind: "turn.reply",
                at: at + 400,
                attemptId: null,
                roundId: null,
                goalId: null,
                importId: null,
                headline: standIn.headline,
                body: standIn.body,
                tool: null,
                toolName: null,
                input: null,
                output: null,
                callId: null,
                outcome: null,
              },
            ]),
      ],
      // Once anything is said the thread is no longer the empty one, and its message count is
      // unknown like every other session's: a stand-in exchange is not a reason to start
      // printing one.
      tally: { ...before.tally, messages: null },
    }));
  }

  /**
   * Posts one message and puts the answer where it belongs. See this module's header.
   *
   * The session is captured at submit: an operator who switches sessions while the request
   * is in flight still has the turn land on the one they wrote it in.
   */
  async #post(
    server: ConversationServer,
    session: S,
    text: string,
    urgency: SteerUrgency,
    /**
     * `files: false` sends none of the composer's files. `dock`: the question dock's
     * message, whose words are the dock's and not the box's, so a refusal of it on the
     * session on screen is the caller's to say and nothing goes into the box.
     */
    options: { readonly files: boolean; readonly dock?: boolean } = {
      files: true,
    },
  ): Promise<PostOutcome | undefined> {
    if (this.sending) return undefined;
    this.sending = true;
    this.notice = "";
    this.refused = false;
    // Behind a switch of this very import, the server holds the message until the switch
    // has answered: say so, since that can be a minute and a half.
    this.waitingForSwitch =
      session.conversationId !== undefined &&
      this.switches.some(
        (each) => each.conversationId === session.conversationId,
      );
    // The switch confirmation on screen as the message leaves, which an accepted message
    // makes stale: "your next message runs on it" has been. One that a switch answering
    // meanwhile puts up is about this message's successor, and stays.
    const noticeBefore = this.switchNotice;
    // Taken before the message goes, so whatever the importer says in answer sorts after
    // it — including what it says before this request has been answered.
    const after = server.highWater();
    // The files go in the same request; the ones sent are taken out of the composer only
    // once the server has them, so a refusal leaves them attached beside the words.
    const sending = options.files ? this.files.items : [];
    const files = sending.map((item) => item.file);
    // The agent the chip picked goes with an opening message only: a later one is to a
    // conversation already pinned to its agent, which the server reads off the row.
    const agentId = session.agentId;
    const opening =
      session.conversationId === undefined
        ? { sessionId: session.id, text }
        : undefined;
    if (opening !== undefined) this.#opening = opening;
    // What a message whose answer is lost is checked against ({@link #confirm}): the
    // sessions the list held, when it left, and — for a reply — the message ids this thread
    // already holds these words under. Only a copy the server stamped after this moment
    // counts (U8 review 6), so a thread whose replay never arrived is looked for too: an
    // earlier copy in the real replay is older than this, whatever the thread holds.
    const known = new Set(this.sessions.map((each) => each.id));
    const baseline: ConfirmBaseline = {
      ids:
        session.conversationId === undefined
          ? new Set()
          : idsSaid(session, text),
      sentAt: this.#now(),
    };
    const answer =
      session.conversationId === undefined
        ? await server.open(text, agentId, files)
        : await server.send(session.conversationId, text, urgency, files);
    const pinnedAgent = agentId ?? this.agents?.defaultAgentId;
    if (opening !== undefined && this.#opening === opening) {
      this.#opening = undefined;
    }
    this.sending = false;
    this.waitingForSwitch = false;
    // The page was left or reset meanwhile: nothing here is the answer's to change.
    if (this.#server !== server) return undefined;
    if (
      answer._tag === "refused" &&
      answer.files === true &&
      this.currentId === session.id
    ) {
      // About the files: said in the dialog, and the words and files stay as they were.
      this.files.refuse({ title: "Message not sent", sentence: answer.detail });
      return { _tag: "refused", detail: answer.detail };
    }
    if (
      answer._tag !== "accepted" &&
      options.dock === true &&
      this.currentId === session.id
    ) {
      // The dock's words are still in the dock, which says so (`sendAnswersAsMessage`).
      if (answer._tag === "refused" && answer.ended === true) {
        void server.reread();
      }
      return answer._tag === "refused"
        ? { _tag: "refused", detail: answer.detail }
        : { _tag: "unanswered", detail: unansweredDetail(false) };
    }
    if (answer._tag !== "accepted") {
      const outcome = answer._tag === "refused" ? "refused" : "unknown";
      const detail =
        answer._tag === "refused"
          ? answer.detail
          : unansweredDetail(session.conversationId === undefined);
      // Still on it: the words are still in the box, under what is known of them.
      const heldOn =
        this.currentId === session.id
          ? this.#refusedHere(detail)
          : this.#undelivered(session, text, detail, outcome);
      if (answer._tag === "refused" && answer.ended === true) {
        void server.reread();
      }
      /*
       * V2(chat): finding out whether a message with no answer arrived is a text match
       * against the replay ({@link #confirm}): a copy of the same words, under an id this
       * thread does not hold, that the server stamped after this message left — less
       * {@link CONFIRM_CLOCK_SLACK}, since this tab only estimates the server's clock. It can
       * be fooled: another tab or device sending the very same words to this session within
       * the confirm window (that slack before this send, up to the last of
       * {@link CONFIRM_DELAYS} after it) reads as this message having arrived, and a copy
       * another tab queued earlier that the harness takes into its transcript before the
       * first read is stamped with the take, not the send. It can also give up too early
       * and leave a delivered message "Not confirmed" (the harness wrote it after the last
       * read), or miss one the harness stored merged with other steers under one entry.
       * V2 replaces the matching with **idempotency keys**: the client mints a
       * `clientMessageId` with each message, the server records it beside the outcome, and
       * on a lost answer the client asks "did you get X?" or sends again under the same id,
       * which the server answers rather than delivering twice — no text, no clocks, no
       * timing loop. With it, **write-ahead parking**: the words are parked (with that id)
       * before the request leaves, not after its answer. Deferred until then: a refused
       * first message whose refusal lands once the operator has left the importer page
       * loses its words (`#server !== server` above drops the answer, and nothing was
       * parked); a message whose answer comes after the tab closed is lost; words parked
       * on a session the server stops listing stay invisible (only listed sessions and the
       * page's own unsent ones are drawn); and a "Not confirmed" entry restored from
       * `sessionStorage` is never looked for again — the confirmation runs only in the page
       * that sent it.
       */
      if (answer._tag === "unanswered") {
        void this.#confirm(server, session, text, heldOn, known, baseline);
      }
      return { _tag: answer._tag, detail };
    }
    const turn = answer.turn;
    /*
     * The draft and the notice are the page's, so they are this answer's only while the
     * operator is still on the session it was sent from, or on the one it became (U8 review
     * 3). Elsewhere the draft is someone else's words and the notice ("A new importer
     * session was opened for this message…") would be about a message that thread never had.
     */
    const here =
      this.currentId === session.id || this.currentId === turn.harnessSessionId;
    if (here) {
      if (this.draft.trim() === text) this.draft = "";
      this.files.drop(sending.map((item) => item.id));
      this.notice = turn.notice;
    }
    if (
      noticeBefore !== undefined &&
      this.switchNotice === noticeBefore &&
      noticeBefore.sessionId === session.id
    ) {
      this.switchNotice = undefined;
    }
    /*
     * The server's time for the message, not this tab's: the turn footer's duration runs
     * from here to the importer's last item, which the server stamped, so both ends are one
     * clock (A6 U4). It is also the "You · 18:02" under the bubble.
     */
    const at = turn.acceptedAt;
    // Delivered as a steer while a turn ran: queued until the harness takes it (A6 U4).
    const midTurn = turn.messageId !== undefined && session.working;
    const landed = (given: S): S => {
      // Carried on under a new period (a reopen after the session's process died): the
      // old period's lost messages went with its queue (slice 3 fix 2, L1).
      const before =
        given.conversationId !== undefined &&
        given.conversationId !== turn.conversationId
          ? withoutLost(given)
          : given;
      // Past every `operator:<n>` the session holds, rather than a count of them: a replay
      // read again replaces rows (`withReplay`), and a count could then mint an id one of
      // the rows it kept already has.
      const index = Math.max(
        0,
        ...before.items.map((item) =>
          Number(/^operator:(\d+)$/u.exec(item.id)?.[1] ?? 0),
        ),
      );
      const row = {
        ...operatorTurn({
          index: index + 1,
          text,
          at,
          after,
          ...(turn.attachments === undefined
            ? {}
            : { attachments: turn.attachments }),
        }),
        ...(turn.messageId === undefined
          ? {}
          : { messageIds: [turn.messageId] }),
      };
      return {
        ...before,
        ...(midTurn ? { midTurn: [...(before.midTurn ?? []), row.id] } : {}),
        ...(midTurn && urgency === "preemptive" && turn.messageId !== undefined
          ? { sentNow: [...(before.sentNow ?? []), turn.messageId] }
          : {}),
        id: turn.harnessSessionId,
        conversationId: turn.conversationId,
        model: turn.model,
        harness: server.harnessName(turn.harnessInstanceId),
        harnessInstanceId: turn.harnessInstanceId,
        indexed: true,
        reading: false,
        working: true,
        items: [...before.items, row],
        floors: { ...before.floors, [row.id]: after },
        tally: { ...before.tally, messages: null },
        // Until the list is read again and says so itself, the agent the message was sent
        // as. A session that had one keeps it: a reopen runs as the row's agent.
        ...pinAgent(before.agentId ?? pinnedAgent),
        // An opening message's options are what the new session's model is set to.
        ...(answer.modelOptions === undefined
          ? {}
          : { modelOptions: answer.modelOptions }),
      };
    };
    const stillThere = this.sessions.some((each) => each.id === session.id);
    if (turn.harnessSessionId === session.id || session.indexed !== true) {
      // The same session, or the page's own empty one becoming the session the server
      // opened for it: one thread, under the server's id from here on.
      const before =
        this.sessions.find((each) => each.id === session.id) ?? session;
      const next = landed(before);
      this.sessions = stillThere
        ? this.sessions.map((each) => (each.id === session.id ? next : each))
        : [...this.sessions, next];
      if (this.currentId === session.id) {
        this.currentId = next.id;
        if (session.indexed !== true) this.becameId = next.id;
      }
    } else {
      // A fresh session opened in place of one the server no longer held: a new thread,
      // and the old one stays in the list as what it was.
      const fresh = landed({
        ...session,
        startedAt: at,
        history: NO_HISTORY,
        items: [],
        floors: {},
        tally: {
          ...this.#binding.emptySession(at).tally,
          messages: null,
        },
      });
      this.sessions = [...this.sessions, fresh];
      if (this.currentId === session.id) this.currentId = fresh.id;
    }
    // Running until the watch says otherwise: a reading of the list in between must not
    // put back an older answer about this import.
    this.#activityOf.set(turn.conversationId, {
      running: true,
      background:
        this.#activityOf.get(turn.conversationId)?.background ?? false,
    });
    this.#watch(turn.conversationId);
    void server.reread();
    return { _tag: "accepted" };
  }

  /** Says why the message on screen did not land; its words are still in the box. */
  #refusedHere(detail: string): WordsHeld {
    this.notice = detail;
    this.refused = true;
    return { in: "box", sessionId: this.currentId, notice: detail };
  }

  /**
   * Puts the words of a message that did not land somewhere the operator will find them,
   * when they had left the session it was sent from before the answer came (U8 review 3).
   *
   * **The words exist nowhere else.** Starting or opening a session clears the draft — the
   * words on their way were that message's — and nothing is left on the session they were
   * sent from, which, for a first message, is an empty one the picker does not list.
   *
   * **Back into the box only for a first message, and only into the page's empty session**
   * (U8 review 4), with nothing typed in it: the operator was about to start a conversation,
   * and now has this one to send or drop — and sending it opens one, as it would have. A
   * reply to a conversation is that conversation's, so it never goes into another one's
   * box. Otherwise the words are {@link parked} on the session they were sent from, which
   * the list marks and which gives them back when opened, and the page names it. The notice
   * on screen is never the refusal itself: it would read as being about a draft it is not.
   */
  #undelivered(
    session: S,
    text: string,
    detail: string,
    outcome: ParkedMessage["outcome"],
  ): WordsHeld {
    const first = session.conversationId === undefined;
    const on = this.current;
    const unknown = outcome === "unknown";
    if (
      first &&
      on !== undefined &&
      on.indexed !== true &&
      on.tally.messages === 0 &&
      this.parked[on.id] === undefined &&
      this.draft.trim() === ""
    ) {
      this.draft = text;
      this.notice = unknown
        ? `No server answered your last message, so whether it was sent is not known. Its words are back in the box: sending them opens a session here, which may be a second one for the same message.`
        : `Your last message was not sent: ${detail} Its words are back in the box, and sending them opens a session here.`;
      this.refused = true;
      return { in: "box", sessionId: on.id, notice: this.notice };
    }
    // A first message's session is the page's own: drawn again under an id of its own, so
    // that the next visit's empty session (always `ses_new`) is never mistaken for it.
    const id = first ? this.#parkedId(session.startedAt) : session.id;
    const words: ParkedMessage = {
      text,
      detail,
      outcome,
      ...(first
        ? {
            first: {
              startedAt: session.startedAt,
              ...(session.agentId === undefined
                ? {}
                : { agentId: session.agentId }),
            },
          }
        : {}),
    };
    if (first) {
      this.sessions = [
        ...this.sessions.filter((each) => each.id !== session.id),
        { ...session, id },
      ];
    }
    this.#setParked({ ...this.parked, [id]: words });
    const mark = `“${parkedMark(words)}”`;
    const where = first
      ? `as ${mark} in the session list`
      : `on ${named(session, this.#now())}, marked ${mark} in the session list`;
    this.notice = unknown
      ? `No server answered your last message, so whether it was sent is not known. Its words are kept in this tab ${where}.`
      : `Your last message was not sent. Its words are kept in this tab ${where}: open it to see why.`;
    this.refused = false;
    return { in: "parked", sessionId: id, notice: this.notice };
  }

  /** An id for a first message's parked session that no session and no parked words have. */
  #parkedId(startedAt: number): string {
    for (let n = 0; ; n += 1) {
      const id = `ses_unsent_${String(startedAt)}${n === 0 ? "" : `_${String(n)}`}`;
      if (
        this.parked[id] === undefined &&
        !this.sessions.some((each) => each.id === id)
      ) {
        return id;
      }
    }
  }

  #setParked(parked: ParkedMessages): void {
    this.parked = parked;
    this.#server?.parked.write(parked);
  }

  /** Forgets one session's parked words: given back, or found delivered after all. */
  #unpark(id: string): void {
    if (this.parked[id] === undefined) return;
    this.#setParked(
      Object.fromEntries(
        Object.entries(this.parked).filter(([key]) => key !== id),
      ),
    );
  }

  /**
   * Finds out whether a message whose answer was lost reached the server after all (U8
   * review 4), by reading the list and the replays again: **a first message** reached it if
   * a session the list did not hold before it was sent now holds its words; **a later one**
   * if its session's conversation now holds a copy the server stamped after it left, under
   * an id the thread did not already hold ({@link ConfirmBaseline}).
   * Both are read a few times ({@link CONFIRM_DELAYS}) — the list too, each time, since a
   * read of it can fail (U8 review 5) — while the page still holds its copy.
   *
   * Found, the copy the page kept goes — the parked words, or the words in the box while the
   * operator is still where they were put — and the real session is shown: moved to, when
   * the operator was on the one the words were in, otherwise named in the notice it replaces.
   * Not found, or not answered, nothing changes: the message stays "Not confirmed", and the
   * page goes on saying that sending it again may send it twice.
   */
  async #confirm(
    server: ConversationServer,
    session: S,
    text: string,
    held: WordsHeld,
    known: ReadonlySet<string>,
    baseline: ConfirmBaseline,
  ): Promise<void> {
    /** Whether the page still holds its copy of the words: parked, or in the box. */
    const copied = (): boolean =>
      this.parked[held.sessionId]?.text === text ||
      (this.currentId === held.sessionId && this.draft.trim() === text);
    /** Copies of the words another tab sent before this one, met in an earlier read. */
    const foreign = new Set<string>();
    let found: S | undefined;
    for (const delay of CONFIRM_DELAYS) {
      if (delay > 0) await server.wait(delay);
      if (this.#server !== server || !copied()) return;
      // The list on every try, not once (U8 review 5): a read that fails keeps the list as
      // it was, and a first message's session is found only in a list that names it.
      await server.reread();
      if (this.#server !== server || !copied()) return;
      found = await this.#holding(
        server,
        session,
        text,
        known,
        baseline,
        foreign,
      );
      if (this.#server !== server) return;
      if (found !== undefined) break;
    }
    if (found === undefined) return;
    const parked = this.parked[held.sessionId];
    if (held.in === "parked" && parked?.text === text)
      this.#unpark(held.sessionId);
    const name = named(found, this.#now());
    if (this.currentId === held.sessionId && this.draft.trim() === text) {
      // The words are in the box on screen: the real session takes their place.
      this.draft = "";
      if (found.id !== this.currentId) {
        this.open(found.id);
        // The page's empty session became it, as an accepted answer would have made it.
        if (session.conversationId === undefined) this.becameId = found.id;
      } else {
        void this.#rereadHistory(found.id);
      }
      this.notice =
        session.conversationId === undefined
          ? "No answer came back, but the server did open a session for that message: this is it."
          : "No answer came back, but that message did reach this session: it is in the thread.";
      this.refused = false;
      return;
    }
    if (this.notice === held.notice) {
      this.notice = `Your last message did reach the server after all: it is on ${name} in the session list.`;
      this.refused = false;
    }
  }

  /**
   * The session that holds a message whose answer was lost, if one does yet ({@link
   * #confirm}): for a first message, one the list did not hold when it was sent; for a later
   * one, its own session — by its harness session, which a resume keeps under a new import.
   * Either is it if its replay holds a copy of the words that is this message's.
   *
   * **A copy counts only if the server stamped it after this message left** (U8 review 6):
   * a queued one by when the server accepted it (`acceptedAt`), one in the transcript by
   * its `turn.operator` item's `at` — on both harnesses that is the server machine's clock,
   * the CLI's transcript entry or OpenCode's message time. Anything older is an earlier
   * message, whichever tab or device sent it and whether the thread on screen ever saw it,
   * so no count of what the thread held is needed. Nor a copy under an id the thread already
   * holds (`baseline.ids`): that one is an earlier message of this tab's. "After" is on the
   * server's clock, which each answer gives (`at`): the send's time is moved onto it by how
   * far that clock is from this tab's, read from the same answer, less {@link
   * CONFIRM_CLOCK_SLACK}. A copy seen queued from before then is another tab's, and its id
   * goes into `foreign`, so it is still not counted once the harness takes it into the
   * transcript and stamps it with the take.
   *
   * **A message over the field cap is compared as the server shortened it** (U8 review 6):
   * the replay and the queue carry an operator's words cut at `NARRATION_FIELD_MAX` with the
   * contracts' mark ({@link truncateNarration}), never the whole.
   */
  async #holding(
    server: ConversationServer,
    session: S,
    text: string,
    known: ReadonlySet<string>,
    baseline: ConfirmBaseline,
    foreign: Set<string>,
  ): Promise<S | undefined> {
    const first = session.conversationId === undefined;
    // As the server holds the words: cut, and marked, past the field cap.
    const replayed = truncateNarration(text);
    const candidates = this.sessions.filter((each) =>
      first
        ? each.indexed === true &&
          each.conversationId !== undefined &&
          !known.has(each.id)
        : each.id === session.id,
    );
    for (const each of candidates) {
      if (each.conversationId === undefined) continue;
      const answered = await server.history(each.conversationId);
      if (answered === undefined) continue;
      const view = answered.view;
      const sentOnServer =
        baseline.sentAt + (view.at - this.#now()) - CONFIRM_CLOCK_SLACK;
      const same = (words: string | null | undefined): boolean =>
        words?.trim() === replayed;
      const theirs = (id: string): boolean =>
        baseline.ids.has(id) || foreign.has(id);
      for (const message of view.queued) {
        if (
          same(message.text) &&
          !baseline.ids.has(message.messageId) &&
          message.acceptedAt < sentOnServer
        ) {
          foreign.add(message.messageId);
        }
      }
      const arrived =
        view.items.some(
          (item) =>
            item.kind === "turn.operator" &&
            same(item.body) &&
            item.at >= sentOnServer &&
            !(item.messageIds ?? []).some(theirs),
        ) ||
        // A queued copy accepted before then is already in `foreign`, just above.
        view.queued.some(
          (message) => same(message.text) && !theirs(message.messageId),
        );
      if (arrived) return each;
    }
    return undefined;
  }

  /**
   * Stops the importer mid-turn, and keeps the conversation (A6 F5).
   *
   * **With a server, the harness is really interrupted**, and the session's working state
   * follows the server's answer rather than the button: it clears when the server says the
   * turn is over (or that nothing was running), and stays when the server says the
   * conversation is still busy — on Claude Code, a message queued behind the stopped turn
   * runs at once. The turn watch is left running either way, so the list is re-read when
   * the import settles. The server's sentence goes in {@link notice}; a refusal goes to the
   * error dialog ({@link stopFailure}), since it is about the turn and not the draft.
   *
   * Without one — the state picker's scenarios — there is nothing to interrupt, and the
   * prototype shows the stopped state: whatever it had not finished stays visibly
   * unfinished.
   */
  async stop(all = false): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    const server = this.#server;
    const conversationId = session.conversationId;
    if (server === undefined || conversationId === undefined) {
      this.#replace(session.id, (before) => ({
        ...before,
        working: false,
        background: false,
      }));
      this.#turnsEnded();
      return;
    }
    // An owner without Stop all cannot stop all: nothing falls back to a plain Stop.
    if (all && server.stopAll === undefined) return;
    if (this.stopping) return;
    this.stopping = true;
    // Stop all (A7-S, E7): the session's sub-agents first, then the turn, in one request.
    const answer = await (all && server.stopAll !== undefined
      ? server.stopAll(conversationId)
      : server.stop(conversationId));
    this.stopping = false;
    // The page was left or reset meanwhile: nothing here is the answer's to change.
    if (this.#server !== server) return;
    if (answer._tag === "refused") {
      this.stopFailure = {
        title: all ? "Not everything was stopped" : "Turn not stopped",
        sentence: answer.detail,
      };
      return;
    }
    const stopped = answer.stopped;
    this.notice = stopped.detail;
    this.refused = false;
    /*
     * What the Stop reached. Background work stopped with no turn running leaves the turn
     * as it was — none — and what may still be running is the background work, which the
     * turn watch goes on asking about (A6 U6). Otherwise the turn is what is still running,
     * or is over.
     */
    const background = stopped.outcome === "background_stopped";
    this.#busyStop = stopped.working
      ? {
          ids: [conversationId, stopped.conversationId],
          text: stopped.detail,
          about: background ? "background" : "turn",
        }
      : undefined;
    if (stopped.working) return;
    /*
     * A turn's Stop stops the background work beside it too, and the answer says whether
     * any still runs (`ConversationStopped.background`, A6 U6 review): cleared here, at the
     * answer, or the pill would turn into "Stop background work" for the moment until the
     * turn watch's next read said the same.
     */
    const backgroundOver = background || !stopped.background;
    for (const id of [conversationId, stopped.conversationId]) {
      const known = this.#activityOf.get(id);
      if (known === undefined) continue;
      this.#activityOf.set(id, {
        running: background ? known.running : false,
        background: backgroundOver ? false : known.background,
      });
    }
    this.sessions = this.sessions.map((each) =>
      each.conversationId === conversationId ||
      each.conversationId === stopped.conversationId
        ? {
            ...each,
            working: background ? each.working : false,
            background: backgroundOver ? false : each.background === true,
          }
        : each,
    );
    this.#turnsEnded();
    this.#rereadSettled();
    // What the stopped turn left in the window (A6 U9 review): the turn watch does not see
    // this turn end, since the session already reads as idle when it next answers.
    void this.readContext(conversationId, false, "stop");
  }

  /**
   * The sub-agents whose Stop is with the server (A7-S), by call id: their card's Stop reads
   * "Stopping…" and is not pressed again until the answer.
   */
  subagentStopping = $state<readonly string[]>([]);

  /**
   * Stops one sub-agent of the session on screen (A7-S, E7). The card follows the server's
   * narration rather than the button: it ends when the harness says the sub-agent stopped.
   * A refusal — it runs inside the turn, it has ended, the harness did not answer — goes to
   * the error dialog with the server's sentence, as a turn's Stop does.
   */
  async stopSubagent(callId: string): Promise<void> {
    const session = this.current;
    const server = this.#server;
    const conversationId = session?.conversationId;
    if (server?.stopSubagent === undefined || conversationId === undefined)
      return;
    if (this.subagentStopping.includes(callId)) return;
    this.subagentStopping = [...this.subagentStopping, callId];
    const answer = await server.stopSubagent(conversationId, callId);
    this.subagentStopping = this.subagentStopping.filter((id) => id !== callId);
    if (this.#server !== server) return;
    if (answer._tag === "refused") {
      this.stopFailure = {
        title: "Sub-agent not stopped",
        sentence: answer.detail,
      };
      return;
    }
    this.notice = answer.detail;
  }

  /** The switch of one session that is with the server, if there is one. */
  switchingOf(sessionId: string | undefined): ModelSwitchInFlight | undefined {
    return this.switches.find((each) => each.sessionId === sessionId);
  }

  /**
   * Rewords a switch confirmation that was about a running turn once its session is idle:
   * the turn it described has ended, so the step it named "is on now" no longer is. Called
   * wherever a session's `working` can go false — a watched turn ending, a Stop, a reading
   * of the list — and once only: the reworded line has nothing left to change to, so a
   * later turn (from another tab, say) does not bring the present tense back.
   */
  #turnsEnded(): void {
    const notice = this.switchNotice;
    if (notice?.onceIdle === undefined) return;
    const session = this.sessions.find((each) => each.id === notice.sessionId);
    if (session?.working === true) return;
    this.switchNotice = { sessionId: notice.sessionId, text: notice.onceIdle };
  }

  /**
   * Moves the session on screen onto another model of its harness, or other options of its
   * model (A6 F4, D6), and answers whether it moved.
   *
   * **Only a started session, and only within its harness**: the caller offers nothing
   * else, and another harness is a new session ({@link start}). The chip follows the
   * server's answer, never the pick: the session's model changes when the server says the
   * switch was accepted, and a refusal leaves it as it was and opens the error dialog with
   * the server's sentence — the switch already in flight, a harness that did not clearly
   * answer, a model its catalogue does not list, a record that could not be written.
   *
   * Without a server — the state picker's scenarios — there is nothing to ask, so the pick
   * is applied here and the line under the composer says that is all it was.
   */
  async switchModel(
    model: string,
    modelOptions: readonly ModelOptionSelection[] | undefined,
  ): Promise<boolean> {
    const session = this.current;
    if (session === undefined || session.tally.messages === 0) return false;
    if (this.switchingOf(session.id) !== undefined) return false;
    const server = this.#server;
    if (server === undefined) {
      this.#replace(session.id, (before) => ({
        ...before,
        model,
        modelOptions: modelOptions ?? [],
      }));
      this.switchNotice = {
        sessionId: session.id,
        text: `Now on ${model} here only: the state picker has no server to ask.`,
      };
      return true;
    }
    const conversationId = session.conversationId;
    if (conversationId === undefined || server.switchModel === undefined)
      return false;
    const inFlight: ModelSwitchInFlight = {
      sessionId: session.id,
      conversationId: conversationId,
      model,
    };
    this.switches = [...this.switches, inFlight];
    if (this.switchNotice?.sessionId === session.id) {
      this.switchNotice = undefined;
    }
    const answer = await server.switchModel(conversationId, {
      model,
      ...(modelOptions === undefined ? {} : { modelOptions }),
    });
    this.switches = this.switches.filter((each) => each !== inFlight);
    // The page was left or reset meanwhile: nothing here is the answer's to draw. But the
    // page may be the same target's again (Back, then return), listed from a reading that
    // left before the server had moved the record, so its chip would stay on the model this
    // switch left. Read the list again on the page's server, which now holds the answer:
    // the chip follows the server's row, and no notice or dialog is put up.
    if (this.#server !== server) {
      void this.#server?.reread();
      return false;
    }
    if (answer._tag === "refused") {
      // Kept with the session it refused, which is not necessarily the one on screen now.
      this.switchFailures = [
        ...this.switchFailures.filter((each) => each.sessionId !== session.id),
        {
          sessionId: session.id,
          notice: {
            title: "Model not switched",
            sentence: sentenceCase(answer.detail),
          },
        },
      ];
      // The record may have moved under this tab — another switch was in flight, or one the
      // harness answered uncertainly — so the chip is the server's row again, not this tab's.
      void server.reread();
      return false;
    }
    const switched = answer.switched;
    const now = this.sessions.find((each) => each.id === session.id) ?? session;
    // Put up only over the session it is about: the line is the session on screen's, and
    // opening another clears it anyway, so an answer for a session left meanwhile would
    // only take the place of that one's own.
    if (this.currentId === session.id) {
      const said = { switched, previous: now.model, working: now.working };
      this.switchNotice = {
        sessionId: session.id,
        text: switchedNotice({ ...said, agent: this.#binding.agent }),
        ...(now.working
          ? {
              onceIdle: switchedNotice({
                ...said,
                agent: this.#binding.agent,
                turnEnded: true,
              }),
            }
          : {}),
      };
    }
    this.#switchedTo.set(switched.conversationId, switched.model);
    // The window is the new model's (A6 U9); the figure stays the last call's until the
    // next, and the server labels it with the model that made that call.
    void this.readContext(switched.conversationId, false, "switch");
    this.sessions = this.sessions.map((each) =>
      each.id === session.id ||
      each.conversationId === conversationId ||
      each.conversationId === switched.conversationId
        ? {
            ...each,
            model: switched.model,
            modelOptions: switched.modelOptions,
            // The import the switch landed on: a successor's, if the one addressed had
            // been taken over, and the one the next message goes to.
            ...(each.id === session.id
              ? { conversationId: switched.conversationId }
              : {}),
          }
        : each,
    );
    void server.reread();
    return true;
  }

  /**
   * Reads one import's context window from the server (A6 U9), and the categories too when
   * `breakdown` — which costs Claude Code a count per category, so it is asked only when the
   * operator opens the meter. Keyed by the import addressed, which is the one the session
   * on screen names; the answer's own `conversationId` may be a successor's. `cause` is
   * what the meter's footer says the reading was taken after.
   *
   * **One breakdown read at a time per import** (A6 U9 review): a meter opened again while
   * one is out joins it, so toggling the meter asks the harness to count once. Closing the
   * meter or opening another session ({@link leaveBreakdown}) leaves it to run and drops its
   * answer, unless the meter is opened again first and takes it back.
   *
   * Two reads can cross, and the later-measured one is the truer: an answer measured before
   * the reading held does not replace its figure, but its categories are kept when they are
   * newer than the ones held — a slow count asked mid-turn that lands after the turn's own
   * reading is still the newest count. An answer for a page that was left, or one that did
   * not come, changes nothing. Without a server — the state picker — there is nothing to ask.
   */
  // V2(chat): V1 reads the window on opening, at each turn's end, after a Stop and after a
  // model switch, and between those draws the live feed's per-call frames; the categories
  // are counted only when the meter is opened and not again while it stays open (they are
  // labelled stale instead). V2 should have the server push a reading at each turn's end
  // and after a compaction on the live feed, so every tab's meter and its breakdown follow
  // without asking.
  readContext(
    conversationId: string,
    breakdown = false,
    cause: ContextReadCause = breakdown ? "asked" : "opened",
  ): Promise<void> {
    const server = this.#server;
    if (server === undefined) return Promise.resolve();
    if (!breakdown)
      return this.#askContext(server, conversationId, false, cause);
    // The operator opened the meter: a fresh opening may re-count once more per model.
    this.#meterOpen.add(conversationId);
    this.#recountedFor.delete(conversationId);
    const out = this.#breakdowns.get(conversationId);
    if (out !== undefined) {
      out.wanted = true;
      this.#counting(conversationId, true);
      return out.done;
    }
    // V2(chat): a breakdown read nobody wants any more is left to run, not aborted: the
    // harness's count (Claude Code's `getContextUsage`) takes no signal, so cancelling the
    // request would only stop the server waiting while the CLI went on counting, and a
    // meter opened again would start a second count beside it. V2 could abort once the
    // harness call can be withdrawn.
    return this.#countBreakdown(server, conversationId, cause);
  }

  /** Starts the one breakdown read for an import. */
  #countBreakdown(
    server: ConversationServer,
    conversationId: string,
    cause: ContextReadCause,
  ): Promise<void> {
    const read = { wanted: true, done: Promise.resolve() };
    this.#breakdowns.set(conversationId, read);
    this.#counting(conversationId, true);
    read.done = this.#askContext(server, conversationId, true, cause, read);
    return read.done;
  }

  /**
   * The meter closed, or another session came on screen (A6 U9 review): the breakdown read
   * out for `conversationId` — for every import without one — is not wanted. Nothing reads as
   * counting any more, and the answer is dropped when it lands unless the meter is opened
   * again first ({@link readContext}).
   */
  leaveBreakdown(conversationId?: string): void {
    if (conversationId === undefined) this.#meterOpen.clear();
    else this.#meterOpen.delete(conversationId);
    for (const [id, read] of this.#breakdowns) {
      if (conversationId !== undefined && id !== conversationId) continue;
      read.wanted = false;
      this.#counting(id, false);
    }
  }

  async #askContext(
    server: ConversationServer,
    conversationId: string,
    breakdown: boolean,
    cause: ContextReadCause,
    read?: { wanted: boolean },
  ): Promise<void> {
    this.#readingContext.set(
      conversationId,
      (this.#readingContext.get(conversationId) ?? 0) + 1,
    );
    let answer: ConversationContext | undefined;
    try {
      answer =
        server.context === undefined
          ? undefined
          : await server.context(conversationId, breakdown);
    } finally {
      const left = (this.#readingContext.get(conversationId) ?? 1) - 1;
      if (left > 0) this.#readingContext.set(conversationId, left);
      else this.#readingContext.delete(conversationId);
      if (read !== undefined && this.#breakdowns.get(conversationId) === read) {
        this.#breakdowns.delete(conversationId);
        this.#counting(conversationId, false);
      }
    }
    if (answer === undefined || this.#server !== server) return;
    if (read !== undefined && !read.wanted) return;
    this.#takeContext(conversationId, answer, cause);
    this.#recountIfStale(server, conversationId);
  }

  /**
   * Puts one answer of {@link readContext} into {@link contexts}.
   *
   * Every figure and every count carries the model the server says measured it (A6 U9
   * review 2), so nothing here guesses across a switch: the newest count is kept whatever
   * its model, and the meter shows it only under a reading of the same window; the figure
   * before is kept with its model, and the meter compares only figures of one model.
   */
  #takeContext(
    conversationId: string,
    answer: ConversationContext,
    cause: ContextReadCause,
  ): void {
    const held = this.contexts[conversationId];
    const counted =
      answer.breakdown._tag === "categories"
        ? {
            rows: answer.breakdown.categories,
            measuredAt: answer.measuredAt,
            model: answer.breakdown.model,
          }
        : undefined;
    const categories =
      counted !== undefined &&
      (held?.categories === undefined ||
        counted.measuredAt >= held.categories.measuredAt)
        ? counted
        : held?.categories;
    // Measured before the reading held: its figure is not the newer, but a slow count it
    // carries may still be the newest.
    if (held !== undefined && answer.measuredAt < held.reading.measuredAt) {
      if (categories !== held.categories) {
        this.contexts = {
          ...this.contexts,
          [conversationId]: {
            ...held,
            ...(categories === undefined ? {} : { categories }),
          },
        };
      }
      return;
    }
    const before = held?.reading;
    const moved =
      before !== undefined &&
      before.reading === "measured" &&
      before.used !== null &&
      (before.used !== answer.used ||
        !sameModel(before.usedModel, answer.usedModel));
    this.contexts = {
      ...this.contexts,
      [conversationId]: {
        reading: answer,
        previous: moved
          ? { used: before.used, model: before.usedModel }
          : (held?.previous ?? null),
        cause,
        ...(categories === undefined ? {} : { categories }),
      },
    };
  }

  /**
   * The meter is open and the reading now held is of a window its categories were not
   * counted on — a switch, here or in another tab — so the panel would show no rows
   * (A6 U9 review 2): one count of the window the reading is of.
   *
   * **Cannot loop.** Nothing is asked while a breakdown read is out (its answer comes back
   * here); a harness that gives none, a session not held and one that did not answer are
   * not asked again; and each window model is re-counted at most once per opening of the
   * meter ({@link #recountedFor}), so a count that comes back on another model asks again
   * only for a model not yet asked for, which takes another switch.
   */
  #recountIfStale(server: ConversationServer, conversationId: string): void {
    if (
      !this.#meterOpen.has(conversationId) ||
      this.#breakdowns.has(conversationId)
    ) {
      return;
    }
    const held = this.contexts[conversationId];
    if (held === undefined) return;
    const { breakdown, model } = held.reading;
    if (breakdown._tag === "none" && breakdown.reason !== "not_asked") return;
    if (sameWindow(held.categories?.model, model)) return;
    if (this.#recountedFor.get(conversationId) === model) return;
    this.#recountedFor.set(conversationId, model);
    // Not `asked`: the operator opened nothing, and the footer says so (U9 review 3).
    void this.#countBreakdown(server, conversationId, "recount");
  }

  /**
   * Another page, or the state picker: no breakdown read out is this page's any more, and a
   * meter opened on the next one must not join one asked of the last.
   */
  #forgetBreakdowns(): void {
    this.leaveBreakdown();
    this.#breakdowns.clear();
    this.#recountedFor.clear();
    this.countingBreakdown = new Set();
  }

  /** Marks one import's categories as being counted, or not. */
  #counting(conversationId: string, counting: boolean): void {
    if (this.countingBreakdown.has(conversationId) === counting) return;
    const next = new Set(this.countingBreakdown);
    if (counting) next.add(conversationId);
    else next.delete(conversationId);
    this.countingBreakdown = next;
  }

  /** A refused switch of one session, not yet dismissed, if there is one. */
  switchFailureOf(sessionId: string | undefined): ErrorNotice | undefined {
    return this.switchFailures.find((each) => each.sessionId === sessionId)
      ?.notice;
  }

  /** Closes the error dialog a refused switch of `sessionId` opened. */
  dismissSwitchFailure(sessionId: string): void {
    this.switchFailures = this.switchFailures.filter(
      (each) => each.sessionId !== sessionId,
    );
  }

  /** Closes the error dialog a refused Stop opened. */
  dismissStopFailure(): void {
    this.stopFailure = undefined;
  }

  /* ── The question dock (A7-Q) ─────────────────────────────────────────────── */

  /**
   * The imports whose session the server said it let go of (`noteConnection`'s `closed`),
   * so a `question` frame after it is not docked (A7-S review 1). An import id is one
   * authority period, and carrying the session on opens a new one under a new id, so an id
   * once here stays here. One entry per import ended while this tab was open.
   */
  #closedPeriods = new Set<string>();

  /**
   * True when no message can go to the session on screen: it is on a harness this server
   * does not run, the operator ended it (the index row, or the replay's refusal), the replay
   * refused to carry it on for another reason, or the owner says nothing can be sent at all
   * (the constructor's `unavailable`). The box's `blocked`, and the dock's rule below.
   */
  messageBlocked = $derived.by(() => {
    const session = this.current;
    return (
      session?.strandedOn !== undefined ||
      session?.ended === true ||
      session?.history.standing?.continuation === "refused" ||
      this.#unavailable()
    );
  });

  /** Whether the owner says nothing can be sent at all: the constructor's `unavailable`. */
  get messagesUnavailable(): boolean {
    return this.#unavailable();
  }

  /**
   * The question the session on screen is waiting on **that the operator can act on here**,
   * or `undefined`: the replay's answer (`ImporterConversationView.question`), moved by the
   * live `question` frames since. The one reader of the pending question (review 2 of slice
   * 2): the dock and any "waiting on you" dot read this, so they cannot disagree.
   */
  question = $derived.by((): PendingQuestion | undefined => {
    // An owner that cannot answer has no dock: the question is the transcript's tool row.
    if (!this.abilities.answerQuestion) return undefined;
    const pending = this.current?.history.question ?? undefined;
    if (pending === undefined || this.abilities.dismissQuestion) return pending;
    /*
     * A dock with nothing it can send and no dismissal would hold the box for good: a
     * question no longer waiting natively, on an owner that cannot dismiss, is left to the
     * transcript's tool row, and nothing says it waits on the operator.
     */
    const readOnly =
      pending.answerability === "not_resumable" ||
      (pending.answerability === "message" && this.messageBlocked);
    return readOnly ? undefined : pending;
  });

  /**
   * A live `question` frame (A7-Q): a question asked is put on its session; one answered or
   * dismissed is taken off. One **withdrawn** — a Stop, the session let go, the harness
   * forgetting it — is taken off and the replay read again, which offers it back as a
   * message where a message would carry the session on (`answerability: "message"`).
   */
  noteQuestion(frame: LiveQuestion): void {
    const conversationId = this.#binding.routeOf(frame);
    if (conversationId === null) return;
    const session = this.sessions.find(
      (each) => each.conversationId === conversationId,
    );
    if (session === undefined) return;
    // Asked of an import the server has let go of (A7-S review 1): nothing holds it to
    // answer, and the replay already read on `closed` says what the question is now.
    if (frame.question !== null && this.#closedPeriods.has(conversationId))
      return;
    if (frame.question !== null) {
      const asked = frame.question;
      this.#replace(session.id, (before) => ({
        ...before,
        history: { ...before.history, question: asked },
      }));
      // Offered again after a dismissal the harness did not answer: the line saying it
      // was put away is no longer true, and goes while it is still the line on screen.
      const said = this.#putAwayNotice;
      if (said?.sessionId === session.id) {
        this.#putAwayNotice = undefined;
        if (this.notice === said.notice) {
          this.notice = "";
          this.refused = false;
        }
      }
      return;
    }
    if (session.history.question?.questionId !== frame.questionId) return;
    this.#replace(session.id, (before) => ({
      ...before,
      history: { ...before.history, question: null },
    }));
    if (frame.settled === "withdrawn") void this.#rereadHistory(session.id);
  }

  /**
   * Sends the operator's answers to the question on screen (A7-Q). Taken off at once when
   * the server passed them on; a refusal is said in the dialog, and one saying the agent no
   * longer waits reads the replay again, so the dock offers the answers as a message.
   */
  async answerQuestion(answers: QuestionAnswers): Promise<void> {
    await this.#settleQuestion("answer", answers);
  }

  /**
   * Dismisses the question on screen (A7-Q): the agent is told the operator declined. A
   * question that is no longer waiting natively (`message`, `not_resumable`) is only put
   * away, so the replay stops offering it.
   */
  async dismissQuestion(): Promise<void> {
    await this.#settleQuestion("dismiss", undefined);
  }

  async #settleQuestion(
    how: "answer" | "dismiss",
    answers: QuestionAnswers | undefined,
  ): Promise<void> {
    const server = this.#server;
    const session = this.current;
    const question = this.question;
    const conversationId = session?.conversationId;
    if (
      server === undefined ||
      session === undefined ||
      question === undefined ||
      conversationId === undefined ||
      this.questionBusy
    ) {
      return;
    }
    // Only what the owner can do: one without the ability is not asked, nor another instead.
    const { answerQuestion, dismissQuestion } = server;
    const settle =
      how === "answer"
        ? answerQuestion === undefined
          ? undefined
          : () =>
              answerQuestion(conversationId, question.questionId, answers ?? {})
        : dismissQuestion === undefined
          ? undefined
          : () => dismissQuestion(conversationId, question.questionId);
    if (settle === undefined) return;
    this.questionBusy = true;
    const answer = await settle();
    this.questionBusy = false;
    if (this.#server !== server) return;
    const putAway = (): void =>
      this.#replace(session.id, (before) =>
        before.history.question?.questionId === question.questionId
          ? { ...before, history: { ...before.history, question: null } }
          : before,
      );
    if (answer._tag === "settled") {
      putAway();
      return;
    }
    /*
     * A dismissal the harness could not be told of (A7-Q review 1): the operator has
     * declined, and a dock they cannot put away while the harness is down would hold the
     * box hostage to it. So it is put away here, and the line above the box that comes back
     * says the agent may not have heard — a line rather than the dialog, which is the
     * dock's and goes with it; cleared, as any of those lines, by the next message or
     * another session.
     *
     * Whether it is offered again is the server's to find out (A7-Q review 2): it asks the
     * harness again for `QUESTION_RECHECK_MS` and publishes the question again while it
     * still waits (`noteQuestion` docks it, and takes this line away), or takes it off
     * once settled. A harness away for longer is found again only by a reload, so the
     * line says so. Never "the agent was not told": that is not known.
     */
    if (
      how === "dismiss" &&
      answer._tag === "refused" &&
      answer.reason === "harness_unreachable"
    ) {
      putAway();
      const notice = putAwayNotice(answer.detail);
      this.notice = notice;
      this.refused = true;
      this.#putAwayNotice = { sessionId: session.id, notice };
      return;
    }
    this.questionRefusal = {
      title: how === "answer" ? "Answers not sent" : "Questions not dismissed",
      sentence:
        answer._tag === "refused"
          ? answer.detail
          : "No server answered at this address, so whether it was passed on is not known. Your answers are kept; try again once the server is back.",
    };
    // No longer waiting: the replay says what can be done instead.
    if (answer._tag === "refused" && answer.reason === "settled") {
      void this.#rereadHistory(session.id);
    }
  }

  /**
   * Sends the answers as an ordinary message (A7-Q's `message` fallback): the question is
   * no longer waiting natively, but the session can be carried on. Posted like a message
   * from the box, without the box's draft or files, which stay where they are.
   *
   * **The dock stays until the message is accepted** (slice 3 fix, L2): it waits, busy,
   * while the message is out, and is put away only once the server took it. A refusal — a
   * session whose harness died a moment ago, say — keeps the dock and the operator's
   * answers in it, and says why in its dialog, as a refused answer does. Putting it away
   * first lost the answers with the dock.
   */
  async sendAnswersAsMessage(text: string): Promise<void> {
    const session = this.current;
    const server = this.#server;
    if (session === undefined || server === undefined) return;
    const question = this.question;
    this.questionRefusal = undefined;
    const outcome = await this.#post(server, session, text, "queued", {
      files: false,
      dock: true,
    });
    if (this.#server !== server || question === undefined) return;
    if (outcome?._tag === "accepted") {
      // Wherever the thread went: the same session, or a fresh one opened in its place.
      this.sessions = this.sessions.map((each) =>
        each.history.question?.questionId === question.questionId
          ? { ...each, history: { ...each.history, question: null } }
          : each,
      );
      return;
    }
    if (outcome === undefined || this.currentId !== session.id) return;
    this.questionRefusal = {
      title: "Answers not sent",
      sentence: sentenceCase(outcome.detail),
    };
  }

  dismissQuestionRefusal(): void {
    this.questionRefusal = undefined;
  }
}

/**
 * The server's sentence with its first letter raised, since the dialog shows it on its own:
 * the server words a switch's refusal as a clause ("another model switch of import … has not
 * answered yet"). The words are otherwise the server's, as they stand.
 */
/** How one post ended, as far as its caller needs it: the dock's message reads it. */
type PostOutcome =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "refused" | "unanswered"; readonly detail: string };

/** Where the words of a message that did not land were put ({@link ImporterSessions}). */
interface WordsHeld {
  /** In the composer of {@link sessionId}, or parked on it. */
  readonly in: "box" | "parked";
  readonly sessionId: string;
  /** What the page said of them then: replaced only while it is still on screen. */
  readonly notice: string;
}

/**
 * When a message whose answer was lost is looked for again, in ms after the list is re-read
 * ({@link ImporterSessions}'s `#confirm`). Not once only: the server answers an opening
 * before the harness has written the operator's words — Claude Code wrote the user entry
 * ~60 ms after the 202 (U8 review 4, haiku-4-5) — so the first read can just miss them. A
 * few reads over about eight seconds, and then the message stays "Not confirmed".
 */
const CONFIRM_DELAYS = [0, 500, 1000, 2000, 4000] as const;

/**
 * How much earlier than this tab's estimate of the server's clock a send is taken to have
 * left, in ms ({@link ImporterSessions}'s `#holding`). The estimate reads the server's clock
 * off an answer's `at` against when it arrived here, so it runs late by that answer's
 * journey; a second more keeps this message's own copy, accepted after it left, from ever
 * reading as older than it. The cost is that a copy another tab sent within that second
 * before is taken for this one (V2(chat): idempotency keys, at `#post`).
 */
const CONFIRM_CLOCK_SLACK = 1000;

/**
 * What a message whose answer was lost is checked against ({@link ImporterSessions}'s
 * `#holding`), taken as it leaves: when it left, on this tab's clock, and the message ids
 * the thread already holds its words under — a copy under one of those is an earlier
 * message of this tab's. A first message's ids are empty.
 */
interface ConfirmBaseline {
  readonly ids: ReadonlySet<string>;
  readonly sentAt: number;
}

/** The message ids the operator's thread on a session already holds these words under. */
const idsSaid = (
  session: {
    readonly history: { readonly items: readonly LiveItem[] };
    readonly items: readonly LiveItem[];
  },
  text: string,
): ReadonlySet<string> => {
  // The thread's own rows hold the whole words; what it read from the replay, the server's
  // shortened form of them.
  const replayed = truncateNarration(text);
  return new Set(
    [...session.history.items, ...session.items].flatMap((item) => {
      const body = item.body?.trim();
      return item.kind === "turn.operator" &&
        (body === text || body === replayed)
        ? (item.messageIds ?? [])
        : [];
    }),
  );
};

/**
 * A session as a notice names it: **always by when it started**, "the session started today
 * at 12:25", and by its title only beside that, isolated (a title is the harness's). Not by
 * its label (U8 review 5): an untitled session's label is "Session 12:25", and Claude Code
 * titles a session seconds into its first turn, so a notice written before the title came
 * named a row the list no longer showed under that name. The start time is on every row
 * and never changes; Claude Code's titles come from bit's own framing, so two are often
 * named alike anyway.
 */
const named = (session: ConversationSession, now: number): string => {
  const when = sessionStarted(session.startedAt, now);
  const title = session.title?.trim() ?? "";
  return title === ""
    ? `the session started ${when}`
    : `the session ${isolated(title)} (started ${when})`;
};

/**
 * What is known of a message no answer came back for (U8 review 4), worded as a model switch
 * in the same case is: not that it was not sent, and what sending it again risks.
 */
const unansweredDetail = (first: boolean): string =>
  `No server answered at this address, so whether this message was sent is not known. Sending it again may ${
    first ? "open a second session for it" : "send it twice"
  }.`;

const sentenceCase = (text: string): string =>
  text === "" ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

/**
 * The line above the box after a dismissal the harness did not answer (A7-Q review 2): the
 * server's sentence, which says whether the agent heard is not known, then what happens
 * next — the server asks again for {@link QUESTION_RECHECK_MS}, and after that only a
 * reload checks.
 */
export const putAwayNotice = (detail: string): string =>
  `Questions put away. ${sentenceCase(detail)} If the harness comes back within ${String(
    Math.round(QUESTION_RECHECK_MS / 60_000),
  )} minutes still waiting on them, they are offered here again; after that, reload the page to check.`;
