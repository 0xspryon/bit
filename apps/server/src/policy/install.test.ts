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
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime } from "effect";

import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import {
  installPolicyHook,
  POLICY_PLUGIN_PACKAGE,
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
      installPolicyHook({
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
        installPolicyHook({
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
      installPolicyHook({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath: paths.auditPath,
        freshAudit: false,
      }).pipe(Effect.orDie),
    );
    expect(readFileSync(paths.auditPath, "utf8")).toContain("an earlier run");
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
      installPolicyHook({
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
        installPolicyHook({
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
      installPolicyHook({
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
