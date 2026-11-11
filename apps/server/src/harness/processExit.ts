/**
 * A harness process that died, said the same way on every driver (harness-instances slice 3
 * fix 2, M1), and marked as an exit — and whether a turn was running — on the narration
 * seam and the replay, so a screen tells it from a turn the harness failed (follow-ups B).
 *
 * Neither harness stores a death. Pi's session file and Claude Code's transcript hold what
 * was finished and stop; a thread read again after a crash would show a turn with no reply
 * and no reason. So a driver that sees its process die while a turn runs keeps one
 * {@link ProcessExit} per death, by session id, narrates it live as the harness's error, and
 * splices it into the session's replay ({@link withExits}) where it happened. Kept in memory
 * only: a restarted server shows none, which is the honest degradation — it does not know.
 */
import type { HarnessNarration, MessageEntry } from "./agentHarness";

/** One process exit, as the thread says it. */
export interface ProcessExit {
  readonly at: number;
  readonly message: string;
  /**
   * Whether a turn was running when it went (follow-ups B, item 1). Claude Code's driver
   * says only mid-turn exits, so always `true` there; Pi's also says a scope stopped for
   * memory between turns, which stopped no turn.
   */
  readonly duringTurn: boolean;
}

/** The entry type of a process exit, live and replayed. */
export const PROCESS_EXIT_ENTRY = "bit.process.exited";

/**
 * A replay with the process exits put where they happened: after every entry the harness
 * stored before the exit. Drawn as the harness's error, as the live narration drew it.
 */
export const withExits = (
  entries: readonly MessageEntry[],
  exits: readonly ProcessExit[],
): MessageEntry[] => {
  const out = [...entries];
  for (const exit of exits) {
    let at = out.length;
    while (at > 0 && (out[at - 1]?.at ?? -Infinity) > exit.at) at -= 1;
    out.splice(at, 0, {
      type: PROCESS_EXIT_ENTRY,
      text: "",
      error: exit.message,
      parts: [],
      model: undefined,
      at: exit.at,
      processExit: { duringTurn: exit.duringTurn },
    });
  }
  return out;
};

/**
 * A process exit as live narration: the harness's error marked as an exit, with no outcome
 * of its own.
 */
export const exitNarration = (exit: ProcessExit): HarnessNarration => ({
  type: PROCESS_EXIT_ENTRY,
  sequence: undefined,
  at: exit.at,
  outcome: undefined,
  detail: {
    _tag: "error",
    message: exit.message,
    processExit: { duringTurn: exit.duringTurn },
  },
});

/**
 * What a thread says of a process that died mid-turn, in the words Pi's driver says it.
 *
 * `process` names it ("The Claude Code process"); `how` is its signal or `code N`, or
 * `undefined` where the driver could not tell, and the sentence then says only that it
 * ended; `untaken` is how many messages were waiting in it, which went with it.
 */
export const processExitMessage = (input: {
  readonly process: string;
  readonly how: string | undefined;
  readonly untaken: number;
}): string =>
  `${input.process} running this session ${input.how === undefined ? "ended" : `exited (${input.how})`} while a turn was in flight. What it finished is kept; how the turn would have ended is not known.${
    input.untaken === 0
      ? ""
      : ` ${input.untaken === 1 ? "A message" : `${String(input.untaken)} messages`} sent while it ran had not been read yet, and went with it.`
  }`;
