<script lang="ts">
  /**
   * The harness picker open, with a refusal of a pick shown from inside it — the shape U3
   * gives the importer, where the picker stays open after a pick. The picker's real
   * `HarnessDialog` and the real `ErrorDialog`, with a stand-in for the columns: one row
   * whose click is refused.
   */
  import ErrorDialog, {
    type ErrorNotice,
  } from "../../../src/lib/components/ErrorDialog.svelte";
  import HarnessDialog from "../../../src/lib/components/HarnessDialog.svelte";

  let pickerOpen = $state(true);
  let failure = $state<ErrorNotice | undefined>();
  let trigger = $state<HTMLButtonElement | null>(null);
</script>

<button type="button" class="trigger" bind:this={trigger}>Harness</button>

{#if pickerOpen}
  <HarnessDialog opener={trigger} onclose={() => (pickerOpen = false)}>
    <button
      type="button"
      class="pick"
      onclick={() =>
        (failure = {
          title: "Model not switched",
          sentence: "The harness would not switch to claude-opus-5-5.",
        })}
    >
      claude-opus-5-5
    </button>
    {#if failure !== undefined}
      <ErrorDialog {...failure} ondismiss={() => (failure = undefined)} />
    {/if}
  </HarnessDialog>
{/if}
