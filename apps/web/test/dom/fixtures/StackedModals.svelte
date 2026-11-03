<script lang="ts">
  /**
   * Dialogs opened inside one another and mounted in one update: a `Modal` inside a
   * `Modal`, or inside the harness picker, with optionally an `ErrorDialog` inside that.
   * Each is the real component; each closes by clearing the value its `{#if}` reads, as a
   * caller's would, which unmounts it and everything opened from inside it.
   *
   * `base` is what the stack stands on; `deep` adds the third dialog. All of them are open
   * from the first render: the fixture is mounted with them set and closes them only.
   */
  import { createRawSnippet } from "svelte";
  import ErrorDialog from "../../../src/lib/components/ErrorDialog.svelte";
  import HarnessDialog from "../../../src/lib/components/HarnessDialog.svelte";
  import Modal from "../../../src/lib/components/Modal.svelte";

  let {
    base = "modal",
    deep = false,
  }: { base?: "modal" | "picker"; deep?: boolean } = $props();

  let outerOpen = $state(true);
  let middleOpen = $state(true);
  let innerOpen = $state(true);
  let trigger = $state<HTMLButtonElement | null>(null);

  const text = (html: string) =>
    createRawSnippet(() => ({ render: () => html }));
</script>

<button type="button" class="trigger" bind:this={trigger}>Open</button>

{#snippet middle()}
  {#if middleOpen}
    <Modal
      title="Middle"
      onclose={() => (middleOpen = false)}
      body={middleBody}
      footer={text('<button type="button" class="middle-save">Save</button>')}
    />
  {/if}
{/snippet}

{#snippet middleBody()}
  <p>Something to lose.</p>
  {#if deep && innerOpen}
    <ErrorDialog
      title="Inner"
      sentence="The server refused that."
      ondismiss={() => (innerOpen = false)}
    />
  {/if}
{/snippet}

{#snippet outerBody()}
  <p>The form behind.</p>
  {@render middle()}
{/snippet}

{#if outerOpen}
  {#if base === "modal"}
    <Modal
      title="Outer"
      opener={trigger}
      onclose={() => (outerOpen = false)}
      body={outerBody}
      footer={text('<button type="button" class="outer-save">Save</button>')}
    />
  {:else}
    <HarnessDialog opener={trigger} onclose={() => (outerOpen = false)}>
      <button type="button" class="pick">claude-opus-5-5</button>
      {@render middle()}
    </HarnessDialog>
  {/if}
{/if}
