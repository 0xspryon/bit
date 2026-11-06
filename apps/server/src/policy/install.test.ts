/**
 * Installing the gate, and proving it is reached.
 *
 * The failure this whole file exists to catch is the quiet one: **a hook that is
 * installed but never consulted looks exactly like a hook that is working.** Nothing
 * fails, no decision is recorded, and the only symptom is an audit trail that stays
 * empty — which is indistinguishable from a worker that simply did nothing interesting.
 * So these tests do not assert from the config. They write the plugin to disk, load it
 * the way the harness loads it, let it call a **real policy route on a real listener**,
 * and check what the control plane recorded.
 *
 * What that covers: the file we wrote is loadable, the options we wrote carry a URL that
 * works, the round trip reaches `decide`, the answer comes back with its basis, the audit
 * line is written, and an unreachable control plane still denies. What it does **not**
 * cover is opencode's own plugin discovery — whether `opencode serve` finds and loads
 * what we put in `.opencode/`. That needs a real harness turn and is exercised live;
 * see the report rather than an assertion here.
 *
 * The other half is the filesystem manners a real engagement folder demands. The spike
 * installed into a scratch directory it had created, so clobbering was impossible; a
 * browser-started run installs into a folder an operator chose, which may already hold
 * their own opencode configuration.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime } from "effect";

import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { FleetStore, UngatedRoleDirectory } from "../persistence/fleet";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import {
  gatedRoleDirectory,
  hookSourcePath,
  HOOK_SOURCES_FROM,
  installOpenCodeGate,
  openCodeGateInstaller,
  POLICY_HOOK_FILE,
  PolicyHookNotInstalled,
  POLICY_PLUGIN_PACKAGE,
  resolveThroughSymlinks,
  SERVER_PACKAGE,
  type GatedDirectory,
  withPolicyPlugin,
} from "./install";
import {
  DEFAULT_POLICY,
  PERMISSIVE_POLICY,
  PolicyDecisions,
  type PolicyConfig,
} from "./service";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

/** A workspace and an audit path beside it, as a real run arranges them. */
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "bit-policy-install-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    // Outside the workspace, deliberately: a worker that can read its own audit trail
    // can read the shape of the boundary it is inside.
    auditPath: join(directory, "policy-audit.log"),
    configPath: join(workspace, ".opencode", "opencode.json"),
    hookPath: join(workspace, ".opencode", "policy", "index.ts"),
  };
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/* ── The merge, on its own ───────────────────────────────────────────────────── */

describe("merging into an operator's opencode config", () => {
  const options = { policyUrl: "http://127.0.0.1:1/p", auditPath: "/tmp/a" };

  test("adds our plugin when there is no config at all", () => {
    const merged = withPolicyPlugin(undefined, options);
    expect(merged["plugins"]).toEqual([
      { package: POLICY_PLUGIN_PACKAGE, options },
    ]);
    expect(merged["$schema"]).toBe("https://opencode.ai/config.json");
  });

  test("keeps every key and every other plugin the operator had", () => {
    // The property that matters: this runs against a folder somebody is working in, and
    // a security tool that quietly rewrote their editor configuration would be the worst
    // kind of surprise.
    const existing = {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-x",
      theme: "nord",
      plugins: [{ package: "./their-plugin", options: { a: 1 } }],
      mcp: { somebodyElse: { type: "local" } },
    };
    const merged = withPolicyPlugin(existing, options);
    expect(merged["model"]).toBe("anthropic/claude-x");
    expect(merged["theme"]).toBe("nord");
    expect(merged["mcp"]).toEqual({ somebodyElse: { type: "local" } });
    expect(merged["plugins"]).toEqual([
      { package: "./their-plugin", options: { a: 1 } },
      { package: POLICY_PLUGIN_PACKAGE, options },
    ]);
  });

  test("replaces a previous entry of ours rather than stacking a second", () => {
    // Two copies of the hook would mean two policy round trips per tool call, and an
    // audit file with everything in it twice.
    const once = withPolicyPlugin(undefined, options);
    const twice = withPolicyPlugin(once, {
      policyUrl: "http://127.0.0.1:2/p",
      auditPath: "/tmp/b",
    });
    expect(twice["plugins"]).toEqual([
      {
        package: POLICY_PLUGIN_PACKAGE,
        options: { policyUrl: "http://127.0.0.1:2/p", auditPath: "/tmp/b" },
      },
    ]);
  });
});

/* ── The filesystem ──────────────────────────────────────────────────────────── */

describe("installing into a workspace", () => {
  test("writes the plugin, its manifest and a config that loads it", async () => {
    const paths = scratch();
    await Effect.runPromise(
      installOpenCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/api/v1/policy/decide",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

    expect(existsSync(paths.hookPath)).toBe(true);
    // A *directory* with an entrypoint, not a bare file: opencode skips a configured
    // plugin path that is not a directory.
    expect(
      existsSync(join(paths.workspace, ".opencode", "policy", "package.json")),
    ).toBe(true);
    const config = readJson(paths.configPath);
    expect(config["plugins"]).toEqual([
      {
        package: POLICY_PLUGIN_PACKAGE,
        options: {
          policyUrl: "http://127.0.0.1:9/api/v1/policy/decide",
          auditPath: paths.auditPath,
        },
      },
    ]);
    // The audit file is created outside the workspace, so the worker cannot read it.
    expect(existsSync(paths.auditPath)).toBe(true);
    expect(paths.auditPath.startsWith(paths.workspace)).toBe(false);
  });

  test("refuses rather than overwrite a config it cannot read", async () => {
    // Unparseable to us is not the same as meaningless to them. The one thing a server
    // must not do is destroy a file in somebody's project that it did not understand.
    const paths = scratch();
    mkdirSync(join(paths.workspace, ".opencode"), { recursive: true });
    const theirs = "{ not json, and possibly precious\n";
    await Bun.write(paths.configPath, theirs);

    const refusal = await Effect.runPromise(
      Effect.result(
        installOpenCodeGate({
          workspace: paths.workspace,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath: paths.auditPath,
          freshAudit: true,
        }),
      ),
    );

    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") {
      expect(refusal.failure._tag).toBe("PolicyHookNotInstalled");
      expect(refusal.failure.message).toContain("refusing to overwrite");
    }
    expect(readFileSync(paths.configPath, "utf8")).toBe(theirs);
  });

  test("appends to an existing audit when asked not to start fresh", async () => {
    // A target's audit accumulates across runs; only a single-scope demo wants it empty.
    const paths = scratch();
    await Bun.write(paths.auditPath, '{"from":"an earlier run"}\n');
    await Effect.runPromise(
      installOpenCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath: paths.auditPath,
        freshAudit: false,
      }).pipe(Effect.orDie),
    );
    expect(readFileSync(paths.auditPath, "utf8")).toContain("an earlier run");
  });
});

/* ── Where the hook sources are found ────────────────────────────────────────── */

/**
 * A6 F12: the built server (`bun dist/main.js`) looked for the gates two folders above
 * `dist/`, in `apps/plugins/`, and refused every import `import_ungated`. Both layouts
 * must reach the same file: the package's own `plugins/`.
 */
describe("the hook sources are found in either server layout", () => {
  /** This server package's root: two folders above `src/policy/`. */
  const SERVER_ROOT = join(import.meta.dir, "..", "..");

  test("the dev layout (src/policy) and the build's (dist) find the same plugins", () => {
    const expected = join(SERVER_ROOT, "plugins", POLICY_HOOK_FILE);
    expect(existsSync(expected)).toBe(true);
    expect(hookSourcePath(POLICY_HOOK_FILE)).toBe(expected);
    expect(hookSourcePath(POLICY_HOOK_FILE, HOOK_SOURCES_FROM)).toBe(expected);
    // Where the bundle's `import.meta.dir` is; the folder need not exist for the walk.
    expect(hookSourcePath(POLICY_HOOK_FILE, join(SERVER_ROOT, "dist"))).toBe(
      expected,
    );
    expect(hookSourcePath("claudeCodeGate.ts", join(SERVER_ROOT, "dist"))).toBe(
      join(SERVER_ROOT, "plugins", "claudeCodeGate.ts"),
    );
  });

  /** A copy of the package's shape: a manifest named `name`, and `plugins/<files>`. */
  const fakePackage = (name: string, files: readonly string[]) => {
    const root = mkdtempSync(join(tmpdir(), "bit-hook-sources-"));
    directories.push(root);
    const pkg = join(root, "apps", "server");
    mkdirSync(join(pkg, "plugins"), { recursive: true });
    mkdirSync(join(pkg, "src", "policy"), { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name }));
    for (const file of files)
      writeFileSync(join(pkg, "plugins", file), `// ${file}\n`);
    return { root, pkg };
  };

  test("in a copy of the package, from either layout's folder", () => {
    const { pkg } = fakePackage(SERVER_PACKAGE, ["hook.ts"]);
    const expected = join(pkg, "plugins", "hook.ts");
    expect(hookSourcePath("hook.ts", join(pkg, "src", "policy"))).toBe(
      expected,
    );
    expect(hookSourcePath("hook.ts", join(pkg, "dist"))).toBe(expected);
  });

  test("another package's manifest on the way up is walked past", () => {
    const { pkg } = fakePackage(SERVER_PACKAGE, ["hook.ts"]);
    writeFileSync(
      join(pkg, "dist", "package.json"),
      JSON.stringify({ name: "something-else" }),
    );
    expect(hookSourcePath("hook.ts", join(pkg, "dist"))).toBe(
      join(pkg, "plugins", "hook.ts"),
    );
  });

  test("a plugins folder in a package that is not the server's is not ours", () => {
    const { pkg } = fakePackage("@bit/web", ["hook.ts"]);
    expect(hookSourcePath("hook.ts", join(pkg, "dist"))).toBeUndefined();
  });

  test("the server's package without the file is not found", () => {
    const { pkg } = fakePackage(SERVER_PACKAGE, []);
    expect(hookSourcePath("hook.ts", join(pkg, "dist"))).toBeUndefined();
  });

  test("a missing plugin refuses the install and writes nothing into the workspace", async () => {
    const paths = scratch();
    const { pkg } = fakePackage(SERVER_PACKAGE, []);
    const refusal = await Effect.runPromise(
      Effect.result(
        openCodeGateInstaller(join(pkg, "dist"))({
          workspace: paths.workspace,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath: paths.auditPath,
          freshAudit: true,
        }),
      ),
    );
    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") {
      expect(refusal.failure).toBeInstanceOf(PolicyHookNotInstalled);
      expect(refusal.failure.message).toContain(
        `plugins/${POLICY_HOOK_FILE} was not found`,
      );
    }
    expect(readdirSync(paths.workspace)).toEqual([]);
    expect(existsSync(paths.auditPath)).toBe(false);
  });

  test("the installed plugin is the package's file, byte for byte", async () => {
    const paths = scratch();
    await Effect.runPromise(
      installOpenCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );
    expect(readFileSync(paths.hookPath, "utf8")).toBe(
      readFileSync(join(SERVER_ROOT, "plugins", POLICY_HOOK_FILE), "utf8"),
    );
  });
});

/* ── The gate, actually consulted ────────────────────────────────────────────── */

/**
 * A control plane serving the policy route, with a scope the test chooses.
 *
 * The real route on a real listener, because what is under test is a round trip: a
 * stubbed `decide` would prove the stub.
 */
const listener = (policy: PolicyConfig) => {
  const base = mkdtempSync(join(tmpdir(), "bit-policy-listener-"));
  const store = ObservationStore.layer(join(base, "hunt.sqlite"));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ControlPlaneEndpoint.layer({ policy }),
      PolicyDecisions.layer,
    ).pipe(
      Layer.provideMerge(McpCredentials.layer),
      Layer.provideMerge(McpCallCounter.layer),
      Layer.provideMerge(PolicyDecisions.layer),
      Layer.provideMerge(TargetStores.ofStore("t").pipe(Layer.provide(store))),
    ),
  );
  return { base, runtime };
};

/**
 * Loads the installed plugin the way the harness does, and returns its `execute.before`.
 *
 * A dynamic import of the file we actually wrote — not of `plugins/policyHook.ts` — so a
 * broken copy, a bad path or a plugin that no longer default-exports `{ id, setup }` is
 * caught here rather than silently producing an ungated run. The `ctx` shape is the one
 * opencode passes (`packages/core/src/plugin/module.ts`).
 */
const loadInstalledHook = async (
  hookPath: string,
  options: Record<string, unknown>,
) => {
  const module = (await import(`${hookPath}?v=${String(Date.now())}`)) as {
    default: {
      id: string;
      setup: (ctx: {
        options: Record<string, unknown>;
        tool: {
          hook: (
            name: "execute.before",
            handler: (event: {
              tool: string;
              sessionID: string;
              input: unknown;
            }) => Promise<void>,
          ) => void;
        };
      }) => Promise<void>;
    };
  };
  let before:
    | ((event: {
        tool: string;
        sessionID: string;
        input: unknown;
      }) => Promise<void>)
    | undefined;
  await module.default.setup({
    options,
    tool: {
      hook: (_name, handler) => {
        before = handler;
      },
    },
  });
  if (before === undefined) throw new Error("the hook registered no handler");
  return { id: module.default.id, before };
};

describe("the installed gate is reached", () => {
  let base = "";
  let runtime: ReturnType<typeof listener>["runtime"] | undefined;

  afterAll(async () => {
    await runtime?.dispose();
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  beforeAll(() => {
    const made = listener(PERMISSIVE_POLICY);
    base = made.base;
    runtime = made.runtime;
  });

  test("a tool call round-trips to the control plane and is recorded", async () => {
    const paths = scratch();
    const live = runtime;
    if (live === undefined) throw new Error("no listener");

    const policyUrl = await live.runPromise(
      Effect.map(ControlPlaneEndpoint, (endpoint) => endpoint.policyUrl),
    );
    await Effect.runPromise(
      installOpenCodeGate({
        workspace: paths.workspace,
        policyUrl,
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

    const hook = await loadInstalledHook(paths.hookPath, {
      policyUrl,
      auditPath: paths.auditPath,
    });
    expect(hook.id).toBe("bit.policy.preexecution");

    // The call a worker would make. It must not throw: this scope permits.
    await hook.before({
      tool: "webfetch",
      sessionID: "ses_gate_test",
      input: { url: "https://example.test/admin" },
    });

    // The claim: the control plane *decided* this call. Not "the config says allow" —
    // a decision row, recorded by the route, for the tool and session the hook named.
    const decisions = await live.runPromise(
      Effect.flatMap(PolicyDecisions, (recorded) => recorded.all),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      tool: "webfetch",
      sessionId: "ses_gate_test",
      effect: "allow",
      // Permitted because the scope is unrestricted, not because a host matched —
      // which is exactly the distinction a browser-started run needs to be able to show.
      basis: "unrestricted",
    });

    // And the hook wrote its own line, carrying the basis rather than a bare "allowed".
    const audit = readFileSync(paths.auditPath, "utf8").trim().split("\n");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0] ?? "{}")).toMatchObject({
      tool: "webfetch",
      outcome: "allowed",
      basis: "unrestricted",
    });
  });

  test("a scope with a host boundary still denies through the same path", async () => {
    // The mechanism is the same one; only the config differs. This is what makes
    // "permitting today" a configuration state rather than an absent gate.
    const strict = listener(DEFAULT_POLICY);
    try {
      const paths = scratch();
      const policyUrl = await strict.runtime.runPromise(
        Effect.map(ControlPlaneEndpoint, (endpoint) => endpoint.policyUrl),
      );
      await Effect.runPromise(
        installOpenCodeGate({
          workspace: paths.workspace,
          policyUrl,
          auditPath: paths.auditPath,
          freshAudit: true,
        }).pipe(Effect.orDie),
      );
      const hook = await loadInstalledHook(paths.hookPath, {
        policyUrl,
        auditPath: paths.auditPath,
      });

      await expect(
        hook.before({
          tool: "webfetch",
          sessionID: "ses_denied",
          input: { url: "https://example.test/admin" },
        }),
      ).rejects.toThrow(/Denied by bit policy/);

      const audit = readFileSync(paths.auditPath, "utf8").trim();
      expect(JSON.parse(audit)).toMatchObject({ outcome: "denied" });
    } finally {
      await strict.runtime.dispose();
      rmSync(strict.base, { recursive: true, force: true });
    }
  });

  test("an unreachable control plane still denies, and says it failed closed", async () => {
    // Unrestricted is a decision the gate makes, not the absence of a gate. The hook
    // holds no local copy of the rules, so a control plane it cannot reach cannot
    // degrade into permitting everything — and the audit says which kind of denial it
    // was, so an outage is not mistaken for a boundary.
    const paths = scratch();
    await Effect.runPromise(
      installOpenCodeGate({
        workspace: paths.workspace,
        // A port nothing is listening on.
        policyUrl: "http://127.0.0.1:1/api/v1/policy/decide",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );
    const hook = await loadInstalledHook(paths.hookPath, {
      policyUrl: "http://127.0.0.1:1/api/v1/policy/decide",
      auditPath: paths.auditPath,
    });

    await expect(
      hook.before({
        tool: "read",
        sessionID: "ses_outage",
        input: { filePath: "anything.txt" },
      }),
    ).rejects.toThrow(/could not be consulted/);

    expect(
      JSON.parse(readFileSync(paths.auditPath, "utf8").trim()),
    ).toMatchObject({
      tool: "read",
      outcome: "denied_failclosed",
    });
  });
});

/* ── Three roles, three directories, one gate each ───────────────────────────── */

/**
 * The containment layout, with the real registry making the directories.
 *
 * Spike B (`spike/mcpIsolationProof.ts`) showed that under OpenCode the directory is the
 * only thing separating one session's MCP authority from another's. These tests do not
 * re-prove that; they prove the layout we derived from it: three distinct directories,
 * each with the gate installed, none of the role ones inside the workspace, and the gate
 * in the role directories behaving as it does in the workspace — denying — because
 * "nothing there is expected to act" is the assumption the gate exists to replace.
 */
describe("a planner, a goal agent and a worker each run behind the gate", () => {
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

  const gateFiles = (directory: string) => ({
    config: join(directory, ".opencode", "opencode.json"),
    hook: join(directory, ".opencode", "policy", "index.ts"),
  });

  /** All three directories, gated as a supervisor would arrange them. */
  const gatedThree = async (policyUrl: string) => {
    const made = await layout();
    const auditPath = join(
      made.root,
      "targets",
      "alpha",
      "evidence",
      "audit.log",
    );
    const roles = await withFleet(made.root, (fleet) =>
      Effect.gen(function* () {
        mkdirSync(join(made.root, "targets", "alpha", "evidence"), {
          recursive: true,
        });
        yield* installOpenCodeGate({
          workspace: made.workspace,
          policyUrl,
          auditPath,
          freshAudit: false,
        });
        const planning = yield* gatedRoleDirectory({
          ensure: fleet.ensurePlanningDirectory("alpha", "rnd_1"),
          install: installOpenCodeGate,
          policyUrl,
          auditPath,
          workspace: made.workspace,
        });
        const goal = yield* gatedRoleDirectory({
          ensure: fleet.ensureGoalDirectory("alpha", "goal_1"),
          install: installOpenCodeGate,
          policyUrl,
          auditPath,
          workspace: made.workspace,
        });
        return { planning, goal };
      }).pipe(Effect.orDie),
    );
    return { ...made, ...roles, auditPath };
  };

  test("the gate is installed in all three, and they are three directories", async () => {
    const three = await gatedThree("http://127.0.0.1:9/api/v1/policy/decide");
    const places = [three.workspace, three.planning, three.goal];
    expect(new Set(places).size).toBe(3);
    for (const place of places) {
      const files = gateFiles(place);
      expect(existsSync(files.hook)).toBe(true);
      const config = readJson(files.config);
      expect(JSON.stringify(config)).toContain(POLICY_PLUGIN_PACKAGE);
      expect(JSON.stringify(config)).toContain(three.auditPath);
    }
  });

  test("a denied action in a planner or goal directory is denied, not permitted", async () => {
    const strict = listener(DEFAULT_POLICY);
    try {
      const policyUrl = await strict.runtime.runPromise(
        Effect.map(ControlPlaneEndpoint, (endpoint) => endpoint.policyUrl),
      );
      const three = await gatedThree(policyUrl);
      for (const [role, place] of [
        ["workspace", three.workspace],
        ["planner", three.planning],
        ["goal", three.goal],
      ] as const) {
        const hook = await loadInstalledHook(gateFiles(place).hook, {
          policyUrl,
          auditPath: three.auditPath,
        });
        // The call a planner has no business making. It is the gate, not the planner's
        // good behaviour, that makes this a fact.
        await expect(
          hook.before({
            tool: "webfetch",
            sessionID: `ses_${role}`,
            input: { url: "https://example.test/admin" },
          }),
        ).rejects.toThrow(/Denied by bit policy/);
      }
      const lines = readFileSync(three.auditPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { outcome: string });
      expect(lines.map((line) => line.outcome)).toEqual([
        "denied",
        "denied",
        "denied",
      ]);
    } finally {
      await strict.runtime.dispose();
      rmSync(strict.base, { recursive: true, force: true });
    }
  });

  test("the fail-closed posture holds in the role directories when the control plane is gone", async () => {
    const gone = "http://127.0.0.1:1/api/v1/policy/decide";
    const three = await gatedThree(gone);
    for (const place of [three.planning, three.goal]) {
      const hook = await loadInstalledHook(gateFiles(place).hook, {
        policyUrl: gone,
        auditPath: three.auditPath,
      });
      await expect(
        hook.before({
          tool: "read",
          sessionID: "ses_outage",
          input: { filePath: "anything.txt" },
        }),
      ).rejects.toThrow(/could not be consulted/);
    }
    const outcomes = readFileSync(three.auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { outcome: string }).outcome);
    expect(outcomes).toEqual(["denied_failclosed", "denied_failclosed"]);
  });

  test("the workspace holds nothing of the planner's or the goal agent's", async () => {
    const three = await gatedThree("http://127.0.0.1:9/api/v1/policy/decide");
    // The gate is the worker's own and is allowed; nothing else is.
    const entries = readdirSync(three.workspace, { recursive: true }).map(
      String,
    );
    expect(entries.sort()).toEqual(
      [
        ".opencode",
        ".opencode/opencode.json",
        ".opencode/policy",
        ".opencode/policy/index.ts",
        ".opencode/policy/package.json",
      ].sort(),
    );
    for (const entry of entries) {
      expect(entry).not.toContain("planning");
      expect(entry).not.toContain("goal");
      expect(entry).not.toContain("rnd_1");
    }
    // Neither role directory, nor the audit, is inside the workspace.
    for (const outside of [three.planning, three.goal, three.auditPath]) {
      expect(outside.startsWith(`${three.workspace}/`)).toBe(false);
    }
    // And the worker's config does not name a role directory.
    const config = readFileSync(gateFiles(three.workspace).config, "utf8");
    expect(config).not.toContain(three.planning);
    expect(config).not.toContain(three.goal);
  });

  test("creating a round's directory twice gates it once, and keeps its audit", async () => {
    const policyUrl = "http://127.0.0.1:9/api/v1/policy/decide";
    const three = await gatedThree(policyUrl);
    await Bun.write(three.auditPath, '{"from":"an earlier session"}\n');
    const again = await withFleet(three.root, (fleet) =>
      gatedRoleDirectory({
        ensure: fleet.ensurePlanningDirectory("alpha", "rnd_1"),
        install: installOpenCodeGate,
        policyUrl,
        auditPath: three.auditPath,
        workspace: three.workspace,
      }).pipe(Effect.orDie),
    );
    expect(again).toBe(three.planning);
    const plugins = readJson(gateFiles(again).config)["plugins"] as unknown[];
    expect(plugins).toHaveLength(1);
    expect(readFileSync(three.auditPath, "utf8")).toContain(
      "an earlier session",
    );
  });

  test("a role directory inside the workspace is refused before anything is installed", async () => {
    const made = await layout();
    const inside = join(made.workspace, "planning", "rnd_1");
    const link = join(made.base, "link-to-workspace");
    symlinkSync(made.workspace, link);
    const auditPath = join(made.base, "audit.log");
    for (const [directory, workspace] of [
      [inside, made.workspace],
      // A symlink to the workspace is the same place under another name.
      [join(link, "goal", "goal_1"), made.workspace],
      // The importer, which is the role an operator actually hit this refusal with, and
      // the reason the sentence it carries no longer names only planners and goals.
      [join(made.workspace, "import", "imp_1"), made.workspace],
    ] as const) {
      const refused = await Effect.runPromise(
        Effect.result(
          gatedRoleDirectory({
            ensure: Effect.sync(() => {
              mkdirSync(directory, { recursive: true });
              return new UngatedRoleDirectory(directory);
            }),
            install: installOpenCodeGate,
            policyUrl: "http://127.0.0.1:9/p",
            auditPath,
            workspace,
          }),
        ),
      );
      expect(refused._tag).toBe("Failure");
      if (refused._tag === "Failure") {
        expect(refused.failure).toBeInstanceOf(PolicyHookNotInstalled);
        /*
         * The sentence is about roles, so what it says about them is asserted.
         *
         * It used to read "a planner or goal directory must be outside it", which was
         * written before the scope importer existed — and the importer is what the
         * refusal reached an operator through: they asked for a scope import and were
         * told about planners. The rule has never been about which roles exist, so the
         * wording names the only distinction it actually draws.
         */
        const detail = (refused.failure as PolicyHookNotInstalled).detail;
        expect(detail).toContain("a session that is not a worker");
        expect(detail).not.toContain("a planner or goal directory");
        // And it says the layout is the problem, not the attempt: this refusal is not
        // one to retry.
        expect(detail).toContain("HUNT_ROOT");
      }
      expect(existsSync(join(directory, ".opencode"))).toBe(false);
    }
  });

  test("an audit path inside the role directory is refused", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_1");
    const refused = await Effect.runPromise(
      Effect.result(
        gatedRoleDirectory({
          ensure: Effect.sync(() => {
            mkdirSync(directory, { recursive: true });
            return new UngatedRoleDirectory(directory);
          }),
          install: installOpenCodeGate,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath: join(directory, "audit.log"),
          workspace: undefined,
        }),
      ),
    );
    expect(refused._tag).toBe("Failure");
    expect(existsSync(join(directory, ".opencode"))).toBe(false);
  });

  /** Runs `gatedRoleDirectory` over a directory this test creates. */
  const gateOver = (directory: string, auditPath: string, workspace?: string) =>
    Effect.runPromise(
      Effect.result(
        gatedRoleDirectory({
          ensure: Effect.sync(() => {
            mkdirSync(directory, { recursive: true });
            return new UngatedRoleDirectory(directory);
          }),
          install: installOpenCodeGate,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath,
          workspace,
        }),
      ),
    );

  test("an audit path that reaches the role directory through a symlink is refused, though the file does not exist yet", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_1");
    mkdirSync(directory, { recursive: true });
    const link = join(made.base, "link-to-role");
    symlinkSync(directory, link);
    // The leaf is missing, which is the ordinary state of an audit file: the case a
    // `realpath` that throws on ENOENT silently degrades to a lexical comparison for.
    const auditPath = join(link, "audit.log");
    expect(existsSync(auditPath)).toBe(false);
    const refused = await gateOver(directory, auditPath, undefined);
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(refused.failure).toBeInstanceOf(PolicyHookNotInstalled);
      expect(String(refused.failure)).toContain(
        "inside the directory it records",
      );
    }
    expect(existsSync(join(directory, ".opencode"))).toBe(false);
  });

  test("an audit path reached through a missing directory under a symlink is refused too", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_2");
    mkdirSync(directory, { recursive: true });
    const link = join(made.base, "link-to-role-2");
    symlinkSync(directory, link);
    const refused = await gateOver(
      directory,
      join(link, "not", "yet", "audit.log"),
      undefined,
    );
    expect(refused._tag).toBe("Failure");
    expect(existsSync(join(directory, ".opencode"))).toBe(false);
  });

  test("a dangling symlink whose target is inside the role directory is refused", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_3");
    mkdirSync(directory, { recursive: true });
    // Creating the audit file *through* this link would make it at the target.
    const dangling = join(made.base, "audit-link.log");
    symlinkSync(join(directory, "audit.log"), dangling);
    expect(existsSync(dangling)).toBe(false);
    const refused = await gateOver(directory, dangling, undefined);
    expect(refused._tag).toBe("Failure");
    expect(existsSync(join(directory, ".opencode"))).toBe(false);
  });

  test("a path that cannot be resolved is refused rather than assumed to be outside", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_4");
    mkdirSync(directory, { recursive: true });
    const loop = join(made.base, "loop");
    symlinkSync(loop, loop);
    const refused = await gateOver(
      directory,
      join(loop, "audit.log"),
      undefined,
    );
    expect(refused._tag).toBe("Failure");
    if (refused._tag === "Failure") {
      expect(String(refused.failure)).toContain(
        "refusing rather than guessing",
      );
    }
    expect(existsSync(join(directory, ".opencode"))).toBe(false);
  });

  test("a legitimate audit path outside the directory still passes, symlinks and all", async () => {
    const made = await layout();
    const directory = join(made.root, "targets", "alpha", "goal", "goal_5");
    const evidence = join(made.root, "targets", "alpha", "evidence");
    mkdirSync(evidence, { recursive: true });
    const link = join(made.base, "link-to-evidence");
    symlinkSync(evidence, link);
    const gated = await gateOver(
      directory,
      join(link, "audit.log"),
      made.workspace,
    );
    expect(gated._tag).toBe("Success");
    if (gated._tag === "Success") expect(String(gated.success)).toBe(directory);
  });

  test("resolution follows symlinks through components that do not exist yet", () => {
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

  test("a plain string is not a gated directory, and an ungated one is not a string", () => {
    // Checked by tsc: these are the lines that stop a caller handing a session an
    // ungated path by accident.
    // @ts-expect-error a plain string has not been through gatedRoleDirectory
    const fromString: GatedDirectory = "/some/where";
    // @ts-expect-error an ungated directory is not a string at all
    const fromUngated: string = new UngatedRoleDirectory("/some/where");
    expect(String(fromString)).toBe("/some/where");
    expect(typeof fromUngated).toBe("object");
  });
});
