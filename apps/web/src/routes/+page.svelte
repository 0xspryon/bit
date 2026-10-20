<script lang="ts">
  import { onMount } from "svelte";
  import { Schema } from "effect";
  import { apiPath, Health } from "@bit/contracts";

  let status = $state("Connecting…");
  onMount(() => {
    const controller = new AbortController();
    void fetch(apiPath("health"), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = Schema.decodeUnknownSync(Health)(await response.json());
        status = health.status;
      })
      .catch(() => {
        if (!controller.signal.aborted) status = "Server unavailable";
      });
    return () => controller.abort();
  });
</script>

<svelte:head
  ><title>bit</title><meta
    name="description"
    content="bit application foundation"
  /></svelte:head
>
<main>
  <h1>bit</h1>
  <p>Application foundation</p>
  <p role="status">Server: {status}</p>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #111827;
    color: #f3f4f6;
  }
  main {
    max-width: 48rem;
    margin: 5rem auto;
    padding: 0 1.5rem;
  }
  h1 {
    font-size: 3rem;
  }
</style>
