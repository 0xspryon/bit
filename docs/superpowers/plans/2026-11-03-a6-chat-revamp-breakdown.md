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
the switch until idle and says so.

**F4 — Model switch for a running conversation (M), F3 → F4.** An endpoint for importer
and goal conversations: refuse a different harness, re-resolve options against the new
model (`explicitModelOptionSelections`, report `droppedModelOptionIds`), call
`switchModel`, and only then update `model` / `model_options` on the row. A failure leaves
the row unchanged and is shown through F2.

**F5 — Real Stop and Send now (M).** Stop calls `interruptSession` for the importer and goal
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

**F10 — One renderer for live and replay (M).** Spec S6: replay produces the same
normalised items as live, through `ChatItem`, including per-turn model and timestamps from
the harness transcript (needed by U4's turn footer). Blocks U4–U6.

### UI (design screens)

**U1 — D1 Assets empty state (S).** "No scope authored", **Auto-load scope…** and **Add an
entry by hand**; the "last importer session … Continue that session" strip; on a target
with entries, **Auto-load…** moves into the Scope tab header.

**U2 — D2 new session (S), F1 → U2.** Heading, lead, composer, and the two suggestion chips
as pre-written first messages. Composer chips read "Importer on <model>".

**U3 — D6 harness modal wording and in-session switching (S), F4 → U3.** Footer: "This
session stays on <harness> — picking another harness opens a new one. Models and reasoning
inside it can change at any time, including mid-run." Choosing a model in an open session
calls F4; choosing another harness opens a new session.

**U4 — D3/D4 transcript layout (M), F10 → U4.** Agent prose full width, no bubble; operator
turns boxed with "You · 18:02"; consecutive tool calls collapse to one muted line
("Ran 3 commands · write_scope_entry, record_asset") with parameters and output one click
away; reasoning collapses to one truncated line (markdown); turn footer
"Importer · <model> · 41s"; record-write states kept.

**U5 — Live streaming in the thread (S), F6 + U4 → U5.** Apply partial updates by item id,
"writing…" indicator, markdown over partial text with unclosed fences handled.

**U6 — D3 Stop pill and Send now (S), F5 + U4 → U6.**

**U7 — D7 agent chip (S), F1 → U7.** Chip and list from the registry ("only agent", what
it can write); locked once the conversation has started.

**U8 — D5 sessions list (M).** Spec S9: session named from the harness title (with its five
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

**U12 — D8 flow figures (S, decide first).** "Small flow figures for relationships" needs a
renderer choice (a diagram dependency, or a constrained format of our own) before
planning.

**U13 — Uploads in the composer (M), F2 + F9 → U13.** Paste, drop and the `+` picker;
thumbnails for images, name and size for files, remove, refusal through F2; the attachment
chip with copy-path in operator turns, live and on reload.

## Suggested order

1. F1, F2, F3, F6, F10, U1, U10 — independent, can run in parallel.
2. F4, F5, F7, F8, F9, U2, U7, U9, U11.
3. U3, U4, U8, U13.
4. U5, U6, then U12 once decided.
