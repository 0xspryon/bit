/**
 * The importer screen names a model by its label, never by an alias (follow-ups A,
 * 2026-11-11): a z.ai Claude Code session on `sonnet` reads "GLM-5.3 Flash" in its turns'
 * footers, its chip, the context meter's popover and the session list; a Pi session's chip
 * says the thinking level chosen beside the model.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type {
  ConversationContext,
  HarnessInstanceView,
  ImporterSessionView,
} from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerConversationView,
  importerSessionView,
  ok,
  replayItem,
} from "../fakeServer";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const said = (element: Element | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The importer's model chip: the one naming a harness instance. */
const modelChip = (): Element | null =>
  document.querySelector(".chip .instance")?.closest(".chip") ?? null;

const ZAI: HarnessInstanceView = {
  instanceId: "cc-zai",
  driver: "claude-code",
  displayName: "Claude Code · z.ai",
  version: "2.1.310",
  ready: true,
  auth: "unknown",
  isDefault: true,
  defaultModel: "sonnet",
  models: [
    { id: "sonnet", label: "GLM-5.3 Flash", reportedAs: "glm-5.3-flash" },
    { id: "opus", label: "GLM-5.3", reportedAs: "glm-5.3" },
  ],
};

const PI: HarnessInstanceView = {
  instanceId: "pi-zai",
  driver: "pi",
  displayName: "Pi · z.ai",
  version: "1.5.2",
  ready: true,
  auth: "unknown",
  isDefault: false,
  defaultModel: "zai/glm-5.3-flash",
  models: [
    {
      id: "zai/glm-5.3-flash",
      label: "GLM-5.3-Flash",
      optionDescriptors: [
        {
          id: "thinkingLevel",
          label: "Thinking",
          type: "select",
          options: [
            { id: "default", label: "Pi's default", isDefault: true },
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "max", label: "Maximum" },
          ],
        },
      ],
    },
  ],
};

const reading = (): ConversationContext => ({
  conversationId: "imp_1",
  model: "sonnet",
  used: 24_106,
  // The last call was before a switch to `sonnet`: on `opus`.
  usedModel: "opus",
  window: 200_000,
  reading: "measured",
  breakdown: { _tag: "none", reason: "not_asked" },
  measuredAt: Date.now(),
});

const openOn = async (session: ImporterSessionView): Promise<App> => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions: [session] });
  fake.onHarnesses = () => ok([ZAI, PI]);
  fake.onImporterContext = () => ok(reading());
  fake.onImporterMessages = (_baseUrl, targetId, importId) =>
    ok(
      importerConversationView({
        targetId,
        importId,
        items: [
          replayItem(0, "turn.operator", "Read the policy page", { importId }),
          replayItem(1, "turn.reply", "On it.", {
            importId,
            model: "opus",
            at: Date.now() - 2_000,
          }),
          replayItem(2, "turn.reply", "Two entries in.", {
            importId,
            model: "sonnet",
            at: Date.now() - 1_000,
          }),
        ],
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.openImporter(session.sessionId);
  await settle();
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  await settle();
  return app;
};

describe("a z.ai Claude Code session on an alias", () => {
  const session = importerSessionView({
    harnessInstanceId: "cc-zai",
    model: "sonnet",
  });

  test("its turn's footer names the models by their labels", async () => {
    await openOn(session);
    const footers = [...document.querySelectorAll('[role="log"] .foot')].map(
      (foot) => said(foot),
    );
    expect(footers.length).toBe(1);
    expect(footers[0]).toMatch(/^Importer · GLM-5\.3 → GLM-5\.3 Flash/);
    expect(footers.join(" ")).not.toMatch(/sonnet|opus/);
  });

  test("its chip and the context meter's popover name the models by their labels", async () => {
    await openOn(session);
    expect(said(modelChip())).toContain("GLM-5.3 Flash");
    const meter = document.querySelector<HTMLButtonElement>(
      ".context-meter button.meter",
    );
    if (meter === null) throw new Error("no context meter");
    click(meter);
    await settle();
    const panel = said(
      document.querySelector(
        '[role="dialog"][aria-label="What fills the context window"]',
      ),
    );
    expect(panel).toContain("Context window GLM-5.3 Flash");
    expect(panel).toContain(
      "Measured on GLM-5.3's last call. The next call, on GLM-5.3 Flash,",
    );
    expect(panel).not.toMatch(/sonnet|opus/);
  });

  test("the session list names its model by its label", async () => {
    const app = await openOn(session);
    expect(app.importer.listed.length).toBe(1);
    app.importer.pickerOpen = true;
    await settle();
    const models = [...document.querySelectorAll(".session-model")].map(
      (each) => said(each),
    );
    expect(models).toEqual(["GLM-5.3 Flash"]);
  });
});

describe("a Pi session at a chosen thinking level", () => {
  test("its chip says the level beside the model's label, from the session's index row", async () => {
    await openOn(
      importerSessionView({
        harnessInstanceId: "pi-zai",
        model: "zai/glm-5.3-flash",
        modelOptions: [{ id: "thinkingLevel", value: "high" }],
      }),
    );
    expect(said(modelChip())).toContain("GLM-5.3-Flash · High");
  });
});
