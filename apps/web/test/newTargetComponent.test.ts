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

import { TargetRefused } from "@bit/contracts";

import NewTarget from "../src/lib/screens/NewTarget.svelte";
import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import { FakeServer, refused } from "./fakeServer";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const DETAIL =
  "/work contains this server's fleet root /work/.runtime/hunt, so this target's own directory /work/.runtime/hunt/targets/bit-demo would sit inside the folder where its workers run. Pick a folder outside /work/.runtime/hunt, or restart this server with HUNT_ROOT set outside the folder you want to use";

/** Drives the real `App` to the refusal, then renders the screen it leaves up. */
const refusedBody = async (error: TargetRefused): Promise<string> => {
  const fake = new FakeServer();
  fake.onCreateTarget = () => refused(error);
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openNewTarget();
  await settle();
  app.chooseFolder("/work");
  await app.createTarget();
  return render(NewTarget, { props: { app } }).body;
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
    expect(html).toContain("Choose another folder");
    // Not the duplicate's offer: `bit-demo` was never registered, so there is nothing to
    // open. This is what the old "duplicate unless invalid_name" mapping would have shown.
    expect(html).not.toContain("Already a target");
    expect(html).not.toContain("Open bit-demo");
    // Nor the readable-folder advice: granting access cannot fix a layout.
    expect(html).not.toContain("grant access");
  });
});
