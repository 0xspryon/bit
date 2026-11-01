/**
 * The Auto-load page and the "Loading the scope" panel.
 *
 * The importer used to start from the create-target page, as a side effect of creating a
 * target. A6 moved it to the Assets page: the page below is the form and the panel it
 * always was, pointed at a target that already exists, and `createTarget` takes no links.
 *
 * Two kinds of claim, and they are checked in two ways for the reason
 * `assetsComponent.test.ts` records: the state machine is checked against `App` directly,
 * and the claims that are *about rendered output* are checked against markup because there
 * is no other way to check them.
 *
 * The markup claims that earn a test here:
 *
 * - **The panel renders tool calls and does not render narration** (D16). This one is the
 *   slice's, and the way it is asserted matters: `ScopeImportView` has no field for
 *   narration, so the only way a reasoning line could reach this screen is if somebody
 *   added a capture path and a field. The test therefore checks that what *is* rendered is
 *   the tool and the value it wrote, and that text which exists nowhere in the view —
 *   because the contract cannot carry it — is nowhere in the output.
 * - **The model picker shows the model the server resolved** (D15), rather than one this
 *   bundle holds.
 *
 * Server output, so no `$effect` runs — the limit `runes.ts` records. Nothing here clicks:
 * the handlers are plain methods on `App` and are driven directly below.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import {
  ImporterModelUnavailable,
  TargetUnavailable,
  type ScopeImportCall,
} from "@bit/contracts";

import AutoLoad from "../src/lib/screens/AutoLoad.svelte";
import { App, IMPORT_POLL_MS } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import {
  FakeServer,
  harnessInstance,
  importerModelView,
  ok,
  refused,
  scopeImportView,
  targetCreated,
  targetSummary,
} from "./fakeServer";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const PAGE_A = "https://hackerone.com/acme/policy";
const PAGE_B = "https://bugcrowd.com/acme-corp";

let sequence = 0;
const call = (
  tool: ScopeImportCall["tool"],
  wrote: string,
  sourceUrl: string | null,
): ScopeImportCall => ({
  sequence: (sequence += 1),
  tool,
  wrote,
  sourceUrl,
  at: 1_700_000_000_000 + sequence,
});

/** A signed-in app sitting on the Auto-load page of an open target. */
const onPage = async (
  arrange: (fake: FakeServer) => void = () => {},
): Promise<{ app: App; fake: FakeServer; countdown: FakeCountdown }> => {
  const fake = new FakeServer();
  arrange(fake);
  const countdown = new FakeCountdown();
  const app = new App(fake, countdown);
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  app.openImporter();
  await settle();
  return { app, fake, countdown };
};

/** The import poll's timers still outstanding: one while a panel watches, none otherwise. */
const pollTimers = (countdown: FakeCountdown) =>
  countdown.live.filter((armed) => armed.ms === IMPORT_POLL_MS);

/**
 * The rendered body, with runs of whitespace collapsed.
 *
 * Svelte keeps the newlines and indentation of the source template inside a text node, so
 * a sentence written across two lines in the component arrives as `"1\n      asset"`.
 * Collapsing is what lets an assertion be about the sentence the operator reads rather
 * than about where the component's source happened to wrap.
 */
const bodyOf = (app: App): string =>
  render(AutoLoad, { props: { app } }).body.replace(/\s+/g, " ");

/**
 * Whether the operator can press Start import, read off the rendered button.
 *
 * `canImport` and the link count are the component's rules, so the claim cannot be made
 * from `App`. SSR emits `disabled` only when it is true.
 */
const startEnabled = (html: string): boolean => {
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
  const start = buttons.find((button) => button.includes("Start import"));
  if (start === undefined) throw new Error("the page rendered no Start import");
  return !/\sdisabled(?:=|[\s>])/.test(start.slice(0, start.indexOf(">") + 1));
};

describe("the panel lists tool calls and no narration", () => {
  test("every line names the tool and the value it wrote", async () => {
    const { app } = await onPage();
    app.importerPhase = "importing";
    app.scopeImportTargetId = "acme-corp";
    app.scopeImport = scopeImportView({
      links: [
        {
          url: PAGE_A,
          state: "read",
          entriesIn: 1,
          entriesOut: 1,
          assets: 1,
        },
        {
          url: PAGE_B,
          state: "reading",
          entriesIn: 0,
          entriesOut: 0,
          assets: 0,
        },
      ],
      calls: [
        call(
          "add_scope_entry",
          "in · subtree · acme.com and every subdomain",
          PAGE_A,
        ),
        call(
          "add_scope_entry",
          "out · host · blog.acme.com, that host only",
          PAGE_A,
        ),
        call("record_imported_asset", "www.acme.com:443", PAGE_A),
        call("read_scope", "read 2 entries", null),
      ],
      totals: { entriesIn: 1, entriesOut: 1, assets: 1 },
    });

    const body = bodyOf(app);

    // The tool, and the value it wrote. A tool call is a fact about what landed, which is
    // what makes this panel a receipt rather than a progress indicator.
    expect(body).toContain("add_scope_entry");
    expect(body).toContain("record_imported_asset");
    expect(body).toContain("read_scope");
    expect(body).toContain("and every subdomain");
    expect(body).toContain("www.acme.com:443");

    // Per-link state, derived from the `source_url` on those calls and from nothing else.
    expect(body).toContain(PAGE_A);
    expect(body).toContain("read · 1 in, 1 out");
    expect(body).toContain("reading…");

    // Running totals.
    expect(body).toContain("1 in-scope · 1 out-of-scope · 1 asset recorded");

    // **There is no `fetch_page` line**, because there is no such tool (D13). The harness
    // reads the page with its own reader, so a page fetch is not one of our tool calls and
    // cannot appear on a receipt of what we wrote. A3's own mockup showed `fetch_page`
    // rows here; the design overrode it, and this is the line that keeps it overridden.
    expect(body).not.toContain("fetch_page");
  });

  test("the call list is calls, and the one line of prose is the closing report", async () => {
    const { app } = await onPage();
    app.importerPhase = "importing";
    app.scopeImportTargetId = "acme-corp";
    // What the server can actually produce: a list of writes, and `detail` holding the
    // session's closing report. The report is one status line and is read — that is the
    // line D16 draws — while narration has no field to arrive in, because nothing in the
    // server subscribes to the importer session's events at all (asserted against a
    // harness that really narrates in `import/scopeImporter.test.ts`).
    app.scopeImport = scopeImportView({
      status: "finished",
      detail: "Read page 1. Page 2 returned a page with no scope table.",
      calls: [call("add_scope_entry", "in · subtree · acme.com", PAGE_A)],
      totals: { entriesIn: 1, entriesOut: 0, assets: 0 },
    });

    const body = bodyOf(app);

    expect(body).toContain("add_scope_entry");
    // The report is on screen, as the panel's status line. An import that wrote nothing
    // has to be able to say why, and this is where it says it.
    expect(body).toContain("Page 2 returned a page with no scope table");
    // And the call list carries no prose of its own: one row per call, the tool and the
    // value it wrote, with nothing between them.
    for (const narration of [
      "Let me",
      "I'll start by",
      "Looking at the page",
      "thinking",
      "reasoning",
    ]) {
      expect(body).not.toContain(narration);
    }
  });

  test("the three exits are on it while it runs, and Stop goes when it does not", async () => {
    const { app } = await onPage();
    app.importerPhase = "importing";
    app.scopeImportTargetId = "acme-corp";
    app.scopeImport = scopeImportView({ status: "running" });
    const running = bodyOf(app);
    expect(running).toContain("Open assets");
    expect(running).toContain("Continue in background");
    expect(running).toContain("Stop");

    // Stopped early is not a failure: the entries written so far stay, and the panel says
    // so rather than reporting an error.
    app.scopeImport = scopeImportView({
      status: "stopped",
      detail:
        "stopped by the operator. Everything written up to this point is kept.",
    });
    const stopped = bodyOf(app);
    expect(stopped).toContain("Open assets");
    expect(stopped).toContain("Everything written up to that point is kept");
    // Nothing left to stop.
    expect(stopped).not.toContain("Continue in background");
  });

  test("links dropped for the ceiling are said out loud, not just logged", async () => {
    const { app } = await onPage();
    app.importerPhase = "importing";
    app.scopeImportTargetId = "acme-corp";
    // The server reads the first `SCOPE_IMPORT_MAX_LINKS` and drops the rest — which is
    // right, because an operator who pasted eleven pages wants the first eight read. What
    // was wrong was doing it silently: the rows below showed eight links where they typed
    // eleven, and the only account of the other three was a line in the server's log.
    app.scopeImport = scopeImportView({
      status: "running",
      links: [
        { url: PAGE_A, state: "read", entriesIn: 1, entriesOut: 0, assets: 1 },
      ],
      droppedLinks: 3,
    });

    const body = bodyOf(app);
    expect(body).toContain("3 links were not read");
    expect(body).toContain("Scope page");
  });

  test("a link that yielded nothing says so once the import has settled", async () => {
    const { app } = await onPage();
    app.importerPhase = "importing";
    app.scopeImportTargetId = "acme-corp";
    app.scopeImport = scopeImportView({
      status: "finished",
      links: [
        {
          url: PAGE_A,
          state: "waiting",
          entriesIn: 0,
          entriesOut: 0,
          assets: 0,
        },
      ],
    });
    // `waiting` under a settled import is a page that gave us nothing, which per D15 is
    // not a failure. The word changes because the same state means two things and the
    // status is what tells them apart.
    expect(bodyOf(app)).toContain("nothing read");
  });
});

describe("the model picker", () => {
  test("it shows what the server resolved, before any link is typed", async () => {
    const { app } = await onPage();
    expect(app.usableLinks).toEqual([]);

    const body = bodyOf(app);
    // The model the *server* resolved against its live catalogue. Nothing in the browser
    // holds this id: `modelOption.ts` is explicit that a descriptor is observed at build
    // and replaced wholesale on rebuild, so an id in this bundle would outlive the
    // catalogue entry it names. And it is on screen with no checkbox and no link: this
    // page exists to import, so there is nothing to reveal it for.
    expect(body).toContain("opencode/glm-5.3-flash-free");
    expect(body).toContain("resolved from the catalogue");
  });

  test("the fallback is labelled as one", async () => {
    const { app } = await onPage((fake) => {
      // What the server answers when its catalogue does not offer the preferred model.
      // The rule ran on the server, over what the harnesses reported; the screen only
      // shows which branch it took.
      fake.onImporterModel = () =>
        ok(
          importerModelView({
            instanceId: "claude-code",
            model: "claude-sonnet-5",
            origin: "fallback",
            detail:
              "no configured harness offers opencode/glm-5.3-flash-free, so this uses Claude Code's own default model, claude-sonnet-5",
          }),
        );
    });

    const body = bodyOf(app);
    expect(body).toContain("claude-sonnet-5");
    expect(body).toContain("resolved by fallback");
    expect(body).toContain("no configured harness offers");
  });

  /**
   * The picker on this page is the composer's picker, from one component.
   *
   * These two claims were where the duplicate had already drifted, and both are about
   * something the operator can see. They are asserted here rather than in the composer's
   * own suite because here is where they were wrong.
   */
  describe("it is the same control as the composer's", () => {
    test("an unusable harness keeps its row and its reason", async () => {
      const { app } = await onPage((fake) => {
        fake.onHarnesses = () =>
          ok([
            harnessInstance({
              instanceId: "opencode",
              displayName: "OpenCode",
              isDefault: true,
            }),
            harnessInstance({
              instanceId: "claude-code",
              displayName: "Claude Code",
              ready: false,
              isDefault: false,
              reason: "the Claude Agent SDK is not installed on this server",
              setup: "bun add @anthropic-ai/claude-agent-sdk",
            }),
          ]);
      });
      app.toggleImportPicker();

      const body = bodyOf(app);
      // Visible, and carrying the harness's own sentence about why and what to do about
      // it. This screen used to set `disabled` with `opacity: 0.5` and print neither,
      // which leaves an operator with nothing to act on — the reason has to be readable
      // where the choice is made.
      expect(body).toContain("Claude Code");
      expect(body).toContain("the Claude Agent SDK is not installed");
      expect(body).toContain("bun add @anthropic-ai/claude-agent-sdk");
      expect(body).toContain("unusable");
    });

    test("the instance rail is there with one harness configured", async () => {
      const { app } = await onPage((fake) => {
        fake.onHarnesses = () =>
          ok([harnessInstance({ instanceId: "opencode" })]);
      });
      app.toggleImportPicker();

      // It used to be hidden behind `harnesses.length > 1`, so configuring a second
      // harness made a rail appear that the operator had not asked for. The composer's
      // picker always showed it.
      const body = bodyOf(app);
      expect(body).toContain('aria-label="Harness instances"');
      // A selectable row for the one harness, which is what "the rail is there" means.
      expect(body).toContain('role="option"');
      expect(body).toContain('aria-selected="true"');
    });
  });

  test("no harness at all says why, and Start cannot be pressed", async () => {
    const { app } = await onPage((fake) => {
      fake.onImporterModel = () =>
        refused(
          new ImporterModelUnavailable({
            reason: "no_harness",
            detail:
              "no agent harness on this server is ready, so there is no catalogue to resolve a model against and no import can run",
          }),
        );
    });
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);

    expect(app.importerModel).toBeUndefined();
    const body = bodyOf(app);
    // Said, rather than leaving Start enabled and letting the operator paste links
    // nothing will ever read.
    expect(body).toContain("no agent harness on this server is ready");
    expect(startEnabled(body)).toBe(false);
  });
});

describe("program links are a repeatable list", () => {
  test("it starts with one empty row, so pasting one URL is one action", async () => {
    const { app } = await onPage();
    expect(app.programLinks).toHaveLength(1);
    expect(app.usableLinks).toEqual([]);
  });

  test("Start cannot be pressed until there is a link to read", async () => {
    const { app } = await onPage();
    expect(startEnabled(bodyOf(app))).toBe(false);
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    expect(startEnabled(bodyOf(app))).toBe(true);
  });

  test("rows are added, filled and removed, and the last one is emptied not removed", async () => {
    const { app } = await onPage();
    const first = app.programLinks[0]?.id ?? 1;
    app.setProgramLink(first, PAGE_A);
    app.addProgramLink();
    const second = app.programLinks[1]?.id ?? 2;
    app.setProgramLink(second, PAGE_B);
    expect(app.usableLinks).toEqual([PAGE_A, PAGE_B]);

    app.removeProgramLink(second);
    expect(app.usableLinks).toEqual([PAGE_A]);

    // Removing the last one leaves a field to type into rather than an empty space with a
    // button under it.
    app.removeProgramLink(app.programLinks[0]?.id ?? 1);
    expect(app.programLinks).toHaveLength(1);
    expect(app.usableLinks).toEqual([]);
  });

  test("blank rows and duplicates are not sent", async () => {
    const { app } = await onPage();
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    app.addProgramLink();
    app.addProgramLink();
    const ids = app.programLinks.map((link) => link.id);
    app.setProgramLink(ids[1] ?? 2, `  ${PAGE_A}  `);
    app.setProgramLink(ids[2] ?? 3, "");
    // Trimmed, deduplicated, in order — and a blank row is not an empty-string link.
    expect(app.usableLinks).toEqual([PAGE_A]);
  });
});

describe("creating a target no longer takes program links", () => {
  test("the draft is a folder, a name and a note, and nothing about an importer", async () => {
    const created = targetSummary({ id: "acme-corp", name: "acme-corp" });
    const fake = new FakeServer();
    fake.onCreateTarget = () => ok(targetCreated({ target: created }));
    fake.onTargets = () => ok([created]);
    const app = new App(fake, new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openNewTarget();
    await settle();
    app.chooseFolder("/work/acme-corp");
    app.dialogScope = "window: Q4";
    await app.createTarget();

    const sent = fake.calls.find((entry) => entry.method === "createTarget");
    expect(sent?.args[1]).toEqual({
      workspacePath: "/work/acme-corp",
      name: "acme-corp",
      scopeNote: "window: Q4",
    });
    // And it asked nothing about an importer while the form was up: which model an import
    // would run on is the Auto-load page's question now.
    expect(fake.countOf("importerModel")).toBe(0);
    // No import to hand a panel to, so it lands on the target as it always did.
    expect(app.screen).toBe("target");
    expect(app.navItem).toBe("goals");
    expect(fake.countOf("startScopeImport")).toBe(0);
  });
});

describe("starting an import on a target that exists", () => {
  test("the links are sent for that target, and the page becomes the panel", async () => {
    const { app, fake } = await onPage();
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    await app.startScopeImport();

    const sent = fake.calls.find(
      (entry) => entry.method === "startScopeImport",
    );
    expect(sent?.args[1]).toBe("acme-corp");
    expect(
      (sent?.args[2] as { programLinks: readonly string[] }).programLinks,
    ).toEqual([PAGE_A]);
    // No model is sent, because the operator overrode nothing — which is what lets the
    // server apply D15's rule to the catalogue it observed rather than to a model id this
    // page happened to be showing.
    expect(
      (sent?.args[2] as { importModel?: unknown }).importModel,
    ).toBeUndefined();

    expect(app.importerPhase).toBe("importing");
    expect(app.scopeImportId).toBe("imp_1");
    expect(app.scopeImportTargetId).toBe("acme-corp");
  });

  test("an override is sent, and only then", async () => {
    const { app, fake } = await onPage();
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    app.pickImportModel("openai/gpt-5.6-sol");
    await app.startScopeImport();

    const sent = fake.calls.find(
      (entry) => entry.method === "startScopeImport",
    );
    expect((sent?.args[2] as { importModel?: unknown }).importModel).toEqual({
      model: "openai/gpt-5.6-sol",
    });
  });

  test("with no link typed it asks the server nothing", async () => {
    const { app, fake } = await onPage();
    await app.startScopeImport();
    expect(fake.countOf("startScopeImport")).toBe(0);
    expect(app.importerPhase).toBe("form");
  });

  test("a second press while the first is out starts one import, not two", async () => {
    // Nothing on the server tells two starts apart, so this is the only thing between a
    // double click and two sessions writing into one scope.
    const { app, fake } = await onPage();
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    const first = app.startScopeImport();
    const second = app.startScopeImport();
    await Promise.all([first, second]);
    expect(fake.countOf("startScopeImport")).toBe(1);
  });

  test("a server that cannot read pages leaves the form up, with its sentence", async () => {
    const { app } = await onPage((server) => {
      server.onStartScopeImport = () =>
        ok({
          scopeImport: null,
          importDetail:
            "this server is configured with no agent harness, so program pages cannot be read.",
        });
    });
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    await app.startScopeImport();

    // Not an error state and not a move: the links are still there to fix or try again.
    expect(app.importerPhase).toBe("form");
    expect(app.importerOpen).toBe(true);
    expect(app.usableLinks).toEqual([PAGE_A]);
    expect(bodyOf(app)).toContain("no agent harness");
    expect(app.scopeImportId).toBe("");
  });

  test("a target the server will not open is refused in its words", async () => {
    const { app } = await onPage((server) => {
      server.onStartScopeImport = () =>
        refused(
          new TargetUnavailable({
            reason: "schema_unavailable",
            targetId: "acme-corp",
            detail: 'Migration "1_x" failed',
          }),
        );
    });
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    await app.startScopeImport();

    expect(app.importerPhase).toBe("form");
    expect(app.importStartDetail).toBe('Migration "1_x" failed');
    expect(bodyOf(app)).toContain("Migration");
  });
});

describe("the import is watched, and stopping keeps what landed", () => {
  const withImport = async () => {
    const { app, fake } = await onPage();
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    return { app, fake };
  };

  test("the first poll happens without waiting for the timer", async () => {
    const { app } = await withImport();
    await app.startScopeImport();
    await settle();
    // The panel has something to render immediately rather than a blank minute.
    expect(app.scopeImport?.importId).toBe("imp_1");
  });

  test("an import that wrote nothing ends in a toast on the Assets screen", async () => {
    const { app, fake } = await withImport();
    fake.onScopeImport = () =>
      ok(
        scopeImportView({
          targetId: "acme-corp",
          status: "finished",
          totals: { entriesIn: 0, entriesOut: 0, assets: 0 },
        }),
      );
    await app.startScopeImport();
    await settle();

    expect(app.toast).toContain("Nothing could be read from those pages");
    expect(app.navItem).toBe("assets");
    // Off the importer page and onto the Assets page itself, where the toast is read.
    expect(app.importerOpen).toBe(false);
  });

  test("and the toast carries why, because the panel it was on is gone", async () => {
    // This is the path where `detail` is the whole message rather than a footnote: an
    // import that wrote nothing takes the operator off the panel, so the panel's own
    // status line is never read. The most common real case is a program page that answers
    // 200 with no scope in it — every step of the import succeeds, and without the
    // session's own report the operator is told only that nothing could be read.
    const { app, fake } = await withImport();
    fake.onScopeImport = () =>
      ok(
        scopeImportView({
          targetId: "acme-corp",
          status: "finished",
          detail:
            "hackerone.com/mars/policy_scopes returned a page with no scope table.",
          totals: { entriesIn: 0, entriesOut: 0, assets: 0 },
        }),
      );
    await app.startScopeImport();
    await settle();

    expect(app.toast).toContain("The importer reported");
    expect(app.toast).toContain("no scope table");
    expect(app.navItem).toBe("assets");
  });

  test("an import that wrote something leaves the operator on the panel", async () => {
    const { app, fake } = await withImport();
    fake.onScopeImport = () =>
      ok(
        scopeImportView({
          targetId: "acme-corp",
          status: "finished",
          totals: { entriesIn: 4, entriesOut: 2, assets: 7 },
        }),
      );
    await app.startScopeImport();
    await settle();

    // The receipt stays, because reading it is why they are here. A screen that jumped
    // away the instant the import finished would take the receipt with it.
    expect(app.toast).toBe("");
    expect(app.importerPhase).toBe("importing");
    expect(app.importerOpen).toBe(true);
    expect(app.scopeImport?.totals.assets).toBe(7);
  });

  test("stopping answers with what landed, and does not clear it", async () => {
    const { app, fake } = await withImport();
    await app.startScopeImport();
    await settle();
    fake.onStopScopeImport = () =>
      ok(
        scopeImportView({
          targetId: "acme-corp",
          status: "stopped",
          detail: "stopped by the operator.",
          totals: { entriesIn: 3, entriesOut: 1, assets: 5 },
          calls: [call("add_scope_entry", "in · subtree · acme.com", PAGE_A)],
        }),
      );
    await app.stopImport();

    // Everything written before the stop stays. That is what makes stopping early a
    // decision rather than a loss, and it is true because the importer writes as it reads.
    expect(app.scopeImport?.status).toBe("stopped");
    expect(app.scopeImport?.totals).toEqual({
      entriesIn: 3,
      entriesOut: 1,
      assets: 5,
    });
    expect(app.scopeImport?.calls).toHaveLength(1);
  });

  test("leaving it in the background stops polling and leaves the import alone", async () => {
    const { app, fake } = await withImport();
    await app.startScopeImport();
    await settle();
    const before = fake.calls.filter(
      (entry) => entry.method === "scopeImport",
    ).length;

    app.continueImportInBackground();
    await settle();

    // No stop was sent: the import is a server-side fiber and was never driven from here,
    // which is what makes this a navigation rather than a mode.
    expect(fake.calls.some((entry) => entry.method === "stopScopeImport")).toBe(
      false,
    );
    // And the panel stopped asking.
    const after = fake.calls.filter(
      (entry) => entry.method === "scopeImport",
    ).length;
    expect(after).toBe(before);
    expect(app.screen).toBe("target");
  });
});

/**
 * Coming back to the page with an import still going.
 *
 * Nothing on the server tells two starts apart, so the page itself is the only thing that
 * keeps an operator who stepped away from starting a second session over the first.
 */
describe("coming back to the page", () => {
  const running = async () => {
    const { app, fake, countdown } = await onPage();
    app.setProgramLink(app.programLinks[0]?.id ?? 1, PAGE_A);
    await app.startScopeImport();
    await settle();
    return { app, fake, countdown };
  };

  test("an import still running is shown as its panel, not a fresh form", async () => {
    const { app, fake } = await running();
    // Leave by the rail: stops the poll, leaves the import.
    app.toSection("assets");
    expect(app.importerOpen).toBe(false);
    const polled = fake.countOf("scopeImport");

    app.openImporter();
    await settle();

    expect(app.importerPhase).toBe("importing");
    expect(app.scopeImportId).toBe("imp_1");
    // Watching again: it asked the server how the import is going.
    expect(fake.countOf("scopeImport")).toBeGreaterThan(polled);
    expect(fake.countOf("startScopeImport")).toBe(1);
  });

  test("a settled import is not resumed: the operator gets a clean form", async () => {
    const { app, fake } = await running();
    fake.onScopeImport = () =>
      ok(
        scopeImportView({
          targetId: "acme-corp",
          status: "finished",
          totals: { entriesIn: 2, entriesOut: 0, assets: 0 },
        }),
      );
    app.toSection("assets");
    app.openImporter();
    await settle();
    // The first answer settles it; the panel stays for the receipt.
    expect(app.scopeImport?.status).toBe("finished");

    app.toSection("assets");
    app.openImporter();

    expect(app.importerPhase).toBe("form");
    expect(app.usableLinks).toEqual([]);
    expect(app.scopeImportId).toBe("");
  });

  test("another target's import is not this target's panel", async () => {
    const { app } = await running();
    app.openTarget("internal-api");
    app.toSection("assets");
    app.openImporter();
    expect(app.importerPhase).toBe("form");
  });

  test("leaving the page stops the poll, so a finish elsewhere cannot yank the operator back", async () => {
    const { app, countdown } = await running();
    // Watching: exactly one poll is armed.
    expect(pollTimers(countdown)).toHaveLength(1);

    app.toSection("goals");

    expect(pollTimers(countdown)).toHaveLength(0);
  });

  test("so does opening another target", async () => {
    const { app, countdown } = await running();
    expect(pollTimers(countdown)).toHaveLength(1);

    app.openTarget("internal-api");

    expect(pollTimers(countdown)).toHaveLength(0);
  });
});
