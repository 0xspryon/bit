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
 * **What is still static, and why.** The hunt list is mock data. Hunts live in a target's
 * own `hunt.sqlite`, reading one per request needs the per-target store resolver, and that
 * is a later day's work. A screen that invented a hunt count would be a lie the operator
 * cannot see through, so the list stays visibly a prototype until there is a real one.
 *
 * **The scenario picker still works.** `reset()` loads the mock rows on purpose: a
 * scenario's job is to reach a UI state without reproducing the conditions that cause
 * it. Where a state can now come from the server — a refused password, an unavailable
 * target, a duplicate folder, a failed migration — the real path produces it too, and the
 * scenario is the shortcut rather than the only way in.
 */

import {
  droppedModelOptionIds,
  explicitModelOptionSelections,
  modelOptionDescriptors,
  type AttemptTranscript,
  LIVE_SILENCE_LIMIT_SECONDS,
  type HarnessInstanceView,
  type LiveFrame,
  type LiveItem,
  type ModelOptionSelection,
  type RunningAttempt,
  type TargetView,
  type TargetCounts,
  type TargetSummary,
} from "@bit/contracts";

import { initialTargets, previewCounts, type Target } from "./mock";
import { server, type ServerClient } from "./client";

/**
 * A cancellable one-shot timer.
 *
 * A seam rather than a direct `setTimeout`, for the reason {@link App}'s client is one: the
 * live transcript's silence watchdog and reconnect backoff depend on elapsed time;
 * a test of the watchdog that actually waited would be a forty-second test.
 * There is one real implementation and it is three lines; see `test/fakeCountdown.ts` for
 * the other.
 */
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

export type Screen = "connect" | "welcome" | "target";
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
export type CreateState =
  "idle" | "creating" | "failed" | "duplicate" | "denied";

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
 *
 * `hunts` and `findings` are zero and visibly so: there is no count to read without
 * opening the target's own database.
 */
export const fromSummary = (summary: TargetSummary, now: number): Target => ({
  id: summary.id,
  name: summary.name,
  path: summary.workspacePath ?? summary.dataDirectory,
  scope: summary.scopeNote === "" ? "—" : summary.scopeNote,
  lastActivity: relative(summary.lastActivityAt, now),
  status: summary.available ? "ready" : "missing",
  hunts: 0,
  findings: 0,
  detail: summary.detail,
});

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
  ) {
    this.client = client;
    this.countdown = countdown;
  }

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
  openTargetIds = $state<string[]>([]);
  selectedId = $state("");
  search = $state("");
  reconnecting = $state(false);
  bannerDismissed = $state(false);

  /** Whether the password field is showing its value. */
  passwordVisible = $state(false);

  /* Level 2 — inside an open target */
  navItem = $state("hunts");
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
   * A target named in the URL that could not be opened yet.
   *
   * A deep link arrives before there is a session, so the id is parked here and acted on
   * once the target list is in hand. Cleared whether or not it resolves — a link to a
   * target that no longer exists should leave the operator on the list, once, rather than
   * re-asking on every refresh of it.
   */
  requestedTargetId = $state("");
  sidebarCollapsed = $state(false);
  detailOpen = $state(false);
  detailRow = $state(0);

  /* ── Runs ─────────────────────────────────────────────────────────────────── */
  /**
   * What the operator has typed into the compose box.
   *
   * One field, because one field is all the server takes: the instruction becomes the
   * goal, the intent's question and the prompt. Which existing intent a run belongs to is
   * the work of the flow that shows intents, and a picker here would be choosing on its
   * behalf.
   */
  instruction = $state("");
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
  /** Server-fed: the parent, or `null` at the root. */
  dialogParent = $state<string | null>(null);
  /** Server-fed: the immediate subdirectories of `dialogPath`. */
  dialogEntries = $state<{ name: string; path: string }[]>([]);
  /** A refusal from the picker, in the server's words. */
  dialogPathError = $state("");
  dialogBusy = $state(false);
  dialogChosen = $state("");
  dialogName = $state("");
  dialogScope = $state("");
  createState = $state<CreateState>("idle");
  /** The server's own words for whichever create state is showing. */
  createDetail = $state("");
  /** For the duplicate state: the target already holding that folder. */
  duplicateOf = $state("");

  selected = $derived(
    this.targets.find((t) => t.id === this.selectedId) ?? this.targets[0],
  );

  openTargets = $derived(
    this.openTargetIds
      .map((id) => this.targets.find((t) => t.id === id))
      .filter((t): t is Target => t !== undefined),
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
      this.openRequested();
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
      this.screen = "welcome";
      await this.loadTargets();
      await this.loadHarnesses();
      // A deep link resumes into the target it named, which is the whole point of the
      // URL carrying one: reloading the tab must not drop you back on the list.
      this.openRequested();
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
    this.targets = [];
    this.openTargetIds = [];
    this.selectedId = "";
    this.viewTargetId = "";
    this.counts = undefined;
    this.viewState = "empty";
    this.viewDetail = "";
    this.runs = [];
    this.instruction = "";
    this.runDetail = "";
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
    this.openTargetIds = this.openTargetIds.filter((id) =>
      this.targets.some((t) => t.id === id),
    );
  }

  select(id: string) {
    this.selectedId = id;
    this.search = "";
    if (!this.openTargetIds.includes(id)) {
      this.openTargetIds = [...this.openTargetIds, id];
    }
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
    this.select(id);
    this.screen = "target";
    this.navItem = "hunts";
    this.detailOpen = false;
    this.instruction = "";
    this.runDetail = "";
    this.viewTargetId = id;
    void this.refreshTarget(id);
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
        this.viewState = "empty";
        this.screen = "welcome";
        // There is no target to watch any more. Forgotten rather than left running against
        // a deep link to something the registry does not hold.
        this.#forgetLive();
        await this.loadTargets();
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
   * Opens a target with the prototype's counts and no request, for the state picker.
   *
   * The picker's job is to reach a UI state without reproducing the conditions that cause
   * it, and its rows are mock rows that no server has heard of — so asking the server
   * about one would land on `TargetNotFound` and bounce back to the list. This is the same
   * shortcut `reset()` is: real where it can be, declared where it cannot.
   */
  previewTarget(id: string) {
    this.select(id);
    this.screen = "target";
    this.detailOpen = false;
    this.viewTargetId = id;
    this.counts = previewCounts;
    this.viewState = "ready";
    this.viewDetail = "";
  }

  /** Remembers a target named in the URL, to open once there is a session. */
  requestTarget(id: string) {
    this.requestedTargetId = id;
  }

  /**
   * Opens the target a URL asked for, if it is one this server has.
   *
   * Called after the list is loaded, by both ways in — a fresh sign-in and a resumed
   * session — because a link should land in the same place either way. An id the registry
   * does not hold is dropped silently *here* and reported by the route if the operator
   * tries again: the list is already on screen, and it is the honest answer to "that
   * target is not on this server".
   */
  openRequested() {
    const id = this.requestedTargetId;
    this.requestedTargetId = "";
    if (id === "") return;
    if (!this.targets.some((target) => target.id === id)) return;
    this.openTarget(id);
  }

  toSettings() {
    this.navItem = "settings";
  }

  closeTab(id: string) {
    this.openTargetIds = this.openTargetIds.filter((t) => t !== id);
  }

  /* ── New target ──────────────────────────────────────────────────────────── */

  openDialog() {
    this.dialogOpen = true;
    this.dialogChosen = "";
    this.dialogName = "";
    this.dialogScope = "";
    this.dialogPathError = "";
    this.createState = "idle";
    this.createDetail = "";
    this.duplicateOf = "";
    void this.browseTo(this.dialogRoot === "" ? undefined : this.dialogRoot);
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
    this.dialogChosen = path;
    this.dialogName = path.split("/").filter(Boolean).pop() ?? "";
    this.createState = "idle";
    this.createDetail = "";
    this.duplicateOf = "";
  }

  /**
   * Registers the chosen folder as a target.
   *
   * Three of the dialog's states come straight from typed server errors:
   * `TargetRefused` with `duplicate_*` is the "already a target" state and carries the id
   * to offer, `PathRefused`/`PathNotFound` is the "that folder cannot be read" state, and
   * `invalid_name` is reported in the same place with the server's wording.
   *
   * The fourth, "migration failed", is deliberately *not* an error. A target whose file
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
        this.createState =
          refused.reason === "invalid_name" ? "denied" : "duplicate";
        this.duplicateOf = refused.targetId;
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

    const created = call.value;
    await this.loadTargets();
    if (!created.available) {
      // The target exists and is listed; it just cannot be opened yet. The dialog stays
      // up so the operator reads why, with the server's own failure text.
      this.createState = "failed";
      this.createDetail = created.detail;
      return;
    }
    this.dialogOpen = false;
    this.createState = "idle";
    this.select(created.id);
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
    if (targetId === "" || this.instruction.trim().length === 0) return;
    if (this.starting) return;
    this.starting = true;
    this.runDetail = "";
    try {
      const call = await this.client.startRun(
        this.serverUrl,
        targetId,
        this.instruction.trim(),
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
        return;
      }
      this.instruction = "";
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
      // The counts moved: a run writes a goal, an intent and an attempt before it is
      // answered, so the header would otherwise be stale until the next open. A refresh
      // and not a navigation — if the operator opened something else while the start was
      // in flight, the right number of targets to move them back to is none.
      await this.refreshTarget(targetId);
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
    const descriptor = this.modelDescriptors.find(
      (entry) => entry.id === descriptorId,
    );
    if (descriptor === undefined) return;
    const key = this.modelOptionKey;
    const kept = (this.modelOptionsByModel[key] ?? []).filter(
      (selection) => selection.id !== descriptorId,
    );
    const isDefault =
      descriptor.options.find((choice) => choice.id === value)?.isDefault ===
      true;
    const next = isDefault ? kept : [...kept, { id: descriptorId, value }];
    this.modelOptionsByModel = {
      ...this.modelOptionsByModel,
      [key]: next,
    };
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
    const next = [...this.liveItems, frame];
    this.liveItems =
      next.length > App.LIVE_KEPT
        ? next.slice(next.length - App.LIVE_KEPT)
        : next;
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

      /**
       * A recorded transcript is proof the attempt settled, so stop claiming it is running.
       *
       * The server writes its own artefact inside the settlement finalizer, *after* the
       * attempt row and its `attempt.settled` event — so `source: "recorded"` cannot exist
       * for a run that is still going. This tab's running list is refreshed on open, on
       * start and on stop and nowhere else, so a run that settled on its own leaves the
       * composer showing "Running for Ns" beside a transcript of the finished run: a
       * screen contradicting itself, where the part that looks wrong is the part that is
       * right.
       *
       * **This is not a live feed.** There is no interval, no poll and no subscription —
       * Day 6 owns those. It is one refetch, on evidence already in hand, declining to keep
       * showing data it has just been told is stale.
       *
       * **Only for `recorded`.** A `harness` source says the harness still holds the
       * session, which says nothing about whether the run finished; and `absent` is also
       * what a foreign instance and an attempt with no session return, so neither supports
       * the inference. Guarded on the composer actually showing it, so a read of an old
       * attempt costs no request.
       */
      if (
        call.value.source === "recorded" &&
        this.runs.some((entry) => entry.attemptId === attemptId)
      ) {
        await this.loadRuns();
      }
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
    this.openTargetIds = ["acme-corp", "internal-api"];
    this.selectedId = "acme-corp";
    this.search = "";
    this.reconnecting = false;
    this.bannerDismissed = false;
    this.dialogOpen = false;
    this.createState = "idle";
    this.createDetail = "";
    this.duplicateOf = "";
    this.dialogPathError = "";
    this.navItem = "hunts";
    this.sidebarCollapsed = false;
    this.detailOpen = false;
    this.passwordVisible = false;
    this.viewTargetId = "";
    this.counts = undefined;
    this.viewState = "empty";
    this.viewDetail = "";
    this.requestedTargetId = "";
    this.runs = [];
    this.instruction = "";
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
    this.transcript = undefined;
    this.transcriptAttemptId = "";
    this.transcriptLoading = false;
    this.transcriptDetail = "";
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
      a.openTargetIds = [];
    },
  },
  {
    id: "welcome-no-hunts",
    group: "A2 Welcome",
    label: "Target with no hunts",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.select("scratch");
      a.targets = a.targets.map((t) =>
        t.id === "scratch" ? { ...t, hunts: 0 } : t,
      );
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
    label: "Collapsed icon rail",
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "blockers";
      a.sidebarCollapsed = true;
    },
  },
  {
    id: "target-empty",
    group: "Level 2 shell",
    label: "Section with nothing in it",
    apply: (a) => {
      a.reset();
      a.previewTarget("acme-corp");
      a.navItem = "traffic";
    },
  },
  {
    id: "new-idle",
    group: "A3 New target",
    label: "Idle",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.openDialog();
    },
  },
  {
    id: "new-chosen",
    group: "A3 New target",
    label: "Folder selected",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.openDialog();
      a.dialogScope = "*.bit.test";
    },
  },
  {
    id: "new-creating",
    group: "A3 New target",
    label: "Creating",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.openDialog();
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
      a.screen = "welcome";
      a.openDialog();
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
      a.screen = "welcome";
      a.openDialog();
      a.dialogChosen = `${a.dialogRoot}/locked`;
      a.dialogName = "locked";
      a.createState = "denied";
      a.createDetail = "the server has no permission to read that folder";
    },
  },
  {
    id: "new-duplicate",
    group: "A3 New target",
    label: "Already a target",
    apply: (a) => {
      a.reset();
      a.screen = "welcome";
      a.openDialog();
      a.dialogChosen = `${a.dialogRoot}/acme-corp`;
      a.dialogName = "acme-corp";
      a.createState = "duplicate";
      a.duplicateOf = "acme-corp";
      a.createDetail = `${a.dialogRoot}/acme-corp is already registered as 'acme-corp'`;
    },
  },
];
