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
 * the second harness: {@link AgentHarness} has sixteen members, and three hand-written
 * copies of a sixteen-member object is three places to forget the seventeenth. `persistence/
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
import type { ModelOptionSelection } from "@bit/contracts";
import { Effect, Stream } from "effect";

import {
  AgentHarness,
  type HarnessNarration,
  type MessageEntry,
  type PromptDelivery,
  type SessionContinuation,
  type SessionStatus,
  type SessionTitle,
} from "./agentHarness";
import type { MessageAttachment } from "./attachments";
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
  // Model *views*: a name plus what that model offers. The first one carries a reasoning
  // descriptor so a test can drive the option path without inventing a shape the real
  // harnesses would not report; the second offers nothing, which is the common case.
  //
  // The first also states a context window and a compaction point, and the second states
  // neither, which is the split the two real drivers have: OpenCode's catalogue carries
  // `limit.context` on every entry and its own compaction fires below that, while Claude
  // Code's model list has no window field at all (DECISIONS.md §24.4). A stub whose every
  // model claimed a window would make the no-percentage path — the honest rendering when
  // nothing stated one — unreachable through this harness.
  //
  // 170 000 is what OpenCode's formula answers for a 200 000 window with no `input` limit;
  // see `openCodeCompactionAt`. Written out rather than computed, because a stub reporting
  // a figure derived by the code under test would agree with it by construction.
  models: [
    {
      id: "scripted/model",
      contextLimit: 200_000,
      compactionAt: 170_000,
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "default", label: "Default", isDefault: true },
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
    { id: "scripted/other" },
  ],
};

export type StubHarness = AgentHarness["Service"];

/** One `switchModel` call, as the stub received it. */
export interface RecordedModelSwitch {
  readonly sessionId: string;
  readonly model: string;
  /** Verbatim, `undefined` included: "nothing chosen" is not the same as `[]`. */
  readonly options: readonly ModelOptionSelection[] | undefined;
}

/**
 * A `switchModel` that remembers every call, for a test about a model switch.
 *
 * Separate from {@link stubHarness} rather than built into it, because a stub's members
 * are services and have nowhere to hang a list a test could read; and the default there
 * succeeds without recording, like `registerMcpServer`. A test that cares passes this as
 * the override and reads `switches` afterwards:
 *
 * ```ts
 * const recorded = recordModelSwitches();
 * const harness = stubHarness({ switchModel: recorded.switchModel });
 * // … then expect(recorded.switches).toEqual([{ sessionId, model, options }])
 * ```
 *
 * Every call is recorded, a repeat included: the seam promises a repeat is harmless, and
 * a caller that sent one should be visible to the test that asks.
 */
export const recordModelSwitches = (): {
  readonly switches: readonly RecordedModelSwitch[];
  readonly switchModel: StubHarness["switchModel"];
} => {
  const switches: RecordedModelSwitch[] = [];
  return {
    switches,
    switchModel: (sessionId, model, options) =>
      Effect.sync(() => {
        switches.push({ sessionId, model, options });
      }),
  };
};

/** One `prompt` call, as the stub received it. */
export interface RecordedPrompt {
  readonly sessionId: string;
  readonly text: string;
  /** Verbatim, `undefined` included: an omitted delivery is the seam's `open` default. */
  readonly delivery: PromptDelivery | undefined;
  /** The files it carried (A6 F9); `undefined` when the caller passed none. */
  readonly attachments: readonly MessageAttachment[] | undefined;
  /** The uploads folder the files were sent with (U13 review 4). */
  readonly uploadsFolder?: string | undefined;
}

/**
 * A `prompt` that remembers every call, for a test about what was delivered and how.
 *
 * {@link recordModelSwitches}'s shape and reason: accepted and reported as delivered, like
 * the default, and the calls kept where a test can read them — a steer's `urgency` is the
 * usual thing asked.
 */
export const recordPrompts = (): {
  readonly prompts: readonly RecordedPrompt[];
  readonly prompt: StubHarness["prompt"];
} => {
  const prompts: RecordedPrompt[] = [];
  return {
    prompts,
    prompt: (sessionId, text, delivery, files) =>
      Effect.sync(() => {
        prompts.push({
          sessionId,
          text,
          delivery,
          attachments: files?.attachments,
          uploadsFolder: files?.uploadsFolder,
        });
        return { delivered: true };
      }),
  };
};

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
    // A resume names the session it continues, as the seam says: the id comes back
    // unchanged, which is what keeps the conversation's identity.
    createSession: (input) =>
      Effect.succeed({
        id: input.resume ?? input.sessionId ?? "ses_chosen_by_harness",
      }),
    // Accepted, like every switch on a real harness that holds the session: a test that
    // wants to see the switches uses `recordModelSwitches`, and one that wants a refusal
    // overrides this with it.
    switchModel: () => Effect.void,
    registerMcpServer: () => Effect.void,
    // Succeeds without recording anything, like the registration above: a test that cares
    // which registrations were taken away says so by overriding it.
    unregisterMcpServer: () => Effect.void,
    // Accepted, always, and reported as delivered: a suite that wants a refusal or a
    // deduped retry overrides it. `PromptAccepted` rather than void since slice 9, because
    // a steer has to be able to say "that id had already been sent".
    prompt: () => Effect.succeed({ delivered: true }),
    waitForIdle: () => Effect.void,
    /*
     * Idle, with nothing recorded — which `recovery/harnessStatus.ts` reads as `abandoned`
     * and so as `uncertain`.
     *
     * This used to be `{}`, and `{}` meant `running` because `activity` did not exist.
     * `idle` is the dull answer *and* the safe one: a suite that does not script a status
     * gets "we cannot say how this ended", never "it is still going" — which is the
     * assumption that left real `running` rows behind. A test about a live turn says
     * `activity: "running"`.
     */
    sessionStatus: () =>
      Effect.succeed({ activity: "idle" } satisfies SessionStatus),
    /*
     * Resumable, with no directory stated.
     *
     * The dull answer, as every other default here is, and the *safe* dull answer: a caller
     * that must gate the directory a resumed session runs in has to refuse a continuation
     * whose directory it cannot match, so a stub that said nothing cannot trick one into
     * resuming blind. A test about resuming states the directory it means.
     */
    sessionContinuation: () =>
      Effect.succeed({
        _tag: "resumable",
        directory: undefined,
        detail: "the scripted harness still holds this session",
      } satisfies SessionContinuation),
    /*
     * Untitled: the harness holds the session and has no name for it.
     *
     * The dull answer, and the one that keeps a list drawn over a stub labelled by its own
     * dates — which is what a screen has to fall back on anyway. A test about a name states
     * it.
     */
    sessionTitle: () =>
      Effect.succeed({ _tag: "untitled" } satisfies SessionTitle),
    messages: () => Effect.succeed([] as readonly MessageEntry[]),
    interruptSession: () => Effect.succeed(false),
    // Claude Code's answer, which is the one that makes a queued message visible after a
    // Stop. A test about a harness that holds it says `held`.
    queuedOnInterrupt: "runs",
    // Nothing held, which is what a `runs` harness always answers. A test about a held
    // message says so.
    holding: () => Effect.succeed(false),
    // Nothing measured, no window: what a harness that has made no call answers.
    contextUsage: () =>
      Effect.succeed({
        used: null,
        usedModel: null,
        window: null,
        reading: "no_call_yet",
        breakdown: { _tag: "none", reason: "harness_gives_none" },
      }),
    // Ended without recording, like `unregisterMcpServer`: a test about closing overrides it.
    endSession: () => Effect.void,
    // Empty rather than open: a suite that wants a stream which stays up until it is
    // interrupted says so, and most do not read one at all.
    sessionEvents: () => Stream.empty as Stream.Stream<HarnessNarration, never>,
  };
  return AgentHarness.of({ ...base, ...overrides });
};
