<script lang="ts">
  /**
   * Prototype-only. Jumps straight to any state in the brief so they can be
   * compared without reproducing the conditions that cause them. Delete this
   * component when the screens are wired to a real server.
   *
   * **It gets out of the way of real controls.** It starts closed, and inside a target
   * its toggle is not floating at all: it is docked into the Live dock's header, the one
   * strip already pinned to the bottom of that screen, and the open list renders inside
   * the expanded dock (`docked`) rather than floating over the compose box's Start and
   * Stop. Elsewhere — Connect and All targets, which have no dock — it keeps its own
   * corner toggle.
   */
  import { scenarios, type App } from "../app.svelte";

  let { app, docked = false }: { app: App; docked?: boolean } = $props();

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

{#snippet list()}
  <div class={["groups", docked && "inline"]} aria-label="Prototype states">
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
{/snippet}

{#if docked}
  {@render list()}
{:else}
  <aside class="dock">
    <button class="toggle" onclick={() => (app.statesOpen = !app.statesOpen)}>
      <span class="dot" aria-hidden="true"></span>
      States
      <span class="caret" aria-hidden="true">{app.statesOpen ? "▾" : "▸"}</span>
    </button>
    {#if app.statesOpen}{@render list()}{/if}
  </aside>
{/if}

<style>
  .dock {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 28px);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-deep);
    box-shadow: var(--elevation-floating);
    overflow: hidden;
  }
  /* Inside the expanded Live dock: a column beside the rows, scrolling on its own. */
  .groups.inline {
    flex: none;
    width: 220px;
    padding: 8px;
    border-top: 0;
    border-left: 1px solid var(--border-muted);
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
