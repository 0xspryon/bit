<script lang="ts">
  /**
   * The shared chat shell driven by a fake adapter (A6 prep): what a goal, planner or
   * worker chat would hand it, with each capability switched on or off by a prop. Every
   * call the shell makes into the adapter is pushed onto `calls`, which the test holds.
   */
  import type {
    LiveItem,
    PendingQuestion,
    QuestionAnswerability,
    QuestionField,
  } from "@bit/contracts";

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
    fields = undefined,
    answerability = "live",
    canMessage = true,
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
    /** The questions asked; two by default (a choose-one and a choose-any). */
    fields?: readonly QuestionField[] | undefined;
    answerability?: QuestionAnswerability;
    /** Whether the chat takes the answers as a message (`sendAsMessage`). */
    canMessage?: boolean;
  } = $props();

  // The page's title bar chips, as `+page.svelte` provides them, drawn in a stand-in bar.
  provideTitleBarChips();

  let working = $state(false);
  let stopping = $state(false);
  let draft = $state("");
  // svelte-ignore state_referenced_locally
  let waiting = $state(asking);
  let shown = $state(true);
  let busy = $state(false);
  let refused = $state<string | undefined>(undefined);
  // Read once: a fixture's capabilities are fixed for its life, as a chat's role is.
  // svelte-ignore state_referenced_locally
  const files = attachable ? new ComposerFiles() : undefined;

  export const set = (next: {
    readonly working?: boolean;
    readonly stopping?: boolean;
    /** A question is asked (`true`), or answered on the server (`false`). */
    readonly asking?: boolean;
    /** The chat is on screen (`false`: unmounted, beside a bar that stays). */
    readonly shown?: boolean;
    /** An answer is with the server. */
    readonly busy?: boolean;
    /** The server refused the last answer, with this sentence. */
    readonly refused?: string | undefined;
  }): void => {
    if (next.shown !== undefined) shown = next.shown;
    if (next.busy !== undefined) busy = next.busy;
    if ("refused" in next) refused = next.refused;
    if (next.working !== undefined) working = next.working;
    if (next.stopping !== undefined) stopping = next.stopping;
    if (next.asking !== undefined) waiting = next.asking;
  };

  /** Files picked, pasted or dropped: the tray's one way in. */
  export const attach = (picked: readonly File[]): void => {
    files?.add(picked);
  };

  const TWO: readonly [QuestionField, ...QuestionField[]] = [
    {
      key: "Which host first?",
      header: "Host",
      question: "Which host first?",
      kind: "one",
      options: [
        { label: "api.acme.com", description: "The API" },
        { label: "www.acme.com", description: null },
      ],
      custom: true,
      required: false,
    },
    {
      key: "Which depths?",
      header: "Depth",
      question: "Which depths?",
      kind: "any",
      options: [
        { label: "One", description: null },
        { label: "Two", description: null },
        { label: "All", description: null },
      ],
      custom: true,
      required: false,
    },
  ];
  // svelte-ignore state_referenced_locally
  const asked: readonly [QuestionField, ...QuestionField[]] =
    fields !== undefined && fields.length > 0
      ? (fields as readonly [QuestionField, ...QuestionField[]])
      : TWO;
  // svelte-ignore state_referenced_locally
  const pending: PendingQuestion = {
    questionId: "toolu_fake",
    // One per mount: the dock keeps drafts by session and questions, across mounts.
    harnessSessionId: `ses_fake_${crypto.randomUUID()}`,
    fields: asked,
    askedAt: null,
    answerability,
    attemptId: null,
    roundId: null,
    goalId: null,
    importId: "imp_fake",
  };
  // svelte-ignore state_referenced_locally
  const message = canMessage
    ? (text: string) => {
        calls.push(`message:${text}`);
        waiting = false;
      }
    : undefined;
  const question: ChatQuestion = {
    pending,
    asker: "The agent",
    get busy() {
      return busy;
    },
    answer: (answers) => {
      calls.push(`answer:${JSON.stringify(answers)}`);
    },
    sendAsMessage: message,
    dismiss: () => {
      calls.push("dismiss");
      waiting = false;
    },
    get refusal() {
      return refused === undefined
        ? undefined
        : { title: "Answers not sent", sentence: refused };
    },
    dismissRefusal: () => {
      refused = undefined;
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
      questionsAsked: (count: number) => `The agent asks ${String(count)}`,
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
{#if shown}
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
{/if}
