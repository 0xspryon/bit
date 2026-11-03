<script lang="ts">
  /**
   * What the harness still holds of a settled attempt's conversation.
   *
   * **The minimum that makes the read path real**, and no more. It is not the live view:
   * the live stream and the tool-call rendering are `LiveTranscript.svelte`, which sits
   * above this one and is about a run that is still happening. This is the read-back of a
   * *settled* attempt, and the harness is its only source: bit keeps no copy of an agent's
   * conversation, so it is gone when the harness purges it — Claude Code deletes local
   * transcripts after `cleanupPeriodDays`, 30 by default.
   *
   * ## Three answers, and they read differently on purpose
   *
   * - **The harness has it** (`harness`) — shown, and labelled **"from the harness, may be
   *   gone"**. A screen that showed it as permanent would be promising a durability it
   *   does not have.
   * - **The harness does not hold it** (`absent`) — **gone**, rendered as normal and not as
   *   an error. For anything old enough that is the expected answer. It is not an empty
   *   conversation either: there are no entries to show, so none are drawn.
   * - **The harness could not be asked** (`unreachable`) — **neither**. It says nothing
   *   about whether the transcript still exists, so it is not shown as gone; it is shown as
   *   a failure to ask, which a retry can change.
   *
   * The server says why in its own `note` rather than this component guessing at a reason.
   *
   * ## The attempt is named by whoever mounts this
   *
   * `attemptId` is a prop and not a read of `App`, because there are two different ways to
   * have an attempt worth reading and each belongs to the section that has it. On **Goals**
   * it is `readableAttemptId`, the one attempt this tab started on this target — the only
   * handle a browser had on a settled attempt before there were URLs. On **Workers** it is
   * `transcriptAttemptId`, the attempt a link named: `/t/<targetId>/attempts/<attemptId>`
   * replays onto that section (`place.ts`, design decision 1), and without this panel there
   * the link would read a transcript into state that no screen could show. Empty means there
   * is nothing to ask about and nothing is drawn, which is the usual case on both.
   */
  import Button from "./Button.svelte";
  import type { App } from "../app.svelte";

  let { app, attemptId }: { app: App; attemptId: string } = $props();
  /** Whether what is on screen is about that attempt, rather than a previous read. */
  let current = $derived(
    app.transcript !== undefined && app.transcriptAttemptId === attemptId,
  );
</script>

{#if attemptId !== ""}
  <section class="transcript" aria-label="Attempt transcript">
    <div class="head">
      <span class="attempt mono" title="Attempt {attemptId}">{attemptId}</span>
      <Button
        size="sm"
        loading={app.transcriptLoading}
        onclick={() => void app.loadTranscript(app.viewTargetId, attemptId)}
      >
        {current ? "Reload transcript" : "Read transcript"}
      </Button>
    </div>

    {#if app.transcriptDetail !== ""}
      <p class="refusal" role="alert">{app.transcriptDetail}</p>
    {/if}

    {#if current && app.transcript !== undefined}
      {@const read = app.transcript}
      <!--
        The source label is text and not only a colour (§9): "may be gone" is the whole
        point of showing the harness's copy, and a tint nobody reads would not carry it.
      -->
      <p
        class="source"
        class:ephemeral={read.ephemeral}
        class:unreachable={read.source === "unreachable"}
      >
        <span class="source-tag">
          {read.source === "harness"
            ? "From the harness, may be gone"
            : read.source === "unreachable"
              ? "Could not ask the harness"
              : "No longer available"}
        </span>
        {read.note}
      </p>

      {#if read.entries.length > 0}
        <ol class="entries">
          {#each read.entries as entry (entry.index)}
            <li class="entry">
              <span class="entry-type mono">{entry.type}</span>
              {#if entry.error !== undefined}
                <span class="entry-error">{entry.error}</span>
              {/if}
              <!--
                `white-space: pre-wrap` rather than any parsing: the text is the harness's
                own and choosing how to structure it is the later slice's decision.
              -->
              <span class="entry-text">{entry.text}</span>
            </li>
          {/each}
        </ol>
        {#if read.truncated}
          <p class="meta">
            Shortened: this answer stopped before the end of the transcript.
          </p>
        {/if}
      {/if}
    {/if}
  </section>
{/if}

<style>
  .transcript {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px;
    border-top: 1px solid var(--border-muted);
    background: var(--bg-layer-01);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .attempt {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-faint);
    font-size: 11px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .source,
  .meta,
  .refusal {
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .source {
    color: var(--text-muted);
  }
  .source-tag {
    display: inline-block;
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    color: var(--text-base);
    font: 600 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* Amber, like an unavailable target: something that is here now and may not be later. */
  .source.ephemeral .source-tag {
    border-color: var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  /* Red, because "could not ask" is a failure a retry can change and "gone" is not. */
  .source.unreachable .source-tag {
    border-color: var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  .meta {
    color: var(--text-faint);
  }
  .refusal {
    color: var(--state-fg-danger);
  }
  .entries {
    display: flex;
    max-height: 220px;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 8px;
    overflow-y: auto;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    list-style: none;
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .entry-type {
    color: var(--text-faint);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .entry-error {
    color: var(--state-fg-danger);
    font-size: 11px;
  }
  .entry-text {
    color: var(--text-base);
    font-size: 12px;
    line-height: var(--lh-compact);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
