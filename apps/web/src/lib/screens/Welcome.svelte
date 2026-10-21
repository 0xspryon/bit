<script lang="ts">
  import Badge from "../components/Badge.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import {
    IconCog,
    IconCrosshairs,
    IconFolderOpen,
    IconHelp,
    IconPencil,
    IconPlus,
    IconSearch,
    IconStream,
    IconTrash,
    IconWarning,
  } from "../icons";
  import { hunts, huntGroups } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let visible = $derived(
    hunts.filter(
      (h) =>
        h.targetId === app.selectedId &&
        h.title.toLowerCase().includes(app.search.toLowerCase()),
    ),
  );
  let targetHunts = $derived(
    hunts.filter((h) => h.targetId === app.selectedId),
  );
</script>

{#if app.reconnecting && !app.bannerDismissed}
  <Banner tone="danger" ondismiss={() => (app.bannerDismissed = true)}>
    Lost contact with the server. Reconnecting — what you see below is the last
    known state.
  </Banner>
{/if}

<div class="welcome">
  <!-- ── Target rail ── -->
  <nav class="rail" aria-label="Targets">
    <div class="rail-head">
      <span class="label">Targets</span>
      <button
        class="icon"
        aria-label="New target"
        onclick={() => app.openDialog()}
      >
        <IconPlus width="12" height="12" />
      </button>
    </div>

    <ul class="targets">
      {#each app.targets as target (target.id)}
        <li
          class={[
            "row",
            target.id === app.selectedId && "selected",
            target.status === "missing" && "missing",
          ]}
        >
          <button class="row-main" onclick={() => app.select(target.id)}>
            <Badge name={target.name} />
            <span class="row-label">
              <span class="row-name">
                {#if target.status === "missing"}
                  <IconWarning class="warn-icon" width="11" height="11" />
                {/if}
                {target.name}
              </span>
              <span class="row-path mono">{target.path}</span>
            </span>
          </button>
          {#if target.status === "missing"}
            <span class="chip">Missing</span>
          {:else}
            <span class="when">{target.lastActivity}</span>
            <span class="actions">
              <button class="icon sm" aria-label="Reveal folder">
                <IconFolderOpen width="12" height="12" />
              </button>
              <button class="icon sm" aria-label="Rename">
                <IconPencil width="12" height="12" />
              </button>
              <button class="icon sm" aria-label="Remove">
                <IconTrash width="12" height="12" />
              </button>
            </span>
          {/if}
        </li>
      {/each}
    </ul>

    {#if app.targets.length === 0}
      <p class="rail-empty">None yet.</p>
    {/if}

    <div class="rail-foot">
      <button class="foot">
        <IconCog width="13" height="13" /> Settings
      </button>
      <button class="foot">
        <IconHelp width="13" height="13" /> Help
      </button>
    </div>
  </nav>

  <!-- ── Hunts ── -->
  <section class="hunts" aria-label="Hunts">
    {#if app.targets.length === 0}
      <div class="centre">
        <div class="empty">
          <span class="empty-icon"
            ><IconCrosshairs width="17" height="17" /></span
          >
          <h2>Add your first target</h2>
          <p>
            A target is one system you are testing. It gets a folder on your
            machine, and everything the agent learns about it is recorded there.
          </p>
          <Button variant="primary" onclick={() => app.openDialog()}>
            New target
          </Button>
          <p class="kbd">Or press <kbd>N</kbd></p>
        </div>
      </div>
    {:else if app.selected?.status === "missing"}
      <div class="search-bar">
        <span class="search-wrap">
          <IconSearch class="search-icon" width="13" height="13" />
          <input
            class="search"
            placeholder="Search hunts in {app.selected.name}"
            disabled
          />
        </span>
      </div>
      <div class="centre">
        <div class="empty">
          <span class="empty-icon warn"
            ><IconWarning width="17" height="17" /></span
          >
          <h2>This target cannot be opened</h2>
          <p class="mono path">{app.selected.path}</p>
          <!--
            The server's own words for why. One `missing` state covers every reason a
            target is unavailable — a deleted folder, a missing database, a migration
            that failed — and the sentence is where the distinction lives, because it is
            the only part the operator acts on differently.
          -->
          <p>
            {app.selected.detail ??
              "Nothing has been deleted. What this target recorded is still in the registry and becomes readable again as soon as its folder is back."}
          </p>
          <div class="pair">
            <Button onclick={() => {}}>Locate folder…</Button>
            <Button variant="quiet" onclick={() => {}}>Remove target</Button>
          </div>
        </div>
      </div>
    {:else}
      <div class="search-bar">
        <span class="search-wrap">
          <IconSearch class="search-icon" width="13" height="13" />
          <input
            class="search"
            placeholder="Search hunts in {app.selected?.name ?? ''}"
            bind:value={app.search}
          />
        </span>
      </div>

      {#if targetHunts.length === 0}
        <div class="centre">
          <div class="empty">
            <span class="empty-icon"><IconStream width="17" height="17" /></span
            >
            <h2>No hunts yet</h2>
            <p>
              This target is ready. Start an investigation and it will appear
              here.
            </p>
            <Button
              variant="primary"
              onclick={() => app.openTarget(app.selectedId)}>New hunt</Button
            >
          </div>
        </div>
      {:else if visible.length === 0}
        <div class="centre">
          <div class="empty">
            <span class="empty-icon"><IconSearch width="17" height="17" /></span
            >
            <h2>Nothing matches “{app.search}”</h2>
            <p>
              {targetHunts.length} hunts on this target, none with that in the title.
            </p>
            <Button variant="quiet" onclick={() => (app.search = "")}>
              Clear search
            </Button>
          </div>
        </div>
      {:else}
        <div class="list">
          {#each huntGroups as group (group)}
            {@const rows = visible.filter((h) => h.group === group)}
            {#if rows.length > 0}
              <div class="group-head">
                <span class="label">{group}</span>
                {#if group === "Today"}
                  <Button
                    size="sm"
                    onclick={() => app.openTarget(app.selectedId)}
                  >
                    + New hunt
                  </Button>
                {/if}
              </div>
              {#each rows as hunt (hunt.id)}
                <button
                  class="hunt"
                  onclick={() => app.openTarget(app.selectedId)}
                >
                  <Badge name={app.selected?.name ?? "?"} size={16} />
                  <span class="hunt-title">{hunt.title}</span>
                  <span class="hunt-when">{hunt.when}</span>
                </button>
              {/each}
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  .welcome {
    display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }

  /* ── Rail ── */
  .rail {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border-base);
    background: var(--bg-base);
    min-height: 0;
  }
  .rail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 12px 8px 16px;
  }
  .label {
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .targets {
    list-style: none;
    margin: 0;
    padding: 0 8px;
    flex: 1;
    overflow: auto;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-md);
    background: var(--bg-base);
    transition: background var(--dur-hover) ease-out;
  }
  .row:hover,
  .row:focus-within {
    background: var(--bg-layer-01);
  }
  .row.selected {
    background: var(--bg-layer-02);
  }
  .row.missing {
    opacity: 0.75;
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row-label {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
  }
  /* The label fades where the action strip slides over it, instead of
     being pushed — no layout shift on hover. */
  .row:hover .row-label,
  .row:focus-within .row-label {
    mask-image: linear-gradient(
      to right,
      black 0,
      black calc(100% - 44px),
      transparent calc(100% - 36px)
    );
  }
  .row-name {
    font-size: 13px;
    color: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-path {
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The class lands on the icon component's own <svg>, so it needs :global. */
  :global(.warn-icon) {
    display: inline-block;
    vertical-align: -1px;
    color: var(--state-fg-warning);
  }
  .when {
    padding-right: 10px;
    font-size: 11px;
    color: var(--text-faint);
  }
  .actions {
    position: absolute;
    right: 0;
    display: none;
    align-items: center;
    gap: 2px;
    padding: 0 8px 0 10px;
    height: 100%;
    background: linear-gradient(to right, transparent, var(--bg-layer-01) 8px);
  }
  .row:hover .actions,
  .row:focus-within .actions {
    display: flex;
  }
  .row.selected:hover .actions {
    background: linear-gradient(to right, transparent, var(--bg-layer-02) 8px);
  }
  .row:hover .when {
    opacity: 0;
  }
  .chip {
    margin-right: 10px;
    padding: 2px 7px;
    border: 1px solid var(--state-border-warning);
    border-radius: var(--radius-sm);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .rail-empty {
    margin: 0;
    padding: 4px 16px;
    font-size: 12px;
    color: var(--text-faint);
  }
  .rail-foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-top: 1px solid var(--border-muted);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: 400 12px/var(--lh-compact) var(--font-sans);
    text-align: left;
    cursor: pointer;
  }
  .foot:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    font-size: 14px;
    cursor: pointer;
  }
  .icon.sm {
    width: 22px;
    height: 22px;
    font-size: 12px;
  }
  .icon:hover {
    background: var(--overlay-pressed);
    color: var(--text-base);
  }

  /* ── Hunts ── */
  .hunts {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg-base);
  }
  .search-bar {
    padding: 12px 16px;
    flex: none;
  }
  .search-wrap {
    position: relative;
    display: block;
  }
  :global(.search-icon) {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-faint);
    pointer-events: none;
  }
  .search {
    width: 100%;
    height: 34px;
    padding: 0 12px 0 32px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 400 13px/var(--lh-base) var(--font-sans);
  }
  .search::placeholder {
    color: var(--text-faint);
  }
  .search:disabled {
    opacity: 0.5;
  }
  .list {
    padding: 4px 8px 16px;
    overflow: auto;
  }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 8px 6px;
  }
  .hunt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .hunt:hover {
    background: var(--bg-layer-01);
  }
  .hunt-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hunt-when {
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  /* ── Empty states ── */
  .centre {
    flex: 1;
    display: grid;
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
    font-size: 15px;
  }
  .empty-icon.warn {
    border-color: var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  .empty h2 {
    margin: 0;
    font: 530 15px/20px var(--font-sans);
  }
  .empty p {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-base);
    color: var(--text-muted);
  }
  .empty .path {
    font-size: 12px;
    color: var(--text-faint);
  }
  .pair {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .kbd {
    font-size: 11px !important;
    color: var(--text-faint) !important;
  }
  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xs);
    background: var(--bg-layer-01);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  @media (max-width: 1024px) {
    .welcome {
      grid-template-columns: 220px minmax(0, 1fr);
    }
  }
</style>
