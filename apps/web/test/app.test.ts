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
  GoalNotFound,
  GoalRefused,
  IntentRefused,
  LIVE_SILENCE_LIMIT_SECONDS,
  PathRefused,
  RunRefused,
  SessionRefused,
  TargetNotFound,
  TargetRefused,
  TargetUnavailable,
  Unauthenticated,
} from "@bit/contracts";

import { App, fromSummary } from "../src/lib/app.svelte";
import { FakeCountdown } from "./fakeCountdown";
import {
  AT,
  FakeServer,
  attemptTranscript,
  goalView,
  harnessInstance,
  intentView,
  liveActivity,
  liveCursor,
  liveItem,
  liveOpened,
  ok,
  refused,
  runStarted,
  runningAttempt,
  sessionProbe,
  targetSummary,
  targetView,
  unreachable,
} from "./fakeServer";

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

/* ── The New target dialog ───────────────────────────────────────────────────── */

describe("new target", () => {
  /** Walks the dialog to the point where `createTarget()` will do something. */
  const choose = async (app: App, path: string): Promise<void> => {
    await signIn(app);
    app.openDialog();
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
    // The dialog stays up: there is an offer on it to accept.
    expect(app.dialogOpen).toBe(true);
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

  test("a name the server will not take is denied, not a duplicate", async () => {
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

    expect(app.createState).toBe("denied");
    expect(app.duplicateOf).toBe("");
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
    fake.onCreateTarget = () => ok(broken);
    fake.onTargets = () => ok([broken]);

    await choose(app, "/work/example");
    await app.createTarget();

    expect(app.createState).toBe("failed");
    expect(app.createDetail).toBe(
      'migrate failed: Migration "1_delegation_memory_slice" failed',
    );
    // Up, so the operator reads why — and listed, because it does exist.
    expect(app.dialogOpen).toBe(true);
    expect(app.targets.map((target) => target.id)).toEqual(["example"]);
    expect(app.targets[0]?.status).toBe("missing");
  });

  test("a target that is created appears on the rail and is selected", async () => {
    const { app, fake } = open();
    const created = targetSummary({ id: "example", name: "example" });
    fake.onCreateTarget = () => ok(created);
    // The rail is re-read rather than appended to locally, so this is what it becomes.
    fake.onTargets = () => ok([created]);

    await choose(app, "/work/example");
    await app.createTarget();

    expect(app.dialogOpen).toBe(false);
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

/* ── The stale-row inference ─────────────────────────────────────────────────── */

/**
 * A transcript is evidence about whether a run is over, and only one of the three
 * sources is evidence that it is.
 *
 * The server writes its own artefact inside the settlement finalizer, after the attempt
 * row and its `attempt.settled` event — so `source: "recorded"` cannot exist for a run
 * that is still going, and seeing one is grounds to go and re-read the running list.
 * `harness` says only that the harness still holds the session, which says nothing about
 * whether the run finished; `absent` is also what a foreign instance and an attempt with
 * no session return. Inferring from either would clear a row for a run that is still
 * working, which is the worse of the two mistakes.
 *
 * This is the most recently changed behaviour in the file and had been checked only by
 * hand, which is why all three sources are pinned rather than just the interesting one.
 */
describe("a transcript that settles a running row", () => {
  /**
   * One running row, one transcript read, and a server that has since noticed the run is
   * over. Whether the row clears is then entirely down to the source.
   */
  const afterReading = async (
    source: "recorded" | "harness" | "absent",
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

  test("a recorded transcript clears the running row", async () => {
    const { app } = await afterReading("recorded");
    expect(app.transcript?.source).toBe("recorded");
    expect(app.runs).toEqual([]);
    expect(app.activeRun).toBeUndefined();
  });

  test.each(["harness", "absent"] as const)(
    "a %s transcript leaves the running row alone",
    async (source) => {
      const { app, fake, runsBefore } = await afterReading(source);
      expect(app.transcript?.source).toBe(source);
      expect(app.activeRun?.attemptId).toBe("attempt-7");
      // Not merely unchanged by luck: the list was never asked for again.
      expect(fake.countOf("runs")).toBe(runsBefore);
    },
  );

  /** An absent transcript is a success. `transcriptDetail` is for a silent server only. */
  test("an absent transcript is not an error", async () => {
    const { app } = await afterReading("absent");
    expect(app.transcriptDetail).toBe("");
    expect(app.transcriptLoading).toBe(false);
  });

  test("a server that does not answer is reported as unreachable", async () => {
    const { app, fake } = open();
    fake.onTranscript = () => unreachable("Failed to fetch");
    await signIn(app);
    await app.loadTranscript("acme-corp", "attempt-7");

    expect(app.transcript).toBeUndefined();
    expect(app.transcriptDetail).toBe("No server answered at this address.");
  });
});

/* ── Deep links ──────────────────────────────────────────────────────────────── */

/**
 * `?target=<id>` is read out of the URL by the route and handed here as
 * {@link App.requestTarget}; what the route does with the URL afterwards is the route's,
 * and is not asserted below because that needs a DOM. What *is* here is the half that
 * decides whether the link works: the id is parked until there is a session, acted on
 * once the rail is in hand, and cleared either way.
 */
describe("deep links", () => {
  test("a link to a target opens that target once there is a session", async () => {
    const { app, fake } = open();
    fake.onTargets = () =>
      ok([
        targetSummary({ id: "acme-corp" }),
        targetSummary({ id: "scratch" }),
      ]);
    fake.onTarget = (_baseUrl, targetId) =>
      ok(targetView(targetSummary({ id: targetId, name: targetId })));

    // Arrives before there is a session, which is the case that matters.
    app.requestTarget("scratch");
    expect(app.screen).toBe("connect");

    await signIn(app);
    await settle();

    expect(app.screen).toBe("target");
    expect(app.viewTargetId).toBe("scratch");
    expect(app.selectedId).toBe("scratch");
    expect(app.viewState).toBe("ready");
    expect(app.requestedTargetId).toBe("");
  });

  test("a link resumed from a reload opens the same target", async () => {
    const { app, fake } = open();
    fake.stored = "token-from-a-reload";
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    app.requestTarget("acme-corp");
    await app.restore();
    await settle();

    expect(app.screen).toBe("target");
    expect(app.viewTargetId).toBe("acme-corp");
  });

  /**
   * Dropped here and not retried. The list is already on screen and is the honest answer
   * to "that target is not on this server"; re-asking on every refresh would be the link
   * following the operator around.
   */
  test("a link to a target this server does not have lands on the list", async () => {
    const { app, fake } = open();
    fake.onTargets = () => ok([targetSummary({ id: "acme-corp" })]);

    app.requestTarget("a-target-from-another-server");
    await signIn(app);

    expect(app.screen).toBe("welcome");
    expect(app.viewTargetId).toBe("");
    // Cleared, so the next `openRequested()` does not try it again.
    expect(app.requestedTargetId).toBe("");
    expect(fake.countOf("target")).toBe(0);
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
