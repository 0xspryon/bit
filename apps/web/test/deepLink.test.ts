/**
 * A deep link from end to end, with no router in the room.
 *
 * The route is a few effects over two halves that know nothing about each other: `App`
 * holds a path across the Connect screen and says when it can be opened
 * (`app.test.ts`), and `place.ts` reads a path and replays it (`place.test.ts`). Neither
 * file can show that a *link works*, because working is the two of them composed in the
 * order the route composes them — read the URL at mount, hold the place, replay it when
 * the session arrives.
 *
 * That composition is four lines, so it is written here rather than mounted:
 * `routes/[...place]/+page.svelte` needs a DOM and `$app/navigation` to mount, and none of
 * the arithmetic worth asserting is in the mounting. What is asserted is the operator's
 * sentence — a link opened before there is a session lands on the whole place afterwards,
 * by either way in — plus the one old spelling that still has to land.
 *
 * **Every test owns its own `App` and its own double**, the convention `app.test.ts`
 * records: a shared one makes the ordering depend on the order the tests run in.
 */
import { describe, expect, test } from "bun:test";

import { App } from "../src/lib/app.svelte";
import { placeArrivedAt } from "../src/lib/arrival";
import { applyPlace, parsePath, pathOf, placeOf } from "../src/lib/place";
import { FakeCountdown } from "./fakeCountdown";
import {
  FakeServer,
  importerSessionView,
  ok,
  targetSummary,
} from "./fakeServer";

/** Lets everything already in flight finish. `openTarget` is fire-and-forget. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const T = "acme-corp";

/** The dev server's own origin, so the hrefs below read like the ones in the address bar. */
const ORIGIN = "http://127.0.0.1:5173";

const served = (arrange: (fake: FakeServer) => void = () => {}): FakeServer => {
  const fake = new FakeServer();
  fake.onTargets = () =>
    ok([targetSummary({ id: T, name: T }), targetSummary({ id: "scratch" })]);
  fake.onImporterSessions = () =>
    ok({ sessions: [importerSessionView({ sessionId: "ses_1" })] });
  arrange(fake);
  return fake;
};

/**
 * The route's mount step: read the URL the tab was opened with, and hold what it names.
 *
 * `pathOf` of the parsed place and not the text that arrived, which is what makes the
 * translation of an old link a one-time event — by the time anything else sees this path
 * there is one spelling of it left.
 */
const arriveAt = (app: App, href: string): void => {
  const url = new URL(href, ORIGIN);
  const place = placeArrivedAt(url.pathname, url.search);
  if (place.kind !== "targets") app.requestPlace(place.targetId, pathOf(place));
};

/** The route's replay step: whatever `App` has released, read and applied. */
const replay = (app: App): void => {
  const path = app.takeReplayPath();
  if (path === "") return;
  applyPlace(app, parsePath(path));
};

/** What the route would write into the address bar for the state as it stands. */
const reflected = (app: App): string => pathOf(placeOf(app));

describe("a link opened before there is a session", () => {
  test("lands on the whole place after a fresh sign-in, not on the target", async () => {
    /*
     * The scope note S2 carries. `requestedTargetId` alone would have opened the target
     * and stopped on Goals, which is the wrong page for this link and a visible flash of
     * the right target on its way somewhere else. The whole path is held, so the section
     * and the tab arrive with it.
     */
    const app = new App(served(), new FakeCountdown());
    arriveAt(app, "/t/acme-corp/assets/scope");

    expect(app.screen).toBe("connect");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    expect(app.screen).toBe("target");
    expect(app.viewTargetId).toBe(T);
    expect(app.navItem).toBe("assets");
    expect(app.assetsTab).toBe("scope");
    expect(reflected(app)).toBe("/t/acme-corp/assets/scope");
  });

  test("lands on the same place when the session is resumed instead", async () => {
    // The other way in, and the one that happens more: the registry is in memory, so a
    // bookmark opened the next morning either resumes or waits behind Connect, and both
    // have to end up here.
    const fake = served();
    fake.stored = "token-from-a-reload";
    const app = new App(fake, new FakeCountdown());
    arriveAt(app, "/t/acme-corp/assets/scope");

    await app.restore();
    replay(app);
    await settle();

    expect(app.screen).toBe("target");
    expect(app.navItem).toBe("assets");
    expect(app.assetsTab).toBe("scope");
    expect(reflected(app)).toBe("/t/acme-corp/assets/scope");
  });

  test("keeps a view the query asked for", async () => {
    // `?filter=` is the one view modifier in the grammar (design decision 2), and it rides
    // through the hold with the rest of the place rather than being dropped at Connect.
    const app = new App(served(), new FakeCountdown());
    arriveAt(app, "/t/acme-corp/assets/estate?filter=uncovered");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    expect(app.assetsTab).toBe("estate");
    expect(app.estateFilter).toBe("uncovered");
    expect(reflected(app)).toBe("/t/acme-corp/assets/estate?filter=uncovered");
  });

  test("is replayed once, so a second pass moves nothing", async () => {
    const app = new App(served(), new FakeCountdown());
    arriveAt(app, "/t/acme-corp/findings");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();
    app.toSection("events");
    replay(app);

    // Still where the operator went, not back where the link pointed.
    expect(app.navItem).toBe("events");
  });

  test("names a target this server does not have, and lands on the list", async () => {
    const fake = served((f) => {
      f.onTargets = () => ok([targetSummary({ id: T, name: T })]);
    });
    const app = new App(fake, new FakeCountdown());
    arriveAt(app, "/t/from-another-server/goals/goal_1");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    expect(app.screen).toBe("welcome");
    expect(reflected(app)).toBe("/");
    expect(fake.countOf("target")).toBe(0);
  });
});

describe("the link the shell used to write", () => {
  test("?target= still lands on that target, as a path", async () => {
    /*
     * The bookmark an operator may already have saved. It is translated on arrival and
     * never again: what is held is the path form, so the first reflection replaces the
     * query in the address bar with `/t/acme-corp` and nothing downstream of the mount has
     * heard of the parameter.
     */
    const app = new App(served(), new FakeCountdown());
    arriveAt(app, "/?target=acme-corp");

    expect(app.requestedPath).toBe("/t/acme-corp");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    expect(app.screen).toBe("target");
    expect(app.viewTargetId).toBe(T);
    expect(app.navItem).toBe("goals");
    expect(reflected(app)).toBe("/t/acme-corp");
  });

  test("a path wins over a stale parameter beside it", () => {
    // Not a disagreement to resolve: a path form says where it goes, and a `?target=` left
    // on it is a parameter riding along from a link that was edited by hand.
    expect(placeArrivedAt("/t/acme-corp/events", "?target=scratch")).toEqual({
      kind: "section",
      targetId: T,
      section: "events",
    });
  });

  test("an empty or absent parameter names nothing in particular", () => {
    expect(placeArrivedAt("/", "")).toEqual({ kind: "targets" });
    expect(placeArrivedAt("/", "?target=")).toEqual({ kind: "targets" });
    expect(placeArrivedAt("/", "?other=acme-corp")).toEqual({
      kind: "targets",
    });
  });
});

describe("a URL that names nowhere", () => {
  test("holds nothing, so the route is free to tidy the address bar", async () => {
    /*
     * The suppression in the route is "a held place is a link not yet followed", and the
     * root is not one: nothing is restored by it and holding it would stop the reflection
     * for the rest of the visit. So a URL that parses to the target list is dropped at the
     * mount and the first reflection writes `/`.
     */
    const app = new App(served(), new FakeCountdown());
    arriveAt(app, "/nonsense/and/more");

    expect(app.requestedPath).toBe("");
    expect(app.requestedTargetId).toBe("");

    app.password = "correct-horse";
    await app.connect();
    replay(app);

    expect(app.screen).toBe("welcome");
    expect(reflected(app)).toBe("/");
  });
});
