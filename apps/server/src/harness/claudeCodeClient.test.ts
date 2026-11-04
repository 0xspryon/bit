/**
 * The Claude Code adapter, against a scripted SDK.
 *
 * The SDK is injected ({@link ClaudeCodeSdk}) rather than mocked at the module level,
 * because every claim worth making here is about *what this adapter does with the SDK* and
 * each one was a decision rather than a translation:
 *
 * 1. **The caller's session id reaches `query()`**, so the attempt row can name the session
 *    before the session exists.
 * 2. **The MCP credential never reaches the `mcpServers` option**, and does reach
 *    `setMcpServers`. The option is serialised onto the CLI's argv, so this is
 *    DECISIONS.md §6 ("credentials off argv") as an assertion rather than a comment.
 * 3. **The prompt is held back until the registration is in place.** A prompt that reached
 *    the model first would be a worker whose `record_observation` tool did not exist yet —
 *    which fails silently, because a worker with no tools simply records nothing.
 * 4. **A registration that will not take refuses the prompt**, for the same reason.
 * 5. **`result` is the only thing that states an outcome**, and an interrupt we caused is
 *    recorded as `interrupted` rather than as the `error_during_execution` the SDK reports.
 * 6. **A session this process does not hold falls back to the transcript on disk**, and an
 *    id nobody has is reported with the taxonomy's own not-found tag so recovery needs no
 *    branch.
 * 7. **The three pinned options stay pinned**: `dontAsk`, the three setting sources, and
 *    forwarded subagent text. Each of them silently un-gates or silently blinds a run if
 *    it changes, which is exactly the kind of regression a test is for.
 *
 * What is **not** here: a real Claude Code turn. That needs a login and a model, and is
 * exercised live; see the report.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type {
  McpServerConfig,
  Options,
  SDKMessage,
  SessionMessage,
  SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Fiber, Layer, Redacted, Stream } from "effect";

import { HarnessSessionStatus } from "../recovery/harnessStatus";
import { CLAUDE_CODE_MINIMUM, compareVersions } from "../policy/claudeCodeGate";
import { processIdentity } from "./ownedProcesses";
import { HarnessResolver } from "./resolver";
import {
  AgentHarness,
  lastAssistantText,
  NARRATION_FIELD_MAX,
  NARRATION_TRUNCATED_MARK,
  SESSION_NOT_FOUND_TAG,
} from "./agentHarness";
import {
  assembleImporterPrompt,
  assembleImporterResumePrompt,
} from "../import/importerPrompt";
import {
  claudeCodeHarness,
  liveClaudeCodeSdk,
  newClaudeCodeSessionId,
  type ClaudeCodeSdk,
  type HarnessQuery,
} from "./claudeCodeClient";

/* ── A scripted SDK ──────────────────────────────────────────────────────────── */

/**
 * The context window the scripted session reports.
 *
 * The figure DECISIONS.md §24.4 measured for `claude-sonnet-5` on the operator's account.
 * It is a *session's* answer and is scripted as one: nothing in `src/` writes it down, and
 * a test asserting a number from the model list would be asserting the thing this harness
 * refuses to claim.
 */
const CONTEXT_WINDOW = 1_000_000;

/** What one `query()` call did, as the test watches it. */
interface Launched {
  readonly options: Options;
  /** `setMcpServers` and `prompt`, in the order they happened. */
  readonly order: string[];
  readonly registered: Record<string, McpServerConfig>[];
  readonly prompts: string[];
  /** `setModel` and `applyFlagSettings` calls, as `model:<id>` and `effort:<level|null>`. */
  readonly switches: string[];
  interrupts: number;
  closes: number;
}

interface Script {
  /** Rejects `setMcpServers`, for the "refuses the prompt" case. */
  readonly registrationFails?: boolean;
  /** Messages delivered once the prompt has been pulled. */
  readonly messages?: readonly SDKMessage[];
  /** The transcript `getSessionInfo` knows about, by session id. */
  readonly stored?: readonly string[];
  /** What `getSessionMessages` answers, oldest first as the SDK documents it. */
  readonly transcript?: readonly SessionMessage[];
  /**
   * What `getSessionInfo` answers for a stored session, beyond its id. A function so a test
   * can make the read itself throw, as a busy or unreadable store does.
   */
  readonly info?: () => Partial<SDKSessionInfo>;
}

const result = (
  sessionId: string,
  subtype: "success" | "error_during_execution",
): SDKMessage =>
  ({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "done",
    total_cost_usd: 0.25,
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-00000000ffff",
  }) as unknown as SDKMessage;

const assistant = (sessionId: string): SDKMessage =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: "00000000-0000-4000-8000-00000000fffe",
  }) as unknown as SDKMessage;

/**
 * A `query()` that behaves like the CLI: it pulls the prompt iterable in the background,
 * then delivers scripted messages.
 *
 * Pulling in the background is what makes claim (3) checkable. The real CLI reads stdin
 * concurrently with everything else, so a fake that only pulled when iterated would make
 * the held-back prompt look like it worked even if the gate were removed.
 */
const scriptedSdk = (script: Script = {}) => {
  const launched: Launched[] = [];
  const sdk: ClaudeCodeSdk = {
    query: ({ prompt, options }) => {
      const seen: Launched = {
        options,
        order: [],
        registered: [],
        prompts: [],
        switches: [],
        interrupts: 0,
        closes: 0,
      };
      launched.push(seen);

      let deliver: (() => void) | undefined;
      const promptPulled = new Promise<void>((resolve) => {
        deliver = resolve;
      });

      void (async () => {
        for await (const message of prompt) {
          const content = (message as { message?: { content?: unknown } })
            .message?.content;
          seen.order.push("prompt");
          seen.prompts.push(String(content));
          deliver?.();
        }
      })();

      const query: HarnessQuery = {
        setMcpServers: async (servers) => {
          seen.order.push("setMcpServers");
          seen.registered.push(servers);
          if (script.registrationFails === true) {
            throw new Error("the session refused the registration");
          }
          return {};
        },
        interrupt: async () => {
          seen.interrupts += 1;
          return undefined;
        },
        // The window this account gets for this model, which is the only place a Claude
        // Code limit can come from: it is session-time, not catalogue-time. See
        // `HarnessQuery.getContextUsage`.
        getContextUsage: async () => ({ maxTokens: CONTEXT_WINDOW }),
        setModel: async (model) => {
          seen.switches.push(`model:${String(model)}`);
        },
        applyFlagSettings: async (settings) => {
          seen.switches.push(`effort:${String(settings.effortLevel)}`);
        },
        close: () => {
          seen.closes += 1;
        },
        [Symbol.asyncIterator]: async function* () {
          // Nothing is narrated until the prompt has actually been sent, which is what the
          // CLI does and what makes the ordering assertions meaningful.
          await promptPulled;
          for (const message of script.messages ?? []) yield message;
        },
      };
      return query;
    },
    sessionMessages: (sessionId) =>
      Promise.resolve(
        script.transcript ?? [
          {
            type: "assistant",
            uuid: "u",
            session_id: sessionId,
            message: { content: [{ type: "text", text: "stored reply" }] },
            parent_tool_use_id: null,
            parent_agent_id: null,
          } satisfies SessionMessage,
        ],
      ),
    sessionInfo: (sessionId) =>
      Promise.resolve(
        (script.stored ?? []).includes(sessionId)
          ? ({
              sessionId,
              summary: "s",
              lastModified: 1,
              ...script.info?.(),
            } satisfies SDKSessionInfo)
          : undefined,
      ),
  };
  return { sdk, launched };
};

/** One harness over a scripted SDK, for the length of one body. */
const withHarness = <A>(
  script: Script,
  use: (
    harness: AgentHarness["Service"],
    launched: Launched[],
  ) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const { sdk, launched } = scriptedSdk(script);
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(AgentHarness, (harness) => use(harness, launched)).pipe(
        Effect.provide(claudeCodeHarness({ sdk, controlTimeout: "2 seconds" })),
        Effect.orDie,
      ),
    ),
  );
};

const registration = (url = "http://127.0.0.1:9/api/v1/mcp") => ({
  url,
  headers: { authorization: Redacted.make("Bearer s3cret") },
  directory: "/tmp/ws",
});

/* ── Identity ────────────────────────────────────────────────────────────────── */

describe("identity", () => {
  test("the instance names the driver and carries the Claude Code build", async () => {
    const instance = await withHarness({}, (harness) =>
      Effect.succeed<AgentHarness["Service"]["instance"]>(harness.instance),
    );
    // `String(...)` because the brand is doing its job: a plain string is not a
    // `DriverKind`, which is the whole reason the slug carries one.
    expect(String(instance.driver)).toBe("claude-code");
    // A stock instance uses the driver slug as its id, so a single-account installation
    // reads the same in both positions and nothing has to know the difference yet.
    expect(String(instance.instanceId)).toBe("claude-code");
    expect(instance.installed).toBe(true);
    // Observed from the SDK package rather than written down, so an upgrade cannot leave
    // this reporting a version nobody is running.
    expect(instance.version).not.toBe("unknown");
    expect(instance.defaultModel.length).toBeGreaterThan(0);
  });

  test("no model in the picker claims a context window", async () => {
    /*
     * The other half of `HarnessModelView.contextLimit`: OpenCode fills it from its
     * catalogue, and this driver has no catalogue to fill it from. `ModelInfo` carries no
     * context-window field, so the only figure available is a *session's*
     * `getContextUsage().maxTokens` — this account's answer for the model as that session
     * resolved it. Writing it into the model list would turn one observation into a
     * constant every deployment inherits, and the meter would then draw a percentage
     * against a denominator nobody measured.
     */
    const instance = await withHarness({}, (harness) =>
      Effect.succeed<AgentHarness["Service"]["instance"]>(harness.instance),
    );
    expect(instance.models.length).toBeGreaterThan(0);
    expect(
      instance.models.every((model) => model.contextLimit === undefined),
    ).toBe(true);
  });

  test("a minted session id is a UUID, because the SDK requires one", () => {
    // Not `ses_…`: OpenCode's format would be rejected outright, which is the whole reason
    // minting is on the harness interface rather than in a shared helper.
    expect(newClaudeCodeSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("provenance names anthropic, and the model unchanged", async () => {
    const provenance = await withHarness({}, (harness) =>
      Effect.succeed(harness.modelProvenance("claude-sonnet-5")),
    );
    // One provider, so no split: the attempt row's `provider_id` says which provider ran
    // the model, and `harness_instance_id` is the column that says which harness did.
    expect(provenance).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });
});

/* ── The build floor ────────────────────────────────────────────────────────── */

describe("the build floor", () => {
  /**
   * Builds the harness against a manifest reporting a given version.
   *
   * The version is read from the SDK package's own manifest, so there is no option to
   * override — which is correct for production and means this test has to reach the real
   * value. What it can check is the two things that matter: the installed build clears the
   * floor, and the comparison that decides is the one `claudeCodeGate.ts` exports and
   * tests directly.
   */
  test("the installed build clears the floor, so the harness is offered", async () => {
    const built = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          Effect.flatMap(AgentHarness, (harness) =>
            Effect.succeed<string>(harness.instance.version),
          ).pipe(Effect.provide(claudeCodeHarness({ sdk: scriptedSdk().sdk }))),
        ),
      ),
    );
    expect(built._tag).toBe("Success");
    if (built._tag === "Success") {
      // Not "unknown": an unreadable version refuses, because the version *is* the
      // evidence for a safety property here rather than a diagnostic.
      expect(built.success).not.toBe("unknown");
      expect(
        compareVersions(built.success, CLAUDE_CODE_MINIMUM),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  test("the floor is the version that gained onFailure", () => {
    // Below this, a PreToolUse hook entry silently ignores `onFailure: "block"`, so a hook
    // that could not start would let its tool call through with no trace but a missing
    // audit line. Pinned here so an SDK downgrade is a startup refusal rather than a
    // quietly weaker gate.
    expect(CLAUDE_CODE_MINIMUM).toBe("2.1.295");
  });
});

/* ── Starting a session ──────────────────────────────────────────────────────── */

describe("starting a session", () => {
  test("creating one starts nothing, and prompting is what launches the query", async () => {
    const sessionId = newClaudeCodeSessionId();
    const launched = await withHarness({}, (harness, seen) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        // The interface's shape is preserved; what moved is where the work happens. A
        // session created and never prompted costs nothing and leaves nothing behind.
        const beforePrompt = seen.length;
        yield* harness.prompt(sessionId, "do the thing");
        return { beforePrompt, after: seen.length, options: seen[0]?.options };
      }),
    );
    expect(launched.beforePrompt).toBe(0);
    expect(launched.after).toBe(1);
    expect(launched.options?.sessionId).toBe(sessionId);
    expect(launched.options?.cwd).toBe("/tmp/ws");
    expect(launched.options?.model).toBe("claude-sonnet-5");
  });

  test("the pinned options stay pinned", async () => {
    const sessionId = newClaudeCodeSessionId();
    const options = await withHarness({}, (harness, seen) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.prompt(sessionId, "go");
        return seen[0]?.options;
      }),
    );
    // `dontAsk` denies anything not pre-approved, and our PreToolUse gate's allow is what
    // pre-approves. Change it and the gate becomes advisory, or the run stalls on the
    // first tool call with nobody at a prompt.
    expect(options?.permissionMode).toBe("dontAsk");
    // The gate lives in `.claude/settings.local.json` in `cwd`. Omitting this would make
    // un-gating a run a matter of somebody changing an SDK default.
    expect(options?.settingSources).toEqual(["user", "project", "local"]);
    // Without this a subagent's text never reaches the stream and narration shows only
    // tool-call heartbeats.
    expect(options?.forwardSubagentText).toBe(true);
    // Needed for `messages` to have anything to read later.
    expect(options?.persistSession).toBe(true);
  });

  test("a session cannot be prompted twice", async () => {
    // Carrying work on after a turn means a new attempt identity (DECISIONS.md §15), so a
    // second prompt into the same session is refused rather than queued.
    const sessionId = newClaudeCodeSessionId();
    const second = await withHarness({}, (harness) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.prompt(sessionId, "first");
        return yield* Effect.result(harness.prompt(sessionId, "second"));
      }),
    );
    expect(second._tag).toBe("Failure");
  });
});

/* ── The credential ─────────────────────────────────────────────────────────── */

describe("the MCP credential", () => {
  test("never reaches the mcpServers option, and does reach setMcpServers", async () => {
    const sessionId = newClaudeCodeSessionId();
    const seen = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.registerMcpServer(
          sessionId,
          "bit-attempt-1",
          registration(),
        );
        yield* harness.prompt(sessionId, "go");
        return launched[0];
      }),
    );

    // The option is serialised onto the CLI's argv as `--mcp-config <json>`, where a
    // bearer would be readable from /proc and from a plain `ps aux` run by the agent's own
    // shell. So it is never used.
    expect(seen?.options.mcpServers).toBeUndefined();
    expect(JSON.stringify(seen?.options ?? {})).not.toContain("s3cret");

    // It travels in a control request body instead.
    expect(seen?.registered).toHaveLength(1);
    expect(seen?.registered[0]?.["bit-attempt-1"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:9/api/v1/mcp",
      headers: { authorization: "Bearer s3cret" },
      alwaysLoad: true,
    });
  });

  test("the prompt is held back until the registration is in place", async () => {
    // A prompt that reached the model before the registration would be a worker whose
    // `record_observation` tool did not exist yet — and a worker with no tools records
    // nothing, silently.
    const sessionId = newClaudeCodeSessionId();
    const order = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.registerMcpServer(
          sessionId,
          "bit-attempt-1",
          registration(),
        );
        yield* harness.prompt(sessionId, "go");
        // The prompt is pulled asynchronously by the fake, as the CLI pulls stdin, so give
        // the pull a tick to land before reading the order.
        yield* Effect.yieldNow;
        yield* Effect.sleep("10 millis");
        return launched[0]?.order;
      }),
    );
    expect(order).toEqual(["setMcpServers", "prompt"]);
  });

  test("a registration that will not take refuses the prompt", async () => {
    const sessionId = newClaudeCodeSessionId();
    const outcome = await withHarness(
      { registrationFails: true },
      (harness, launched) =>
        Effect.gen(function* () {
          yield* harness.createSession({
            title: "bit: t",
            model: "claude-sonnet-5",
            directory: "/tmp/ws",
            sessionId,
          });
          yield* harness.registerMcpServer(
            sessionId,
            "bit-attempt-1",
            registration(),
          );
          const prompted = yield* Effect.result(
            harness.prompt(sessionId, "go"),
          );
          return { prompted, launched: launched[0] };
        }),
    );
    expect(outcome.prompted._tag).toBe("Failure");
    // Nothing was prompted, and the query was closed rather than left running toolless.
    expect(outcome.launched?.prompts).toEqual([]);
    expect(outcome.launched?.closes).toBeGreaterThan(0);
  });

  test("unregistering before the prompt means the name never reaches the CLI", async () => {
    // Complete in this direction: `launch` builds the one `mcp_set_servers` request from
    // the record, so a name taken off the record is a name the session never had.
    const sessionId = newClaudeCodeSessionId();
    const seen = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.registerMcpServer(sessionId, "bit-a", registration());
        yield* harness.registerMcpServer(sessionId, "bit-b", registration());
        yield* harness.unregisterMcpServer(sessionId, "bit-a");
        yield* harness.prompt(sessionId, "go");
        return launched[0];
      }),
    );

    expect(Object.keys(seen?.registered[0] ?? {})).toEqual(["bit-b"]);
  });

  test("unregistering after the prompt pushes the remaining set over the control channel", async () => {
    // Spike B measured that a *late registration* never reaches the CLI through this
    // seam; whether the CLI drops an already-connected server on a later
    // `mcp_set_servers` was not measured. What is asserted here is only what this
    // adapter does: it makes the request, with the removed name absent.
    const sessionId = newClaudeCodeSessionId();
    const seen = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.registerMcpServer(sessionId, "bit-a", registration());
        yield* harness.registerMcpServer(sessionId, "bit-b", registration());
        yield* harness.prompt(sessionId, "go");
        yield* harness.unregisterMcpServer(sessionId, "bit-a");
        return launched[0];
      }),
    );

    // Two control requests: the one `launch` made, and this one. Only the second is
    // read, because `launch` hands the SDK the live record and the fake keeps that
    // reference — so the first entry is not a snapshot of what was sent at the time.
    expect(seen?.registered).toHaveLength(2);
    expect(Object.keys(seen?.registered[1] ?? {})).toEqual(["bit-b"]);
  });

  test("unregistering an unknown name or session is a no-op", async () => {
    // Called from the release side of a scope, where a failure would turn tidy-up into
    // an outcome: there is nothing of ours to remove, so there is nothing to report.
    const sessionId = newClaudeCodeSessionId();
    const seen = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        yield* harness.registerMcpServer(sessionId, "bit-a", registration());
        yield* harness.unregisterMcpServer(sessionId, "bit-never-registered");
        yield* harness.unregisterMcpServer(newClaudeCodeSessionId(), "bit-a");
        yield* harness.prompt(sessionId, "go");
        return launched[0];
      }),
    );

    expect(Object.keys(seen?.registered[0] ?? {})).toEqual(["bit-a"]);
    expect(seen?.registered).toHaveLength(1);
  });

  test("one session's registration is not reachable from another's", async () => {
    const first = newClaudeCodeSessionId();
    const second = newClaudeCodeSessionId();
    const seen = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        for (const id of [first, second]) {
          yield* harness.createSession({
            title: "bit: t",
            model: "claude-sonnet-5",
            directory: "/tmp/ws",
            sessionId: id,
          });
        }
        yield* harness.registerMcpServer(first, "bit-a", registration());
        yield* harness.prompt(first, "a");
        yield* harness.prompt(second, "b");
        return launched;
      }),
    );
    expect(Object.keys(seen[0]?.registered[0] ?? {})).toEqual(["bit-a"]);
    // The second session was launched with no registration at all, rather than inheriting
    // the first's. This is the guarantee OpenCode's directory-scoped registration cannot
    // make; see `AgentHarness.registerMcpServer`.
    expect(seen[1]?.registered).toEqual([]);
  });
});

/* ── Outcomes and narration ─────────────────────────────────────────────────── */

describe("outcomes", () => {
  const run = (
    messages: readonly SDKMessage[],
    after?: (
      harness: AgentHarness["Service"],
      sessionId: string,
    ) => Effect.Effect<void, unknown>,
  ) => {
    const sessionId = newClaudeCodeSessionId();
    return withHarness({ messages }, (harness) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
        });
        const narration = yield* Effect.forkChild(
          Stream.runCollect(harness.sessionEvents(sessionId)),
        );
        yield* harness.prompt(sessionId, "go");
        if (after !== undefined) yield* after(harness, sessionId);
        yield* harness.waitForIdle(sessionId);
        return {
          status: yield* harness.sessionStatus(sessionId),
          narrated: yield* Fiber.join(narration),
        };
      }),
    );
  };

  test("a successful result settles succeeded, and the stream carries it", async () => {
    const sessionId = "ignored";
    const outcome = await run([
      assistant(sessionId),
      result(sessionId, "success"),
    ]);
    expect(outcome.status.outcome).toBe("succeeded");
    expect(outcome.status.cost).toBe(0.25);
    const entries = [...outcome.narrated];
    // The SDK's own message types, verbatim and unmapped: the vocabulary belongs to the
    // harness, and it is coarser than OpenCode's. That is a difference the seam absorbs by
    // not promising a vocabulary at all.
    expect(entries.map((entry) => entry.type)).toEqual(["assistant", "result"]);
    // Only the terminal entry states an outcome. Never inferred.
    expect(entries.map((entry) => entry.outcome)).toEqual([
      undefined,
      "succeeded",
    ]);
    // No cursor to carry: the SDK's stream is not resumable from a position, which is why
    // the interface makes `sequence` optional.
    expect(entries.every((entry) => entry.sequence === undefined)).toBe(true);
  });

  /**
   * One SDK message is several narrated moments, and the mapping is what a transcript reads.
   *
   * Verified against `@anthropic-ai/claude-agent-sdk@0.3.310`'s declared shapes: an
   * `assistant` message carries a `BetaMessage` whose `content` is a list of blocks, so a
   * turn that says something and then calls a tool is **one** message holding a `text`
   * block and a `tool_use` block. A reduction to one entry would have had to choose which
   * of the two to show.
   */
  test("one assistant message carrying text and a tool call narrates both", async () => {
    const sessionId = "ignored";
    const outcome = await run([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Probing the limiter." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "curl -s http://127.0.0.1:41317/login" },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-00000000fff0",
      } as unknown as SDKMessage,
      result(sessionId, "success"),
    ]);
    const entries = [...outcome.narrated];
    // Two entries from one message, and both carry that message's own `type`: the harness's
    // vocabulary is unchanged by our reading of it.
    expect(entries.map((entry) => entry.type)).toEqual([
      "assistant",
      "assistant",
      "result",
    ]);
    expect(entries[0]?.detail).toEqual({
      _tag: "reply",
      text: "Probing the limiter.",
    });
    expect(entries[1]?.detail).toEqual({
      _tag: "toolCall",
      callId: "toolu_1",
      tool: "Bash",
      input: '{"command":"curl -s http://127.0.0.1:41317/login"}',
    });
  });

  test("a tool result comes back on a user message, and is read as one", async () => {
    const sessionId = "ignored";
    const outcome = await run([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "HTTP/1.1 429 Too Many Requests" },
              ],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-00000000fff1",
      } as unknown as SDKMessage,
      result(sessionId, "success"),
    ]);
    const entries = [...outcome.narrated];
    // A tool's output arrives as a *user* message, because that is how the Messages API
    // carries it. It reads oddly and it is the SDK's shape rather than ours.
    expect(entries[0]?.detail).toEqual({
      _tag: "toolResult",
      callId: "toolu_1",
      // Named by its call id and not by its tool: a `tool_result` block says which call it
      // answers, never which tool, and borrowing a name would be the one mistake worth
      // refusing. The id pairs it with the `toolCall` entry that does carry the name.
      tool: undefined,
      output: "HTTP/1.1 429 Too Many Requests",
      failed: false,
    });
  });

  /**
   * A thinking block is read, and it used to be the example of something that was not.
   *
   * This test asserted `opaque` for exactly this message, with the comment that one entry
   * per message is what keeps anything downstream from having to cope with a message that
   * narrated nothing. That part still holds — see the `system` case below, which is now
   * what carries it — but the premise does not: a thinking block has a whole block of text
   * in `block.thinking`, and reading it as "nothing to render" was this build's limitation
   * rather than the driver's.
   */
  test("a thinking block is narrated as thinking, with its own text", async () => {
    const sessionId = "ignored";
    const outcome = await run([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "The limiter is probably per-IP.",
              signature: "x",
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-00000000fff2",
      } as unknown as SDKMessage,
      result(sessionId, "success"),
    ]);
    const entries = [...outcome.narrated];
    expect(entries[0]?.detail).toEqual({
      _tag: "thinking",
      text: "The limiter is probably per-IP.",
    });
    // The field is `thinking` and not `text`, so a mapping that read the wrong one would
    // produce an empty block rather than failing — which is why the text is asserted.
    expect(entries[0]?.type).toBe("assistant");
  });

  test("an empty thinking block is carried as empty, and not as a reply", async () => {
    const sessionId = "ignored";
    // Observed in DECISIONS.md §24.4's own run: the provider returned no readable
    // reasoning and the SDK still delivered the block, `thinking: ""`. Whether a block with
    // nothing in it is worth a row is the transcript's decision — `liveTranscript.ts` drops
    // it — and this mapping's job is not to turn it into something it is not.
    const outcome = await run([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "x" }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-00000000fff7",
      } as unknown as SDKMessage,
      result(sessionId, "success"),
    ]);
    expect([...outcome.narrated][0]?.detail).toEqual({
      _tag: "thinking",
      text: "",
    });
  });

  test("a message with nothing to render still narrates, as opaque", async () => {
    const sessionId = "ignored";
    const outcome = await run([
      // A `system` frame: no content blocks, nothing measurable, and nothing to show.
      {
        type: "system",
        subtype: "compact_boundary",
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-00000000fff8",
      } as unknown as SDKMessage,
      result(sessionId, "success"),
    ]);
    const entries = [...outcome.narrated];
    // One entry per message either way, so nothing downstream has to cope with a message
    // that narrated nothing — and `opaque` is not an empty reply: "the harness said
    // something we do not display" must not read as "the agent replied with nothing".
    expect(entries).toHaveLength(2);
    expect(entries[0]?.detail).toEqual({ _tag: "opaque" });
  });

  /* ── Usage: per call, never per turn ───────────────────────────────────────── */

  /**
   * The figures below are DECISIONS.md §24.4's own, from
   * `apps/server/.runtime/usage-probe/claude-messages.jsonl`.
   *
   * Three properties of this driver make a naive reading wrong, and each has a test:
   * one API call arrives as several `assistant` frames repeating one `message.id`; those
   * frames' `output_tokens` is a stale snapshot; and the `result`'s own `usage` is a
   * per-turn **sum** that re-counts the cached prefix per call.
   */
  const usageOf = (entries: readonly { readonly detail: unknown }[]) =>
    entries
      .map((entry) => entry.detail)
      .filter(
        (
          detail,
        ): detail is {
          _tag: "usage";
          callId: string;
          promptTokens: number;
          outputTokens: number | undefined;
          contextLimit: number | undefined;
        } => (detail as { _tag?: string })._tag === "usage",
      );

  /** One API call, as two frames: a thinking block and then a tool call. */
  const assistantCall = (
    callId: string,
    usage: Record<string, unknown>,
    block: Record<string, unknown>,
    /**
     * The `Task` call this frame is nested under, for a forwarded subagent frame.
     *
     * `null` on the main loop, which is what all eight of the probe's captures carry.
     */
    parentToolUseId: string | null = null,
  ): SDKMessage =>
    ({
      type: "assistant",
      message: { role: "assistant", id: callId, usage, content: [block] },
      parent_tool_use_id: parentToolUseId,
      session_id: "ignored",
      uuid: `00000000-0000-4000-8000-0000000${callId.slice(-5)}`,
    }) as unknown as SDKMessage;

  test("one API call delivered as several frames is one call, counted once", async () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 21_386,
      output_tokens: 2,
    };
    const outcome = await run([
      assistantCall("msg_011CgY4r9e5W12kRrNxTPEy4", usage, {
        type: "thinking",
        thinking: "Reading the first file.",
        signature: "x",
      }),
      assistantCall("msg_011CgY4r9e5W12kRrNxTPEy4", usage, {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "/tmp/a" },
      }),
      result("ignored", "success"),
    ]);
    const measured = usageOf([...outcome.narrated]);
    // Two frames, two entries — `narrate` is stateless and does not try to remember what
    // it has already said — and **one call**, because both carry the same id. A reader
    // keying the latest per id draws 21 388; one summing the entries would draw 42 776.
    expect(measured).toHaveLength(2);
    expect(new Set(measured.map((entry) => entry.callId)).size).toBe(1);
    for (const entry of measured) {
      // 2 uncached + 21 386 read from the cache + 0 written. The input side of an
      // `assistant` frame is exact; it is only the output side that is a snapshot.
      expect(entry.promptTokens).toBe(21_388);
      // The frame says `output_tokens: 2` and the call really produced 16. The stale
      // figure is omitted rather than published, so nothing downstream can draw it.
      expect(entry.outputTokens).toBeUndefined();
    }
  });

  test("the turn's result states the last call's real output, under the same id", async () => {
    const callId = "msg_011CgY4rvbJ27RSLnHS5LvE1";
    const turnResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "done",
      total_cost_usd: 0.028_72,
      modelUsage: {},
      permission_denials: [],
      session_id: "ignored",
      uuid: "00000000-0000-4000-8000-00000000fffa",
      usage: {
        /*
         * The per-turn sum, which is the trap. These four fields add to 90 784 against a
         * real context of 23 179 — 3.9 times too many — because `cache_read` re-counts the
         * cached prefix on each of the turn's four calls. Put here deliberately so that a
         * mapping which read the easy field would fail this test rather than pass it.
         */
        input_tokens: 8,
        cache_creation_input_tokens: 1_775,
        cache_read_input_tokens: 88_626,
        output_tokens: 375,
        output_tokens_details: { thinking_tokens: 63 },
        // The last call alone, exact, with the true output count.
        iterations: [
          {
            input_tokens: 2,
            output_tokens: 16,
            cache_read_input_tokens: 23_005,
            cache_creation_input_tokens: 156,
            type: "message",
          },
        ],
      },
    } as unknown as SDKMessage;

    const outcome = await run([
      assistantCall(
        callId,
        {
          input_tokens: 2,
          cache_creation_input_tokens: 156,
          cache_read_input_tokens: 23_005,
          output_tokens: 1,
        },
        { type: "text", text: "Done." },
      ),
      turnResult,
    ]);
    const measured = usageOf([...outcome.narrated]);
    expect(measured).toHaveLength(2);
    // The same call, topped up: the id comes from the stream's own order because
    // `iterations[0]` carries no message id at all.
    expect(measured[1]?.callId).toBe(callId);
    expect(measured[1]?.promptTokens).toBe(23_163);
    expect(measured[1]?.outputTokens).toBe(16);
    // 23 163 + 16 is the context at that call. Not 90 784, and not 91 159.
    expect(measured[1]?.promptTokens).not.toBe(90_784 - 375);
    /*
     * The session's window, asserted on this entry rather than on the one before it.
     *
     * It is read beside the run — a forked, bounded control request, so a failed read
     * costs a percentage and never a run — which means a call that happens before it
     * answers carries no limit. That is the honest behaviour and pinning down *which*
     * calls have it would be asserting a race. By the turn's `result` the read has
     * certainly answered.
     */
    expect(measured[1]?.contextLimit).toBe(CONTEXT_WINDOW);
  });

  test("a subagent's call narrates its words and does not feed the meter", async () => {
    /*
     * `forwardSubagentText: true` is pinned so that a subagent's text and thinking reach
     * the stream, and the policy gate's default answer is `allow`, so a `Task` call is
     * reachable on any run. A subagent has **its own context**: its prompt size is not this
     * session's, and a meter that took its newest frame would change subject without saying
     * so — which is the exact defect that keeps this meter off the target-wide transcript.
     *
     * The driver's own accounting agrees on the unit: the SDK documents `result.usage` as
     * "MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model
     * calls", so the `iterations` the output count comes from describe main-loop calls.
     * Letting a subagent set `lastCallId` would hang that count on a call it is not about.
     */
    const main = "msg_main";
    const outcome = await run([
      assistantCall(
        main,
        {
          input_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 21_386,
          output_tokens: 1,
        },
        { type: "tool_use", id: "toolu_task", name: "Task", input: {} },
      ),
      // The subagent's own call, forwarded. A big context of its own, and not ours.
      assistantCall(
        "msg_sub",
        {
          input_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 99_000,
          output_tokens: 1,
        },
        { type: "text", text: "Subagent reporting." },
        "toolu_task",
      ),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
        total_cost_usd: 0.01,
        modelUsage: {},
        permission_denials: [],
        session_id: "ignored",
        uuid: "00000000-0000-4000-8000-00000000fffb",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 120_386,
          output_tokens: 20,
          iterations: [
            {
              input_tokens: 2,
              output_tokens: 9,
              cache_read_input_tokens: 21_386,
              cache_creation_input_tokens: 0,
              type: "message",
            },
          ],
        },
      } as unknown as SDKMessage,
    ]);
    const entries = [...outcome.narrated];

    // The subagent's words still narrate — that is what the forwarding option is for, and
    // they are transcript content rather than a measurement.
    expect(
      entries.some(
        (entry) =>
          entry.detail._tag === "reply" &&
          entry.detail.text === "Subagent reporting.",
      ),
    ).toBe(true);

    const measured = usageOf(entries);
    // Two measurements: the main call, and the turn's top-up of that same call. The
    // subagent's 99 002 is not among them.
    expect(measured.map((entry) => entry.callId)).toEqual([main, main]);
    expect(measured.map((entry) => entry.promptTokens)).toEqual([
      21_388, 21_388,
    ]);
    // And the turn's exact output count landed on the main call rather than on the
    // subagent's id, which is what excluding it from `lastCallId` buys.
    expect(measured[1]?.outputTokens).toBe(9);
  });

  test("a result on a stream that made no call states no usage", async () => {
    // `iterations[0]` has no id, so with no call to attribute it to there is nothing
    // honest to publish. Nothing is invented to hang the numbers on.
    const outcome = await run([result("ignored", "success")]);
    expect(usageOf([...outcome.narrated])).toEqual([]);
  });

  test("an oversized tool argument is cut once, here, and says so", async () => {
    const sessionId = "ignored";
    const outcome = await run([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_big",
              name: "Write",
              input: { content: "x".repeat(NARRATION_FIELD_MAX * 2) },
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-00000000fff3",
      } as unknown as SDKMessage,
      result(sessionId, "success"),
    ]);
    const detail = [...outcome.narrated][0]?.detail;
    expect(detail?._tag).toBe("toolCall");
    if (detail?._tag !== "toolCall") throw new Error("not a tool call");
    // Cut at the point the payload is read, so an oversized argument does not go on to
    // grow a queue, a PubSub buffer and an SSE frame — and it says it was cut, because a
    // silently shortened argument is an argument a reader would misread.
    expect(detail.input.length).toBeLessThan(NARRATION_FIELD_MAX + 64);
    expect(detail.input.endsWith(NARRATION_TRUNCATED_MARK)).toBe(true);
  });

  test("an error result settles failed", async () => {
    const outcome = await run([result("x", "error_during_execution")]);
    expect(outcome.status.outcome).toBe("failed");
  });

  test("an interrupt we caused settles interrupted, not failed", async () => {
    // The SDK reports an interrupted turn as `error_during_execution`, which on the wire is
    // indistinguishable from a genuine failure. We know which it was, so recording `failed`
    // would be a claim about the work that we know to be wrong.
    const outcome = await run(
      [result("x", "error_during_execution")],
      (harness, sessionId) =>
        Effect.asVoid(harness.interruptSession(sessionId)),
    );
    expect(outcome.status.outcome).toBe("interrupted");
  });

  test("interrupting a session that never started is false, not a failure", async () => {
    // `false` means "there was nothing running to interrupt", which is a different fact
    // from "we could not reach the harness" — and the supervisor reports both.
    const interrupted = await withHarness({}, (harness) =>
      Effect.gen(function* () {
        const id = newClaudeCodeSessionId();
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: id,
        });
        return yield* harness.interruptSession(id);
      }),
    );
    expect(interrupted).toBe(false);
  });
});

/* ── Reading back ───────────────────────────────────────────────────────────── */

describe("a session this process does not hold", () => {
  /**
   * The answer S7's live demonstration found missing, and the reason nothing on this
   * driver was continued after a restart.
   *
   * A Claude Code session is run by a subprocess the SDK owns, so an id this process does
   * not hold is a session that is *not running* — whatever the transcript says. That much
   * was always true; what changed is that the seam can now say it. This used to **fail**,
   * because with only an `outcome` field there was no way to report "exists, nothing
   * running it, outcome unknown" without `{}` implying `running` — and `{}` is exactly
   * what made recovery record `still_running` and leave the row `running` for ever.
   *
   * `activity` is that missing sentence. `idle` with no outcome is `abandoned` in
   * `recovery/harnessStatus.ts`, which is `uncertain` for an attempt — the same
   * disposition the refusal reached, for a stated reason instead of an unanswered
   * question, and the only one a continuation can be decided from.
   */
  test("a transcript this process holds is idle with no outcome, not a refusal", async () => {
    const status = await withHarness(
      { stored: ["11111111-0000-4000-8000-000000000001"] },
      (harness) =>
        harness.sessionStatus("11111111-0000-4000-8000-000000000001"),
    );
    expect(status.activity).toBe("idle");
    // Not `failed`, and not anything else: nothing recorded one and nothing may invent it.
    expect(status.outcome).toBeUndefined();
    // Both live on the session record this process no longer has. Absent is the seam's
    // word for "the harness does not know", not zero.
    expect(status.cost).toBeUndefined();
    expect(status.tokens).toBeUndefined();
  });

  /**
   * The mapping the fix exists for, asserted through the real adapter rather than assumed
   * from the driver's answer.
   */
  test("recovery reads that session as abandoned, not missing or unreachable", async () => {
    const report = await withHarness(
      { stored: ["11111111-0000-4000-8000-000000000001"] },
      (harness) =>
        Effect.provide(
          Effect.flatMap(HarnessSessionStatus, (service) =>
            service.of(
              "11111111-0000-4000-8000-000000000001",
              harness.instance.instanceId,
            ),
          ),
          HarnessSessionStatus.layer.pipe(
            Layer.provide(HarnessResolver.fromHarnesses([harness])),
          ),
        ),
    );
    expect(report.observed).toBe("abandoned");
    expect(report.detail).toContain("no turn in flight");
  });

  test("an id nobody has is reported with the taxonomy's not-found tag", async () => {
    // Reusing the generated OpenCode client's own tag deliberately, so
    // `recovery/harnessStatus.ts` maps this to `missing` with no branch on driver.
    const failure = await withHarness({ stored: [] }, (harness) =>
      Effect.result(
        harness.sessionStatus("11111111-0000-4000-8000-000000000002"),
      ),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as { tag?: string; status?: number };
      expect(error.tag).toBe(SESSION_NOT_FOUND_TAG);
      expect(error.status).toBe(404);
    }
  });

  test("messages come from the stored transcript", async () => {
    const entries = await withHarness({}, (harness) =>
      harness.messages("11111111-0000-4000-8000-000000000003"),
    );
    expect(entries).toEqual([
      { type: "assistant", text: "stored reply", error: undefined },
    ]);
  });

  test("messages keep the order the SDK read them in, so the last reply is the last entry", async () => {
    // `AgentHarness.messages` promises oldest first, and `lastAssistantText` scans from the
    // end on that promise. The SDK documents `getSessionMessages` as chronological; this is
    // the half of the promise that is ours to keep for it: nothing here re-sorts or
    // reverses what it was given.
    const said = (
      type: "user" | "assistant",
      uuid: string,
      text: string,
    ): SessionMessage => ({
      type,
      uuid,
      session_id: "11111111-0000-4000-8000-000000000004",
      message: { content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      parent_agent_id: null,
    });
    const entries = await withHarness(
      {
        transcript: [
          said("user", "a", "start"),
          said("assistant", "b", "first reply"),
          said("user", "c", "continue"),
          said("assistant", "d", "closing report"),
        ],
      },
      (harness) => harness.messages("11111111-0000-4000-8000-000000000004"),
    );
    expect(entries.map((entry) => entry.text)).toEqual([
      "start",
      "first reply",
      "continue",
      "closing report",
    ]);
    expect(lastAssistantText(entries)).toBe("closing report");
  });

  /**
   * What `Query.setModel` leaves in the transcript (A6 F4): the CLI records the switch as
   * though `/model` had been typed. The entries below are what SDK 0.3.310's
   * `getSessionMessages` returned for a 2.1.310 transcript the model-switch probe wrote —
   * keys, flag and string content as read: the `isMeta` caveat that heads the run on disk is
   * already gone, and the two entries after it carry `isCompletedLocalCommand: true`.
   */
  test("the CLI's own record of a /model switch is not a message, and an operator's message that is one wrapper is", async () => {
    const SESSION = "11111111-0000-4000-8000-000000000005";
    const user = (
      uuid: string,
      content: string,
      localCommand = false,
    ): SessionMessage =>
      ({
        type: "user",
        uuid,
        session_id: SESSION,
        message: { role: "user", content },
        parent_tool_use_id: null,
        parent_agent_id: null,
        ...(localCommand ? { isCompletedLocalCommand: true } : {}),
      }) as SessionMessage;
    const stdout =
      "<local-command-stdout>Set model to `claude-sonnet-4-5`</local-command-stdout>";
    const commandName =
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-sonnet-4-5</command-args>";
    const quoted = `Why does my log say ${stdout}?`;
    const entries = await withHarness(
      {
        transcript: [
          user("a", "start"),
          {
            type: "assistant",
            uuid: "b",
            session_id: SESSION,
            message: { content: [{ type: "text", text: "first reply" }] },
            parent_tool_use_id: null,
            parent_agent_id: null,
          },
          user("d", commandName, true),
          user("e", stdout, true),
          user("f", quoted),
          // An operator's paste sent verbatim — an importer follow-up is the operator's
          // words unchanged — whose whole text is one wrapper. No caveat precedes it, so
          // the SDK does not mark it, and it is the operator's message.
          user("g", stdout),
          user("h", commandName),
        ],
      },
      (harness) => harness.messages(SESSION),
    );
    expect(entries.map((entry) => entry.text)).toEqual([
      "start",
      "first reply",
      quoted,
      stdout,
      commandName,
    ]);
  });

  /**
   * The same claim against the **real** `getSessionMessages`, because the flag the filter
   * reads is SDK 0.3.310's own derivation and is not in its published types: a later SDK
   * that stopped setting it, or set it wider, fails here rather than in a replay.
   *
   * The transcript is written to a temporary `CLAUDE_CONFIG_DIR` in the CLI's on-disk form,
   * each entry trimmed to the fields the SDK reads from the probe's 2.1.310 transcripts: the
   * `/model` run is the meta caveat, the command record and its stdout, and the operator
   * prompts carry `promptSource: "sdk"` as every message this server sends does. The hard
   * case is the last prompt — an operator's paste that is exactly one stdout wrapper, sent
   * directly after a `/model` run, where a filter that looked at the text or the position
   * alone would take it for the run's output.
   */
  test("the real SDK marks only the CLI's /model run, not an operator's paste of its output that follows it", async () => {
    const SESSION = "11111111-0000-4000-8000-000000000006";
    const WORKSPACE = "/tmp/bit-local-command-ws";
    const root = await mkdtemp(join(tmpdir(), "bit-local-command-"));
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    const stdout =
      "<local-command-stdout>Set model to `claude-sonnet-4-5`</local-command-stdout>";
    let at = Date.parse("2026-11-03T20:49:06.000Z");
    let parent: string | null = null;
    const line = (
      uuid: string,
      type: "user" | "assistant",
      content: unknown,
      extra: Record<string, unknown> = {},
    ) => {
      const entry = {
        parentUuid: parent,
        isSidechain: false,
        type,
        message:
          type === "user"
            ? { role: "user", content }
            : { role: "assistant", content, model: "claude-sonnet-4-5" },
        uuid,
        timestamp: new Date((at += 1000)).toISOString(),
        sessionId: SESSION,
        version: "2.1.310",
        ...extra,
      };
      parent = uuid;
      return JSON.stringify(entry);
    };
    const prompt = { promptSource: "sdk" } as const;
    const reply = (text: string) => [{ type: "text", text }];
    const transcript = [
      line("00000000-0000-4000-8000-000000000001", "user", "start", prompt),
      line(
        "00000000-0000-4000-8000-000000000002",
        "assistant",
        reply("first reply"),
      ),
      line(
        "00000000-0000-4000-8000-000000000003",
        "user",
        "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>",
        { isMeta: true },
      ),
      line(
        "00000000-0000-4000-8000-000000000004",
        "user",
        "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-sonnet-4-5</command-args>",
      ),
      line("00000000-0000-4000-8000-000000000005", "user", stdout),
      line("00000000-0000-4000-8000-000000000006", "user", stdout, prompt),
      line(
        "00000000-0000-4000-8000-000000000007",
        "assistant",
        reply("second reply"),
      ),
    ];
    try {
      const project = join(
        root,
        "projects",
        WORKSPACE.replace(/[^a-zA-Z0-9]/g, "-"),
      );
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, `${SESSION}.jsonl`),
        `${transcript.join("\n")}\n`,
      );
      process.env["CLAUDE_CONFIG_DIR"] = root;
      const { sdk } = scriptedSdk();
      const entries = await Effect.runPromise(
        Effect.scoped(
          // No session is registered, so `messages` passes no `dir` and the SDK searches
          // every project under the temporary config directory — this one only.
          Effect.flatMap(AgentHarness, (harness) =>
            harness.messages(SESSION),
          ).pipe(
            Effect.provide(
              claudeCodeHarness({
                sdk: {
                  ...sdk,
                  sessionMessages: liveClaudeCodeSdk.sessionMessages,
                },
                controlTimeout: "2 seconds",
              }),
            ),
            Effect.orDie,
          ),
        ),
      );
      expect(entries.map((entry) => entry.text)).toEqual([
        "start",
        "first reply",
        stdout,
        "second reply",
      ]);
    } finally {
      if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

/* ── Steering, and what `waitForIdle` means once a session can take two messages ── */

/**
 * An SDK whose turns are driven by the test, one `result` at a time.
 *
 * The scripted SDK above delivers its whole message list as soon as the prompt is pulled,
 * which is right for every claim it serves and useless for these: what is being asserted
 * here is **when** a turn ends relative to a second message being accepted, so the test has
 * to own that moment. `emitResult` is it.
 *
 * It models the one thing DECISIONS.md §24.1 measured about this driver: **one `result` per
 * accepted message**, `num_turns: 1` on each, and the directive's own uuid on the second
 * one only. Nothing folds. A fake that answered one `result` for two messages would make
 * the fixed pump look broken and the broken one look fine.
 */
const turnDrivenSdk = () => {
  const seen = {
    /** Every message the SDK pulled off the input iterable, oldest first. */
    prompts: [] as string[],
    uuids: [] as (string | undefined)[],
    priorities: [] as (string | undefined)[],
    /** `setModel` and `applyFlagSettings` calls, as `model:<id>` and `effort:<level|null>`. */
    switches: [] as string[],
    /** How many times the context window was asked for. */
    contextReads: 0,
    closes: 0,
    interrupts: 0,
  };
  /**
   * How the session answers a model switch, changeable mid-test so a retry can succeed.
   *
   * `refuse` rejects that one control request; `hang` never answers it, which is the case
   * the control bound exists for. `hangOn` does the same for one call only, named as it
   * is recorded in `seen.switches` (`effort:high`). Either way the call is still recorded,
   * because a request the CLI refused was still sent.
   *
   * A request left hanging is **rejected when the query closes**, as SDK 0.3.310's
   * `Query.cleanup` does to every pending control response ("Query closed before response
   * received"). A fake that left it hanging would make a switch racing a close look like a
   * timeout, which is not what the caller gets.
   */
  const controls: {
    refuse: "setModel" | "applyFlagSettings" | undefined;
    hang: "setModel" | "applyFlagSettings" | undefined;
    hangOn: string | undefined;
    /** Rejects `interrupt()`, as a CLI that will not acknowledge one does. */
    refuseInterrupt: boolean;
  } = {
    refuse: undefined,
    hang: undefined,
    hangOn: undefined,
    refuseInterrupt: false,
  };
  const hanging = new Set<(cause: Error) => void>();
  const answer = async (
    request: "setModel" | "applyFlagSettings",
    label: string,
  ): Promise<void> => {
    if (controls.hang === request || controls.hangOn === label) {
      await new Promise<never>((_, reject) => {
        hanging.add(reject);
      });
    }
    if (controls.refuse === request) {
      throw new Error(`the CLI refused ${request}`);
    }
  };
  const pending: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let sessionId = "";
  /** Set by {@link failStream}: what the stream throws once it has been woken. */
  let streamFailure: Error | undefined;
  /** Set by {@link endStream}: the stream returns once it has been woken. */
  let streamEnded = false;
  const push = (message: SDKMessage): void => {
    pending.push(message);
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };

  const sdk: ClaudeCodeSdk = {
    query: ({ prompt, options }) => {
      sessionId = options.sessionId ?? "";
      void (async () => {
        for await (const message of prompt) {
          const record = message as unknown as {
            message?: { content?: unknown };
            uuid?: string;
            priority?: string;
          };
          seen.prompts.push(String(record.message?.content));
          seen.uuids.push(record.uuid);
          seen.priorities.push(record.priority);
          // A reply arrives with the turn; the `result` that *ends* it is the test's.
          push(assistant(sessionId));
        }
      })();
      const query: HarnessQuery = {
        setMcpServers: async () => ({}),
        interrupt: async () => {
          seen.interrupts += 1;
          if (controls.refuseInterrupt) {
            throw new Error("the CLI did not acknowledge the interrupt");
          }
          return undefined;
        },
        // The window this account gets for this model, which is the only place a Claude
        // Code limit can come from: it is session-time, not catalogue-time. See
        // `HarnessQuery.getContextUsage`.
        getContextUsage: async () => {
          seen.contextReads += 1;
          return { maxTokens: CONTEXT_WINDOW };
        },
        setModel: async (model) => {
          const label = `model:${String(model)}`;
          seen.switches.push(label);
          await answer("setModel", label);
        },
        applyFlagSettings: async (settings) => {
          const label = `effort:${String(settings.effortLevel)}`;
          seen.switches.push(label);
          await answer("applyFlagSettings", label);
        },
        close: () => {
          seen.closes += 1;
          for (const reject of hanging) {
            reject(new Error("Query closed before response received"));
          }
          hanging.clear();
        },
        [Symbol.asyncIterator]: async function* () {
          // Never ends on its own, like the real stream: it is closed, not completed.
          for (;;) {
            while (pending.length > 0) {
              const next = pending.shift();
              if (next !== undefined) yield next;
            }
            if (streamFailure !== undefined) throw streamFailure;
            if (streamEnded) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
      return query;
    },
    sessionMessages: () => Promise.resolve([]),
    sessionInfo: () => Promise.resolve(undefined),
  };

  /** Ends one turn, as the driver does: one `result` per accepted message. */
  const emitResult = (): void => {
    push(result(sessionId, "success"));
  };
  /**
   * Kills the query with an error, **in the order the pump sees it under SDK 0.3.310**:
   * `Query.readMessages` errors the message stream and calls `cleanup(e)`, which rejects
   * every pending control request at once, but the pump's iterator only throws once
   * `readSdkMessages`' `finally` has awaited that cleanup. So a switch waiting on
   * `setModel` wakes before the pump has seen the stream fail, which is the order a fix
   * has to survive.
   */
  const failStream = (cause: Error): void => {
    for (const reject of hanging) reject(cause);
    hanging.clear();
    streamFailure = cause;
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  /**
   * Ends the query **cleanly**, as SDK 0.3.310 does when the CLI exits with code 0:
   * `readMessages` finishes the message stream and calls `cleanup()`, which rejects every
   * pending control request with "Query closed before response received"; the pump's
   * iterator then returns, without an error, after that cleanup has run.
   */
  const endStream = (): void => {
    for (const reject of hanging) {
      reject(new Error("Query closed before response received"));
    }
    hanging.clear();
    streamEnded = true;
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  /** Waits until the SDK has pulled `count` messages off the input iterable. */
  const pulled = async (count: number): Promise<void> => {
    for (let index = 0; index < 400; index += 1) {
      if (seen.prompts.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { sdk, seen, controls, emitResult, failStream, endStream, pulled };
};

const withTurnDriven = <A>(
  use: (
    harness: AgentHarness["Service"],
    driver: ReturnType<typeof turnDrivenSdk>,
  ) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const driver = turnDrivenSdk();
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(AgentHarness, (harness) => use(harness, driver)).pipe(
        Effect.provide(
          claudeCodeHarness({ sdk: driver.sdk, controlTimeout: "2 seconds" }),
        ),
        Effect.orDie,
      ),
    ),
  );
};

const SESSION = "22222222-0000-4000-8000-000000000001";

describe("a second accepted message, and what settlement means after one", () => {
  test("waitForIdle waits for the steer's own turn, not the one it took over from", async () => {
    /*
     * DECISIONS.md §24.1, consequence 4 — the only place the spike demanded a change to
     * shipped code, and it is this.
     *
     * The pump used to `break` at the first `result` ("one prompt, one turn") and then
     * close the session. Under a steer that first `result` belongs to the turn the steer
     * took over from, so the old pump ended narration, completed `idle` and closed the
     * query while the directive's own turn was still queued: the supervisor would settle a
     * round that was about to produce its real answer.
     *
     * So the assertion is in two halves and the first half is the one that used to fail:
     * after one `result` with two messages accepted, `waitForIdle` is **still waiting**.
     */
    const answer = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: SESSION,
        });
        yield* harness.prompt(SESSION, "the round's briefing");
        yield* Effect.promise(() => driver.pulled(1));

        const waiting = yield* Effect.forkChild(harness.waitForIdle(SESSION));

        // The steer, accepted while the first turn is still running.
        const steered = yield* harness.prompt(SESSION, "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: "aaaaaaaabbbbbbbbccccccccdddddddd",
        });
        yield* Effect.promise(() => driver.pulled(2));

        // Turn one ends. Two messages are outstanding, so the session is not idle.
        driver.emitResult();
        yield* Effect.sleep("40 millis");
        // `pollUnsafe` because that is the only "has it finished yet" there is in Effect
        // 4: `Fiber` exposes it as an immediate runtime hook and has no effectful poll.
        const earlyWait = waiting.pollUnsafe();

        // Turn two ends. Now every accepted message has been answered.
        driver.emitResult();
        yield* Fiber.join(waiting);
        return { steered, earlyWait };
      }),
    );

    expect(answer.steered.delivered).toBe(true);
    // The half that used to fail: no answer at the first `result`.
    expect(answer.earlyWait).toBeUndefined();
  });

  /**
   * The same two turns, asked the other question: what does `sessionStatus` say *during*
   * turn two?
   *
   * `record.outcome` is overwritten by the pump on every `result`, so after turn one's
   * result it holds `succeeded` — turn one's answer — while turn two is still running.
   * This used to be reported verbatim, which is a terminal answer about a turn that has
   * not happened yet. A supervisor settling on it would have closed the round and revoked
   * the credential while the directive's own turn was mid-flight.
   *
   * The counterpart defect on the other driver is OpenCode's `Execution.Started`, which
   * sets `time_busy` and never clears `idle_outcome`. Both are answered the same way: the
   * outcome is only reported while no turn is in flight.
   */
  test("mid-second-turn, the status reports a live turn and not the first turn's outcome", async () => {
    const answer = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: SESSION,
        });
        yield* harness.prompt(SESSION, "the round's briefing");
        yield* Effect.promise(() => driver.pulled(1));
        yield* harness.prompt(SESSION, "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: "aaaaaaaabbbbbbbbccccccccdddddddd",
        });
        yield* Effect.promise(() => driver.pulled(2));

        // Turn one ends; `record.outcome` is now `succeeded` and turn two is still live.
        driver.emitResult();
        yield* Effect.sleep("40 millis");
        const duringTurnTwo = yield* harness.sessionStatus(SESSION);

        driver.emitResult();
        yield* harness.waitForIdle(SESSION);
        const afterBoth = yield* harness.sessionStatus(SESSION);
        return { duringTurnTwo, afterBoth };
      }),
    );

    expect(answer.duringTurnTwo.activity).toBe("running");
    // The half that used to be wrong: turn one's answer, reported about turn two.
    expect(answer.duringTurnTwo.outcome).toBeUndefined();
    // And once everything accepted has been answered, the outcome is current and reported.
    expect(answer.afterBoth.activity).toBe("idle");
    expect(answer.afterBoth.outcome).toBe("succeeded");
  });

  test("the steer carries the driver's own id and its own timing", async () => {
    const seen = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: SESSION,
        });
        yield* harness.prompt(SESSION, "the round's briefing");
        yield* Effect.promise(() => driver.pulled(1));
        yield* harness.prompt(SESSION, "finish first", {
          _tag: "steer",
          urgency: "queued",
          messageId: "0123456789abcdef0123456789abcdef",
        });
        yield* harness.prompt(SESSION, "stop now", {
          _tag: "steer",
          urgency: "preemptive",
          messageId: "fedcba9876543210fedcba9876543210",
        });
        yield* Effect.promise(() => driver.pulled(3));
        return driver.seen;
      }),
    );

    // The opening prompt carries neither, exactly as every worker and round session always
    // has: there is nothing to be idempotent about and no timing to choose.
    expect(seen.uuids[0]).toBeUndefined();
    expect(seen.priorities[0]).toBeUndefined();
    /*
     * A **UUID**, because the SDK's `uuid` is one, derived from the application's own hex
     * id so a retry presents the same value. `later` lets the work in flight finish and
     * `now` cuts it off — measured at 60 of 60 lines against 1 of 60 (§24.1).
     */
    expect(seen.uuids[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(seen.priorities[1]).toBe("later");
    expect(seen.priorities[2]).toBe("now");
    // Two different application ids, two different driver ids.
    expect(seen.uuids[1]).not.toBe(seen.uuids[2]);
  });

  test("a retried steer under the same message id delivers nothing twice", async () => {
    const answer = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: SESSION,
        });
        yield* harness.prompt(SESSION, "the round's briefing");
        yield* Effect.promise(() => driver.pulled(1));

        const id = "11112222333344445555666677778888";
        const first = yield* harness.prompt(SESSION, "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: id,
        });
        yield* Effect.promise(() => driver.pulled(2));
        // The retry: the same derived id, because the id is a function of the operation it
        // belongs to and not of the attempt to send it.
        const retry = yield* harness.prompt(SESSION, "a directive", {
          _tag: "steer",
          urgency: "queued",
          messageId: id,
        });
        yield* Effect.sleep("20 millis");
        const other = yield* harness.prompt(SESSION, "something else", {
          _tag: "steer",
          urgency: "queued",
          messageId: "99998888777766665555444433332222",
        });
        yield* Effect.promise(() => driver.pulled(3));
        return { first, retry, other, prompts: [...driver.seen.prompts] };
      }),
    );

    expect(answer.first.delivered).toBe(true);
    // Answered successfully with `delivered: false`: a caller that read this as a failure
    // would retry forever, and one that read it as a delivery would believe the round had
    // been told twice.
    expect(answer.retry.delivered).toBe(false);
    expect(answer.other.delivered).toBe(true);
    // Three messages pulled, not four. The directive is in the session once.
    expect(answer.prompts).toHaveLength(3);
    expect(
      answer.prompts.filter((text) => text.includes("a directive")),
    ).toHaveLength(1);
  });

  test("a steer into a session that has finished what it accepted is refused", async () => {
    /*
     * The backstop for the race the supervisor's claim narrows. On this driver the session
     * is a query this process holds, so "already finished" is knowable — and refusing is
     * the only safe answer: a message pushed into a closing generator would be reported as
     * delivered and read by nobody.
     *
     * On OpenCode the same call cannot be refused at all (§24.1: prompting an idle session
     * starts a new execution), which is why `PlanSupervisor.steer` holds a claim rather
     * than relying on this.
     */
    const failure = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: SESSION,
        });
        yield* harness.prompt(SESSION, "the round's briefing");
        yield* Effect.promise(() => driver.pulled(1));
        driver.emitResult();
        yield* harness.waitForIdle(SESSION);
        return yield* Effect.result(
          harness.prompt(SESSION, "too late", {
            _tag: "steer",
            urgency: "queued",
            messageId: "abababababababababababababababab",
          }),
        );
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect((failure.failure as { message: string }).message).toContain(
        "already finished the work it accepted",
      );
    }
  });

  test("a steer before the session has been prompted at all is refused", async () => {
    const failure = await withTurnDriven((harness) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: SESSION,
        });
        return yield* Effect.result(
          harness.prompt(SESSION, "a directive", {
            _tag: "steer",
            urgency: "queued",
            messageId: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
          }),
        );
      }),
    );

    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect((failure.failure as { message: string }).message).toContain(
        "no turn to steer",
      );
    }
  });

  test("a multi-turn session survives going idle and takes another message", async () => {
    /*
     * The goal conversation's whole requirement, and the one thing that genuinely differs
     * between the two drivers: an OpenCode session lives in the harness's own server and
     * outlives every turn, while a Claude Code session **is** an open `query()` this
     * process holds. Closed when it idles — which is right for a round — the operator's
     * second message would have nothing to arrive at.
     */
    const answer = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "conversation",
          model: "claude-sonnet-5",
          directory: "/tmp/goal",
          sessionId: SESSION,
          multiTurn: true,
        });
        yield* harness.prompt(SESSION, "what is happening?");
        yield* Effect.promise(() => driver.pulled(1));
        driver.emitResult();
        yield* harness.waitForIdle(SESSION);
        const closedAfterTurnOne = driver.seen.closes;

        const second = yield* harness.prompt(SESSION, "look at the lockout", {
          _tag: "steer",
          urgency: "queued",
          messageId: "1a1a1a1a2b2b2b2b3c3c3c3c4d4d4d4d",
        });
        yield* Effect.promise(() => driver.pulled(2));
        driver.emitResult();
        // A fresh wait for the new turn, which is only possible because the deferred was
        // replaced when the message was accepted.
        yield* harness.waitForIdle(SESSION);
        return {
          second,
          closedAfterTurnOne,
          prompts: [...driver.seen.prompts],
        };
      }),
    );

    // Not closed when it went idle, which is the difference from a round.
    expect(answer.closedAfterTurnOne).toBe(0);
    expect(answer.second.delivered).toBe(true);
    expect(answer.prompts).toHaveLength(2);
  });
});

/* ── What a session is called ────────────────────────────────────────────────── */

describe("what Claude Code calls a session", () => {
  const STORED = "11111111-0000-4000-8000-0000000000a1";

  const titleOf = (info?: () => Partial<SDKSessionInfo>, stored = [STORED]) =>
    withHarness(
      { stored, ...(info === undefined ? {} : { info }) },
      (harness) => harness.sessionTitle(STORED),
    );

  /**
   * What the SDK does to a prompt before it reports one, so the fixtures below are what it
   * actually hands back rather than a tidier stand-in.
   *
   * `sdk.mjs` (0.3.310): every new line becomes a space, the result is trimmed, and anything
   * over 200 characters is cut to 200 and given a `…`. That is `firstPrompt`; the CLI's
   * `last-prompt` entry, which `summary` prefers, is the same text cut shorter.
   */
  const asTheSdkReportsIt = (prompt: string): string => {
    const line = prompt.replaceAll("\n", " ").trim();
    return line.length > 200 ? `${line.slice(0, 200).trim()}…` : line;
  };

  /** A real opener: the importer's whole framing, with an operator's sentence below it. */
  const OPENER = assembleImporterPrompt({
    targetName: "Acme Corp",
    links: [],
    message: "Load the staging hosts from the policy page",
  });

  test("the CLI's ai-title, which the SDK reports as customTitle, is the title", async () => {
    // As observed on this machine's real importer transcripts: the SDK folds `aiTitle` into
    // `customTitle`, and `summary` repeats it.
    const answer = await titleOf(() => ({
      customTitle: "Acme Corp bug bounty scope review",
      summary: "Acme Corp bug bounty scope review",
      firstPrompt: asTheSdkReportsIt(OPENER),
    }));
    expect(answer).toEqual({
      _tag: "titled",
      title: "Acme Corp bug bounty scope review",
    });
  });

  /**
   * The leak this operation exists to refuse. With no title earned yet, the SDK's `summary`
   * falls through to the prompt — and the prompt is this server's three kilobytes of rules,
   * flattened and cut so that the delimiter the replay splits at is gone.
   */
  test("a summary that is only the opener's framing is untitled, never the title", async () => {
    expect(OPENER.length).toBeGreaterThan(2_000);
    const reported = asTheSdkReportsIt(OPENER);
    // The premise, checked rather than assumed: the SDK's version has lost the operator's
    // words entirely, so there is nothing below a delimiter to trim back to.
    expect(reported).toStartWith("You are reading the published scope");
    expect(reported).not.toContain("Load the staging hosts");
    const answer = await titleOf(() => ({
      summary: reported,
      firstPrompt: reported,
    }));
    expect(answer).toEqual({ _tag: "untitled" });
  });

  test("a summary that is a reconnected session's framing is untitled too", async () => {
    const resumed = asTheSdkReportsIt(
      assembleImporterResumePrompt({
        message: "carry on with the second page",
      }),
    );
    const answer = await titleOf(() => ({
      summary: resumed,
      firstPrompt: asTheSdkReportsIt(OPENER),
    }));
    expect(answer).toEqual({ _tag: "untitled" });
  });

  /**
   * Not the SDK's behaviour today, and the reason it is pinned anyway: if a release stopped
   * cutting the prompt, `summary` would carry the whole opener, and a driver that had started
   * trusting `summary` would put every word of the framing in the operator's chrome.
   */
  test("even a summary carrying the whole opener verbatim is not a title", async () => {
    const answer = await titleOf(() => ({ summary: OPENER }));
    expect(answer).toEqual({ _tag: "untitled" });
  });

  test("a blank customTitle is untitled, not an empty name", async () => {
    const answer = await titleOf(() => ({ customTitle: "   ", summary: "x" }));
    expect(answer).toEqual({ _tag: "untitled" });
  });

  test("a session the store does not hold is forgotten, with the store's sentence", async () => {
    const answer = await titleOf(undefined, []);
    expect(answer._tag).toBe("forgotten");
    if (answer._tag === "forgotten") expect(answer.detail).toContain(STORED);
  });

  test("a store that cannot be read is a failure, not a forgotten session", async () => {
    const result = await withHarness(
      {
        stored: [STORED],
        info: () => {
          throw new Error("EBUSY");
        },
      },
      (harness) => Effect.result(harness.sessionTitle(STORED)),
    );
    expect(result._tag).toBe("Failure");
  });
});

/* ── Stopping a conversation's turn ──────────────────────────────────────────── */

describe("stopping a conversation's turn (A6 F5)", () => {
  const TALK = "44444444-0000-4000-8000-000000000001";

  /** A multi-turn session with its opening turn running. */
  const talking = (
    harness: AgentHarness["Service"],
    driver: ReturnType<typeof turnDrivenSdk>,
  ) =>
    Effect.gen(function* () {
      yield* harness.createSession({
        title: "conversation",
        model: "claude-sonnet-5",
        directory: "/tmp/goal",
        sessionId: TALK,
        multiTurn: true,
      });
      yield* harness.prompt(TALK, "go");
      yield* Effect.promise(() => driver.pulled(1));
    });

  const steer = (harness: AgentHarness["Service"], id: string) =>
    harness.prompt(TALK, `message ${id}`, {
      _tag: "steer",
      urgency: "queued",
      messageId: id.padEnd(32, "0"),
    });

  test("an interrupted turn ends interrupted, the query stays open, and the next message is answered as an ordinary turn", async () => {
    /*
     * Measured on 2.1.310 (`AgentHarness.interruptSession`): the CLI keeps a streaming
     * query open across an interrupt. This used to close it, so Stop ended the
     * conversation and the operator's next message was refused.
     */
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* talking(harness, driver);
        const stopped = yield* harness.interruptSession(TALK);
        driver.emitResult();
        yield* harness.waitForIdle(TALK);
        const afterStop = yield* harness.sessionStatus(TALK);
        const next = yield* steer(harness, "aa");
        yield* Effect.promise(() => driver.pulled(2));
        const runningAgain = yield* harness.sessionStatus(TALK);
        driver.emitResult();
        yield* harness.waitForIdle(TALK);
        const afterNext = yield* harness.sessionStatus(TALK);
        return {
          stopped,
          afterStop,
          next,
          runningAgain,
          afterNext,
          closes: driver.seen.closes,
          interrupts: driver.seen.interrupts,
        };
      }),
    );
    expect(outcome.stopped).toBe(true);
    expect(outcome.interrupts).toBe(1);
    expect(outcome.closes).toBe(0);
    expect(outcome.afterStop.activity).toBe("idle");
    expect(outcome.afterStop.outcome).toBe("interrupted");
    expect(outcome.next.delivered).toBe(true);
    expect(outcome.runningAgain.activity).toBe("running");
    // The interrupt was for the turn it stopped, not for every turn after it.
    expect(outcome.afterNext.outcome).toBe("succeeded");
  });

  test("a message queued behind the stopped turn runs after it, and the session is idle only once it has", async () => {
    // The measured Claude Code behaviour: the queued message is a turn of its own, run at
    // once. `accepted`/`completed` stay paired, so `waitForIdle` waits for it.
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* talking(harness, driver);
        yield* steer(harness, "bb");
        yield* Effect.promise(() => driver.pulled(2));
        const stopped = yield* harness.interruptSession(TALK);
        driver.emitResult();
        yield* Effect.sleep("40 millis");
        const between = yield* harness.sessionStatus(TALK);
        driver.emitResult();
        yield* harness.waitForIdle(TALK);
        const after = yield* harness.sessionStatus(TALK);
        return { stopped, between, after, closes: driver.seen.closes };
      }),
    );
    expect(outcome.stopped).toBe(true);
    expect(outcome.between.activity).toBe("running");
    expect(outcome.after.activity).toBe("idle");
    expect(outcome.after.outcome).toBe("succeeded");
    expect(outcome.closes).toBe(0);
  });

  test("a conversation between turns has nothing to interrupt, and the CLI is not asked", async () => {
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* talking(harness, driver);
        driver.emitResult();
        yield* harness.waitForIdle(TALK);
        const stopped = yield* harness.interruptSession(TALK);
        return { stopped, interrupts: driver.seen.interrupts };
      }),
    );
    expect(outcome.stopped).toBe(false);
    expect(outcome.interrupts).toBe(0);
  });

  test("an interrupt the CLI will not acknowledge fails, and the query is closed", async () => {
    // `false` would say nothing was running, which is the one thing this does not know.
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* talking(harness, driver);
        driver.controls.refuseInterrupt = true;
        const failure = yield* Effect.flip(harness.interruptSession(TALK));
        const status = yield* harness.sessionStatus(TALK);
        return { failure, status, closes: driver.seen.closes };
      }),
    );
    expect(outcome.failure._tag).toBe("HarnessTransportError");
    expect(outcome.failure.message).toContain("would not acknowledge");
    expect(outcome.closes).toBe(1);
    expect(outcome.status.activity).toBe("idle");
  });
});

/* ── Ending a conversation's session ─────────────────────────────────────────── */

describe("ending a conversation's session (A6 F5, from its review)", () => {
  const TALK = "55555555-0000-4000-8000-000000000001";

  const talking = (
    harness: AgentHarness["Service"],
    driver: ReturnType<typeof turnDrivenSdk>,
  ) =>
    Effect.gen(function* () {
      const ref = yield* harness.createSession({
        title: "conversation",
        model: "claude-sonnet-5",
        directory: "/tmp/goal",
        sessionId: TALK,
        multiTurn: true,
      });
      yield* harness.prompt(TALK, "go");
      yield* Effect.promise(() => driver.pulled(1));
      return ref;
    });

  test("a conversation between turns has its query closed, and takes no message afterwards", async () => {
    /*
     * The case the review found: between turns an interrupt is not even sent (nothing is
     * running), so a close that relied on it left the CLI running for the life of the server.
     */
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        const ref = yield* talking(harness, driver);
        driver.emitResult();
        yield* harness.waitForIdle(TALK);
        yield* harness.endSession(ref);
        const status = yield* harness.sessionStatus(TALK);
        const refused = yield* Effect.flip(
          harness.prompt(TALK, "are you there?", {
            _tag: "steer",
            urgency: "queued",
            messageId: "cc".padEnd(32, "0"),
          }),
        );
        return {
          closes: driver.seen.closes,
          interrupts: driver.seen.interrupts,
          status,
          refused: refused._tag,
          pulled: driver.seen.prompts.length,
        };
      }),
    );
    expect(outcome.closes).toBe(1);
    expect(outcome.interrupts).toBe(0);
    expect(outcome.status.activity).toBe("idle");
    expect(outcome.refused).toBe("HarnessTransportError");
    expect(outcome.pulled).toBe(1);
  });

  test("a turn with a message queued behind it is closed, not interrupted, so the queued message never becomes a turn", async () => {
    /*
     * Not interrupted first: on 2.1.310 an interrupt is what makes the CLI go straight on to
     * the queued message. Closing the query takes the CLI, and its queue, away instead.
     */
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        const ref = yield* talking(harness, driver);
        yield* harness.prompt(TALK, "and then the API", {
          _tag: "steer",
          urgency: "queued",
          messageId: "dd".padEnd(32, "0"),
        });
        yield* Effect.promise(() => driver.pulled(2));
        yield* harness.endSession(ref);
        const status = yield* harness.sessionStatus(TALK);
        // Ending twice is ending once.
        yield* harness.endSession(ref);
        return {
          closes: driver.seen.closes,
          interrupts: driver.seen.interrupts,
          status,
        };
      }),
    );
    expect(outcome.interrupts).toBe(0);
    expect(outcome.closes).toBe(1);
    expect(outcome.status.activity).toBe("idle");
  });

  test("a session this process does not hold is already ended", async () => {
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.endSession({
          id: "66666666-0000-4000-8000-000000000001",
        });
        return driver.seen.closes;
      }),
    );
    expect(outcome).toBe(0);
  });
});

/* ── Switching a session's model ─────────────────────────────────────────────── */

describe("switching a Claude Code session's model", () => {
  const LIVE = "33333333-0000-4000-8000-000000000001";

  /** A multi-turn session whose query is running, ready to be switched. */
  const opened = (
    harness: AgentHarness["Service"],
    driver: ReturnType<typeof turnDrivenSdk>,
  ) =>
    Effect.gen(function* () {
      yield* harness.createSession({
        title: "conversation",
        model: "claude-sonnet-5",
        directory: "/tmp/goal",
        sessionId: LIVE,
        multiTurn: true,
        options: [{ id: "effort", value: "low" }],
      });
      yield* harness.prompt(LIVE, "go");
      yield* Effect.promise(() => driver.pulled(1));
    });

  test("before the first prompt, the switch is what the query starts with, and nothing is sent", async () => {
    const sessionId = newClaudeCodeSessionId();
    const seen = await withHarness({}, (harness, launched) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "bit: t",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId,
          options: [{ id: "effort", value: "low" }],
        });
        yield* harness.switchModel(sessionId, "claude-opus-5", [
          { id: "effort", value: "max" },
        ]);
        yield* harness.prompt(sessionId, "go");
        return launched[0];
      }),
    );
    expect(seen?.options.model).toBe("claude-opus-5");
    expect(seen?.options.effort).toBe("max");
    // There was no query to send a control request to, and the launch carried it all.
    expect(seen?.switches).toEqual([]);
  });

  test("a live session is moved with setModel, then given its level", async () => {
    const switches = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        yield* harness.switchModel(LIVE, "claude-opus-5", [
          { id: "effort", value: "high" },
        ]);
        return [...driver.seen.switches];
      }),
    );
    // Model first, so the level is applied to the model it was chosen for.
    expect(switches).toEqual(["model:claude-opus-5", "effort:high"]);
  });

  test("the default level, and no level at all, are sent as null rather than left out", async () => {
    /*
     * `null` is the SDK's "the model's default effort" (`applyFlagSettings`), and the probe
     * measured it doing that: `low`, then `null` on the same model, read back Sonnet 5's
     * default. Leaving the key out instead would keep the previous model's level on the
     * new one — which is a level nobody chose for it.
     */
    const switches = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        yield* harness.switchModel(LIVE, "claude-opus-5", [
          { id: "effort", value: "default" },
        ]);
        yield* harness.switchModel(LIVE, "claude-haiku-4-5");
        return [...driver.seen.switches];
      }),
    );
    expect(switches).toEqual([
      "model:claude-opus-5",
      "effort:null",
      "model:claude-haiku-4-5",
      "effort:null",
    ]);
  });

  test("the same switch twice sends nothing the second time, and a level alone sends only the level", async () => {
    const switches = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        // What the session was opened with: nothing to send.
        yield* harness.switchModel(LIVE, "claude-sonnet-5", [
          { id: "effort", value: "low" },
        ]);
        const afterNoOp = [...driver.seen.switches];
        yield* harness.switchModel(LIVE, "claude-sonnet-5", [
          { id: "effort", value: "high" },
        ]);
        yield* harness.switchModel(LIVE, "claude-sonnet-5", [
          { id: "effort", value: "high" },
        ]);
        return { afterNoOp, all: [...driver.seen.switches] };
      }),
    );
    expect(switches.afterNoOp).toEqual([]);
    expect(switches.all).toEqual(["effort:high"]);
  });

  test("a model change asks for the session's context window again", async () => {
    const reads = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        // The launch's own read is forked; let it land before counting.
        yield* Effect.sleep("20 millis");
        const atLaunch = driver.seen.contextReads;
        yield* harness.switchModel(LIVE, "claude-sonnet-5", [
          { id: "effort", value: "high" },
        ]);
        yield* Effect.sleep("20 millis");
        const afterLevelOnly = driver.seen.contextReads;
        yield* harness.switchModel(LIVE, "claude-opus-5");
        yield* Effect.sleep("20 millis");
        return {
          atLaunch,
          afterLevelOnly,
          afterModel: driver.seen.contextReads,
        };
      }),
    );
    expect(reads.atLaunch).toBe(1);
    // The window is the model's: a level changes nothing about it.
    expect(reads.afterLevelOnly).toBe(1);
    expect(reads.afterModel).toBe(2);
  });

  test("a refused setModel fails, and the retry sends it again", async () => {
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.refuse = "setModel";
        const refused = yield* Effect.flip(
          harness.switchModel(LIVE, "claude-opus-5"),
        );
        driver.controls.refuse = undefined;
        yield* harness.switchModel(LIVE, "claude-opus-5");
        return { refused, switches: [...driver.seen.switches] };
      }),
    );
    expect(outcome.refused._tag).toBe("HarnessTransportError");
    if (outcome.refused._tag === "HarnessTransportError") {
      expect(outcome.refused.operation).toBe("query.setModel");
      expect(outcome.refused.detail).toContain("the CLI refused setModel");
    }
    expect(outcome.switches).toEqual([
      "model:claude-opus-5",
      "model:claude-opus-5",
      "effort:null",
    ]);
  });

  test("after a switch that timed out, going back to the old model is still sent", async () => {
    /*
     * A `setModel` that never answered may have been taken anyway — a timeout says nothing
     * about what the CLI did — so the session is on the old model or the new one and
     * nobody knows which. The record still says the old one. A switch *back* to it is the
     * retry a record-only comparison gets wrong: model and level both "already match", it
     * would send nothing, and the session could stay on the model the operator just
     * backed out of. Both requests must go.
     */
    const switches = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.hang = "setModel";
        yield* Effect.flip(
          harness.switchModel(LIVE, "claude-opus-5", [
            { id: "effort", value: "high" },
          ]),
        );
        driver.controls.hang = undefined;
        yield* harness.switchModel(LIVE, "claude-sonnet-5", [
          { id: "effort", value: "low" },
        ]);
        // Settled now: the same switch again sends nothing.
        yield* harness.switchModel(LIVE, "claude-sonnet-5", [
          { id: "effort", value: "low" },
        ]);
        return [...driver.seen.switches];
      }),
    );
    expect(switches).toEqual([
      "model:claude-opus-5",
      "model:claude-sonnet-5",
      "effort:low",
    ]);
  }, 20_000);

  test("a level that was refused after the model moved is sent again by the same switch", async () => {
    const switches = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.refuse = "applyFlagSettings";
        yield* Effect.flip(
          harness.switchModel(LIVE, "claude-opus-5", [
            { id: "effort", value: "high" },
          ]),
        );
        driver.controls.refuse = undefined;
        yield* harness.switchModel(LIVE, "claude-opus-5", [
          { id: "effort", value: "high" },
        ]);
        return [...driver.seen.switches];
      }),
    );
    // The retry sends both, not just the level: an unfinished switch makes the record no
    // evidence of either, and a second `setModel` to the model the CLI is on is harmless.
    expect(switches).toEqual([
      "model:claude-opus-5",
      "effort:high",
      "model:claude-opus-5",
      "effort:high",
    ]);
  });

  test("a control request that never answers fails on the control bound", async () => {
    const failure = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.hang = "setModel";
        return yield* Effect.flip(harness.switchModel(LIVE, "claude-opus-5"));
      }),
    );
    expect(failure._tag).toBe("HarnessTransportError");
    if (failure._tag === "HarnessTransportError") {
      expect(failure.operation).toBe("query.setModel");
      expect(failure.tag).toBe("TimeoutError");
      expect(failure.detail).toContain("whether it took the change is unknown");
    }
  }, 20_000);

  test("a switch whose query closes while it waits is refused as not found, not left uncertain", async () => {
    /*
     * `setModel` takes about a second to be answered (the probe measured 1.0–1.2 s), and
     * the query can close inside that second: an interrupt of a single-turn session, a
     * stream failure, or a single-turn session's turn ending. The SDK then rejects every
     * pending control request. A plain transport failure there reads as "uncertain", so
     * the caller keeps the row on the old model — and the next resume, which reads the
     * row, starts on the model the operator just switched away from. The query is gone;
     * the answer is the same one a switch arriving a moment later gets: not found, update
     * the row.
     *
     * Single-turn, because only there does an interrupt close the query: a conversation's
     * stays open across one (A6 F5, the tests under "stopping a conversation's turn").
     */
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* harness.createSession({
          title: "round",
          model: "claude-sonnet-5",
          directory: "/tmp/ws",
          sessionId: LIVE,
        });
        yield* harness.prompt(LIVE, "go");
        yield* Effect.promise(() => driver.pulled(1));
        driver.controls.hang = "setModel";
        const switching = yield* Effect.forkChild(
          Effect.flip(harness.switchModel(LIVE, "claude-opus-5")),
        );
        for (let tries = 0; driver.seen.switches.length === 0; tries += 1) {
          if (tries > 200) throw new Error("setModel was never sent");
          yield* Effect.sleep("5 millis");
        }
        const stopped = yield* harness.interruptSession(LIVE);
        const failure = yield* Fiber.join(switching);
        return { stopped, failure, switches: [...driver.seen.switches] };
      }),
    );
    expect(outcome.stopped).toBe(true);
    expect(outcome.switches).toEqual(["model:claude-opus-5"]);
    expect(outcome.failure._tag).toBe("HarnessTransportError");
    if (outcome.failure._tag === "HarnessTransportError") {
      expect(outcome.failure.operation).toBe("session.switchModel");
      expect(outcome.failure.tag).toBe(SESSION_NOT_FOUND_TAG);
      expect(outcome.failure.status).toBe(404);
    }
  });

  test("a switch whose stream fails while it waits is refused as not found, though the SDK rejects the request first", async () => {
    /*
     * The same answer as the interrupt above, reached in the order that makes it hard: the
     * SDK rejects the pending `setModel` *before* it errors the stream, so the switch's
     * failure arrives while the pump has not yet seen the stream end and the record does
     * not yet say the session is going. Read then, it is a plain transport failure — an
     * "uncertain" switch on a query that no longer exists.
     */
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.hang = "setModel";
        const switching = yield* Effect.forkChild(
          Effect.flip(harness.switchModel(LIVE, "claude-opus-5")),
        );
        for (let tries = 0; driver.seen.switches.length === 0; tries += 1) {
          if (tries > 200) throw new Error("setModel was never sent");
          yield* Effect.sleep("5 millis");
        }
        driver.failStream(new Error("the CLI exited with code 1"));
        const failure = yield* Fiber.join(switching);
        return { failure, switches: [...driver.seen.switches] };
      }),
    );
    expect(outcome.switches).toEqual(["model:claude-opus-5"]);
    expect(outcome.failure._tag).toBe("HarnessTransportError");
    if (outcome.failure._tag === "HarnessTransportError") {
      expect(outcome.failure.operation).toBe("session.switchModel");
      expect(outcome.failure.tag).toBe(SESSION_NOT_FOUND_TAG);
      expect(outcome.failure.status).toBe(404);
    }
  });

  test("a switch whose stream ends cleanly while it waits is refused as not found", async () => {
    /*
     * The CLI exiting with code 0 under a conversation: no error anywhere, the pump's
     * `for await` simply finishes. The SDK still rejects the pending `setModel` first, and
     * the switch is resumed by `ended` on the pump's own call stack, before `closeSession`
     * has marked the record closed. Unless the pump marked it as going before that, the
     * switch reads a live session and reports a plain, "uncertain", failure.
     */
    const outcome = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.hang = "setModel";
        const switching = yield* Effect.forkChild(
          Effect.flip(harness.switchModel(LIVE, "claude-opus-5")),
        );
        for (let tries = 0; driver.seen.switches.length === 0; tries += 1) {
          if (tries > 200) throw new Error("setModel was never sent");
          yield* Effect.sleep("5 millis");
        }
        driver.endStream();
        const failure = yield* Fiber.join(switching);
        return { failure, switches: [...driver.seen.switches] };
      }),
    );
    expect(outcome.switches).toEqual(["model:claude-opus-5"]);
    expect(outcome.failure._tag).toBe("HarnessTransportError");
    if (outcome.failure._tag === "HarnessTransportError") {
      expect(outcome.failure.operation).toBe("session.switchModel");
      expect(outcome.failure.tag).toBe(SESSION_NOT_FOUND_TAG);
      expect(outcome.failure.status).toBe(404);
    }
  });

  test("two switches at once are taken one after the other, so the later one's timeout is not forgotten", async () => {
    /*
     * A goes to (opus, low) and B to (haiku, high), started together. Interleaved, A could
     * finish while B's level was still unanswered and clear the flag that says the record
     * is no evidence: B then times out, the record says haiku/low *settled* while the CLI
     * may be at high, and a later (haiku, low) is skipped as a no-op. Taken in turn, B's
     * timeout is the last word, and the later switch is sent.
     */
    const switches = await withTurnDriven((harness, driver) =>
      Effect.gen(function* () {
        yield* opened(harness, driver);
        driver.controls.hangOn = "effort:high";
        const first = yield* Effect.forkChild(
          harness.switchModel(LIVE, "claude-opus-5", [
            { id: "effort", value: "low" },
          ]),
        );
        const second = yield* Effect.forkChild(
          Effect.flip(
            harness.switchModel(LIVE, "claude-haiku-4-5", [
              { id: "effort", value: "high" },
            ]),
          ),
        );
        yield* Fiber.join(first);
        const timedOut = yield* Fiber.join(second);
        driver.controls.hangOn = undefined;
        yield* harness.switchModel(LIVE, "claude-haiku-4-5", [
          { id: "effort", value: "low" },
        ]);
        return {
          timedOut:
            timedOut._tag === "HarnessTransportError"
              ? timedOut.tag
              : undefined,
          all: [...driver.seen.switches],
        };
      }),
    );
    expect(switches.timedOut).toBe("TimeoutError");
    expect(switches.all).toEqual([
      "model:claude-opus-5",
      "effort:low",
      "model:claude-haiku-4-5",
      "effort:high",
      // The record is unsettled after B, so the switch back to `low` is sent in full.
      "model:claude-haiku-4-5",
      "effort:low",
    ]);
  }, 20_000);

  test("a session this process does not hold live is refused as not found, and nothing is sent", async () => {
    /*
     * Two ways of not holding one: never having had it (another process opened it, or
     * this one restarted), and a single-turn session whose query closed when its turn
     * ended. Neither has a query to send a control request to; a resume opens a new query
     * on whatever model its caller passes, which is the session row's.
     */
    const sessionId = newClaudeCodeSessionId();
    const outcome = await withHarness(
      { messages: [assistant(sessionId), result(sessionId, "success")] },
      (harness, launched) =>
        Effect.gen(function* () {
          const unknown = yield* Effect.flip(
            harness.switchModel(
              "44444444-0000-4000-8000-000000000001",
              "claude-opus-5",
            ),
          );
          yield* harness.createSession({
            title: "bit: round",
            model: "claude-sonnet-5",
            directory: "/tmp/ws",
            sessionId,
          });
          yield* harness.prompt(sessionId, "go");
          yield* harness.waitForIdle(sessionId);
          const closed = yield* Effect.flip(
            harness.switchModel(sessionId, "claude-opus-5"),
          );
          return { unknown, closed, switches: launched[0]?.switches };
        }),
    );
    for (const failure of [outcome.unknown, outcome.closed]) {
      expect(failure._tag).toBe("HarnessTransportError");
      if (failure._tag === "HarnessTransportError") {
        expect(failure.tag).toBe(SESSION_NOT_FOUND_TAG);
        expect(failure.status).toBe(404);
      }
    }
    expect(outcome.switches).toEqual([]);
  });
});

/* ── Ending a session stops its CLI, now (A6 F5, second review) ─────────────── */

describe("ending a session stops the CLI it runs in, and what that CLI started", () => {
  /*
   * The review's finding: `Query.close()` only ends the CLI's stdin, and SDK 0.3.310 sends
   * `SIGTERM` 2 s later, so an ended import's CLI went on to run a tool 0.93 s after its end
   * had returned. These run a real stand-in for the CLI — a shell with a child of its own,
   * as a CLI running a tool has — through the harness's own spawner, which is the thing
   * under test: the scripted SDK asks for the process exactly as the real one does, through
   * `options.spawnClaudeCodeProcess`.
   */
  const TALK = "77777777-0000-4000-8000-000000000001";

  /** An SDK whose query spawns `script` and then reads nothing until it is closed. */
  const spawningSdk = (script: string) => {
    const seen = { closes: 0, leader: undefined as number | undefined };
    const sdk: ClaudeCodeSdk = {
      query: ({ prompt, options }) => {
        const spawn = options.spawnClaudeCodeProcess;
        if (spawn === undefined)
          throw new Error("the harness spawned nothing itself");
        const child = spawn({
          command: "sh",
          args: ["-c", script],
          env: { PATH: process.env["PATH"] },
          signal: new AbortController().signal,
        });
        seen.leader = (child as unknown as { pid?: number }).pid;
        // Pulls the opening prompt, as the SDK does, so `launch` is not left parked.
        void (async () => {
          for await (const _message of prompt) void _message;
        })();
        let wake: (() => void) | undefined;
        let closed = false;
        const query: HarnessQuery = {
          setMcpServers: async () => ({}),
          interrupt: async () => undefined,
          getContextUsage: async () => ({}),
          setModel: async () => undefined,
          applyFlagSettings: async () => undefined,
          close: () => {
            // What the SDK's own close does at once: end the CLI's stdin. Its `SIGTERM`
            // comes 2 s later, which no test here waits for.
            seen.closes += 1;
            closed = true;
            child.stdin.end();
            wake?.();
          },
          // Nothing to say until it is closed, and then the stream ends.
          [Symbol.asyncIterator]: async function* () {
            while (!closed) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            yield* [] as SDKMessage[];
          },
        };
        return query;
      },
      sessionMessages: () => Promise.resolve([]),
      sessionInfo: () => Promise.resolve(undefined),
    };
    return { sdk, seen };
  };

  /** Opens a conversation on a CLI running `script`, ends it, and says what was left. */
  const endedWhileRunning = async (script: (pidFile: string) => string) => {
    const scratch = await mkdtemp(join(tmpdir(), "bit-cli-stop-"));
    const pidFile = join(scratch, "tool.pid");
    const { sdk, seen } = spawningSdk(script(pidFile));
    try {
      return await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(AgentHarness, (harness) =>
            Effect.gen(function* () {
              const ref = yield* harness.createSession({
                title: "conversation",
                model: "claude-sonnet-5",
                directory: scratch,
                sessionId: TALK,
                multiTurn: true,
              });
              yield* harness.prompt(TALK, "go");
              // The stand-in's own child writes its pid once it is running.
              const tool = yield* Effect.promise(async () => {
                for (let tries = 0; tries < 200; tries += 1) {
                  const text = await readFile(pidFile, "utf8").catch(() => "");
                  if (text.trim() !== "") return Number(text.trim());
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
                throw new Error("the stand-in CLI never started its tool");
              });
              const leader = seen.leader;
              if (leader === undefined) throw new Error("no CLI was spawned");
              const before = {
                leader: processIdentity(leader) !== undefined,
                tool: processIdentity(tool) !== undefined,
              };
              const started = Date.now();
              yield* harness.endSession(ref);
              const took = Date.now() - started;
              // Read at the instant `endSession` returned: that is the contract.
              const after = {
                leader: processIdentity(leader) !== undefined,
                tool: processIdentity(tool) !== undefined,
              };
              // Ending twice is ending once.
              yield* harness.endSession(ref);
              return { before, after, took, closes: seen.closes };
            }),
          ).pipe(
            Effect.provide(
              claudeCodeHarness({
                sdk,
                controlTimeout: "2 seconds",
                cliStopBounds: { terminateGrace: 300, killGrace: 500, poll: 5 },
              }),
            ),
            Effect.orDie,
          ),
        ),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  test("the CLI and the tool it is running are gone by the time endSession returns", async () => {
    const outcome = await endedWhileRunning(
      (pidFile) => `sleep 30 & echo $! > '${pidFile}'; wait`,
    );
    expect(outcome.before).toEqual({ leader: true, tool: true });
    expect(outcome.after).toEqual({ leader: false, tool: false });
    expect(outcome.closes).toBe(1);
    // Inside the SIGTERM grace, and far inside the SDK's own 2 s.
    expect(outcome.took).toBeLessThan(1_000);
  }, 10_000);

  test("a CLI that ignores SIGTERM is killed, tool and all, within the bounds", async () => {
    // `trap '' TERM` is inherited by the child, so neither of them goes on SIGTERM.
    const outcome = await endedWhileRunning(
      (pidFile) => `trap '' TERM; sleep 30 & echo $! > '${pidFile}'; wait`,
    );
    expect(outcome.before).toEqual({ leader: true, tool: true });
    expect(outcome.after).toEqual({ leader: false, tool: false });
    expect(outcome.took).toBeGreaterThanOrEqual(250);
    expect(outcome.took).toBeLessThan(1_500);
  }, 10_000);

  test("a resumed opening under the same id is not ended by the earlier opening's close", async () => {
    /*
     * The race the review named: an old close ending "the session with this id" while a
     * resume under that id has created its session ends the new CLI and orphans the old one.
     * Ending by ref ends the opening the ref stands for.
     */
    const driver = turnDrivenSdk();
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(AgentHarness, (harness) =>
          Effect.gen(function* () {
            const first = yield* harness.createSession({
              title: "conversation",
              model: "claude-sonnet-5",
              directory: "/tmp/goal",
              sessionId: TALK,
              multiTurn: true,
            });
            const second = yield* harness.createSession({
              title: "conversation",
              model: "claude-sonnet-5",
              directory: "/tmp/goal",
              resume: TALK,
              multiTurn: true,
            });
            yield* harness.prompt(TALK, "go");
            yield* Effect.promise(() => driver.pulled(1));
            // The earlier opening's close, landing after the resume took the id.
            yield* harness.endSession(first);
            const afterFirst = driver.seen.closes;
            yield* harness.endSession(second);
            return { afterFirst, afterSecond: driver.seen.closes };
          }),
        ).pipe(
          Effect.provide(
            claudeCodeHarness({ sdk: driver.sdk, controlTimeout: "2 seconds" }),
          ),
          Effect.orDie,
        ),
      ),
    );
    // The query belongs to the second opening: the first's end closed nothing of it.
    expect(outcome).toEqual({ afterFirst: 0, afterSecond: 1 });
  });
});
