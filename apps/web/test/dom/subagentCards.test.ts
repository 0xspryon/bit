/**
 * A7-S's sub-agent cards (E7) and panel (E8) on the real importer page: each state of a
 * card, Stop hidden with its reason where a sub-agent has none of its own, the title-bar
 * chip's counts, the panel's groups, selecting a row scrolls to its card, Stop all in Stop's
 * place, a card's Stop and the 560px rail rule. Strings and booleans only — never a node in
 * an assertion.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type {
  ImporterSessionView,
  LiveItem,
  PendingQuestion,
  SubagentView,
} from "@bit/contracts";

import { App } from "../../src/lib/app.svelte";
import { FakeCountdown } from "../fakeCountdown";
import {
  FakeServer,
  emptyScope,
  importerConversationView,
  importerSessionView,
  ok,
  refused,
} from "../fakeServer";
import ImporterPage from "./fixtures/ImporterPage.svelte";
import { click, mountInto, settle, type Mounted } from "./dom";

let mounted: Mounted[] = [];
let restore: (() => void)[] = [];
afterEach(() => {
  for (const each of mounted) each.destroy();
  mounted = [];
  for (const undo of restore) undo();
  restore = [];
});

const SESSIONS: ImporterSessionView[] = [
  importerSessionView({
    sessionId: "ses_newest",
    importId: "imp_newest",
    model: "anthropic/claude-newest",
    harnessInstanceId: "claude-code",
    openedAt: 1_700_000_200_000,
  }),
];

const NOW = Date.now();

const view = (over: Partial<SubagentView> = {}): SubagentView => ({
  callId: "toolu_run",
  tool: "Agent",
  agentType: "general-purpose",
  description: "Login-flow mapper",
  task: "Map every step of /login, /sso and /reset",
  background: true,
  status: "running",
  startedAt: NOW - 72_000,
  endedAt: null,
  calls: 9,
  lines: [
    {
      tool: "http_request",
      input: "GET /sso/callback?state=…",
      result: "302",
      failed: false,
    },
    {
      tool: "http_request",
      input: "GET /reset?token=…",
      result: null,
      failed: false,
    },
  ],
  activity: "Comparing the reset token's lifetime against the session cookie…",
  result: null,
  failure: null,
  stop: "own",
  ...over,
});

let nextId = 0;
const item = (subagent: SubagentView): LiveItem => ({
  _tag: "item",
  id: `replay:${String((nextId += 1))}`,
  origin: "activity",
  sequence: null,
  kind: "subagent",
  at: NOW - 80_000,
  attemptId: null,
  roundId: null,
  goalId: null,
  importId: "imp_newest",
  headline: subagent.agentType ?? "sub-agent",
  body: subagent.description,
  tool: subagent.tool,
  toolName: subagent.tool,
  input: null,
  output: null,
  callId: subagent.callId,
  outcome: subagent.status,
  subagent,
});

const operator = (text: string): LiveItem => ({
  ...item(view()),
  id: "replay:0",
  kind: "turn.operator",
  headline: "You",
  body: text,
  tool: null,
  toolName: null,
  callId: null,
  outcome: null,
  subagent: undefined as never,
});

const RUNNING = view();
const FOREGROUND = view({
  callId: "toolu_fg",
  description: "Scope reader",
  task: "Confirm what is in scope",
  background: false,
  stop: "with_turn",
  calls: 2,
  lines: [],
  activity: "Reading scope.md",
});
const FINISHED = view({
  callId: "toolu_done",
  description: "Endpoint census",
  task: "Enumerate unauthenticated API routes",
  status: "finished",
  startedAt: NOW - 200_000,
  endedAt: NOW - 39_000,
  calls: 34,
  activity: null,
  result:
    "23 routes under /api/v2; 4 answer without a session — /users/lookup, /export, /flags, /health.",
  stop: "none",
});
const FAILED = view({
  callId: "toolu_failed",
  description: "acmelabs.io crawler",
  task: "Crawl and fingerprint acmelabs.io",
  status: "failed",
  startedAt: NOW - 100_000,
  endedAt: NOW - 42_000,
  calls: 17,
  activity: null,
  failure: {
    reason: "The sub-agent failed",
    error: "429 from openai, window resets 01:30",
  },
  stop: "none",
});
const STOPPED = view({
  callId: "toolu_stopped",
  description: "Token analyser",
  status: "stopped",
  startedAt: NOW - 60_000,
  endedAt: NOW - 50_000,
  activity: null,
  lines: [{ tool: "Bash", input: "sleep 60", result: "stopped", failed: true }],
  stop: "none",
});

/** The newest session continued on the Assets page, its replay holding `subagents`. */
const continueWith = async (
  fake: FakeServer,
  subagents: readonly SubagentView[],
  options: {
    readonly working?: boolean;
    /** The replay's items instead of the operator's message and these sub-agents. */
    readonly items?: readonly LiveItem[];
    readonly question?: PendingQuestion | null;
  } = {},
): Promise<App> => {
  fake.onScope = () => ok(emptyScope());
  fake.onImporterSessions = () =>
    ok({
      sessions: SESSIONS.map((each) => ({
        ...each,
        ...(options.working === true ? { working: true } : {}),
      })),
    });
  fake.onHarnesses = () =>
    ok([
      {
        instanceId: "claude-code",
        driver: "claude-code",
        displayName: "Claude Code",
        version: "1.0.0",
        ready: true,
        auth: "authenticated" as const,
        isDefault: true,
        defaultModel: "m",
        models: [{ id: "m" }],
      },
    ]);
  fake.onImporterMessages = (_baseUrl, targetId, importId) =>
    ok(
      importerConversationView({
        targetId,
        importId,
        live: true,
        continuation: "live",
        items: options.items ?? [
          operator("Map the auth surface."),
          ...subagents.map(item),
        ],
        question: options.question ?? null,
      }),
    );
  const app = new App(fake, new FakeCountdown());
  app.password = "correct-horse";
  await app.connect();
  app.openTarget("acme-corp");
  await settle();
  app.toSection("assets");
  await settle();
  app.toAssetsTab("scope");
  await settle();
  mounted.push(mountInto(ImporterPage, { app }));
  await settle();
  click(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) =>
      (each.textContent ?? "").includes("Continue that session"),
    )!,
  );
  await settle();
  return app;
};

const card = (callId: string) =>
  document.querySelector<HTMLElement>(`#subagent-${callId}`);
const text = (node: Element | null | undefined) =>
  (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const chip = () => document.querySelector<HTMLButtonElement>(".subagents-chip");
const panel = () => document.querySelector<HTMLElement>("#subagent-panel");

describe("sub-agent cards (A7-S, E7)", () => {
  test("a running card shows its last tool lines, what it is doing now, its time and call count, and its Stop", async () => {
    await continueWith(new FakeServer(), [RUNNING]);
    const running = card("toolu_run");
    expect(running?.getAttribute("data-status")).toBe("running");
    expect(text(running?.querySelector(".name"))).toBe("Login-flow mapper");
    expect(text(running?.querySelector(".task"))).toBe(
      "Map every step of /login, /sso and /reset",
    );
    expect(text(running?.querySelector(".meta"))).toBe("1m 12s · 9 calls");
    expect(
      [...(running?.querySelectorAll(".line") ?? [])].map((line) => text(line)),
    ).toEqual([
      ">_ http_request GET /sso/callback?state=… → answered 302",
      ">_ http_request GET /reset?token=… running",
    ]);
    expect(text(running?.querySelector(".activity"))).toBe(
      "Comparing the reset token's lifetime against the session cookie…",
    );
    expect(text(running?.querySelector(".stop"))).toBe("Stop");
    expect(running?.querySelector(".withheld")).toBeNull();
    // "Open its thread" is there, and disabled until V2.
    const thread = running?.querySelector<HTMLButtonElement>(".thread");
    expect(thread?.disabled).toBe(true);
    expect(thread?.title).toContain("V2");
    // The card is inside the chat's own row for it.
    expect(running?.closest("li.subagent-card")).not.toBeNull();
  });

  test("a finished card quotes what it returned; a failed one is tinted with the reason and the raw error; a stopped one says so", async () => {
    await continueWith(new FakeServer(), [FINISHED, FAILED, STOPPED]);
    const finished = card("toolu_done");
    expect(text(finished?.querySelector(".eyebrow"))).toBe(
      "Returned to the importer",
    );
    expect(text(finished?.querySelector(".quote"))).toBe(
      "23 routes under /api/v2; 4 answer without a session — /users/lookup, /export, /flags, /health.",
    );
    expect(text(finished?.querySelector(".meta"))).toBe("2m 41s · 34 calls");
    expect(finished?.querySelector(".lines")).toBeNull();
    expect(finished?.querySelector(".stop")).toBeNull();

    const failed = card("toolu_failed");
    expect(failed?.getAttribute("data-status")).toBe("failed");
    expect(text(failed?.querySelector(".meta"))).toBe("failed at 58s");
    expect(text(failed?.querySelector(".reason"))).toBe(
      "The sub-agent failed after 17 calls",
    );
    expect(text(failed?.querySelector(".raw"))).toBe(
      "429 from openai, window resets 01:30",
    );
    expect(text(failed)).toContain("What it did before it failed is kept.");

    const stopped = card("toolu_stopped");
    expect(text(stopped?.querySelector(".meta"))).toBe("stopped at 10s");
    expect(text(stopped)).toContain("Stopped before it finished.");
    expect(text(stopped?.querySelector(".line"))).toBe(
      ">_ Bash sleep 60 → answered stopped",
    );
  });

  test("a foreground sub-agent has no Stop of its own, and says why where it would be", async () => {
    await continueWith(new FakeServer(), [FOREGROUND]);
    const foreground = card("toolu_fg");
    expect(foreground?.querySelector(".stop")).toBeNull();
    expect(text(foreground?.querySelector(".withheld"))).toBe(
      "No Stop of its own: it runs inside the importer's turn, and Stop all stops the turn with it.",
    );
  });

  test("the sub-agent's words are plain text: no markup in its name, task, lines, quote or error", async () => {
    const markup =
      '<img src=x onerror="alert(1)"> **bold** [a](https://evil.example/)';
    await continueWith(new FakeServer(), [
      view({
        callId: "toolu_x",
        description: markup,
        task: markup,
        status: "finished",
        result: markup,
        lines: [{ tool: markup, input: markup, result: markup, failed: false }],
      }),
      view({
        callId: "toolu_y",
        status: "failed",
        failure: { reason: markup, error: markup },
      }),
    ]);
    for (const callId of ["toolu_x", "toolu_y"]) {
      expect(
        card(callId)?.querySelector("img, a, strong:not(.reason strong) em"),
      ).toBeNull();
      expect(card(callId)?.querySelector("img")).toBeNull();
      expect(card(callId)?.querySelector("a")).toBeNull();
    }
    expect(text(card("toolu_x")?.querySelector(".quote"))).toBe(markup);
    expect(text(card("toolu_y")?.querySelector(".raw"))).toBe(markup);
  });

  test("its details fold away and back, and the toggle says which", async () => {
    await continueWith(new FakeServer(), [RUNNING]);
    const fold = card("toolu_run")?.querySelector<HTMLButtonElement>(".fold");
    expect(fold?.getAttribute("aria-expanded")).toBe("true");
    click(fold!);
    await settle();
    expect(card("toolu_run")?.querySelector(".body")).toBeNull();
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    click(fold!);
    await settle();
    expect(card("toolu_run")?.querySelector(".body")).not.toBeNull();
  });

  test("a card's Stop goes to the server for that sub-agent of the session's import, and a refusal is the F2 dialog", async () => {
    const fake = new FakeServer();
    await continueWith(fake, [RUNNING]);
    click(card("toolu_run")!.querySelector<HTMLButtonElement>(".stop")!);
    await settle();
    const [call] = fake.calls
      .filter((each) => each.method === "stopImporterSubagent")
      .map((each) => each.args);
    expect(JSON.stringify(call?.slice(1))).toBe(
      JSON.stringify(["acme-corp", "imp_newest", "toolu_run"]),
    );
    fake.onStopImporterSubagent = () =>
      refused({
        _tag: "SubagentStopRefused",
        reason: "not_running",
        detail:
          "The sub-agent is no longer running, or this session did not start it.",
      } as never);
    click(card("toolu_run")!.querySelector<HTMLButtonElement>(".stop")!);
    await settle();
    const dialog = document.querySelector("[role=alertdialog], [role=dialog]");
    expect(text(dialog)).toContain("Sub-agent not stopped");
    expect(text(dialog)).toContain("no longer running");
  });
});

describe("Stop all, in Stop's place (A7-S, E7)", () => {
  test("while a sub-agent runs the pill reads Stop all and stops the sub-agents then the turn; with none running it is Stop", async () => {
    const fake = new FakeServer();
    await continueWith(fake, [RUNNING, FINISHED]);
    const pills = () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".importer button.stop",
        ),
      ].filter((each) => each.closest(".card") === null);
    expect(pills().map((each) => text(each))).toEqual(["Stop all"]);
    expect(pills()[0]?.title).toBe(
      "Stop the importer's sub-agents, then its turn",
    );
    click(pills()[0]!);
    await settle();
    expect(fake.countOf("stopImporterAll")).toBe(1);
    expect(fake.countOf("stopImporterTurn")).toBe(0);
  });

  test("with no sub-agent running there is no Stop all", async () => {
    await continueWith(new FakeServer(), [FINISHED, FAILED]);
    const pills = [
      ...document.querySelectorAll<HTMLButtonElement>(".importer button.stop"),
    ].filter((each) => each.closest(".card") === null);
    expect(pills.map((each) => text(each))).toEqual([]);
  });
});

describe("the sub-agents chip and panel (A7-S, E8)", () => {
  test("the chip in the title bar counts every sub-agent, with running and failed beside it", async () => {
    await continueWith(new FakeServer(), [
      RUNNING,
      FINISHED,
      FAILED,
      STOPPED,
      FOREGROUND,
    ]);
    expect(chip()?.closest(".right")).not.toBeNull();
    expect(text(chip()?.querySelector(".label"))).toBe("5 sub-agents");
    expect(text(chip()?.querySelector(".count.running"))).toBe("2");
    expect(text(chip()?.querySelector(".count.failed"))).toBe("1");
    expect(chip()?.getAttribute("aria-label")).toBe(
      "5 sub-agents, 2 running, 1 failed",
    );
    expect(chip()?.getAttribute("aria-pressed")).toBe("false");
  });

  test("no sub-agent, no chip", async () => {
    await continueWith(new FakeServer(), []);
    expect(chip()).toBeNull();
  });

  test("the chip opens the 400px panel grouped Running, Failed, Finished, stays pressed, and Esc or × closes it", async () => {
    await continueWith(new FakeServer(), [
      RUNNING,
      FINISHED,
      FAILED,
      STOPPED,
      FOREGROUND,
    ]);
    click(chip()!);
    await settle();
    expect(chip()?.getAttribute("aria-pressed")).toBe("true");
    expect(panel()?.closest("aside.aside")).not.toBeNull();
    expect(
      [...(panel()?.querySelectorAll(".group") ?? [])].map(
        (group) =>
          `${text(group.querySelector(".group-title"))}: ${[...group.querySelectorAll(".row .name")].map((name) => text(name)).join(", ")}`,
      ),
    ).toEqual([
      "Running 2: Login-flow mapper, Scope reader",
      "Failed 1: acmelabs.io crawler",
      "Finished 2: Endpoint census, Token analyser",
    ]);
    // One line each: what it does now, else a fixed message.
    expect(
      [...(panel()?.querySelectorAll(".row .line") ?? [])].map((line) =>
        text(line),
      ),
    ).toEqual([
      "Comparing the reset token's lifetime against the session cookie…",
      "Reading scope.md",
      "The sub-agent failed · what it recorded is kept",
      "Finished · reported back to the importer",
      "Stopped before it finished",
    ]);
    // Stop only on a running row that has its own; Open thread on every row, disabled.
    expect(
      [...(panel()?.querySelectorAll(".row") ?? [])].map(
        (row) =>
          `${row.querySelector(".stop") === null ? "-" : "stop"} ${String((row.querySelector(".thread") as HTMLButtonElement | null)?.disabled)}`,
      ),
    ).toEqual(["stop true", "- true", "- true", "- true", "- true"]);
    // Focus went into the panel.
    expect(document.activeElement?.id).toBe("subagent-panel-heading");
    panel()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(panel()).toBeNull();
    expect(chip()?.getAttribute("aria-pressed")).toBe("false");
    // Focus was in the panel: it goes back to the chip that opened it.
    expect(document.activeElement?.className).toContain("subagents-chip");
    click(chip()!);
    await settle();
    click(panel()!.querySelector<HTMLButtonElement>(".close")!);
    await settle();
    expect(panel()).toBeNull();
  });

  test("an Esc that an input method is using does not close the panel", async () => {
    await continueWith(new FakeServer(), [RUNNING]);
    click(chip()!);
    await settle();
    panel()!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    );
    await settle();
    expect(panel()).not.toBeNull();
  });

  test("selecting a row scrolls the transcript to its card, and focus goes with it", async () => {
    const scrolled: string[] = [];
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    restore.push(() => {
      Element.prototype.scrollIntoView = before;
    });
    await continueWith(new FakeServer(), [RUNNING, FINISHED, FAILED]);
    click(chip()!);
    await settle();
    const rows = [
      ...(panel()?.querySelectorAll<HTMLButtonElement>(".row .pick") ?? []),
    ];
    click(rows[1]!);
    await settle();
    expect(scrolled).toEqual(["subagent-toolu_failed"]);
    expect(document.activeElement?.id).toBe("subagent-toolu_failed");
  });

  test("A7-S review 1: Esc on the card a row moved focus to closes the panel, and focus goes back to the chip", async () => {
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = () => undefined;
    restore.push(() => {
      Element.prototype.scrollIntoView = before;
    });
    await continueWith(new FakeServer(), [RUNNING, FINISHED]);
    click(chip()!);
    await settle();
    click(panel()!.querySelectorAll<HTMLButtonElement>(".row .pick")[1]!);
    await settle();
    expect(document.activeElement?.id).toBe("subagent-toolu_done");
    // An Esc an input method uses is left alone here too.
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    );
    await settle();
    expect(panel()).not.toBeNull();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await settle();
    expect(panel()).toBeNull();
    expect(document.activeElement?.className).toContain("subagents-chip");
    // Closed, an Esc on a card is nobody's here.
    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    card("toolu_done")!.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
  });

  test("A7-S review 1: a long name can be read in full, and a long quote is cut to its first lines with a way to read it all", async () => {
    const name = `Scope reader for every host under the wildcard ${"x".repeat(80)}`;
    const report = Array.from(
      { length: 20 },
      (_, index) => `Line ${String(index + 1)}`,
    ).join("\n");
    await continueWith(new FakeServer(), [
      view({
        callId: "toolu_long",
        description: name,
        status: "finished",
        result: report,
      }),
      FINISHED,
    ]);
    const long = card("toolu_long");
    expect(long?.querySelector(".name")?.getAttribute("title")).toBe(name);
    const quote = long?.querySelector(".quote");
    // All of it is there, as written, for a reader and a copy.
    expect(quote?.textContent).toBe(report);
    expect(quote?.classList.contains("clamped")).toBe(true);
    const more = long?.querySelector<HTMLButtonElement>(".more");
    expect(text(more)).toBe("Show all of it");
    expect(more?.getAttribute("aria-expanded")).toBe("false");
    expect(more?.getAttribute("aria-controls")).toBe(quote?.id);
    click(more!);
    await settle();
    expect(quote?.classList.contains("clamped")).toBe(false);
    expect(text(more)).toBe("Show less");
    expect(more?.getAttribute("aria-expanded")).toBe("true");
    // A short one is drawn whole, with no toggle.
    const short = card("toolu_done");
    expect(short?.querySelector(".quote")?.classList.contains("clamped")).toBe(
      false,
    );
    expect(short?.querySelector(".more")).toBeNull();
    // The panel's row names it in full on hover too.
    click(chip()!);
    await settle();
    expect(panel()?.querySelector(".row .name")?.getAttribute("title")).toBe(
      name,
    );
  });

  test("a panel row's Stop stops that sub-agent", async () => {
    const fake = new FakeServer();
    await continueWith(fake, [RUNNING]);
    click(chip()!);
    await settle();
    click(panel()!.querySelector<HTMLButtonElement>(".row .stop")!);
    await settle();
    expect(
      fake.calls
        .filter((each) => each.method === "stopImporterSubagent")
        .map((each) => each.args[3]),
    ).toEqual(["toolu_run"]);
  });

  test("at 1024px the rail gives way while the panel is open and comes back on close; wide enough, it stays", async () => {
    const width = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    let shell = 0;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("chat-shell") ? shell : 0;
      },
    });
    restore.push(() => {
      if (width !== undefined) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      }
    });
    const app = await continueWith(new FakeServer(), [RUNNING]);
    // 1024 less the 232px rail: a 792px shell, which a 400px panel would leave at 392.
    shell = 792;
    expect(app.drawerHidden).toBe(false);
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(true);
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(false);
    // 1440 less the rail: 1208, so the column keeps 808 beside the panel.
    shell = 1208;
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(false);
    click(chip()!);
    await settle();
    // A rail the operator hid stays hidden after the panel closes.
    shell = 792;
    app.drawerHidden = true;
    click(chip()!);
    await settle();
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(true);
  });
});

describe("the 560px rule follows a resize while the panel is open (A7-S review 1)", () => {
  /** The shell's and the window's widths, and the observers the chat made, to fire. */
  const sized = () => {
    const width = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    const inner = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const observer = (globalThis as { ResizeObserver?: unknown })
      .ResizeObserver;
    const size = { shell: 0, window: 0 };
    const watching = new Set<() => void>();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("chat-shell") ? size.shell : 0;
      },
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      get: () => size.window,
    });
    // happy-dom has none: a stub that fires when the test says the size moved.
    class StubResizeObserver {
      readonly #fire: () => void;
      constructor(callback: () => void) {
        this.#fire = () => {
          callback();
        };
      }
      observe(): void {
        watching.add(this.#fire);
      }
      disconnect(): void {
        watching.delete(this.#fire);
      }
      unobserve(): void {
        watching.delete(this.#fire);
      }
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      StubResizeObserver;
    restore.push(() => {
      if (width !== undefined) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      }
      if (inner !== undefined)
        Object.defineProperty(window, "innerWidth", inner);
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observer;
    });
    /** The window resized to `to`, with the 232px rail showing or not. */
    const resize = async (to: number, railShows: boolean) => {
      size.window = to;
      size.shell = railShows ? to - 232 : to;
      for (const fire of [...watching]) fire();
      await settle();
    };
    return { size, resize };
  };

  test("1440 to 1024 puts the rail away, and back to 1440 gives it back; closing leaves it as the operator had it", async () => {
    const { size, resize } = sized();
    size.window = 1440;
    size.shell = 1208;
    const app = await continueWith(new FakeServer(), [RUNNING]);
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(false);
    // Turned to portrait: 792 less the panel would leave 392.
    await resize(1024, true);
    expect(app.drawerHidden).toBe(true);
    // The shell widened with the rail gone; that alone gives nothing back.
    await resize(1024, false);
    expect(app.drawerHidden).toBe(true);
    // Back to landscape: with the rail, 808 beside the panel.
    await resize(1440, false);
    expect(app.drawerHidden).toBe(false);
    await resize(1440, true);
    expect(app.drawerHidden).toBe(false);
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(false);
    // Closed, the rule is not watched: a resize no longer moves the rail.
    await resize(1024, true);
    expect(app.drawerHidden).toBe(false);
  });

  test("a rail the operator shows again while the panel is open is not taken again by a resize", async () => {
    const { size, resize } = sized();
    size.window = 1440;
    size.shell = 1208;
    const app = await continueWith(new FakeServer(), [RUNNING]);
    click(chip()!);
    await settle();
    await resize(1024, true);
    expect(app.drawerHidden).toBe(true);
    app.drawerHidden = false;
    await resize(1024, true);
    expect(app.drawerHidden).toBe(false);
    // Nor by the next one.
    await resize(1000, true);
    expect(app.drawerHidden).toBe(false);
    click(chip()!);
    await settle();
    expect(app.drawerHidden).toBe(false);
  });
});

describe("a question call's row and the session chip (A7-Q's E3/E6 leftovers, done in A7-S)", () => {
  const call = (id: string, tool: string, input: unknown): LiveItem => ({
    ...operator(""),
    id: `replay:${id}`,
    kind: "tool.call",
    headline: tool,
    body: "",
    tool,
    toolName: tool,
    input: JSON.stringify(input),
    callId: id,
    outcome: null,
  });
  const answer = (id: string): LiveItem => ({
    ...call(`${id}-r`, "AskUserQuestion", {}),
    kind: "tool.result",
    callId: id,
    input: null,
    output: "Your questions have been answered.",
  });
  const ASKED = {
    questions: [{ question: "Which hosts?" }, { question: "Depth?" }],
  };
  const pending: PendingQuestion = {
    questionId: "toolu_q",
    harnessSessionId: "ses_newest",
    fields: [
      {
        key: "Which hosts?",
        header: "Hosts",
        question: "Which hosts?",
        kind: "text",
        options: [],
        custom: true,
        required: false,
      },
    ],
    askedAt: NOW,
    answerability: "live",
    attemptId: null,
    roundId: null,
    goalId: null,
    importId: "imp_newest",
  };
  const runLine = () => text(document.querySelector(".importer .run summary"));

  test("a run of question calls reads as the questions asked, and waiting on you while one has no answer", async () => {
    await continueWith(new FakeServer(), [], {
      items: [operator("Ask me."), call("toolu_q", "AskUserQuestion", ASKED)],
      question: pending,
    });
    expect(runLine()).toBe(">_ Asked 2 questions · waiting on you");
  });

  test("A7-S review 1: a question call cut off by a restart, or no longer waited on, is not waiting on you", async () => {
    // After a restart the call has no answer and never will: the replay offers its answers
    // as a message, and the harness waits on nothing.
    await continueWith(new FakeServer(), [], {
      items: [operator("Ask me."), call("toolu_q", "AskUserQuestion", ASKED)],
      question: { ...pending, answerability: "message" },
    });
    expect(runLine()).toBe(">_ Asked 2 questions");
    for (const each of mounted) each.destroy();
    mounted = [];
    // Put away, or the session ended: nothing waits.
    await continueWith(new FakeServer(), [], {
      items: [operator("Ask me."), call("toolu_q", "AskUserQuestion", ASKED)],
    });
    expect(runLine()).toBe(">_ Asked 2 questions");
  });

  test("answered, it is the questions asked alone; any other tool is still a command", async () => {
    await continueWith(new FakeServer(), [], {
      items: [
        operator("Ask me."),
        call("toolu_q", "AskUserQuestion", ASKED),
        answer("toolu_q"),
      ],
    });
    expect(runLine()).toBe(">_ Asked 2 questions");
    for (const each of mounted) each.destroy();
    mounted = [];
    await continueWith(new FakeServer(), [], {
      items: [operator("Run it."), call("toolu_b", "Bash", { command: "ls" })],
    });
    expect(runLine()).toBe(">_ Ran 1 command · Bash");
  });

  test("the session chip carries a warning dot while the session waits on the operator", async () => {
    await continueWith(new FakeServer(), [], {
      items: [operator("Ask me."), call("toolu_q", "AskUserQuestion", ASKED)],
      question: pending,
    });
    expect(document.querySelector(".right .question-dot")).not.toBeNull();
    expect(text(document.querySelector(".right .crumb.chip"))).toContain(
      "Waiting on you:",
    );
  });

  test("and none while it does not", async () => {
    await continueWith(new FakeServer(), [RUNNING]);
    expect(document.querySelector(".right .question-dot")).toBeNull();
  });
});
