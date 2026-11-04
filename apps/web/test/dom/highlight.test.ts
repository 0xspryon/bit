/**
 * A fence, highlighted (A6 U11), against a stand-in tokeniser: what is asked for, and what
 * the returned tones become in the page. Shiki itself is exercised in
 * `test/highlightEngine.test.ts`, without a DOM.
 *
 * Compared as strings — `textContent`, `outerHTML`, class lists — never as nodes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";

import Markdown from "../../src/lib/components/Markdown.svelte";
import {
  createHighlights,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  type Highlights,
  type ToneLines,
  type Tokenise,
} from "../../src/lib/highlight";
import type { Grammar } from "../../src/lib/highlightLanguages";

import { click, mountInto, settle, type Mounted } from "./dom";
import GrowingReply from "./fixtures/GrowingReply.svelte";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

/** A tokeniser that records each call and answers with `answer`'s lines. */
const standIn = (
  answer: (code: string, grammar: Grammar) => ToneLines | Promise<ToneLines>,
): { highlights: Highlights; calls: { code: string; grammar: Grammar }[] } => {
  const calls: { code: string; grammar: Grammar }[] = [];
  const tokenise: Tokenise = async (code, grammar) => {
    calls.push({ code, grammar });
    return answer(code, grammar);
  };
  return { highlights: createHighlights(tokenise), calls };
};

/** D8's `js` sample, toned as Shiki tones it (`highlightEngine.test.ts` pins that). */
const JS = "var=expres() + yield * expres2()";
const JS_TONES: ToneLines = [
  [
    { text: "var", tone: "key" },
    { text: "=", tone: "plain" },
    { text: "expres", tone: "value" },
    { text: "() + ", tone: "plain" },
    { text: "yield", tone: "key" },
    { text: " * ", tone: "plain" },
    { text: "expres2", tone: "value" },
    { text: "()", tone: "plain" },
  ],
];

const reply = (text: string, highlights?: Highlights): HTMLElement => {
  const one = mountInto(Markdown, {
    text,
    ...(highlights ? { highlights } : {}),
  });
  mounted.push(one);
  return one.target;
};

/** The code's children as `tone:text` pieces, plain text as `:text`. */
const pieces = (code: Element | null): string[] =>
  [...(code?.childNodes ?? [])].map((node) =>
    node instanceof Element
      ? `${node.className}:${node.textContent ?? ""}`
      : `:${node.textContent ?? ""}`,
  );

/** Until the stand-in's answer has been built into the page. */
const toned = async (root: HTMLElement): Promise<void> => {
  for (let tries = 0; tries < 20; tries += 1) {
    await settle();
    if (root.querySelector("code.toned") !== null) return;
  }
};

const withClipboard = async (run: (copied: string[]) => Promise<void>) => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  try {
    await run(copied);
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(navigator, "clipboard");
    } else {
      Object.defineProperty(navigator, "clipboard", original);
    }
  }
};

describe("a highlighted fence", () => {
  test("is its tones as spans with constant classes, in the code's own frame", async () => {
    const stand = standIn(() => JS_TONES);
    const root = reply(
      `Fenced:\n\n\`\`\`js\n${JS}\n\`\`\`\n`,
      stand.highlights,
    );
    await toned(root);
    expect(stand.calls).toEqual([{ code: JS, grammar: "javascript" }]);
    const code = root.querySelector("pre > code");
    expect(code?.className).toBe("language-js toned");
    expect(pieces(code)).toEqual([
      "tone-key:var",
      ":=",
      "tone-value:expres",
      ":() + ",
      "tone-key:yield",
      ": * ",
      "tone-value:expres2",
      ":()",
      ":\n",
    ]);
    expect(code?.textContent).toBe(`${JS}\n`);
    expect(
      root.querySelector(".code-frame")?.getAttribute("data-highlight"),
    ).toBe("javascript");
  });

  test("names its grammar by bit's own name, whatever the fence called it", () => {
    const stand = standIn(() => [[]]);
    const root = reply(
      "```JSON\n{}\n```\n\n```sh\nls\n```\n\n```patch\n-a\n```\n",
      stand.highlights,
    );
    expect(
      [...root.querySelectorAll(".code-frame")].map((frame) =>
        frame.getAttribute("data-highlight"),
      ),
    ).toEqual(["json", "shellscript", "diff"]);
  });

  test("an unknown language, a bare fence and a mermaid fence are not asked for", async () => {
    const stand = standIn(() => JS_TONES);
    const root = reply(
      "```cobol\nDISPLAY 'X'.\n```\n\n```\nplain\n```\n\n```constructor\nx\n```\n\n```__proto__\ny\n```\n",
      stand.highlights,
    );
    await settle();
    await settle();
    expect(stand.calls).toHaveLength(0);
    expect(root.querySelector("[data-highlight]")).toBeNull();
    expect(root.querySelector("code.toned")).toBeNull();
    expect(
      root.querySelector(".tone-key, .tone-value, .tone-comment"),
    ).toBeNull();
  });

  test("a fence cut mid-stream is plain and never tokenised", async () => {
    const stand = standIn(() => JS_TONES);
    const root = reply(`Fenced:\n\n\`\`\`js\n${JS}\n`, stand.highlights);
    await settle();
    await settle();
    expect(stand.calls).toHaveLength(0);
    expect(root.querySelector("[data-highlight]")).toBeNull();
    expect(root.querySelector("pre > code")?.textContent).toBe(`${JS}\n`);
  });

  test("is tokenised once as the reply grows, and keeps the same built code", async () => {
    const stand = standIn(() => JS_TONES);
    const target = document.body.appendChild(document.createElement("div"));
    const live = mount(GrowingReply, {
      target,
      props: { highlights: stand.highlights },
    });
    try {
      let text = `Fenced:\n\n\`\`\`js\n${JS}\n\`\`\`\n\nThen`;
      live.write(text);
      flushSync();
      await toned(target);
      const first = target.querySelector("pre > code");
      expect(first?.classList.contains("toned")).toBe(true);
      for (const delta of [" the", " request", " goes", " out.", "\n\nMore."]) {
        text += delta;
        live.write(text);
        flushSync();
        await settle();
        const now = target.querySelector("pre > code");
        // The same element, moved into each new frame: not built again.
        expect(now === first).toBe(true);
        expect(now?.classList.contains("toned")).toBe(true);
      }
      expect(stand.calls).toHaveLength(1);
      expect(target.querySelector(".markdown")?.textContent).toContain("More.");
    } finally {
      void unmount(live);
      target.remove();
    }
  });

  test("a fence that closes as the reply streams is tokenised once, when it closes", async () => {
    const stand = standIn(() => JS_TONES);
    const target = document.body.appendChild(document.createElement("div"));
    const live = mount(GrowingReply, {
      target,
      props: { highlights: stand.highlights },
    });
    try {
      let text = "Fenced:\n\n```js\n";
      for (const delta of ["var=", "expres() + ", "yield * expres2()", "\n"]) {
        text += delta;
        live.write(text);
        flushSync();
        await settle();
      }
      expect(stand.calls).toHaveLength(0);
      live.write(`${text}\`\`\``);
      flushSync();
      await toned(target);
      expect(stand.calls).toEqual([{ code: JS, grammar: "javascript" }]);
    } finally {
      void unmount(live);
      target.remove();
    }
  });

  test("two replies with the same fence share one tokenising", async () => {
    const stand = standIn(() => JS_TONES);
    const one = reply(`\`\`\`js\n${JS}\n\`\`\``, stand.highlights);
    await toned(one);
    const two = reply(
      `Again:\n\n\`\`\`javascript\n${JS}\n\`\`\``,
      stand.highlights,
    );
    // Known already, so built at once, with no wait.
    expect(two.querySelector("code.toned")).not.toBeNull();
    expect(stand.calls).toHaveLength(1);
  });
});

describe("a highlighted fence's text", () => {
  test("hostile code is text in a span, never markup", async () => {
    const hostile = `</span><script>alert(1)</script>"><img src=x onerror=alert(2)>`;
    const stand = standIn(() => [
      [
        { text: "</span><script>", tone: "key" },
        { text: "alert(1)", tone: "value" },
        { text: `</script>"><img src=x onerror=alert(2)>`, tone: "comment" },
      ],
    ]);
    const root = reply(`\`\`\`html\n${hostile}\n\`\`\``, stand.highlights);
    await toned(root);
    const code = root.querySelector("pre > code");
    expect(code?.classList.contains("toned")).toBe(true);
    expect(root.querySelector("script, img, [onerror]")).toBeNull();
    expect(code?.textContent).toBe(`${hostile}\n`);
    expect(
      [...(code?.querySelectorAll("*") ?? [])].map((each) => each.tagName),
    ).toEqual(["SPAN", "SPAN", "SPAN"]);
  });

  test("a tone the page does not know is plain text, not a class", async () => {
    const stand = standIn(
      () =>
        [
          [
            { text: "var", tone: 'key" onclick="alert(1)' },
            { text: " x", tone: "__proto__" },
          ],
        ] as unknown as ToneLines,
    );
    const root = reply("```js\nvar x\n```", stand.highlights);
    await toned(root);
    const code = root.querySelector("pre > code");
    expect(pieces(code)).toEqual([":var", ": x", ":\n"]);
    expect(code?.querySelector("[onclick]")).toBeNull();
  });

  test("tones that do not spell the code leave it plain", async () => {
    const stand = standIn(() => [
      [
        { text: "var", tone: "key" },
        { text: "=evil()", tone: "value" },
      ],
    ]);
    const root = reply(`\`\`\`js\n${JS}\n\`\`\``, stand.highlights);
    await settle();
    await settle();
    expect(stand.calls).toHaveLength(1);
    expect(root.querySelector("code.toned")).toBeNull();
    expect(root.querySelector("pre > code")?.textContent).toBe(`${JS}\n`);
  });

  test("tones with a line too many or too few leave it plain", async () => {
    const stand = standIn(() => [JS_TONES[0] ?? [], []]);
    const root = reply(`\`\`\`js\n${JS}\n\`\`\``, stand.highlights);
    await settle();
    await settle();
    expect(root.querySelector("code.toned")).toBeNull();
  });

  test("a hidden character inside a highlighted word is still its marker", async () => {
    const code = "co\u200Bnst \u202Eevil = 'ad\u{E0041}min'";
    const stand = standIn(() => [
      [
        { text: "co\u200Bnst", tone: "key" },
        { text: " ", tone: "plain" },
        { text: "\u202Eevil", tone: "value" },
        { text: " = ", tone: "plain" },
        // A tag character split across two runs, as no tokeniser should but one might.
        { text: "'ad\uDB40", tone: "value" },
        { text: "\uDC41min'", tone: "plain" },
      ],
    ]);
    const root = reply(`\`\`\`js\n${code}\n\`\`\``, stand.highlights);
    await toned(root);
    const built = root.querySelector("pre > code");
    expect(
      [...(built?.querySelectorAll(".char-escape") ?? [])].map(
        (mark) =>
          `${mark.parentElement?.className ?? ""}>${mark.textContent ?? ""}`,
      ),
    ).toEqual([
      "tone-key>⟨U+200B⟩",
      "tone-value>⟨U+202E⟩",
      // The split character is carried whole into the run after it, and marked there.
      "language-js toned>⟨U+E0041⟩",
    ]);
    expect(built?.textContent).not.toMatch(/\u200B|\u202E|\u{E0041}/u);
    expect(built?.textContent).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  test("Copy gives back the code as written, before and after it is highlighted", async () => {
    await withClipboard(async (copied) => {
      const code =
        "const host = '\u2067com\u200F.\u200Facme\u2069'; // ⟨U+202E⟩ literal\r\nx\u{E0041}";
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stand = standIn(async () => {
        await gate;
        return [
          [
            { text: "const", tone: "key" },
            { text: " host = ", tone: "plain" },
            { text: "'\u2067com\u200F.\u200Facme\u2069'", tone: "value" },
            { text: "; ", tone: "plain" },
            { text: "// ⟨U+202E⟩ literal", tone: "comment" },
          ],
          [{ text: "x\u{E0041}", tone: "value" }],
        ];
      });
      const root = reply(`\`\`\`ts\n${code}\n\`\`\``, stand.highlights);
      const copy = (): void => {
        const button =
          root.querySelector<HTMLButtonElement>("button.code-copy");
        if (button === null) throw new Error("no Copy button");
        click(button);
      };
      copy();
      await settle();
      expect(root.querySelector("code.toned")).toBeNull();
      release();
      await toned(root);
      expect(root.querySelector("code.toned")).not.toBeNull();
      // The agent's own "⟨U+202E⟩" stays text: only the four real characters are markers.
      expect(root.querySelectorAll("code .char-escape")).toHaveLength(5);
      copy();
      await settle();
      expect(copied).toEqual([code, code]);
    });
  });
});

describe("a fence drawn plain", () => {
  test("a block past the size limit is never tokenised", async () => {
    const stand = standIn(() => [[]]);
    const long = Array.from(
      { length: HIGHLIGHT_MAX_LINES + 1 },
      (_, i) => `x${i}`,
    ).join("\n");
    const wide = `var a = "${"x".repeat(HIGHLIGHT_MAX_CHARS)}"`;
    const root = reply(
      `\`\`\`js\n${long}\n\`\`\`\n\n\`\`\`js\n${wide}\n\`\`\``,
      stand.highlights,
    );
    await settle();
    await settle();
    expect(stand.calls).toHaveLength(0);
    expect(root.querySelectorAll("[data-highlight]")).toHaveLength(2);
    expect(root.querySelector("code.toned")).toBeNull();
  });

  test("a block that fails to tokenise is plain, and not asked for again", async () => {
    let calls = 0;
    const highlights = createHighlights(async () => {
      calls += 1;
      throw new Error("grammar would not load");
    });
    const target = document.body.appendChild(document.createElement("div"));
    const live = mount(GrowingReply, { target, props: { highlights } });
    try {
      let text = `\`\`\`json\n{}\n\`\`\`\n\nThen`;
      live.write(text);
      flushSync();
      for (const delta of [" one", " two", " three"]) {
        await settle();
        text += delta;
        live.write(text);
        flushSync();
      }
      await settle();
      expect(calls).toBe(1);
      expect(target.querySelector("code.toned")).toBeNull();
      expect(target.querySelector("pre > code")?.textContent).toBe("{}\n");
    } finally {
      void unmount(live);
      target.remove();
    }
  });

  test("the app's own highlighter cannot start here, so its fences stay plain", async () => {
    // `preload.ts` takes Bun's `Worker` away; the app's highlights fail to start, quietly.
    const root = reply('```json\n{"a": 1}\n```');
    for (let tries = 0; tries < 5; tries += 1) await settle();
    expect(root.querySelector("code.toned")).toBeNull();
    expect(root.querySelector("pre > code")?.textContent).toBe('{"a": 1}\n');
  });
});

describe("the tones' style", () => {
  test("is weight and the reply's own ink: no hue", async () => {
    const path = new URL(
      "../../src/lib/components/Markdown.svelte",
      import.meta.url,
    ).pathname;
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    const rules = (css?.code ?? "")
      .split("}")
      .filter((rule) => /tone-|code\.toned/.test(rule));
    expect(rules.length).toBe(4);
    for (const rule of rules) {
      for (const color of rule.match(/color:[^;]+/g) ?? []) {
        expect(color).toMatch(/^color: var\(--text-(base|muted|faint)\)$/);
      }
    }
    const sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);
    try {
      const stand = standIn(() => JS_TONES);
      const root = reply(`\`\`\`js\n${JS}\n\`\`\``, stand.highlights);
      await toned(root);
      const weight = (selector: string): string =>
        getComputedStyle(root.querySelector(selector) ?? root).fontWeight;
      expect(weight(".tone-key")).toBe("500");
      expect(weight(".tone-value")).not.toBe("500");
    } finally {
      sheet.remove();
    }
  });
});
