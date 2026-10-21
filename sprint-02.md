# Sprint 02 — The investigation survives a restart

Persist the same useful loop, with per-target isolation and trustworthy mutation
identity. Written 2026-10-21 from `DECISIONS.md` and `sprint-roadmap.html`, in the
roadmap's five-part sprint contract. Architecture source is `DECISIONS.md`; where this
brief and that document disagree, the document wins.

## Already banked — do not re-scope

Half of the original Sprint 02 card landed early, during Sprint 01 and the §22
milestone:

| Item                                                                                                         | Where                                              |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Statically imported, append-only migrations through a real `Migrator`, run to completion before store access | `migrations.ts` (`0001`–`0007`)                    |
| SQLite pragmas — `busy_timeout`, `foreign_keys`, WAL, `journal_size_limit`                                   | `sql.ts`, asserted live in `sql.test.ts:48`        |
| Attempt authority: pinned binding, `write_fence`, per-attempt credentials, stale rejection across restart    | `attempts` + `mcp/credentials.ts` + `store.ts:816` |
| Command receipts: exact retry replays the original result, conflicting retry refuses and writes nothing      | `store.ts:846`–`967`                               |
| Store-assigned monotonic `sequence`, allocated inside the transaction                                        | `store.ts:913`                                     |
| Append-only observations — no `UPDATE observations` path exists                                              | `store.ts`                                         |
| Restart preserving provenance; unsettled attempts reconciled honestly                                        | `recovery/`, §22                                   |
| Parameterised tagged-template SQL, schema-decoded rows, every statement run against a real file              | `store.test.ts`, `migrations.test.ts`              |

The remaining work is concentrated on **two tiers, the graph being written through the
store rather than by test fixtures, and the event/outbox write path.**

## 1. User-visible outcome

An investigation lives in its own file. Kill the process mid-hunt and restart: the graph,
its provenance and the obligations recorded before the crash are intact, a mutation
retried after the crash yields one result rather than two, and an attempt whose authority
was revoked cannot change anything. Deleting a target is `rm -rf targets/<id>/`.

## 2. One end-to-end demonstration

A fifth phase on `milestoneProof.ts`, or a sibling proof driven from `spike/phases.ts`:

1. Two targets exist in `control.sqlite`'s registry; migrations run across both.
2. Work on target A records an asset, an intent anchored to an existing observation, and
   an observation — each writing its domain row, receipt and event in **one** transaction,
   with an outbox entry where the change implies an obligation outside the database.
   Corrected 2026-10-21: the first draft said all three carry one. Creating an intent has
   no external effect, and §6 defines the outbox as a queue of side-effect _requests_, so
   writing an empty obligation would be noise. A later notification is driven from the
   event.
3. The process is killed between two mutations.
4. On restart: the event log reads back in sequence order, the outbox still holds its
   undispatched obligations, the attempt is reconciled, and target B's file is untouched
   and unreachable from target A's connection.
5. The same `operationId` replayed returns the original result, with no second event and
   no second outbox row. The same id with changed input is refused and writes nothing.
6. A superseded attempt's credential is refused after the fence bump.

## 3. Required contracts

- **Two tiers** (§3). `control.sqlite` holds settings and the target registry;
  `targets/<id>/hunt.sqlite` holds the graph and events; evidence stays out of SQLite.
  The migrator iterates the registry **from day one** — §3 is explicit that retrofitting
  at target #4 is painful.
- **Per-target sequence** (§8): "Cursors belong to a particular target event log, not a
  global sequence across independent target files." This also removes the coupling §22
  flagged, where one global cursor means any write anywhere moves `preparedAtSequence`.
- **Intent anchoring** (§4). An intent anchors only to an existing confirmed observation
  or finding, never to an intent, goal or hint; empty parents mean a new top-level
  direction; the rejection is instructive rather than a bare failure. §4 calls this the
  differentiator and says to implement it before anything else that writes to the graph.
- **Three identities at the mutation boundary** (§6): caller authority from the
  authenticated context, operation identity for retries, domain identity for
  rediscovered assets. Kept separate.
- **Append-only events** (§3): immutable rows, stable ids, store-assigned monotonic
  sequence, decided at schema time rather than retrofitted.
- **Event evolution** (§6, `unknownField.ts`): readers tolerate undeclared fields by
  returning `undefined` rather than throwing.
- **Outbox meaning** (§6): a durable queue of _side-effect requests_, written in the same
  transaction as its domain change. It does not provide exactly-once remote execution.
- **Asset identity** (§17 `SPIKE`, open): type-specific uniqueness for the few types the
  fixture uses, and no more. Avoid both duplicate representations of one host and
  over-normalisation that merges behaviourally different endpoints.

## 4. Known uncertainty

- **Do not renumber sequences.** An observation's id is `obs_${sequence}_${attemptId}`
  (`store.ts:918`) and dimension addresses are built from it, so renumbering per target
  would rewrite primary keys and every address already printed in a briefing. Each target
  file keeps its own counter going forward and existing ids stand. Decide this on day
  one, not on day three.
- **Partial fleet migration.** There is no `down` and no `redo` (§3). A failure on target
  3 leaves 1 and 2 migrated. Policy is undecided: fail startup entirely, or serve
  migrated targets and mark the rest unavailable. Choose before writing the runner, and
  record the choice.
- **`add_intent` hits the planner-authority gap.** Intents are planner-generated, and a
  planner round has no attempt — but `CallerContext` requires `attemptId` and
  `attemptFence`, and `checkAuthority` validates against a live unsettled attempt. This
  sprint therefore enforces anchoring **in the store**, with the host creating intents as
  it does today; the planner-facing tool waits for Sprint 07, when there is a planner
  loop to authenticate.
- **Endpoint identity** is where over-normalisation bites first: URL + method, versus URL
  - method + role.
- **Crash-window testing.** One transaction is the mechanism, but proving nothing is
  half-written means killing the process mid-transaction, not asserting that SQLite is
  atomic.

## 5. Scope to drop if time is short

In this order:

1. `record_asset` as an MCP tool — keep the identity rules and store-level enforcement,
   drop the tool surface.
2. The second real target in the proof — keep registry iteration, exercise it in tests.
3. Outbox entries for all but one event kind.
4. The `unknownField` reader — the event schema is ours and stable this week, so the rule
   can land with Sprint 03's consumers.

Anchoring, receipts across every mutation, and the single-transaction write are **not**
droppable. They are the sprint.

## Done when

- Restart preserves provenance.
- A retried mutation has one result; a conflicting retry has none.
- A superseded attempt cannot change current state.
- Two target files, migrated independently, with no cross-target read path.

## Explicitly not this sprint

Reading events back through durable cursors, PubSub wake-ups, startup catch-up, outbox
claims, leases, delivery state and retry scheduling are all Sprint 03. Sprint 02
**writes** events and outbox rows; Sprint 03 **consumes** them.

## Sequencing note

Do §17's now-half — `0008_observation_dimensions` and
`0009_intent_dimension_provenance` — **before** the target split. `0008`'s backfill is a
`json_each` statement far easier to validate against one file than against a registry of
N, and it changes dimension identity, which briefings print, so it wants to settle before
anything else moves underneath it.
