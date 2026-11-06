# UAT — the scope importer as a conversation

> **2026-11-06:** the pre-execution policy gate this document mentions was removed at the
> operator's request, to be redone later. See the "Policy gate removed" entry in
> `docs/superpowers/plans/2026-11-03-a6-chat-revamp-breakdown.md`; the last commit with the
> gate is `635c1fc`.

Covers what shipped on 2 Nov 2026: slices S1–S6, S7a and S8 of
`docs/superpowers/specs/2026-11-02-importer-conversation-design.md`. Written to be worked
through in order; later parts depend on sessions created by earlier ones.

**`docs/uat-target-scope.md` is older and covers neither this nor the create-target screen.**
Use this document for anything to do with the importer; use that one for the scope model itself.

**Not covered, because it had not landed when this was written:** the dispatched continuation
after a restart (S7b). Part G tests only that recovery _reports_ honestly, which is S7a.

---

## 0 · Setting up

```bash
cd /run/media/hbt/work/bit
bun install --frozen-lockfile
BIT_PASSWORD=devpass bun run dev
```

`BIT_PASSWORD` matters: without it the server generates a password, prints it **once**, and
stores only an argon2id hash — there is no way to recover it afterwards.

Open the web app (vite prints the URL, normally `http://127.0.0.1:5173`). On the Connect screen
leave **Server URL at the vite origin** and enter the password. Do not point it at port 3000 —
the browser reaches the control plane through vite's proxy and the server serves no CORS
headers, so a direct port gives "No server answered at this address."

**Which harness.** Both work. `zai-coding-plan/glm-5.3-flash` on the `opencode` instance is the
cheaper one and emits visible reasoning; `claude-sonnet-5` on `claude-code` also works. The
free `opencode/*` models hit "Free usage limit reached" and will look like a broken importer.

---

## 1 · Scope by hand, as the baseline

1. Open a target → **Assets** → **Scope**.
2. On an empty target you should see **"No scope authored for this target"**, with
   _Auto-load scope…_ and _Add an entry by hand_.
3. Press _Add an entry by hand_. ✅ The **Add an entry** bar opens under the empty state
   (D1 draws none until it is asked for), with focus in its field. Add `atlassian.com` with
   **In** and _Apex and subdomains_.
   - ✅ A row appears under **IN SCOPE** reading `atlassian.com` · `and every subdomain`.
   - ✅ **OUT OF SCOPE** reads `0 entries` and `None.`
4. Add `id.atlassian.com` the same way. ✅ `IN SCOPE 2 entries`.
5. **Alignment check.** The page title, its subtitle, the `Estate | Scope` toggle, both section
   labels, `None.`, and the entry values should all sit on **one left edge**. The entry rows'
   hover highlight extends further left than their text on purpose — the _text_ is what must
   line up. Check at a tablet width and a wide window, with the side panel shown and hidden.
6. Delete one entry. ✅ A confirm dialog names the entry and says what removing it means.
   ✅ Focus stays on the list rather than jumping to the page body.

> **Known gap.** The confirm dialog has no _"Move to out of scope instead"_ action. It is
> specified (B5) and not built; it needs an atomic server-side effect change.

---

## 2 · Opening a conversation

1. **Assets → Scope → Auto-load scope…**
2. ✅ The page reads _"Load the scope for &lt;target&gt;"_ and offers to read a program page or
   take a pasted statement of work.
3. ✅ A model chip shows the resolved model, e.g. `o opencode/glm-5.3-flash-free`.
4. Click the chip. ✅ A picker opens with a harness rail, a filterable model list, and a
   **REASONING** column headed `Reasoning  variant`, listing Default (marked `DEFAULT`) through
   Maximum, under _"Only what you set here is sent…"_.
5. **At a tablet width (768px)** the picker stacks: the harness rail becomes a strip on top.
   ✅ Every harness stays visible and clickable without scrolling the rail, and the model list
   shows at least four rows.
6. Pick `zai-coding-plan/glm-5.3-flash` and set Reasoning to **High**.
7. Type `Reply with exactly: hello from the importer. Do not call any tool.` and send.
   - ✅ The composer clears.
   - ✅ The note says a new session was opened, and describes its authority as _"the three tools
     that let it write, and whatever its harness gives it for reading a page — all inside its own
     gated directory."_

> That sentence is deliberate. The three MCP tools are the only ones that can **write**, but the
> session is an ordinary harness session and also holds whatever else that harness provides — a
> live run used `Bash` to `curl` a page. The gated directory is the control. Narrowing the tool
> set is a recorded, unbuilt slice.

---

## 3 · Narration, records and the cursor

1. While the turn runs: ✅ a streaming cursor shows. It clears within about a second of the
   agent finishing — it is driven by the import's polled status, not by the stream, so a short
   lag is expected and correct.
2. ✅ The agent's reply appears **under your message**, and appears _before_ the turn settles.
3. ✅ If the model emits reasoning, it renders collapsed and labelled as what it is. GLM does;
   Claude Sonnet often does not.
4. Send a second message. ✅ It opens its own group, and the reply lands under **that** message,
   not the first.
5. Now ask it to do real work — paste a short scope list and ask it to record the entries.
   - ✅ Each tool call renders as **one row** carrying its receipt, e.g.
     `entry scope_… created · in · subtree · acme.com and every subdomain`.
   - ✅ Asking it to add the same entry twice gives a second row reading **"already in scope …
     nothing changed"** — and the rows after it still show their own receipts rather than
     shifting by one.
6. Open **Assets → Scope**. ✅ The entries the agent wrote are there, marked as imported.
7. ✅ An entry **you** typed in part 1 does **not** appear in the importer's chat. Records are
   filed by import, and a hand-authored entry belongs to none.

---

## 4 · Sessions, and coming back to one

1. Reload the page. ✅ The conversation is still there, replayed from the harness.
2. ✅ Your first message reads as **your words**, not as the server's assembled prompt — the
   opener's framing is trimmed off.
3. ✅ No message appears twice across the replay/live boundary.
4. ✅ A note says the prose comes from the harness and may be deleted by it, and that what the
   importer _wrote_ is durable and on the Scope tab.
5. Go back to **Assets → Scope**. ✅ A strip names the last importer session, when it was, and
   what it did, with **Continue that session**.
6. Click it. ✅ You land in that conversation.

---

## 5 · The Agent sessions list

1. Rail → **Operations → Agent sessions**.
2. ✅ One row per session across goal conversations, importer sessions and worker attempts, with
   kind, subject, harness and model, start time, state, and the importer's tally.
3. ✅ A target with no sessions says so rather than showing an empty frame.
4. ✅ A session whose harness is no longer configured is **marked**, not hidden.
5. Click an importer row. ✅ It opens that session's conversation.
6. Worker rows do nothing yet — row-click deep links wait on real URL routing, and the component
   says so in a comment.

> **Two known reporting gaps.** An importer session held open _between_ turns reads
> "Not running", because the list only sees "a run is in flight" — fix recorded. And a goal
> conversation that is not live shows "model not recorded", because `goal_sessions` has no model
> column yet.

---

## 6 · Surviving a restart

This is the part most worth doing carefully, and the one most likely to look broken if the
harness is out of quota.

1. With a conversation open and at least two turns in it, stop the server (`Ctrl-C`) and start
   it again with the same `BIT_PASSWORD`.
2. Reload the app and open that conversation.
   - ✅ The history is still there — it comes from the harness, not from us.
   - ✅ A note explains that this server no longer holds the session's authority.
3. Send another message.
   - ✅ The answer says `resumed`, on the **same harness session id**, under a **new import id**.
   - ✅ Ask the agent what it said earlier. It should quote its own earlier replies — which it
     can only do from the resumed transcript. _(Verified on both drivers.)_
4. ✅ The session list shows the conversation as **one** row, not two.
5. **Recovery honesty (S7a).** If a worker attempt or a round was running when you stopped the
   server, after the restart it must **not** still read `running`. It should be settled as
   uncertain, with its fence bumped.

> Why this used to fail: a gracefully shut-down OpenCode session reports no outcome, and that
> was read as "still running", leaving stuck rows. A comment claimed a restarted `opencode serve`
> had never heard of the old session — it has; sessions are rows in one SQLite file under the
> user's XDG data directory.

### 6b · The continuation that is dispatched for you (S7b)

Continuation is **on by default**. Turn it off globally or per target with `CONTINUATION=0`
at boot, the same way `BIT_PASSWORD` is set. A setting that cannot be decoded — `"true"`,
`"1"`, a typo — is a refusal, not a default: nothing continues on a guess.

1. Open a conversation and, **on its first turn**, ask for something long enough to still be
   running when you stop the server. Stop it mid-turn.
2. Restart. ✅ Without you sending anything, the conversation picks up: the agent is given a
   fresh turn and carries on, saying what it was doing when it was cut off.
3. ✅ The session list shows **one** `harness_session_id` with two `import_sessions` rows —
   one conversation, two authority periods.
4. ✅ A worker attempt does **not** resume. The interrupted attempt ends, a new one opens
   linked by `replaces_attempt_id`, and its prompt carries a **summary** of the dead one —
   a message count, the last reply bounded and marked where it was cut, and the first recorded
   error. If the transcript cannot be read, the block says so and the continuation still
   happens.
5. ✅ A crash loop does not become a spend loop: three continuations per chain in five minutes,
   counted off the outbox queue itself.

> **The limitation worth knowing before you test.** Continuation fires only for a conversation
> interrupted on its **first** turn. OpenCode never clears `idle_outcome` when a turn starts, so
> after a restart turn one's `succeeded` is still believed about turn two, and the sweep reads
> the session as finished rather than abandoned. On Claude Code the liveness half is missing
> too: its `sessionStatus` refuses outright for a session the process does not hold. Both fail
> **safe** — nothing is continued that should not be — and both are recorded as defects with
> their fixes, which were left alone because each changes what an attempt _settles_ to.

---

## 7 · Refusals, and the things that should be refused

1. **An ended session.** Stop an import from the panel, then try to send to it.
   ✅ Refused, with the importer's own sentence, and the composer is disabled with a note.
2. **A session the server merely let go of** (after a restart) stays **enabled** — a message to
   it reopens. Only an operator's explicit end refuses writes.
3. **Citable pages.** Paste a block of text that _contains_ URLs inside prose or inside a pasted
   page. ✅ Those URLs do **not** become pages the importer may cite. A URL on a line of its own
   does. ✅ The acceptance notice names which pages were added and which were not.
4. ✅ A URL with embedded credentials (`https://host@evil.example/x`) is rejected outright.
5. Ask the agent to record an entry citing a page nobody gave it. ✅ Refused.

> This is the sharpest edge in the whole feature. The agent reads untrusted program pages and
> writes the scope those pages describe, so **any provenance the agent can choose is
> forgeable**. The only pages it may cite are ones the operator supplied, and "supplied" means a
> URL the operator's message was _about_, not one that appeared somewhere inside it.

---

## 8 · What will look odd, and is meant to

- The streaming cursor lingers up to about a second after the last word. The narration stream
  has no idle signal; treating silence as idle would be a guess.
- Records that arrive with no operator message before them sit in a leading group,
  **"earlier in this session"**, rather than under a turn. Nothing on the wire says which
  message a record answered, and placing it by timestamp would be an invention.
- A reopen mints a **new import id** while keeping the same harness session. The id names one
  _authority period_, not a conversation.
- The free `opencode/*` models fail with a usage-limit error that looks like a broken importer.
  Check the harness before filing a bug.
