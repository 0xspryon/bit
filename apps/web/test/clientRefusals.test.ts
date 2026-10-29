/**
 * How `client.ts` sorts a server's answer from transport trouble, against a stubbed `fetch`.
 *
 * **This is the one thing `FakeServer` cannot cover, and the gap was not theoretical.**
 * The double in `fakeServer.ts` *implements* `ServerClient`, so every test in
 * `app.test.ts` hands the app a `{_tag: "Refused", error}` that has already been
 * classified. The classification itself lives in `client.ts` — `REFUSAL_TAGS` plus
 * `isRefusal` — and it is an **allow-list**, so a tag nobody added is not a compile error:
 * it is a well-formed typed refusal silently reported to the operator as "No server
 * answered at this address". That is exactly what happened to `GoalBriefingRefused`, while
 * an `app.test.ts` test asserting the over-the-ceiling panel state passed.
 *
 * So these tests go through the real client, over a `fetch` that returns the bytes the
 * server returns. Nothing here asserts app state; `app.test.ts` owns that half, and the
 * two halves together are what the single half could not say.
 *
 * `globalThis.fetch` is the seam because it is the only one: `client.ts` builds
 * `FetchHttpClient.layer` internally and deliberately exposes no way to inject a
 * transport, since a client whose transport a caller could swap would not be the thing the
 * screens use.
 */
import { afterAll, describe, expect, test } from "bun:test";

import * as contracts from "@bit/contracts";
import {
  GoalBriefingRefused,
  GoalNotFound,
  IntentNotFound,
  IntentRefused,
} from "@bit/contracts";

import { NOT_REFUSALS, REFUSAL_TAGS, server } from "../src/lib/client";

const BASE = "http://127.0.0.1:65530";

const originalFetch = globalThis.fetch;

/**
 * What the next request should get, swapped per test.
 *
 * **One stub installed once, not one per test, and that is not a style choice.**
 * `FetchHttpClient`'s `Fetch` is a `Context.Reference` whose default is `globalThis.fetch`
 * resolved on first use and then held, so a second assignment to `globalThis.fetch` is
 * never seen: reassigning it per test silently served every later test the first test's
 * response. The indirection is what makes each test's answer its own.
 */
let handler: (url: string) => Promise<Response> = () =>
  Promise.reject(new Error("no handler installed"));

/** Every URL the stub was asked for, so a test can say the request was really made. */
let asked: string[] = [];

globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  return handler(url);
}) as typeof globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every request with one status and one JSON body. */
const answering = (status: number, body: unknown): void => {
  asked = [];
  handler = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
};

/** Answers every request by failing the way an unreachable server does. */
const unreachable = (): void => {
  asked = [];
  handler = () => Promise.reject(new TypeError("Unable to connect"));
};

describe("a goal briefing over the ceiling, through the real client", () => {
  const OVER = {
    _tag: "GoalBriefingRefused",
    reason: "too_large",
    goalId: "goal_1",
    sizeChars: 329_342,
    maxChars: 320_000,
    detail:
      "This goal's briefing renders to 329342 characters, over the 320000-character ceiling, so none was built.",
  };

  test("a 409 is a Refused carrying both numbers, not an Unreachable", async () => {
    answering(409, OVER);

    const call = await server.goalBriefing(BASE, "acme-corp", "goal_1");

    // The request was actually made, so a passing assertion below cannot be a stub that
    // was never reached.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("/targets/acme-corp/goals/goal_1/briefing");

    // The whole point: this used to be `Unreachable`, and the panel said so.
    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(GoalBriefingRefused);
    expect(call.error).toMatchObject({
      _tag: "GoalBriefingRefused",
      reason: "too_large",
      goalId: "goal_1",
      sizeChars: 329_342,
      maxChars: 320_000,
    });
    // Decoded as numbers, not as whatever JSON happened to hold, so the panel can format
    // them rather than print the sentence twice.
    if (call.error._tag !== "GoalBriefingRefused") return;
    expect(typeof call.error.sizeChars).toBe("number");
    expect(call.error.detail).toContain("329342");
  });

  test("a goal this target does not hold is also a Refused", async () => {
    // The sibling tag, so the briefing route's *other* typed refusal is covered by the
    // same mechanism rather than only by the app-state test.
    answering(404, {
      _tag: "GoalNotFound",
      targetId: "acme-corp",
      goalId: "goal_1",
      detail: "no goal 'goal_1' is recorded in this target",
    });

    const call = await server.goalBriefing(BASE, "acme-corp", "goal_1");

    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(GoalNotFound);
  });

  test("a server that does not answer is Unreachable, so the two are really distinguished", async () => {
    unreachable();

    const call = await server.goalBriefing(BASE, "acme-corp", "goal_1");

    expect(asked).toHaveLength(1);
    expect(call._tag).toBe("Unreachable");
    if (call._tag !== "Unreachable") return;
    // Whatever the transport said, kept for the console. It is `HttpClient`'s own sentence
    // rather than the `TypeError`'s, which is why the app prints its own words instead.
    expect(call.detail).toContain("Transport error");
    expect(call.detail).toContain("/goals/goal_1/briefing");
  });

  test("a tag the client does not know stays Unreachable, which is what the allow-list does", async () => {
    // Not a defect to fix: it is the mechanism, stated so the next person adding a typed
    // error to a route sees what forgetting `REFUSAL_TAGS` costs. A refusal the client
    // has never heard of is indistinguishable, from here, from a server answering with
    // something it should not.
    answering(409, {
      _tag: "SomeRefusalNobodyRegistered",
      detail: "a sentence the panel will never show",
    });

    const call = await server.goalBriefing(BASE, "acme-corp", "goal_1");

    expect(call._tag).toBe("Unreachable");
  });
});

describe("the intent refusals, which were missing for the same reason", () => {
  // Found by the investigation that found `GoalBriefingRefused` and fixed in the same
  // round: both were already on `main`, so an operator adding an intent against a bad
  // anchor, or abandoning one a run holds, got "No server answered at this address"
  // instead of the sentence the store wrote to teach them what to do.

  test("a refused intent carries the store's instructive sentence, not a connectivity complaint", async () => {
    const detail =
      "anchor 'intent-4' is an intent, not an observation; anchor to the observation it recorded, or give no anchor for a new top-level direction";
    answering(409, { _tag: "IntentRefused", reason: "invalid", detail });

    const call = await server.createIntent(BASE, "acme-corp", "goal_1", {
      question: "Does the limiter reset on a new window?",
      anchorObservationIds: ["intent-4"],
      addressesDimension: null,
    });

    expect(asked).toHaveLength(1);
    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(IntentRefused);
    // The whole value of the tag being here: the app reads `detail` and shows it as
    // written, so the instruction survives.
    expect(call.error).toMatchObject({ _tag: "IntentRefused", detail });
  });

  test("an intent this target does not hold is a Refused, not an Unreachable", async () => {
    answering(404, {
      _tag: "IntentNotFound",
      targetId: "acme-corp",
      intentId: "intent-9",
      detail: "no intent 'intent-9' is recorded in this target",
    });

    const call = await server.abandonIntent(BASE, "acme-corp", "intent-9", {
      reason: "",
    });

    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(IntentNotFound);
  });
});

/**
 * Every tagged error the contract declares is accounted for, by name.
 *
 * **This is the test that stops the class recurring.** The three tags that were missing
 * were each a one-line omission from an allow-list, invisible to the compiler and visible
 * only to an operator who happened to hit that refusal in a browser. The individual tests
 * above pin the ones somebody thought to write; this one pins the ones nobody did.
 *
 * The declared set is read out of the contract rather than restated here, which is the
 * point — a tag listed in a test is the same hand-maintained list one level up. An error
 * type added to `api.ts` tomorrow appears here with no edit to this file.
 */
describe("every declared error tag is accounted for", () => {
  /**
   * The `_tag` of every tagged error the contract exports.
   *
   * Two filters, and both are needed. Testing the prototype against `Error` keeps the
   * tagged *errors* and drops the tagged data unions — `LiveItem`, `CaseBasedObservation`
   * and the rest carry a literal `_tag` too and are not refusals of anything. The literal
   * is then
   * read from the schema's own AST rather than from the export's name, so a class whose
   * exported name and wire tag ever diverge is reported under the tag that actually
   * travels.
   */
  const declaredErrorTags = (): readonly string[] => {
    const found: string[] = [];
    for (const exported of Object.values(contracts)) {
      if (typeof exported !== "function") continue;
      // `prototype instanceof Error` rather than `Error.prototype.isPrototypeOf`: the
      // same question, and ESLint's `no-prototype-builtins` rightly objects to reaching
      // through `Object.prototype` on a value of unknown shape.
      const prototype = (exported as { prototype?: unknown }).prototype;
      if (!(prototype instanceof Error)) continue;
      const fields = (exported as { fields?: Record<string, unknown> }).fields;
      const tagField = fields?.["_tag"] as
        | {
            readonly ast?: {
              readonly _tag?: string;
              readonly literal?: unknown;
            };
          }
        | undefined;
      if (tagField?.ast?._tag !== "Literal") continue;
      if (typeof tagField.ast.literal !== "string") continue;
      found.push(tagField.ast.literal);
    }
    return found.sort();
  };

  test("the contract really does export tagged errors, so the enumeration is not vacuous", () => {
    const declared = declaredErrorTags();
    // A guard on the guard: if `Schema.TaggedError`'s runtime shape ever changes, this
    // enumeration could quietly return nothing and every assertion below would pass.
    expect(declared.length).toBeGreaterThanOrEqual(14);
    expect(declared).toContain("GoalBriefingRefused");
    expect(declared).toContain("IntentRefused");
    expect(declared).toContain("Unauthenticated");
  });

  test("each is either a refusal or a named exclusion with a reason", () => {
    const unaccounted = declaredErrorTags().filter(
      (tag) => !REFUSAL_TAGS.has(tag) && NOT_REFUSALS[tag] === undefined,
    );
    // The failure message is the instruction: a tag arriving here has two homes and the
    // next person should not have to work out which.
    expect(unaccounted).toEqual([]);
  });

  test("nothing in either list is stale, so a renamed error is caught too", () => {
    const declared = new Set(declaredErrorTags());
    expect([...REFUSAL_TAGS].filter((tag) => !declared.has(tag))).toEqual([]);
    expect(
      Object.keys(NOT_REFUSALS).filter((tag) => !declared.has(tag)),
    ).toEqual([]);
  });

  test("the two lists are disjoint, so no tag is both an answer and not one", () => {
    expect(
      Object.keys(NOT_REFUSALS).filter((tag) => REFUSAL_TAGS.has(tag)),
    ).toEqual([]);
  });

  test("nothing is excluded today, and every exclusion must carry a reason", () => {
    // An empty map is the checkable form of "every error the contract declares is an
    // answer a screen shows". The second assertion is what a future entry has to satisfy.
    expect(Object.keys(NOT_REFUSALS)).toEqual([]);
    for (const [tag, reason] of Object.entries(NOT_REFUSALS)) {
      expect(
        reason.length,
        `${tag} is excluded with no reason given`,
      ).toBeGreaterThan(20);
    }
  });
});
