/**
 * What an importer session is called: which harness answers are fit to show, and the list's
 * fan-out never failing or waiting past its budget.
 *
 * The prompts here are **real assemblies**, not short stand-ins: the delimiter sits about
 * three kilobytes into an opener, and the defect worth pinning is the one a short fixture
 * cannot reproduce — a title capped before it was split, which shows a line of this server's
 * rules as the session's name.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  IMPORTER_PROMPT_DELIMITER,
  assembleImporterPrompt,
  assembleImporterResumePrompt,
} from "./importerPrompt";
import {
  IMPORTER_SESSION_TITLE_PREFIX,
  importerSessionTitle,
  importerSessionTitles,
  importerTitleOf,
} from "./importerTitle";
import { SESSION_TITLE_MAX, type SessionTitle } from "../harness/agentHarness";
import { HarnessResolver } from "../harness/resolver";
import { STUB_INSTANCE, stubHarness } from "../harness/stubHarness";

const titled = (title: string): SessionTitle => ({ _tag: "titled", title });

const OPERATOR = "Load the staging hosts from the policy page";

/** The opener exactly as the importer sends it, with links and an operator's sentence. */
const OPENER = assembleImporterPrompt({
  targetName: "Acme Corp",
  links: ["https://acme.test/policy", "https://acme.test/scope"],
  message: OPERATOR,
});

describe("which harness answers are a title", () => {
  test("an earned title is shown as it is", () => {
    expect(importerTitleOf(titled("Acme Corp bug bounty scope review"))).toBe(
      "Acme Corp bug bounty scope review",
    );
  });

  test("forgotten and untitled have nothing to show", () => {
    expect(importerTitleOf({ _tag: "untitled" })).toBeUndefined();
    expect(
      importerTitleOf({ _tag: "forgotten", detail: "swept" }),
    ).toBeUndefined();
  });

  /**
   * OpenCode keeps the name a session was created under and never generates one over it, so
   * this is what every importer session on OpenCode answers. It is the same for every session
   * of a target, which says less than the date.
   */
  test("the name this server opened the session under is not a title", () => {
    expect(importerSessionTitle("Acme")).toStartWith(
      IMPORTER_SESSION_TITLE_PREFIX,
    );
    expect(
      importerTitleOf(titled(importerSessionTitle("Acme"))),
    ).toBeUndefined();
  });

  /**
   * The exact split. If a harness ever titled a session with its opening prompt, the operator's
   * own words are the honest part of it — and they sit below a delimiter about three
   * kilobytes in, so splitting has to happen before the cap. Cap first and this answers the
   * first 120 characters of the rules.
   */
  test("a whole opener as a title shows the operator's words, not our framing", () => {
    expect(OPENER.length).toBeGreaterThan(2_000);
    expect(OPENER.indexOf(IMPORTER_PROMPT_DELIMITER)).toBeGreaterThan(
      SESSION_TITLE_MAX,
    );
    expect(importerTitleOf(titled(OPENER))).toBe(OPERATOR);
  });

  test("a resumed session's prompt as a title shows the operator's words", () => {
    const resumed = assembleImporterResumePrompt({ message: OPERATOR });
    expect(importerTitleOf(titled(resumed))).toBe(OPERATOR);
  });

  test("the operator's words are capped to one line like any other title", () => {
    const long = `${"Read the policy and then the scope table. ".repeat(10)}\nThanks`;
    const shown = importerTitleOf(
      titled(
        assembleImporterPrompt({
          targetName: "Acme",
          links: [],
          message: long,
        }),
      ),
    );
    expect(shown).toBeDefined();
    expect(shown?.length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    expect(shown).toEndWith("…");
    expect(shown).toStartWith("Read the policy");
    expect(shown).not.toContain("\n");
  });

  /**
   * The Claude Agent SDK's `firstPrompt`: new lines flattened, cut at 200 characters. The
   * delimiter and everything below it are gone, so there is nothing of the operator's to show
   * and the framing must not stand in for it.
   */
  test("framing that lost its delimiter is no title at all", () => {
    const flattened = `${OPENER.replaceAll("\n", " ").slice(0, 200).trim()}…`;
    expect(flattened).not.toContain(OPERATOR);
    expect(importerTitleOf(titled(flattened))).toBeUndefined();
    const resumeFlattened = assembleImporterResumePrompt({ message: OPERATOR })
      .replaceAll("\n", " ")
      .slice(0, 160);
    expect(importerTitleOf(titled(resumeFlattened))).toBeUndefined();
  });

  /** An opener started from links alone has no delimiter at all, and is all framing. */
  test("an opener with no operator message is no title", () => {
    const linksOnly = assembleImporterPrompt({
      targetName: "Acme",
      links: ["https://acme.test/policy"],
    });
    expect(linksOnly).not.toContain(IMPORTER_PROMPT_DELIMITER);
    expect(importerTitleOf(titled(linksOnly))).toBeUndefined();
  });

  test("a long title is cut to one line with an ellipsis", () => {
    const shown = importerTitleOf(titled(`  Acme\n\tscope ${"x".repeat(300)}`));
    expect(shown).toStartWith("Acme scope x");
    expect(shown?.length).toBeLessThanOrEqual(SESSION_TITLE_MAX);
    expect(shown).toEndWith("…");
  });
});

describe("the list's titles", () => {
  const OTHER = "retired-harness";

  test("each session is asked of its own harness, and only titles come back", async () => {
    const titles = await Effect.runPromise(
      importerSessionTitles({
        resolver: HarnessResolver.fromEntries([
          {
            instance: STUB_INSTANCE,
            harness: stubHarness({
              sessionTitle: (sessionId) =>
                sessionId === "ses_named"
                  ? Effect.succeed(titled("Acme scope review"))
                  : sessionId === "ses_ours"
                    ? Effect.succeed(titled(importerSessionTitle("Acme")))
                    : sessionId === "ses_gone"
                      ? Effect.succeed({ _tag: "forgotten", detail: "swept" })
                      : Effect.succeed({ _tag: "untitled" }),
            }),
          },
        ]),
        sessions: [
          { harnessSessionId: "ses_named", harnessInstanceId: null },
          {
            harnessSessionId: "ses_ours",
            harnessInstanceId: STUB_INSTANCE.instanceId,
          },
          { harnessSessionId: "ses_gone", harnessInstanceId: null },
          { harnessSessionId: "ses_quiet", harnessInstanceId: null },
        ],
      }),
    );
    expect([...titles]).toEqual([["ses_named", "Acme scope review"]]);
  });

  /**
   * The constraint the list rests on: its durable half is bit's own rows, and no harness
   * answer — a failure, a defect, a session on an instance this server does not run, or no
   * answer at all — can make it fail or make it wait past the budget.
   */
  test("a failing, dying, foreign or hung harness costs a title and nothing else", async () => {
    const started = Date.now();
    const titles = await Effect.runPromise(
      importerSessionTitles({
        resolver: HarnessResolver.fromEntries([
          {
            instance: STUB_INSTANCE,
            harness: stubHarness({
              sessionTitle: (sessionId) => {
                switch (sessionId) {
                  case "ses_fails":
                    return Effect.fail(
                      // Any failure; the shape is the seam's and is not read.
                      undefined as never,
                    );
                  case "ses_dies":
                    return Effect.die("a driver defect");
                  case "ses_hangs":
                    return Effect.never;
                  case "ses_foreign":
                    return Effect.die("a foreign session must not be asked");
                  default:
                    return Effect.succeed(titled("Still named"));
                }
              },
            }),
          },
        ]),
        sessions: [
          { harnessSessionId: "ses_fails", harnessInstanceId: null },
          { harnessSessionId: "ses_dies", harnessInstanceId: null },
          { harnessSessionId: "ses_hangs", harnessInstanceId: null },
          { harnessSessionId: "ses_foreign", harnessInstanceId: OTHER },
          { harnessSessionId: "ses_fine", harnessInstanceId: null },
        ],
        budget: "200 millis",
      }),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([...titles]).toEqual([["ses_fine", "Still named"]]);
  });
});
