/**
 * Shiki on the Oniguruma engine, as the highlighter's worker runs it (A6 U11): the real
 * grammars and the tone theme, with no DOM. What the page makes of the tones is
 * `test/dom/highlight.test.ts`.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { INITIAL, type ITokenizeLineResult2 } from "@shikijs/core/textmate";

import {
  tokenise,
  tokeniseLine,
  TOKENIZE_BLOCK_BUDGET_MS,
  TOKENIZE_TIME_LIMIT_MS,
  TOKENIZE_MAX_LINE_LENGTH,
  TokeniseOverBudget,
  type ToneLines,
} from "../src/lib/highlightEngine";
import { GRAMMARS, grammarOf } from "../src/lib/highlightLanguages";

/** Each run as `tone:text`, the plain ones as `:text`, a line per array. */
const read = (lines: ToneLines): string[][] =>
  lines.map((line) =>
    line.map((run) => `${run.tone === "plain" ? "" : run.tone}:${run.text}`),
  );

/*
 * Every grammar is loaded and run once before any test asserts on its tones. The first line
 * a grammar tokenises pays for compiling its regexes, and on a loaded machine that can pass
 * the per-line limit; the engine retries such a line, but a test's exact runs should not
 * rest on the retry's timing either.
 */
beforeAll(async () => {
  for (const grammar of GRAMMARS) {
    await tokenise("a = 1 // x\n<b c=\"d\">'e'</b>", grammar);
  }
}, 60_000);

describe("the tones Shiki gives", () => {
  test("D8's js sample: words heavier, names in the base ink, symbols muted", async () => {
    expect(
      read(await tokenise("var=expres() + yield * expres2()", "javascript")),
    ).toEqual([
      [
        "key:var",
        ":=",
        "value:expres",
        ":() + ",
        "key:yield",
        ": * ",
        "value:expres2",
        ":()",
      ],
    ]);
  });

  test("D8's entry-10.json: keys heavier, values in the base ink, punctuation muted", async () => {
    const json =
      '{\n  "host":       "app.partner.com",\n  "subdomains": false\n}';
    expect(read(await tokenise(json, "json"))).toEqual([
      [":{"],
      [":  ", 'key:"host"', "::       ", 'value:"app.partner.com"', ":,"],
      [":  ", 'key:"subdomains"', ":: ", "value:false"],
      [":}"],
    ]);
  });

  test("a comment is faint, and word operators are words", async () => {
    expect(
      read(
        await tokenise("if (typeof a === 'x') new X() // why", "javascript"),
      ),
    ).toEqual([
      [
        "key:if",
        ": (",
        "key:typeof",
        ": ",
        "value:a",
        ": === ",
        "value:'x'",
        ":) ",
        "key:new",
        ": ",
        "value:X",
        ":() ",
        "comment:// why",
      ],
    ]);
  });

  test("an HTTP request: the method and header names heavier, their values in the base ink", async () => {
    const request = "POST /api/v1/session HTTP/1.1\nHost: acme.com";
    expect(read(await tokenise(request, "http"))).toEqual([
      ["key:POST", ": ", "value:/api/v1/session", ": HTTP/", "value:1.1"],
      ["key:Host", ":: ", "value:acme.com"],
    ]);
  });

  test("every grammar loads and gives back exactly the code it was given", async () => {
    const code = "a = 1 # x\r\n<b c=\"d\">'e'</b>\n-- f\n+ g";
    for (const grammar of GRAMMARS) {
      const lines = await tokenise(code, grammar);
      expect(
        lines.map((line) => line.map((run) => run.text).join("")).join("\n"),
        grammar,
      ).toBe(code.replace("\r\n", "\n"));
      expect(
        lines.flat().some((run) => run.tone !== "plain"),
        grammar,
      ).toBe(true);
    }
  });

  test("a line past the length limit is one plain run", async () => {
    const line = `var a = ${JSON.stringify("x".repeat(TOKENIZE_MAX_LINE_LENGTH))};`;
    const lines = await tokenise(line, "javascript");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.map((run) => run.text).join("")).toBe(line);
    expect(lines[0]?.some((run) => run.tone === "key")).toBe(false);
  });

  test("a hostile block is given up at its budget, not after every line's own limit", async () => {
    // The review's block: `(a,a,a,…` lines just under the length limit, each of which
    // runs Oniguruma to nearly its per-line limit. Sixty took 5 s before the block budget.
    const line = `(${Array.from({ length: 495 }, () => "a").join(",")}`;
    expect(line.length).toBeLessThan(TOKENIZE_MAX_LINE_LENGTH);
    const hostile = Array.from({ length: 60 }, () => line).join("\n");
    await tokenise("x", "typescript");
    const started = performance.now();
    let failed: unknown;
    let begun = 0;
    try {
      await tokenise(hostile, "typescript", {
        budgetMs: 300,
        onStart: () => (begun += 1),
      });
    } catch (error) {
      failed = error;
    }
    const took = performance.now() - started;
    expect(failed).toBeInstanceOf(TokeniseOverBudget);
    expect(begun).toBe(1);
    // The budget, and at most a line or two past it, never sixty lines' worth.
    expect(took).toBeLessThan(1_000);
  });

  test("the budget is read before every line, from the clock it is given", async () => {
    let time = 0;
    const now = (): number => (time += 400);
    await expect(
      tokenise("var a\nvar b\nvar c", "javascript", { budgetMs: 1000, now }),
    ).rejects.toBeInstanceOf(TokeniseOverBudget);
    // An ordinary block is nowhere near the real budget.
    const ordinary = Array.from(
      { length: 1000 },
      (_, index) => `const v${String(index)} = f(${String(index)}) // c`,
    ).join("\n");
    const started = performance.now();
    expect(await tokenise(ordinary, "javascript")).toHaveLength(1000);
    expect(performance.now() - started).toBeLessThan(TOKENIZE_BLOCK_BUDGET_MS);
  });

  test("a hidden character stays in the run's text, for the page to mark", async () => {
    const lines = await tokenise('{"ho\u200Bst": "\u202Eevil"}', "json");
    expect(
      lines
        .flat()
        .map((run) => run.text)
        .join(""),
    ).toBe('{"ho\u200Bst": "\u202Eevil"}');
  });
});

describe("a line that stops at the per-line limit", () => {
  const result = (
    stoppedEarly: boolean,
    tag: number,
  ): ITokenizeLineResult2 => ({
    tokens: new Uint32Array([0, tag]),
    ruleStack: INITIAL,
    stoppedEarly,
  });

  /** A grammar whose lines stop early as `stops` says, logging each call's limit. */
  const grammar = (stops: boolean[]) => {
    const limits: number[] = [];
    return {
      limits,
      tokenizeLine2: (_line: string, _state: unknown, limit?: number) => {
        limits.push(limit ?? -1);
        return result(stops[limits.length - 1] ?? false, limits.length);
      },
    };
  };

  test("is tried once more from the same state, and the second answer is kept", () => {
    const fake = grammar([true, false]);
    const answer = tokeniseLine(fake, "var a", INITIAL, 1_000, () => 0);
    expect(fake.limits).toEqual([
      TOKENIZE_TIME_LIMIT_MS,
      TOKENIZE_TIME_LIMIT_MS,
    ]);
    expect(answer.stoppedEarly).toBe(false);
    expect([...answer.tokens]).toEqual([0, 2]);
  });

  test("only once: a line that stops early again is kept as it came back", () => {
    const fake = grammar([true, true, false]);
    const answer = tokeniseLine(fake, "var a", INITIAL, 1_000, () => 0);
    expect(fake.limits).toHaveLength(2);
    expect(answer.stoppedEarly).toBe(true);
  });

  test("a line that did not stop early is not tried again", () => {
    const fake = grammar([false]);
    tokeniseLine(fake, "var a", INITIAL, 1_000, () => 0);
    expect(fake.limits).toHaveLength(1);
  });

  test("the retry stays inside the block's budget, by the clock it is given", () => {
    // No time left: no retry.
    const spent = grammar([true, false]);
    let time = 1_000;
    expect(
      tokeniseLine(spent, "var a", INITIAL, 1_000, () => time).stoppedEarly,
    ).toBe(true);
    expect(spent.limits).toHaveLength(1);

    // 30 ms left: the retry is given those, not a whole per-line limit.
    const short = grammar([true, false]);
    time = 970;
    tokeniseLine(short, "var a", INITIAL, 1_000, () => time);
    expect(short.limits).toEqual([TOKENIZE_TIME_LIMIT_MS, 30]);
  });
});

describe("the languages a fence may name", () => {
  test("aliases reach their grammar, case-blind; others and prototype names reach none", () => {
    expect(
      [
        "JS",
        "jsx",
        "ts",
        "sh",
        "Bash",
        "zsh",
        "py",
        "yml",
        "svg",
        "patch",
        "HTTP",
      ].map(grammarOf),
    ).toEqual([
      "javascript",
      "javascript",
      "typescript",
      "shellscript",
      "shellscript",
      "shellscript",
      "python",
      "yaml",
      "xml",
      "diff",
      "http",
    ]);
    for (const name of [
      "tsx",
      "cobol",
      "",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(grammarOf(name), name).toBeUndefined();
    }
  });
});
