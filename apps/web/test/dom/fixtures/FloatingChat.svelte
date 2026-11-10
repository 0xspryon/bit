<script lang="ts">
  /**
   * A `Chat` with the floating composer: one turn whose rows a test replaces through
   * `write`, and a composer whose box gives way to a dock stand-in on `setDock(true)`, which
   * is also when the box stops resting.
   */
  import type { LiveItem } from "@bit/contracts";

  import { rowsFor, type ChatGroup } from "../../../src/lib/chat";
  import Chat from "../../../src/lib/components/Chat.svelte";

  let {
    layout = "panel",
    docked = false,
  }: { layout?: "panel" | "thread"; docked?: boolean } = $props();

  // Read once: whether the dock is up at mount.
  // svelte-ignore state_referenced_locally
  let dock = $state(docked);
  export const setDock = (open: boolean): void => {
    dock = open;
  };

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
{#snippet composer()}
  {#if dock}
    <section class="question-dock" tabindex="-1">A question for you</section>
  {:else}
    <textarea id="box"></textarea>
  {/if}
{/snippet}

<Chat
  label="Floating"
  {groups}
  {separator}
  {footnote}
  {composer}
  {layout}
  floating
  composerResting={!dock}
  readonly={false}
  empty="Nothing yet."
/>
