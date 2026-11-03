/**
 * `Modal`s opened inside one another in a single update, which is the order Svelte gets
 * wrong for a dialog that renders its content before its layer is in `<body>`.
 *
 * A child's attachment runs before its parent's. A `Modal` that rendered its body at once
 * had its inner dialog's layer appended first, so the outer one was drawn on top, had the
 * keyboard, and one Escape closed it — and with it, unseen, the dialog opened from inside.
 * The picker never did this, because it renders nothing until its own layer has moved;
 * `Modal` now does the same, and these pin it for a `Modal` under a `Modal`, three deep
 * under either, and nothing left in `<body>` when they go.
 */
import { afterEach, describe, expect, test } from "bun:test";

import StackedModals from "./fixtures/StackedModals.svelte";
import { focused, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const PICKER = "Choose a harness and model";

/** The dialogs' names in `<body>` order: the last is the one drawn on top. */
const layers = (): (string | null)[] =>
  [...document.body.children]
    .filter((each) => each.classList.contains("layer"))
    .map(
      (each) =>
        each.querySelector('[aria-modal="true"]')?.getAttribute("aria-label") ??
        null,
    );

const dialogNamed = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[aria-modal="true"][aria-label="${name}"]`,
  );

const open = async (props: { base?: "modal" | "picker"; deep?: boolean }) => {
  const stack = mountInto(StackedModals, props);
  mounted.push(stack);
  await settle();
  return stack;
};

/** Escape, then the dialog that should be on top is, and focus is inside it. */
const escapeInto = async (expected: string[]) => {
  press("Escape");
  await settle();
  expect(layers()).toEqual(expected);
  const top = dialogNamed(expected.at(-1) ?? "");
  expect(top?.contains(document.activeElement) ?? false, focused()).toBe(true);
};

describe("a Modal inside a Modal, mounted together", () => {
  test("the inner one is drawn on top and has focus", async () => {
    await open({});
    expect(layers()).toEqual(["Outer", "Middle"]);
    expect(document.activeElement, focused()).toBe(dialogNamed("Middle"));
  });

  test("the first Escape closes only the inner one, with focus back in the outer", async () => {
    await open({});
    await escapeInto(["Outer"]);

    press("Escape");
    await settle();
    expect(layers()).toEqual([]);
    expect(document.activeElement, focused()).toBe(
      document.querySelector(".trigger"),
    );
  });
});

describe("three deep, mounted together", () => {
  test("under a Modal: each Escape closes only the top one", async () => {
    await open({ deep: true });
    expect(layers()).toEqual(["Outer", "Middle", "Inner"]);
    expect(document.activeElement, focused()).toBe(dialogNamed("Inner"));

    await escapeInto(["Outer", "Middle"]);
    await escapeInto(["Outer"]);
  });

  test("under the harness picker: each Escape closes only the top one", async () => {
    await open({ base: "picker", deep: true });
    expect(layers()).toEqual([PICKER, "Middle", "Inner"]);
    expect(document.activeElement, focused()).toBe(dialogNamed("Inner"));

    await escapeInto([PICKER, "Middle"]);
    await escapeInto([PICKER]);
  });
});

describe("unmounting", () => {
  test("leaves no layer in <body>, whichever stack it was", async () => {
    for (const props of [
      {},
      { deep: true },
      { base: "picker" as const, deep: true },
    ]) {
      const stack = await open(props);
      expect(layers().length).toBeGreaterThan(1);
      stack.destroy();
      mounted = mounted.filter((each) => each !== stack);
      await settle();
      expect(layers()).toEqual([]);
      expect(document.body.querySelector(".layer")).toBeNull();
    }
  });
});
