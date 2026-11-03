<script lang="ts" module>
  /**
   * What a caller holds while the dialog is up: one value, `undefined` when it is closed.
   *
   * ```svelte
   * let failure = $state<ErrorNotice | undefined>();
   * // on a refusal: failure = { title: "Model not switched", sentence: answer.detail };
   *
   * {#if failure !== undefined}
   *   <ErrorDialog {...failure} ondismiss={() => (failure = undefined)} />
   * {/if}
   * ```
   */
  export interface ErrorNotice {
    /** What failed, in the app's words: "Model not switched". */
    readonly title: string;
    /** Why, in the server's words, shown as it stands. */
    readonly sentence: string;
    /** A secondary line, set in mono: an error code, a status. */
    readonly detail?: string;
  }
</script>

<script lang="ts">
  /**
   * "The server refused this, and here is why", as a dialog: a title, the server's
   * sentence, an optional code under it, and one way out.
   *
   * ## How a caller opens it
   *
   * Like `ConfirmAction`: the caller renders it under an `{#if}` and closes it from
   * `ondismiss`, holding one {@link ErrorNotice} that is `undefined` while it is closed (see
   * the example on the type). Not a bindable `open`, and not a store with one host on the
   * page: a refusal is about the control that sent the request, and the caller is the one
   * that knows that control — which it can pass as `opener` for focus to go back to — and
   * whether a refusal also changes anything else it draws.
   *
   * ## Where it belongs, and where it does not
   *
   * For a refusal that has nowhere better to be said: a model switch the harness would
   * not make, an upload the server would not take. A refusal that has a place beside the
   * thing it is about — the importer's send, under the draft it refused; a scope
   * contradiction, beside the rows — stays there. A modal there would cover the words the
   * operator is about to correct.
   *
   * ## The sentence is text
   *
   * It can carry an agent's or a target's words, so it is never HTML and never markdown:
   * it is interpolated as a text node, and `<b>` in it reads as `<b>`. A long one wraps —
   * anywhere, so a URL or a token cannot push the panel wider — and the body scrolls
   * inside the panel's height, so nothing of it is cut off and the dismiss button stays
   * on screen.
   *
   * ## Being a dialog
   *
   * It is {@link Modal} with the options for this: `alertdialog`, named by the title and
   * described by the sentence. Focus follows `dialogFocus` like every other dialog's — onto
   * the panel, not the button, so the Enter that sent a message cannot also dismiss the
   * refusal of it — and goes back to the opener on close. Escape, the button, and a click
   * on the scrim all close it, as the harness picker's dialog does: nothing is lost by
   * closing an acknowledgement. There is no header ×: the button is the one way out.
   *
   * "Close" rather than "OK" because it is the app's word for leaving a dialog: `Modal`'s ×
   * and `HarnessDialog`'s scrim both say it.
   */
  import Modal from "./Modal.svelte";

  let {
    title,
    sentence,
    detail,
    dismissLabel = "Close",
    ondismiss,
    opener = null,
  }: ErrorNotice & {
    dismissLabel?: string;
    ondismiss: () => void;
    /** The control whose request was refused, which focus returns to. */
    opener?: HTMLElement | null;
  } = $props();

  const sentenceId = $props.id();
</script>

<Modal
  {title}
  role="alertdialog"
  describedby={sentenceId}
  scrimCloses
  closeButton={false}
  width={440}
  {opener}
  onclose={ondismiss}
>
  {#snippet body()}
    <div class="message">
      <p class="sentence" id={sentenceId}>{sentence}</p>
      {#if detail !== undefined && detail !== ""}
        <p class="detail">{detail}</p>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <button type="button" class="dismiss" onclick={ondismiss}>
      {dismissLabel}
    </button>
  {/snippet}
</Modal>

<style>
  .message {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .sentence {
    font: 400 13px/20px var(--font-sans);
    color: var(--text-base);
  }
  .detail {
    font: 400 12px/16px var(--font-mono);
    color: var(--text-muted);
  }
  /*
   * `ConfirmAction`'s neutral confirm, which is D6's "Use for this session": the one solid
   * object on the dialog, inverse fill, darkened by an inset overlay on hover and press.
   */
  .dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    box-sizing: border-box;
    background: var(--bg-inverse);
    color: var(--text-inverse);
    font: 500 12px/16px var(--font-sans);
    cursor: pointer;
  }
  .dismiss:hover {
    box-shadow: inset 0 0 0 999px
      color-mix(in srgb, var(--text-inverse) 12%, transparent);
  }
  .dismiss:active {
    box-shadow: inset 0 0 0 999px
      color-mix(in srgb, var(--text-inverse) 21%, transparent);
  }
</style>
