# UAT — the goal and planner flow

For the operator. Covers everything built in commits `2a4b96b..79e937b`: target → goal →
planner → intents → attempts, the two chat surfaces, the context meter, and uploads.

Work top to bottom the first time: later sections assume state the earlier ones create.
Each check says what you should see. Where a check exists because a bug was found and
fixed, it says so — those are the ones worth not skipping.

---

## 0. Setup

```sh
cd /run/media/hbt/work/bit
bun install --frozen-lockfile

mkdir -p /tmp/uat/workspace
HUNT_ROOT=/tmp/uat/hunt \
WORKSPACE_ROOT=/tmp/uat \
BIT_PASSWORD=uat \
GOAL_BRIEFING_MAX_CHARS=320000 \
PLANNER_ROUND_BUDGET=5 \
UPLOAD_MAX_BYTES=10485760 \
UPLOAD_MAX_FILES=10 \
bun run dev
```

Open http://localhost:5173. The server is on 3000 and the dev proxy expects it there —
moving it breaks `/api`.

**Use a fresh `HUNT_ROOT`** so you are not reading an earlier run's data. To start over,
stop the server and `rm -rf /tmp/uat`.

**Two known conditions, neither a bug you have found:**

- `bun run format:check` fails on `sprint-roadmap.html`. It predates all of this.
- One test is skipped (`browserApi.test.ts`'s heartbeat case) — timing-dependent, passes
  alone, quarantined deliberately with its history in a comment.

**A gate that will lie to you.** `bun run typecheck`, `test` and `build` replay Turbo's
cache and print as if they ran. If you want a real run, add `--force`. A reviewer in this
plan reported green gates that were entirely cache replays.

---

## 1. Getting in, and a target

| #   | Do                                                      | Expect                                                |
| --- | ------------------------------------------------------- | ----------------------------------------------------- |
| 1.1 | Open the app with no session                            | The Connect screen; nothing else reachable            |
| 1.2 | Wrong password                                          | A refusal naming the reason; no session issued        |
| 1.3 | `uat`                                                   | The Welcome screen                                    |
| 1.4 | Reload                                                  | Still signed in                                       |
| 1.5 | Clear the session                                       | Back at Connect                                       |
| 1.6 | New target against `/tmp/uat/workspace`, name it `acme` | Appears at once with its path                         |
| 1.7 | Restart the server, reload                              | Still there, with migration rows in its `hunt.sqlite` |

> The folder picker runs server-side. The browser never reads your filesystem — if it
> offers you a path it got it from the server.

---

## 2. Goals

| #   | Do                                                                           | Expect                                                                                       |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 2.1 | Open `acme` → **Goals**                                                      | Empty state, not a blank page                                                                |
| 2.2 | New goal: name `Auth`, objective `Find a way to reach another tenant's data` | Appears immediately                                                                          |
| 2.3 | Watch the target header                                                      | Counts move on the same tick — **not** after a reload                                        |
| 2.4 | Reload                                                                       | Goal still there, status `active`                                                            |
| 2.5 | Open it                                                                      | Objective, status, counts                                                                    |
| 2.6 | End it as `met`, with a reason                                               | Shows who ended it, when, why; the End control is **gone**, not disabled-without-explanation |
| 2.7 | Try to end it again (second tab)                                             | Refused, naming its current status                                                           |
| 2.8 | Make a second goal `Tenancy` and leave it active                             | Both listed, independent                                                                     |

> 2.3 and 2.6 both exist because review found them wrong the first time: the header went
> stale while the transcript below it showed the new record, and any store conflict was
> reported as "already ended" even when it wasn't.

---

## 3. Intents, and running one

| #   | Do                                                                                    | Expect                                                                                                             |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 3.1 | In `Tenancy`, add an intent: `Does the tenant id in the JWT get checked server-side?` | Listed, status `open`                                                                                              |
| 3.2 | Add one anchored to an observation that does not exist                                | Refused with a sentence that **teaches** — it should tell you an intent cannot anchor an intent, not say "invalid" |
| 3.3 | Run the intent, picking a harness and model                                           | Running strip with elapsed time; a Stop control                                                                    |
| 3.4 | Open a second tab, try to run the same intent                                         | Refused, **naming the attempt that holds it**                                                                      |
| 3.5 | Stop it                                                                               | Settles; its write authority is withdrawn                                                                          |
| 3.6 | Check the goal and intent counts before and after a run                               | Exactly one new attempt — **no new goal, no new intent**                                                           |
| 3.7 | Run an intent whose goal you have ended                                               | Refused, naming the status                                                                                         |

> 3.6 is the whole point of the second slice: before it, every run minted a goal, an intent
> and an attempt from one typed string.
>
> 3.4 is worth doing properly. The claim is a single conditional UPDATE, and a crash between
> claiming and writing the attempt row used to leave an intent nobody could ever run again.

---

## 4. The planner

| #   | Do                                                  | Expect                                                                                     |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 4.1 | In `Tenancy`, open the briefing panel               | Exactly what the planner will be given, with its size                                      |
| 4.2 | Compare with the goal's observations                | **Nothing omitted.** The omitted list is present and empty — that is a claim you can check |
| 4.3 | Set `GOAL_BRIEFING_MAX_CHARS=1200`, restart, reopen | Refused, naming the rendered size **and** the ceiling; no shortened briefing               |
| 4.4 | Restore the ceiling. Press **Plan next**            | A round starts; the control shows it in flight                                             |
| 4.5 | Watch it                                            | Proposed intents appear under the goal, anchored                                           |
| 4.6 | Let it exhaust `PLANNER_ROUND_BUDGET`               | The next `add_intent` is refused **instructively** — and it can still record a disposition |
| 4.7 | Have it propose a duplicate                         | Refused, naming what it duplicates                                                         |
| 4.8 | Press Plan next twice quickly                       | The second is refused, naming the round that holds the goal                                |
| 4.9 | Let a round record `objective_met`                  | The goal ends, `endedBy: planner`                                                          |

---

## 5. Watching the planner

| #   | Do                                   | Expect                                                                                                     |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 5.1 | Open the planner view during a round | Turns, tool calls, results; no composer — you cannot prompt a round                                        |
| 5.2 | Find an `add_intent` call            | Rendered **once**, not twice. A one-line summary of the question it proposed                               |
| 5.3 | Look at a recorded row               | The record's own id _and_ the call id, labelled which is durable                                           |
| 5.4 | Stop a round mid-call                | The row goes `pending` → `unresolved` with a sentence; if the record lands late it collapses to `recorded` |
| 5.5 | Reload mid-round                     | Round separators and dispositions survive; the prose is replayed and **labelled a replay**                 |
| 5.6 | Reload a round from a few days ago   | "The harness no longer has this" as a note, **not** an error                                               |
| 5.7 | Check the replayed block             | No empty labelled turns, and the planner prompt is **not** replayed as conversation                        |

> 5.2 is the single most-regressed behaviour in this work. It was dead code for two rounds
> because the rule matched `add_intent` while the wire carries
> `mcp__bit-<roundId>__add_intent`, and both test suites had invented the short name.

---

## 6. The goal conversation

| #    | Do                                           | Expect                                                                         |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| 6.1  | Open a goal's conversation, send a message   | Your words appear as you wrote them                                            |
| 6.2  | Send a second                                | Multi-turn; same session                                                       |
| 6.3  | Send `ok`, then send `ok` again              | **Both render.** A re-sent sentence must not vanish                            |
| 6.4  | Ask it what intents exist                    | It reads the graph                                                             |
| 6.5  | Ask it to add an intent directly             | It cannot — it has no such tool. It steers; the planner commits                |
| 6.6  | With a round live, ask it to focus somewhere | The directive reaches the running round                                        |
| 6.7  | Check the planner view after a steer         | A marker that the round was steered — the directive's words are **not** stored |
| 6.8  | Steer with no round live                     | A new round opens carrying the directive                                       |
| 6.9  | Restart the server, send another message     | A new session, and it **says** the earlier conversation is unavailable         |
| 6.10 | Ask it to end the goal                       | Ends with `endedBy: goal_agent`                                                |

> 6.3 exists because a stale replay silently swallowed repeated messages — delivered, but
> nowhere on screen.
>
> 6.9 is the accepted cost of not persisting conversations: the harness's retention is the
> conversation's lifetime.

---

## 7. The meter and thinking

| #   | Do                                                   | Expect                                                                                                                             |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Run a round on OpenCode                              | A context figure at the top of the pane                                                                                            |
| 7.2 | Click it                                             | Session id, provider, model, limit, totals, message counts, timestamps                                                             |
| 7.3 | Compare with OpenCode's own view of the same session | **Within a per-call measure, not a session spend total.** If it reads 4–5× what you expect, that is the bug this was built against |
| 7.4 | Look for the compaction mark                         | A tick on the bar and a row naming where OpenCode will summarise — around 58% of the window on the default model                   |
| 7.5 | Run past that point                                  | The note warns the next figure may be **smaller**, because the conversation has been rewritten                                     |
| 7.6 | Run on Claude Code                                   | Totals and **no percentage** until the session reports a window                                                                    |
| 7.7 | Expand a thinking block                              | Collapsed by default; opens; never presented as a record of what happened                                                          |

---

## 8. Uploads

| #   | Do                                                                                                      | Expect                                                             |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 8.1 | Attach a small text file in a goal conversation                                                         | Accepted; the agent can read it                                    |
| 8.2 | Check `/tmp/uat/hunt/targets/<id>/goal/<goalId>/uploads/`                                               | It is there                                                        |
| 8.3 | Check `/tmp/uat/workspace`                                                                              | **Nothing.** Workers never see your attachments                    |
| 8.4 | Read the prompt the agent got                                                                           | Your message is unaltered; the file list sits above it, separately |
| 8.5 | Attach an 11 MB file                                                                                    | Refused server-side, with the size in the sentence                 |
| 8.6 | Attach 11 files                                                                                         | Refused, naming the cap                                            |
| 8.7 | Try a name with `..` or a slash                                                                         | Refused                                                            |
| 8.8 | `ln -s /etc/passwd /tmp/uat/hunt/targets/<id>/goal/<goalId>/uploads/notes.txt`, then upload `notes.txt` | **Refused**, and `/etc/passwd` untouched                           |

> 8.8 is a real finding from review: before it, the write followed the link and the route
> answered `201` claiming containment. 39 other hostile names were already refused; these
> two paths — reading a name back, and the filesystem's own behaviour — were the gap.

---

## 9. Recovery

| #   | Do                                         | Expect                                                  |
| --- | ------------------------------------------ | ------------------------------------------------------- |
| 9.1 | Start a run, `kill -9` the server, restart | The attempt reconciles to `uncertain` — never `failed`  |
| 9.2 | Same with a planner round                  | Round settles `uncertain`; its goal accepts a new round |
| 9.3 | `Ctrl-C` during a run                      | Settles cleanly before exit; authority revoked          |
| 9.4 | After any crash, check intents             | None stuck `claimed` by an attempt that does not exist  |

---

## 10. Authority — the checks worth doing deliberately

| #    | Do                                       | Expect                                                                |
| ---- | ---------------------------------------- | --------------------------------------------------------------------- |
| 10.1 | Look at a worker's tools                 | `record_observation`; **no** `add_intent`                             |
| 10.2 | Look at a planner round's                | `add_intent`, disposition, reads; **no** `record_observation`         |
| 10.3 | Look at the goal agent's                 | Steer, wake, reads, end; **no** `add_intent`, no `record_observation` |
| 10.4 | Check the directories                    | `workspace/`, `planning/<roundId>/`, `goal/<goalId>/` — all distinct  |
| 10.5 | Check the gate is installed in all three | Including the two where nothing is expected to act                    |

> These matter because under OpenCode the **directory** is the authority boundary: a second
> session in the same directory reaches the first's MCP server under the first's token.
> That is measured, in `DECISIONS.md` §24.2, not assumed.

---

## 11. What is NOT verified — read before trusting this

Three things no automated check in this work covers, all because the account hit its usage
limits during review. **These are the first things to exercise by hand:**

1. **Tool exposure to a live model.** A harness can accept a tool registration and not yet
   offer the tool on the first turn (measured: 3 of 8). A round is built to tolerate it and
   logs `toolCallsSeen` when it happens — but no round has been watched doing so end to end.
2. **`plan.round.steered` on screen.** The record is written and asserted; a human has not
   watched one appear in the planner view during a live steer.
3. **More than one steer into a single round.** The spike measured one. Two is untested on
   both drivers.

Also worth knowing, none of them defects:

- **Your global OpenCode config reaches these sessions.** Its config walk does not stop at
  the git root — every ancestor up to `/` is a source (§24.3). So MCP servers you configure
  anywhere above the fleet root are visible to planner and goal sessions, including any
  carrying credentials. Nothing in this work can change that; it is your call.
- **`CLAUDE_CONFIG_DIR` is stripped by `bun run dev`.** It feeds the Claude Code policy
  gate. Pre-existing, deliberately left.
- **Uploads have a millisecond race** on the directory component: the goal agent — which
  already has a shell there — could swap `uploads/` for a symlink between the check and the
  write. Documented at the call site rather than closed.
- **A browser tab from before this deploy** cannot decode the new usage frame and will
  reconnect in a loop until reloaded.

---

## 12. If something is wrong

The design and its reasoning: `docs/design/goal-and-planner-flow.md`.
What the harnesses actually do, measured: `DECISIONS.md` §24.1–§24.4.
Every commit message in `2a4b96b..79e937b` says why, not just what.
