/**
 * The instance file: what it accepts, and the one sentence each refusal comes to.
 *
 * Every refusal stops the server at startup, so the claim tested is that the sentence names
 * the file and the field an operator has to fix — not merely that decoding failed.
 */
import { describe, expect, test } from "bun:test";

import {
  decodeInstanceConfig,
  readInstanceConfig,
  type FolderCheck,
  type InstanceConfigResult,
} from "./instanceConfig";

const SOURCE = "/etc/bit/instances.json";
const ZAI = "/cc/zai";
const folders: FolderCheck = (path) =>
  path === ZAI ? "folder" : path === "/cc/file" ? "not_folder" : "missing";

const decode = (value: unknown): InstanceConfigResult =>
  decodeInstanceConfig(JSON.stringify(value), SOURCE, folders);

const refusal = (value: unknown): string => {
  const result = decode(value);
  if (result._tag !== "invalid") throw new Error("expected a refusal");
  return result.sentence;
};

const GOOD = {
  instances: [
    { id: "claude-code", driver: "claude-code" },
    {
      id: "cc-zai",
      driver: "claude-code",
      displayName: "Claude Code · z.ai",
      configDir: ZAI,
      provider: "zai",
      models: [
        { id: "opus", label: "GLM-5.3", reportedAs: "glm-5.3" },
        { id: "sonnet", label: "GLM-5.3 Flash" },
      ],
      defaultModel: "sonnet",
      maxRetries: 1,
    },
    { id: "opencode", driver: "opencode" },
  ],
};

describe("a good file", () => {
  test("is every instance, in order, with defaults filled in", () => {
    const result = decode(GOOD);
    expect(result._tag).toBe("configured");
    if (result._tag !== "configured") return;
    expect(result.instances.map((each) => String(each.id))).toEqual([
      "claude-code",
      "cc-zai",
      "opencode",
    ]);
    const [stock, zai, openCode] = result.instances;
    // The stock id reads as the driver's own name, as it did before the file existed.
    expect(stock?.displayName).toBe("Claude Code");
    expect(openCode?.displayName).toBe("OpenCode");
    expect(zai).toEqual({
      driver: "claude-code",
      id: zai?.id as never,
      displayName: "Claude Code · z.ai",
      configDir: ZAI,
      provider: "zai",
      models: [
        { id: "opus", label: "GLM-5.3", reportedAs: "glm-5.3" },
        { id: "sonnet", label: "GLM-5.3 Flash" },
      ],
      defaultModel: "sonnet",
      maxRetries: 1,
    });
  });

  test("a second Claude Code instance without a name is told apart by its id", () => {
    const result = decode({
      instances: [
        { id: "claude-code", driver: "claude-code" },
        { id: "cc-work", driver: "claude-code", configDir: ZAI },
      ],
    });
    expect(result._tag).toBe("configured");
    if (result._tag !== "configured") return;
    expect(result.instances[1]?.displayName).toBe("Claude Code (cc-work)");
  });

  test("models without a default take the first", () => {
    const result = decode({
      instances: [
        {
          id: "cc",
          driver: "claude-code",
          models: [{ id: "opus" }, { id: "sonnet" }],
        },
      ],
    });
    expect(
      result._tag === "configured" &&
        result.instances[0]?.driver === "claude-code"
        ? result.instances[0].defaultModel
        : undefined,
    ).toBe("opus");
  });
});

describe("no file", () => {
  test("an unset or blank variable is no configuration at all", () => {
    expect(readInstanceConfig(undefined)).toBeUndefined();
    expect(readInstanceConfig("  ")).toBeUndefined();
  });

  test("a file that cannot be read is refused naming it", () => {
    const result = readInstanceConfig("/nowhere/instances.json", () => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(result?._tag).toBe("invalid");
    expect(result?._tag === "invalid" ? result.sentence : "").toContain(
      "HARNESS_INSTANCES names /nowhere/instances.json, which could not be read: ENOENT",
    );
  });

  test("a file that is not JSON says so", () => {
    const result = decodeInstanceConfig("{ instances: [", SOURCE, folders);
    expect(result._tag === "invalid" ? result.sentence : "").toContain(
      "it is not JSON",
    );
  });
});

describe("each bad field is named", () => {
  const withZai = (patch: Record<string, unknown>) => ({
    instances: [{ ...GOOD.instances[1], ...patch }],
  });

  test.each([
    [{ instances: [] }, "instances: lists no instance"],
    [{}, "instances: Missing key"],
    [{ instances: [], extra: 1 }, "extra: Expected no excess property"],
    [withZai({ id: "z ai" }), "instances[0].id"],
    [withZai({ id: "" }), "instances[0].id"],
    [
      withZai({ configdir: ZAI }),
      "instances[0].configdir: Expected no excess property",
    ],
    [
      withZai({ configDir: "cc/zai" }),
      "instances[0].configDir: 'cc/zai' is not an absolute path",
    ],
    [
      withZai({ configDir: "/cc/none" }),
      "instances[0].configDir: '/cc/none' does not exist",
    ],
    [
      withZai({ configDir: "/cc/file" }),
      "instances[0].configDir: '/cc/file' is not a folder",
    ],
    [
      withZai({ maxRetries: -1 }),
      "instances[0].maxRetries: Expected a value greater than or equal to 0",
    ],
    [withZai({ maxRetries: 1.5 }), "instances[0].maxRetries"],
    [withZai({ models: [] }), "instances[0].models"],
    [withZai({ models: [{ id: "" }] }), "instances[0].models[0].id"],
    [
      withZai({ models: [{ id: "opus", lable: "x" }] }),
      "instances[0].models[0].lable: Expected no excess property",
    ],
    [
      withZai({ models: [{ id: "opus" }, { id: "opus" }] }),
      "instances[0].models[1].id: 'opus' is listed twice",
    ],
    [
      withZai({ defaultModel: "haiku" }),
      "instances[0].defaultModel: 'haiku' is not one of the instance's models (opus, sonnet)",
    ],
    [
      withZai({ driver: "pi" }),
      "instances[0].driver: 'pi' is not a driver this build has",
    ],
    [{ instances: [{ id: "x" }] }, "instances[0].driver: missing"],
    [
      { instances: [{ id: "oc", driver: "opencode", configDir: ZAI }] },
      "instances[0].configDir: Expected no excess property",
    ],
  ])("%j", (value, expected) => {
    const sentence = refusal(value);
    expect(sentence.startsWith(`HARNESS_INSTANCES names ${SOURCE}`)).toBe(true);
    expect(sentence).toContain(expected);
  });

  test("duplicate ids", () => {
    expect(
      refusal({
        instances: [
          { id: "cc", driver: "claude-code" },
          { id: "cc", driver: "claude-code", displayName: "Other" },
        ],
      }),
    ).toContain(
      "instances[1].id: 'cc' is already the id of instances[0]; ids must be unique",
    );
  });

  test("duplicate names, case ignored", () => {
    expect(
      refusal({
        instances: [
          { id: "a", driver: "claude-code", displayName: "Claude" },
          { id: "b", driver: "claude-code", displayName: "claude" },
        ],
      }),
    ).toContain(
      "instances[1].displayName: 'claude' is already the name of instances[0]",
    );
  });

  test("a second OpenCode instance", () => {
    expect(
      refusal({
        instances: [
          { id: "oc", driver: "opencode" },
          { id: "oc2", driver: "opencode" },
        ],
      }),
    ).toContain("instances[1].driver: only one opencode instance");
  });
});
