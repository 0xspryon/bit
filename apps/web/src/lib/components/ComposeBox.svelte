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
   * **There is deliberately no *live* transcript.** The run narrates — the server publishes
   * every step of it onto an in-process bus — and nothing subscribes yet; the stream is
   * Day 6's. What a *settled* attempt left behind is readable, and that is a different
   * thing: the server writes the harness's own log into the target's `evidence/` directory
   * when the attempt settles, and {@link TranscriptPanel} reads it back. What this box
   * shows while a run is going is still the honest minimum: that it is going, how long it
   * has been going, and the attempt it is going under.
   *
   * **The harness and the model are chosen here.** {@link HarnessPicker} is a popover on
   * this row, which is why it is here rather than in the shell: the choice belongs to the
   * thing being submitted, and it must not disturb the Level 2 frame behind it.
   *
   * **The elapsed time is a fact about the request, not a deadline.** Nothing counts down
   * and nothing settles when it runs out: settlement is the harness's to decide
   * (DECISIONS.md §5), and a progress bar would be an invented estimate of something
   * genuinely unbounded.
   */
  import Button from "./Button.svelte";
  import HarnessPicker from "./HarnessPicker.svelte";
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
  /**
   * Whether the harness the operator picked will take a run.
   *
   * Read off the picker's own answer rather than guessed: an instance that is configured
   * and unusable is *visible* and not *ready*, and submitting into it would produce a
   * refusal the server has already told us about. The sentence under the box says which,
   * so the disabled button is never unexplained.
   */
  let harnessReady = $derived(app.pickedInstance?.ready === true);
  let canSubmit = $derived(
    ready &&
      harnessReady &&
      running === undefined &&
      !app.starting &&
      app.instruction.trim().length > 0,
  );
  /**
   * Why the box will not submit, when the reason is the harness rather than the text.
   *
   * The picked instance's own reason when there is one, the server's "nothing configured"
   * when there is not. Never a generic "cannot run": a refusal an operator cannot act on
   * is the thing this product keeps refusing to render.
   */
  let harnessNote = $derived(
    harnessReady
      ? ""
      : app.harnesses.length === 0
        ? "This server configures no agent harness, so it will refuse every run."
        : (app.pickedInstance?.reason ??
          "The harness this run would use is not usable on this server."),
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
        <HarnessPicker {app} />
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

  {#if harnessNote !== "" && running === undefined}
    <!--
      Not `role="alert"`: this is a standing condition of the server rather than a response
      to something the operator just did, and announcing it on every repaint would be
      noise. The refusal below *is* an alert, because it is an answer.
    -->
    <p class="note">{harnessNote}</p>
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
