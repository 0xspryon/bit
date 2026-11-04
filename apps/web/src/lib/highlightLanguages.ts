/**
 * Which fences are highlighted (A6 U11): the grammars bit carries, and the names a fence's
 * info string may call each by. A fence in any other language is drawn plain.
 *
 * Nothing here loads a grammar. This module is imported by `markdown.ts`, which runs on
 * every reply, so it is a table and nothing more: the grammars themselves are loaded one at
 * a time, by the highlighter's worker, the first time a closed fence in that language is
 * drawn (`highlightEngine.ts`).
 *
 * ## Why these eleven
 *
 * bit's agents read bug-bounty program pages and the targets they describe, and their
 * fences are the artefacts of that work:
 *
 * - `http` — a raw request or response, the artefact a report is built on. Its grammar
 *   embeds JSON, XML, GraphQL and shell bodies, so it is also the heaviest to load.
 * - `json` — API bodies, and bit's own records (D8's `entry-10.json`).
 * - `javascript` and `typescript` — a target's client code and a proof of concept.
 * - `shellscript` — `curl`, `ffuf` and the rest of a reproduction.
 * - `python` — exploit and automation scripts.
 * - `html` — a page's markup, and a reflected payload in it.
 * - `xml` — SAML, SOAP and XXE.
 * - `yaml` — CI, Kubernetes and OpenAPI files found on a target.
 * - `sql` — an injection, and the query it lands in.
 * - `diff` — a patch, a fix, or what changed between two responses.
 *
 * Each is one module the browser fetches only when needed, so the set is small for the
 * time a first highlight takes, not for the bundle. `jsx` reads as `javascript`, whose
 * grammar parses JSX; `tsx` does not read as `typescript`, whose grammar takes `<div>` for
 * a type assertion, so it is plain.
 */
export const GRAMMARS = [
  "http",
  "json",
  "javascript",
  "typescript",
  "shellscript",
  "python",
  "html",
  "xml",
  "yaml",
  "sql",
  "diff",
] as const;

export type Grammar = (typeof GRAMMARS)[number];

/**
 * A fence's language, lowercased, to the grammar it is drawn with. A `Map`, not an object,
 * so a fence named `constructor` or `__proto__` names nothing rather than a prototype's
 * property.
 */
const NAMES = new Map<string, Grammar>([
  ["http", "http"],
  ["json", "json"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "javascript"],
  ["typescript", "typescript"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["shellscript", "shellscript"],
  ["shell", "shellscript"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["zsh", "shellscript"],
  ["python", "python"],
  ["py", "python"],
  ["python3", "python"],
  ["html", "html"],
  ["htm", "html"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["sql", "sql"],
  ["diff", "diff"],
  ["patch", "diff"],
]);

/** The grammar a fence's language names, or `undefined` for one drawn plain. */
export const grammarOf = (language: string): Grammar | undefined =>
  NAMES.get(language.toLowerCase());

/** Whether a string is one of {@link GRAMMARS} itself — what a frame's mark must hold. */
export const isGrammar = (name: string): name is Grammar =>
  (GRAMMARS as readonly string[]).includes(name);
