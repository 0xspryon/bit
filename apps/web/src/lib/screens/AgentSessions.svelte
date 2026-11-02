<script lang="ts">
  /**
   * Every long-running agent session on this target, in one list: "what is running right now".
   *
   * ## Basic is the specification
   *
   * One row per session: which kind, what it is about, the harness and model, when it
   * started, live or not, and whatever tally that kind derives. **No grouping, no filters, no
   * detail pane** — the screens that show a session properly are the surfaces' own (the goal
   * page, the importer), and this page's job is to get you to them. Adding a filter row here
   * is how it becomes a fourth place that is wrong about what a session means.
   *
   * ## Live, ended, and the third thing
   *
   * `Live` is "this server holds the session right now" and `Ended` is "something recorded
   * that its authority is over". `Not running` is the honest third: the index has the row and
   * nothing here holds the session — every goal conversation after a restart. It is not
   * "ended", and a restart does not turn the list into one.
   *
   * A session whose harness this server no longer runs is **marked, not hidden**: the harness
   * may still hold it, and an operator looking for a session should find the row that says so.
   *
   * ## Row click, and the part that waits for URL routing
   *
   * **The destination of a row is a deep link, and this build cannot make one.** "Open the
   * importer on this session" and "open this goal's conversation" are addresses, and the app
   * has no URL routing: navigation is in-memory state (`App.navItem`, `openGoalId`,
   * `importerOpen`). A half-built router inside this slice would be a second routing
   * convention nothing else follows, so none is invented here.
   *
   * What a click does today is call the in-memory openers the Assets strip and the Goals list
   * already use — `App.openImporterSession` (which goes to Assets and selects the session on
   * the importer page) and `App.openGoalConversation` (which goes to Goals and opens the
   * goal, where its conversation is). Those are honest destinations, but they are state, not
   * addresses: they do not survive a reload, cannot be copied, and "back" does not know about
   * them. A worker row has **no** destination — there is no attempt screen to open, and the
   * Workers page is a placeholder — so it is inert rather than half-working.
   *
   * When real routing lands, each row becomes a plain `<a href>` and both shims are deleted:
   *
   *   importer  → /targets/:targetId/importer/:sessionId    (the importer page, selecting that session)
   *   goal      → /targets/:targetId/goals/:subjectId       (the goal page; the conversation is its compose area)
   *   worker    → /targets/:targetId/attempts/:subjectId    (once an attempt has a screen)
   *
   * Every id those need is already on the view (`sessionId`, `subjectId`), which is why the
   * route returns them. A link also fixes the one thing the shim cannot: opening an importer
   * session the importer's own index does not list yet (see `openImporterSession`'s reread).
   */
  import type { AgentSessionView } from "@bit/contracts";

  import {
    destinationOf,
    harnessOf,
    KIND_LABEL,
    stateLabel,
    stateTitle,
    tallySentence,
  } from "../agentSessions";
  import type { App } from "../app.svelte";
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import { sessionWhen } from "../importerChat";
  import { IconRobot } from "../icons";

  let { app }: { app: App } = $props();

  // The rows are this target's, or nothing: the list is dropped when the target changes, but
  // a render can land between the switch and that drop.
  let mine = $derived(app.agentSessionsTargetId === app.viewTargetId);
  let rows = $derived(mine ? app.agentSessions : []);

  const go = (session: AgentSessionView) => {
    switch (destinationOf(session.kind)) {
      case "importer":
        void app.openImporterSession(session.sessionId);
        return;
      case "goal":
        app.openGoalConversation(session.subjectId);
        return;
      case null:
        return;
    }
  };
</script>

{#snippet content(session: AgentSessionView)}
  {@const harness = harnessOf(session, app.harnesses, app.harnessesLoaded)}
  {@const tally = tallySentence(session.tally)}
  <span class="top">
    <span class={["kind", session.kind]}>{KIND_LABEL[session.kind]}</span>
    <span class="subject" title={session.subject}>{session.subject}</span>
    <span
      class={["state", session.state]}
      title={stateTitle(session)}
      data-state={session.state}>{stateLabel(session)}</span
    >
  </span>
  <span class="meta">
    <span class="harness">{harness.name}</span>
    <span class="mono model">{session.model ?? "model not recorded"}</span>
    <span class="mono when">{sessionWhen(session.startedAt, Date.now())}</span>
    {#if tally !== null}<span class="tally">{tally}</span>{/if}
    {#if harness.strandedOn !== undefined}
      <!-- Marked, not hidden: the harness this was minted on is not one this server runs,
           so nothing here can act on the session, though it may be alive there. -->
      <span
        class="stranded"
        title="This server does not run the harness instance this session was opened on, so it cannot be asked about it. It may still be alive there."
        >Harness “{harness.strandedOn}” is no longer configured</span
      >
    {/if}
  </span>
{/snippet}

<PageFrame
  title="Agent sessions"
  description="Every long-running agent session on this target — goal conversations, importer sessions and worker attempts — and whether this server holds it right now."
  centered={app.drawerHidden}
>
  {#snippet body()}
    {#if app.agentSessionsState === "failed" && rows.length === 0}
      <div class="notice">
        <Banner tone="danger">{app.agentSessionsDetail}</Banner>
        <Button onclick={() => void app.loadAgentSessions(app.viewTargetId)}>
          Try again
        </Button>
      </div>
    {:else if rows.length === 0 && app.agentSessionsState !== "ready"}
      <p class="quiet" role="status">Reading this target's agent sessions…</p>
    {:else if rows.length === 0}
      <div class="empty">
        <IconRobot width="28" height="28" />
        <p class="empty-lead">No agent sessions on this target yet.</p>
        <p class="empty-more">
          A session appears here once a goal conversation is opened, a scope
          import runs, or a worker attempt starts on its harness.
        </p>
      </div>
    {:else}
      {#if app.agentSessionsNote !== ""}
        <p class="refusal" role="alert">{app.agentSessionsNote}</p>
      {/if}
      <ul class="rows" aria-label="Agent sessions">
        {#each rows as session (session.key)}
          <li>
            {#if destinationOf(session.kind) !== null}
              <button class="row go" onclick={() => go(session)}>
                {@render content(session)}
              </button>
            {:else}
              <!-- Inert: there is no screen for a worker attempt to open yet. -->
              <div class="row">{@render content(session)}</div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if app.agentSessionsWorkersOmitted > 0}
        <p class="quiet-small" role="status">
          {app.agentSessionsWorkersOmitted} older worker {app.agentSessionsWorkersOmitted ===
          1
            ? "session is"
            : "sessions are"} not shown. Worker attempts accumulate with every intent,
          so the list holds the newest.
        </p>
      {/if}
    {/if}
  {/snippet}
</PageFrame>

<style>
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
    padding: 10px 12px;
    border: 0;
    border-bottom: 1px solid var(--border-muted);
    background: transparent;
    color: var(--text-base);
    font: 400 13px/18px var(--font-sans);
    text-align: left;
  }
  .row.go {
    cursor: pointer;
    transition: background var(--dur-hover) ease-out;
  }
  .row.go:hover {
    background: var(--overlay-hover);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .kind {
    flex: none;
    min-width: 62px;
    padding: 1px 8px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font: 500 11px/16px var(--font-sans);
    text-align: center;
  }
  .subject {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    flex: none;
    font: 400 12px/16px var(--font-sans);
    color: var(--text-muted);
  }
  /* Live is the one filled state; ended and not-running differ by words, not colour, as
     out-of-scope does on the Assets screen: neither is an error. */
  .state.live {
    padding: 1px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-layer-02);
    color: var(--text-base);
    font-weight: 500;
  }
  .state.dormant {
    font-style: italic;
  }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding-left: 72px;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 16px;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .stranded {
    padding: 0 7px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-base);
  }
  .refusal {
    margin: 0 0 12px;
    padding: 9px 12px;
    border: 1px solid var(--state-border-danger);
    border-radius: var(--radius-md);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: 18px;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .quiet {
    margin: 0;
    color: var(--text-muted);
  }
  .quiet-small {
    margin: 14px 12px 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 520px;
    margin: 48px auto;
    color: var(--icon-faint);
    text-align: center;
  }
  .empty-lead {
    margin: 0;
    font: 530 20px/28px var(--font-sans);
    color: var(--text-base);
  }
  .empty-more {
    margin: 0;
    font: 400 13px/20px var(--font-sans);
    color: var(--text-muted);
    text-wrap: pretty;
  }
</style>
