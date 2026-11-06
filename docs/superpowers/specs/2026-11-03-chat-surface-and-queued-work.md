# The chat surface, and the work queued behind it

> **2026-11-06:** the pre-execution policy gate this document mentions was removed at the
> operator's request, to be redone later. See the "Policy gate removed" entry in
> `docs/superpowers/plans/2026-11-03-a6-chat-revamp-breakdown.md`; the last commit with the
> gate is `635c1fc`.

**Status:** backlog plus research findings. Items S1–S5 approved by the operator on
2026-11-03; S6–S8 are recorded, not yet designed.
**Date:** 2026-11-03

## Why this file exists

The operator compared bit's importer chat against OpenCode's and T3 Code's chat views and
asked why a reloaded conversation reads as one undifferentiated block while a live one
reads as a thread. The answer turned into a survey of both codebases, and the survey turned
into a queue of work. This file holds both so neither depends on a chat session surviving.

## What is actually wrong, in one paragraph

A conversation reaches the browser two ways and they carry different amounts of
information. The live path carries `LiveItem` — a normalised struct with `kind`, `callId`,
`input`, `output`, `outcome`, `origin`, `tool` and `toolName`. The replay path carries
`MessageEntry` (`apps/server/src/harness/agentHarness.ts:219`), which is
`{ type, text, error }` and nothing else, because both drivers' `flatten` discards
everything that is not a text block: `openCodeClient.ts:659` keeps only
`part.type === "text"`, and `claudeCodeClient.ts:886` does the same. On top of that, neither
path renders markdown — the only text transform in the web app is `splitCode`
(`apps/web/src/lib/chat.ts:411`), which matches single-backtick spans containing no newline.
So a table arrives as literal pipes, a fenced block arrives as literal backticks, and an
ASCII tree collapses because the text is placed in one `<p>`.

The structure is not missing from the harnesses. OpenCode's stored `AssistantTool` part
carries `id`, `name`, and a `state` union of `streaming | running | completed | error`
holding `input`, `content` and `error`, with the call and its result already paired in one
part. Claude Code's stored transcript carries `tool_use` and `tool_result` content blocks,
and `claudeCodeClient.ts:770` (`narrationOf`) already walks exactly those blocks into
`NarrationDetail` for the live stream. On that driver the rich mapper exists and is pointed
at the wrong source.

## Research findings

### OpenCode's GUI chat

`packages/app` (SolidJS) rendering `@opencode/session-ui`. Four dispatch levels:

1. **Message type** (`packages/schema/src/session-message.ts:304`), 11 tags:
   `agent-switched`, `model-switched`, `location-switched`, `user`, `synthetic`, `system`,
   `skill`, `shell`, `assistant`, `compaction`, `idle`.
2. **Timeline row** (`session-ui/src/timeline/timeline-row.ts:101`), 12 tags. This is a
   _projection_: a pure function turns messages into rows before anything renders.
   `TurnGap`, `Activity` (renders nothing), `UserMessage`, `Shell`, `Notice`, `TurnDivider`,
   `CompactionQueued`, `AssistantPart`, `Thinking`, `TurnDiff`, `Retry`, `Error`.
3. **Assistant content** (`session-message.ts:203`), and it is short: `text`, `reasoning`,
   `tool`. That is all. No `file`, `patch`, `todo`, `step-start` or `snapshot` — snapshots
   are a field on the message, patches and todos are _tools_, attachments are `User.files`.
4. **Tool group type** (`timeline-row.ts:8`): `context`, `read`, `file`, `part`.

Grouping of consecutive tool calls into the "N tools used" header is decided in
`projection.ts:978` (`groupContent`), not in a component: it walks a turn's contents, asks
for a group type per item, and flushes when the type changes.

Fourteen per-tool renderers in a `ToolRegistry` (`tool-renderer.tsx:1163`): `read`, `list`,
`glob`, `grep`, `webfetch`, `websearch`, `subagent`, `execute`, `shell`, `edit`, `write`,
`patch`, `question`, `skill`. Everything else falls to `GenericTool`.

Markdown is `marked` v18 in a web worker, output sanitised by DOMPurify, GFM on by default
(so tables, strikethrough, autolinks and task lists work), fenced code handed to
`@pierre/highlights`. Tables are post-processed in the DOM: `wrapTables`
(`markdown.tsx:338`) wraps each `<table>` in a div carrying `overflow-x: auto`.

No role label above assistant prose. Agent name, model and duration sit in a **footer**,
rendered only on the turn's last text part.

The scroller is full-bleed with `scrollbar-width: none`; the visible bar is a custom
absolutely-positioned thumb pinned to the panel's right edge. The reading cap is applied
**per row, inside the scroller**: `md:max-w-session md:mx-auto`, where `--container-session`
is 744px.

### T3 Code's chat

One normalised type, `OrchestrationV2TurnItem`
(`packages/contracts/src/orchestrationV2.ts:1338`), a closed union of 25 members
discriminated on `type`, each spreading a shared base of `id, threadId, runId,
providerThreadId, providerTurnId, nativeItemRef, ordinal, status, title, startedAt,
completedAt` plus optional `toolSurface / toolIcon / toolSource`.

**Adapters are server-side, one per provider, and the UI never branches on provider.** Ten
of them, each emitting `{ type: "turn_item.updated", driver, turnItem }` already normalised
(`packages/provider-core/src/server/ProviderAdapter.ts:118`).

**It persists the normalised parts** — `orchestration_v2_projection_turn_items`, with `type`
and `status` promoted out for indexing and the rest in `payload_json`. The raw provider
payload is not stored; only a `nativeItemRef` of `{ driver, nativeId, strength, fingerprint? }`.

**Reload and live match because of that persistence**, not because of the renderer: the
client applies live events into the same projection object it fetched on reload
(`client-runtime/src/state/orchestrationV2Projection.ts:213`). Streaming is a `streaming`
boolean plus `status` _on the part_, not a second pipeline.

**Tool vocabularies across providers are reconciled at the adapter, not in the renderer.**
There is no component registry keyed by tool name. Claude's adapter normalises the name
(`ClaudeAdapterV2.ts:2220`: lowercase, strip `[\s_-]`) and classifies it into the closed
union — `Bash` → `command_execution`, `MultiEdit` → `file_change`, `WebSearch` →
`web_search` — with **unknown names landing on `dynamic_tool`** as the escape hatch. ACP maps
its own `kind` enum; Codex ships typed items already.

Two details worth lifting verbatim:

- `resolveT3McpToolName` (`packages/shared/src/t3McpToolPresentation.ts:349`) handles every
  MCP prefix spelling seen in the wild: `mcp__t3-code__x`, `t3-code.x`, colon, slash, dash,
  space, and OpenCode 2's per-thread `t3-code-<threadId>_<tool>` resolved by longest known
  tool name that ends the label. bit's `mcpToolName.ts` covers two of these.
- `toolNameToken` (`packages/shared/src/toolActivity.ts:246`) refuses a token to any
  MCP-qualified name, so `mcp__foo__read` can never be styled as a file read.

**Forward compatibility** is solved at the codec, not with an open string
(`packages/contracts/src/baseSchemas.ts:151-237`): `UnknownUnionMember` is a class so only
the codec can mint one; `ForwardCompatibleUnion(members, tag)` appends a member matching
tags this build does not know; `ForwardCompatibleUnionArray` filters them out of the decoded
array. It is deliberately not a blanket catch — a _known_ tag with a malformed payload still
fails loudly. The stream-level variant (`orchestrationV2.ts:3281`) lets a stale tab decode an
unknown event, **advance its resume cursor**, and skip it rather than wedge the subscription.

Markdown is `react-markdown` over plain `unified`: `remark-gfm` plus six normalisation
plugins, then `rehype-raw` → `rehype-sanitize` with a tightened schema. Raw HTML is parsed
then sanitised; a `parseRawHtml={false}` mode drops `rehypeRaw` and leaves HTML literal.
Highlighting is Shiki pinned to the **Oniguruma WASM engine**, with the reason in a comment:
the JS regex engine "can backtrack catastrophically and hang the tokenizing thread."

## What bit already has

Worth stating, because it is more than it looked like.

- `LiveItem` is already a normalised model with the fields a renderer needs.
- `tool` and `toolName` are **separate fields**, where `toolName` has this application's MCP
  namespacing stripped **server-side** (`packages/contracts/src/live.ts`, `mcpToolName.ts`).
  That is the cross-harness tool identity T3 solves with `resolveT3McpToolName`.
- `WRITE_SUMMARY_FIELDS` (`apps/web/src/lib/chat.ts:322`) is a per-tool registry keyed on
  `toolName` already, with four entries.
- `rowsFor` / `ChatGroup` (`chat.ts`) is a projection layer in embryo: it folds a `tool.call`
  into the record it produced and pairs results by `callId`.
- `ChatItem.svelte` already renders a `LiveItem` in two arrangements (ledger and `narrated`).

## What bit deliberately does differently, and keeps

**`LiveItem` is one struct with an open `kind: Schema.String`, not a closed union.**
`live.ts:290` argues for it: a union "would make every unknown kind undecodable", and a
browser one deploy behind must render an unknown item rather than fail to decode the frame
it arrived in. OpenCode's `<Switch>` with no fallback is the opposite choice. Keep bit's.

**bit persists no conversation prose.** `DECISIONS.md` §8, `FIX — conversation history is the
harness's, and we do not keep a copy`, decided 2026-11-02. So normalisation happens **on
read**, in the two `flatten`s, and not at storage the way T3's does. Live/replay parity does
not require persistence — it requires both paths to produce the same type. What persistence
would additionally buy is a conversation that outlives Claude Code's sweep, which §8
declines on purpose.

Note the tension and leave it recorded rather than resolved: §8 also holds
`COPY — AppThread / ProviderThread separation`, quoting T3's "the canonical durable row is
the normalized V2 event". On the conversation surface those two entries pull against each
other. The renderer work does not need the question settled.

---

## The queue

Ordered so that nothing is built twice. S1–S3 are layout and labelling; S4 is text
rendering; S5 is self-contained; S6 is the architectural one and wants its own design
document before any code; S7–S8 are unscoped.

### S1 — the scrollbar reaches the window edge — **done, 2026-11-03**

The scrolling element _was_ the reading column, so its bar was drawn at the text edge. The
chain is `.importer` (`padding: 0 32px`) → `.chat.thread`
(`width: 100%; max-width: 800px; margin: 0 auto`) → `.thread .groups` (the `overflow-y: auto`
element). `PageFrame` is **not** in it, as this document first claimed: `Target.svelte:88`
renders `AutoLoad` outside `PageFrame`.

`.thread` now spans the page and the log scrolls across all of it. **The column is drawn,
not boxed**: padding inside the `<ol>` draws it there, and a width on every non-scrolling
sibling draws it for them, with `--column` and `--gutter` shared so the two calculations
cannot disagree. `.importer`'s side margin moved onto those, because padding on any ancestor
of the log would put the bar 32px in from the edge it is meant to be on.

This document originally asked for an 800px wrapper _inside_ the scroller. That was wrong
and was declined during implementation: a wrapper splits the element `bind:this={list}`
points at from the `role="log"` region, leaving the region one level below the rows it
announces. Padding keeps the `<ol>` as both, so the pinning logic and the `.groups.hollow`
rule needed no change.

Native scrollbar kept. OpenCode's edge-hugging bar is a custom thumb over a
`scrollbar-width: none` scroller; that is a separate and larger piece of work, and the
geometry is the part the operator asked for.

**Accepted cost.** Where the browser draws a classic scrollbar, the bar takes its width out
of the log's content box, so the column's right edge falls ~15px short of the composer's
while the left edges stay exact. CSS cannot measure the bar, so the only symmetric
alternative is `scrollbar-gutter: stable both-edges`, which narrows the column by 30px
instead. Tablets use overlay scrollbars and show no gap. Documented in the source.

**Found during review, not caused by it:** `.thread.idle .groups { display: none }` takes
the live region out of the accessibility tree in the empty state, so the region and its first
row reappear together — the exact case the `.groups.hollow` comment exists to prevent. Its
own item, below.

### S1a — the idle thread hides its live region

`.thread.idle .groups { display: none }` (`Chat.svelte`, from `db65874`) contradicts the
reasoning at the `.groups.hollow` rule, which collapses the list rather than unmounting it
precisely so a live region is never added to the DOM at the same moment as its first child.
In the thread layout `hollow` is true exactly when `idle` is. Unscoped; fix is probably to
collapse the idle list the way `hollow` does rather than to remove it.

### S2 — no active style on the compose box while typing — **done, 2026-11-03**

`ImporterChat.svelte` lit the textarea on focus with `outline: 2px` at `outline-offset: 4px`,
which — against `.box`'s 14px padding — drew a bright rectangle floating inside the box. On a
text field `:focus-visible` matches on click as well as on keyboard focus, so it stayed lit
for the whole time someone was typing.

Removed with no replacement: the caret is the indicator for a text field, the box keeps its
own border, and OpenCode and T3 both do this. **This overrides an earlier draft of this
section, which said to keep a ring for keyboard users.** It is a small accessibility trade,
taken deliberately and recorded here so it can be reversed by choice rather than by accident.
The buttons around the composer — `.stop`, `.send`, `.icon-btn`, `.starter` — keep theirs,
because removing a button's indicator does strip keyboard navigation.

The rule had to become `outline: none` rather than be deleted: `styles/tokens.css:183` sets
`:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px }` for every
element, so deleting the component rule would have left a ring 2px closer to the text.
`Welcome.svelte`, `CrumbPicker.svelte` and `Modal.svelte` already switch it off the same way.

**Left inconsistent on purpose, for the operator to settle.** `ComposeBox.svelte:343` — the
run composer on Target, a different component on a different screen — still lights its whole
box on `:focus-within`, with a comment arguing for it. Only the importer's was complained
about, so only the importer's changed.

### S3 — the assistant's prose loses its labels — **done, 2026-11-03**

Both labels gone. The agent header — avatar, `Importer`, model — is deleted from
`ImporterChat.svelte`'s `separator`, so a turn is the operator's right-aligned bubble and
then unlabelled left-aligned prose, which is the whole of OpenCode's arrangement. The
`replay-type` label is dropped **only in the thread layout and only for
`type === "assistant"`**: the panel layout keeps every label, and `shell`, `synthetic`,
`idle` and any word this build has never seen keep theirs, so a command's output cannot read
as the agent speaking.

A footer carrying the model sits inside the turn's last prose row — inside the `<li>`,
because a `<p>` between list items is invalid and a separate `<li>` would read as a row. It
is thread-layout only, and absent while the turn is still working.

**No duration, deliberately.** Replayed turns carry no time at all; on a live turn the
operator's message time comes from the browser's clock and the replies' from the server's;
and a turn's end is known only from a poll that also stops on any failure to answer.
OpenCode's `2m 27s` is two times from one clock, and there is no such pair here. Inventing
one was the alternative and it was refused.

**The 27px indent is deleted**, not re-anchored: prose now starts on the column's left edge,
the same pixel as the composer, with 8px under the operator's bubble so a reply does not sit
tighter to the question than turns sit to each other.

The working-state announcement moved from the deleted header to the turn's tail, beside the
streaming cursor, with the same `{#if working}` lifetime as before.

**Carried forward from review, not fixed here:**

- An `assistant` entry with empty text and no error would render as a 0px-high `<li>` plus
  an 8px gap, where before the label made it visible. **Not reachable through the server** —
  `import/importerHistory.ts:487` drops entries with neither text nor error and counts them
  into `omittedBlank`, and `plan/goalNarration.ts` does the same. Defensive guard folded into
  S4.
- `StreamCursor.svelte:11-12` still says the cursor's meaning is said in "the importer's
  heading". That heading is gone; the sentence is in the turn's tail now.
- `Chat.svelte`'s layout doc lists how `thread` differs from `panel` and no longer mentions
  the replay label or the footer.
- `ImporterConversationMessage.type`'s doc comment (`packages/contracts/src/scopeImport.ts`)
  lists only "`user`, `assistant`", which undersells what OpenCode sends.
- The footer is inside `role="log"`, so finishing a turn now announces "Model: …". Arguably a
  useful done-cue; nobody chose it on purpose.
- Two added tests claim more than they check: one named for a live reply beating the replayed
  copy has no replayed entries in its fixture, and one named "has the cursor" asserts a
  `pending` chip.

### S3 (original brief)

Two labels, two places:

- `Importer` + the model + the avatar letter — `ImporterChat.svelte`'s `separator` snippet.
- The uppercase `ASSISTANT` — `Chat.svelte:267`,
  `<span class="replay-type mono">{message.type}</span>`, which is the harness's own raw word
  passed through unmapped.

Drop both. Move the model, and the duration where one is known, into a footer under the
turn's last prose row, as OpenCode does. Watch
`Chat.svelte:568` — `.thread .group > :not(.sep) { margin-left: 27px }` indents everything
under the agent header past the avatar, and with the header gone that indent has no anchor.

### S4 — markdown in a text part — **done, 2026-11-03** (review pending at time of writing)

`apps/web/src/lib/markdown.ts` exposes `renderMarkdown(text)`: unified → `remark-parse` →
`remark-gfm` → `remark-rehype` → `rehype-sanitize` (default GitHub schema) → a `finish` step →
`rehype-stringify`. It needs no DOM, so markup tests, happy-dom and the browser all agree.
`components/Markdown.svelte` is the single renderer both the live row (`ChatItem.svelte`) and
the replayed row (`Chat.svelte`) use. `splitCode` is deleted.

Dependencies, pinned exact: `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`,
`remark-rehype@11.1.2`, `rehype-sanitize@6.0.0`, `rehype-stringify@10.0.1`, and
`@types/hast@3.0.5` as a dev dependency because the isolated install layout does not expose
hast's types to `apps/web` otherwise.

**No syntax highlighting**, by scope. A fence gets `data-language` and a small label.

**Two decisions taken during implementation that went past the brief, both kept:**

- **Raw HTML is escaped and shown as text, not dropped.** Dropping is equally safe and was
  what the brief asked for, but it hides information on a surface whose whole job is quoting
  program pages: an agent quoting `<form action=…>` would have it silently erased, and
  because CommonMark treats a line opening with `<script>` as an HTML block, the rest of that
  line would go too. Inline HTML renders as text; a block renders in `<pre><code>`. Neither
  becomes an element.
- **Images render as links, not images.** An `<img>` fetches on render, so a program page
  that got `![](https://attacker/p.png)` into a reply would tell its author when and from
  where the operator read it. The brief did not consider this.

**`clobberPrefix: ""` on remark-rehype**, because otherwise both it and the sanitiser add
`user-content-` and footnote ids come out doubled with links pointing nowhere. The sanitiser
remains the only thing adding the prefix; in-page fragment links are rewritten to match.

**Open for the operator — single line breaks.** Standard markdown: a lone newline becomes a
space. Agent prose with manual line breaks (a list of hosts, an unfenced ASCII tree) now
collapses where `pre-wrap` styling used to preserve it. A fenced block is unaffected, which
covers the case that prompted this slice. T3 Code ships both behaviours via a `remark-breaks`
variant; OpenCode collapses, as this does. Decide whether a chat surface wants the other one.

**Known costs:** the built chunk `nodes/2` grew past Vite's 500 kB warning to 655.8 kB
(192 kB gzipped), of which the pipeline is about 205 kB (61 kB gzipped). This is a
locally-served operator tool. A fenced block in a reply currently uses the same dark bordered
box as a tool-call block, told apart only by the language label — worth a design look.

`mockImporter.ts` gained a scope table and an ASCII tree so the state picker can show
markdown; that fixture change was kept.

### S4a — what the markdown review found, and what was done — **done, 2026-11-03**

The sanitiser argument was attacked with about eighty probes — `javascript:` in six spellings,
the `<math><mglyph><style>` mXSS chain, `<svg><animate onbegin>`, `srcdoc`, reference
definitions pointing at script URLs — and nothing escaped. Worth recording one detail: the
`data-language` attribute is safe because the **serialiser** escapes it, not because the
sanitiser checks it — the sanitiser only verifies the class begins with `language-`. That
guarantee would disappear silently if the stringify step were ever swapped.

The real findings were elsewhere.

**Fragment links could throw the operator out of the importer.** Clicking any `#` link in
agent prose — a footnote reference, or `[x](#y)` an agent was talked into writing — fired
`popstate`, which `routes/[...place]/+page.svelte` treats as Back/Forward and answers by
re-applying the place: the importer closes, `stopWatchingImport()` runs, and `importer.begin()`
clears the composer draft. Fragment links are now **inert**: replaced by their text, footnote
references render as plain superscripts with the note still below, and every `id` and
`aria-describedby` is stripped — which also fixes `[^1]` minting the same
`id="user-content-fn-1"` in every reply, so a later footnote link jumped to an earlier reply's
note. Namespacing ids per render was the alternative and was refused: it fixes the collision
but not the route change, and per-render ids fight the text-keyed cache.

**A code fence was indistinguishable from a committed record.** Same background, same solid
1px border, same radius, padding and mono font — differing only in text colour and an optional
language label the fence's own author chooses. The footnote under the composer tells the
operator that a solid edge means committed and a dashed edge means narration, and `live.ts`
argues that distinction is load-bearing. Agent prose could draw itself as a receipt. Fences
now have no border, a 6% tint of the text colour, prose colour, a 4px radius and a lower-case
label: a solid edge would claim "record", a dashed one would claim "activity", and prose may
claim neither.

**Markdown silently alters quoted scope text.** `*.acme.com` renders as italic `.acme.com` —
a subtree reading as a single host. Also `__init__` → bold, `\*` losing its backslash, a
`` `a|b` `` splitting a table cell, a ragged row dropping its extra cell. The durable scope
entries are tool-call records and are unaffected; this is the prose the operator checks them
against. Emphasis was **not** disabled wholesale. Instead: code spans in table cells get
`white-space: nowrap` (hostnames were breaking at hyphens), and `import/importerPrompt.ts`
now tells the importer that its replies are shown as markdown and to put every host, wildcard
and scope value in backticks.

Also fixed: every live event re-parsed every reply on screen (~140 ms for 30 replies on one
unrelated event) — `renderMarkdown` is now behind a bounded 512-entry LRU keyed on the text,
sized against `LIVE_KEPT = 500`; an image inside a link produced nested anchors that the
browser split, sending the visible text to the image URL; and a reply that renders to nothing
(a bare link definition, an unreferenced footnote) now falls back to its escaped source
rather than drawing an invisible row.

**Left undone, deliberately.** The `popstate` handler was not guarded. A guard needs either a
remembered last address — a second writer of address state, which that file's one-way rule
exists to prevent — or a comparison against the derived place, which is wrong while a place
is still being applied. Agent prose can no longer reach the handler, so the exposure is
closed from this side.

### S4b — the routing doc rests on a false premise

`routes/[...place]/+page.svelte` states the browser fires `popstate` "for a traversal and for
nothing else". That is **false for fragment navigation**, including Back and Forward between
`#` entries the operator types into the address bar. S4a closed the agent-prose path into it,
but the premise is still wrong and the handler still over-fires. Belongs with
`2026-11-03-url-routing-design.md`, not here.

### S4 (original brief)

Tables, fenced code blocks, lists, headings, emphasis. Applies to **both** the live prose
row (`ChatItem.svelte:146`) and the replayed row (`Chat.svelte:271`), which today does not
even run `splitCode`.

Constraints:

- **Raw HTML off at the parser**, not sanitised after. The importer's whole job is reading
  attacker-controlled program pages and quoting them back; a renderer that emits HTML makes a
  scope page able to inject into the operator's UI. T3's `parseRawHtml={false}` mode is the
  shape to copy.
- GFM tables on, wrapped in an `overflow-x: auto` container as OpenCode does, or a tablet
  width will be decided by someone else's column count.
- Syntax highlighting is **out of scope** for this slice. `<pre><code>` with the fence's own
  language as a label gets the operator's ASCII trees and code back; Shiki is its own slice
  and its own dependency weight.
- `splitCode` is retired by this, not kept beside it.

### S5 — the harness selector becomes a modal — **done, 2026-11-03** (review pending at time of writing)

The request's dismissal clause was already satisfied: both pickers already had an
outside-click layer, Escape, a Tab-wrap trap and `role="dialog"`. What they were not was
**modal** — anchored to the chip, no dimming, no `aria-modal`. That is what changed, for
`ImporterModelPicker` only.

`lib/dialogFocus.ts` (new) holds `holdFocus(panel, opener?)` and `wrapTab(event, panel)`,
lifted out of `Modal.svelte` unchanged so both dialogs share one copy — including the
`data-focus-fallback` path for an opener deleted while the dialog was open.
`components/HarnessDialog.svelte` (new) is the shell: scrim, outside-click layer, Escape,
trap, `aria-modal="true"`, and the popover's own geometry kept — 622px wide, 340px max
height, same border, radius and background, only the shadow swapped; 470px below 920px,
the width `HarnessChoice`'s stacked layout was measured against. `HarnessChoice` is
untouched.

**Two corrections to the brief, both the implementer's and both right.**

`Modal.svelte` does **not** close on an outside click — its scrim has no click handler, and
that is correct for its users (the New goal form, the delete confirmation), where a stray
click must not discard a form or a question. So `HarnessDialog` is a separate shell rather
than a use of `Modal`: `Modal` would impose a heading, a × button, padding, a footer and a
560px width, which would be redesigning the picker.

Switching `HarnessPicker` over later is **not** one line, as the brief assumed. It is five
steps: bind `trigger`; swap `.dismiss` + `.panel` for `<HarnessDialog>`; drop `onDismiss`
from its `HarnessChoice`; delete its Tab trap, `<svelte:window>`, `panel` state and
`.dismiss`/`.panel` CSS; drop `position: relative` from `.picker`.

**The opener must be passed explicitly**, never read from `document.activeElement`:
`HarnessChoice`'s effect runs first and moves focus into the filter box, which then
disappears with the dialog. Removing the explicit opener broke the ordinary keyboard case,
not only Safari's click-does-not-focus-a-button case.

`onDismiss` is no longer passed to `HarnessChoice`, so Escape does not close twice.

**Found by review, fixed in S5a: Enter in the picker's filter sent the composer's draft.**
The dialog renders inside the composer's `<form onsubmit={submit}>` and the filter is an
`<input type="search">`, so Enter was an implicit form submission. It predates this slice —
the popover had the same nesting — but the modal makes it a contradiction, since
`aria-modal="true"` asserts the page behind is inert. The fallout compounded: sending starts
a turn, `pinned` goes non-null, the `{#if pinned === null}` branch tears down with the dialog
inside it, `app.importPickerOpen` stays true, focus lands on `<body>` (the opener is
disconnected and nothing carries `data-focus-fallback`), and the modal **reopens unasked** on
the next new session with a stale query.

The invariant worth keeping: a flag that controls a dialog may not survive a teardown of the
branch that renders the dialog. One that does will reopen it later with no operator action.

The review also settled the button→span question: the opener is **not** stale while the
dialog is open, because dialog and chip live in the same branch and the dialog cannot outlive
its button. The bug was the flag, never the binding.

The picker had **no** existing dismissal or focus tests — only lookups by `aria-haspopup`
and `role="dialog"`. Added: `aria-modal` set and focus starting in the filter; Escape
closing with focus back on the chip; a click inside keeping it open and a click outside
closing it; focus returning to the chip when the click never focused it; Tab and Shift+Tab
wrapping. Each was confirmed to fail when its behaviour was broken.

Dismissible by Escape or by clicking outside. The design otherwise unchanged.
`Modal.svelte` already exists and already handles focus restore, including the case where
the element that opened it has since been removed from the DOM.

### S5a — the picker left the composer's form — **done, 2026-11-03**

`HarnessDialog` now **portals its layer to the end of `<body>`** rather than guarding the
filter's Enter. A guard covers one control; the next input or submit button added to the
columns would belong to the composer's form again. Outside the form nothing in the dialog
belongs to it whatever the columns grow, it covers the run composer's picker if that ever
becomes this modal, and it takes `position: fixed` out of any ancestor's stacking context.

Two details make the move safe, both argued in the component's header:

- **The root element never moves.** Svelte removes a block by walking from its first node to
  its last through siblings; moving the root would send that walk on through whatever
  followed it. So the root is an empty `hidden` placeholder that stays where the caller wrote
  it, and only the layer inside it moves.
- **The panel renders only after the move.** Svelte runs `HarnessChoice`'s focus-the-filter
  effect before the attachment that moves the layer, and moving a focused node blurs it. So
  scrim and panel sit behind `{#if moved}` and are created in `<body>`.

Svelte listens for delegated events on `document`, which is what makes a moved node still
work, and the design tokens are on `:root`, so the move costs no styling.

`app.importPickerOpen` is now cleared by an attachment on the chip's own branch, not in
`importer.start()` or a `pinned` watcher: the branch goes for several reasons — a session
gains messages, the importer is left, a session is opened from the crumb bar — and fixing
each path separately means the one forgotten reopens the dialog.

The scrim sentence was **corrected rather than made true**: it now says it is a copy of
`Modal`'s scrim and both keyframes and that a change to one must be made to the other. What
carries the look is already shared through tokens; the copy is nine lines of fixed, centred
grid, and sharing it would mean a global class or rebuilding `Modal` on a scrim component.

`apps/web/test/dom/dom.ts` gained `pressEnterIn`, because happy-dom does not perform implicit
submission — the helper does what a browser does and clicks the owning form's first enabled
submit button.

**Still open, raised unprompted:** when the branch is torn down while the dialog is open,
focus still lands on `<body>`. The filter-Enter path can no longer cause that, but Back
navigation can. A fix needs a `data-focus-fallback` ancestor in the importer; not added.

### S6 — one renderer for live and replay (not yet designed)

The architectural one. Both paths produce the same normalised item; the replayed branch in
`Chat.svelte` stops being a separate rendering and goes through `ChatItem` like everything
else.

Blast radius, from the survey:

- `MessageEntry` (`agentHarness.ts:219`) gains parts.
- `openCodeClient.ts:659` and `claudeCodeClient.ts:886` become part mappers. On Claude Code
  `narrationOf` (`claudeCodeClient.ts:770`) already does this work against the same block
  shape. On OpenCode the stored `AssistantTool` part is richer than the live event stream —
  call and result arrive already paired, with timestamps.
- Three identical reduced contracts go: `RoundNarrationMessage` (`plan.ts:304`),
  `GoalConversationMessage` (`goalAgent.ts:209`), `ImporterConversationMessage`
  (`scopeImport.ts:817`).
- `Chat.svelte`'s replayed branch, `chat.ts`, `importerChat.ts`.
- Four chat surfaces consume this: `PlannerChat`, `GoalAgentChat`, `ImporterChat`,
  `LiveTranscript`.

Open questions for its design document: whether a tool-classification step
(T3's `command_execution | file_change | file_search | web_search | dynamic_tool`) is worth
adding to the two harness clients, so that adding a third harness does not mean teaching the
renderer about it; and whether to lift `ForwardCompatibleUnion` for the stream cursor,
independently of the renderer.

### S9 — a session is named by its harness, not by its clock

The crumb reads `Session 18:02`, built in `importerChat.ts:660` from `startedAt`
(`ImporterSessionView.openedAt`). Both harnesses can give a real name instead.

**OpenCode:** `Session.title`, optional string on the session row
(`@opencode/schema/dist/session.d.ts:152`), returned by `session.get` **and**
`session.list` — so a whole list of titles is one call. Auto-titled from the conversation.

**Claude Code:** `getSessionInfo(sessionId)` → `SDKSessionInfo`, carrying
`summary: string` ("custom title, auto-generated summary, or first prompt"),
`customTitle?`, `firstPrompt?`, `lastModified`, `createdAt`, `cwd`, `gitBranch`, `tag`.
Also `listSessions({ dir })` in bulk and `renameSession(id, title)`.

`AgentHarness` has no title operation; that is the seam change.
`ImporterSessionView` has no title field; that is the contract change.

**Five constraints, and the second is the one that bites:**

1. **A title is as perishable as the prose.** §8 accepted losing a conversation when a
   harness purges it, and the title goes with it. The date comes from bit's **own** durable
   row, so it is what keeps a swept session legible. The date is not replaced — it becomes
   the fallback and the subtitle.
2. **Claude Code's fallback chain leaks our own prompt.** `summary` falls back to the first
   meaningful user prompt, and bit's first prompt is `assembleImporterPrompt`'s ~3 KB of
   rules with the operator's sentence at the bottom. A session that never earned an
   auto-summary would be titled with our framing. `importerPrompt.ts` already has
   `IMPORTER_PROMPT_DELIMITER` and `operatorTextOf` — the replay path's exact split — and the
   same trim is needed here. Prefer `customTitle`; distrust `summary` when it matches the
   stored prompt. **Test this explicitly**: getting it wrong puts three kilobytes of our own
   prompt in a crumb.
3. **The cost shape is asymmetric per driver.** OpenCode returns every title in the list
   call. Claude Code's `listSessions` is per project directory, and bit's sessions live in
   per-import _gated_ directories (`FleetPaths.importDirectory`), so it is one list call per
   import — effectively N× `getSessionInfo`, each bounded by the control timeout. The seam
   hides that; the list endpoint has to decide whether a slow driver blocks the list or
   titles arrive on a second paint.
4. **Titles mutate.** Both harnesses retitle as a conversation develops, so this is a
   read-through-on-open value. Caching it in `import_sessions` would be a second copy of
   harness-owned data with no invalidation story — what §8 argues against.
5. **It is agent-authored text in the operator's chrome.** The same untrusted-content class
   as S4. A plain label, so Svelte escapes it, but it wants a length cap and must never go
   through the markdown renderer.

**Shape:** title when the harness has one, date when it does not, both visible — title as
the label, time as subtitle or `title` attribute — so nothing becomes unidentifiable when a
harness forgets it, and two same-named sessions stay tellable apart.

**Split for implementation.** The server half (seam, contract field, the item-2 trim, the
per-driver cost decision) is independent of how the selector looks. The UI half waits on the
operator's updated session-selector design, which was promised on 2026-11-03 and had not
arrived when this was written.

### S7 — API environment variables into their own package

Extract into `packages/`. Must stay browser-safe if contracts are to consume it; more likely
it is server-only and contracts must _not_ import it. Unscoped.

### S8 — file upload from the prompt box (researched 2026-11-03, decided)

Today the `+` button is deliberately inert: `aria-disabled` with a title saying nothing is
behind it. Wanted: uploads that work across every harness bit supports, generic enough that
adding a harness does not mean rethinking uploads.

**What T3 does** (verified against its source): paste, drop and picker feed one intake; the
browser uploads each file to a signed, size-pinned URL first, and the send-turn command
carries only `{ id, name, mimeType, sizeBytes }`. Every provider gets a
`[Attached file "name" is saved at: /abs/path]` line appended to the prompt text
(`provider-core/src/server/attachmentPrompt.ts:176`); on top of that, images go inline to
Claude as base64 `image` blocks (`ClaudeAdapterV2.ts:1912`) and to OpenCode as file parts,
and OpenCode also takes `text/plain` and PDF under 20 MiB as file parts. Everything else is
path-only. Limits: 10 MiB per image, 50 MiB per file, 100 per message
(`contracts/src/chatAttachment.ts:12-23`).

**What bit does, V1:**

- **Intake:** paste, drag-and-drop and the `+` picker. Images: GIF, JPEG, PNG, WebP only.
  **HEIC/HEIF is refused**, with the reason, not converted. Limits are T3's: 10 MiB per
  image, 50 MiB per file, 100 per message. Over a limit is refused, not compressed.
- **Transport:** one `multipart` request carrying the message and its files. No upload
  step, no signed URL, no pending state. A failed upload refuses the send through the
  generic error modal.
- **Storage:** inside the session's own working directory (the import directory for the
  importer), so the existing policy gate already covers the agent reading it and no new
  filesystem authority is granted.
- **Delivery:** the path line is appended on every harness. Images also go inline to Claude
  Code (`SDKUserMessage` image blocks) and as `files: [{ uri }]` to OpenCode
  (`SessionPromptInput.files`, `@opencode/client` 2.1). `text/plain` and PDF also go as
  OpenCode `files`. Everything else is path-only.
- **Reload:** rendered from the harness transcript, which already holds the image block
  (Claude Code) or the file reference (OpenCode). No attachment table — DECISIONS.md §8.
- **Path rendering:** the attachment line in an operator message renders as a chip with a
  copy-path button (`navigator.clipboard.writeText`; bit is served from localhost, which is
  a secure context, so the API is available).

## Deferred to V2

_Superseded by the `V2(chat):` comments in code and by
`docs/superpowers/plans/2026-11-03-a6-chat-revamp-breakdown.md`._

This is the register of every compromise the chat-surface V1 makes on purpose. Each entry
names what V1 does, why it is enough for now, and what the proper V2 does. **At every code
site that implements one of these, leave a comment beginning `V2(chat):` that names the
compromise and points here**, so `grep -rn "V2(chat):"` finds every site when the V2 issue
is opened. An entry is removed from here only when its V2 lands.

1. **Model switching keeps one model on the session row.** V1 updates `model` and
   `model_options` in place and keeps no record of when a switch happened; a reload shows
   only the current model. Switching is within one harness only, because the agent
   definition is native to each harness and the conversation cannot be carried across.
   _V2:_ an append-only switch log so the transcript can show where each switch happened,
   and cross-harness handoff that carries the graph, the agent definition and a summary of
   the conversation.
2. _(Withdrawn: the updated A6 design applies a model switch at once, including mid-run.)_
3. **Queued messages are held by the harness, not by bit.** Follow-ups go straight to the
   harness as `steer`/`queued`. They cannot be edited, cancelled or reordered once sent, and
   a Claude Code message queued but not yet run is lost if bit restarts (it lives in bit's
   input stream; OpenCode keeps its queue in its own database). What an interrupt does to
   messages still in either harness's queue is unmeasured. _V2:_ T3's model — an app-owned
   queue the operator can edit, cancel, reorder, and promote to an immediate steer.
4. **"Send now" is a preemptive steer, not an interrupt.** It takes effect at the harness's
   next step boundary, so a tool call already executing finishes first, and the rest of the
   work in flight is discarded. _V2:_ a combined "stop and send" that interrupts the turn and
   then opens the next one, once interrupt-with-queued-messages behaviour is measured.
5. **Compaction is left to each harness's own automatic default.** Both compact by default
   and bit disables neither, but an `opencode.json` in an ancestor directory or the user's
   Claude Code settings can turn it off, and bit does not detect that or warn when a switch
   lands on a model with a smaller window. _V2:_ detect the effective policy and warn before
   a switch that the current context will not fit.
6. **Streaming partials are never stored and are not replayed after a reconnect.** A
   reconnect catches up from finished blocks only, so a block still being written shows
   nothing until it ends. _V2:_ resume the in-flight block from the harness's own buffer.
7. **Uploads are one multipart request with no lifecycle.** No signed upload URLs, no
   pending state, no sweep of abandoned files (they live as long as the session's
   directory), the browser's MIME type is trusted after the allow-list, no client-side image
   compression, and HEIC/HEIF is refused. _V2:_ T3's two-step upload (signed, size-pinned
   URL, claim on send, pending sweep), byte sniffing, compression to fit the limit, and HEIC
   conversion if it is wanted.
8. **Non-image files reach Claude Code as a path only.** The agent reads them through its
   own tools if it decides to. _V2:_ inline `text/plain` and PDF as document blocks where
   the Claude Agent SDK accepts them, matching what OpenCode gets.
