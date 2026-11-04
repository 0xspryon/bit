/**
 * The agent chip on the importer's composer (A6 D7), as the operator meets it: before the
 * first message a button that opens the registry's list, after it a pinned label naming
 * the session's agent, and for a session recorded under an agent the server no longer
 * defines, the raw id marked unknown.
 *
 * The chip reads the registry (`GET /agents`) and the session, so the server-backed tests
 * drive it through a fake server that answers as the real one does; the state picker's
 * scenarios use the mock registry, which is the server's one entry.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { AgentsView, ImporterSessionView } from "@bit/contracts";

import { App, scenarios } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerSessionView,
  importerTurnAccepted,
  ok,
  unreachable,
} from "../fakeServer";
import { click, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const WRITES =
  "Scope entries and the hosts they name, from the program pages you give it";

const said = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const composer = (): HTMLTextAreaElement => {
  const box = document.querySelector<HTMLTextAreaElement>("#importer-message");
  if (box === null) throw new Error("no composer");
  return box;
};

const typeInto = (box: HTMLTextAreaElement, value: string): void => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** The chip's button, before the first message; `null` once it is pinned. */
const chipButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>("button.agent-chip");

/** The pinned chip, after the first message; `null` while it is a button. */
const chipLabel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("span.agent-chip");

const listbox = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="listbox"][aria-label="Agent"]');

const options = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>(
    '[role="listbox"][aria-label="Agent"] [role="option"]',
  ),
];

/** The page in the state a scenario puts it in, with the mock registry. */
const show = async (id: string): Promise<App> => {
  const app = new App(new FakeServer(), new FakeCountdown());
  const scenario = scenarios.find((each) => each.id === id);
  if (scenario === undefined) throw new Error(`no scenario "${id}"`);
  scenario.apply(app);
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return app;
};

const harness = {
  instanceId: "opencode",
  driver: "opencode" as const,
  displayName: "OpenCode",
  version: "1.0.0",
  ready: true,
  auth: "authenticated" as const,
  isDefault: true,
  defaultModel: "m",
  models: [{ id: "m" }],
};

/**
 * A real target's importer page against a fake server listing `sessions`, opened on
 * `sessionId` or on the empty session to type into.
 */
const openOn = async (
  sessions: ImporterSessionView[],
  sessionId?: string,
  agents?: AgentsView,
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  if (agents !== undefined) fake.onAgents = () => ok(agents);
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions });
  fake.onHarnesses = () => ok([harness]);
  fake.onOpenImporterConversation = (_baseUrl, targetId) =>
    ok(
      importerTurnAccepted({
        targetId,
        importId: "imp_opened",
        harnessSessionId: "ses_opened",
        conversation: "opened",
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.openImporter(sessionId);
  await settle();
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return { app, fake };
};

/** A registry of three, so a list has rows to move between. */
const THREE: AgentsView = {
  agents: [
    { id: "importer", label: "Importer", writes: WRITES },
    {
      id: "scout",
      label: "Scout",
      writes: "Assets it finds on the hosts in scope",
    },
    { id: "triage", label: "Triage", writes: "Notes on findings" },
  ],
  defaultAgentId: "scout",
};

describe("D7: before the first message", () => {
  test("the chip is the registry's default agent, with a chevron, and opens nothing until clicked", async () => {
    await show("importer-first");

    const chip = chipButton();
    expect(chip).not.toBeNull();
    expect(said(chip)).toBe("Importer");
    expect(chip?.getAttribute("aria-label")).toBe("Agent: Importer");
    expect(chip?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(chip?.getAttribute("aria-expanded")).toBe("false");
    expect(chip?.querySelector(".caret")).not.toBeNull();
    expect(listbox()).toBeNull();
  });

  test("its list names each agent, its tag and what it can write, under D7's heading and the pinning note", async () => {
    await show("importer-first");
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");

    click(chip);
    await settle();

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const rows = options();
    expect(rows.map((row) => said(row))).toEqual([
      `Importer only agent Can write: ${WRITES}`,
    ]);
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
      "true",
    ]);
    const pop = listbox()?.parentElement;
    expect(said(pop?.querySelector(".head"))).toBe("Agent");
    // Adapted to the decision: the agent is pinned per conversation, so no promise of
    // switching it per message.
    expect(said(pop?.querySelector(".note"))).toBe(
      "The agent is fixed once a conversation starts. Importer is the only agent for now.",
    );
    // The focus goes to the agent in use, as a listbox's does.
    expect(document.activeElement).toBe(rows[0] ?? null);
  });

  test("Escape closes the list and gives the focus back to the chip; arrows stay in it", async () => {
    await show("importer-first");
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();

    press("ArrowDown");
    await settle();
    expect(document.activeElement).toBe(options()[0] ?? null);

    press("Escape");
    await settle();
    expect(listbox()).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
  });

  test("a click outside the list closes it", async () => {
    await show("importer-first");
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();

    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    await settle();
    expect(listbox()).toBeNull();
  });

  test("picking an agent sets the draft's agent, closes the list and returns the focus", async () => {
    const app = await show("importer-first");
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();

    const row = options()[0];
    if (row === undefined) throw new Error("no option");
    click(row);
    await settle();

    expect(app.importer.current?.agentId).toBe("importer");
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

describe("D7's list from the keyboard", () => {
  test("the list is one tab stop: the agent in use holds it, and the trigger controls the list while it is open", async () => {
    await openOn([], undefined, THREE);
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    expect(chip.hasAttribute("aria-controls")).toBe(false);

    click(chip);
    await settle();

    const id = listbox()?.id ?? "";
    expect(id).not.toBe("");
    expect(chip.getAttribute("aria-controls")).toBe(id);
    // The registry's default is the agent in use before a pick.
    expect(options().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(options()[1] ?? null);
  });

  test("arrows, Home and End move the focus and the one tab stop with it", async () => {
    await openOn([], undefined, THREE);
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();

    press("End");
    await settle();
    expect(document.activeElement).toBe(options()[2] ?? null);
    expect(options().map((row) => row.tabIndex)).toEqual([-1, -1, 0]);

    press("Home");
    await settle();
    expect(document.activeElement).toBe(options()[0] ?? null);
    expect(options().map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    press("ArrowDown");
    await settle();
    expect(document.activeElement).toBe(options()[1] ?? null);
    expect(options().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
  });

  test("Tab is left to the browser, which takes it out of the list, and the list closes behind it", async () => {
    await openOn([], undefined, THREE);
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();

    const tab = press("Tab");
    expect(tab.defaultPrevented).toBe(false);
    // happy-dom does not move focus on Tab: take the browser's step, to the next stop.
    const next = document.querySelector<HTMLElement>("button.chip");
    if (next === null) throw new Error("no model chip");
    next.focus();
    await settle();
    expect(listbox()).toBeNull();
  });
});

describe("D7: after the first message", () => {
  test("the chip is locked: no chevron, not a button, and it says the agent is fixed", async () => {
    await show("importer-first");
    typeInto(composer(), "Read https://hackerone.com/acme");
    composer().focus();
    press("Enter");
    await settle();

    expect(chipButton()).toBeNull();
    const chip = chipLabel();
    expect(chip).not.toBeNull();
    expect(chip?.querySelector(".caret")).toBeNull();
    // Its accessible text: the agent, then that it is fixed, with no stray space between.
    expect(said(chip)).toBe("Importer, fixed for this conversation");
    expect(said(chip?.querySelector(".visually-hidden"))).toBe(
      ", fixed for this conversation",
    );
    expect(chip?.getAttribute("title")).toBe(
      "The agent is fixed for this conversation.",
    );
  });

  test("an earlier session's chip is its own recorded agent, locked", async () => {
    await openOn([importerSessionView({ sessionId: "ses_old" })], "ses_old");

    expect(chipButton()).toBeNull();
    expect(said(chipLabel()?.querySelector(".name"))).toBe("Importer");
  });

  test("a session recorded under an agent this build does not define shows the raw id, marked unknown", async () => {
    await openOn(
      [
        importerSessionView({
          sessionId: "ses_retired",
          agentId: "retired_agent",
        }),
      ],
      "ses_retired",
    );

    expect(chipButton()).toBeNull();
    const chip = chipLabel();
    expect(chip?.classList.contains("unknown")).toBe(true);
    expect(said(chip?.querySelector(".name"))).toBe("retired_agent");
    expect(said(chip?.querySelector(".tag"))).toBe("unknown");
    expect(said(chip?.querySelector(".visually-hidden"))).toBe(
      ", an agent this server does not define",
    );
    expect(chip?.getAttribute("title")).toBe(
      "This server defines no agent 'retired_agent', so this conversation cannot be continued.",
    );
  });
});

describe("D7 against the server", () => {
  test("the registry is read once per page load, however often the page is opened", async () => {
    const { app, fake } = await openOn([]);
    app.toSection("assets");
    await settle();
    app.openImporter();
    await settle();

    expect(fake.countOf("agents")).toBe(1);
    expect(said(chipButton())).toBe("Importer");
  });

  test("the first message carries the agent picked on the chip, and the session is pinned to it", async () => {
    const { app, fake } = await openOn([]);
    const chip = chipButton();
    if (chip === null) throw new Error("no chip");
    click(chip);
    await settle();
    const row = options()[0];
    if (row === undefined) throw new Error("no option");
    click(row);
    await settle();

    typeInto(composer(), "Read https://hackerone.com/acme");
    composer().focus();
    press("Enter");
    await settle();

    const draft = fake.calls.find(
      (call) => call.method === "openImporterConversation",
    )?.args[2];
    expect(draft).toEqual({
      text: "Read https://hackerone.com/acme",
      agentId: "importer",
    });
    expect(app.importer.current?.agentId).toBe("importer");
    expect(chipButton()).toBeNull();
  });

  test("while the first message is with the server the chip is pinned, and a pick changes nothing", async () => {
    const { app, fake } = await openOn([], undefined, THREE);
    const release = fake.hold("openImporterConversation");
    typeInto(composer(), "Read https://hackerone.com/acme");
    composer().focus();
    press("Enter");
    await settle();

    expect(app.importer.sending).toBe(true);
    expect(chipButton()).toBeNull();
    expect(chipLabel()).not.toBeNull();
    // A pick that reached the store anyway — a list left open, a stale handler — is refused:
    // the message in flight was sent as the default agent, and the session must say so.
    app.importer.pickAgent("triage");
    await settle();
    expect(app.importer.current?.agentId).toBeUndefined();

    release();
    await settle();
    expect(app.importer.current?.agentId).toBe("scout");
  });

  test("signing out forgets the server's registry, so the next server's page names none it has not read", async () => {
    const { app, fake } = await openOn([], undefined, THREE);
    expect(app.importer.agents?.defaultAgentId).toBe("scout");

    app.signOut();
    expect(app.importer.agents).toBeUndefined();

    // The next sign-in's registry does not answer: nothing of the last one may stand in.
    fake.onAgents = () => unreachable("connection refused");
    app.password = "correct-horse";
    await app.connect();
    app.openTarget("acme-corp");
    await settle();
    app.toSection("assets");
    await settle();
    app.openImporter();
    await settle();

    expect(app.importer.agents).toBeUndefined();
    expect(chipButton()).toBeNull();
    expect(chipLabel()?.getAttribute("title")).toBe(
      "The server's agents have not been read.",
    );
  });

  test("a first message with no pick carries no agent, and the server's default is shown pinned", async () => {
    const { app, fake } = await openOn([]);
    typeInto(composer(), "Read https://hackerone.com/acme");
    composer().focus();
    press("Enter");
    await settle();

    const draft = fake.calls.find(
      (call) => call.method === "openImporterConversation",
    )?.args[2];
    expect(draft).toEqual({ text: "Read https://hackerone.com/acme" });
    expect(app.importer.current?.agentId).toBe("importer");
    expect(said(chipLabel()?.querySelector(".name"))).toBe("Importer");
  });
});
