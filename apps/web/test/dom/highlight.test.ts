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
  createWorkerTokenise,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  weightOf,
  WORKER_TIMING,
  type HighlightWorker,
  type Highlights,
  type ToneLines,
  type Tokenise,
  type WorkerAnswer,
  type WorkerRequest,
} from "../../src/lib/highlight";
import {
  TOKENIZE_BLOCK_BUDGET_MS,
  TOKENIZE_TIME_LIMIT_MS,
} from "../../src/lib/highlightEngine";
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

/*
 * The page's side of the worker, against a stand-in worker the test answers by hand: one
 * block at a time, a deadline that fails only the block that ran over, and a crash or a
 * load failure that costs no other fence its tones.
 */
describe("the worker the page talks to", () => {
  /** A stand-in worker: what it was sent, and a way to answer as the real one would. */
  class StandInWorker implements HighlightWorker {
    onmessage: ((event: MessageEvent<WorkerAnswer>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly sent: WorkerRequest[] = [];
    terminated = false;
    constructor(
      private readonly behave: (
        request: WorkerRequest,
        self: StandInWorker,
      ) => void,
    ) {}
    postMessage = (message: WorkerRequest): void => {
      this.sent.push(message);
      this.behave(message, this);
    };
    terminate = (): void => {
      this.terminated = true;
    };
    answer = (data: WorkerAnswer): void => {
      this.onmessage?.(new MessageEvent("message", { data }));
    };
    crash = (): void => {
      this.onerror?.(new ErrorEvent("error"));
    };
  }

  const tonesOf = (code: string): ToneLines => [[{ text: code, tone: "key" }]];
  /** Started, then answered with tones, on the next turn. */
  const answers = (request: WorkerRequest, self: StandInWorker): void => {
    setTimeout(() => {
      self.answer({ id: request.id, started: true });
      self.answer({ id: request.id, lines: tonesOf(request.code) });
    }, 0);
  };
  const FAST = { loadMs: 40, blockMs: 40 };

  /** Each promise's outcome: its first run's text, or `plain` for a rejection. */
  const outcome = (pending: Promise<ToneLines>): Promise<string> =>
    pending.then(
      (lines) => lines[0]?.[0]?.text ?? "",
      () => "plain",
    );

  test("the page waits longer than the worker's own budget and a line past it", () => {
    expect(WORKER_TIMING.blockMs).toBeGreaterThan(
      TOKENIZE_BLOCK_BUDGET_MS + TOKENIZE_TIME_LIMIT_MS,
    );
  });

  test("blocks are sent one at a time, each after the one before has answered", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(() => {
      const made = new StandInWorker(answers);
      workers.push(made);
      return made;
    }, FAST);
    const first = outcome(tokenise("a", "json"));
    const second = outcome(tokenise("b", "json"));
    expect(workers[0]?.sent.map((each) => each.code)).toEqual(["a"]);
    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.sent.map((each) => each.code)).toEqual(["a", "b"]);
  });

  test("a block past its deadline is plain, alone; the worker is replaced and the rest go on", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(() => {
      const made = new StandInWorker((request, self) => {
        // The hostile block starts and never answers; the others answer at once.
        if (request.code === "hostile") {
          setTimeout(() => self.answer({ id: request.id, started: true }), 0);
          return;
        }
        answers(request, self);
      });
      workers.push(made);
      return made;
    }, FAST);
    const results = Promise.all(
      ["hostile", "d8", "other"].map((code) =>
        outcome(tokenise(code, "javascript")),
      ),
    );
    expect(await results).toEqual(["plain", "d8", "other"]);
    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminated).toBe(true);
    // The waiting blocks were never sent to the stalled worker; each went once, to the new.
    expect(workers[0]?.sent.map((each) => each.code)).toEqual(["hostile"]);
    expect(workers[1]?.sent.map((each) => each.code)).toEqual(["d8", "other"]);
  });

  test("a worker that reports a block over budget leaves that block plain and is kept", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(() => {
      const made = new StandInWorker((request, self) => {
        if (request.code !== "hostile") return answers(request, self);
        setTimeout(() => {
          self.answer({ id: request.id, started: true });
          self.answer({ id: request.id, failed: "too long", retry: false });
        }, 0);
      });
      workers.push(made);
      return made;
    }, FAST);
    const results = Promise.all(
      ["hostile", "d8"].map((code) => outcome(tokenise(code, "javascript"))),
    );
    expect(await results).toEqual(["plain", "d8"]);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.sent.map((each) => each.code)).toEqual([
      "hostile",
      "d8",
    ]);
  });

  test("a crash costs no block its tones: the one in flight is sent once more, the rest wait", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(() => {
      const made = new StandInWorker((request, self) => {
        // The first worker dies on its first block; the next one works.
        if (workers.length === 1) setTimeout(() => self.crash(), 0);
        else answers(request, self);
      });
      workers.push(made);
      return made;
    }, FAST);
    const results = Promise.all(
      ["a", "b", "c"].map((code) => outcome(tokenise(code, "json"))),
    );
    expect(await results).toEqual(["a", "b", "c"]);
    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminated).toBe(true);
    expect(workers[1]?.sent.map((each) => each.code)).toEqual(["a", "b", "c"]);
  });

  test("a load that fails is tried once on a fresh worker; failing twice, that block alone is plain", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(() => {
      const made = new StandInWorker((request, self) => {
        if (request.code === "broken") {
          setTimeout(
            () =>
              self.answer({
                id: request.id,
                failed: "fetch failed",
                retry: true,
              }),
            0,
          );
          return;
        }
        answers(request, self);
      });
      workers.push(made);
      return made;
    }, FAST);
    const results = Promise.all(
      ["broken", "b"].map((code) => outcome(tokenise(code, "json"))),
    );
    expect(await results).toEqual(["plain", "b"]);
    expect(workers).toHaveLength(2);
    expect(workers.map((each) => each.sent.map((sent) => sent.code))).toEqual([
      ["broken"],
      ["broken", "b"],
    ]);
  });

  test("a load that never finishes is given up on its own deadline and tried once more", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(() => {
      const made = new StandInWorker((request, self) => {
        if (workers.length > 1) answers(request, self);
      });
      workers.push(made);
      return made;
    }, FAST);
    expect(await outcome(tokenise("a", "json"))).toBe("a");
    expect(workers).toHaveLength(2);
  });

  test("an answer from a worker already replaced is not taken for the new one's", async () => {
    const workers: StandInWorker[] = [];
    const tokenise = createWorkerTokenise(
      () => {
        const made = new StandInWorker((request, self) => {
          if (workers.length === 1) {
            setTimeout(() => self.answer({ id: request.id, started: true }), 0);
            // After the deadline, the old worker answers the new one's id with wrong tones.
            setTimeout(
              () =>
                self.answer({ id: request.id + 1, lines: tonesOf("stale") }),
              60,
            );
            return;
          }
          setTimeout(() => answers(request, self), 60);
        });
        workers.push(made);
        return made;
      },
      { loadMs: 400, blockMs: 40 },
    );
    const results = Promise.all(
      ["slow", "next"].map((code) => outcome(tokenise(code, "json"))),
    );
    expect(await results).toEqual(["plain", "next"]);
  });

  test("with the cache in front, a crash leaves the waiting fences highlighted, not plain", async () => {
    let made = 0;
    const highlights = createHighlights(
      createWorkerTokenise(() => {
        made += 1;
        const first = made === 1;
        return new StandInWorker((request, self) => {
          if (first) setTimeout(() => self.crash(), 0);
          else answers(request, self);
        });
      }, FAST),
    );
    await Promise.all(
      ["x", "y", "z"].map((code) => highlights.request(code, "json")),
    );
    expect(
      ["x", "y", "z"].map(
        (code) => highlights.peek(code, "json")?.[0]?.[0]?.text,
      ),
    ).toEqual(["x", "y", "z"]);
  });
});

describe("the tones kept", () => {
  test("are weighed by their runs, so dense blocks cannot hold the page's memory", async () => {
    // A dense block: a run every character, alternating tones, as minified code gives.
    const dense = (seed: number): { code: string; lines: ToneLines } => {
      const text = `${String(seed)}:${"ab".repeat(20_000)}`;
      const runs = [...text].map((char, index) => ({
        text: char,
        tone: index % 2 === 0 ? ("key" as const) : ("plain" as const),
      }));
      return { code: text, lines: [runs] };
    };
    const blocks = Array.from({ length: 40 }, (_, index) => dense(index));
    const byCode = new Map(blocks.map((block) => [block.code, block.lines]));
    const highlights = createHighlights(async (code) => byCode.get(code) ?? []);
    for (const block of blocks)
      await highlights.request(block.code, "javascript");

    const kept = blocks.filter(
      (block) => highlights.peek(block.code, "javascript") !== undefined,
    );
    const weight = kept.reduce(
      (sum, block) => sum + weightOf(`javascript\n${block.code}`, block.lines),
      0,
    );
    const heaviest = weightOf(
      `javascript\n${blocks[0]?.code ?? ""}`,
      blocks[0]?.lines ?? null,
    );
    // A run is an object as well as its text: weighed as such, one block is about 2.6 MB,
    // so the cache keeps a block or two of these rather than all forty (~100 MB).
    expect(heaviest).toBeGreaterThan(40_000 * 64);
    expect(weight).toBeLessThanOrEqual(4_000_000 + heaviest);
    expect(highlights.bytes()).toBeLessThanOrEqual(4_000_000 + heaviest);
    expect(kept.length).toBeLessThan(4);
    // The newest is kept even alone, or it would be tokenised again on every render.
    expect(
      highlights.peek(blocks.at(-1)?.code ?? "", "javascript"),
    ).toBeDefined();
  });
});
