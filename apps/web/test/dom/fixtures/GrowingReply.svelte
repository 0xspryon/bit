<script lang="ts">
  /**
   * A live reply whose text grows a delta at a time, as a streamed one does: the real
   * `Markdown`, given text a test sets through `write`, and the highlighter a test gives it.
   */
  import Markdown from "../../../src/lib/components/Markdown.svelte";
  import { appHighlights, type Highlights } from "../../../src/lib/highlight";

  let { highlights = appHighlights }: { highlights?: Highlights } = $props();

  let text = $state("");

  export const write = (next: string): void => {
    text = next;
  };
</script>

<Markdown {text} {highlights} />
