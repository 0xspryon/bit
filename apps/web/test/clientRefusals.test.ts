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
  MESSAGE_FIELD,
  MESSAGE_FILES_FIELD,
  MessageUploadRefused,
  UploadedFileRefused,
} from "@bit/contracts";

import {
  NOT_REFUSALS,
  REFUSAL_TAGS,
  RequestNotSent,
  RequestTooLarge,
  server,
} from "../src/lib/client";

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

/**
 * Every request the stub was handed, as a `Request`, so a test can read the body it sent.
 *
 * Recorded **here** rather than by a second wrapper around `globalThis.fetch`: the note on
 * {@link handler} is the reason — `FetchHttpClient`'s `Fetch` is a `Context.Reference`
 * resolved on first use and then held, so a later reassignment is never seen. The upload
 * call is the only one whose body is not JSON, and its body is the thing worth asserting.
 */
let sent: Request[] = [];

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  sent.push(
    input instanceof Request ? input : new Request(url, init ?? undefined),
  );
  return handler(url);
}) as typeof globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every request with one status and one JSON body. */
const answering = (status: number, body: unknown): void => {
  asked = [];
  sent = [];
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
  sent = [];
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

describe("a message over the importer's limit, through the real client (U8 review 5)", () => {
  const long = "x".repeat(contracts.IMPORTER_MESSAGE_MAX_CHARS + 1);

  test("a later message is refused before any request, never Unreachable", async () => {
    answering(202, {});
    const call = await server.sendImporterMessage(
      BASE,
      "acme-corp",
      "imp_1",
      long,
    );
    // Nothing left the browser, so "whether it was sent is not known" would be false.
    expect(asked).toHaveLength(0);
    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(RequestNotSent);
    expect((call.error as RequestNotSent).detail).toContain(
      "This message is 32,001 characters; the limit is 32,000.",
    );
  });

  test("an opening message too", async () => {
    answering(202, {});
    const call = await server.openImporterConversation(BASE, "acme-corp", {
      text: long,
    });
    expect(asked).toHaveLength(0);
    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(RequestNotSent);
  });

  test("one at the limit is sent, so the check refuses only what the contract would", async () => {
    unreachable();
    const call = await server.sendImporterMessage(
      BASE,
      "acme-corp",
      "imp_1",
      "x".repeat(contracts.IMPORTER_MESSAGE_MAX_CHARS),
    );
    expect(asked).toHaveLength(1);
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

describe("a message's files, in the message's own request (A6 U13)", () => {
  const accepted = {
    targetId: "acme-corp",
    goalId: "goal_1",
    harnessSessionId: "ses_1",
    instanceId: "claude-code",
    providerId: "anthropic",
    modelId: "claude-haiku-4-5",
    conversation: "continued",
    priorUnavailable: false,
    note: "",
    acceptedAt: 0,
  };

  test("with files, a goal message goes out as multipart: its JSON under `message`, each file under `files`", async () => {
    answering(202, accepted);
    await server.sendGoalMessage(
      BASE,
      "acme-corp",
      "goal_1",
      "Read it.",
      undefined,
      [new File(["a scope letter"], "scope.pdf", { type: "application/pdf" })],
    );
    const seen = sent[0];
    expect(seen?.headers.get("content-type")).toContain("multipart/form-data");
    expect(seen?.headers.get("content-type")).toContain("boundary=");
    const form = await seen?.formData();
    expect(form?.get(MESSAGE_FIELD)).toBe(JSON.stringify({ text: "Read it." }));
    const file = form?.get(MESSAGE_FILES_FIELD);
    expect(file instanceof File ? file.name : undefined).toBe("scope.pdf");
  });

  test("without files it is the JSON it always was", async () => {
    answering(202, accepted);
    await server.sendGoalMessage(BASE, "acme-corp", "goal_1", "Hello.");
    expect(sent[0]?.headers.get("content-type")).toContain("application/json");
    expect(await sent[0]?.text()).toBe(JSON.stringify({ text: "Hello." }));
  });

  test("a refused file keeps the server's figures instead of becoming Unreachable", async () => {
    const detail =
      "'huge.png' is an image over 10485760 bytes (10.0 MiB), this server's cap per image, so reading it stopped there and nothing in that message was stored or sent.";
    answering(409, {
      _tag: "MessageUploadRefused",
      reason: "too_large",
      detail,
    });
    const call = await server.sendImporterMessage(
      BASE,
      "acme-corp",
      "imp_1",
      "Look.",
      undefined,
      [new File(["x"], "huge.png", { type: "image/png" })],
    );
    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(MessageUploadRefused);
    expect(call.error).toMatchObject({ detail });
  });

  test("the listener's empty 413 is a refusal in a sentence, naming what was sent", async () => {
    handler = () => Promise.resolve(new Response(null, { status: 413 }));
    const call = await server.openImporterConversation(
      BASE,
      "acme-corp",
      { text: "Read these." },
      [new File([new Uint8Array(3 * 1024 * 1024)], "big.bin")],
    );
    expect(call._tag).toBe("Refused");
    if (call._tag !== "Refused") return;
    expect(call.error).toBeInstanceOf(RequestTooLarge);
    const detail = (call.error as RequestTooLarge).detail;
    expect(detail).toContain("1 file (3.0 MiB together)");
    expect(detail).toContain("Nothing was stored");
  });

  test("a stored upload is fetched by its path, and a refusal of one is a refusal", async () => {
    handler = () =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    const ok = await server.uploadedFile(
      BASE,
      "acme-corp",
      "/h/a b/uploads/x.png",
    );
    const url = new URL(asked.at(-1) ?? "");
    expect(url.pathname).toBe("/api/v1/targets/acme-corp/uploads");
    expect(url.searchParams.get("path")).toBe("/h/a b/uploads/x.png");
    expect(ok._tag === "Ok" ? [...ok.value] : undefined).toEqual([1, 2, 3]);
    answering(404, {
      _tag: "UploadedFileRefused",
      reason: "not_an_upload",
      detail: "'/etc/passwd' is not inside a session's uploads folder",
    });
    const refusedCall = await server.uploadedFile(
      BASE,
      "acme-corp",
      "/etc/passwd",
    );
    expect(refusedCall._tag).toBe("Refused");
    if (refusedCall._tag !== "Refused") return;
    expect(refusedCall.error).toBeInstanceOf(UploadedFileRefused);
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
    expect(declared.length).toBeGreaterThanOrEqual(15);
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
