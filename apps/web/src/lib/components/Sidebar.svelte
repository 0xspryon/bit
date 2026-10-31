<script lang="ts">
  /**
   * Level 2 navigation: the rail inside an open target.
   *
   * Everything in it is scoped to that one target — nothing here is global. It carries no
   * target name: the first crumb says which target this is, once. It hides rather than
   * collapsing to icons, and while it is hidden the crumb bar grows a section crumb that
   * does this rail's job (see `TitleBar`).
   *
   * Only Findings and Blockers may show an attention state, and only Blockers is in colour.
   * If everything can demand attention, nothing does.
   */
  import { IconCog, IconHelp } from "../icons";
  import { navGlyphs } from "../navGlyphs";
  import { navGroups } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();
</script>

<nav class="sidebar" aria-label="Target navigation">
  <div class="groups">
    {#each navGroups as group (group.label)}
      <span class="group-label">{group.label}</span>
      {#each group.items as item (item.id)}
        {@const Glyph = navGlyphs[item.icon]}
        {@const count = app.navCount(item.id)}
        <button
          class={["item", app.navItem === item.id && "active"]}
          data-item={item.id}
          aria-current={app.navItem === item.id ? "page" : undefined}
          onclick={() => app.toSection(item.id)}
        >
          <span class="glyph">
            {#if Glyph}<Glyph width="15" height="15" />{/if}
          </span>
          <span class="item-label">{item.label}</span>
          {#if count !== undefined}
            <span class={["count", item.attention && "attention"]}>
              {count}
            </span>
          {/if}
        </button>
      {/each}
    {/each}
  </div>

  <footer class="foot">
    <button
      class={["item", app.navItem === "settings" && "active"]}
      onclick={() => app.toSettings()}
    >
      <span class="glyph"><IconCog width="15" height="15" /></span>
      <span class="item-label">Settings</span>
    </button>
    <button class="item">
      <span class="glyph"><IconHelp width="15" height="15" /></span>
      <span class="item-label">Help</span>
    </button>
  </footer>
</nav>

<style>
  .sidebar {
    display: flex;
    flex: none;
    flex-direction: column;
    width: var(--rail-w);
    min-height: 0;
    border-right: 1px solid var(--border-base);
    background: var(--bg-deep);
  }

  .groups {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: auto;
    padding: 16px 8px 12px;
  }
  .group-label {
    padding: 20px 8px 4px;
    font: 600 10px/14px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .group-label:first-child {
    padding-top: 6px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font: 400 13px/18px var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .item:hover {
    background: var(--overlay-hover);
  }
  .item.active {
    background: var(--bg-layer-01);
    color: var(--text-base);
    font-weight: 500;
  }
  .glyph {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    color: var(--icon-muted);
  }
  .item.active .glyph {
    color: var(--icon-base);
  }
  .item-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .count {
    flex: none;
    color: var(--text-muted);
    font: 500 12px/16px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  /* Findings reads one step louder; Blockers is the one place colour is spent. */
  .count.attention {
    color: var(--text-base);
  }
  [data-item="blockers"] .glyph,
  [data-item="blockers"] .count {
    color: var(--state-fg-warning);
  }

  .foot {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-top: 1px solid var(--border-muted);
  }
</style>
