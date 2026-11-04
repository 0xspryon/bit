/**
 * The Auto-load page's chat state: the server's session list, over a conversation that is
 * still mock.
 *
 * ## What is real and what is not
 *
 * **The list is real.** {@link begin} and {@link syncIndexed} put the target's indexed
 * sessions (`GET .../importer-sessions`) in the picker, each with its model, time, running
 * flag and tally. **And what was said in one is real too, since S6**: opening an indexed
 * session reads its conversation back from the harness
 * (`GET .../importer-sessions/:importId/messages`, {@link #loadHistory}) and with it the
 * server's own account of what the next message will do — continue the live session, resume
 * one this process let go of, open a fresh one, or be refused. Sending into one posts, and
 * what the importer says back is live (below). `ImporterChat.svelte` and `TitleBar.svelte`
 * read these fields and know nothing about which is which;
 * {@link ImporterSession.indexed} is what tells them apart.
 *
 * The nine scenarios the state picker loads ({@link load}) never touch the server and are
 * wholly declared (`mockImporter.ts`), which is what lets an operator inspect a state
 * without reproducing it.
 *
 * ## Sending, when there is a server
 *
 * {@link begin} is given an {@link ImporterServer} when the page is a real target's, and then
 * a message is posted rather than answered here (the importer conversation design, S3). The
 * empty session's first message **opens** a conversation; a message in a session the server
 * lists goes to that session's import. The draft is cleared **on acceptance**, not on submit,
 * so a refusal leaves the operator's words where they were beside the server's sentence.
 *
 * What comes back decides where the turn lands. `continued` appends to the session on
 * screen. `opened` is a **new harness session** — the first message of a conversation, or a
 * message to an import the server no longer held, which it reopened under a new import id —
 * so the page moves to it, keeping the operator's words on it.
 *
 * ## What the importer says, live (the importer conversation design, S4)
 *
 * The importer's replies and thinking arrive on the **target's** live feed, which the app
 * already holds, with `importId` set; {@link groups} reads that feed and files each entry
 * under the session whose import it names (`importerFeed`). Nothing is copied into a
 * session, so an entry is in one place and a re-read of the index cannot lose it.
 *
 * While a turn is in flight its session is `working`, which is what draws the streaming
 * cursor. It is set when the server accepts a message and cleared when the server says the
 * import is no longer running ({@link ImporterServer.watchTurn}) — not when the agent goes
 * quiet, because an agent reading a page can be quiet for a long time and is still working.
 *
 * ## What sending does without a server, and the one fake in it
 *
 * In the state picker's scenarios there is no server.
 * Sending there appends the operator's message to the session's feed — as the same minted
 * `turn.operator` row the goal chat uses — and then a single stand-in reply, labelled as
 * one. Nothing is attached to answer, and a chat that took a message and went quiet would be
 * judged on its silence rather than on its layout. The reply is the only invented content
 * the interface produces; the fixtures it joins are in `mockImporter.ts`.
 *
 * A message sent while the importer is mid-turn ends that turn: there is no agent to
 * interleave with, and the write it was making is then honestly `unresolved` rather than
 * `pending` for ever. The same is true of Stop, which is what lets the prototype show that
 * state at all.
 */
import type {
  ConversationStopped,
  ImporterConversationView,
  ImporterTurnAccepted,
  LiveItem,
} from "@bit/contracts";

import type { ErrorNotice } from "./components/ErrorDialog.svelte";

import { operatorTurn } from "./chat";
import {
  NO_HISTORY,
  buildImporterChat,
  historyOf,
  importerFeed,
  type ImporterGroup,
  type ImporterSession,
  acceptedNotice,
} from "./importerChat";
import {
  mockAwaitingSession,
  mockCompletedSession,
  mockEarlierSessions,
  mockForgottenSession,
  mockNewSession,
  mockOpeningSession,
  mockReloadedSession,
  mockStreamingSession,
} from "./mockImporter";

/**
 * The two pre-written first messages D2 offers.
 *
 * The design is exact that they are "really just pre-written first messages", so choosing
 * one fills the composer and sends nothing: each ends where the operator's own words go.
 */
export const STARTERS = {
  program: {
    label: "Read a HackerOne or Bugcrowd program page",
    draft: "Read the program page at https://",
  },
  sow: {
    label: "Paste a statement of work",
    draft:
      "Here is the statement of work. Load what it puts in and out of scope:\n\n",
  },
} as const;
export type StarterKey = keyof typeof STARTERS;

/** The states the prototype can be put into, in `ScenarioBar`'s words. */
export type ImporterScenario =
  | "default"
  | "first"
  | "streaming"
  | "awaiting"
  | "complete"
  | "picker"
  | "reloaded"
  | "forgotten"
  | "opening";

/** What the server answered a message with, as the page needs it. */
export type ImporterSent =
  | { readonly _tag: "accepted"; readonly turn: ImporterTurnAccepted }
  | {
      readonly _tag: "refused";
      readonly detail: string;
      /**
       * The server refused because the import was ended (`import_ended`): its row changed
       * since the list was read, so the list is read again and the composer disables on it.
       */
      readonly ended?: boolean;
    };

/** What the server answered a Stop with, as the page needs it. */
export type ImporterStopAnswer =
  | { readonly _tag: "stopped"; readonly stopped: ConversationStopped }
  | { readonly _tag: "refused"; readonly detail: string };

/**
 * The page's way to the server, handed in by the app when the page is a real target's.
 *
 * Absent in the state picker's scenarios, which never touch a server and answer with the
 * stand-in reply instead.
 */
export interface ImporterServer {
  /** Opens a conversation whose first turn is `text`. */
  readonly open: (text: string) => Promise<ImporterSent>;
  /** Says `text` to one import's session. */
  readonly send: (importId: string, text: string) => Promise<ImporterSent>;
  /**
   * Stops the turn running in one import's session, keeping the conversation (A6 F5): the
   * harness is interrupted and the session stays open for the next message.
   */
  readonly stop: (importId: string) => Promise<ImporterStopAnswer>;
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
    importId: string,
  ) => Promise<
    | { readonly view: ImporterConversationView; readonly floor: number }
    | undefined
  >;
  /**
   * Reads the session list again: after an accepted message, so the session it landed in
   * is listed with the server's figures, and after an `import_ended` refusal, so the
   * session the operator ended reads as ended and the composer stops offering it.
   */
  readonly reread: () => void;
  /** A harness instance's display name, for the glyph on the composer's model chip. */
  readonly harnessName: (instanceId: string) => string;
  /**
   * The highest activity publish order this tab has seen, or `0` for none. Read when a
   * message is sent, so the importer's answer sorts after it: see
   * `ImporterSession.floors`.
   */
  readonly highWater: () => number;
  /**
   * Watches one import until its turn is over, then calls `idle` once.
   *
   * **Asked, because the narration cannot say it.** The bus carries what the agent says and
   * nothing about when it has stopped — a harness's stream has no "idle" entry, and an
   * agent can be silent for a minute while it reads a page. The server does know: the
   * import is `running` from the moment a message is accepted until `waitForIdle` returns
   * for it (`progress.resume`, then `settle`). So the turn's cursor is cleared by that
   * answer and by nothing guessed from the feed. Returns a function that stops watching.
   */
  readonly watchTurn: (importId: string, idle: () => void) => () => void;
}

/** What a stand-in reply says, so no one reads it as the importer's own words. */
export const STAND_IN_REPLY =
  "Understood. This is a prototype: nothing is attached to answer, so this line is a stand-in for the importer's reply.";

export class ImporterSessions {
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
  #sent = 0;
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
  /** Stops watching the turn in flight, if one is being watched. */
  #unwatch: (() => void) | undefined = undefined;
  /** The import {@link #unwatch} is for. */
  #watching: string | undefined = undefined;
  /**
   * A Stop's sentence about a conversation that was still busy when it was answered, and the
   * ids it is about. It describes the turn the Stop left running, so it is over when that
   * turn is: the turn watch clears it from {@link notice} when the import goes idle.
   */
  #busyStop:
    { readonly ids: readonly string[]; readonly text: string } | undefined =
    undefined;

  /** Every session on the target, in no particular order. */
  sessions = $state.raw<readonly ImporterSession[]>([]);
  /** The one on screen. */
  currentId = $state("");
  /** What is typed in the composer and not yet sent. */
  draft = $state("");
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
  /** True while a Stop is with the server and not yet answered. */
  stopping = $state(false);
  /**
   * A Stop the server could not carry out, for the error dialog; `undefined` when there is
   * none. Not {@link notice}: that line is about the draft beneath it, and a Stop is not.
   */
  stopFailure = $state<ErrorNotice | undefined>(undefined);
  #server: ImporterServer | undefined = undefined;

  constructor(
    now: () => number = () => Date.now(),
    live: () => readonly LiveItem[] = () => [],
    skipped: () => number = () => 0,
  ) {
    this.#now = now;
    this.#live = live;
    this.#skipped = skipped;
    this.load("default");
  }

  current = $derived(
    this.sessions.find((session) => session.id === this.currentId),
  );

  /** The conversation on screen, one group per operator message. */
  groups = $derived<readonly ImporterGroup[]>(
    this.current === undefined
      ? []
      : buildImporterChat({
          history: this.current.history,
          items: importerFeed({
            own: this.current.items,
            floors: this.current.floors,
            live: this.#live(),
            importId: this.current.importId,
            // The replay/live boundary. Undefined on a session whose words were never asked
            // for, which takes nothing away: it has no replay to collide with.
            historyFloor: this.current.historyFloor,
          }),
          working: this.current.working,
          recordsSkipped: this.#skipped(),
        }),
  );

  /**
   * The picker's rows, newest first.
   *
   * A session nobody has said anything in is not a *previous* session; it is the empty one
   * the operator is looking at, and listing it would make "Start a new session" appear to
   * have a twin. An indexed session's count is unknown rather than zero, and it is listed:
   * the server says it exists.
   */
  listed = $derived(
    this.sessions
      .filter((session) => session.tally.messages !== 0)
      .toSorted((left, right) => right.startedAt - left.startedAt),
  );

  /**
   * Opens the page on a target: an empty session to type into, beside the ones the server
   * lists.
   *
   * Replaces everything, including whatever a scenario or an earlier visit left, because the
   * sessions are the target's and a list that kept another visit's local ones would be
   * showing one of them as if the server had it.
   */
  begin(indexed: readonly ImporterSession[], server?: ImporterServer): void {
    const fresh = mockNewSession(this.#now());
    this.#stopWatching();
    this.#reading.clear();
    this.#server = server;
    this.draft = "";
    this.notice = "";
    this.refused = false;
    this.sending = false;
    this.stopping = false;
    this.stopFailure = undefined;
    this.pickerOpen = false;
    this.#sent = 0;
    this.sessions = [fresh, ...indexed];
    this.currentId = fresh.id;
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
  syncIndexed(indexed: readonly ImporterSession[]): void {
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
    const refreshed = indexed.map((session) => {
      const kept = touched.get(session.id);
      return kept === undefined
        ? session
        : {
            ...session,
            history: kept.history,
            items: kept.items,
            ...(kept.floors === undefined ? {} : { floors: kept.floors }),
            ...(kept.historyFloor === undefined
              ? {}
              : { historyFloor: kept.historyFloor }),
            ...(kept.loaded === undefined ? {} : { loaded: kept.loaded }),
            reading: kept.reading,
          };
    });
    const unlisted = [...touched.values()].filter(
      (kept) => !indexed.some((session) => session.id === kept.id),
    );
    this.sessions = [...own, ...refreshed, ...unlisted];
    if (!this.sessions.some((session) => session.id === this.currentId)) {
      this.currentId = own[0]?.id ?? refreshed[0]?.id ?? "";
    }
    // `working` is the server's figure here, so a session it says is running — a turn sent
    // from another tab, say — is watched to its end like one sent from this one.
    const current = this.current;
    if (
      current?.working === true &&
      current.importId !== undefined &&
      this.#watching !== current.importId
    ) {
      this.#watch(current.importId);
    }
    // And its words, if this is the first list that named it: `openImporter` can open a
    // session by id before the index has arrived, so the read cannot only hang off `open`.
    if (current !== undefined) void this.#loadHistory(current);
  }

  /** Puts the prototype into one of the states the brief shows. */
  load(scenario: ImporterScenario): void {
    const now = this.#now();
    const earlier = mockEarlierSessions(now);
    this.#stopWatching();
    this.#reading.clear();
    this.#server = undefined;
    this.notice = "";
    this.refused = false;
    this.sending = false;
    this.stopping = false;
    this.stopFailure = undefined;
    this.draft = "";
    this.pickerOpen = false;
    this.#sent = 0;
    const show = (
      current: ImporterSession,
      rest: readonly ImporterSession[] = earlier,
    ): void => {
      this.sessions = [current, ...rest];
      this.currentId = current.id;
    };
    switch (scenario) {
      case "default":
        show(mockNewSession(now));
        return;
      case "first":
        show(mockNewSession(now), []);
        return;
      case "streaming":
        show(mockStreamingSession(now));
        return;
      case "awaiting":
        show(mockAwaitingSession(now));
        return;
      case "complete":
        show(mockCompletedSession(now));
        this.draft = "The engagement window is Nov 3 to Nov 21";
        return;
      case "picker":
        show(mockCompletedSession(now));
        this.pickerOpen = true;
        return;
      case "reloaded":
        show(mockReloadedSession(now));
        return;
      case "forgotten":
        // Opened from the picker: the session that is gone, with today's still listed.
        this.sessions = [
          mockCompletedSession(now),
          ...earlier.filter((session) => session.id !== "ses_forgotten"),
          mockForgottenSession(now),
        ];
        this.currentId = "ses_forgotten";
        return;
      case "opening":
        this.sessions = [
          mockCompletedSession(now),
          ...earlier.filter((session) => session.id !== "ses_forgotten"),
          mockOpeningSession(now),
        ];
        this.currentId = "ses_forgotten";
        return;
    }
  }

  #replace(id: string, change: (session: ImporterSession) => ImporterSession) {
    this.sessions = this.sessions.map((session) =>
      session.id === id ? change(session) : session,
    );
  }

  /** Opens a session from the picker. An older one is read-only until the operator types. */
  open(id: string): void {
    this.pickerOpen = false;
    this.notice = "";
    this.refused = false;
    const opened = this.sessions.find((session) => session.id === id);
    if (opened !== undefined) {
      this.currentId = id;
      this.draft = "";
      // A session the server says is running is watched to its end, so its cursor clears
      // here too rather than only in the tab that sent the message.
      if (opened.working && opened.importId !== undefined) {
        this.#watch(opened.importId);
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
  async #loadHistory(session: ImporterSession): Promise<void> {
    const server = this.#server;
    const importId = session.importId;
    if (
      server === undefined ||
      importId === undefined ||
      session.loaded === true ||
      session.items.length > 0 ||
      this.#reading.has(importId)
    ) {
      return;
    }
    this.#reading.add(importId);
    const answered = await server
      .history(importId)
      .finally(() => this.#reading.delete(importId));
    if (answered === undefined) return;
    // The page was left or reset meanwhile: nothing here is the answer's to change.
    if (this.#server !== server) return;
    this.#replace(session.id, (before) =>
      before.loaded === true || before.items.length > 0
        ? before
        : {
            ...before,
            history: historyOf(answered.view),
            historyFloor: answered.floor,
            loaded: true,
          },
    );
  }

  /**
   * Watches one import's turn and marks its session idle once the server says it is.
   * One at a time: a later turn, or another session's, replaces the watch.
   */
  #watch(importId: string): void {
    const server = this.#server;
    if (server === undefined) return;
    this.#stopWatching();
    const stop = server.watchTurn(importId, () => {
      if (this.#unwatch !== stop) return;
      this.#unwatch = undefined;
      this.#watching = undefined;
      this.sessions = this.sessions.map((session) =>
        session.importId === importId
          ? { ...session, working: false }
          : session,
      );
      // A Stop's "is answering it now" is about the turn that just ended, so it goes with
      // the pill rather than outliving it. Only if it is still what the line says.
      const busy = this.#busyStop;
      if (busy !== undefined && busy.ids.includes(importId)) {
        this.#busyStop = undefined;
        if (this.notice === busy.text) this.notice = "";
      }
      // The turn wrote what it wrote: the list's tally is the server's to restate.
      server.reread();
    });
    this.#unwatch = stop;
    this.#watching = importId;
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
   * two blank threads are one choice, not two.
   */
  start(): void {
    this.pickerOpen = false;
    this.draft = "";
    this.notice = "";
    this.refused = false;
    if (this.current?.tally.messages === 0) return;
    this.#sent += 1;
    const fresh = mockNewSession(this.#now(), `ses_new_${String(this.#sent)}`);
    this.sessions = [...this.sessions, fresh];
    this.currentId = fresh.id;
  }

  /** Fills the composer with a pre-written first message. Sends nothing. */
  useStarter(key: StarterKey): void {
    this.draft = STARTERS[key].draft;
  }

  /** Sends the draft into the session on screen, resuming it if it was only being read. */
  send(): void {
    const text = this.draft.trim();
    const session = this.current;
    if (text === "" || session === undefined) return;
    // A session on a harness this server does not run is not asked, and not typed into:
    // the harness it does have would answer "no such session" for one that may be alive
    // elsewhere. The composer is disabled too; this is the rule, that is its face.
    if (session.strandedOn !== undefined) return;
    // The operator ended it; the server would refuse, and the composer says so instead.
    if (session.ended === true) return;
    if (this.#server !== undefined) {
      void this.#post(this.#server, session, text);
      return;
    }
    const at = this.#now();
    /** How many this tab's feed already holds: the id's namespace, not the turn's number. */
    const index = session.items.filter(
      (item) => item.kind === "turn.operator",
    ).length;
    this.draft = "";
    this.#replace(session.id, (before) => ({
      ...before,
      reading: false,
      working: false,
      items: [
        ...before.items,
        operatorTurn({ index: index + 1, text, at, after: 0 }),
        {
          _tag: "item",
          id: `activity:stand-in-${String(index + 1)}`,
          origin: "activity",
          sequence: null,
          kind: "turn.reply",
          at: at + 400,
          attemptId: null,
          roundId: null,
          goalId: null,
          importId: null,
          headline: "Importer",
          body: STAND_IN_REPLY,
          tool: null,
          toolName: null,
          input: null,
          output: null,
          callId: null,
          outcome: null,
        },
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
    server: ImporterServer,
    session: ImporterSession,
    text: string,
  ): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    this.notice = "";
    this.refused = false;
    // Taken before the message goes, so whatever the importer says in answer sorts after
    // it — including what it says before this request has been answered.
    const after = server.highWater();
    const answer =
      session.importId === undefined
        ? await server.open(text)
        : await server.send(session.importId, text);
    this.sending = false;
    // The page was left or reset meanwhile: nothing here is the answer's to change.
    if (this.#server !== server) return;
    if (answer._tag === "refused") {
      this.notice = answer.detail;
      this.refused = true;
      if (answer.ended === true) server.reread();
      return;
    }
    const turn = answer.turn;
    if (this.draft.trim() === text) this.draft = "";
    this.notice = acceptedNotice(turn);
    const at = this.#now();
    const landed = (before: ImporterSession): ImporterSession => {
      const index = before.items.filter(
        (item) => item.kind === "turn.operator",
      ).length;
      const row = operatorTurn({ index: index + 1, text, at, after });
      return {
        ...before,
        id: turn.harnessSessionId,
        importId: turn.importId,
        model: turn.model,
        harness: server.harnessName(turn.harnessInstanceId),
        indexed: true,
        reading: false,
        working: true,
        items: [...before.items, row],
        floors: { ...before.floors, [row.id]: after },
        tally: { ...before.tally, messages: null },
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
      if (this.currentId === session.id) this.currentId = next.id;
    } else {
      // A fresh session opened in place of one the server no longer held: a new thread,
      // and the old one stays in the list as what it was.
      const fresh = landed({
        ...session,
        startedAt: at,
        history: NO_HISTORY,
        items: [],
        floors: {},
        tally: { in: 0, out: 0, assets: 0, messages: null },
      });
      this.sessions = [...this.sessions, fresh];
      if (this.currentId === session.id) this.currentId = fresh.id;
    }
    this.#watch(turn.importId);
    server.reread();
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
  async stop(): Promise<void> {
    const session = this.current;
    if (session === undefined) return;
    const server = this.#server;
    const importId = session.importId;
    if (server === undefined || importId === undefined) {
      this.#replace(session.id, (before) => ({ ...before, working: false }));
      return;
    }
    if (this.stopping) return;
    this.stopping = true;
    const answer = await server.stop(importId);
    this.stopping = false;
    // The page was left or reset meanwhile: nothing here is the answer's to change.
    if (this.#server !== server) return;
    if (answer._tag === "refused") {
      this.stopFailure = { title: "Turn not stopped", sentence: answer.detail };
      return;
    }
    const stopped = answer.stopped;
    this.notice = stopped.detail;
    this.refused = false;
    this.#busyStop = stopped.working
      ? { ids: [importId, stopped.conversationId], text: stopped.detail }
      : undefined;
    if (stopped.working) return;
    this.sessions = this.sessions.map((each) =>
      each.importId === importId || each.importId === stopped.conversationId
        ? { ...each, working: false }
        : each,
    );
  }

  /** Closes the error dialog a refused Stop opened. */
  dismissStopFailure(): void {
    this.stopFailure = undefined;
  }
}
