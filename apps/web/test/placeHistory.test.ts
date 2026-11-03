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
