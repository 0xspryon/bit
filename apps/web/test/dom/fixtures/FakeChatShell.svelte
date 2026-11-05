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
    ChatSession,
    ThreadTurn,
  } from "../../../src/lib/chatShell";
  import { ComposerFiles } from "../../../src/lib/composerFiles.svelte";
  import ChatShell from "../../../src/lib/components/ChatShell.svelte";

  let {
    calls,
    closed = undefined,
    stoppable = true,
    steerable = false,
    attachable = false,
    dock = false,
    cards = false,
    since = undefined,
    items = [],
  }: {
    calls: string[];
    closed?: string | undefined;
    stoppable?: boolean;
    steerable?: boolean;
    attachable?: boolean;
    dock?: boolean;
    cards?: boolean;
    since?: number | undefined;
    items?: readonly LiveItem[];
  } = $props();

  let working = $state(false);
  let stopping = $state(false);
  let draft = $state("");
  // Read once: a fixture's capabilities are fixed for its life, as a chat's role is.
  // svelte-ignore state_referenced_locally
  const files = attachable ? new ComposerFiles() : undefined;

  export const set = (next: {
    readonly working?: boolean;
    readonly stopping?: boolean;
  }): void => {
    if (next.working !== undefined) working = next.working;
    if (next.stopping !== undefined) stopping = next.stopping;
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

  const composer: ChatComposerSource = {
    get draft() {
      return draft;
    },
    set draft(value: string) {
      draft = value;
    },
    files,
    sending: false,
    get closed() {
      return closed;
    },
    blocked: false,
    placeholder: "Say something…",
    send: (urgency) => {
      calls.push(`send:${urgency}:${draft}`);
      draft = "";
    },
    get sendNow() {
      return steerable ? { offered: true, title: "Send it now" } : undefined;
    },
    notices: [],
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
    },
    footer: { agent: "Agent", model: "fake-model" },
    sentNowTitle: "",
  };
</script>

{#snippet footnote()}
  <span>footnote</span>
{/snippet}
{#snippet question()}
  <div class="fake-question">Which host first?</div>
{/snippet}
{#snippet card(row: { readonly item: LiveItem })}
  <div class="fake-card">{row.item.headline}: {row.item.outcome}</div>
{/snippet}
{#snippet chip()}
  <span class="fake-chip">1 sub-agent</span>
{/snippet}

<ChatShell
  {session}
  id="fake"
  {footnote}
  dock={dock ? question : undefined}
  subagent={cards ? card : undefined}
  header={cards ? chip : undefined}
/>
