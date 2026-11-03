<script lang="ts">
  /**
   * Flow A shell, on the route that answers every path.
   *
   * The three screens from `docs/design/flow-a-getting-in.md`, against the real control
   * plane: Connect exchanges the server password for a session, the target rail reads
   * the registry, and the New target dialog browses the filesystem server-side. The
   * state picker is still mounted below, for comparing states without reproducing the
   * conditions that cause them.
   *
   * **It also owns the URL**, which is the one piece of state that is not in `App`. The
   * place on screen — which target, which section, which record, in the grammar of
   * `lib/place.ts` — is reflected into the path, and the path is read back at the two
   * moments a URL can arrive from outside: at mount, and on a `popstate`. So a link to a
   * resource opens that resource, so does a reload, and so does Back — three spellings of
   * one thing from the operator's side. It stays in this file because `$app/navigation` is
   * SvelteKit's, and `App` is a plain class that a test or a second shell can construct
   * without a router. `App` does not see the grammar either: the only thing it holds for
   * the URL's sake is an opaque path string, and `App.requestedPath` says why.
   *
   * **Why a catch-all, `[...place]`.** A path has to resolve in development as well as in
   * the build: the `adapter-static` fallback covers the built app only, and SvelteKit's
   * dev server still routes from files, so `/t/acme-corp` answered 404 before this
   * directory existed. It is needed for the reflection below too, not only for a cold
   * load — a shallow `goto` resolves its intent against the route table like any other,
   * so a path with no route would be refused on the way out as well as on the way in.
   *
   * One catch-all, and nothing beside it: a rest parameter matches zero segments, so this
   * file answers `/` as well. A `+page.svelte` left at the root would have claimed `/`
   * ahead of it and the app would mount through one of two routes depending on the URL it
   * was opened with — two nodes rendering one shell, for no gain, since the shell reads
   * the URL from `location` and never from `params`. The parameter is named for what it
   * carries and is never read.
   */
  import { untrack } from "svelte";

  import { goto } from "$app/navigation";

  import Banner from "../../lib/components/Banner.svelte";
  import ScenarioBar from "../../lib/components/ScenarioBar.svelte";
  import TitleBar from "../../lib/components/TitleBar.svelte";
  import Connect from "../../lib/screens/Connect.svelte";
  import NewTarget from "../../lib/screens/NewTarget.svelte";
  import Target from "../../lib/screens/Target.svelte";
  import Welcome from "../../lib/screens/Welcome.svelte";
  import { App } from "../../lib/app.svelte";
  import { placeArrivedAt } from "../../lib/arrival";
  import {
    applyPlace,
    parsePath,
    pathOf,
    placeOf,
    type Place,
  } from "../../lib/place";
  import { historyWrite } from "../../lib/placeHistory";

  const app = new App();

  /**
   * How many places the URL has asked for that the app has not yet reached.
   *
   * Applying a place is not instant for all eight of them: `applyPlace` reaches a chat by
   * reading the importer's index first, an attempt by reading its transcript, and a goal by
   * confirming after the fact that the goal exists. So between the call and the answer the
   * app stands either on the page *above* the place that was asked for, or on a goal page
   * that may turn out to be empty. Neither is somewhere the operator went, and the
   * reflection below is
   * suppressed until this returns to zero, for the same reason it is suppressed while a
   * place is held across Connect: there is nothing true to write yet.
   *
   * This mattered less before S4 and matters now. Under a reflection that always replaced,
   * writing the intermediate page was an invisible flicker of the address bar; under one
   * that can push it is a junk history entry for every deep link to a chat or an attempt,
   * and a second one when the real place lands.
   *
   * A counter rather than a flag, so that two traversals in flight at once cannot have the
   * first to answer lift the suppression the second still needs.
   */
  let applying = $state(0);

  /**
   * Applies a place the URL asked for, and says so for as long as it takes.
   *
   * The one way into `applyPlace` from a URL — both discrete moments below go through here
   * — and deliberately not the way a click goes. Following a chat row applies a place too
   * (`AgentSessions.svelte`), and that is the operator moving the app, which is the event
   * the reflection exists to write down rather than to wait out.
   *
   * The `catch` is for the shape rather than for a known thrower: `applyPlace` hands back
   * whatever the `App` method it called hands back, and a rejection from a URL nobody is
   * waiting on would otherwise be an unhandled one.
   */
  const applyFromUrl = (place: Place): void => {
    applying += 1;
    void applyPlace(app, place)
      .catch((cause: unknown) => {
        console.warn("could not open the place the URL asked for", cause);
      })
      .finally(() => {
        applying -= 1;
      });
  };

  /**
   * One attempt to resume a session a reload left behind, and the place the URL asked
   * for.
   *
   * `$effect` with no reactive reads, so it runs once after mount and never again. It
   * asks the server rather than trusting the stored token — the session registry is in
   * memory, so a restart has already invalidated it and nothing here can know that
   * without asking. Until it answers the Connect screen is what is shown, which is the
   * correct thing to show when the app does not yet know whether it is signed in.
   *
   * The place is read *before* `restore()` and released by it: a deep link may well
   * arrive with no session at all, in which case it waits behind the Connect screen and
   * is replayed below once there is one. `location` rather than `page.url` because this
   * runs once at mount and the answer wanted is the URL the tab was opened with.
   *
   * What is held is `pathOf` of the place, not the text that arrived, and that is where an
   * old `?target=<id>` bookmark is translated — once, here, by `placeArrivedAt`. Past this
   * line the app knows one spelling of a place, and the reflection below writes it into
   * the address bar. The target list is not held: there is nothing for a link to the root
   * to restore, and holding it would suppress the reflection for ever.
   */
  $effect(() => {
    const place = placeArrivedAt(location.pathname, location.search);
    if (place.kind !== "targets") {
      app.requestPlace(place.targetId, pathOf(place));
    }
    void app.restore();
  });

  /**
   * The held place, replayed at the moment `App` says it can be.
   *
   * `App` carries the path across Connect and releases it once the target list is in
   * hand, by either way in — a fresh sign-in or a resumed session — because a link should
   * land in the same place either way. This is the half that knows what the path says.
   * Taking it empties it, so a place is replayed once and not on every later change.
   *
   * `untrack` around the replay, because `applyPlace` reads much of the state it then
   * writes — `screen`, `viewTargetId` — and tracking those would re-run this effect on
   * every screen change for nothing. The read that must stay tracked is the one in
   * `takeReplayPath`, which is what wakes it.
   *
   * Declared before the reflection so that within one flush the place lands before the
   * URL is written. The other order would reflect the target list first and the place
   * second, replacing an address bar nobody had read yet.
   */
  $effect(() => {
    const path = app.takeReplayPath();
    if (path === "") return;
    untrack(() => {
      applyFromUrl(parsePath(path));
    });
  });

  /**
   * Back and Forward: the second and last moment the URL is read.
   *
   * **A bare `popstate` listener, and not one of SvelteKit's three alternatives.** The
   * reasons are specific to this version and were read out of `@sveltejs/kit@3.1.0`'s
   * `src/runtime/client/client.js` rather than remembered, because the writes below are
   * *shallow* and shallow routing is where that file keeps its surprises:
   *
   * - **`page.url` from `$app/state` is not the address bar here.** A shallow `goto` never
   *   touches it — `update_state` updates `page.state` and `page.shallow` and nothing else
   *   (`client.js:2953`) — so it still holds the URL the tab was loaded with, and on a
   *   `popstate` the router sets it back to that same stale URL (`client.js:2173`). An
   *   effect over it would read the bookmark the operator arrived on, for ever, rather than
   *   where they have walked to.
   * - **`afterNavigate` is stale for the same reason.** The entry a shallow write leaves
   *   carries `pageUrl: page.url.href` (`client.js:2929`) — the load URL, not the one just
   *   written — and that is the URL the popstate handler navigates to (`client.js:3323`).
   *   So `navigation.to.url` is not the entry the browser traversed to either.
   * - **`page.shallow.url` is correct and still wrong to use.** It is set from
   *   `location.href` on a traversal (`client.js:3357`) and it is reactive — but it is also
   *   set by our own `goto` (`client.js:2957`), so an effect over it would read back what
   *   this component had just written. That is precisely the two-writers race the one-way
   *   rule exists to prevent, re-admitted through a side door.
   *
   * What is left is the DOM's own event, and it is the better answer rather than the
   * remaining one. `location` during a `popstate` is the entry the browser has already
   * traversed to, with no router indirection between the fact and the read. And the browser
   * fires `popstate` for a traversal and for nothing else — never for the `pushState` or
   * `replaceState` a `goto` performs. So **the writer cannot wake the reader**: not by this
   * file's good manners but by the event's definition, which is the first of the two things
   * that make the feedback loop impossible rather than unlikely.
   *
   * SvelteKit's own listener runs too, and does that stale-URL navigation: our entries never
   * satisfy its shallow test (`client.js:3329` compares the stored `pageUrl` against
   * `location.href`, and they differ by construction). It is noise rather than a conflict —
   * it writes no history entry, because a popped navigation skips both branches that would,
   * and it does not touch `App`. The one thing it must not do is unmount this component,
   * which would take the `App` above with it. It does not: the route node is the same
   * catch-all and only the data is re-applied, which is what a marker left on `window`
   * proved across three traversals when this slice was driven in a browser.
   *
   * **A traversal while the Connect gate is up is held, not applied.** Behind the gate there
   * is no session, so opening a target would only be refused — the same situation a cold
   * deep link is in, so it takes the same road: `App` carries the place and releases it once
   * there is a session. Holding also keeps the reflection suppressed, so the URL the
   * operator walked to survives until there is something true to say about it.
   *
   * `placeArrivedAt` rather than `parsePath`, so that the two readers of a URL cannot
   * disagree about one. The only entry in this tab's history this app did not write is the
   * one the tab was opened with, and that one may still be spelled `?target=<id>`; the first
   * reflection replaces it, so Back does not reach it in practice, and reading it through
   * the same translation the mount uses costs nothing.
   */
  $effect(() => {
    const traversed = (): void => {
      const place = placeArrivedAt(location.pathname, location.search);
      if (app.screen === "connect") {
        // The root holds nothing — there is no resource to restore, and a held root would
        // suppress the reflection for the rest of the visit — so walking back to it at the
        // gate drops what was held rather than replacing it.
        if (place.kind === "targets") app.requestPlace("", "");
        else app.requestPlace(place.targetId, pathOf(place));
        return;
      }
      applyFromUrl(place);
    };
    window.addEventListener("popstate", traversed);
    return () => {
      window.removeEventListener("popstate", traversed);
    };
  });

  /**
   * The place on screen, reflected into the path.
   *
   * One writer: state is the source of truth and the URL follows it. Reading the URL back
   * on every change would mean two writers for one fact and a race between them on every
   * click; the URL is read at discrete moments only — at mount, and on a traversal.
   *
   * **Nothing is written while the app is not yet where it has been asked to be.** Three
   * conditions, one rule, and the rule is that a URL should say where the operator *is*
   * rather than where they are on the way to. A place held across Connect: the gate is not
   * a place, so `placeOf` reads the target list while it is up, and writing that would throw
   * away the link the tab was opened with — a reload on the Connect screen would land on the
   * list instead of on the bookmark. A place released and not yet replayed, which is the
   * same instant seen from the other side. And a place being applied, which is `applying`
   * above.
   *
   * **What makes the feedback loop impossible.** The URL is written only when it does not
   * already say what the state says — `historyWrite` answers `"skip"` otherwise — and a
   * traversal that is applied successfully ends in exactly that equality, because
   * `parsePath` and `pathOf` are inverses over every place and `applyPlace` puts the app in
   * the place it was handed. So the apply-then-reflect cycle has no first step: no write, so
   * no second hop to loop on and no entry to accumulate. That is the half this effect owns;
   * the reader above owns the other half.
   *
   * **A failed arrival corrects its entry rather than adding one**, which is design D5's
   * half of this effect and the third thing `historyWrite` is told. A standing
   * `app.arrivalNote` means the last thing that happened was a link landing on the nearest
   * place that exists instead of the place it named — so the entry in the address bar names
   * nothing, and the write that follows is a correction of it. Reading the note here is
   * also what *wakes* this effect for the fallbacks that answer a round trip late: the
   * registry refusing a target comes back after `applying` has already returned to zero.
   *
   * The note is not cleared here. `App` clears it on the operator's next navigation, which
   * is the moment the sentence stops being about anything on screen, and it is the same
   * moment the next write goes back to pushing.
   *
   * `shallow: true` so this updates the address bar without running a navigation: there is
   * one route and nothing to load. `replace` comes from `historyWrite`, which is D4's
   * "opening a resource pushes a history entry; everything else replaces" turned into a
   * decision — a change of path pushes, a change of query or of spelling replaces. The
   * `catch` is not decoration: a rejected navigation must not take the screen down with it,
   * and an address bar that lags is a far smaller problem than an app that crashes on it.
   */
  $effect(() => {
    if (app.requestedPath !== "" || app.replayPath !== "" || applying > 0) {
      return;
    }
    const next = pathOf(placeOf(app));
    const write = historyWrite(
      location,
      next,
      app.arrivalNote === "" ? "landed" : "fell-back",
    );
    if (write === "skip") return;
    void goto(new URL(next, location.href), {
      shallow: true,
      replace: write === "replace",
      state: {},
    }).catch((cause: unknown) => {
      console.warn("could not reflect the place into the URL", cause);
    });
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
  {:else}
    <!--
      The crumb bar, on every screen above the gate. Hoisted out of the three branches
      below so that the arrival banner has one place to sit: under the chrome and above
      whatever page a link landed on.
    -->
    <TitleBar {app} />

    <!--
      What a link that outlived its resource has to say (design D5).

      **One site, three landing places.** A dead target lands on the target list, a dead
      goal on that target's goal list, a dead chat session on its Agent sessions list — so
      a banner owned by any one screen would be missing from the other two, which is the
      bug D5 names: the sentence for a dead chat already existed and was written to the
      Agent sessions list's own banner, where an operator arriving from a bookmark never
      saw it. Rendering it here means every page a fallback can reach has it by
      construction, and a fourth fallback added later inherits the surface.

      **In the document flow, not floating.** It pushes the page down rather than covering
      a row of it, and it reads as part of the page the link landed on rather than as a
      system notification about one. The import's toast below is the other choice and the
      right one for *that* message, which belongs to no screen at all.

      `tone="info"` and `role="status"` from `Banner`: nothing has failed here. A bookmark
      got old, which is a fact rather than an error, and dressing it in the danger tones
      the import failure uses would say something untrue about the severity. It is
      dismissible and it does not time out — see `App.arrivalNote` for why waiting is the
      whole point.

      Not rendered on the Connect screen, which has no chrome and nothing to be above;
      `signOut` retires the note so one cannot wait behind the gate for a later session.
    -->
    {#if app.arrivalNote !== ""}
      <Banner tone="info" ondismiss={() => app.dismissArrivalNote()}>
        {app.arrivalNote}
      </Banner>
    {/if}

    {#if app.screen === "welcome"}
      <!-- Level 1: above target scope. The table of targets is the navigation. -->
      <Welcome {app} />
    {:else if app.screen === "new-target"}
      <!--
        Level 1 as well: a page above target scope, because the target it is about does not
        exist yet. A3 turns what was a dialog into this, and keeps only the folder browser
        modal — which `NewTarget` mounts itself, since it is the one thing on that page
        whose state nothing else reads.
      -->
      <NewTarget {app} />
    {:else}
      <!-- Level 2: the target's own rail, under the crumb bar. -->
      <Target {app} />
    {/if}
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
    /* `dvh`, not `vh`: on a tablet whose browser toolbar retracts, `100vh` is the
       *large* viewport, so the shell stands taller than the room it has and the
       document scrolls the whole app — header, rail and composer included. The
       shell is the only full-height box here, so it is the only one that can
       cause that; the panels below clamp with `dvh` for the narrower reason that
       a popover sized against the large viewport overhangs the visible one. */
    height: 100dvh;
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
