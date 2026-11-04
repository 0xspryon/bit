<script lang="ts">
  /**
   * A live reply whose text grows a delta at a time, as a streamed one does: the real
   * `Markdown`, given text a test sets through `write`.
   */
  import Markdown from "../../../src/lib/components/Markdown.svelte";

  let text = $state("");

  export const write = (next: string): void => {
    text = next;
  };
</script>

<Markdown {text} />
