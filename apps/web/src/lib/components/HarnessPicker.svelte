<script lang="ts">
  /**
   * Which harness and which model the next run goes to: the composer's popover.
   *
   * **A popover on the composer, not a page.** It hangs off the compose box's own
   * trigger, is absolutely positioned over the Level 2 shell and takes nothing from it:
   * no route, no change to the sidebar, the page frame or the detail panel. Opening it
   * must not move a pixel of what is behind it, which is why it is `position: absolute`
   * out of a `position: relative` trigger rather than anything that participates in the
   * composer's layout.
   *
   * ## What is here, and what is in `HarnessChoice`
   *
   * **This file is the popover.** The trigger, the dismiss scrim, the floating panel, the
   * Tab wrap that keeps focus inside it, and which state fills the third column —
   * reasoning depth, rendered by `ModelOptionsColumn` from the run's own options on `App`.
   *
   * **The columns are `HarnessChoice`'s**, shared with the Auto-load page, which
   * asks the same question in an inline block. That component's header records what the
   * two copies had already drifted on before they were one: whether an unusable harness
   * stayed selectable with its reason, whether the rail appeared at all with one harness
   * configured, and two identical copies of the filter. Popover versus inline justifies
   * two shells; it does not justify two instance rails.
   *
   * The instance a run would go to stays this caller's: `app.pickedInstance` resolves
   * through the server's *default* instance, which is a run's rule and not an import's.
   *
   * ## What is deliberately not here
   *
   * T3Code's picker serves a dozen providers and has the furniture to match: a favorites
   * group, a legacy-model section, a virtualized list, multi-model fan-out and number-key
   * shortcuts. None of that is here. Two instances do not need a favourites group to find
   * one of them, nothing is legacy because nothing has shipped, a list of this length does
   * not need windowing, and running one prompt on several models at once is a different
   * feature with its own provenance questions.
   */
  import Badge from "./Badge.svelte";
  import HarnessChoice from "./HarnessChoice.svelte";
  import ModelOptionsColumn from "./ModelOptionsColumn.svelte";
  import { IconAngleDown } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let panel = $state<HTMLElement | null>(null);

  /**
   * The instance whose models the right pane is showing.
   *
   * The *picked* one, resolved through the server's default — so a picker opened before
   * anything has been chosen highlights the instance a run would actually go to rather
   * than nothing.
   */
  let active = $derived(app.pickedInstance);

  /**
   * Tab wraps inside the panel; the arrows belong to the columns.
   *
   * The same wrap as `Modal.svelte`'s, for the same reason: a popover that let focus out
   * of it while open would leave the keyboard somewhere the operator cannot see. Escape
   * and the up/down walking are `HarnessChoice`'s, because they are about the rows rather
   * than about being a popover.
   */
  function onkeydown(event: KeyboardEvent) {
    if (!app.pickerOpen) return;
    if (event.key !== "Tab" || panel === null) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="picker">
  <button
    class="trigger"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={app.pickerOpen}
    onclick={() => app.togglePicker()}
  >
    {#if active !== undefined}
      <Badge name={active.displayName} size={16} />
      <span class="trigger-model mono">{app.effectiveModel}</span>
    {:else}
      <span class="trigger-model">No harness</span>
    {/if}
    <IconAngleDown class="trigger-chevron" width="11" height="11" />
  </button>

  {#if app.pickerOpen}
    <!--
      The scrim is transparent and sits under the panel: clicking anywhere outside closes
      the popover without the page having to listen on `document`, and without darkening
      the shell the way the modal's does. A popover is not a modal.
    -->
    <button
      class="dismiss"
      type="button"
      tabindex="-1"
      aria-label="Close the harness picker"
      onclick={() => (app.pickerOpen = false)}
    ></button>

    <div
      class="panel"
      role="dialog"
      aria-label="Choose a harness and model"
      bind:this={panel}
    >
      <HarnessChoice
        instances={app.harnesses}
        {active}
        model={app.effectiveModel}
        bind:query={app.modelQuery}
        onPickInstance={(instanceId) => app.pickInstance(instanceId)}
        onPickModel={(modelId) => app.pickModel(modelId)}
        onDismiss={() => (app.pickerOpen = false)}
      >
        {#snippet note()}
          An attempt is pinned to the harness it starts on. Changing harness
          starts a new attempt; it never moves this one.
        {/snippet}

        {#snippet options()}
          <!--
            The composer's because the composer is where a run's model options are set; the
            column itself is `ModelOptionsColumn`, shared with the importer's picker.
          -->
          <ModelOptionsColumn
            instance={active}
            model={app.effectiveModel}
            modelView={app.pickedModelView}
            descriptors={app.modelDescriptors}
            selections={app.pickedModelOptions}
            dropped={app.droppedModelOptions}
            onPick={(descriptorId, value) =>
              app.pickModelOption(descriptorId, value)}
          />
        {/snippet}
      </HarnessChoice>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: flex;
    /* A control on the composer's strip: it gives way before the submit button does. */
    min-width: 0;
  }
  /**
   * A control inside the compose box, not a field beside it.
   *
   * 28px tall, transparent, hover-only background: the same geometry as the other
   * controls on that strip, and no border of its own because it already sits inside the
   * composer's. The width cap is 220px — a model name is the longest thing on the strip
   * and it ellipsises rather than pushing the submit button off the edge.
   */
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    max-width: 220px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/var(--lh-compact) var(--font-sans);
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .trigger:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .trigger-model {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .picker :global(.trigger-chevron) {
    flex: none;
    color: var(--icon-muted);
  }
  /* Transparent, and only there to catch the click that closes the popover. */
  .dismiss {
    position: fixed;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  /**
   * The floating panel, and the height bound the columns resolve against.
   *
   * `max-height` is here and the clamp is explained in `HarnessChoice`: a single-line flex
   * container's cross size is resolved and then clamped, and the columns stretch to that,
   * which is what gives them a definite height to scroll inside.
   *
   * Opens rightwards from the trigger, which is where the trigger is: the composer puts it
   * at the left end of its control strip, and a panel right-aligned to it would run off
   * the left edge of the pane. The stacked layout takes over before the three columns can
   * reach the other edge.
   */
  .panel {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 1;
    display: flex;
    /* 196 + 240 + 184, plus the two 1px dividers between them. */
    width: 622px;
    max-height: 340px;
    overflow: hidden;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    /* Menus are floating; the modal is overlay (§6.6). */
    box-shadow: var(--elevation-floating);
    background: var(--bg-layer-01);
  }
  /*
    Narrow viewports: the panel narrows and `HarnessChoice` moves the rail above the other
    two columns (§3.5). 920px is where the columns stop fitting beside each other — the
    trigger sits about 280px in with the sidebar open, and 280 + 622 is the whole of a
    900px window.

    As wide as what is right of the trigger allows, up to 470px: under the rail the model
    list and the options column still share a row, and at the old 360px that row left a
    model name about 150px. `100vw - 310px` is the trigger's ~290px offset plus a margin,
    so the panel ends inside the window at 768px; the 360px floor is the old width, for a
    window narrower than the tablets this app is for.
  */
  @media (max-width: 920px) {
    .panel {
      width: min(92vw, clamp(360px, calc(100vw - 310px), 470px));
    }
  }
</style>
