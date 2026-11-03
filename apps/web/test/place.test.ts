/**
 * The URL grammar: what each inventory row's path is, what garbage means, and what
 * replaying a place does to the state.
 *
 * `place.ts` has no DOM, no router and no server, which is the point of it being its own
 * module — so most of this file is plain table-driven assertions about strings. The last
 * section is not: {@link applyPlace} drives a real `App` against `FakeServer`, because the
 * claim being tested there is that calling `App`'s own methods in the right order lands in
 * the state the place names, and the ordering is the part that can be wrong (`openTarget`
 * resets `navItem` to `goals`, so anything built on top of it has to come after).
 *
 * **Every test owns its own `App` and its own double**, the convention `app.test.ts`
 * records: a shared one makes the ordering tests depend on the order they run in.
 */
import { describe, expect, test } from "bun:test";

import { App } from "../src/lib/app.svelte";
import { navItems } from "../src/lib/mock";
import {
  PLAIN_SECTIONS,
  applyPlace,
  parsePath,
  pathOf,
  placeOf,
  type Place,
} from "../src/lib/place";
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

/**
 * The design's addressable inventory, as a table.
 *
 * Both directions are checked against these literal strings rather than against each
 * other, because a round-trip alone would hold just as well for a grammar that formatted
 * every place as `/x/y/z`. The paths here are the ones written in the design doc, and a
 * saved link is a promise about exactly this text.
 */
const INVENTORY: readonly (readonly [string, Place])[] = [
  ["/", { kind: "targets" }],
  ["/t/acme-corp", { kind: "target", targetId: T }],
  [
    "/t/acme-corp/findings",
    { kind: "section", targetId: T, section: "findings" },
  ],
  [
    "/t/acme-corp/goals/goal_1",
    { kind: "goal", targetId: T, goalId: "goal_1" },
  ],
  [
    "/t/acme-corp/assets/estate",
    { kind: "estate", targetId: T, filter: "all" },
  ],
  [
    "/t/acme-corp/assets/estate?filter=uncovered",
    { kind: "estate", targetId: T, filter: "uncovered" },
  ],
  [
    "/t/acme-corp/assets/estate?filter=in",
    { kind: "estate", targetId: T, filter: "in" },
  ],
  [
    "/t/acme-corp/assets/estate?filter=out",
    { kind: "estate", targetId: T, filter: "out" },
  ],
  ["/t/acme-corp/assets/scope", { kind: "scope", targetId: T }],
  [
    "/t/acme-corp/assets/chat/ses_1",
    { kind: "chat", targetId: T, sessionId: "ses_1" },
  ],
  [
    "/t/acme-corp/attempts/attempt-7",
    { kind: "attempt", targetId: T, attemptId: "attempt-7" },
  ],
  [
    "/t/acme-corp/settings",
    { kind: "section", targetId: T, section: "settings" },
  ],
];

describe("the addressable inventory", () => {
  for (const [path, place] of INVENTORY) {
    test(`${place.kind} formats as ${path}`, () => {
      expect(pathOf(place)).toBe(path);
    });

    test(`${path} parses back to the same place`, () => {
      expect(parsePath(path)).toEqual(place);
    });
  }

  test("every section of the rail has a path", () => {
    /*
     * The rail is the list of sections an operator can reach by clicking, so a section
     * missing from the grammar is a page with no link to it. `goals` and `assets` are
     * covered by their own cases — a target's landing page and the Assets tabs — which is
     * why they are not in `PLAIN_SECTIONS`.
     */
    for (const item of navItems) {
      const addressable =
        item.id === "goals" ||
        item.id === "assets" ||
        PLAIN_SECTIONS.some((section) => section === item.id);
      expect(addressable).toBe(true);
    }
  });

  test("each plain section round-trips under its own id", () => {
    for (const section of PLAIN_SECTIONS) {
      const place: Place = { kind: "section", targetId: T, section };
      expect(pathOf(place)).toBe(`/t/acme-corp/${section}`);
      expect(parsePath(pathOf(place))).toEqual(place);
    }
  });

  test("an id with a slash in it survives the trip", () => {
    // Ids come from the server and nothing promises they are URL-safe. A goal id with a
    // separator in it would otherwise parse as two segments and name a different goal.
    const place: Place = {
      kind: "goal",
      targetId: "acme/corp",
      goalId: "goal/1",
    };
    expect(pathOf(place)).toBe("/t/acme%2Fcorp/goals/goal%2F1");
    expect(parsePath(pathOf(place))).toEqual(place);
  });
});

/**
 * What a string that is not an inventory row means.
 *
 * "The nearest place that exists" is one level out, not the root: an unknown section on a
 * known target is still that target, because the target is the part of the link that was
 * right. Each row here is a shape a real bookmark goes wrong in — a hand-edited path, a
 * link wrapped by a mail client, an id that has since grown a character.
 */
const GARBAGE: readonly (readonly [string, Place])[] = [
  ["", { kind: "targets" }],
  ["/", { kind: "targets" }],
  ["//", { kind: "targets" }],
  ["/t", { kind: "targets" }],
  ["/t/", { kind: "targets" }],
  ["/t//", { kind: "targets" }],
  ["/nonsense", { kind: "targets" }],
  ["/nonsense/acme-corp/goals", { kind: "targets" }],
  // The root segment is a literal, and a path is case-sensitive. `/T/...` is a root this
  // grammar does not have rather than a spelling of the one it does.
  ["/T/acme-corp", { kind: "targets" }],
  ["/t/acme-corp/", { kind: "target", targetId: T }],
  ["/t//acme-corp", { kind: "target", targetId: T }],
  ["t/acme-corp", { kind: "target", targetId: T }],
  ["/t/acme-corp#somewhere", { kind: "target", targetId: T }],
  ["/t/acme-corp?filter=uncovered", { kind: "target", targetId: T }],
  ["/t/acme-corp/nonsense", { kind: "target", targetId: T }],
  // The goal list is the target's landing page, so a goals path with no goal is that.
  ["/t/acme-corp/goals", { kind: "target", targetId: T }],
  ["/t/acme-corp/goals/", { kind: "target", targetId: T }],
  // Trailing junk is ignored rather than refused: the resource is already named.
  [
    "/t/acme-corp/goals/goal_1/notes",
    { kind: "goal", targetId: T, goalId: "goal_1" },
  ],
  [
    "/t/acme-corp/settings/notifications",
    { kind: "section", targetId: T, section: "settings" },
  ],
  // The Assets page without a tab, and with a tab it does not have.
  ["/t/acme-corp/assets", { kind: "estate", targetId: T, filter: "all" }],
  ["/t/acme-corp/assets/", { kind: "estate", targetId: T, filter: "all" }],
  [
    "/t/acme-corp/assets/nonsense",
    { kind: "estate", targetId: T, filter: "all" },
  ],
  [
    "/t/acme-corp/assets?filter=uncovered",
    { kind: "estate", targetId: T, filter: "uncovered" },
  ],
  // A chat with no session named: there is no conversation to open, so it is the page the
  // Auto-load sub-page sits on.
  ["/t/acme-corp/assets/chat", { kind: "estate", targetId: T, filter: "all" }],
  ["/t/acme-corp/assets/chat/", { kind: "estate", targetId: T, filter: "all" }],
  // `attempts` is a collection with no page of its own, and Workers is where its rows will
  // be listed — which is also where replaying one puts the rail.
  [
    "/t/acme-corp/attempts",
    { kind: "section", targetId: T, section: "workers" },
  ],
  [
    "/t/acme-corp/attempts/",
    { kind: "section", targetId: T, section: "workers" },
  ],
  [
    "/t/acme-corp/attempts/attempt-7/raw",
    { kind: "attempt", targetId: T, attemptId: "attempt-7" },
  ],
  // Percent-encoding, decoded where it can be and left alone where it cannot: a stray `%`
  // is a `URIError` from `decodeURIComponent`, and this parser has no failure mode to put
  // it in. It names no target the server holds, which is a different slice's answer.
  ["/t/acme%20corp", { kind: "target", targetId: "acme corp" }],
  ["/t/100%", { kind: "target", targetId: "100%" }],
  [
    "/t/acme-corp/goals/goal%ZZ",
    { kind: "goal", targetId: T, goalId: "goal%ZZ" },
  ],
];

describe("a path that is not one of ours", () => {
  for (const [path, place] of GARBAGE) {
    test(`${path === "" ? "an empty string" : path} is ${place.kind}`, () => {
      expect(parsePath(path)).toEqual(place);
    });
  }

  /**
   * Totality, over more strings than a table can hold.
   *
   * Every combination of three segments from a pool of the things that break parsers —
   * empty, a separator inside a segment, a half-written escape, each of the grammar's own
   * keywords out of position. The two claims are the ones the design asks for: nothing
   * throws, and what comes back is a place the grammar can write down again and read back
   * identically. The second is the stronger of the two — it is what says the parser
   * normalises rather than inventing places that cannot survive a round trip.
   */
  test("nothing throws, and everything normalises", () => {
    const pool = [
      "",
      "t",
      "acme-corp",
      "goals",
      "assets",
      "attempts",
      "estate",
      "chat",
      "settings",
      "%",
      "a/b",
      "..",
    ];
    let checked = 0;
    for (const first of pool) {
      for (const second of pool) {
        for (const third of pool) {
          const path = `/${first}/${second}/${third}`;
          const place = parsePath(path);
          expect(parsePath(pathOf(place))).toEqual(place);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(pool.length ** 3);
  });
});

describe("the estate filter", () => {
  const filterOf = (query: string): string => {
    const place = parsePath(`/t/acme-corp/assets/estate${query}`);
    expect(place.kind).toBe("estate");
    return place.kind === "estate" ? place.filter : "";
  };

  test("an absent, misspelled or impossible filter is the default view", () => {
    // A query parameter says how you were looking at a page, not which page it is, so
    // getting it wrong must still land. Every one of these is a link that made it into a
    // bookmark somehow.
    expect(filterOf("")).toBe("all");
    expect(filterOf("?")).toBe("all");
    expect(filterOf("?filter=")).toBe("all");
    expect(filterOf("?filter=nonsense")).toBe("all");
    expect(filterOf("?filter=UNCOVERED")).toBe("all");
    expect(filterOf("?filter=in-scope")).toBe("all");
    expect(filterOf("?other=uncovered")).toBe("all");
  });

  test("a filter is read beside other parameters, in any order", () => {
    // `&q=` is the home the design leaves for the estate's search text. It must not matter
    // whether it arrives before or after the filter, nor that it is unknown today.
    expect(filterOf("?filter=uncovered&q=admin")).toBe("uncovered");
    expect(filterOf("?q=admin&filter=uncovered")).toBe("uncovered");
  });

  test("a repeated filter takes the first", () => {
    // Arbitrary, and the alternative is worse: a link with two answers has to resolve to
    // one, and the first is the one a reader sees.
    expect(filterOf("?filter=in&filter=uncovered")).toBe("in");
  });

  test("the default view keeps the short URL", () => {
    // `?filter=all` is the whole estate and so is no query at all. Writing the parameter
    // would put it in every bookmark of the Assets page.
    expect(pathOf({ kind: "estate", targetId: T, filter: "all" })).toBe(
      "/t/acme-corp/assets/estate",
    );
  });

  test("a filter on a path that has no filter is ignored, not carried", () => {
    // Otherwise `pathOf` would drop it and the place would not survive its own round trip.
    expect(parsePath("/t/acme-corp/assets/scope?filter=uncovered")).toEqual({
      kind: "scope",
      targetId: T,
    });
    expect(parsePath("/t/acme-corp/findings?filter=uncovered")).toEqual({
      kind: "section",
      targetId: T,
      section: "findings",
    });
  });
});

describe("reading the place out of the state", () => {
  test("a fresh app is the target list", () => {
    // Constructed with no arguments on purpose: `placeOf` must not need a server, a
    // countdown or a router, because the shell will call it on a tab that has not
    // connected to anything yet.
    expect(placeOf(new App())).toEqual({ kind: "targets" });
  });

  test("Connect, the rail and the New target page are all the root", () => {
    // Connect is a gate rather than a place — it is what is shown while the app does not
    // yet know whether it is signed in — and a half-filled form is view state. Neither is
    // a thing to bookmark.
    const app = new App(new FakeServer(), new FakeCountdown());
    expect(placeOf(app)).toEqual({ kind: "targets" });
    app.screen = "welcome";
    expect(placeOf(app)).toEqual({ kind: "targets" });
    app.openNewTarget();
    expect(placeOf(app)).toEqual({ kind: "targets" });
  });

  test("a target on screen with nothing open is still the root", () => {
    // `viewTargetId` is what says which target's data is on screen, and it is empty until
    // `openTarget` moves it. A screen that claims to be on a target without one is not a
    // place a link can name.
    const app = new App(new FakeServer(), new FakeCountdown());
    app.screen = "target";
    expect(placeOf(app)).toEqual({ kind: "targets" });
  });

  test("a section this grammar does not know is the target's own page", () => {
    // Rather than a path that cannot be read back. The rail's ids and `PLAIN_SECTIONS`
    // agree today, and the test above keeps them agreeing; this is what happens if they
    // ever stop.
    const app = new App(new FakeServer(), new FakeCountdown());
    app.screen = "target";
    app.viewTargetId = T;
    app.navItem = "something-later";
    expect(placeOf(app)).toEqual({ kind: "target", targetId: T });
  });
});

/* ── Replay ──────────────────────────────────────────────────────────────────── */

const connected = async (
  arrange: (fake: FakeServer) => void = () => {},
): Promise<App> => {
  const fake = new FakeServer();
  fake.onTargets = () =>
    ok([
      targetSummary({ id: T, name: T }),
      targetSummary({ id: "other-corp" }),
    ]);
  fake.onImporterSessions = () =>
    ok({ sessions: [importerSessionView({ sessionId: "ses_1" })] });
  arrange(fake);
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  return app;
};

/** Signed in, then dropped straight into a place, with its reads let finish. */
const landed = async (
  place: Place,
  arrange: (fake: FakeServer) => void = () => {},
): Promise<App> => {
  const app = await connected(arrange);
  applyPlace(app, place);
  await settle();
  return app;
};

describe("replaying a place", () => {
  test("the target list leaves the target", async () => {
    const app = await landed({ kind: "target", targetId: T });
    applyPlace(app, { kind: "targets" });
    expect(app.screen).toBe("welcome");
    expect(placeOf(app)).toEqual({ kind: "targets" });
  });

  test("a target lands on its goal list", async () => {
    const app = await landed({ kind: "target", targetId: T });
    expect(app.screen).toBe("target");
    expect(app.selectedId).toBe(T);
    expect(app.viewTargetId).toBe(T);
    expect(app.navItem).toBe("goals");
    expect(app.openGoalId).toBe("");
  });

  test("a section opens that section", async () => {
    const app = await landed({
      kind: "section",
      targetId: T,
      section: "findings",
    });
    expect(app.viewTargetId).toBe(T);
    expect(app.navItem).toBe("findings");
  });

  test("a section is reached after the target, not before it", async () => {
    /*
     * The ordering this module exists to get right. `openTarget` resets `navItem` to
     * `goals` — it is how an operator always lands on Goals — so a replay that set the
     * section first would arrive on Goals every time and the bug would look like a section
     * link that does not work.
     */
    const app = await landed({
      kind: "section",
      targetId: T,
      section: "blockers",
    });
    expect(app.navItem).toBe("blockers");
    expect(placeOf(app)).toEqual({
      kind: "section",
      targetId: T,
      section: "blockers",
    });
  });

  test("a goal opens the goal, on the Goals section", async () => {
    const app = await landed({ kind: "goal", targetId: T, goalId: "goal_1" });
    expect(app.navItem).toBe("goals");
    expect(app.openGoalId).toBe("goal_1");
  });

  test("the goal list closes a goal that is open", async () => {
    // The way *back* out of a goal, which is what Back will need of it: `openTarget` is
    // skipped for a target already open, so `toSection("goals")` is what closes the goal.
    const app = await landed({ kind: "goal", targetId: T, goalId: "goal_1" });
    applyPlace(app, { kind: "target", targetId: T });
    expect(app.openGoalId).toBe("");
    expect(app.navItem).toBe("goals");
  });

  test("the estate opens the Assets page on the Estate tab, filtered", async () => {
    const app = await landed({
      kind: "estate",
      targetId: T,
      filter: "uncovered",
    });
    expect(app.navItem).toBe("assets");
    expect(app.assetsTab).toBe("estate");
    expect(app.estateFilter).toBe("uncovered");
  });

  test("the default view clears a filter left by the place before it", async () => {
    // Each case sets everything its place implies rather than trusting what the last one
    // left, because this is also a transition between two places on the same target —
    // where `openTarget`, which would have cleared the filter, is deliberately not called.
    const app = await landed({
      kind: "estate",
      targetId: T,
      filter: "uncovered",
    });
    applyPlace(app, { kind: "estate", targetId: T, filter: "all" });
    expect(app.estateFilter).toBe("all");
  });

  test("the scope opens the Assets page on the Scope tab", async () => {
    const app = await landed({ kind: "scope", targetId: T });
    expect(app.navItem).toBe("assets");
    expect(app.assetsTab).toBe("scope");
  });

  test("a chat from a cold load opens the Auto-load page on that session", async () => {
    /*
     * **Cold on purpose**, because that is the case the whole feature is for: a bookmark
     * opened the next morning, with nothing read yet. The session has to be in the
     * importer's own index before it can be selected, and the index arrives a round trip
     * after the target is opened — so `openImporterSession` reads it first rather than
     * `openImporter` dropping an id it cannot find. The warm case goes through the same
     * method and skips the read.
     */
    const app = await landed({ kind: "chat", targetId: T, sessionId: "ses_1" });

    expect(app.navItem).toBe("assets");
    expect(app.importerOpen).toBe(true);
    expect(app.importer.currentId).toBe("ses_1");
    expect(app.importer.current?.indexed).toBe(true);
    expect(placeOf(app)).toEqual({
      kind: "chat",
      targetId: T,
      sessionId: "ses_1",
    });
  });

  test("a chat whose session is gone does not open the page on the wrong one", async () => {
    /*
     * A bookmark outlives the thing it names, and an importer session is the likeliest of
     * them to go: the index is the importer's own and a session falls out of it. The link
     * then goes nowhere rather than opening the Auto-load page on an empty conversation
     * that looks like the one that was asked for.
     *
     * **The behaviour is right and the surface is not.** `agentSessionsNote` is the Agent
     * sessions list's own line, and nothing on the Assets page or the goal list reads it,
     * so an operator arriving by URL is told nothing. Design D5 wants a sentence on the
     * page the link lands on; S5 owns moving it, and this assertion is here so that slice
     * can see what it is replacing.
     */
    const app = await landed(
      { kind: "chat", targetId: T, sessionId: "ses_1" },
      (fake) => {
        fake.onImporterSessions = () => ok({ sessions: [] });
      },
    );

    expect(app.importerOpen).toBe(false);
    expect(app.agentSessionsNote).not.toBe("");
    // Still on the target it named, which is the nearest place that does exist.
    expect(placeOf(app)).toEqual({ kind: "target", targetId: T });
  });

  test("an attempt reads the transcript, with the rail on Workers", async () => {
    // The path never says `workers`, because the resource being linked to is the attempt
    // (design decision 1). The rail has to be set by the replay instead.
    const app = await landed({
      kind: "attempt",
      targetId: T,
      attemptId: "attempt-7",
    });
    expect(app.navItem).toBe("workers");
    expect(app.transcriptAttemptId).toBe("attempt-7");
    expect(app.transcript).not.toBeUndefined();
    expect(placeOf(app)).toEqual({
      kind: "attempt",
      targetId: T,
      attemptId: "attempt-7",
    });
  });

  test("every place reads back as itself", async () => {
    /*
     * The state round-trip, which is the one that matters for the address bar: a place
     * replayed and then read back out of the state must be the place that was asked for,
     * or the URL will be rewritten to something else the moment the shell reflects it.
     *
     * Every row of the inventory, cold, from a fresh `App` each time. The target list is
     * the one exception — it needs no target and has its own test above.
     */
    for (const [, place] of INVENTORY) {
      if (place.kind === "targets") continue;
      const app = await landed(place);
      expect(placeOf(app)).toEqual(place);
    }
  });

  test("moving between targets re-opens the target", async () => {
    // `openTarget` is skipped for the target already open and must not be skipped for
    // another one: it is the only place `viewTargetId` moves, and it is what re-reads the
    // counts, the goals and the live feed for the target being arrived at.
    const app = await landed({
      kind: "section",
      targetId: T,
      section: "findings",
    });
    applyPlace(app, { kind: "target", targetId: "other-corp" });
    await settle();
    expect(app.viewTargetId).toBe("other-corp");
    expect(app.selectedId).toBe("other-corp");
    expect(app.navItem).toBe("goals");
  });

  test("a place reached from the target list opens the target", async () => {
    // `toAllTargets` leaves `viewTargetId` where it was, so "the same target" is not
    // enough to decide the target is open: the screen has to say so too.
    const app = await landed({
      kind: "section",
      targetId: T,
      section: "events",
    });
    applyPlace(app, { kind: "targets" });
    applyPlace(app, { kind: "section", targetId: T, section: "events" });
    await settle();
    expect(app.screen).toBe("target");
    expect(app.viewTargetId).toBe(T);
    expect(app.navItem).toBe("events");
  });
});
