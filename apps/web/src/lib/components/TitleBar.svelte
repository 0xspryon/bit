<script lang="ts">
  import Badge from "./Badge.svelte";
  import { IconClose, IconGrid, IconMoon, IconPlus, IconSun } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();
</script>

<header class="titlebar">
  <button
    class="grid"
    title="All targets"
    aria-label="All targets"
    onclick={() => (app.screen = "welcome")}
  >
    <IconGrid width="14" height="14" />
  </button>

  <div class="tabs" role="tablist" aria-label="Open targets">
    {#each app.openTargets as target (target.id)}
      <div class="tab-wrap">
        <button
          role="tab"
          aria-selected={target.id === app.selectedId}
          class={["tab", target.id === app.selectedId && "active"]}
          onclick={() =>
            app.screen === "target"
              ? app.openTarget(target.id)
              : app.select(target.id)}
        >
          <Badge name={target.name} size={16} />
          <span class="name">{target.name}</span>
        </button>
        <button
          class="close"
          aria-label="Close {target.name}"
          onclick={() => app.closeTab(target.id)}
        >
          <IconClose width="10" height="10" />
        </button>
      </div>
    {/each}
    <button
      class="add"
      aria-label="New target"
      onclick={() => app.openDialog()}
    >
      <IconPlus width="11" height="11" />
    </button>
  </div>

  <div class="right">
    {#if app.reconnecting}
      <span class="chip" role="status">Reconnecting…</span>
    {/if}
    <button
      class="theme"
      onclick={() => app.toggleTheme()}
      aria-label="Switch to {app.theme === 'dark' ? 'light' : 'dark'} theme"
    >
      {#if app.theme === "dark"}
        <IconMoon width="13" height="13" />
      {:else}
        <IconSun width="13" height="13" />
      {/if}
    </button>
  </div>
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--titlebar-h);
    padding: 0 8px;
    background: var(--bg-deep);
    border-bottom: 1px solid var(--border-base);
    flex: none;
  }
  .grid,
  .add,
  .theme,
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--icon-muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .grid,
  .add,
  .theme {
    width: 26px;
    height: 26px;
    font-size: 14px;
  }
  .grid:hover,
  .add:hover,
  .theme:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .tab-wrap {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    max-width: 180px;
  }
  .tab-wrap:hover {
    background: var(--overlay-hover);
  }
  .tab-wrap:has(.active) {
    background: var(--bg-layer-02);
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    height: 26px;
    padding: 0 4px 0 7px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/1 var(--font-sans);
    cursor: pointer;
  }
  .tab.active {
    color: var(--text-base);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    width: 18px;
    height: 18px;
    margin-right: 4px;
    font-size: 14px;
    opacity: 0;
  }
  .tab-wrap:hover .close,
  .tab-wrap:has(.active) .close {
    opacity: 1;
  }
  .close:hover {
    background: var(--overlay-pressed);
    color: var(--text-base);
  }

  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  /* The persistent half of the reconnecting signal: dismissing the banner
     must not hide a dead connection. */
  .chip {
    padding: 3px 9px;
    border: 1px solid var(--state-border-danger);
    border-radius: 99px;
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
    font-size: 11px;
  }
</style>
