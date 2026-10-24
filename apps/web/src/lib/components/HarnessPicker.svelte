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
   * **A third column: what the model offers.** Reasoning depth, on both harnesses today.
   * It is a column of this popover rather than a control of its own on the composer
   * because it is a setting *of the model* — it changes when the model does, and it is
   * meaningless without one — and because the rules for what survives a model change are
   * only readable next to the thing being changed. `@bit/contracts`'s `modelOption.ts`
   * holds those rules; this file renders them.
   *
   * **All three columns scroll, and all three scroll by key as well as by wheel.**
   * OpenCode reports 28 models, which is more than 340px of rows, so the panel's height
   * bound has to land on the column rather than on the panel's clipped edge — see
   * `.panel` below for why that took a change of layout mode and not an `overflow`
   * declaration. Up and down walk the column the focus is in and bring the row they land
   * on just inside the edge.
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
  import { displayedModelOption } from "@bit/contracts";

  import Badge from "./Badge.svelte";
  import { IconAngleDown, IconSearch } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let panel = $state<HTMLElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let railColumn = $state<HTMLElement | null>(null);
  let modelColumn = $state<HTMLElement | null>(null);
  let optionColumn = $state<HTMLElement | null>(null);

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
      : all.filter((model) => model.id.toLowerCase().includes(query));
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

  /**
   * Arrow keys walk a column, and the row they land on is scrolled into view.
   *
   * Tab reaches every row on its own, and a browser scrolls what it focuses — but Tab
   * through 28 models to reach the 29th thing after them is not reachability, it is a
   * penalty for having a long catalogue. So each column takes its own up/down, and the
   * focus is moved with `preventScroll` and then scrolled with `block: "nearest"`: the
   * row comes just inside the edge rather than jumping to the middle, which is what
   * makes holding the key down readable.
   *
   * Clamped rather than wrapping. A list that jumps from the last model back to the first
   * reads as a loop the operator did not ask for, and the end of the list is information.
   */
  function stepRow(
    column: HTMLElement | null,
    selector: string,
    delta: number,
  ) {
    if (column === null) return;
    const rows = Array.from(
      column.querySelectorAll<HTMLButtonElement>(selector),
    );
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row === document.activeElement);
    const next =
      current === -1
        ? delta > 0
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, current + delta));
    const row = rows[next];
    if (row === undefined) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }

  function onkeydown(event: KeyboardEvent) {
    if (!app.pickerOpen) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      app.pickerOpen = false;
      return;
    }
    // Arrows belong to whichever column the focus is already in — the same window
    // handler as Escape and Tab rather than a listener per element, because a keydown
    // handler on a plain container is the thing the a11y lint is right to object to.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const focused = document.activeElement;
      if (
        optionColumn !== null &&
        focused !== null &&
        optionColumn.contains(focused)
      ) {
        event.preventDefault();
        stepRow(optionColumn, ".option-row", delta);
      } else if (
        modelColumn !== null &&
        focused !== null &&
        modelColumn.contains(focused)
      ) {
        event.preventDefault();
        stepRow(modelColumn, ".model-row", delta);
      } else if (
        railColumn !== null &&
        focused !== null &&
        railColumn.contains(focused)
      ) {
        event.preventDefault();
        stepRow(railColumn, ".rail-row", delta);
      }
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
      <div
        class="rail"
        role="listbox"
        aria-label="Harness instances"
        bind:this={railColumn}
      >
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

      <div class="models" bind:this={modelColumn}>
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
          {#each models as model (model.id)}
            <li>
              <button
                class="model-row"
                class:selected={model.id === app.effectiveModel}
                type="button"
                onclick={() => app.pickModel(model.id)}
              >
                <span class="model-name mono">{model.id}</span>
                {#if model.id === active?.defaultModel}
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

      <!--
        The third column: what the *model* on the left offers, which on both harnesses
        today is how hard it should think. It is not a third kind of identity — a run is
        pinned to an instance and a model, and this is a setting *of* the model — which is
        why it is a column of the same popover rather than a control of its own on the
        composer, and why it changes under the model selection rather than beside it.
      -->
      <div class="options" bind:this={optionColumn}>
        <p class="rail-label">Reasoning</p>

        {#if active === undefined}
          <p class="models-empty">Nothing to choose from.</p>
        {:else if app.pickedModelView === undefined}
          <!--
            A model an operator named that this instance's catalogue does not list. It may
            still run — whether a model runs is the harness's answer — but nothing is known
            about what it offers, and offering controls on a guess is the one thing this
            column must not do.
          -->
          <p class="models-empty">
            This server's catalogue does not list <span class="mono"
              >{app.effectiveModel}</span
            >, so what it offers is unknown. A run on it is still the harness's
            to accept or refuse.
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
                Rule 4 in `modelOption.ts`: an obsolete value is shown *as itself*, marked
                unknown, and deliberately not relabelled as what the run would fall back
                to. The fallback is stated separately so the operator can read both facts
                instead of inferring one from the other.
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
            Only what you set here is sent. A model left on its default is sent
            nothing, so the harness applies its own.
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
   * The height that bounds both columns.
   *
   * `max-height` alone did not: the panel used to be a grid, and a grid row with an
   * indefinite container height is sized to its content, so the row grew to 28 models
   * and `overflow: hidden` clipped it. The columns' own `overflow-y: auto` never fired
   * because they were never shorter than what was in them.
   *
   * Flex is used instead because the rule that fixes it is a flexbox rule: a single-line
   * flex container's cross size is resolved *and then clamped* by `max-height`, and
   * `align-items: stretch` stretches the items to that clamped size. So both columns get
   * a definite height of at most 340px whatever is inside them, and the scrolling happens
   * where the content is rather than at the panel's clipped edge.
   */
  /*
    Opens rightwards from the trigger, which is where the trigger now is: the composer
    puts it at the left end of its control strip, and a panel right-aligned to it — which
    is what this was while the trigger lived at the right end of a row — would run off the
    left edge of the pane. The stacked layout below takes over before the three columns
    can reach the other edge.
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
  /**
   * The rail scrolls on its own.
   *
   * It is two entries today, so nothing scrolls in practice — but it is the same popover
   * and the same bound, and a third configured harness with a warning block under it
   * reaches 340px without anything else changing.
   */
  .rail {
    display: flex;
    flex: 0 0 196px;
    min-height: 0;
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
    flex: 1 1 240px;
    min-width: 0;
    /* A flex item's automatic minimum is its content, which would undo the clamp above. */
    min-height: 0;
    flex-direction: column;
    padding: 8px;
    overflow: hidden;
  }
  /*
    The third column scrolls as a whole rather than holding one scrolling list: it is a
    label, a choice list and up to three sentences about what will and will not be sent,
    and keeping the sentences in view while only the choices moved would mean an operator
    reading a note about rows they cannot see.
  */
  .options {
    display: flex;
    flex: 0 0 184px;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    padding: 8px;
    overflow-y: auto;
    border-left: 1px solid var(--border-base);
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
  /**
   * This is the element that actually scrolls: the filter above it and the note below it
   * stay put, and the rows between them move. `min-height: 0` is the half that was
   * missing — `flex: 1` sets the basis to 0 but leaves the automatic minimum at the
   * content's height, so the list pushed the column taller than the panel instead of
   * scrolling inside it.
   */
  .model-list {
    flex: 1;
    min-height: 0;
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

  /*
    Narrow viewports: the three panes stack rather than overflowing the composer (§3.5).
    920px is where the columns stop fitting beside each other — the trigger sits about
    280px in with the sidebar open, and 280 + 622 is the whole of a 900px window.
  */
  @media (max-width: 920px) {
    .panel {
      flex-direction: column;
      width: min(92vw, 360px);
    }
    /*
      Stacked, the rail is sized by its content and the model list takes the rest, so the
      two columns keep their own scrolling instead of one starving the other.
    */
    .rail {
      flex: 0 1 auto;
      border-right: 0;
      border-bottom: 1px solid var(--border-base);
    }
    .models {
      flex: 1 1 auto;
    }
    .options {
      flex: 0 1 auto;
      border-left: 0;
      border-top: 1px solid var(--border-base);
    }
  }
</style>
