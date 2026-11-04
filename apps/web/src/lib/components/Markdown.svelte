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
   * **The one other place is a flow figure** (A6 U12): a closed ` ```mermaid ` fence, which
   * `MermaidBlock` draws client-side from the fence's text. Its SVG is the renderer's, not
   * the agent's markup, and it passes a second, private sanitiser before it is in the page
   * (`diagramDraw.ts`).
   *
   * `renderMarkdown` is remembered by text, so this deriving again — which it does whenever
   * the row above it is rebuilt, on every frame of unrelated live activity — is a lookup
   * rather than a parse.
   *
   * Sizes are inherited: the live row sets 13px and the replayed one 12px, and a heading or
   * a code block is drawn relative to whichever it is in.
   */
  import { mount, unmount } from "svelte";
  import type { Attachment } from "svelte/attachments";

  import { renderMarkdown } from "../markdown";
  import MermaidBlock from "./MermaidBlock.svelte";

  let { text }: { text: string } = $props();

  const html = $derived(renderMarkdown(text));

  /** How long a Copy button says what happened before it says Copy again. */
  const COPIED_FOR_MS = 1500;

  /**
   * What the last Copy did, for a screen reader. The button's own word changes too, but its
   * `aria-label` ("Copy entry-10.json") is what is read for it, and a changed word inside a
   * button is not announced anyway. One polite region per reply, outside the `{@html}`, so
   * it is this component's and no agent text can be in it — which is why it says "Copied"
   * and not the fence's name: that name is the agent's.
   *
   * A region speaks when its text changes, so a second Copy inside the 1.5 s, writing
   * "Copied" over "Copied", would go unheard. Emptying the region and setting the word a
   * frame later is not enough either: a screen reader samples the accessibility tree, and
   * both changes can land between two samples. So each result alternates with itself plus
   * a trailing space — `Copied`, then `Copied ` — and two announcements in a row always
   * differ in the text itself. The space is not spoken.
   */
  let announced = $state("");

  /**
   * The code as the agent wrote it. `markdown.ts` shows each bidi, zero-width or tag
   * character in code as a `.char-escape` marker, `⟨U+202E⟩` or the five-digit
   * `⟨U+E0041⟩`; this puts the character back. Only the pipeline makes a `.char-escape`
   * (the sanitiser passes no such class from the source), so an agent's own `⟨U+202E⟩` is
   * copied as those characters.
   */
  const written = (code: Element): string => {
    const copy = code.cloneNode(true);
    if (!(copy instanceof Element)) return "";
    for (const mark of copy.querySelectorAll(".char-escape")) {
      const point = /^⟨U\+([0-9A-F]+)⟩$/.exec(mark.textContent ?? "")?.[1];
      if (point !== undefined) {
        mark.replaceWith(String.fromCodePoint(Number.parseInt(point, 16)));
      }
    }
    return copy.textContent ?? "";
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
   *
   * Every reset timer belongs to the attachment and is cleared with it, so a reply taken
   * away within the 1.5 s leaves nothing to run against its detached buttons.
   */
  const copyButtons: Attachment<HTMLElement> = (root) => {
    const resets = new Map<Element, ReturnType<typeof setTimeout>>();
    const later = (key: Element, run: () => void): void => {
      clearTimeout(resets.get(key));
      resets.set(
        key,
        setTimeout(() => {
          resets.delete(key);
          run();
        }, COPIED_FOR_MS),
      );
    };
    let spaced = false;
    const say = (button: HTMLButtonElement, word: string): void => {
      button.textContent = word;
      announced = spaced ? `${word} ` : word;
      spaced = !spaced;
      later(button, () => {
        button.textContent = "Copy";
      });
      later(root, () => {
        announced = "";
      });
    };
    const onclick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest(".code-copy");
      if (!(button instanceof HTMLButtonElement) || !root.contains(button)) {
        return;
      }
      const code = button.closest(".code-frame")?.querySelector("pre > code");
      if (code === null || code === undefined) return;
      const copied = written(code).replace(/\n$/, "");
      Promise.resolve()
        .then(() => navigator.clipboard.writeText(copied))
        .then(
          () => say(button, "Copied"),
          () => say(button, "Copy failed"),
        );
    };
    root.addEventListener("click", onclick);
    return () => {
      root.removeEventListener("click", onclick);
      for (const timer of resets.values()) clearTimeout(timer);
      resets.clear();
    };
  };

  /**
   * Each closed mermaid fence in this reply, drawn as a flow figure (A6 U12).
   *
   * `markdown.ts` marks such a fence's frame `data-diagram` and leaves it ordinary code, so
   * the HTML is the same sanitised string whether or not a figure is ever drawn. Here, after
   * `{@html}` has put it in the page, each marked frame's contents are replaced by a
   * `MermaidBlock`, given the fence's name and code **as the agent wrote them** (`written`
   * puts back the characters the pipeline marked: the figure's own drawing marks them
   * again). An `$effect` rather than an attachment, because it must run after `{@html}`
   * has replaced the frames: it re-runs whenever the HTML changes.
   *
   * **A drawn figure outlives the HTML it was drawn in.** A live reply's text grows by a
   * delta at a time, and every delta is a new HTML string that `{@html}` puts in place of
   * every frame, a closed fence's included. Mounting a fresh block each time laid every
   * figure out again on every delta — about a second each in Chrome for a large one — and
   * reset its Show code (U12 review). So each block is mounted into a `host` element of its
   * own, remembered by the fence's place among this reply's figures, its name and its code;
   * when the new HTML has a frame with the same three, the host — the drawn SVG, the
   * toggle's state and all — is moved into it, and only a fence that is new, or changed,
   * is drawn. A block whose fence is gone is unmounted. The host is `display: contents`, so
   * the block's head, figure and code are laid out by the frame exactly as before.
   */
  interface Drawn {
    readonly host: HTMLElement;
    readonly block: ReturnType<typeof mount>;
  }
  let drawn = new Map<string, Drawn>();
  let root: HTMLElement | undefined = $state();
  $effect(() => {
    void html;
    if (root === undefined) return;
    const next = new Map<string, Drawn>();
    const frames = root.querySelectorAll<HTMLElement>(
      ".code-frame[data-diagram]",
    );
    for (const [index, frame] of frames.entries()) {
      const code = frame.querySelector("pre > code");
      const label = frame.querySelector(".code-label");
      const source = code === null ? "" : written(code).replace(/\n$/, "");
      const name = label === null ? "mermaid" : written(label);
      const key = JSON.stringify([index, name, source]);
      let kept = drawn.get(key);
      drawn.delete(key);
      if (kept === undefined) {
        const host = document.createElement("div");
        host.className = "diagram-host";
        host.style.display = "contents";
        kept = {
          host,
          block: mount(MermaidBlock, {
            target: host,
            props: { source, label: name },
          }),
        };
      }
      frame.replaceChildren(kept.host);
      next.set(key, kept);
    }
    for (const gone of drawn.values()) void unmount(gone.block);
    drawn = next;
  });
  $effect(() => () => {
    for (const each of drawn.values()) void unmount(each.block);
    drawn = new Map();
  });
</script>

<div class="markdown" bind:this={root} {@attach copyButtons}>
  {@html html}
</div>
<span class="announce" aria-live="polite">{announced}</span>

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
  /*
   * Code is its own left-to-right isolate. A bidi control in the prose around it (U+202E,
   * which `reveal` in `markdown.ts` marks only inside code) otherwise carries on into the
   * span, and `nosj.live` after one would show as `evil.json`. Isolated, the code's
   * letters are in the order written whatever the sentence around it does.
   */
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    unicode-bidi: isolate;
    direction: ltr;
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
    color: var(--text-muted);
    font: 500 11px/16px var(--font-sans);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  /*
   * The header's deep fill only over a body. A header row alone, deep inside a solid edge,
   * is drawn the way the chat draws a committed record (`ChatItem`'s `.block`), and a GFM
   * table needs no body: `| RECORDED add_scope_entry(…) |` over `|---|` would be an agent's
   * receipt. Alone, it is a plain row in a hairline box, which no record is.
   */
  .markdown :global(table:has(tbody) th) {
    background: var(--bg-deep);
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
  /*
   * A bidi, zero-width or tag character in code, or a bidi control in prose, written out
   * as its code point (`reveal` and `proseRuns` in `markdown.ts`): smaller, faint and boxed, so it reads as a note about the text rather
   * than as part of it.
   */
  .markdown :global(.char-escape) {
    margin: 0 1px;
    padding: 0 2px;
    border: 1px solid var(--border-muted);
    border-radius: 3px;
    color: var(--text-faint);
    font-size: 0.85em;
    font-style: normal;
    letter-spacing: normal;
    text-transform: none;
    white-space: nowrap;
  }
  .announce {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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
