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

/**
 * How many fences' tones are kept, and roughly how many bytes they may hold between them.
 *
 * **Weighed by what is stored, not by the code.** A review found a budget of two million
 * code characters let the cache hold about 150 MB: a dense block is a run every character
 * or two, and each run is an object as well as its text — about 77 bytes a character in
 * Chrome. So an entry is weighed as its key's text, its lines and its runs
 * ({@link weightOf}), and the budget is bytes. One entry is never evicted by its own
 * arrival, or a block heavier than the budget would be tokenised again on every render; the
 * heaviest a block can be (60,000 characters, a run each) is about 5 MB, so the cache holds
 * at most the budget and that.
 */
const KEPT_ENTRIES = 256;
const KEPT_BYTES = 4_000_000;
/** An estimate of a run's own cost, past its text: the object, its two fields, its slot. */
const RUN_BYTES = 64;
/** An estimate of a line's own cost, past its runs: the array and its slot. */
const LINE_BYTES = 32;

/** What one cache entry costs, roughly, in bytes: two a character of text, and the objects. */
export const weightOf = (key: string, lines: ToneLines | null): number => {
  let bytes = key.length * 2;
  for (const line of lines ?? []) {
    bytes += LINE_BYTES;
    for (const run of line) bytes += RUN_BYTES + run.text.length * 2;
  }
  return bytes;
};

/**
 * A cache of tones in front of `tokenise`, keyed by grammar and code: one tokenising per
 * fence, however many times a reply is re-rendered around it, and one in flight at a time.
 *
 * Least recently used, bounded by count and by {@link weightOf}, so a few very long blocks
 * cannot hold the page's memory. **A failure is remembered as plain**: `tokenise` rejects
 * only for the block's own sake — it ran past its time, or its grammar would not load on a
 * second, fresh worker ({@link createWorkerTokenise}) — and asking again would only make
 * each re-render a new failure.
 *
 * `bytes` reports what the kept entries weigh, for a test to hold the budget to.
 */
export const createHighlights = (
  tokenise: Tokenise,
): Highlights & { readonly bytes: () => number } => {
  const kept = new Map<
    string,
    { readonly lines: ToneLines | null; readonly weight: number }
  >();
  const waiting = new Map<string, Promise<void>>();
  let bytes = 0;
  const keyOf = (code: string, grammar: Grammar): string =>
    `${grammar}\n${code}`;
  const keep = (key: string, lines: ToneLines | null): void => {
    const weight = weightOf(key, lines);
    bytes -= kept.get(key)?.weight ?? 0;
    kept.delete(key);
    kept.set(key, { lines, weight });
    bytes += weight;
    for (const [oldest, entry] of kept) {
      if (kept.size <= KEPT_ENTRIES && bytes <= KEPT_BYTES) break;
      if (oldest === key) break;
      kept.delete(oldest);
      bytes -= entry.weight;
    }
  };
  const tooLarge = (code: string): boolean =>
    code.length > HIGHLIGHT_MAX_CHARS ||
    code.split("\n", HIGHLIGHT_MAX_LINES + 1).length > HIGHLIGHT_MAX_LINES;
  return {
    bytes: () => bytes,
    peek: (code, grammar) => {
      if (tooLarge(code)) return null;
      const key = keyOf(code, grammar);
      const entry = kept.get(key);
      if (entry === undefined) return undefined;
      kept.delete(key);
      kept.set(key, entry);
      return entry.lines;
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

/** What the page sends the worker: one block. */
export interface WorkerRequest {
  readonly id: number;
  readonly code: string;
  readonly grammar: Grammar;
}

/** What the worker answers about one block (`highlight.worker.ts`). */
export interface WorkerAnswer {
  readonly id: number;
  readonly started?: true;
  readonly lines?: ToneLines;
  readonly failed?: string;
  readonly retry?: boolean;
}

/** What the page needs of a worker: the browser's `Worker`, or a test's stand-in. */
export interface HighlightWorker {
  onmessage: ((event: MessageEvent<WorkerAnswer>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
}

/**
 * How long the page waits on the worker. `loadMs` from sending a block to the worker's
 * word that tokenising started — Shiki, the WASM and a grammar are fetched in that time —
 * and `blockMs` from then to its answer. `blockMs` is a backstop: the worker gives a block
 * up itself at its budget (`TOKENIZE_BLOCK_BUDGET_MS`, a second) and a line later, and this
 * is for the line that does not stop when told, which only terminating the worker ends. It
 * is a literal rather than that constant plus a second because importing a value from
 * `highlightEngine.ts` would put Shiki in the page's bundle; a test holds the two apart.
 */
export interface WorkerTiming {
  readonly loadMs: number;
  readonly blockMs: number;
}
export const WORKER_TIMING: WorkerTiming = {
  loadMs: 20_000,
  blockMs: 2_000,
};

/** How many times one block is sent to a worker before it is drawn plain. */
const TRIES = 2;

/**
 * A {@link Tokenise} that sends each block to a worker, **one at a time**, and times it.
 *
 * One at a time because the worker can only tokenise one block at once anyway, and because
 * it makes "the block that ran over" a fact rather than a guess: whatever is in flight when
 * the deadline passes is the block that held it. That block is drawn plain; the worker is
 * terminated, since a line that ignores its own time limit is not otherwise stopped; and
 * the blocks still queued go to a new one, never having been sent to the old.
 *
 * **One failure does not spread.** A worker that crashes, or a grammar or the WASM that
 * will not load, fails the block in flight only, and that block is sent once more on a
 * fresh worker before it is drawn plain — a network blip is not a reply's fences plain until
 * a reload. A block that ran past its budget is not sent again: it would only run past it
 * again.
 */
export const createWorkerTokenise = (
  start: () => HighlightWorker,
  timing: WorkerTiming = WORKER_TIMING,
): Tokenise => {
  interface Job {
    readonly code: string;
    readonly grammar: Grammar;
    readonly resolve: (lines: ToneLines) => void;
    readonly reject: (error: Error) => void;
    tries: number;
    id: number;
  }
  const queue: Job[] = [];
  let worker: HighlightWorker | undefined;
  let current: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;

  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (ms: number, onLate: () => void): void => {
    disarm();
    timer = setTimeout(onLate, ms);
  };
  const stop = (): void => {
    disarm();
    const old = worker;
    worker = undefined;
    old?.terminate();
  };
  /** The block in flight is done with; send the next. */
  const settle = (): void => {
    disarm();
    current = undefined;
    pump();
  };
  /**
   * The block in flight failed for want of a working worker: once more, on a new one. On
   * its last try the block is plain, and the worker is kept unless `dead` says it is gone
   * or stuck — a grammar that would not load twice says nothing about the next block's.
   */
  const again = (job: Job, why: string, dead: boolean): void => {
    const retry = job.tries < TRIES;
    if (dead || retry) stop();
    else disarm();
    current = undefined;
    if (retry) queue.unshift(job);
    else job.reject(new Error(why));
    pump();
  };
  const listen = (made: HighlightWorker): void => {
    made.onmessage = (event) => {
      const job = current;
      if (made !== worker || job === undefined || event.data.id !== job.id) {
        return;
      }
      if (event.data.started === true) {
        arm(timing.blockMs, () => {
          stop();
          job.reject(new Error("the highlighter took too long on this block"));
          settle();
        });
        return;
      }
      if (event.data.lines !== undefined) {
        job.resolve(event.data.lines);
        settle();
        return;
      }
      const why = event.data.failed ?? "tokenising failed";
      if (event.data.retry === true) {
        again(job, why, false);
        return;
      }
      job.reject(new Error(why));
      settle();
    };
    made.onerror = () => {
      if (made !== worker) return;
      if (current === undefined) stop();
      else again(current, "the highlighter stopped", true);
    };
  };
  const pump = (): void => {
    while (current === undefined) {
      const job = queue.shift();
      if (job === undefined) return;
      job.tries += 1;
      if (worker === undefined) {
        try {
          worker = start();
        } catch {
          worker = undefined;
          if (job.tries < TRIES) queue.unshift(job);
          else job.reject(new Error("the highlighter could not start"));
          continue;
        }
        listen(worker);
      }
      nextId += 1;
      job.id = nextId;
      current = job;
      arm(timing.loadMs, () =>
        again(job, "the highlighter did not load", true),
      );
      worker.postMessage({ id: job.id, code: job.code, grammar: job.grammar });
    }
  };

  return (code, grammar) =>
    new Promise((resolve, reject) => {
      queue.push({ code, grammar, resolve, reject, tries: 0, id: 0 });
      pump();
    });
};

/** The app's highlights: Shiki in a worker, one cache for every reply on the page. */
export const appHighlights: Highlights = createHighlights(
  createWorkerTokenise(
    () =>
      new Worker(new URL("./highlight.worker.ts", import.meta.url), {
        type: "module",
      }),
  ),
);

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
