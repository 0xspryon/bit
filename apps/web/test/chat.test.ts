/**
 * The rules the planner chat makes its claims with.
 *
 * `chat.ts` lives in its own module so this file can exist — the division `scroll.test.ts`
 * records, with more riding on it. Every assertion here is about a sentence an operator
 * acts on: that an intent the planner added appears **once** and under its real id, that a
 * tool call which produced nothing stays visibly unresolved rather than looking committed,
 * and that the three ways a round can have no prose read as three different things.
 *
 * What is **not** here is the arrangement: the markup, the separators, the composer's
 * absence. Those are `chatComponent.test.ts`, which renders the component.
 */
import { describe, expect, test } from "bun:test";

import {
  bareToolName,
  bitMcpServerName,
  claudeCodeToolName,
  openCodeToolName,
  type GoalNarrationView,
  type LiveItem,
  type LiveUsage,
  type PlanRoundView,
} from "@bit/contracts";

import {
  CHAT_ROUNDS_SHOWN,
  OPERATOR_TURN_KIND,
  activityOrder,
  buildChat,
  buildGoalConversation,
  contextMeter,
  contextMeterLabel,
  pastCompaction,
  domainSummary,
  goalUsageScope,
  groupDigits,
  kindLabel,
  outcomeTint,
  roundUsageScope,
  usageScope,
  type ContextMeter,
  type SentTurn,
} from "../src/lib/chat";
import type { GoalConversationView } from "@bit/contracts";

const AT = 1_700_000_000_000;
const ROUND = "rnd_1";
const GOAL = "goal_1";

const round = (over: Partial<PlanRoundView> = {}): PlanRoundView => ({
  roundId: ROUND,
  goalId: GOAL,
  targetId: "acme-corp",
  status: "running",
  disposition: null,
  dispositionRationale: null,
  budget: 5,
  intentsAdded: 0,
  harnessSessionId: "ses_1",
  instanceId: "opencode",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  startedAtSequence: 4,
  startedAt: AT,
  endedAt: null,
  ...over,
});

/** One activity item: narration, in this process's publish order. */
let published = 0;
const activity = (over: Partial<LiveItem> = {}): LiveItem => ({
  _tag: "item",
  id: `activity:${String(++published)}`,
  origin: "activity",
  sequence: null,
  kind: "turn.reply",
  at: AT,
  attemptId: null,
  roundId: ROUND,
  goalId: null,
  headline: "Reply",
  body: "thinking",
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
  ...over,
});

/** One record item: committed, with the store's own sequence and id. */
let sequenced = 0;
const record = (over: Partial<LiveItem> = {}): LiveItem => {
  const next = ++sequenced;
  return {
    _tag: "item",
    id: `record:evt-${String(next)}`,
    origin: "record",
    sequence: next,
    kind: "intent.added",
    at: AT,
    attemptId: null,
    roundId: ROUND,
    goalId: null,
    headline: "Intent",
    body: "intent int_real was added",
    tool: null,
    toolName: null,
    input: null,
    output: null,
    callId: null,
    outcome: null,
    ...over,
  };
};

/**
 * The MCP server name the round's tools really arrive under.
 *
 * Built by `@bit/contracts` rather than typed out, which is the whole point of this file's
 * change: the merge rule shipped broken because this suite hard-coded `tool: "add_intent"`
 * and the harness never sends that. A fixture built from the same module the reducer is
 * written against cannot drift from the reducer.
 */
const SERVER = bitMcpServerName(ROUND);

/**
 * One call to one of *our* tools, named the way a driver names it.
 *
 * `driver` picks between the two observed wire forms — `mcp__<server>__<tool>` for Claude
 * Code, read out of a live round's DOM, and `<server>.<tool>` for OpenCode, recorded from
 * the harness's own refusal message in DECISIONS.md §24.2 Q1. **Neither the namespaced name
 * nor the reduced one is written by hand**: the first comes from the constructors and the
 * second from `bareToolName`, the very function `run/liveTranscript.ts` calls to produce
 * `LiveItem.toolName`.
 */
const call = (
  callId: string,
  bare = "add_intent",
  driver: "claude-code" | "opencode" = "claude-code",
  input = `{"question":"can the limiter be bypassed?"}`,
) => {
  const wire =
    driver === "opencode"
      ? openCodeToolName(SERVER, bare)
      : claudeCodeToolName(SERVER, bare);
  return activity({
    kind: "tool.call",
    tool: wire,
    toolName: bareToolName(wire, SERVER) ?? null,
    callId,
    headline: wire,
    body: "",
    input,
  });
};

const result = (callId: string, failed: boolean) =>
  activity({
    kind: "tool.result",
    // A result is paired by `callId` alone — Claude Code's `tool_result` block carries no
    // tool name at all — so what is in these two fields is immaterial to the pairing. They
    // are still the real wire forms, so the fixture cannot be read as evidence for the
    // bare name working anywhere.
    tool: claudeCodeToolName(SERVER, "add_intent"),
    toolName: "add_intent",
    callId,
    headline: "add_intent",
    body: "",
    output: failed ? "duplicate: an open intent already asks this" : "int_real",
    outcome: failed ? "failed" : "ok",
  });

const narration = (
  over: Partial<GoalNarrationView> = {},
): GoalNarrationView => ({
  goalId: GOAL,
  targetId: "acme-corp",
  rounds: [],
  skipped: 0,
  // After every round these tests build, so a missing entry reads as past the budget
  // rather than as a round newer than the replay.
  at: AT + 60_000,
  ...over,
});

const chat = (input: {
  rounds?: readonly PlanRoundView[];
  items?: readonly LiveItem[];
  narration?: GoalNarrationView | undefined;
  narrationFloor?: number | undefined;
  inFlight?: readonly string[];
}) =>
  buildChat({
    rounds: input.rounds ?? [round()],
    items: input.items ?? [],
    narration: input.narration,
    narrationFloor: input.narrationFloor,
    inFlight: new Set(input.inFlight ?? []),
  });

describe("labels", () => {
  test("a kind this build knows reads as words, and one it does not reads as itself", () => {
    expect(kindLabel("plan.round.settled")).toBe("Planner round settled");
    // `plan.round.steered` arrived with the goal conversation and is known now, which is
    // why the unknown example below is one no build writes: the claim is about the
    // fallback, and a kind that becomes known makes the test pass for the wrong reason.
    expect(kindLabel("plan.round.steered")).toBe("Steered");
    // The whole reason `LiveItem.kind` is a string on the wire: a tab one deploy behind
    // must render an item it has never seen rather than hiding it.
    expect(kindLabel("plan.round.invented")).toBe("plan.round.invented");
  });

  test("an outcome vocabulary that is not ours is left plain rather than guessed at", () => {
    expect(outcomeTint("failed")).toBe("danger");
    expect(outcomeTint("uncertain")).toBe("warning");
    expect(outcomeTint("unheard-of")).toBe("plain");
  });
});

describe("activityOrder", () => {
  test("it reads this process's publish order off an activity item", () => {
    expect(activityOrder(activity({ id: "activity:42" }))).toBe(42);
  });

  test("a record has none, because the counter is not its identity", () => {
    expect(activityOrder(record({ id: "record:evt-9" }))).toBeUndefined();
  });

  test("a refused action does not parse, because it is counted by another service", () => {
    // `activity:decision:<n>` is the policy service's answer order, not the narration bus's.
    // Treating the two counters as one would compare numbers from different sequences.
    expect(
      activityOrder(activity({ id: "activity:decision:3" })),
    ).toBeUndefined();
  });
});

describe("the tool name the merge rule has to match", () => {
  /*
   * The regression these two guard, stated plainly: the rule shipped keyed on
   * `LiveItem.tool`, which for a planner's own tools is the driver's namespaced form. It
   * matched nothing against a real round — every write rendered twice, no write state was
   * ever computed, and `unresolved` was unreachable — and the suite could not catch it
   * because it fabricated the bare name in both fields. These cases build the name the way
   * the system does and assert the rule fires on both drivers' forms.
   */

  test("the fixtures carry the namespaced name a driver really sends", () => {
    const claude = call("call-1");
    const opencode = call("call-2", "add_intent", "opencode");
    // Not `add_intent`: the round id is in the name, and the two drivers differ.
    expect(claude.tool).toBe(`mcp__bit-${ROUND}__add_intent`);
    expect(opencode.tool).toBe(`bit-${ROUND}.add_intent`);
    expect(claude.tool).not.toBe(claude.toolName);
    // And the reduced field is what the rule matches on, produced by the same function the
    // server calls.
    expect(claude.toolName).toBe("add_intent");
    expect(opencode.toolName).toBe("add_intent");
  });

  test("the rule fires on both drivers' forms, and `tool` alone would match neither", () => {
    for (const driver of ["claude-code", "opencode"] as const) {
      const view = chat({
        items: [call("call-1", "add_intent", driver), record({})],
      });
      const rows = view.groups[0]?.rows ?? [];
      expect(rows.length).toBe(1);
      expect(rows[0]?.write).toBe("recorded");
    }
  });

  test("a harness's own tool is not namespaced and is not a write", () => {
    // `bareToolName` strips only the prefix this application chose, so a harness's `bash`
    // survives unchanged and does not accidentally become a tool of ours.
    const view = chat({
      items: [activity({ kind: "tool.call", tool: "bash", toolName: "bash" })],
    });
    expect(view.groups[0]?.rows[0]?.write).toBeNull();
  });
});

describe("the one-line domain summary", () => {
  test("an add_intent call says the question it proposed", () => {
    // The brief's requirement. Without it the row is the raw MCP tool name over two empty
    // disclosure labels, and the question reaches the screen only once the record arrives —
    // which is exactly what a pending call cannot rely on.
    const view = chat({ items: [call("call-1")] });
    const row = view.groups[0]?.rows[0];
    expect(row?.write).toBe("pending");
    expect(row?.summary).toBe("can the limiter be bypassed?");
  });

  test("a record_round_disposition call says the disposition, in the panel's own words", () => {
    const view = chat({
      items: [
        call(
          "call-1",
          "record_round_disposition",
          "claude-code",
          `{"disposition":"objective_met","rationale":"the limiter is bypassable"}`,
        ),
      ],
    });
    // The same sentence `PlanPanel` prints for it, so one round does not read as two
    // different conclusions on one page.
    expect(view.groups[0]?.rows[0]?.summary).toBe(
      "Objective met — this ended the goal",
    );
  });

  test("a disposition outside the four is shown as the planner said it", () => {
    expect(
      domainSummary({
        toolName: "record_round_disposition",
        input: `{"disposition":"something_new"}`,
      }),
    ).toBe("something_new");
  });

  test("a summary is never guessed from arguments that will not parse", () => {
    // A large `add_intent` is capped at `NARRATION_FIELD_MAX` with a marker appended, so it
    // arrives as invalid JSON. The row then carries no summary and the arguments are still
    // there to open; inventing a sentence from a half-parsed payload is the one failure a
    // summary must not have.
    for (const input of [
      `{"question":"can the limi`,
      `{"question":""}`,
      `{"somethingElse":"x"}`,
      `"not an object"`,
    ]) {
      expect(domainSummary({ toolName: "add_intent", input })).toBeNull();
    }
    expect(domainSummary({ toolName: null, input: "{}" })).toBeNull();
    expect(domainSummary({ toolName: "add_intent", input: null })).toBeNull();
    // A read-only tool has no summary to give.
    expect(
      domainSummary({ toolName: "list_intents", input: `{"goalId":"g"}` }),
    ).toBeNull();
  });

  test("a recorded write keeps the record's own sentence and the call's summary beside it", () => {
    // `ChatItem` shows the summary only when the rendered item has no body, so a committed
    // record's own sentence is never doubled by a paraphrase of the request. Both are on the
    // row so the component can make that choice.
    const view = chat({
      items: [call("call-1"), record({ body: "intent int_real was added" })],
    });
    const row = view.groups[0]?.rows[0];
    expect(row?.item.body).toBe("intent int_real was added");
    expect(row?.summary).toBe("can the limiter be bypassed?");
  });
});

describe("the pending-until-recorded merge rule", () => {
  test("an add_intent call renders once, and the record's id is what survives", () => {
    const asked = call("call-1");
    const committed = record({ id: "record:evt-real", body: "int_real added" });
    const view = chat({ items: [asked, result("call-1", false), committed] });

    const rows = view.groups[0]?.rows ?? [];
    // One row for the pair, not two. Showing both would report one intent as two.
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.write).toBe("recorded");
    // The record wins: it is what is rendered and its id is the row's key.
    expect(row?.item.id).toBe("record:evt-real");
    expect(row?.key).toBe("record:evt-real");
    expect(row?.item.origin).toBe("record");
    // The call is kept, because it is the only place the arguments are.
    expect(row?.proposedBy?.id).toBe(asked.id);
    expect(row?.proposedBy?.input).toContain("limiter");
    // And the tool's own result is folded into the same row rather than left adrift.
    expect(row?.result?.outcome).toBe("ok");
  });

  test("a record that arrives before its narration still pairs", () => {
    // The record channel is ordered and the activity channel is not, so a narration entry
    // can land after the record it describes. Requiring the order would turn one late
    // entry into a row claiming an intent was never recorded.
    const committed = record({ id: "record:evt-first" });
    const view = chat({ items: [committed, call("call-1")] });
    const rows = view.groups[0]?.rows ?? [];
    expect(rows.length).toBe(1);
    expect(rows[0]?.write).toBe("recorded");
    expect(rows[0]?.item.id).toBe("record:evt-first");
  });

  test("two calls and two records pair in order, not by name", () => {
    // Nothing joins a `callId` to a store subject id, so the i-th write of a round belongs
    // with the i-th record it wrote. Both rows must be recorded and distinct.
    const view = chat({
      items: [
        call("call-1"),
        call("call-2"),
        record({ id: "record:evt-a" }),
        record({ id: "record:evt-b" }),
      ],
    });
    const rows = view.groups[0]?.rows ?? [];
    expect(rows.map((row) => row.write)).toEqual(["recorded", "recorded"]);
    expect(rows.map((row) => row.item.id)).toEqual([
      "record:evt-a",
      "record:evt-b",
    ]);
  });

  test("a write with no record yet is pending while the round runs", () => {
    const view = chat({ items: [call("call-1")] });
    expect(view.groups[0]?.rows[0]?.write).toBe("pending");
  });

  test("a tool call with no record stays visibly unresolved once the round has settled", () => {
    const view = chat({
      rounds: [round({ status: "settled", endedAt: AT + 1_000 })],
      items: [call("call-1")],
    });
    const row = view.groups[0]?.rows[0];
    // Not `recorded` and not silently dropped: either the record was lost from this tab's
    // feed or the write did not happen, and the chat is not allowed to pick.
    expect(row?.write).toBe("unresolved");
    expect(row?.item.kind).toBe("tool.call");
  });

  test("a call the harness says failed is refused, not unresolved", () => {
    const view = chat({
      rounds: [round({ status: "settled", endedAt: AT + 1_000 })],
      items: [call("call-1"), result("call-1", true)],
    });
    const row = view.groups[0]?.rows[0];
    expect(row?.write).toBe("refused");
    // The store's instructive refusal is in the tool's own output, folded into the row.
    expect(row?.result?.output).toContain("duplicate");
  });

  test("a read-only tool is not a write at all", () => {
    const view = chat({ items: [call("call-1", "list_intents")] });
    const row = view.groups[0]?.rows[0];
    expect(row?.write).toBeNull();
    expect(row?.item.kind).toBe("tool.call");
  });

  test("a result naming no call is a row of its own rather than guessed into one", () => {
    // Falling back to the tool name would attribute one call's output to a different call.
    const view = chat({
      items: [
        call("call-1"),
        activity({
          kind: "tool.result",
          tool: "add_intent",
          callId: null,
          outcome: "ok",
          output: "whose?",
        }),
      ],
    });
    const rows = view.groups[0]?.rows ?? [];
    expect(rows.length).toBe(2);
    expect(rows[1]?.item.kind).toBe("tool.result");
  });
});

describe("grouping", () => {
  test("rounds read oldest first, and items land under the round that owns them", () => {
    const first = round({ roundId: "rnd_old", startedAt: AT - 10_000 });
    const second = round({ roundId: "rnd_new" });
    const view = chat({
      // The server orders rounds newest first; the chat shows them newest last.
      rounds: [second, first],
      items: [
        activity({ roundId: "rnd_old", body: "older" }),
        activity({ roundId: "rnd_new", body: "newer" }),
        // A worker's narration, which belongs to no round and must not be adopted by one.
        activity({ roundId: null, attemptId: "attempt-1", body: "a worker" }),
      ],
    });
    expect(view.groups.map((entry) => entry.key)).toEqual([
      "rnd_old",
      "rnd_new",
    ]);
    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual(["older"]);
    expect(view.groups[1]?.rows.map((row) => row.item.body)).toEqual(["newer"]);
  });

  test("a round this process is driving says so", () => {
    const view = chat({ inFlight: [ROUND] });
    expect(view.groups[0]?.subject.inFlight).toBe(true);
    // A row saying `running` is not the same claim: a dead process leaves exactly that.
    expect(chat({}).groups[0]?.subject.inFlight).toBe(false);
  });

  test("rounds past the shown budget are counted rather than quietly dropped", () => {
    const many = Array.from({ length: CHAT_ROUNDS_SHOWN + 3 }, (_, index) =>
      round({ roundId: `rnd_${String(index)}`, startedAt: AT - index }),
    );
    const view = chat({ rounds: many });
    expect(view.groups.length).toBe(CHAT_ROUNDS_SHOWN);
    expect(view.older).toBe(3);
  });
});

describe("the three absences, which must never be one", () => {
  test("a round the replay has not answered for yet is loading, not empty", () => {
    expect(chat({}).groups[0]?.prose._tag).toBe("loading");
  });

  test("a round with no narration yet says so and is worth waiting for", () => {
    const view = chat({
      narration: narration({
        rounds: [
          {
            roundId: ROUND,
            harnessSessionId: "ses_1",
            source: "pending",
            ephemeral: false,
            note: "OpenCode holds nothing for this round yet.",
            messages: [],
            truncated: false,
            omittedBlank: 0,
            promptOmitted: false,
          },
        ],
      }),
    });
    expect(view.groups[0]?.prose._tag).toBe("pending");
  });

  test("a round whose prose the harness has forgotten says that, and is not an error", () => {
    const view = chat({
      rounds: [round({ status: "settled", endedAt: AT + 1_000 })],
      narration: narration({
        rounds: [
          {
            roundId: ROUND,
            harnessSessionId: "ses_1",
            source: "forgotten",
            ephemeral: false,
            note: "OpenCode no longer holds session ses_1.",
            messages: [],
            truncated: false,
            omittedBlank: 0,
            promptOmitted: false,
          },
        ],
      }),
    });
    const prose = view.groups[0]?.prose;
    expect(prose?._tag).toBe("forgotten");
    expect(prose && "note" in prose ? prose.note : "").toContain(
      "no longer holds",
    );
    // The structure is untouched: the separator and the conclusion come from the row.
    expect(view.groups[0]?.subject.round.status).toBe("settled");
  });

  test("a round that never produced any narration is a third thing again", () => {
    const view = chat({
      rounds: [round({ status: "settled", endedAt: AT + 1_000 })],
      narration: narration({
        rounds: [
          {
            roundId: ROUND,
            harnessSessionId: "ses_1",
            source: "none",
            ephemeral: false,
            note: "OpenCode still holds this round's session and there are no messages under it.",
            messages: [],
            truncated: false,
            omittedBlank: 0,
            promptOmitted: false,
          },
        ],
      }),
    });
    expect(view.groups[0]?.prose._tag).toBe("none");
  });

  test("a round past the replay budget says it was not read, not that it is empty", () => {
    const view = chat({
      rounds: [round({ startedAt: AT - 10_000 })],
      narration: narration({ rounds: [], skipped: 1 }),
    });
    expect(view.groups[0]?.prose._tag).toBe("unasked");
  });

  test("a round newer than the replay is loading rather than unasked", () => {
    // The round an operator has just opened from this page. The read that covers it is
    // already on its way, and calling it "not asked for" would be wrong by a second.
    const view = chat({
      rounds: [round({ startedAt: AT + 120_000 })],
      narration: narration({ rounds: [] }),
    });
    expect(view.groups[0]?.prose._tag).toBe("loading");
  });
});

describe("the replay and the live tail", () => {
  const replayed = (over = {}) =>
    narration({
      rounds: [
        {
          roundId: ROUND,
          harnessSessionId: "ses_1",
          source: "harness",
          ephemeral: true,
          note: "From OpenCode, which may delete it.",
          messages: [
            {
              index: 0,
              type: "assistant",
              text: "two dimensions are untested",
            },
          ],
          truncated: false,
          omittedBlank: 0,
          promptOmitted: false,
          ...over,
        },
      ],
    });

  test("a replayed round carries the harness's messages and is marked ephemeral", () => {
    const view = chat({ narration: replayed() });
    const prose = view.groups[0]?.prose;
    expect(prose?._tag).toBe("replayed");
    expect(prose && "ephemeral" in prose ? prose.ephemeral : false).toBe(true);
    expect(view.groups[0]?.replayed.length).toBe(1);
  });

  test("a replay and the live tail are shown together, which is what a refresh mid-round needs", () => {
    // The regression this guards: hiding the replay the moment one live entry arrived would
    // make a refresh mid-round lose everything the round had already said.
    const view = chat({
      items: [activity({ id: "activity:50", body: "live now" })],
      narration: replayed(),
      narrationFloor: 10,
    });
    expect(view.groups[0]?.prose._tag).toBe("replayed");
    expect(view.groups[0]?.replayed.length).toBe(1);
    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "live now",
    ]);
  });

  test("a round whose replay holds nothing but which this tab is watching is live", () => {
    // The narrow case `live` is for: the harness had not flushed the round's prose when the
    // replay was read, and this tab saw it anyway.
    const view = chat({
      items: [activity({ body: "live now" })],
      narration: narration({
        rounds: [
          {
            roundId: ROUND,
            harnessSessionId: "ses_1",
            source: "pending",
            ephemeral: false,
            note: "OpenCode holds nothing for this round yet.",
            messages: [],
            truncated: false,
            omittedBlank: 0,
            promptOmitted: false,
          },
        ],
      }),
    });
    expect(view.groups[0]?.prose._tag).toBe("live");
    expect(view.groups[0]?.replayed.length).toBe(0);
    expect(view.groups[0]?.rows.length).toBe(1);
  });

  test("narration already inside the replay is dropped from the live tail", () => {
    const early = activity({ id: "activity:5", body: "already replayed" });
    const late = activity({ id: "activity:9", body: "after the read" });
    const view = chat({
      items: [early, late],
      narration: replayed(),
      narrationFloor: 5,
    });
    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "after the read",
    ]);
  });

  test("a record is never dropped by the floor, because it is the evidence of a write", () => {
    const view = chat({
      items: [record({ id: "record:evt-kept", sequence: 1 })],
      narration: replayed(),
      narrationFloor: 9_999,
    });
    const rows = view.groups[0]?.rows ?? [];
    expect(rows.map((row) => row.item.id)).toEqual(["record:evt-kept"]);
    // A record on its own is not a live narration, so the replayed block still shows.
    expect(view.groups[0]?.prose._tag).toBe("replayed");
  });
});

/* ── The goal conversation ───────────────────────────────────────────────────── */

describe("the goal conversation", () => {
  const conversation = (
    over: Partial<GoalConversationView> = {},
  ): GoalConversationView => ({
    targetId: "acme-corp",
    goalId: GOAL,
    harnessSessionId: "ses_goal",
    live: true,
    source: "harness",
    ephemeral: true,
    note: "From OpenCode, which may delete it.",
    messages: [],
    truncated: false,
    omittedBlank: 0,
    at: AT,
    ...over,
  });

  const sent = (over: Partial<SentTurn> = {}): SentTurn => ({
    index: 1,
    text: "look at the lockout path",
    at: AT,
    after: 0,
    ...over,
  });

  const built = (input: {
    items?: readonly LiveItem[];
    conversation?: GoalConversationView | undefined;
    sent?: readonly SentTurn[];
    narrationFloor?: number | undefined;
    /**
     * How many turns had been sent when the replay was asked for.
     *
     * Defaults to **every** turn the case passes, which is the "the replay was asked for
     * after everything on screen" arrangement most of these cases want. The one case that
     * matters most passes `0` explicitly, because that is the real state of a replay read
     * on open: it cannot contain a message sent afterwards.
     */
    replayedThrough?: number;
    awaiting?: boolean;
  }) =>
    buildGoalConversation({
      goalId: GOAL,
      items: input.items ?? [],
      conversation: input.conversation,
      narrationFloor: input.narrationFloor,
      sent: input.sent ?? [],
      replayedThrough: input.replayedThrough ?? (input.sent ?? []).length,
      awaiting: input.awaiting ?? false,
    });

  test("a goal nobody has talked to has no group at all, not an empty one", () => {
    // The fifth source, and the shape it is rendered in: `Chat` prints its `empty`
    // sentence when there are no groups, which is the right rendering of "there is no
    // conversation" — as against the three ways a conversation that exists can have no
    // prose, which are shown inside a group.
    const view = built({ conversation: conversation({ source: "absent" }) });
    expect(view.groups).toEqual([]);
  });

  test("a conversation this process no longer holds is shown and marked as such", () => {
    const view = built({
      conversation: conversation({
        live: false,
        messages: [
          { index: 0, type: "assistant", text: "two rounds have run" },
        ],
        note: "From Claude Code. This conversation was opened by a server process that is no longer running.",
      }),
    });

    const group = view.groups[0];
    expect(group?.prose._tag).toBe("replayed");
    expect(group?.replayed).toHaveLength(1);
    // The separator reads this: the words are here and the conversation is not continuable,
    // which are two facts and must not be collapsed into one.
    expect(group?.subject.conversation?.live).toBe(false);
  });

  test("only this goal's items are in it", () => {
    const view = built({
      items: [
        activity({ goalId: GOAL, roundId: null, body: "the agent" }),
        activity({ goalId: "goal_other", roundId: null, body: "another goal" }),
        activity({ goalId: null, roundId: ROUND, body: "a planner round" }),
      ],
      conversation: conversation(),
    });

    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "the agent",
    ]);
  });

  test("an operator's own message is a row, marked activity and never a record", () => {
    const view = built({ sent: [sent()], conversation: conversation() });

    const row = view.groups[0]?.rows[0];
    expect(row?.item.kind).toBe(OPERATOR_TURN_KIND);
    expect(row?.item.body).toBe("look at the lockout path");
    // Not part of the record, not stored, gone on a reload — and the row says so rather
    // than borrowing the authority of a committed event.
    expect(row?.item.origin).toBe("activity");
    expect(row?.item.sequence).toBeNull();
    // And it cannot be read as a narration entry by the floor, which would drop it.
    expect(activityOrder(row?.item as LiveItem)).toBeUndefined();
  });

  test("a sent message the replay has brought back is shown once", () => {
    /*
     * Important finding 6's second half, seen in the browser: the operator's first sentence
     * appeared twice — once in the replayed block, because the harness stores it and the
     * server now trims its framing off, and once as this tab's own "YOU" row.
     *
     * The match is on the operator's own verbatim words, which is a much stronger key than
     * anything the narration join could use, and it cancels **one** local turn per replayed
     * entry rather than filtering by text.
     */
    const view = built({
      conversation: conversation({
        messages: [
          { index: 0, type: "user", text: "look at the lockout path" },
          { index: 1, type: "assistant", text: "I will steer the planner." },
        ],
      }),
      sent: [sent()],
    });

    expect(view.groups[0]?.replayed).toHaveLength(2);
    // No "YOU" row for a sentence the replayed block above already shows.
    expect(view.groups[0]?.rows).toEqual([]);
  });

  test("a sentence re-sent after a stale replay is still shown", () => {
    /*
     * The false positive the one-for-one drop had, and the reason the bound exists.
     *
     * The replay is read on open and re-read only after a send that *opens* a conversation,
     * so by the time an operator types into a live conversation it is stale. Cancelling by
     * text alone meant a re-sent short sentence — "ok", "continue", "yes" — was matched
     * against the old entry and rendered **nowhere**: a review measured zero operator rows
     * for exactly this input. The message was still delivered, which is what makes it the
     * worse failure: the operator cannot tell.
     *
     * `replayedThrough: 0` is the honest state of that replay. The new turn is numbered 1,
     * so no answer read before it was sent can contain it, and it is never a candidate.
     */
    const view = built({
      conversation: conversation({
        messages: [
          { index: 0, type: "user", text: "ok" },
          { index: 1, type: "assistant", text: "done" },
        ],
      }),
      sent: [sent({ index: 1, text: "ok" })],
      replayedThrough: 0,
    });

    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual(["ok"]);
    // And the old entry is still in the replayed block above it, which is correct: those
    // are two different messages that happen to say the same thing.
    expect(view.groups[0]?.replayed).toHaveLength(2);
  });

  test("the same sentence sent twice with one in the replay still shows two", () => {
    // Counted, not filtered: an operator who sends "ok" twice has sent two messages, and a
    // replay that has caught up with one of them must not hide the other.
    const view = built({
      conversation: conversation({
        messages: [{ index: 0, type: "user", text: "ok" }],
      }),
      sent: [
        sent({ index: 1, text: "ok" }),
        sent({ index: 2, text: "ok", after: 1 }),
      ],
    });

    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual(["ok"]);
  });

  test("a sent message the replay does not have is kept", () => {
    // The ordinary state of a second or later message: nothing is dropped on the strength
    // of a replay that does not contain it.
    const view = built({
      conversation: conversation({
        messages: [{ index: 0, type: "assistant", text: "One round has run." }],
      }),
      sent: [sent({ text: "and the admin console?" })],
    });

    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "and the admin console?",
    ]);
  });

  test("a sent message sorts before the narration that answered it", () => {
    /*
     * The join, and it is the same one the replay uses rather than a second mechanism: the
     * turn carries the activity publish order it was sent at, so it lands before the first
     * entry that arrived after it. Comparing timestamps instead would compare this tab's
     * clock with the server's, and the order would wobble for no visible reason.
     */
    const before = activity({ goalId: GOAL, roundId: null, body: "earlier" });
    const after = activity({ goalId: GOAL, roundId: null, body: "later" });
    const order = activityOrder(before);
    expect(order).toBeDefined();

    const view = built({
      items: [before, after],
      sent: [sent({ after: order ?? 0 })],
      conversation: conversation(),
    });

    expect(view.groups[0]?.rows.map((row) => row.item.body)).toEqual([
      "earlier",
      "look at the lockout path",
      "later",
    ]);
  });

  test("the three empty states read as three different things", () => {
    const states: {
      source: GoalConversationView["source"];
      expected: ReturnType<typeof built>["groups"][number]["prose"]["_tag"];
    }[] = [
      { source: "pending", expected: "pending" },
      { source: "forgotten", expected: "forgotten" },
      { source: "none", expected: "none" },
    ];
    for (const state of states) {
      const view = built({
        conversation: conversation({
          source: state.source,
          note: `the note for ${state.source}`,
        }),
        // A sent message so there is something to render a group for at all; the prose is
        // the claim under test.
        sent: [sent()],
      });
      expect(view.groups[0]?.prose._tag).toBe(state.expected);
    }
  });

  test("a conversation the replay has not answered for yet reads as loading", () => {
    const view = built({ sent: [sent()], conversation: undefined });
    expect(view.groups[0]?.prose._tag).toBe("loading");
  });
});

/* ── The context meter ───────────────────────────────────────────────────────── */

/**
 * What the figure at the top of a pane is allowed to say.
 *
 * Three claims, and every one of them was a way to be wrong:
 *
 * 1. **The numerator is one model call.** Both drivers publish running totals that re-count
 *    the cached prefix per call, so a meter built from those reads four to five times high
 *    (DECISIONS.md §24.4: 65 838 against 13 753 on OpenCode, 90 784 against 23 179 on
 *    Claude Code). The fixture below carries both figures so a regression to the easy one
 *    fails here.
 * 2. **No limit, no percentage.** Ruling 3. An honest "14,870 tokens" beats a fabricated
 *    "7%".
 * 3. **One call per session, latest wins.** A repeat of a call's id replaces it; nothing
 *    anywhere adds two of these together.
 */
describe("the context meter", () => {
  const usage = (over: Partial<LiveUsage> = {}): LiveUsage => ({
    _tag: "usage",
    callId: "msg_1",
    promptTokens: 13_750,
    outputTokens: 3,
    contextLimit: 200_000,
    compactionAt: 170_000,
    attemptId: null,
    roundId: ROUND,
    goalId: null,
    at: AT,
    ...over,
  });

  /** The meter for a frame, with the "no call yet" case ruled out loudly. */
  const meterOf = (frame: LiveUsage): ContextMeter => {
    const meter = contextMeter(frame);
    if (meter === undefined) throw new Error("expected a meter for this frame");
    return meter;
  };

  /** The one-line figure for a frame. */
  const labelOf = (frame: LiveUsage): string =>
    contextMeterLabel(meterOf(frame));

  test("the figure is the last call's own context, not the session's spend", () => {
    /*
     * The probe's fifth and last call: 150 uncached, 13 600 read from the cache, 3 output.
     * Its context is 13 753. The **session total** at that same moment was 14 504 input,
     * 113 output, 85 reasoning and 51 136 cache read — 65 838 together, 4.8 times as much
     * — and that total is what `session.usage.updated` and `session.tokens` carry.
     *
     * Both numbers are in this test on purpose. A meter that regressed to the cumulative
     * field would still produce a plausible-looking percentage, so the assertion names the
     * wrong answer as well as the right one.
     */
    const meter = contextMeter(usage());
    expect(meter?.tokens).toBe(13_753);
    expect(meter?.tokens).not.toBe(65_838);
    expect(meter?.percent).toBe(7);
    expect(meter?.limit).toBe(200_000);
    expect(meter?.outputStated).toBe(true);
    expect(labelOf(usage())).toBe("13,753 / 200,000 · 7%");
  });

  test("no limit means no percentage, and the tokens still read", () => {
    const unlimited = usage({
      promptTokens: 14_870,
      outputTokens: null,
      contextLimit: null,
    });
    const meter = contextMeter(unlimited);
    expect(meter?.limit).toBeNull();
    expect(meter?.percent).toBeNull();
    expect(labelOf(unlimited)).toBe("14,870 tokens");
  });

  test("an unstated output count is not a zero, and the meter says which", () => {
    // Claude Code's `assistant` frames carry a stale output count, so the server omits it.
    // The figure is then the prompt side alone and runs short — stated rather than rounded
    // away.
    const meter = contextMeter(
      usage({
        promptTokens: 21_388,
        outputTokens: null,
        contextLimit: 1_000_000,
      }),
    );
    expect(meter?.tokens).toBe(21_388);
    expect(meter?.outputStated).toBe(false);
    expect(meter?.outputTokens).toBeNull();
  });

  test("a real fraction that rounds to nothing says so rather than reading as zero", () => {
    const sliver = usage({
      promptTokens: 1_500,
      outputTokens: 0,
      contextLimit: 1_000_000,
    });
    expect(contextMeter(sliver)?.percent).toBe(0);
    expect(labelOf(sliver)).toBe("1,500 / 1,000,000 · <1%");
  });

  test("the harness's own compaction point is carried, as a fraction of the window", () => {
    /*
     * The number the meter would otherwise imply does not exist.
     *
     * bit's default model: OpenCode rewrites the session at 231 200 tokens, which is 58 %
     * of the 400 000 the bar is drawn against. So a bar with no mark on it tells an
     * operator that nothing happens until it reads full, and the thing they would actually
     * act on arrives a little past halfway.
     */
    const meter = meterOf(
      usage({
        promptTokens: 120_000,
        outputTokens: 500,
        contextLimit: 400_000,
        compactionAt: 231_200,
      }),
    );
    expect(meter.compactionAt).toBe(231_200);
    expect(meter.compactionPercent).toBe(58);
    // Below it, so nothing has been rewritten yet.
    expect(pastCompaction(meter)).toBe(false);
  });

  test("past the compaction point is its own state, because the next figure gets smaller", () => {
    const meter = meterOf(
      usage({
        promptTokens: 235_000,
        outputTokens: 0,
        contextLimit: 400_000,
        compactionAt: 231_200,
      }),
    );
    // Not "nearly full" — 59 % of the window — but past the point where the harness is
    // about to replace the conversation with a summary, or has just done so. The figure
    // itself still measures a call that really was sent at this size.
    expect(meter.percent).toBe(59);
    expect(pastCompaction(meter)).toBe(true);
  });

  test("no window means no fraction to mark, even when a threshold is known", () => {
    const meter = contextMeter(
      usage({ contextLimit: null, compactionAt: 170_000 }),
    );
    expect(meter?.compactionAt).toBe(170_000);
    // A mark is a mark *on* something. The panel still states the number in words.
    expect(meter?.compactionPercent).toBeNull();
  });

  test("a harness that states no threshold gets no mark and no sentence", () => {
    const meter = meterOf(usage({ compactionAt: null }));
    expect(meter.compactionAt).toBeNull();
    expect(meter.compactionPercent).toBeNull();
    // And "we have not been told" is never read as "it will never compact": `pastCompaction`
    // is false, which is what stops a warning being drawn for an unmeasured policy.
    expect(pastCompaction(meter)).toBe(false);
  });

  test("a session that has not called a model yet has no meter", () => {
    expect(contextMeter(undefined)).toBeUndefined();
  });

  test("a nonsense window costs the percentage rather than producing an Infinity", () => {
    const meter = contextMeter(usage({ contextLimit: 0 }));
    expect(meter?.limit).toBeNull();
    expect(meter?.percent).toBeNull();
  });

  test("a frame is scoped to the one agent it measures, and an unattributed one is dropped", () => {
    // A page shows a planner round above a goal conversation: two agents, two sessions,
    // two windows. A figure shown against the wrong one is worse than no figure.
    expect(usageScope(usage())).toBe(roundUsageScope(ROUND));
    expect(usageScope(usage({ roundId: null, goalId: GOAL }))).toBe(
      goalUsageScope(GOAL),
    );
    expect(usageScope(usage({ roundId: null, attemptId: "att_1" }))).toBe(
      "attempt:att_1",
    );
    expect(usageScope(usage({ roundId: null }))).toBeUndefined();
  });

  test("the figure is grouped the same way in a test as on a screen", () => {
    // `toLocaleString` would answer differently under the runner's locale than in a
    // browser, which is a test passing for the wrong reason.
    expect(groupDigits(13_753)).toBe("13,753");
    expect(groupDigits(0)).toBe("0");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(1_000_000)).toBe("1,000,000");
  });
});
