/**
 * The app's hold on the importer's session index: when it is read, when it is let go of, and
 * what a failed read does to it.
 *
 * The screens' own claims are `dom/importerSessions.test.ts`'s. These are the state ones a
 * click cannot see: that the index belongs to a target and is not carried to the next one,
 * that each visit to Assets asks again, and that a read which fails keeps what was there.
 */
import { describe, expect, test } from "bun:test";

import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import {
  FakeServer,
  importerSessionView,
  ok,
  targetSummary,
  unreachable,
} from "./fakeServer";
import { settle } from "./dom/dom";

const connected = async (fake: FakeServer): Promise<App> => {
  fake.onTargets = () =>
    ok([targetSummary(), targetSummary({ id: "other-corp", name: "other" })]);
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  return app;
};

describe("the importer session index", () => {
  test("is read each time the Assets section is entered", async () => {
    const fake = new FakeServer();
    const app = await connected(fake);
    app.openTarget("acme-corp");
    await settle();

    app.toSection("assets");
    await settle();
    expect(fake.countOf("importerSessions")).toBe(1);

    // A session may have started in another tab since: the same reasoning as the estate.
    fake.onImporterSessions = () =>
      ok({ sessions: [importerSessionView({ sessionId: "ses_later" })] });
    app.toSection("goals");
    app.toSection("assets");
    await settle();
    expect(fake.countOf("importerSessions")).toBe(2);
    expect(app.lastImporterSession?.sessionId).toBe("ses_later");
  });

  test("sessions that arrive after the page opened are listed, and the open thread stays put", async () => {
    const fake = new FakeServer();
    fake.onImporterSessions = () =>
      ok({ sessions: [importerSessionView({ sessionId: "ses_arrived" })] });
    const app = await connected(fake);
    app.openTarget("acme-corp");
    await settle();

    // Straight to the page, without the Assets screen having read the index first: what is
    // known when it opens is nothing, and the list fills in when the read comes back.
    app.openImporter();
    expect(app.importer.listed).toEqual([]);
    const typing = app.importer.currentId;
    await settle();

    expect(app.importer.listed.map((session) => session.id)).toEqual([
      "ses_arrived",
    ]);
    // The empty session the operator may already be typing into is not swapped from under them.
    expect(app.importer.currentId).toBe(typing);
  });

  test("is not carried to the next target", async () => {
    const fake = new FakeServer();
    fake.onImporterSessions = () =>
      ok({ sessions: [importerSessionView({ sessionId: "ses_acme" })] });
    const app = await connected(fake);
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    expect(app.lastImporterSession?.sessionId).toBe("ses_acme");

    // Another client's engagement must not be offered this one's session to continue.
    fake.onImporterSessions = () => unreachable("slow");
    app.openTarget("other-corp");
    await settle();
    expect(app.lastImporterSession).toBeUndefined();
    expect(app.importerIndex).toEqual([]);
  });

  test("keeps what it held when a later read fails", async () => {
    const fake = new FakeServer();
    fake.onImporterSessions = () =>
      ok({ sessions: [importerSessionView({ sessionId: "ses_kept" })] });
    const app = await connected(fake);
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();

    fake.onImporterSessions = () => unreachable("no answer");
    await app.loadImporterSessions("acme-corp");

    // A blip must not make the operator think their sessions are gone.
    expect(app.lastImporterSession?.sessionId).toBe("ses_kept");
  });

  test("a read that answers after the operator has moved on is dropped", async () => {
    const fake = new FakeServer();
    fake.onImporterSessions = () =>
      ok({ sessions: [importerSessionView({ sessionId: "ses_late" })] });
    const app = await connected(fake);
    app.openTarget("acme-corp");
    await settle();

    // The read for acme-corp is in flight when the operator opens the other target: the
    // answer resumes after `viewTargetId` has moved, and must not land on the new target.
    app.toSection("assets");
    app.openTarget("other-corp");
    await settle();

    expect(app.importerIndex).toEqual([]);
    expect(app.lastImporterSession).toBeUndefined();
  });
});
