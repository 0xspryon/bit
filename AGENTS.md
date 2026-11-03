# Working in bit

- The operator is experienced with single-tenant software but new to building agent
  harnesses. In plans, reviews, and explanations, focus on the harness-specific
  mechanics and tradeoffs: session and attempt identity, tool/MCP authority,
  credential isolation, policy hooks, stream durability, interruption, recovery,
  and uncertain outcomes. Keep ordinary single-tenant application plumbing brief
  unless it is needed to explain a harness boundary.
- The app is intended for tablet-sized screens and larger, not mobile phones.
  Verify responsive UI from tablet widths upward; do not spend roadmap or
  implementation effort fixing phone-width layout solely for mobile support.
- Use Bun 1.4.3 and the committed `bun.lock`. Install with
  `bun install --frozen-lockfile`; do not add another package manager's lockfile.
- Commands from this root: `bun run dev`, `bun run build`, `bun run typecheck`,
  `bun run test`, `bun run test:persistence`, `bun run lint`, `bun run format:check`,
  `bun run format`. `test:persistence` is the real-SQLite subset; `test` includes it.
- Keep TypeScript strict and ESM. Verify Effect v4 APIs against installed types;
  v3 examples are not reliable. Use Effect Schema, not a direct Zod dependency.
- The Effect devtools are advisory and sit beside the gates, not inside them.
  `bun run lint` stays ESLint: it owns the browser-safety import boundary and
  unused-vars, and the Effect Oxlint preset carries neither. `bun run lint:oxlint`
  is the Effect-rule pass, and it currently reports pre-existing findings, so do not
  treat a non-zero exit as a regression without diffing against the baseline.
  `bun run typecheck` stays stock `tsc` at the pinned TypeScript; the Effect
  diagnostics come from `effect-tsgo tsc -p <project>`, which brings its own
  TypeScript 7 and never changes what CI compiles with.
- TypeScript stays pinned at 6.0.3. `typescript-eslint` requires `<6.1.0` and
  `svelte-check` requires `^5 || ^6`, so a TypeScript 7 upgrade breaks `lint` and
  `typecheck`. `@effect/tsgo` does not need it: its compiler is bundled. The root
  `prepare` script is therefore `effect-tsgo patch --no-typescript --oxlint`, which
  patches only the Oxlint binaries. Do not alias `@typescript/native` to a
  TypeScript 7 release to satisfy the patcher — that package's `tsc` bin hijacks
  `node_modules/.bin/tsc` and silently moves `typecheck` and `build` onto TS 7.
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
- Run every test command under a 1 GB memory limit, as
  `systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 timeout 900 <command>`
  (e.g. `… bun run test`). The operator's machine has little memory to spare, and a test
  that runs away takes the machine and every agent on it down; under the limit only that
  test process dies. The whole of `bun run test` fits (measured peak: server suite 386 MB,
  web DOM suite 294 MB), so a run killed at 1 GB is a bug to investigate, not a reason to
  raise the limit. `bun run typecheck` runs under the same limit only one package at a
  time with Node's heap sized to it:
  `… NODE_OPTIONS=--max-old-space-size=900 bun run typecheck --concurrency=1` (in
  parallel, `tsc` and `svelte-check` together exceed 1 GB and are killed). A failing assertion on happy-dom nodes is the known cause: never
  `toEqual` a node or an array of nodes — compare strings (`outerHTML`, `textContent`).
  When a test mutates a file to prove it can fail, copy the file first and restore from
  the copy; a killed run never reaches a cleanup step after it.
- When in doubt about how to implement a functionality or how EffectV4 works, look
  the EffectV4, OpenCode/ T3Code better-agent repositories and gain inspiration
  from that about how how such a functionality should be implemented.
- Delegate short-lived work — research, a codebase survey, a focused question —
  to the **OpenCode** harness on GLM 5.3: `glm-5.3` from the z.ai coding plan, or
  `glm-5.3-flash` from the OpenCode plan. Either is enough for a task that reads
  and reports, and neither spends the frontier-model budget that long-running
  implementation and review work needs. Implementation, code review and anything
  holding a design decision stay on the stronger model.
  Resolve the id from the harness's live catalogue rather than hardcoding one —
  `@opencode/schema`'s `Agent.Info.model` is a `Model.Ref`, and the OpenCode plan
  currently spells its entry `opencode/glm-5.3-flash-free`
  (`apps/server/src/spike/usageProbe.ts:75`). The z.ai entry depends on the
  provider the operator has configured and is not pinned here for the same reason.
