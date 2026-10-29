<script lang="ts">
  /**
   * The open target's goals: the list, and the dialog that makes one.
   *
   * A goal is an objective within this target's investigation — the thing intents and a
   * planner will later hang off. Nothing plans yet, so what this page does is the part
   * that exists: create a goal, see the target's goals, open one. It reads
   * `app.goals`, which holds exactly one target's rows (`app.goalsTargetId` says whose),
   * so switching targets cannot leave another engagement's objectives on this page.
   *
   * Three states are kept apart on purpose, because "no goals" is a fact and "not read
   * yet" and "could not read" are not: an empty-state sentence shown while the request is
   * in flight would tell the operator, falsely and for a moment, that their target has
   * nothing in it.
   */
  import Banner from "../components/Banner.svelte";
  import Button from "../components/Button.svelte";
  import Field from "../components/Field.svelte";
  import GoalStatusChip from "../components/GoalStatusChip.svelte";
  import Modal from "../components/Modal.svelte";
  import PageFrame from "../components/PageFrame.svelte";
  import { countsLine, goalTitle, whenText } from "../goalFormat";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  /** Only this target's rows, whatever else the store holds from an earlier visit. */
  let goals = $derived(app.goalsTargetId === app.viewTargetId ? app.goals : []);
</script>

<PageFrame
  title="Goals"
  description="What this target's investigation is trying to establish. A goal stays open until you end it."
>
  {#snippet actions()}
    <Button variant="primary" onclick={() => app.openGoalDialog()}>
      New goal
    </Button>
  {/snippet}

  {#snippet body()}
    {#if app.goalsState === "failed"}
      <div class="notice">
        <Banner tone="danger">
          {app.goalsDetail}
        </Banner>
        <Button onclick={() => void app.loadGoals(app.viewTargetId)}>
          Try again
        </Button>
      </div>
    {:else if goals.length === 0 && app.goalsState !== "ready"}
      <p class="quiet" role="status">Reading this target's goals…</p>
    {:else if goals.length === 0}
      <div class="empty">
        <p class="empty-lead">No goals in this target yet.</p>
        <p class="empty-more">
          A goal is an objective — "find out whether the login limiter can be
          bypassed". Write one and it stays here, open, until you end it.
        </p>
        <Button variant="primary" onclick={() => app.openGoalDialog()}>
          New goal
        </Button>
      </div>
    {:else}
      <ul class="rows" aria-label="Goals">
        {#each goals as goal (goal.goalId)}
          <li>
            <button class="row" onclick={() => app.openGoal(goal.goalId)}>
              <span class="main">
                <span class="title">{goalTitle(goal)}</span>
                {#if goal.name !== ""}
                  <span class="objective">{goal.description}</span>
                {/if}
                <span class="meta">
                  {countsLine(goal.counts)} · created {whenText(goal.createdAt)}
                </span>
              </span>
              <GoalStatusChip status={goal.status} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/snippet}
</PageFrame>

{#if app.goalDialogOpen}
  <Modal title="New goal" onclose={() => app.closeGoalDialog()}>
    {#snippet body()}
      <form
        id="new-goal"
        onsubmit={(event) => {
          event.preventDefault();
          void app.createGoal();
        }}
      >
        <Field
          id="goal-name"
          label="Name (optional)"
          placeholder="Auth bypass"
          bind:value={app.goalName}
          disabled={app.goalCreating}
        />
        <div class="area">
          <label for="goal-objective">Objective</label>
          <textarea
            id="goal-objective"
            rows="5"
            placeholder="What should this goal establish?"
            bind:value={app.goalObjective}
            disabled={app.goalCreating}
            aria-invalid={app.goalCreateDetail !== ""}
            aria-describedby={app.goalCreateDetail !== ""
              ? "goal-objective-error"
              : undefined}></textarea>
          {#if app.goalCreateDetail !== ""}
            <p class="error" id="goal-objective-error" role="alert">
              {app.goalCreateDetail}
            </p>
          {/if}
        </div>
      </form>
    {/snippet}

    {#snippet footer()}
      <Button
        variant="quiet"
        disabled={app.goalCreating}
        onclick={() => app.closeGoalDialog()}
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        loading={app.goalCreating}
        disabled={app.goalObjective.trim() === ""}
        onclick={() => void app.createGoal()}
      >
        {app.goalCreating ? "Creating…" : "Create goal"}
      </Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .quiet {
    margin: 24px 10px;
    font-size: 13px;
    color: var(--text-faint);
  }
  .notice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    margin: 8px 8px 0;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    max-width: 460px;
    margin: 24px 10px;
  }
  .empty-lead {
    margin: 0;
    font: 530 14px/var(--lh-base) var(--font-sans);
  }
  .empty-more {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: var(--lh-base);
    color: var(--text-muted);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    min-height: 44px;
    padding: 10px 10px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-layer-01);
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .title {
    font: 530 13px/var(--lh-base) var(--font-sans);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .objective {
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-faint);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .area {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    font: 530 13px/var(--lh-compact) var(--font-sans);
    color: var(--text-base);
  }
  textarea {
    width: 100%;
    min-height: 120px;
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    font: 400 16px/24px var(--font-sans);
    resize: vertical;
    transition: border-color var(--dur-hover) ease-out;
  }
  textarea::placeholder {
    color: var(--text-faint);
  }
  textarea:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  textarea:disabled {
    opacity: 0.55;
  }
  textarea[aria-invalid="true"] {
    border-color: var(--state-border-danger);
  }
  .error {
    margin: 0;
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
</style>
