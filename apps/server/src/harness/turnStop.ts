/**
 * A Stop's answer and refusal, in the words both conversation surfaces give (A6 F5).
 *
 * `modelSwitch.ts`'s arrangement: the importer and the goal conversation each decide which
 * session a Stop lands on, and the spine (`LiveAgentSessions.interrupt`) does the stopping,
 * so what is left — turning what the spine found into the contract's answer, with a sentence
 * — is the same for both and lives here once.
 */
import {
  ConversationStopRefused,
  type ConversationStopped,
} from "@bit/contracts";

import type { HarnessFailure } from "./agentHarness";
import type { LiveInterrupt } from "./liveAgentSessions";

/**
 * The answer to a Stop, from what the spine found.
 *
 * `what` names the conversation in a sentence, as the operator sees it from inside it —
 * "this session" for an importer, "this conversation" for a goal — never by its id: the
 * sentence is shown under the composer of the conversation it is about, and an id there
 * (`imp_…`) names nothing the operator can see (A6 U6 review). `conversationId` is the id
 * the Stop landed on, which for an importer may be a successor of the one addressed.
 *
 * `background` is whether background work still runs once the Stop was answered (A6 U6
 * review): an interrupted turn's Stop stops the background shells too
 * (`ClaudeCodeHarness.interruptSession`), and a screen that heard only "the turn is over"
 * would go on offering "Stop background work" until its next activity read.
 */
export const turnStopped = <Meta>(input: {
  readonly found: LiveInterrupt<Meta>;
  readonly conversationId: string;
  readonly what: string;
}): ConversationStopped => {
  const { found, conversationId, what } = input;
  switch (found._tag) {
    case "not_live":
      return {
        conversationId,
        outcome: "not_live",
        working: false,
        background: false,
        detail: `This server does not hold ${what}, so nothing of it is running here and there was nothing to stop.`,
      };
    case "idle":
      return {
        conversationId,
        outcome: "idle",
        working: false,
        background: false,
        detail: `Nothing was running in ${what}, so there was nothing to stop. It is waiting for your next message.`,
      };
    case "interrupted":
      return {
        conversationId,
        outcome: "interrupted",
        working: found.working,
        background: found.background,
        detail: interruptedDetail(found, what),
      };
    case "background":
      return {
        conversationId,
        outcome: "background_stopped",
        working: found.working,
        background: found.working,
        detail: found.working
          ? `No turn was running in ${what}, but work the agent had started in the background was. It was told to stop, and some of it had not stopped by the time this answered, so it may still be running; stop again to ask once more.`
          : `No turn was running in ${what}, but work the agent had started in the background was, and that is stopped now. Everything it wrote is kept, and your next message carries the conversation on in the same session.`,
      };
  }
};

/**
 * What an interrupted turn's answer says, from what the spine tracked rather than guessed.
 *
 * `working` alone only says the session was not idle within `INTERRUPT_SETTLE`; whether that
 * is because of a message the operator sent is `followUp`, and what the harness did with that
 * message is `queuedOnInterrupt` — Claude Code runs it at once, OpenCode holds it for the
 * next message (`V2(chat):` at `LiveAgentSessions.deliver`: no app-owned queue to hold it on
 * both alike). The operator is told which, because on OpenCode nothing on screen would.
 */
const interruptedDetail = <Meta>(
  found: Extract<LiveInterrupt<Meta>, { readonly _tag: "interrupted" }>,
  what: string,
): string => {
  const stopped = `Stopped the turn running in ${what}.`;
  if (found.followUp && found.entry.harness.queuedOnInterrupt === "held") {
    return `${stopped} The message you sent while it ran has not been answered: its harness is holding it, and will run it, ahead of your next message, when you send one. Everything written before the stop is kept.`;
  }
  if (found.working && found.followUp) {
    return `${stopped} Its harness went straight on to a message you sent while that turn ran, and is answering it now; stop again to stop that too.`;
  }
  // A `runs` harness that went on to the follow-up and finished it inside the settle: the
  // conversation is quiet again, and what it last said answers the operator's message.
  if (found.followUp) {
    return `${stopped} Its harness went straight on to the message you sent while that turn ran, and has answered it. Everything written before and after the stop is kept, and your next message carries the conversation on in the same session.`;
  }
  if (found.working) {
    return `${stopped} The turn is still finishing, so a little more may appear before it goes quiet. Everything it wrote is kept, and your next message carries the conversation on in the same session.`;
  }
  return `${stopped} Everything it wrote before the stop is kept, and your next message carries the conversation on in the same session.`;
};

/** A harness that would not acknowledge the Stop. The spine has closed the session. */
export const turnStopRefusal = (
  failure: HarnessFailure,
  what: string,
): ConversationStopRefused =>
  new ConversationStopRefused({
    reason: "harness_unreachable",
    detail: `The harness did not acknowledge the stop (${failure.message}), so whether the turn in ${what} stopped is uncertain. This server has let go of the session — its credential is revoked, so it can record nothing more — and your next message carries the conversation on in a session it holds again.`,
  });
