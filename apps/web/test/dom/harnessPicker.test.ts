/**
 * The run composer's harness picker, mounted through its prototype state.
 *
 * happy-dom does no layout, so nothing here measures the popover; what it pins is the
 * structure the narrow-window layout depends on. `HarnessChoice` moves only the rail above
 * the other two columns when it stacks, and that works because the model list and the
 * options column share one wrapper under it — so both pickers are checked for that shape,
 * as well as that the run picker's state reaches the real component at all.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { App, scenarios } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer } from "../fakeServer";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const show = async (id: string): Promise<App> => {
  const app = new App(new FakeServer(), new FakeCountdown());
  const scenario = scenarios.find((each) => each.id === id);
  if (scenario === undefined) throw new Error(`no scenario "${id}"`);
  scenario.apply(app);
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return app;
};

const dialog = (): Element => {
  const found = document.querySelector(
    '[role="dialog"][aria-label="Choose a harness and model"]',
  );
  if (found === null) throw new Error("no picker open");
  return found;
};

/** The columns as `HarnessChoice` lays them out: the rail, then the other two together. */
const columns = (root: Element): string[][] => {
  const choice = root.querySelector(".choice");
  if (choice === null) throw new Error("no HarnessChoice");
  return [...choice.children].map((child) =>
    child.classList.contains("body")
      ? [...child.children].map((inner) => inner.className.split(" ")[0] ?? "")
      : [child.className.split(" ")[0] ?? ""],
  );
};

describe("the run composer's picker", () => {
  test("its prototype state opens the real picker, with both harnesses and the Reasoning column", async () => {
    await show("run-picker");

    const open = dialog();
    expect(open.textContent).toContain("OpenCode");
    expect(open.textContent).toContain("Claude Code");
    expect(open.querySelectorAll(".model-row")).toHaveLength(7);
    // The composer's own pinning sentence, in attempts' words.
    expect(open.textContent).toContain(
      "An attempt is pinned to the harness it starts on",
    );
    expect(open.querySelectorAll(".option-row")).toHaveLength(7);
  });

  test("the model list and the options column sit together under the rail", async () => {
    await show("run-picker");

    expect(columns(dialog())).toEqual([["rail"], ["models", "options"]]);
  });

  test("picking another harness in the rail lists its models", async () => {
    const app = await show("run-picker");

    const row = [
      ...dialog().querySelectorAll<HTMLButtonElement>(".rail-row"),
    ].find((each) => each.textContent?.includes("Claude Code"));
    if (row === undefined) throw new Error("no Claude Code row");
    click(row);
    await settle();

    expect(app.pickedInstanceId).toBe("claude-code");
    expect(
      [...dialog().querySelectorAll(".model-name")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["claude-sonnet-5", "claude-opus-5"]);
  });
});

describe("the importer's picker", () => {
  test("has the same shape: the rail, then the model list and the options column together", async () => {
    await show("importer-first");
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
    );
    if (chip === null) throw new Error("no model chip");
    click(chip);
    await settle();

    expect(columns(dialog())).toEqual([["rail"], ["models", "options"]]);
  });
});
