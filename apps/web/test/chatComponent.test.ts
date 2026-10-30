/**
 * What the chat's markup actually says.
 *
 * **The one claim in this slice that cannot be tested any other way is the composer's.**
 * Ruling 1 of the brief is that the chat is parameterised rather than planner-specific,
 * because slice 9 renders this same component with its composer enabled — so "the composer
 * is absent in read-only mode and present when the prop says otherwise" is the interface
 * that slice depends on, and it is a fact about rendered markup. `test/runes.ts` compiles
 * `.svelte` for the server for exactly this, with no new dependency and no second runner.
 *
 * **It is server output, so no `$effect` runs.** The scroll-following and the ticking clock
 * are therefore not exercised here; that is the division `scroll.test.ts` records and the
 * reason the rules live in `chat.ts` and `scroll.ts` rather than in a component.
 */
import { describe, expect, test } from "bun:test";
import { createRawSnippet, type ComponentProps } from "svelte";
import { render } from "svelte/server";

import {
  bareToolName,
  bitMcpServerName,
  claudeCodeToolName,
  type LiveItem,
  type PlanRoundView,
} from "@bit/contracts";

import Chat from "../src/lib/components/Chat.svelte";
import PlannerChat from "../src/lib/components/PlannerChat.svelte";
import { App } from "../src/lib/app.svelte";
import {
  AT,
  FakeServer,
  goalView,
  ok,
  planRoundView,
  runningRound,
  targetSummary,
} from "./fakeServer";
import { FakeCountdown } from "./fakeCountdown";
import type { ChatRound } from "../src/lib/chat";

/**
 * Lets everything already in flight finish. `app.test.ts`'s helper, for its reason:
 * `openTarget` and `openGoal` are fire-and-forget, so a test has to wait for work it was
 * not handed a promise for.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const row = (over: Partial<PlanRoundView> = {}): PlanRoundView => ({
  roundId: "rnd_1",
  goalId: "goal_1",
  targetId: "acme-corp",
  status: "settled",
  disposition: "actionable",
  dispositionRationale: "Two dimensions had no work out.",
  budget: 5,
  intentsAdded: 2,
  harnessSessionId: "ses_1",
  instanceId: "opencode",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  startedAtSequence: 4,
  startedAt: AT,
  endedAt: AT + 1_000,
  ...over,
});

const chatRound = (over: Partial<ChatRound> = {}): ChatRound => ({
  key: "rnd_1",
  subject: { round: row(), inFlight: false },
  prose: { _tag: "loading" },
  replayed: [],
  rows: [],
  ...over,
});

/**
 * The separator every case here renders, standing in for a caller's own.
 *
 * `Chat.svelte` knows nothing about what a group *is*, so a test of the component has to
 * supply this exactly as {@link PlannerChat} does. What a planner's separator actually says
 * is asserted further down, by rendering `PlannerChat` itself.
 */
const separator = createRawSnippet<[ChatRound]>((group) => ({
  render: () => `<span data-probe="sep">${group().key}</span>`,
}));

const footnote = createRawSnippet(() => ({
  render: () => `<span data-probe="footnote">record and activity</span>`,
}));

/** The committed record a write collapsed into: the row, and the durable half of it. */
const committed = (): LiveItem => ({
  _tag: "item",
  id: "record:evt-real",
  origin: "record",
  sequence: 7,
  kind: "intent.added",
  at: AT,
  attemptId: null,
  roundId: "rnd_1",
  headline: "Intent added",
  body: "intent int_real was added",
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
});

/**
 * The `tool.call` folded into it, named the way a driver names it.
 *
 * Built from `@bit/contracts` rather than typed out, for the reason `fakeServer.ts`'s
 * `livePlannerCall` is: a fixture that fabricates the bare name asserts against a tool-name
 * space the server never produces.
 */
const proposed = (): LiveItem => {
  const server = bitMcpServerName("rnd_1");
  const wire = claudeCodeToolName(server, "add_intent");
  return {
    ...committed(),
    id: "activity:7",
    origin: "activity",
    sequence: null,
    kind: "tool.call",
    headline: wire,
    body: "",
    tool: wire,
    toolName: bareToolName(wire, server) ?? null,
    callId: "toolu_01C1CDQ1",
    input: '{"question":"can the limiter be bypassed?"}',
  };
};

const composer = createRawSnippet(() => ({
  render: () => `<form data-probe="composer"></form>`,
}));

const controls = createRawSnippet(() => ({
  render: () => `<button data-probe="stop">Stop</button>`,
}));

/**
 * Renders the chat with the two props every case shares already filled.
 *
 * Typed against the component's own props rather than a loose record, so a test cannot
 * pass a prop the component does not declare — which is the whole value of rendering the
 * real component instead of asserting on a string.
 */
const body = (
  props: Omit<
    ComponentProps<typeof Chat<ChatRound["subject"]>>,
    "label" | "empty" | "separator" | "footnote"
  >,
): string => {
  /*
   * Assembled into a typed local first, so the component's `Subject` parameter is inferred
   * from the whole props object rather than from each argument on its own. Passed inline,
   * TypeScript resolves `Subject` to `unknown` before it sees the separator and then
   * reports the separator as the mismatch — which is the generic failing to bind, not a
   * wrong snippet.
   */
  const all = {
    label: "Planner conversation",
    empty: "Nothing yet.",
    separator,
    footnote,
    ...props,
  } satisfies ComponentProps<typeof Chat<ChatRound["subject"]>>;
  return render(Chat<ChatRound["subject"]>, { props: all }).body;
};

describe("the composer, which slice 9 depends on", () => {
  test("read-only renders no composer even when one is passed", () => {
    // Hidden rather than disabled: a disabled box reads as "not yet", and an operator may
    // not prompt a planner round ever — the round's prompt is assembled server-side.
    const html = body({ groups: [], readonly: true, composer });
    expect(html).not.toContain(`data-probe="composer"`);
  });

  test("the same component renders the composer when the prop says otherwise", () => {
    const html = body({ groups: [], readonly: false, composer });
    expect(html).toContain(`data-probe="composer"`);
  });

  test("the controls strip is rendered either way, because stopping is not a message", () => {
    expect(body({ groups: [], readonly: true, controls })).toContain(
      `data-probe="stop"`,
    );
    expect(body({ groups: [], readonly: false, controls })).toContain(
      `data-probe="stop"`,
    );
  });

  test("read-only with no composer passed renders none, which is the planner's case", () => {
    const html = body({ groups: [], readonly: true });
    expect(html).not.toContain("<form");
  });
});

describe("the separator, which the caller owns", () => {
  test("the group's heading is the caller's snippet and this component adds nothing to it", () => {
    // The other half of ruling 1. `Chat` renders the separator it is handed and knows
    // nothing about what a group is, so slice 9's goal conversation — which has no rounds in
    // it at all — writes its own heading and changes nothing in this file.
    const html = body({ groups: [chatRound()], readonly: true });
    expect(html).toContain(`data-probe="sep"`);
    expect(html).toContain("rnd_1");
    // No planner vocabulary of its own: nothing here knows a round has a status or a
    // disposition.
    expect(html).not.toContain("Finished");
    expect(html).not.toContain("Added work worth running");
  });

  test("the durability footnote is the caller's too, and is not optional", () => {
    // Required rather than optional: a chat mixing committed records with in-process
    // narration and saying nothing about the difference is what `live.ts` exists to prevent.
    expect(body({ groups: [], readonly: true })).toContain(
      `data-probe="footnote"`,
    );
  });

  test("a group whose prose the harness has forgotten keeps its heading and says so", () => {
    // The whole of decision 16: the structure comes from rows and the prose from the
    // harness, so a reload degrades to this rather than to a blank chat.
    const html = body({
      groups: [
        chatRound({
          prose: {
            _tag: "forgotten",
            note: "OpenCode no longer holds session ses_1.",
          },
        }),
      ],
      readonly: true,
    });
    expect(html).toContain(`data-probe="sep"`);
    expect(html).toContain("no longer holds session ses_1");
    // "The harness no longer has this" is not an error state and must not render as one.
    expect(html).not.toContain(`role="alert"`);
  });

  test("a group with no narration yet is announced; a forgotten one is not", () => {
    const pending = body({
      groups: [
        chatRound({
          subject: {
            round: row({ status: "running", endedAt: null, disposition: null }),
            inFlight: true,
          },
          prose: { _tag: "pending", note: "Nothing from it yet." },
        }),
      ],
      readonly: true,
    });
    expect(pending).toContain("Nothing from it yet.");
    expect(pending).toContain(`role="status"`);
  });

  test("a replayed group labels what it is and admits what the shape cost", () => {
    const html = body({
      groups: [
        chatRound({
          prose: {
            _tag: "replayed",
            note: "From OpenCode, which may delete it. Replayed messages carry no tool arguments.",
            ephemeral: true,
            truncated: true,
          },
          replayed: [
            {
              index: 0,
              type: "assistant",
              text: "two dimensions are untested",
            },
          ],
        }),
      ],
      readonly: true,
    });
    expect(html).toContain("which may delete it");
    expect(html).toContain("two dimensions are untested");
    expect(html).toContain("Shortened");
  });

  test("an empty chat says what would fill it, and a failed read is an alert", () => {
    expect(body({ groups: [], readonly: true })).toContain("Nothing yet.");
    const failed = body({
      groups: [],
      readonly: true,
      detail: "No server answered at this address.",
    });
    expect(failed).toContain(`role="alert"`);
    expect(failed).toContain("No server answered");
  });

  test("a recorded row shows the record's own id, which is what its sentence calls real", () => {
    /*
     * The row used to render only `proposedBy.callId` — the harness's local, non-durable
     * tool-call id — beneath a sentence saying "the id above is the real one". That told an
     * operator the opposite of the distinction the merge rule exists to draw: the record
     * wins *because* its id is the durable one.
     *
     * Both are now rendered, and the sentence names which is which.
     */
    const html = body({
      groups: [
        chatRound({
          rows: [
            {
              key: "record:evt-real",
              item: committed(),
              proposedBy: proposed(),
              result: null,
              write: "recorded",
              summary: "can the limiter be bypassed?",
            },
          ],
        }),
      ],
      readonly: true,
    });
    // The store's own event id, on the row.
    expect(html).toContain("record:evt-real");
    expect(html).toContain("durable identity");
    // The harness's call id too, said to be the one that is not durable.
    expect(html).toContain("call toolu_01");
    expect(html).toContain("not durable");
    // And the sentence no longer claims an id the row does not show.
    expect(html).toContain("The store's own event id is above");
    expect(html).not.toContain("the id above is the real one");
  });

  test("a recorded row keeps the record's own sentence, not the call's summary", () => {
    // `ChatItem`'s `{:else if}`: a committed record has a body of its own, so the summary of
    // the request that produced it is not shown beneath it as a second version of the fact.
    const html = body({
      groups: [
        chatRound({
          rows: [
            {
              key: "record:evt-real",
              item: committed(),
              proposedBy: proposed(),
              result: null,
              write: "recorded",
              summary: "can the limiter be bypassed?",
            },
          ],
        }),
      ],
      readonly: true,
    });
    expect(html).toContain(">intent int_real was added<");
    // Not as the row's own text. The question is still on the row inside the collapsed
    // "Arguments the round asked with" block, which is the whole reason the call is kept —
    // so the assertion is about the element's text, not about the string being absent.
    expect(html).not.toContain(">can the limiter be bypassed?<");
  });

  test("a caller's note about what is not shown is rendered as a note, not an alert", () => {
    const html = body({
      groups: [chatRound()],
      readonly: true,
      note: "3 older rounds are not here.",
    });
    expect(html).toContain("3 older rounds are not here.");
    expect(html).not.toContain(`role="alert"`);
  });
});

describe("the planner's own half of the chat", () => {
  /**
   * The real component, with a real {@link App} the fake server has answered into.
   *
   * Rendered rather than stubbed, because the point of these cases is the content the
   * separator carries — which moved out of `Chat.svelte` into `PlannerChat.svelte` when the
   * component was parameterised on its subject, and would otherwise be untested markup.
   */
  const plannerBody = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<string> => {
    const fake = new FakeServer();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    arrange(fake);
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    return render(PlannerChat, { props: { app } }).body;
  };

  test("a settled round's separator carries its status, its id and what it concluded", async () => {
    const html = await plannerBody((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({ rounds: [planRoundView({ targetId, goalId })] });
    });
    expect(html).toContain("Finished");
    expect(html).toContain("rnd_1");
    expect(html).toContain("Added work worth running");
    expect(html).toContain("1 round");
  });

  test("a round this process is driving says so, and offers a stop", async () => {
    const html = await plannerBody((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              status: "running",
              disposition: null,
              dispositionRationale: null,
              endedAt: null,
            }),
          ],
        });
      fake.onRounds = () => ok([runningRound({ roundId: "rnd_1" })]);
    });
    expect(html).toContain("Running");
    expect(html).toContain("in flight here");
    expect(html).toContain("Stop");
    expect(html).toContain("Planning for");
    // A running round has nothing to conclude, so no conclusion is claimed for it.
    expect(html).not.toContain("It recorded no conclusion");
  });

  test("the planner chat has no composer, in any state", async () => {
    const html = await plannerBody((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({ rounds: [planRoundView({ targetId, goalId })] });
    });
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<input");
  });

  test("older rounds left out of the chat are counted in the planner's own sentence", async () => {
    const html = await plannerBody((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: Array.from({ length: 11 }, (_, index) =>
            planRoundView({
              targetId,
              goalId,
              roundId: `rnd_${String(index)}`,
              startedAt: AT - index,
            }),
          ),
        });
    });
    expect(html).toContain("3 older rounds are not here");
    expect(html).toContain("still listed above");
  });
});
