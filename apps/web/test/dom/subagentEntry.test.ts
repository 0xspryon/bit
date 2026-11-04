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

import { compile } from "svelte/compiler";

import { App } from "../../src/lib/app.svelte";
import ChatItem from "../../src/lib/components/ChatItem.svelte";
import LiveTranscript from "../../src/lib/components/LiveTranscript.svelte";
import { SUBAGENT_NOTE } from "../../src/lib/chat";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer } from "../fakeServer";

import { mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
let sheet: HTMLStyleElement | undefined;
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
  sheet?.remove();
  sheet = undefined;
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

  /*
   * U14's review: an RLO in the type moved the status chip in front of it, and one in the
   * task drew the sentence backwards. Every bidi control is marked, as prose marks one
   * (`proseRuns`), whatever is beside it, and both are their own isolate.
   */
  test("a bidi control in its type or task is a marker, in both readings, and each is an isolate", async () => {
    const item = entry({
      headline: "\u202Eesoprup-lareneg",
      body: "Fetch \u2067com\u200F.\u200Facme\u2069 and \u202Bwrite\u202C it",
    });
    const type = "⟨U+202E⟩esoprup-lareneg";
    const task =
      "Fetch ⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩ and ⟨U+202B⟩write⟨U+202C⟩ it";
    const row = draw(item);
    expect(row.querySelector(".agent-type")?.textContent).toBe(type);
    expect(row.querySelector(".task")?.textContent).toBe(task);
    expect(row.querySelectorAll(".char-escape")).toHaveLength(7);
    const ledger = draw(item, false);
    expect(ledger.querySelector(".headline")?.textContent).toBe(type);
    expect(ledger.querySelector(".body")?.textContent).toBe(task);
    expect(ledger.textContent).not.toMatch(/[\u200F\u202B-\u202E\u2067\u2069]/);

    // A Hebrew word glued to a host, or one planted letter, keeps none of its controls
    // (a second review of U14).
    const glued = draw(
      entry({
        headline: "י\u2067com\u200F.\u200Facme\u2069",
        body: "Fetch שלום\u2800\u2067com\u200F.\u200Facme\u2069 now",
      }),
    );
    expect(glued.querySelector(".agent-type")?.textContent).toBe(
      "י⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩",
    );
    expect(glued.querySelector(".task")?.textContent).toBe(
      "Fetch שלום\u2800⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩ now",
    );

    // One planted letter after an opener keeps no control either (a third review of U14):
    // it reordered the rest of its run through an Arabic-Indic digit.
    const planted = draw(
      entry({
        headline: "\u2068יcom.\u0660acmeי\u2069",
        body: "Visit \u202Bיcom.\u0640acmeי\u202C for details",
      }),
    );
    expect(planted.querySelector(".agent-type")?.textContent).toBe(
      "⟨U+2068⟩יcom.\u0660acmeי⟨U+2069⟩",
    );
    expect(planted.querySelector(".task")?.textContent).toBe(
      "Visit ⟨U+202B⟩יcom.\u0640acmeי⟨U+202C⟩ for details",
    );

    // Right-to-left letters with no controls draw as written; a control among them is a
    // marker like any other.
    const hebrew = draw(
      entry({ headline: "סוכן", body: "בדוק \u2067את האתר\u2069 בבקשה" }),
    );
    expect(hebrew.querySelector(".agent-type")?.textContent).toBe("סוכן");
    expect(hebrew.querySelector(".task")?.textContent).toBe(
      "בדוק ⟨U+2067⟩את האתר⟨U+2069⟩ בבקשה",
    );

    const path = new URL(
      "../../src/lib/components/ChatItem.svelte",
      import.meta.url,
    ).pathname;
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);
    expect(
      [".agent-type", ".task"].map(
        (selector) =>
          getComputedStyle(row.querySelector(selector) ?? row).unicodeBidi,
      ),
    ).toEqual(["isolate", "isolate"]);
  });
});

describe("the target's Live panel", () => {
  /*
   * A second review of U14: collapsed, the bar names the newest arrival by its headline, a
   * sub-agent's type, and drew it as it came, so an RLO in it reversed the bar.
   */
  test("collapsed, it marks a bidi control in the newest headline and isolates it", async () => {
    const app = new App(new FakeServer(), new FakeCountdown());
    app.viewTargetId = "acme-corp";
    app.liveTargetId = "acme-corp";
    app.liveExpanded = false;
    app.liveItems = [
      entry({
        headline: "\u202Eesoprup-lareneg \u2067com\u200F.\u200Facme\u2069",
      }),
    ];
    const panel = mountInto(LiveTranscript, { app });
    mounted.push(panel);
    await settle();
    const headline =
      panel.target.querySelector<HTMLElement>(".newest .headline");
    expect(headline?.textContent).toBe(
      "⟨U+202E⟩esoprup-lareneg ⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩",
    );
    expect(headline?.querySelectorAll(".char-escape")).toHaveLength(5);
    expect(
      panel.target
        .querySelector(".newest")
        ?.textContent?.replace(/\s+/gu, " ")
        .trim(),
    ).toBe(
      "Sub-agent — ⟨U+202E⟩esoprup-lareneg ⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩",
    );

    const path = new URL(
      "../../src/lib/components/LiveTranscript.svelte",
      import.meta.url,
    ).pathname;
    const { css } = compile(await Bun.file(path).text(), {
      filename: path,
      generate: "client",
      css: "external",
      dev: true,
    });
    sheet = document.createElement("style");
    sheet.textContent = css?.code ?? "";
    document.head.append(sheet);
    expect(
      headline === null ? "" : getComputedStyle(headline).unicodeBidi,
    ).toBe("isolate");

    // One planted letter after an opener keeps no control (a third review of U14).
    app.liveItems = [entry({ headline: "\u2067יcom.\u0660acmeי\u2069" })];
    await settle();
    const planted =
      panel.target.querySelector<HTMLElement>(".newest .headline");
    expect(planted?.textContent).toBe("⟨U+2067⟩יcom.\u0660acmeי⟨U+2069⟩");
    expect(planted?.querySelectorAll(".char-escape")).toHaveLength(2);
  });

  test("draws each sub-agent as one row, at where it started, in its newest state", async () => {
    const app = new App(new FakeServer(), new FakeCountdown());
    app.viewTargetId = "acme-corp";
    app.liveTargetId = "acme-corp";
    app.liveExpanded = true;
    const reply = (id: string, body: string): LiveItem => ({
      ...entry({ id, body }),
      kind: "turn.reply",
      headline: "reply",
      tool: null,
      toolName: null,
      callId: null,
      outcome: null,
    });
    app.liveItems = [
      entry({ id: "activity:1" }),
      reply("activity:2", "Started it."),
      entry({ id: "activity:3", callId: "toolu_other", body: "Say PING" }),
      entry({ id: "activity:4", outcome: "finished" }),
    ];
    const panel = mountInto(LiveTranscript, { app });
    mounted.push(panel);
    await settle();
    const rows = [...panel.target.querySelectorAll(".items > li")].map(
      (row) =>
        `${row.querySelector(".kind")?.textContent ?? ""} ${row.querySelector(".body")?.textContent ?? ""} ${[...row.querySelectorAll(".outcome")].map((chip) => chip.textContent?.trim()).join(",")}`,
    );
    expect(rows).toEqual([
      "Sub-agent Say PONG finished",
      "Reply Started it. ",
      "Sub-agent Say PING running",
    ]);
  });
});
