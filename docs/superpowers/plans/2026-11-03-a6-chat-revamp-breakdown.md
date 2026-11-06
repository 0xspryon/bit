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
- **Attachment lines match T3 Code** (operator, 2026-11-05, reversing U13 Step 0's marker
  decision): one plain `[Attached … is saved at: <path>]` line per file after a blank line,
  nothing for a message without files. Five review rounds showed wording cannot stop a
  forgery, the sealed block cost about 400 tokens per message, and neither T3 nor OpenCode
  guards against look-alikes. The block's design is a `V2(chat):` note in
  `harness/attachments.ts`.

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

**F8 — Claude Code partial messages (S), F6 → F8.** From F6's review: the `blockId` on each delta must
equal the one on the finished block — derive it from the `stream_event`'s `message.id`
plus the content-block index, and recover the index from the stream, not from the block's
position in the CLI's split `assistant` message. Confirm an interrupted turn's `result`
carries an outcome (the coalescer ends open blocks on it) and whether the CLI emits an
`assistant` message for a cut block. `includePartialMessages: true`; handle
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

**U4 — D3/D4 transcript layout (M), F10 → U4.** From U3's review: a harness error (e.g. OpenCode's
"Free usage limit reached") currently shows only as "The importer wrote nothing in reply" —
show the harness's own error sentence in the thread (as text, marked). From F10's review (decided): a steer sent while a
turn runs is drawn where the operator sent it but marked **queued** until the server says
the harness took it (a later `result` names it in `user_message_uuids`); then it reads as
an ordinary operator turn. Pair a tool call with its result across that boundary so a
result that lands after the steer still folds into its call's row. The turn footer's model must come from the transcript, not
the session row: after a switch every replayed turn is labelled with the current model
(`ImporterChat.svelte:275`), but each assistant entry records the model that answered it. Agent prose full width, no bubble; operator
turns boxed with "You · 18:02"; consecutive tool calls collapse to one muted line
("Ran 3 commands · write_scope_entry, record_asset") with parameters and output one click
away; reasoning collapses to one truncated line (markdown); turn footer
"Importer · <model> · 41s"; record-write states kept.

**U5 — Live streaming in the thread (S), F6 + U4 → U5.** From U4's last fix round: a reload while Claude Code is partway through a
text block shows "The harness holds this message and no reply to it." until the block
finishes (the CLI writes a block only once complete, and partials from before the reload are
not resent) — show the turn as in progress ("writing…") instead. From F6: request the live stream with `?partials=1`;
replace by `blockId` and never add a partial's `id` to the shown-ids set; when the session
goes idle, hide "writing…" for any partial with no finished block; on stream reopen, drop
every partial (finished blocks replayed after a gap carry no `blockId`). From F7's live run (GLM 5.3): `session.reasoning.ended` arrives only at the
step's end, so a thinking partial would show "writing…" for the whole reply — treat a
thinking partial as done once a reply partial of the same message starts (the `blockId`
prefix is the message id). A thinking block over the 4,000-character cap stops growing while
the model keeps thinking (seen frozen ~30 s) — show it as truncated rather than as still
writing. Apply partial updates by item id,
"writing…" indicator, markdown over partial text with unclosed fences handled. From F8's review: a retried API call (new `message_start`, non-streaming
fallback, refusal `supersedes`) leaves the first attempt's block unfinished; the turn's end
flushes it, so at turn end drop any partial that has no finished block.

**U6 — D3 Stop pill and Send now (S), F5 + U4 → U6.** Show Stop whenever the **server** says the
conversation is running (`sessionStatus` / the live stream), not only while a message the
operator sent is unanswered — today the web decides from accepted messages
(`importerSessions.svelte.ts:~192`), so a turn the CLI starts itself (a background task's
notification turn) cannot be stopped from the browser (F5 R4 review). Also: after a
`background_stopped` answer with `working: true`, the "may still be running" notice is
cleared only by the turn watch, so it can stay until the next turn ends — clear it from
`sessionStatus.background` going false (F5 R6 review). Background work counts too:
`sessionStatus.background` is true while a background subagent or shell the agent started is
still running, outside any turn, and a Stop then answers `background_stopped` (F5 R5 review).

**U7 — D7 agent chip (S), F1 → U7.** Chip and list from the registry ("only agent", what
it can write); locked once the conversation has started. Today the chip is hardcoded text "Importer"
(`ImporterChat.svelte`, `agent-chip`): read the session's `agentId` instead, and decide what
it shows for a session whose agent this build no longer defines (the composer is already
refused with the server's sentence, F1 `609da09`). Also from F1's review: `startWith` checks
the agent's authority role on every open path — keep that when the chip can choose.

**U8 — D5 sessions list (M).** From U3's review: a new empty session's URL becomes
`/assets/estate`, and so does the session menu's "Start a new session" — give a new session
a URL that keeps the operator on the importer page. The server half of S9 is done (`d0d82a2`:
`AgentHarness.sessionTitle`, `import/importerTitle.ts`, nullable `title` in the
contract); this task is the web half. Spec S9: session named from the harness title (with its five
constraints), the write summary ("7 in · 3 out · 14 assets"), the model it ended on, the
date, **Start a new session**; an older session read-only until the operator types.
**U8b — A7 Agent sessions page (M), U8 → U8b.** Split out of U8 (2026-11-05) so each is reviewed on its own. Builds A7's E1, E2, E5 and E6
(`docs/superpowers/design/A7-agent-sessions.html`) on the existing `screens/AgentSessions.svelte`:

- grouping and filters replace that page's "no grouping, no filters" rule;
- Active is grouped Needs you / Running / Idle, with a second line of what each session is
  doing (last tool, call count);
- Active/Ended/All tabs with counts, a Needs you toggle with an "N more hidden" line, an
  agent filter and a text filter;
- Ended is grouped by day with outcome marks (completed, stopped by you, failed with
  "resumable", empty), and a deleted surface is struck through but its transcript still opens;
- **server-side pagination** for Ended: 25/50/100 rows, range and total, and each day's full
  count on every page;
- the sidebar entry under Operations: a warning count of sessions waiting on you, falling back
  to a quiet active count.
  "Needs you" stays empty until A7-Q lands.
  **Built (2026-11-05):** the Needs you plumbing is in place end to end; A7-Q only sets
  `waiting` per row in `apps/server/src/http/agentSessions.ts` (`unionAgentSessions`, see its
  `V2(chat):` note), including the planner's "approve a plan" state, which no round status
  records today.

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

**U13 — Uploads in the composer (M), F2 + F9 → U13.** **Step 0 (from F9's last review):** in
`upload/uploads.ts:537-543`, a `writeSync` that throws partway leaves a partial
`.incoming-<uuid>` file in `uploads/` (the temporary is never recorded in `made`) — remove
it via `removeOwn`, and add a test; also add a test that fails if only the dev/ino half of
the pre-write check (`:501`) is removed. **Also step 0 (operator decision): mark real attachment lines so pasted
look-alikes can't pass as attachments to the agent** — e.g. a per-message random marker on
the server-written attachment block that the agent is told about in that same message
(text a page author cannot know in advance), with the replay parser requiring it too. From F9's review: Bun answers a body over 128 MiB
that declares its length with an **empty 413** before the server can send a sentence —
the browser's `FormData` declares its length, so turn a 413 into a sentence through F2.
Replayed attachments carry no bytes: add a route that serves a file from a session's
`uploads/` only after checking the path is inside it (never trust a replayed path). Show
the empty-file and files-only refusals. **Decided:** retire the goal's old attach route
and its per-goal list once the goal composer sends files with the message (message files
currently share `goal/<id>/uploads/`, are re-listed in every later goal prompt, and count
against the attach route's per-goal cap). Paste, drop and the `+` picker;
thumbnails for images, name and size for files, remove, refusal through F2; the attachment
chip with copy-path in operator turns, live and on reload.

**U14 — Sub-agent entry (S), F10 → U14. Decided by the operator.** A sub-agent's own
reasoning, tool calls and replies currently appear live in the calling agent's chat as if
the caller wrote them, and vanish on reload. Instead: show **one sub-agent entry** in the
chat (what it is — e.g. its type/description — and whether it is running or finished),
both live and on reload, and **omit its content** from the caller's chat. The entry carries
a visible note that viewing a sub-agent's content is postponed to V2, and the code carries
a `V2(chat):` comment: proper V2 replays the sub-agent's own transcript (Claude Code keeps
it in a `subagents/` folder) labelled as the sub-agent's.

**A7-Q — The question dock (M+M), U13 → A7-Q. Decided by the operator (2026-11-05).** A7's E3/E4.

- Follow T3: each harness's **native** question mechanism maps onto one pending-question
  contract, whose answerability is `live`, `message` or `not_resumable`.
- **OpenCode 2.2.5: forms.** The 1.x question API is gone; the model's `question` tool _is_ a
  form (`metadata.kind: "question"`, fields `q0…qN`). Use the `form.created`, `form.replied`
  and `form.cancelled` events; `session.form.list` on (re)connect; `session.form.reply` to
  answer; `session.form.cancel` to dismiss. A `FormAlreadySettledError` counts as settled.
  Forms are in memory only, so an OpenCode restart loses them.
- **Claude Code:** `AskUserQuestion`, caught in `canUseTool` and answered as T3 does (`allow`
  with `updatedInput` carrying `answers`). Limits: at most 4 questions and 4 options each, no
  required flag, answers keyed by question text.
- **The dock:** it always uses the full interface with Jump to, even for 1–4 questions. It is
  **dismissible**: dismissing cancels the native request so the agent is told the operator
  declined. A question that is no longer answerable offers to send the answers as an
  ordinary message.
- **Waiting on you:** pending questions drive E1's Needs you group and E6's warning count.
- Step 0 measures each harness live: an interrupt while waiting, a reload, a restart, and a
  dismiss.

**A7-S — Sub-agent cards and panel (M), A7-Q → A7-S. Decided by the operator (2026-11-05):
replaces U14's "omit content".** A7's E7/E8.

- **Cards:**
  - running cards show their last tool lines, the current activity, the time and the call
    count;
  - finished cards quote what was returned to the parent;
  - failed cards carry a danger tint, the reason and the raw error;
  - "Open its thread" is disabled until V2, and keeps its `V2(chat):` note.
- **Stop:**
  - a per-card Stop for background sub-agents (`stopTask`);
  - **hidden, with the reason, for a foreground Claude Code sub-agent**, since only the whole
    turn can be stopped;
  - on OpenCode, interrupt the child session, measured first;
  - "Stop all".
- **E8:** a header chip ("N sub-agents · running · failed") opens a 400px reflowing panel
  grouped Running / Failed / Finished, and selecting a row scrolls to its card.

**F12 — Built server cannot open Claude Code sessions (S), last.** `bun dist/main.js`
refuses every Claude Code import with `import_ungated`: it resolves the policy hook at
`apps/plugins/claudeCodeGate.ts`, which does not exist (`bun src/main.ts` works). Fix the
resolution so the built server finds the gate. **Remind the operator when the plan is done.**

### Chat shell for goal/planner/worker (prep)

**Done (2026-11-06), web only; the full wiring is a later task, not yet scheduled.** The
importer's shell around its thread is now shared, so the goal, planner and worker chats can
mount it. Nothing outside the importer mounts it yet, and the importer looks and behaves as
before: its DOM suites pass unchanged, except that the composer-border test now compiles
`ChatComposer.svelte`, where the box's CSS moved.

**Review 1 fixes (2026-11-06).** The question dock now takes the composer's slot instead of
sitting above it (E3). The sub-agents chip moved from a `Chat` header row to the app's
title bar (E8). The shell gained `aside` for E8's panel and `controls` for E7's "Stop all".
A closed composer is its reason alone. The hidden file input is no longer a Tab stop. U13
review 6's leftovers were folded in: the reconnect notice is cleared when its import ends or
a message opens or resumes it, and `lost` now comes after ~31.5 s (`RESUBSCRIBE_LOST_AFTER` 7).

**What was extracted.**

- `apps/web/src/lib/chatShell.ts` holds the adapter types (`ChatSession`, `ChatComposerSource`
  = `OpenChatComposer | ClosedChatComposer`, `ChatQuestion`, `ChatTurnState`, `ChatWords`,
  `ComposerNotice`, `ComposerSendNow`) and the turn shape `ThreadTurn`. `ImporterTurn` is now an alias of `ThreadTurn`. The module also holds the
  rules the shell needs: `turnFooterText`, `replyText`, `clockLabel`, `composerCanSend` and
  `stopOffered`.
- `components/ChatShell.svelte` wraps `Chat` with `layout="thread"`. It draws the operator's
  bubble, the streaming cursor, the turn footer, Stop with an optional elapsed clock, the
  composer column with the sentences above the box, the drop of files on the panel, and the
  two F2 dialogs (a refused file, a refused Stop). It also sets the attachment loader.
- `components/ChatComposer.svelte` is the box: tray, textarea, `+`, Send now, arrow and
  count. It has three states:
  - **open**;
  - **blocked**: the input is disabled and the placeholder says why (the importer's
    stranded, ended and refused sessions);
  - **closed**: a reason sentence takes the input's place, and there is no `+` and no
    send. A closed source is `{ closed: "…" }` and nothing else; the importer's composer
    is typed `OpenChatComposer`, so the compiler checks it supplies every field.
- `Chat.svelte` has one new optional snippet, `subagent` (one sub-agent row, wrapped in
  `li.subagent-card`, which replaces U14's entry).
- `titleBarChips.svelte.ts` and `TitleBarChipSlot.svelte`: the page (`+page.svelte`)
  provides one holder by context, `TitleBar` draws whatever is placed in it between the
  context meter and the session chip, and a chat places a chip for as long as it is
  mounted.
- `ImporterChat.svelte` is now the importer's adapter. Its own parts are the starters
  (`below`), and the agent chip, model picker and caption (`strip`). The importer also keeps
  the switch notices and every sentence about why a session cannot be continued. Parked
  words, `#confirm`, open and the new-session flow were already in `importerSessions` and
  `TitleBar`.

**How to mount it.** Build a `ChatSession<Subject>`, where `Subject` is `ThreadTurn` or an
extension of it, as getters over the chat's own state. Then render
`<ChatShell session id rootClass footnote>`. Optional parts:

- `separator`, `tail` and `footer` override a turn's bubble, cursor and footer, for example
  for a planner round's status heading.
- `strip` fills the composer strip and `below` goes under the composer.
- `dock` is **A7-Q's question dock**, drawn **in the composer's slot** (E3) while the
  session's `question` is set: the box, open or closed with its reason, is not drawn; the
  dock is, in the same column and width. Stop, the elapsed clock and the sentences above
  the box stay where they were. Esc in the dock calls `question.dismiss()` unless the dock's
  own control kept the key (`preventDefault`); once the adapter clears `question`
  (dismissed, or answered on the server) the box is back and, if focus went with the dock,
  is focused. A dismissed question still waits on the server (E3's "reply in chat
  instead"); the snippet gets the `ChatQuestion` so the dock can offer that too.
- `controls` sits beside Stop: **E7's "Stop all"**. It is drawn whether or not Stop is.
- `chip` is **E8's sub-agents chip**. The shell places it in the app's title bar beside the
  session chip, not in the chat.
- `aside` is **E8's 400px panel**, beside the chat column (`.chat-shell` is a row:
  `.column`, then `aside.aside`), which narrows the column rather than covering it.
- `subagent` is **A7-S's card**, called per folded row.

**The panel at tablet width (decision, 2026-11-06).** E8 has no note for narrow widths.
Measured live with a 400px region in the shell: at 1024 px with the rail showing the chat
column is 392 px (box 328 px). It still works, but the model chip is ellipsed and the
strip's caption drops out. With the rail hidden it is 624 px (box 560 px), and at 1440 px
it is 808 px. So **A7-S hides the rail while the panel is open whenever the column would
otherwise be under 560 px** (1024 px and similar), and gives it back on close. The panel
still reflows the chat, as E8 says, and is never an overlay.

All of the A7 slots are empty today. Leaving a field out means the chat cannot do that
thing:

- no `stop` means no Stop;
- no `composer.sendNow` means no Send now;
- no `composer.files` means no `+`, no paste and no drop;
- no `composer` means a read-only thread (unless a `question` is docked or there is a
  `below`);
- no `question` means the box is drawn;
- `turn.since` set means an elapsed clock beside Stop, and `words.elapsedLead` puts the
  chat's words before it (the planner's "Planning for", a worker's "Running for").

**The adapter each role needs.**

- **Goal chat: rebuilt on the shared shell with a goal adapter** (operator, 2026-11-06),
  on both harnesses, in the importer chat's image with goal-specific changes.
  `GoalAgentChat.svelte` is replaced rather than upgraded, and its current design is not
  kept. The adapter turns the goal conversation's replay and live items into `ThreadTurn`
  groups, the way `buildImporterChat` does for the importer. Its composer is the goal's
  draft and files, with `send` passing `urgency`. `stop` calls `stopGoalTurn`.
- **Planner.** It becomes a page-layout chat (`layout="thread"` through the shell), not
  `PlannerChat`'s panel, with the shell's clock beside Stop in place of its own running
  strip. `groups` has one `ThreadTurn` per round, with `message: null` or the round's
  objective, plus a `separator` override for the round's status. The composer is
  `{ closed: "Steered from the goal chat" }`. `stop` calls `stopRound`, `turn.since` is the
  round's `startedAt`, and `words.elapsedLead` is "Planning for".
- **Worker.** Also a page-layout chat with the shell's clock, in place of `ComposeBox`'s
  strip. One turn whose `message` is the intent's question, from the attempt transcript.
  The composer is `{ closed: "The prompt is the intent's question" }`. `stop` calls
  `stopRun`, `turn.since` is the attempt's start, and `words.elapsedLead` is "Running for".

**What is missing per role on the server and in the web state.** The live frames are not
in this list. `LiveItem`, `LiveUsage`, `LiveTurnEnded` and `LiveConnection` all carry
`attemptId`, `roundId`, `goalId` and `importId` already, and every role has a Stop route.
No route was added, and no contract was changed.

- **Goal** (for the rebuild).
  - Stop and Send now are not wired in the web: `client.ts` has `stopGoalTurn` and sends
    `urgency`, but the app never calls the stop.
  - There is no activity route like `importerActivity`, so nothing tells the page about a
    turn the harness opens itself or about background work.
  - There is no context route like `importerContext`: the meter has only `LiveUsage`, and
    no categories.
  - The server has a switch route (`switchGoalModel`), but `client.ts` does not call it
    and there is no picker: see the `ImporterModelPicker` `V2(chat):` note in
    `ImporterChat.svelte`.
  - Nothing marks queued, taken or carried turns for the goal: `turn.taken` and
    `turn.carried` are read only by `buildImporterChat`.
- **Planner.**
  - The replay source is `goalNarration` (per round, budgeted by `CHAT_ROUNDS_SHOWN`), and
    a mapping from it to `ThreadTurn` groups is needed.
  - There is no activity, context, switch or Send now route. The read-only composer is
    by design.
- **Worker.**
  - The replay source is the attempt `transcript` route (`TranscriptPanel`), plus the live
    feed (`LiveTranscript`), which are two sources to merge into one turn.
  - There is no activity, context or switch route, and no uploads.
- **All roles.** `app.liveConnection` is keyed by `usageScope`, so `connection` comes for
  free. The shell's `loadFile` is `app.loadUploadedFile`, which is per target.

## Order

Slices run **one at a time** on branch `a6-chat-revamp`, each committed by its implementer.
After each, a separate reviewer agent reviews the code against its brief and the design,
and checks the UI in a real browser (headless Chrome over CDP on the dev server) at tablet
width and up. Fixes go back to the implementer; the next slice starts after review passes.

F1, F2, F3, F4, F5, F6, F7, F8, F10, F9, U1, U10, U14, U12, U11, U2, U7, U3, U4, U5, U6, U9,
U8, U8b, U13, A7-Q, A7-S, F12.

## Known issues found along the way (not in any slice)

- **By design for V1 (U13 review 6).** A pasted line that names one of this session's own
  uploads in T3's attachment-line format is drawn as words live, but a replay after a
  reload reads it as a chip for that file, and the paragraph break around it collapses.
  Only this session's stored uploads are ever chips, so nothing outside the session can be
  named this way. The V2 gate refusal is where forged lines are refused.
- **V2 (U13 review 6).** No stall timer on OpenCode's event stream: OpenCode sends a
  heartbeat every 15 s, but a connection that stays open and goes quiet is neither an end
  nor a failure, so it never shows `reconnecting` and the chat shows no notice while
  narration has stopped. Recorded as a `V2(chat):` note at `resubscribing`
  (`harness/openCodeEvents.ts`).

- The **built** server (`bun dist/main.js`) cannot open Claude Code sessions: it refuses
  `import_ungated` because it resolves the policy hook at `apps/plugins/claudeCodeGate.ts`,
  which does not exist; `bun src/main.ts` works. Predates this work (found in F4's review).
- **Decided (operator, 2026-11-04): intended.** Importer (and goal) Claude Code CLIs load the operator's
  _user_ settings (`settingSources: ["user", …]`, `claudeCodeClient.ts:~1478`). Seen live in
  F5's review: the operator's own hooks ran against the importer, the superpowers
  SessionStart context was injected into it, and the operator's episodic-memory MCP server
  ran as its child — so the importer agent could search the operator's past conversations.
  The source comment justifies the setting only by the gate in `.claude/settings.local.json`.
- **Decided (operator, 2026-11-04): V2.** Recorded as `V2(chat):` notes in `harness/ownedProcesses.ts` and `policy/service.ts`. Real containment of an agent CLI and its tools. F5 kills a
  Claude Code CLI's process group and its descendants found in `/proc`; a tool that
  detaches itself (its own session, `setsid`, a plugin's sync process) can still escape. A
  cgroup per CLI would contain everything it starts. The gate's list of ended sessions is
  in memory only, so a CLI orphaned by a hard server kill is allowed again after a restart.
- **Decided (operator, 2026-11-04): intended**, as for Claude Code. An importer's OpenCode session listed a global `bit` MCP
  server (`bit_ingest`, `bit_retrieve`) in its tool catalogue, most likely from the
  operator's global OpenCode config — so an importer session could call tools outside what
  bit grants it (F7 review). Same class as the Claude Code user-settings item above.
- **Decided (operator, 2026-11-04): task U14.** Subagent activity. When an importer uses a subagent
  (possible because it loads the operator's user settings), its thinking, tool calls and
  replies appear live as the importer's own rows, but vanish on reload — the CLI keeps a
  subagent's transcript in a separate `subagents/` folder the replay does not read (F10
  review). Choose: replay subagent transcripts labelled as a subagent's, or keep subagent
  frames out of the live chat. Tied to the user-settings decision above.
- **Decided (operator, 2026-11-04): fine** — bit delegates to the harnesses and does not manage how they handle images. Evidence leaving the session directory. Claude Code keeps a
  full-size copy of every uploaded image in `/tmp/claude-<uid>/<project>/<session>/images/`
  and a JPEG copy in its transcript under `~/.claude/projects` (F9 review). Same class as the
  user-settings item.
- **Decided (operator, 2026-11-04): implement** — see U13 step 0. A line in the operator's text (e.g. pasted
  from a target page) shaped like `[Attached file "x" is saved at: /some/path]` is
  indistinguishable to the _agent_ from a real attachment line. The replay no longer trusts
  such lines (F9 fix), but the live prompt does; a per-message nonce on real lines would
  close it. Treated as ordinary prompt injection for V1.
  **Done in U13, tightened in U13 review 1:** the real block's header says it is bit's and
  the last in the message, and counts any lines in the operator's text imitating it (a
  file-less message with such lines gets the header alone); the header carries an
  HMAC-SHA256 seal under a key in `HUNT_ROOT/attachment-seal.key` over the session id,
  the header and the file lines, and a replay reads a block only when its seal verifies
  (`harness/attachments.ts`).
  **U13 review 3:** messages a harness hands to the model together (Claude Code joins steers
  it takes at once; OpenCode puts waiting messages in one call) each end in a block, so the
  header no longer says it is last: each operator header names the codes of the session's
  unanswered messages as bit's (newest 16, under the seal), and a prompt bit writes (a
  run's task, a planner round) ends in a briefing block instead.
  **Reversed (operator, 2026-11-05):** the sealed block above is cut; bit writes T3's plain
  lines (see Decisions). A forged line in pasted text is now ordinary prompt injection, out of
  scope until the V2 gate refuses an agent's reads outside the session's `uploads/`. bit still
  never lists a path outside that folder (`withAttachmentLines` throws), and a replay draws a
  chip only for a line naming a file in this session's `uploads/` (a gone one as "no longer
  stored"). Old dev transcripts with sealed blocks now show those blocks as words.
- **Found in U13 review 3, half fixed:** ending a goal left its idle goal-chat CLI running
  (about 800 MB with its MCP servers). The operator's End goal route now closes the goal's
  conversation. A goal the goal agent ends itself (`end_goal`) still keeps its session until
  the server stops, because the call comes from inside that session's own turn — a
  `V2(chat):` note at `endGoal` in `http/browserApi.ts`.
- **Not done, operator may want it:** the importer prompt does not tell agents about the
  blockquote source convention (a last line starting with `—` renders as the quote's
  source, U10). Adding it changes the prompt and needs the F1 prompt-hash pins in
  `apps/server/src/agent/registry.test.ts` updated. The source line is the agent's claim,
  not a checked citation.
- **Not decided (found in U5's live runs, 2026-11-04): a reply longer than 4,000 characters
  is cut, live and after a reload.** The server caps every narration field at
  `NARRATION_FIELD_MAX` (`agentHarness.ts`), a finished reply included, and the replay caps
  the same way (`projectReplay`), so the thread ends a long answer with `… (shortened)` and
  the rest is nowhere on the page — seen on both Haiku 4.5 (a 30-term glossary, ~3,950
  shown) and GLM 5.3 Flash. U5 says so while the block streams ("writing… — shown here up
  to 4,000 characters"); whether replies should have a larger cap, or none, is the
  operator's call. GLM 5.3 Flash's thinking passes the cap often (a 33 s thought).
  **Decided (U5 review, 2026-11-05):** a finished reply has its own cap,
  `REPLY_FIELD_MAX` = 32,000 characters, live and on replay (`truncateReply`); thinking,
  every tool field and every partial stay at 4,000. A reply streaming past 4,000 says
  "writing… — the rest shows when it finishes", and its finished block brings the whole.
- **Found in U5's live runs, not U5's:** a reload of a session that is still running draws
  "You are reading an earlier session. Your next message continues it…" above it, as for a
  session the page opened from the picker, while the turn runs with Stop under it.
