<script lang="ts">
  /**
   * One sub-agent, as E7 draws it in the parent's transcript (A7-S): status mark, name,
   * task, then its time and tool calls; the body below says how it stands.
   *
   * - **Running** spins, shows its last tool lines and what it is working on now, and its
   *   Stop — or, where it has no Stop of its own, the reason, where the button would be.
   * - **Finished** quotes what it returned to the agent that started it, as it wrote it.
   * - **Failed** is the only card in colour — a danger border and tint — with the reason,
   *   the raw error in mono and a fixed line that its records are kept.
   * - **Stopped** says so, and keeps the lines it had.
   *
   * "Open its thread" is on every card and disabled. Everything on the card is the
   * server's view (`SubagentView`); this component words it and computes nothing about the
   * sub-agent's work. The sub-agent's and the calling agent's words — its name, task, tool
   * lines, activity, result and error — are drawn as plain text, never markup.
   */
  import type { SubagentView } from "@bit/contracts";

  import { IconAngleDown, IconAngleUp, IconCheck, IconClose } from "../icons";
  import {
    callsLabel,
    stopWithheld,
    subagentCardId,
    subagentMeta,
    subagentName,
  } from "../subagents";

  let {
    view,
    now,
    agent,
    stopping = false,
    onstop,
  }: {
    view: SubagentView;
    /** The clock a running card's time is measured to, ticked by the chat. */
    now: number;
    /** The chat's word for the agent that started it: "the importer". */
    agent: string;
    /** Its Stop is with the server. */
    stopping?: boolean;
    /** Asks the chat to stop it; absent where the chat cannot. */
    onstop?: ((callId: string) => void) | undefined;
  } = $props();

  let open = $state(true);
  const bodyId = $derived(`${subagentCardId(view.callId)}-body`);
  const withheld = $derived(stopWithheld(view, agent));
  const statusWord = $derived(
    view.status === "running"
      ? "running"
      : view.status === "finished"
        ? "finished"
        : view.status === "failed"
          ? "failed"
          : "stopped",
  );
</script>

<!--
  Focusable by script only (`tabindex="-1"`): the panel's rows move focus here when they
  scroll to it, so a keyboard reader lands where the eye does.
-->
<article
  class="card"
  id={subagentCardId(view.callId)}
  data-status={view.status}
  tabindex="-1"
  aria-label={`Sub-agent ${subagentName(view)}, ${statusWord}`}
>
  <header class="head">
    <span class="mark" data-status={view.status} aria-hidden="true">
      {#if view.status === "running"}
        <span class="spinner"></span>
      {:else if view.status === "finished"}
        <IconCheck width="13" height="13" />
      {:else if view.status === "failed"}
        <IconClose width="13" height="13" />
      {:else}
        <span class="square"></span>
      {/if}
    </span>
    <span class="name">{subagentName(view)}</span>
    {#if view.task !== "" && view.task !== view.description}
      <span class="task" title={view.task}>{view.task}</span>
    {/if}
    {#if view.agentType !== null}
      <span class="type">{view.agentType}</span>
    {/if}
    <span class="meta" data-status={view.status}>{subagentMeta(view, now)}</span
    >
    <button
      class="fold"
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      aria-label={open ? "Hide its details" : "Show its details"}
      onclick={() => (open = !open)}
    >
      {#if open}
        <IconAngleUp width="12" height="12" />
      {:else}
        <IconAngleDown width="12" height="12" />
      {/if}
    </button>
  </header>

  {#if open}
    <div class="body" id={bodyId}>
      {#if view.status === "finished"}
        <p class="eyebrow">Returned to {agent}</p>
        {#if view.result !== null && view.result !== ""}
          <!-- V2(chat): the quote is plain text; the sub-agent's Markdown is not rendered. -->
          <blockquote class="quote">{view.result}</blockquote>
        {:else}
          <p class="quiet">It handed back without words bit could read.</p>
        {/if}
      {:else if view.status === "failed" && view.failure !== null}
        <p class="reason">
          <strong>{view.failure.reason}</strong>{view.calls === null
            ? ""
            : ` after ${callsLabel(view.calls)}`}
        </p>
        <pre class="raw">{view.failure.error}</pre>
        <p class="quiet">
          What it did before it failed is kept. Whether to try again is {agent}'s
          call: ask in the chat.
        </p>
      {:else if view.status === "stopped"}
        <p class="quiet">
          Stopped before it finished. What it did before then is kept.
        </p>
      {/if}

      {#if view.lines.length > 0 && view.status !== "finished"}
        <ul class="lines" aria-label="Its last tool calls">
          {#each view.lines as line, index (index)}
            <li class="line" data-failed={line.failed}>
              <span class="prompt" aria-hidden="true">&gt;_</span>
              <span class="tool">{line.tool}</span>
              <span class="input">{line.input}</span>
              {#if line.result !== null}
                <span class="arrow" aria-hidden="true">→</span>
                <span class="result"
                  ><span class="visually-hidden">{"answered "}</span
                  >{line.result}</span
                >
              {:else}
                <span class="pending">running</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if view.status === "running" && view.activity !== null}
        <p class="activity">
          <span class="cursor" aria-hidden="true"></span>{view.activity}
        </p>
      {/if}

      <div class="actions">
        {#if view.status === "running" && view.stop === "own" && onstop !== undefined}
          <button
            class="stop"
            type="button"
            aria-disabled={stopping}
            onclick={() => {
              if (!stopping) onstop(view.callId);
            }}
          >
            <span class="stop-mark" aria-hidden="true"></span>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        {:else if withheld !== undefined}
          <!-- Stop is hidden, and why is said where it would be (A7-S). -->
          <p class="withheld">{withheld}</p>
        {/if}
        <!--
          V2(chat): a sub-agent's own thread is not shown — "Open its thread" is disabled.
          Proper V2: the sub-agent's transcript (Claude Code's `subagents/agent-<id>.jsonl`,
          OpenCode's child session) as a thread of its own, and sub-agents listed in Agent
          sessions (E7's note).
        -->
        <button
          class="thread"
          type="button"
          disabled
          title="Coming in V2: a sub-agent's own thread">Open its thread</button
        >
      </div>
    </div>
  {/if}
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    scroll-margin: 24px;
  }
  .card:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  /* E7: failed is the only card in colour. */
  .card[data-status="failed"] {
    border-color: var(--state-border-danger);
    background: var(--state-bg-danger);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .mark {
    display: inline-flex;
    flex: none;
    align-self: center;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--icon-muted);
  }
  .mark[data-status="finished"] {
    color: var(--text-base);
  }
  .mark[data-status="failed"] {
    color: var(--state-fg-danger);
  }
  .spinner {
    width: 10px;
    height: 10px;
    box-sizing: border-box;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--text-base);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  .square {
    width: 8px;
    height: 8px;
    border-radius: 1px;
    background: var(--icon-muted);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  .name {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    color: var(--text-base);
    font: 600 13px/20px var(--font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: isolate;
  }
  .task {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font: 400 13px/20px var(--font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: isolate;
  }
  .type {
    flex: none;
    color: var(--text-faint);
    font: 400 11px/20px var(--font-mono);
    unicode-bidi: isolate;
  }
  .meta {
    flex: none;
    margin-left: auto;
    color: var(--text-muted);
    font: 400 11px/20px var(--font-mono);
    white-space: nowrap;
  }
  .meta[data-status="failed"] {
    color: var(--state-fg-danger);
  }
  .fold {
    display: inline-flex;
    flex: none;
    align-self: center;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .fold:hover {
    border-color: var(--border-base);
    background: var(--overlay-hover);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-left: 22px;
  }
  .eyebrow {
    margin: 0;
    color: var(--text-faint);
    font: 600 10px/16px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .quote {
    margin: 0;
    padding: 0 0 0 10px;
    border-left: 2px solid var(--border-strong);
    color: var(--text-base);
    font: 400 13px/20px var(--font-sans);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    unicode-bidi: plaintext;
  }
  .reason {
    margin: 0;
    color: var(--text-base);
    font: 400 13px/20px var(--font-sans);
  }
  .reason strong {
    color: var(--state-fg-danger);
    font-weight: 500;
  }
  .raw {
    max-height: 160px;
    margin: 0;
    overflow: auto;
    color: var(--text-base);
    font: 400 12px/18px var(--font-mono);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .quiet,
  .withheld {
    margin: 0;
    color: var(--text-muted);
    font: 400 12px/18px var(--font-sans);
  }
  .lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .line {
    display: flex;
    gap: 6px;
    min-width: 0;
    color: var(--text-muted);
    font: 400 12px/18px var(--font-mono);
  }
  .line .prompt {
    flex: none;
    color: var(--text-faint);
  }
  .line .tool {
    flex: none;
    color: var(--text-base);
  }
  .line .input {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: isolate;
  }
  .line .arrow {
    flex: none;
  }
  .line .result {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: isolate;
  }
  .line[data-failed="true"] .result {
    color: var(--state-fg-danger);
  }
  .line .pending {
    flex: none;
    color: var(--text-faint);
    font-style: italic;
  }
  .activity {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--text-base);
    font: 400 12px/18px var(--font-sans);
    unicode-bidi: plaintext;
  }
  .cursor {
    flex: none;
    width: 6px;
    height: 12px;
    background: var(--text-base);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .stop,
  .thread {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 500 12px/22px var(--font-sans);
    cursor: pointer;
  }
  .stop:hover {
    background: var(--overlay-pressed);
  }
  .stop[aria-disabled="true"] {
    color: var(--text-muted);
    cursor: progress;
  }
  .stop-mark {
    width: 8px;
    height: 8px;
    border-radius: 1px;
    background: currentColor;
  }
  .thread {
    border-color: var(--border-muted);
    background: transparent;
    color: var(--text-faint);
    cursor: not-allowed;
  }
</style>
