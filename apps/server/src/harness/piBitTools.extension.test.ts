/**
 * The extension's load-time rules that need no Pi process: what it does with and without
 * an endpoint and a credential. The rest — tools reaching bit, the bearer kept out of the
 * agent's shells — runs against a real `pi --mode rpc` in `piClient.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import bitTools from "./piBitTools.extension";

const KEPT = Symbol.for("bit.piBitTools.endpoint");
const QUESTION_KEPT = Symbol.for("bit.piBitTools.questionKey");

interface Tool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: { type: string; text?: string }[];
    details: unknown;
  }>;
}

const registered: string[] = [];
const tools: Tool[] = [];
const pi = {
  registerTool: (definition: Tool) => {
    registered.push(definition.name);
    tools.push(definition);
  },
};

afterEach(() => {
  registered.length = 0;
  tools.length = 0;
  delete process.env.BIT_MCP_URL;
  delete process.env.BIT_MCP_TOKEN_FD;
  delete process.env.BIT_QUESTION_KEY;
  delete (globalThis as { [KEPT]?: unknown })[KEPT];
  delete (globalThis as { [QUESTION_KEPT]?: unknown })[QUESTION_KEPT];
});

/** A tool context whose `input` dialog answers with `answer`, recording what it was asked. */
const dialog = (
  answer: (signal: AbortSignal | undefined) => Promise<string | undefined>,
) => {
  const asked: { title: string; placeholder: string | undefined }[] = [];
  const ctx = {
    ui: {
      input: (
        title: string,
        placeholder?: string,
        options?: { signal?: AbortSignal },
      ) => {
        asked.push({ title, placeholder });
        return answer(options?.signal);
      },
    },
  };
  return { asked, ctx };
};

const QUESTIONS = { questions: [{ question: "Which colour?" }] };

const askTool = async (): Promise<Tool> => {
  process.env.BIT_QUESTION_KEY = "k-123";
  await bitTools(pi as never);
  const tool = tools.find((each) => each.name === "ask_user_question");
  if (tool === undefined) throw new Error("no question tool");
  return tool;
};

describe("bit's question tool", () => {
  test("offered only with a key, which leaves the environment", async () => {
    await bitTools(pi as never);
    expect(registered).toEqual([]);
    await askTool();
    expect(registered).toEqual(["ask_user_question"]);
    expect(process.env.BIT_QUESTION_KEY).toBeUndefined();
  });

  test("asks one input dialog titled with the key, the set and its call as JSON, and returns bit's words", async () => {
    const tool = await askTool();
    const { asked, ctx } = dialog(() =>
      Promise.resolve(
        JSON.stringify({
          outcome: "answered",
          text: "The operator answered: Red",
          answers: { "Which colour?": ["Red"] },
        }),
      ),
    );
    const result = await tool.execute(
      "call_9",
      QUESTIONS,
      undefined,
      undefined,
      ctx,
    );
    expect(asked.map((each) => each.title)).toEqual(["bit-question:k-123"]);
    expect(JSON.parse(asked[0]?.placeholder ?? "")).toEqual({
      callId: "call_9",
      ...QUESTIONS,
    });
    expect(result.content).toEqual([
      { type: "text", text: "The operator answered: Red" },
    ]);
    expect(result.details).toEqual({ answers: { "Which colour?": ["Red"] } });
  });

  test("a dismissal, a Stop, an empty dialog and an unreadable answer are each the call's error", async () => {
    const tool = await askTool();
    const failure = (
      answer: (signal: AbortSignal | undefined) => Promise<string | undefined>,
      signal?: AbortSignal,
    ) =>
      tool
        .execute("call_9", QUESTIONS, signal, undefined, dialog(answer).ctx)
        .then(
          () => "returned",
          (error: unknown) => String(error),
        );
    expect(
      await failure(() =>
        Promise.resolve(
          JSON.stringify({ outcome: "dismissed", text: "declined" }),
        ),
      ),
    ).toBe("Error: declined");
    const stop = new AbortController();
    expect(
      await failure((signal) => {
        stop.abort();
        return signal?.aborted === true
          ? Promise.resolve(undefined)
          : Promise.resolve("{}");
      }, stop.signal),
    ).toContain("withdrawn");
    expect(await failure(() => Promise.resolve(undefined))).toContain(
      "No answer came",
    );
    expect(await failure(() => Promise.resolve("not json"))).toContain(
      "No answer came",
    );
    // No questions: nothing is asked.
    const { asked, ctx } = dialog(() => Promise.resolve(undefined));
    const empty = await tool
      .execute("call_9", { questions: [] }, undefined, undefined, ctx)
      .then(
        () => "returned",
        (error: unknown) => String(error),
      );
    expect(empty).toContain("needs at least one question");
    expect(asked).toEqual([]);
  });
});

describe("piBitTools at load", () => {
  test("no endpoint: a session given no bit tools runs without them", async () => {
    await bitTools(pi as never);
    expect(registered).toEqual([]);
  });

  test("an endpoint without a credential refuses to load, loudly (slice 2 review, L2)", async () => {
    process.env.BIT_MCP_URL = "http://127.0.0.1:9/api/v1/importer/mcp";
    const thrown = await bitTools(pi as never).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("no credential");
    expect(registered).toEqual([]);
  });

  test("the endpoint is taken out of the environment either way", async () => {
    process.env.BIT_MCP_URL = "http://127.0.0.1:9/api/v1/importer/mcp";
    await bitTools(pi as never).catch(() => undefined);
    expect(process.env.BIT_MCP_URL).toBeUndefined();
  });
});
