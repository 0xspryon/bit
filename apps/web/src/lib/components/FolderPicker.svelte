<script lang="ts">
  /**
   * The folder browser: the only modal A3 leaves standing.
   *
   * It was the middle of the New target dialog and is now its own thing, because the
   * dialog became a page and the tree was the one part of it that genuinely wants to be
   * modal. A3's own words: *"The picker does one thing and hands back one value, so it can
   * be modal without trapping anything: open it, choose, land back on the form with the
   * path filled and every other field as you left it."*
   *
   * The tree is the server's answer, not the browser's: every row comes from
   * `GET /api/v1/folders`, which is bounded by a configured root and refuses `..` and
   * symlinks. A refusal is shown as the server worded it rather than translated, because
   * the five reasons it can give (`traversal`, `symlink`, `outside_root`, `not_absolute`,
   * `denied`) are distinctions the operator needs and this screen has no better words for.
   */
  import Button from "./Button.svelte";
  import Field from "./Field.svelte";
  import Modal from "./Modal.svelte";
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

  /**
   * What "Use this folder" would hand back: the selected row, else the folder on screen.
   *
   * `dialogSelection` and not `dialogChosen`: the form's folder is not this modal's
   * selection, and reading it here is what left the button handing back a folder the
   * operator had navigated away from — with the refusal about that folder still on the
   * form behind it.
   */
  let resolved = $derived(
    app.dialogSelection !== "" ? app.dialogSelection : app.dialogPath,
  );
</script>

<Modal title="Choose a folder" onclose={() => (app.folderPickerOpen = false)}>
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
        label="Browsing"
        mono
        bind:value={pathDraft}
        error={app.dialogPathError}
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
          class={["node", app.dialogSelection === entry.path && "chosen"]}
          onclick={() => app.selectFolder(entry.path)}
          ondblclick={() => void app.browseTo(entry.path)}
          role="option"
          aria-selected={app.dialogSelection === entry.path}
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

    <!--
      It confirms the chosen path in words, which A3 asks for and which is the only thing
      standing between a double-click that navigated and one that selected.

      Labelled, because it is the second path on screen: the field above is the folder
      being *listed* and this is the folder that would be *used*. Unlabelled, the two were
      indistinguishable, which is how an operator came to type a new path and press a
      button that handed back the old one.
    -->
    <p class="resolved">
      <span class="resolved-label">Use</span>
      <span class="mono">{resolved === "" ? "No folder chosen" : resolved}</span
      >
    </p>
  {/snippet}

  {#snippet footer()}
    <Button variant="quiet" onclick={() => (app.folderPickerOpen = false)}>
      Cancel
    </Button>
    <Button
      variant="primary"
      disabled={resolved === ""}
      onclick={() => app.useChosenFolder()}
    >
      Use this folder
    </Button>
  {/snippet}
</Modal>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    height: 220px;
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
  .resolved-label {
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
  }
  .resolved {
    margin: -8px 0 0;
    font-size: 12px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
