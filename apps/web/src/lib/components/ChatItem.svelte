<script lang="ts">
  /**
   * One row of a transcript: a reply, a tool call, a record, a refused action.
   *
   * **Extracted from {@link LiveTranscript} rather than rewritten beside it**, which is the
   * answer to the slice brief's "refactor it or extract a component both use". That panel
   * had already settled four things worth keeping exactly as they were, and a second
   * implementation of them in the chat would have been two renderings of the same contract
   * drifting apart: the origin as a readable **word** rather than a tint (`live.ts` §9), the
   * `callId` shown on both a call and its result because nothing else can pair them, the
   * payloads in collapsed `<details>` so a screen reader is not narrated a directory
   * listing on every arrival, and the outcome as text rather than as a colour.
   *
   * So this is that row, and both the target's live panel and the planner chat render it.
   * What differs between them is **arrangement**, which is their business: the panel is a
   * flat list in arrival order, and the chat groups by round and folds a result into the
   * call it answers.
   *
   * ## What the three optional props add, and why the chat needs them
   *
   * They are the whole of the spec's pending-until-recorded merge rule as it reaches the
   * screen. `chat.ts` decides them; this renders them.
   *
   * - `proposedBy` — the `tool.call` a committed record was collapsed into. The record is
   *   `item`, because the record wins and carries the real id; the call is kept because it
   *   is the only place the *arguments* are.
   * - `result` — the `tool.result` paired to this call by `callId`, folded in rather than
   *   left as a row of its own.
   * - `write` — what became of an attempted write, in words. `unresolved` is the one that
   *   must never be quiet: a call that produced neither a record nor a stated failure is
   *   either a record this tab dropped or a write that did not happen, and the row says so
   *   rather than picking one.
   * - `summary` — the brief's one-line domain summary: `add_intent` → the question it
   *   proposed, `record_round_disposition` → the disposition. Shown **only when the
   *   rendered item has no body of its own**, so a committed record's own sentence is never
   *   doubled by a paraphrase of the request that produced it. Without it a planner's row
   *   is the raw MCP tool name over two empty disclosure labels, and the proposed question
   *   reaches the screen only once the record arrives — which is exactly what a *pending*
   *   call cannot rely on.
   */
  import type { LiveItem } from "@bit/contracts";
  import type { Snippet } from "svelte";

  import {
    REPLY_KIND,
    SUBAGENT_KIND,
    SUBAGENT_NOTE,
    REPLY_PAST_CAP_LABEL,
    THINKING_KIND,
    callSignature,
    kindLabel,
    outcomeTint,
    pastPartialCap,
    resultLine,
    type StreamState,
    type WriteState,
  } from "../chat";
  import { IconAngleRight, IconClock } from "../icons";
  import Markdown from "./Markdown.svelte";
  import MarkedText from "./MarkedText.svelte";
  import StreamCursor from "./StreamCursor.svelte";

  let {
    item,
    proposedBy = null,
    result = null,
    write = null,
    summary = null,
    narrated = false,
    footer,
    stream = undefined,
  }: {
    item: LiveItem;
    proposedBy?: LiveItem | null;
    result?: LiveItem | null;
    write?: WriteState | null;
    summary?: string | null;
    /**
     * Read the row as a transcript rather than as a ledger entry: prose as prose, a call as
     * a mono block. The importer chat's (A6), where the page is one conversation and a row
     * with a kind column, a time and a call id beside every line would bury it. Every fact
     * the ledger row carries is still on it; see the narrated markup.
     */
    narrated?: boolean;
    /**
     * A line under this row's prose, inside the row: the turn's footer, when {@link Chat}
     * has placed it here. Inside rather than after, because it is a caption on these words
     * and a list item between two rows would be a row of its own. Drawn only on a narrated
     * reply — the one reading where a row is prose — and ignored on anything else.
     */
    footer?: Snippet | undefined;
    /**
     * How the block stands if it is still being written (A6 U5, `streamStates` in
     * `chat.ts`): which needs the rows around it, so a chat that has them says. Without
     * one, a partial is `writing`, or `shortened` past the cap — what the item alone says.
     */
    stream?: StreamState | undefined;
  } = $props();

  /** {@link stream}, or what the item alone says; `null` on a finished block. */
  let streamState = $derived<StreamState | null>(
    stream ??
      (item.streaming !== true
        ? null
        : pastPartialCap(item)
          ? "shortened"
          : "writing"),
  );

  /** What the ledger reading's chip says of a block still being written. */
  const STREAM_LABELS: Record<StreamState, string> = {
    writing: "writing…",
    shortened: "shortened",
    done: "written",
  };

  /**
   * What each write state says, as a sentence an operator can act on.
   *
   * Written out rather than left as the tag, because the tag is a state machine's word and
   * these are four genuinely different situations. `refused` says the tool's own output is
   * where the reason is, which for `add_intent` is the store's instructive refusal.
   */
  const WRITE_NOTES: Record<WriteState, string> = {
    recorded:
      "Committed: this is the record the call produced. The store's own event id is above, beside the harness's id for the call it came from; the first is durable and the second is not.",
    refused:
      "The harness reported this call failed, so nothing was written. Its result below is where the reason is.",
    pending:
      "Asked for and not yet confirmed. No record of it has arrived, and the round is still running.",
    unresolved:
      "Unresolved: the round has finished and this call produced neither a record nor a stated failure. It may have been refused, or its record may have been dropped from this tab's feed — which of the two is not knowable from here.",
  };

  const WRITE_LABELS: Record<WriteState, string> = {
    recorded: "recorded",
    refused: "refused",
    pending: "pending",
    unresolved: "unresolved",
  };

  /**
   * Whether this row is what the agent **considered**, rather than what it did.
   *
   * It changes two things and nothing else: the text goes in a collapsed `<details>`
   * instead of straight into the row, and a sentence says what the block is. Both follow
   * from ruling 2 of the brief — collapsed by default, and never presented as a record of
   * what happened.
   *
   * The thing that happened is the reply or the tool call beside this row. Thinking is a
   * draft: bit never stores it — a reload reads it back from the harness's copy, like the
   * rest of the conversation, for as long as the harness keeps it — and an
   * operator who acted on it would be acting on something the agent may have talked itself
   * out of two rows later.
   */
  let thinking = $derived(item.kind === THINKING_KIND);

  /**
   * A turn the harness ended in its own error (A6 U4): the `turn.other` item labelled
   * `error`, live and replayed alike. Drawn as its sentence, not as a ledger line.
   */
  let harnessError = $derived(
    item.kind === "turn.other" &&
      item.headline === "error" &&
      item.outcome === "failed",
  );

  /**
   * A thought's collapsed line: its first line with words in it, the markdown that would
   * only be noise in one line (a heading's hashes, emphasis, code ticks) taken off. The
   * whole thought, as markdown, is what opens under it.
   */
  const gist = (text: string): string =>
    (text.split("\n").find((line) => line.trim() !== "") ?? "")
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, "")
      .replace(/(\*\*|__|`)/g, "")
      .trim();

  /** When it happened, as a wall-clock time. Display only: never an ordering key. */
  let time = $derived(
    new Date(item.at).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  let writeTint = $derived(
    write === "recorded"
      ? "success"
      : write === "refused"
        ? "danger"
        : write === "unresolved"
          ? "warning"
          : "plain",
  );
</script>

<!--
  Every piece of agent or tool text below is drawn through `MarkedText`, never raw: a fetched
  page reaches a tool's arguments and results, and a bidi or zero-width character in them
  would otherwise make `https://` RLI `com` RLM `.` RLM `acme` PDI read as `https://acme.com`.
  The narrated reading's prose — a thought, a sub-agent's type and task — is marked as prose
  (bidi controls); everything that reads as code or as a ledger line is marked as code (bidi,
  zero-width and tag characters).
-->

{#if narrated}
  <!--
    The transcript reading of a row, for a chat that is a page (A6 D3/D4): the agent's own
    prose as prose, and a tool call as the mono block it would be if the agent had said it —
    the call on one line and what answered it under an arrow. **The same facts as the ledger
    row below, arranged differently**: the record/activity distinction (a solid border for
    what is committed, a dashed one for what is only narrated), the write state in words, the
    verbatim payload one disclosure away, and the call id — all still here, only quieter.
  -->
  {#if item.kind === REPLY_KIND}
    <li class="prose" data-origin={item.origin}>
      <span class="visually-hidden">{item.origin}</span>
      <div class="reply"><Markdown text={item.body} /></div>
      {#if streamState !== null}
        <!--
          D3's mark on the reply being written (A6 U5). Past the 4,000 characters a partial
          carries, the words have stopped moving while the agent goes on: that is said, and
          that the finished reply (up to 32,000) brings the rest (A6 U5 review).
        -->
        <p class="writing" role="status">
          <StreamCursor
            label={streamState === "shortened"
              ? REPLY_PAST_CAP_LABEL
              : "writing…"}
          />
        </p>
      {/if}
      {@render footer?.()}
    </li>
  {:else if thinking}
    <!--
      D3: reasoning as one truncated line — a clock, the thought's first line, a chevron —
      opened to the whole of it as markdown, with the note that it is what was considered
      and not what was done. The line is prose, marked as prose is.
    -->
    <li class="prose reasoning" data-origin={item.origin}>
      <span class="visually-hidden">{item.origin}</span>
      <details>
        <summary>
          <span class="glyph" aria-hidden="true"><IconClock /></span>
          <span class="visually-hidden">What it considered: </span>
          <!--
            D3's shimmer while the thought is being written (A6 U5); still under reduced
            motion. A thought past the cap, or one the agent has moved on from, does not
            shimmer: the first says so, the second is simply what was thought.
          -->
          <span class={["gist", streamState === "writing" && "shimmer"]}
            ><MarkedText text={gist(item.body)} /></span
          >
          {#if streamState === "writing"}
            <span class="visually-hidden"> (being written)</span>
          {:else if streamState === "shortened"}
            <span class="cut">shortened</span>
          {/if}
          <span class="chevron" aria-hidden="true"><IconAngleRight /></span>
        </summary>
        <div class="thought"><Markdown text={item.body} /></div>
        <p class="aside">
          What the agent was considering, not what it did. Not stored here: a
          reload shows it only while the harness still has it.
        </p>
      </details>
    </li>
  {:else if harnessError}
    <!--
      The harness ended the turn with an error of its own (A6 U4) — a provider refusing the
      call, say. Its sentence, as the harness wrote it and marked as prose, rather than a
      turn that reads as though the importer chose to say nothing.
    -->
    <li class="prose harness-error" data-origin={item.origin}>
      <span class="visually-hidden">{item.origin}</span>
      <p class="error-head">The harness stopped this turn with an error:</p>
      <p class="error-text"><MarkedText text={item.body} /></p>
    </li>
  {:else if item.kind === SUBAGENT_KIND}
    <!--
      A sub-agent the agent started, as one entry (A6 U14): what it is and how it stands,
      and a note that what it did is not shown. Its type and its task are the calling
      agent's words, drawn as text and nothing else. A block, like a tool call: it is
      something the agent did, not something it said.
    -->
    <li
      class="block subagent"
      data-origin={item.origin}
      data-status={item.outcome ?? ""}
      title={item.callId === null ? undefined : `call ${item.callId}`}
    >
      <span class="visually-hidden">{item.origin}</span>
      <div class="sig mono">
        <span class="what">{kindLabel(item.kind)}</span>
        <span class="agent-type"><MarkedText text={item.headline} /></span>
        <span
          class="chip"
          data-tint={outcomeTint(item.outcome ?? "running")}
          data-status={item.outcome ?? "running"}
        >
          {item.outcome ?? "running"}
        </span>
      </div>
      {#if item.body !== ""}
        <div class="ret task"><MarkedText text={item.body} /></div>
      {/if}
      <p class="state-note">{SUBAGENT_NOTE}</p>
    </li>
  {:else}
    <!--
      A call (live, or collapsed into the record it produced), a result with no call to
      fold into, a record with no call, or an event this build has no better word for. All
      of them are a block: they are the "what it did" half of the thread.
    -->
    {@const call = proposedBy ?? (item.kind === "tool.call" ? item : null)}
    {@const answer = resultLine(
      result ?? (item.kind === "tool.result" ? item : null),
    )}
    <li
      class="block"
      data-origin={item.origin}
      data-write={write ?? ""}
      title={call?.callId == null ? undefined : `call ${call.callId}`}
    >
      <span class="visually-hidden">{item.origin}</span>
      <div class="sig mono">
        {#if call !== null}
          <MarkedText text={callSignature(call)} code />
        {:else if item.kind === "tool.result"}
          <MarkedText text={item.toolName ?? item.headline} code />
        {:else}
          <span class="what">{kindLabel(item.kind)}</span>
          <MarkedText text={item.headline} code />
        {/if}
      </div>
      {#if call === null && item.kind !== "tool.result" && item.body !== ""}
        <div class="ret mono"><MarkedText text={item.body} code /></div>
      {/if}
      <!--
        A write folded into its record answers with the **record's** sentence — D3's
        `→ entry 1 created`, or "already in scope" for a no-op — rather than the tool's
        own output: the record is what was committed, and the output is the harness's
        copy of what the tool returned, still one disclosure away under "Full call". A
        record with no body falls back to the result's line, then to the chip alone.
      -->
      {#if write === "recorded"}
        <div class="ret mono">
          → <MarkedText
            text={item.body !== "" ? item.body : (answer ?? "")}
            code
          />
          <span class="chip" data-tint="success" title={item.id}>recorded</span>
        </div>
      {:else if answer !== null}
        <div class="ret mono" data-failed={result?.outcome === "failed"}>
          → <MarkedText text={answer} code />
        </div>
      {:else if write === "pending"}
        <div class="ret writing mono">
          <StreamCursor label="writing…" />
        </div>
      {/if}
      {#if write === "unresolved" || write === "refused"}
        <div
          class="ret mono"
          data-failed={write === "refused"}
          data-unresolved={write === "unresolved"}
          role={write === "unresolved" ? "status" : undefined}
        >
          → {write === "unresolved" ? "unresolved" : "refused"}
          <span class="state-note">{WRITE_NOTES[write]}</span>
        </div>
      {/if}
      {#if call?.input != null || item.output !== null || (result !== null && result.output !== null)}
        <details class="raw">
          <summary>Full call</summary>
          {#if call?.input != null}
            <pre class="mono"><MarkedText text={call.input} code /></pre>
          {/if}
          {#if result !== null && result.output !== null}
            <pre class="mono"><MarkedText text={result.output} code /></pre>
          {:else if item.output !== null}
            <pre class="mono"><MarkedText text={item.output} code /></pre>
          {/if}
        </details>
      {/if}
    </li>
  {/if}
{:else}
  <!--
  The origin is the row's left edge: a solid rule for a committed record, a dashed rule and
  italics for in-process activity. The word is still here for a screen reader and in the
  row's title, because an edge nobody can read cannot say "this one is not part of the
  record" (`live.ts` §9) — it just no longer costs a second badge on every row.
-->
  <li
    class="item"
    data-origin={item.origin}
    title={item.origin === "record"
      ? "Record: a committed event, in the order the store assigned it."
      : "Activity: live and in-process. Not part of the record; can be dropped under load."}
  >
    <div class="row">
      <span class="kind mono">{kindLabel(item.kind)}</span>
      <span class="visually-hidden">{item.origin}</span>
      <!--
      The call id, on the items that have one.

      **It is the only thing that can pair a `tool.result` with its `tool.call`.** Both
      harnesses run tools concurrently, so results do not arrive in the order the calls
      were made and two calls to the same tool are indistinguishable by name. When
      `callId` is `null` on a result — reachable, when the harness never named the call —
      the row carries no tag: falling back to the tool name would attribute one command's
      output to a different command.
    -->
      {#if item.callId !== null}
        <span
          class="call mono"
          title="The harness's own id for this tool call. A result and the call it answers carry the same id; this is the only thing that pairs them."
        >
          call {item.callId}
        </span>
      {:else if proposedBy !== null && proposedBy.callId !== null}
        <!--
        A collapsed pair, which renders **two** ids because they are two different kinds of
        thing and the row's own sentence distinguishes them.

        The record's id comes first: it is the store's own event id, stable across
        connections and across a restart, and it is the thing the merge rule means when it
        says the record wins and carries the real identity. `WRITE_NOTES.recorded` used to
        say "the id above is the real one" while the only id rendered was the second one
        below — the harness's local, non-durable call id — which told an operator the
        opposite of the distinction the sentence exists to draw.
      -->
        <span
          class="call mono"
          data-kind="record"
          title="The store's own event id for this committed record. Stable across connections and across a restart; this is the durable identity."
        >
          {item.id}
        </span>
        <span
          class="call mono"
          title="The harness's own id for the tool call this record came from. Local to that harness session and not durable."
        >
          call {proposedBy.callId}
        </span>
      {/if}
      <span class="headline"><MarkedText text={item.headline} code /></span>
      {#if write !== null}
        <span
          class="chip outcome"
          data-tint={writeTint}
          title={WRITE_NOTES[write]}
        >
          {WRITE_LABELS[write]}
        </span>
      {/if}
      {#if item.outcome !== null}
        <span class="chip outcome" data-tint={outcomeTint(item.outcome)}>
          {item.outcome}
        </span>
      {/if}
      {#if streamState !== null}
        <!-- A block still being written (A6 U5): said in words, as an outcome is. -->
        <span class="chip outcome stream" data-tint="plain">
          {streamState === "shortened" && item.kind === REPLY_KIND
            ? REPLY_PAST_CAP_LABEL
            : STREAM_LABELS[streamState]}
        </span>
      {/if}
      <span class="time mono">{time}</span>
    </div>

    {#if thinking && item.body !== ""}
      <!--
      Collapsed, like a tool's arguments and for one more reason than they are: the text
      runs to paragraphs, it arrives a block at a time while the operator is reading
      something else, and it is the one thing on this surface that is not a claim about
      what happened. Shut, it is out of the accessibility tree, so a reader is not narrated
      a model's deliberation on every arrival.
    -->
      <details class="io">
        <summary class="io-label">What it considered</summary>
        <p class="thought"><MarkedText text={item.body} /></p>
        <p class="note">
          What the agent was considering, not what it did. Not stored here: a
          reload shows it only while the harness still has it. What it actually
          did is the reply or the tool call beside this.
        </p>
      </details>
    {:else if item.body !== ""}
      <p class="body"><MarkedText text={item.body} code /></p>
    {:else if summary !== null}
      <!--
      The one-line domain summary, in place of the body a tool call does not have. The
      `{:else if}` is the rule rather than a convenience: a committed record *has* a body —
      the server's own sentence about what was written — and showing a paraphrase of the
      request beneath it would be the same fact twice.
    -->
      <p class="body"><MarkedText text={summary} code /></p>
    {/if}

    {#if item.kind === SUBAGENT_KIND}
      <!-- What a sub-agent's entry does not show, and why (A6 U14). -->
      <p class="note">{SUBAGENT_NOTE}</p>
    {/if}

    <!--
    The write's state in words as well as in the chip, because the chip is one word and
    three of the four states need a sentence to be actionable. `role="status"` only on
    `unresolved`: it is the one an operator must not miss, and announcing every pending
    tool call would make the region useless.
  -->
    {#if write !== null}
      <p
        class={["note", write === "unresolved" && "loud"]}
        role={write === "unresolved" ? "status" : undefined}
      >
        {WRITE_NOTES[write]}
      </p>
    {/if}

    <!--
    Collapsed by default, and the `<summary>` says what is inside while it is shut, so the
    row stays readable and the payload stays out of both the accessibility tree and the box
    until a reader asks for it.
  -->
    {#if item.input !== null}
      <details class="io">
        <summary class="io-label">Arguments</summary>
        <pre class="io-text mono"><MarkedText text={item.input} code /></pre>
      </details>
    {:else if proposedBy !== null && proposedBy.input !== null}
      <details class="io">
        <summary class="io-label">Arguments the round asked with</summary>
        <pre class="io-text mono"><MarkedText
            text={proposedBy.input}
            code
          /></pre>
      </details>
    {/if}

    {#if item.output !== null}
      <details class="io">
        <summary class="io-label">Result</summary>
        <pre class="io-text mono"><MarkedText text={item.output} code /></pre>
      </details>
    {/if}

    {#if result !== null && result.output !== null}
      <details class="io">
        <summary class="io-label">
          Result{result.outcome === "failed"
            ? " (the harness reported a failure)"
            : ""}
        </summary>
        <pre class="io-text mono"><MarkedText text={result.output} code /></pre>
      </details>
    {/if}
  </li>
{/if}

<style>
  .item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 9px 0 9px 14px;
    border-left: 2px solid var(--border-strong);
  }
  .item[data-origin="activity"] {
    border-left-style: dashed;
    border-left-color: var(--border-muted);
  }
  .item[data-origin="activity"] .headline {
    color: var(--text-muted);
    font-style: italic;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
  }
  /* What sits under the row lines up with the headline, past the kind column. */
  .item > :not(.row) {
    margin-left: 100px;
  }
  /* The one badge a row carries: what kind of thing it is. */
  .kind {
    flex: none;
    width: 86px;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 10px;
    font-weight: 500;
    line-height: 18px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .time {
    flex: none;
    margin-left: auto;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 18px;
  }
  /*
   * `--text-muted` is the floor for text in these rows; `--text-faint` is not usable here.
   *
   * Every label below is 10-11px, and `--text-faint` measures 3.4-4.0:1 against both
   * backgrounds these rows sit on in both themes, which is under WCAG AA's 4.5:1 for
   * normal-size text. `--text-muted` is 6.1-7.0:1 across those same pairings.
   */
  .chip {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: var(--bg-layer-02);
    color: var(--text-base);
    font: 600 10px/var(--lh-tight) var(--font-sans);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .chip[data-tint="success"] {
    border-color: var(--state-border-success);
    background: var(--state-bg-success);
    color: var(--state-fg-success);
  }
  .chip[data-tint="warning"] {
    border-color: var(--state-border-warning);
    background: var(--state-bg-warning);
    color: var(--state-fg-warning);
  }
  .chip[data-tint="danger"] {
    border-color: var(--state-border-danger);
    background: var(--state-bg-danger);
    color: var(--state-fg-danger);
  }
  .outcome {
    text-transform: none;
    letter-spacing: 0;
  }
  /*
   * Metadata like `.origin`, but a harness's call id can be long, so this truncates instead
   * of wrapping the row: the leading characters are what an operator matches on by eye, and
   * the `title` has the whole of it.
   */
  /*
   * The record's id is given more room than the call id, because it is the one an operator
   * matches against the event log and the prefix (`record:`) eats four characters of it.
   */
  .call[data-kind="record"] {
    max-width: 24ch;
    border-style: solid;
    border-color: var(--border-strong);
  }
  .call {
    max-width: 16ch;
    padding: 1px 5px;
    overflow: hidden;
    border: 1px dotted var(--border-muted);
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font-size: 10px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .headline {
    flex: 1;
    min-width: 0;
    color: var(--text-base);
    font-size: 13px;
    line-height: 18px;
    overflow-wrap: anywhere;
  }
  /*
   * Reads as the quotation it is: indented behind a rule, in the body size rather than the
   * monospace a payload gets, because it is prose and not a tool's output.
   */
  .thought {
    margin: 2px 0 0;
    padding-left: 8px;
    border-left: 2px solid var(--border-muted);
    color: var(--text-muted);
    font-size: 12px;
    line-height: var(--lh-compact);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .body {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
    line-height: var(--lh-compact);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .note.loud {
    color: var(--state-fg-warning);
  }
  /* Block, not flex: a `<details>` laid out as a flex container does not reliably collapse. */
  .io {
    display: block;
  }
  /*
   * The old `.io-label` look — small, uppercase, faint — on what is now the control that
   * opens the block, so it also has to read as clickable: a pointer, a hover shift, and a
   * focus ring, since this is reachable by keyboard and a summary with no visible focus is
   * a control nobody can find.
   */
  .io-label {
    width: fit-content;
    padding: 1px 2px;
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .io-label:hover {
    color: var(--text-base);
  }
  .io-label:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 1px;
  }
  /* Still capped and still scrollable: open, a long payload must not take over the box. */
  .io-text {
    max-height: 140px;
    margin: 2px 0 0;
    padding: 6px 8px;
    overflow-y: auto;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-sm);
    background: var(--bg-deep);
    color: var(--text-muted);
    font-size: 11px;
    line-height: var(--lh-compact);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /*
   * ── The narrated reading (`narrated`) ───────────────────────────────────────
   *
   * A6 D3/D4: prose at 13px/21px in the base colour, and a tool call as a mono block in the
   * deep background with a hairline border. Consecutive blocks are one block — three writes
   * in a row read as one fenced span of calls, which is what they are — by overlapping each
   * pair's borders and squaring the joined corners.
   */
  .prose {
    list-style: none;
  }
  /*
   * The reply is markdown (`Markdown.svelte`), which draws its own blocks; this sets the
   * type they inherit. No `white-space: pre-wrap` any more — see that component.
   */
  .prose .reply {
    color: var(--text-base);
    font: 400 13px/21px var(--font-sans);
    text-wrap: pretty;
  }
  .prose p {
    margin: 0;
    color: var(--text-base);
    font: 400 13px/21px var(--font-sans);
    text-wrap: pretty;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .prose .thought {
    margin-top: 8px;
    padding-left: 24px;
    border-left: 0;
    color: var(--text-muted);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
  /*
   * D3's reasoning line: a faint clock, the thought's first line cut to the column with an
   * ellipsis, and a chevron that turns when it is open. Muted rather than D3's faint, which
   * is below AA at 13px.
   */
  .reasoning summary {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font: 400 13px/20px var(--font-sans);
    list-style: none;
    cursor: pointer;
  }
  .reasoning summary::-webkit-details-marker {
    display: none;
  }
  .reasoning summary:hover {
    opacity: 0.85;
  }
  .reasoning summary:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 2px;
  }
  .reasoning .glyph,
  .reasoning .chevron {
    display: inline-flex;
    flex: none;
    width: 14px;
    height: 14px;
    color: var(--icon-faint);
  }
  .reasoning .glyph :global(svg),
  .reasoning .chevron :global(svg) {
    width: 14px;
    height: 14px;
  }
  .reasoning details[open] .chevron {
    transform: rotate(90deg);
  }
  .reasoning .gist {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    unicode-bidi: isolate;
  }
  .reasoning .aside {
    padding-left: 24px;
  }
  /*
   * D3's shimmer on a thought still being written (A6 U5): a lighter band passing along the
   * line, drawn in the text itself. Between the summary's muted ink and the base ink rather
   * than D3's faint, which is below AA at 13px. Without motion it is the muted line.
   */
  .reasoning .gist.shimmer {
    background-image: linear-gradient(
      90deg,
      var(--text-muted) 30%,
      var(--text-base) 50%,
      var(--text-muted) 70%
    );
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    animation: shimmer 2.6s linear infinite;
  }
  @keyframes shimmer {
    from {
      background-position: 160% 0;
    }
    to {
      background-position: -60% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reasoning .gist.shimmer {
      background-image: none;
      color: var(--text-muted);
      -webkit-text-fill-color: currentColor;
      animation: none;
    }
  }
  .reasoning .cut {
    flex: none;
    color: var(--text-muted);
    font-size: 12px;
  }
  .prose .writing {
    margin-top: 6px;
    font-size: 12px;
    line-height: 16px;
  }
  /* A harness's own error: its sentence in the danger ink, behind a rule. */
  .harness-error {
    padding-left: 12px;
    border-left: 2px solid var(--state-border-danger);
  }
  .harness-error .error-head {
    color: var(--text-muted);
    font-size: 12px;
    line-height: 18px;
  }
  .harness-error .error-text {
    color: var(--state-fg-danger);
  }
  .prose .aside {
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 11px;
    line-height: var(--lh-compact);
  }
  .block {
    display: flex;
    flex-direction: column;
    padding: 9px 12px;
    border: 1px solid var(--border-muted);
    border-radius: var(--radius-md);
    background: var(--bg-deep);
    color: var(--text-muted);
    font: 400 12px/20px var(--font-mono);
    list-style: none;
  }
  /* Not committed: narration only, which can be dropped and is gone on a reload. */
  .block[data-origin="activity"] {
    border-style: dashed;
    border-color: var(--border-base);
  }
  .block + :global(.block) {
    margin-top: -13px;
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  .block:has(+ :global(.block)) {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  .sig,
  .ret {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .what {
    margin-right: 6px;
    color: var(--text-faint);
    font: 600 10px/20px var(--font-sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .block .chip {
    margin-left: 6px;
    vertical-align: 1px;
  }
  .ret[data-failed="true"] {
    color: var(--state-fg-danger);
  }
  .ret[data-unresolved="true"] {
    color: var(--state-fg-warning);
  }
  /*
   * A sub-agent's task is the calling agent's sentence, so it reads as one: sans, wrapping,
   * where a call's line is mono. Its note sits under it, as a write's state note does.
   */
  .subagent .task {
    unicode-bidi: isolate;
    color: var(--text-base);
    font: 400 13px/20px var(--font-sans);
    overflow-wrap: anywhere;
  }
  .subagent .agent-type {
    unicode-bidi: isolate;
    margin-right: 6px;
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  .subagent .state-note {
    margin: 2px 0 0;
  }
  .state-note {
    display: block;
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    white-space: normal;
  }
  /* A6 D3's "writing…", drawn by `StreamCursor`: a mark that a write is in flight. */
  .writing {
    display: flex;
    align-items: center;
  }
  .raw {
    margin-top: 4px;
  }
  .raw summary {
    color: var(--text-muted);
    font: 400 11px/16px var(--font-sans);
    cursor: pointer;
  }
  .raw pre {
    margin: 4px 0 0;
    overflow-x: auto;
    color: var(--text-muted);
    font-size: 11px;
    line-height: 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
