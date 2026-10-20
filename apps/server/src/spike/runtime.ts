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

import { FixtureEndpoint } from "../fixture/server";
import { DEFAULT_CONFIG, type RateLimitConfig } from "../fixture/rateLimit";
import {
  OpenCodeClient,
  type ClientTimeouts,
  type ModelRef,
} from "../harness/openCodeClient";
import { OpenCodeServer } from "../harness/openCodeServer";
import { McpCredentials } from "../mcp/credentials";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import {
  DEFAULT_POLICY,
  PolicyDecisions,
  type PolicyConfig,
} from "../policy/service";
import { McpCallCounter } from "../mcp/server";
import { ObservationStore } from "../persistence/store";

/**
 * The provider and model the worker is pinned to.
 *
 * `openai` here is OpenCode's OAuth-authenticated ChatGPT subscription provider, which
 * the spawned server reads from the user's own stored credentials. No API key is read,
 * passed or held by this process. Verified on 2026-10-19 against opencode v2.0.32:
 * `gpt-5.6-sol` and `gpt-6-astra` complete; `gpt-5.5` and `gpt-5.3-codex-spark` are
 * refused by the provider with "not supported when using Codex with a ChatGPT
 * account", so model availability is narrower than the catalogue suggests.
 */
export const WORKER_MODEL: ModelRef = {
  providerID: "openai",
  id: "gpt-5.6-sol",
};

export const RUNTIME_DIR = join(process.cwd(), ".runtime");

/** Paths the demos report and read back. Values, not a service's business. */
export class SpikePaths extends Context.Service<
  SpikePaths,
  { readonly workspace: string; readonly databaseFile: string }
>()("bit/spike/SpikePaths") {}

export interface SpikeOptions {
  readonly databaseName?: string;
  readonly workspaceName?: string;
  readonly fixtureConfig?: RateLimitConfig;
  readonly timeouts?: ClientTimeouts;
  /** Extra files to drop into the workspace before the harness starts. */
  readonly workspaceFiles?: Readonly<Record<string, string>>;
  /** Boundaries the policy route enforces. Defaults to {@link DEFAULT_POLICY}. */
  readonly policy?: PolicyConfig;
}

const prepareWorkspace = Effect.fnUntraced(function* (
  workspace: string,
  files: Readonly<Record<string, string>>,
) {
  yield* Effect.sync(() => {
    mkdirSync(workspace, { recursive: true });
  });
  yield* Effect.forEach(Object.entries(files), ([name, content]) =>
    Effect.promise(async () => {
      const target = join(workspace, name);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, content);
    }),
  );
});

/**
 * The spike's application layer.
 *
 * `ObservationStore.layer` is passed to the MCP endpoint *and* merged into the result;
 * layer memoisation builds it once, so there is one database connection and one scope
 * owning it.
 */
export const spikeLayer = (options: SpikeOptions = {}) => {
  const workspace = join(RUNTIME_DIR, options.workspaceName ?? "workspace");
  const databaseFile = join(RUNTIME_DIR, options.databaseName ?? "hunt.sqlite");

  const store = ObservationStore.layer(databaseFile);

  const workspaceReady = Layer.effectDiscard(
    prepareWorkspace(workspace, options.workspaceFiles ?? {}),
  );

  const harness = OpenCodeClient.layer(options.timeouts).pipe(
    Layer.provideMerge(OpenCodeServer.layer({ cwd: workspace })),
    Layer.provide(workspaceReady),
  );

  // One listener for both control-plane surfaces: the MCP route the worker calls back
  // into and the policy route the harness-side hook consults.
  const endpoint = ControlPlaneEndpoint.layer({
    policy: options.policy ?? DEFAULT_POLICY,
  }).pipe(
    Layer.provideMerge(McpCredentials.layer),
    Layer.provideMerge(McpCallCounter.layer),
    Layer.provideMerge(PolicyDecisions.layer),
    Layer.provide(store),
  );

  return Layer.mergeAll(
    store,
    endpoint,
    FixtureEndpoint.layer(options.fixtureConfig ?? DEFAULT_CONFIG),
    harness,
    Layer.succeed(SpikePaths, { workspace, databaseFile }),
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
  const client = yield* OpenCodeClient;
  const credentials = yield* McpCredentials;
  const endpoint = yield* ControlPlaneEndpoint;
  const paths = yield* SpikePaths;

  yield* store.seedAttempt({
    ...binding,
    providerId: WORKER_MODEL.providerID,
    modelId: WORKER_MODEL.id,
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
  });

  yield* client.registerMcpServer(`bit-${binding.attemptId}`, {
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

  return { session, credential };
});
