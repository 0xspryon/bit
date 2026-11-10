/**
 * The Pi driver against a real `pi --mode rpc` (Pi 1.5.2 measured), with only the model
 * scripted (`piFakeModel.ts`): a temporary `PI_CODING_AGENT_DIR` holds a `models.json`
 * pointing provider `fake` at it, so no credential of the operator's is read.
 *
 * Skipped when `pi` is not on `PATH`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Exit, Layer, Redacted, Scope, Stream } from "effect";

import {
  AgentHarness,
  type HarnessNarration,
  type NarrationDetail,
} from "./agentHarness";
import { InstanceId } from "./identity";
import { fakeModelsJson, startFakeModel, type FakeModel } from "./piFakeModel";
import { piHarness, type PiHarnessOptions } from "./piClient";

const hasPi = spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

let model: FakeModel;
let root: string;
let agentDir: string;

beforeAll(() => {
  model = startFakeModel();
  root = mkdtempSync(join(tmpdir(), "bit-pi-client-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), fakeModelsJson(model.url));
});

afterAll(async () => {
  await model.stop();
  rmSync(root, { recursive: true, force: true });
});

const S = (steps: readonly unknown[]): string =>
  `SCRIPT:${JSON.stringify(steps)}`;

interface Fixture {
  readonly harness: AgentHarness["Service"];
  readonly scope: Scope.Closeable;
  readonly sessionDir: string;
  readonly records: string;
  readonly work: string;
}

let counter = 0;

/** A harness layer of its own, on fresh folders; the scope is the test's to close. */
const fixture = async (
  overrides: Partial<PiHarnessOptions> = {},
  folders?: { sessionDir: string; records: string; work: string },
): Promise<Fixture> => {
  counter += 1;
  const base = join(root, `f${String(counter)}`);
  const sessionDir = folders?.sessionDir ?? join(base, "sessions");
  const records = folders?.records ?? join(base, "records");
  const work = folders?.work ?? join(base, "work");
  mkdirSync(work, { recursive: true });
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      piHarness({
        instanceId: InstanceId.make("pi-test"),
        displayName: "Pi test",
        agentDir,
        sessionDir,
        recordDirectory: records,
        stopBounds: { terminateGrace: 1_000, killGrace: 1_000, poll: 25 },
        ...overrides,
      }),
      scope,
    ),
  );
  return {
    harness: Context.get(context, AgentHarness),
    scope,
    sessionDir,
    records,
    work,
  };
};

const close = (fixtureValue: Fixture) =>
  Effect.runPromise(Scope.close(fixtureValue.scope, Exit.void));

/** Collects one session's narration in the background. */
const listen = (
  harness: AgentHarness["Service"],
  sessionId: string,
  scope: Scope.Closeable,
) => {
  const seen: HarnessNarration[] = [];
  void Effect.runPromise(
    Effect.forkIn(
      Stream.runForEach(harness.sessionEvents(sessionId), (entry) =>
        Effect.sync(() => {
          seen.push(entry);
        }),
      ),
      scope,
    ),
  );
  return seen;
};

const until = async (
  check: () => boolean,
  what: string,
  ms = 20_000,
): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const details = <T extends NarrationDetail["_tag"]>(
  seen: readonly HarnessNarration[],
  tag: T,
) =>
  seen
    .map((entry) => entry.detail)
    .filter(
      (detail): detail is Extract<NarrationDetail, { _tag: T }> =>
        detail._tag === tag,
    );

const outcomes = (seen: readonly HarnessNarration[]) =>
  seen.flatMap((entry) => (entry.outcome === undefined ? [] : [entry.outcome]));

/** The pid of the one Pi process a fixture recorded. */
const recordedPid = (records: string): number => {
  const [name] = readdirSync(records).filter((file) => file.endsWith(".json"));
  if (name === undefined) throw new Error("no Pi process was recorded");
  return Number(name.replace(/\.json$/, ""));
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const open = (
  harness: AgentHarness["Service"],
  work: string,
  text: string,
  modelId = "fake/fake-1",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ref = yield* harness.createSession({
        title: "bit test session",
        model: modelId,
        directory: work,
        sessionId: harness.newSessionId(),
        multiTurn: true,
      });
      return ref;
    }),
  );

/**
 * Without `pi` on PATH these tests cannot run, and a suite that skipped them would pass
 * having checked nothing about the driver (slice 2 review, L7). So a missing `pi` fails
 * here, saying why, unless `BIT_SKIP_PI_TESTS=1` says the skip is meant.
 */
const skipPi = !hasPi && process.env.BIT_SKIP_PI_TESTS === "1";

test.skipIf(hasPi || skipPi)("pi is on PATH for the driver tests", () => {
  throw new Error(
    "`pi` is not on PATH, so piHarness's tests cannot run; install pi-coding-agent, or set BIT_SKIP_PI_TESTS=1 to skip them on purpose",
  );
});

describe.skipIf(!hasPi)("piHarness against a real pi --mode rpc", () => {
  test("the catalogue is Pi's own list, labelled by its names, with windows", async () => {
    const f = await fixture();
    try {
      expect(String(f.harness.instance.driver)).toBe("pi");
      expect(f.harness.instance.models.map((entry) => entry.id)).toEqual([
        "fake/fake-1",
        "fake/fake-2",
      ]);
      expect(f.harness.instance.models[0]?.label).toBe("Fake One");
      expect(f.harness.instance.models[1]?.contextLimit).toBe(100_000);
      expect(f.harness.instance.models[1]?.compactionAt).toBe(100_000 - 16_384);
      expect(f.harness.modelProvenance("zai/glm-5.3-flash")).toEqual({
        providerId: "zai",
        modelId: "glm-5.3-flash",
      });
    } finally {
      await close(f);
    }
  });

  test("a configured catalogue keeps its order and labels", async () => {
    const f = await fixture({
      models: [{ id: "fake/fake-2", label: "Second" }, { id: "fake/fake-1" }],
    });
    try {
      expect(
        f.harness.instance.models.map((entry) => [entry.id, entry.label]),
      ).toEqual([
        ["fake/fake-2", "Second"],
        ["fake/fake-1", "Fake One"],
      ]);
      expect(f.harness.instance.defaultModel).toBe("fake/fake-2");
    } finally {
      await close(f);
    }
  });

  test("a turn is narrated — streamed reply, thinking, a tool call and its result — and replays the same from the file", async () => {
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      const seen = listen(f.harness, ref.id, f.scope);
      await Effect.runPromise(
        f.harness.prompt(
          ref.id,
          `hello ${S([
            { tool: "bash", args: { command: "echo from-bash" } },
            { thinking: "considering", text: "all done here", chunks: 3 },
          ])}`,
        ),
      );
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      await until(() => outcomes(seen).length > 0, "the turn's outcome");
      expect(outcomes(seen)).toEqual(["succeeded"]);
      const call = details(seen, "toolCall")[0];
      expect(call?.tool).toBe("bash");
      expect(call?.input).toContain("echo from-bash");
      const result = details(seen, "toolResult")[0];
      expect(result?.callId).toBe(call?.callId ?? "");
      expect(result?.output).toContain("from-bash");
      expect(result?.failed).toBe(false);
      const deltas = details(seen, "delta").filter(
        (delta) => delta.channel === "reply",
      );
      expect(deltas.map((delta) => delta.text).join("")).toBe("all done here");
      const reply = details(seen, "reply")[0];
      expect(reply?.text).toBe("all done here");
      expect(reply?.blockId).toBe(deltas[0]?.blockId ?? "");
      expect(details(seen, "thinking")[0]?.text).toBe("considering");
      const usage = details(seen, "usage");
      expect(usage.length).toBe(2);
      expect(usage[1]?.contextLimit).toBe(200_000);
      expect(usage[1]?.model).toBe("fake/fake-1");

      const status = await Effect.runPromise(f.harness.sessionStatus(ref.id));
      expect(status).toEqual({ activity: "idle", outcome: "succeeded" });

      const replay = await Effect.runPromise(f.harness.messages(ref.id));
      expect(replay.map((entry) => entry.type)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(replay[0]?.text).toContain("hello");
      expect(replay[1]?.parts[0]?._tag).toBe("toolCall");
      expect(replay[2]?.parts[0]?._tag).toBe("toolResult");
      expect(replay[3]?.text).toBe("all done here");
      expect(replay[3]?.model).toBe("fake/fake-1");
      expect(replay[3]?.parts.map((part) => part._tag)).toEqual([
        "thinking",
        "reply",
      ]);

      const context = await Effect.runPromise(
        f.harness.contextUsage(ref.id, {
          model: "fake/fake-1",
          breakdown: false,
        }),
      );
      // The fake reports 100 tokens per message sent and 10 generated: the second call sent
      // four messages (system, user, assistant, tool result).
      expect(context.reading).toBe("measured");
      expect(context.used).toBe(410);
      expect(context.window).toBe(200_000);
      expect(context.usedModel).toBe("fake/fake-1");

      // The session is stored in bit's own folder, named by bit's id and title.
      const [file] = readdirSync(f.sessionDir);
      expect(file?.endsWith(`_${ref.id}.jsonl`)).toBe(true);
      const title = await Effect.runPromise(f.harness.sessionTitle(ref.id));
      expect(title).toEqual({ _tag: "titled", title: "bit test session" });
    } finally {
      await close(f);
    }
  });

  test("bit's tools reach the session through the extension, and its credential reaches no shell", async () => {
    const calls: string[] = [];
    const mcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as {
          method: string;
          params?: { arguments?: unknown };
        };
        calls.push(
          `${body.method} ${request.headers.get("authorization") ?? ""}`,
        );
        if (body.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "echo",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          });
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: `echoed ${JSON.stringify(body.params?.arguments)}`,
              },
            ],
          },
        });
      },
    });
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      await Effect.runPromise(
        f.harness.registerMcpServer(ref.id, "bit-test", {
          url: `http://127.0.0.1:${String(mcp.port)}/`,
          headers: { authorization: Redacted.make("Bearer secret-pi-token") },
          directory: f.work,
        }),
      );
      const seen = listen(f.harness, ref.id, f.scope);
      const probe = [
        "env | grep -c secret-pi-token || true",
        "tr '\\0' '\\n' < /proc/$PPID/environ | grep -c secret-pi-token || true",
      ].join("; ");
      await Effect.runPromise(
        f.harness.prompt(
          ref.id,
          S([
            { tool: "bit_echo", args: { said: "hi" } },
            { tool: "bash", args: { command: probe } },
            { text: "done" },
          ]),
        ),
      );
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      const results = details(seen, "toolResult");
      expect(results[0]?.tool).toBe("bit_echo");
      expect(results[0]?.output).toContain('echoed {"said":"hi"}');
      expect(results[1]?.output.trim().split("\n")).toEqual(["0", "0"]);
      expect(calls).toEqual([
        "tools/list Bearer secret-pi-token",
        "tools/call Bearer secret-pi-token",
      ]);
      expect(model.requests.at(-1)?.tools).toContain("bit_echo");
    } finally {
      await close(f);
      await mcp.stop(true);
    }
  });

  test("a Send now and a queued message mid-turn are each taken, in Pi's order, and named in the replay", async () => {
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      const seen = listen(f.harness, ref.id, f.scope);
      await Effect.runPromise(
        f.harness.prompt(
          ref.id,
          S([
            { tool: "bash", args: { command: "sleep 1.5; echo slept" } },
            { text: "after" },
          ]),
        ),
      );
      await until(() => details(seen, "toolCall").length > 0, "the tool call");
      const queued = await Effect.runPromise(
        f.harness.prompt(ref.id, `QUEUED ${S([{ text: "queued answer" }])}`, {
          _tag: "steer",
          urgency: "queued",
          messageId: "m-queued",
        }),
      );
      const now = await Effect.runPromise(
        f.harness.prompt(ref.id, `NOW ${S([{ text: "now answer" }])}`, {
          _tag: "steer",
          urgency: "preemptive",
          messageId: "m-now",
        }),
      );
      expect(queued.delivered && now.delivered).toBe(true);
      const again = await Effect.runPromise(
        f.harness.prompt(ref.id, "repeat", {
          _tag: "steer",
          urgency: "queued",
          messageId: "m-now",
        }),
      );
      expect(again.delivered).toBe(false);
      const running = await Effect.runPromise(f.harness.sessionStatus(ref.id));
      expect(running.activity).toBe("running");
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      await until(() => outcomes(seen).length > 0, "the run's outcome");
      expect(details(seen, "taken").map((taken) => taken.messageIds)).toEqual([
        ["m-now"],
        ["m-queued"],
      ]);
      expect(details(seen, "reply").map((reply) => reply.text)).toEqual([
        "now answer",
        "queued answer",
      ]);
      // One run, one settle.
      expect(outcomes(seen)).toEqual(["succeeded"]);
      const replay = await Effect.runPromise(f.harness.messages(ref.id));
      const users = replay.filter((entry) => entry.type === "user");
      expect(users.map((entry) => entry.messageIds)).toEqual([
        undefined,
        ["m-now"],
        ["m-queued"],
      ]);
    } finally {
      await close(f);
    }
  });

  test("a message into an idle session starts a turn, and waitForIdle waits for it", async () => {
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      const seen = listen(f.harness, ref.id, f.scope);
      await Effect.runPromise(f.harness.prompt(ref.id, S([{ text: "first" }])));
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      await Effect.runPromise(
        f.harness.prompt(
          ref.id,
          S([{ text: "second", chunks: 4, delayMs: 100 }]),
          {
            _tag: "steer",
            urgency: "preemptive",
            messageId: "m-2",
          },
        ),
      );
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      await until(() => outcomes(seen).length === 2, "both turns' outcomes");
      expect(details(seen, "reply").map((reply) => reply.text)).toEqual([
        "first",
        "second",
      ]);
      expect(outcomes(seen)).toEqual(["succeeded", "succeeded"]);
    } finally {
      await close(f);
    }
  });

  test("Stop mid-turn ends the turn interrupted, holds a queued message, and runs it ahead of the next one", async () => {
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      const seen = listen(f.harness, ref.id, f.scope);
      await Effect.runPromise(
        f.harness.prompt(
          ref.id,
          S([
            { tool: "bash", args: { command: "sleep 30; echo slept" } },
            { text: "after" },
          ]),
        ),
      );
      await until(() => details(seen, "toolCall").length > 0, "the tool call");
      await Effect.runPromise(
        f.harness.prompt(ref.id, `HELD ${S([{ text: "held answer" }])}`, {
          _tag: "steer",
          urgency: "queued",
          messageId: "m-held",
        }),
      );
      const started = Date.now();
      const stopped = await Effect.runPromise(
        f.harness.interruptSession(ref.id),
      );
      expect(stopped).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      await until(
        () => outcomes(seen).length > 0,
        "the stopped turn's outcome",
      );
      expect(outcomes(seen)).toEqual(["interrupted"]);
      expect(details(seen, "marker").map((marker) => marker.marker)).toEqual([
        "interrupted",
      ]);
      expect(details(seen, "toolResult")[0]?.failed).toBe(true);
      expect(await Effect.runPromise(f.harness.sessionStatus(ref.id))).toEqual({
        activity: "idle",
        outcome: "interrupted",
      });
      expect(f.harness.queuedOnInterrupt).toBe("held");
      expect(await Effect.runPromise(f.harness.holding(ref.id))).toBe(true);
      // Nothing runs until the next message.
      await Bun.sleep(500);
      expect(details(seen, "taken")).toEqual([]);

      await Effect.runPromise(
        f.harness.prompt(ref.id, `NEXT ${S([{ text: "next answer" }])}`, {
          _tag: "steer",
          urgency: "queued",
          messageId: "m-next",
        }),
      );
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      await until(() => outcomes(seen).length === 2, "the second turn");
      expect(details(seen, "taken").map((taken) => taken.messageIds)).toEqual([
        ["m-held"],
        ["m-next"],
      ]);
      expect(details(seen, "reply").map((reply) => reply.text)).toEqual([
        "held answer",
        "next answer",
      ]);
      expect(await Effect.runPromise(f.harness.holding(ref.id))).toBe(false);
      const replay = await Effect.runPromise(f.harness.messages(ref.id));
      expect(
        replay.filter((entry) => entry.marker === "interrupted").length,
      ).toBe(1);
    } finally {
      await close(f);
    }
  });

  test("a Pi process killed mid-turn leaves the turn uncertain and the session closed", async () => {
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      const seen = listen(f.harness, ref.id, f.scope);
      await Effect.runPromise(f.harness.prompt(ref.id, S([{ hang: true }])));
      await until(
        () => readdirSync(f.records).length > 0,
        "the process record",
      );
      const pid = recordedPid(f.records);
      await Bun.sleep(300);
      expect(
        (await Effect.runPromise(f.harness.sessionStatus(ref.id))).activity,
      ).toBe("running");
      process.kill(pid, "SIGKILL");
      const waited = await Effect.runPromise(
        Effect.result(f.harness.waitForIdle(ref.id)),
      );
      expect(waited._tag).toBe("Failure");
      await until(() => details(seen, "error").length > 0, "the exit's error");
      expect(outcomes(seen)).toEqual([]);
      expect(details(seen, "error")[0]?.message).toContain("exited");
      const status = await Effect.runPromise(f.harness.sessionStatus(ref.id));
      expect(status).toEqual({ activity: "idle", outcome: undefined });
      const refused = await Effect.runPromise(
        Effect.result(
          f.harness.prompt(ref.id, "more", {
            _tag: "steer",
            urgency: "queued",
            messageId: "m-late",
          }),
        ),
      );
      expect(refused._tag).toBe("Failure");
      // What was finished is in the file: the message, and no reply.
      const replay = await Effect.runPromise(f.harness.messages(ref.id));
      expect(replay.map((entry) => entry.type)).toEqual(["user"]);
    } finally {
      await close(f);
    }
  });

  test("an ended session leaves no Pi process, and a restarted server replays and resumes it from its file", async () => {
    const first = await fixture();
    const folders = {
      sessionDir: first.sessionDir,
      records: first.records,
      work: first.work,
    };
    const held = { sessionId: "" };
    try {
      const ref = await open(first.harness, first.work, "");
      held.sessionId = ref.id;
      await Effect.runPromise(
        first.harness.prompt(ref.id, `one ${S([{ text: "first reply" }])}`),
      );
      await Effect.runPromise(first.harness.waitForIdle(ref.id));
      const pid = recordedPid(first.records);
      expect(alive(pid)).toBe(true);
      await Effect.runPromise(first.harness.endSession(ref));
      expect(alive(pid)).toBe(false);
      expect(readdirSync(first.records)).toEqual([]);
      // Ending again, or a ref this harness never handed out, is nothing.
      await Effect.runPromise(first.harness.endSession(ref));
      await Effect.runPromise(first.harness.endSession({ id: ref.id }));
    } finally {
      await close(first);
    }

    const sessionId = held.sessionId;
    const second = await fixture({}, folders);
    try {
      const continuation = await Effect.runPromise(
        second.harness.sessionContinuation(sessionId),
      );
      expect(continuation._tag).toBe("resumable");
      expect(
        continuation._tag === "resumable" ? continuation.directory : "",
      ).toBe(folders.work);
      expect(
        await Effect.runPromise(second.harness.sessionStatus(sessionId)),
      ).toEqual({
        activity: "idle",
        outcome: undefined,
      });
      const before = await Effect.runPromise(
        second.harness.messages(sessionId),
      );
      expect(before.map((entry) => entry.text)).toEqual([
        "one " + S([{ text: "first reply" }]),
        "first reply",
      ]);
      const context = await Effect.runPromise(
        second.harness.contextUsage(sessionId, {
          model: "fake/fake-1",
          breakdown: false,
        }),
      );
      expect(context.reading).toBe("measured");

      const resumed = await Effect.runPromise(
        second.harness.createSession({
          title: "bit test session",
          model: "fake/fake-1",
          directory: folders.work,
          resume: sessionId,
          multiTurn: true,
        }),
      );
      expect(resumed.id).toBe(sessionId);
      const seen = listen(second.harness, sessionId, second.scope);
      await Effect.runPromise(
        second.harness.prompt(
          sessionId,
          `two ${S([{ text: "second reply" }])}`,
        ),
      );
      await Effect.runPromise(second.harness.waitForIdle(sessionId));
      expect(details(seen, "reply").map((reply) => reply.text)).toEqual([
        "second reply",
      ]);
      // The model saw the first turn: one conversation, one file, one name.
      expect(
        model.requests
          .at(-1)
          ?.messages.some((message) => message.text.includes("first reply")),
      ).toBe(true);
      const files = readdirSync(folders.sessionDir);
      expect(files.length).toBe(1);
      const text = readFileSync(
        join(folders.sessionDir, files[0] ?? ""),
        "utf8",
      );
      expect(
        text.split("\n").filter((line) => line.includes('"session_info"'))
          .length,
      ).toBe(1);
      const after = await Effect.runPromise(second.harness.messages(sessionId));
      expect(
        after
          .filter((entry) => entry.type === "assistant")
          .map((entry) => entry.text),
      ).toEqual(["first reply", "second reply"]);
    } finally {
      await close(second);
    }
  });

  test("a model switch moves the live session, and the meter's window with it", async () => {
    const f = await fixture();
    try {
      const ref = await open(f.harness, f.work, "");
      await Effect.runPromise(f.harness.prompt(ref.id, S([{ text: "one" }])));
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      await Effect.runPromise(f.harness.switchModel(ref.id, "fake/fake-2"));
      // Idempotent.
      await Effect.runPromise(f.harness.switchModel(ref.id, "fake/fake-2"));
      await Effect.runPromise(
        f.harness.prompt(ref.id, S([{ text: "two" }]), {
          _tag: "steer",
          urgency: "queued",
          messageId: "m-two",
        }),
      );
      await Effect.runPromise(f.harness.waitForIdle(ref.id));
      expect(model.requests.at(-1)?.model).toBe("fake-2");
      const context = await Effect.runPromise(
        f.harness.contextUsage(ref.id, {
          model: "fake/fake-2",
          breakdown: false,
        }),
      );
      expect(context.window).toBe(100_000);
      expect(context.usedModel).toBe("fake/fake-2");
      const replay = await Effect.runPromise(f.harness.messages(ref.id));
      expect(
        replay
          .filter((entry) => entry.type === "assistant")
          .map((entry) => entry.model),
      ).toEqual(["fake/fake-1", "fake/fake-2"]);
    } finally {
      await close(f);
    }
  });

  test("closing the layer stops every Pi process it started", async () => {
    const f = await fixture();
    const ref = await open(f.harness, f.work, "");
    await Effect.runPromise(f.harness.prompt(ref.id, S([{ hang: true }])));
    await until(() => readdirSync(f.records).length > 0, "the process record");
    const pid = recordedPid(f.records);
    expect(alive(pid)).toBe(true);
    await close(f);
    expect(alive(pid)).toBe(false);
  });
});
