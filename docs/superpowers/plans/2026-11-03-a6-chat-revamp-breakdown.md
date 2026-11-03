# A6 chat revamp — task breakdown for delegates

The design is `docs/superpowers/design/A6-auto-load.dc.html` (screens D1–D8; the caption
under each screen is the designer's intent). This file is temporary: every compromise that
outlives it is recorded **in code** as a comment starting `V2(chat):` at the site that
makes it. `grep -rn "V2(chat):" apps packages` lists them.

## Rules for every task

- Read `AGENTS.md` first. Bun 1.4.3, strict ESM, Effect v4 (check installed types), Effect
  Schema, contracts browser-safe, `effect/sql` with tagged-template SQL, append-only
  migrations.
- Each delegate first **surveys what already exists** (much of D1, D2, D5, D6 is built:
  `screens/AutoLoad.svelte`, `screens/Assets.svelte`, `HarnessDialog.svelte`,
  `ContextMeter.svelte`, `Markdown.svelte`), then writes its own plan, then implements.
- Gates before hand-off: `bun run typecheck`, `bun run test`, `bun run lint`,
  `bun run format:check`, `bun run build`; `bun run test:persistence` for any SQL.
- A task that makes a listed compromise writes the `V2(chat):` comment given in its brief,
  at the site, naming what V1 does and what the proper V2 does.
- UI is verified from tablet width up, never phone.
- **Before any task runs in a worktree, the uncommitted S4/S5 work on `main` must be
  committed** (a worktree starts from the last commit and does not copy edits).

## Decisions already made (do not reopen)

- **Harness is pinned** to a conversation after its first message. Picking another harness
  in the modal opens a new session.
- **Model and reasoning switch freely within that harness, including mid-run** (D6). The
  switch is applied at once; the harness takes it from its next model call. The session row
  holds the current model only.
- **Agent is pinned** after the first message. The agent decides the prompt a conversation
  uses, and comes from a generic registry so more agents and prompt editing (a future
  dashboard) are data changes, not code changes.
- **Follow-ups stay harness-queued** (`queued` steer). **Send now** is a `preemptive`
  steer. **Stop** really interrupts the harness.
- **Live streaming** like T3: full accumulated text per item, coalesced at ~50 ms, the
  finished block replaces it; partials are never stored.
- **Uploads, simple:** GIF/JPEG/PNG/WebP images (HEIC/HEIF refused), 10 MiB per image,
  50 MiB per file, 100 per message, one multipart request, saved in the session's working
  directory, path line on every harness, images inline (Claude image blocks / OpenCode
  `files`), `text/plain` and PDF also as OpenCode `files`. Attachment chip with a copy-path
  button. Reload renders from the harness transcript.
- **Compaction** is each harness's default. **Rewind** is out.

## Tasks

Sizes: S ≈ half a day, M ≈ a day. Arrows are hard dependencies.

### Foundation (server and contracts)

**F1 — Agent registry (M).** A generic `AgentDefinition`: id, label, one-line "what it can
write", the prompt it is opened with, and the MCP authority profile its credential grants.
One entry, the importer; `importerPrompt.ts` assembles from it. Record `agent_id` on the
import session row (new migration) and expose the registry in contracts for the chip. The
agent is fixed once the first message is sent.
`V2(chat):` at the registry — agents are code-defined and pinned per session; V2 stores
prompts as editable, versioned data (the dashboard), and allows switching agent
per message, which means re-scoping the session's MCP credential and re-sending the new
agent's prompt mid-session.

**F2 — Generic error modal (S).** Built on `Modal.svelte`/`ConfirmAction.svelte`: title,
the server's sentence, one dismiss action. Used by F4, F5, U3.

**F3 — `AgentHarness.switchModel` (M).** `switchModel(sessionId, model, options)` on the
seam. OpenCode: `api.session.switchModel({ sessionID, model: Model.Ref })` with the
variant on the ref. Claude Code: `query.setModel(model)` and
`query.applyFlagSettings({ effortLevel })` on the live query; for a session not held live,
the new model applies at its next resume (`record.model`). Stub harness too. Include a short
probe (in `spike/`, like `steeringProbe.ts`) that switches **mid-turn** on both harnesses
and records when the change takes effect; if a harness refuses mid-turn, that harness holds
the switch until idle and says so. Known already (OpenCode source, read by an earlier
thread): `switchModel` takes effect at the next step boundary, the new model is sent the
full stored history, reasoning from a different model is dropped on Anthropic and OpenAI
Responses providers, and a smaller window can fire OpenCode's auto-compaction on the next
step. T3 applies every in-session switch on the _next turn_, never mid-turn, so Claude Code
mid-turn behaviour is genuinely unmeasured.

**F4 — Model switch for a running conversation (M), F3 → F4.** From F3 and its review: the live-session
registry keeps its own copy of the model besides the row, so update both; a Claude Code
`switchModel` refused with `SESSION_NOT_FOUND_TAG`/404 means "not live — update the row, the
next resume uses it"; OpenCode's switch 404 has no tag (check the status); `switchModel`
requires a catalogue model id — OpenCode's `modelOf`/`openCodeVariantOf` decode with
`decodeUnknownSync` and **throw** on a malformed id, so validate catalogue membership and
resolve options before calling (or map the decode failure to a typed error); the stub's
`recordModelSwitches()` is there for the tests. From F3's second review: run switches **one at a time per
conversation** in F4 — two concurrent OpenCode HTTP switches can reach the server in one
order and complete in the other, so a row written on each completion could disagree with
the server; and a queued switch's wait has no bound of its own on Claude Code (a hung CLI
makes a burst time out one after another), so refuse or coalesce a switch while one is in
flight. An endpoint for importer
and goal conversations: refuse a different harness, re-resolve options against the new
model (`explicitModelOptionSelections`, report `droppedModelOptionIds`), call
`switchModel`, and only then update `model` / `model_options` on the row. A failure leaves
the row unchanged and is shown through F2.

**F5 — Real Stop and Send now (M).** Also, from F4's last review: after a restart, a message or a
switch addressed to an _older_ import id in a reopen chain (I1 when I3 is the newest run)
is not followed to the newest run — `send` would reopen the same Claude Code session a
second time while I3 holds it, and a switch reports success on a row nothing reads. Refuse
(or redirect) an import id that is not its session's newest confirmed run in both `send`
and `switchFrom`, using the `latest_import_id` subquery. Stop calls `interruptSession` for the importer and goal
conversations (today `importerSessions.svelte.ts:710` only flips a browser flag). The
message endpoint takes `urgency: "queued" | "preemptive"`; the composer shows **Send now**
beside Send while a turn runs. Record what an interrupt does to messages still in each
harness's queue.
`V2(chat):` at the urgency handling — Send now lands at the next step boundary, so a tool
call already running finishes first; V2 adds "stop and send" once interrupt-with-queue is
measured.

**F6 — Streaming contract and coalescer (S).** A partial state on `LiveItem` (stable item
id, `streaming: true`, full text so far) and a server-side coalescer (~50 ms, full text per
flush, final flush on block end). Partials go on the live stream only, never to storage.
`V2(chat):` at the coalescer — a reconnect catches up from finished blocks only, so a block
being written shows nothing until it ends; V2 resumes the in-flight block.

**F7 — OpenCode deltas (S), F6 → F7.** Feed `session.text.delta` and reasoning deltas into
the coalescer; `session.text.ended` / `reasoning.ended` close the item
(`openCodeClient.ts:496` today reads only `ended`).

**F8 — Claude Code partial messages (S), F6 → F8.** `includePartialMessages: true`; handle
`text_delta` and `thinking_delta` `stream_event`s; the `assistant` message closes the
items. Check the outcome watch and usage mapping still read the same events.

**F9 — Uploads, server (M).** Multipart on the conversation message endpoint; validate type,
size and count (HEIC refused with a reason); write into the session's working directory;
the harness `prompt` gains attachments: Claude Code image blocks in the `SDKUserMessage`,
OpenCode `files: [{ uri }]` for images, `text/plain` and PDF; the
`[Attached … is saved at: <path>]` line on every harness.
`V2(chat):` at the endpoint — one request with no upload lifecycle: no signed URLs, no
pending state or sweep, browser MIME trusted after the allow-list, no compression, no
HEIC; V2 is T3's signed, size-pinned two-step upload with sniffing and compression.
`V2(chat):` at the Claude Code delivery — non-image files reach it as a path only; V2
inlines `text/plain` and PDF as document blocks.

**F10 — One renderer for live and replay (M). While reshaping the conversation view, make
`ImporterConversationView` a union keyed on `continuation` so `refusal` exists only on
`refused` (F1 review: today the invariant holds by convention, and a `refused` without a
refusal would leave the composer enabled).** Spec S6: replay produces the same
normalised items as live, through `ChatItem`, including per-turn model and timestamps from
the harness transcript (needed by U4's turn footer). Blocks U4–U6.

### UI (design screens)

**U1 — D1 Assets empty state (S).** "No scope authored", **Auto-load scope…** and **Add an
entry by hand**; the "last importer session … Continue that session" strip; on a target
with entries, **Auto-load…** moves into the Scope tab header.

**U2 — D2 new session (S), F1 → U2.** Heading, lead, composer, and the two suggestion chips
as pre-written first messages. Composer chips read "Importer on <model>".

**U3 — D6 harness modal wording and in-session switching (S), F4 → U3.** From F4's review: a message
already running finishes on the old model — `applied: "live"` means _from the next model
call_, so word the confirmation that way (measured: a turn sent before the switch still
answered on the old model). A message sent behind an in-flight switch can wait up to ~90 s
in the worst case (successor open, then `setModel`, context-limit read and
`applyFlagSettings`, each bounded by the control timeout) — show that it is waiting.
Refusals are `ConversationModelRefused` (409, with a sentence) → the F2 `ErrorDialog`. Footer: "This
session stays on <harness> — picking another harness opens a new one. Models and reasoning
inside it can change at any time, including mid-run." Choosing a model in an open session
calls F4; choosing another harness opens a new session.

**U4 — D3/D4 transcript layout (M), F10 → U4.** The turn footer's model must come from the transcript, not
the session row: after a switch every replayed turn is labelled with the current model
(`ImporterChat.svelte:275`), but each assistant entry records the model that answered it. Agent prose full width, no bubble; operator
turns boxed with "You · 18:02"; consecutive tool calls collapse to one muted line
("Ran 3 commands · write_scope_entry, record_asset") with parameters and output one click
away; reasoning collapses to one truncated line (markdown); turn footer
"Importer · <model> · 41s"; record-write states kept.

**U5 — Live streaming in the thread (S), F6 + U4 → U5.** Apply partial updates by item id,
"writing…" indicator, markdown over partial text with unclosed fences handled.

**U6 — D3 Stop pill and Send now (S), F5 + U4 → U6.**

**U7 — D7 agent chip (S), F1 → U7.** Chip and list from the registry ("only agent", what
it can write); locked once the conversation has started. Today the chip is hardcoded text "Importer"
(`ImporterChat.svelte`, `agent-chip`): read the session's `agentId` instead, and decide what
it shows for a session whose agent this build no longer defines (the composer is already
refused with the server's sentence, F1 `609da09`). Also from F1's review: `startWith` checks
the agent's authority role on every open path — keep that when the chip can choose.

**U8 — D5 sessions list (M).** The server half of S9 is done (`d0d82a2`:
`AgentHarness.sessionTitle`, `import/importerTitle.ts`, nullable `title` in the
contract); this task is the web half. Spec S9: session named from the harness title (with its five
constraints), the write summary ("7 in · 3 out · 14 assets"), the model it ended on, the
date, **Start a new session**; an older session read-only until the operator types.

**U9 — D3 context meter (S).** Ring and token count in the crumb bar, clickable to show what
fills the window: Claude Code's `getContextUsage()` categories; on OpenCode, tokens and
window only.

**U10 — D8 markdown, framing (S).** Task lists, blockquotes with their source line, tables at
thread width, code blocks with filename and a Copy button, long unbreakable lines scroll in
their own block within the 800 px measure.

**U11 — D8 syntax highlighting (S).** Monochrome, by weight and tone. New dependency; T3 pins
Shiki to the Oniguruma WASM engine because the JS regex engine can hang.

**U12 — D8 flow figures (S), U10 → U12. Decided: T3's approach.** Agents write
` ```mermaid ` fences, rendered with **`pele`** (T3 `^1.8.0`; OpenCode pins `1.7.0`),
not mermaid.js. The fence leaves the sanitised markdown pipeline as plain code; a Svelte
component for `language-mermaid` draws it client-side. Lazy `import("pele/lazy")`, cached,
with per-diagram-type loads (T3 `apps/web/src/components/chat/MermaidDiagram.tsx:11-42`).
Mount with `links: false, images: false, zoom: false`; **re-sanitise the SVG** with a
private DOMPurify (`USE_PROFILES: { svg, svgFilters }`, `FORBID_TAGS: a, image,
foreignObject, style`, `FORBID_ATTR: href, xlink:href, src, srcset`; T3 `:154-167`) —
OpenCode skips this pass and bit must not, because importer text is attacker-controlled.
While streaming, show the code until the fence is closed (T3 `isClosedCodeFence`,
`MarkdownCodeBlock.logic.ts:44-66`), then draw once. Theme through `--pele-*` CSS
variables mapped to bit's tokens, so light/dark flips without redrawing. Errors: "Unable
to render diagram" with the source, a Show code / Show diagram toggle, Copy copies the
source. `overflow-x: auto`, SVG `max-width: 100%`. Out of V1: KaTeX labels and the expand
dialog. New dependencies: `pele`, `dompurify`.

**U13 — Uploads in the composer (M), F2 + F9 → U13.** Paste, drop and the `+` picker;
thumbnails for images, name and size for files, remove, refusal through F2; the attachment
chip with copy-path in operator turns, live and on reload.

## Order

Slices run **one at a time** on branch `a6-chat-revamp`, each committed by its implementer.
After each, a separate reviewer agent reviews the code against its brief and the design,
and checks the UI in a real browser (headless Chrome over CDP on the dev server) at tablet
width and up. Fixes go back to the implementer; the next slice starts after review passes.

F1, F2, F3, F4, F5, F6, F7, F8, F10, F9, U1, U10, U12, U11, U2, U7, U3, U4, U5, U6, U9, U8,
U13.

## Known issues found along the way (not in any slice)

- The **built** server (`bun dist/main.js`) cannot open Claude Code sessions: it refuses
  `import_ungated` because it resolves the policy hook at `apps/plugins/claudeCodeGate.ts`,
  which does not exist; `bun src/main.ts` works. Predates this work (found in F4's review).
