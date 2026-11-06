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
    expect(picked.some((each) => each.startsWith("model "))).toBe(true);
    const harnesses = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    const second = harnesses.find(
      (row) => row.getAttribute("aria-selected") === "false",
    );
    if (second !== undefined) {
      click(second);
      await settle();
      expect(picked.some((each) => each.startsWith("instance "))).toBe(true);
    }
  });
});
