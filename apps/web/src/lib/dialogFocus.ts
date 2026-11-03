/**
 * Where focus goes while a modal dialog is open, and where it goes back to.
 *
 * `Modal`'s rules, out of `Modal` so that a dialog with a different body can keep them
 * without a second copy. `HarnessDialog` is the other caller: the harness picker as a
 * modal, whose columns have no title bar or footer for `Modal` to draw. Two dialogs with
 * their own focus code are two dialogs that will come to disagree about it, which is the
 * drift `HarnessChoice`'s header records between two copies of one set of columns.
 *
 * ## Into the dialog
 *
 * Without it, focus stays on whatever opened the dialog — behind the scrim — so Tab walks
 * the page underneath, and Enter re-activates the opener. Focus lands on the panel itself
 * and no control, unless something inside has already taken it: a dialog that focuses its
 * confirm button turns the Enter that opened it into the Enter that confirms it, but a
 * dialog whose body focuses its own filter field has chosen a field, and taking that back
 * to the panel would undo the choice.
 *
 * ## Back out of it
 *
 * To the opener, if it still exists. The dialogs that matter most are the ones that
 * *delete the thing that opened them* — the `×` on an entry row is gone once the entry
 * is — and an opener that is no longer in the document cannot take focus, which leaves it
 * on `<body>` and the next Tab at the first control on the page, nowhere near where the
 * operator was.
 *
 * So a page that opens a dialog from something deletable marks a survivor with
 * `data-focus-fallback` (and `tabindex="-1"`, so it can take focus without becoming a tab
 * stop). The nearest marked ancestor of the opener is remembered when the dialog opens,
 * because by the time it closes the opener has no ancestors left to ask. If the opener is
 * gone, that ancestor gets focus instead; if there is none, behaviour is what it was.
 *
 * **The marked ancestor can go too.** Deleting the last scope entry replaces both lists
 * with the empty state, so the list that was marked is as gone as the `×` was. The dialog
 * was opened from something marked, so the page has said it keeps a survivor somewhere:
 * the first one still in the document gets focus, which on that page is the empty state,
 * and is better than `<body>`.
 *
 * **The opener can be named.** It is otherwise whatever has focus when the dialog's effect
 * runs, and that is not always the control that opened it: a child's effect runs first and
 * may have focused something inside, and Safari does not focus a button on click, so a
 * dialog opened by pointer there finds `<body>`. A caller that knows its trigger passes it.
 */

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Moves focus into `panel` and returns what puts it back. Call it from the `$effect` that
 * sees the panel mount, and return its result as the effect's teardown. `named` is the
 * opener when the caller knows it; otherwise it is whatever has focus now.
 */
export function holdFocus(
  panel: HTMLElement,
  named: Element | null = null,
): () => void {
  const opener = named ?? document.activeElement;
  const fallback =
    opener instanceof Element
      ? opener.closest<HTMLElement>("[data-focus-fallback]")
      : null;
  if (!panel.contains(document.activeElement)) panel.focus();
  return () => {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    else if (fallback !== null && fallback.isConnected) fallback.focus();
    else if (fallback !== null) {
      document.querySelector<HTMLElement>("[data-focus-fallback]")?.focus();
    }
  };
}

/**
 * Keeps Tab inside `panel`: past the last control is the first, before the first (or the
 * panel itself, where focus starts) is the last. A modal that let focus out would leave the
 * keyboard on a page the scrim says cannot be used.
 */
export function wrapTab(event: KeyboardEvent, panel: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === panel)
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
