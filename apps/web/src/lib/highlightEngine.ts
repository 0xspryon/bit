/**
 * The tokenising half of syntax highlighting (A6 U11): Shiki, on the Oniguruma WASM engine,
 * with one grammar loaded per language the first time it is asked for. It runs inside the
 * highlighter's worker (`highlight.worker.ts`) and nowhere else in the app, so neither
 * Shiki, the WASM nor a grammar is in the page's own bundle, and a long block is tokenised
 * without holding the page's thread.
 *
 * ## Why Oniguruma
 *
 * TextMate grammars are written for Oniguruma's regular expressions. Shiki's alternative
 * engine translates them to JavaScript `RegExp`s, and a JavaScript regex can backtrack
 * catastrophically: T3 Code pins its highlighter to the WASM engine for exactly that, since
 * one hostile line can hang the tokenising thread. The code highlighted here is an agent's
 * fence, which in the importer is a program page's words, so a line built to make a regex
 * backtrack is an input to expect. Oniguruma is also given a time limit per line
 * ({@link TOKENIZE_TIME_LIMIT_MS}), a length past which a line is left plain
 * ({@link TOKENIZE_MAX_LINE_LENGTH}), and a block a time limit of its own
 * ({@link TOKENIZE_BLOCK_BUDGET_MS}).
 *
 * ## What comes out is data
 *
 * {@link tokenise} returns each line as runs of text and a {@link Tone}, never HTML. Shiki
 * can render HTML itself; nothing here asks it to. The page builds the spans from these
 * runs, with classes of its own, after the reply's sanitiser has run (`highlight.ts`).
 */
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemeRegistrationRaw,
} from "@shikijs/core";
import {
  EncodedTokenMetadata,
  INITIAL,
  type IGrammar,
  type ITokenizeLineResult2,
  type StateStack,
} from "@shikijs/core/textmate";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";

import type { Grammar } from "./highlightLanguages";

/**
 * How a run of code is drawn: in a reply's monochrome palette, by weight and tone only
 * (A6 D8). `plain` is the code's own muted ink, which punctuation and operators keep.
 */
export type Tone = "key" | "value" | "comment" | "plain";

/** One run of a line: its text, exactly as written, and its tone. */
export interface ToneRun {
  readonly text: string;
  readonly tone: Tone;
}

/** A block's lines, split where Shiki splits them (`\n` or `\r\n`), each as its runs. */
export type ToneLines = readonly (readonly ToneRun[])[];

/**
 * One module per grammar, each a literal `import()` so the bundler gives each its own
 * chunk. `http` brings the grammars it embeds (shell, JSON, XML, GraphQL) as chunks of
 * their own, fetched with it.
 */
const LOADERS: Record<
  Grammar,
  () => Promise<{ default: LanguageRegistration[] }>
> = {
  http: () => import("@shikijs/langs/http"),
  json: () => import("@shikijs/langs/json"),
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  python: () => import("@shikijs/langs/python"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
  sql: () => import("@shikijs/langs/sql"),
  diff: () => import("@shikijs/langs/diff"),
};

/*
 * A theme whose colours are not colours: each is a sentinel that says which tone a scope
 * is, read back by {@link TONE_OF}. A TextMate theme is how a grammar's scopes are mapped to
 * a style, with its rules for which selector wins, and reusing it is simpler than walking
 * each token's scope stack here. The real ink is CSS, in the reply's tokens, so light and
 * dark need no second theme.
 */
const KEY = "#000001";
const VALUE = "#000002";
const COMMENT = "#000003";
const PLAIN = "#000000";
const TONE_OF = new Map<string, Tone>([
  [KEY, "key"],
  [VALUE, "value"],
  [COMMENT, "comment"],
]);

/**
 * Which scopes take which tone. D8 draws `var` and `yield` and a JSON key heavier, a value
 * and a called function in the base ink, and the punctuation and operators between them in
 * the code's muted ink; a comment is fainter still. The rest follows that: a key is a word
 * of the language or a name a structure is keyed by (a tag, an attribute, a header, a
 * property), a value is what is said with it.
 */
const TONE_THEME: ThemeRegistrationRaw = {
  name: "bit-tone",
  type: "dark",
  fg: PLAIN,
  bg: "#ffffff",
  settings: [
    { settings: { foreground: PLAIN, background: "#ffffff" } },
    {
      scope: [
        "keyword",
        "storage",
        "entity.name.tag",
        "entity.other.attribute-name",
        "support.type.property-name",
        "meta.diff.header",
        "meta.diff.range",
        // Operators that are words: `new`, `typeof`, `instanceof`; Python's `and`, `not`.
        "keyword.operator.new",
        "keyword.operator.expression",
        "keyword.operator.logical.python",
      ],
      settings: { foreground: KEY },
    },
    {
      scope: [
        "string",
        "constant",
        "variable",
        "entity.name",
        "support.function",
        "support.class",
        "support.type",
        "support.constant",
        "support.variable",
        "markup.inserted",
        // The http grammar's own scope for a request line's path.
        "const.language.http",
      ],
      settings: { foreground: VALUE },
    },
    {
      scope: ["comment", "markup.deleted"],
      settings: { foreground: COMMENT },
    },
    {
      // Symbols, not words: `=`, `+`, `===`, `|`, a generator's `*`, the `:` after a header.
      scope: [
        "keyword.operator",
        "keyword.generator.asterisk",
        "keyword.other.http",
      ],
      settings: { foreground: PLAIN },
    },
  ],
};

/**
 * Lines longer than this are one plain run. A minified bundle is one line of a quarter of a
 * megabyte, and there is nothing to read in it by tone.
 */
export const TOKENIZE_MAX_LINE_LENGTH = 1000;
/** How long Oniguruma may spend on one line before the rest of it is left untokenised. */
export const TOKENIZE_TIME_LIMIT_MS = 100;
/**
 * How long one block may take to tokenise, in all, before it is given up and drawn plain.
 *
 * **The per-line limit does not bound a block.** A review measured 60 lines of
 * `(a,a,a,…` (991 characters each, just under the line length) as TypeScript: each ran to
 * nearly its 100 ms, and the block took 5 s; two of them held the worker for 11 s, and
 * every other fence on the page waited behind them. So the block is tokenised a line at a
 * time against this deadline, and one that passes it fails with
 * {@link TokeniseOverBudget}. 1,000 lines of ordinary JavaScript take about 300 ms, so
 * nothing a reply would show is near it; a hostile block costs at most this plus one line.
 */
export const TOKENIZE_BLOCK_BUDGET_MS = 1000;

/** A block that ran past its budget: drawn plain, and not worth asking for again. */
export class TokeniseOverBudget extends Error {
  constructor(budgetMs: number) {
    super(`tokenising took longer than ${String(budgetMs)} ms`);
    this.name = "TokeniseOverBudget";
  }
}

let core: Promise<HighlighterCore> | undefined;
const loading = new Map<Grammar, Promise<void>>();

const highlighter = (): Promise<HighlighterCore> => {
  core ??= createHighlighterCore({
    themes: [TONE_THEME],
    langs: [],
    engine: createOnigurumaEngine(
      import("@shikijs/engine-oniguruma/wasm-inlined"),
    ),
  }).catch((error: unknown) => {
    core = undefined;
    throw error;
  });
  return core;
};

const load = (shiki: HighlighterCore, grammar: Grammar): Promise<void> => {
  let loaded = loading.get(grammar);
  if (loaded === undefined) {
    loaded = LOADERS[grammar]()
      .then((module) => shiki.loadLanguage(module.default))
      .catch((error: unknown) => {
        loading.delete(grammar);
        throw error;
      });
    loading.set(grammar, loaded);
  }
  return loaded;
};

/** How {@link tokenise} is run: its budget, and a call made when loading is done. */
export interface TokeniseOptions {
  /** The block's budget, {@link TOKENIZE_BLOCK_BUDGET_MS} unless a test says otherwise. */
  readonly budgetMs?: number;
  /**
   * Called once Shiki, the WASM and the grammar are loaded and tokenising starts. The
   * worker tells the page, which times the block from here rather than from its request:
   * fetching a grammar is the network's time, and not the block's.
   */
  readonly onStart?: () => void;
  /** The clock the budget is read from; `performance.now` unless a test says otherwise. */
  readonly now?: () => number;
}

/**
 * One line through Oniguruma, tried a second time if the first stopped at the per-line
 * limit and the block's budget has time left.
 *
 * **A line that stops early comes back partly plain**: the tokens up to where it stopped,
 * then the rest as one untoned token. On a loaded machine the *first* line of a grammar
 * can do that with nothing hostile in it, since its regexes are compiled on first use and
 * that compile is billed to the line. The retry starts from the same state, with the
 * compile paid, so an ordinary line comes back whole; a hostile one stops early again and
 * is kept as it is, and costs at most one more per-line limit, never past the deadline.
 */
export const tokeniseLine = (
  grammar: Pick<IGrammar, "tokenizeLine2">,
  line: string,
  state: StateStack,
  deadline: number,
  now: () => number,
): ITokenizeLineResult2 => {
  const first = grammar.tokenizeLine2(line, state, TOKENIZE_TIME_LIMIT_MS);
  if (!first.stoppedEarly) return first;
  const left = deadline - now();
  if (left <= 0) return first;
  return grammar.tokenizeLine2(
    line,
    state,
    Math.min(TOKENIZE_TIME_LIMIT_MS, left),
  );
};

/**
 * `code` as lines of toned runs, in `grammar`. Neighbouring runs of one tone are joined, so
 * a line is as few spans as its tones need. Rejects with {@link TokeniseOverBudget} when the
 * block takes longer than its budget.
 *
 * The lines are walked here rather than by Shiki's `codeToTokensBase`, which tokenises the
 * whole block in one synchronous call and so cannot be stopped between lines. The walk is
 * the one Shiki makes — split at `\n` and `\r\n`, an empty line no runs, a line at the
 * length limit one plain run, each line's state carried to the next — with the clock read
 * before every line.
 */
export const tokenise = async (
  code: string,
  grammar: Grammar,
  options: TokeniseOptions = {},
): Promise<ToneLines> => {
  const shiki = await highlighter();
  await load(shiki, grammar);
  const budgetMs = options.budgetMs ?? TOKENIZE_BLOCK_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  options.onStart?.();
  const deadline = now() + budgetMs;
  const { colorMap } = shiki.setTheme("bit-tone");
  const engine = shiki.getLanguage(grammar);
  const parts = code.split(/(\r?\n)/);
  const lines: ToneRun[][] = [];
  let state = INITIAL;
  for (let index = 0; index < parts.length; index += 2) {
    if (now() > deadline) throw new TokeniseOverBudget(budgetMs);
    const line = parts[index] ?? "";
    const runs: ToneRun[] = [];
    lines.push(runs);
    if (line === "") continue;
    if (line.length >= TOKENIZE_MAX_LINE_LENGTH) {
      runs.push({ text: line, tone: "plain" });
      continue;
    }
    const result = tokeniseLine(engine, line, state, deadline, now);
    state = result.ruleStack;
    const count = result.tokens.length / 2;
    for (let token = 0; token < count; token += 1) {
      const start = result.tokens[2 * token] ?? 0;
      const end =
        token + 1 < count ? (result.tokens[2 * token + 2] ?? 0) : line.length;
      if (start === end) continue;
      const color =
        colorMap[
          EncodedTokenMetadata.getForeground(result.tokens[2 * token + 1] ?? 0)
        ];
      const tone = TONE_OF.get(color?.toLowerCase() ?? "") ?? "plain";
      const text = line.substring(start, end);
      const last = runs.at(-1);
      if (last !== undefined && last.tone === tone) {
        runs[runs.length - 1] = { text: last.text + text, tone };
      } else {
        runs.push({ text, tone });
      }
    }
  }
  return lines;
};
