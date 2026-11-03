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
import {
  click,
  focused,
  mountInto,
  press,
  pressEnterIn,
  settle,
  type Mounted,
} from "./dom";

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

/** Each group's own text, separator and all. */
const groupText = (index: number): string =>
  (
    document.querySelectorAll('[role="log"] > .group')[index]?.textContent ?? ""
  ).replace(/\s+/g, " ");

/**
 * Each group's footer, in order, as the element its footer sits inside and the footer's
 * words: `null` for a group with none.
 */
const footers = (): ({ in: Element | null; says: string } | null)[] =>
  [...document.querySelectorAll('[role="log"] > .group')].map((group) => {
    const foot = group.querySelector(".foot");
    if (foot === null) return null;
    return {
      in: foot.closest("li.prose, li.replayed"),
      says: foot.textContent?.replace(/\s+/g, " ").trim() ?? "",
    };
  });

/** What became of each write on screen, in order: the row's own `data-write`. */
const chips = (): string[] =>
  [...document.querySelectorAll(".block")]
    .map((each) => each.getAttribute("data-write") ?? "")
    .filter((state) => state !== "");

/** What each row of the thread is, in order: a reply, a write, a read, a bare record. */
const kinds = (): string[] =>
  [
    ...document.querySelectorAll('[role="log"] .prose, [role="log"] .block'),
  ].map((row) => {
    if (row.classList.contains("prose")) return "Reply";
    const what = row.querySelector(".what")?.textContent?.trim();
    if (what !== undefined && what !== "") return what;
    const sig = row.querySelector(".sig")?.textContent?.trim() ?? "";
    if (sig.startsWith("add_scope_entry(")) return "Scope entry";
    if (sig.startsWith("record_imported_asset(")) return "Asset";
    return "Tool call";
  });

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
  test("a write in flight is pending, the turn says the importer is working, and Stop is offered", async () => {
    await show("importer-streaming");

    expect(headings()).toHaveLength(1);
    expect(headings()[0]).toContain(
      "Load the scope from https://hackerone.com/acme/policy",
    );
    // Said in the turn, for a reader who cannot see the cursor — not in the separator, which
    // is the operator's bubble and nothing else since the header over the reply went (S3).
    expect(headings()[0]).not.toContain("working");
    expect(groupText(0)).toContain("The importer is working");
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
    expect(groupText(0)).not.toContain("The importer is working");
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
    expect(kinds()).toContain("Reply");
    expect(kinds()).toContain("Scope entry");
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
    expect(kinds().filter((kind) => kind === "Scope entry")).toHaveLength(7);
    expect(kinds().filter((kind) => kind === "Asset")).toHaveLength(3);
    // The one read, `read_scope`, is a call with no record to collapse into.
    expect(kinds().filter((kind) => kind === "Tool call")).toHaveLength(1);
    // And no row for a tool the importer does not have: it reads pages with its harness's
    // own reader (D13), so reading is prose and never a page-fetch call.
    expect(text()).not.toContain("fetch_page");
    expect(text()).not.toContain("write_scope_entry");
    expect(chips().filter((chip) => chip === "unresolved")).toHaveLength(0);
  });
});

describe("S3: nothing labels what the importer says", () => {
  test("no header over a reply: the separator is the operator's words, and nothing else", async () => {
    await show("importer-complete");

    const seps = [...document.querySelectorAll('[role="log"] > .group > .sep')];
    expect(seps).toHaveLength(2);
    for (const sep of seps) {
      const bubble = sep.querySelector(".bubble")?.textContent?.trim() ?? "";
      expect(bubble).not.toBe("");
      expect(sep.textContent?.trim()).toBe(bubble);
    }
  });

  test("a finished turn carries the model in a footer under its last reply", async () => {
    const app = await show("importer-complete");
    const model = app.importer.current?.model ?? "";
    expect(model).not.toBe("");

    const each = footers();
    expect(each).toHaveLength(2);
    for (const footer of each) {
      expect(footer?.says).toBe(`Model: ${model}`);
      expect(footer?.in?.classList.contains("prose")).toBe(true);
    }
  });

  test("a turn still in flight has the cursor and no footer yet", async () => {
    await show("importer-streaming");

    expect(footers()).toEqual([null]);
    // The pending write draws the cursor here, as `writing…`.
    expect(chips()).toContain("pending");
  });

  test("a replayed reply is unlabelled, and its footer is under the harness's copy", async () => {
    const app = await show("importer-reloaded");

    const labels = [
      ...document.querySelectorAll('[role="log"] .replay-type'),
    ].map((each) => each.textContent);
    expect(labels).not.toContain("assistant");
    const replayedFooters = footers().filter((each) => each !== null);
    expect(replayedFooters.length).toBeGreaterThan(0);
    for (const footer of replayedFooters) {
      expect(footer.in?.classList.contains("replayed")).toBe(true);
      expect(footer.says).toBe(`Model: ${app.importer.current?.model ?? ""}`);
    }
  });
});

describe("the page layout", () => {
  test("is a thread, not a panel: no caption, no frame, the footnote under the composer", async () => {
    await show("importer-complete");

    const chat = document.querySelector(
      'section[aria-label^="Load the scope"]',
    );
    expect(chat?.classList.contains("thread")).toBe(true);
    // The panel's caption strip is the planner's and the goal agent's.
    expect(chat?.querySelector(".head")).toBeNull();
    const composerRow = chat?.querySelector(".composer");
    const footnote = chat?.querySelector(".footnote");
    expect(composerRow).not.toBeNull();
    expect(
      composerRow!.compareDocumentPosition(footnote!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("an empty session leads with the heading and the composer, and the log is out of the way", async () => {
    await show("importer-first");

    const chat = document.querySelector(
      'section[aria-label^="Load the scope"]',
    );
    expect(chat?.classList.contains("idle")).toBe(true);
    expect(chat?.querySelector("h2")?.textContent).toBe(
      "Load the scope for acme-corp",
    );
  });
});

describe("D6: the model chip is the picker the operator already has", () => {
  const chip = (): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
    );
    if (found === null) throw new Error("no model chip");
    return found;
  };

  test("opens HarnessChoice in a modal, and choosing a model changes the chip", async () => {
    const app = await show("importer-first");
    expect(chip().textContent).toContain("openai/gpt-5.6-sol");

    click(chip());
    await settle();

    // The real component's columns: harness rail, a model filter, the model list.
    const dialog = document.querySelector(
      '[role="dialog"][aria-label="Choose a harness and model"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("OpenCode");
    expect(dialog?.textContent).toContain("Claude Code");
    expect(
      dialog?.querySelector('input[placeholder="Filter models"]'),
    ).not.toBeNull();
    // The importer's own sentence about pinning, in sessions' words.
    expect(dialog?.textContent).toContain(
      "A session is pinned to the harness it starts on",
    );

    const other = [
      ...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find((each) => each.textContent?.trim() === "openai/gpt-5.5");
    if (other === undefined) throw new Error("no gpt-5.5 row");
    click(other);
    await settle();

    expect(app.pickedImportModel).toBe("openai/gpt-5.5");
    // Still open, as the composer's is: the Reasoning column is about the model just
    // picked, so closing on the pick would mean reopening to use it.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(chip().textContent).toContain("openai/gpt-5.5");
    // Nothing was sent by choosing.
    expect(app.importer.current?.tally.messages).toBe(0);
  });

  test("the Reasoning column is the composer's, and what is picked in it is kept", async () => {
    const app = await show("importer-first");
    click(chip());
    await settle();

    const dialog = document.querySelector('[role="dialog"]');
    // D6's third column: the descriptor's label and its harness id, every choice, the
    // default marked, and the sentence about what is sent.
    expect(dialog?.textContent).toContain("Reasoning");
    expect(dialog?.textContent).toContain("variant");
    const rows = [
      ...(dialog?.querySelectorAll<HTMLButtonElement>(".option-row") ?? []),
    ];
    expect(
      rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual([
      "Default default",
      "None",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Maximum",
    ]);
    // Nothing set, so the model's own default is the one shown as current.
    expect(rows[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(dialog?.textContent).toContain("Only what you set here is sent.");

    const high = rows.find((row) => row.textContent?.trim() === "High");
    if (high === undefined) throw new Error("no High row");
    click(high);
    await settle();

    expect(app.pickedImportModelOptions).toEqual([
      { id: "variant", value: "high" },
    ]);
    expect(high.getAttribute("aria-pressed")).toBe("true");
    // A run's options are a different store: the importer's pick does not touch them.
    expect(app.pickedModelOptions).toEqual([]);
  });

  test("once a session has started its model is shown and not editable", async () => {
    await show("importer-complete");

    expect(
      document.querySelector('button[aria-label^="Harness and model"]'),
    ).toBeNull();
    // A span, not a disabled button: "not ever" rather than "not yet".
    const held = document.querySelector(".chip.held");
    expect(held?.tagName).toBe("SPAN");
    expect(held?.textContent).toContain("openai/gpt-5.6-sol");
  });
});

describe("S5: the model picker is a modal", () => {
  const chip = (): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
    );
    if (found === null) throw new Error("no model chip");
    return found;
  };
  const dialog = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Choose a harness and model"]',
    );

  /** Opened the way a hand opens it: focus on the chip, then the click. */
  const open = async (): Promise<HTMLElement> => {
    await show("importer-first");
    chip().focus();
    click(chip());
    await settle();
    const found = dialog();
    if (found === null) throw new Error("the picker did not open");
    return found;
  };

  test("says it is modal, and starts with focus in the filter", async () => {
    const panel = await open();

    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(
      document.activeElement ===
        panel.querySelector('input[aria-label="Filter models"]'),
      `focus is on ${focused()}`,
    ).toBe(true);
  });

  test("Escape closes it and puts focus back on the chip", async () => {
    await open();

    press("Escape");
    await settle();

    expect(dialog()).toBeNull();
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip());
  });

  test("a click outside the panel closes it and puts focus back on the chip", async () => {
    const panel = await open();

    // Inside the panel is not outside: a rail row is picked and the dialog stays.
    const row = panel.querySelector<HTMLButtonElement>(".rail-row");
    if (row === null) throw new Error("no rail row");
    click(row);
    await settle();
    expect(dialog()).not.toBeNull();

    // happy-dom does no hit-testing, so "outside" is the scrim's own control, which is
    // what a click anywhere off the panel lands on in a browser.
    const scrim = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close the harness picker"]',
    );
    if (scrim === null) throw new Error("no scrim");
    expect(panel.contains(scrim)).toBe(false);
    click(scrim);
    await settle();

    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  test("focus returns to the chip even when the click that opened it did not focus it", async () => {
    // Safari's case: a button clicked is not focused, so the dialog opens over `<body>`.
    await show("importer-first");
    (document.activeElement as HTMLElement | null)?.blur();
    click(chip());
    await settle();
    expect(dialog()).not.toBeNull();

    press("Escape");
    await settle();

    expect(document.activeElement).toBe(chip());
  });

  test("Tab and Shift+Tab wrap inside the panel and never reach the page behind it", async () => {
    const panel = await open();
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined || first === last) {
      throw new Error("the panel has too few controls to wrap");
    }

    last.focus();
    press("Tab");
    expect(document.activeElement).toBe(first);

    press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Still open, and the chip — the page behind it — never had focus.
    expect(dialog()).not.toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

describe("S5: the picker is not part of the composer it opens from", () => {
  const chip = (): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
    );
    if (found === null) throw new Error("no model chip");
    return found;
  };
  const dialog = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Choose a harness and model"]',
    );
  const filter = (): HTMLInputElement => {
    const found = dialog()?.querySelector<HTMLInputElement>(
      'input[aria-label="Filter models"]',
    );
    if (found === undefined || found === null) throw new Error("no filter");
    return found;
  };

  test("Enter in the filter does not send the draft in the composer behind it", async () => {
    const app = await show("importer-first");
    type(composer(), "Read https://bugcrowd.com/acme and load it");
    click(chip());
    await settle();

    const field = filter();
    field.value = "gpt";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    pressEnterIn(field);
    await settle();

    // The modal is not in the composer's form, so its fields have no form owner at all.
    expect(field.form).toBeNull();
    expect(dialog()?.closest("form")).toBeNull();
    // Nothing sent and no turn started: the draft is still the operator's, in the box.
    expect(app.importer.current?.tally.messages).toBe(0);
    expect(headings()).toEqual([]);
    expect(composer().value).toBe("Read https://bugcrowd.com/acme and load it");
    // And the picker the operator was typing in is still open.
    expect(dialog()).not.toBeNull();
  });

  test("a picker left open when its branch goes does not reopen when the branch comes back", async () => {
    const app = await show("importer-first");
    click(chip());
    await settle();
    expect(dialog()).not.toBeNull();

    // A session gaining messages under an open picker: the chip's branch goes, dialog and
    // all, without anything closing the dialog first. (Enter in the filter was how; it no
    // longer is, so the send is made directly.)
    app.importer.draft = "Read https://bugcrowd.com/acme and load it";
    app.importer.send();
    await settle();
    expect(headings()).toHaveLength(1);
    expect(document.querySelector(".chip.held")).not.toBeNull();
    expect(dialog()).toBeNull();
    expect(app.importPickerOpen).toBe(false);

    // The next new session renders the chip again, and the picker stays shut until asked.
    app.importer.start();
    await settle();
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
  });

  test("a picker left open when the importer is left does not reopen on return", async () => {
    const app = await show("importer-first");
    click(chip());
    await settle();
    expect(dialog()).not.toBeNull();

    // The whole page goes, as it does when the operator navigates away, and comes back.
    for (const each of mounted) each.destroy();
    mounted = [];
    expect(dialog()).toBeNull();
    mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
    await settle();

    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
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
    expect(document.querySelectorAll('[role="log"] .block')).toHaveLength(8);
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
      "earlier in this sessio",
      "Load the scope from ht",
      "It does — shop.acme.co",
    ]);
    expect(text()).toContain(
      "This is its copy, not ours, and it may delete it.",
    );
    expect(text()).toContain("The table has five rows:");
    // S4: the harness's copy is markdown too, so its table is a table and not pipes.
    expect(
      document.querySelectorAll("li.replayed .table-wrap > table"),
    ).toHaveLength(1);
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
    expect(said[0]).toContain("4 in · 3 out · 3 assets");
    expect(said[1]).toContain("nothing written");
    expect(said[2]).toContain("3 in · 0 out · 5 assets");
    // The state picker is the reference for what a state looks like, so it must not print
    // what a real session cannot: this server keeps no prose and so has no message count.
    expect(said.join(" ")).not.toContain("message");
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
