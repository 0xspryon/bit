<script lang="ts">
  /**
   * An agent's prose, rendered as markdown. Used by the importer's live reply in `ChatItem`
   * (its narrated reading) and by every replayed entry in `Chat`, so within the importer a
   * reply and its copy read back after a reload cannot disagree about what a table or a
   * fence looks like. **Not yet everywhere:** in `layout="panel"` a *live* reply still goes
   * through `ChatItem`'s ledger row as plain text while its replayed copy comes through
   * here. Unifying the two is S6's.
   *
   * **The `{@html}` below is the one place agent text becomes markup**, and what makes it
   * safe is `renderMarkdown`, not this component: raw HTML in the source never becomes an
   * element (it is turned into escaped text while hast is being built, by a handler that has
   * no way to produce an element), and every link and image URL has been through
   * `rehype-sanitize`'s protocol allowlist. See `markdown.ts`. Nothing else may be passed to
   * `{@html}` here.
   *
   * `renderMarkdown` is remembered by text, so this deriving again — which it does whenever
   * the row above it is rebuilt, on every frame of unrelated live activity — is a lookup
   * rather than a parse.
   *
   * Sizes are inherited: the live row sets 13px and the replayed one 12px, and a heading or
   * a code block is drawn relative to whichever it is in.
   */
  import type { Attachment } from "svelte/attachments";

  import { renderMarkdown } from "../markdown";

  let { text }: { text: string } = $props();

  const html = $derived(renderMarkdown(text));

  /** How long a Copy button says what happened before it says Copy again. */
  const COPIED_FOR_MS = 1500;
  const resets = new WeakMap<
    HTMLButtonElement,
    ReturnType<typeof setTimeout>
  >();

  const say = (button: HTMLButtonElement, word: string): void => {
    clearTimeout(resets.get(button));
    button.textContent = word;
    resets.set(
      button,
      setTimeout(() => {
        button.textContent = "Copy";
      }, COPIED_FOR_MS),
    );
  };

  /**
   * A fence's **Copy** button, wired here rather than in the HTML: the HTML is agent text
   * and carries no handler (`codeFrame` in `markdown.ts` builds the button from constants).
   * One listener on the root, for every frame in this reply, however often `{@html}`
   * replaces them.
   *
   * What is copied is the fence's text exactly as written: the `<pre>`'s `<code>` in the
   * clicked button's own frame, less the one newline `remark-rehype` adds after every
   * fence's last line. Nothing in agent text can be a `.code-copy` but that button, since
   * the sanitiser lets no class through from the source except a fence's `language-…` and
   * the task list's and footnotes' own.
   *
   * The clipboard API needs a secure context, which bit's localhost is; where it is
   * missing or refused, the button says so rather than claiming a copy.
   */
  const copyButtons: Attachment<HTMLElement> = (root) => {
    const onclick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest(".code-copy");
      if (!(button instanceof HTMLButtonElement) || !root.contains(button)) {
        return;
      }
      const code = button.closest(".code-frame")?.querySelector("pre > code");
      if (code === null || code === undefined) return;
      const copied = (code.textContent ?? "").replace(/\n$/, "");
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(copied))
        .then(
          () => say(button, "Copied"),
          () => say(button, "Copy failed"),
        );
    };
    root.addEventListener("click", onclick);
    return () => root.removeEventListener("click", onclick);
  };
</script>

<div class="markdown" {@attach copyButtons}>
  {@html html}
</div>

<style>
  /*
   * `white-space` is normal on purpose. The serialiser puts a newline between block
   * elements, and the row this replaces used `pre-wrap`; keeping that would draw each of
   * those as a blank line. Markdown's own line breaks are the paragraphs and the fences.
   *
   * A6 D8 is the reference for everything below: the thread's own ink, monochrome, and an
   * 800px measure nothing in a reply may widen. Prose wraps anywhere it has to; what cannot
   * wrap (a fence, a table too wide for the column) scrolls inside its own block.
   */
  .markdown {
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .markdown > :global(:first-child) {
    margin-top: 0;
  }
  .markdown > :global(:last-child),
  .markdown :global(blockquote > :last-child),
  .markdown :global(li > :last-child) {
    margin-bottom: 0;
  }
  /*
   * D8 spaces a reply's blocks further apart than its lines: prose by its paragraphs, and a
   * framed block (a table, a fence, a quote) with a wider gap either side.
   */
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 0.75em;
  }
  .markdown :global(blockquote),
  .markdown :global(.code-frame),
  .markdown :global(.table-wrap) {
    margin: 1.15em 0;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: 1.4em 0 0.6em;
    color: var(--text-base);
    font-weight: 530;
    line-height: 1.45;
  }
  .markdown :global(h1) {
    font-size: 1.3em;
  }
  .markdown :global(h2) {
    font-size: 1.15em;
  }
  .markdown :global(h3) {
    font-size: 1.06em;
  }
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    font-size: 1em;
  }
  .markdown :global(strong) {
    font-weight: 600;
  }
  .markdown :global(del) {
    color: var(--text-muted);
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    padding-left: 1.5em;
  }
  /* D8's round dot at every depth, set here rather than taken from the chat's list. */
  .markdown :global(ul) {
    list-style-type: disc;
  }
  .markdown :global(ol) {
    list-style-type: decimal;
  }
  .markdown :global(li::marker) {
    color: var(--icon-muted);
  }
  .markdown :global(li li::marker) {
    color: var(--icon-faint);
  }
  .markdown :global(li + li) {
    margin-top: 0.3em;
  }
  .markdown :global(li > ul),
  .markdown :global(li > ol) {
    margin: 0.3em 0 0;
  }
  .markdown :global(li > p) {
    margin-bottom: 0.3em;
  }
  /*
   * A task list (GFM `- [ ]`, `- [x]`) is read, not ticked: the sanitiser forces every
   * `<input>` to `disabled` and `type="checkbox"`, and this draws D8's box over it. A done
   * item's text is struck through and muted; `finish` wraps that text in `.task-text` so the
   * strike stops before any list nested under the item.
   */
  /*
   * Per item, not per list: GFM marks the whole list `contains-task-list` when any one
   * item is a task, and a bullet item in the same list keeps its bullet. The box takes the
   * marker's place, at the list's own left edge.
   */
  .markdown :global(li.task-list-item) {
    margin-left: -1.5em;
    list-style-type: none;
  }
  .markdown :global(li.task-list-item input[type="checkbox"]) {
    flex: none;
    width: 15px;
    height: 15px;
    margin: 0 10px 0 0;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    background: transparent;
    vertical-align: -3px;
    appearance: none;
    cursor: default;
  }
  /*
   * The tick is cut out of the filled box, so it shows the page through it — D8's tick is
   * the page's colour on the inverse fill, in either theme, with no colour of its own.
   */
  .markdown :global(li.task-list-item input[type="checkbox"]:checked) {
    border-color: transparent;
    background: var(--bg-inverse);
    mask:
      linear-gradient(#000 0 0),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 15 15'%3E%3Cpath d='m12.5 4-6.9 6.9-3.1-3.1' fill='none' stroke='%23000' stroke-width='1.9'/%3E%3C/svg%3E")
        center / 15px 15px no-repeat;
    mask-composite: exclude;
  }
  .markdown :global(input:checked + .task-text) {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  /*
   * A quote is a bar and muted ink; the line it came from, when the agent gives one
   * (`— source` closing the quote, see `quoteSource` in `markdown.ts`), sits under it in
   * small mono.
   */
  .markdown :global(blockquote) {
    margin-left: 2px;
    padding-left: 14px;
    border-left: 2px solid var(--border-strong);
    color: var(--text-muted);
  }
  .markdown :global(blockquote > p.quote-source) {
    margin-top: 0.6em;
    color: var(--text-faint);
    font: 400 11px/16px var(--font-mono);
  }
  .markdown :global(hr) {
    margin: 0.8em 0;
    border: 0;
    border-top: 1px solid var(--border-muted);
  }
  .markdown :global(a) {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  /*
   * Inline code, as D8 draws it: mono a step under the prose (12px in a 13px reply), on
   * the second layer, 1px by 5px, a 4px radius. It is text inside a sentence, so it wraps
   * with the sentence: a long span (a URL, a token) breaks anywhere rather than widening the
   * 800px measure — set here rather than inherited, so no parent can turn it off — and each
   * broken piece keeps its own padding and corners. Only a fence scrolls; a span never does.
   */
  .markdown :global(:not(pre) > code) {
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: var(--bg-layer-02);
    white-space: normal;
    overflow-wrap: anywhere;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  /*
   * A fence, framed (`codeFrame` in `markdown.ts`): its name and Copy above, the block
   * under. The block is verbatim — an ASCII tree is its indentation — so `pre` keeps every
   * space and line break and scrolls on its own rather than wrapping a line or widening
   * the thread.
   *
   * **Why the header is on every fence.** In the chat a box with an edge means something: a
   * solid one is a committed record and a dashed one is narration (`ChatItem`'s `.block`,
   * and `live.ts` §9 on why that distinction must never be implied by something that does
   * not have it). D8 gives a fence an edge, and its long-line box is drawn exactly as a
   * record is: the hairline, the deep background, mono 12/20. A fence is the agent's prose,
   * and in a record's box it could write itself a convincing `add_scope_entry` receipt. So
   * a fence always carries the header strip with its Copy button, which no record has, and
   * its text is the prose's own colour rather than the records' muted one.
   */
  .markdown :global(.code-frame) {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    border: 1px solid var(--border-base);
    border-radius: 7px;
    background: var(--bg-deep);
  }
  .markdown :global(.code-head) {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 5px 6px 5px 12px;
    border-bottom: 1px solid var(--border-base);
  }
  .markdown :global(.code-label) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .markdown :global(.code-copy) {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    cursor: pointer;
    transition:
      background var(--dur-hover) ease-out,
      color var(--dur-hover) ease-out;
  }
  .markdown :global(.code-copy)::before {
    content: "";
    width: 12px;
    height: 12px;
    background: currentColor;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='1.5'%3E%3Crect x='9' y='9' width='12' height='12' rx='2'/%3E%3Cpath d='M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'/%3E%3C/svg%3E")
      center / contain no-repeat;
  }
  .markdown :global(.code-copy:hover) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .markdown :global(.code-copy:focus-visible) {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .markdown :global(.code-frame pre) {
    margin: 0;
    overflow-x: auto;
    padding: 12px 14px;
    color: var(--text-base);
    font: 400 12px/20px var(--font-mono);
    white-space: pre;
    overflow-wrap: normal;
  }
  .markdown :global(pre code) {
    font-size: inherit;
  }
  /*
   * A table fills the thread's width, as D8 draws it; the wrapper scrolls only when its
   * columns genuinely need more than the column has (see `finish` in `markdown.ts`), and
   * carries the edge so the edge scrolls with nothing.
   */
  .markdown :global(.table-wrap) {
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border-base);
    border-radius: 7px;
  }
  .markdown :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92em;
    line-height: 18px;
  }
  .markdown :global(th),
  .markdown :global(td) {
    padding: 9px 12px;
    border-bottom: 1px solid var(--border-muted);
    text-align: left;
    vertical-align: top;
    overflow-wrap: normal;
  }
  .markdown :global(th) {
    border-bottom-color: var(--border-base);
    background: var(--bg-deep);
    color: var(--text-muted);
    font: 500 11px/16px var(--font-sans);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .markdown :global(tbody tr:last-child td) {
    border-bottom: 0;
  }
  /*
   * A host in a cell is one token. Left to wrap, a narrow column broke
   * `asset-0.subdomain.acme-corp.com` at its hyphens, and a hostname split across lines
   * reads as two. The scroller above takes the width instead.
   */
  .markdown :global(td code),
  .markdown :global(th code) {
    padding: 0;
    background: none;
    white-space: nowrap;
    overflow-wrap: normal;
  }
  /* A header's capitals are its label's style; code in one is still the text as written. */
  .markdown :global(th code) {
    letter-spacing: normal;
    text-transform: none;
  }
  .markdown :global(th[align="center"]),
  .markdown :global(td[align="center"]) {
    text-align: center;
  }
  .markdown :global(th[align="right"]),
  .markdown :global(td[align="right"]) {
    text-align: right;
  }
  /* remark-rehype labels a footnote section with a heading meant only for screen readers. */
  .markdown :global(.sr-only) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .markdown :global(.footnotes) {
    margin-top: 0.8em;
    color: var(--text-muted);
    font-size: 0.92em;
  }
</style>
