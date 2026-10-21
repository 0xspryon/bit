<script lang="ts">
  import { IconEye, IconEyeSlash } from "../icons";

  let {
    id,
    label,
    value = $bindable(""),
    type = "text",
    placeholder = "",
    error = "",
    mono = false,
    disabled = false,
    reveal = false,
    revealed = $bindable(false),
  }: {
    id: string;
    label: string;
    value?: string;
    type?: "text" | "password" | "url";
    placeholder?: string;
    error?: string;
    mono?: boolean;
    disabled?: boolean;
    /** Adds a show/hide control. Only meaningful for a password field. */
    reveal?: boolean;
    revealed?: boolean;
  } = $props();

  let inputType = $derived(reveal && revealed ? "text" : type);
</script>

<div class="field">
  <label for={id}>{label}</label>
  <!-- `type` is dynamic, so this sets `value` by hand rather than binding. -->
  <span class="wrap">
    <input
      {id}
      type={inputType}
      {placeholder}
      {disabled}
      {value}
      oninput={(event) => (value = event.currentTarget.value)}
      class={[
        mono && "mono",
        error !== "" && "invalid",
        reveal && "has-reveal",
      ]}
      aria-invalid={error !== ""}
      aria-describedby={error !== "" ? `${id}-error` : undefined}
    />
    {#if reveal}
      <button
        type="button"
        class="reveal"
        {disabled}
        aria-label={revealed ? "Hide password" : "Show password"}
        aria-pressed={revealed}
        onclick={() => (revealed = !revealed)}
      >
        {#if revealed}
          <IconEyeSlash width="14" height="14" />
        {:else}
          <IconEye width="14" height="14" />
        {/if}
      </button>
    {/if}
  </span>
  {#if error !== ""}
    <p class="error" id="{id}-error" role="alert">{error}</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  label {
    font: 530 13px/var(--lh-compact) var(--font-sans);
    color: var(--text-base);
  }
  .wrap {
    position: relative;
    display: block;
  }
  .reveal {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--icon-muted);
    cursor: pointer;
  }
  .reveal:hover:not(:disabled) {
    background: var(--overlay-hover);
    color: var(--text-base);
  }
  input {
    width: 100%;
    height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-base);
    /* 16px keeps iOS from zooming the viewport on focus. */
    font: 400 16px/24px var(--font-sans);
    transition: border-color var(--dur-hover) ease-out;
  }
  input.has-reveal {
    padding-right: 42px;
  }
  input.mono {
    font-family: var(--font-mono);
    font-size: 14px;
  }
  input::placeholder {
    color: var(--text-faint);
  }
  input:hover:not(:disabled) {
    border-color: var(--border-strong);
  }
  input:disabled {
    opacity: 0.55;
  }
  input.invalid {
    border-color: var(--state-border-danger);
  }
  .error {
    margin: 0;
    color: var(--state-fg-danger);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
</style>
