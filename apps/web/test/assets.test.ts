/**
 * What the Assets screen's state machine does, against a control plane that is not there.
 *
 * Tests of the *state*, not of the markup: nothing here renders a component or looks at
 * an element, and every assertion is about a field the screen reads. That is the division
 * `app.test.ts` records and the reason it holds — the screens reading these fields
 * correctly is a separate tier with a separate harness, and this harness has no DOM.
 *
 * Its own file rather than more of `app.test.ts`, which is already 3,000 lines: the estate
 * and its scope are one feature with one set of fixtures, and a reader looking for "what
 * happens when a promote is refused" should not have to scroll past the live transcript.
 *
 * **Every test owns its own `App` and its own double.** A shared one would make the
 * stale-answer tests depend on the order they run in, which is the kind of result that is
 * worse than no test at all.
 */
import { describe, expect, test } from "bun:test";

import {
  ScopeRefused,
  TargetUnavailable,
  type ScopeEntry,
} from "@bit/contracts";

import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import { FakeServer, assetView, emptyScope, ok, refused } from "./fakeServer";

/** Lets everything already in flight finish. `openTarget` is fire-and-forget. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const open = (): { app: App; fake: FakeServer } => {
  const fake = new FakeServer();
  return { app: new App(fake, new FakeCountdown()), fake };
};

const signIn = async (app: App): Promise<void> => {
  app.password = "correct-horse";
  await app.connect();
};

/**
 * Signed in, on a target, with the Assets section open.
 *
 * `toSection("assets")` is what asks for the estate and the scope. `openTarget` does not,
 * and that is deliberate: the operator lands on Goals, so reading the estate of every
 * target they open would spend a request per open on a screen they may never visit.
 */
const onAssets = async (
  arrange: (fake: FakeServer) => void = () => {},
): Promise<[App, FakeServer]> => {
  const { app, fake } = open();
  arrange(fake);
  await signIn(app);
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  return [app, fake];
};

/**
 * The arguments one method was called with, the nth time.
 *
 * {@link FakeServer} records every call as `{ method, args }`; this is just the lookup,
 * written once rather than in every assertion below.
 */
const argsOf = (
  fake: FakeServer,
  method: Parameters<FakeServer["countOf"]>[0],
  nth = 0,
): readonly unknown[] | undefined =>
  fake.calls.filter((call) => call.method === method)[nth]?.args;

/** One entry, for the scope states a fixture has to build by hand. */
const entry = (
  over: Partial<ScopeEntry> & Pick<ScopeEntry, "effect" | "kind" | "value">,
): ScopeEntry => ({
  entryId: "e1",
  targetId: "acme-corp",
  source: "operator",
  note: null,
  createdAt: 1,
  ...over,
});

/* ── Reading the estate ──────────────────────────────────────────────────────── */

describe("the estate", () => {
  test("it is read when the operator goes to look at it, not on every target open", async () => {
    const { app, fake } = open();
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    expect(fake.countOf("assets")).toBe(0);
    expect(fake.countOf("scope")).toBe(0);

    app.toSection("assets");
    await settle();
    expect(fake.countOf("assets")).toBe(1);
    expect(fake.countOf("scope")).toBe(1);
    expect(app.assetsState).toBe("ready");
  });

  test("it is re-read on every visit, because a worker records while you are elsewhere", async () => {
    const [app, fake] = await onAssets();
    app.toSection("goals");
    app.toSection("assets");
    await settle();
    // A cached list would show a stale estate and let the operator promote a host off a
    // row that had already changed.
    expect(fake.countOf("assets")).toBe(2);
    expect(app.assetsState).toBe("ready");
  });

  test("nothing found yet is a fact, kept apart from not read yet", async () => {
    const [app] = await onAssets();
    expect(app.assetsState).toBe("ready");
    expect(app.estateRows).toEqual([]);
    // An empty-state sentence shown while the request was in flight would tell the
    // operator, falsely and for a moment, that the hunt has found nothing.
    expect(app.assetsDetail).toBe("");
  });

  test("a failed read says the server's words and keeps the list empty", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAssets = () =>
        refused(
          new TargetUnavailable({
            reason: "database_missing",
            targetId: "acme-corp",
            detail: "hunt.sqlite is not where the registry says it is",
          }),
        );
    });
    expect(app.assetsState).toBe("failed");
    expect(app.assetsDetail).toContain("hunt.sqlite");
    expect(app.estateRows).toEqual([]);
  });

  test("an answer about a target the operator has left is dropped", async () => {
    /*
     * The guard that matters most on this screen. Showing one client's estate under
     * another client's name is misattribution at the UI layer, which is the one thing
     * this product may not do — so the owner id is checked before the request and again
     * after it.
     */
    const { app, fake } = open();
    fake.onAssets = () =>
      ok({ assets: [assetView({ host: "stale.acme.test" })] });
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();

    const pending = app.loadAssets("acme-corp");
    app.viewTargetId = "other-target";
    await pending;

    expect(app.assets).toEqual([]);
    // And the derived view refuses it a second time: the owner id no longer agrees.
    expect(app.estateRows).toEqual([]);
  });

  test("rows group by host, because that is the unit a label reaches", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a1",
              host: "app.acme.test",
              identity: "app.acme.test:443",
            }),
            assetView({
              assetId: "a2",
              host: "app.acme.test",
              kind: "endpoint",
              identity: "GET https://app.acme.test:443/v1/orders",
              method: "GET",
              path: "/v1/orders",
              scheme: "https:",
            }),
            assetView({
              assetId: "a3",
              host: "api.acme-cdn.test",
              identity: "api.acme-cdn.test:443",
            }),
          ],
        });
    });

    expect(app.estateGroups.map((group) => group.host)).toEqual([
      "app.acme.test",
      "api.acme-cdn.test",
    ]);
    expect(app.estateGroups[0]?.rows).toHaveLength(2);
  });

  test("a group's header takes the host's verdict, not one row's hand label", async () => {
    // An endpoint excluded by hand inside an in-scope host must not relabel its whole
    // group: the group header is about the host, and the row carries its own decision.
    const [app] = await onAssets((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a1",
              host: "app.acme.test",
              scope: {
                state: "out",
                by: {
                  _tag: "assetLabel",
                  label: {
                    assetId: "a1",
                    state: "out",
                    reason: null,
                    setBy: "acme-corp/operator",
                    setAt: 2,
                  },
                },
                overrode: null,
              },
            }),
            assetView({
              assetId: "a2",
              host: "app.acme.test",
              scope: {
                state: "in",
                by: {
                  _tag: "entry",
                  entry: entry({
                    effect: "in",
                    kind: "subtree",
                    value: "acme.test",
                  }),
                },
                overrode: null,
              },
            }),
          ],
        });
    });

    const group = app.estateGroups[0];
    expect(group?.host).toBe("app.acme.test");
    expect(group?.scope.by._tag).toBe("entry");
    expect(group?.scope.state).toBe("in");
  });

  test("the four filters count the three states apart", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "in1",
              host: "app.acme.test",
              scope: {
                state: "in",
                by: {
                  _tag: "entry",
                  entry: entry({
                    effect: "in",
                    kind: "subtree",
                    value: "acme.test",
                  }),
                },
                overrode: null,
              },
            }),
            assetView({
              assetId: "out1",
              host: "blog.acme.test",
              scope: {
                state: "out",
                by: {
                  _tag: "entry",
                  entry: entry({
                    entryId: "e2",
                    effect: "out",
                    kind: "host",
                    value: "blog.acme.test",
                  }),
                },
                overrode: null,
              },
            }),
            // Covered by nothing: `out`, but by nobody's decision.
            assetView({ assetId: "un1", host: "api.acme-cdn.test" }),
          ],
        });
    });

    expect(app.estateTally).toEqual({ all: 3, in: 1, out: 1, uncovered: 1 });

    /*
     * "Excluded" and "not covered" are both `out` and must not be one filter.
     * Collapsing them is the collapse the three-sentence rule forbids: one was decided,
     * and the other is the group waiting for a decision.
     */
    const shown = () =>
      app.shownEstateGroups.flatMap((group) =>
        group.rows.map((row) => row.assetId),
      );

    app.estateFilter = "out";
    expect(shown()).toEqual(["out1"]);
    app.estateFilter = "uncovered";
    expect(shown()).toEqual(["un1"]);
    app.estateFilter = "in";
    expect(shown()).toEqual(["in1"]);
    app.estateFilter = "all";
    expect(shown()).toEqual(["in1", "out1", "un1"]);
  });

  test("filtering changes the view and never what was read", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({ assetId: "a1", host: "app.acme.test" }),
            assetView({
              assetId: "a2",
              host: "blog.acme.test",
              identity: "blog.acme.test:443",
            }),
          ],
        });
    });
    app.estateQuery = "blog";
    expect(app.shownEstateGroups.map((group) => group.host)).toEqual([
      "blog.acme.test",
    ]);
    // The estate itself is untouched: a filter is a view, not a gate.
    expect(app.estateRows).toHaveLength(2);
    expect(app.estateTally.all).toBe(2);
  });

  test("the query matches a path as well as a host", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAssets = () =>
        ok({
          assets: [
            assetView({
              assetId: "a1",
              host: "app.acme.test",
              kind: "endpoint",
              identity: "GET https://app.acme.test:443/internal/metrics",
              method: "GET",
              path: "/internal/metrics",
              scheme: "https:",
            }),
            assetView({ assetId: "a2", host: "app.acme.test" }),
          ],
        });
    });
    app.estateQuery = "metrics";
    expect(
      app.shownEstateGroups.flatMap((group) =>
        group.rows.map((row) => row.assetId),
      ),
    ).toEqual(["a1"]);
  });
});

/* ── The scope ───────────────────────────────────────────────────────────────── */

describe("the scope", () => {
  test("nothing authored is reported as such, not as a failure", async () => {
    const [app] = await onAssets();
    expect(app.scopeState).toBe("ready");
    expect(app.viewScope?.entries).toEqual([]);
    // Null, which the screen says plainly rather than showing "In scope: (nothing)" —
    // the thing the agent would otherwise be told, which reads as "touch nothing".
    expect(app.viewScope?.promptBlock).toBeNull();
  });

  test("the preview is the server's own block, not one the browser rebuilt", async () => {
    const block =
      "[Authorized testing scope — highest priority]\nIn scope: acme.test and every subdomain";
    const [app] = await onAssets((fake) => {
      fake.onScope = () => ok(emptyScope({ promptBlock: block }));
    });
    // Verbatim. A preview assembled by a second renderer is the drift the one-renderer
    // rule exists to stop, and this panel's whole purpose is to be trustworthy.
    expect(app.viewScope?.promptBlock).toBe(block);
  });

  test("adding an entry sends the value as typed and clears the box on success", async () => {
    const [app, fake] = await onAssets();
    app.entryEffect = "in";
    app.entryKind = "subtree";
    // Untrimmed and mixed case on purpose: normalising in the browser would be a second
    // implementation of a rule that has one, and the server's refusals are worth more
    // than the round trip saves.
    app.entryValue = "  ACME.Test  ";
    await app.addScopeEntry();

    expect(argsOf(fake, "addScopeEntry")?.[2]).toEqual({
      effect: "in",
      kind: "subtree",
      value: "ACME.Test",
    });
    expect(app.entryValue).toBe("");
    expect(app.scopeRefusal).toBe("");
  });

  test("a refused entry keeps the text, says why, and leaves the list alone", async () => {
    const [app] = await onAssets((fake) => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              {
                entryId: "e1",
                effect: "in",
                kind: "subtree",
                value: "acme.test",
                source: "operator",
                note: null,
                createdAt: 1,
              },
            ],
            promptBlock: "[Authorized testing scope — highest priority]",
          }),
        );
      fake.onAddScopeEntry = () =>
        refused(
          new ScopeRefused({
            reason: "invalid",
            detail:
              "'localhost' is a single label with no dot; an entry names a host or an apex like acme.com",
          }),
        );
    });

    app.entryValue = "localhost";
    await app.addScopeEntry();

    // The normaliser's own sentence, which names the remedy rather than the rule.
    expect(app.scopeRefusal).toContain("single label with no dot");
    expect(app.scopeRefusalContradiction).toBe(false);
    // Kept, so the operator fixes it rather than retyping it out of the error message.
    expect(app.entryValue).toBe("localhost");
    // A refusal is not a failed read: the server refused and therefore changed nothing,
    // so the correct list stays on screen untouched.
    expect(app.scopeState).toBe("ready");
    expect(app.viewScope?.entries).toHaveLength(1);
  });

  test("a contradiction is flagged as the one danger case in the flow", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAddScopeEntry = () =>
        refused(
          new ScopeRefused({
            reason: "contradiction",
            detail:
              "'blog.acme.test' is already an out-of-scope host entry (scope_1); an entry cannot be in and out at once.",
          }),
        );
    });
    app.entryValue = "blog.acme.test";
    await app.addScopeEntry();

    expect(app.scopeRefusalContradiction).toBe(true);
    // It names the row the operator has to deal with.
    expect(app.scopeRefusal).toContain("scope_1");
  });

  test("an empty value is not submitted at all", async () => {
    const [app, fake] = await onAssets();
    app.entryValue = "   ";
    await app.addScopeEntry();
    expect(fake.countOf("addScopeEntry")).toBe(0);
  });

  test("removing an entry sends its id and takes the answer as the new scope", async () => {
    const [app, fake] = await onAssets((fake) => {
      fake.onRemoveScopeEntry = () => ok(emptyScope({ promptBlock: null }));
    });
    await app.removeScopeEntry("scope_7");
    expect(argsOf(fake, "removeScopeEntry")?.[2]).toBe("scope_7");
    expect(app.viewScope?.entries).toEqual([]);
  });

  describe("deleting an entry asks first", () => {
    const withEntry = (fake: FakeServer): void => {
      fake.onScope = () =>
        ok(
          emptyScope({
            entries: [
              {
                entryId: "scope_7",
                effect: "in",
                kind: "subtree",
                value: "acme.test",
                source: "operator",
                note: null,
                createdAt: 1,
              },
            ],
          }),
        );
      fake.onRemoveScopeEntry = () => ok(emptyScope());
    };

    test("asking sends nothing, and cancelling leaves the entry alone", async () => {
      const [app, fake] = await onAssets(withEntry);
      app.askToRemoveScopeEntry("scope_7");
      expect(app.scopeEntryToRemove).toBe("scope_7");
      // The click that opens the question is not the click that deletes. This is the
      // whole change: before it, the `×` called `removeScopeEntry` directly.
      expect(fake.countOf("removeScopeEntry")).toBe(0);

      app.cancelRemoveScopeEntry();
      expect(app.scopeEntryToRemove).toBe("");
      expect(fake.countOf("removeScopeEntry")).toBe(0);
      expect(app.viewScope?.entries).toHaveLength(1);
    });

    test("confirming deletes the entry that was asked about, and closes the question", async () => {
      const [app, fake] = await onAssets(withEntry);
      app.askToRemoveScopeEntry("scope_7");
      await app.confirmRemoveScopeEntry();

      expect(argsOf(fake, "removeScopeEntry")?.[2]).toBe("scope_7");
      expect(app.scopeEntryToRemove).toBe("");
      expect(app.viewScope?.entries).toEqual([]);
    });

    test("confirming with nothing asked about deletes nothing", async () => {
      const [app, fake] = await onAssets(withEntry);
      await app.confirmRemoveScopeEntry();
      expect(fake.countOf("removeScopeEntry")).toBe(0);
    });

    test("a second confirm while the first is in flight sends nothing", async () => {
      const [app, fake] = await onAssets(withEntry);
      const release = fake.hold("removeScopeEntry");
      app.askToRemoveScopeEntry("scope_7");
      const first = app.confirmRemoveScopeEntry();
      await settle();
      expect(app.scopeBusy).toBe(true);

      // The dialog's working state, seen from the state machine: a double-click is one
      // delete, not a delete and a refusal that "no such entry" would have been.
      await app.confirmRemoveScopeEntry();
      // And the question cannot be dropped from under a request already on its way.
      app.cancelRemoveScopeEntry();
      expect(app.scopeEntryToRemove).toBe("scope_7");

      release();
      await first;
      expect(fake.countOf("removeScopeEntry")).toBe(1);
      expect(app.scopeEntryToRemove).toBe("");
      expect(app.scopeBusy).toBe(false);
    });

    test("a refusal closes the question and is shown beside the Add form", async () => {
      const [app] = await onAssets((fake) => {
        withEntry(fake);
        fake.onRemoveScopeEntry = () =>
          refused(
            new ScopeRefused({
              reason: "not_found",
              detail: "no scope entry 'scope_7' on target acme-corp",
            }),
          );
      });
      app.askToRemoveScopeEntry("scope_7");
      await app.confirmRemoveScopeEntry();

      expect(app.scopeEntryToRemove).toBe("");
      expect(app.scopeRefusal).toContain("no scope entry 'scope_7'");
    });

    test("a deleted entry moves the verdict on its assets, so the estate is re-read", async () => {
      const [app, fake] = await onAssets(withEntry);
      const before = fake.countOf("assets");
      app.askToRemoveScopeEntry("scope_7");
      await app.confirmRemoveScopeEntry();
      // Verdicts are derived by the server at read time. Without this the Estate tab
      // would go on calling a host "in scope" after the entry that said so was deleted.
      expect(fake.countOf("assets")).toBe(before + 1);
    });

    test("leaving the target drops a question that was never answered, and the open panel", async () => {
      const [app] = await onAssets(withEntry);
      app.askToRemoveScopeEntry("scope_7");
      app.scopeBlockOpen = true;
      app.openTarget("other-corp");
      await settle();
      expect(app.scopeEntryToRemove).toBe("");
      // One client's scope panel must not be open on another's first visit.
      expect(app.scopeBlockOpen).toBe(false);
    });
  });

  test("promoting a host re-reads the estate, because one click can move other rows", async () => {
    const [app, fake] = await onAssets((fake) => {
      // The server's own answer, distinguishable from the draft sent below.
      fake.onLabelScope = () =>
        ok(
          emptyScope({
            hostLabels: [
              {
                host: "api.acme-cdn.test",
                state: "in",
                reason: null,
                setBy: "acme-corp/operator",
                setAt: 2,
              },
            ],
          }),
        );
    });
    const before = fake.countOf("assets");

    await app.labelScope({
      subject: { _tag: "host", host: "api.acme-cdn.test" },
      state: "in",
    });

    expect(argsOf(fake, "labelScope")?.[2]).toEqual({
      subject: { _tag: "host", host: "api.acme-cdn.test" },
      state: "in",
    });
    /*
     * A host label covers every asset on that host, present and future, so one click can
     * change the state of rows the operator did not click. Guessing which from the
     * browser would be a second implementation of the ladder.
     */
    expect(fake.countOf("assets")).toBe(before + 1);
    /*
     * And the scope on screen is the server's answer, not the draft this test sent.
     *
     * The assertion above only proves the draft travelled unmangled — it is the same
     * object going out and coming back through a pass-through fake. What matters to the
     * operator is that the label the *server* reports is the one the Scope tab then
     * shows, which is the half a pass-through assertion cannot see.
     */
    expect(app.viewScope?.hostLabels).toEqual([
      {
        host: "api.acme-cdn.test",
        state: "in",
        reason: null,
        setBy: "acme-corp/operator",
        setAt: 2,
      },
    ]);
  });

  test("excluding one asset is the same control in the other direction", async () => {
    const [app, fake] = await onAssets();
    await app.labelScope({
      subject: { _tag: "asset", assetId: "asset_1" },
      state: "out",
      reason: "the client asked us to leave this endpoint alone",
    });
    expect(argsOf(fake, "labelScope")?.[2]).toEqual({
      subject: { _tag: "asset", assetId: "asset_1" },
      state: "out",
      reason: "the client asked us to leave this endpoint alone",
    });
  });

  test("withdrawing a label is the same control again", async () => {
    const [app, fake] = await onAssets();
    await app.labelScope({
      subject: { _tag: "host", host: "app.acme.test" },
      state: "cleared",
    });
    // One route, one method, six combinations. An earlier design had promotion writing an
    // entry and exclusion writing a label, which made two buttons different mechanisms
    // wearing one shape.
    //
    // The subject is asserted too: `toMatchObject({ state: "cleared" })` said nothing
    // about *what* was being withdrawn, which is the one field a mis-wired control would
    // get wrong.
    expect(argsOf(fake, "labelScope")?.[2]).toEqual({
      subject: { _tag: "host", host: "app.acme.test" },
      state: "cleared",
    });
  });

  test("a refused label does not re-read the estate", async () => {
    const [app, fake] = await onAssets((fake) => {
      fake.onLabelScope = () =>
        refused(
          new ScopeRefused({
            reason: "not_found",
            detail: "asset 'asset_gone' is not an asset of target acme-corp",
          }),
        );
    });
    const before = fake.countOf("assets");

    await app.labelScope({
      subject: { _tag: "asset", assetId: "asset_gone" },
      state: "in",
    });

    expect(app.scopeRefusal).toContain("not an asset of");
    // Nothing changed, so there is nothing to re-read — and a list that reloaded here
    // would suggest to the operator that something had.
    expect(fake.countOf("assets")).toBe(before);
  });

  test("switching tab clears a refusal that belonged to the control left behind", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAddScopeEntry = () =>
        refused(new ScopeRefused({ reason: "invalid", detail: "not a host" }));
    });
    app.entryValue = "localhost";
    await app.addScopeEntry();
    expect(app.scopeRefusal).not.toBe("");

    app.toAssetsTab("estate");
    expect(app.scopeRefusal).toBe("");
    expect(app.scopeRefusalContradiction).toBe(false);
    expect(app.assetsTab).toBe("estate");
  });

  test("leaving the target leaves its estate and its scope behind", async () => {
    const [app] = await onAssets((fake) => {
      fake.onAssets = () => ok({ assets: [assetView()] });
      fake.onScope = () => ok(emptyScope({ promptBlock: "something" }));
    });
    expect(app.estateRows).toHaveLength(1);
    app.toAssetsTab("scope");
    app.estateFilter = "uncovered";

    app.openTarget("other-target");
    await settle();

    // Another client's screen must not carry this one's estate, and the tab resets so an
    // operator does not land on the Scope tab of an engagement they just left.
    expect(app.estateRows).toEqual([]);
    expect(app.viewScope).toBeUndefined();
    /*
     * Read through widened locals.
     *
     * The assignments above narrow these properties to the literals they were given, and
     * TypeScript does not know `openTarget` puts them back — so asserting on them
     * directly would compare a value the compiler believes is `"scope"` against
     * `"estate"` and fail to typecheck rather than fail to pass. The annotation says
     * "whatever is in there now", which is the question the test is actually asking.
     */
    const tab: string = app.assetsTab;
    const filter: string = app.estateFilter;
    expect(tab).toBe("estate");
    expect(filter).toBe("all");
  });
});
