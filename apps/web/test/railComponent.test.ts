/**
 * What the rail inside an open target says it has counted.
 *
 * `App.navCount` is the only source of a number there, and it fell back to the figures in
 * `mock.ts` for every section nothing had read. So a target created a moment earlier, with
 * an empty database, showed `Findings 2`, `Evidence 9`, `Workers 2` and `Blockers 1` — in
 * the same rail as Goals, Observations and Assets, which had been read from that target's
 * own file. Invented numbers are not merely noise beside real ones: they are the reason
 * the real ones stop being believed.
 *
 * Rendered rather than asserted on `navCount`, because the badge is the claim: a count of
 * `undefined` must leave *nothing* on the row, and that is the component's decision.
 *
 * Server-rendered, so no `$effect` runs; the division is the one `assetsComponent.test.ts`
 * records.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import Sidebar from "../src/lib/components/Sidebar.svelte";
import { App } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import { FakeServer, ok, targetSummary, targetView } from "./fakeServer";

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** The badge text on one rail row, or `undefined` when the row carries none. */
const badge = (html: string, item: string): string | undefined => {
  const row = new RegExp(
    `<button[^>]*data-item="${item}"[\\s\\S]*?</button>`,
  ).exec(html);
  if (row === null) throw new Error(`no rail row for '${item}'`);
  return /class="count[^"]*"[^>]*>([\s\S]*?)</.exec(row[0])?.[1]?.trim();
};

/** Signs in and opens a target whose database is empty, which is a new target. */
const railOfEmptyTarget = async (): Promise<string> => {
  const fake = new FakeServer();
  const summary = targetSummary({ id: "fresh", name: "fresh" });
  fake.onTargets = () => ok([summary]);
  fake.onTarget = () =>
    ok(
      targetView(summary, {
        goals: 0,
        intents: 0,
        attempts: 0,
        observations: 0,
        assets: 0,
        events: 0,
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("fresh");
  await settle();
  return render(Sidebar, { props: { app } }).body;
};

describe("the rail of a target with nothing in it", () => {
  test("shows the zeroes it read and no number at all for the rest", async () => {
    const html = await railOfEmptyTarget();

    // Read from this target's own file, and zero is a real answer.
    expect(badge(html, "goals")).toBe("0");
    expect(badge(html, "observations")).toBe("0");
    expect(badge(html, "assets")).toBe("0");

    // Nothing has counted these. The prototype's figures used to be shown here.
    expect(badge(html, "findings")).toBeUndefined();
    expect(badge(html, "evidence")).toBeUndefined();
    expect(badge(html, "workers")).toBeUndefined();
    expect(badge(html, "blockers")).toBeUndefined();
  });
});
