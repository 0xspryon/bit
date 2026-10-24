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
  PathRefused,
  RunRefused,
  SessionRefused,
  TargetNotFound,
  TargetRefused,
  TargetUnavailable,
  Unauthenticated,
} from "@bit/contracts";

import { App, fromSummary } from "../src/lib/app.svelte";
import {
  AT,
  FakeServer,
  attemptTranscript,
  harnessInstance,
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

/** An app and the double it talks to, wired together and nothing else done to them. */
const open = (): { app: App; fake: FakeServer } => {
  const fake = new FakeServer();
  return { app: new App(fake), fake };
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

    app.instruction = "  enumerate the subdomains  ";
    await app.startRun();

    expect(app.activeRun?.attemptId).toBe("attempt-7");
    // Readable later, which is the only handle this tab keeps on a settled attempt.
    expect(app.readableAttemptId).toBe("attempt-7");
    // Cleared only once the server accepted it, and trimmed on the way out.
    expect(app.instruction).toBe("");
    expect(app.runDetail).toBe("");
    const started = fake.calls.find((call) => call.method === "startRun");
    expect(started?.args[2]).toBe("enumerate the subdomains");
    expect(app.starting).toBe(false);
  });

  /**
   * Two of the refusals the compose box exists to show. Both are normal answers rather
   * than faults, and in both cases what the operator typed has to survive — a box that
   * emptied optimistically would lose the instruction every time.
   */
  test.each([
    ["workspace_busy", "another run is already working in /work/acme-corp"],
    ["harness_not_ready", "Claude Code is configured but not authenticated"],
  ] as const)("a %s refusal surfaces its text", async (reason, detail) => {
    const [app, fake] = await onTarget();
    fake.onStartRun = () => refused(new RunRefused({ reason, detail }));

    app.instruction = "enumerate the subdomains";
    await app.startRun();

    expect(app.runDetail).toBe(detail);
    expect(app.instruction).toBe("enumerate the subdomains");
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

    app.instruction = "enumerate the subdomains";
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

    app.instruction = "enumerate the subdomains";
    await app.startRun();
    await app.stopRun();

    expect(app.runDetail).toBe("that attempt is not running");
    expect(app.activeRun).toBeUndefined();
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
    app.instruction = "enumerate the subdomains";
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
    app.instruction = "enumerate the subdomains";
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
