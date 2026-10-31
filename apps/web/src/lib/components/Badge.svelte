<script lang="ts">
  /**
   * Target badge. Neutral by design: with the monochrome direction the letters
   * carry identity instead of a colour.
   *
   * The tone says how the target stands relative to the screen, not what it is:
   * `current` is the target you are in (the one filled badge on any screen),
   * `plain` is any other, and `quiet` is one with nothing in it or nothing to
   * open. Two letters where there is room for them, one in the crumb.
   */
  let {
    name,
    size = 24,
    letters = 1,
    tone = "plain",
  }: {
    name: string;
    size?: number;
    letters?: 1 | 2;
    tone?: "current" | "plain" | "quiet";
  } = $props();

  let initials = $derived(
    (
      name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, letters) || "?"
    ).toUpperCase(),
  );
</script>

<span
  class={["badge", tone]}
  style:--size="{size}px"
  style:--ratio={letters === 2 ? 0.42 : 0.56}
  aria-hidden="true">{initials}</span
>

<style>
  .badge {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--size);
    height: var(--size);
    border-radius: var(--radius-sm);
    font: 600 calc(var(--size) * var(--ratio)) / 1 var(--font-sans);
    user-select: none;
  }
  .current {
    background: var(--bg-inverse);
    color: var(--bg-deep);
  }
  .plain {
    background: var(--bg-layer-03);
    color: var(--text-base);
  }
  .quiet {
    background: var(--bg-layer-02);
    color: var(--text-muted);
  }
</style>
