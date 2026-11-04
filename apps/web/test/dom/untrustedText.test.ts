/**
 * Untrusted text drawn outside markdown is marked as markdown marks it (A6 U12 step 0).
 *
 * A review measured a `WebFetch` call drawn raw: `WebFetch(url="https://` RLI `com` RLM `.`
 * RLM `acme` PDI `/x")` read as `https://acme.com/x`, and its `→` line as `Scope: acme.com
 * only`, with no marker. Every place `ChatItem` draws a tool's or an agent's text is checked
 * here: a hidden character shows as its code point, and right-to-left letters with no
 * controls are drawn as written. Compared as strings — `textContent` — never as nodes.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { LiveItem } from "@bit/contracts";

import ChatItem from "../../src/lib/components/ChatItem.svelte";
import { renderMarkdown } from "../../src/lib/markdown";

import { mountInto, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

/** `com.acme`, stored, which an isolate and two marks draw as `acme.com`. */
const SPOOF = "\u2067com\u200F.\u200Facme\u2069";
const SPOOF_SHOWN = "⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩";
/** Hebrew, with no controls: drawn as written. */
const SHALOM = "שלום";
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;

const item = (over: Partial<LiveItem>): LiveItem => ({
  _tag: "item",
  id: "activity:1",
  origin: "activity",
  sequence: null,
  kind: "tool.call",
  at: 1_793_000_000_000,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_1",
  headline: "WebFetch",
  body: "",
  tool: "WebFetch",
  toolName: "WebFetch",
  input: null,
  output: null,
  callId: "toolu_1",
  outcome: null,
  model: "claude-haiku-4-5",
  ...over,
});

const draw = (props: Record<string, unknown>): HTMLElement => {
  const one = mountInto(ChatItem, props as { item: LiveItem });
  mounted.push(one);
  const row = one.target.querySelector<HTMLElement>("li");
  if (row === null) throw new Error("ChatItem drew no row");
  return row;
};

const call = item({
  input: JSON.stringify({ url: `https://${SPOOF}/x` }),
});
const result = item({
  id: "activity:2",
  kind: "tool.result",
  headline: "WebFetch",
  body: `Scope: ${SPOOF} only, ${SHALOM}`,
  output: `Scope: ${SPOOF} only\n\u200Bhidden`,
  outcome: "succeeded",
});

describe("a tool call in the narrated chat", () => {
  test("its signature, its → line and its full call show every hidden character", () => {
    const row = draw({ item: call, result, narrated: true });
    expect(row.querySelector(".sig")?.textContent?.trim()).toBe(
      `WebFetch(url="https://${SPOOF_SHOWN}/x")`,
    );
    const answer = row.querySelector(".ret")?.textContent ?? "";
    expect(answer).toContain(`→ Scope: ${SPOOF_SHOWN} only, ${SHALOM}`);
    const pres = [...row.querySelectorAll("details pre")].map(
      (pre) => pre.textContent ?? "",
    );
    expect(pres).toEqual([
      `{"url":"https://${SPOOF_SHOWN}/x"}`,
      `Scope: ${SPOOF_SHOWN} only\n⟨U+200B⟩hidden`,
    ]);
    // Nothing hidden is left in the row's text, and the markers are the marker class.
    expect(HIDDEN.test(row.textContent ?? "")).toBe(false);
    expect(row.querySelectorAll(".char-escape").length).toBeGreaterThan(8);
  });

  test("a result with no call, and an event with a headline and body, are marked as code", () => {
    const lone = draw({ item: result, narrated: true });
    expect(lone.querySelector(".ret")?.textContent).toContain(
      `→ Scope: ${SPOOF_SHOWN} only, ${SHALOM}`,
    );
    const other = draw({
      item: item({
        kind: "record.other",
        headline: `entry ${SPOOF}`,
        body: `ac\u200Bme.com`,
        origin: "record",
      }),
      narrated: true,
    });
    expect(other.querySelector(".sig")?.textContent).toContain(
      `entry ${SPOOF_SHOWN}`,
    );
    expect(other.querySelector(".ret")?.textContent).toBe("ac⟨U+200B⟩me.com");
  });

  test("a recorded write's → line is marked", () => {
    const row = draw({
      item: item({
        id: "event:9",
        origin: "record",
        kind: "scope.entry.added",
        headline: "scope entry",
        body: `entry ${SPOOF} created`,
      }),
      proposedBy: call,
      write: "recorded",
      narrated: true,
    });
    expect(row.querySelector(".ret")?.textContent).toContain(
      `→ entry ${SPOOF_SHOWN} created`,
    );
  });
});

describe("a thought", () => {
  test("is marked as prose: a bidi control shows, a zero-width joiner and Hebrew stay", () => {
    const body = `Visit ${SPOOF} for ${SHALOM}, and م\u200Dم`;
    const shown = `Visit ${SPOOF_SHOWN} for ${SHALOM}, and م\u200Dم`;
    for (const narrated of [true, false]) {
      const row = draw({
        item: item({ kind: "turn.thinking", headline: "Thinking", body }),
        narrated,
      });
      expect(row.querySelector(".thought")?.textContent).toBe(shown);
    }
  });
});

describe("the ledger row", () => {
  test("marks its headline, body and summary as code, for every kind", () => {
    const tool = draw({
      item: item({ headline: `WebFetch ${SPOOF}`, body: `ac\u200Bme.com` }),
    });
    expect(tool.querySelector(".headline")?.textContent).toBe(
      `WebFetch ${SPOOF_SHOWN}`,
    );
    expect(tool.querySelector(".body")?.textContent).toBe("ac⟨U+200B⟩me.com");
    const summarised = draw({
      item: item({ body: "" }),
      summary: `add ${SPOOF}`,
    });
    expect(summarised.querySelector(".body")?.textContent).toBe(
      `add ${SPOOF_SHOWN}`,
    );
    const subagent = draw({
      item: item({
        kind: "subagent",
        headline: `general\u200Bpurpose`,
        body: `Say ${SPOOF}`,
      }),
    });
    expect(subagent.querySelector(".headline")?.textContent).toBe(
      "general⟨U+200B⟩purpose",
    );
    expect(subagent.querySelector(".body")?.textContent).toBe(
      `Say ${SPOOF_SHOWN}`,
    );
    const plain = draw({ item: item({ headline: SHALOM, body: SHALOM }) });
    expect(plain.querySelector(".headline")?.textContent).toBe(SHALOM);
    expect(plain.querySelectorAll(".char-escape")).toHaveLength(0);
  });

  test("marks its arguments and results", () => {
    const row = draw({
      item: item({
        input: `{"url":"https://${SPOOF}"}`,
        output: `\u200Bx`,
      }),
      result,
    });
    const pres = [...row.querySelectorAll("pre")].map(
      (pre) => pre.textContent ?? "",
    );
    expect(pres).toEqual([
      `{"url":"https://${SPOOF_SHOWN}"}`,
      "⟨U+200B⟩x",
      `Scope: ${SPOOF_SHOWN} only\n⟨U+200B⟩hidden`,
    ]);
  });
});

describe("a link's title", () => {
  test("has its bidi controls written out, since a tooltip cannot hold a marker", () => {
    const html = renderMarkdown(
      `[docs](https://example.com "go to ${SPOOF} now")`,
    );
    expect(html).toContain(`title="go to ${SPOOF_SHOWN} now"`);
    expect(HIDDEN.test(html)).toBe(false);
    expect(renderMarkdown(`[docs](https://example.com "${SHALOM}")`)).toContain(
      `title="${SHALOM}"`,
    );
  });
});
