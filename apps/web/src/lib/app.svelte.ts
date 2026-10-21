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

import type { TargetSummary } from "@bit/contracts";

import { initialTargets, type Target } from "./mock";
import { server, setToken, storedToken } from "./client";

export type Screen = "connect" | "welcome" | "target";
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
  sidebarCollapsed = $state(false);
  detailOpen = $state(false);
  detailRow = $state(0);

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
      const call = await server.openSession(this.serverUrl, this.password);
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
      setToken(call.value.token);
      this.connectError = "none";
      this.password = "";
      this.screen = "welcome";
      await this.loadTargets();
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
    const token = storedToken();
    if (token === undefined) return;
    setToken(token);
    const call = await server.probe(this.serverUrl);
    if (call._tag === "Ok") {
      this.dialogRoot = call.value.workspaceRoot;
      this.screen = "welcome";
      await this.loadTargets();
      return;
    }
    if (call._tag === "Refused") {
      setToken(undefined);
      this.screen = "connect";
      this.connectError = "expired";
      return;
    }
    this.screen = "connect";
    this.connectError = "unreachable";
    this.connectDetail = call.detail;
  }

  signOut(reason: ConnectError = "none") {
    setToken(undefined);
    this.screen = "connect";
    this.password = "";
    this.connectError = reason;
    this.targets = [];
    this.openTargetIds = [];
    this.selectedId = "";
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
    const call = await server.targets(this.serverUrl);
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

  /** Opens a target: Level 1 gives way to Level 2. */
  openTarget(id: string) {
    this.select(id);
    this.screen = "target";
    this.navItem = "hunts";
    this.detailOpen = false;
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
      const call = await server.folders(this.serverUrl, path);
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
    const call = await server.createTarget(this.serverUrl, {
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
      a.openTarget("acme-corp");
    },
  },
  {
    id: "target-detail",
    group: "Level 2 shell",
    label: "Detail panel open",
    apply: (a) => {
      a.reset();
      a.openTarget("acme-corp");
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
      a.openTarget("acme-corp");
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
      a.openTarget("acme-corp");
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
