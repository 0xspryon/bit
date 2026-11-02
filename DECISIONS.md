# Hunt Platform — Architecture & Porting Decisions

Working record of what we are building, what we port from which source, and what we
deliberately leave behind. Written 2026-10-15.

**Reference codebases on disk:**

| Name        | Path                                               | License                      | Role                                               |
| ----------- | -------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| ScopeWeaver | `../artex/scopeweaver`                             | AGPL-3.0                     | Domain + architecture reference. Read, don't copy. |
| OpenCode    | `../01-better-agents-codebases/resources/opencode` | **MIT**                      | Production Effect v4 reference. **May copy code.** |
| T3Code      | `../01-better-agents-codebases/resources/t3code`   | **MIT**                      | Production Effect v4 reference. **May copy code.** |
| ScopeSentry | Local checkout removed                             | AGPL-3.0 + commercial clause | Optional recon feed. Not required.                 |

**Status legend**

| Tag     | Meaning                                               |
| ------- | ----------------------------------------------------- |
| `PORT`  | Carry the idea across; reimplement in the new stack   |
| `COPY`  | Copy code (MIT only); preserve notice                 |
| `FIX`   | Port the concept but fix a defect found in the source |
| `SKIP`  | Deliberately not carried over                         |
| `DEFER` | Good idea, not now; revisit on a named trigger        |
| `SPIKE` | Unresolved; needs an experiment before committing     |

---

## 1. What we are building

A **control plane for autonomous security testing**, where:

- We own durable state: targets, assets, scope, the exploration graph, findings, evidence.
- We own planning: what gets worked on next, and what is allowed to be worked on.
- We **delegate all model work** to coding-agent harnesses (OpenCode / Claude Agent SDK)
  that bring their own subscription credentials.

This is "architecture B" from the T3Code investigation: keep the control plane, replace
the compute. We are building it fresh in the target stack rather than retrofitting
ScopeWeaver's Go, because norma reaches **49 non-test Go files across 8 packages**
(verified: `agent` 21, `server` 19, `sidequestion` 4, plus `traffic`, `mcphttp`,
`llmrec`, `llmpool`, `guard` — 25,789 lines touched), and unpicking that is months of
archaeology in someone else's codebase.

### Why delegate rather than call model APIs

1. **Legitimacy.** Every subscription we hold is gated behind a coding agent, not a raw
   API. Delegation is the sanctioned path; shims are not.
2. **Economics.** Planner + N workers + judge is a token furnace. Flat-rate wins.
3. **Inherited harness.** Permissions, context management, tool-call retries, sandboxing
   — all better than what we'd build.
4. **Model agility.** No provider-shape maintenance.

---

## 2. Stack

| Layer                   | Choice                                                          | Notes                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                | **TypeScript strict ESM + Effect v4** (`effect@4.0.5`)          | Registry-verified stable for the foundation on 2026-10-18; TypeScript 6.0.3 matches current Svelte/lint peer ranges.                                                                                                                                       |
| Runtime/package manager | **Bun 1.4.3 + Bun workspaces**                                  | Accepted 2026-10-18; native `bun:sqlite`, pinned versions and Bun lockfile.                                                                                                                                                                                |
| Monorepo tasks          | **Turborepo 2.11.9**                                            | Explicitly selected by the operator; `apps/server`, `apps/web`, `packages/contracts`.                                                                                                                                                                      |
| Primary agent runtime   | **OpenCode v2**, client/server (`@opencode/client@2.0.29`)      | Effect-native (`effect@4.0.1`). Spawn `opencode serve`, talk HTTP — **not** the embedded SDK. See SPIKE-1 resolution in §12. Host-driven sessions.                                                                                                         |
| Secondary agent runtime | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk@0.3.299`) | Zero deps, plain TS. Confirmed subscription auth.                                                                                                                                                                                                          |
| Database                | **SQLite via `effect/sql` + `@effect/sql-sqlite-bun@4.0.5`**    | Accepted 2026-10-20, replacing Drizzle; see §3. Official Effect v4 driver over `bun:sqlite`, zero dependencies, MIT. Parameterised tagged SQL, `SqlSchema`-decoded rows, `effect/sql/Migrator` with a journal, scoped connection lifetime, typed failures. |
| UI                      | **Svelte / SvelteKit**                                          | `adapter-static`.                                                                                                                                                                                                                                          |
| Proxy / traffic         | **Caido CLI** (headless, GraphQL)                               | Not building a MITM proxy. See §7.                                                                                                                                                                                                                         |

### Foundation implementation boundary (2026-10-18)

`bit/` established the runnable monorepo, a health endpoint and static browser shell,
browser-independent Effect contracts, and a scoped SQLite layer with real
commit/rollback tests. It has no planner, evidence pipeline or exploration graph. The
architecture and build order below remain future work; establishing the base does not
imply those features are implemented.

**`CORRECTED 2026-10-20`.** This section previously described Drizzle's synchronous
transaction callbacks as the rule to follow and called `effect/sql`'s adapter and
migrator "superseded". Both statements are now wrong, and §3 records the replacement.
What survives from the old rule is the part that was never about Drizzle: no harness
call, HTTP request or filesystem work inside a transaction, because SQLite's single
write lock is held for its duration. Transaction bodies themselves are now ordinary
Effects and may yield.

### Effect v4 gotchas (verified, do not write from memory)

- **`Effect.fork` does not exist.** Use `forkChild` / `forkIn` / `forkScoped` / `forkDetach`.
- `Context.Tag` → **`Context.Service`**; `FiberRef` → **`Context.Reference`**; `Runtime<R>` **removed**.
- **No compatibility exports for v3 paths.** Every v3 blog post, SO answer, and
  model-generated snippet will be wrong.
- `@effect/ai` has **no v4** (latest 0.37.0). Irrelevant if we delegate — another reason to.
- Several core modules tagged `@stability unstable`.

**Added 2026-10-19, verified against the installed `effect@4.0.5` types while building
the Sprint 1 slice.** Each of these cost a compile error first:

- **`Effect.catchAll` does not exist, but `Effect.catch` does.** `CORRECTED
2026-10-19`: the earlier note here stopped at the missing name and sent readers to
  `Effect.result` as if reifying the failure were the only option. The direct
  replacement exists — `Effect.catch(self, (e) => ...)` catches every typed failure
  (`src/Effect.ts:4551-4588`, exported as `catch_ as catch`), alongside the typed
  `Effect.catchTag` / `catchTags` / `catchCause` / `catchReason` family.
  `Effect.result` is correct when you genuinely want to _inspect_ an outcome — the
  spike demos use it to tell "the wait call failed" from "the session failed", which
  is a distinction they must report rather than recover from — but it is not the
  general catch.
- **`Effect.timeout` fails with `Cause.TimeoutError`** (`_tag: "TimeoutError"`,
  `src/internal/effect.ts:6406`), so it is catchable by tag. `Effect.timeoutOption`
  returns an `Option`, not `undefined`.
- **`Effect.Effect.Success<T>` → `Effect.Success<T>`.** The success/error/services type
  helpers are top-level exports now, not members of an inner namespace
  (`dist/Effect.d.ts:140`).
- **`Result` carries `.success` / `.failure`, not `.value`.** `Result.d.ts:149-152` and
  `:233-240`. Note the trap: `JSON.stringify` of a `Result` prints `"value"` because of
  its `Inspectable` rendering, so a runtime log will actively mislead you here.
- Schema API shape: `Schema.Struct({...})`, `Schema.Literals([...])`, `Schema.Array`,
  `Schema.optional`, and `Schema.decodeUnknownResult` / `decodeUnknownSync` /
  `decodeUnknownEffect`.
- **`FIX` — Schema → JSON Schema conversion does exist. The earlier claim here was
  wrong.** `CORRECTED 2026-10-19`. This entry previously said there is no Effect Schema
  → JSON Schema converter in 4.0.5 and that an MCP tool's `inputSchema` must therefore
  be hand-written. Both halves are false, and the hand-written schema they justified
  was a real liability: two descriptions of one payload, in two naming conventions,
  with nothing keeping them in step.

  What is actually installed:

  - `Schema.toJsonSchemaDocument(schema, options?)` — `src/Schema.ts:17040`. Returns
    `{ dialect, schema, definitions }`. Verified by running it against
    `RecordObservationInput`.
  - `Tool.getJsonSchemaFromSchema(schema)` — `src/ai/Tool.ts:1772-1804`. The same
    conversion with `$defs` attached, which is what `effect/ai`'s own tool
    registration uses.
  - `effect/JsonSchema` converts _between_ dialects. That part was right; it was
    mistaken for the whole story.

  For a transformation schema the document describes the **encoded** side, which is
  exactly what an advertised wire schema needs. So `record_observation` now defines one
  canonical schema in `@bit/contracts` and derives both ends from it:

  ```ts
  // packages/contracts/src/observation.ts
  export const RecordObservationInputWire = Schema.Struct({
    ...RecordObservationInput.fields,
    conditions: ObservationConditionsWire,
  }).pipe(Schema.encodeKeys({ operationId: "operation_id" /* ... */ }));
  ```

  `Schema.encodeKeys` (`src/Schema.ts:3683`) renames keys on the encoded side only, so
  the domain type stays camelCase and the wire form is snake_case. One schema is both
  the decoder for incoming arguments and the source of the advertised `inputSchema`;
  `apps/server/src/mcp/server.test.ts` asserts the advertised property names and the
  decoder's accepted names are the same set, so they cannot drift.

  Two things follow from doing it this way rather than by hand. Field `description`
  annotations reach the advertised schema, so the honesty rules a worker reads are
  maintained in one place. And `Schema.Number` renders as an `anyOf` admitting
  `"Infinity"` / `"NaN"` strings, which pushed the epoch-millisecond and count fields
  onto `Schema.Finite` / `Schema.Int` — a domain improvement found only because the
  derivation made the sloppiness visible.

### Provider auth

| Runtime          | Mechanism                                                                                                                                                                                                       | Status                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Claude Agent SDK | Spawns the CLI, which reads **stored OAuth credentials from the OS keychain**. Set `CLAUDE_CONFIG_DIR`; **never override `HOME`** — it relocates the macOS keychain lookup and the CLI reports "Not logged in". | **Confirmed** (T3Code `provider/Drivers/ClaudeHome.ts`) |
| OpenCode         | Unknown whether an embedded host reuses OpenCode's stored credentials.                                                                                                                                          | `SPIKE-1` — blocking                                    |
| GLM (z.ai)       | API key. Coding Plan endpoint `api.z.ai/api/coding/paas/v4` — **permission granted**. General API `api.z.ai/api/paas/v4` needs none.                                                                            | Granted                                                 |

---

## 3. Persistence

### Two tiers

```
~/.hunt/
  control.sqlite                  # settings, LLM profiles, credentials, target registry
  targets/
    <target-id>/
      hunt.sqlite                 # graph, intents, findings, conversation, events
      evidence/                   # content-hashed blobs, out of SQLite
```

**Rationale for per-target files** (we diverge from T3Code here, which uses a single
`statev2.sqlite` for everything):

1. **Provable deletion.** Clients and programs require evidence destruction.
   `rm -rf targets/<id>/` is complete and demonstrable. `DELETE` + `VACUUM` is not.
2. **Scope isolation as a filesystem guarantee**, not a `WHERE` clause we might forget.
   Given that scope drift is the central defect we found in ScopeWeaver, this is thematic.
3. **Size.** Traffic capture is heavy.

**Accepted cost:** migrations must run against N files. Build the migration runner to
iterate the target registry **from day one** — retrofitting at target #4 is painful.
Cross-target queries get harder; if that bites, add a roll-up table in `control.sqlite`.

### `COPY` — SQLite pragmas

From T3Code `apps/server/src/persistence/Sqlite.ts:19-24`:

```sql
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA journal_size_limit = 33554432;   -- 32 MiB, WAL cutback on first commit
```

Also copy the `layerMemory` / `:memory:` test-layer pattern.

### `FIX` — `effect/sql` replaces Drizzle entirely

**Accepted 2026-10-20**, at the operator's explicit direction, superseding the
2026-10-18 Drizzle choice recorded in §2. Drizzle is gone from the repository: no
`drizzle-orm` dependency, no `schema.ts` table definitions, no `database.ts` wrapper.
There is now one description of the schema — the migrations — rather than two that had
to be kept in step by hand.

**Driver, and why this one.** `effect/sql` is a subpath of `effect` itself in 4.0.5
(`Migrator`, `SqlClient`, `SqlSchema`, `Statement`, …), but `SqlClient` is a _service_
with no implementation: it does nothing until a driver provides it. The driver is
`@effect/sql-sqlite-bun@4.0.5`, which was registry-verified before adding:
`peerDependencies: { effect: "^4.0.5" }` exactly matching the installed version, **zero**
runtime dependencies, MIT, 257 KB unpacked. It wraps `bun:sqlite` directly, so no native
module is compiled and no second SQLite is downloaded. `@effect/sql@0.52.1` — the v3-era
standalone package — peers on `effect@^3.22` and `@effect/platform`, and is _not_ what
this uses; reading its docs or examples will mislead.

**What the driver does and does not configure.** `SqliteClient.layer` opens the file into
the layer's scope and closes it on exit, sets `busy_timeout = 5000`, enables WAL, and
serialises every statement behind a semaphore of one
(`@effect/sql-sqlite-bun/src/SqliteClient.ts:140-299`). It does **not** set `foreign_keys`
or `journal_size_limit`, so `apps/server/src/persistence/sql.ts` applies them and then
reads all four back off the live connection; `sql.test.ts` asserts the read-back values.
This matters more than it sounds: with `foreign_keys` off, every `REFERENCES` clause in
the migrations is decoration, and nothing else would have noticed.

**Transactions.** `sql.withTransaction(effect)` holds one connection for the body
(`effect/src/sql/SqlClient.ts:394-491`) and SQLite's `BEGIN IMMEDIATE` takes the write
lock up front. `recordObservation` runs the receipt lookup, the sequence bump, the
observation insert and the receipt insert inside one such transaction, so they commit
together or not at all. A receipt conflict fails _inside_ the transaction, which is why
the sequence cursor cannot advance on a refused call — asserted, not assumed. The old
rule about synchronous callbacks is obsolete; the rule that survives is that no harness
call, HTTP request or filesystem work happens inside a transaction body.

**What is typed, and what is not.** Rows are decoded through `SqlSchema.findAll` /
`findOne` / `findOneOption` against Effect Schema result schemas, so a column of the
wrong type, or a JSON column that no longer matches the contract, is a typed
`StoredRowError` naming the row rather than a cast. Driver failures become a typed
`DatabaseError` carrying the operation and the driver's classified reason
(`UniqueViolation`, `ConstraintError`, `LockTimeoutError`, …).

**`FIX` — do not claim SQL typos are caught at compile time.** They are not, and a
generic result annotation does not catch them either. `sql<Row>\`SELECT …\``asserts a
shape; it does not read the statement. A misspelled column, a misspelled table, a wrong
placeholder count, or a`SELECT`that omits a field the result schema requires all
compile cleanly and fail only when executed. That is the entire reason`apps/server/src/persistence/{sql,migrations,store}.test.ts`execute every repository
statement and every migration path against real SQLite files — 66 tests under`bun run test:persistence`. The decoders cover the _decode_ half; the integration tests
cover the SQL half. Neither is optional and neither is a substitute for the other.

### `FIX` — migrations, with the migrator's real limits stated

`apps/server/src/persistence/migrations.ts` holds the chain as a literal record of
statically imported Effects keyed `<id>_<name>`, loaded with `SqliteMigrator.fromRecord`
(`effect/src/sql/Migrator.ts:410-423`). Static imports rather than a glob or a filesystem
scan, so `bun build` cannot drop a migration. The earlier design note's
static-import/target-iteration intent is preserved; only the mechanism changed.

Verified behaviour, each covered by a test:

- **A journal.** `effect_sql_migrations (migration_id, name, created_at)`, created on
  demand.
- **Pending-only application.** The migrator reads the highest applied id and skips
  everything at or below it. A repeated startup applies nothing, which is what stops
  `0002`'s table rebuild from running twice and destroying observations.
- **Transactional failure.** The entire run — journal inserts and migration bodies
  alike — is inside one `sql.withTransaction` (`Migrator.ts:321`), and SQLite makes DDL
  transactional. A migration that fails leaves neither its schema change nor its journal
  row. Note the consequence, which is not what a per-migration transaction would do: if
  the failing migration is in the _first_ batch, the whole batch rolls back and the
  database is left empty rather than half-built.

**Honest limitation: there is no `down`, no `redo`, no `undo`.** `MigratorOptions` has a
loader and nothing else, and `ResolvedMigration` is `[id, name, load]` with a single
effect — there is no reverse direction anywhere in the module. No such framework was
built here, and none was asked for. The way to retract a migration is a new forward
migration that corrects it; the way to know the chain still builds from nothing is to
replay it into a throwaway file, which `migrations.test.ts` does on every run.

**Second honest limitation: a failing migration arrives as a defect.**
`Migrator.runMigration` wraps the body in `Effect.die(new MigrationError(...))`
(`Migrator.ts:221-233`), so a caller handling only the error channel sees the fiber die.
`runMigrations` converts it back to a typed `DatabaseError`. Relatedly, migration bodies
deliberately do **not** `orDie` their own `SqlError`: the migrator's `Effect.catch` is
what attaches the migration's name, so a body that dies reports SQLite's message with no
indication of which migration produced it. That was found by a test asserting the error
named `3_broken` and getting `UnknownError` instead.

**The adoption path for existing databases.** The pre-change bootstrap ran
`CREATE TABLE IF NOT EXISTS` on every start and recorded nothing, so a real
`.runtime/hunt.sqlite` has the old tables and **no journal**. Migration `0001` therefore
reproduces that bootstrap byte for byte, `IF NOT EXISTS` clauses included: against an
existing file every statement in it is a no-op, and only `0002` does work. Replaying the
same chain into an empty file produces the same schema — `migrations.test.ts` asserts the
two column sets are equal. Run against a copy of the real six-observation evidence
database, `migrate` reported `[[1, "delegation_memory_slice"], [2, "observation_cases"]]`,
a second call reported `[]`, and all six observations, all six receipts and the sequence
cursor at 6 came through unchanged.

### `PORT` — append-only message storage

Immutable rows, stable IDs, store-assigned monotonic sequence. **Decided at schema
time, not later** — retrofitting append-only onto a mutable store is painful, and it
costs nothing now. This is what makes the (deferred) summary tree possible and gives
us report reconstruction for free.

---

## 4. Core model — ported from ScopeWeaver

### `PORT` — the exploration graph

`scopeweaver/db/constants.go`:

| Kind      | Meaning                                                                             |
| --------- | ----------------------------------------------------------------------------------- |
| `goal`    | A task objective                                                                    |
| `intent`  | An exploration direction (planner-generated)                                        |
| `fact`    | A worker's result or conclusion, **including negative results**, tied to its intent |
| `finding` | A confirmed vulnerability (distinct from a fact)                                    |
| `hint`    | Operator-supplied steer                                                             |

`begin` is deprecated upstream; new tasks seed an origin fact (`KindFact` + `StateOrigin`).

### `PORT` + `FIX` — observations are scoped evidence, not intent-wide verdicts

Accepted 2026-10-17. The graph is authoritative **recorded knowledge**, not guaranteed
truth. Preserve observations separately from interpretations and confirmed findings.
Add a `record_observation` operation to the delegation seam; ordinary and negative
results must survive the disposable worker session, not only assets and findings.

An observation belongs to an intent and execution attempt and records:

- `outcome: positive | negative | inconclusive`, relative to an explicit `tested_claim`.
  Positive means the observation supports that narrow claim; negative means the test
  did not support it under the recorded conditions; inconclusive means the test cannot
  decide it. A timeout or broken test is not a negative result.
- `tested_claim`, tested assets/endpoints, account or role context, method, relevant
  configuration, time window, and test bounds (such as request counts).
- Observed behavior and evidence references, separately from the worker's interpretation.
- Known limitations, untested dimensions, and provenance (`intent_id`, `attempt_id`,
  worker/session identity, observation time).

**Never store a single positive/negative outcome as the verdict for a broad intent.**
Intent execution status (done, blocked, exhausted, etc.) is separate from whether a
hypothesis was supported. Multiple positive, negative, or inconclusive observations can
coexist on one intent. Briefings and any later summaries must retain each observation's
tested claim, bounds, and limitations; counts or one observation must not automatically
settle the intent. Broader conclusions explicitly cite supporting and conflicting
observations and state remaining uncertainty. Finding confirmation is a separate step.

Example: for “can auth rate limits be bypassed?”, IPv6 /128 rotation inside one /64
may positively support “rotation evades the observed 10-requests-per-IP limit”. It does
not establish unlimited authentication attempts or bypass of an account-wide limit.
Record whether the same account was used, request counts, and the observation window;
the possible 100-requests-per-account-per-day limit remains untested until measured.
A subsequently observed account limit qualifies the broader conclusion rather than
erasing the narrower positive observation. Negative results are equally bounded:
“not reproduced under these conditions”, never automatically “not vulnerable”.

Reason: fact anchoring preserves provenance but cannot itself establish correctness.
The planner must be able to identify the next untested slice without inheriting a false
intent-wide verdict. No confidence-scoring subsystem is required initially.

### `PORT` — the graph's physical shape

ScopeWeaver (`db/schema.sql:153-283`). Four tables, and the design choices matter more
than the columns.

```sql
explorations          -- graph root, one per task
  id, description, goal, status ∈ (open|achieved|failed), round_no BIGINT

exploration_nodes     -- ALL kinds, polymorphic
  id, exploration_id, kind, payload JSONB, priority INT, state,
  origin, owner, blocked_reason, delete_reason,
  content_version INT, cold_since_round BIGINT, timestamps

exploration_edges
  exploration_id, src_id, dst_id, rel, created_at
  PRIMARY KEY (exploration_id, src_id, rel, dst_id)   -- idempotent inserts

exploration_anchors   -- node ↔ asset, M:N
  node_id, asset_id
```

**Design points to carry over:**

1. **One polymorphic node table**, not a table per kind. Uniform edges, one index
   strategy, trivial traversal.
2. **The per-kind state machine is a DB CHECK constraint**, not application logic — a
   buggy tool handler or confused agent cannot persist an invalid `(kind, state)` pair:

   ```sql
   CHECK ((kind='intent'  AND state IN ('open','running','paused','done','blocked','exhausted','stopped','deleted'))
       OR (kind='goal'    AND state IN ('open','met','abandoned'))
       OR (kind='fact'    AND state IN ('confirmed','dismissed','origin'))
       OR (kind='finding' AND state IN ('confirmed','dismissed'))
       OR (kind='hint'    AND state IN ('active','consumed'))
       OR (kind='digest'  AND state IN ('active','superseded')))
   ```

3. **Five edge relations carry the semantics:** `spawns` (planning lineage),
   `derived_from` (provenance), `yields` (intent → fact), `proves` (fact → finding),
   `covers` (digest → member).
4. **Partial index matching the hot query exactly:**
   ```sql
   CREATE INDEX idx_expnodes_frontier ON exploration_nodes(exploration_id, priority DESC)
     WHERE kind='intent' AND state='open';
   ```
5. **`content_version`** bumps on any change that could alter a digest body — this is
   what lets `major` compaction reuse unchanged bodies instead of re-summarising.
6. **`cold_since_round` is measured in planner rounds, not wall-clock.** A paused task
   must not have its whole graph go cold overnight.

### `PORT` — the atomic intent claim

No row locks, no `SKIP LOCKED`. A compare-and-swap on the state column
(`db/exploration.go:1172`):

```sql
UPDATE exploration_nodes SET state='running', owner=$1
WHERE id=$2 AND exploration_id=$3 AND kind='intent' AND state='open'
-- claimed iff RowsAffected() == 1
```

The `state='open'` predicate _is_ the lock. `claimNext` (`server/engine.go:1239`) pulls
the top 20 of the frontier and walks down until one sticks, so contention degrades to
"take the next one" rather than blocking. (ScopeWeaver does use `FOR UPDATE SKIP LOCKED`
elsewhere — `task_archives`, `notification_delivery` — so the simpler CAS here is a
deliberate choice.)

**SQLite notes.** Everything ports: partial indexes ✅, CHECK constraints ✅, conditional
UPDATE + rows-affected ✅. Translate `BIGSERIAL`→`INTEGER PRIMARY KEY AUTOINCREMENT`,
`JSONB`→`TEXT` + `json_*()` (or native JSONB on 3.45+), `TIMESTAMPTZ`→ISO-8601 TEXT.
**One real difference:** WAL mode allows a single writer, so concurrent claims serialise.
Fine at 3–8 workers with a sub-millisecond claim and `busy_timeout=5000`; reconsider
before setting workers to 30.

### `PORT` — `task_constraints` (a third scope layer)

`db/schema.sql:276+`. Operator-authored `allow`/`deny` constraints as **natural-language
text**, extracted by the goals decomposer at round 0 from the goal/description, editable
at runtime by the main agent, and injected into the planner/worker system prompt each
round.

Distinct from the other two scope mechanisms, and all three coexist:

| Layer                 | Form                                 | Enforcement                            |
| --------------------- | ------------------------------------ | -------------------------------------- |
| Asset intercept rules | patterns (`exact_domain`, `cidr`, …) | **hard** — tool-boundary gate          |
| `task_scope`          | assets/CIDRs                         | coverage denominator + prompt context  |
| `task_constraints`    | prose                                | **advisory** — system-prompt injection |

Prose constraints are how an operator expresses intent that patterns cannot
("don't touch anything that looks like a production payment flow").

### `PORT` — intent anchoring (the single most valuable idea here)

`scopeweaver/agent/tools_insert.go`, `addOneIntent`:

> Intents may anchor only to existing confirmed **fact or finding** nodes — never to
> intents, goals, or hints. New top-level directions use empty `parent_ids`.

The rejection message is **instructive**, not just a failure:

```
parent_id %d is a %q node and cannot anchor an intent. Only existing fact/finding
nodes may anchor intents, not intents/goals/hints. Leave parent_ids empty for a new
top-level direction.
```

This is what keeps a multi-week hunt from drifting into speculation. T3Code has **no
equivalent** — grepping its contracts and orchestration for `dependsOn`, `blockedBy`,
`prerequisite`, `dag`, `topological` returns zero hits. Its "graph" is transcript
lineage. This rule is our differentiator; implement it before anything else that writes
to the graph.

### `PORT` — the engine shape

`scopeweaver/server/engine.go:749`:

- `Run` reads worker count, registers `1 + N` routines, forks one planner loop and N worker loops.
- Workers **claim** intents from persisted state (`claimNext`) — the queue is the
  database, not memory, so a dead worker's intent is reclaimable.
- Planner wakes on a heartbeat (`plannerHeartbeatInterval`, floor 600s) or on activity.

**Effect v4 mapping** (verified against `Effect-TS/effect` main):

| Go construct                                     | Effect v4                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go func()` + `wg`                               | `Effect.forkScoped` / `forkIn` / `forkChild`                                                                                                             |
| `runtimes map[string]*taskRuntime`               | `FiberMap` (`set`/`remove`/`clear`/`awaitEmpty`/`join`)                                                                                                  |
| `context.WithCancelCause` + `context.Cause(ctx)` | `Fiber.interruptAs(fiber, id, annotations)` → read via `Cause.annotations`. **New in v4** — v3 had no cause payload. This is what makes the port viable. |
| `run.done chan error` + select/timer             | `Deferred` + `Effect.timeout`                                                                                                                            |
| `sync.Map` counters                              | `Ref` / `SynchronizedRef` / `MutableHashMap`; `TxRef`/`TxHashMap` for compound invariants                                                                |
| `deleteMu`/`execMu`/`workMu`                     | `Semaphore`, `TxReentrantLock`                                                                                                                           |
| `Broadcaster` → SSE                              | `PubSub.subscribe` (scoped) + `Stream`                                                                                                                   |
| N-worker claim loop                              | `Effect.forEach({ concurrency })` / `Pool`                                                                                                               |
| `defer` / cleanup                                | `Effect.scoped`, `acquireRelease`, `addFinalizer`, `onInterrupt`, `ensuring`                                                                             |
| `AbortCause` + `errors.As`                       | `Data.TaggedError` + `catchTag` / `catchCause`                                                                                                           |
| DI of `Manager`/stores                           | `Layer` + `Context.Service`                                                                                                                              |

### `PORT` + `FIX` — bounded planner expansion and explicit progress

Accepted 2026-10-17. Bound the queued frontier and the number of intents a planner round
may add. Repeated investigations must identify new evidence or changed test conditions;
distinguish transport retries from genuinely new investigation work. Duplicate-intent
handling must account for the tested slice, not merely similar prose. Initial numerical
budgets and equivalence rules remain implementation choices to validate on the first loop.

Planner round results distinguish objective met, actionable next work, currently no
useful next action, and waiting for capacity/evidence. A stopped or exhausted worker is
not proof that the objective is met or that a vulnerability is absent. Preserve scoped
observations and untested dimensions when choosing follow-up work.

Reason: concurrency caps bound simultaneous work, not endless expansion or repetition.
Start with deterministic budgets and explicit outputs, not a speculative scoring system.
Implement with the first planner loop, before increasing worker concurrency.

### `PORT` — live steering via tool-call denial

`scopeweaver/server/engine.go:579`. `SteerWork(intentID, msg)` queues to `steerBox`;
`steerHooks.PreToolUse` drains it and **denies the worker's next tool call**, returning
the message as the denial reason:

```
[Live planner correction] <msg>
(This is the planner's immediate instruction for this intent. The current tool call was
not executed. Adjust the next action; this takes precedence over your current plan.)
```

No stream interruption, no restart. Steering rides the permission channel. This maps
**directly** onto both target runtimes:

- OpenCode: `ctx.tool.hook("execute.before", …)` → fail with `new Tool.Error({ message })`
- Claude Agent SDK: **`PreToolUse` hook**

### `PORT` — the empty-turn nudge

`steerHooks.Stop` (`engine.go:600`) detects a thinking-only turn (no text, no tools) and
injects a continuation, bounded by a limit. Cheap anti-stall; port it.

### `PORT` — task linking

`scopeweaver/db/exploration_sources.go`, `DirectSourceStores()`:

- Joins through `source_task_id`, **re-queried on every call** — "relations disappear
  when a source task is deleted, and inherited context must not retain stale rows."
- **One hop only**: "Sources of a source are never expanded."

### `PORT` — the digest / cold-graph system

`scopeweaver/agent/compaction.go` + `db/digest.go` + `agent/tools.go:2043`.

This is ScopeWeaver's most underrated subsystem, and it independently converged on
Taelin's UniiChat design:

- `KindDigest` nodes linked to members by **`covers` edges** (digest → member).
- **Originals are retained.** `CoveredMembers` maps member → covering digest for ACTIVE
  digests only; a node with no entry is not folded. The digest is an overlay.
- **`expand_digest(id)`** is a model-facing zoom tool. `cold_digests_more` carries
  truncated older digest IDs, expandable on demand.
- `minor` = tiered append of the not-yet-covered cold set; `major` re-derives the whole
  grouping but **reuses bodies whose signature is unchanged**.
- Runs background only, off the planner hot path, mutex + cooldown.
- hot/cold by `cold_since_round`.

**Port the `covers`-edge model specifically** — summaries as retained overlays with
explicit edges beat a tree baked into storage, because you can re-group without
rewriting history and zoom is an edge traversal.

### `PORT` + `FIX` — the evidence chain

`scopeweaver/evidence/store.go:1` — _"Package evidence preserves finding evidence
independently of disposable traffic."_ On finding creation it copies bytes out of the
traffic store under a writer lock (`traffic/evidence.go:16`): "Readers are closed before
releasing the writer lock, so host deletion cannot remove a blob between its index
lookup and its evidence copy."

**`FIX`:** with Caido owning capture, the atomic copy-out becomes a network fetch
against retention we don't control. Mitigation: on `report_finding`, immediately pull
the referenced flows from Caido and write content-hashed blobs to
`targets/<id>/evidence/`. Do not rely on Caido still holding them later.

#### `PORT` + `FIX` — evidence capture is a recoverable lifecycle

Accepted 2026-10-17. Network fetch, filesystem writes, and SQLite commit cannot be one
atomic transaction. Distinguish a recorded finding from its evidence capture state:
pending, captured and linked, or unavailable (with a reason). Pending/unavailable
evidence must not silently appear report-ready. Finding validation and evidence
availability are separate properties.

Persist the capture obligation with the domain mutation, then dispatch it promptly:
fetch the source bytes, write a temporary blob, verify/hash it, atomically place it in
the target's evidence store, and commit its durable reference. Mark capture complete only
after required blobs are durably stored and linked. Reconcile interrupted captures and
orphaned temporary/unreferenced blobs without deleting evidence referenced by another
finding. Repeated capture uses stable identities and content hashes.

Reason: an outbox preserves an obligation, not the source bytes. If Caido removes the
flow before capture, record unavailable evidence honestly; retries cannot reconstruct
it. Implement with Caido ingestion, before relying on generated reports.

---

## 5. Scope enforcement — `FIX`, this is where ScopeWeaver is broken

### What ScopeWeaver actually does (the audit finding)

- `guard/guard.go:4`: _"The RoE authorization-scope mechanism was removed; a replacement
  may be added later."_
- `guard.preToolUse` extracts the shell command **only for the audit log**. No host,
  domain, or IP is ever extracted or compared. There is **no scope check on outbound traffic**.
- The asset allowlist gate (`db/asset_intercept_match.go:195`) is **fail-open**:
  "Empty or entirely disabled allowRules disable the allowlist gate and permit all candidates."
- The LLM judge is **disabled by default** (`GetBool(settingJudgeEnabled, false)`) and
  `defaultJudgeFailAction = "allow"`.
- `AddAutoScope` (`db/task_scope.go`) lets the agent **widen its own scope** as it
  discovers assets — **with no operator-set ceiling**. We keep the mechanism and add the
  ceiling; see "bounded auto-scope" below. The unbounded form is the defect, not the idea.
- No target-side rate limiting anywhere. Default 3 concurrent workers.

### What it gets right, and we keep

Two real enforcement points for asset rules:

| Site                                 | Effect                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/tools_insert.go:245`          | Blocks _recording_ an out-of-scope asset                                                                                                     |
| `agent/tools.go:1060` (`add_intent`) | **Rejects an intent whose bound assets fail the gate** — "Assets bound to intent … failed scope validation. Stop testing the related assets" |

Rule model (`db/asset_intercept.go`): `kind` ∈ `exact_domain | exact_ip | exact_url |
fuzzy_domain | fuzzy_ip | fuzzy_url | cidr`, `action` ∈ `allow | block`, plus `enabled`,
`pattern`, `note`.

Precedence (as stated in ScopeWeaver's own UI help text): block rules checked first, any
match prohibits; if no block matches **and** allow rules exist, an allow rule must match;
**without allow rules, no allowlist applies.**

Matching semantics: `exact_domain` is `strings.EqualFold`; `fuzzy_domain` is
`strings.Contains` — fine for the built-in `.gov`/`.edu` blocks, **dangerous as an allow
rule** (`cyberaar.io` would permit `evil-cyberaar.io.attacker.com`).

### Our design

**Design constraint: this tool runs autonomously.** A human cannot be in every loop.
Damage limitation must therefore come from _code-enforced boundaries_, not from approval
prompts. The two mechanisms below make that possible.

#### The permission pipeline (verified — CC docs, "How permissions are evaluated")

Order of evaluation, which resolves the apparent conflict between autonomy and gating:

| #   | Step                | Note                                                      |
| --- | ------------------- | --------------------------------------------------------- |
| 1   | **Hooks**           | Run **first**. A hook can deny outright.                  |
| 2   | Deny rules          | Blocked **even in `bypassPermissions`**                   |
| 3   | Ask rules           | Falls through to `canUseTool` even in `bypassPermissions` |
| 4   | **Permission mode** | `bypassPermissions` approves here                         |
| 5   | Allow rules         |                                                           |
| 6   | `canUseTool`        | Only if nothing above resolved it                         |

> "For checks that must run on every tool call, use a `PreToolUse` hook: **hooks run
> before every other step, and a hook deny applies even in `bypassPermissions` mode.**"

And on `bypassPermissions` specifically: _"Hooks still execute and can block operations
if needed."_

**So: `bypassPermissions` + a `PreToolUse` scope hook = unattended autonomy with a hard,
code-enforced boundary.** No prompts, no stalls, and the gate cannot be silently skipped.

#### Design points

1. **Gate at the tool boundary, deny-by-default.** OpenCode `execute.before` →
   `Tool.Error`; CC `PreToolUse`. This is the chokepoint every agent action passes.
2. **`canUseTool` is NOT a universal gate** — "calls auto-approved by `allowedTools`,
   allow rules, or `permissionMode` never reach it." Never put the scope check there.
   T3Code's `full-access` installs no interception for exactly this reason; we run
   `bypassPermissions` _with_ hooks instead.
3. **Use `disallowedTools`, not `allowedTools`, to constrain a bypass session.**
   Documented trap: _"`allowed_tools` does not constrain `bypassPermissions`… Setting
   `allowed_tools=["Read"]` alongside `permission_mode="bypassPermissions"` still
   approves every tool."_ Scoped deny rules like `Bash(rm *)` are honoured in every mode.
4. **Bounded auto-scope** — see below.
5. **Target-side rate limiting**, which ScopeWeaver has none of.

#### `PORT` — bounded auto-scope

We **keep** `AddAutoScope`. Autonomous discovery-and-test is the point of the tool, and a
wildcard-scope program authorises exactly that. ScopeWeaver's defect is not auto-scope
itself — it is auto-scope with **no ceiling**.

Our version:

- Each **target** carries an operator-set **perimeter** (root domains, wildcards, CIDRs).
  This is the human-authored authorization boundary and the agent can never write to it.
  It maps directly onto how programs state scope, and onto our target = company +
  perimeter model.
- The agent may **auto-scope freely inside the perimeter** — no approval, no stall.
- Discoveries **outside** the perimeter are recorded as **candidates**, never as scope,
  and never become testable without an operator promoting them.
- Every auto-scoped entry records **provenance**: which discovery produced it, which
  intent, which worker, when. Auditable and revocable in bulk.

This preserves full autonomy within the authorized perimeter while making
out-of-perimeter expansion structurally impossible rather than policy-discouraged.

#### `NEW` — cleanup ledger (in neither reference)

Rollback does not exist for us, but **artifacts we create on a target do**: test
accounts, uploaded files, injected rows, scheduled jobs. ScopeWeaver's judge prompt
reasons about "this test's own artifacts" but nothing tracks them.

Per target, every write the agent makes gets a row:

```
artifact { id, target_id, intent_id, kind, locator, created_at, cleanup_hint, status }
```

At hunt end this is a cleanup checklist; at report time it is a statement of what we
left behind. This is a requirement for responsible autonomous testing and a genuine gap
in both reference codebases.

#### Operational gotchas for `bypassPermissions`

- **Refuses to start as root or under `sudo`** on Linux/macOS outside a recognised
  sandbox — _"the query fails before the first turn."_ Our container must run as a
  non-root user, or this breaks on first launch.
- **Subagents inherit it.** _"A subagent runs in `bypassPermissions` mode only when the
  parent session itself does… inheriting `bypassPermissions` grants them full,
  autonomous system access."_ Worker subagents therefore run unconstrained too — our
  `PreToolUse` gate must cover them, which it does, since hooks are session-wide.
- Not auto-approved in any mode: `rm`/`rmdir` against critical paths, tools marked
  `requiresUserInteraction`, connector tools an org set to `ask`.
- Worth evaluating later: CC's **`auto` mode**, where "a model classifier reviews actions
  such as shell commands and network requests, allowing or blocking each one." That is a
  first-party version of ScopeWeaver's judge, and a possible second layer under the hook.

### `COPY` — `DispatchModeLimit`

T3Code `apps/server/src/orchestration-v2/DispatchModeLimit.ts:14-52`. Prevents an agent
from spawning a child with broader permissions than itself, **re-verified under the
thread lock** because the user could raise modes meanwhile. We need exactly this the
moment an agent can call `add_intent` or spawn a subagent.

---

## 6. Agent delegation layer

### Runtime comparison (verified)

| Capability        | OpenCode v2                                                         | Claude Agent SDK                                                                    |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Effect            | native (`effect@4.0.1`)                                             | none (zero deps)                                                                    |
| Wiring            | `OpenCode.layer()` / `OpenCode.Service`                             | `query()` async generator; wrap it                                                  |
| Session creation  | **host-driven** — `ctx.session.create` + `prompt`                   | model-driven subagents; host runs N concurrent `query()` calls instead              |
| Custom tools      | `editor.add({ input: Schema.Struct })` — **Effect Schema**          | `tool(name, desc, zodShape, handler)` + `createSdkMcpServer` — **Zod**              |
| Universal gate    | `ctx.tool.hook("execute.before")` → `Tool.Error`                    | `PreToolUse` hook                                                                   |
| Interrupt         | `ctx.session.interrupt`                                             | `query.interrupt()` (streaming-input mode only)                                     |
| Events            | `ctx.event.subscribe()` → Effect `Stream`, **95 typed event types** | `SDKMessage` union                                                                  |
| Sessions          | create/get/remove/fork/compact/wait/switchAgent/switchModel         | resume/continue/`forkSession`/`resumeSessionAt`/`listSessions`/`getSessionMessages` |
| Concurrency cap   | not found                                                           | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20)                                 |
| Spend cap         | not found                                                           | **`maxBudgetUsd`**                                                                  |
| Subscription auth | `SPIKE-1`                                                           | **confirmed**                                                                       |

**Decision: OpenCode primary, Claude Agent SDK behind the same adapter interface.**
Pending `SPIKE-1`; if OpenCode auth fails, invert.

### Worker mapping — important

**Do not map workers onto CC subagents.** CC subagents are _model-driven_ — Claude
decides when to spawn them via the Agent tool; the host cannot say "run worker 3 on
intent 42". The docs even have a troubleshooting section titled "Claude not delegating
to subagents."

Map workers onto **N concurrent host-driven sessions**: one Effect fiber per worker,
each pulling an intent from our SQLite queue and running its own session with a
worker-flavoured system prompt and our MCP toolset. The fiber pool _is_ `workerLoop`.

Subagents remain useful for what they're good at — a worker spawning a focused
sub-investigation whose context doesn't pollute its own.

### Provider binding policy (decided)

| Agent          | Provider binding                                   |
| -------------- | -------------------------------------------------- |
| **Main agent** | **Switchable mid-hunt**                            |
| **Planner**    | Switchable (follows main agent)                    |
| **Workers**    | **Pinned to the provider they were launched with** |

Pinning workers removes handoff from the worker path entirely — no context transfer, no
delta summaries, and **no exposure to the thinking-block portability problem**, since a
worker's reasoning never crosses a provider boundary. An intent simply records which
provider ran it.

### `COPY` — capability declaration pattern

T3Code `packages/contracts/src/orchestrationV2.ts:198-337`. Each adapter declares what
it supports; the orchestrator picks a strategy; the policy layer **fails loudly** when a
provider can't honour it. Beats discovering at runtime that a provider silently dropped
context.

`ContextCapabilities` (lines 283-285) is the handoff spec:

```ts
type ContextCapabilities = {
  acceptsSystemContext;
  acceptsDeveloperContext;
  acceptsSyntheticUserContext;
  canGenerateSummaries;
  canConsumeHandoffSummaries;
  supportsDeltaHandoff;
  supportsFullThreadHandoff;
  maxRecommendedHandoffChars;
};
```

Fidelity is **not** uniform: Claude and Codex declare `acceptsSystemContext: true`;
OpenCode's adapter declares `false`.

### Config ownership — what we define vs. what the provider supplies

T3 splits this by direction, and we copy the split with one deliberate divergence.

**Discovered, not owned.** T3 probes the provider for skills and slash commands
(`provider-core/src/server/snapshotProbe.ts` → `ServerProviderSkill`;
`openCodeSkillsToServerProviderSkills`, `openCode2CommandsToServerProviderSlashCommands`).
These live where the provider natively reads them — `.claude/skills/`, OpenCode config,
the repo. T3 has no skill editor, no skill table, no skill migrations.

**Owned and injected.** Its own MCP server (`apps/server/src/mcp/McpHttpServer.ts`) with
twelve toolkits (`orchestrator`, `thread`, `project`, `worktree`, `environment`, `device`,
`preview`, `previewControls`, `pullRequests`, `attachment`, `html`, `core`), plus
`McpSessionRegistry` (session-scoped credentials), `McpToolAccess` (per-tool access
control), `McpInvocationContext`, and `AcpMcpStdioBridge`. Also the per-session query
options: model, permission mode, cwd, env, hooks.

| Concern                                                                            | Owner                             |
| ---------------------------------------------------------------------------------- | --------------------------------- |
| Skills / methodology                                                               | **Provider** — we discover        |
| Slash commands                                                                     | **Provider** — we discover        |
| Orchestrator tools (`record_asset`, `add_intent`, `report_finding`, scope queries) | **Us** — own MCP server, injected |
| MCP credentials & per-tool access                                                  | **Us**                            |
| Model / permission mode / cwd / session lifecycle                                  | **Us**                            |
| **Agent personas** (planner / worker / main agent)                                 | **Us** — diverges from T3         |

**Why the divergence:** T3 is a harness-agnostic GUI, so user-authored agents are the
point. We are a domain product — planner/worker/main-agent are roles the orchestrator
defines, with fixed tool subsets and system prompts (as ScopeWeaver does with
`MainAgentTools()` / `PlannerTools()` / `WorkerTools()`). A user redefining "worker"
would break the intent contract.

**Practical saving: do not build a skill-management subsystem.** Methodology — how to
test IDOR, which payloads, what makes a finding reportable — goes in skill files the
agent reads natively. Version-controlled, editable without touching the app. Still
implement the **discovery probe** so the main agent knows what is installed and we can
report "that skill isn't loaded" rather than watching the agent silently not use it.

### `COPY` — session-scoped MCP credentials

T3Code `apps/server/src/mcp/McpSessionRegistry.ts`. A bearer credential scoped to
{environment, parent thread, provider instance, provider session}, with max-lifetime
_and_ idle expiry, revoked on session release, raw token never persisted. This is how to
safely expose the worker toolset.

Related: **credentials off argv** — T3 passes MCP servers to Claude over the SDK's
**stdin control channel**, not `--mcp-config` (`Adapters/ClaudeAdapterV2.ts:686-689`):

> "The SDK would pass `mcpServers` as an inline `--mcp-config` argument, which every
> local user can read. They go over the CLI's stdin control channel instead, so header
> credentials stay out of its argv **and out of the environment every command the agent
> runs inherits**."

That second clause is load-bearing **for us specifically**: our agents run shell commands
against remote targets. An MCP bearer token in the inherited environment could be carried
off-box by any `curl` the agent fires. Non-negotiable.

### `COPY` — `UsageLimitRecoveryWorker`

T3Code `UsageLimitRecoveryWorker.ts:10-60`. On a subscription usage-limit failure it
persists `usageLimitResetAt`, arms a recovery keyed `threadId:runId:resetMs`, and
auto-resumes when the window opens, with guards against retry loops on an already-expired
window. **A multi-week campaign on a flat-rate plan will hit this.** Highest-value single
copy in the repo for our situation.

**`FIX` — verified implementation limits (2026-10-17).** This is a reference for
persisted recovery scheduling, not ready-made quota routing. The worker requires a
failed `usage_limit` run with a usable reset timestamp, arms recovery, and later dispatches
“Continue where you left off.” (`UsageLimitRecoveryWorker.ts:17-71`). The orchestrator
rechecks recovery identity and requires the provider instance still to match the failed
run (`Orchestrator.ts:4540-4560`). It does not select fallback models or harnesses.
The scheduler sweeps persisted due work every five seconds (`scheduling/Scheduler.ts:52-60`).

The current OpenCode v2 adapter maps `session.execution.failed` to `provider_error`,
without a quota classification/reset timestamp
(`packages/provider-opencode/src/server/v2/adapter.ts:2363-2370`); the shared failure
constructor does not infer a quota class (`packages/provider-core/src/server/failure.ts:147-170`).
Its usage probe is specifically for OpenCode Go, not arbitrary providers behind OpenCode
(`packages/provider-opencode/src/server/usageLimits.ts:21-41,69-103`). Therefore GLM and
other provider quota detection/reset metadata must be verified against actual harness
events; copying this worker alone does not implement their recovery. Claude additionally
has live rejected-limit pauses that do not end the turn
(`Adapters/ClaudeAdapterV2.ts:6571-6624`); distinguish a paused live session from a terminal
quota failure before creating replacement work.

#### `PORT` + `FIX` — usage-limit fallback across models and harnesses

**`FIX` — upstream quota signals verified (2026-10-17).** T3's generic error mapping
is not evidence that OpenCode lacks quota information. Official source checkouts:
`opencode-official` (`dev`, `22e771f5893e255ea78fc10557ed3fb98d3a1072`, client 2.0.32)
and `opencode-official-v1` (`v1`, `a1f604bbe0285c1e43f00a2568c8aa19f0fb02ff`, release
1.19.3). These findings do not establish the exact contract of our pinned 2.0.29.

- V2 exposes `provider.quota`, separately from `provider.rate-limit`, `provider.auth`,
  and other classes (`opencode-official/packages/core/src/session/to-session-error.ts:28-54`).
  Public errors retain type, message, optional HTTP status and raw response body, but
  drop response headers and parsed retry/rate-limit metadata (`:97-104`).
- V1's public `APIError` includes status, retryability, response headers and body
  (`opencode-official-v1/packages/schema/src/v1/session.ts:48-55`). T3's V1 adapter
  likewise flattens errors to `provider_error` rather than exploiting that metadata
  (`t3code/packages/provider-opencode/src/server/adapter.ts:2673-2702`).
- V2 has explicit Z.ai plan/balance classification tests, including five-hour and
  weekly/monthly exhaustion, expired plans, and model entitlement failures
  (`opencode-official/packages/ai/test/provider-error.test.ts:286-314`). A quota error
  therefore does not necessarily describe a window that will reset. Provider body codes
  remain important; do not equate every HTTP 429 with subscription exhaustion.
- `session.retry.scheduled.at` is the harness's next retry time, **not** the quota reset
  time; execution is still live during the wait
  (`opencode-official/packages/core/src/session/runner/retry.ts:94-112`). A step failure
  is not sufficient proof of terminal execution. Observe execution settlement or stop
  and reconcile before launching a replacement attempt.

**`SPIKE` — validate the deployed quota-event contract.** Replay representative provider
errors against the pinned server/client versions before wiring fallback. Prefer event-driven
exhaustion detection and preserve provider body codes; parse reset times only with known
units/timezones. Quota polling is not required to detect an observed rejection. Evaluate
provider-specific quota APIs only if proactive remaining-capacity visibility or missing
reset metadata justifies them. Reconcile session state after event-stream gaps.

Accepted 2026-10-17. Implement analogous recovery with an operator-configured ordered
fallback chain of **harness + provider/account binding + model**, rather than only
waiting for the original quota window to reset. Example operator preferences include
OpenCode/GLM 5.0 → OpenCode/DeepSeek v4 Flash → OpenCode/GPT-6 Astra → Claude Agent
SDK/Opus 5. These are desired selections, not verified model IDs or availability;
resolve them through runtime discovery/configuration when implementing.

- Classify quota exhaustion separately from transient transport failures, authentication
  errors, and unavailable models. Track cooldown/reset state at the actual quota scope
  when known; changing a model on the same exhausted account may not provide capacity.
- Choose an eligible fallback with the required capabilities and the same perimeter,
  role/tool restrictions, and execution budgets. Persist the reason and selected binding.
- **Workers remain pinned per attempt.** Stop/reconcile the exhausted attempt, fence its
  authority, and create a fresh attempt/session on the fallback. Seed it with the intent,
  bounded observations, completed work, and unresolved actions. Do not blindly repeat
  actions with unknown outcomes or transfer a worker's native reasoning history.
- Main-agent fallback uses the existing labelled handoff policy; subsequent planner
  rounds follow the selected binding. Worker fallback does not globally switch the main
  agent or unrelated workers.
- Bound fallback/retry attempts, avoid cycling through cooling-down bindings, and persist
  the wait when all eligible bindings are exhausted. Resume when capacity returns;
  do not busy-loop. Returning to a preferred binding happens at a new attempt boundary.

Reason: unattended work should use available configured capacity without violating
worker pinning or duplicating remote effects. Wire one runtime first; cross-harness
fallback becomes executable when the secondary adapter and handoff support land.

### `COPY` — `unknownField.ts`

Readers that decode undeclared provider payloads without trusting shapes, returning
`undefined` rather than throwing. Two lines of idea, large payoff.

---

### Orchestration patterns — additional `COPY` items

Found on a second pass through areas the first investigation didn't cover. Ranked by
value for a long-running autonomous tool.

#### `COPY` — the outbox pattern (highest value)

`apps/server/src/orchestration-v2/EffectOutbox.ts`, driven by `EventSink.ts`.

`EventSink` commits in **one transaction**: domain events + projections + command
receipt + a queue of typed side-effect requests. A background worker drains the queue
with retry (`Queue`, `Schedule`, `Deferred`, `forkParked`).

```ts
OrchestrationEffectRequestV2 = Union([
  { type: "provider-runtime.continue", sourceRunId },
  { type: "provider-session.detach",   providerSessionId, detail?, … },
  …
])
```

**Why we need it:** an autonomous tool runs for weeks and will crash mid-operation.
State and the actions it implies commit atomically, so a committed finding cannot lose
its notification obligation merely because the process crashes before dispatch.
ScopeWeaver has no equivalent — its notify layer fires inline.

#### `FIX` — outbox meaning and delivery guarantees

Accepted 2026-10-17. The outbox is **a durable queue of side-effect requests**, with
execution metadata (status, attempts, lease, next retry time, last error). It is not
the store of all commands and their domain results. Command receipts deduplicate accepted
commands; domain tables/events record resulting state and observations. A mutation commits
its domain changes, receipt, and required outbox entries in one SQLite transaction.
The dispatcher executes committed requests afterwards and records completion; meaningful
results enter the domain through the normal mutation path.

Example: `report_finding` commits the finding, its receipt/event, and a notification
request together. The outbox dispatcher sends the notification afterwards. A failed send
can be retried without rerunning finding creation. No external network call belongs
inside that database transaction.

**An outbox does not provide exactly-once remote execution.** If a remote action succeeds
and the process crashes before recording success, its outcome is ambiguous. A command
receipt only deduplicates that command's local commit; it does not solve this external
acknowledgement gap. Assign an explicit recovery policy to each effect type:

1. Safe to retry.
2. Retry using a stable idempotency key supported by the receiver.
3. Reconcile observable external state before deciding whether to retry.
4. Outcome unknown: do not repeat automatically; persist uncertainty and schedule a
   reconciliation task where possible. This does not require an approval prompt.

T3 already distinguishes replay-safe from process-bound effects
(`t3code/apps/server/src/orchestration-v2/EffectOutbox.ts:123-141`) and cancels the latter
instead of indiscriminately replaying them (`:490-519`). Port this distinction, not a
blanket “drain everything on restart” policy. Outbox use alone does not require full
event sourcing; the choice of replay-derived versus current-state domain tables is separate.

#### `COPY` — command receipts / idempotency

`CommandReceiptStore.ts` → `persistence/OrchestrationCommandReceipts.ts`. Every command
writes a receipt in the same transaction as its effects, so replay is a no-op. Required
once an autonomous loop retries after a timeout and cannot tell whether the first
attempt landed.

#### `PORT` + `FIX` — three identities at the mutation boundary

Accepted 2026-10-17. Keep these three questions separate:

1. **Caller authority:** derive target, intent/attempt, role, and permission ceiling from
   the authenticated invocation context. Model-supplied IDs select only resources the
   caller is authorized to address; they cannot establish or broaden caller authority.
2. **Operation identity:** mutation retries reuse a stable operation ID namespaced to
   the authenticated caller. Commit a receipt, result reference, domain changes, and
   required outbox entries together. Return the original result on an exact retry;
   reject reuse with conflicting input. Generating a fresh ID for every transport retry
   defeats deduplication. The adapter/tool contract must specify who creates and retains
   the ID; do not assume the harness automatically supplies stable retry identity.
3. **Domain identity:** two distinct operations may discover the same canonical asset.
   Domain uniqueness rules merge the asset identity while retaining both discovery
   provenance records. Similar observations under different accounts, times, or test
   conditions remain distinct; do not merge them by text similarity.

Reason: authorization, retry deduplication, and domain deduplication solve different
problems. Establish invocation/operation identity in step 1 and persist receipts and
domain uniqueness in step 2. T3 reference: `apps/server/src/mcp/McpInvocationContext.ts:23-60`.

#### `COPY` — message dispatch policy

`CommandPolicy.ts`. The typed answer to "the operator typed while the agent was working"
— a path we hit constantly, since mid-hunt directives are the normal workflow.

```
MessageDispatchDecisionV2 =
  start_run | steer_active | restart_active | queue_after_active | switch_provider
```

Decision logic (`CommandPolicy.ts:130-165`), capability-driven with a safe fallback:

```
no active run                → start_immediately
deliveryIntent "steer"       → steer_active
deliveryIntent "restart"     → restart_active
run preparing/starting       → queue_after_active   // can't steer what isn't running
else by capability:
  supportsActiveSteering            → steer_active
  supportsQueuedMessages            → queue_after_active
  supportsSteeringByInterruptRestart→ restart_active
  none                              → queue_after_active
```

ScopeWeaver's `SteerWork` simply **errors** when no worker is running. This is a direct
upgrade, and it is what makes mid-hunt steering work across providers with different
steering abilities.

Related: `SteeringExecutionPolicyV2 = ["active_steering", "interrupt_restart"]`.
ScopeWeaver has only the tool-call-denial trick (§4); providers that cannot support it
need interrupt-and-restart. Two strategies, selected by declared capability.

#### `COPY` — migration strategy (relevant to our per-target DBs)

`persistence/Migrations.ts`: `effect/sql/Migrator` with `Migrator.make` + `fromRecord`,
every migration **statically imported**.

> "All migrations are statically imported — no dynamic file system loading.
> `runMigrations` is called by the SQLite persistence layer at startup, so the schema is
> always up to date before the application starts."

Exactly right for N target databases: static imports bundle cleanly and run identically
against every file, with no per-target filesystem scan to go wrong. Also note
`reconcileV2PreviewMigration.ts` — recovery from a partially-applied state. Copy that
idea once we have more than a couple of targets.

#### `COPY` — smaller items

- **Thread command lock.** Serialises commands per thread; `DispatchModeLimit`
  re-verifies under it because state can change while a decision is being made.
- **Error taxonomy.** `Schema.TaggedError` with structured fields and a `message`
  getter, used consistently. Typed, loggable, catchable by tag.

#### `PORT` + `FIX` — startup recovery service

**Problem:** the process dies mid-hunt. Persisted `running` intents and `live` sessions
no longer prove execution liveness. A separately spawned harness server, shell process,
or remote action may survive the control-plane crash.

T3's policy (`ProviderRuntimeRecoveryService.ts:64-85`) **terminalizes** every run in
`preparing|starting|running|waiting` on boot. Correct for them — their unit of work is a
conversation, and a dead conversation can't be resumed. **Wrong for us**, because our
unit of work is an intent in a queue.

**`FIX` — execution-attempt identity and fencing (accepted 2026-10-17).** Distinguish
the durable **intent**, one **attempt** to execute it, and the harness **session** used
by that attempt. Persist attempt ID, generation/ownership, lifecycle status, binding,
and session linkage. Attempt identity and stale-attempt rejection are schema-critical
in step 2, alongside the outbox, static migrations, and event-evolution rule.

On boot we:

1. Reconcile recorded attempts with owned processes/sessions; do not infer their death
   solely from the control plane restarting. Stop or explicitly recover surviving work.
2. Fence superseded attempts. State mutations check current attempt/generation authority
   transactionally; execution admission rejects revoked attempts. Revoking database
   authority does not cancel already-running network operations: reconcile those too.
3. Preserve partial observations and classify unfinished external actions using the
   outbox recovery policies above. Unknown outcomes are not evidence of non-execution.
4. Requeue eligible intents only after reconciliation, creating a **new attempt** for
   replacement work. Enforce attempt ceilings so poison intents cannot loop forever.
5. Resume replay-safe outbox work; reconcile or cancel process-bound work according to
   its explicit policy. Persist reasons and unresolved outcomes.

This is the payoff for keeping the queue in the database rather than in memory.

#### `PORT` + `FIX` — reconnect and reconcile delegated execution

Accepted 2026-10-17. A lost event stream means **execution state uncertain**, not a
failed worker. Each adapter must reconnect and reconcile against harness state/history,
returning still executing, completed, failed, or unknown/unreachable. Recover missed
results using stable native identities so backfill does not duplicate previously
recorded output. Backfill missing observations only through normal authorized domain
mutations; transcript reconstruction is not evidence that an MCP mutation committed.

Do not launch replacement work solely because the stream disconnected. If reconciliation
cannot establish the outcome, apply the existing attempt-fencing and uncertain-action
recovery rules. Reconcile after process restart and event-stream gaps; never depend on
the delivery of a terminal event alone.

Reference: T3's OpenCode v2 adapter reconnects and backfills session history
(`t3code/packages/provider-opencode/src/server/v2/adapter.ts:2724-2729,2748-2815`).
Reason: execution may continue while its observer is disconnected. Implement before
unattended multi-worker operation; copy the pattern rather than transcript UI machinery.

#### `PORT` — provider lifecycle & error classification

T3's OpenCode integration is a coherent unit worth copying whole
(`packages/provider-opencode/src/server/`):

- `OpenCodeServerOwner` — owns the spawned server's lifecycle per provider instance.
- `OpenCodeServerLedger` — prevents duplicate spawns and orphaned processes.
- `versionProbe.ts` + `MINIMUM_OPENCODE_VERSION` — fail clearly on an unsupported binary
  instead of mysteriously later.
- Health timeout (5s), startup timeout (30s), **bounded startup-output capture (64 KiB)**
  so a broken binary cannot flood logs.
- `status.ts` — **classifies** failures into causes (auth rejected / unreachable /
  version mismatch).

**Why classification matters for autonomy:** it decides between _retry_, _switch
provider_, and _stop and alert_. ScopeWeaver has the same split in `llmpool` — transient
failures (429, 5xx, network) trip a circuit breaker after a threshold; deterministic ones
(402 insufficient balance, 401/403 invalid key, 404 missing model) trip it immediately.
Without this an unattended tool will retry an invalid API key for three weeks.

#### `PORT` — event schema evolution discipline (constraint, not code)

T3's stored event envelope has **no `schemaVersion`** and there are no upcasters:

```ts
OrchestrationV2StoredEvent = Schema.Struct({
  sequence: NonNegativeInt,
  commandId: Schema.NullOr(CommandId),
  event: OrchestrationV2DomainEvent,
});
```

Evolution is handled by **additive-only schemas with decoding defaults**:

```ts
settledAt:   Schema.NullOr(…).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
snoozedUntil: Schema.optional(Schema.NullOr(…)),
```

When a change cannot be additive they add a discriminator and branch on it —
`itemIdentityVersion: Schema.optional(Schema.Literal(2))`.

**THE RULE, adopted before the first event type exists:** a persisted event may only
ever gain **optional** fields (or fields with decoding defaults). Never remove a field,
never change a field's meaning, never change a type. If a change cannot be additive, add
a version-marker field and branch.

Copying the event store without this discipline means writing an upcaster framework
later, or rewriting history we specifically chose to make immutable.

#### `COPY` — testkit Layer pattern + recorded fixtures

Most practically important remaining item: testing an agent system is otherwise slow,
expensive, and (for us) involves attacking something.

Every service ships a co-located `*.testkit.ts` exporting a stub Layer:

```ts
export const layer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({ issue: ({ threadId }) => Effect.succeed({…}) }),
)
```

One per adapter (`ClaudeAdapterV2.testkit.ts`, `CodexAdapterV2.testkit.ts`, …) and per
service. Because services are Layers, a test double is just another Layer — no mocking
framework. Plus `probeResponses.fixture.ts`, which replays **recorded real server
responses** for protocol edges (six fixture files; targeted, not wholesale VCR).

For us: planner, scope gate, intent queue and outbox all testable against stub provider
Layers — zero tokens, zero traffic to a target.

#### `COPY` — credential storage

`provider/ProviderCredentialStore.ts` — _"A provider binding stores opaque bytes; only
its adapter decodes or refreshes them."_ Backed by `auth/ServerSecretStore.ts`.

```ts
// Hash the tuple so arbitrary bindings cannot escape or exceed a filename.
crypto.digest("SHA-256", encode(`${driver.length}:${driver}${bindingId}`));
```

The **length prefix before hashing** is both a path-traversal guard on the derived
filename and a defence against concatenation ambiguity (`"ab"+"c"` vs `"a"+"bc"`). Take
verbatim — we hold Caido keys, z.ai keys, and possibly program credentials.

#### `COPY` — diagnostic logs separate from durable state

`ProviderEventLoggers.EventNdjsonLogger` writes raw provider frames to
`logsDir/provider` as NDJSON, correlated to durable events by optional `rawEventId`.
Raw frames never enter the database; join by correlation id when debugging.

#### `SKIP` — examined and rejected

| Thing                                                                              | Why                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpoints (`CheckpointScope`, `appCanCheckpointFilesystem`)                      | For coding agents editing a repo. **A coding agent makes reversible local changes; we make irreversible remote ones** — you cannot roll back an HTTP request already sent. That asymmetry is why we gate before execution and log after, instead of checkpointing. See the cleanup ledger in §5 for the one thing we do need from this space. |
| Worktrees (`worktree.*`, `native/` worktree code)                                  | Same.                                                                                                                                                                                                                                                                                                                                         |
| Conversation rollback                                                              | Mildly interesting as "undo the last N turns"; OpenCode gives it free via `session.revert.*`. Not worth building.                                                                                                                                                                                                                             |
| Projection / `WireProjection` layer                                                | UI machinery — deferred with the rest of the UI.                                                                                                                                                                                                                                                                                              |
| Cloud link / device pairing (`AuthPairingLinks`, `CloudLink`)                      | Remote access. Later, if ever.                                                                                                                                                                                                                                                                                                                |
| UI transport (`ws.ts`), projections, `WireProjection`, event coalescing            | Real engineering, but UI is out of scope and it is the most re-derivable part once the event stream exists.                                                                                                                                                                                                                                   |
| Desktop updates, AUR packaging, signed artifacts, `native/` (Rust screenshot + VT) | Platform/scale concerns for a shipped desktop product. Not us.                                                                                                                                                                                                                                                                                |

**Mining status:** three sweeps done; yield is now low. A fourth pass should be
targeted at a specific problem encountered during the build, not open-ended.

---

## 7. Traffic & evidence — Caido

**Decision: use Caido CLI headless. Do not build or port a MITM proxy.**

- Caido CLI _is_ the server component; GraphQL on `127.0.0.1:8080`, bearer-token auth.
  Headless automation is a design goal.
- Go SDK exists (`caido-community/sdk-go`, genqlient from the official schema) — useful
  as a schema reference even though we're in TS.
- A third-party `caido-mcp-server` exists, which means a delegated agent could query
  Caido directly over MCP without us mediating.

**Known constraints:**

- Caido is **not open source** (their pricing page states it). Free tier: 2 projects,
  7 workflows. Fine for personal use; blocks redistribution. Since this is personal and
  not distributed, AGPL reciprocity never triggers.
- `SPIKE-3`: read Caido's EULA re: personal automated use of the free tier.
- Evidence must be pulled into our store on finding creation — see §4 `FIX`.

**Rejected alternatives:** `mockttp` (viable but unnecessary now), `http-mitm-proxy`
(stale, 2023), `node-mitmproxy` / `anyproxy` (abandoned), keeping a Go sidecar.

**Dependencies that turned out not to be blockers** (recorded so we don't re-litigate):
`projectdiscovery/dnsx` → Node's built-in `dns.Resolver`; `miekg/dns` → used only for
three constants (`TypeA`, `TypeAAAA`, `TypeCNAME`), delete it.

---

## 8. Conversation, provider switching & the UI record

### `COPY` — AppThread / ProviderThread separation

T3Code `docs/orchestration-v2/core-graph-and-data-model.md`. The mechanism that makes a
provider switch invisible to the user:

- **`AppThread`** — "the user-visible conversation". App-owned, provider-neutral. The UI reads this.
- **`ProviderThread`** — "a provider-native conversation handle". One per provider.
- **`ContextTransfer`** — provider-neutral relationship record (forks, switches, merge-back, subagents).
- **`ContextHandoff`** — materialized portable context artifact.

> "V2 events are durable because they are the app state transition log. Raw provider
> frames are **not** durable app state… the canonical durable row is the normalized V2 event."

**Attribution is preserved, so continuity is a rendering choice:**

| Entity           | Provider fields                              |
| ---------------- | -------------------------------------------- |
| `AppThread`      | `providerBinding`, `activeProviderThreadId?` |
| `Run`            | `providerThreadId`, `contextHandoffId?`      |
| `ExecutionNode`  | `providerThreadId?`, `providerTurnId?`       |
| `ProviderThread` | `coveredRunRange?`                           |

### `COPY` — sequence cursor + bounded resume

#### `PORT` + `FIX` — durable ordered reads; PubSub only wakes consumers

Accepted 2026-10-17. Consumers read committed events from SQLite in ascending sequence
order after their cursor. PubSub carries an advisory wake-up, not the authoritative event
payload or delivery guarantee. A consumer catches up at startup/reconnect and on a bounded
periodic reconciliation sweep, so a crash between commit and notification cannot strand
committed work. Establish subscription/catch-up ordering without a lost-wakeup gap.

Advance a durable consumer's cursor only with successful processing; where processing
changes domain state or schedules effects, commit its receipt/state/outbox and cursor
atomically in the same target database. External effects still use the outbox's delivery
semantics. UI reconnect cursors and replay budgets remain as described below; they are
not durable business-consumer acknowledgements. Cursors belong to a particular target
event log, not a global sequence across independent target files.

Reason: commit order does not guarantee publication order. T3 serializes the commit-to-
publish boundary (`t3code/apps/server/src/orchestration-v2/EventSink.ts:232-259`); our
smaller implementation uses ordered database reads instead. PubSub may coalesce or lose
wake-ups without losing committed events. Implement with the state layer before planner
activity notifications and UI streaming.

Every committed event carries a store-assigned **monotonically increasing `sequence`**:

```
read snapshot at sequence N
  -> stream committed V2 events where sequence > N
```

`decideThreadResume` (`ThreadStream.ts:100-124`) chooses between replaying the gap and a
fresh snapshot, bounded by explicit budgets — 128 replay events, 1 MiB encoded, 1 MiB raw
(`ThreadStream.ts:15,19,26`). Plus `WireProjection` to shrink payloads and
`ThreadLiveEventCoalescer` to batch.

**This is the fix for ScopeWeaver's SSE Broadcaster, which has no cursor and silently
loses the gap on a dropped connection.** Copy it.

### `FIX` — conversation history is the harness's, and we do not keep a copy

Decided 2026-11-02. **We read an agent session's history from the harness that minted it,
and we accept losing it when that harness purges it.** We do not persist conversation
prose — not in a table, not in a file beside the evidence.

Claude Code sweeps transcripts older than `cleanupPeriodDays` (default 30, minimum 1,
configurable). OpenCode keeps sessions in its own SQLite store with no age-based expiry.
Both can be asked for a past session's messages
(`getSessionMessages` / `api.message.list`), which is what `AgentHarness.messages` already
abstracts.

**Why not keep our own copy.** Because it is a second record of the same thing, and two
records of one conversation is a synchronisation problem we would own forever: which is
authoritative when they disagree, what happens to ours when the harness compacts theirs,
what a reader is looking at when both exist. The harness already does this job. Paying to
duplicate it buys a retention guarantee we have not been asked for.

**What this costs, stated plainly.** An attempt's conversation is unreadable once the
harness drops it. On Claude Code that is roughly thirty days, and not reliably ours to
extend — the sweep covers `~/.claude` wholesale, so any other `claude` process with a
lower `cleanupPeriodDays` deletes ours too. That loss is accepted.

#### What survives a purge, and why it is the right half

**The prose is perishable; the consequences are not.** Every fact an agent established is
already a durable event in this database, written because it is provenance rather than
because it is chat — `asset.recorded`, `asset.imported`, `scope.entry.added`,
`observation.recorded`, `attempt.settled`. A session whose transcript Claude Code deleted
on day thirty-one still renders what it _did_: the entries it wrote, the assets it
recorded, the observations it produced.

So the honest degradation is the inverse of the obvious fear. We lose the narration and
keep the record, which is the half that matters for an engagement.

#### The one thing that stays ours

**An index of where to look, which is not history.** To ask a harness for a session you
need its id _and which harness minted it_ — a session is only readable from the harness
that created it, and the two answer differently. `goal_sessions`
(`goal_id, target_id, harness_session_id, harness_instance_id, opened_at`) is already that
shape, and anything else wanting resumable sessions needs the same handful of columns.

That index is also what makes an honest tombstone possible. **Neither harness can tell you
a session expired** — Claude Code's `getSessionMessages` returns `[]` for an expired
session, a missing file, a permission error and a bad id alike; OpenCode raises a clean 404. So the harness can only say _"I do not hold this"_. We supply _"it existed"_ from our
own row, and the two together make "this session is gone" a statement rather than a guess.

#### The contract this implies

`AgentHarness.messages` answers `Retained | NotHeld`, with unreachable staying in the
error channel. Three outcomes, three screens: a conversation, a tombstone, a retry.
Collapsing _expired_ into _unreachable_ turns an expected outcome into something that
reads like a fault, and collapsing either into an empty list is how a reader concludes
nothing was ever said.

Claude Code needs a store-reachability check to hold up its end, since an unmounted config
directory is indistinguishable from an expired session through the SDK alone.

#### What this retracts

`run/transcript.ts` wrote a copy of each attempt's conversation to
`targets/<id>/evidence/` at settlement. That is retracted by this decision and the writer
is removed; `readTranscript` keeps only the harness read. `TranscriptSource` loses
`recorded` and becomes _harness_ or _absent_.

The evidence directory keeps `policy-audit.log`, which is a different kind of artefact: it
is **our** record of our own gate's decisions, which no harness holds and nothing else
would retain.

### Handoff — what it actually is

**Not a transcript replay.** Strategies, from `CommandPolicy.ensureContextHandoff`:
`full_thread_summary`, `delta_context`, `fork_delta_context` — delivered as **synthetic
user context**, capped by `maxRecommendedHandoffChars`, gated on
`canConsumeHandoffSummaries` **and** `acceptsSyntheticUserContext`.

Transition decision (`ProviderSessionTransitionPolicy.ts`): switching driver →
`create_with_handoff`; returning to a provider you used before → resume its existing
thread + a **delta** summary of off-provider runs.

Why verbatim replay is impossible: no API accepts foreign history; cost; and **thinking
blocks are bound to the producing model** — other models drop them.

### Our handoff: structured briefing **plus** a labelled run summary

T3 must summarize a _transcript_, because that's all it has. **We have a graph** — so our
handoff has a better source. But we carry both parts:

**Part 1 — hunt-state briefing (deterministic, no model call).** Rendered from structured
state: goals, open intents, confirmed findings, asset scope and perimeter, recent operator
directives. Higher fidelity than any summary, and free to produce.

**Part 2 — summary of the previous agent's run (model-generated, explicitly labelled).**
The graph records observations and conclusions with their evidence and limits; it does
not guarantee their truth or necessarily say what the previous agent was in the middle
of, what it had ruled out and why, or how the operator had been steering it. That context
is worth carrying.

**Labelling is mandatory.** The handoff must state plainly that this is a summary of a
_previous agent's_ run on a _different provider_ — not the reading agent's own memory.
Without that framing a model will confabulate having done the work itself, and will
over-trust conclusions it never reached. Something like:

```
[Context handoff — you are resuming a hunt that was previously run by a different
agent on a different provider. The following is a SUMMARY of that agent's run,
not your own memory. Treat its conclusions as reported, not observed. Authoritative
current state is in the hunt graph; query it with the tools available to you.]
```

Both parts are delivered as **synthetic user context**, per T3's mechanism, capped by the
target provider's `maxRecommendedHandoffChars`.

Scope: one function, needed only for the main agent. Workers are pinned, so no worker
ever reads a handoff.

---

## 9. UI / UX

Target: richer than a chat log. ScopeWeaver's UI renders only four part types —
`text`, `thinking`, `tool_result`, `error` (`web/src/lib/types.ts`) — which is why it
feels basic. That's a missing-renderers problem, not an architecture problem.

### OpenCode's event surface (pulled locally from `@opencode/client@2.0.29`, `dist/promise/generated/types.d.ts`)

`V2Event` is a union of **95 types**. Delta-level streaming on three separate channels:

```
session.text.started       → session.text.delta       → session.text.ended
session.reasoning.started  → session.reasoning.delta  → session.reasoning.ended
session.tool.input.started → session.tool.input.delta → session.tool.input.ended
session.tool.called → session.tool.progress → session.tool.success | session.tool.failed
session.step.started → session.step.streamed → session.step.ended | session.step.failed
```

Reasoning is its own channel — a collapsible thinking pane is a filter, not a parser.

**Notable primitives beyond rendering:**

| Events                                                        | Why it matters                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `session.inbox.enqueued/delivered/cancelled/delivery.changed` | **Built-in per-session message queue.** Directly useful for work distribution.                   |
| `form.created / form.replied / form.cancelled`                | The agent can request **structured input** from the UI. Strongest single find for enriched chat. |
| `session.revert.staged/cleared/committed`                     | Undo of agent actions.                                                                           |
| `session.usage.updated / recorded`                            | Per-session token/cost accounting.                                                               |
| `permission.asked / permission.replied`                       | Approval round-trip as first-class events.                                                       |
| `session.compaction.started/delta/ended/failed`               | Lets us _observe_ harness compaction without owning it.                                          |

Others: lifecycle (`execution.*`, `session.idle`, `session.status`, `retry.scheduled`),
session state (`created/deleted/forked/moved/renamed/metadata.updated/instructions.updated/
agent.selected/model.selected`), side channels (`shell.*`, `pty.*`, `skill.activated`,
`websearch.updated`, `mcp.status.changed`, `mcp.resources.changed`, `filesystem.changed`,
`vcs.branch.updated`, `worktree.*`), host UI (`tui.toast.show`, `tui.prompt.append`, …).

### Rich output — the mechanism

Tool results carry structured content, **not just text**:

```ts
type ToolTextContent = { type: "text"; text: string };
type ToolFileContent = {
  type: "file";
  uri: string;
  mime: string;
  name?: string | null;
};

type SessionMessageToolStateCompleted = {
  status: "completed";
  input: { [x: string]: JsonValue };
  content: [ToolContent, ...ToolContent[]];
  metadata?: { [x: string]: JsonValue }; // ← arbitrary structured payload
};
```

- Images: `mime: "image/png"` + `uri` → render inline.
- **`metadata` is the custom-renderer hook.** `report_finding` returns
  `metadata: { severity, cvss, request, response }` → draw a finding card, not a text blob.

**Richness is a function of tool output schema design, not of model formatting.**

### `COPY` — the render taxonomy

T3Code's `ExecutionNode.kind` is a battle-tested list of what an agent UI needs to draw:

```
root_turn | assistant_message | reasoning | plan | todo_list | tool_call |
approval_request | user_input_request | subagent | hook | system
```

The T3Code investigation called these "rendering units, not work units" as a _criticism_
of its work model. For UI purposes that's exactly the right taxonomy. Build a component
per kind.

### Worker lanes

With `agent_id` + `parent_tool_use_id` (CC) or session ids (OC), render N live worker
lanes side by side, each with its own tool-call feed, alongside the main-agent column.
ScopeWeaver cannot do this.

### `SPIKE` — the visual layer, and where OpenCode's look actually comes from

Established 2026-10-21 by reading the local OpenCode checkout. Nothing is committed; the
route is unresolved as `SPIKE-5`.

**OpenCode's v2 GUI is IBM Carbon reskinned, not a shadcn-style kit.** Evidence, all from
`../01-better-agents-codebases/resources/opencode`:

- `packages/ui/src/styles/tokens/theme.css` declares **363 semantic custom properties** whose
  families mirror Carbon's layer model: `--v2-background-bg-base`/`-deep`/`-layer-01`…`-layer-04`,
  `--v2-text-text-base`/`-muted`/`-faint`, `--v2-border-border-base`/`-muted`/`-strong`/`-focus`,
  plus `elevation-*`, `state-bg-*`, nine `avatar-*` pairs and per-agent accents
  (`agent-build-*`, `agent-explore-*`, `agent-plan-*`).
- `packages/app/package.json` pins `@ibm/plex@6.4.1` — the exact version `@carbon/styles@1.118.0`
  depends on — and `packages/app/src/index.css:21` `@font-face`s IBM Plex Mono as the code font.
  Sans is Inter; `JetBrainsMonoNerdFontMono` is bundled for TUI glyph parity.
- Control metrics are Carbon's, not Tailwind's: 24/28/32px heights at 4–6px radii
  (`packages/ui/src/actions/button/button.css`).

**The visual layer is framework-agnostic and ports verbatim.** Components are thin Kobalte
shells emitting `data-component`/`data-size`/`data-variant` — `button.tsx` is ~40 lines — and
every pixel is plain CSS in `@layer components` reading those tokens. OpenCode is MIT, so the
component CSS, the token files and `theme/themes/*.json` fall under `COPY`; only the Solid
`.tsx` shells need rewriting as Svelte.

**Most of the hard widgets are not Solid-specific either.** `shiki@4.4.3`, `@shikijs/stream`,
`marked@18`, `marked-shiki`, `@pierre/diffs@1.5.1`, `@pierre/trees`, `diff@8`, `fuzzysort@3.1`,
`remeda`, `dompurify`, `motion@12` and `@dnd-kit/dom` are framework-agnostic; the Solid packages
beside them are adapters. The rest have 1:1 Svelte equivalents: `@kobalte/core@0.13.13` →
`bits-ui@2.20.0`, `@tanstack/solid-virtual` → `@tanstack/svelte-virtual`, `@tanstack/solid-query`
→ `@tanstack/svelte-query`, `solid-sonner` → `svelte-sonner`, `@corvu/drawer` → `vaul-svelte`,
pane splitting → `paneforge`.

**Three candidate routes.**

| Route           | What it is                                                                                           | Cost and risk                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C** (leading) | shadcn-svelte on Tailwind v4, with `@carbon/themes`' g100 values written into its 32 oklch variables | shadcn's theming is 32 `:root`/`.dark` variables mapped through `@theme inline`, and its components use only semantic utilities, so re-pointing them propagates without markup edits. Collapsing 363 tokens to 32 is the accepted fidelity loss: elevation, overlays, agent accents and avatar pairs are deferred, each addable through the documented declare→map→use path. Density and radius are separate levers (`--spacing`, `--radius`), not colour variables. |
| **A**           | `@carbon/styles@1.118.0` (Apache-2.0) tokens + `bits-ui`                                             | Highest fidelity per unit of effort, no Svelte-version risk. Unknown: Carbon ships SCSS, so whether the build needs sass or `@carbon/themes` can be consumed as CSS custom properties directly.                                                                                                                                                                                                                                                                      |
| **B**           | `carbon-components-svelte@0.113.1`                                                                   | Largest ready-made set in the right aesthetic (DataTable, TreeView, Tabs, Modal), but community-maintained, pre-1.0, shipping Carbon **v10** styles against `@carbon/styles`' v11, and its published `package.json` declares **no `svelte` peer range** — Svelte 5.57 compatibility unverified, Svelte-4 idiom inside a runes codebase.                                                                                                                              |

**What no route solves.** The session timeline, dock prompt, diff view and pane shell are
app-level composition, not catalogue components: `packages/ui` is 35.9k lines of TS/TSX plus
9.9k of CSS, `packages/session-ui` 22.4k/4.6k, `packages/app` 120.6k/5.5k. The toolkit choice
decides the first afternoon; the component-per-`ExecutionNode.kind` work above is unaffected
by it.

---

## 10. `SKIP` — deliberately not carried over

| Thing                                       | Source                                                       | Why                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/` + norma framework                  | ScopeWeaver, 7,573 LOC + 49 import sites                     | The whole point of delegating. Worst line-per-value trade available.                                                                                                  |
| `selfupdate/`                               | ScopeWeaver, 968 LOC                                         | Built around replacing a static binary. Irrelevant.                                                                                                                   |
| `locale/` as a parallel subsystem           | ScopeWeaver, 2,874 LOC, 1,953 `Register()`, 1,279 call sites | One shared catalog consumed by both ends, if i18n is wanted at all.                                                                                                   |
| `db/asset_dsl.go` transliteration           | ScopeWeaver, 638 LOC hand-written tokeniser → AST → SQL      | Rebuild on a parser combinator with `effect/schema`-validated field maps. ~40% the code.                                                                              |
| Mock mode (`lib/mock/*`)                    | ScopeWeaver                                                  | Demo scaffolding.                                                                                                                                                     |
| DTO hand-mapping (`server/dto.go`, 667 LOC) | ScopeWeaver                                                  | One `effect/schema` definition serves API, DB row, and frontend type.                                                                                                 |
| Fail-open allowlist / judge-off-by-default  | ScopeWeaver                                                  | Inverted: fail closed.                                                                                                                                                |
| T3Code's restart behaviour                  | T3Code                                                       | It _terminalizes_ every in-flight run on startup and "resumes" by injecting `"Continue where you left off."` Our intent queue is strictly better for unattended work. |
| T3Code's unbounded concurrency              | T3Code                                                       | No global/per-project/per-user agent cap; only OS cgroups. We cap explicitly.                                                                                         |
| T3Code's `full-access` **as implemented**   | T3Code                                                       | We keep `bypassPermissions` (§5) but, unlike T3, we **do** install interception. T3 installs none, which is the part we reject — not the mode.                        |
| ScopeSentry integration                     | ScopeSentry                                                  | Discovery is not our bottleneck; for named-scope programs it only manufactures out-of-scope targets. Revisit for wildcard programs.                                   |
| Porting the Go backend wholesale            | —                                                            | 72–105 person-weeks, zero user-visible gain, discards 738 test functions.                                                                                             |

---

## 11. `DEFER` — good ideas, not now

| Thing                                                 | Trigger to revisit                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Custom context management / UniiChat summary tree** | Only if one of: (a) the main-agent thread visibly forgets decisions; (b) compaction-induced cache invalidation causes measurable stalls; (c) something needed wasn't in the graph. Until then **let CC/OC compact** — context is working memory, the DB is the record. Keep storage append-only so the option survives. |
| Cross-target roll-up queries                          | When per-target isolation actually blocks a question we want to ask.                                                                                                                                                                                                                                                    |
| ScopeSentry asset sync                                | A wildcard-scope program.                                                                                                                                                                                                                                                                                               |
| OpenCode + CC both wired                              | After `SPIKE-1` resolves and one runtime works end to end.                                                                                                                                                                                                                                                              |
| Deadline-driven worker settlement / wrap-up           | Explicitly parked by the operator on 2026-10-17; do not introduce deadline-triggered settlement as a requirement. Revisit only after discussing why it is needed. Incremental observation persistence and explicit stop/recovery remain separate.                                                                       |

**On deferred compaction — the reasoning:** persistence and context management are
separable. Log every message append-only (cheap, no model calls); let the harness manage
its own working window (free, already built). That gives report reconstruction without
building a summary tree. If we ever do build one, build it as **retained overlays with a
zoom path** (ScopeWeaver's `covers` edges), not destructive replacement.

---

## 12. `SPIKE` — open, blocking items

| ID              | Question                                                                                                                                     | How to settle it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Blocks                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| ~~**SPIKE-1**~~ | ~~Does an embedded OpenCode host use the user's stored credentials?~~                                                                        | **RESOLVED by reading T3Code.** It does not embed the SDK — it **spawns a local `opencode serve`** (`OpenCodeServerOwner`) with `inheritedEnvironment = process.env`, so the server runs as the user and reads the user's own credentials. `OPENCODE_SERVER_PASSWORD` is only Basic auth for our→server HTTP, not provider auth. **Correction 2026-10-19:** in OpenCode 2 the variable is `OPENCODE_PASSWORD`, which takes precedence over the 1.x `OPENCODE_SERVER_PASSWORD`; drop the inherited 1.x variable so exactly one password is live. Confirmed live against v2.0.32. **Decision: use the client/server model, not the embedded SDK** — proven path, plus process isolation. Wrinkle: `@opencode/client` carries a `solid-js` peer dep (warning only). | —                         |
| **SPIKE-2**     | Does z.ai honour prefix caching the way long-run economics assume?                                                                           | Measure cache-read tokens across repeated turns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Cost model only.          |
| **SPIKE-3**     | Does Caido's EULA permit personal automated use of the free tier?                                                                            | Read their terms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Traffic layer.            |
| **SPIKE-4**     | What exactly does OpenCode's `session.hook("context")` allow rewriting, and can host compaction be disabled?                                 | Read the hook's types in the pulled package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Only if DEFER-1 triggers. |
| **SPIKE-5**     | Which visual-layer route does `apps/web` take — shadcn-svelte on Carbon values, `@carbon/styles` + `bits-ui`, or `carbon-components-svelte`? | Build the same dense panel three times in `apps/web` and compare. Settles `@tailwindcss/vite` against Vite 8.3.4, the SCSS cost of `@carbon/styles`, and whether `carbon-components-svelte@0.113.1` runs on Svelte 5.57. See §9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Any UI work.              |

---

## 13. Build order

Front-loads learning; each step leaves something working.

1. **`SPIKE` — delegation-and-memory seam against a local fixture.** An Effect v4 MCP
   server exposing `record_asset`, `add_intent`, `record_observation`, `report_finding`,
   with a deny-by-default scope gate in `execute.before` / `PreToolUse`. Use one real
   OpenCode worker first. Acceptance criteria (accepted 2026-10-17):
   - The session successfully invokes the Effect-backed MCP tools.
   - A server-side OpenCode plugin demonstrably denies a prohibited action before
     execution; client/server connectivity alone does not prove hook integration.
   - Missing policy or enforcement connectivity fails closed.
   - The worker records a bounded ordinary observation, including a negative result.
   - A fresh planner/session uses the resulting briefing to choose a next investigation
     without the original conversation. Preserve tested claims and untested dimensions.
   - Identify and record exactly which execution/traffic paths the boundary covers;
     tool-input inspection alone does not prove control of arbitrary downstream traffic.
     Reason: prove delegation, enforcement behavior, and useful graph memory, not just
     three successful MCP calls. SPIKE-1's architectural decision is already resolved;
     this verifies the real integration. Do not treat the earlier ~500-line estimate as
     an acceptance criterion or a verified implementation size.
     **Outcome 2026-10-19: all six criteria exercised against a real subscription-
     authenticated OpenCode v2.0.32 worker; see §19 for what passed, what the enforcement
     boundary actually covers, and what was not attempted.** One worker only; §19's
     "Not attempted" list is part of the result.
2. **State layer.** `control.sqlite` + per-target `hunt.sqlite`. Append-only messages,
   stable IDs, monotonic sequence. Migration runner that iterates targets. **`PORT` +
   `FIX`:** transactional outbox and command receipts, statically imported migrations,
   immutable event semantics, scoped observation contracts, and attempt identities /
   stale-attempt rejection land here. Verify deliberately interrupted execution with an
   ambiguous external outcome and safe recovery, not only a clean restart. Table count
   follows these contracts; the earlier ~6-table estimate is not a constraint.
3. **Caido ingestion.** GraphQL client; pull flows; link to findings; content-hash blobs
   into `targets/<id>/evidence/`. _From here the project is useful for real hunting._
4. **The engine.** Planner + N worker fibers, intent claiming, `Fiber.interruptAs` with
   cause annotations, `FiberMap` supervision, `Semaphore` locks, `PubSub` activity stream,
   steering via tool-call denial. **This is the Effect masterclass.**
5. **Svelte UI.** SSE from ordered durable-event reads, awakened by PubSub, with a
   sequence cursor; component per render kind;
   worker lanes; tool-metadata-driven cards.
6. **Main-agent provider switching.** AppThread/ProviderThread split; "render hunt state
   as briefing" handoff. Enable cross-harness usage-limit fallback when the secondary
   adapter is wired; same-harness model fallback can land earlier with attempt recovery.

**`DEFER` — concurrency until the single-worker loop is useful.** Keep one worker through
the delegation/memory and recovery proofs; then add N-worker scheduling. Reason: first
prove useful knowledge accumulation and honest recovery, then parallelize that behavior.

**Known accepted risk:** a from-scratch build won't inherit ScopeWeaver's subtle
correctness — lock orderings, timeout settlement, evidence atomicity. We hit those
ourselves. Acceptable while this isn't load-bearing during an engagement we care about.

---

## 14. Operating note — tool vs. engagement fit

Separate from the build: **an autonomous scanner is the wrong instrument for a
named-scope bounty program with a "no automated scanning without PoC" clause.** For those,
drive testing by hand through Caido with Claude Code, and use this platform as the state,
evidence, and reporting workbench.

Autonomy earns its keep on wildcard-scope programs and own-infrastructure work. Build for
that; don't point it at a three-asset program and expect it to be appropriate.

---

## 15. Domain contracts and lifecycle review

### `PORT` + `FIX` — domain meaning precedes schema and tool design

Accepted 2026-10-17. A domain contract specifies what a concept means, the invariants
on its transitions, and what consumers may infer. Field validation alone is insufficient.

| Contract         | Required meaning                                                                                                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent           | Question/objective, bound assets and supporting observations, assigned slice, constraints/budget, expected worker output. Finishing a slice does not settle the broader question.                                                                               |
| Observation      | Explicit tested claim, conditions/bounds, positive/negative/inconclusive outcome, observed behavior, evidence, interpretation, limitations. Negative is never an unbounded absence claim.                                                                       |
| Attempt          | One execution with identity and binding; termination distinguishes completion, interruption, technical failure, quota/capacity interruption, budget exhaustion, and uncertain outcome. Successful execution is not a positive security result.                  |
| Finding          | Connect observed behavior to a violated security property and demonstrated impact, with supporting/conflicting evidence and limitations. Positive observations do not automatically confirm vulnerabilities. Evidence availability is separate from validation. |
| Planner progress | Bounded new work, waiting for capacity/evidence, no useful next action, or objective met with rationale. Follow-ups identify uncertainty; repetition states changed conditions, new evidence, or reproducibility purpose.                                       |
| Recovery         | Distinguish known not executed, known completed, and unknown external outcomes. Replacement attempts receive explicit uncertainty, not an assumption that missing results mean nothing happened.                                                                |

Reason: these meanings are the control plane's domain responsibility; harness execution
and orchestration plumbing cannot supply them. Exact finding-confirmation criteria,
state names, and final tool shapes remain to be settled through the lifecycle exercise.

### `PORT` + `FIX` — focus the next source review on ScopeWeaver's domain paths

ScopeWeaver remains a read-only idea reference, not code to copy. T3 remains the reference
for transport/lifecycle/recovery plumbing. Next inspect the intent → attempt → observation
→ finding lifecycle against a concrete rate-limit investigation; no new open-ended T3 sweep.

Verified source observations:

- `scopeweaver/agent/tools.go:1026-1084`: intents carry summary, asset IDs, parent IDs,
  and priority; creation checks parent existence/kind and bound-asset interception.
  Despite comments/tool prose saying “confirmed”, the parent loop at `:1044-1052`
  does not check parent state. Our intended confirmed-anchor rule requires explicit
  enforcement; it is not established by those comments.
- `scopeweaver/agent/tools.go:1306-1354`: facts are separate graph nodes linked with
  `yields`; they carry summary/detail/evidence/confidence and optional intent binding.
  The handler checks nonempty summary, conditionally includes evidence/confidence, and
  inserts the fact in `confirmed` state. It does not require our structured outcome,
  tested claim, conditions, or attempt provenance.
- `scopeweaver/agent/tools.go:1359-1374`: tool guidance already asks for honest negative
  conclusions and observed versus inferred labels, but also encourages one fact per
  intent. Preserve its caution; do not collapse differently bounded conclusions just
  to achieve one fact per intent.
- `scopeweaver/agent/tools.go:1225-1233,1289-1298`: findings have evidence and optional
  traffic references with baseline/proof/verification/supporting roles; the result can
  explicitly say evidence is not bound. Preserve that distinction and add our durable
  evidence-capture lifecycle. Tool wording alone does not prove vulnerability validation.

### `PORT` + `FIX` — lifecycle semantics, illustrated by authentication rate limits

Accepted 2026-10-17. Use `goal` for the broad objective and `intent` for an actionable
investigation direction. Do not introduce a separate slice entity without a demonstrated
need. Exact schemas/tool signatures remain implementation work. The following is a
hypothetical design example, not an implemented/tested security result:

1. Broad objective: determine whether authentication rate limits can be bypassed and
   with what impact. Worker assignment: test the specific per-IP limiter under recorded
   account/address conditions. Preserve the broad objective and narrow assignment as
   distinct meanings, represented by the goal and its actionable intent respectively.
2. Attempt A executes that slice on its pinned binding and records observations as it
   goes. Quota interruption ends/pauses execution according to the adapter; it does not
   negate observations or settle the objective. A fallback gets a new attempt identity.
3. Observation O1: rotation among IPv6 /128s within one /64 supports evasion of the
   observed 10-requests-per-IP threshold. Record actual account, request counts, time
   window, baseline, response behavior, and evidence. Account-wide daily controls remain
   untested; do not describe O1 as unlimited authentication attempts.
4. Planner derives follow-up work from O1 to investigate the independent account limit.
   O2 may establish that the account is blocked at 100 requests/day under the tested
   conditions. O2 qualifies the broad bypass claim without erasing O1. Actual day/window
   semantics must be supported by observations/configuration, not inferred from one burst.
5. A proposed finding cites O1 and O2, identifies the precise protection bypassed and
   demonstrated impact, and retains the effective account-level limit. If impact or
   the expected security property remains unestablished, keep it as a bounded observation
   or validation lead rather than automatically creating a confirmed finding.
6. Capture evidence independently. “Captured” proves byte availability/integrity, not
   vulnerability validity. Subsequent evidence may qualify or dismiss a conclusion;
   retain the original observations and the reason for the revision.

Reason: validate branching, partial coverage, contradictory/qualifying evidence, quota
fallback, and reportability before freezing tool schemas. The lifecycle is a graph:
one intent can have several attempts; attempts yield many observations; observations
can seed more intents or jointly support findings. It is not a mandatory linear funnel
where every completed intent produces a vulnerability.

**Three independent answers:** attempt status says whether execution finished;
observation outcome says what the bounded test established; finding validation says
whether the supported behavior constitutes a vulnerability. Never derive one answer
solely from another. Observations are saved incrementally, so quota fallback preserves
committed knowledge and resumes the remaining question rather than repeating everything.
Response differences alone do not prove authentication was processed; evidence must
support the stated interpretation. Missing HTTP capture does not invalidate other
verifiable evidence, while stored bytes alone do not establish a valid vulnerability.

---

## 16. Report freshness and evidence dependencies — dedicated design topic

### `PORT` + `FIX` — reports identify the evidence and conclusions they used

Accepted 2026-10-17; simplified design accepted in the subsequent discussion below.
A report is a derived artifact, not independent truth. Preserve the finding revision
used to produce it and explicit observation/evidence references. Relevant knowledge
changes are assessed by the existing planner, which updates the finding when warranted;
the report then becomes stale. New observations do not automatically invalidate reports.

ScopeWeaver reference: `db/finding_traffic.go:239-246,469` tracks evidence and report-
evidence versions; `agent/finding_workflow.go:77` instructs the reporter to use the version
it actually read. Our equivalent should account for changed conclusions and newly added
qualifying/contradictory observations as well as changed traffic bindings.

Example: a report drafted from IPv6 per-IP evasion predates evidence of an effective
account-wide cap. Preserve the old report and its inputs; flag it for review/regeneration
against the new knowledge rather than silently presenting it as current.

Reason: retained provenance must extend from observations through findings to generated
reports. Report generation reads existing evidence; it must not silently rerun tests to
fill gaps. Historical report revisions remain attributable to their input versions.

### `PORT` + `FIX` — minimal implementation: versioned finding, cached report

Accepted: implement the small version for this single-operator application, not a general
truth-maintenance or taint-propagation engine. This resolves the earlier design spike.

Conceptual finding fields: `id`, `revision`, `claim`, `impact`, `limitations`,
`observation_ids`, `evidence_ids`. A report carries `finding_id`, `source_revision`,
and `content`. Existing historical report revisions remain attributable to their inputs.

- Increment the finding revision whenever report-relevant content changes: claim,
  impact, limitations, or supporting observation/evidence references.
- A report is current iff `report.source_revision == finding.revision`; otherwise it
  is stale. Use the whole finding/report as the invalidation unit, not individual claims.
- Finding updates supply the revision they read. Reject conflicting updates so the
  caller rereads current state rather than overwriting newly recorded qualifications.
- Report generation captures one consistent input bundle: the finding revision and
  its referenced observations/evidence. Generate from that fixed bundle, not changing
  inputs fetched throughout generation. Save the source revision; if the finding changed
  meanwhile, retain the generated report as stale rather than presenting it as current.
- Regenerate on request or at an explicit reporting point, not after every mutation.
  A visible stale indicator is sufficient initially. Report writing uses existing
  evidence and does not silently rerun tests.

**Stage A is code, semantic assessment belongs to the existing planner.** Select candidate
findings through explicit finding references, shared intent, or overlapping bound assets.
These are retrieval hints, not proof of relevance or automatic invalidation. Include new
observations and candidate findings in the next normal planner round. The planner updates
only findings whose conclusions/support actually change; no separate weaker assessment
subagent or assessment queue is required.

Example: new observation O2 shares an asset with F1 and F2. The planner determines it
qualifies F1, updates F1's limitations/support, and leaves F2 alone. F1's revision changes,
making its report stale. Regenerate later when needed.

**Explicit limitation:** current means “matches the current recorded finding”, not
“incorporates every potentially relevant discovery”. New evidence affects freshness only
after its relevance is recognized and the finding updated. Before submission, the existing
main agent can review the finding against relevant recent observations as part of reporting.

Reason: retain useful provenance, concurrency correctness, and honest freshness without
adding services, model calls, or generalized dependency machinery for a personal tool.

### `DEFER` — generalized dependency propagation

The operator identified a resemblance to value tainting. The useful analogy is propagation
of changed/invalidated assumptions through dependent conclusions and reports. Distinguish:

- **Freshness:** whether the artifact incorporates the relevant current input revisions.
- **Validity:** whether its substantive conclusion remains supported.
- **Evidence availability:** whether referenced bytes can still be retrieved.

A stale report is not automatically false, and a freshly regenerated report is not
automatically correct. Do not conflate this with security taint analysis of untrusted
inputs. Defer dedicated weaker assessment agents, automatic invalidation queues, recursive
dependency propagation, claim/sentence-level versioning, numerical confidence propagation,
and automatic report regeneration. Revisit only if the minimal workflow demonstrably
misses important updates or whole-report regeneration becomes an actual bottleneck.
Finding confirmation remains an explicit domain assessment, not a consequence of a stale
flag or merely receiving a contradictory observation.

### `SPIKE` — dedicated retest workflow not yet accepted

Retesting was proposed, but the operator requested justification on 2026-10-17.
Do not treat a separate retest subsystem or UI as required. Existing intents/attempts
and timestamped observations may suffice for rechecking a claim. Explain the distinction
between initial validation, recovery after interruption, and verification after a reported
fix before deciding whether any dedicated workflow is worth building.

Recommended minimal representation: existing finding → verification intent → attempt →
new observations → qualified disposition update. Missing authentication or changed test
conditions must not turn a failed reproduction into a claim of remediation. Preserve
historical evidence. No dedicated agent, queue, or UI is required by this recommendation.

## 17. Remaining focused domain recommendations — pending agreement

These preserve the final review suggestions, not additional accepted build requirements.

### `SPIKE` — deterministic briefing selection

Define how fresh planners receive goals/constraints, open and running intents, relevant
bounded observations (including contradictions), blockers, and known gaps. Include IDs
for omitted detail and explicitly disclose truncation. Record the graph sequence used to
prepare a briefing and validate proposed mutations against current state. This is
deterministic retrieval/rendering, not the deferred model-generated digest subsystem.
Reason: absent briefing content must not imply absent graph knowledge. ScopeWeaver
reference: `agent/planner.go:340-356`. Resolve during the delegation-and-memory experiment.

**Partially resolved 2026-10-19 (§19).** Deterministic rendering from stored rows at a
recorded sequence, with omitted observation IDs disclosed explicitly, is implemented and
proven for one intent with two observations. Truncation drops oldest-first so qualifying
evidence survives. Still open: contradiction presentation, blockers, running-intent state,
multi-intent briefings, and validating proposed mutations against current state.

### `SPIKE` — concrete asset identity rules

Before persistent `record_asset`, define identity/normalization/provenance for the few
asset types the first experiment uses. ScopeWeaver has type-specific uniqueness for IPs,
service URLs, endpoint URL + HTTP method, and domains/record types
(`db/schema.sql:83-91`). Borrow the principle, not the entire asset catalog. Avoid both
duplicate representations of one host and over-normalization that merges behaviorally
different endpoints. This makes the already accepted domain-deduplication contract concrete.

### `SPIKE` — coverage semantics, not a misleading completeness percentage

An asset with an attached observation is not necessarily sufficiently tested. ScopeWeaver
labels its asset coverage approximate and warns against treating it as completion
(`agent/tools.go:527-553`, especially `:538`). Initially prefer tested claims, actual
conditions, and known gaps over a percentage. Define the denominator (assets, claims,
roles, methods, time windows, etc.) before adopting any coverage metric. Reason: a narrow
positive or negative result must not imply broad coverage, as the rate-limit example shows.

### `FIX` — untested dimensions are rows, and a planner may dispose of one

**Accepted 2026-10-21**, unlike the three recommendations above, which remain pending.
It sits in this section because it closes the open half of the briefing-selection
`SPIKE` — what a fresh planner is shown, and what it is spared — and because Sprint 07,
the first planner loop, cannot be built on the current shape. None of it is a `PORT`:
ScopeWeaver has no untested-dimension concept. Its "untested" is asset-level
(`list_untested_assets`, `agent/tools_insert.go:490`) with exactly the approximate
coverage percentage the entry above warns against.

#### Dimensions become rows

§22 recorded the limit this removes. A dimension address is positional, which is "only
sound while observations are immutable", and "anything that ever edits, merges or rewords
a recorded dimension needs its own identity scheme rather than this one stretched to
fit."

`observation_dimensions(id, observation_id, position, text, created_at)`, backfilled by
unnesting each observation's stored `untested_dimensions` array in position order, so
every existing dimension keeps the identity its address already implied.
`observation_dimension_links` repoints from `(address, dimension_index)` onto
`dimension_id`; it already stores `source_observation_id` and `dimension_index` as real
columns, so the repoint is a join rather than a parse. SQLite cannot change a foreign key
in place, so this is a table rebuild in the manner of `0006`.

`<observationId>#u<index>` survives as the **wire alias**: it is what a briefing prints
and what a worker copies, resolved to a `dimension_id` on the way in.
`parseDimensionAddress` keeps refusing a non-canonical index, no worker-facing payload
changes, and the identity behind the alias stops depending on position.

#### Rendered once, in the tail — implemented 2026-10-21

The rest of this entry is a plan; this part is built, because it is the precondition for
any of it. `renderBriefing` printed every dimension twice: inside its observation's block
and again, with status and addressers, in the volatile section below
`PREPARATION_HEADING`.

That duplication was harmless only while a dimension's visibility was fixed. A
disposition changes it, which left no good option: filter the block too and a briefing
rewrites observation text that earlier rounds already emitted, destroying the byte-for-byte
prefix §22 built the planner lineage for; leave the block alone and a retired dimension is
still in the brief, so retiring it shrinks nothing and the tool is decorative.

So an observation's block now ends at `limitations` and names no dimension. The division
is not merely mechanical: `limitations` qualifies what that observation established, so it
is evidence and immutable with it, while an untested dimension is forward work whose state
changes as it is addressed or retired. Evidence above the heading, derived state below it.
`briefing.test.ts` asserts the stable prefix contains neither address, and that both are
still in the rendered text — a test that fails if a well-meaning edit puts them back.

Grouping in the tail stays by status (uninvestigated, addressed-inconclusive,
addressed-with-evidence, and in due course the retired count), not by raising observation:
status is what a planner acts on and what visibly shrinks as questions are settled. A
by-observation view belongs in the UI, where a reader browsing one observation wants its
own caveats together.

#### A planner's judgement is not a test result

The tool does not mark a dimension `tested`. §4 and §15 reserve that vocabulary for what
a bounded test established against an explicit `tested_claim`; it is the same rule that
makes a timeout not a negative result. A planner disposing of a dimension has executed
nothing — it has decided the question is no longer worth asking. Spelling that `tested`
would reintroduce precisely the conflation the observation contract exists to prevent,
and no later reader could tell a dimension somebody measured from one somebody dropped.

Two dispositions, both of which remove a dimension from the planner's open questions:

- `subsumed` — other recorded observations already cover it. **Must cite them.**
- `withdrawn` — not worth testing: out of scope, impractical, or overtaken by the goal.
  **Must give a reason.**

#### Bounded closure authority, attributed and reversible

This changes §22's position that nothing closes a question and no closure authority
exists, and the change is deliberate: a question nothing can retire accumulates for
ever, and a brief that only grows eventually buries what matters. What does not change is
that closure is a judgement rather than a derivation — so it is attributed, evidenced and
reversible.

The authority goes to the planner, whose own workload shrinks every time it exercises it.
That incentive is the reason for each constraint below rather than a hypothetical:

- `dimension_dispositions(id, dimension_id, disposition, reason, planner_session_id,
round, created_at)`, with `dimension_disposition_basis(disposition_id,
observation_id)` for the cited evidence.
- Validated inside the write transaction, as `resolveAddress` already validates an
  address: the dimension exists; a `subsumed` basis is non-empty and every cited
  observation exists and belongs to the same goal; a `withdrawn` reason is a non-empty
  string; a duplicate citation in one call is refused rather than collapsed.
- At most one live disposition per dimension.
- Author and round are recorded, so a round that retired nine questions is visible as one
  round having retired nine questions.
- Dispositions per planner round are capped under the same budget §4 already requires for
  intent expansion.
- **Nothing is deleted.** A dispositioned dimension leaves the brief, not the record: it
  still renders on request and in reports, and a later observation or a human can reopen
  it. A wrong disposition is recoverable rather than invisible.

#### One derivation, not a stored flag

A dimension's briefing state is computed over the links, the dispositions and intent
provenance:

| State                                             | Means                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `uninvestigated`                                  | no addressing observation, no live disposition, no intent naming it |
| `scheduled`                                       | an intent names it; no addressing observation has landed yet        |
| `addressedInconclusive` / `addressedWithEvidence` | as §22 defines them, from the addressers' own outcomes              |
| `subsumed` / `withdrawn`                          | a live disposition; excluded from the planner's open questions      |

`intents` gains a nullable `addresses_dimension`, stated by the planner as it creates the
intent. It buys three things. `scheduled` becomes derivable, so a later round can tell
"nobody has looked at this" from "work is out for this". Duplicate-intent detection
becomes a join rather than the prose matching §4 warns against. And the same-intent
constraint in `resolveAddress` can relax to _same goal, when the caller's own intent
declares that dimension_ — so a planner may answer a dimension with a **new intent**,
which today is a path no worker can close. Authority is still checked; it is checked
against recorded lineage instead of an assumption.

`scheduled` must not become §22's forever-`uncertain`. Once every attempt on the
declaring intent has settled with no addressing observation, the dimension falls back to
`uninvestigated`, carrying the history that somebody tried. A state that can be entered
and never left is a lie with a long half-life.

The count of dispositioned dimensions is disclosed in the brief the way truncated
observations already are. A shorter brief must not be able to masquerade as a smaller
graph.

#### Migration plan

Append-only, in order, each independently reviewable:

- `0008_observation_dimensions` — the table, the backfill, the links rebuild.
- `0009_intent_dimension_provenance` — `intents.addresses_dimension`.
- dispositions and their cited basis take **the next free id**, not a reserved one.

Revised 2026-10-21, after §23 implemented the first two. The original plan reserved
`0009` for dispositions and gave provenance `0010`. Reserving an id for work that waits
for a later sprint does not work: the migrator reads the highest id _this database's_
journal holds and skips every id at or below it, while the loader sorts by id, so a
migration dropped into a reserved gap later applies to a fresh database and never to one
already past it. The two diverge, and each journal reports itself as current. Ids are
therefore assigned when a migration is written, never in advance.

Reason: a planner needs a brief that narrows as questions are settled, and the record
needs to say who settled each one and on what basis. Keeping those apart — a view that
narrows, a record that only grows — is what stops a bounded test result and a planner's
judgement from being spelled the same way.

Still open, and not decided here: **when** a planner should answer a dimension with a new
intent rather than another attempt on the raising one — this entry makes the first
possible, not preferred — and whether anything below an observation, a case or an action
or one concrete payload, needs its own identity so that a finding or a steer can cite it.

---

## 18. ScopeWeaver subsystems not yet represented

Found on a coverage sweep of ScopeWeaver packages against this document. Ranked by how
much an **unattended** tool needs them. Distinct from §16's evidence-dependency topic.

### `PORT` — notification subsystem

Accepted 2026-10-18: **Discord is the first and initially only notification delivery
adapter**, using the existing transactional outbox. Discord serves as the secondary UI
for notification-related activity; the main application UI remains accessible in the
browser. Route messages to configured dedicated channels within one Discord server.
Exact grouping by target, event category, or both remains to be specified; this does not
mean creating a new channel per individual message.

Start with significant findings, work blocked on operator input, and exhausted provider
capacity. Include stable event/finding identifiers and links to the browser UI where
useful. Keep delivery status and failures visible in the application. Implement delivery
and routing rather than ScopeWeaver's full multi-channel management subsystem. Verify the
current Discord API before choosing webhook versus bot transport and implementing
rate-limit handling; this decision does not require inbound Discord commands or a bot UI.

Reason: unattended hunts need actionable notifications; one preferred transport and the
existing outbox provide this without a separate delivery framework.

ScopeWeaver `notify/` (2,408 LOC): six channels — `KindDingTalk`, `KindEmail`,
`KindFeishu`, `KindTelegram`, `KindWebhook`, `KindWeCom` — plus `mask.go`, `filter.go`,
per-format rendering (`markdown.go`, `html.go`), and SSRF guards on **both** HTTP dial
(`http.go`) and SMTP dial (`email.go`). It took a 12-item security-fix commit (mask
bypass, SSRF, silent loss), so the hardening is earned, not theoretical.

#### `PORT` — lease-based delivery claiming

`db/notification_delivery.go:13-20` contains the mechanism our outbox dispatcher needs:

> "Claims use **leases** rather than long transactions: set `sending` and move
> `next_attempt_at` into the future as the lease expiry, **then commit before network
> delivery**. This avoids holding database locks across requests that may take seconds
> (15-second client timeout) and delay unrelated writes.
>
> A process crash during delivery leaves `sending` rows, but **recovery is automatic**:
> after lease expiry, `next_attempt_at` is in the past and the next claim picks up the
> row again."

Crash recovery as a consequence of lease expiry, with no separate reaper. Pairs with
§6's outbox semantics and the startup recovery service — this is the concrete claiming
mechanism to implement, and it matters more under SQLite's single-writer constraint,
where holding a write lock across a 15-second HTTP call would stall every other writer.

Accepted qualification: lease expiry makes a delivery retryable; it does not prove the
previous send failed. Preserve at-least-once semantics and stable delivery identities;
duplicate Discord notifications remain possible after an ambiguous send. Size/renew the
lease consistently with bounded delivery duration so a live sender is not concurrently
reclaimed. Source reference: `db/notification_delivery.go:121-122`. Reimplement the idea;
do not copy ScopeWeaver code.

### `PORT` — scheduler and triggers

`server/scheduler.go`. The automation layer for the continuous-coverage scenario §14
names as our actual fit. Absent from this document.

> "Scheduler drives P3 triggers: on each tick it fires due **interval** triggers and
> scans for new findings / newly-met goals (any task) to fire **event** triggers. Each
> fire enqueues a NEW conversation on the agent's per-agent trigger queue: fires for the
> same agent run one at a time in FIFO order, distinct agents still run concurrently.
> State is persisted (per-trigger `last_fire` + finding watermark + fired-goal set) so a
> **restart resumes without double-firing**."

Plus watermark seeding on first run "so pre-existing findings/goals don't all fire at
once" (`scheduler.go:60-62`).

Two trigger classes to carry over: **interval** (cadence) and **event** (new finding,
goal met). Event triggers are what give unattended reactive behaviour — "new Critical →
run the triage agent." The persisted watermark + fired-goal set is the idempotency that
survives restart, and it composes with §6's startup recovery.

### `PORT` + `FIX` — side questions without perturbing execution

Accepted 2026-10-18. Answer factual status questions (current asset/objective, running
attempts, blockers) deterministically from control-plane state. For interpretive questions,
use a separate harness session with a captured briefing and tools disabled. Do not inject
the question into the running worker or main-agent conversation as a steering message.
Make the snapshot time/revision visible so a historical answer is not mistaken for live state.

ScopeWeaver's interaction pattern is useful, but its implementation invokes a raw model
provider (`sidequestion/service.go:27,55`), which we do not carry over. All model work
still goes through the selected harness and its subscription credentials. Its one-run
16.97-second validation is not a performance guarantee for our architecture.

Reason: distinguish observation from intervention. Start with state queries; add isolated
interpretive sessions when needed, without a dedicated side-question execution framework.

### `PORT` + `FIX` — deterministic asset enrichment with explicit policy

Accepted 2026-10-18. Implement small non-AI DNS-resolution and HTTP-metadata jobs,
using the same policy service and applicable execution/request budgets as other testing.
These jobs execute outside the harness, so harness pre-tool hooks cannot gate them;
enforce policy in their own execution path. HTTP probes route through Caido for capture;
do not silently fall back to direct traffic when the required proxy is unavailable.

DNS resolution is network activity, not strictly passive. Permit bounded resolution of
candidates for classification without automatically making resolved addresses testable.
A hostname resolving into an allowed CIDR is a relationship, not blanket authorization
for every hostname/service sharing that address. Keep domain and IP perimeter semantics
explicit and recheck relevant policy when executing active probes.

Source correction: `enrich/enrich.go:1-6` claims HTTP is gated, but `:225-235` constructs
and sends the request without a scope check in that path. Its client permits direct
traffic when the proxy is absent (`:101-107`). Port the enrichment concept, not those
assumptions. Node's built-in `dns.Resolver` covers the resolution path (§7).

Reason: cheaply turn discovered assets into useful structured knowledge while preserving
the same scope boundary for deterministic jobs and delegated tools.

### `PORT` + `SKIP` — external MCP tools through harness-owned clients

Accepted 2026-10-18. Configure third-party MCP servers in the selected harness; our
adapter injects/selects the appropriate configuration. **Do not build or port an MCP
client into the control plane.** ScopeWeaver's `mcphttp/` client is therefore skipped.
Our own domain MCP server remains application-owned (§6).

External MCP invocations pass through the session's pre-execution policy and role/tool
restrictions. Verify coverage on the deployed harness. Invocation authorization alone
does not constrain every downstream action of a remote MCP server: distinguish read-only
lookup services from tools that perform active testing, and require an explicit execution
scope contract for the latter rather than assuming the hook controls their traffic.

Reason: reuse harness protocol/authentication/lifecycle support while retaining our
policy at tool admission; avoid a second client implementation and falsely broad guarantees.

### `PORT` — shared workspace / artifact directory

`DataDir` appears in **every** prompt var struct (`PlannerVars`, `WorkerVars`,
`MainVars`, `GoalsVars`); `server/workspace.go` manages it. Where agents write
intermediate artifacts.

Decisions needed: per-target location (`targets/<id>/workspace/`), size and retention
policy, and the boundary against §5's cleanup ledger — **artifacts on our disk** are
housekeeping; **artifacts on the target** are a remediation obligation. Do not conflate.

---

## 19. Sprint 1 — delegation-and-memory slice, implementation outcomes

Recorded 2026-10-19. These are results from building and running the §13 step 1 spike,
not new architectural commitments. Everything below was observed against the installed
toolchain; where a claim is unproven it says so.

**Environment actually used.** `opencode` **v2.0.32** (the document's `@opencode/client@2.0.29`
is stale), `effect@4.0.5`, `drizzle-orm@0.45.4`, Bun **1.4.3**. (Drizzle was removed on
2026-10-20, §3; this records what the Sprint 1 runs below actually used.) The machine had Bun 1.3.14
installed, which cannot parse the committed `bun.lock` (`lockfileVersion 2`, written by
1.4.3) and fails with `UnknownLockfileVersion`. `.bun-version` already pins 1.4.3;
installing that exact version was required before `bun install --frozen-lockfile` would run.

### `PORT` — OpenCode 2 client/server contract, verified against the binary

Read off the running server's own OpenAPI document (`GET /openapi.json`, 119 paths), not
from docs. The routes this slice depends on:

| Concern                 | Route                                            | Note                                                                                                                                                    |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness               | `GET /api/info`                                  | The only endpoint that proves an OpenCode 2 server. `/doc` answers 200 with the web UI's HTML on any version.                                           |
| Host-controlled session | `POST /api/session`                              | Takes `model` and `location.directory`; returns `{ data: Session.Info }`.                                                                               |
| Submit work             | `POST /api/session/{id}/prompt`                  | Returns once the prompt is _accepted_, not when it completes.                                                                                           |
| Await settlement        | `POST /api/experimental/session/{id}/wait`       | Answers `204`.                                                                                                                                          |
| **Terminal status**     | `GET /api/session/{id}`                          | `outcome: "succeeded" \| "failed" \| "interrupted"`.                                                                                                    |
| Transcript              | `GET /api/session/{id}/message`                  | Entries typed `user`, `assistant`, `idle`. The `idle` entry carries the terminal `outcome`; provider failures appear as `error` on the assistant entry. |
| MCP injection           | `PUT /api/experimental/mcp/{server}?directory=…` | Remote config accepts `headers`.                                                                                                                        |

**`COPY` — MCP credentials travel in a request body.** `Mcp.RemoteConfigEncoded` carries
`headers`, so the session-scoped bearer token reaches the harness over HTTP and stays out
of the server's argv _and_ out of the environment every shell command the agent runs
inherits. This satisfies §6's non-negotiable directly, without T3's stdin-control-channel
machinery. Verified: the `PUT` returns `204`, is runtime-scoped, and **does not write to
the user's `~/.config/opencode/opencode.jsonc`** (checked by hash before and after).

**Known wart:** our MCP server answers `GET` with `405` (it exposes no server-initiated
stream). OpenCode's `StreamableHTTPClientTransport` logs `mcp transport error … Failed to
open SSE stream` once per connection and then works normally over POST. Tool calls are
unaffected. Do not treat that warning as a failure.

### `SPIKE` resolved — subscription auth works, and the model catalogue overstates access

The spawned server runs as the user and reads the user's own stored credentials; this
process never read, copied or held a credential. The only authenticated provider present
was `openai`, `type: oauth` — a ChatGPT subscription, not an API key. Confirmed by the
provider answering real requests at `cost: 0`.

**`FIX` — the catalogue is not an availability list.** `GET /api/model` advertised nine
`openai` models. Probed individually:

| Model                 | Result                                                           |
| --------------------- | ---------------------------------------------------------------- |
| `gpt-5.6-sol`         | completes                                                        |
| `gpt-6-astra`         | completes                                                        |
| `gpt-5.5`             | refused: "not supported when using Codex with a ChatGPT account" |
| `gpt-5.3-codex-spark` | refused, same message                                            |

So a worker's pinned model must be validated against the actual subscription, not
selected from the catalogue. The refusal arrives as a session `outcome: "failed"` with a
`provider.invalid-request` error on the assistant entry — which is also useful evidence
that an attempt's terminal status and a security result are genuinely separate signals.

### `PORT` + `FIX` — `record_observation` as built

Contract in `packages/contracts/src/observation.ts` (browser-safe, Effect Schema); store
in `apps/server/src/persistence/store.ts`; MCP surface in `apps/server/src/mcp/server.ts`.

- **Caller authority** comes from a session-scoped bearer grant
  (`apps/server/src/mcp/registry.ts`): `{target, intent, attempt, worker, harness session}`,
  hashed in memory, raw token never persisted, revoked on release. The session is created
  _before_ the credential is minted so the grant binds the real harness session ID rather
  than a placeholder. Tested: provenance a caller asserts in the payload is ignored.
- **Operation identity** is a receipt keyed `${callerScope}:record_observation:${operationId}`,
  written in the same transaction as the observation and the sequence bump. Exact retry
  replays the original result and does not advance the sequence; the same ID with
  different input is rejected as a conflict and writes nothing. Receipts survive restart.
- **Fails closed.** No bearer token, an unknown token or an expired grant is refused
  before any tool runs; there is no anonymous path and `tools/list` is unavailable too.
- The worker supplies `operation_id` itself. **We did not verify that OpenCode reuses a
  tool-call ID across a transport retry**, and deliberately did not depend on it — §6's
  warning stands unresolved rather than assumed away.

### `PORT` — the rate-limit fixture

`apps/server/src/fixture/rateLimit.ts`. Per-client limit 10, per-account limit 100,
independent; counters move only on a request or an explicit reset, never on a wall clock.
Loopback only.

**`FIX` — the audit counter must outlive the reset control.** `lifetimeRequests` counts
every request ever seen and is deliberately _not_ cleared by `reset`. Without it the
host's view of traffic is whatever survived the worker's last reset, and a worker's
self-reported `request_count` has to be taken on trust. With it the figures can be
checked: in the final run the worker claimed 14 + 11 = 25 requests and the host-side
counter independently recorded exactly 25.

### Checkpoints — what actually ran

Against §13 step 1's acceptance criteria. Two real harness runs, both reproducible from a
deleted `.runtime/`.

| #   | Criterion                                                         | Status                                                  | Evidence                                                                               |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Host-controlled session, task submitted, terminal status observed | **passed**                                              | `outcome: succeeded`, tokens `{input 13936, output 2241, cache.read 49024}`, `cost: 0` |
| 2   | Bounded fixture investigation under a request budget              | **passed**                                              | 25 of 60 permitted requests, host-corroborated                                         |
| 3   | Effect-backed MCP tool invoked, observation durable               | **passed**                                              | 2 tool calls; 2 rows read back by a separate process                                   |
| 3b  | Bounded **negative** result recorded                              | **passed**                                              | `outcome: negative` for the User-Agent claim, with conditions and limits               |
| 4   | Fresh session uses the briefing to choose a next investigation    | **passed**                                              | see below                                                                              |
| 5   | Server-side hook denies a prohibited action **before** execution  | **passed**                                              | see below                                                                              |
| 5b  | Missing policy connectivity fails closed                          | **passed**                                              | hook denied, citing unreachability                                                     |
| 5c  | Record exactly which execution paths the boundary covers          | **passed — and the answer is "narrower than it looks"** | see below                                                                              |

**Not attempted:** a second worker, concurrency, cross-harness fallback, quota/usage-limit
recovery, Caido, evidence blobs, any UI, `record_asset`, `add_intent`, `report_finding`.
Connectivity and these five checkpoints are **not** a full Sprint proof.

### Checkpoint 4 — briefing (resolves the §17 `SPIKE` for this narrow case)

`apps/server/src/briefing/briefing.ts` renders from stored rows at a recorded sequence.
Observations are ordered most-recent-first so truncation drops the _older_ evidence, since
a later observation qualifies an earlier one; omitted IDs are listed explicitly, so a
reader can tell truncation from absent knowledge.

The fresh session ran in a separate process with no access to the worker's transcript and
was given no candidate follow-ups. It cited both stored observation IDs, correctly stated
that rotating `X-Client-Id` bypassed the limit while varying `User-Agent` did not, and
proposed investigating **missing, empty, malformed and duplicate `X-Client-Id` headers** —
a dimension the database records as untested, and _not_ the per-account follow-up this
document's §15 example anticipated. It separately noted per-account limiting as
deliberately out of scope. Knowledge survived; it was not parroted.

**`FIX` — do not automate the "sensible follow-up" judgement.** A first attempt scored
keyword overlap between the proposal and the recorded untested dimensions, and credited
the per-account gap because the answer mentioned it _in order to exclude it_. The
automated assertion now covers only what is exactly checkable — session succeeded, cited
IDs exist in our database, all four sections answered — and the overlap score is printed
as an indicator for a human reader. A fuzzy matcher asserting semantic alignment would
have manufactured a pass.

### Checkpoint 5 — the pre-execution hook, and its real coverage

`apps/server/plugins/policyHook.ts` is a real server-side OpenCode plugin; the rule lives
in `apps/server/src/policy/service.ts`, reached over HTTP. The hook holds no local copy of
the rules, which is what makes failing closed meaningful. Posture is **permissive with
explicit coded boundaries** — no human-approval path, autonomy preserved.

Loading it took three contract corrections, each verified against v2.0.32:

1. A plugin must be a **default export** of `{ id, setup }` or `{ id, effect }`
   (`opencode/packages/core/src/plugin/module.ts:78-90`).
2. The config key is **`plugins`**, not `plugin`. The superseded `plugin` key accepts a string
   or a `[package, options]` _tuple_; an object there is silently dropped with
   `configuration normalization diagnostic … skipped malformed recognized value`
   (`packages/core/src/config/normalize.ts:185-190`).
3. A **configured** local plugin must point at a **directory** with an `index`/`server`
   entrypoint, not a bare `.ts` file — otherwise `configured plugin path must be a
directory` and it is skipped (`packages/plugin/src/host.ts:17-42`). Auto-discovery via
   a `plugin/` directory does admit a standalone file, but passes no options, so it cannot
   carry the policy endpoint. Keep the configured directory out of `plugin/`, or it loads
   twice and the optionless copy throws.

A hook that silently fails to load looks exactly like a hook that allows everything. The
first run of this experiment recorded **zero** policy decisions and an empty audit log and
would have been reported as a pass had the demo not asserted on server-side decision
records rather than on the model's account of events. **Any future enforcement claim must
rest on control-plane-side evidence.**

Results:

| Probe                     | Expected             | Observed                                                                   |
| ------------------------- | -------------------- | -------------------------------------------------------------------------- |
| in-scope file read        | allowed              | allowed, `SAFE-MARKER` returned                                            |
| out-of-scope file read    | denied pre-execution | denied; file `atime` unchanged; `FORBIDDEN-MARKER` never reached the model |
| policy service stopped    | fail closed          | denied, citing "control plane could not be consulted"                      |
| path assembled at runtime | —                    | **allowed; the file was read**                                             |

**`FIX` — tool-input inspection is not execution control.** The fourth probe ran
`f="out-of-scope"; g="-secret.txt"; cat "$f$g"` and succeeded with the policy service up
and healthy. The gate is a genuine pre-execution boundary on **model-supplied tool
arguments**, and nothing more: it does not constrain what a started process then does.
Covering that needs enforcement in the execution path itself — filesystem scoping or
sandboxing for local actions, a proxy for traffic — and §18's enrichment jobs, which
execute outside the harness entirely, are not covered by it at all. This is asserted as a
test (`policy/service.test.ts`, "a path assembled at runtime is NOT covered") so that a
future change claiming broader coverage has to confront it rather than inherit it quietly.

**`FIX` — compare hosts, not authorities.** The scope check first compared `host:port`
against the allowed-host list, which denied the fixture on its arbitrary free port. Ports
are not host identity here. Caught by a test before it reached a demo, and the reason
checkpoints 2 and 5 were never exercised together in one session.

### Honest limitations of this slice

- The policy endpoint is unauthenticated loopback. The hook cannot be impersonated — it
  runs server-side and a decision grants nothing — but a real deployment should
  authenticate it so policy traffic is not merely trusted by position.
- The plugin's options, including the policy URL, sit in a workspace config file the agent
  can read. Harmless here; not a pattern to extend to anything secret.
- Attempt settlement distinguishes `uncertain` from `failed`, and a failed `wait` is
  reconciled against harness state rather than inferred — but **no interrupted-execution
  recovery path was exercised.** §13 step 2's ambiguous-outcome requirement is untouched.
- `Session.Info.outcome` is the harness's view of _execution_. Nothing here derives an
  observation outcome or a finding from it, and nothing should.

---

## 20. Sprint 1 — Effect correction round

Recorded 2026-10-19, after an independent review of the §19 slice's Effect usage. Six
findings, all real; all addressed here. These are corrections to the implementation and,
in two places, to claims §2 and §19 made. Nothing below widens the architecture: no new
feature, no generalised framework, and the domain semantics, synchronous Drizzle
transactions, atomic observation+receipt write, bounded fixture and deterministic
briefings are unchanged.

### `FIX` — HTTP cancellation and transport bounds were decorative

`openCodeClient.ts` wrapped `fetch` in `Effect.promise(async () => ...)` and never
touched the `AbortSignal`. The review's probe interrupted a client fiber and confirmed
the request's signal was never aborted: the fiber went away, the request carried on.
`openCodeServer.ts`'s readiness loop had the same shape one level up — the deadline was
checked only _between_ requests, so a single hung `GET /api/info` outlived the 30-second
startup timeout indefinitely.

The client is now a `Context.Service` over Effect's own `HttpClient` with
`FetchHttpClient.layer`, which passes the fiber's signal into `fetch`
(`src/http/FetchHttpClient.ts:56-75`). Readiness is `Effect.retry` + `Effect.timeout`
around a probe built with `Effect.tryPromise({ try: (signal) => ... })` —
`Effect.promise` and `Effect.tryPromise` both hand the callback an `AbortSignal`
(`src/Effect.ts:1366`, `:1441`), which the old code had no way to know because it never
asked.

Bounds are per operation and are **transport bounds only**. `waitForIdle` keeps a
generous ceiling so a dead socket cannot wedge the process; it is not a deadline on
worker settlement, which stays the harness's to decide (§5). The timeout failure's own
message says so, and the demos treat it as `uncertain`, never as `failed`:

> request exceeded its transport bound and was aborted; this does not mean the harness
> stopped working

That distinction is the point. **Cancelling our request proves nothing about whether
remote execution stopped**, and the reconciliation path (§15) is what resolves it.

`@opencode/client/effect` would be the better source of these types, and T3Code uses it
(`packages/provider-opencode/src/server/v2/OpenCode2Client.ts:1-15`). It is not adopted
here: it is not installed, it is published against its own Effect version, and taking it
on is a dependency decision for the sprint that needs the whole 119-path surface rather
than six routes. `DEFER`, with that as the trigger.

Covered by `harness/openCodeClient.test.ts`, which stubs `FetchHttpClient.Fetch` (a
`Context.Reference`, so substitutable without a server) and asserts the signal is handed
over, that interrupting the fiber sets `signal.aborted`, and that a hung request fails
on its bound.

### `FIX` — the owned process was not actually owned

Three defects in one place. `stdout` and `stderr` were piped and never read, so the
child blocks once a pipe buffer fills. The finalizer called `kill()` without waiting or
escalating, which is a request rather than an outcome. And a readiness failure reported
an exit code with none of the process's own output.

Now: scope-owned fibers drain both streams to EOF into a character-budgeted ring —
reading is unbounded, _retention_ is bounded, and everything discarded is counted rather
than silently truncated. The finalizer sends `SIGTERM`, awaits `child.exited` within a
grace period, escalates to `SIGKILL`, awaits again, and logs if the process survives
even that. Readiness failures carry the retained tail, so "exited with code 3" arrives
with `fatal: port 4096 already in use` attached. Ordering is load-bearing: the process
is stopped before the readers are, so the pipes reach EOF on their own and the last
lines land in the diagnostics.

`effect/process`'s `ChildProcessSpawner` would be the idiomatic answer and is **not
installed** — which is a dependency decision, not a wall. `CORRECTED 2026-10-19`: an
earlier version of this entry called it "not usable", which overstates the case.
`src/process/ChildProcessSpawner.ts` defines the `Context.Service` and a
`ChildProcessSpawner.make(spawn)` helper (`:232`) that builds the service from a single
`spawn` function, so a Bun implementation is writable here; what ships elsewhere
(`@effect/platform-node` / `-bun`) is a ready-made one. `ChildProcess.make` even takes
`detached` (`:455`), which is the option this slice needs. Not taken on: the service's
surface is `spawn` / `exitCode` / `streamString` / `streamLines` / `lines`, and
implementing all of it to own one server is more than the slice needs while the module
is `@stability unstable`. `DEFER`, with "a second kind of spawned process" as the
trigger. Bun's `spawn` is retained with the ownership built explicitly. T3's
cross-process sharing ledger (`OpenCodeRuntime.ts`) is deliberately not carried over
either: one process owns one server here, so there is nothing to arbitrate.

Covered by `harness/openCodeServer.test.ts`, which spawns a **real** scripted stand-in
rather than a mock — pipe back-pressure, signal handling, process groups and awaited
exit are precisely what a double cannot have. It asserts a child writing 4000 lines on
each stream still reaches readiness (so the pipes were being read) while only a bounded
tail is retained; that a child installing a `SIGTERM` handler is escalated and gone;
that a readiness failure leaves no surviving process; and that a hung `/api/info` ends
on the bound.

### `FIX` — process ownership, round two

Recorded 2026-10-19 after the review re-read the above against the code. Three of its
claims were still wrong and a fourth property was missing. Nothing here widens scope:
it is the same correction — "own the process you spawned" — carried to the end.

**1. "Retention is bounded" was false.** The old `LineRing` capped the number of
complete lines and nothing else. A child writing without a newline grew the
partial-line buffer without limit — and re-copied it on every chunk, so the cost was
quadratic in the length of the unterminated line — and each retained complete line was
itself unbounded. A line count bounds memory only if lines are short, which is an
assumption about someone else's process.

Retention is now budgeted in characters, three ways: per stream
(`diagnosticCharacters`, default 32 000), per line (`diagnosticLineCharacters`, default
2 000) and still per line count (`diagnosticLines`, 100), whichever binds first. Past
the per-line budget characters are counted and dropped as they arrive rather than
appended, so an unterminated stream neither grows the buffer nor pays for a copy. A line
kept only as a head says so in its own text (`…[+N characters truncated]`), and
`Diagnostics` now reports `droppedCharacters`, `truncatedLines` and
`retainedCharacters` beside the existing `dropped` line count. An error's rendering is
bounded too: `renderDiagnostics` caps its output and appends the accounting, because
twenty retained lines can still be twenty line budgets wide.

**2. The drain's interruption comment was false.** `drain` wrapped a `for await` in
`Effect.promise` and the comment claimed interruption would break the loop and release
the reader. It does not: interrupting a fiber does not cancel an arbitrary pending
promise, and the loop's next `read()` is already in flight. Measured, on the old code:
interrupt the drain fiber over a stalled stream and the source's `cancel` is never
called and `stream.locked` stays `true` — the reader outlives its owner. This matters
because EOF is not guaranteed by the direct child's death: anything it started that
inherited the pipe keeps the write end open.

The readers are now `Stream.fromReadableStream` pulls. That constructor acquires the
reader inside the pull's own scope and registers `reader.cancel()` as its finalizer
(`effect/src/Channel.ts:1943-1976`), so an interrupt genuinely ends the read. Verified
against Bun 1.4.3: `cancel()` settles even with a `read()` pending and resolves that
read as done. (`stream.locked` stays `true` afterwards in Bun; the loop is over
regardless and nothing reuses the stream.) The readers live in their **own** scope, not
the caller's, so teardown can order itself: stop the process, give the drains a bounded
moment to reach EOF and flush, then close the reader scope — which cancels them
outright for the case the pipes never did close. Decoder flush and tail flush are one
`Effect.ensuring`, so EOF, read failure and interruption all finalize identically.

**3. `acquireRelease` had been dropped for `Effect.try` + `forkScoped` +
`addFinalizer`.** That loses the thing `acquireRelease` is for: an interrupt arriving
between `Bun.spawn` returning and the finalizer being registered leaks the child.
`Effect.acquireRelease` runs its acquire inside `uninterruptibleMask`
(`effect/src/internal/effect.ts:4143-4158`), and that is what the spawn, the group
verification and the reader fork now sit inside. The region is deliberately minimal:
readiness polling is **outside** it and stays interruptible, so nothing masks the
thirty-second wait.

**4. Termination reached the direct child only.** `child.kill()` signals one pid.
OpenCode runs shell commands, so the owned tree is not one process, and a direct-child
signal leaves them. Measured: a child that traps `SIGTERM` and a shell it started both
survive a direct `SIGTERM`; `kill(-pid, SIGKILL)` removes both.

The child is therefore spawned `detached` (`setsid()`, so it leads its own process
group) and termination signals the group, following T3Code
(`OpenCodeRuntime.ts:731,761-780`) and its `signalProcessGroup` guard
(`provider-core/src/server/processGroup.ts`). Two safeguards, because the cost of being
wrong is signalling processes we do not own:

- The group is **verified against the kernel**, not assumed from the spawn option:
  `/proc/<pid>/stat`'s `pgrp` field (or `ps -o pgid=` where there is no procfs) must
  equal the child's own pid. If it does not, a warning is logged and cleanup falls back
  to the direct child.
- A pid of `0` or `1` is refused outright, since `kill(-0)` signals _this_ process's
  group and `kill(-1)` everything the user owns.

Nothing is ever matched by name or command line, so a pre-existing `opencode serve` is
untouchable by construction — confirmed incidentally during this round, with two
unrelated servers running on the machine throughout (one of them T3 Code's own) and
neither signalled.

Two honest limits of detaching. A detached child does **not** receive the terminal's
`SIGINT` alongside us, and does not die if _this_ process is `SIGKILL`ed; cleanup is
ours alone, which is why the `SIGINT` path was re-verified against the real binary
rather than assumed. And group signalling inherits POSIX's pid-reuse race: the group id
cannot be recycled while the group has members, so the window is between our
"is the group non-empty" probe and the signal that follows it. It is microseconds wide
and inherent; T3 carries the same one.

Covered by `harness/openCodeServer.test.ts`, 22 tests, every process assertion made
against **pids the probes record about themselves** rather than a global `pgrep` — a
name match would pick up a concurrent test's binary and would also make the tests claim
things about processes they do not own. `afterEach` reaps those recorded pids whether
the assertions passed or failed. Specifically:

- A real child writes 2 MiB to stdout with no newline at all and twenty 50 000-character
  lines to stderr, still becomes ready (so draining continued throughout), and retains
  under `2 × (characters + lineCharacters)` of the 3 MB it was handed, with the
  truncation visible in the retained text.
- `LineRing` directly: the character budget binds where the line count would not, a
  truncated line carries its own count, and the tail flush is idempotent.
- A stalled `ReadableStream` whose `cancel` we wrote: interrupting the drain calls it,
  within milliseconds rather than waiting out the read. A half-encoded multi-byte
  character is flushed out of the decoder on that same path.
- A descendant that traps `SIGTERM` and holds the inherited pipe open dies with the
  group; with `ownProcessGroup: false` — the old contract — it survives, which is the
  test that makes the default load-bearing rather than decorative.
- A descendant that escapes into its own session keeps the write end open after the
  group is gone: the scope still closes, spending its drain grace and then cancelling
  the reader, and the test proves the holder was alive at that moment rather than
  assuming it.
- Interrupting startup at twelve staggered offsets never leaves a recorded pid behind.
  The instant between spawn and registration is unobservable from outside by
  construction — that is the guarantee — so this covers the window, not the instant.

### `FIX` — scopes and credentials outliving their failure paths

`spike/policyDemo.ts` closed its scope only on the success path, leaking a live
`opencode serve` and a policy listener on exactly the runs where a clean machine matters
most. `workerDemo.ts` and `briefingDemo.ts` hand-rolled `Scope.make` / `Scope.close`
and silenced the type error with `Effect.void as never`, discarding the program's real
exit through a `.finally`. The MCP credential was revoked only after a successful run:
a failure between issuing it and finishing the attempt left a usable credential bound to
a session nobody was driving.

One correction to the review's framing, which matters for anyone reading the old code:
**`Effect.void` is recognised as a success `Exit` at runtime in 4.0.5**, so finalizers
did run. The defects were the cast, the lost exit value, and the skipped close — not a
broken finalizer. `Exit.void` is the correct value and exists (`src/Exit.ts:347`); T3
uses it for intentional closure (`OpenCodeServerOwner.ts:38-40`).

What replaces it:

- Demos run under `spike/main.ts`, a `Runtime.makeRunMain` entrypoint
  (`src/Runtime.ts:183` is the documented seam for exactly this). `@effect/platform-bun`
  provides `BunRuntime.runMain` and is not installed, so this is the same construction
  locally: `SIGINT`/`SIGTERM` interrupt the main fiber instead of killing the process,
  and the program's exit reaches the teardown.
- Resource regions are `Effect.scoped`. `policyDemo` has two, and the first one closing
  is what _stops_ the policy service — the precondition probe 3 claims to test.
- `McpCredentials.issue` is an `Effect.acquireRelease`, so the grant belongs to the
  caller's scope and is revoked on success, failure and interruption alike. `revoke` is
  idempotent, so the demo can still revoke early and prove a later call fails closed.
- No `as never` remains anywhere in the slice.

Covered by `mcp/server.test.ts` "credential lifetime": a grant does not outlive a scope
that **fails**, nor one whose fiber is **interrupted**, and the registry holds no raw
token. Verified live too: `SIGINT` sent to a running `workerDemo` 22 seconds in exited
**130** with the spawned `opencode serve` gone.

### `FIX` — `JSON.parse(text) as A` is not a typed boundary

The client cast response bodies, so the review's stub answering HTTP 200
`{unexpected:true}` to `createSession` produced a `Cause.Die` from `body.data.id` rather
than a `HarnessError`. Every response is now decoded through a Schema, with the two
failure modes kept apart all the way out: `HarnessTransportError` (no usable HTTP
answer, or non-2xx, carrying the status when there was one) versus `HarnessDecodeError`
(2xx whose body does not match the contract, carrying both the status and the schema
issue). "200 with the wrong shape" is a different diagnosis from "503" and the types say
which one happened. Response schemas are deliberately **narrow** — they decode the
fields used and ignore the rest, because this is someone else's API.

The same unsafe-cast pattern appeared at two more untrusted boundaries and both are
fixed:

- **Policy requests.** `policy/service.ts` did `(await request.json()) as PolicyRequest`,
  so a body with no `tool` reached `decide` with `undefined` fields. A gate that accepts
  malformed requests is not a gate. Now decoded, denied with a reason on failure, and
  **not** recorded as a decision about a request that was never understood.
- **Persisted rows.** `store.ts` read JSON columns with `JSON.parse(row.evidenceRefs) as
string[]` and `decodeUnknownSync` for conditions — an unsafe cast beside a throwing
  decoder, both inside a query. Row shapes are now `Schema.fromJsonString(...)` codecs
  and a row that no longer decodes is a tagged `StoredRowError` naming the table and the
  row. Receipt replay decodes the stored result too, rather than casting it.

The policy _hook_ (`plugins/policyHook.ts`) still reads its response without Schema,
and that stays: it is loaded as a standalone entrypoint inside the harness process and
must not depend on anything resolvable only from this workspace. It is not an unchecked
cast — it accepts `allow` and `deny` by name and treats everything else, including a
missing or unrecognised verdict, as a fail-closed denial.

### `FIX` — the MCP server is Effect's now, and §2's rationale for hand-writing it was false

See §2 for the corrected Schema → JSON Schema entry: the conversion exists, the claim
that it does not was wrong, and the hand-written `inputSchema` it justified was a
liability. Two descriptions of one payload — a JSON Schema literal in snake_case and an
Effect Schema in camelCase, bridged by a hand-written key-by-key mapper — is a drift
waiting to happen.

The whole handwritten JSON-RPC server is replaced by `McpServer.layerHttp`
(`src/ai/McpServer.ts:1649`) with a `Tool` / `Toolkit`, following T3Code
(`apps/server/src/mcp/McpHttpServer.ts:183-185,861-867`). Roughly 200 lines of protocol
code that had to be read against the spec to be trusted are gone. What remains is the
part that is genuinely ours: the auth boundary and the binding to Bun's HTTP server.

The properties that had to be preserved, and were:

- **Auth still fails closed, and earlier than before.** An `HttpRouter.middleware`
  resolves the presented credential before any protocol handling, so a missing, unknown
  or expired token gets `401` and never reaches a tool, a tool list, or even
  `initialize`. The resolved grant is provided as `McpInvocation` for that request only.
  `record_observation` declares it with `Tool.addDependency`, making the caller identity
  a _request-level_ requirement rather than something a handler layer closes over —
  which is precisely the thing one wants to be unable to forget.
- **Provenance is still server-derived.** A caller asserting `intent_id` in its payload
  is still describing a resource it cannot address.
- **Transport behaviour is unchanged for the client that matters.** OpenCode speaks
  Streamable HTTP (`opencode/packages/core/src/mcp/client.ts:272`) and negotiates
  `2025-06-18`, which is the configured protocol.

Two mechanisms considered and not used, with reasons rather than silence:

- `McpServer.layerHttpRequestScoped` accepts only sessionless protocols
  (`v2026_07_28`, `src/ai/McpProtocol.ts:211`), which OpenCode's client does not
  negotiate. `layerHttp` plus middleware-provided request context is what T3 runs in
  production and is what works here.
- An Effect HTTP _server_ layer needs a platform package (`@effect/platform-bun`) that
  is not a dependency. `HttpRouter.toWebHandler` bridges to `Bun.serve` instead: it
  builds the application layer **once** and returns a scope-owned handler with a
  `dispose()`, which is a single long-lived runtime — not the detached per-call root
  executions the previous Bun callbacks were doing.

A refused write is now a tool _result_ rather than a transport error
(`failureMode: "return"`), because a receipt conflict is information the worker needs
("you already used that `operation_id`") and not a reason to lose its turn. A store
failure is returned the same way and logged, for the same reason: the worker must learn
that its observation did **not** land.

**This is protocol and tool infrastructure only.** `effect/ai`'s `LanguageModel` is not
used and no model API is called. All model work still goes through the
subscription-authenticated harness (§1).

### `PORT` — service boundaries, tagged errors, testable time

Four `Context.Service` boundaries, not one per helper: the harness
(`OpenCodeServer` owning the process, `OpenCodeClient` owning the HTTP seam),
`ObservationStore`, `McpCredentials`, and the MCP/fixture/policy endpoints as scoped
resources. Operations are named `Effect.fn`s, so a trace reads in domain terms. Pure
transforms — `decide`, `RateLimitFixture`, `renderBriefing`, `openQuestionsOf` — stay
ordinary functions; a bounded state machine has no business being a service. Stock
Drizzle typed queries and the synchronous-callback wrapper are untouched.

The spike's wiring is a layer graph rather than a `bootstrap` record, because its
ordering constraints are real and a graph states them: the workspace must exist before
the harness spawns into it (the first `policyDemo` run after this refactor failed with
`ENOENT` for exactly that reason, which is the sort of thing a layer dependency makes
checkable instead of remembered), the store before the endpoint serving a tool that
writes to it, and all of it down in reverse order on any exit.

Error channels name what a caller can act on. `store.ts`'s mutation boundary was
`MutationError | Error` and `briefing.ts` was `Effect<Briefing, Error>`; both erased
the distinctions that make recovery possible. Now: `MutationError` (domain refusal),
`DatabaseError` (SQLite), `StoredRowError` (data integrity), `BriefingError`
(tagged, `reason: "unknown_intent"`), `HarnessTransportError` / `HarnessDecodeError` /
`HarnessProcessError`. Expected failures are typed, not `Effect.promise` defects.

Time is read through the `Clock`, so `recordedAt` and credential expiry are testable —
`store.test.ts` asserts an exact `recordedAt` under `TestClock` instead of a range.
Secrets are `Redacted`: the generated server password and the MCP bearer token cannot
reach a log line or an error rendering, and the single unwrap sits at the one request
that delivers the token.

### Verification actually run

| Check                  | Result                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`         | 93 pass, 0 fail (was 83, was 49) — run uncached, `turbo` reporting `0 cached, 1 total`                                                                                             |
| `bun run typecheck`    | clean                                                                                                                                                                              |
| `bun run build`        | clean                                                                                                                                                                              |
| `bun run lint`         | clean                                                                                                                                                                              |
| `bun run format:check` | clean except `sprint-roadmap.html`, which this round did not touch                                                                                                                 |
| Checkpoints 1-3, live  | `succeeded`; 2 new observations recorded through the Effect-native MCP server by a real subscription-authenticated worker; 6 authenticated MCP requests served; credential revoked |
| Checkpoint 4, live     | `PASSED`; a fresh session cited all four stored observation IDs and answered 4/4 sections                                                                                          |
| Checkpoint 5, live     | all four probes as before: allowed / denied pre-execution / fail-closed / runtime-assembled path still uncovered                                                                   |
| Interruption, live     | `SIGINT` to a running `workerDemo` → exit **130**, no surviving `opencode serve`                                                                                                   |

Re-run for the process-ownership round, after the spawn became `detached` — the change
that could have broken the `SIGINT` path, since a detached child no longer receives the
terminal's signal with us:

| Check                     | Result                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`            | 93 pass, 0 fail, uncached                                                                                                                                                           |
| `bun run typecheck`       | clean                                                                                                                                                                               |
| `bun run build`           | clean                                                                                                                                                                               |
| `bun run lint`            | clean                                                                                                                                                                               |
| `bun run format:check`    | clean except `sprint-roadmap.html`, untouched by this round as by the last                                                                                                          |
| Real harness lifecycle    | `opencode serve` v2.0.32 spawned, ready, `leadsOwnGroup: true` (pgid 234988 = pid, against our own group 234968); scope close left `alive: false` and an empty group                |
| Real harness `SIGINT`     | wrapper exit **130**; the detached server (pid 235058) gone, its group empty — so the finalizer, not the terminal, is what stopped it                                               |
| Checkpoints 1-3, live     | re-run against the detached server: session `succeeded`, 2 further observations written through the MCP tool, 6 authenticated MCP requests served, credential revoked, 0 live after |
| Unrelated servers on host | two pre-existing `opencode serve` processes ran throughout (one T3 Code's own) and neither was signalled; nothing is ever matched by name                                           |

The pre-existing SQLite evidence under `apps/server/.runtime/` was kept, not reset. Rows
written by the previous build decode unchanged through the new Schema-based reader,
which is a useful compatibility signal in its own right.

### Remaining limitations

- **Interrupted attempts are still not reconciled.** The interruption test leaves two
  attempt rows at `status: "running"` with real session IDs that nothing will ever
  settle. Cleanup on interruption is proven; _recovery_ is not, and §13 step 2's
  ambiguous-outcome requirement remains untouched. This is the largest open gap.
- **The hook's coverage limit is unchanged**, and must not be restated as broader. A
  shell command assembling a forbidden path at runtime still reaches the file.
- `McpServer.layerHttp`, `HttpRouter.toWebHandler` and `effect/ai`'s `Tool` are tagged
  `@stability unstable` in 4.0.5. Verified working against the real OpenCode client at
  v2.0.32; worth re-checking on any Effect upgrade.
- The toolkit registration casts away `McpInvocation` from the layer's requirements,
  since the middleware provides it per request. T3 does the same with the same
  justification (`McpHttpServer.ts:777-782`), but it is a type assertion, not a proof.
- `@opencode/client/effect` is still not used, so the response schemas remain
  handwritten and narrow. They decode what this slice reads and nothing more.
- **Group ownership is verified on Linux and only argued elsewhere.** The `pgrp` read
  goes through `/proc` with a `ps -o pgid=` fallback, but every run of it so far has
  been on Linux. macOS takes the fallback path and is untested.
- **A process that escapes our group is not ours to clean up**, and is not claimed.
  Anything that calls `setsid()` for itself leaves the tree; the reader is cancelled so
  it cannot hold our scope open, but the process itself survives. The test that proves
  this reaps it as a test probe, which is not something the implementation does.
- `Stream.fromReadableStream`'s cancellation behaviour is relied upon and was verified
  empirically against Bun 1.4.3 rather than specified anywhere; `effect/process` and
  `Stream` are both `@stability unstable` in 4.0.5.
- The pid-reuse race described above is narrowed but not eliminated.

---

## 21. Persistence replacement and multi-case observations

Recorded 2026-10-20. Two changes landed together, at the operator's direction: Drizzle
was replaced with `effect/sql` (§3), and an observation now carries several test cases
instead of one flattened set of conditions. Both are implemented, both are exercised
against real SQLite, and the live proof below ran on the new backend with a real
subscription-authenticated worker.

### `PORT` + `FIX` — one claim, several cases

The §4 rule is unchanged and is the reason for the change: an observation speaks to
exactly one narrow `testedClaim` and carries one `outcome` relative to that claim alone.
What was wrong was the shape underneath it. A single `conditions` struct had one
`endpoint`, one `account`, one `clientIdentity`, one `method` and one `requestCount`, so
a test that necessarily involves more than one identity had to flatten them into prose.
The stored evidence shows exactly that failure: `obs_000005`'s `clientIdentity` reads
"held at claim1-fixed through refusal, then changed to claim1-rotated", and its
`requestCount` of 13 is one total across both. Which identity got the 429 is recoverable
only by reading the free text.

The accepted shape (`packages/contracts/src/observation.ts`):

- `setup: string` — the shared arrangement every case ran against.
- `cases: NonEmptyArray<ObservationTestCase>`, each with `id`, `purpose`,
  `actors[{ id, account, role, clientIdentity }]`,
  `relationships[{ subject, relation, object }]`,
  `actions: NonEmptyArray<{ actorId, endpoint, method, description, requestCount,
observedBehavior, evidenceRefs }>`, `configuration`, `windowStart`, `windowEnd`,
  `testBounds`, `limitations`.
- At the observation level: `operationId` (input only), `testedClaim`, `outcome`,
  `interpretation`, overall `limitations`, `untestedDimensions`, and server-derived
  provenance.

Three deliberate consequences:

1. **Observed behavior lives on the action that produced it**, not once per observation.
   An actor, an endpoint, a method, a request count and a response cannot drift apart.
   There is no top-level `observedBehavior` or `evidenceRefs` duplicating the actions',
   because a second summary of the same thing is a second thing to keep true.
2. **Actions are ordered, and the order is the order performed.** A list cannot express
   concurrency, so overlapping work is described as such in the action's `description`
   rather than implied.
3. **`account: null` means unauthenticated and `role: null` means unknown or not
   applicable** — in _new_ records. Both are nullable rather than defaulted to an empty
   string because "signed in as nobody" and "we did not record who" are different facts.
   No credential belongs in an actor.

`relationships` expresses ownership and tenancy as three strings a reader can check. It
is not a graph subsystem and no resolution happens over it.

**Validation is in the schema, not in prose.** Required strings are
`Schema.NonEmptyString`; `cases` and `actions` are `Schema.NonEmptyArray`; counts are
`Schema.Natural` (integer, `>= 0`, so a step that sent none is legal and `-1` and `1.5`
are not); window bounds are `Schema.Finite`. Three cross-field checks reject duplicate
case ids, duplicate actor ids within a case, an action naming an actor the case never
declared, and a window that ends before it starts. `SchemaAST.Filter` is contravariant
in its input (`effect/src/SchemaAST.ts:4078`), so one set of checks is declared once and
applied to both the domain and the wire schema — the boundary cannot be laxer than the
store.

The wire schema is still derived, not written twice: `Schema.encodeKeys` on shared field
records. It renames one struct's own keys and does not recurse, so the nested member
schemas are substituted explicitly; `mcp/server.test.ts` asserts the advertised JSON
Schema contains `test_bounds`, `actor_id`, `request_count`, `observed_behavior`,
`client_identity` and friends and contains **no** camelCase equivalent, so a missed
substitution fails the build rather than reaching a worker.

### `FIX` — summary-format observations keep their shape, and say so

> Superseded in part by "`FIX` — one contract version, two record formats" below, which
> replaced the version-numbered naming this subsection originally used. The reasoning
> here stands; the names in it have been brought in line with the code.

Rewriting the six stored observations as cases without losing information is impossible.
Their `clientIdentity` names up to four identities in one string and their `requestCount`
is a single total; manufacturing per-actor actions and an allocation of that total would
be fabrication, not migration. So:

- The contract's `Observation` is a discriminated union over the record format:
  `_tag: "caseBased"` (`setup` + `cases`) or `_tag: "summary"` (the flattened
  `conditions`, `observedBehavior` and `evidenceRefs`). There is deliberately no
  accessor that papers over the difference, because every such accessor would have to
  invent something for one arm.
- Migration `0002` rebuilds `observations` with a `CHECK` enforcing the pairing — a row
  cannot be both formats or neither — and carries existing rows across with their columns
  renamed, not parsed. Ids, sequences, outcomes, limitations, untested dimensions and
  provenance are untouched, so every receipt naming them still resolves.
- Briefings render summary rows under an explicit `RECORD FORMAT: summary` heading that
  states _why_ the prose must not be read as a single actor, and prints the count as
  "requests issued (total)". `briefing.test.ts` asserts a summary row produces no
  `cases (` and no `actions, in the order performed` heading.
- New writes are case-based only. Nothing can write the summary format; it is read-only
  and unreachable from `RecordObservationInput`.
- Receipt semantics are unchanged across the upgrade. A retry of a pre-change operation
  ID whose content differs is a **conflict**, not a second write — the old hash was
  computed by a build that no longer exists, so a match is impossible and a conflict is
  the correct answer. Asserted in `store.test.ts`.

### Verification actually run

**Automated.** `bun run test:persistence` — 66 tests across four files, all against real
`bun:sqlite` files in temporary directories, none against `.runtime/`:

| Area                      | What is executed                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sql.test.ts` (8)         | pragmas read back off the live connection; FK violation refused; bound parameters with embedded quotes and a `DROP TABLE` payload stored and re-read intact; failed transaction commits nothing; interrupted transaction rolls back; reopen; unopenable path is a typed `DatabaseError`                                                                                                                                                                                         |
| `migrations.test.ts` (13) | fresh DB replays the full chain; journal matches `MIGRATIONS`; `CHECK` refuses a both-shapes row; repeat migrate applies nothing; rows written after migrating survive a later migrate; a first-slice DB with no journal upgrades with every row, receipt and cursor preserved; upgraded schema equals fresh schema; adoption is idempotent; failure names the migration, rolls back its DDL and its journal row, and recovers via a forward correction; duplicate ids refused  |
| `store.test.ts` (37)      | every repository statement executed; receipt replay/conflict including a conflict triggered by one edited action; per-caller namespacing; monotonic sequence; FK refusal leaves the cursor at 0; full multi-case round trip with ordered actions and null account/role; 12 validation cases; summary read-back unrewritten; both formats coexisting; corrupted JSON, corrupted cases and a contradictory record format each reported as a typed `StoredRowError` naming the row |
| `briefing.test.ts` (8)    | cases, actors, relationships, ordered actions, per-case bounds and concurrency note all reach the rendered page; summary row labelled and not dressed up as cases; both formats side by side, newest first; truncation disclosed by id                                                                                                                                                                                                                                          |

Full preflight: `bun run test` (145 tests), `bun run typecheck`, `bun run build`,
`bun run lint`, `bun run format:check`. The last reports `sprint-roadmap.html` only,
which was already failing before this change and was left alone.

**Live, on the new backend.** `workerDemo.ts` against `opencode` **v2.1.0** (up from the
v2.0.32 §19 recorded) with stored OpenAI OAuth, writing to the real
`.runtime/hunt.sqlite`:

- The adoption path ran in place on the six-observation evidence database. All six came
  through as the summary format and the two new ones as case-based; the demo's record
  format tally reported six and two. Re-read after the `0003` rename it still does:
  `record formats: {"caseBased":2,"summary":6}`.
- The worker recorded two multi-case observations, sequences 7 and 8, `outcome` positive
  and negative respectively. Session `succeeded`, tokens
  `{input 14574, output 3072, reasoning 795, cache.read 51840}`, cost 0, 6 MCP requests
  served, credential revoked and 0 live grants at exit.
- **The per-action counts are host-corroborated, and the prose was not.** The worker's
  closing message said "25 total requests". The sum of every `requestCount` across both
  observations' actions is **23**, and the fixture's own `lifetimeRequests` counter
  independently recorded **23**. Under the old single-`requestCount` shape the only
  figure available would have been the worker's own total; the per-action breakdown is
  what made the discrepancy visible, and it favours the structured record.
- `briefingDemo.ts`: a fresh session in a separate process read a 24,924-character
  briefing holding both formats, answered all four required sections, and cited four
  stored observation IDs — three summary-format and one case-based. It proposed testing missing,
  empty, malformed, duplicated and case-varied `X-Client-Id` headers, which the database
  records as untested, and explicitly set per-account limiting aside as out of scope. It
  did not treat any single observation as settling the broad objective. Checkpoint 4
  `PASSED` on the same exactly-checkable criteria as before; the sensibleness of the
  follow-up remains a human judgement, printed rather than asserted.

Logs: `.runtime/workerDemo-sql-122715.log`, `.runtime/briefingDemo-sql-122918.log`.

### Remaining limitations of this change

- **No `down`, no `redo`.** Stated in §3 and worth repeating: the migrator has no
  reverse direction, none was built, and retraction means a new forward migration. The
  replay test is what stands in for "the chain is still coherent".
- **SQL identifiers and placeholders are not checked before runtime.** The integration
  tests are the check. A statement added without a test that executes it is unverified,
  regardless of how well-typed its result schema is.
- **The six summary-format observations will stay that way.** Nothing is planned that
  would rewrite them as cases, because nothing can without inventing data. They are
  readable and labelled; a consumer that wants uniform structure has to handle the union.
- **One worker, one attempt, local fixture.** Unchanged from §19: no concurrency, no
  second worker, no cross-harness fallback, no Caido, no evidence blobs, no UI. The
  interrupted-attempt reconciliation gap in §20 is untouched by this change.
- **`effect/sql` and the driver are `@stability unstable` in 4.0.5**, as is
  `effect/sql/Migrator`. The APIs used here were read off the installed source and
  verified by execution, not taken from documentation; they are worth re-checking on any
  Effect upgrade.
- **Exactly-once remote effects are still not assumed.** The receipt makes _our_ write
  idempotent. It says nothing about whether a worker's request reached the target once,
  and §6's unresolved warning about tool-call ID reuse across a transport retry stands.

### `FIX` — Automatic migrations before store availability (2026-10-20)

The operator requested automatic migrations, matching T3's startup ordering. Both
`ObservationStore` layers now run the pending migration chain during acquisition,
before publishing the service (`apps/server/src/persistence/store.ts:291`). This
prevents callers from accidentally querying an unmigrated database. Applied migrations
are logged; an already-current database is a no-op. A migration failure fails layer
acquisition with `DatabaseError`, so consumers cannot start against a partial schema.

The public `store.migrate` method and explicit calls in server startup, demos and tests
were removed. The low-level runner remains available for migration replay and rollback
tests; the raw `sqliteLayer` remains connection-only so those tests can construct old
and deliberately broken schemas. Real SQLite store tests verify automatic fresh startup,
reopening, first-slice upgrades and failure before consumer execution
(`apps/server/src/persistence/store.test.ts`, "automatic store migrations"). Persistence/briefing verification:
68 tests passed; typecheck passed.

### `FIX` — one contract version, two record formats (2026-10-20)

The operator's correction: this is a foundation in its first version, nothing has been
published, and naming part of it after being deprecated asserted a release history that
does not exist. The previous round had invented one. It called the multi-case shape
`schemaVersion: 2` and the earlier shape `schemaVersion: 1`, tagged the earlier one with a
deprecation word rather than with what it holds, and so read as "v1 shipped, then v2
superseded it". Neither ever shipped. The two shapes differ in **how the evidence is laid
out**, not in which release wrote them, so the distinction is now a _record format_
inside contract version 1.

**Public version semantics.** `OBSERVATION_CONTRACT_VERSION = 1`
(`packages/contracts/src/observation.ts:404`) is the whole version story, and it exists to
give the number one home with a stated meaning, not for consumers to branch on: nothing
has been published under any other value, so no code should carry a "v1 path" and a "v2
path". Migration ids are a **separate** sequence counting schema changes made during
development. `0002` is the second such change, not evidence of a second released shape —
stated at the top of `apps/server/src/persistence/migrations.ts` so the next reader does
not re-derive the wrong conclusion from a journal row.

**The two formats** (`ObservationRecordFormat`, `contracts/observation.ts`):

- `caseBased` — `setup` plus one or more `ObservationTestCase`, each with actors,
  ownership facts and ordered actions (`CaseBasedObservation`).
  Everything writes this; `OBSERVATION_WRITE_FORMAT` is the only
  value the store inserts, and it is the only format `RecordObservationInput` expresses.
- `summary` — one flattened `conditions` struct and one prose `observedBehavior`
  (`SummaryObservation`). Read-only. The name describes the data: a
  single summary of one run, where a case-based record would have several cases.

The `_tag` **is** the record format, so the redundant per-arm version literal is gone. A
reader of a union value learns the format from the discriminant and nothing else claims a
version.

**`FIX` — the stored schema says format, not version.** Migration `0003`
(`migrations.ts:246`) rebuilds `observations` once more: `schema_version INTEGER` becomes
`record_format TEXT` holding `'case_based'` or `'summary'`, and the three columns named
for being superseded are renamed after the format they belong to (`summary_conditions`,
`summary_observed_behavior`, `summary_evidence_refs`). A rebuild rather than
`RENAME COLUMN` because the `CHECK` that enforces the format/columns pairing names the old
column and SQLite cannot replace a `CHECK` in place; renaming alone would leave a
constraint written in the old vocabulary behind it. `STORED_FORMAT`
(`apps/server/src/persistence/store.ts`) is the one place the snake_case stored values
and the camelCase tags are mapped.

This is development evolution inside v1, **not** a production compatibility lifecycle.
There is no upcaster, no version negotiation and no generic migration framework — one
forward rename, and then the old vocabulary is gone from every live database.

**Why `0002` still spells the old column names.** `0002` has been applied to the
development database at `apps/server/.runtime/hunt.sqlite`, and §3's rule is append-only:
never edit an applied migration. Re-spelling its body would change what a replay produces
without changing what that file contains, and the two would silently diverge. So its
statements stay as applied, and `0003` is what reconciles them. The identifiers inside it
are a record of how that one file reached its current state. **After `0003` no database —
fresh or upgraded — has a column by those names**, and the only other place they appear is
the one test that writes a row in `0002`'s vocabulary to prove `0003` maps it rather than
dropping it ("a case-based row written at 0002 keeps its cases through the rename",
`apps/server/src/persistence/migrations.test.ts`). Both sites are called
out as frozen history in the source. Nothing in the active contract, store, briefing,
MCP surface, fixtures or docs uses the old wording.

### Verification actually run for the naming change

**Automated.** `bun run test` — 149 tests, 0 failures, of which 70 are the real-SQLite
persistence and briefing subset (`bun run test:persistence`). `bun run typecheck`,
`bun run build` and `bun run lint` pass; `bun run format:check` reports
`sprint-roadmap.html` only, which was already failing before this change and was left
alone.

Two migration tests were added for the path the development file actually takes
(`migrations.test.ts`, "a database already at 0002"): a database brought only to `0002` by the real migration
bodies, then migrated, keeps its observation, its idempotency receipt and its sequence
cursor and reaches the renamed schema; and a case-based row inserted in `0002`'s
vocabulary comes through `0003` as `record_format = 'case_based'` with its `setup` and
`cases` intact. The existing "upgraded schema equals fresh schema" test now covers all
three migrations.

**On the development database.** `apps/server/.runtime/hunt.sqlite` was backed up, then
migrated through the store's own automatic acquisition path:

- `0003` applied alone; the journal reads `1_delegation_memory_slice`,
  `2_observation_cases`, `3_observation_record_format`.
- All eight observations survived. The six prose records are `record_format = 'summary'`,
  the two multi-case ones are `'case_based'`. A SHA-256 over every carried column of all
  eight rows is **identical before and after** the migration
  (`93573d9290022e6abb4e3b154685b8232d1f3c314683c9f9c3d56fc6a322a1ea`), so no field was
  reformatted, reparsed or re-attributed — only the column it lives in was renamed.
- All eight command receipts and the sequence cursor at 8 are untouched, so every stored
  idempotency receipt still resolves and a replayed operation ID still cannot write twice.
- A second startup applied nothing, confirming the rebuild does not run twice.
- Reading the intent back through the store returns `{"caseBased":2,"summary":6}`, and the
  rendered briefing is 24,936 characters with six `RECORD FORMAT: summary` headings and no
  occurrence of the old wording.

**Not run.** No live worker and no `opencode` session for this change: it renames
identifiers and one column, and the §21 live proof above already exercised both formats
end to end. The old observations were not re-derived or re-recorded.

### `FIX` — the MCP endpoint serves only the stateless 2026-07-28 revision (2026-10-20)

The operator asked whether `v2026_07_28` could replace `v2025_06_18`, and whether it is
the stateless revision. It is: `McpProtocol.v2026_07_28` is typed
`ProtocolAdapter<"2026-07-28", StatelessRuntimeDescriptor>`
(`effect/src/ai/McpProtocol.ts:211`) and is the **only** stateless adapter in the module —
`2025_11_25`, `2025_06_18`, `2025_03_26` and `2024_11_05` are all stateful. Its own
documentation: "this revision uses request-scoped metadata instead of initialization and
protocol-level sessions".

Decided: serve that revision and nothing else (`apps/server/src/mcp/server.ts:139`). The
runtime can serve stateless and stateful adapters side by side — `admitHttp` selects per
request — but a fallback path nobody intends to use is a second code path to keep honest,
and §21's naming round is a fresh reminder of what unused compatibility surface costs.

**What the revision moves onto every request.** There is no handshake and no session, so
each POST carries its own envelope, and the runtime refuses each omission with its own
400 (`effect/src/ai/internal/mcpRuntime.ts:280-320`): an `MCP-Protocol-Version` header, a
`params._meta` carrying `io.modelcontextprotocol/protocolVersion` matching that header and
`io.modelcontextprotocol/clientCapabilities`, an `Mcp-Method` header matching the JSON-RPC
method, and for routed methods an `Mcp-Name` header matching `params.name` (`tools/call`,
`prompts/get`) or `params.uri` (`resources/read`). Nothing is kept server-side between
requests, so there is no session table to expire or reconcile.

**The client must be pinned, and that is not optional.** OpenCode's remote MCP config
has a `protocol` field with three accepted values (`@opencode/schema`'s `Mcp.Protocol`),
and **its default is the handshake-based one**, which opens with `initialize` and speaks
revisions only up to 2025-11-25. `openCodeClient.ts` therefore sends
`protocol: "2026-07-28"` on the server config. `"auto"` was rejected: it probes and
silently falls back, and there is nothing to fall back to, so a misconfiguration would
surface as a confusing discovery failure instead of a loud one.

**`FIX` — an invalid payload is now a tool error, not a JSON-RPC error.** Under this
revision a schema-invalid `tools/call` returns HTTP 200 with `result.isError: true` and
the reason in `result.content[0].text` ("Invalid parameters for tool
'record_observation': Missing key at [\"cases\"][0]"), where the stateful revisions put it
in a top-level `error` object. The call is still refused and still writes nothing. The
test helper now reads both channels rather than assuming one
(`apps/server/src/mcp/server.test.ts`), because which channel carries a refusal is the
protocol's business and the assertion that matters is that the write did not happen.

### Verification actually run for the protocol change

**Automated.** `bun run test` — 158 tests, 0 failures (up from 151; the MCP suite is now
32). The suite's hand-rolled client was rewritten to the stateless envelope: the
`initialize`/`notifications/initialized`/session-id harness is gone, and seven new tests
pin the envelope rules themselves — a complete envelope is accepted and no session is
issued; a missing `MCP-Protocol-Version` is refused; `2025-06-18` is refused as
unsupported; a request with no `_meta` is refused; a `_meta` protocol version
contradicting the header is refused; an `Mcp-Method` disagreeing with the body is refused;
an `Mcp-Name` naming a different tool than the body is refused. `bun run typecheck`,
`bun run build` and `bun run lint` pass; `format:check` reports `sprint-roadmap.html` and
two files edited outside this change.

**Live, against the real client.** A throwaway probe registered the endpoint with a real
`opencode` **v2.1.0** server and polled `GET /api/mcp` for the connection status. No model
call and no provider credential are involved, so this isolates the handshake:

- Pinned to `"2026-07-28"`: `{"name":"bit","status":{"status":"connected"}}`, with **3
  authenticated requests** served by our endpoint — discovery completed over the stateless
  transport.
- **Negative control**, the same probe with the pin removed so the client used its
  handshake-based default: `{"status":"failed","error":"Error POSTing to endpoint:
{\"jsonrpc\":\"2.0\",\"id\":0,\"error\":{\"code\":-32020,\"message\":\"MCP-Protocol-Version
header is required\"}} (HTTP 400)"}`, with 1 request served and no discovery. The pin is
  load-bearing, and its absence fails loudly at connection time rather than mid-run.

**Not run.** No full `workerDemo` round trip on the new revision: that needs a live
provider session, and the handshake plus discovery is the part this change can break. A
worker run is the next thing worth doing against it.

### `FIX` — the harness client is OpenCode's generated Effect client (2026-10-20)

`openCodeClient.ts` previously hand-wrote six routes against the binary's OpenAPI
document, with a narrow Effect Schema per response. Its own header named the better
option and the reasons not to take it: `@opencode/client/effect`, the Effect client
OpenCode publishes from the same source as the server, "not installed, published against
its own Effect version". At the operator's direction it is installed now, and both
objections are addressed below.

`@opencode/client@2.1.0` and `@opencode/schema@2.1.0` are direct dependencies of
`apps/server`, matching the `opencode` binary version the demos spawn. The six routes are
`api.session.create`, `api.session.prompt`, `api.session.wait`, `api.session.get`,
`api.message.list` and `api.mcp.add`. Hand-written request builders and response schemas
are gone; URL construction and payload shapes now come from the same source as the server.

**`FIX` — the exact Effect peer forces a workspace override.** The package declares
`effect: "4.0.1"` as an exact peer, so bun installed a second copy alongside our 4.0.5.
Two Schema instances then interleave inside one decode and throw
`s.startsWith is not a function` from `SchemaAST` — a stack with `effect@4.0.1` and
`effect@4.0.5` frames in it. The root `package.json` now pins
`overrides: { effect: "4.0.5" }`; `@opencode/client`, `@opencode/schema` and
`@opencode/protocol` all resolve to the single copy. **Re-check that override on any
Effect or client upgrade** — the failure mode is a runtime type error inside a decode,
not an install error.

**What stayed ours, deliberately.** The service interface, its six operations and its
error taxonomy are unchanged, so every call site, demo and test still compiles against
the same contract:

- **The transport.** We build the `HttpClient` the generated client runs on, so the Basic
  credential, the base URL and the per-operation bounds apply to every call it makes,
  including operations we have not wrapped. `filterStatusOk` was _removed_ on purpose: the
  client reads non-2xx bodies to produce its own tagged errors, and pre-filtering would
  flatten `UnauthorizedError` and friends into a bare status.
- **The error taxonomy.** `fail` unwraps the client's `ClientError` one level and sorts
  the result with Effect's own predicates — `Schema.isSchemaError` to
  {@link HarnessDecodeError}, everything else to {@link HarnessTransportError}, with
  `HttpClientError.isHttpClientError` supplying the status. The §20 distinction holds:
  transport failure means the harness's state is _uncertain_, a decode failure means we
  are talking to something that does not answer the way this build expects.
- **The §20 cancellation and transport-bound guarantees**, unchanged, because they live in
  the `HttpClient` and in `bounded`, not in the request builders that were replaced.

**`FIX` — a decode failure may not carry a status.** `HarnessDecodeError.status` is now
`UndefinedOr(Int)`. The decode is the client's, and its `SchemaError` does not name the
response it came from. Reporting `HTTP 200` because that is the likely answer would be
inventing evidence, so the message says "the response body" when the status is unknown.

**Branded ids are applied at the boundary.** The client's types brand `Session.ID`,
`Model.ID`, `Provider.ID` and `AbsolutePath`. Our `ModelRef` and directory strings are
decoded through those schemas in `createSession` and `registerMcpServer` rather than cast,
so a bad value fails where it enters with its own value in the message. The MCP protocol
pin is now typed too: `protocol: "2026-07-28"` is a `Mcp.Protocol` literal on
`Mcp.RemoteConfig`, so a typo is a compile error rather than a connection failure.

### Verification actually run for the client replacement

**Automated.** `bun run test` — 158 tests, 0 failures. `bun run typecheck`,
`bun run build` and `bun run lint` pass; `format:check` reports `sprint-roadmap.html` and
two files edited outside this change.

The harness suite (31 tests) needed real updating rather than re-running, and what it
found is worth recording:

- Its stub answered the old narrow shapes. The generated client decodes the server's whole
  `Session.Info`, so the canned payload was replaced with one captured verbatim from a
  live `POST /api/session` against v2.1.0. The `{ data }` envelope is still what goes over
  the wire; the client decodes it and returns the inner value.
- **The routes it builds are byte-identical to the hand-written ones**, confirmed by
  recording every URL the stubbed transport saw:
  `/api/experimental/mcp/{name}?location[directory]=…`, `/api/session/{id}`,
  `/api/session/{id}/message`, `/api/experimental/session/{id}/wait`,
  `/api/session/{id}/prompt`. Path encoding is preserved — `ses/../admin` still arrives as
  `ses%2F..%2Fadmin`, so the traversal test stands unchanged.
- The credential still travels in the request body, never the URL, and the body now also
  carries `"protocol":"2026-07-28"`. Both asserted.

**Live.** A throwaway end-to-end probe drove the rewritten client against a real
`opencode` v2.1.0 server and our real MCP endpoint: `createSession` returned a session id,
`registerMcpServer` succeeded, `sessionStatus` and `messages` decoded, and
`GET /api/mcp` reported `{"status":"connected"}` with **3 authenticated requests** served
by our endpoint. No model call, so this isolates the client and the handshake.

**Not run.** No full `workerDemo` round trip, which needs a live provider session. The
prompt path (`api.session.prompt`) is exercised by the stubbed suite and by the URL
recording, but not yet by a real model turn.

### `FIX` — one control-plane listener, two routes (2026-10-20)

The MCP endpoint and the policy endpoint were two `Bun.serve` instances on two ports,
with two scopes and two hand-written request handlers. At the operator's direction they
are one listener: `ControlPlaneEndpoint`
(`apps/server/src/http/controlPlane.ts`) builds both route sets into one
`HttpRouter`, serves them from one port, and publishes `mcpUrl` and `policyUrl` off the
same origin.

**Why this is safe to merge, and why a router rather than a `fetch` handler.**
`McpServer.layerHttp` applies its bearer middleware to the **MCP protocol layer**, not to
the router. Routing happens by path first, and each route carries whatever admission its
own layer declared, so sharing a port does not pool the two postures:

- `/api/v1/mcp` still fails closed — no credential, an unknown one or an expired one is
  `401` before any protocol handling, tool list or dispatch.
- `/api/v1/policy/decide` is **deliberately unauthenticated**, at the operator's
  direction (`policyRoutes`, `policy/service.ts:176`). The hook that calls it is a plugin
  inside the harness process and stays credential-free. The cost is recorded rather than
  implied: anything that can reach loopback can submit a decision request and have it
  recorded, and the worker can read the URL because it is written into the
  `.opencode/opencode.json` in its own workspace. It cannot force an `allow` — the answer
  is computed from `PolicyConfig`, never from the request — so the exposure is a polluted
  in-memory audit list, not a bypassed gate.

What the router supplies that the replaced handlers did not: method handling, `415` on
the wrong content type, `406` on the wrong accept header, and origin checks. The policy
handler's `if (url.pathname !== … ) return 404` is gone.

**`SKIP` — the fixture keeps its own listener.** `fixture/server.ts` is the simulated
target under test. Putting it on the control plane's port would mean the worker probing
"the target" was probing our own origin, would collapse the pretence that it is a third
party, and would let a fixture fault take down the endpoint the worker needs in order to
record what it saw. The `/__fixture/*` controls are already marked "part of the fixture,
not of the system under test"; this is the same boundary. The health route in `main.ts`
is mergeable on the same terms but was left alone — it is a separate process from the
spike demos, and the operator asked for the two.

Consequences worth naming:

- `servePolicy` and `PolicyEndpoint` are gone. The recorded decisions moved to a
  `PolicyDecisions` service (`policy/service.ts:136`), because the handler and the demo
  that reads the audit now sit on opposite sides of one listener.
- One listener means one application layer, so `policyDemo` must now supply the MCP
  services even though it never calls a tool. Its store is `:memory:` on purpose: that
  probe writes no observations, and pointing it at the real database would put demo rows
  next to real evidence.
- `DEFAULT_POLICY` (`policy/service.ts:54`) exists for runs that name no boundaries:
  loopback only, no forbidden fragments. Deliberately not inventing constraints, which
  would make a run look more constrained than it is.
- Shared fate is real and accepted: a fault that wedges the listener now stops both
  surfaces, where previously a wedged MCP endpoint left policy answering.

### Verification actually run for the merge

**Automated.** `bun run test` — 166 tests, 0 failures (up from 158). `bun run typecheck`,
`bun run build` and `bun run lint` pass; `format:check` reports `sprint-roadmap.html` and
two files edited outside this change.

Eight of the new tests are `http/controlPlane.test.ts`, which asserts only what merging
created — each route's own behaviour stays in its own suite. The ones that matter are in
"the postures stay separate on the shared port" (`controlPlane.test.ts`): both URLs
resolve to one origin; an unrouted path on that port is a `404` rather than either route;
the MCP route is `401` without a credential and `200` with one; the policy route answers
`200` with no credential at all and still denies on its own boundaries; a bearer on the
policy route is ignored rather than required, and the policy route's openness does not
reach the MCP route. One more asserts that a policy decision does **not** increment the
MCP call counter, since that counter is what the demos cite as proof the worker reached
our tools.

**Live.** A throwaway probe registered the merged endpoint with a real `opencode` v2.1.0
server: both URLs reported the same port, the worker's MCP client reached
`{"status":"connected"}` with **3 authenticated requests served**, and a credential-free
`POST` to the policy route on that same port answered `200 {"effect":"allow"}` and was
recorded. No model call, so this isolates the transport and both admission paths.

**Not run.** No full `workerDemo` or `policyDemo` round trip, both of which need a live
provider session. The policy hook's own fail-closed behaviour is unchanged by this and
was proven in §19 Checkpoint 5.

---

## 22. Reliable single worker — control plane, recovery, and explicit follow-up

Recorded 2026-10-21, at the operator's direction, as one milestone in four parts. Nothing
below widens the architecture: no planner, no finding subsystem, no approval workflow, no
concurrency. The scope is still one worker, one attempt at a time, against the local
fixture.

### `FIX` — the health route is a route, and `main.ts` serves the control plane

§21 recorded the health endpoint as "mergeable on the same terms but left alone". It is
merged now. `GET /api/v1/health` is registered on the one router
(`healthRoutes`, `http/controlPlane.ts`) and published off the same origin as the other
two (`ControlPlaneEndpoint.layer`), and `main.ts` builds `ControlPlaneEndpoint` instead of its own
`Bun.serve` with a hand-written `fetch`. There is one router, one port and one shutdown
path in the server process too.

What that removed was a second, differently-behaved HTTP composition: the old handler
answered any method on the matched path and `404`'d everything else, with no content-type
or origin handling. The merged route gets the router's.

The three postures stay separate, and that is asserted rather than argued
(`controlPlane.test.ts`): health answers `200` with no credential and refuses a `POST`;
the MCP route is still `401` before any dispatch; the policy route still answers
unauthenticated and still denies on its own boundaries. Health is deliberately
**one word**: a liveness answer that reports store or harness state is a reconnaissance
surface, and one that fails when a subsystem is degraded cannot be used to tell "the
process is up" from "the database is slow". A test pins the response to exactly
`{"status":"ok"}` for that reason.

**`SKIP` — the fixture keeps its own listener**, unchanged from §21 and for the same
reasons: the simulated target must not be served from the control plane's origin, and a
fixture fault must not take down the endpoint the worker records through.

### `FIX` — the worker runs under the policy hook, not only a probe

The pre-execution gate was proven in §19 Checkpoint 5 by a dedicated probe and then not
used: `workerDemo` ran with no hook loaded, so the policy endpoint sat there answering
nobody while the run it was supposed to constrain went unenforced. The workspace
preparation that installs the hook is now shared (`prepareWorkspace`,
`spike/runtime.ts`) and on by default for any spike run (`SpikeOptions.policyHook`), writing the
plugin config against the live `policyUrl` before the harness spawns — expressed as a
layer dependency so the ordering is checked, not remembered.

`WORKER_POLICY` (`spike/phases.ts`) names boundaries that are real and narrow: loopback
only, and two forbidden fragments the task would never legitimately touch (our own
control-plane database, and anything marked out-of-scope). Deliberately not more:
constraints the task _does_ need would turn a misconfiguration into something that looks
like a boundary holding.

Every tool call the worker makes — including its own `record_observation` calls — now
round-trips to the control plane before it runs. The audit trail written by the hook is
the evidence, and it lands outside the workspace: a worker that can read its own audit
log can read the shape of the boundary it is inside.

### `FIX` — interrupted attempts are reconciled, and uncertainty is recorded as uncertainty

§20 recorded this as "the largest open gap", with two attempts in the development
database left at `status: "running"` and real session IDs nothing would ever settle.

The reconciler asks a **harness-status abstraction** (`recovery/harnessStatus.ts`) one
question per attempt and gets an answer that includes the cases where there is no answer.
Its vocabulary (`HarnessObservedStatus`, `harnessStatus.ts`) is seven values: the harness's own four, plus
`unbound` (no session was ever recorded), `missing` (we asked; it has never heard of it)
and `unreachable` (we could not ask). The query's error channel is `never` by design — a
reconciler that fails when the harness is unreachable has not reconciled anything.

`mapObserved` (`recovery/reconcile.ts`) sends all three of ours to `uncertain`. There
is no path from "we do not know" to a definite execution status, and in particular none
to `failed`.

The write rules live in one pure function, `decideRecovery`
(`persistence/store.ts`), so the whole state space is readable in one place and
enumerable in a test without a connection. Line references into our own files are given
as symbols from here on: this section has already been read against a moved line once.

- A `succeeded`/`failed`/`interrupted` attempt is **never moved**. A contradicting
  harness answer is still recorded, as `already_final`, because "we asked again and it
  said something else" is worth having.
- `uncertain` is terminal for _authority_ but refineable: a later definite answer refines
  it (`refined`), and an answer of "still running" does **not** reopen it
  (`unresumable`). Replacement work gets a new attempt identity
  (`openReplacementAttempt`, `store.ts`), which refuses a running predecessor, a
  predecessor from another target or intent, and any attempt id that is already in use.
- Leaving `running` is the one transition that revokes authority.
- **Every startup asks again about `running` and `uncertain`, and never about a settled
  attempt.** The sweep reads `unsettledAttempts`, not a running-only query; see the
  correction below, where it did not.

**`NEW` — write authority is fenced.** `attempts.write_fence` (migration `0004`) is the
attempt's authority epoch; a credential carries the value it was minted against
(`CallerContext.attemptFence`), and `checkAuthority` (`store.ts`) refuses a new write
whose fence has been superseded or whose attempt has stopped running. The in-memory half
is `McpCredentials.revokeAttempt` (`mcp/credentials.ts`), called by the reconciler after
the fence moves. Both exist
because they cover different windows: the registry is per-process and a restart forgets
it, while the fence is a column.

**Receipt semantics are preserved, deliberately, by checking the receipt before the
authority.** A matching receipt is answered even under revoked authority, because a
replay writes nothing and creates no external effect — it hands back a result this store
already committed, to the only caller whose scope can name it. Refusing it would make a
transport retry that crossed a settlement boundary look like lost evidence, which is the
one thing a worker must never be told wrongly. A _new_ write is where authority is
enforced, because that is where something would change. A conflicting reuse is still a
conflict.

`settleAttempt` is now guarded to `status = 'running'` and reports whether it changed
anything (`store.ts`), so the terminal-regression rule holds from the worker's side too:
a late settlement cannot overwrite what recovery decided.

**What is recorded, and what is not inferred.** `attempt_recoveries` keeps the harness's
answer verbatim, the prior status, the resulting status, the disposition, the fence
before and after, and the detail text. Its key is the whole reconciliation state
(migration `0006`; `0004`'s three-column key was wrong, and the correction below says
how), so repeating the same state updates one row rather than manufacturing history and
`times` keeps the repeat visible, while a pass that decided something different gets its
own row. `observations_at_recovery` is recorded as a fact about
our own store at that instant and is **never** an input to the disposition — it is even
read after the decision, for exactly that reason. A worker can issue requests against a
target and die before recording anything, and the target does not roll back.

No HTTP happens inside a transaction: the harness is asked, then one transaction writes.
One attempt is one ask plus one transaction, so the write lock is never held across a
network round trip or across several attempts.

### `FIX` — untested dimensions are addressable, and progress on them is explicit

An untested dimension used to be free text that reappeared in every briefing forever.
Nothing could say "that one, I took it on", so progress could only be guessed at by
matching words — and `briefingDemo` had to score lexical overlap and admit it was an
indicator only.

Each recorded dimension now has an address, `<observationId>#u<index>`
(`dimensionAddress`, `contracts/observation.ts`). The index is sound because `untestedDimensions` is
written once, inside the same transaction as its row, and nothing in this codebase
updates an observation afterwards — there is no `UPDATE observations` statement and no
path that rewrites the list. Parsing is strict (`parseDimensionAddress`): a non-canonical
index is refused, so one position cannot have two spellings. Hashing the text was
rejected — it would make two identically worded dimensions one address, and would change
identity if wording were ever corrected.

`RecordObservationInput` gains `addressesDimensions` (`contracts/observation.ts`,
`addresses_dimensions` on the wire). It is validated against stored state inside the
write transaction (`resolveAddress`, `store.ts`): the address parses, the observation
it names exists, that observation belongs to **the caller's authenticated intent**, and
the position is within the list that row actually holds. A duplicate in one call is
refused rather than collapsed. Links are rows in `observation_dimension_links`
(migration `0005`) with real foreign keys both ways, written in the
same transaction as the observation, so a half-linked observation cannot exist. There is
no fuzzy match anywhere and no inference from wording: an address a worker invents,
rewords or truncates is refused and nothing is stored.

**Addressed is not resolved, and there is deliberately no `resolved` value.**
`FollowUpStatus` (`contracts/briefing.ts`) is `uninvestigated`,
`addressedInconclusive` and `addressedWithEvidence`, derived from the recorded links and
outcomes alone (`statusOf`, `briefing/briefing.ts`). An `inconclusive` follow-up is work that
happened and decided nothing, which is a third state and not progress on the claim.
Deciding a question is settled is a disposition somebody has to take, and nothing here
takes it: closure authority is not implemented, and the rendered briefing says so in as
many words.

Questions are computed over **all** of the intent's observations, not just the ones a
briefing had room for, so truncating the body cannot drop a question; a question raised
or addressed by an omitted observation is labelled as such. They are **not** deduplicated
by text: two observations that recorded the same sentence recorded two separate
questions, and collapsing them would be exactly the matching this mechanism exists to
avoid — and would mean addressing one silently closed the other. Old rows keep their
dimensions and gain no links, so nothing is retro-fitted with a relationship nobody
recorded.

### `PORT` — one proof path, three entrypoints

`spike/phases.ts` holds the worker leg and the planner leg as functions;
`workerDemo.ts`, `briefingDemo.ts` and `milestoneProof.ts` all drive them. A proof that
re-implemented the worker leg would be proving its own copy.

**A hazard worth recording, because it cost a run.** Every entrypoint in `src/spike/`
calls `runMain` at module scope, so importing one _runs it_. The first version of
`milestoneProof.ts` imported a shared constant from `workerDemo.ts` and thereby ran the
worker demo concurrently with its own phase 1 — against the development database, since
that is `workerDemo`'s default — and then `process.exit`'d from the demo's teardown while
the proof's harness scope was still open, leaking a detached `opencode serve` that had to
be reaped by hand. Nothing was lost (one extra attempt and two observations landed in
`hunt.sqlite`, and the two abandoned rows were untouched), but the fix is structural:
nothing imports an entrypoint, everything reusable lives in `phases.ts`, and each
entrypoint now says so at the top.

### `FIX` — correction round after review (2026-10-21)

The four parts above were reviewed and four defects came back. Each was a real fault in
the code, not a wording problem, and each is fixed here with tests against a real SQLite
file rather than an argument about why it was tolerable.

**1. `openReplacementAttempt` was not atomic, and believed what it found.** It read the
predecessor, called `seedAttempt` — which is one transaction — and then wrote
`replaces_attempt_id` in a separate statement outside it. A failure between the two left
a replacement attempt that recorded nothing about what it replaced, which is
indistinguishable from a worker simply starting fresh. Worse, `seedAttempt` inserts with
`ON CONFLICT DO NOTHING`, so an `attemptId` that already existed — another intent's
attempt, somebody else's predecessor — came back as a successful seed and was then
relinked. Nothing checked that predecessor and replacement shared a target and an intent
either, so the link could assert a continuity that did not exist.

It is now one transaction containing every check and one purpose-built `INSERT` that
carries the link as a column of the new row. It takes a dedicated `ReplacementInput`
rather than `SeedInput`, because a replacement is opened under the goal and intent the
predecessor already belongs to and has no business re-declaring either; the new row hangs
off the predecessor's own `intent_id`. Four refusals, none of which writes anything: no
such predecessor, a predecessor still `running`, a predecessor from a different target or
intent, and an `attemptId` already in use. That last one is deliberately **not**
idempotent — an existing attempt is never adopted, because a replacement is new work and
needs an identity nothing has written under.

**2. `attempt_recoveries` conflated dispositions.** `0004` keyed the table
`(attempt_id, observed_status, resulting_status)`. Settle a running attempt whose harness
says `succeeded` and the pass is `settled`, `running -> succeeded`, fence `0 -> 1`; ask
again and the pass is `already_final`, `succeeded -> succeeded`, fence `1 -> 1`. Those
three columns are identical, so the second upsert landed on the first row: the persisted
`disposition` stayed `settled` over a `detail` text that said `already_final`, and the
caller was handed the first pass's fence movement as if it were its own.

Migration `0006` rebuilds the table keyed by the whole reconciliation state —
`(attempt_id, observed_status, prior_status, resulting_status, disposition, fence_before,
fence_after)`. Repeating that exact state still increments `times`; a pass that decided
anything different gets its own row. Because the fences are part of the key, the row
`recordRecovery` reads back is the row it wrote, so what a caller is told and what the
table holds cannot drift apart. `RecoveryOutcome` gained `priorStatus` for the same
reason: "running became uncertain" and "uncertain stayed uncertain" are different events
and `status` alone cannot tell them apart.

`0004` is applied and stays untouched; `0006` appends. Every existing row is carried
across with its `times`, timestamps, fences, detail and disposition, and `prior_status`
is **derived rather than guessed**: `already_final` can only have been decided about an
attempt already in its resulting status, `refined` and `unresumable` are only reachable
from `uncertain`, `still_running` and `settled` only from `running`, and a disposition of
`uncertain` is told apart by the fence, which moves exactly when an attempt leaves
`running`. A disposition nothing writes is carried across as `prior_status =
'unrecorded'` rather than filed under a status it may not have held. What the migration
does **not** do is un-conflate a row the old key already merged: a `settled` row with
`times = 2` whose second pass was really `already_final` arrives as recorded, because
splitting it would mean inventing the `first_reconciled_at` the overwrite destroyed.
**There is no such row here**, which was checked rather than assumed, on copies of the
files and read-only: the development database holds two recovery rows, both single
settles with the fence moving `0 -> 1`, and the only repeated row in the proof evidence
(`times = 2`) is a `still_running` pass, which the new key keeps as one row anyway. The
preservation and derivation paths are therefore proven by `migrations.test.ts`, which
builds a database at `0005` with one row per disposition, the conflated case
included — and not by the live files.

**3. An `uncertain` attempt could not be refined in practice.** The rules allowed
refinement and a test exercised it, but only by calling `recordRecovery` directly. The
startup sweep read running attempts, and the first pass moved the row out of `running` —
so no later startup ever looked at it again, and a harness that came back with a definite
answer had no way to deliver it. The sweep now reads both statuses no answer has been
reached about (`unsettledAttempts`, and the sweep is `reconcileUnsettledAttempts`); the
old names said something the code did not do. Final statuses are never swept. The two
statuses are named in the query rather than derived as "not final", because they are
exactly the two `decideRecovery` has rules for — a row holding anything else is left
alone instead of being read as `running` and moved.

What the widened sweep may and may not conclude is unchanged: `uncertain` plus a definite
answer is `refined`, and `uncertain` plus a harness reporting the session live is
`unresumable` — the fence stays where it was, the session still cannot write, and
carrying the work on means a new attempt identity.

**4. The word, and the stale references.** The removal recorded in §21 had left four
prose occurrences describing OpenCode's `protocol` field by quoting its default value;
they are rephrased to describe the behaviour instead (the handshake-based default, which
speaks revisions only up to 2025-11-25 — `@opencode/schema`'s `Mcp.Protocol`). A
case-insensitive search of the repository, excluding dependencies, build output and
`.runtime/`, now returns **12 lines — 18 identifier occurrences — and nothing else**:
11 lines in `migrations.ts` (the three columns `0002` created, in its `CREATE TABLE`, its
two `CHECK` branches and its `INSERT` list, plus the `SELECT` in `0003` that reads them)
and one line in `migrations.test.ts`, the row written in `0002`'s vocabulary to prove
`0003` maps it rather than dropping it. Those are identifiers in applied migrations, and
the append-only rule is what freezes them.

Separately, this section cited line numbers into our own files and the review was read
against several that had moved. References to our own code are symbols and paths from
here on; the numeric ones that remain (`mcp/server.ts:139`, `store.ts:291`,
`migrations.ts:246`, `contracts/observation.ts:404`, `policy/service.ts`) were re-checked
against the files.

### Verification actually run for the correction round

**Automated, uncached.** `bun run test --force` — **231 tests, 0 failures** (220 before
this round). `bun run test:persistence --force` — **128** of those against real SQLite
files (117 before). `bun run typecheck --force`, `bun run build --force` and
`bun run lint` pass; `format:check` reports only `sprint-roadmap.html`, which is
pre-existing and untouched.

The 11 new tests are the four objections, each pinned where it can actually fail:

- **Replacement**: a trigger that aborts the insert proves the transaction leaves
  nothing behind — no replacement row, no attempt that exists without saying what it
  replaced — and that the same call succeeds once the trigger is gone, with the link
  intact after a reopen; an `attemptId` that already belongs to an unrelated attempt is
  refused and that
  attempt is untouched; a predecessor from another intent, from another target, and one
  that does not exist are each refused with no row written; a refused replacement of a
  running attempt leaves no half-seeded row and does not relink the predecessor; an
  `uncertain` predecessor can be replaced and keeps its own status and fence.
- **Recovery identity**: a settle followed by an already-final pass with the same
  observed and resulting status produces two rows with their own dispositions and fences,
  and every returned outcome is compared field by field with the row that holds it; three
  sweeps with one answer produce two states and `times = 2` on the repeat, in first-seen
  order.
- **Migration `0006`**: a database taken to `0005` by the real migration bodies and
  loaded with one row per disposition — including the conflated one and a disposition
  nothing writes — reaches the new key with every count, timestamp, fence and detail
  intact and the derived `prior_status` asserted row by row; the rebuilt key then accepts
  the pass the old one collapsed and refuses an exact duplicate; a fresh replay ends up
  with the same key; and a migration that fails after `0006` rolls back without taking
  the rebuilt table or its rows with it.
- **Refinement through the sweep**: `unreachable` and then `succeeded` across two
  ordinary startup sweeps with the database closed and reopened between them —
  `recordRecovery` is not called by that test at all — ending `succeeded`/`refined` with
  the fence still where the first sweep left it, and a third startup not sweeping it at
  all; plus an `uncertain` attempt the harness reports live, which is swept, recorded
  `unresumable`, and still refuses a write under its old credential.

**Not run.** No live model demo and no new live run: this round changed the control
plane's write rules, and the live evidence from the first pass
(`.runtime/milestone-proof-003637.log`, `.runtime/recovery-live-003300.log`) is left as
recorded. The development database was not touched — migration `0006` has not been
applied to it, and will be by whatever opens it next. Nothing was committed.

### Verification actually run for the first pass

These are the figures from the first pass, before the correction round above. `bun run
test` — **220 tests, 0 failures** (up from 166), stable across three consecutive runs.
`bun run test:persistence` — 117 of those, every one against a real SQLite file.
`bun run typecheck`, `bun run build` and `bun run lint` pass; `format:check` reports only
`sprint-roadmap.html`, which is pre-existing and untouched.

`recovery/reconcile.test.ts` — 30 tests then, 37 now — runs against real SQLite with a
scripted harness. The harness is scripted on purpose: `missing` and `unreachable` are
the answers a live harness will not produce on demand, and a recovery path exercised
only on the
answers you can arrange is the one that breaks later. They cover every mapping, the
no-regression rule across the whole `(current, proposed)` space, refinement of
`uncertain`, the refusal to reopen it, the idempotent repeat (one row at `times = 2`
then; two rows with the repeat on the second since `0006`), stale
authority on a live attempt, stale authority surviving a reopen of the file, credential
revocation being per-attempt, replay still working after settlement, replacement attempt
rules, and the live adapter's own 404-versus-no-status mapping with a stub client.

`persistence/store.test.ts` adds the address rules: a valid address becomes a link with
the position it resolved to; a non-existent observation, an out-of-range index, a
malformed address, a cross-intent address and a duplicate in one call are each refused
with nothing written and no sequence gap; an exact retry replays and writes no second
link; a changed address list under one operation ID is a conflict; links survive a
reopen. `briefing.test.ts` adds the three statuses, the sibling dimension that is _not_
swept along, and the question raised by a truncated observation that is still listed and
labelled. `migrations.test.ts` replays the chain from nothing — six entries since
`0006` — adopts a first-slice database, and still proves rollback, with the deliberately
broken migration
appended past the real chain (`0007`) rather than colliding with it.

**Live, on this stack** (`opencode` v2.1.0, subscription OAuth, `@opencode/client` 2.1.0,
`effect` 4.0.5):

- `src/spike/milestoneProof.ts`, four phases in four scopes:
  **22/22 exact checks passed** (`.runtime/milestone-proof-003637.log`). Phase 1: a real
  worker made 25 HTTP requests against the fixture under the loaded hook, every tool call
  decided by the control plane first, 5 authenticated MCP requests served, 2 observations
  persisted and provenance-bound, attempt settled `succeeded`, credential stopped
  resolving. Phase 2: a new process and session, given only the database-derived
  briefing, cited both observation IDs and one real address and invented none, answering
  all five sections. Phase 3: a second worker took on
  `obs_000002_…#u0` by address from a third process; the link was recorded, the question
  moved `uninvestigated -> addressedWithEvidence`, the addressing observation and its
  outcome are shown, the other eight questions stayed open, and it raised a sharper new
  one. Phase 4: the abandoned attempt was reconciled, both settled attempts were
  untouched, and a repeated sweep produced `times = 2` on one row.
- **The development database's two abandoned attempts are reconciled**, through
  `recordRecovery` and nothing else (`.runtime/recovery-live-003300.log`). Backed up
  first, byte-identical plus a `VACUUM INTO` copy, under `.runtime/backups/`. A freshly
  spawned `opencode serve` **still knew both sessions** — opencode persists them — and
  answered `succeeded` for `ses_eac55532…` and `interrupted` for `ses_eac54aad9…`. So
  both became `settled` with definite statuses, fence `0 -> 1`, and both hold zero
  observations: an attempt that recorded nothing was still recorded as having succeeded,
  because the harness said so and because absent evidence is not evidence of absence. The
  other five attempts were not touched.
- **The uncertain path, end to end**: `main.ts` against a _copy_ of that database with no
  harness configured answered `missing` for both sessions and settled them `uncertain`
  with the fence bumped, before serving — which is also the adoption path, since it
  applied only migrations `0004` and `0005` to an already-`0003` file.
- **Fail-closed, re-proven on this harness version.** The hook source is unchanged from
  §19, but "a thrown `execute.before` refuses the call" is the harness's behaviour, not
  ours. With the policy URL pointed at a dead port: the read was denied, the denial cited
  connectivity, the marker never reached the model, and the hook logged
  `denied_failclosed`.
- The server entrypoint, by hand: `200 {"status":"ok"}` on health, `401` on MCP with no
  bearer, `200 {"effect":"allow"}` on the unauthenticated policy route, `404` off-route —
  all on one port.
- No `opencode serve` was left behind by any of it.

### `FIX` — the briefing is stable under append, and planner rounds share a cache lineage (2026-10-21)

Two changes with one motivation. A briefing is already a pure function of stored rows, so
two planner rounds over unchanged state render identical text — but nothing made the
_growth_ of that text append-only, and nothing made two rounds reuse a provider's cached
prefix even when it was.

**What the rendering did wrong.** The graph sequence sat on line 3 and the observation
count sat in the first heading, both above every observation. `preparedAtSequence` comes
from the global cursor, which any observation write under any intent bumps, so a number
roughly forty tokens into the prompt changed whenever anything was recorded anywhere. And
observations were rendered newest-first, so a new row changed the _top_ of the list.
Between them, one write invalidated the whole document.

Selection and presentation are now separate decisions. `buildBriefing` still chooses
newest-first — a later observation qualifies an earlier one, and that is what should
survive truncation — and then renders the chosen rows oldest-first. Everything that
restates the record as a whole moved below a named heading, `PREPARATION_HEADING`: the
sequence, the counts, the disclosed omissions, and the open questions with their
statuses. So the text above that line grows by whole observation blocks and never
rewrites the ones already there, and `stablePrefixOf` is how a caller or a test gets
exactly that part. The property is asserted on bytes, not on "the same strings appear
somewhere", because the failure mode is a well-meaning edit that moves a count upward.

**Why a lineage, and what it is not.** OpenCode derives one provider cache key per
session lineage — `parentID ?? fork.sessionID ?? id` (`core/src/session/affinity.ts`),
sent as `prompt_cache_key` and as the `x-session-affinity` header
(`core/src/session/model-request.ts`). Two separately created top-level sessions
therefore never share a cached prefix however identical their prompts, which is what
`runPlannerPhase` was doing on every round. It now opens each round under one anchor
session per target, recorded in `planner_lineages` by migration `0007`.

Three things this deliberately is not. It is **not** a persistent planner: each round is
still a fresh session with no transcript, the anchor is created and never prompted, and
a child is not a fork — only the fork path copies messages across
(`core/src/session/projector.ts`). Keeping it that way is the point, because a planner
that remembered its own earlier rounds would hold investigation state that no observation
records, which is the transcript-derived knowledge §17 exists to refuse. It is **not**
applied to worker sessions: OpenCode resumes only parentless sessions after a crash
(`SessionStore.listSuspended`, which filters `isNull(parent_id)`) and merely releases a
child's claim, so a worker — whose interruption we reconcile and whose session the
harness may legitimately resume — stays top-level. And the table holds **no knowledge**:
drop it and every briefing and observation is unchanged, which is asserted rather than
asserted-to-be-obvious.

A recorded lineage is a hint, not a fact. It names a row in OpenCode's storage, which can
be cleared without ours changing, so `runPlannerPhase` confirms the session before using
it and records a replacement when it cannot. The cost of being wrong is one uncached
round.

**What this does not buy.** Prompt caching on the OpenAI path is implicit: OpenCode skips
breakpoint injection for protocols that ignore inline hints (`packages/ai/src/cache-policy.ts`),
so there is no explicit cache write and nothing here extends an entry's lifetime. A
provider's implicit cache expires in minutes, and a planner round separated from the last
one by a worker phase will miss whatever we do. The lineage makes a hit _possible_ for
rounds close together; it does not make one certain, and no claim here rests on a measured
hit rate, because none was measured.

### Verification actually run for the briefing-stability change

**Automated, uncached.** `bun run test --force` — **241 tests, 0 failures** (231 before
this change). `bun run test:persistence --force` — **136** against real SQLite files (128
before). `bun run typecheck --force`, `bun run build --force` and `bun run lint` pass;
`format:check` reports only `sprint-roadmap.html`.

The 10 new tests:

- **Prefix stability**: a briefing rendered after another observation lands starts with
  the previous briefing's stable part byte for byte, with the growth and the changed tail
  both asserted so the check cannot pass vacuously; nothing above the heading mentions
  the sequence, the counts, the omissions or the questions, while the tail still carries
  all four; and the honest limit — once the truncation window slides, the stable part is
  rewritten from its first block, which the test asserts rather than hides.
- **Ordering**: truncation keeps the newest rows and lists them oldest-first, with the
  omitted id named; the upgraded-database briefing has the adopted summary-format row
  leading and the case-based one following.
- **The lineage, against real SQLite**: an unrecorded target answers `undefined` rather
  than failing; a recorded lineage survives a reopen and is per target; recording again
  replaces the row instead of adding a second, checked directly against the file; and
  deleting the whole table leaves `observationsForIntent` byte-identical.
- **Migration `0007`**: a database at `0006` gains exactly one table, keyed on
  `target_id`, arriving empty, with every other table unchanged.
- **The wire**: a parent session id reaches `session.create` as `parentID`, asserted on
  the request body rather than on our own input; and a parentless create sends
  `parentID: null`, because the generated client encodes an absent optional as an
  explicit null — which the first version of this note got wrong until the body was
  printed.

**Not run.** No live model demo, so no measured cache hit: the harness reports
`tokens.cache.read` per session and `PlannerPhaseResult` does not yet surface it. The
development database was not touched; `0007` is pending for it. Nothing was committed.

### Remaining limitations

- **The abandoned-attempt leg of the proof lands on `still_running`, not `uncertain`.**
  A restarted `opencode serve` knows the sessions a previous one created, which is good
  news and means the live runs never needed the uncertain path. `uncertain` is proven by
  the deterministic tests and by the no-harness run above, not by a live harness that had
  genuinely forgotten a session.
- **The worker's tool catalogue is wider than what we register.** The spawned harness
  reads the user's own opencode configuration, which on this machine declares other MCP
  servers; the audit shows our gate deciding on one of their tools too. That the gate
  covers them is the property that matters, but we do not control what is in the
  catalogue, and a globally configured server named `bit` sits one character away from
  colliding with our per-attempt `bit-<attemptId>` registration.
- **The hook's coverage limit is unchanged** and must not be restated as broader: it
  gates tool _input_, and a shell command that assembles a forbidden path at runtime
  still reaches the file (§19 Checkpoint 5 probe 4). Not re-tested here.
- **One worker, one attempt at a time.** The fence and the per-attempt revocation are the
  primitives concurrency will need, but nothing here runs two workers, and the
  same-workspace MCP registration hazard is unchanged — `api.mcp.add` is a runtime
  registration and does not persist into the workspace config, which is why repeated
  phases did not accumulate stale servers, but two _concurrent_ attempts in one workspace
  would still be registering into the same harness.
- **`observations_at_recovery` is a number nobody should reason from**, and the only thing
  stopping that is a comment and a test. There is no type-level guard against a future
  caller treating it as evidence.
- **An `uncertain` attempt is asked about at every startup, for ever.** There is no
  backoff, no attempt limit and no way to mark one as "stop asking": each sweep adds a
  `times` increment to one row. That is cheap and visible, but it is an open loop, and a
  deployment that accumulates unanswerable attempts will sweep all of them on every
  start.
- **A recovery row written before `0006` keeps the disposition it was recorded with.**
  No database here holds a conflated one, but the migration cannot repair one if it
  arrives: the overwritten `first_reconciled_at` is gone and nothing invents it. The new
  key prevents it recurring.
- **The replacement attempt's id check is a read in the same transaction, not a lock.**
  Two concurrent opens of the same id both find it free and the second fails on the
  primary key, so it surfaces as a `DatabaseError` rather than the `MutationError` a
  sequential caller gets. Nothing is written either way, and nothing runs two
  openers today.
- **A dimension address is positional, and that is only sound while observations are
  immutable.** Nothing updates one today. Anything that ever edits, merges or rewords a
  recorded dimension needs its own identity scheme rather than this one stretched to fit.
- **`addressedWithEvidence` is derived from outcomes, not from judgement.** A follow-up
  that cites an address and reaches a positive result relative to its _own_ narrow claim
  moves the question, whether or not that claim really bears on it. Phase 3's semantic
  check exists because nothing automated can make that call.
- **Nothing closes a question or validates an observation**, by design: no finding
  subsystem, no approval workflow, no closure authority. A briefing says what has been
  recorded, and a human decides what it means.
- **Prefix stability ends where truncation begins.** With more than `limit` observations
  under one intent, each new row drops the oldest included one and rewrites the stable
  part from its first block. Nothing is lost from the graph and the omission is disclosed
  as always, but the append-only property covers the growing phase only.
- **No cache hit has been measured.** The lineage makes one possible and the rendering
  makes one worth having; whether either pays off on a real run is unknown, because no
  live round has been executed since the change and `tokens.cache.read` is decoded but
  not reported.
- **A lineage row can point at a session the harness has forgotten.** It is confirmed
  before use and replaced when it cannot be, so the failure is one uncached round — but
  the row is stale in the meantime and nothing cleans it up on a schedule.

## 23. Two tiers, the graph written through the store, and one transaction per mutation

Recorded 2026-10-21, at the operator's direction, as the Sprint 02 slice. Nothing below
widens the architecture: there is still no planner loop, no finding subsystem, no
concurrency and no UI, and nothing yet _consumes_ an event or an outbox row — this slice
writes them and the next one reads them. The scope is still one worker at a time, and now
one served target at a time.

### `FIX` — an untested dimension is a row, and the address becomes a wire alias

§22 recorded the limit this removes: a dimension address is positional, which "is only
sound while observations are immutable", and anything that ever edits, merges or rewords a
recorded dimension "needs its own identity scheme rather than this one stretched to fit".
Migration `0008_observation_dimensions` is that scheme.

`observation_dimensions(id, observation_id, position, text, created_at)` is backfilled by
unnesting each observation's stored `untested_dimensions` array with `json_each`, whose
`key` column is the array index as an integer. `json_each` is available in the SQLite
`bun:sqlite` links — 3.53.4 on this machine, checked before the migration was written
rather than after — so the backfill is one `INSERT ... SELECT` and every existing
dimension keeps the identity its address already implied.

**The ids are random, and that is the entire point.** `dim_` plus sixteen random bytes,
not `obs_…#u1` and not anything derived from `(observation_id, position)`: an id that
encoded the position would make position the identity again and the table would be
decoration. `created_at` is the raising observation's own `recorded_at`, not the
migration's clock, because the dimension was recorded when its observation was and
stamping it "now" would make every backfilled row claim to have been created during an
upgrade.

`observation_dimension_links` is rebuilt onto `dimension_id` — a table rebuild in the
manner of `0006`, because SQLite cannot change a foreign key in place. It **drops**
`source_observation_id` and `dimension_index`, which are now the dimension row's own
columns; keeping them would be a second answer to a question that already has one, which
is the argument `0005` itself makes about the intent column. `address` stays, verbatim as
submitted, because that is a fact about the request rather than derived state.

**The repoint joins with a `LEFT JOIN` into a `NOT NULL` column, deliberately.** A link
whose `(source_observation_id, dimension_index)` has no dimension row produces a `NULL`
`dimension_id` and aborts the whole migration; an `INNER JOIN` would have dropped that
link silently, which is the one outcome a repoint must not have. No such link can exist —
`0005`'s write boundary bounds-checked the index against the stored list — so this guards
against what we have not thought of, and `migrations.test.ts` manufactures one to prove
the guard fires. An `untested_dimensions` column holding a JSON scalar rather than an
array aborts the same way, on the `NOT NULL` on `position`.

**`<observationId>#u<index>` survives as the wire alias and nothing worker-facing
changed.** It is what a briefing prints and what a worker copies; `resolveAddress`
resolves it to a `dimension_id` on the way in, `parseDimensionAddress` still refuses a
non-canonical index, and `RecordObservationInput` is untouched.

The observation's `untested_dimensions` JSON column is still written and still read. The
two cannot disagree: `recordObservation` writes the rows from the same list inside the
same transaction as the observation, and nothing updates an observation afterwards. The
column is that observation's own immutable record of what it declared; the rows are the
addressable identities derived from it.

### `FIX` — an intent may declare the dimension it addresses, and `scheduled` is derived

Migration `0009_intent_dimension_provenance` adds one nullable
`intents.addresses_dimension`, referencing `observation_dimensions(id)`. A foreign key
whose default is `NULL` is the one kind `ALTER TABLE ADD COLUMN` accepts, so no rebuild is
needed. `NULL` means only that the caller did not say; it never means "this intent
addresses nothing".

It buys the three things §17 says it should. `scheduled` becomes **derived** rather than
stored: `dimensionSchedulesForIntent` counts the declaring intent's attempts in the two
statuses no definite answer has been reached about, and `statusOf` reports `scheduled`
only while that work is outstanding. Duplicate-intent detection becomes a join. And the
same-intent constraint in `resolveAddress` relaxes to _same goal, when the caller's own
intent declares that dimension_ — so an observation recorded under a **new** intent can
answer a question raised by a sibling one, which is a path no worker could close before.
Authority is still checked; it is checked against recorded lineage instead of an
assumption, and the caller's claim about its own intent is read from the row rather than
from the payload.

The relaxation is narrow in a way worth stating: a declaration authorises exactly the one
dimension it names. A sibling intent that declares position 0 cannot address position 1 of
the same observation, which `store.test.ts` pins.

**`scheduled` falls back to `uninvestigated`**, carrying `scheduledBy` so a reader can see
somebody tried. §17 requires that — "a state that can be entered and never left is a lie
with a long half-life" — and it is asserted on real rows rather than argued.

**One reading §17 leaves open, decided here: an intent with zero attempts is
`scheduled`.** The fallback is written as "once every attempt on the declaring intent has
settled", and zero attempts satisfies that vacuously. Reading it that way would publish
the question as open the moment a planner scheduled it, which is exactly the duplicate
round this column exists to prevent — so `attemptsOpen` is true for an intent that has no
attempt yet, and `attemptsTotal` of zero is how a reader tells "nothing dispatched" from
"everything finished". Its cost is in the limitations below.

### `SKIP` — dispositions wait for Sprint 07, and their id is not reserved

The dimension-disposition migration and the planner disposition tool are **not**
implemented.
§17 explains why: a planner round has no attempt to authenticate with, so there is nothing
for `checkAuthority` to validate, and the tool needs a planner loop to belong to. The
comment in `renderBriefing` that marks the text which changes when it lands is left where
it is, and the briefing still says in as many words that nothing here closes a question.

**So §17's reserved `0009` is not reserved, and the chain is contiguous.** The first pass
of this work gave provenance `0010` and left `0009` empty for dispositions, which looked
like a courtesy and was a trap. `latestMigrationId` is resolved **once per run, from the
journal of the database being migrated** (`effect/src/sql/Migrator.ts:243-249`), and every
resolved id at or below it is skipped (`:265`, `if (currentId <= latestMigrationId)
continue`); the loader sorts by id (`:410-423`, `Arr.sort(migrationOrder)`). A `0009`
written later would therefore apply **to a fresh database, in the correct position, and
never to a database already at `0010`** — the opposite of harmless. The two schemas
diverge, both journals report themselves as current, and nothing detects it.

Provenance was therefore renumbered to `0009` and the rest of this sprint's chain moved
down with it, while it was still safe: no database held `0008` or above, and no `.sqlite`
is tracked in git, so nothing applied was edited. Dispositions will take the next free id
when they are written. **An id is assigned when a migration is written, never reserved in
advance** — `MIGRATIONS` says so where the next author will read it.

`migrations.test.ts` also builds every "already at NNNN" fixture with `chainThrough(id)`
rather than by removing an entry from the middle of the record. The old arrangement only
worked while the removed entry was last, and would have manufactured exactly the
divergence described above.

### `PORT` — two tiers, with the migration runner iterating the registry from day one

`<HUNT_ROOT>/control.sqlite` holds the settings and the target registry;
`targets/<id>/hunt.sqlite` holds one target's graph, events and outbox; `targets/<id>/
evidence/` is created for blobs that stay out of SQLite. §3's three reasons are the
reasons: provable deletion, because `rm -rf targets/<id>/` is demonstrable where `DELETE`
plus `VACUUM` is not; scope isolation as a filesystem guarantee rather than a `WHERE`
clause we might forget; and size.

The control database has **its own chain** (`controlMigrations.ts`, `CONTROL_MIGRATIONS`),
numbered from `0001` again in its own journal, holding `targets`, `target_schema_state` and
`settings`. The two chains must never meet, and `FleetStore` is what keeps them apart by
being the only thing that opens either; `fleet.test.ts` asserts the control file holds no
graph table.

`FleetStore.migrateFleet` is the runner §3 says to build on day one. It iterates the
registry in registration order, skipping archived targets — whose directories may
legitimately have been deleted, and migrating one would recreate an empty file. Each
target's file is opened, migrated and **closed** before its state row is written to
control: no database is nested inside a transaction on another, and the directory creation
that precedes it is filesystem work, which §3 forbids inside a transaction body.

**A target id is a directory name, so it is validated before it reaches a path.**
`isTargetId` allows 1–64 characters of lowercase alphanumerics, hyphen and underscore,
starting with an alphanumeric — which excludes `.`, `..`, separators, a leading hyphen,
whitespace, the control file's own name, and case variants a case-insensitive filesystem
would fold onto an existing id. It is checked at registration and **again** on every open,
because a registry row can arrive from a file somebody edited. `fleetPaths` throws rather
than returning a traversing path, so a caller that ignored a typed refusal cannot get a
working path outside the fleet.

`targetStoreLayer` is the only sanctioned way to a target's graph: it validates the id,
asks the registry whether that target exists and migrated, and only then opens a file. A
caller cannot assemble a path and get a store.

**This process serves one target at a time**, named by `TARGET_ID` and registered on
demand. That is a deliberate stop short of what the layout allows, and the reason is
recorded in `main.ts`: dispatching an MCP request to the right target's store needs a
per-target store resolver at the mutation boundary, and the only motive for one is running
work against several targets at once — which is concurrency, and is not this slice. What
the layout buys today is real regardless, and is asserted: separate files, provable
deletion, per-target sequences, and no query path from one target's connection to
another's rows.

### `FIX` — a partial fleet migration serves what migrated and refuses the rest

The open question the brief names, decided: **serve the targets that migrated, mark the
rest unavailable, and fail startup only when the control database itself cannot be
migrated.** Four reasons, in order of weight:

1. The alternative couples availability globally, which throws away the isolation the file
   split exists to provide. One unreadable file would stop work on every unrelated
   engagement, and scope isolation as a filesystem guarantee is the thematic point of §3.
2. A failed migration is rolled back by the migrator's own transaction, so the file sits
   at its last completed id. That is a safe state to refuse to open and to retry from.
3. It is recorded rather than tolerated. `target_schema_state` holds the state
   `unavailable` with the failure text and the `applied_through` read from that file's
   own journal, and `huntFileFor` refuses the target by name quoting the failure. Nothing
   silently returns an empty graph for it, and `main.ts` prints the list to stderr.
4. Control is genuinely different. Without the registry there is no list of targets to
   serve, so there is nothing to degrade _to_; that case fails layer acquisition.

`applied_through` is per target rather than one global schema version, because two targets
can legitimately sit at different ids — one migrated cleanly and one failed half way up —
and a single number would be a lie about a fleet.

### `FIX` — asset identity is URL plus method, and role is not part of it

This resolves §17's `SPIKE` for the two kinds the fixture presents, and no more, because
an asset kind nothing records is an identity rule nothing has tested.

- **`host`** — `host:port`, lowercased, trailing dot removed, with the scheme's default
  port made explicit so `http://x` and `http://x:80` are one host. That is the narrow
  answer to §17's "duplicate representations of one host".
- **`endpoint`** — `METHOD scheme://host:port/path`, method upper-cased, path as `URL`
  normalised it, which resolves `.` and `..` and percent-encoding so one path cannot have
  two spellings.

**Query and fragment are excluded from identity.** Including a query string mints one
asset per parameter value, which turns an inventory of a surface into a log of requests and
makes any coverage denominator meaningless. The accepted cost is the other direction of
§17's warning: two endpoints differing only by a query parameter merge into one row. The
full URL as submitted is kept on every discovery record, so the distinction survives in
provenance even though it is not identity. ScopeWeaver's own rule is the same and carries
no role either — `uq_av2_endpoint ... ON assets(url, method) WHERE type = 'endpoint'`
(`scopeweaver/db/schema.sql:91`, read for the domain rule only; no code was copied). Its
host-shaped kinds key on the address alone (`:84`) or on the URL (`:88`), which is the
precedent for excluding the query string too.

**A trailing slash is two paths**, not one. A server is free to treat `/x` and `/x/`
differently, and merging them would be the over-normalisation §17 names.

**Role is deliberately not part of endpoint identity**, which is the second half of the
open question the brief poses. An endpoint tested as an administrator and as an anonymous
caller is one endpoint. Splitting by role would make the coverage denominator §17 warns
about lie — two assets where one exists — and would mean "we probed `/login`
unauthenticated" never counted as having touched `/login` at all. Role is a property of the
test rather than of the thing tested, and it is already recorded where it belongs, on an
observation's actors. Roles are also open-ended text, so using them in identity would mint
a new asset for every new spelling.

Enforcement is at the store level, not in a tool. `UNIQUE (target_id, kind, identity)` is
where the merge happens, so a second discovery of the same canonical identity cannot create
a second row even if a caller tries, and a `CHECK` pairs the kind-specific columns the way
`0003` pairs the two observation formats — a host cannot carry a method. The merge is
`ON CONFLICT DO NOTHING` followed by a read, so the schema decides identity rather than a
handler's control flow.

**`asset_discoveries` is append-only provenance, keyed `(asset_id, operation_id)`.** This
is §6's domain identity: two distinct operations may discover the same canonical asset, and
the right outcome is one asset with two discovery records. `created` and `replayed` are
separate booleans because they answer different questions — `created: false` with
`replayed: false` is a new command that found a known asset, which is new knowledge about
where it was seen and no new asset.

**`record_asset` is not an MCP tool.** That is the brief's first drop, taken: the identity
rules and the store-level enforcement are what matter, and the tool surface is a later
decision about what a worker should be allowed to assert.

### `PORT` — intent anchoring, enforced in the store

§4 calls this "the single most valuable idea here" and says to implement it before anything
else that writes to the graph. `addIntent` enforces it: an intent anchors only to a stored
observation, never to another intent, a goal or a hint, and an empty list is a new
top-level direction. `intent_anchors` is an edge table with real foreign keys both ways and
a `position`, so the order a caller gave survives — a first parent is usually where the
direction came from and the rest qualify it.

**The refusal is instructive, as §4 requires.** It names what the id actually is, says why
that kind cannot anchor, and gives the way to express a new direction. The schema does half
the work on its own: the foreign key is to `observations(id)`, so an intent id or a goal id
is refused outright; what it cannot check is the same-goal rule, which needs a two-table
join and is enforced in the write transaction.

**Why the store and not a planner tool.** Intents are planner-generated and a planner round
has no execution attempt, so `CallerContext` cannot be built and `checkAuthority` would
refuse every planner. The host creates intents as it does today, and the planner-facing
surface waits for Sprint 07. What this buys is that the rule cannot be bypassed by writing
an intent some other way, because there is no other way. The host's own authority is still
not the payload's: `HostContext` supplies the target, and the goal's own `target_id` is
checked against it.

**Two deviations from ScopeWeaver's rule, both because we have less, not more.** It
reserves anchoring for `confirmed` fact and finding nodes; we have no dismissal state and
no finding subsystem, so every stored observation is recorded evidence and anchorable —
including an `inconclusive` one, which is a real result about a real test. If a dismissal
state is ever added this check must gain it, which `0011`'s docstring says. And there is no
`hint` kind to refuse, so the refusal names the three kinds that exist here.

### `PORT` — the append-only event log, with the three identities kept apart

`events` is immutable rows, stable ids and a store-assigned monotonic per-target
`sequence`, decided at schema time as §3 requires rather than retrofitted. §8 is what the
sequence is for: a consumer reads committed events in ascending sequence order after its
cursor, and PubSub carries an advisory wake-up rather than the payload or the guarantee.
`eventsAfter` is that read, and it is explicitly **not** the durable consumer §8 describes
— there is no stored cursor, no acknowledgement, no wake-up and no catch-up sweep.

**The three identities are three sets of columns, not one `actor` string** (§6). Caller
authority is `caller_scope` with `intent_id` and `attempt_id`, all three `NULL` together
for a host-originated mutation — an honest absence rather than a fabricated attempt.
Operation identity is `operation` with `operation_id`, the same pair the receipt is keyed
on. Domain identity is `subject_id`, which is not a foreign key because it names rows in
several tables and a column pointing at one would be wrong for the others. The proof
asserts all three separately.

**Immutability is enforced by the database**, not by the absence of a statement: two
triggers raise on `UPDATE` and on `DELETE`, which is the argument §4 makes for putting the
per-kind state machine in a `CHECK` rather than in application logic. `migrations.test.ts`
proves both fire. The one thing they do not stop is a future migration that rebuilds the
table the way `0006` did, which `0012`'s docstring flags.

**Events and the outbox have separate counters**, and neither shares the observation
counter. Sharing would mean a transaction writing one event and one request consumed two
numbers, leaving the event sequence with gaps — and a gap is the one thing a consumer
reading `WHERE sequence > cursor` cannot tell apart from a loss. A refused mutation leaves
no gap either, because the bump is inside the rolled-back transaction; there is a test for
exactly that.

### `FIX` — sequences are per target, and nothing is renumbered

§8: "cursors belong to a particular target event log, not a global sequence across
independent target files." The file split delivers that for the observation counter with no
work, because `sequence_cursor` lives in the target's own file — which also removes the
coupling §22 flagged, where one global counter meant a write anywhere moved every
briefing's `preparedAtSequence`.

**Existing ids are not renumbered, decided on day one as the brief asks.** An observation's
id is `obs_<sequence>_<attemptId>` and every dimension alias a briefing has printed is
built from it, so renumbering per target would rewrite primary keys and invalidate
addresses already in circulation. Each file carries the counter it has, forward. The
visible consequence is that two targets both have an `obs_000001_…`, which is correct: an
observation id is unique within the target it belongs to, and the target is the file.

### `COPY` — the transactional outbox, and what it does not promise

`outbox` is a durable queue of side-effect requests, written in the same transaction as the
domain change that implies them, with `caused_by_event_id` a real foreign key to
`events(id)` — a request with no event behind it would be an obligation nobody can explain.

**`recovery_policy` is a column with a `CHECK`, not a default.** §6 requires an explicit
policy per effect type, and the four it names are the four allowed values. A dispatcher
with one blanket policy either loses work or repeats something unrepeatable. Each request
type's policy is declared once in `OUTBOX_RECOVERY_POLICIES`, not passed per call, so two
writers cannot disagree about whether the same remote action may be repeated.

Two request types, both grounded in an accepted §18 entry rather than invented to exercise
the mechanism: `asset.enrich` is §18's "deterministic asset enrichment with explicit
policy" and is `safe_to_retry`, because enrichment is a read of external state;
`notification.deliver` is §18's notification subsystem, which §18 says to build "using the
existing transactional outbox", and is `reconcile_first` — a notification is visible to a
person, and a crash between sending and recording the send leaves it genuinely unknown
whether it arrived. It is deliberately not `idempotency_key`, because no receiver is wired
and claiming a key the other side honours would be a claim about a system that does not
exist here.

**Adding an intent writes no outbox request, and that is a deviation from the brief's §2
worth stating plainly.** The brief says each of the three mutations writes "domain row,
receipt, event and outbox entry". A new intent implies no action outside this database: the
queue of intents _is_ the database (§4's atomic claim), not a side-effect queue. Writing a
request would make the outbox look more exercised than it is, and a mutation that was
_obliged_ to write one would be a design error — so this is also what demonstrates it is
not. The brief's own drop order permits "outbox entries for all but one event kind"; two of
three carry one.

**Sprint 02 writes `pending` rows and nothing moves them.** `status`, `attempts`, the lease
pair, `next_attempt_at` and `last_error` are declared now because §3's
append-only-at-schema-time argument applies to them and because a dispatcher that had to
add a lease column later would have to rebuild the table. They are inert here: claiming,
leasing, retry scheduling and delivery state are the next slice. `pendingRequests` is a
read and only a read.

**An outbox does not provide exactly-once remote execution**, which is unchanged from §6
and worth not drifting on: if a remote action succeeds and the process dies before
recording that, the outcome is ambiguous and no local row fixes it.

### `FIX` — one transaction per mutation, and the receipt is decoded rather than cast

Every mutation — `recordAsset`, `addIntent`, `recordObservation` — runs its receipt
lookup, its authority check, its validation, its domain writes, its receipt insert, its
event and any request it implies inside one `sql.withTransaction`. A refusal short-circuits
by failing _inside_ it, which rolls the whole thing back. So a conflicting retry writes no
event and no outbox row not because the code checks for one, but because there is no path
to the commit that is not committing everything.

**Receipt before authority, preserved from §22 and for its stated reason**: a replay writes
nothing and creates no external effect, so refusing it would make a transport retry that
crossed a settlement boundary look like lost evidence. A _new_ write is where authority is
enforced. The proof exercises both halves against the same attempt after its fence moved.

**The receipt's stored result is decoded through the operation's own schema.** One table now
holds receipts for three operations, so the single `RecordObservationResult` codec on the
query had to go; what replaced it is `replayResult`, which decodes through the codec the
caller names and reports a `StoredRowError` against the receipt when the stored JSON no
longer matches. What was deliberately not done is `JSON.parse(text) as A`, which §20
already records as not a typed boundary.

`hashRequest` covers the caller **and** the input, not the input alone: the receipt key
already namespaces an operation id to one caller scope, so this is the finer check that the
same id under a different attempt, session or worker is a different request rather than one
answered with provenance nothing recorded.

### `COPY` — `unknownField`

Implemented rather than dropped, because it is two lines of idea and the event log is
exactly what it is for: a payload is JSON written by whichever build recorded it, the set
of kinds and fields only grows, and a reader that threw on an unexpected field would turn
"this event has something extra" into "this consumer is stuck". A field that is absent,
null or of the wrong type reads as `undefined`, and the three are deliberately not told
apart — a caller that needs to distinguish them is reading a shape it should be decoding.
It is not a decoder and not a substitute for one; where a shape is ours and declared,
Effect Schema and a typed failure are still the answer.

### Verification actually run

**Automated, uncached.** `bun run typecheck --force`, `bun run build --force` and
`bun run lint` pass. `bun run test --force` — **290 tests, 0 failures, 1221 `expect()`
calls** (242 before this slice). `bun run test:persistence --force` — **185** of those
against real SQLite files (136 before). `bun run format:check` reports only
`sprint-roadmap.html`, which is pre-existing and untouched; `prettier --check` passes on
every file this slice changed. `git diff --check` is clean and **nothing was committed**.

The 48 new tests, each pinned where it can actually fail:

- **Migration `0008`, against a file the real migration bodies took to `0007`** and then
  filled with the shapes the backfill has to carry: three dimensions including one whose
  text would break a concatenated statement, one observation with an empty array, and one
  link in `0005`'s `(address, dimension_index)` shape. Asserted: one row per element in
  position order with the text byte for byte, the empty array contributing nothing, the
  raising observation's own `recorded_at` on every row, ids matching `dim_[0-9a-f]{32}` and
  containing neither the observation id nor `#u`, the link repointed onto the right
  dimension with its address and timestamp intact, the new primary key, and the two dropped
  columns gone. Plus both guards: a link whose dimension does not exist aborts the
  migration and leaves the journal at `7` with both links and the old columns intact, and a
  non-array `untested_dimensions` aborts it too.
- **Migration `0009`**: the column arrives `NULL` on an existing intent, accepts a real
  dimension id, and refuses one no dimension holds — so the reference is a live foreign
  key rather than a text column.
- **Migrations `0010`, `0012`, `0013`**: a host row carrying a method and an endpoint row
  without one are each refused by the `CHECK`; a duplicate identity within one target is
  refused and the same identity under a different target is accepted; a recorded event
  refuses `UPDATE` and `DELETE` and a duplicate sequence; an unknown outbox status, an
  unknown recovery policy and a request naming no event are each refused.
- **The fleet, against files on disk** (`fleet.test.ts`, 12 tests): the id rules, including
  that `fleetPaths` throws on `../..` rather than returning a traversing path; registration
  creating both directories and refusing a duplicate id; the registry and settings
  surviving a reopen; archiving being idempotent and skipped by the sweep; two targets
  migrated into their own files with a second sweep applying nothing; **the partial-failure
  policy produced by breaking one target's file for real** — `observations` replaced with a
  table `0002`'s rebuild cannot select, so the chain fails inside a real migration body
  rather than in a stub — with the sweep running to the end, the broken target refused by
  name quoting the failure, and its neighbours served; an unswept target refused rather
  than migrated by whoever opens it; a repaired target becoming available on the next
  sweep; two targets keeping their own rows and their own counters, with target A's intent
  and observations simply absent from B's connection rather than filtered out; `rm -rf` on
  one target leaving the other intact; and the control file holding no graph table.
- **Assets** (`store.test.ts`): the canonical endpoint identity with a second discovery
  merging onto it and both `discovered_as` values kept; a host identified by host and port
  across case, a trailing dot and an omitted default port, with a different port a
  different host; a trailing slash two paths, two methods two endpoints, and `..` resolved;
  role not part of identity, asserted as one asset with two discoveries; a relative URL, a
  scheme with no default port and an endpoint with no method each refused with no asset, no
  event and no obligation written; and an asset refused under a settled attempt.
- **Anchoring**: an empty list is top-level; two anchors keep the order given; an intent, a
  goal and an unrecorded id are each refused by what they are, with the instructive text
  asserted phrase by phrase; an anchor from another goal and a duplicate anchor in one call
  are refused; a goal from another target is `unauthorized` and a reused intent id is
  refused; and an exact retry replays while conflicting reuse is a conflict, leaving one
  anchor row and one event from three calls.
- **The relaxation**: a declaring sibling intent may answer the dimension and the link is
  recorded; an undeclared sibling may not; the declaration authorises exactly the one
  dimension it names and not the one beside it; a declaration cannot name a dimension of
  another goal; and a declaration naming no recorded dimension is refused.
- **One transaction**: one event per mutation in commit order with the three identities
  asserted separately and the two obligations naming their events; an exact retry of both
  an observation and an asset replaying with no second row, event, obligation or sequence
  number; a conflicting retry of both refused with the event and outbox lists compared
  field by field against their pre-call values; a refused mutation leaving no sequence gap
  for the next one to skip; events and obligations reading back in order after the file is
  closed and reopened, with the cursor read and the bound both exercised and the payload
  interrogated through `unknownField`; a superseded attempt refused across a restart, with
  reminting against the current fence still refused and the pre-fence replay still
  answered; and **a trigger that aborts the receipt insert** — the last write in the
  mutation — proving the asset, its discovery, the event and the obligation all disappear
  together, and that the same call succeeds once the trigger is gone.
- **`scheduled`** (`briefing.test.ts`): scheduled while the declaring intent's work is
  outstanding, with the sibling dimension untouched and the rendered group naming the
  intent; scheduled for an intent nothing has been dispatched for; **falling back to
  `uninvestigated`** once every attempt settled with no answer, still carrying the history;
  an addressing observation winning over the declaration, through the cross-intent path;
  and §22's prefix-stability property re-checked now that a fourth status exists.

**Live, in this environment.** `src/spike/persistenceProof.ts`, six phases: **23/23 exact
checks passed** (`apps/server/.runtime/persistence-proof-122609.log`, whose fleet is left
at `.runtime/persistence-proof-20261021112609/`). Two targets registered
and both migrated to schema `14`; asset, anchored intent and observation each in one
transaction with three events and two obligations; **two child processes genuinely killed
by `SIGKILL`** — signal asserted, not assumed — one between two mutations and one _inside_
an uncommitted transaction after a complete mutation had been handed to SQLite, with the
first surviving and the second leaving no asset, discovery, receipt, event or outbox row;
then a restart in which the events read back `1, 2, 3, 4` with the cursor read returning
only what follows, three obligations still `pending` with zero attempts, both abandoned
attempts reconciled `running -> uncertain` with the fence moved, provenance intact, target
B holding nothing and A's connection unable to reach a row under B's id; a replayed
operation id returning its committed result with no new event or obligation and the same id
with changed input refused; and the revoked credential refused twice over.

`src/spike/crashStep.ts` uses `process.kill(process.pid, "SIGKILL")` rather than
`process.exit`, a thrown error or an interrupt, because all three of those run finalizers,
which would close the database in an orderly way and prove nothing about a crash. It shares
one `SqlClient` with the store through `layerWithClient`, because two connections would
mean two transactions and the outer would block on SQLite's write lock rather than
containing the inner.

**The server entrypoint, by hand**, against a fresh `HUNT_ROOT`: the control chain applied
`1_control_registry`, `fixture-local` was registered on demand, the sweep reported it
`ready` at schema `14` listing all thirteen hunt migrations, startup reconciliation found
nothing unsettled, and the three route postures held on one port — `200 {"status":"ok"}` on
health, `401` on MCP with no bearer, `200` with a typed denial on the unauthenticated policy
route, `404` off-route. The directory tree afterwards was `control.sqlite` plus
`targets/fixture-local/{hunt.sqlite,evidence/}`.

**Not run.** No live model demo and no new live worker run: this slice changed the write
path and the file layout, and the live evidence from §22 is left as recorded. The
development database was not touched — migrations `0008` and `0009` through `0013` have not
been applied to it, and will be by whatever opens it next, which under the new layout means
it is no longer the file `main.ts` opens at all.

### Remaining limitations

- **The running server serves one target, not the fleet.** The registry is iterated for
  migrations and the files are genuinely separate, but `main.ts` opens exactly one target's
  store and the MCP boundary has no per-target resolver. Nothing cross-target has been
  exercised through the control plane, only through the store.
- **Nothing reads an event or an outbox row.** There is no durable cursor, no
  acknowledgement, no PubSub wake-up, no catch-up sweep, no claiming, no lease, no retry
  schedule and no dispatcher. `eventsAfter` and `pendingRequests` are reads that prove the
  rows are there and ordered; they are not the consumer §8 describes, and the outbox's
  execution columns have never held anything but their initial values.
- **The crash-window proof covers a transaction, not every interleaving.** One `SIGKILL`
  inside one uncommitted transaction after one complete mutation is strong evidence that a
  mutation cannot be half-written. It is not a search over kill points: nothing here kills
  between the event insert and the outbox insert specifically, or during SQLite's own
  commit, and no WAL-corruption case was manufactured.
- **An intent that declares a dimension and is never dispatched holds it `scheduled`
  indefinitely.** The fallback is keyed on attempts settling, and an intent with no attempt
  has none to settle. Nothing in this slice expires or garbage-collects such an intent,
  because nothing in this slice dispatches; a planner that created intents and failed to
  dispatch them would accumulate questions that look like work in flight.
- **Nothing stops a future author from reserving an id again.** The hole this sprint
  briefly opened was closed while no database held `0008` or above, and `MIGRATIONS` now
  says why ids are assigned rather than reserved — but that is a comment, not a check.
  `migrations.test.ts` asserts the chain it is given is contiguous and increasing; it
  cannot assert anything about a chain somebody intended, and a gap introduced once a
  database has passed it is not repairable.
- **Asset identity merges two endpoints that differ only by a query parameter.** Accepted
  for the reason recorded above, and visible in `discovered_as` rather than in identity. It
  will be wrong for a target that routes on a query string, and the fix is a new identity
  rule for a new kind rather than a widening of this one.
- **Asset identity has only ever seen the fixture's shapes.** Two kinds, loopback hosts and
  three paths. No IPv6 literal, no internationalised domain, no non-HTTP scheme beyond the
  refusal path, and no real target.
- **An observation's untested dimensions are stored twice.** The JSON column and the
  dimension rows are written from one list in one transaction and nothing updates an
  observation, so they cannot drift today — but it is two copies of one fact, and anything
  that ever edits an observation has to update both or the alias and the row will disagree.
- **A dimension id is random, so it is meaningless outside its file.** That is correct for
  per-target files and will need thought if a roll-up table in `control.sqlite` ever has to
  name a dimension across targets.
- **Anchoring cannot exclude a dismissed observation**, because there is no dismissal state
  and no finding subsystem. Every stored observation is anchorable. When either arrives,
  this check is a place that must change, and nothing enforces that it will be noticed.
- **The event-immutability triggers do not survive a table rebuild.** A future migration
  doing what `0006` did would drop them with the table, and only a docstring says so.
- **`register` is two commits, not one.** The directories are created and then the registry
  row is written, because filesystem work must not happen inside a transaction. A failure in
  between leaves a directory with no registry row — inert, and adopted by a re-registration
  — but the two are not atomic and nothing cleans up the orphan.
- **An unavailable target is retried only by another startup.** There is no backoff, no
  schedule and no way to ask for one target to be re-swept while the process runs.
- **The `0008` orphan-link guard is proven by a manufactured row.** No database in this
  repository holds one, which was checked rather than assumed; the guard's behaviour is
  therefore proven by `migrations.test.ts` and not by live data, exactly as `0006`'s
  conflated row was.
- **Nothing closes a question, still.** Dispositions are not implemented, so a brief only
  grows. `scheduled` narrows what a planner should act on but retires nothing, and the
  rendered briefing continues to say in as many words that nothing here settles anything.

## 24. Goal and planner flow — spike findings

Two investigations run on 2026-10-29 before the goal/planner slices, because the design
in `docs/design/goal-and-planner-flow.md` rested on two claims nobody had run. Both are
reproducible: `apps/server/src/spike/steeringProbe.ts` and
`apps/server/src/spike/mcpIsolationProof.ts`, with run logs under `apps/server/.runtime/`.

### 24.1 Mid-run prompt injection (Spike A)

### `SPIKE` resolved — a running session can be prompted again on both drivers, but only OpenCode keeps it inside one execution (2026-10-29)

Spike A of `docs/design/goal-and-planner-flow.md`. Decision 12 says steering "injects into a
live planner session". That is now measured on both drivers and **injection works on both**,
so the approved fallback — settle the round, open another one carrying the directive — is
**not needed** and is not designed here. What the measurement does change is the round
contract's _settlement_ clause on Claude Code, and it adds a knob decision 12 does not
mention: each driver offers two injection timings, one of which throws the round's work in
flight away and one of which does not.

**What was run.** `apps/server/src/spike/steeringProbe.ts`, against both drivers on this
machine — `opencode` 2.2.1 (model `openai/gpt-5.6-sol`) and Claude Code 2.1.310 through
`@anthropic-ai/claude-agent-sdk@0.3.310` (model `claude-sonnet-5`). Nothing was simulated
and nothing is UNTESTED for want of a driver. Each round prompts a session with slow work,
waits for the model to be demonstrably producing output, prompts again with a directive —
"reply with exactly the single word STEERED" — and reads the verdict off the driver's own
event stream rather than off the second call returning without an error. The probe measures
**executions and turns, not prompts**: an accepted prompt that the model never sees is the
failure decision 12 would not survive, so the marker has to appear in the transcript and
the driver has to say which execution produced it.

**OpenCode — INTERLEAVED.** The second prompt lands inside the **same**
`session.execution`, and one `api.session.wait` covers both.

- `POST /api/session/:id/prompt` carries a `delivery: "steer" | "queue"` field that
  `AgentHarness.prompt` does not pass today. Omitting it, the server resolved it to
  `steer` — reported back on the inbox record the call answers with, so this is the
  server's own word and not a default read out of its source.
- Both deliveries produced exactly **one** `session.execution.started` /
  `.succeeded` pair, with the directive arriving as a second
  `session.inbox.enqueued` and later `session.inbox.delivered` **inside** it.
- The two deliveries differ in _when_, and a one-step first turn cannot show it: a single
  long text answer is one step, and OpenCode promotes an inbox item only at a **step**
  boundary, so steer and queue both landed at the same instant. With a first prompt made
  of eight sequential `read` calls the difference is stark:
  - `delivery: "steer"` — directive delivered **after step 1 of 2**, 4 tool events. The
    tool call in flight completed, then the directive cut the rest of the work off. The
    session read one file of eight.
  - `delivery: "queue"` — directive delivered **after step 9 of 10**, 32 tool events. All
    eight reads finished, then the directive ran, still inside the one execution.
- No permission event appeared in any round, and `session.wait` answered after the
  directive's own output in every round.
- A prompt to an **idle** session starts a new execution rather than being refused; that is
  what every round's first prompt did. OpenCode never refuses a prompt for being busy
  (`packages/core/src/session/run-coordinator.ts` is a coalescing doorbell, not a queue of
  callers, and `SessionBusyError` is wired only to the three `session.revert.*` handlers).
  **So a steer that loses the race against settlement does not fail — it silently starts
  fresh work.** That is a race the goal agent has to lose safely; see the consequences.

**Claude Code — QUEUED.** The directive runs in the same session, the same process and the
same open `query()`, but as its **own turn** with its own `result`.

- Our own seam refuses it first, verbatim: `HarnessTransportError: session
<id> has already been prompted; carrying work on means a new attempt identity`
  (`claudeCodeClient.ts`'s `prompt`). That is bit's rule, not the driver's.
- Below it there is no second call to make. The SDK takes an
  `AsyncIterable<SDKUserMessage>` and `launch` already holds that iterable open for the
  session's whole life; a second prompt is a second `yield`. The probe drives `query()`
  itself, with `SDKUserMessage.priority`:
  - `priority: "now"` — the running turn was **cut off**: result 1 at 3.9s, 53 characters,
    the count reached 1 of 60, `subtype: "success"`. Result 2 at 8.0s carried `STEERED`.
  - `priority: "later"` — the running turn ran **to completion**: result 1 at 19.9s, 4757
    characters, the count reached 60 of 60. Result 2 at 21.8s carried `STEERED`.
- In **both** cases there were two `result` messages, each with `num_turns: 1` and
  `user_message_uuids` of length 1, and the directive's uuid appeared only on the second.
  Nothing folded. The SDK's own `user_message_uuids` doc describes folding only "for a turn
  started by a synthetic (meta) prompt", which a host-sent prompt is not — so the
  measurement and the documentation agree.
- The stream says so plainly: a `command_lifecycle` frame marks the directive's acceptance,
  then `result`, then a fresh `command_lifecycle command_lifecycle system system` — a
  second `system/init` — before the directive's turn.
- **This breaks bit's pump as written.** `claudeCodeClient.ts`'s `pump` has
  `if (message.type === "result") break;` — "one prompt, one turn" — and then
  `closeSession`. Under a steer that first `result` is the _steered-away_ turn: the pump
  would end narration, complete `idle`, close the query, and the directive's turn would be
  killed before it ran. `waitForIdle` would answer early and the supervisor would settle a
  round that is about to produce its real answer.

**T3 Code does exactly this, and names it.** Read at
`/run/media/hbt/work/01-better-agents-codebases/resources/t3code`:

- Five dispatch modes on one command, as a tagged union, not a flag:
  `defer_start | steer_active | restart_active | queue_after_active | start_immediately`
  (`packages/contracts/src/orchestrationV2.ts:2812`); newer clients send
  `deliveryIntent: "auto" | "steer" | "restart"` and the server picks under the thread lock
  (`:2804`).
- The pick is a capability ladder, not a preference:
  `apps/server/src/orchestration-v2/CommandPolicy.ts:147-199`. No active run →
  `start_immediately`; active run with no _running provider turn_ → `queue_after_active`,
  "so steering cannot reject the message"; otherwise `supportsActiveSteering` → steer,
  else `supportsQueuedMessages` → queue, else `supportsSteeringByInterruptRestart` →
  restart.
- The two drivers bit has are declared differently.
  `Adapters/ClaudeAdapterV2.ts:351-361`: `supportsActiveSteering: true`,
  **`activeSteeringInterruptsTools: true`**, `supportsSteeringByInterruptRestart: false`.
  `packages/provider-opencode/src/server/v2/adapter.ts:109-118`: steering, queueing and
  interrupt-restart all true, and `activeSteeringInterruptsTools` absent. Both of those
  match what the probe measured.
- Mechanism per driver: Claude is `existing.query.offer(userMessage)` with
  `priority: "now"` (`ClaudeAdapterV2.ts:9810-9860`), after first moving foreground
  subagents to the background because the priority cancels the root turn's running tool
  calls. OpenCode is `client.session.prompt({ ..., id: inboxID, delivery: "steer" })`
  (`provider-opencode/src/server/v2/adapter.ts:3735-3790`), where `inboxID` is **derived**
  from the session and message id so a retry cannot double-deliver.
- A steer is a **durable outbox effect**, not a call:
  `effect:${commandId}:provider-turn.steer:${providerTurnId}`
  (`Orchestrator.ts:4373-4387`, executed in `EffectWorker.ts:219`). The "steer arrived too
  late" race is handled at three layers — dispatch (`Orchestrator.ts:5021-5050`), effect
  (`ProviderTurnControlService.ts:130-139`, `turnCompleted: true`) and recovery
  (`EffectWorker.ts:248-300`, which re-dispatches the _same_ `messageId` as a new turn
  under the deterministic command id `command:steer-follow-up:${effect.id}`).
- Queued follow-ups are real runs with `status: "queued"` and a `queuePosition`, which is
  what makes them listable, editable, reorderable and promotable
  (`QueuedRunOrder.ts`; `queued-message.promote-to-steer` at `Orchestrator.ts:7918`, whose
  resulting turn is tagged `inputIntent: "promoted_queued_to_steer"` rather than `"steer"`).
- Default client behaviour is `followUpBehavior: "queue"`, not steer
  (`packages/contracts/src/settings.ts:440`).

**Consequences for the plan**

1. **Decision 12 stands.** Steering injects into a live session on both drivers, with the
   session's lineage, its MCP registration and its credential all intact. No fallback.
2. **Decision 12 needs a second sentence: which timing.** Each driver has a destructive and
   a non-destructive injection, and the probe shows the difference is not academic —
   OpenCode's `steer` cost seven of eight reads, Claude's `"now"` cost 59 of 60 lines.
   A planner round that is part-way through writing intents should finish them, so the
   default should be the non-destructive one (`delivery: "queue"` / `priority: "later"`),
   with the destructive one reserved for an explicit "redirect now" the operator or the
   goal agent asks for. T3's own default agrees (`followUpBehavior: "queue"`).
3. **`AgentHarness.prompt` has to grow.** It needs an urgency, and it needs an
   application-chosen message id for idempotency — OpenCode takes one (`id`) and Claude
   takes one (`uuid`), and T3 derives both deterministically so a retried steer cannot
   double-deliver. A steer must also be distinguishable from the round's opening prompt at
   the seam, because the two have different recovery rules: the opening prompt is never
   resubmitted, and a steer whose delivery is uncertain must not be either.
4. **Round settlement is now per-driver, and slice 6's settlement table has to say so.**
   On OpenCode a steered round settles once. On Claude Code it produces a second `result`,
   so "the first `result` ends the run" is wrong for a steered round: the pump must not
   break at the first one, `waitForIdle` must mean "idle after the last accepted message",
   and `closeSession` must not fire while a steer is outstanding. This is the only place
   the spike demands a change to shipped code, and it is in `claudeCodeClient.ts`.
5. **A steer can lose the race, and on OpenCode losing is not an error.** Prompting an idle
   session starts a new execution. So the goal agent's `steer` tool cannot simply call
   `prompt`: it has to claim the round as live first — the `FiberMap` keyed by round id
   from decision 6 is the natural claim — and fall back to decision 12's second clause
   ("open a round whose prompt already carries the directive") when the claim fails.
   Otherwise a late steer starts unsupervised work on a settled round, with no round record
   and no disposition.
6. **Decision 17 is load-bearing, not cosmetic.** Neither driver's narration, as bit
   reduces it, distinguishes a steer from the round's own prompt: OpenCode's steer is a
   `session.inbox.*` pair that maps to `opaque`, and Claude Code's is a
   `command_lifecycle` frame plus a second `system/init`, also `opaque`. Without the
   `plan.round.steered` record the spec already asks for, a steered round's transcript
   cannot explain its own disposition.

**Not tested.** Interrupting a tool call mid-execution with a steer (OpenCode's steer waited
for the tool to finish, which is what its capability flags claim; Claude's `"now"` was
measured against text generation, not against a tool call). More than one steer into one
round. A steer racing settlement (the behaviour is read from OpenCode's source and from
bit's own pump, not measured). Withdrawing a steer (`cancel_async_message` on Claude Code,
`session.inbox.cancel` on OpenCode). Any driver other than these two.

**Verification actually run.** `bun run typecheck` and `bun run lint` pass.
`bun run format:check` reports only `sprint-roadmap.html`, which is the documented baseline.
No production code changed. Logs are in `apps/server/.runtime/steering-probe-*.log`
(gitignored); `steering-probe-full.log` is the single run that produced every verdict above.

### 24.2 The directory as an authority boundary (Spike B)

### `SPIKE` resolved — the directory is an authority boundary under OpenCode, and a session is one under Claude Code (2026-10-29)

Spike B of `docs/design/goal-and-planner-flow.md`. Decision 5 builds the three-directory
layout, and a goal credential with no clock expiry, on the claim that an OpenCode MCP
registration belongs to a directory. Until now that claim was inferred from the comment on
`AgentHarness.registerMcpServer` (`apps/server/src/harness/agentHarness.ts`). It is now
measured, on both drivers, and **the design stands as written**. No fallback (reissued
short-lived credentials) is needed, so none is designed here.

**What was run.** `apps/server/src/spike/mcpIsolationProof.ts`, once per driver: real
`McpCredentials.issue`, real `seedAttempt`, the real control-plane MCP endpoint, real
`registerMcpServer` on the real driver (`opencode` 2.2.1, Claude Code 2.1.310 through the
Agent SDK), and the policy gate installed in every directory. Nothing was simulated and
both drivers started, so nothing is UNTESTED for want of a driver.

**What counts as evidence.** Never the model's account of itself. Each registration is
pointed at a recording proxy in front of the MCP endpoint, which notes which bearer each
request carried and what the endpoint answered. The store then says whose credential a
write came in under, because provenance is derived from the credential. For OpenCode the
harness's own registry (`api.mcp.list`, per directory) is read as well.

**Question 1 — POSITIVE.** Two OpenCode sessions in one directory: the second sees the
first's `bit-<id>` server and calls it successfully with the first's credential.

- With no model involved, `mcp.list` for the shared directory showed `bit-iso-a` the
  moment it was registered for session A, and the same call for a second directory
  showed nothing of it.
- Session B, which was never registered for anything named `bit-iso-a`, called its
  `record_observation`. The proxy saw `tools/call` carrying **A's** token, answered 200;
  the store holds the observation under **A's attempt and A's harness session id**. B's
  model made the call and A's identity signed it. That is the exact failure the layout
  exists to prevent, demonstrated rather than inferred. It succeeded in runs 3 to 6; in
  runs 1 and 2 the tool was not yet exposed to B's first prompt (caveat 1 below).
- Control: a session in a **different** directory, whose own server was reachable, asked
  for `bit-iso-a` and got the harness's own refusal: `Unknown tool
'bit-iso-a.record_observation'. Did you mean tools["bit-iso-c"].record_observation?`
  Zero requests reached the endpoint. The two directories were siblings under one parent
  and inside one git worktree, which is the shape of `targets/<id>/{workspace,planning,goal}`.
- Source agrees (OpenCode `packages/core/src/tool/mcp.ts`): MCP tools are registered into
  a registry built with `makeLocationNode`, so they belong to the location, and the
  session id is passed to `callTool` only as context. There is no per-session filter to
  find.

So under OpenCode the directory is the only boundary there is. The layout is
**load-bearing, not merely tidy**, and `mcp/credentials.ts` should say so when slice 4
documents the no-expiry case (the spec already asks for this).

**Question 2 — OpenCode replaces cleanly; Claude Code replaces before the prompt and
silently ignores after it.**

- _OpenCode._ Re-adding `bit-iso-a` with a new token (a different attempt, `a2`) left one
  registry entry, not two. The harness reconnected immediately under the new token
  (`server/discover`, `subscriptions/listen`, `tools/list`, all `a2`). Every later call,
  from a brand-new session and from a session that was already open, carried `a2`; the old
  token was revoked first and no request ever carried it, so no 401 appeared. The writes
  are attributed to `a2`.
- _Claude Code, before the prompt._ Registering one name twice on a session replaces the
  first: only the second token ever connected and the first presented nothing.
- _Claude Code, after the prompt was accepted._ `registerMcpServer` **returns success and
  does nothing**: zero requests reached the endpoint under the late name. The registration
  is pushed to the CLI once, at launch (`claudeCodeClient.ts` `launch`), and a later write
  to the session record is never sent. A token cannot be rotated on a live Claude Code
  session through this seam, and nothing says so.

**Question 3 — CONFIRMED.** Two Claude Code sessions live at once in one directory, each
registered with its own server. A (positive control) called its own server; the proxy saw
that call under A's token. B searched for `bit-iso-a` three ways and the harness answered
"No matching deferred tools found" each time; B reached only its own server, and no
request under A's token came from B. Registration is per session, as `agentHarness.ts`
documents.

**Neither driver wrote the bearer to disk.** Files modified during each run under the
harness's data and config directories, the Claude Code home, and the spike's own
directory were searched for the raw tokens: none found, on either driver.

**Caveats that change how this is built**

1. **A server can be registered, connected and not yet callable.** `mcp.add` returns once
   the server is connected, but OpenCode's tool registry reloads on its own schedule, behind
   a lock and a debounce (`tool/mcp.ts`, the `ToolsChanged` subscription). In 3 of 8
   first prompts after a registration, the model reported the tool was not exposed and the
   endpoint saw no call; the same prompt succeeded on the next turn or the next run. Not
   root-caused. It cuts both ways: a negative result in this spike is weak evidence on its
   own, which is why the control above is a harness error beside a working sibling rather
   than a model's "not found". And it means **a worker prompted straight after
   registration can silently lack `record_observation` today.** There is no API to read
   the tool registry, so a readiness check would need a different mechanism. Worth its own
   follow-up; not fixed here.
2. **Workers are not isolated from each other.** Concurrent attempts on one target share
   `targets/<id>/workspace/`, so each sees every `bit-<attemptId>` registered there and can
   write under another attempt's credential. The layout protects the planner and goal tool
   sets from workers, which is what it claims; it does not protect worker from worker. The
   comment on `registerMcpServer` already says this; the demonstration is above.
3. **Registrations are never removed.** Nothing calls `mcp.remove`, and the interface has
   no way to. After a credential is revoked the entry stays, `connected`, until the OpenCode
   server dies. A per-round `planning/<roundId>/` directory keeps that from accumulating
   across rounds; the shared `workspace/` accumulates a dead entry per attempt.
4. **The operator's global OpenCode config is in every directory.** Every registry listing
   above carried four servers the spike did not register, from the operator's
   `~/.config/opencode` (one of them a remote server with a key in its headers). A planner
   or goal session in its own directory sees them exactly as a worker does. Directory
   splitting does not reach this; the harness child's `XDG_CONFIG_HOME` would.
5. **Claude Code's stored transcript did not carry the final reply** in this run, so the
   spike took narration from `sessionEvents` instead. That is a retention detail
   (`AgentHarness.messages`) and matters to decision 14's replay, not to this finding.

**Consequences for the plan**

- Slice 3 stays as specified: three sibling directories, never nested, gate in each. The
  review should check the paths are siblings, since only siblings were tested.
- Slice 9: under OpenCode a goal credential's token can be swapped in place by
  re-registering the same name, and an already-open session picks it up. Under Claude Code
  it cannot be swapped at all on a live session; a replacement means a new session. The
  no-expiry design never needs a swap, but any future rotation work must know this.
- Slice 7's "a worker cannot reach `add_intent`" is now backed by the cross-directory
  control, not assumed.

**Not tested.** A tool call in flight across a re-registration. Nested directories (a
role directory inside another). Whether a registration survives an OpenCode server
restart (the server is a child of this process, so it should not outlive it). Any
driver other than these two. Claude Code across directories, which is moot while
registration is per session.

**Verification actually run.** Six OpenCode runs and two Claude Code runs; logs are in
`apps/server/.runtime/mcp-isolation-*.log` (gitignored). `bun run typecheck`, `bun run
lint` pass; `bun run format:check` reports only files outside this spike
(`sprint-roadmap.html` and others edited elsewhere in the tree). No production code
changed.

### 24.3 Does OpenCode walk up to a parent git root for configuration? (slice 7)

### `SPIKE` resolved — it walks up to the git root for instructions and **past it, to `/`, for configuration** (2026-10-29)

Spike B's "not tested" list and slice 7's brief both left this open: §24.2 only ever ran
sessions in directories whose ancestors held no OpenCode configuration, so nothing there
says what a planner directory **nested inside a git repository** inherits. It is not a
hypothetical shape — `main.ts` defaults `HUNT_ROOT` to `<cwd>/.runtime/hunt`, so in the
ordinary development layout `targets/<id>/planning/<roundId>/` sits four levels below this
repository's own `.git`.

**What was run.** `opencode debug config` ("List configuration sources"), `opencode 2.2.2`,
in a purpose-built tree under `/tmp` rather than in this repository, so nothing had to be
written into a git worktree to measure it:

```
/tmp/bit-gitroot-above/opencode.json          -> instructions: ["ABOVE-MARKER.md"]
/tmp/bit-gitroot-above/repo/                  -> git init
/tmp/bit-gitroot-above/repo/opencode.json     -> instructions: ["ROOT-MARKER.md"]
/tmp/bit-gitroot-above/repo/targets/t1/planning/rnd1/   <- cwd, no config of its own
```

**Result — POSITIVE, and wider than the question.** Run in `planning/rnd1`, OpenCode
listed as configuration sources: the operator's `~/.config/opencode/opencode.jsonc`, the
repository root's `opencode.json` (`ROOT-MARKER.md`) — four directories up, across the git
boundary — **and `/tmp/bit-gitroot-above/opencode.json` (`ABOVE-MARKER.md`), which is
outside the repository altogether.** So the configuration walk does not stop at the git
root: every ancestor directory up to `/` is a configuration source for a planner directory.
A control run in a sibling directory with no such ancestor listed only the operator's
global file.

**Instruction files are the narrower case, and the git root is their boundary.** From
OpenCode's own source rather than measured: `packages/core/src/config/plugin/instruction.ts`
walks `AGENTS.md` from the session's directory up to `location.project.directory`
(`fs.up({ targets: ["AGENTS.md"], start, stop })`, where `stop` is the project directory,
or the user's home when the location sits beneath it), and `packages/core/src/project.ts`
resolves the project directory as the nearest ancestor holding `.git` or `.hg`
(`markers = [".git", ".hg"]`, `fs.up({ targets: [".git", ".hg"], mode: "first" })`). So a
planner directory inside this repository is given **this repository's `AGENTS.md`** as
agent instructions. That half is read from source and not measured: the behavioural probe
(`opencode run` in the nested directory, asking the model to echo a token only the root
instruction file carries) could not complete — the default model answered
`Error: The usage limit has been reached`.

**Consequences.** This is the same class of leak as §24.2's caveat 4 and strictly larger
than it: directory splitting separates MCP registrations per role, and it does nothing
about configuration or instructions, which are inherited from every ancestor. A planner
round running under the default `HUNT_ROOT` therefore sees this repository's `AGENTS.md`
and any `opencode.json` at or above it — including, on a developer's machine, whatever
sits in `/tmp`'s or `$HOME`'s ancestry. **Nothing in slice 7 depends on it being
otherwise**, and the authority boundary is unaffected: tools come from the registration's
bearer and the endpoint it points at, not from configuration. What it would change is a
decision nobody has taken yet — a fleet root placed inside a repository whose config an
untrusted party can write is a fleet root whose planner inherits that config. The fix, if
one is ever wanted, is the one caveat 4 already names: set the harness child's
`XDG_CONFIG_HOME`, and additionally place `HUNT_ROOT` outside any git worktree.

**Not tested.** Whether `AGENTS.md` inheritance behaves as the source says (the model run
hit a provider usage limit). Claude Code's own configuration discovery. Whether a
`.gitignore`d ancestor config is treated differently. Any driver other than OpenCode 2.2.2.

### 24.4 Token usage and context limits (Spike C)

### 24.4 Usage and context limits (Spike C)

### `SPIKE` resolved — both drivers report tokens per model call, only OpenCode reports a limit before a run starts, and the figure that arrives most readily is the wrong one for a meter (2026-10-30)

Spike C of `docs/design/goal-and-planner-flow.md`, for slice 10's context meter. A meter is
tokens-used over a limit; `agentHarness.ts` classifies "a usage update" as `opaque` and
`HarnessModelView` carries no limit. This measures what each driver actually emits, so the
slice draws only what is true. Reproducible: `apps/server/src/spike/usageProbe.ts`, raw
frames under `apps/server/.runtime/usage-probe/` (JSONL, unreduced; gitignored).

**What was run.** `opencode` 2.2.2 on model `opencode/glm-5.3-flash-free` (catalogue name
"GLM-5.3-Flash Free"; the operator's `GLM-5.3-Flash` is that id, not a different one), and
Claude Code 2.1.310 through `@anthropic-ai/claude-agent-sdk@0.3.310` on `claude-sonnet-5`.
Nothing is UNTESTED. Claude Code was run three times (partials on, then again, then
partials off); the figures below are from the surviving partials-on file, and the stale
`output_tokens` and per-turn `result` behaviour were seen in every run. Each driver was prompted twice in one session: a three-file read task
(one `read` per file; four model calls on each driver) and then "reply
DONE" (one call). The second prompt is what separates per-call from cumulative figures.
OpenCode's stream was read **raw** (`fetch` on `/api/event`), not through the generated
client, because a schema decode drops fields it does not name.

#### OpenCode: three carriers, and only one of them is a context measure

| Event                            | Durable                      | Scope                      | Fields                                                                                                    |
| -------------------------------- | ---------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session.step.ended`             | yes (`durable.seq`)          | **one model call**         | `data.tokens {input, output, reasoning, cache{read, write}}`, `data.cost`, `assistantMessageID`, `finish` |
| `session.usage.updated`          | no (ephemeral, no `durable`) | **session lifetime total** | `data.tokens` (same shape), `data.cost`                                                                   |
| `message.list` assistant message | n/a (REST)                   | one model call             | `tokens`, `cost`, `finish`                                                                                |

`session.usage.updated` fires in the same millisecond as each `session.step.ended` (five
of each over two prompts). `GET /api/session/:id` carries the same cumulative `tokens` and
`cost`; that is what `sessionStatus` already returns as `tokens` for OpenCode.

Observed, per call (`step.ended`), then the running `usage.updated` total after it:

| call           | input | output | reasoning | cache.read | cache.write | context (in+cr+cw+out+rsn) | session total, in / cache.read |
| -------------- | ----- | ------ | --------- | ---------- | ----------- | -------------------------- | ------------------------------ |
| 1              | 10979 | 14     | 57        | 0          | 0           | 11050                      | 10979 / 0                      |
| 2              | 2692  | 25     | 28        | 10880      | 0           | 13625                      | 13671 / 10880                  |
| 3              | 590   | 26     | 0         | 13056      | 0           | 13672                      | 14261 / 23936                  |
| 4              | 93    | 45     | 0         | 13600      | 0           | 13738                      | 14354 / 37536                  |
| 5 (2nd prompt) | 150   | 3      | 0         | 13600      | 0           | 13753                      | 14504 / 51136                  |

- **`usage.updated` and `session.tokens` are cumulative and exactly the sum of the
  `step.ended` figures** (14504 input, 113 output, 85 reasoning, 51136 cache read: checked).
  The second prompt did not reset them. They are **not** a context measure: the last total
  sums to 65 838 tokens against a real context of 13 753, 4.8 times too many, because
  `cache.read` re-counts the whole cached prefix on every call.
- `input` is the **uncached** remainder, `cache.read` the cached prefix; they are disjoint,
  so the prompt size of a call is `input + cache.read + cache.write`. `reasoning` is **not**
  inside `output` on this provider. Call 1 shows `output 14, reasoning 57`.
- `cache.write` was 0 on every call: this provider never reports a write. Do not read
  zero as "nothing was written".
- `cost` was 0 throughout (free model).
- OpenCode's own meter (`packages/tui/src/util/session.ts`, `contextUsage`) takes the
  **last assistant message's** `input + output + reasoning + cache.read + cache.write`
  over `model.limit.context`. That is the last row above: 13 753 / 200 000, 7%.

#### OpenCode: the limit is reachable, through the call bit already makes

`GET /api/model`, which `openCodeClient.ts` already calls as `api.model.list()` for the
picker, carries `limit` on **all 27** catalogue entries:

```
opencode/glm-5.3-flash-free   limit: { context: 200000, output: 32000 }
openai/gpt-5.6-sol (default)  limit: { context: 400000, input: 272000, output: 128000 }
```

- It **survives the generated client's decode**: `api.model.list()` returns the entry with
  `limit.context` intact (the installed `@opencode/schema` 2.1.0 types it as `{ context: Int,
input?: Int, output: Int }`, against a 2.2.2 server). No new request, no raw HTTP.
- `limit.input` is optional and present on the default model. OpenCode's compaction uses
  `limit.input || limit.context` as its window; its meter uses `limit.context`. These
  differ for bit's own default (272 000 against 400 000), so the choice of denominator is a
  decision, not a given.
- The limit is **per model**, not per variant, and it is known at catalogue time, before
  any session exists. It fits `HarnessModelView` directly.

#### Claude Code: per-call figures in the stream, and a limit that is not in the catalogue

Carriers, per frame type (production does **not** set `includePartialMessages`, so the
first row is the only live carrier it sees; the second needs the option turned on):

| Frame                         | Scope        | What it carries                                                                                        |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `assistant` (`message.usage`) | one API call | `input_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{…}, output_tokens` |
| `stream_event/message_start`  | one API call | the same snapshot                                                                                      |
| `stream_event/message_delta`  | one API call | `usage` with the **final** `output_tokens`, `output_tokens_details.thinking_tokens`, `iterations[]`    |
| `result`                      | see below    | `usage`, `total_cost_usd`, `modelUsage`, `model_usage_since_last_result`                               |

- **An `assistant` frame's `usage` is the `message_start` snapshot, not the final figure.**
  The input side is exact; `output_tokens` is stale. The call that really produced 16
  output tokens reported `output_tokens: 1` on its `assistant` frame, and the one that
  produced 153 reported 2. This holds with partials off as well (the production
  configuration). Only `message_delta` (partials on) and the `result` carry the true
  output count.
- **One API call arrives as several `assistant` frames**, one per content block (a thinking
  block, then a tool_use block), each repeating the same `message.id` and the same `usage`.
  Counting per frame double-counts; the unit is `message.id`.
- No reasoning bucket in `assistant.usage`. `output_tokens_details.thinking_tokens` exists
  on `message_delta` and `result.usage`, and is **inside** `output_tokens` (the opposite of
  OpenCode here).
- Prompt side per call, turn 1: 21 388, 22 851, 23 007, 23 163 (grows). The last call's
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is the context
  size at that call; with its 16 output tokens, 23 179.
- **`result.usage` is per turn and summed over that turn's calls**: `input_tokens 8` (2 per
  call, four calls), `cache_read 88 626` = 21 386 + 21 386 + 22 849 + 23 005, and
  `cache_creation 1 775`. All four fields sum to 90 784 against a real context of 23 179,
  3.9 times too many, the same trap as OpenCode's total. Turn 2's `result.usage` was
  `2 / 74 / 23 161 / 5` (input / cache creation / cache read / output): it restarted, it
  did not accumulate.
- **`result.usage.iterations[0]` is the last call alone** (here input 2, output 16, cache read 23 005, cache creation 156),
  exact, with the true output count. It is the only exact last-call figure that needs
  neither partials nor a second request, and it arrives at turn end only.
- **`total_cost_usd` and `modelUsage` are cumulative across the query; `usage` and
  `model_usage_since_last_result` are per turn.** Cost went 0.02872 to 0.03371 (the
  difference, 0.00498, is turn 2's own figure); `modelUsage["claude-sonnet-5"].cacheReadInputTokens`
  went 88 626 to 111 787, a difference of 23 161, which is turn 2's own cache read. The same `result` mixes both scopes.
- `modelUsage` also lists **`claude-haiku-5-5`** (1 237 input, 17 output): a side call the
  SDK made that is billed to the session and is not part of the main model's context. A
  reader summing `modelUsage` over its keys overstates the context.

Limit, three candidates:

| Source                                               | Value                                     | Available when                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `result.modelUsage[model].contextWindow`             | 1 000 000 (also `maxOutputTokens` 64 000) | the end of the first turn, and keyed by model with a side model beside it                                      |
| `query.getContextUsage().maxTokens` / `rawMaxTokens` | 1 000 000                                 | **from `system/init`**, before any API response (`apiUsage: null` then); a control request, not a stream frame |
| `query.supportedModels()` (`ModelInfo`)              | **absent**                                | no `contextWindow` field on any of the entries                                                                 |

- `claudeCodeClient.ts`'s `CLAUDE_CODE_MODELS` is a static list; there is no catalogue to
  read a limit from, so a Claude Code limit cannot live on `HarnessModelView` honestly.
  It is a **session-time** fact. The 1 000 000 is this account's, for the model as
  resolved here; it should not be written down as a constant.
- `getContextUsage().totalTokens` is **not** a usage figure to trust: it was 24 053 after
  both turns (and 27 847 / 24 098 at the two `system/init`s), a category estimate that did
  not move between turn 1 (context 23 179) and turn 2 (23 242). Use it, if at all, for
  `maxTokens`. Its `apiUsage` field is the last call's exact usage.

#### Where this sits against `NarrationDetail`

- **OpenCode.** `openCodeNarration`'s `default:` arm turns `session.step.ended` and
  `session.usage.updated` into `{ _tag: "opaque" }`. What it discards is, on `step.ended`,
  the per-call token breakdown, `cost`, `assistantMessageID` and `finish`; on
  `usage.updated`, a cumulative total. **The right event is `session.step.ended`**:
  durable (it has a `sequence`, so a reconnect can resume past it), per call, and carrying
  the message id that dedupes it. `usage.updated` is ephemeral, a stream that reconnects
  loses it silently, and it is the wrong scope.
- **Claude Code.** `narrate` returns `[opaque]` for any `assistant` frame without a `text`
  or `tool_use` block and for every `result`. For `assistant` frames with blocks the usage
  rides on the same frame and is dropped; for `result`, `pump` keeps only
  `record.tokens = message.usage` and `record.cost`, then narrates it as `opaque`.
- **`sessionStatus.tokens` already means two different things.** On OpenCode it is the
  lifetime session total; on Claude Code it is the **last turn's** `result.usage`,
  overwritten each turn. Same field, same `Record<string, unknown>`, different scope, and
  neither is a context measure. Slice 10 must not reuse it as a numerator.

#### Consequence for the `usage` tag

The seam's rule is that a case exists only if both harnesses can produce it. What both can
produce, per model call, in the stream, exactly, is the **prompt side**: OpenCode
`input + cache.read + cache.write`; Claude Code `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`. That is the size of the context sent on that call, and it
is the bulk of the meter. Output is exact on OpenCode and exact on Claude Code only at turn
end (or with partials on), and reasoning is separate on one and inside output on the other.

```ts
| {
    readonly _tag: "usage";
    /** One model call: OpenCode assistantMessageID, Claude Code message.id. The dedupe key. */
    readonly callId: string;
    /** Tokens sent to the model on this call: uncached input + cache read + cache write. */
    readonly promptTokens: number;
    /** Tokens generated on this call, thinking included; undefined where the stream has not yet stated it. */
    readonly outputTokens: number | undefined;
    /** The model's context window, when this driver states it by now. */
    readonly contextLimit: number | undefined;
  }
```

- `promptTokens` is the numerator the meter needs and both drivers state it exactly.
- `outputTokens` is `undefined` on Claude Code's `assistant` frames, which would otherwise
  carry a stale 1. If a later frame (the `result`'s `iterations[0]`) states it, that is a
  second `usage` entry with the same `callId`; the reader keeps the latest per `callId`.
  For OpenCode it is `output + reasoning`, so the field means "all generated" on both.
- Cache read and write, and reasoning, are deliberately **not** cases. They cannot be
  filled on both drivers with the same meaning (`cache.write` is a constant 0 on one,
  `reasoning` is inside `output` on the other), and slice 10 does not draw them.
- `contextLimit` is optional on the tag **and** should be added to `HarnessModelView` as
  `contextLimit?: number`, filled by OpenCode from `limit.context` and left absent on
  Claude Code. Claude Code's value comes from `getContextUsage()` at `system/init` or the
  first `result`, so it can only ride the tag or the session, never the static model list.
- A meter shows a percentage only when `contextLimit` is known and shows the token figure
  alone otherwise. Both are reachable here; neither is guaranteed by the seam.
- Do **not** put cumulative figures on the tag. `usage.updated`, `session.tokens`,
  `result.usage`, `modelUsage` and `total_cost_usd` all measure spend, not context, and
  two of them mix scopes in one object.
