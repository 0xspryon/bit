# UAT — goal and planner flow

A step-by-step script for the work in `2a4b96b..HEAD`: target → goal → planner → intents →
attempts, the two chat surfaces, the context meter, and uploads.

**How to use this.** Work top to bottom — later parts rely on state earlier parts create.
Each step is an action and the one thing to look for. Tick as you go. If a step fails,
write what you saw next to it and carry on; later steps rarely depend on a failure.

**Time:** about 90 minutes for Parts 0–K, longer if you explore Part L.

**Labels:** button text is quoted as built. If a label differs slightly but the control is
obviously the one described, that is not a failure — note it and continue.

---

## Part 0 · Setup

**0.1** Open a terminal in the repo.

```sh
cd /run/media/hbt/work/bit
git log --oneline -1          # expect e69ab3c or later
bun install --frozen-lockfile
```

`[ ] pass  [ ] fail` ______________________________________________

**0.2** Make a clean workspace and target folder.

```sh
rm -rf /tmp/uat && mkdir -p /tmp/uat/workspace
printf 'hello from uat\n' > /tmp/uat/notes.txt
```

`[ ] pass  [ ] fail` ______________________________________________

**0.3** Start the app with every knob set explicitly, so later steps can change one.

```sh
HUNT_ROOT=/tmp/uat/hunt \
WORKSPACE_ROOT=/tmp/uat \
BIT_PASSWORD=uat \
GOAL_BRIEFING_MAX_CHARS=320000 \
PLANNER_ROUND_BUDGET=5 \
UPLOAD_MAX_BYTES=10485760 \
UPLOAD_MAX_FILES=10 \
bun run dev
```

→ Both apps start. Web on **5173**, server on **3000**.
**Do not move the server off 3000** — the dev proxy expects it there.

`[ ] pass  [ ] fail` ______________________________________________

**0.4** Open <http://localhost:5173> in a browser. Keep the terminal visible; several steps
read its log.

`[ ] pass  [ ] fail` ______________________________________________

> **Two things that are not your bugs.**
> `bun run format:check` fails on `sprint-roadmap.html` — it predates all of this.
> One test is skipped (`browserApi.test.ts`'s heartbeat case): timing-dependent, passes
> alone, quarantined on purpose with its history in a comment.
>
> **A gate that will lie to you.** `bun run typecheck`, `test` and `build` replay Turbo's
> cache and print as though they ran. Add `--force` when you want a real run. A reviewer in
> this work reported green gates that were entirely cache replays.

---

## Part A · Getting in, and a target

**A.1** With no session, look at the app.
→ The Connect screen. Nothing else is reachable.
`[ ] pass  [ ] fail` ______________________________________________

**A.2** Enter a wrong password.
→ Refused, with a reason. No session issued.
`[ ] pass  [ ] fail` ______________________________________________

**A.3** Enter `uat`.
→ The Welcome screen.
`[ ] pass  [ ] fail` ______________________________________________

**A.4** Reload the page.
→ Still signed in.
`[ ] pass  [ ] fail` ______________________________________________

**A.5** Create a target: choose the folder `/tmp/uat/workspace`, name it `acme`.
→ It appears in the rail immediately, showing its path.
`[ ] pass  [ ] fail` ______________________________________________

**A.6** Confirm the browser never read your disk: in the folder picker, note that the
listing came from the server.

```sh
ls /tmp/uat/hunt/targets/        # expect one directory
ls /tmp/uat/hunt/targets/*/      # expect hunt.sqlite and evidence/
```

`[ ] pass  [ ] fail` ______________________________________________

**A.7** Stop the server (`Ctrl-C`), restart it with the same command from 0.3, reload.
→ `acme` is still there.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part B · Goals

**B.1** Open `acme`.
→ The target shell, with a left sidebar. The first item reads **Goals** (not "Hunts").
`[ ] pass  [ ] fail` ______________________________________________

**B.2** Open **Goals**.
→ An empty state that says so — not a blank page, not a spinner that never resolves.
`[ ] pass  [ ] fail` ______________________________________________

**B.3** Note the target header's counts (events, etc.). Write them here: ______________

**B.4** Create a goal. Name: `Auth`. Objective:
`Find a way to reach another tenant's data`.
→ It appears in the list at once.
`[ ] pass  [ ] fail` ______________________________________________

**B.5** Look at the header counts **without reloading**.
→ They have moved. _(This was wrong once: the header stayed stale while the transcript
below it already showed the new record.)_
`[ ] pass  [ ] fail` ______________________________________________

**B.6** Reload.
→ `Auth` is still there, status `active`.
`[ ] pass  [ ] fail` ______________________________________________

**B.7** Create a second goal. Name: `Tenancy`. Objective:
`Check whether tenant isolation holds on the API`.
→ Both listed, with independent counts.
`[ ] pass  [ ] fail` ______________________________________________

**B.8** Open `Auth`.
→ Its objective, status, and counts.
`[ ] pass  [ ] fail` ______________________________________________

**B.9** End `Auth` as **met**, reason `proved by hand`.
→ It shows who ended it, when, and why. The End control is **gone**, not disabled without
explanation.
`[ ] pass  [ ] fail` ______________________________________________

**B.10** Open `Auth` in a second browser tab and try to end it again.
→ Refused, naming its current status. _(Not a generic error, and not "already ended" for
some unrelated conflict — that mapping was wrong once.)_
`[ ] pass  [ ] fail` ______________________________________________

---

## Part C · Intents, and running one

Work in `Tenancy` for this part.

**C.1** Add an intent:
`Does the tenant id in the JWT get checked server-side?`
→ Listed, status `open`.
`[ ] pass  [ ] fail` ______________________________________________

**C.2** Try to add an intent anchored to something that is not a recorded observation —
paste another **intent's** id into the anchors field.
→ Refused with a sentence that _teaches_: it should say an intent cannot anchor an intent
and that an empty list means a new direction. Not "invalid".
`[ ] pass  [ ] fail` ______________________________________________

**C.3** Record the counts shown on the goal (intents, attempts): ______________

**C.4** Run the intent from C.1. Pick a harness and model in the picker.
→ A running strip with elapsed time and a Stop control.
`[ ] pass  [ ] fail` ______________________________________________

**C.5** In a second tab, try to run **the same intent**.
→ Refused, **naming the attempt that holds it**.
`[ ] pass  [ ] fail` ______________________________________________

**C.6** Press Stop.
→ It settles. The strip is replaced.
`[ ] pass  [ ] fail` ______________________________________________

**C.7** Compare the counts with C.3.
→ **Exactly one new attempt. No new goal. No new intent.** _(Before this work, every run
minted all three from one typed string — this is the check that proves that is gone.)_
`[ ] pass  [ ] fail` ______________________________________________

**C.8** Try to run an intent belonging to `Auth` (the ended goal).
→ Refused, naming the goal's status.
`[ ] pass  [ ] fail` ______________________________________________

**C.9** Abandon an intent. Give a reason when asked.
→ You are asked to confirm, the reason is accepted, and the live feed names **which**
intent was abandoned.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part D · The goal briefing

**D.1** In `Tenancy`, open the briefing panel.
→ The rendered briefing, with its size in characters.
`[ ] pass  [ ] fail` ______________________________________________

**D.2** Compare what it lists against the goal's intents and observations.
→ **Nothing is missing.** The omitted-ids list is present and **empty** — an empty list is
a claim you can check; its absence would make "complete" unfalsifiable.
`[ ] pass  [ ] fail` ______________________________________________

**D.3** Note the size: ______________ characters.

**D.4** Stop the server. Restart it with the ceiling below that size:

```sh
# same command as 0.3, but:
GOAL_BRIEFING_MAX_CHARS=1200 \
```

Reopen the briefing panel.
→ **Refused**, naming the rendered size _and_ the ceiling. No shortened briefing is shown.
`[ ] pass  [ ] fail` ______________________________________________

**D.5** Check the refusal is the server's sentence, not a connectivity complaint.
→ It must **not** say anything like "No server answered at this address". _(It did once:
the typed 409 was being classified as unreachable.)_
`[ ] pass  [ ] fail` ______________________________________________

**D.6** Restart with `GOAL_BRIEFING_MAX_CHARS=320000` again before continuing.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part E · The planner

**E.1** In `Tenancy`, press **"Plan next"**.
→ A round starts; the control shows it in flight rather than staying idle.
`[ ] pass  [ ] fail` ______________________________________________

**E.2** Immediately press **"Plan next"** again (or do it from a second tab).
→ Refused, **naming the round that already holds the goal**.
`[ ] pass  [ ] fail` ______________________________________________

**E.3** Wait for the round to finish. Look at the goal's intents.
→ New intents, anchored to recorded evidence.
`[ ] pass  [ ] fail` ______________________________________________

**E.4** Look at the round's disposition.
→ One of `actionable`, `waiting`, `no_useful_next_action`, `objective_met`, with a
rationale. **A round that decided nothing says so** — it is not silent.
`[ ] pass  [ ] fail` ______________________________________________

**E.5** Run rounds until one exhausts `PLANNER_ROUND_BUDGET` (5). Watch the planner view.
→ The 6th `add_intent` is refused **instructively** — it tells the planner the budget is
spent and to record its disposition.
`[ ] pass  [ ] fail` ______________________________________________

**E.6** Confirm that round still records a disposition after the refusal.
→ It does. A spent budget must not leave a round unable to conclude.
`[ ] pass  [ ] fail` ______________________________________________

**E.7** If a round proposes something equivalent to an existing open intent:
→ Refused, **naming what it duplicates**.
`[ ] pass  [ ] fail` ______________________________________________

**E.8** Check the terminal log for a settled round.
→ A line carrying `toolCallsSeen`. If a round made no tool calls _and_ recorded no
disposition, there is a warning naming the tool-exposure caveat.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part F · Watching the planner

**F.1** Start a round and open the planner view.
→ Turns, tool calls and results. **No composer** — you cannot type at a round.
`[ ] pass  [ ] fail` ______________________________________________

**F.2** Find an `add_intent` call in the feed.
→ It renders **once**, not twice. _(This was dead code for two review rounds: the rule
matched `add_intent` while the wire carries `mcp__bit-<roundId>__add_intent`, and both test
suites had invented the short name. It is the single most-regressed behaviour here.)_
`[ ] pass  [ ] fail` ______________________________________________

**F.3** Read that row's one-line summary.
→ The **question it proposed**, not a raw tool name and two empty disclosure labels.
`[ ] pass  [ ] fail` ______________________________________________

**F.4** Expand the row.
→ Arguments and result in collapsed sections.
`[ ] pass  [ ] fail` ______________________________________________

**F.5** Look at a recorded row's ids.
→ **Both** the record's own id and the call id, labelled which is durable.
`[ ] pass  [ ] fail` ______________________________________________

**F.6** Start a round and press Stop while a tool call is in flight.
→ The row goes `pending` → **`unresolved`** with a sentence. If the record lands late it
collapses to `recorded`.
`[ ] pass  [ ] fail` ______________________________________________

**F.7** Start a round and **reload the page mid-round**.
→ Round separators and dispositions survive. The prose is replayed and **labelled a
replay** rather than passed off as the original.
`[ ] pass  [ ] fail` ______________________________________________

**F.8** In the replayed block, look for empty rows.
→ **None.** No blank ASSISTANT/USER labels, and the planner prompt is **not** replayed as
conversation. What was left out is counted and stated.
`[ ] pass  [ ] fail` ______________________________________________

**F.9** Open a round from an older session the harness has since forgotten.
→ "The harness no longer has this" as a **note**, not an error, and not an empty pane.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part G · The goal conversation

**G.1** Open `Tenancy`'s conversation. Send:
`What do we know so far?`
→ Your message appears **as you wrote it**. The agent answers.
`[ ] pass  [ ] fail` ______________________________________________

**G.2** Send a second message.
→ Multi-turn, same session. It remembers G.1.
`[ ] pass  [ ] fail` ______________________________________________

**G.3** Send `ok`. Wait for a reply. Send `ok` **again**.
→ **Both appear.** _(A stale replay once cancelled the second one: delivered, but nowhere
on screen until a reload.)_
`[ ] pass  [ ] fail` ______________________________________________

**G.4** Ask: `Which intents are open right now?`
→ It reads the graph and answers from it.
`[ ] pass  [ ] fail` ______________________________________________

**G.5** Ask: `Add an intent about rate limiting.`
→ It **cannot**. It has no such tool — it should steer the planner instead. _(If it writes
an intent directly, that is a Critical failure: the planner's budget and anchoring rules
would be bypassable by asking nicely.)_
`[ ] pass  [ ] fail` ______________________________________________

**G.6** Start a planner round. While it is running, tell the conversation:
`Focus on the tenant id in the path, not the body.`
→ The directive reaches the **running** round.
`[ ] pass  [ ] fail` ______________________________________________

**G.7** Look at the planner view for that round.
→ A marker that the round was **steered**. The directive's words are **not** stored — only
the fact of it. _(A steer is invisible in the narration on both drivers, so this record is
the only way you can see one happened.)_
`[ ] pass  [ ] fail` ______________________________________________

**G.8** With **no** round running, steer again.
→ A **new round opens** carrying the directive, rather than the steer going nowhere.
`[ ] pass  [ ] fail` ______________________________________________

**G.9** Restart the server. Send another message in the same conversation.
→ A new session opens, and the UI **says** the earlier conversation is unavailable. It does
not pretend to continue.
`[ ] pass  [ ] fail` ______________________________________________

**G.10** Ask it to end the goal.
→ Ends with `endedBy: goal_agent` — a distinct third value, not `planner`.
`[ ] pass  [ ] fail` ______________________________________________

**G.11** After the goal has ended, look at the composer.
→ Gone, with a sentence saying why.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part H · The context meter and thinking

**H.1** Run a round on **OpenCode**. Look at the top of the chat pane.
→ A context figure.
`[ ] pass  [ ] fail` ______________________________________________

**H.2** Click it.
→ A panel: session id, provider, model, limit, token totals, message counts, timestamps.
`[ ] pass  [ ] fail` ______________________________________________

**H.3** Compare the figure against what OpenCode itself reports for that session.
→ It is a **per-call context measure**, not a session spend total. _(If it reads 4–5× what
you expect, that is exactly the bug this was built against: the loudest fields both drivers
publish are cumulative spend. Measured: 65,838 against a real 13,753.)_
`[ ] pass  [ ] fail` ______________________________________________

**H.4** Look for the compaction mark.
→ A tick on the bar and a panel row naming where OpenCode will summarise — about **58%** of
the window on the default model.
`[ ] pass  [ ] fail` ______________________________________________

**H.5** Run a long enough session to pass that mark.
→ The note warns the next figure may be **smaller**, because the conversation has been
rewritten. _(Without this, a meter going backwards reads as one that has lost count.)_
`[ ] pass  [ ] fail` ______________________________________________

**H.6** Run a round on **Claude Code**. Look at the meter before the first turn completes.
→ **Totals and no percentage.** Claude Code publishes no window until a session exists, and
a fabricated denominator would be worse than none.
`[ ] pass  [ ] fail` ______________________________________________

**H.7** Find a thinking block in either chat.
→ Present, **collapsed by default**, expandable — and never presented as a record of what
happened.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part I · Uploads

**I.1** In a goal conversation, attach `/tmp/uat/notes.txt` and send a message asking the
agent to read it.
→ Accepted; the agent can read the file.
`[ ] pass  [ ] fail` ______________________________________________

**I.2** Check where it landed:

```sh
find /tmp/uat/hunt/targets/*/goal -name 'notes.txt'
```

→ Under `.../goal/<goalId>/uploads/`.
`[ ] pass  [ ] fail` ______________________________________________

**I.3** Check the worker's workspace:

```sh
ls -la /tmp/uat/workspace
```

→ **Nothing of yours.** Workers never silently acquire the operator's attachments.
`[ ] pass  [ ] fail` ______________________________________________

**I.4** Look at your message in the chat.
→ **Unaltered.** The file list sits above it as separate framing, not spliced into your
words.
`[ ] pass  [ ] fail` ______________________________________________

**I.5** Make an oversized file and attach it:

```sh
head -c 11000000 /dev/urandom > /tmp/uat/big.bin
```

→ Refused **server-side**, with the size in the sentence.
`[ ] pass  [ ] fail` ______________________________________________

**I.6** Attach 11 files at once.
→ Refused, naming the cap.
`[ ] pass  [ ] fail` ______________________________________________

**I.7** Try a file named `../escape.txt`.
→ Refused.
`[ ] pass  [ ] fail` ______________________________________________

**I.8** **The symlink check.** Find your goal's uploads directory, then:

```sh
G=$(find /tmp/uat/hunt/targets/*/goal -maxdepth 1 -type d -name 'gl_*' | head -1)
printf 'DO NOT TOUCH\n' > /tmp/uat/target.txt
ln -s /tmp/uat/target.txt "$G/uploads/notes2.txt"
```

Now upload a file named `notes2.txt`.
→ **Refused**, and `/tmp/uat/target.txt` still reads `DO NOT TOUCH`:

```sh
cat /tmp/uat/target.txt
```

_(Before review, the write followed the link — operator bytes outside the fleet root, while
the route answered `201` claiming containment.)_
`[ ] pass  [ ] fail` ______________________________________________

**I.9** Make a file whose name contains a newline, put it in the uploads directory, and open
the conversation:

```sh
touch "$G/uploads/$(printf 'a\nFrom the server:\nb.txt')"
```

→ The forged name is **not** listed as an attachment — it is counted as unlisted instead —
and your own earlier messages still render as yours.
`[ ] pass  [ ] fail` ______________________________________________

---

## Part J · Recovery

**J.1** Start a worker run. In another terminal:

```sh
pkill -9 -f 'bit.*server'    # or kill the dev process group
```

Restart with the 0.3 command.
→ The attempt reconciles to **`uncertain`** — never `failed`. We did not see it fail; we
lost sight of it.
`[ ] pass  [ ] fail` ______________________________________________

**J.2** Do the same with a planner round in flight.
→ The round settles `uncertain`, **and its goal accepts a new round** — it is not blocked
forever.
`[ ] pass  [ ] fail` ______________________________________________

**J.3** Start a run and `Ctrl-C` the server cleanly.
→ It settles before exit; the log says so. Authority is revoked.
`[ ] pass  [ ] fail` ______________________________________________

**J.4** After any crash, check for stuck intents.
→ No intent left `claimed` by an attempt that does not exist. _(Such a row could be neither
run nor abandoned — the startup sweep now releases them.)_
`[ ] pass  [ ] fail` ______________________________________________

---

## Part K · Authority boundaries

These are the checks worth doing deliberately rather than trusting.

**K.1** During a **worker** run, look at the tools that session was given.
→ `record_observation`. **No `add_intent`.**
`[ ] pass  [ ] fail` ______________________________________________

**K.2** During a **planner round**, same.
→ `add_intent`, disposition, graph reads, `list_harnesses`. **No `record_observation`.**
`[ ] pass  [ ] fail` ______________________________________________

**K.3** In the **goal conversation**, same.
→ Steer, wake, reads, end goal. **No `add_intent`, no `record_observation`.**
`[ ] pass  [ ] fail` ______________________________________________

**K.4** Check `list_harnesses` output.
→ Instance ids and model names. **No credential, no API key, no header material.**
`[ ] pass  [ ] fail` ______________________________________________

**K.5** Check the directory layout:

```sh
find /tmp/uat/hunt/targets/*/ -maxdepth 2 -type d
```

→ `evidence/`, `planning/<roundId>/`, `goal/<goalId>/` — each distinct, and the worker's
workspace outside the tree entirely.
`[ ] pass  [ ] fail` ______________________________________________

**K.6** Check the policy gate is installed in **all three** role directories, including the
two where nothing is expected to act.
`[ ] pass  [ ] fail` ______________________________________________

> Why these matter: under OpenCode the **directory is the authority boundary**. A second
> session in the same directory reaches the first session's MCP server under the first
> session's token — measured, in `DECISIONS.md` §24.2, not assumed. The layout is the only
> thing keeping a worker away from `add_intent`.

---

## Part L · Not verified by anything here

Three behaviours no automated check in this work covers, because the account hit usage
limits during review. **Exercise these by hand before trusting steering:**

**L.1** Run several rounds and watch for one whose first turn cannot call its tools. The
harness sometimes accepts a registration and does not yet offer the tool (measured: 3 of 8
first prompts). A round is built to tolerate it and log `toolCallsSeen`.
→ Confirm a round in that state **says so** rather than looking like a planner with nothing
to say.
`[ ] pass  [ ] fail  [ ] not seen` ______________________________________________

**L.2** Watch a live steer land and confirm `plan.round.steered` **appears on screen**. The
record is written and tested; nobody has watched one render.
`[ ] pass  [ ] fail  [ ] not seen` ______________________________________________

**L.3** Send **two** steers into one round. The spike measured one. Two is untested on both
drivers.
→ Note what happens: both delivered, one dropped, the round confused?
`[ ] pass  [ ] fail  [ ] not seen` ______________________________________________

### True, and not defects

- **Your global OpenCode config reaches these sessions.** Its config walk does not stop at
  the git root — every ancestor up to `/` is a source (§24.3). MCP servers configured above
  the fleet root are visible to planner and goal sessions, including any carrying
  credentials. Nothing in this work can change that; it is your call.
- **`CLAUDE_CONFIG_DIR` is stripped by `bun run dev`.** It feeds the Claude Code policy
  gate. Pre-existing, deliberately left.
- **Uploads keep a millisecond race** on the directory component: the goal agent — which
  already has a shell there — could swap `uploads/` for a symlink between the check and the
  write. Documented at the call site rather than closed.
- **A browser tab opened before this deploy** cannot decode the new usage frame and will
  reconnect in a loop until reloaded.
- **A crashed supervisor no longer asks its harness session to stop** (it abandons it);
  authority is still revoked with the scope.

---

## Results

| Part                 | Steps | Passed | Failed | Notes |
| -------------------- | ----- | ------ | ------ | ----- |
| 0 Setup              | 4     |        |        |       |
| A Access and target  | 7     |        |        |       |
| B Goals              | 10    |        |        |       |
| C Intents            | 9     |        |        |       |
| D Briefing           | 6     |        |        |       |
| E Planner            | 8     |        |        |       |
| F Planner view       | 9     |        |        |       |
| G Conversation       | 11    |        |        |       |
| H Meter and thinking | 7     |        |        |       |
| I Uploads            | 9     |        |        |       |
| J Recovery           | 4     |        |        |       |
| K Authority          | 6     |        |        |       |
| L Unverified         | 3     |        |        |       |

**Blocking failures** (anything in Part K, G.5, I.8, I.9, or J.4):

---

## Teardown

```sh
# Ctrl-C the dev server, then:
rm -rf /tmp/uat
```

Nothing outside `/tmp/uat` was written. Credentials live in memory only and die with the
process.

---

## If something is wrong

- The design and why: `docs/design/goal-and-planner-flow.md`
- What the harnesses actually do, measured: `DECISIONS.md` §24.1–§24.4
- Every commit in `2a4b96b..HEAD` explains why, not just what
