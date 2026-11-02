/**
 * The Agent sessions list's words, against plain data (`src/lib/agentSessions.ts`).
 *
 * The rendered list is `test/dom/agentSessions.test.ts`; this owns the decisions that are
 * not layout: what each state is called, and when a harness counts as gone.
 */
import { describe, expect, test } from "bun:test";

import {
  destinationOf,
  harnessOf,
  stateLabel,
  tallySentence,
} from "../src/lib/agentSessions";

const LISTED = [
  { instanceId: "opencode", displayName: "OpenCode" },
  { instanceId: "claude-code", displayName: "Claude Code" },
];

describe("a session's state", () => {
  test("a session this server does not hold is 'Not running', never 'Ended'", () => {
    expect(stateLabel({ state: "dormant", detail: null })).toBe("Not running");
  });

  test("an ended session carries the kind's own reason", () => {
    expect(stateLabel({ state: "ended", detail: "failed" })).toBe(
      "Ended · failed",
    );
    expect(stateLabel({ state: "ended", detail: "open_failed" })).toBe(
      "Ended · open failed",
    );
    expect(stateLabel({ state: "ended", detail: null })).toBe("Ended");
  });
});

describe("the harness a session ran on", () => {
  test("resolves an instance to its name", () => {
    expect(harnessOf({ harnessInstanceId: "opencode" }, LISTED, true)).toEqual({
      name: "OpenCode",
      strandedOn: undefined,
    });
  });

  test("an instance this server does not run is stranded, once the listing has said what is here", () => {
    expect(harnessOf({ harnessInstanceId: "gone" }, LISTED, true)).toEqual({
      name: "gone",
      strandedOn: "gone",
    });
  });

  test("before the listing arrives an unknown instance is unknown, not gone", () => {
    expect(
      harnessOf({ harnessInstanceId: "gone" }, [], false).strandedOn,
    ).toBeUndefined();
  });

  test("a row recorded with no instance has nothing to compare and is not flagged", () => {
    expect(harnessOf({ harnessInstanceId: null }, LISTED, true)).toEqual({
      name: "Harness not recorded",
      strandedOn: undefined,
    });
  });
});

describe("the tally and the destination", () => {
  test("only a kind that derives a tally has one", () => {
    expect(tallySentence(null)).toBeNull();
    expect(tallySentence({ entriesIn: 2, entriesOut: 1, assets: 1 })).toBe(
      "2 in · 1 out · 1 asset",
    );
    expect(tallySentence({ entriesIn: 0, entriesOut: 0, assets: 3 })).toBe(
      "0 in · 0 out · 3 assets",
    );
  });

  test("a worker has no destination, so its row is inert", () => {
    expect(destinationOf("worker")).toBeNull();
    expect(destinationOf("importer")).toBe("importer");
    expect(destinationOf("goal")).toBe("goal");
  });
});
