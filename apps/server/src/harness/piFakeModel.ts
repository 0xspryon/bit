/**
 * A scripted model for driving a real `pi --mode rpc` in tests: an OpenAI-compatible chat
 * completions endpoint whose every answer is decided by the conversation, not by a model.
 *
 * Grown from `spike/piMcpIsolationProof.ts`'s fake. **What the "model" does is written in the
 * user's message**: `SCRIPT:[…]` on one line, a JSON list of steps. The newest user message
 * that carries a script is the one followed; the step taken is the number of assistant
 * messages since it, so a tool call's result brings the next step. A message without a
 * script — a steer that only says something, say — keeps the previous script going.
 *
 * Steps:
 *
 * - `{ "text": "…", "chunks"?: n, "delayMs"?: ms }` — a reply, streamed in `chunks` pieces
 *   with `delayMs` between them (so a test can Stop mid-reply).
 * - `{ "thinking": "…", "text": "…" }` — a thinking block, then the reply.
 * - `{ "tool": "bash", "args": { … } }` — one tool call.
 * - `{ "status": 429, "error": "…" }` — the provider refuses this call.
 * - `{ "hang": true }` — never answers: the call stays in flight until the client goes away.
 *
 * Usage is reported on every answer: `prompt_tokens` grows with the conversation (100 per
 * message), so a context reading can be told from a stale one.
 *
 * Test support only. Nothing in the server imports it.
 */

export type FakeStep =
  | {
      readonly text: string;
      readonly thinking?: string;
      readonly chunks?: number;
      readonly delayMs?: number;
    }
  | { readonly tool: string; readonly args: unknown }
  | { readonly status: number; readonly error: string }
  | { readonly hang: true };

export interface FakeModelRequest {
  /** The model id asked for. */
  readonly model: string;
  /** The tool names offered to the model on this call. */
  readonly tools: readonly string[];
  /** Every message's role and text, as sent. */
  readonly messages: readonly {
    readonly role: string;
    readonly text: string;
  }[];
}

export interface FakeModel {
  readonly url: string;
  readonly requests: FakeModelRequest[];
  readonly stop: () => Promise<void>;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: { text?: unknown }) =>
            typeof part?.text === "string" ? part.text : "",
          )
          .join("")
      : "";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts the fake on a free port of 127.0.0.1. */
export const startFakeModel = (): FakeModel => {
  const requests: FakeModelRequest[] = [];
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      if (request.method === "GET")
        return Response.json({
          object: "list",
          data: [{ id: "fake-1", object: "model" }],
        });
      const body = (await request.json()) as {
        model?: string;
        messages?: { role: string; content: unknown }[];
        tools?: { function?: { name?: string } }[];
      };
      const messages = body.messages ?? [];
      requests.push({
        model: body.model ?? "",
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? "?"),
        messages: messages.map((message) => ({
          role: message.role,
          text: textOf(message.content),
        })),
      });
      let start = -1;
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (
          message?.role === "user" &&
          textOf(message.content).includes("SCRIPT:")
        ) {
          start = index;
          break;
        }
      }
      let step: FakeStep = { text: "ok" };
      if (start >= 0) {
        const raw =
          textOf(messages[start]?.content)
            .split("SCRIPT:")[1]
            ?.split("\n")[0] ?? "[]";
        const script = JSON.parse(raw) as FakeStep[];
        const taken = messages
          .slice(start + 1)
          .filter((message) => message.role === "assistant").length;
        step = script[taken] ?? { text: "done" };
      }
      if ("status" in step) {
        return Response.json(
          { error: { message: step.error, type: "fake", code: step.status } },
          { status: step.status },
        );
      }
      if ("hang" in step) {
        return new Response(
          new ReadableStream({
            start() {
              // Never enqueues and never closes.
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      calls += 1;
      const id = `chatcmpl-${String(calls)}`;
      const base = {
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: body.model ?? "fake",
      };
      const usage = {
        prompt_tokens: 100 * messages.length,
        completion_tokens: 10,
        total_tokens: 100 * messages.length + 10,
      };
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const encoder = new TextEncoder();
      const answer = step;
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (value: unknown) => {
              try {
                controller.enqueue(encoder.encode(frame(value)));
                return true;
              } catch {
                return false;
              }
            };
            if ("tool" in answer) {
              send({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${String(calls)}`,
                          type: "function",
                          function: {
                            name: answer.tool,
                            arguments: JSON.stringify(answer.args),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else {
              if (answer.thinking !== undefined) {
                send({
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        reasoning_content: answer.thinking,
                      },
                      finish_reason: null,
                    },
                  ],
                });
              }
              const chunks = Math.max(1, answer.chunks ?? 1);
              const size = Math.ceil(answer.text.length / chunks);
              for (let at = 0; at < answer.text.length; at += size) {
                if (at > 0 && answer.delayMs !== undefined)
                  await sleep(answer.delayMs);
                const ok = send({
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: "assistant",
                        content: answer.text.slice(at, at + size),
                      },
                      finish_reason: null,
                    },
                  ],
                });
                if (!ok) return;
              }
            }
            send({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "tool" in answer ? "tool_calls" : "stop",
                },
              ],
            });
            send({ ...base, choices: [], usage });
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {
              // The client went away.
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    requests,
    stop: () => server.stop(true),
  };
};

/**
 * A `models.json` for a temporary `PI_CODING_AGENT_DIR` pointing provider `fake` at a fake
 * model: models `fake-1` (window 200 000) and `fake-2` (window 100 000).
 */
export const fakeModelsJson = (url: string): string =>
  JSON.stringify(
    {
      providers: {
        fake: {
          baseUrl: `${url}/v1`,
          api: "openai-completions",
          apiKey: "fake",
          models: [
            { id: "fake-1", name: "Fake One", contextWindow: 200_000 },
            { id: "fake-2", name: "Fake Two", contextWindow: 100_000 },
          ].map((model) => ({
            ...model,
            maxTokens: 8_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      },
    },
    null,
    1,
  );
