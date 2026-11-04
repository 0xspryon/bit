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
 * **It is not only the first entry any more.** Slice 11 put an attachment list above the
 * same delimiter on *every* message of a goal that has files attached
 * (`plan/goalPrompt.ts`'s header has the two reasons), so a conversation can have framing
 * on several of its `user` entries and a long one can have it on all of them. Nothing here
 * needed changing — the trim is per entry and the delimiter is the same string — but the
 * count is now *n* rather than one, which is why {@link FRAMING_NOTE} does not promise that
 * only the first message was trimmed. An entry with no delimiter in it is still left
 * exactly as it is: a later message on a goal with no attachments travels verbatim and has
 * nothing to remove.
 */
import { Effect, type Duration } from "effect";

import type { GoalConversationView } from "@bit/contracts";

import { SESSION_NOT_FOUND_TAG } from "../harness/agentHarness";
import { operatorTextOf } from "./goalPrompt";
import type { HarnessResolver } from "../harness/resolver";
import { projectReplay } from "../run/liveTranscript";

/** How long the harness is given to answer about one conversation. */
export const GOAL_NARRATION_FETCH_TIMEOUT: Duration.Input = "5 seconds";

/** How many items one conversation's replay answers with before it says it stopped (newest kept). */
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
  items: [],
  truncated: false,
  // Nothing was left out, because nothing came back. A count here would imply there had
  // been something to count.
  omittedBlank: 0,
  at: input.at,
});

/**
 * What is said when framing was trimmed off one or more of the operator's own messages.
 *
 * Said rather than silent, for the reason every other omission on this shape is counted: a
 * trimmed message looks shorter here than the thing the agent was actually given, and a
 * reader comparing this screen against the harness's own log would otherwise find a message
 * that does not match.
 *
 * **"Your messages", not "your first message".** It was the first one only while the
 * preamble was the one thing this server put above a message. Since slice 11 a goal with
 * files attached carries the attachment list above the same delimiter on every turn, so the
 * trim can touch several entries — and a sentence naming only the first would be the
 * understatement this note exists to prevent.
 */
const FRAMING_NOTE =
  "Your messages are shown as you wrote them; what this server puts above them for the agent — the opening briefing, and the list of any files you have attached — is not replayed.";

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
   * The framing above each of the operator's messages, taken off before anything else.
   *
   * Before the blanks and before the limit, for `roundNarration.ts`'s reason in the same
   * position: an entry whose text is about to change size should change size before a
   * budget is spent on it. An entry with no delimiter is untouched — which is every entry
   * on a goal with no files attached but the first, and may be no entry at all on one that
   * has had files attached from the start. See this module's header.
   */
  const trimmed = fetched.success.map((entry) => {
    const operator = operatorTextOf(entry.text);
    return operator === undefined ? entry : { ...entry, text: operator };
  });
  const framingOmitted = trimmed.some(
    (entry, index) => entry.text !== fetched.success[index]?.text,
  );
  /*
   * The conversation as the live stream's own items (A6 F10): the operator's words, the
   * agent's replies, thinking and tool calls with their results. What produced no item at all
   * is counted in `omittedBlank`. Unlike a round's replay, no `user` entry is dropped.
   */
  const { items, blank } = projectReplay({
    entries: trimmed,
    subject: { _tag: "goal", goalId: input.goalId },
    harnessSessionId: sessionId,
    users: "operator",
    fallbackAt: at,
  });
  if (items.length === 0) {
    return {
      targetId: input.targetId,
      goalId: input.goalId,
      harnessSessionId: sessionId,
      live,
      // Still `harness`, not `none`: the harness **does** hold this session and did answer
      // about it. Everything it holds is empty, which is a real state, and reporting it as
      // `none` would collapse it into "the harness held nothing at all".
      source: "harness",
      ephemeral: true,
      note:
        `From ${displayName}, which may delete it. Nothing here can be shown: everything the harness holds for this conversation is ` +
        `${String(blank)} empty ${blank === 1 ? "message" : "messages"}.` +
        (framingOmitted ? ` ${FRAMING_NOTE}` : "") +
        restart,
      items: [],
      truncated: false,
      omittedBlank: blank,
      at,
    } satisfies GoalConversationView;
  }

  /**
   * The newest items, not the oldest.
   *
   * The opposite end from a round's replay, and deliberately: a round is read to find out
   * what it concluded, which is at its end, and a long conversation is read to pick up
   * where it left off — which is also at its end. Truncating from the front of a
   * conversation would hand an operator the first forty messages of a hundred and call it a
   * replay.
   */
  const kept = items.length > limit ? items.slice(items.length - limit) : items;
  return {
    targetId: input.targetId,
    goalId: input.goalId,
    harnessSessionId: sessionId,
    live,
    source: "harness",
    ephemeral: true,
    note:
      `From ${displayName}, which may delete it: this build stores no part of a conversation, so what is here lasts exactly as long as the harness keeps it.` +
      (framingOmitted ? ` ${FRAMING_NOTE}` : "") +
      (blank > 0
        ? ` ${String(blank)} empty ${blank === 1 ? "message is" : "messages are"} left out.`
        : "") +
      (kept.length < items.length
        ? ` Shortened to the most recent ${String(kept.length)} items.`
        : "") +
      restart,
    items: kept,
    truncated: kept.length < items.length,
    omittedBlank: blank,
    at,
  } satisfies GoalConversationView;
});
