# Working in bit

- Use Bun 1.4.3 and the committed `bun.lock`. Install with
  `bun install --frozen-lockfile`; do not add another package manager's lockfile.
- Commands from this root: `bun run dev`, `bun run build`, `bun run typecheck`,
  `bun run test`, `bun run test:persistence`, `bun run lint`, `bun run format:check`,
  `bun run format`. `test:persistence` is the real-SQLite subset; `test` includes it.
- Keep TypeScript strict and ESM. Verify Effect v4 APIs against installed types;
  v3 examples are not reliable. Use Effect Schema, not a direct Zod dependency.
- Contracts must remain browser-safe: no server, Bun, Node, or persistence imports.
  Web code consumes contracts, never server implementation.
- Persistence is `effect/sql` with the `@effect/sql-sqlite-bun` driver. No ORM.
  Write parameterised tagged-template SQL and decode rows with `SqlSchema`; never
  interpolate a value into statement text. Transaction bodies are ordinary Effects
  and may yield, but must not do harness, HTTP or filesystem work — SQLite's single
  write lock is held for their duration.
- Migrations are `effect/sql/Migrator` entries in `MIGRATIONS`, statically imported
  and ordered. Append; never edit an applied one. There is no `down` or `redo`:
  retract a migration with a new forward one. A failed migration rolls back, and
  surfaces as a defect unless run through `runMigrations`.
- Migration ids are not contract versions. The observation contract is at version 1
  (`OBSERVATION_CONTRACT_VERSION`) and nothing has been published, so name shapes for
  what they hold, not for a release history that does not exist: an observation is
  `caseBased` or `summary`, which is its _record format_. Do not reintroduce
  version-numbered or "older/superseded" naming for a shape that is still v1.
- Add server folders only when implementing a real feature. This is foundation
  work, not an implementation of the architecture in `DECISIONS.md`.
- Keep credentials, runtime databases, and evidence out of git. Do not copy code
  from AGPL reference repositories.
- For persistence changes, run `bun run test:persistence` as well as typecheck:
  nothing checks SQL identifiers or placeholders at compile time, so every
  repository statement and every migration path has to be executed against a real
  file. Run build, lint, and format checks before handing off changes.
  `sprint-roadmap.html` fails `format:check` already; leave it alone.
- When in doubt about how to implement a functionality or how EffectV4 works, look
  the EffectV4, OpenCode/ T3Code better-agent repositories and gain inspiration
  from that about how how such a functionality should be implemented.
