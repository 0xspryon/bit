# bit

Bun workspaces, Turborepo, strict TypeScript ESM, Effect v4, SQLite through
`effect/sql` with the `@effect/sql-sqlite-bun` driver, and a static SvelteKit browser
app. On top of that foundation: one control-plane HTTP listener, an application-owned
MCP tool a delegated worker records evidence through, a local rate-limit fixture to
test against, deterministic briefings built from stored rows, and startup
reconciliation of attempts no definite outcome has been recorded for.

Persistence is two tiers: `control.sqlite` holds the settings and the target registry,
and each target's graph, events and outbox live in `targets/<id>/hunt.sqlite`.

The planner, evidence capture, concurrency and the UI are not implemented, and nothing
yet _consumes_ the events or the outbox. One worker at a time, one target served at a
time; see `DECISIONS.md` for what is deliberately absent.

## Run

Install **Bun 1.4.3** (also pinned in `.bun-version` and `packageManager`), then:

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. Vite proxies `/api` to the loopback-only server on
port 3000.

```sh
bun run build
bun run typecheck
bun run test              # the whole suite, including the real-SQLite subset
bun run test:persistence  # the real-SQLite subset on its own
bun run lint
bun run format:check
bun run format
```

`sprint-roadmap.html` fails `format:check` and is left alone.

`bun run --cwd apps/server start` runs the built server. `apps/web/build` is a
static SPA: production hosting must serve its fallback `index.html` and proxy
`/api` to the server. The server does not serve the web build. Vite's development
proxy is not a production proxy.

## The control plane

Every endpoint this application _serves_ is one route on one listener
(`apps/server/src/http/controlPlane.ts`), under the `/api/v1` prefix built from
`apiPath` in `@bit/contracts` so the web app and the server cannot disagree about a
path. Each route keeps its own admission:

| Route                | Admission                                                 |
| -------------------- | --------------------------------------------------------- |
| `GET /api/v1/health` | none; answers `{ "status": "ok" }` and nothing else       |
| `POST /api/v1/mcp`   | **bearer credential required**, `401` before any dispatch |

The simulated target under test keeps its **own** listener
(`apps/server/src/fixture/server.ts`). It is not part of this API and must not be
served from this origin.

Set `HUNT_ROOT` to the fleet directory (default `.runtime/hunt`), `TARGET_ID` to the
target this process serves (default `fixture-local`, registered on demand), and `PORT` to
change the listen port — and update the Vite proxy to match in development.
`RECONCILE_ON_START=0` skips startup reconciliation. There is no in-memory mode: the
layout is a filesystem guarantee, and an in-memory fleet would be a different thing
wearing the same name.

## Persistence

```
<HUNT_ROOT>/
  control.sqlite              settings and the target registry
  targets/<target-id>/
    hunt.sqlite               the graph, its events and its outbox
    evidence/                 content-hashed blobs, out of SQLite
```

Per-target files, because `rm -rf targets/<id>/` is provable evidence destruction where
`DELETE` plus `VACUUM` is not, because scope isolation is then a filesystem guarantee
rather than a `WHERE` clause, and because traffic capture is heavy. The accepted cost is
that migrations run against N files: startup migrates the control database, then iterates
the registry and migrates each target's own file. A target whose file does not migrate is
marked unavailable and refused by name; its neighbours are served, and only a failure of
the control database itself fails startup.

Sequences are per target, because the counter lives in the target's file. Existing ids are
never renumbered: an observation's id carries its sequence and every dimension address a
briefing has printed is built from it.

`effect/sql` with the official Bun SQLite driver. No ORM: parameterised tagged-template
SQL, rows decoded through Effect Schema, and `effect/sql/Migrator` over statically
imported, append-only migration records — one chain per tier. Migrations run to completion
before a store is available, so a failed migration fails startup instead of exposing a
partial schema. There is no `down` and no `redo`; a migration is retracted by a new
forward one, migration ids must strictly increase, and a skipped id can never be filled
in afterwards.

Every mutation — recording an asset, adding an intent, recording an observation — writes
its domain rows, its command receipt, its event and any side-effect request it implies in
**one** SQLite transaction. So an exact retry of an operation id replays the original
result and writes no second event and no second request; the same id with changed input is
refused and writes nothing at all; and a process killed inside an uncommitted transaction
leaves none of it behind, which is demonstrated by actually killing one
(`src/spike/persistenceProof.ts`).

An intent may anchor only to a recorded observation — never to another intent, a goal or a
hint — and the refusal says so rather than failing bare. Anchoring is enforced in the
store rather than in a tool, because a planner round has no execution attempt to
authenticate with; the planner-facing surface waits until there is a planner loop.

The event log is append-only in the database, not only by convention: triggers refuse an
`UPDATE` and a `DELETE`. The outbox is a durable queue of side-effect requests, each
carrying an explicit recovery policy, and it does **not** provide exactly-once remote
execution. Nothing reads either yet — cursors, wake-ups, claiming, leases and retry
scheduling are the next slice.

A transaction body is an ordinary Effect and may yield, but must do no harness, HTTP or
filesystem work: SQLite holds one write lock for its duration.

The SQLite tests run every repository statement and every migration path against a real
file, because nothing checks SQL identifiers or placeholders at compile time.

## Lifecycle, in three independent answers

An **attempt status** says whether execution finished. An **observation outcome** says
what one bounded test established about one narrow claim. Whether anything constitutes a
vulnerability is a third question, and nothing here answers it — there is no finding
subsystem. None of the three is derived from another.

An attempt a previous process left `running` is reconciled against the harness at
startup (`apps/server/src/recovery/`). A session the harness cannot be asked about, or
has never heard of, makes the attempt `uncertain` — never `failed`, and never "it did
nothing": holding no observation for an attempt is not evidence that it had no effect on
a target. Leaving `running` bumps the attempt's write fence, so a credential minted
before that is refused afterwards, including after a restart.

`uncertain` is an admission, so every startup asks again: the sweep reads `running` and
`uncertain` attempts and never a settled one. A definite answer refines an `uncertain`
attempt; a harness that reports the session live does not reopen it, because its
authority is already revoked — carrying the work on means a new attempt that records
which one it replaces.

Each untested dimension an observation records is a row with its own identity, and an
addressable open question. `<observationId>#u<index>` is the address a briefing prints and
a worker copies; it is resolved to that identity on the way in, so nothing is matched by
wording. "Addressed" is not "resolved", and the briefing distinguishes uninvestigated,
scheduled, addressed-but-inconclusive and addressed-with-evidence rather than collapsing
them. `scheduled` means an intent was created saying it addresses that dimension and its
work has not settled; once every attempt on that intent settles with no answer recorded,
the question is open again, carrying the record that somebody tried. Nothing closes a
question: there is no closure authority here.

A briefing grows by appending. Observations are chosen newest-first, so truncation keeps
the evidence that qualifies the rest, and then listed oldest-first; everything that
restates the record — the graph sequence, the counts, the disclosed omissions and the open
questions — sits below one heading at the end. An observation's block therefore ends at
its `limitations` and names none of the dimensions it left untested: those are forward
work whose state changes as they are addressed, so they are rendered once, below that
heading. So a briefing built after another observation lands begins with the previous one,
byte for byte, until the truncation window slides. Planner rounds on a target are opened under one anchor session for the same
reason: a harness that caches by session lineage can then reuse what it has already been
sent. Each round is still a fresh session that reads the briefing and nothing else.

## Boundaries

- `apps/server`: the control-plane listener, persistence, the harness seam, the MCP
  tool, the fixture, and the spike entrypoints under `src/spike/`.
- `apps/web`: browser-only SvelteKit + Vite app (`adapter-static`).
- `packages/contracts`: browser-safe Effect schemas and inferred types, consumed
  directly as TypeScript by both apps. No server, Bun, Node or persistence imports —
  ESLint enforces it. Its build task checks types; there is no separately published
  library artifact.

ESLint checks TypeScript with recommended rules and those import boundaries;
`svelte-check` checks components, and Prettier formats all supported
source/configuration files.

Versions were checked against the npm registry on 2026-10-18. Effect 4.0.5 is
stable; TypeScript 6.0.3 is selected for the SvelteKit/svelte-check and
typescript-eslint peer ranges (rather than incompatible TypeScript 7).
