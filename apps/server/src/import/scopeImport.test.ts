/**
 * The import contract's one piece of real logic: per-link progress, derived.
 *
 * D13 settles that **nothing we own observes the importer's page fetches** — the harness
 * reads the page with its own tool, so a link's state has to be read off the `sourceUrl`
 * of the calls the importer made against it. This file is where that rule is pinned,
 * because it is the one place the panel could quietly start inventing progress: a
 * derivation that marked a link `read` before anything came off it would be a screen
 * claiming a page was parsed when it was not, which is the opposite of what an operator
 * is watching it for.
 *
 * The vectors are written from the rule, not from a recording of a run.
 */
import { describe, expect, test } from "bun:test";

import {
  scopeImportLinkIndex,
  scopeImportLinks,
  scopeImportUrlKey,
  type ScopeImportCall,
  type ScopeImportTool,
} from "@bit/contracts";

const A = "https://hackerone.com/acme/policy";
const B = "https://bugcrowd.com/acme-corp";

let sequence = 0;
const call = (
  tool: ScopeImportTool,
  sourceUrl: string | null,
  wrote: string,
): ScopeImportCall => ({
  sequence: (sequence += 1),
  tool,
  wrote,
  sourceUrl,
  at: 1_000 + sequence,
});

const entryIn = (sourceUrl: string): ScopeImportCall =>
  call("add_scope_entry", sourceUrl, "in · subtree · acme.com");
const entryOut = (sourceUrl: string): ScopeImportCall =>
  call("add_scope_entry", sourceUrl, "out · host · blog.acme.com");
const asset = (sourceUrl: string): ScopeImportCall =>
  call("record_imported_asset", sourceUrl, "www.acme.com:443");

describe("scopeImportLinks", () => {
  test("a link with no calls is waiting, whatever the import is doing", () => {
    const running = scopeImportLinks({
      urls: [A, B],
      calls: [],
      running: true,
    });
    expect(running.map((link) => link.state)).toEqual(["waiting", "waiting"]);

    // The same two links under a finished import. `waiting` is deliberately the same
    // word: a page that was read and yielded nothing produced no calls, exactly like a
    // page that was never reached, and D15 says neither is a failure. What tells them
    // apart is the import's status, which is not this function's to report.
    const finished = scopeImportLinks({
      urls: [A, B],
      calls: [],
      running: false,
    });
    expect(finished.map((link) => link.state)).toEqual(["waiting", "waiting"]);
  });

  test("the last link with calls is reading while the import runs", () => {
    const links = scopeImportLinks({
      urls: [A, B],
      calls: [entryIn(A), entryOut(A)],
      running: true,
    });
    // A produced calls and is the furthest link that has, so it is the one being read.
    // Nothing says it is finished with until a later page produces a call or the session
    // ends, and the panel does not get to guess.
    expect(links[0]?.state).toBe("reading");
    expect(links[1]?.state).toBe("waiting");
  });

  test("a call against a later link is what marks an earlier one read", () => {
    const links = scopeImportLinks({
      urls: [A, B],
      calls: [entryIn(A), entryOut(A), entryIn(B)],
      running: true,
    });
    expect(links[0]?.state).toBe("read");
    expect(links[1]?.state).toBe("reading");
  });

  test("every link with calls is read once the import stops running", () => {
    const links = scopeImportLinks({
      urls: [A, B],
      calls: [entryIn(A), entryIn(B)],
      running: false,
    });
    expect(links.map((link) => link.state)).toEqual(["read", "read"]);
  });

  test("tallies are per link, and entries are split by effect", () => {
    const links = scopeImportLinks({
      urls: [A, B],
      calls: [
        entryIn(A),
        entryIn(A),
        entryOut(A),
        asset(A),
        asset(A),
        asset(A),
        entryOut(B),
      ],
      running: false,
    });
    expect(links[0]).toEqual({
      url: A,
      state: "read",
      entriesIn: 2,
      entriesOut: 1,
      assets: 3,
    });
    expect(links[1]).toEqual({
      url: B,
      state: "read",
      entriesIn: 0,
      entriesOut: 1,
      assets: 0,
    });
  });

  test("a read_scope call carries no page and moves no link", () => {
    // `read_scope` is how a second page is read against the first, so it says nothing
    // about which page is being read. It has no `sourceUrl` for that reason, and a
    // derivation that counted it would mark a link reached on the strength of a call that
    // wrote nothing.
    const links = scopeImportLinks({
      urls: [A, B],
      calls: [call("read_scope", null, "read 4 entries")],
      running: true,
    });
    expect(links.map((link) => link.state)).toEqual(["waiting", "waiting"]);
  });

  test("a call naming a page the operator did not paste is attributed nowhere", () => {
    // It still happened and still counts toward the import's totals — it is a write that
    // really landed. It simply cannot be filed under a link, and inventing a row for it
    // would put a URL on the operator's screen that they never typed.
    const links = scopeImportLinks({
      urls: [A],
      calls: [entryIn("https://example.test/elsewhere")],
      running: true,
    });
    expect(links).toEqual([
      { url: A, state: "waiting", entriesIn: 0, entriesOut: 0, assets: 0 },
    ]);
  });

  test("no links is no rows, not an error", () => {
    expect(scopeImportLinks({ urls: [], calls: [], running: false })).toEqual(
      [],
    );
  });
});

/**
 * The near misses, which are the common case rather than the exotic one.
 *
 * `source_url` is a tool argument: the importer **retypes** the URL it was given, and a
 * model that normalised it, a reader that followed a redirect, or an operator who pasted a
 * trailing slash all produce a string that names the right page and is not the same bytes.
 * Matched exactly, every one of those calls is attributed to no link — and because the
 * totals are tallied over every call while the rows are tallied only over attributed ones,
 * the receipt reads "2 in-scope · 1 out-of-scope" above a list where every link says
 * "nothing read". The screen contradicting itself is the failure these vectors exist to
 * stop.
 */
describe("a link is matched on what identifies the page, not on the bytes", () => {
  const near = (sourceUrl: string) =>
    scopeImportLinks({
      urls: [A],
      calls: [entryIn(sourceUrl), entryOut(sourceUrl), asset(sourceUrl)],
      running: false,
    })[0];

  test("a trailing slash is the same page", () => {
    expect(near(`${A}/`)).toMatchObject({
      url: A,
      state: "read",
      entriesIn: 1,
      entriesOut: 1,
      assets: 1,
    });
  });

  test("a different case in the host and scheme is the same page", () => {
    expect(near("HTTPS://HackerOne.com/acme/policy")).toMatchObject({
      state: "read",
      entriesIn: 1,
    });
  });

  test("the scheme a redirect landed on is the same page", () => {
    // The operator pastes `http`, the program serves `https` after one redirect, and the
    // harness's reader reports where it ended up. The page the importer read is the page
    // the operator named.
    expect(
      scopeImportLinks({
        urls: ["http://hackerone.com/acme/policy"],
        calls: [entryIn("https://hackerone.com/acme/policy")],
        running: false,
      })[0],
    ).toMatchObject({ state: "read", entriesIn: 1 });
  });

  test("the default port and a fragment change nothing", () => {
    expect(near("https://hackerone.com:443/acme/policy#scope")).toMatchObject({
      state: "read",
      entriesIn: 1,
    });
  });

  test("a dropped query still finds the one page it can be", () => {
    // A model that reported `…/policy` for a page pasted as `…/policy?tab=scope` is naming
    // the page it read. One link can match, so there is nothing to guess at.
    expect(
      scopeImportLinks({
        urls: [`${A}?tab=scope`],
        calls: [entryIn(A)],
        running: false,
      })[0],
    ).toMatchObject({ state: "read", entriesIn: 1 });
  });

  test("but not when two links differ only by their query", () => {
    // Two pages, and attributing the call to either would be a guess. Left unattributed:
    // the call is still in `calls` and still counted in the totals, so nothing is lost
    // except a row's claim to have produced it.
    const links = scopeImportLinks({
      urls: [`${A}?tab=scope`, `${A}?tab=rewards`],
      calls: [entryIn(A)],
      running: false,
    });
    expect(links.map((link) => link.state)).toEqual(["waiting", "waiting"]);
  });

  test("a wholly foreign page is still attributed nowhere", () => {
    expect(scopeImportLinkIndex([A, B], "https://example.test/elsewhere")).toBe(
      -1,
    );
  });

  test("a string no URL parser accepts is compared as it stands", () => {
    // It is still what the importer was handed, and inventing a shape for it would be
    // worse than comparing it as it is.
    expect(scopeImportUrlKey("  Not A Url  ")).toBe("not a url");
    expect(scopeImportLinkIndex(["not a url"], "NOT A URL")).toBe(0);
  });
});
