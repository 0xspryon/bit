/**
 * Frame spellings back to the catalogue (`modelSpellings.ts`), with the spellings measured
 * on z.ai and on the operator's Anthropic login (CLI 2.1.310).
 */
import { describe, expect, test } from "bun:test";

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
