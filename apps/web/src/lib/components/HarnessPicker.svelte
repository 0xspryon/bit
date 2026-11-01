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
   * Tab wrap that keeps focus inside it, and the third column's contents — reasoning
   * depth, which is this screen's to offer because the composer is where a run's model
   * options are set.
   *
   * **The columns are `HarnessChoice`'s**, shared with the create-target screen, which
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
  import { displayedModelOption } from "@bit/contracts";

  import Badge from "./Badge.svelte";
  import HarnessChoice from "./HarnessChoice.svelte";
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
            What the *model* offers, which on both harnesses today is how hard it should
            think. Not a third kind of identity — a run is pinned to an instance and a
            model, and this is a setting *of* the model — which is why it is a column of
            the same popover rather than a control of its own on the composer, and why it
            changes under the model selection rather than beside it.

            It is the composer's and not the importer's: `@bit/contracts`'s
            `modelOption.ts` holds the rules for what survives a model change, and the
            create-target screen has no model options to carry.
          -->
          <p class="rail-label">Reasoning</p>

          {#if active === undefined}
            <p class="models-empty">Nothing to choose from.</p>
          {:else if app.pickedModelView === undefined}
            <!--
              A model an operator named that this instance's catalogue does not list. It
              may still run — whether a model runs is the harness's answer — but nothing is
              known about what it offers, and offering controls on a guess is the one thing
              this column must not do.
            -->
            <p class="models-empty">
              This server's catalogue does not list <span class="mono"
                >{app.effectiveModel}</span
              >, so what it offers is unknown. A run on it is still the
              harness's to accept or refuse.
            </p>
          {:else if app.modelDescriptors.length === 0}
            <p class="models-empty">
              <span class="mono">{app.effectiveModel}</span> offers nothing to choose
              beyond itself.
            </p>
          {:else}
            {#each app.modelDescriptors as descriptor (descriptor.id)}
              {@const shown = displayedModelOption(
                descriptor,
                app.pickedModelOptions,
              )}
              <p class="option-label">
                {descriptor.label}
                <!--
                  The harness's own id for the option, shown rather than hidden: it is what
                  travels with the run, and `effort` against `variant` is the difference
                  between the two harnesses rather than a detail.
                -->
                <span class="option-id mono">{descriptor.id}</span>
              </p>

              {#if !shown.known}
                <!--
                  Rule 4 in `modelOption.ts`: an obsolete value is shown *as itself*,
                  marked unknown, and deliberately not relabelled as what the run would
                  fall back to. The fallback is stated separately so the operator can read
                  both facts instead of inferring one from the other.
                -->
                <p class="option-stale">
                  <span class="mono">{shown.label}</span> is set here and this model
                  does not offer it. A run would use this option's default instead.
                </p>
              {/if}

              <ul class="option-list">
                {#each descriptor.options as choice (choice.id)}
                  <li>
                    <button
                      class="option-row"
                      class:selected={shown.known && choice.id === shown.value}
                      type="button"
                      aria-pressed={shown.known && choice.id === shown.value}
                      onclick={() =>
                        app.pickModelOption(descriptor.id, choice.id)}
                    >
                      <span class="option-name">{choice.label}</span>
                      {#if choice.isDefault === true}
                        <span class="model-tag">default</span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/each}

            {#if app.droppedModelOptions.length > 0}
              <!--
                Said out loud rather than dropped quietly. T3Code's version of this
                resolution has no such signal, so a setting that stops applying is
                indistinguishable from one never made; this product loses information
                loudly or not at all.
              -->
              <p class="option-dropped">
                Not offered by this model, so it will not be sent:
                <span class="mono">{app.droppedModelOptions.join(", ")}</span>.
              </p>
            {/if}

            <p class="models-note">
              Only what you set here is sent. A model left on its default is
              sent nothing, so the harness applies its own.
            </p>
          {/if}
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
    The third column's own type, which is this file's because the markup is. The column
    element and its scrolling belong to `HarnessChoice`; everything inside it is here.
  */
  .rail-label {
    margin: 0 0 4px 4px;
    color: var(--text-faint);
    font: 600 11px/var(--lh-compact) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .models-empty {
    margin: 0;
    padding: 4px;
    color: var(--text-faint);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .option-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    margin: 6px 0 4px 4px;
    color: var(--text-muted);
    font: 530 11px/var(--lh-compact) var(--font-sans);
  }
  .option-id {
    color: var(--text-faint);
    font-size: 10px;
  }
  .option-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .option-row {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-base);
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .option-row:hover {
    background: var(--overlay-hover);
  }
  .option-row.selected {
    background: var(--overlay-pressed);
  }
  .option-name {
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .model-tag {
    margin-left: 4px;
    color: var(--text-faint);
    font: 400 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /*
    Amber, like an unavailable target's reason: a setting that will not take effect is the
    same kind of fact as a target that will not open, and this app spends colour only on
    state (§9). Never colour alone — both of these say what is wrong in words.
  */
  .option-stale,
  .option-dropped {
    margin: 4px 0 6px;
    padding: 6px 8px;
    border: 1px solid var(--state-border-warning);
    border-radius: var(--radius-sm);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .models-note {
    margin: 6px 0 0;
    color: var(--text-faint);
    font-size: 11px;
    line-height: var(--lh-compact);
  }

  /*
    Narrow viewports: the panel narrows and `HarnessChoice` stacks its own columns (§3.5).
    920px is where the columns stop fitting beside each other — the trigger sits about
    280px in with the sidebar open, and 280 + 622 is the whole of a 900px window.
  */
  @media (max-width: 920px) {
    .panel {
      width: min(92vw, 360px);
    }
  }
</style>
