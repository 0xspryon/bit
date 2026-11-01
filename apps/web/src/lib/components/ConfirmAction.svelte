<script lang="ts">
  /**
   * Asks before doing something the operator cannot take back from here.
   *
   * Nothing in it knows what is being confirmed: the title, the body, both button labels
   * and the tone arrive as props, so the next confirmation is a call site and not a
   * second dialog. It wraps {@link Modal}, which owns the scrim, the Escape key and the
   * Tab trap.
   *
   * ## What it will not do
   *
   * - **It never focuses the confirm button.** Modal puts focus on the panel, so the
   *   first Tab reaches the first control and Enter does nothing until then. The Enter
   *   that opened a dialog must not be able to finish it.
   * - **Its focus ring is the global one.** Focus is not a severity signal, so a danger
   *   confirm gets the same ring as every other control and no red outline of its own.
   * - **A working confirm is `aria-disabled`, not `disabled`.** It stays focusable, so
   *   focus is not dropped onto the page behind the scrim while the request runs, but it
   *   ignores clicks. Escape, the close button and Cancel are ignored while it works: the
   *   request is already on its way, and a dialog that closed would only hide it.
   *
   * ## The confirm button's states
   *
   * One fill and four overlays. Hover and pressed darken the fill with ink at 12% and
   * 21%; the working state dims it and swaps the label. The overlay is drawn with an
   * inset shadow so the fill itself never changes and the label stays crisp.
   */
  import type { Snippet } from "svelte";

  import Modal from "./Modal.svelte";

  let {
    title,
    body: content,
    confirmLabel,
    workingLabel,
    cancelLabel = "Cancel",
    tone = "neutral",
    working = false,
    icon,
    onconfirm,
    oncancel,
  }: {
    /** The question. Also the dialog's accessible name. */
    title: string;
    /** What the action costs, in plain words. */
    body: Snippet;
    /** The confirm button at rest: "Delete entry". */
    confirmLabel: string;
    /** The confirm button while the request runs: "Deleting…". */
    workingLabel: string;
    cancelLabel?: string;
    /** `danger` for the solid red confirm; `neutral` for the inverse one. */
    tone?: "danger" | "neutral";
    working?: boolean;
    /** A glyph before the confirm label. Replaced by a spinner while working. */
    icon?: Snippet;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  function cancel() {
    if (!working) oncancel();
  }

  function confirm() {
    if (!working) onconfirm();
  }
</script>

<Modal {title} onclose={cancel}>
  {#snippet body()}
    {@render content()}
  {/snippet}

  {#snippet footer()}
    <button
      type="button"
      class="action cancel"
      disabled={working}
      onclick={cancel}
    >
      {cancelLabel}
    </button>
    <button
      type="button"
      class={["action", "confirm", tone]}
      aria-disabled={working}
      onclick={confirm}
    >
      {#if working}
        <span class="spinner" aria-hidden="true"></span>
      {:else if icon}
        <span class="glyph" aria-hidden="true">{@render icon()}</span>
      {/if}
      <span>{working ? workingLabel : confirmLabel}</span>
    </button>
  {/snippet}
</Modal>

<style>
  /* Both buttons share one geometry: no size trick nudging the operator either way. */
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 32px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    box-sizing: border-box;
    font: 500 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .cancel {
    border-color: var(--border-base);
    background: transparent;
    color: var(--text-base);
  }
  .cancel:hover:not(:disabled) {
    background: var(--overlay-hover);
  }
  .cancel:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /*
   * The only solid object on the dialog. `--ink` is what the overlays are made of: black
   * over the red fill, and the label colour over the inverse one, so each darkens or
   * lightens away from its own fill.
   */
  .confirm {
    --ink: #000;
    border-color: transparent;
  }
  .confirm.danger {
    background: var(--state-fg-danger);
    color: var(--bg-base);
  }
  .confirm.neutral {
    --ink: var(--text-inverse);
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .confirm:hover:not([aria-disabled="true"]) {
    box-shadow: inset 0 0 0 999px
      color-mix(in srgb, var(--ink) 12%, transparent);
  }
  .confirm:active:not([aria-disabled="true"]) {
    box-shadow: inset 0 0 0 999px
      color-mix(in srgb, var(--ink) 21%, transparent);
  }
  .confirm[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .glyph {
    display: inline-flex;
    flex: none;
  }
  .spinner {
    flex: none;
    width: 13px;
    height: 13px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
