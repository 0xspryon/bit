/**
 * The scope importer's sessions, as static data (A6 D2–D5).
 *
 * `mock.ts`'s pattern: what has no server behind it yet. There is no importer endpoint, no
 * session list and no feed for one, so every session below is declared, and the state
 * picker (`ScenarioBar`) loads them. Nothing outside the prototype may import this file.
 *
 * The content is deliberately a real-looking import — a program page read, entries written
 * in and out, assets recorded, an operator correcting it — because the point of building
 * the chat before its API is to judge the design against something that reads like the
 * work, not like filler.
 */
import type { LiveItem } from "@bit/contracts";

import { operatorTurn } from "./chat";
import { NO_HISTORY, type ImporterSession } from "./importerChat";

/**
 * The model every new importer session shows.
 *
 * Mock. The real source is `App.importerModel`, the server's answer resolved against the
 * live catalogue, and the composer's harness picker once a session can choose. A literal
 * here is exactly the "id written into a bundle" `modelOption.ts` warns against, which is
 * why nothing outside the prototype may read it.
 */
export const IMPORTER_MODEL = "openai/gpt-5.6-sol";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const base = (
  over: Pick<LiveItem, "id" | "kind" | "at"> & Partial<LiveItem>,
): LiveItem => ({
  _tag: "item",
  origin: "activity",
  sequence: null,
  attemptId: null,
  roundId: null,
  goalId: null,
  headline: "",
  body: "",
  tool: null,
  toolName: null,
  input: null,
  output: null,
  callId: null,
  outcome: null,
  ...over,
});

/**
 * Builders for the feed's rows, so a fixture reads as a conversation rather than a wall of
 * nulls. Each returns the shape the server's `LiveItem` has: an `activity` row for what the
 * agent said and called, a `record` row for what was committed. The counters are the
 * fixture's own, so ids are unique within a session and identical between runs.
 */
const feed = (prefix: string, start: number) => {
  let activity = 0;
  let sequence = 0;
  let call = 0;
  const at = (seconds: number): number => start + seconds * 1000;
  return {
    operator: (turn: number, text: string, seconds: number): LiveItem =>
      operatorTurn({ index: turn, text, at: at(seconds), after: 0 }),
    reply: (text: string, seconds: number): LiveItem =>
      base({
        id: `activity:${String((activity += 1))}`,
        kind: "turn.reply",
        at: at(seconds),
        headline: "Importer",
        body: text,
      }),
    /** A tool call and the result that answers it; a `result` of `null` is a call in flight. */
    call: (
      name: string,
      args: Record<string, unknown>,
      result: string | null,
      seconds: number,
    ): readonly LiveItem[] => {
      call += 1;
      const callId = `${prefix}_${String(call).padStart(2, "0")}`;
      const tool = name === "fetch_page" ? name : `mcp__bit-importer__${name}`;
      const calling = base({
        id: `activity:${String((activity += 1))}`,
        kind: "tool.call",
        at: at(seconds),
        headline: name,
        tool,
        toolName: name,
        callId,
        input: JSON.stringify(args),
      });
      if (result === null) return [calling];
      return [
        calling,
        base({
          id: `activity:${String((activity += 1))}`,
          kind: "tool.result",
          at: at(seconds + 1),
          headline: name,
          tool,
          toolName: name,
          callId,
          output: result,
          outcome: "ok",
        }),
      ];
    },
    /** A committed record: the store's id, the store's sequence. */
    record: (
      kind: string,
      headline: string,
      body: string,
      seconds: number,
    ): LiveItem =>
      base({
        id: `record:evt_${prefix}_${String((sequence += 1))}`,
        origin: "record",
        sequence,
        kind,
        at: at(seconds),
        headline,
        body,
      }),
  };
};

const entryBody = (
  host: string,
  effect: "in" | "out",
  subdomains: boolean,
  source: string,
): string =>
  `${host}${subdomains ? " and every subdomain" : ", host only"}, ${effect} of scope. Source ${source}.`;

type Stage = "streaming" | "complete" | "records-only";

/**
 * Today's session, which D3 and D4 share: the same conversation caught mid-stream and
 * caught complete.
 *
 * Written once with a `stage` rather than as two fixtures, so the streaming state is
 * literally a prefix of the finished one and the two cannot drift apart. `records-only` is
 * what a reloaded tab holds of it — the committed rows, and none of the calls or words.
 */
const todaySession = (now: number, stage: Stage): ImporterSession => {
  const startedAt = now - 41 * MINUTE;
  const f = feed("tod", startedAt);
  const items: LiveItem[] = [];

  const entry = (
    n: number,
    host: string,
    effect: "in" | "out",
    subdomains: boolean,
    source: string,
    seconds: number,
    settled = true,
  ): void => {
    items.push(
      ...f.call(
        "write_scope_entry",
        { host, subdomains, direction: effect, source },
        settled ? `entry ${String(n)} created` : null,
        seconds,
      ),
    );
    if (settled) {
      items.push(
        f.record(
          "scope.entry.added",
          host,
          entryBody(host, effect, subdomains, source),
          seconds + 1,
        ),
      );
    }
  };
  const asset = (host: string, seconds: number): void => {
    items.push(
      ...f.call("record_asset", { host }, `asset recorded: ${host}`, seconds),
      f.record(
        "asset.recorded",
        host,
        `${host} recorded as an asset of acme-corp.`,
        seconds + 1,
      ),
    );
  };

  items.push(
    f.operator(
      1,
      "Load the scope from https://hackerone.com/acme/policy — and the SOW says the partner portal is in too.",
      0,
    ),
    f.reply("Fetching the policy page.", 2),
    ...f.call(
      "fetch_page",
      { url: "https://hackerone.com/acme/policy" },
      "200 · 48 KB · scope table found at line 212",
      3,
    ),
    f.reply(
      "The table has five rows. Three are in scope — acme.com and acmelabs.io are written with wildcards, so I am taking them as the host and every subdomain. Writing them now.",
      8,
    ),
  );
  entry(1, "acme.com", "in", true, "policy:212", 10);
  entry(2, "acmelabs.io", "in", true, "policy:213", 14);
  entry(3, "203.0.113.0/24", "in", false, "policy:216", 18);
  items.push(
    f.reply(
      "Row four reads “No WordPress properties”, which is prose rather than a host. The only WordPress property the page names is blog.acme.com, so I am writing that one host out and leaving the rule itself for you —",
      24,
    ),
  );

  if (stage === "streaming") {
    // The write in flight: the call has gone out and neither its result nor its record has
    // come back. It is `pending` for exactly as long as the importer is working.
    entry(4, "blog.acme.com", "out", true, "policy:214", 27, false);
    return {
      id: "ses_today",
      startedAt,
      model: IMPORTER_MODEL,
      history: NO_HISTORY,
      items,
      working: true,
      tally: { in: 3, out: 0, assets: 0, messages: 1 },
      reading: false,
    };
  }

  entry(4, "blog.acme.com", "out", true, "policy:214", 27);
  items.push(
    f.reply(
      "Row five, status.acme.com, is hosted by a third party and the page says so. That one is out.",
      31,
    ),
  );
  entry(5, "status.acme.com", "out", false, "policy:215", 33);
  items.push(f.reply("Now the hosts the page names, as assets.", 38));
  asset("acme.com", 40);
  asset("www.acme.com", 43);
  asset("shop.acme.com", 46);
  items.push(
    f.reply(
      "…that is the whole table. I wrote 3 in-scope entries and 2 out, and recorded 3 hosts as assets. One row I could not turn into an entry: “No WordPress properties” — I excluded blog.acme.com because the page names it, but the rule may reach further.",
      52,
    ),
    f.operator(
      2,
      "It does — shop.acme.com is WordPress too. Put it out, and the partner portal app.partner.com is in, host only, no subdomains.",
      180,
    ),
    f.reply("Two entries to write, and one asset to relabel.", 182),
  );
  entry(6, "shop.acme.com", "out", true, "operator", 184);
  entry(7, "app.partner.com", "in", false, "operator", 188);
  items.push(
    ...f.call(
      "relabel_asset",
      { host: "shop.acme.com", label: "excluded" },
      "already recorded, relabelled excluded",
      192,
    ),
    f.reply(
      "Both written. The partner portal is host-only, so a subdomain of it found later will come back uncovered rather than in scope. The scope now reads 4 in, 3 out. Anything else from the SOW that the program page would not know about?",
      196,
    ),
  );

  return {
    id: "ses_today",
    startedAt,
    model: IMPORTER_MODEL,
    history: NO_HISTORY,
    items:
      stage === "records-only"
        ? items.filter((item) => item.origin === "record")
        : items,
    working: false,
    tally: { in: 4, out: 3, assets: 3, messages: 4 },
    reading: false,
  };
};

/** The streaming session of D3. */
export const mockStreamingSession = (now: number): ImporterSession =>
  todaySession(now, "streaming");

/** The finished two-turn session of D4. */
export const mockCompletedSession = (now: number): ImporterSession =>
  todaySession(now, "complete");

/**
 * Today's session as a reloaded tab sees it with the harness **still holding** it: the
 * words come back as the harness's copy, the records come back as records, and the tool
 * calls are not anywhere.
 */
export const mockReloadedSession = (now: number): ImporterSession => ({
  ...todaySession(now, "records-only"),
  history: {
    source: "harness",
    note: "The harness still holds this session's messages. This is its copy, not ours, and it may delete it.",
    truncated: false,
    messages: [
      {
        index: 0,
        type: "user",
        text: "Load the scope from https://hackerone.com/acme/policy — and the SOW says the partner portal is in too.",
      },
      {
        index: 1,
        type: "assistant",
        text: "The table has five rows. Three are in scope — acme.com and acmelabs.io are written with wildcards, so I am taking them as the host and every subdomain.",
      },
      {
        index: 2,
        type: "assistant",
        text: "…that is the whole table. I wrote 3 in-scope entries and 2 out, and recorded 3 hosts as assets. One row I could not turn into an entry: “No WordPress properties” — I excluded blog.acme.com because the page names it, but the rule may reach further.",
      },
      {
        index: 3,
        type: "user",
        text: "It does — shop.acme.com is WordPress too. Put it out, and the partner portal app.partner.com is in, host only, no subdomains.",
      },
      {
        index: 4,
        type: "assistant",
        text: "Both written. The partner portal is host-only, so a subdomain of it found later will come back uncovered rather than in scope. The scope now reads 4 in, 3 out. Anything else from the SOW that the program page would not know about?",
      },
    ],
  },
});

/**
 * A session the operator has sent one message into and nothing has answered yet: the
 * `pending` state, with the importer working so Stop is on offer.
 */
export const mockAwaitingSession = (now: number): ImporterSession => {
  const f = feed("awa", now - 20_000);
  return {
    id: "ses_awaiting",
    startedAt: now - 20_000,
    model: IMPORTER_MODEL,
    history: NO_HISTORY,
    items: [
      f.operator(
        1,
        "Read https://bugcrowd.com/engagements/acme-corp and load what is in scope.",
        0,
      ),
    ],
    working: true,
    tally: { in: 0, out: 0, assets: 0, messages: 1 },
    reading: false,
  };
};

/** An empty session. */
export const mockNewSession = (
  now: number,
  id = "ses_new",
): ImporterSession => ({
  id,
  startedAt: now,
  model: IMPORTER_MODEL,
  history: NO_HISTORY,
  items: [],
  working: false,
  tally: { in: 0, out: 0, assets: 0, messages: 0 },
  reading: false,
});

/**
 * The session from nine days ago, where the importer asked a question and the operator
 * never answered it. Its words are still with the harness; it wrote nothing.
 */
const questionSession = (now: number): ImporterSession => ({
  id: "ses_question",
  startedAt: now - 9 * DAY,
  model: "anthropic/claude-code",
  history: {
    source: "harness",
    note: "The harness still holds this session's messages. This is its copy, not ours, and it may delete it.",
    truncated: false,
    messages: [
      {
        index: 0,
        type: "user",
        text: "Here is the SOW for Acme. The scope is whatever the Q4 pentest covers.",
      },
      {
        index: 1,
        type: "assistant",
        text: "The statement of work says the Q4 pentest covers “the customer-facing web estate” and names no hosts. I will not guess at them. Which hosts or address blocks does that mean?",
      },
    ],
  },
  items: [],
  working: false,
  tally: { in: 0, out: 0, assets: 0, messages: 2 },
  reading: true,
});

/**
 * The session from twelve days ago, whose conversation the harness has since deleted. What
 * it recorded is still on the record; what was said is gone — the expected answer for an
 * old session, and a note rather than a fault.
 */
export const mockForgottenSession = (now: number): ImporterSession => {
  const f = feed("old", now - 12 * DAY);
  const items: LiveItem[] = [];
  const hosts: readonly (readonly [string, boolean])[] = [
    ["acme.com", true],
    ["acmelabs.io", true],
    ["203.0.113.0/24", false],
  ];
  hosts.forEach(([host, subdomains], index) => {
    items.push(
      f.record(
        "scope.entry.added",
        host,
        entryBody(host, "in", subdomains, "policy"),
        10 + index,
      ),
    );
  });
  for (const host of [
    "acme.com",
    "www.acme.com",
    "api.acme.com",
    "api.acmelabs.io",
    "203.0.113.7",
  ]) {
    items.push(
      f.record(
        "asset.recorded",
        host,
        `${host} recorded as an asset of acme-corp.`,
        20,
      ),
    );
  }
  return {
    id: "ses_forgotten",
    startedAt: now - 12 * DAY,
    model: "openai/gpt-5.5",
    history: {
      source: "forgotten",
      note: "The harness no longer has this session, so what was said in it is gone. What it recorded is below, and on the Assets page.",
      truncated: false,
      messages: [],
    },
    items,
    working: false,
    tally: { in: 3, out: 0, assets: 5, messages: 9 },
    reading: true,
  };
};

/** The same session while the harness has not yet answered: the `loading` state. */
export const mockOpeningSession = (now: number): ImporterSession => ({
  ...mockForgottenSession(now),
  history: { source: "loading", note: "", truncated: false, messages: [] },
});

/** Sessions earlier than today's, newest first, for the picker. */
export const mockEarlierSessions = (now: number): ImporterSession[] => [
  questionSession(now),
  mockForgottenSession(now),
];
