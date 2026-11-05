<script lang="ts">
  /**
   * The files one operator's message carried, as chips in its turn (A6 U13): under the
   * importer's bubble, right-aligned with it, and under a goal turn's words. One
   * {@link AttachmentChip} each; the list is named for a screen reader by how many.
   */
  import type { MessageAttachmentView } from "@bit/contracts";

  import AttachmentChip from "./AttachmentChip.svelte";

  let {
    attachments,
    align = "start",
  }: {
    attachments: readonly MessageAttachmentView[];
    align?: "start" | "end";
  } = $props();
</script>

{#if attachments.length > 0}
  <ul
    class={["attachments", align === "end" && "end"]}
    aria-label={attachments.length === 1
      ? "1 file sent with this message"
      : `${String(attachments.length)} files sent with this message`}
  >
    {#each attachments as attachment, index (`${String(index)}:${attachment.path}`)}
      <AttachmentChip {attachment} />
    {/each}
  </ul>
{/if}

<style>
  .attachments {
    display: flex;
    max-width: 560px;
    min-width: 0;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .attachments.end {
    justify-content: flex-end;
  }
</style>
