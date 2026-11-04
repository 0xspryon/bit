/**
 * What the transcript panel says for each thing a read can find.
 *
 * bit keeps no copy of an agent's conversation, so the harness is the only source and every
 * transcript ends in a purge. The panel therefore has three screens that have to stay
 * three, and this is the claim about rendered output the state tests cannot make:
 *
 * - the harness **has** it — shown, and labelled as the thing that may be gone;
 * - the harness **does not hold** it — gone, said plainly, with no conversation drawn;
 * - the harness **could not be asked** — not gone, and not an empty conversation.
 *
 * A panel that drew "No transcript" for the last two would satisfy every assertion in
 * `app.test.ts`, which is why it is checked here.
 *
 * Server output, so no `$effect` runs — the limit `runes.ts` records. Nothing here clicks.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import TranscriptPanel from "../src/lib/components/TranscriptPanel.svelte";
import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import { FakeServer, attemptTranscript, ok } from "./fakeServer";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const TARGET = "acme-corp";
const ATTEMPT = "attempt-1";

/** The panel, after one transcript read that the server answered as given. */
const panelAfter = async (
  answer: Parameters<typeof attemptTranscript>[0],
): Promise<string> => {
  const fake = new FakeServer();
  fake.onTranscript = () => ok(attemptTranscript(answer));
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget(TARGET);
  await settle();
  app.lastAttempts = { [TARGET]: ATTEMPT };
  await app.loadTranscript(TARGET, ATTEMPT);
  // The section that mounts the panel names the attempt: Goals the one this tab started,
  // Workers the one a link asked for. This is the Goals case.
  return render(TranscriptPanel, { props: { app, attemptId: ATTEMPT } }).body;
};

describe("the transcript panel", () => {
  test("names no attempt and draws nothing at all", () => {
    // The absent form of the prop, and the usual state of both sections that mount this:
    // no run started in this tab, and no link naming an attempt.
    const app = new App(new FakeServer(), new FakeCountdown());
    const html = render(TranscriptPanel, {
      props: { app, attemptId: "" },
    }).body;
    expect(html).not.toContain("Read transcript");
    expect(html).not.toContain("Attempt transcript");
  });

  test("a transcript the harness has is shown, labelled as one that may be gone", async () => {
    const html = await panelAfter({
      source: "harness",
      ephemeral: true,
      note: "From Claude Code, which may delete it.",
      entries: [
        { index: 0, type: "assistant", text: "probing the login form" },
      ],
    });
    expect(html).toContain("From the harness, may be gone");
    expect(html).toContain("probing the login form");
    expect(html).not.toContain("No longer available");
    expect(html).not.toContain("Could not ask the harness");
  });

  test("an entry's text and error mark bidi and zero-width characters as code does", async () => {
    // A transcript holds whatever the agent fetched: a host reordered by an isolate, or
    // with a zero-width space in it, shows each hidden character as its code point.
    const html = await panelAfter({
      source: "harness",
      ephemeral: true,
      note: "From Claude Code, which may delete it.",
      entries: [
        {
          index: 0,
          type: "tool_result",
          text: "Scope: \u2067com\u200F.\u200Facme\u2069 only, \u05E9\u05DC\u05D5\u05DD",
          error: "ac\u200Bme.com refused",
        },
      ],
    });
    expect(html).toContain('<span class="char-escape');
    const plain = html.replace(/<[^>]*>/g, "");
    expect(plain).toContain(
      "Scope: ⟨U+2067⟩com⟨U+200F⟩.⟨U+200F⟩acme⟨U+2069⟩ only, \u05E9\u05DC\u05D5\u05DD",
    );
    expect(plain).toContain("ac⟨U+200B⟩me.com refused");
    expect(/[\u200B\u200F\u2067\u2069]/u.test(html)).toBe(false);
  });

  test("a transcript the harness does not hold reads as gone, with nothing drawn", async () => {
    const html = await panelAfter({
      source: "absent",
      note: "No longer available: Claude Code no longer holds session ses_1.",
    });
    expect(html).toContain("No longer available");
    expect(html).toContain("no longer holds session ses_1");
    expect(html).not.toContain("Could not ask the harness");
    expect(html).not.toContain("From the harness, may be gone");
    // Gone is not an error and not an empty conversation.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('class="entries');
  });

  test("a harness that could not be asked does not read as gone", async () => {
    const html = await panelAfter({
      source: "unreachable",
      note: "Could not ask Claude Code about session ses_1: connection refused The transcript may still exist there.",
    });
    expect(html).toContain("Could not ask the harness");
    expect(html).toContain("may still exist there");
    expect(html).not.toContain("No longer available");
    expect(html).not.toContain("From the harness, may be gone");
    expect(html).not.toContain('class="entries');
  });
});
