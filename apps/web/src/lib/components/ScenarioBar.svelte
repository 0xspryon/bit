<script lang="ts">
  /**
   * Prototype-only. Jumps straight to any state in the brief so they can be
   * compared without reproducing the conditions that cause them. Delete this
   * component when the screens are wired to a real server.
   *
   * **It gets out of the way of real controls**, which it did not used to. It
   * is a fixed panel pinned to the bottom-right, and the compose box's Start
   * and Stop buttons are in that corner — so a debug tool was sitting on top
   * of the one control on the screen that does something. Two changes: it
   * starts closed, so the default screen has nothing covering anything; and
   * when the compose box is on screen it lifts clear of it, so opening the
   * picker does not take the buttons away again.
   */
  import { scenarios, type App } from "../app.svelte";

  let { app }: { app: App } = $props();

  /**
   * Closed by default.
   *
   * It opened itself when it was the only way to see the screens. The screens
   * come from a real server now, so a panel that opens over them on every load
   * is in the way more often than it is useful.
   */
  let open = $state(false);
  let active = $state("connect-idle");

  /**
   * Whether the compose box is on screen, and therefore whether to sit above it.
   *
   * The same condition `Target.svelte` renders it under — the open target's
   * Goals list — rather than a guess from the viewport, because what has to
   * be cleared is that component and not a width.
   */
  let lifted = $derived(
    app.screen === "target" && app.navItem === "goals" && app.openGoalId === "",
  );

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

<aside class={["dock", !open && "closed", lifted && "lifted"]}>
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
  /*
   * Clear of the compose box. The offset is deliberately generous — it covers
   * the box in its tallest state, running with a refusal showing — because a
   * debug tool that is a few pixels too high costs nothing and one that is a
   * few pixels too low costs a control.
   */
  .dock.lifted {
    bottom: 136px;
    max-height: calc(100vh - 150px);
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
