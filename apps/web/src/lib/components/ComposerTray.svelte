<script lang="ts">
  /**
   * The files a composer holds before Send (A6 U13), inside its border above the words:
   * a thumbnail for an image the model will see, a glyph for any other file, the name and
   * the size, and a way to take each one out again.
   *
   * The size is the browser's figure for the file, which is the one the server's caps are
   * about. The name is the file's own; the server may store it under a cleaned-up one
   * (no quotes, no path), which the sent turn's chip then shows.
   */
  import { sizeLabel, type ComposerFiles } from "../composerFiles.svelte";
  import { IconClose, IconFile } from "../icons";

  let {
    files,
    disabled = false,
  }: { files: ComposerFiles; disabled?: boolean } = $props();
</script>

{#if files.items.length > 0}
  <ul
    class="tray"
    aria-label={files.items.length === 1
      ? "1 file to send with this message"
      : `${String(files.items.length)} files to send with this message`}
  >
    {#each files.items as item (item.id)}
      <li class="pending" title={item.file.name}>
        {#if item.preview !== undefined}
          <img class="thumb" src={item.preview} alt="" />
        {:else}
          <span class="glyph" aria-hidden="true"
            ><IconFile width="14" height="14" /></span
          >
        {/if}
        <span class="text">
          <span class="name">{item.file.name}</span>
          <span class="size">{sizeLabel(item.file.size)}</span>
        </span>
        <button
          class="remove"
          type="button"
          {disabled}
          aria-label={`Remove ${item.file.name}`}
          title={`Remove ${item.file.name}`}
          onclick={() => files.remove(item.id)}
        >
          <IconClose width="11" height="11" />
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .tray {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pending {
    display: inline-flex;
    max-width: 260px;
    min-width: 0;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 4px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 8px;
    background: var(--bg-layer-02);
  }
  .thumb,
  .glyph {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 5px;
  }
  .thumb {
    object-fit: cover;
    background: var(--bg-layer-01);
  }
  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-layer-01);
    color: var(--icon-muted);
  }
  .text {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .name {
    overflow: hidden;
    unicode-bidi: isolate;
    color: var(--text-base);
    font: 400 12px/16px var(--font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--text-muted);
    font: 400 11px/14px var(--font-mono);
  }
  .remove {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .remove:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--icon-base, var(--text-base));
  }
  .remove:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
</style>
