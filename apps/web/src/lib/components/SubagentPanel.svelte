<script lang="ts">
  /**
   * E8's sub-agents panel (A7-S): 400px beside the chat (the shell's `aside`), grouped
   * Running, Failed, Finished, each row with its task, time and tool calls and one line —
   * what it is doing now while running, otherwise a fixed status message. The only live
   * action is Stop on running rows; "Open thread" is on every row and disabled until V2.
   * **Selecting a row scrolls the transcript to its card**; Esc or × closes the panel.
   *
   * No per-agent counts of what it found are computed for this list: only time and tool
   * calls, which the runtime tracks (the server's view).
   */
  import { tick } from "svelte";

  import { composing } from "../composing";
  import { IconClose, IconRobot } from "../icons";
  import {
    subagentMeta,
    subagentName,
    type SubagentEntry,
    type SubagentGroups,
  } from "../subagents";

  let {
    groups,
    now,
    agent,
    stopping,
    onstop,
    onselect,
    onclose,
  }: {
    groups: SubagentGroups;
    now: number;
    /** The chat's word for the agent that started them: "the importer". */
    agent: string;
    /** The call ids whose Stop is with the server. */
    stopping: readonly string[];
    onstop?: ((callId: string) => void) | undefined;
    /** Scrolls the transcript to the sub-agent's card. */
    onselect: (callId: string) => void;
    onclose: () => void;
  } = $props();

  let heading = $state<HTMLElement | undefined>(undefined);
  const total = $derived(
    groups.running.length + groups.failed.length + groups.finished.length,
  );
  const sections = $derived([
    { key: "running", title: "Running", entries: groups.running },
    { key: "failed", title: "Failed", entries: groups.failed },
    { key: "finished", title: "Finished", entries: groups.finished },
  ]);

  // Focus goes into the panel when it opens, onto its heading, so a keyboard reader is in
  // it; Tab then reaches the rows.
  $effect(() => {
    void tick().then(() => heading?.focus());
  });

  /** One line under a row: what it does now while running, otherwise a fixed message. */
  const lineOf = (entry: SubagentEntry): string => {
    const view = entry.view;
    switch (view.status) {
      case "running":
        return (
          view.activity ??
          (view.lines.at(-1) === undefined
            ? "Starting…"
            : `${view.lines.at(-1)?.tool ?? ""} ${view.lines.at(-1)?.input ?? ""}`)
        );
      case "failed":
        return `${view.failure?.reason ?? "Failed"} · what it recorded is kept`;
      case "stopped":
        return "Stopped before it finished";
      default:
        return `Finished · reported back to ${agent}`;
    }
  };

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented || composing(event)) {
      return;
    }
    event.preventDefault();
    onclose();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="panel"
  id="subagent-panel"
  aria-labelledby="subagent-panel-heading"
  {onkeydown}
>
  <header class="top">
    <IconRobot width="14" height="14" aria-hidden="true" />
    <h2 id="subagent-panel-heading" tabindex="-1" bind:this={heading}>
      Sub-agents <span class="total">{total}</span>
    </h2>
    <button
      class="close"
      type="button"
      aria-label="Close the sub-agents panel"
      title="Close (Esc)"
      onclick={onclose}
    >
      <IconClose width="13" height="13" />
    </button>
  </header>

  {#each sections as section (section.key)}
    {#if section.entries.length > 0}
      <section class="group" aria-labelledby={`subagent-group-${section.key}`}>
        <h3 id={`subagent-group-${section.key}`} class="group-title">
          {section.title} <span class="total">{section.entries.length}</span>
        </h3>
        <ul class="rows">
          {#each section.entries as entry (entry.view.callId)}
            {@const view = entry.view}
            <li class="row" data-status={view.status}>
              <button
                class="pick"
                type="button"
                onclick={() => onselect(view.callId)}
                aria-label={`${subagentName(view)}: show its card`}
              >
                <span class="row-head">
                  <span class="name" title={subagentName(view)}
                    >{subagentName(view)}</span
                  >
                  <span class="meta" data-status={view.status}
                    >{subagentMeta(view, now)}</span
                  >
                </span>
                {#if view.task !== "" && view.task !== view.description}
                  <span class="task">{view.task}</span>
                {/if}
                <span class="line" data-status={view.status}
                  >{lineOf(entry)}</span
                >
              </button>
              <div class="actions">
                {#if view.status === "running" && view.stop === "own" && onstop !== undefined}
                  {@const busy = stopping.includes(view.callId)}
                  <button
                    class="stop"
                    type="button"
                    aria-disabled={busy}
                    aria-label={`Stop ${subagentName(view)}`}
                    onclick={() => {
                      if (!busy) onstop(view.callId);
                    }}
                  >
                    <span class="stop-mark" aria-hidden="true"></span>
                    {busy ? "Stopping…" : "Stop"}
                  </button>
                {/if}
                <!-- V2(chat): disabled until a sub-agent's own thread exists (see SubagentCard). -->
                <button
                  class="thread"
                  type="button"
                  disabled
                  title="Coming in V2">Open thread</button
                >
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/each}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    background: var(--bg-base);
  }
  .top {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border-muted);
    background: var(--bg-base);
    color: var(--icon-muted);
  }
  h2 {
    flex: 1;
    margin: 0;
    color: var(--text-base);
    font: 600 13px/20px var(--font-sans);
  }
  h2:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
  .total {
    margin-left: 4px;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-mono);
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .close:hover {
    border-color: var(--border-base);
    background: var(--overlay-hover);
  }
  .group {
    border-bottom: 1px solid var(--border-muted);
  }
  .group-title {
    margin: 0;
    padding: 10px 14px 4px;
    color: var(--text-faint);
    font: 600 10px/16px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 14px 10px;
  }
  .row + .row {
    border-top: 1px solid var(--border-muted);
  }
  .pick {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    margin: 0;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .pick:hover {
    background: var(--overlay-hover);
  }
  .row-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-base);
    font: 600 12px/18px var(--font-sans);
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: isolate;
  }
  .meta {
    flex: none;
    color: var(--text-muted);
    font: 400 11px/18px var(--font-mono);
  }
  .meta[data-status="failed"] {
    color: var(--state-fg-danger);
  }
  .task,
  .line {
    color: var(--text-muted);
    font: 400 12px/17px var(--font-sans);
    overflow-wrap: anywhere;
    unicode-bidi: isolate;
  }
  .task {
    color: var(--text-base);
  }
  .line[data-status="failed"] {
    color: var(--state-fg-danger);
  }
  .actions {
    display: flex;
    gap: 8px;
    padding-left: 6px;
  }
  .stop,
  .thread {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 500 11px/20px var(--font-sans);
    cursor: pointer;
  }
  .stop[aria-disabled="true"] {
    color: var(--text-muted);
    cursor: progress;
  }
  .stop-mark {
    width: 7px;
    height: 7px;
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
