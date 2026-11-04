<script lang="ts">
  /**
   * The agent chip on the importer's composer, and the list it opens (A6 D7).
   *
   * **The agent is what the message is for**: the prompt the conversation is opened with and
   * the tools its credential reaches. It leads the strip ("Importer on openai/gpt-5.6-sol"),
   * and it reads from the server's registry (`GET /agents`) and the session, never from
   * text compiled in here.
   *
   * ## Pinned once the conversation has started (the operator's decision)
   *
   * D7's caption has the agent switch per message. The decision taken since is that it is
   * fixed by the first message, so the chip has two faces:
   *
   * - **Before the first message**: a button with a chevron. It shows the agent picked for
   *   the draft, or the registry's default, and opens D7's list: each agent's name, a tag
   *   ("only agent", or "default here" when there are several), and what it can write. A pick
   *   is the draft's agent, sent with the first message (`ImporterConversationDraft.agentId`).
   * - **After it**: a span with no chevron, the **session's** agent, saying that it is
   *   fixed for this conversation. A span rather than a disabled button, as the model chip
   *   beside it is: a disabled control reads as "not yet", and this one is "not ever".
   *
   * A session recorded under an agent this build no longer defines shows the raw id, marked
   * unknown. Its composer is already refused with the server's sentence; the chip only has
   * to stop naming an agent the server does not have.
   *
   * ## Text only
   *
   * The label and what it writes are the server's strings and are rendered as text, never
   * as markup.
   */
  import type { AgentsView } from "@bit/contracts";
  import type { Attachment } from "svelte/attachments";

  import {
    IconAngleUp,
    IconCheck,
    IconDownload,
    IconInfoCircle,
  } from "../icons";

  let {
    agents,
    agentId,
    locked,
    onpick,
  }: {
    /** The registry, or `undefined` while it has not been read. */
    agents: AgentsView | undefined;
    /** The session's agent, or the draft's pick; `undefined` for the registry's default. */
    agentId: string | undefined;
    /** The conversation has started (or its first message is with the server). */
    locked: boolean;
    onpick: (agentId: string) => void;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | undefined>(undefined);
  let trigger = $state<HTMLButtonElement | undefined>(undefined);
  let list = $state<HTMLDivElement | undefined>(undefined);
  /** Where the list sits, from the box's left edge: above the composer's box. */
  let left = $state(0);

  let shownId = $derived(agentId ?? agents?.defaultAgentId);
  let agent = $derived(agents?.agents.find((each) => each.id === shownId));
  /** A recorded agent the registry, now read, does not define. */
  let unknown = $derived(
    agents !== undefined && shownId !== undefined && agent === undefined,
  );
  let label = $derived(agent?.label ?? shownId ?? "Agent");
  let only = $derived(agents?.agents.length === 1);
  /** The list's footnote, in the registry's own words for the one agent there is. */
  let footnote = $derived(
    `The agent is fixed once a conversation starts.${
      only && agents?.agents[0] !== undefined
        ? ` ${agents.agents[0].label} is the only agent for now.`
        : ""
    }`,
  );

  /**
   * Closes the list whenever the button that opens it goes — the first message sent, the
   * page left — so a list left open is not shown again the next time a new session's chip
   * renders, with no operator action.
   */
  const closesWithButton: Attachment = () => () => {
    open = false;
  };

  function close(refocus: boolean): void {
    open = false;
    if (refocus) trigger?.focus();
  }

  function toggle(): void {
    if (open) {
      close(false);
      return;
    }
    // The list is placed in the composer's box, above it, so it covers the conversation and
    // never the draft: D7 sets it 32px left of the chip, 18px in from the box's edge.
    left = Math.max(0, (trigger?.offsetLeft ?? 0) - 32);
    open = true;
  }

  /** The focus goes to the agent in use when the list opens, as a listbox's does. */
  const focusSelected = (node: HTMLDivElement) => {
    const rows = [...node.querySelectorAll<HTMLButtonElement>(".row")];
    (
      rows.find((row) => row.getAttribute("aria-selected") === "true") ??
      rows[0]
    )?.focus();
  };

  function pick(id: string): void {
    onpick(id);
    close(true);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === "Escape") {
      // The composer's own Escape (if any) is not this list's to trigger as well.
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const focused = document.activeElement;
    if (list === undefined || focused === null || !list.contains(focused)) {
      return;
    }
    event.preventDefault();
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".row")];
    const at = rows.findIndex((row) => row === focused);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    rows[Math.min(rows.length - 1, Math.max(0, at + delta))]?.focus();
  }
</script>

<svelte:window
  {onkeydown}
  onpointerdown={(event) => {
    if (!open || root === undefined) return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    close(false);
  }}
/>

<div
  class="agent"
  bind:this={root}
  onfocusout={(event) => {
    // Tabbing out of the list closes it, as a click outside does.
    const next = event.relatedTarget;
    if (open && next instanceof Node && root?.contains(next) !== true) {
      close(false);
    }
  }}
>
  {#if locked || agents === undefined}
    <span
      class={["agent-chip", unknown && "unknown"]}
      title={unknown
        ? `This server defines no agent '${shownId ?? ""}', so this conversation cannot be continued.`
        : agents === undefined
          ? "The server's agents have not been read."
          : "The agent is fixed for this conversation."}
    >
      <IconDownload width="12" height="12" aria-hidden="true" />
      <span class={["name", unknown && "raw"]}>{label}</span>
      {#if unknown}
        <span class="tag">unknown</span>
      {/if}
      {#if locked}
        <span class="visually-hidden">
          {unknown
            ? ", an agent this server does not define"
            : ", fixed for this conversation"}
        </span>
      {/if}
    </span>
  {:else}
    <button
      bind:this={trigger}
      class={["agent-chip", open && "open"]}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label="Agent: {label}"
      title="The agent this conversation will run as. It is fixed once the first message is sent."
      onclick={toggle}
      {@attach closesWithButton}
    >
      <IconDownload width="12" height="12" aria-hidden="true" />
      <span class="name">{label}</span>
      <span class="caret" aria-hidden="true"
        ><IconAngleUp width="11" height="11" /></span
      >
    </button>

    {#if open}
      <div
        class="pop"
        style:left="{left}px"
        style:max-width="calc(100% - {left + 14}px)"
      >
        <p class="head" aria-hidden="true">Agent</p>
        <div
          class="rows"
          role="listbox"
          aria-label="Agent"
          bind:this={list}
          {@attach focusSelected}
        >
          {#each agents.agents as each (each.id)}
            {@const selected = each.id === shownId}
            <button
              class={["row", selected && "selected"]}
              type="button"
              role="option"
              aria-selected={selected}
              onclick={() => pick(each.id)}
            >
              <IconDownload
                class="row-icon"
                width="14"
                height="14"
                aria-hidden="true"
              />
              <span class="text">
                <span class="line">
                  <span class="row-name">{each.label}</span>
                  {#if only}
                    <span class="tag">only agent</span>
                  {:else if each.id === agents.defaultAgentId}
                    <span class="tag">default here</span>
                  {/if}
                </span>
                <span class="writes"
                  ><span class="visually-hidden">{"Can write: "}</span
                  >{each.writes}</span
                >
              </span>
              <span class="tick" aria-hidden="true">
                {#if selected}<IconCheck width="13" height="13" />{/if}
              </span>
            </button>
          {/each}
        </div>
        <p class="note">
          <IconInfoCircle
            class="note-icon"
            width="13"
            height="13"
            aria-hidden="true"
          />
          <span>{footnote}</span>
        </p>
      </div>
    {/if}
  {/if}
</div>

<style>
  /*
    Not positioned, on purpose: the list's containing block is the composer's box, so it
    sits above the whole box (D7) rather than over the draft.
  */
  .agent {
    display: contents;
  }
  .agent-chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 7px;
    max-width: 240px;
    height: 28px;
    padding: 0 9px;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 6px;
    background: transparent;
    color: var(--text-base);
    font: 500 12px/16px var(--font-sans);
  }
  .agent-chip :global(svg) {
    flex: none;
    color: var(--icon-muted);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A recorded id, not a name: in mono, and muted, beside its "unknown" tag. */
  .name.raw {
    color: var(--text-muted);
    font: 400 12px/16px var(--font-mono);
  }
  button.agent-chip {
    cursor: pointer;
  }
  .caret {
    display: inline-flex;
    flex: none;
  }
  button.agent-chip:hover {
    background: var(--overlay-hover);
  }
  /* D7's open chip: the strong border and the pressed fill. */
  button.agent-chip.open {
    border-color: var(--border-strong);
    background: var(--overlay-pressed);
  }
  button.agent-chip.open :global(svg) {
    color: var(--icon-base);
  }
  button.agent-chip:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }

  /* ── D7's list: above the composer, 440px ────────────────────────────────── */
  .pop {
    position: absolute;
    bottom: calc(100% + 4px);
    z-index: 20;
    display: flex;
    width: 440px;
    flex-direction: column;
    padding: 6px;
    box-sizing: border-box;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-layer-01);
    box-shadow: 0 18px 48px #00000070;
  }
  .head {
    margin: 0;
    padding: 8px 8px 6px;
    color: var(--text-faint);
    font: 600 10px/14px var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .rows {
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 8px;
    box-sizing: border-box;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-base);
    text-align: left;
    cursor: pointer;
  }
  .row:hover,
  .row.selected {
    background: var(--overlay-hover);
  }
  .row:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: -2px;
  }
  .row :global(.row-icon) {
    flex: none;
    margin-top: 2px;
    color: var(--icon-base);
  }
  .text {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .row-name {
    font: 500 13px/18px var(--font-sans);
    overflow-wrap: anywhere;
  }
  .tag {
    flex: none;
    color: var(--text-faint);
    font: 400 10px/14px var(--font-sans);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .writes {
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }
  .tick {
    display: inline-flex;
    flex: none;
    width: 13px;
    margin-top: 3px;
    color: var(--icon-base);
  }
  .note {
    display: flex;
    gap: 9px;
    margin: 5px 0 0;
    padding: 9px 8px 6px;
    border-top: 1px solid var(--border-muted);
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    text-wrap: pretty;
  }
  .note :global(.note-icon) {
    flex: none;
    margin-top: 1px;
    color: var(--icon-faint);
  }
</style>
