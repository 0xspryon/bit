<script lang="ts">
  /**
   * Which harness, and which of its models — the columns, wherever that question is asked.
   *
   * ## Why this exists as a component
   *
   * It is asked in two places: the composer's popover (`HarnessPicker`) and the
   * Auto-load page's model control (`AutoLoad`). Those were two implementations of
   * the same screen, and they had already drifted in four ways that an operator could see:
   *
   * - **The unready harness.** One kept the row selectable and printed the harness's own
   *   reason and setup line; the other set `disabled` with `opacity: 0.5` and no reason at
   *   all. The first is the product's rule everywhere — a configured instance that cannot
   *   run stays visible, dimmed, carrying its own sentence — and it is the rule that makes
   *   a picker worth having, because the reason has to be read where the choice is made.
   * - **The rail with one harness.** One hid it behind `length > 1`, the other always
   *   showed it. A rail that appears when a second harness is configured is a layout that
   *   changes under the operator for a reason they did not act on.
   * - **The filter.** Duplicated byte for byte, with nothing keeping the two the same.
   * - **The options column**, which only one of them had.
   *
   * So the columns are here, once. What the two shells keep is the *shell*: a popover with
   * a scrim, a focus trap and Escape, against an inline block in a form. Popover versus
   * inline justifies two wrappers; it does not justify two instance rails and two policies
   * about an unusable harness.
   *
   * ## What stays the caller's
   *
   * **Which instance is active**, and that is not an oversight. The two resolutions are
   * genuinely different rules: a run goes to the operator's pick or else the server's
   * *default* instance, while an import goes to the operator's pick or else whatever D15's
   * rule resolved against the live catalogue — which may be neither the default nor the
   * same harness. Both are already computed on `App`, each beside the thing it is a rule
   * for, and passing one in is what lets this file have no opinion about it.
   *
   * The options column is a snippet for the same reason: it is a setting *of a model*, whose
   * state is the caller's — a run's options and an import's are kept apart — and the
   * Auto-load page has none to offer. The callers that do render `ModelOptionsColumn` into
   * it from their own state, so the column is one component and the state stays theirs.
   *
   * ## Keyboard
   *
   * Up and down walk the column the focus is in, clamped rather than wrapping, with the
   * row brought just inside the edge (`preventScroll` then `block: "nearest"`). That lives
   * here because it is about these columns; the popover's Tab trap stays with the popover,
   * because it is about being a popover. Escape calls {@link onDismiss} when a caller gives
   * one, so the inline usage gets the same key as the popover rather than nothing.
   */
  import Badge from "./Badge.svelte";
  import { IconSearch } from "../icons";
  import type { HarnessInstanceView } from "@bit/contracts";
  import type { Snippet } from "svelte";

  let {
    instances,
    active,
    model,
    query = $bindable(""),
    onPickInstance,
    onPickModel,
    layout = "popover",
    options,
    note,
    onDismiss,
  }: {
    /** Every configured instance, ready or not. Unready ones stay in the rail. */
    instances: readonly HarnessInstanceView[];
    /** The instance whose models are listed: the caller's own resolution of "which". */
    active: HarnessInstanceView | undefined;
    /** The model id a run or an import would use, resolved through the caller's defaults. */
    model: string;
    /** What the model list is filtered by. Owned by the caller so it survives a close. */
    query?: string;
    onPickInstance: (instanceId: string) => void;
    onPickModel: (modelId: string) => void;
    /** Only a width question: the popover is three columns wide, the inline block is two. */
    layout?: "popover" | "inline";
    /** The third column, when the caller has something of the model to offer. */
    options?: Snippet;
    /** A closing line under the model list, in the caller's own words. */
    note?: Snippet;
    /** Escape, when the caller is something Escape should close. */
    onDismiss?: () => void;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let railColumn = $state<HTMLElement | null>(null);
  let modelColumn = $state<HTMLElement | null>(null);
  let optionColumn = $state<HTMLElement | null>(null);

  /** The filter, in one place, so the two callers cannot come to disagree about it. */
  let shown = $derived.by(() => {
    const all = active?.models ?? [];
    const wanted = query.trim().toLowerCase();
    return wanted === ""
      ? all
      : all.filter((entry) => entry.id.toLowerCase().includes(wanted));
  });

  /**
   * Focus into the filter when this appears.
   *
   * The filter rather than the first row: the rail is two entries an operator can see at a
   * glance, and the thing they came to type into is the search. Tab still reaches
   * everything.
   */
  $effect(() => {
    searchInput?.focus();
  });

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
    if (event.key === "Escape") {
      // The same key closes both shells. The inline one had no Escape at all, which is
      // the kind of difference that only exists because the markup was written twice.
      if (onDismiss === undefined) return;
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // Arrows belong to whichever column the focus is already in — one window handler
    // rather than a listener per element, because a keydown handler on a plain container
    // is the thing the a11y lint is right to object to.
    const focused = document.activeElement;
    if (focused === null || root === null || !root.contains(focused)) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    if (optionColumn?.contains(focused) === true) {
      event.preventDefault();
      stepRow(optionColumn, ".option-row", delta);
    } else if (modelColumn?.contains(focused) === true) {
      event.preventDefault();
      stepRow(modelColumn, ".model-row", delta);
    } else if (railColumn?.contains(focused) === true) {
      event.preventDefault();
      stepRow(railColumn, ".rail-row", delta);
    }
  }
</script>

<svelte:window {onkeydown} />

<div class={["choice", layout]} bind:this={root}>
  <div
    class="rail"
    role="listbox"
    aria-label="Harness instances"
    bind:this={railColumn}
  >
    <p class="rail-label">Harness</p>
    {#if instances.length === 0}
      <p class="rail-empty">
        This server configures no agent harness, so it will refuse every run.
      </p>
    {/if}
    {#each instances as instance (instance.instanceId)}
      <button
        class="rail-row"
        class:selected={instance.instanceId === active?.instanceId}
        class:unusable={!instance.ready}
        type="button"
        role="option"
        aria-selected={instance.instanceId === active?.instanceId}
        onclick={() => onPickInstance(instance.instanceId)}
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
            The version when it is usable, the reason when it is not. State is never colour
            alone here: the row is dimmed *and* says what is wrong (§9).
          -->
          <span class="rail-meta mono">
            {instance.ready ? instance.version : "unusable"}
          </span>
        </span>
      </button>
      {#if !instance.ready}
        <!--
          Dimmed, never removed, and never merely `disabled` either: picking one is refused
          by the server with the harness's own sentence, and the reason has to be readable
          where the choice is made. A row that was only greyed out left the operator with
          nothing to act on.
        -->
        <p class="rail-reason">
          {instance.reason ?? "This server could not bring that harness up."}
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
        bind:value={query}
      />
    </div>

    {#if active === undefined}
      <p class="models-empty">Nothing to choose from.</p>
    {:else if !active.ready}
      <!--
        The models of an unusable instance are still listed: it is the same catalogue, and
        hiding it would be a second way of saying what the rail already says.
      -->
      <p class="models-empty">
        {active.displayName} is not usable on this server, so a run on it is refused.
        Its models are listed for reference.
      </p>
    {/if}

    <ul class="model-list">
      {#each shown as entry (entry.id)}
        <li>
          <button
            class="model-row"
            class:selected={entry.id === model}
            type="button"
            onclick={() => onPickModel(entry.id)}
          >
            <span class="model-name mono">{entry.id}</span>
            {#if entry.id === active?.defaultModel}
              <span class="model-tag">default</span>
            {/if}
          </button>
        </li>
      {/each}
      {#if active !== undefined && shown.length === 0}
        <li class="no-results">
          <p>
            No model here matches that. This list is what the harness reported
            when this server started it, and an operator may still name one that
            is not on it — whether a model runs is the harness's answer.
          </p>
        </li>
      {/if}
    </ul>

    {#if active !== undefined && note !== undefined}
      <p class="models-note">{@render note()}</p>
    {/if}
  </div>

  {#if options !== undefined}
    <!--
      The third column, rendered from the caller's markup: what the *model* on the left
      offers, which on both harnesses today is how hard it should think. It is a column of
      the same control rather than one of its own, because it is a setting of the model —
      it changes when the model does and is meaningless without one.
    -->
    <div class="options" bind:this={optionColumn}>
      {@render options()}
    </div>
  {/if}
</div>

<style>
  /**
   * The flex container the callers' own height bound reaches through.
   *
   * `HarnessPicker`'s note on why this is flex and not grid applies here, because this is
   * the element it was about: a grid row with an indefinite container height is sized to
   * its content, so the row grew to 28 models and the panel clipped it. A single-line flex
   * container's cross size is resolved and *then* clamped by the ancestor's `max-height`,
   * and `align-items: stretch` stretches the columns to that clamped size — so the columns
   * get a definite height and the scrolling happens where the content is.
   */
  .choice {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .choice.inline {
    /* Inside a form column rather than floating: bounded on its own, since there is no
       popover above it doing the bounding. */
    max-height: 300px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
  }
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
    box-sizing: border-box;
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
   * stay put, and the rows between them move. `min-height: 0` is the half that is easy to
   * miss — `flex: 1` sets the basis to 0 but leaves the automatic minimum at the content's
   * height, so the list pushes the column taller than the panel instead of scrolling.
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
    Narrow viewports: the columns stack rather than overflowing whatever holds them (§3.5).
    920px is where three columns stop fitting beside the composer's trigger; the inline
    block stacks at the width its own form does.
  */
  @media (max-width: 920px) {
    .choice.popover {
      flex-direction: column;
    }
    .choice.popover .rail {
      flex: 0 1 auto;
      border-right: 0;
      border-bottom: 1px solid var(--border-base);
    }
    .choice.popover .models {
      flex: 1 1 auto;
    }
    .choice.popover .options {
      flex: 0 1 auto;
      border-left: 0;
      border-top: 1px solid var(--border-base);
    }
  }
  @media (width < 700px) {
    .choice.inline {
      flex-direction: column;
    }
    .choice.inline .rail {
      flex: 0 1 auto;
      border-right: 0;
      border-bottom: 1px solid var(--border-base);
    }
    .choice.inline .models {
      flex: 1 1 auto;
    }
  }
</style>
