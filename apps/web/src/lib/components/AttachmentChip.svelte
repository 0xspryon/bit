<script lang="ts">
  /**
   * One file an operator's message carried, in that message's turn (A6 U13): what it is
   * called, a thumbnail when it is an image, a way to open it and a copy of its path.
   *
   * The same live and after a reload: the turn knows the file by its stored path either way
   * (the server's answer, the harness's transcript), and the bytes are asked of the server
   * by that path ({@link attachmentLoader}) — for an image's thumbnail as the chip appears,
   * for any other file only when it is opened. Nothing about the path is trusted here or
   * there: the server serves only a file in a session's own `uploads/` folder.
   *
   * **Opening never runs the file as the page.** A blob URL is bit's own origin, so only
   * what a tab shows inertly is opened in one — the four image types, a PDF, text forced
   * to `text/plain` ({@link openableType}); anything else is saved under its name.
   *
   * **The path is what is copied**, because it is what the agent was told: an operator
   * pointing the agent at "the second screenshot" again, or at it from a shell, needs the
   * path, not the bytes.
   *
   * **A file no longer stored** (`missing`, U13 review 3: moved aside or deleted since the
   * message was sent) keeps its chip, so the turn still says what it carried, and says it is
   * gone: no open, no thumbnail, and the path still copies, since it is what the agent was
   * told.
   */
  import type { MessageAttachmentView } from "@bit/contracts";

  import { attachmentLoader, openableType } from "../attachmentFiles";
  import { IconFile } from "../icons";
  import CopyButton from "./CopyButton.svelte";

  let { attachment }: { attachment: MessageAttachmentView } = $props();

  const load = attachmentLoader();

  /** The thumbnail's object URL, once the image's bytes are here. */
  let thumbnail = $state<string | undefined>(undefined);
  /** Why the file could not be had, in the server's words, once asked and refused. */
  let unavailable = $state<string | undefined>(undefined);

  const blobOf = (bytes: Uint8Array, type: string): Blob =>
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type });

  $effect(() => {
    if (
      attachment.kind !== "image" ||
      attachment.missing === true ||
      load === undefined
    )
      return;
    const type = openableType(attachment.mimeType);
    if (type === undefined || !type.startsWith("image/")) return;
    let url: string | undefined;
    let gone = false;
    void load(attachment.path).then((loaded) => {
      if (gone) return;
      if (loaded._tag === "none") {
        unavailable = loaded.detail;
        return;
      }
      url = URL.createObjectURL(blobOf(loaded.bytes, type));
      thumbnail = url;
    });
    return () => {
      gone = true;
      if (url !== undefined) URL.revokeObjectURL(url);
      thumbnail = undefined;
    };
  });

  /**
   * Opens the file in a new tab, or saves it. The tab is opened **before** the bytes are
   * asked for, while the click still counts as the operator's, so no popup blocker stands
   * between them; it is closed again if the server has no such file.
   */
  async function open(): Promise<void> {
    if (load === undefined) return;
    const type = openableType(attachment.mimeType);
    if (type !== undefined && thumbnail !== undefined) {
      window.open(thumbnail, "_blank");
      return;
    }
    const tab = type === undefined ? null : window.open("", "_blank");
    const loaded = await load(attachment.path);
    if (loaded._tag === "none") {
      tab?.close();
      unavailable = loaded.detail;
      return;
    }
    unavailable = undefined;
    const url = URL.createObjectURL(
      blobOf(loaded.bytes, type ?? "application/octet-stream"),
    );
    if (tab !== null) {
      tab.location.href = url;
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.name;
      link.click();
    }
    // Long enough for the tab or the download to have read it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
</script>

<li
  class={[
    "attachment",
    `attachment-${attachment.kind}`,
    attachment.missing === true && "attachment-missing",
  ]}
>
  {#if attachment.missing === true}
    <span class="gone" title={`${attachment.name} is no longer stored`}>
      <span class="glyph" aria-hidden="true"
        ><IconFile width="14" height="14" /></span
      >
      <span class="label">
        <span class="name">{attachment.name}</span>
        <span class="note">no longer stored</span>
      </span>
    </span>
  {:else}
    <button
      class="open"
      type="button"
      title={unavailable === undefined
        ? `Open ${attachment.name}`
        : `${attachment.name} is not available: ${unavailable}`}
      disabled={load === undefined}
      onclick={() => void open()}
    >
      {#if thumbnail !== undefined}
        <img class="thumb" src={thumbnail} alt="" />
      {:else}
        <span class="glyph" aria-hidden="true"
          ><IconFile width="14" height="14" /></span
        >
      {/if}
      <span class="name">{attachment.name}</span>
    </button>
  {/if}
  <CopyButton
    text={attachment.path}
    label={`Copy the path of ${attachment.name}`}
  />
  {#if unavailable !== undefined}
    <span class="visually-hidden" role="status"
      >{attachment.name} is not available: {unavailable}</span
    >
  {/if}
</li>

<style>
  .attachment {
    display: inline-flex;
    max-width: 100%;
    min-width: 0;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 3px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 8px;
    background: var(--bg-layer-01);
  }
  .open {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 7px;
    padding: 0 2px 0 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-base);
    font: 400 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .open:hover:not(:disabled) .name {
    text-decoration: underline;
  }
  .open:disabled {
    cursor: default;
  }
  .open:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .thumb {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 5px;
    object-fit: cover;
    background: var(--bg-layer-02);
  }
  .glyph {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 5px;
    background: var(--bg-layer-02);
    color: var(--icon-muted);
  }
  .gone {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 7px;
    padding: 0 2px 0 0;
    color: var(--text-muted);
    font: 400 12px/16px var(--font-sans);
  }
  .gone .glyph {
    color: var(--icon-faint);
  }
  .label {
    display: inline-flex;
    min-width: 0;
    flex-direction: column;
  }
  .note {
    font-size: 11px;
    line-height: 14px;
  }
  .attachment-missing {
    border-style: dashed;
  }
  .name {
    min-width: 0;
    max-width: 240px;
    overflow: hidden;
    unicode-bidi: isolate;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
