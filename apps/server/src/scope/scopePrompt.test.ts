/**
 * The scope block, and the four properties the design asks it to have.
 *
 * The block is what finally answers the first of the two reasons this work exists: the
 * agent is never told what it is authorized to test. It receives an intent question or a
 * goal briefing, and until now neither mentioned the client's estate at all.
 *
 * What is asserted here:
 *
 * - **A target with nothing in scope gets no block at all.** Not an empty block — none.
 * - **The planner's variant omits the `record_asset` line**, because it has no such tool.
 * - **Labels are folded into the two lists**, and a label that overrode an entry appears
 *   once, under the effect the label gave it.
 * - **Every item spells out its reach**, from the one renderer, so nothing is bare text.
 *
 * The two *wiring* properties — that a planner round and a worker attempt both receive it,
 * that the briefing's bytes are unchanged, and that `roundPromptOverhead` accounts for it
 * — are asserted in `plan/roundPrompt`'s own suite and in `plan/planSupervisor.test.ts`,
 * where the assembled prompt is available.
 */
import { describe, expect, test } from "bun:test";

import type {
  AssetScopeLabel,
  HostScopeLabel,
  ScopeEntry,
} from "@bit/contracts";

import {
  SCOPE_BLOCK_MARKER,
  renderScopeBlock,
  scopeListsOf,
  type ScopeForPrompt,
} from "./scopePrompt";

let nextEntry = 0;

const entry = (
  effect: "in" | "out",
  kind: "subtree" | "host" | "cidr",
  value: string,
): ScopeEntry => ({
  entryId: `ent_${String((nextEntry += 1)).padStart(3, "0")}`,
  targetId: "target-1",
  effect,
  kind,
  value,
  source: "operator",
  note: null,
  createdAt: 1_000,
});

const hostLabel = (host: string, state: "in" | "out"): HostScopeLabel => ({
  targetId: "target-1",
  host,
  state,
  reason: null,
  setBy: "target-1/operator",
  setAt: 2_000,
});

const assetLabel = (assetId: string, state: "in" | "out"): AssetScopeLabel => ({
  assetId,
  state,
  reason: null,
  setBy: "target-1/operator",
  setAt: 3_000,
});

const empty: ScopeForPrompt = {
  entries: [],
  hostLabels: [],
  assetLabels: [],
};

/** The design's own worked example, which is the shape the operator signed off. */
const worked: ScopeForPrompt = {
  entries: [
    entry("in", "subtree", "acme.test"),
    entry("in", "subtree", "acmelabs.test"),
    entry("in", "host", "app.partner.test"),
    entry("in", "cidr", "203.0.113.0/24"),
    entry("out", "subtree", "labs.acme.test"),
    entry("out", "host", "blog.acme.test"),
  ],
  hostLabels: [hostLabel("x.labs.acme.test", "in")],
  assetLabels: [
    {
      label: assetLabel("asset_metrics", "out"),
      identity: "GET https://app.acme.test:443/internal/metrics",
    },
  ],
};

/* ── Nothing in scope means no block ────────────────────────────────────────────── */

describe("a target with nothing in scope", () => {
  test("gets no block at all", () => {
    /*
     * The rule with teeth.
     *
     * Migration `0022` creates these tables empty for every target that already exists,
     * including the fixtures in `run/supervisor.test.ts`. A block reading
     * "In scope: (nothing)" would tell all of their agents they may touch nothing, which
     * is a worse instruction than silence.
     */
    expect(
      renderScopeBlock({ scope: empty, audience: "worker" }),
    ).toBeUndefined();
    expect(
      renderScopeBlock({ scope: empty, audience: "planner" }),
    ).toBeUndefined();
  });

  test("gets no block even when things are explicitly out", () => {
    // "No `in` entry and no `in` label" is the condition, and an out-list alone does not
    // satisfy it: a block listing only exclusions says nothing about what *is* authorized,
    // so an agent reading it would still be inferring its boundary from the objective.
    const outOnly: ScopeForPrompt = {
      entries: [entry("out", "host", "blog.acme.test")],
      hostLabels: [hostLabel("legacy.acme.test", "out")],
      assetLabels: [],
    };
    expect(
      renderScopeBlock({ scope: outOnly, audience: "worker" }),
    ).toBeUndefined();
  });

  test("gets a block the moment one in-scope label exists, with no entries at all", () => {
    // Promotion alone is enough. An operator who has typed no entries but promoted one
    // discovered host has put something in scope, and the agent should be told.
    const promoted: ScopeForPrompt = {
      entries: [],
      hostLabels: [hostLabel("api.acme-cdn.test", "in")],
      assetLabels: [],
    };
    const block = renderScopeBlock({ scope: promoted, audience: "worker" });
    expect(block).toBeDefined();
    expect(block).toContain("api.acme-cdn.test");
  });
});

/* ── The two variants ───────────────────────────────────────────────────────────── */

describe("the two audiences", () => {
  test("a worker is told to record what it finds", () => {
    const block = renderScopeBlock({ scope: worked, audience: "worker" }) ?? "";
    expect(block).toContain(
      "Record it with record_asset and move on; do not derive intents for it.",
    );
  });

  test("the planner's variant omits the record_asset line", () => {
    /*
     * D9: `record_asset` is a worker tool, because `asset_discoveries.intent_id` and
     * `.attempt_id` are NOT NULL and a round has neither. Telling a round to record what
     * it finds would name a tool it has no access to, which is a turn spent discovering
     * that.
     */
    const block =
      renderScopeBlock({ scope: worked, audience: "planner" }) ?? "";
    expect(block).not.toContain("record_asset");
    expect(block).toContain("Do not derive intents for it.");
    // And it keeps the sentence that does the real work.
    expect(block).toContain(
      "Discovering a host outside the in-scope list does not grant authorization.",
    );
  });

  test("the two variants differ in exactly that one line", () => {
    // One renderer, so the two prompts cannot drift about what the scope *is*. The only
    // difference is a capability, and this is the assertion that keeps it the only one.
    const worker =
      renderScopeBlock({ scope: worked, audience: "worker" }) ?? "";
    const planner =
      renderScopeBlock({ scope: worked, audience: "planner" }) ?? "";
    const workerLines = worker.split("\n");
    const plannerLines = planner.split("\n");
    expect(workerLines).toHaveLength(plannerLines.length);
    const differing = workerLines.filter(
      (line, index) => line !== plannerLines[index],
    );
    expect(differing).toHaveLength(1);
    expect(differing[0]).toContain("record_asset");
  });
});

/* ── What the lists hold ────────────────────────────────────────────────────────── */

describe("the two lists", () => {
  test("every entry is rendered with what it covers spelled out", () => {
    const { inScope, outOfScope } = scopeListsOf(worked);
    /*
     * The anti-goal this answers. A chip or a list item reading `acme.test` that means
     * "and every subdomain" without saying so is the misread this whole model exists to
     * prevent, and the renderer is the one place it is fixed for every surface at once.
     */
    expect(inScope).toContain("acme.test and every subdomain");
    expect(inScope).toContain("app.partner.test (that host only)");
    expect(inScope).toContain("203.0.113.0/24 (every address in the block)");
    expect(outOfScope).toContain("labs.acme.test and every subdomain");
    expect(outOfScope).toContain("blog.acme.test (that host only)");
    // Nothing is bare.
    for (const item of [...inScope, ...outOfScope]) {
      expect(item.length).toBeGreaterThan(item.split(" ")[0]?.length ?? 0);
    }
  });

  test("a label that overrode an entry appears under the label's effect only", () => {
    /*
     * A4's worked example and its own note: `x.labs.acme.test` appears in the in-list
     * only, though an entry excludes its parent.
     *
     * From the agent's side there is no difference between "excluded because you typed it"
     * and "excluded because you clicked it", so the labels are folded in rather than
     * listed apart. What must not happen is the same host appearing in both lists, which
     * would leave the agent to resolve a contradiction the store already resolved.
     */
    const { inScope, outOfScope } = scopeListsOf(worked);
    const promoted = inScope.filter((item) =>
      item.startsWith("x.labs.acme.test"),
    );
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toContain("set by hand");
    expect(outOfScope.some((item) => item.startsWith("x.labs.acme.test"))).toBe(
      false,
    );

    // The entry it overrode is still listed as what it is: the parent subtree really is
    // excluded, and only the one carved-out host is not.
    expect(outOfScope).toContain("labs.acme.test and every subdomain");
  });

  test("a promoted host is not also listed as out by the entry it beat", () => {
    /*
     * The same-host case, which is the one that was broken.
     *
     * `blog.acme.test` has an `out`/`host` entry and an `in` hand label. The effective
     * state is `in` and always was — the ladder is right — but both sentences were
     * pushed, and they never collided on the dedup because they differ by the words
     * `, set by hand`. The agent was handed an authorization text saying the host is in
     * scope *and* explicitly out of it.
     *
     * The label wins (D5), so the entry is silent and the agent sees one answer.
     */
    const promoted: ScopeForPrompt = {
      entries: [
        entry("in", "subtree", "acme.test"),
        entry("out", "host", "blog.acme.test"),
      ],
      hostLabels: [hostLabel("blog.acme.test", "in")],
      assetLabels: [],
    };
    const { inScope, outOfScope } = scopeListsOf(promoted);
    expect(inScope).toContain("blog.acme.test (that host only, set by hand)");
    expect(outOfScope).toEqual([]);
    // Said as the property rather than as two list assertions: one mention, anywhere.
    const mentions = [...inScope, ...outOfScope].filter((item) =>
      item.startsWith("blog.acme.test"),
    );
    expect(mentions).toHaveLength(1);
  });

  test("a host excluded by hand is not also listed as in by the entry it beat", () => {
    // The symmetric case. Nothing about the suppression is specific to a promotion: an
    // `in`/`host` entry the operator later excluded by hand is just as contradictory
    // read the other way round, and `out` is the direction where believing the wrong
    // sentence costs something.
    const excluded: ScopeForPrompt = {
      entries: [
        entry("in", "subtree", "acme.test"),
        entry("in", "host", "app.partner.test"),
      ],
      hostLabels: [hostLabel("app.partner.test", "out")],
      assetLabels: [],
    };
    const { inScope, outOfScope } = scopeListsOf(excluded);
    expect(outOfScope).toContain(
      "app.partner.test (that host only, set by hand)",
    );
    const mentions = [...inScope, ...outOfScope].filter((item) =>
      item.startsWith("app.partner.test"),
    );
    expect(mentions).toHaveLength(1);
    // The rest of the typed list is untouched: suppression is per host, not per list.
    expect(inScope).toContain("acme.test and every subdomain");
  });

  test("a subtree entry is never suppressed, even by a label on its own apex", () => {
    /*
     * The limit of the rule, and it is the half that must not change.
     *
     * A subtree reaches more than the host its value names, so a label on that host
     * contradicts none of what the entry says about the rest of the subtree. Dropping the
     * entry would stop telling the agent that everything *under* the apex is excluded,
     * which is the silent-coverage anti-goal pointing the other way.
     */
    const apexLabelled: ScopeForPrompt = {
      entries: [
        entry("in", "subtree", "acme.test"),
        entry("out", "subtree", "labs.acme.test"),
      ],
      hostLabels: [hostLabel("labs.acme.test", "in")],
      assetLabels: [],
    };
    const { inScope, outOfScope } = scopeListsOf(apexLabelled);
    expect(outOfScope).toContain("labs.acme.test and every subdomain");
    expect(inScope).toContain("labs.acme.test (that host only, set by hand)");
  });

  test("an asset label is named by its identity, under its own effect", () => {
    const { inScope, outOfScope } = scopeListsOf(worked);
    expect(outOfScope).toContain(
      "GET https://app.acme.test:443/internal/metrics (that one asset, set by hand)",
    );
    expect(inScope.some((item) => item.includes("/internal/metrics"))).toBe(
      false,
    );
  });

  test("a host both typed and promoted is listed once", () => {
    /*
     * An operator can type `in`/`host`/`app.acme.test` and also promote that host from
     * the Estate view. Both are true, both reach exactly that host, and the agent is told
     * once.
     *
     * This used to assert `new Set(mentions).size === mentions.length`, which is
     * tautological when the dedup is already by exact sentence — and it held while the
     * renderer produced two mentions, which is the opposite of what the test's name
     * claims. The property is a count.
     */
    const doubled: ScopeForPrompt = {
      entries: [entry("in", "host", "app.acme.test")],
      hostLabels: [hostLabel("app.acme.test", "in")],
      assetLabels: [],
    };
    const { inScope, outOfScope } = scopeListsOf(doubled);
    const mentions = [...inScope, ...outOfScope].filter((item) =>
      item.startsWith("app.acme.test"),
    );
    expect(mentions).toEqual(["app.acme.test (that host only, set by hand)"]);
  });

  test("the out-of-scope heading is omitted when nothing is out", () => {
    const inOnly: ScopeForPrompt = {
      entries: [entry("in", "subtree", "acme.test")],
      hostLabels: [],
      assetLabels: [],
    };
    const block = renderScopeBlock({ scope: inOnly, audience: "worker" }) ?? "";
    expect(block).toContain("In scope:");
    // A heading with nothing after it reads as a truncation, and a truncated out-list is
    // the one that tells an agent a host is fair game.
    expect(block).not.toContain("Explicitly OUT of scope");
  });
});

/* ── The shape of the block itself ──────────────────────────────────────────────── */

describe("the block", () => {
  test("it opens with the marker and reads as the design's example", () => {
    const block = renderScopeBlock({ scope: worked, audience: "worker" }) ?? "";
    expect(block.startsWith(SCOPE_BLOCK_MARKER)).toBe(true);
    expect(block).toContain("In scope:");
    expect(block).toContain("Explicitly OUT of scope:");
  });

  test("long lists wrap rather than running to one enormous line", () => {
    const many: ScopeForPrompt = {
      entries: Array.from({ length: 12 }, (_unused, index) =>
        entry("in", "subtree", `host-${String(index)}.acme.test`),
      ),
      hostLabels: [],
      assetLabels: [],
    };
    const block = renderScopeBlock({ scope: many, audience: "worker" }) ?? "";
    const lines = block.split("\n");
    // No line is absurd, and a wrapped continuation is indented so it reads as part of
    // the line above rather than as a new heading.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(96);
    expect(lines.some((line) => line.startsWith("  "))).toBe(true);
    // Every entry still appears: wrapping is layout, never truncation.
    for (let index = 0; index < 12; index += 1) {
      expect(block).toContain(`host-${String(index)}.acme.test`);
    }
  });

  test("it is never truncated, however long the lists are", () => {
    /*
     * `GOAL_BRIEFING_MAX_CHARS` bounds the briefing and this block sits outside it.
     * Truncating an in-scope list would be the silent-coverage anti-goal with extra
     * steps; truncating the out-list would tell an agent a host is fair game. If a scope
     * list is ever large enough to matter against the context window that is a real
     * problem, but a silent trim would hide it.
     */
    const enormous: ScopeForPrompt = {
      entries: Array.from({ length: 400 }, (_unused, index) =>
        entry("out", "host", `excluded-${String(index)}.acme.test`),
      ).concat(entry("in", "subtree", "acme.test")),
      hostLabels: [],
      assetLabels: [],
    };
    const block =
      renderScopeBlock({ scope: enormous, audience: "worker" }) ?? "";
    expect(block).toContain("excluded-0.acme.test");
    expect(block).toContain("excluded-399.acme.test");
    expect(block).not.toContain("…");
    expect(block).not.toContain("truncated");
  });

  test("it ends with the authorization sentence, not with the lists", () => {
    // ScopeWeaver's framing, and the sentence that does the actual work: a discovery is
    // not a permission. It goes last because that is where a model's attention lands.
    const block = renderScopeBlock({ scope: worked, audience: "worker" }) ?? "";
    const lines = block.trimEnd().split("\n");
    expect(lines.at(-2)).toContain("does not grant authorization");
    expect(lines.at(-1)).toContain("record_asset");
  });
});
