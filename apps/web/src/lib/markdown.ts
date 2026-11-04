/**
 * An agent's prose as HTML: GFM tables, fenced code, lists, headings, emphasis, links.
 *
 * ## Why agent prose is untrusted here
 *
 * The scope importer's whole job is reading attacker-controlled bug-bounty program pages and
 * quoting them back. Whatever a program page says can therefore arrive in an agent's reply
 * verbatim, and this module's output is put into the page with `{@html}`
 * (`Markdown.svelte`). So the pipeline is built so that nothing in the source text can
 * become markup this module did not choose to emit.
 *
 * ## Raw HTML never becomes markup, at the parser rather than after it
 *
 * There is no `rehype-raw` and no `allowDangerousHtml` anywhere in this chain, and that is
 * the guarantee rather than a default: without them `remark-rehype` has no way to turn an
 * mdast `html` node into hast elements, so `<script>`, `<img onerror>` and `<iframe>` in
 * agent text never become elements at all. A filter that removes them after parsing is a
 * filter someone can loosen; a conversion that never produced them cannot be. T3's
 * `parseRawHtml={false}` is the same shape.
 *
 * What that conversion produces instead is the HTML **as text** ({@link htmlAsText}),
 * rather than the nothing `remark-rehype` emits by default. Dropping it would be just as
 * inert, but on this surface it would also be a lie by omission: an agent saying "the page
 * has `<form action=…>` in it" would arrive with the part that matters erased, and a block
 * starting with `<script>` takes the rest of its line with it. A text node is escaped by the
 * serialiser like any other, so showing it costs nothing in safety.
 *
 * ## `rehype-sanitize` is still needed
 *
 * Markdown makes links and images out of its own syntax, not out of HTML, so
 * `[x](javascript:alert(1))` reaches hast as a real `<a href="javascript:…">` with raw HTML
 * long gone. The default (GitHub) schema allowlists URL protocols and strips that `href`. It
 * also prefixes generated `id`s with `user-content-`, so a footnote cannot clobber a global
 * the app reads — and {@link finish} then drops them all, for a reason of its own.
 *
 * ## What runs after the sanitiser, and why it is safe there
 *
 * {@link finish} runs last, on already-sanitised hast. It only adds attributes whose values
 * are constants or are copied from attributes the sanitiser already passed, replaces an
 * image with a link to the same, already-checked URL, and otherwise only takes things away:
 * attributes, anchors, a back-reference. What it builds from the source is text: text
 * nodes, and one `aria-label` on a fence's Copy button, a plain string in a fixed
 * attribute. The serialiser escapes both like any other. Putting it before the sanitiser would
 * mean widening the schema to let its attributes through, which would let the same
 * attributes through from the source as well.
 */
import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype, {
  type Options as RemarkRehypeOptions,
} from "remark-rehype";
import { unified } from "unified";

const element = (
  tagName: string,
  properties: Element["properties"],
  children: ElementContent[],
): Element => ({ type: "element", tagName, properties, children });

const isElement = (node: RootContent | ElementContent): node is Element =>
  node.type === "element";

/**
 * An mdast `html` node as what it literally says. Inline HTML stays inline text; a block of
 * it becomes a `<pre><code>`, because a block of markup is source and reads as source —
 * and because under normal `white-space` its line breaks would otherwise collapse.
 *
 * The handler's `node` is typed `any` upstream; the only field read is `value`, a string
 * on every mdast `html` node.
 */
const BLOCK_PARENTS = new Set([
  "root",
  "blockquote",
  "listItem",
  "footnoteDefinition",
]);
const htmlAsText: NonNullable<RemarkRehypeOptions["handlers"]>["html"] = (
  _state,
  node: { readonly value: string },
  parent,
) => {
  const text: ElementContent = { type: "text", value: node.value };
  return parent === undefined || BLOCK_PARENTS.has(parent.type)
    ? element("pre", {}, [element("code", {}, [text])])
    : text;
};

/**
 * What the sanitised tree is given, and what it is relieved of, on its way out.
 *
 * Three things GitHub's own rendering also has (one of them, the frame, in its own way):
 *
 * - **A table is wrapped in a scroller.** A table's width is its widest row, which is the
 *   agent's column count and not the operator's screen; without this a quoted scope table
 *   decides the width of the whole thread on a tablet. OpenCode wraps its tables the same
 *   way.
 * - **A fence is framed, with its name and a Copy button** ({@link codeFrame}). Its
 *   language is also copied to `data-language` on the `<pre>`. There is no highlighting —
 *   that is its own slice and its own dependency weight.
 * - **A link opens elsewhere, without an opener.** The page is a working session; following
 *   a link an agent quoted should not navigate it away, and the page it opens should get
 *   neither `window.opener` nor a referrer naming this app.
 *
 * And one GitHub's renderer leaves to the reader: a quote's closing `— source` line is
 * marked as its source ({@link quoteSource}).
 *
 * And three GitHub does not do:
 *
 * - **An image becomes a link to it.** An `<img>` is fetched the moment it is rendered, so a
 *   program page that put `![](https://attacker/p.png?…)` in front of the agent would learn
 *   when, and from where, the operator read the reply. A link fetches only when clicked. An
 *   image that is already the text of a link becomes that link's text instead, because an
 *   anchor inside an anchor is not something a browser builds: it splits them, and the
 *   visible text ends up going to the image while the link the agent meant is left empty.
 * - **An in-page link is not a link.** A fragment (`#…`) is the one `href` that does not
 *   leave the page, and following one is a same-document navigation — which fires
 *   `popstate`, the event the shell reads as Back or Forward and answers by re-applying the
 *   place in the address bar. An agent's prose must not be able to move the app, and a reply
 *   that quotes a program page is a program page choosing where to send the operator. So
 *   the anchor is unwrapped to its text: a footnote reference stays a superscript number,
 *   the note stays at the foot of the same reply, and the `↩` back-reference, which says
 *   nothing once it goes nowhere, is dropped. An image whose own `src` is a fragment is
 *   text for the same reason, rather than the link to it every other image becomes.
 * - **No `id` survives.** Every one of them was a footnote's target, and with nothing left
 *   to point at them they could only collide: each reply with a `[^1]` mints the same one.
 *   `aria-describedby` goes with them, since all it named was a footnote heading's `id`.
 */
const rewrite = (node: ElementContent, inLink: boolean): ElementContent[] => {
  if (!isElement(node)) return [node];
  delete node.properties["id"];
  delete node.properties["ariaDescribedBy"];
  if (node.tagName === "img") {
    const src = node.properties["src"];
    const alt = node.properties["alt"];
    const label =
      typeof alt === "string" && alt !== ""
        ? alt
        : typeof src === "string"
          ? src
          : "image";
    const text: ElementContent = { type: "text", value: label };
    return typeof src === "string" && !inLink && !src.startsWith("#")
      ? [
          element(
            "a",
            { href: src, rel: ["noopener", "noreferrer"], target: "_blank" },
            [text],
          ),
        ]
      : [text];
  }
  if (node.tagName === "a") {
    const href = node.properties["href"];
    if (node.properties["dataFootnoteBackref"] !== undefined) return [];
    if (typeof href === "string" && href.startsWith("#")) {
      return node.children.flatMap((child) => rewrite(child, inLink));
    }
    if (typeof href === "string") {
      node.properties["rel"] = ["noopener", "noreferrer"];
      node.properties["target"] = "_blank";
    }
    node.children = node.children.flatMap((child) => rewrite(child, true));
    return [node];
  }
  node.children = node.children.flatMap((child) => rewrite(child, inLink));
  if (node.tagName === "code") node.children = node.children.flatMap(reveal);
  if (node.tagName === "table") {
    return [element("div", { className: ["table-wrap"] }, [node])];
  }
  if (node.tagName === "blockquote") quoteSource(node);
  if (node.tagName === "li") taskText(node);
  if (node.tagName === "pre") return [codeFrame(node)];
  return [node];
};

/**
 * Characters that change how code reads without showing as anything, shown as what they
 * are: `⟨U+202E⟩`, in a `<span class="char-escape">`.
 *
 * A bidi control (U+202A–202E, U+2066–2069) reorders the letters around it on screen and
 * not in the text, so a fence named `\u202Enosj.live` reads as `evil.json` and copies as
 * something else; a zero-width one (U+200B–200F, U+2060, U+FEFF) puts a character into a
 * host the eye cannot see. In code, and in a fence's name, the exact characters are the
 * point, so each is replaced by its code point. Prose is left alone: there, these are how
 * right-to-left text and joined scripts are written.
 *
 * The marker is a text node in an element with a constant class, built here after the
 * sanitiser like the rest of the frame. The sanitiser lets no `class` through from the
 * source but a fence's language and the task list's and footnotes' own, so a
 * `.char-escape` is only ever this one, and the agent's own `⟨U+202E⟩` stays plain text.
 * That is what lets `Markdown.svelte`'s Copy put the original character back: the button
 * copies the code as the agent wrote it.
 */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const hiddenName = (char: string): string =>
  `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
const reveal = (node: ElementContent): ElementContent[] => {
  if (isElement(node)) {
    node.children = node.children.flatMap(reveal);
    return [node];
  }
  if (node.type !== "text" || !HIDDEN.test(node.value)) return [node];
  return [...node.value].flatMap((char): ElementContent[] =>
    HIDDEN.test(char)
      ? [
          element("span", { className: ["char-escape"] }, [
            { type: "text", value: hiddenName(char) },
          ]),
        ]
      : [{ type: "text", value: char }],
  );
};
/** The same, as plain text, for an attribute: an `aria-label` cannot hold a span. */
const revealText = (text: string): string =>
  text.replace(new RegExp(HIDDEN.source, "gu"), hiddenName);

/**
 * A fence, framed as A6 D8 draws it: a header naming it, a **Copy** button, then the block.
 *
 * The header's name is the fence's info string after the language — ` ```json entry-10.json `
 * is named `entry-10.json` — or the language alone when that is all there is (` ```js ` is
 * `js`), or nothing. The words after the language are `meta` on the `<code>`'s `data`,
 * which `remark-rehype` puts there and the sanitiser carries over untouched because `data`
 * is never serialised; it is read here as a string and becomes a **text node**, escaped by
 * the serialiser like any other, so an info string of `"><script>` is a name, not markup.
 * The language is copied from the `class="language-x"` the sanitiser passed, as before.
 *
 * Every element of the frame is built here, after the sanitiser, from constants: the
 * classes, `type="button"`, and the button's word. Nothing in the schema is widened for it.
 * One attribute carries source text: the button's `aria-label`, `Copy <name>` (or `Copy
 * code`), so a screen reader can tell one fence's button from the next. It is a string the
 * serialiser escapes as an attribute value, and the name in it has its hidden characters
 * written out ({@link reveal}) as the visible label does. The button has no handler in the
 * markup — `Markdown.svelte` listens on its own root for a click on a `.code-copy` and copies the
 * text of the `<pre>` in the same frame, so there is no script in the HTML to inject into.
 *
 * Every fence gets the header, even one with nothing to name. A6 D8 draws a long unbroken
 * line in a headerless, hairline-edged box, but that box is exactly the chat's committed
 * record (`ChatItem`'s `.block`: the same edge, background, mono 12/20 and muted ink), and a
 * fence is the agent's prose: without the header an agent could draw itself a receipt. The
 * header with its Copy button is the one thing a record never has.
 */
const codeFrame = (pre: Element): Element => {
  const code = pre.children.find(isElement);
  const language = (
    Array.isArray(code?.properties["className"])
      ? code.properties["className"]
      : []
  )
    .map(String)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
  if (language !== undefined) pre.properties["dataLanguage"] = language;
  const meta: unknown =
    code?.data !== undefined && "meta" in code.data
      ? code.data.meta
      : undefined;
  const label =
    typeof meta === "string" && meta.trim() !== ""
      ? meta.trim()
      : (language ?? "");
  return element("div", { className: ["code-frame"] }, [
    element("div", { className: ["code-head"] }, [
      element(
        "span",
        { className: ["code-label"] },
        reveal({ type: "text", value: label }),
      ),
      element(
        "button",
        {
          type: "button",
          className: ["code-copy"],
          ariaLabel: label === "" ? "Copy code" : `Copy ${revealText(label)}`,
        },
        [{ type: "text", value: "Copy" }],
      ),
    ]),
    pre,
  ]);
};

/**
 * A task item's own words, after its checkbox, in a `<span class="task-text">`: what a done
 * item's strike-through is drawn on, so it stops before a list nested under the item.
 *
 * In a tight list the checkbox is the item's first child; in a loose one it opens the
 * item's first paragraph. The words run from the checkbox to the first block element.
 * Only nodes the sanitiser passed are moved, into an element with a constant class.
 */
const BLOCKS = new Set(["ul", "ol", "p", "pre", "div", "blockquote", "table"]);
const taskText = (item: Element): void => {
  const holder = item.children.find(isElement);
  const host = holder?.tagName === "p" ? holder : item;
  const box = host.children.findIndex(
    (child) => isElement(child) && child.tagName === "input",
  );
  if (box === -1) return;
  let end = box + 1;
  while (end < host.children.length) {
    const next = host.children[end];
    if (next !== undefined && isElement(next) && BLOCKS.has(next.tagName)) {
      break;
    }
    end += 1;
  }
  const words = host.children.slice(box + 1, end);
  // The space GFM leaves after `[x]`: the box's own margin is the gap D8 draws.
  const lead = words[0];
  if (lead?.type === "text") lead.value = lead.value.trimStart();
  if (words.length === 0) return;
  host.children.splice(
    box + 1,
    words.length,
    element("span", { className: ["task-text"] }, words),
  );
};

/**
 * A quote's last line is the line it came from, when the agent writes it as one: a line
 * starting with an em dash, after the quoted text.
 *
 * ```md
 * > "Testing is permitted against any Acme-owned property except WordPress properties."
 * > — hackerone.com/acme/policy · line 219
 * ```
 *
 * That is how prose attributes a quotation anyway, so it needs no new syntax and reads
 * correctly anywhere the markdown is shown raw. Written on its own line (no blank line
 * before it) it is part of the quote's last paragraph, after a soft break; after a blank
 * line it is a paragraph of its own. Either way it is split off into a `<p
 * class="quote-source">` and the dash is dropped, since the line's own style now says what
 * the dash said. A quote that is *only* such a line is left alone: there is nothing for it
 * to be the source of. So is a dash line with any more of the quote after it, soft break or
 * hard: a source is where a quote ends, and a dash line mid-quote is the quote's own text.
 *
 * It only moves nodes the sanitiser already passed and splits one text node; the class is
 * a constant.
 */
const SOURCE_DASH = /\n\s*—\s*/;
/** A line break anywhere in a node: a soft one in its text, or a hard `<br>`. */
const breaks = (node: ElementContent): boolean =>
  node.type === "text"
    ? node.value.includes("\n")
    : isElement(node) && (node.tagName === "br" || node.children.some(breaks));
const quoteSource = (quote: Element): void => {
  const blocks = quote.children.filter(isElement);
  const last = blocks.at(-1);
  if (last?.tagName !== "p") return;
  const first = last.children[0];
  if (
    blocks.length > 1 &&
    first?.type === "text" &&
    /^\s*—/.test(first.value) &&
    !last.children.some(breaks)
  ) {
    first.value = first.value.replace(/^\s*—\s*/, "");
    last.properties["className"] = ["quote-source"];
    return;
  }
  // A soft break, then the dash: the last text node holding one is where the quote ends.
  const at = last.children.findLastIndex(
    (child) => child.type === "text" && SOURCE_DASH.test(child.value),
  );
  const split = last.children[at];
  if (split?.type !== "text") return;
  const match = [
    ...split.value.matchAll(new RegExp(SOURCE_DASH.source, "g")),
  ].at(-1);
  if (match === undefined) return;
  const before = split.value.slice(0, match.index);
  const after = split.value.slice(match.index + match[0].length);
  // Only the quote's last line: a dash line with more of the quote under it is quoted text.
  if (after.includes("\n") || last.children.slice(at + 1).some(breaks)) {
    return;
  }
  const quoted = [
    ...last.children.slice(0, at),
    ...(before === "" ? [] : [{ type: "text" as const, value: before }]),
  ];
  if (quoted.every(textless)) return;
  const source = [
    ...(after === "" ? [] : [{ type: "text" as const, value: after }]),
    ...last.children.slice(at + 1),
  ];
  last.children = quoted;
  quote.children.splice(
    quote.children.indexOf(last) + 1,
    0,
    { type: "text", value: "\n" },
    element("p", { className: ["quote-source"] }, source),
  );
};

/**
 * Text that renders to nothing is shown as the text it is.
 *
 * Markdown has two constructs that are pure bookkeeping: a link definition (`[x]: https://…`)
 * and a footnote nobody references. A reply that is only one of those is not blank — every
 * caller's `trim() !== ""` passes it — but it renders to an empty element, and the row
 * around it is then drawn with nothing in it except, possibly, the turn's footer, which
 * would read as a footer to the reply above. Guarding it here, in the one place every
 * renderer of agent prose passes through, is cheaper and harder to forget than teaching
 * each row and `lastProse` about it. Showing the source rather than dropping the row is the
 * honest answer: the agent did say it.
 *
 * A paragraph or heading with no text in it counts as nothing too: it draws nothing, and
 * {@link rewrite} makes one whenever a line is only a fragment link with no text, such as
 * `[](#x)`. That is a narrower test than "no visible text", on purpose. A rule, a list's
 * markers, a quote's bar, a table's borders and a code block's box are all drawn without a
 * character of text, and a reply that is only `---` is a rule, not the string `---`.
 */
const TEXT_ONLY = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);
const textless = (node: RootContent | ElementContent): boolean =>
  node.type === "text"
    ? node.value.trim() === ""
    : isElement(node) && node.children.every(textless);
const blank = (tree: Root): boolean =>
  tree.children.every((node) =>
    node.type === "text"
      ? node.value.trim() === ""
      : isElement(node) && TEXT_ONLY.has(node.tagName) && textless(node),
  );

const finish = () => (tree: Root, file: { readonly value: unknown }) => {
  tree.children = tree.children.flatMap((node): RootContent[] =>
    node.type === "doctype" ? [node] : rewrite(node, false),
  );
  if (blank(tree)) {
    tree.children = [
      element("p", {}, [{ type: "text", value: String(file.value) }]),
    ];
  }
};

/**
 * Built once: a frozen processor is reused for every message, and every plugin in it is
 * synchronous, which is what lets {@link renderMarkdown} use `processSync`.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, {
    handlers: { html: htmlAsText },
    // The sanitiser prefixes every `id` with `user-content-` itself, so `remark-rehype`'s
    // own prefix would only double it, and a footnote's `id` would stop matching its `href`.
    // `finish` drops both today; this keeps the pair consistent if that ever changes.
    clobberPrefix: "",
  })
  .use(rehypeSanitize)
  .use(finish)
  .use(rehypeStringify)
  .freeze();

/**
 * A string-to-string function, remembered by its argument for the last `capacity` calls.
 *
 * Least-recently-used, on a `Map`'s insertion order: a hit is moved to the back, and the
 * front is the one to evict. Exported so the bound and the hit can be tested against a
 * counting stand-in rather than inferred from timing.
 */
export const memoiseByText = (
  render: (text: string) => string,
  capacity: number,
): ((text: string) => string) => {
  const kept = new Map<string, string>();
  return (text) => {
    const hit = kept.get(text);
    if (hit !== undefined) {
      kept.delete(text);
      kept.set(text, hit);
      return hit;
    }
    const html = render(text);
    kept.set(text, html);
    if (kept.size > capacity) {
      const oldest = kept.keys().next();
      if (oldest.done !== true) kept.delete(oldest.value);
    }
    return html;
  };
};

/**
 * How many rendered replies are remembered.
 *
 * Enough to hold every reply the live panel can have on screen at once — `App.LIVE_KEPT`
 * is 500 items, and a reply is at most one of them — with the replayed history beside it.
 * A miss on every recompute is what the cache exists to prevent, and an LRU smaller than
 * the set it is scanned over misses on every entry.
 *
 * **The bound is a count of entries, not bytes**, and nothing caps an entry. Live narration
 * is cut at 4,000 characters (`NARRATION_FIELD_MAX`), but a replayed message is not cut at
 * all, and a replay is up to 400 of them (`IMPORTER_HISTORY_READ_LIMIT`). The HTML can also
 * be longer than its source: the serialiser writes `&` and `<` as six-character
 * references. So a few megabytes is the typical full cache, not the worst one; the worst is
 * 512 of the longest replies seen, at up to six times their length.
 *
 * It stays a count because the count is what the cache has to cover. A byte budget small
 * enough to matter would be smaller than one long replay, and an LRU smaller than what it
 * is scanned over evicts every entry before it is asked for again — so a long history would
 * be re-parsed on every frame, which is the cost this exists to remove, and it would hold
 * the memory anyway, in the page's own copy of those messages and in the DOM drawn from
 * them. What a count does leave is up to 512 replies from a view already closed, kept until
 * newer ones push them out.
 */
const RENDERS_KEPT = 512;

/**
 * Agent prose as sanitised HTML, for `{@html}`.
 *
 * Pure and DOM-free — parsing and serialising are both string-to-tree-to-string — so it
 * renders the same in server-rendered markup tests, under happy-dom and in the browser.
 *
 * **Remembered by text**, because it is called far more often than the text changes.
 * `Markdown.svelte` derives from it, and the rows above it are rebuilt on every frame of
 * live activity on the target — a planner's or a goal agent's included — so without this
 * every reply on screen was re-parsed for an event that had nothing to do with it (30
 * replies of 3.9 KB measured ~140 ms per event). A reply arrives whole rather than token by
 * token, so the same text is asked for again and again and a plain cache is enough. Being
 * pure is what makes caching it correct.
 */
export const renderMarkdown = memoiseByText(
  (text) => String(processor.processSync(text)),
  RENDERS_KEPT,
);
