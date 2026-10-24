<script lang="ts">
  /**
   * Start a run against the open target, and stop the one that is running.
   *
   * **It is not a chat box, and the difference is the whole design.** Submitting does not
   * add a message to a conversation; it starts an *attempt* — a durable row with its own
   * identity, its own credential and its own place in the target's event log. So there is
   * one of them at a time per target, the control flips to Stop while it runs, and nothing
   * here pretends to show what the agent is doing.
   *
   * **There is deliberately no transcript.** The run narrates — the server publishes every
   * step of it onto an in-process bus — and nothing subscribes yet. The next slice adds the
   * stream and the transcript, and a format invented here would be the one that slice
   * inherited without having chosen it. What this shows instead is the honest minimum: that
   * a run is going, how long it has been going, and the attempt it is going under.
   *
   * **The elapsed time is a fact about the request, not a deadline.** Nothing counts down
   * and nothing settles when it runs out: settlement is the harness's to decide
   * (DECISIONS.md §5), and a progress bar would be an invented estimate of something
   * genuinely unbounded.
   */
  import Button from "./Button.svelte";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  /**
   * A ticking clock, so the elapsed time is live rather than frozen at render.
   *
   * `$effect` with a cleanup, which is what makes this correct under Svelte 5: the
   * interval is started when the component mounts and cleared when it unmounts, so a
   * closed target does not leave a timer behind. One second is as often as a value in
   * whole seconds can change.
   */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  });

  let running = $derived(app.activeRun);
  let elapsed = $derived(
    running === undefined
      ? ""
      : formatElapsed(Math.max(0, now - running.startedAt)),
  );
  /**
   * Whether this target can be run against at all.
   *
   * A target that will not open cannot be written to, so offering a box that submits into
   * a refusal would be worse than showing the refusal the header already carries.
   */
  let ready = $derived(app.viewState === "ready");
  let canSubmit = $derived(
    ready &&
      running === undefined &&
      !app.starting &&
      app.instruction.trim().length > 0,
  );

  function formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${String(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
    return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
  }

  /**
   * Enter submits, Shift+Enter breaks the line.
   *
   * The convention an operator will expect from the shape of the control, and the reason
   * the textarea is a textarea: an instruction describing what to probe is often more than
   * one line, and a single-line input would quietly truncate the way people write.
   */
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (canSubmit) void app.startRun();
  }
</script>

<section class="compose" aria-label="Start a run">
  {#if running !== undefined}
    <div class="status" role="status">
      <span class="pulse" aria-hidden="true"></span>
      <span class="status-text">
        Running for <strong>{elapsed}</strong>
      </span>
      <span class="attempt mono" title="Attempt {running.attemptId}">
        {running.attemptId}
      </span>
      <Button
        size="sm"
        variant="danger"
        loading={app.stopping}
        onclick={() => void app.stopRun()}
      >
        Stop
      </Button>
    </div>
    <p class="note">
      This run is going on the server, not in this tab — closing it will not
      stop the agent. Stopping settles the attempt and withdraws its write
      authority.
    </p>
  {:else}
    <div class="row">
      <textarea
        class="input"
        rows="2"
        placeholder={ready
          ? "What should this run find out?"
          : "This target cannot be opened, so nothing can run against it."}
        disabled={!ready || app.starting}
        bind:value={app.instruction}
        {onkeydown}></textarea>
      <div class="controls">
        <!--
          The model is shown and not chosen. This server pins one; a picker is a later
          slice, and a dropdown that the server ignored would be worse than a label.
        -->
        <span class="model mono" title="This server pins one model.">
          gpt-5.6-sol
        </span>
        <Button
          variant="primary"
          loading={app.starting}
          disabled={!canSubmit}
          onclick={() => void app.startRun()}
        >
          Start run
        </Button>
      </div>
    </div>
  {/if}

  {#if app.runDetail !== ""}
    <p class="refusal" role="alert">{app.runDetail}</p>
  {/if}
</section>

<style>
  .compose {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-base);
    background: var(--bg-layer-01);
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-base);
    color: var(--text-base);
    font: 400 13px/var(--lh-base) var(--font-sans);
    resize: vertical;
  }
  .input::placeholder {
    color: var(--text-faint);
  }
  .input:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .model {
    font-size: 11px;
    color: var(--text-faint);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status-text {
    font-size: 13px;
    color: var(--text-base);
  }
  .attempt {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-base, currentColor);
    animation: pulse 1.6s ease-in-out infinite;
  }
  /* Respects a reduced-motion preference: the dot is still there, it just stops. */
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  .note,
  .refusal {
    margin: 0;
    font-size: 11px;
    line-height: var(--lh-base);
  }
  .note {
    color: var(--text-faint);
  }
  .refusal {
    color: var(--text-danger, var(--text-base));
  }
</style>
