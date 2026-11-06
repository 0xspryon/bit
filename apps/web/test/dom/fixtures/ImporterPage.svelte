<script lang="ts">
  /**
   * The importer's page as `+page.svelte` mounts it, for the DOM suite: the title bar and
   * the target screen under **one** title-bar chip holder, so a chip the chat places
   * (A7-S's sub-agents chip) is drawn in the bar as on the real page.
   */
  import type { App } from "../../../src/lib/app.svelte";
  import TitleBar from "../../../src/lib/components/TitleBar.svelte";
  import Target from "../../../src/lib/screens/Target.svelte";
  import { provideTitleBarChips } from "../../../src/lib/titleBarChips.svelte";

  let { app }: { app: App } = $props();

  provideTitleBarChips();
</script>

<TitleBar {app} />
<Target {app} />
