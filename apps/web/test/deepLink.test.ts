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
import { GoalNotFound } from "@bit/contracts";

import { App } from "../src/lib/app.svelte";
import { placeArrivedAt } from "../src/lib/arrival";
import { applyPlace, parsePath, pathOf, placeOf } from "../src/lib/place";
import { FakeCountdown } from "./fakeCountdown";
import {
  FakeServer,
  importerSessionView,
  ok,
  refused,
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

  test("names a target this server does not have, and lands on the list saying so", async () => {
    /*
     * Design D5, on the path the whole slice had to be driven along: the link arrives
     * before there is a session, waits behind Connect for as long as the password takes,
     * and only once the registry is in hand turns out to name nothing.
     *
     * **The sentence has to be there when the list renders**, which is why it is `App`'s
     * and not raised by whatever screen was up at the time: it is written at the one moment
     * the answer is known, which is after the gate has already dropped, and nothing between
     * that moment and the first render of the target list clears it. A message raised while
     * Connect was up and gone by the time the list arrived would be no message at all.
     *
     * Still no request spent on the target: the refusal is read off the list that just
     * loaded, so there is no flash of a target on its way to being refused.
     */
    const fake = served((f) => {
      f.onTargets = () => ok([targetSummary({ id: T, name: T })]);
    });
    const app = new App(fake, new FakeCountdown());
    arriveAt(app, "/t/from-another-server/goals/goal_1");

    expect(app.screen).toBe("connect");
    expect(app.arrivalNote).toBe("");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    expect(app.screen).toBe("welcome");
    expect(reflected(app)).toBe("/");
    expect(fake.countOf("target")).toBe(0);
    expect(app.arrivalNote).toBe(
      'This server has no target called "from-another-server", so there was nothing to open. These are the targets it does have.',
    );
  });

  test("names a goal that has gone, and lands on that target's goal list saying so", async () => {
    /*
     * The second of D5's three, and the one that needs the server rather than the registry:
     * `App` can tell a target it has never heard of from the list it already holds, and it
     * cannot tell anything about a goal without asking. So this link is replayed in full,
     * the goal page opens on the strength of the id, and the fallback happens a round trip
     * later — one flicker in exchange for every live link opening at once.
     */
    const fake = served((f) => {
      f.onGoal = (_url, targetId, goalId) =>
        refused(
          new GoalNotFound({
            targetId,
            goalId,
            detail: `no goal '${goalId}' is recorded in this target`,
          }),
        );
    });
    const app = new App(fake, new FakeCountdown());
    arriveAt(app, "/t/acme-corp/goals/goal_9");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    // On the target the link named, on its goal list, which is one level out.
    expect(app.viewTargetId).toBe(T);
    expect(app.navItem).toBe("goals");
    expect(app.openGoalId).toBe("");
    expect(reflected(app)).toBe("/t/acme-corp");
    expect(app.arrivalNote).toBe(
      "This target has no goal under the id \"goal_9\". A goal id belongs to one target, so it may be another target's — these are this target's goals.",
    );
  });

  test("names a chat session that has gone, and lands on the Agent sessions list saying so", async () => {
    /*
     * The third, and the one D5 calls likeliest, because a harness can let a session go
     * while an index still remembers it. The sentence already existed before this slice and
     * went to the Agent sessions list's own banner, which an operator arriving from a
     * bookmark was not looking at — so what S5 changed is the surface, and this is the
     * arrival that could not see the old one.
     */
    const fake = served((f) => {
      f.onImporterSessions = () => ok({ sessions: [] });
    });
    const app = new App(fake, new FakeCountdown());
    arriveAt(app, "/t/acme-corp/assets/chat/ses_1");

    app.password = "correct-horse";
    await app.connect();
    replay(app);
    await settle();

    expect(app.importerOpen).toBe(false);
    expect(app.navItem).toBe("agent-sessions");
    expect(reflected(app)).toBe("/t/acme-corp/agent-sessions");
    expect(app.arrivalNote).toBe(
      "That importer session is no longer in the importer's own list, so there is nothing to open it on. The target's agent sessions are listed here.",
    );
  });

  test("and the note goes when the operator navigates away from the fallback", async () => {
    // It waits to be read and it does not outstay its welcome. The sentence is about where
    // a link sent the operator, so once they pick somewhere themselves it is about nothing
    // on screen — and the route's history rule depends on the same moment.
    const fake = served((f) => {
      f.onTargets = () => ok([targetSummary({ id: T, name: T })]);
    });
    const app = new App(fake, new FakeCountdown());
    arriveAt(app, "/t/from-another-server");

    app.password = "correct-horse";
    await app.connect();
    await settle();
    expect(app.arrivalNote).not.toBe("");

    app.openTarget(T);
    expect(app.arrivalNote).toBe("");
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
