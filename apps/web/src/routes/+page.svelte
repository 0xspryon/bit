<script lang="ts">
  /**
   * Flow A shell.
   *
   * The three screens from `docs/design/flow-a-getting-in.md`, against the real control
   * plane: Connect exchanges the server password for a session, the target rail reads
   * the registry, and the New target dialog browses the filesystem server-side. The
   * state picker is still mounted below, for comparing states without reproducing the
   * conditions that cause them.
   *
   * **It also owns the URL**, which is the one piece of state that is not in `App`. The
   * open target is reflected into `?target=<id>` and read back out of it on load, so a
   * link to a target opens that target — and so does a reload, which is the same thing
   * from the operator's side. It stays in this file because `$app/navigation` is
   * SvelteKit's, and `App` is a plain class that a test or a second shell can construct
   * without a router.
   */
  import { goto } from "$app/navigation";

  import ScenarioBar from "../lib/components/ScenarioBar.svelte";
  import TitleBar from "../lib/components/TitleBar.svelte";
  import Connect from "../lib/screens/Connect.svelte";
  import NewTarget from "../lib/screens/NewTarget.svelte";
  import Target from "../lib/screens/Target.svelte";
  import Welcome from "../lib/screens/Welcome.svelte";
  import { App } from "../lib/app.svelte";

  const app = new App();

  /** The query parameter a deep link to a target carries. */
  const TARGET_PARAM = "target";

  /**
   * One attempt to resume a session a reload left behind, and the target the URL asked
   * for.
   *
   * `$effect` with no reactive reads, so it runs once after mount and never again. It
   * asks the server rather than trusting the stored token — the session registry is in
   * memory, so a restart has already invalidated it and nothing here can know that
   * without asking. Until it answers the Connect screen is what is shown, which is the
   * correct thing to show when the app does not yet know whether it is signed in.
   *
   * The requested target is read *before* `restore()` and acted on by it: a deep link may
   * well arrive with no session at all, in which case it waits behind the Connect screen
   * and opens once there is one. `location` rather than `page.url` because this runs once
   * at mount and the answer wanted is the URL the tab was opened with.
   */
  $effect(() => {
    const requested = new URLSearchParams(location.search).get(TARGET_PARAM);
    if (requested !== null && requested !== "") app.requestTarget(requested);
    void app.restore();
  });

  /**
   * The open target, reflected into the URL.
   *
   * One direction only: state is the source of truth and the URL follows it. Reading the
   * URL back on every change would mean two writers for one fact and a race between them
   * on every click; the URL is read once, at mount, above.
   *
   * `shallow: true` so this updates the address bar without running a navigation —
   * there is one route and nothing to load — and `replace: true` so opening three targets
   * does not leave three history entries on the way back out. The `catch` is not
   * decoration: a rejected navigation must not take the screen down with it, and an
   * address bar that lags is a far smaller problem than an app that crashes on it.
   */
  $effect(() => {
    const open = app.screen === "target" ? app.selectedId : "";
    const url = new URL(location.href);
    if (open === "") url.searchParams.delete(TARGET_PARAM);
    else url.searchParams.set(TARGET_PARAM, open);
    if (url.href === location.href) return;
    void goto(url, { shallow: true, replace: true, state: {} }).catch(
      (cause: unknown) => {
        console.warn("could not reflect the open target into the URL", cause);
      },
    );
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
