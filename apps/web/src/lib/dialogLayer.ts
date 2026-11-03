/**
 * Where a modal dialog is in the document, and which one the keyboard is talking to.
 *
 * `dialogFocus` is where focus goes in and out of one dialog. This is about there being
 * more than one: the harness picker stays open after a pick, so a refusal of that pick
 * opens an `ErrorDialog` from inside it, and two dialogs are up at once. `Modal` and
 * `HarnessDialog` both use it, so every dialog stacks the same way.
 *
 * ## At the end of `<body>`
 *
 * A dialog renders where its caller writes it, and that is inside whatever the caller is
 * inside: a `<form>` that becomes the form owner of every field in the dialog (the reason
 * `HarnessDialog` moved first — see its header), and any containing block or stacking
 * context an ancestor makes, which `position: fixed` does not escape. Every scrim is
 * `z-index: 50`, so between two of them the later one in the document is drawn on top —
 * and a dialog opened from inside a dialog that had moved to `<body>`, while it stayed put,
 * was drawn *under* the one it was opened from.
 *
 * So each dialog's layer is appended to `<body>` as it mounts. The one opened last is last
 * in `<body>`, so it is on top, whatever either caller is nested in.
 *
 * That holds only if a dialog renders nothing into its layer until the layer has moved.
 * Svelte runs a child's attachment before its parent's, so a dialog opened from inside
 * another *in the same update* — a `Modal` whose body holds another `Modal` — would have
 * its layer appended first, and the outer one drawn over it. Both `Modal` and
 * `HarnessDialog` render their panel in `toBody`'s `onMoved`, so the inner dialog does not
 * exist until the outer one's layer is in `<body>`, and can only follow it there.
 *
 * The component keeps an empty, `hidden` origin where it was written and moves only a layer
 * inside it: Svelte removes a block by walking its nodes from first to last sibling, and a
 * moved root would send that walk off through whatever followed it in `<body>`.
 *
 * ## The topmost one has the keyboard
 *
 * Each dialog listens for Escape and Tab on the window, because focus can be on the panel
 * itself or anywhere in it. With two up, both hear one key: one Escape closed both, and
 * the lower one's Tab trap pulled focus out of the upper one. So only the dialog on top
 * answers; and an Escape it answered is marked handled, so a dialog that becomes the top
 * one *during* that same key — the upper one closed synchronously, before the lower one's
 * listener ran — still leaves it.
 *
 * "On top" is the order the layers went into `<body>`, which is what is drawn: they are
 * kept in a list as `toBody` appends them, so the list and the screen cannot disagree. It
 * was once the order the dialogs' effects ran in, and those are not the same order. When
 * a dialog renders inside another in the same update — the picker opening with a refusal
 * already set — Svelte runs the inner one's effects first, a child's before its parent's,
 * while the outer one's layer is in `<body>` first. The error was drawn on top and the
 * picker had the keyboard.
 *
 * ## Focus goes in from the bottom up
 *
 * The same child-first order sent focus the wrong way: the error's effect focused it, and
 * the picker's, after, took focus back to the panel behind. So a dialog does not take
 * focus until every layer under it has: one whose layer is in `<body>` but whose effect
 * has not run yet holds the ones over it back, and they go in after it, in `<body>` order.
 * That is the order they would have taken focus in had they opened one after the other —
 * so the error's opener is in the picker, and closing the error puts focus back there.
 */
import type { Attachment } from "svelte/attachments";
import { wrapTab } from "./dialogFocus";

/**
 * A dialog's layer in `<body>`, from the moment it is appended.
 *
 * - `mounting`: in `<body>`, its effect not run yet. Every layer over it waits for it.
 * - `waiting`: its effect has run, and it takes focus with `enter` once nothing under it
 *   is still mounting.
 * - `entered`: it has taken focus, and `restore` gives it back.
 * - `left`: its effect is torn down, and it holds nothing back while its layer goes.
 */
interface Layer {
  readonly element: HTMLElement;
  status: "mounting" | "waiting" | "entered" | "left";
  enter: (() => () => void) | null;
  restore: (() => void) | null;
}

/** Every dialog's layer, in `<body>` order: the last is on top. */
const open: Layer[] = [];

/** Lets every waiting layer take focus, bottom up, as far as the first still mounting. */
const advance = (): void => {
  for (const layer of open) {
    if (layer.status === "mounting") return;
    if (layer.status === "waiting" && layer.enter !== null) {
      layer.status = "entered";
      layer.restore = layer.enter();
      layer.enter = null;
    }
  }
};

/**
 * Moves the element it is attached to to the end of `<body>`, which puts it on top of the
 * open dialogs, and removes it with the dialog. `onMoved` runs once it is there: both
 * dialogs render their panel only then, so one opened from inside it follows it into
 * `<body>` (see "At the end of `<body>`").
 *
 * Moving a node that holds focus blurs it. A body whose own effect focused a field before
 * the attachment ran would lose that, so whatever inside had focus has it again after.
 */
export const toBody =
  (onMoved?: () => void): Attachment<HTMLElement> =>
  (element) => {
    const held = document.activeElement;
    document.body.append(element);
    const layer: Layer = {
      element,
      status: "mounting",
      enter: null,
      restore: null,
    };
    open.push(layer);
    if (
      held instanceof HTMLElement &&
      held !== document.activeElement &&
      element.contains(held)
    ) {
      held.focus();
    }
    onMoved?.();
    return () => {
      const at = open.indexOf(layer);
      if (at !== -1) open.splice(at, 1);
      element.remove();
      // It may have gone without its effect ever running; nothing over it waits on it now.
      advance();
    };
  };

/**
 * Takes focus into `panel` with `holdFocus` once every dialog under it has, and returns
 * what gives it back. Call it from the effect that sees the panel mount, after `toBody`
 * has moved its layer.
 */
export function enterLayer(
  panel: HTMLElement,
  holdFocus: () => () => void,
): () => void {
  const layer = open.find((each) => each.element.contains(panel));
  if (layer === undefined) return holdFocus();
  layer.status = "waiting";
  layer.enter = holdFocus;
  advance();
  return () => {
    const { restore } = layer;
    layer.status = "left";
    layer.enter = null;
    layer.restore = null;
    restore?.();
  };
}

/** Whether `panel` is in the dialog on top, which is the one keys are for. */
export const isTopmost = (panel: HTMLElement): boolean =>
  open.at(-1)?.element.contains(panel) ?? false;

/**
 * A dialog's window `keydown`: Escape closes it, Tab stays in it — if it is the dialog on
 * top and nothing has already answered the key.
 */
export function dialogKeydown(
  event: KeyboardEvent,
  panel: HTMLElement | null,
  onclose: () => void,
): void {
  if (panel === null || event.defaultPrevented || !isTopmost(panel)) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onclose();
    return;
  }
  wrapTab(event, panel);
}
