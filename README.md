# bit

Bun workspaces, Turborepo, strict TypeScript ESM, Effect v4, SQLite through
`effect/sql` with the `@effect/sql-sqlite-bun` driver, and a static SvelteKit browser
app. On top of that foundation: one control-plane HTTP listener, an application-owned
MCP tool a delegated worker records evidence through, a local rate-limit fixture to
test against, deterministic briefings built from stored rows, and startup
reconciliation of attempts no definite outcome has been recorded for.

The planner, the exploration graph, evidence capture, concurrency and the UI are not
implemented. One worker at a time; see `DECISIONS.md` for what is deliberately absent.

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

| Route                        | Admission                                                 |
| ---------------------------- | --------------------------------------------------------- |
| `GET /api/v1/health`         | none; answers `{ "status": "ok" }` and nothing else       |
| `POST /api/v1/mcp`           | **bearer credential required**, `401` before any dispatch |
| `POST /api/v1/policy/decide` | deliberately unauthenticated, at the operator's direction |

The simulated target under test keeps its **own** listener
(`apps/server/src/fixture/server.ts`). It is not part of this API and must not be
served from this origin.

Set `DATABASE_PATH` for a persistent connection (an in-memory database otherwise) and
`PORT` to change the listen port — and update the Vite proxy to match in development.
`RECONCILE_ON_START=0` skips startup reconciliation.

## Persistence

`effect/sql` with the official Bun SQLite driver. No ORM: parameterised tagged-template
SQL, rows decoded through Effect Schema, and `effect/sql/Migrator` over a statically
imported, append-only `MIGRATIONS` record. Migrations run to completion before the store
is available, so a failed migration fails startup instead of exposing a partial schema.
There is no `down` and no `redo`; a migration is retracted by a new forward one.

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

Each untested dimension an observation records becomes an addressable open question. A
later observation can say which one it took on, by exact address; nothing is matched by
wording. "Addressed" is not "resolved", and the briefing distinguishes uninvestigated,
addressed-but-inconclusive and addressed-with-evidence rather than collapsing them.

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
