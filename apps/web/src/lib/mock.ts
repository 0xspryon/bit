/**
 * Static data for the Flow A prototype.
 *
 * What is left here is what has no server behind it yet: the hunt list, the Level 2
 * navigation, and the rows the state picker loads. Hunts live in a target's own
 * `hunt.sqlite` and reading one per request needs the per-target store resolver, so they
 * stay visibly a prototype rather than becoming a fabricated count on a real screen.
 *
 * The target rail is **not** fed from here any more: `app.svelte.ts` fills it from
 * `GET /api/v1/targets`. The rows below survive only because the state picker loads
 * them, which is how it reaches a UI state without a server in that state. The folder
 * tree that used to live here is gone — the New target dialog lists the real filesystem
 * through `GET /api/v1/folders`, server-side and bounded by a configured root, because
 * the browser never reads the filesystem.
 */

export type TargetStatus = "ready" | "missing" | "migrating" | "failed";

export interface Target {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly scope: string;
  readonly lastActivity: string;
  status: TargetStatus;
  readonly hunts: number;
  readonly findings: number;
  /**
   * The server's own words for the state this row is in.
   *
   * Present on a row that came from the registry, absent on the picker's static rows.
   * The rail has one `missing` state for every reason a target cannot be opened, and
   * this is where the reason is kept so the screen can show it instead of guessing.
   */
  readonly detail?: string;
}

export interface Hunt {
  readonly id: string;
  readonly targetId: string;
  readonly title: string;
  readonly when: string;
  readonly group: "Today" | "Yesterday" | "Earlier";
}

export const initialTargets: Target[] = [
  {
    id: "acme-corp",
    name: "acme-corp",
    path: "~/hunts/acme-corp",
    scope: "*.acme-corp.test",
    lastActivity: "2m",
    status: "ready",
    hunts: 6,
    findings: 2,
  },
  {
    id: "internal-api",
    name: "internal-api",
    path: "~/hunts/internal-api",
    scope: "api.internal.test",
    lastActivity: "7m",
    status: "ready",
    hunts: 14,
    findings: 3,
  },
  {
    id: "scratch",
    name: "scratch",
    path: "~/hunts/scratch",
    scope: "localhost:8080",
    lastActivity: "6d",
    status: "ready",
    hunts: 1,
    findings: 0,
  },
];

export const hunts: Hunt[] = [
  {
    id: "h1",
    targetId: "acme-corp",
    title: "Rate limit probe on /v1/login",
    when: "2m ago",
    group: "Today",
  },
  {
    id: "h2",
    targetId: "acme-corp",
    title: "Auth surface sweep",
    when: "1h ago",
    group: "Today",
  },
  {
    id: "h3",
    targetId: "acme-corp",
    title: "IDOR check across tenant ids",
    when: "4h ago",
    group: "Today",
  },
  {
    id: "h4",
    targetId: "acme-corp",
    title: "GraphQL introspection",
    when: "Yesterday",
    group: "Yesterday",
  },
  {
    id: "h5",
    targetId: "acme-corp",
    title: "Session fixation follow-up",
    when: "Yesterday",
    group: "Yesterday",
  },
  {
    id: "h6",
    targetId: "acme-corp",
    title: "Initial recon",
    when: "12 Oct",
    group: "Earlier",
  },
  {
    id: "h7",
    targetId: "internal-api",
    title: "Tenant boundary probe",
    when: "7m ago",
    group: "Today",
  },
  {
    id: "h8",
    targetId: "internal-api",
    title: "JWT claim tampering",
    when: "Yesterday",
    group: "Yesterday",
  },
];

export const huntGroups = ["Today", "Yesterday", "Earlier"] as const;

export const START_COMMAND = "bun run dev --filter @bit/server";

/* ── Level 2 navigation ──────────────────────────────────────────────────── */

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Rows behind this item, shown as a quiet count. */
  readonly count?: number;
  /** Only Blockers and Findings may demand attention. */
  readonly attention?: boolean;
}

export const navGroups: ReadonlyArray<{
  readonly label: string;
  readonly items: readonly NavItem[];
}> = [
  {
    label: "Investigation",
    items: [
      { id: "hunts", label: "Hunts", icon: "stream", count: 6 },
      {
        id: "findings",
        label: "Findings",
        icon: "bug",
        count: 2,
        attention: true,
      },
      { id: "observations", label: "Observations", icon: "eye", count: 148 },
      { id: "assets", label: "Assets", icon: "sitemap", count: 37 },
      { id: "frontier", label: "Frontier", icon: "compass", count: 12 },
      { id: "traffic", label: "Traffic", icon: "exchange" },
      { id: "evidence", label: "Evidence", icon: "archive", count: 9 },
      { id: "reports", label: "Reports", icon: "file", count: 1 },
    ],
  },
  {
    label: "Operations",
    items: [
      { id: "workers", label: "Workers", icon: "robot", count: 2 },
      {
        id: "blockers",
        label: "Blockers",
        icon: "blocked",
        count: 1,
        attention: true,
      },
      { id: "policy", label: "Policy", icon: "shield" },
      { id: "quota", label: "Quota", icon: "hourglass" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "events", label: "Event log", icon: "scroll" },
    ],
  },
];
