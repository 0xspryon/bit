/**
 * The floating composer: the log fills the space and runs under the box, its bottom padding
 * the box's resting height; scrolled up, "↓ Latest" brings the newest message back with
 * focus in the box; a docked question hides the heading and footnote it covers.
 *
 * happy-dom does no layout, so the log is given geometry by hand, as `chatFollow.test.ts`
 * does, and the box's height is stubbed. The component CSS is compiled and applied where a
 * rule is what is asserted. Strings, numbers and booleans only, never `toEqual` on a node.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";

import type { LiveItem } from "@bit/contracts";

import { settle } from "./dom";

const { default: FloatingChat } =
  await import("./fixtures/FloatingChat.svelte");
const { default: FakeChatShell } =
  await import("./fixtures/FakeChatShell.svelte");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const each of cleanups) each();
  cleanups = [];
});

const reply = (n: number): LiveItem => ({
  _tag: "item",
  id: `activity:${String(n)}`,
  origin: "activity",
  sequence: null,
  at: 1_793_000_000_000 + n,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_1",
  kind: "turn.reply",
  headline: "Reply",
  body: `Reply ${String(n)}`,
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
});

/** The box reports `height` as its `clientHeight` until the test ends. */
const composerHeight = (height: number): void => {
  const real = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("floating-composer")
        ? height
        : (real?.get?.call(this) ?? 0);
    },
  });
  cleanups.push(() => {
    if (real !== undefined)
      Object.defineProperty(HTMLElement.prototype, "clientHeight", real);
  });
};

/** `Chat`'s own CSS, compiled and applied: the DOM suite injects none. */
const applyChatCss = async (): Promise<void> => {
  const path = new URL("../../src/lib/components/Chat.svelte", import.meta.url)
    .pathname;
  const { css } = compile(await Bun.file(path).text(), {
    filename: path,
    generate: "client",
    css: "external",
    dev: true,
  });
  const sheet = document.createElement("style");
  sheet.textContent = css?.code ?? "";
  document.head.append(sheet);
  cleanups.push(() => sheet.remove());
};

const floating = (layout: "panel" | "thread" = "panel", docked = false) => {
  const target = document.body.appendChild(document.createElement("div"));
  const chat = mount(FloatingChat, { target, props: { layout, docked } });
  cleanups.push(() => {
    void unmount(chat);
    target.remove();
  });
  flushSync();
  const box = target.querySelector("ol.groups");
  if (!(box instanceof HTMLElement)) throw new Error("no scroll box");
  const geometry = { content: 1_000, top: 0 };
  const client = 400;
  Object.defineProperty(box, "scrollHeight", { get: () => geometry.content });
  Object.defineProperty(box, "clientHeight", { get: () => client });
  Object.defineProperty(box, "scrollTop", {
    get: () => geometry.top,
    set: (value: number) => {
      geometry.top = Math.max(0, Math.min(value, geometry.content - client));
    },
  });
  const short = () => geometry.content - geometry.top - client;
  const stage = target.querySelector(".floating-stage");
  if (!(stage instanceof HTMLElement)) throw new Error("no stage");
  return { chat, target, box, geometry, short, stage };
};

describe("the floating composer", () => {
  test("the composer sits over the log, inside its stage, and a panel's footnote above it", () => {
    const { target, stage } = floating();
    expect(stage.querySelector("ol.groups") !== null).toBe(true);
    expect(stage.querySelector(".floating-composer.afloat #box") !== null).toBe(
      true,
    );
    // The footnote is before the log, not under the floating box.
    const order = [...(target.querySelector("section.chat")?.children ?? [])]
      .map((child) => child.className.split(" ")[0])
      .join(",");
    expect(order.indexOf("footnote")).toBeGreaterThan(-1);
    expect(order.indexOf("footnote")).toBeLessThan(order.indexOf("stage"));
  });

  test("a thread keeps its footnote under the box, on the floating surface", () => {
    const { stage } = floating("thread");
    expect(
      stage
        .querySelector(".floating-composer.afloat .footnote")
        ?.textContent?.trim(),
    ).toBe("footnote");
  });

  test("the log's bottom padding is the box's resting height", async () => {
    composerHeight(120);
    await applyChatCss();
    const { box, stage } = floating("thread");
    flushSync();
    expect(stage.style.getPropertyValue("--rest")).toBe("120px");
    expect(getComputedStyle(box).paddingBottom).toBe("calc(120px + 12px)");
  });

  test("a box that is not at rest is not taken as the padding", () => {
    composerHeight(300);
    const { stage } = floating("panel", true);
    expect(stage.style.getPropertyValue("--rest")).toBe("0px");
  });

  test("scrolled up, a new message leaves the view where it is and ↓ Latest brings it back", () => {
    const { chat, target, box, geometry, short } = floating("thread");
    chat.write([reply(1)]);
    flushSync();
    expect(short()).toBe(0);
    expect(target.querySelector("button.latest")).toBeNull();

    // The reader scrolls up: the view is theirs.
    box.scrollTop = geometry.top - 300;
    box.dispatchEvent(new Event("scroll"));
    flushSync();
    expect(target.querySelector("button.latest")?.textContent?.trim()).toBe(
      "↓ Latest",
    );
    geometry.content += 200;
    chat.write([reply(1), reply(2)]);
    flushSync();
    expect(short()).toBe(500);

    // ↓ Latest: to the newest message, following again, with focus in the box.
    (target.querySelector("button.latest") as HTMLButtonElement).click();
    flushSync();
    expect(short()).toBe(0);
    expect(document.activeElement?.id).toBe("box");
    expect(target.querySelector("button.latest")).toBeNull();
    geometry.content += 100;
    chat.write([reply(1), reply(2), reply(3)]);
    flushSync();
    expect(short()).toBe(0);
  });

  test("the dock opening in the composer's place does not move the log", () => {
    const { chat, box, geometry, stage } = floating("thread");
    chat.write([reply(1), reply(2)]);
    flushSync();
    box.scrollTop = 250;
    box.dispatchEvent(new Event("scroll"));
    const before = box.scrollTop;
    const padding = stage.style.getPropertyValue("--rest");
    chat.setDock(true);
    flushSync();
    expect(
      stage.querySelector(".floating-composer.grown .question-dock") !== null,
    ).toBe(true);
    expect(geometry.top).toBe(before);
    expect(stage.style.getPropertyValue("--rest")).toBe(padding);
  });
});

describe("a docked question over the log", () => {
  test("hides the heading and footnote it covers, and ↓ Latest", async () => {
    await applyChatCss();
    const { chat, target, box, geometry } = floating();
    chat.write([reply(1), reply(2)]);
    flushSync();
    box.scrollTop = geometry.top - 300;
    box.dispatchEvent(new Event("scroll"));
    flushSync();
    expect(target.querySelector("button.latest") !== null).toBe(true);
    const section = target.querySelector("section.chat");
    const head = target.querySelector("section.chat > .head");
    const footnote = target.querySelector("section.chat > .footnote");
    if (head === null || footnote === null) throw new Error("no heading");
    expect(section?.classList.contains("docked")).toBe(false);
    expect(getComputedStyle(head).visibility).not.toBe("hidden");

    chat.setDock(true);
    flushSync();
    expect(section?.classList.contains("docked")).toBe(true);
    expect(getComputedStyle(head).visibility).toBe("hidden");
    expect(getComputedStyle(footnote).visibility).toBe("hidden");
    // Hidden, not removed: still laid out, so the dock's reach is unchanged.
    expect(head.isConnected && footnote.isConnected).toBe(true);
    expect(target.querySelector("button.latest")).toBeNull();

    chat.setDock(false);
    flushSync();
    expect(section?.classList.contains("docked")).toBe(false);
    expect(getComputedStyle(head).visibility).not.toBe("hidden");
    expect(target.querySelector("button.latest") !== null).toBe(true);
  });
});

describe("the chat shell, floating", () => {
  const shell = async (asking = false) => {
    const root = document.body.appendChild(document.createElement("div"));
    const chat = mount(FakeChatShell, {
      target: root,
      props: { calls: [], floating: true, asking, items: [reply(1)] },
    });
    cleanups.push(() => {
      void unmount(chat);
      root.remove();
    });
    flushSync();
    await settle();
    return { root, chat };
  };

  test("the box, its notices and Stop float over the thread, the footnote under them", async () => {
    const { root } = await shell();
    const afloat = root.querySelector(
      ".chat.thread.floating .floating-stage > .floating-composer.afloat",
    );
    expect(afloat?.querySelector("textarea#fake-message") !== null).toBe(true);
    expect(afloat?.querySelector(".notice")?.textContent?.trim()).toBe(
      "The last message was delivered.",
    );
    expect(afloat?.lastElementChild?.className.includes("footnote")).toBe(true);
    expect(root.querySelector(".chat")?.classList.contains("docked")).toBe(
      false,
    );
  });

  test("a question docks inside the floating box, which is then not at rest", async () => {
    const { root } = await shell(true);
    const afloat = root.querySelector(".floating-composer.afloat.grown");
    expect(afloat?.querySelector("section.question-dock") !== null).toBe(true);
    expect(root.querySelector("textarea#fake-message")).toBeNull();
    expect(root.querySelector(".chat")?.classList.contains("docked")).toBe(
      true,
    );
  });
});
