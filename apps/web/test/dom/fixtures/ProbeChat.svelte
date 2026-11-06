<script lang="ts">
  /**
   * A non-importer owner's chat as a page would mount it (A6 chat generalisation, slice 2):
   * the session `chatSessionOf` built, drawn by the real `ChatShell`. What the probe
   * owner's tests read the DOM of.
   */
  import type { ChatSession, ThreadTurn } from "../../../src/lib/chatShell";
  import ChatShell from "../../../src/lib/components/ChatShell.svelte";

  let { chat }: { chat: ChatSession<ThreadTurn> } = $props();
</script>

<ChatShell session={chat} id="probe" rootClass="probe">
  {#snippet footnote()}
    <p>Probe footnote.</p>
  {/snippet}
</ChatShell>
