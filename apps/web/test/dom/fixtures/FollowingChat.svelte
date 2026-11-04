<script lang="ts">
  /**
   * A thread `Chat` with one turn whose rows a test replaces through `write` (A6 U5 review):
   * the real component, its follow-while-pinned rule and its scroll container, with the
   * smallest snippets it needs.
   */
  import type { LiveItem } from "@bit/contracts";

  import { rowsFor, type ChatGroup } from "../../../src/lib/chat";
  import Chat from "../../../src/lib/components/Chat.svelte";

  let items = $state<readonly LiveItem[]>([]);
  let groups = $derived<readonly ChatGroup<string>[]>([
    {
      key: "turn:1",
      subject: "turn 1",
      prose: { _tag: "live" },
      rows: rowsFor(items, true),
    },
  ]);

  export const write = (next: readonly LiveItem[]): void => {
    items = next;
  };
</script>

{#snippet separator(group: ChatGroup<string>)}
  <span>{group.subject}</span>
{/snippet}
{#snippet footnote()}
  <span>footnote</span>
{/snippet}

<Chat
  label="Following"
  {groups}
  {separator}
  {footnote}
  readonly
  empty="Nothing yet."
  layout="thread"
/>
