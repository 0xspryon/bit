<script lang="ts">
  import Button from "../components/Button.svelte";
  import Field from "../components/Field.svelte";
  import { START_COMMAND } from "../mock";
  import type { App } from "../app.svelte";

  let { app }: { app: App } = $props();

  let urlError = $derived(
    app.connectError === "unreachable"
      ? "No server answered at this address."
      : "",
  );
  let passwordError = $derived(
    app.connectError === "password"
      ? "That password was refused. No session was created."
      : "",
  );
</script>

<main class="connect">
  <div class="column">
    <div class="brand">
      <span class="mark">bit</span>
      <span class="sub">Hunt Platform</span>
    </div>

    <header>
      <h1>Connect to your server</h1>
      <p>
        The control plane runs on your machine. Point the app at it and
        authenticate.
      </p>
    </header>

    {#if app.connectError === "expired"}
      <div class="notice" role="status">
        Your session ended. Sign in again to carry on where you left off.
      </div>
    {/if}

    <form
      onsubmit={(event) => {
        event.preventDefault();
        void app.connect();
      }}
    >
      <Field
        id="server-url"
        label="Server URL"
        type="url"
        mono
        bind:value={app.serverUrl}
        error={urlError}
        disabled={app.connecting}
      />
      <Field
        id="password"
        label="Password"
        type="password"
        placeholder="••••••••"
        reveal
        bind:revealed={app.passwordVisible}
        bind:value={app.password}
        error={passwordError}
        disabled={app.connecting}
      />
      <Button
        type="submit"
        variant="primary"
        full
        loading={app.connecting}
        disabled={app.password.length === 0}
      >
        {app.connecting ? "Connecting…" : "Connect"}
      </Button>
    </form>

    <p class="hint">
      The password is the one the server printed to its terminal the first time
      it started. It is shown once and is not recoverable.
    </p>

    {#if app.connectError === "unreachable"}
      <footer>
        <p class="hint">Not running? Start it with:</p>
        <code class="block mono">{START_COMMAND}</code>
        {#if app.connectDetail !== ""}
          <p class="hint detail mono">{app.connectDetail}</p>
        {/if}
      </footer>
    {/if}
  </div>
</main>

<style>
  .connect {
    display: flex;
    flex: 1;
    width: 100%;
    overflow: auto;
    padding: max(48px, env(safe-area-inset-top))
      max(24px, env(safe-area-inset-right))
      max(32px, env(safe-area-inset-bottom))
      max(24px, env(safe-area-inset-left));
    background: var(--bg-base);
  }
  .column {
    display: flex;
    flex-direction: column;
    width: min(100%, 360px);
    margin: auto;
    gap: 16px;
  }
  .brand {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    margin-block-end: 16px;
  }
  .mark {
    font-family: var(--font-mono);
    font-size: 30px;
    letter-spacing: -0.04em;
    color: var(--text-base);
  }
  .sub {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  header {
    text-align: center;
    margin-block-end: 16px;
  }
  h1 {
    margin: 0 0 8px;
    font: 530 20px/28px var(--font-sans);
  }
  header p {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-base);
    color: var(--text-muted);
  }
  .notice {
    padding: 10px 12px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    color: var(--text-muted);
    font-size: 12px;
    line-height: var(--lh-compact);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: var(--lh-compact);
    color: var(--text-faint);
    text-align: center;
  }
  footer {
    margin-block-start: 16px;
    text-align: center;
  }
  .detail {
    margin-block-start: 12px;
    font-size: 11px;
    word-break: break-word;
  }
  code.block {
    display: inline-block;
    margin-block-start: 12px;
    padding: 8px 16px;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-md);
    background: var(--bg-layer-01);
    font-size: 13px;
    line-height: var(--lh-base);
    color: var(--text-muted);
    user-select: all;
  }
</style>
