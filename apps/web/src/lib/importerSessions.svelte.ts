/**
 * The Auto-load page's chat state: the server's session list, over a conversation that is
 * still mock.
 *
 * ## What is real and what is not
 *
 * **The list is real.** {@link begin} and {@link syncIndexed} put the target's indexed
 * sessions (`GET .../importer-sessions`) in the picker, each with its model, time, running
 * flag and tally. **What was said before this page opened is not**: there is no way to read
 * a session's history yet (S6), so an indexed session opens empty with a note saying why.
 * Sending into one posts, and what the importer says back is live (below).
 * `ImporterChat.svelte` and `TitleBar.svelte` read these fields and know nothing about which
 * is which; {@link ImporterSession.indexed} is what tells them apart.
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
import type { ImporterTurnAccepted, LiveItem } from "@bit/contracts";

import { operatorTurn } from "./chat";
import {
  NO_HISTORY,
  buildImporterChat,
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
   * Reads the session list again: after an accepted message, so the session it landed in
   * is listed with the server's figures, and after an `import_ended` refusal, so the
   * session the operator ended reads as ended and the composer stops offering it.
   */
  readonly reread: () => void;
  /** A harness instance's display name, for the avatar on the session's header. */
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
  #sent = 0;
  /** Stops watching the turn in flight, if one is being watched. */
  #unwatch: (() => void) | undefined = undefined;
  /** The import {@link #unwatch} is for. */
  #watching: string | undefined = undefined;

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
  #server: ImporterServer | undefined = undefined;

  constructor(
    now: () => number = () => Date.now(),
    live: () => readonly LiveItem[] = () => [],
  ) {
    this.#now = now;
    this.#live = live;
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
          }),
          working: this.current.working,
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
    this.#server = server;
    this.draft = "";
    this.notice = "";
    this.refused = false;
    this.sending = false;
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
          (session) => session.indexed === true && session.items.length > 0,
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
  }

  /** Puts the prototype into one of the states the brief shows. */
  load(scenario: ImporterScenario): void {
    const now = this.#now();
    const earlier = mockEarlierSessions(now);
    this.#stopWatching();
    this.#server = undefined;
    this.notice = "";
    this.refused = false;
    this.sending = false;
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
    }
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

  /** Stops the importer mid-turn. Whatever it had not finished stays visibly unfinished. */
  stop(): void {
    const session = this.current;
    if (session === undefined) return;
    this.#replace(session.id, (before) => ({ ...before, working: false }));
  }
}
