/**
 * A thread follows its newest words while the reader is at the bottom (A6 U5 review).
 *
 * happy-dom does no layout, so the scroll container is given geometry by hand: a content
 * height a test sets, a 400 px box, and a `scrollTop` clamped as a browser clamps it. A
 * `ResizeObserver` stand-in is installed before mounting so a test can say "this turn grew"
 * the way a figure finishing its layout does. Compared as numbers and strings, never with
 * `toEqual` on a node.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { flushSync, mount, unmount } from "svelte";

import type { LiveItem } from "@bit/contracts";

import { withBlock } from "../../src/lib/chat";

const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly watched = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(node: Element): void {
    this.watched.add(node);
  }
  unobserve(node: Element): void {
    this.watched.delete(node);
  }
  disconnect(): void {
    this.watched.clear();
  }
  /** What the browser does when a watched turn changes size. */
  fire(): void {
    if (this.watched.size === 0) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}
// Installed for this file only: `Chat` makes its observer when it mounts.
const realObserver = globalThis.ResizeObserver;
beforeAll(() => {
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
});
afterAll(() => {
  globalThis.ResizeObserver = realObserver;
});

const { default: FollowingChat } =
  await import("./fixtures/FollowingChat.svelte");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const each of cleanups) each();
  cleanups = [];
  observers.length = 0;
});

const reply = (id: string, body: string, streaming: boolean): LiveItem => ({
  _tag: "item",
  id,
  origin: "activity",
  sequence: null,
  at: 1_793_000_000_000,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_1",
  kind: "turn.reply",
  headline: "Reply",
  body,
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
  blockId: "ses:msg_1:0",
  blockCall: "ses:msg_1",
  ...(streaming ? { streaming: true as const } : {}),
});

/** The thread, with a scroll box whose content height the test controls. */
const thread = () => {
  const target = document.body.appendChild(document.createElement("div"));
  const chat = mount(FollowingChat, { target });
  cleanups.push(() => {
    void unmount(chat);
    target.remove();
  });
  flushSync();
  const box = target.querySelector("ol.groups");
  if (!(box instanceof HTMLElement)) throw new Error("no scroll box");
  const geometry = { content: 1_000, top: 0 };
  const client = 400;
  Object.defineProperty(box, "scrollHeight", {
    get: () => geometry.content,
  });
  Object.defineProperty(box, "clientHeight", { get: () => client });
  Object.defineProperty(box, "scrollTop", {
    get: () => geometry.top,
    set: (value: number) => {
      geometry.top = Math.max(0, Math.min(value, geometry.content - client));
    },
  });
  /** How far the view is from the bottom, in px. */
  const short = () => geometry.content - geometry.top - client;
  return { chat, box, geometry, short };
};

describe("A6 U5 review: following a reply while pinned", () => {
  test("a scroll event the follow caused, read after a figure grew the page, does not unpin", () => {
    const { chat, box, geometry, short } = thread();
    let feed: readonly LiveItem[] = [];
    const send = (item: LiveItem) => {
      feed = withBlock(feed, item) ?? [...feed, item];
      chat.write(feed);
      flushSync();
    };
    send(reply("activity:1", "Here is the flow:", true));
    expect(short()).toBe(0);
    // The follow put the view at the bottom; then a mermaid figure drew 476 px more before
    // the scroll event that follow caused arrived.
    geometry.content += 476;
    box.dispatchEvent(new Event("scroll"));
    // The next words still bring the view with them.
    geometry.content += 40;
    send(reply("activity:2", "Here is the flow:\n\nand then the end.", true));
    expect(short()).toBe(0);
  });

  test("a pinned view catches up when a turn grows with no new words, and not once the reader scrolled up", () => {
    const { chat, box, geometry, short } = thread();
    chat.write([reply("activity:1", "A figure follows.", false)]);
    flushSync();
    expect(short()).toBe(0);
    const watcher = observers.at(-1);
    expect(watcher?.watched.size).toBe(1);
    // The figure lays out: the turn is taller, and nothing else changed.
    geometry.content += 300;
    watcher?.fire();
    expect(short()).toBe(0);
    // The reader scrolls up: that event is theirs, and the view stops following.
    box.scrollTop = geometry.top - 200;
    box.dispatchEvent(new Event("scroll"));
    geometry.content += 300;
    watcher?.fire();
    expect(short()).toBe(500);
  });
});

describe("A6 U9 review 2: a scroll after the thread is torn down", () => {
  test("a scroll event that reaches the list after unmount reads nothing it no longer holds", () => {
    const target = document.body.appendChild(document.createElement("div"));
    const chat = mount(FollowingChat, { target });
    flushSync();
    const box = target.querySelector("ol.groups");
    if (!(box instanceof HTMLElement)) throw new Error("no scroll box");
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(String(event.message));
    window.addEventListener("error", onError);
    const realError = console.error;
    console.error = (...args: unknown[]) =>
      errors.push(args.map(String).join(" "));
    try {
      // `bind:this` clears the list on teardown, and Svelte leaves a plain element's
      // listener attached: a scroll queued before the teardown still runs the handler.
      void unmount(chat);
      flushSync();
      box.dispatchEvent(new Event("scroll"));
    } catch (thrown) {
      errors.push(String(thrown));
    } finally {
      window.removeEventListener("error", onError);
      console.error = realError;
      target.remove();
    }
    expect(errors.join("\n")).toBe("");
  });
});
