/**
 * Static data for the Flow A prototype.
 *
 * What is left here is what has no server behind it yet: the Level 2 navigation, and the rows the state picker loads — including the two goals its
 * open target shows, since a scenario has no server to read real ones from.
 *
 * The target rail is **not** fed from here any more: `app.svelte.ts` fills it from
 * `GET /api/v1/targets`. The rows below survive only because the state picker loads
 * them, which is how it reaches a UI state without a server in that state. The folder
 * tree that used to live here is gone — the New target dialog lists the real filesystem
 * through `GET /api/v1/folders`, server-side and bounded by a configured root, because
 * the browser never reads the filesystem.
 */

import type { GoalView, TargetCounts } from "@bit/contracts";

/**
 * Counts for the state picker's open target.
 *
 * The hunt view's header reads real numbers from the server. A scenario has no server, so
 * it needs some, and these are deliberately the same ones the prototype's Level 2
 * navigation shows — a picker that disagreed with itself would be worse than one that is
 * visibly a prototype. Nothing outside `scenarios` reads this.
 */
export const previewCounts: TargetCounts = {
  goals: 2,
  intents: 6,
  attempts: 8,
  unsettledAttempts: 1,
  observations: 148,
  assets: 37,
  events: 212,
};

/**
 * The goals the state picker's open target shows.
 *
 * A scenario has no server, so the Goals page cannot read any, and left alone it would sit
 * at "reading" for ever. These are declared instead, and there are as many as
 * {@link previewCounts} says there are (two), for the reason that object's own comment
 * gives: a picker that disagreed with itself would be worse than one that is visibly a
 * prototype. One is open and one is ended, so both states of the page can be compared
 * without a server in either. Called with the target's id so the rows belong to it.
 */
export const previewGoals = (targetId: string): GoalView[] => [
  {
    goalId: "goal_preview_open",
    targetId,
    name: "Auth bypass",
    description: "Find out whether the login limiter can be bypassed.",
    status: "active",
    createdAt: 1_700_000_000_000,
    endedAt: null,
    endedBy: null,
    endReason: null,
    counts: { intents: 4, attempts: 5, observations: 90 },
  },
  {
    goalId: "goal_preview_met",
    targetId,
    name: "",
    description: "Map the unauthenticated surface of the API.",
    status: "met",
    createdAt: 1_699_000_000_000,
    endedAt: 1_699_500_000_000,
    endedBy: "operator",
    endReason: "Every route is listed.",
    counts: { intents: 2, attempts: 3, observations: 58 },
  },
];

export type TargetStatus = "ready" | "missing" | "migrating" | "failed";

export interface Target {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly scope: string;
  readonly lastActivity: string;
  status: TargetStatus;
  /**
   * The server's own words for the state this row is in.
   *
   * Present on a row that came from the registry, absent on the picker's static rows.
   * The rail has one `missing` state for every reason a target cannot be opened, and
   * this is where the reason is kept so the screen can show it instead of guessing.
   */
  readonly detail?: string;
}

export const initialTargets: Target[] = [
  {
    id: "acme-corp",
    name: "acme-corp",
    path: "~/hunts/acme-corp",
    scope: "*.acme-corp.test",
    lastActivity: "2m",
    status: "ready",
  },
  {
    id: "internal-api",
    name: "internal-api",
    path: "~/hunts/internal-api",
    scope: "api.internal.test",
    lastActivity: "7m",
    status: "ready",
  },
  {
    id: "scratch",
    name: "scratch",
    path: "~/hunts/scratch",
    scope: "localhost:8080",
    lastActivity: "6d",
    status: "ready",
  },
];

export const START_COMMAND = "bun run dev --filter @bit/server";

/* ── Level 2 navigation ──────────────────────────────────────────────────── */

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /**
   * How many placeholder rows an undesigned section renders.
   *
   * **Not a count, and never shown as one.** It was `count`, and the rail read it as a
   * fallback whenever the real figure was unavailable — so a brand-new target with an
   * empty database showed Findings 2, Evidence 9, Workers 2, Blockers 1 in its rail.
   * Invented numbers on an empty target are worse than no numbers: they put every real
   * figure beside them in doubt. The rail now shows only counts it has read
   * (`App.navCount`), and this stays what it always was — how many grey rows
   * `Target.svelte` draws on a page that says "Placeholder content" on it.
   */
  readonly placeholderRows?: number;
  /** Only Blockers and Findings may demand attention. */
  readonly attention?: boolean;
}

/**
 * The rail, trimmed to the things being investigated.
 *
 * Eleven items rather than fifteen: Policy, Quota and Notifications are configuration and
 * live under Settings, and Traffic and Reports wait for the flows that design them. Settings
 * and Help are the rail's footer, not entries here.
 */
export const navGroups: ReadonlyArray<{
  readonly label: string;
  readonly items: readonly NavItem[];
}> = [
  {
    label: "Investigation",
    items: [
      // Goals, Observations and Assets are driven by real rows and render their own
      // pages, so they have no placeholder rows either.
      { id: "goals", label: "Goals", icon: "goals" },
      {
        id: "findings",
        label: "Findings",
        icon: "findings",
        placeholderRows: 2,
        attention: true,
      },
      { id: "observations", label: "Observations", icon: "observations" },
      { id: "assets", label: "Assets", icon: "assets" },
      {
        id: "evidence",
        label: "Evidence",
        icon: "evidence",
        placeholderRows: 9,
      },
    ],
  },
  {
    label: "Operations",
    items: [
      { id: "workers", label: "Workers", icon: "workers", placeholderRows: 2 },
      {
        id: "blockers",
        label: "Blockers",
        icon: "blockers",
        placeholderRows: 1,
        attention: true,
      },
      { id: "events", label: "Event log", icon: "events" },
    ],
  },
];

/** Every rail item, flat, for the places that look one up by id. */
export const navItems: readonly NavItem[] = navGroups.flatMap((g) => g.items);
