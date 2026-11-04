<script lang="ts">
  /**
   * A thread's rows as `Chat` draws them (A6 U5): `rowsFor` over the feed, rebuilt from
   * nothing on every arrival, each row a narrated `ChatItem` keyed as the chat keys it. A
   * test puts a new feed through `write`, as `App.applyLiveFrame` replaces `liveItems`.
   */
  import type { LiveItem } from "@bit/contracts";

  import { rowsFor } from "../../../src/lib/chat";
  import ChatItem from "../../../src/lib/components/ChatItem.svelte";

  let items = $state<readonly LiveItem[]>([]);
  let rows = $derived(rowsFor(items, true));

  export const write = (next: readonly LiveItem[]): void => {
    items = next;
  };
</script>

<ol>
  {#each rows as row (row.key)}
    <ChatItem item={row.item} stream={row.stream} narrated />
  {/each}
</ol>
