/**
 * The error dialog, mounted on its own as a caller's `{#if}` would mount it.
 *
 * `ondismiss` here does what a caller's does — clears the value the `{#if}` reads, so the
 * dialog unmounts — which is the moment focus has to go back. The opener is a real button
 * in the document, focused first, as the hand that sent the refused request left it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createRawSnippet } from "svelte";

import ErrorDialog from "../../src/lib/components/ErrorDialog.svelte";
import Modal from "../../src/lib/components/Modal.svelte";
import NestedDialogs from "./fixtures/NestedDialogs.svelte";
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

  test("Tab and Shift+Tab are kept inside it", async () => {
    await open();
    const panel = dialog();
    const close = panel?.querySelector<HTMLElement>("button");
    if (panel === null || close === null || close === undefined) {
      throw new Error("no panel or no Close");
    }

    // From the panel itself, where focus starts: Shift+Tab is cancelled and lands on the
    // last control rather than leaving for the page behind.
    expect(document.activeElement).toBe(panel);
    const back = press("Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement, focused()).toBe(close);

    // Past the last control, which here is also the first.
    const forward = press("Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement, focused()).toBe(close);

    const backAgain = press("Tab", { shiftKey: true });
    expect(backAgain.defaultPrevented).toBe(true);
    expect(document.activeElement, focused()).toBe(close);
  });

  test("Tab from the panel to its first control is the browser's, not cancelled", async () => {
    await open();
    // Nothing to wrap: the next control in order is inside the panel already.
    expect(press("Tab").defaultPrevented).toBe(false);
  });
});

describe("in the document", () => {
  test("it renders at the end of <body>, not inside the element it was mounted in", async () => {
    await open();
    const shown = dialog();
    const layer = shown?.closest(".layer");
    expect(layer?.parentElement).toBe(document.body);
    for (const each of mounted)
      expect(each.target.contains(shown ?? null)).toBe(false);
  });
});

/**
 * `ErrorDialog`'s options are `Modal`'s, each defaulting to what the form and question
 * dialogs had. A default `Modal` is checked here so a change of default for the error
 * dialog cannot quietly change `Goals`, `FolderPicker` and `ConfirmAction`.
 */
describe("a default Modal", () => {
  const snippet = (html: string) =>
    createRawSnippet(() => ({ render: () => html }));

  const openModal = async () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    openers.push(trigger);
    trigger.focus();
    const state = { closed: 0 };
    mounted.push(
      mountInto(Modal, {
        title: "New goal",
        onclose: () => (state.closed += 1),
        body: snippet('<p class="body-text">Something to lose.</p>'),
        footer: snippet('<button type="button" class="save">Save</button>'),
      }),
    );
    await settle();
    const panel = document.querySelector<HTMLElement>(".panel");
    if (panel === null) throw new Error("no Modal");
    return { panel, state };
  };

  test("is a dialog, not an alertdialog", async () => {
    const { panel } = await openModal();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.hasAttribute("aria-describedby")).toBe(false);
  });

  test("keeps its header ×, which closes it", async () => {
    const { panel, state } = await openModal();
    const x = panel.querySelector<HTMLElement>(
      'header button[aria-label="Close"]',
    );
    if (x === null) throw new Error("no header ×");
    click(x);
    expect(state.closed).toBe(1);
  });

  test("a click outside the panel does not close it", async () => {
    const { panel, state } = await openModal();
    // No control on the scrim to catch it, and the scrim itself does nothing.
    expect(document.querySelector('button.dismiss[tabindex="-1"]')).toBeNull();
    const scrim = panel.closest(".scrim");
    if (scrim === null) throw new Error("no scrim");
    click(scrim);
    await settle();
    expect(state.closed).toBe(0);
    expect(panel.isConnected).toBe(true);
  });
});

/**
 * The refusal of a pick, from inside the harness picker that stays open after one. Both
 * are the real dialogs; the fixture stands in only for the columns.
 */
describe("opened from inside the harness picker", () => {
  const picker = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Choose a harness and model"]',
    );

  const openNested = async () => {
    mounted.push(mountInto(NestedDialogs, {}));
    await settle();
    const pick = picker()?.querySelector<HTMLElement>(".pick");
    if (pick === null || pick === undefined) throw new Error("no picker");
    pick.focus();
    click(pick);
    await settle();
    return { pick };
  };

  test("is drawn over the picker: later in <body>", async () => {
    await openNested();
    const error = dialog();
    const lower = picker();
    if (error === null || lower === null)
      throw new Error("both should be open");
    const errorLayer = error.closest(".layer");
    const pickerLayer = lower.closest(".layer");
    expect(errorLayer?.parentElement).toBe(document.body);
    expect(pickerLayer?.parentElement).toBe(document.body);
    // Not inside the picker's panel, where the picker's scrim would be over it.
    expect(lower.contains(error)).toBe(false);
    expect(
      (pickerLayer?.compareDocumentPosition(errorLayer as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(document.activeElement).toBe(error);
  });

  test("one Escape closes only the error, and focus goes back into the picker", async () => {
    const { pick } = await openNested();
    press("Escape");
    await settle();
    expect(dialog()).toBeNull();
    expect(picker()).not.toBeNull();
    expect(document.activeElement, focused()).toBe(pick);

    // The picker answers the next one.
    press("Escape");
    await settle();
    expect(picker()).toBeNull();
    expect(document.activeElement, focused()).toBe(
      document.querySelector(".trigger"),
    );
  });

  test("the picker's Tab trap leaves the error's focus alone", async () => {
    await openNested();
    const close = dialog()?.querySelector<HTMLElement>("button");
    if (close === null || close === undefined) throw new Error("no Close");
    close.focus();
    press("Tab");
    expect(document.activeElement, focused()).toBe(close);
    press("Tab", { shiftKey: true });
    expect(document.activeElement, focused()).toBe(close);
  });

  test("a click on the error's scrim closes only the error", async () => {
    const { pick } = await openNested();
    const scrims = document.querySelectorAll<HTMLElement>(
      'button.dismiss[tabindex="-1"]',
    );
    const top = scrims[scrims.length - 1];
    if (top === undefined) throw new Error("no scrim control");
    click(top);
    await settle();
    expect(dialog()).toBeNull();
    expect(picker()).not.toBeNull();
    expect(document.activeElement, focused()).toBe(pick);
  });
});
