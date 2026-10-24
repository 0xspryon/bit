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

import type {
  AttemptTranscript,
  HarnessInstanceView,
  RunningAttempt,
  TargetCounts,
  TargetSummary,
} from "@bit/contracts";

import { initialTargets, previewCounts, type Target } from "./mock";
import { server, type ServerClient } from "./client";

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
   * Defaults to the live client, so `new App()` is unchanged for the route that mounts
   * it. The parameter exists for the tests, which hand in a hand-written double; it is
   * not a configuration point and there is no second real implementation.
   */
  constructor(client: ServerClient = server) {
    this.client = client;
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

  /** Picks a model inside the picked instance. `""` means the instance's default. */
  pickModel(model: string) {
    this.pickedModel = model;
    this.pickerOpen = false;
    this.modelQuery = "";
  }

  togglePicker() {
    this.pickerOpen = !this.pickerOpen;
    if (!this.pickerOpen) this.modelQuery = "";
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
    // The harness list is *not* cleared: it is this server's configuration, not a screen
    // state, and a scenario that emptied it would make the composer claim a server has no
    // harness when it has two. The *selection* is cleared, because that is a screen state.
    this.pickedInstanceId = "";
    this.pickedModel = "";
    this.pickerOpen = false;
    this.modelQuery = "";
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
