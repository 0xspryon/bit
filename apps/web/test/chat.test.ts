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
  type PlanRoundView,
} from "@bit/contracts";

import {
  CHAT_ROUNDS_SHOWN,
  activityOrder,
  buildChat,
  domainSummary,
  kindLabel,
  outcomeTint,
} from "../src/lib/chat";

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
    // The whole reason `LiveItem.kind` is a string on the wire: a tab one deploy behind
    // must render an item it has never seen rather than hiding it.
    expect(kindLabel("plan.round.steered")).toBe("plan.round.steered");
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
