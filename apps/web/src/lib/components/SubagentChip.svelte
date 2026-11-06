<script lang="ts">
  /**
   * E8's sub-agents chip (A7-S), in the app's title bar beside the session chip: "5
   * sub-agents" with two live counts, running and failed in danger red. It counts every
   * sub-agent of the session, including ones whose cards have long scrolled away, and opens
   * the sub-agents panel; it stays pressed while the panel is open. Drawn once the agent has
   * started its first sub-agent, and not before.
   *
   * **Compact below about 900px of viewport** (A7-S review 3): the icon and the two counts,
   * the words in its accessible name and title, so the title bar fits a portrait tablet.
   */
  import { MediaQuery } from "svelte/reactivity";

  import { IconRobot } from "../icons";
  import {
    SUBAGENT_CHIP_COMPACT_QUERY,
    subagentChipLabel,
    subagentChipName,
    type SubagentGroups,
  } from "../subagents";

  let {
    groups,
    open,
    ontoggle,
    button = $bindable(),
  }: {
    groups: SubagentGroups;
    open: boolean;
    ontoggle: () => void;
    /** The chip itself, for focus to come back to when the panel closes. */
    button?: HTMLButtonElement | undefined;
  } = $props();

  const total = $derived(
    groups.running.length + groups.failed.length + groups.finished.length,
  );
  const compact = new MediaQuery(SUBAGENT_CHIP_COMPACT_QUERY, false);
  const action = $derived(
    open ? "Close the sub-agents panel" : "Open the sub-agents panel",
  );
</script>

{#if total > 0}
  <button
    bind:this={button}
    class={["subagents-chip", compact.current && "compact"]}
    type="button"
    aria-pressed={open}
    aria-controls="subagent-panel"
    aria-label={subagentChipName(groups)}
    title={compact.current ? `${subagentChipName(groups)}. ${action}` : action}
    onclick={ontoggle}
  >
    <IconRobot width="13" height="13" aria-hidden="true" />
    {#if !compact.current}
      <span class="label">{subagentChipLabel(total)}</span>
    {/if}
    <span class="count running" aria-hidden="true"
      ><span class="dot"></span>{groups.running.length}</span
    >
    <span class="count failed" aria-hidden="true"
      ><span class="dot"></span>{groups.failed.length}</span
    >
  </button>
{/if}

<style>
  .subagents-chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 5px;
    background: transparent;
    color: var(--text-base);
    font: 400 12px/16px var(--font-mono);
    white-space: nowrap;
    cursor: pointer;
  }
  .subagents-chip.compact {
    gap: 5px;
    padding: 0 7px;
  }
  .subagents-chip:hover {
    background: var(--overlay-hover);
  }
  .subagents-chip[aria-pressed="true"] {
    border-color: var(--border-strong);
    background: var(--bg-layer-02);
  }
  .subagents-chip :global(svg) {
    color: var(--icon-muted);
  }
  .count {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-muted);
    font-size: 11px;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .count.failed {
    color: var(--state-fg-danger);
  }
  .count.failed .dot {
    background: var(--state-fg-danger);
  }
</style>
