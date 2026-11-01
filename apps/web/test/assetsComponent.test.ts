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

    /*
     * The three chips, read off the chips.
     *
     * This used to be three bare `toContain` calls — which passed on the filter bar's
     * own labels at the top of the screen, rendered unconditionally and never from a
     * row's state. A `chipLabel` returning "In scope" for all three groups satisfied
     * them. So the chip spans are extracted and compared as a set.
     */
    const chips = [
      ...html.matchAll(/<span class="chip [^"]*">([^<]+)<\/span>/g),
    ]
      .map((match) => (match[1] ?? "").trim())
      .sort();
    expect(chips).toEqual(["Excluded", "In scope", "Not covered"]);

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

  test("a row offers the direction it is not already in", async () => {
    /*
     * The per-asset half of "one control, two directions". The group header's half is
     * asserted above; the row-level ternary was matched nowhere, so inverting it — asking
     * an operator to promote what is already in scope — passed the whole suite.
     *
     * Two rows on two hosts, one in scope and one covered by nothing, so the two
     * directions are asserted against each other in one render.
     */
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
              assetId: "a_none",
              host: "api.acme-cdn.test",
              identity: "api.acme-cdn.test:443",
            }),
          ],
        });
    });

    // Each row's own markup, so a button cannot be credited to the wrong row.
    const rows = [...html.matchAll(/<li class="row [^"]*">(.*?)<\/li>/gs)].map(
      (match) => match[1] ?? "",
    );
    expect(rows).toHaveLength(2);
    const rowFor = (identity: string) =>
      rows.find((row) => row.includes(identity)) ?? "";

    const inScope = rowFor("app.acme.test:443");
    expect(inScope).toContain("Exclude this asset");
    expect(inScope).not.toContain("Promote this asset");

    const uncovered = rowFor("api.acme-cdn.test:443");
    expect(uncovered).toContain("Promote this asset");
    expect(uncovered).not.toContain("Exclude this asset");

    // And both say what they reach, which is the narrower of the two label reaches.
    expect(inScope).toContain("that one asset");
    expect(uncovered).toContain("that one asset");
  });

  test("the host control states what it reaches, now and later", async () => {
    // D8 and the view design: every option states its reach. "And later" is the part a
    // button reading *Exclude host* cannot imply, and it is what makes an exclusion mean
    // what the operator meant by it.
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
    const header = /<header class="host [^"]*">(.*?)<\/header>/s.exec(html);
    expect(header?.[1]).toContain("Exclude host");
    expect(header?.[1]).toContain("every asset on that host, now and later");
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
    prepare: (app: App) => void = () => {},
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
    prepare(app);
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

  test("a hand label is listed with what it reaches, and offers to withdraw it", async () => {
    /*
     * The whole "Set by hand" panel, which no test rendered: `hostLabels` and
     * `assetLabels` arrived as `[]` everywhere, so deleting the panel passed — and so did
     * swapping its two sentences, which would tell an operator that a host label reaches
     * one asset. That is precisely the hole D5 keyed labels by host to close.
     */
    const html = await scopeBody((fake) => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              entry({ effect: "in", kind: "subtree", value: "acme.test" }),
            ],
            hostLabels: [
              {
                host: "legacy.acme.test",
                state: "out",
                reason: "retired last quarter",
                setBy: `${TARGET}/operator`,
                setAt: 2,
              },
            ],
            assetLabels: [
              {
                assetId: "a_metrics",
                identity: "GET https://app.acme.test:443/internal/metrics",
                state: "in",
                reason: null,
                setBy: `${TARGET}/operator`,
                setAt: 3,
              },
            ],
            promptBlock: "[Authorized testing scope — highest priority]",
          }),
        );
    });

    expect(html).toContain("Set by hand");
    expect(html).toContain("These beat the lists above");

    // Each value with the sentence beside it, as pairs, so the two reaches cannot be
    // swapped without failing: a host label covers the host's assets now and later, an
    // asset label covers the one row.
    const pairs = [
      ...html.matchAll(
        /<span class="entry-value mono [^"]*">([^<]+)<\/span> <span class="entry-covers [^"]*">([^<]+)<\/span>/g,
      ),
    ].map(
      (match) => [(match[1] ?? "").trim(), (match[2] ?? "").trim()] as const,
    );
    expect(pairs).toContainEqual([
      "legacy.acme.test",
      "excluded — every asset on that host, now and later",
    ]);
    expect(pairs).toContainEqual([
      "GET https://app.acme.test:443/internal/metrics",
      "in scope — that one asset",
    ]);

    // And each is withdrawable from here, named so the control cannot be aimed at the
    // wrong subject.
    expect(html).toContain('aria-label="Clear the label on legacy.acme.test"');
    expect(html).toContain(
      'aria-label="Clear the label on GET https://app.acme.test:443/internal/metrics"',
    );
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

    const html = await scopeBody(
      (fake) => {
        fake.onScope = () => ok(emptyScope({ promptBlock: block }));
      },
      (app) => {
        app.scopeBlockOpen = true;
      },
    );

    /*
     * Verbatim means verbatim: the whole block, as one string.
     *
     * This used to loop the non-empty lines and `toContain` each one trimmed, which
     * discarded the blank line, the indentation that marks a wrapped continuation, the
     * ordering and the adjacency — so a panel that reassembled the lines in another
     * order, or dropped the indent, passed. The panel is a bare `<pre>{block}</pre>` and
     * the fixture holds nothing HTML-escapable, so the stronger assertion was available
     * all along. This is the only place an operator can check what their list says
     * before an agent acts on it.
     */
    expect(html).toContain(block);
    // And the note that the planner's copy differs, which is the one thing a single
    // previewed block cannot show by itself.
    expect(html).toContain("A planner round gets the same block");
    expect(html).toContain(
      "An agent already running keeps the scope it was given",
    );
  });

  test("an empty scope says so plainly rather than promising nothing is authorized", async () => {
    const html = await scopeBody(
      () => {},
      (app) => {
        app.scopeBlockOpen = true;
      },
    );
    /*
     * A4's empty state. "In scope: (nothing)" is what the agent would otherwise be told,
     * and it reads as "you may touch nothing" — so the screen says what is true instead:
     * the hunt still records everything, and the agent is told nothing about the estate.
     */
    expect(html).toContain("No scope authored for this target");
    expect(html).toContain("not covered");
    expect(html).toContain("Add the first entry");
  });

  describe("what the agent is told is a button that opens a panel", () => {
    const block = "[Authorized testing scope — highest priority]";
    const arrange = (fake: FakeServer): void => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              entry({ effect: "in", kind: "subtree", value: "acme.test" }),
            ],
            promptBlock: block,
          }),
        );
    };

    test("closed, the tab offers the button and does not print the block", async () => {
      const html = await scopeBody(arrange);
      expect(html).toContain("What the agent is told");
      expect(html).toMatch(/aria-expanded="false"/);
      // It used to take a column of its own, always. The block is the thing to check
      // before a hunt, not the thing to read on every visit.
      expect(html).not.toContain(block);
      expect(html).not.toContain('<aside class="detail"');
    });

    test("open, the panel holds the block and the button says so", async () => {
      const html = await scopeBody(arrange, (app) => {
        app.scopeBlockOpen = true;
      });
      expect(html).toMatch(/aria-expanded="true"/);
      const panel =
        /<aside class="detail[^"]*" aria-label="([^"]*)">(.*?)<\/aside>/s.exec(
          html,
        );
      expect(panel?.[1]).toBe("What the agent is told");
      expect(panel?.[2]).toContain(block);
    });

    test("it is not offered on the Estate tab, where there is nothing to preview", async () => {
      const html = await bodyOf(() => {});
      expect(html).not.toContain("What the agent is told");
    });
  });

  test("the Add form sits outside the scrolling lists, so it cannot scroll away", async () => {
    const html = await scopeBody((fake) => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              entry({ effect: "in", kind: "subtree", value: "acme.test" }),
              entry({ effect: "out", kind: "host", value: "blog.acme.test" }),
            ],
            promptBlock: "[Authorized testing scope — highest priority]",
          }),
        );
    });
    const lists = html.search(/<div class="lists[ "]/);
    const form = html.search(/<form class="add[ "]/);
    expect(lists).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(lists);
    // Every `<div>` opened since the lists container began has been closed by the time
    // the form starts, so the form is its sibling and not its child. Inside it, the form
    // would scroll with the entries and a long list would push it out of view — the one
    // thing this layout exists to prevent. (CSS is not rendered here; the scrolling
    // itself is checked in a browser.)
    const between = html.slice(lists, form);
    const opened = (between.match(/<div[ >]/g) ?? []).length;
    const closed = (between.match(/<\/div>/g) ?? []).length;
    expect(closed).toBe(opened);
    // Both lists are inside it.
    expect(between).toContain("In scope");
    expect(between).toContain("Out of scope");
  });

  describe("deleting an entry shows the dialog", () => {
    const entries = [
      entry({ effect: "in", kind: "subtree", value: "acme.test" }),
      entry({ effect: "out", kind: "host", value: "blog.acme.test" }),
    ];
    const arrange = (fake: FakeServer): void => {
      fake.onScope = () => ok(emptyScope({ entries }));
    };
    const rawDialogOf = (html: string): string =>
      /<div class="panel[^"]*" role="dialog".*?<\/footer>/s.exec(html)?.[0] ??
      "";
    /** The words of the dialog: tags gone, and source line breaks folded to spaces. */
    const dialogOf = (html: string): string =>
      rawDialogOf(html)
        .replace(/<svg.*?<\/svg>/gs, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");

    test("no question is on screen until one is asked", async () => {
      const html = await scopeBody(arrange);
      expect(html).not.toContain('role="dialog"');
    });

    test("an in-scope entry says what it removes, and what it leaves alone", async () => {
      const html = await scopeBody(arrange, (app) => {
        app.askToRemoveScopeEntry("ent_acme.test");
      });
      const dialog = dialogOf(html);
      expect(rawDialogOf(html)).toContain(
        'aria-label="Delete the entry acme.test?"',
      );
      expect(dialog).toContain("acme.test and every subdomain");
      expect(dialog).toContain("from the in-scope list");
      // The delete path touches no asset and no label, and the sentence says so.
      expect(dialog).toContain("Nothing the hunt found is deleted");
      expect(dialog).toContain("Labels you set by hand are not touched");
      expect(dialog).toContain("not covered");
      expect(dialog).toContain("Delete entry");
      expect(dialog).toContain("Cancel");
      expect(dialog).not.toContain("Keep it out");
    });

    test("an out-of-scope entry warns that deleting ends the exclusion", async () => {
      const html = await scopeBody(arrange, (app) => {
        app.askToRemoveScopeEntry("ent_blog.acme.test");
      });
      const dialog = dialogOf(html);
      expect(dialog).toContain("from the out-of-scope list");
      // Deleting an exclusion can make a host *in* scope, if an in-scope entry also
      // covers it. That is the consequence an operator tidying the list would not guess.
      expect(dialog).toContain("becomes");
      expect(dialog).toContain("in scope");
      expect(dialog).toContain("does not keep a host out of the hunt");
      expect(dialog).toContain("Keep it out");
    });

    test("it promises no count, no undo and no alternative action", async () => {
      /*
       * B5 and B6 draw an asset count, an Undo and a "Move to out of scope instead"
       * button. None has a server behind it: no contract carries a per-entry asset
       * count, and nothing anywhere undoes a deletion. Copy that promised them would be
       * a button that appears to work and does nothing.
       */
      for (const id of ["ent_acme.test", "ent_blog.acme.test"]) {
        const dialog = dialogOf(
          await scopeBody(arrange, (app) => {
            app.askToRemoveScopeEntry(id);
          }),
        );
        expect(dialog).not.toMatch(/\d+ assets?/);
        expect(dialog).not.toContain("Undoable");
        expect(dialog).not.toContain("Move to out of scope");
        expect(dialog).toContain("There is no undo");
      }
    });

    test("the × asks, and nothing on the screen deletes without asking", async () => {
      /*
       * A source check, and an honest weak one: the markup tests render on the server,
       * where no click runs, so "the × opens the dialog instead of deleting" cannot be
       * observed. What can be said is that the screen never reaches the `DELETE` itself.
       * `confirmRemoveScopeEntry` is the only way in, and `assets.test.ts` shows it goes
       * through a question that was asked.
       */
      const screen = await Bun.file(
        new URL("../src/lib/screens/Assets.svelte", import.meta.url),
      ).text();
      expect(screen).toContain("app.askToRemoveScopeEntry(");
      expect(screen).not.toMatch(/app\.removeScopeEntry\(/);
    });

    test("nothing in it is focused, and Delete is not disabled until it is working", async () => {
      const html = await scopeBody(arrange, (app) => {
        app.askToRemoveScopeEntry("ent_acme.test");
      });
      const dialog = rawDialogOf(html);
      // Enter does nothing until the operator tabs to Delete. `autofocus` is the one
      // way the markup itself could make it do something.
      expect(dialog).not.toContain("autofocus");
      expect(dialog).toMatch(
        /<button[^>]*class="action confirm danger[^"]*"[^>]*aria-disabled="false"/,
      );
    });

    test("while it works the button says so and cannot be pressed", async () => {
      const html = await scopeBody(arrange, (app) => {
        app.askToRemoveScopeEntry("ent_acme.test");
        app.scopeBusy = true;
      });
      const dialog = rawDialogOf(html);
      expect(dialog).toContain("Deleting…");
      expect(dialog).not.toContain("Delete entry");
      expect(dialog).toMatch(
        /<button[^>]*class="action confirm danger[^"]*"[^>]*aria-disabled="true"/,
      );
      // Cancel is withdrawn too: the request is already on its way.
      expect(dialog).toMatch(
        /<button[^>]*class="action cancel[^"]*"[^>]*disabled/,
      );
    });

    test("an entry that is gone takes its question with it", async () => {
      const html = await scopeBody(arrange, (app) => {
        app.askToRemoveScopeEntry("ent_already_deleted");
      });
      expect(html).not.toContain('role="dialog"');
    });
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

describe("an imported asset reads as provenance, not as an absence", () => {
  /**
   * The gotcha this whole block exists for.
   *
   * A host the scope importer read off a program page has `discoveries: 0` and
   * `firstAttemptId: null` — both correct, because the importer runs before any attempt
   * exists (D14). A screen with only those two fields can say nothing better than "no
   * recorded discovery" and "0 sightings", which are two phrasings of a gap. There is no
   * gap: the program's own page named the host, and `asset_imports` records which page.
   *
   * So this checks the sentence, because the sentence is the only place the distinction
   * exists. A state-machine test would pass either way.
   */
  test("it says which program page it was read off", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "asset_imported",
              identity: "app.acme.test:443",
              host: "app.acme.test",
              discoveries: 0,
              firstAttemptId: null,
              firstIntentId: null,
              lastDiscoveredAt: null,
              imports: 1,
              firstSourceUrl: "https://hackerone.com/acme/policy",
            }),
          ],
        });
    });

    expect(html).toContain("imported from hackerone.com");
    // The two sentences that read as absence are gone.
    expect(html).not.toContain("no recorded discovery");
    expect(html).not.toContain("0 sightings");
    // Zero discoveries is still said, because it is still true — but as a fact about what
    // has happened to the host rather than as a count of nothing.
    expect(html).toContain("not yet seen");
  });

  test("a worker's later discovery of the same host wins the sentence", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "asset_both",
              discoveries: 2,
              firstAttemptId: "att_01HQZX9",
              imports: 1,
              firstSourceUrl: "https://hackerone.com/acme/policy",
            }),
          ],
        });
    });
    // By then the more informative fact is that somebody has actually been there. Both
    // provenance rows are kept either way; the column has room for one.
    expect(html).toContain("via att_01HQZX9");
    expect(html).toContain("2 sightings");
  });

  test("hand-labelling an imported host does not erase where it came from", async () => {
    // The regression this is written against: `foundBy` checked `assetLabel` first, so one
    // click of Promote or Exclude on an imported row replaced "imported from hackerone.com"
    // with "by hand". A scope label is a decision about whether the asset may be tested; it
    // is not a claim about where the asset came from, and the row says which label decided
    // its state in its own chip and its own "why" column already.
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "asset_imported_labelled",
              identity: "app.acme.test:443",
              host: "app.acme.test",
              discoveries: 0,
              firstAttemptId: null,
              firstIntentId: null,
              lastDiscoveredAt: null,
              imports: 1,
              firstSourceUrl: "https://hackerone.com/acme/policy",
              scope: {
                state: "in",
                by: {
                  _tag: "assetLabel",
                  label: {
                    assetId: "asset_imported_labelled",
                    state: "in",
                    reason: null,
                    setBy: "acme-corp/operator",
                    setAt: 2,
                  },
                },
                overrode: null,
              },
            }),
          ],
        });
    });

    // The provenance column says where the host came from…
    expect(html).toContain(">imported from hackerone.com<");
    // …and the label is still visible as what decided the scope state, which is a
    // different claim and has its own column.
    expect(html).toContain("in scope, set by hand on this asset alone");
  });

  test("an asset neither path accounts for says so plainly", async () => {
    const html = await bodyOf((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              discoveries: 0,
              firstAttemptId: null,
              firstIntentId: null,
              lastDiscoveredAt: null,
              imports: 0,
              firstSourceUrl: null,
            }),
          ],
        });
    });
    // Should not happen — both writes put their provenance row in the same transaction as
    // the asset — so it is said rather than dressed up as something ordinary.
    expect(html).toContain("no recorded provenance");
    expect(html).toContain("no sightings");
  });
});
