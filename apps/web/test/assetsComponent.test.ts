/**
 * What the Assets screen's markup actually says.
 *
 * `assets.test.ts` covers the state machine; this covers the claims that are *about
 * rendered output* and cannot be checked any other way. Three of them earn a markup test:
 *
 * - **The three states read as three different sentences.** "Excluded on purpose",
 *   "excluded by hand" and "covered by nothing" are the distinction the whole design
 *   turns on, and a screen that rendered one word for all three would satisfy every
 *   state-machine assertion in the other file.
 * - **Every entry spells out its reach.** An entry shown as bare `acme.test` is the
 *   silent-coverage anti-goal, and whether the sentence reaches the DOM is a fact about
 *   markup.
 * - **The preview panel shows the server's block verbatim.** The panel's whole purpose is
 *   to be the place an operator can trust, so "the bytes we were given are the bytes on
 *   screen" is worth asserting rather than assuming.
 *
 * **It is server output, so no `$effect` runs**, and that is the limit `runes.ts` records.
 * Nothing here exercises a click: the promote and exclude handlers are plain methods on
 * `App` and are tested directly in `assets.test.ts`, which is the division this repo
 * already draws for the chat's scrolling.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import {
  ScopeRefused,
  type ScopeEntryView,
  type ScopeState,
} from "@bit/contracts";

import Assets from "../src/lib/screens/Assets.svelte";
import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import { FakeServer, assetView, emptyScope, ok, refused } from "./fakeServer";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const TARGET = "acme-corp";

const entry = (
  over: Pick<ScopeEntryView, "effect" | "kind" | "value"> &
    Partial<ScopeEntryView>,
): ScopeEntryView => ({
  entryId: `ent_${over.value}`,
  source: "operator",
  note: null,
  createdAt: 1,
  ...over,
});

/** In scope because an entry says so. */
const byEntry = (value: string, effect: "in" | "out"): ScopeState => ({
  state: effect,
  by: {
    _tag: "entry",
    entry: {
      entryId: `ent_${value}`,
      targetId: TARGET,
      effect,
      kind: "subtree",
      value,
      source: "operator",
      note: null,
      createdAt: 1,
    },
  },
  overrode: null,
});

/**
 * Renders the screen for one target's estate and scope.
 *
 * Drives the real `App` through `toSection("assets")` rather than assigning its fields,
 * so what is rendered is a state the application actually reaches.
 */
const bodyOf = async (arrange: (fake: FakeServer) => void): Promise<string> => {
  const fake = new FakeServer();
  arrange(fake);
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget(TARGET);
  await settle();
  app.toSection("assets");
  await settle();
  return render(Assets, { props: { app } }).body;
};

describe("the Estate tab", () => {
  test("the three states are three different sentences", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a_in",
              host: "app.acme.test",
              identity: "app.acme.test:443",
              scope: byEntry("acme.test", "in"),
            }),
            assetView({
              assetId: "a_out",
              host: "blog.acme.test",
              identity: "blog.acme.test:443",
              scope: byEntry("blog.acme.test", "out"),
            }),
            // Covered by nothing: `out`, but by nobody's decision.
            assetView({
              assetId: "a_none",
              host: "api.acme-cdn.test",
              identity: "api.acme-cdn.test:443",
            }),
          ],
        });
    });

    // The three chips.
    expect(html).toContain("In scope");
    expect(html).toContain("Excluded");
    expect(html).toContain("Not covered");

    /*
     * And the three sentences, which are the part that must not collapse. "Excluded on
     * purpose" and "covered by nothing" are both `out`; if the screen printed one phrase
     * for both, an operator could not tell a decision from a thing awaiting one.
     */
    expect(html).toContain("explicitly out of scope: blog.acme.test");
    expect(html).toContain("not covered by any in-scope entry");
    expect(html).toContain("in scope: acme.test and every subdomain");
  });

  test("the group that is covered by nothing offers to promote the host", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a_none",
              host: "api.acme-cdn.test",
              identity: "api.acme-cdn.test:443",
            }),
          ],
        });
    });
    // It is the only group asking the operator for a decision, so it is the one carrying
    // the action on its header.
    expect(html).toContain("Promote host");
    expect(html).not.toContain("Exclude host");
  });

  test("an in-scope group offers to exclude it instead", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a_in",
              host: "app.acme.test",
              scope: byEntry("acme.test", "in"),
            }),
          ],
        });
    });
    // One control, two directions: the same place on the row, the opposite verb.
    expect(html).toContain("Exclude host");
    expect(html).not.toContain("Promote host");
  });

  test("a row whose own label decided it says so, and names the entry it beat", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a_metrics",
              host: "app.acme.test",
              kind: "endpoint",
              identity: "GET https://app.acme.test:443/internal/metrics",
              method: "GET",
              path: "/internal/metrics",
              scheme: "https:",
              scope: {
                state: "out",
                by: {
                  _tag: "assetLabel",
                  label: {
                    assetId: "a_metrics",
                    state: "out",
                    reason: "operations endpoint",
                    setBy: `${TARGET}/operator`,
                    setAt: 2,
                  },
                },
                overrode: {
                  entryId: "ent_acme",
                  targetId: TARGET,
                  effect: "in",
                  kind: "subtree",
                  value: "acme.test",
                  source: "operator",
                  note: null,
                  createdAt: 1,
                },
              },
            }),
            assetView({
              assetId: "a_plain",
              host: "app.acme.test",
              kind: "endpoint",
              identity: "GET https://app.acme.test:443/v1/orders",
              method: "GET",
              path: "/v1/orders",
              scheme: "https:",
              scope: byEntry("acme.test", "in"),
            }),
          ],
        });
    });

    // The hand-labelled row says it was a decision, and which entry that decision beat.
    expect(html).toContain("excluded by hand on this asset alone");
    expect(html).toContain("overriding acme.test and every subdomain");
    // The row beside it, which merely follows its host, says that instead — so the two
    // are never read as the same kind of fact.
    expect(html).toContain("inherits host");
  });

  test("nothing found yet is said plainly, and is not an error", async () => {
    const html = await bodyOf(() => {});
    expect(html).toContain("Nothing found on this target yet");
    expect(html).toContain("record_asset");
  });

  test("a refused promote is shown on the tab the control is on", async () => {
    /*
     * The anti-goal about an operator action that appears to work and does nothing.
     *
     * The promote and exclude controls are on the Estate tab, so a refusal rendered only
     * on the Scope tab would leave the click looking as though it had succeeded. This
     * asserts the sentence reaches the markup *here*, beside the rows it was aimed at.
     */
    const fake = new FakeServer();
    fake.onAssets = () =>
      ok({
        assets: [
          assetView({
            assetId: "a_none",
            host: "api.acme-cdn.test",
            identity: "api.acme-cdn.test:443",
          }),
        ],
      });
    fake.onLabelScope = () =>
      refused(
        new ScopeRefused({
          reason: "not_found",
          detail: "asset 'asset_gone' is not an asset of target acme-corp",
        }),
      );

    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget(TARGET);
    await settle();
    app.toSection("assets");
    await settle();
    await app.labelScope({
      subject: { _tag: "asset", assetId: "asset_gone" },
      state: "in",
    });

    const html = render(Assets, { props: { app } }).body;
    expect(html).toContain("is not an asset of target acme-corp");
    // And the list it was aimed at is still there, because the server changed nothing.
    expect(html).toContain("api.acme-cdn.test");
  });
});

describe("the Scope tab", () => {
  const scopeBody = async (
    arrange: (fake: FakeServer) => void,
  ): Promise<string> => {
    const fake = new FakeServer();
    arrange(fake);
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget(TARGET);
    await settle();
    app.toSection("assets");
    await settle();
    app.toAssetsTab("scope");
    return render(Assets, { props: { app } }).body;
  };

  test("every entry spells out what it reaches, never bare text", async () => {
    const html = await scopeBody((fake) => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              entry({ effect: "in", kind: "subtree", value: "acme.test" }),
              entry({ effect: "in", kind: "host", value: "app.partner.test" }),
              entry({ effect: "in", kind: "cidr", value: "203.0.113.0/24" }),
              entry({ effect: "out", kind: "host", value: "blog.acme.test" }),
            ],
            promptBlock: "[Authorized testing scope — highest priority]",
          }),
        );
    });

    /*
     * The anti-goal this answers: a row reading `acme.test` that means "and every
     * subdomain" without saying so is the misread the whole model exists to prevent.
     */
    expect(html).toContain("and every subdomain");
    expect(html).toContain("that host only");
    expect(html).toContain("every address in the block");
    // Both lists are present and labelled.
    expect(html).toContain("In scope");
    expect(html).toContain("Out of scope");
  });

  test("an imported entry is visibly imported", async () => {
    const html = await scopeBody((fake) => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              entry({
                effect: "in",
                kind: "subtree",
                value: "acme.test",
                source: "imported",
                note: "listed under In scope on the programme page",
              }),
            ],
            promptBlock: "[Authorized testing scope — highest priority]",
          }),
        );
    });
    /*
     * "Read this list before you start" is only a real step if the rows that need reading
     * are the ones a machine wrote. An imported entry and a typed one are identical to
     * the matcher, so the screen is the only place the difference can show.
     */
    expect(html).toContain("Imported");
    expect(html).toContain("listed under In scope on the programme page");
  });

  test("the preview panel shows the server's block verbatim", async () => {
    const block = [
      "[Authorized testing scope — highest priority]",
      "In scope: acme.test and every subdomain;",
      "  x.labs.acme.test (that host only, set by hand)",
      "Explicitly OUT of scope: labs.acme.test and every subdomain",
      "",
      "Discovering a host outside the in-scope list does not grant authorization.",
      "Record it with record_asset and move on; do not derive intents for it.",
    ].join("\n");

    const html = await scopeBody((fake) => {
      fake.onScope = () => ok(emptyScope({ promptBlock: block }));
    });

    /*
     * Verbatim, line for line. This panel is the only place an operator can check what
     * their list actually says before an agent acts on it, so it shows the bytes the
     * server rendered from the same function both prompt paths call — not a
     * reconstruction this component assembled from the lists beside it.
     */
    for (const line of block.split("\n").filter((text) => text !== "")) {
      expect(html).toContain(line.trim());
    }
    // And the note that the planner's copy differs, which is the one thing a single
    // previewed block cannot show by itself.
    expect(html).toContain("A planner round gets the same block");
    expect(html).toContain(
      "An agent already running keeps the scope it was given",
    );
  });

  test("an empty scope says so plainly rather than promising nothing is authorized", async () => {
    const html = await scopeBody(() => {});
    /*
     * A4's empty state. "In scope: (nothing)" is what the agent would otherwise be told,
     * and it reads as "you may touch nothing" — so the screen says what is true instead:
     * the hunt still records everything, and the agent is told nothing about the estate.
     */
    expect(html).toContain("No scope authored for this target");
    expect(html).toContain("not covered");
    expect(html).toContain("Add the first entry");
  });

  test("the add form offers the three reaches by name, not by jargon", async () => {
    const html = await scopeBody(() => {});
    // The operator picks what the entry covers in words. `subtree` is our word, not
    // theirs, and a control labelled with it would be the silent-coverage problem moved
    // into the form.
    expect(html).toContain("Apex and subdomains");
    expect(html).toContain("Host only");
    expect(html).toContain("Address block");
  });
});
