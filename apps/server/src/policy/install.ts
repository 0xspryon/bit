/**
 * Installing the pre-execution policy hook into a workspace the harness will run in.
 *
 * `policy/service.ts` owns the *decision*; `plugins/policyHook.ts` is the plugin that
 * asks and enforces. This is the third piece: getting that plugin into the directory
 * `opencode serve` will load it from, with the control plane's URL in its options.
 *
 * It was inside `spike/runtime.ts`'s `prepareWorkspace`, which only the spike calls, and
 * so a browser-started run had **no gate at all** — the endpoint sat there answering
 * nobody. Separating it is what lets both paths install the same hook; what stayed behind
 * in `prepareWorkspace` is the part that is genuinely the spike's, which is writing
 * fixture files into a scratch directory.
 *
 * ## A real workspace is somebody else's directory
 *
 * The spike installs into a scratch folder it created. A browser-started run installs
 * into the folder an operator picked for the engagement, and that changes what is
 * acceptable:
 *
 * - **An existing `opencode.json` is merged into, never replaced.** An operator may well
 *   have their own opencode configuration in a project they are testing, and a security
 *   tool that silently overwrote it would be the worst kind of surprise. Our plugin entry
 *   is added to `plugins`, any previous entry for the same package is replaced so a
 *   second run does not stack duplicates, and every other key is left exactly as it was.
 * - **An `opencode.json` we cannot parse stops the install** rather than being
 *   overwritten. Unparseable to us is not the same as meaningless to them, and the one
 *   thing we must not do is destroy a file we did not understand.
 * - **No fixture files.** Nothing here writes anything into the workspace except the
 *   plugin and the configuration that loads it.
 *
 * ## The audit file lives outside the workspace
 *
 * `auditPath` is a caller's decision and both callers put it outside the directory the
 * worker runs in, for the reason `spike/runtime.ts` already recorded: a worker that can
 * read its own audit trail can read the shape of the boundary it is inside. For a
 * browser-started run that means the target's own `evidence/` directory, which is where
 * things that are not database rows already go.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Effect, Schema } from "effect";

/**
 * What the hook's audit file is called inside a target's `evidence/` directory.
 *
 * Named here rather than at the call site because two things have to agree on it: the
 * server that configures the hook, and anything that later reads the record back.
 */
export const POLICY_AUDIT_FILE = "policy-audit.log";

/** The plugin's source, copied into whichever workspace needs it. */
export const POLICY_HOOK_SOURCE = join(
  import.meta.dir,
  "..",
  "..",
  "plugins",
  "policyHook.ts",
);

/**
 * The package name our plugin is configured under.
 *
 * A *configured* local plugin must point at a DIRECTORY with an `index`/`server`
 * entrypoint, not a bare file — opencode logs "configured plugin path must be a
 * directory" and skips it otherwise (`packages/plugin/src/host.ts:17-42`). Deliberately
 * not named `plugin/`, which is auto-discovered and would load a second copy with no
 * options (`packages/core/src/plugin/source-directory.ts:9`).
 */
export const POLICY_PLUGIN_PACKAGE = "./policy";

/**
 * A workspace the gate could not be installed into.
 *
 * A tagged error rather than a bare `Error` so it joins the taxonomy a caller already
 * branches on: starting a run collapses four subsystems' failures into one typed refusal,
 * and this has to be tellable from a harness that would not answer or a database that
 * would not open, because the operator action is different for each.
 */
export class PolicyHookNotInstalled extends Schema.TaggedError<PolicyHookNotInstalled>()(
  "PolicyHookNotInstalled",
  {
    workspace: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `the policy hook could not be installed into ${this.workspace}: ${this.detail}`;
  }
}

interface OpencodeConfig {
  readonly [key: string]: unknown;
  readonly plugins?: unknown;
}

/**
 * Our plugin entry merged into whatever configuration is already there.
 *
 * Exported so the merge can be tested without a filesystem: it is the part with the
 * judgement in it, and "does this preserve the operator's other keys" is a question worth
 * answering directly rather than through a file round trip.
 *
 * `plugins` (not `plugin`) is the key that accepts the object form. The superseded
 * `plugin` key takes a string or a `[package, options]` tuple, and an object there is
 * silently skipped as malformed (opencode `packages/core/src/config/normalize.ts:185-190`).
 */
export const withPolicyPlugin = (
  existing: OpencodeConfig | undefined,
  options: { readonly policyUrl: string; readonly auditPath: string },
): Record<string, unknown> => {
  const entry = {
    package: POLICY_PLUGIN_PACKAGE,
    options: { policyUrl: options.policyUrl, auditPath: options.auditPath },
  };
  const current = Array.isArray(existing?.plugins) ? existing.plugins : [];
  // Replace a previous entry for the same package rather than appending beside it: a
  // second run into the same workspace must not leave two copies of our hook, each
  // asking the control plane about every call.
  const others = current.filter(
    (plugin) =>
      !(
        typeof plugin === "object" &&
        plugin !== null &&
        (plugin as { package?: unknown }).package === POLICY_PLUGIN_PACKAGE
      ),
  );
  return {
    $schema: "https://opencode.ai/config.json",
    ...(existing ?? {}),
    plugins: [...others, entry],
  };
};

/**
 * Writes the hook, its package manifest and the configuration that loads it.
 *
 * Fails with {@link PolicyHookNotInstalled} rather than dying, so a caller starting a run
 * can refuse that run: a workspace whose configuration we will not touch is a reason not
 * to start an ungated worker in it, not a reason to start an ungated worker and hope.
 */
export const installPolicyHook = Effect.fnUntraced(function* (input: {
  readonly workspace: string;
  /** Where the harness-side hook posts each decision request. */
  readonly policyUrl: string;
  /** Where the hook appends its decisions. Outside {@link workspace}, by convention. */
  readonly auditPath: string;
  /**
   * Empty the audit file first.
   *
   * Required rather than defaulted, because both answers are wrong somewhere. A
   * single-scope demo wants a file describing this run and nothing else; a program with
   * several scopes — or a target accumulating a record across runs — would wipe its own
   * evidence every time.
   */
  readonly freshAudit: boolean;
}) {
  return yield* Effect.tryPromise({
    try: async () => {
      const opencodeDirectory = join(input.workspace, ".opencode");
      const pluginDirectory = join(opencodeDirectory, "policy");
      const configPath = join(opencodeDirectory, "opencode.json");

      const configFile = Bun.file(configPath);
      let existing: OpencodeConfig | undefined;
      if (await configFile.exists()) {
        const text = await configFile.text();
        if (text.trim().length > 0) {
          try {
            const parsed: unknown = JSON.parse(text);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              throw new Error("it is not a JSON object");
            }
            existing = parsed as OpencodeConfig;
          } catch (cause) {
            throw new PolicyHookNotInstalled({
              workspace: input.workspace,
              detail: `${configPath} already exists and could not be read as JSON (${String(cause)}); refusing to overwrite somebody else's configuration`,
            });
          }
        }
      }

      mkdirSync(pluginDirectory, { recursive: true });
      if (input.freshAudit || !(await Bun.file(input.auditPath).exists())) {
        await Bun.write(input.auditPath, "");
      }
      await Bun.write(
        join(pluginDirectory, "index.ts"),
        await Bun.file(POLICY_HOOK_SOURCE).text(),
      );
      await Bun.write(
        join(pluginDirectory, "package.json"),
        `${JSON.stringify(
          {
            name: "bit-policy-hook",
            private: true,
            type: "module",
            main: "index.ts",
          },
          null,
          2,
        )}\n`,
      );
      await Bun.write(
        configPath,
        `${JSON.stringify(
          withPolicyPlugin(existing, {
            policyUrl: input.policyUrl,
            auditPath: input.auditPath,
          }),
          null,
          2,
        )}\n`,
      );
      return { configPath, pluginDirectory };
    },
    catch: (cause) =>
      cause instanceof PolicyHookNotInstalled
        ? cause
        : new PolicyHookNotInstalled({
            workspace: input.workspace,
            detail: String(cause),
          }),
  });
});
