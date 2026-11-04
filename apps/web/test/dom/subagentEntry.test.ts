/**
 * A sub-agent's entry, as `ChatItem` draws it (A6 U14).
 *
 * The server narrates a sub-agent's own thinking, tool calls and replies as nothing and its
 * call as `subagent` items; `chat.ts` folds those into one row. What is left to check is
 * the row: that it says what the sub-agent is and how it stands, that it says its work is
 * not shown, that the calling agent's words in it are text and nothing else, and that a
 * reloaded entry is the live one. Compared as strings — `textContent`, `outerHTML` —
 * never as nodes.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { LiveItem } from "@bit/contracts";

import ChatItem from "../../src/lib/components/ChatItem.svelte";
import { SUBAGENT_NOTE } from "../../src/lib/chat";

import { mountInto, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const entry = (over: Partial<LiveItem> = {}): LiveItem => ({
  _tag: "item",
  id: "activity:7",
  origin: "activity",
  sequence: null,
  kind: "subagent",
  at: 1_793_000_000_000,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_1",
  headline: "general-purpose",
  body: "Say PONG",
  tool: "Agent",
  toolName: "Agent",
  input: null,
  output: null,
  callId: "toolu_017TrDc21wUaAJ83MdQSfYyo",
  outcome: "running",
  model: "claude-haiku-4-5-20251001",
  ...over,
});

const draw = (item: LiveItem, narrated = true): HTMLElement => {
  const one = mountInto(ChatItem, { item, narrated });
  mounted.push(one);
  const row = one.target.querySelector<HTMLElement>("li");
  if (row === null) throw new Error("ChatItem drew no row");
  return row;
};

describe("a sub-agent's entry", () => {
  test("says what it is, how it stands, and that its own work is postponed to V2", () => {
    const row = draw(entry());
    expect(row.className).toContain("subagent");
    expect(row.querySelector(".what")?.textContent).toBe("Sub-agent");
    expect(row.querySelector(".agent-type")?.textContent).toBe(
      "general-purpose",
    );
    expect(row.querySelector(".chip")?.textContent?.trim()).toBe("running");
    expect(row.querySelector(".task")?.textContent).toBe("Say PONG");
    expect(row.querySelector(".state-note")?.textContent).toBe(SUBAGENT_NOTE);
    expect(SUBAGENT_NOTE).toContain("postponed to V2");
    // The call it came from is named for a reader matching it against the harness's log.
    expect(row.getAttribute("title")).toBe(
      "call toolu_017TrDc21wUaAJ83MdQSfYyo",
    );
  });

  test("finished, failed and stopped are each said in words", () => {
    expect(
      ["finished", "failed", "stopped"].map(
        (outcome) =>
          `${draw(entry({ outcome })).querySelector(".chip")?.textContent?.trim() ?? ""} ${draw(entry({ outcome })).querySelector(".chip")?.getAttribute("data-tint") ?? ""}`,
      ),
    ).toEqual(["finished success", "failed danger", "stopped warning"]);
  });

  test("the calling agent's words are plain text: no markup, no markdown, no link", () => {
    const row = draw(
      entry({
        headline: '<img src=x onerror="alert(1)">',
        body: "**Fetch** [the login page](https://evil.example/) <script>alert(1)</script>",
      }),
    );
    expect(row.querySelector("img, script, a, strong")).toBeNull();
    expect(row.querySelector(".agent-type")?.textContent).toBe(
      '<img src=x onerror="alert(1)">',
    );
    expect(row.querySelector(".task")?.textContent).toBe(
      "**Fetch** [the login page](https://evil.example/) <script>alert(1)</script>",
    );
  });

  test("a reloaded entry is the live one, and the ledger reading carries the note too", () => {
    const live = draw(entry({ outcome: "finished" })).outerHTML;
    const replayed = draw(
      entry({ id: "replay:3", at: 1_793_000_000_500, outcome: "finished" }),
    ).outerHTML;
    expect(replayed).toBe(live);

    const ledger = draw(entry(), false);
    expect(ledger.querySelector(".kind")?.textContent).toBe("Sub-agent");
    expect(ledger.querySelector(".headline")?.textContent).toBe(
      "general-purpose",
    );
    expect(ledger.querySelector(".body")?.textContent).toBe("Say PONG");
    expect(ledger.textContent).toContain(SUBAGENT_NOTE);
  });
});
