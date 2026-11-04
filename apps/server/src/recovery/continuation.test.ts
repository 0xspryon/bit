/**
 * The four decisions a restart continuation is made of (S7.4), each on its own.
 *
 * They are tested apart from the dispatcher because each one is a *rule* rather than a
 * step: which harness answers mean work was interrupted, what the dead attempt's
 * transcript is reduced to, how often one chain may be continued, and whether the operator
 * has switched the whole thing off. `continuationDispatcher.test.ts` then checks the order
 * they are applied in, against a real database.
 *
 * The settings half runs against a real `control.sqlite`, for the reason every persistence
 * test in this repository does: nothing checks a SQL identifier at compile time, and "an
 * unreadable setting means no continuation" is a claim about what a decode does to a value
 * that came back out of a file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import { STUB_INSTANCE, stubHarness } from "../harness/stubHarness";
import { FleetStore } from "../persistence/fleet";
import {
  CONTINUATION_CHAIN_MAX,
  CONTINUATION_CHAIN_WINDOW,
  CONTINUATION_SETTING,
  CONTINUATION_SUMMARY_MAX,
  attemptContinuationNote,
  chainKeyFor,
  continuationAllowed,
  continuationMessage,
  continuationSettingFor,
  continuationTrigger,
  decodeContinuationRequest,
  readTranscriptSummary,
  summariseTranscript,
} from "./continuation";
import type { HarnessObservedStatus } from "./harnessStatus";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

const newRoot = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "bit-continuation-"));
  directories.push(directory);
  return join(directory, "fleet");
};

const TARGET = "target-1";

/* ── The trigger ─────────────────────────────────────────────────────────────── */

describe("when a continuation is owed at all", () => {
  /**
   * The one answer that means a turn was cut off, and S7's first half is what produces it:
   * the harness knows the session, nothing is running it, and no outcome was ever recorded.
   */
  test("only `abandoned` is owed one", () => {
    expect(continuationTrigger("abandoned", "…")._tag).toBe("owed");
    const others: readonly HarnessObservedStatus[] = [
      "running",
      "succeeded",
      "failed",
      "interrupted",
      "unbound",
      "missing",
      "unreachable",
    ];
    for (const observed of others) {
      expect(continuationTrigger(observed, "…")._tag).toBe("none");
    }
  });

  /**
   * The two refusals most worth having a sentence of their own, because both look
   * continuable from a distance.
   *
   * `unreachable` is the "never resume on a guess" case: the work may be running somewhere
   * we cannot see. A stated outcome is the opposite case: the turn finished, so continuing
   * would be this server starting work nobody asked for.
   */
  test("the sentence says which kind of 'no' it is, and carries what the harness said", () => {
    const unasked = continuationTrigger("unreachable", "the port was closed");
    expect(unasked.detail).toContain("nothing is continued on a guess");
    expect(unasked.detail).toContain("the port was closed");

    const finished = continuationTrigger(
      "succeeded",
      "it reported 'succeeded'",
    );
    expect(finished.detail).toContain("nothing to carry on");
    expect(finished.detail).toContain("it reported 'succeeded'");
  });

  /** The chain the cap counts is the thing that survives being continued. */
  test("a chain key is the intent for an attempt, the goal for a goal, the target for an import", () => {
    expect(
      chainKeyFor(
        { kind: "attempt", attemptId: "ats_2", intentId: "int_1" },
        TARGET,
      ),
    ).toBe("intent:int_1");
    expect(chainKeyFor({ kind: "goal", goalId: "goal_1" }, TARGET)).toBe(
      "goal:goal_1",
    );
    // An import id names one authority period and the session id changes when a resume
    // fails, so neither is a chain. The target is, and the cost is recorded on `chainKeyFor`.
    expect(chainKeyFor({ kind: "importer", importId: "imp_9" }, TARGET)).toBe(
      `importer:${TARGET}`,
    );
  });
});

/* ── The bound ───────────────────────────────────────────────────────────────── */

describe("the bound", () => {
  /**
   * T3 Code's numbers, taken rather than invented (S7.4). Asserted because they are the
   * difference between surviving one restart and paying for a crash loop all night, and a
   * change to either should have to be a deliberate edit to a test.
   */
  test("is three continuations in five minutes", () => {
    expect(CONTINUATION_CHAIN_MAX).toBe(3);
    expect(CONTINUATION_CHAIN_WINDOW).toBe(5 * 60 * 1000);
  });
});

/* ── The summary ─────────────────────────────────────────────────────────────── */

describe("the summary of a dead attempt's transcript", () => {
  const entry = (type: string, text: string, error?: string) => ({
    type,
    text,
    error,
    parts: [],
    model: undefined,
    at: undefined,
  });

  /**
   * Mechanical, and that is the answer to S7.4's first question: no model call on the
   * recovery path. What it hands the next worker is the dead one's own words, quoted.
   */
  test("counts the messages and quotes the last thing the worker said", () => {
    const summary = summariseTranscript([
      entry("user", "Probe the limiter on POST /login."),
      entry("assistant", "Sending ten requests."),
      entry("assistant", "Nine of ten were accepted; the tenth was 429."),
    ]);
    expect(summary).toContain("3 message(s)");
    expect(summary).toContain("2 of them its own");
    expect(summary).toContain("Nine of ten were accepted");
  });

  /** A transcript with nothing a successor could use is no summary rather than an empty one. */
  test("an empty transcript, and one with no words in it, produce nothing", () => {
    expect(summariseTranscript([])).toBeUndefined();
    expect(
      summariseTranscript([entry("user", "do the thing")]),
    ).toBeUndefined();
  });

  test("an error on the session is carried, because 'it died trying this' is the useful sentence", () => {
    const summary = summariseTranscript([
      entry("assistant", "Reading the login page."),
      entry("tool", "", "ECONNRESET while fetching https://acme.test/login"),
    ]);
    expect(summary).toContain("ECONNRESET");
  });

  /** Bounded, and marked where it was cut: a silently shortened quote is a misread quote. */
  test("a very long reply is cut and says so", () => {
    const long = "x".repeat(CONTINUATION_SUMMARY_MAX + 500);
    const summary = summariseTranscript([entry("assistant", long)]) ?? "";
    expect(summary.length).toBeLessThan(long.length);
    expect(summary).toContain("its reply was longer than this");
  });

  /**
   * S7's fourth done criterion: the summary is read from the harness, and failing to
   * produce it does not stop the continuation. Every failure here is `undefined`, and
   * `attemptContinuationNote` then says so rather than going quiet.
   */
  test("a harness that will not answer loses the summary and nothing else", async () => {
    const summary = await Effect.runPromise(
      readTranscriptSummary({
        resolver: HarnessResolver.fromEntries([
          {
            instance: STUB_INSTANCE,
            harness: stubHarness({
              messages: () =>
                Effect.fail(
                  new HarnessTransportError({
                    operation: "message.list",
                    status: undefined,
                    tag: undefined,
                    detail: "the harness did not answer",
                    cause: undefined,
                  }),
                ),
            }),
          },
        ]),
        harnessSessionId: "ses_dead",
        harnessInstanceId: STUB_INSTANCE.instanceId,
      }),
    );
    expect(summary).toBeUndefined();
    const note = attemptContinuationNote({
      replacesAttemptId: "ats_1",
      summary: undefined,
    });
    expect(note).toContain("could not be read");
    expect(note).toContain("unknown rather than as absent");
  });

  /**
   * The same check `harnessStatus.ts` makes, and it matters more here: reading another
   * harness's answer for this session id would quote another conversation's words into the
   * new worker's prompt.
   */
  test("an instance this server does not run is not asked", async () => {
    let asked = 0;
    const summary = await Effect.runPromise(
      readTranscriptSummary({
        resolver: HarnessResolver.fromEntries([
          {
            instance: STUB_INSTANCE,
            harness: stubHarness({
              messages: () =>
                Effect.sync(() => {
                  asked += 1;
                  return [];
                }),
            }),
          },
        ]),
        harnessSessionId: "ses_dead",
        harnessInstanceId: "some-other-harness",
      }),
    );
    expect(summary).toBeUndefined();
    expect(asked).toBe(0);
  });
});

/* ── What each surface is told ───────────────────────────────────────────────── */

describe("what a continued agent is told", () => {
  /**
   * The worker's block says three things, and the third is the one that keeps the summary
   * honest: the observations are the account of what happened, not this.
   */
  test("a worker is told it is a new attempt, what the old one got to, and where the record is", () => {
    const note = attemptContinuationNote({
      replacesAttemptId: "ats_dead",
      summary: "It got as far as reading the login page.",
    });
    expect(note).toContain("ats_dead");
    expect(note).toContain("new attempt");
    expect(note).toContain("It got as far as reading the login page.");
    expect(note).toContain("read the evidence before");
    // And that the target did not roll back, which is the one thing a fresh worker could
    // otherwise assume from an attempt that recorded nothing.
    expect(note).toContain("was not undone");
  });

  /**
   * It arrives as a `user` entry — that is the only kind of turn either driver takes — so
   * it will sit in the operator's own chat beside sentences they really typed. The prefix
   * is the difference between reading your own history and finding a message you never
   * sent.
   */
  test("a conversation's synthetic message is marked as this server speaking", () => {
    for (const subject of [
      { kind: "importer", importId: "imp_1" },
      { kind: "goal", goalId: "goal_1" },
    ] as const) {
      expect(continuationMessage(subject).startsWith("[bit] ")).toBe(true);
      expect(continuationMessage(subject)).toContain("restarted");
    }
    // The importer is the one told not to record anything twice, because it is the one
    // whose tools write entries.
    expect(
      continuationMessage({ kind: "importer", importId: "imp_1" }),
    ).toContain("read_scope");
  });
});

/* ── The operator's switch ───────────────────────────────────────────────────── */

describe("whether the operator has switched continuation off", () => {
  const ask = (
    settings: Readonly<Record<string, string>>,
  ): Promise<{ readonly _tag: string; readonly detail?: string }> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fleet = yield* FleetStore;
        for (const [key, value] of Object.entries(settings)) {
          yield* fleet.setSetting(key, value);
        }
        return yield* continuationAllowed({ fleet, targetId: TARGET });
      }).pipe(Effect.provide(FleetStore.layer(newRoot())), Effect.orDie),
    );

  /** T3 Code's default, and the one that matches what the feature is for. */
  test("it is on when nothing says otherwise", async () => {
    expect((await ask({}))._tag).toBe("on");
  });

  test("a global 'off' stops everything, and says which setting did it", async () => {
    const decision = await ask({ [CONTINUATION_SETTING]: "off" });
    expect(decision._tag).toBe("off");
    expect(decision.detail).toContain(CONTINUATION_SETTING);
  });

  test("a target's own setting overrides a global 'on'", async () => {
    const decision = await ask({
      [CONTINUATION_SETTING]: "on",
      [continuationSettingFor(TARGET)]: "off",
    });
    expect(decision._tag).toBe("off");
    expect(decision.detail).toContain(TARGET);
  });

  test("another target's setting is not this one's", async () => {
    const decision = await ask({
      [continuationSettingFor("some-other-target")]: "off",
    });
    expect(decision._tag).toBe("on");
  });

  /**
   * The last done criterion of this slice, and the reason the stored value is decoded
   * against a closed set rather than compared loosely: `"true"`, `"1"`, `"yes"` and a typo
   * all have to be refusals, not accidental `on`s.
   */
  test("a value this build cannot read means no continuation", async () => {
    for (const value of ["true", "1", "yes", "ON ", ""]) {
      const decision = await ask({ [CONTINUATION_SETTING]: value });
      expect(decision._tag).toBe("off");
      expect(decision.detail).toContain("cannot read");
    }
  });

  test("a setting that could not be read at all means no continuation either", async () => {
    const decision = await Effect.runPromise(
      continuationAllowed({
        // A fleet store whose read fails, which is the one case a real control database
        // cannot be made to produce on demand.
        fleet: {
          setting: () =>
            Effect.fail({
              _tag: "DatabaseError",
              message: "the control database is locked",
            }),
        } as unknown as FleetStore["Service"],
        targetId: TARGET,
      }),
    );
    expect(decision._tag).toBe("off");
    expect(decision._tag === "off" && decision.detail).toContain(
      "could not be read",
    );
  });
});

/* ── The queued row ──────────────────────────────────────────────────────────── */

describe("a queued continuation", () => {
  /**
   * Decoded rather than cast, which is what makes an unreadable row a refusal instead of a
   * property access on `unknown`. The dispatcher's own test checks what it does with one.
   */
  test("is refused when its payload is not one this build wrote", () => {
    expect(
      decodeContinuationRequest({ subject: { kind: "planner" } })._tag,
    ).toBe("Failure");
    expect(decodeContinuationRequest("not an object")._tag).toBe("Failure");
    expect(
      decodeContinuationRequest({
        subject: { kind: "goal", goalId: "goal_1" },
        targetId: TARGET,
        harnessSessionId: "ses_1",
        harnessInstanceId: null,
        observed: "abandoned",
        detail: "…",
        chainKey: "goal:goal_1",
        requestedAt: 1,
      })._tag,
    ).toBe("Success");
  });
});
