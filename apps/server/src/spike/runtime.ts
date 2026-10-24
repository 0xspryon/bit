/**
 * Shared wiring for the Sprint 1 delegation-and-memory spike.
 *
 * One layer stack brings up, in one scope: the control-plane store, the local
 * rate-limit fixture, the application-owned MCP endpoint, and a local `opencode
 * serve` with a client over it. Everything binds to loopback and every artifact lands
 * under a gitignored runtime directory.
 *
 * Layers rather than a hand-rolled `bootstrap` record, because the ordering constraints
 * here are real and a layer graph states them: the workspace must exist before the
 * harness spawns into it, the store must exist before the MCP endpoint can serve a tool
 * that writes to it, and *all* of it must come down in reverse order on any exit.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { Context, Effect, Layer, Redacted } from "effect";

import { HarnessSessionStatus } from "../recovery/harnessStatus";

import { FixtureEndpoint } from "../fixture/server";
import { DEFAULT_CONFIG, type RateLimitConfig } from "../fixture/rateLimit";
import { AgentHarness } from "../harness/agentHarness";
import {
  openCodeHarness,
  OPENCODE_DEFAULT_MODEL,
  openCodeModelProvenance,
  type ClientTimeouts,
} from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { HarnessResolver } from "../harness/resolver";
import { McpCredentials } from "../mcp/credentials";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { installOpenCodeGate } from "../policy/install";
import {
  DEFAULT_POLICY,
  PolicyDecisions,
  type PolicyConfig,
} from "../policy/service";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";

/**
 * The provider and model the worker is pinned to.
 *
 * Re-exported rather than declared, now that the server starts runs too: the constant
 * lives on `run/model.ts` so there is one answer for both, and the attempt rows a demo
 * writes name the same provider and model as the ones a browser-started run writes.
 */
/**
 * The model the spike's demos run on.
 *
 * Re-exported from the OpenCode harness rather than from a `run/model.ts` constant of its
 * own: the model a run gets when it names none belongs to the *instance*, because
 * `openai/gpt-5.6-sol` is not something a second harness could run. The spike drives
 * OpenCode specifically, so it names OpenCode's default specifically.
 */
export const WORKER_MODEL = OPENCODE_DEFAULT_MODEL;

export const RUNTIME_DIR = join(process.cwd(), ".runtime");

/** The policy hook's source. Re-exported; it lives with the installer now. */
export { POLICY_HOOK_SOURCE } from "../policy/install";

/** Paths the demos report and read back. Values, not a service's business. */
export class SpikePaths extends Context.Service<
  SpikePaths,
  {
    readonly workspace: string;
    readonly databaseFile: string;
    /** Where the harness-side hook appends its decisions. Outside the workspace. */
    readonly auditFile: string;
  }
>()("bit/spike/SpikePaths") {}

export interface SpikeOptions {
  /**
   * Which target this one `hunt.sqlite` holds the evidence for.
   *
   * The MCP write boundary dispatches by the target id its credential carries, so the
   * endpoint needs a resolver rather than a store. The spike has one database and no
   * fleet around it, so the resolver is `TargetStores.ofStore` over that file — one
   * entry, and a credential for any other target is refused by name. Every demo here
   * binds to `fixture-local`, which is why it is the default.
   */
  readonly targetId?: string;
  readonly databaseName?: string;
  readonly workspaceName?: string;
  readonly fixtureConfig?: RateLimitConfig;
  readonly timeouts?: ClientTimeouts;
  /** Extra files to drop into the workspace before the harness starts. */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
  /** Boundaries the policy route enforces. Defaults to {@link DEFAULT_POLICY}. */
  readonly policy?: PolicyConfig;
  /**
   * Load the pre-execution policy hook into the worker's workspace.
   *
   * On by default, which is the change this milestone makes: the policy gate used to be
   * exercised only by a dedicated probe, so the worker demo ran *unenforced* while the
   * endpoint it would have consulted sat there answering nobody. A run with the hook off
   * is a run with no pre-execution boundary, and has to say so.
   */
  readonly policyHook?: boolean;
  /**
   * Empty the policy audit file when the workspace is prepared. Defaults to `true`.
   *
   * A program that builds this layer more than once — once per phase, in separate
   * scopes — must pass `false`, or each phase starts by deleting the record of the
   * previous one.
   */
  readonly freshAudit?: boolean;
}

/**
 * Lays out the worker's workspace, including the policy hook when one is wanted.
 *
 * The hook-installing half moved to `policy/install.ts`, because a browser-started run
 * needs exactly that and needs none of this: the fixture files below are the spike's own,
 * written into a scratch directory, and a server must never write them into a folder an
 * operator picked. What is left here is the spike's part, with the shared part delegated.
 *
 * The audit file is written *outside* the workspace on purpose: it records what the
 * worker was allowed and denied, and a worker that can read its own audit trail can read
 * the shape of the boundary it is inside.
 */
export const prepareWorkspace = Effect.fnUntraced(function* (input: {
  readonly workspace: string;
  readonly files: Readonly<Record<string, string>>;
  readonly hook?: {
    readonly policyUrl: string;
    readonly auditPath: string;
    /** Empty the audit file first. See `policy/install.ts` for why this is required. */
    readonly freshAudit: boolean;
  };
}) {
  yield* Effect.sync(() => {
    mkdirSync(input.workspace, { recursive: true });
  });
  yield* Effect.forEach(Object.entries(input.files), ([name, content]) =>
    Effect.promise(async () => {
      const target = join(input.workspace, name);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }),
  );
  const hook = input.hook;
  if (hook === undefined) return;
  // `orDie` here and not in the server: a demo whose workspace it created cannot have an
  // `opencode.json` it did not write, so a refusal would be a defect in this file.
  yield* Effect.orDie(
    installOpenCodeGate({
      workspace: input.workspace,
      policyUrl: hook.policyUrl,
      auditPath: hook.auditPath,
      freshAudit: hook.freshAudit,
    }),
  );
});

/**
 * The spike's application layer.
 *
 * The ordering constraints here are real, which is why this is a layer graph and not a
 * `bootstrap` function: the control plane must exist before the workspace can be written
 * (the hook's config has to carry the live policy URL), the workspace must exist before
 * the harness spawns into it, the store must exist before the MCP endpoint can serve a
 * tool that writes to it, and *all* of it must come down in reverse order on any exit.
 *
 * `store` and `endpoint` are each referenced from two places in that graph; layer
 * memoisation builds each once, so there is one database connection and one listener,
 * owned by one scope.
 */
export const spikeLayer = (options: SpikeOptions = {}) => {
  const name = options.workspaceName ?? "workspace";
  const workspace = join(RUNTIME_DIR, name);
  const databaseFile = join(RUNTIME_DIR, options.databaseName ?? "hunt.sqlite");
  const auditFile = join(RUNTIME_DIR, `${name}-policy-audit.log`);

  const store = ObservationStore.layer(databaseFile);
  const resolver = TargetStores.ofStore(
    options.targetId ?? "fixture-local",
  ).pipe(Layer.provide(store));

  // One listener for all three control-plane surfaces: health, the MCP route the worker
  // calls back into, and the policy route the harness-side hook consults.
  const endpoint = ControlPlaneEndpoint.layer({
    policy: options.policy ?? DEFAULT_POLICY,
  }).pipe(
    Layer.provideMerge(McpCredentials.layer),
    Layer.provideMerge(McpCallCounter.layer),
    Layer.provideMerge(PolicyDecisions.layer),
    Layer.provide(resolver),
  );

  const workspaceReady = Layer.effectDiscard(
    Effect.flatMap(ControlPlaneEndpoint, (control) =>
      prepareWorkspace({
        workspace,
        files: options.workspaceFiles ?? {},
        ...(options.policyHook === false
          ? {}
          : {
              hook: {
                policyUrl: control.policyUrl,
                auditPath: auditFile,
                freshAudit: options.freshAudit ?? true,
              },
            }),
      }),
    ),
  ).pipe(Layer.provide(endpoint));

  const harness = openCodeHarness(
    options.timeouts === undefined ? {} : { timeouts: options.timeouts },
  ).pipe(
    Layer.provideMerge(OpenCodeServer.layer({ cwd: workspace })),
    Layer.provide(workspaceReady),
  );

  return Layer.mergeAll(
    store,
    endpoint,
    FixtureEndpoint.layer(options.fixtureConfig ?? DEFAULT_CONFIG),
    harness,
    // Recovery asks the live harness, so it is wired from the same client the worker
    // runs on rather than from a second connection to the same server.
    // `HarnessResolver.single` is the one-instance resolver: the spike drives one harness
    // and chooses nothing, so the resolver is a wrapper here rather than a decision.
    HarnessSessionStatus.layer.pipe(
      Layer.provide(HarnessResolver.single),
      Layer.provide(harness),
    ),
    Layer.succeed(SpikePaths, { workspace, databaseFile, auditFile }),
  );
};

export interface AttemptBinding {
  readonly targetId: string;
  readonly goalId: string;
  readonly goal: string;
  readonly intentId: string;
  readonly question: string;
  readonly attemptId: string;
  readonly workerId: string;
}

/**
 * Creates the session the worker will run in and binds a freshly minted MCP
 * credential to it.
 *
 * Order matters. The session is created first so the credential can be bound to the
 * real harness session ID rather than a placeholder — that ID is what
 * `record_observation` records as provenance, so it must be the genuine one. Only then
 * is the MCP server registered, carrying the token in a request body. The token never
 * appears in the harness's argv, nor in the environment the agent's own shell commands
 * inherit (DECISIONS.md §6 "credentials off argv").
 *
 * The credential is issued into the **caller's scope**. If the registration call below
 * fails, or the attempt is interrupted, the grant is revoked as that scope closes — it
 * does not survive as a live credential bound to a session nobody is driving.
 */
export const openWorkerSession = Effect.fn("openWorkerSession")(function* (
  binding: AttemptBinding,
  title: string,
) {
  const store = yield* ObservationStore;
  const client = yield* AgentHarness;
  const credentials = yield* McpCredentials;
  const endpoint = yield* ControlPlaneEndpoint;
  const paths = yield* SpikePaths;

  const authority = yield* store.seedAttempt({
    ...binding,
    harnessInstanceId: client.instance.instanceId,
    providerId: openCodeModelProvenance(WORKER_MODEL).providerId,
    modelId: openCodeModelProvenance(WORKER_MODEL).modelId,
    // The spikes dispatch no model options, so there is nothing to record.
    modelOptions: null,
    harnessSessionId: null,
  });

  const session = yield* client.createSession({
    title,
    model: WORKER_MODEL,
    directory: paths.workspace,
  });
  yield* store.bindSessionToAttempt(binding.attemptId, session.id);

  const credential = yield* credentials.issue({
    targetId: binding.targetId,
    intentId: binding.intentId,
    attemptId: binding.attemptId,
    harnessSessionId: session.id,
    workerId: binding.workerId,
    // Authority as of now. If recovery fences this attempt while the worker is out,
    // the credential stops working even though the registry still holds it.
    attemptFence: authority.writeFence,
  });

  yield* client.registerMcpServer(session.id, `bit-${binding.attemptId}`, {
    url: endpoint.mcpUrl,
    // Unwrapped and immediately re-wrapped: this is the one place the raw token is
    // touched, to put it in the header of the one request that delivers it.
    headers: {
      authorization: Redacted.make(
        `Bearer ${Redacted.value(credential.token)}`,
      ),
    },
    directory: paths.workspace,
  });

  return { session, credential, authority };
});
