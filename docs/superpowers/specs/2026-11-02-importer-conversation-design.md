# The importer conversation — API design

> Six slices that turn the mock-driven importer chat into a real one. Written after slice 1
> shipped, so S1 below records what was built rather than what was planned.

## Intent

The scope importer is today a **single-turn batch job**: `createTarget` prompts it once, it
reads the links it was given, writes entries, and the session is destroyed. The Assets
screen now has a chat around it (`ImporterChat.svelte`, whose D1–D7 are the
design reference `.superpowers/design-refs/A6 Auto-load.dc.html`), and every interactive part of that chat is mock:
the composer, the prose, the streaming cursor, the tool rows, the history.

These six slices replace the mock with a server, in an order where each one can be merged
on its own and each one unmocks a named piece of the screen. They do not change what the
importer is _for_ — D13's gap between an import and the first execution stays, the
operator's review stays the only control on an imported scope — they change how long it
lives and how much of it a browser can see.

## What is pretending, and what each slice unmocks

| Screen element                         | Source today                | Becomes real in |
| -------------------------------------- | --------------------------- | --------------- |
| Session picker (D5)                    | `GET .../importer-sessions` | **S1 — done**   |
| "Continue that session" strip (D1)     | same route                  | **S1 — done**   |
| Composer (D4)                          | inert; `mockImporter.ts`    | S3              |
| Agent prose, streaming cursor (D3)     | `mockImporter.ts`           | S4              |
| Tool-call rows and their receipts (D3) | `mockImporter.ts`           | S5              |
| Replayed history, tombstone (D6)       | `mockImporter.ts`           | S6              |

## The shape all six converge on

There is already a long-lived agent session in this process, and it is not the importer:
`plan/goalConversation.ts`. It is created on the operator's first message, prompted again
for every message after it, holds its credential and its MCP registration in a per-session
`Scope`, and ends when something closes that scope or when the process dies. Its module
header is a written argument for every one of those choices.

**The importer conversation is that file's second instance, and the slices below are mostly
transliterations of it.** Where they diverge from it, the divergence is named and reasoned
in place. Inventing a second lifecycle for the same shape of thing is the failure these
slices are sequenced to avoid.

---

## S1 — The session index · _shipped_

`import_sessions` (migration `0024`), one row per import: `import_id`, `target_id`,
`harness_session_id`, `harness_instance_id`, `model`, `started_at`, and `session_created_at`
(`0025`). `GET /targets/:id/importer-sessions` lists the rows the harness confirmed
creating, newest first, each with a derived tally.

Two things it settled that the later slices inherit:

1. **The row is written before the session exists**, and marked once `createSession`
   returns. The attempt rows' arrangement, for their reason: an id recorded first cannot be
   lost to a crash, and an unmarked row is one the list refuses to offer for a resume. A
   crash between creation and the mark hides a real session and never offers an unreal one.
2. **Tallies are derived, not stored** — from `scope.entry.added` events and `asset_imports`
   rows joined on `caller_scope = <target>/import/<importId>`. `ImporterTally.messages` is
   typed `0 | null`, because nothing counts messages and the type should not be able to
   claim otherwise.

**Handoff constraint, and S3 must honour it:** a continued session's writes are only visible
to those tallies if they carry an import id the index knows. A second turn either reuses the
original `importId` or inserts a new `import_sessions` row — otherwise the tally on the
picker silently stops counting.

---

## S2 — A session that outlives a turn

### What it is

One line is deleted and the question it was answering has to be answered differently.
`scopeImporter.ts` forks each import into the layer's own scope, then:

```ts
Effect.onExit(() => Scope.close(scope, Exit.void));
```

The inner `scope` holds the credential and the MCP registration. `onExit` fires when the
fiber finishes — which it does immediately after `waitForIdle` returns and the closing report
is read. **So the importer's authority is destroyed at the end of its first turn, by
construction.** There is nothing to send a second message to.

This slice is entirely about authority. It writes no UI.

### S2.1 — The session is `multiTurn`, and the lifetime is a per-session `Scope.Closeable`

`createSession({ multiTurn: true })`. On OpenCode this changes nothing — a session lives in
the harness's own server and outlives every turn regardless. On Claude Code it is the whole
difference: a session **is** an open `query()` held by this process, and the pump closes it
when the last accepted message produces its `result`.

The inner scope stays, and so does the reason it is not the caller's (`Scope.make()`, because
the caller is an HTTP handler about to answer). What changes is who closes it: a map from
import id to `{ scope, harness, sessionId, instanceId, model, narrator }`, which is
`goalConversation.ts`'s `live` map with an import id as its key.

**A scope in no map is a scope nothing can close.** That is not a hypothetical: it is the bug
a review measured against the running server for goal conversations, where two concurrent
first messages opened two sessions and `live.set` kept one — leaving the loser's credential
and registration alive until process death. So S2 takes the same permit (`Semaphore` per
import id, re-read inside it) and takes it for the same reason.

### S2.2 — The list of things that close it, and it is the whole list

1. **The operator ends the session.** A route, and the only intentional close.
2. **This layer's finalizer**, which closes every scope still open. A `SIGINT` ends every
   importer conversation, which is what makes "no longer than the process" true.
3. **A prompt the harness refuses.** `goalConversation.ts`'s `deliverInto` closes the session
   when `prompt` fails, so the _next_ message opens a fresh one rather than failing the same
   way forever. On Claude Code that case includes a session whose query has closed.

**No idle timeout**, and that is a decision rather than an omission. The goal path's header
makes the argument and it transfers without modification: an idle conversation costs an entry
in a map and, on Claude Code, one parked `query()` whose generator is waiting on a promise;
neither accumulates with time and both die with the process. A timeout would introduce the one
failure this design exists to avoid — a conversation that stops working for a reason the
operator cannot see — in exchange for releasing memory bounded by the number of imports an
operator has open. If a bound is ever wanted it is a count, not a clock.

### S2.3 — The credential loses its clock

`IMPORT_LIFETIME_MS` is 30 minutes, chosen as a backstop that could not expire mid-import
when an import was one batch of page reads. A conversation the operator leaves and comes back
to blows through it, and the symptom is the worst available one: the session is alive, the
chat accepts a message, and every tool call is a `401` the operator cannot see a cause for.

**Issue it without a clock expiry, as a goal's is.** `McpCredentials.issueWithoutExpiry`
currently accepts a goal binding and only a goal binding — its parameter type is what enforces
that — so S2 widens it to accept an importer binding. Not "lengthen the lifetime": a longer
clock is the same failure further away, and the reason a goal's has no clock is that the
bounds in S2.2 are better bounds than a clock is.

Rejected: **reissue per turn.** The token is carried in the MCP registration's
`authorization` header, so a new token means unregistering and re-registering the server
every turn — churn, plus a window in which the session has no tools, in exchange for a
shorter grant on a session the operator is actively watching.

### S2.4 — `import_sessions.ended_at`, which is the one thing this adds beyond the goal path

A goal's no-expiry credential has a second gate behind it: `store.checkGoalAuthority` refuses
every write under an ended goal, so even a leaked grant writes nothing. **An import has no
such gate** — the importer toolkit writes under `caller_scope = <target>/import/<importId>`
and nothing consults a status — so a no-expiry importer credential whose scope was somehow
not closed is a grant with nothing behind it.

So: `0026_import_session_end` adds `ended_at` to `import_sessions`, set when the session is
closed, and the importer toolkit refuses a write whose import has ended. This is the direct
analogue of `checkGoalAuthority`, it costs one column and one `WHERE`, and it makes the
durable record of "this conversation is over" the same object the picker already reads.

It also pays for itself on the screen: `ended_at` is what lets the picker mark a session
closed instead of inferring it from the absence of a live entry in this process's memory.

### S2.5 — Reviving a session, and the one place the two harnesses genuinely differ

Within a process, nothing needs reviving: an idle session is promptable, which is S3.

Across a **close**, revival is real on both drivers. The harness still holds the session and
its messages; what was lost is ours — a credential from an in-memory map and a registration.
Reopening is: reissue, re-register, prompt the same session id. The agent gets its own prior
context back from the harness, because that context was never ours.

Across a **restart**, revival is driver-dependent, and this is the honest statement of it:

- **OpenCode** — revivable. The session lives in OpenCode's own server. Registration is
  directory-scoped (DECISIONS §24.2), so re-registering into the import's directory is the
  same call that made it in the first place.
- **Claude Code** — not revivable. `claudeCodeClient.ts` says it in as many words: _"a Claude
  Code session does not outlive the process that spawned it."_ There is no `resume` on
  `createSession` and no `resumeSessionId` in the client. A restart means a new session.

Both drivers can still **read** a dead session's messages — Claude Code's `messages` calls
`sdk.sessionMessages`, which reads the transcript from disk for a session this process does
not hold. So after a restart the chat can always show what was said; it is only continuing
that is conditional. That split is exactly S6's `Retained | NotHeld`, and D1's "Continue that
session" strip must read it: on a Claude Code session from a dead process the strip offers a
new session with a sentence saying so, in the register `goalConversation.ts`'s
`priorUnavailable` note already uses.

### Done criteria

- [ ] `createSession` is called with `multiTurn: true`; a test asserts the flag reaches the
      client.
- [ ] A per-import `live` map holds the `Scope.Closeable`; a `Semaphore` per import id guards
      opening, re-read inside the permit.
- [ ] A test opens two concurrent conversations on one import and asserts one session, one
      credential and one registration.
- [ ] `issueWithoutExpiry` accepts an importer binding; the importer's credential has no clock
      expiry; a test asserts a call succeeds after `IMPORT_LIFETIME_MS` of simulated time.
- [ ] Closing a session revokes the credential and unregisters the server. A belt-and-braces
      `revokeImport` after the close logs an error on a non-zero count, as `closeSession` does
      for goals.
- [ ] The layer finalizer closes every open session; a test asserts zero live grants after the
      layer is released.
- [ ] A refused `prompt` closes the session, so the next message opens a fresh one.
- [ ] Migration `0026_import_session_end` adds `ended_at`; set on close; the importer toolkit
      refuses a write under an ended import; `bun run test:persistence` covers both paths.
- [ ] `GET .../importer-sessions` reports `ended_at`, and does not report a session as
      resumable on a driver that cannot resume it.
- [ ] **No idle timeout exists**, and the module header says why.
- [ ] A single-link import through `createTarget` still behaves exactly as before: it writes
      its entries, settles `finished`, and its closing report still reaches the toast. The
      session now stays open afterwards, and that is the only observable change.

---

## S3 — Send a turn

### What it is

`POST /targets/:id/importer-sessions/:importId/messages`, carrying the operator's text. The
composer stops being decorative (D4).

### S3.1 — Two prompt assemblers, not one

`assembleImporterPrompt` carries the rules, the tool list and the links. A second message must
not repeat them: the session already has them in its context, and a resent preamble is both
waste and a contradiction risk. `plan/goalPrompt.ts` has the shape — `assembleGoalFollowUpPrompt`
beside the opener — and `importerPrompt.ts` grows the same pair.

### S3.2 — Delivery is a `steer` at `queued` urgency

The same seam and the same reasoning as a goal message (DECISIONS §24.1): work in flight
finishes, then the message runs. `preemptive` would cut off a tool call the agent was about to
report on, and an operator typing a second message has not asked for that.

### S3.3 — The import id is reused, which is S1's constraint

A second turn writes under the same `caller_scope`, so the picker's tally keeps counting. A new
`import_sessions` row per turn is the alternative and is wrong: the row is a _session_ index,
and one session would then have several.

### S3.4 — A session the operator opens with no links

Today an import exists because `createTarget` was given links. The Assets screen's composer can
open one with none: no links, no opener full of URLs, just the operator's message. `start` must
stop treating zero links as `{ _tag: "none" }` on this path — that answer belongs to the
create-target route, which asked a different question.

### S3.5 — Model options, decided here

`ScopeImportRequest.choice` carries an instance and a model and deliberately no `modelOptions`:
reasoning depth on a single-turn extraction session was a control for nothing, and the field was
plumbing with no caller. **A multi-turn conversation makes it a control for something**, which
is why this is the slice that decides. The recommendation is to add it: the picker on the Assets
screen already renders an options column for every other harness surface (`HarnessChoice.svelte`),
and an importer that is now a conversation is no longer the odd one out. If it is added,
`ImportModelDraft`'s comment explaining its absence is deleted rather than left to contradict the
code.

### Done criteria

- [ ] The route exists, is authenticated like its neighbours, and refuses an unknown or ended
      import with the refusing component's own sentence.
- [ ] A follow-up assembler exists; a test asserts the second prompt carries no copy of the
      rules or the link list.
- [ ] Delivery is `steer` at `queued`; a test asserts the urgency.
- [ ] A conversation opened from the Assets screen with no links works and is not answered
      `none`.
- [ ] A second turn's writes appear in the session's tally.
- [ ] The composer in `ImporterChat.svelte` posts to the route and clears on acceptance; its
      disabled states (no harness, stranded session, ended session) come from the server.
- [ ] Model options: either on the wire with the picker's column live, or a one-paragraph
      record of why not.

---

## S4 — Live narration

### What it is

`AgentHarness.sessionEvents` → the in-process narration bus → the chat. D3's prose and the
streaming cursor.

### S4.1 — Reuse `RunNarrations`, do not invent

The goal conversation forks a narrator per session into that session's scope and drains
`sessionEvents` onto the bus; `plan/goalNarration.ts` is the whole of it. The importer gets the
same narrator in the same scope, which also means S2's close already interrupts it — and
interrupts it _first_, so no entry is published for a session whose credential is about to go.

### S4.2 — This reverses half of D16, deliberately

D16 says the progress panel shows tool calls and nothing else, and `import/progress.ts`'s header
argues that narration _cannot_ be rendered because it is never captured. **That argument was
about the panel, and the chat is not the panel.** A single-turn batch job with no operator on the
other end has nothing to narrate to; a conversation does. So S4 subscribes, and D16's statement
is amended in the design record rather than quietly broken: the panel keeps its call list, and
the chat shows prose.

The closing-report read (`messages` after `waitForIdle`) stays as it is on the create-target
path, because that path still has no browser attached.

### Done criteria

- [ ] A narrator fiber per session, forked into the session's scope, interrupted before the
      scope closes.
- [ ] `turn.reply` and `turn.thinking` reach the chat; thinking renders collapsed and labelled,
      as the live transcript already does.
- [ ] The streaming cursor shows while a turn is in flight and clears when it idles.
- [ ] A stream that ends does not end the conversation: a log line, and the next message still
      reaches the session.
- [ ] D16's amendment is written into `2026-10-31-target-scope-design.md`.

---

## S5 — Tool rows on the feed

### What it is

`scope.entry.added` and `asset.imported` are real `EventKind`s (`event.ts:144` and `:169`) that
are not members of `LIVE_ITEM_KINDS`, so they cannot reach a chat. S5 adds them, carrying the call _and_
its result, because D3's receipt reads `→ entry 1 created`.

### S5.1 — The pairing gap, fixed at the source

`add_scope_entry` on an entry that already exists returns `created: false` and **writes no
record**. A feed that pairs the Nth call with the Nth record then shifts every later pair. Two
candidate fixes:

- Emit a record for the no-op case, with `created: false` on it. The feed pairs by position and
  the row reads "already in scope", which is both true and useful.
- Pair by an explicit id rather than by position.

The first is preferred: it fixes the data rather than teaching every reader to compensate, and
"the agent tried to add something already there" is information an operator reviewing an import
wants.

### S5.2 — Nothing links a record to the message it answered

This is the question D6 surfaced and the one S5 has to answer rather than discover. After a
reload, records are durable and the harness's messages may not be, and nothing on the wire says
which message a record answered — so `importerChat.ts` puts unattributed records in a leading
"earlier in this session" group rather than guessing by timestamp (`LiveItem.at` is documented as
not an ordering key).

If per-turn placement is wanted, the wire must carry it: a turn ordinal on the record, minted
when the message is accepted and stamped on every write under it. That is a column on
`scope_entries` and `asset_imports`, or a side table. **The recommendation is not to**: the
leading group is honest, it is already built and labelled, and a turn ordinal is a durable schema
cost for a cosmetic grouping on a screen whose durable half — the entries themselves — is
reviewed on the Assets list anyway. Decide it here either way; do not leave it open past this
slice.

### Done criteria

- [ ] `scope.entry.added` and `asset.imported` are in `LIVE_ITEM_KINDS` with doc comments in the
      register of their neighbours.
- [ ] A tool call and its result render as one folded row, with the receipt text.
- [ ] A no-op `add_scope_entry` produces a row that says so; a test covers the pairing across a
      no-op.
- [ ] The record-to-message question has a written answer in this document.

---

## S6 — History replay

### What it is

`AgentHarness.messages` → the five answers `ImporterHistory.source` already declares
(`loading | none | harness | pending | forgotten`) → `RoundProse`. Reopening an old session, and
the tombstone.

### S6.1 — `GET .../importer-sessions/:importId/messages`

Oldest first and all of them, which is what the seam now promises after the `openCodeClient`
fix (`order: "asc"`, paged). Reduced to the `{ role, text }` shape the goal replay already
answers with, so `ImporterChat.svelte` needs no second renderer.

### S6.2 — `forgotten` is a real state on both drivers, for different reasons

Claude Code deletes transcripts after 30 days; OpenCode's retention is its own. A session whose
messages are gone is not an error — it is a session with durable entries and no prose, and D6's
tombstone is the correct rendering of that. The entries are still on the Assets list, which is
what makes losing the prose acceptable (DECISIONS §8: the conversation history is the harness's
and we do not keep a copy).

### S6.3 — The replay and the live feed must not double up

The goal chat solves this with a narration floor the caller owns; `importerChat.ts` already takes
replayed turns first and live ones after, and expects the caller to hold the floor. S6 supplies it.

### Done criteria

- [ ] The route exists and answers the reduced shape, oldest first, with a `truncated` flag.
- [ ] All five `source` values are reachable and each renders its own sentence; a test covers
      `forgotten`.
- [ ] A session reopened after a close shows its history and accepts a new message (OpenCode).
- [ ] A session from a dead process on Claude Code shows its history and offers a _new_ session
      with a sentence saying why, not a composer that will fail.
- [ ] No message appears twice across the replay/live boundary.

---

## Deferred

- **A concurrent-import guard on one target.** The server does not prevent two imports on one
  target. S2's permit is per import id, which is a different thing. Harmless today — both write
  entries and `ON CONFLICT DO NOTHING` holds — and worth a named decision later.
- **B5's "Move to out of scope instead" CTA** on the delete-asset confirm. Needs an atomic
  server-side effect-change operation, which none of these slices builds.
- **Dead code from the single-turn era**: `ScopeImportPanel`, the unreachable `importerPhase`,
  and `createTarget`'s `programLinks`/`importModel` once the Assets screen owns the import.
  Clean up after S3.
- **`docs/uat-target-scope.md`** covers neither the importer nor create-target. Rewrite after S6.

## Build order

S1 → **S2** → S3 → S4 → S5 → S6. S2 before S3 and not alongside it: S3's route is meaningless
against a session that destroys itself, and writing them together means writing S3 twice.
