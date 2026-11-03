/**
 * A link to an attempt transcript, from the path to the words on the screen.
 *
 * `/t/<targetId>/attempts/<attemptId>` is the one row of the addressable inventory that is
 * **inbound only** (design decision 1): the resource is named rather than the rail it is
 * reached through, and nothing in the app produces such a link, because Workers lists no
 * attempts to click. So the only test of it is this one — a path, replayed, and a transcript
 * on screen afterwards.
 *
 * It is a DOM test rather than a line in `place.test.ts` because the part that was missing
 * was not the replay. `applyPlace` already set the rail to Workers and read the transcript;
 * what no screen did was *show* it, since the transcript panel was mounted on Goals alone and
 * only for the attempt this tab had started. A state assertion passes either way, which is
 * why this one renders.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { App } from "../../src/lib/app.svelte";
import Target from "../../src/lib/screens/Target.svelte";
import { applyPlace, parsePath, pathOf, placeOf } from "../../src/lib/place";
import { FakeCountdown } from "../fakeCountdown";
import { FakeServer, attemptTranscript, ok } from "../fakeServer";
import { mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
});

const T = "acme-corp";
const ATTEMPT = "att_7";
const LINK = "/t/acme-corp/attempts/att_7";

const text = (): string =>
  (document.body.textContent ?? "").replace(/\s+/g, " ");

/** The app signed in, with the shell up, and the server answering about one transcript. */
const arrived = async (): Promise<App> => {
  const fake = new FakeServer();
  fake.onTranscript = () =>
    ok(
      attemptTranscript({
        source: "harness",
        ephemeral: true,
        note: "From OpenCode, which may delete it.",
        entries: [{ index: 0, type: "assistant", text: "read the login form" }],
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  mounted.push(mountInto(Target, { app }));
  await settle();
  // What the route does with a held place once there is a session: parse, and apply.
  applyPlace(app, parsePath(LINK));
  await settle();
  return app;
};

describe("a link to an attempt transcript", () => {
  test("opens that transcript, on the section the path replays onto", async () => {
    const app = await arrived();

    expect(app.viewTargetId).toBe(T);
    // The one place the grammar is not uniform: `attempts` is a resource collection, so
    // the rail is set here and the path never says so.
    expect(app.navItem).toBe("workers");
    expect(app.transcriptAttemptId).toBe(ATTEMPT);
    // And the transcript is on the screen, which is the part the state cannot say.
    expect(text()).toContain(ATTEMPT);
    expect(text()).toContain("read the login form");
    expect(text()).toContain("From the harness, may be gone");
  });

  test("keeps the address it was opened with, so a reload lands again", async () => {
    const app = await arrived();
    // The reflection the route writes from. It emits this path exactly when an attempt's
    // transcript is what is on screen on Workers — which, after this arrival, it is.
    expect(pathOf(placeOf(app))).toBe(LINK);
  });

  test("an attempt nobody linked to draws no panel on Workers", async () => {
    // The usual case: the section is a placeholder and nothing has read a transcript, so
    // there is nothing to show and nothing is drawn.
    const app = new App(new FakeServer(), new FakeCountdown());
    app.password = "correct-horse";
    await app.connect();
    app.openTarget(T);
    await settle();
    app.toSection("workers");
    mounted.push(mountInto(Target, { app }));
    await settle();

    expect(
      document.querySelector("[aria-label='Attempt transcript']"),
    ).toBeNull();
    expect(pathOf(placeOf(app))).toBe("/t/acme-corp/workers");
  });
});
