<script lang="ts" module>
  import type { DockDraft } from "../questionDock";

  /**
   * The operator's draft answers by question set (`questionSignature`), so a dock drawn
   * again — a reload of the chat, a question withdrawn and offered back as a message under
   * another id — opens where the operator left it. Ten sets at most: it is a convenience.
   */
  // A plain Map, not a SvelteMap: nothing renders from it; it is read once, at mount.
  const drafts = new Map<string, { draft: DockDraft; index: number }>();
  const DRAFTS_KEPT = 10;
</script>

<script lang="ts">
  /**
   * A7-Q's question dock (E3/E4), drawn by the chat shell in the composer's slot while the
   * agent waits on the operator.
   *
   * **One anatomy at any count** (the operator: always the full interface, Jump to included,
   * even for one to four questions): a header — counter, bar, Jump to…, Back and Next arrows,
   * Dismiss — then the answered line, the current question, and a footer with the keys and
   * Skip, Back and Next. Only the current question is drawn in full. Nothing is sent before
   * the last question's "Send N answers".
   *
   * **Keys.** `1`–`9` choose an option (a choose-any toggles it), the number after the last
   * option goes to "Something else"; Enter moves on (in a "your words" box, Ctrl/⌘ Enter);
   * Space toggles a checkbox; arrows move within a choose-one. Esc anywhere in the dock gives
   * the composer back by dismissing (the shell's handler) — except in the Jump to… list,
   * which takes Esc to close itself and says so with `preventDefault`.
   *
   * **What it can do depends on the question's answerability.** `live`: the answers go to
   * the harness. `message`: the request is gone, the answers go as an ordinary message when
   * the chat takes one. `not_resumable`: nothing can be sent; the questions are shown, read
   * only, with the sentence that says why, and Dismiss gives the box back.
   *
   * Every word in it is the agent's: plain text, never markup.
   */
  import { tick } from "svelte";

  import {
    questionAnswersAsMessage,
    questionAnswersProblem,
  } from "@bit/contracts";

  import type { ChatQuestion } from "../chatShell";
  import {
    IconAngleLeft,
    IconAngleRight,
    IconCheck,
    IconClose,
    IconHelp,
  } from "../icons";
  import {
    EMPTY_DRAFT,
    answerabilityNote,
    answeredCounts,
    answeredLine,
    choose,
    draftAnswers,
    fieldAnswer,
    fieldName,
    isAnswered,
    kindTag,
    progressBar,
    questionSignature,
    requirementLabel,
    visit,
    write,
  } from "../questionDock";

  let { question }: { question: ChatQuestion } = $props();

  const uid = $props.id();

  let pending = $derived(question.pending);
  let fields = $derived(pending.fields);
  let signature = $derived(questionSignature(pending));
  let canMessage = $derived(question.sendAsMessage !== undefined);
  /** Nothing can be sent: the questions are shown read only. */
  let readOnly = $derived(
    pending.answerability === "not_resumable" ||
      (pending.answerability === "message" && !canMessage),
  );
  let note = $derived(answerabilityNote(pending, question.asker, canMessage));

  // svelte-ignore state_referenced_locally
  const kept = drafts.get(questionSignature(question.pending));
  let draft = $state<DockDraft>(kept?.draft ?? EMPTY_DRAFT);
  let index = $state(kept?.index ?? 0);
  let showAnswered = $state(false);
  let jumping = $state(false);
  let jumpActive = $state(0);
  /** A sentence about the answers, said before anything is sent (a required one skipped). */
  let problem = $state("");

  $effect(() => {
    drafts.delete(signature);
    drafts.set(signature, { draft, index });
    while (drafts.size > DRAFTS_KEPT) {
      const oldest = drafts.keys().next().value;
      if (oldest === undefined) break;
      drafts.delete(oldest);
    }
  });

  let field = $derived(fields[Math.min(index, fields.length - 1)] ?? fields[0]);
  let last = $derived(index >= fields.length - 1);
  let counts = $derived(answeredCounts(fields, draft));
  let bar = $derived(progressBar(fields, draft, index));
  let answered = $derived(
    fields.filter(
      (each) => isAnswered(each, draft) || draft.visited.includes(each.key),
    ),
  );
  let latest = $derived(
    [...fields].reverse().find((each) => isAnswered(each, draft)),
  );
  let answeredCount = $derived(counts.answered);
  let currentAnswered = $derived(isAnswered(field, draft));
  let mayMoveOn = $derived(!field.required || currentAnswered || readOnly);
  let written = $derived(draft.written[field.key] ?? "");
  let chosen = $derived(draft.chosen[field.key] ?? []);

  let root = $state<HTMLElement | undefined>(undefined);
  let jumpButton = $state<HTMLButtonElement | undefined>(undefined);
  let jumpList = $state<HTMLUListElement | undefined>(undefined);

  /** Puts focus on the current question's first control: its chosen option, else the first. */
  export async function focus(): Promise<void> {
    await tick();
    const scope = root?.querySelector<HTMLElement>(".current");
    const target =
      scope?.querySelector<HTMLElement>("input:checked:not(:disabled)") ??
      scope?.querySelector<HTMLElement>(
        "input:not(:disabled), textarea:not(:disabled)",
      ) ??
      root?.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus();
  }

  function go(to: number, focusAfter = true): void {
    if (to < 0 || to >= fields.length) return;
    draft = visit(field, draft);
    index = to;
    problem = "";
    if (focusAfter) void focus();
  }

  function next(): void {
    if (!mayMoveOn) {
      problem = `"${fieldName(field)}" needs an answer before the next question.`;
      return;
    }
    if (!last) {
      go(index + 1);
      return;
    }
    submit();
  }

  function submit(): void {
    if (readOnly || question.busy || answeredCount === 0) return;
    const answers = draftAnswers(fields, draft);
    const wrong = questionAnswersProblem(fields, answers);
    if (wrong !== null) {
      problem = wrong;
      return;
    }
    problem = "";
    if (pending.answerability === "live") {
      question.answer(answers);
    } else {
      question.sendAsMessage?.(questionAnswersAsMessage(fields, answers));
    }
  }

  function pick(label: string): void {
    if (readOnly) return;
    draft = choose(field, draft, label);
    problem = "";
  }

  function words(value: string): void {
    if (readOnly) return;
    draft = write(field, draft, value);
    problem = "";
  }

  /** The dock's own keys; Esc is the shell's, unless the Jump to… list took it. */
  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || readOnly) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && target.type === "text");
    /*
     * Esc in a free-text answer with words in it only leaves that box, and focus moves to
     * the dock; a second Esc dismisses (A7-Q review 1, a plan decision). A dismissal cannot
     * be undone — a live question's agent is told the operator declined — so one key
     * pressed to leave a box must not throw away what was written there. An empty box, or
     * anywhere else in the dock, dismisses at once, as E3 says; kept from the shell by
     * `preventDefault`, as the Jump to… list's Esc is.
     */
    if (
      event.key === "Escape" &&
      typing &&
      (target as HTMLTextAreaElement | HTMLInputElement).value.trim() !== ""
    ) {
      event.preventDefault();
      root?.focus();
      return;
    }
    if (event.key === "Enter") {
      if (target instanceof HTMLButtonElement) return;
      if (
        target instanceof HTMLTextAreaElement &&
        !(event.ctrlKey || event.metaKey)
      ) {
        return;
      }
      if (event.shiftKey) return;
      event.preventDefault();
      next();
      return;
    }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[1-9]$/u.test(event.key)) {
      const n = Number(event.key);
      const option = field.options[n - 1];
      if (option !== undefined) {
        event.preventDefault();
        pick(option.label);
        root
          ?.querySelector<HTMLInputElement>(
            `.current input[data-option="${String(n - 1)}"]`,
          )
          ?.focus();
      } else if (n === field.options.length + 1 && field.custom) {
        event.preventDefault();
        root?.querySelector<HTMLInputElement>(".current input.own")?.focus();
      }
    }
  }

  async function openJump(): Promise<void> {
    jumping = true;
    jumpActive = index;
    await tick();
    jumpList
      ?.querySelector<HTMLElement>(`[data-index="${String(index)}"]`)
      ?.focus();
  }

  function closeJump(refocus: boolean): void {
    jumping = false;
    if (refocus) jumpButton?.focus();
  }

  function jumpTo(to: number): void {
    closeJump(false);
    go(to);
  }

  /** The Jump to… list's keys. Esc closes the list and is kept from the shell. */
  function onjumpkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeJump(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      jumpActive = (jumpActive + step + fields.length) % fields.length;
      jumpList
        ?.querySelector<HTMLElement>(`[data-index="${String(jumpActive)}"]`)
        ?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      jumpActive = event.key === "Home" ? 0 : fields.length - 1;
      jumpList
        ?.querySelector<HTMLElement>(`[data-index="${String(jumpActive)}"]`)
        ?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      jumpTo(jumpActive);
      return;
    }
    if (event.key === "Tab") closeJump(false);
  }

  /** Focus leaving the list and its button closes the list: a Tab away, a click elsewhere. */
  function onjumpfocusout(): void {
    // After the move, where focus landed is known (a focus event's `relatedTarget` is not
    // given everywhere).
    setTimeout(() => {
      const at = document.activeElement;
      if (at !== null && (jumpList?.contains(at) || jumpButton?.contains(at)))
        return;
      jumping = false;
    }, 0);
  }

  let sendLabel = $derived(
    answeredCount === 0
      ? pending.answerability === "live"
        ? "Send answers"
        : "Send answers as a message"
      : pending.answerability === "live"
        ? answeredCount === 1
          ? "Send 1 answer"
          : `Send ${String(answeredCount)} answers`
        : answeredCount === 1
          ? "Send 1 answer as a message"
          : `Send ${String(answeredCount)} answers as a message`,
  );
  let dismissTitle = $derived(
    pending.answerability === "live"
      ? `Dismiss these questions (Esc): ${question.asker.toLowerCase()} is told you declined, and the box comes back`
      : "Put these questions away (Esc), and get the box back",
  );
</script>

<!-- The dock's own keys (`onkeydown`): its controls are the interactive elements. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  bind:this={root}
  class={["question-dock", readOnly && "read-only"]}
  aria-label="{question.asker}'s questions"
  aria-describedby={note === "" ? undefined : `${uid}-note`}
  aria-busy={question.busy}
  tabindex="-1"
  {onkeydown}
>
  <header class="head">
    <span class="mark" aria-hidden="true"><IconHelp /></span>
    <span class="counter" id="{uid}-counter">
      Question <strong>{index + 1}</strong>
      <span class="of">of</span>
      <strong>{fields.length}</strong>
    </span>
    <span class="bar" aria-hidden="true">
      {#if bar._tag === "segments"}
        {#each bar.segments as segment, at (at)}
          <span class="segment is-{segment}"></span>
        {/each}
      {:else}
        <span class="run"
          ><span class="fill" style:width="{bar.filled * 100}%"></span></span
        >
      {/if}
    </span>
    <span class="jump-wrap">
      <button
        bind:this={jumpButton}
        type="button"
        class="jump"
        aria-haspopup="listbox"
        aria-expanded={jumping}
        aria-controls="{uid}-jump"
        onclick={() => (jumping ? closeJump(true) : void openJump())}
      >
        Jump to…
      </button>
      {#if jumping}
        <ul
          bind:this={jumpList}
          id="{uid}-jump"
          class="jump-list"
          role="listbox"
          aria-label="Jump to a question"
          onkeydown={onjumpkeydown}
          onfocusout={onjumpfocusout}
        >
          {#each fields as each, at (each.key)}
            <li
              role="option"
              tabindex="-1"
              data-index={at}
              aria-selected={at === index}
              class={["jump-row", at === jumpActive && "active"]}
              onclick={() => jumpTo(at)}
              onkeydown={() => {}}
            >
              <span class="jump-n">{at + 1}</span>
              <span class="jump-name">{fieldName(each)}</span>
              {#if isAnswered(each, draft)}
                <span class="jump-done" aria-label="answered"
                  ><IconCheck /></span
                >
              {:else if draft.visited.includes(each.key)}
                <span class="jump-skipped">skipped</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </span>
    <button
      type="button"
      class="arrow"
      aria-label="Previous question"
      disabled={index === 0}
      onclick={() => go(index - 1)}
    >
      <IconAngleLeft />
    </button>
    <button
      type="button"
      class="arrow"
      aria-label="Next question"
      disabled={last}
      onclick={() => go(index + 1)}
    >
      <IconAngleRight />
    </button>
    <button
      type="button"
      class="arrow dismiss"
      aria-label={pending.answerability === "live"
        ? "Dismiss these questions"
        : "Put these questions away"}
      title={dismissTitle}
      disabled={question.busy}
      onclick={() => question.dismiss()}
    >
      <IconClose />
    </button>
  </header>

  {#if answered.length > 0}
    <div class="answered">
      <span class="tick" aria-hidden="true"><IconCheck /></span>
      <span class="answered-count">{answeredLine(counts)}</span>
      {#if latest !== undefined && !showAnswered}
        <span class="answered-last">
          <span class="name">{fieldName(latest)}</span>
          <span class="to" aria-hidden="true">→</span>
          <span class="value">{fieldAnswer(latest, draft).join(", ")}</span>
        </span>
      {/if}
      <button
        type="button"
        class="show"
        aria-expanded={showAnswered}
        aria-controls="{uid}-answered"
        onclick={() => (showAnswered = !showAnswered)}
      >
        {showAnswered ? "Hide" : "Show"}
      </button>
    </div>
    {#if showAnswered}
      <ul
        class="answered-list"
        id="{uid}-answered"
        aria-label="Answered and skipped questions"
      >
        {#each answered as each (each.key)}
          <li>
            <button
              type="button"
              class="answered-row"
              onclick={() => go(fields.indexOf(each))}
            >
              <span class="name">{fieldName(each)}</span>
              <span class="to" aria-hidden="true">→</span>
              <span class="value">
                {isAnswered(each, draft)
                  ? fieldAnswer(each, draft).join(", ")
                  : "skipped"}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <div class="current" role="group" aria-labelledby="{uid}-q-{index}">
    <div class="tags">
      <span class="tag">{kindTag(field.kind)}</span>
      <span class="requirement">{requirementLabel(field, draft)}</span>
      {#if field.header !== null}<span class="header-name">{field.header}</span
        >{/if}
    </div>
    <p class="title" id="{uid}-q-{index}">{field.question}</p>

    {#if field.kind === "text"}
      <textarea
        class="words"
        aria-labelledby="{uid}-q-{index}"
        placeholder="Your answer…"
        rows="3"
        disabled={readOnly || question.busy}
        value={written}
        oninput={(event) => words(event.currentTarget.value)}></textarea>
    {:else}
      <div
        class="options"
        role={field.kind === "one" ? "radiogroup" : "group"}
        aria-labelledby="{uid}-q-{index}"
      >
        {#each field.options as option, at (option.label)}
          <label class={["option", chosen.includes(option.label) && "chosen"]}>
            <input
              type={field.kind === "one" ? "radio" : "checkbox"}
              name="{uid}-q-{index}"
              data-option={at}
              checked={chosen.includes(option.label)}
              disabled={readOnly || question.busy}
              onchange={() => pick(option.label)}
            />
            <span class="key" aria-hidden="true">{at + 1}</span>
            <span class="text">
              <span class="label">{option.label}</span>
              {#if option.description !== null && option.description !== option.label}
                <span class="description">{option.description}</span>
              {/if}
            </span>
          </label>
        {/each}
        {#if field.custom}
          <label
            class={["option", "own-row", written.trim() !== "" && "chosen"]}
          >
            <span class="key" aria-hidden="true"
              >{field.options.length + 1}</span
            >
            <input
              class="own"
              type="text"
              aria-label="Something else, in your own words"
              placeholder="Something else — in your own words…"
              disabled={readOnly || question.busy}
              value={written}
              oninput={(event) => words(event.currentTarget.value)}
            />
          </label>
        {/if}
      </div>
    {/if}
  </div>

  {#if note !== ""}
    <p class="note" id="{uid}-note" role="status">{note}</p>
  {/if}
  {#if problem !== ""}
    <p class="problem" role="alert">{problem}</p>
  {/if}

  <footer class="foot">
    <span class="keys" aria-hidden="true">
      {#if !readOnly}
        {#if field.kind === "text"}
          <kbd>Ctrl Enter</kbd> next
        {:else}
          <kbd>1–{field.options.length + (field.custom ? 1 : 0)}</kbd>
          choose · <kbd>Enter</kbd> next
        {/if}
        · <kbd>Esc</kbd>
        {pending.answerability === "live"
          ? "reply in chat instead"
          : "put away"}
      {:else}
        <kbd>Esc</kbd> put away
      {/if}
    </span>
    {#if readOnly}
      <button type="button" class="primary" onclick={() => question.dismiss()}>
        Dismiss
      </button>
    {:else}
      {#if !field.required && !currentAnswered && !last}
        <button type="button" class="quiet" onclick={() => go(index + 1)}
          >Skip</button
        >
      {/if}
      <button
        type="button"
        class="quiet"
        disabled={index === 0}
        onclick={() => go(index - 1)}
      >
        <IconAngleLeft /> Back
      </button>
      {#if last}
        <!-- Nothing answered sends nothing: answering none is what Dismiss is for. -->
        <button
          type="button"
          class="primary"
          disabled={question.busy || !mayMoveOn || answeredCount === 0}
          title={answeredCount === 0
            ? "Answer at least one question, or dismiss them (Esc)"
            : undefined}
          onclick={submit}
        >
          {question.busy ? "Sending…" : sendLabel}
        </button>
      {:else}
        <button
          type="button"
          class="primary"
          disabled={!mayMoveOn}
          onclick={next}
        >
          Next <IconAngleRight />
        </button>
      {/if}
    {/if}
  </footer>
</section>

<style>
  /*
    The composer's box, as E3 has it: same width, same border, same radius — the slot is
    the box's — with a header and a footer band of its own.
  */
  .question-dock {
    position: relative;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    border: 1px solid var(--border-base);
    border-radius: 10px;
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 400 13px/20px var(--font-sans);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 8px 10px 8px 14px;
    border-bottom: 1px solid var(--border-muted);
    border-radius: 10px 10px 0 0;
    background: var(--bg-deep);
  }
  .mark {
    display: inline-flex;
    width: 14px;
    height: 14px;
    color: var(--state-fg-warning);
  }
  .mark :global(svg) {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  .counter {
    flex: none;
    font-weight: 500;
    white-space: nowrap;
  }
  .counter strong {
    font-weight: 600;
  }
  .of {
    color: var(--text-muted);
    font-weight: 400;
  }
  .bar {
    display: flex;
    flex: 1 1 auto;
    min-width: 40px;
    gap: 3px;
  }
  .segment {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--border-base);
  }
  /* `is-` prefixed: `.current` is also the question's region (scoped classes collide). */
  .segment.is-done {
    background: var(--text-muted);
  }
  .segment.is-current {
    background: var(--text-base);
  }
  .run {
    position: relative;
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: var(--border-base);
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 2px;
    background: var(--text-base);
  }
  .jump-wrap {
    position: relative;
    flex: none;
  }
  .jump {
    padding: 2px 8px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .jump:hover {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .jump-list {
    position: absolute;
    z-index: 5;
    right: 0;
    bottom: calc(100% + 6px);
    width: max-content;
    min-width: 220px;
    max-width: min(420px, 70vw);
    max-height: 280px;
    margin: 0;
    padding: 4px;
    overflow: auto;
    list-style: none;
    border: 1px solid var(--border-base);
    border-radius: 8px;
    background: var(--bg-layer-01);
    box-shadow: var(--elevation-floating);
  }
  .jump-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .jump-row.active,
  .jump-row:hover {
    background: var(--overlay-hover);
  }
  .jump-row[aria-selected="true"] .jump-name {
    font-weight: 600;
  }
  .jump-n {
    flex: none;
    width: 18px;
    color: var(--text-faint);
    font: 400 11px/16px var(--font-mono);
    text-align: right;
  }
  .jump-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jump-done,
  .jump-skipped {
    flex: none;
    margin-left: auto;
    color: var(--text-faint);
    font-size: 11px;
  }
  .jump-done :global(svg) {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }
  .arrow {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .arrow :global(svg) {
    width: 14px;
    height: 14px;
    fill: currentColor;
  }
  .arrow:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .arrow:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .answered {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 6px 14px;
    border-bottom: 1px solid var(--border-muted);
    color: var(--text-muted);
    font-size: 12px;
  }
  .tick {
    display: inline-flex;
    color: var(--text-faint);
  }
  .tick :global(svg) {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }
  .answered-count {
    flex: none;
    color: var(--text-base);
  }
  .answered-last,
  .answered-row {
    display: inline-flex;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .answered-last .value,
  .answered-row .value {
    overflow: hidden;
    color: var(--text-base);
    text-overflow: ellipsis;
  }
  .to {
    color: var(--text-faint);
  }
  .show {
    flex: none;
    margin-left: auto;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .answered-list {
    margin: 0;
    padding: 4px 8px;
    list-style: none;
    border-bottom: 1px solid var(--border-muted);
  }
  .answered-row {
    width: 100%;
    padding: 3px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .answered-row:hover {
    background: var(--overlay-hover);
  }
  .current {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
  }
  .tags {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--text-faint);
    font-size: 12px;
  }
  .tag {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font: 500 10px/18px var(--font-mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .header-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    margin: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 7px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
  }
  .option:hover {
    background: var(--overlay-hover);
  }
  .option.chosen {
    border-color: var(--border-strong);
    background: var(--overlay-hover);
  }
  .option:focus-within {
    border-color: var(--border-focus);
  }
  .option input[type="radio"],
  .option input[type="checkbox"] {
    flex: none;
    margin: 3px 0 0;
    accent-color: var(--text-base);
  }
  .key {
    flex: none;
    min-width: 16px;
    padding: 0 3px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xs);
    color: var(--text-faint);
    font: 400 10px/16px var(--font-mono);
    text-align: center;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .label {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .description {
    color: var(--text-muted);
    font-size: 12px;
    line-height: 18px;
    overflow-wrap: anywhere;
  }
  .own-row {
    align-items: center;
    border: 1px dashed var(--border-base);
  }
  .own {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-base);
    font: inherit;
  }
  .own::placeholder,
  .words::placeholder {
    color: var(--text-faint);
  }
  .own:focus-visible {
    outline: none;
  }
  /* Where a first Esc in a written answer leaves focus (`onkeydown`): said, not hidden. */
  .question-dock:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  .words {
    width: 100%;
    box-sizing: border-box;
    min-height: 64px;
    padding: 8px 10px;
    border: 1px solid var(--border-base);
    border-radius: 8px;
    background: transparent;
    color: var(--text-base);
    font: inherit;
    resize: vertical;
  }
  .note,
  .problem {
    margin: 0;
    padding: 0 14px 10px;
    font-size: 12px;
    line-height: 18px;
    text-wrap: pretty;
  }
  .note {
    color: var(--text-muted);
  }
  .problem {
    color: var(--state-fg-danger);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 14px;
    border-top: 1px solid var(--border-muted);
  }
  .keys {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-faint);
    font-size: 11px;
  }
  kbd {
    font: 400 11px/16px var(--font-mono);
    color: var(--text-muted);
  }
  .foot button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    font: 500 12px/18px var(--font-sans);
    cursor: pointer;
  }
  .foot button :global(svg) {
    width: 12px;
    height: 12px;
    fill: currentColor;
  }
  .quiet {
    border: 0;
    background: transparent;
    color: var(--text-muted);
  }
  .quiet:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  .primary {
    border: 1px solid var(--bg-inverse);
    background: var(--bg-inverse);
    color: var(--text-inverse);
  }
  .foot button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .read-only .option {
    cursor: default;
  }
</style>
