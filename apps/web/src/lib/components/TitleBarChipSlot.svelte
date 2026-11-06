<script lang="ts">
  /**
   * The title bar's place for chips a chat puts there (`titleBarChips.svelte.ts`): E8's
   * sub-agents chip, between the context meter and the session chip. Draws nothing while
   * nothing is placed, which is every chat today.
   */
  import { titleBarChips } from "../titleBarChips.svelte";

  const chips = titleBarChips();
</script>

{#each chips?.placed ?? [] as each (each.id)}
  {@render each.chip()}
{/each}
