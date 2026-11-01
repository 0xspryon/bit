/**
 * Installing a pre-execution policy gate into a workspace a harness will run in.
 *
 * `policy/service.ts` owns the *decision*. This file owns what every harness's gate has to
 * be true of, and the OpenCode installation of it; `policy/claudeCodeGate.ts` is the
 * second one. The decision and the endpoint are **harness-agnostic and unchanged**: what
 * varies is how a harness is told to consult it and how its hook reports back.
 *
 * ## The six properties, which are the actual contract
 *
 * A second harness is what turned these from "how the OpenCode installer happens to
 * behave" into a specification, so they are written here once rather than twice:
 *
 * 1. **It fails closed on policy outage**, and that denial is audited *distinctly* from an
 *    ordinary one (`denied_failclosed`, not `denied`). An outage and a boundary are
 *    different facts and a screen that showed them identically would hide the one worth
 *    seeing.
 * 2. **The audit line records the decision basis** — `unrestricted`, `hosts_allowed`,
 *    `no_host_named` — verbatim as the control plane decided it, never re-derived.
 * 3. **The audit file lives outside the workspace** the worker can read. Enforced at the
 *    call site, because the path is a fleet-layout question; see {@link GateInstall}.
 * 4. **An existing configuration of the operator's is merged, not clobbered**, and one we
 *    cannot parse **refuses the run**. Unparseable to us is not the same as meaningless to
 *    them, and the one thing a security tool must not do is destroy a file in somebody's
 *    project that it did not understand. {@link mergeableConfigAt} is that step, shared,
 *    so the two installers cannot drift on it.
 * 5. **Installing is idempotent**: a second run into the same workspace replaces our entry
 *    rather than stacking a second beside it. Two copies of the gate would mean two policy
 *    round trips per tool call and an audit file with everything in it twice.
 * 6. **A failure refuses the run.** Nothing has been prompted at the point this is called,
 *    so refusing costs an error message, while permitting would cost a worker running
 *    against somebody's systems with no record of what it was allowed to do.
 *
 * ## Why the two gates cannot share code, only shape
 *
 * Both hook scripts are written without imports and copied into the workspace, because
 * each is loaded as a standalone entrypoint *by the harness* and must not depend on
 * anything resolvable only from our own node_modules. So the ~60 lines that POST to the
 * policy endpoint and append an audit line are duplicated between
 * `plugins/policyHook.ts` and `plugins/claudeCodeGate.ts`. That is deliberate: the
 * alternative is a build step that bundles a shared module into two generated files, which
 * trades a readable duplicate for an opaque artefact in somebody else's project directory.
 * What is *not* duplicated is the vocabulary — both write the same four audit outcomes —
 * so one reader handles either harness's trail.
 *
 * ## A real workspace is somebody else's directory
 *
 * A browser-started run installs into the folder an operator picked for the engagement,
 * which may already hold their own harness configuration. Nothing here writes anything
 * into the workspace except the gate and the configuration that loads it: no fixture
 * files, no reformatting of keys we do not own.
 */
import { mkdirSync, readlinkSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { Brand, Effect, Schema } from "effect";

import type { UngatedRoleDirectory } from "../persistence/fleet";

/**
 * What the gate's audit file is called inside a target's `evidence/` directory.
 *
 * Named here rather than at the call site because two things have to agree on it: the
 * server that configures the gate, and anything that later reads the record back. It is
 * the same name for every harness — the audit is the target's, not the driver's.
 */
export const POLICY_AUDIT_FILE = "policy-audit.log";

/** What installing a pre-execution gate into one workspace needs. */
export interface GateInstall {
  /** The directory the harness session will run in. Somebody else's project. */
  readonly workspace: string;
  /** Where the harness-side gate posts each decision request. */
  readonly policyUrl: string;
  /**
   * Where the gate appends its decisions.
   *
   * Outside {@link workspace}, by convention enforced at the call site: a worker that can
   * read its own audit trail can read the shape of the boundary it is inside. For a
   * browser-started run that means the target's own `evidence/` directory, which is where
   * things that are not database rows already go.
   */
  readonly auditPath: string;
  /**
   * Empty the audit file first.
   *
   * Required rather than defaulted, because both answers are wrong somewhere. A
   * single-scope demo wants a file describing this run and nothing else; a target
   * accumulating a record across runs would wipe its own evidence every time.
   */
  readonly freshAudit: boolean;
}

/**
 * The one shape every harness's gate installer has.
 *
 * It is this, and not a free function the supervisor picks between, because the supervisor
 * must not know which harness it is driving: this type is what
 * `AgentHarness.installGate` is declared as.
 */
export type GateInstaller = (
  input: GateInstall,
) => Effect.Effect<void, PolicyHookNotInstalled>;

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

/** A JSON object somebody else may own, as read for merging. */
export interface MergeableConfig {
  readonly [key: string]: unknown;
}

/**
 * Reads a configuration file we are about to merge into, or refuses.
 *
 * Property 4 of this module's header, as one function, shared by both installers because
 * it is the step with the judgement in it:
 *
 * - absent, or present but empty → `undefined`, meaning "write ours fresh";
 * - present and a JSON object → that object, to merge into;
 * - present and anything else → {@link PolicyHookNotInstalled}, which refuses the run.
 *
 * A JSON *array* is refused along with unparseable text, and that is not pedantry: both
 * harnesses' configuration files are objects, so an array there means the file is not what
 * we think it is, and writing an object over it would destroy whatever it was.
 *
 * Throws rather than returning an Effect because both callers run inside one
 * `Effect.tryPromise` whose `catch` recognises this error; see {@link installOpenCodeGate}.
 */
export const mergeableConfigAt = async (
  workspace: string,
  configPath: string,
): Promise<MergeableConfig | undefined> => {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("it is not a JSON object");
    }
    return parsed as MergeableConfig;
  } catch (cause) {
    throw new PolicyHookNotInstalled({
      workspace,
      detail: `${configPath} already exists and could not be read as JSON (${String(cause)}); refusing to overwrite somebody else's configuration`,
    });
  }
};

/**
 * Creates the audit file if it is wanted fresh or is not there yet.
 *
 * Shared because the rule is the target's, not the harness's, and because a gate installed
 * against a path nothing has created yet would fail its first append — which, being
 * best-effort inside the hook, would be a silently unaudited run.
 */
export const prepareAudit = async (input: GateInstall): Promise<void> => {
  if (input.freshAudit || !(await Bun.file(input.auditPath).exists())) {
    await Bun.write(input.auditPath, "");
  }
};

/**
 * Keeps the files *we* create out of the operator's commits.
 *
 * ## Why this exists at all
 *
 * Installing a gate writes into somebody's project directory. The choice of
 * `.claude/settings.local.json` over their committed `.claude/settings.json` was made so
 * our entry would stay out of their repository — and that only holds if the file is
 * actually ignored. Nothing makes it so: Claude Code adds its own local settings to the
 * git excludes when *it* first writes them, which says nothing about a file this server
 * wrote instead. Without this, a `git add -A` after a run commits our hook configuration
 * and a copy of our gate script into their history. Small, and exactly the kind of small
 * thing that annoys people.
 *
 * ## `.git/info/exclude`, not a `.gitignore`
 *
 * A `.gitignore` is itself a file in their repository, which is the problem rather than
 * the fix. `.git/info/exclude` is per clone, cannot be committed by construction, and is
 * the mechanism git provides for exactly this. A `.git` that is a *file* — a worktree or a
 * submodule — is followed through its `gitdir:` pointer.
 *
 * ## Only what we own
 *
 * The paths passed in are the ones an installer creates: `.claude/bit-policy/`,
 * `.claude/settings.local.json`, `.opencode/policy/`. **Not** `.opencode/opencode.json`,
 * which may be the operator's own configuration that we merged into and that they may well
 * want tracked. Excluding a file we did not create would be a second kind of surprise.
 *
 * ## Best effort, deliberately
 *
 * A failure here is swallowed. Not being in a git repository is the ordinary case rather
 * than an error, and an unwritable `.git/info/exclude` is untidy rather than unsafe — so it
 * must not be able to refuse a run whose gate is otherwise installed. The exposure when it
 * does fail is that our files show up in the operator's `git status`.
 */
export const excludeFromGit = async (
  workspace: string,
  paths: readonly string[],
): Promise<void> => {
  try {
    const marker =
      "# bit: the policy gate this server installs, which is not yours to keep";
    const gitPath = join(workspace, ".git");

    // A directory is not readable as text, so "is `.git` a pointer file" is asked by
    // trying to read it rather than by stat'ing a type.
    let gitDirectory = gitPath;
    const pointer = await Bun.file(gitPath)
      .text()
      .catch(() => undefined);
    if (pointer !== undefined) {
      const named = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (named === undefined) return;
      gitDirectory = named.startsWith("/") ? named : join(workspace, named);
    }

    const excludePath = join(gitDirectory, "info", "exclude");
    const existing = await Bun.file(excludePath)
      .text()
      .catch(() => undefined);
    // `undefined` means there is no `.git/info/exclude` to append to, so this is not a
    // git working tree we can exclude anything in. Nothing to do, and not a problem.
    if (existing === undefined) return;

    const lines = existing.split("\n");
    const missing = paths.filter((path) => !lines.includes(path));
    if (missing.length === 0) return;

    const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const header = lines.includes(marker) ? "" : `${marker}\n`;
    await Bun.write(
      excludePath,
      `${existing}${prefix}${header}${missing.join("\n")}\n`,
    );
  } catch {
    // See the header: untidy, not unsafe.
  }
};

/**
 * Turns anything thrown inside an installer into this module's typed refusal.
 *
 * Shared so a thrown {@link PolicyHookNotInstalled} is never re-wrapped and loses the
 * sentence an operator needs, and so an `EACCES` from a directory we may not write still
 * arrives as a refusal rather than a defect.
 */
export const asRefusal =
  (workspace: string) =>
  (cause: unknown): PolicyHookNotInstalled =>
    cause instanceof PolicyHookNotInstalled
      ? cause
      : new PolicyHookNotInstalled({ workspace, detail: String(cause) });

/* ── Role directories ────────────────────────────────────────────────────────── */

/**
 * An absolute path with the symlinks in its **deepest existing ancestor** followed, for a
 * path whose final components may not exist yet.
 *
 * `realpathSync` alone is not enough: it throws when the final component is missing, and
 * the audit file is by design a file nothing has created yet. Falling back to a lexical
 * `resolve` at that point (as an earlier version did) silently skips symlink resolution
 * for exactly the path that needs it, so a symlink to the role directory defeated the
 * audit-path refusal. So this resolves the deepest ancestor that exists and appends the
 * components that do not. Two cases beyond that:
 *
 * - **A dangling symlink** is not "a missing component": creating a file through it makes
 *   the file at its target. When a component fails to resolve but is itself a symlink, its
 *   target is read and resolution continues from there.
 * - **Anything other than "does not exist"** (permissions, a loop, more than 40 hops)
 *   throws. The callers treat a path they cannot resolve as a refusal, because "cannot
 *   tell whether it is inside" must not read as "is not".
 *
 * **What this does not do, and why that was weighed rather than missed.**
 *
 * - It does not follow every symlink in the path. The first step is `resolve()`, which
 *   collapses `..` segments **lexically**, before any link is followed. A path that mixes a
 *   symlink with `..` (`link/../role/a.log`, where the filesystem would step out of the
 *   link's *target*, not out of the directory holding the link) therefore resolves to a
 *   different place than the filesystem would put it, and can be judged inside or outside
 *   wrongly. This is accepted because every path given to it here is built by the server
 *   (`fleetPaths`, a validated id, a configured workspace) and none contains `..`; a
 *   caller that passes a path from anywhere else must not rely on this function.
 * - It is a check at one moment. A symlink swapped in after the check, or a component
 *   created as a symlink later, is not seen. That is a race against somebody with write
 *   access to the fleet root, who could already edit the gate directly, so it is accepted
 *   rather than defended.
 */
export const resolveThroughSymlinks = (path: string): string => {
  let pending = resolve(path);
  for (let hops = 0; hops < 40; hops += 1) {
    const rest: string[] = [];
    let probe = pending;
    for (;;) {
      try {
        return join(realpathSync(probe), ...rest);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
      }
      const parent = dirname(probe);
      let link: string | undefined;
      try {
        link = readlinkSync(probe);
      } catch {
        // Not a symlink (or not there): an ordinary missing component.
      }
      if (link !== undefined) {
        pending = join(resolve(realpathSync(parent), link), ...rest);
        break;
      }
      if (parent === probe) return join(probe, ...rest);
      rest.unshift(basename(probe));
      probe = parent;
    }
  }
  throw new Error(`too many levels of symbolic links resolving ${path}`);
};

/**
 * Whether `child` is `parent` or lies inside it, both resolved as above.
 *
 * Exported for one caller beyond this file: `createTarget` (`http/browserApi.ts`) refuses
 * a workspace folder that contains this server's fleet root, because every role directory
 * under it would then be inside the workspace and {@link gatedRoleDirectory} below would
 * refuse every non-worker session on that target. The two checks are the same question
 * asked at two moments, so they share this one derivation of "inside" — including the
 * symlink resolution, which is where a second implementation would have drifted first.
 */
export const isWithin = (parent: string, child: string): boolean => {
  const relation = relative(
    resolveThroughSymlinks(parent),
    resolveThroughSymlinks(child),
  );
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
};

/**
 * A role directory — a planner round's, a goal agent's, a scope import's — that exists
 * and has the gate installed.
 *
 * Only {@link gatedRoleDirectory} produces one. It is still a string, so it can be handed
 * to a harness as one; the brand is what lets a function that creates a session ask for
 * *this* and so refuse the plain strings and the ungated directories everything else is.
 */
export type GatedDirectory = string & Brand.Brand<"GatedDirectory">;
const asGated = Brand.nominal<GatedDirectory>();

/** What preparing one non-worker role's directory needs. */
export interface GatedRoleDirectory<E> {
  /**
   * Makes the directory, idempotently. For the fleet that is
   * `FleetStore.ensurePlanningDirectory`, `ensureGoalDirectory` or
   * `ensureImportDirectory`; taken as an effect so
   * this file has no runtime dependence on the persistence layer (the import above is
   * type-only). What it yields is deliberately not a
   * string: see {@link UngatedRoleDirectory}.
   */
  readonly ensure: Effect.Effect<UngatedRoleDirectory, E>;
  /** The harness's installer, as `AgentHarness.installGate`. */
  readonly install: GateInstaller;
  readonly policyUrl: string;
  /** The target's audit file, outside every role directory; see {@link GateInstall}. */
  readonly auditPath: string;
  /**
   * The operator's folder, where workers run, or `undefined` for a target that has none.
   *
   * **Required, and explicitly `undefined` when there is none**, for the reason
   * {@link GateInstall.freshAudit} is required: the containment check below is the only
   * thing in this function that enforces the layout's central rule, and an optional field
   * is a check that silently does not run for the caller who forgets it. Spelling out
   * `undefined` makes a caller say "this target has no workspace" rather than say nothing.
   *
   * A role directory inside it is refused. Spike B established that a sibling directory is
   * a separate authority under OpenCode; it did not establish that a *nested* one is, and
   * a worker could read the planner's machinery from inside the workspace in any case.
   */
  readonly workspace: string | undefined;
}

/**
 * Makes one non-worker role's directory — a planner round's, a goal agent's, a scope
 * import's — and gates it, in that order, or refuses.
 *
 * **Why the gate goes in a directory where nothing is expected to act.** "The planner does
 * not run shell commands" and "the goal agent only talks" are assumptions about what a
 * model will choose to do, and the gate is what turns an assumption into a fact: a planner
 * that does reach for `bash` or `webfetch` is denied by the same fail-closed path that
 * stops a worker, and the attempt is audited, rather than relying on nothing having been
 * asked. A gate missing from exactly the directories where no action is expected is how an
 * unexpected action goes unrecorded. So every role is gated, the ones that only read and
 * talk included, and this is the single way to obtain a directory a non-worker session may
 * be created in.
 *
 * The directory is created first and gated before it is returned, so no caller can
 * receive a path whose gate has not been installed. Nothing here creates a session or
 * grants a credential; it is layout and installation only.
 *
 * Both containment checks resolve symlinks, including through components that do not
 * exist yet; see {@link resolveThroughSymlinks} for what that does and does not cover. A
 * check that cannot resolve a path refuses rather than permits.
 *
 * Idempotent, because both steps are: a second call for the same round replaces the gate's
 * entry (property 5) and appends to the same audit rather than emptying it.
 */
export const gatedRoleDirectory = <E>(
  input: GatedRoleDirectory<E>,
): Effect.Effect<GatedDirectory, E | PolicyHookNotInstalled> =>
  Effect.gen(function* () {
    const directory = (yield* input.ensure).unsafePath();
    const refuse = (detail: string) =>
      new PolicyHookNotInstalled({ workspace: directory, detail });

    const auditInside = yield* Effect.try({
      try: () => isWithin(directory, input.auditPath),
      catch: (cause) =>
        refuse(
          `could not resolve the audit path ${input.auditPath} (${String(cause)}); refusing rather than guessing that it is outside`,
        ),
    });
    if (auditInside) {
      return yield* refuse(
        `the audit path ${input.auditPath} is inside the directory it records; a session that can read its own audit trail can read the shape of the boundary it is inside`,
      );
    }
    const workspace = input.workspace;
    if (workspace !== undefined) {
      const inWorkspace = yield* Effect.try({
        try: () => isWithin(workspace, directory),
        catch: (cause) =>
          refuse(
            `could not resolve the workspace ${workspace} (${String(cause)}); refusing rather than guessing that ${directory} is outside it`,
          ),
      });
      if (inWorkspace) {
        return yield* refuse(
          `${directory} is inside the workspace ${workspace}, where workers run; a session that is not a worker must run outside it. That workspace holds this target's own fleet directory, so no planner, goal or import session on it can start — re-create the target against a folder that does not contain this server's fleet root, or run the server with a HUNT_ROOT outside that folder`,
        );
      }
    }
    yield* input.install({
      workspace: directory,
      policyUrl: input.policyUrl,
      auditPath: input.auditPath,
      // The audit belongs to the target and accumulates; see the worker's call site.
      freshAudit: false,
    });
    return asGated(directory);
  });

/* ── OpenCode ────────────────────────────────────────────────────────────────── */

/** The OpenCode plugin's source, copied into whichever workspace needs it. */
export const POLICY_HOOK_SOURCE = join(
  import.meta.dir,
  "..",
  "..",
  "plugins",
  "policyHook.ts",
);

/**
 * The package name our OpenCode plugin is configured under.
 *
 * A *configured* local plugin must point at a DIRECTORY with an `index`/`server`
 * entrypoint, not a bare file — opencode logs "configured plugin path must be a
 * directory" and skips it otherwise (`packages/plugin/src/host.ts:17-42`). Deliberately
 * not named `plugin/`, which is auto-discovered and would load a second copy with no
 * options (`packages/core/src/plugin/source-directory.ts:9`).
 */
export const POLICY_PLUGIN_PACKAGE = "./policy";

interface OpencodeConfig extends MergeableConfig {
  readonly plugins?: unknown;
}

/**
 * Our plugin entry merged into whatever OpenCode configuration is already there.
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
 * Writes the OpenCode plugin, its package manifest and the configuration that loads it.
 *
 * Fails with {@link PolicyHookNotInstalled} rather than dying, so a caller starting a run
 * can refuse that run.
 */
export const installOpenCodeGate: GateInstaller = Effect.fnUntraced(function* (
  input: GateInstall,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const opencodeDirectory = join(input.workspace, ".opencode");
      const pluginDirectory = join(opencodeDirectory, "policy");
      const configPath = join(opencodeDirectory, "opencode.json");

      const existing = (await mergeableConfigAt(
        input.workspace,
        configPath,
      )) as OpencodeConfig | undefined;
      // Captured before we write it: afterwards there is no way to tell whether the
      // config file is ours or theirs.
      const configIsOurs = existing === undefined;

      mkdirSync(pluginDirectory, { recursive: true });
      await prepareAudit(input);
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
      await excludeFromGit(input.workspace, [
        ".opencode/policy/",
        // Only when there was nothing there and this install created it; see
        // `excludeFromGit`. An operator's own opencode config stays theirs to commit.
        ...(configIsOurs ? [".opencode/opencode.json"] : []),
      ]);
    },
    catch: asRefusal(input.workspace),
  });
});
