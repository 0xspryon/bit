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
  type LiveUsage,
  type PlanRoundView,
  GoalUploadRefused,
} from "@bit/contracts";

import Chat from "../src/lib/components/Chat.svelte";
import ContextMeter from "../src/lib/components/ContextMeter.svelte";
import GoalAgentChat from "../src/lib/components/GoalAgentChat.svelte";
import PlannerChat from "../src/lib/components/PlannerChat.svelte";
import { App } from "../src/lib/app.svelte";
import {
  AT,
  FakeServer,
  goalConversationView,
  goalNarrationView,
  goalUploadsAccepted,
  goalView,
  liveGoalAgentCall,
  liveItem,
  liveOpened,
  ok,
  planRoundView,
  refused,
  replayItem,
  roundNarration,
  runningRound,
  targetSummary,
} from "./fakeServer";
import { FakeCountdown } from "./fakeCountdown";
import {
  THINKING_KIND,
  contextMeter,
  rowsFor,
  type ChatRound,
  type ContextMeter as ContextMeterView,
} from "../src/lib/chat";

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
  goalId: null,
  importId: null,
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

/* ── Thinking ────────────────────────────────────────────────────────────────── */

/**
 * What the agent considered, and the two rulings that decide how it is drawn.
 *
 * Ruling 2: **collapsed by default, and never presented as a record of what happened.** So
 * the text is inside a `<details>` — shut, it is out of the accessibility tree, which is
 * the same argument a tool's arguments are behind one — and the row says in words that it
 * is a record of what was *considered*.
 */
describe("a thinking row", () => {
  const thought = (body: string): LiveItem => ({
    ...committed(),
    id: "activity:9",
    origin: "activity",
    sequence: null,
    kind: THINKING_KIND,
    headline: "Thinking",
    body,
  });

  const withRow = (item: LiveItem): string =>
    body({
      groups: [
        chatRound({
          rows: [
            {
              key: item.id,
              item,
              proposedBy: null,
              result: null,
              write: null,
              summary: null,
            },
          ],
        }),
      ],
      readonly: true,
    });

  test("it is collapsed, and says what it is rather than what happened", () => {
    const html = withRow(thought("The limiter is probably per-IP."));
    // Inside the disclosure, not in the row's own body: an open `<details>` is a reader
    // asking for it.
    expect(html).toContain("What it considered");
    expect(html).toContain("<details");
    // Shut by default — a rendered `<details>` with no `open` attribute.
    expect(html).not.toContain("<details open");
    expect(html).toContain("The limiter is probably per-IP.");
    // The sentence that stops it being read as the account of the run.
    expect(html).toContain("not what it did");
    expect(html).toContain("Not stored here");
  });

  test("a thinking row with nothing in it renders no disclosure at all", () => {
    /*
     * The server drops an empty block, so this should not be reachable — and the component
     * still has to be right about it, because "the harness closed a block it put nothing
     * in" must never render as "the agent considered nothing".
     */
    const html = withRow(thought(""));
    expect(html).not.toContain("What it considered");
    expect(html).not.toContain("not what it did");
    // The row itself is still there with its label, which is the honest minimum.
    expect(html).toContain("Thinking");
  });
});

/* ── The context meter ───────────────────────────────────────────────────────── */

/**
 * The figure at the top of the pane, and the one thing it must never do.
 *
 * A percentage is drawn **only when a limit is known** (ruling 3). The rules are
 * `chat.ts`'s and are tested there; what is asserted here is that the markup obeys them —
 * including the sentence that says why there is no percentage, which is the part a reader
 * actually needs.
 */
describe("the context meter", () => {
  const meterBody = (
    meter: ContextMeterView | undefined,
    facts: readonly { readonly term: string; readonly value: string }[] = [],
  ): string =>
    render(ContextMeter, {
      props: { meter, label: "Planner round context", facts },
    }).body;

  const usage = (over: Partial<LiveUsage> = {}): LiveUsage => ({
    _tag: "usage",
    callId: "msg_1",
    promptTokens: 13_750,
    outputTokens: 3,
    contextLimit: 200_000,
    compactionAt: 170_000,
    attemptId: null,
    roundId: "rnd_1",
    goalId: null,
    importId: null,
    at: AT,
    ...over,
  });

  test("a known window gets a figure, a percentage and the call it measured", () => {
    const html = meterBody(contextMeter(usage()), [
      { term: "Model", value: "openai/gpt-5.6-sol" },
    ]);
    expect(html).toContain("13,753 / 200,000");
    expect(html).toContain("7%");
    expect(html).toContain("msg_1");
    expect(html).toContain("openai/gpt-5.6-sol");
    // The sentence that keeps the figure from being read as a session's spend, which is
    // the mistake the whole design is organised around.
    expect(html).toContain("one model call");
  });

  test("no window means no percentage, and a sentence saying so", () => {
    const html = meterBody(
      contextMeter(usage({ contextLimit: null, outputTokens: null })),
    );
    expect(html).toContain("13,750 tokens");
    expect(html).not.toContain("%");
    expect(html).toContain("No context window was reported");
    // And the output side says it is unstated rather than showing a zero.
    expect(html).toContain("not stated yet");
  });

  test("the harness's own compaction point is on the meter and in the panel", () => {
    /*
     * The finding this exists for: "this application does not compact" was false. bit never
     * calls compaction and OpenCode compacts anyway, at 231 200 tokens on bit's default
     * model — **58 %** of the 400 000 this bar is drawn against. An operator shown only the
     * window would watch it pass halfway with the session being rewritten underneath.
     */
    const html = meterBody(
      contextMeter(
        usage({
          promptTokens: 120_000,
          outputTokens: 500,
          contextLimit: 400_000,
          compactionAt: 231_200,
        }),
      ),
    );
    // The number, in the panel, in words.
    expect(html).toContain("Summarised at");
    expect(html).toContain("231,200 tokens");
    expect(html).toContain("summarises a session on its own at");
    // And marked on the track, at its own fraction of the window rather than at the fill.
    expect(html).toContain("left: 58%");
    // Said as what it is: read from the harness's policy, not reported by it.
    expect(html).toContain("rather than reported");
  });

  test("past the compaction point the panel says the figure may go backwards", () => {
    const html = meterBody(
      contextMeter(
        usage({
          promptTokens: 235_000,
          outputTokens: 0,
          contextLimit: 400_000,
          compactionAt: 231_200,
        }),
      ),
    );
    expect(html).toContain("Past the point where this harness summarises");
    /*
     * The tense is load-bearing, which is why it is asserted.
     *
     * This call was **sent** at this size — the rewrite had not happened when it went — so
     * the figure is a true measurement and the sentence must not retract it. What is true
     * past this point is about the *next* call. Asserted with whitespace collapsed, because
     * prettier wraps the markup.
     */
    const flat = html.replace(/\s+/gu, " ");
    expect(flat).toContain("is about to be, or has already been, rewritten");
    expect(flat).not.toContain("has most likely already been rewritten");
    // The one thing an operator cannot work out for themselves: the next figure is smaller,
    // and that is not the meter losing count.
    expect(html).toContain("smaller");
    expect(html).toContain(`role="status"`);
  });

  test("a harness that states no threshold draws no mark and claims nothing", () => {
    const html = meterBody(contextMeter(usage({ compactionAt: null })));
    expect(html).toContain("not stated by this harness");
    // No tick, and no sentence about a policy nobody measured.
    expect(html).not.toContain("left:");
    expect(html).not.toContain("summarises a session on its own");
  });

  test("a session that has not called a model renders nothing at all", () => {
    // Not a zero and not a placeholder: there is no context to be a fraction of. The
    // render is Svelte's own anchor comments and nothing else.
    const html = meterBody(undefined);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("tokens");
    expect(html.replace(/<!--.*?-->/gu, "").trim()).toBe("");
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

  /** A replay's items as a group's rows, the way every builder makes them (A6 F10). */
  const replayRows = (items: readonly LiveItem[]) => rowsFor(items, false);

  test("a replayed group labels what it is, and its rows are drawn like live ones", () => {
    const html = body({
      groups: [
        chatRound({
          prose: {
            _tag: "replayed",
            note: "From OpenCode, which may delete it.",
            ephemeral: true,
            truncated: true,
          },
          rows: replayRows([
            replayItem(0, "turn.reply", "two dimensions are untested"),
          ]),
        }),
      ],
      readonly: true,
    });
    expect(html).toContain("which may delete it");
    expect(html).toContain("two dimensions are untested");
    expect(html).toContain("Shortened");
  });

  /*
   * S3: a thread drops the label over the agent's own words, and only those. A harness entry
   * that is neither side — OpenCode's `shell` and `synthetic`, an error on a turn — is a
   * `turn.other` item under the harness's own word, which must not read as the agent.
   */
  const mixed = (): ChatRound =>
    chatRound({
      prose: {
        _tag: "replayed",
        note: "From OpenCode, which may delete it.",
        ephemeral: true,
        truncated: false,
      },
      rows: replayRows([
        replayItem(0, "turn.reply", "reading the policy page"),
        replayItem(1, "turn.other", "$ curl -sI https://acme.com", {
          headline: "shell",
        }),
        replayItem(2, "turn.other", "injected by the harness", {
          headline: "synthetic",
        }),
        replayItem(3, "turn.reply", "three entries are in scope"),
        replayItem(4, "turn.other", "the model stopped", {
          headline: "error",
          outcome: "failed",
        }),
      ]),
    });
  /** The harness's word on each narrated `turn.other` block, in order. */
  const labels = (html: string): string[] =>
    [
      ...html.matchAll(
        /<span class="what[^"]*">[^<]*<\/span>\s*([^<\s][^<]*?)\s*<!--/g,
      ),
    ].map((match) => match[1] ?? "");

  test("a thread labels every harness entry but the agent's own words", () => {
    const html = body({ groups: [mixed()], readonly: true, layout: "thread" });
    expect(labels(html)).toEqual(["shell", "synthetic", "error"]);
    expect(html).toContain("three entries are in scope");
    // The agent's words are prose, unlabelled.
    expect(html.match(/<li class="prose/g)).toHaveLength(2);
  });

  test("a panel keeps a kind on every replayed row, the agent's included", () => {
    const html = body({ groups: [mixed()], readonly: true });
    expect(
      [...html.matchAll(/<span class="kind mono[^"]*">([^<]*)</g)].map(
        (match) => match[1],
      ),
    ).toEqual(["Reply", "Harness", "Harness", "Reply", "Harness"]);
  });

  /*
   * S4: the agent's words render as markdown, replayed and live alike — one path now, since
   * a replayed reply is the same `turn.reply` item. What markdown does to the text is
   * `test/dom/markdown.test.ts`; this is only that both reach it.
   */
  test("the agent's words are markdown on both paths, live and replayed", () => {
    const reply: LiveItem = {
      ...committed(),
      id: "activity:1",
      origin: "activity",
      sequence: null,
      kind: "turn.reply",
      headline: "Reply",
      body: "Layout:\n\n```text\nsrc/\n  lib/\n```",
    };
    const html = body({
      groups: [
        chatRound({
          prose: {
            _tag: "replayed",
            note: "From OpenCode, which may delete it.",
            ephemeral: true,
            truncated: false,
          },
          rows: replayRows([
            replayItem(
              0,
              "turn.reply",
              "| Asset | In |\n| --- | --- |\n| `acme.com` | yes |",
            ),
          ]),
        }),
        chatRound({
          key: "rnd_2",
          prose: { _tag: "live" },
          rows: [
            {
              key: reply.id,
              item: reply,
              proposedBy: null,
              result: null,
              write: null,
              summary: null,
            },
          ],
        }),
      ],
      readonly: true,
      layout: "thread",
    });
    // Replayed: a table in its scroller, not a row of pipes.
    expect(html).toContain(`<div class="table-wrap"><table>`);
    expect(html).toContain("<td><code>acme.com</code></td>");
    expect(html).not.toContain("| Asset |");
    // Live: a fence, its indentation intact, and no backticks left.
    expect(html).toContain(
      `<pre data-language="text"><code class="language-text">src/\n  lib/\n</code></pre>`,
    );
    expect(html).not.toContain("```");
  });

  const foot = createRawSnippet<[ChatRound]>((group) => ({
    render: () => `<span data-probe="foot">${group().key}</span>`,
  }));
  /** The text of the element the footer probe was rendered inside. */
  const captioned = (html: string): string | undefined => {
    const at = html.indexOf(`data-probe="foot"`);
    if (at === -1) return undefined;
    const open = html.lastIndexOf("<li", at);
    return html.slice(open, at);
  };

  test("a thread's footer sits inside the last entry the agent said words in", () => {
    const html = body({
      groups: [mixed()],
      readonly: true,
      layout: "thread",
      footer: foot,
    });
    expect(html.match(/data-probe="foot"/g)).toHaveLength(1);
    // Not the error-only entry after it, and not the `shell` or `synthetic` ones.
    expect(captioned(html)).toContain("three entries are in scope");
  });

  test("a live reply takes the footer over the replayed copy, and a call after it does not", () => {
    const reply = (id: string, text: string): LiveItem => ({
      ...committed(),
      id,
      origin: "activity",
      sequence: null,
      kind: "turn.reply",
      headline: "Reply",
      body: text,
    });
    const rows = [
      reply("activity:1", "first words"),
      reply("activity:2", "I will add the intent now"),
      reply("activity:3", "   "),
    ].map((item) => ({
      key: item.id,
      item,
      proposedBy: null,
      result: null,
      write: null,
      summary: null,
    }));
    const html = body({
      groups: [
        chatRound({
          prose: { _tag: "live" },
          rows: [
            ...rows,
            {
              key: "record:evt-real",
              item: committed(),
              proposedBy: proposed(),
              result: null,
              write: "recorded",
              summary: null,
            },
          ],
        }),
      ],
      readonly: true,
      layout: "thread",
      footer: foot,
    });
    expect(html.match(/data-probe="foot"/g)).toHaveLength(1);
    expect(captioned(html)).toContain("I will add the intent now");
  });

  test("no footer on a group with no words, nor in a panel", () => {
    const silent = chatRound({
      prose: { _tag: "none", note: "The importer wrote nothing." },
    });
    expect(
      body({
        groups: [silent],
        readonly: true,
        layout: "thread",
        footer: foot,
      }),
    ).not.toContain(`data-probe="foot"`);
    expect(
      body({ groups: [mixed()], readonly: true, footer: foot }),
    ).not.toContain(`data-probe="foot"`);
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
  const plannerApp = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<{ app: App; fake: FakeServer }> => {
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
    return { app, fake };
  };

  const plannerBody = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<string> => {
    const { app } = await plannerApp(arrange);
    return render(PlannerChat, { props: { app } }).body;
  };

  test("the context meter sits in the pane's head, naming the round's own model", async () => {
    /*
     * The whole of the slice's second half, end to end through the real component: a usage
     * frame arrives on the target's feed, the app files it under the round it names, and
     * this pane draws it beside its heading with the round's own harness and model — which
     * come from the round's **row**, because a running round's in-flight record carries
     * neither.
     */
    const { app, fake } = await plannerApp((server) => {
      server.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({ rounds: [planRoundView({ targetId, goalId })] });
    });
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send({
      _tag: "usage",
      callId: "msg_1",
      promptTokens: 13_750,
      outputTokens: 3,
      contextLimit: 200_000,
      compactionAt: 170_000,
      attemptId: null,
      roundId: "rnd_1",
      goalId: null,
      importId: null,
      at: AT,
    });
    await settle();

    const html = render(PlannerChat, { props: { app } }).body;
    expect(html).toContain("13,753 / 200,000");
    expect(html).toContain("Planner round context");
    expect(html).toContain("openai/gpt-5.6-sol");
    expect(html).toContain("ses_1");
    /*
     * The brief's "message counts", and the value says what it counts.
     *
     * It is the harness's **replayed** copy, which is the only count this application has:
     * narration is not persisted, so nothing here knows how many messages a round really
     * had. A bare number would read as the second thing — and on a round whose replay was
     * never asked for it would read as zero messages rather than as no answer, which is
     * what "not read" says instead.
     */
    expect(html).toContain("Replayed");
    expect(html).toContain("not read");
  });

  test("the panel counts the messages the harness actually answered with", async () => {
    const { app, fake } = await plannerApp((server) => {
      server.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({ rounds: [planRoundView({ targetId, goalId })] });
      server.onGoalNarration = (_baseUrl, targetId, goalId) =>
        ok(
          goalNarrationView({
            targetId,
            goalId,
            rounds: [roundNarration({ roundId: "rnd_1" })],
          }),
        );
    });
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send({
      _tag: "usage",
      callId: "msg_1",
      promptTokens: 13_750,
      outputTokens: 3,
      contextLimit: 200_000,
      compactionAt: 170_000,
      attemptId: null,
      roundId: "rnd_1",
      goalId: null,
      importId: null,
      at: AT,
    });
    await settle();

    const html = render(PlannerChat, { props: { app } }).body;
    // `roundNarration`'s own two messages, and the value names whose count it is.
    expect(html).toContain("2 items held by the harness");
  });

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

describe("the goal agent's own half of the chat", () => {
  /**
   * The real component, with a real {@link App} the fake server has answered into.
   *
   * The same arrangement as the planner's body above, and the contrast between the two is
   * the point: one renders `Chat` read-only with controls where a composer would be, the
   * other renders it with a composer — and `Chat.svelte` is the same file in both cases,
   * unmodified by this slice. That is ruling 1 holding.
   */
  const goalBody = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<{ html: string; app: App; fake: FakeServer }> => {
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
    return { html: render(GoalAgentChat, { props: { app } }).body, app, fake };
  };

  test("an active goal gets a composer, which is the half the planner's chat has not", async () => {
    const { html } = await goalBody();
    expect(html).toContain("<form");
    expect(html).toContain("<textarea");
    expect(html).toContain("Send to the goal agent");
    // The ruling, on the screen as well as in the toolkit: an operator reading this knows
    // why asking for an intent produces a steer rather than a row.
    expect(html).toContain("cannot create intents itself");
  });

  test("a goal nobody has talked to says so instead of showing an empty conversation", async () => {
    const { html } = await goalBody();
    expect(html).toContain("Nobody has talked to this goal's agent yet");
    // No separator, because there is no conversation to put one over.
    expect(html).not.toContain("Goal agent</span>");
  });

  test("a conversation the harness still has is labelled as the harness's copy", async () => {
    const { html } = await goalBody((fake) => {
      fake.onGoalConversation = (_baseUrl, targetId, goalId) =>
        ok(
          goalConversationView({
            targetId,
            goalId,
            harnessSessionId: "ses_goal_1",
            live: true,
            source: "harness",
            ephemeral: true,
            items: [
              replayItem(0, "turn.operator", "what is happening?", { goalId }),
              replayItem(1, "turn.reply", "One round has run.", { goalId }),
            ],
            note: "From OpenCode, which may delete it: this build stores no part of a conversation.",
          }),
        );
    });

    expect(html).toContain("Goal agent");
    expect(html).toContain("ses_goal_1");
    expect(html).toContain("One round has run.");
    // The cost decision 14 accepted, said rather than hidden.
    expect(html).toContain("may delete it");
    // The operator's own half of it comes back from the harness as a `user` entry, which is
    // the only reason a reload is not one-sided.
    expect(html).toContain("what is happening?");
    // A panel, so each replayed row is a ledger row with its kind, the operator's included:
    // the same `ChatItem` rows a live conversation draws (A6 F10).
    expect(
      [...html.matchAll(/<span class="kind mono[^"]*">([^<]*)</g)].map(
        (match) => match[1],
      ),
    ).toEqual(["You", "Reply"]);
  });

  test("a conversation this process no longer holds is marked, not silently shown", async () => {
    const { html } = await goalBody((fake) => {
      fake.onGoalConversation = (_baseUrl, targetId, goalId) =>
        ok(
          goalConversationView({
            targetId,
            goalId,
            harnessSessionId: "ses_before",
            live: false,
            source: "harness",
            ephemeral: true,
            items: [replayItem(0, "turn.reply", "earlier words", { goalId })],
            note: "This conversation was opened by a server process that is no longer running.",
          }),
        );
    });

    expect(html).toContain("earlier words");
    // Readable and not continuable, which are two facts: a chip rather than a colour, so a
    // monochrome display carries it too.
    expect(html).toContain("not this process's");
    expect(html).toContain("no longer running");
  });

  test("an ended goal has no composer and a sentence in its place", async () => {
    const ended = (targetId: string) =>
      goalView({
        targetId,
        goalId: "goal_1",
        status: "abandoned",
        endedAt: AT + 1,
        endedBy: "goal_agent",
        endReason: "The operator asked me to stop.",
      });
    const { html } = await goalBody((fake) => {
      fake.onGoals = (_baseUrl, targetId) => ok({ goals: [ended(targetId)] });
      // And the single-goal read, which `openGoal` makes straight after the list and which
      // replaces the row: overriding only the list would leave an active goal on screen.
      fake.onGoal = (_baseUrl, targetId) => ok(ended(targetId));
    });

    // Not a disabled box: an ended goal's agent has no authority left, and a control that
    // cannot be pressed and does not say so is a question rather than an answer.
    expect(html).not.toContain("<textarea");
    expect(html).toContain("has ended, so its agent has no authority left");
  });

  test("the conversation's panel counts the messages the harness holds", async () => {
    // The brief's "message counts" on this surface. The harness's replayed copy, labelled
    // as such: not a word of this conversation is stored, so there is no other count — and
    // this tab's own unreplayed turns are deliberately not added in, because a single
    // number covering both would be counting two different things.
    const { html, app, fake } = await goalBody((server) => {
      server.onGoalConversation = (_baseUrl, targetId, goalId) =>
        ok(
          goalConversationView({
            targetId,
            goalId,
            harnessSessionId: "ses_live",
            source: "harness",
            ephemeral: true,
            items: [
              replayItem(0, "turn.operator", "look at the lockout path", {
                goalId,
              }),
              replayItem(1, "turn.reply", "steering the planner", { goalId }),
            ],
            note: "From Claude Code, which may delete it.",
          }),
        );
    });
    expect(html).toContain("ses_live");

    // The count rides the panel, so it needs a model call to open a panel at all.
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send({
      _tag: "usage",
      callId: "msg_g1",
      promptTokens: 21_388,
      outputTokens: null,
      // Claude Code states neither, which is also what this asserts: the panel's
      // threshold row says so rather than drawing a mark.
      contextLimit: null,
      compactionAt: null,
      attemptId: null,
      roundId: null,
      goalId: "goal_1",
      importId: null,
      at: AT,
    });
    await settle();

    const withMeter = render(GoalAgentChat, { props: { app } }).body;
    expect(withMeter).toContain("2 items held by the harness");
    expect(withMeter).toContain("ses_live");
    expect(withMeter).toContain("not stated by this harness");
  });

  /**
   * The goal agent's own writes, on the screen rather than in the reducer.
   *
   * `chat.test.ts` asserts the merge rule over these three tools; this asserts that the
   * rule reaches the markup an operator reads, which is where the defect was *seen*: a
   * review found a steer rendered as two rows, one saying a tool was called and one saying
   * the same steer landed. Every tool name here is built by `@bit/contracts` from the goal's
   * own MCP server name — `bit-<goalId>` — because a fixture that typed `"steer_planner"`
   * would assert against a name no harness sends, which is exactly how this survived.
   */
  describe("the goal agent's writes on screen", () => {
    /** The app with the live stream opened, so items can be pushed onto it. */
    const withLive = async (
      items: readonly LiveItem[],
    ): Promise<{ html: string; app: App }> => {
      const { app, fake } = await goalBody((server) => {
        server.onGoalConversation = (_baseUrl, targetId, goalId) =>
          ok(
            goalConversationView({
              targetId,
              goalId,
              harnessSessionId: "ses_goal_1",
              source: "harness",
              ephemeral: true,
              items: [
                replayItem(0, "turn.operator", "steer the planner", { goalId }),
              ],
            }),
          );
      });
      fake.watch.send(liveOpened({ from: 0, latest: 0 }));
      for (const item of items) fake.watch.send(item);
      await settle();
      return { html: render(GoalAgentChat, { props: { app } }).body, app };
    };

    /**
     * Rows in the rendered conversation. One `<li class="item …">` each.
     *
     * Matched on the class with its scoping suffix left open, because Svelte appends a
     * per-component hash — and anchored on the word boundary so the surrounding
     * `class="items …"` list is not counted as a row.
     */
    const rowCount = (html: string): number =>
      [...html.matchAll(/class="item\s/g)].length -
      // Less the replayed operator message every case here starts from (`withLive`), which
      // is a row of its own since the replay draws through `ChatItem` (A6 F10).
      1;

    test("a steer is one row, carrying the record and the call it came from", async () => {
      const { html } = await withLive([
        liveGoalAgentCall("steer_planner", {
          goalId: "goal_1",
          over: { callId: "toolu_steer" },
        }),
        liveItem({
          id: "record:evt-steer",
          sequence: 9,
          kind: "plan.round.steered",
          attemptId: null,
          roundId: "rnd_1",
          goalId: "goal_1",
          headline: "Round steered",
          body: "a directive was delivered to round rnd_1 at queued urgency",
          outcome: null,
        }),
      ]);

      // One row, where this shipped as two.
      expect(rowCount(html)).toBe(1);
      expect(html).toContain("recorded");
      // The record's sentence, and the record's own durable id beside the harness's local
      // call id — which is the pair the collapsed row exists to show.
      expect(html).toContain("a directive was delivered");
      expect(html).toContain("record:evt-steer");
      expect(html).toContain("call toolu_steer");
    });

    test("a goal ending is one row too", async () => {
      const { html } = await withLive([
        liveGoalAgentCall("end_goal", {
          goalId: "goal_1",
          over: { callId: "toolu_end" },
        }),
        liveItem({
          id: "record:evt-ended",
          sequence: 10,
          kind: "goal.ended",
          attemptId: null,
          roundId: null,
          goalId: "goal_1",
          headline: "Goal ended",
          body: "this goal was ended: met",
          outcome: null,
        }),
      ]);

      expect(rowCount(html)).toBe(1);
      expect(html).toContain("this goal was ended: met");
      expect(html).toContain("recorded");
    });

    test("a wake is one row with no write chip, because its record is the round's", async () => {
      // The decision, on screen: `plan.round.started` is written with no caller scope, so
      // it never reaches this conversation and the call is shown as a call. A `pending`
      // chip here would be the chat waiting on something that cannot arrive.
      const { html } = await withLive([
        liveGoalAgentCall("wake_planner", {
          goalId: "goal_1",
          over: { callId: "toolu_wake" },
        }),
      ]);

      expect(rowCount(html)).toBe(1);
      expect(html).toContain("wake_planner");
      expect(html).not.toContain(">pending<");
      expect(html).not.toContain(">unresolved<");
    });
  });

  test("the operator's own turn and the agent's are distinguishable without colour", async () => {
    const { app } = await goalBody();
    app.goalMessage = "look at the lockout path";
    await app.sendGoalMessage();
    const html = render(GoalAgentChat, { props: { app } }).body;

    // The label, as a word: "You" on the minted turn, and the activity marker that says it
    // is not part of the record.
    expect(html).toContain("You");
    expect(html).toContain("look at the lockout path");
    expect(html).toContain("activity");
    expect(html).toContain("Waiting for the agent");
  });

  test("the composer offers a file control, with a real input behind the paperclip", async () => {
    const { html } = await goalBody();
    // A real `<input type="file">`, not only a button: a browser cannot produce bytes
    // without one, and it stays in the accessibility tree with its own label so the
    // paperclip is a convenience over a working control rather than a replacement for it.
    expect(html).toContain('type="file"');
    expect(html).toContain("Attach files to this goal");
    expect(html).toContain("Attach files the goal agent can read");
  });

  test("an attached file is listed by the name the server chose, with what happens next", async () => {
    const { app, fake } = await goalBody();
    fake.onUploadGoalFiles = (_baseUrl, targetId, goalId) =>
      ok(
        goalUploadsAccepted({
          targetId,
          goalId,
          // Deliberately not the name passed in below: this is what says the list is built
          // from the **server's** answer rather than from the browser's own `File`.
          files: [{ name: "scope-letter.pdf", bytes: 2_048 }],
          note: "It has not been told yet: the list goes to it with your next message.",
        }),
      );

    await app.attachGoalFiles([
      new File(["a scope letter"], "SCOPE LETTER.pdf", {
        type: "application/pdf",
      }),
    ]);
    const html = render(GoalAgentChat, { props: { app } }).body;

    expect(html).toContain("scope-letter.pdf");
    expect(html).not.toContain("SCOPE LETTER.pdf");
    expect(html).toContain("2048 bytes");
    // The part an operator could otherwise get wrong: the files are there and the agent
    // does not know yet. The server composes that sentence; this only places it.
    expect(html).toContain("your next message");
  });

  test("a refused upload says why, in the server's words, beside the composer", async () => {
    const { app, fake } = await goalBody();
    const detail =
      "'huge.bin' is more than 10485760 bytes (10.0 MiB), which is this server's per-file cap, so reading it was abandoned and nothing in that request was attached.";
    fake.onUploadGoalFiles = () =>
      refused(new GoalUploadRefused({ reason: "too_large", detail }));

    await app.attachGoalFiles([new File(["x"], "huge.bin")]);
    const html = render(GoalAgentChat, { props: { app } }).body;

    // As written, including both figures: a rejected upload that said only "failed" would
    // be the first refusal in this app that does not teach.
    expect(html).toContain("10485760 bytes");
    expect(html).toContain("per-file cap");
    expect(html).toContain('role="alert"');
    // And nothing is listed as attached, because nothing was.
    expect(app.goalAttachments).toEqual([]);
  });

  test("a replaced file stays one row and says it replaced one", async () => {
    const { app, fake } = await goalBody();
    fake.onUploadGoalFiles = (_baseUrl, targetId, goalId, files) =>
      ok(
        goalUploadsAccepted({
          targetId,
          goalId,
          files: files.map((file) => ({ name: file.name, bytes: file.size })),
          replaced: app.goalAttachments.length === 0 ? [] : ["notes.txt"],
        }),
      );

    await app.attachGoalFiles([new File(["one"], "notes.txt")]);
    await app.attachGoalFiles([new File(["corrected"], "notes.txt")]);
    const html = render(GoalAgentChat, { props: { app } }).body;

    // One row, because the agent will see one file: a list that grew a second row for a
    // replacement would show two documents where there is one.
    expect(app.goalAttachments).toHaveLength(1);
    expect(app.goalAttachments[0]?.bytes).toBe(9);
    expect(html).toContain("replaced an earlier one");
  });

  test("an ended goal has no composer, so there is nothing to attach to", async () => {
    const ended = (targetId: string) =>
      goalView({
        targetId,
        goalId: "goal_1",
        status: "met",
        endedAt: AT,
        endedBy: "operator",
        endReason: "established",
      });
    const { html } = await goalBody((fake) => {
      fake.onGoals = (_baseUrl, targetId) => ok({ goals: [ended(targetId)] });
      // `openGoal` re-reads the one goal and that answer replaces the row in the list, so
      // both have to say it ended or the list's version is overwritten by the default.
      fake.onGoal = (_baseUrl, targetId) => ok(ended(targetId));
    });

    // The composer goes away whole, the attach control with it: an ended goal's agent has
    // no authority left, and a file control that submitted into a refusal would be worse
    // than a sentence that explains itself.
    expect(html).not.toContain('type="file"');
    expect(html).toContain("This goal has ended");
  });
});
