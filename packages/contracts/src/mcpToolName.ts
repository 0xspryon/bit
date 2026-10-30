/**
 * What a tool this server registered is *called*, once a harness has namespaced it.
 *
 * ## Why this is a module and not two template literals
 *
 * A planner round's tools reach it over MCP, and the two drivers rename them on the way
 * in. The round's own view has to recognise `add_intent` to apply the
 * pending-until-recorded merge rule — the rule the planner chat exists for — and against a
 * real round it never did, because the name on the wire is not the name in the toolkit:
 *
 * | Driver | Observed form | Evidence |
 * | --- | --- | --- |
 * | Claude Code | `mcp__bit-rnd_…__add_intent` | read out of a live round's DOM |
 * | OpenCode | `bit-iso-a.record_observation` | the harness's own refusal, DECISIONS.md §24.2 Q1 |
 *
 * Both are `<server>` plus a separator plus the bare name, and `<server>` is **ours**:
 * `run/supervisor.ts` and `plan/planSupervisor.ts` both register as
 * {@link bitMcpServerName}. So the reduction below is not a heuristic over tool names in
 * general — it strips a prefix this application chose, and leaves anything else alone. A
 * harness's own `bash` stays `bash`, and a tool a model genuinely called `foo.bar` is not
 * quietly renamed.
 *
 * ## Why the forms are constructed here as well as recognised here
 *
 * {@link claudeCodeToolName} and {@link openCodeToolName} exist so a **test** can emit the
 * shape a driver emits without typing it out. The merge rule shipped broken precisely
 * because two test suites fabricated the bare name: they asserted the implementation
 * against a tool-name space the system never produces, so nothing could have caught it. A
 * fixture that builds its name from the same module the reducer is written against cannot
 * drift from the reducer; one that types `"add_intent"` by hand already had.
 *
 * Browser-safe: no imports at all. It is in contracts rather than in the server because
 * the web's own tests have to reach the constructors, and because the reduced name is a
 * field of {@link LiveItem} — so what the field means belongs beside the field.
 */

/**
 * The prefix every MCP server this application registers carries.
 *
 * One registration per caller, named for the caller: `bit-<attemptId>` for a worker and
 * `bit-<roundId>` for a planner round. Under OpenCode that name is also the **authority
 * boundary's** visible half — every session in a directory sees every `bit-<id>` registered
 * there (DECISIONS.md §24.2) — which is why the three role directories exist.
 */
export const BIT_MCP_SERVER_PREFIX = "bit-";

/**
 * The MCP server name for one caller: a worker's attempt, or a planner round.
 *
 * The single builder. Both supervisors call it, and {@link bareToolName} is written against
 * it, so a change to the naming cannot leave the reducer matching the old form.
 */
export const bitMcpServerName = (callerId: string): string =>
  `${BIT_MCP_SERVER_PREFIX}${callerId}`;

/** How Claude Code names a tool from a registered MCP server. */
export const claudeCodeToolName = (serverName: string, tool: string): string =>
  `mcp__${serverName}__${tool}`;

/** How OpenCode names a tool from a registered MCP server. */
export const openCodeToolName = (serverName: string, tool: string): string =>
  `${serverName}.${tool}`;

/**
 * The bare tool name, with this application's own MCP namespacing taken off.
 *
 * `serverName` is the registration this caller was given — {@link bitMcpServerName} of the
 * attempt or the round — and only that server's prefix is removed. `undefined` for a
 * narration entry the harness named no tool on, which is reachable: Claude Code's
 * `tool_result` block carries the call id and no name at all.
 *
 * **It returns the raw name unchanged when nothing matched**, rather than guessing at a
 * separator. Taking "the segment after the last separator" would have worked for both forms
 * above and would also have renamed a harness's own dotted tool, which is a misattribution
 * a reader cannot see.
 */
export const bareToolName = (
  raw: string | undefined,
  serverName: string,
): string | undefined => {
  if (raw === undefined) return undefined;
  const claude = claudeCodeToolName(serverName, "");
  if (raw.startsWith(claude)) return raw.slice(claude.length);
  const opencode = openCodeToolName(serverName, "");
  if (raw.startsWith(opencode)) return raw.slice(opencode.length);
  return raw;
};
