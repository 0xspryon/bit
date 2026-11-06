/**
 * bit's own settings, which an agent's environment does not carry.
 *
 * Every variable this server configures itself from (`main.ts`, and `turbo.json`'s `dev`
 * pass-through list) names something about *this* process — where its fleet lives, the
 * port it serves, which harness it defaults to, its browser password — and means nothing
 * to an agent. A Claude Code CLI inherited all of them, and through it so did every shell
 * command the model ran and every MCP server of the operator's the CLI started: `env` in a
 * session printed `HUNT_ROOT`, `WORKSPACE_ROOT`, `PORT` and `HARNESS` (final review,
 * 2026-11-06). `PORT` in particular is a name other programs read as their own.
 *
 * **A denylist here, where OpenCode's is an allowlist** (`openCodeServer.ts`,
 * `HARNESS_ENVIRONMENT_ALLOWLIST`), and the difference is deliberate. `opencode serve` is
 * bit's own long-lived server, authenticated from its credential store under `HOME`, so
 * naming what it needs is affordable. The Claude Code CLI is the operator's agent, run "as
 * if I launched it" (the plan's "Policy gate removed" entry): it authenticates from
 * whatever the operator exports (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, a Bedrock
 * or Vertex set, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`), and the operator's MCP servers
 * it starts read their own tokens the same way. An allowlist would break both silently, so
 * this takes out bit's names and leaves the rest as the operator's shell had it. The two
 * lists are kept disjoint by a test, so neither hands an agent a bit setting.
 *
 * `BIT_PASSWORD` is also deleted from this process's own environment at startup
 * (`http/browserSessions.ts`); it is listed here as well, so the scrub does not depend on
 * that having run first.
 */

/** The variables bit reads its own configuration from. A test keeps it complete. */
export const BIT_ENVIRONMENT: readonly string[] = [
  "BIT_PASSWORD",
  "BIT_SERVER_URL",
  "HUNT_ROOT",
  "WORKSPACE_ROOT",
  "PORT",
  "HARNESS",
  "TARGET_ID",
  "RECONCILE_ON_START",
  "CONTINUATION",
  "CONTINUE_ON_START",
  "PLANNER_ROUND_BUDGET",
  "GOAL_BRIEFING_MAX_CHARS",
  "UPLOAD_MAX_BYTES",
  "UPLOAD_MAX_FILES",
  "UPLOAD_MAX_IMAGE_BYTES",
  "UPLOAD_MAX_TOTAL_BYTES",
];

/** `environment` without {@link BIT_ENVIRONMENT}'s names; everything else as it was. */
export const agentEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const scrubbed: Record<string, string | undefined> = { ...environment };
  for (const name of BIT_ENVIRONMENT) delete scrubbed[name];
  return scrubbed;
};
