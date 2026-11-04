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
 * ({@link TOKENIZE_TIME_LIMIT_MS}) and a length past which a line is left plain
 * ({@link TOKENIZE_MAX_LINE_LENGTH}).
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

/**
 * `code` as lines of toned runs, in `grammar`. Neighbouring runs of one tone are joined, so
 * a line is as few spans as its tones need.
 */
export const tokenise = async (
  code: string,
  grammar: Grammar,
): Promise<ToneLines> => {
  const shiki = await highlighter();
  await load(shiki, grammar);
  const lines = shiki.codeToTokensBase(code, {
    lang: grammar,
    theme: "bit-tone",
    tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
    tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS,
  });
  return lines.map((tokens) => {
    const runs: ToneRun[] = [];
    for (const token of tokens) {
      const tone = TONE_OF.get(token.color?.toLowerCase() ?? "") ?? "plain";
      const last = runs.at(-1);
      if (last !== undefined && last.tone === tone) {
        runs[runs.length - 1] = { text: last.text + token.content, tone };
      } else if (token.content !== "") {
        runs.push({ text: token.content, tone });
      }
    }
    return runs;
  });
};
