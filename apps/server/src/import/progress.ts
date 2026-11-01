/**
 * What one scope import has done so far, in this process's memory.
 *
 * ## This is the whole of D16's implementation, and the shape is the argument
 *
 * The "Loading the scope" panel lists the importer's MCP tool calls and nothing else. The
 * obvious way to build that would have been to subscribe to the importer session's
 * narration stream — `AgentHarness.sessionEvents` already yields a
 * `{ _tag: "toolCall" }` detail per call — and filter out `reply` and `thinking`.
 *
 * **This does not do that, and the difference is not stylistic.** The calls below are
 * recorded by the importer's own toolkit, at the moment each one crosses our MCP boundary
 * and after the write it describes has landed. Nothing in this process subscribes to the
 * importer's narration at all. Three things follow, and the first is the one that matters:
 *
 * - **Narration cannot be rendered, because it is never captured.** A filter is a line of
 *   code somebody can relax; not reading the stream is a thing somebody would have to go
 *   and build. D16's "no narration, no reasoning" is therefore a property of the wiring.
 * - **A recorded call is a write that happened.** The toolkit records *after* the store
 *   returns, so the panel cannot show an entry that was refused, and an operator reading
 *   it as a receipt is reading it correctly. A narration-derived panel would show the call
 *   the model attempted, which is a different and much weaker claim.
 * - **It costs nothing extra.** The calls are already crossing this boundary. Nothing is
 *   captured, streamed or stored to render the panel, which is what D16 promises.
 *
 * The harness's own page fetches do not appear here, per D13: they are not our tool calls,
 * and nothing we own observes them.
 *
 * **The one thing the model says that does reach a screen is {@link Entry.detail}**, and
 * it is not an exception to the above. `import/scopeImporter.ts` reads the session's last
 * message *after* it has settled and settles the import with it, so an import that wrote
 * nothing can say why it wrote nothing. That is one status line, written once, by the same
 * `settle` call that records the status — not a stream, not the call list, and nothing this
 * registry subscribes to.
 *
 * ## In memory, for the life of the process, and deliberately
 *
 * An import is not a row. What it *writes* is rows — `scope_entries` and `asset_imports`,
 * both durable, both reviewable on the Assets screen forever. This registry holds only the
 * receipt for a write that has already landed, so a restart forgetting it loses nothing an
 * operator cannot recover by looking at the entries themselves. `ScopeImportNotFound` says
 * the same thing to a browser that reloads onto a forgotten import.
 *
 * Bounded by {@link KEPT}: the newest imports, by start order. An import is one target
 * creation, so the natural bound is how many targets an operator makes in one session, and
 * this is comfortably above it.
 */
import {
  scopeImportLinkIndex,
  scopeImportLinks,
  type ScopeImportCall,
  type ScopeImportStatus,
  type ScopeImportTool,
  type ScopeImportView,
} from "@bit/contracts";
import { Clock, Context, Effect, Layer } from "effect";

/**
 * How many imports this process remembers.
 *
 * Evicted oldest-first by start order, not by finish: an import that is still running is
 * never evicted, because the panel watching it would lose the thing it is watching. In
 * practice an operator has one import in flight at a time — the create-target screen is
 * where they start.
 */
export const KEPT = 32;

/** One import's mutable state. The view is derived from it on every read. */
interface Entry {
  readonly importId: string;
  readonly targetId: string;
  readonly urls: readonly string[];
  readonly harnessInstanceId: string;
  readonly model: string;
  readonly startedAt: number;
  status: ScopeImportStatus;
  detail: string | null;
  finishedAt: number | null;
  readonly calls: ScopeImportCall[];
}

/**
 * Whether an import has been asked to stop.
 *
 * Read by the supervisor's own loop and set by the browser's stop route, because the two
 * are different fibers and the stop has to reach a session the route does not hold.
 */
export interface ScopeImportStopped {
  readonly stopped: boolean;
}

const viewOf = (entry: Entry): ScopeImportView => {
  const running = entry.status === "running";
  // Totals over **every** call, including one naming a page the operator did not paste.
  // `scopeImportLinks` cannot attribute such a call to a row, and the contract says so;
  // counting it here anyway is the honest version, because it is a write that landed.
  let entriesIn = 0;
  let entriesOut = 0;
  let assets = 0;
  for (const call of entry.calls) {
    if (call.tool === "record_imported_asset") assets += 1;
    else if (call.tool === "add_scope_entry") {
      if (call.wrote.startsWith("out")) entriesOut += 1;
      else entriesIn += 1;
    }
  }
  return {
    importId: entry.importId,
    targetId: entry.targetId,
    status: entry.status,
    detail: entry.detail,
    harnessInstanceId: entry.harnessInstanceId,
    model: entry.model,
    links: scopeImportLinks({
      urls: entry.urls,
      calls: entry.calls,
      running,
    }),
    calls: [...entry.calls],
    totals: { entriesIn, entriesOut, assets },
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  };
};

export class ScopeImportProgress extends Context.Service<
  ScopeImportProgress,
  {
    /**
     * Registers an import that is about to start.
     *
     * Called before the session exists, so the panel has something to render from the
     * first poll — a target whose links are all `waiting` is the honest first frame, and
     * a `404` for the first second after creation is not.
     */
    readonly open: (input: {
      readonly importId: string;
      readonly targetId: string;
      readonly urls: readonly string[];
      readonly harnessInstanceId: string;
      readonly model: string;
    }) => Effect.Effect<void>;
    /**
     * Records one call the importer made, after its write landed.
     *
     * Called by the importer's toolkit and by nothing else. It is deliberately not able to
     * record a *refused* call: the handler only reaches this on the success path, so the
     * panel is a list of writes rather than a list of attempts.
     */
    readonly record: (input: {
      readonly importId: string;
      readonly tool: ScopeImportTool;
      readonly wrote: string;
      readonly sourceUrl: string | null;
    }) => Effect.Effect<void>;
    /**
     * Settles an import, once.
     *
     * Idempotent in the only direction that matters: a `stopped` import that the session
     * then finishes normally stays `stopped`, because the operator's decision is the more
     * informative fact and arrived first. Otherwise a second settle is ignored.
     */
    readonly settle: (input: {
      readonly importId: string;
      readonly status: Exclude<ScopeImportStatus, "running">;
      readonly detail: string | null;
    }) => Effect.Effect<void>;
    /**
     * Which of this import's own links a call's `source_url` names, in the operator's
     * spelling, or `undefined`.
     *
     * **This is what makes an entry's attribution a handler's fact rather than the
     * model's.** `source_url` is a tool argument, so left unchecked it is the model's
     * choice of which page to blame an entry on — and a program page is untrusted input
     * whose payoff is exactly that: an entry attributed to a page the operator trusts.
     * The importer's toolkit resolves the argument through here and refuses anything this
     * import was not pointed at, then stores **this** string rather than the one it was
     * sent.
     *
     * Matched by `scopeImportLinkIndex`, which normalises both sides: the importer retypes
     * the URL, and a trailing slash or a redirect's scheme is not an attack. `undefined`
     * means either an import this process does not know or a page it was never given, and
     * the caller refuses both — the distinction is not one a refusal needs to make.
     */
    readonly pageOf: (
      importId: string,
      sourceUrl: string,
    ) => Effect.Effect<string | undefined>;
    /** The links an import was given, or `undefined` for one this process forgot. */
    readonly linksOf: (
      importId: string,
    ) => Effect.Effect<readonly string[] | undefined>;
    /** One import as the panel reads it, or `undefined` if this process forgot it. */
    readonly view: (
      importId: string,
    ) => Effect.Effect<ScopeImportView | undefined>;
    /**
     * Marks an import stopped and reports what it looked like at that moment.
     *
     * `undefined` when unknown. Settling here rather than waiting for the session to
     * notice is what makes the stop answer immediately with the receipt for what landed,
     * which is the thing the operator pressed the button to find out.
     */
    readonly stop: (
      importId: string,
      detail: string,
    ) => Effect.Effect<ScopeImportView | undefined>;
    /** Whether an import has been asked to stop. Read by the importer's own fiber. */
    readonly stopped: (importId: string) => Effect.Effect<boolean>;
  }
>()("bit/import/ScopeImportProgress") {
  static readonly layer = Layer.sync(ScopeImportProgress, () => {
    // Insertion-ordered, which is start order, which is what eviction walks.
    const entries = new Map<string, Entry>();

    const evict = (): void => {
      if (entries.size <= KEPT) return;
      for (const [id, entry] of entries) {
        if (entries.size <= KEPT) return;
        // A running import is never evicted: the panel watching it would lose its subject
        // mid-read, and the one thing this registry exists for is that panel.
        if (entry.status === "running") continue;
        entries.delete(id);
      }
    };

    return ScopeImportProgress.of({
      open: (input) =>
        Effect.map(Clock.currentTimeMillis, (startedAt) => {
          entries.set(input.importId, {
            importId: input.importId,
            targetId: input.targetId,
            urls: [...input.urls],
            harnessInstanceId: input.harnessInstanceId,
            model: input.model,
            startedAt,
            status: "running",
            detail: null,
            finishedAt: null,
            calls: [],
          });
          evict();
        }),

      record: (input) =>
        Effect.map(Clock.currentTimeMillis, (at) => {
          const entry = entries.get(input.importId);
          // An unknown import is dropped rather than created. The only way to reach this
          // is a credential for an import this process has forgotten, which a restart
          // makes impossible anyway — the grant lived in memory too.
          if (entry === undefined) return;
          entry.calls.push({
            sequence: entry.calls.length + 1,
            tool: input.tool,
            wrote: input.wrote,
            sourceUrl: input.sourceUrl,
            at,
          });
        }),

      settle: (input) =>
        Effect.map(Clock.currentTimeMillis, (finishedAt) => {
          const entry = entries.get(input.importId);
          if (entry === undefined) return;
          if (entry.status !== "running") return;
          entry.status = input.status;
          entry.detail = input.detail;
          entry.finishedAt = finishedAt;
          evict();
        }),

      pageOf: (importId, sourceUrl) =>
        Effect.sync(() => {
          const entry = entries.get(importId);
          if (entry === undefined) return undefined;
          const at = scopeImportLinkIndex(entry.urls, sourceUrl);
          return at === -1 ? undefined : entry.urls[at];
        }),

      linksOf: (importId) =>
        Effect.sync(() => {
          const entry = entries.get(importId);
          return entry === undefined ? undefined : entry.urls;
        }),

      view: (importId) =>
        Effect.sync(() => {
          const entry = entries.get(importId);
          return entry === undefined ? undefined : viewOf(entry);
        }),

      stop: (importId, detail) =>
        Effect.map(Clock.currentTimeMillis, (finishedAt) => {
          const entry = entries.get(importId);
          if (entry === undefined) return undefined;
          if (entry.status === "running") {
            entry.status = "stopped";
            entry.detail = detail;
            entry.finishedAt = finishedAt;
          }
          return viewOf(entry);
        }),

      stopped: (importId) =>
        Effect.sync(() => entries.get(importId)?.status === "stopped"),
    });
  });

  /**
   * A registry nothing writes to, for a server with no harness.
   *
   * Reads answer `undefined`, which the browser route turns into `ScopeImportNotFound` —
   * the same answer a forgotten import gets, which is the right one: there is no import.
   */
  static readonly none: Layer.Layer<ScopeImportProgress> = Layer.sync(
    ScopeImportProgress,
    () =>
      ScopeImportProgress.of({
        open: () => Effect.void,
        record: () => Effect.void,
        settle: () => Effect.void,
        // No import exists, so no page belongs to one. The toolkit refuses on this, which
        // is correct on a server where no import can have been started.
        pageOf: () => Effect.succeed(undefined),
        linksOf: () => Effect.succeed(undefined),
        view: () => Effect.succeed(undefined),
        stop: () => Effect.succeed(undefined),
        stopped: () => Effect.succeed(false),
      }),
  );
}
