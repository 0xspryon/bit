/**
 * The shared session spine, driven with the scope importer's descriptor.
 *
 * `plan/goalConversation.test.ts` already drives the spine through the goal surface, and is
 * the safety net that says the extraction changed nothing there. This file is about what
 * the importer adds to it and what no route can yet reach: there is no "second message to
 * an import" until S3, so the concurrency property is asserted here, against the registry
 * the importer is built on, with an importer credential and the importer endpoint — the
 * same descriptor `import/scopeImporter.ts` passes.
 *
 * Real: the fleet layout and its gate installer, the credential registry. Faked: the
 * harness, because what is under test is the seam around it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Scope } from "effect";

import type { AgentHarness, McpRegistration } from "./agentHarness";
import {
  makeLiveAgentSessions,
  type LiveAgentSessions,
  type OpenPlan,
} from "./liveAgentSessions";
import { stubHarness } from "./stubHarness";
import { McpCredentials } from "../mcp/credentials";
import { FleetStore } from "../persistence/fleet";
import type { WorkerUrls } from "../run/supervisor";

const TARGET = "acme-corp";
const IMPORT = "imp_concurrent";

const URLS: WorkerUrls = {
  mcp: "http://127.0.0.1:9/api/v1/mcp",
  plannerMcp: "http://127.0.0.1:9/api/v1/planner/mcp",
  goalMcp: "http://127.0.0.1:9/api/v1/goal/mcp",
  importerMcp: "http://127.0.0.1:9/api/v1/importer/mcp",
  policy: "http://127.0.0.1:9/api/v1/policy/decide",
};

const scratches: string[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

interface Recorder {
  readonly created: { sessionId: string; multiTurn: boolean }[];
  readonly registrations: { name: string; url: string; bearer: string }[];
  readonly unregistrations: string[];
  readonly prompts: { sessionId: string; delivery: string }[];
}

/**
 * A harness with three places an opener can be parked: inside `createSession`; inside
 * `registerMcpServer`, with a credential minted and nothing yet published; and inside the
 * opening prompt, after the entry is published and before it is preambled. Every other step
 * is `Effect.sync`, so without a suspension point two openers would never interleave and
 * the permit would be tested by nothing. A fourth, inside `unregisterMcpServer`, parks a
 * *close* halfway through its scope.
 */
const gatedHarness = (
  recorder: Recorder,
  gates: {
    readonly createEntered?: Deferred.Deferred<void>;
    readonly createGate?: Deferred.Deferred<void>;
    readonly registerEntered?: Deferred.Deferred<void>;
    readonly registerGate?: Deferred.Deferred<void>;
    readonly promptEntered?: Deferred.Deferred<void>;
    readonly promptGate?: Deferred.Deferred<void>;
    readonly unregisterEntered?: Deferred.Deferred<void>;
    readonly unregisterGate?: Deferred.Deferred<void>;
  },
): AgentHarness["Service"] => {
  let minted = 0;
  return stubHarness({
    newSessionId: () => {
      minted += 1;
      return `ses_${String(minted)}`;
    },
    installGate: () => Effect.void,
    createSession: (input) =>
      Effect.gen(function* () {
        if (gates.createEntered !== undefined) {
          yield* Deferred.succeed(gates.createEntered, undefined);
        }
        if (gates.createGate !== undefined) {
          yield* Deferred.await(gates.createGate);
        }
        const id = input.sessionId ?? "ses_unchosen";
        recorder.created.push({
          sessionId: id,
          multiTurn: input.multiTurn === true,
        });
        return { id };
      }),
    registerMcpServer: (_sessionId, name, config: McpRegistration) =>
      Effect.gen(function* () {
        if (gates.registerEntered !== undefined) {
          yield* Deferred.succeed(gates.registerEntered, undefined);
        }
        if (gates.registerGate !== undefined) {
          yield* Deferred.await(gates.registerGate);
        }
        recorder.registrations.push({
          name,
          url: config.url,
          bearer: Redacted.value(
            config.headers["authorization"] ?? Redacted.make(""),
          ),
        });
      }),
    unregisterMcpServer: (sessionId) =>
      Effect.gen(function* () {
        if (gates.unregisterEntered !== undefined) {
          yield* Deferred.succeed(gates.unregisterEntered, undefined);
        }
        if (gates.unregisterGate !== undefined) {
          yield* Deferred.await(gates.unregisterGate);
        }
        recorder.unregistrations.push(sessionId);
      }),
    prompt: (sessionId, _text, delivery = { _tag: "open" as const }) =>
      Effect.gen(function* () {
        if (delivery._tag === "open") {
          if (gates.promptEntered !== undefined) {
            yield* Deferred.succeed(gates.promptEntered, undefined);
          }
          if (gates.promptGate !== undefined) {
            yield* Deferred.await(gates.promptGate);
          }
        }
        recorder.prompts.push({ sessionId, delivery: delivery._tag });
        return { delivered: true };
      }),
  });
};

/**
 * Runs `body` with an importer-shaped registry in a scope that is closed afterwards, and
 * hands back the credential registry so a test can count grants after the close.
 */
const withImporterSessions = async <A>(
  harness: AgentHarness["Service"],
  body: (input: {
    readonly sessions: LiveAgentSessions<undefined>;
    readonly plan: OpenPlan<undefined>;
    readonly credentials: McpCredentials["Service"];
  }) => Effect.Effect<A, unknown, Scope.Scope>,
) => {
  const scratch = mkdtempSync(join(tmpdir(), "bit-live-sessions-"));
  scratches.push(scratch);
  const workspace = join(scratch, "work");
  mkdirSync(workspace, { recursive: true });

  return Effect.runPromise(
    Effect.gen(function* () {
      const fleet = yield* FleetStore;
      const credentials = yield* McpCredentials;
      yield* fleet.register({
        targetId: TARGET,
        name: "Acme Corp",
        scopeNote: "",
        workspacePath: workspace,
      });
      const ended: string[] = [];
      // The layer's scope, closed by hand so the finalizer is observable.
      const layerScope = yield* Scope.make();
      const sessions = yield* makeLiveAgentSessions<undefined>(
        { fleet, endpoints: { urls: Effect.succeed(URLS) } },
        {
          endpoint: (urls) => urls.importerMcp,
          issue: (input) =>
            credentials.issueWithoutExpiry({
              _tag: "importer",
              targetId: input.targetId,
              importId: input.id,
            }),
          revokeStray: credentials.revokeImport,
          afterClose: (entry) =>
            Effect.sync(() => {
              ended.push(entry.id);
            }),
          words: {
            unregisterRefused: "unregister refused",
            strayCredential: "stray importer credential",
            closed: "closed",
            idKey: "importId",
          },
        },
      ).pipe(Scope.provide(layerScope));
      const plan: OpenPlan<undefined> = {
        targetId: TARGET,
        harness,
        model: "stub/model",
        sessionId: harness.newSessionId(),
        title: "bit scope importer: Acme Corp",
        ensureDirectory: fleet.ensureImportDirectory(TARGET, IMPORT),
        workspace,
        openingPrompt: () => "read these pages",
        meta: undefined,
      };
      const result = yield* body({ sessions, plan, credentials });
      yield* Scope.close(layerScope, Exit.void);
      return {
        result,
        ended,
        afterRelease: yield* credentials.size,
      };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          FleetStore.layer(join(scratch, "fleet")),
          McpCredentials.layer,
        ),
      ),
    ),
  );
};

const opening = (
  sessions: LiveAgentSessions<undefined>,
  plan: OpenPlan<undefined>,
) =>
  sessions.open<"opened" | "joined", unknown, never>({
    id: IMPORT,
    joined: () => Effect.succeed("joined" as const),
    refuse: (failure) => failure,
    prepare: Effect.succeed(plan),
    opened: () => Effect.succeed("opened" as const),
  });

describe("opening an import session", () => {
  test("two concurrent opens on one import make one session, one credential, one registration", async () => {
    const recorder: Recorder = {
      created: [],
      registrations: [],
      unregistrations: [],
      prompts: [],
    };
    const createEntered = Effect.runSync(Deferred.make<void>());
    const createGate = Effect.runSync(Deferred.make<void>());
    const harness = gatedHarness(recorder, { createEntered, createGate });

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          // The first opener parks inside `createSession`, holding the permit; the second
          // is started while it is parked, so the two genuinely interleave.
          const first = yield* Effect.forkChild(opening(sessions, plan));
          yield* Deferred.await(createEntered);
          const second = yield* Effect.forkChild(opening(sessions, plan));
          yield* Effect.yieldNow;
          yield* Deferred.succeed(createGate, undefined);
          return {
            answers: [yield* Fiber.join(first), yield* Fiber.join(second)],
            grants: yield* credentials.size,
            live: sessions.get(IMPORT),
          };
        }),
    );

    expect(outcome.result.answers).toEqual(["opened", "joined"]);
    expect(recorder.created).toEqual([{ sessionId: "ses_1", multiTurn: true }]);
    expect(recorder.registrations).toHaveLength(1);
    expect(recorder.registrations[0]?.url).toBe(URLS.importerMcp);
    expect(outcome.result.grants).toBe(1);
    expect(outcome.result.live?.preambled).toBe(true);
    // One opening prompt. The joiner's caller decides what to send; the spine sent nothing.
    expect(recorder.prompts).toEqual([
      { sessionId: "ses_1", delivery: "open" },
    ]);
    // And the finalizer leaves nothing behind.
    expect(outcome.afterRelease).toBe(0);
    expect(recorder.unregistrations).toEqual(["ses_1"]);
    expect(outcome.ended).toEqual([IMPORT]);
  });

  test("an opener interrupted before publish leaves no scope behind", async () => {
    const recorder: Recorder = {
      created: [],
      registrations: [],
      unregistrations: [],
      prompts: [],
    };
    const registerEntered = Effect.runSync(Deferred.make<void>());
    const registerGate = Effect.runSync(Deferred.make<void>());
    const harness = gatedHarness(recorder, { registerEntered, registerGate });

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          const opener = yield* Effect.forkChild(opening(sessions, plan));
          yield* Deferred.await(registerEntered);
          // A credential is minted into a scope that is in no map yet: the window in which
          // an interrupt used to leave a grant only process death could end.
          const during = yield* credentials.size;
          // A registration is an `acquireRelease` acquire, which is uninterruptible, so the
          // interrupt lands as soon as it completes — still before anything is published.
          // `interruptUnsafe` sends the signal now rather than from a fiber that might
          // start after the gate opens, which would let the opener finish uninterrupted.
          yield* Effect.sync(() => opener.interruptUnsafe());
          yield* Deferred.succeed(registerGate, undefined);
          yield* Fiber.await(opener);
          const after = yield* credentials.size;
          // The permit was released, so a later open is not wedged behind the dead one.
          return {
            during,
            after,
            live: sessions.get(IMPORT),
            reopened: yield* opening(sessions, plan),
          };
        }),
    );

    expect(outcome.result.during).toBe(1);
    expect(outcome.result.after).toBe(0);
    expect(outcome.result.live).toBeUndefined();
    expect(outcome.result.reopened).toBe("opened");
  });

  test("an opener interrupted after publish closes the unpreambled session rather than leave it joinable", async () => {
    const recorder: Recorder = {
      created: [],
      registrations: [],
      unregistrations: [],
      prompts: [],
    };
    const promptEntered = Effect.runSync(Deferred.make<void>());
    const promptGate = Effect.runSync(Deferred.make<void>());
    const harness = gatedHarness(recorder, { promptEntered, promptGate });

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          const opener = yield* Effect.forkChild(opening(sessions, plan));
          yield* Deferred.await(promptEntered);
          // Published, registered, holding a grant, and not yet told what it is.
          const during = {
            grants: yield* credentials.size,
            ready: sessions.ready(IMPORT),
            published: sessions.get(IMPORT)?.preambled,
          };
          yield* Fiber.interrupt(opener);
          return {
            during,
            grants: yield* credentials.size,
            live: sessions.get(IMPORT),
          };
        }),
    );

    expect(outcome.result.during).toEqual({
      grants: 1,
      ready: undefined,
      published: false,
    });
    expect(outcome.result.grants).toBe(0);
    expect(outcome.result.live).toBeUndefined();
    expect(recorder.unregistrations).toEqual(["ses_1"]);
    expect(outcome.ended).toEqual([IMPORT]);
  });
});

const freshRecorder = (): Recorder => ({
  created: [],
  registrations: [],
  unregistrations: [],
  prompts: [],
});

describe("closing an import session that is no longer the id's", () => {
  test("a stale close leaves the newer session under the same id alone", async () => {
    // The goal path's sequence, which S3's `deliverInto` makes reachable here too: two
    // messages delivered into one session whose prompts both fail. The first failure closes
    // it, a third message opens a fresh session under the same id, and only then does the
    // second failure close the session it was holding.
    const recorder = freshRecorder();
    const harness = gatedHarness(recorder, {});

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          yield* opening(sessions, plan);
          const first = sessions.get(IMPORT);
          if (first === undefined) return yield* Effect.die("no first session");
          yield* sessions.closeSession(first);
          yield* opening(sessions, { ...plan, sessionId: "ses_second" });
          // The stale close, holding the first entry.
          yield* sessions.closeSession(first);
          return {
            live: sessions.get(IMPORT)?.sessionId,
            grants: yield* credentials.size,
            unregistered: [...recorder.unregistrations],
          };
        }),
    );

    // The second session is still the id's, still holds its credential, and its
    // registration was not touched.
    expect(outcome.result.live).toBe("ses_second");
    expect(outcome.result.grants).toBe(1);
    expect(outcome.result.unregistered).toEqual(["ses_1"]);
    // One end for the first close and one for the finalizer's: the stale close records none.
    expect(outcome.ended).toEqual([IMPORT, IMPORT]);
    expect(outcome.afterRelease).toBe(0);
  });

  test("a close still taking its scope down does not revoke the credential of a session opened meanwhile", async () => {
    const recorder = freshRecorder();
    const unregisterEntered = Effect.runSync(Deferred.make<void>());
    const unregisterGate = Effect.runSync(Deferred.make<void>());
    const harness = gatedHarness(recorder, {
      unregisterEntered,
      unregisterGate,
    });

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          yield* opening(sessions, plan);
          const first = sessions.get(IMPORT);
          if (first === undefined) return yield* Effect.die("no first session");
          // The close deletes the entry, then parks in the unregister round trip...
          const closing = yield* Effect.forkChild(sessions.closeSession(first));
          yield* Deferred.await(unregisterEntered);
          // ...and a message that arrives now finds nothing live and opens a new one.
          const reopened = yield* opening(sessions, {
            ...plan,
            sessionId: "ses_second",
          });
          yield* Deferred.succeed(unregisterGate, undefined);
          yield* Fiber.join(closing);
          return {
            reopened,
            live: sessions.get(IMPORT)?.sessionId,
            grants: yield* credentials.size,
          };
        }),
    );

    expect(outcome.result.reopened).toBe("opened");
    expect(outcome.result.live).toBe("ses_second");
    // The first credential went with its scope; the second's is untouched.
    expect(outcome.result.grants).toBe(1);
    expect(outcome.afterRelease).toBe(0);
  });
});

describe("an opener that dies", () => {
  test("a defect before publish leaves no scope and no credential behind", async () => {
    const recorder = freshRecorder();
    const harness: AgentHarness["Service"] = {
      ...gatedHarness(recorder, {}),
      // After the credential is minted into a scope that is in no map.
      registerMcpServer: () =>
        Effect.die("the harness threw while registering"),
    };

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(opening(sessions, plan));
          return {
            died: Exit.hasDies(exit),
            grants: yield* credentials.size,
            live: sessions.get(IMPORT),
          };
        }),
    );

    expect(outcome.result.died).toBe(true);
    expect(outcome.result.grants).toBe(0);
    expect(outcome.result.live).toBeUndefined();
  });

  test("a defect after publish closes the unpreambled session, so the next opener builds rather than joins", async () => {
    const recorder = freshRecorder();
    const base = gatedHarness(recorder, {});
    let dies = true;
    const harness: AgentHarness["Service"] = {
      ...base,
      // The opening prompt throws once: published, registered, never told what it is.
      prompt: (sessionId, text, delivery) =>
        dies
          ? Effect.suspend(() => {
              dies = false;
              return Effect.die("the harness threw while prompting");
            })
          : base.prompt(sessionId, text, delivery),
    };

    const outcome = await withImporterSessions(
      harness,
      ({ sessions, plan, credentials }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(opening(sessions, plan));
          const after = {
            grants: yield* credentials.size,
            live: sessions.get(IMPORT),
          };
          // The permit is released. Without the close, this would find the unpreambled
          // entry inside the permit, skip the `preambled` test, and join it.
          const next = yield* opening(sessions, {
            ...plan,
            sessionId: "ses_second",
          });
          return {
            died: Exit.hasDies(exit),
            after,
            next,
            live: sessions.get(IMPORT),
          };
        }),
    );

    expect(outcome.result.died).toBe(true);
    expect(outcome.result.after).toEqual({ grants: 0, live: undefined });
    expect(outcome.result.next).toBe("opened");
    expect(outcome.result.live?.sessionId).toBe("ses_second");
    expect(outcome.result.live?.preambled).toBe(true);
    expect(recorder.unregistrations[0]).toBe("ses_1");
  });
});
