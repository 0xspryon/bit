# bit

Minimal application foundation: Bun workspaces, Turborepo, strict TypeScript ESM,
Effect v4, stock Drizzle with `bun:sqlite`, and a static SvelteKit browser app.
Hunting workflows, domain schemas, delegation, and harness integration are not implemented.

## Run

Install **Bun 1.4.3** (also pinned in `.bun-version` and `packageManager`), then:

```sh
bun install --frozen-lockfile
bun run dev
```

Open http://localhost:5173. Vite proxies `/api` to the loopback-only server on
port 3000. `GET /api/health` returns `{ "status": "ok" }`.

```sh
bun run build
bun run typecheck
bun run test
bun run lint
bun run format:check
bun run format
```

`bun run --cwd apps/server start` runs the built server. `apps/web/build` is a
static SPA: production hosting must serve its fallback `index.html` and proxy
`/api` to the server. The server does not serve the web build. Vite's development
proxy is not a production proxy.

## Boundaries

- `apps/server`: Bun HTTP entry point and scoped persistence helpers.
- `apps/web`: browser-only SvelteKit + Vite app (`adapter-static`).
- `packages/contracts`: browser-safe Effect schemas and inferred types, consumed
  directly as TypeScript by both apps. Its build task checks types; there is no
  separately published library artifact.

The server defaults to an in-memory database. Set `DATABASE_PATH` to an existing
parent directory plus filename for a persistent connection; set `PORT` to change
the listen port (and update the Vite proxy for development). No application tables
or migration system exist yet.

`openDatabase` requires an Effect scope and closes the connection at scope exit.
Queries and transactions wrap synchronous Drizzle operations in `Effect.try` and
report `DatabaseError` with the operation and original cause. Use terminal Drizzle
methods (`.run()`, `.get()`, `.all()`) inside callbacks. A transaction callback must
finish synchronously: no promises, Effects, networking, or escaped transaction
handles. A thrown error rolls back the entire callback. Returning a promise or
Effect is rejected by the types and runtime; it cannot cancel async work already
started by a caller violating that contract.

The SQLite tests exercise durable commit, full rollback after a real uniqueness
violation, and connection release. ESLint checks TypeScript with recommended
rules and import boundaries; `svelte-check` checks components, and Prettier formats
all supported source/configuration files.

Versions were checked against the npm registry on 2026-10-18. Effect 4.0.5 is
stable; TypeScript 6.0.3 is selected for the SvelteKit/svelte-check and
typescript-eslint peer ranges (rather than incompatible TypeScript 7).
