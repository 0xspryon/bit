/**
 * The five answers an importer conversation can come back with, and the fourth question
 * beside them: whether the next message will work.
 *
 * Nothing stores a word of an importer session (DECISIONS.md §8), so this reader is the
 * whole of what a reloaded Auto-load page can show — and its interesting answers are the
 * empty ones. An operator looking at a session with no prose has to be able to tell "it has
 * only just started" from "the harness deleted it" from "it said nothing" from "nothing was
 * ever said here", because the first is worth waiting for, the second and third are not, and
 * the fourth means their message never landed at all.
 *
 * There is no error channel to assert on, which is itself the point: a session whose words
 * the harness has swept is the *expected* state of anything a month old, and a reader that
 * could be made to render a failure for it would make the common case look like a fault.
 *
 * The other half of the file is `continuation`, and it is the half that can cost the operator
 * a message. A composer offered for a session the driver cannot continue is a message written
 * and lost, so every one of these tests asks the harness rather than assuming — including the
 * two that refuse a resume the harness *would* have accepted, because the directory it
 * resolves the session in is not one this server gates.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { HarnessTransportError } from "../harness/errors";
import { HarnessResolver } from "../harness/resolver";
import { STUB_INSTANCE, stubHarness } from "../harness/stubHarness";
import { SESSION_NOT_FOUND_TAG } from "../harness/agentHarness";
import type {
  MessageEntry,
  SessionContinuation,
} from "../harness/agentHarness";

import {
  importerConversation,
  importerReopen,
  type RecordedImportSession,
} from "./importerHistory";
import {
  assembleImporterPrompt,
  assembleImporterResumePrompt,
} from "./importerPrompt";

const TARGET = "acme-corp";
const IMPORT = "imp_1";
const SESSION = "ses_1";

/** Where this target's import directories are, as `FleetPaths` builds them. */
const importDirectory = (targetId: string, importId: string) =>
  `/fleet/targets/${targetId}/import/${importId}`;

const recorded = (
  over: Partial<RecordedImportSession> = {},
): RecordedImportSession => ({
  harnessSessionId: SESSION,
  harnessInstanceId: STUB_INSTANCE.instanceId,
  endedReason: null,
  confirmedAt: 1_700_000_000_000,
  ...over,
});

const entry = (over: Partial<MessageEntry> = {}): MessageEntry => ({
  type: "assistant",
  text: "two in, one out",
  error: undefined,
  ...over,
});

/**
 * One read, through a resolver holding one scripted harness.
 *
 * `messages` and `sessionContinuation` are the only two members any of this touches, so a
 * test states one or both and nothing else — which is also the assertion that this reader
 * asks the harness nothing else. **`sessionStatus` in particular**: the defect it carries for
 * a session from a dead process is S7's, and a default that dies is how this file proves
 * nothing here reaches it.
 */
/** One scripted answer to "do you still hold this session", in the seam's shape. */
const continuing =
  (answer: SessionContinuation) => (): Effect.Effect<SessionContinuation> =>
    Effect.succeed(answer);

const read = (input: {
  readonly recorded?: RecordedImportSession;
  readonly messages?: readonly MessageEntry[];
  readonly fail?: HarnessTransportError;
  readonly continuation?: SessionContinuation | undefined;
  readonly resolver?: HarnessResolver["Service"] | undefined;
  readonly live?: boolean;
  readonly limit?: number;
}) =>
  Effect.runPromise(
    importerConversation({
      resolver:
        "resolver" in input
          ? input.resolver
          : HarnessResolver.fromEntries([
              {
                instance: STUB_INSTANCE,
                harness: stubHarness({
                  messages: () =>
                    input.fail === undefined
                      ? Effect.succeed(input.messages ?? [])
                      : Effect.fail(input.fail),
                  ...(input.continuation === undefined
                    ? {}
                    : { sessionContinuation: continuing(input.continuation) }),
                  sessionStatus: () =>
                    Effect.die(
                      "the replay must not ask how a session's last turn ended",
                    ),
                }),
              },
            ]),
      targetId: TARGET,
      importId: IMPORT,
      recorded: input.recorded ?? recorded(),
      liveSessionId: input.live === true ? SESSION : undefined,
      importDirectory,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  );

describe("the five answers, each with its own sentence", () => {
  test("a row whose session was never created is absent: nothing was ever said here", async () => {
    const view = await read({ recorded: recorded({ confirmedAt: null }) });
    expect(view.source).toBe("absent");
    // The id on the row may never have been minted, so there is nothing to name as the
    // session this was read from.
    expect(view.harnessSessionId).toBeNull();
    expect(view.live).toBe(false);
    expect(view.note).toContain("Nothing was ever said");
    // And it is not the harness's "I no longer hold that session", which would tell an
    // operator their message had been lost.
    expect(view.note).not.toContain("no longer holds");
    expect(view.continuation).toBe("fresh");
  });

  test("a live session the harness holds nothing for is pending, not none", async () => {
    const view = await read({ messages: [], live: true });
    expect(view.source).toBe("pending");
    expect(view.live).toBe(true);
    expect(view.note).toContain("holds nothing for this session yet");
    // Live, so the next message is delivered into it: no harness round trip was needed and
    // none was made.
    expect(view.continuation).toBe("live");
  });

  test("a session the harness still holds and has nothing under is none", async () => {
    const view = await read({
      messages: [],
      continuation: {
        _tag: "resumable",
        directory: importDirectory(TARGET, IMPORT),
        detail: "still held",
      },
    });
    expect(view.source).toBe("none");
    expect(view.note).toContain("produced nothing");
    expect(view.note).toContain("not the same as the harness having forgotten");
  });

  test("a harness that has swept the transcript is forgotten, and says there is nothing to wait for", async () => {
    const view = await read({
      fail: new HarnessTransportError({
        operation: "message.list",
        status: 404,
        tag: SESSION_NOT_FOUND_TAG,
        detail: "no such session",
        cause: undefined,
      }),
      continuation: { _tag: "unresumable", detail: "the transcript is gone" },
    });
    expect(view.source).toBe("forgotten");
    expect(view.messages).toEqual([]);
    expect(view.note).toContain("no longer holds session");
    expect(view.note).toContain("delete them");
    // What it wrote is unaffected, and that is what makes losing the prose acceptable.
    expect(view.note).toContain("Scope tab");
    // And the composer is told the truth about what is left: a new session, not a resume.
    expect(view.continuation).toBe("fresh");
    expect(view.note).toContain("cannot be carried on");
  });

  test("a harness that would not answer is forgotten too, and says it differently", async () => {
    const view = await read({
      fail: new HarnessTransportError({
        operation: "message.list",
        status: undefined,
        tag: "TimeoutError",
        detail: "request exceeded its transport bound",
        cause: undefined,
      }),
      continuation: {
        _tag: "resumable",
        directory: importDirectory(TARGET, IMPORT),
        detail: "still held",
      },
    });
    expect(view.source).toBe("forgotten");
    expect(view.note).toContain("could not be asked");
    expect(view.note).toContain("about reaching the harness");
    /*
     * **The prose being unavailable does not make the conversation dead.** This is the
     * reason `source` and `continuation` are two fields: a read that timed out says nothing
     * about whether the session can be prompted, and the harness said it can.
     */
    expect(view.continuation).toBe("resume");
  });

  test("messages that came back are harness, oldest first, and marked as the harness's to delete", async () => {
    const view = await read({
      messages: [
        entry({ type: "user", text: "read the policy page" }),
        entry({ text: "two in, one out" }),
      ],
      continuation: {
        _tag: "resumable",
        directory: importDirectory(TARGET, IMPORT),
        detail: "still held",
      },
    });
    expect(view.source).toBe("harness");
    expect(view.ephemeral).toBe(true);
    expect(view.messages.map((message) => message.text)).toEqual([
      "read the policy page",
      "two in, one out",
    ]);
    expect(view.messages.map((message) => message.index)).toEqual([0, 1]);
    expect(view.truncated).toBe(false);
    expect(view.note).toContain("which may delete it");
  });

  test("a server with no harness configured is forgotten, and says that rather than blaming the harness", async () => {
    const view = await read({ resolver: undefined });
    expect(view.source).toBe("forgotten");
    expect(view.note).toContain("no agent harness configured");
    expect(view.continuation).toBe("fresh");
  });

  test("a session on an instance this server does not run is not asked about at all", async () => {
    const view = await read({
      recorded: recorded({ harnessInstanceId: "claude-code-2" }),
    });
    expect(view.source).toBe("forgotten");
    expect(view.note).toContain("claude-code-2");
    expect(view.note).toContain("does not configure");
    // Not asked, because the harness we do have would answer a confident "no such session"
    // for a session that may be alive elsewhere.
    expect(view.continuation).toBe("fresh");
  });
});

describe("tool calls and results, which are most of an importer session", () => {
  test("blank entries are dropped and counted, and a session of nothing but calls is still harness", async () => {
    const view = await read({
      messages: [
        entry({ type: "user", text: "" }),
        entry({ text: "" }),
        entry({ text: "" }),
      ],
    });
    // `harness`, not `none`: the harness does hold this session and did answer about it.
    expect(view.source).toBe("harness");
    expect(view.messages).toEqual([]);
    expect(view.omittedBlank).toBe(3);
    expect(view.note).toContain("3 tool calls and results");
  });

  test("an entry with an error and no words is kept: a failure is still the importer telling us something", async () => {
    const view = await read({
      messages: [entry({ text: "", error: "the page would not load" })],
    });
    expect(view.messages).toEqual([
      {
        index: 0,
        type: "assistant",
        text: "",
        error: "the page would not load",
      },
    ]);
    expect(view.omittedBlank).toBe(0);
  });
});

describe("the operator's words, with this server's framing taken off", () => {
  test("the opener replays as the operator's sentence and not as three kilobytes of rules", async () => {
    const opener = assembleImporterPrompt({
      targetName: "Acme Corp",
      links: [],
      message:
        "Read https://hackerone.com/acme/policy and say what is in scope",
    });
    // The fixture is the real assembler's output, so the split cannot drift from the thing
    // it splits: `roundNarration.test.ts`'s rule, for its reason.
    expect(opener.length).toBeGreaterThan(2_000);
    const view = await read({
      messages: [entry({ type: "user", text: opener })],
    });
    expect(view.messages[0]?.text).toBe(
      "Read https://hackerone.com/acme/policy and say what is in scope",
    );
    expect(view.note).toContain("Your messages are shown as you wrote them");
  });

  test("a resumed conversation has framing on more than one entry, and every one is trimmed", async () => {
    const view = await read({
      messages: [
        entry({
          type: "user",
          text: assembleImporterPrompt({
            targetName: "Acme Corp",
            links: [],
            message: "first ask",
          }),
        }),
        entry({ text: "first answer" }),
        entry({
          type: "user",
          text: assembleImporterResumePrompt({ message: "second ask" }),
        }),
      ],
    });
    expect(view.messages.map((message) => message.text)).toEqual([
      "first ask",
      "first answer",
      "second ask",
    ]);
  });

  test("a later message travels verbatim and is left exactly as it is", async () => {
    const view = await read({
      messages: [entry({ type: "user", text: "also the staging hosts" })],
    });
    expect(view.messages[0]?.text).toBe("also the staging hosts");
    // Nothing was trimmed, so nothing is said about trimming.
    expect(view.note).not.toContain("Your messages are shown");
  });

  test("an import started from links alone has no operator message below the line, and keeps its prompt", async () => {
    // Its opening prompt has no delimiter at all: there is nothing of the operator's in it.
    const opener = assembleImporterPrompt({
      targetName: "Acme Corp",
      links: ["https://hackerone.com/acme/policy"],
    });
    const view = await read({
      messages: [entry({ type: "user", text: opener })],
    });
    expect(view.messages[0]?.text).toBe(opener);
    expect(view.note).not.toContain("Your messages are shown");
  });
});

describe("a long conversation keeps its end", () => {
  test("the newest are kept, oldest first, and the note says it does not start at the beginning", async () => {
    const many = Array.from({ length: 10 }, (_at, index) =>
      entry({ text: `line ${String(index)}` }),
    );
    const view = await read({ messages: many, limit: 3 });
    expect(view.truncated).toBe(true);
    expect(view.messages.map((message) => message.text)).toEqual([
      "line 7",
      "line 8",
      "line 9",
    ]);
    expect(view.note).toContain("most recent 3 messages");
    expect(view.note).toContain("does not start at the beginning");
  });
});

describe("an import the operator ended", () => {
  test("is refused rather than offered, and its words are still shown", async () => {
    const view = await read({
      recorded: recorded({ endedReason: "operator" }),
      messages: [entry({ text: "two in, one out" })],
    });
    // The prose is worth reading after the authority is over.
    expect(view.source).toBe("harness");
    expect(view.messages).toHaveLength(1);
    expect(view.continuation).toBe("refused");
    expect(view.note).toContain("refuse every write");
  });

  test("is not asked about: the harness is never consulted for a session nothing will be sent to", async () => {
    // A harness whose continuation answer dies. Reached, the test fails; not reached, the
    // `refused` answer above was taken without a round trip, which is the assertion.
    const view = await Effect.runPromise(
      importerConversation({
        resolver: HarnessResolver.fromEntries([
          {
            instance: STUB_INSTANCE,
            harness: stubHarness({
              messages: () => Effect.succeed([]),
              sessionContinuation: () =>
                Effect.die("an ended import is not asked about"),
            }),
          },
        ]),
        targetId: TARGET,
        importId: IMPORT,
        recorded: recorded({ endedReason: "operator" }),
        liveSessionId: undefined,
        importDirectory,
      }),
    );
    expect(view.continuation).toBe("refused");
  });

  test("an end the *server* recorded is not refused: a message to it opens a way on", async () => {
    for (const reason of ["shutdown", "refused", "open_failed"] as const) {
      const view = await read({
        recorded: recorded({ endedReason: reason }),
        messages: [],
        continuation: {
          _tag: "resumable",
          directory: importDirectory(TARGET, IMPORT),
          detail: "still held",
        },
      });
      expect(view.continuation).toBe("resume");
    }
  });
});

/**
 * The decision `send` then acts on, asked of the harness.
 *
 * Tested through {@link importerReopen} directly as well as through the view, because the
 * directory check is the part that is about *authority* rather than about resuming: the
 * policy gate lives in the directory a session runs in, so a resume into a directory this
 * server did not gate is an agent whose tool calls nothing is consulting.
 */
describe("whether a session this process does not hold can be carried on", () => {
  const ask = (continuation: SessionContinuation | (() => never)) =>
    Effect.runPromise(
      importerReopen({
        harness: stubHarness({
          sessionContinuation: () =>
            typeof continuation === "function"
              ? Effect.fail(
                  new HarnessTransportError({
                    operation: "session.get",
                    status: undefined,
                    tag: undefined,
                    detail: "the harness did not answer",
                    cause: undefined,
                  }),
                )
              : Effect.succeed(continuation),
        }),
        targetId: TARGET,
        sessionId: SESSION,
        importDirectory,
      }),
    );

  test("a harness that still holds it, in one of this target's import directories, is resumed there", async () => {
    const reopen = await ask({
      _tag: "resumable",
      // The *original* import's directory, which is not the one the successor will be
      // filed under: both drivers resolve a conversation where it was created.
      directory: importDirectory(TARGET, "imp_first"),
      detail: "still on disk",
    });
    expect(reopen).toEqual({
      _tag: "resume",
      sessionId: SESSION,
      directoryImportId: "imp_first",
      detail: "still on disk",
    });
  });

  test("a directory that is not one of this target's is a fresh session, not an ungated resume", async () => {
    const reopen = await ask({
      _tag: "resumable",
      directory: "/home/operator/somewhere-else",
      detail: "still on disk",
    });
    expect(reopen._tag).toBe("fresh");
    expect(reopen.detail).toContain(
      "not one of this target's own import directories",
    );
  });

  test("another target's import directory is not this target's either", async () => {
    const reopen = await ask({
      _tag: "resumable",
      directory: importDirectory("other-target", "imp_first"),
      detail: "still on disk",
    });
    expect(reopen._tag).toBe("fresh");
  });

  test("a harness that does not say where it runs the session is a fresh one", async () => {
    const reopen = await ask({
      _tag: "resumable",
      directory: undefined,
      detail: "still on disk",
    });
    expect(reopen._tag).toBe("fresh");
    expect(reopen.detail).toContain("did not say which directory");
  });

  test("a session killed before its first prompt was saved is a fresh one, and says so", async () => {
    const reopen = await ask({
      _tag: "unresumable",
      detail:
        "it has a transcript with no first prompt in it, so there is no conversation to load",
    });
    expect(reopen._tag).toBe("fresh");
    expect(reopen.detail).toContain("no first prompt");
  });

  test("a harness that cannot be asked is a fresh session: a resume that was promised and refused loses a message", async () => {
    const reopen = await ask(() => {
      throw new Error("unused");
    });
    expect(reopen._tag).toBe("fresh");
    expect(reopen.detail).toContain("could not be asked");
  });
});
