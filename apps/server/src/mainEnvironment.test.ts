/**
 * Every environment variable `main.ts` configures this server from is reachable through
 * `bun run dev`.
 *
 * **This test exists because the gap it closes was invisible to every other one.**
 * `turbo.json` runs with `envMode: strict`, so a task sees only the variables named in its
 * `passThroughEnv` plus turbo's own built-in defaults. `GOAL_BRIEFING_MAX_CHARS` and
 * `PLANNER_ROUND_BUDGET` were added to `main.ts` in slices 6 and 7 and to that list in
 * neither, so setting either one and running the command the README tells an operator to
 * use silently had no effect — and the over-the-ceiling refusal told them to raise a limit
 * they could not raise. Nothing failed: the server booted, logged the default, and was
 * wrong about why.
 *
 * So the check is structural rather than a list of names, in the same spirit as
 * `clientRefusals.test.ts`: **the variables are read out of `main.ts`'s source** and each
 * has to be either in `passThroughEnv` or in {@link NOT_PASSED_THROUGH} with a reason.
 * A variable added to `main.ts` tomorrow appears here with no edit to this file.
 *
 * It reads the files as text on purpose. Importing a module would start a server or open a
 * database, and `turbo.json` is configuration with no module to import. Every path is
 * resolved from `import.meta.dir` so the test does not depend on the working directory
 * `bun test` was launched from.
 *
 * ## Why it walks the whole server and not only `main.ts`
 *
 * It read `main.ts` alone, which is the composition root and *nearly* the only place this
 * process reads its environment — and the exception is the one that proves the point.
 * `policy/claudeCodeGate.ts` read `CLAUDE_CONFIG_DIR` (until the policy gate was removed,
 * 2026-11-06), which is absent from `passThroughEnv` and was therefore invisible to exactly
 * the test written to make that class of gap visible. A variable read in an imported module is as unreachable under
 * `bun run dev` as one read here, so the enumeration is over the modules rather than over
 * one file, and what the test guarantees now matches what its name claims.
 *
 * Two kinds of file are left out, both deliberately and both named in code below: a
 * `*.test.ts` (a suite's own environment is not this server's configuration) and anything
 * under `spike/` (run by hand, never by `bun run dev` — DECISIONS.md §24 records what each
 * one measured).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** `apps/server/src` → the repository root. */
const repositoryRoot = join(import.meta.dir, "..", "..", "..");

const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

/**
 * Every module this server is built from, as `{ path, source }`.
 *
 * Recursive from `apps/server/src`, with the two exclusions this file's header names. The
 * path is kept beside the source so a failure can say *where* an unaccounted variable is
 * read, which is the difference between a name and an instruction.
 */
const serverModules = (): readonly { path: string; source: string }[] => {
  const found: { path: string; source: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // A spike is a hand-run proof, not part of the server this command starts.
        if (entry.name === "spike") continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      // A suite's own environment is the suite's business: `openCodeServer.test.ts` sets
      // `ANTHROPIC_API_KEY` to prove it is *not* inherited, and that is not configuration
      // an operator passes in.
      if (entry.name.endsWith(".test.ts")) continue;
      found.push({ path, source: readFileSync(path, "utf8") });
    }
  };
  walk(import.meta.dir);
  return found;
};

const turboConfig = JSON.parse(
  readFileSync(join(repositoryRoot, "turbo.json"), "utf8"),
) as {
  readonly tasks: Record<
    string,
    { readonly passThroughEnv?: readonly string[] }
  >;
};

/**
 * Variables `main.ts` reads that are deliberately **not** in `dev`'s list, with the reason.
 *
 * The map exists so an exception has to be written down by name rather than left out of the
 * list, which is indistinguishable from forgetting — and forgetting is exactly what
 * happened to the two this test was written for.
 */
const NOT_PASSED_THROUGH: Readonly<Record<string, string>> = {
  HOME: "turbo passes HOME through by default, and main.ts reads it only as the last fallback for WORKSPACE_ROOT, which is itself in the list",
};

/**
 * Every environment variable name one source file reads.
 *
 * Both syntaxes, and the second one is not padding: the bracket form was all this matched,
 * so a `process.env.FOO` added tomorrow would have been as invisible as a read in another
 * module. `Bun.env` is matched too — it is the same object under a different name, and a
 * reader who used it would not expect a different answer about `bun run dev`.
 */
const readsIn = (source: string): readonly string[] => {
  const found = new Set<string>();
  const patterns = [
    /(?:process|Bun)\.env\[\s*"([A-Z0-9_]+)"\s*\]/g,
    /(?:process|Bun)\.env\.([A-Z0-9_]+)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
  }
  return [...found];
};

/** Every `process.env["NAME"]` literal in `main.ts`'s own source. */
const environmentReads = (): readonly string[] =>
  [...readsIn(mainSource)].sort();

/**
 * The same enumeration over the whole server, as `{ name, where }` pairs.
 *
 * Pairs rather than names, so a failure names the file. One variable read in two modules
 * appears twice, which is correct for a message and does not affect any assertion below.
 */
const serverReads = (): readonly { name: string; where: string }[] =>
  serverModules()
    .flatMap((module) =>
      readsIn(module.source).map((name) => ({
        name,
        where: module.path.slice(repositoryRoot.length + 1),
      })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

describe("the dev command can set everything main.ts configures from", () => {
  const passed = turboConfig.tasks["dev"]?.passThroughEnv ?? [];

  test("the enumeration is not vacuous, so a passing assertion means something", () => {
    // A guard on the guard: if the regex ever stops matching, every assertion below would
    // pass over an empty list.
    const reads = environmentReads();
    expect(reads.length).toBeGreaterThanOrEqual(7);
    expect(reads).toContain("HUNT_ROOT");
    expect(reads).toContain("GOAL_BRIEFING_MAX_CHARS");
    expect(reads).toContain("PLANNER_ROUND_BUDGET");
    expect(passed.length).toBeGreaterThanOrEqual(7);
  });

  test("each is either passed through or a named exclusion with a reason", () => {
    const unaccounted = environmentReads().filter(
      (name) =>
        !passed.includes(name) && NOT_PASSED_THROUGH[name] === undefined,
    );
    // The failure message is the instruction: a name arriving here has two homes, and the
    // next person should not have to work out which.
    expect(unaccounted).toEqual([]);
  });

  test("the walk over the server's modules finds more than main.ts does", () => {
    /*
     * The guard on the widening, in the spirit of the vacuity guard above: an enumeration
     * that silently stopped walking would make the next assertion pass over `main.ts`'s own
     * list again, which is the gap this test was widened to close.
     */
    const everywhere = serverReads();
    expect(serverModules().length).toBeGreaterThan(20);
    // A read somewhere other than the entrypoint, which is the whole finding. It was
    // `CLAUDE_CONFIG_DIR` in the policy gate's module until the gate went (2026-11-06);
    // the scope fixture's `HUNT_ROOT` is one today.
    expect(
      everywhere.some(
        (read) =>
          read.name === "HUNT_ROOT" && read.where.includes("scopeFixture.ts"),
      ),
    ).toBe(true);
  });

  test("every variable the server reads anywhere is accounted for", () => {
    const unaccounted = serverReads().filter(
      (read) =>
        !passed.includes(read.name) &&
        NOT_PASSED_THROUGH[read.name] === undefined,
    );
    // Named with its file, because "which module reads this" is the first thing the next
    // person needs and the thing a bare list of names withholds.
    expect(unaccounted.map((read) => `${read.name} (${read.where})`)).toEqual(
      [],
    );
  });

  test("every exclusion carries a reason, so none is a silent one", () => {
    for (const [name, reason] of Object.entries(NOT_PASSED_THROUGH)) {
      expect(
        reason.length,
        `${name} is excluded with no reason given`,
      ).toBeGreaterThan(20);
    }
  });

  test("the password's variable is passed through, though main.ts names it indirectly", () => {
    // `main.ts` reads it through `PASSWORD_ENV_VAR` rather than as a literal, so the
    // enumeration above cannot see it. Asserted by name instead: a `bun run dev` that
    // could not be given a password would refuse every sign-in.
    expect(passed).toContain("BIT_PASSWORD");
  });
});
