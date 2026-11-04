/**
 * What {@link App} does, against a control plane that is not there.
 *
 * These are tests of the *state machine*, not of the screens. Nothing here renders a
 * component, looks at an element or needs a DOM — every assertion is about a field the
 * screens read, and the screens reading them correctly is a separate tier with a
 * separate harness. The division is deliberate rather than incidental: everything below
 * has been verified by one person driving a browser by hand up to now, and a browser is
 * the slowest possible way to find out that a 401 on the probe lands in the wrong state.
 *
 * **Runes in a `bun test` process.** `app.svelte.ts` is a compiler input, so it is
 * compiled on the way in — see `test/runes.ts`, preloaded by `bunfig.toml`. The module
 * under test is the module that ships.
 *
 * **Every test owns its own `App` and its own double**, built by {@link open} below.
 * A shared one would make the stale-row tests depend on the order they run in, which is
 * exactly the kind of result that is worse than no test at all.
 */
import { describe, expect, test } from "bun:test";
import {
  GoalBriefingRefused,
  GoalConversationRefused,
  GoalNotFound,
  GoalRefused,
  IntentRefused,
  LIVE_SILENCE_LIMIT_SECONDS,
  PathRefused,
  PlanRefused,
  RunRefused,
  SessionRefused,
  TargetNotFound,
  TargetRefused,
  TargetUnavailable,
  Unauthenticated,
  type LiveUsage,
} from "@bit/contracts";

import { App, fromSummary } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import {
  AT,
  FakeServer,
  attemptTranscript,
  folderListing,
  goalBriefingView,
  goalConversationView,
  goalNarrationView,
  goalTurnAccepted,
  goalView,
  harnessInstance,
  intentView,
  liveActivity,
  liveCursor,
  liveItem,
  liveOpened,
  livePlannerCall,
  ok,
  planRoundStarted,
  planRoundView,
  refused,
  roundNarration,
  runStarted,
  runningAttempt,
  runningRound,
  sessionProbe,
  targetCreated,
  targetSummary,
  targetView,
  unreachable,
  replayItem,
} from "./fakeServer";

/** A chat group's rows that the server's replay brought (A6 F10): `replay:` ids. */
const replayedRows = (
  group: { readonly rows: readonly { readonly key: string }[] } | undefined,
) => (group?.rows ?? []).filter((row) => row.key.startsWith("replay:"));

/** A chat group's rows from this tab's own feed, everything the replay did not bring. */
const liveRows = <Row extends { readonly key: string }>(
  group: { readonly rows: readonly Row[] } | undefined,
): Row[] => (group?.rows ?? []).filter((row) => !row.key.startsWith("replay:"));

/**
 * Lets everything already in flight finish.
 *
 * `openTarget` is deliberately fire-and-forget — the screen switches first and the
 * counts follow, so the frame is up while the request is going — which means a test has
 * to wait for work it was not handed a promise for. A macrotask drains the whole
 * microtask queue behind it, so this says "let the open settle" without a test having to
 * know how many awaits deep the client happens to be.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An app, the double it talks to, and the schedule it arms timers on.
 *
 * The third is new and only one thing uses it — the live transcript's silence watchdog —
 * but it is handed to every instance so that a test which does not care about timers still
 * cannot accidentally arm a real forty-second one.
 */
const open = (): { app: App; fake: FakeServer; clock: FakeCountdown } => {
  const fake = new FakeServer();
  const clock = new FakeCountdown();
  return { app: new App(fake, clock), fake, clock };
};

/**
 * Signs in and lands on the target rail, so a test about something later can start
 * there.
 *
 * It goes through `connect()` rather than assigning `screen = "welcome"`, because
 * several of the things under test downstream — the harness list, the token, the rail —
 * are things `connect()` puts in place, and a test that set the screen by hand would be
 * testing against a state the app never actually reaches.
 */
const signIn = async (app: App): Promise<void> => {
  app.password = "correct-horse";
  await app.connect();
};

/* ── Connect ─────────────────────────────────────────────────────────────────── */

describe("connect", () => {
  /**
   * The division the typed refusal exists for. A wrong password is an *answer*, and it
   * belongs on the password field; the Connect screen renders the two against different
   * inputs, so getting this wrong attaches a reason to the wrong thing.
   */
  test("a refused password is a refusal, against the password field", async () => {
    const { app, fake } = open();
    fake.onOpenSession = () =>
      refused(
        new SessionRefused({
          reason: "invalid_password",
          detail: "that is not the password this server printed",
        }),
      );

    app.password = "wrong";
    await app.connect();

    expect(app.connectError).toBe("password");
    expect(app.screen).toBe("connect");
    // Cleared, so the field is not sitting there inviting a second submit of the same
    // thing — and so nothing claims a session was created.
    expect(app.password).toBe("");
    expect(fake.token).toBeUndefined();
    expect(fake.countOf("setToken")).toBe(0);
  });

  test("a transport failure is unreachable, against the URL field", async () => {
    const { app, fake } = open();
    fake.onOpenSession = () => unreachable("Failed to fetch");

    app.serverUrl = "http://127.0.0.1:9999";
    app.password = "correct-horse";
    await app.connect();

    expect(app.connectError).toBe("unreachable");
    expect(app.connectDetail).toBe("Failed to fetch");
    expect(app.screen).toBe("connect");
    // Kept, unlike the refusal above: the password was never judged, so re-submitting
    // the same one once the server is up is the right next move.
    expect(app.password).toBe("correct-horse");
    expect(fake.token).toBeUndefined();
  });

  test("a session opens, and the rail and the harness list come with it", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onHarnesses = () =>
      ok([harnessInstance({ instanceId: "claude-code" })]);

    await signIn(app);

    expect(app.screen).toBe("welcome");
    expect(app.connectError).toBe("none");
    expect(fake.token).toBe("token-1");
    expect(app.targets.map((target) => target.id)).toEqual(["acme-corp"]);
    expect(app.anyHarnessReady).toBe(true);
    expect(app.effectiveModel).toBe("claude-sonnet-5");
  });

  test("an empty password asks the server nothing", async () => {
    const { app, fake } = open();
    await app.connect();
    expect(fake.countOf("openSession")).toBe(0);
    expect(app.connectError).toBe("none");
  });
});

/* ── Resuming a session ──────────────────────────────────────────────────────── */

describe("restore", () => {
  test("a probe that succeeds resumes the session", async () => {
    const { app, fake } = open();
    fake.stored = "token-from-a-reload";
    fake.onProbe = () => ok(sessionProbe({ workspaceRoot: "/work" }));
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    await app.restore();

    expect(app.screen).toBe("welcome");
    expect(app.connectError).toBe("none");
    expect(fake.token).toBe("token-from-a-reload");
    expect(app.targets.map((target) => target.id)).toEqual(["acme-corp"]);
    // The probe is the only thing that knows where the folder picker should start.
    expect(app.dialogRoot).toBe("/work");
  });

  /**
   * The server holds its session registry in memory, so a restart invalidates every
   * token and nothing in the browser can know that without asking. The answer is a
   * refusal, and it has to end as "your session ended" rather than as a silent Connect
   * screen.
   */
  test("a probe that is refused returns to Connect as expired", async () => {
    const { app, fake } = open();
    fake.stored = "a-token-from-before-the-restart";
    fake.onProbe = () => refused(new Unauthenticated({ reason: "unknown" }));

    await app.restore();

    expect(app.screen).toBe("connect");
    expect(app.connectError).toBe("expired");
    expect(fake.token).toBeUndefined();
    expect(fake.countOf("targets")).toBe(0);
  });

  /**
   * The asymmetry with the test above, and the reason the two are not one branch: an
   * unreachable server has not said anything about the token, so throwing it away would
   * turn one failed request into a sign-out the operator did not earn.
   */
  test("a probe that cannot reach the server keeps the token", async () => {
    const { app, fake } = open();
    fake.stored = "still-good-for-all-we-know";
    fake.onProbe = () => unreachable("ECONNREFUSED");

    await app.restore();

    expect(app.screen).toBe("connect");
    expect(app.connectError).toBe("unreachable");
    expect(app.connectDetail).toBe("ECONNREFUSED");
    expect(fake.token).toBe("still-good-for-all-we-know");
  });

  test("nothing stored asks the server nothing", async () => {
    const { app, fake } = open();
    await app.restore();
    expect(fake.countOf("probe")).toBe(0);
    expect(app.screen).toBe("connect");
  });
});

/* ── The target rail ─────────────────────────────────────────────────────────── */

describe("targets", () => {
  test("the rail is what the registry holds", async () => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([
        targetSummary({
          id: "acme-corp",
          name: "acme-corp",
          scopeNote: "*.acme.test",
          workspacePath: "/work/acme-corp",
        }),
        targetSummary({
          id: "scratch",
          name: "scratch",
          scopeNote: "",
          // No workspace: the row falls back to the data directory it was given.
          workspacePath: null,
          dataDirectory: "/fleet/scratch",
        }),
      ]);

    await signIn(app);

    expect(app.targets.map((target) => target.id)).toEqual([
      "acme-corp",
      "scratch",
    ]);
    expect(app.targets[0]?.path).toBe("/work/acme-corp");
    expect(app.targets[1]?.path).toBe("/fleet/scratch");
    // An empty scope note is shown as a dash rather than as blank space.
    expect(app.targets[1]?.scope).toBe("—");
    // The first row is selected so the rail is never pointing at nothing.
    expect(app.selectedId).toBe("acme-corp");
  });

  /**
   * The rail's whole job in the partial-failure policy: one target whose file will not
   * open stays visible, dimmed, carrying the server's own sentence. A row that vanished
   * would leave the operator with nothing to act on and no way to find out why.
   */
  test("an unavailable target stays listed, with the server's own sentence", async () => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([
        targetSummary({
          id: "internal-api",
          available: false,
          unavailableReason: "folder_missing",
          detail: "the workspace folder /work/internal-api is gone",
        }),
      ]);

    await signIn(app);

    expect(app.targets).toHaveLength(1);
    expect(app.targets[0]?.status).toBe("missing");
    expect(app.targets[0]?.detail).toBe(
      "the workspace folder /work/internal-api is gone",
    );
  });

  /**
   * The same distinction one level down. `TargetUnavailable` is about *this* target, so
   * the answer is shown on this target's header; bouncing to the list would answer a
   * question the operator did not ask.
   */
  test("opening an unavailable target stays on it and says why", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "internal-api" })]);
    fake.onTarget = () =>
      refused(
        new TargetUnavailable({
          reason: "database_missing",
          targetId: "internal-api",
          detail: "hunt.sqlite is not where the registry says it is",
        }),
      );

    await signIn(app);
    app.openTarget("internal-api");
    await settle();

    expect(app.screen).toBe("target");
    expect(app.viewState).toBe("unavailable");
    expect(app.viewDetail).toBe(
      "hunt.sqlite is not where the registry says it is",
    );
  });

  test("a target the server does not have lands back on the list", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onTarget = () =>
      refused(
        new TargetNotFound({
          reason: "unknown_target",
          targetId: "ghost",
          detail: "no target 'ghost' is registered",
        }),
      );

    await signIn(app);
    // Through the navigation, because a refresh of a target that is not in view does
    // nothing at all now — a stale link is something the operator *opens*.
    app.openTarget("ghost");
    await settle();

    expect(app.screen).toBe("welcome");
    expect(app.viewState).toBe("empty");
  });

  test("a coarse relative time, from a clock the caller supplies", () => {
    const row = (ago: number) =>
      fromSummary(targetSummary({ lastActivityAt: AT - ago }), AT).lastActivity;
    expect(row(0)).toBe("now");
    expect(row(5 * 60_000)).toBe("5m");
    expect(row(3 * 3_600_000)).toBe("3h");
    expect(row(6 * 86_400_000)).toBe("6d");
  });
});

/* ── The New target screen ───────────────────────────────────────────────────── */

describe("new target", () => {
  /** Walks the page to the point where `createTarget()` will do something. */
  const choose = async (app: App, path: string): Promise<void> => {
    await signIn(app);
    app.openNewTarget();
    await settle();
    app.chooseFolder(path);
  };

  test("a folder that is already a target offers the one holding it", async () => {
    const { app, fake } = open();
    fake.onCreateTarget = () =>
      refused(
        new TargetRefused({
          reason: "duplicate_workspace",
          targetId: "acme-corp",
          detail: "/work/acme-corp is already registered as 'acme-corp'",
        }),
      );

    await choose(app, "/work/acme-corp");
    await app.createTarget();

    expect(app.createState).toBe("duplicate");
    expect(app.duplicateOf).toBe("acme-corp");
    expect(app.createDetail).toBe(
      "/work/acme-corp is already registered as 'acme-corp'",
    );
    // The page stays up: there is an offer on it to accept.
    expect(app.screen).toBe("new-target");
  });

  test("a folder the server may not read is denied, in its words", async () => {
    const { app, fake } = open();
    fake.onCreateTarget = () =>
      refused(
        new PathRefused({
          reason: "denied",
          path: "/work/locked",
          detail: "the server has no permission to read that folder",
        }),
      );

    await choose(app, "/work/locked");
    await app.createTarget();

    expect(app.createState).toBe("denied");
    expect(app.createDetail).toBe(
      "the server has no permission to read that folder",
    );
  });

  /**
   * The refusal the operator could not have predicted from the picker.
   *
   * Its own state because the two neighbouring ones are both wrong for it. "Already a
   * target" would offer to open an id nobody registered — which is what the previous
   * mapping did with any reason it had not heard of, since `duplicate` was its default —
   * and "that folder cannot be read" invites a retry that cannot work: the folder is
   * perfectly readable and still cannot hold a target.
   */
  test("a folder holding the server's own fleet root is unusable, not a duplicate", async () => {
    const { app, fake } = open();
    const detail =
      "/work contains this server's fleet root /work/.runtime/hunt, so this target's own directory /work/.runtime/hunt/targets/demo would sit inside the folder where its workers run";
    fake.onCreateTarget = () =>
      refused(
        new TargetRefused({
          reason: "workspace_contains_fleet_root",
          targetId: "demo",
          detail,
        }),
      );

    await choose(app, "/work");
    await app.createTarget();

    expect(app.createState).toBe("unusable");
    // No offer to open anything: the id in the refusal is the one that was *not* created.
    expect(app.duplicateOf).toBe("");
    expect(app.createDetail).toBe(detail);
    // The page stays up, with the server's sentence on it.
    expect(app.screen).toBe("new-target");
    expect(app.targets).toEqual([]);
  });

  /**
   * A problem with the name is a problem with the name.
   *
   * It used to land on `denied` — "that folder cannot be used", three sentences about the
   * folder for a fault in a different field — and `denied` disables Create, so correcting
   * the name changed nothing the operator could see or press. Both halves are asserted:
   * which state it is, and that editing the name leaves the form usable again.
   */
  test("a name the server will not take is a name refusal, and editing the name clears it", async () => {
    const { app, fake } = open();
    fake.onCreateTarget = () =>
      refused(
        new TargetRefused({
          reason: "invalid_name",
          targetId: "",
          detail: "a target name may not contain a path separator",
        }),
      );

    await choose(app, "/work/odd name");
    await app.createTarget();

    expect(app.createState).toBe("invalid-name");
    expect(app.duplicateOf).toBe("");

    // The field that fixes it is on screen, and touching it withdraws a refusal that was
    // about the string it no longer holds.
    app.dialogName = "odd-name";
    expect(app.createState).toBe("idle");
    expect(app.createDetail).toBe("");
  });

  /**
   * The exit the refusal offers, walked.
   *
   * "Choose another folder" opens the picker; the picker's Path field is a form that
   * navigates on submit; "Use this folder" closes it. Every one of those steps worked and
   * the sequence did not: the picker handed back the folder selected *before* the
   * navigation, which was the refused one, so the form came back unchanged with the
   * refusal still on it and Create still disabled. This drives the sequence rather than
   * asserting the states, because each state was already correct on its own.
   */
  test("typing a path in the picker and using it recovers from a refusal", async () => {
    const { app, fake } = open();
    fake.onCreateTarget = () =>
      refused(
        new TargetRefused({
          reason: "workspace_contains_fleet_root",
          targetId: "work",
          detail: "/work is /work/.runtime/hunt/targets/work or above it",
        }),
      );

    await choose(app, "/work");
    await app.createTarget();
    expect(app.createState).toBe("unusable");

    app.openFolderPicker();
    await settle();
    // What the Path field does on submit, with the server answering about the folder asked
    // for — and not about the one the form is holding.
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

    expect(app.folderPickerOpen).toBe(false);
    expect(app.dialogChosen).toBe("/work/hunts/acme");
    // The name follows the folder, as it does for a row clicked in the list.
    expect(app.dialogName).toBe("acme");
    expect(app.createState).toBe("idle");
    expect(app.createDetail).toBe("");
  });

  /**
   * Cancel means cancel, which is what the picker's own selection buys.
   *
   * The selection and the form's folder were one field, so this could not be asked: every
   * click in the tree edited the form. Now a selection is the modal's, and abandoning it
   * leaves the folder and the name the operator already had.
   */
  /**
   * Confirming the folder that is already there is not an edit.
   *
   * "Use this folder" now always commits, which is what clears a refusal — so it must not
   * also re-propose a name over one the operator has typed, and must not withdraw a
   * refusal that is still true of the folder it is about. Both would be new defects
   * introduced by the fix for the dead end.
   */
  test("using the folder the form already has keeps the name and the refusal", async () => {
    const { app, fake } = open();
    fake.onCreateTarget = () =>
      refused(
        new TargetRefused({
          reason: "workspace_contains_fleet_root",
          targetId: "work",
          detail: "/work is /work/.runtime/hunt/targets/work or above it",
        }),
      );

    await choose(app, "/work");
    app.dialogName = "Acme Corp";
    await app.createTarget();
    expect(app.createState).toBe("unusable");

    app.openFolderPicker();
    await settle();
    app.useChosenFolder();

    expect(app.dialogName).toBe("Acme Corp");
    expect(app.createState).toBe("unusable");
  });

  test("a selection abandoned with Cancel leaves the form's folder alone", async () => {
    const { app } = open();
    await choose(app, "/work/acme-corp");
    app.dialogName = "Acme Corp";

    app.openFolderPicker();
    await settle();
    app.selectFolder("/work/elsewhere");
    app.folderPickerOpen = false;

    expect(app.dialogChosen).toBe("/work/acme-corp");
    expect(app.dialogName).toBe("Acme Corp");
  });

  /**
   * The one that is **not** an error, and the reason this is worth a test of its own.
   * A target whose database will not migrate is still created, recorded and listed —
   * that is the fleet's partial-failure policy — so the dialog learns about it from a
   * *successful* response carrying `available: false`, not from a refusal.
   */
  test("a target that was created but will not open reports the failure", async () => {
    const { app, fake } = open();
    const broken = targetSummary({
      id: "example",
      name: "example",
      available: false,
      unavailableReason: "never_migrated",
      detail: 'migrate failed: Migration "1_delegation_memory_slice" failed',
    });
    fake.onCreateTarget = () => ok(targetCreated({ target: broken }));
    fake.onTargets = () => ok([broken]);

    await choose(app, "/work/example");
    await app.createTarget();

    expect(app.createState).toBe("failed");
    expect(app.createDetail).toBe(
      'migrate failed: Migration "1_delegation_memory_slice" failed',
    );
    // Up, so the operator reads why — and listed, because it does exist.
    expect(app.screen).toBe("new-target");
    expect(app.targets.map((target) => target.id)).toEqual(["example"]);
    expect(app.targets[0]?.status).toBe("missing");
  });

  test("a target that is created appears on the rail and is selected", async () => {
    const { app, fake } = open();
    const created = targetSummary({ id: "example", name: "example" });
    fake.onCreateTarget = () => ok(targetCreated({ target: created }));
    // The rail is re-read rather than appended to locally, so this is what it becomes.
    fake.onTargets = () => ok([created]);

    await choose(app, "/work/example");
    await app.createTarget();

    // No links, so no import: the page is left behind and the target is open.
    expect(app.screen).toBe("target");
    expect(app.createState).toBe("idle");
    expect(app.targets.map((target) => target.id)).toEqual(["example"]);
    expect(app.selectedId).toBe("example");
  });
});

/* ── Runs ────────────────────────────────────────────────────────────────────── */

describe("runs", () => {
  /** Signs in and opens one target, which is where a run can be started from. */
  const onTarget = async (id = "acme-corp"): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id, name: id })]);
    fake.onHarnesses = () => ok([harnessInstance()]);
    await signIn(app);
    app.openTarget(id);
    await settle();
    return [app, fake];
  };

  test("a run that starts hands back an attempt and shows as running", async () => {
    const [app, fake] = await onTarget();
    fake.onStartRun = () =>
      ok(runStarted({ attemptId: "attempt-7", targetId: "acme-corp" }));

    app.runIntentId = "intent-1";
    await app.startRun();

    expect(app.activeRun?.attemptId).toBe("attempt-7");
    // Readable later, which is the only handle this tab keeps on a settled attempt.
    expect(app.readableAttemptId).toBe("attempt-7");
    // Cleared only once the server accepted it.
    expect(app.runIntentId).toBe("");
    expect(app.runDetail).toBe("");
    const started = fake.calls.find((call) => call.method === "startRun");
    // The intent, by id: there is no free text in a run any more.
    expect(started?.args[2]).toBe("intent-1");
    expect(app.starting).toBe(false);
  });

  /**
   * Two of the refusals the run box exists to show. Both are normal answers rather than
   * faults, and in both cases the intent the box is aimed at has to stay aimed at — a box
   * that emptied optimistically would make the operator find their intent again every time.
   */
  test.each([
    ["workspace_busy", "another run is already working in /work/acme-corp"],
    ["harness_not_ready", "Claude Code is configured but not authenticated"],
  ] as const)("a %s refusal surfaces its text", async (reason, detail) => {
    const [app, fake] = await onTarget();
    fake.onStartRun = () => refused(new RunRefused({ reason, detail }));

    app.runIntentId = "intent-1";
    await app.startRun();

    expect(app.runDetail).toBe(detail);
    expect(app.runIntentId).toBe("intent-1");
    expect(app.activeRun).toBeUndefined();
    expect(app.readableAttemptId).toBe("");
  });

  test("a run that stops settles, and the row goes with it", async () => {
    const [app, fake] = await onTarget();
    let settled = false;
    fake.onStartRun = () => ok(runStarted({ attemptId: "attempt-7" }));
    fake.onRuns = () =>
      ok(settled ? [] : [runningAttempt({ attemptId: "attempt-7" })]);
    fake.onStopRun = () => {
      settled = true;
      return ok({
        attemptId: "attempt-7",
        targetId: "acme-corp",
        harnessSessionId: "harness-session-1",
        status: "stopped",
        credentialsRevoked: 1,
        stoppedAt: AT,
      });
    };

    app.runIntentId = "intent-1";
    await app.startRun();
    expect(app.activeRun?.attemptId).toBe("attempt-7");

    await app.stopRun();

    expect(app.activeRun).toBeUndefined();
    expect(app.stopping).toBe(false);
    expect(app.runDetail).toBe("");
  });

  /**
   * The likeliest refusal of a stop is `unknown_attempt`: this tab was holding a run the
   * server has already finished. Saying so is not enough — the stale row has to go, or
   * the screen keeps offering to stop something that is over.
   */
  test("a stop the server does not recognise says so and drops the row", async () => {
    const [app, fake] = await onTarget();
    fake.onStartRun = () => ok(runStarted({ attemptId: "attempt-7" }));
    let started = false;
    fake.onRuns = () =>
      ok(started ? [] : [runningAttempt({ attemptId: "attempt-7" })]);
    fake.onStopRun = () => {
      started = true;
      return refused(
        new RunRefused({
          reason: "unknown_attempt",
          detail: "that attempt is not running",
        }),
      );
    };

    app.runIntentId = "intent-1";
    await app.startRun();
    await app.stopRun();

    expect(app.runDetail).toBe("that attempt is not running");
    expect(app.activeRun).toBeUndefined();
  });
});

/* ── Intents ─────────────────────────────────────────────────────────────────── */

describe("intents", () => {
  /** Signs in, opens a target holding one goal, and opens that goal. */
  const onGoal = async (
    held: Parameters<typeof intentView>[0][] = [],
    goal: Parameters<typeof goalView>[0] = {},
  ): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onHarnesses = () => ok([harnessInstance()]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1", ...goal })] });
    fake.onIntents = (_baseUrl, _targetId, goalId) =>
      ok({ intents: held.map((over) => intentView({ goalId, ...over })) });
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    return [app, fake];
  };

  test("opening a goal reads its intents, and only that goal's", async () => {
    const [app, fake] = await onGoal([
      { intentId: "intent-a" },
      { intentId: "intent-b", status: "claimed", claimedByAttemptId: "att-1" },
    ]);
    expect(app.intentsState).toBe("ready");
    expect(app.intents.map((intent) => intent.intentId)).toEqual([
      "intent-a",
      "intent-b",
    ]);
    expect(app.intentsGoalId).toBe("goal_1");
    expect(fake.calls.find((call) => call.method === "intents")?.args).toEqual([
      expect.any(String),
      "acme-corp",
      "goal_1",
    ]);

    // Leaving the goal leaves its intents behind, so another goal's heading is never over
    // them.
    app.closeGoal();
    expect(app.intents).toEqual([]);
    expect(app.intentsGoalId).toBe("");
  });

  test("an answer for a goal the operator has left is dropped", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({
        goals: [
          goalView({ targetId, goalId: "goal_1" }),
          goalView({ targetId, goalId: "goal_2" }),
        ],
      });
    fake.onIntents = (_baseUrl, _targetId, goalId) =>
      ok({
        intents: [intentView({ goalId, intentId: `intent_of_${goalId}` })],
      });
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    const release = fake.hold("intents");
    app.openGoal("goal_1");
    app.openGoal("goal_2");
    release();
    await settle();
    expect(app.intents.map((intent) => intent.intentId)).toEqual([
      "intent_of_goal_2",
    ]);
  });

  test("a failed read says so, in the server's words", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = () => ok({ goals: [goalView()] });
    fake.onIntents = () =>
      refused(
        new GoalNotFound({
          targetId: "acme-corp",
          goalId: "goal_1",
          detail: "no goal 'goal_1' is recorded in this target",
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    expect(app.intentsState).toBe("failed");
    expect(app.intentsDetail).toContain("no goal 'goal_1'");
  });

  test("adding an intent sends the question trimmed with its anchors and dimension, and no id", async () => {
    const [app, fake] = await onGoal();
    app.openIntentForm();
    app.intentQuestion = "  Is rollover measured?  ";
    app.toggleAnchor("obs_1");
    app.toggleAnchor("obs_2");
    app.toggleAnchor("obs_1");
    app.intentDimension = "obs_2#u0";
    await app.createIntent();

    const sent = fake.calls.find((call) => call.method === "createIntent");
    expect(sent?.args[3]).toEqual({
      question: "Is rollover measured?",
      anchorObservationIds: ["obs_2"],
      addressesDimension: "obs_2#u0",
    });
    // The row is on screen at once and the form is closed and empty.
    expect(app.intents.map((intent) => intent.question)).toEqual([
      "Is rollover measured?",
    ]);
    expect(app.intentFormOpen).toBe(false);
    expect(app.intentQuestion).toBe("");
    expect(app.intentAnchors).toEqual([]);
  });

  test("no dimension is sent as null, not as an empty string", async () => {
    const [app, fake] = await onGoal();
    app.openIntentForm();
    app.intentQuestion = "q";
    await app.createIntent();
    expect(
      (
        fake.calls.find((call) => call.method === "createIntent")?.args[3] as {
          addressesDimension: unknown;
        }
      ).addressesDimension,
    ).toBeNull();
  });

  test("a blank question asks the server nothing and keeps the form open", async () => {
    const [app, fake] = await onGoal();
    app.openIntentForm();
    app.intentQuestion = "   ";
    await app.createIntent();
    expect(fake.countOf("createIntent")).toBe(0);
    expect(app.intentFormOpen).toBe(true);
    expect(app.intentCreateDetail).toContain("needs a question");
  });

  test("an anchoring refusal is shown as the server wrote it, and nothing typed is lost", async () => {
    const [app, fake] = await onGoal();
    const sentence =
      "anchor 'intent-1' is an intent and cannot anchor an intent. Leave anchorObservationIds empty for a new top-level direction.";
    fake.onCreateIntent = () =>
      refused(new IntentRefused({ reason: "invalid", detail: sentence }));
    app.openIntentForm();
    app.intentQuestion = "Follow up?";
    app.toggleAnchor("intent-1");
    await app.createIntent();

    // Verbatim: the sentence is the instruction.
    expect(app.intentCreateDetail).toBe(sentence);
    expect(app.intentFormOpen).toBe(true);
    expect(app.intentQuestion).toBe("Follow up?");
    expect(app.intentAnchors).toEqual(["intent-1"]);
    expect(app.intents).toEqual([]);
    expect(app.intentCreating).toBe(false);
  });

  test("the form offers the goal's observations as anchors when it opens", async () => {
    const [app, fake] = await onGoal();
    fake.onGoalObservations = () =>
      ok({
        observations: [
          {
            observationId: "obs_1",
            intentId: "intent-1",
            testedClaim: "The limiter resets per window.",
            outcome: "positive",
            untestedDimensions: [{ address: "obs_1#u0", text: "rollover" }],
          },
        ],
      });
    app.openIntentForm();
    await settle();
    expect(app.goalObservationsState).toBe("ready");
    expect(app.goalObservations.map((entry) => entry.observationId)).toEqual([
      "obs_1",
    ]);
  });

  test("abandoning asks first: nothing is sent until it is confirmed, and the reason goes with it", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    app.openIntentAbandon("intent-a");
    expect(app.intentAbandonOpenId).toBe("intent-a");
    // Opening the confirmation is not the act.
    expect(fake.countOf("abandonIntent")).toBe(0);

    app.intentAbandonReason = "  Out of scope.  ";
    await app.abandonIntent("intent-a");

    const sent = fake.calls.find((call) => call.method === "abandonIntent");
    expect(sent?.args[2]).toBe("intent-a");
    expect(sent?.args[3]).toEqual({ reason: "Out of scope." });
    expect(app.intents.map((intent) => intent.status)).toEqual(["abandoned"]);
    // Closed and cleared, so the next one does not inherit this one's reason.
    expect(app.intentAbandonOpenId).toBe("");
    expect(app.intentAbandonReason).toBe("");
  });

  test("cancelling the confirmation sends nothing and forgets the reason", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    app.openIntentAbandon("intent-a");
    app.intentAbandonReason = "changed my mind";
    app.cancelIntentAbandon();
    expect(app.intentAbandonOpenId).toBe("");
    expect(app.intentAbandonReason).toBe("");
    expect(fake.countOf("abandonIntent")).toBe(0);
    // And opening another starts with an empty reason.
    app.openIntentAbandon("intent-a");
    expect(app.intentAbandonReason).toBe("");
  });

  test("an abandon with no reason typed sends an empty one, which is none given", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    app.openIntentAbandon("intent-a");
    await app.abandonIntent("intent-a");
    expect(
      fake.calls.find((call) => call.method === "abandonIntent")?.args[3],
    ).toEqual({ reason: "" });
  });

  test("a refused abandon is shown against that intent, closes the confirmation, and re-reads the list", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    fake.onAbandonIntent = () =>
      refused(
        new IntentRefused({
          reason: "not_abandonable",
          detail: "intent intent-a is claimed: attempt att-9 is running it",
        }),
      );
    app.openIntentAbandon("intent-a");
    const before = fake.countOf("intents");
    await app.abandonIntent("intent-a");
    expect(app.intentAbandonDetailId).toBe("intent-a");
    expect(app.intentAbandonDetail).toContain("att-9");
    expect(app.intentAbandonOpenId).toBe("");
    // The likeliest cause is another tab having started it, so the row is re-read.
    expect(fake.countOf("intents")).toBe(before + 1);
  });

  test("a run starts from the intent aimed at, which is then cleared and re-read as claimed", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    app.chooseRun("intent-a");
    expect(app.runIntent?.intentId).toBe("intent-a");
    fake.onStartRun = () =>
      ok(runStarted({ attemptId: "attempt-7", intentId: "intent-a" }));
    const before = fake.countOf("intents");

    await app.startRun();

    expect(fake.calls.find((call) => call.method === "startRun")?.args[2]).toBe(
      "intent-a",
    );
    expect(app.runIntentId).toBe("");
    expect(app.activeRun?.attemptId).toBe("attempt-7");
    // The row has to stop offering a run: it is claimed now, and only the server knows.
    expect(fake.countOf("intents")).toBe(before + 1);
  });

  test("a start with nothing aimed at asks the server nothing", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    await app.startRun();
    expect(fake.countOf("startRun")).toBe(0);
  });

  test("a refused run keeps the intent aimed at, shows the reason, and re-reads the list", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    fake.onStartRun = () =>
      refused(
        new RunRefused({
          reason: "intent_not_open",
          detail:
            "intent intent-a cannot be claimed: it is claimed by attempt att-3",
        }),
      );
    app.chooseRun("intent-a");
    const before = fake.countOf("intents");
    await app.startRun();
    expect(app.runDetail).toContain("att-3");
    expect(app.runIntentId).toBe("intent-a");
    expect(fake.countOf("intents")).toBe(before + 1);
  });

  test("a suggestion that could not be honoured is reported with where the run went", async () => {
    const [app, fake] = await onGoal([{ intentId: "intent-a" }]);
    fake.onStartRun = () =>
      ok(
        runStarted({
          attemptId: "attempt-7",
          instanceId: "opencode",
          instanceFallback: {
            requested: "claude-code",
            reason: "claude-code is configured but would not start",
          },
        }),
      );
    app.chooseRun("intent-a");
    await app.startRun();
    expect(app.runFallback).toEqual({
      requested: "claude-code",
      reason: "claude-code is configured but would not start",
      ranOn: "opencode",
    });
    // And a run that needed no fallback says nothing.
    app.chooseRun("intent-a");
    fake.onStartRun = () => ok(runStarted({ attemptId: "attempt-8" }));
    await app.startRun();
    expect(app.runFallback).toBeNull();
  });

  test("the run box is aimed at an intent of the goal on screen and no other", async () => {
    const [app] = await onGoal([{ intentId: "intent-a" }]);
    app.chooseRun("intent-a");
    app.closeGoal();
    expect(app.runIntentId).toBe("");
    expect(app.runIntent).toBeUndefined();
  });

  test("the record saying a run settled re-reads the intents, but only once history has arrived", async () => {
    const [, fake] = await onGoal([{ intentId: "intent-a" }]);
    // History replays on opening: none of it may cause a request per item.
    fake.watch.send(liveOpened({ from: 0, latest: 2 }));
    fake.watch.send(
      liveItem({ id: "record:e1", sequence: 1, kind: "run.settled" }),
    );
    expect(fake.countOf("intents")).toBe(1);

    fake.watch.send(liveCursor({ sequence: 1, caughtUp: true }));
    const before = fake.countOf("intents");
    fake.watch.send(
      liveItem({ id: "record:e2", sequence: 2, kind: "run.settled" }),
    );
    await settle();
    expect(fake.countOf("intents")).toBe(before + 1);

    // An unrelated record does not.
    fake.watch.send(
      liveItem({ id: "record:e3", sequence: 3, kind: "observation.recorded" }),
    );
    await settle();
    expect(fake.countOf("intents")).toBe(before + 1);
  });
});

/* ── Refreshing is not navigating ────────────────────────────────────────────── */

/**
 * A run finishing its round trip must not move the operator.
 *
 * `startRun` and `stopRun` both refresh the target's counts at their tails, because a
 * run writes rows before it is answered. The refresh used to be the same method that
 * navigates, so it assigned `viewTargetId` on the way in — and a round trip is long
 * enough for the operator to have clicked something else. The header's own guard held,
 * so no wrong numbers were ever rendered; what moved was everything keyed off
 * `viewTargetId` that has no second guard. The composer would show the *other* target's
 * run as running, offer its transcript, and aim Stop at its attempt, all while a
 * different target was on screen.
 *
 * That is misattribution at the UI layer, which is the thing this product is built
 * against, so both call sites are pinned here rather than just the one that is easier to
 * provoke.
 */
describe("goals", () => {
  /** Signs in and opens one target, with the goals the server is told to hold. */
  const onTarget = async (
    held: Parameters<typeof goalView>[0][] = [],
    id = "acme-corp",
  ): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id, name: id })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: held.map((over) => goalView({ targetId, ...over })) });
    await signIn(app);
    app.openTarget(id);
    await settle();
    return [app, fake];
  };

  test("opening a target lands on Goals and reads that target's goals", async () => {
    const [app, fake] = await onTarget([
      { goalId: "goal_a", name: "Auth" },
      { goalId: "goal_b" },
    ]);
    expect(app.navItem).toBe("goals");
    expect(app.goalsState).toBe("ready");
    expect(app.goals.map((goal) => goal.goalId)).toEqual(["goal_a", "goal_b"]);
    expect(app.goalsTargetId).toBe("acme-corp");
    // The sidebar's number is the list's length, not the intent count it used to borrow.
    expect(app.goalCount).toBe(2);
    expect(fake.countOf("goals")).toBe(1);
  });

  test("a target with no goals is an empty ready list, not a loading one", async () => {
    const [app] = await onTarget([]);
    expect(app.goalsState).toBe("ready");
    expect(app.goals).toEqual([]);
    expect(app.goalCount).toBe(0);
  });

  test("a failed read says so and keeps the sentence", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = () =>
      refused(
        new TargetUnavailable({
          reason: "database_missing",
          targetId: "acme-corp",
          detail: "hunt.sqlite is not there",
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    expect(app.goalsState).toBe("failed");
    expect(app.goalsDetail).toBe("hunt.sqlite is not there");
  });

  test("another target's goals are cleared before the new answer, and never shown under it", async () => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([targetSummary({ id: "alpha" }), targetSummary({ id: "beta" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({
        goals: [goalView({ targetId, goalId: `goal_of_${targetId}` })],
      });
    await signIn(app);
    app.openTarget("alpha");
    await settle();
    expect(app.goals.map((goal) => goal.goalId)).toEqual(["goal_of_alpha"]);

    const release = fake.hold("goals");
    app.openTarget("beta");
    // Between the two answers there is nothing of alpha's on screen.
    expect(app.goals).toEqual([]);
    expect(app.goalCount).not.toBe(1);
    release();
    await settle();
    expect(app.goals.map((goal) => goal.goalId)).toEqual(["goal_of_beta"]);
    expect(app.goalsTargetId).toBe("beta");
  });

  test("an answer for a target the operator has left is dropped", async () => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([targetSummary({ id: "alpha" }), targetSummary({ id: "beta" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: `goal_of_${targetId}` })] });
    await signIn(app);
    const release = fake.hold("goals");
    app.openTarget("alpha");
    app.openTarget("beta");
    release();
    await settle();
    expect(app.goals.map((goal) => goal.goalId)).toEqual(["goal_of_beta"]);
  });

  test("creating a goal sends the objective trimmed and no id, and the row appears at once", async () => {
    const [app, fake] = await onTarget([{ goalId: "goal_old" }]);
    app.openGoalDialog();
    app.goalName = "  Auth bypass ";
    app.goalObjective = "  Can the limiter be bypassed?  ";
    fake.onCreateGoal = (_baseUrl, targetId, draft) =>
      ok(
        goalView({
          goalId: "goal_new",
          targetId,
          ...draft,
          name: "Auth bypass",
        }),
      );

    await app.createGoal();

    const sent = fake.calls.find((call) => call.method === "createGoal");
    expect(sent?.args[1]).toBe("acme-corp");
    expect(sent?.args[2]).toEqual({
      name: "Auth bypass",
      description: "Can the limiter be bypassed?",
    });
    expect(app.goalDialogOpen).toBe(false);
    expect(app.goals.map((goal) => goal.goalId)).toEqual([
      "goal_new",
      "goal_old",
    ]);
    expect(app.goalCount).toBe(2);
  });

  test("an empty objective asks the server nothing and keeps the dialog open", async () => {
    const [app, fake] = await onTarget();
    app.openGoalDialog();
    app.goalObjective = "   ";
    await app.createGoal();
    expect(fake.countOf("createGoal")).toBe(0);
    expect(app.goalDialogOpen).toBe(true);
    expect(app.goalCreateDetail).toContain("objective");
  });

  test("a refused create keeps what was typed and says why", async () => {
    const [app, fake] = await onTarget();
    app.openGoalDialog();
    app.goalObjective = "Something";
    fake.onCreateGoal = () =>
      refused(
        new TargetUnavailable({
          reason: "schema_unavailable",
          targetId: "acme-corp",
          detail: "the schema did not migrate",
        }),
      );
    await app.createGoal();
    expect(app.goalDialogOpen).toBe(true);
    expect(app.goalObjective).toBe("Something");
    expect(app.goalCreateDetail).toBe("the schema did not migrate");
    expect(app.goalCreating).toBe(false);
  });

  test("ending a goal sends the operator's choice and replaces the row", async () => {
    const [app, fake] = await onTarget([{ goalId: "goal_a" }]);
    app.openGoal("goal_a");
    await settle();
    app.openGoalEnd();
    app.goalEndStatus = "abandoned";
    app.goalEndReason = "  out of scope ";
    await app.endGoal();

    const sent = fake.calls.find((call) => call.method === "endGoal");
    expect(sent?.args.slice(1, 3)).toEqual(["acme-corp", "goal_a"]);
    expect(sent?.args[3]).toEqual({
      status: "abandoned",
      reason: "out of scope",
    });
    expect(app.openGoalView?.status).toBe("abandoned");
    expect(app.openGoalView?.endedBy).toBe("operator");
    expect(app.goalEndOpen).toBe(false);
    expect(app.goalEnding).toBe(false);
  });

  test("a goal already ended elsewhere shows the ending that stands", async () => {
    const [app, fake] = await onTarget([{ goalId: "goal_a" }]);
    app.openGoal("goal_a");
    await settle();
    app.openGoalEnd();
    fake.onEndGoal = () =>
      refused(
        new GoalRefused({
          reason: "already_ended",
          goalId: "goal_a",
          detail: "goal goal_a is already met, ended by operator",
        }),
      );
    // What the re-read finds: the other tab's ending.
    fake.onGoal = (_baseUrl, targetId, goalId) =>
      ok(
        goalView({
          targetId,
          goalId,
          status: "met",
          endedAt: AT + 5,
          endedBy: "operator",
          endReason: "done in the other tab",
        }),
      );
    await app.endGoal();

    expect(app.goalEndDetail).toBe(
      "goal goal_a is already met, ended by operator",
    );
    expect(app.goalEndOpen).toBe(false);
    expect(app.openGoalView?.status).toBe("met");
    expect(app.openGoalView?.endReason).toBe("done in the other tab");
  });

  test("an expired session while ending signs out", async () => {
    const [app, fake] = await onTarget([{ goalId: "goal_a" }]);
    app.openGoal("goal_a");
    await settle();
    app.openGoalEnd();
    fake.onEndGoal = () => refused(new Unauthenticated({ reason: "expired" }));
    await app.endGoal();
    expect(app.screen).toBe("connect");
    expect(app.goals).toEqual([]);
  });

  test("the state picker's open target has goals to show and asks the server for none", async () => {
    const { app, fake } = open();
    app.reset();
    app.previewTarget("acme-corp");
    // Not "reading": a scenario has no server, so nothing would ever answer.
    expect(app.goalsState).toBe("ready");
    expect(app.goalsTargetId).toBe("acme-corp");
    expect(app.goals).toHaveLength(2);
    expect(app.goals.every((goal) => goal.targetId === "acme-corp")).toBe(true);
    // Agrees with the sidebar's number and with the counts the same scenario declares.
    expect(app.goalCount).toBe(2);
    expect(app.counts?.goals).toBe(2);
    expect(fake.countOf("goals")).toBe(0);
  });

  test("creating a goal refreshes the header's counts", async () => {
    const [app, fake] = await onTarget([]);
    let events = 0;
    fake.onTarget = (_baseUrl, id) => {
      const view = targetView(targetSummary({ id, name: id }), { events });
      return ok(view);
    };
    await app.refreshTarget("acme-corp");
    expect(app.counts?.events).toBe(0);

    app.openGoalDialog();
    app.goalObjective = "A new objective";
    // The server has recorded `goal.added` by the time it answers the create.
    events = 1;
    await app.createGoal();
    await settle();

    expect(app.counts?.events).toBe(1);
    expect(app.goals).toHaveLength(1);
  });

  test("ending a goal refreshes the header's counts", async () => {
    const [app, fake] = await onTarget([{ goalId: "goal_a" }]);
    let events = 0;
    fake.onTarget = (_baseUrl, id) =>
      ok(targetView(targetSummary({ id, name: id }), { events }));
    await app.refreshTarget("acme-corp");
    app.openGoal("goal_a");
    await settle();
    app.openGoalEnd();
    events = 2;
    await app.endGoal();
    await settle();
    expect(app.counts?.events).toBe(2);
  });

  test("choosing Goals again from inside a goal returns to the list", async () => {
    const [app] = await onTarget([{ goalId: "goal_a" }]);
    app.openGoal("goal_a");
    expect(app.openGoalId).toBe("goal_a");
    app.closeGoal();
    expect(app.openGoalId).toBe("");
  });
});

/* ── The goal briefing panel ─────────────────────────────────────────────────── */

/**
 * The planner's input for the open goal, as the panel's state rather than as text.
 *
 * What is pinned here is the app's half: that opening a goal reads the briefing and
 * leaving it clears the panel, that an over-the-ceiling refusal keeps both numbers and
 * no briefing, that a refusal carrying no figures has none invented for it, and that an
 * answer for a goal the operator has left is dropped.
 *
 * **These drive `FakeServer`, which implements `ServerClient` directly, so none of them
 * exercises `client.ts`.** Whether a `409 GoalBriefingRefused` is classified as a
 * refusal at all is that module's judgement and is covered in `clientRefusals.test.ts`
 * against a stubbed `fetch`. The two halves are separate on purpose: it was the gap
 * between them that let the panel report a connectivity failure for a typed 409 while
 * the block below passed.
 */
describe("the goal briefing", () => {
  /** Signs in, opens a target holding one goal, and opens that goal. */
  const onGoal = async (): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onHarnesses = () => ok([harnessInstance()]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    return [app, fake];
  };

  test("opening a goal reads its briefing, and leaving it puts the panel back", async () => {
    const [app, fake] = await onGoal();

    expect(app.goalBriefingState).toBe("ready");
    expect(app.goalBriefingGoalId).toBe("goal_1");
    expect(app.goalBriefing?.rendered).toContain("# Planner briefing");
    expect(app.goalBriefing?.sizeChars).toBe(app.goalBriefing?.rendered.length);
    expect(app.goalBriefing?.maxChars).toBe(320_000);
    expect(app.goalBriefing?.omittedObservationIds).toEqual([]);
    expect(app.goalBriefing?.truncated).toBe(false);
    expect(
      fake.calls.find((call) => call.method === "goalBriefing")?.args,
    ).toEqual([expect.any(String), "acme-corp", "goal_1"]);

    app.closeGoal();
    expect(app.goalBriefing).toBeUndefined();
    expect(app.goalBriefingGoalId).toBe("");
    expect(app.goalBriefingState).toBe("idle");
  });

  test("over the ceiling keeps both numbers and no briefing at all", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    fake.onGoalBriefing = () =>
      refused(
        new GoalBriefingRefused({
          reason: "too_large",
          goalId: "goal_1",
          sizeChars: 400_000,
          maxChars: 320_000,
          detail: "This goal's briefing renders to 400000 characters.",
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();

    expect(app.goalBriefingState).toBe("failed");
    // The two figures are kept as numbers so the panel names them without parsing prose.
    expect(app.goalBriefingSize).toBe(400_000);
    expect(app.goalBriefingCeiling).toBe(320_000);
    expect(app.goalBriefingDetail).toContain("400000");
    // Nothing is shown in place of the briefing: there is no shorter version of it.
    expect(app.goalBriefing).toBeUndefined();
  });

  test("a failed read says so without numbers it was not given", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    fake.onGoalBriefing = () =>
      refused(
        new GoalNotFound({
          targetId: "acme-corp",
          goalId: "goal_1",
          detail: "no goal 'goal_1' is recorded in this target",
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();

    expect(app.goalBriefingState).toBe("failed");
    expect(app.goalBriefingDetail).toContain("no goal 'goal_1'");
    // Not every refusal carries figures, and the panel must not invent them.
    expect(app.goalBriefingSize).toBeUndefined();
    expect(app.goalBriefingCeiling).toBeUndefined();
  });

  test("an answer for a goal the operator has left is dropped", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({
        goals: [
          goalView({ targetId, goalId: "goal_1" }),
          goalView({ targetId, goalId: "goal_2" }),
        ],
      });
    fake.onGoalBriefing = (_baseUrl, targetId, goalId) =>
      ok(
        goalBriefingView({
          targetId,
          goalId,
          rendered: `# Planner briefing for ${goalId}`,
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    const release = fake.hold("goalBriefing");
    app.openGoal("goal_1");
    app.openGoal("goal_2");
    release();
    await settle();

    expect(app.goalBriefing?.goalId).toBe("goal_2");
    expect(app.goalBriefing?.rendered).toContain("goal_2");
  });
});

describe("planning a goal", () => {
  /** Signs in, opens a target holding one active goal, and opens that goal. */
  const onGoal = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onHarnesses = () => ok([harnessInstance()]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    arrange(fake);
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    return [app, fake];
  };

  test("opening a goal reads its rounds and what the process is driving", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({ rounds: [planRoundView({ targetId, goalId })] });
    });

    expect(app.planRoundsState).toBe("ready");
    expect(app.planRoundsGoalId).toBe("goal_1");
    // The newest row is what the screen reports: "the round's disposition once recorded"
    // is a statement about the last one.
    expect(app.latestPlanRound?.disposition).toBe("actionable");
    expect(app.latestPlanRound?.dispositionRationale).toContain("no work out");
    expect(app.latestPlanRound?.intentsAdded).toBe(2);
    // Both reads happen, because the rows and what this process is driving are different
    // questions and only the second can disable the control.
    expect(fake.calls.map((call) => call.method)).toContain("goalRounds");
    expect(fake.calls.map((call) => call.method)).toContain("rounds");

    app.closeGoal();
    expect(app.planRounds).toEqual([]);
    expect(app.planRoundsGoalId).toBe("");
    expect(app.planRoundsState).toBe("idle");
  });

  test("a round in flight is the process's answer, not a row saying running", async () => {
    // The distinction the control turns on. The row says `running` and nothing is driving
    // it — a process that died leaves exactly this — so the operator is not told to wait
    // for a round that will never finish.
    const [stale] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              status: "running",
              disposition: null,
              dispositionRationale: null,
              endedAt: null,
            }),
          ],
        });
      fake.onRounds = () => ok([]);
    });
    expect(stale.latestPlanRound?.status).toBe("running");
    expect(stale.openGoalRunningRound).toBeUndefined();

    const [live] = await onGoal((fake) => {
      fake.onRounds = () => ok([runningRound({ goalId: "goal_1" })]);
    });
    expect(live.openGoalRunningRound?.roundId).toBe("rnd_1");
  });

  test("Plan next sends no payload and re-reads both lists", async () => {
    const [app, fake] = await onGoal();
    fake.calls.length = 0;

    await app.plan();
    await settle();

    const planned = fake.calls.find((call) => call.method === "plan");
    // Target and goal, and nothing else: no harness, no model, no directory.
    expect(planned?.args).toEqual([expect.any(String), "acme-corp", "goal_1"]);
    expect(app.planDetail).toBe("");
    expect(app.planStarting).toBe(false);
    const after = fake.calls.map((call) => call.method);
    expect(after).toContain("goalRounds");
    expect(after).toContain("rounds");
  });

  test("the started round is on screen before the re-reads land", async () => {
    // The claim the comment on `plan()` makes, and the one the control depends on: the
    // button is disabled on what this *process* is driving, so waiting for a read to say so
    // would leave it pressable for a round that has already started. Held reads are what
    // make "before" observable at all.
    const [app, fake] = await onGoal((fake) => {
      fake.onPlan = (_baseUrl, targetId, goalId) =>
        ok(planRoundStarted({ targetId, goalId, roundId: "rnd_new" }));
    });
    const releaseRounds = fake.hold("goalRounds");
    const releaseRunning = fake.hold("rounds");

    const pending = app.plan();
    await pending;

    // Both halves, with neither read answered yet.
    expect(app.latestPlanRound?.roundId).toBe("rnd_new");
    expect(app.latestPlanRound?.status).toBe("running");
    // Nothing invented: a round that has just started has concluded nothing and written
    // nothing.
    expect(app.latestPlanRound?.disposition).toBeNull();
    expect(app.latestPlanRound?.dispositionRationale).toBeNull();
    expect(app.latestPlanRound?.intentsAdded).toBe(0);
    expect(app.latestPlanRound?.endedAt).toBeNull();
    // And the control is already in its in-flight state.
    expect(app.openGoalRunningRound?.roundId).toBe("rnd_new");

    releaseRounds();
    releaseRunning();
    await settle();
    // The server's own answer replaces it rather than being appended beside it.
    expect(
      app.planRounds.filter((round) => round.roundId === "rnd_new"),
    ).toHaveLength(0);
  });

  test("a round started on a goal the operator has since left is not placed", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onPlan = (_baseUrl, targetId) =>
        ok(planRoundStarted({ targetId, goalId: "goal_1" }));
    });
    const release = fake.hold("plan");
    const pending = app.plan();
    app.closeGoal();
    release();
    await pending;
    await settle();

    expect(app.planRounds).toEqual([]);
  });

  test("a refusal is the server's sentence, and the world is re-read", async () => {
    const [app, fake] = await onGoal();
    fake.onPlan = () =>
      refused(
        new PlanRefused({
          reason: "goal_busy",
          detail:
            "round rnd_9 is already planning goal goal_1 (target 'acme-corp'). One planner round works a goal at a time.",
        }),
      );
    fake.calls.length = 0;

    await app.plan();
    await settle();

    // Shown as written — the sentence names the round holding the goal, which is the one
    // thing an operator needs — and **not** reported as "no server answered".
    expect(app.planDetail).toContain("rnd_9 is already planning");
    expect(app.planRefusalSize).toBeUndefined();
    // A refusal can mean the world moved, so both are read again.
    const after = fake.calls.map((call) => call.method);
    expect(after).toContain("rounds");
    expect(after).toContain("goal");
  });

  test("a briefing over the ceiling keeps both numbers and says nothing was started", async () => {
    const [app, fake] = await onGoal();
    fake.onPlan = () =>
      refused(
        new GoalBriefingRefused({
          reason: "too_large",
          goalId: "goal_1",
          sizeChars: 400_000,
          maxChars: 320_000,
          detail:
            "This goal's briefing renders to 400000 characters, over the 320000-character ceiling, so no planner round was opened and nothing was started.",
        }),
      );

    await app.plan();
    await settle();

    // The same refusal the briefing panel renders, with the same two numbers kept as
    // numbers so the control can name them without parsing prose.
    expect(app.planRefusalSize).toBe(400_000);
    expect(app.planRefusalCeiling).toBe(320_000);
    expect(app.planDetail).toContain("nothing was started");
  });

  test("a server that does not answer is said to be unreachable, not a refusal", async () => {
    const [app, fake] = await onGoal();
    fake.onPlan = () => unreachable("Unable to connect");

    await app.plan();
    await settle();

    expect(app.planDetail).toBe("No server answered at this address.");
    expect(app.planRefusalSize).toBeUndefined();
  });

  test("a round record on the live stream re-reads the rounds, and nothing else does", async () => {
    const [, fake] = await onGoal();
    // History replays on opening a target, so nothing in it may cause a request per item.
    fake.watch.send(liveOpened({ from: 0, latest: 3 }));
    fake.watch.send(
      liveItem({ id: "record:r0", sequence: 1, kind: "plan.round.started" }),
    );
    await settle();
    const replayed = fake.countOf("goalRounds");
    fake.watch.send(liveCursor({ sequence: 1, caughtUp: true }));

    // Not a round record: `intentsAdded` moves only when the round writes, and a round's
    // own two records are the siblings of that write.
    fake.watch.send(
      liveItem({ id: "record:r1", sequence: 2, kind: "observation.recorded" }),
    );
    await settle();
    expect(fake.countOf("goalRounds")).toBe(replayed);

    const before = fake.countOf("rounds");
    fake.watch.send(
      liveItem({ id: "record:r2", sequence: 3, kind: "plan.round.settled" }),
    );
    await settle();
    expect(fake.countOf("goalRounds")).toBe(replayed + 1);
    // And what the process is driving, because the settled record is what takes the round
    // out of the supervisor's map — a panel that refreshed only the rows would keep saying
    // a round was in flight after it had finished.
    expect(fake.countOf("rounds")).toBe(before + 1);
    // And the prose, which is a third read with a third source: a round this tab did not
    // watch has no live narration, so the harness's copy is the only thing that will ever
    // show what it said.
    expect(fake.calls.map((call) => call.method)).toContain("goalNarration");
  });

  /* ── The planner chat ─────────────────────────────────────────────────────── */

  test("opening a goal replays its narration from the harness", async () => {
    const [app] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({ rounds: [planRoundView({ targetId, goalId })] });
      fake.onGoalNarration = (_baseUrl, targetId, goalId) =>
        ok(
          goalNarrationView({
            targetId,
            goalId,
            rounds: [roundNarration({ roundId: "rnd_1" })],
          }),
        );
    });

    expect(app.goalNarrationState).toBe("ready");
    expect(app.goalNarrationGoalId).toBe("goal_1");
    const shown = app.goalChat.groups[0];
    expect(shown?.key).toBe("rnd_1");
    expect(shown?.prose._tag).toBe("replayed");
    expect(replayedRows(shown).length).toBe(2);

    app.closeGoal();
    expect(app.goalNarration).toBeUndefined();
    expect(app.goalNarrationGoalId).toBe("");
    expect(app.goalNarrationState).toBe("idle");
  });

  test("a refresh mid-round keeps the round and its disposition, and degrades the prose", async () => {
    // What a reload *is* from the app's side: the rows come back from the server and the
    // activity channel has nothing to replay, so the chat is the separator plus whatever
    // the harness still holds. Here it holds nothing, and the structure is untouched.
    const [app] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              roundId: "rnd_1",
              status: "settled",
              disposition: "waiting",
              dispositionRationale: "Two runs are still out.",
            }),
          ],
        });
      fake.onGoalNarration = (_baseUrl, targetId, goalId) =>
        ok(
          goalNarrationView({
            targetId,
            goalId,
            rounds: [
              roundNarration({
                roundId: "rnd_1",
                source: "forgotten",
                ephemeral: false,
                note: "OpenCode no longer holds session ses_1.",
                items: [],
              }),
            ],
          }),
        );
    });

    const shown = app.goalChat.groups[0];
    // The structure is rows and survives: status and disposition are both still here.
    expect(shown?.subject.round.status).toBe("settled");
    expect(shown?.subject.round.disposition).toBe("waiting");
    // The prose is the harness's and did not: it says so, and it is not an error.
    expect(shown?.prose._tag).toBe("forgotten");
    expect(app.goalNarrationDetail).toBe("");
  });

  test("a round the harness has forgotten is not reported as a failed read", async () => {
    const [app] = await onGoal((fake) => {
      fake.onGoalNarration = () => unreachable("Unable to connect");
    });

    // The one case that *is* a failed read, kept apart from every empty answer above.
    expect(app.goalNarrationState).toBe("failed");
    expect(app.goalNarrationDetail).toBe("No server answered at this address.");
  });

  test("an added intent appears once in the chat, under the record's own id", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              roundId: "rnd_1",
              status: "running",
              disposition: null,
              dispositionRationale: null,
              endedAt: null,
            }),
          ],
        });
    });
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(liveCursor({ sequence: 0, caughtUp: true }));
    /*
     * The call, as the harness narrates it: immediate and unconfirmed — and **named the way
     * a driver names it**.
     *
     * {@link livePlannerCall} builds both the namespaced wire form and the reduced name from
     * `@bit/contracts`, the same module `run/liveTranscript.ts` reduces with. This test
     * previously set `tool: "add_intent"` by hand, which is a tool-name space the server
     * never produces: the merge rule was keyed on it, matched nothing against a real round,
     * and this suite could not have noticed.
     */
    fake.watch.send(
      livePlannerCall("add_intent", {
        roundId: "rnd_1",
        over: {
          id: "activity:7",
          callId: "call-1",
          input: '{"question":"can the limiter be bypassed?"}',
        },
      }),
    );
    // And the record it produced, with the store's own id on it.
    fake.watch.send(
      liveItem({
        id: "record:evt-real",
        sequence: 1,
        kind: "intent.added",
        attemptId: null,
        roundId: "rnd_1",
        headline: "Intent",
        body: "intent int_real was added",
        outcome: null,
      }),
    );
    await settle();

    const rows = app.goalChat.groups[0]?.rows ?? [];
    expect(rows.length).toBe(1);
    expect(rows[0]?.write).toBe("recorded");
    expect(rows[0]?.item.id).toBe("record:evt-real");
    expect(rows[0]?.proposedBy?.callId).toBe("call-1");
    // The wire name really was namespaced, so this test is evidence about the shape the
    // server sends rather than about a shape it was handed.
    expect(rows[0]?.proposedBy?.tool).toBe("mcp__bit-rnd_1__add_intent");
    // And the brief's one-line domain summary is on the row, from the call's arguments.
    expect(rows[0]?.summary).toBe("can the limiter be bypassed?");
  });

  test("a write the round never recorded stays visibly unresolved once it settles", async () => {
    // The clause of ruling 4 that was unreachable in the running app: with the rule keyed
    // on the namespaced name, a refused `add_intent` rendered as an ordinary tool call with
    // nothing said about it — a chat reporting writes that may have been refused.
    const [app, fake] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              roundId: "rnd_1",
              status: "settled",
              disposition: "waiting",
              dispositionRationale: "Nothing to add.",
            }),
          ],
        });
    });
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(liveCursor({ sequence: 0, caughtUp: true }));
    fake.watch.send(
      livePlannerCall("add_intent", {
        roundId: "rnd_1",
        driver: "opencode",
        over: {
          id: "activity:9",
          callId: "call-9",
          input: '{"question":"is the lockout bypassable?"}',
        },
      }),
    );
    await settle();

    const row = app.goalChat.groups[0]?.rows[0];
    expect(row?.write).toBe("unresolved");
    expect(row?.summary).toBe("is the lockout bypassable?");
  });

  test("stopping a round settles its row and takes it out of what this process drives", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              roundId: "rnd_1",
              status: "running",
              disposition: null,
              dispositionRationale: null,
              endedAt: null,
            }),
          ],
        });
      fake.onRounds = () => ok([runningRound({ roundId: "rnd_1" })]);
    });
    expect(app.openGoalRunningRound?.roundId).toBe("rnd_1");

    await app.stopRound("rnd_1");

    // The settled row is placed at once, so the separator changes on the same tick the
    // control disappears rather than after the re-read.
    expect(app.planRounds[0]?.status).toBe("interrupted");
    expect(
      app.runningRounds.filter((round) => round.roundId === "rnd_1"),
    ).toEqual([]);
    expect(app.roundStopDetail).toBe("");
    expect(fake.calls.map((call) => call.method)).toContain("stopRound");
  });

  test("stopping a round nothing is driving says so, and re-reads both halves", async () => {
    const [app, fake] = await onGoal();
    fake.onStopRound = () =>
      refused(
        new PlanRefused({
          reason: "unknown_round",
          detail: "no round 'rnd_1' is running in this process",
        }),
      );
    const rows = fake.countOf("goalRounds");
    const driving = fake.countOf("rounds");

    await app.stopRound("rnd_1");
    await settle();

    // The server's sentence, not "No server answered": a round that settled on its own
    // while the page was open is an answer an operator can act on.
    expect(app.roundStopDetail).toContain("running in this process");
    expect(fake.countOf("goalRounds")).toBe(rows + 1);
    expect(fake.countOf("rounds")).toBe(driving + 1);
  });

  test("a refresh mid-round keeps the replayed prose beside the live tail", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              roundId: "rnd_1",
              status: "running",
              disposition: null,
              dispositionRationale: null,
              endedAt: null,
            }),
          ],
        });
      fake.onGoalNarration = (_baseUrl, targetId, goalId) =>
        ok(
          goalNarrationView({
            targetId,
            goalId,
            rounds: [roundNarration({ roundId: "rnd_1" })],
          }),
        );
    });
    expect(app.goalChat.groups[0]?.prose._tag).toBe("replayed");

    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(
      liveItem({
        id: "activity:11",
        origin: "activity",
        sequence: null,
        kind: "turn.reply",
        attemptId: null,
        roundId: "rnd_1",
        headline: "Reply",
        body: "two dimensions have no work out",
        outcome: null,
      }),
    );
    await settle();

    // Both halves: what the harness already had, and what has arrived since. Hiding the
    // first the moment the second landed would make a refresh mid-round lose the round's
    // own history, which is the opposite of degrading honestly.
    const shown = app.goalChat.groups[0];
    expect(shown?.prose._tag).toBe("replayed");
    expect(replayedRows(shown).length).toBe(2);
    expect(liveRows(shown).map((row) => row.item.body)).toEqual([
      "two dimensions have no work out",
    ]);
  });

  test("narration already inside the replay is not shown twice beside the live tail", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onGoalRounds = (_baseUrl, targetId, goalId) =>
        ok({
          rounds: [
            planRoundView({
              targetId,
              goalId,
              roundId: "rnd_1",
              status: "running",
              disposition: null,
              dispositionRationale: null,
              endedAt: null,
            }),
          ],
        });
      fake.onGoalNarration = (_baseUrl, targetId, goalId) =>
        ok(
          goalNarrationView({
            targetId,
            goalId,
            rounds: [roundNarration({ roundId: "rnd_1" })],
          }),
        );
    });

    // An entry this tab already holds, numbered below the floor the replay was read at.
    // It is inside the replayed block, so it must not also be a live row.
    const early = liveItem({
      id: "activity:3",
      origin: "activity",
      sequence: null,
      kind: "turn.reply",
      attemptId: null,
      roundId: "rnd_1",
      headline: "Reply",
      body: "already in the replay",
      outcome: null,
    });
    fake.watch.send(early);
    await settle();
    // Re-reading the narration takes a fresh floor, which is now above that entry.
    await app.loadGoalNarration("goal_1");

    expect(app.goalNarrationFloor).toBe(3);
    const shown = app.goalChat.groups[0];
    expect(shown?.prose._tag).toBe("replayed");
    expect(liveRows(shown)).toEqual([]);
  });
});

describe("a round trip that outlives the view it started in", () => {
  /** Two targets with distinguishable counts, open on alpha, signed in. */
  const onAlpha = async (): Promise<{ app: App; fake: FakeServer }> => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([targetSummary({ id: "alpha" }), targetSummary({ id: "beta" })]);
    fake.onTarget = (_baseUrl, id) =>
      ok(
        targetView(targetSummary({ id, name: id }), {
          goals: id === "alpha" ? 1 : 99,
        }),
      );
    fake.onStartRun = () =>
      ok(runStarted({ targetId: "alpha", attemptId: "alpha-run" }));
    fake.onRuns = () =>
      ok([runningAttempt({ targetId: "alpha", attemptId: "alpha-run" })]);

    await signIn(app);
    app.openTarget("alpha");
    await settle();
    expect(app.viewTargetId).toBe("alpha");
    return { app, fake };
  };

  /**
   * The operator is on beta and alpha's run is live on the server. Beta is what the
   * screen must be about, in every field the composer reads.
   */
  const expectTheViewIsBetas = (app: App, fake: FakeServer, asked: number) => {
    expect(app.viewTargetId).toBe("beta");
    expect(app.selectedId).toBe("beta");
    expect(app.counts?.goals).toBe(99);
    // Alpha's run is still running. It must not be offered here, because Stop acts on
    // whatever this answers with.
    expect(app.activeRun).toBeUndefined();
    expect(app.readableAttemptId).toBe("");
    // Not asked for at all: a refresh of a target that is off screen has nothing to
    // refresh, so it does not spend a request whose answer it would only discard.
    expect(fake.countOf("target")).toBe(asked);
  };

  test("a start that lands late leaves the view where the operator put it", async () => {
    const { app, fake } = await onAlpha();

    const release = fake.hold("startRun");
    app.runIntentId = "intent-1";
    const starting = app.startRun();
    // The round trip is open; the operator clicks beta in the rail.
    app.openTarget("beta");
    await settle();
    expect(app.viewTargetId).toBe("beta");
    const asked = fake.countOf("target");

    release();
    await starting;
    await settle();

    expectTheViewIsBetas(app, fake, asked);
  });

  test("a stop that lands late leaves the view where the operator put it", async () => {
    const { app, fake } = await onAlpha();
    app.runIntentId = "intent-1";
    await app.startRun();
    expect(app.activeRun?.attemptId).toBe("alpha-run");

    const release = fake.hold("stopRun");
    const stopping = app.stopRun();
    app.openTarget("beta");
    await settle();
    const asked = fake.countOf("target");

    release();
    await stopping;
    await settle();

    expectTheViewIsBetas(app, fake, asked);
  });
});

/* ── Reading a transcript says nothing about whether a run is over ───────────── */

/**
 * No transcript source is evidence that a run has settled, so reading one never touches
 * the running list.
 *
 * There used to be one: a transcript the server had written itself could only exist once
 * the attempt settled, so seeing it was grounds to re-read the running list. That copy is
 * gone and the harness is the only source. `harness` says only that the harness still holds
 * the session, which a live run does too; `absent` and `unreachable` are also what a
 * foreign instance or an attempt with no session return. Inferring from any of them would
 * clear a row for a run that is still working, which is the worse mistake. A run that ends
 * while the tab watches is cleared by the live feed's `run.settled` frame instead.
 */
describe("reading a transcript leaves the running list alone", () => {
  /**
   * One running row, one transcript read, and a server that has since noticed the run is
   * over, which the transcript read must not act on whatever it answers.
   */
  const afterReading = async (
    source: "harness" | "absent" | "unreachable",
  ): Promise<{ app: App; fake: FakeServer; runsBefore: number }> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onRuns = () => ok([runningAttempt({ attemptId: "attempt-7" })]);
    fake.onTranscript = () =>
      ok(attemptTranscript({ attemptId: "attempt-7", source }));

    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    expect(app.activeRun?.attemptId).toBe("attempt-7");

    // The server has settled it in the meantime, which is the situation the inference is
    // about: this tab has no feed and would otherwise never find out.
    fake.onRuns = () => ok([]);
    const runsBefore = fake.countOf("runs");
    await app.loadTranscript("acme-corp", "attempt-7");
    return { app, fake, runsBefore };
  };

  test.each(["harness", "absent", "unreachable"] as const)(
    "a transcript that reads as %s leaves the running row alone",
    async (source) => {
      const { app, fake, runsBefore } = await afterReading(source);
      expect(app.transcript?.source).toBe(source);
      expect(app.activeRun?.attemptId).toBe("attempt-7");
      // Not merely unchanged by luck: the list was never asked for again.
      expect(fake.countOf("runs")).toBe(runsBefore);
    },
  );

  /**
   * Neither "gone" nor "could not ask" is an error: both are successful answers, and each
   * keeps its own source so the panel can tell them apart. `transcriptDetail` is for a
   * silent server only.
   */
  test.each(["absent", "unreachable"] as const)(
    "a transcript that reads as %s is an answer, not an error",
    async (source) => {
      const { app } = await afterReading(source);
      expect(app.transcript?.source).toBe(source);
      expect(app.transcriptDetail).toBe("");
      expect(app.transcriptLoading).toBe(false);
    },
  );

  test("a server that does not answer is reported as unreachable", async () => {
    const { app, fake } = open();
    fake.onTranscript = () => unreachable("Failed to fetch");
    await signIn(app);
    await app.loadTranscript("acme-corp", "attempt-7");

    expect(app.transcript).toBeUndefined();
    expect(app.transcriptDetail).toBe("No server answered at this address.");
  });
});

/* ── Deep links ──────────────────────────────────────────────── */

/**
 * The half of a deep link `App` owns: a place it cannot read, held across the Connect
 * screen and released at the one moment it can be opened.
 *
 * It is held as text because the grammar that reads a path imports `App` itself
 * (`lib/place.ts`), and a runtime cycle between the state and its own grammar is not worth
 * a typed field — see {@link App.requestedPath}. So `App` knows *when* a held link can be
 * opened and nothing about *what* it says, and these tests assert exactly that much: held,
 * released once by either way in, dropped for a target this server does not have, cleared
 * either way. Where a link lands is the route's half, and `deepLink.test.ts` puts the two
 * together the way the route does.
 */
describe("deep links", () => {
  test("a place is held across Connect and released once there is a session", async () => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([
        targetSummary({ id: "acme-corp" }),
        targetSummary({ id: "scratch" }),
      ]);

    // Arrives before there is a session, which is the case that matters.
    app.requestPlace("scratch", "/t/scratch/assets/scope");
    expect(app.screen).toBe("connect");
    expect(app.replayPath).toBe("");

    await signIn(app);
    await settle();

    expect(app.replayPath).toBe("/t/scratch/assets/scope");
    expect(app.requestedTargetId).toBe("");
    expect(app.requestedPath).toBe("");
    /*
     * Nothing has been opened here, not even the target. A path names a whole place and
     * only the route can read one, so opening the target eagerly would land the operator
     * on Goals and then move them — two screens for one link. The target waits with the
     * rest of it.
     */
    expect(app.screen).toBe("welcome");
    expect(app.viewTargetId).toBe("");
    expect(fake.countOf("target")).toBe(0);
  });

  test("a place held through a reload is released by the resume", async () => {
    // The second way in. A link should land in the same place whether the session was
    // opened by hand or resumed, and the browser session registry is in memory — so the
    // morning after a server restart is the common case, not the odd one.
    const { app, fake } = open();
    fake.stored = "token-from-a-reload";
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    app.requestPlace("acme-corp", "/t/acme-corp/findings");
    await app.restore();
    await settle();

    expect(app.replayPath).toBe("/t/acme-corp/findings");
  });

  /**
   * Dropped here and not retried. The list is already on screen and is the honest answer
   * to "that target is not on this server"; re-asking on every refresh would be the link
   * following the operator around.
   *
   * The check is `App`'s because the registry is, and it is the one question about a held
   * path that `App` can answer without reading it. Design D5's sentence goes with it: the
   * operator asked for something specific by following a link and waited behind Connect for
   * it, so being put on a list with nothing said is the one outcome S5 rules out.
   */
  test("a link to a target this server does not have is dropped on the list, with a reason", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    app.requestPlace(
      "a-target-from-another-server",
      "/t/a-target-from-another-server/goals/goal_1",
    );
    await signIn(app);

    expect(app.screen).toBe("welcome");
    expect(app.viewTargetId).toBe("");
    expect(app.replayPath).toBe("");
    // Cleared, so the next way in does not try it again.
    expect(app.requestedTargetId).toBe("");
    expect(app.requestedPath).toBe("");
    expect(fake.countOf("target")).toBe(0);
    expect(app.arrivalNote).toContain(
      'This server has no target called "a-target-from-another-server"',
    );
  });

  test("and a held place that does resolve leaves no note behind", async () => {
    // The note is for the arrival that failed. A link that lands says nothing, because
    // landing is what a link is supposed to do.
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    app.requestPlace("acme-corp", "/t/acme-corp/findings");
    await signIn(app);

    expect(app.replayPath).toBe("/t/acme-corp/findings");
    expect(app.arrivalNote).toBe("");
  });

  /*
   * `confirmOpenGoal` is the half of design D5 that has to ask the server, so it is also
   * the half that can be wrong about what the answer meant. "That goal no longer exists" is
   * not a sentence to say on a guess — it sends the operator looking for a goal that is
   * perfectly fine — so only the server's own `GoalNotFound` produces it.
   */
  test("a goal the server refuses by id falls back to the goal list", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = () => ok({ goals: [goalView({ goalId: "goal_1" })] });
    fake.onGoal = (_url, targetId, goalId) =>
      refused(
        new GoalNotFound({
          targetId,
          goalId,
          detail: `no goal '${goalId}' is recorded in this target`,
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_9");
    await app.confirmOpenGoal("goal_9");

    expect(app.openGoalId).toBe("");
    expect(app.arrivalNote).toContain('no goal under the id "goal_9"');
  });

  test("an unreachable server says nothing about whether the goal exists", async () => {
    // The failure that looks identical from the goal page: no row, nothing read. The link
    // may be perfectly good and the server merely away, so the goal stays open and the
    // reads' own failure states are what the operator sees.
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = () => ok({ goals: [] });
    fake.onGoal = () => unreachable("no server answered");
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_9");
    await app.confirmOpenGoal("goal_9");

    expect(app.openGoalId).toBe("goal_9");
    expect(app.arrivalNote).toBe("");
  });

  test("a goal on a target that has gone says so about the target, once", async () => {
    // Both halves of the path are dead and the operator gets one sentence, not two: the
    // target is the outer fact, and a goal list for a target that is not there is not a
    // page to put anybody on.
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoal = (_url, targetId) =>
      refused(
        new TargetNotFound({
          reason: "unknown_target",
          targetId,
          detail: `no target '${targetId}' is registered`,
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_9");
    await app.confirmOpenGoal("goal_9");

    expect(app.screen).toBe("welcome");
    expect(app.arrivalNote).toContain(
      'This server has no target called "acme-corp"',
    );
  });

  test("a released place is taken once", async () => {
    // The route reads it from an effect, and an effect re-runs. A path that stayed put
    // would replay the link again later and pull the operator back to a page they had
    // left.
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    app.requestPlace("acme-corp", "/t/acme-corp");
    await signIn(app);

    expect(app.takeReplayPath()).toBe("/t/acme-corp");
    expect(app.takeReplayPath()).toBe("");
    expect(app.replayPath).toBe("");
  });

  test("a scenario reset drops a held place", () => {
    // `reset()` is the picker's way back to a fresh load, and a link the last visit was
    // holding would otherwise fire during the next one.
    const { app } = open();
    app.requestPlace("acme-corp", "/t/acme-corp/assets/scope");
    app.reset();
    expect(app.requestedTargetId).toBe("");
    expect(app.requestedPath).toBe("");
    expect(app.replayPath).toBe("");
  });
});

/* ── Losing the session, and losing the server ───────────────────────────────── */

describe("a session that goes while the app is up", () => {
  test("an unauthenticated rail refresh signs out as expired", async () => {
    const { app, fake } = open();
    await signIn(app);
    expect(app.screen).toBe("welcome");

    fake.onTargets = () => refused(new Unauthenticated({ reason: "expired" }));
    await app.loadTargets();

    expect(app.screen).toBe("connect");
    expect(app.connectError).toBe("expired");
    expect(app.targets).toEqual([]);
    expect(fake.token).toBeUndefined();
  });

  /**
   * Losing contact is the other thing, and the rail must not be emptied for it: the
   * banner's claim is "what you see below is the last known state", which is only true
   * if the last known state is still there.
   */
  test("losing contact keeps the rail and raises the banner", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    await signIn(app);

    fake.onTargets = () => unreachable("Failed to fetch");
    await app.loadTargets();

    expect(app.screen).toBe("welcome");
    expect(app.reconnecting).toBe(true);
    expect(app.bannerDismissed).toBe(false);
    expect(app.targets.map((target) => target.id)).toEqual(["acme-corp"]);
  });
});

/* ── The live transcript ─────────────────────────────────────────────────────── */

/**
 * Watching a run, as the state machine sees it.
 *
 * The double delivers nothing on its own — see {@link FakeServer.watchLive} — so every
 * frame below is one a test chose to send. That is the only way to state the day's two
 * claims as tests rather than as hopes: items appear in the order they arrive and are not
 * re-sorted, and an item already shown is never shown again.
 *
 * Nothing here renders a component. `LiveTranscript.svelte` reads exactly the fields
 * asserted below, and the division is the one this file's header records.
 */
describe("the live transcript", () => {
  /** Signed in with one target, opened, with a live connection waiting to be driven. */
  const watching = async (): Promise<{ app: App; fake: FakeServer }> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    return { app, fake };
  };

  test("opening a target opens one connection, for that target", async () => {
    const { app, fake } = await watching();
    expect(fake.watches).toHaveLength(1);
    expect(fake.watch.targetId).toBe("acme-corp");
    expect(app.liveTargetId).toBe("acme-corp");
    expect(app.liveWatching).toBe(true);
    // An empty view reconstructs the committed record from the beginning.
    expect(fake.watch.cursor).toBe(0);
  });

  test("the record arrives in the order it was sent, and is not re-sorted", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveOpened({ from: 0, latest: 3 }));
    // Deliberately descending timestamps against ascending sequences. Sorting by `at` is
    // the obvious wrong thing to do here — two items can share a millisecond and a run's
    // timestamps come from three different clocks — so the store's order has to be the
    // arrival order and nothing else.
    fake.watch.send(
      liveItem({
        id: "record:e1",
        sequence: 1,
        at: AT + 300,
        kind: "run.started",
      }),
    );
    fake.watch.send(
      liveItem({
        id: "record:e2",
        sequence: 2,
        at: AT + 200,
        kind: "tool.result",
      }),
    );
    fake.watch.send(
      liveItem({
        id: "record:e3",
        sequence: 3,
        at: AT + 100,
        kind: "observation.recorded",
      }),
    );
    expect(app.liveItems.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(app.liveItems.map((item) => item.kind)).toEqual([
      "run.started",
      "tool.result",
      "observation.recorded",
    ]);
  });

  test("every render kind the day asks for survives to the screen's fields", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveOpened());
    fake.watch.send(liveItem({ id: "r1", sequence: 1, kind: "run.started" }));
    fake.watch.send(
      liveActivity({
        id: "a1",
        kind: "tool.call",
        tool: "bash",
        input: '{"command":"curl -s http://127.0.0.1:41317/login"}',
      }),
    );
    fake.watch.send(
      liveActivity({
        id: "a2",
        kind: "tool.result",
        tool: "bash",
        input: null,
        output: "HTTP/1.1 429 Too Many Requests",
        outcome: "ok",
      }),
    );
    fake.watch.send(
      liveActivity({
        id: "a3",
        kind: "action.denied",
        headline: "Denied",
        body: "host 'out-of-scope.test' is not in scope",
        tool: "bash",
        outcome: "denied",
      }),
    );
    fake.watch.send(
      liveItem({
        id: "r2",
        sequence: 2,
        kind: "observation.recorded",
        outcome: "negative",
      }),
    );

    const byKind = new Map(app.liveItems.map((item) => [item.kind, item]));
    // A tool call shows its arguments; its result shows its output. Both are the harness's
    // own and neither is invented here.
    expect(byKind.get("tool.call")?.input).toContain("curl");
    expect(byKind.get("tool.result")?.output).toContain("429");
    // A denied action reads as denied, with the gate's reason.
    expect(byKind.get("action.denied")?.outcome).toBe("denied");
    expect(byKind.get("action.denied")?.body).toContain("out-of-scope.test");
    // A recorded observation reads as recorded, and a negative result is still a result.
    expect(byKind.get("observation.recorded")?.outcome).toBe("negative");
    // And the two channels stay told apart: only the record carries a position.
    expect(byKind.get("run.started")?.sequence).toBe(1);
    expect(byKind.get("tool.call")?.sequence).toBeNull();
  });

  test("an item delivered twice is shown once", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    fake.watch.send(liveActivity({ id: "activity:9" }));
    fake.watch.send(liveActivity({ id: "activity:9" }));
    expect(app.liveItems.map((item) => item.id)).toEqual([
      "record:e1",
      "activity:9",
    ]);
  });

  test("the cursor follows the record forward, and never back", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e4", sequence: 4 }));
    expect(app.liveCursor).toBe(4);
    // An activity item carries no position, so it cannot move the cursor.
    fake.watch.send(liveActivity({ id: "activity:1" }));
    expect(app.liveCursor).toBe(4);
    // Nor can a frame about somewhere this tab has already been. A cursor that went
    // backwards would mean "somewhere I have been" rather than "everything up to here".
    fake.watch.send(liveCursor({ sequence: 2, caughtUp: true }));
    expect(app.liveCursor).toBe(4);
    fake.watch.send(liveCursor({ sequence: 6, caughtUp: true }));
    expect(app.liveCursor).toBe(6);
  });

  test("the cursor frame is what says whether the history has finished arriving", async () => {
    const { app, fake } = await watching();
    expect(app.liveCaughtUp).toBe(false);
    fake.watch.send(liveCursor({ sequence: 2, caughtUp: false }));
    expect(app.liveCaughtUp).toBe(false);
    fake.watch.send(liveCursor({ sequence: 3, caughtUp: true }));
    expect(app.liveCaughtUp).toBe(true);
  });

  test("a bounded start is reported rather than swallowed", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveOpened({ from: 900, latest: 1000, skipped: 900 }));
    // The transcript starts part way through this target's record, and a screen that
    // looked complete and was not would be the wrong kind of quiet.
    expect(app.liveSkipped).toBe(900);
    expect(app.liveCursor).toBe(900);
  });

  test("a dropped connection reconnects without discarding committed items", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    fake.watch.close({ _tag: "failed", detail: "Failed to fetch" });
    expect(app.liveWatching).toBe(false);
    expect(app.liveReconnecting).toBe(true);
    expect(app.liveDetail).toContain("cannot be replayed");
    expect(app.liveItems).toHaveLength(1);
  });

  test("a clean end also resumes the durable stream", async () => {
    const { app, fake } = await watching();
    fake.watch.close({ _tag: "ended" });
    expect(app.liveWatching).toBe(false);
    expect(app.liveReconnecting).toBe(true);
  });

  test("reconnect resumes after the committed cursor and deduplicates overlap", async () => {
    const { app, fake, clock } = open();
    fake.onTargets = () => ok([targetSummary()]);
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    fake.watch.send(liveItem({ id: "record:one", sequence: 1 }));
    fake.watch.close({ _tag: "failed", detail: "network" });
    expect(app.liveReconnecting).toBe(true);
    expect(clock.latest.ms).toBe(1_000);
    clock.fire();
    expect(fake.watches).toHaveLength(2);
    expect(fake.watch.cursor).toBe(1);
    fake.watch.send(liveOpened({ from: 1, latest: 2 }));
    fake.watch.send(liveItem({ id: "record:one", sequence: 1 }));
    fake.watch.send(liveItem({ id: "record:two", sequence: 2 }));
    fake.watch.send(liveCursor({ sequence: 2, caughtUp: true }));
    expect(app.liveItems.map((item) => item.id)).toEqual([
      "record:one",
      "record:two",
    ]);
    expect(app.liveCursor).toBe(2);
    expect(app.liveReconnecting).toBe(false);
    expect(app.liveCaughtUp).toBe(true);
  });

  test("a reloaded view reconstructs committed history rather than skipping to a saved cursor", async () => {
    const first = await watching();
    first.fake.watch.send(liveItem({ id: "record:one", sequence: 1 }));
    first.app.stopLive();
    const second = await watching();
    expect(second.fake.watch.cursor).toBe(0);
    second.fake.watch.send(liveItem({ id: "record:one", sequence: 1 }));
    second.fake.watch.send(liveItem({ id: "record:two", sequence: 2 }));
    second.fake.watch.send(liveCursor({ sequence: 2, caughtUp: true }));
    expect(second.app.liveItems.map((item) => item.id)).toEqual([
      "record:one",
      "record:two",
    ]);
  });

  test("target recovery notices retain uncertain as distinct from a definite outcome", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary()]);
    fake.onTarget = () => ok(targetView(targetSummary(), {}));
    await signIn(app);
    fake.onTarget = () =>
      ok({
        ...targetView(targetSummary()),
        recoveries: [
          {
            attemptId: "attempt-unknown",
            status: "uncertain",
            disposition: "uncertain",
            observedStatus: "missing",
            detail: "session unavailable",
            reconciledAt: AT,
          },
          {
            attemptId: "attempt-confirmed",
            status: "succeeded",
            disposition: "settled",
            observedStatus: "succeeded",
            detail: "harness confirmed",
            reconciledAt: AT,
          },
        ],
      });
    app.openTarget("acme-corp");
    await settle();
    expect(app.liveRecoveries.map((recovery) => recovery.status)).toEqual([
      "uncertain",
      "succeeded",
    ]);
    expect(
      fake.calls.filter((call) => call.method === "startRun"),
    ).toHaveLength(0);
  });

  test("switching target cancels a pending reconnect", async () => {
    const { app, fake, clock } = open();
    fake.onTargets = () => ok([targetSummary()]);
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    fake.watch.close({ _tag: "failed", detail: "network" });
    const pending = clock.latest;
    app.openTarget("other-corp");
    await settle();
    expect(pending.cancelled).toBe(true);
    pending.fire();
    expect(fake.watches).toHaveLength(2);
    expect(app.liveTargetId).toBe("other-corp");
  });

  /**
   * An expired session on the live connection signs the tab out.
   *
   * The failure that says so is the contract's own typed `Unauthenticated`, and the client
   * keeps it typed all the way here rather than stringifying it — see `LiveClosed`. This is
   * the test for what happened when it did not: the tab reported "the connection dropped",
   * went on showing a target list it could no longer refresh, and held a dead token while
   * looking signed in.
   */
  test("an expired session on the live connection signs out as expired", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    fake.watch.close({ _tag: "unauthenticated" });

    expect(app.screen).toBe("connect");
    expect(app.connectError).toBe("expired");
    expect(fake.token).toBeUndefined();
    // Not left as a connection-trouble message: the operator is being asked to sign in
    // again, which is a different thing from being told the socket went.
    expect(app.liveDetail).toBe("");
    expect(app.liveWatching).toBe(false);
    expect(app.liveItems).toEqual([]);
    expect(app.liveTargetId).toBe("");
  });

  /**
   * A connection this tab stopped reports nothing, and navigating is not news.
   *
   * The client sets its own stopped flag before interrupting the fiber, so `onClosed` is
   * never called for a connection the caller closed — which is what keeps "the operator
   * opened another target" from putting up a connection-lost alert or, worse, a sign-out.
   *
   * It also bounds the guard-order fix above: an expired session can only be reported by the
   * connection that is *current*, because a replaced one is already stopped. The
   * unauthenticated case is still handled before the target check, because the ordering is
   * free and the alternative — a tab that keeps a dead token because the news arrived a beat
   * after a navigation — is the failure that is expensive to find.
   */
  test("a connection this tab stopped reports nothing at all", async () => {
    const { app, fake } = await watching();
    const leaving = fake.watch;
    app.openTarget("other-corp");
    await settle();
    expect(leaving.stopped()).toBe(true);

    leaving.close({ _tag: "unauthenticated" });
    leaving.close({ _tag: "failed", detail: "Failed to fetch" });
    expect(app.screen).toBe("target");
    expect(app.connectError).toBe("none");
    expect(app.liveDetail).toBe("");
    // The new connection is the one that would report it, and it is still up.
    expect(app.liveWatching).toBe(true);
    expect(app.liveTargetId).toBe("other-corp");
  });

  test("the connection opened after a switch is the one that reports an expired session", async () => {
    const { app, fake } = await watching();
    app.openTarget("other-corp");
    await settle();
    fake.watch.close({ _tag: "unauthenticated" });
    expect(app.screen).toBe("connect");
    expect(app.connectError).toBe("expired");
    expect(fake.watches.every((watch) => watch.stopped())).toBe(true);
  });

  /**
   * Two tools running at once, with their results coming back the other way round.
   *
   * Both harnesses run tools concurrently, so this is the ordinary case rather than a
   * contrived one, and it is the case where pairing by tool *name* silently attributes one
   * command's output to the other command. `callId` is the only thing that can pair them —
   * and for Claude Code it is the only thing available at all, because a `tool_result`
   * block carries no tool name.
   */
  test("concurrent tool calls keep their own call ids when results arrive reversed", async () => {
    const { app, fake } = await watching();
    fake.watch.send(
      liveActivity({
        id: "activity:1",
        kind: "tool.call",
        tool: "bash",
        callId: "c1",
        input: '{"command":"curl -s http://a/"}',
      }),
    );
    fake.watch.send(
      liveActivity({
        id: "activity:2",
        kind: "tool.call",
        tool: "bash",
        callId: "c2",
        input: '{"command":"curl -s http://b/"}',
      }),
    );
    // The second call answers first.
    fake.watch.send(
      liveActivity({
        id: "activity:3",
        kind: "tool.result",
        tool: "bash",
        callId: "c2",
        input: null,
        output: "from b",
        outcome: "ok",
      }),
    );
    fake.watch.send(
      liveActivity({
        id: "activity:4",
        kind: "tool.result",
        tool: "bash",
        callId: "c1",
        input: null,
        output: "from a",
        outcome: "failed",
      }),
    );

    // Arrival order is kept — nothing regroups or reorders the list — so the pairing has to
    // be carried on the items themselves.
    expect(app.liveItems.map((item) => [item.kind, item.callId])).toEqual([
      ["tool.call", "c1"],
      ["tool.call", "c2"],
      ["tool.result", "c2"],
      ["tool.result", "c1"],
    ]);
    // And pairing on the id gives the right answer where pairing on the tool name would
    // give whichever call to `bash` came first.
    const paired = (callId: string) =>
      app.liveItems
        .filter((item) => item.callId === callId)
        .map((item) => item.output ?? item.input);
    expect(paired("c1")).toEqual(['{"command":"curl -s http://a/"}', "from a"]);
    expect(paired("c2")).toEqual(['{"command":"curl -s http://b/"}', "from b"]);
  });

  test("a result the harness never named a call for carries no pairing at all", async () => {
    const { app, fake } = await watching();
    fake.watch.send(
      liveActivity({
        id: "activity:9",
        kind: "tool.result",
        tool: null,
        callId: null,
        input: null,
        output: "orphan",
        outcome: "ok",
      }),
    );
    // Null rather than the tool name: an unpairable result must read as unpairable, because
    // the alternative is attributing it to a call it may have nothing to do with.
    expect(app.liveItems[0]?.callId).toBeNull();
  });

  test("the record items this tab is shown do not carry a call id", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    expect(app.liveItems[0]?.callId).toBeNull();
  });

  test("switching target clears what the other one said, and opens one connection", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    expect(app.liveItems).toHaveLength(1);

    app.openTarget("other-corp");
    await settle();
    // A stale item here is actively misleading: it looks like the target in front of you
    // doing something it did not do.
    expect(app.liveTargetId).toBe("other-corp");
    expect(app.liveItems).toEqual([]);
    expect(app.liveCursor).toBe(0);
    expect(fake.watches).toHaveLength(2);
    expect(fake.watches[0]?.stopped()).toBe(true);
    expect(fake.watch.targetId).toBe("other-corp");
  });

  test("a frame from the connection this tab has left is dropped", async () => {
    const { app, fake } = await watching();
    const leaving = fake.watch;
    app.openTarget("other-corp");
    await settle();
    // A connection being torn down can deliver one more frame after the operator moved on.
    leaving.send(liveItem({ id: "record:stale", sequence: 99 }));
    expect(app.liveItems).toEqual([]);
    expect(app.liveCursor).toBe(0);
  });

  test("reopening the same target does not open a second connection", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    app.openTarget("acme-corp");
    await settle();
    // Two sockets delivering the same frames would be deduped by their ids, but a second
    // socket is still a second socket.
    expect(fake.watches).toHaveLength(1);
    expect(app.liveItems).toHaveLength(1);
  });

  test("signing out closes the connection and clears what it showed", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    app.signOut();
    // The connection carries a bearer that has just been dropped, so it goes with it.
    expect(fake.watches[0]?.stopped()).toBe(true);
    expect(app.liveWatching).toBe(false);
    expect(app.liveItems).toEqual([]);
    expect(app.liveTargetId).toBe("");
    // Stopping is not news: nothing went wrong.
    expect(app.liveDetail).toBe("");
  });

  test("a target the registry no longer holds stops the connection", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onTarget = () =>
      refused(
        new TargetNotFound({
          reason: "unknown_target",
          targetId: "gone",
          detail: "no target 'gone' is registered on this server",
        }),
      );
    await signIn(app);
    app.openTarget("gone");
    await settle();
    expect(app.screen).toBe("welcome");
    expect(fake.watches[0]?.stopped()).toBe(true);
    expect(app.liveWatching).toBe(false);
    expect(app.liveTargetId).toBe("");
  });

  /**
   * Resetting to a scenario takes the live transcript with it, socket included.
   *
   * The picker replaces the rail with mock rows no server has heard of, so a stream left
   * running would go on writing items attributed to a target that is no longer on screen —
   * and would hold a connection open against a server the picker has just walked away from.
   */
  test("reset closes the connection and forgets what it showed", async () => {
    const { app, fake } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    expect(app.liveItems).toHaveLength(1);

    app.reset();
    expect(fake.watches[0]?.stopped()).toBe(true);
    expect(app.liveWatching).toBe(false);
    expect(app.liveItems).toEqual([]);
    expect(app.liveTargetId).toBe("");
    expect(app.liveCursor).toBe(0);
    expect(app.liveCaughtUp).toBe(false);
    expect(app.liveSkipped).toBe(0);
    expect(app.liveDetail).toBe("");
    // And nothing is reopened: the rows `reset` installs are the prototype's.
    expect(fake.watches).toHaveLength(1);
  });

  /**
   * The memory of what has been shown is bounded, and the bound is out of reach in practice.
   *
   * Unbounded it grew one string per narrated moment for as long as a tab stayed open, which
   * for an agent working overnight was the one structure here with no ceiling. What the
   * bound costs is that an id evicted after `LIVE_IDS_KEPT` newer items could be shown
   * twice — reachable only from a server that re-sent it, which within a connection it never
   * does.
   */
  test("the id memory is bounded, and still dedupes everything on screen", async () => {
    const { app, fake } = await watching();
    for (let n = 1; n <= App.LIVE_IDS_KEPT + 10; n += 1) {
      fake.watch.send(liveItem({ id: `record:e${n}`, sequence: n }));
    }
    // Re-delivering the newest is still a no-op, which is the case that actually happens.
    const before = app.liveItems.length;
    fake.watch.send(
      liveItem({
        id: `record:e${App.LIVE_IDS_KEPT + 10}`,
        sequence: App.LIVE_IDS_KEPT + 10,
      }),
    );
    expect(app.liveItems).toHaveLength(before);
    // And every id still on screen is remembered: the eviction window is four times the
    // number of items kept, so nothing visible can have been forgotten.
    for (const item of app.liveItems) {
      const length = app.liveItems.length;
      fake.watch.send(item);
      expect(app.liveItems).toHaveLength(length);
    }
  });

  test("a very long run keeps the newest items and not the oldest", async () => {
    const { app, fake } = await watching();
    for (let n = 1; n <= App.LIVE_KEPT + 5; n += 1) {
      fake.watch.send(liveItem({ id: `record:e${n}`, sequence: n }));
    }
    expect(app.liveItems).toHaveLength(App.LIVE_KEPT);
    // Dropping the oldest is sound here in a way it would not be on the server: everything
    // on the record channel is still in the target's event log, and the cursor still says
    // where this tab had got to.
    expect(app.liveItems[0]?.sequence).toBe(6);
    expect(app.liveItems[App.LIVE_KEPT - 1]?.sequence).toBe(App.LIVE_KEPT + 5);
    expect(app.liveCursor).toBe(App.LIVE_KEPT + 5);
  });
});

/* ── Noticing a connection that stopped speaking ─────────────────────────────── */

/**
 * The silence watchdog, driven by hand.
 *
 * **What it is for.** Observed in a browser: through the dev server's `/api` proxy the
 * downstream response stayed open after the upstream closed, so the stream never ended,
 * nothing failed, and the transcript sat showing `Live` with a cursor that would never move
 * again. Any buffering reverse proxy can do the same. The stream ending is therefore not a
 * signal that can be relied on, and silence is the only evidence of a drop that does not
 * depend on someone telling us.
 *
 * Every test here fires the timer on purpose rather than waiting for it — see
 * `test/fakeCountdown.ts`. That is what makes "a frame re-armed it" a statement about which
 * timers are outstanding instead of a statement about how fast this machine is.
 */
describe("the live transcript's silence watchdog", () => {
  const watching = async (): Promise<{
    app: App;
    fake: FakeServer;
    clock: FakeCountdown;
  }> => {
    const opened = open();
    opened.fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    await signIn(opened.app);
    opened.app.openTarget("acme-corp");
    await settle();
    return opened;
  };

  test("opening a connection arms it, at twice the server's heartbeat", async () => {
    const { clock } = await watching();
    expect(clock.live).toHaveLength(1);
    // The limit comes from the contract, where the server's heartbeat is also defined, so
    // the two cannot drift into a client that gives up on a healthy connection.
    expect(clock.latest.ms).toBe(LIVE_SILENCE_LIMIT_SECONDS * 1_000);
  });

  test("every frame re-arms it, and only one is ever outstanding", async () => {
    const { fake, clock } = await watching();
    const first = clock.latest;

    fake.watch.send(liveOpened({ from: 0, latest: 1 }));
    expect(first.cancelled).toBe(true);
    expect(clock.live).toHaveLength(1);

    const second = clock.latest;
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    expect(second.cancelled).toBe(true);
    expect(clock.live).toHaveLength(1);
  });

  /**
   * A heartbeat alone keeps it alive, which is the whole reason this cannot false-positive.
   *
   * The server sends a `LiveCursor` every heartbeat whether or not anything is happening, so
   * a quiet target and a long slow catch-up both keep producing frames. Keying liveness off
   * *items* would have made a run that is thinking for a minute look dead.
   */
  test("cursor frames alone keep it alive, so a quiet target is not read as dropped", async () => {
    const { app, fake, clock } = await watching();
    for (let beat = 1; beat <= 5; beat += 1) {
      const armed = clock.latest;
      fake.watch.send(liveCursor({ sequence: 0, caughtUp: true }));
      expect(armed.cancelled).toBe(true);
    }
    expect(app.liveWatching).toBe(true);
    expect(app.liveDetail).toBe("");
    expect(clock.live).toHaveLength(1);
  });

  test("a duplicate frame still counts as evidence of life", async () => {
    const { app, fake, clock } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    const armed = clock.latest;
    // Already shown, so it changes nothing on screen — but it arrived, so the socket works.
    // A reconnect that re-read a range would otherwise look like silence.
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    expect(armed.cancelled).toBe(true);
    expect(app.liveItems).toHaveLength(1);
  });

  test("when it fires, the tab stops claiming to be live and says why", async () => {
    const { app, fake, clock } = await watching();
    fake.watch.send(liveItem({ id: "record:e1", sequence: 1 }));
    clock.fire();

    expect(app.liveWatching).toBe(false);
    // The connection is actually closed, not merely relabelled: a socket left open would
    // keep a credential in use and go on buffering frames nobody reads.
    expect(fake.watch.stopped()).toBe(true);
    // Said as silence rather than as a diagnosis — we do not know it is dead, we know
    // nothing has arrived for long enough that it cannot be called live.
    expect(app.liveDetail).toContain("Reconnecting");
    expect(app.liveDetail).toContain(String(LIVE_SILENCE_LIMIT_SECONDS));
    // What arrived is kept, and so is the cursor: both are still true.
    expect(app.liveItems).toHaveLength(1);
    expect(app.liveCursor).toBe(1);
  });

  test("it waits before reconnecting after a silent connection", async () => {
    const { app, fake, clock } = await watching();
    const before = fake.watches.length;
    clock.fire();
    // Backoff avoids a hot loop against a stopped server.
    expect(fake.watches).toHaveLength(before);
    expect(app.liveReconnecting).toBe(true);
    expect(clock.latest.ms).toBe(1_000);
    clock.fire();
    expect(fake.watches).toHaveLength(before + 1);
    expect(fake.watch.cursor).toBe(app.liveCursor);
  });

  test("switching target cancels the old watchdog and arms one for the new connection", async () => {
    const { app, fake, clock } = await watching();
    const forOldTarget = clock.latest;

    app.openTarget("other-corp");
    await settle();
    expect(forOldTarget.cancelled).toBe(true);
    expect(clock.live).toHaveLength(1);

    // And the cancelled one cannot come back to life and blank the new target's transcript.
    fake.watches[1]?.send(liveItem({ id: "record:n1", sequence: 1 }));
    forOldTarget.fire();
    expect(app.liveWatching).toBe(true);
    expect(app.liveTargetId).toBe("other-corp");
    expect(app.liveDetail).toBe("");
    expect(app.liveItems).toHaveLength(1);
  });

  test("signing out cancels it", async () => {
    const { app, clock } = await watching();
    const armed = clock.latest;
    app.signOut();
    expect(armed.cancelled).toBe(true);
    expect(clock.live).toHaveLength(0);
  });

  test("resetting cancels it", async () => {
    const { app, clock } = await watching();
    const armed = clock.latest;
    app.reset();
    expect(armed.cancelled).toBe(true);
    expect(clock.live).toHaveLength(0);
  });

  test("stopping the connection cancels it", async () => {
    const { app, clock } = await watching();
    const armed = clock.latest;
    app.stopLive();
    expect(armed.cancelled).toBe(true);
    expect(clock.live).toHaveLength(0);
  });

  test("a connection that ends on its own cancels it, and keeps its own words", async () => {
    const { app, fake, clock } = await watching();
    const armed = clock.latest;
    fake.watch.close({ _tag: "failed", detail: "Failed to fetch" });
    expect(armed.cancelled).toBe(true);
    // The close said what happened; a watchdog firing afterwards would overwrite that with
    // a vaguer sentence about silence.
    expect(app.liveDetail).toContain("Reconnecting");
  });

  test("an expired session cancels it rather than leaving it to fire after sign-out", async () => {
    const { app, fake, clock } = await watching();
    const armed = clock.latest;
    fake.watch.close({ _tag: "unauthenticated" });
    expect(armed.cancelled).toBe(true);
    expect(app.screen).toBe("connect");
    expect(app.connectError).toBe("expired");
  });
});

describe("the goal conversation", () => {
  /** Signs in, opens a target holding one active goal, and opens that goal. */
  const onGoal = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    arrange(fake);
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    return [app, fake];
  };

  test("opening a goal reads its conversation, and a fresh goal has none", async () => {
    const [app, fake] = await onGoal();

    expect(fake.calls.map((call) => call.method)).toContain("goalConversation");
    expect(app.goalConversationState).toBe("ready");
    expect(app.goalConversationGoalId).toBe("goal_1");
    // `absent` is the default the fake answers with, and the chat renders it by showing no
    // group at all: "there is no conversation" is not one of the three ways a conversation
    // can have no prose.
    expect(app.goalConversation?.source).toBe("absent");
    expect(app.goalConversationChat.groups).toEqual([]);

    app.closeGoal();
    expect(app.goalConversation).toBeUndefined();
    expect(app.goalConversationGoalId).toBe("");
  });

  test("a sent message clears the composer and appears as this tab's own turn", async () => {
    const [app, fake] = await onGoal();
    app.goalMessage = "  look at the lockout path  ";
    await app.sendGoalMessage();

    const sent = fake.calls.find((call) => call.method === "sendGoalMessage");
    // Trimmed before it goes: the payload decoder refuses an empty message, and leading
    // whitespace is not something an operator meant to send.
    expect(sent?.args[3]).toBe("look at the lockout path");
    expect(app.goalMessage).toBe("");
    expect(app.goalSending).toBe(false);
    expect(app.goalTurns.map((turn) => turn.text)).toEqual([
      "look at the lockout path",
    ]);
    // The turn is in the chat, which now has a group even though the replay said `absent`:
    // the operator's own message is enough of a conversation to render.
    expect(app.goalConversationChat.groups).toHaveLength(1);
    expect(
      liveRows(app.goalConversationChat.groups[0]).map((row) => row.item.body),
    ).toEqual(["look at the lockout path"]);
    // And the agent owes an answer until something arrives for this goal.
    expect(app.goalAwaiting).toBe(true);
  });

  test("re-sending a sentence the replay already holds still shows it", async () => {
    /*
     * The false positive, end to end through the app rather than through `chat.ts` alone:
     * the replay is read when the goal opens, so by the time the operator types it is stale,
     * and a repeated short sentence must not be cancelled against the old entry.
     *
     * `goalConversationThrough` is what carries the bound — the number of turns sent when
     * the replay was *asked for*, which here is zero — and this test is what proves it is
     * plumbed rather than merely present in `chat.ts`.
     */
    const [app] = await onGoal((fake) => {
      fake.onGoalConversation = (_baseUrl, targetId, goalId) =>
        ok(
          goalConversationView({
            targetId,
            goalId,
            harnessSessionId: "ses_goal_1",
            live: true,
            source: "harness",
            ephemeral: true,
            items: [
              replayItem(0, "turn.operator", "ok"),
              replayItem(1, "turn.reply", "done"),
            ],
            note: "From OpenCode, which may delete it.",
          }),
        );
      fake.onSendGoalMessage = (_baseUrl, targetId, goalId) =>
        ok(
          goalTurnAccepted({
            targetId,
            goalId,
            conversation: "continued",
            note: "",
          }),
        );
    });
    expect(app.goalConversationThrough).toBe(0);

    app.goalMessage = "ok";
    await app.sendGoalMessage();
    await settle();

    expect(app.goalTurns.map((turn) => turn.text)).toEqual(["ok"]);
    // The row the operator just typed, on screen rather than swallowed.
    expect(
      liveRows(app.goalConversationChat.groups[0]).map((row) => row.item.body),
    ).toEqual(["ok"]);
  });

  test("a turn sent while the replay is in flight survives the answer", async () => {
    /*
     * The regression the bound exists to prevent, and the one the bound alone does not pin:
     * capturing `replayedThrough` **late** — when the replay returns rather than before the
     * request leaves — passes every other test in this suite while reintroducing the
     * swallowed message.
     *
     * The window is a real one: a replay round trip is long enough to type into, and the
     * answer describes the harness's log as of when the *request* left. A turn sent during
     * the trip cannot be in that answer, so it must never be cancelled against it — however
     * much the answer happens to agree with its text.
     */
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    fake.onGoalConversation = (_baseUrl, targetId, goalId) =>
      ok(
        goalConversationView({
          targetId,
          goalId,
          harnessSessionId: "ses_goal_1",
          live: true,
          source: "harness",
          ephemeral: true,
          // The answer agrees with what is about to be typed, which is what makes a
          // text-only cancellation fire.
          items: [replayItem(0, "turn.operator", "ok")],
          note: "From OpenCode, which may delete it.",
        }),
      );
    fake.onSendGoalMessage = (_baseUrl, targetId, goalId) =>
      ok(
        goalTurnAccepted({
          targetId,
          goalId,
          // `continued`, so the send does not itself re-read the replay: the one read under
          // test has to still be the one in flight.
          conversation: "continued",
          note: "",
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();

    // The replay is held open from before the goal is opened, so it is in flight for the
    // whole of the send below.
    const answer = fake.hold("goalConversation");
    app.openGoal("goal_1");
    await settle();
    expect(app.goalConversationState).toBe("loading");

    app.goalMessage = "ok";
    await app.sendGoalMessage();
    expect(app.goalTurns.map((turn) => turn.text)).toEqual(["ok"]);

    // Now the replay lands, carrying an "ok" of its own from earlier in the history.
    answer();
    await settle();

    expect(app.goalConversationState).toBe("ready");
    /*
     * The operator's own words, still on the screen. **This assertion first**, because it
     * is the defect: with the capture moved late this reads `[]` — the message was
     * delivered and is nowhere to be seen — and a test that failed on the bookkeeping
     * instead would report the cause rather than the harm.
     */
    expect(
      liveRows(app.goalConversationChat.groups[0]).map((row) => row.item.body),
    ).toEqual(["ok"]);
    // And the bookkeeping that makes it true: captured before the request left, so a turn
    // sent during the trip is out of this answer's reach. A late capture reads
    // `goalTurns.length` here and makes it 1.
    expect(app.goalConversationThrough).toBe(0);
  });

  test("leaving a goal and coming back cannot let the old answer swallow a re-sent turn", async () => {
    /*
     * The A → B → A navigation, and the reason `replayedThrough` alone could not hold it.
     *
     * That bound is a **count** — how many of this tab's turns had been sent when a replay
     * was asked for — and `#clearGoalConversation` renumbers turns from 1 on every
     * navigation. So an answer to the first visit's read, landing after the operator has
     * been to another goal and back, passes the `openGoalId === goalId` guard (it is the
     * same goal), installs the first visit's count of 1, and makes the second visit's
     * freshly re-sent turn 1 a cancellation candidate again. If the stale replay happens to
     * contain that sentence — "ok", "yes", "continue" — the message is delivered and
     * appears nowhere, which is the exact harm slice 9 called worse than showing it twice.
     *
     * A per-visit token is the fix: an answer from a visit nobody is on is dropped whole.
     *
     * `holdOne` rather than `hold`, and that is what makes this reproducible at all: the
     * stale answer has to land **after** the two reads the navigation itself issues, or the
     * last writer wins and the defect hides.
     */
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({
        goals: [
          goalView({ targetId, goalId: "goal_1" }),
          goalView({ targetId, goalId: "goal_2" }),
        ],
      });
    fake.onGoalConversation = (_baseUrl, targetId, goalId) =>
      ok(
        goalConversationView({
          targetId,
          goalId,
          harnessSessionId: "ses_goal_1",
          live: true,
          source: "harness",
          ephemeral: true,
          // An "ok" from earlier in the history, which is what a text-only cancellation
          // fires on.
          items: [replayItem(0, "turn.operator", "ok")],
          note: "From OpenCode, which may delete it.",
        }),
      );
    fake.onSendGoalMessage = (_baseUrl, targetId, goalId) =>
      ok(
        goalTurnAccepted({
          targetId,
          goalId,
          // `continued`, so a send never re-reads the replay: the reads in this test are
          // exactly the three the navigation makes.
          conversation: "continued",
          note: "",
        }),
      );
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();

    // Visit one, with a turn of its own, so the read below is asked for with a count of 1.
    app.openGoal("goal_1");
    await settle();
    app.goalMessage = "ok";
    await app.sendGoalMessage();
    expect(app.goalTurns).toHaveLength(1);

    // The stale read: asked for during visit one, parked, and released at the end.
    const releaseStale = fake.holdOne("goalConversation");
    void app.loadGoalConversation("goal_1");

    // Away and back. Both visits' own reads answer immediately, because the gate above was
    // one-shot.
    app.openGoal("goal_2");
    await settle();
    app.openGoal("goal_1");
    await settle();
    // Visit three's turns are numbered from 1 again, which is the whole mechanism.
    expect(app.goalTurns).toEqual([]);

    app.goalMessage = "ok";
    await app.sendGoalMessage();
    expect(app.goalTurns.map((turn) => turn.index)).toEqual([1]);

    // And now the first visit's answer arrives.
    releaseStale();
    await settle();

    /*
     * The operator's own words, still on screen. **This assertion first**, because it is
     * the harm: without the token this reads `[]` — the message reached the agent and the
     * chat shows nothing, so the operator cannot tell whether it was sent.
     */
    expect(
      liveRows(app.goalConversationChat.groups[0]).map((row) => row.item.body),
    ).toEqual(["ok"]);
    // The bookkeeping underneath it: the stale answer installed nothing, so the bound is
    // still visit three's own zero rather than visit one's one.
    expect(app.goalConversationThrough).toBe(0);
  });

  test("a refused message keeps the text and says why, with no turn invented", async () => {
    const [app] = await onGoal((fake) => {
      fake.onSendGoalMessage = () =>
        refused(
          new GoalConversationRefused({
            reason: "goal_not_active",
            detail: "goal goal_1 is abandoned, so its authority has ended",
          }),
        );
    });
    app.goalMessage = "anything";
    await app.sendGoalMessage();

    // The agent did not hear it, so there is no row claiming it did — a chat that invented
    // a turn for a refused message would be the one lie this surface cannot afford.
    expect(app.goalTurns).toEqual([]);
    expect(app.goalConversationChat.groups).toEqual([]);
    // The text stays, so it can be sent again once whatever was wrong is fixed.
    expect(app.goalMessage).toBe("anything");
    expect(app.goalSendDetail).toContain("abandoned");
  });

  test("a turn that opened a conversation after a restart says so above the composer", async () => {
    /*
     * The spec's §5, as the operator meets it. The grant died with the process and the row
     * did not, so this message opened a *new* conversation — and the words still on screen
     * belong to the old one. A silent second conversation on the same goal looks from here
     * exactly like the old one continuing, which is why the note is rendered rather than
     * logged.
     */
    const [app] = await onGoal((fake) => {
      fake.onGoalConversation = (_baseUrl, targetId, goalId) =>
        ok(
          goalConversationView({
            targetId,
            goalId,
            harnessSessionId: "ses_before",
            live: false,
            source: "harness",
            ephemeral: true,
            items: [replayItem(0, "turn.reply", "earlier words")],
            note: "From Claude Code. This conversation was opened by a server process that is no longer running.",
          }),
        );
      fake.onSendGoalMessage = (_baseUrl, targetId, goalId) =>
        ok(
          goalTurnAccepted({
            targetId,
            goalId,
            harnessSessionId: "ses_after",
            conversation: "opened",
            priorUnavailable: true,
            note: "This goal had a conversation on session ses_before, which this server process no longer holds — a restart ends a conversation.",
          }),
        );
    });

    // Before the message: the words are here and the conversation is not continuable.
    expect(app.goalConversation?.live).toBe(false);
    expect(app.goalConversationChat.groups[0]?.prose._tag).toBe("replayed");

    app.goalMessage = "are you still there?";
    await app.sendGoalMessage();
    await settle();

    expect(app.goalSessionNote).toContain("restart ends a conversation");
    expect(app.goalSessionNote).toContain("ses_before");
  });

  test("a continued turn says nothing new and does not re-read the replay", async () => {
    const [app, fake] = await onGoal((fake) => {
      fake.onSendGoalMessage = (_baseUrl, targetId, goalId) =>
        ok(
          goalTurnAccepted({
            targetId,
            goalId,
            conversation: "continued",
            priorUnavailable: false,
            note: "",
          }),
        );
    });
    const readsBefore = fake.calls.filter(
      (call) => call.method === "goalConversation",
    ).length;

    app.goalMessage = "and the admin console?";
    await app.sendGoalMessage();
    await settle();

    // Nothing to say: a continued turn changes nothing the replay said, and re-reading it
    // would replace the block an operator is reading mid-sentence.
    expect(app.goalSessionNote).toBe("");
    expect(
      fake.calls.filter((call) => call.method === "goalConversation").length,
    ).toBe(readsBefore);
  });

  test("narration for this goal answers the turn and clears the waiting state", async () => {
    const [app, fake] = await onGoal();
    app.goalMessage = "what is happening?";
    await app.sendGoalMessage();
    expect(app.goalAwaiting).toBe(true);

    // The agent's reply, over the target's own live connection, carrying the goal it
    // belongs to — which is the field that puts it in this conversation rather than in the
    // planner's.
    fake.watch.send(liveOpened());
    fake.watch.send(
      liveActivity({
        // `activity:<n>` is the server's own id for a narration entry, and the number is
        // what the join reads: an id this tab could not parse would be treated as having
        // no order at all, which is right for a record and wrong for narration.
        id: "activity:7",
        goalId: "goal_1",
        roundId: null,
        kind: "turn.reply",
        body: "One round has run so far.",
      }),
    );
    await settle();

    expect(app.goalAwaiting).toBe(false);
    expect(
      liveRows(app.goalConversationChat.groups[0]).map((row) => row.item.body),
    ).toEqual(["what is happening?", "One round has run so far."]);
  });
});

/* ── The context meter ───────────────────────────────────────────────────────── */

/**
 * What this tab does with the usage frames, which is: keep the newest per session.
 *
 * `chat.ts` decides what a figure *says*; this is about which frame a pane is looking at,
 * and the two things that must not happen. A meter that summed these would read four to
 * five times high, because both drivers' cumulative figures re-count the cached prefix per
 * call (DECISIONS.md §24.4). A meter that showed the newest frame on the *target* would
 * show the planner round's context above the goal conversation and never say so.
 */
describe("the context meter", () => {
  const onGoal = async (
    arrange: (fake: FakeServer) => void = () => {},
  ): Promise<[App, FakeServer]> => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);
    fake.onGoals = (_baseUrl, targetId) =>
      ok({ goals: [goalView({ targetId, goalId: "goal_1" })] });
    fake.onGoalRounds = () =>
      ok({ rounds: [planRoundView({ roundId: "rnd_1" })] });
    arrange(fake);
    await signIn(app);
    app.openTarget("acme-corp");
    await settle();
    app.openGoal("goal_1");
    await settle();
    return [app, fake];
  };

  const usage = (over: Partial<LiveUsage> = {}): LiveUsage => ({
    _tag: "usage",
    callId: "msg_1",
    promptTokens: 11_050,
    outputTokens: 0,
    contextLimit: 200_000,
    compactionAt: 170_000,
    attemptId: null,
    roundId: "rnd_1",
    goalId: null,
    importId: null,
    at: AT,
    ...over,
  });

  test("each session's own call, and the newest of them, is what its pane shows", async () => {
    const [app, fake] = await onGoal();
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));

    // The probe's first four calls on one round. The context grows and the figure follows
    // the last one — it is not the sum of them, which would be 52 085.
    for (const [callId, promptTokens] of [
      ["msg_1", 11_050],
      ["msg_2", 13_572],
      ["msg_3", 13_646],
      ["msg_4", 13_693],
    ] as const) {
      fake.watch.send(usage({ callId, promptTokens, outputTokens: 45 }));
    }
    await settle();
    expect(app.plannerContextMeter?.callId).toBe("msg_4");
    expect(app.plannerContextMeter?.tokens).toBe(13_738);
    expect(app.plannerContextMeter?.percent).toBe(7);

    // The goal's own agent is a different session, a different model and a different
    // window, and its pane says so rather than borrowing the round's figure.
    expect(app.goalContextMeter).toBeUndefined();
    fake.watch.send(
      usage({
        callId: "msg_g1",
        roundId: null,
        goalId: "goal_1",
        promptTokens: 21_388,
        outputTokens: null,
        contextLimit: 1_000_000,
      }),
    );
    await settle();
    expect(app.goalContextMeter?.tokens).toBe(21_388);
    expect(app.goalContextMeter?.outputStated).toBe(false);
    // And the planner's is untouched by it.
    expect(app.plannerContextMeter?.tokens).toBe(13_738);
  });

  test("a repeat of one call's id replaces it rather than counting twice", async () => {
    const [app, fake] = await onGoal();
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));

    /*
     * Claude Code's shape: one API call arrives as several frames repeating one
     * `message.id` with a stale output count, and the turn's `result` then states the real
     * one under that same id. Three frames, one call: 21 388 sent, 16 generated.
     */
    fake.watch.send(
      usage({ callId: "msg_a", promptTokens: 21_388, outputTokens: null }),
    );
    fake.watch.send(
      usage({ callId: "msg_a", promptTokens: 21_388, outputTokens: null }),
    );
    fake.watch.send(
      usage({ callId: "msg_a", promptTokens: 21_388, outputTokens: 16 }),
    );
    await settle();

    expect(app.plannerContextMeter?.tokens).toBe(21_404);
    expect(app.plannerContextMeter?.outputStated).toBe(true);
    // Not three calls' worth, which is what a counter would have made of it.
    expect(app.plannerContextMeter?.tokens).not.toBe(21_388 * 3);
  });

  test("a usage frame is not a transcript row, and does not dedupe like one", async () => {
    const [app, fake] = await onGoal();
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(usage());
    fake.watch.send(usage({ promptTokens: 13_572 }));
    await settle();

    // Nothing of it reaches the items, so no chat renders a row per model call.
    expect(app.liveItems).toEqual([]);
    // And the second frame was applied rather than dropped as a duplicate: these carry no
    // item id, and "already shown" is not a question about a measurement.
    expect(app.plannerContextMeter?.promptTokens).toBe(13_572);
  });

  test("leaving the target leaves its figures behind", async () => {
    const [app, fake] = await onGoal();
    fake.watch.send(liveOpened({ from: 0, latest: 0 }));
    fake.watch.send(usage());
    await settle();
    expect(app.plannerContextMeter).toBeDefined();

    // Another target's screen must not carry this one's context figure, for the reason its
    // items do not.
    app.openTarget("other-target");
    await settle();
    expect(app.liveUsage).toEqual({});
  });
});
