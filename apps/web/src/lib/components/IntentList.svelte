<script lang="ts">
  /**
   * The open goal's intents: what is to be investigated, and the one control that runs it.
   *
   * **An intent is a direction, not a job.** It is a question a bounded test could speak to,
   * anchored to evidence that already exists (or to nothing, which is a new top-level
   * direction), and it lives under one goal. Running it starts an *attempt* against it; the
   * attempt is where the harness, the model and the outcome are recorded, and this list
   * never claims to know them. That is why a suggestion is shown *as a suggestion* — the
   * intent's advice about where it would like to run — and never in the place a fact about
   * a run would go.
   *
   * **Every status has a sentence, and a disabled control is never unexplained.** An open
   * intent offers "Run this intent". A claimed one says a run is working on it, naming the
   * attempt, and offers nothing: the running strip under the page is the control for that
   * run, and a second "Run" here would be a button the server is certain to refuse. An
   * intent under an ended goal says why it cannot run. An answered or abandoned one says
   * that.
   *
   * **"Run this intent" does not run it.** It aims the run box at the row (see
   * {@link ComposeBox}), where the existing harness and model picker is and where the
   * operator confirms. Starting a run is a commitment of a worker against somebody's
   * systems, and one click on a list row is too little ceremony for it.
   *
   * ## The add form
   *
   * A question, optionally anchors chosen from this goal's recorded observations, and
   * optionally the untested dimension this intent exists to answer. The choices are
   * sentences — the claim that was tested, how it came out — because an observation id is
   * not something an operator can be expected to recognise. A refusal is shown as the server
   * wrote it: the store's anchoring refusals say what the offending id actually is and what
   * to do instead, and a paraphrase would lose the instruction.
   */
  import Button from "./Button.svelte";
  import {
    attemptsText,
    intentStatusLabel,
    notRunnableBecause,
    suggestionText,
  } from "../goalFormat";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let goal = $derived(app.openGoalView);
  let goalActive = $derived(goal?.status === "active");
  /** The dimensions the open goal's observations left untested, flattened for a `<select>`. */
  let dimensionChoices = $derived(
    app.goalObservations.flatMap((observation) =>
      observation.untestedDimensions.map((dimension) => ({
        address: dimension.address,
        text: dimension.text,
        claim: observation.testedClaim,
      })),
    ),
  );
</script>

<section aria-labelledby="intents-heading" class="intents">
  <div class="head">
    <h2 id="intents-heading">Intents</h2>
    <!-- No add button here: the page header's New intent opens this list's form. -->
  </div>

  {#if app.intentFormOpen}
    <form
      class="add"
      onsubmit={(event) => {
        event.preventDefault();
        void app.createIntent();
      }}
    >
      <div class="field">
        <label for="intent-question">Question</label>
        <textarea
          id="intent-question"
          rows="3"
          placeholder="What could a bounded test find out?"
          bind:value={app.intentQuestion}
          disabled={app.intentCreating}></textarea>
      </div>

      <fieldset disabled={app.intentCreating}>
        <legend>Anchor it to evidence (optional)</legend>
        {#if app.goalObservationsState === "loading"}
          <p class="hint" role="status">Reading this goal's observations…</p>
        {:else if app.goalObservationsState === "failed"}
          <p class="hint">
            This goal's observations could not be read, so none can be offered
            as anchors. The intent can still be added as a new top-level
            direction.
          </p>
        {:else if app.goalObservations.length === 0}
          <p class="hint">
            Nothing has been recorded under this goal yet, so a new intent is a
            new top-level direction: it is not a follow-up to anything.
          </p>
        {:else}
          <p class="hint">
            Leave all of these unticked for a new top-level direction. An anchor
            must be a recorded observation from this goal, never another intent.
          </p>
          <ul class="choices">
            {#each app.goalObservations as observation (observation.observationId)}
              <li>
                <label class="choice">
                  <input
                    type="checkbox"
                    checked={app.intentAnchors.includes(
                      observation.observationId,
                    )}
                    onchange={() => app.toggleAnchor(observation.observationId)}
                  />
                  <span>
                    <span class="claim">{observation.testedClaim}</span>
                    <span class="meta">
                      {observation.outcome} ·
                      <span class="mono">{observation.observationId}</span>
                    </span>
                  </span>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      </fieldset>

      {#if dimensionChoices.length > 0}
        <div class="field">
          <label for="intent-dimension"
            >The untested dimension it answers (optional)</label
          >
          <select
            id="intent-dimension"
            bind:value={app.intentDimension}
            disabled={app.intentCreating}
          >
            <option value="">None in particular</option>
            {#each dimensionChoices as choice (choice.address)}
              <option value={choice.address}>{choice.text}</option>
            {/each}
          </select>
          <p class="hint">
            Naming one marks that dimension as scheduled, so a later reader can
            tell "nobody has looked" from "work is out for this".
          </p>
        </div>
      {/if}

      {#if app.intentCreateDetail !== ""}
        <p class="error" role="alert">{app.intentCreateDetail}</p>
      {/if}

      <div class="actions">
        <Button
          variant="quiet"
          disabled={app.intentCreating}
          onclick={() => app.cancelIntentForm()}
        >
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={app.intentCreating}>
          {app.intentCreating ? "Adding…" : "Add intent"}
        </Button>
      </div>
    </form>
  {/if}

  {#if app.intentsState === "failed"}
    <p class="error" role="alert">{app.intentsDetail}</p>
  {:else if app.intents.length === 0}
    <p class="hint" role="status">
      {#if app.intentsState === "loading" || app.intentsState === "idle"}
        Reading this goal's intents…
      {:else if goalActive}
        No intents yet. An intent is a specific question to investigate under
        this goal; add one, then run it.
      {:else}
        This goal has no intents.
      {/if}
    </p>
  {:else}
    <ul class="rows">
      {#each app.intents as intent (intent.intentId)}
        {@const blocked = notRunnableBecause(intent, goal?.status)}
        {@const suggested = suggestionText(intent.suggestion)}
        <li class={["row", app.runIntentId === intent.intentId && "aimed"]}>
          <div class="top">
            <p class="question">{intent.question}</p>
            <span class={["chip", intent.status]}
              >{intentStatusLabel(intent.status)}</span
            >
          </div>

          <dl class="facts">
            <dt>Anchors</dt>
            <dd>
              {#if intent.anchoredTo.length === 0}
                None: a new top-level direction.
              {:else}
                <span class="mono">{intent.anchoredTo.join(", ")}</span>
              {/if}
            </dd>
            {#if intent.addressesDimension !== null}
              <dt>Addresses</dt>
              <dd class="mono">{intent.addressesDimension}</dd>
            {/if}
            {#if suggested !== null}
              <dt>Suggested</dt>
              <dd>
                {suggested}
                <span class="aside"
                  >(a suggestion only: the run decides what actually runs)</span
                >
              </dd>
            {/if}
            <dt>Attempts</dt>
            <dd>{attemptsText(intent.attempts)}</dd>
          </dl>

          <div class="controls">
            {#if blocked === null}
              <Button
                size="sm"
                variant={app.runIntentId === intent.intentId
                  ? "primary"
                  : "neutral"}
                onclick={() => app.chooseRun(intent.intentId)}
              >
                {app.runIntentId === intent.intentId
                  ? "Ready to run below"
                  : "Run this intent"}
              </Button>
              <Button
                size="sm"
                variant="quiet"
                loading={app.intentAbandoningId === intent.intentId}
                disabled={app.intentAbandoningId !== ""}
                onclick={() => app.openIntentAbandon(intent.intentId)}
              >
                Abandon
              </Button>
            {:else}
              <!--
                Not a disabled button: a sentence. For a claimed intent the control that
                matters is the running strip under the page, and for the rest there is
                nothing to press.
              -->
              <p class="why" role="status">
                {blocked}
                {#if intent.status === "open"}
                  <Button
                    size="sm"
                    variant="quiet"
                    loading={app.intentAbandoningId === intent.intentId}
                    disabled={app.intentAbandoningId !== ""}
                    onclick={() => app.openIntentAbandon(intent.intentId)}
                  >
                    Abandon
                  </Button>
                {/if}
              </p>
            {/if}
          </div>

          {#if app.intentAbandonOpenId === intent.intentId}
            <!--
              Abandoning is one-way, so it asks first and says what it does: it drops the
              direction, it stops nothing (an intent a run holds cannot be abandoned at
              all), and a different conclusion is a new intent. The reason is optional and
              is recorded in the target's log.
            -->
            <form
              class="confirm"
              onsubmit={(event) => {
                event.preventDefault();
                void app.abandonIntent(intent.intentId);
              }}
            >
              <div class="field">
                <label for="abandon-reason-{intent.intentId}"
                  >Why are you abandoning it? (optional)</label
                >
                <textarea
                  id="abandon-reason-{intent.intentId}"
                  rows="2"
                  bind:value={app.intentAbandonReason}
                  disabled={app.intentAbandoningId !== ""}></textarea>
              </div>
              <p class="hint">
                This drops the intent and records why. An abandoned intent is
                not run and cannot be reopened; to pursue the question again,
                add a new intent.
              </p>
              <div class="actions">
                <Button
                  variant="quiet"
                  disabled={app.intentAbandoningId !== ""}
                  onclick={() => app.cancelIntentAbandon()}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  type="submit"
                  loading={app.intentAbandoningId === intent.intentId}
                >
                  {app.intentAbandoningId === intent.intentId
                    ? "Abandoning…"
                    : "Abandon intent"}
                </Button>
              </div>
            </form>
          {/if}

          {#if app.intentAbandonDetailId === intent.intentId && app.intentAbandonDetail !== ""}
            <p class="error" role="alert">{app.intentAbandonDetail}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .intents {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font: 600 11px/var(--lh-compact) var(--font-sans);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  p {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-base);
  }
  .hint {
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
  }
  .error {
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: var(--lh-compact);
    /* The store's sentences are long and written to be read whole. */
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .add {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 14px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label[for],
  legend {
    padding: 0;
    font: 530 13px/var(--lh-compact) var(--font-sans);
  }
  textarea,
  select {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-base);
    font: 400 16px/24px var(--font-sans);
  }
  textarea {
    resize: vertical;
  }
  select {
    min-height: 44px;
  }
  textarea:disabled,
  select:disabled {
    opacity: 0.55;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 260px;
    overflow-y: auto;
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    cursor: pointer;
  }
  .choice:has(input:checked) {
    border-color: var(--border-focus);
  }
  .choice input {
    margin-top: 3px;
  }
  .choice > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .claim {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .meta {
    font-size: 11px;
    color: var(--text-faint);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border-base);
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
  }
  .row.aimed {
    border-color: var(--border-focus);
  }
  .top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .question {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .facts {
    display: grid;
    grid-template-columns: 84px 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: 12px;
  }
  dt {
    color: var(--text-faint);
  }
  dd {
    margin: 0;
    color: var(--text-base);
    overflow-wrap: anywhere;
  }
  .aside {
    color: var(--text-muted);
  }
  .controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .why {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }

  /*
    The word carries the meaning and the tint reinforces it. Running is info, answered is
    success, and abandoned is neutral for the reason a goal's is: dropping a direction is a
    decision and not a fault.
  */
  .chip {
    display: inline-flex;
    align-items: center;
    flex: none;
    padding: 1px 8px;
    border: 1px solid var(--border-base);
    border-radius: 99px;
    font: 530 11px/var(--lh-compact) var(--font-sans);
    white-space: nowrap;
  }
  .claimed {
    border-color: var(--state-border-info);
    background: var(--state-bg-info);
    color: var(--state-fg-info);
  }
  .answered {
    border-color: var(--state-border-success);
    background: var(--state-bg-success);
    color: var(--state-fg-success);
  }
  .abandoned,
  .proposed {
    background: var(--bg-layer-02);
    color: var(--text-muted);
  }
</style>
