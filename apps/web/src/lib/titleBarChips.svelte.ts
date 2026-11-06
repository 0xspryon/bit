/**
 * Chips a chat places in the app's title bar, beside the session chip (A6 prep for A7-S).
 *
 * E8's "N sub-agents" chip is about the whole session and sits in the crumb bar's right
 * cluster, between the context meter and the session chip — the same bar the importer's
 * meter is in — not in a row inside the chat. The title bar and the chat are siblings on
 * the page (`+page.svelte` mounts `TitleBar` beside the screen), so neither can hand the
 * other a snippet. This is the seam: the page provides one {@link TitleBarChips}, the title
 * bar draws whatever is placed in it ({@link TitleBarChipSlot}), and a chat places its chip
 * for as long as it is mounted (`ChatShell`'s `chip`).
 *
 * A snippet keeps its own component's scope wherever it is rendered, so the chip stays the
 * chat's: its state, its click and the panel it opens (the shell's `aside`) are the chat's,
 * and the bar only says where it goes. Nothing is placed today; A7-S builds the chip.
 */
import { createContext, untrack, type Snippet } from "svelte";

/** What the title bar holds: the chips placed in it, oldest first. */
export class TitleBarChips {
  placed = $state<readonly { readonly id: number; readonly chip: Snippet }[]>(
    [],
  );
  #next = 0;

  /**
   * Places `chip` in the bar and returns what takes it away again. Untracked, so a caller's
   * `$effect` that places a chip does not also depend on what is already placed.
   */
  place(chip: Snippet): () => void {
    const id = this.#next++;
    untrack(() => {
      this.placed = [...this.placed, { id, chip }];
    });
    return () => {
      untrack(() => {
        this.placed = this.placed.filter((each) => each.id !== id);
      });
    };
  }
}

const [getChips, setChips, hasChips] = createContext<TitleBarChips>();

/** The page's one holder, given to the title bar and every chat under it. */
export const provideTitleBarChips = (): TitleBarChips =>
  setChips(new TitleBarChips());

/**
 * The holder a page provided, or `undefined` where none did — a component mounted alone, as
 * the DOM suite mounts `TitleBar` and the screens side by side. A chip placed there is drawn
 * nowhere, which is the honest result of a page with no title bar.
 */
export const titleBarChips = (): TitleBarChips | undefined =>
  hasChips() ? getChips() : undefined;
