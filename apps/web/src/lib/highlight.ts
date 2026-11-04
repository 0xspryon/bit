/**
 * Syntax highlighting for an agent's fences (A6 U11), as A6 D8 draws it: by weight and tone
 * in the reply's own monochrome ink, never by hue.
 *
 * ## Where it runs, and why there
 *
 * `markdown.ts` marks a **closed** fence in a known language (`highlightLanguages.ts`)
 * `data-highlight="<grammar>"`, and leaves it ordinary, sanitised code. `Markdown.svelte`
 * then asks this module for that fence's tones and, once it has them, rebuilds the code's
 * children from them. A fence still being streamed is not closed and is never asked for, so
 * nothing is tokenised on the streaming path; a reply's later deltas find the same fence's
 * tones in {@link Highlights}' cache and its `<code>` already built.
 *
 * Tokenising happens in a worker (`highlight.worker.ts`), which loads Shiki, its WASM and
 * each grammar the first time one is needed. 1,000 lines of JavaScript took 290 ms to
 * tokenise on one thread (measured under Bun, U11); in the page that is a frozen tab, in a
 * worker it is a late highlight. What is left on the page's thread is building spans, and a
 * block past {@link HIGHLIGHT_MAX_LINES} or {@link HIGHLIGHT_MAX_CHARS} is not highlighted
 * at all: it is drawn plain, as every fence was before this.
 *
 * ## Why the output cannot reopen the sanitiser
 *
 * The worker answers with **data** — each line as runs of text and a tone — and never
 * HTML. {@link toneCode} builds the spans with `document.createElement` and text nodes,
 * with one of three constant classes chosen by the tone, after `rehype-sanitize` has run
 * and outside `{@html}` altogether; a tone it does not know is plain text. So `</span>
 * <script>` in a fence is text in a span, as it was text in the `<code>` before.
 *
 * Two more things hold by construction rather than by care:
 *
 * - **Hidden characters are still marked.** Each run's text goes through `codeRuns`, the
 *   rule the fence was marked by, so a bidi, zero-width or tag character inside a
 *   highlighted keyword is the same `.char-escape` marker it was in the plain fence. A run
 *   is never allowed to end halfway through a surrogate pair, where a tag character would
 *   be split into two halves no rule names.
 * - **Copy copies what was written.** The runs are checked against the code they claim to
 *   be: a line whose runs do not spell exactly that line, or a block whose lines are not
 *   its lines, is left plain. Copy reads the `<code>` back (`written`), and what it reads
 *   is therefore the same text before and after.
 */
import type { Tone, ToneLines, ToneRun } from "./highlightEngine";
import type { Grammar } from "./highlightLanguages";
import { codeRuns } from "./markdown";

export type { Tone, ToneLines, ToneRun };

/**
 * The largest block highlighted, in lines and in characters; past either it is drawn
 * plain. Tokenising is in the worker and does not hold the page — 5,000 lines of JavaScript
 * took 1.2 s there with no frame on the page later than 17 ms (Chrome, U11) — but building
 * the spans is on the page's thread and grows with the block: 44 ms for 1,000 lines on
 * their own, and a 1,000-line fence's whole highlight was one long task of about 90 ms,
 * once. Past these, a block is read by scrolling and searching rather than by tone, and a
 * longer task would be a hitch the operator feels.
 */
export const HIGHLIGHT_MAX_LINES = 1000;
export const HIGHLIGHT_MAX_CHARS = 60_000;

/** Tokenises one fence's code: the app's runs Shiki in a worker; a test's is a stand-in. */
export type Tokenise = (code: string, grammar: Grammar) => Promise<ToneLines>;

/**
 * What a reply knows about a fence's tones: `peek` says, without waiting, and `request`
 * starts the work and settles when `peek` has an answer.
 *
 * `peek` is `undefined` while there is no answer yet, `null` when the fence is drawn plain
 * (too large, or tokenising failed), and the lines once they are known.
 */
export interface Highlights {
  readonly peek: (
    code: string,
    grammar: Grammar,
  ) => ToneLines | null | undefined;
  readonly request: (code: string, grammar: Grammar) => Promise<void>;
}

/** How many fences' tones are kept, and how many characters of code across them. */
const KEPT_ENTRIES = 256;
const KEPT_CHARS = 2_000_000;

/**
 * A cache of tones in front of `tokenise`, keyed by grammar and code: one tokenising per
 * fence, however many times a reply is re-rendered around it, and one in flight at a time.
 *
 * Least recently used, bounded by both count and characters, so a few very long blocks
 * cannot hold the page's memory. **A failure is remembered as plain**: a grammar that will
 * not load or a block that will not tokenise would fail again, and asking again would only
 * make each re-render a new failure.
 */
export const createHighlights = (tokenise: Tokenise): Highlights => {
  const kept = new Map<string, ToneLines | null>();
  const waiting = new Map<string, Promise<void>>();
  let chars = 0;
  const keyOf = (code: string, grammar: Grammar): string =>
    `${grammar}\n${code}`;
  const keep = (key: string, lines: ToneLines | null): void => {
    kept.set(key, lines);
    chars += key.length;
    for (const [oldest] of kept) {
      if (kept.size <= KEPT_ENTRIES && chars <= KEPT_CHARS) break;
      kept.delete(oldest);
      chars -= oldest.length;
    }
  };
  const tooLarge = (code: string): boolean =>
    code.length > HIGHLIGHT_MAX_CHARS ||
    code.split("\n", HIGHLIGHT_MAX_LINES + 1).length > HIGHLIGHT_MAX_LINES;
  return {
    peek: (code, grammar) => {
      if (tooLarge(code)) return null;
      const key = keyOf(code, grammar);
      const lines = kept.get(key);
      if (lines === undefined) return undefined;
      kept.delete(key);
      kept.set(key, lines);
      return lines;
    },
    request: (code, grammar) => {
      if (tooLarge(code)) return Promise.resolve();
      const key = keyOf(code, grammar);
      if (kept.has(key)) return Promise.resolve();
      let pending = waiting.get(key);
      if (pending === undefined) {
        pending = Promise.resolve()
          .then(() => tokenise(code, grammar))
          .then(
            (lines) => keep(key, lines),
            () => keep(key, null),
          )
          .finally(() => waiting.delete(key));
        waiting.set(key, pending);
      }
      return pending;
    },
  };
};

/**
 * The worker, started on the first request. If it cannot start, or dies, every request in
 * flight fails — the fences stay plain — and the next request starts a new one.
 */
let worker: Worker | undefined;
let nextId = 0;
const answers = new Map<
  number,
  { resolve: (lines: ToneLines) => void; reject: (error: Error) => void }
>();
const stopWorker = (why: string): void => {
  worker?.terminate();
  worker = undefined;
  for (const each of answers.values()) each.reject(new Error(why));
  answers.clear();
};
const startWorker = (): Worker => {
  const made = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
    type: "module",
  });
  made.onmessage = (
    event: MessageEvent<{ id: number; lines?: ToneLines; failed?: string }>,
  ) => {
    const answer = answers.get(event.data.id);
    if (answer === undefined) return;
    answers.delete(event.data.id);
    if (event.data.lines !== undefined) answer.resolve(event.data.lines);
    else answer.reject(new Error(event.data.failed ?? "tokenising failed"));
  };
  made.onerror = () => stopWorker("the highlighter stopped");
  return made;
};
const workerTokenise: Tokenise = (code, grammar) =>
  new Promise((resolve, reject) => {
    worker ??= startWorker();
    nextId += 1;
    answers.set(nextId, { resolve, reject });
    worker.postMessage({ id: nextId, code, grammar });
  });

/** The app's highlights: Shiki in a worker, one cache for every reply on the page. */
export const appHighlights: Highlights = createHighlights(workerTokenise);

/** The constant class each tone is drawn with. `plain` is no element at all. */
const TONE_CLASS: Readonly<Record<Exclude<Tone, "plain">, string>> = {
  key: "tone-key",
  value: "tone-value",
  comment: "tone-comment",
};
const classOf = (tone: unknown): string | undefined =>
  tone === "key" || tone === "value" || tone === "comment"
    ? TONE_CLASS[tone]
    : undefined;

/** Whether a string ends with the first half of a surrogate pair. */
const endsHalfway = (text: string): boolean => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff;
};

/**
 * `code`, as `lines` tone it: text nodes and spans to put in its `<code>`, or `null` when
 * the lines are not exactly `code`, in which case it stays as it was.
 *
 * `code` is split where Shiki splits a block, at `\n` and `\r\n`, and each line's runs must
 * spell that line. Within a run, every character `codeRuns` names becomes a `.char-escape`
 * marker, the same element the fence's plain rendering has, which Copy reads back.
 */
export const toneCode = (
  lines: ToneLines,
  code: string,
): DocumentFragment | null => {
  const parts = code.split(/(\r?\n)/);
  if (parts.length !== lines.length * 2 - 1) return null;
  const fragment = document.createDocumentFragment();
  for (const [index, line] of lines.entries()) {
    if (index > 0) fragment.append(parts[index * 2 - 1] ?? "");
    if (line.map((run) => run.text).join("") !== parts[index * 2]) return null;
    let carried = "";
    for (const [at, run] of line.entries()) {
      let text = carried + run.text;
      carried = "";
      if (at < line.length - 1 && endsHalfway(text)) {
        carried = text.slice(-1);
        text = text.slice(0, -1);
      }
      if (text === "") continue;
      const name = classOf(run.tone);
      let holder: DocumentFragment | HTMLSpanElement = fragment;
      if (name !== undefined) {
        holder = document.createElement("span");
        holder.className = name;
        fragment.append(holder);
      }
      for (const piece of codeRuns(text)) {
        if (!piece.escape) {
          holder.append(piece.text);
          continue;
        }
        const mark = document.createElement("span");
        mark.className = "char-escape";
        mark.textContent = piece.text;
        holder.append(mark);
      }
    }
  }
  return fragment;
};
