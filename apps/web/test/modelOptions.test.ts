/**
 * What the picker remembers of a model, and what a run is dispatched with.
 *
 * ## Why these are here and not beside the contract
 *
 * The rules themselves are pure and live in `@bit/contracts`'s `modelOption.ts`, because
 * the server resolves with exactly the same functions — a browser that normalised
 * differently from the server would show one thing and run another. They are exercised
 * from this package because this is where the *stateful* half is: which bucket a choice
 * lands in, what survives a model change, and what the composer ends up sending. A test
 * of `displayedModelOption` alone would miss every one of those, and `@bit/contracts` has
 * no test runner of its own to add one to without touching the lockfile.
 *
 * The server's half of the same rules — resolution against *its* catalogue, and what
 * reaches `createSession` — is `apps/server/src/run/supervisor.test.ts`, and
 * `apps/server/src/import/scopeImporter.test.ts` for an importer session.
 *
 * Like `app.test.ts`, nothing here renders a component: every assertion is about a field
 * the picker reads.
 */
import { describe, expect, test } from "bun:test";
import {
  displayedModelOption,
  type ModelOptionDescriptor,
} from "@bit/contracts";

import { App } from "../src/lib/app.svelte";
import { FakeServer, harnessInstance, ok } from "./fakeServer";

/** `effort`, with a default and two levels. The shape both harnesses report. */
const effort: ModelOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "default", label: "Default", isDefault: true },
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
};

/**
 * Two instances, each with a model that offers reasoning and one that offers nothing.
 *
 * Both halves are load-bearing: the models prove that a choice does not follow a model
 * change, and the two instances prove that it does not follow a harness change either.
 */
const signedIn = async (): Promise<{ app: App; fake: FakeServer }> => {
  const fake = new FakeServer();
  fake.onHarnesses = () =>
    ok([
      harnessInstance({
        instanceId: "opencode",
        displayName: "OpenCode",
        isDefault: true,
        defaultModel: "openai/one",
        models: [
          { id: "openai/one", optionDescriptors: [effort] },
          { id: "openai/plain" },
        ],
      }),
      harnessInstance({
        instanceId: "claude-code",
        displayName: "Claude Code",
        isDefault: false,
        defaultModel: "claude-sonnet-5",
        models: [{ id: "claude-sonnet-5", optionDescriptors: [effort] }],
      }),
    ]);
  const app = new App(fake);
  app.password = "correct-horse";
  await app.connect();
  return { app, fake };
};

describe("what the model column offers", () => {
  test("the picked model's descriptors are what is offered", async () => {
    const { app } = await signedIn();

    expect(app.effectiveModel).toBe("openai/one");
    expect(app.modelDescriptors.map((entry) => entry.id)).toEqual(["effort"]);

    app.pickModel("openai/plain");
    // A model that offers nothing offers nothing: the column says so rather than
    // carrying the previous model's controls over.
    expect(app.modelDescriptors).toEqual([]);
  });

  test("a model the catalogue does not list offers nothing, and is not refused", async () => {
    const { app } = await signedIn();

    app.pickModel("openai/never-heard-of-it");

    expect(app.pickedModelView).toBeUndefined();
    expect(app.modelDescriptors).toEqual([]);
    // Still the model a run would use. Whether it runs is the harness's answer.
    expect(app.effectiveModel).toBe("openai/never-heard-of-it");
  });
});

describe("what a choice survives", () => {
  test("a choice is kept per model, and switching back restores it", async () => {
    const { app } = await signedIn();

    app.pickModelOption("effort", "high");
    expect(app.pickedModelOptions).toEqual([{ id: "effort", value: "high" }]);

    // Switching model does not carry it over...
    app.pickModel("openai/plain");
    expect(app.pickedModelOptions).toEqual([]);

    // ...and does not lose it either.
    app.pickModel("openai/one");
    expect(app.pickedModelOptions).toEqual([{ id: "effort", value: "high" }]);
  });

  test("a choice is kept per instance, so switching harness cannot mix them", async () => {
    const { app } = await signedIn();

    app.pickModelOption("effort", "high");
    app.pickInstance("claude-code");

    expect(app.effectiveModel).toBe("claude-sonnet-5");
    // The same descriptor id on a different instance's model, and none of the other
    // instance's choice.
    expect(app.modelDescriptors.map((entry) => entry.id)).toEqual(["effort"]);
    expect(app.pickedModelOptions).toEqual([]);

    app.pickModelOption("effort", "low");
    app.pickInstance("opencode");
    expect(app.pickedModelOptions).toEqual([{ id: "effort", value: "high" }]);
  });

  test("picking the model's own default takes the setting off", async () => {
    const { app } = await signedIn();

    app.pickModelOption("effort", "high");
    app.pickModelOption("effort", "default");

    // Stored as nothing rather than as `"default"`: the two are indistinguishable
    // downstream, so keeping them apart would be a state with no consequence.
    expect(app.pickedModelOptions).toEqual([]);
  });

  test("an option the model does not offer cannot be set", async () => {
    const { app } = await signedIn();

    app.pickModelOption("madeUp", "yes");

    expect(app.pickedModelOptions).toEqual([]);
    expect(app.droppedModelOptions).toEqual([]);
  });
});

describe("what the picker shows", () => {
  test("nothing set shows the model's default, marked as not the operator's", () => {
    const shown = displayedModelOption(effort, []);
    expect(shown).toEqual({
      value: "default",
      label: "Default",
      known: true,
      explicit: false,
    });
  });

  test("a choice set shows that choice", () => {
    expect(
      displayedModelOption(effort, [{ id: "effort", value: "low" }]),
    ).toEqual({ value: "low", label: "Low", known: true, explicit: true });
  });

  test("a stale value is shown as itself rather than relabelled", () => {
    // The subtlest rule in `modelOption.ts`, and the reason display bypasses
    // normalisation: a run would fall back to `default` here, and showing "Default" would
    // tell an operator their choice is still in effect under another name.
    const shown = displayedModelOption(effort, [
      { id: "effort", value: "xhigh" },
    ]);
    expect(shown).toEqual({
      value: "xhigh",
      label: "xhigh",
      known: false,
      explicit: true,
    });
  });
});

describe("what a run is dispatched with", () => {
  const dispatchedOptions = (fake: FakeServer): unknown => {
    const call = fake.calls.find((entry) => entry.method === "startRun");
    const pick = call?.args[3];
    return pick === undefined || pick === null
      ? undefined
      : (pick as { modelOptions?: unknown }).modelOptions;
  };

  const readyToRun = async (): Promise<{ app: App; fake: FakeServer }> => {
    const { app, fake } = await signedIn();
    await app.openTarget("acme-corp");
    app.runIntentId = "intent-1";
    return { app, fake };
  };

  test("nothing set sends no options at all", async () => {
    const { app, fake } = await readyToRun();

    await app.startRun();

    expect(fake.countOf("startRun")).toBe(1);
    // Absent, not `[]`: a harness handed nothing applies its own default, and an empty
    // list would have claimed an opinion the operator never expressed.
    expect(dispatchedOptions(fake)).toBeUndefined();
  });

  test("what was set is sent, and only that", async () => {
    const { app, fake } = await readyToRun();

    app.pickModelOption("effort", "high");
    await app.startRun();

    expect(dispatchedOptions(fake)).toEqual([{ id: "effort", value: "high" }]);
  });

  test("a choice made on another model is not sent with this one", async () => {
    const { app, fake } = await readyToRun();

    app.pickModelOption("effort", "high");
    app.pickModel("openai/plain");
    await app.startRun();

    expect(dispatchedOptions(fake)).toBeUndefined();
  });
});

/**
 * The importer's picker sends options too (S3.5), from a store of its own.
 *
 * The run's cases above, asked of `startScopeImport`: absent when nothing was set, only
 * what was set, and nothing carried across a model change. The server resolves what arrives
 * again against the model it actually picked.
 */
describe("what an import is dispatched with", () => {
  const sentImportModel = (fake: FakeServer): unknown => {
    const call = fake.calls.find(
      (entry) => entry.method === "startScopeImport",
    );
    return (call?.args[2] as { importModel?: unknown } | undefined)
      ?.importModel;
  };

  const readyToImport = async (): Promise<{ app: App; fake: FakeServer }> => {
    const { app, fake } = await signedIn();
    fake.onImporterModel = () =>
      ok({
        instanceId: "opencode",
        model: "openai/one",
        origin: "preferred",
        detail: "OpenCode offers openai/one",
      });
    await app.openTarget("acme-corp");
    app.toSection("assets");
    app.openImporter();
    await new Promise((resolve) => setTimeout(resolve, 0));
    app.setProgramLink(
      app.programLinks[0]?.id ?? 1,
      "https://hackerone.com/acme/policy",
    );
    return { app, fake };
  };

  test("the server's resolved model offers its descriptors to the column", async () => {
    const { app } = await readyToImport();
    expect(app.effectiveImportModel).toBe("openai/one");
    expect(app.importModelDescriptors.map((entry) => entry.id)).toEqual([
      "effort",
    ]);
  });

  test("nothing set sends no importModel at all", async () => {
    const { app, fake } = await readyToImport();
    await app.startScopeImport();
    expect(fake.countOf("startScopeImport")).toBe(1);
    expect(sentImportModel(fake)).toBeUndefined();
  });

  test("an option set on the resolved model is sent alone, for the server to resolve", async () => {
    const { app, fake } = await readyToImport();
    app.pickImportModelOption("effort", "high");
    await app.startScopeImport();
    // No model: the operator did not override it, so the server still applies D15's rule
    // and resolves the option against whatever that answers.
    expect(sentImportModel(fake)).toEqual({
      modelOptions: [{ id: "effort", value: "high" }],
    });
  });

  test("picking the default takes the setting off rather than sending it", async () => {
    const { app, fake } = await readyToImport();
    app.pickImportModelOption("effort", "high");
    app.pickImportModelOption("effort", "default");
    await app.startScopeImport();
    expect(sentImportModel(fake)).toBeUndefined();
  });

  test("a choice made on another model is not sent with this one", async () => {
    const { app, fake } = await readyToImport();
    app.pickImportModelOption("effort", "high");
    app.pickImportModel("openai/plain");
    await app.startScopeImport();
    expect(sentImportModel(fake)).toEqual({ model: "openai/plain" });
  });

  test("a run's options and an import's are kept apart", async () => {
    const { app } = await readyToImport();
    app.pickModelOption("effort", "low");
    expect(app.pickedImportModelOptions).toEqual([]);
    app.pickImportModelOption("effort", "high");
    expect(app.pickedModelOptions).toEqual([{ id: "effort", value: "low" }]);
  });
});
