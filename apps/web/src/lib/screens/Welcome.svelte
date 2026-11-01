<script lang="ts">
  /**
   * All targets: the page above target scope, behind the first crumb.
   *
   * Every target this server knows, as a table. Create is in the page header, reading is
   * the row, and everything else done *to* a target lives in the row's overflow menu, with
   * delete below a rule and the only thing on this page in danger red. An unavailable
   * target says so next to its name rather than in a column, so a target with nothing wrong
   * carries no decoration at all.
   *
   * There is no rail here — you are above target scope — and the crumb bar is one chip
   * that does not switch.
   *
   * **The row menu is the design's, not yet the server's.** The registry has no endpoint to
   * edit, duplicate, export, archive or delete a target, so those entries are shown
   * disabled and say why, rather than looking like controls that silently do nothing.
   */
  import Badge from "../components/Badge.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import {
    IconArchive,
    IconCopy,
    IconCrosshairs,
    IconEllipsis,
    IconExport,
    IconPencil,
    IconPlus,
    IconSearch,
    IconTrash,
    IconWarning,
  } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let visible = $derived(
    app.targets.filter((target) =>
      target.name.toLowerCase().includes(app.search.trim().toLowerCase()),
    ),
  );

  /** The target whose row menu is open, or "" for none. */
  let menuFor = $state("");
  let menu = $state<HTMLDivElement | undefined>(undefined);

  const when = (lastActivity: string) =>
    lastActivity === "now" ? "just now" : `${lastActivity} ago`;

  const NOT_YET = "Not available yet: the server has no endpoint for this.";
</script>

<svelte:window
  onpointerdown={(event) => {
    if (menuFor === "" || menu === undefined) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".more") !== null
    )
      return;
    if (event.target instanceof Node && menu.contains(event.target)) return;
    menuFor = "";
  }}
  onkeydown={(event) => {
    if (menuFor !== "" && event.key === "Escape") menuFor = "";
  }}
/>

{#if app.reconnecting && !app.bannerDismissed}
  <Banner tone="danger" ondismiss={() => (app.bannerDismissed = true)}>
    Lost contact with the server. Reconnecting — what you see below is the last
    known state.
  </Banner>
{/if}

<div class="page">
  {#if app.targets.length === 0}
    <div class="centre">
      <div class="empty">
        <span class="empty-icon"><IconCrosshairs width="17" height="17" /></span
        >
        <h2>Add your first target</h2>
        <p>
          A target is one system you are testing. You give it a folder on your
          machine for its workers to run in; what they learn is recorded by the
          server, with its own fleet data.
        </p>
        <Button
          variant="primary"
          size="page"
          onclick={() => app.openNewTarget()}
        >
          <IconPlus width="14" height="14" />
          New target
        </Button>
      </div>
    </div>
  {:else}
    <header class="head">
      <div class="titles">
        <h1>Targets</h1>
        <p>
          Every system you have permission to investigate. Open one to see its
          goals.
        </p>
      </div>
      <Button variant="primary" size="page" onclick={() => app.openNewTarget()}>
        <IconPlus width="14" height="14" />
        New target
      </Button>
    </header>

    <label class="filter">
      <IconSearch width="14" height="14" />
      <input placeholder="Filter targets…" bind:value={app.search} />
    </label>

    {#if visible.length === 0}
      <div class="no-match">
        <p>Nothing matches “{app.search}”.</p>
        <Button variant="quiet" size="sm" onclick={() => (app.search = "")}>
          Clear filter
        </Button>
      </div>
    {:else}
      <div class="table" role="table" aria-label="Targets">
        <div class="cols" role="row">
          <span class="col-name" role="columnheader">Target</span>
          <span class="col-scope" role="columnheader">Scope</span>
          <span class="col-when" role="columnheader">Last activity</span>
          <span class="col-more" aria-hidden="true"></span>
        </div>

        <ul class="rows">
          {#each visible as target (target.id)}
            {@const missing = target.status === "missing"}
            <li class={["row", menuFor === target.id && "menu-open"]}>
              <button
                class="row-main"
                onclick={() => app.openTarget(target.id)}
              >
                <span class="col-name">
                  <Badge
                    name={target.name}
                    size={26}
                    letters={2}
                    tone={target.id === app.selectedId
                      ? "current"
                      : missing
                        ? "quiet"
                        : "plain"}
                  />
                  <span class={["name", missing && "dim"]}>{target.name}</span>
                  {#if missing}
                    <!-- The server's words for why, on hover; the target page says it in full. -->
                    <span class="warn" title={target.detail}>
                      <IconWarning width="13" height="13" />
                      Cannot be opened
                    </span>
                  {/if}
                </span>
                <span class="col-scope mono">{target.scope}</span>
                <span class="col-when mono">{when(target.lastActivity)}</span>
              </button>

              <div class="col-more">
                <button
                  class="more"
                  aria-label="Actions for {target.name}"
                  aria-haspopup="menu"
                  aria-expanded={menuFor === target.id}
                  onclick={() =>
                    (menuFor = menuFor === target.id ? "" : target.id)}
                >
                  <IconEllipsis width="15" height="15" />
                </button>

                {#if menuFor === target.id}
                  <div
                    class="menu"
                    role="menu"
                    aria-label="Actions for {target.name}"
                    bind:this={menu}
                  >
                    <button
                      class="menu-item"
                      role="menuitem"
                      disabled
                      title={NOT_YET}
                    >
                      <IconPencil width="14" height="14" /> Edit target
                    </button>
                    <button
                      class="menu-item"
                      role="menuitem"
                      disabled
                      title={NOT_YET}
                    >
                      <IconCopy width="14" height="14" /> Duplicate
                    </button>
                    <button
                      class="menu-item"
                      role="menuitem"
                      disabled
                      title={NOT_YET}
                    >
                      <IconExport width="14" height="14" /> Export report
                    </button>
                    <span class="menu-rule" role="separator"></span>
                    <button
                      class="menu-item"
                      role="menuitem"
                      disabled
                      title={NOT_YET}
                    >
                      <IconArchive width="14" height="14" /> Archive
                    </button>
                    <button
                      class="menu-item danger"
                      role="menuitem"
                      disabled
                      title={NOT_YET}
                    >
                      <IconTrash width="14" height="14" /> Delete target
                    </button>
                    <p class="menu-note">Not wired to the server yet.</p>
                  </div>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 28px;
    min-height: 0;
    padding: 40px 56px;
    overflow: auto;
    background: var(--bg-base);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 32px;
  }
  .titles {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 620px;
  }
  h1 {
    margin: 0;
    font: 530 26px/32px var(--font-sans);
    letter-spacing: -0.01em;
  }
  .titles p {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 19px;
    text-wrap: pretty;
  }

  .filter {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 360px;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
    color: var(--icon-muted);
  }
  .filter:focus-within {
    border-color: var(--border-strong);
  }
  .filter input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    font: 400 13px/18px var(--font-sans);
    outline: none;
  }
  .filter input::placeholder {
    color: var(--text-faint);
  }

  .no-match {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .no-match p {
    margin: 0;
  }

  /* ── Table ── */
  .table {
    display: flex;
    flex-direction: column;
  }
  .cols {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 0 12px 10px;
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-faint);
    font: 600 10px/14px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .col-name {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 11px;
    min-width: 0;
  }
  .col-scope {
    flex: none;
    width: 200px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .col-when {
    flex: none;
    width: 130px;
  }
  .col-more {
    position: relative;
    flex: none;
    width: 28px;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 6px 0 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 24px;
    padding-right: 12px;
    border-radius: var(--radius-md);
  }
  .row:hover,
  .row.menu-open {
    background: var(--overlay-hover);
  }
  .row-main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 24px;
    min-width: 0;
    padding: 12px 0 12px 12px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row-main .col-scope,
  .row-main .col-when {
    color: var(--text-muted);
    font-size: 12px;
    line-height: 18px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    color: var(--text-base);
    font: 600 14px/20px var(--font-sans);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .name.dim {
    color: var(--text-muted);
  }
  .warn {
    display: flex;
    flex: none;
    align-items: center;
    gap: 5px;
    color: var(--state-fg-warning);
    font-size: 12px;
    line-height: 16px;
  }

  .more {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .more:hover,
  .more[aria-expanded="true"] {
    background: var(--overlay-pressed);
    color: var(--icon-base);
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    width: 216px;
    padding: 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--bg-layer-01);
    box-shadow: 0 18px 48px #00000070;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-base);
    font: 400 13px/18px var(--font-sans);
    text-align: left;
    cursor: pointer;
  }
  .menu-item :global(svg) {
    flex: none;
    color: var(--icon-muted);
  }
  .menu-item:hover:not(:disabled) {
    background: var(--overlay-hover);
  }
  .menu-item.danger,
  .menu-item.danger :global(svg) {
    color: var(--state-fg-danger);
  }
  .menu-item.danger:hover:not(:disabled) {
    background: var(--state-bg-danger);
  }
  .menu-item:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .menu-rule {
    height: 1px;
    margin: 5px 2px;
    background: var(--border-muted);
  }
  .menu-note {
    margin: 4px 8px 2px;
    color: var(--text-muted);
    font-size: 11px;
    line-height: 15px;
  }

  /* ── First run ── */
  .centre {
    display: grid;
    flex: 1;
    place-items: center;
    padding: 24px;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 380px;
    text-align: center;
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    margin-bottom: 4px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-lg);
    color: var(--icon-faint);
  }
  .empty h2 {
    margin: 0;
    font: 530 15px/20px var(--font-sans);
  }
  .empty p {
    margin: 0 0 6px;
    color: var(--text-muted);
    font-size: 13px;
    line-height: var(--lh-base);
  }

  @media (max-width: 1024px) {
    .page {
      padding: 32px;
    }
    .col-scope {
      display: none;
    }
  }
</style>
