/**
 * The extension's load-time rules that need no Pi process: what it does with and without
 * an endpoint and a credential. The rest — tools reaching bit, the bearer kept out of the
 * agent's shells — runs against a real `pi --mode rpc` in `piClient.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import bitTools from "./piBitTools.extension";

const KEPT = Symbol.for("bit.piBitTools.endpoint");

const registered: string[] = [];
const pi = {
  registerTool: (definition: { name: string }) => {
    registered.push(definition.name);
  },
};

afterEach(() => {
  registered.length = 0;
  delete process.env.BIT_MCP_URL;
  delete process.env.BIT_MCP_TOKEN_FD;
  delete (globalThis as { [KEPT]?: unknown })[KEPT];
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
