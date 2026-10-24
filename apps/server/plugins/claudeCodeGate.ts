/**
 * The Claude Code `PreToolUse` command hook that enforces our pre-execution policy.
 *
 * This file is copied into the worker's workspace and named in
 * `.claude/settings.local.json`, so Claude Code spawns it as a subprocess before every
 * tool call — not in our server. It is the Claude Code counterpart of
 * `plugins/policyHook.ts`, which is an OpenCode plugin, and the two have nothing in
 * common but the control plane they ask and the audit vocabulary they write; the reason
 * they do not share a module is recorded on `src/policy/install.ts`.
 *
 * It is written without imports on purpose: it is a standalone entrypoint and must not
 * depend on anything resolvable only from our own node_modules.
 *
 * ## The contract, which is not OpenCode's
 *
 * Verified against the hooks reference at https://code.claude.com/docs/en/hooks and
 * exercised live against Claude Code 2.1.306:
 *
 * - **stdin** is a JSON object. The fields this reads are `tool_name`, `tool_input` and
 *   `session_id`.
 * - **exit 2 blocks the call**, and whatever is on stderr becomes the reason the model is
 *   shown. That is the deny path: there is no throwing, because this is a process and not
 *   a function.
 * - **exit 0 with a single JSON object on stdout** is read as a decision. `allow` skips
 *   the permission prompt; the reason is recorded by Claude Code.
 * - **any other exit code is non-blocking**: the call proceeds. So a crash in this script
 *   must never be allowed to look like an allow — hence the single `try` around
 *   everything and {@link deny} as the only way out of it.
 *
 * ## Fails closed twice over, and the second one is structural
 *
 * If the policy service cannot be reached, answers badly, or times out, this exits 2 and
 * the call is blocked. That is the same guarantee the OpenCode plugin makes, and it covers
 * everything that happens *inside* this script.
 *
 * What it does not cover is this script failing to start at all — a missing interpreter, a
 * deleted file — which Claude Code treats as non-blocking by default. Two things close
 * that:
 *
 * 1. The settings entry carries `onFailure: "block"`, so a hook that cannot start, times
 *    out or prints nonsense blocks the call (Claude Code 2.1.295+).
 * 2. The session runs in `dontAsk` permission mode, which **denies anything not
 *    pre-approved**. An allow from this hook is what pre-approves a call, so a gate that
 *    never answers is a worker that cannot act — fail-closed by construction rather than
 *    by configuration. This is the one place where Claude Code's permission model is a
 *    better fit for a gate than OpenCode's: there, a plugin that failed to load would
 *    leave a session that happily ran everything.
 *
 * Because of (2) this hook answers `allow` explicitly rather than staying silent and
 * letting the normal permission flow decide. It is the authority, deliberately.
 */

const TIMEOUT_MS = 5_000;

/** Marks this entry as ours in a settings file we may have to merge into twice. */
const SENTINEL = "--bit-policy-gate";

interface Decision {
  readonly effect?: string;
  readonly reason?: string;
  /**
   * Why an `allow` was an allow, as the control plane decided it.
   *
   * Written to the audit verbatim and never interpreted here. "Permitted because this
   * engagement has no host boundary" and "permitted because the host was in the list" are
   * different facts, and an audit line that said only `allowed` would have thrown away the
   * one worth reading.
   */
  readonly basis?: string;
}

/** Reads `--flag value` pairs out of argv, ignoring the sentinel. */
const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
};

const policyUrl = option("policy-url");
const auditPath = option("audit-path");

const audit = async (entry: Record<string, unknown>): Promise<void> => {
  if (auditPath === undefined || auditPath.length === 0) return;
  try {
    const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
    const existing = await Bun.file(auditPath)
      .text()
      .catch(() => "");
    await Bun.write(auditPath, existing + line);
  } catch {
    // Audit is best-effort; it must never turn a decision into a crash, because a crash
    // here is a non-blocking exit code and the whole point is that nothing slips through.
  }
};

/** Blocks the call. Exit 2 is the only code Claude Code treats as a refusal. */
const deny = (reason: string): never => {
  process.stderr.write(`Denied by bit policy: ${reason}`);
  process.exit(2);
};

/** Pre-approves the call, carrying the control plane's basis as the recorded reason. */
const allow = (basis: string): never => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: `allowed by bit policy (${basis})`,
      },
    }),
  );
  process.exit(0);
};

const main = async (): Promise<never> => {
  if (policyUrl === undefined || policyUrl.length === 0) {
    // No endpoint configured is itself a missing-connectivity condition, so it denies
    // rather than reporting a configuration problem and letting the call through.
    await audit({
      tool: "unknown",
      outcome: "denied_failclosed",
      failure: `no ${SENTINEL} policy URL was configured for this hook`,
    });
    return deny(
      "no policy endpoint is configured for this workspace, so the control plane could not be consulted",
    );
  }

  const raw = await Bun.stdin.text();
  const event = JSON.parse(raw) as {
    tool_name?: unknown;
    tool_input?: unknown;
    session_id?: unknown;
  };
  const tool =
    typeof event.tool_name === "string" ? event.tool_name : "unknown";
  const sessionId =
    typeof event.session_id === "string" ? event.session_id : "unknown";

  let decision: Decision | null = null;
  let failure = "";
  try {
    const response = await fetch(policyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        tool,
        input: event.tool_input,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      failure = `policy service returned HTTP ${String(response.status)}`;
    } else {
      decision = (await response.json()) as Decision;
    }
  } catch (cause) {
    failure = `policy service unreachable: ${String(cause)}`;
  }

  if (decision === null) {
    await audit({ tool, outcome: "denied_failclosed", failure });
    return deny(
      `${failure}. The control plane could not be consulted, so this call was refused rather than allowed by default.`,
    );
  }

  if (decision.effect === "deny") {
    const reason = decision.reason ?? "no reason given";
    await audit({ tool, outcome: "denied", reason });
    return deny(reason);
  }

  if (decision.effect !== "allow") {
    await audit({
      tool,
      outcome: "denied_unrecognised",
      decision: decision.effect ?? null,
    });
    return deny(`unrecognised decision '${String(decision.effect)}'`);
  }

  const basis = decision.basis ?? null;
  await audit({ tool, outcome: "allowed", basis });
  return allow(String(basis));
};

// Everything above is inside one catch, because an uncaught throw leaves a non-zero exit
// code that is *not* 2 — which Claude Code treats as non-blocking, letting the call run.
// A bug in this script must deny, not permit.
try {
  await main();
} catch (cause) {
  await audit({
    tool: "unknown",
    outcome: "denied_failclosed",
    failure: `the policy gate itself failed: ${String(cause)}`,
  });
  deny(
    `the policy gate itself failed (${String(cause)}), so this call was refused rather than allowed by default.`,
  );
}
