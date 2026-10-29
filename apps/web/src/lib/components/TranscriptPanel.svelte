<script lang="ts">
  /**
   * What a settled attempt left behind, and how durable it is.
   *
   * **The minimum that makes the read path real**, and no more. It is not the live view:
   * the live stream and the tool-call rendering are `LiveTranscript.svelte`, which sits
   * above this one and is about a run that is still happening. This is the read-back of
   * what a *settled* attempt left behind, and its two sources are not equal-status data.
   * What this does is prove the thing Part 3 is about — that an attempt's transcript can be
   * read back after the harness session is gone, and that the two sources are not presented
   * as the same kind of thing.
   *
   * ## Three answers, and they read differently on purpose
   *
   * - **Ours** (`recorded`) — written into the target's `evidence/` directory when the
   *   attempt settled, content-hashed. The system of record. Shown plainly, with the hash
   *   so it can be matched against the file.
   * - **The harness's** (`harness`) — asked for now, and labelled **"from the harness, may
   *   be gone"**. It is the richer view while it lasts and it lasts only as long as the
   *   harness keeps it: Claude Code deletes local transcripts after `cleanupPeriodDays`, 30
   *   by default. A screen that showed it as equal-status data would be promising a
   *   durability it does not have.
   * - **Neither** (`absent`) — rendered as **normal**, not as an error. For anything old
   *   enough that is the expected answer, and the server says so in its own `note` rather
   *   than this component guessing at a reason.
   */
  import Button from "./Button.svelte";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  /** The attempt there is something to ask about: the last this tab started here. */
  let attemptId = $derived(app.readableAttemptId);
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
      <p class="source" class:ephemeral={read.ephemeral}>
        <span class="source-tag">
          {read.source === "recorded"
            ? "Recorded by this server"
            : read.source === "harness"
              ? "From the harness, may be gone"
              : "No transcript"}
        </span>
        {read.note}
      </p>

      {#if read.source === "recorded" && read.contentHash !== undefined}
        <p class="meta mono">sha256 {read.contentHash}</p>
      {/if}

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
