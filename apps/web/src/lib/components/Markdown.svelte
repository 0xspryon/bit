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
  import { renderMarkdown } from "../markdown";

  let { text }: { text: string } = $props();

  const html = $derived(renderMarkdown(text));
</script>

<div class="markdown">
  {@html html}
</div>

<style>
  /*
   * `white-space` is normal on purpose. The serialiser puts a newline between block
   * elements, and the row this replaces used `pre-wrap`; keeping that would draw each of
   * those as a blank line. Markdown's own line breaks are the paragraphs and the fences.
   */
  .markdown {
    min-width: 0;
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .markdown > :global(:first-child) {
    margin-top: 0;
  }
  .markdown > :global(:last-child) {
    margin-bottom: 0;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(blockquote),
  .markdown :global(pre),
  .markdown :global(.table-wrap) {
    margin: 0 0 0.6em;
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    margin: 1em 0 0.4em;
    color: var(--text-base);
    font-weight: 600;
    line-height: 1.35;
  }
  .markdown :global(h1) {
    font-size: 1.3em;
  }
  .markdown :global(h2) {
    font-size: 1.18em;
  }
  .markdown :global(h3) {
    font-size: 1.06em;
  }
  .markdown :global(h4),
  .markdown :global(h5),
  .markdown :global(h6) {
    font-size: 1em;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    padding-left: 1.5em;
  }
  .markdown :global(li > ul),
  .markdown :global(li > ol) {
    margin-bottom: 0;
  }
  .markdown :global(li > p) {
    margin-bottom: 0.3em;
  }
  .markdown :global(blockquote) {
    padding-left: 10px;
    border-left: 2px solid var(--border-muted);
    color: var(--text-muted);
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
    font-size: 0.95em;
  }
  /*
   * A fence is verbatim: an ASCII tree is its indentation. `pre` keeps every space and
   * line break, and the block scrolls on its own rather than wrapping a line or widening
   * the thread.
   *
   * **And it has no edge, on purpose.** In the chat a box with an edge means something: a
   * solid one is a committed record and a dashed one is narration (`ChatItem`'s `.block`,
   * and `live.ts` §9 on why that distinction must never be implied by something that does
   * not have it). A fence is the agent's prose, so it is not a record — and a fence drawn in
   * the record's box, mono at 12/20 on the deep background with a hairline border, could
   * write itself a convincing `add_scope_entry` receipt. Nor is the dashed edge right: it
   * would make a fence an *activity* block, which is a call the harness says the agent
   * made, and that is still a claim prose cannot make. So a fence claims neither: no
   * border, a tint of the text colour rather than the records' `--bg-deep`, the prose's own
   * colour rather than the records' muted one, and a smaller radius. What makes it a block
   * is the font and the tint; what would make it a record is the one thing it lacks.
   */
  .markdown :global(pre) {
    overflow-x: auto;
    padding: 8px 12px;
    border: 0;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--text-base) 6%, transparent);
    color: var(--text-base);
    font: 400 12px/20px var(--font-mono);
    white-space: pre;
    overflow-wrap: normal;
  }
  .markdown :global(pre code) {
    font-size: inherit;
  }
  /*
   * The fence's own word, as a label: there is no highlighter behind it. Lower-case and
   * mono, as the author spelled it — not the small upper-case label a record block uses for
   * its kind, which a fence tagged `RECORDED` would otherwise borrow.
   */
  .markdown :global(pre[data-language])::before {
    content: attr(data-language);
    display: block;
    margin-bottom: 2px;
    color: var(--text-faint);
    font: 400 11px/16px var(--font-mono);
  }
  /*
   * The scroller is what keeps a wide table from setting the width of the thread; see
   * `finish` in `markdown.ts`.
   */
  .markdown :global(.table-wrap) {
    max-width: 100%;
    overflow-x: auto;
  }
  .markdown :global(table) {
    border-collapse: collapse;
    font-size: 0.95em;
  }
  .markdown :global(th),
  .markdown :global(td) {
    padding: 4px 10px;
    border: 1px solid var(--border-muted);
    text-align: left;
    vertical-align: top;
    overflow-wrap: normal;
  }
  .markdown :global(th) {
    font-weight: 600;
  }
  /*
   * A host in a cell is one token. Left to wrap, a narrow column broke
   * `asset-0.subdomain.acme-corp.com` at its hyphens, and a hostname split across lines
   * reads as two. The scroller above takes the width instead.
   */
  .markdown :global(td code),
  .markdown :global(th code) {
    white-space: nowrap;
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
