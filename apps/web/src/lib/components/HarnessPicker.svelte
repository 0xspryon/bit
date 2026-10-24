<script lang="ts">
  /**
   * Which harness and which model the next run goes to.
   *
   * **A popover on the composer, not a page.** It hangs off the compose box's own
   * trigger, is absolutely positioned over the Level 2 shell and takes nothing from it:
   * no route, no change to the sidebar, the page frame or the detail panel. Opening it
   * must not move a pixel of what is behind it, which is why it is `position: absolute`
   * out of a `position: relative` trigger rather than anything that participates in the
   * composer's layout.
   *
   * **The instance rail on the left, a searchable model list on the right.** The rail is
   * short — two drivers, one configured instance each — so it is a list and not a tree,
   * and the model list is long enough on OpenCode to need a filter.
   *
   * ## What is deliberately not here
   *
   * T3Code's picker serves a dozen providers and has the furniture to match: a favorites
   * group, a legacy-model section, a virtualized list, multi-model fan-out and number-key
   * shortcuts. None of that is here. Two instances do not need a favourites group to find
   * one of them, nothing is legacy because nothing has shipped, a list of this length does
   * not need windowing, and running one prompt on several models at once is a different
   * feature with its own provenance questions.
   *
   * ## Visible is not the same as offered
   *
   * An instance that is configured and unusable **stays in the rail**, dimmed, carrying
   * the harness's own sentence about why and what to do about it. That is the product's
   * rule everywhere else and it is the rule that makes the picker worth having: a harness
   * that silently vanished would leave an operator with nothing to act on. Selecting one
   * is refused rather than hidden, so the reason is read where the choice is made.
   *
   * The badge treatment is the target badge's, doing duty as the instance avatar: the same
   * monochrome square with a mono letter, because the identity here is a name rather than
   * a colour (tokens.css, and §6.4 reduced to neutral tones).
   */
  import Badge from "./Badge.svelte";
  import { IconSearch } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let panel = $state<HTMLElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);

  /**
   * The instance whose models the right pane is showing.
   *
   * The *picked* one, resolved through the server's default — so a picker opened before
   * anything has been chosen highlights the instance a run would actually go to rather
   * than nothing.
   */
  let active = $derived(app.pickedInstance);

  let models = $derived.by(() => {
    const all = active?.models ?? [];
    const query = app.modelQuery.trim().toLowerCase();
    return query === ""
      ? all
      : all.filter((name) => name.toLowerCase().includes(query));
  });

  /**
   * Focus into the filter when the popover opens.
   *
   * The reason it is the filter and not the first row: the rail is two entries an operator
   * can see at a glance, and the thing they came to type into is the search. Tab still
   * reaches everything, and Escape closes.
   */
  $effect(() => {
    if (app.pickerOpen) searchInput?.focus();
  });

  function onkeydown(event: KeyboardEvent) {
    if (!app.pickerOpen) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      app.pickerOpen = false;
      return;
    }
    if (event.key !== "Tab" || panel === null) return;
    // The same wrap as `Modal.svelte`'s, for the same reason: a popover that let focus
    // out of it while open would leave the keyboard somewhere the operator cannot see.
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
      <div class="rail" role="listbox" aria-label="Harness instances">
        <p class="rail-label">Harness</p>
        {#if app.harnesses.length === 0}
          <p class="rail-empty">
            This server configures no agent harness, so it will refuse every
            run.
          </p>
        {/if}
        {#each app.harnesses as instance (instance.instanceId)}
          <button
            class="rail-row"
            class:selected={instance.instanceId === active?.instanceId}
            class:unusable={!instance.ready}
            type="button"
            role="option"
            aria-selected={instance.instanceId === active?.instanceId}
            onclick={() => app.pickInstance(instance.instanceId)}
          >
            <Badge name={instance.displayName} size={20} />
            <span class="rail-text">
              <span class="rail-name">
                {instance.displayName}
                {#if instance.isDefault}
                  <span class="rail-tag">default</span>
                {/if}
              </span>
              <!--
                The version when it is usable, the reason when it is not. State is never
                colour alone here: the row is dimmed *and* says what is wrong (§9).
              -->
              <span class="rail-meta mono">
                {instance.ready ? instance.version : "unusable"}
              </span>
            </span>
          </button>
          {#if !instance.ready}
            <p class="rail-reason">
              {instance.reason ??
                "This server could not bring that harness up."}
              {#if instance.setup !== undefined}
                <span class="rail-setup">{instance.setup}</span>
              {/if}
            </p>
          {/if}
        {/each}
      </div>

      <div class="models">
        <div class="search-wrap">
          <IconSearch class="search-icon" width="13" height="13" />
          <input
            class="search"
            type="search"
            placeholder="Filter models"
            aria-label="Filter models"
            bind:this={searchInput}
            bind:value={app.modelQuery}
          />
        </div>

        {#if active === undefined}
          <p class="models-empty">Nothing to choose from.</p>
        {:else if !active.ready}
          <!--
            The models of an unusable instance are still listed: it is the same catalogue
            and hiding it would be a second way of saying what the rail already says.
            Picking one is pointless until the harness works, and the run is refused with
            the harness's own words rather than silently.
          -->
          <p class="models-empty">
            {active.displayName} is not usable on this server, so a run on it is refused.
            Its models are listed for reference.
          </p>
        {/if}

        <ul class="model-list">
          {#each models as model (model)}
            <li>
              <button
                class="model-row"
                class:selected={model === app.effectiveModel}
                type="button"
                onclick={() => app.pickModel(model)}
              >
                <span class="model-name mono">{model}</span>
                {#if model === active?.defaultModel}
                  <span class="model-tag">default</span>
                {/if}
              </button>
            </li>
          {/each}
          {#if active !== undefined && models.length === 0}
            <li class="no-results">
              <p>
                No model here matches that. This list is what the harness
                reported when this server started it, and an operator may still
                name one that is not on it — whether a model runs is the
                harness's answer.
              </p>
            </li>
          {/if}
        </ul>

        {#if active !== undefined}
          <p class="models-note">
            An attempt is pinned to the harness it starts on. Changing harness
            starts a new attempt; it never moves this one.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: flex;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 4px 8px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-muted);
    font: 400 11px/var(--lh-compact) var(--font-sans);
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .trigger:hover {
    background: var(--overlay-hover);
  }
  .trigger-model {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* Transparent, and only there to catch the click that closes the popover. */
  .dismiss {
    position: fixed;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }
  .panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 1;
    display: grid;
    grid-template-columns: 220px 260px;
    width: 480px;
    max-height: 340px;
    overflow: hidden;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    /* Menus are floating; the modal is overlay (§6.6). */
    box-shadow: var(--elevation-floating);
    background: var(--bg-layer-01);
  }
  .rail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    overflow-y: auto;
    border-right: 1px solid var(--border-base);
  }
  .rail-label {
    margin: 0 0 4px 4px;
    color: var(--text-faint);
    font: 600 11px/var(--lh-compact) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .rail-empty,
  .models-empty {
    margin: 0;
    padding: 4px;
    color: var(--text-faint);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .rail-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-base);
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .rail-row:hover {
    background: var(--overlay-hover);
  }
  .rail-row.selected {
    background: var(--overlay-pressed);
  }
  /* Dimmed, never removed, and the reason is rendered under it. */
  .rail-row.unusable {
    opacity: 0.62;
  }
  .rail-text {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .rail-name {
    font: 530 13px/var(--lh-compact) var(--font-sans);
  }
  .rail-tag,
  .model-tag {
    margin-left: 4px;
    color: var(--text-faint);
    font: 400 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .rail-meta {
    overflow: hidden;
    color: var(--text-faint);
    font-size: 10px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rail-reason {
    margin: 0 0 6px;
    padding: 6px 8px;
    border: 1px solid var(--state-border-warning);
    border-radius: var(--radius-sm);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .rail-setup {
    display: block;
    margin-top: 4px;
    color: var(--state-fg-warning);
  }
  .models {
    display: flex;
    min-width: 0;
    flex-direction: column;
    padding: 8px;
    overflow: hidden;
  }
  .search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-wrap :global(.search-icon) {
    position: absolute;
    left: 8px;
    color: var(--icon-muted);
    pointer-events: none;
  }
  .search {
    width: 100%;
    padding: 6px 8px 6px 26px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-base);
    font: 400 12px/var(--lh-compact) var(--font-sans);
  }
  .search::placeholder {
    color: var(--text-faint);
  }
  .model-list {
    flex: 1;
    margin: 6px 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .model-row {
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
  .model-row:hover {
    background: var(--overlay-hover);
  }
  .model-row.selected {
    background: var(--overlay-pressed);
  }
  .model-name {
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .no-results p,
  .models-note {
    margin: 6px 0 0;
    color: var(--text-faint);
    font-size: 11px;
    line-height: var(--lh-compact);
  }

  /* Narrow viewports: the two panes stack rather than overflowing the composer (§3.5). */
  @media (max-width: 560px) {
    .panel {
      right: auto;
      left: 0;
      grid-template-columns: 1fr;
      width: min(92vw, 360px);
    }
    .rail {
      border-right: 0;
      border-bottom: 1px solid var(--border-base);
    }
  }
</style>
