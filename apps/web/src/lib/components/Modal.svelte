<script lang="ts">
  /**
   * The titled card every form and question dialog is drawn in: a scrim, a heading, a
   * padded body and a footer of actions. It owns the Escape key and the Tab trap, and takes
   * its focus rules from `dialogFocus`.
   *
   * It renders at the end of `<body>`, not where it is written, and answers keys only while
   * it is the dialog on top: both are `dialogLayer`'s, shared with `HarnessDialog`, so a
   * dialog opened from inside another is drawn over it and one Escape closes only it.
   *
   * The options below exist for {@link ErrorDialog}, which is this card saying "the server
   * refused that" rather than asking anything. Every one defaults to what the form and
   * question dialogs already had, so they are unchanged by it.
   */
  import { untrack, type Snippet } from "svelte";
  import { holdFocus } from "../dialogFocus";
  import { dialogKeydown, enterLayer, toBody } from "../dialogLayer";
  import { IconClose } from "../icons";

  let {
    title,
    onclose,
    body,
    footer,
    role = "dialog",
    describedby,
    scrimCloses = false,
    closeButton = true,
    width = 560,
    opener = null,
  }: {
    /** The heading, and the dialog's accessible name. */
    title: string;
    onclose: () => void;
    body: Snippet;
    footer: Snippet;
    /**
     * `alertdialog` for a dialog that interrupts to say something went wrong, so a screen
     * reader announces it as urgent; `dialog` for everything that asks or collects.
     */
    role?: "dialog" | "alertdialog";
    /** The id of the element in `body` that is the dialog's message, for `aria-describedby`. */
    describedby?: string;
    /**
     * Whether a click on the scrim closes it. Off by default: a form or a question about
     * deleting something should not be lost to a stray click. A dialog that holds nothing
     * to lose — `HarnessDialog`, `ErrorDialog` — turns it on.
     */
    scrimCloses?: boolean;
    /** The header's ×. A dialog whose footer is its one way out leaves it off. */
    closeButton?: boolean;
    /** The panel's width in px, before the window narrows it. */
    width?: number;
    /**
     * The control that opened it, when the caller knows. Otherwise it is whatever has focus
     * as the dialog mounts, which for a refusal that arrives after a request is not always
     * the control that sent it: see `dialogFocus`, "The opener can be named".
     */
    opener?: HTMLElement | null;
  } = $props();

  let panel = $state<HTMLElement | null>(null);

  /*
   * Focus goes into the dialog when it opens, onto the panel itself and no control, and
   * back to the opener — or to a marked survivor when the opener was deleted — when it
   * closes. Both rules, and why each is the way it is, are `dialogFocus`'s, shared with the
   * harness picker's dialog so the two cannot drift. Focus goes in only once every dialog
   * drawn under this one has taken it, which `dialogLayer` orders.
   */
  $effect(() => {
    if (panel === null) return;
    const mounted = panel;
    // Only the panel mounting is a reason to run this; a new `opener` is not.
    return untrack(() => enterLayer(mounted, () => holdFocus(mounted, opener)));
  });
</script>

<svelte:window onkeydown={(event) => dialogKeydown(event, panel, onclose)} />

<!--
  The origin stays where the caller wrote the dialog; the layer inside it moves to the end
  of `<body>` as it mounts. See `dialogLayer`.
-->
<div class="origin" hidden>
  <div class="layer" {@attach toBody()}>
    <div class="scrim">
      {#if scrimCloses}
        <!--
      The outside of the panel, as a control, as `HarnessDialog` draws it: out of the tab
      order, because Escape is the keyboard's way out.
    -->
        <button
          class="dismiss"
          type="button"
          tabindex="-1"
          aria-label="Close"
          onclick={onclose}
        ></button>
      {/if}
      <div
        class="panel"
        {role}
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedby}
        tabindex="-1"
        style:--modal-width={`${width}px`}
        bind:this={panel}
      >
        <header>
          <h2>{title}</h2>
          {#if closeButton}
            <button
              class="x"
              type="button"
              onclick={onclose}
              aria-label="Close"
            >
              <IconClose width="12" height="12" />
            </button>
          {/if}
        </header>
        <div class="body">{@render body()}</div>
        <footer>{@render footer()}</footer>
      </div>
    </div>
  </div>
</div>

<style>
  /* In `<body>` it is one more child of a block box; it should not be a box at all. */
  .layer {
    display: contents;
  }
  /*
   * One row, as tall as the window less the padding, and no taller: a grid row otherwise
   * grows to its content, and then the panel's `max-height: 100%` is a percentage of a
   * panel-sized row and never binds — a long body pushed the footer, and its one way out,
   * off the bottom of the window. `minmax(0, …)` lets the row be shorter than the panel's
   * content, so the panel is the one that gives, and its body scrolls.
   */
  .scrim {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    padding: 24px;
    background: var(--overlay-scrim);
    z-index: 50;
    animation: fade var(--dur-fade) ease-out;
  }
  .dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  .panel {
    position: relative;
    width: min(100%, var(--modal-width));
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
