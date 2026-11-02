/**
 * The Auto-load page's chat state, driven entirely by mock data.
 *
 * **There is no importer API yet**, and this is the stand-in for the one thing the page will
 * need from it: a list of sessions on the open target, the one being read, and what typing
 * into it does. Everything here is local to the tab and gone on a reload. When a real source
 * exists, this class is what gets replaced; `ImporterChat.svelte` and `TitleBar.svelte`
 * read these fields and know nothing about where they came from.
 *
 * ## What sending does, and the one fake in it
 *
 * Sending appends the operator's message to the session's feed — as the same minted
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
import { operatorTurn } from "./chat";
import {
  buildImporterChat,
  type ImporterGroup,
  type ImporterSession,
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

/** What a stand-in reply says, so no one reads it as the importer's own words. */
export const STAND_IN_REPLY =
  "Understood. This is a prototype: nothing is attached to answer, so this line is a stand-in for the importer's reply.";

export class ImporterSessions {
  readonly #now: () => number;
  #sent = 0;

  /** Every session on the target, in no particular order. */
  sessions = $state.raw<readonly ImporterSession[]>([]);
  /** The one on screen. */
  currentId = $state("");
  /** What is typed in the composer and not yet sent. */
  draft = $state("");
  /** Whether the crumb bar's session list is open. */
  pickerOpen = $state(false);

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
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
          items: this.current.items,
          working: this.current.working,
        }),
  );

  /**
   * The picker's rows, newest first.
   *
   * A session nobody has said anything in is not a *previous* session; it is the empty one
   * the operator is looking at, and listing it would make "Start a new session" appear to
   * have a twin.
   */
  listed = $derived(
    this.sessions
      .filter((session) => session.tally.messages > 0)
      .toSorted((left, right) => right.startedAt - left.startedAt),
  );

  /** Puts the prototype into one of the states the brief shows. */
  load(scenario: ImporterScenario): void {
    const now = this.#now();
    const earlier = mockEarlierSessions(now);
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
    if (this.sessions.some((session) => session.id === id)) {
      this.currentId = id;
      this.draft = "";
    }
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
      tally: { ...before.tally, messages: before.tally.messages + 2 },
    }));
  }

  /** Stops the importer mid-turn. Whatever it had not finished stays visibly unfinished. */
  stop(): void {
    const session = this.current;
    if (session === undefined) return;
    this.#replace(session.id, (before) => ({ ...before, working: false }));
  }
}
