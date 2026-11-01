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
    <!-- Level 1: above target scope. One crumb, and the table of targets is the navigation. -->
    <TitleBar {app} />
    <Welcome {app} />
  {:else if app.screen === "new-target"}
    <!--
      Level 1 as well: a page above target scope, because the target it is about does not
      exist yet. A3 turns what was a dialog into this, and keeps only the folder browser
      modal — which `NewTarget` mounts itself, since it is the one thing on that page
      whose state nothing else reads.
    -->
    <TitleBar {app} />
    <NewTarget {app} />
  {:else}
    <!-- Level 2: the crumb bar plus the target's own rail. -->
    <TitleBar {app} />
    <Target {app} />
  {/if}

  <!--
    The import's error toast (D15).

    Every link failing is not an error state *for the target*: the operator has already been
    moved on to its Assets screen by the time this shows, and this says why. It is the one
    toast in the application, and it is here rather than in a screen because the screen it
    belongs to is not the screen that raised it.

    **`role="alert"`, and the danger tones.** It is still not an error state, but it is a
    failure being reported: the import read nothing, or could not start. `role="status"` is
    polite — a screen reader finishes what it is saying and may never reach this — and the
    amber of a warning said something milder than the panel's own `tone="danger"` banner
    about the same event. One event, one severity, on both surfaces.

    **It does not time out, on purpose.** On the path that matters this toast carries the
    importer's own account of why nothing was read, which can be the only explanation the
    operator ever gets (the panel it would have been on is gone by then). A message that
    takes itself away mid-sentence would be worse than one that waits to be dismissed, and
    it blocks nothing while it waits.
  -->
  {#if app.toast !== ""}
    <div class="toast" role="alert">
      <p>{app.toast}</p>
      <button
        class="toast-close"
        aria-label="Dismiss"
        onclick={() => app.dismissToast()}>×</button
      >
    </div>
  {/if}
</div>

<!-- Inside a target the Live dock carries this toggle; see `ScenarioBar`. -->
{#if app.screen !== "target"}<ScenarioBar {app} />{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-base);
    color: var(--text-base);
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    max-width: 560px;
    padding: 12px 14px;
    box-sizing: border-box;
    /* The panel's banner for the same event is `tone="danger"`. One severity, both
       surfaces — and never colour alone, since the toast says what happened in words. */
    border: 1px solid var(--state-border-danger);
    border-radius: var(--radius-md);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
    box-shadow: var(--elevation-overlay);
  }
  .toast p {
    margin: 0;
    font-size: 12px;
    line-height: var(--lh-base);
    text-wrap: pretty;
  }
  .toast-close {
    flex: none;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.8;
  }
  .toast-close:hover {
    opacity: 1;
  }
</style>
