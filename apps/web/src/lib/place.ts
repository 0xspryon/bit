/**
 * The URL grammar: which resource the operator is looking at, as a path and back again.
 *
 * One operator wanting to bookmark a link and find the same page next week is the whole
 * requirement (`docs/superpowers/specs/2026-11-03-url-routing-design.md`). This module is
 * that design's D3: the **grammar alone**, with no opinion about navigation. Nothing here
 * imports `$app/navigation`, reads `location`, or touches history — the shell owns `goto`
 * and `popstate`, and `App` goes on knowing nothing about either, which is what keeps it a
 * plain class that a test or a second shell can construct with no router. The four
 * functions below are string and state work, so they are unit-testable without a DOM, and
 * that is where the round-trip and totality properties are pinned down.
 *
 * ## Place, not view
 *
 * A {@link Place} is *which resource* is on screen: target, section, record id. `App` has
 * well over two hundred `$state` fields and almost none of them belong in a URL — a filter
 * box, an open picker, a scroll offset are how you have arranged your look at a thing, not
 * which thing it is. The estate's scope filter is the one deliberate exception, and it is
 * in the **query string** rather than the path for exactly that reason: "uncovered assets
 * on acme-corp" is worth coming back to, and a query parameter can be added or dropped
 * without touching the grammar the saved path is a promise about.
 *
 * ## One state, one path
 *
 * {@link placeOf} is a function of the state, so every state has exactly one canonical
 * path. The grammar accepts more than it emits: `/t/acme-corp/goals` and
 * `/t/acme-corp/assets` are real links an operator might type or an older build might have
 * written, and {@link parsePath} normalises them onto the canonical place rather than
 * carrying a second spelling of it through the union. That is what makes
 * `parsePath(pathOf(p))` equal `p` for every `Place` — the aliases live on the input side
 * only.
 *
 * ## A link is a request, not an assertion
 *
 * {@link parsePath} is total. There is no parse error, no thrown `URIError`, no `undefined`
 * return: every string names *somewhere*, and a string that names nothing valid lands on
 * the nearest place that is — the target's own landing page for an unknown section, the
 * target list for an unknown root. A bookmark is a year-old guess about a URL scheme, and
 * the honest answer to a bad guess is the closest real page, not a stack trace.
 *
 * Whether the *resource* a well-formed path names still exists is a different question,
 * answered later by the `App` methods {@link applyPlace} calls (design D5). This module
 * only decides what a string means.
 */
import type { App, EstateFilter } from "./app.svelte";

/**
 * The sections that are nothing but a section.
 *
 * Every nav id from `navGroups` except two, plus `settings` — which is a `navItem` value
 * the rail's footer sets and so is addressable like any other, even though it is not a
 * `navGroups` row.
 *
 * `goals` and `assets` are absent **on purpose**: both hold addressable records beneath
 * them, so they have their own cases in {@link Place} and `/t/x/goals` is a spelling of
 * {@link Place} `target` rather than a `section`. Keeping them out of this list is what
 * makes the type say so instead of a comment saying so.
 *
 * `place.test.ts` asserts that every id in `navItems` is covered by this list or by one of
 * those two cases, so a new rail item cannot quietly become unaddressable.
 */
export const PLAIN_SECTIONS = [
  "findings",
  "observations",
  "evidence",
  "workers",
  "blockers",
  "events",
  "agent-sessions",
  "settings",
] as const;

export type PlainSection = (typeof PLAIN_SECTIONS)[number];

/**
 * Where the app is, as the URL is able to say it.
 *
 * One case per row of the design's addressable inventory, with "assets, one tab" and "the
 * estate, filtered" folded into {@link EstatePlace}: the tab is always known, so a place
 * that named no tab would be a state the app never actually holds.
 *
 * The cases are named after the **resource**, not after the path. `estate` and `scope` live
 * under `/t/<id>/assets/...` because that is where the operator finds them, and `attempt`
 * lives under `/t/<id>/attempts/...` because the thing being linked to is the attempt — see
 * {@link ATTEMPTS} for the one place the grammar is not uniform.
 */
export type Place =
  /** Every target. The app's root, and where a link that means nothing lands. */
  | { readonly kind: "targets" }
  /**
   * One target, on the page opening it lands on.
   *
   * `/t/<id>` and not `/t/<id>/goals`, because the design's inventory says a target's own
   * path is the short one; the long one parses to this same place.
   */
  | { readonly kind: "target"; readonly targetId: string }
  | {
      readonly kind: "section";
      readonly targetId: string;
      readonly section: PlainSection;
    }
  | {
      readonly kind: "goal";
      readonly targetId: string;
      readonly goalId: string;
    }
  | EstatePlace
  | { readonly kind: "scope"; readonly targetId: string }
  /** The Auto-load page on one of the importer's sessions: the AI asset chat. */
  | {
      readonly kind: "chat";
      readonly targetId: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: "attempt";
      readonly targetId: string;
      readonly attemptId: string;
    };

/**
 * The Estate tab, with the scope filter it is showing.
 *
 * The filter is part of the place because the operator decided it is (design decision 2),
 * and `"all"` is its absent form: {@link pathOf} writes no query for it, so the default
 * view keeps the short URL and every other value is visible in the address bar.
 */
export interface EstatePlace {
  readonly kind: "estate";
  readonly targetId: string;
  readonly filter: EstateFilter;
}

/** The target prefix. One letter, because it is in every path this app will ever write. */
const TARGET = "t";

/**
 * The second segment that is not a section (design decision 1).
 *
 * An attempt transcript is `/t/<id>/attempts/<attemptId>`: the resource is named, not the
 * rail it is reached through. The consequence is that this one second segment is a resource
 * collection where every other is a nav id, and that replaying such a path has to set
 * `navItem` to `workers` itself, because the path never says so. One documented exception
 * is the price of a path that does not misname what it points at.
 */
const ATTEMPTS = "attempts";

/** The query parameter the estate's scope filter travels in. */
const FILTER_PARAM = "filter";

const ESTATE_FILTERS: readonly EstateFilter[] = [
  "all",
  "in",
  "out",
  "uncovered",
];

/** The filter a path with no usable `?filter` means: the whole estate. */
const DEFAULT_FILTER: EstateFilter = "all";

const TARGETS: Place = { kind: "targets" };

/**
 * Reads the place out of the state.
 *
 * Only ever reads. The URL follows the state and never the other way about, which is the
 * discipline the route keeps — `routes/[...place]/+page.svelte`, where this function is
 * what the address bar is written from — and the reason it gives: two writers for one fact
 * race each other on every click.
 *
 * Connect, the target rail and the New target page are all the target list here. Connect is
 * a gate rather than a place — it is what is shown while the app does not yet know whether
 * it is signed in — and a half-filled form is view state by design D1. Neither is something
 * to bookmark, so neither gets a path of its own, and `placeOf(new App())` is the root.
 */
export const placeOf = (app: App): Place => {
  if (app.screen !== "target") return TARGETS;
  const targetId = app.viewTargetId;
  // `viewTargetId` rather than `selectedId`: it is the target whose data is on screen, and
  // `openTarget` is the only place it moves. Empty means nothing is open yet, which is the
  // list however the screen got here.
  if (targetId === "") return TARGETS;

  if (app.navItem === "goals") {
    return app.openGoalId === ""
      ? { kind: "target", targetId }
      : { kind: "goal", targetId, goalId: app.openGoalId };
  }

  if (app.navItem === "assets") {
    const sessionId = chatSessionOf(app);
    if (sessionId !== "") return { kind: "chat", targetId, sessionId };
    return app.assetsTab === "scope"
      ? { kind: "scope", targetId }
      : { kind: "estate", targetId, filter: app.estateFilter };
  }

  /*
   * A transcript is the one resource whose place is not implied by its section, so it is
   * read off the pair the design's decision 1 names: the rail on Workers, and an attempt
   * being read.
   *
   * **Today nothing in the app reaches this**, and that is worth knowing rather than
   * discovering in a later slice. `TranscriptPanel` renders on the *Goals* section — see
   * `Target.svelte` — and only for `readableAttemptId`, the one attempt this tab started
   * here, "the only handle a browser has on a settled attempt until Flow B lists them".
   * So a transcript read by clicking still shows the target's path until Workers lists
   * attempts. {@link applyPlace} does reach it, which is what makes a link work in the
   * direction the operator asked for.
   *
   * `transcriptAttemptId` is also never cleared except by `reset()`, so leaving Workers
   * and coming back would name the last attempt read. Harmless while nothing on Workers
   * can read one; whichever slice puts the attempt list there owns closing it, and the
   * narrow condition here is what keeps the staleness inside that one section.
   */
  if (app.navItem === "workers" && app.transcriptAttemptId !== "") {
    return { kind: "attempt", targetId, attemptId: app.transcriptAttemptId };
  }

  const section = PLAIN_SECTIONS.find((known) => known === app.navItem);
  // A `navItem` this grammar does not know is the target's landing page rather than a
  // guess: better a link that lands one level out than a path that cannot be read back.
  return section === undefined
    ? { kind: "target", targetId }
    : { kind: "section", targetId, section };
};

/**
 * The session id the Auto-load page is addressable by, or `""`.
 *
 * Only a session the **server lists** has one. The empty session the page opens with is
 * minted here and known to nothing else, so there is no id a link could carry and nothing
 * for one to restore; a path naming it would be a promise this app cannot keep. In that
 * state the place is the Assets page the Auto-load sub-page sits on, which is where a
 * reload or a Back honestly lands.
 */
const chatSessionOf = (app: App): string => {
  if (!app.importerOpen) return "";
  const current = app.importer.current;
  return current?.indexed === true ? current.id : "";
};

/**
 * Formats a place as a path, with a query string where the place has one.
 *
 * Every id is percent-encoded segment by segment, because an id is server data and nothing
 * promises it holds no slash. The section names are closed sets of plain words and are
 * written as they are.
 */
export const pathOf = (place: Place): string => {
  if (place.kind === "targets") return "/";
  const target = `/${TARGET}/${segment(place.targetId)}`;
  switch (place.kind) {
    case "target":
      return target;
    case "section":
      return `${target}/${place.section}`;
    case "goal":
      return `${target}/goals/${segment(place.goalId)}`;
    case "estate":
      // The default view keeps the short URL: see {@link EstatePlace}.
      return place.filter === DEFAULT_FILTER
        ? `${target}/assets/estate`
        : `${target}/assets/estate?${FILTER_PARAM}=${place.filter}`;
    case "scope":
      return `${target}/assets/scope`;
    case "chat":
      return `${target}/assets/chat/${segment(place.sessionId)}`;
    case "attempt":
      return `${target}/${ATTEMPTS}/${segment(place.attemptId)}`;
  }
};

/**
 * Reads a path as a place. Total: it has no failure mode and never throws.
 *
 * Takes what `location.pathname + location.search` gives, and tolerates more than that: a
 * fragment, a missing leading slash, a trailing one, doubled separators, an empty string.
 * Anything it cannot place lands on the nearest place that exists, and "nearest" means one
 * level out rather than the root — an unknown section on a known target is still that
 * target, and the operator asked about the target.
 */
export const parsePath = (path: string): Place => {
  const [beforeHash = ""] = path.split("#");
  const [pathname = "", query = ""] = beforeHash.split("?");
  // Empty segments dropped, which is every variant of too many slashes at once.
  const parts = pathname
    .split("/")
    .filter((part) => part !== "")
    .map(decodeSegment);

  if (parts[0] !== TARGET) return TARGETS;
  const targetId = parts[1] ?? "";
  if (targetId === "") return TARGETS;
  const second = parts[2];
  if (second === undefined) return { kind: "target", targetId };
  const third = parts[3] ?? "";

  if (second === "goals") {
    return third === ""
      ? { kind: "target", targetId }
      : { kind: "goal", targetId, goalId: third };
  }

  if (second === "assets") {
    if (third === "scope") return { kind: "scope", targetId };
    if (third === "chat") {
      const sessionId = parts[4] ?? "";
      // A chat with no session named is the page it is a sub-page of, not an empty chat:
      // there is no conversation to open and the Assets page is what the link was near.
      if (sessionId !== "") return { kind: "chat", targetId, sessionId };
    }
    // Everything else under `assets` is the page on the tab it opens on: no tab named, a
    // tab this app does not have, a chat with no session. A tab is not a resource that
    // can be missing, so there is nothing here to report as gone.
    return { kind: "estate", targetId, filter: filterOf(query) };
  }

  if (second === ATTEMPTS) {
    // The collection has no page of its own: the attempts of a target are the Workers
    // section, which is also where replaying a transcript puts the rail.
    return third === ""
      ? { kind: "section", targetId, section: "workers" }
      : { kind: "attempt", targetId, attemptId: third };
  }

  const section = PLAIN_SECTIONS.find((known) => known === second);
  return section === undefined
    ? { kind: "target", targetId }
    : { kind: "section", targetId, section };
};

/**
 * The scope filter a query string asks for, or the default.
 *
 * Absent, misspelled, repeated or impossible all mean the same thing — the whole estate —
 * because a query parameter is how you were looking at a page and not which page it is. A
 * link that gets it wrong should still land.
 */
const filterOf = (query: string): EstateFilter => {
  const asked = new URLSearchParams(query).get(FILTER_PARAM);
  return ESTATE_FILTERS.find((known) => known === asked) ?? DEFAULT_FILTER;
};

const segment = (value: string): string => encodeURIComponent(value);

/**
 * One path segment, decoded, or the segment as written if it cannot be.
 *
 * `decodeURIComponent` throws `URIError` on a stray `%` — `/t/100%` is a URL a human can
 * type and a link rot can produce — and this module has no failure mode to put that in. The
 * raw text is the best remaining guess at what was meant, and it will simply name no target
 * the server holds, which is design D5's problem rather than a parse error.
 */
const decodeSegment = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * Puts the app in a place, by calling the methods that go there.
 *
 * Nothing new is written here: `App` is already shaped for this, because every way into a
 * resource is a method that takes an id and reads everything from it — down to the one that
 * re-reads the importer's index before it can select a session by id. This only calls them,
 * and the order is the hierarchy — outermost first — because `openTarget` resets `navItem`
 * to `goals` and would undo a section set before it.
 *
 * **It is a transition from anywhere, not just from a cold start**, which is what history
 * navigation will need of it: each case sets everything its place implies rather than
 * trusting what the last place left behind. The one thing it does not redo is entering a
 * target it is already in — `openTarget` reopens the database, re-reads the counts and
 * reconnects the live feed, and pressing Back between two sections of one target is not a
 * reason to do any of that.
 *
 * Fire-and-forget, like the methods it calls: the screen arrives first and the reads land
 * behind it.
 */
export const applyPlace = (app: App, place: Place): void => {
  if (place.kind === "targets") {
    app.toAllTargets();
    return;
  }

  const { targetId } = place;
  if (app.screen !== "target" || app.viewTargetId !== targetId) {
    app.openTarget(targetId);
  }

  switch (place.kind) {
    case "target":
      // `openTarget` has already landed on Goals, but this is also the way *back* to the
      // goal list from a goal that is open, and `toSection` is what closes one.
      app.toSection("goals");
      return;
    case "section":
      app.toSection(place.section);
      return;
    case "goal":
      app.toSection("goals");
      app.openGoal(place.goalId);
      return;
    case "estate":
      app.toSection("assets");
      app.toAssetsTab("estate");
      // Assigned, because there is no setter and the Estate tab's own filter buttons
      // assign it too. `openTarget` resets it; arriving from another place on the same
      // target does not, so a place that means "the whole estate" has to say so.
      app.estateFilter = place.filter;
      return;
    case "scope":
      app.toSection("assets");
      app.toAssetsTab("scope");
      return;
    case "chat":
      /*
       * `openImporterSession` rather than `toSection("assets")` and `openImporter`, which
       * is the pair the hierarchy suggests and which does not work: `openImporter` selects
       * a session only if the importer's own index already holds it, and on a cold load
       * that index has not been read yet — so the id would be dropped and the page would
       * open on its empty session. This method is the one that reads the index first,
       * re-checks, and goes to Assets itself.
       *
       * It is the method this slice was written for. Its own comment calls it "a stopgap:
       * see `AgentSessions.svelte` on the deep link this stands in for", and that file says
       * the destination of a row is a deep link this build cannot make. This is the link.
       *
       * It reads `viewTargetId`, which `openTarget` above has already set, so the order
       * still holds. Fire-and-forget like the rest: the page arrives and the conversation
       * follows the read.
       *
       * A session the index no longer lists leaves the operator on the target with
       * `agentSessionsNote` set. The behaviour is right and the surface is not: that note
       * belongs to the Agent sessions list, and a link that outlived its session deserves
       * design D5's own sentence on the page it lands on. S5 owns moving it.
       */
      void app.openImporterSession(place.sessionId);
      return;
    case "attempt":
      // The rail goes to Workers, which the path does not say — decision 1's consequence.
      app.toSection("workers");
      void app.loadTranscript(targetId, place.attemptId);
      return;
  }
};
