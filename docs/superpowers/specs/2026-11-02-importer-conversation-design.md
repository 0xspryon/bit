# The agent conversation — API design

> Eight slices that turn the mock-driven importer chat into a real one — written for the
> importer, built so the goal agent and the worker attempt inherit it rather than repeat it.
> See "The generic spine" for what is shared and where the sharing honestly stops. Written
> after slice 1 shipped, so S1 records what was built rather than what was planned.

## State of play — 2 Nov 2026

**Merged to `main`**, each verified green at merge:

| Slice | What landed                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | The session index (`import_sessions`, `0024`/`0025`)                                                                                                     |
| S2    | `LiveAgentSessions` extracted from the goal path; the importer session outlives its turn; no-clock credential; `ended_at`/`ended_reason` (`0026`/`0027`) |
| S3    | Open and continue a conversation; citable pages; the in-flight guard; `0028`/`0029`                                                                      |
| S3.5  | The Reasoning column, resolved options reaching `createSession` and recorded                                                                             |
| S4    | Live narration — a fourth `import` tag on the narration bus                                                                                              |
| S5    | `scope.entry.added` and `asset.imported` on the feed, folded into their calls                                                                            |
| S6    | Replay from the harness, and resuming a session this process no longer holds                                                                             |
| S8    | One list of every agent session, under Operations                                                                                                        |
| S7a   | Recovery tells the truth after a restart: `activity` on `SessionStatus`, the `abandoned` answer                                                          |

Gates on `main`: **1540 server · 455 web · 84 DOM · 971 persistence**, migrations contiguous `0001`–`0029`.

**In flight:** S7b — the continuation turn.

**Still to do:**

1. **S7b** (in flight): the dispatched continuation, the summary for worker attempts only, the chained-continuation cap, the outbox dispatcher, the opt-out.
2. **Narrow the importer session's tool set.** Recorded under Known defects. The three MCP tools are the only ones that can _write_, but the session also holds whatever else the harness gives it — a live run used `Bash` to `curl` a page. The gated directory is the control and always was; the sentence we showed the operator was what was wrong, and that is already corrected. The fix is `allowedTools` on `createSession`, done with a live import to verify against, because the live run reached for `curl` rather than `WebFetch`.
3. **Importer liveness in the S8 list is a lower bound.** A session held open _between_ turns — exactly what S2 built — reads "Not running", because the registry only exposes "a run is in flight". Needs `scopeImporter.ts`, which was off-limits while S6 and S8 ran in parallel.
4. **A third state in the S8 list.** A restart leaves goal conversations and unended importer sessions neither live nor ended — nothing recorded their authority ending, which is `ended_reason` working as designed. "Not running" is the honest reading; S8.1 says "live or ended" and should say three.
5. **`goal_sessions` has no model column**, so a dormant goal shows "model not recorded". A migration, held back while slices were taking `0028`/`0029`.
6. **The end-to-end pass**, now possible on both drivers.

## What has been verified against live agents, and on which driver

This matters because several claims in this document were wrong until someone ran them.

- **Claude Code (`claude-sonnet-5`)** — live narration with real timings (prose under the right message before the turn settled); records folded into their calls, including across a no-op; replay and resume across a real server restart, with the agent quoting its earlier reply.
- **OpenCode (`zai-coding-plan/glm-5.3-flash`)** — open, continue, and resume across a restart that killed the `opencode serve` holding the session, with the resumed agent quoting _both_ earlier replies verbatim; `turn.reply` **and** `turn.thinking` reaching the feed keyed by `importId` (Claude Sonnet emitted no thinking, so that had been test-only); `scope.entry.added` carrying `importId: null` for an operator's own entry, confirming the isolation rule; the recovery sweep's before/after on a real abandoned session.

**Not observed live:** the `fresh`-session fallbacks (a swept transcript, a metadata-only transcript, an ungated directory), a refused tool call, and a retried asset call. All test-only, and all say so.

## Environment notes, rediscovered too many times

- The browser reaches the control plane **same-origin through vite's proxy**; the server serves **no CORS headers**, so the Connect screen's Server URL must be the vite origin, never the API port.
- The stored server password is an **argon2id hash and unrecoverable**. Set `BIT_PASSWORD` at boot to know it.
- `preview_*` tools are unreliable here. **Headless Chrome over CDP works.**
- A synthetic `el.click()` does **not** fire Svelte handlers — dispatch a real mouse event.
- `bun run format` rewrites `sprint-roadmap.html`, which is the one file `format:check` is expected to fail on. Do not run it.
- A dev server may be serving a **git worktree rather than the main checkout** — check `/proc/<pid>/cwd` before trusting a measurement.

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

## The generic spine, and where it honestly stops

There is already a long-lived agent session in this process, and it is not the importer:
`plan/goalConversation.ts`. It is created on the operator's first message, prompted again for
every message after it, holds its credential and its MCP registration in a per-session `Scope`,
and ends when something closes that scope or when the process dies. Its module header is a
written argument for every one of those choices.

**The importer is the second of four, and the worker and planner are the other two.** So the
instruction for S2 is _extract_, not copy. A transliteration would produce the second of four
copies of the same lifecycle, and the fourth is the one nobody will reconcile.

### What is genuinely one implementation

A service — call it `LiveAgentSessions` — owning the part of a session that is about
**authority and lifetime**, and nothing about what the session is for:

1. **The registry.** `id → { scope, harness, sessionId, instanceId, model, narrator }`, plus
   the per-id `Semaphore` that guards opening. A scope in no map is a scope nothing can close,
   and a review already measured that bug on the goal path: two concurrent first messages, two
   sessions, the loser's credential and registration alive until process death.
2. **The acquire order**, because each step rules out the next step's ambiguity: gated
   directory → session → credential → MCP registration → prompt. A failure at any step closes
   the scope, which revokes the credential and unregisters the server — including when the
   _next_ step is what failed.
3. **`closeSession`.** Narrator interrupted first, so nothing is published for a session whose
   credential is about to go; then the scope; then a belt-and-braces revoke whose expected
   answer is zero and whose non-zero answer is a logged bug rather than a handled condition.
4. **The layer finalizer**, closing every session still open, which is what makes "no longer
   than the process" true.
5. **The session index.** One row per session, written before the session exists and marked
   once the harness confirms it — `goal_sessions` (`0021`) and `import_sessions`
   (`0024`/`0025`) are already the same table twice.
6. **The chat.** `Chat.svelte` is already generic: groups plus a `separator` snippet, with the
   group's subject an opaque type parameter. `RoundProse`, `rowsFor`, the record-versus-activity
   distinction and the folding of a tool result into its call are shared with it.
7. **The restart sweep** (S7): terminalize every non-terminal run _first_, then dispatch.

### What stays per-surface, as a descriptor rather than a fork

Role and endpoint URL; credential kind and lifetime; `multiTurn`; the prompt assemblers, opener
and follow-up; the grouping rule; whether there is a settlement; and the continuation shape. The
four role endpoints already exist and `authMiddlewareFor` already refuses a grant whose tag is
not the role it serves, so "which tools this session can reach" is a property of the
registration rather than of a filter — that part needs no generalising, only passing through.

### Where the abstraction stops, and this is the important line

**A worker attempt is not a conversation.** It is supervised, it has an attempt identity, a
fence, a settlement table and an outcome; it is prompted once and nobody is on the other end of
it. It shares the spine's _authority lifetime_ — scope, credential, registration, close — and it
shares none of the conversation semantics: no follow-up assembler, no chat grouping, no
composer.

So the spine owns **how long a session's authority lives and who can end it**. It does not own
what a session means. An abstraction that tried to own both would have to invent a settlement
for a goal conversation and a composer for a worker, which is exactly the failure
`Chat.svelte`'s own header records having already been caught once.

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

**Amended: `ended_at` alone conflated two events, so `0027` records why.** Every close stamps
`ended_at`, the layer finalizer's included — so as first built, a graceful shutdown ended
every open import (and refused its writes forever) while a crash ended none, and S7 could
never continue a gracefully restarted import. `0027_import_session_end_reason` adds
`ended_reason`: `operator` | `shutdown` | `refused` | `open_failed`, written with `ended_at`
by the first close and never cleared. **The toolkit refuses writes only on `operator`**, the
one case where the authority is genuinely over; the other three are this process letting go,
and the credential behind them is already gone with the in-memory grant.

The rule: `ended_at` plus `ended_reason` describe one _authority period_. A session may have
several, and **the import id is what changes between them** — a later opening gets a new
import id and a new row rather than reviving an ended one. The index still reads them as one
session, because it groups by `harness_session_id` and tallies across every `caller_scope`
of the session. S3.3's reuse of the import id is _within_ one authority period.

### S2.5 — Reviving a session, and what each harness actually keeps

**Researched rather than assumed, after an earlier draft of this section got both drivers
wrong.** The sources are the installed `@anthropic-ai/claude-agent-sdk@0.3.310` declarations,
OpenCode 2.x's own source, and T3 Code's Claude adapter, which has shipped this for a while.

Within a process, nothing needs reviving: an idle `multiTurn` session is promptable, which is
S3.

Across a **close**, revival is real on both drivers. The harness still holds the session and
its messages; what was lost is ours — a credential from an in-memory map and a registration.
Reopening is reissue, re-register, prompt.

Across a **restart**, revival is _also_ real on both drivers, and the reason is the same in
both cases: the conversation was never ours and was never in memory.

|                                       | Claude Code                                                                                                                                                            | OpenCode                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Where the conversation lives          | the CLI's own JSONL transcript under `~/.claude/projects/<dir>/<id>.jsonl`                                                                                             | one SQLite file at `$XDG_DATA_HOME/opencode/opencode.db`                                                                    |
| Read its messages after a restart     | yes — `getSessionMessages`, which searches every project when given no `dir`                                                                                           | yes — the messages route is a plain row read with no location middleware                                                    |
| Continue the conversation             | yes — a **fresh** `query({ options: { resume: id } })`. The SDK's own `forkSession` doc says the result is "Resumable via `query({ options: { resume: sessionId } })`" | yes — `POST …/prompt`. Session lookup, admission and model context are all DB reads; nothing in-memory is required          |
| Auto-resume a turn that was in flight | no                                                                                                                                                                     | **not for us** — the sweep runs only when a lifecycle is attached, which is `--service` mode only; we spawn `serve --stdio` |

**So "a Claude Code session does not outlive the process that spawned it"
(`claudeCodeClient.ts:1630`) is true of the live `Query` handle and false of the
conversation.** The SDK offers no re-attach to another process's query — control requests,
stream input and close all travel over the open stream — but it offers `resume`, and we have
never passed it. The non-use is ours, not the SDK's. The matching OpenCode comment in the same
file is simply wrong: a fresh server finds the session by primary key.

**MCP re-registration is not an obstacle.** `Query.setMcpServers` is a control request valid on
any live query, not only the one that first registered — so a resumed session can be given a
fresh bearer token. T3 Code does exactly this, and strips `mcpServers` out of the query options
for our reason: the SDK would pass them as an inline `--mcp-config` argv that any local user can
read. Our `registerMcpServer` seam is the right shape; what it lacks is the ability to run
against a session this process did not create (`recordFor` refuses the id), plus the
already-recorded gap that a late registration never re-pushes (§24.2).

**What this slice does with all that: nothing yet, deliberately.** S2 keeps a session alive
within one process, which is the whole of what S3 needs. Resume is a capability we now know we
have, and it belongs to S6 — where the question is already on the table as `Retained | NotHeld`
— because that is the slice that reads a session the operator came back to.

What S2 must do is **stop asserting the false thing**: the comments that say a session cannot
outlive the process are corrected in place, so S6 does not inherit a reason not to try.

### Caveats to carry into S6, each from the source

- **The import's directory must still exist.** OpenCode resolves a prompt through the session's
  _stored_ directory and answers `LocationNotFoundError` if it is gone. Our import directories
  are per-import under the fleet root, so a swept directory is a session that reads but cannot
  continue. Verify before relying on resume.
- **`sessionId` cannot be reused as a resume.** Passing `sessionId` for an id that already has
  turns fails "already in use"; turn two onward must pass `resume` instead. T3 Code decides this
  from a persisted turn count.
- **A resume can raise a dialog.** The SDK can answer a resume with a `resume_return`
  user-dialog — a compaction question — which has to be answered or the resume stalls.
- **A session killed before its first prompt was saved** leaves a metadata-only transcript that
  can be neither resumed nor created. The fallback is a fresh session plus a summary.
- **OpenCode's database filename depends on the build channel** (`opencode-<channel>.db` outside
  `latest|dev|beta|next|prod`, and `OPENCODE_DB` overrides both), so a channel change makes old
  sessions unreachable rather than missing.
- **Retention is the harness's.** Claude Code sweeps transcripts on `cleanupPeriodDays`; the
  default is not stated in the declarations. This is DECISIONS §8 as already accepted: the
  conversation history is the harness's and we keep no copy.

### A thing we are not building here, and the rule it would break

T3 Code's threads _appear_ to survive a reboot and carry on working. They do not: every
in-flight run is terminalized on boot with "cancelled because the server restarted", and a
project setting (`continueThreadsAfterServerUpdate`, default on) then dispatches a synthetic
`"Continue where you left off."` user message, with a note listing the cancelled background
work, capped at three chained continuations. The seamlessness is an automatic new turn, not a
resurrection.

bit should not take that for **worker attempts**: it is an agent resuming offensive work against
a target with no operator present, and `agentHarness.ts` already holds the opposing rule —
carrying work on after an interruption means a new attempt identity. Whether it is wanted for a
_conversation_ — importer or goal — is a separate decision, outside these six slices. If it is
ever taken, the dispatcher belongs on the transactional outbox (migration `0013`), which is
built and has no dispatcher; that is what it is for.

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
      _Amended by `0027`: the refusal is for an `operator` end only (S2.4)._
- [ ] `GET .../importer-sessions` reports `ended_at`.
- [ ] The two comments asserting a session cannot outlive the process — the Claude Code
      sentence at `claudeCodeClient.ts:1630` and the OpenCode claim beside it — are corrected
      to say what is actually true: the live handle dies, the conversation does not. S6
      inherits no reason not to resume.
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

### S3.3 — The same import id within one authority period, a new one per opening

A second turn in a live conversation writes under the same `caller_scope`, so the picker's
tally keeps counting. A new `import_sessions` row per _turn_ would be wrong: the row is a
session index, and one session would then have several.

**But a new opening is a new import id**, and that is the correction S2's review forced.
`ended_at` plus `ended_reason` describe one _authority period_, not a session: a session may
have several, and the import id is what changes between them. So "the session was closed, the
operator sends another message, a fresh one opens" mints a new id rather than reviving the
ended one — `ended_at` is never cleared, and a fresh session under an ended id would have
every write refused.

The **tally** absorbs this for free: the session query groups by `harness_session_id` and the
tally counts across every `caller_scope` of the session, so a new id per opening keeps counting
correctly.

**The session row does not, and an earlier draft of this section was wrong to say it did.**
Until S6's resume lands, a reopen is a _new harness session_, so the picker gains a second row
and the composer moves to it — one conversation shown as two. That is the honest degradation
and the picker should not pretend otherwise. It becomes genuinely free only when a reopen can
resume the same harness session, which is S6.

**Half of that cost is now gone, and S6 says which half.** When the harness still holds the
session and resolves it in a directory this server gates, a reopen passes `resume` and the
successor import runs on the **same `harness_session_id`** — so the session index, which
groups by that column, shows one conversation as one row again, the composer stays on it, and
the tally keeps counting. The accepted turn says `conversation: "resumed"` rather than
`"opened"`, and the chat's thread continues rather than starting over.

**The import id still changes, and that half is not a degradation.** An import id names one
_authority period_: the credential behind the old one died with the process that held it,
`ended_at` is never cleared, and a fresh session under the old id would have every write
refused. A new period gets a new id and a new row. That was never the cost the picker paid —
the index groups by session and tallies across every `caller_scope` of it — so there is
nothing left to pay off.

**What remains is the case the harness cannot answer for**: a swept transcript, a session
killed before its first prompt was saved (neither resumable nor re-creatable), a session the
harness resolves in a directory this server does not gate, or a harness that could not be
asked. Each of those is still a new session and still two rows, and the replay says which and
why before the operator types — `ImporterConversationView.continuation`, which is `resume` or
`fresh` and never a guess.

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

### S4.4 — Narrated tool rows stay, and that shrinks S5

Tool calls and their results arrive on the **same narration stream** as prose, so turning the
narrator on put them in the chat whether or not anyone asked. They stay: the goal chat shows
them the same way, and building a filter to hide information the operator wants — then deleting
that filter one slice later — is work in both directions for nothing.

So **S5's remit narrows** to what narration genuinely cannot give: the durable _records_
(`scope.entry.added`, `asset.imported`) and the pairing of a record with the call that wrote it.

### S4.5 — The cursor clears on the server's status, because the stream has no idle signal

S4's done criteria said the cursor "clears when it idles", which assumed the narration stream
could say when a turn was over. It cannot. The page polls the import's own `running` status
instead, so the cursor can stay on for up to one poll interval (~900ms) after the agent's last
word. Treating silence on the stream as idle would be a guess, and a cursor that vanishes
mid-sentence is worse than one that lingers.

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

`scope.entry.added` and `asset.imported` are real `EventKind`s (`event.ts:169` and `:144`) that
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

**Built that way.** `addScopeEntry`'s no-op branch appends a `scope.entry.added` naming the
existing entry, with `created: false`, and touches nothing else; the added branch now says
`created: true`. The session tally (`selectImportSessions`) counts only records whose `created`
is true or absent, so the no-op record does not inflate the picker's figures. The no-op branch
writes for every caller, the operator's Scope tab included — the store does not distinguish
them, and an operator's no-op is no less a fact.

**The asset side had no no-op gap.** `importAsset` already appended `asset.imported` with
`created` read off the insert, for a host new or already known. What it does not record is an
**exact retry** — the same `operation_id` replays the stored receipt and writes nothing — and that
is idempotence working, not a gap: a record there would claim a second write that never
happened. A **refused** write of either kind likewise has no record (the transaction rolls back).
For those two cases only, the reader does compensate, and from the call's own result rather than
a guess: `pairWrites` skips a call whose result is `failed` or says `replayed: true`. Neither is
a case the data can fix.

### S5.2 — Nothing links a record to the message it answered

This is the question D6 surfaced and the one S5 has to answer rather than discover. After a
reload, records are durable and the harness's messages may not be, and nothing on the wire says
which message a record answered — so `importerChat.ts` puts unattributed records in a leading
"earlier in this session" group rather than guessing by timestamp (`LiveItem.at` is documented as
not an ordering key).

If per-turn placement is wanted, the wire must carry it: a turn ordinal on the record, minted
when the message is accepted and stamped on every write under it. That is a column on
`scope_entries` and `asset_imports`, or a side table.

**Decided: no turn ordinal.** The leading "earlier in this session" group is honest, already
built and already labelled, and a turn ordinal is a durable schema cost for a cosmetic grouping
on a screen whose durable half — the entries themselves — is reviewed on the Assets list anyway.
This is a ruling, not a deferral; do not reopen it without a use beyond grouping.

The ruling covers records after a **reload** only. Live records already sit under the message
they answered: `importerFeed` places narration by publish-order floor against each operator row,
and a record arriving live lands among the narration around it, so it is grouped with the call
it answered and folded into it. A reload has no narration to place against, and its records go
to the leading group.

### Done criteria

- [x] `scope.entry.added` and `asset.imported` are in `LIVE_ITEM_KINDS` with doc comments in the
      register of their neighbours.
- [x] A tool call and its result render as one folded row, with the receipt text.
- [x] A no-op `add_scope_entry` produces a row that says so; a test covers the pairing across a
      no-op.
- [x] The record-to-message question has a written answer in this document.

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

### S6.4 — Continuing a session this process no longer holds, and the two checks it needs

`AgentHarness.createSession` takes a `resume`, and the spine passes one or the other — never
both, because the Claude Agent SDK documents `sessionId` and `resume` as mutually exclusive
and refuses a `sessionId` that already has turns ("already in use"). On Claude Code a resume is
a fresh `query({ options: { resume: id } })`; on OpenCode `createSession` does nothing at all
and the ordinary prompt continues the row.

**The `resume_return` dialog cannot stall us, and that is checkable rather than hopeful.** The
SDK emits a `request_user_dialog` only for a `dialog_kind` the client declared in
`supportedDialogKinds`, and its own doc says "omitting the option entirely means no dialogs are
emitted, even with `onUserDialog` wired". We pass neither, so a dialog-gated flow degrades to
its no-dialog behaviour. If either option is ever added, this caveat comes back.

**Whether a session can be continued is a seam question, not an assumption**:
`AgentHarness.sessionContinuation` answers `resumable` with the directory the harness resolves
the session in, or `unresumable` with a reason. Claude Code answers it from
`getSessionInfo` — no info is a swept transcript, info with no `firstPrompt` is the
metadata-only transcript that can be neither resumed nor recreated, and info with one is
resumable in its `cwd`. OpenCode answers it from `session.get`, reading `location.directory`
and deliberately **not** `outcome`: that field is the one the recorded OpenCode recovery defect
turns on, and nothing added in S6 reads it.

**The directory is checked, and the reason is authority rather than resume.** Both drivers
resolve a conversation through the directory it was created in, so a swept directory is
OpenCode's `LocationNotFoundError` — which `ensureImportDirectory` fixes by recreating it. But
the pre-execution policy gate lives _in_ that directory, so a resume into a directory this
server did not gate is an agent whose tool calls nothing is consulting. The path the harness
reports is therefore required to be one of **this target's own import directories**, rebuilt
from the id in its last segment through `FleetPaths.importDirectory` and compared; anything
else, including a harness that reports no directory, is a fresh session. That also means the
resumed session is gated and run in the **original** import's directory, not the successor's.

### Done criteria

- [x] The route exists and answers the reduced shape, oldest first, with a `truncated` flag.
- [x] All five `source` values are reachable and each renders its own sentence; a test covers
      `forgotten`.
- [x] A session reopened after a close shows its history and accepts a new message. _Verified
      against Claude Code live, and in tests for both paths; OpenCode's free tier and the z.ai
      plan were exhausted, so the OpenCode driver's half is tests only._
- [x] A session from a dead process shows its history and offers either a continuation or a
      _new_ session with a sentence saying which and why, never a composer that will fail.
      `ImporterConversationView.continuation` is the field, and `ScopeImporter.send` acts on
      the same function that answers it, so the promise and the behaviour cannot drift.
- [x] No message appears twice across the replay/live boundary. Two mechanisms, because there
      are two kinds of duplicate: narration is dropped at or below `historyFloor`, the activity
      publish order taken before the read; and the replay is asked for **once**, when a session
      is opened and before anything is typed into it, so this tab's own `turn.operator` rows
      cannot collide with the `user` entries the harness holds for the same sentences.

---

---

## S7 — Continuation after a restart

Decided by the operator on 2 Nov 2026, after the research in S2.5. **All three agent surfaces
get it**: the importer, the goal conversation and the worker attempt.

### S7.1 — It is a new turn, not a resurrection

T3 Code's threads appear to survive a reboot and carry on. They do not, and the mechanism is
worth copying exactly because its honesty is what makes it safe: on boot, every run left
non-terminal is **terminalized first**, with a reason naming the restart, and pending
permission requests are marked not-resumable. Only then is a fresh turn started, carrying a
synthetic operator message and a note listing what the restart cancelled. The agent reads its
own history and decides what to redo.

Nothing half-finished is ever presented as still running. That is the property to preserve.

### S7.2 — The trigger is a lost process, not a reboot

Any loss of the process that owned the work: a crash, a `SIGKILL`, an OOM, a deploy, an
operator restarting the server. The condition is "a run is non-terminal and the process that
owned it is gone", which `recovery/` already establishes for attempts.

### S7.3 — Two shapes, because an attempt is not a conversation

**The importer and the goal conversation resume the session.** A fresh
`query({ resume: <id> })` on Claude Code, an ordinary prompt on OpenCode, then the synthetic
continue message. The conversation is the unit, it keeps its identity, and the agent keeps its
own context from the harness's copy.

**A worker attempt does not.** The operator's decision: **end the interrupted attempt, open a
new one, and seed the new one with a summary of the dead attempt's transcript.** The summary is
for attempt workers only — not for the importer, not for the goal agent, both of which get
their real history back by resuming.

That split is the one that keeps `agentHarness.ts`'s existing rule intact rather than breaking
it: _carrying work on after an interruption means a new attempt identity_. A resumed attempt
would have made the settlement record lie about what a given attempt did. A new attempt seeded
with a summary says exactly what happened. It is also the shape T3 falls back to when a resume
fails — a fresh session plus a generated thread summary — so it is a travelled path, not an
invention.

Consequence worth stating: the summary is generated from the harness's own `messages()` read at
continuation time, which both drivers answer for a session this process no longer holds. We
removed the transcript writer at settlement (DECISIONS §8) and this does not bring it back.

### S7.4 — Open questions this slice must answer

- **How the summary is made.** A model call costs money and can fail on the recovery path, which
  is the worst place for a new failure mode; a mechanical reduction is free and worse. Decide,
  and make the failure non-fatal either way — a continuation with no summary is better than no
  continuation.
- **The bound.** T3 caps at three chained continuations in a five-minute window and refuses to
  continue at all when its settings cannot be decoded ("never resume threads on a guess").
  Without a bound, a crash loop becomes an auto-prompt loop that spends real money. Take the cap.
- **Where the dispatcher lives.** The transactional outbox (migration `0013`) is built and has
  no dispatcher. This is what it is for.
- **Whether the operator can turn it off**, per target or globally. T3 makes it a project
  setting defaulting on.
- ~~**Whether `serve --stdio` attaches OpenCode's own `resumeSuspendedSessions` sweep.**~~
  Settled: it does not. See "OpenCode sessions survive a restart" under Known defects.

### S7.5 — The first half, shipped: terminalize-first actually terminalizes

Done on 2 Nov 2026, as the half S7's continuation has to stand on. **No continuation was
built**: no synthetic turn, no dispatcher, no cap.

The property S7.1 asks for — nothing half-finished is ever presented as still running — was
not true, because the sweep could not tell a restart from a live turn. Both drivers now
answer "is a turn in flight" (`SessionStatus.activity`) separately from "how did the last
turn end", `harnessStatus.ts` has a fourth answer of its own (`abandoned`) for a session
that exists with nothing running it, and both the attempt and round vocabularies map that to
`uncertain` — which moves the row, bumps the fence and revokes the credential. Reproduced
live against a real restart mid-turn and covered by a real-SQLite sweep test. The full
reasoning, the reproduction and the `serve --stdio` answer are under Known defects.

Two things the continuation half inherits from it:

- **`abandoned` is not `missing`.** The conversation is still there — the live probe read its
  messages back and `sessionContinuation` answered `resumable` — which is exactly what the
  importer and goal paths will resume. Keeping the two answers apart is what makes a
  continuation decidable from a recovery record.
- **`uncertain` is still swept.** It is an open question the sweep re-asks, so a later
  definite answer can refine it. A continuation must therefore key off the _attempt_ being
  non-running, not off the row having been read once.

### Done criteria

- [x] On boot, every non-terminal run is terminalized with a reason naming the restart,
      **before** anything is continued. The reason is the harness's own sentence on the
      `attempt_recoveries` row (and in the `plan.round.settled` payload for a round),
      alongside `observed: "abandoned"`. _Pending permission requests do not apply: bit's
      policy gate decides allow/deny synchronously and holds no pending request to mark._
- [ ] The importer and the goal conversation continue by resuming their session; a test covers
      each.
- [ ] A worker attempt continues by ending the old attempt and opening a new one; the new
      attempt's prompt carries a summary of the old one's transcript; a test covers the
      end-to-new handoff.
- [ ] The summary is read from the harness, not from a transcript we persist, and a failure to
      produce it does not stop the continuation.
- [ ] A chained-continuation cap exists and is tested against a crash loop.
- [ ] The dispatcher rides the `0013` outbox.
- [ ] Nothing continues on a guess: an unreadable setting means no continuation.

---

## S8 — One list of every agent session

The last slice, and the one that pays the spine off: if four surfaces hold long-running
sessions, an operator needs one place that answers "what is running right now".

A tab **Agent sessions** in the rail, in the **Operations** group beside Workers, Blockers and
Event log (`apps/web/src/lib/mock.ts`, `navGroups`; it needs an entry in `navGlyphs` too).

### S8.1 — Nothing fancy, and that is the specification

A basic list. One row per session: which kind it is, what it is about, the harness and model it
runs on, when it started, whether it is live or ended, and whatever tally that kind already
derives. No grouping, no filters, no detail pane. The screens that show a session _properly_ are
the surfaces' own, and this one's job is to get you there.

### S8.2 — Read-time union, not a fourth table

The three indexes stay where they are and the route unions them.

A shared `agent_sessions` table is the obvious alternative and is wrong here: each index row is
written inside its own surface's transaction — a goal session with the goal, an import session
with the import — and one table would make a single write path the owner of three surfaces'
invariants. The subjects differ too (`goal_id`, `import_id`, an attempt's identity), so a merged
table means a nullable triple and a check constraint standing in for a type.

The list is a _read_ concern. Union at read, behind one route, and if a fourth table ever earns
itself the route's shape does not change.

Per target, not global: the rail is target-scoped, so the list is the sessions of the target you
are in.

### S8.3 — Clicking a row opens that surface's chat, and that part waits

Clicking an importer row opens the importer's chat on that session. Clicking a goal row opens
the goal conversation. That is the whole interaction.

**It cannot be built properly yet, because the app has no URL routing.** "Open the importer at
this session" is a deep link, and today navigation is in-memory state. So:

- Build the list and the route now.
- Wire the click to whatever in-memory navigation exists, if that is honest; otherwise leave the
  row inert.
- **Leave a comment in the list component** naming this: that the destination is a deep link,
  that it waits on real URL routing, and what it will look like when that lands. A comment the
  next reader finds is the deliverable here — not a half-built router.

### Done criteria

- [ ] `Agent sessions` appears in the rail under Operations, with a glyph.
- [ ] One route returns the target's sessions across every kind that has an index, as a
      read-time union; a test covers a target with sessions of more than one kind.
- [ ] The list renders kind, subject, harness and model, start time, live/ended state, and the
      per-kind tally where one exists.
- [ ] A target with no sessions says so rather than rendering an empty frame.
- [ ] A session whose harness is no longer configured is marked, not hidden — S1 already
      established `strandedOn` for this.
- [ ] The component carries a comment explaining that row-click deep linking waits on URL
      routing, and what it will become.
- [ ] No URL routing is invented for this slice.

## Known defects, found while building this and not fixed here

### "Three tools" is true of writing and false of the session

**Observed live during S5, on Claude Code.** Told to read a program page, the importer ran
`Bash` (a `curl`), and also had `Agent`, `WebFetch` and `ToolSearch` available to it.

The three MCP tools — `add_scope_entry`, `record_imported_asset`, `read_scope` — really are the
only tools that can **write** anything, and that part is structural: the endpoint selects the
toolkit and `authMiddlewareFor` refuses a grant whose tag is not the role it serves. But the
session is an ordinary harness session, so it also holds whatever that harness gives every
session, shell included.

**What held this up until now** is the gated directory, and `fleet.ts`'s comment is explicit
that this is the design: the importer "fetches a page and calls three tools — and that is
exactly why it gets its own gated one", because the policy hook lives in the directory a session
runs in. So the control was always the gate, never the tool list.

**What was wrong is what we said.** The operator-facing note claimed "its rules and its three
tools", and `scopeImporter.test.ts`'s comment asserts containment is structural because there
are "three tools and no others". On Claude Code that is not true, and the note has been
corrected to say what is: three tools that write, plus whatever the harness gives it for
reading, inside a gated directory.

**The fix worth making, as its own slice:** pass `allowedTools` on the importer's
`createSession` so the session holds the MCP trio plus what it needs to read a page, and nothing
else. The Claude Agent SDK takes it in the query options and T3 Code already pairs it with an
MCP allowlist wildcard. Two cautions: the live run reached for `curl` rather than `WebFetch`, so
restricting without checking which read path actually works would break imports; and the same
question applies to the planner, goal and worker sessions, which were never audited for it
either. Do it with a live import to verify against, not blind.

### OpenCode sessions survive a restart — fixed in S7's first half

**Found during S2's review, confirmed against OpenCode's source during S3's, surfaced from
the UI by S8, and reproduced live and fixed on 2 Nov 2026.** Kept here rather than deleted
because the reasoning is what the continuation half of S7 rests on.

`openCodeClient.ts`'s `sessionStatus` read `session.outcome`, which OpenCode fills from
`session_v2.idle_outcome` — written only on a terminal execution event. Two paths therefore
left a session that exists with no outcome after a restart:

- an unclean death, where no terminal event is ever written; and
- a **graceful** shutdown, where `projectIdle` returns early for an
  `Execution.Interrupted` whose `reason` is `"shutdown"`, writing neither `idle_outcome`
  nor `time_idle`. `coordinator.interrupt`'s reason defaults to `"shutdown"`
  (`core/src/session/execution.ts`, `terminal`'s `reason ?? "shutdown"`), so a server
  tearing its own executions down records nothing — deliberately, to support OpenCode's own
  restart continuity. An interrupt through the HTTP API is tagged `"user"` and does record.

`harnessStatus.ts` mapped "no outcome" to `running`, and reconciliation then recorded
`still_running`: the attempt row stayed `running`, the fence was not bumped, and a round was
left alone — so `openRound` refused every later round on that goal for ever. S8 put that row
on a screen, where a stale `running` attempt read **Live**
(`http/agentSessions.ts`: `attempt.status === "running" ? "live" : "ended"`).

**The fix is a second question, not a cleverer reading of the first.** `SessionStatus` now
carries a required `activity: "running" | "idle"` beside the optional `outcome`, and a
caller may believe the outcome only while `activity` is `idle`. On OpenCode it comes from
`GET /api/session/active` — _"foreground Session drains currently owned by this OpenCode
process; sessions absent from the result are inactive"_, backed by `SessionExecution.active`
— which is the server's own answer rather than an inference off `time_busy`/`time_idle`.
The active set is read **before** the session row, so a turn that terminalises between the
two reads is reported as still running rather than as abandoned: erring towards "ask again"
is recoverable, erring towards "abandoned" fences a live attempt. On Claude Code it comes
from the pump's `accepted`/`completed` pair, which `waitForIdle` already settles on.
`harnessStatus.ts` grew a fourth answer of its own, `abandoned` — the session is there,
nothing is running it, nothing ever recorded an outcome — which maps to `uncertain` for both
attempts and rounds. It is deliberately not `interrupted`: that is a terminal answer a
harness states, and nothing stated it.

**The smaller defect alongside it is fixed by the same field.** `Execution.Started` updates
`time_busy` and never clears `idle_outcome`, so a multi-turn OpenCode session mid-turn-two
reported turn one's outcome; Claude Code's pump overwrites `record.outcome` on each `result`
and had the identical problem from the other side. Both drivers now drop the outcome while a
turn is in flight, and `harnessStatus.ts` ignores one reported beside `activity: "running"`
as well, so a third harness that forgets cannot answer about the wrong turn through that
seam. It had not bitten because nothing read `sessionStatus` for importer or goal sessions
— S6 shipped without reading it, deliberately, and added `AgentHarness.sessionContinuation`
beside it instead — but worker attempts can be steered, so it was reachable.

#### The live reproduction

`spike/restartStatusProbe.ts`, run on 2 Nov 2026 against `opencode v2.2.5` and
`zai-coding-plan/glm-5.3-flash`. One session, one real turn, server A closed gracefully
**mid-turn**, server B spawned over the same database:

```
status while live (A)   {"activity":"running", ...}
server A closed         gracefully, mid-turn
GET /api/session/:id    {"data":{... "time":{"created":…,"updated":…,"busy":1793627661384} …}}
GET /api/session/active {"data":{}}
sessionStatus           {"activity":"idle", ...}            # no outcome field at all
before this slice       running    -> attempt stays 'running', fence unmoved, still_running
after this slice        abandoned  -> uncertain, fence bumped, credential revoked
sessionContinuation     resumable
messages still readable 2
```

And the same abandoned session, swept end to end through `spike/recoveryDemo.ts` — the
real startup sweep over a real database with a freshly spawned server — before the fix and
after it:

```
before   harness=running     status=running->running     disposition=still_running  fence=0->0
after    harness=abandoned   status=running->uncertain   disposition=uncertain      fence=0->1
```

The row is the projector's signature exactly: `time.busy` set, `time.idle` **absent**, and
no `outcome` key. The same session reported `activity: "running"` while its turn was in
flight, which is the distinction that did not exist before. Note also that the live server
exposes `time.busy` while the pinned `@opencode/schema@2.1.0` does not — another reason not
to build the answer on those timestamps.

#### `serve --stdio` does not attach OpenCode's own sweep — settled

The open question S7 was told to settle before building on this. **It does not attach it**,
and the gate is a `lifecycle`, not the mode:

- `server/src/process.ts` calls `installRestartContinuity` — the one `forkScoped` of
  `resumeSuspendedSessions` — inside `if (lifecycle)`.
- `cli/src/server-process.ts` passes a `lifecycle` only when `serviceOptions !== undefined`,
  and `serviceOptions` is read only for `options.mode === "service"`. All three modes
  (`default`, `service`, `stdio`) otherwise share one `start`.
- `server/src/fetch.ts:49` does fork it unconditionally, but that is `ServerFetch.make`, the
  entry for embedders that hand requests in (workerd, Deno, `Bun.serve`, a test harness).
  The CLI's `serve` never goes through it.

We spawn `serve --stdio`, so OpenCode is **not** resuming our worker turns, and the
auto-continuation S7 rejects for workers is not already happening behind us. The live probe
agrees: server B's `/api/session/active` was `{}` with an unfinished turn sitting in the
database.

The corollary matters for the fix: because nothing resumes, "absent from `active`" really
does mean "no turn of this session is running", and that is why the active set is a sound
basis for the answer. If an upgrade ever attached that sweep under `--stdio`, `active` would
start reporting our abandoned sessions as running again — which would be _honest_ (something
would indeed be running them) and would make the credential problem the real one to solve.

#### What this did _not_ fix: `narrated` has the same staleness one rank down

`run/settlement.ts` ranks the harness's answer first and the **narration's** terminal event
second. Both supervisors keep `narrated` as the last terminal `session.execution.*` the
stream carried, and that is per-_stream_, not per-turn — so a round whose first turn
terminalised and was then steered holds turn one's event in `narrated` while turn two runs.
Suppressing the stale outcome at rank 1 therefore narrows the window rather than closing it:
when narration is present it carries the same stale value, and the practical difference
appears only when the stream dropped, where settlement now reaches `interrupted` (for a stop)
or `uncertain` instead of asserting turn one's answer about turn two.

Left alone deliberately — this slice was not to change how an attempt or a round settles
beyond making its _recovery_ status honest. The fix would be to clear `report.narrated` when
a steer is accepted, in both supervisors, which is a settlement change with its own tests to
write.

#### One limit, stated

`session.active` reports drains owned by _this_ OpenCode process. The sessions live in one
SQLite file under the user's XDG data directory, so a different `opencode` could in
principle be executing a session of ours and our server would not see it. The answer would
then be `abandoned` → `uncertain`: our authority revoked over work that may continue. That is
the same disposition as an unreachable harness and the right direction to fail in.

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

S1 → **S2** → S3 → S4 → S5 → S6 → S7 → S8. S2 before S3 and not alongside it: S3's route is meaningless
against a session that destroys itself, and writing them together means writing S3 twice.
