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
 * It reads the two files as text on purpose. Importing `main.ts` would start a server, and
 * `turbo.json` is configuration with no module to import. Both paths are resolved from
 * `import.meta.dir` so the test does not depend on the working directory `bun test` was
 * launched from.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `apps/server/src` → the repository root. */
const repositoryRoot = join(import.meta.dir, "..", "..", "..");

const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

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

/** Every `process.env["NAME"]` literal in `main.ts`'s own source. */
const environmentReads = (): readonly string[] => {
  const found = new Set<string>();
  for (const match of mainSource.matchAll(
    /process\.env\[\s*"([A-Z0-9_]+)"\s*\]/g,
  )) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
};

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
