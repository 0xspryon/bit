/**
 * A goal conversation's prose, replayed from the harness after a reload.
 *
 * Sibling of `plan/roundNarration.ts` and built on the same accepted cost: nothing in this
 * build stores a word of a conversation (`docs/design/goal-and-planner-flow.md` decisions
 * 14 and 15), so the only other copy belongs to the **harness**, and this module asks for
 * it. Claude Code deletes its transcripts after about thirty days; an OpenCode session dies
 * with the server process that held it. For an older conversation, *gone* is the normal
 * answer and must read as one rather than as a fault.
 *
 * ## Five answers, and why the extra one exists
 *
 * A round always has a row saying it happened, so `roundNarration.ts` has three ways of
 * being empty. A conversation has a fourth: **nobody has said anything yet**. That is not
 * an absence of prose, it is an absence of a conversation, and a screen that reported it
 * with the harness's "I no longer hold that session" sentence would be telling an operator
 * their first message had been lost.
 *
 * `absent` is therefore its own source, and the four that remain mean exactly what they
 * mean for a round: `harness` with messages, `pending` while a live session has produced
 * nothing yet, `forgotten` for a session the harness will not or cannot answer about, and
 * `none` for a session it still knows and holds nothing under.
 *
 * ## `live` is a separate question from the source
 *
 * Whether **this process** holds the session is orthogonal to whether the harness still has
 * its prose, and the restart case is the pair that proves it: after a restart the recorded
 * session id is ours, Claude Code may still have every word of it on disk, and the
 * credential that let it do anything is gone — so the prose is `harness` and `live` is
 * false. The note is what explains that the conversation cannot be continued and that the
 * next message opens a new one. Collapsing the two would make a readable conversation look
 * resumable.
 *
 * ## The operator's words are kept; this server's framing above them is not
 *
 * A round's replay drops its own prompt whole: it is this server's assembly of the goal
 * briefing, the largest thing on the screen, and never the planner speaking. A
 * conversation's `user` entries are **the operator**, so dropping one would leave the agent
 * answering a question nobody can see — but the *first* of them is not only the operator.
 * The harness stores the opening prompt as one message, and that message is
 * `goalAgentPreamble` (about 2.4 KB of framing) with the operator's sentence at the bottom.
 * Replayed as it is, the preamble was the dominant content of the operator's own chat; a
 * review observed exactly that in the browser.
 *
 * So the framing is trimmed and the words are kept. **There is nothing to guess**, which an
 * earlier version of this comment claimed there was: `plan/goalPrompt.ts` ends the preamble
 * with {@link GOAL_PROMPT_DELIMITER}, a fixed string it writes itself, and appends the
 * operator's text after it unaltered — so {@link operatorTextOf} is an exact split. It is
 * the same technique `isRoundPromptText` uses one file over, and for the same reason.
 *
 * An entry with no delimiter in it is left exactly as it is: a later operator message
 * travels verbatim and has no framing to remove.
 */
import { Effect, type Duration } from "effect";

import type {
  GoalConversationMessage,
  GoalConversationView,
} from "@bit/contracts";

import { SESSION_NOT_FOUND_TAG } from "../harness/agentHarness";
import { operatorTextOf } from "./goalPrompt";
import type { HarnessResolver } from "../harness/resolver";

/** How long the harness is given to answer about one conversation. */
export const GOAL_NARRATION_FETCH_TIMEOUT: Duration.Input = "5 seconds";

/** How many messages one conversation's replay answers with before it says it stopped. */
export const GOAL_NARRATION_READ_LIMIT = 400;

/** What a goal's recorded session is, as this reader needs it. */
export interface RecordedGoalSession {
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string | null;
}

const empty = (input: {
  readonly targetId: string;
  readonly goalId: string;
  readonly harnessSessionId: string | null;
  readonly live: boolean;
  readonly source: "pending" | "forgotten" | "none" | "absent";
  readonly note: string;
  readonly at: number;
}): GoalConversationView => ({
  targetId: input.targetId,
  goalId: input.goalId,
  harnessSessionId: input.harnessSessionId,
  live: input.live,
  source: input.source,
  ephemeral: false,
  note: input.note,
  messages: [],
  truncated: false,
  // Nothing was left out, because nothing came back. A count here would imply there had
  // been something to count.
  omittedBlank: 0,
  at: input.at,
});

/**
 * What is said when the framing was trimmed off the operator's first message.
 *
 * Said rather than silent, for the reason every other omission on this shape is counted:
 * the operator's first message looks shorter here than the thing the agent was actually
 * given, and a reader comparing this screen against the harness's own log would otherwise
 * find a message that does not match.
 */
const FRAMING_NOTE =
  "Your first message is shown as you wrote it; the briefing this server puts above it for the agent is not replayed.";

/**
 * The sentence appended to every answer about a session this process does not hold.
 *
 * One string rather than one per source, because it is the same fact in every case and the
 * operator needs it whether the prose came back or not: this conversation is readable at
 * best and is not continuable.
 */
const RESTART_NOTE =
  " This conversation was opened by a server process that is no longer running, so nothing can be said to it: its agent's authority died with that process. Your next message starts a new conversation, and the agent in it will not have read any of this.";

/**
 * One goal conversation's narration, as the harness still has it.
 *
 * Never fails: every way of not having the prose is one of the five sources, with a
 * sentence. A reader of this cannot be made to render an error for a conversation whose
 * words the harness simply deleted.
 */
export const goalConversationNarration = Effect.fnUntraced(function* (input: {
  /**
   * The resolver, as a parameter rather than from the context.
   *
   * `roundNarration.ts`'s reason verbatim: a requirement yielded inside an HTTP handler
   * becomes a per-request requirement of the *route*. `undefined` is a server with no
   * harness configured at all, which is a different answer from a harness that would not
   * answer and is reported as such.
   */
  readonly resolver: HarnessResolver["Service"] | undefined;
  readonly targetId: string;
  readonly goalId: string;
  /** The session recorded for this goal, or `undefined` if none ever was. */
  readonly recorded: RecordedGoalSession | undefined;
  /** The session **this process** is holding for this goal, if any. */
  readonly liveSessionId: string | undefined;
  readonly limit?: number | undefined;
  readonly fetchTimeout?: Duration.Input | undefined;
}) {
  const at = Date.now();
  const limit = input.limit ?? GOAL_NARRATION_READ_LIMIT;
  const base = { targetId: input.targetId, goalId: input.goalId, at };

  if (input.recorded === undefined) {
    return empty({
      ...base,
      harnessSessionId: null,
      live: false,
      source: "absent",
      note: "Nobody has talked to this goal's agent yet. Your first message opens the conversation: a session is created for it, in this goal's own directory, with the goal's tools on it.",
    });
  }
  const sessionId = input.recorded.harnessSessionId;
  const live = input.liveSessionId === sessionId;
  const restart = live ? "" : RESTART_NOTE;

  if (input.resolver === undefined) {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      source: "forgotten",
      note: `This server has no agent harness configured, so session ${sessionId} cannot be asked about and no message can be sent.${restart}`,
    });
  }

  const resolved = yield* Effect.result(
    input.resolver.resolve(input.recorded.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      source: "forgotten",
      note: `${resolved.failure.message} This conversation's words can only come from the harness, so they are unavailable here. The goal's own record — its intents, its rounds and what they concluded — is unaffected.${restart}`,
    });
  }
  // A row naming a *different* instance is foreign and is not asked about at all: the
  // harness we do have would answer a confident "no such session" for a session that may
  // be alive elsewhere. `run/transcript.ts` and `roundNarration.ts` refuse the same
  // inference.
  if (
    input.recorded.harnessInstanceId !== null &&
    resolved.success.instance.instanceId !== input.recorded.harnessInstanceId
  ) {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      source: "forgotten",
      note: `This conversation ran on harness instance '${input.recorded.harnessInstanceId}', which this server does not configure, so its words cannot be asked for here.${restart}`,
    });
  }

  const displayName = resolved.success.instance.displayName;
  const fetched = yield* Effect.result(
    Effect.timeout(
      resolved.success.harness.messages(sessionId),
      input.fetchTimeout ?? GOAL_NARRATION_FETCH_TIMEOUT,
    ),
  );
  if (fetched._tag === "Failure") {
    const failure = fetched.failure;
    /**
     * "The harness has never heard of this session" and "we could not ask" are told apart
     * and said differently, which is what `SESSION_NOT_FOUND_TAG` is on the seam for. Both
     * are `forgotten` — the prose is not available either way — but an operator reading
     * "deleted after about thirty days" knows there is nothing to wait for, and one reading
     * "did not answer" knows there might be.
     */
    const deleted =
      failure._tag === "HarnessTransportError" &&
      (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      source: "forgotten",
      note: deleted
        ? `${displayName} no longer holds session ${sessionId}. Harnesses keep their own transcripts for a while and then delete them — Claude Code for about thirty days, and an OpenCode session dies with its server — so this is the normal answer for a conversation that has been left for a while.${restart}`
        : `${displayName} could not be asked about session ${sessionId} — ${failure.message} This is about reaching the harness, not about the conversation.${restart}`,
    });
  }

  if (fetched.success.length === 0) {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      source: live ? "pending" : "none",
      note: live
        ? `${displayName} holds nothing for this conversation yet. What the agent says will appear here as it says it.`
        : `${displayName} still holds session ${sessionId} and there are no messages under it: this conversation produced nothing. That is not the same as the harness having forgotten it.${restart}`,
    });
  }

  /**
   * The blanks, dropped and counted.
   *
   * The reduced shape has no text for a `tool_use` or `tool_result` block, so each one
   * arrives as an entry with an empty `text` and no error — on a real settled round that
   * was 15 of 21 rows, rendered as turns with nothing in them. An entry carrying an
   * `error` is **kept** even with no text: a failure with no prose is still the agent
   * telling us something.
   *
   * Unlike a round's replay, no `user` entry is dropped. See this module's header.
   */
  /**
   * The framing above the operator's first message, taken off before anything else.
   *
   * Before the blanks and before the limit, for `roundNarration.ts`'s reason in the same
   * position: an entry whose text is about to change size should change size before a
   * budget is spent on it. An entry with no delimiter is untouched, which is every entry
   * but one.
   */
  const trimmed = fetched.success.map((entry) => {
    const operator = operatorTextOf(entry.text);
    return operator === undefined ? entry : { ...entry, text: operator };
  });
  const framingOmitted = trimmed.some(
    (entry, index) => entry.text !== fetched.success[index]?.text,
  );
  const speaking = trimmed.filter(
    (entry) => entry.text.trim() !== "" || entry.error !== undefined,
  );
  const omittedBlank = trimmed.length - speaking.length;
  if (speaking.length === 0) {
    return {
      targetId: input.targetId,
      goalId: input.goalId,
      harnessSessionId: sessionId,
      live,
      // Still `harness`, not `none`: the harness **does** hold this session and did answer
      // about it. The conversation made tool calls and said nothing in words, which is a
      // real state, and reporting it as `none` would collapse it into "the harness held
      // nothing at all".
      source: "harness",
      ephemeral: true,
      note:
        `From ${displayName}, which may delete it. Nothing here is words: everything the harness holds for this conversation is ` +
        `${String(omittedBlank)} tool ${omittedBlank === 1 ? "call or result" : "calls and results"}, which the reduced replay shape carries no text for.` +
        (framingOmitted ? ` ${FRAMING_NOTE}` : "") +
        restart,
      messages: [],
      truncated: false,
      omittedBlank,
      at,
    } satisfies GoalConversationView;
  }

  /**
   * The newest messages, not the oldest.
   *
   * The opposite end from a round's replay, and deliberately: a round is read to find out
   * what it concluded, which is at its end, and a long conversation is read to pick up
   * where it left off — which is also at its end. Truncating from the front of a
   * conversation would hand an operator the first forty messages of a hundred and call it a
   * replay.
   */
  const kept =
    speaking.length > limit
      ? speaking.slice(speaking.length - limit)
      : speaking;
  return {
    targetId: input.targetId,
    goalId: input.goalId,
    harnessSessionId: sessionId,
    live,
    source: "harness",
    ephemeral: true,
    note:
      `From ${displayName}, which may delete it: this build stores no part of a conversation, so what is here lasts exactly as long as the harness keeps it.` +
      ` Replayed messages carry no tool arguments and no call ids, so a tool call and its result are not paired as they are live.` +
      (framingOmitted ? ` ${FRAMING_NOTE}` : "") +
      (omittedBlank > 0
        ? ` ${String(omittedBlank)} tool ${omittedBlank === 1 ? "call or result is" : "calls and results are"} left out: the reduced shape carries no text for them.`
        : "") +
      (kept.length < speaking.length
        ? ` Shortened to the most recent ${String(kept.length)} messages.`
        : "") +
      restart,
    messages: kept.map((entry, index): GoalConversationMessage => ({
      index,
      type: entry.type,
      text: entry.text,
      error: entry.error,
    })),
    truncated: kept.length < speaking.length,
    omittedBlank,
    at,
  } satisfies GoalConversationView;
});
