<script lang="ts">
  /**
   * The crumb bar: identity, switching and the way back out, in one row.
   *
   * It replaced three things — a tab row of open targets, the rail's target header, and
   * the page header's target name — that each said which target you were in. Now the
   * first crumb says it once, and opens the list of every target to move sideways to.
   *
   * Which crumbs there are follows one rule each:
   *
   * - **Above target scope** (All targets) there is one chip, and it does not switch:
   *   there is nothing beside it to switch to.
   * - **The section crumb appears only while the rail is hidden.** The rail is what moves
   *   you between Goals, Findings and Observations; with it put away nothing else can, so
   *   the crumb bar takes on exactly that job and gives it back when the rail returns. On a
   *   list page with the rail showing, a `Goals ▾` crumb would be the third statement of
   *   one word.
   * - **The goal crumb appears inside a goal**, and lists that target's other goals — ended
   *   ones kept but dimmed — with "New goal" at its foot.
   */
  import Badge from "./Badge.svelte";
  import CrumbPicker from "./CrumbPicker.svelte";
  import {
    IconAngleRight,
    IconCheck,
    IconGoal,
    IconGrid,
    IconPanel,
    IconPlus,
    IconTheme,
    IconWarning,
  } from "../icons";
  import { countsLine, goalTitle, statusLabel, whenText } from "../goalFormat";
  import { navGlyphs } from "../navGlyphs";
  import { navItems } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let targetOpen = $state(false);
  let targetQuery = $state("");
  let sectionOpen = $state(false);
  let sectionQuery = $state("");
  let goalOpen = $state(false);
  let goalQuery = $state("");

  const matches = (text: string, query: string) =>
    text.toLowerCase().includes(query.trim().toLowerCase());

  let targetRows = $derived(
    app.targets.filter((target) => matches(target.name, targetQuery)),
  );
  let sectionRows = $derived(
    navItems.filter((item) => matches(item.label, sectionQuery)),
  );
  /** Only this target's goals, as the Goals page reads them. */
  let goals = $derived(app.goalsTargetId === app.viewTargetId ? app.goals : []);
  let goalRows = $derived(
    goals.filter((goal) => matches(goalTitle(goal), goalQuery)),
  );
  let section = $derived(navItems.find((item) => item.id === app.navItem));
  let SectionGlyph = $derived(navGlyphs[section?.icon ?? ""]);
  let goal = $derived(app.navItem === "goals" ? app.openGoalView : undefined);
  let goalName = $derived(goal === undefined ? "" : goalTitle(goal));

  /** The second line of a target row: what needs attention, or when it last moved. */
  const targetFact = (lastActivity: string) =>
    lastActivity === "now" ? "active now" : `active ${lastActivity} ago`;

  function pickTarget(id: string) {
    targetOpen = false;
    if (id === app.selectedId && app.viewTargetId === id) return;
    app.openTarget(id);
  }
  function pickSection(id: string) {
    sectionOpen = false;
    app.toSection(id);
  }
  function pickGoal(goalId: string) {
    goalOpen = false;
    if (goalId !== app.openGoalId) app.openGoal(goalId);
  }
</script>

<header class="titlebar">
  {#if app.screen === "target"}
    <button
      class="drawer"
      aria-label={app.drawerHidden ? "Show panel" : "Hide panel"}
      aria-pressed={!app.drawerHidden}
      title={app.drawerHidden ? "Show panel" : "Hide panel"}
      onclick={() => (app.drawerHidden = !app.drawerHidden)}
    >
      <IconPanel width="15" height="15" />
    </button>

    <CrumbPicker
      label="Switch target"
      placeholder="Find target…"
      bind:open={targetOpen}
      bind:query={targetQuery}
      onenter={() => {
        const first = targetRows[0];
        if (first !== undefined) pickTarget(first.id);
      }}
    >
      {#snippet trigger()}
        <Badge name={app.selected?.name ?? "?"} size={16} tone="current" />
        <span class="crumb-text">{app.selected?.name ?? ""}</span>
      {/snippet}
      {#snippet rows()}
        {#each targetRows as target (target.id)}
          {@const current = target.id === app.selectedId}
          {@const missing = target.status === "missing"}
          <button
            class="option"
            aria-current={current}
            onclick={() => pickTarget(target.id)}
          >
            <Badge
              name={target.name}
              size={28}
              letters={2}
              tone={current ? "current" : missing ? "quiet" : "plain"}
            />
            <span class="option-main">
              <span class={["option-name", missing && "dim"]}>
                {target.name}
              </span>
              {#if missing}
                <span class="option-sub warn" title={target.detail}>
                  cannot be opened
                </span>
              {:else}
                <span class="option-sub">{targetFact(target.lastActivity)}</span
                >
              {/if}
            </span>
            {#if current}
              <IconCheck class="option-end" width="14" height="14" />
            {:else if missing}
              <IconWarning class="option-end warn" width="14" height="14" />
            {/if}
          </button>
        {:else}
          <p class="none">No target matches.</p>
        {/each}
      {/snippet}
      {#snippet footer()}
        <button
          class="foot-item"
          onclick={() => {
            targetOpen = false;
            app.openNewTarget();
          }}
        >
          <IconPlus width="14" height="14" />
          New target
        </button>
        <button
          class="foot-item"
          onclick={() => {
            targetOpen = false;
            app.toAllTargets();
          }}
        >
          All targets
          <IconAngleRight width="13" height="13" />
        </button>
      {/snippet}
    </CrumbPicker>

    {#if app.drawerHidden}
      <IconAngleRight class="sep" width="12" height="12" />
      <CrumbPicker
        label="Switch section"
        placeholder="Find section…"
        width={260}
        bind:open={sectionOpen}
        bind:query={sectionQuery}
        onenter={() => {
          const first = sectionRows[0];
          if (first !== undefined) pickSection(first.id);
        }}
      >
        {#snippet trigger()}
          {#if SectionGlyph}<SectionGlyph
              class="crumb-icon"
              width="13"
              height="13"
            />{/if}
          <span class="crumb-text">{section?.label ?? "Settings"}</span>
        {/snippet}
        {#snippet rows()}
          {#each sectionRows as item (item.id)}
            {@const Glyph = navGlyphs[item.icon]}
            {@const count = app.navCount(item.id)}
            <button
              class="option"
              aria-current={item.id === app.navItem}
              onclick={() => pickSection(item.id)}
            >
              {#if Glyph}<Glyph width="15" height="15" />{/if}
              <span class="option-main">
                <span class="option-name">{item.label}</span>
              </span>
              {#if count !== undefined}
                <span class={["section-count", item.attention && "attention"]}>
                  {count}
                </span>
              {/if}
            </button>
          {:else}
            <p class="none">No section matches.</p>
          {/each}
        {/snippet}
      </CrumbPicker>
    {/if}

    {#if goal !== undefined}
      <IconAngleRight class="sep" width="12" height="12" />
      <CrumbPicker
        label="Switch goal"
        placeholder="Find goal…"
        width={340}
        bind:open={goalOpen}
        bind:query={goalQuery}
        onenter={() => {
          const first = goalRows[0];
          if (first !== undefined) pickGoal(first.goalId);
        }}
      >
        {#snippet trigger()}
          <IconGoal class="crumb-icon" width="13" height="13" />
          <span class="crumb-text">{goalName}</span>
        {/snippet}
        {#snippet rows()}
          {#each goalRows as row (row.goalId)}
            {@const current = row.goalId === app.openGoalId}
            {@const ended = row.status !== "active"}
            <button
              class="option"
              aria-current={current}
              onclick={() => pickGoal(row.goalId)}
            >
              <span class="option-main">
                <span class={["option-name", ended && "dim"]}>
                  {goalTitle(row)}
                </span>
                {#if ended}
                  <span class="option-sub faint">
                    {statusLabel(row.status).toLowerCase()}
                    {whenText(row.endedAt ?? row.createdAt)}
                  </span>
                {:else if countsLine(row.counts) !== ""}
                  <span class="option-sub">{countsLine(row.counts)}</span>
                {/if}
              </span>
              {#if current}
                <IconCheck class="option-end" width="14" height="14" />
              {:else if ended}
                <span class="ended">Ended</span>
              {/if}
            </button>
          {:else}
            <p class="none">No goal matches.</p>
          {/each}
        {/snippet}
        {#snippet footer()}
          <button
            class="foot-item"
            onclick={() => {
              goalOpen = false;
              app.closeGoal();
              app.openGoalDialog();
            }}
          >
            <IconPlus width="14" height="14" />
            New goal
          </button>
        {/snippet}
      </CrumbPicker>
    {/if}
  {:else if app.screen === "new-target"}
    <!--
      Above target scope, and two crumbs rather than one — the only place that happens up
      here. The first is a way back out, which matters on this screen because it is the one
      page above target scope that the operator can be *in* rather than at: A3 shows
      exactly this, and without the first crumb Cancel is the only exit.
    -->
    <button class="chip-back" onclick={() => app.cancelNewTarget()}>
      <IconGrid width="13" height="13" />
      All targets
    </button>
    <IconAngleRight class="sep" width="12" height="12" />
    <span class="crumb-leaf">New target</span>
  {:else}
    <!-- Above target scope: one chip, and nothing to switch it to. -->
    <span class="chip-all">
      <IconGrid width="13" height="13" />
      All targets
    </span>
  {/if}

  <div class="right">
    {#if app.reconnecting}
      <span class="chip" role="status">Reconnecting…</span>
    {/if}
    <button
      class="theme"
      onclick={() => app.toggleTheme()}
      aria-label="Switch to {app.theme === 'dark' ? 'light' : 'dark'} theme"
      title="Theme"
    >
      <IconTheme width="15" height="15" />
    </button>
  </div>
</header>

<style>
  .titlebar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: var(--titlebar-h);
    padding: 0 4px 0 0;
    background: var(--bg-deep);
    border-bottom: 1px solid var(--border-base);
  }
  .drawer,
  .theme {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .drawer {
    width: 38px;
    height: 38px;
    color: var(--icon-base);
  }
  .drawer[aria-pressed="false"] {
    color: var(--icon-muted);
  }
  .drawer:hover {
    background: var(--overlay-hover);
    color: var(--icon-base);
  }
  .theme {
    width: 30px;
    height: 30px;
    border-radius: 5px;
    color: var(--icon-muted);
  }
  .theme:hover {
    background: var(--overlay-hover);
    color: var(--icon-base);
  }

  .crumb-text {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .titlebar :global(.crumb-icon) {
    flex: none;
    color: var(--icon-muted);
  }
  .titlebar :global(.sep) {
    flex: none;
    color: var(--icon-faint);
  }

  .chip-all {
    display: flex;
    flex: none;
    align-items: center;
    gap: 7px;
    height: 26px;
    margin-left: 10px;
    padding: 0 8px;
    color: var(--text-base);
    font: 500 12px/16px var(--font-sans);
  }
  /* The same chip, but it goes somewhere. */
  .chip-back {
    display: flex;
    flex: none;
    align-items: center;
    gap: 7px;
    height: 26px;
    margin-left: 10px;
    padding: 0 8px;
    box-sizing: border-box;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-base);
    font: 500 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .chip-back:hover {
    background: var(--overlay-hover);
    border-color: var(--border-base);
  }
  .crumb-leaf {
    flex: none;
    padding: 0 2px;
    color: var(--text-base);
    font: 400 12px/16px var(--font-sans);
  }

  .section-count {
    flex: none;
    color: var(--text-muted);
    font: 500 12px/16px var(--font-mono);
  }
  .section-count.attention {
    color: var(--text-base);
  }
  .ended {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    color: var(--text-muted);
    font: 500 10px/14px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .right {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    margin-left: auto;
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
