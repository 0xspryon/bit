/**
 * A planner round's prose, replayed from the harness after a reload.
 *
 * ## Why this exists at all, and what it cannot promise
 *
 * A round's narration is **never written down** (`docs/design/goal-and-planner-flow.md`
 * decision 14). While a browser is attached it arrives live, on the in-process bus
 * `plan/planSupervisor.ts` publishes to; when the tab reloads, that channel has nothing to
 * replay, because it is a sliding buffer in a process that makes no durability claim. The
 * only other copy of what a round said belongs to the **harness**, and this module asks
 * for it.
 *
 * So the retention policy here is somebody else's. Claude Code deletes its local
 * transcripts after `cleanupPeriodDays` — 30 by default — and an OpenCode session lives
 * inside a server process that restarts. For an older round, *gone* is the normal answer.
 * That is the cost decision 14 accepted in exchange for not writing one row per token into
 * the same SQLite file a worker is recording observations into, and the reason the planner
 * view's structure comes from records (`plan.round.started` / `.settled`) while only its
 * prose comes from here.
 *
 * ## The four answers, and why none of them may be flattened
 *
 * `run/transcript.ts`'s `harnessTranscript` answers two ways: it has the harness's copy, or
 * it is `absent` with a sentence. That is right for an attempt, which also has *our* copy
 * to fall back on. It is not enough for a round, which has none — so this module keeps the
 * absences apart ({@link RoundNarrationSource}):
 *
 * - **`pending`** — the round is `running` and nothing has come back yet. The ordinary
 *   first second of a round.
 * - **`forgotten`** — the harness will not or cannot answer about the session. Not a
 *   failure, and specifically not reported as one.
 * - **`none`** — the harness answered, knows the session, and holds nothing under it; or
 *   the round never opened a session at all.
 *
 * `harnessTranscript` collapses the second and third of those into one "no longer
 * available" sentence, which for an attempt is harmless and for a round would mean an
 * operator could not tell a round that said nothing from a round whose words were deleted.
 * That is why this is a separate reader rather than a call into that one.
 *
 * ## The instance is honoured, not assumed
 *
 * A round recorded against a harness instance this process does not configure is **not**
 * asked about: asking the harness we do have would get a confident "no such session" for a
 * session that may be alive elsewhere. `run/transcript.ts` and `recovery/harnessStatus.ts`
 * both refuse that inference and this does too.
 */
import { Effect, type Duration } from "effect";

import type { RoundNarration, RoundNarrationMessage } from "@bit/contracts";

import { SESSION_NOT_FOUND_TAG } from "../harness/agentHarness";
import type { HarnessResolver } from "../harness/resolver";
import type { StoredRound } from "../persistence/store";

/**
 * How long the harness is given to answer about one round.
 *
 * `run/transcript.ts`'s `TRANSCRIPT_FETCH_TIMEOUT`, and the same reasoning: `messages`
 * buffers the whole log on the harness's side before this process sees a byte, so the only
 * bound available is on the ask. It is shorter here than there would be harmless — the
 * caller is a browser waiting on a screen — but it is the same five seconds, because the
 * round being asked about may be the one running right now and a harness busy driving it
 * is slower to answer, not broken.
 */
export const ROUND_NARRATION_FETCH_TIMEOUT: Duration.Input = "5 seconds";

/** How many messages one round's replay answers with before it says it stopped. */
export const ROUND_NARRATION_READ_LIMIT = 1_000;

/**
 * How many of a goal's rounds are replayed, newest first.
 *
 * **A budget on harness calls, not on rows.** Each round replayed is one request into the
 * harness, and a goal with a long planning history would otherwise turn opening its chat
 * into fifty of them. The rounds themselves are not budgeted: their rows come from
 * `goalRounds` and cost one statement for all of them, so a round past this limit still
 * has its separator, its status and its disposition — only its prose was not asked for,
 * and `GoalNarrationView.skipped` says how many.
 *
 * Eight: more than any goal has needed in practice, and small enough that the slowest
 * plausible case is eight concurrent asks rather than a page that does not load.
 */
export const GOAL_NARRATION_ROUND_LIMIT = 8;

/** Builds one of the three empty answers. */
const empty = (
  round: StoredRound,
  source: "pending" | "forgotten" | "none",
  note: string,
): RoundNarration => ({
  roundId: round.roundId,
  harnessSessionId: round.harnessSessionId,
  source,
  ephemeral: false,
  note,
  messages: [],
  truncated: false,
  // Nothing was left out, because nothing came back. The two figures are about a reply the
  // harness actually gave; reporting a count here would imply there had been something to
  // count.
  omittedBlank: 0,
  promptOmitted: false,
});

/**
 * One round's narration, as the harness still has it.
 *
 * Never fails: every way of not having the prose is one of the sources above, with a
 * sentence. A reader of this cannot be made to render an error for a round whose words the
 * harness simply deleted, because there is no error channel to render.
 */
export const roundNarration = Effect.fnUntraced(function* (input: {
  /**
   * The resolver, as a parameter rather than from the context.
   *
   * `run/transcript.ts`'s reason verbatim: a requirement yielded inside an HTTP handler
   * becomes a per-request requirement of the *route*, and the handler group resolves this
   * once where it is built.
   */
  readonly resolver: HarnessResolver["Service"];
  readonly round: StoredRound;
  readonly limit?: number | undefined;
  readonly fetchTimeout?: Duration.Input | undefined;
}) {
  const round = input.round;
  const limit = input.limit ?? ROUND_NARRATION_READ_LIMIT;
  const running = round.status === "running";

  if (round.harnessSessionId === null || round.harnessSessionId === "") {
    return empty(
      round,
      // A *running* round with no session recorded is a round mid-start: the row is written
      // before the harness session exists, so this is a moment rather than an absence.
      running ? "pending" : "none",
      running
        ? "This round is starting: its harness session does not exist yet, so there is nothing to ask for."
        : "This round never opened a harness session, so it produced no narration at all. It does not establish that nothing was recorded — its disposition and its intents are rows.",
    );
  }

  const resolved = yield* Effect.result(
    input.resolver.resolve(round.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") {
    return empty(
      round,
      "forgotten",
      `${resolved.failure.message} This round's prose can only come from the harness, so it is unavailable here. Its disposition and the intents it added are rows and are unaffected.`,
    );
  }
  // A row written before instances were recorded (`null`) resolves to the default, which is
  // the best available answer. A row naming a *different* instance is foreign and is not
  // asked about at all — see this module's header.
  if (
    round.harnessInstanceId !== null &&
    resolved.success.instance.instanceId !== round.harnessInstanceId
  ) {
    return empty(
      round,
      "forgotten",
      `This round ran on harness instance '${round.harnessInstanceId}', which this server does not configure, so its narration cannot be asked for here.`,
    );
  }

  const displayName = resolved.success.instance.displayName;
  const fetched = yield* Effect.result(
    Effect.timeout(
      resolved.success.harness.messages(round.harnessSessionId),
      input.fetchTimeout ?? ROUND_NARRATION_FETCH_TIMEOUT,
    ),
  );
  if (fetched._tag === "Failure") {
    const failure = fetched.failure;
    /**
     * "The harness has never heard of this session" and "we could not ask" are told apart
     * here and said differently, which is the distinction `agentHarness.ts` put
     * `SESSION_NOT_FOUND_TAG` on the seam for. Both are `forgotten` — the prose is not
     * available either way — but an operator reading "deleted after about thirty days"
     * knows there is nothing to wait for, and one reading "did not answer" knows there
     * might be.
     */
    const deleted =
      failure._tag === "HarnessTransportError" &&
      (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);
    return empty(
      round,
      "forgotten",
      deleted
        ? `${displayName} no longer holds session ${round.harnessSessionId}. Harnesses keep their own transcripts for a while and then delete them — Claude Code for about thirty days — so this is the normal answer for an older round. What it concluded is a row and is still below.`
        : `${displayName} could not be asked about session ${round.harnessSessionId} — ${failure.message} This is about reaching the harness, not about the round.`,
    );
  }
  if (fetched.success.length === 0) {
    return empty(
      round,
      running ? "pending" : "none",
      running
        ? `${displayName} holds nothing for this round yet. It has only just been prompted; what it says will appear here as it says it.`
        : `${displayName} still holds this round's session and there are no messages under it: this round produced no narration. That is not the same as the harness having forgotten it.`,
    );
  }

  /**
   * What the harness holds, minus the two things that are not the round talking.
   *
   * **The prompt first, then the blanks, and only then the limit** — the order matters,
   * because a limit applied before the omissions would spend the budget on entries that are
   * about to be dropped.
   *
   * *The prompt.* The round's own prompt is this server's assembly of the goal's objective
   * and the whole goal briefing, sent as the session's only user message. It is the largest
   * thing on the screen and the one message that is never the planner speaking; the same
   * bytes are already on the page in the briefing panel.
   *
   * **It is found by kind, not by position, because the order is the harness's and the two
   * drivers disagree.** Claude Code replays it first; OpenCode's `message.list` answers in
   * whatever order it answers in, and a round replayed from it read `idle`, `assistant`,
   * `user(the prompt)` — the prompt **last**. A filter that looked at index 0 therefore
   * worked on one driver and left the whole briefing in the chat on the other, which is the
   * one this server defaults to. So the **first `user` entry wherever it sits** is dropped:
   * for a round that is our prompt by construction, since the operator cannot prompt a
   * round. Only one is dropped, so a steering directive injected later (slice 9, decision
   * 12) still appears whichever side of the prompt the harness happens to return it.
   *
   * *The blanks.* The reduced shape has no text for a `tool_use` or `tool_result` block, so
   * each one became an entry with an empty `text` and no error — 15 of 21 rows on a real
   * settled round, rendered as turns with nothing in them, with the round's three actual
   * sentences buried among them. An entry carrying an `error` is **kept** even with no
   * text: a failure with no prose is still the round telling us something.
   */
  const promptAt = fetched.success.findIndex(
    // A `user` entry with **text**. Claude Code's `tool_result` blocks are also `user`
    // entries and the reduction leaves them empty, so matching on the type alone would
    // claim the first tool result as the prompt — dropping one blank as "the prompt" and
    // reporting the rest as blanks, which is two wrong figures from one wrong guess. Our
    // prompt is never empty: it is an objective plus a whole briefing.
    (entry) => entry.type === "user" && entry.text.trim() !== "",
  );
  const withoutPrompt =
    promptAt < 0
      ? fetched.success
      : [
          ...fetched.success.slice(0, promptAt),
          ...fetched.success.slice(promptAt + 1),
        ];
  const promptOmitted = promptAt >= 0;
  const speaking = withoutPrompt.filter(
    (entry) => entry.text.trim() !== "" || entry.error !== undefined,
  );
  const omittedBlank = withoutPrompt.length - speaking.length;
  if (speaking.length === 0) {
    /*
     * Everything the harness held was our prompt and its tool blocks.
     *
     * Still `harness`, not `none`: the harness **does** hold this round's session and did
     * answer about it. The round made calls and said nothing in words, which is a real
     * outcome, and reporting it as `none` would claim the harness held nothing at all —
     * collapsing it into the case the three sources exist to keep apart.
     */
    return {
      roundId: round.roundId,
      harnessSessionId: round.harnessSessionId,
      source: "harness",
      ephemeral: true,
      note:
        `From ${displayName}, which may delete it. This round narrated no words: everything it holds is ` +
        `${promptOmitted ? "the prompt we sent and " : ""}${String(omittedBlank)} tool ${omittedBlank === 1 ? "call or result" : "calls and results"}, ` +
        `which the reduced replay shape carries no text for. A round this tab watched live shows them in full.`,
      messages: [],
      truncated: false,
      omittedBlank,
      promptOmitted,
    } satisfies RoundNarration;
  }

  const kept = speaking.slice(0, limit);
  return {
    roundId: round.roundId,
    harnessSessionId: round.harnessSessionId,
    source: "harness",
    ephemeral: true,
    /**
     * Two things an operator has to know about what is on screen, in one sentence each.
     *
     * That it can be gone tomorrow — it is the harness's copy and this build keeps none of
     * its own — and that it is the **reduced** `{ type, text, error }` shape, so the paired
     * tool blocks a live round shows are not here. The second is the one a reader would
     * otherwise read as a round having done less than it did.
     */
    note:
      `From ${displayName}, which may delete it: this build does not store a round's narration, so what is here lasts exactly as long as the harness keeps it.` +
      ` Replayed messages carry no tool arguments and no call ids, so a tool call and its result are not paired as they are live.` +
      (promptOmitted
        ? ` The prompt this round was given is not replayed here; the briefing panel on this page is the same text.`
        : "") +
      (omittedBlank > 0
        ? ` ${String(omittedBlank)} tool ${omittedBlank === 1 ? "call or result is" : "calls and results are"} left out: the reduced shape carries no text for them.`
        : "") +
      (speaking.length > kept.length
        ? ` Shortened: not every message is shown.`
        : ""),
    messages: kept.map((entry, index): RoundNarrationMessage => ({
      index,
      type: entry.type,
      text: entry.text,
      error: entry.error,
    })),
    truncated: speaking.length > kept.length,
    omittedBlank,
    promptOmitted,
  } satisfies RoundNarration;
});
