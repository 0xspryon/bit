/**
 * What the New target screen actually says when a folder cannot hold a target.
 *
 * `app.test.ts` covers the state machine, and the state is not the defect: an operator
 * picked a folder in the picker, created a target, and learned only when the scope
 * importer refused that the folder was unusable. So the claim worth asserting here is
 * about *rendered output* — that the refusal reaches the screen in the server's own
 * words, with the way out on it, and without the offer that belongs to a different
 * refusal. None of that can be checked from `createState` alone.
 *
 * Server-rendered, so no `$effect` runs; the division is the one `assetsComponent.test.ts`
 * records.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import { PathRefused, TargetRefused } from "@bit/contracts";

import NewTarget from "../src/lib/screens/NewTarget.svelte";
import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import {
  FakeServer,
  folderListing,
  ok,
  refused,
  unreachable,
} from "./fakeServer";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const DETAIL =
  "/work contains this server's fleet root /work/.runtime/hunt, so this target's own directory /work/.runtime/hunt/targets/bit-demo would sit inside the folder where its workers run. Pick a folder outside /work/.runtime/hunt, or restart this server with HUNT_ROOT set outside the folder you want to use";

/** Signs in and opens the form, which is as far as every test below starts from. */
const onForm = async (fake = new FakeServer()): Promise<App> => {
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openNewTarget();
  await settle();
  return app;
};

const body = (app: App): string => render(NewTarget, { props: { app } }).body;

/** Drives the real `App` to the refusal, then renders the screen it leaves up. */
const refusedBody = async (error: TargetRefused): Promise<string> => {
  const fake = new FakeServer();
  fake.onCreateTarget = () => refused(error);
  const app = await onForm(fake);
  app.chooseFolder("/work");
  await app.createTarget();
  return body(app);
};

/** Whether some button on the screen carries this label. */
const buttonLabelled = (html: string, label: string): boolean =>
  (html.match(/<button[\s\S]*?<\/button>/g) ?? []).some((button) =>
    button.includes(label),
  );

/**
 * Whether the operator can press Create, read off the rendered button.
 *
 * The claim in two of the fixes below is "Create stays disabled", and `createState` cannot
 * answer it: the disabling rule is `canCreate` in the component. SSR emits the attribute
 * only when it is true, so its presence on the submit button is the whole answer.
 */
const createEnabled = (html: string): boolean => {
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
  const create = buttons.find((button) => button.includes("Create target"));
  if (create === undefined) {
    throw new Error("the screen rendered no Create target button");
  }
  // SSR spells a true boolean attribute `disabled=""`, so the `=` form counts.
  return !/\sdisabled(?:=|[\s>])/.test(
    create.slice(0, create.indexOf(">") + 1),
  );
};

describe("a folder that cannot hold a target", () => {
  test("the screen carries the server's reason and a way out", async () => {
    const html = await refusedBody(
      new TargetRefused({
        reason: "workspace_contains_fleet_root",
        targetId: "bit-demo",
        detail: DETAIL,
      }),
    );

    // The server's sentence, which is the only thing on screen that says what to change.
    expect(html).toContain("That folder cannot hold a target");
    expect(html).toContain("/work/.runtime/hunt/targets/bit-demo");
    expect(html).toContain("HUNT_ROOT");
    // The picker again, because the folder is what has to change.
    expect(buttonLabelled(html, "Choose another folder")).toBe(true);
    // Not the duplicate's offer: `bit-demo` was never registered, so there is nothing to
    // open. This is what the old "duplicate unless invalid_name" mapping would have shown.
    expect(html).not.toContain("Already a target");
    expect(html).not.toContain("Open bit-demo");
    // Nor the readable-folder advice: granting access cannot fix a layout.
    expect(html).not.toContain("grant access");
  });
});

/**
 * What the Folder field claims, which is the defect the refusal above was a symptom of.
 *
 * The field read "where this target's hunt database is written" and previewed
 * `<chosen folder>/<name>-<id>/hunt.sqlite`. Neither is true: `fleet.paths.huntFile` is
 * `<fleet root>/targets/<id>/hunt.sqlite`, and the reviewer's chosen folder was left
 * empty. It is not a cosmetic defect — an operator who believes that label has no reason
 * to think the folder they choose relates to `HUNT_ROOT` at all, which is how one
 * nominates a folder containing it and gets a target no session can run in. The screenshot
 * of the refusal has both claims on it at once.
 */
describe("the folder field", () => {
  test("says the folder is the workspace, and where the database really goes", async () => {
    const app = await onForm();
    app.chooseFolder("/work/acme-corp");
    const html = body(app);

    // What the folder is for.
    expect(html).toContain("where this target's workers run");
    // Where the file goes: the fleet root the server reported, and not here.
    expect(html).toContain("/fleet/targets/");
    // A regex because Prettier wraps the sentence across lines in the markup.
    expect(html).toMatch(/not in the\s+workspace\s+folder/);
    // Not the old claim, and not a path that will never exist.
    expect(html).not.toContain("where this target's hunt database is written");
    expect(html).not.toContain("/work/acme-corp/acme-corp-");
  });

  test("with no answer from the server it names no path at all", async () => {
    const fake = new FakeServer();
    // The probe is how the browser learns the fleet root, and it can fail: the form words
    // the sentence without a root rather than filling the gap with a guess.
    fake.onProbe = () => unreachable("no server answered at this address");
    const app = await onForm(fake);
    app.chooseFolder("/work/acme-corp");
    const html = body(app);

    expect(html).toMatch(
      /with this server's own fleet data, not in the\s+workspace\s+folder/,
    );
    expect(html).not.toContain("/targets/");
  });
});

/**
 * The two refusals an operator has to be able to walk out of.
 *
 * Both were dead ends. `invalid_name` landed on the folder refusal, which disables Create,
 * so the field that would have fixed it was inert; and the folder refusal's own exit —
 * the picker — handed back the folder that had just been refused when the operator typed
 * a path rather than clicking a row. These drive the exits instead of asserting states:
 * every state involved was already right on its own.
 */
describe("getting out of a refusal", () => {
  test("a name refusal talks about the name, and leaves Create pressable", async () => {
    const html = await refusedBody(
      new TargetRefused({
        reason: "invalid_name",
        targetId: "",
        detail:
          "A target's name becomes a directory name: it needs at least one letter or digit, and only a-z, 0-9, '-' and '_' are kept",
      }),
    );

    expect(html).toContain("That name cannot be used");
    expect(html).toContain("Edit the name above");
    // Not three statements about the folder for a fault in the name.
    expect(html).not.toContain("That folder cannot be used");
    expect(html).not.toContain("grant access");
    // The one field that can fix this is usable, and so is the button beside it.
    expect(createEnabled(html)).toBe(true);
  });

  test("a folder the server cannot read offers the picker rather than nothing", async () => {
    const fake = new FakeServer();
    fake.onCreateTarget = () =>
      refused(
        new PathRefused({
          reason: "denied",
          path: "/work/locked",
          detail: "the server has no permission to read that folder",
        }),
      );
    const app = await onForm(fake);
    app.chooseFolder("/work/locked");
    await app.createTarget();
    const html = body(app);

    expect(html).toContain("That folder cannot be used");
    // Create is disabled here, so the alert must carry the way out itself — a button, not
    // a sentence describing one.
    expect(createEnabled(html)).toBe(false);
    expect(buttonLabelled(html, "Choose another folder")).toBe(true);
  });

  test("a path typed into the picker leaves a form that can be submitted", async () => {
    const fake = new FakeServer();
    fake.onCreateTarget = () =>
      refused(
        new TargetRefused({
          reason: "workspace_contains_fleet_root",
          targetId: "work",
          detail: DETAIL,
        }),
      );
    const app = await onForm(fake);
    app.chooseFolder("/work");
    await app.createTarget();
    expect(createEnabled(body(app))).toBe(false);

    // "Choose another folder", then the Path field, then "Use this folder" — the only
    // sequence the refusal offers.
    app.openFolderPicker();
    await settle();
    fake.onFolders = () =>
      ok(
        folderListing({
          path: "/work/hunts/acme",
          parent: "/work/hunts",
          entries: [],
        }),
      );
    await app.browseTo("/work/hunts/acme");
    app.useChosenFolder();
    const html = body(app);

    // The folder the operator typed, on the form, with the refusal gone and the primary
    // button live. Before, all three were the opposite.
    expect(html).toContain("/work/hunts/acme");
    expect(html).not.toContain("That folder cannot hold a target");
    expect(createEnabled(html)).toBe(true);
  });
});
