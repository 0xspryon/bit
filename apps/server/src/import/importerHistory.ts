/**
 * An importer conversation's prose, replayed from the harness, and whether it can be
 * carried on (S6).
 *
 * Sibling of `plan/goalNarration.ts` and built on the same accepted cost: nothing in this
 * build stores a word of a conversation (DECISIONS.md §8), so the only other copy belongs
 * to the **harness**, and this module asks for it. Claude Code sweeps its transcripts on
 * `cleanupPeriodDays`; OpenCode's retention is its own. For an import opened a while ago,
 * *gone* is the normal answer and must read as one rather than as a fault — which is why
 * this has no error channel at all past the row it is given.
 *
 * ## Five answers, and the one that is not about prose
 *
 * `harness` with messages, `pending` while a live session has produced nothing yet,
 * `forgotten` for a session the harness will not or cannot answer about, `none` for a
 * session it still knows and holds nothing under — and `absent`, which is **not** an
 * absence of prose but an absence of a conversation.
 *
 * `absent` is reachable here for a reason that is the importer's own rather than a goal's.
 * An import's index row is written *before* its session exists (`0025`), so a row whose
 * `session_created_at` is null names a session the harness may never have minted: the gate
 * would not install, the harness refused, the process died in between. Nobody has said
 * anything in that import, and reporting it with the harness's "I no longer hold that
 * session" sentence would tell an operator their message had been lost. The goal path makes
 * the same distinction for the same reason, one row earlier.
 *
 * ## `live`, `continuation` and the three different questions in there
 *
 * Whether **this process** holds the session (`live`), whether the **harness** still has
 * its prose (`source`), and whether the conversation can be **carried on**
 * (`continuation`) are three questions with three answers, and the restart case is the one
 * that proves they do not collapse:
 *
 * - after a restart the recorded session id is ours;
 * - Claude Code may still have every word of it on disk, so the prose is `harness`;
 * - the in-memory grant that let the agent act is gone, so `live` is false;
 * - and the SDK *will* resume it, so `continuation` is `resume` and the conversation is
 *   genuinely continuable.
 *
 * Collapsing the first two makes a readable conversation look dead. Collapsing the last two
 * — which is what this screen did before S6 — makes every post-restart session look dead
 * when both drivers would have continued it. And **getting `continuation` wrong in the
 * other direction is worse**: a composer offered for a session the driver cannot continue is
 * a message the operator writes and loses. So it is decided by asking the harness
 * ({@link AgentHarness.sessionContinuation}) rather than by assuming, and by
 * {@link importerReopen}, which is the *same* function `ScopeImporter.send` takes the
 * decision with — so the promise this screen makes and the thing the server then does
 * cannot disagree.
 *
 * ## The operator's own words are kept; this server's framing above them is not
 *
 * A planner round's replay drops its prompt whole: it is this server's assembly of a
 * briefing and never the agent speaking. A conversation's `user` entries are **the
 * operator**, so dropping one would leave the agent answering a question nobody can see —
 * **except** that the first of them is not only the operator. The harness stores the
 * opening prompt as one message, and that message is `assembleImporterPrompt`'s three
 * kilobytes of rules with the operator's sentence at the bottom; replayed as it stands, the
 * framing is the dominant content of the operator's own chat.
 *
 * So the framing is trimmed and the words are kept, and **there is nothing to guess**:
 * `import/importerPrompt.ts` ends its framing with `IMPORTER_PROMPT_DELIMITER`, a fixed
 * string it writes itself, and appends the operator's text after it unaltered — so
 * {@link operatorTextOf} is an exact split. It is the same technique the goal replay uses
 * one directory over, for the same reason.
 *
 * **It is not only the first entry.** A session this process has resumed gets
 * `assembleImporterResumePrompt`, which puts its own three lines above the same delimiter,
 * so a conversation that has been reconnected has framing on more than one of its `user`
 * entries. The trim is per entry and the delimiter is the same string, so nothing here
 * needed to change — but the note must not promise that only the first message was
 * trimmed, and it does not.
 */

import {
  type ImporterContinuation,
  type ImporterContinuationRefusal,
  type ImporterConversationView,
  type ImporterSessionEndReason,
  type PendingQuestion,
} from "@bit/contracts";
import { Effect, type Duration } from "effect";

import { operatorTextOf, type ImporterPromptInput } from "./importerPrompt";
import { agentById, type AgentDefinition } from "../agent/registry";
import {
  SESSION_NOT_FOUND_TAG,
  type AgentHarness,
} from "../harness/agentHarness";
import {
  pendingQuestionView,
  transcriptQuestionId,
  unansweredQuestion,
} from "../harness/questions";
import type { HarnessResolver } from "../harness/resolver";
import { roleDirectoryMatcher, sessionReopen } from "../harness/sessionReopen";
import { isRoleDirectoryId } from "../persistence/fleet";
import type { CallerContext } from "../persistence/store";
import { projectReplay } from "../run/liveTranscript";
import { uploadsFolderIn } from "../upload/uploads";

/** How long the harness is given to answer about one conversation. */
export const IMPORTER_HISTORY_FETCH_TIMEOUT: Duration.Input = "5 seconds";

/** How many items one session's replay answers with before it says it stopped (newest kept). */
export const IMPORTER_HISTORY_READ_LIMIT = 400;

/** The `import_sessions` row this reader needs, as the store answers it. */
export interface RecordedImportSession {
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string | null;
  readonly endedReason: ImporterSessionEndReason | null;
  /** `null` while the harness never confirmed creating the session. See the header. */
  readonly confirmedAt: number | null;
  /** The agent the session runs as (`0002`). See {@link importSessionAgent}. */
  readonly agentId: string;
}

/**
 * The caller kind every import session's credential is minted as.
 *
 * The scope importer registers its sessions at the importer endpoint and nowhere else, and
 * that endpoint admits this kind and refuses every other. So it is the one authority an
 * import session can carry, and an agent granted any other cannot be opened here: it would
 * be handed the importer's tools instead of its own.
 */
export const IMPORT_SESSION_ROLE =
  "importer" as const satisfies CallerContext["_tag"];

/**
 * The agent an import session may run as, by the id a row recorded, or `undefined`.
 *
 * `undefined` for an id this server does not define, and for an agent whose authority is
 * not {@link IMPORT_SESSION_ROLE}.
 *
 * **One decision for the replay and the send.** The replay answers `refused` on it, with
 * {@link agentUnavailableDetail} as its sentence, and a message to the same row is refused
 * on it with the same sentence — so a composer is never offered for a session the send
 * will not reopen.
 */
export const importSessionAgent = (
  id: string,
): AgentDefinition<ImporterPromptInput> | undefined => {
  const agent = agentById(id);
  return agent?.authority.role === IMPORT_SESSION_ROLE ? agent : undefined;
};

/** Why a session whose recorded agent {@link importSessionAgent} refuses is not continued. */
export const agentUnavailableDetail = (
  importId: string,
  agentId: string,
): string =>
  `Import ${importId}'s session runs as the agent '${agentId}', which this server does not define as an importer, so it cannot be continued. Start a new session to carry on.`;

/**
 * What a message to an import this process does not hold will do.
 *
 * `resume` carries everything the reopen needs and nothing it would have to re-derive: the
 * session to continue and the import whose directory the harness resolves it in — because
 * that directory is where the policy gate has to be, and it is not the new import's.
 */
export type ImporterReopen =
  | {
      readonly _tag: "resume";
      readonly sessionId: string;
      /** The import whose directory the session runs in. The gate goes there. */
      readonly directoryImportId: string;
      readonly detail: string;
    }
  | { readonly _tag: "fresh"; readonly detail: string };

/**
 * Whether a message to this import can continue its harness session, asked of the harness.
 *
 * The importer's half of {@link sessionReopen}, which is where the reasoning now lives:
 * never fails, every uncertainty is a `fresh` session with the reason in its sentence, and
 * the directory the harness names has to be **one of this target's own import
 * directories** — rebuilt from the id in its last segment through
 * `FleetPaths.importDirectory` and compared — because the policy gate lives in the
 * directory the session runs in.
 *
 * What is the importer's own here is the word in the refusal and the name of the id in the
 * answer: `directoryImportId`, the import whose directory the harness resolves the session
 * in, which is the original opening's and not the successor's.
 */
export const importerReopen = Effect.fnUntraced(function* (input: {
  readonly harness: AgentHarness["Service"];
  readonly targetId: string;
  readonly sessionId: string;
  /** `FleetPaths.importDirectory`, so this module builds no paths of its own. */
  readonly importDirectory: (targetId: string, importId: string) => string;
}) {
  const reopen = yield* sessionReopen({
    harness: input.harness,
    sessionId: input.sessionId,
    gatedRoleId: roleDirectoryMatcher({
      isRoleId: isRoleDirectoryId,
      rebuild: (importId) => input.importDirectory(input.targetId, importId),
    }),
    directoryWords: "import directories",
  });
  // The spine's `roleId` read as what it is on this surface: the import whose directory
  // the harness resolves the session in, which is the original opening's and not the
  // successor's. Renamed rather than passed through, because `ScopeImportRequest.resume`
  // takes `directoryImportId` and a reader of that field should not have to know that the
  // shared decision calls it something more general.
  return reopen._tag === "fresh"
    ? ({
        _tag: "fresh",
        detail: reopen.detail,
      } as const satisfies ImporterReopen)
    : ({
        _tag: "resume",
        sessionId: reopen.sessionId,
        directoryImportId: reopen.roleId,
        detail: reopen.detail,
      } as const satisfies ImporterReopen);
});

/**
 * {@link importerReopen} from a resolver and a row, for a caller that has not resolved the
 * harness yet.
 *
 * `ScopeImporter.send` is that caller: the reopen path has a row and no harness. The two
 * refusals it adds are the two the replay reports as `forgotten` for the same facts — no
 * harness to ask, and a row naming an instance this server does not run, which must not be
 * asked about because the harness we *do* have would answer a confident "no such session"
 * for a session that may be alive elsewhere.
 *
 * Both answer `fresh`, which is what the composer was promised in those cases.
 */
export const importerReopenFor = Effect.fnUntraced(function* (input: {
  readonly resolver: HarnessResolver["Service"];
  readonly targetId: string;
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string | null;
  readonly importDirectory: (targetId: string, importId: string) => string;
}) {
  const resolved = yield* Effect.result(
    input.resolver.resolve(input.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") {
    return {
      _tag: "fresh",
      detail: resolved.failure.message,
    } as const satisfies ImporterReopen;
  }
  if (
    input.harnessInstanceId !== null &&
    resolved.success.instance.instanceId !== input.harnessInstanceId
  ) {
    return {
      _tag: "fresh",
      detail: `it ran on harness instance '${input.harnessInstanceId}', which this server does not configure, so it cannot be asked about from here`,
    } as const satisfies ImporterReopen;
  }
  return yield* importerReopen({
    harness: resolved.success.harness,
    targetId: input.targetId,
    sessionId: input.harnessSessionId,
    importDirectory: input.importDirectory,
  });
});

/**
 * What the chat says of a session this process does not hold, beside whatever prose came
 * back.
 *
 * One sentence per continuation rather than one for all of them, because the operator's
 * next action differs: a `resume` continues the conversation the words above belong to, and
 * a `fresh` one starts a conversation the agent in it will not have read.
 */
const continuationNote = (reopen: ImporterReopen): string =>
  reopen._tag === "resume"
    ? ` This conversation was opened by a server process that is no longer running, so the authority behind it is gone — but the conversation itself is not: ${reopen.detail}. Your next message takes it back over, under a new import, and the importer in it keeps everything above.`
    : ` This conversation was opened by a server process that is no longer running, and it cannot be carried on: ${reopen.detail}. Your next message starts a new session, and the importer in it will not have read any of this — what this session wrote is on the Scope tab and in the Estate.`;

const empty = (input: {
  readonly targetId: string;
  readonly importId: string;
  readonly harnessSessionId: string | null;
  readonly live: boolean;
  readonly continuation: ImporterContinuation;
  readonly refusal: ImporterContinuationRefusal | null;
  readonly source: "pending" | "forgotten" | "none" | "absent";
  readonly note: string;
}): ImporterConversationView =>
  standing(
    {
      targetId: input.targetId,
      importId: input.importId,
      harnessSessionId: input.harnessSessionId,
      live: input.live,
      source: input.source,
      ephemeral: false,
      note: input.note,
      items: [],
      // A message still queued in a live session is the caller's to add (`ScopeImporter`'s
      // `replay`): this module reads the harness, which does not hold one until it is taken.
      queued: [],
      // Nothing was read, so nothing was asked. A question a live session holds is the
      // caller's to add, as its queued messages are.
      question: null,
      truncated: false,
      // Nothing was left out, because nothing came back. A count here would imply there had
      // been something to count.
      omittedBlank: 0,
      at: Date.now(),
    },
    input.continuation,
    input.refusal,
  );

/**
 * A view with its continuation, built so the union holds by construction: a refusal goes on
 * a `refused` answer and nowhere else, and a `refused` answer always has one — the
 * continuation of an import with a refusal **is** `refused`, whatever was passed beside it.
 */
const standing = (
  fields: Omit<
    Extract<ImporterConversationView, { continuation: "refused" }>,
    "continuation" | "refusal"
  >,
  continuation: ImporterContinuation,
  refusal: ImporterContinuationRefusal | null,
): ImporterConversationView =>
  refusal !== null
    ? { ...fields, continuation: "refused", refusal }
    : continuation === "refused"
      ? // Unreachable from this module: `refused` is only ever decided from a refusal. Kept
        // total rather than asserted, so a later caller that breaks that gets a continuable
        // answer it can see is wrong, never a composer left enabled under a refusal.
        { ...fields, continuation: "fresh" }
      : { ...fields, continuation };

/**
 * What is said when framing was trimmed off one or more of the operator's own messages.
 *
 * Said rather than silent, for the reason every other omission on this shape is counted: a
 * trimmed message looks shorter here than the thing the agent was actually given, and an
 * operator comparing this screen against the harness's own log would otherwise find a
 * message that does not match.
 *
 * **"Your messages", not "your first message".** It is the first one on a session that was
 * opened once and never reconnected; a resumed session carries framing above the same
 * delimiter on the first message of each authority period, so the count is *n*. A sentence
 * naming only the first would be the understatement this note exists to prevent.
 */
const FRAMING_NOTE =
  "Your messages are shown as you wrote them; the rules and instructions this server puts above them for the importer are not replayed.";

/**
 * The sentence appended to an answer about an import the operator ended.
 *
 * Separate from the two continuation notes because the fact is different in kind: the
 * others are this process having let go of a session, and this one is the authority being
 * over. The composer is disabled on it rather than offered.
 */
const ENDED_NOTE =
  "You ended this import, so its authority has ended with it: the importer's tools refuse every write under it and no message is accepted. Start a new session to carry on.";

/**
 * One importer session's conversation, as the harness still has it.
 *
 * Never fails: every way of not having the prose is one of the five sources with a sentence
 * of its own. A reader of this cannot be made to render an error for a session whose words
 * the harness simply deleted.
 */
export const importerConversation = Effect.fnUntraced(function* (input: {
  /**
   * The resolver, as a parameter rather than from the context.
   *
   * `plan/goalNarration.ts`'s reason verbatim: a requirement yielded inside an HTTP handler
   * becomes a per-request requirement of the *route*. `undefined` is a server with no
   * harness configured at all, which is a different answer from a harness that would not
   * answer and is reported as such.
   */
  readonly resolver: HarnessResolver["Service"] | undefined;
  readonly targetId: string;
  readonly importId: string;
  readonly recorded: RecordedImportSession;
  /** The session **this process** is holding for this import, if any. */
  readonly liveSessionId: string | undefined;
  /**
   * The directory that held session runs in, as the spine gated it — which for a successor
   * is the original import's, not this one's. Where its files are stored (A6 F9).
   */
  readonly liveDirectory?: string | undefined;
  /** `FleetPaths.importDirectory`. Passed in; see {@link importerReopen}. */
  readonly importDirectory: (targetId: string, importId: string) => string;
  readonly limit?: number | undefined;
  readonly fetchTimeout?: Duration.Input | undefined;
  /**
   * Told the application's ids of every operator message the transcript the harness
   * answered holds (`MessageEntry.messageIds`), **all of it** — read before the answer is cut
   * to {@link limit} (A6 U4 review 3). Not called when the harness was not read.
   *
   * What the importer joins the steers it holds to (`ImporterConversationView.queued`):
   * a steer whose copy is older than the newest `limit` items is still written, and joined
   * to the cut answer's items alone it was put back at the end of the conversation.
   */
  readonly onTranscript?: ((written: ReadonlySet<string>) => void) | undefined;
}) {
  const limit = input.limit ?? IMPORTER_HISTORY_READ_LIMIT;
  const base = { targetId: input.targetId, importId: input.importId };
  const sessionId = input.recorded.harnessSessionId;
  const live = input.liveSessionId === sessionId;
  /*
   * The operator's end is checked before anything else, and before the harness is asked.
   *
   * It is the one end that is final (`0027`): the toolkit refuses every write under it, so
   * a composer offered here would be a message accepted into a session that can do nothing.
   * The prose is still read and still shown — what was said is worth reading after the
   * authority is over — but the continuation is `refused` whatever the harness answers.
   */
  const ended = input.recorded.endedReason === "operator";
  /*
   * The other refusal, and in `send`'s order: an operator's end first, then a session this
   * process holds (which was opened here, so its agent is defined), then the recorded agent.
   * A row naming an agent this build does not define is refused by the send, so the
   * composer is disabled on it here, with the send's own sentence.
   */
  const refusalOf: ImporterContinuationRefusal | null = ended
    ? { reason: "import_ended", detail: ENDED_NOTE }
    : live || importSessionAgent(input.recorded.agentId) !== undefined
      ? null
      : {
          reason: "agent_unavailable",
          detail: agentUnavailableDetail(
            input.importId,
            input.recorded.agentId,
          ),
        };
  const refused = refusalOf !== null;
  /*
   * The refusal's sentence as the tail of a note, and as the view's own field. Both,
   * because the note is the replay's whole account and the field is what the screen words
   * the composer and the banner from — and must not read every `refused` as an end.
   */
  const refusal: string | undefined =
    refusalOf === null ? undefined : ` ${refusalOf.detail}`;

  /*
   * Nothing has ever been said here: the row exists and the session does not.
   *
   * Before the harness is asked, because there is nothing to ask about — the id on the row
   * may never have been minted. See this module's header on why this is its own answer.
   */
  if (input.recorded.confirmedAt === null) {
    return empty({
      ...base,
      harnessSessionId: null,
      live: false,
      continuation: refused ? "refused" : "fresh",
      refusal: refusalOf,
      source: "absent",
      note: refused
        ? `Nothing was ever said in import ${input.importId}: its session was never created.${refusal}`
        : `Nothing was ever said in import ${input.importId}. Its index entry was written before its session existed, and the session was never created — so there is no conversation here rather than no words. Your next message opens one.`,
    });
  }

  if (input.resolver === undefined) {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      continuation: refused ? "refused" : "fresh",
      refusal: refusalOf,
      source: "forgotten",
      note: `This server has no agent harness configured, so session ${sessionId} cannot be asked about and no message can be sent to it.${refusal ?? ""}`,
    });
  }

  const resolved = yield* Effect.result(
    input.resolver.resolve(input.recorded.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      continuation: refused ? "refused" : "fresh",
      refusal: refusalOf,
      source: "forgotten",
      note: `${resolved.failure.message} This conversation's words can only come from the harness, so they are unavailable here. What this import wrote is unaffected: its entries are on the Scope tab and its assets in the Estate.${refusal ?? ""}`,
    });
  }
  /*
   * A row naming a *different* instance is foreign and is not asked about at all: the
   * harness we do have would answer a confident "no such session" for a session that may be
   * alive elsewhere. `run/transcript.ts`, `plan/roundNarration.ts` and the goal replay all
   * refuse the same inference, and the picker disables the composer on the same fact.
   */
  if (
    input.recorded.harnessInstanceId !== null &&
    resolved.success.instance.instanceId !== input.recorded.harnessInstanceId
  ) {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      continuation: refused ? "refused" : "fresh",
      refusal: refusalOf,
      source: "forgotten",
      note: `This session ran on harness instance '${input.recorded.harnessInstanceId}', which this server does not configure, so its words cannot be asked for here and it cannot be continued from here.${refusal ?? ""}`,
    });
  }

  const harness = resolved.success.harness;
  const displayName = resolved.success.instance.displayName;
  /*
   * What the next message will do, asked once and reported.
   *
   * Only for a session this process does not hold: a live one is continued by delivering
   * into it, which needs no harness round trip and is the registry's answer rather than the
   * harness's. Not asked for a refused one either — nothing will be sent to it.
   */
  const reopen: ImporterReopen | undefined =
    live || refused
      ? undefined
      : yield* importerReopen({
          harness,
          targetId: input.targetId,
          sessionId,
          importDirectory: input.importDirectory,
        });
  const continuation: ImporterContinuation = refused
    ? "refused"
    : live
      ? "live"
      : (reopen?._tag ?? "fresh");
  /** Appended to every note, because it is the same fact whether the prose came back or not. */
  const standingNote =
    refusal !== undefined
      ? refusal
      : reopen === undefined
        ? ""
        : continuationNote(reopen);

  /*
   * Where this session's files are stored (A6 F9): `uploads/` in the directory it runs in,
   * named from this server's own record — the registry's for a held session, the import
   * directory the reopen recognised for a resumable one. A refused session is not asked
   * where it runs (nothing will be sent to it), so it is read in this import's own
   * directory, which is where it runs unless it was a successor's; a successor's lines then
   * stay words. A replay reads a path line as a file only inside this folder, so a line
   * the operator typed naming anywhere else stays their words; with no folder, every one
   * does.
   */
  const importFolder = (importId: string): string | undefined => {
    try {
      return input.importDirectory(input.targetId, importId);
    } catch {
      // `FleetPaths` throws on an id it will not build a path from: no folder, no files.
      return undefined;
    }
  };
  const runsIn = live
    ? input.liveDirectory
    : reopen === undefined
      ? importFolder(input.importId)
      : reopen._tag === "resume"
        ? importFolder(reopen.directoryImportId)
        : undefined;
  const fetched = yield* Effect.result(
    Effect.timeout(
      harness.messages(sessionId, {
        uploadsFolder:
          runsIn === undefined ? undefined : uploadsFolderIn(runsIn),
      }),
      input.fetchTimeout ?? IMPORTER_HISTORY_FETCH_TIMEOUT,
    ),
  );
  if (fetched._tag === "Failure") {
    const failure = fetched.failure;
    /*
     * "The harness has never heard of this session" and "we could not ask" are told apart
     * and said differently, which is what `SESSION_NOT_FOUND_TAG` is on the seam for. Both
     * are `forgotten` — the prose is not available either way — but an operator reading
     * "harnesses delete their transcripts" knows there is nothing to wait for, and one
     * reading "did not answer" knows there might be.
     */
    const deleted =
      failure._tag === "HarnessTransportError" &&
      (failure.tag === SESSION_NOT_FOUND_TAG || failure.status === 404);
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      continuation,
      refusal: refusalOf,
      source: "forgotten",
      note:
        (deleted
          ? `${displayName} no longer holds session ${sessionId}. Harnesses keep their own transcripts for a while and then delete them, so this is the normal answer for a session left for a while. What it wrote is not affected: its entries are on the Scope tab and its assets in the Estate.`
          : // A7-Q review 1: nor can it be asked what its agent waits on, and a question
            // offered from what this process last heard would be answered into a harness
            // that is not there (an OpenCode killed for good is not restarted). So none is
            // offered, and the note says why rather than leaving the dock silently gone.
            `${displayName} could not be asked about session ${sessionId} — ${failure.message} This is about reaching the harness, not about the conversation. Nor could it be asked whether the importer is waiting on a question, so none is offered here; one still waiting is offered again once the harness answers.`) +
        standingNote,
    });
  }

  input.onTranscript?.(
    new Set(fetched.success.flatMap((entry) => entry.messageIds ?? [])),
  );

  if (fetched.success.length === 0) {
    return empty({
      ...base,
      harnessSessionId: sessionId,
      live,
      continuation,
      refusal: refusalOf,
      source: live ? "pending" : "none",
      note: live
        ? `${displayName} holds nothing for this session yet. What the importer says will appear here as it says it.`
        : `${displayName} still holds session ${sessionId} and there are no messages under it: this session produced nothing. That is not the same as the harness having forgotten it.${standingNote}`,
    });
  }

  /*
   * The framing above each of the operator's messages, taken off before anything else.
   *
   * Before the projection and before the limit, for the goal replay's reason in the same
   * position: an entry whose text is about to change size should change size before a budget
   * is spent on it. An entry with no delimiter in it is untouched — which is every entry
   * but the openers, and is also the whole of an import started from links alone, whose
   * opening prompt has no operator message below the line at all.
   */
  const trimmed = fetched.success.map((entry) => {
    const operator = operatorTextOf(entry.text);
    return operator === undefined ? entry : { ...entry, text: operator };
  });
  const framingOmitted = trimmed.some(
    (entry, index) => entry.text !== fetched.success[index]?.text,
  );
  /*
   * The conversation as the live stream's own items (A6 F10): the operator's words, the
   * importer's replies, thinking, tool calls and their results — the importer's whole job is
   * tool calls, and they are drawn now rather than counted. What produced no item at all is
   * counted in `omittedBlank`.
   */
  const at = Date.now();
  const { items, blank } = projectReplay({
    entries: trimmed,
    subject: { _tag: "import", importId: input.importId },
    harnessSessionId: sessionId,
    users: "operator",
    fallbackAt: at,
    endedByOperator: ended,
  });
  if (items.length === 0) {
    return standing(
      {
        ...base,
        harnessSessionId: sessionId,
        live,
        // Still `harness`, not `none`: the harness **does** hold this session and did answer
        // about it. Everything it holds is empty, which is a real state, and reporting it as
        // `none` would collapse it into "the harness held nothing at all".
        source: "harness",
        ephemeral: true,
        note:
          `From ${displayName}, which may delete it. Nothing here can be shown: everything the harness holds for this session is ` +
          `${String(blank)} empty ${blank === 1 ? "message" : "messages"}. What this import wrote is on the Scope tab and in the Estate.` +
          (framingOmitted ? ` ${FRAMING_NOTE}` : "") +
          standingNote,
        items: [],
        queued: [],
        question: null,
        truncated: false,
        omittedBlank: blank,
        at,
      },
      continuation,
      refusalOf,
    );
  }

  /*
   * The newest items, not the oldest, when there are more than the limit — and still
   * oldest-first in the answer.
   *
   * The same end the goal replay keeps and for its reason: a conversation is read to pick up
   * where it left off, which is at its end. What `truncated` therefore says is that the
   * answer stopped short of the *oldest* items, and the note says so in words so an
   * operator does not read the first group on screen as the start of the session. The limit
   * counts items, the unit the screen draws.
   */
  const kept = items.length > limit ? items.slice(items.length - limit) : items;
  /*
   * A question the transcript ends on without an answer (A7-Q): its native request is gone
   * or was never this process's, so it is offered as a message where a message carries the
   * session on, and as unanswerable where none does. A question the harness is still
   * waiting on is the caller's to put over this, as `live` (`ScopeImporter`'s `replay`).
   */
  const unanswered = unansweredQuestion(items);
  const question: PendingQuestion | null =
    unanswered === undefined
      ? null
      : pendingQuestionView({
          question: {
            questionId: transcriptQuestionId(unanswered.callId),
            fields: unanswered.fields,
            askedAt: unanswered.at,
            callId: unanswered.callId,
          },
          harnessSessionId: sessionId,
          subject: {
            attemptId: null,
            roundId: null,
            goalId: null,
            importId: input.importId,
          },
          answerability:
            continuation === "live" || continuation === "resume"
              ? "message"
              : "not_resumable",
        });
  return standing(
    {
      ...base,
      harnessSessionId: sessionId,
      live,
      source: "harness",
      ephemeral: true,
      note:
        `From ${displayName}, which may delete it: this build stores no part of a conversation, so what is here lasts exactly as long as the harness keeps it. What the importer *wrote* is durable and is on the Scope tab and in the Estate.` +
        (framingOmitted ? ` ${FRAMING_NOTE}` : "") +
        (blank > 0
          ? ` ${String(blank)} empty ${blank === 1 ? "message is" : "messages are"} left out.`
          : "") +
        (kept.length < items.length
          ? ` Shortened to the most recent ${String(kept.length)} items, so this does not start at the beginning of the session.`
          : "") +
        standingNote,
      items: kept,
      queued: [],
      question,
      truncated: kept.length < items.length,
      omittedBlank: blank,
      at,
    },
    continuation,
    refusalOf,
  );
});
