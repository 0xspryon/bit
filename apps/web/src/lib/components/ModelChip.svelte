<script lang="ts">
  /**
   * A6's model chip: a letter for the harness and the model in mono, with a caret when it
   * opens something. Extracted from the importer's picker (A6 chat generalisation, slice 2)
   * so the same chip heads every Harness · Model · Reasoning selector, in a chat's strip or
   * outside one (A9 H4f's Suggest-a-worker dialog, H6's chain rows).
   *
   * Two kinds: a **button** that opens a picker (`expanded`, `onclick`), and a **held** chip
   * for a model that cannot be changed from here.
   */
  import { IconAngleDown } from "../icons";

  let {
    harness,
    model,
    instance,
    modelLabel,
    kind = "button",
    expanded = false,
    switching = false,
    label,
    title,
    onclick,
    trigger = $bindable(null),
  }: {
    /** The harness's display name: its first letter is the glyph. */
    harness: string;
    /** The model id, as `provider/model`; `""` reads "No model". */
    model: string;
    /**
     * The instance's name, said before the model (harness instances, slice 1): where two
     * instances share a driver — two Claude Code configurations — the glyph alone would make
     * them look the same. Absent: the glyph alone, as before.
     */
    instance?: string | undefined;
    /** What the instance's configuration calls {@link model}. Absent: the id. */
    modelLabel?: string | undefined;
    kind?: "button" | "held";
    /** Whether the picker this chip opens is open. */
    expanded?: boolean;
    /** A switch is with the server: the chip shows the model it is still on, quietly. */
    switching?: boolean;
    /** The button's accessible name. */
    label?: string | undefined;
    title?: string | undefined;
    onclick?: (() => void) | undefined;
    /** The button, which a dialog hands focus back to when it closes. */
    trigger?: HTMLButtonElement | null;
  } = $props();

  let letter = $derived((harness.slice(0, 1) || "?").toLowerCase());
</script>

{#if kind === "button"}
  <button
    class={["chip", switching && "switching"]}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={expanded}
    aria-label={label}
    {title}
    bind:this={trigger}
    {onclick}
  >
    <span class="glyph" aria-hidden="true">{letter}</span>
    {#if instance !== undefined}
      <span class="instance">{instance}</span>
    {/if}
    <span class="model"
      >{model === "" ? "No model" : (modelLabel ?? model)}</span
    >
    <IconAngleDown class="caret" width="11" height="11" />
  </button>
{:else}
  <span class={["chip", "held"]} {title}>
    <span class="glyph" aria-hidden="true">{letter}</span>
    {#if instance !== undefined}
      <span class="instance">{instance}</span>
    {/if}
    <span class="model">{modelLabel ?? model}</span>
  </span>
{/if}

<style>
  /* A6's chip: 28px, a hairline border, a letter for the harness and the model in mono. */
  .chip {
    display: inline-flex;
    /*
     * Shrinks inside `.picker` when the strip is short of room (U6's "Send now" took some
     * at 1024), so the model name ellipses rather than the chip spilling over the caption.
     */
    flex: 0 1 auto;
    min-width: 0;
    align-items: center;
    gap: 8px;
    max-width: 280px;
    height: 28px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-base);
    font: 400 12px/var(--lh-compact) var(--font-mono);
  }
  button.chip {
    cursor: pointer;
  }
  button.chip:hover,
  button.chip[aria-expanded="true"] {
    background: var(--overlay-hover);
  }
  button.chip:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .chip.held {
    cursor: default;
  }
  /* A switch is with the server: the chip shows the model it is still on, quietly. */
  .chip.switching {
    color: var(--text-muted);
    cursor: progress;
  }
  .glyph {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 4px;
    background: var(--bg-layer-03);
    color: var(--text-base);
    font: 500 9px/15px var(--font-mono);
  }
  /* The instance's name, in the sans face, before the model; at most half the chip. */
  .instance {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    color: var(--text-muted);
    font-family: var(--font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .chip :global(.caret) {
    flex: none;
    color: var(--icon-muted);
  }
</style>
