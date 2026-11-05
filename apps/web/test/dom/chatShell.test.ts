/**
 * The shared chat shell, driven by a fake adapter (A6 prep for the goal, planner and worker
 * chats): what each capability draws, and what its absence does not.
 *
 * The importer's own suites (`importer.test.ts` and its neighbours) are the proof the shell
 * draws the importer as before; this file is the proof it draws a chat that is not the
 * importer — a closed composer with Stop still working, no Send now where the server cannot
 * steer, the dock over a closed box, and a sub-agent's row handed to the chat's card.
 * Compared as strings and booleans, never with `toEqual` on a node.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";

import type { LiveItem } from "@bit/contracts";

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
  readonly cards?: boolean;
  readonly since?: number;
  readonly items?: readonly LiveItem[];
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
  }): Promise<void> => {
    chat.set(next);
    await settle();
  };
  return { calls, root, set };
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

describe("the hosting points for A7", () => {
  test("A7-Q's dock is drawn above a closed composer", async () => {
    const { root } = await shell({
      closed: "The prompt is the intent's question.",
      dock: true,
    });
    const dock = root.querySelector(".stack > .dock");
    const box = root.querySelector(".stack > .box");
    expect(dock?.textContent?.trim()).toBe("Which host first?");
    expect(box).not.toBeNull();
    // Above it: the dock comes first in the composer's column.
    expect(
      dock !== null &&
        box !== null &&
        (dock.compareDocumentPosition(box) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
  });

  test("a chat with no dock snippet draws no dock region", async () => {
    const { root } = await shell({});
    expect(root.querySelector(".dock")).toBeNull();
  });

  test("A7-S's card hook draws a sub-agent's folded row, and its header chip", async () => {
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
    expect(root.querySelector(".header-region .fake-chip")?.textContent).toBe(
      "1 sub-agent",
    );
  });

  test("without the hook a sub-agent is U14's entry, as before", async () => {
    const { root } = await shell({ items: [subagent("finished")] });
    expect(root.querySelector("li.subagent-card")).toBeNull();
    expect(root.querySelector("li.block.subagent")).not.toBeNull();
    expect(root.querySelector(".header-region")).toBeNull();
  });
});
