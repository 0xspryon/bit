/**
 * A Claude Code instance's model names, as its frames spell them, mapped back to the
 * catalogue entry a run asked for.
 *
 * ## Why there are two spellings
 *
 * A run names a model in the catalogue's spelling, and the CLI resolves it through the
 * instance's settings. On the operator's Anthropic login the two agree up to a release date
 * (`claude-haiku-4-5` is reported as `claude-haiku-4-5-20251001`), which `modelKey` in
 * `@bit/contracts` already takes off. On an **aliasing** instance they do not agree at all:
 * a z.ai instance's `settings.json` maps the `sonnet` alias to `glm-5.3-flash`, so a session
 * asked for `sonnet` reports `glm-5.3-flash` everywhere the CLI names a model. Measured on
 * CLI 2.1.310 (2026-11-10), every one of these says the provider's name:
 *
 * - `system/init`'s `model`, at every turn's start, after a switch too;
 * - each call's `message.model` (stream `message_start` and `assistant` frames, and the
 *   stored transcript entries a replay reads);
 * - `getContextUsage().model`, from the moment `setModel` returns;
 * - the `/model` echo, `Set model to \`opus (glm-5.3)\``.
 *
 * Every place bit matches a frame's model against the session's catalogue model — the
 * context meter's "measured on another model", the live usage frame that tells a tab the
 * session moved, a replayed reply's model — would read `glm-5.3-flash` as a model nobody
 * picked. So the harness hands every frame-derived model through this map and the rest of
 * bit sees the catalogue's spelling.
 *
 * ## Where the map comes from
 *
 * Two sources, and the second is the one that cannot be wrong for a live session:
 *
 * 1. **Declared**: a configured model's `reportedAs` (`harness/instanceConfig.ts`). The only
 *    source before a session has said anything, which is what a replay or a context read
 *    after a restart needs.
 * 2. **Learned**: the CLI's own answer for the model the session was asked for — its
 *    `system/init` frame, and the context read right after a switch. Both name the model the
 *    session is on, in the provider's spelling, at a moment the harness knows which
 *    catalogue entry it asked for.
 *
 * Two catalogue entries can resolve to one provider model (z.ai maps `sonnet` and `haiku`
 * both to `glm-5.3-flash`). The session's own model wins where it is one of them; otherwise
 * the entry learned most recently.
 *
 * A spelling that already names a catalogue entry (by `modelKey`) is left alone, so the
 * Anthropic instance's dated spellings reach the browser exactly as they did before.
 */
import { modelKey } from "@bit/contracts";

export interface ModelSpellings {
  /** The CLI answered `reported` for a session asked to run `asked`. */
  readonly learn: (
    reported: string | undefined,
    asked: string | undefined,
  ) => void;
  /**
   * `reported` in the catalogue's spelling where this instance knows the mapping, else as
   * it came. `current` is the session's own model, preferred among several matches.
   */
  readonly toCatalogue: (
    reported: string | undefined,
    current: string | undefined,
  ) => string | undefined;
  /**
   * The provider's own name for one catalogue entry, where it is another name than the
   * entry's: declared, or the newest a session reported. What a screen falls back to when
   * the entry has no label (follow-ups A), so an alias is not shown as the model.
   */
  readonly providerName: (catalogueId: string) => string | undefined;
}

export const modelSpellings = (
  catalogue: readonly {
    readonly id: string;
    readonly reportedAs?: string | undefined;
  }[],
): ModelSpellings => {
  const catalogueKeys = new Set(catalogue.map((entry) => modelKey(entry.id)));
  /** Provider spelling (keyed) → catalogue ids, oldest first. */
  const learned = new Map<string, string[]>();
  /** Catalogue id → the provider's spelling of it, as last reported. */
  const named = new Map<string, string>();

  const learn: ModelSpellings["learn"] = (reported, asked) => {
    if (reported === undefined || asked === undefined) return;
    if (reported.trim() === "" || asked.trim() === "") return;
    const key = modelKey(reported);
    if (key === modelKey(asked) || catalogueKeys.has(key)) return;
    const ids = learned.get(key) ?? [];
    const at = ids.indexOf(asked);
    if (at !== -1) ids.splice(at, 1);
    ids.push(asked);
    learned.set(key, ids);
    named.set(asked, reported.trim());
  };

  for (const entry of catalogue) learn(entry.reportedAs, entry.id);

  return {
    learn,
    toCatalogue: (reported, current) => {
      if (reported === undefined || reported === "") return reported;
      const key = modelKey(reported);
      if (catalogueKeys.has(key)) return reported;
      const ids = learned.get(key);
      if (ids === undefined || ids.length === 0) return reported;
      if (current !== undefined && ids.includes(current)) return current;
      return ids[ids.length - 1];
    },
    providerName: (catalogueId) => named.get(catalogueId),
  };
};
