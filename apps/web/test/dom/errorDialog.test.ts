/**
 * The error dialog, mounted on its own as a caller's `{#if}` would mount it.
 *
 * `ondismiss` here does what a caller's does — clears the value the `{#if}` reads, so the
 * dialog unmounts — which is the moment focus has to go back. The opener is a real button
 * in the document, focused first, as the hand that sent the refused request left it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import ErrorDialog from "../../src/lib/components/ErrorDialog.svelte";
import { click, focused, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
let openers: HTMLElement[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  for (const each of openers) each.remove();
  mounted = [];
  openers = [];
});

const SENTENCE = "The harness would not switch to claude-opus-5-5.";

/** A focused trigger, then the dialog over it; `dismissed` counts closes, each of which unmounts it. */
const open = async (
  props: {
    sentence?: string;
    detail?: string;
    named?: boolean;
    /** What has focus as the dialog mounts, when it is not the trigger. */
    focusedAtOpen?: HTMLElement;
  } = {},
) => {
  const trigger = document.body.appendChild(document.createElement("button"));
  trigger.textContent = "Switch model";
  openers.push(trigger);
  (props.focusedAtOpen ?? trigger).focus();
  const state = { dismissed: 0 };
  const self: Mounted = mountInto(ErrorDialog, {
    title: "Model not switched",
    sentence: props.sentence ?? SENTENCE,
    ...(props.detail === undefined ? {} : { detail: props.detail }),
    ...(props.named === true ? { opener: trigger } : {}),
    ondismiss: () => {
      state.dismissed += 1;
      self.destroy();
      mounted = mounted.filter((each) => each !== self);
    },
  });
  mounted.push(self);
  await settle();
  return { trigger, state };
};

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]');

describe("opening", () => {
  test("is an alertdialog named by its title and described by the sentence", async () => {
    await open({ detail: "model_unavailable" });
    const shown = dialog();
    expect(shown).not.toBeNull();
    expect(shown?.getAttribute("aria-modal")).toBe("true");
    expect(shown?.getAttribute("aria-label")).toBe("Model not switched");
    expect(shown?.querySelector("h2")?.textContent).toBe("Model not switched");

    const described = shown?.getAttribute("aria-describedby") ?? "";
    expect(described).not.toBe("");
    expect(document.getElementById(described)?.textContent).toBe(SENTENCE);
    expect(shown?.querySelector(".detail")?.textContent).toBe(
      "model_unavailable",
    );
  });

  test("has one way out: the dismiss button, and no header ×", async () => {
    await open();
    const buttons = [...(dialog()?.querySelectorAll("button") ?? [])];
    expect(buttons.map((each) => each.textContent.trim())).toEqual(["Close"]);
  });

  test("moves focus onto the panel, not the button", async () => {
    await open();
    expect(document.activeElement).toBe(dialog());
  });

  test("draws no detail line when there is none", async () => {
    await open();
    expect(dialog()?.querySelector(".detail")).toBeNull();
  });
});

describe("the sentence", () => {
  test("is text: markup in it stays literal and builds no element", async () => {
    const hostile =
      '<img src=x onerror="alert(1)"><b>bold</b> **not markdown** [link](https://evil.test)';
    await open({ sentence: hostile, detail: "<i>code</i>" });
    const shown = dialog();
    const sentence = shown?.querySelector(".sentence");
    expect(sentence?.textContent).toBe(hostile);
    expect(sentence?.children).toHaveLength(0);
    expect(shown?.querySelector("img, b, i, a, strong")).toBeNull();
    expect(shown?.querySelector(".detail")?.textContent).toBe("<i>code</i>");
  });
});

describe("closing", () => {
  test("Escape closes it and focus goes back to the opener", async () => {
    const { trigger, state } = await open();
    press("Escape");
    await settle();
    expect(state.dismissed).toBe(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement, focused()).toBe(trigger);
  });

  test("the dismiss button closes it and focus goes back to the opener", async () => {
    const { trigger, state } = await open();
    const close = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (each) => each.textContent.trim() === "Close",
    );
    if (close === undefined) throw new Error("no Close button");
    close.focus();
    click(close);
    await settle();
    expect(state.dismissed).toBe(1);
    expect(dialog()).toBeNull();
    expect(document.activeElement, focused()).toBe(trigger);
  });

  test("a click on the scrim closes it, as the harness picker's does", async () => {
    const { trigger, state } = await open();
    const scrim = document.querySelector('button.dismiss[tabindex="-1"]');
    if (scrim === null) throw new Error("no scrim control");
    click(scrim);
    await settle();
    expect(state.dismissed).toBe(1);
    expect(document.activeElement, focused()).toBe(trigger);
  });

  test("a named opener gets focus back even when focus was elsewhere as it opened", async () => {
    const elsewhere = document.body.appendChild(
      document.createElement("button"),
    );
    openers.push(elsewhere);
    // The refusal arrived after the operator had moved on; the trigger is still the one.
    const { trigger } = await open({ named: true, focusedAtOpen: elsewhere });
    press("Escape");
    await settle();
    expect(document.activeElement, focused()).toBe(trigger);
  });

  test("Tab stays inside it", async () => {
    await open();
    const close = dialog()?.querySelector<HTMLElement>("button");
    close?.focus();
    press("Tab");
    expect(document.activeElement).toBe(close ?? null);
  });
});
