/**
 * The scripted harness's model switch: what a test about a switch can read back.
 *
 * Small on purpose. The stub's other members are exercised by every suite that uses it;
 * `switchModel` has no caller yet, so these pin the two promises a later test will lean on:
 * the default accepts without anyone having to script it, and the recorder keeps every call
 * exactly as it arrived.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { recordModelSwitches, stubHarness } from "./stubHarness";

describe("the scripted harness's model switch", () => {
  test("accepts a switch by default", async () => {
    const answer = await Effect.runPromise(
      Effect.result(stubHarness().switchModel("ses_stub_1", "scripted/other")),
    );
    expect(answer._tag).toBe("Success");
  });

  test("records every switch verbatim, a repeat and an absent options list included", async () => {
    const recorded = recordModelSwitches();
    const harness = stubHarness({ switchModel: recorded.switchModel });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* harness.switchModel("ses_stub_1", "scripted/model", [
          { id: "effort", value: "high" },
        ]);
        yield* harness.switchModel("ses_stub_1", "scripted/model", [
          { id: "effort", value: "high" },
        ]);
        yield* harness.switchModel("ses_stub_2", "scripted/other");
      }),
    );
    expect(recorded.switches).toEqual([
      {
        sessionId: "ses_stub_1",
        model: "scripted/model",
        options: [{ id: "effort", value: "high" }],
      },
      {
        sessionId: "ses_stub_1",
        model: "scripted/model",
        options: [{ id: "effort", value: "high" }],
      },
      { sessionId: "ses_stub_2", model: "scripted/other", options: undefined },
    ]);
    // "Nothing chosen" stays distinguishable from "chose nothing": `undefined`, not `[]`.
    expect("options" in (recorded.switches[2] ?? {})).toBe(true);
    expect(recorded.switches[2]?.options).toBeUndefined();
  });
});
