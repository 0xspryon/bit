/**
 * The words of importer messages that did not land where the operator sent them, kept per
 * session (U8 review 3 and 4).
 *
 * The composer's draft is the page's, not a session's, so a message whose answer comes back
 * after the operator has left its session has nowhere to go: the box on screen holds other
 * words, or belongs to another conversation. Its words are **parked** on the session they
 * were sent from, which the session list then marks, and given back when that session is
 * opened. Two outcomes are parked, and never confused:
 *
 * - `refused`: the server answered, and said no. Nothing was sent ("Not sent").
 * - `unknown`: no answer came back. The server may have taken the message — opened a
 *   session for it, even — before the connection failed, so sending the words again may
 *   send them twice ("Not confirmed"). The page reads the list once more to find out.
 *
 * **Kept in this tab.** Every return to the importer page starts it afresh (`begin`), which
 * used to drop them; so they are mirrored into `sessionStorage`, per server and target, and
 * read back there. A reload and in-app navigation keep them; another tab, or closing this
 * one, does not. A store that throws (blocked site data) keeps them as long as the page.
 */
// V2(chat): parked words live in this tab's `sessionStorage` only, because the draft is the
// page's (`ImporterSessions.draft`) and a session has none of its own. V2 keeps a draft per
// session on the server, which makes parked words an ordinary draft: they would follow the
// operator to another tab or browser, and "Not sent" would be a draft's state, not a copy.
import { Option, Schema } from "effect";

/** A message's words that were not delivered, or not known to be. */
export interface ParkedMessage {
  readonly text: string;
  /** What the page says when they are given back: the server's sentence, or ours. */
  readonly detail: string;
  readonly outcome: "refused" | "unknown";
  /**
   * Set on a **first** message's words only. The session it was typed in was the page's own
   * empty one, which no server lists and the next visit does not have: this is what it is
   * drawn again from — when it was started, and the agent the chip had picked for it.
   */
  readonly first?: {
    readonly startedAt: number;
    readonly agentId?: string;
  };
}

/** Parked words by the id of the session they wait on. */
export type ParkedMessages = Readonly<Record<string, ParkedMessage>>;

/** Where parked words are kept. The browser's {@link browserParkedStore}, or a test's own. */
export interface ParkedStore {
  read(serverUrl: string, targetId: string): ParkedMessages;
  write(serverUrl: string, targetId: string, parked: ParkedMessages): void;
}

const Parked = Schema.Record(
  Schema.String,
  Schema.Struct({
    text: Schema.String,
    detail: Schema.String,
    outcome: Schema.Literals(["refused", "unknown"]),
    first: Schema.optionalKey(
      Schema.Struct({
        startedAt: Schema.Number,
        agentId: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);
const decodeParked = Schema.decodeUnknownOption(Schema.fromJsonString(Parked));

/** One key per server and target, as `importerModelMemory.ts` keys a remembered pick. */
const keyOf = (serverUrl: string, targetId: string): string =>
  `bit.importerParked:${JSON.stringify([serverUrl, targetId])}`;

/** {@link ParkedStore} over `sessionStorage`. Every failure to read or write is a no-op. */
export const browserParkedStore: ParkedStore = {
  read(serverUrl, targetId) {
    try {
      const stored = globalThis.sessionStorage?.getItem(
        keyOf(serverUrl, targetId),
      );
      if (stored === null || stored === undefined) return {};
      return Option.getOrElse(decodeParked(stored), () => ({}));
    } catch {
      return {};
    }
  },
  write(serverUrl, targetId, parked) {
    try {
      const key = keyOf(serverUrl, targetId);
      if (Object.keys(parked).length === 0) {
        globalThis.sessionStorage?.removeItem(key);
      } else {
        globalThis.sessionStorage?.setItem(key, JSON.stringify(parked));
      }
    } catch {
      // Blocked site data: they last as long as the page, as they did before.
    }
  },
};

/** How a session holding parked words is marked: its row's label, and its accessible name. */
export const parkedMark = (parked: Pick<ParkedMessage, "outcome">): string =>
  parked.outcome === "refused" ? "Not sent" : "Not confirmed";

/** How much of the parked words a row shows, to tell two parked rows apart. */
const START_MAX = 60;

/** The start of parked words, on one line: what a row and its tooltip quote. */
export const parkedStart = (text: string): string => {
  const line = [...text.replace(/\s+/gu, " ").trim()];
  return line.length > START_MAX
    ? `${line.slice(0, START_MAX).join("")}…`
    : line.join("");
};
