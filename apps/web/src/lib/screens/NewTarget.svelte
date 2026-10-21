<script lang="ts">
  /**
   * The New target dialog.
   *
   * The tree is the server's answer, not the browser's: every row comes from
   * `GET /api/v1/folders`, which is bounded by a configured root and refuses `..` and
   * symlinks. The three failure states below are each driven by a typed error the server
   * sent, with the server's own wording shown rather than a translation of it.
   */
  import Button from "../components/Button.svelte";
  import Field from "../components/Field.svelte";
  import Modal from "../components/Modal.svelte";
  import { IconAngleRight, IconFolder, IconLevelUp } from "../icons";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  /**
   * The path field's own text.
   *
   * Seeded from, and re-seeded by, whatever the server last listed. Separate from
   * `app.dialogPath` so that a half-typed path does not look like the folder currently
   * being shown.
   */
  let pathDraft = $state("");
  $effect(() => {
    pathDraft = app.dialogPath;
  });

  let canCreate = $derived(
    app.dialogChosen !== "" &&
      app.dialogName !== "" &&
      app.createState !== "duplicate" &&
      app.createState !== "denied" &&
      app.createState !== "creating",
  );
</script>

<Modal title="New target" onclose={() => (app.dialogOpen = false)}>
  {#snippet body()}
    <!--
      The path is a form, not a bound field: typing into it changes nothing until it is
      submitted, because every change is a server round trip that can be refused.
    -->
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void app.browseTo(pathDraft);
      }}
    >
      <Field
        id="folder-path"
        label="Folder"
        mono
        bind:value={pathDraft}
        error={app.dialogPathError}
        disabled={app.createState === "creating"}
      />
    </form>

    <div class="tree" role="listbox" aria-label="Folders">
      {#if app.dialogParent !== null}
        <button
          class="node up"
          onclick={() => void app.browseTo(app.dialogParent ?? undefined)}
        >
          <span class="arrow"><IconLevelUp width="11" height="11" /></span>
          <span class="mono">..</span>
        </button>
      {/if}
      {#each app.dialogEntries as entry (entry.path)}
        <button
          class={["node", app.dialogChosen === entry.path && "chosen"]}
          onclick={() => app.chooseFolder(entry.path)}
          ondblclick={() => void app.browseTo(entry.path)}
          role="option"
          aria-selected={app.dialogChosen === entry.path}
        >
          <span class="arrow"><IconAngleRight width="10" height="10" /></span>
          <span class="arrow"><IconFolder width="12" height="12" /></span>
          <span class="mono">{entry.name}</span>
        </button>
      {/each}
      {#if app.dialogEntries.length === 0 && !app.dialogBusy}
        <p class="tree-empty">No folders here.</p>
      {/if}
    </div>

    <p class="resolved mono">
      {app.dialogChosen === "" ? "No folder chosen" : app.dialogChosen}
    </p>

    {#if app.createState === "duplicate"}
      <div class="alert warning" role="alert">
        <strong>Already a target.</strong>
        {app.createDetail}. Open it instead?
        <div class="alert-action">
          <Button
            size="sm"
            onclick={() => {
              app.select(app.duplicateOf);
              app.dialogOpen = false;
            }}>Open {app.duplicateOf}</Button
          >
        </div>
      </div>
    {/if}

    {#if app.createState === "denied"}
      <div class="alert warning" role="alert">
        <strong>That folder cannot be used.</strong>
        {app.createDetail} Choose another folder, or grant access and try again.
      </div>
    {/if}

    {#if app.createState === "failed"}
      <div class="alert danger" role="alert">
        <strong>This target could not be prepared.</strong> It is registered and
        listed, but its database did not migrate, so it shows as unavailable in
        the rail. Your other targets are unaffected and still open.
        <code class="mono trace">{app.createDetail}</code>
      </div>
    {/if}

    <Field
      id="target-name"
      label="Name"
      bind:value={app.dialogName}
      disabled={app.createState === "creating"}
    />
    <Field
      id="target-scope"
      label="Scope"
      mono
      placeholder="*.example.test"
      bind:value={app.dialogScope}
      disabled={app.createState === "creating"}
    />
  {/snippet}

  {#snippet footer()}
    <Button variant="quiet" onclick={() => (app.dialogOpen = false)}>
      Cancel
    </Button>
    <Button
      variant="primary"
      disabled={!canCreate}
      loading={app.createState === "creating"}
      onclick={() => app.createTarget()}
    >
      {app.createState === "creating" ? "Preparing…" : "Create target"}
    </Button>
  {/snippet}
</Modal>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    height: 190px;
    overflow: auto;
    padding: 4px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  .node {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-base);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .node:hover {
    background: var(--overlay-hover);
  }
  .node.chosen {
    background: var(--bg-layer-02);
  }
  /* --icon-faint equals --bg-layer-03, so a chosen row would hide its icons. */
  .node.chosen .arrow {
    color: var(--icon-base);
  }
  .arrow {
    display: inline-flex;
    align-items: center;
    color: var(--icon-faint);
  }
  .tree-empty {
    margin: 0;
    padding: 8px;
    font-size: 12px;
    color: var(--text-faint);
  }
  .resolved {
    margin: -8px 0 0;
    font-size: 12px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .alert {
    padding: 12px 14px;
    border-radius: var(--radius-md);
    font-size: 12px;
    line-height: var(--lh-base);
  }
  .alert strong {
    font-weight: 600;
  }
  .warning {
    border: 1px solid var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  .danger {
    border: 1px solid var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  .alert-action {
    margin-top: 10px;
  }
  .trace {
    display: block;
    margin-top: 8px;
    font-size: 11px;
    opacity: 0.85;
  }
</style>
