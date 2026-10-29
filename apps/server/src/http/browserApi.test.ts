/**
 * The browser API over a real listener, against real files.
 *
 * Every request here goes out through `fetch` to the port `ControlPlaneEndpoint` opened,
 * so what is asserted is what a browser would actually receive: the status, the tag and
 * the reason. Nothing is called in-process, because the parts most likely to be wrong —
 * which status an error annotation produces, whether the guard runs before the handler,
 * whether a path refusal survives serialisation — only exist on the wire.
 *
 * The fleet is on disk under a temporary root, and the folder picker's root is a second
 * temporary tree containing a symlink that points out of it. Both are deliberate: a
 * traversal refusal proven against a string comparison is a test of the string
 * comparison, and the one refusal that matters is a link *inside* the root resolving
 * outside it.
 *
 * What is **not** retested here is the three routes this API shares a listener with.
 * `controlPlane.test.ts` owns that, and it owns it from before this API existed; the one
 * thing asserted below is the part merging created — that the two token spaces did not
 * become one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIVE_HEARTBEAT_SECONDS,
  LIVE_SILENCE_LIMIT_SECONDS,
  RunRefused,
  type LiveFrame,
  type LiveItem,
  type RunningAttempt,
} from "@bit/contracts";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";

import {
  abandonRefusal,
  addIntentRefusal,
  browserApiRoutes,
  goalRefusal,
} from "./browserApi";
import { CONTROL_PLANE_IDLE_TIMEOUT } from "./controlPlane";
import { BrowserSessions, ensureServerPassword } from "./browserSessions";
import { ControlPlaneEndpoint } from "./controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { FleetStore, HUNT_FILE } from "../persistence/fleet";
import { multiCaseInput } from "../persistence/fixtures";
import {
  MutationError,
  ObservationStore,
  type AttemptCaller,
  type StoredGoal,
  type StoredIntent,
} from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { InstanceId } from "../harness/identity";
import { HarnessResolver } from "../harness/resolver";
import { stubHarness, STUB_INSTANCE } from "../harness/stubHarness";
import type { NarrationDetail } from "../harness/agentHarness";
import { LIVE_HEARTBEAT } from "../run/liveTranscript";
import { RunNarrations } from "../run/narration";
import { RunSupervisor, type RunInput } from "../run/supervisor";
import { PolicyDecisions, type PolicyConfig } from "../policy/service";

const scratch = mkdtempSync(join(tmpdir(), "bit-browser-api-"));
/** `realpath` because the OS temporary directory is itself a link on some systems. */
const base = realpathSync(scratch);
const fleetRoot = join(base, "fleet");
const workspaceRoot = join(base, "workspace");
const outside = join(base, "outside");

/**
 * The goal-briefing ceiling this suite configures, far below the shipped 320 000.
 *
 * Deliberately small, because the refusal above the ceiling is the behaviour worth
 * driving over the wire and crossing the real default would take about a hundred recorded
 * observations per test. A handful of writes crosses this one. It is also the only way to
 * prove the number is *threaded*: the route reports the ceiling in force, so a response
 * saying 320 000 here would mean `browserApiRoutes` was ignoring its own configuration.
 */
const SUITE_BRIEFING_CEILING = 12_000;

const POLICY: PolicyConfig = {
  forbiddenPathFragments: ["out-of-scope/"],
  hostScope: { _tag: "hosts", allowed: ["127.0.0.1"] },
};

/** One MCP grant, so "an MCP bearer is not a session" can be asserted rather than assumed. */
class TestCredential extends Context.Service<
  TestCredential,
  { readonly token: Redacted.Redacted<string> }
>()("bit/http/TestCredential") {
  static readonly layer = Layer.effect(
    TestCredential,
    Effect.flatMap(McpCredentials, (credentials) =>
      credentials.issue({
        _tag: "attempt",
        targetId: "t",
        intentId: "i",
        attemptId: "a",
        workerId: "w",
        harnessSessionId: "ses_api",
        attemptFence: 0,
      }),
    ),
  );
}

const fleet = FleetStore.layer(fleetRoot);

/**
 * The one run this suite's supervisor claims to be holding.
 *
 * Its session id is what the policy gate's request has to name for a refusal to be
 * attributable, and its target is the one the live-transcript block registers. Nothing
 * actually runs: `start` is refused exactly as it is on a harness-less server.
 */
const SUPERVISED: RunningAttempt = {
  attemptId: "at_live",
  targetId: "livefeed",
  intentId: "intent-live",
  harnessSessionId: "ses_live",
  startedAt: 1_700_000_000_000,
};

/** Every input the route has handed `start` in this suite, in order. */
const startedWith: RunInput[] = [];

/**
 * A supervisor that refuses every start and reports {@link SUPERVISED} as running.
 *
 * `RunSupervisor.unavailable` with one answer changed. The refusals are copied in their
 * shape rather than imported, because what this suite needs is a *reporting* supervisor on
 * a server that still cannot run anything — which is a combination no production layer
 * produces and which is exactly the right fixture here: it lets the attribution path be
 * driven over HTTP without a harness, a model or a provider login.
 */
const supervisorHolding: Layer.Layer<RunSupervisor> = Layer.succeed(
  RunSupervisor,
  RunSupervisor.of({
    start: (input) =>
      Effect.andThen(
        // Recorded, so a test can read what the route handed the supervisor. The refusal
        // is unchanged; this only makes "startRun passes the intent through" observable.
        Effect.sync(() => {
          startedWith.push(input);
        }),
        Effect.fail(
          new RunRefused({
            reason: "no_harness",
            detail:
              "this suite configures no harness, so nothing can be started",
          }),
        ),
      ),
    stop: (attemptId) =>
      Effect.fail(
        new RunRefused({
          reason: "unknown_attempt",
          detail: `nothing is running under ${attemptId} in this suite`,
        }),
      ),
    running: Effect.succeed([SUPERVISED]),
  }),
);

/**
 * The browser API's routes, with the narration bus handed in rather than rebuilt.
 *
 * `Layer.unwrap` over `Effect.context` is the same move `main.ts` makes and it is here for
 * the same reason: `ControlPlaneEndpoint` builds the router's application layer through
 * `HttpRouter.toWebHandler`, which uses **its own memo map**, so a layer merely *provided*
 * to `extraRoutes` is built a second time. For a `PubSub` that means the supervisor
 * publishing into one bus and the live transcript subscribing to another — a run that
 * narrates to nobody — so the instance is read out of this graph and passed as a context.
 * Which also means a test can get the same reference out of the runtime and publish into it.
 */
const endpoint = Layer.unwrap(
  Effect.map(Effect.context<RunNarrations>(), (shared) =>
    ControlPlaneEndpoint.layer({
      policy: POLICY,
      extraRoutes: browserApiRoutes({
        workspaceRoot,
        goalBriefingMaxChars: SUITE_BRIEFING_CEILING,
      }).pipe(
        Layer.provide(BrowserSessions.layer),
        // The same resolver the server builds, over the same registry: the route under test is
        // the one that opens a target's own file, so a stub here would test the stub.
        Layer.provide(TargetStores.layer.pipe(Layer.provide(fleet))),
        Layer.provide(fleet),
        // No harness in this suite, so starts are refused exactly as they are on a server
        // without one — standing up an agent to check a 409 would make this suite depend on
        // a provider login. What this adds over `RunSupervisor.unavailable` is a non-empty
        // `running`, because that is the only way a policy decision can be attributed: the
        // gate's request carries a harness session id and the live route resolves it against
        // the runs the supervisor is holding. See {@link SUPERVISED}.
        Layer.provide(supervisorHolding),
        /**
         * Two configured instances, one of which would not start.
         *
         * No harness is *driven* here — `RunSupervisor.unavailable` refuses every start — and
         * that is the point of splitting the two: the harness **listing** is configuration plus
         * what a server observed, and it has to answer correctly on a server that cannot run
         * anything. The broken entry is what proves the route keeps an unusable instance visible
         * with its reason rather than filtering it out.
         */
        Layer.provide(
          Layer.succeed(
            HarnessResolver,
            HarnessResolver.fromEntries([
              { instance: STUB_INSTANCE, harness: stubHarness() },
              {
                instance: {
                  ...STUB_INSTANCE,
                  instanceId: InstanceId.make("absent-harness"),
                  displayName: "Absent harness",
                  installed: false,
                },
                harness: undefined,
                reason: "no such binary on this server's PATH",
                setup: "install it and log in",
              },
            ]),
          ),
        ),
        Layer.provide(Layer.succeedContext(shared)),
        Layer.orDie,
      ),
    }),
  ),
);

const testLayer = Layer.mergeAll(
  TestCredential.layer,
  endpoint,
  McpCredentials.layer,
  McpCallCounter.layer,
  PolicyDecisions.layer,
).pipe(
  Layer.provideMerge(RunNarrations.layer),
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  // The MCP route on this listener dispatches by credential, so it takes a resolver. The
  // browser API has its own, fleet-backed, provided above; this one is for the MCP route
  // and holds the one target `TestCredential` names.
  Layer.provide(
    TargetStores.ofStore("t").pipe(
      Layer.provide(ObservationStore.layer(join(base, "served.sqlite"))),
    ),
  ),
);

const runtime = ManagedRuntime.make(testLayer);

let api = "";
let mcpUrl = "";
let healthUrl = "";
let password = "";
let mcpToken = "";
let token = "";

const call = (
  path: string,
  options?: {
    readonly method?: string;
    readonly body?: unknown;
    readonly bearer?: string | undefined;
  },
) =>
  fetch(`${api}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options?.bearer === undefined
        ? {}
        : { authorization: `Bearer ${options.bearer}` }),
    },
    ...(options?.body === undefined || (options.method ?? "GET") === "GET"
      ? {}
      : { body: JSON.stringify(options.body) }),
  });

const signedIn = (
  path: string,
  options?: { readonly method?: string; readonly body?: unknown },
) => call(path, { ...options, bearer: token });

/** `{ status, body }`, so a test can assert both without two awaits. */
const read = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

beforeAll(async () => {
  mkdirSync(join(workspaceRoot, "alpha"), { recursive: true });
  mkdirSync(join(workspaceRoot, "beta"), { recursive: true });
  mkdirSync(join(workspaceRoot, "gamma"), { recursive: true });
  mkdirSync(join(workspaceRoot, "broken"), { recursive: true });
  mkdirSync(join(workspaceRoot, "locked", "inner"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  // A sibling whose path begins with the root's: `startsWith(root)` alone admits it, and
  // it has to exist or the refusal under test would be `not_found` instead.
  mkdirSync(`${workspaceRoot}-elsewhere`, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "not for the browser");
  writeFileSync(join(workspaceRoot, "a-file.txt"), "not a directory");
  // A link *inside* the root pointing out of it. A prefix test on the literal string
  // passes this; resolving it is what refuses it.
  symlinkSync(outside, join(workspaceRoot, "escape"));
  chmodSync(join(workspaceRoot, "locked"), 0o000);

  // A file the hunt chain cannot migrate, in the directory the target `broken` will get.
  // Produced by breaking a real file rather than by stubbing the migrator: a policy
  // proven against a stub migrator is a policy about the stub.
  mkdirSync(join(fleetRoot, "targets", "broken"), { recursive: true });
  const corrupt = new Database(
    join(fleetRoot, "targets", "broken", HUNT_FILE),
    { create: true },
  );
  corrupt.run("CREATE TABLE observations (id TEXT)");
  corrupt.close();

  // The password before the listener comes up, in its own scope, so the plaintext this
  // suite signs in with is the one the first boot generated.
  password = await Effect.runPromise(
    Effect.scoped(
      Effect.map(ensureServerPassword(), (state) => state.generated ?? "").pipe(
        Effect.provide(fleet),
        Effect.orDie,
      ),
    ),
  );

  await runtime.runPromise(
    Effect.gen(function* () {
      const endpoint = yield* ControlPlaneEndpoint;
      const credential = yield* TestCredential;
      api = `${endpoint.origin}/api/v1`;
      mcpUrl = endpoint.mcpUrl;
      healthUrl = endpoint.healthUrl;
      mcpToken = Redacted.value(credential.token);
    }),
  );

  const opened = await read(
    await call("/session", { method: "POST", body: { password } }),
  );
  token = String(opened.body["token"]);
});

afterAll(async () => {
  await runtime.dispose();
  chmodSync(join(workspaceRoot, "locked"), 0o755);
  rmSync(`${workspaceRoot}-elsewhere`, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("opening a session", () => {
  test("the password generated on first boot is the one that works", () => {
    expect(password).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a wrong password is a typed 401 that names the reason", async () => {
    const refused = await read(
      await call("/session", { method: "POST", body: { password: "wrong" } }),
    );
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({
      _tag: "SessionRefused",
      reason: "invalid_password",
    });
    // The refusal is an answer, not a transport failure: that is the whole distinction
    // the Connect screen renders against two different fields.
    expect(refused.body["detail"]).toBeString();
  });

  test("a wrong password hands back nothing that can be used as a bearer", async () => {
    const refused = await read(
      await call("/session", { method: "POST", body: { password: "wrong" } }),
    );
    // No token, and nothing token-shaped under another name either.
    expect(refused.body["token"]).toBeUndefined();
    expect(Object.keys(refused.body).sort()).toEqual([
      "_tag",
      "detail",
      "reason",
    ]);
    // That no registry entry was created at all is asserted where the registry is
    // reachable, in `browserSessions.test.ts`; from out here the observable claim is
    // that a refusal yields no credential and changes nothing about admission.
    const stillGuarded = await read(await call("/targets"));
    expect(stillGuarded.status).toBe(401);
  });

  test("the session route itself needs no bearer", async () => {
    const response = await call("/session", {
      method: "POST",
      body: { password },
    });
    expect(response.status).toBe(200);
  });
});

describe("the guard", () => {
  test("no bearer is `missing`, not `unknown`", async () => {
    const response = await read(await call("/targets"));
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      _tag: "Unauthenticated",
      reason: "missing",
    });
  });

  test("an unrecognised bearer is `unknown`", async () => {
    const response = await read(await call("/targets", { bearer: "nope" }));
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      _tag: "Unauthenticated",
      reason: "unknown",
    });
  });

  test("it guards every endpoint behind it, not just the list", async () => {
    for (const [path, method] of [
      ["/session", "GET"],
      ["/targets", "GET"],
      ["/targets", "POST"],
      ["/targets/acme-corp", "GET"],
      ["/folders", "GET"],
    ] as const) {
      const response = await read(await call(path, { method, body: {} }));
      expect({ path, method, status: response.status }).toEqual({
        path,
        method,
        status: 401,
      });
      expect(response.body["_tag"]).toBe("Unauthenticated");
    }
  });

  test("the probe confirms a session and hands back the two roots", async () => {
    const response = await read(await signedIn("/session"));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceRoot,
      fleetRoot,
    });
    expect(String(response.body["sessionId"])).toStartWith("ses_");
  });
});

describe("two registries, not one", () => {
  test("an MCP credential does not open a browser session", async () => {
    const response = await read(await call("/targets", { bearer: mcpToken }));
    expect(response.status).toBe(401);
    expect(response.body["_tag"]).toBe("Unauthenticated");
  });

  test("a browser session token does not satisfy the MCP route", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  test("health is still unauthenticated and still says one word", async () => {
    const response = await fetch(healthUrl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("the folder picker", () => {
  test("lists the root's directories, and nothing above it", async () => {
    const response = await read(await signedIn("/folders"));
    expect(response.status).toBe(200);
    expect(response.body["root"]).toBe(workspaceRoot);
    expect(response.body["path"]).toBe(workspaceRoot);
    // `null` at the root, so the picker has no affordance for leaving it.
    expect(response.body["parent"]).toBeNull();
    const names = (
      response.body["entries"] as ReadonlyArray<{ name: string }>
    ).map((entry) => entry.name);
    // Directories only, sorted. The file is not listed, and neither is the symlink:
    // `readdir` does not follow links, so a link reports as a link and is filtered out.
    expect(names).toEqual(["alpha", "beta", "broken", "gamma", "locked"]);
  });

  test("walks into a directory and offers its parent", async () => {
    const response = await read(
      await signedIn(
        `/folders?path=${encodeURIComponent(join(workspaceRoot, "alpha"))}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body["path"]).toBe(join(workspaceRoot, "alpha"));
    expect(response.body["parent"]).toBe(workspaceRoot);
    expect(response.body["entries"]).toEqual([]);
  });

  test("refuses every way out of the root, each with its own reason", async () => {
    const cases: ReadonlyArray<readonly [string, number, string, string]> = [
      // Refused as written, never normalised: a path that climbs out and happens to come
      // back would otherwise pass a range check on the result.
      [`${workspaceRoot}/../outside`, 403, "PathRefused", "traversal"],
      [`${workspaceRoot}/./alpha`, 403, "PathRefused", "traversal"],
      // The one that matters: a link inside the root pointing out of it.
      [`${workspaceRoot}/escape`, 403, "PathRefused", "symlink"],
      [outside, 403, "PathRefused", "outside_root"],
      ["/etc", 403, "PathRefused", "outside_root"],
      // A sibling of the root whose name starts with the root's: `startsWith` alone
      // would admit it.
      [`${workspaceRoot}-elsewhere`, 403, "PathRefused", "outside_root"],
      ["relative/path", 403, "PathRefused", "not_absolute"],
      [`${workspaceRoot}/locked/inner`, 403, "PathRefused", "denied"],
      [`${workspaceRoot}/nothing-here`, 404, "PathNotFound", "not_found"],
      [`${workspaceRoot}/a-file.txt`, 404, "PathNotFound", "not_a_directory"],
    ];
    for (const [path, status, tag, reason] of cases) {
      const response = await read(
        await signedIn(`/folders?path=${encodeURIComponent(path)}`),
      );
      expect({ path, status: response.status, body: response.body }).toEqual({
        path,
        status,
        body: {
          _tag: tag,
          reason,
          path: expect.any(String),
          detail: expect.any(String),
        },
      });
    }
  });

  test("a refusal reveals nothing about what is out there", async () => {
    const response = await read(
      await signedIn(`/folders?path=${encodeURIComponent(outside)}`),
    );
    expect(JSON.stringify(response.body)).not.toContain("secret.txt");
  });
});

describe("creating a target", () => {
  test("registers it, migrates its own file, and lists it at once", async () => {
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "alpha"),
          name: "Acme Corp",
          scopeNote: "*.acme.test",
        },
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      // The name became a directory-safe id; the name itself is kept as typed.
      id: "acme-corp",
      name: "Acme Corp",
      workspacePath: join(workspaceRoot, "alpha"),
      dataDirectory: join(fleetRoot, "targets", "acme-corp"),
      available: true,
      unavailableReason: null,
    });
    expect(created.body["appliedThrough"]).toBeNumber();

    const listed = await read(await signedIn("/targets"));
    expect(
      (listed.body as unknown as ReadonlyArray<{ id: string }>).map(
        (row) => row.id,
      ),
    ).toContain("acme-corp");

    // The migration really ran against that file, in that file.
    const database = new Database(
      join(fleetRoot, "targets", "acme-corp", HUNT_FILE),
      { readonly: true },
    );
    try {
      const rows = database
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM effect_sql_migrations",
        )
        .all();
      expect(rows[0]?.n).toBe(Number(created.body["appliedThrough"]));
    } finally {
      database.close();
    }
  });

  test("a second target does not touch the first one's file", async () => {
    const first = join(fleetRoot, "targets", "acme-corp", HUNT_FILE);
    const before = await Bun.file(first).arrayBuffer();
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "beta"),
          name: "internal-api",
          scopeNote: "api.internal.test",
        },
      }),
    );
    expect(created.status).toBe(200);
    expect(created.body["id"]).toBe("internal-api");
    const after = await Bun.file(first).arrayBuffer();
    // Byte-for-byte: separate files is the claim the two-tier layout exists to make,
    // and a shared connection would have shown up here as a changed journal.
    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });

  test("the same folder twice is refused, naming the target that holds it", async () => {
    const refused = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "alpha"),
          name: "a-different-name",
          scopeNote: "",
        },
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "TargetRefused",
      reason: "duplicate_workspace",
      // The id the dialog offers to open instead.
      targetId: "acme-corp",
    });
  });

  test("the same id twice is refused, even against a different folder", async () => {
    const refused = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "gamma"),
          name: "acme corp",
          scopeNote: "",
        },
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "TargetRefused",
      reason: "duplicate_target",
      targetId: "acme-corp",
    });
  });

  test("a name that cannot be a directory is refused with its own reason", async () => {
    const refused = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "gamma"),
          name: "...",
          scopeNote: "",
        },
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "TargetRefused",
      reason: "invalid_name",
    });
  });

  test("a folder outside the root, or unreadable, is refused before anything is written", async () => {
    for (const [path, reason] of [
      [outside, "outside_root"],
      [`${workspaceRoot}/escape`, "symlink"],
      [`${workspaceRoot}/locked/inner`, "denied"],
    ] as const) {
      const refused = await read(
        await signedIn("/targets", {
          method: "POST",
          body: {
            workspacePath: path,
            name: "should-not-exist",
            scopeNote: "",
          },
        }),
      );
      expect({
        path,
        status: refused.status,
        reason: refused.body["reason"],
      }).toEqual({ path, status: 403, reason });
    }
    // Nothing was registered, so the folder check really did come first.
    const listed = await read(await signedIn("/targets"));
    expect(
      (listed.body as unknown as ReadonlyArray<{ id: string }>).map(
        (row) => row.id,
      ),
    ).not.toContain("should-not-exist");
  });

  test("a target whose file cannot migrate is created, unavailable, and alone in that", async () => {
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "broken"),
          name: "broken",
          scopeNote: "",
        },
      }),
    );
    // Not an error: the row stays, the directory exists, and the request succeeded in
    // registering what the operator asked for. The policy, and why, is on `fleet.ts`.
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      id: "broken",
      available: false,
      unavailableReason: "schema_unavailable",
    });
    expect(String(created.body["detail"])).toContain("Migration");

    const listed = (await read(await signedIn("/targets")))
      .body as unknown as ReadonlyArray<{
      id: string;
      available: boolean;
    }>;
    // Its neighbours keep serving. That is the half of the policy that matters.
    expect(listed.filter((row) => row.available).map((row) => row.id)).toEqual(
      expect.arrayContaining(["acme-corp", "internal-api"]),
    );
    expect(listed.find((row) => row.id === "broken")?.available).toBe(false);
  });
});

/**
 * Opening a target: the one route that opens a target's own database.
 *
 * Everything above this point is answerable from `control.sqlite` plus a `stat`. These
 * tests are the first that make the server open `targets/<id>/hunt.sqlite`, through the
 * per-target resolver, and they are written as two targets *in turn* rather than as one,
 * because the claim worth proving is not that a count can be read — it is that the count
 * read for one target is that target's.
 */
describe("opening a target", () => {
  /**
   * Asymmetric fixture data, written to one target's file and not the other's.
   *
   * Inserted with `bun:sqlite` rather than through the store, deliberately: the store's
   * own writers demand an attempt, a credential and a write fence, and none of that is
   * what this is about. Two rows in one file and none in its neighbour is the smallest
   * fixture that can tell a cross-target read from a correct one — with both files empty,
   * reading the wrong one looks exactly like reading the right one.
   */
  beforeAll(() => {
    const database = new Database(
      join(fleetRoot, "targets", "acme-corp", HUNT_FILE),
    );
    try {
      database.run(
        "INSERT INTO goals (id, target_id, description, created_at) VALUES (?, ?, ?, ?)",
        ["goal_seed", "acme-corp", "seeded for the counts test", 1],
      );
      database.run(
        `INSERT INTO intents (id, goal_id, target_id, question, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["intent_seed", "goal_seed", "acme-corp", "does it hold?", 2],
      );
    } finally {
      database.close();
    }
  });

  test("it answers with the target's own row and the counts from its own file", async () => {
    const response = await read(await signedIn("/targets/acme-corp"));
    expect(response.status).toBe(200);
    const body = response.body as {
      target: Record<string, unknown>;
      counts: Record<string, number>;
    };
    // The header's name and scope come from this one request, so a deep link into a cold
    // tab has everything it needs without the list.
    expect(body.target).toMatchObject({
      id: "acme-corp",
      name: "Acme Corp",
      scopeNote: "*.acme.test",
      available: true,
    });
    expect(body.counts).toEqual({
      goals: 1,
      intents: 1,
      attempts: 0,
      unsettledAttempts: 0,
      observations: 0,
      assets: 0,
      events: 0,
    });
    expect((response.body as { recoveries: unknown[] }).recoveries).toEqual([]);
  });

  test("the neighbour's counts are the neighbour's", async () => {
    const response = await read(await signedIn("/targets/internal-api"));
    expect(response.status).toBe(200);
    const body = response.body as {
      target: Record<string, unknown>;
      counts: Record<string, number>;
    };
    expect(body.target["id"]).toBe("internal-api");
    expect(body.target["scopeNote"]).toBe("api.internal.test");
    // Nothing was seeded here. If the resolver had handed back the entry cached for
    // `acme-corp` a moment ago — the exact failure a key-by-anything-else resolver has —
    // these would read 1 and 1.
    expect(body.counts["goals"]).toBe(0);
    expect(body.counts["intents"]).toBe(0);
  });

  test("two targets open at once keep their own rows", async () => {
    // Concurrent rather than sequential: both entries are live in the resolver at the
    // same moment, which is when a shared connection or a shared cache entry would show.
    const [acme, internal] = await Promise.all([
      read(await signedIn("/targets/acme-corp")),
      read(await signedIn("/targets/internal-api")),
    ]);
    expect([acme.status, internal.status]).toEqual([200, 200]);
    expect(
      (acme.body as { counts: Record<string, number> }).counts["intents"],
    ).toBe(1);
    expect(
      (internal.body as { counts: Record<string, number> }).counts["intents"],
    ).toBe(0);
  });

  test("an id nothing is registered under is a 404 that names it", async () => {
    const response = await read(await signedIn("/targets/not-a-target"));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      _tag: "TargetNotFound",
      reason: "unknown_target",
      targetId: "not-a-target",
    });
  });

  test("an id that could never name a target is refused as that, before any path", async () => {
    // Uppercase cannot be a target id: ids are directory names, and a case-insensitive
    // filesystem would fold this onto another one. Refused for being unusable rather than
    // for being absent, because they are different mistakes.
    const response = await read(await signedIn("/targets/Acme-Corp"));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      _tag: "TargetNotFound",
      reason: "invalid_target_id",
    });
  });

  test("a target whose file will not migrate is refused by name, and only it", async () => {
    const refused = await read(await signedIn("/targets/broken"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "TargetUnavailable",
      reason: "schema_unavailable",
      targetId: "broken",
    });
    expect(String(refused.body["detail"])).toContain("Migration");

    // The whole partial-failure policy, in two requests: the refusal names one target,
    // and the next request for a different one is served from the same listener by the
    // same resolver.
    const served = await read(await signedIn("/targets/acme-corp"));
    expect(served.status).toBe(200);
  });

  test("the list still opens nothing", async () => {
    // `GET /targets` is the cheap screen and has to stay cheap: it answers from the
    // registry plus a `stat`, so no count appears on a rail row however many targets
    // have been opened individually.
    const rows = (await read(await signedIn("/targets")))
      .body as unknown as ReadonlyArray<Record<string, unknown>>;
    for (const row of rows) {
      expect(row["counts"]).toBeUndefined();
    }
  });
});

describe("availability in the list", () => {
  test("a target whose folder is gone stays listed and is marked unavailable", async () => {
    const before = (await read(await signedIn("/targets")))
      .body as unknown as ReadonlyArray<{ id: string }>;
    rmSync(join(workspaceRoot, "beta"), { recursive: true, force: true });
    const after = (await read(await signedIn("/targets")))
      .body as unknown as ReadonlyArray<{
      id: string;
      available: boolean;
      unavailableReason: string | null;
      detail: string;
    }>;
    // Listed, not dropped. The registry row is the last record that the engagement
    // happened, so the list never silently shrinks.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    const row = after.find((entry) => entry.id === "internal-api");
    expect(row?.available).toBe(false);
    expect(row?.unavailableReason).toBe("workspace_missing");
    expect(row?.detail).toContain(join(workspaceRoot, "beta"));
  });

  test("a target whose data directory is gone is unavailable for a different reason", async () => {
    rmSync(join(fleetRoot, "targets", "acme-corp"), {
      recursive: true,
      force: true,
    });
    const after = (await read(await signedIn("/targets")))
      .body as unknown as ReadonlyArray<{
      id: string;
      available: boolean;
      unavailableReason: string | null;
    }>;
    const row = after.find((entry) => entry.id === "acme-corp");
    expect(row?.available).toBe(false);
    // The filesystem is checked before the schema: a missing folder explains a missing
    // schema, so reporting the schema state of a directory that is not there would be
    // misleading.
    expect(row?.unavailableReason).toBe("folder_missing");
  });

  test("every row carries the path and the last activity the rail shows", async () => {
    const rows = (await read(await signedIn("/targets")))
      .body as unknown as ReadonlyArray<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(typeof row["dataDirectory"]).toBe("string");
      expect(typeof row["lastActivityAt"]).toBe("number");
      expect(Number(row["lastActivityAt"])).toBeGreaterThanOrEqual(
        Number(row["createdAt"]),
      );
    }
  });
});

/* ── The harness listing and the transcript, on the wire ─────────────────────── */

/**
 * The two routes slice C added, asserted through `fetch` like everything else here.
 *
 * What is worth checking on the wire rather than in the service: that an unusable instance
 * survives serialisation with its reason attached, and that an attempt with no transcript
 * is a **200** rather than a 404. The second is a decision rather than an accident — "we
 * kept none and the harness has forgotten it" is the ordinary end state of every attempt
 * old enough, and an error status would make a browser treat the common case as a fault.
 */
describe("the harness listing", () => {
  test("every configured instance is listed, including one that will not start", async () => {
    const listed = (await read(await signedIn("/harnesses")))
      .body as unknown as ReadonlyArray<{
      instanceId: string;
      ready: boolean;
      reason?: string;
      setup?: string;
      isDefault: boolean;
      defaultModel: string;
      models: readonly { id: string }[];
      auth: string;
    }>;
    expect(listed.map((entry) => entry.instanceId)).toEqual([
      "stub",
      "absent-harness",
    ]);

    const working = listed[0];
    expect(working?.ready).toBe(true);
    expect(working?.isDefault).toBe(true);
    expect(working?.reason).toBeUndefined();
    // The catalogue the picker searches, and the default is in it. Entries are model
    // *views* — a name plus whatever that model offers — so the name is read off `id`.
    expect(working?.models.map((model) => model.id)).toContain(
      working?.defaultModel ?? "",
    );
    // `unknown` is a real answer and the only one either harness can give: neither offers
    // a non-destructive "am I logged in" probe, so `ready` deliberately does not fold it
    // in. See `harness/resolver.ts`.
    expect(working?.auth).toBe("unknown");

    // Visible with a reason, which is the rule. Not filtered out, not a 404, not silence.
    const broken = listed[1];
    expect(broken?.ready).toBe(false);
    expect(broken?.reason).toContain("no such binary");
    expect(broken?.setup).toContain("install it");
    expect(broken?.isDefault).toBe(false);
  });

  test("the listing needs a session like everything else", async () => {
    const refused = await read(await call("/harnesses"));
    expect(refused.status).toBe(401);
    expect(refused.body["_tag"]).toBe("Unauthenticated");
  });
});

describe("reading an attempt's transcript", () => {
  const targetId = "transcripts";
  const attemptId = "at_no_transcript";

  /**
   * One target of this block's own, with one attempt row and nothing else.
   *
   * A target of its own because the blocks above deliberately break `acme-corp`'s folder
   * and its data directory to test the availability states, and a transcript read starts by
   * opening the target.
   *
   * The attempt row goes in with `bun:sqlite`, which is the pattern this file already uses
   * for a fixture: the store's own writer wants a goal, an intent, a credential and a write
   * fence, and none of that is what a transcript read is about. `harness_session_id` is
   * null on purpose — the cheapest honest version of "there is nothing to ask about".
   */
  beforeAll(async () => {
    mkdirSync(join(workspaceRoot, "transcripts"), { recursive: true });
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, "transcripts"),
          name: "transcripts",
          scopeNote: "",
        },
      }),
    );
    expect(created.status).toBe(200);
    const database = new Database(
      join(fleetRoot, "targets", targetId, HUNT_FILE),
    );
    try {
      database.run(
        `INSERT INTO attempts
           (id, intent_id, target_id, worker_id, harness_session_id,
            harness_instance_id, provider_id, model_id, status, started_at, write_fence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attemptId,
          "in_t",
          targetId,
          "wk_t",
          null,
          "stub",
          "stub",
          "scripted/model",
          "succeeded",
          1,
          0,
        ],
      );
    } finally {
      database.close();
    }
  });

  test("an attempt this target does not hold is a typed 404", async () => {
    const refused = await read(
      await signedIn(`/targets/${targetId}/attempts/at_nope/transcript`),
    );
    expect(refused.status).toBe(404);
    expect(refused.body["_tag"]).toBe("AttemptNotFound");
    expect(refused.body["attemptId"]).toBe("at_nope");
  });

  /**
   * An attempt with no transcript answers 200 and says so.
   *
   * Not a 404: "we kept none and the harness has forgotten it" is the ordinary end state
   * of every attempt old enough, and an error status would make a browser treat the common
   * case as a fault. The sentence is the server's own, not the browser's guess.
   */
  test("an attempt with no transcript is a success that says there is none", async () => {
    const answered = await read(
      await signedIn(`/targets/${targetId}/attempts/${attemptId}/transcript`),
    );
    expect(answered.status).toBe(200);
    expect(answered.body["source"]).toBe("absent");
    expect(answered.body["ephemeral"]).toBe(false);
    expect(String(answered.body["note"])).toContain(
      "no harness session recorded",
    );
    expect(answered.body["entries"]).toEqual([]);
  });
});

/* ── The live transcript, on the wire ────────────────────────────────────────── */

/**
 * Reads Server-Sent Events off the real socket until `done`, then aborts.
 *
 * Over `fetch` and parsed by hand, deliberately. Everything that could be wrong about this
 * endpoint is on the wire: whether the response is a 200 with `text/event-stream` rather
 * than a buffered body, whether a frame survives the SSE framing the contract's
 * `HttpApiSchema.StreamSse` chose, and whether the connection stays open while the server
 * is reading pages. Calling the handler in process would check none of it.
 *
 * `AbortController` is what closes it. The stream never ends on its own — a caught-up
 * reader sleeps and reads again — so every test has to say what it is waiting for, and the
 * deadline turns "the frame never came" into a failed assertion rather than a hung suite.
 */
const liveFrames = async (
  path: string,
  done: (frames: readonly LiveFrame[]) => boolean,
  /**
   * Work to do while the connection is open — publishing narration, answering a decision.
   *
   * Started as soon as the response's headers are in and **not** awaited before the read
   * loop, because the two have to overlap: the activity channel replays nothing, so a
   * publish has to land while this connection is subscribed, and a publish that blocked the
   * reader would deadlock against a server waiting for the socket to drain. It is awaited at
   * the end, so a failure inside it fails the test rather than vanishing.
   */
  during?: () => Promise<void>,
): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly frames: readonly LiveFrame[];
}> => {
  const controller = new AbortController();
  const response = await fetch(`${api}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  const contentType = response.headers.get("content-type");
  const body = response.body;
  if (response.status !== 200 || body === null) {
    controller.abort();
    return { status: response.status, contentType, frames: [] };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: LiveFrame[] = [];
  let buffer = "";
  const deadline = Date.now() + 10_000;
  const working = during?.();
  try {
    while (!done(frames) && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        for (const line of buffer.slice(0, split).split("\n")) {
          if (line.startsWith("data:")) {
            frames.push(JSON.parse(line.slice(5).trim()) as LiveFrame);
          }
        }
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
  }
  await working;
  return { status: response.status, contentType, frames };
};

/**
 * Waits for a bus's subscriber count to reach `want`.
 *
 * Both activity buses replay nothing — `run/narration.ts` and `policy/service.ts` both say
 * so — so publishing before the connection under test is subscribed is publishing into the
 * void. The counts are usable as readiness signals precisely because each is incremented
 * *after* its `PubSub.subscribe` returns, which `policy/service.test.ts` pins down; a fixed
 * sleep here would be a test that passes on a fast machine and flakes on a loaded one.
 */
const untilSubscribers = (
  count: Effect.Effect<number, never, RunNarrations | PolicyDecisions>,
  want: number,
): Promise<void> =>
  runtime.runPromise(
    Effect.timeout(
      Effect.gen(function* () {
        while ((yield* count) !== want) yield* Effect.sleep("5 millis");
      }),
      "10 seconds",
    ).pipe(Effect.orDie),
  );

const narrationSubscribers = Effect.flatMap(
  RunNarrations,
  (narrations) => narrations.subscriberCount,
);
const decisionSubscribers = Effect.flatMap(
  PolicyDecisions,
  (decisions) => decisions.subscriberCount,
);

/**
 * Waits until no live connection is subscribed to either activity bus.
 *
 * **This is what makes the readiness wait below mean anything**, and finding out why cost a
 * debugging round worth recording. Aborting a `fetch` tears the socket down from the client
 * side; the server's own stream, and therefore its subscription, unwinds a moment later. So
 * a connection from the previous test can still be holding a subscriber while the next one
 * opens — and a readiness wait phrased as "the count went above what it was when I started"
 * is then satisfied by *that* subscriber, letting the publish land before the connection
 * under test has subscribed to anything. The symptom was a handful of tests timing out
 * while the one that happened to run first passed.
 *
 * Draining to zero first and then waiting for exactly one is unambiguous: the only
 * subscriber there can be is this connection's.
 */
const quietBuses = async (): Promise<void> => {
  await untilSubscribers(narrationSubscribers, 0);
  await untilSubscribers(decisionSubscribers, 0);
};

/** Waits until the connection under test — the only one — has subscribed. */
const connectionSubscribed = (
  count: Effect.Effect<number, never, RunNarrations | PolicyDecisions>,
): Promise<void> => untilSubscribers(count, 1);

const liveItems = (frames: readonly LiveFrame[]): readonly LiveItem[] =>
  frames.filter((frame): frame is LiveItem => frame._tag === "item");

const liveCaughtUp = (frames: readonly LiveFrame[]): boolean =>
  frames.some((frame) => frame._tag === "cursor" && frame.caughtUp);

/**
 * The live endpoint against a target with a real event log.
 *
 * The events are written through the real store rather than inserted by hand, so the
 * sequences under test are the ones the store assigned inside its own transactions — the
 * same reason `run/liveTranscript.test.ts` uses a real file. What this block adds on top of
 * that suite is the HTTP half: the guard, the typed refusals, the framing, and that the
 * connection is a stream rather than a response that waits for the run to finish.
 *
 * `RunSupervisor.unavailable` is still what this suite has, so nothing is *running*: the
 * activity channel has no publisher a request could reach and the policy gate's decisions
 * cannot be attributed to an attempt. Those two paths are proven in
 * `run/liveTranscript.test.ts`, with the real narration bus, and claiming them here would
 * mean standing up an agent and a provider login to assert a status code.
 */
describe("watching a target's live transcript", () => {
  const targetId = "livefeed";

  beforeAll(async () => {
    mkdirSync(join(workspaceRoot, targetId), { recursive: true });
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, targetId),
          name: targetId,
          scopeNote: "",
        },
      }),
    );
    expect(created.status).toBe(200);

    // Three committed events: the attempt, an asset and an observation. Written with the
    // store's own writer, in its own scope, which is closed before the suite reads over
    // HTTP — so the connection the endpoint opens is a second one on a settled file.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* ObservationStore;
          yield* store.seedAttempt({
            targetId,
            goalId: "goal-live",
            goal: "Watch a run happen.",
            intentId: "intent-live",
            question: "Does the transcript arrive in order?",
            attemptId: "at_live",
            workerId: "wk_live",
            harnessInstanceId: "stub",
            providerId: "stub",
            modelId: "scripted/model",
            modelOptions: null,
            harnessSessionId: "ses_live",
          });
          const caller: AttemptCaller = {
            _tag: "attempt",
            callerScope: `${targetId}/at_live`,
            targetId,
            intentId: "intent-live",
            attemptId: "at_live",
            harnessSessionId: "ses_live",
            workerId: "wk_live",
            attemptFence: 0,
          };
          yield* store.recordAsset(caller, {
            operationId: "op-asset",
            kind: "endpoint",
            url: "http://127.0.0.1:41317/login",
            method: "POST",
            note: "the fixture's login endpoint",
          });
          yield* store.recordObservation(
            caller,
            multiCaseInput({ operationId: "op-obs" }),
          );
        }).pipe(
          Effect.provide(
            ObservationStore.layer(
              join(fleetRoot, "targets", targetId, HUNT_FILE),
            ),
          ),
          Effect.orDie,
        ),
      ),
    );
  });

  test("it needs a session, like everything else about a target", async () => {
    const response = await fetch(`${api}/targets/${targetId}/live`, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  test("a well-formed id nothing is registered under is a typed 404", async () => {
    const refused = await read(await signedIn("/targets/nosuchtarget/live"));
    expect(refused.status).toBe(404);
    expect(refused.body["_tag"]).toBe("TargetNotFound");
  });

  test("a string that cannot name a target is refused before any path is built", async () => {
    const refused = await read(await signedIn("/targets/..%2Fetc/live"));
    expect(refused.status).toBe(404);
    expect(refused.body["_tag"]).toBe("TargetNotFound");
    expect(refused.body["reason"]).toBe("invalid_target_id");
  });

  test("it answers as an event stream, opening with where it is reading from", async () => {
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=0`,
      liveCaughtUp,
    );
    expect(live.status).toBe(200);
    // A stream, not a buffered body. A 200 with `application/json` here would mean the
    // response was waiting for the run to end, which is the one thing this endpoint exists
    // not to do.
    expect(live.contentType).toContain("text/event-stream");
    const opened = live.frames[0];
    expect(opened?._tag).toBe("opened");
    if (opened?._tag !== "opened") throw new Error("no opening frame");
    expect(opened.targetId).toBe(targetId);
    expect(opened.from).toBe(0);
    expect(opened.latest).toBe(3);
    expect(opened.skipped).toBe(0);
  });

  test("the record arrives in store-assigned order, once each", async () => {
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=0`,
      liveCaughtUp,
    );
    const items = liveItems(live.frames);
    expect(items.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(items.map((item) => item.kind)).toEqual([
      "run.started",
      "asset.recorded",
      "observation.recorded",
    ]);
    // Every item on this channel says it is the record and carries a position, which is
    // what a client's resume cursor is taken from.
    expect(items.every((item) => item.origin === "record")).toBe(true);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    // And a recorded observation reads as recorded, through the framing, with its outcome.
    const observation = items[2];
    expect(observation?.headline).toBe("Observation recorded");
    expect(observation?.outcome).toBe("positive");
  });

  test("a cursor in the query string is honoured on the wire", async () => {
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=2`,
      liveCaughtUp,
    );
    // The protocol Day 7's reconnect is built on: a client that passes the highest sequence
    // it saw is answered strictly after it, so the gap is filled and nothing repeats.
    expect(liveItems(live.frames).map((item) => item.sequence)).toEqual([3]);
    const opened = live.frames[0];
    if (opened?._tag !== "opened") throw new Error("no opening frame");
    expect(opened.from).toBe(2);
    expect(opened.skipped).toBe(0);
  });

  test("a cursor at the end of the log opens, says so, and sends no items", async () => {
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=3`,
      liveCaughtUp,
    );
    expect(liveItems(live.frames)).toEqual([]);
    // Caught up at once rather than after a heartbeat: a watcher on a quiet target is told
    // the history has finished arriving instead of being left to guess.
    const cursor = live.frames.find((frame) => frame._tag === "cursor");
    expect(cursor?._tag).toBe("cursor");
    if (cursor?._tag !== "cursor") throw new Error("no cursor frame");
    expect(cursor.sequence).toBe(3);
    expect(cursor.caughtUp).toBe(true);
  });

  test("a target whose database is gone is refused for the reason the rail gives", async () => {
    // `acme-corp`'s data directory is removed by the availability block above, which is the
    // same condition the rail dims its row with. Watching a target is reading it, so the
    // refusal has to be the same one — and with the same words.
    const refused = await read(await signedIn("/targets/acme-corp/live"));
    expect(refused.status).toBe(409);
    expect(refused.body["_tag"]).toBe("TargetUnavailable");
    expect(String(refused.body["detail"]).length).toBeGreaterThan(0);
  });
});

/**
 * The activity channel, over the socket.
 *
 * The block above proves the record channel on the wire. This one proves the other half,
 * which nothing had tested over HTTP: that a harness's narration and the policy gate's
 * refusals reach a browser through this endpoint, with their arguments intact and
 * attributed to the right attempt.
 *
 * **It is a different claim from the one `run/liveTranscript.test.ts` makes**, and the
 * difference is the whole reason it is here. That suite drives the merge in process, so it
 * cannot see any of the things that only exist on this path: whether the `PubSub` the
 * supervisor publishes into is the same instance the route subscribes to — which it only is
 * because `main.ts` and this file hand it across the router's own memo map by value — and
 * whether an item survives SSE framing and the contract's own encoding with its JSON
 * arguments unmangled. Both were taken on trust until this block existed.
 *
 * Attribution needs a supervisor that is holding something, which is what {@link SUPERVISED}
 * is for: the gate's request carries a harness session id and nothing else, so a decision is
 * matched against the runs this process reports.
 */
describe("the live transcript's activity channel, on the wire", () => {
  const targetId = "livefeed";

  /** One narration entry, published as the supervisor publishes them. */
  const publish = (entry: {
    readonly type: string;
    readonly detail: NarrationDetail;
  }) =>
    runtime.runPromise(
      Effect.flatMap(RunNarrations, (narrations) =>
        narrations.publish({
          targetId,
          attemptId: SUPERVISED.attemptId,
          harnessSessionId: SUPERVISED.harnessSessionId,
          entry: {
            type: entry.type,
            sequence: undefined,
            at: 1_700_000_000_000,
            outcome: undefined,
            detail: entry.detail,
          },
        }),
      ),
    );

  const activityOf = (frames: readonly LiveFrame[]): readonly LiveItem[] =>
    liveItems(frames).filter((item) => item.origin === "activity");

  test("a tool call reaches the browser with its arguments and its call id", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=99`,
      (frames) => activityOf(frames).length >= 1,
      async () => {
        await connectionSubscribed(narrationSubscribers);
        await publish({
          type: "session.tool.called",
          detail: {
            _tag: "toolCall",
            callId: "t1",
            tool: "bash",
            input: '{"command":"curl -s http://127.0.0.1:41317/login"}',
          },
        });
      },
    );

    const [call] = activityOf(live.frames);
    expect(call?.kind).toBe("tool.call");
    expect(call?.headline).toBe("bash");
    expect(call?.tool).toBe("bash");
    expect(call?.callId).toBe("t1");
    // The arguments as JSON text, through SSE framing and the contract's encoding, with the
    // quotes and the colon intact. A `data:` line that had been mangled would still parse
    // as a frame and would be wrong here.
    expect(call?.input).toBe(
      '{"command":"curl -s http://127.0.0.1:41317/login"}',
    );
    // An activity item claims no position, on the wire as everywhere else.
    expect(call?.sequence).toBeNull();
    expect(call?.attemptId).toBe(SUPERVISED.attemptId);
  });

  test("a result arrives with the same call id as its call, answered out of order", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=99`,
      (frames) => activityOf(frames).length >= 4,
      async () => {
        await connectionSubscribed(narrationSubscribers);
        await publish({
          type: "session.tool.called",
          detail: { _tag: "toolCall", callId: "a", tool: "bash", input: "{}" },
        });
        await publish({
          type: "session.tool.called",
          detail: { _tag: "toolCall", callId: "b", tool: "bash", input: "{}" },
        });
        // `b` answers first, which is the ordinary case with two tools in flight.
        await publish({
          type: "session.tool.success",
          detail: {
            _tag: "toolResult",
            callId: "b",
            tool: "bash",
            output: "from b",
            failed: false,
          },
        });
        await publish({
          type: "session.tool.failed",
          detail: {
            _tag: "toolResult",
            callId: "a",
            tool: "bash",
            output: "from a",
            failed: true,
          },
        });
      },
    );

    // Published order is kept through the bus, the merge and the framing, so the pairing has
    // to be carried on the items — which is what `callId` is for.
    expect(
      activityOf(live.frames).map((item) => [item.kind, item.callId]),
    ).toEqual([
      ["tool.call", "a"],
      ["tool.call", "b"],
      ["tool.result", "b"],
      ["tool.result", "a"],
    ]);
    const failed = activityOf(live.frames).find(
      (item) => item.kind === "tool.result" && item.callId === "a",
    );
    expect(failed?.outcome).toBe("failed");
    expect(failed?.output).toBe("from a");
  });

  test("an opaque entry is not pushed down the socket at all", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=99`,
      (frames) => activityOf(frames).some((item) => item.kind === "turn.reply"),
      async () => {
        await connectionSubscribed(narrationSubscribers);
        // A token delta, which is most of what a harness narrates. Dropped at the
        // projection so one frame reaches the wire per reply block instead of hundreds per
        // turn; the reply behind it is what proves the drop happened rather than the
        // publish failing.
        await publish({
          type: "session.text.delta",
          detail: { _tag: "opaque" },
        });
        await publish({
          type: "session.text.ended",
          detail: { _tag: "reply", text: "Probing the limiter." },
        });
      },
    );
    expect(activityOf(live.frames).map((item) => item.kind)).toEqual([
      "turn.reply",
    ]);
    expect(activityOf(live.frames)[0]?.body).toBe("Probing the limiter.");
  });

  test("a refused action reaches the browser, attributed to the run holding its session", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=99`,
      (frames) => activityOf(frames).some((i) => i.kind === "action.denied"),
      async () => {
        await connectionSubscribed(decisionSubscribers);
        // Through the real decision bus, from the same instance the policy route records
        // into — see this block's header on why that sameness is the thing under test.
        await runtime.runPromise(
          Effect.flatMap(PolicyDecisions, (decisions) =>
            decisions.record({
              sessionId: SUPERVISED.harnessSessionId,
              tool: "shell",
              input: { command: "curl -s https://out-of-scope.test/" },
              effect: "deny",
              reason: "host 'out-of-scope.test' is not in scope",
            }),
          ),
        );
      },
    );

    const denied = activityOf(live.frames).find(
      (item) => item.kind === "action.denied",
    );
    expect(denied?.headline).toBe("Denied");
    expect(denied?.outcome).toBe("denied");
    expect(denied?.tool).toBe("shell");
    // The gate's own sentence, unsoftened and unmangled.
    expect(denied?.body).toBe("host 'out-of-scope.test' is not in scope");
    expect(denied?.input).toContain("out-of-scope.test");
    // Attributed from the supervisor's own map, not from anything in the request.
    expect(denied?.attemptId).toBe(SUPERVISED.attemptId);
    // A refusal carries no call id: the hook does not know which of the harness's own calls
    // it is being asked about.
    expect(denied?.callId).toBeNull();
  });

  test("a decision for a session this target does not hold never reaches the browser", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=99`,
      (frames) => activityOf(frames).some((i) => i.kind === "action.denied"),
      async () => {
        await connectionSubscribed(decisionSubscribers);
        await runtime.runPromise(
          Effect.flatMap(PolicyDecisions, (decisions) =>
            Effect.andThen(
              // Another engagement's session — or this one's, after its attempt settled and
              // left the supervisor's map.
              decisions.record({
                sessionId: "ses_somewhere_else",
                tool: "shell",
                input: { command: "whoami" },
                effect: "deny",
                reason: "not this target's business",
              }),
              // One that *is* placeable behind it, so reaching the second proves the first
              // was reached and dropped rather than still in flight.
              decisions.record({
                sessionId: SUPERVISED.harnessSessionId,
                tool: "shell",
                input: { command: "id" },
                effect: "deny",
                reason: "placeable",
              }),
            ),
          ),
        );
      },
    );

    const denials = activityOf(live.frames).filter(
      (item) => item.kind === "action.denied",
    );
    // Showing one target's refused action under another target would be worse than not
    // showing it, so it does not appear.
    expect(denials).toHaveLength(1);
    expect(denials[0]?.body).toBe("placeable");
  });

  test("an allowed decision is not pushed down the socket", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=99`,
      (frames) => activityOf(frames).some((i) => i.kind === "action.denied"),
      async () => {
        await connectionSubscribed(decisionSubscribers);
        await runtime.runPromise(
          Effect.flatMap(PolicyDecisions, (decisions) =>
            Effect.andThen(
              decisions.record({
                sessionId: SUPERVISED.harnessSessionId,
                tool: "read",
                input: { filePath: "in-scope.txt" },
                effect: "allow",
                basis: "no_host_named",
              }),
              decisions.record({
                sessionId: SUPERVISED.harnessSessionId,
                tool: "shell",
                input: { command: "id" },
                effect: "deny",
                reason: "the one that should arrive",
              }),
            ),
          ),
        );
      },
    );
    // The permitted call is already on this stream as `tool.call` from the harness's own
    // narration; the gate's agreement beside it would show one call as two items.
    expect(activityOf(live.frames).map((item) => item.body)).toEqual([
      "the one that should arrive",
    ]);
  });

  test("the record and the activity channel arrive on one connection, told apart", async () => {
    await quietBuses();
    const live = await liveFrames(
      `/targets/${targetId}/live?cursor=0`,
      (frames) => liveCaughtUp(frames) && activityOf(frames).length >= 1,
      async () => {
        await connectionSubscribed(narrationSubscribers);
        await publish({
          type: "session.text.ended",
          detail: { _tag: "reply", text: "both channels" },
        });
      },
    );

    const record = liveItems(live.frames).filter(
      (item) => item.origin === "record",
    );
    // The record still arrives in store-assigned order beside the activity, and only it
    // carries a position — which is the distinction the whole contract exists to keep.
    expect(record.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(
      activityOf(live.frames).every((item) => item.sequence === null),
    ).toBe(true);
  });
});

/* ── Surviving an idle connection ────────────────────────────────────────────── */

/**
 * A live connection with nothing to say stays open, because the heartbeat keeps it warm.
 *
 * **This is the one claim about this endpoint that only a real socket, held past a real
 * timeout, can make — and it was false.** `Bun.serve`'s `idleTimeout` defaults to ten
 * seconds and closes any connection with no bytes in either direction for that long; the
 * live transcript sends a `LiveCursor` every twenty. So in a browser the transcript on a
 * quiet target went dead after ten seconds, and because the dev-server proxy kept the
 * downstream response open, nothing said so. Every test above this point reads a frame and
 * aborts within a second or two, which is exactly why none of them saw it.
 *
 * The suite's own listener cannot answer this: it is built once with the real timings, and
 * asserting against those is a sixty-second test. So this block stands up listeners of its
 * own with the heartbeat and the idle timeout scaled down **together**, which keeps it a
 * test of the relationship between them rather than of two numbers.
 *
 * **Two of them, because the second is the control.** A test that only watched a healthy
 * connection survive could pass for reasons that have nothing to do with the heartbeat — a
 * Bun that ignored `idleTimeout`, a reader that kept the socket busy by itself. The second
 * listener reproduces the shipped bug's *shape*, a heartbeat longer than the timeout, and
 * asserts that the server does close it. Together they say: the timeout is real, and the
 * heartbeat is what defeats it.
 */
describe("a target's goals", () => {
  const first = "goals-one";
  const second = "goals-two";

  const register = async (name: string) => {
    mkdirSync(join(workspaceRoot, name), { recursive: true });
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: {
          workspacePath: join(workspaceRoot, name),
          name,
          scopeNote: "",
        },
      }),
    );
    expect(created.status).toBe(200);
  };

  beforeAll(async () => {
    await register(first);
    await register(second);
  });

  const create = (targetId: string, body: unknown) =>
    signedIn(`/targets/${targetId}/goals`, { method: "POST", body });

  test("create, list, open and end make one round trip", async () => {
    const empty = await read(await signedIn(`/targets/${first}/goals`));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ goals: [] });

    const created = await read(
      await create(first, {
        name: "Auth bypass",
        description: "  Can the login limiter be bypassed?  ",
      }),
    );
    // A resource exists that did not, and the objective was trimmed on the way in.
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      targetId: first,
      name: "Auth bypass",
      description: "Can the login limiter be bypassed?",
      status: "active",
      endedAt: null,
      endedBy: null,
      endReason: null,
      counts: { intents: 0, attempts: 0, observations: 0 },
    });
    const goalId = String(created.body["goalId"]);
    // The server minted it; the browser sent no id.
    expect(goalId).toStartWith("goal_");

    const listed = await read(await signedIn(`/targets/${first}/goals`));
    expect(
      (listed.body["goals"] as ReadonlyArray<{ goalId: string }>).map(
        (goal) => goal.goalId,
      ),
    ).toEqual([goalId]);

    const opened = await read(
      await signedIn(`/targets/${first}/goals/${goalId}`),
    );
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ goalId, status: "active" });

    const ended = await read(
      await signedIn(`/targets/${first}/goals/${goalId}/end`, {
        method: "POST",
        body: { status: "met", reason: "Shown with 40 rapid requests." },
      }),
    );
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({
      goalId,
      status: "met",
      // The route is the operator's, and the payload had no say in it.
      endedBy: "operator",
      endReason: "Shown with 40 rapid requests.",
    });
    expect(ended.body["endedAt"]).toBeNumber();

    // And it is the same goal when read again, which is what surviving a reload means.
    const reread = await read(
      await signedIn(`/targets/${first}/goals/${goalId}`),
    );
    expect(reread.body).toEqual(ended.body);
  });

  test("a name is optional", async () => {
    const created = await read(
      await create(first, { description: "Map the unauthenticated surface." }),
    );
    expect(created.status).toBe(201);
    expect(created.body["name"]).toBe("");
  });

  test("an empty or blank objective is refused before anything is written", async () => {
    const before = await read(await signedIn(`/targets/${second}/goals`));
    for (const description of ["", "   \n\t "]) {
      const refused = await create(second, { description });
      expect(refused.status).toBe(400);
    }
    const missing = await create(second, { name: "no objective" });
    expect(missing.status).toBe(400);

    const after = await read(await signedIn(`/targets/${second}/goals`));
    expect(after.body).toEqual(before.body);
    // Nor did the refused request reach the event log: a target with no goal has none.
    const database = new Database(
      join(fleetRoot, "targets", second, HUNT_FILE),
      { readonly: true },
    );
    try {
      expect(database.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
        n: 0,
      });
    } finally {
      database.close();
    }
  });

  test("ending is refused by name the second time, and the first ending stands", async () => {
    const created = await read(
      await create(first, { description: "Enumerate tenant ids." }),
    );
    const goalId = String(created.body["goalId"]);
    const end = (status: string, reason: string) =>
      signedIn(`/targets/${first}/goals/${goalId}/end`, {
        method: "POST",
        body: { status, reason },
      });

    expect((await end("abandoned", "out of scope")).status).toBe(200);
    const again = await read(await end("met", "never mind"));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      _tag: "GoalRefused",
      reason: "already_ended",
      goalId,
    });
    expect(String(again.body["detail"])).toContain("already abandoned");
    expect(String(again.body["detail"])).toContain("operator");

    const after = await read(
      await signedIn(`/targets/${first}/goals/${goalId}`),
    );
    expect(after.body).toMatchObject({
      status: "abandoned",
      endReason: "out of scope",
    });
  });

  test("an end status other than met or abandoned is not accepted", async () => {
    const created = await read(
      await create(first, { description: "A goal that stays open." }),
    );
    const refused = await signedIn(
      `/targets/${first}/goals/${String(created.body["goalId"])}/end`,
      { method: "POST", body: { status: "active", reason: "" } },
    );
    expect(refused.status).toBe(400);
  });

  test("two targets keep their own goals", async () => {
    const mine = await read(
      await create(second, { description: "Only the second target has this." }),
    );
    const secondGoals = await read(await signedIn(`/targets/${second}/goals`));
    const firstGoals = await read(await signedIn(`/targets/${first}/goals`));
    const secondIds = (
      secondGoals.body["goals"] as ReadonlyArray<{ goalId: string }>
    ).map((goal) => goal.goalId);
    const firstIds = (
      firstGoals.body["goals"] as ReadonlyArray<{ goalId: string }>
    ).map((goal) => goal.goalId);

    expect(secondIds).toEqual([String(mine.body["goalId"])]);
    expect(firstIds).not.toContain(String(mine.body["goalId"]));

    // A goal is a handle into one target's file: asked for through the other, it is not
    // found, and ending it through the other is refused the same way.
    const crossRead = await read(
      await signedIn(`/targets/${first}/goals/${String(mine.body["goalId"])}`),
    );
    expect(crossRead.status).toBe(404);
    expect(crossRead.body).toMatchObject({
      _tag: "GoalNotFound",
      targetId: first,
    });
    const crossEnd = await read(
      await signedIn(
        `/targets/${first}/goals/${String(mine.body["goalId"])}/end`,
        { method: "POST", body: { status: "met", reason: "" } },
      ),
    );
    expect(crossEnd.status).toBe(404);
    const untouched = await read(
      await signedIn(`/targets/${second}/goals/${String(mine.body["goalId"])}`),
    );
    expect(untouched.body["status"]).toBe("active");
  });

  test("a goal nobody created is a 404 that names it", async () => {
    const response = await read(
      await signedIn(`/targets/${first}/goals/goal_nowhere`),
    );
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      _tag: "GoalNotFound",
      goalId: "goal_nowhere",
    });
    const end = await read(
      await signedIn(`/targets/${first}/goals/goal_nowhere/end`, {
        method: "POST",
        body: { status: "met", reason: "" },
      }),
    );
    expect(end.status).toBe(404);
  });

  test("an unopenable target refuses all four routes the way every other route does", async () => {
    const unknown = "no-such-target";
    const paths: ReadonlyArray<
      readonly [method: string, path: string, body?: unknown]
    > = [
      ["GET", `/targets/${unknown}/goals`],
      ["POST", `/targets/${unknown}/goals`, { description: "x" }],
      ["GET", `/targets/${unknown}/goals/goal_1`],
      [
        "POST",
        `/targets/${unknown}/goals/goal_1/end`,
        { status: "met", reason: "" },
      ],
    ];
    for (const [method, path, body] of paths) {
      const response = await read(
        await signedIn(path, {
          method,
          ...(body === undefined ? {} : { body }),
        }),
      );
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        _tag: "TargetNotFound",
        reason: "unknown_target",
      });
    }
    // And a target whose folder is gone is the other refusal, from the same check.
    const gone = "goals-gone";
    await register(gone);
    rmSync(join(fleetRoot, "targets", gone), { recursive: true, force: true });
    const unavailable = await read(await signedIn(`/targets/${gone}/goals`));
    expect(unavailable.status).toBe(409);
    expect(unavailable.body).toMatchObject({
      _tag: "TargetUnavailable",
      reason: "folder_missing",
    });
    const refusedWrite = await create(gone, { description: "x" });
    expect(refusedWrite.status).toBe(409);
  });

  test("the routes need a session like everything else", async () => {
    const response = await call(`/targets/${first}/goals`);
    expect(response.status).toBe(401);
    const write = await call(`/targets/${first}/goals`, {
      method: "POST",
      body: { description: "x" },
    });
    expect(write.status).toBe(401);
  });

  test("goals created and ended appear in the target's record", async () => {
    const database = new Database(
      join(fleetRoot, "targets", first, HUNT_FILE),
      { readonly: true },
    );
    try {
      const kinds = database
        .query<{ kind: string }, []>(
          "SELECT kind FROM events ORDER BY sequence",
        )
        .all()
        .map((row) => row.kind);
      expect(kinds).toContain("goal.added");
      expect(kinds).toContain("goal.ended");
    } finally {
      database.close();
    }
  });
});

describe("what a goal refusal is allowed to claim", () => {
  const stored = (status: StoredGoal["status"]): StoredGoal => ({
    goalId: "goal_x",
    targetId: "t",
    name: "",
    description: "d",
    status,
    createdAt: 1,
    endedAt: status === "active" ? null : 2,
    endedBy: status === "active" ? null : "operator",
    endReason: status === "active" ? null : "",
    intentCount: 0,
    attemptCount: 0,
    observationCount: 0,
  });
  const storeHolding = (goal: StoredGoal | undefined) => ({
    loadGoal: () => Effect.succeed(goal),
  });
  const conflict = new MutationError({
    reason: "conflict",
    detail: "operation op_1 was already used with different input",
  });

  test("a conflict about a goal that is ended is already_ended", async () => {
    const exit = await Effect.runPromiseExit(
      goalRefusal(storeHolding(stored("met")), "t", "goal_x", conflict),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("already_ended");
  });

  test("a conflict about a goal that is still active is not claimed to be an ending", async () => {
    // A reused operation id with different input: the store says `conflict`, and the goal
    // is open. Naming that `already_ended` would be a 409 that misdescribes what happened.
    const exit = await Effect.runPromiseExit(
      goalRefusal(storeHolding(stored("active")), "t", "goal_x", conflict),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("already_ended");
  });

  test("a conflict about a goal that cannot be read is not claimed either", async () => {
    const exit = await Effect.runPromiseExit(
      goalRefusal(storeHolding(undefined), "t", "goal_x", conflict),
    );
    expect(Exit.hasDies(exit)).toBe(true);
  });

  test("an invalid refusal is a GoalNotFound carrying the store's sentence", async () => {
    const exit = await Effect.runPromiseExit(
      goalRefusal(
        storeHolding(undefined),
        "t",
        "goal_x",
        new MutationError({
          reason: "invalid",
          detail: "no goal goal_x exists",
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("GoalNotFound");
    expect(JSON.stringify(exit)).toContain("no goal goal_x exists");
  });
});

describe("a goal's intents", () => {
  let counter = 0;

  /**
   * A target of its own for every test, and so a database of its own: nothing here reads
   * what an earlier test left. The goals block above shares its targets across tests and
   * is order-dependent for it; this one is not.
   */
  const freshTarget = async () => {
    counter += 1;
    const name = `intents-${String(counter)}`;
    mkdirSync(join(workspaceRoot, name), { recursive: true });
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: { workspacePath: join(workspaceRoot, name), name, scopeNote: "" },
      }),
    );
    expect(created.status).toBe(200);
    return name;
  };

  const newGoal = async (targetId: string) => {
    const created = await read(
      await signedIn(`/targets/${targetId}/goals`, {
        method: "POST",
        body: { description: "Can the login limiter be bypassed?" },
      }),
    );
    return String(created.body["goalId"]);
  };

  const addIntent = (targetId: string, goalId: string, body: unknown) =>
    signedIn(`/targets/${targetId}/goals/${goalId}/intents`, {
      method: "POST",
      body,
    });

  const draft = (overrides: Record<string, unknown> = {}) => ({
    question: "Does the limiter reset on a new window?",
    anchorObservationIds: [],
    addressesDimension: null,
    ...overrides,
  });

  /** The target's file through a store of our own, for what no route writes yet. */
  const withHunt = <A, E>(
    targetId: string,
    use: (store: ObservationStore["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(ObservationStore, use).pipe(
          Effect.provide(
            ObservationStore.layer(
              join(fleetRoot, "targets", targetId, HUNT_FILE),
            ),
          ),
        ),
      ),
    );

  test("adding an intent mints its identity, trims the question, and lists it with the goal's count", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);

    const empty = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/intents`),
    );
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ intents: [] });

    const created = await read(
      await addIntent(
        targetId,
        goalId,
        draft({ question: "  Does the limiter reset on a new window?  " }),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      goalId,
      question: "Does the limiter reset on a new window?",
      status: "open",
      anchoredTo: [],
      addressesDimension: null,
      claimedByAttemptId: null,
      attempts: 0,
      suggestion: { instanceId: null, model: null, modelOptions: null },
    });
    // The server minted it; the browser sent no id.
    expect(String(created.body["intentId"])).toStartWith("int_");

    const listed = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/intents`),
    );
    expect(
      (listed.body["intents"] as ReadonlyArray<{ intentId: string }>).map(
        (intent) => intent.intentId,
      ),
    ).toEqual([String(created.body["intentId"])]);

    const goal = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}`),
    );
    expect(goal.body["counts"]).toMatchObject({ intents: 1 });
  });

  test("a suggestion is carried as a suggestion, and absent stays absent", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const created = await read(
      await addIntent(
        targetId,
        goalId,
        draft({
          suggestedInstanceId: "claude-code",
          suggestedModel: "claude-sonnet-5",
          suggestedModelOptions: [{ id: "effort", value: "high" }],
        }),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.body["suggestion"]).toEqual({
      instanceId: "claude-code",
      model: "claude-sonnet-5",
      modelOptions: [{ id: "effort", value: "high" }],
    });
    // Nothing about what ran is on an intent: only the attempt says that.
    expect(Object.keys(created.body)).not.toContain("instanceId");
  });

  test("a blank question, or an empty suggestion, is refused before anything is written", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    for (const bad of [
      draft({ question: "   " }),
      draft({ suggestedInstanceId: "" }),
    ]) {
      expect((await addIntent(targetId, goalId, bad)).status).toBe(400);
    }
    const listed = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/intents`),
    );
    expect(listed.body).toEqual({ intents: [] });
  });

  test("an anchoring refusal comes back as the store's own sentence, and writes nothing", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const first = await read(await addIntent(targetId, goalId, draft()));

    // Anchoring an intent to an intent: the one mistake the rule exists to teach.
    const refused = await read(
      await addIntent(
        targetId,
        goalId,
        draft({
          question: "Follow-up?",
          anchorObservationIds: [first.body["intentId"]],
        }),
      ),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "IntentRefused",
      reason: "invalid",
    });
    // Says what the id is, why that cannot anchor, and what to do instead.
    expect(String(refused.body["detail"])).toContain("is an intent");
    expect(String(refused.body["detail"])).toContain("new top-level direction");

    const listed = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/intents`),
    );
    expect(listed.body["intents"]).toHaveLength(1);
  });

  test("an intent anchors to a recorded observation under its goal, and can address its dimension", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    // Evidence has to come from somewhere, and no route records it: a worker does, through
    // the MCP route. A store over the same file stands in for the worker.
    const observationId = await withHunt(targetId, (store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt({
          targetId,
          goalId,
          goal: "g",
          intentId: "int_seed",
          question: "q",
          attemptId: "att_seed",
          workerId: "wk_seed",
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt",
          modelOptions: null,
          harnessSessionId: null,
        });
        const recorded = yield* store.recordObservation(
          {
            _tag: "attempt",
            callerScope: `${targetId}/att_seed`,
            targetId,
            intentId: "int_seed",
            attemptId: "att_seed",
            harnessSessionId: "ses_seed",
            workerId: "wk_seed",
            attemptFence: 0,
          },
          multiCaseInput({
            operationId: "obs-1",
            untestedDimensions: ["no window rollover was measured"],
          }),
        );
        return recorded.observationId;
      }),
    );

    // The digest the form picks from: the claim, how it came out, and what it left open.
    const digest = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/observations`),
    );
    expect(digest.status).toBe(200);
    expect(digest.body["observations"]).toMatchObject([
      {
        observationId,
        intentId: "int_seed",
        outcome: "positive",
        untestedDimensions: [
          {
            address: `${observationId}#u0`,
            text: "no window rollover was measured",
          },
        ],
      },
    ]);

    const created = await read(
      await addIntent(
        targetId,
        goalId,
        draft({
          anchorObservationIds: [observationId],
          addressesDimension: `${observationId}#u0`,
        }),
      ),
    );
    expect(created.status).toBe(201);
    expect(created.body["anchoredTo"]).toEqual([observationId]);
    // Read back as the alias that was submitted, derived from the dimension row.
    expect(created.body["addressesDimension"]).toBe(`${observationId}#u0`);
  });

  test("a dimension address that names nothing is refused with the store's sentence", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const refused = await read(
      await addIntent(
        targetId,
        goalId,
        draft({ addressesDimension: "obs_000009_nothing#u0" }),
      ),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "IntentRefused",
      reason: "invalid",
    });
    expect(String(refused.body["detail"])).toContain("obs_000009_nothing#u0");
  });

  test("the observation digest of a goal nobody created is a 404, and of an empty goal is empty", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const empty = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/observations`),
    );
    expect(empty.body).toEqual({ observations: [] });
    const missing = await read(
      await signedIn(`/targets/${targetId}/goals/goal_nonesuch/observations`),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ _tag: "GoalNotFound" });
  });

  test("a goal nobody created, and another target's goal, are a 404 that names it", async () => {
    const targetId = await freshTarget();
    const other = await freshTarget();
    const othersGoal = await newGoal(other);
    for (const goalId of ["goal_nonesuch", othersGoal]) {
      const listed = await read(
        await signedIn(`/targets/${targetId}/goals/${goalId}/intents`),
      );
      expect(listed.status).toBe(404);
      expect(listed.body).toMatchObject({ _tag: "GoalNotFound", goalId });
      const added = await read(await addIntent(targetId, goalId, draft()));
      expect(added.status).toBe(404);
      expect(added.body).toMatchObject({ _tag: "GoalNotFound", goalId });
    }
    // And nothing landed in the target that the goal does belong to.
    const untouched = await read(
      await signedIn(`/targets/${other}/goals/${othersGoal}/intents`),
    );
    expect(untouched.body).toEqual({ intents: [] });
  });

  test("abandoning drops an open intent once, as the operator, and says why on the second try", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const created = await read(await addIntent(targetId, goalId, draft()));
    const intentId = String(created.body["intentId"]);

    const abandoned = await read(
      await signedIn(`/targets/${targetId}/intents/${intentId}/abandon`, {
        method: "POST",
        body: { reason: "Out of scope." },
      }),
    );
    expect(abandoned.status).toBe(200);
    expect(abandoned.body).toMatchObject({ intentId, status: "abandoned" });

    const again = await read(
      await signedIn(`/targets/${targetId}/intents/${intentId}/abandon`, {
        method: "POST",
        body: { reason: "" },
      }),
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      _tag: "IntentRefused",
      reason: "not_abandonable",
    });
    expect(String(again.body["detail"])).toContain("already abandoned");

    // And the abandonment is in the target's record, attributed to the operator.
    const database = new Database(
      join(fleetRoot, "targets", targetId, HUNT_FILE),
      { readonly: true },
    );
    try {
      const events = database
        .query<{ kind: string; caller_scope: string }, []>(
          "SELECT kind, caller_scope FROM events WHERE kind = 'intent.abandoned'",
        )
        .all();
      expect(events).toEqual([
        { kind: "intent.abandoned", caller_scope: `${targetId}/operator` },
      ]);
    } finally {
      database.close();
    }
  });

  test("an intent a run holds cannot be abandoned from under it, and the refusal names the attempt", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const created = await read(await addIntent(targetId, goalId, draft()));
    const intentId = String(created.body["intentId"]);
    await withHunt(targetId, (store) =>
      store.claimIntent(
        { callerScope: `${targetId}/operator`, targetId },
        intentId,
        "att_running",
      ),
    );

    const refused = await read(
      await signedIn(`/targets/${targetId}/intents/${intentId}/abandon`, {
        method: "POST",
        body: { reason: "" },
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      _tag: "IntentRefused",
      reason: "not_abandonable",
    });
    expect(String(refused.body["detail"])).toContain("att_running");
    // The view of it says who holds it.
    const listed = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/intents`),
    );
    expect(listed.body["intents"]).toMatchObject([
      { status: "claimed", claimedByAttemptId: "att_running" },
    ]);
  });

  test("an intent nobody created, or another target's, is a 404 that names it", async () => {
    const targetId = await freshTarget();
    const other = await freshTarget();
    const othersGoal = await newGoal(other);
    const othersIntent = String(
      (await read(await addIntent(other, othersGoal, draft()))).body[
        "intentId"
      ],
    );
    for (const intentId of ["int_nonesuch", othersIntent]) {
      const refused = await read(
        await signedIn(`/targets/${targetId}/intents/${intentId}/abandon`, {
          method: "POST",
          body: { reason: "" },
        }),
      );
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ _tag: "IntentNotFound", intentId });
    }
    // Not abandoned by the attempt.
    const listed = await read(
      await signedIn(`/targets/${other}/goals/${othersGoal}/intents`),
    );
    expect(listed.body["intents"]).toMatchObject([{ status: "open" }]);
  });

  test("starting a run hands the supervisor the intent, and nothing the old route minted from", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    const created = await read(await addIntent(targetId, goalId, draft()));
    const intentId = String(created.body["intentId"]);
    startedWith.length = 0;

    const refused = await read(
      await signedIn(`/targets/${targetId}/runs`, {
        method: "POST",
        body: { intentId, instanceId: "opencode", model: "gpt" },
      }),
    );
    // This suite's supervisor refuses every start; what matters is what it was given.
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ _tag: "RunRefused" });
    expect(startedWith).toHaveLength(1);
    expect(startedWith[0]).toMatchObject({
      targetId,
      intentId,
      instanceId: "opencode",
      model: "gpt",
    });
    // No free text reaches the supervisor: the prompt is the intent's, claimed there.
    expect(Object.keys(startedWith[0] ?? {})).not.toContain("task");
    expect(Object.keys(startedWith[0] ?? {})).not.toContain("question");
    expect(Object.keys(startedWith[0] ?? {})).not.toContain("goal");
  });

  test("the old one-instruction run is no longer accepted", async () => {
    const targetId = await freshTarget();
    startedWith.length = 0;
    const response = await signedIn(`/targets/${targetId}/runs`, {
      method: "POST",
      body: { instruction: "probe the limiter" },
    });
    expect(response.status).toBe(400);
    expect(startedWith).toHaveLength(0);
  });

  test("the routes need a session like everything else", async () => {
    const targetId = await freshTarget();
    for (const [method, path, body] of [
      ["GET", `/targets/${targetId}/goals/g/intents`, undefined],
      ["GET", `/targets/${targetId}/goals/g/briefing`, undefined],
      ["POST", `/targets/${targetId}/goals/g/intents`, draft()],
      ["POST", `/targets/${targetId}/intents/i/abandon`, { reason: "" }],
    ] as const) {
      const response = await call(path, {
        method,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(401);
    }
  });

  test("an unopenable target refuses these routes the way every other route does", async () => {
    for (const [method, path, body] of [
      ["GET", "/targets/no-such-target/goals/g/intents", undefined],
      ["GET", "/targets/no-such-target/goals/g/briefing", undefined],
      ["POST", "/targets/no-such-target/goals/g/intents", draft()],
      ["POST", "/targets/no-such-target/intents/i/abandon", { reason: "" }],
    ] as const) {
      const response = await read(
        await signedIn(path, {
          method,
          ...(body === undefined ? {} : { body }),
        }),
      );
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ _tag: "TargetNotFound" });
    }
  });
});

describe("what an intent refusal is allowed to claim", () => {
  const stored = (status: StoredIntent["status"]): StoredIntent => ({
    intentId: "int_x",
    goalId: "goal_x",
    targetId: "t",
    question: "q",
    status,
    anchoredTo: [],
    addressesDimension: null,
    createdAt: 1,
    claimedByAttemptId: status === "claimed" ? "att_1" : null,
    suggestion: { instanceId: null, model: null, modelOptions: null },
    attemptCount: 0,
  });
  const storeHolding = (intent: StoredIntent | undefined) => ({
    intent: () => Effect.succeed(intent),
  });
  const conflict = new MutationError({
    reason: "conflict",
    detail: "operation op_1 was already used with different input",
  });

  test("an add refused as invalid is an IntentRefused carrying the store's sentence", async () => {
    const exit = await Effect.runPromiseExit(
      addIntentRefusal(
        new MutationError({
          reason: "invalid",
          detail: "anchor 'x' is nothing",
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain("IntentRefused");
    expect(JSON.stringify(exit)).toContain("anchor 'x' is nothing");
  });

  test("an add refused for any other reason is a defect, not an invented refusal", async () => {
    for (const reason of ["conflict", "unauthorized", "stale"] as const) {
      const exit = await Effect.runPromiseExit(
        addIntentRefusal(new MutationError({ reason, detail: "d" })),
      );
      expect(Exit.hasDies(exit)).toBe(true);
    }
  });

  test("a conflict about an intent that is no longer open is not_abandonable", async () => {
    for (const status of ["claimed", "answered", "abandoned"] as const) {
      const exit = await Effect.runPromiseExit(
        abandonRefusal(storeHolding(stored(status)), "t", "int_x", conflict),
      );
      expect(JSON.stringify(exit)).toContain("not_abandonable");
    }
  });

  test("a conflict about an intent that is still open is not claimed to be a status", async () => {
    // A reused operation id: the store says `conflict` and the intent is open. Calling
    // that `not_abandonable` would tell an operator an open intent cannot be dropped.
    const exit = await Effect.runPromiseExit(
      abandonRefusal(storeHolding(stored("open")), "t", "int_x", conflict),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("not_abandonable");
  });

  test("an invalid refusal is an IntentNotFound carrying the store's sentence", async () => {
    const exit = await Effect.runPromiseExit(
      abandonRefusal(
        storeHolding(undefined),
        "t",
        "int_x",
        new MutationError({
          reason: "invalid",
          detail: "no intent int_x exists",
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain("IntentNotFound");
    expect(JSON.stringify(exit)).toContain("no intent int_x exists");
  });
});

describe("a goal's planner briefing", () => {
  let counter = 0;

  /** A target, and so a database, of its own per test. See the intents block's note. */
  const freshTarget = async () => {
    counter += 1;
    const name = `briefing-${String(counter)}`;
    mkdirSync(join(workspaceRoot, name), { recursive: true });
    const created = await read(
      await signedIn("/targets", {
        method: "POST",
        body: { workspacePath: join(workspaceRoot, name), name, scopeNote: "" },
      }),
    );
    expect(created.status).toBe(200);
    return name;
  };

  const newGoal = async (targetId: string) => {
    const created = await read(
      await signedIn(`/targets/${targetId}/goals`, {
        method: "POST",
        body: {
          name: "Login limiter",
          description: "Can the login limiter be bypassed?",
        },
      }),
    );
    expect(created.status).toBe(201);
    return String(created.body["goalId"]);
  };

  /** The target's own file through a store of our own, for what no route writes. */
  const withHunt = <A, E>(
    targetId: string,
    use: (store: ObservationStore["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(ObservationStore, use).pipe(
          Effect.provide(
            ObservationStore.layer(
              join(fleetRoot, "targets", targetId, HUNT_FILE),
            ),
          ),
        ),
      ),
    );

  /** `count` observations under one intent of the goal, seeded directly. */
  const seedObservations = (
    targetId: string,
    goalId: string,
    intentId: string,
    count: number,
  ) =>
    withHunt(targetId, (store) =>
      Effect.gen(function* () {
        yield* store.seedAttempt({
          targetId,
          goalId,
          goal: "Can the login limiter be bypassed?",
          intentId,
          question: `Probe the limiter, from ${intentId}.`,
          attemptId: `att_${intentId}`,
          workerId: `wk_${intentId}`,
          harnessInstanceId: "opencode",
          providerId: "openai",
          modelId: "gpt",
          modelOptions: null,
          harnessSessionId: null,
        });
        const caller: AttemptCaller = {
          _tag: "attempt",
          callerScope: `${targetId}/att_${intentId}`,
          targetId,
          intentId,
          attemptId: `att_${intentId}`,
          harnessSessionId: `ses_${intentId}`,
          workerId: `wk_${intentId}`,
          attemptFence: 0,
        };
        for (let index = 0; index < count; index += 1) {
          yield* store.recordObservation(
            caller,
            multiCaseInput({ operationId: `${intentId}-${String(index)}` }),
          );
        }
      }),
    );

  test("an empty goal is a briefing that says so, with its size and the ceiling", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);

    const response = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/briefing`),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      targetId,
      goalId,
      maxChars: SUITE_BRIEFING_CEILING,
      intentCount: 0,
      observationCount: 0,
      omittedObservationIds: [],
      truncated: false,
    });
    const rendered = String(response.body["rendered"]);
    // Not an error and not blank: the text says the graph has nothing yet.
    expect(rendered).toContain("Nothing has been recorded under this goal yet");
    expect(rendered).toContain("Can the login limiter be bypassed?");
    expect(response.body["sizeChars"]).toBe(rendered.length);
  });

  test("the text carries every observation of every intent, and says nothing was omitted", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    await seedObservations(targetId, goalId, "int_a", 1);
    await seedObservations(targetId, goalId, "int_b", 1);

    const response = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/briefing`),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      intentCount: 2,
      observationCount: 2,
      omittedObservationIds: [],
      truncated: false,
    });
    const rendered = String(response.body["rendered"]);
    expect(rendered).toContain("under intent int_a");
    expect(rendered).toContain("under intent int_b");
    expect(rendered).toContain("Observations above: 2. Omitted: 0.");
    // The whole record of each, not a digest of it: a case's interior is on the page.
    expect(rendered).toContain("case case-saturate:");
    expect(response.body["sizeChars"]).toBe(rendered.length);
  });

  test("over the ceiling is a 409 naming both numbers, and carries no briefing", async () => {
    const targetId = await freshTarget();
    const goalId = await newGoal(targetId);
    await seedObservations(targetId, goalId, "int_a", 1);

    const under = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/briefing`),
    );
    expect(under.status).toBe(200);
    expect(Number(under.body["sizeChars"])).toBeLessThanOrEqual(
      SUITE_BRIEFING_CEILING,
    );

    // Enough more that the total is well past the ceiling rather than just over it.
    await seedObservations(targetId, goalId, "int_b", 5);

    const over = await read(
      await signedIn(`/targets/${targetId}/goals/${goalId}/briefing`),
    );
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      _tag: "GoalBriefingRefused",
      reason: "too_large",
      goalId,
      maxChars: SUITE_BRIEFING_CEILING,
    });
    expect(Number(over.body["sizeChars"])).toBeGreaterThan(
      SUITE_BRIEFING_CEILING,
    );
    // The sentence an operator reads carries both figures and what to do about it.
    const detail = String(over.body["detail"]);
    expect(detail).toContain(String(over.body["sizeChars"]));
    expect(detail).toContain(String(SUITE_BRIEFING_CEILING));
    expect(detail).toContain("GOAL_BRIEFING_MAX_CHARS");
    // Nothing partial rode along: no text, no counts, nothing a client could render as a
    // briefing.
    for (const field of ["rendered", "observationCount", "intentCount"]) {
      expect(over.body).not.toHaveProperty(field);
    }
  });

  test("a goal nobody created, and another target's goal, are a 404 that names it", async () => {
    const targetId = await freshTarget();
    const other = await freshTarget();
    const othersGoal = await newGoal(other);
    for (const goalId of ["goal_nonesuch", othersGoal]) {
      const response = await read(
        await signedIn(`/targets/${targetId}/goals/${goalId}/briefing`),
      );
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ _tag: "GoalNotFound", goalId });
    }
    // The goal is still readable in the target that does hold it.
    const mine = await read(
      await signedIn(`/targets/${other}/goals/${othersGoal}/briefing`),
    );
    expect(mine.status).toBe(200);
  });
});

describe("a live connection that has nothing to say", () => {
  /** Scaled down together, at a ratio wider than the shipped 60:20. */
  const IDLE_TIMEOUT_SECONDS = 2;
  const FITTING_HEARTBEAT = Duration.millis(400);
  /** Longer than the timeout: the shape the server shipped with. */
  const OVERLONG_HEARTBEAT = Duration.seconds(30);
  /** Comfortably past the timeout, so surviving it is the thing being observed. */
  const WATCH_FOR_MS = 3_000;

  /** One listener of this block's own, with its own fleet, password and target. */
  interface Endpoint {
    readonly api: string;
    readonly token: string;
    readonly dispose: () => Promise<void>;
  }

  const standUp = async (options: {
    readonly name: string;
    readonly heartbeat: Duration.Duration;
  }): Promise<Endpoint> => {
    const password = `${options.name}-pass`;
    const ownFleet = FleetStore.layer(join(base, `${options.name}-fleet`));
    const layer = Layer.unwrap(
      Effect.map(Effect.context<RunNarrations>(), (shared) =>
        ControlPlaneEndpoint.layer({
          policy: POLICY,
          idleTimeout: IDLE_TIMEOUT_SECONDS,
          extraRoutes: browserApiRoutes({
            workspaceRoot,
            liveHeartbeat: options.heartbeat,
            // The sweep is left at its default on purpose. Shortening it would make the
            // record channel chatty, and chatter would keep the connection alive whether or
            // not the heartbeat ever fired — which is the one thing being measured.
          }).pipe(
            Layer.provide(BrowserSessions.layerWithPassword(password)),
            Layer.provide(TargetStores.layer.pipe(Layer.provide(ownFleet))),
            Layer.provide(ownFleet),
            Layer.provide(supervisorHolding),
            Layer.provide(HarnessResolver.empty),
            Layer.provide(Layer.succeedContext(shared)),
            Layer.orDie,
          ),
        }),
      ),
    ).pipe(
      Layer.provideMerge(RunNarrations.layer),
      Layer.provideMerge(McpCredentials.layer),
      Layer.provideMerge(McpCallCounter.layer),
      Layer.provideMerge(PolicyDecisions.layer),
      Layer.provide(
        TargetStores.ofStore("t").pipe(
          Layer.provide(
            ObservationStore.layer(join(base, `${options.name}-served.sqlite`)),
          ),
        ),
      ),
    );

    const own = ManagedRuntime.make(layer);
    const endpoint = await own.runPromise(ControlPlaneEndpoint);
    const api = `${endpoint.origin}/api/v1`;

    const opened = await fetch(`${api}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const token = String(
      ((await opened.json()) as Record<string, unknown>)["token"],
    );

    mkdirSync(join(workspaceRoot, options.name), { recursive: true });
    const created = await fetch(`${api}/targets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspacePath: join(workspaceRoot, options.name),
        name: options.name,
        scopeNote: "",
      }),
    });
    expect(created.status).toBe(200);

    return { api, token, dispose: () => own.dispose() };
  };

  let beating: Endpoint;
  let silent: Endpoint;

  beforeAll(async () => {
    beating = await standUp({ name: "beating", heartbeat: FITTING_HEARTBEAT });
    silent = await standUp({ name: "silent", heartbeat: OVERLONG_HEARTBEAT });
  });

  afterAll(async () => {
    await beating?.dispose();
    await silent?.dispose();
  });

  /**
   * Holds one connection open for a fixed wall-clock window and reports what arrived.
   *
   * Deliberately *not* `done`-driven like {@link liveFrames}: the question here is what
   * happens over time rather than whether a particular frame shows up, and "the server was
   * still holding the connection when we stopped looking" is half the answer. A reader that
   * stopped at the first frame it liked could not tell a surviving connection from one the
   * server had already hung up on.
   *
   * `Promise.race` against the deadline rather than a bare `read()`, because a healthy idle
   * connection sends nothing for a whole heartbeat and an unraced read would sit there past
   * the window.
   */
  const watchFor = async (
    endpoint: Endpoint,
    path: string,
    ms: number,
  ): Promise<{
    readonly frames: readonly LiveFrame[];
    /** True when the *server* ended the stream before the window closed. */
    readonly closedByServer: boolean;
    readonly heldForMs: number;
  }> => {
    const controller = new AbortController();
    const started = Date.now();
    const response = await fetch(`${endpoint.api}${path}`, {
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("the response carried no body");
    const decoder = new TextDecoder();
    const frames: LiveFrame[] = [];
    let buffer = "";
    let closedByServer = false;
    const deadline = started + ms;
    try {
      while (Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<"deadline">((resolve) =>
            setTimeout(
              () => resolve("deadline"),
              Math.max(0, deadline - Date.now()),
            ),
          ),
        ]).catch(() => {
          // An idle-timeout close arrives as an abrupt `ECONNRESET`, not as a clean
          // end-of-stream, so the read *throws*. Caught here and reported as what it is: a
          // server-side close. Letting it propagate failed the test with a transport error
          // instead of an assertion, which told a reader nothing about the behaviour — and
          // it is the same reason a browser cannot notice a drop by waiting for the stream
          // to end.
          closedByServer = true;
          return "closed" as const;
        });
        if (chunk === "deadline" || chunk === "closed") break;
        if (chunk.done) {
          closedByServer = true;
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          for (const line of buffer.slice(0, split).split("\n")) {
            if (line.startsWith("data:")) {
              frames.push(JSON.parse(line.slice(5).trim()) as LiveFrame);
            }
          }
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
        }
      }
    } finally {
      controller.abort();
    }
    return { frames, closedByServer, heldForMs: Date.now() - started };
  };

  const cursorFrames = (frames: readonly LiveFrame[]) =>
    frames.filter((frame) => frame._tag === "cursor");

  test("it stays open past the listener's idle timeout, sending a cursor each heartbeat", async () => {
    const watched = await watchFor(
      beating,
      "/targets/beating/live?cursor=0",
      WATCH_FOR_MS,
    );

    // The window was comfortably longer than the listener's own timeout, so surviving it
    // is a fact about the heartbeat rather than about the test being quick.
    expect(watched.heldForMs).toBeGreaterThan(IDLE_TIMEOUT_SECONDS * 1_000);
    // The point of the test: the server did not hang up.
    expect(watched.closedByServer).toBe(false);
    // More than one cursor frame on the *same* connection, which is what proves the
    // heartbeat is firing rather than the opening pair simply having arrived.
    const beats = cursorFrames(watched.frames);
    expect(beats.length).toBeGreaterThan(1);
    // And every one of them says the same true thing about a target with no events.
    expect(beats.every((frame) => frame.caughtUp)).toBe(true);
    expect(beats.every((frame) => frame.sequence === 0)).toBe(true);
  }, 15_000);

  /**
   * The control, and what it deliberately does **not** assert.
   *
   * Its job is to show that the test above passes *because of the heartbeat* rather than
   * because nothing was ever going to close the connection. So the same endpoint shape is
   * given a heartbeat longer than its own idle timeout — the shipped bug exactly — and the
   * assertion is that no heartbeat arrives in the same window.
   *
   * It is **not** an assertion about when `Bun.serve` hangs up, because that turned out not
   * to be a stable number: a standalone probe closed an idle streaming response after
   * ~4000ms with `idleTimeout` set to both 2 *and* 4, and inside this suite the close landed
   * sooner still. Bun's idle timer is evidently coarser than the value it is handed, and
   * possibly not reckoned per connection. A test that pinned a time would be asserting
   * Bun's scheduling; a test that asserts "nothing kept this one warm" is asserting ours.
   *
   * What a close *does* look like when it comes is recorded on {@link watchFor}: an abrupt
   * `ECONNRESET` rather than a clean end-of-stream — which is itself part of why a browser
   * cannot rely on the stream ending to notice, and why the client needs a silence watchdog
   * of its own (`LIVE_SILENCE_LIMIT_SECONDS`).
   */
  test("with a heartbeat longer than the timeout, nothing keeps the connection warm", async () => {
    const watched = await watchFor(
      silent,
      "/targets/silent/live?cursor=0",
      WATCH_FOR_MS,
    );

    // The opening pair arrived, so the connection and the route worked: what is missing is
    // only the thing that would have kept it alive.
    expect(watched.frames[0]?._tag).toBe("opened");
    // Exactly one cursor frame — the caught-up announcement — and no heartbeat behind it,
    // across a window the other endpoint fitted several heartbeats into.
    expect(cursorFrames(watched.frames)).toHaveLength(1);
  }, 15_000);

  test("the shipped constants satisfy the invariant a browser depends on", () => {
    // The structural half of the fix: the listener's timeout is *derived* from the
    // heartbeat, so the two cannot drift apart again. Were this to fail, every live
    // connection on a quiet target would be closed by the server before it could speak.
    expect(CONTROL_PLANE_IDLE_TIMEOUT).toBeGreaterThan(LIVE_HEARTBEAT_SECONDS);
    expect(Duration.toSeconds(LIVE_HEARTBEAT)).toBe(LIVE_HEARTBEAT_SECONDS);
    // `Bun.serve` refuses an `idleTimeout` above 255 seconds.
    expect(CONTROL_PLANE_IDLE_TIMEOUT).toBeLessThanOrEqual(255);
    // And the client's patience is longer than the heartbeat, or a healthy quiet connection
    // would be read as dead. See `LIVE_SILENCE_LIMIT_SECONDS`.
    expect(LIVE_SILENCE_LIMIT_SECONDS).toBeGreaterThan(LIVE_HEARTBEAT_SECONDS);
  });
});
