/**
 * The importer's chat (A6 D2–D5), driven the way a person drives it: choose a starter, type,
 * press Enter, stop it, open a session from the crumb bar.
 *
 * `importerChat.test.ts` owns the grouping rule against plain data. What it cannot see is
 * that a starter button puts the caret in the box, that Enter sends and Shift+Enter does
 * not, that Stop turns a pending write into an unresolved one *on screen*, or that choosing
 * a row in the crumb bar's picker changes the thread under it. Those are the claims here.
 *
 * Every state is reached through `scenarios`, the same entry the state picker uses, so a
 * scenario that stops loading fails here rather than in front of the person judging it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { App, scenarios } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer } from "../fakeServer";
import { click, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

/** The page and the crumb bar, in the state a scenario puts the app in. */
const show = async (id: string): Promise<App> => {
  const app = new App(new FakeServer(), new FakeCountdown());
  const scenario = scenarios.find((each) => each.id === id);
  if (scenario === undefined) throw new Error(`no scenario "${id}"`);
  scenario.apply(app);
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return app;
};

const text = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

const button = (label: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((each) =>
    each.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
};

const hasButton = (label: string): boolean =>
  [...document.querySelectorAll("button")].some((each) =>
    each.textContent?.replace(/\s+/g, " ").trim().startsWith(label),
  );

const composer = (): HTMLTextAreaElement => {
  const box = document.querySelector<HTMLTextAreaElement>("#importer-message");
  if (box === null) throw new Error("no composer");
  return box;
};

/** What typing does: set the value, then tell the handler. */
const type = (box: HTMLTextAreaElement, value: string): void => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** The conversation's groups, each as its separator's words. */
const headings = (): string[] =>
  [...document.querySelectorAll('[role="log"] > .group > .sep')].map(
    (each) => each.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );

/** Every status chip on a tool-call row, in order. */
const chips = (): string[] =>
  [...document.querySelectorAll(".item .chip")].map(
    (each) => each.textContent?.trim() ?? "",
  );

describe("D2: a new session", () => {
  test("is an empty chat with a composer and two starters, and no form", async () => {
    await show("importer-first");

    expect(headings()).toEqual([]);
    expect(text()).toContain("The importer reads, narrates what it is doing");
    expect(composer().disabled).toBe(false);
    expect(hasButton("Read a HackerOne or Bugcrowd program page")).toBe(true);
    expect(hasButton("Paste a statement of work")).toBe(true);
    // The link list, the model picker and the run button are the page it replaced.
    expect(
      document.querySelector('input[aria-label="Program link"]'),
    ).toBeNull();
    expect(hasButton("Start import")).toBe(false);
    expect(button("New session")).toBeDefined();
  });

  test("a starter fills the composer, puts the caret after it and sends nothing", async () => {
    const app = await show("importer-first");

    click(button("Read a HackerOne or Bugcrowd program page"));
    await settle();

    const box = composer();
    expect(box.value).toBe("Read the program page at https://");
    // Where the operator's own words go next, not on the button they just pressed.
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(box.value.length);
    expect(headings()).toEqual([]);
    expect(app.importer.current?.tally.messages).toBe(0);
  });
});

describe("sending a message", () => {
  test("Enter sends it as the heading of a new group and the composer stays open", async () => {
    await show("importer-first");
    const box = composer();
    type(box, "Read https://bugcrowd.com/acme and load it");
    box.focus();

    press("Enter");
    await settle();

    expect(headings()).toHaveLength(1);
    expect(headings()[0]).toContain(
      "Read https://bugcrowd.com/acme and load it",
    );
    expect(composer().value).toBe("");
    expect(composer().disabled).toBe(false);
    // The starters are first messages; once one is sent the thread is the prompt.
    expect(hasButton("Paste a statement of work")).toBe(false);
    expect(button("Session")).toBeDefined();
  });

  test("Shift+Enter is a newline and sends nothing, and an empty box cannot send", async () => {
    await show("importer-first");
    const box = composer();
    const send = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Send to the importer"]',
    );
    expect(send?.disabled).toBe(true);

    type(box, "half a thought");
    box.focus();
    press("Enter", { shiftKey: true });
    await settle();

    expect(headings()).toEqual([]);
    expect(composer().value).toBe("half a thought");
    expect(send?.disabled).toBe(false);
  });

  test("a correction goes into the same thread as a second group, under the first", async () => {
    await show("importer-complete");
    // D4 arrives with the next message half-typed, and the composer is enabled.
    expect(composer().value).toBe("The engagement window is Nov 3 to Nov 21");
    expect(headings()).toHaveLength(2);

    composer().focus();
    press("Enter");
    await settle();

    expect(headings()).toHaveLength(3);
    expect(headings()[2]).toContain("The engagement window is Nov 3 to Nov 21");
    // Every message is answered under its own heading, never under the previous one's.
    expect(
      document.querySelectorAll('[role="log"] > .group')[2]?.textContent,
    ).toContain("stand-in");
  });
});

describe("D3: streaming", () => {
  test("a write in flight is pending, the heading says the importer is working, and Stop is offered", async () => {
    await show("importer-streaming");

    expect(headings()).toHaveLength(1);
    expect(headings()[0]).toContain(
      "Load the scope from https://hackerone.com/acme/policy",
    );
    expect(headings()[0]).toContain("working");
    // Three entries landed; the fourth is asked for and not confirmed.
    expect(chips().filter((chip) => chip === "recorded")).toHaveLength(3);
    expect(chips().filter((chip) => chip === "pending")).toHaveLength(1);
    expect(hasButton("Stop")).toBe(true);
    expect(text()).toContain("The importer is working");
    // Mid-stream the composer is open for a correction, and the model cannot move.
    expect(composer().disabled).toBe(false);
    expect(text()).toContain("pinned while the session is running");
  });

  test("Stop leaves the unfinished write unresolved rather than letting it read as pending for ever", async () => {
    await show("importer-streaming");

    click(button("Stop"));
    await settle();

    expect(chips().filter((chip) => chip === "pending")).toHaveLength(0);
    expect(chips().filter((chip) => chip === "unresolved")).toHaveLength(1);
    expect(hasButton("Stop")).toBe(false);
    expect(headings()[0]).not.toContain("working");
    expect(text()).toContain(
      "this call produced neither a record nor a stated failure",
    );
  });

  test("a message sent and not yet answered says so, and the call list is the narration", async () => {
    await show("importer-awaiting");

    expect(text()).toContain("Sent. The importer has not answered yet.");
    expect(hasButton("Stop")).toBe(true);
    // Tool calls and the agent's prose are rows of the same list, through the same item.
    await show("importer-streaming");
    const kinds = [...document.querySelectorAll(".item .kind")].map((each) =>
      each.textContent?.trim(),
    );
    expect(kinds).toContain("Reply");
    expect(kinds).toContain("Tool call");
    expect(kinds).toContain("Scope entry");
  });
});

describe("D4: multi-turn", () => {
  test("two messages are two groups, and every write is a call collapsed into its record", async () => {
    await show("importer-complete");

    expect(headings()).toHaveLength(2);
    expect(headings()[0]).toContain("hackerone.com/acme/policy");
    expect(headings()[1]).toContain("shop.acme.com is WordPress too");
    // 7 scope entries and 3 assets, each shown once as its record with the call folded in:
    // 10 rows chipped `recorded`, and no bare "Tool call" row for any write.
    expect(chips().filter((chip) => chip === "recorded")).toHaveLength(10);
    const kinds = [...document.querySelectorAll(".item .kind")].map((each) =>
      each.textContent?.trim(),
    );
    expect(kinds.filter((kind) => kind === "Scope entry")).toHaveLength(7);
    expect(kinds.filter((kind) => kind === "Asset")).toHaveLength(3);
    // The one read, `read_scope`, is a call with no record to collapse into.
    expect(kinds.filter((kind) => kind === "Tool call")).toHaveLength(1);
    // And no row for a tool the importer does not have: it reads pages with its harness's
    // own reader (D13), so reading is prose and never a page-fetch call.
    expect(text()).not.toContain("fetch_page");
    expect(text()).not.toContain("write_scope_entry");
    expect(chips().filter((chip) => chip === "unresolved")).toHaveLength(0);
  });
});

describe("the list's height", () => {
  test("the importer's chat is the page, so it lifts Chat's 420px bound through the prop", async () => {
    await show("importer-complete");

    const style = document.querySelector('[role="log"]')?.getAttribute("style");
    expect(style).toContain("max-height");
    expect(style).toContain("100vh");
  });
});

describe("a session the harness no longer holds", () => {
  test("is a note and not an alert, and what it recorded is still there", async () => {
    await show("importer-forgotten");

    expect(text()).toContain("The harness no longer has this session");
    // The ordinary answer for an old session: no element announces it as a fault.
    expect(document.querySelector('[role="log"] [role="alert"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    // 3 entries and 5 assets survive as records, with no words and no calls.
    expect(document.querySelectorAll('[role="log"] .item')).toHaveLength(8);
    expect(text()).toContain("You are reading an earlier session");
    // Still writeable: the first message resumes it.
    expect(composer().disabled).toBe(false);
  });

  test("while it is being read, the chat says it is reading", async () => {
    await show("importer-opening");

    expect(text()).toContain("Reading what the harness still has of this");
    expect(
      document.querySelector('[role="status"]')?.textContent,
    ).toBeDefined();
  });

  test("when the harness still holds it, its words come back as its copy, labelled", async () => {
    await show("importer-reloaded");

    expect(headings().map((each) => each.slice(0, 22))).toEqual([
      "Earlier in this sessio",
      "You Load the scope fro",
      "You It does — shop.acm",
    ]);
    expect(text()).toContain(
      "This is its copy, not ours, and it may delete it.",
    );
    expect(text()).toContain("The table has five rows.");
    // The records are up in 'earlier', with the reason they are not under a message.
    expect(text()).toContain("Nothing on the record says which message");
  });
});

describe("D5: sessions are sticky per target", () => {
  test("the crumb lists earlier sessions with what each wrote, and marks the one on screen", async () => {
    await show("importer-picker");

    const dialog = document.querySelector(
      '[role="dialog"][aria-label="Importer sessions"]',
    );
    expect(dialog).not.toBeNull();
    const rows = [...(dialog?.querySelectorAll("button.option") ?? [])];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    const said = rows.map((row) => row.textContent?.replace(/\s+/g, " ") ?? "");
    expect(said[0]).toContain("4 in · 3 out · 3 assets · 4 messages");
    expect(said[1]).toContain("nothing written · 2 messages");
    expect(said[2]).toContain("3 in · 0 out · 5 assets · 9 messages");
    expect(said[1]).toContain("anthropic/claude-code");
    expect(text()).toContain("Start a new session");
  });

  test("opening an older session shows its transcript read-only until the first message, which resumes it", async () => {
    const app = await show("importer-picker");
    const rows = document.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button.option',
    );

    click(rows[1] as HTMLButtonElement);
    await settle();

    // The picker closed, the thread under it changed, and it says it is only being read.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(app.importer.currentId).toBe("ses_question");
    expect(text()).toContain("You are reading an earlier session");
    expect(text()).toContain("names no hosts");

    type(composer(), "The hosts are the ones in the SOW appendix");
    composer().focus();
    press("Enter");
    await settle();

    expect(text()).not.toContain("You are reading an earlier session");
    expect(headings()).toHaveLength(2);
    expect(headings()[1]).toContain("SOW appendix");
  });

  test("Start a new session is an empty thread on the same target, and does not stack empties", async () => {
    const app = await show("importer-picker");

    click(button("Start a new session"));
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(headings()).toEqual([]);
    expect(composer().value).toBe("");
    expect(button("New session")).toBeDefined();
    const before = app.importer.sessions.length;

    // Already looking at an empty one: asking again is the same choice, not a second thread.
    click(button("New session"));
    await settle();
    click(button("Start a new session"));
    await settle();
    expect(app.importer.sessions.length).toBe(before);
    // And the earlier sessions are all still there to go back to.
    expect(app.importer.listed).toHaveLength(3);
  });
});

describe("the state picker", () => {
  test("every A6 scenario mounts a chat with a composer", async () => {
    const ids = scenarios
      .filter((each) => each.group === "A6 Auto-load")
      .map((each) => each.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);

    for (const id of ids) {
      await show(id);
      expect(
        document.querySelector('section[aria-label^="Load the scope for"]'),
      ).not.toBeNull();
      expect(document.querySelector("#importer-message")).not.toBeNull();
      for (const each of mounted) each.destroy();
      mounted = [];
    }
  });
});
