/**
 * Installing the Claude Code gate, and proving it is reached.
 *
 * The same failure `policy/install.test.ts` exists to catch, in a mechanism that shares
 * none of its parts: **a gate that is installed but never consulted looks exactly like a
 * gate that is working.** Nothing fails, no decision is recorded, and the only symptom is
 * an audit trail that stays empty — which is indistinguishable from a worker that simply
 * did nothing interesting.
 *
 * So these tests do not assert from the settings file. They install into a scratch
 * workspace, **read the command and argv back out of the settings we wrote**, spawn exactly
 * that, feed it the `PreToolUse` payload Claude Code feeds a hook on stdin, and check three
 * things: the process's exit code, which is the only thing Claude Code reads as a refusal;
 * the decision the control plane recorded, on a real listener; and the audit line.
 *
 * Spawning what the settings name, rather than a path this file knows, is deliberate. A
 * hook entry that pointed at a file we did not write, or carried argv the script does not
 * parse, would pass a test that called the script directly and produce an ungated run in
 * production.
 *
 * What these do **not** cover is Claude Code's own hook dispatch — whether the CLI reads
 * `.claude/settings.local.json` from a session's `cwd` and runs what it finds there. That
 * needs a real Claude Code turn and is exercised live; see the report rather than an
 * assertion here.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime } from "effect";

import { ControlPlaneEndpoint } from "../http/controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import {
  CLAUDE_CODE_MINIMUM,
  CLAUDE_GATE_PATH,
  CLAUDE_GATE_SENTINEL,
  CLAUDE_SETTINGS_PATH,
  compareVersions,
  installClaudeCodeGate,
  readableSettingsFiles,
  withPolicyHook,
} from "./claudeCodeGate";
import { installOpenCodeGate } from "./install";
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
  const directory = mkdtempSync(join(tmpdir(), "bit-claude-gate-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
  return {
    workspace,
    // Outside the workspace, deliberately: a worker that can read its own audit trail can
    // read the shape of the boundary it is inside.
    auditPath: join(directory, "policy-audit.log"),
    settingsPath: join(workspace, CLAUDE_SETTINGS_PATH),
    gatePath: join(workspace, CLAUDE_GATE_PATH),
  };
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/* ── The merge, on its own ───────────────────────────────────────────────────── */

describe("merging into an operator's Claude Code settings", () => {
  const options = {
    interpreter: "/usr/bin/bun",
    gatePath: "/ws/.claude/bit-policy/gate.ts",
    policyUrl: "http://127.0.0.1:1/p",
    auditPath: "/tmp/a",
  };

  /** Our entry, as a shape the assertions below can read without repeating it. */
  const ourEntry = (merged: Record<string, unknown>) => {
    const hooks = merged["hooks"] as { PreToolUse?: unknown[] } | undefined;
    const groups = hooks?.PreToolUse ?? [];
    return groups.filter((group) =>
      JSON.stringify(group).includes(CLAUDE_GATE_SENTINEL),
    );
  };

  test("adds a PreToolUse entry when there are no settings at all", () => {
    const merged = withPolicyHook(undefined, options);
    const hooks = merged["hooks"] as { PreToolUse: unknown[] };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]).toEqual({
      // Every tool, including `mcp__*`, which a narrower matcher would silently skip.
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: options.interpreter,
          args: [
            options.gatePath,
            CLAUDE_GATE_SENTINEL,
            "--policy-url",
            options.policyUrl,
            "--audit-path",
            options.auditPath,
          ],
          timeout: 20,
          // The outer fail-closed guarantee: a hook that cannot start, times out or
          // prints nonsense blocks the call rather than letting it through.
          onFailure: "block",
          statusMessage: "Consulting the bit policy gate",
        },
      ],
    });
  });

  test("keeps every key and every other hook the operator had", () => {
    // The property that matters: this runs against a folder somebody is working in, and a
    // security tool that quietly rewrote their editor configuration would be the worst
    // kind of surprise. Hook entries merge across Claude Code's settings files, so their
    // committed hooks keep running either way — but the file we touch is still theirs.
    const existing = {
      model: "claude-opus-4-8",
      permissions: { allow: ["Bash(git *)"] },
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "theirs" }] },
        ],
      },
    };
    const merged = withPolicyHook(existing, options);
    expect(merged["model"]).toBe("claude-opus-4-8");
    expect(merged["permissions"]).toEqual({ allow: ["Bash(git *)"] });
    const hooks = merged["hooks"] as {
      PostToolUse: unknown[];
      PreToolUse: unknown[];
    };
    expect(hooks.PostToolUse).toEqual(existing.hooks.PostToolUse);
    expect(hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(ourEntry(merged)).toHaveLength(1);
  });

  test("replaces a previous entry of ours rather than stacking a second", () => {
    // Matching PreToolUse groups run in parallel, so two copies would mean two policy
    // round trips per tool call and an audit file with everything in it twice.
    const once = withPolicyHook(undefined, options);
    const twice = withPolicyHook(once, {
      ...options,
      policyUrl: "http://127.0.0.1:2/p",
    });
    expect(ourEntry(twice)).toHaveLength(1);
    expect(JSON.stringify(ourEntry(twice))).toContain("http://127.0.0.1:2/p");
    expect(JSON.stringify(ourEntry(twice))).not.toContain(
      "http://127.0.0.1:1/p",
    );
  });
});

/* ── The filesystem ──────────────────────────────────────────────────────────── */

describe("installing into a workspace", () => {
  test("writes the gate script and settings that run it", async () => {
    const paths = scratch();
    await Effect.runPromise(
      installClaudeCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/api/v1/policy/decide",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

    expect(readFileSync(paths.gatePath, "utf8")).toContain("hookEventName");
    const settings = readJson(paths.settingsPath);
    const hooks = settings["hooks"] as { PreToolUse: unknown[] };
    expect(hooks.PreToolUse).toHaveLength(1);
    // The interpreter is this process's own Bun, not the string "bun": a hook entry is
    // spawned without a shell, so a bare name would depend on the harness's PATH.
    expect(JSON.stringify(hooks.PreToolUse)).toContain(process.execPath);
    // The audit file is created outside the workspace, so the worker cannot read it.
    expect(paths.auditPath.startsWith(paths.workspace)).toBe(false);
    expect(await Bun.file(paths.auditPath).exists()).toBe(true);
  });

  test("the local settings file is the one written, not the committed one", async () => {
    // `.claude/settings.json` is the file an operator commits. Writing our entry there
    // would put it in their repository, where a `git add -A` would commit it; hooks merge
    // across both files, so the untracked one costs nothing.
    const paths = scratch();
    await Effect.runPromise(
      installClaudeCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );
    expect(paths.settingsPath.endsWith("settings.local.json")).toBe(true);
    expect(
      await Bun.file(
        join(paths.workspace, ".claude", "settings.json"),
      ).exists(),
    ).toBe(false);
  });

  test("refuses rather than overwrite settings it cannot read", async () => {
    // Unparseable to us is not the same as meaningless to them. This is the refusal the
    // supervisor turns into `workspace_ungated`, so the run never starts.
    const paths = scratch();
    mkdirSync(join(paths.workspace, ".claude"), { recursive: true });
    const theirs = "{ not json, and possibly precious\n";
    await Bun.write(paths.settingsPath, theirs);

    const refusal = await Effect.runPromise(
      Effect.result(
        installClaudeCodeGate({
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
    expect(readFileSync(paths.settingsPath, "utf8")).toBe(theirs);
  });

  test("appends to an existing audit when asked not to start fresh", async () => {
    // A target's audit accumulates across runs, and across harnesses: one engagement's
    // trail is one file whichever agent produced the lines in it.
    const paths = scratch();
    await Bun.write(paths.auditPath, '{"from":"an earlier run"}\n');
    await Effect.runPromise(
      installClaudeCodeGate({
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
 * The real route on a real listener, because what is under test is a round trip: a stubbed
 * `decide` would prove the stub.
 */
const listener = (policy: PolicyConfig) => {
  const base = mkdtempSync(join(tmpdir(), "bit-claude-listener-"));
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
 * Runs the installed gate the way Claude Code runs it: the command and argv the settings
 * name, with the hook payload on stdin.
 *
 * Returns the exit code, because that is the whole of what Claude Code reads as a decision
 * — `2` blocks, `0` with JSON on stdout decides, anything else lets the call through.
 */
const invokeGate = async (
  settingsPath: string,
  event: { tool_name: string; session_id: string; tool_input: unknown },
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const settings = readJson(settingsPath);
  const groups = (settings["hooks"] as { PreToolUse: unknown[] }).PreToolUse;
  const ours = groups.find((group) =>
    JSON.stringify(group).includes(CLAUDE_GATE_SENTINEL),
  ) as { hooks: { command: string; args: string[] }[] };
  const entry = ours.hooks[0];
  if (entry === undefined) throw new Error("the settings carry no hook entry");
  const child = Bun.spawn([entry.command, ...entry.args], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: "PreToolUse", ...event }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
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
      installClaudeCodeGate({
        workspace: paths.workspace,
        policyUrl,
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

    const run = await invokeGate(paths.settingsPath, {
      tool_name: "WebFetch",
      session_id: "4f1c1d2e-0000-4000-8000-000000000001",
      tool_input: { url: "https://example.test/admin" },
    });

    // Exit 0 and an explicit allow: the session runs in `dontAsk`, so the gate is the
    // authority and silence would deny. That is the inversion that makes Claude Code's
    // permission model a better fit for a gate than OpenCode's.
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "allowed by bit policy (unrestricted)",
      },
    });

    // The claim: the control plane *decided* this call. Not "the settings say allow" — a
    // decision row, recorded by the route, for the tool and session the hook named.
    const decisions = await live.runPromise(
      Effect.flatMap(PolicyDecisions, (recorded) => recorded.all),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      tool: "WebFetch",
      sessionId: "4f1c1d2e-0000-4000-8000-000000000001",
      effect: "allow",
      // Permitted because the scope is unrestricted, not because a host matched — the same
      // basis vocabulary the OpenCode gate writes, so one reader handles both trails.
      basis: "unrestricted",
    });

    const audit = readFileSync(paths.auditPath, "utf8").trim().split("\n");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0] ?? "{}")).toMatchObject({
      tool: "WebFetch",
      outcome: "allowed",
      basis: "unrestricted",
    });
  });

  test("a scope with a host boundary denies through the same path, with exit 2", async () => {
    // The mechanism is the same one; only the config differs. This is what makes
    // "permitting today" a configuration state rather than an absent gate.
    const strict = listener(DEFAULT_POLICY);
    try {
      const paths = scratch();
      const policyUrl = await strict.runtime.runPromise(
        Effect.map(ControlPlaneEndpoint, (endpoint) => endpoint.policyUrl),
      );
      await Effect.runPromise(
        installClaudeCodeGate({
          workspace: paths.workspace,
          policyUrl,
          auditPath: paths.auditPath,
          freshAudit: true,
        }).pipe(Effect.orDie),
      );

      const run = await invokeGate(paths.settingsPath, {
        tool_name: "WebFetch",
        session_id: "4f1c1d2e-0000-4000-8000-000000000002",
        tool_input: { url: "https://example.test/admin" },
      });

      // 2, and nothing else: 1 would let the call proceed.
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("Denied by bit policy");
      expect(run.stderr).toContain("not in the engagement scope");

      expect(
        JSON.parse(readFileSync(paths.auditPath, "utf8").trim()),
      ).toMatchObject({ outcome: "denied" });
    } finally {
      await strict.runtime.dispose();
      rmSync(strict.base, { recursive: true, force: true });
    }
  });

  test("an unreachable control plane still denies, and says it failed closed", async () => {
    // Unrestricted is a decision the gate makes, not the absence of a gate. The hook holds
    // no local copy of the rules, so a control plane it cannot reach cannot degrade into
    // permitting everything — and the audit says which kind of denial it was, so an outage
    // is not mistaken for a boundary.
    const paths = scratch();
    await Effect.runPromise(
      installClaudeCodeGate({
        workspace: paths.workspace,
        // A port nothing is listening on.
        policyUrl: "http://127.0.0.1:1/api/v1/policy/decide",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

    const run = await invokeGate(paths.settingsPath, {
      tool_name: "Read",
      session_id: "4f1c1d2e-0000-4000-8000-000000000003",
      tool_input: { file_path: "anything.txt" },
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("could not be consulted");
    expect(
      JSON.parse(readFileSync(paths.auditPath, "utf8").trim()),
    ).toMatchObject({ tool: "Read", outcome: "denied_failclosed" });
  });

  test("a second install leaves one entry, and it is the current one", async () => {
    // Idempotence through the filesystem rather than through the merge function, because
    // the thing that must not stack is what ends up on disk.
    const paths = scratch();
    const live = runtime;
    if (live === undefined) throw new Error("no listener");
    const policyUrl = await live.runPromise(
      Effect.map(ControlPlaneEndpoint, (endpoint) => endpoint.policyUrl),
    );
    for (const url of ["http://127.0.0.1:1/stale", policyUrl]) {
      await Effect.runPromise(
        installClaudeCodeGate({
          workspace: paths.workspace,
          policyUrl: url,
          auditPath: paths.auditPath,
          freshAudit: true,
        }).pipe(Effect.orDie),
      );
    }
    const settings = readJson(paths.settingsPath);
    const groups = (settings["hooks"] as { PreToolUse: unknown[] }).PreToolUse;
    expect(groups).toHaveLength(1);

    // And the surviving entry is the live one: one invocation, one decision.
    const before = (
      await live.runPromise(
        Effect.flatMap(PolicyDecisions, (recorded) => recorded.all),
      )
    ).length;
    const run = await invokeGate(paths.settingsPath, {
      tool_name: "Bash",
      session_id: "4f1c1d2e-0000-4000-8000-000000000004",
      tool_input: { command: "ls" },
    });
    expect(run.code).toBe(0);
    const after = await live.runPromise(
      Effect.flatMap(PolicyDecisions, (recorded) => recorded.all),
    );
    expect(after.length).toBe(before + 1);
    expect(
      readFileSync(paths.auditPath, "utf8").trim().split("\n"),
    ).toHaveLength(1);
  });
});

/* ── Refusing what cannot be gated ───────────────────────────────────────────── */

describe("settings that would switch the gate off", () => {
  const install = (workspace: string, auditPath: string) =>
    Effect.runPromise(
      Effect.result(
        installClaudeCodeGate({
          workspace,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath,
          freshAudit: true,
        }),
      ),
    );

  for (const key of ["disableAllHooks", "allowManagedHooksOnly"]) {
    for (const value of [true, "true"]) {
      test(`${key}: ${JSON.stringify(value)} in the project settings refuses the run`, async () => {
        // A gate installed into a workspace whose settings turn hooks off is present on
        // disk and never consulted, which is the one failure mode indistinguishable from
        // a working gate. Refused, with the file and the key named.
        const paths = scratch();
        mkdirSync(join(paths.workspace, ".claude"), { recursive: true });
        await Bun.write(
          join(paths.workspace, ".claude", "settings.json"),
          JSON.stringify({ [key]: value }),
        );
        const refusal = await install(paths.workspace, paths.auditPath);
        expect(refusal._tag).toBe("Failure");
        if (refusal._tag === "Failure") {
          expect(refusal.failure._tag).toBe("PolicyHookNotInstalled");
          expect(refusal.failure.message).toContain(key);
          expect(refusal.failure.message).toContain("ungated worker");
        }
        // And nothing was written: a refusal leaves the workspace as it was.
        expect(await Bun.file(paths.gatePath).exists()).toBe(false);
        expect(await Bun.file(paths.settingsPath).exists()).toBe(false);
      });
    }
  }

  test("an explicit false is not a refusal", async () => {
    // `false` is the default said out loud. Refusing it would make writing down the safe
    // value an error.
    const paths = scratch();
    mkdirSync(join(paths.workspace, ".claude"), { recursive: true });
    await Bun.write(
      join(paths.workspace, ".claude", "settings.json"),
      JSON.stringify({ disableAllHooks: false, model: "claude-opus-5" }),
    );
    const outcome = await install(paths.workspace, paths.auditPath);
    expect(outcome._tag).toBe("Success");
  });

  test("the local settings file is checked too, before being merged into", async () => {
    const paths = scratch();
    mkdirSync(join(paths.workspace, ".claude"), { recursive: true });
    await Bun.write(
      paths.settingsPath,
      JSON.stringify({ allowManagedHooksOnly: true }),
    );
    const refusal = await install(paths.workspace, paths.auditPath);
    expect(refusal._tag).toBe("Failure");
    // Their file is untouched, not merged into and then found unusable.
    expect(JSON.parse(await Bun.file(paths.settingsPath).text())).toEqual({
      allowManagedHooksOnly: true,
    });
  });

  test("the user tier is read from CLAUDE_CONFIG_DIR when it is set", async () => {
    // `CLAUDE_CONFIG_DIR` relocates the whole config home, so assuming `~/.claude` would
    // read a file Claude Code is not reading.
    const paths = scratch();
    const configDir = join(paths.workspace, "..", "fake-config");
    mkdirSync(configDir, { recursive: true });
    await Bun.write(
      join(configDir, "settings.json"),
      JSON.stringify({ disableAllHooks: true }),
    );
    expect(readableSettingsFiles(paths.workspace)).not.toContain(
      join(configDir, "settings.json"),
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = configDir;
    try {
      expect(readableSettingsFiles(paths.workspace)[0]).toBe(
        join(configDir, "settings.json"),
      );
      const refusal = await install(paths.workspace, paths.auditPath);
      expect(refusal._tag).toBe("Failure");
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
    }
  });

  test("settings we cannot parse refuse too, for a different reason", async () => {
    // Not a clobber risk — we never write the project file — but we cannot establish from
    // it that the gate will run, and "we could not tell" is not a basis for starting an
    // ungated worker.
    const paths = scratch();
    mkdirSync(join(paths.workspace, ".claude"), { recursive: true });
    await Bun.write(
      join(paths.workspace, ".claude", "settings.json"),
      "{ nope",
    );
    const refusal = await install(paths.workspace, paths.auditPath);
    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") {
      expect(refusal.failure.message).toContain("cannot be established");
    }
  });
});

/* ── The build floor ─────────────────────────────────────────────────────────── */

describe("the Claude Code build floor", () => {
  test("compares dotted versions numerically, not as strings", () => {
    // `"2.1.9" > "2.1.10"` lexically, which is the bug this exists to not have.
    expect(compareVersions("2.1.310", CLAUDE_CODE_MINIMUM)).toBeGreaterThan(0);
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.295", CLAUDE_CODE_MINIMUM)).toBe(0);
    expect(compareVersions("2.2.0", "2.1.999")).toBeGreaterThan(0);
    expect(compareVersions("3", "2.9.9")).toBeGreaterThan(0);
    // A missing or non-numeric component reads as 0 rather than throwing.
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("", "0")).toBe(0);
  });
});

/* ── Keeping our files out of the operator's commits ─────────────────────────── */

describe("the files we create stay out of git", () => {
  /** A workspace that is a git working tree, as far as this helper needs one. */
  const asRepository = (workspace: string) => {
    mkdirSync(join(workspace, ".git", "info"), { recursive: true });
    return join(workspace, ".git", "info", "exclude");
  };

  test("the gate script and our settings file are excluded per clone", async () => {
    // `.git/info/exclude` rather than a `.gitignore`: a `.gitignore` is itself a file in
    // their repository, which is the problem rather than the fix.
    const paths = scratch();
    const excludePath = asRepository(paths.workspace);
    await Bun.write(excludePath, "# their own rules\nbuild/\n");

    await Effect.runPromise(
      installClaudeCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

    const excludes = await Bun.file(excludePath).text();
    // Theirs survives.
    expect(excludes).toContain("# their own rules");
    expect(excludes).toContain("build/");
    expect(excludes).toContain(CLAUDE_SETTINGS_PATH);
    expect(excludes).toContain(".claude/bit-policy/");
  });

  test("a second install does not duplicate the lines", async () => {
    const paths = scratch();
    const excludePath = asRepository(paths.workspace);
    await Bun.write(excludePath, "");
    for (let run = 0; run < 2; run += 1) {
      await Effect.runPromise(
        installClaudeCodeGate({
          workspace: paths.workspace,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath: paths.auditPath,
          freshAudit: true,
        }).pipe(Effect.orDie),
      );
    }
    const lines = (await Bun.file(excludePath).text())
      .split("\n")
      .filter((line) => line === CLAUDE_SETTINGS_PATH);
    expect(lines).toHaveLength(1);
  });

  test("a workspace that is not a git tree installs anyway", async () => {
    // Not being in a repository is the ordinary case, not an error, and tidiness must not
    // be able to refuse a run whose gate is otherwise installed.
    const paths = scratch();
    const outcome = await Effect.runPromise(
      Effect.result(
        installClaudeCodeGate({
          workspace: paths.workspace,
          policyUrl: "http://127.0.0.1:9/p",
          auditPath: paths.auditPath,
          freshAudit: true,
        }),
      ),
    );
    expect(outcome._tag).toBe("Success");
    expect(await Bun.file(paths.gatePath).exists()).toBe(true);
  });

  test("a .git pointer file is followed to the real git directory", async () => {
    // A worktree or submodule has `.git` as a file. Writing `info/exclude` next to that
    // file would create a directory nothing reads.
    const paths = scratch();
    const real = join(paths.workspace, "..", "real-git-dir");
    mkdirSync(join(real, "info"), { recursive: true });
    await Bun.write(join(real, "info", "exclude"), "");
    await Bun.write(join(paths.workspace, ".git"), `gitdir: ${real}\n`);

    await Effect.runPromise(
      installClaudeCodeGate({
        workspace: paths.workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath: paths.auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );
    expect(await Bun.file(join(real, "info", "exclude")).text()).toContain(
      ".claude/bit-policy/",
    );
  });

  const installOpenCode = (workspace: string, auditPath: string) =>
    Effect.runPromise(
      installOpenCodeGate({
        workspace,
        policyUrl: "http://127.0.0.1:9/p",
        auditPath,
        freshAudit: true,
      }).pipe(Effect.orDie),
    );

  test("the OpenCode gate excludes its plugin directory, and the config it created", async () => {
    // An ignore rule cannot hide a file git already tracks, so the only harm excluding can
    // do is stop an *untracked* file of theirs reaching a later `git add`. Nothing of
    // theirs was here, so both of these are ours.
    const paths = scratch();
    const excludePath = asRepository(paths.workspace);
    await Bun.write(excludePath, "");
    await installOpenCode(paths.workspace, paths.auditPath);
    const excludes = await Bun.file(excludePath).text();
    expect(excludes).toContain(".opencode/policy/");
    expect(excludes).toContain(".opencode/opencode.json");
  });

  test("an opencode config the operator already had is left theirs to commit", async () => {
    // We merged into it rather than creating it, and an operator may well want their own
    // opencode configuration tracked. Quietly stopping them would be the same kind of
    // surprise as overwriting it.
    const paths = scratch();
    const excludePath = asRepository(paths.workspace);
    await Bun.write(excludePath, "");
    mkdirSync(join(paths.workspace, ".opencode"), { recursive: true });
    await Bun.write(
      join(paths.workspace, ".opencode", "opencode.json"),
      JSON.stringify({ theme: "nord" }),
    );
    await installOpenCode(paths.workspace, paths.auditPath);
    const excludes = await Bun.file(excludePath).text();
    expect(excludes).toContain(".opencode/policy/");
    expect(excludes).not.toContain("opencode.json");
    // And their key survived the merge.
    expect(
      JSON.parse(
        await Bun.file(
          join(paths.workspace, ".opencode", "opencode.json"),
        ).text(),
      )["theme"],
    ).toBe("nord");
  });
});
