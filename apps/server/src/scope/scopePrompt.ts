/**
 * The scope block an agent is given, from one renderer.
 *
 * Two paths prompt an agent to act on a target and they differ in everything else: a
 * planner round goes through `plan/roundPrompt.ts`'s preamble, and a worker attempt gets
 * its intent's question and nothing else. **One renderer produces the block for both**, so
 * the two prompts cannot drift about what the scope is — which is the anti-goal about two
 * code paths that can disagree, applied to the half an agent actually reads.
 *
 * The framing follows ScopeWeaver's `agent/constraints.go`, including its closing sentence
 * that discovering something outside the scope does not grant authorization. What is *not*
 * borrowed is where the text comes from: ScopeWeaver builds its block from free-text
 * `task_constraints` rather than from its own scope table, so the thing the agent reads
 * and the thing the coverage query uses are two unrelated strings. Here both come from the
 * entries and the labels.
 *
 * ## Three rules on the block itself
 *
 * - **Nothing in scope means no block.** With no `in` entry and no `in` label, the target
 *   gets the prompt it gets today, unchanged. Rendering "In scope: (nothing)" would tell
 *   every existing target's agent it may touch nothing, and migration `0022` creates these
 *   tables empty for every target that already exists. The block appears the moment the
 *   operator puts the first thing in scope.
 * - **The planner's variant drops the `record_asset` line**, because the planner cannot
 *   call it. The rest is identical, from this same function.
 * - **It is never truncated.** `GOAL_BRIEFING_MAX_CHARS` bounds the briefing and this sits
 *   outside it. Truncating an in-scope list would be the silent-coverage anti-goal with
 *   extra steps, and truncating the out-list would tell an agent a host is fair game.
 *
 * ## Why labels are folded in rather than listed apart
 *
 * From the agent's side there is no difference between "excluded because you typed it" and
 * "excluded because you clicked it" — both are the operator saying so, and an agent given
 * two lists to reconcile would be doing the store's job. So each entry appears under its
 * own effect and each label under its state, and a label that overrode an entry appears
 * once, under the effect the label gave it, and not at all under the other.
 *
 * That last clause is a suppression rule rather than a consequence of deduplication, and
 * it is implemented as one — see {@link scopeListsOf}. Deduplication is by rendered
 * sentence, and the sentence a label renders differs from the sentence its entry renders
 * by the words `, set by hand`, so two sentences about one host never collide on their
 * own.
 */
import {
  describeScopeEntry,
  type AssetScopeLabel,
  type HostScopeLabel,
  type ScopeEntry,
} from "@bit/contracts";

/** The first line of the block, which is also how a test and a reader recognise one. */
export const SCOPE_BLOCK_MARKER =
  "[Authorized testing scope — highest priority]";

/**
 * Which agent the block is for.
 *
 * Only one thing differs, and it is a capability rather than a tone: a worker can call
 * `record_asset` and a planner round cannot (D9), so telling a round to record what it
 * finds would be an instruction it has no tool for.
 */
export type ScopeAudience = "worker" | "planner";

/** One labelled asset, with the identity the block names it by. */
export interface LabelledAsset {
  readonly label: AssetScopeLabel;
  /** The asset's canonical identity, which is what an agent can act on. */
  readonly identity: string;
}

/** Everything the block is rendered from. The store's `targetScope`, essentially. */
export interface ScopeForPrompt {
  readonly entries: readonly ScopeEntry[];
  readonly hostLabels: readonly HostScopeLabel[];
  readonly assetLabels: readonly LabelledAsset[];
}

/**
 * How wide a rendered list line may be before it wraps.
 *
 * A prompt is read by a model and, in the Scope tab's preview panel, by the operator. A
 * single 2,000-character line is legible to neither, and the wrap point is fixed rather
 * than terminal-derived so the block is a pure function of the scope.
 */
const WRAP_AT = 76;

/**
 * One labelled list, wrapped, with its items separated by semicolons.
 *
 * Semicolons rather than commas because an item can contain a comma — "and every
 * subdomain" will not, but an operator's own value could — and a list an agent has to
 * guess the boundaries of is a list it can misread.
 */
const renderList = (label: string, items: readonly string[]): string[] => {
  const lines: string[] = [];
  let current = `${label}:`;
  for (const [index, item] of items.entries()) {
    const piece = index === items.length - 1 ? item : `${item};`;
    if (
      current.length + 1 + piece.length > WRAP_AT &&
      current !== `${label}:`
    ) {
      lines.push(current);
      // Two spaces, so a wrapped continuation is visibly part of the line above it
      // rather than a new heading.
      current = `  ${piece}`;
      continue;
    }
    current = `${current} ${piece}`;
  }
  lines.push(current);
  return lines;
};

/**
 * The in-scope and out-of-scope lists, as the sentences every surface shows.
 *
 * Exported because the Scope tab's preview panel renders the same two lists, and because
 * a test should be able to assert what is in each without parsing the block.
 *
 * Every item goes through `describeScopeEntry` or the label equivalents, so nothing is
 * ever shown as bare text. An entry reading `acme.com` that silently means "and every
 * subdomain" is the misread this whole model exists to prevent, and this is the one place
 * it is fixed for every surface at once.
 *
 * Deduplicated by rendered sentence, and — the rule with teeth — **a `host` entry whose
 * host a hand label also names is not mentioned at all.** The label speaks for that host,
 * in both directions:
 *
 * - Opposite effects are a flat contradiction on the page. `out`/`host`/`blog.acme.test`
 *   with an `in` label on `blog.acme.test` would otherwise render the host under *both*
 *   headings — the effective state is `in`, correctly, but the authorization text the
 *   agent reads would say two things. The label wins (D5), so the entry is silent.
 * - Equal effects are redundant rather than contradictory, and the entry is still
 *   silent, because the two sentences state the same reach — "that host only" — and
 *   differ only in provenance, which the agent has no use for.
 *
 * **Only a `host` entry is suppressed, and only on an exact value match.** A `subtree`
 * entry covering a promoted host is not a contradiction and stays: `out`/`subtree`/
 * `labs.acme.test` with an `in` label on `x.labs.acme.test` is two true statements, and
 * dropping the entry would stop telling the agent that the rest of that subtree is
 * excluded. The same holds when a subtree's own apex is labelled — the entry still
 * reaches every host under it, so it keeps saying so.
 */
export const scopeListsOf = (
  scope: ScopeForPrompt,
): {
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
} => {
  const inScope: string[] = [];
  const outOfScope: string[] = [];

  const push = (state: "in" | "out", sentence: string) => {
    const list = state === "in" ? inScope : outOfScope;
    if (!list.includes(sentence)) list.push(sentence);
  };

  /*
   * The hosts a hand label names, which is what decides them whatever the entries say.
   *
   * Both sides are already normalised through `normaliseHost` — an entry value on write,
   * a label key on write — so an exact string comparison is the whole test, and it is
   * the same comparison the ladder itself makes when it looks a label up by host.
   */
  const labelledHosts = new Set(scope.hostLabels.map((label) => label.host));

  for (const entry of scope.entries) {
    if (entry.kind === "host" && labelledHosts.has(entry.value)) continue;
    push(entry.effect, describeScopeEntry(entry));
  }
  for (const label of scope.hostLabels) {
    // A host label reaches that host and everything recorded on it, which is narrower
    // than a subtree and is rendered as what it is rather than as an apex.
    push(label.state, `${label.host} (that host only, set by hand)`);
  }
  for (const labelled of scope.assetLabels) {
    push(
      labelled.label.state,
      `${labelled.identity} (that one asset, set by hand)`,
    );
  }

  return { inScope, outOfScope };
};

/**
 * The block, or `undefined` when there is nothing in scope.
 *
 * `undefined` rather than an empty string, so a caller has to decide what to do about the
 * absence rather than concatenating a blank line and moving on.
 */
export const renderScopeBlock = (input: {
  readonly scope: ScopeForPrompt;
  readonly audience: ScopeAudience;
}): string | undefined => {
  const { inScope, outOfScope } = scopeListsOf(input.scope);

  /*
   * The first of D6's three rules, and the one with teeth.
   *
   * Nothing authorized means no block at all — not a block saying nothing is authorized.
   * Every target that existed before migration `0022` has empty scope tables, including
   * the fixtures in `run/supervisor.test.ts`, and a block reading "In scope: (nothing)"
   * would tell all of their agents they may touch nothing.
   *
   * Note what this does *not* do: the default-is-out rule still holds for the labels and
   * for the view. It simply does not get spoken aloud to an agent, because "out by
   * default" is a labelling convention and not an instruction.
   */
  if (inScope.length === 0) return undefined;

  const lines: string[] = [
    SCOPE_BLOCK_MARKER,
    ...renderList("In scope", inScope),
  ];
  if (outOfScope.length > 0) {
    // Omitted entirely when empty rather than rendered as an empty heading: "Explicitly
    // OUT of scope:" with nothing after it reads as a truncation.
    lines.push(...renderList("Explicitly OUT of scope", outOfScope));
  }
  lines.push("");
  lines.push(
    "Discovering a host outside the in-scope list does not grant authorization.",
  );
  lines.push(
    input.audience === "worker"
      ? "Record it with record_asset and move on; do not derive intents for it."
      : // The planner has no `record_asset` — it is a worker tool, because a discovery's
        // provenance needs an attempt — so it is told what not to do and nothing it
        // cannot do. An instruction naming a tool the model has no access to is a turn
        // spent discovering that.
        "Do not derive intents for it.",
  );
  return lines.join("\n");
};
