/**
 * The importer's parked words in `sessionStorage` (U8 review 4): kept per server and target,
 * decoded rather than trusted, and gone from storage once there are none.
 */
import { describe, expect, test } from "bun:test";

import {
  browserParkedStore,
  parkedStart,
  type ParkedMessages,
} from "../../src/lib/importerParked";

const SERVER = "http://127.0.0.1:3000";
const KEY = `bit.importerParked:${JSON.stringify([SERVER, "acme-corp"])}`;

const PARKED: ParkedMessages = {
  ses_unsent_1: {
    text: "Read https://example.com/",
    detail: "the harness would not take the message",
    outcome: "refused",
    first: { startedAt: 1, agentId: "importer" },
  },
  ses_newest: { text: "Also load staging", detail: "…", outcome: "unknown" },
};

describe("parked words in this tab", () => {
  test("come back as they were written, per server and target", () => {
    browserParkedStore.write(SERVER, "acme-corp", PARKED);
    expect(browserParkedStore.read(SERVER, "acme-corp")).toEqual(PARKED);
    expect(browserParkedStore.read(SERVER, "other")).toEqual({});
    expect(browserParkedStore.read("http://elsewhere", "acme-corp")).toEqual(
      {},
    );
  });

  test("none left is no key at all", () => {
    browserParkedStore.write(SERVER, "acme-corp", PARKED);
    browserParkedStore.write(SERVER, "acme-corp", {});
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  test("anything that does not decode is nothing parked", () => {
    for (const stored of [
      "not json",
      "[]",
      JSON.stringify({ s: { text: "x", detail: "y", outcome: "lost" } }),
      JSON.stringify({ s: { text: 1, detail: "y", outcome: "refused" } }),
    ]) {
      sessionStorage.setItem(KEY, stored);
      expect(browserParkedStore.read(SERVER, "acme-corp")).toEqual({});
    }
  });

  test("a row quotes the start of the words, on one line", () => {
    expect(parkedStart("  Read\n\nthe   policy ")).toBe("Read the policy");
    const long = "x".repeat(70);
    expect(parkedStart(long)).toBe(`${"x".repeat(60)}…`);
  });
});
