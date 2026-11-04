<script lang="ts">
  // Self-hosted, so the app renders in the faces the design was drawn in rather
  // than in whatever the machine happens to have. Imported before the tokens that
  // name them. OpenCode bundles the same two families; we take them from
  // Fontsource instead of @ibm/plex because it ships woff2 and a variable Inter.
  import "@fontsource-variable/inter";
  import "@fontsource/ibm-plex-mono/400.css";
  // A highlighted fence's keywords are mono at 500 (A6 U11). Without the face the browser
  // draws 500 as 400 and the weight says nothing; each file is fetched only when used.
  import "@fontsource/ibm-plex-mono/500.css";
  import "../lib/styles/tokens.css";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
