<script lang="ts">
  /**
   * Level 2 navigation: the persistent sidebar inside an open target.
   *
   * Everything in it is scoped to that one target — nothing here is global.
   * It collapses to an icon rail, and only Blockers and Findings are allowed
   * to show an attention state. If everything can demand attention, nothing
   * does.
   */
  import Badge from "./Badge.svelte";
  import {
    IconArchive,
    IconBell,
    IconBlocked,
    IconBug,
    IconCog,
    IconCollapse,
    IconCompass,
    IconExchange,
    IconExpand,
    IconEye,
    IconFile,
    IconHelp,
    IconHourglass,
    IconMoon,
    IconRobot,
    IconScroll,
    IconShield,
    IconSitemap,
    IconStream,
    IconSun,
  } from "../icons";
  import { navGroups } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  const glyphs: Record<string, typeof IconBug> = {
    stream: IconStream,
    bug: IconBug,
    eye: IconEye,
    sitemap: IconSitemap,
    compass: IconCompass,
    exchange: IconExchange,
    archive: IconArchive,
    file: IconFile,
    robot: IconRobot,
    blocked: IconBlocked,
    shield: IconShield,
    hourglass: IconHourglass,
    bell: IconBell,
    scroll: IconScroll,
  };
</script>

<nav
  class={["sidebar", app.sidebarCollapsed && "collapsed"]}
  aria-label="Target navigation"
>
  <header class="head">
    <button class="target" onclick={() => app.toSettings()}>
      <Badge
        name={app.selected?.name ?? "?"}
        size={app.sidebarCollapsed ? 24 : 26}
      />
      {#if !app.sidebarCollapsed}
        <span class="target-text">
          <span class="target-name">{app.selected?.name ?? ""}</span>
          <span class="target-scope mono">{app.selected?.scope ?? ""}</span>
        </span>
      {/if}
    </button>
  </header>

  <div class="groups">
    {#each navGroups as group (group.label)}
      <div class="group">
        {#if !app.sidebarCollapsed}
          <span class="group-label">{group.label}</span>
        {:else}
          <span class="rule" aria-hidden="true"></span>
        {/if}
        {#each group.items as item (item.id)}
          {@const Glyph = glyphs[item.icon]}
          <button
            class={["item", app.navItem === item.id && "active"]}
            aria-current={app.navItem === item.id ? "page" : undefined}
            title={app.sidebarCollapsed ? item.label : undefined}
            onclick={() => (app.navItem = item.id)}
          >
            <span class="glyph">
              {#if Glyph}<Glyph width="15" height="15" />{/if}
              {#if app.sidebarCollapsed && item.attention}
                <span class="pip" aria-hidden="true"></span>
              {/if}
            </span>
            {#if !app.sidebarCollapsed}
              <span class="item-label">{item.label}</span>
              {#if item.count !== undefined}
                <span class={["count", item.attention && "attention"]}>
                  {item.count}
                </span>
              {/if}
            {/if}
            {#if app.sidebarCollapsed}
              <span class="visually-hidden">
                {item.label}{item.count !== undefined ? `, ${item.count}` : ""}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <footer class="foot">
    <button class="item" onclick={() => app.toSettings()}>
      <span class="glyph"><IconCog width="15" height="15" /></span>
      {#if !app.sidebarCollapsed}<span class="item-label">Settings</span>{/if}
    </button>
    <button class="item">
      <span class="glyph"><IconHelp width="15" height="15" /></span>
      {#if !app.sidebarCollapsed}<span class="item-label">Help</span>{/if}
    </button>
    <div class="foot-row">
      <button
        class="item"
        onclick={() => app.toggleTheme()}
        aria-label="Switch to {app.theme === 'dark' ? 'light' : 'dark'} theme"
      >
        <span class="glyph">
          {#if app.theme === "dark"}
            <IconMoon width="15" height="15" />
          {:else}
            <IconSun width="15" height="15" />
          {/if}
        </span>
        {#if !app.sidebarCollapsed}<span class="item-label">Theme</span>{/if}
      </button>
      <button
        class="collapse"
        onclick={() => (app.sidebarCollapsed = !app.sidebarCollapsed)}
        aria-label={app.sidebarCollapsed
          ? "Expand navigation"
          : "Collapse navigation"}
      >
        {#if app.sidebarCollapsed}
          <IconExpand width="13" height="13" />
        {:else}
          <IconCollapse width="13" height="13" />
        {/if}
      </button>
    </div>
  </footer>
</nav>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 220px;
    flex: none;
    min-height: 0;
    border-right: 1px solid var(--border-base);
    background: var(--bg-base);
    transition: width var(--dur-panel) var(--ease-panel);
  }
  .sidebar.collapsed {
    width: 56px;
  }

  .head {
    padding: 10px 8px;
    border-bottom: 1px solid var(--border-muted);
  }
  .target {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 7px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .target:hover {
    background: var(--overlay-hover);
  }
  .target-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
  }
  .target-name {
    font-size: 13px;
    color: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .target-scope {
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .groups {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .group-label {
    padding: 4px 8px 5px;
    font: 600 10px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .rule {
    height: 1px;
    margin: 3px 8px 6px;
    background: var(--border-muted);
  }

  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font: 400 13px/var(--lh-compact) var(--font-sans);
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .item:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .item.active {
    background: var(--bg-layer-02);
    color: var(--text-base);
  }
  .glyph {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 20px;
    color: var(--icon-muted);
  }
  .item:hover .glyph,
  .item.active .glyph {
    color: var(--icon-base);
  }
  .item-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    flex: none;
    font-size: 11px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  /* Only Blockers and Findings carry this. Everything else stays quiet. */
  .count.attention {
    padding: 1px 6px;
    border: 1px solid var(--state-border-warning);
    border-radius: 99px;
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  /* Collapsed, the count has nowhere to go, so attention becomes a pip. */
  .pip {
    position: absolute;
    top: -1px;
    right: 0;
    width: 6px;
    height: 6px;
    border: 1px solid var(--bg-base);
    border-radius: 50%;
    background: var(--state-fg-warning);
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px;
    border-top: 1px solid var(--border-muted);
  }
  .foot-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .foot-row .item {
    flex: 1;
  }
  .collapse {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-faint);
    cursor: pointer;
  }
  .collapse:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .collapsed .foot-row {
    flex-direction: column;
  }
  .collapsed .item {
    justify-content: center;
    padding: 8px 0;
  }
</style>
