<script lang="ts">
  /**
   * Prototype-only. Jumps straight to any state in the brief so they can be
   * compared without reproducing the conditions that cause them. Delete this
   * component when the screens are wired to a real server.
   */
  import { scenarios, type App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let open = $state(true);
  let active = $state("connect-idle");

  let groups = $derived([...new Set(scenarios.map((s) => s.group))]);

  function run(id: string) {
    const scenario = scenarios.find((s) => s.id === id);
    if (scenario === undefined) return;
    const theme = app.theme;
    scenario.apply(app);
    app.theme = theme;
    active = id;
  }
</script>

<aside class={["dock", !open && "closed"]}>
  <button class="toggle" onclick={() => (open = !open)}>
    <span class="dot" aria-hidden="true"></span>
    States
    <span class="caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
  </button>

  {#if open}
    <div class="groups">
      {#each groups as group (group)}
        <div class="group">
          <span class="label">{group}</span>
          {#each scenarios.filter((s) => s.group === group) as scenario (scenario.id)}
            <button
              class={["item", active === scenario.id && "active"]}
              onclick={() => run(scenario.id)}>{scenario.label}</button
            >
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .dock {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 28px);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-deep);
    box-shadow: var(--elevation-floating);
    overflow: hidden;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: 600 11px/1 var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .toggle:hover {
    color: var(--text-base);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--state-fg-success);
  }
  .caret {
    margin-left: auto;
    font-size: 9px;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px 8px 10px;
    overflow: auto;
    border-top: 1px solid var(--border-muted);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .label {
    padding: 6px 6px 3px;
    font: 600 10px/1 var(--font-sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .item {
    padding: 6px 9px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/1.4 var(--font-sans);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .item:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .item.active {
    background: var(--bg-layer-02);
    color: var(--text-base);
  }
</style>
