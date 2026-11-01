<script lang="ts">
  import type { Snippet } from "svelte";
  import { IconClose } from "../icons";

  let {
    title,
    onclose,
    body,
    footer,
  }: {
    title: string;
    onclose: () => void;
    body: Snippet;
    footer: Snippet;
  } = $props();

  let panel = $state<HTMLElement | null>(null);

  /*
   * Focus goes *into* the dialog when it opens, onto the panel itself and no control.
   *
   * Without this, focus stays on whatever opened the dialog — behind the scrim — so Tab
   * walks the page underneath, and Enter re-activates the opener. Landing on the panel
   * rather than a button is deliberate: a dialog that focuses its confirm button turns
   * the Enter that opened it into the Enter that confirms it. The first Tab reaches the
   * first control.
   *
   * ## Where focus goes back to
   *
   * To the opener, if it still exists. The dialogs that matter most are the ones that
   * *delete the thing that opened them* — the `×` on an entry row is gone once the entry
   * is — and an opener that is no longer in the document cannot take focus, which leaves
   * it on `<body>` and the next Tab at the first control on the page, nowhere near where
   * the operator was.
   *
   * So a page that opens a dialog from something deletable marks a survivor with
   * `data-focus-fallback` (and `tabindex="-1"`, so it can take focus without becoming a
   * tab stop). The nearest marked ancestor of the opener is remembered when the dialog
   * opens, because by the time it closes the opener has no ancestors left to ask. If the
   * opener is gone, that ancestor gets focus instead; if there is none, behaviour is what
   * it was.
   *
   * **The marked ancestor can go too.** Deleting the last scope entry replaces both lists
   * with the empty state, so the list that was marked is as gone as the `×` was. The
   * dialog was opened from something marked, so the page has said it keeps a survivor
   * somewhere: the first one still in the document gets focus, which on that page is the
   * empty state, and is better than `<body>`.
   */
  $effect(() => {
    if (panel === null) return;
    const opener = document.activeElement;
    const fallback =
      opener instanceof Element
        ? opener.closest<HTMLElement>("[data-focus-fallback]")
        : null;
    if (!panel.contains(opener)) panel.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else if (fallback !== null && fallback.isConnected) fallback.focus();
      else if (fallback !== null) {
        document.querySelector<HTMLElement>("[data-focus-fallback]")?.focus();
      }
    };
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      onclose();
      return;
    }
    if (event.key !== "Tab" || panel === null) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
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
</script>

<svelte:window {onkeydown} />

<div class="scrim">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    bind:this={panel}
  >
    <header>
      <h2>{title}</h2>
      <button class="x" onclick={onclose} aria-label="Close">
        <IconClose width="12" height="12" />
      </button>
    </header>
    <div class="body">{@render body()}</div>
    <footer>{@render footer()}</footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--overlay-scrim);
    z-index: 50;
    animation: fade var(--dur-fade) ease-out;
  }
  .panel {
    width: min(100%, 560px);
    max-height: min(100%, 640px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xl);
    background: var(--bg-base);
    box-shadow: var(--elevation-overlay);
    animation: rise var(--dur-panel) var(--ease-panel);
  }
  /* A container that is focused so Tab starts inside it, not a control: no ring. */
  .panel:focus {
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border-muted);
  }
  h2 {
    margin: 0;
    font: 530 15px/20px var(--font-sans);
  }
  .x {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    font-size: 17px;
    cursor: pointer;
  }
  .x:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .body {
    padding: 18px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 18px;
    border-top: 1px solid var(--border-muted);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
  }
</style>
