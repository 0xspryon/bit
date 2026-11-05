/**
 * D4's granularity, as a decision about one write.
 *
 * "Opening a resource pushes a history entry; everything else replaces" is a sentence about
 * meaning, and `placeHistory.ts` is where it becomes `replace: boolean`. The rule it lands
 * on — a change of *path* pushes, a change of query or of spelling replaces — is testable
 * without a DOM, a router or an `App`, which is why it is a module of its own rather than an
 * expression inside the route's effect.
 *
 * `history.test.ts` is the other half: this file pins the decision for one write, that one
 * composes the writes into a history stack and walks it.
 */
import { describe, expect, test } from "bun:test";

import { historyWrite } from "../src/lib/placeHistory";

const at = (pathname: string, search = "") => ({ pathname, search });

describe("a write that would change nothing", () => {
  test("is skipped, which is what keeps the reflection from looping", () => {
    /*
     * The structural half of the loop defence. Reading the URL on a traversal, applying it
     * to the state and reflecting the state back is a cycle on paper; it has no first step
     * because by the time the reflection runs the address bar already holds the place, and
     * every path this grammar emits is one `parsePath`/`pathOf` round trip from itself.
     */
    expect(historyWrite(at("/"), "/")).toBe("skip");
    expect(historyWrite(at("/t/acme-corp"), "/t/acme-corp")).toBe("skip");
    expect(
      historyWrite(
        at("/t/acme-corp/assets/estate", "?filter=uncovered"),
        "/t/acme-corp/assets/estate?filter=uncovered",
      ),
    ).toBe("skip");
    expect(
      historyWrite(
        at("/t/acme-corp/assets/chat/ses_1"),
        "/t/acme-corp/assets/chat/ses_1",
      ),
    ).toBe("skip");
  });
});

describe("opening a resource", () => {
  test("pushes, for every segment of the path the place lives in", () => {
    // One case per row of the design's inventory that an operator can reach by clicking:
    // the target, the section, the assets tab, the goal, the chat. Each is a thing you may
    // want to come back from, which is the whole test D4 applies.
    expect(historyWrite(at("/"), "/t/acme-corp")).toBe("push");
    expect(historyWrite(at("/t/acme-corp"), "/t/acme-corp/findings")).toBe(
      "push",
    );
    expect(historyWrite(at("/t/acme-corp"), "/t/scratch")).toBe("push");
    expect(
      historyWrite(
        at("/t/acme-corp/assets/estate"),
        "/t/acme-corp/assets/scope",
      ),
    ).toBe("push");
    expect(historyWrite(at("/t/acme-corp"), "/t/acme-corp/goals/goal_1")).toBe(
      "push",
    );
    expect(
      historyWrite(
        at("/t/acme-corp/goals/goal_1"),
        "/t/acme-corp/goals/goal_2",
      ),
    ).toBe("push");
    expect(
      historyWrite(
        at("/t/acme-corp/agent-sessions"),
        "/t/acme-corp/assets/chat/ses_1",
      ),
    ).toBe("push");
    expect(
      historyWrite(at("/t/acme-corp"), "/t/acme-corp/attempts/att_1"),
    ).toBe("push");
  });

  test("pushes on the way back out to the list, which is a resource too", () => {
    // The target list is the root of the inventory, so leaving a target for it is opening
    // something rather than rearranging a page — and Back from the list returns to the
    // target, which is what makes the crumb's "All targets" undoable.
    expect(historyWrite(at("/t/acme-corp/goals/goal_1"), "/")).toBe("push");
  });
});

describe("a view of the page you are already on", () => {
  test("replaces, because only the query moves", () => {
    /*
     * Design decision 2 put the estate filter in the URL and D2 put it in the *query*,
     * precisely because it is a way of looking at a page rather than a page. So the
     * push/replace split is not a second rule over the grammar: it is the path/query split
     * already in it.
     */
    expect(
      historyWrite(
        at("/t/acme-corp/assets/estate"),
        "/t/acme-corp/assets/estate?filter=uncovered",
      ),
    ).toBe("replace");
    expect(
      historyWrite(
        at("/t/acme-corp/assets/estate", "?filter=uncovered"),
        "/t/acme-corp/assets/estate?filter=in",
      ),
    ).toBe("replace");
    expect(
      historyWrite(
        at("/t/acme-corp/assets/estate", "?filter=uncovered"),
        "/t/acme-corp/assets/estate",
      ),
    ).toBe("replace");
  });
});

describe("the same place under another name", () => {
  test("replaces, so tidying a URL is not somewhere to go back to", () => {
    /*
     * The grammar accepts more than it emits. `/t/acme-corp/goals` is the goal list and so
     * is `/t/acme-corp`; `?target=` is the link the shell wrote before there were paths.
     * Pushing for either would leave an entry whose Back lands on the same page under its
     * old spelling — and with a saved `?target=` bookmark, one such entry per attempt to
     * leave it.
     */
    expect(historyWrite(at("/t/acme-corp/goals"), "/t/acme-corp")).toBe(
      "replace",
    );
    expect(historyWrite(at("/", "?target=acme-corp"), "/t/acme-corp")).toBe(
      "replace",
    );
    expect(historyWrite(at("/t/acme-corp/"), "/t/acme-corp")).toBe("replace");
    expect(historyWrite(at("//t//acme-corp"), "/t/acme-corp")).toBe("replace");
    expect(
      historyWrite(at("/t/acme-corp/assets"), "/t/acme-corp/assets/estate"),
    ).toBe("replace");
  });

  test("replaces when the spelling named nowhere at all", () => {
    // A URL that parses to the target list is already the target list, so writing `/` over
    // it corrects the text and moves nobody. S2 left the address bar being tidied here;
    // what S4 adds is that the tidying is not a history entry.
    expect(historyWrite(at("/nonsense/and/more"), "/")).toBe("replace");
    expect(historyWrite(at("/t"), "/")).toBe("replace");
  });
});

describe("an arrival that fell back", () => {
  test("replaces, whatever the two paths say about each other", () => {
    /*
     * Design D5's history rule. Every one of these would push under the rule above — a
     * fallback lands on a *container* of the place the link named, which is a different
     * path by construction — and pushing is wrong for all three. The entry the operator is
     * standing on names nothing, so leaving it behind leaves a trap; and going Back onto it
     * applies it, falls back again, and pushes again, which is a Back button that cannot
     * leave the page.
     */
    expect(historyWrite(at("/t/acme-corp"), "/", "fell-back")).toBe("replace");
    expect(
      historyWrite(
        at("/t/acme-corp/goals/goal_9"),
        "/t/acme-corp",
        "fell-back",
      ),
    ).toBe("replace");
    expect(
      historyWrite(
        at("/t/acme-corp/assets/chat/ses_9"),
        "/t/acme-corp/agent-sessions",
        "fell-back",
      ),
    ).toBe("replace");
  });

  test("still skips a write that would change nothing", () => {
    // The skip stays first, because it is what keeps the apply-then-reflect cycle from
    // having a first step. A fallback that happens to land on the address already in the
    // bar — a stale row clicked from the very list it falls back to — is not a correction
    // of anything.
    expect(
      historyWrite(
        at("/t/acme-corp/agent-sessions"),
        "/t/acme-corp/agent-sessions",
        "fell-back",
      ),
    ).toBe("skip");
  });

  test("and a landing is the ordinary rule, which is the default", () => {
    // Stated so the default is pinned: an omitted third argument must mean "landed", so a
    // caller that forgets it spends a history entry rather than silently eating one.
    expect(historyWrite(at("/"), "/t/acme-corp", "landed")).toBe("push");
    expect(historyWrite(at("/"), "/t/acme-corp")).toBe("push");
  });
});

describe("the importer's empty session becoming a session (U8)", () => {
  test("renames the entry, so Back does not land on a blank thread already written in", () => {
    const chat = "/t/acme/assets/chat/ses_9";
    expect(historyWrite(at("/t/acme/assets/chat"), chat, "landed", chat)).toBe(
      "replace",
    );
    // Without that hint it is opening a resource, like any other.
    expect(historyWrite(at("/t/acme/assets/chat"), chat)).toBe("push");
    // Another session opened from the empty one pushes: it is not the one it became.
    expect(
      historyWrite(
        at("/t/acme/assets/chat"),
        "/t/acme/assets/chat/ses_old",
        "landed",
        chat,
      ),
    ).toBe("push");
    // And "Start a new session" from a session pushes the empty one's place.
    expect(historyWrite(at(chat), "/t/acme/assets/chat", "landed", chat)).toBe(
      "push",
    );
  });
});
