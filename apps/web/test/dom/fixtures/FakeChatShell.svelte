<script lang="ts">
  /**
   * The shared chat shell driven by a fake adapter (A6 prep): what a goal, planner or
   * worker chat would hand it, with each capability switched on or off by a prop. Every
   * call the shell makes into the adapter is pushed onto `calls`, which the test holds.
   */
  import type { LiveItem } from "@bit/contracts";

  import { rowsFor, type ChatGroup } from "../../../src/lib/chat";
  import type {
    ChatComposerSource,
    ChatQuestion,
    ChatSession,
    ThreadTurn,
  } from "../../../src/lib/chatShell";
  import { ComposerFiles } from "../../../src/lib/composerFiles.svelte";
  import ChatShell from "../../../src/lib/components/ChatShell.svelte";
  import TitleBarChipSlot from "../../../src/lib/components/TitleBarChipSlot.svelte";
  import { provideTitleBarChips } from "../../../src/lib/titleBarChips.svelte";

  let {
    calls,
    closed = undefined,
    stoppable = true,
    steerable = false,
    attachable = false,
    dock = false,
    asking = false,
    cards = false,
    stopAll = false,
    panel = false,
    since = undefined,
    elapsedLead = undefined,
    items = [],
  }: {
    calls: string[];
    closed?: string | undefined;
    stoppable?: boolean;
    steerable?: boolean;
    attachable?: boolean;
    dock?: boolean;
    /** A question holds the composer's slot from the start. */
    asking?: boolean;
    cards?: boolean;
    stopAll?: boolean;
    panel?: boolean;
    since?: number | undefined;
    elapsedLead?: string | undefined;
    items?: readonly LiveItem[];
  } = $props();

  // The page's title bar chips, as `+page.svelte` provides them, drawn in a stand-in bar.
  provideTitleBarChips();

  let working = $state(false);
  let stopping = $state(false);
  let draft = $state("");
  // svelte-ignore state_referenced_locally
  let waiting = $state(asking);
  // Read once: a fixture's capabilities are fixed for its life, as a chat's role is.
  // svelte-ignore state_referenced_locally
  const files = attachable ? new ComposerFiles() : undefined;

  export const set = (next: {
    readonly working?: boolean;
    readonly stopping?: boolean;
    /** A question is asked (`true`), or answered on the server (`false`). */
    readonly asking?: boolean;
  }): void => {
    if (next.working !== undefined) working = next.working;
    if (next.stopping !== undefined) stopping = next.stopping;
    if (next.asking !== undefined) waiting = next.asking;
  };

  /** Files picked, pasted or dropped: the tray's one way in. */
  export const attach = (picked: readonly File[]): void => {
    files?.add(picked);
  };

  const question: ChatQuestion = {
    dismiss: () => {
      calls.push("dismiss");
      waiting = false;
    },
  };

  let groups = $derived<readonly ChatGroup<ThreadTurn>[]>([
    {
      key: "turn:1",
      subject: {
        message: "What is in scope?",
        number: 1,
        at: null,
        working,
        queued: false,
        sentNow: false,
        startedAt: null,
        midBlock: false,
      },
      prose: { _tag: "live" },
      rows: rowsFor(items, true),
    },
  ]);

  // A closed box is its reason and nothing else (`ClosedChatComposer`): no stubs.
  // svelte-ignore state_referenced_locally
  const composer: ChatComposerSource =
    closed !== undefined
      ? { closed }
      : {
          get draft() {
            return draft;
          },
          set draft(value: string) {
            draft = value;
          },
          files,
          sending: false,
          blocked: false,
          placeholder: "Say something…",
          send: (urgency) => {
            calls.push(`send:${urgency}:${draft}`);
            draft = "";
          },
          get sendNow() {
            return steerable
              ? { offered: true, title: "Send it now" }
              : undefined;
          },
          notices: [
            {
              key: "note",
              text: "The last message was delivered.",
              tone: "status",
            },
          ],
        };

  const session: ChatSession = {
    label: "Fake chat",
    empty: "Nothing yet.",
    get groups() {
      return groups;
    },
    note: "",
    connection: "",
    get turn() {
      return { working, background: false, stopping, since };
    },
    get stop() {
      return stoppable ? () => calls.push("stop") : undefined;
    },
    composer,
    get question() {
      return waiting ? question : undefined;
    },
    words: {
      working: "The agent is working.",
      copyReply: "Copy the agent's reply",
      stopTurn: "Stop the agent's turn.",
      stopBackground: "Stop the agent's background work.",
      messageLabel: "Message the agent",
      sendLabel: "Send to the agent",
      sendTitle: "Send to the agent",
      sendQueuedTitle: "Send to the agent, queued",
      countTitle: "Characters",
      get elapsedLead() {
        return elapsedLead;
      },
    },
    footer: { agent: "Agent", model: "fake-model" },
    sentNowTitle: "",
  };
</script>

{#snippet footnote()}
  <span>footnote</span>
{/snippet}
{#snippet ask(asked: ChatQuestion)}
  <div class="fake-question">
    <p>Which host first?</p>
    <button class="fake-answer" type="button">api.acme.com</button>
    <button class="fake-reply" type="button" onclick={asked.dismiss}
      >Reply in chat instead</button
    >
  </div>
{/snippet}
{#snippet stopEvery()}
  <button
    class="fake-stop-all"
    type="button"
    onclick={() => calls.push("stop-all")}>Stop all</button
  >
{/snippet}
{#snippet subagents()}
  <div class="fake-panel">Sub-agents 1</div>
{/snippet}
{#snippet card(row: { readonly item: LiveItem })}
  <div class="fake-card">{row.item.headline}: {row.item.outcome}</div>
{/snippet}
{#snippet chip()}
  <span class="fake-chip">1 sub-agent</span>
{/snippet}

<header class="fake-bar"><TitleBarChipSlot /></header>
<ChatShell
  {session}
  id="fake"
  {footnote}
  dock={dock ? ask : undefined}
  controls={stopAll ? stopEvery : undefined}
  aside={panel ? subagents : undefined}
  subagent={cards ? card : undefined}
  chip={cards ? chip : undefined}
/>
