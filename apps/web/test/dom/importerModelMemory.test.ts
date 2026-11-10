/**
 * The model the operator last picked for a new importer session, kept per target (U8
 * review): every opening of the importer used to put the chip back on D15's default — the
 * free OpenCode model, often out of quota — and the operator's pick was lost to "Auto-load…",
 * a reload of `/assets/chat`, or a deep link.
 *
 * Driven through the chip and its dialog, as the operator picks; a reload is a second `App`
 * on the same browser storage, which is what a reload is to `localStorage`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { HarnessInstanceView } from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import TitleBar from "../../src/lib/components/TitleBar.svelte";
import { browserModelMemory } from "../../src/lib/modelMemory";
import Target from "../../src/lib/screens/Target.svelte";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer, emptyScope, ok } from "../fakeServer";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const FREE = "opencode/glm-5.3-flash-free";
/** The server address a page load points at, which the memory is keyed by beside the target. */
const SERVER_URL = new App(new FakeServer(), new FakeCountdown()).serverUrl;
const HAIKU = "claude-haiku-4-5";

const harness = (
  instanceId: string,
  displayName: string,
  models: readonly string[],
  ready = true,
): HarnessInstanceView => ({
  instanceId,
  driver: instanceId,
  displayName,
  version: "1.0.0",
  ready,
  auth: "authenticated",
  isDefault: false,
  defaultModel: models[0] ?? "",
  models: models.map((id) => ({ id })),
});

const HARNESSES = (
  claudeReady = true,
  claudeModels = [HAIKU, "claude-sonnet-5"],
) => [
  harness("opencode", "OpenCode", [FREE, "zai-coding-plan/glm-5.3-flash"]),
  harness("claude-code", "Claude Code", claudeModels, claudeReady),
];

/** A page load: a fresh `App` on the server `fake`, opened on `targetId`'s Scope tab. */
const load = async (fake: FakeServer, targetId = "acme-corp"): Promise<App> => {
  for (const each of mounted) each.destroy();
  mounted = [];
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  await toScope(app, targetId);
  mounted.push(mountInto(TitleBar, { app }), mountInto(Target, { app }));
  await settle();
  return app;
};

const toScope = async (app: App, targetId: string): Promise<void> => {
  app.openTarget(targetId);
  await settle();
  app.toSection("assets");
  await settle();
  app.toAssetsTab("scope");
  await settle();
};

const server = (harnesses = HARNESSES()): FakeServer => {
  const fake = new FakeServer();
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () => ok({ sessions: [] });
  fake.onHarnesses = () => ok(harnesses);
  return fake;
};

const chip = (): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="dialog"][aria-label^="Harness and model"]',
  );
  if (found === null) throw new Error("no model chip");
  return found;
};

/** The chip's model: its label names the instance, then the model (harness instances). */
const chipModel = (): string =>
  chip()
    .getAttribute("aria-label")
    ?.replace(/^Harness and model: [^,]*, /, "") ?? "";

const autoLoad = async (app: App): Promise<void> => {
  app.openImporter();
  await settle();
};

/** Picks through the chip's dialog: the harness's row, then the model's button. */
const pick = async (harnessName: string, model: string): Promise<void> => {
  click(chip());
  await settle();
  const dialog = document.querySelector(
    '[role="dialog"][aria-label="Choose a harness and model"]',
  );
  if (dialog === null) throw new Error("no picker open");
  const row = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (each) => each.textContent?.includes(harnessName) === true,
  );
  if (row === undefined) throw new Error(`no ${harnessName} row`);
  click(row);
  await settle();
  const button = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim().startsWith(model) === true,
  );
  if (button === undefined) throw new Error(`no ${model} button`);
  click(button);
  await settle();
};

describe("the model picked for a new importer session (U8 review)", () => {
  test("is the chip's again after Auto-load… and after a reload, not D15's free model", async () => {
    const fake = server();
    let app = await load(fake);
    await autoLoad(app);
    expect(chipModel()).toBe(FREE);

    await pick("Claude Code", HAIKU);
    expect(chipModel()).toBe(HAIKU);

    // Back to the Scope tab and "Auto-load…" again: a fresh page, the same pick.
    await toScope(app, "acme-corp");
    await autoLoad(app);
    expect(chipModel()).toBe(HAIKU);
    expect(app.importInstance?.instanceId).toBe("claude-code");

    // A reload: a new App on the same browser storage.
    app = await load(fake);
    await autoLoad(app);
    expect(chipModel()).toBe(HAIKU);
    expect(app.importInstance?.instanceId).toBe("claude-code");
  });

  test("is kept per target: another target opens on D15's rule", async () => {
    const fake = server();
    const app = await load(fake);
    await autoLoad(app);
    await pick("Claude Code", HAIKU);

    await toScope(app, "other-corp");
    await autoLoad(app);
    expect(chipModel()).toBe(FREE);
  });

  test("gives way to D15's rule when its harness is not ready, or no longer lists it", async () => {
    browserModelMemory.write(SERVER_URL, "acme-corp", {
      instanceId: "claude-code",
      model: HAIKU,
    });
    let app = await load(server(HARNESSES(false)));
    await autoLoad(app);
    expect(chipModel()).toBe(FREE);

    app = await load(server(HARNESSES(true, ["claude-sonnet-5"])));
    await autoLoad(app);
    expect(chipModel()).toBe(FREE);

    // And D15's own pick is not written down as the operator's: the memory is untouched.
    expect(browserModelMemory.read(SERVER_URL, "acme-corp")?.model).toBe(HAIKU);
    app = await load(server());
    await autoLoad(app);
    expect(chipModel()).toBe(HAIKU);
  });

  test("a newer catalogue that cannot honour a pick put on from memory puts D15's back", async () => {
    const fake = server();
    let app = await load(fake);
    await autoLoad(app);
    await pick("Claude Code", HAIKU);
    app = await load(fake);
    await autoLoad(app);
    expect(chipModel()).toBe(HAIKU);
    // Claude Code stops being ready; the next reading of the harnesses says so.
    fake.onHarnesses = () => ok(HARNESSES(false));
    await app.loadHarnesses();
    await settle();
    expect(chipModel()).toBe(FREE);
  });
});
