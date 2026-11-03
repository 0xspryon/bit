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
 * `what` names the conversation in a sentence ("import imp_…", "goal g1's conversation");
 * `conversationId` is the id the Stop landed on, which for an importer may be a successor of
 * the one addressed.
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
        detail: `This server holds no session for ${what}, so nothing of it is running here and there was nothing to stop.`,
      };
    case "idle":
      return {
        conversationId,
        outcome: "idle",
        working: false,
        detail: `Nothing was running in ${what}'s session, so there was nothing to stop. It is waiting for your next message.`,
      };
    case "interrupted":
      return {
        conversationId,
        outcome: "interrupted",
        working: found.working,
        detail: found.working
          ? `Stopped the turn ${what} was taking. Its harness went straight on to a message you sent while that turn ran, and is answering it now; stop again to stop that too.`
          : `Stopped the turn ${what} was taking. Everything it wrote before the stop is kept, and your next message carries the conversation on in the same session.`,
      };
  }
};

/** A harness that would not acknowledge the Stop. The spine has closed the session. */
export const turnStopRefusal = (
  failure: HarnessFailure,
  what: string,
): ConversationStopRefused =>
  new ConversationStopRefused({
    reason: "harness_unreachable",
    detail: `The harness did not acknowledge the stop (${failure.message}), so whether ${what}'s turn stopped is uncertain. This server has let go of the session — its credential is revoked, so it can record nothing more — and your next message carries the conversation on in a session it holds again.`,
  });
