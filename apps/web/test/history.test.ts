/**
 * Back and Forward, as a history stack over a real `App` and no router.
 *
 * S4's criteria are about a *stack*: three targets and three Backs, Back out of a goal,
 * Forward returning, and nothing accumulating for a picker or a theme. None of those can be
 * seen in one write, so `placeHistory.test.ts` cannot show them and `place.test.ts` cannot
 * either. What they need is the route's composition — read the URL on a traversal, apply the
 * place, reflect the place back — run against the state machine the places are made of.
 *
 * **The route is not mounted, for the reason `deepLink.test.ts` gives**: mounting
 * `routes/[...place]/+page.svelte` needs a DOM and `$app/navigation`, and none of the
 * arithmetic worth asserting is in the mounting. So {@link tab} below is the route's three
 * rules written out in twenty lines, against a `FakeHistory` that counts entries the way
 * `history.length` does in a browser. The browser run is what proves the rules are wired to
 * the real `popstate` and the real `goto`; this is what proves the rules are right.
 *
 * **Every test owns its own `App` and its own double**, the convention `app.test.ts`
 * records.
 */
import { describe, expect, test } from "bun:test";

import { App } from "../src/lib/app.svelte";
import { placeArrivedAt } from "../src/lib/arrival";
import { applyPlace, pathOf, placeOf } from "../src/lib/place";
import { historyWrite } from "../src/lib/placeHistory";
import { FakeCountdown } from "./fakeCountdown";
import {
  FakeServer,
  attemptTranscript,
  goalView,
  importerSessionView,
  ok,
  targetSummary,
} from "./fakeServer";

/** Lets everything already in flight finish. The `App` methods are fire-and-forget. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The browser's session history, as much of it as a URL-only app can observe.
 *
 * `entries` and `index` are what `history.length` and the Back button are made of: a push
 * truncates everything ahead of the cursor and appends, a replace overwrites in place, and a
 * traversal moves the cursor without changing the list. That truncation is why push versus
 * replace is worth getting right — a junk entry does not merely add noise, it destroys the
 * Forward the operator was about to use.
 */
class FakeHistory {
  entries: string[];
  index = 0;

  constructor(href: string) {
    this.entries = [href];
  }

  get length(): number {
    return this.entries.length;
  }

  /** What the address bar holds, which is what the route's reader and writer both consult. */
  get here(): string {
    return this.entries[this.index] ?? "";
  }

  get address(): { pathname: string; search: string } {
    const [pathname = "", query = ""] = this.here.split("?");
    return { pathname, search: query === "" ? "" : `?${query}` };
  }

  push(href: string) {
    this.entries = [...this.entries.slice(0, this.index + 1), href];
    this.index = this.entries.length - 1;
  }

  replace(href: string) {
    this.entries[this.index] = href;
  }
}

/**
 * One tab: an `App`, its history, and the three rules the route composes over them.
 *
 * `reflect` is the route's writer, `traverse` is its `popstate` reader, and `applying` is
 * the suppression between them — written out here rather than mocked, because the thing
 * under test is that those three fit together.
 */
const tab = (app: App, href: string) => {
  const history = new FakeHistory(href);
  let applying = 0;

  const reflect = () => {
    if (applying > 0) return;
    const next = pathOf(placeOf(app));
    const write = historyWrite(history.address, next);
    if (write === "skip") return;
    if (write === "push") history.push(next);
    else history.replace(next);
  };

  /**
   * The operator doing something: the state moves, and the writer runs on each flush.
   *
   * Twice, because a Svelte effect runs after the synchronous handler and again after any
   * state the reads behind it land on. A rule that only held at rest would pass a single
   * call and leave entries behind in a browser.
   */
  const act = async (move: () => void) => {
    move();
    reflect();
    await settle();
    reflect();
  };

  /** The browser traversing, and the route reading the entry it landed on. */
  const traverse = async (step: number) => {
    history.index += step;
    const place = placeArrivedAt(
      history.address.pathname,
      history.address.search,
    );
    applying += 1;
    const applied = applyPlace(app, place);
    // The suppressed window: a place reached across a round trip stands on the page above
    // itself for the duration, and writing that page is what would cost an entry.
    reflect();
    await applied;
    await settle();
    applying -= 1;
    reflect();
  };

  return { history, reflect, act, traverse };
};

const served = (arrange: (fake: FakeServer) => void = () => {}): FakeServer => {
  const fake = new FakeServer();
  fake.onTargets = () =>
    ok([
      targetSummary({ id: "alpha", name: "alpha" }),
      targetSummary({ id: "bravo", name: "bravo" }),
      targetSummary({ id: "charlie", name: "charlie" }),
    ]);
  fake.onGoals = () =>
    ok({
      goals: [
        goalView({ goalId: "goal_1", targetId: "alpha" }),
        goalView({ goalId: "goal_2", targetId: "alpha" }),
      ],
    });
  fake.onImporterSessions = () =>
    ok({ sessions: [importerSessionView({ sessionId: "ses_1" })] });
  arrange(fake);
  return fake;
};

/** A tab that is signed in and sitting on the target list, which is where `/` lands. */
const signedIn = async (
  fake: FakeServer = served(),
): Promise<ReturnType<typeof tab> & { app: App }> => {
  const app = new App(fake, new FakeCountdown());
  const shell = tab(app, "/");
  app.password = "correct-horse";
  await app.connect();
  await settle();
  shell.reflect();
  return { ...shell, app };
};

describe("three targets and three Backs", () => {
  test("walks back through them, one entry each", async () => {
    const { app, history, act, traverse } = await signedIn();

    await act(() => {
      app.openTarget("alpha");
    });
    await act(() => {
      app.openTarget("bravo");
    });
    await act(() => {
      app.openTarget("charlie");
    });

    // Four entries: the list the tab was opened on, then one per target. Three opens,
    // three entries — not six, which is what a reflection that pushed on every flush
    // would leave, and not one, which is what S2's unconditional replace left.
    expect(history.entries).toEqual([
      "/",
      "/t/alpha",
      "/t/bravo",
      "/t/charlie",
    ]);

    await traverse(-1);
    expect(app.viewTargetId).toBe("bravo");
    expect(history.here).toBe("/t/bravo");

    await traverse(-1);
    expect(app.viewTargetId).toBe("alpha");
    expect(history.here).toBe("/t/alpha");

    await traverse(-1);
    expect(app.screen).toBe("welcome");
    expect(history.here).toBe("/");

    // Nothing was written on the way back: every traversal ended with the address bar
    // already holding the place, so the writer had nothing to do.
    expect(history.length).toBe(4);
  });

  test("and Forward returns to where Back came from", async () => {
    const { app, history, act, traverse } = await signedIn();
    await act(() => {
      app.openTarget("alpha");
    });
    await act(() => {
      app.openTarget("bravo");
    });

    await traverse(-1);
    expect(app.viewTargetId).toBe("alpha");
    await traverse(+1);

    expect(app.viewTargetId).toBe("bravo");
    expect(history.here).toBe("/t/bravo");
    expect(history.length).toBe(3);
  });
});

describe("a goal", () => {
  test("Back out of it lands on the goal list, not on the previous target", async () => {
    /*
     * The criterion that distinguishes a place from a target. `/t/alpha/goals/goal_1` is a
     * record inside `/t/alpha`, so the entry below it is the target's own page — which is
     * only true if opening the goal pushed rather than replaced.
     */
    const { app, history, act, traverse } = await signedIn();
    await act(() => {
      app.openTarget("alpha");
    });
    await act(() => {
      app.openGoal("goal_1");
    });

    expect(history.entries).toEqual(["/", "/t/alpha", "/t/alpha/goals/goal_1"]);

    await traverse(-1);

    expect(app.openGoalId).toBe("");
    expect(app.navItem).toBe("goals");
    expect(app.viewTargetId).toBe("alpha");
    expect(history.here).toBe("/t/alpha");

    await traverse(+1);
    expect(app.openGoalId).toBe("goal_1");
    expect(history.here).toBe("/t/alpha/goals/goal_1");
    expect(history.length).toBe(3);
  });
});

describe("what is not a place", () => {
  test("leaves no entry: a picker, the theme, the rail, the dock", async () => {
    /*
     * None of these is in the URL at all (design D1), so none of them can change what
     * `placeOf` returns and none of them reaches the writer. The assertion is on the stack
     * rather than on the rule, because that is the criterion the operator stated.
     */
    const { app, history, act } = await signedIn();
    await act(() => {
      app.openTarget("alpha");
    });
    const before = [...history.entries];

    await act(() => {
      app.theme = app.theme === "dark" ? "light" : "dark";
    });
    await act(() => {
      app.drawerHidden = true;
    });
    await act(() => {
      app.detailOpen = true;
    });
    await act(() => {
      app.liveExpanded = !app.liveExpanded;
    });

    expect(history.entries).toEqual(before);
  });

  test("and the estate filter replaces, because it is a view and not a page", async () => {
    // The one view modifier that is in the URL (decision 2) is in the query, so switching
    // it corrects the entry rather than adding one — and Back from a filtered estate leaves
    // the Assets page altogether rather than stepping through four filters.
    const { app, history, act, traverse } = await signedIn();
    await act(() => {
      app.openTarget("alpha");
    });
    await act(() => {
      app.toSection("assets");
    });
    await act(() => {
      app.estateFilter = "uncovered";
    });
    await act(() => {
      app.estateFilter = "in";
    });

    expect(history.entries).toEqual([
      "/",
      "/t/alpha",
      "/t/alpha/assets/estate?filter=in",
    ]);

    await traverse(-1);
    expect(app.navItem).toBe("goals");
    expect(history.length).toBe(3);
  });
});

describe("a place that is reached across a round trip", () => {
  test("Back onto a chat costs no entry, because nothing is written on the way", async () => {
    /*
     * The hazard S4 had to close. `applyPlace` reaches a chat through
     * `openImporterSession`, which reads the importer's index before it can enter the
     * Assets section — so for the length of that read the app is on the target's Goals
     * page while the address bar says `assets/chat/ses_1`. Reflecting that page was an
     * invisible flicker while every write replaced; with a push it would be a junk entry,
     * and a second one when the chat finally lands. The suppression is what makes it
     * neither.
     */
    const { app, history, act, traverse } = await signedIn();
    await act(() => {
      app.openTarget("alpha");
    });
    await act(() => {
      void app.openImporterSession("ses_1");
    });

    expect(history.entries).toEqual([
      "/",
      "/t/alpha",
      "/t/alpha/assets/chat/ses_1",
    ]);

    await act(() => {
      app.toSection("findings");
    });
    expect(history.length).toBe(4);

    // Back onto the chat: one traversal, no new entry, and Forward still has somewhere to
    // go because nothing truncated the stack.
    await traverse(-1);

    expect(history.here).toBe("/t/alpha/assets/chat/ses_1");
    expect(history.length).toBe(4);
    expect(history.index).toBe(2);
    expect(app.navItem).toBe("assets");
    expect(app.importerOpen).toBe(true);
    expect(pathOf(placeOf(app))).toBe("/t/alpha/assets/chat/ses_1");
  });
});

describe("a section entry with a transcript read behind it", () => {
  test("Back passes through /t/<id>/workers instead of bouncing off it", async () => {
    /*
     * The regression guard for the defect S4 found. `transcriptAttemptId` used to be
     * cleared only by `reset()`, and `placeOf` reads the pair `navItem === "workers" &&
     * transcriptAttemptId !== ""` — so once a transcript had been read, *every* arrival on
     * Workers answered with the attempt. Traversing onto a plain `/t/alpha/workers` entry
     * applied the section, `placeOf` returned the stale attempt, and the reflection pushed
     * the attempt path straight back: Back could not pass that entry, in either direction,
     * for the rest of the visit.
     *
     * `toSection` now closes the transcript, as it already closed an open goal. The stack
     * below is built with a direct `loadTranscript` because that is the minimal way to
     * reach the state; in the app it arrives by reading a transcript on Goals — which
     * changes no place and so writes nothing — and then choosing Workers.
     */
    const { app, history, act, traverse } = await signedIn(
      served((fake) => {
        fake.onTranscript = () => ok(attemptTranscript({ targetId: "alpha" }));
      }),
    );
    await act(() => {
      app.openTarget("alpha");
    });
    await act(() => {
      app.toSection("workers");
    });
    await act(() => {
      void app.loadTranscript("alpha", "att_7");
    });

    expect(history.entries).toEqual([
      "/",
      "/t/alpha",
      "/t/alpha/workers",
      "/t/alpha/attempts/att_7",
    ]);

    await traverse(-1);

    // The entry is reached and stays reached: no attempt in hand, so no attempt in the URL.
    expect(history.here).toBe("/t/alpha/workers");
    expect(history.index).toBe(2);
    expect(history.length).toBe(4);
    expect(app.transcriptAttemptId).toBe("");

    // And Back goes on working, which is the whole point.
    await traverse(-1);
    expect(history.here).toBe("/t/alpha");
    expect(history.length).toBe(4);

    // Forward still reads the transcript the path names, so nothing was lost by closing it.
    await traverse(+2);
    expect(history.here).toBe("/t/alpha/attempts/att_7");
    expect(app.transcriptAttemptId).toBe("att_7");
  });
});

describe("the link the shell used to write", () => {
  test("is tidied in place, so Back cannot land on it again", async () => {
    /*
     * An old `?target=` bookmark is translated once on arrival, and the first reflection
     * writes the path form. That write must replace: pushing would leave the legacy URL
     * one Back away, and walking back to it would open the same target and push again —
     * a Back button that does not go back.
     */
    const app = new App(served(), new FakeCountdown());
    const { history, act } = tab(app, "/?target=alpha");
    const place = placeArrivedAt("/", "?target=alpha");
    app.requestPlace("alpha", pathOf(place));

    app.password = "correct-horse";
    await app.connect();
    await settle();
    await act(() => {
      void applyPlace(app, placeArrivedAt("/", "?target=alpha"));
      app.takeReplayPath();
    });

    expect(history.entries).toEqual(["/t/alpha"]);
  });
});
