/**
 * A non-worker session's directory: outside the workspace, or refused.
 *
 * These were the role-directory tests of `policy/install.test.ts` until the policy gate was
 * removed (2026-11-06). The gate's own cases (installed in all three, the audit path's
 * place) went with it; what stays is the layout rule and the symlink resolution it and
 * `createTarget` share.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { FleetStore, UncheckedRoleDirectory } from "../persistence/fleet";
import {
  isWithin,
  resolveThroughSymlinks,
  roleDirectory,
  RoleDirectoryRefused,
  type RoleDirectory,
} from "./roleDirectory";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const withFleet = <A, E>(
  root: string,
  use: (fleet: FleetStore["Service"]) => Effect.Effect<A, E, FleetStore>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(FleetStore, use).pipe(
        Effect.provide(FleetStore.layer(root)),
      ),
    ),
  );

/** A hunt root, a workspace beside it (not inside), and a registered target. */
const layout = async () => {
  const base = mkdtempSync(join(tmpdir(), "bit-roles-"));
  directories.push(base);
  const root = join(base, "hunt");
  const workspace = join(base, "operator-folder");
  mkdirSync(workspace, { recursive: true });
  await withFleet(root, (fleet) =>
    fleet.register({
      targetId: "alpha",
      name: "Alpha",
      scopeNote: "local fixture",
      workspacePath: workspace,
    }),
  );
  return { base, root, workspace };
};

/** `roleDirectory` over a directory this test creates. */
const checkOver = (directory: string, workspace: string | undefined) =>
  Effect.runPromise(
    Effect.result(
      roleDirectory({
        ensure: Effect.sync(() => {
          mkdirSync(directory, { recursive: true });
          return new UncheckedRoleDirectory(directory);
        }),
        workspace,
      }),
    ),
  );

describe("a role directory", () => {
  test("a planner's and a goal agent's are two directories, and the workspace holds neither", async () => {
    const made = await layout();
    const roles = await withFleet(made.root, (fleet) =>
      Effect.gen(function* () {
        const planning = yield* roleDirectory({
          ensure: fleet.ensurePlanningDirectory("alpha", "rnd_1"),
          workspace: made.workspace,
        });
        const goal = yield* roleDirectory({
          ensure: fleet.ensureGoalDirectory("alpha", "goal_1"),
          workspace: made.workspace,
        });
        return { planning, goal };
      }).pipe(Effect.orDie),
    );
    expect(roles.planning).not.toBe(roles.goal);
    expect(readdirSync(made.workspace)).toEqual([]);
    for (const outside of [roles.planning, roles.goal]) {
      expect(outside.startsWith(`${made.workspace}/`)).toBe(false);
    }
    // Nothing is written into it: the policy gate that used to be is gone.
    expect(readdirSync(roles.planning)).toEqual([]);
  });

  test("asking twice for the same round's directory answers the same path", async () => {
    const made = await layout();
    const twice = await withFleet(made.root, (fleet) =>
      Effect.all([
        roleDirectory({
          ensure: fleet.ensurePlanningDirectory("alpha", "rnd_1"),
          workspace: made.workspace,
        }),
        roleDirectory({
          ensure: fleet.ensurePlanningDirectory("alpha", "rnd_1"),
          workspace: made.workspace,
        }),
      ]).pipe(Effect.orDie),
    );
    expect(twice[0]).toBe(twice[1]);
  });

  test("one inside the workspace is refused, by name or through a symlink", async () => {
    const made = await layout();
    const link = join(made.base, "link-to-workspace");
    symlinkSync(made.workspace, link);
    for (const directory of [
      join(made.workspace, "planning", "rnd_1"),
      // A symlink to the workspace is the same place under another name.
      join(link, "goal", "goal_1"),
      // The importer, which is the role an operator actually hit this refusal with.
      join(made.workspace, "import", "imp_1"),
    ]) {
      const refused = await checkOver(directory, made.workspace);
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(refused.failure).toBeInstanceOf(RoleDirectoryRefused);
        const detail = (refused.failure as RoleDirectoryRefused).detail;
        // The rule names the only distinction it draws, not which roles exist.
        expect(detail).toContain("a session that is not a worker");
        // And it says the layout is the problem: not a refusal to retry.
        expect(detail).toContain("HUNT_ROOT");
      }
    }
  });

  test("a workspace that cannot be resolved is refused rather than assumed to be outside", async () => {
    const made = await layout();
    const loop = join(made.base, "loop");
    symlinkSync(loop, loop);
    const refused = await checkOver(
      join(made.root, "targets", "alpha", "goal", "goal_4"),
      join(loop, "workspace"),
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(String(refused.failure)).toContain(
        "refusing rather than guessing",
      );
    }
  });

  test("with no workspace there is nothing to be inside", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_5");
    const checked = await checkOver(directory, undefined);
    expect(checked._tag).toBe("Success");
    if (checked._tag === "Success")
      expect(String(checked.success)).toBe(directory);
  });

  test("a plain string is not a role directory, and an unchecked one is not a string", () => {
    // Checked by tsc: these are the lines that stop a caller handing a session an
    // unchecked path by accident.
    // @ts-expect-error a plain string has not been through roleDirectory
    const fromString: RoleDirectory = "/some/where";
    // @ts-expect-error an unchecked directory is not a string at all
    const fromUnchecked: string = new UncheckedRoleDirectory("/some/where");
    expect(String(fromString)).toBe("/some/where");
    expect(typeof fromUnchecked).toBe("object");
  });
});

describe("resolving a path through symlinks", () => {
  test("follows symlinks through components that do not exist yet", () => {
    const base = mkdtempSync(join(tmpdir(), "bit-resolve-"));
    directories.push(base);
    const real = join(base, "real");
    mkdirSync(real);
    symlinkSync(real, join(base, "link"));
    // `realpath` alone would throw for the last two components.
    expect(
      resolveThroughSymlinks(join(base, "link", "missing", "leaf.log")),
    ).toBe(join(realpathSync(real), "missing", "leaf.log"));
    // An existing path resolves exactly as `realpath` does.
    expect(resolveThroughSymlinks(join(base, "link"))).toBe(realpathSync(real));
  });

  test("a dangling symlink resolves to its target, and is inside where its target is", () => {
    const base = mkdtempSync(join(tmpdir(), "bit-resolve-"));
    directories.push(base);
    const directory = join(base, "role");
    mkdirSync(directory);
    const dangling = join(base, "file-link.log");
    symlinkSync(join(directory, "file.log"), dangling);
    expect(isWithin(directory, dangling)).toBe(true);
    expect(isWithin(directory, join(base, "elsewhere.log"))).toBe(false);
  });
});
