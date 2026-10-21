<script lang="ts">
  /**
   * Flow A shell.
   *
   * The three screens from `docs/design/flow-a-getting-in.md`, against the real control
   * plane: Connect exchanges the server password for a session, the target rail reads
   * the registry, and the New target dialog browses the filesystem server-side. The
   * state picker is still mounted below, for comparing states without reproducing the
   * conditions that cause them.
   */
  import ScenarioBar from "../lib/components/ScenarioBar.svelte";
  import TitleBar from "../lib/components/TitleBar.svelte";
  import Connect from "../lib/screens/Connect.svelte";
  import NewTarget from "../lib/screens/NewTarget.svelte";
  import Target from "../lib/screens/Target.svelte";
  import Welcome from "../lib/screens/Welcome.svelte";
  import { App } from "../lib/app.svelte";

  const app = new App();

  /**
   * One attempt to resume a session a reload left behind.
   *
   * `$effect` with no reactive reads, so it runs once after mount and never again. It
   * asks the server rather than trusting the stored token — the session registry is in
   * memory, so a restart has already invalidated it and nothing here can know that
   * without asking. Until it answers the Connect screen is what is shown, which is the
   * correct thing to show when the app does not yet know whether it is signed in.
   */
  $effect(() => {
    void app.restore();
  });

  // The token sheet is scoped to :root, so the theme has to land on <html>.
  $effect(() => {
    const theme = app.theme;
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.dataset.theme = theme;
    const frame = requestAnimationFrame(() => {
      root.classList.remove("theme-switching");
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<svelte:head>
  <title>bit · Hunt Platform</title>
</svelte:head>

<div class="app">
  {#if app.screen === "connect"}
    <!-- Level 0: no chrome. There is nothing to navigate to yet. -->
    <Connect {app} />
  {:else if app.screen === "welcome"}
    <!-- Level 1: title bar only. The target rail is the navigation. -->
    <TitleBar {app} />
    <Welcome {app} />
  {:else}
    <!-- Level 2: title bar plus the target's own navigation. -->
    <TitleBar {app} />
    <Target {app} />
  {/if}

  {#if app.dialogOpen}
    <NewTarget {app} />
  {/if}
</div>

<ScenarioBar {app} />

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-base);
    color: var(--text-base);
  }
</style>
