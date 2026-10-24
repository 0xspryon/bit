/**
 * The server-side OpenCode plugin that enforces our pre-execution policy.
 *
 * This file is copied into the worker's workspace and loaded by `opencode serve` as a
 * local plugin, so it runs inside the harness process — not in our server. Verified
 * against opencode v2.0.32: a plugin must be a **default export** of `{ id, setup }`
 * (`opencode/packages/core/src/plugin/module.ts:78-90`), and throwing from an
 * `execute.before` hook rejects that one tool call before it runs
 * (`packages/plugin/src/promise/adapter.ts:638-642`).
 *
 * It is written without imports on purpose: it is loaded as a standalone entrypoint
 * and must not depend on anything resolvable only from our workspace.
 *
 * **Fails closed.** If the policy service cannot be reached, answers badly, or times
 * out, the call is denied. The hook holds no local copy of the rules, so an
 * unreachable control plane cannot degrade into permitting everything.
 */

const TIMEOUT_MS = 5_000;

interface HookEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
}

interface Decision {
  readonly effect?: string;
  readonly reason?: string;
  /**
   * Why an `allow` was an allow, as the control plane decided it.
   *
   * Written to the audit verbatim and never interpreted here. "Permitted because this
   * engagement has no host boundary" and "permitted because the host was in the list"
   * are different facts, and an audit line that said only `allowed` would have thrown
   * away the one worth reading.
   */
  readonly basis?: string;
}

export default {
  id: "bit.policy.preexecution",
  setup: async (ctx: {
    readonly options: Readonly<Record<string, unknown>>;
    readonly tool: {
      readonly hook: (
        name: "execute.before",
        handler: (event: HookEvent) => Promise<void>,
      ) => Promise<void> | void;
    };
  }) => {
    const policyUrl = ctx.options["policyUrl"];
    if (typeof policyUrl !== "string" || policyUrl.length === 0) {
      // No endpoint configured is itself a missing-connectivity condition.
      throw new Error(
        "bit policy hook: no policyUrl configured; refusing to load",
      );
    }
    const auditPath = ctx.options["auditPath"];

    const audit = async (entry: Record<string, unknown>) => {
      if (typeof auditPath !== "string" || auditPath.length === 0) return;
      try {
        const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
        const existing = await Bun.file(auditPath)
          .text()
          .catch(() => "");
        await Bun.write(auditPath, existing + line);
      } catch {
        // Audit is best-effort; it must never turn a decision into a crash.
      }
    };

    await ctx.tool.hook("execute.before", async (event) => {
      let decision: Decision | null = null;
      let failure = "";
      try {
        const response = await fetch(policyUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: event.sessionID,
            tool: event.tool,
            input: event.input,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          failure = `policy service returned HTTP ${response.status}`;
        } else {
          decision = (await response.json()) as Decision;
        }
      } catch (cause) {
        failure = `policy service unreachable: ${String(cause)}`;
      }

      if (decision === null) {
        await audit({
          tool: event.tool,
          outcome: "denied_failclosed",
          failure,
        });
        throw new Error(
          `Denied by bit policy: ${failure}. The control plane could not be consulted, ` +
            `so this call was refused rather than allowed by default.`,
        );
      }

      if (decision.effect === "deny") {
        const reason = decision.reason ?? "no reason given";
        await audit({ tool: event.tool, outcome: "denied", reason });
        throw new Error(`Denied by bit policy: ${reason}`);
      }

      if (decision.effect !== "allow") {
        await audit({
          tool: event.tool,
          outcome: "denied_unrecognised",
          decision: decision.effect ?? null,
        });
        throw new Error(
          `Denied by bit policy: unrecognised decision '${String(decision.effect)}'.`,
        );
      }

      await audit({
        tool: event.tool,
        outcome: "allowed",
        basis: decision.basis ?? null,
      });
    });
  },
};
