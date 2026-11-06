/**
 * The shared chat shell, driven by a fake adapter (A6 prep for the goal, planner and worker
 * chats): what each capability draws, and what its absence does not.
 *
 * The importer's own suites (`importer.test.ts` and its neighbours) are the proof the shell
 * draws the importer as before; this file is the proof it draws a chat that is not the
 * importer — a closed composer with Stop still working, no Send now where the server cannot
 * steer, A7-Q's dock in the box's place, and A7-S's card, chip, panel and "Stop all".
 * Compared as strings and booleans, never with `toEqual` on a node.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";

import type {
  LiveItem,
  QuestionAnswerability,
  QuestionField,
} from "@bit/contracts";

import { click, settle } from "./dom";

const { default: FakeChatShell } =
  await import("./fixtures/FakeChatShell.svelte");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const each of cleanups) each();
  cleanups = [];
});

interface Options {
  readonly closed?: string;
  readonly stoppable?: boolean;
  readonly steerable?: boolean;
  readonly attachable?: boolean;
  readonly dock?: boolean;
  readonly asking?: boolean;
  readonly cards?: boolean;
  readonly stopAll?: boolean;
  readonly panel?: boolean;
  readonly since?: number;
  readonly elapsedLead?: string;
  readonly items?: readonly LiveItem[];
  readonly fields?: readonly QuestionField[];
  readonly answerability?: QuestionAnswerability;
  readonly canMessage?: boolean;
}

/** The fake chat, mounted; `calls` is what the shell asked the adapter to do. */
const shell = async (options: Options = {}) => {
  const calls: string[] = [];
  const root = document.body.appendChild(document.createElement("div"));
  const chat = mount(FakeChatShell, {
    target: root,
    props: { ...options, calls },
  });
  cleanups.push(() => {
    void unmount(chat);
    root.remove();
  });
  flushSync();
  await settle();
  const set = async (next: {
    readonly working?: boolean;
    readonly stopping?: boolean;
    readonly asking?: boolean;
    readonly shown?: boolean;
    readonly busy?: boolean;
    readonly refused?: string | undefined;
  }): Promise<void> => {
    chat.set(next);
    await settle();
  };
  const attach = async (files: readonly File[]): Promise<void> => {
    chat.attach(files);
    await settle();
  };
  return { calls, root, set, attach };
};

const subagent = (outcome: string | null): LiveItem => ({
  _tag: "item",
  id: `sub-${outcome ?? "running"}`,
  origin: "activity",
  sequence: null,
  at: 1_793_000_000_000,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: null,
  kind: "subagent",
  headline: "general-purpose",
  body: "Read the program page",
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: "toolu_1",
  outcome,
});

const button = (root: HTMLElement, selector: string): HTMLButtonElement => {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${selector}`);
  return found;
};
const textarea = (root: HTMLElement): HTMLTextAreaElement => {
  const found = root.querySelector("textarea");
  if (!(found instanceof HTMLTextAreaElement)) throw new Error("no textarea");
  return found;
};
const type = async (box: HTMLTextAreaElement, words: string): Promise<void> => {
  box.value = words;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};

describe("a closed composer (the planner's, a worker's)", () => {
  test("says why where the input would be, and draws no input, `+` or send", async () => {
    const { root, set } = await shell({
      closed: "Steered from the goal chat: a planner round takes no messages.",
      attachable: true,
      steerable: true,
    });
    await set({ working: true });
    expect(root.querySelector(".box .closed-reason")?.textContent?.trim()).toBe(
      "Steered from the goal chat: a planner round takes no messages.",
    );
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector('input[type="file"]')).toBeNull();
    expect(root.querySelector(".send")).toBeNull();
    expect(root.querySelector(".send-now")).toBeNull();
  });

  test("keeps Stop and its elapsed clock working above it", async () => {
    const { root, calls, set } = await shell({
      closed: "The prompt is the intent's question.",
      since: Date.now() - 65_000,
    });
    // Nothing runs: no Stop, and no clock.
    expect(root.querySelector(".stop")).toBeNull();
    expect(root.querySelector(".elapsed")).toBeNull();

    await set({ working: true });
    const stop = button(root, ".stop");
    expect(stop.textContent?.trim()).toBe("Stop");
    expect(stop.title).toBe("Stop the agent's turn.");
    expect(root.querySelector(".elapsed")?.textContent).toBe("1m 05s");
    click(stop);
    expect(calls.join(",")).toBe("stop");

    // A Stop out and unanswered: the pill says so, stays focusable, and sends nothing more.
    await set({ stopping: true });
    const pending = button(root, ".stop");
    expect(pending.textContent?.trim()).toBe("Stopping…");
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    click(pending);
    expect(calls.join(",")).toBe("stop");
  });

  test("the clock is led by the chat's own words where it has them (the planner's)", async () => {
    const { root, set } = await shell({
      closed: "Steered from the goal chat.",
      since: Date.now() - 65_000,
      elapsedLead: "Planning for",
    });
    await set({ working: true });
    const clock = root.querySelector(".elapsed");
    expect(clock?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "Planning for 1m 05s",
    );
    expect(clock?.querySelector("strong")?.textContent).toBe("1m 05s");
  });

  test("a chat that cannot stop draws no Stop while it runs", async () => {
    const { root, set } = await shell({ stoppable: false });
    await set({ working: true });
    expect(root.querySelector(".stop")).toBeNull();
  });
});

describe("Send now and the queue", () => {
  test("offered by the adapter: while a turn runs the arrow queues and Send now steers", async () => {
    const { root, calls, set } = await shell({ steerable: true });
    // Idle: one way to send.
    expect(root.querySelector(".send-now")).toBeNull();
    expect(button(root, ".send").title).toBe("Send to the agent");

    await set({ working: true });
    expect(button(root, ".send").title).toBe("Send to the agent, queued");
    const now = button(root, ".send-now");
    expect(now.title).toBe("Send it now");
    // Nothing typed: nothing to send ahead.
    expect(now.disabled).toBe(true);

    await type(textarea(root), "Skip the API host");
    expect(button(root, ".send-now").disabled).toBe(false);
    click(button(root, ".send-now"));
    await settle();
    expect(calls.join(",")).toBe("send:preemptive:Skip the API host");

    await type(textarea(root), "Then the docs");
    textarea(root).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle();
    expect(calls.join(",")).toBe(
      "send:preemptive:Skip the API host,send:queued:Then the docs",
    );
  });

  test("not offered: no Send now while a turn runs, and Enter still queues", async () => {
    const { root, calls, set } = await shell({ steerable: false });
    await set({ working: true });
    await type(textarea(root), "One more thing");
    expect(root.querySelector(".send-now")).toBeNull();
    click(button(root, ".send"));
    await settle();
    expect(calls.join(",")).toBe("send:queued:One more thing");
  });

  test("files only where the adapter has a tray", async () => {
    const without = await shell({ attachable: false });
    expect(without.root.querySelector('input[type="file"]')).toBeNull();
    expect(without.root.querySelector(".icon-btn")).toBeNull();
    const withTray = await shell({ attachable: true });
    expect(
      withTray.root.querySelector('input[type="file"]#fake-attach'),
    ).not.toBeNull();
  });
});

describe("A7-Q's question dock takes the composer's slot (E3)", () => {
  const box = (root: HTMLElement) => root.querySelector(".stack > form.box");
  const dock = (root: HTMLElement) => root.querySelector(".stack > .dock");

  test("while a question waits the box is not drawn and the dock is, in its place", async () => {
    const { root, set } = await shell({ dock: true, steerable: true });
    await set({ working: true });
    await type(textarea(root), "Half a sentence");
    expect(box(root)).not.toBeNull();
    expect(dock(root)).toBeNull();

    await set({ asking: true });
    expect(dock(root)?.querySelector("p")?.textContent).toBe(
      "Which host first?",
    );
    // In the box's place: no box, no textarea, no strip, no send buttons.
    expect(box(root)).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector(".send")).toBeNull();
    expect(root.querySelector(".send-now")).toBeNull();
    // Where the box was: after the sentences above it, in the composer's column.
    const notice = root.querySelector(".stack > .notice");
    expect(notice?.textContent?.trim()).toBe("The last message was delivered.");
    expect(
      notice !== null &&
        (notice.nextElementSibling?.classList.contains("dock") ?? false),
    ).toBe(true);
    // Stop stays where it was, above the composer's column.
    expect(root.querySelector(".controls .stop")?.textContent?.trim()).toBe(
      "Stop",
    );

    // Answered on the server: the box is back, with the words that were in it.
    await set({ asking: false });
    expect(dock(root)).toBeNull();
    expect(box(root)).not.toBeNull();
    expect(textarea(root).value).toBe("Half a sentence");
  });

  test("Esc in the dock gives the composer back, focused", async () => {
    const { root, calls } = await shell({ dock: true, asking: true });
    expect(box(root)).toBeNull();
    const answer = button(root, ".fake-answer");
    answer.focus();
    answer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(calls.join(",")).toBe("dismiss");
    expect(dock(root)).toBeNull();
    expect(box(root)).not.toBeNull();
    expect(document.activeElement === textarea(root)).toBe(true);
  });

  test("the dock's own dismiss gives the composer back too", async () => {
    const { root, calls } = await shell({ dock: true, asking: true });
    click(button(root, ".fake-reply"));
    await settle();
    expect(calls.join(",")).toBe("dismiss");
    expect(box(root)).not.toBeNull();
  });

  test("an Esc the dock's control kept for itself does not dismiss it", async () => {
    const { root, calls } = await shell({ dock: true, asking: true });
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    escape.preventDefault();
    button(root, ".fake-answer").dispatchEvent(escape);
    await settle();
    expect(calls.join(",")).toBe("");
    expect(dock(root)).not.toBeNull();
  });

  test("it takes a closed box's place as well, its reason included", async () => {
    const { root, set } = await shell({
      closed: "The prompt is the intent's question.",
      dock: true,
    });
    expect(root.querySelector(".closed-reason")).not.toBeNull();
    await set({ asking: true });
    expect(root.querySelector(".closed-reason")).toBeNull();
    expect(box(root)).toBeNull();
    expect(dock(root)).not.toBeNull();
    await set({ asking: false });
    expect(root.querySelector(".closed-reason")?.textContent).toBe(
      "The prompt is the intent's question.",
    );
  });

  test("a chat that passes no dock of its own gets the shell's question dock, and one asking nothing has no region", async () => {
    const asked = await shell({ asking: true });
    expect(box(asked.root)).toBeNull();
    expect(
      asked.root.querySelector(".stack > .dock > section.question-dock"),
    ).not.toBeNull();
    const quiet = await shell({});
    expect(quiet.root.querySelector(".dock")).toBeNull();
  });
});

describe("the hosting points for A7-S (E7, E8)", () => {
  test("the card hook draws a sub-agent's folded row, and the chip goes in the title bar", async () => {
    const { root } = await shell({
      cards: true,
      items: [subagent(null), subagent("finished")],
    });
    const cards = [...root.querySelectorAll("li.subagent-card .fake-card")].map(
      (card) => card.textContent?.trim(),
    );
    // One card per sub-agent, carrying its newest state (`foldSubagents`).
    expect(cards.join("|")).toBe("general-purpose: finished");
    // Not also the U14 entry.
    expect(root.querySelector("li.block.subagent")).toBeNull();
    // E8: in the app's title bar, not in the chat.
    expect(root.querySelector(".fake-bar .fake-chip")?.textContent).toBe(
      "1 sub-agent",
    );
    expect(root.querySelector(".chat-shell .fake-chip")).toBeNull();
  });

  test("a chip leaves the title bar with its chat, while the bar stays", async () => {
    // The chat in an `{#if}` beside a bar that stays mounted (chat shell review 2): a chip
    // that `place` never took back would stay in the bar after the chat went.
    const { root, set } = await shell({ cards: true });
    const bar = root.querySelector(".fake-bar");
    expect(bar?.querySelector(".fake-chip")).not.toBeNull();
    await set({ shown: false });
    expect(root.querySelector(".chat-shell")).toBeNull();
    expect(root.querySelector(".fake-bar") === bar).toBe(true);
    expect(bar?.querySelector(".fake-chip")).toBeNull();
    await set({ shown: true });
    expect(root.querySelector(".fake-bar .fake-chip")).not.toBeNull();
  });

  test("without the hook a sub-agent is U14's entry, and the bar holds nothing", async () => {
    const { root } = await shell({ items: [subagent("finished")] });
    expect(root.querySelector("li.subagent-card")).toBeNull();
    expect(root.querySelector("li.block.subagent")).not.toBeNull();
    expect(root.querySelector(".fake-bar")?.children.length).toBe(0);
  });

  test("the aside is E8's panel beside the chat's column, not inside it", async () => {
    const { root } = await shell({ panel: true });
    const aside = root.querySelector(".chat-shell > aside.aside");
    expect(aside?.textContent?.trim()).toBe("Sub-agents 1");
    // Beside the column the chat is drawn in.
    expect(
      aside?.previousElementSibling?.classList.contains("column") ?? false,
    ).toBe(true);
    expect(root.querySelector(".column aside")).toBeNull();
    const none = await shell({});
    expect(none.root.querySelector("aside")).toBeNull();
  });

  test("the controls hook sits beside Stop, and is the chat's to draw", async () => {
    const { root, calls, set } = await shell({ stopAll: true });
    // Drawn whether or not Stop is: the chat decides when "Stop all" applies.
    expect(root.querySelector(".controls .fake-stop-all")).not.toBeNull();
    await set({ working: true });
    const stop = button(root, ".controls .stop");
    expect(stop.nextElementSibling?.classList.contains("fake-stop-all")).toBe(
      true,
    );
    click(button(root, ".fake-stop-all"));
    expect(calls.join(",")).toBe("stop-all");
  });
});

describe("files", () => {
  test("the hidden picker is out of the Tab order; the `+` is the way to it", async () => {
    const { root } = await shell({ attachable: true });
    const picker = root.querySelector('input[type="file"]');
    expect(picker?.getAttribute("tabindex")).toBe("-1");
    expect(button(root, ".icon-btn").getAttribute("tabindex")).toBeNull();
  });

  test("after a refused file's dialog closes, focus is back on the `+`", async () => {
    const { root, attach } = await shell({ attachable: true });
    const plus = button(root, ".icon-btn");
    plus.focus();
    await attach([new File([], "empty.txt")]);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("File not attached");
    expect(document.activeElement === plus).toBe(false);
    const close = [...document.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === "Close",
    );
    if (close === undefined) throw new Error("no Close");
    click(close);
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement === plus).toBe(true);
  });
});
