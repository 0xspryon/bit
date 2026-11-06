/**
 * The Auto-load page's chat state: the generic conversation state
 * (`conversationSessions.svelte.ts`) bound to the scope importer, and the importer's own
 * parts — the two starters D2 offers, the nine scenarios the state picker loads, and the
 * stand-in reply a scenario's message gets.
 *
 * ## The scenarios, and the one fake in them
 *
 * The scenarios never touch the server and are wholly declared (`mockImporter.ts`), which is
 * what lets an operator inspect a state without reproducing it. Sending there appends the
 * operator's message and then a single stand-in reply, labelled as one: nothing is attached
 * to answer, and a chat that took a message and went quiet would be judged on its silence
 * rather than on its layout.
 */
import {
  ConversationSessions,
  type ConversationBinding,
} from "./conversationSessions.svelte";
import { IMPORTER_AGENT_NOUN, type ImporterSession } from "./importerChat";
import {
  mockAgents,
  mockAwaitingSession,
  mockCompletedSession,
  mockEarlierSessions,
  mockForgottenSession,
  mockNewSession,
  mockOpeningSession,
  mockReloadedSession,
  mockStreamingSession,
} from "./mockImporter";

export type {
  ConversationServer as ImporterServer,
  ConversationSent as ImporterSent,
  ConversationActivityState as ImporterActivity,
  ConversationQuestionAnswer as ImporterQuestionAnswer,
  ConversationContextState as ImporterContext,
  ConversationStopAnswer as ImporterStopAnswer,
  ConversationSwitchAnswer as ImporterSwitchAnswer,
  ContextReadCause,
  ModelSwitchInFlight,
  SwitchFailure,
  SwitchNotice,
} from "./conversationSessions.svelte";

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

/** What a starter leaves for the operator to finish: the program page's scheme. */
const SEED = "https://";

/**
 * The operator's own words in a draft: what follows a starter the draft begins with (its
 * trailing whitespace aside), or the whole draft. A starter that ends in `https://` with
 * words glued to it was finished by the operator, so the `https://` is theirs too — unless
 * they pasted a URL of their own after it, which is then the URL.
 */
const operatorWordsOf = (draft: string): string => {
  for (const each of Object.values(STARTERS)) {
    const lead = each.draft.replace(/\s+$/u, "");
    if (!draft.startsWith(lead)) continue;
    const rest = draft.slice(lead.length);
    const glued = rest !== "" && !/^\s/u.test(rest);
    if (lead.endsWith(SEED) && glued && !/^https?:\/\//iu.test(rest)) {
      return `${SEED}${rest}`;
    }
    return rest;
  }
  return draft;
};

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

/**
 * The importer, as a chat's state is bound to it: its frames carry the period as `importId`,
 * its empty session is the page's own blank thread, and a scenario's message is answered
 * with {@link STAND_IN_REPLY}.
 */
export const IMPORTER_BINDING: ConversationBinding<ImporterSession> = {
  routeOf: (frame) => frame.importId,
  agent: IMPORTER_AGENT_NOUN,
  emptySession: (now, id) => mockNewSession(now, id),
  standIn: { headline: "Importer", body: STAND_IN_REPLY },
};

export class ImporterSessions extends ConversationSessions<ImporterSession> {
  readonly #clock: () => number;

  constructor(
    now: () => number = () => Date.now(),
    live?: () => readonly import("@bit/contracts").LiveItem[],
    skipped?: () => number,
  ) {
    super(IMPORTER_BINDING, now, live, skipped);
    this.#clock = now;
    this.load("default");
  }

  /** Puts the prototype into one of the states the brief shows. */
  load(scenario: ImporterScenario): void {
    const now = this.#clock();
    const earlier = mockEarlierSessions(now);
    const agents = mockAgents();
    const show = (
      current: ImporterSession,
      rest: readonly ImporterSession[] = earlier,
      extra: { readonly draft?: string; readonly pickerOpen?: boolean } = {},
    ): void => {
      this.reset({ sessions: [current, ...rest], agents, ...extra });
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
        show(mockCompletedSession(now), earlier, {
          draft: "The engagement window is Nov 3 to Nov 21",
        });
        return;
      case "picker":
        show(mockCompletedSession(now), earlier, { pickerOpen: true });
        return;
      case "reloaded":
        show(mockReloadedSession(now));
        return;
      case "forgotten":
        // Opened from the picker: the session that is gone, with today's still listed.
        this.reset({
          sessions: [
            mockCompletedSession(now),
            ...earlier.filter((session) => session.id !== "ses_forgotten"),
            mockForgottenSession(now),
          ],
          currentId: "ses_forgotten",
          agents,
        });
        return;
      case "opening":
        this.reset({
          sessions: [
            mockCompletedSession(now),
            ...earlier.filter((session) => session.id !== "ses_forgotten"),
            mockOpeningSession(now),
          ],
          currentId: "ses_forgotten",
          agents,
        });
        return;
    }
  }

  /**
   * Fills the composer with a pre-written first message, sends nothing, and answers where
   * the caret goes: at the end of the starter's words, where the operator's own begin.
   *
   * **It never drops what the operator typed.** A box that begins with a starter (its
   * trailing whitespace aside) holds that starter and then the operator's words, so the
   * starter is swapped and their words kept: a second chip swaps the first, the same chip
   * twice changes nothing, and a URL typed after the program starter's `https://` stays one
   * URL. Anything else is the operator's — often a pasted statement of work, which is long
   * and may not be on the clipboard any more — so the starter goes in front of it, a blank
   * line between, and the caret stays at the starter's end. A starter that ends in
   * `https://` put in front of words that begin with a URL takes the URL as its own rather
   * than leaving a dangling `https://` on a line of its own.
   */
  useStarter(key: StarterKey): number {
    const starter = STARTERS[key].draft;
    const words = operatorWordsOf(this.draft).replace(/^\s+/u, "");
    if (words === "") {
      this.draft = starter;
      return starter.length;
    }
    const lead = starter.replace(/\s+$/u, "");
    if (lead.endsWith(SEED) && /^https?:\/\/\S/iu.test(words)) {
      const head = lead.slice(0, -SEED.length);
      this.draft = `${head}${words}`;
      return head.length;
    }
    if (lead !== starter) {
      this.draft = `${starter}${words}`;
      return lead.length;
    }
    this.draft = `${lead}\n\n${words}`;
    return lead.length;
  }
}
