/**
 * The Pi extension that offers one bit MCP endpoint's tools to one Pi session as native Pi
 * tools (`bit_<tool>`). Loaded by `piClient.ts` with `pi -e <this file>`, once per Pi process,
 * and each bit session is one Pi process.
 *
 * Promoted from `spike/piBitTools.extension.ts` (spike E, 2026-11-10), with one change: the
 * credential travels on a pipe, not in the environment.
 *
 * **Pi compiles this with jiti and it imports nothing of Pi's or bit's** — not from Pi,
 * whose package names have moved before, and not from bit, whose server modules must never
 * load inside an agent process. Only Node built-ins.
 *
 * **Why not Pi's built-in MCP.** bit's endpoints serve MCP revision 2026-07-28 only: no
 * `initialize`, every request carries its own metadata (`mcp/server.ts`). Pi's MCP client
 * speaks 2025-11-25 down to 2024-11-05 and always opens with `initialize`, which bit answers
 * 400. This speaks the stateless revision itself: one `tools/list` at load, one `tools/call`
 * per call, each a single POST.
 *
 * ## Where the credential lives
 *
 * bit writes the bearer to the Pi process's **file descriptor 3**, a pipe it closes at once,
 * and names the descriptor in `BIT_MCP_TOKEN_FD`. This reads it to the end, closes the
 * descriptor, and keeps the token in this process's memory only (a global symbol, so a Pi
 * `reload` of the extension finds it again).
 *
 * Not an environment variable, which is what the spike used. Deleting it from
 * `process.env` kept it out of the shells Pi starts, but **not out of
 * `/proc/<pi pid>/environ`**, which is the environment the process was started with and
 * which any process of the same user can read — another bit session's agent included. A
 * pipe leaves nothing to read once it is drained: not in `/proc`, not on disk.
 *
 * `BIT_MCP_URL` names the endpoint and is not a secret. Without both, no tools are offered.
 *
 * ## bit's question tool (harness-instances slice 3)
 *
 * Pi has no question tool, so a model that needs the operator asks in its reply and ends its
 * turn, and bit cannot dock the question or raise Needs you. With `BIT_QUESTION_KEY` set,
 * this also offers `ask_user_question` (Claude Code's `AskUserQuestion` input), which asks
 * through Pi's own extension-UI channel and returns the operator's answer as its result.
 *
 * **How bit tells its question from any other dialog.** In RPC mode a dialog is an
 * `extension_ui_request` on Pi's stdout, which `piClient.ts` reads. The question is one
 * `input` dialog whose `title` is `bit-question:<key>` — the key a random string bit gave
 * this process alone — and whose `placeholder` is the question set as JSON. The driver docks
 * a dialog only when its title is exactly that, and cancels every other dialog, as it did
 * before. Not `editor`, though it is meant for longer text: Pi's RPC `editor` takes no
 * abort signal (1.5.2, `rpc-mode.js`), so a Stop would leave the tool waiting; `input` is
 * resolved by the tool call's signal. Not `select`/`confirm` per question either: one
 * dialog carries the whole set, which the dock shows as one set.
 *
 * The answer comes back as the dialog's `value`: JSON `{ outcome, text }`, where `text` is
 * what the model reads, written by bit (`questions.ts`), so its words are tested beside the
 * dock's. A dismissal is thrown, so Pi stores it as the call's error, which is how the
 * replay tells a dismissed question from one that was never answered.
 */
import { closeSync, readFileSync } from "node:fs";

interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

interface ToolContent {
  readonly type: string;
  readonly text?: string;
}

interface CallResult {
  readonly content?: readonly ToolContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** The part of a tool call's context this uses (`docs/extensions.md`, `ctx.ui`). */
interface PiToolContext {
  readonly ui: {
    input(
      title: string,
      placeholder?: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<string | undefined>;
  };
}

/** The part of Pi's extension API this uses (`docs/extensions.md`, `pi.registerTool`). */
interface PiExtensionApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: PiToolContext,
    ) => Promise<{ content: readonly ToolContent[]; details: unknown }>;
  }): void;
}

const PROTOCOL = "2026-07-28";

/** The name prefix of every tool this offers: `bit_<tool>`. */
const PREFIX = "bit";

const parseBody = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // An event-stream answer: the last `data:` line carrying a JSON-RPC response.
  let found: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.startsWith("{")) found = JSON.parse(payload);
  }
  if (found === undefined)
    throw new Error("bit MCP: no JSON-RPC response in the answer");
  return found;
};

const rpc = async (
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const name = typeof params.name === "string" ? params.name : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-method": method,
      "mcp-protocol-version": PROTOCOL,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "bit-pi-extension",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `bit MCP ${method}: HTTP ${String(response.status)} ${text.slice(0, 200)}`,
    );
  const body = parseBody(text) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (body.error !== undefined)
    throw new Error(`bit MCP ${method}: ${body.error.message ?? "error"}`);
  return body.result ?? {};
};

/** Drains the credential's descriptor and closes it; `undefined` when none was given. */
const readToken = (): string | undefined => {
  const named = process.env.BIT_MCP_TOKEN_FD;
  delete process.env.BIT_MCP_TOKEN_FD;
  if (named === undefined || !/^\d+$/.test(named)) return undefined;
  const fd = Number(named);
  try {
    const token = readFileSync(fd, "utf8").trim();
    return token === "" ? undefined : token;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
};

/**
 * Where the endpoint and its bearer stay after the first load, in this process's memory
 * only: a Pi `reload` runs this factory again, and by then fd 3 is closed and the variables
 * are gone. Never the environment, which the agent's shells inherit.
 */
const KEPT = Symbol.for("bit.piBitTools.endpoint");
type Kept = { readonly url: string; readonly token: string };
const holder = globalThis as { [KEPT]?: Kept };

/** The question tool's name: `questions.ts`'s `PI_QUESTION_TOOL`, which this cannot import. */
const QUESTION_TOOL = "ask_user_question";

/** The dialog title's prefix; the key follows it. `piClient.ts`'s `PI_QUESTION_DIALOG`. */
const QUESTION_DIALOG = "bit-question:";

/**
 * How long a question waits before Pi resolves its dialog empty: a day, as Claude Code's
 * question hook does (`claudeCodeClient.ts`, `QUESTION_HOOK_TIMEOUT_SECONDS`).
 */
const QUESTION_TIMEOUT_MS = 86_400_000;

const QUESTION_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description:
        "The questions to ask, 1 to 4, shown to the operator together.",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The full question, ending with a question mark: clear on its own.",
          },
          header: {
            type: "string",
            description:
              "A short label for the question, at most 12 characters.",
          },
          options: {
            type: "array",
            maxItems: 4,
            description:
              "Two to four choices, when there are clear ones; leave out for an open question. The operator can always answer in their own words instead.",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "The choice, in 1 to 5 words.",
                },
                description: {
                  type: "string",
                  description: "What choosing it means.",
                },
              },
              required: ["label"],
            },
          },
          multiSelect: {
            type: "boolean",
            description: "true when the operator may choose several options.",
          },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
};

/** The dialog's answer: what the driver writes as the `input` dialog's value. */
interface QuestionReply {
  readonly outcome: "answered" | "dismissed";
  readonly text: string;
  readonly answers?: unknown;
}

const replyOf = (value: string): QuestionReply | undefined => {
  try {
    const reply = JSON.parse(value) as Partial<QuestionReply> | null;
    return reply !== null &&
      (reply.outcome === "answered" || reply.outcome === "dismissed") &&
      typeof reply.text === "string"
      ? (reply as QuestionReply)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Kept beside the endpoint, for a Pi `reload`: the variable is gone by then. */
const QUESTION_KEPT = Symbol.for("bit.piBitTools.questionKey");
const questionHolder = globalThis as { [QUESTION_KEPT]?: string };

/** Offers `ask_user_question`, asked through the dialog only bit's driver answers. */
const registerQuestionTool = (pi: PiExtensionApi, key: string): void => {
  pi.registerTool({
    name: QUESTION_TOOL,
    label: "Ask the operator",
    description:
      "Ask the operator — the person running this session in bit — one to four questions, and wait for their answers. Use it when you need a decision or information only they have and cannot go on well without it; do not ask what you can find out yourself. Give options when there are clear choices; they can always answer in their own words, or decline and reply in the chat instead.",
    promptSnippet: "Ask the operator questions and wait for their answers",
    promptGuidelines: [
      "When you need the operator's decision or information to continue, call ask_user_question rather than ending your reply with a question.",
    ],
    parameters: QUESTION_PARAMETERS,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      const questions = (params as { questions?: unknown } | null)?.questions;
      if (!Array.isArray(questions) || questions.length === 0)
        throw new Error(
          `${QUESTION_TOOL} needs at least one question, as { "questions": [{ "question": "…" }] }.`,
        );
      const value = await ctx.ui.input(
        `${QUESTION_DIALOG}${key}`,
        JSON.stringify({ callId: toolCallId, questions }),
        {
          timeout: QUESTION_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (signal?.aborted === true)
        throw new Error(
          "The questions were withdrawn before the operator answered: the turn was stopped, or the session ended.",
        );
      const reply = value === undefined ? undefined : replyOf(value);
      if (reply === undefined)
        throw new Error(
          "No answer came: the questions could not be put to the operator, or went unanswered for a day. Ask in your reply instead.",
        );
      if (reply.outcome === "dismissed") throw new Error(reply.text);
      return {
        content: [{ type: "text", text: reply.text }],
        details: { answers: reply.answers ?? {} },
      };
    },
  });
};

export default async function bitTools(pi: PiExtensionApi): Promise<void> {
  const givenKey = process.env.BIT_QUESTION_KEY;
  delete process.env.BIT_QUESTION_KEY;
  if (givenKey !== undefined && givenKey !== "")
    questionHolder[QUESTION_KEPT] = givenKey;
  const questionKey = questionHolder[QUESTION_KEPT];
  if (questionKey !== undefined) registerQuestionTool(pi, questionKey);

  const token = readToken();
  const named = process.env.BIT_MCP_URL;
  delete process.env.BIT_MCP_URL;
  if (named !== undefined && token !== undefined)
    holder[KEPT] = { url: named, token };
  const kept = holder[KEPT];
  // No endpoint: this session was given no bit tools, and runs without them.
  if (named === undefined && kept === undefined) return;
  // An endpoint without its bearer is a session bit meant to have tools for: refuse to run
  // without them, loudly, as an unreachable endpoint already does (slice 2 review, L2).
  if (kept === undefined)
    throw new Error(
      "bit's tools: BIT_MCP_URL is set but no credential arrived on the descriptor named by BIT_MCP_TOKEN_FD",
    );
  const { url } = kept;
  const bearer = kept.token;

  const listed = await rpc(url, bearer, "tools/list", {});
  const tools = (listed.tools ?? []) as readonly McpTool[];
  for (const tool of tools) {
    pi.registerTool({
      name: `${PREFIX}_${tool.name}`,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      execute: async (_toolCallId, params, signal) => {
        const result = (await rpc(
          url,
          bearer,
          "tools/call",
          { name: tool.name, arguments: params ?? {} },
          signal,
        )) as CallResult;
        const content = result.content ?? [
          {
            type: "text",
            text: JSON.stringify(result.structuredContent ?? {}),
          },
        ];
        if (result.isError === true) {
          throw new Error(content.map((part) => part.text ?? "").join("\n"));
        }
        return { content, details: result.structuredContent ?? {} };
      },
    });
  }
}
