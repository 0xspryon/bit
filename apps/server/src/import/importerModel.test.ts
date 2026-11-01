/**
 * Which model an import runs on, resolved against the catalogue (D15).
 *
 * The thing under test is that **neither half of the rule is a remembered model id**.
 * `modelOption.ts` is explicit that a descriptor is observed when the server built the
 * harness and replaced wholesale when it is rebuilt, and that collapsing one into a
 * remembered choice is how a capability starts being presented as a selection. A
 * hardcoded id would outlive the catalogue entry it names.
 *
 * So the preferred model is a *lookup key* — present or absent in what the harness
 * reported, and nothing is assumed about it when absent — and the fallback is the
 * harness's own `defaultModel`, which is a value the harness reports and which every run
 * already uses (`run/supervisor.ts`: `input.model ?? harness.instance.defaultModel`).
 *
 * **The assertions name the instance as well as the model**, which is the whole point of
 * the second step: an earlier version of this suite checked only `origin === "fallback"`
 * and `model !== PREFERRED`, which passed whichever harness the fallback landed on and
 * whichever model it chose there. The catalogues are invented here, including ones where
 * every model name in the repo today has been retired.
 */
import { describe, expect, test } from "bun:test";

import {
  chooseImporterModel,
  PREFERRED_IMPORTER_MODEL,
  resolveImporterModel,
} from "./importerModel";
import {
  CLAUDE_CODE_DRIVER,
  InstanceId,
  OPENCODE_DRIVER,
  type HarnessInstance,
} from "../harness/identity";
import type { HarnessListing } from "../harness/resolver";

const instance = (input: {
  readonly id: string;
  readonly driver: typeof OPENCODE_DRIVER;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
}): HarnessInstance => ({
  instanceId: InstanceId.make(input.id),
  driver: input.driver,
  displayName: input.displayName,
  version: "1.0.0",
  installed: true,
  auth: "unknown",
  defaultModel: input.defaultModel,
  models: input.models.map((id) => ({ id })),
});

const listing = (
  value: HarnessInstance,
  options?: { readonly ready?: boolean; readonly isDefault?: boolean },
): HarnessListing => ({
  instance: value,
  enabled: true,
  available: options?.ready !== false,
  status: options?.ready === false ? "unavailable" : "ready",
  reason: options?.ready === false ? "not installed on this server" : undefined,
  setup: undefined,
  isDefault: options?.isDefault ?? false,
});

/** An OpenCode catalogue that has the preferred model. */
const openCodeWithGlm = listing(
  instance({
    id: "opencode",
    driver: OPENCODE_DRIVER,
    displayName: "OpenCode",
    defaultModel: "openai/gpt-5.6-sol",
    models: [
      "openai/gpt-5.6-sol",
      PREFERRED_IMPORTER_MODEL,
      "anthropic/claude-sonnet-5",
    ],
  }),
  { isDefault: true },
);

/** The same harness after the provider retired that model. */
const openCodeWithoutGlm = listing(
  instance({
    id: "opencode",
    driver: OPENCODE_DRIVER,
    displayName: "OpenCode",
    defaultModel: "openai/gpt-5.6-sol",
    models: ["openai/gpt-5.6-sol", "openai/gpt-5-mini"],
  }),
  { isDefault: true },
);

const claudeCode = listing(
  instance({
    id: "claude-code",
    driver: CLAUDE_CODE_DRIVER as unknown as typeof OPENCODE_DRIVER,
    displayName: "Claude Code",
    defaultModel: "claude-sonnet-5",
    models: [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ],
  }),
);

describe("the default resolves from the catalogue", () => {
  test("the preferred model is used when a harness reports it", () => {
    const choice = chooseImporterModel([openCodeWithGlm, claudeCode]);
    expect(choice).toMatchObject({
      instanceId: "opencode",
      model: PREFERRED_IMPORTER_MODEL,
      origin: "preferred",
    });
  });

  test("it is found wherever it is, not on a particular harness", () => {
    // The rule is "whichever ready harness offers it", not "OpenCode". A build where the
    // preferred model is reachable through a differently named instance still gets it.
    const elsewhere = listing(
      instance({
        id: "opencode-2",
        driver: OPENCODE_DRIVER,
        displayName: "OpenCode (second)",
        defaultModel: "openai/gpt-5.6-sol",
        models: [PREFERRED_IMPORTER_MODEL],
      }),
    );
    expect(chooseImporterModel([claudeCode, elsewhere])).toMatchObject({
      instanceId: "opencode-2",
      model: PREFERRED_IMPORTER_MODEL,
      origin: "preferred",
    });
  });

  test("nothing is assumed about it when the catalogue does not list it", () => {
    // The fallback triggers on absence from the *reported* catalogue, which is the whole
    // reason the preferred id is a lookup key rather than a descriptor. This is the test
    // that would fail if somebody "optimised" the lookup away and used the id directly.
    //
    // **And it names what it landed on.** Asserting only `origin === "fallback"` and
    // `model !== PREFERRED` passed whichever harness and whichever model the fallback
    // chose, which is exactly what went wrong: it was taking a heuristic's answer over the
    // first ready harness's catalogue, and nothing here could tell.
    const choice = chooseImporterModel([openCodeWithoutGlm, claudeCode]);
    expect(choice).toEqual({
      instanceId: "opencode",
      // OpenCode's own default, not Claude Code's anything and not the `gpt-5-mini` a
      // name-ranking rule would have preferred. The harness answers "which model" for
      // itself, which is what every run already does.
      model: "openai/gpt-5.6-sol",
      origin: "fallback",
      detail: `no configured harness offers ${PREFERRED_IMPORTER_MODEL}, so this uses OpenCode's own default model, openai/gpt-5.6-sol`,
    });
  });
});

describe("the fallback is the harness's own default model", () => {
  test("it is the configured harness's defaultModel, whatever else is in its catalogue", () => {
    // `claudeCode`'s catalogue lists a haiku, a sonnet and an opus. The fallback takes the
    // default the harness reports — the operator's configuration — rather than ranking
    // those names for the cheapest-looking one.
    const choice = chooseImporterModel([claudeCode]);
    expect(choice).toMatchObject({
      instanceId: "claude-code",
      model: "claude-sonnet-5",
      origin: "fallback",
    });
    expect(choice?.detail).toContain(PREFERRED_IMPORTER_MODEL);
    expect(choice?.detail).toContain("claude-sonnet-5");
  });

  test("it is the first ready harness, in configuration order", () => {
    // Which is also what `resolve(undefined)` would have picked, so the importer lands on
    // the same harness as everything else rather than on a surprising one.
    expect(chooseImporterModel([claudeCode, openCodeWithoutGlm])).toMatchObject(
      {
        instanceId: "claude-code",
        model: "claude-sonnet-5",
      },
    );
  });

  test("it works on a catalogue where every name in the repo today is gone", () => {
    // The point of reading a reported value rather than naming a second model. None of
    // these ids exists anywhere in this codebase and the rule still answers.
    const future = listing(
      instance({
        id: "future",
        driver: OPENCODE_DRIVER,
        displayName: "Future",
        defaultModel: "acme/colossus-9",
        models: ["acme/colossus-9", "acme/colossus-9-nano", "acme/midsize-3"],
      }),
    );
    expect(chooseImporterModel([future])).toMatchObject({
      instanceId: "future",
      model: "acme/colossus-9",
      origin: "fallback",
    });
  });

  test("an unready harness does not get to answer, even first in order", () => {
    expect(
      chooseImporterModel([
        listing(claudeCode.instance, { ready: false }),
        openCodeWithoutGlm,
      ]),
    ).toMatchObject({ instanceId: "opencode", model: "openai/gpt-5.6-sol" });
  });
});

describe("what it refuses to answer", () => {
  test("no harness at all is undefined, not an invented model", () => {
    expect(chooseImporterModel([])).toBeUndefined();
  });

  test("an unready harness is not resolved against", () => {
    // It is still listed to the operator with its reason — `harness/resolver.ts` keeps it
    // visible on purpose — but preferring a model on a harness that will refuse to open a
    // session turns a legible "no harness is ready" into an import that fails a step later
    // for a reason reading like the model's fault.
    expect(
      chooseImporterModel([
        listing(openCodeWithGlm.instance, { ready: false }),
      ]),
    ).toBeUndefined();
  });
});

describe("the operator's pick", () => {
  test("no pick is the rule's answer", () => {
    expect(resolveImporterModel({ listings: [openCodeWithGlm] })).toMatchObject(
      { model: PREFERRED_IMPORTER_MODEL, origin: "preferred" },
    );
  });

  test("an explicit model is taken as sent, not validated against the list", () => {
    // `RunDraft.model`'s treatment exactly: that list is what the picker *offers*, and
    // whether a model can run is the harness's answer to give rather than ours to
    // pre-empt. A browser holding a stale catalogue is the expected case.
    expect(
      resolveImporterModel({
        listings: [openCodeWithGlm],
        choice: { instanceId: "opencode", model: "openai/something-new" },
      }),
    ).toMatchObject({
      instanceId: "opencode",
      model: "openai/something-new",
    });
  });

  test("picking another instance with no model gets that instance's own default", () => {
    // Not the rule's model, which belongs to a different harness's catalogue and would be
    // a name this instance has never heard of.
    expect(
      resolveImporterModel({
        listings: [openCodeWithGlm, claudeCode],
        choice: { instanceId: "claude-code" },
      }),
    ).toMatchObject({
      instanceId: "claude-code",
      model: "claude-sonnet-5",
    });
  });

  test("picking an instance this server does not configure substitutes nothing", () => {
    // The module's own promise, which it used to break in exactly this case: an unknown
    // `instanceId` fell through to the rule's answer, so the record of which harness ran
    // the import named a harness the operator never chose. `HarnessResolver.resolve`
    // refuses this by name, with its own sentence, which is where a bad pick belongs.
    const choice = resolveImporterModel({
      listings: [openCodeWithGlm],
      choice: { instanceId: "not-configured" },
    });
    expect(choice?.instanceId).toBe("not-configured");
    expect(choice?.model).toBe("");
    expect(choice?.detail).toContain("does not configure");
  });

  test("empty strings are no pick rather than a pick of nothing", () => {
    // The browser sends "" for "the server's default", which is the convention
    // `app.svelte.ts` already uses for the harness picker.
    expect(
      resolveImporterModel({
        listings: [openCodeWithGlm],
        choice: { instanceId: "", model: "" },
      }),
    ).toMatchObject({ model: PREFERRED_IMPORTER_MODEL });
  });
});
