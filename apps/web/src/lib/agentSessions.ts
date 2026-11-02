/**
 * What the Agent sessions list says about a row, as pure functions of the server's view.
 *
 * Kept out of the component so the words are testable and so the component stays a layout:
 * the one decision in here that is not wording is {@link harnessOf}, which is where a session
 * whose harness this server no longer runs is *marked rather than hidden*.
 */
import type {
  AgentSessionKind,
  AgentSessionView,
  HarnessInstanceView,
} from "@bit/contracts";

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
 * Which in-memory destination a row has today, or `null` where it has none.
 *
 * A worker attempt has no screen of its own to open (the Workers page is a placeholder), so
 * its row is inert rather than leading somewhere that is not about it.
 */
export const destinationOf = (
  kind: AgentSessionKind,
): "importer" | "goal" | null =>
  kind === "importer" ? "importer" : kind === "goal" ? "goal" : null;
