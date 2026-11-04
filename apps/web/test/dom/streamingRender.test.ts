/**
 * What a block being written costs to draw (A6 U5), and how its reasoning line moves.
 *
 * Partials arrive about every 50 ms and each rebuilds every row of the thread, so the claim
 * is that only the block that changed is parsed as markdown again: an unchanged reply above
 * it is a string comparison. `renderMarkdown` is wrapped — counting, and otherwise the real
 * one — so the count is the parses the page actually does. Compared as strings and by `===`
 * on elements, never with `toEqual` on a node.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";

import type { LiveItem } from "@bit/contracts";

import * as markdown from "../../src/lib/markdown";

const real = markdown.renderMarkdown;
const parsed: string[] = [];
void mock.module("../../src/lib/markdown", () => ({
  ...markdown,
  renderMarkdown: (text: string) => {
    parsed.push(text);
    return real(text);
  },
}));

const { default: StreamingRows } =
  await import("./fixtures/StreamingRows.svelte");
const { withBlock } = await import("../../src/lib/chat");
const { default: LiveTranscript } =
  await import("../../src/lib/components/LiveTranscript.svelte");
const { App } = await import("../../src/lib/app.svelte");
const { FakeServer } = await import("../fakeServer");
const { FakeCountdown } = await import("../fakeCountdown");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const each of cleanups) each();
  cleanups = [];
});

const block = (
  id: string,
  blockId: string,
  body: string,
  over: Partial<LiveItem> = {},
): LiveItem => ({
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
  blockId,
  ...over,
});

const rows = () => {
  const target = document.body.appendChild(document.createElement("div"));
  const live = mount(StreamingRows, { target });
  cleanups.push(() => {
    void unmount(live);
    target.remove();
  });
  return { target, live };
};

describe("A6 U5: drawing a block being written", () => {
  test("each partial parses only the block that changed, not the finished reply above it", () => {
    const { target, live } = rows();
    const done = block("activity:1", "ses:msg_a:0", "Earlier, **finished**.");
    let feed: readonly LiveItem[] = [done];
    live.write(feed);
    flushSync();
    parsed.length = 0;
    let text = "Now";
    for (const [n, delta] of [
      " reading",
      " the",
      " policy",
      " page.",
    ].entries()) {
      text += delta;
      feed =
        withBlock(
          feed,
          block(`activity:${String(10 + n)}`, "ses:msg_b:0", text, {
            streaming: true,
          }),
        ) ?? feed;
      live.write(feed);
      flushSync();
    }
    // One parse per partial, of the partial's own text, and none of the finished reply.
    expect(parsed).toEqual([
      "Now reading",
      "Now reading the",
      "Now reading the policy",
      "Now reading the policy page.",
    ]);
    expect(target.querySelectorAll("li.prose")).toHaveLength(2);
    expect(target.textContent).toContain("Now reading the policy page.");
  });

  test("an unclosed fence in a partial is plain code, and closing it draws the same row", () => {
    const { target, live } = rows();
    let feed: readonly LiveItem[] = [];
    const send = (id: string, body: string, streaming: boolean) => {
      feed =
        withBlock(
          feed,
          block(id, "ses:msg_c:0", body, streaming ? { streaming: true } : {}),
        ) ?? feed;
      live.write(feed);
      flushSync();
    };
    send("activity:1", "Run:\n\n```js\nconst a = 1;", true);
    const row = target.querySelector("li.prose");
    expect(target.querySelector("pre > code")?.textContent).toContain(
      "const a = 1;",
    );
    // Open, it is not marked for highlighting: nothing is tokenised mid-fence.
    expect(target.querySelector(".code-frame[data-highlight]")).toBeNull();
    send("activity:3", "Run:\n\n```js\nconst a = 1;\n```\n\nDone.", false);
    expect(target.querySelector("li.prose") === row).toBe(true);
    expect(target.querySelector(".code-frame[data-highlight]")).not.toBeNull();
    expect(target.querySelector(".writing")).toBeNull();
  });

  test("the reasoning line's shimmer stops under reduced motion", async () => {
    const path = new URL(
      "../../src/lib/components/ChatItem.svelte",
      import.meta.url,
    ).pathname;
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
    });
    const code = (css?.code ?? "").replace(/\s+/g, " ");
    // Moving by default…
    expect(code).toMatch(
      /\.gist\.shimmer:where\(\.svelte-[a-z0-9]+\) \{[^}]*animation: svelte-[a-z0-9]+-shimmer 2\.6s linear infinite/,
    );
    // …and still, with the plain muted line, under `prefers-reduced-motion: reduce`.
    const reduced = code.match(
      /@media \(prefers-reduced-motion: reduce\) \{ \.reasoning\.svelte-[a-z0-9]+ \.gist\.shimmer:where\(\.svelte-[a-z0-9]+\) \{([^}]*)\}/,
    );
    expect(reduced?.[1]).toContain("animation: none");
    expect(reduced?.[1]).toContain("background-image: none");
  });

  test("the Live panel says a GLM thought is written once the reply of its message starts, as the chat does", () => {
    const app = new App(new FakeServer(), new FakeCountdown());
    app.viewTargetId = "acme-corp";
    app.liveTargetId = "acme-corp";
    app.liveExpanded = true;
    app.liveItems = [
      block("activity:1", "ses:msg_1:reasoning:0", "Weighing it", {
        kind: "turn.thinking",
        headline: "Thinking",
        streaming: true,
      }),
      block("activity:2", "ses:msg_1:text:0", "The answer", {
        streaming: true,
      }),
    ];
    const target = document.body.appendChild(document.createElement("div"));
    const panel = mount(LiveTranscript, { target, props: { app } });
    cleanups.push(() => {
      void unmount(panel);
      target.remove();
    });
    flushSync();
    expect(
      [...target.querySelectorAll(".items > li")].map(
        (row) =>
          `${row.querySelector(".kind")?.textContent ?? ""}: ${row.querySelector(".chip.stream")?.textContent?.trim() ?? ""}`,
      ),
    ).toEqual(["Thinking: written", "Reply: writing…"]);
  });
});
