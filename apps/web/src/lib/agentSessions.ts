/**
 * What the Agent sessions list says about a row, as pure functions of the server's view.
 *
 * Kept out of the component so the words are testable and so the component stays a layout:
 * the one decision in here that is not wording is {@link harnessOf}, which is where a session
 * whose harness this server no longer runs is *marked rather than hidden*, and
 * {@link placeOfSession}, which is where a row's destination became an address.
 */
import type {
  AgentSessionKind,
  AgentSessionView,
  HarnessInstanceView,
} from "@bit/contracts";

import type { Place } from "./place";

export const KIND_LABEL: Record<AgentSessionKind, string> = {
  goal: "Goal",
  importer: "Importer",
  worker: "Worker",
};

/**
 * The state's word, with the kind's own word beside it where the kind has one.
 *
 * Three states, three sentences. **`Not running` is `dormant`, and it is not "ended"**: this
 * server is not holding the session — every goal conversation after a restart, an importer
 * session a shutdown closed — and nothing recorded that its authority was over for good, so a
 * message reopens it. `Ended` is the other fact: the operator ended it and it stays ended.
 * The words differ on purpose; the composer's disabled states rely on the same difference.
 */
export const stateLabel = (
  session: Pick<AgentSessionView, "state" | "detail">,
): string => {
  const reason =
    session.detail === null ? "" : ` · ${session.detail.replaceAll("_", " ")}`;
  switch (session.state) {
    case "live":
      return "Live";
    case "ended":
      return `Ended${reason}`;
    case "dormant":
      return `Not running${reason}`;
  }
};

export const stateTitle = (
  session: Pick<AgentSessionView, "state">,
): string => {
  switch (session.state) {
    case "live":
      return "This server is holding the session right now: its scope and credential are open, whether or not a turn is running.";
    case "ended":
      return "Ended for good: the session's authority is over and its writes are refused. Sending a message does not reopen it.";
    case "dormant":
      return "This server is not holding the session, and nothing recorded the operator ending it. It may still exist in its harness; sending a message reopens it.";
  }
};

/**
 * The harness a row ran on: its name, and whether this server still runs it.
 *
 * **Stranded is decided against a loaded listing only.** Before the harness listing arrives
 * every instance is merely unknown, and calling a live session's harness "gone" for the
 * length of a round trip would be wrong. A row recorded with no instance has nothing to
 * compare, and is named as unrecorded rather than flagged. The same rule the importer's own
 * picker uses (`App.#indexedSessions`).
 */
export const harnessOf = (
  session: Pick<AgentSessionView, "harnessInstanceId">,
  harnesses: readonly Pick<HarnessInstanceView, "instanceId" | "displayName">[],
  loaded: boolean,
): { readonly name: string; readonly strandedOn: string | undefined } => {
  const id = session.harnessInstanceId;
  if (id === null)
    return { name: "Harness not recorded", strandedOn: undefined };
  const listed = harnesses.find((entry) => entry.instanceId === id);
  return {
    name: listed?.displayName ?? id,
    strandedOn: loaded && listed === undefined ? id : undefined,
  };
};

/** "2 in · 1 out · 1 asset", or null for a kind that derives no tally. */
export const tallySentence = (
  tally: AgentSessionView["tally"],
): string | null =>
  tally === null
    ? null
    : `${String(tally.entriesIn)} in · ${String(tally.entriesOut)} out · ${String(tally.assets)} ${tally.assets === 1 ? "asset" : "assets"}`;

/**
 * The place a row leads to, or `null` for a row that leads nowhere.
 *
 * One function rather than a destination name the component then turns into an address: the
 * href a row carries and the place a click applies are the same answer, and two functions
 * could disagree about which id a kind is addressed by. They are different ids —
 * `sessionId` for an importer session, because the chat is addressed by the conversation;
 * `subjectId` for a goal, because the session is about a goal and the goal is the resource —
 * which is precisely the sort of thing that goes wrong twice if it is decided twice.
 *
 * **A worker attempt leads nowhere, and that is not an oversight.** The grammar has a path
 * for one, `/t/<targetId>/attempts/<attemptId>`, and following it opens that transcript. But
 * the Workers section lists nothing yet, so a row here is the only place an attempt could be
 * clicked from, and the design keeps that row inert rather than let this list become half of
 * the attempt list Flow B owns. The path stays inbound-only: a link to an attempt works, and
 * nothing in the app writes one.
 */
export const placeOfSession = (
  session: Pick<AgentSessionView, "kind" | "sessionId" | "subjectId">,
  targetId: string,
): Place | null => {
  switch (session.kind) {
    case "importer":
      return { kind: "chat", targetId, sessionId: session.sessionId };
    case "goal":
      return { kind: "goal", targetId, goalId: session.subjectId };
    case "worker":
      return null;
  }
};
