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
import { describe, expect, test } from "bun:test";
import type {
  McpServerConfig,
  Options,
  SDKMessage,
  SessionMessage,
  SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Fiber, Redacted, Stream } from "effect";

import { CLAUDE_CODE_MINIMUM, compareVersions } from "../policy/claudeCodeGate";
import { AgentHarness, SESSION_NOT_FOUND_TAG } from "./agentHarness";
import {
  claudeCodeHarness,
  newClaudeCodeSessionId,
  type ClaudeCodeSdk,
  type HarnessQuery,
} from "./claudeCodeClient";

/* ── A scripted SDK ──────────────────────────────────────────────────────────── */

/** What one `query()` call did, as the test watches it. */
interface Launched {
  readonly options: Options;
  /** `setMcpServers` and `prompt`, in the order they happened. */
  readonly order: string[];
  readonly registered: Record<string, McpServerConfig>[];
  readonly prompts: string[];
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
      Promise.resolve([
        {
          type: "assistant",
          uuid: "u",
          session_id: sessionId,
          message: { content: [{ type: "text", text: "stored reply" }] },
          parent_tool_use_id: null,
          parent_agent_id: null,
        } satisfies SessionMessage,
      ]),
    sessionInfo: (sessionId) =>
      Promise.resolve(
        (script.stored ?? []).includes(sessionId)
          ? ({
              sessionId,
              summary: "s",
              lastModified: 1,
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
  test("an id the transcript knows cannot be asked about, and says why", async () => {
    // A Claude Code session is run by a subprocess the SDK owns, so an id this process
    // does not hold is a session that is *not running* — whatever the transcript says.
    // Reporting "exists, nothing definite" here made recovery record `still_running` and
    // leave the row `running` forever, which a live crash-and-restart caught; see
    // `claudeCodeClient.ts`. So this fails, and recovery reads it as uncertain.
    const failure = await withHarness(
      { stored: ["11111111-0000-4000-8000-000000000001"] },
      (harness) =>
        Effect.result(
          harness.sessionStatus("11111111-0000-4000-8000-000000000001"),
        ),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      const error = failure.failure as { tag?: string; message: string };
      // Not the not-found tag: we *do* have its transcript, and recovery's detail should
      // say so rather than claiming the harness has never heard of it.
      expect(error.tag).not.toBe(SESSION_NOT_FOUND_TAG);
      expect(error.message).toContain("does not outlive the process");
    }
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
});
