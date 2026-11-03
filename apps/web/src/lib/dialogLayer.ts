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
 * The component keeps an empty, `hidden` origin where it was written and moves only a layer
 * inside it: Svelte removes a block by walking its nodes from first to last sibling, and a
 * moved root would send that walk off through whatever followed it in `<body>`.
 *
 * ## The topmost one has the keyboard
 *
 * Each dialog listens for Escape and Tab on the window, because focus can be on the panel
 * itself or anywhere in it. With two up, both hear one key: one Escape closed both, and
 * the lower one's Tab trap pulled focus out of the upper one. So the dialogs that are open
 * are kept in the order they opened, and only the last answers; and an Escape it answered
 * is marked handled, so a dialog that becomes the last one *during* that same key — the
 * upper one closed synchronously, before the lower one's listener ran — still leaves it.
 */
import type { Attachment } from "svelte/attachments";
import { wrapTab } from "./dialogFocus";

/** Every open dialog's panel, in the order they opened: the last is on top. */
const open: HTMLElement[] = [];

/**
 * Moves the element it is attached to to the end of `<body>`, and removes it with the
 * dialog. `onMoved` runs once it is there, for a dialog that renders its panel only after
 * the move (`HarnessDialog`).
 *
 * Moving a node that holds focus blurs it. A body whose own effect focused a field before
 * the attachment ran would lose that, so whatever inside had focus has it again after.
 */
export const toBody =
  (onMoved?: () => void): Attachment<HTMLElement> =>
  (layer) => {
    const held = document.activeElement;
    document.body.append(layer);
    if (
      held instanceof HTMLElement &&
      held !== document.activeElement &&
      layer.contains(held)
    ) {
      held.focus();
    }
    onMoved?.();
    return () => layer.remove();
  };

/**
 * Puts `panel` on top of the open dialogs, and returns what takes it off. Call it from the
 * effect that sees the panel mount, beside `holdFocus`.
 */
export function enterLayer(panel: HTMLElement): () => void {
  open.push(panel);
  return () => {
    const at = open.lastIndexOf(panel);
    if (at !== -1) open.splice(at, 1);
  };
}

/** Whether `panel` is the dialog on top, which is the one keys are for. */
export const isTopmost = (panel: HTMLElement): boolean => open.at(-1) === panel;

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
