# Working in bit

- Use Bun 1.4.3 and the committed `bun.lock`. Install with
  `bun install --frozen-lockfile`; do not add another package manager's lockfile.
- Commands from this root: `bun run dev`, `bun run build`, `bun run typecheck`,
  `bun run test`, `bun run lint`, `bun run format:check`, `bun run format`.
- Keep TypeScript strict and ESM. Verify Effect v4 APIs against installed types;
  v3 examples are not reliable. Use Effect Schema, not a direct Zod dependency.
- Contracts must remain browser-safe: no server, Bun, Node, or persistence imports.
  Web code consumes contracts, never server implementation.
- Use stock Drizzle typed queries and `bun:sqlite`, with thin Effect wrappers.
  Database callbacks are synchronous; execute queries inside them and never return
  promises/Effects or perform network work inside transactions.
- Add server folders only when implementing a real feature. This is foundation
  work, not an implementation of the architecture in `DECISIONS.md`.
- Keep credentials, runtime databases, and evidence out of git. Do not copy code
  from AGPL reference repositories.
- For persistence changes, run the real SQLite tests as well as typecheck; run
  build, lint, and format checks before handing off changes.
