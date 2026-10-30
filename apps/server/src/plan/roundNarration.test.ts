/**
 * The four answers a round's narration can come back with, and why none may be one.
 *
 * Narration is never stored (`docs/design/goal-and-planner-flow.md` decision 14), so this
 * reader is the whole of what a reloaded planner view can show — and its interesting
 * answers are the empty ones. An operator looking at a round with no prose has to be able
 * to tell "it has only just started" from "the harness deleted it" from "it genuinely said
 * nothing", because the first is worth waiting for and the other two are not. Every test
 * here is about keeping those apart.
 *
 * There is no error channel to assert on, which is itself the point: a round whose words
 * the harness has thrown away is the *expected* state of anything a month old, and a reader
 * that could be made to render a failure for it would make the common case look like a
 * fault.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import { STUB_INSTANCE, stubHarness } from "../harness/stubHarness";
import type { MessageEntry } from "../harness/agentHarness";
import type { StoredRound } from "../persistence/store";

import { roundNarration } from "./roundNarration";
import {
  assembleRoundPrompt,
  assembleSteerPrompt,
  ROUND_PROMPT_MARKER,
} from "./roundPrompt";

const AT = 1_700_000_000_000;

/**
 * The text a real round's prompt has, built from the module the filter is written against.
 *
 * **Not a hand-typed excerpt, and that is the lesson `mcpToolName.ts` already records**: the
 * replay recognises the prompt by its own opening sentence, so a fixture that typed an
 * approximation of that sentence would be asserting the implementation against a string the
 * system never produces. Built here, it cannot drift from `assembleRoundPrompt`, and if the
 * preamble's first line ever changes these tests fail rather than silently testing nothing.
 */
const PROMPT = assembleRoundPrompt({
  goalId: "goal_1",
  budget: 5,
  briefing: "THE WHOLE GOAL BRIEFING",
}).prompt;

/** A steer, in the form `PlanSupervisor.steer` really delivers one. */
const STEER = assembleSteerPrompt("focus on the lockout path");

const round = (over: Partial<StoredRound> = {}): StoredRound => ({
  roundId: "rnd_1",
  goalId: "goal_1",
  targetId: "alpha",
  status: "settled",
  writeFence: 1,
  harnessSessionId: "ses_1",
  harnessInstanceId: STUB_INSTANCE.instanceId,
  providerId: "stub",
  modelId: "model",
  startedAtSequence: 4,
  budget: 5,
  disposition: "actionable",
  dispositionRationale: "Two dimensions had no work out.",
  startedAt: AT,
  endedAt: AT + 1_000,
  ...over,
});

/** Reads one round against a harness whose `messages` does whatever a test needs. */
const read = (
  over: Partial<StoredRound>,
  messages: () => Effect.Effect<readonly MessageEntry[], HarnessTransportError>,
  limit?: number,
) =>
  Effect.runPromise(
    roundNarration({
      resolver: HarnessResolver.fromEntries([
        { instance: STUB_INSTANCE, harness: stubHarness({ messages }) },
      ]),
      round: round(over),
      ...(limit === undefined ? {} : { limit }),
    }),
  );

const entries = (count: number): readonly MessageEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    type: index === 0 ? "assistant" : "tool",
    text: `entry ${String(index)}`,
    error: undefined,
  }));

describe("a round whose prose the harness still has", () => {
  test("it comes back reduced, marked ephemeral, and says both of those things", async () => {
    const answer = await read({}, () => Effect.succeed(entries(2)));

    expect(answer.source).toBe("harness");
    expect(answer.messages.map((message) => message.index)).toEqual([0, 1]);
    expect(answer.messages[0]?.text).toBe("entry 0");
    // The harness's copy, so it can be gone tomorrow. The flag exists so a reader cannot
    // present this and a durable record as the same kind of thing.
    expect(answer.ephemeral).toBe(true);
    expect(answer.note).toContain("may delete it");
    // And the cost decision 14 accepted, stated rather than left to be noticed: the shape
    // is `{ type, text, error }`, so a call and its result do not reconstruct.
    expect(answer.note).toContain("not paired");
    expect(answer.truncated).toBe(false);
    expect(answer.omittedBlank).toBe(0);
    expect(answer.promptOmitted).toBe(false);
  });

  test("a long round is shortened and says so", async () => {
    const answer = await read({}, () => Effect.succeed(entries(5)), 2);

    expect(answer.messages.length).toBe(2);
    expect(answer.truncated).toBe(true);
    expect(answer.note).toContain("Shortened");
  });
});

describe("what is left out of a replay, and said", () => {
  /*
   * The regression these guard, observed on every settled round: 15 of 21 replayed rows
   * were an `<li>` holding nothing but the word ASSISTANT or USER, with the round's three
   * actual sentences buried among them — a blank presented as content, which a reader
   * cannot tell from a turn in which the planner said nothing. Plus the entire planner
   * prompt, thousands of characters of goal briefing, as the first turn of the
   * conversation on every reload.
   */

  test("tool blocks the reduced shape has no text for are left out and counted", async () => {
    const answer = await read({}, () =>
      Effect.succeed([
        {
          type: "assistant",
          text: "two dimensions are untested",
          error: undefined,
        },
        // A `tool_use` block: the reduction keeps its type and has no text for it.
        { type: "assistant", text: "", error: undefined },
        { type: "user", text: "", error: undefined },
        {
          type: "assistant",
          text: "recording the disposition",
          error: undefined,
        },
      ]),
    );

    expect(answer.messages.map((message) => message.text)).toEqual([
      "two dimensions are untested",
      "recording the disposition",
    ]);
    expect(answer.omittedBlank).toBe(2);
    // Counted rather than silent: an omission a reader cannot count is indistinguishable
    // from a round that said less than it did.
    expect(answer.note).toContain("2 tool calls and results are left out");
    // The index is a position in **this answer**, assigned after the omissions, which is
    // what its contract now says it is.
    expect(answer.messages.map((message) => message.index)).toEqual([0, 1]);
  });

  test("an entry with an error but no text is kept, because it is still the round talking", async () => {
    const answer = await read({}, () =>
      Effect.succeed([
        { type: "assistant", text: "", error: "the tool call failed" },
      ]),
    );

    expect(answer.messages).toHaveLength(1);
    expect(answer.messages[0]?.error).toBe("the tool call failed");
    expect(answer.omittedBlank).toBe(0);
  });

  test("the round's own prompt is not replayed as conversation", async () => {
    const answer = await read({}, () =>
      Effect.succeed([
        // Our prompt: the goal's objective plus the whole briefing, and the one message
        // that is never the planner speaking. The briefing panel on the same page is the
        // same text.
        { type: "user", text: PROMPT, error: undefined },
        {
          type: "assistant",
          text: "two dimensions are untested",
          error: undefined,
        },
      ]),
    );

    expect(answer.promptOmitted).toBe(true);
    expect(answer.messages.map((message) => message.text)).toEqual([
      "two dimensions are untested",
    ]);
    expect(answer.note).toContain("not replayed here");
    expect(answer.note).toContain("briefing panel");
  });

  test("the prompt is found wherever the harness puts it, including last", async () => {
    /*
     * The regression this is for, and the reason the filter is not positional: the order of
     * a replay is the harness's, and the two drivers disagree. Claude Code returns the
     * prompt first; OpenCode's `message.list` returned it **last**, after an `idle` and an
     * `assistant` entry — read out of a live round's DOM — so a filter that looked at index
     * 0 left the entire goal briefing in the chat on the driver this server defaults to.
     */
    const answer = await read({}, () =>
      Effect.succeed([
        {
          type: "idle",
          text: "The usage limit has been reached",
          error: undefined,
        },
        {
          type: "assistant",
          text: "The usage limit has been reached",
          error: undefined,
        },
        { type: "user", text: PROMPT, error: undefined },
      ]),
    );

    expect(answer.promptOmitted).toBe(true);
    expect(answer.messages.map((message) => message.text)).toEqual([
      "The usage limit has been reached",
      "The usage limit has been reached",
    ]);
    expect(answer.note).toContain("not replayed here");
  });

  test("an empty user entry is a tool result, not the prompt", async () => {
    // Claude Code's `tool_result` blocks are `user` entries the reduction leaves empty. A
    // filter matching on the type alone would drop the first of them as "the prompt" and
    // count the rest as blanks — two wrong figures from one wrong guess. Our prompt is never
    // empty: it is an objective plus a whole briefing.
    const answer = await read({}, () =>
      Effect.succeed([
        { type: "assistant", text: "calling add_intent", error: undefined },
        { type: "user", text: "", error: undefined },
        { type: "user", text: "", error: undefined },
      ]),
    );

    expect(answer.promptOmitted).toBe(false);
    expect(answer.omittedBlank).toBe(2);
    expect(answer.messages.map((message) => message.text)).toEqual([
      "calling add_intent",
    ]);
  });

  test("a replay with no user entry at all omits no prompt and says so", async () => {
    const answer = await read({}, () =>
      Effect.succeed([
        {
          type: "assistant",
          text: "two dimensions are untested",
          error: undefined,
        },
      ]),
    );

    expect(answer.promptOmitted).toBe(false);
    expect(answer.note).not.toContain("not replayed here");
    expect(answer.messages).toHaveLength(1);
  });

  test("the prompt is dropped and a steer is kept, in either order", async () => {
    /*
     * The regression that made the rule content-based rather than positional.
     *
     * Steering injects a second `user` entry into the same session (DECISIONS.md §24.1),
     * and on OpenCode's ordering it can sort **before** the prompt. The old rule — "the
     * first non-blank `user` entry, wherever it sits" — then dropped the *directive* and
     * replayed the entire goal briefing as conversation: both halves wrong from one guess.
     * So the assertion runs both ways round, and checks which of the two survived rather
     * than only how many did.
     */
    for (const order of [
      [PROMPT, STEER],
      [STEER, PROMPT],
    ] as const) {
      const answer = await read({}, () =>
        Effect.succeed([
          { type: "assistant", text: "thinking", error: undefined },
          ...order.map((text) => ({ type: "user", text, error: undefined })),
        ]),
      );

      expect(answer.promptOmitted).toBe(true);
      expect(answer.messages).toHaveLength(2);
      const user = answer.messages.filter((message) => message.type === "user");
      expect(user).toHaveLength(1);
      // The steer, by its own text. "One survived" was true of the broken rule too.
      expect(user[0]?.text).toBe(STEER);
      expect(user[0]?.text).not.toContain(ROUND_PROMPT_MARKER);
    }
  });

  test("two steers and no prompt drop nothing and say no prompt was omitted", async () => {
    // More than one steer into one round is not tested against a driver (DECISIONS.md
    // §24.1's "not tested" list) and is perfectly possible — the goal agent may send two.
    // Neither is our prompt, so neither is dropped, and the note must not claim a prompt
    // was left out of a replay that never held one.
    const answer = await read({}, () =>
      Effect.succeed([
        { type: "user", text: STEER, error: undefined },
        { type: "assistant", text: "adjusting", error: undefined },
        {
          type: "user",
          text: assembleSteerPrompt("and ignore the admin console"),
          error: undefined,
        },
      ]),
    );

    expect(answer.promptOmitted).toBe(false);
    expect(answer.messages).toHaveLength(3);
    expect(answer.note).not.toContain("not replayed here");
  });

  test("a user entry from another goal's prompt is not mistaken for this round's", async () => {
    // The discriminator is the marker **and** this round's goal id, so a session lineage
    // reused across goals cannot have one goal's prompt dropped out of another's replay.
    const answer = await read({}, () =>
      Effect.succeed([
        {
          type: "user",
          text: assembleRoundPrompt({
            goalId: "goal_other",
            budget: 5,
            briefing: "A DIFFERENT GOAL",
          }).prompt,
          error: undefined,
        },
      ]),
    );

    expect(answer.promptOmitted).toBe(false);
    expect(answer.messages).toHaveLength(1);
  });

  test("a round that made calls and said nothing is still `harness`, not `none`", async () => {
    // The harness **does** hold this session and did answer about it. Reporting `none`
    // would claim it held nothing at all, collapsing it into the case the four sources
    // exist to keep apart.
    const answer = await read({}, () =>
      Effect.succeed([
        { type: "user", text: PROMPT, error: undefined },
        { type: "assistant", text: "", error: undefined },
        { type: "user", text: "", error: undefined },
      ]),
    );

    expect(answer.source).toBe("harness");
    expect(answer.messages).toEqual([]);
    expect(answer.omittedBlank).toBe(2);
    expect(answer.promptOmitted).toBe(true);
    expect(answer.note).toContain("narrated no words");
    expect(answer.note).toContain("the prompt we sent");
  });

  test("the limit is spent on messages that are shown, not on omitted ones", async () => {
    // The order the filtering happens in: prompt, then blanks, then the limit. A limit
    // applied first would spend the budget on entries that are about to be dropped.
    const answer = await read(
      {},
      () =>
        Effect.succeed([
          { type: "user", text: PROMPT, error: undefined },
          { type: "assistant", text: "", error: undefined },
          { type: "assistant", text: "one", error: undefined },
          { type: "assistant", text: "", error: undefined },
          { type: "assistant", text: "two", error: undefined },
        ]),
      2,
    );

    expect(answer.messages.map((message) => message.text)).toEqual([
      "one",
      "two",
    ]);
    expect(answer.truncated).toBe(false);
  });
});

describe("the three absences", () => {
  test("a running round with nothing yet is pending, not empty", async () => {
    const answer = await read({ status: "running", endedAt: null }, () =>
      Effect.succeed([]),
    );

    expect(answer.source).toBe("pending");
    expect(answer.messages).toEqual([]);
    expect(answer.ephemeral).toBe(false);
    expect(answer.note).toContain("as it says it");
  });

  test("a settled round the harness still knows and holds nothing for produced none", async () => {
    // The distinction `run/transcript.ts` is allowed to collapse and this is not: an
    // attempt has our own transcript to fall back on, and a round has nothing at all, so
    // "it said nothing" and "its words were deleted" must not share a sentence.
    const answer = await read({}, () => Effect.succeed([]));

    expect(answer.source).toBe("none");
    expect(answer.note).toContain("produced no narration");
    expect(answer.note).toContain(
      "not the same as the harness having forgotten",
    );
  });

  test("a session the harness has deleted is forgotten, and reads as normal", async () => {
    const answer = await read({}, () =>
      Effect.fail(
        new HarnessTransportError({
          operation: "messages",
          status: 404,
          tag: undefined,
          detail: "no such session",
          cause: undefined,
        }),
      ),
    );

    expect(answer.source).toBe("forgotten");
    // Named as retention rather than as a failure: for an older round this is the answer.
    expect(answer.note).toContain("thirty days");
    expect(answer.note).toContain("still below");
  });

  test("a harness that could not be asked is forgotten with a different sentence", async () => {
    // Both are `forgotten` because the prose is unavailable either way, and the sentences
    // differ because one means there is nothing to wait for and the other does not.
    const answer = await read({}, () =>
      Effect.fail(
        new HarnessTransportError({
          operation: "messages",
          status: undefined,
          tag: undefined,
          detail: "connection refused",
          cause: undefined,
        }),
      ),
    );

    expect(answer.source).toBe("forgotten");
    expect(answer.note).toContain("could not be asked");
    expect(answer.note).toContain("not about the round");
  });

  test("a round that never opened a session produced none, and is not asked about", async () => {
    let asked = 0;
    const answer = await read({ harnessSessionId: null }, () => {
      asked += 1;
      return Effect.succeed([]);
    });

    expect(answer.source).toBe("none");
    expect(asked).toBe(0);
    expect(answer.note).toContain("never opened a harness session");
  });

  test("a round mid-start has no session yet, which is pending rather than none", async () => {
    // The row is written before the harness session exists, so a `running` round with a
    // null session is a moment in the start sequence and not an absence.
    const answer = await read(
      { status: "running", endedAt: null, harnessSessionId: null },
      () => Effect.succeed([]),
    );

    expect(answer.source).toBe("pending");
    expect(answer.note).toContain("does not exist yet");
  });
});

describe("the instance a round ran on", () => {
  test("a foreign instance is not asked about, and says why", async () => {
    // The same inference `recovery/harnessStatus.ts` refuses: asking the harness we do have
    // would get a confident "no such session" for a session that may be alive elsewhere.
    let asked = 0;
    const answer = await read({ harnessInstanceId: "opencode-2" }, () => {
      asked += 1;
      return Effect.succeed(entries(2));
    });

    expect(answer.source).toBe("forgotten");
    expect(asked).toBe(0);
    expect(answer.note).toContain("opencode-2");
    expect(answer.note).toContain("does not configure");
  });

  test("a row written before instances were recorded resolves to the default", async () => {
    const answer = await read({ harnessInstanceId: null }, () =>
      Effect.succeed(entries(1)),
    );

    expect(answer.source).toBe("harness");
    expect(answer.messages.length).toBe(1);
  });

  test("a server with no harness at all reports the prose unavailable, not a failure", async () => {
    const answer = await Effect.runPromise(
      roundNarration({
        resolver: HarnessResolver.fromEntries([]),
        round: round(),
      }),
    );

    expect(answer.source).toBe("forgotten");
    // And it says what is unaffected, because an operator reading this still has the row.
    expect(answer.note).toContain("rows and are unaffected");
  });
});
