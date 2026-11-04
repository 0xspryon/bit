/**
 * D6 and U3: the harness and model modal over a session that has started, and switching
 * that session's model while it runs (A6 F4).
 *
 * The harness is pinned to a conversation by its first message and its model is not: the
 * modal says so in its footer, stages a pick until "Use for this session", asks the server
 * to switch, and shows what the server answered — when the switch applies, and which
 * settings the new model does not offer. A refusal is the F2 error dialog, over the modal.
 * Another harness is a new session, said before it is opened. A message sent while a
 * switch is out waits for it on the server, and the composer says so.
 *
 * Driven against a fake server that answers as the real one does.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  ConversationModelRefused,
  type ImporterSessionView,
} from "@bit/contracts";

import { App, scenarios } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import { mockHarnesses } from "../../src/lib/mockImporter";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerModelView,
  importerSessionView,
  importerTurnAccepted,
  ok,
  refused,
} from "../fakeServer";
import { click, mountInto, press, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const SOL = "openai/gpt-5.6-sol";
const FIVE = "openai/gpt-5.5";
const FOOTER =
  "This session stays on OpenCode — picking another harness opens a new one. Models and reasoning inside it can change at any time, including mid-run.";

const said = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const page = (): string => said(document.body);

const composer = (): HTMLTextAreaElement => {
  const box = document.querySelector<HTMLTextAreaElement>("#importer-message");
  if (box === null) throw new Error("no composer");
  return box;
};

const typeInto = (box: HTMLTextAreaElement, value: string): void => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** A started session's model chip. */
const sessionChip = (): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Model: "]',
  );
  if (found === null) throw new Error("no session model chip");
  return found;
};

const picker = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Choose a harness and model"]',
  );

const alert = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]');

/** A button in the picker, by its text. */
const inPicker = (label: string): HTMLButtonElement => {
  const found = [
    ...(picker()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ].find((each) => said(each).startsWith(label));
  if (found === undefined) throw new Error(`no "${label}" in the picker`);
  return found;
};

/** A harness in the picker's rail, by its name. */
const railRow = (name: string): HTMLButtonElement => {
  const found = [
    ...(picker()?.querySelectorAll<HTMLButtonElement>(".rail-row") ?? []),
  ].find((each) => said(each.querySelector(".rail-name")).startsWith(name));
  if (found === undefined) throw new Error(`no harness "${name}" in the rail`);
  return found;
};

/** The dialogs' names in `<body>` order: the last is drawn on top. */
const layers = (): (string | null)[] =>
  [...document.body.children]
    .filter((each) => each.classList.contains("layer"))
    .map(
      (each) =>
        each.querySelector('[aria-modal="true"]')?.getAttribute("aria-label") ??
        each.querySelector("[aria-modal='true'] h2")?.textContent ??
        null,
    );

/**
 * A real target's importer page against a fake server listing `sessions`, opened on
 * `sessionId` (the listed one by default), with A6's two harnesses.
 */
const openOn = async (
  sessions: ImporterSessionView[] = [
    importerSessionView({ sessionId: "ses_old", model: SOL }),
  ],
  sessionId: string | undefined = "ses_old",
): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions });
  fake.onHarnesses = () => ok(mockHarnesses());
  fake.onImporterModel = () => ok(importerModelView({ model: SOL }));
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

const openPicker = async (): Promise<HTMLElement> => {
  const chip = sessionChip();
  chip.focus();
  click(chip);
  await settle();
  const found = picker();
  if (found === null) throw new Error("the picker did not open");
  return found;
};

describe("D6: the modal's footer", () => {
  test("over a started session it says the harness stays and the model does not, with D6's two actions", async () => {
    await openOn();
    const panel = await openPicker();

    expect(said(panel.querySelector(".foot-note"))).toBe(FOOTER);
    const actions = [...panel.querySelectorAll(".foot-button")].map(said);
    expect(actions).toEqual(["Cancel", "Use for this session"]);
    // The session's own harness and model are what it opens on.
    expect(said(panel.querySelector(".rail-row.selected"))).toContain(
      "OpenCode",
    );
    expect(said(panel.querySelector(".model-row.selected"))).toBe(
      `${SOL} default`,
    );
  });

  test("over a new session the modal is as it was: picks apply at once, no footer", async () => {
    await openOn([], undefined);
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Harness and model"]',
    );
    if (chip === null) throw new Error("no new-session chip");
    click(chip);
    await settle();

    expect(picker()?.querySelector(".foot-note")).toBeNull();
    expect(picker()?.querySelector(".foot-button")).toBeNull();
    expect(said(picker())).toContain(
      "A session is pinned to the harness it starts on",
    );
  });

  test("Cancel closes it and changes nothing", async () => {
    const { app, fake } = await openOn();
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Cancel"));
    await settle();

    expect(picker()).toBeNull();
    expect(fake.countOf("switchImporterModel")).toBe(0);
    expect(app.importer.current?.model).toBe(SOL);
    expect(document.activeElement).toBe(sessionChip());
  });
});

describe("U3: switching a started session's model", () => {
  test("a pick is staged, and 'Use for this session' switches the model, model and reasoning in one call", async () => {
    const { app, fake } = await openOn();
    await openPicker();

    click(inPicker(FIVE));
    await settle();
    // Staged, not sent: the chip behind still says the session's model.
    expect(fake.countOf("switchImporterModel")).toBe(0);
    expect(said(sessionChip())).toBe(`o ${SOL}`);

    // The chip follows the switch's answer, not a later reading of the list.
    const releaseList = fake.hold("importerSessions");
    click(inPicker("Use for this session"));
    await settle();

    const call = fake.calls.find(
      (each) => each.method === "switchImporterModel",
    );
    expect(call?.args.slice(1)).toEqual([
      "acme-corp",
      "imp_1",
      { model: FIVE },
    ]);
    expect(picker()).toBeNull();
    expect(app.importer.current?.model).toBe(FIVE);
    expect(said(sessionChip())).toBe(`o ${FIVE}`);
    // Between turns: the next message runs on it.
    expect(page()).toContain(`Now on ${FIVE}. Your next message runs on it.`);
    releaseList();
    await settle();
  });

  test("a reasoning level goes with the switch it was set for", async () => {
    const { fake } = await openOn();
    await openPicker();
    click(inPicker("High"));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    const call = fake.calls.find(
      (each) => each.method === "switchImporterModel",
    );
    expect(call?.args[3]).toEqual({
      model: SOL,
      modelOptions: [{ id: "variant", value: "high" }],
    });
    expect(page()).toContain(`Now on ${SOL} (variant: high).`);
  });

  test("mid-turn the confirmation says it applies from the next model call, and the step running finishes on the old model", async () => {
    await openOn([
      importerSessionView({ sessionId: "ses_old", model: SOL, running: true }),
    ]);
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    expect(page()).toContain(
      `Now on ${FIVE}. The importer takes it from its next model call: the step it is on now finishes on ${SOL}.`,
    );
  });

  test("a session this server does not hold has its record switched, and the next message reopens it on the model", async () => {
    const { fake } = await openOn();
    fake.onSwitchImporterModel = (_url, _target, importId, draft) =>
      ok({
        conversationId: importId,
        harnessInstanceId: "opencode",
        model: draft.model,
        modelOptions: [],
        droppedModelOptionIds: [],
        applied: "recorded",
        changed: true,
      });
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    expect(page()).toContain(
      `Now on ${FIVE}. This session is not running on this server, so the change is recorded and your next message reopens it on ${FIVE}.`,
    );
  });

  test("settings the new model does not offer are named", async () => {
    const { fake } = await openOn();
    fake.onSwitchImporterModel = (_url, _target, importId, draft) =>
      ok({
        conversationId: importId,
        harnessInstanceId: "opencode",
        model: draft.model,
        modelOptions: [],
        droppedModelOptionIds: ["variant"],
        applied: "live",
        changed: true,
      });
    await openPicker();
    click(inPicker("High"));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    expect(page()).toContain(
      `${SOL} does not offer variant, so that setting was not sent.`,
    );
  });

  test("while the switch is out the modal and the caption say so, and a second one is not offered", async () => {
    const { app, fake } = await openOn();
    const release = fake.hold("switchImporterModel");
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    // The modal stays up while the call is out, its confirm saying so.
    const confirm = inPicker("Switching…");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    click(confirm);
    await settle();
    expect(fake.countOf("switchImporterModel")).toBe(1);
    expect(page()).toContain(`Switching to ${FIVE}…`);
    expect(sessionChip().classList.contains("switching")).toBe(true);
    // The chip is the session's model until the server says otherwise.
    expect(app.importer.current?.model).toBe(SOL);

    release();
    await settle();
    expect(picker()).toBeNull();
    expect(page()).not.toContain("Switching to");
    expect(app.importer.current?.model).toBe(FIVE);
  });

  test("a reading of the index that left before the switch answered does not put the old model back", async () => {
    const { app, fake } = await openOn();
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    // The list still names the old model, as a read that left before the switch would.
    await app.loadImporterSessions("acme-corp");
    await settle();
    expect(app.importer.current?.model).toBe(FIVE);

    // Once the server's row agrees, the row is the model again, whoever changes it next.
    fake.onImporterSessions = () =>
      ok({
        sessions: [importerSessionView({ sessionId: "ses_old", model: FIVE })],
      });
    await app.loadImporterSessions("acme-corp");
    await settle();
    fake.onImporterSessions = () =>
      ok({
        sessions: [
          importerSessionView({
            sessionId: "ses_old",
            model: "openai/gpt-5.6-terra",
          }),
        ],
      });
    await app.loadImporterSessions("acme-corp");
    await settle();
    expect(app.importer.current?.model).toBe("openai/gpt-5.6-terra");
  });
});

describe("U3: a refused switch", () => {
  const refuse = (
    fake: FakeServer,
    reason: ConversationModelRefused["reason"],
    detail: string,
  ) => {
    fake.onSwitchImporterModel = () =>
      refused(new ConversationModelRefused({ reason, detail }));
  };

  test("opens the error dialog over the modal with the server's sentence, and leaves the model as it was", async () => {
    const { app, fake } = await openOn();
    refuse(
      fake,
      "switch_in_flight",
      "another model switch of import imp_1 has not answered yet. Switches are not queued: wait for it to finish, then pick again.",
    );
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();

    const shown = alert();
    expect(shown).not.toBeNull();
    expect(said(shown)).toContain("Model not switched");
    expect(said(shown?.querySelector(".sentence"))).toBe(
      "Another model switch of import imp_1 has not answered yet. Switches are not queued: wait for it to finish, then pick again.",
    );
    // Stacked: the picker is still up, under the error, which has the keyboard.
    expect(picker()).not.toBeNull();
    expect(layers()).toEqual([
      "Choose a harness and model",
      "Model not switched",
    ]);
    expect(shown?.contains(document.activeElement)).toBe(true);
    expect(app.importer.current?.model).toBe(SOL);
    expect(page()).not.toContain("Now on");

    // One Escape closes the error only; focus is back on the picker's confirm.
    press("Escape");
    await settle();
    expect(alert()).toBeNull();
    expect(picker()).not.toBeNull();
    expect(document.activeElement).toBe(inPicker("Use for this session"));
  });

  test("the list is read again, so a switch that won the race is the model the chip shows", async () => {
    const { app, fake } = await openOn();
    refuse(
      fake,
      "switch_in_flight",
      "another model switch of import imp_1 has not answered yet.",
    );
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    // The switch that was in flight, from another tab, has landed on the server's row.
    fake.onImporterSessions = () =>
      ok({
        sessions: [
          importerSessionView({
            sessionId: "ses_old",
            model: "openai/gpt-5.6-terra",
          }),
        ],
      });
    click(inPicker("Use for this session"));
    await settle();
    await settle();

    expect(alert()).not.toBeNull();
    expect(app.importer.current?.model).toBe("openai/gpt-5.6-terra");
  });

  test("each refusal reason is the server's sentence in the dialog", async () => {
    const { fake } = await openOn();
    const reasons = [
      ["harness_unreachable", "the harness did not clearly answer."],
      [
        "model_unavailable",
        "'openai/gpt-5.5' is not a model harness instance 'opencode' offers.",
      ],
      ["store_unavailable", "import imp_1's record could not be written."],
    ] as const;
    await openPicker();
    for (const [reason, detail] of reasons) {
      refuse(fake, reason, detail);
      click(inPicker("Use for this session"));
      await settle();
      expect(said(alert()?.querySelector(".sentence"))).toBe(
        `${detail[0]?.toUpperCase() ?? ""}${detail.slice(1)}`,
      );
      press("Escape");
      await settle();
      expect(alert()).toBeNull();
    }
  });
});

describe("U3: another harness is a new session", () => {
  test("the footer says so before it is confirmed, and confirming opens a new session on it, draft and all", async () => {
    const { app, fake } = await openOn();
    typeInto(composer(), "Now the wildcard rows");
    await openPicker();

    click(railRow("Claude Code"));
    await settle();
    const panel = picker();
    expect(said(panel?.querySelector(".foot-note"))).toBe(
      "This session stays on OpenCode. Claude Code is another harness, so this opens a new session on it and leaves this one as it is.",
    );
    expect(said(panel?.querySelector(".model-row.selected"))).toBe(
      "claude-sonnet-5 default",
    );
    click(inPicker("claude-opus-5"));
    await settle();

    click(inPicker("Open a new session"));
    await settle();

    expect(fake.countOf("switchImporterModel")).toBe(0);
    expect(picker()).toBeNull();
    // A new, empty session on that harness and model, with the operator's words kept.
    expect(app.importer.current?.tally.messages).toBe(0);
    expect(app.importer.current?.id).not.toBe("ses_old");
    expect(composer().value).toBe("Now the wildcard rows");
    expect(app.pickedImportInstanceId).toBe("claude-code");
    expect(app.pickedImportModel).toBe("claude-opus-5");
    const chip = document.querySelector(
      'button[aria-label^="Harness and model"]',
    );
    expect(said(chip)).toBe("c claude-opus-5");
    // The session it came from is untouched, still listed.
    expect(
      app.importer.sessions.find((each) => each.id === "ses_old")?.model,
    ).toBe(SOL);
  });

  test("the new session's first message opens on the harness, model and reasoning picked", async () => {
    const { fake } = await openOn([], undefined);
    fake.onOpenImporterConversation = (_baseUrl, targetId) =>
      ok(importerTurnAccepted({ targetId, conversation: "opened" }));
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Harness and model"]',
    );
    if (chip === null) throw new Error("no new-session chip");
    click(chip);
    await settle();
    click(inPicker("High"));
    await settle();
    press("Escape");
    await settle();

    typeInto(composer(), "Read https://hackerone.com/acme");
    composer().focus();
    press("Enter");
    await settle();

    const draft = fake.calls.find(
      (each) => each.method === "openImporterConversation",
    )?.args[2];
    expect(draft).toEqual({
      text: "Read https://hackerone.com/acme",
      importModel: { modelOptions: [{ id: "variant", value: "high" }] },
    });
  });
});

describe("U3: a message sent while a switch is out", () => {
  test("says it is waiting for the switch, until the switch has answered", async () => {
    const { fake } = await openOn();
    const releaseSwitch = fake.hold("switchImporterModel");
    const releaseSend = fake.hold("sendImporterMessage");
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();
    // The modal can be left while the switch is out, and the composer used.
    press("Escape");
    await settle();
    expect(picker()).toBeNull();

    typeInto(composer(), "And the staging hosts");
    composer().focus();
    press("Enter");
    await settle();

    expect(page()).toContain(
      "Waiting for the model switch: this message is delivered once the switch has answered, which can take up to a minute and a half.",
    );

    releaseSwitch();
    await settle();
    expect(page()).not.toContain("Waiting for the model switch");

    releaseSend();
    await settle();
    expect(composer().value).toBe("");
  });

  test("a message with no switch out says nothing of one", async () => {
    const { fake } = await openOn();
    const releaseSend = fake.hold("sendImporterMessage");
    typeInto(composer(), "And the staging hosts");
    composer().focus();
    press("Enter");
    await settle();

    expect(page()).not.toContain("Waiting for the model switch");
    releaseSend();
    await settle();
  });
});

describe("D3: the caption beside the model chip", () => {
  test("a started session says its harness is fixed and its models are not", async () => {
    await openOn();
    const caption = [...document.querySelectorAll(".strip .hint")].map(said);
    expect(caption).toEqual(["OpenCode for this session · any of its models"]);
  });

  test("a new session has none: its harness is still open", async () => {
    await openOn([], undefined);
    expect(page()).not.toContain("for this session · any of its models");
  });

  test("a session the operator ended has none, and its model is a label, not a control", async () => {
    await openOn([
      importerSessionView({
        sessionId: "ses_old",
        model: SOL,
        endedAt: 1,
        endedReason: "operator",
      }),
    ]);
    expect(page()).not.toContain("for this session · any of its models");
    expect(document.querySelector('button[aria-label^="Model: "]')).toBeNull();
    expect(document.querySelector(".chip.held")?.tagName).toBe("SPAN");
  });

  test("in the state picker the caption is drawn too, and a switch applies here only", async () => {
    const app = new App(new FakeServer(), new FakeCountdown());
    const scenario = scenarios.find((each) => each.id === "importer-complete");
    if (scenario === undefined) throw new Error("no scenario");
    scenario.apply(app);
    mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
    await settle();

    expect(page()).toContain("OpenCode for this session · any of its models");
    await openPicker();
    click(inPicker(FIVE));
    await settle();
    click(inPicker("Use for this session"));
    await settle();
    expect(app.importer.current?.model).toBe(FIVE);
    expect(page()).toContain(
      `Now on ${FIVE} here only: the state picker has no server to ask.`,
    );
  });
});
