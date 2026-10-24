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

import { Context, Effect, Layer, ManagedRuntime, Redacted } from "effect";

import { browserApiRoutes } from "./browserApi";
import { BrowserSessions, ensureServerPassword } from "./browserSessions";
import { ControlPlaneEndpoint } from "./controlPlane";
import { McpCredentials } from "../mcp/credentials";
import { McpCallCounter } from "../mcp/server";
import { FleetStore, HUNT_FILE } from "../persistence/fleet";
import { ObservationStore } from "../persistence/store";
import { TargetStores } from "../persistence/targetStores";
import { PolicyDecisions } from "../policy/service";

const scratch = mkdtempSync(join(tmpdir(), "bit-browser-api-"));
/** `realpath` because the OS temporary directory is itself a link on some systems. */
const base = realpathSync(scratch);
const fleetRoot = join(base, "fleet");
const workspaceRoot = join(base, "workspace");
const outside = join(base, "outside");

const POLICY = {
  forbiddenPathFragments: ["out-of-scope/"],
  allowedHosts: ["127.0.0.1"],
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

const browserApi = browserApiRoutes({ workspaceRoot }).pipe(
  Layer.provide(BrowserSessions.layer),
  // The same resolver the server builds, over the same registry: the route under test is
  // the one that opens a target's own file, so a stub here would test the stub.
  Layer.provide(TargetStores.layer.pipe(Layer.provide(fleet))),
  Layer.provide(fleet),
  Layer.orDie,
);

const testLayer = Layer.mergeAll(
  TestCredential.layer,
  ControlPlaneEndpoint.layer({ policy: POLICY, extraRoutes: browserApi }),
  McpCredentials.layer,
  McpCallCounter.layer,
  PolicyDecisions.layer,
).pipe(
  Layer.provideMerge(McpCredentials.layer),
  Layer.provideMerge(McpCallCounter.layer),
  Layer.provideMerge(PolicyDecisions.layer),
  Layer.provide(ObservationStore.layer(join(base, "served.sqlite"))),
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
      Effect.map(ensureServerPassword, (state) => state.generated ?? "").pipe(
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
