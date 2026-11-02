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
 *
 * ## What is real in here, and what is invented
 *
 * **Everything the agent says is invented.** The prose, the order it works in, the notes it
 * writes on an entry, the questions it ends on and the numbers it reports are all written
 * by hand to look plausible. Nothing here is a specification of what the importer will say
 * or how it will behave, and none of it should be read as one; the importer's real wording
 * comes from its prompt (`importerTools.ts`) and its model.
 *
 * **The tools are real.** The importer has exactly three — `add_scope_entry`,
 * `record_imported_asset` and `read_scope` (`ScopeImportTool`, D13) — and the arguments
 * below are the shapes `importerTools.ts` declares. There is deliberately **no page-fetch
 * tool** (D13): the importer reads pages with its harness's own reader, so reading a page
 * is prose here and not a tool-call row. A row for a tool the importer does not have would
 * teach the design something false.
 *
 * **The record kinds are real events but not yet live item kinds.** `scope.entry.added` and
 * `asset.imported` are in `EventKind` and absent from `LIVE_ITEM_KINDS`, so the feed that
 * would deliver them is the API slice's to build. See `chat.ts`' `WRITE_TOOLS`.
 */
import {
  bitMcpServerName,
  claudeCodeToolName,
  type HarnessInstanceView,
  type ImporterModelView,
  type ImporterSessionView,
  type LiveItem,
  type ScopeImportTool,
} from "@bit/contracts";

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
      name: ScopeImportTool,
      args: Record<string, unknown>,
      result: {
        readonly say: string;
        readonly output: Record<string, unknown>;
      } | null,
      seconds: number,
    ): readonly LiveItem[] => {
      call += 1;
      const callId = `${prefix}_${String(call).padStart(2, "0")}`;
      // Claude Code's spelling of the importer's own MCP registration, built from the same
      // module the reducer is written against so the two cannot drift.
      const tool = claudeCodeToolName(bitMcpServerName("imp_acme"), name);
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
          // `body` is "a sentence for the operator", the server's own; the transcript prints
          // it after the arrow. The output beside it is the tool's payload, verbatim.
          body: result.say,
          output: JSON.stringify(result.output),
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

const POLICY = "https://hackerone.com/acme/policy";

type Effect = "in" | "out";
type Kind = "subtree" | "host" | "cidr";

/** What an entry covers, in the words `describeScopeEntry` uses on the Scope tab. */
const covers = (kind: Kind, value: string): string =>
  kind === "subtree"
    ? `${value} and every subdomain`
    : kind === "host"
      ? `${value}, that host only`
      : `every address in ${value}`;

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
  let entries = 0;

  /** One `add_scope_entry`, its result, and the record it produced (unless in flight). */
  const entry = (
    effect: Effect,
    kind: Kind,
    value: string,
    note: string,
    seconds: number,
    settled = true,
  ): void => {
    entries += 1;
    items.push(
      ...f.call(
        "add_scope_entry",
        { effect, kind, value, source_url: POLICY, note },
        settled
          ? {
              say: `entry ent_${String(entries)} created · ${covers(kind, value)}`,
              output: {
                entry_id: `ent_${String(entries)}`,
                effect,
                kind,
                value,
                covers: covers(kind, value),
                created: true,
              },
            }
          : null,
        seconds,
      ),
    );
    if (settled) {
      items.push(
        f.record(
          "scope.entry.added",
          value,
          `${effect} · ${kind} · ${covers(kind, value)}`,
          seconds + 1,
        ),
      );
    }
  };
  /** One `record_imported_asset`, its result, and the record it produced. */
  const asset = (host: string, scopeState: Effect, seconds: number): void => {
    items.push(
      ...f.call(
        "record_imported_asset",
        {
          url: `https://${host}`,
          kind: "host",
          method: null,
          source_url: POLICY,
          note: "Named in the scope table.",
          operation_id: `op_${host}`,
        },
        {
          say: `${host} recorded · ${scopeState === "in" ? "covered by an in-scope entry" : "excluded by an out entry"}`,
          output: {
            identity: host,
            scope_state: scopeState,
            scope_detail: `decided by the ${scopeState === "in" ? "in-scope" : "out-of-scope"} entries written so far`,
          },
        },
        seconds,
      ),
      f.record(
        "asset.imported",
        host,
        `${host} recorded as an asset of acme-corp, read off ${POLICY}.`,
        seconds + 1,
      ),
    );
  };

  // Reading the page is the harness's own reader doing the work (D13), so it is prose here
  // and not a row: the importer has no page-fetch tool.
  items.push(
    f.operator(
      1,
      `Load the scope from ${POLICY} — and the SOW says the partner portal is in too.`,
      0,
    ),
    f.reply("Reading the policy page.", 2),
    f.reply(
      "The scope table is at line 212 and has five rows. Three are in scope — `acme.com` and `acmelabs.io` are written with wildcards, so I am taking them as the apex and every subdomain. Writing them now.",
      8,
    ),
  );
  entry(
    "in",
    "subtree",
    "acme.com",
    "Row 1 of the in-scope table, written *.acme.com.",
    10,
  );
  entry(
    "in",
    "subtree",
    "acmelabs.io",
    "Row 2 of the in-scope table, written *.acmelabs.io.",
    14,
  );
  entry(
    "in",
    "cidr",
    "203.0.113.0/24",
    "Row 3 of the in-scope table, an address block.",
    18,
  );
  items.push(
    f.reply(
      "Row four reads “No WordPress properties”, which is prose rather than a host. The only WordPress property the page names is `blog.acme.com`, so I am writing that one host out and leaving the rule itself for you —",
      24,
    ),
  );

  if (stage === "streaming") {
    // The write in flight: the call has gone out and neither its result nor its record has
    // come back. It is `pending` for exactly as long as the importer is working.
    entry(
      "out",
      "host",
      "blog.acme.com",
      "Row 4: the only WordPress property the page names.",
      27,
      false,
    );
    return {
      id: "ses_today",
      startedAt,
      model: IMPORTER_MODEL,
      harness: "OpenCode",
      history: NO_HISTORY,
      items,
      working: true,
      tally: { in: 3, out: 0, assets: 0, messages: null },
      reading: false,
    };
  }

  entry(
    "out",
    "host",
    "blog.acme.com",
    "Row 4: the only WordPress property the page names.",
    27,
  );
  items.push(
    f.reply(
      "Row five, `status.acme.com`, is hosted by a third party and the page says so. That one is out.",
      31,
    ),
  );
  entry(
    "out",
    "host",
    "status.acme.com",
    "Row 5: hosted by a third party, per the page.",
    33,
  );
  items.push(f.reply("Now the hosts the page names, as assets.", 38));
  asset("acme.com", "in", 40);
  asset("shop.acme.com", "in", 43);
  asset("status.acme.com", "out", 46);
  items.push(
    f.reply(
      "…that is the whole table. I wrote 3 in-scope entries and 2 out, and recorded 3 hosts as assets. One row I could not turn into an entry: “No WordPress properties” — I excluded `blog.acme.com` because the page names it, but the rule may reach further.",
      52,
    ),
    f.operator(
      2,
      "It does — shop.acme.com is WordPress too. Put it out, and the partner portal app.partner.com is in, host only, no subdomains.",
      180,
    ),
    f.reply("Let me read back what is there before I change it.", 182),
    ...f.call(
      "read_scope",
      {},
      {
        say: "read 5 entries",
        output: {
          total: 5,
          entries: [
            {
              entry_id: "ent_1",
              effect: "in",
              kind: "subtree",
              value: "acme.com",
              source: "imported",
            },
            {
              entry_id: "ent_2",
              effect: "in",
              kind: "subtree",
              value: "acmelabs.io",
              source: "imported",
            },
            {
              entry_id: "ent_3",
              effect: "in",
              kind: "cidr",
              value: "203.0.113.0/24",
              source: "imported",
            },
            {
              entry_id: "ent_4",
              effect: "out",
              kind: "host",
              value: "blog.acme.com",
              source: "imported",
            },
            {
              entry_id: "ent_5",
              effect: "out",
              kind: "host",
              value: "status.acme.com",
              source: "imported",
            },
          ],
        },
      },
      184,
    ),
    f.reply(
      "Nothing there clashes. The policy page is the only page I was given, so both entries are attributed to it, and the notes say they come from you.",
      188,
    ),
  );
  entry(
    "out",
    "host",
    "shop.acme.com",
    "Added at the operator's instruction: also a WordPress property.",
    190,
  );
  entry(
    "in",
    "host",
    "app.partner.com",
    "Added at the operator's instruction: the partner portal, from the SOW.",
    194,
  );
  items.push(
    f.reply(
      "Both written. The partner portal is host-only, so a subdomain of it found later will come back uncovered rather than in scope. `shop.acme.com` was already recorded as an asset and will now read as out. The scope now reads 4 in, 3 out. Anything else from the SOW that the program page would not know about?",
      198,
    ),
  );

  return {
    id: "ses_today",
    startedAt,
    model: IMPORTER_MODEL,
    harness: "OpenCode",
    history: NO_HISTORY,
    items:
      stage === "records-only"
        ? items.filter((item) => item.origin === "record")
        : items,
    working: false,
    tally: { in: 4, out: 3, assets: 3, messages: null },
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
    harness: "OpenCode",
    history: NO_HISTORY,
    items: [
      f.operator(
        1,
        "Read https://bugcrowd.com/engagements/acme-corp and load what is in scope.",
        0,
      ),
    ],
    working: true,
    tally: { in: 0, out: 0, assets: 0, messages: null },
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
  harness: "OpenCode",
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
  harness: "Claude Code",
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
  tally: { in: 0, out: 0, assets: 0, messages: null },
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
  const written: readonly (readonly [Kind, string])[] = [
    ["subtree", "acme.com"],
    ["subtree", "acmelabs.io"],
    ["cidr", "203.0.113.0/24"],
  ];
  written.forEach(([kind, value], index) => {
    items.push(
      f.record(
        "scope.entry.added",
        value,
        `in · ${kind} · ${covers(kind, value)}`,
        10 + index,
      ),
    );
  });
  for (const host of [
    "acme.com",
    "app.acme.com",
    "api.acme.com",
    "acmelabs.io",
    "labs.acmelabs.io",
  ]) {
    items.push(
      f.record(
        "asset.imported",
        host,
        `${host} recorded as an asset of acme-corp, read off ${POLICY}.`,
        20,
      ),
    );
  }
  return {
    id: "ses_forgotten",
    startedAt: now - 12 * DAY,
    model: "openai/gpt-5.5",
    harness: "OpenCode",
    history: {
      source: "forgotten",
      note: "The harness no longer has this session, so what was said in it is gone. What it recorded is below, and on the Assets page.",
      truncated: false,
      messages: [],
    },
    items,
    working: false,
    tally: { in: 3, out: 0, assets: 5, messages: null },
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

/**
 * What the server would list for a target with two earlier sessions, newest first.
 *
 * The state picker's D1 scenario loads these into `app.importerIndex`, so the Assets
 * screen's "last session" strip and the picker's indexed rows can be inspected without a
 * server that has run an import. They are the contract's own view, which is the point: the
 * strip and the rows are rendered from exactly what the route answers.
 */
export const mockImporterIndex = (now: number): ImporterSessionView[] => [
  {
    sessionId: "ses_indexed_quiet",
    harnessInstanceId: "claude-code",
    model: "anthropic/claude-code",
    openedAt: now - 9 * DAY,
    running: false,
    endedAt: now - 9 * DAY + 4 * 60_000,
    endedReason: "shutdown",
    importId: "imp_indexed_quiet",
    tally: { entriesIn: 0, entriesOut: 0, assets: 0 },
  },
  {
    sessionId: "ses_indexed_wrote",
    harnessInstanceId: "opencode",
    model: "openai/gpt-5.5",
    openedAt: now - 12 * DAY,
    running: false,
    endedAt: now - 12 * DAY + 6 * 60_000,
    endedReason: "operator",
    importId: "imp_indexed_wrote",
    tally: { entriesIn: 3, entriesOut: 0, assets: 5 },
  },
];

/**
 * The harnesses the composer's chip offers while there is no server to ask.
 *
 * Mock, and shaped as the contract's `HarnessInstanceView` so `HarnessChoice` renders them
 * unmodified. The state picker loads these into `app.harnesses` for the A6 scenarios; a
 * connected app has the server's own, read by `openImporter`.
 */
export const mockHarnesses = (): HarnessInstanceView[] => [
  {
    instanceId: "opencode",
    driver: "opencode",
    displayName: "OpenCode",
    version: "2.1.2",
    ready: true,
    auth: "authenticated",
    isDefault: true,
    defaultModel: IMPORTER_MODEL,
    models: [
      // The `variant` descriptor `openCodeClient.ts` builds for a reasoning model: a Default
      // row first, then the effort ladder under its labels. So the chip's Reasoning column
      // has something to show while there is no server to ask.
      {
        id: "openai/gpt-5.6-sol",
        optionDescriptors: [
          {
            id: "variant",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "default", label: "Default", isDefault: true },
              { id: "none", label: "None" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "xhigh", label: "Extra high" },
              { id: "max", label: "Maximum" },
            ],
          },
        ],
      },
      { id: "openai/gpt-5.3-codex-spark" },
      { id: "openai/gpt-5.5" },
      { id: "openai/gpt-5.5-fast" },
      { id: "openai/gpt-5.6-luna" },
      { id: "openai/gpt-5.6-sol-fast" },
      { id: "openai/gpt-5.6-terra" },
    ],
  },
  {
    instanceId: "claude-code",
    driver: "claude_code",
    displayName: "Claude Code",
    version: "2.1.310",
    ready: true,
    auth: "authenticated",
    isDefault: false,
    defaultModel: "claude-sonnet-5",
    models: [{ id: "claude-sonnet-5" }, { id: "claude-opus-5" }],
  },
];

/** What the server would say an import runs on, resolved against `mockHarnesses`. */
export const mockImporterModel = (): ImporterModelView => ({
  instanceId: "opencode",
  model: IMPORTER_MODEL,
  origin: "preferred",
  detail: `OpenCode offers ${IMPORTER_MODEL}`,
});
