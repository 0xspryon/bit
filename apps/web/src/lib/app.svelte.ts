/**
 * State for Flow A, now against a real server.
 *
 * One class holding everything the three screens need. It is still deliberately a single
 * object — switching between states quickly is what the scenario picker is for, and a
 * picker that had to coordinate five stores would get in the way of that — but the data
 * behind Connect, the target rail and the New target dialog is no longer static. Every
 * field marked below as server-fed is written only from a response, and the shapes it is
 * written from are the ones declared in `@bit/contracts`.
 *
 * **What is still static, and why.** Every Level 2 section except Goals. A goal is a real
 * row in the open target's own `hunt.sqlite` and the Goals section reads, creates and ends
 * them through the server; the rest of the sidebar is the prototype it was, and a screen
 * that invented a count for them would be a lie the operator cannot see through, so they
 * stay visibly prototypes until there is something real behind each.
 *
 * **The scenario picker still works.** `reset()` loads the mock rows on purpose: a
 * scenario's job is to reach a UI state without reproducing the conditions that cause
 * it. Where a state can now come from the server — a refused password, an unavailable
 * target, a duplicate folder, a failed migration — the real path produces it too, and the
 * scenario is the shortcut rather than the only way in.
 *
 * That includes the Goals page. A scenario has no server to read goals from, so
 * {@link App.previewTarget} declares the prototype's two (`mock.ts`'s `previewGoals`)
 * rather than leaving the page waiting for an answer nothing will send.
 */

import {
  droppedModelOptionIds,
  explicitModelOptionSelections,
  modelOptionDescriptors,
  SCOPE_IMPORT_MAX_LINKS,
  type AssetView,
  type AttemptTranscript,
  LIVE_SILENCE_LIMIT_SECONDS,
  type GoalEndStatus,
  type GoalBriefingView,
  type GoalConversationView,
  type GoalNarrationView,
  type GoalObservationView,
  type GoalUploadView,
  type GoalView,
  type AgentSessionView,
  type HarnessInstanceView,
  type ImporterModelView,
  type ImporterSessionView,
  type IntentView,
  type LiveFrame,
  type LiveItem,
  type LiveUsage,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
  type PlanRoundStarted,
  type PlanRoundView,
  type RunningAttempt,
  type RunningRound,
  type ScopeImportView,
  type ScopeKind,
  type ScopeLabelDraft,
  type ScopeState,
  type ScopeView,
  type TargetView,
  type TargetCounts,
  type TargetSummary,
} from "@bit/contracts";

import {
  initialTargets,
  previewCounts,
  previewGoals,
  type Target,
} from "./mock";
import {
  activityOrder,
  buildChat,
  buildGoalConversation,
  contextMeter,
  goalUsageScope,
  roundUsageScope,
  usageScope,
  withBlock,
  withoutPartials,
  type ContextMeter,
  type SentTurn,
} from "./chat";
import { server, type ServerClient } from "./client";
import { indexedSession } from "./importerChat";
import {
  browserModelMemory,
  usableRemembered,
  type ModelMemory,
} from "./importerModelMemory";
import {
  ImporterSessions,
  type ImporterScenario,
  type ImporterSent,
  type ImporterActivity,
  type ImporterServer,
} from "./importerSessions.svelte";
import {
  mockHarnesses,
  mockImporterIndex,
  mockImporterModel,
} from "./mockImporter";

/**
 * A cancellable one-shot timer.
 *
 * A seam rather than a direct `setTimeout`, for the reason {@link App}'s client is one: the
 * live transcript's silence watchdog and reconnect backoff depend on elapsed time;
 * a test of the watchdog that actually waited would be a forty-second test.
 * There is one real implementation and it is three lines; see `test/fakeCountdown.ts` for
 * the other.
 */
/**
 * How often the "Loading the scope" panel asks the server what the import has done.
 *
 * An import writes a dozen rows over a minute or so, and the panel is a receipt rather
 * than a live channel — so this is slow enough to cost nothing and quick enough that a
 * line appears while the operator is still looking at the one before it. The poll
 * reschedules itself after each answer, so this is the gap between answers rather than a
 * rate at which requests are fired.
 */
export const IMPORT_POLL_MS = 900;

export interface Countdown {
  /** Schedules `fire` for `ms` from now. The returned function cancels it. */
  readonly after: (ms: number, fire: () => void) => () => void;
}

/** `setTimeout`, as a {@link Countdown}. What the app runs with. */
export const realCountdown: Countdown = {
  after: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

/**
 * Which top-level screen is showing.
 *
 * `new-target` is new, and it is a screen rather than a flag because A3 turns the New
 * target **dialog** into a **page**: the folder browser becomes the only remaining modal.
 * (It also carried the program links and the "Loading the scope" panel until A6 moved the
 * importer to the Assets page; that is {@link ImporterPhase}'s page, inside a target.)
 */
export type Screen = "connect" | "welcome" | "target" | "new-target";
/**
 * What the Auto-load page is doing.
 *
 * `form` and `importing` are two views of one page, which was A3's C1 and C2 on the
 * create-target page and is now the Assets page's Auto-load sub-page. They are a state on
 * the page rather than two pages because the crumbs, the rail and the page frame do not
 * change between them — only the body does.
 */
export type ImporterPhase = "form" | "importing";
/**
 * What the hunt view knows about the target it is showing.
 *
 * `loading` is a real state rather than "counts are zero": a fresh target genuinely holds
 * zero of everything, so a header cannot use `0` to mean "not read yet" without lying in
 * the one case it is most likely to be looked at.
 */
export type TargetViewState =
  "empty" | "loading" | "ready" | "unavailable" | "unreachable";
export type Theme = "dark" | "light";
export type ConnectError = "none" | "password" | "unreachable" | "expired";
/**
 * What the create-target form is showing, which is mostly which refusal.
 *
 * Every refusal is its own state, and the states differ by what the operator must change.
 * `denied` is "this folder cannot be read": a permission, or a path the server will not
 * take, where granting access and choosing it again is a real answer. `unusable` is the
 * server saying the folder *can* be read and still cannot host a target, because it holds
 * the directory the target's own data would live in; every planner, goal and import session
 * on such a target would be refused, so retrying cannot help and the screen must not
 * suggest it. `invalid-name` is about the **name**, and it used to land on `denied` — which
 * told an operator who typed `###` three things about their folder, none of which was the
 * problem, and disabled the button that would have let them fix it.
 */
export type CreateState =
  | "idle"
  | "creating"
  | "failed"
  | "duplicate"
  | "denied"
  | "unusable"
  | "invalid-name";
/**
 * What the goals list knows about the target it is showing.
 *
 * `loading` is a state of its own for the reason {@link TargetViewState} gives: a fresh
 * target genuinely has no goals, so an empty list cannot also mean "not read yet" without
 * the empty-state sentence flashing up before the answer arrives.
 */
export type GoalsState = "idle" | "loading" | "ready" | "failed";

/**
 * How the estate read is going. The same four as {@link GoalsState}, for the same reason.
 *
 * "Nothing found yet" is a fact about a target, and it is a different fact from "not read
 * yet" and from "could not read". An empty-state sentence shown while the request is in
 * flight tells the operator, falsely and for a moment, that their hunt has found nothing.
 */
export type AssetsState = "idle" | "loading" | "ready" | "failed";

/** Which tab of the Assets screen is showing. */
export type AssetsTab = "estate" | "scope";

/**
 * Which rows the Estate tab is showing.
 *
 * Filters by *scope state*, which is the only grouping that matches what a label reaches,
 * and never removes a row from the underlying list: "Not covered" is the one an operator
 * actually works from, and it is the whole reason the view exists.
 */
export type EstateFilter = "all" | "in" | "out" | "uncovered";

export interface Scenario {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly apply: (app: App) => void;
}

/**
 * A coarse relative time, from epoch milliseconds.
 *
 * The rail shows this next to each target and the column is narrow, so it is one unit
 * and no suffix — `2m`, `7h`, `6d`. "now" rather than `0s` because a target created a
 * moment ago reading `0s` looks like a missing value.
 */
const relative = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(Math.max(1, minutes))}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
};

/**
 * Turns one server row into a rail row.
 *
 * Every reason the server can give for a target being unavailable maps to the one
 * `missing` state the screens have, because that is the one thing the rail is saying: you
 * cannot open this. *Which* reason it was is kept in `detail`, in the server's own words,
 * and shown where there is room for a sentence. A per-reason badge would be five states
 * for a distinction the operator acts on identically.
 */
export const fromSummary = (summary: TargetSummary, now: number): Target => ({
  id: summary.id,
  name: summary.name,
  path: summary.workspacePath ?? summary.dataDirectory,
  scope: summary.scopeNote === "" ? "—" : summary.scopeNote,
  lastActivity: relative(summary.lastActivityAt, now),
  status: summary.available ? "ready" : "missing",
  detail: summary.detail,
});

/**
 * One options store with one descriptor set, or taken off.
 *
 * The rule behind both {@link App.pickModelOption} and {@link App.pickImportModelOption},
 * written once because it is a rule rather than plumbing: picking the choice the model
 * marks as its default **removes** the entry instead of storing `"default"` as a value, and
 * an id the model has no descriptor for is refused (`undefined`) rather than stored.
 */
export const withModelOptionPicked = (
  store: Record<string, readonly ModelOptionSelection[]>,
  key: string,
  descriptors: readonly ModelOptionDescriptor[],
  descriptorId: string,
  value: string,
): Record<string, readonly ModelOptionSelection[]> | undefined => {
  const descriptor = descriptors.find((entry) => entry.id === descriptorId);
  if (descriptor === undefined) return undefined;
  const kept = (store[key] ?? []).filter(
    (selection) => selection.id !== descriptorId,
  );
  const isDefault =
    descriptor.options.find((choice) => choice.id === value)?.isDefault ===
    true;
  return {
    ...store,
    [key]: isDefault ? kept : [...kept, { id: descriptorId, value }],
  };
};

/*
 * ── What a link that outlived its resource says ──────────────────────────────────
 *
 * Design D5: a bookmark outlives the thing it names, and the app should say so instead of
 * pretending. Three resources can go while a saved link still points at them — a target
 * leaves the registry, a goal id turns out to be another target's, an importer session
 * falls out of the harness's own index — and the rule for all three is the same: fall back
 * to the nearest place that does exist, and say what was missing.
 *
 * The three sentences live together here, out of the methods that raise them, because they
 * are one piece of writing and are easier to keep consistent side by side than three
 * hundred lines apart. They share a shape, and the shape is the point:
 *
 * - **They name the id.** An operator looking at this is deciding whether their bookmark
 *   has a typo in it or the thing really went, and the id is most of that answer.
 * - **They say where the operator has been put**, because being moved without being told
 *   is the failure mode D5 exists to end.
 * - **They blame nobody.** Following your own saved link is not a mistake, and nothing has
 *   gone wrong here that anyone could have avoided: time passed. So no "invalid", no
 *   "error", no "failed" — just what is not there and what is.
 *
 * {@link App.arrivalNote} is where they are put and the shell is what renders them.
 */

/** A path naming a target this server's registry does not hold. */
const targetGoneNote = (targetId: string): string =>
  `This server has no target called "${targetId}", so there was nothing to open. These are the targets it does have.`;

/**
 * A path naming a goal the target it names does not hold.
 *
 * The second sentence is the useful half. A goal id is a handle into one target's evidence
 * — the server's own `GoalNotFound` says so, and answers it for a goal that exists under a
 * *different* target — so "wrong target" is the likeliest reason an operator is reading
 * this, and a sentence that only said "no such goal" would leave them hunting for it.
 */
const goalGoneNote = (goalId: string): string =>
  `This target has no goal under the id "${goalId}". A goal id belongs to one target, so it may be another target's — these are this target's goals.`;

/**
 * A path naming an importer session the importer's index no longer lists.
 *
 * The first sentence is the one that was already in the code before D5, written for the
 * Agent sessions banner; it was right about *what* and wrong only about *where*, so it is
 * kept word for word. The second says where the fallback landed.
 *
 * No id in this one, deliberately: a `ses_…` handle is the harness's and says nothing to an
 * operator that the list beneath it does not say better.
 */
const chatGoneNote = (): string =>
  "That importer session is no longer in the importer's own list, so there is nothing to open it on. The target's agent sessions are listed here.";

export class App {
  /**
   * The control plane this instance talks to.
   *
   * Not reactive, and deliberately not: it is handed in once and never changes, and a
   * `$state` field here would make "which client did that call go to" a question about
   * when an effect ran. It holds the session token too — see {@link ServerClient} — so
   * everything that reaches the network, including signing out, goes through this one
   * reference and a test needs no second seam to intercept it.
   */
  readonly client: ServerClient;

  /**
   * How this instance schedules the one thing it does on a timer.
   *
   * Not reactive and never reassigned, for the same reason {@link client} is not: it is
   * handed in once, and a `$state` field would make "which timer did that watchdog use" a
   * question about when an effect ran.
   */
  readonly countdown: Countdown;

  /**
   * Defaults to the live client and real timers, so `new App()` is unchanged for the route
   * that mounts it. Both parameters exist for the tests, which hand in hand-written
   * doubles; neither is a configuration point and there is no second real implementation
   * of either.
   */
  constructor(
    client: ServerClient = server,
    countdown: Countdown = realCountdown,
    modelMemory: ModelMemory = browserModelMemory,
  ) {
    this.client = client;
    this.countdown = countdown;
    this.modelMemory = modelMemory;
  }

  /**
   * Where the harness and model last picked for a new importer session are kept, per target
   * (`importerModelMemory.ts`). Handed in once, like {@link countdown}; the tests hand in
   * their own so one test's pick is not the next one's default.
   */
  readonly modelMemory: ModelMemory;

  screen = $state<Screen>("connect");
  theme = $state<Theme>("dark");

  /* Connect */
  /**
   * Where the server is.
   *
   * The page's own origin, because the browser reaches the control plane same-origin —
   * through the dev server's `/api` proxy in development, from the server itself in a
   * packaged deployment. It stays an editable field because an operator may genuinely be
   * pointing at another machine, and a wrong answer here is exactly what the
   * server-unreachable state is for.
   */
  serverUrl = $state(
    typeof location === "undefined" ? "http://127.0.0.1:3000" : location.origin,
  );
  password = $state("");
  connectError = $state<ConnectError>("none");
  connecting = $state(false);
  /** Forces the next connect attempt to fail as if the server were down. */
  simulateDown = $state(false);
  /** Whatever the transport said, for the console rather than the screen. */
  connectDetail = $state("");

  /* Welcome */
  /** Server-fed. Empty until a session is open; `reset()` loads the mock rows. */
  targets = $state<Target[]>([]);
  selectedId = $state("");
  search = $state("");
  reconnecting = $state(false);
  bannerDismissed = $state(false);

  /** Whether the password field is showing its value. */
  passwordVisible = $state(false);

  /* Level 2 — inside an open target */
  navItem = $state("goals");
  /**
   * Which target {@link counts} were read for.
   *
   * Carried next to the counts rather than assumed to be `selectedId`, because they are
   * written at different times: the id changes the moment a target is opened and the
   * counts arrive one round trip later. The header renders counts only when these agree,
   * which is what makes "no data from one target appears while viewing the other" a
   * property of the screen rather than a property of how fast the server answered.
   */
  viewTargetId = $state("");
  /** Server-fed: what the open target's own database holds. */
  counts = $state<TargetCounts | undefined>(undefined);
  viewState = $state<TargetViewState>("empty");
  /** The server's own words for a refusal, shown instead of the counts. */
  viewDetail = $state("");
  /**
   * The target named by a URL that could not be opened yet.
   *
   * A deep link arrives before there is a session, so the place it names is parked here
   * and acted on once the target list is in hand. Cleared whether or not it resolves — a
   * link to a target that no longer exists should leave the operator on the list, once,
   * rather than re-asking on every refresh of it.
   *
   * This is the only part of the held place `App` reads, because it is the only part `App`
   * can judge: whether this server has such a target. See {@link requestedPath}.
   */
  requestedTargetId = $state("");
  /**
   * The rest of that held place, as the path it arrived as.
   *
   * A path and not a `Place`, because `place.ts` imports `App` — so `App` importing
   * `place.ts` back would be a runtime cycle between the state and its own grammar. The
   * string is opaque here: `App` holds it across the Connect screen and hands it back
   * through {@link replayPath}, and the route, which owns the grammar, is what reads it.
   *
   * Holding the whole place rather than the target alone is what makes a link opened
   * before there is a session land where it pointed. The browser session registry is in
   * memory, so a server restart invalidates it and a bookmark opened the next morning is
   * the common case, not an edge one: `/t/x/assets/scope` has to arrive at Scope after
   * Connect, not merely at the target's Goals page.
   */
  requestedPath = $state("");
  /**
   * The held path, released at the one moment it can be replayed, or `""`.
   *
   * The handshake that keeps the grammar out of `App`. `App` knows *when* a held link can
   * be opened — the list has arrived, by whichever way in — and nothing about *what* the
   * link says; the route knows the grammar and cannot see the moment. So this field is
   * `App` saying "now", and {@link takeReplayPath} is the route taking the answer.
   */
  replayPath = $state("");
  /**
   * What a link that outlived the thing it names has to say, or `""`.
   *
   * The other half of a deep link, and the half design D5 is about: {@link requestedPath}
   * carries a link to the moment it can be followed, and this is what is left when
   * following it finds nothing there. A target the registry has dropped, a goal id that
   * belongs to a different target, an importer session the harness has let go — each used
   * to fail quietly, and each now lands on the nearest place that does exist with its
   * reason here. The three sentences are above the class; this is where they are put.
   *
   * ## Why one field, read by the shell above every screen
   *
   * The three fallbacks land on three different pages — the target list, a target's goal
   * list, its Agent sessions list — so a banner belonging to any one screen would be absent
   * from the other two, which is precisely the bug D5 names: `openImporterSession` had the
   * right sentence on a screen the arrival was not looking at. The route renders this
   * between the crumb bar and the screen, so it is on every page a fallback can reach *by
   * construction* rather than by three separate correct decisions, and a fourth fallback
   * added later inherits the surface instead of needing one.
   *
   * ## Why not {@link toast}
   *
   * That one belongs to the import that read nothing: `role="alert"`, danger-toned,
   * floating over the page. Nothing has failed here — time passed and a link got old — so
   * putting the two on one surface would either dress this up as a failure or quieten that
   * one down to a notice. One surface per severity, and these are two.
   *
   * ## Why it waits
   *
   * This sentence is the answer to a question the operator asked by following a link, and a
   * link can take a while to be answered: a deep link may arrive before there is a session,
   * sit behind Connect for as long as the password takes, and only then turn out to name
   * something gone. A message that timed out would often be gone before the page it belongs
   * to had rendered. So nothing expires it. It goes when the operator dismisses it, and
   * when they navigate — every method below that moves the app clears it, because once they
   * have chosen somewhere else the sentence is about where they were sent, not where they
   * are.
   *
   * ## It is also a history rule
   *
   * The route reads this a second way, as `placeHistory.ts`'s `"fell-back"`: a reflection
   * written while this stands **corrects** the address bar entry the dead link is on
   * instead of adding one. Without that, a bookmark to a deleted target left a `/` entry
   * pushed over `/t/<gone>`, and Back onto `/t/<gone>` bounced and pushed another — a Back
   * button that could not leave the page. So the note is what makes a failed arrival cost
   * no history entry.
   */
  arrivalNote = $state("");
  /**
   * Whether the target's rail is put away.
   *
   * Hidden, not collapsed to icons: the crumb bar takes over the one job the rail did that
   * nothing else does — moving between sections — by growing a section crumb while the
   * rail is gone. So there is never a state with two ways to switch section on screen.
   */
  drawerHidden = $state(false);
  /**
   * Whether the Live dock is open past its one-line summary.
   *
   * Closed by default so the page above it gets the viewport. Kept across targets: it is
   * how this operator likes the screen, not a fact about any one target.
   */
  liveExpanded = $state(false);
  /** Whether the prototype's state picker is open. See `ScenarioBar`. */
  statesOpen = $state(false);
  detailOpen = $state(false);
  detailRow = $state(0);

  /* ── Runs ─────────────────────────────────────────────────────────────────── */
  /**
   * The intent the run box is aimed at, or `""` for none.
   *
   * A run claims an intent that already exists, so there is nothing to type: the operator
   * picks "Run this intent" on a row and the box shows that intent's question as the
   * prompt. Held as an id and looked up in {@link intents} rather than as a copy of the
   * row, so the box always shows the intent's *current* status — an intent another tab
   * has since started reads as claimed here too, instead of offering a run the server
   * will refuse.
   */
  runIntentId = $state("");
  /**
   * What became of the last accepted run's harness suggestion, when it could not be honoured.
   *
   * Non-null only when the intent *suggested* an instance and the server ran the default
   * instead; the sentence says so, because a substitution nobody mentions is the quiet
   * kind of lie this product refuses. Cleared by the next start and by leaving the target.
   */
  runFallback = $state<{
    requested: string;
    reason: string;
    ranOn: string;
  } | null>(null);
  /** True from submitting until the server has answered, which is not the run's length. */
  starting = $state(false);
  /** True from asking to stop until the server confirms it settled. */
  stopping = $state(false);
  /**
   * Runs the server is supervising, as it last told us.
   *
   * Server-fed and process-wide, so a reloaded tab finds a run it started — the attempt id
   * appears nowhere else that survives a refresh. Not a live feed: it is refreshed on
   * open, on start and on stop, and the transcript that would make it live is the next
   * slice's.
   */
  runs = $state<RunningAttempt[]>([]);
  /** The server's own words for a refused start or stop. */
  runDetail = $state("");

  /** The run against the target currently on screen, if this server has one. */
  activeRun = $derived(
    this.runs.find((entry) => entry.targetId === this.viewTargetId),
  );

  /* ── Goals ────────────────────────────────────────────────────────────────── */
  /**
   * The open target's goals, newest first, as the server last told us.
   *
   * Server-fed and one target's at a time: {@link goalsTargetId} says whose, and nothing
   * reads {@link goals} without agreeing with it, for the reason {@link viewTargetId} sits
   * beside {@link counts}. Switching targets clears it before the new answer is asked for,
   * so one target's objectives are never on screen under another's name.
   */
  goals = $state<GoalView[]>([]);
  /** Which target {@link goals} were read for. Empty until the first answer. */
  goalsTargetId = $state("");
  goalsState = $state<GoalsState>("idle");
  /** The server's own words for a failed read. */
  goalsDetail = $state("");
  /** The goal being looked at, or `""` for the list. */
  openGoalId = $state("");

  /* ── The Agent sessions list (importer conversation design, S8) ───────────── */

  /**
   * Every long-running agent session on the open target, of every kind, as the server
   * unions them. One target's at a time: {@link agentSessionsTargetId} says whose, and the
   * screen draws nothing that disagrees with {@link viewTargetId}.
   */
  agentSessions = $state<readonly AgentSessionView[]>([]);
  /** Worker sessions the server held back to bound the list; the screen says so. */
  agentSessionsWorkersOmitted = $state(0);
  agentSessionsTargetId = $state("");
  agentSessionsState = $state<AssetsState>("idle");
  agentSessionsDetail = $state("");
  /*
   * `agentSessionsNote` was here: "why the last click on a row went nowhere", with the one
   * case being an importer session the importer's index no longer lists.
   *
   * Deleted rather than kept beside {@link arrivalNote}, which now carries that sentence.
   * The case it answered is design D5's, and D5's point is that the answer has to be on the
   * page the link landed on — a banner that only the Agent sessions list rendered was right
   * for the one arrival that came from a click on that list and silent for every arrival
   * that came from a URL. Two surfaces for one event would have left the choice of which to
   * write to whoever added the next fallback.
   */

  /* ── The estate, and the scope that frames it ──────────────────────────────── */

  /**
   * Every asset the open target has recorded, with the scope state of each.
   *
   * Server-fed and one target's at a time, like {@link goals}: {@link assetsTargetId}
   * says whose, and nothing renders a row without agreeing with it.
   *
   * **Nothing is filtered out of this list.** An asset no in-scope entry covers is here
   * like any other, because the whole point of the estate view is that a discovery is
   * recorded, kept, displayed and labelled. {@link estateFilter} changes what is *shown*
   * and never what was read.
   */
  assets = $state<AssetView[]>([]);
  /** Which target {@link assets} were read for. Empty until the first answer. */
  assetsTargetId = $state("");
  assetsState = $state<AssetsState>("idle");
  /** The server's own words for a failed read. */
  assetsDetail = $state("");

  /**
   * The open target's authored scope, and the block an agent would be given now.
   *
   * `undefined` until the first answer. `promptBlock` inside it is `null` when nothing is
   * in scope, which is a different thing from not having read it yet.
   */
  scope = $state<ScopeView | undefined>(undefined);
  scopeTargetId = $state("");
  scopeState = $state<AssetsState>("idle");
  scopeDetail = $state("");

  /**
   * The open target's importer sessions as the server indexes them, newest first.
   *
   * What the Auto-load page's session list and the Scope tab's "last session" strip both
   * read. **Kept on a failed read** rather than cleared: the strip and the list are
   * conveniences for finding a session again, a stale pointer is still a pointer to the
   * same target, and a transient failure that blanked them would make an operator think the
   * sessions were gone. A change of target clears it (`#clearEstate`), which is the only
   * time it could be someone else's.
   */
  importerIndex = $state<readonly ImporterSessionView[]>([]);
  importerIndexTargetId = $state("");

  /**
   * The newest importer session on the open target, or `undefined` when there is none or
   * the index has not been read for this target yet.
   */
  lastImporterSession = $derived(
    this.importerIndexTargetId === this.viewTargetId
      ? this.importerIndex[0]
      : undefined,
  );

  /** Which tab of the Assets screen is open. Estate first: it is what the hunt produced. */
  assetsTab = $state<AssetsTab>("estate");
  estateFilter = $state<EstateFilter>("all");
  /** The host-or-path filter box. Matches on either, because a row shows both. */
  estateQuery = $state("");

  /* The Add an entry form, on the Scope tab */
  entryEffect = $state<"in" | "out">("in");
  entryKind = $state<ScopeKind>("subtree");
  entryValue = $state("");
  /**
   * The server's refusal of the last scope change, or `""`.
   *
   * Kept apart from {@link scopeDetail}, which is a failed *read*: a refusal is an answer
   * about what the operator just asked for and belongs beside the control that caused it,
   * where a read failure belongs at the top of the panel.
   */
  scopeRefusal = $state("");
  /** Whether the refusal above is D2's contradiction, which is the one danger-red case. */
  scopeRefusalContradiction = $state(false);
  /** True while a scope change is in flight, so the control can say so. */
  scopeBusy = $state(false);
  /**
   * The entry the operator has asked to delete and has not yet confirmed, or `""`.
   *
   * Held as an id and not as the entry, so the dialog is drawn from the entries as they
   * are now: if a re-read drops the entry, there is nothing left to confirm and the
   * dialog goes with it rather than offering to delete a row that is already gone.
   */
  scopeEntryToRemove = $state("");
  /**
   * Whether the panel holding the block the agent is given is open on the Scope tab.
   *
   * Held here with the tab it belongs to rather than in the screen, so that a test can
   * open it: the markup tests render on the server, where no click can.
   */
  scopeBlockOpen = $state(false);

  /* The New goal dialog */
  goalDialogOpen = $state(false);
  goalName = $state("");
  goalObjective = $state("");
  goalCreating = $state(false);
  /** A refusal of the create, in the server's words. Shown inside the dialog. */
  goalCreateDetail = $state("");

  /* Ending the open goal */
  /** Whether the end form is showing. Ending is deliberate, so it is never one click. */
  goalEndOpen = $state(false);
  goalEndStatus = $state<GoalEndStatus>("met");
  goalEndReason = $state("");
  goalEnding = $state(false);
  /** A refusal of the end, in the server's words. Shown beside the control. */
  goalEndDetail = $state("");

  /** The goal being looked at, from the list. Absent if it has left the list. */
  openGoalView = $derived(
    this.goals.find((goal) => goal.goalId === this.openGoalId),
  );

  /* ── The goal briefing ────────────────────────────────────────────────────── */
  /**
   * What a planner round would be given for the open goal, as the server last rendered it.
   *
   * One goal's at a time, like {@link intents}: {@link goalBriefingGoalId} says whose, and
   * nothing reads this without agreeing with {@link openGoalId}. It is the server's
   * rendering and is never assembled here — the panel's whole claim is that it is showing
   * the text the planner gets, and a browser that built any part of it could not make that
   * claim.
   */
  goalBriefing = $state<GoalBriefingView | undefined>(undefined);
  goalBriefingGoalId = $state("");
  goalBriefingState = $state<GoalsState>("idle");
  /**
   * Why there is no briefing, in the server's words.
   *
   * Carries the over-the-ceiling refusal as well as a failed read, because to the panel
   * they are the same shape of answer: a sentence instead of a briefing. The two numbers
   * are in {@link goalBriefingSize} and {@link goalBriefingCeiling} so the panel can name
   * them without parsing the sentence.
   */
  goalBriefingDetail = $state("");
  /** The rendered size the refusal named, or `undefined` when the failure had no size. */
  goalBriefingSize = $state<number | undefined>(undefined);
  /** The ceiling the refusal named. Also `undefined` for a failure that had none. */
  goalBriefingCeiling = $state<number | undefined>(undefined);

  /* ── Planner rounds ───────────────────────────────────────────────────────── */
  /**
   * The open goal's planner rounds, newest first, as the server last told us.
   *
   * One goal's at a time, like {@link intents} and {@link goalBriefing}:
   * {@link planRoundsGoalId} says whose, and nothing reads this without agreeing with
   * {@link openGoalId}. These are the **rows**, which is where a settled round's
   * disposition lives — the only place it survives a refresh.
   */
  planRounds = $state<PlanRoundView[]>([]);
  planRoundsGoalId = $state("");
  planRoundsState = $state<GoalsState>("idle");
  /** The server's own words when the rounds could not be read. */
  planRoundsDetail = $state("");

  /**
   * The rounds this server is supervising right now, across every target.
   *
   * **A different question from {@link planRounds} and the difference decides what the
   * control says.** A row saying `running` can be one a dead process left behind, and
   * nothing will settle it until the next startup sweep; a round in this list has a fiber
   * driving it. So "a planner is working on this goal — wait for it" is answered from
   * here, and "the last round concluded X" from the rows.
   */
  runningRounds = $state<RunningRound[]>([]);

  /** True while a `POST .../plan` is in flight, so the button can spin exactly once. */
  planStarting = $state(false);
  /**
   * Why a round was refused, in the server's words, shown beside the control.
   *
   * Every reason `PlanRefused` carries is a sentence written for an operator, and an
   * over-the-ceiling briefing arrives as `GoalBriefingRefused` with its two numbers in
   * {@link planRefusalSize} and {@link planRefusalCeiling} so the control can name them
   * without parsing the sentence.
   */
  planDetail = $state("");
  planRefusalSize = $state<number | undefined>(undefined);
  planRefusalCeiling = $state<number | undefined>(undefined);

  /** The round this process is driving on the open goal, if there is one. */
  openGoalRunningRound = $derived(
    this.runningRounds.find((round) => round.goalId === this.openGoalId),
  );

  /**
   * The open goal's most recent round, by the server's own ordering.
   *
   * `planRounds` is newest first, so this is the head. It is what the goal screen reports:
   * "the round's disposition once recorded" is a statement about the last one.
   */
  latestPlanRound = $derived(
    this.planRoundsGoalId === this.openGoalId ? this.planRounds[0] : undefined,
  );

  /* ── A round's narration ──────────────────────────────────────────────────── */
  /**
   * The open goal's planner narration, as the harness last had it.
   *
   * **The one read in this application whose answer is somebody else's retention policy.**
   * A round's prose is never stored (the spec's decision 14), so after a reload this is the
   * only place it can come from — and the harness may have deleted it, which arrives as a
   * success saying so rather than as a failure. Each round in it carries its own `source`,
   * and `chat.ts` turns that into the sentence the chat prints.
   *
   * `undefined` means the read has not answered yet, which the chat shows as `loading`
   * rather than as an absence: "we have not asked" and "there is nothing" are different.
   */
  goalNarration = $state<GoalNarrationView | undefined>(undefined);
  goalNarrationGoalId = $state("");
  goalNarrationState = $state<GoalsState>("idle");
  /** The server's own words when the narration could not be read at all. */
  goalNarrationDetail = $state("");

  /**
   * The activity publish order at the moment the narration answered.
   *
   * **This is the dedupe between the replay and the live tail, and it is the honest version
   * of the one the spec asks for.** The spec's join is "by the harness's own message
   * index", and neither side has one to join on: `AgentHarness.messages` is the reduced
   * `{ type, text, error }` shape, and a `LiveItem` carries the server's publish counter
   * rather than the harness's cursor — Claude Code has no cursor at all. So what is used
   * instead is *our* arrival order: narration published at or below this number is already
   * inside the replayed block, and narration above it is this tab's own tail.
   *
   * It is an in-process counter, which is exactly the right scope for the question: both
   * the replay and the live feed came from this server process, and a restart invalidates
   * the replay and the floor together.
   *
   * The remaining overlap is small and real: an entry the harness had already recorded when
   * it answered, but which this process published between then and the answer landing, is
   * in both. The replayed block says it is a replay rather than claiming completeness,
   * which is why that is tolerable and a silent dedupe by tool name would not be.
   */
  goalNarrationFloor = $state<number | undefined>(undefined);

  /* ── The goal conversation ────────────────────────────────────────────────── */
  /**
   * The open goal's conversation, as the harness last had it.
   *
   * {@link goalNarration}'s sibling for the other agent, with one state a round cannot be
   * in: `absent`, for a goal nobody has said anything to. `undefined` means the read has
   * not answered, which the chat shows as `loading` — "we have not asked" and "there is
   * nothing" are different things to tell an operator.
   */
  goalConversation = $state<GoalConversationView | undefined>(undefined);
  goalConversationGoalId = $state("");
  goalConversationState = $state<GoalsState>("idle");
  /** The server's own words when the conversation could not be read at all. */
  goalConversationDetail = $state("");
  /** The replay's join floor, for {@link goalNarrationFloor}'s reason exactly. */
  goalConversationFloor = $state<number | undefined>(undefined);
  /**
   * How many of {@link goalTurns} had been sent when the replay was asked for.
   *
   * **The bound on which of this tab's own messages the replay may cancel.** The replay
   * brings the operator's words back as `user` entries, so a local turn it contains has to
   * be dropped or the sentence appears twice — but it is read on open and re-read only
   * after a send that opens a conversation, so it is usually stale. Cancelling by text
   * alone therefore swallowed a *re-sent* sentence ("ok", "continue") against the old entry
   * and showed it nowhere until a reload. This is a count rather than a clock, for the
   * reason the floor beside it is: a turn numbered above it was sent after the request
   * left, so no answer to that request can contain it. `chat.ts` is where it is applied.
   */
  goalConversationThrough = $state(0);

  /**
   * Which **visit** to a goal conversation this tab is on. Counted, never reset.
   *
   * ## What it is for, and why the count beside it was not enough
   *
   * {@link goalConversationThrough} bounds the cancellation by *how many* turns had been
   * sent, and {@link #clearGoalConversation} renumbers turns from 1 on every navigation. So
   * goal A → B → A, inside one replay round trip, defeats it: the answer to visit one's read
   * arrives while `openGoalId` is A again, passes the `openGoalId === goalId` guard, and
   * installs visit one's `through` — under which visit two's freshly re-sent turn 1 is a
   * cancellation candidate again, and is swallowed if the stale replay happens to contain
   * its text. Slice 9's own finding applies to it exactly: a chat that silently swallows
   * what was just typed is worse than one that shows it twice.
   *
   * A token rather than a larger count, because the thing being identified is the *visit* —
   * a monotonic number taken before a request leaves and compared when it lands. A reply
   * that does not match belongs to a conversation nobody is looking at any more, and it is
   * dropped whole rather than having its parts guarded one at a time.
   *
   * Not a `$state` field anybody renders, and it is deliberately **not** cleared: a reset
   * counter is a counter that can collide with the request it is supposed to tell apart.
   */
  #goalConversationVisit = 0;

  /** What the operator is typing. Cleared the moment the server accepts it. */
  goalMessage = $state("");
  /** True while a message is in flight, so the composer spins exactly once. */
  goalSending = $state(false);
  /** Why a message was refused, in the server's words, beside the composer. */
  goalSendDetail = $state("");
  /**
   * What the server said about the session this tab's last message landed in.
   *
   * Only ever non-empty for a turn that **opened** a conversation, which includes the first
   * message after a restart — and that is the one an operator has to be told about, because
   * a new conversation on a goal that already had one looks from here exactly like the old
   * one continuing.
   */
  goalSessionNote = $state("");
  /**
   * Which harness and model the goal's agent is running on, from the last turn this tab
   * sent.
   *
   * **From a turn, which is why it is `undefined` until this tab has sent one.** The
   * conversation replay says which session the words came from and nothing about what is
   * behind it; `GoalTurnAccepted` is the one answer that names the instance, the provider
   * and the model. So the context panel shows the model once there has been a turn and says
   * nothing before — rather than naming the harness's default, which is a guess about a
   * session somebody else's process may have opened.
   */
  goalAgentRuntime = $state<
    | {
        readonly instanceId: string;
        readonly providerId: string;
        readonly modelId: string;
      }
    | undefined
  >(undefined);
  /**
   * The messages this tab has sent, oldest first.
   *
   * **Local because nothing stores them** (the spec's decision 15 and ruling 4): between
   * typing and a reload, this is the only copy of the operator's half of the conversation.
   * Cleared when the goal changes and on a reload, where the harness's own copy takes over.
   */
  goalTurns = $state<SentTurn[]>([]);

  /**
   * The files this tab has attached to the open goal, as the server described them.
   *
   * **What the server stored, not what the operator picked.** Each entry is the name the
   * file is kept under, its size on disk and whether it replaced one of the same name — all
   * three from the answer, because the browser's own `File` says nothing about what happened
   * to it. A `replaced: true` entry is why this is a list of the server's words rather than
   * a running count.
   *
   * Local to the tab, like {@link goalTurns}: nothing reads the uploads directory back for
   * the browser, and an attachment the operator made in another tab is one the agent will
   * be told about and this list will not show. That is the honest state, and the composer
   * says the agent is told on the next message rather than claiming to know the directory.
   */
  goalAttachments = $state<GoalUploadView[]>([]);
  /** True while an upload is in flight, so the attach control spins exactly once. */
  goalAttaching = $state(false);
  /** Why an upload was refused, in the server's words, beside the composer. */
  goalAttachDetail = $state("");
  /** What the server said about the files it stored. Its sentence, not this tab's. */
  goalAttachNote = $state("");

  /** True while a round's stop is in flight, so the control spins exactly once. */
  roundStopping = $state("");
  /** Why a stop was refused, in the server's words, beside the control. */
  roundStopDetail = $state("");

  /* ── Intents ──────────────────────────────────────────────────────────────── */
  /**
   * The open goal's intents, oldest first, as the server last told us.
   *
   * Server-fed and one goal's at a time: {@link intentsGoalId} says whose, and nothing
   * reads {@link intents} without agreeing with {@link openGoalId}, for the reason
   * {@link goalsTargetId} exists.
   */
  intents = $state<IntentView[]>([]);
  intentsGoalId = $state("");
  intentsState = $state<GoalsState>("idle");
  /** The server's own words when the intents could not be read. */
  intentsDetail = $state("");

  /* The Add intent form */
  intentFormOpen = $state(false);
  intentQuestion = $state("");
  /** Observation ids chosen as anchors, in the order they were ticked. */
  intentAnchors = $state<string[]>([]);
  /** The wire alias of the dimension the intent addresses, or `""` for none. */
  intentDimension = $state("");
  intentCreating = $state(false);
  /**
   * The server's sentence when an intent was refused, shown as written.
   *
   * The store's anchoring refusals name what the offending id actually is and what to do
   * instead, so they are the instruction the operator needs and are not paraphrased.
   */
  intentCreateDetail = $state("");
  /** What the form can anchor to: the open goal's observations, read when it opens. */
  goalObservations = $state<GoalObservationView[]>([]);
  goalObservationsState = $state<GoalsState>("idle");

  /**
   * The intent whose abandon confirmation is open, or `""`.
   *
   * Abandoning is one-way (an abandoned intent is not reopened; a different conclusion is a
   * new intent), so the control opens a confirmation with a place to say why first, the way
   * ending a goal does, and nothing is sent until it is confirmed. One at a time: opening a
   * second closes the first.
   */
  intentAbandonOpenId = $state("");
  /** Why, in the operator's words, for the open confirmation. Empty means none given. */
  intentAbandonReason = $state("");
  /** The intent being abandoned right now, so only its own button spins. */
  intentAbandoningId = $state("");
  /** Why an abandon was refused, against the intent it was about. */
  intentAbandonDetail = $state("");
  intentAbandonDetailId = $state("");

  /** The intent the run box is aimed at, with its current status. */
  runIntent = $derived(
    this.intents.find((intent) => intent.intentId === this.runIntentId),
  );

  /**
   * How many goals the sidebar says the open target has.
   *
   * The list's own length once it has been read for this target, since that is the number
   * of rows the section will show; before that, the count the target header read from the
   * target's file; and `undefined` when neither is this target's, so the sidebar shows no
   * number rather than another target's. Never the intent count it used to borrow.
   */
  goalCount = $derived(
    this.goalsTargetId === this.viewTargetId && this.goalsState === "ready"
      ? this.goals.length
      : this.counts !== undefined && this.viewTargetId === this.selectedId
        ? this.counts.goals
        : undefined,
  );

  /**
   * The open target's counts, only if they are this target's.
   *
   * The same guard {@link goalCount} applies, for the rail's other real numbers: a count
   * read for the target the operator just left must not sit beside the new one's name.
   */
  viewCounts = $derived(
    this.counts !== undefined && this.viewTargetId === this.selectedId
      ? this.counts
      : undefined,
  );

  /**
   * Only the open target's asset rows, whatever else an earlier visit left behind.
   *
   * The same guard the Goals screen applies to {@link goals}, and for the same reason: a
   * row from another engagement rendered under this one's name is misattribution at the
   * UI layer.
   */
  estateRows = $derived(
    this.assetsTargetId === this.viewTargetId ? this.assets : [],
  );

  /** The open target's scope, or `undefined` if it belongs to a target left behind. */
  viewScope = $derived(
    this.scopeTargetId === this.viewTargetId ? this.scope : undefined,
  );

  /**
   * The estate grouped by host, as A4 shows it.
   *
   * **Host is the grouping because it is the unit a label reaches.** A host label covers
   * every asset on that host, present and future, so grouping by anything else would put
   * the promote control somewhere it does not correspond to what the click does.
   *
   * The group's own state is the host's: taken from a row whose scope was decided at the
   * host level or by the entries, rather than from one asset's own label — an endpoint
   * excluded by hand inside an in-scope host must not relabel its whole group. Where no
   * row settles it, the first row's state stands, which is the honest fallback: every row
   * in a group shares a host, so they agree unless an asset label disagrees, and that
   * disagreement is shown on the row that carries it.
   */
  estateGroups = $derived.by(() => {
    const groups = new Map<
      string,
      { host: string; rows: AssetView[]; scope: ScopeState }
    >();
    for (const asset of this.estateRows) {
      const existing = groups.get(asset.host);
      if (existing === undefined) {
        groups.set(asset.host, {
          host: asset.host,
          rows: [asset],
          scope: asset.scope,
        });
        continue;
      }
      existing.rows.push(asset);
      // Prefer a host-level verdict over an asset-level one for the header.
      if (
        existing.scope.by._tag === "assetLabel" &&
        asset.scope.by._tag !== "assetLabel"
      ) {
        existing.scope = asset.scope;
      }
    }
    return [...groups.values()];
  });

  /**
   * The groups the Estate tab is showing, after the filter and the query.
   *
   * A group survives if it or any of its rows matches, and the rows shown are the
   * matching ones — so filtering to "Not covered" on a mostly-in-scope host shows that
   * host with the rows that need a decision, rather than hiding the host entirely.
   *
   * Nothing is removed from {@link assets} by any of this. The filter changes what is on
   * screen and never what was read, which is the difference between a view and a gate.
   */
  shownEstateGroups = $derived.by(() => {
    const query = this.estateQuery.trim().toLowerCase();
    const matchesFilter = (scope: ScopeState): boolean => {
      if (this.estateFilter === "all") return true;
      if (this.estateFilter === "in") return scope.state === "in";
      if (this.estateFilter === "out") {
        // "Excluded" means somebody said so — an entry or a hand label. A subject nothing
        // covers is `out` too, and lumping the two together is exactly the collapse the
        // three-sentence rule forbids.
        return scope.state === "out" && scope.by._tag !== "default";
      }
      return scope.by._tag === "default";
    };
    const matchesQuery = (asset: AssetView): boolean =>
      query === "" ||
      asset.host.toLowerCase().includes(query) ||
      (asset.path ?? "").toLowerCase().includes(query) ||
      asset.identity.toLowerCase().includes(query);

    return this.estateGroups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (asset) => matchesFilter(asset.scope) && matchesQuery(asset),
        ),
      }))
      .filter(
        (group) =>
          group.rows.length > 0 ||
          (matchesFilter(group.scope) &&
            (query === "" || group.host.toLowerCase().includes(query))),
      );
  });

  /**
   * How many assets fall under each of the Estate tab's four filters.
   *
   * Counted off the rows already on hand rather than asked of the server. The design
   * defers per-*entry* aggregates and pagination together, and these are neither: they are
   * four counts over one list the browser is already holding whole.
   */
  estateTally = $derived.by(() => {
    let inScope = 0;
    let excluded = 0;
    let uncovered = 0;
    for (const asset of this.estateRows) {
      if (asset.scope.state === "in") inScope += 1;
      else if (asset.scope.by._tag === "default") uncovered += 1;
      else excluded += 1;
    }
    return {
      all: this.estateRows.length,
      in: inScope,
      out: excluded,
      uncovered,
    };
  });

  /**
   * The number a rail item shows, from wherever it really comes from.
   *
   * Goals, Observations and Assets are read from the open target. Every other item shows
   * **nothing**, because nothing has read a number for it: `undefined` hides the count,
   * and that is what a real item does until it has a figure for *this* target. The rail
   * used to show the prototype's 148 observations beside a header that had read the real
   * figure, and the two disagreed; it then fell back to the prototype's other figures, so
   * a brand-new target with an empty database claimed Findings 2, Evidence 9, Workers 2
   * and Blockers 1 — four numbers nobody had counted, in the same rail as three that had
   * been. A section gets a count here when something reads one.
   */
  navCount(id: string): number | undefined {
    if (id === "goals") return this.goalCount;
    if (id === "observations") return this.viewCounts?.observations;
    if (id === "assets") return this.viewCounts?.assets;
    return undefined;
  }

  /* ── The harness and model picker ─────────────────────────────────────────── */
  /**
   * Every harness instance the server configures, ready or not.
   *
   * Server-fed and read once per session: it is the server's configuration plus what it
   * observed bringing each harness up, so it does not move while the server runs.
   *
   * **The unusable ones are kept.** `ready` is false on them and `reason` says why, and
   * the picker shows them with that sentence instead of dropping them — a configured
   * harness that silently vanished would leave an operator with nothing to act on.
   */
  harnesses = $state<HarnessInstanceView[]>([]);
  /**
   * Whether {@link harnesses} is the server's answer rather than its initial `[]`.
   *
   * An empty list is also what a server with no harness configured says, so emptiness cannot
   * stand for "not read yet". A session's harness is only declared gone once this is true.
   */
  harnessesLoaded = $state(false);
  /**
   * Which instance the operator has picked, or `""` for the server's default.
   *
   * `""` is not the same as the default instance's id, and the difference is deliberate:
   * it means "whatever this server would choose", so the request omits the field and the
   * server's own preference order answers it. An operator who picks explicitly gets
   * exactly that instance or a refusal, never a substitution.
   */
  pickedInstanceId = $state("");
  /** Which model, or `""` for the picked instance's own default. */
  pickedModel = $state("");
  /** Whether the composer's picker popover is open. */
  pickerOpen = $state(false);
  /** What the model list is being filtered by. Reset when the popover closes. */
  modelQuery = $state("");
  /**
   * What the operator has chosen *of* a model — reasoning depth, today — kept per model.
   *
   * **Keyed by instance *and* model, and that is the whole of three of the transition
   * rules.** Switching model does not carry the outgoing model's choices over, because a
   * different key is read; coming back to a model restores what was set on it, because
   * the key is still there; and switching harness cannot mix one instance's options into
   * another's, because the instance is in the key. None of that needs code to happen —
   * which is the point of keying it this way rather than holding one "current options"
   * list and trying to remember when to clear it.
   *
   * What is stored is only what an operator *set*. Picking a model's own default removes
   * the entry rather than storing the default as a value: see {@link pickModelOption}.
   */
  modelOptionsByModel = $state<Record<string, readonly ModelOptionSelection[]>>(
    {},
  );

  /** The instance a run would go to right now, as far as this tab can tell. */
  pickedInstance = $derived(
    this.harnesses.find(
      (entry) =>
        entry.instanceId ===
        (this.pickedInstanceId === ""
          ? (this.harnesses.find((candidate) => candidate.isDefault)
              ?.instanceId ?? "")
          : this.pickedInstanceId),
    ),
  );
  /** The model a run would use, resolved through the instance's default. */
  effectiveModel = $derived(
    this.pickedModel === ""
      ? (this.pickedInstance?.defaultModel ?? "")
      : this.pickedModel,
  );
  /**
   * That model's catalogue entry, when the instance lists it.
   *
   * Absent for a model an operator named that this server's catalogue does not have —
   * which is allowed, because whether a model runs is the harness's answer. Such a model
   * offers nothing to choose as far as this tab can tell, and the picker says so rather
   * than offering controls it cannot stand behind.
   */
  pickedModelView = $derived(
    this.pickedInstance?.models.find(
      (entry) => entry.id === this.effectiveModel,
    ),
  );
  /** What that model can be asked for beyond its name. Empty for most models. */
  modelDescriptors = $derived(modelOptionDescriptors(this.pickedModelView));
  /**
   * The bucket {@link modelOptionsByModel} keeps this instance-and-model's choices in.
   *
   * Built from the *resolved* instance and model rather than the raw picks, so "the
   * server's default instance" and that instance named explicitly are one bucket and not
   * two. `\u0000` separates them because it cannot occur in either id.
   */
  modelOptionKey = $derived(
    `${this.pickedInstance?.instanceId ?? ""}\u0000${this.effectiveModel}`,
  );
  /** What the operator has set on the model a run would use. Nothing, usually. */
  pickedModelOptions = $derived(
    this.modelOptionsByModel[this.modelOptionKey] ?? [],
  );
  /**
   * Choices this model has no descriptor for, so they will be dropped.
   *
   * The signal T3Code's version does not have. It is normally empty; it fills when a
   * harness comes back from a restart with a changed catalogue, and the picker renders it
   * as a sentence rather than leaving a setting to stop working quietly.
   */
  droppedModelOptions = $derived(
    droppedModelOptionIds(this.modelDescriptors, this.pickedModelOptions),
  );
  /**
   * Whether anything on this server can run at all.
   *
   * Distinct from "the picked one is ready": the composer disables submission on this,
   * and the picker explains the per-instance case. A server with two configured harnesses
   * and neither usable shows both rows with both reasons.
   */
  anyHarnessReady = $derived(this.harnesses.some((entry) => entry.ready));

  /* ── Transcripts ──────────────────────────────────────────────────────────── */
  /**
   * The last attempt this tab started, per target.
   *
   * **The only handle a browser has on a settled attempt today**, and worth being honest
   * about why. A run leaves {@link runs} the moment it settles — that list is what the
   * server is *supervising* — so without this there would be nothing to ask a transcript
   * about until the flow that lists an engagement's attempts exists, which is Flow B's.
   * Keyed by target so switching tabs does not offer one target's attempt under another's.
   *
   * It does not survive a reload, and that is not papered over: the transcript is on the
   * server either way, and inventing a list of past attempts here would be inventing the
   * screen Flow B owns.
   */
  lastAttempts = $state<Record<string, string>>({});
  /** The attempt a transcript can be read for on the open target, if this tab started one. */
  readableAttemptId = $derived(this.lastAttempts[this.viewTargetId] ?? "");

  /** The transcript last read, with where it came from. */
  transcript = $state<AttemptTranscript | undefined>(undefined);
  /** Which attempt {@link transcript} is about, so a stale read is never shown. */
  transcriptAttemptId = $state("");
  transcriptLoading = $state(false);
  /** Unreachable-server text for the transcript panel. Refusals arrive in the value. */
  transcriptDetail = $state("");

  /* ── The live transcript ──────────────────────────────────────────────────── */
  /**
   * What the open target's live transcript has shown, in arrival order.
   *
   * **Arrival order, and deliberately not re-sorted.** The record items arrive in the
   * order the store assigned them — the server reads `WHERE sequence > ? ORDER BY
   * sequence` and nothing between here and there reorders a stream — so appending is what
   * preserves that order. Sorting by {@link LiveItem.at} would actively break it: two
   * items can share a millisecond, and a run's timestamps come from the store, the harness
   * and this server's own clock, which are three clocks. Sorting by `sequence` would have
   * to invent one for every activity item, which is the claim the contract refuses to make.
   */
  liveItems = $state<LiveItem[]>([]);
  /**
   * The highest store-assigned sequence this tab has been shown.
   *
   * The resume cursor within this tab. A reload has no rendered items, so it reconstructs
   * from zero rather than trusting a persisted cursor whose preceding items are absent.
   */
  liveCursor = $state(0);
  /** Whether the record channel has delivered everything committed up to its cursor. */
  liveCaughtUp = $state(false);
  /**
   * How many committed events the connection would not send, from its opening frame.
   *
   * Non-zero means what is on screen starts part way through this target's record. Shown,
   * not swallowed: a transcript that looked complete and was not is the wrong kind of quiet.
   */
  liveSkipped = $state(0);
  /** True between asking for a connection and whatever ends it. */
  liveWatching = $state(false);
  liveReconnecting = $state(false);
  /** Last persisted recovery outcomes for the target on screen. */
  liveRecoveries = $state<TargetView["recoveries"]>([]);
  /** What ended the connection, in the client's words. Empty while it is up or stopped. */
  liveDetail = $state("");
  /** Which target {@link liveItems} belong to, so one target's never shows under another. */
  liveTargetId = $state("");

  /**
   * The newest model call per session, keyed by {@link usageScope}.
   *
   * **The latest, never a running sum, and that is the whole correctness of the meter.**
   * Both drivers publish cumulative figures that re-count the cached prefix on every call,
   * and `live.ts` has the measured consequence: a meter built by adding these up reads four
   * to five times high. So each frame *replaces* the one before it for its session —
   * including a frame with the same `callId`, which is how Claude Code tops up a call's
   * output count once its turn ends — and nothing here accumulates anything.
   *
   * A record rather than a `Map` because `$state` has to see the write: reassigning the
   * object is what makes the deriveds below recompute.
   *
   * Cleared with {@link liveItems} when the target changes, for that field's reason: a
   * figure from another target's run has no place on this one's screen.
   */
  liveUsage = $state<Record<string, LiveUsage>>({});

  /**
   * The open goal's chat: its rounds, their replayed prose and their live rows.
   *
   * Declared here, among the live transcript's state, rather than up with the planner
   * rounds it is mostly about: a `$derived` is initialised in field order, so one that read
   * {@link liveItems} before that field existed would be reading an uninitialised class
   * field. It is the live feed that decides where it goes.
   *
   * Derived rather than stored, so one arriving item moves the chat without anything having
   * to remember to rebuild it. The rules it applies — grouping by round, folding a tool
   * result into its call, and collapsing a write into the record it produced — are all in
   * `chat.ts`, which is a plain module so they can be tested without a browser.
   */
  goalChat = $derived(
    buildChat({
      rounds: this.planRoundsGoalId === this.openGoalId ? this.planRounds : [],
      items: this.liveTargetId === this.viewTargetId ? this.liveItems : [],
      narration:
        this.goalNarrationGoalId === this.openGoalId
          ? this.goalNarration
          : undefined,
      narrationFloor: this.goalNarrationFloor,
      inFlight: new Set(this.runningRounds.map((round) => round.roundId)),
    }),
  );

  /**
   * The open goal's **conversation**: the agent's narration, the record of what it did, and
   * what this tab has said to it.
   *
   * Beside {@link goalChat} rather than part of it, because they are two conversations with
   * two different agents on one page: the planner's is grouped by round and read-only, and
   * this one is one stretch with a composer. The rules for both are in `chat.ts`.
   */
  /**
   * Whether the agent still owes an answer to the last thing this tab said.
   *
   * True while a message is in flight, and after it is accepted until **any** narration for
   * this goal arrives above the publish order the message was sent at. That is the same
   * join everything else on this surface uses, and it is deliberately not a timeout: an
   * agent reading a briefing can be quiet for a while, and a strip that gave up on it
   * would be inventing a deadline for work this build does not bound.
   */
  goalAwaiting = $derived.by(() => {
    if (this.goalSending) return true;
    const last = this.goalTurns.at(-1);
    if (last === undefined) return false;
    return !this.liveItems.some(
      (item) =>
        item.goalId === this.openGoalId &&
        (activityOrder(item) ?? -1) > last.after,
    );
  });

  goalConversationChat = $derived(
    buildGoalConversation({
      goalId: this.openGoalId,
      items: this.liveTargetId === this.viewTargetId ? this.liveItems : [],
      conversation:
        this.goalConversationGoalId === this.openGoalId
          ? this.goalConversation
          : undefined,
      narrationFloor: this.goalConversationFloor,
      sent: this.goalTurns,
      replayedThrough: this.goalConversationThrough,
      awaiting: this.goalAwaiting,
      /*
       * Whether a write with no record yet is still worth waiting for, which is the goal's
       * own status and not anything the conversation knows. `true` while the row has not
       * loaded: see `chat.ts` on why an unknown reads as `pending` rather than `unresolved`.
       */
      conversationLive: (this.openGoalView?.status ?? "active") === "active",
    }),
  );

  /**
   * The context meter for the planner pane: the round it is about, and that round only.
   *
   * **The round in flight if there is one, else the newest** — which is the same subject the
   * strip under that chat already reports on, so the figure and the sentence beside it are
   * about one round. A meter over "the newest call on this target" would jump between two
   * concurrent rounds and between a round and a worker, and a number that changes subject
   * without saying so is worse than no number.
   *
   * `undefined` before the round's first model call, and for a reloaded round whose session
   * this process is not watching: narration is not replayed (decision 14), so there is
   * nothing to measure a finished round with and the pane shows no meter rather than the
   * last one it happened to see.
   */
  plannerContextMeter: ContextMeter | undefined = $derived.by(() => {
    const round = this.openGoalRunningRound ?? this.latestPlanRound;
    if (round === undefined) return undefined;
    return contextMeter(this.liveUsage[roundUsageScope(round.roundId)]);
  });

  /** The context meter for the goal conversation: its own agent's session. */
  goalContextMeter: ContextMeter | undefined = $derived.by(() =>
    this.openGoalId === ""
      ? undefined
      : contextMeter(this.liveUsage[goalUsageScope(this.openGoalId)]),
  );

  /**
   * Ids already shown, so an item delivered twice is shown once.
   *
   * A reconnect re-reads a range of the record on purpose — the client's cursor is the last
   * item it *received*, and asking to be answered after it is what guarantees nothing
   * committed in the gap is skipped — so the same event arriving again is the normal case
   * rather than a fault, and this is what makes it invisible. A record item's id is the
   * store's own event id, which is why that works across connections and across a server
   * restart.
   *
   * **Bounded at {@link App.LIVE_IDS_KEPT}, oldest evicted first.** Unbounded, this grew
   * one string per narrated moment for as long as a tab stayed open on a run, which for an
   * agent working overnight is the one structure here with no ceiling at all.
   *
   * What the bound costs, stated rather than hoped over: an id evicted after
   * `LIVE_IDS_KEPT` newer items would be shown a second time if the server sent it again.
   * Within one connection the server never does — the record reader's cursor only moves
   * forward — so the only path is a reconnect, which resumes *after* the cursor and
   * therefore re-sends only what is newer than the last item this tab saw. The eviction
   * window is four times the number of items kept on screen, so the ids that can be
   * re-delivered are, by a wide margin, ones already dropped from the view.
   *
   * Not `$state`: nothing renders it, and a reactive `Set` would make every arrival
   * invalidate every reader of the list.
   */
  #shown = new Set<string>();
  /**
   * The same ids in arrival order, so the oldest can be evicted.
   *
   * A second structure rather than relying on `Set` iteration order: insertion order is
   * specified for `Set`, but evicting from the front of it means `values().next()` per
   * eviction, and an array index is the same answer without the iterator.
   */
  #shownOrder: string[] = [];
  /** The live connection's stop function, while one is open. */
  #stopLive: (() => void) | undefined;
  /**
   * Cancels the silence watchdog, while one is armed.
   *
   * See {@link App.prototype.watchLive}. Held apart from {@link stopLive} because the two
   * are cancelled on different occasions: every frame re-arms the watchdog without touching
   * the connection.
   */
  #cancelSilence: (() => void) | undefined;
  #cancelReconnect: (() => void) | undefined;
  #liveGeneration = 0;
  #reconnectFailures = 0;

  /* New target */
  dialogOpen = $state(false);
  /** Server-fed: the folder currently being listed. */
  dialogPath = $state("");
  /** Server-fed: the configured root. Nothing above it is reachable. */
  dialogRoot = $state("");
  /**
   * Server-fed: where this server keeps `control.sqlite` and every target's directory.
   *
   * Held for one sentence on the create-target form, and that sentence is the one the
   * field used to get wrong: the chosen folder is the workspace, and the hunt database is
   * written under *this* root instead. It is the server's answer rather than a guess —
   * `HUNT_ROOT` is the server's environment and the browser cannot see it — and `""` until
   * the answer arrives, which the form words around rather than filling with a placeholder.
   */
  fleetRoot = $state("");
  /** Server-fed: the parent, or `null` at the root. */
  dialogParent = $state<string | null>(null);
  /** Server-fed: the immediate subdirectories of `dialogPath`. */
  dialogEntries = $state<{ name: string; path: string }[]>([]);
  /** A refusal from the picker, in the server's words. */
  dialogPathError = $state("");
  dialogBusy = $state(false);
  dialogChosen = $state("");
  /**
   * The row the folder picker has selected, which is **not** yet the form's folder.
   *
   * It used to be the same field, and that is what made the picker's only exit a dead
   * end: a stale selection outlived the listing it was made in, so typing a new path and
   * submitting it left `dialogChosen` on the old folder, "Use this folder" handed back
   * that old folder — the one the refusal was about — and nothing reset the refusal. Two
   * paths were on screen, the selected one and the one being listed, and the button took
   * the one the operator had moved away from.
   *
   * Held apart, the picker is free to drop a selection the moment the listing moves (see
   * {@link App.prototype.browseTo}) without Cancel losing the folder the form already
   * had. Only {@link App.prototype.useChosenFolder} promotes it.
   */
  dialogSelection = $state("");
  #dialogName = $state("");
  /**
   * The target's name, as typed.
   *
   * An accessor rather than a plain field so that editing it clears the server's refusal
   * *of this string*. Without that, an operator who typed `###`, was told the name could
   * not be used and then corrected it was left reading a refusal about a name that was no
   * longer on screen.
   */
  get dialogName(): string {
    return this.#dialogName;
  }
  set dialogName(name: string) {
    if (name === this.#dialogName) return;
    this.#dialogName = name;
    if (this.createState === "invalid-name") {
      this.createState = "idle";
      this.createDetail = "";
    }
  }
  dialogScope = $state("");
  createState = $state<CreateState>("idle");
  /** The server's own words for whichever create state is showing. */
  createDetail = $state("");
  /** For the duplicate state: the target already holding that folder. */
  duplicateOf = $state("");

  /**
   * Whether the folder browser is open.
   *
   * **The only modal A3 leaves standing.** It does one thing and hands back one value, so
   * it can be modal without trapping anything: open it, choose, land back on the form with
   * the path filled and every other field as you left it.
   */
  folderPickerOpen = $state(false);

  /* ── The Auto-load page (A6 D1, D13) ──────────────────────────────────────── */

  /**
   * Whether the open target's Auto-load page is showing, in place of its Assets page.
   *
   * **A page, not a dialog**, and not a screen either: it is a sub-page of the Assets
   * section, the way an open goal is of Goals, so the rail, the crumbs and the live dock
   * stay where they are and the target is already in hand. It is reached from Assets
   * ({@link openImporter}) and left by going anywhere else — `toSection` and `openTarget`
   * both close it, and stop watching an import on the way out.
   *
   * It is a chat with the importer (A6 D2–D5). On a real target its session list, its
   * composer and the importer's live words are the server's (the importer conversation
   * design, S1–S4); the state picker's scenarios are declared. The form, the model picker
   * and the polled progress panel it used to carry are still here as state
   * ({@link importerPhase}, {@link programLinks}, {@link startScopeImport}) and no longer on
   * screen; they go when the chat has replaced them everywhere.
   */
  importerOpen = $state(false);
  /**
   * The Auto-load chat's sessions, the one on screen and its composer.
   *
   * Handed the target's live feed as a function, so the chat's groups read it where they
   * are derived and an arriving entry moves them. Guarded by target, for
   * {@link liveTargetId}'s reason: one target's feed never shows under another.
   */
  importer = new ImporterSessions(
    undefined,
    () => (this.liveTargetId === this.viewTargetId ? this.liveItems : []),
    () => (this.liveTargetId === this.viewTargetId ? this.liveSkipped : 0),
  );
  /**
   * Which half of the Auto-load page is showing: the links and the model, or the import's
   * progress. `importing` once an import has started on this target in this tab.
   */
  importerPhase = $state<ImporterPhase>("form");
  /** True from the click on Start until the server has answered it. */
  importStarting = $state(false);
  /**
   * Why no import started, in the server's words — no harness, a dead picked instance, a
   * target that will not open. Shown beside the form, which stays on screen.
   */
  importStartDetail = $state("");

  /**
   * The program pages the importer will read, as the operator is typing them.
   *
   * **A list of drafts with ids rather than a list of strings**, because Svelte's `{#each}`
   * needs a stable key for a repeatable input list: keyed on the string, two identical
   * half-typed URLs collapse into one row and the operator's cursor jumps. The id is
   * local and never sent.
   *
   * It starts with one empty row, which is what A3 shows: the field is there to be typed
   * into, and an empty list with only an "Add another link" button would make pasting one
   * URL a two-click operation.
   */
  programLinks = $state<{ id: number; url: string }[]>([{ id: 1, url: "" }]);
  #nextLinkId = 2;

  /** The links that would actually be sent: non-empty, trimmed, in order, deduplicated. */
  usableLinks = $derived.by(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const link of this.programLinks) {
      const url = link.url.trim();
      if (url === "" || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out.slice(0, SCOPE_IMPORT_MAX_LINKS);
  });

  /* ── The importer's model (D15) ───────────────────────────────────────────── */

  /**
   * What the server says an import would run on, resolved against the live catalogue.
   *
   * **Read from the server, never written down here.** `modelOption.ts`'s doctrine is the
   * reason and it is worth restating at the one place a constant would have been
   * convenient: a descriptor is observed when the server built its harnesses and replaced
   * wholesale when they are rebuilt, so a model id in this bundle would outlive the
   * catalogue entry it names and this screen would offer a choice the server could not
   * honour. `undefined` means "not asked yet"; `importModelDetail` carries the refusal when
   * there is no harness to resolve against.
   */
  importerModel = $state<ImporterModelView | undefined>(undefined);
  /** Why there is no resolved model, in the server's words. Empty when there is one. */
  importModelDetail = $state("");
  /**
   * Whether the server *answered* that no harness is ready (`ImporterModelUnavailable`), as
   * opposed to the lookup failing some other way — no server at the address, a refusal of
   * another kind. Both leave {@link importerModel} unset; only this one makes "no agent
   * harness is ready" a true sentence.
   */
  importModelNoHarness = $state(false);
  /** The operator's override, or "" for "whatever the server resolved". */
  pickedImportInstanceId = $state("");
  pickedImportModel = $state("");
  importPickerOpen = $state(false);
  importModelQuery = $state("");

  /** The instance the import would use: the operator's pick, else the resolved default. */
  importInstance = $derived.by(() => {
    const wanted =
      this.pickedImportInstanceId !== ""
        ? this.pickedImportInstanceId
        : this.importerModel?.instanceId;
    return this.harnesses.find((entry) => entry.instanceId === wanted);
  });

  /** The model id the import would use, as a string the screen can print. */
  effectiveImportModel = $derived(
    this.pickedImportModel !== ""
      ? this.pickedImportModel
      : this.pickedImportInstanceId !== "" &&
          this.pickedImportInstanceId !== this.importerModel?.instanceId
        ? // Another instance was picked with no model, so the resolved model — which
          // belongs to a different harness's catalogue — says nothing here. The server
          // applies the same rule; this is only what the screen shows meanwhile.
          (this.importInstance?.defaultModel ?? "")
        : (this.importerModel?.model ?? ""),
  );

  /**
   * What the operator has set *of* the importer's model, kept per instance and model.
   *
   * {@link modelOptionsByModel}'s twin and keyed the same way, for the same transition
   * rules — but a store of its own, because a run's model and an import's are picked
   * separately and a reasoning level set for one should not quietly ride along on the
   * other. Only what was *set* is stored; see {@link pickImportModelOption}.
   */
  importModelOptionsByModel = $state<
    Record<string, readonly ModelOptionSelection[]>
  >({});
  /** The import model's catalogue entry, when its instance lists it. */
  importModelView = $derived(
    this.importInstance?.models.find(
      (entry) => entry.id === this.effectiveImportModel,
    ),
  );
  /** What the import model can be asked for beyond its name. Empty for most models. */
  importModelDescriptors = $derived(
    modelOptionDescriptors(this.importModelView),
  );
  /** {@link modelOptionKey}'s rule, over the import's resolved instance and model. */
  importModelOptionKey = $derived(
    `${this.importInstance?.instanceId ?? ""}\u0000${this.effectiveImportModel}`,
  );
  /** What the operator has set on the model an import would use. Nothing, usually. */
  pickedImportModelOptions = $derived(
    this.importModelOptionsByModel[this.importModelOptionKey] ?? [],
  );
  /** Choices the import model has no descriptor for, so they will not be sent. */
  droppedImportModelOptions = $derived(
    droppedModelOptionIds(
      this.importModelDescriptors,
      this.pickedImportModelOptions,
    ),
  );

  /*
   * There is no filtered model list here, and `modelQuery` has no sibling derivation
   * either: **the filter lives in `HarnessChoice`**, once, for both the composer's picker
   * and this screen's. It was written twice — identically, with nothing keeping the two
   * the same — and a filter that means two things in two places is the kind of drift an
   * operator meets as "the same control behaving differently". What stays here is
   * `importModelQuery`, because the *query* is state that has to survive the picker being
   * closed and reopened; what was derived from it is the component's.
   */

  /* ── The import in progress (D16) ─────────────────────────────────────────── */

  /**
   * The import the panel is watching, or `undefined`.
   *
   * **It carries tool calls and nothing else**, because that is all the contract has: the
   * panel is a receipt for what landed on the target, and there is no field on
   * `ScopeImportView` for narration. A reasoning line cannot reach this screen, because
   * nothing on the server ever captured one.
   */
  scopeImport = $state<ScopeImportView | undefined>(undefined);
  /** Which import is being watched, so a stale poll cannot write over a newer one. */
  scopeImportId = $state("");
  /** The target the import is writing to. Where the three exits lead. */
  scopeImportTargetId = $state("");
  /** A refusal from the import read or the stop, in the server's words. */
  scopeImportDetail = $state("");
  /**
   * The error toast for an import that produced nothing, or could not start.
   *
   * Per D15 this is **not** an error state: the operator is moved on to the target's
   * Assets screen and told in a toast, because the target was created and is entirely
   * usable with no scope — the same state as a target created with no links at all.
   * Keeping someone on a dead progress panel to contemplate a failure they cannot fix from
   * there would be worse.
   */
  toast = $state("");
  #stopPolling: (() => void) | undefined;

  selected = $derived(
    this.targets.find((t) => t.id === this.selectedId) ?? this.targets[0],
  );

  /* ── Session ─────────────────────────────────────────────────────────────── */

  /**
   * Opens a session against the server, or lands on the right failure.
   *
   * The two failures are not interchangeable and are not guessed at: a `SessionRefused`
   * is the server saying the password was wrong, and goes on the password field with the
   * field cleared, because a refused password should not sit there inviting a second
   * submit of the same thing. Anything else is "no server answered at this address" and
   * goes on the URL field, with the start command shown underneath.
   */
  async connect() {
    if (this.password.length === 0) return;
    this.connecting = true;
    this.connectDetail = "";
    try {
      if (this.simulateDown) {
        this.connectError = "unreachable";
        this.connectDetail = "simulated by the state picker";
        return;
      }
      const call = await this.client.openSession(this.serverUrl, this.password);
      if (call._tag === "Refused") {
        this.connectError = "password";
        this.password = "";
        return;
      }
      if (call._tag === "Unreachable") {
        this.connectError = "unreachable";
        this.connectDetail = call.detail;
        return;
      }
      this.client.setToken(call.value.token);
      this.connectError = "none";
      this.password = "";
      this.screen = "welcome";
      await this.loadTargets();
      // Once per session, with the target list: the harness configuration does not move
      // while a server runs, and the composer on every open target reads the same answer.
      await this.loadHarnesses();
      this.releaseRequestedPlace();
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Tries the token a reload left behind, exactly once, at startup.
   *
   * It asks the server rather than trusting the stored string. A token in
   * `sessionStorage` says only that this tab once had a session — the server holds its
   * registry in memory, so a restart has invalidated it and nothing in the browser can
   * know that without asking. Rendering the Welcome screen on the strength of a stored
   * token would show the operator a target list that is no longer theirs.
   *
   * An `Unauthenticated` answer is a refusal and clears the token. An unreachable server
   * is *not*: the token may still be good, so it is kept and the operator gets the
   * Connect screen with the unreachable state, not a spurious "your session ended".
   */
  async restore() {
    const token = this.client.storedToken();
    if (token === undefined) return;
    this.client.setToken(token);
    const call = await this.client.probe(this.serverUrl);
    if (call._tag === "Ok") {
      this.dialogRoot = call.value.workspaceRoot;
      this.fleetRoot = call.value.fleetRoot;
      this.screen = "welcome";
      await this.loadTargets();
      await this.loadHarnesses();
      // A deep link resumes into the place it named, which is the whole point of the URL
      // carrying one: reloading the tab must not drop you back on the list.
      this.releaseRequestedPlace();
      return;
    }
    if (call._tag === "Refused") {
      this.client.setToken(undefined);
      this.screen = "connect";
      this.connectError = "expired";
      return;
    }
    this.screen = "connect";
    this.connectError = "unreachable";
    this.connectDetail = call.detail;
  }

  signOut(reason: ConnectError = "none") {
    this.client.setToken(undefined);
    this.screen = "connect";
    this.password = "";
    this.connectError = reason;
    // A note about a link followed in the session that just ended. The Connect screen does
    // not render it, so leaving it would make it reappear behind a *later* sign-in.
    this.#retireArrivalNote();
    this.targets = [];
    this.selectedId = "";
    this.viewTargetId = "";
    this.counts = undefined;
    this.viewState = "empty";
    this.viewDetail = "";
    this.runs = [];
    this.runIntentId = "";
    this.runFallback = null;
    this.runDetail = "";
    // The next sign-in may be to another server, whose registry is its own.
    this.#agentsRead = false;
    this.importer.forgetServerAgents();
    this.#clearGoals();
    // The connection carries a bearer that has just been dropped, so it has to go with it:
    // a stream left open on a signed-out session is a credential still in use. What it
    // showed goes too — this is one of the exits where it belongs to a session that no
    // longer exists.
    this.#forgetLive();
  }

  /* ── Targets ─────────────────────────────────────────────────────────────── */

  /**
   * Replaces the rail with what the registry holds.
   *
   * A session that has gone stale between screens signs out with `expired` rather than
   * leaving the last known rows on screen pretending to be current. Losing contact is
   * different: the rows stay and the reconnect banner goes up, which is what that banner
   * is for — "what you see below is the last known state".
   */
  async loadTargets() {
    const call = await this.client.targets(this.serverUrl);
    if (call._tag === "Refused") {
      this.signOut("expired");
      return;
    }
    if (call._tag === "Unreachable") {
      this.reconnecting = true;
      this.bannerDismissed = false;
      this.connectDetail = call.detail;
      return;
    }
    this.reconnecting = false;
    const now = Date.now();
    this.targets = call.value.map((summary) => fromSummary(summary, now));
    if (this.targets.find((t) => t.id === this.selectedId) === undefined) {
      this.selectedId = this.targets[0]?.id ?? "";
    }
  }

  /**
   * Makes a target the selected one, without opening it.
   *
   * One target is mounted at a time — there is no tab row, so no per-tab state to keep —
   * and switching is the target crumb's picker rather than a list of open ones.
   */
  select(id: string) {
    this.selectedId = id;
    this.search = "";
  }

  /**
   * Opens a target: Level 1 gives way to Level 2, and the server opens a database.
   *
   * The screen switches first and the counts follow, so the frame is up while the request
   * is in flight rather than the operator waiting on a blank page for a file to be opened.
   * The header shows its loading state for that moment and never shows the previous
   * target's numbers, because {@link refreshTarget} clears them before it asks.
   *
   * **This is where {@link viewTargetId} moves, and the only place.** Navigating is a
   * decision the operator made; reading a target's counts is a consequence of one. When
   * the same method did both, a read that finished late could move the view to a target
   * nobody had asked for — see {@link refreshTarget}.
   */
  openTarget(id: string) {
    this.#retireArrivalNote();
    // A different target, or the same one reopened, is never the Auto-load page: and if its
    // panel was polling, that poll is about an import this screen is no longer showing.
    if (this.importerOpen) {
      this.stopWatchingImport();
      this.importerOpen = false;
    }
    this.select(id);
    this.screen = "target";
    this.navItem = "goals";
    this.detailOpen = false;
    this.runIntentId = "";
    this.runFallback = null;
    this.runDetail = "";
    this.viewTargetId = id;
    // Cleared before the read, like the counts: between two targets the only honest
    // answer is "reading", and the previous target's objectives must not be on screen.
    this.#clearGoals();
    // Cleared for the same reason the goals are, and *not* read here: the Assets screen is
    // one section of several and the operator lands on Goals. Reading the estate of every
    // target they open would spend a request per open on a screen they may never go to.
    // `toSection` asks for it when they do.
    this.#clearEstate();
    void this.refreshTarget(id);
    void this.loadGoals(id);
    // Asked on every open, because a run started in another tab — or by this one before a
    // reload — is a fact about the server that this screen has no other way to learn.
    void this.loadRuns();
    // And the live transcript, which is the other half of that: `loadRuns` says *that*
    // something is running and this says what it is doing. Opened before the counts come
    // back, so a run already in progress starts appearing while the header is still
    // loading rather than after it.
    this.watchLive(id);
  }

  /**
   * Refreshes the open target: its row and the counts from its own `hunt.sqlite`.
   *
   * **It reads. It does not navigate.** {@link viewTargetId} belongs to
   * {@link openTarget}, and this method only ever asks about the target that field
   * already names. That division is load-bearing rather than tidy-minded, because this
   * method used to assign `viewTargetId` as its first statement — which made the guard
   * below useless to anyone but itself. A guard cannot protect a value from the call
   * that sets it, so `startRun` and `stopRun` refreshing at their tails could land a
   * target the operator had already navigated away from: the header blanked, but the
   * composer went on showing *that* target's run, offering *that* target's transcript,
   * and pointing its Stop button at *that* target's attempt while a different target was
   * on screen. A Stop that acts on something not on screen is misattribution at the UI
   * layer, which is the one thing this product may not do.
   *
   * So a refresh of a target that is not in view has nothing to refresh, and says so by
   * doing nothing. The guard after the request then does the job it was written for: an
   * answer about a target the operator has since left.
   *
   * Three refusals, each landing somewhere different, because they are different facts:
   *
   * - `TargetNotFound` — the link is stale or the id is not an id. Back to the list; there
   *   is nothing to show a header for.
   * - `TargetUnavailable` — the target exists and will not open. The header stays, saying
   *   so in the server's own words, which are the same words the rail dims the row with.
   *   It is deliberately *not* a bounce to the list: the operator asked about this target
   *   and the answer is about this target.
   * - `Unauthenticated` — the session went while we were looking. Sign out as expired
   *   rather than leave a screen that cannot be refreshed.
   *
   * The response carries the target's own row, so this also refreshes the rail entry it
   * came from: a deep link into a cold tab has a name and a scope note before the list
   * has loaded.
   */
  async refreshTarget(id: string) {
    // Asked before anything is written, so a refresh for a target that has gone off
    // screen cannot clear the counts of the one that replaced it, cannot show it a
    // loading state, and does not spend a request it would only discard below.
    if (this.viewTargetId !== id) return;
    // Cleared before the request, not after it: between two targets there is a moment
    // where the only honest answer is "reading", and stale counts in that moment are the
    // exact thing this screen must never show.
    this.counts = undefined;
    this.viewDetail = "";
    this.viewState = "loading";

    const call = await this.client.target(this.serverUrl, id);
    // A second open may have overtaken this one. Whatever came back is about a target the
    // operator has already left, so it is dropped rather than rendered.
    if (this.viewTargetId !== id) return;

    if (call._tag === "Unreachable") {
      this.viewState = "unreachable";
      this.viewDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      const error = call.error;
      const detail =
        "detail" in error && typeof error.detail === "string"
          ? error.detail
          : "";
      if (error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      if (error._tag === "TargetNotFound") {
        await this.#targetIsGone(id);
        return;
      }
      this.viewState = "unavailable";
      this.viewDetail = detail;
      return;
    }

    const now = Date.now();
    const row = fromSummary(call.value.target, now);
    this.targets = this.targets.some((target) => target.id === row.id)
      ? this.targets.map((target) => (target.id === row.id ? row : target))
      : [...this.targets, row];
    this.counts = call.value.counts;
    this.liveRecoveries = call.value.recoveries;
    this.viewState = "ready";
  }

  /**
   * The fallback for a target this server's registry does not hold: the list, and a
   * sentence saying so.
   *
   * Design D5's first case, and it arrives two ways that have to behave alike. A URL names
   * a target that has gone, which is the bookmark the design is about; or the operator
   * clicks a rail row for a target something else removed while this tab held the list.
   * Both end up here through {@link refreshTarget}'s `TargetNotFound`, and the sentence is
   * true of both without accusing either — it says what this server has, not what the
   * operator did.
   *
   * There is also a third way in, {@link confirmOpenGoal}'s own `TargetNotFound`, which is
   * why this is a method rather than a branch. A deep link to a goal on a target that has
   * gone asks about both at once, and the two answers must not be two different screens.
   *
   * The note is set **before** the list is read, so the sentence is up while the read is in
   * flight rather than arriving after it: the operator has just been moved, and that is the
   * moment the explanation is worth having.
   */
  async #targetIsGone(id: string) {
    this.viewState = "empty";
    this.screen = "welcome";
    // There is no target to watch any more. Forgotten rather than left running against a
    // deep link to something the registry does not hold.
    this.#forgetLive();
    this.arrivalNote = targetGoneNote(id);
    await this.loadTargets();
  }

  /**
   * Opens a target with the prototype's counts and goals and no request, for the state
   * picker.
   *
   * The picker's job is to reach a UI state without reproducing the conditions that cause
   * it, and its rows are mock rows that no server has heard of — so asking the server
   * about one would land on `TargetNotFound` and bounce back to the list. This is the same
   * shortcut `reset()` is: real where it can be, declared where it cannot.
   */
  previewTarget(id: string) {
    this.#retireArrivalNote();
    this.select(id);
    this.screen = "target";
    this.detailOpen = false;
    this.viewTargetId = id;
    this.counts = previewCounts;
    this.viewState = "ready";
    this.viewDetail = "";
    // Declared, not read: this target is a mock row, so asking the server for its goals
    // would land on `TargetNotFound`, and not asking would leave the Goals page reading
    // for ever. Marked `ready` for the target on screen, with the two rows `previewCounts`
    // says it has.
    this.#clearGoals();
    this.goals = previewGoals(id);
    this.goalsTargetId = id;
    this.goalsState = "ready";
  }

  /**
   * Remembers the place a URL asked for, to land on once there is a session.
   *
   * Two strings, split along what `App` can read: `targetId` is the part it can check
   * against the registry, `path` is text it only carries. See {@link requestedPath} for
   * why the place does not arrive here parsed.
   */
  /**
   * Retires a standing arrival note, because the operator has gone somewhere of their own
   * choosing.
   *
   * Called at the head of every method that moves the app: {@link openTarget},
   * {@link toSection}, {@link toAllTargets}, {@link openGoal}, {@link toAssetsTab},
   * {@link toSettings}, {@link openImporter}, {@link previewTarget}. The sentence is about
   * where a link *sent* them, so the moment they pick a destination themselves it has
   * stopped being about anything on screen.
   *
   * **At the head, and that is load-bearing.** Each of D5's three fallbacks navigates to
   * the place it falls back to and *then* writes its note, so the clear has to happen on
   * the way in or the fallback would erase its own sentence. A clear at the tail would have
   * worked for two of the three and silently not for the one that matters.
   *
   * A method rather than nine assignments, so that the reason is written once and the next
   * navigation someone adds has somewhere to find it.
   */
  #retireArrivalNote() {
    this.arrivalNote = "";
  }

  /** Puts away a note the operator has read. The route's banner offers this. */
  dismissArrivalNote() {
    this.arrivalNote = "";
  }

  requestPlace(targetId: string, path: string) {
    this.requestedTargetId = targetId;
    this.requestedPath = path;
  }

  /**
   * Releases the place a URL asked for, if its target is one this server has.
   *
   * Called after the list is loaded, by both ways in — a fresh sign-in and a resumed
   * session — because a link should land in the same place either way.
   *
   * A target the registry does not hold is dropped *here*, before anything is opened: the
   * list is already on screen, and it is the honest answer to "that target is not on this
   * server". The check is in `App` rather than in the route because it is the one question
   * about a held link that `App` is the authority on.
   *
   * **It is no longer dropped silently**, which is design D5 and the whole of S5. The
   * operator asked for something specific by following a link, waited behind the Connect
   * screen for it, and used to be left on a target list with nothing said and the address
   * bar quietly tidied to `/`. {@link arrivalNote} gets the sentence instead, and the route
   * is what puts it on screen. The target is *not* opened to find this out: the registry is
   * already in hand, so the refusal costs no request and there is no flash of a target on
   * its way to being refused.
   *
   * Only the target is checked, because only the target is a question `App` can answer
   * without the grammar. A held path whose *goal* or *chat* has gone is replayed and
   * answered by {@link confirmOpenGoal} and {@link openImporterSession} once the place is
   * being applied.
   *
   * The release happens whether or not anything is listening. A second shell, or a test,
   * can hold a place, reach this moment and simply never replay it — no screen moves and
   * nothing is left pending, which is the correct behaviour for a harness with no router.
   */
  releaseRequestedPlace() {
    const id = this.requestedTargetId;
    const path = this.requestedPath;
    this.requestedTargetId = "";
    this.requestedPath = "";
    if (id === "" || path === "") return;
    if (!this.targets.some((target) => target.id === id)) {
      this.arrivalNote = targetGoneNote(id);
      return;
    }
    this.replayPath = path;
  }

  /**
   * Takes the released path, and leaves nothing behind.
   *
   * Once, because a place is replayed once. The route reads this from an effect, and an
   * effect re-runs: a path that stayed put would replay the link again the next time
   * anything that effect reads moved, pulling the operator back to a page they had left.
   */
  takeReplayPath(): string {
    const path = this.replayPath;
    this.replayPath = "";
    return path;
  }

  toSettings() {
    this.#retireArrivalNote();
    this.navItem = "settings";
  }

  /**
   * Moves to a section of the open target.
   *
   * Choosing Goals from inside one goal means the list, not the same page, so it closes
   * the goal as well.
   *
   * **A read transcript is closed for the same reason, and that is not a second rule.** A
   * transcript is a record showing inside a section, exactly as an open goal is, so leaving
   * the section puts it away. The symmetry was missing: `transcriptAttemptId` used to be
   * cleared only by {@link reset}, so a transcript read on Goals went on being the
   * *addressable place* of the Workers section for the rest of the visit — `placeOf` reads
   * the pair `navItem === "workers" && transcriptAttemptId !== ""` — and the URL kept
   * claiming `/t/<id>/attempts/<id>` over a section that had no attempt in hand.
   *
   * S4 made that visible and unacceptable. With history navigation, traversing onto a plain
   * `/t/<id>/workers` entry applied the section, `placeOf` answered with the stale attempt,
   * and the reflection pushed the attempt path straight back — so Back could not pass that
   * entry at all. Clearing here is what makes `placeOf` honest, and honest is what Back
   * needs: a section the operator chose names no attempt, and the Workers transcript panel
   * goes back to being what its own comment says it is, the attempt a *link* named.
   *
   * The attempt itself is not forgotten — {@link lastAttempts} is untouched, so the Goals
   * panel still offers "Read transcript" for the attempt this tab started. What is dropped
   * is the reading, not the handle.
   */
  toSection(id: string) {
    this.#retireArrivalNote();
    // Going to a section — Assets included — leaves the Auto-load page, and stops watching
    // the import its panel was showing. The import runs on: nothing here ever drove it.
    if (this.importerOpen) {
      this.stopWatchingImport();
      this.importerOpen = false;
    }
    this.navItem = id;
    if (id === "goals") this.closeGoal();
    // Before any of the reads below, and before `applyPlace`'s attempt case calls
    // `loadTranscript` — which sets the id synchronously, so that one case gets its
    // transcript back on the same tick and nothing flickers.
    this.#closeTranscript();
    /*
     * The estate is read when the operator goes to look at it.
     *
     * Read on every visit rather than once, because both of these move while the operator
     * is elsewhere: a worker records assets as it works, and the scope is what the next
     * attempt will be told. A cached list would show an operator a stale estate and let
     * them promote a host off a row that had already changed.
     */
    if (id === "assets" && this.viewTargetId !== "") {
      void this.loadAssets(this.viewTargetId);
      void this.loadScope(this.viewTargetId);
      void this.loadImporterSessions(this.viewTargetId);
    }
    // Read on every visit: "what is running right now" is the one question this list answers.
    if (id === "agent-sessions" && this.viewTargetId !== "") {
      void this.loadHarnesses();
      void this.loadAgentSessions(this.viewTargetId);
    }
  }

  /** Back above target scope, to every target. */
  toAllTargets() {
    this.#retireArrivalNote();
    this.search = "";
    this.screen = "welcome";
  }

  /* ── Goals ───────────────────────────────────────────────────────────────── */

  /** Puts every goal field back where a fresh target leaves it. */
  /**
   * Forgets the open target's estate and scope.
   *
   * Called when the target changes, before the new read goes out, for
   * {@link #clearGoals}'s reason: between two targets the only honest answer is "reading",
   * and one client's estate must never be on screen under another client's name. The tab
   * and the filters go too — an operator who left the Scope tab open on one engagement
   * should not land on it in another.
   */
  #clearEstate() {
    this.assets = [];
    this.assetsTargetId = "";
    this.assetsState = "idle";
    this.assetsDetail = "";
    this.scope = undefined;
    this.scopeTargetId = "";
    this.scopeState = "idle";
    this.scopeDetail = "";
    this.importerIndex = [];
    this.importerIndexTargetId = "";
    this.assetsTab = "estate";
    this.estateFilter = "all";
    this.estateQuery = "";
    this.entryEffect = "in";
    this.entryKind = "subtree";
    this.entryValue = "";
    this.scopeRefusal = "";
    this.scopeRefusalContradiction = false;
    this.scopeBusy = false;
    this.scopeEntryToRemove = "";
    this.scopeBlockOpen = false;
  }

  #clearGoals() {
    this.goals = [];
    this.goalsTargetId = "";
    this.goalsState = "idle";
    this.goalsDetail = "";
    this.openGoalId = "";
    this.goalDialogOpen = false;
    this.goalName = "";
    this.goalObjective = "";
    this.goalCreating = false;
    this.goalCreateDetail = "";
    this.goalEndOpen = false;
    this.goalEndStatus = "met";
    this.goalEndReason = "";
    this.goalEnding = false;
    this.goalEndDetail = "";
    this.#clearIntents();
    this.#clearGoalBriefing();
    this.#clearPlanRounds();
    this.#clearGoalConversation();
  }

  /**
   * Puts every planner-round field back where a fresh goal leaves it.
   *
   * {@link runningRounds} is **not** cleared here, for the reason {@link runs} is not: it
   * is a fact about the process rather than about the goal on screen, and blanking it on
   * every navigation would make the control forget a round is in flight for as long as the
   * next poll takes.
   */
  #clearPlanRounds() {
    this.planRounds = [];
    this.planRoundsGoalId = "";
    this.planRoundsState = "idle";
    this.planRoundsDetail = "";
    this.planStarting = false;
    this.planDetail = "";
    this.planRefusalSize = undefined;
    this.planRefusalCeiling = undefined;
    this.goalNarration = undefined;
    this.goalNarrationGoalId = "";
    this.goalNarrationState = "idle";
    this.goalNarrationDetail = "";
    this.goalNarrationFloor = undefined;
    this.roundStopping = "";
    this.roundStopDetail = "";
  }

  /**
   * Puts every goal-conversation field back where a fresh goal leaves it.
   *
   * {@link goalTurns} is cleared with the rest, which is what it means for the operator's
   * own messages to be this tab's and not the record's: navigating away loses them, and the
   * harness's copy is what a later visit replays.
   *
   * It also **ends the visit**: {@link #goalConversationVisit} moves on, so every reply
   * still in flight for the conversation being cleared is discarded when it lands instead of
   * being installed over the next one's. See that field for the navigation that needs it.
   */
  #clearGoalConversation() {
    this.#goalConversationVisit += 1;
    this.goalConversation = undefined;
    this.goalConversationGoalId = "";
    this.goalConversationState = "idle";
    this.goalConversationDetail = "";
    this.goalConversationFloor = undefined;
    this.goalConversationThrough = 0;
    this.goalMessage = "";
    this.goalSending = false;
    this.goalSendDetail = "";
    this.goalSessionNote = "";
    this.goalAgentRuntime = undefined;
    this.goalTurns = [];
    this.goalAttachments = [];
    this.goalAttaching = false;
    this.goalAttachDetail = "";
    this.goalAttachNote = "";
  }

  /** Puts every goal-briefing field back where a fresh goal leaves it. */
  #clearGoalBriefing() {
    this.goalBriefing = undefined;
    this.goalBriefingGoalId = "";
    this.goalBriefingState = "idle";
    this.goalBriefingDetail = "";
    this.goalBriefingSize = undefined;
    this.goalBriefingCeiling = undefined;
  }

  /** Puts every intent field back where a fresh goal leaves it. */
  #clearIntents() {
    this.intents = [];
    this.intentsGoalId = "";
    this.intentsState = "idle";
    this.intentsDetail = "";
    this.intentFormOpen = false;
    this.intentQuestion = "";
    this.intentAnchors = [];
    this.intentDimension = "";
    this.intentCreating = false;
    this.intentCreateDetail = "";
    this.goalObservations = [];
    this.goalObservationsState = "idle";
    this.intentAbandoningId = "";
    this.intentAbandonOpenId = "";
    this.intentAbandonReason = "";
    this.intentAbandonDetail = "";
    this.intentAbandonDetailId = "";
    // The run box was aimed at one of these intents; with them gone it points at nothing.
    this.runIntentId = "";
  }

  /**
   * The sentence for a refusal the server sent, or the fallback when it sent none.
   *
   * A signed-out session is not a sentence: it leaves the screen, so the caller checks
   * for it first and this is only reached by the refusals that stay on the page.
   */
  #refusalText(error: object, fallback: string): string {
    return "detail" in error && typeof error.detail === "string"
      ? error.detail
      : fallback;
  }

  /**
   * Reads the target's goals into {@link goals}.
   *
   * **It reads. It does not navigate**, and for the same reason {@link refreshTarget}
   * does not: it asks about the target the view already names, and an answer for a target
   * the operator has since left is dropped rather than rendered. `goalsState` goes to
   * `loading` first and the list is kept while it does *if it is this target's*, so a
   * refresh after creating a goal does not blank the page the operator is looking at.
   */
  async loadGoals(id: string) {
    if (this.viewTargetId !== id) return;
    if (this.goalsTargetId !== id) {
      this.goals = [];
      this.goalsTargetId = id;
    }
    this.goalsState = "loading";
    this.goalsDetail = "";

    const call = await this.client.goals(this.serverUrl, id);
    if (this.viewTargetId !== id) return;

    if (call._tag === "Unreachable") {
      this.goalsState = "failed";
      this.goalsDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.goalsState = "failed";
      this.goalsDetail = this.#refusalText(
        call.error,
        "This target's goals could not be read.",
      );
      return;
    }
    this.goals = call.value.goals.map((goal) => ({ ...goal }));
    this.goalsState = "ready";
  }

  /* ── The estate and its scope ────────────────────────────────────────────────── */

  /**
   * Reads the open target's estate.
   *
   * The {@link loadGoals} template, and the two owner-id guards are load-bearing for the
   * same reason: the one before spends no request on a target the operator has left, and
   * the one after drops an answer about a target that is no longer open. Showing one
   * client's assets under another client's name is the single thing this product may not
   * do.
   */
  async loadAssets(id: string) {
    if (this.viewTargetId !== id) return;
    if (this.assetsTargetId !== id) {
      this.assets = [];
      this.assetsTargetId = id;
    }
    this.assetsState = "loading";
    this.assetsDetail = "";

    const call = await this.client.assets(this.serverUrl, id);
    if (this.viewTargetId !== id) return;

    if (call._tag === "Unreachable") {
      this.assetsState = "failed";
      this.assetsDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.assetsState = "failed";
      this.assetsDetail = this.#refusalText(
        call.error,
        "This target's assets could not be read.",
      );
      return;
    }
    this.assets = call.value.assets.map((asset) => ({ ...asset }));
    this.assetsState = "ready";
  }

  /** Reads the open target's authored scope, and the block an agent would be given. */
  async loadScope(id: string) {
    if (this.viewTargetId !== id) return;
    if (this.scopeTargetId !== id) {
      this.scope = undefined;
      this.scopeTargetId = id;
    }
    this.scopeState = "loading";
    this.scopeDetail = "";

    const call = await this.client.scope(this.serverUrl, id);
    if (this.viewTargetId !== id) return;

    if (call._tag === "Unreachable") {
      this.scopeState = "failed";
      this.scopeDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.scopeState = "failed";
      this.scopeDetail = this.#refusalText(
        call.error,
        "This target's scope could not be read.",
      );
      return;
    }
    this.scope = call.value;
    this.scopeState = "ready";
  }

  /**
   * Reads the open target's importer sessions, and brings the Auto-load page into line if
   * it is open.
   *
   * A failed read is silent and keeps what the page already holds (see
   * {@link importerIndex}): the index is how an operator finds a session again, and nothing
   * about the Assets screen is wrong because it could not be listed.
   */
  async loadImporterSessions(id: string) {
    if (this.viewTargetId !== id) return;
    const call = await this.client.importerSessions(this.serverUrl, id);
    if (this.viewTargetId !== id) return;
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") this.signOut("expired");
      return;
    }
    if (call._tag === "Unreachable") return;
    this.importerIndex = call.value.sessions;
    this.importerIndexTargetId = id;
    if (this.importerOpen) this.importer.syncIndexed(this.#indexedSessions());
  }

  /** The index as the Auto-load page holds sessions, harness names resolved. */
  #indexedSessions() {
    return this.importerIndex.map((view) => {
      const listed = this.harnesses.find(
        (entry) => entry.instanceId === view.harnessInstanceId,
      );
      return indexedSession(
        view,
        listed?.displayName ?? view.harnessInstanceId ?? "Unknown harness",
        // Gone only once the listing has said what is here: until then every instance is
        // merely unknown. A session recorded without an instance has nothing to compare.
        this.harnessesLoaded &&
          view.harnessInstanceId !== null &&
          listed === undefined
          ? view.harnessInstanceId
          : undefined,
      );
    });
  }

  /**
   * The Auto-load page's way to the server for one target (the importer conversation
   * design, S3): its composer posts through this, and an accepted message reads the session
   * list again so the session it landed in is listed with the server's figures.
   *
   * The model pick goes with an *opening* message exactly as `startScopeImport` sends it —
   * absent unless the operator overrode something — and never with a later one: a session
   * keeps the model it was opened on.
   */
  #importerServer(targetId: string): ImporterServer {
    const answer = (
      call: Awaited<ReturnType<ServerClient["sendImporterMessage"]>>,
    ): ImporterSent => {
      if (call._tag === "Ok") return { _tag: "accepted", turn: call.value };
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") this.signOut("expired");
        return {
          _tag: "refused",
          detail: this.#refusalText(
            call.error,
            "That message was not delivered.",
          ),
          ...(call.error._tag === "ImporterConversationRefused" &&
          call.error.reason === "import_ended"
            ? { ended: true }
            : {}),
        };
      }
      return { _tag: "refused", detail: "No server answered at this address." };
    };
    return {
      open: async (text, agentId) => {
        // The Reasoning column's choices go with the opening message, normalised against
        // the descriptors this tab holds and absent when nothing was set — as
        // `startScopeImport` sends them. They were dropped here before U3.
        const importOptions = explicitModelOptionSelections(
          this.importModelDescriptors,
          this.pickedImportModelOptions,
        );
        const sent = answer(
          await this.client.openImporterConversation(this.serverUrl, targetId, {
            text,
            ...(agentId === undefined ? {} : { agentId }),
            ...(this.pickedImportInstanceId !== "" ||
            this.pickedImportModel !== "" ||
            importOptions !== undefined
              ? {
                  importModel: {
                    ...(this.pickedImportInstanceId === ""
                      ? {}
                      : { instanceId: this.pickedImportInstanceId }),
                    ...(this.pickedImportModel === ""
                      ? {}
                      : { model: this.pickedImportModel }),
                    ...(importOptions === undefined
                      ? {}
                      : { modelOptions: importOptions }),
                  },
                }
              : {}),
          }),
        );
        return sent._tag === "accepted"
          ? { ...sent, modelOptions: importOptions ?? [] }
          : sent;
      },
      /**
       * Moves one import onto another model of its harness (A6 F4). An expired session signs
       * out; any other refusal, or no server answering, is a sentence for the error dialog.
       */
      switchModel: async (importId, draft) => {
        const call = await this.client.switchImporterModel(
          this.serverUrl,
          targetId,
          importId,
          draft,
        );
        if (call._tag === "Ok")
          return { _tag: "switched", switched: call.value };
        if (call._tag === "Refused") {
          if (call.error._tag === "Unauthenticated") this.signOut("expired");
          return {
            _tag: "refused",
            detail: this.#refusalText(
              call.error,
              "The model was not switched.",
            ),
          };
        }
        return {
          _tag: "refused",
          detail:
            "No server answered at this address, so whether the model was switched is not known. Pick it again once the server is back.",
        };
      },
      send: async (importId, text, urgency) =>
        answer(
          await this.client.sendImporterMessage(
            this.serverUrl,
            targetId,
            importId,
            text,
            urgency,
          ),
        ),
      /**
       * Stops one import's turn and keeps the conversation (A6 F5). An expired session signs
       * out, as every call here does; anything else refused, or no server answering, is a
       * sentence for the error dialog.
       */
      stop: async (importId) => {
        const call = await this.client.stopImporterTurn(
          this.serverUrl,
          targetId,
          importId,
        );
        if (call._tag === "Ok") return { _tag: "stopped", stopped: call.value };
        if (call._tag === "Refused") {
          if (call.error._tag === "Unauthenticated") this.signOut("expired");
          return {
            _tag: "refused",
            detail: this.#refusalText(call.error, "The turn was not stopped."),
          };
        }
        return {
          _tag: "refused",
          detail:
            "No server answered at this address, so the turn may still be running.",
        };
      },
      /**
       * One session's conversation, with the floor the live tail is joined at (S6).
       *
       * **The floor is taken before the request leaves**, like every other join on this
       * page and for its reason: what an answer can possibly contain is decided at the
       * moment it is asked for, so narration published during the round trip is the live
       * tail and must not be dropped against it.
       *
       * A refusal or an unreachable server answers `undefined`, which leaves the session's
       * thread as it was rather than claiming the harness said nothing. The one thing it
       * acts on is an expired session, like every other call here.
       */
      history: async (importId) => {
        const floor = this.#activityHighWater() ?? 0;
        const call = await this.client.importerMessages(
          this.serverUrl,
          targetId,
          importId,
        );
        if (call._tag === "Ok") return { view: call.value, floor };
        if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
          this.signOut("expired");
        }
        return undefined;
      },
      reread: () => void this.loadImporterSessions(targetId),
      harnessName: (instanceId) =>
        this.harnesses.find((entry) => entry.instanceId === instanceId)
          ?.displayName ?? instanceId,
      harnessDriver: (instanceId) =>
        this.harnesses.find((entry) => entry.instanceId === instanceId)?.driver,
      highWater: () => this.#activityHighWater() ?? 0,
      watchTurn: (importId, update) =>
        this.#watchImporterTurn(targetId, importId, update),
      /**
       * One import's context reading (A6 U9). An expired session signs out, as every call
       * here does; anything else unanswered leaves the meter as it was.
       */
      context: async (importId, breakdown) => {
        const call = await this.client.importerContext(
          this.serverUrl,
          targetId,
          importId,
          breakdown,
        );
        if (call._tag === "Ok") return call.value;
        if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
          this.signOut("expired");
        }
        return undefined;
      },
    };
  }

  /**
   * Polls what is running in one import's session (A6 U6), handing each answer to `update`,
   * until nothing is: no turn and no background work.
   *
   * {@link watchImport}'s loop — rescheduled after each answer, one request in flight — and
   * separate from it because it watches a different thing for a different reader: that one
   * settles the progress panel, this one draws a chat's cursor and its Stop, and the two must
   * not stop each other.
   *
   * **The harness's account, not the import's** (`importerActivity`): a turn the harness
   * opened by itself — Claude Code's, on a background task's notification — runs with the
   * import `finished`, and background work runs outside any turn. **Anything that is not an
   * answer is the end**: a refusal, or no server answering, means nothing more is coming that
   * this tab could see, and a cursor left blinking over a conversation that has stopped
   * would be a claim the chat cannot back.
   */
  #watchImporterTurn(
    targetId: string,
    importId: string,
    update: (activity: ImporterActivity) => void,
  ): () => void {
    let stopped = false;
    let cancelNext: (() => void) | undefined;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      const call = await this.client.importerActivity(
        this.serverUrl,
        targetId,
        importId,
      );
      if (stopped) return;
      if (call._tag === "Ok") {
        const activity = {
          running: call.value.turn === "running",
          background: call.value.background,
        };
        const going = activity.running || activity.background;
        if (going) {
          cancelNext = this.countdown.after(IMPORT_POLL_MS, () => void loop());
        } else {
          stopped = true;
        }
        update(activity);
        return;
      }
      if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
        this.signOut("expired");
      }
      stopped = true;
      update({ running: false, background: false });
    };
    void loop();
    return () => {
      stopped = true;
      cancelNext?.();
      cancelNext = undefined;
    };
  }

  /**
   * Applies whatever the server answered a scope change with.
   *
   * Every scope mutation answers with the **whole scope**, because every one of them moves
   * the block the operator is checking beside the list. Shared by all four actions so
   * there is one place that decides what a successful change does to the screen, and one
   * place that turns a refusal into the sentence beside the control.
   *
   * A refusal is not a failed read: {@link scopeState} stays `ready` and the list on
   * screen stays exactly as it was, because the server refused and therefore changed
   * nothing. Setting `failed` here would blank a correct list over a rejected keystroke.
   */
  async #applyScopeChange(
    id: string,
    call: Awaited<ReturnType<ServerClient["labelScope"]>>,
  ): Promise<boolean> {
    if (this.viewTargetId !== id) return false;

    if (call._tag === "Unreachable") {
      this.scopeRefusal = "No server answered at this address.";
      this.scopeRefusalContradiction = false;
      return false;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return false;
      }
      this.scopeRefusal = this.#refusalText(
        call.error,
        "That scope change was refused.",
      );
      // The one refusal in the whole flow, and the only place A4 spends danger red.
      this.scopeRefusalContradiction =
        "reason" in call.error && call.error.reason === "contradiction";
      return false;
    }
    this.scope = call.value;
    this.scopeTargetId = id;
    this.scopeState = "ready";
    this.scopeRefusal = "";
    this.scopeRefusalContradiction = false;
    return true;
  }

  /**
   * Adds the entry in the form.
   *
   * The value goes as typed. Normalising here would be a second implementation of a rule
   * that has one, and the server's refusal names the remedy — "write the apex alone",
   * "add it as a CIDR entry instead" — which is worth more than the round trip saves.
   */
  async addScopeEntry() {
    const id = this.viewTargetId;
    const value = this.entryValue.trim();
    if (id === "" || value === "" || this.scopeBusy) return;

    this.scopeBusy = true;
    this.scopeRefusal = "";
    this.scopeRefusalContradiction = false;
    const call = await this.client.addScopeEntry(this.serverUrl, id, {
      effect: this.entryEffect,
      kind: this.entryKind,
      value,
    });
    this.scopeBusy = false;
    if (await this.#applyScopeChange(id, call)) {
      // Cleared only on success, so a refused value stays in the box for the operator to
      // fix rather than having to be retyped from the error message.
      this.entryValue = "";
      // An exclude entry is the one action whose whole purpose is to change the verdict on
      // assets already in the estate, so the Estate tab is re-read, not left saying "in
      // scope" about a host the server now excludes. The same rule, and the same guard,
      // as {@link removeScopeEntry}.
      await this.loadAssets(id);
    }
  }

  /**
   * Asks to delete one entry. Nothing is sent: the screen shows the question, and
   * {@link confirmRemoveScopeEntry} is what sends it.
   */
  askToRemoveScopeEntry(entryId: string) {
    if (this.scopeBusy) return;
    this.scopeEntryToRemove = entryId;
  }

  /** Drops the question without deleting anything. */
  cancelRemoveScopeEntry() {
    if (this.scopeBusy) return;
    this.scopeEntryToRemove = "";
  }

  /**
   * Deletes the entry the operator was asked about.
   *
   * The question closes whichever way the server answers (see {@link removeScopeEntry}).
   * A refusal is shown beside the Add form, which the screen keeps in view, rather than
   * inside a dialog that would have to hold an error slot of its own for one rare outcome.
   */
  async confirmRemoveScopeEntry() {
    const entryId = this.scopeEntryToRemove;
    if (entryId === "") return;
    await this.removeScopeEntry(entryId);
  }

  /**
   * Removes one entry.
   *
   * This is the `DELETE`, not the question: it does not ask. The screen reaches it only
   * through {@link confirmRemoveScopeEntry}.
   *
   * The estate is re-read afterwards, as {@link labelScope} does, because removing an
   * entry moves the verdict on every asset it covered and that verdict is derived by the
   * server at read time. Patching the scope alone would leave the Estate tab saying
   * "in scope" about a host nothing covers any more.
   *
   * **The question is closed while the request still counts as in flight**, so the
   * dialog's working state hands straight to a closed dialog and the confirm button is
   * never drawn clickable again over an entry that has just been deleted.
   */
  async removeScopeEntry(entryId: string) {
    const id = this.viewTargetId;
    if (id === "" || this.scopeBusy) return;
    this.scopeBusy = true;
    this.scopeRefusal = "";
    this.scopeRefusalContradiction = false;
    const call = await this.client.removeScopeEntry(
      this.serverUrl,
      id,
      entryId,
    );
    const applied = await this.#applyScopeChange(id, call);
    this.scopeEntryToRemove = "";
    this.scopeBusy = false;
    if (applied) await this.loadAssets(id);
  }

  /**
   * Promotes, excludes or withdraws a label on one host or one asset.
   *
   * One method for all six combinations, because it is one control with two directions
   * and an undo. **It never touches the typed entries**, which is what lets the operator
   * carve one host out of their own exclusion and still see the exclusion they wrote.
   *
   * The estate is re-read afterwards, not patched: a host label covers every asset on
   * that host — present and future — so one click can change the state of rows the
   * operator did not click, and guessing which from here would be a second
   * implementation of the ladder.
   */
  async labelScope(draft: ScopeLabelDraft) {
    const id = this.viewTargetId;
    if (id === "" || this.scopeBusy) return;
    this.scopeBusy = true;
    const call = await this.client.labelScope(this.serverUrl, id, draft);
    this.scopeBusy = false;
    if (await this.#applyScopeChange(id, call)) {
      await this.loadAssets(id);
    }
  }

  /** Switches tab. Clears a refusal, which belonged to the control the operator left. */
  toAssetsTab(tab: AssetsTab) {
    this.#retireArrivalNote();
    this.assetsTab = tab;
    this.scopeRefusal = "";
    this.scopeRefusalContradiction = false;
  }

  /**
   * Opens one goal from the list, and asks the server for its current counts.
   *
   * The row on hand is shown at once rather than after the round trip, since it is the
   * same goal a moment ago; the read then replaces it, because a run that finished since
   * the list was loaded has changed the numbers under it.
   */
  openGoal(goalId: string) {
    this.#retireArrivalNote();
    this.openGoalId = goalId;
    this.goalEndOpen = false;
    this.goalEndStatus = "met";
    this.goalEndReason = "";
    this.goalEndDetail = "";
    // The previous goal's intents must not be on screen under this one's heading, and the
    // same goes for its briefing — which names its own goal in its first lines.
    this.#clearIntents();
    this.#clearGoalBriefing();
    this.#clearPlanRounds();
    this.#clearGoalConversation();
    void this.refreshGoal(goalId);
    void this.loadIntents(goalId);
    void this.loadGoalBriefing(goalId);
    void this.loadPlanRounds(goalId);
    // The prose, from the harness's own retention. Read on opening a goal because that is
    // the moment a reloaded tab has no narration of its own: everything on the activity
    // channel before this page connected is unrecoverable from the stream.
    void this.loadGoalNarration(goalId);
    // And the other agent's half of the page, for the same reason: a reloaded tab has no
    // conversation of its own, and the harness is the only other place it exists.
    void this.loadGoalConversation(goalId);
    // What the *process* is driving, which the rows cannot answer. Read on opening a goal
    // so a reloaded tab knows at once whether a round is in flight rather than finding out
    // when the button is refused.
    void this.loadRunningRounds();
  }

  /**
   * Confirms the open goal is one this target still holds, and falls back to its list if it
   * is not.
   *
   * Design D5's second case. {@link openGoal} is optimistic by design — it shows the row it
   * already has and lets the reads replace it — and for a click that is right, because the
   * row was on screen a moment ago so the goal exists. For a link it is not enough: a path
   * can name a goal id that is a year old, a typo, or another target's, and until something
   * asks the server nobody knows which. So the link's replay calls this after
   * {@link openGoal}, and this is the half that can say the goal is gone.
   *
   * **Optimistic first, confirmed second, and not the other way round.** Confirming before
   * opening would hold every link to a goal behind a round trip and show the goal list on
   * the way to a goal that exists, which is the common case paying for the rare one.
   * Opening first means a dead link shows a goal page with nothing in it for one round trip
   * before falling back — a flicker, in exchange for every live link being instant.
   *
   * **Why its own read rather than {@link refreshGoal}'s.** `openGoal` fires that read and
   * forgets it, and `refreshGoal` is deliberately indiscriminate about failure: it keeps
   * the row it has and says nothing, because an operator looking at a goal is not helped by
   * it vanishing when a refresh fails. Reusing it would mean reading "the goal is gone" off
   * an absent row, which is also what an unreachable server looks like — and "that goal no
   * longer exists" is not a sentence to say on a guess. This asks, and acts only on the
   * server's own `GoalNotFound`. The cost is one duplicate `GET` beside the seven reads
   * `openGoal` already fires, and only on a link rather than on a click.
   *
   * The two guards after the await are {@link refreshGoal}'s, for its reason: an answer
   * about a goal the operator has since left is dropped rather than acted on, so a slow
   * refusal cannot close a goal they opened in the meantime or leave a note about a page
   * they are no longer on.
   */
  async confirmOpenGoal(goalId: string): Promise<void> {
    const targetId = this.viewTargetId;
    if (targetId === "") return;
    const call = await this.client.goal(this.serverUrl, targetId, goalId);
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;

    if (call._tag === "Ok") {
      // The goal is real, and this is the answer `refreshGoal` would have placed: put it in
      // the list so the page has its row even when the list read has not come back yet.
      this.#placeGoal(call.value);
      return;
    }
    // No server answered. The link may be perfectly good, so nothing is claimed about it;
    // the goal page keeps saying it has no row, which is what is true.
    if (call._tag === "Unreachable") return;
    if (call.error._tag === "Unauthenticated") {
      this.signOut("expired");
      return;
    }
    if (call.error._tag === "TargetNotFound") {
      // The link named a goal on a target that has gone. One sentence about the target, not
      // two about both halves of the path, and it is the same one a stale rail row gets.
      await this.#targetIsGone(targetId);
      return;
    }
    if (call.error._tag !== "GoalNotFound") return;
    // The goal list, which is one level out and the nearest place that does exist: the rail
    // is already on Goals, so closing the goal *is* the fallback.
    this.closeGoal();
    this.arrivalNote = goalGoneNote(goalId);
  }

  /**
   * Reads the open target's agent sessions.
   *
   * `loadAssets`' discipline: another target's sessions are dropped before the read goes out
   * and a late answer for a target we have left is ignored. A failed read keeps nothing from
   * the last one, because unlike the importer's index this list *is* the answer to "what is
   * running", and a stale one would be a wrong answer rather than a stale pointer.
   */
  async loadAgentSessions(id: string) {
    if (this.viewTargetId !== id) return;
    if (this.agentSessionsTargetId !== id) {
      this.agentSessions = [];
      this.agentSessionsWorkersOmitted = 0;
      this.agentSessionsTargetId = id;
    }
    this.agentSessionsState = "loading";
    this.agentSessionsDetail = "";

    const call = await this.client.agentSessions(this.serverUrl, id);
    if (this.viewTargetId !== id) return;

    if (call._tag === "Unreachable") {
      this.agentSessionsState = "failed";
      this.agentSessionsDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.agentSessionsState = "failed";
      this.agentSessionsDetail = this.#refusalText(
        call.error,
        "This target's agent sessions could not be read.",
      );
      return;
    }
    this.agentSessions = call.value.sessions;
    this.agentSessionsWorkersOmitted = call.value.workersOmitted;
    this.agentSessionsState = "ready";
  }

  /**
   * Opens the importer on one session, by id alone. `false` when it could not, with
   * {@link arrivalNote} saying so and the rail on the target's Agent sessions list.
   *
   * **This is what a link to a chat needs**, and the reason it exists rather than the two
   * calls it looks like. `openImporter(sessionId)` selects a session only if the importer's
   * own index already holds it, and silently opens the page on a fresh empty one if it does
   * not — which on a cold load is always, because the index arrives a round trip after the
   * Assets section is entered. So the index is read first when it does not hold the session,
   * and a session that is still not there is refused rather than landing on the wrong
   * conversation.
   *
   * Both ways to a chat come through here: the row on the Agent sessions list, which is an
   * `<a href>` whose click applies the place, and `place.ts`'s replay of that same path on a
   * cold load. One method, so a link followed in two ways cannot behave two ways.
   */
  async openImporterSession(sessionId: string): Promise<boolean> {
    const targetId = this.viewTargetId;
    if (targetId === "") return false;
    const held = () =>
      this.importerIndexTargetId === targetId &&
      this.importerIndex.some((view) => view.sessionId === sessionId);
    if (!held()) await this.loadImporterSessions(targetId);
    if (this.viewTargetId !== targetId) return false;
    if (!held()) {
      /*
       * Design D5's third case, and the one it calls likeliest: a harness can let a session
       * go while something else still remembers it. The sentence was already right before
       * this slice and was written to `agentSessionsNote`, the Agent sessions list's own
       * banner — so an operator who clicked a row there read it, and an operator who opened
       * the same link in a second tab was told nothing at all. It goes to
       * {@link arrivalNote} now, which the shell renders above whatever screen the arrival
       * reached.
       *
       * **The fallback is the Agent sessions list, which is not the nearest page in the
       * path.** `/t/<id>/assets` is; `parsePath` sends a chat path with no session there,
       * and the Assets page is what the Auto-load page sits on. But it has nothing to say
       * about conversations, and the question this link asked was which conversations this
       * target has. The Agent sessions list is the page that answers it, so that is the
       * nearest place that exists *in the sense D5 means* — somewhere the operator can
       * carry on from rather than merely a page that renders.
       *
       * It is also the one fallback that is usually no move at all: a click on a stale row
       * comes from this list, so the rail does not change, the address bar does not change,
       * and the only difference the operator sees is the sentence. The cold arrival is the
       * case that moves.
       *
       * One honest cost of landing here: the row may still be in the list. The server
       * unions the harness's sessions and the importer's index is a different reader of the
       * same world, so the session this note is about can still be on screen underneath it.
       * That is the staleness the note names, and seeing which row it is beats not seeing
       * it.
       */
      this.toSection("agent-sessions");
      this.arrivalNote = chatGoneNote();
      return false;
    }
    this.toSection("assets");
    this.openImporter(sessionId);
    return true;
  }

  /*
   * `openGoalConversation(goalId)` was here: the goal half of the same stopgap, which went
   * to Goals and opened the goal because a row could not be a link. A goal's conversation is
   * on its own page and that page has an address — `/t/<targetId>/goals/<goalId>` — so the
   * row carries it and `applyPlace` is what opens it, by the two calls this method wrapped.
   * Deleted rather than kept as an alias: a second way to reach a place is a second place for
   * the two to drift apart.
   */

  closeGoal() {
    this.openGoalId = "";
    this.goalEndOpen = false;
    this.goalEndDetail = "";
    this.#clearIntents();
    this.#clearGoalBriefing();
    this.#clearPlanRounds();
    this.#clearGoalConversation();
  }

  /** Replaces one goal in the list with the server's current answer about it. */
  async refreshGoal(goalId: string) {
    const targetId = this.viewTargetId;
    const call = await this.client.goal(this.serverUrl, targetId, goalId);
    if (this.viewTargetId !== targetId) return;
    if (call._tag === "Ok") {
      this.#placeGoal(call.value);
      return;
    }
    if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
      this.signOut("expired");
    }
    // Any other failure leaves the row already on screen: it was true when it was read,
    // and an operator looking at a goal is not helped by it vanishing because a refresh
    // failed. The next action says what is wrong.
  }

  /** Puts a goal into the list in place, or at the top if the list has not got it. */
  #placeGoal(goal: GoalView) {
    this.goals = this.goals.some((entry) => entry.goalId === goal.goalId)
      ? this.goals.map((entry) => (entry.goalId === goal.goalId ? goal : entry))
      : [goal, ...this.goals];
  }

  openGoalDialog() {
    this.goalDialogOpen = true;
    this.goalName = "";
    this.goalObjective = "";
    this.goalCreateDetail = "";
  }

  closeGoalDialog() {
    if (this.goalCreating) return;
    this.goalDialogOpen = false;
  }

  /**
   * Creates a goal from the dialog.
   *
   * The objective is required and checked here only to save a round trip and say it in the
   * dialog's own words; the server refuses an empty one too, and that is the check that
   * counts. Neither an id nor an operation id is sent — the server mints both.
   */
  async createGoal() {
    const targetId = this.viewTargetId;
    const description = this.goalObjective.trim();
    if (targetId === "" || this.goalCreating) return;
    if (description === "") {
      this.goalCreateDetail =
        "A goal needs an objective: say what it is trying to establish.";
      return;
    }
    this.goalCreating = true;
    this.goalCreateDetail = "";
    try {
      const call = await this.client.createGoal(this.serverUrl, targetId, {
        name: this.goalName.trim(),
        description,
      });
      if (this.viewTargetId !== targetId) return;
      if (call._tag === "Unreachable") {
        this.goalCreateDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.goalCreateDetail = this.#refusalText(
          call.error,
          "That goal was refused.",
        );
        return;
      }
      // The server's answer goes straight into the list, so the new row is on screen on
      // the tick the dialog closes; the list is only re-read when something else may have
      // changed it.
      this.goalsTargetId = targetId;
      this.#placeGoal(call.value);
      this.goalsState = "ready";
      this.goalDialogOpen = false;
      // The header's counts moved: creating a goal wrote an event, and the transcript
      // below shows that record while a stale header would still say there are none. A
      // refresh and not a navigation, like `startRun`'s — it is not awaited, so the
      // dialog's button is released as soon as the list has the row.
      void this.refreshTarget(targetId);
    } finally {
      this.goalCreating = false;
    }
  }

  openGoalEnd() {
    this.goalEndOpen = true;
    this.goalEndStatus = "met";
    this.goalEndReason = "";
    this.goalEndDetail = "";
  }

  cancelGoalEnd() {
    if (this.goalEnding) return;
    this.goalEndOpen = false;
    this.goalEndDetail = "";
  }

  /**
   * Ends the open goal as met or abandoned.
   *
   * It records that the goal is over and nothing more: a run already going under it is not
   * stopped, and the screen says so before the operator commits. When another tab got
   * there first, the refusal names what ended the goal and the row is re-read, so the
   * page then shows the ending that stands instead of a control that no longer applies.
   */
  async endGoal() {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    if (targetId === "" || goalId === "" || this.goalEnding) return;
    this.goalEnding = true;
    this.goalEndDetail = "";
    try {
      const call = await this.client.endGoal(this.serverUrl, targetId, goalId, {
        status: this.goalEndStatus,
        reason: this.goalEndReason.trim(),
      });
      if (this.viewTargetId !== targetId) return;
      if (call._tag === "Unreachable") {
        this.goalEndDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.goalEndDetail = this.#refusalText(
          call.error,
          "That goal could not be ended.",
        );
        if (call.error._tag === "GoalRefused") {
          // Already ended elsewhere: show the ending that stands.
          this.goalEndOpen = false;
          await this.refreshGoal(goalId);
        }
        return;
      }
      this.#placeGoal(call.value);
      this.goalEndOpen = false;
      this.goalEndReason = "";
      // Ending writes an event too, for the reason `createGoal` refreshes.
      void this.refreshTarget(targetId);
    } finally {
      this.goalEnding = false;
    }
  }

  /* ── Planner rounds ──────────────────────────────────────────────────────── */

  /**
   * Reads the open goal's planner rounds into {@link planRounds}.
   *
   * **It reads. It does not navigate**, like {@link loadIntents}: it asks about the goal
   * the view already names, and an answer for a goal or target the operator has since left
   * is dropped. The list is kept while it reloads *if it is this goal's*, so a refresh
   * after a round settles does not blank what is on screen.
   */
  async loadPlanRounds(goalId: string) {
    const targetId = this.viewTargetId;
    if (targetId === "" || this.openGoalId !== goalId) return;
    if (this.planRoundsGoalId !== goalId) {
      this.planRounds = [];
      this.planRoundsGoalId = goalId;
    }
    this.planRoundsState = "loading";
    this.planRoundsDetail = "";

    const call = await this.client.goalRounds(this.serverUrl, targetId, goalId);
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;

    if (call._tag === "Unreachable") {
      this.planRoundsState = "failed";
      this.planRoundsDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.planRoundsState = "failed";
      this.planRoundsDetail = this.#refusalText(
        call.error,
        "This goal's planner rounds could not be read.",
      );
      return;
    }
    this.planRounds = call.value.rounds.map((round) => ({ ...round }));
    this.planRoundsState = "ready";
  }

  /**
   * Reads what the server is supervising right now into {@link runningRounds}.
   *
   * Process-wide and not goal-scoped, so there is nothing to drop an answer against and no
   * failure to render: a read that did not land leaves the last answer, and the control
   * falls back to the server's own refusal if it was wrong. The alternative — a banner
   * saying the round list could not be read — would be a second place to report a
   * connectivity problem the rest of the page already reports.
   */
  async loadRunningRounds() {
    const call = await this.client.rounds(this.serverUrl);
    if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
      this.signOut("expired");
      return;
    }
    if (call._tag !== "Ok") return;
    this.runningRounds = call.value.map((round) => ({ ...round }));
  }

  /**
   * Opens a planner round on the open goal.
   *
   * It sends no body: the round's directory, its audit path, its harness and its prompt
   * are all the server's. It returns as soon as the round is prompted, so the button is
   * released long before the round finishes — what happens after that shows up in
   * {@link planRounds} and, from slice 8, in the round's own view.
   *
   * The two refusals that are not generic are handled by name. `GoalBriefingRefused`
   * carries the briefing's size and the ceiling, which the control prints: the round
   * started nothing, so the honest message names both numbers rather than saying the
   * planner failed. `GoalRefused`-shaped cases arrive inside `PlanRefused` with the
   * server's sentence, which is written for an operator and is shown as written.
   */
  async plan() {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    if (targetId === "" || goalId === "" || this.planStarting) return;
    this.planStarting = true;
    this.planDetail = "";
    this.planRefusalSize = undefined;
    this.planRefusalCeiling = undefined;
    try {
      const call = await this.client.plan(this.serverUrl, targetId, goalId);
      if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
      if (call._tag === "Unreachable") {
        this.planDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        if (call.error._tag === "GoalBriefingRefused") {
          this.planRefusalSize = call.error.sizeChars;
          this.planRefusalCeiling = call.error.maxChars;
        }
        this.planDetail = this.#refusalText(
          call.error,
          "No planner round was opened.",
        );
        // A refusal can mean the world moved: a goal ended in another tab, or a round
        // already running. Re-reading both says which, and replaces a control that no
        // longer applies with the state that does.
        void this.loadRunningRounds();
        void this.refreshGoal(goalId);
        return;
      }
      // The round the server just started, placed at once rather than after a round trip,
      // the way `startRun` puts its own answer straight into `runs`. Both halves: the row
      // list so the round appears, and `runningRounds` so the control switches to the
      // in-flight state on the same tick — the button is disabled on what this *process* is
      // driving, and waiting for a read to say so would leave it pressable for a round that
      // has already started. The reads below then replace both with the server's answer.
      this.#placePlanRound(call.value);
      void this.loadRunningRounds();
      void this.loadPlanRounds(goalId);
      // And the narration, so the new round has something to say about itself at once.
      // The live stream's own `plan.round.started` triggers this too, which is belt and
      // braces on purpose: a tab whose stream is still catching up — or reconnecting —
      // would otherwise leave the round it just opened reading as "still being read".
      void this.loadGoalNarration(goalId);
    } finally {
      this.planStarting = false;
    }
  }

  /**
   * Puts a just-started round at the head of {@link planRounds} and into
   * {@link runningRounds}.
   *
   * **It builds a `PlanRoundView` from a `PlanRoundStarted`, which is a widening and not a
   * guess.** Every field it fills is one the server has just told us or one that is true of
   * a round by definition at the instant it starts: `status: "running"`, no disposition and
   * no rationale (nothing has concluded), `intentsAdded: 0` (the round has not written),
   * and `endedAt: null`. Nothing is invented and nothing is carried over from a previous
   * round. The re-read that follows replaces it either way, so the only thing this buys is
   * the tick between the answer and the read — which is the tick the button is live in.
   *
   * Guarded on the goal, like {@link #placeGoal}'s callers: a round must not be placed into
   * a list the view has since re-pointed at another goal.
   */
  #placePlanRound(started: PlanRoundStarted) {
    if (this.openGoalId !== started.goalId) return;
    const placed: PlanRoundView = {
      roundId: started.roundId,
      goalId: started.goalId,
      targetId: started.targetId,
      status: "running",
      disposition: null,
      dispositionRationale: null,
      budget: started.budget,
      intentsAdded: 0,
      harnessSessionId: started.harnessSessionId,
      instanceId: started.instanceId,
      providerId: started.providerId,
      modelId: started.modelId,
      startedAtSequence: started.startedAtSequence,
      startedAt: started.startedAt,
      endedAt: null,
    };
    this.planRoundsGoalId = started.goalId;
    this.planRounds = [
      placed,
      ...this.planRounds.filter((round) => round.roundId !== placed.roundId),
    ];
    this.planRoundsState = "ready";
    this.runningRounds = [
      {
        roundId: started.roundId,
        targetId: started.targetId,
        goalId: started.goalId,
        harnessSessionId: started.harnessSessionId,
        startedAt: started.startedAt,
      },
      ...this.runningRounds.filter(
        (round) => round.roundId !== started.roundId,
      ),
    ];
  }

  /**
   * Reads the open goal's planner narration into {@link goalNarration}.
   *
   * **A read whose empty answers are the interesting ones.** A round the harness has
   * deleted, a round that has only just been prompted and a round that genuinely said
   * nothing all come back as successes with no messages and different `source` values, and
   * {@link goalNarrationDetail} is reserved for the one case where no server answered at
   * all. Treating a forgotten round as an error is the mistake this route's shape exists to
   * make impossible.
   *
   * {@link goalNarrationFloor} is taken **before** the request goes out, not after it
   * returns. The floor's job is to say which narration the replay already contains, and the
   * answer describes the harness's log as of when the harness read it — which is at or
   * before the moment the request left here. Reading the counter afterwards would exclude
   * entries that arrived during the round trip and are *not* in the replay, which is the
   * one direction this dedupe must not err in: a dropped live entry is invisible, where a
   * duplicated one is merely untidy and the replayed block is labelled as a replay anyway.
   */
  async loadGoalNarration(goalId: string) {
    const targetId = this.viewTargetId;
    if (targetId === "" || this.openGoalId !== goalId) return;
    if (this.goalNarrationGoalId !== goalId) {
      this.goalNarration = undefined;
      this.goalNarrationGoalId = goalId;
    }
    this.goalNarrationState = "loading";
    this.goalNarrationDetail = "";
    const floor = this.#activityHighWater();

    const call = await this.client.goalNarration(
      this.serverUrl,
      targetId,
      goalId,
    );
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;

    if (call._tag === "Unreachable") {
      this.goalNarrationState = "failed";
      this.goalNarrationDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.goalNarrationState = "failed";
      this.goalNarrationDetail = this.#refusalText(
        call.error,
        "This goal's planner narration could not be read.",
      );
      return;
    }
    this.goalNarration = call.value;
    this.goalNarrationFloor = floor;
    this.goalNarrationState = "ready";
  }

  /**
   * Reads the open goal's conversation into {@link goalConversation}.
   *
   * {@link loadGoalNarration}'s shape and its reasoning, including the floor being taken
   * **before** the request leaves. The difference is what the empty answers mean: a goal
   * nobody has talked to answers `absent`, which is not an absence of prose but an absence
   * of a conversation, and the chat renders it by showing no group rather than an empty one.
   */
  async loadGoalConversation(goalId: string) {
    const targetId = this.viewTargetId;
    if (targetId === "" || this.openGoalId !== goalId) return;
    if (this.goalConversationGoalId !== goalId) {
      this.goalConversation = undefined;
      this.goalConversationGoalId = goalId;
    }
    this.goalConversationState = "loading";
    this.goalConversationDetail = "";
    const floor = this.#activityHighWater();
    // Taken before the request leaves, like the floor and for the same reason: what the
    // answer can possibly contain is decided at the moment it is asked for, and a turn sent
    // during the round trip is one no answer to this request holds.
    const through = this.goalTurns.length;
    // And which visit asked, which is what `through` alone cannot express: see
    // {@link #goalConversationVisit}. Taken here, compared below.
    const visit = this.#goalConversationVisit;

    const call = await this.client.goalConversation(
      this.serverUrl,
      targetId,
      goalId,
    );
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
    /*
     * The same goal, and not the same visit: A → B → A inside one round trip.
     *
     * The guard above cannot see it — `openGoalId` is this goal again — and the cost of
     * missing it is not a stale block of prose but a **swallowed message**: visit one's
     * `through` would be installed over visit two's turns, which are numbered from 1 again,
     * and a re-sent sentence the stale replay happens to contain would be cancelled against
     * it. Dropped whole rather than partly honoured, because none of the three fields below
     * is about the conversation on screen.
     */
    if (visit !== this.#goalConversationVisit) return;

    if (call._tag === "Unreachable") {
      this.goalConversationState = "failed";
      this.goalConversationDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.goalConversationState = "failed";
      this.goalConversationDetail = this.#refusalText(
        call.error,
        "This goal's conversation could not be read.",
      );
      return;
    }
    this.goalConversation = call.value;
    this.goalConversationFloor = floor;
    this.goalConversationThrough = through;
    this.goalConversationState = "ready";
  }

  /**
   * Says what the operator typed to the open goal's agent.
   *
   * **The turn is recorded locally the moment the server accepts it, and not before.** A
   * message that was refused never appears in the conversation: the agent did not hear it,
   * and a row claiming otherwise would be the chat inventing a turn. The composer keeps the
   * text on a refusal so it can be sent again once whatever was wrong is fixed.
   *
   * It does **not** wait for the agent. The route answers `202` once the session has the
   * message, and what the agent says arrives on the live stream like everything else — so
   * {@link goalAwaiting} is what the strip reads, not this promise.
   *
   * `priorUnavailable` is put on screen through {@link goalSessionNote} rather than
   * swallowed. It is true exactly once per restart, and it is the only way an operator
   * learns that the conversation they can see above is not the one they are now talking to.
   */
  async sendGoalMessage() {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    const text = this.goalMessage.trim();
    if (targetId === "" || goalId === "" || text === "" || this.goalSending) {
      return;
    }
    this.goalSending = true;
    this.goalSendDetail = "";
    // Taken before the message goes, so the turn sorts before whatever the agent says in
    // answer to it. See `SentTurn.after`.
    const after = this.#activityHighWater() ?? 0;
    // And which visit sent it, for the reason `loadGoalConversation` takes one: an accepted
    // turn from a visit nobody is on would be appended to this visit's list, as a sentence
    // the operator did not type here.
    const visit = this.#goalConversationVisit;

    const call = await this.client.sendGoalMessage(
      this.serverUrl,
      targetId,
      goalId,
      text,
    );
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
    if (visit !== this.#goalConversationVisit) return;
    this.goalSending = false;

    if (call._tag === "Unreachable") {
      this.goalSendDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.goalSendDetail = this.#refusalText(
        call.error,
        "That message was not delivered.",
      );
      return;
    }

    this.goalTurns = [
      ...this.goalTurns,
      {
        index: this.goalTurns.length + 1,
        text,
        at: Date.now(),
        after,
      },
    ];
    this.goalMessage = "";
    // Not on a `continued` turn, which changes nothing the operator can see. On an
    // `opened` *or* a `resumed` one it does: both mean this process was not holding the
    // session when the message arrived, and the note is the sentence saying which happened.
    this.goalSessionNote =
      call.value.conversation === "continued" ? "" : call.value.note;
    // What the agent is actually running on, which only an accepted turn states. See
    // {@link goalAgentRuntime}.
    this.goalAgentRuntime = {
      instanceId: call.value.instanceId,
      providerId: call.value.providerId,
      modelId: call.value.modelId,
    };
    /*
     * The conversation is live now, which the replay read before it was.
     *
     * Not on a `continued` turn: it changes nothing the replay said, and re-reading it
     * would replace the block an operator is reading mid-sentence. On an `opened` one the
     * replay is about a session this process no longer holds — or about no session at all
     * — and leaving it on screen would attribute the last conversation's words to this
     * one. On a `resumed` one the words on screen are still this conversation's, and the
     * re-read is what makes them *live* rather than a replay: the same session, now held
     * here, so the feed and the history agree about which session is speaking.
     */
    if (call.value.conversation !== "continued") {
      void this.loadGoalConversation(goalId);
    }
  }

  /**
   * Attaches files to the open goal, so its agent can read them.
   *
   * **It does not send a message and does not wait for the agent.** The route answers once
   * the bytes are on disk in the goal's own directory; the agent is told about them on the
   * operator's *next* message. {@link goalAttachNote} is the server's sentence saying so,
   * and it is kept on screen rather than toasted because "the agent does not know yet" is
   * the one thing an operator could otherwise get wrong about this control.
   *
   * **The caps are the server's and are not checked here.** This tab is never told
   * `UPLOAD_MAX_BYTES` or `UPLOAD_MAX_FILES`, which is deliberate: a figure in the browser
   * is a second copy to keep in step, and the refusal that comes back already carries the
   * file's size, the cap and what to do about it. The cost is that an oversized file is
   * uploaded before it is refused, which is a wasted transfer on a same-machine server and
   * the honest price of having one place the limit lives.
   *
   * A refusal leaves the picked files unattached and prints the server's sentence. There is
   * nothing to retry automatically: every reason is either a file to change or a limit to
   * raise.
   */
  async attachGoalFiles(files: readonly File[]) {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    if (targetId === "" || goalId === "" || files.length === 0) return;
    if (this.goalAttaching) return;
    this.goalAttaching = true;
    this.goalAttachDetail = "";

    const call = await this.client.uploadGoalFiles(
      this.serverUrl,
      targetId,
      goalId,
      files,
    );
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
    this.goalAttaching = false;

    if (call._tag === "Unreachable") {
      this.goalAttachDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.goalAttachDetail = this.#refusalText(
        call.error,
        "Those files were not attached.",
      );
      return;
    }

    /*
     * The stored list, merged by the name the **server** chose rather than appended to.
     *
     * A re-attached file replaces the one of the same name on disk (`replaced: true` says
     * so), and a list that grew a second row for it would show the operator two documents
     * where the agent will see one.
     */
    const byName = new Map(
      this.goalAttachments.map((file) => [file.name, file]),
    );
    for (const file of call.value.stored) byName.set(file.name, file);
    this.goalAttachments = [...byName.values()].sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
    this.goalAttachNote = call.value.note;
  }

  /**
   * The highest activity publish order this tab has seen, or `undefined` for none.
   *
   * Read across every live item rather than only this round's, because the counter is one
   * per process: an entry numbered below the high-water mark cannot be one that arrives
   * later, whichever round or attempt it belongs to. See {@link goalNarrationFloor}.
   */
  #activityHighWater(): number | undefined {
    let highest: number | undefined;
    for (const item of this.liveItems) {
      const order = activityOrder(item);
      if (order === undefined) continue;
      if (highest === undefined || order > highest) highest = order;
    }
    return highest;
  }

  /**
   * Stops one planner round on the open goal.
   *
   * **It settles the round; it does not pause it and there is no resume.** By the time the
   * server answers, the harness has been asked to interrupt, the row is `interrupted`, the
   * round's credential is revoked and its write fence is superseded — so anything the
   * planner tries to write afterwards is refused by the store, not merely ignored. Work
   * carried on after an interruption is a new round, which is why there is no second
   * control here.
   *
   * The answer is the settled row, placed straight into {@link planRounds} so the
   * separator's status changes on the same tick the control disappears, and
   * {@link loadRunningRounds} follows because the round leaving the fiber map is what the
   * stop control is keyed on.
   */
  async stopRound(roundId: string) {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    if (targetId === "" || goalId === "" || this.roundStopping !== "") return;
    this.roundStopping = roundId;
    this.roundStopDetail = "";
    try {
      const call = await this.client.stopRound(
        this.serverUrl,
        targetId,
        goalId,
        roundId,
      );
      if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
      if (call._tag === "Unreachable") {
        this.roundStopDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.roundStopDetail = this.#refusalText(
          call.error,
          "That round was not stopped.",
        );
        // A refusal usually means the round settled on its own while the page was open, so
        // what this tab believes about the fiber map is stale. Re-read both halves.
        void this.loadRunningRounds();
        void this.loadPlanRounds(goalId);
        return;
      }
      const settled = call.value;
      this.planRounds = this.planRounds.map((round) =>
        round.roundId === settled.roundId ? { ...settled } : round,
      );
      this.runningRounds = this.runningRounds.filter(
        (round) => round.roundId !== settled.roundId,
      );
      void this.loadRunningRounds();
      void this.loadPlanRounds(goalId);
    } finally {
      this.roundStopping = "";
    }
  }

  /* ── Intents ─────────────────────────────────────────────────────────────── */

  /**
   * Reads the open goal's intents into {@link intents}.
   *
   * **It reads. It does not navigate**: it asks about the goal the view already names, and
   * an answer for a goal or target the operator has since left is dropped. The list is kept
   * while it reloads *if it is this goal's*, so a refresh after a run settles does not blank
   * the rows the operator is looking at.
   */
  async loadIntents(goalId: string) {
    const targetId = this.viewTargetId;
    if (targetId === "" || this.openGoalId !== goalId) return;
    if (this.intentsGoalId !== goalId) {
      this.intents = [];
      this.intentsGoalId = goalId;
    }
    this.intentsState = "loading";
    this.intentsDetail = "";

    const call = await this.client.intents(this.serverUrl, targetId, goalId);
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;

    if (call._tag === "Unreachable") {
      this.intentsState = "failed";
      this.intentsDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.intentsState = "failed";
      this.intentsDetail = this.#refusalText(
        call.error,
        "This goal's intents could not be read.",
      );
      return;
    }
    this.intents = call.value.intents.map((intent) => ({ ...intent }));
    this.intentsState = "ready";
  }

  /**
   * Reads the open goal's briefing into {@link goalBriefing}.
   *
   * **It reads. It does not navigate**, like {@link loadIntents}: it asks about the goal
   * the view already names and drops an answer for a goal or target the operator has since
   * left. The previous briefing is kept while it reloads *if it is this goal's*, so a
   * refresh after an observation lands does not blank the panel being read.
   *
   * The over-the-ceiling refusal is handled as an answer rather than as a broken read,
   * because that is what it is: the server built the briefing, measured it, and declined
   * to hand it over. Both numbers are kept so the panel names them.
   */
  async loadGoalBriefing(goalId: string) {
    const targetId = this.viewTargetId;
    if (targetId === "" || this.openGoalId !== goalId) return;
    if (this.goalBriefingGoalId !== goalId) {
      this.goalBriefing = undefined;
      this.goalBriefingGoalId = goalId;
    }
    this.goalBriefingState = "loading";
    this.goalBriefingDetail = "";
    this.goalBriefingSize = undefined;
    this.goalBriefingCeiling = undefined;

    const call = await this.client.goalBriefing(
      this.serverUrl,
      targetId,
      goalId,
    );
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;

    if (call._tag === "Unreachable") {
      this.goalBriefing = undefined;
      this.goalBriefingState = "failed";
      this.goalBriefingDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      if (call.error._tag === "GoalBriefingRefused") {
        this.goalBriefingSize = call.error.sizeChars;
        this.goalBriefingCeiling = call.error.maxChars;
      }
      // Cleared, not kept: a briefing that is over the ceiling has no shorter version, and
      // leaving the last readable one on screen would show a planner input that no longer
      // exists.
      this.goalBriefing = undefined;
      this.goalBriefingState = "failed";
      this.goalBriefingDetail = this.#refusalText(
        call.error,
        "This goal's briefing could not be read.",
      );
      return;
    }
    this.goalBriefing = { ...call.value };
    this.goalBriefingState = "ready";
  }

  /** Reads what the add-intent form can anchor to: the open goal's observations. */
  async loadGoalObservations(goalId: string) {
    const targetId = this.viewTargetId;
    if (targetId === "" || this.openGoalId !== goalId) return;
    this.goalObservationsState = "loading";
    const call = await this.client.goalObservations(
      this.serverUrl,
      targetId,
      goalId,
    );
    if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
    if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
      this.signOut("expired");
      return;
    }
    if (call._tag !== "Ok") {
      // Anchors are optional, so a failed read costs the picker and not the form: an
      // intent can still be added as a new top-level direction.
      this.goalObservations = [];
      this.goalObservationsState = "failed";
      return;
    }
    this.goalObservations = call.value.observations.map((entry) => ({
      ...entry,
    }));
    this.goalObservationsState = "ready";
  }

  openIntentForm() {
    this.intentFormOpen = true;
    this.intentQuestion = "";
    this.intentAnchors = [];
    this.intentDimension = "";
    this.intentCreateDetail = "";
    if (this.openGoalId !== "") void this.loadGoalObservations(this.openGoalId);
  }

  cancelIntentForm() {
    if (this.intentCreating) return;
    this.intentFormOpen = false;
    this.intentCreateDetail = "";
  }

  /** Ticks or unticks one observation as an anchor. */
  toggleAnchor(observationId: string) {
    this.intentAnchors = this.intentAnchors.includes(observationId)
      ? this.intentAnchors.filter((id) => id !== observationId)
      : [...this.intentAnchors, observationId];
    // A dimension belongs to the observation that raised it; it does not have to be one of
    // the anchors, so nothing is cleared here.
  }

  /**
   * Adds an intent under the open goal.
   *
   * The question is trimmed and must not be blank, checked here so an empty submit asks
   * the server nothing. A refusal keeps everything typed and shows the server's sentence
   * as written — for an anchoring refusal that sentence *is* the instruction, naming what
   * the id was and what to do instead — so it is not summarised into "invalid".
   */
  async createIntent() {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    const question = this.intentQuestion.trim();
    if (targetId === "" || goalId === "" || this.intentCreating) return;
    if (question.length === 0) {
      this.intentCreateDetail =
        "An intent needs a question: say what a bounded test could find out.";
      return;
    }
    this.intentCreating = true;
    this.intentCreateDetail = "";
    try {
      const call = await this.client.createIntent(
        this.serverUrl,
        targetId,
        goalId,
        {
          question,
          anchorObservationIds: [...this.intentAnchors],
          addressesDimension:
            this.intentDimension === "" ? null : this.intentDimension,
        },
      );
      if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
      if (call._tag === "Unreachable") {
        this.intentCreateDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.intentCreateDetail = this.#refusalText(
          call.error,
          "That intent was refused.",
        );
        return;
      }
      this.intents = [...this.intents, { ...call.value }];
      this.intentsGoalId = goalId;
      this.intentsState = "ready";
      this.intentFormOpen = false;
      this.intentQuestion = "";
      this.intentAnchors = [];
      this.intentDimension = "";
      // The goal's intent count moved, and creating wrote an event the header counts.
      void this.refreshGoal(goalId);
      void this.refreshTarget(targetId);
    } finally {
      this.intentCreating = false;
    }
  }

  /** Opens the confirmation for one intent, with the reason empty. */
  openIntentAbandon(intentId: string) {
    if (this.intentAbandoningId !== "") return;
    this.intentAbandonOpenId = intentId;
    this.intentAbandonReason = "";
    this.intentAbandonDetail = "";
    this.intentAbandonDetailId = "";
  }

  cancelIntentAbandon() {
    if (this.intentAbandoningId !== "") return;
    this.intentAbandonOpenId = "";
    this.intentAbandonReason = "";
  }

  /**
   * Abandons one open intent, with the reason typed into its confirmation.
   *
   * The refusal for a claimed intent names the attempt running it, and is shown against
   * that intent's row. The list is re-read after a refusal either way: the likeliest cause
   * is another tab having started it, and the row should then say so.
   */
  async abandonIntent(intentId: string) {
    const targetId = this.viewTargetId;
    const goalId = this.openGoalId;
    if (targetId === "" || goalId === "" || this.intentAbandoningId !== "")
      return;
    this.intentAbandoningId = intentId;
    this.intentAbandonDetail = "";
    this.intentAbandonDetailId = "";
    try {
      const call = await this.client.abandonIntent(
        this.serverUrl,
        targetId,
        intentId,
        { reason: this.intentAbandonReason.trim() },
      );
      if (this.viewTargetId !== targetId || this.openGoalId !== goalId) return;
      if (call._tag === "Unreachable") {
        this.intentAbandonDetail = "No server answered at this address.";
        this.intentAbandonDetailId = intentId;
        return;
      }
      if (call._tag === "Refused") {
        if (call.error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.intentAbandonDetail = this.#refusalText(
          call.error,
          "That intent could not be abandoned.",
        );
        this.intentAbandonDetailId = intentId;
        // Closed: the row is re-read below and may no longer be abandonable at all.
        this.intentAbandonOpenId = "";
        await this.loadIntents(goalId);
        return;
      }
      this.intents = this.intents.map((intent) =>
        intent.intentId === intentId ? { ...call.value } : intent,
      );
      if (this.runIntentId === intentId) this.runIntentId = "";
      this.intentAbandonOpenId = "";
      this.intentAbandonReason = "";
      void this.refreshTarget(targetId);
    } finally {
      this.intentAbandoningId = "";
    }
  }

  /** Aims the run box at one intent. */
  chooseRun(intentId: string) {
    this.runIntentId = intentId;
    this.runDetail = "";
    this.runFallback = null;
  }

  /** Takes the run box off its intent without running anything. */
  clearRunChoice() {
    if (this.starting) return;
    this.runIntentId = "";
    this.runDetail = "";
  }

  /* ── New target ──────────────────────────────────────────────────────────── */

  /**
   * Opens the create-target **page** (A3).
   *
   * `dialogOpen` is gone from this path: A3 turns the dialog into a page and leaves the
   * folder browser as the only modal. The fields keep their names — `dialogChosen`,
   * `dialogName`, `dialogScope` — because renaming them would touch every test and every
   * binding for a word, and the comment that says what they are costs nothing.
   *
   * **It starts no import and asks nothing about one.** A target is made from a folder, a
   * name and a note; the importer is the Assets page's ({@link openImporter}).
   */
  openNewTarget() {
    // Coming here from inside a target can mean coming from its Auto-load page, whose panel
    // is polling an import. The loop reschedules itself after every answer, so a screen
    // change alone leaves a fiber polling an import nobody is looking at.
    this.stopWatchingImport();
    this.importerOpen = false;
    this.screen = "new-target";
    this.dialogChosen = "";
    this.dialogSelection = "";
    this.dialogName = "";
    this.dialogScope = "";
    this.dialogPathError = "";
    this.createState = "idle";
    this.createDetail = "";
    this.duplicateOf = "";
    this.folderPickerOpen = false;
    void this.browseTo(this.dialogRoot === "" ? undefined : this.dialogRoot);
    // The fleet root, for the one sentence on this form that says where the database goes.
    // Asked here rather than at sign-in because this is the only screen that needs it, and
    // asked rather than remembered because `restore` is the only other path that learns it
    // — a tab that signed in rather than reloaded would otherwise have no answer at all.
    void this.loadFleetRoot();
  }

  /**
   * Leaves the create-target page without creating anything.
   *
   * Back to wherever the operator came from, which is the target list when there are
   * targets and the welcome screen when there are not — the same decision `toAllTargets`
   * makes, so Cancel and the breadcrumb agree.
   */
  cancelNewTarget() {
    this.screen = "welcome";
    this.folderPickerOpen = false;
    this.createState = "idle";
    this.createDetail = "";
  }

  /** Opens the folder browser, which is the only modal A3 keeps. */
  openFolderPicker() {
    this.folderPickerOpen = true;
    // Seeded with the folder the form already has, and the listing below lands on it, so
    // the picker opens showing one path rather than two.
    this.dialogSelection = this.dialogChosen;
    void this.browseTo(
      this.dialogChosen !== ""
        ? this.dialogChosen
        : this.dialogRoot === ""
          ? undefined
          : this.dialogRoot,
    );
  }

  /**
   * Takes the folder the picker is showing and closes it.
   *
   * The picker "does one thing and hands back one value", which is what lets it be modal
   * without trapping anything: the operator lands back on the form with the path filled and
   * every other field as they left it.
   */
  useChosenFolder() {
    // Always through `chooseFolder`, because that is the only thing that clears a refusal
    // — and this button is the only way out the refusal offers. It used to call it only
    // when nothing had been selected yet, so an operator who typed a path into the picker
    // landed back on a form still showing the old folder, still showing the refusal, with
    // Create still disabled and no other exit on screen.
    this.chooseFolder(
      this.dialogSelection !== "" ? this.dialogSelection : this.dialogPath,
    );
    this.folderPickerOpen = false;
  }

  /**
   * Selects a row in the picker without committing it to the form.
   *
   * The commit is "Use this folder", and keeping the two apart is what lets Cancel mean
   * cancel: a selection made and then abandoned leaves the form's folder alone.
   */
  selectFolder(path: string) {
    this.dialogSelection = path;
  }

  /* ── The Auto-load page ───────────────────────────────────────────────────── */

  /**
   * Opens the Auto-load page on the open target (A6 D1).
   *
   * **The target is already in hand**, which is the point of moving the importer here from
   * the create-target page: nothing is registered by this, and nothing about the target is
   * asked again. What it asks the server is the same two things the create-target page
   * asked while the operator typed — which harnesses are ready, and which model an import
   * would run on — for `importerModel`'s reason: a descriptor is observed when the server
   * built its harnesses, so the picker is told rather than holding an id.
   *
   * **It resumes before it resets.** An import this tab started on this target and that is
   * still running is shown as its panel again, and watched again — "Continue in
   * background" and the crumbs both stop the poll, and a form offered over a running import
   * is a second session writing into the same scope. A settled import is not resumed: the
   * operator comes back for another go, and gets a clean form.
   */
  openImporter(sessionId?: string) {
    const targetId = this.viewTargetId;
    if (targetId === "") return;
    this.#retireArrivalNote();
    this.importerOpen = true;
    // The target's indexed sessions beside an empty one to type into. What the index held
    // when the page was reached is shown at once and read again below, so the list is never
    // blank for the length of a round trip.
    this.importer.begin(
      this.importerIndexTargetId === targetId ? this.#indexedSessions() : [],
      this.#importerServer(targetId),
    );
    // "Continue that session": select it. Prompting it is a later slice, so this only puts
    // it on screen, read-only until the operator types.
    if (sessionId !== undefined) this.importer.open(sessionId);
    this.importStartDetail = "";
    this.importStarting = false;
    void this.loadHarnesses();
    void this.loadImporterModel();
    void this.loadImporterSessions(targetId);
    if (!this.#agentsRead) void this.loadAgents();

    const running =
      this.scopeImportId !== "" &&
      this.scopeImportTargetId === targetId &&
      (this.scopeImport === undefined || this.scopeImport.status === "running");
    if (running) {
      this.importerPhase = "importing";
      this.watchImport(targetId, this.scopeImportId);
      return;
    }
    this.importerPhase = "form";
    this.programLinks = [{ id: 1, url: "" }];
    this.#nextLinkId = 2;
    this.pickedImportInstanceId = "";
    this.pickedImportModel = "";
    this.#pickFromMemory = false;
    // The model last picked for a new session here, over D15's rule, when the catalogue
    // already read can honour it; otherwise once `loadHarnesses` has read it.
    this.#useRememberedModel();
    this.importPickerOpen = false;
    this.importModelQuery = "";
    this.scopeImport = undefined;
    this.scopeImportId = "";
    this.scopeImportTargetId = "";
    this.scopeImportDetail = "";
  }

  /**
   * Starts an import of the typed links on the open target.
   *
   * **A refusal to start leaves the form where it is**, with the server's sentence beside
   * it: no harness, a picked instance that is not ready, a target that will not open. The
   * operator's links are still there to be fixed or tried again, which is the whole
   * reason it is a value on the answer rather than a state change.
   *
   * The import's id is recorded even if the operator has left the page by the time the
   * server answers. The session is running either way, and an id this tab did not keep is
   * an import {@link openImporter} could never offer to resume.
   */
  async startScopeImport() {
    const targetId = this.viewTargetId;
    const links = this.usableLinks;
    if (targetId === "" || links.length === 0 || this.importStarting) return;
    this.importStarting = true;
    this.importStartDetail = "";
    // Normalised against the descriptors this tab is holding and absent when nothing was
    // set — the run composer's rule, and the function the server resolves with again.
    const importOptions = explicitModelOptionSelections(
      this.importModelDescriptors,
      this.pickedImportModelOptions,
    );
    const call = await this.client.startScopeImport(this.serverUrl, targetId, {
      programLinks: links,
      // Absent unless the operator actually overrode something, which is what lets the
      // server apply D15's rule to the catalogue it observed. Sending the model this page
      // is *showing* would make the browser the authority on a descriptor it only read,
      // and would pin an import to a model id that may have been retired since it loaded.
      ...(this.pickedImportInstanceId !== "" ||
      this.pickedImportModel !== "" ||
      importOptions !== undefined
        ? {
            importModel: {
              ...(this.pickedImportInstanceId === ""
                ? {}
                : { instanceId: this.pickedImportInstanceId }),
              ...(this.pickedImportModel === ""
                ? {}
                : { model: this.pickedImportModel }),
              ...(importOptions === undefined
                ? {}
                : { modelOptions: importOptions }),
            },
          }
        : {}),
    });
    this.importStarting = false;

    if (call._tag === "Ok") {
      const started = call.value.scopeImport;
      if (started === null) {
        this.importStartDetail =
          call.value.importDetail ?? "The importer could not be started.";
        return;
      }
      this.scopeImportId = started.importId;
      this.scopeImportTargetId = targetId;
      this.scopeImport = undefined;
      this.scopeImportDetail = "";
      // Still on this page, on this target: the form becomes the panel. Otherwise the
      // import runs unwatched and the page resumes it when it is next opened.
      if (this.importerOpen && this.viewTargetId === targetId) {
        this.importerPhase = "importing";
        this.watchImport(targetId, started.importId);
      }
      return;
    }
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.importStartDetail =
        "detail" in call.error && typeof call.error.detail === "string"
          ? call.error.detail
          : "The importer could not be started.";
      return;
    }
    this.importStartDetail = "No server answered at this address.";
  }

  /* ── Program links ────────────────────────────────────────────────────────── */

  addProgramLink() {
    if (this.programLinks.length >= SCOPE_IMPORT_MAX_LINKS) return;
    this.programLinks = [
      ...this.programLinks,
      { id: this.#nextLinkId++, url: "" },
    ];
  }

  /**
   * Removes one link row.
   *
   * The last row is emptied rather than removed, so the field the operator types into is
   * always on screen. A3 shows a field, not an empty space with a button under it.
   */
  removeProgramLink(id: number) {
    const left = this.programLinks.filter((link) => link.id !== id);
    this.programLinks =
      left.length === 0 ? [{ id: this.#nextLinkId++, url: "" }] : left;
  }

  setProgramLink(id: number, url: string) {
    this.programLinks = this.programLinks.map((link) =>
      link.id === id ? { ...link, url } : link,
    );
  }

  /* ── The agent registry ──────────────────────────────────────────────────── */

  /** Whether {@link loadAgents} has had the registry: it is read once per page load. */
  #agentsRead = false;

  /**
   * Reads the agents a conversation can run as (`GET /agents`), for the composer's agent
   * chip (D7). Once per page load: the registry is the server's code, and it changes only
   * when the server does. A failure is silent and tried again on the next visit; until then
   * the chip names no agent and offers no list, and a first message goes as the server's
   * default.
   */
  async loadAgents() {
    const call = await this.client.agents(this.serverUrl);
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") this.signOut("expired");
      return;
    }
    if (call._tag === "Unreachable") return;
    this.#agentsRead = true;
    this.importer.setServerAgents(call.value);
  }

  /* ── The importer's model ─────────────────────────────────────────────────── */

  /**
   * Asks the server which model an import would run on (D15).
   *
   * One request, one rule, on the server, over the catalogue it observed. A refusal means
   * no harness is ready, which disables the checkbox and says why — rather than leaving it
   * enabled and letting the operator paste links nothing will ever read.
   */
  async loadImporterModel() {
    const call = await this.client.importerModel(this.serverUrl);
    if (call._tag === "Ok") {
      this.importerModel = call.value;
      this.importModelDetail = "";
      this.importModelNoHarness = false;
      return;
    }
    this.importerModel = undefined;
    this.importModelNoHarness =
      call._tag === "Refused" && call.error._tag === "ImporterModelUnavailable";
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      // `ImporterModelUnavailable` carries one; `Unauthenticated` does not, which is why
      // this reads the field rather than assuming the union has it.
      this.importModelDetail =
        "detail" in call.error && typeof call.error.detail === "string"
          ? call.error.detail
          : "No agent harness is ready, so program pages cannot be read.";
      return;
    }
    this.importModelDetail = "No server answered at this address.";
  }

  /**
   * Asks where this server keeps its fleet data.
   *
   * The probe is read-only and already carries both roots, so this is the cheapest true
   * answer available to a browser: `HUNT_ROOT` is the server's environment, and a form
   * that wanted to name the directory its database lands in had no other way to get it
   * right. A failure is silent on purpose — the form has a wording for "root unknown" and
   * an operator cannot act on "the server would not say where it keeps its own files"
   * while they are trying to name a target.
   */
  async loadFleetRoot() {
    const call = await this.client.probe(this.serverUrl);
    if (call._tag === "Ok") {
      this.fleetRoot = call.value.fleetRoot;
      return;
    }
    if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
      this.signOut("expired");
    }
  }

  /**
   * Opens a new importer session on another harness (D6): a session is pinned to the harness
   * it started on, so a harness picked in an open session's picker is a new session, never a
   * move. The pick becomes the new session's — its harness, model and reasoning — and the
   * operator's draft, if any, is carried over to it rather than dropped.
   */
  startImporterSessionOn(
    instanceId: string,
    model: string,
    options: readonly ModelOptionSelection[],
  ) {
    this.importer.start({ keepDraft: true });
    this.pickedImportInstanceId = instanceId;
    this.pickedImportModel = model;
    this.#rememberImportModel();
    this.importModelQuery = "";
    this.importPickerOpen = false;
    this.importModelOptionsByModel = {
      ...this.importModelOptionsByModel,
      [`${instanceId}\u0000${model}`]: options,
    };
  }

  toggleImportPicker() {
    this.importPickerOpen = !this.importPickerOpen;
  }

  pickImportInstance(instanceId: string) {
    this.pickedImportInstanceId = instanceId;
    // A model belongs to one instance's catalogue, so a model picked on the old instance
    // means nothing on the new one. Cleared rather than carried, which is what stops the
    // screen showing a model the chosen harness has never heard of.
    this.pickedImportModel = "";
    this.importModelQuery = "";
    this.#rememberImportModel();
  }

  /**
   * Picks the importer's model. **The picker stays open**, for {@link pickModel}'s reason:
   * the Reasoning column beside the list is about the model just picked.
   */
  pickImportModel(model: string) {
    this.pickedImportModel = model;
    this.#rememberImportModel();
  }

  /**
   * Keeps the harness and model the operator just picked for a new session on this target
   * (U8 review), so the next opening of the importer starts on them rather than on D15's
   * default. What is kept is what the chip now shows: a harness picked without a model is
   * that harness's default model. Only an operator's pick is kept, never a default.
   */
  #rememberImportModel(): void {
    this.#pickFromMemory = false;
    const targetId = this.viewTargetId;
    const instanceId = this.importInstance?.instanceId;
    const model = this.effectiveImportModel;
    if (targetId === "" || instanceId === undefined || model === "") return;
    this.modelMemory.write(this.serverUrl, targetId, { instanceId, model });
  }

  /**
   * Puts the chip on the model last picked for a new session on this target, when its
   * harness is ready and still lists it (`usableRemembered`). Nothing is changed otherwise,
   * so D15's rule — the server's resolved default — stands; and nothing is changed once the
   * operator has picked on this page, which a late catalogue read must not undo.
   */
  #useRememberedModel(): void {
    const targetId = this.viewTargetId;
    if (targetId === "" || !this.harnessesLoaded) return;
    const usable = usableRemembered(
      this.modelMemory.read(this.serverUrl, targetId),
      this.harnesses,
    );
    // Put on from memory by an earlier reading of the catalogue, which a newer one says
    // can no longer be honoured: back to D15's rule rather than a refusal at the send.
    if (this.#pickFromMemory && usable === undefined) {
      this.#pickFromMemory = false;
      this.pickedImportInstanceId = "";
      this.pickedImportModel = "";
      return;
    }
    if (this.pickedImportInstanceId !== "" || this.pickedImportModel !== "") {
      return;
    }
    if (usable === undefined) return;
    this.pickedImportInstanceId = usable.instanceId;
    this.pickedImportModel = usable.model;
    this.#pickFromMemory = true;
  }

  /** Whether the import pick on this page is {@link #useRememberedModel}'s, not the operator's. */
  #pickFromMemory = false;

  /** {@link pickModelOption}, for the importer's model and the importer's store. */
  pickImportModelOption(descriptorId: string, value: string) {
    const next = withModelOptionPicked(
      this.importModelOptionsByModel,
      this.importModelOptionKey,
      this.importModelDescriptors,
      descriptorId,
      value,
    );
    if (next !== undefined) this.importModelOptionsByModel = next;
  }

  /**
   * Lists one folder, server-side.
   *
   * The browser never reads the filesystem — it asks, and the server decides what the
   * string it was handed is allowed to name. A refusal is shown as the server worded it
   * rather than translated, because the five reasons it can give (`traversal`, `symlink`,
   * `outside_root`, `not_absolute`, `denied`) are distinctions the operator needs and
   * this screen has no better words for.
   *
   * On a refusal the listing is left where it was, so a mistyped path does not empty the
   * tree the operator was navigating.
   */
  async browseTo(path?: string) {
    this.dialogBusy = true;
    try {
      const call = await this.client.folders(this.serverUrl, path);
      if (call._tag === "Ok") {
        this.dialogPathError = "";
        this.dialogRoot = call.value.root;
        this.dialogPath = call.value.path;
        this.dialogParent = call.value.parent;
        // A selection older than the listing does not survive it. Navigating or typing a
        // path is the more recent statement of intent, and leaving the old row selected is
        // what put two paths on screen with the button taking the stale one. Harmless to
        // drop, because this is the picker's own selection and not the form's folder.
        if (this.dialogSelection !== call.value.path) this.dialogSelection = "";
        this.dialogEntries = call.value.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
        }));
        return;
      }
      if (call._tag === "Unreachable") {
        this.dialogPathError = "No server answered at this address.";
        return;
      }
      const error = call.error;
      // Dropped here too: a listing that was refused is still not the selected folder, so
      // the selection is older than what the tree is showing.
      if (this.dialogSelection !== this.dialogPath) this.dialogSelection = "";
      this.dialogPathError =
        "detail" in error && typeof error.detail === "string"
          ? error.detail
          : "That folder cannot be browsed.";
      if (error._tag === "Unauthenticated") this.signOut("expired");
    } finally {
      this.dialogBusy = false;
    }
  }

  /**
   * Picks a folder, and proposes its basename as the target's name.
   *
   * The duplicate check is no longer done here. A duplicate is a fact about the registry
   * and only the server knows it; guessing from the rows this tab happens to be holding
   * was how the prototype did it and it would be wrong the moment two tabs were open.
   */
  chooseFolder(path: string) {
    // The same folder again is not a change: it must not re-propose a name the operator
    // has since edited, and it must not wipe a refusal that is still true of this folder.
    // "Use this folder" on the folder already in the form is a confirmation, not an edit.
    if (path === this.dialogChosen) return;
    this.dialogChosen = path;
    this.dialogName = path.split("/").filter(Boolean).pop() ?? "";
    this.createState = "idle";
    this.createDetail = "";
    this.duplicateOf = "";
  }

  /**
   * Registers the chosen folder as a target.
   *
   * Four of the dialog's states come straight from typed server errors:
   * `TargetRefused` with `duplicate_*` is the "already a target" state and carries the id
   * to offer, `PathRefused`/`PathNotFound` is the "that folder cannot be read" state,
   * `invalid_name` is reported in the same place with the server's wording, and
   * `workspace_contains_fleet_root` is the one refusal retrying cannot fix — see
   * {@link CreateState}.
   *
   * The fifth, "migration failed", is deliberately *not* an error. A target whose file
   * fails to migrate is created, recorded and listed as unavailable while its neighbours
   * keep serving — that is the fleet's partial-failure policy, and it means the created
   * row comes back with `available: false`. So the dialog reads the created target rather
   * than a failure, which is why the rail and this dialog cannot disagree about what
   * happened.
   */
  async createTarget() {
    if (this.dialogChosen === "" || this.dialogName === "") return;
    this.createState = "creating";
    this.createDetail = "";
    // A folder, a name and a note — and no program links. The importer is started from the
    // Assets page, against the target this call is about to register (A6 D1).
    const call = await this.client.createTarget(this.serverUrl, {
      workspacePath: this.dialogChosen,
      name: this.dialogName,
      scopeNote: this.dialogScope,
    });

    if (call._tag === "Unreachable") {
      this.createState = "failed";
      this.createDetail = "No server answered at this address.";
      return;
    }
    if (call._tag === "Refused") {
      const error = call.error;
      const detail =
        "detail" in error && typeof error.detail === "string"
          ? error.detail
          : "";
      this.createDetail = detail;
      if (error._tag === "TargetRefused") {
        const refused = error as { reason: string; targetId: string };
        /*
         * Reason by reason, and never "duplicate unless invalid_name".
         *
         * That is what this read before `workspace_contains_fleet_root` existed, and the
         * default was the trap: a reason this build had not heard of rendered as "Already
         * a target" with an Open button pointing at an id nobody registered. A reason it
         * does not know now reads as the folder refusal, in the server's own words, which
         * is true of every refusal this screen can be sent.
         */
        if (
          refused.reason === "duplicate_workspace" ||
          refused.reason === "duplicate_target"
        ) {
          this.createState = "duplicate";
          this.duplicateOf = refused.targetId;
          return;
        }
        /*
         * `invalid_name` is about the name and says so.
         *
         * It landed on `denied` — "that folder cannot be used", with three sentences about
         * the folder and the one about the name buried among them, and Create disabled, so
         * the one field that could fix it was the one field whose correction changed
         * nothing. An unknown reason still lands on `denied`, which is the right default
         * (`duplicate` offered an Open button for an id nobody registered), and that state
         * now carries a way out of its own.
         */
        this.createState =
          refused.reason === "workspace_contains_fleet_root"
            ? "unusable"
            : refused.reason === "invalid_name"
              ? "invalid-name"
              : "denied";
        this.duplicateOf = "";
        return;
      }
      if (error._tag === "PathRefused" || error._tag === "PathNotFound") {
        this.createState = "denied";
        return;
      }
      if (error._tag === "Unauthenticated") {
        this.signOut("expired");
        return;
      }
      this.createState = "failed";
      return;
    }

    const answer = call.value;
    const created = answer.target;
    await this.loadTargets();
    if (!created.available) {
      // The target exists and is listed; it just cannot be opened yet. The form stays up
      // so the operator reads why, with the server's own failure text.
      this.createState = "failed";
      this.createDetail = created.detail;
      return;
    }
    this.createState = "idle";
    this.select(created.id);

    // Straight to the target. It has no scope, and the Assets page is where it says so and
    // offers to load one (A6 D1) — creating a target no longer starts an import, so there
    // is no panel to hand the page to.
    this.screen = "target";
    this.openTarget(created.id);
  }

  /* ── The "Loading the scope" panel (D16) ──────────────────────────────────── */

  /**
   * Polls one import until it settles.
   *
   * **Polled rather than streamed, and the reason is what the panel is.** It is a receipt
   * for writes that have already landed, read from an in-process registry — not a live
   * channel. The live transcript's socket exists because a run narrates for hours and an
   * operator watches it; an import writes a dozen rows over a minute, and a poll every
   * `IMPORT_POLL_MS` is both simpler and enough. It also means "Continue in background" is
   * a navigation rather than a mode: the import keeps running whether or not anybody is
   * polling it.
   */
  watchImport(targetId: string, importId: string) {
    this.stopWatchingImport();
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      const call = await this.client.scopeImport(
        this.serverUrl,
        targetId,
        importId,
      );
      // A poll that came back after the operator moved on, or for an import that is no
      // longer the one being watched, is dropped. Without this a slow response can
      // overwrite a newer import's panel with an older one's receipt.
      if (stopped || this.scopeImportId !== importId) return;
      if (call._tag === "Ok") {
        this.scopeImport = call.value;
        this.scopeImportDetail = "";
        if (call.value.status === "running") return;
        this.stopWatchingImport();
        this.settleImport(call.value);
        return;
      }
      if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
        this.stopWatchingImport();
        this.signOut("expired");
        return;
      }
      // Anything else — an import this process has forgotten, a server that stopped
      // answering — sends the operator to where the writes are. There is nothing to do on
      // a panel whose subject is gone.
      this.stopWatchingImport();
      this.scopeImportDetail =
        call._tag === "Refused"
          ? ((call.error as { detail?: string }).detail ??
            "That import could not be read.")
          : "No server answered at this address.";
      this.toast = this.scopeImportDetail;
      // Forgotten, so not resumable: `openImporter` would otherwise offer the panel of an
      // import that no longer exists, poll it, and send the operator straight back here.
      this.scopeImportId = "";
      this.openAssetsFor(targetId);
    };
    /*
     * Rescheduled after each answer rather than fired on an interval.
     *
     * `Countdown` offers `after` and nothing else, which is the shape that actually suits
     * this: an interval would start a second request while the first was still out, and on
     * a slow link that is how a poll turns into a queue. Rescheduling means exactly one
     * request is in flight at a time, and the gap is measured from the answer rather than
     * from the request.
     */
    let cancelNext: (() => void) | undefined;
    const loop = async (): Promise<void> => {
      await tick();
      if (stopped) return;
      cancelNext = this.countdown.after(IMPORT_POLL_MS, () => void loop());
    };
    this.#stopPolling = () => {
      stopped = true;
      cancelNext?.();
      cancelNext = undefined;
    };
    void loop();
  }

  stopWatchingImport() {
    this.#stopPolling?.();
    this.#stopPolling = undefined;
  }

  /**
   * What happens when an import finishes on screen.
   *
   * **Nothing, when it wrote something.** The panel stays, showing the receipt and the
   * three exits, because the operator is on it to read what landed. A screen that jumped
   * away the instant the import finished would take the receipt with it.
   *
   * **A toast and a move to Assets, when it wrote nothing** (D15). Every link failing is
   * not an error state: the target is untouched and usable, with whatever scope it had,
   * and the Assets screen already says what that means ("No scope authored for this
   * target", when it has none). Keeping someone on a dead progress panel to contemplate a
   * failure they cannot fix from there would be worse.
   *
   * **The toast carries `detail`, because this is the path where it is the whole message.**
   * An import that wrote nothing takes the operator off the panel, so the panel's own
   * status line is never read — and on a `finished` import that line is the session's
   * closing report, which is the only account of *why* nothing was written. The most
   * common real case is a program page that answers `200` with no scope in it: without the
   * report, "nothing could be read from those pages" is everything the operator is ever
   * told.
   */
  settleImport(view: ScopeImportView) {
    const wrote =
      view.totals.entriesIn + view.totals.entriesOut + view.totals.assets;
    if (wrote > 0) return;
    this.toast =
      view.status === "failed"
        ? `The scope could not be read: ${view.detail ?? "the importer did not start"}. Nothing was added — author it by hand here.`
        : `Nothing could be read from those pages, so nothing was added — author the scope by hand here.${
            view.detail === null ? "" : ` The importer reported: ${view.detail}`
          }`;
    this.openAssetsFor(view.targetId);
  }

  /** Opens a target on its Assets screen. Where all three of the panel's exits lead. */
  openAssetsFor(targetId: string) {
    this.stopWatchingImport();
    this.folderPickerOpen = false;
    this.openTarget(targetId);
    this.toSection("assets");
  }

  /** The panel's first exit: go and read what was imported. */
  openImportedAssets() {
    this.openAssetsFor(
      this.scopeImportTargetId === ""
        ? this.selectedId
        : this.scopeImportTargetId,
    );
  }

  /**
   * The panel's second exit: leave it reading.
   *
   * Identical to the first in what it does to the import — which is nothing. The import is
   * a server-side fiber and was never driven from here. The difference is only where the
   * operator lands, and they land on the target either way; this one does not jump them to
   * Assets, because they said they were going to do something else.
   */
  continueImportInBackground() {
    const targetId =
      this.scopeImportTargetId === ""
        ? this.selectedId
        : this.scopeImportTargetId;
    this.stopWatchingImport();
    this.folderPickerOpen = false;
    this.openTarget(targetId);
  }

  /**
   * The panel's third exit: stop, keeping everything already written.
   *
   * **Stopping early is not a failure.** The entries written so far stay, and the rest is
   * the operator's to add — which is true because the importer writes as it reads rather
   * than batching to the end (D15). The answer carries the import as it stood at the stop,
   * so the panel's last render is the receipt for exactly what landed.
   */
  async stopImport() {
    const targetId = this.scopeImportTargetId;
    const importId = this.scopeImportId;
    if (targetId === "" || importId === "") return;
    this.stopWatchingImport();
    const call = await this.client.stopScopeImport(
      this.serverUrl,
      targetId,
      importId,
    );
    if (call._tag === "Ok") {
      this.scopeImport = call.value;
      return;
    }
    if (call._tag === "Refused" && call.error._tag === "Unauthenticated") {
      this.signOut("expired");
      return;
    }
    this.scopeImportDetail =
      call._tag === "Refused"
        ? ((call.error as { detail?: string }).detail ??
          "That import could not be stopped.")
        : "No server answered at this address.";
  }

  dismissToast() {
    this.toast = "";
  }

  /**
   * Starts a run against the open target.
   *
   * The compose box is cleared only once the server has accepted it. A box emptied
   * optimistically loses what the operator typed on every refusal, and a refusal here is
   * a normal answer — no harness, an unavailable target, a database that will not open.
   *
   * It does **not** wait for the run. The server answers when the run is going, and what
   * this method then does is refresh the running list so the screen shows a run in
   * progress rather than a submitted form.
   */
  async startRun() {
    const targetId = this.viewTargetId;
    const intentId = this.runIntentId;
    if (targetId === "" || intentId === "") return;
    if (this.starting) return;
    this.starting = true;
    this.runDetail = "";
    this.runFallback = null;
    try {
      const call = await this.client.startRun(
        this.serverUrl,
        targetId,
        intentId,
        // Omitted when the operator has not picked, which means "whatever this server
        // would choose" rather than any particular instance. The response says which it
        // used, so provenance comes back either way.
        {
          ...(this.pickedInstanceId === ""
            ? {}
            : { instanceId: this.pickedInstanceId }),
          ...(this.pickedModel === "" ? {} : { model: this.pickedModel }),
          // Normalised against the descriptors this tab is holding, and absent when
          // nothing was set — the same function the server resolves with, so a run cannot
          // be dispatched with a value the picker was not showing.
          ...(() => {
            const options = explicitModelOptionSelections(
              this.modelDescriptors,
              this.pickedModelOptions,
            );
            return options === undefined ? {} : { modelOptions: options };
          })(),
        },
      );
      if (call._tag === "Unreachable") {
        this.runDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        const error = call.error;
        if (error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.runDetail =
          "detail" in error && typeof error.detail === "string"
            ? error.detail
            : "That run was refused.";
        // Re-read, because the likeliest refusal is the intent having been taken or the
        // goal ended since this list was loaded, and the row should then say so instead of
        // offering the same run again.
        if (this.openGoalId !== "") void this.loadIntents(this.openGoalId);
        return;
      }
      this.runIntentId = "";
      this.runFallback =
        call.value.instanceFallback === null
          ? null
          : { ...call.value.instanceFallback, ranOn: call.value.instanceId };
      // Remembered so its transcript is readable once it settles: a run leaves `runs` at
      // settlement, and nothing else a browser holds survives that.
      this.lastAttempts = {
        ...this.lastAttempts,
        [targetId]: call.value.attemptId,
      };
      // Pushed from the response rather than waited for in a list refresh: the run is
      // going, and the screen should say so on the same tick the server said it.
      this.runs = [
        ...this.runs.filter(
          (entry) => entry.attemptId !== call.value.attemptId,
        ),
        {
          attemptId: call.value.attemptId,
          targetId: call.value.targetId,
          intentId: call.value.intentId,
          harnessSessionId: call.value.harnessSessionId,
          startedAt: call.value.startedAt,
        },
      ];
      // The counts moved: a run writes an attempt and an event before it is answered, so
      // the header would otherwise be stale until the next open. A refresh and not a
      // navigation — if the operator opened something else while the start was in flight,
      // the right number of targets to move them back to is none.
      await this.refreshTarget(targetId);
      // The goals' counts, and the intent: it is claimed now, so its row must stop
      // offering a run.
      void this.loadGoals(targetId);
      if (this.openGoalId !== "") void this.loadIntents(this.openGoalId);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Stops the run on the open target.
   *
   * The server settles the attempt and revokes its authority before it answers, so by the
   * time this returns the run is over in every sense the database records. The running
   * list is then refreshed from the server rather than edited here, because what stopping
   * left behind is the server's answer and not ours to assume.
   */
  async stopRun() {
    const running = this.activeRun;
    if (running === undefined || this.stopping) return;
    this.stopping = true;
    this.runDetail = "";
    try {
      const call = await this.client.stopRun(
        this.serverUrl,
        running.targetId,
        running.attemptId,
      );
      if (call._tag === "Unreachable") {
        this.runDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        const error = call.error;
        if (error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.runDetail =
          "detail" in error && typeof error.detail === "string"
            ? error.detail
            : "That run could not be stopped.";
        // Refreshed anyway: the most likely refusal is `unknown_attempt`, which means
        // this tab was holding a run the server has already finished, and the honest
        // response is to stop showing it.
        await this.loadRuns();
        return;
      }
      await this.loadRuns();
      await this.refreshTarget(running.targetId);
    } finally {
      this.stopping = false;
    }
  }

  /**
   * Reads which harnesses this server configures.
   *
   * A failure leaves the list empty, which the composer reads as "nothing to pick from"
   * and falls back to letting the server choose — the run still starts, and the refusal
   * if there is no harness comes from the server with its own words. An empty picker is
   * better than a picker full of guesses.
   */
  async loadHarnesses() {
    const call = await this.client.harnesses(this.serverUrl);
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") this.signOut("expired");
      return;
    }
    if (call._tag === "Unreachable") return;
    this.harnesses = call.value.map((entry) => ({ ...entry }));
    this.harnessesLoaded = true;
    if (this.importerOpen) this.#useRememberedModel();
    // The Auto-load page names each session's harness, and may be showing the id until now.
    if (this.importerOpen) this.importer.syncIndexed(this.#indexedSessions());
    // A picked instance the server no longer configures is dropped back to the default
    // rather than kept and refused later: this runs on a fresh session, so the only way
    // to be holding a stale id is a server that was reconfigured under us.
    if (
      this.pickedInstanceId !== "" &&
      !this.harnesses.some(
        (entry) => entry.instanceId === this.pickedInstanceId,
      )
    ) {
      this.pickedInstanceId = "";
      this.pickedModel = "";
    }
  }

  /**
   * Picks a harness instance, and resets the model with it.
   *
   * The model is cleared rather than carried across, because a model name is meaningful
   * only inside one instance: `gpt-5.6-sol` is OpenCode's and `claude-sonnet-5` is Claude
   * Code's, and carrying one over would hand the new harness a name it will refuse.
   * `""` means that instance's own default.
   */
  pickInstance(instanceId: string) {
    this.pickedInstanceId = instanceId;
    this.pickedModel = "";
    this.modelQuery = "";
  }

  /**
   * Picks a model inside the picked instance. `""` means the instance's default.
   *
   * **The popover stays open**, because the model is no longer the last thing chosen in
   * it: the reasoning column to the right is about the model just picked, and closing on
   * the model would mean reopening to use it. Choosing a reasoning level does not close it
   * either — see {@link pickModelOption} — so the popover is dismissed the way it always
   * was, by Escape or by clicking outside.
   *
   * Nothing is cleared here. Whatever was set on the *new* model is restored and whatever
   * was set on the old one stays where it was, which is what keying the store by model
   * buys: switching away and back is not a way to lose a choice.
   */
  pickModel(model: string) {
    this.pickedModel = model;
  }

  /**
   * Sets one of the picked model's options, or takes the setting off.
   *
   * Picking the choice the model marks as its default **removes** the entry instead of
   * storing `"default"` as a value. The two are indistinguishable downstream — only what
   * was explicitly set is dispatched, and the harness clients drop the default choice
   * before it reaches a provider — so keeping them apart here would be a distinction with
   * no effect, and one more state for the picker to render differently for no reason.
   *
   * An id this model has no descriptor for is refused rather than stored: the only way to
   * reach that is a stale screen, and storing it would add to the pile this already has to
   * report as dropped.
   */
  pickModelOption(descriptorId: string, value: string) {
    const next = withModelOptionPicked(
      this.modelOptionsByModel,
      this.modelOptionKey,
      this.modelDescriptors,
      descriptorId,
      value,
    );
    if (next !== undefined) this.modelOptionsByModel = next;
  }

  togglePicker() {
    this.pickerOpen = !this.pickerOpen;
    if (!this.pickerOpen) this.modelQuery = "";
  }

  /* ── The live transcript ──────────────────────────────────────────────────── */

  /**
   * How many live items this tab keeps.
   *
   * A long run narrates thousands of moments and a browser that kept all of them would
   * grow a DOM nobody scrolls back through. The oldest are dropped, which is sound here in
   * a way it would not be on the server: everything on the record channel is still in the
   * target's event log, and {@link liveCursor} still says where this tab had got to.
   *
   * V2(chat): a busy target (many items from other subjects) can slide an earlier turn's
   * live reply and footer out of view until a reload. Proper V2: keep each conversation's
   * own items outside the shared sliding window.
   */
  static readonly LIVE_KEPT = 500;

  /**
   * How many item ids this tab remembers for the purpose of not showing one twice.
   *
   * Four times {@link App.LIVE_KEPT}, so an id can only fall out of memory long after the
   * item itself has fallen off the screen. The `#shown` field records what the bound costs
   * and why that multiple puts the cost out of reach in practice.
   */
  static readonly LIVE_IDS_KEPT = 2_000;

  /**
   * Opens the live transcript for one target, closing any other.
   *
   * **Asking for the same target twice is a no-op**, not a second connection. The hunt view
   * reaches here from opening a target and from a reload, and two sockets delivering the
   * same frames would be the one duplication the day's claim is about — the ids would
   * dedupe them, but a second socket is still a second socket.
   *
   * Switching target clears everything first; reconnecting the same target retains the
   * already shown items and resumes after their committed cursor.
   */
  watchLive(targetId: string) {
    if (this.liveWatching && this.liveTargetId === targetId) return;
    const sameTarget = this.liveTargetId === targetId;
    this.stopLive();
    this.liveTargetId = targetId;
    if (!sameTarget) {
      this.liveItems = [];
      this.liveCursor = 0;
      this.liveUsage = {};
      this.liveRecoveries = [];
      this.#shown = new Set();
      this.#shownOrder = [];
    }
    this.liveCaughtUp = false;
    if (!sameTarget) this.liveSkipped = 0;
    this.liveDetail = "";
    this.#reconnectFailures = 0;
    // An empty view must reconstruct from the start; an already populated view can
    // resume after its last delivered durable sequence. Activity has no replay cursor.
    this.#connectLive(
      targetId,
      this.liveItems.length === 0 ? 0 : this.liveCursor,
    );
  }

  #connectLive(targetId: string, cursor: number) {
    const generation = ++this.#liveGeneration;
    /*
     * Every partial goes when a connection opens (A6 U5): none is resent, and a block that
     * finished while the feed was down comes back — if at all — as a finished block on the
     * record of what the harness wrote, not as this connection's, so a partial kept from
     * the last one would stay beside it as a second, shorter copy.
     */
    this.liveItems = withoutPartials(this.liveItems);
    this.liveWatching = true;
    this.#armSilence(targetId);
    this.#stopLive = this.client.watchLive(this.serverUrl, targetId, {
      cursor,
      onFrame: (frame) => {
        if (generation !== this.#liveGeneration) return;
        if (frame._tag === "cursor" && frame.caughtUp) {
          const wasCatchingUp = !this.liveCaughtUp;
          this.#reconnectFailures = 0;
          this.liveReconnecting = false;
          this.liveDetail = "";
          if (wasCatchingUp) void this.refreshTarget(targetId);
        }
        this.applyLiveFrame(targetId, frame);
      },
      onClosed: (closed) => {
        /**
         * **The session going is handled before the target guard, and that order matters.**
         *
         * An expired token is a fact about this tab, not about the target it happened to be
         * watching, so it has to be acted on even if the operator has since navigated —
         * otherwise a tab that switched target at the wrong moment keeps a dead token and
         * goes on looking signed in. `signOut` clears the live state itself.
         */
        if (closed._tag === "unauthenticated") {
          this.signOut("expired");
          return;
        }
        if (generation !== this.#liveGeneration) return;
        // Everything else *is* about this connection, so news about one this tab has left
        // is dropped, exactly as `applyLiveFrame` drops a late frame from it.
        if (this.liveTargetId !== targetId) return;
        // The connection has already ended, so the watchdog has nothing left to watch for
        // and must not fire later and overwrite this sentence with its own.
        this.#cancelSilence?.();
        this.#cancelSilence = undefined;
        this.liveWatching = false;
        this.#stopLive = undefined;
        this.#scheduleReconnect(
          targetId,
          closed._tag === "ended"
            ? "The live connection ended."
            : "The live connection dropped.",
        );
      },
    });
  }

  #scheduleReconnect(targetId: string, reason = "The live connection ended.") {
    if (this.liveTargetId !== targetId) return;
    this.liveReconnecting = true;
    this.liveCaughtUp = false;
    this.liveDetail = `${reason} Reconnecting to the committed record. Live activity during the gap cannot be replayed.`;
    this.#cancelReconnect?.();
    const delay = Math.min(
      10_000,
      1_000 * 2 ** Math.min(this.#reconnectFailures++, 4),
    );
    this.#cancelReconnect = this.countdown.after(delay, () => {
      this.#cancelReconnect = undefined;
      if (this.liveTargetId !== targetId || !this.liveReconnecting) return;
      // A cursor is advanced only from committed items or cursor frames. Resume after it;
      // overlap is harmless because stable event ids are deduplicated below.
      this.#connectLive(targetId, this.liveCursor);
    });
  }

  /**
   * Forgets everything about the live transcript, connection included.
   *
   * One method because three exits need it and each of them needs *all* of it: signing out,
   * resetting to a scenario, and a deep link to a target the registry does not hold. Each
   * used to clear the fields it remembered to, which is how `#shown` kept one session's ids
   * across a sign-out and how `reset()` left a socket open against a server the scenario
   * picker had just pretended to leave.
   *
   * It is deliberately *not* what {@link stopLive} does. Stopping leaves what arrived on
   * screen, because an operator may still be reading it; this is for the exits where what is
   * on screen belongs to a session or a target that no longer exists.
   */
  #forgetLive() {
    // `stopLive` cancels the silence watchdog as well as the connection.
    this.stopLive();
    this.liveTargetId = "";
    this.liveItems = [];
    this.liveUsage = {};
    this.liveCursor = 0;
    this.liveCaughtUp = false;
    this.liveSkipped = 0;
    this.liveDetail = "";
    this.liveRecoveries = [];
    this.#shown = new Set();
    this.#shownOrder = [];
  }

  /**
   * Closes the live connection, if one is open.
   *
   * Leaves the items on screen. Navigating away from a target clears them — see
   * {@link watchLive} — but signing out or losing the view is not a reason to blank a
   * transcript the operator may still be reading, and the stop itself is not news:
   * {@link liveDetail} stays empty because nothing went wrong.
   */
  stopLive() {
    ++this.#liveGeneration;
    this.#stopLive?.();
    this.#stopLive = undefined;
    this.#cancelSilence?.();
    this.#cancelSilence = undefined;
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.liveWatching = false;
    this.liveReconnecting = false;
  }

  /**
   * Arms the silence watchdog, replacing any armed before it.
   *
   * ## Why silence is the signal, and not the stream ending
   *
   * The obvious way to notice a dead connection is for the stream to end, and it is not a
   * reliable one. Observed in a browser: through the dev server's `/api` proxy the
   * downstream response **stayed open after the upstream closed**, so nothing ended, nothing
   * failed, and the transcript sat there showing `Live` and a cursor that would never move
   * again. Any buffering reverse proxy can do the same in a deployment. And when a close
   * *is* visible it arrives as an abrupt reset rather than an end-of-stream — which is how
   * `Bun.serve` hangs up on an idle connection — so even the visible case is not a tidy
   * signal.
   *
   * What is always true is that a healthy connection speaks. The server sends a
   * {@link LiveCursor} after every catch-up batch and then every
   * `LIVE_HEARTBEAT_SECONDS` whether or not anything is happening, so **silence longer than
   * `LIVE_SILENCE_LIMIT_SECONDS` is the only evidence of a drop that does not depend on
   * anyone telling us.** The limit is twice the heartbeat, so one late or lost heartbeat is
   * not read as a death and two in a row is.
   *
   * ## Why this cannot fire on a healthy slow run
   *
   * Because the heartbeat is not conditional on there being anything to report. A target
   * with nothing running still sends a cursor frame every heartbeat; a long catch-up sends
   * one after every page. Both re-arm this. The only way to go a whole
   * `LIVE_SILENCE_LIMIT_SECONDS` without a frame is for the frames to have stopped
   * arriving, which is the condition being detected.
   *
   * ## What it does not do
   *
   * Day 7 reconnects after this watchdog fires, from the last delivered record cursor.
   * Until catch-up finishes the panel says reconnecting, not live. Activity in the gap
   * remains unrecoverable.
   *
   * `targetId` is captured and re-checked when it fires, so a watchdog armed for a target
   * the operator has since left cannot overwrite the state of the one that replaced it.
   */
  #armSilence(targetId: string) {
    this.#cancelSilence?.();
    this.#cancelSilence = this.countdown.after(
      LIVE_SILENCE_LIMIT_SECONDS * 1_000,
      () => {
        this.#cancelSilence = undefined;
        if (this.liveTargetId !== targetId || !this.liveWatching) return;
        this.stopLive();
        this.#scheduleReconnect(
          targetId,
          `Nothing has arrived for ${LIVE_SILENCE_LIMIT_SECONDS} seconds.`,
        );
      },
    );
  }

  /**
   * Applies one frame.
   *
   * Separate from {@link watchLive} and taking the target it is for, which is what makes
   * the day's two claims testable without a connection:
   *
   * - **In store-assigned order.** Items are appended as they arrive and never re-sorted;
   *   {@link liveItems} records why that *is* the store's order for the record channel.
   * - **Without duplicates.** An id already shown is dropped, so a reconnect that re-reads
   *   a range of the record shows nothing twice.
   *
   * A frame naming a target this tab has left is dropped rather than applied. The guard is
   * the same one {@link refreshTarget} uses and is there for the same reason: a connection
   * that is being torn down can deliver one more frame after the operator has moved on.
   *
   * {@link liveCursor} only ever moves **forward**, and only from a record item or a cursor
   * frame. A cursor that could go backwards would make a reconnect re-read a range it had
   * already been shown — harmless, because of the deduplication above, but it would make
   * the cursor mean "somewhere I have been" rather than "everything up to here".
   */
  applyLiveFrame(targetId: string, frame: LiveFrame) {
    if (this.liveTargetId !== targetId) return;
    /**
     * Any frame at all is evidence the connection is alive, so the watchdog restarts here
     * and not in one of the branches below.
     *
     * Before the deduplication check on purpose: a frame this tab has already shown still
     * arrived, so it still proves the socket works. Keying liveness off *new* items would
     * have made a reconnect that re-read a range look like silence.
     */
    this.#armSilence(targetId);
    if (frame._tag === "opened") {
      this.liveSkipped = Math.max(this.liveSkipped, frame.skipped);
      // The cursor the server is reading after. Taken as the floor rather than ignored, so
      // a client that asked for nothing knows where the record it is being shown starts.
      this.liveCursor = Math.max(this.liveCursor, frame.from);
      return;
    }
    if (frame._tag === "cursor") {
      this.liveCursor = Math.max(this.liveCursor, frame.sequence);
      this.liveCaughtUp = frame.caughtUp;
      return;
    }
    if (frame._tag === "usage") {
      /*
       * One model call's measurement, kept against its own session and nothing else.
       *
       * It does **not** go through the deduplication below, and it has no `id` to go
       * through it with: a usage frame is not an item and there is nothing to show twice.
       * Two frames sharing a `callId` are the ordinary case — Claude Code delivers one call
       * as several frames and then states its output count once at turn end — and the rule
       * for all of them is the same, which is that the newest replaces the last.
       *
       * A frame naming no session is dropped. {@link usageScope} says why: a context figure
       * shown against the wrong agent is worse than none.
       */
      const scope = usageScope(frame);
      if (scope === undefined) return;
      this.liveUsage = { ...this.liveUsage, [scope]: frame };
      this.importer.noteUsage(frame);
      return;
    }
    /*
     * A partial (A6 U5): replaced by its `blockId`, never deduplicated by its `id` — that is
     * the frame's own and names nothing else, so remembering it would hide nothing that
     * could come again and would push real ids out of the bounded memory below. Nothing
     * else here is about a partial: it moves no cursor, takes nothing and refreshes nothing.
     */
    if (frame.streaming === true) {
      const placed = withBlock(this.liveItems, frame);
      if (placed !== undefined && placed !== this.liveItems) {
        this.#keepLive(placed);
      }
      // A turn's first words are a partial: a turn the harness opened itself (A6 U6).
      this.importer.noteActivity(frame);
      return;
    }
    if (this.#shown.has(frame.id)) return;
    this.#shown.add(frame.id);
    this.#shownOrder.push(frame.id);
    if (this.#shownOrder.length > App.LIVE_IDS_KEPT) {
      const oldest = this.#shownOrder.shift();
      if (oldest !== undefined) this.#shown.delete(oldest);
    }
    if (frame.sequence !== null) {
      this.liveCursor = Math.max(this.liveCursor, frame.sequence);
    }
    // A finished block takes its partial's place; anything else is added at the end.
    this.#keepLive(
      withBlock(this.liveItems, frame) ?? [...this.liveItems, frame],
    );
    // A take is kept on its importer session, since this list slides (A6 U4 review).
    this.importer.noteTaken(frame);
    // And words from a session this tab thinks idle start its turn watch (A6 U6).
    this.importer.noteActivity(frame);
    this.#refreshIntentsFor(targetId, frame);
    this.#refreshGoalBriefingFor(targetId, frame);
    this.#refreshPlanRoundsFor(targetId, frame);
  }

  /** Puts `next` on screen, the newest {@link App.LIVE_KEPT} of it. */
  #keepLive(next: readonly LiveItem[]) {
    this.liveItems = next.slice(Math.max(0, next.length - App.LIVE_KEPT));
  }

  /**
   * Re-reads the open goal's intents when the record says one of them moved.
   *
   * A run settling gives its intent back (to `open`, or `answered`), another tab may have
   * started or abandoned one, and none of that reaches this tab any other way — the
   * intents are read, not pushed. **Only once the history has finished arriving**: opening
   * a target replays its whole recent record, and a refresh per historical `run.settled`
   * would be a request storm that says nothing a single read does not.
   */
  #refreshIntentsFor(targetId: string, frame: LiveItem) {
    if (!this.liveCaughtUp || this.viewTargetId !== targetId) return;
    if (
      frame.kind !== "run.started" &&
      frame.kind !== "run.settled" &&
      frame.kind !== "intent.added" &&
      frame.kind !== "intent.abandoned"
    ) {
      return;
    }
    if (frame.kind === "run.settled") void this.loadRuns();
    if (this.openGoalId !== "") {
      void this.loadIntents(this.openGoalId);
      void this.refreshGoal(this.openGoalId);
    }
  }

  /**
   * Re-reads the open goal's briefing when something that is *in* it has changed.
   *
   * A narrower trigger than {@link #refreshIntentsFor}'s, and separate from it, because a
   * briefing is the one read here whose response is allowed to be hundreds of kilobytes:
   * it is re-read when an observation lands (the body grows) or when an intent appears,
   * goes or changes hands (the tail moves), and not for the rest. `goal.ended` is not
   * among them — a briefing carries no goal status, so ending one does not change its
   * text.
   *
   * Guarded on `liveCaughtUp` for the reason the intents refresh is: opening a target
   * replays its whole recent record, and a briefing read per historical observation would
   * be a request storm that says nothing one read at the end does not.
   */
  /**
   * Re-reads the open goal's rounds when a round record arrives.
   *
   * The narrowest trigger of the three: a round's own two records and nothing else. An
   * intent being added does not move a round row, and an observation certainly does not —
   * what they move is `intentsAdded`, which comes from the round's receipts and so changes
   * only when the round writes, which is a `plan.round.*` event's sibling rather than this
   * frame.
   *
   * **It re-reads what is in flight as well, and that is the point.** The settled record
   * is what takes a round out of the supervisor's map, so a panel that refreshed only the
   * rows would keep saying "a round has been planning this goal since…" after the round
   * had finished, with the button still disabled.
   *
   * Guarded on `liveCaughtUp` for {@link #refreshGoalBriefingFor}'s reason: opening a
   * target replays its whole recent record, and one read per historical round would be a
   * request storm that says nothing the last read does not.
   */
  #refreshPlanRoundsFor(targetId: string, frame: LiveItem) {
    if (!this.liveCaughtUp || this.viewTargetId !== targetId) return;
    if (this.openGoalId === "") return;
    if (
      frame.kind !== "plan.round.started" &&
      frame.kind !== "plan.round.settled"
    ) {
      return;
    }
    void this.loadPlanRounds(this.openGoalId);
    void this.loadRunningRounds();
    /*
     * And the prose, which is a different read with a different source.
     *
     * On a **start** because a round newer than the last replay has no entry in it, and
     * the chat would have nothing to say about it until the first narration arrived. On a
     * **settle** because a round this tab did not watch — opened in another tab, or
     * started before this page connected — has no live narration of its own, and the
     * harness's copy is the only thing that will ever show what it said.
     */
    void this.loadGoalNarration(this.openGoalId);
  }

  #refreshGoalBriefingFor(targetId: string, frame: LiveItem) {
    if (!this.liveCaughtUp || this.viewTargetId !== targetId) return;
    if (this.openGoalId === "") return;
    if (
      frame.kind !== "observation.recorded" &&
      frame.kind !== "run.started" &&
      frame.kind !== "run.settled" &&
      frame.kind !== "intent.added" &&
      frame.kind !== "intent.abandoned" &&
      frame.kind !== "intent.released"
    ) {
      return;
    }
    void this.loadGoalBriefing(this.openGoalId);
  }

  /**
   * Puts the read transcript away, with the refusal and the loading flag that belong to it.
   *
   * {@link lastAttempts} is deliberately not touched: that is the *handle* on an attempt
   * this tab started, which outlives any one look at it, and clearing it would take the
   * Goals panel's offer away rather than close what the panel was showing.
   *
   * Called by {@link toSection}, for the reason its comment gives, and by {@link reset}.
   * A read in flight is dropped by the same guard that drops an overtaken one —
   * {@link loadTranscript} re-checks {@link transcriptAttemptId} after its await — so
   * leaving a section mid-read cannot land a transcript on a screen that no longer asked
   * for it.
   */
  #closeTranscript() {
    this.transcript = undefined;
    this.transcriptAttemptId = "";
    this.transcriptLoading = false;
    this.transcriptDetail = "";
  }

  /**
   * Reads one attempt's transcript: ours if the server kept one, the harness's if not.
   *
   * **An absent transcript is a success, not a failure.** The server answers `200` with
   * `source: "absent"` for an attempt nobody kept one for, because that is the normal end
   * state of anything old enough — harnesses delete their own after a while — and
   * `transcriptDetail` is reserved for a server that did not answer at all.
   */
  async loadTranscript(targetId: string, attemptId: string) {
    this.transcriptAttemptId = attemptId;
    this.transcriptLoading = true;
    this.transcriptDetail = "";
    this.transcript = undefined;
    try {
      const call = await this.client.transcript(
        this.serverUrl,
        targetId,
        attemptId,
      );
      // A second request may have overtaken this one. Whatever came back is about an
      // attempt that is no longer on screen, so it is dropped rather than shown.
      if (this.transcriptAttemptId !== attemptId) return;
      if (call._tag === "Unreachable") {
        this.transcriptDetail = "No server answered at this address.";
        return;
      }
      if (call._tag === "Refused") {
        const error = call.error;
        if (error._tag === "Unauthenticated") {
          this.signOut("expired");
          return;
        }
        this.transcriptDetail =
          "message" in error && typeof error.message === "string"
            ? error.message
            : "That transcript could not be read.";
        return;
      }
      this.transcript = call.value;
    } finally {
      if (this.transcriptAttemptId === attemptId)
        this.transcriptLoading = false;
    }
  }

  /** Replaces the running list with what the server is supervising. */
  async loadRuns() {
    const call = await this.client.runs(this.serverUrl);
    if (call._tag === "Refused") {
      if (call.error._tag === "Unauthenticated") this.signOut("expired");
      return;
    }
    if (call._tag === "Unreachable") return;
    this.runs = call.value.map((entry) => ({ ...entry }));
  }

  toggleTheme() {
    this.theme = this.theme === "dark" ? "light" : "dark";
  }

  /**
   * Puts every field back where a fresh load leaves it, with the mock rows loaded.
   *
   * Only the scenario picker calls this. It is the one place the prototype's static data
   * is still used for the target rail, and it is used on purpose: a scenario reaches a UI
   * state without needing a server in that state.
   */
  reset() {
    this.screen = "connect";
    this.password = "";
    this.connectError = "none";
    this.connectDetail = "";
    this.connecting = false;
    this.simulateDown = false;
    this.targets = initialTargets.map((t) => ({ ...t }));
    this.selectedId = "acme-corp";
    this.search = "";
    this.reconnecting = false;
    this.bannerDismissed = false;
    this.dialogOpen = false;
    this.createState = "idle";
    this.createDetail = "";
    this.duplicateOf = "";
    this.dialogPathError = "";
    // The Auto-load page and its import panel. A scenario that left a half-filled
    // link list or a settled import behind would show the next scenario somebody else's
    // receipt, which is the one thing the state picker must not do.
    this.importerOpen = false;
    this.importer.load("default");
    this.importerIndex = [];
    this.importerIndexTargetId = "";
    this.importerPhase = "form";
    this.importStarting = false;
    this.importStartDetail = "";
    this.folderPickerOpen = false;
    this.programLinks = [{ id: 1, url: "" }];
    this.#nextLinkId = 2;
    this.importerModel = undefined;
    this.importModelDetail = "";
    this.importModelNoHarness = false;
    this.pickedImportInstanceId = "";
    this.pickedImportModel = "";
    this.#pickFromMemory = false;
    this.importModelOptionsByModel = {};
    this.importPickerOpen = false;
    this.importModelQuery = "";
    this.stopWatchingImport();
    this.scopeImport = undefined;
    this.scopeImportId = "";
    this.scopeImportTargetId = "";
    this.scopeImportDetail = "";
    this.toast = "";
    this.#retireArrivalNote();
    this.navItem = "goals";
    this.#clearGoals();
    this.drawerHidden = false;
    this.liveExpanded = false;
    this.detailOpen = false;
    this.passwordVisible = false;
    this.viewTargetId = "";
    this.counts = undefined;
    this.viewState = "empty";
    this.viewDetail = "";
    this.requestedTargetId = "";
    this.requestedPath = "";
    this.replayPath = "";
    this.runs = [];
    this.runIntentId = "";
    this.runFallback = null;
    this.starting = false;
    this.stopping = false;
    this.runDetail = "";
    /**
     * The live transcript goes, connection and all.
     *
     * The scenario picker's whole job is to reach a UI state without reproducing the
     * conditions that cause it, and `reset()` is the way back to the beginning of that —
     * which has to include the one piece of state here that owns an open socket. Leaving it
     * meant a reset that walked the screen back to Connect while a stream went on arriving
     * behind it, writing items for a target the picker had just replaced with a mock row.
     * The mock rows this method installs are not targets any server has heard of, so there
     * is nothing to re-watch and nothing is reopened.
     */
    this.#forgetLive();
    // The harness list is *not* cleared: it is this server's configuration, not a screen
    // state, and a scenario that emptied it would make the composer claim a server has no
    // harness when it has two. The *selection* is cleared, because that is a screen state.
    this.pickedInstanceId = "";
    this.pickedModel = "";
    this.pickerOpen = false;
    this.modelQuery = "";
    this.modelOptionsByModel = {};
    this.#closeTranscript();
    // And the handle as well, which `#closeTranscript` leaves alone: a scenario or a
    // sign-out starts a tab that has run nothing, so there is no attempt to offer.
    this.lastAttempts = {};
  }
}

/**
 * Shortcuts to each state in the brief, for comparing them side by side.
 *
 * Kept, and kept working, now that the screens are wired: a scenario is still the fastest
 * way to look at two states next to each other, and several of these (an unavailable
 * target, a failed migration) need conditions it is tedious to reproduce on purpose. What
 * changed is that they are no longer the *only* way in — every state below is reachable
 * from a real server too, and the folder picker ones now list a real filesystem.
 */
export const scenarios: Scenario[] = [
  {
    id: "connect-idle",
    group: "A1 Connect",
    label: "Idle",
    apply: (a) => {
      a.reset();
    },
  },
  {
    id: "connect-password",
    group: "A1 Connect",
    label: "Wrong password",
    apply: (a) => {
      a.reset();
      a.connectError = "password";
    },
  },
  {
    id: "connect-unreachable",
    group: "A1 Connect",
    label: "Server unreachable",
    apply: (a) => {
      a.reset();
      a.connectError = "unreachable";
      a.simulateDown = true;
    },
  },
  {
    id: "connect-expired",
    group: "A1 Connect",
    label: "Session expired",
    apply: (a) => {
      a.reset();
      a.connectError = "expired";
    },
  },
  {
    id: "welcome-populated",
    group: "A2 Welcome",
    label: "Populated",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
    },
  },
  {
    id: "welcome-first-run",
    group: "A2 Welcome",
    label: "First run — no targets",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.targets = [];
    },
  },
  {
    id: "welcome-missing",
    group: "A2 Welcome",
    label: "Unavailable target",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.targets = a.targets.map((t) =>
        t.id === "internal-api" ? { ...t, status: "missing" as const } : t,
      );
      a.select("internal-api");
    },
  },
  {
    id: "welcome-no-results",
    group: "A2 Welcome",
    label: "Search with no results",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.search = "xmlrpc";
    },
  },
  {
    id: "welcome-reconnecting",
    group: "A2 Welcome",
    label: "Reconnecting",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.reconnecting = true;
    },
  },
  {
    id: "run-picker",
    group: "Run composer",
    label: "Harness picker open",
    // The run composer's popover, open, against the importer's declared harnesses: no other
    // state renders `ComposeBox`, which only appears with an intent aimed at, so without
    // this its picker's layout could only be inferred from the CSS it shares.
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "goals";
      a.harnesses = mockHarnesses();
      a.harnessesLoaded = true;
      a.intents = [
        {
          intentId: "int_preview",
          goalId: "goal_preview_open",
          question: "Does the limiter key on the forwarded address?",
          status: "open",
          anchoredTo: [],
          addressesDimension: null,
          createdAt: 1_700_000_000_000,
          claimedByAttemptId: null,
          suggestion: { instanceId: null, model: null, modelOptions: null },
          attempts: 0,
        },
      ];
      a.intentsGoalId = "goal_preview_open";
      a.intentsState = "ready";
      a.runIntentId = "int_preview";
      a.pickerOpen = true;
    },
  },
  {
    id: "target-shell",
    group: "Level 2 shell",
    label: "Open target",
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
    },
  },
  {
    id: "target-detail",
    group: "Level 2 shell",
    label: "Detail panel open",
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "findings";
      a.detailRow = 0;
      a.detailOpen = true;
    },
  },
  {
    id: "target-collapsed",
    group: "Level 2 shell",
    label: "Rail hidden",
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.drawerHidden = true;
    },
  },
  {
    id: "target-empty",
    group: "Level 2 shell",
    label: "Section with nothing in it",
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "events";
    },
  },
  {
    id: "new-idle",
    group: "A3 New target",
    label: "Idle",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
    },
  },
  {
    id: "new-chosen",
    group: "A3 New target",
    label: "Folder selected",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      // A note for people, like the field: a pattern here would show the prototype
      // promising something the field has never parsed.
      a.dialogScope = "The local bit fixture, and nothing else.";
    },
  },
  {
    id: "new-creating",
    group: "A3 New target",
    label: "Creating",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      a.dialogChosen = `${a.dialogRoot}/example`;
      a.dialogName = "example";
      a.createState = "creating";
    },
  },
  {
    id: "new-failed",
    group: "A3 New target",
    label: "Migration failed",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      a.dialogChosen = `${a.dialogRoot}/example`;
      a.dialogName = "example";
      a.createState = "failed";
      a.createDetail =
        'migrate failed: Failed: Migration "1_delegation_memory_slice" failed';
    },
  },
  {
    id: "new-denied",
    group: "A3 New target",
    label: "Permission denied",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      a.dialogChosen = `${a.dialogRoot}/locked`;
      a.dialogName = "locked";
      a.createState = "denied";
      a.createDetail = "the server has no permission to read that folder";
    },
  },
  {
    id: "new-unusable",
    group: "A3 New target",
    label: "Folder holds the fleet root",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      a.dialogChosen = a.dialogRoot;
      a.dialogName = "bit-demo";
      a.createState = "unusable";
      // The server's sentence, verbatim: a prototype state showing wording the server no
      // longer sends is a state nobody can review.
      a.createDetail = `${a.dialogRoot} is ${a.dialogRoot}/.runtime/hunt/targets/bit-demo — the directory this server would record this target in — or one of the folders above it, so that directory would sit inside the very folder where this target's workers run. Every planner, goal and import session runs in a directory under ${a.dialogRoot}/.runtime/hunt/targets/bit-demo, and the policy gate refuses to install into one that sits inside the workspace, so the target could be created and then do nothing. Pick a folder that is neither ${a.dialogRoot}/.runtime/hunt/targets/bit-demo nor one of the folders above it — a folder elsewhere inside ${a.dialogRoot}/.runtime/hunt, such as ${a.dialogRoot}/.runtime/hunt/workspaces/bit-demo, is fine — or restart this server with HUNT_ROOT set outside the folder you want to use`;
    },
  },
  {
    id: "new-invalid-name",
    group: "A3 New target",
    label: "Name the server will not take",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      a.dialogChosen = `${a.dialogRoot}/example`;
      a.dialogName = "###";
      a.createState = "invalid-name";
      a.createDetail =
        "A target's name becomes a directory name: it needs at least one letter or digit, and only a-z, 0-9, '-' and '_' are kept";
    },
  },
  {
    id: "new-duplicate",
    group: "A3 New target",
    label: "Already a target",
    apply: (a) => {
      a.reset();
      a.openNewTarget();
      a.dialogChosen = `${a.dialogRoot}/acme-corp`;
      a.dialogName = "acme-corp";
      a.createState = "duplicate";
      a.duplicateOf = "acme-corp";
      a.createDetail = `${a.dialogRoot}/acme-corp is already registered as 'acme-corp'`;
    },
  },
  ...(
    [
      ["importer-first", "D2 · New session, first on this target", "first"],
      ["importer-new", "D2 · New session, earlier ones exist", "default"],
      ["importer-awaiting", "D3 · Sent, not answered yet", "awaiting"],
      ["importer-streaming", "D3 · Mid-stream, a write in flight", "streaming"],
      ["importer-complete", "D4 · Multi-turn, correcting it", "complete"],
      ["importer-picker", "D5 · Session picker", "picker"],
      ["importer-reloaded", "Reloaded · harness still has it", "reloaded"],
      [
        "importer-forgotten",
        "Reloaded · harness no longer has it",
        "forgotten",
      ],
      ["importer-opening", "Opening an older session", "opening"],
    ] as const satisfies readonly (readonly [
      string,
      string,
      ImporterScenario,
    ])[]
  ).map(([id, label, state]): Scenario => ({
    id,
    group: "A6 Auto-load",
    label,
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "assets";
      a.importerOpen = true;
      // There is no server to ask which harnesses are ready or which model an import would
      // run on, so the chip's picker is given declared ones.
      a.harnesses = mockHarnesses();
      a.harnessesLoaded = true;
      a.importerModel = mockImporterModel();
      a.importer.load(state);
    },
  })),
  // Its own group: the A6 Auto-load nine are the importer page's states, and each of those
  // mounts the chat. These two are the Assets screen that leads to it, with and without
  // entries: D1 draws the strip on both, and moves the primary button into the header once
  // there are entries.
  ...(
    [
      ["importer-strip", "D1 · Assets, an earlier session to continue", []],
      [
        "importer-strip-entries",
        "D1 · Assets with entries, the same strip",
        [
          ["in", "subtree", "acme.com", "imported"],
          ["in", "host", "api.acme.com", "imported"],
          ["out", "host", "status.acme.com", "operator"],
        ],
      ],
    ] as const
  ).map(([id, label, entries]): Scenario => ({
    id,
    group: "A6 Assets",
    label,
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "assets";
      a.assetsTab = "scope";
      // The scope is declared: with no entries the strip sits under the empty state, with
      // some it sits under the lists.
      a.scope = {
        entries: entries.map(([effect, kind, value, source], index) => ({
          entryId: `ent_mock_${String(index)}`,
          effect,
          kind,
          value,
          source,
          note: null,
          createdAt: Date.now() - index * 60_000,
        })),
        hostLabels: [],
        assetLabels: [],
        promptBlock: null,
      };
      a.scopeTargetId = "acme-corp";
      a.scopeState = "ready";
      // What `GET .../importer-sessions` would answer, so the strip can be inspected without
      // a server that has run an import. "Continue that session" is only faithful against a
      // real session: it opens the page, which reads the harness listing and the model like
      // any other visit to it, and with no session to read them with the app signs out as it
      // does for every scenario that makes a call. The state picker's nine do not make one.
      a.importerIndex = mockImporterIndex(Date.now());
      a.importerIndexTargetId = "acme-corp";
      a.harnesses = mockHarnesses();
      a.harnessesLoaded = true;
      a.importerModel = mockImporterModel();
    },
  })),
];
