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
import { click, mountInto, press, settle, type Mounted } from "./dom";

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

describe("an input method in the picker's filter (A7-Q review 2)", () => {
  test("Esc and the arrows while composing are the input method's, not the dialog's; after it, Esc closes", async () => {
    await show("importer-first");
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
    );
    if (chip === null) throw new Error("no model chip");
    click(chip);
    await settle();
    const filter = dialog().querySelector<HTMLInputElement>("input.search");
    if (filter === null) throw new Error("no filter");
    filter.focus();
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      const escape = press("Escape", ime);
      await settle();
      expect(escape.defaultPrevented).toBe(false);
      expect(dialog().isConnected).toBe(true);
    }
    // The arrows choose the IME's candidate while it converts, not a model row.
    const down = press("ArrowDown", { isComposing: true });
    await settle();
    expect(down.defaultPrevented).toBe(false);
    expect(document.activeElement === filter).toBe(true);
    press("ArrowDown");
    await settle();
    expect(document.activeElement?.classList.contains("model-row")).toBe(true);
    press("Escape");
    await settle();
    expect(
      document.querySelector(
        '[role="dialog"][aria-label="Choose a harness and model"]',
      ),
    ).toBeNull();
  });
});

/*
 * The model list is a roving tabindex: every row but one is a `tabindex="-1"` button. A
 * trap that counted those took the last row for its last stop, so with a picked model that
 * has no Reasoning column and is not last in the list, Tab from its row — the real last
 * stop — went past the trap: behind the scrim, or onto the composer under the popover.
 * happy-dom does not move focus on Tab, so what is pinned is the trap's own move.
 */
describe("Tab from a picked model with no reasoning options wraps inside the picker", () => {
  const PICKED = "openai/gpt-5.5";

  /** The picked row, after picking it, with focus on it as the arrows would leave it. */
  const onPickedRow = async (): Promise<HTMLButtonElement> => {
    const row = [
      ...dialog().querySelectorAll<HTMLButtonElement>(".model-row"),
    ].find((each) => each.textContent.includes(PICKED));
    if (row === undefined) throw new Error(`no ${PICKED} row`);
    click(row);
    await settle();
    expect(dialog().querySelectorAll(".option-row")).toHaveLength(0);
    // Not the last row: the rows after it are the ones Tab never reaches.
    const rows = [...dialog().querySelectorAll(".model-row")];
    expect(rows.indexOf(row)).toBeLessThan(rows.length - 1);
    row.focus();
    return row;
  };

  /** The first and last controls Tab stops on, in the panel's order. */
  const stops = (): HTMLElement[] =>
    [
      ...dialog().querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [tabindex]",
      ),
    ].filter((each) => each.tabIndex >= 0);

  const wrapsFrom = async (row: HTMLButtonElement): Promise<void> => {
    const order = stops();
    expect(order.at(-1)?.outerHTML).toBe(row.outerHTML);
    const forward = press("Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement === order[0]).toBe(true);
    const back = press("Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement === row).toBe(true);
  };

  test("in the new-session dialog", async () => {
    await show("importer-first");
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
    );
    if (chip === null) throw new Error("no model chip");
    click(chip);
    await settle();
    await wrapsFrom(await onPickedRow());
  });

  test("in the run composer's popover", async () => {
    const app = await show("run-picker");
    await wrapsFrom(await onPickedRow());
    expect(app.pickerOpen).toBe(true);
  });
});
