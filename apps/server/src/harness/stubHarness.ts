/**
 * A harness that answers from a script, for the tests that are not about a harness.
 *
 * Three suites need one — `run/supervisor.test.ts`, `recovery/reconcile.test.ts` and
 * `mcp/dispatch.test.ts` — and each of them is testing something *around* the agent: what
 * is forked where, what the attempt row says afterwards, which credential still resolves,
 * which store a write lands in. A real harness would make every one of those assertions
 * wait on a model and a provider login and, worse, would make "the stream died" and "the
 * harness cannot answer" states a test could not produce on demand.
 *
 * It lives in `src/` rather than in one of those files for a reason that only appeared with
 * the second harness: {@link AgentHarness} has twelve members, and three hand-written
 * copies of a twelve-member object is three places to forget the thirteenth. `persistence/
 * fixtures.ts` is here on the same grounds.
 *
 * **Every member is overridable and the defaults are the dullest possible answers**: a
 * session is created under whatever id it is handed, a prompt succeeds, a wait returns, the
 * session reports no outcome, the narration stream is empty, and the gate is installed
 * without touching a filesystem. A test overrides exactly the behaviour it is about, so a
 * reader can see what the test depends on by reading the override list.
 *
 * The one default worth noticing is {@link STUB_INSTANCE}: a stub reports a driver of its
 * own, `stub`, rather than claiming to be OpenCode. A test that wants an attempt row to
 * name a real instance says so.
 */
import { Effect, Stream } from "effect";

import {
  AgentHarness,
  type HarnessNarration,
  type MessageEntry,
  type SessionStatus,
} from "./agentHarness";
import {
  DriverKind,
  defaultInstanceIdForDriver,
  type HarnessInstance,
} from "./identity";

/** The driver a stub claims. Not `opencode`: a stub is not pretending to be one. */
export const STUB_DRIVER = DriverKind.make("stub");

export const STUB_INSTANCE: HarnessInstance = {
  instanceId: defaultInstanceIdForDriver(STUB_DRIVER),
  driver: STUB_DRIVER,
  displayName: "Scripted harness",
  version: "0",
  installed: true,
  auth: "unknown",
  defaultModel: "scripted/model",
};

export type StubHarness = AgentHarness["Service"];

/**
 * A scripted harness, with the members a test cares about replaced.
 *
 * `newSessionId` defaults to a counter rather than a random value, because a test that
 * asserts on an id it did not choose is a test that has to read the supervisor's log to
 * find out what happened.
 */
export const stubHarness = (
  overrides: Partial<StubHarness> = {},
): StubHarness => {
  let minted = 0;
  const base: StubHarness = {
    instance: STUB_INSTANCE,
    newSessionId: () => {
      minted += 1;
      return `ses_stub_${String(minted)}`;
    },
    modelProvenance: (model) => {
      const slash = model.indexOf("/");
      return slash === -1
        ? { providerId: "stub", modelId: model }
        : {
            providerId: model.slice(0, slash),
            modelId: model.slice(slash + 1),
          };
    },
    // Nothing on disk: a test that wants the real gate installed passes a real installer,
    // which `run/supervisor.test.ts` does for both harnesses' gates.
    installGate: () => Effect.void,
    createSession: (input) =>
      Effect.succeed({ id: input.sessionId ?? "ses_chosen_by_harness" }),
    registerMcpServer: () => Effect.void,
    prompt: () => Effect.void,
    waitForIdle: () => Effect.void,
    sessionStatus: () => Effect.succeed({} satisfies SessionStatus),
    messages: () => Effect.succeed([] as readonly MessageEntry[]),
    interruptSession: () => Effect.succeed(false),
    // Empty rather than open: a suite that wants a stream which stays up until it is
    // interrupted says so, and most do not read one at all.
    sessionEvents: () => Stream.empty as Stream.Stream<HarnessNarration, never>,
  };
  return AgentHarness.of({ ...base, ...overrides });
};
