/**
 * Claude Code as one of several configured instances (`instanceConfig.ts`): its identity,
 * what each CLI it spawns is given, two of them in one process, a provider's retries, and
 * an aliasing provider's model spellings.
 *
 * Over a scripted SDK, like `claudeCodeClient.test.ts`: what is checked is what this harness
 * does with what the SDK says, and what it asks the SDK for.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Options,
  SDKMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Effect, Fiber, Layer, Stream } from "effect";

import { AgentHarness } from "./agentHarness";
import {
  claudeCodeHarness,
  modelOfApiUsage,
  newClaudeCodeSessionId,
  type ClaudeCodeHarnessOptions,
  type ClaudeContextUsage,
  type ClaudeCodeSdk,
  type HarnessQuery,
} from "./claudeCodeClient";
import { InstanceId } from "./identity";
import { readLearnedModelNames } from "./learnedModelNames";

interface Script {
  readonly messages?: readonly SDKMessage[];
  readonly transcript?: readonly SessionMessage[];
  readonly contextModel?: string;
  /** What the context read answers as `apiUsage`; `null` when absent. */
  readonly apiUsage?: ClaudeContextUsage["apiUsage"];
  /** Holds the stream open after the script, as a live conversation's CLI does. */
  readonly stayOpen?: boolean;
}

/** A `query()` that yields its script once the prompt is pulled, and the options it got. */
const scriptedSdk = (script: Script = {}) => {
  const launched: Options[] = [];
  const sdk: ClaudeCodeSdk = {
    query: ({ prompt, options }) => {
      launched.push(options);
      let pulled: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        pulled = resolve;
      });
      let release: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      void (async () => {
        for await (const message of prompt)
          if (message !== undefined) pulled?.();
      })();
      const query: HarnessQuery = {
        setMcpServers: async () => ({}),
        interrupt: async () => undefined,
        stopTask: async () => undefined,
        getContextUsage: async () => ({
          maxTokens: 200_000,
          ...(script.contextModel === undefined
            ? {}
            : { model: script.contextModel }),
          apiUsage: script.apiUsage ?? null,
        }),
        setModel: async () => undefined,
        applyFlagSettings: async () => undefined,
        close: () => release?.(),
        [Symbol.asyncIterator]: async function* () {
          await ready;
          for (const message of script.messages ?? []) yield message;
          if (script.stayOpen === true) await closed;
        },
      };
      return query;
    },
    sessionMessages: () => Promise.resolve(script.transcript ?? []),
    sessionInfo: () => Promise.resolve(undefined),
    subagentMessages: () => Promise.resolve([]),
    listSubagents: () => Promise.resolve([]),
  };
  return { sdk, launched };
};

class Stock extends Context.Service<Stock, AgentHarness["Service"]>()(
  "test/Stock",
) {}
class Zai extends Context.Service<Zai, AgentHarness["Service"]>()("test/Zai") {}

const ZAI: ClaudeCodeHarnessOptions = {
  instanceId: InstanceId.make("cc-zai"),
  displayName: "Claude Code · z.ai",
  configDir: "/cc/zai",
  provider: "zai",
  models: [
    { id: "opus", label: "GLM-5.3" },
    { id: "sonnet", label: "GLM-5.3 Flash" },
  ],
  defaultModel: "sonnet",
  maxRetries: 1,
};

const withHarness = <A>(
  options: ClaudeCodeHarnessOptions,
  use: (harness: AgentHarness["Service"]) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(AgentHarness, use).pipe(
        Effect.provide(
          claudeCodeHarness({ controlTimeout: "2 seconds", ...options }),
        ),
        Effect.orDie,
      ),
    ),
  );

/** One turn on `model`, its narration collected. */
const turn = (
  harness: AgentHarness["Service"],
  model: string,
  multiTurn = false,
) =>
  Effect.gen(function* () {
    const sessionId = newClaudeCodeSessionId();
    const ref = yield* harness.createSession({
      title: "bit: t",
      model,
      directory: "/tmp/ws",
      sessionId,
      ...(multiTurn ? { multiTurn: true } : {}),
    });
    const narration = yield* Effect.forkChild(
      Stream.runCollect(harness.sessionEvents(sessionId)),
    );
    yield* harness.prompt(sessionId, "go");
    yield* harness.waitForIdle(sessionId);
    if (multiTurn) return { sessionId, ref, narrated: [] };
    return { sessionId, ref, narrated: [...(yield* Fiber.join(narration))] };
  });

const init = (model: string): SDKMessage =>
  ({
    type: "system",
    subtype: "init",
    model,
    session_id: "s",
    uuid: "00000000-0000-4000-8000-000000000001",
  }) as unknown as SDKMessage;

const assistant = (model: string): SDKMessage =>
  ({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model,
      content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: "00000000-0000-4000-8000-000000000002",
  }) as unknown as SDKMessage;

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  result: "OK",
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {},
  permission_denials: [],
  session_id: "s",
  uuid: "00000000-0000-4000-8000-00000000ffff",
} as unknown as SDKMessage;

describe("a configured instance", () => {
  test("is the instance the file named, with its catalogue and labels", async () => {
    const { sdk } = scriptedSdk();
    const instance = await withHarness({ ...ZAI, sdk }, (harness) =>
      Effect.succeed(harness.instance),
    );
    expect(String(instance.instanceId)).toBe("cc-zai");
    expect(String(instance.driver)).toBe("claude-code");
    expect(instance.displayName).toBe("Claude Code · z.ai");
    expect(instance.defaultModel).toBe("sonnet");
    // The default first, as for the stock list.
    expect(instance.models).toEqual([
      { id: "sonnet", label: "GLM-5.3 Flash" },
      { id: "opus", label: "GLM-5.3" },
    ]);
  });

  test("a configured model the stock list knows keeps its reasoning descriptor", async () => {
    const { sdk } = scriptedSdk();
    const instance = await withHarness(
      { sdk, models: [{ id: "claude-sonnet-5", label: "Sonnet" }] },
      (harness) => Effect.succeed(harness.instance),
    );
    expect(instance.defaultModel).toBe("claude-sonnet-5");
    expect(instance.models[0]?.label).toBe("Sonnet");
    expect(instance.models[0]?.optionDescriptors?.[0]?.id).toBe("effort");
  });

  test("provenance records the instance's provider, and the model as asked", async () => {
    const { sdk } = scriptedSdk();
    expect(
      await withHarness({ ...ZAI, sdk }, (harness) =>
        Effect.succeed(harness.modelProvenance("sonnet")),
      ),
    ).toEqual({ providerId: "zai", modelId: "sonnet" });
    expect(
      await withHarness({ sdk }, (harness) =>
        Effect.succeed(harness.modelProvenance("claude-sonnet-5")),
      ),
    ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5" });
  });
});

describe("what each CLI is given", () => {
  test("the instance's folder and retry bound, on top of this process's environment", async () => {
    const { sdk, launched } = scriptedSdk({ messages: [success] });
    await withHarness({ ...ZAI, sdk }, (harness) => turn(harness, "sonnet"));
    const env = launched[0]?.env;
    expect(env?.["CLAUDE_CONFIG_DIR"]).toBe("/cc/zai");
    expect(env?.["CLAUDE_CODE_MAX_RETRIES"]).toBe("1");
    expect(env?.["PATH"]).toBe(process.env["PATH"]);
  });

  test("an instance with neither leaves the SDK's default environment alone", async () => {
    const { sdk, launched } = scriptedSdk({ messages: [success] });
    await withHarness({ sdk }, (harness) => turn(harness, "claude-sonnet-5"));
    expect(launched[0]?.env).toBeUndefined();
  });

  test("two instances in one process each launch on their own folder", async () => {
    const stock = scriptedSdk({ messages: [success] });
    const zai = scriptedSdk({ messages: [success] });
    // Each harness built as its own layer, as the resolver builds each candidate.
    const both = Layer.mergeAll(
      Layer.effect(
        Stock,
        Effect.map(AgentHarness, (harness) => harness),
      ).pipe(
        Layer.provide(
          claudeCodeHarness({ sdk: stock.sdk, controlTimeout: "2 seconds" }),
        ),
      ),
      Layer.effect(
        Zai,
        Effect.map(AgentHarness, (harness) => harness),
      ).pipe(
        Layer.provide(
          claudeCodeHarness({
            ...ZAI,
            sdk: zai.sdk,
            controlTimeout: "2 seconds",
          }),
        ),
      ),
    );
    const sessions = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const left = yield* Stock;
          const right = yield* Zai;
          const [a, b] = yield* Effect.all(
            [turn(left, "claude-haiku-4-5"), turn(right, "sonnet")],
            { concurrency: "unbounded" },
          );
          // Each holds its own session and not the other's.
          const crossed = yield* Effect.result(
            right.sessionStatus(a.sessionId),
          );
          return { a, b, crossed, ids: [left.instance, right.instance] };
        }).pipe(Effect.provide(both), Effect.orDie),
      ),
    );
    expect(stock.launched[0]?.env).toBeUndefined();
    expect(zai.launched[0]?.env?.["CLAUDE_CONFIG_DIR"]).toBe("/cc/zai");
    expect(sessions.ids.map((each) => String(each.instanceId))).toEqual([
      "claude-code",
      "cc-zai",
    ]);
    expect(sessions.crossed._tag).toBe("Failure");
  });
});

describe("a provider's retries", () => {
  test("each api_retry frame is a retry entry with its counters", async () => {
    const { sdk } = scriptedSdk({
      messages: [
        init("glm-5.3-flash"),
        {
          type: "system",
          subtype: "api_retry",
          attempt: 3,
          max_retries: 10,
          retry_delay_ms: 2_150,
          error_status: 429,
          error: "rate_limit",
          session_id: "s",
          uuid: "00000000-0000-4000-8000-000000000003",
        } as unknown as SDKMessage,
        success,
      ],
    });
    const { narrated } = await withHarness({ ...ZAI, sdk }, (harness) =>
      turn(harness, "sonnet"),
    );
    expect(
      narrated
        .map((entry) => entry.detail)
        .filter((detail) => detail._tag === "retry"),
    ).toEqual([
      {
        _tag: "retry",
        attempt: 3,
        maxRetries: 10,
        delayMs: 2_150,
        status: 429,
        error: "rate_limit",
      },
    ]);
  });
});

describe("an aliasing provider's model spellings", () => {
  const models = (narrated: readonly { readonly detail: unknown }[]) =>
    narrated
      .map((entry) => entry.detail as { _tag: string; model?: string })
      .filter((detail) => detail.model !== undefined)
      .map((detail) => `${detail._tag}:${String(detail.model)}`);

  test("a frame's provider name reads as the catalogue model the session was asked for", async () => {
    const { sdk } = scriptedSdk({
      messages: [init("glm-5.3-flash"), assistant("glm-5.3-flash"), success],
    });
    const { narrated } = await withHarness({ ...ZAI, sdk }, (harness) =>
      turn(harness, "sonnet"),
    );
    expect(models(narrated)).toEqual(["reply:sonnet", "usage:sonnet"]);
  });

  test("the provider's name of a model is on the catalogue, declared or once a session reported it (follow-ups A)", async () => {
    const declared = await withHarness(
      {
        ...ZAI,
        sdk: scriptedSdk().sdk,
        models: [
          { id: "opus", reportedAs: "glm-5.3" },
          { id: "sonnet", label: "GLM-5.3 Flash" },
        ],
      },
      (harness) => Effect.succeed(harness.instance.models),
    );
    expect(declared.map((entry) => entry.reportedAs)).toEqual([
      undefined,
      "glm-5.3",
    ]);

    const { sdk } = scriptedSdk({
      messages: [init("glm-5.3-flash"), assistant("glm-5.3-flash"), success],
    });
    const learned = await withHarness(
      { ...ZAI, sdk, models: [{ id: "sonnet" }, { id: "opus" }] },
      (harness) =>
        Effect.gen(function* () {
          const before = harness.instance.models.map(
            (entry) => entry.reportedAs,
          );
          yield* turn(harness, "sonnet");
          return {
            before,
            after: harness.instance.models.map((entry) => entry.reportedAs),
          };
        }),
    );
    expect(learned.before).toEqual([undefined, undefined]);
    expect(learned.after).toEqual(["glm-5.3-flash", undefined]);
  });

  test("a provider's name a session reported is kept for the next run: the picker, a replay and the meter say the model, not the alias (follow-ups A review, M2)", async () => {
    const folder = mkdtempSync(join(tmpdir(), "bit-model-names-"));
    const file = join(folder, "cc-zai.json");
    try {
      const { sdk } = scriptedSdk({
        messages: [init("glm-5.3"), assistant("glm-5.3"), success],
      });
      await withHarness(
        {
          ...ZAI,
          sdk,
          models: [{ id: "sonnet" }, { id: "opus" }],
          learnedModelNamesFile: file,
        },
        (harness) => turn(harness, "opus"),
      );
      expect(readLearnedModelNames(file)).toEqual(
        new Map([["opus", "glm-5.3"]]),
      );

      // The next run: no session has said anything yet.
      const restarted = scriptedSdk({
        transcript: [
          {
            type: "assistant",
            uuid: "u1",
            session_id: "s",
            message: {
              id: "msg_1",
              model: "glm-5.3",
              content: [{ type: "text", text: "stored" }],
              usage: { input_tokens: 5, output_tokens: 1 },
            },
            parent_tool_use_id: null,
            parent_agent_id: null,
          },
        ],
      });
      const after = await withHarness(
        {
          ...ZAI,
          sdk: restarted.sdk,
          models: [{ id: "sonnet" }, { id: "opus" }],
          learnedModelNamesFile: file,
        },
        (harness) =>
          Effect.gen(function* () {
            const sessionId = newClaudeCodeSessionId();
            return {
              names: harness.instance.models.map((entry) => [
                entry.id,
                entry.reportedAs,
              ]),
              replayed: (yield* harness.messages(sessionId)).map(
                (entry) => entry.model,
              ),
              measured: (yield* harness.contextUsage(sessionId, {
                model: "opus",
                breakdown: false,
              })).usedModel,
            };
          }),
      );
      expect(after.names).toEqual([
        ["sonnet", undefined],
        ["opus", "glm-5.3"],
      ]);
      expect(after.replayed).toEqual(["opus"]);
      expect(after.measured).toBe("opus");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a declared spelling is read before any session said it: a replay after a restart", async () => {
    const { sdk } = scriptedSdk({
      transcript: [
        {
          type: "assistant",
          uuid: "u1",
          session_id: "s",
          message: {
            id: "msg_1",
            model: "glm-5.3",
            content: [{ type: "text", text: "stored" }],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          parent_agent_id: null,
        },
      ],
    });
    const entries = await withHarness(
      {
        ...ZAI,
        sdk,
        models: [
          { id: "opus", label: "GLM-5.3", reportedAs: "glm-5.3" },
          { id: "sonnet", label: "GLM-5.3 Flash" },
        ],
      },
      (harness) => harness.messages(newClaudeCodeSessionId()),
    );
    expect(entries.map((entry) => entry.model)).toEqual(["opus"]);
    expect(
      entries.flatMap((entry) =>
        entry.parts.map((part) => (part as { model?: string }).model),
      ),
    ).toEqual(["opus"]);
  });

  test("a context read names the measured call by its catalogue model", async () => {
    const { sdk } = scriptedSdk({
      messages: [init("glm-5.3-flash"), assistant("glm-5.3-flash"), success],
      contextModel: "glm-5.3-flash",
      transcript: [
        {
          type: "assistant",
          uuid: "u1",
          session_id: "s",
          message: {
            id: "msg_1",
            model: "glm-5.3-flash",
            content: [{ type: "text", text: "OK" }],
            usage: { input_tokens: 10, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          parent_agent_id: null,
        },
      ],
    });
    const usage = await withHarness({ ...ZAI, sdk }, (harness) =>
      Effect.gen(function* () {
        const { sessionId } = yield* turn(harness, "sonnet");
        return yield* harness.contextUsage(sessionId, {
          model: "sonnet",
          breakdown: false,
        });
      }),
    );
    // The turn closed its single-turn session, so this is the transcript's reading: the
    // stored call's provider name, in the catalogue's spelling.
    expect(usage.usedModel).toBe("sonnet");
  });

  test("a z.ai call's figure, stated only on message_delta, labels the live context read", async () => {
    // z.ai's frames as measured (slice 1 re-check): `message_start` and the `assistant`
    // frame carry zero usage, and only the `message_delta` stream event has the call's
    // prompt side, which `getContextUsage().apiUsage` equals.
    const zero = { input_tokens: 0, output_tokens: 0 };
    const stream = (event: unknown): SDKMessage =>
      ({
        type: "stream_event",
        event,
        parent_tool_use_id: null,
        session_id: "s",
        uuid: "00000000-0000-4000-8000-0000000000aa",
      }) as unknown as SDKMessage;
    const zeroAssistant = {
      ...(assistant("glm-5.3-flash") as unknown as Record<string, unknown>),
      message: {
        id: "msg_1",
        role: "assistant",
        model: "glm-5.3-flash",
        content: [{ type: "text", text: "OK" }],
        usage: zero,
      },
    } as unknown as SDKMessage;
    const figure = {
      input_tokens: 2_208,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 7_424,
      output_tokens: 5,
    };
    const { sdk } = scriptedSdk({
      messages: [
        init("glm-5.3-flash"),
        stream({
          type: "message_start",
          message: { id: "msg_1", model: "glm-5.3-flash", usage: zero },
        }),
        zeroAssistant,
        stream({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: figure,
        }),
        success,
      ],
      contextModel: "glm-5.3-flash",
      apiUsage: figure,
      stayOpen: true,
    });
    const usage = await withHarness({ ...ZAI, sdk }, (harness) =>
      Effect.gen(function* () {
        const { sessionId, ref } = yield* turn(harness, "sonnet", true);
        const read = yield* harness.contextUsage(sessionId, {
          model: "sonnet",
          breakdown: false,
        });
        yield* harness.endSession(ref);
        return read;
      }),
    );
    expect(usage.reading).toBe("measured");
    expect(usage.used).toBe(2_208 + 7_424 + 5);
    expect(usage.usedModel).toBe("sonnet");
  });

  test("a live session's context read names its catalogue model, not the provider's", async () => {
    const { sdk } = scriptedSdk({
      messages: [init("glm-5.3-flash"), assistant("glm-5.3-flash"), success],
      contextModel: "glm-5.3-flash",
      stayOpen: true,
    });
    const usage = await withHarness({ ...ZAI, sdk }, (harness) =>
      Effect.gen(function* () {
        const { sessionId, ref } = yield* turn(harness, "sonnet", true);
        const read = yield* harness.contextUsage(sessionId, {
          model: "sonnet",
          breakdown: false,
        });
        yield* harness.endSession(ref);
        return read;
      }),
    );
    expect(usage.model).toBe("sonnet");
    expect(usage.window).toBe(200_000);
  });
});

describe("a history read the caller gives up on", () => {
  // The worker reader kills its child on this signal (`claudeHistory.ts`); this checks that
  // the client hands each read the signal of the Effect that asked for it.
  const hanging = () => {
    const signals: AbortSignal[] = [];
    const { sdk: base } = scriptedSdk();
    const remember = (signal: AbortSignal | undefined) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise<never>(() => {});
    };
    const sdk: ClaudeCodeSdk = {
      ...base,
      sessionInfo: (_id, { signal }) => remember(signal),
      sessionMessages: (_id, { signal }) => remember(signal),
    };
    return { sdk, signals };
  };

  test("a title read past its budget aborts the read", async () => {
    const { sdk, signals } = hanging();
    await withHarness({ ...ZAI, sdk }, (harness) =>
      harness
        .sessionTitle(newClaudeCodeSessionId())
        .pipe(Effect.timeout("50 millis"), Effect.ignore),
    );
    expect(signals.length).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  test("a transcript read past its budget aborts the read", async () => {
    const { sdk, signals } = hanging();
    await withHarness({ ...ZAI, sdk }, (harness) =>
      harness
        .messages(newClaudeCodeSessionId())
        .pipe(Effect.timeout("50 millis"), Effect.ignore),
    );
    expect(signals.length).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("modelOfApiUsage", () => {
  const calls = [
    { id: "msg_a", promptTokens: 1_000, model: "glm-5.3" },
    { id: "msg_b", promptTokens: 2_000, model: "glm-5.3-flash" },
  ];
  const usage = (input: number) => ({ input_tokens: input, output_tokens: 3 });

  test("a figure equal to a call's prompt side is that call's", () => {
    expect(modelOfApiUsage(calls, usage(1_000))).toBe("glm-5.3");
  });

  test("a figure matching no call is nobody's", () => {
    // A call this stream did not see: a sub-agent's, or one from before a resume.
    expect(modelOfApiUsage(calls, usage(2_042))).toBeNull();
  });

  test("a call whose figure is still 0 matches nothing", () => {
    const pending = [{ id: "msg_c", promptTokens: 0, model: "glm-5.3" }];
    expect(modelOfApiUsage(pending, usage(0))).toBeNull();
  });

  test("two calls of different models with the figure's prompt side leave it unlabelled", () => {
    const tied = [
      { id: "msg_a", promptTokens: 1_000, model: "glm-5.3" },
      { id: "msg_b", promptTokens: 1_000, model: "glm-5.3-flash" },
    ];
    expect(modelOfApiUsage(tied, usage(1_000))).toBeNull();
  });
});
