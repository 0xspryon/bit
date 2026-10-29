# Goal and planner flow — spec and delivery sequence

Written 2026-10-29. Covers the path from an open target to a goal, to a planner that
dispatches intents, and the two chat surfaces around it.

This document is the **spec**. Each slice below gets its own task-level plan under
`docs/superpowers/plans/` when it is started; a delegated implementer is given this
document plus that slice's plan, and nothing else is assumed to travel with them.

---

## 1. The model

| Term       | Means                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| **Target** | A system under test. Owns a folder and its own `hunt.sqlite`. Already built. |
| **Hunt**   | The investigation of one target over time. Not a row — it _is_ the target.  |
| **Goal**   | An objective within the hunt. A durable record with a lifecycle.            |
| **Intent** | A specific direction to investigate, under one goal. Planner-created.       |
| **Attempt**| One execution of one intent by one worker. Already built.                   |

The graph belongs to the **target**, not to a goal: `goals.target_id`,
`intents.goal_id`, `attempts.intent_id` already express this and nothing is re-parented.

Two agents sit above the workers:

- **Goal agent** — long-horizon, operator-facing, multi-turn. Holds the conversation.
  Tools: steer the planner, wake the planner, introspect intents and attempts, end the
  goal, graph reads, read uploads. **Never `add_intent`.**
- **Planner round** — a bounded, supervised unit of work on a reusable session. The
  operator may pause or stop it but may not prompt it. Tools: `add_intent`,
  `record_round_disposition`, graph reads, `list_harnesses`.

A planner "conversation" is not an entity: it is one session lineage plus N round
records. Multi-turn happens only when the goal agent opens another round on it.

## 2. Settled decisions

These were decided in review and are not open for re-litigation by an implementer. Where
one conflicts with something in the code, the code is what changes.

**Authority**

1. The planner writes through **MCP tools**, not through host-side writes. It gets both
   read and write tools over the graph.
2. `CallerContext` becomes a tagged union: attempt-authority, round-authority,
   goal-authority. `checkAuthority` grows a parallel path per tag.
3. Caller scopes are namespaced: `targetId/<attemptId>`, `targetId/round/<roundId>`,
   `targetId/goal/<goalId>`. Receipt keys and event attribution follow from this.
4. A round credential expires on **scope close**, with the existing clock as a backstop.
   A goal credential has **no clock expiry at all** (`expiresAt: number | null`, null
   meaning no expiry — not a sentinel). What still revokes it: scope close, explicit
   `revokeGoal`, and process death, because grants are held in memory only. The in-memory
   grant map is also why a goal needs no write-fence column: a credential cannot survive a
   restart to be replayed.
5. **Under OpenCode the directory is the authority boundary**, because MCP servers are
   registered per directory and the registration carries the bearer token in its headers.
   Every distinct tool set therefore gets its own directory:

   ```
   targets/<id>/workspace/            workers       → record_observation
   targets/<id>/planning/<roundId>/   planner round → add_intent, disposition, reads
   targets/<id>/goal/<goalId>/        goal agent    → steer, wake, end_goal, reads
   ```

   The policy gate is installed in all three, fail-closed, including the ones where an
   agent is not expected to act.

**Lifecycle**

6. Rounds use the attempt machinery: a `FiberMap` keyed by round id in the process scope,
   narration subscribed before prompting, a settlement table over the ways the loop can
   end, `uncertain` when the harness cannot answer, stop interrupts and settles, the
   startup sweep reconciles leftover `running` rounds, shutdown settles in flight. **The
   prompt is never resubmitted.**
7. One round per goal at a time, claimed synchronously before the fiber forks. Rounds may
   run concurrently with workers; they are in different directories and take different
   claims.
8. A goal ends when the planner records `objective_met` or the operator ends it. Ending
   blocks new dispatch and planner wake-ups; it does **not** interrupt a running attempt.

**Planning**

9. The planner reads the graph **live**, including its own writes within a round. The
   round records `started_at_sequence` as provenance, never as a snapshot guarantee.
10. Duplicate-intent rejection and budget enforcement live **inside `add_intent`**, because
    a live read protects the planner only against itself.
11. The goal briefing is rendered at **100% — nothing omitted from any intent of the
    goal**. `omittedObservationIds` stays in the shape and is always empty, because an
    empty list is a checkable claim. The brief carries its own size. Exceeding the
    configured ceiling **refuses the round naming the size**; it never silently truncates.
12. Steering injects into a live planner session. With no live session, the goal agent
    opens a round whose prompt already carries the directive. No directive storage: the
    goal agent's own session is the memory, and losing it with the harness's retention is
    accepted.

**Harness and model**

13. Harness and model stay per-attempt and free-floating. The planner may *suggest* an
    instance and model per intent (advisory columns, never a pin). Resolution order:
    operator's explicit pick → intent's suggestion → server default. A suggestion naming a
    dead instance **falls back and says so**; only an operator's explicit pick is refused
    with `harness_not_ready`.

**Conversation**

14. Narration is **not persisted**. The chat streams from OpenCode/Claude Code; a refresh
    reconnects and replays from `AgentHarness.messages`. Accepted consequences: replay is
    the reduced `{type, text, error}` shape, so paired tool blocks do not reconstruct;
    retention is the harness's (Claude Code ~30 days, OpenCode until its process
    restarts); the join between replay and live tail needs a dedupe by harness message
    index.
15. Operator messages are piped straight to the agent and not stored. Thinking is streamed
    and not stored.
16. Round boundaries come from **records** (`plan.round.started` / `.settled`), so the
    structure of a planner session survives a refresh even when its prose does not.
17. A steered round records that a steer occurred, without the directive text, so its
    disposition is not read as answering the framing it opened with.

## 3. What already exists and must not be rebuilt

- `store.addIntent(host, input)` — anchoring rule, goal/target ownership check, receipt
  idempotency, four instructive refusals. Needs a route and a tool, not a rewrite.
- `seedAttempt` — all inserts are `ON CONFLICT(id) DO NOTHING`, so dispatching against an
  existing goal and intent writes only the attempt row.
- `plannerLineage` / `recordPlannerLineage` and the `planner_lineages` table (re-key from
  `target_id` to the goal).
- `RunSupervisor`'s shape: claim-before-fork, subscribe-before-prompt, settlement table,
  credential as `acquireRelease`, recovery sweep, shutdown settlement.
- `McpCredentials` issue/resolve/revoke and the per-attempt grant model.
- `LiveTranscript` + `LiveFrame`/`LiveItem`: reply, tool call, tool result paired by
  `callId`, denied actions, record-vs-activity origin, cursor and heartbeat.
- `ComposeBox`: harness/model picker, running strip with elapsed time, stop, refusals that
  explain themselves.
- The policy gate and its fail-closed posture; `transcript.ts` for settled attempts.

## 4. Delivery sequence

Order is forced by three dependencies: authority before anything that uses it, the goal
briefing before a planner can be prompted, and the planner before the goal agent that
steers it.

Each slice is one delegation. **Implement** is one agent with this document and that
slice's plan. **Review** is a fresh agent that has not seen the implementation; UI slices
additionally get a reviewer who drives the running app rather than reading the diff.

Gates run on every slice: `bun run typecheck`, `bun run test`, `bun run lint`,
`bun run format:check`, and `bun run test:persistence` for anything touching SQL.
`sprint-roadmap.html` already fails `format:check` and is left alone.

### Spike A — Mid-run prompt injection

**Question.** Can a session that is currently running be prompted again, on OpenCode and
on Claude Code, and what happens — queued, interleaved, or refused?

**Why first.** Decision 12 assumes injection works. If a driver refuses, steering becomes
"settle the current round, open a new one on the same session", which changes the round
contract rather than just its implementation.

**Deliverable.** A script under `apps/server/src/spike/`, plus findings appended to
`DECISIONS.md` naming each driver's behaviour verbatim. No production code.

### Spike B — Directory as an authority boundary

**Questions.** (1) Two OpenCode sessions in one directory: does the second see the first's
`bit-<id>` MCP registration, and can it call it? (2) Does re-registering the same name with
a new token replace cleanly on both drivers? (3) Confirm Claude Code's registration is
session-scoped as documented.

**Why here.** Decision 5 is the containment story for a credential with no expiry. It is
currently inferred from `agentHarness.ts`'s own comment, not demonstrated.

**Deliverable.** Script plus findings in `DECISIONS.md`. If (1) comes back negative, the
three-directory layout is cheaper than it looks and we keep it anyway; if positive, it is
load-bearing and must be stated as such in `mcp/credentials.ts`.

### Slice 1 — Goal as a record

**Delivers.** Create a goal from the open target and see it in a list.

Migration appending goal columns (name, objective, status `active|met|abandoned`,
`ended_at`, `ended_by`, reason). `openGoal` and `endGoal` in the store under `HostContext`,
receipt-keyed like `addIntent`. `goal.added` / `goal.ended` on `EventKind` and
`LIVE_ITEM_KINDS`. `contracts/goal.ts`. Routes: `POST`/`GET /targets/:targetId/goals`,
`POST /goals/:goalId/end`. UI: the mock Hunts page becomes a real goals list with a create
form; per-goal counts.

**Review — code.** Migration is append-only and the chain still applies to an existing
database. Receipt semantics match `addIntent`'s exactly. Ending blocks nothing it should
not (decision 8).
**Review — UI.** Create, list, end, reload. Two targets do not bleed into each other.
Tablet width upward.

### Slice 2 — Intents by hand, and dispatch from an existing intent

**Delivers.** Add an intent under a goal, then run it.

Migration: `intents.status` (`proposed|open|claimed|answered|abandoned`) plus advisory
`suggested_instance_id`, `suggested_model`, `suggested_model_options`. Transactional claim
and release, released on settlement. `POST /goals/:goalId/intents` exposing the existing
`addIntent`. `RunDraft` gains `intentId`; `startRun` stops minting goals and intents.
Resolution order and the visible fallback from decision 13. UI: intents under a goal,
anchors shown, "Run this intent" with the existing picker.

**Review — code.** `startRun` mints nothing when given an intent. Claim is atomic and a
second claim is refused by name. A dead suggestion falls back visibly; an operator's
explicit pick still refuses.
**Review — UI.** Anchoring refusals read as instructions, not as errors. A claimed intent
cannot be started twice from two tabs.

### Slice 3 — Three directories, three postures

**Delivers.** The containment layout, with tests rather than a screen.

Per-role directory creation, the policy gate installed in all three, uploads and evidence
kept out of the workspace. Tests assert the three paths are distinct, that the gate is
installed in each, and that a worker's workspace contains no planner or goal artefacts.

**Review — code.** Against Spike B's findings. The reviewer's job is to confirm the layout
matches what the spike actually demonstrated, not what this document predicted.

### Slice 4 — Round identity and round authority

**Delivers.** No user-visible change. The authority model that everything after depends on.

`planner_rounds` table (goal_id, target_id, status, `write_fence`, harness_session_id,
`started_at_sequence`, budget, disposition, timestamps). `CallerContext` as a tagged union
and the parallel `checkAuthority` path. `McpCredentials` gains round and goal bindings,
`expiresAt: number | null`, `revokeRound`, `revokeGoal`. Caller-scope namespacing.

**Review — code.** The heaviest gate in the plan, on the most capable model. Specifically:
no call site silently treats a round credential as an attempt one; a settled round's
credential is refused; a null expiry cannot be produced for an attempt or round binding;
scopes cannot collide. Documentation of the no-expiry case in `mcp/credentials.ts`'s
header, in that file's existing register.

### Slice 5 — PlanSupervisor

**Delivers.** A round can be started, watched, stopped and settled — still with a stub
prompt and no tools.

Extract `SupervisionEnd` and `settlementFor` to a shared module and use them from both
supervisors. `FiberMap` keyed by round id, goal claim taken synchronously before the fork,
drain, settle, revoke, stop. `plan.round.started` / `.settled` events. Startup sweep for
unsettled rounds. Shutdown settlement.

**Review — code.** The extraction changed no attempt behaviour: `supervisor.test.ts` passes
untouched. A killed process leaves a round the sweep reconciles to `uncertain`. Stop
revokes. Two concurrent `plan` calls on one goal: one refusal naming the holder.

### Slice 6 — The goal briefing at 100%

**Delivers.** A read-only briefing panel on the goal, which is also the planner's input.

`*ForGoal` store reads. A goal-level briefing shape: every intent, every observation in
sequence, the untested-dimension tail deduplicated across intents, `omittedObservationIds`
present and always empty, a size figure, and a ceiling that refuses rather than truncates.

**Review — code.** Nothing is dropped at any size below the ceiling; at the ceiling the
refusal names the size. The stable-prefix property holds unconditionally now that nothing
is evicted. Dimension dedup across intents is a join, not prose matching.
**Review — UI.** The panel shows the same bytes the planner would be given, and says how
large it is.

### Slice 7 — Planner tools, and a round that plans

**Delivers.** "Plan next" produces anchored intents and a recorded disposition.

MCP tools for the round scope: `add_intent` (now enforcing budget and duplicate rejection),
`record_round_disposition`, graph reads, `list_harnesses` with no credentials in it.
`POST /goals/:goalId/plan`. The round's prompt assembled from objective plus briefing.

**Review — code.** A budget refusal is instructive and the round can still record a
disposition after it. A duplicate is refused by the join. The planner's own writes are
visible to its next read. A worker cannot reach `add_intent` — verified against Spike B's
findings, not assumed.

### Slice 8 — Planner view, read-only chat

**Delivers.** Watch a round think and call tools; pause and stop it.

The chat component in read-only mode: live narration plus round separators from records,
tool calls rendered with their domain meaning, the pending-until-recorded merge rule, no
compose box, round controls in its place.

**Review — UI.** A refresh mid-round keeps the round structure and degrades the prose
honestly. A tool call that never produced a record stays visibly unresolved. An added
intent appears once, not twice.

### Slice 9 — The goal agent and its conversation

**Delivers.** The surface you actually open: tell the agent the goal, watch it work, steer
it.

Long-lived goal session in its own directory with a no-expiry credential. Goal-scope tools:
steer, wake planner, introspect intents and attempts, end goal, graph reads. Operator
messages piped straight through, multi-turn. Reconnect replays from
`AgentHarness.messages` with the dedupe, and renders the ephemeral and absent states.
Steering per Spike A's answer, with the steered marker from decision 17.

**Review — code.** The goal agent has no `add_intent`, verified by the tool list it is
actually registered with. Ending a goal blocks dispatch and leaves a running attempt alone.
**Review — UI.** Operator and agent turns are distinguishable without colour alone. A
30-day-old goal says the harness has forgotten it rather than showing an empty chat.

### Spike C — Usage and context limits

**Questions.** What token usage does each driver emit, and in what shape? Does either
expose a model's context window through the catalogue bit already reads?

**Deliverable.** Findings in `DECISIONS.md`, including which fields are unavailable per
driver, because the meter must render honestly where the denominator is missing.

### Slice 10 — Thinking and the context meter

**Delivers.** Thinking blocks in all three chats, and a context indicator that opens a
detail panel.

`NarrationDetail` gains `thinking` and `usage`; both clients map them. New live item kinds.
`HarnessModelView` gains an optional `contextLimit`. The meter plus detail panel (session
id, provider, model, limit, totals, message counts, timestamps) on goal, planner and
attempt chats.

**Review — UI.** With no context limit available, the meter shows totals and no
percentage. Thinking is collapsed by default and is never presented as a record.

### Slice 11 — Uploads

**Delivers.** Attach files to the goal conversation.

A server-side upload route writing under a bounded root inside the goal's directory, with
size and count caps. An explicit attachment list in the prompt rather than mutating the
operator's text. Composer UI.

**Review — code.** The browser never names a filesystem path. Nothing lands in the worker
workspace. Caps are enforced server-side.
**Review — UI.** A rejected upload says why.

### Final — whole-branch review

One reviewer over the whole branch on the most capable model, with this document as the
spec. Focus: the authority boundaries (slices 3, 4, 7, 9) read together rather than one at
a time, which is the only way the escalation path in decision 5 is visible.

## 5. Review focus

Conditions this spec implies that no single slice's tests naturally cover, most likely to
bite first:

1. **A goal whose brief outgrows the model.** Decision 11 says refuse; the refusal must
   reach the operator as a sentence naming the size and the ceiling, not as a failed round
   with no explanation. Owned by slice 6.
2. **A planner round running while a worker settles an attempt under the same goal.** The
   round's last read is stale by definition; only `add_intent`'s write-time join prevents a
   duplicate. Owned by slice 7.
3. **A second browser tab.** Claims, round starts and goal ends are all reachable twice.
   Each refusal must name the holder. Owned by slices 2 and 5.
4. **A harness that has forgotten a session.** Every chat surface must distinguish "no
   messages yet" from "the harness no longer has them". Owned by slice 9.
5. **A restart with a goal session live.** The grant is gone, the goal row is not. The next
   operator message must open a new session rather than prompting a dead one, and must say
   that the conversation before it is unavailable. Owned by slice 9.
