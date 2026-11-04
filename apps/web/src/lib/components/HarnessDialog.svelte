<script lang="ts">
  /**
   * The harness and model question asked as a modal: a scrim, a centred panel, and
   * {@link HarnessChoice}'s columns inside it, as they are anywhere else.
   *
   * ## Why not `Modal`
   *
   * `Modal` is a titled card: a heading and a close button over a padded body, a footer of
   * actions under it, 560px wide. The picker's columns are not a padded body — they run to
   * the panel's edges, each scrolling on its own — and D6's frame is its own: a header row
   * with its title and a close button ({@link title}), the columns, and D6's footer when the
   * picks are staged, at D6's 820px. Putting them in `Modal` would have been a redesign of
   * the picker, which is the one thing its move to a modal was not to be.
   *
   * What `Modal` does that matters here is focus, and that is shared rather than redone:
   * `dialogFocus` holds both dialogs' rules for where focus goes in and where it comes back
   * to. The scrim is a **copy** of `Modal`'s — its rule and both keyframes — not a shared
   * one; see the note on `.scrim` for why, and for what has to change in both places.
   *
   * ## What differs from `Modal`
   *
   * - **A click on the scrim closes it.** `Modal`'s does not, because its dialogs hold a
   *   form or a question about deleting something, and a stray click should lose neither.
   *   Nothing here is lost by closing: every pick has already been made.
   * - **Focus starts in the filter, not on the panel.** That is `HarnessChoice`'s choice,
   *   and `holdFocus` leaves it alone.
   * - **The opener is named** by the caller rather than read from `document.activeElement`.
   *   By the time this component's effect runs, `HarnessChoice`'s — a child's, so first —
   *   has already moved focus into the filter, which is gone once the dialog is; and Safari
   *   does not focus a button on click, so even read earlier it could be `<body>`.
   *
   * Escape is here rather than `HarnessChoice`'s `onDismiss`: closing is about being a
   * dialog, and a caller that passed both would close twice.
   *
   * ## It renders at the end of `<body>`, not where it is written
   *
   * Its callers write it beside their trigger, and the importer's trigger is inside the
   * composer's `<form>`. A dialog left there is a descendant of a form it is not part of:
   * the filter is an `<input>` whose form owner is the composer, so Enter in it was an
   * implicit submission and sent the operator's draft — from a panel whose `aria-modal`
   * says the page behind it is inert. The same nesting puts it inside whatever containing
   * block or stacking context an ancestor makes, which `position: fixed` does not escape.
   *
   * So the layer is moved to `<body>`, and it is moved rather than guarded: a guard on the
   * filter's Enter covers one control, and the next input or submit button anyone puts in
   * the columns would have the composer as its form owner again. Out of the form, nothing
   * in the dialog has one, whatever the columns grow. Two details make the move safe:
   *
   * - **The root stays where it was written.** Svelte removes a block by walking its nodes
   *   from first to last sibling, so a moved *root* would send that walk off through
   *   whatever followed it. The root is an empty, `hidden` origin that never moves; only
   *   the layer inside it does, and the attachment that moved it removes it.
   * - **The panel is rendered after the move, not before.** Moving a node that holds focus
   *   blurs it, and `HarnessChoice` focuses its filter in its first effect — which runs
   *   before this component's attachment does. So nothing is in the layer until it is in
   *   `<body>`.
   *
   * The move is `dialogLayer`'s `toBody`, which `Modal` uses too — so a dialog opened from
   * inside this one (a refusal of a pick, while the picker stays open) is later in `<body>`
   * and drawn on top of it, and only the dialog on top answers Escape and Tab.
   *
   * Nothing else about the dialog depends on where it is: Svelte also listens for its
   * delegated events on `document` for exactly this case, the design tokens are on
   * `:root`, the focus trap is the panel's own, and focus goes back to the named opener
   * wherever that is.
   *
   * ## Why this is a component of its own
   *
   * The run composer's `HarnessPicker` asks the same question in the popover this replaced
   * on the importer. If it becomes a modal too, it is this — so the panel's size and the
   * narrow-window rule live once, here, and moving it is swapping its scrim and panel for
   * this element.
   */
  import { untrack, type Snippet } from "svelte";
  import { holdFocus } from "../dialogFocus";
  import { dialogKeydown, enterLayer, toBody } from "../dialogLayer";
  import { IconClose } from "../icons";

  let {
    onclose,
    opener,
    title,
    children,
    footer,
  }: {
    /** Escape, or a click outside the panel. */
    onclose: () => void;
    /** The control that opened the dialog, which focus returns to when it closes. */
    opener: HTMLElement | null;
    /**
     * D6's header row: this title and a close button over the columns. Absent, the panel
     * starts with the columns, as the popover did.
     */
    title?: string;
    children: Snippet;
    /**
     * D6's footer under the columns: a note and the actions, for a picker whose picks are
     * staged and applied together ("Use for this session") rather than taking effect as
     * they are made. Absent, the panel is the columns alone, as before.
     */
    footer?: Snippet;
  } = $props();

  let panel = $state<HTMLElement | null>(null);
  /** Whether the layer is in `<body>` yet, which is when the panel may render into it. */
  let moved = $state(false);

  /** Moves the layer to the end of `<body>`, and takes it away with the dialog. */
  const toBodyThenRender = toBody(() => (moved = true));

  // Only the panel mounting is a reason to run this: re-running it would restore focus
  // to the opener and take it back again while the dialog was still open. A dialog drawn
  // over this one waits for it to take focus first; see `dialogLayer`.
  $effect(() => {
    if (panel === null) return;
    const mounted = panel;
    return untrack(() => enterLayer(mounted, () => holdFocus(mounted, opener)));
  });
</script>

<svelte:window onkeydown={(event) => dialogKeydown(event, panel, onclose)} />

<!--
  The origin stays where the caller wrote the dialog and is empty once the layer has moved:
  see "It renders at the end of `<body>`" above.
-->
<div class="origin" hidden>
  <div class="layer" {@attach toBodyThenRender}>
    {#if moved}
      <div class="scrim">
        <!--
          The outside of the panel, as a control: a click anywhere on the scrim closes
          without a listener on `document`. Out of the tab order because Escape is the
          keyboard's way out.
        -->
        <button
          class="dismiss"
          type="button"
          tabindex="-1"
          aria-label="Close the harness picker"
          onclick={onclose}
        ></button>
        <div
          class={[
            "panel",
            footer !== undefined && "with-footer",
            title !== undefined && "framed",
          ]}
          role="dialog"
          aria-modal="true"
          aria-label="Choose a harness and model"
          tabindex="-1"
          bind:this={panel}
        >
          {#if title !== undefined}
            <div class="header">
              <h2 class="title">{title}</h2>
              <button
                class="close"
                type="button"
                aria-label="Close"
                onclick={onclose}
              >
                <IconClose width="14" height="14" />
              </button>
            </div>
          {/if}
          {#if footer === undefined && title === undefined}
            {@render children()}
          {:else}
            <div class="columns">{@render children()}</div>
            {#if footer !== undefined}
              <div class="footer">{@render footer()}</div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* In `<body>` it is one more child of a block box; it should not be a box at all. */
  .layer {
    display: contents;
  }
  /*
   * A copy of `Modal`'s scrim, kept the same so both kinds of dialog say "the page is held"
   * the same way — and a copy, so a change to one is a change to make to the other, along
   * with the two keyframes at the bottom. What carries the look is already shared: colour,
   * timing and easing are the `--overlay-scrim`, `--dur-fade`, `--dur-panel` and
   * `--ease-panel` tokens. What is copied is the fixed, centred grid and its padding, which
   * Svelte's scoped styles give no way to share short of a global class — the one kind of
   * rule this codebase keeps for utilities like `.visually-hidden` — or a scrim component
   * that `Modal` would have to be rebuilt on. Neither is worth it for nine lines that only
   * change when a dialog's layout does.
   */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    padding: 24px;
    background: var(--overlay-scrim);
    animation: fade var(--dur-fade) ease-out;
  }
  .dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  /*
   * The popover's panel, unchanged but for where it sits and its shadow: the same width,
   * border, radius and surface, so the columns inside render as they did. The shadow is
   * the overlay elevation because this is now an overlay rather than a menu (§6.6).
   *
   * `max-height` is the bound `HarnessChoice` resolves its scrolling against (its header
   * explains the clamp). 340 is the popover's number; `100%` keeps the panel inside a
   * window too short for it, which matters less centred than anchored to a chip — the
   * popover's extra arm for the room above the chip is gone with the chip.
   */
  .panel {
    position: relative;
    display: flex;
    /* 196 + 240 + 184, plus the two 1px dividers between them. */
    width: 622px;
    max-width: 100%;
    max-height: min(100%, 340px);
    overflow: hidden;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    box-shadow: var(--elevation-overlay);
    background: var(--bg-layer-01);
    animation: rise var(--dur-panel) var(--ease-panel);
  }
  /*
   * With D6's footer the panel is a column: the three columns over the footer, the columns
   * taking what the footer leaves. 400 rather than 340 so the columns keep the height they
   * had without one.
   */
  .panel.with-footer {
    flex-direction: column;
    max-height: min(100%, 400px);
  }
  /*
   * D6's frame: the header row over the columns, at D6's width (820px, the scrim's padding
   * keeping it inside a window narrower than that), and the strong border D6 draws it with.
   * The columns keep their own widths; the model list takes what the wider panel adds. The
   * height bounds grow by the header's 47px so the columns keep the height they had.
   */
  .panel.framed {
    flex-direction: column;
    width: 820px;
    max-height: min(100%, 388px);
    border-color: var(--border-strong);
    border-radius: var(--radius-xl);
  }
  .panel.framed.with-footer {
    max-height: min(100%, 448px);
  }
  .header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border-base);
  }
  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--text-base);
    font: 530 14px/20px var(--font-sans);
  }
  .close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .close:hover {
    background: var(--overlay-hover);
    color: var(--icon-base);
  }
  .close:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .columns {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  /* D6: a hairline over it, the page's own surface, the note and the actions on one line. */
  .footer {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-top: 1px solid var(--border-base);
    background: var(--bg-base);
  }
  /* A container that is focused so Tab starts inside it, not a control: no ring. */
  .panel:focus {
    outline: none;
  }
  /*
   * Narrow windows: `HarnessChoice` stacks the rail above the other two columns at 920px,
   * and its stacked layout was measured against 470px. Centred, nothing but the window
   * limits it, so the popover's offset-from-the-trigger arithmetic is not needed.
   */
  @media (max-width: 920px) {
    .panel,
    .panel.framed {
      width: 470px;
    }
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
