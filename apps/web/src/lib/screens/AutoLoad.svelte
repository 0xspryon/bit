<script lang="ts">
  /**
   * Auto-load scope: the importer's page, reached from Assets (A6 D1).
   *
   * **A page, not a dialog.** D1 is explicit that it "opens a full importer session with
   * the target already in hand", so this is a sub-page of the Assets section — the target,
   * its rail and its crumbs are all still there, and nothing about the target is asked for
   * again. It is not a screen of its own: that would be a second place the target could be
   * half-open in.
   *
   * ## A conversation, not a machine (D2–D5)
   *
   * The body is {@link ImporterChat}: one multi-turn chat with an importer agent that
   * narrates every tool call it makes, so the narration is the transcript and there is no
   * separate panel of activity to keep honest. Corrections are messages. Sessions are
   * sticky per target, and the control for them lives in the crumb bar (`TitleBar`) because
   * a session belongs to the target and not to the message being typed.
   *
   * **It is driven by mock data**, for want of an importer API: see `app.importer`. The
   * link list, the model picker and the polled progress panel this page used to carry are
   * gone from it, and the state machine behind them (`startScopeImport`, `importerPhase`,
   * `ScopeImportPanel`) is left untouched and unreachable from here until the chat has a
   * real source to replace it with.
   *
   * **Opening it starts no hunt**, for the reason on the create-target page (D13): the
   * operator's review of what the importer wrote is the only control on it, and that review
   * is a real step only because an import never begins work.
   */
  import type { App } from "../app.svelte";
  import Button from "../components/Button.svelte";
  import ImporterChat from "../components/ImporterChat.svelte";
  import PageFrame from "../components/PageFrame.svelte";

  let { app }: { app: App } = $props();

  let target = $derived(app.selected?.name ?? app.viewTargetId);
</script>

<PageFrame
  title="Auto-load scope"
  description={`Talk the importer through ${target}'s program. It reads each page with its own browser, narrates every call it makes, and writes the in and out lists as scope entries and the hosts they name as assets.`}
  centered={app.drawerHidden}
>
  {#snippet actions()}
    <Button
      variant="outline"
      size="page"
      onclick={() => app.toSection("assets")}
    >
      Back to Assets
    </Button>
  {/snippet}

  {#snippet body()}
    <ImporterChat {app} />
  {/snippet}
</PageFrame>
