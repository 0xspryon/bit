<script lang="ts">
  /**
   * The harness picker open, with a refusal of a pick shown from inside it — the shape U3
   * gives the importer, where the picker stays open after a pick. The picker's real
   * `HarnessDialog` and the real `ErrorDialog`, with a stand-in for the columns: one row
   * whose click is refused.
   *
   * `refusedAtOpen` mounts both in one update: the picker opening with the caller's
   * refusal already set, so the error renders inside it as it renders.
   */
  import ErrorDialog, {
    type ErrorNotice,
  } from "../../../src/lib/components/ErrorDialog.svelte";
  import { untrack } from "svelte";
  import HarnessDialog from "../../../src/lib/components/HarnessDialog.svelte";

  let { refusedAtOpen = false }: { refusedAtOpen?: boolean } = $props();

  const REFUSAL: ErrorNotice = {
    title: "Model not switched",
    sentence: "The harness would not switch to claude-opus-5-5.",
  };

  let pickerOpen = $state(true);
  // Only the first value matters: the fixture is mounted with it and never changes it.
  let failure = $state<ErrorNotice | undefined>(
    untrack(() => (refusedAtOpen ? REFUSAL : undefined)),
  );
  let trigger = $state<HTMLButtonElement | null>(null);
</script>

<button type="button" class="trigger" bind:this={trigger}>Harness</button>

{#if pickerOpen}
  <HarnessDialog opener={trigger} onclose={() => (pickerOpen = false)}>
    <button type="button" class="pick" onclick={() => (failure = REFUSAL)}>
      claude-opus-5-5
    </button>
    {#if failure !== undefined}
      <ErrorDialog {...failure} ondismiss={() => (failure = undefined)} />
    {/if}
  </HarnessDialog>
{/if}
