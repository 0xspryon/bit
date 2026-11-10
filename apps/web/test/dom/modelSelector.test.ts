/**
 * The Harness · Model · Reasoning selector mounted on its own, outside any chat (A6 chat
 * generalisation, slice 2): what A9 H4f's Suggest-a-worker dialog and H6's chain rows mount.
 * Every value is the caller's; the selector only reports picks.
 */
import { afterEach, describe, expect, test } from "bun:test";

import ModelSelector from "../../src/lib/components/ModelSelector.svelte";
import { mockHarnesses } from "../../src/lib/mockImporter";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

describe("the model selector, alone", () => {
  test("opens from its chip and reports a harness and a model picked", async () => {
    const instances = mockHarnesses();
    const first = instances[0];
    if (first === undefined) throw new Error("no harness");
    const picked: string[] = [];
    mounted.push(
      mountInto(ModelSelector, {
        instances,
        active: first,
        model: first.defaultModel,
        modelView: first.models.find((each) => each.id === first.defaultModel),
        descriptors: [],
        selections: [],
        dropped: [],
        harness: first.displayName,
        subject: "A worker",
        onPickInstance: (instanceId: string) =>
          picked.push(`instance ${instanceId}`),
        onPickModel: (modelId: string) => picked.push(`model ${modelId}`),
        onPickOption: () => undefined,
      }),
    );
    const chip = document.querySelector<HTMLButtonElement>("button.chip");
    if (chip === null) throw new Error("no chip");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.textContent ?? "").toContain(first.defaultModel);
    click(chip);
    await settle();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const rows = [
      ...document.querySelectorAll<HTMLElement>("button.model-row"),
    ];
    const other = rows.find(
      (row) => !(row.textContent ?? "").includes(first.defaultModel),
    );
    if (other === undefined) throw new Error("no second model");
    click(other);
    await settle();
    const otherModel = first.models.find(
      (each) => each.id !== first.defaultModel,
    );
    expect(picked).toEqual([`model ${otherModel?.id ?? ""}`]);
    // A pick may close the list: open it again for the harness.
    if (chip.getAttribute("aria-expanded") !== "true") {
      click(chip);
      await settle();
    }
    const harnesses = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    const secondInstance = instances[1];
    expect(secondInstance).toBeDefined();
    const second = harnesses.find(
      (row) => row.getAttribute("aria-selected") === "false",
    );
    // Unconditional: a selector with two harnesses offers the one not picked.
    expect(second).toBeDefined();
    if (second === undefined) return;
    click(second);
    await settle();
    expect(picked.at(-1)).toBe(`instance ${secondInstance?.instanceId ?? ""}`);
  });
});

describe("two Claude Code instances (harness instances, slice 1)", () => {
  const instance = (
    instanceId: string,
    displayName: string,
    models: readonly { id: string; label?: string }[],
  ) => ({
    instanceId,
    driver: "claude-code",
    displayName,
    version: "2.1.310",
    ready: true,
    auth: "unknown" as const,
    isDefault: instanceId === "claude-code",
    defaultModel: models[0]?.id ?? "",
    models,
  });
  const stock = instance("claude-code", "Claude Code", [
    { id: "claude-haiku-4-5" },
  ]);
  const zai = instance("cc-zai", "Claude Code · z.ai", [
    { id: "sonnet", label: "GLM-5.3 Flash" },
    { id: "opus", label: "GLM-5.3" },
  ]);

  const mountOn = (active: typeof stock, namesHarness: boolean) =>
    mounted.push(
      mountInto(ModelSelector, {
        instances: [stock, zai],
        active,
        model: active.defaultModel,
        modelView: active.models[0],
        descriptors: [],
        selections: [],
        dropped: [],
        harness: active.displayName,
        namesHarness,
        onPickInstance: () => undefined,
        onPickModel: () => undefined,
        onPickOption: () => undefined,
      }),
    );

  test("the chip names the instance and the model's configured label, so the two never look the same", () => {
    mountOn(zai, true);
    mountOn(stock, true);
    const chips = [...document.querySelectorAll<HTMLElement>("button.chip")];
    expect(
      chips.map((chip) => chip.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual([
      "c Claude Code · z.ai GLM-5.3 Flash",
      "c Claude Code claude-haiku-4-5",
    ]);
  });

  test("a surface that does not ask keeps the glyph and the id", () => {
    mountOn(zai, false);
    const chip = document.querySelector<HTMLElement>("button.chip");
    expect(chip?.textContent?.replace(/\s+/g, " ").trim()).toBe("c sonnet");
  });

  test("the picker lists the instance's models by label, with the id a run names", async () => {
    mountOn(zai, true);
    const chip = document.querySelector<HTMLButtonElement>("button.chip");
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();
    const rows = [
      ...document.querySelectorAll<HTMLElement>("button.model-row"),
    ].map((row) => row.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toEqual(["GLM-5.3 Flash sonnet default", "GLM-5.3 opus"]);
    const rail = [...document.querySelectorAll<HTMLElement>(".rail-name")].map(
      (name) => name.textContent?.trim(),
    );
    expect(rail).toEqual(["Claude Code default", "Claude Code · z.ai"]);
  });
});
