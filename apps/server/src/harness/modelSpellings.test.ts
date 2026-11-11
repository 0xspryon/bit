/**
 * Frame spellings back to the catalogue (`modelSpellings.ts`), with the spellings measured
 * on z.ai and on the operator's Anthropic login (CLI 2.1.310).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readLearnedModelNames,
  writeLearnedModelNames,
} from "./learnedModelNames";
import { modelSpellings } from "./modelSpellings";

describe("an aliasing instance", () => {
  test("a declared spelling maps back before any session has said it", () => {
    const spellings = modelSpellings([
      { id: "opus", reportedAs: "glm-5.3" },
      { id: "sonnet", reportedAs: "glm-5.3-flash" },
    ]);
    expect(spellings.toCatalogue("glm-5.3-flash", undefined)).toBe("sonnet");
    expect(spellings.toCatalogue("GLM-5.3", "sonnet")).toBe("opus");
  });

  test("a learned spelling maps back, from the session's init or a switch", () => {
    const spellings = modelSpellings([{ id: "opus" }, { id: "sonnet" }]);
    expect(spellings.toCatalogue("glm-5.3-flash", "sonnet")).toBe(
      "glm-5.3-flash",
    );
    spellings.learn("glm-5.3-flash", "sonnet");
    spellings.learn("glm-5.3", "opus");
    expect(spellings.toCatalogue("glm-5.3-flash", "opus")).toBe("sonnet");
    expect(spellings.toCatalogue("glm-5.3", "opus")).toBe("opus");
  });

  test("two entries on one provider model: the session's own wins, else the newest", () => {
    const spellings = modelSpellings([
      { id: "sonnet", reportedAs: "glm-5.3-flash" },
      { id: "haiku" },
    ]);
    spellings.learn("glm-5.3-flash", "haiku");
    expect(spellings.toCatalogue("glm-5.3-flash", "sonnet")).toBe("sonnet");
    expect(spellings.toCatalogue("glm-5.3-flash", "haiku")).toBe("haiku");
    expect(spellings.toCatalogue("glm-5.3-flash", undefined)).toBe("haiku");
  });

  test("a spelling nobody declared or learned is left as it came", () => {
    const spellings = modelSpellings([{ id: "sonnet" }]);
    expect(spellings.toCatalogue("glm-9", "sonnet")).toBe("glm-9");
    expect(spellings.toCatalogue(undefined, "sonnet")).toBeUndefined();
  });
});

describe("the Anthropic instance", () => {
  test("a dated spelling of a catalogue model is not touched", () => {
    const spellings = modelSpellings([
      { id: "claude-haiku-4-5" },
      { id: "claude-sonnet-5" },
    ]);
    spellings.learn("claude-haiku-4-5-20251001", "claude-haiku-4-5");
    // `sameModel` already reads these as one model; the browser keeps the dated spelling it
    // has always been sent.
    expect(
      spellings.toCatalogue("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
    ).toBe("claude-haiku-4-5-20251001");
  });

  test("a model that is another catalogue entry is never rewritten", () => {
    const spellings = modelSpellings([
      { id: "claude-haiku-4-5" },
      { id: "claude-sonnet-5" },
    ]);
    // A switch whose context read raced the old model's answer must not teach that
    // haiku is spelt sonnet: a catalogue spelling is never learned.
    spellings.learn("claude-sonnet-5", "claude-haiku-4-5");
    expect(spellings.toCatalogue("claude-sonnet-5", "claude-haiku-4-5")).toBe(
      "claude-sonnet-5",
    );
  });
});

describe("the provider's name of a catalogue entry", () => {
  test("is the declared spelling, then the newest a session reported, and nothing where the id is the name", () => {
    const spellings = modelSpellings([
      { id: "opus", reportedAs: "glm-5.3" },
      { id: "sonnet" },
      { id: "claude-haiku-4-5" },
    ]);
    expect(spellings.providerName("opus")).toBe("glm-5.3");
    expect(spellings.providerName("sonnet")).toBeUndefined();
    spellings.learn("glm-5.3-flash", "sonnet");
    expect(spellings.providerName("sonnet")).toBe("glm-5.3-flash");
    spellings.learn("claude-haiku-4-5-20251001", "claude-haiku-4-5");
    expect(spellings.providerName("claude-haiku-4-5")).toBeUndefined();
  });
});

describe("names kept from an earlier run (follow-ups A review, M2)", () => {
  test("are read first: a declared name, then a live answer, take their place, and only live answers are kept", () => {
    const kept: ReadonlyMap<string, string>[] = [];
    const spellings = modelSpellings(
      [
        { id: "opus", reportedAs: "glm-5.3" },
        { id: "sonnet" },
        { id: "haiku" },
      ],
      {
        names: new Map([
          ["opus", "glm-old"],
          ["sonnet", "glm-5.3-flash"],
        ]),
        learned: (names) => kept.push(names),
      },
    );
    // Declared beats kept; kept is there before any session spoke.
    expect(spellings.providerName("opus")).toBe("glm-5.3");
    expect(spellings.providerName("sonnet")).toBe("glm-5.3-flash");
    expect(spellings.toCatalogue("glm-5.3-flash", undefined)).toBe("sonnet");
    expect(kept).toEqual([]);
    // The same answer again keeps nothing new; a new one is kept with the rest.
    spellings.learn("glm-5.3-flash", "sonnet");
    expect(kept).toEqual([]);
    spellings.learn("glm-5.3-air", "haiku");
    expect(kept.map((names) => [...names])).toEqual([
      [
        ["opus", "glm-old"],
        ["sonnet", "glm-5.3-flash"],
        ["haiku", "glm-5.3-air"],
      ],
    ]);
  });

  test("a missing, broken or wrongly shaped file is no names, and a written one reads back", () => {
    const folder = mkdtempSync(join(tmpdir(), "bit-kept-names-"));
    try {
      const file = join(folder, "nested", "cc.json");
      expect(readLearnedModelNames(file).size).toBe(0);
      expect(writeLearnedModelNames(file, new Map([["opus", "glm-5.3"]]))).toBe(
        true,
      );
      expect([...readLearnedModelNames(file)]).toEqual([["opus", "glm-5.3"]]);
      writeFileSync(file, "{ not json");
      expect(readLearnedModelNames(file).size).toBe(0);
      writeFileSync(file, JSON.stringify({ names: { opus: 3 } }));
      expect(readLearnedModelNames(file).size).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
