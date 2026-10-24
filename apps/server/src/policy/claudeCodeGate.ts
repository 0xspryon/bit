/**
 * Installing the pre-execution policy gate into a workspace Claude Code will run in.
 *
 * The second implementation of {@link GateInstaller}, and the one that proved the first
 * was OpenCode-shaped. The six properties it has to keep are written once, on
 * `policy/install.ts`; what follows is only what is different, because *everything* about
 * the mechanism is.
 *
 * ## Four differences, each of which had to be designed around
 *
 * **A different file.** `.claude/settings.local.json`, not `.opencode/opencode.json`.
 * Claude Code reads three settings files — `~/.claude/settings.json` (user),
 * `.claude/settings.json` (project, committed) and `.claude/settings.local.json` (local,
 * untracked) — and **hook entries merge across all of them** rather than the highest
 * precedence replacing the others. So writing the local file is strictly better than
 * writing the project one: the operator's committed hooks keep running, and the file we
 * touch is the one Claude Code itself keeps out of git. Writing their *committed* settings
 * would have put our entry in their repository, where a `git add -A` would commit it.
 *
 * There is a third option, considered and rejected: the Agent SDK's `settings` option
 * takes a path or an inline object and occupies a session-scoped layer above all three
 * files, so the gate could be installed without touching the workspace at all. It is
 * genuinely cleaner on that one axis and it is not what this does, for two reasons. The
 * gate would then exist only for sessions *we* start, so a workspace we had gated would
 * not be gated for anything else that opened it; and the brief's property 4 — an
 * operator's configuration is merged, and one we cannot parse refuses the run — only means
 * anything if there is a file to merge into. The trade is recorded rather than hidden: we
 * write into somebody's project directory, and the thing that makes that acceptable is
 * that we write only the untracked file and only our own entry in it.
 *
 * **A different shape.** OpenCode takes `plugins: [{ package, options }]` and hands the
 * options to a module it imports. Claude Code takes
 * `hooks.PreToolUse: [{ matcher, hooks: [{ type: "command", command, args, ... }] }]` and
 * spawns a process. There is no options channel, so the policy URL and the audit path go
 * on argv — which is safe here and would not be for a credential: neither is one, the
 * policy endpoint is deliberately unauthenticated (`policy/service.ts`), and both already
 * sit in plain text in the OpenCode config inside the same workspace. DECISIONS.md §6's
 * "credentials off argv" is untouched; the MCP bearer still travels in a request body.
 *
 * **A different way to say no.** The OpenCode plugin throws. This hook is a process: exit
 * 2 blocks the call and stderr becomes the reason. See `plugins/claudeCodeGate.ts`.
 *
 * **A different failure default, and this is the one that matters.** A Claude Code command
 * hook that cannot start, times out or prints nonsense is **non-blocking by default** —
 * the tool call proceeds. An OpenCode plugin that fails to load leaves the same hole. Two
 * things close it here, and the second has no OpenCode equivalent:
 *
 * - `onFailure: "block"` on the hook entry (Claude Code 2.1.295+), which turns any failure
 *   into a block;
 * - the session's `dontAsk` permission mode, which denies anything not pre-approved. An
 *   allow from our gate is what pre-approves a call, so a gate that never answers is a
 *   worker that cannot act. That is fail-closed *structurally*, and it is why
 *   `harness/claudeCodeClient.ts` pins that mode rather than treating it as a preference.
 *
 * Both floors are version-gated, so {@link CLAUDE_CODE_MINIMUM} records them next to the
 * entry that depends on them.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import {
  asRefusal,
  excludeFromGit,
  mergeableConfigAt,
  PolicyHookNotInstalled,
  prepareAudit,
  type GateInstall,
  type GateInstaller,
  type MergeableConfig,
} from "./install";

/**
 * The settings file we merge into, relative to the workspace.
 *
 * The untracked one, deliberately; the reasoning is in this module's header.
 */
export const CLAUDE_SETTINGS_PATH = join(".claude", "settings.local.json");

/** Where the hook script is copied, relative to the workspace. */
export const CLAUDE_GATE_PATH = join(".claude", "bit-policy", "gate.ts");

/** The hook script's source, copied into whichever workspace needs it. */
export const CLAUDE_GATE_SOURCE = join(
  import.meta.dir,
  "..",
  "..",
  "plugins",
  "claudeCodeGate.ts",
);

/**
 * The argv marker that identifies an entry as ours.
 *
 * Idempotence needs a way to recognise our own hook in a settings file that may also hold
 * the operator's. Matching on the script path would work until somebody moved the
 * workspace; matching on `command` would catch every `bun` hook they have. So the entry
 * carries a flag that means nothing to the script except "this is bit's gate", and the
 * merge filters on it. It is also what `plugins/claudeCodeGate.ts` names in its own
 * diagnostics, so a stray entry is traceable from either end.
 */
export const CLAUDE_GATE_SENTINEL = "--bit-policy-gate";

/**
 * The oldest Claude Code build this harness will run against.
 *
 * `onFailure: "block"` is 2.1.295+, and an older build **silently ignores it** — which
 * costs the outer of the two fail-closed guarantees. The inner one (`dontAsk`) still
 * holds there, so the gate would not be absent, only weaker.
 *
 * It is a floor rather than a note anyway, and that is a reversal of the first answer.
 * "Weaker in a way nothing reports" is exactly the condition nobody finds until they read
 * the evidence: a hook that failed to start would have let a tool call through, and the
 * only trace would be an audit file missing a line nobody knew to look for. So
 * `harness/claudeCodeClient.ts` compares the build it is about to run against this at
 * layer-build time and **refuses to offer the harness** below it, the same way an
 * unrecognised `HARNESS` refuses rather than falling back. A server that cannot make the
 * guarantee says so at startup and serves without an agent.
 */
export const CLAUDE_CODE_MINIMUM = "2.1.295";

/**
 * Compares two dotted version strings numerically. Negative when `left` is older.
 *
 * Deliberately not a semver dependency: these are Claude Code's own `major.minor.patch`
 * build numbers, a missing or non-numeric component reads as `0`, and "is this at least
 * that" is the only question asked of it.
 */
export const compareVersions = (left: string, right: string): number => {
  const parts = (value: string): number[] =>
    value.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The two settings keys that would switch our gate off, and how they read.
 *
 * `disableAllHooks` turns off every hook at once; `allowManagedHooksOnly` keeps only the
 * ones an administrator deployed, which ours is not. Either one makes a workspace we have
 * "gated" ungated, with nothing on the hook side to notice it.
 *
 * Truthiness is read the strict way — anything but absent, `false` or `"false"` counts as
 * set — because enterprise configuration routinely yields a boolean as text, and the SDK's
 * own policy-tier handling reads these two keys exactly that way.
 */
const HOOK_DISABLING_KEYS = [
  "disableAllHooks",
  "allowManagedHooksOnly",
] as const;

const disablesHooks = (settings: MergeableConfig): string | undefined =>
  HOOK_DISABLING_KEYS.find((key) => {
    const value = settings[key];
    return value !== undefined && value !== false && value !== "false";
  });

/**
 * Where Claude Code reads settings from, as far as this process can see them.
 *
 * Three files, in its own precedence order. `CLAUDE_CONFIG_DIR` relocates the user tier,
 * so it is honoured rather than assuming `~/.claude`.
 *
 * **This is not every tier.** A managed/MDM source sits above all three and may live at a
 * path this process does not know and may not be able to read; the SDK's `managedSettings`
 * channel can also bind `allowManagedHooksOnly` from a parent process. If hooks are
 * disabled *there*, nothing below can tell, and the run would proceed believing it is
 * gated. That gap is stated rather than papered over: what {@link readableSettingsFiles}
 * covers is the three files an operator edits, which is where this would realistically be
 * set by accident.
 */
export const readableSettingsFiles = (workspace: string): readonly string[] => {
  // `CLAUDE_CONFIG_DIR` *is* the config directory; `HOME` holds `.claude` inside it.
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  const home = process.env["HOME"];
  const user =
    configured !== undefined
      ? join(configured, "settings.json")
      : home !== undefined
        ? join(home, ".claude", "settings.json")
        : undefined;
  return [
    ...(user === undefined ? [] : [user]),
    join(workspace, ".claude", "settings.json"),
    join(workspace, CLAUDE_SETTINGS_PATH),
  ];
};

/** The refusal both checks below raise, worded once. */
const hooksDisabled = (
  workspace: string,
  path: string,
  key: string,
): PolicyHookNotInstalled =>
  new PolicyHookNotInstalled({
    workspace,
    detail: `${path} sets '${key}', which switches off the PreToolUse gate this run would be enforced by; refusing to start an ungated worker. Remove it from that file, or run this engagement in a folder it does not apply to.`,
  });

/**
 * Refuses if a settings tier *other than the one we merge into* has switched hooks off.
 *
 * Same posture as an unparseable configuration, and for the same reason: we are about to
 * tell a caller the workspace is gated, and these are conditions under which it would not
 * be. A file we cannot parse is refused too — not because we would clobber it (we never
 * write these two), but because we cannot establish from it that the gate will run, and
 * "we could not tell" is not a basis for starting an ungated worker.
 *
 * The local file is deliberately **not** checked here: it is the one `mergeableConfigAt`
 * reads, which owns the better message for it ("refusing to overwrite somebody else's
 * configuration"), and the installer checks the parsed result for these keys separately.
 * Two checks on one file would mean whichever ran first decided what an operator reads.
 */
const refuseIfOtherTiersDisableHooks = async (
  input: GateInstall,
): Promise<void> => {
  const local = join(input.workspace, CLAUDE_SETTINGS_PATH);
  for (const path of readableSettingsFiles(input.workspace)) {
    if (path === local) continue;
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const text = await file.text();
    if (text.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new PolicyHookNotInstalled({
        workspace: input.workspace,
        detail: `${path} could not be read as JSON (${String(cause)}), so it cannot be established that Claude Code will run the policy gate; refusing to start an ungated worker`,
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const key = disablesHooks(parsed as MergeableConfig);
    if (key !== undefined) throw hooksDisabled(input.workspace, path, key);
  }
};

/**
 * How long one gate invocation may take before Claude Code gives up on it, in seconds.
 *
 * The script's own HTTP bound is 5 seconds and it answers immediately afterwards, so this
 * is a ceiling on a wedged process rather than a budget for the round trip. Short enough
 * that a hung gate shows up as a blocked call within a tool call's worth of patience,
 * which with `onFailure: "block"` is a refusal rather than a hang.
 */
const HOOK_TIMEOUT_SECONDS = 20;

interface ClaudeSettings extends MergeableConfig {
  readonly hooks?: unknown;
}

/** One `hooks.PreToolUse` matcher group, as far as the merge has to understand it. */
interface MatcherGroup {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
}

/** Whether a matcher group contains an entry this server wrote. */
const isOurs = (group: unknown): boolean => {
  if (typeof group !== "object" || group === null) return false;
  const hooks = (group as MatcherGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (typeof hook !== "object" || hook === null) return false;
    const args = (hook as { args?: unknown }).args;
    return Array.isArray(args) && args.includes(CLAUDE_GATE_SENTINEL);
  });
};

/**
 * Our `PreToolUse` entry merged into whatever settings are already there.
 *
 * Exported so the merge can be tested without a filesystem, exactly like
 * `withPolicyPlugin`: it is the part with the judgement in it.
 *
 * The matcher is `*` — every tool, including MCP tools, whose names are
 * `mcp__<server>__<tool>` and which a narrower matcher would silently skip. A gate that
 * covered only the built-in tools would be a gate with a documented hole in it, and the
 * one tool call worth seeing is the one somebody added a server for.
 *
 * `args` carries the exec form rather than a shell string, which is what keeps a workspace
 * path containing a space from becoming two arguments.
 */
export const withPolicyHook = (
  existing: ClaudeSettings | undefined,
  options: {
    readonly interpreter: string;
    readonly gatePath: string;
    readonly policyUrl: string;
    readonly auditPath: string;
  },
): Record<string, unknown> => {
  const entry = {
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
        timeout: HOOK_TIMEOUT_SECONDS,
        // The outer fail-closed guarantee; see this module's header and
        // {@link CLAUDE_CODE_MINIMUM}.
        onFailure: "block",
        statusMessage: "Consulting the bit policy gate",
      },
    ],
  };

  const hooks =
    typeof existing?.hooks === "object" &&
    existing.hooks !== null &&
    !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const current = Array.isArray(hooks["PreToolUse"]) ? hooks["PreToolUse"] : [];
  // Replace a previous entry of ours rather than appending beside it. Matching groups run
  // in parallel, so two copies would mean two policy round trips per tool call and an
  // audit file with everything in it twice.
  const others = current.filter((group) => !isOurs(group));

  return {
    ...(existing ?? {}),
    hooks: { ...hooks, PreToolUse: [...others, entry] },
  };
};

/**
 * Writes the hook script and the settings entry that runs it.
 *
 * The interpreter is `process.execPath` — this process's own Bun — rather than the string
 * `"bun"`. A hook entry is spawned without a shell, so a bare name would depend on
 * whatever `PATH` the harness inherited, and the one thing worse than a gate that denies
 * is a gate that cannot be found.
 */
export const installClaudeCodeGate: GateInstaller = Effect.fnUntraced(
  function* (input: GateInstall) {
    return yield* Effect.tryPromise({
      try: async () => {
        const gatePath = join(input.workspace, CLAUDE_GATE_PATH);
        const settingsPath = join(input.workspace, CLAUDE_SETTINGS_PATH);

        // Both checks happen before anything is written, because a workspace whose
        // settings switch hooks off is a workspace we cannot gate — and installing into it
        // would leave a gate that is present on disk and never consulted, which is the one
        // failure mode indistinguishable from a working one.
        await refuseIfOtherTiersDisableHooks(input);

        const existing = (await mergeableConfigAt(
          input.workspace,
          settingsPath,
        )) as ClaudeSettings | undefined;
        const disabledLocally =
          existing === undefined ? undefined : disablesHooks(existing);
        if (disabledLocally !== undefined) {
          throw hooksDisabled(input.workspace, settingsPath, disabledLocally);
        }

        mkdirSync(join(gatePath, ".."), { recursive: true });
        await prepareAudit(input);
        await Bun.write(gatePath, await Bun.file(CLAUDE_GATE_SOURCE).text());
        await Bun.write(
          settingsPath,
          `${JSON.stringify(
            withPolicyHook(existing, {
              interpreter: process.execPath,
              gatePath,
              policyUrl: input.policyUrl,
              auditPath: input.auditPath,
            }),
            null,
            2,
          )}\n`,
        );
        // Both of these are files *we* create, and the reason for choosing the local
        // settings file over the committed one only holds if they stay out of the
        // operator's commits. Nothing else makes that true; see `excludeFromGit`.
        await excludeFromGit(input.workspace, [
          CLAUDE_SETTINGS_PATH,
          `${join(".claude", "bit-policy")}/`,
        ]);
      },
      catch: asRefusal(input.workspace),
    });
  },
);
