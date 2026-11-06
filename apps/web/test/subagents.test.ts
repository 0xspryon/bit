/** The sub-agent words and groups a chat draws (A7-S): `src/lib/subagents.ts`. */
import { describe, expect, test } from "bun:test";

import type { SubagentView } from "@bit/contracts";

import {
  callsLabel,
  railGivesWay,
  stopWithheld,
  subagentCardId,
  subagentGroups,
  subagentMeta,
} from "../src/lib/subagents";

const view = (over: Partial<SubagentView> = {}): SubagentView => ({
  callId: "toolu_1",
  tool: "Agent",
  agentType: null,
  description: "d",
  task: "",
  background: true,
  status: "running",
  startedAt: 1_000,
  endedAt: null,
  calls: null,
  lines: [],
  activity: null,
  result: null,
  failure: null,
  stop: "own",
  ...over,
});

describe("sub-agent words (A7-S)", () => {
  test("a running clock runs to now, an ended one to its end; a count is said only when counted", () => {
    expect(subagentMeta(view({ calls: 9 }), 73_000)).toBe("1m 12s · 9 calls");
    expect(subagentMeta(view({ calls: 1 }), 2_000)).toBe("1s · 1 call");
    expect(subagentMeta(view(), 2_000)).toBe("1s");
    expect(
      subagentMeta(view({ status: "failed", endedAt: 59_000 }), 999_999),
    ).toBe("failed at 58s");
    expect(
      subagentMeta(view({ status: "stopped", startedAt: null, endedAt: 5 }), 0),
    ).toBe("stopped");
    expect(
      subagentMeta(view({ status: "stopped", endedAt: 59_000 }), 999_999),
    ).toBe("stopped at 58s");
    // Gone with its session's harness, which kept no time for it (A7-S review 2).
    expect(subagentMeta(view({ status: "stopped", endedAt: null }), 0)).toBe(
      "stopped with the session",
    );
    expect(callsLabel(null)).toBe("");
  });

  test("Stop is withheld, with its reason, from a running one that has no Stop of its own, and from nothing else", () => {
    expect(stopWithheld(view(), "the importer")).toBeUndefined();
    expect(stopWithheld(view({ stop: "with_turn" }), "the importer")).toContain(
      "inside the importer's turn",
    );
    expect(stopWithheld(view({ stop: "none" }), "the importer")).toContain(
      "cannot reach",
    );
    expect(
      stopWithheld(view({ status: "finished", stop: "none" }), "the importer"),
    ).toBeUndefined();
  });

  test("stopped goes with finished, not failed", () => {
    const groups = subagentGroups(
      (["running", "failed", "finished", "stopped"] as const).map((status) => ({
        item: {} as never,
        view: view({ callId: status, status }),
      })),
    );
    expect(
      [groups.running, groups.failed, groups.finished].map((each) =>
        each.map((entry) => entry.view.callId).join(","),
      ),
    ).toEqual(["running", "failed", "finished,stopped"]);
  });

  test("the rail gives way while the column beside a 400px panel would be under 560px", () => {
    expect(railGivesWay(792)).toBe(true);
    expect(railGivesWay(959)).toBe(true);
    expect(railGivesWay(960)).toBe(false);
    expect(railGivesWay(1208)).toBe(false);
  });

  test("a card's id is the call's, with anything an id should not hold replaced", () => {
    expect(subagentCardId("toolu_01AbC-9")).toBe("subagent-toolu_01AbC-9");
    expect(subagentCardId('x" onclick="y')).toBe("subagent-x__onclick__y");
  });
});
