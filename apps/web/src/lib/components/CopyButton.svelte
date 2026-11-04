<script lang="ts">
  /**
   * D3/D4's copy glyph beside "You · 18:02" and under a finished turn: copies one piece of
   * the conversation's text as it stands.
   *
   * The clipboard API needs a secure context, which bit's localhost is; where it is missing
   * or refused, the button says so rather than claiming a copy (`Markdown`'s fence Copy
   * does the same). What happened is said in the button's title and in a polite status
   * beside it, for a reader who cannot see the glyph change.
   */
  import { IconCheck, IconCopy } from "../icons";

  let { text, label }: { text: string; label: string } = $props();

  /** How long the button says what happened before it is a copy button again. */
  const SAID_FOR_MS = 1500;

  let said = $state<"" | "Copied" | "Copy failed">("");
  let timer: ReturnType<typeof setTimeout> | undefined;

  function copy(): void {
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    const done = (word: "Copied" | "Copy failed"): void => {
      said = word;
      clearTimeout(timer);
      timer = setTimeout(() => (said = ""), SAID_FOR_MS);
    };
    if (clipboard === undefined) {
      done("Copy failed");
      return;
    }
    clipboard.writeText(text).then(
      () => done("Copied"),
      () => done("Copy failed"),
    );
  }

  $effect(() => () => clearTimeout(timer));
</script>

<button
  class="copy"
  type="button"
  aria-label={label}
  title={said === "" ? label : said}
  onclick={copy}
>
  {#if said === "Copied"}
    <IconCheck width="13" height="13" aria-hidden="true" />
  {:else}
    <IconCopy width="13" height="13" aria-hidden="true" />
  {/if}
</button>
<span class="visually-hidden" role="status">{said}</span>

<style>
  .copy {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    /* D3 draws it faint; muted, because a control's glyph needs 3:1 against the page. */
    color: var(--icon-muted);
    cursor: pointer;
  }
  .copy:hover {
    color: var(--icon-base);
  }
  .copy:focus-visible {
    outline: 1px solid var(--border-focus);
    outline-offset: 1px;
  }
</style>
