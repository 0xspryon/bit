/**
 * What this server owes a session whose process is gone, and what it is allowed to do
 * about it (S7).
 *
 * The decisions are here and the dispatch is in `recovery/continuationDispatcher.ts`. This
 * module answers four questions, each of which S7.4 asks and none of which has a defensible
 * default:
 *
 * 1. **When a continuation is owed at all** ({@link continuationTrigger}).
 * 2. **How the dead attempt's transcript is summarised** ({@link summariseTranscript},
 *    {@link readTranscriptSummary}) — mechanically, from the harness, non-fatally.
 * 3. **How often one chain may be continued** ({@link CONTINUATION_CHAIN_MAX}).
 * 4. **Whether the operator has switched it off** ({@link continuationAllowed}).
 *
 * ## The trigger: `abandoned`, and nothing else
 *
 * S7.2 says the condition is "a run is non-terminal and the process that owned it is gone",
 * and S7's first half built exactly that answer: `recovery/harnessStatus.ts`'s `abandoned`
 * — the harness knows the session, is running no turn on it, and has recorded no outcome
 * for it. Nobody will ever write that outcome, so the work was interrupted mid-turn; and
 * the conversation is still there, which is what makes it continuable.
 *
 * Every other answer is left alone, and the ones worth naming are the ones that look
 * continuable and are not:
 *
 * - `running` — a turn is in flight somewhere. Continuing would put two turns on one
 *   session.
 * - `succeeded`, `failed`, `interrupted` — the harness *stated* how the last turn ended, so
 *   nothing was left half-finished. A restart that caught a session between turns lands
 *   here, and re-prompting it would be this server starting work nobody asked for.
 * - `unreachable` — we could not ask. "Never resume on a guess" (S7.4) is the whole rule,
 *   and this is the case it is about.
 * - `missing` — the harness does not know the session. There is nothing to resume and no
 *   transcript to summarise.
 *
 * **The cost of that strictness, stated plainly: on Claude Code nothing is continued after
 * a restart today.** The driver's `sessionStatus` *fails* for any session this process does
 * not hold — the SDK's live query dies with the process that spawned it and there is no
 * re-attach — so `harnessStatus.ts` answers `missing` or `unreachable`, both of which this
 * refuses. OpenCode answers `abandoned`, because its sessions are rows in a SQLite file a
 * fresh server reads (and `serve --stdio` attaches none of OpenCode's own resume sweep, so
 * "absent from `/api/session/active`" really does mean no turn is running). The fix is not
 * here: it is for the Claude Code driver to answer `{ activity: "idle", outcome: undefined }`
 * for a transcript it still holds, which is honest now that `activity` exists and was not
 * expressible before it. That is a change to a driver with its own tests, and it is named
 * in the spec rather than smuggled in here.
 *
 * ## Two shapes, because an attempt is not a conversation (S7.3)
 *
 * The importer and the goal conversation **resume the session**: slice 6's reopen, asked of
 * the harness, with the directory check that keeps a resumed agent behind a gate this server
 * installed. Nothing here writes a second resume — {@link ContinuationSubject} names the
 * surface and the dispatcher calls that surface's own `send`.
 *
 * A worker attempt **does not**. The interrupted attempt is ended by the sweep and a new one
 * is opened beside it, seeded with a summary of the dead one's transcript
 * (`RunSupervisor.continueAttempt`). A resumed attempt would make its settlement record lie
 * about what that attempt did.
 *
 * ## What is not continued here
 *
 * A **planner round**. S7 names three surfaces and a round is not one of them: the sweep
 * settles it — which is what frees the goal, because `openRound` refuses a second running
 * round — and opening the next round is the goal agent's decision, which it makes on its own
 * resumed conversation. A round continued from here would be this server choosing the next
 * question, which is the one thing the planner exists to decide.
 */
import { Duration, Effect, Schema } from "effect";

import {
  lastAssistantText,
  type AgentHarness,
  type MessageEntry,
} from "../harness/agentHarness";
import type { HarnessResolver } from "../harness/resolver";
import type { HarnessObservedStatus } from "./harnessStatus";
import type { FleetStore } from "../persistence/fleet";

/* ── The trigger ─────────────────────────────────────────────────────────────── */

/** Whether a continuation is owed, with the sentence that goes on the durable record. */
export type ContinuationTrigger =
  | { readonly _tag: "owed"; readonly detail: string }
  | { readonly _tag: "none"; readonly detail: string };

/**
 * Whether what the harness said about a session means its work was interrupted.
 *
 * Pure, and takes the harness's own sentence so the record carries what was *seen* beside
 * what was concluded. See this module's header for why `abandoned` is the only answer that
 * is owed a continuation.
 */
export const continuationTrigger = (
  observed: HarnessObservedStatus,
  harnessDetail: string,
): ContinuationTrigger => {
  switch (observed) {
    case "abandoned":
      return {
        _tag: "owed",
        detail: `the harness knows this session, is running no turn on it and recorded no outcome, so its last turn was interrupted by the loss of the process that owned it — ${harnessDetail}`,
      };
    case "running":
      return {
        _tag: "none",
        detail: `a turn is in flight on this session, so nothing was interrupted — ${harnessDetail}`,
      };
    case "succeeded":
    case "failed":
    case "interrupted":
      return {
        _tag: "none",
        detail: `the harness stated how this session's last turn ended ('${observed}'), so nothing of it was left half-finished and there is nothing to carry on — ${harnessDetail}`,
      };
    case "unbound":
      return {
        _tag: "none",
        detail: `nothing recorded a harness session here, so there is no conversation to carry on — ${harnessDetail}`,
      };
    case "missing":
      return {
        _tag: "none",
        detail: `the harness does not know this session, so there is nothing to resume and no transcript to read — ${harnessDetail}`,
      };
    case "unreachable":
      return {
        _tag: "none",
        detail: `the harness could not be asked what became of this session, and nothing is continued on a guess — ${harnessDetail}`,
      };
  }
};

/* ── The bound ───────────────────────────────────────────────────────────────── */

/**
 * How many continuations one chain may be dispatched inside
 * {@link CONTINUATION_CHAIN_WINDOW}.
 *
 * T3 Code's number, taken as S7.4 says to take it: three chained continuations in five
 * minutes, and then nothing. The reason is not politeness. **Without a bound a crash loop
 * becomes an auto-prompt loop**: the process dies mid-turn, boots, finds an abandoned
 * session, prompts a model, dies mid-turn again — spending real money, unattended, for as
 * long as whatever is killing the process keeps killing it. Three is enough to survive the
 * single restart this feature exists for, and small enough that a loop costs three turns
 * rather than a night of them.
 */
export const CONTINUATION_CHAIN_MAX = 3;

/** The window {@link CONTINUATION_CHAIN_MAX} counts inside. T3 Code's five minutes. */
export const CONTINUATION_CHAIN_WINDOW = Duration.toMillis("5 minutes");

/* ── The subject ─────────────────────────────────────────────────────────────── */

/**
 * What a continuation is about: one of S7's three surfaces, and nothing else.
 *
 * Decoded from the outbox row's payload, which is why it is a `Schema` and not an
 * interface: a payload this build cannot read is a continuation it must not dispatch, and
 * that has to be a decode failure rather than a property access on `unknown`.
 */
export const ContinuationSubject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("attempt"),
    attemptId: Schema.String,
    /** The slice being carried on. Read back so a reader need not join the attempt row. */
    intentId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("importer"),
    /**
     * The import the message is addressed to: the newest authority period of the session.
     *
     * `ScopeImporter.send` takes it from here and does the rest — including minting the new
     * import id a resumed session is filed under, which is why nothing in the payload names
     * the successor.
     */
    importId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("goal"), goalId: Schema.String }),
]);
export type ContinuationSubject = typeof ContinuationSubject.Type;

/**
 * One continuation, as the outbox row holds it.
 *
 * Everything a dispatcher needs and nothing it would have to re-derive: it runs in a
 * different pass from the sweep that decided, possibly in a later process, so a payload
 * that leaned on an in-memory fact would be a payload that stops working exactly when the
 * outbox earns its keep.
 */
export const ContinuationRequest = Schema.Struct({
  subject: ContinuationSubject,
  targetId: Schema.String,
  /** The session the answer came from. On a worker, the dead attempt's. */
  harnessSessionId: Schema.String,
  /** The instance that session ran on, or `null` for a row written before `0014`. */
  harnessInstanceId: Schema.NullOr(Schema.String),
  /** What the harness said: `abandoned`, always, today. Recorded rather than assumed. */
  observed: Schema.String,
  /** The sweep's sentence about why this is owed. Goes on the log and the outbox row. */
  detail: Schema.String,
  /** See {@link chainKeyFor}. */
  chainKey: Schema.String,
  requestedAt: Schema.Finite,
});
export type ContinuationRequest = typeof ContinuationRequest.Type;

export const decodeContinuationRequest =
  Schema.decodeUnknownResult(ContinuationRequest);

/**
 * What the cap counts, which is a *chain* and not a row.
 *
 * Each key is the thing that stays the same when a continuation is itself continued, and
 * each one is different because what survives differs by surface:
 *
 * - **An attempt** keeps its intent. The attempt id changes by design — a continuation is a
 *   new attempt identity — so counting attempts would never reach the cap, while counting
 *   intents counts "how many times has this slice been restarted".
 * - **A goal** keeps its id across every session it ever has, including the one a failed
 *   resume replaces.
 * - **An importer conversation keeps nothing**, and this is the honest consequence: an
 *   import id names one authority period, the harness session id changes when a resume
 *   fails and a fresh conversation is opened, and no column links one period to the next.
 *   So the chain is the **target**, and two importer conversations on one target share one
 *   cap. That is coarser than the other two, and it fails in the safe direction: the thing
 *   being bounded is unattended spending on one engagement.
 */
export const chainKeyFor = (
  subject: ContinuationSubject,
  targetId: string,
): string => {
  switch (subject.kind) {
    case "attempt":
      return `intent:${subject.intentId}`;
    case "goal":
      return `goal:${subject.goalId}`;
    case "importer":
      return `importer:${targetId}`;
  }
};

/** How a subject reads in a log line or an operator-facing sentence. */
export const describeSubject = (subject: ContinuationSubject): string => {
  switch (subject.kind) {
    case "attempt":
      return `worker attempt ${subject.attemptId} (intent ${subject.intentId})`;
    case "goal":
      return `goal conversation ${subject.goalId}`;
    case "importer":
      return `importer conversation ${subject.importId}`;
  }
};

/* ── The operator's switch ───────────────────────────────────────────────────── */

/**
 * The control-tier setting that switches continuation off, globally.
 *
 * A setting rather than only an environment variable, for the reason the browser password
 * is one (`http/browserSessions.ts`): it is the operator's decision about an installation,
 * it has to survive a restart, and `control.sqlite`'s `settings` table is where §3 says
 * installation-wide operator choices live. The environment variable below is how it is
 * *set* without a screen for it.
 */
export const CONTINUATION_SETTING = "continuation";

/** The same decision for one engagement, which overrides the global one. */
export const continuationSettingFor = (targetId: string): string =>
  `${CONTINUATION_SETTING}.${targetId}`;

/**
 * The two values either setting may hold.
 *
 * A literal pair rather than a boolean-ish string, because the whole point of this slice's
 * last done criterion is that **an unreadable setting means no continuation**. `"true"`,
 * `"1"`, `"yes"` and a typo all have to be refusals, and the only way to make that true of
 * the code rather than of a comment is to decode against a closed set and treat a failure
 * as `off`.
 */
const ContinuationSwitch = Schema.Literals(["on", "off"]);
const decodeSwitch = Schema.decodeUnknownResult(ContinuationSwitch);

/** Whether continuation is on, and when it is not, the sentence saying why. */
export type ContinuationPolicy =
  { readonly _tag: "on" } | { readonly _tag: "off"; readonly detail: string };

/**
 * Whether this server may continue anything for one target.
 *
 * **Defaults to on**, which is T3 Code's default and the one that matches what this
 * feature is for: the ordinary case is one restart, and an operator who has to remember to
 * switch recovery on does not have recovery. Three things turn it off, and two of them are
 * failures rather than choices:
 *
 * - the global setting says `off`;
 * - this target's own setting says `off`, which overrides a global `on`;
 * - **either setting holds something this build cannot read, or could not be read at all.**
 *   That is the "never resume on a guess" rule, and it is deliberately the same answer as
 *   an explicit `off`: a settings row with `"maybe"` in it is a server that does not know
 *   what it was told, and a server that does not know does not prompt a model.
 *
 * A target's absent setting inherits the global one; it does not re-read it.
 */
export const continuationAllowed = Effect.fnUntraced(function* (input: {
  readonly fleet: FleetStore["Service"];
  readonly targetId: string;
}) {
  const read = (key: string) =>
    Effect.result(input.fleet.setting(key)).pipe(
      Effect.map(
        (
          outcome,
        ):
          | { readonly _tag: "absent" }
          | { readonly _tag: "value"; readonly value: "on" | "off" }
          | { readonly _tag: "unreadable"; readonly detail: string } => {
          if (outcome._tag === "Failure") {
            return {
              _tag: "unreadable",
              detail: `the setting '${key}' could not be read from the control database (${outcome.failure.message})`,
            };
          }
          if (outcome.success === undefined) return { _tag: "absent" };
          const decoded = decodeSwitch(outcome.success);
          return decoded._tag === "Success"
            ? { _tag: "value", value: decoded.success }
            : {
                _tag: "unreadable",
                detail: `the setting '${key}' holds '${outcome.success}', which is neither 'on' nor 'off'`,
              };
        },
      ),
    );

  for (const key of [
    CONTINUATION_SETTING,
    continuationSettingFor(input.targetId),
  ]) {
    const answer = yield* read(key);
    if (answer._tag === "unreadable") {
      return {
        _tag: "off",
        detail: `${answer.detail}, so nothing is continued: a continuation is a prompt into a model, and this server does not send one on a setting it cannot read`,
      } as const satisfies ContinuationPolicy;
    }
    if (answer._tag === "value" && answer.value === "off") {
      return {
        _tag: "off",
        detail: `continuation is switched off by the setting '${key}'`,
      } as const satisfies ContinuationPolicy;
    }
  }
  return { _tag: "on" } as const satisfies ContinuationPolicy;
});

/* ── The summary ─────────────────────────────────────────────────────────────── */

/** The most characters of the dead attempt's own words a continuation prompt carries. */
export const CONTINUATION_SUMMARY_MAX = 1_200;

/** How long the harness is given to answer with a dead attempt's transcript. */
export const CONTINUATION_SUMMARY_TIMEOUT = "10 seconds";

/**
 * The dead attempt's transcript, reduced to what the next worker can use.
 *
 * ## Mechanical, and that is the answer to S7.4's first question
 *
 * The alternative is a model call, and it is wrong here for three reasons that compound.
 * It **costs money on the recovery path** — the one path that runs when something has
 * already gone wrong, unattended, possibly in a loop. It **adds a failure mode exactly
 * where a new one is least affordable**: a summariser needs a harness, a model, a
 * credential, a timeout and a cap of its own, which is the whole machinery this slice is
 * trying not to need twice. And it would **paraphrase evidence**: what this hands the next
 * worker is the dead attempt's own last words, quoted, with a count of what came before —
 * where a paraphrase that drops the one fact that mattered is indistinguishable, to the
 * worker reading it, from a transcript that never contained it.
 *
 * It is worse prose than a model would write, and S7.4 says so in advance ("a mechanical
 * reduction is free and worse"). What makes that trade sound is that the summary is
 * **advisory and is not the record**: what the interrupted attempt actually established is
 * in its observations, which the new worker can read with its own tools, and what became of
 * it is on its `attempt_recoveries` row. This is a hint about where it got to, not the
 * account of it.
 *
 * ## What it says
 *
 * The number of messages the harness holds and how many of them were the worker's; the last
 * thing the worker said in words, bounded by {@link CONTINUATION_SUMMARY_MAX} and marked
 * when it is cut; and the first error any entry reported, because "it died trying this"
 * is the single most useful sentence a successor can be given. `undefined` when the
 * transcript holds nothing a successor could use — an empty list, or one with no words in
 * it — because an empty summary block is worse than none.
 */
export const summariseTranscript = (
  entries: readonly MessageEntry[],
): string | undefined => {
  if (entries.length === 0) return undefined;
  const assistant = entries.filter((entry) => entry.type === "assistant");
  const said = lastAssistantText(entries).trim();
  const error = entries.find(
    (entry) => entry.error !== undefined && entry.error !== "",
  )?.error;
  if (said === "" && error === undefined) return undefined;
  const quoted =
    said.length > CONTINUATION_SUMMARY_MAX
      ? `${said.slice(0, CONTINUATION_SUMMARY_MAX)}\n… (its reply was longer than this; the rest is in the harness's own transcript)`
      : said;
  return [
    `The harness holds ${String(entries.length)} message(s) for it, ${String(assistant.length)} of them its own.`,
    ...(said === ""
      ? ["It recorded no words of its own before it stopped."]
      : ["The last thing it said:", "", quoted]),
    ...(error === undefined
      ? []
      : [
          "",
          `An error was recorded against that session: ${error.slice(0, 400)}`,
        ]),
  ].join("\n");
};

/**
 * {@link summariseTranscript} over the harness's own `messages()`, and it cannot fail.
 *
 * **Every failure answers `undefined`**, which is the other half of S7.4's first question:
 * a continuation with no summary is better than no continuation. A harness that will not
 * answer, an instance this server does not configure, a transcript the CLI has swept, a
 * read that hangs — all of them lose the hint and none of them stops the turn.
 *
 * Bounded, like every other harness ask outside a stream: `CONTINUATION_SUMMARY_TIMEOUT`,
 * because this runs during a boot that is holding everything else up.
 *
 * It reads the harness and **not a transcript of our own**, which is DECISIONS §8 holding:
 * the transcript writer that slice removed is not reinstated by this, and both drivers
 * answer `messages()` for a session this process does not hold (verified live in S6).
 */
export const readTranscriptSummary = Effect.fnUntraced(function* (input: {
  readonly resolver: HarnessResolver["Service"];
  readonly harnessSessionId: string;
  readonly harnessInstanceId: string | null;
}) {
  const resolved = yield* Effect.result(
    input.resolver.resolve(input.harnessInstanceId ?? undefined),
  );
  if (resolved._tag === "Failure") return undefined;
  // The same check `harnessStatus.ts` makes, for the same reason: the resolver answers with
  // the default when asked for `undefined`, so a row naming an instance has to be compared
  // against what came back. Reading another harness's answer for this session id would be
  // reading another conversation's words into this prompt.
  if (
    input.harnessInstanceId !== null &&
    resolved.success.instance.instanceId !== input.harnessInstanceId
  ) {
    return undefined;
  }
  const harness: AgentHarness["Service"] = resolved.success.harness;
  const entries = yield* Effect.result(
    Effect.timeout(
      harness.messages(input.harnessSessionId),
      CONTINUATION_SUMMARY_TIMEOUT,
    ),
  );
  return entries._tag === "Failure"
    ? undefined
    : summariseTranscript(entries.success);
});

/* ── What each surface is told ───────────────────────────────────────────────── */

/**
 * The block a continued worker gets above its question (S7.3).
 *
 * It says three things, and the order is deliberate: this is a **new attempt** and the old
 * one is over, what the old one got to, and where the authoritative record of it is. The
 * last is what keeps the summary from being read as the account of what happened — a worker
 * that believed this block over `read_scope` would be reasoning from a hint.
 *
 * `summary` is absent when the harness could not be read, and then the block says so rather
 * than going quiet: a worker told nothing about its predecessor would re-derive everything,
 * and one told "there was a predecessor and we could not read it" knows to look.
 */
export const attemptContinuationNote = (input: {
  readonly replacesAttemptId: string;
  readonly summary: string | undefined;
}): string =>
  [
    `CARRYING ON FROM AN INTERRUPTED ATTEMPT`,
    ``,
    `The server process that was running attempt ${input.replacesAttemptId} on this slice`,
    `died while it was working. That attempt has been ended — its status is 'uncertain',`,
    `which means nobody established what it did — and its write authority was revoked. You`,
    `are a new attempt on the same question, with your own identity and your own tools.`,
    ``,
    ...(input.summary === undefined
      ? [
          `Its transcript could not be read, so there is no summary of it here. Treat its`,
          `work as unknown rather than as absent.`,
        ]
      : [`What it did, from the harness's own transcript:`, ``, input.summary]),
    ``,
    `Two things follow. Anything it recorded is still recorded — read the evidence before`,
    `you repeat work, because its observations are the account of what it established and`,
    `the summary above is only a hint about where it got to. And anything it did to the`,
    `target was not undone: a request it had already sent had already arrived.`,
  ].join("\n");

/**
 * The synthetic message a resumed conversation is continued with (S7.1).
 *
 * **It is written as this server speaking, and it is marked.** It arrives in the
 * conversation as a `user` entry — that is the only kind of turn either driver takes — so
 * it will appear in the operator's own chat beside sentences they really typed. Prefixing
 * it is the difference between an operator reading their own history and an operator
 * finding a message they never sent.
 *
 * It is short on purpose. The agent has its entire history above this message; what it does
 * not have is the knowledge that time passed, that its last turn was cut off, and that the
 * authority behind its tools is new. Each surface's resume prompt
 * (`assembleImporterResumePrompt`, `assembleGoalResumePrompt`) says the authority part, so
 * this says the rest.
 */
export const continuationMessage = (subject: ContinuationSubject): string =>
  subject.kind === "importer"
    ? [
        `[bit] This server restarted while you were working, so your last turn was cut off`,
        `part-way through. Nothing you were in the middle of finished.`,
        ``,
        `Carry on from where you were. Call read_scope first: everything you recorded before`,
        `the restart is still recorded, and recording an entry twice is worse than not`,
        `recording it. If you had in fact finished, say so in a sentence instead of`,
        `repeating the work.`,
      ].join("\n")
    : [
        `[bit] This server restarted while you were working, so your last turn was cut off`,
        `part-way through. Nothing you were in the middle of finished.`,
        ``,
        `Tell the operator briefly where this goal stands and what the restart interrupted,`,
        `reading your tools rather than your memory of what was running. Then carry on.`,
      ].join("\n");
