/**
 * What an importer session is called, read from the harness that minted it (S9).
 *
 * The session list used to be labelled by its clock alone — `openedAt`, from bit's own
 * `import_sessions` row. Both harnesses can do better: OpenCode keeps a `title` on the
 * session row and Claude Code an `ai-title` in the transcript. This module asks for it, and
 * decides what of the answer is fit to show.
 *
 * ## The date stays, and this is why it is a separate field
 *
 * A title is as perishable as the prose (DECISIONS.md §8): it lives in the harness's storage,
 * and when the harness sweeps a session its title goes with it. The date comes from bit's own
 * durable row and does not. So a title is an *addition* beside `openedAt`, never a
 * replacement: a session whose harness has forgotten it is still identifiable by when it was
 * opened, and two sessions the harness happened to name alike are still told apart.
 *
 * It is also **never stored**. Both harnesses retitle a conversation as it develops, so a copy
 * in `import_sessions` would be a second copy of harness-owned data with no invalidation
 * story — which is the thing §8 argues against. It is read through, every time the list is.
 *
 * ## This server's own words are not a title
 *
 * Two different ways a harness could hand back something bit wrote, and each is recognised by
 * a string this server writes itself rather than by a guess about prose:
 *
 * - **OpenCode keeps the name it was created with.** The importer opens every session with
 *   `title: importerSessionTitle(targetName)`, and OpenCode generates a title only for a
 *   session that has none — so every importer session on OpenCode answers
 *   `bit scope importer: <target>` for ever. That is the same string for every session of a
 *   target and says less than the date does, so a title beginning with
 *   {@link IMPORTER_SESSION_TITLE_PREFIX} is not one.
 * - **A prompt, if a harness ever titles a session with one.** The Claude Code driver already
 *   refuses the SDK's prompt fallback (`claudeCodeHarness.sessionTitle` says why it cannot be
 *   trimmed), so today nothing reaches here that way. The check below is the second line
 *   behind it, and it is exact for the reason the replay's is: `assembleImporterPrompt` and
 *   `assembleImporterResumePrompt` end their framing with `IMPORTER_PROMPT_DELIMITER`, which
 *   `operatorTextOf` splits at, and they *begin* it with a fixed first line this module reads
 *   off the assemblers themselves. A title carrying the delimiter is shown as the operator's
 *   words below it; a title that begins with our framing and has lost the delimiter — the
 *   SDK's flattened, 200-character `firstPrompt` is exactly that — is no title at all, since
 *   whatever of the operator's words it held has been cut off.
 *
 * ## Whether the list waits for titles
 *
 * It waits, **briefly and never fatally**. The list is drawn when the importer opens, so it
 * cannot be slow, and its durable half — bit's own rows, the tallies, the end reasons — must
 * not be made to fail by a harness that is down. So every session is asked concurrently, the
 * whole fan-out is held to {@link IMPORTER_TITLES_BUDGET}, and anything that has not answered
 * by then, or answered with a failure, is simply untitled in this answer. The next read asks
 * again.
 *
 * The other arrangement — answer without titles and let the browser fetch them on a second
 * read — was weighed and not taken. Titles cost a local file read on Claude Code and a
 * localhost round trip on OpenCode, so in the ordinary case the budget is never approached
 * and the second read would be a second request, a second route and a repaint to save
 * milliseconds. The budget is what the list pays *only* when a harness is unreachable, and
 * it is paid once per list rather than once per session.
 */
import { Effect, type Duration } from "effect";

import {
  IMPORTER_PROMPT_DELIMITER,
  assembleImporterPrompt,
  assembleImporterResumePrompt,
  operatorTextOf,
} from "./importerPrompt";
import { capSessionTitle, type SessionTitle } from "../harness/agentHarness";
import type { HarnessResolver } from "../harness/resolver";

/**
 * The start of the name the importer gives every session it opens.
 *
 * Fixed text this server writes, so recognising it is exact. See this module's header on why
 * OpenCode hands it back.
 */
export const IMPORTER_SESSION_TITLE_PREFIX = "bit scope importer: ";

/** The name the importer opens a session under. One function, so the check above cannot drift from it. */
export const importerSessionTitle = (targetName: string): string =>
  `${IMPORTER_SESSION_TITLE_PREFIX}${targetName}`;

/**
 * How long the session list waits for every title together.
 *
 * Short, because the list is drawn on opening the importer and a title is decoration. In the
 * ordinary case every answer arrives in milliseconds and this is never reached; it is the
 * most a hung or unreachable harness can add to the list, once.
 */
export const IMPORTER_TITLES_BUDGET: Duration.Input = "1500 millis";

/** How many harness lookups run at once. A target's sessions grow by an operator's hand, so this is rarely the bound. */
export const IMPORTER_TITLES_CONCURRENCY = 8;

/** Whitespace collapsed, so a check holds against a harness that flattened new lines. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The first line of each kind of framing this server puts above an operator's words.
 *
 * Read off the assemblers rather than copied, so a reworded rule changes both at once. The
 * first line of each is fixed text with nothing of the target's or the operator's in it.
 */
const FRAMING_OPENINGS: readonly string[] = [
  assembleImporterPrompt({ targetName: "", links: [] }),
  assembleImporterResumePrompt({ message: "" }),
].map((prompt) => flat(prompt.split("\n")[0] ?? ""));

/**
 * The label one harness answer gives an importer session, or `undefined` for none.
 *
 * `undefined` covers every way of having nothing to show — forgotten, untitled, a name this
 * server gave, framing with no operator words left in it — because the screen draws all of
 * them the same way: by the date. The harness's own distinctions are on {@link SessionTitle},
 * where a caller that needs them still has them.
 *
 * Capped **last**, after the framing checks: the delimiter sits about three kilobytes into an
 * opener, so a title cut to `SESSION_TITLE_MAX` characters first would have lost it and
 * would show a line of this server's rules as the session's name.
 */
export const importerTitleOf = (answer: SessionTitle): string | undefined => {
  if (answer._tag !== "titled") return undefined;
  const title = answer.title;
  if (title.trimStart().startsWith(IMPORTER_SESSION_TITLE_PREFIX))
    return undefined;
  const operator = operatorTextOf(title);
  if (operator !== undefined) return capSessionTitle(operator);
  const line = flat(title);
  if (
    line.includes(flat(IMPORTER_PROMPT_DELIMITER)) ||
    FRAMING_OPENINGS.some((opening) => line.startsWith(opening))
  )
    return undefined;
  return capSessionTitle(title);
};

/**
 * What each listed importer session is called, by harness session id. Never fails.
 *
 * A session is absent from the answer when it has no title to show, for any reason: see
 * {@link importerTitleOf}, and this module's header for the budget. A session recorded
 * against a harness instance this server does not run is **not asked** — the harness we do
 * have would answer "no such session" about a session that may be alive elsewhere, which is
 * the inference `importerConversation` refuses for the same rows.
 */
export const importerSessionTitles = Effect.fnUntraced(function* (input: {
  readonly resolver: HarnessResolver["Service"];
  readonly sessions: readonly {
    readonly harnessSessionId: string;
    readonly harnessInstanceId: string | null;
  }[];
  readonly budget?: Duration.Input | undefined;
}) {
  const found = new Map<string, string>();
  const ask = (session: (typeof input.sessions)[number]) =>
    Effect.gen(function* () {
      const resolved = yield* Effect.result(
        input.resolver.resolve(session.harnessInstanceId ?? undefined),
      );
      if (resolved._tag === "Failure") return;
      if (
        session.harnessInstanceId !== null &&
        resolved.success.instance.instanceId !== session.harnessInstanceId
      )
        return;
      const answer = yield* resolved.success.harness.sessionTitle(
        session.harnessSessionId,
      );
      const title = importerTitleOf(answer);
      if (title !== undefined) found.set(session.harnessSessionId, title);
    }).pipe(
      // Any failure, and any defect in a driver, is this one session being untitled. The
      // list's durable half is bit's own rows, and a title must not be able to fail it.
      Effect.catchCause((cause) =>
        Effect.logDebug(
          "an importer session's title could not be read; it is listed by its date",
          { sessionId: session.harnessSessionId, cause },
        ),
      ),
    );
  yield* Effect.forEach(input.sessions, ask, {
    concurrency: IMPORTER_TITLES_CONCURRENCY,
    discard: true,
  }).pipe(Effect.timeoutOption(input.budget ?? IMPORTER_TITLES_BUDGET));
  // A copy, so a lookup interrupted by the budget cannot write into the answer after it is
  // returned.
  return new Map(found) as ReadonlyMap<string, string>;
});
