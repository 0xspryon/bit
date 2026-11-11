/**
 * What the web calls a model (follow-ups A, 2026-11-11): a configured label, else the
 * provider's own name, else the id — on every surface that words a model. The rule is
 * `@bit/contracts`' `modelDisplayName`; `modelNames.ts` finds the catalogue it applies to;
 * the footer, the switch notice and the meter's source line each take it as a function.
 */
import { describe, expect, test } from "bun:test";

import {
  modelDisplayName,
  modelOptionsSummary,
  type ConversationModelSwitched,
  type HarnessInstanceView,
  type ModelOptionDescriptor,
} from "@bit/contracts";

import { turnFooterText, type ThreadTurn } from "../src/lib/chatShell";
import type { ChatGroup } from "../src/lib/chat";
import { switchedNotice } from "../src/lib/conversationChat";
import { crumbMeter, crumbSource } from "../src/lib/crumbMeter";
import {
  modelNameIn,
  modelWithOptions,
  provenanceModelIn,
} from "../src/lib/modelNames";

/** Pi's descriptor for `zai/glm-5.3-flash`, as the server builds it (`piThinking.ts`). */
const thinking: ModelOptionDescriptor = {
  id: "thinkingLevel",
  label: "Thinking",
  type: "select",
  options: [
    { id: "default", label: "Pi's default", isDefault: true },
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
    { id: "max", label: "Maximum" },
  ],
};

const instance = (
  over: Partial<HarnessInstanceView> & Pick<HarnessInstanceView, "instanceId">,
): HarnessInstanceView => ({
  driver: "claude-code",
  displayName: over.instanceId,
  version: "1",
  ready: true,
  auth: "unknown",
  isDefault: false,
  defaultModel: over.models?.[0]?.id ?? "",
  models: [],
  ...over,
});

const HARNESSES: readonly HarnessInstanceView[] = [
  instance({
    instanceId: "claude-code",
    displayName: "Claude Code",
    isDefault: true,
    models: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }],
  }),
  instance({
    instanceId: "cc-zai",
    displayName: "Claude Code · z.ai",
    models: [
      { id: "sonnet", label: "GLM-5.3 Flash", reportedAs: "glm-5.3-flash" },
      { id: "opus", reportedAs: "glm-5.3" },
      { id: "haiku" },
    ],
  }),
  instance({
    instanceId: "pi-zai",
    driver: "pi",
    displayName: "Pi · z.ai",
    models: [
      {
        id: "zai/glm-5.3-flash",
        label: "GLM-5.3-Flash",
        optionDescriptors: [thinking],
      },
    ],
  }),
];

describe("modelDisplayName", () => {
  const zai = HARNESSES[1]?.models;

  test("the label, else the provider's name, else the name as given", () => {
    expect(modelDisplayName(zai, "sonnet")).toBe("GLM-5.3 Flash");
    expect(modelDisplayName(zai, "opus")).toBe("glm-5.3");
    expect(modelDisplayName(zai, "haiku")).toBe("haiku");
    expect(modelDisplayName(zai, "unlisted")).toBe("unlisted");
    expect(modelDisplayName(undefined, "claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
  });

  test("a frame's spelling finds its entry: the provider's name, or a dated id", () => {
    expect(modelDisplayName(zai, "glm-5.3-flash")).toBe("GLM-5.3 Flash");
    expect(
      modelDisplayName(
        [{ id: "claude-haiku-4-5", label: "Haiku" }],
        "claude-haiku-4-5-20251001",
      ),
    ).toBe("Haiku");
  });
});

describe("modelOptionsSummary", () => {
  test("what was set, by its choice's label; the default and nothing are nothing", () => {
    expect(
      modelOptionsSummary([thinking], [{ id: "thinkingLevel", value: "high" }]),
    ).toBe("High");
    expect(
      modelOptionsSummary(
        [thinking],
        [{ id: "thinkingLevel", value: "default" }],
      ),
    ).toBe("");
    expect(modelOptionsSummary([thinking], undefined)).toBe("");
    // A value the model no longer offers is said as itself (rule 4).
    expect(
      modelOptionsSummary(
        [thinking],
        [{ id: "thinkingLevel", value: "xhigh" }],
      ),
    ).toBe("xhigh");
  });
});

describe("modelNameIn", () => {
  test("in its own instance's catalogue, by id or by display name", () => {
    expect(modelNameIn(HARNESSES, { instanceId: "cc-zai" }, "sonnet")).toBe(
      "GLM-5.3 Flash",
    );
    expect(
      modelNameIn(HARNESSES, { harness: "Claude Code · z.ai" }, "opus"),
    ).toBe("glm-5.3");
    expect(
      modelNameIn(HARNESSES, { instanceId: "claude-code" }, "claude-sonnet-5"),
    ).toBe("claude-sonnet-5");
  });

  test("with no instance known, the first catalogue that names it", () => {
    expect(modelNameIn(HARNESSES, undefined, "sonnet")).toBe("GLM-5.3 Flash");
    expect(modelNameIn(HARNESSES, { instanceId: "gone" }, "sonnet")).toBe(
      "GLM-5.3 Flash",
    );
    expect(modelNameIn(HARNESSES, undefined, "mystery")).toBe("mystery");
  });

  test("a model with what was chosen of it, as the chip and the lists say it", () => {
    expect(
      modelWithOptions(
        HARNESSES,
        { instanceId: "pi-zai" },
        "zai/glm-5.3-flash",
        [{ id: "thinkingLevel", value: "high" }],
      ),
    ).toBe("GLM-5.3-Flash · High");
    expect(
      modelWithOptions(
        HARNESSES,
        { instanceId: "pi-zai" },
        "zai/glm-5.3-flash",
        undefined,
      ),
    ).toBe("GLM-5.3-Flash");
  });

  test("a provenance row: the name where the catalogue has one, else provider/model", () => {
    expect(provenanceModelIn(HARNESSES, "cc-zai", "zai", "sonnet")).toBe(
      "GLM-5.3 Flash",
    );
    expect(
      provenanceModelIn(HARNESSES, "claude-code", "anthropic", "claude-sonnet-5"),
    ).toBe("anthropic/claude-sonnet-5");
  });
});

describe("the surfaces that word a model take the rule", () => {
  const name = (model: string) =>
    modelNameIn(HARNESSES, { instanceId: "cc-zai" }, model);

  test("a turn's footer names each model that answered by its label", () => {
    const group = {
      subject: { startedAt: 1_000 },
      rows: [
        { item: { model: "sonnet", at: 2_000 } },
        { item: { model: "opus", at: 3_000 } },
      ],
    } as unknown as ChatGroup<ThreadTurn>;
    const said = turnFooterText(group, {
      agent: "Importer",
      model: "sonnet",
      name,
    });
    expect(said.startsWith("Importer · GLM-5.3 Flash → glm-5.3")).toBe(true);
    expect(said).not.toContain("sonnet");
  });

  test("a footer whose turn names no model says the session's by its label", () => {
    const group = {
      subject: { startedAt: null },
      rows: [],
    } as unknown as ChatGroup<ThreadTurn>;
    expect(
      turnFooterText(group, { agent: "Importer", model: "sonnet", name }),
    ).toBe("Importer · GLM-5.3 Flash");
  });

  test("a switch's notice names both models by their labels", () => {
    const switched: ConversationModelSwitched = {
      conversationId: "imp_1",
      harnessInstanceId: "cc-zai",
      model: "opus",
      modelOptions: [],
      droppedModelOptionIds: [],
      applied: "live",
      changed: true,
    };
    const said = switchedNotice({
      switched,
      previous: "sonnet",
      working: true,
      name,
    });
    expect(said).toContain("Now on glm-5.3.");
    expect(said).toContain("finishes on GLM-5.3 Flash");
    expect(said).not.toContain("sonnet");
    expect(said).not.toContain("opus");
  });

  test("the meter's recount line names the model by its label", () => {
    const meter = crumbMeter(
      {
        reading: {
          conversationId: "imp_1",
          model: "sonnet",
          used: 1_000,
          usedModel: "sonnet",
          window: 200_000,
          reading: "measured",
          breakdown: { _tag: "none", reason: "not_asked" },
          measuredAt: 1,
        },
        previous: null,
        cause: "recount",
      },
      undefined,
    );
    expect(crumbSource(meter, name)).toBe("Recounted for GLM-5.3 Flash");
  });
});
