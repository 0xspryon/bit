/**
 * The scope importer's tool surface, over real HTTP against a real SQLite file.
 *
 * **The first half of this file is the only test in the slice that guards an authorization
 * boundary, and it is written to fail loudly if the boundary moves.** D13 gives the
 * importer `add_scope_entry`, which writes the list every later agent is judged against.
 * `DECISIONS.md` §5 names an agent widening its own scope as the defect the whole scope
 * model exists to prevent, and the design's own anti-goals say the importer is not an
 * exception to it — the difference is *structural*: a different role on a different
 * endpoint, running before any goal exists, unable to test anything.
 *
 * "Structural" is a claim about wiring, so it is checked as one:
 *
 * - A worker attempt, a planner round and a goal agent are each offered **none** of the
 *   three, on their own endpoints, by reading the whole `tools/list`.
 * - Each of those three credentials is presented **at the importer's endpoint** and
 *   refused `401` before any tool list is produced.
 * - An importer credential is presented at each of the other three endpoints and refused
 *   `401` there.
 *
 * The first set is what catches the `Layer.fresh` mistake `mcp/server.ts`'s header records
 * — without it every path serves one merged toolkit, which would hand a worker
 * `add_scope_entry` not as a decision but as a layer that was not wrapped.
 *
 * The second half drives the three tools for real: an entry written here carries
 * `source = 'imported'` and the page it came from, and a contradiction between two pages
 * is refused with the entry it clashed with.
 *
 * `ManagedRuntime` owns the layer stack's scope and the envelope helper is
 * `plannerTools.test.ts`'s: the 2026-07-28 revision is stateless, so every request carries
 * its own protocol metadata and a test that hand-rolled part of it would be asserting
 * against its own mistake.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";

import { IMPORTER_AGENT } from "../agent/registry";
import { ScopeImportProgress } from "../import/progress";
import {
  ObservationStore,
  operatorScope,
  type AttemptCaller,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { McpCredentials } from "./credentials";
import { McpCallCounter } from "./server";
import { ControlPlaneEndpoint } from "../http/controlPlane";
import { DEFAULT_POLICY, PolicyDecisions } from "../policy/service";

const directory = mkdtempSync(join(tmpdir(), "bit-importer-tools-"));
const databaseFile = join(directory, "hunt.sqlite");

const TARGET = "target-1";
const GOAL = "goal-1";
const ROUND = "rnd-1";
const IMPORT = "imp-1";
/** An import the operator ended (`0026`, `0027`), for the gate behind a no-clock grant. */
const IMPORT_ENDED = "imp-ended";
/**
 * The ends that are this process letting go rather than the authority ending (`0027`). Each
 * gets an import of its own, ended for that reason, with a live credential.
 */
const LET_GO = ["shutdown", "refused", "open_failed"] as const;
const letGoImport = (reason: (typeof LET_GO)[number]) => `imp-let-go-${reason}`;
const BUDGET = 3;

const HOST = { callerScope: operatorScope(TARGET), targetId: TARGET } as const;

const ATTEMPT: AttemptCaller = {
  _tag: "attempt",
  callerScope: `${TARGET}/attempt-1`,
  targetId: TARGET,
  intentId: "intent-1",
  attemptId: "attempt-1",
  harnessSessionId: "ses_worker",
  workerId: "worker-1",
  attemptFence: 0,
};

/** The page URLs the importer is pretending to have read. */
const PAGE_A = "https://hackerone.com/acme/policy";
const PAGE_B = "https://bugcrowd.com/acme-corp";

/**
 * Every credential this suite needs, minted into a scope that outlives the tests.
 *
 * One layer rather than a `beforeAll`, for `plannerTools.test.ts`'s reason: `issue` is an
 * `acquireRelease`, so a credential minted inside a bare effect is revoked the moment that
 * effect ends. The rows the round and attempt credentials refer to have to exist before
 * they are minted, which in a layer is simply the order of the statements.
 */
class Seeded extends Context.Service<
  Seeded,
  {
    readonly importerToken: string;
    readonly workerToken: string;
    readonly roundToken: string;
    readonly goalToken: string;
    readonly endedImporterToken: string;
    readonly letGoTokens: Readonly<Record<(typeof LET_GO)[number], string>>;
  }
>()("test/ImporterSeeded") {
  static readonly layer = Layer.effect(
    Seeded,
    Effect.gen(function* () {
      const store = yield* ObservationStore;
      const credentials = yield* McpCredentials;
      const progress = yield* ScopeImportProgress;

      yield* store.seedAttempt({
        targetId: TARGET,
        goalId: GOAL,
        goal: "Determine whether authentication rate limits can be bypassed.",
        intentId: ATTEMPT.intentId,
        question: "Probe the per-client limiter.",
        attemptId: ATTEMPT.attemptId,
        workerId: ATTEMPT.workerId,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        modelOptions: null,
        harnessSessionId: ATTEMPT.harnessSessionId,
      });
      const planned = yield* store.openRound(HOST, {
        goalId: GOAL,
        roundId: ROUND,
        budget: BUDGET,
        harnessInstanceId: "opencode",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        harnessSessionId: "ses_planner",
      });

      // The import, registered so the toolkit's progress records land somewhere. The real
      // importer does this before it forks its session fiber.
      yield* progress.open({
        importId: IMPORT,
        targetId: TARGET,
        urls: [PAGE_A, PAGE_B],
        droppedLinks: 0,
        harnessInstanceId: "opencode",
        model: "opencode/glm-5.3-flash-free",
      });

      const importer = yield* credentials.issueImport({
        _tag: "importer",
        targetId: TARGET,
        importId: IMPORT,
      });
      const worker = yield* credentials.issue({
        _tag: "attempt",
        targetId: TARGET,
        intentId: ATTEMPT.intentId,
        attemptId: ATTEMPT.attemptId,
        harnessSessionId: ATTEMPT.harnessSessionId,
        workerId: ATTEMPT.workerId,
        attemptFence: 0,
      });
      const round = yield* credentials.issue({
        _tag: "round",
        targetId: TARGET,
        goalId: GOAL,
        roundId: ROUND,
        roundFence: planned.writeFence,
      });
      const goal = yield* credentials.issueWithoutExpiry({
        _tag: "goal",
        targetId: TARGET,
        goalId: GOAL,
      });

      // An import that has ended, with a live credential still in hand: what a grant whose
      // scope was somehow not closed looks like. Minted the way the importer session now
      // mints its own — no clock — so the only thing that can refuse it is the column.
      yield* progress.open({
        importId: IMPORT_ENDED,
        targetId: TARGET,
        urls: [PAGE_A],
        droppedLinks: 0,
        harnessInstanceId: "opencode",
        model: "opencode/glm-5.3-flash-free",
      });
      yield* store.recordImportSession({
        importId: IMPORT_ENDED,
        targetId: TARGET,
        harnessSessionId: "ses_ended",
        harnessInstanceId: "opencode",
        model: "opencode/glm-5.3-flash-free",
        agentId: "importer",
      });
      yield* store.confirmImportSession(IMPORT_ENDED);
      yield* store.endImportSession(IMPORT_ENDED, "operator");
      const ended = yield* credentials.issueWithoutExpiry({
        _tag: "importer",
        targetId: TARGET,
        importId: IMPORT_ENDED,
      });

      // Ended for each reason that is not the operator's, each with a live credential: what
      // a later authority period on a continued session would hold (S7).
      const letGo: Record<string, string> = {};
      for (const reason of LET_GO) {
        const importId = letGoImport(reason);
        yield* progress.open({
          importId,
          targetId: TARGET,
          urls: [PAGE_A],
          droppedLinks: 0,
          harnessInstanceId: "opencode",
          model: "opencode/glm-5.3-flash-free",
        });
        yield* store.recordImportSession({
          importId,
          targetId: TARGET,
          harnessSessionId: `ses_${reason}`,
          harnessInstanceId: "opencode",
          model: "opencode/glm-5.3-flash-free",
          agentId: "importer",
        });
        yield* store.confirmImportSession(importId);
        yield* store.endImportSession(importId, reason);
        const issued = yield* credentials.issueWithoutExpiry({
          _tag: "importer",
          targetId: TARGET,
          importId,
        });
        letGo[reason] = Redacted.value(issued.token);
      }

      return Seeded.of({
        importerToken: Redacted.value(importer.token),
        workerToken: Redacted.value(worker.token),
        roundToken: Redacted.value(round.token),
        goalToken: Redacted.value(goal.token),
        endedImporterToken: Redacted.value(ended.token),
        letGoTokens: {
          shutdown: letGo["shutdown"] ?? "",
          refused: letGo["refused"] ?? "",
          open_failed: letGo["open_failed"] ?? "",
        },
      });
    }),
  );
}

/**
 * The endpoint, with the progress registry handed in rather than rebuilt.
 *
 * `Layer.unwrap` over `Effect.context` is the move `main.ts` makes, and it is here for
 * exactly the reason that file's header gives: `ControlPlaneEndpoint` builds the router's
 * application layer through `HttpRouter.toWebHandler`, which uses **its own memo map**, so
 * a layer merely *provided* as `scopeImports` is built a second time. The toolkit would
 * then record into one registry while this suite read another — every call landing, the
 * receipt blank — and `the panel's receipt` below would fail with an empty list.
 *
 * Reading the instance out of this graph and passing it as a value is what makes the
 * assertions on `progress.view` assertions about the registry the server actually writes.
 */
const endpoint = Layer.unwrap(
  Effect.map(Effect.context<ScopeImportProgress>(), (shared) =>
    ControlPlaneEndpoint.layer({
      policy: DEFAULT_POLICY,
      scopeImports: Layer.succeed(
        ScopeImportProgress,
        Context.get(shared, ScopeImportProgress),
      ),
    }),
  ),
);

const testLayer = Layer.mergeAll(endpoint, Seeded.layer).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provideMerge(ScopeImportProgress.layer),
  Layer.provideMerge(ObservationStore.layer(databaseFile)),
  Layer.provideMerge(
    TargetStores.ofStore(TARGET).pipe(
      Layer.provide(ObservationStore.layer(databaseFile)),
    ),
  ),
);

const runtime = ManagedRuntime.make(testLayer);

let importerUrl = "";
let workerUrl = "";
let plannerUrl = "";
let goalUrl = "";
let importerToken = "";
let workerToken = "";
let roundToken = "";
let goalToken = "";
let endedImporterToken = "";
let letGoTokens: Readonly<Record<(typeof LET_GO)[number], string>> = {
  shutdown: "",
  refused: "",
  open_failed: "",
};

beforeAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const endpoint = yield* ControlPlaneEndpoint;
      const seeded = yield* Seeded;
      importerUrl = endpoint.importerMcpUrl;
      workerUrl = endpoint.mcpUrl;
      plannerUrl = endpoint.plannerMcpUrl;
      goalUrl = endpoint.goalMcpUrl;
      importerToken = seeded.importerToken;
      workerToken = seeded.workerToken;
      roundToken = seeded.roundToken;
      goalToken = seeded.goalToken;
      endedImporterToken = seeded.endedImporterToken;
      letGoTokens = seeded.letGoTokens;
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
});

let nextId = 1;
const PROTOCOL_VERSION = "2026-07-28";

const ROUTING_KEY: Record<string, "name" | "uri" | undefined> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

const envelope = (params: unknown): unknown => {
  const base = (params ?? {}) as Record<string, unknown>;
  return {
    ...base,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
};

const rpc = async (
  url: string,
  method: string,
  params: unknown,
  bearer: string | null,
) => {
  const routingKey = ROUTING_KEY[method];
  const routedName =
    routingKey === undefined
      ? undefined
      : (params as Record<string, unknown> | undefined)?.[routingKey];
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(typeof routedName === "string" ? { "mcp-name": routedName } : {}),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: envelope(params),
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body:
      text.length > 0 && text.startsWith("{")
        ? (JSON.parse(text) as Record<string, unknown>)
        : null,
  };
};

const toolNames = async (url: string, bearer: string): Promise<string[]> => {
  const listed = await rpc(url, "tools/list", {}, bearer);
  expect(listed.status).toBe(200);
  const result = listed.body?.["result"] as
    { readonly tools?: readonly { readonly name: string }[] } | undefined;
  return [...(result?.tools ?? [])].map((tool) => tool.name).sort();
};

/** The content of a tool result, decoded, or the structured refusal it returned. */
const callTool = async (
  url: string,
  bearer: string,
  name: string,
  args: Record<string, unknown>,
) => {
  const called = await rpc(
    url,
    "tools/call",
    { name, arguments: args },
    bearer,
  );
  expect(called.status).toBe(200);
  const result = called.body?.["result"] as
    | {
        readonly isError?: boolean;
        readonly structuredContent?: unknown;
        readonly content?: readonly { readonly text?: string }[];
      }
    | undefined;
  return {
    isError: result?.isError === true,
    structured: result?.structuredContent,
    text: result?.content?.[0]?.text ?? "",
  };
};

const IMPORTER_TOOLS = [
  "add_scope_entry",
  "read_scope",
  "record_imported_asset",
];

describe("the importer's three tools exist here and nowhere else", () => {
  test("the importer is offered exactly the three", async () => {
    expect(await toolNames(importerUrl, importerToken)).toEqual(IMPORTER_TOOLS);
    // And the importer agent's declared authority is what the endpoint serves.
    expect([...IMPORTER_AGENT.authority.tools].sort()).toEqual(IMPORTER_TOOLS);
  });

  test("a worker attempt is offered none of them", async () => {
    const offered = await toolNames(workerUrl, workerToken);
    // Asserted as the whole list rather than as three absences, so a fourth tool
    // appearing on the worker's endpoint has to be a deliberate edit to this line.
    expect(offered).toEqual([
      "list_assets",
      "record_asset",
      "record_observation",
    ]);
    for (const tool of IMPORTER_TOOLS) expect(offered).not.toContain(tool);
  });

  test("a planner round is offered none of them", async () => {
    const offered = await toolNames(plannerUrl, roundToken);
    for (const tool of IMPORTER_TOOLS) expect(offered).not.toContain(tool);
  });

  test("a goal session is offered none of them", async () => {
    const offered = await toolNames(goalUrl, goalToken);
    for (const tool of IMPORTER_TOOLS) expect(offered).not.toContain(tool);
  });

  test("a worker, a planner and a goal credential are all refused at the importer's door", async () => {
    // `401` before protocol dispatch, so none of them gets a tool list, an `initialize`,
    // or the knowledge that the path exists. The refusal is deliberately the same `401`
    // with the same body as an unknown token: a distinct sentence for "valid credential,
    // wrong endpoint" would tell a caller that the credential it holds is real.
    for (const token of [workerToken, roundToken, goalToken]) {
      const listed = await rpc(importerUrl, "tools/list", {}, token);
      expect(listed.status).toBe(401);
    }
  });

  test("and an importer credential buys nothing at the other three doors", async () => {
    for (const url of [workerUrl, plannerUrl, goalUrl]) {
      const listed = await rpc(url, "tools/list", {}, importerToken);
      expect(listed.status).toBe(401);
    }
  });

  test("no credential at all is refused", async () => {
    const listed = await rpc(importerUrl, "tools/list", {}, null);
    expect(listed.status).toBe(401);
  });
});

describe("add_scope_entry", () => {
  test("an entry it writes is marked imported and says which page it came from", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "subtree",
        value: "acme.com",
        source_url: PAGE_A,
        note: "scope table, row 1",
      },
    );
    expect(called.isError).toBe(false);
    expect(called.structured).toMatchObject({
      effect: "in",
      kind: "subtree",
      value: "acme.com",
      created: true,
    });
    // The rendered sentence is the one every other surface shows, from
    // `describeScopeEntry`. An importer told only `created: true` could not notice it had
    // written the narrower reading of an ambiguous page; one told "and every subdomain"
    // can.
    expect(called.structured).toMatchObject({
      covers: expect.stringContaining("every subdomain"),
    });

    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.targetScope(TARGET)),
    );
    const entry = stored.entries.find((row) => row.value === "acme.com");
    // `source = 'imported'` is not an argument of the tool and is set from the
    // credential's kind. This is the assertion the operator's whole review rests on: an
    // imported row has to be distinguishable from one they typed.
    expect(entry?.source).toBe("imported");
    // And the note carries the page *and* the place on it. `scope_entries.note` is one
    // column and D2 says it holds "where on the page it came from" — the page is part of
    // that, so both arguments are composed rather than one dropped.
    expect(entry?.note).toBe(`${PAGE_A} · scope table, row 1`);
  });

  test("a second page contradicting the first is refused, naming the entry it clashed with", async () => {
    // D2's direct contradiction, and for the importer it is the most interesting refusal
    // it can earn: it is reading several pages in one session precisely so that it can
    // notice when they disagree.
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "out",
        kind: "subtree",
        value: "acme.com",
        source_url: PAGE_B,
        note: "out of scope, item 1",
      },
    );
    expect(called.isError).toBe(true);
    expect(called.text).toContain("conflict");
    expect(called.text).toContain("acme.com");
  });

  test("writing the same entry twice writes nothing and is not an error", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "subtree",
        value: "acme.com",
        source_url: PAGE_B,
        note: "in-scope targets",
      },
    );
    expect(called.isError).toBe(false);
    expect(called.structured).toMatchObject({ created: false });
  });

  test("an unparseable value is refused with the normaliser's own sentence", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "cidr",
        value: "not-a-block",
        source_url: PAGE_A,
        note: "in-scope targets",
      },
    );
    expect(called.isError).toBe(true);
    expect(called.text).toContain("invalid");
  });

  test("a value naming a user before the host is refused, and no host is guessed", async () => {
    // A program page's link is attacker-written. Read with userinfo cut at the last `@`,
    // this was stored as evil.com; with the authority ended first it would be acme.com.
    // The `user@` is refused either way, so neither host is written.
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "host",
        value: "https://evil.com@acme.com/x@evil.com",
        source_url: PAGE_A,
        note: "in-scope targets",
      },
    );
    expect(called.isError).toBe(true);
    expect(called.text).toContain("names a user before the host");
    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.targetScope(TARGET)),
    );
    expect(stored.entries.map((entry) => entry.value)).not.toContain(
      "evil.com",
    );
  });
});

describe("record_imported_asset", () => {
  test("it records a host with no intent and no attempt, and reports its scope state", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "record_imported_asset",
      {
        operation_id: "op-import-1",
        kind: "host",
        url: "https://app.acme.com",
        method: null,
        source_url: PAGE_A,
        note: "scope table, row 1",
      },
    );
    expect(called.isError).toBe(false);
    expect(called.structured).toMatchObject({
      kind: "host",
      created: true,
      replayed: false,
      imports: 1,
      // Covered by the `in`/`subtree` entry written above, from the same ladder the Scope
      // tab reads. The importer is the caller with the most to lose from a second
      // implementation of it: it just wrote the entry this is derived from.
      scope_state: "in",
    });
  });

  test("an exact retry replays and writes nothing", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "record_imported_asset",
      {
        operation_id: "op-import-1",
        kind: "host",
        url: "https://app.acme.com",
        method: null,
        source_url: PAGE_A,
        note: "scope table, row 1",
      },
    );
    expect(called.isError).toBe(false);
    expect(called.structured).toMatchObject({ replayed: true, imports: 1 });
  });

  test("a host no entry covers comes back out, which is the disagreement worth reporting", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "record_imported_asset",
      {
        operation_id: "op-import-2",
        kind: "host",
        url: "https://unrelated.example.test",
        method: null,
        source_url: PAGE_B,
        note: "mentioned in the policy text",
      },
    );
    expect(called.isError).toBe(false);
    expect(called.structured).toMatchObject({ scope_state: "out" });
  });
});

describe("read_scope", () => {
  test("it reads back what has been written, with each entry's coverage spelled out", async () => {
    const called = await callTool(importerUrl, importerToken, "read_scope", {});
    expect(called.isError).toBe(false);
    const result = called.structured as {
      readonly total: number;
      readonly entries: readonly {
        readonly value: string;
        readonly source: string;
        readonly covers: string;
      }[];
    };
    expect(result.total).toBe(result.entries.length);
    const acme = result.entries.find((entry) => entry.value === "acme.com");
    expect(acme?.source).toBe("imported");
    expect(acme?.covers).toContain("every subdomain");
  });
});

describe("the panel's receipt", () => {
  test("it lists the calls that landed, with the page each named, and no narration", async () => {
    const view = await runtime.runPromise(
      Effect.flatMap(ScopeImportProgress, (progress) => progress.view(IMPORT)),
    );
    expect(view).toBeDefined();
    const calls = view?.calls ?? [];

    // Every recorded call is one of the three tools. There is no field on the view for
    // narration and nothing in this process subscribes to the importer's session events,
    // so a reasoning line cannot appear here — which is D16 as a property of the wiring
    // rather than as a filter. If narration were ever captured, this assertion is where a
    // fourth kind of entry would show up.
    for (const call of calls) {
      expect(IMPORTER_TOOLS).toContain(call.tool);
    }

    // Refused calls are not on the receipt. Five `add_scope_entry` calls were made above
    // and three were refused — the contradiction, the bad CIDR and the value with a user
    // before its host — so two entries landed:
    // the original and the idempotent duplicate, which really was a call the importer
    // made and which the operator should see it make.
    const entryCalls = calls.filter((call) => call.tool === "add_scope_entry");
    expect(entryCalls).toHaveLength(2);
    for (const call of entryCalls) expect(call.wrote).toContain("acme.com");

    // The replayed import is not on it either: a replay wrote nothing, and the original
    // call is already there.
    const assetCalls = calls.filter(
      (call) => call.tool === "record_imported_asset",
    );
    expect(assetCalls).toHaveLength(2);

    // A read names no page, so it cannot be what marks a link reached.
    const reads = calls.filter((call) => call.tool === "read_scope");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.sourceUrl).toBeNull();

    // Per-link progress, derived from those `sourceUrl`s and from nothing else.
    expect(view?.links.map((link) => link.url)).toEqual([PAGE_A, PAGE_B]);
    expect(view?.links[0]?.state).toBe("read");
    expect(view?.links[1]?.state).toBe("reading");
    expect(view?.totals).toMatchObject({ entriesIn: 2, assets: 2 });
  });
});

/**
 * The page an entry is attributed to is the handler's fact, not the model's.
 *
 * `source_url` is a tool argument, so left unchecked it is the model's choice of which
 * page to blame an entry on — and the pages are untrusted input whose payoff is exactly
 * that: an entry naming someone else's domain, attributed to a page the operator trusts.
 * The operator reads that note to decide whether to trust the row, so the server resolves
 * the argument against this import's own links, refuses anything else, and stores its own
 * spelling of the page rather than the one it was sent.
 *
 * Last in the file on purpose: the refusals write nothing, and the accepted near miss
 * would otherwise change the call counts `the panel's receipt` above asserts.
 */
describe("source_url must be one of this import's own pages", () => {
  test("an entry attributed to a page this import was not given is refused", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "subtree",
        value: "attacker.example.test",
        source_url: "https://attacker.example.test/scope",
        note: "the in-scope table",
      },
    );
    expect(called.isError).toBe(true);
    expect(called.text).toContain("invalid");
    // The refusal names the pages this import does have, because the common and innocent
    // case is a model that mistyped one of them and can correct itself.
    expect(called.text).toContain(PAGE_A);

    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.targetScope(TARGET)),
    );
    expect(
      stored.entries.some((entry) => entry.value === "attacker.example.test"),
    ).toBe(false);
  });

  test("an asset attributed to one is refused on the same ground", async () => {
    const called = await callTool(
      importerUrl,
      importerToken,
      "record_imported_asset",
      {
        operation_id: "op-import-foreign",
        kind: "host",
        url: "https://host.attacker.example.test",
        method: null,
        source_url: "https://attacker.example.test/scope",
        note: "the in-scope table",
      },
    );
    expect(called.isError).toBe(true);
    expect(called.text).toContain("invalid");
  });

  test("a near miss of a real link is accepted and stored in the operator's spelling", async () => {
    // The importer retypes the URL it was given, so a trailing slash is the normal case
    // rather than an attack. What is stored is the operator's own string: the note is read
    // beside the link list on the panel, and two spellings of one page there would read as
    // two pages.
    const called = await callTool(
      importerUrl,
      importerToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "host",
        value: "near.acme.com",
        source_url: `${PAGE_A}/`,
        note: "scope table, row 4",
      },
    );
    expect(called.isError).toBe(false);

    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.targetScope(TARGET)),
    );
    const entry = stored.entries.find((row) => row.value === "near.acme.com");
    expect(entry?.note).toBe(`${PAGE_A} · scope table, row 4`);
  });
});

describe("an import whose session has ended", () => {
  test("refuses every write after the operator ended it, even under a credential that is still live", async () => {
    // `checkGoalAuthority`'s analogue: a no-clock importer grant has the column behind it.
    const entry = await callTool(
      importerUrl,
      endedImporterToken,
      "add_scope_entry",
      {
        effect: "in",
        kind: "host",
        value: "after-the-end.acme.com",
        source_url: PAGE_A,
        note: "scope table, row 9",
      },
    );
    expect(entry.isError).toBe(true);
    expect(entry.text).toContain("unauthorized");
    expect(entry.text).toContain("ended by the operator");

    const asset = await callTool(
      importerUrl,
      endedImporterToken,
      "record_imported_asset",
      {
        operation_id: "op-after-the-end",
        kind: "host",
        url: "https://after-the-end.acme.com",
        method: null,
        source_url: PAGE_A,
        note: "scope table, row 9",
      },
    );
    expect(asset.isError).toBe(true);
    expect(asset.text).toContain("ended by the operator");

    const stored = await runtime.runPromise(
      Effect.flatMap(ObservationStore, (store) => store.targetScope(TARGET)),
    );
    expect(
      stored.entries.some((row) => row.value === "after-the-end.acme.com"),
    ).toBe(false);
  });

  test.each(LET_GO)(
    "does not refuse a write after a %s end, because the process let go rather than the authority ending",
    async (reason) => {
      // The grant here is what a later authority period would hold. Gating on this end is
      // what would stop a gracefully restarted import from being continued (S7).
      const value = `after-a-${reason.replace("_", "-")}.acme.com`;
      const entry = await callTool(
        importerUrl,
        letGoTokens[reason],
        "add_scope_entry",
        {
          effect: "in",
          kind: "host",
          value,
          source_url: PAGE_A,
          note: "scope table, row 10",
        },
      );
      expect(entry.isError).toBe(false);
      const stored = await runtime.runPromise(
        Effect.flatMap(ObservationStore, (store) => store.targetScope(TARGET)),
      );
      expect(stored.entries.some((row) => row.value === value)).toBe(true);
    },
  );

  test("still reads, because a read is not what the gate defends", async () => {
    const called = await callTool(
      importerUrl,
      endedImporterToken,
      "read_scope",
      {},
    );
    expect(called.isError).toBe(false);
  });
});
