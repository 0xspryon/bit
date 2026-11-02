<script lang="ts">
  /**
   * One crumb in the title bar, and the picker it opens.
   *
   * **The crumb is the switcher.** There is no tab row: each crumb opens a list of its
   * siblings — targets on the first, goals or sections on the second — so the operator
   * moves sideways at either level without going back up. The same control at every level
   * puts "switch" and "start a new one" in the same place.
   *
   * The trigger and the popover are one component so that a click on the trigger is not
   * read as a click outside the popover: the outside test is against this whole root. A
   * caller closes it on a choice by setting the bound `open` to false.
   *
   * Rows are the caller's, rendered inside `.options`; a row that is a `button.option`
   * gets this picker's row style, and `.option-main`, `.option-sub` and `.option-end`
   * lay out its parts. The footer is the caller's too, inside `.foot`, with `button.foot-item`.
   */
  import type { Snippet } from "svelte";
  import { IconAngleDown, IconSearch } from "../icons";

  let {
    label,
    placeholder,
    query = $bindable(""),
    open = $bindable(false),
    width = 324,
    align = "start",
    onenter,
    trigger,
    rows,
    footer,
  }: {
    /** What the list is, for a screen reader: "Switch target". */
    label: string;
    placeholder: string;
    query?: string;
    open?: boolean;
    width?: number;
    /**
     * Which edge of the crumb the popover lines up with. `end` for a crumb on the bar's
     * right-hand side, where a popover opening rightwards would run off the window.
     */
    align?: "start" | "end";
    /** Enter in the search field: usually, take the first match. */
    onenter?: () => void;
    trigger: Snippet;
    rows: Snippet;
    footer?: Snippet;
  } = $props();

  let root = $state<HTMLDivElement | undefined>(undefined);
  let button = $state<HTMLButtonElement | undefined>(undefined);
  let search = $state<HTMLInputElement | undefined>(undefined);

  function close(refocus: boolean) {
    open = false;
    query = "";
    if (refocus) button?.focus();
  }

  $effect(() => {
    if (open) search?.focus();
  });
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!open || root === undefined) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    close(false);
  }}
  onkeydown={(event) => {
    if (open && event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  }}
/>

<div class="crumb-picker" bind:this={root}>
  <button
    bind:this={button}
    class={["crumb", open && "open"]}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => (open ? close(false) : (open = true))}
  >
    {@render trigger()}
    <IconAngleDown class="caret" width="12" height="12" />
  </button>

  {#if open}
    <div
      class={["picker", align === "end" && "end"]}
      role="dialog"
      aria-label={label}
      style:width="{width}px"
    >
      <label class="search">
        <IconSearch width="14" height="14" />
        <input
          bind:this={search}
          bind:value={query}
          {placeholder}
          aria-label={placeholder}
          onkeydown={(event) => {
            if (event.key === "Enter" && onenter !== undefined) {
              event.preventDefault();
              onenter();
              close(false);
            }
          }}
        />
        <kbd>Esc</kbd>
      </label>
      <div class="options">{@render rows()}</div>
      {#if footer}<div class="foot">{@render footer()}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .crumb-picker {
    position: relative;
    flex: none;
    min-width: 0;
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 280px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--text-base);
    font: 500 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .crumb:hover {
    border-color: var(--border-base);
    background: var(--overlay-hover);
  }
  .crumb.open {
    border-color: var(--border-strong);
    background: var(--bg-layer-02);
  }
  .crumb :global(.caret) {
    flex: none;
    color: var(--icon-muted);
  }
  .crumb.open :global(.caret) {
    color: var(--icon-base);
  }

  .picker {
    position: absolute;
    top: calc(100% + 9px);
    left: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    max-height: min(520px, calc(100vh - 80px));
    padding: 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-layer-01);
    box-shadow: 0 18px 48px #00000070;
  }
  .picker.end {
    right: 0;
    left: auto;
  }
  .search {
    display: flex;
    flex: none;
    align-items: center;
    gap: 9px;
    height: 36px;
    margin-bottom: 6px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border-muted);
    color: var(--icon-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    font: 400 13px/18px var(--font-sans);
    outline: none;
  }
  .search input::placeholder {
    color: var(--text-faint);
  }
  kbd {
    flex: none;
    padding: 1px 5px;
    border: 1px solid var(--border-base);
    border-radius: 3px;
    color: var(--text-muted);
    font: 500 10px/14px var(--font-mono);
  }

  .options {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  .options :global(.option) {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .options :global(.option:hover),
  .options :global(.option[aria-current="true"]) {
    background: var(--overlay-hover);
  }
  .options :global(.option-main) {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .options :global(.option-name) {
    overflow: hidden;
    color: var(--text-base);
    font: 500 13px/18px var(--font-sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .options :global(.option-name.dim) {
    color: var(--text-muted);
  }
  .options :global(.option-sub) {
    overflow: hidden;
    color: var(--text-muted);
    font: 400 11px/15px var(--font-mono);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .options :global(.option-sub.warn) {
    color: var(--state-fg-warning);
  }
  .options :global(.option-sub.faint) {
    color: var(--text-faint);
  }
  .options :global(.option-end) {
    flex: none;
    color: var(--icon-base);
  }
  .options :global(.option-end.warn) {
    color: var(--state-fg-warning);
  }
  .options :global(.none) {
    margin: 0;
    padding: 8px;
    color: var(--text-faint);
    font-size: 13px;
  }

  .foot {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 6px 2px 2px;
    border-top: 1px solid var(--border-muted);
  }
  .foot :global(.foot-item) {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font: 400 13px/18px var(--font-sans);
    cursor: pointer;
  }
  .foot :global(.foot-item:first-child) {
    flex: 1;
  }
  .foot :global(.foot-item:hover) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
</style>
