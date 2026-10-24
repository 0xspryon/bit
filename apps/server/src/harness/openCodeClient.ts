/**
 * A typed client over the OpenCode 2 HTTP API.
 *
 * Built on Effect's own `HttpClient` (`effect/http`), not on bare `fetch`. That is
 * what makes two properties true rather than aspirational:
 *
 * - **Cancellation reaches the socket.** `FetchHttpClient` passes the fiber's
 *   `AbortSignal` into `fetch`, so interrupting a client fiber — or letting a timeout
 *   interrupt it — aborts the in-flight request. The previous `Effect.promise(() =>
 *   fetch(...))` ignored the signal entirely: the fiber moved on and the request kept
 *   running. Cancelling *our* request still says nothing about whether the harness
 *   stopped working; see {@link waitForIdle}.
 * - **The typed boundary is real.** Every response body is decoded through an Effect
 *   Schema. A 2xx answer in an unexpected shape is a typed {@link HarnessDecodeError},
 *   not a cast that lies about what we have and dies somewhere downstream.
 *
 * **Routes and payload shapes are the generated client's, not ours.**
 * `@opencode/client/effect` is the Effect client OpenCode publishes from the same
 * source as the server, and it is what T3Code uses
 * (`packages/provider-opencode/src/server/v2/OpenCode2Client.ts:1-15`). The six routes
 * this service needs were previously hand-written against the binary's OpenAPI
 * document, with a narrow schema per response; they are now `api.session.create`,
 * `api.session.prompt`, `api.session.wait`, `api.session.get`, `api.message.list` and
 * `api.mcp.add`. Pinning a URL or re-deriving a response shape is no longer our job, so
 * it can no longer drift from the server we are talking to.
 *
 * What stays ours is everything above the wire, and it is the reason this is a service
 * rather than a re-export:
 *
 * - **The authenticated, bounded transport.** We build the `HttpClient` the generated
 *   client runs on, so the Basic credential, the base URL and the per-operation
 *   timeouts below apply to every call it makes — including any we have not wrapped.
 * - **Our error taxonomy.** The client's failures are its own tagged errors; `fail`
 *   below collapses them into {@link HarnessTransportError} and
 *   {@link HarnessDecodeError}, keeping "the transport broke" distinct from "the answer
 *   was not the shape we were promised". Callers and tests depend on that distinction.
 * - **The narrow surface.** Six operations with domain-shaped results, not 200 routes.
 *
 * One dependency note, because it cost an afternoon to find: the package declares
 * `effect: "4.0.1"` as an **exact** peer. Without intervention bun installs a second
 * copy of Effect, and Schema internals from two instances interleave and throw
 * (`s.startsWith is not a function` out of `SchemaAST`). The root `package.json`
 * therefore pins `overrides: { effect: "4.0.5" }` so one copy is resolved for the whole
 * workspace. Check that override on any Effect or client upgrade.
 *
 * `POST /api/experimental/mcp/{server}` — now `api.mcp.add` — is how our bearer
 * credential reaches the harness: in a request body, never in the server's argv and
 * never in the environment the agent's own shell commands inherit (DECISIONS.md §6
 * "credentials off argv").
 */
import { OpenCode } from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import { ID as ModelID } from "@opencode/schema/model";
import { ID as ProviderID } from "@opencode/schema/provider";
import { AbsolutePath } from "@opencode/schema/schema";
import { ID as SessionID, type Session } from "@opencode/schema/session";
import {
  Context,
  Effect,
  Layer,
  Redacted,
  Result,
  Schema,
  Stream,
  type Duration,
} from "effect";
import { Filter } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/http";

import { HarnessDecodeError, HarnessTransportError } from "./errors";
import { OpenCodeServer } from "./openCodeServer";

export const TerminalOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "interrupted",
]);
export type TerminalOutcome = typeof TerminalOutcome.Type;

/**
 * The session fields this application reads.
 *
 * Still declared here, and still narrow, because it is a *domain* shape rather than a
 * transport one: the generated client returns the server's whole `Session.Info`, and
 * everything past these three fields is noise a caller should not come to depend on.
 * Nothing is decoded from JSON any more — these are read off an already-decoded value.
 */
export interface SessionStatus {
  readonly outcome?: TerminalOutcome | undefined;
  readonly cost?: number | undefined;
  readonly tokens?: Record<string, unknown> | undefined;
}

export interface SessionRef {
  readonly id: string;
}

export interface MessageEntry {
  readonly type: string;
  readonly text: string;
  readonly error: string | undefined;
}

/**
 * One narrated moment of a session, reduced to what this application reads.
 *
 * **Deliberately four fields and no content.** A transcript needs the text of a reply,
 * the arguments of a tool call and a shape to render them in; choosing that shape is the
 * next slice's work, and a field invented here would be the format that slice inherits
 * without having decided it. So this carries the harness's own event `type` verbatim, its
 * own cursor, when it happened, and the one thing a supervisor has to act on.
 *
 * `type` is a plain `string` rather than a union of the ~50 entry kinds the client
 * declares. Which kinds exist is the harness's business and the set grows with its
 * releases; a union here would make an upgrade a compile error in a module that only
 * forwards the value.
 *
 * `outcome` is the exception, and it is the whole reason this is not an opaque blob:
 * `session.execution.succeeded`, `.failed` and `.interrupted` are the harness stating a
 * terminal outcome, which is a *definite answer* and must be told apart from the stream
 * merely ending. It is `undefined` on every other entry.
 */
export interface HarnessNarration {
  /** The harness's own event type, unmapped. */
  readonly type: string;
  /** `durable.seq`: the harness's cursor, for resuming a log without replaying it. */
  readonly sequence: number | undefined;
  /** When the harness recorded it, in epoch milliseconds. */
  readonly at: number;
  /** Set only by a terminal `session.execution.*` entry. Never inferred. */
  readonly outcome: TerminalOutcome | undefined;
}

/**
 * The three log entries that state an outcome, mapped to this application's vocabulary.
 *
 * A table rather than string surgery on the entry type, so adding a fourth is a change
 * here and a `session.execution.something_else` we have not met stays `undefined` — which
 * is the honest answer, and leaves the consumer reconciling against the harness's own
 * session state instead of guessing from a name.
 */
const EXECUTION_OUTCOMES: Readonly<Record<string, TerminalOutcome>> = {
  "session.execution.succeeded": "succeeded",
  "session.execution.failed": "failed",
  "session.execution.interrupted": "interrupted",
};

/**
 * The session an event belongs to, or `undefined` if it names none.
 *
 * Two fields are read because the harness provides both and they agree: every `session.*`
 * event in `@opencode/schema`'s manifest carries `data.sessionID`, and every event carries
 * `durable.aggregateID`, which for a session event is that same id. Reading the first and
 * falling back to the second costs nothing and means a build that stops populating one of
 * them is a dropped event rather than a misattributed one.
 *
 * `undefined` is returned rather than a guess for anything that names no session — the
 * stream also carries `server.connected`, `provider.updated`, `mcp.status.changed` and a
 * dozen other process-wide events, none of which belong to anybody's run.
 */
const sessionOf = (event: unknown): string | undefined => {
  const record = (event ?? {}) as {
    data?: { sessionID?: unknown } | undefined;
    durable?: { aggregateID?: unknown } | undefined;
  };
  const fromData = record.data?.sessionID;
  if (typeof fromData === "string") return fromData;
  const fromDurable = record.durable?.aggregateID;
  return typeof fromDurable === "string" ? fromDurable : undefined;
};

/**
 * Reduces one log entry to {@link HarnessNarration}.
 *
 * Reads defensively off an already-decoded value, for the same reason {@link flatten}
 * does: the entry union is wide and version-specific, and re-asserting a shape the
 * generated client has already validated would only add a second place for it to be
 * wrong.
 */
const narrate = (entry: unknown): HarnessNarration => {
  const record = (entry ?? {}) as {
    type?: unknown;
    created?: unknown;
    durable?: { seq?: unknown } | undefined;
  };
  const type = typeof record.type === "string" ? record.type : "unknown";
  const sequence = record.durable?.seq;
  return {
    type,
    sequence: typeof sequence === "number" ? sequence : undefined,
    at: typeof record.created === "number" ? record.created : 0,
    outcome: EXECUTION_OUTCOMES[type],
  };
};

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
}

/**
 * Reduces one inbox entry to the three fields a caller uses.
 *
 * The entry union is wide and version-specific, so this reads defensively off an
 * already-decoded value rather than re-asserting a shape the client has validated.
 * `text` falls back to concatenating the entry's text parts, which is where an
 * assistant's reply actually lives.
 */
const flatten = (entry: unknown): MessageEntry => {
  const record = (entry ?? {}) as {
    type?: unknown;
    text?: unknown;
    error?: { message?: unknown } | undefined;
    content?: ReadonlyArray<{ type?: unknown; text?: unknown }> | undefined;
  };
  const parts = Array.isArray(record.content) ? record.content : [];
  return {
    type: typeof record.type === "string" ? record.type : "unknown",
    text:
      typeof record.text === "string"
        ? record.text
        : parts
            .filter((part) => part.type === "text")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("\n"),
    error:
      typeof record.error?.message === "string"
        ? record.error.message
        : undefined,
  };
};

/**
 * Per-operation request bounds.
 *
 * These bound *our* transport, nothing else. `wait` is deliberately absent from the
 * defaults as a deadline on the worker: settlement is the harness's to decide
 * (DECISIONS.md §5 "no deadline-triggered worker settlement"). It carries a generous
 * ceiling only so a dead socket cannot wedge the process forever, and exceeding it is
 * reported as an *uncertain* outcome rather than a failed one.
 */
export interface ClientTimeouts {
  /** Short control-plane calls: create, prompt, status, messages, mcp registration. */
  readonly control: Duration.Input;
  /** The long poll that blocks until a session settles. */
  readonly wait: Duration.Input;
}

export const DEFAULT_TIMEOUTS: ClientTimeouts = {
  control: "30 seconds",
  wait: "30 minutes",
};

export class OpenCodeClient extends Context.Service<
  OpenCodeClient,
  {
    readonly registerMcpServer: (
      name: string,
      config: {
        readonly url: string;
        readonly headers: Readonly<Record<string, Redacted.Redacted<string>>>;
        readonly directory: string;
      },
    ) => Effect.Effect<void, HarnessTransportError | HarnessDecodeError>;
    /**
     * Opens a session, optionally inside an existing session's lineage.
     *
     * `parentSessionId` exists for provider prompt caching and nothing else. OpenCode
     * derives one cache key per lineage — `parentID ?? fork.sessionID ?? id`
     * (`core/src/session/affinity.ts`), sent as `prompt_cache_key` and as the
     * `x-session-affinity` header (`core/src/session/model-request.ts`) — so sessions
     * that name the same parent are routed to the same cached prefix, and separately
     * created top-level sessions never are, however identical their prompts.
     *
     * A child is **not** a fork: only the fork path copies messages across
     * (`core/src/session/projector.ts`), so the new session starts empty and a briefing
     * remains the only thing in it. What a parent does change is crash recovery —
     * OpenCode resumes only parentless sessions (`SessionStore.listSuspended`) and
     * merely releases a child's claim — which is why this is passed for planner rounds,
     * whose state is the graph, and not for worker sessions, whose interruption is
     * reconciled by us and should stay resumable by the harness.
     */
    readonly createSession: (input: {
      readonly title: string;
      readonly model: ModelRef;
      readonly directory: string;
      readonly parentSessionId?: string | undefined;
      /**
       * The id to create the session under, instead of one the harness picks.
       *
       * This closes a real window. Opening a worker session is `seedAttempt({
       * harnessSessionId: null })` → `createSession` → `bindSessionToAttempt`, and a
       * process that dies between the second and third steps leaves a live harness
       * session that no attempt row points at: recovery sweeps attempts, so it never
       * looks at it, and nothing else knows it exists. Minting the id first and writing
       * it with the seed means the row names the session *before* the session exists —
       * the worst case becomes a recorded id for a session that was never created, which
       * recovery already handles (it asks the harness, is told `missing`, and records
       * `uncertain`).
       *
       * **Verified, not assumed.** `SessionCreateInput.id` is `Session.ID | undefined` in
       * `@opencode/client@2.1.0`, and the harness returning the id it was handed was
       * checked against a live `opencode serve` rather than inferred from the type.
       * `@opencode/schema`'s `Session.ID` is `isStartingWith("ses")` plus a brand, with
       * `ID.create()` minting one; {@link newHarnessSessionId} is where this application
       * calls it, so the format stays the harness's to define.
       */
      readonly sessionId?: string | undefined;
    }) => Effect.Effect<SessionRef, HarnessTransportError | HarnessDecodeError>;
    readonly prompt: (
      sessionId: string,
      text: string,
    ) => Effect.Effect<void, HarnessTransportError | HarnessDecodeError>;
    readonly waitForIdle: (
      sessionId: string,
    ) => Effect.Effect<void, HarnessTransportError | HarnessDecodeError>;
    readonly sessionStatus: (
      sessionId: string,
    ) => Effect.Effect<
      SessionStatus,
      HarnessTransportError | HarnessDecodeError
    >;
    readonly messages: (
      sessionId: string,
    ) => Effect.Effect<
      readonly MessageEntry[],
      HarnessTransportError | HarnessDecodeError
    >;
    /**
     * Asks the harness to stop whatever the session is doing.
     *
     * Reports whether the harness says it interrupted something: `false` for a session
     * that was already idle, which is not a failure and is worth being able to tell
     * apart. `resume` is deliberately not exposed — nothing in this application resumes
     * a session, because carrying work on after an interruption means a new attempt
     * identity (DECISIONS.md §15, and `store.openReplacementAttempt`).
     */
    readonly interruptSession: (
      sessionId: string,
    ) => Effect.Effect<boolean, HarnessTransportError | HarnessDecodeError>;
    /**
     * The harness's event stream, filtered to one session.
     *
     * ## Why `event.subscribe()` and not `session.log`
     *
     * The brief for this slice expected the opposite, and the harness settled it. Both
     * calls exist on the generated client; `session.log({ sessionID, follow: true })` is
     * per session by construction and replays a durable log, which on paper makes it the
     * unambiguous choice. Against a live `opencode` 2.1.2 it carries **no narration at
     * all**: a session that was prompted, ran, replied and settled `succeeded` produced
     * exactly one entry, `log.synced`, both while following and on a non-following replay
     * afterwards. That build's durable per-session log is simply not where execution is
     * written. Checked on 2026-10-24; the probe is reproducible with two prompts and two
     * subscriptions side by side.
     *
     * `event.subscribe()` carries all of it — `session.execution.started`,
     * `session.inbox.*`, `session.step.*`, `session.text.*`, `session.tool.*`,
     * `session.usage.updated` and the terminal `session.execution.{succeeded,failed,
     * interrupted}`.
     *
     * **And the ambiguity the brief worried about is not there.** It is one stream for the
     * whole server, so events have to be attributed, but the attribution is a single field
     * read at the same position in every event: the manifest gives every `session.*` event
     * `data.sessionID`, and every event also carries `durable.aggregateID`, which for a
     * session event is that same id. Two sessions prompted a moment apart were separated
     * cleanly on both fields. So this reads `data.sessionID` and falls back to
     * `durable.aggregateID`, and an event carrying neither is dropped rather than guessed
     * at — a misattributed entry would publish one target's narration under another's key,
     * which is the one failure worth being strict about.
     *
     * **One subscription per watched session, not one shared and demultiplexed.** N
     * concurrent runs open N streams to a local server, which is a cost worth paying for
     * the lifetime it buys: each belongs to one supervisor fiber, is cancelled at the
     * socket when that fiber is interrupted, and cannot be kept alive by, or taken down
     * by, another run. A shared subscription would be a reference-counted resource whose
     * failure is every supervisor's problem at once.
     *
     * **It is live-only, so it has a startup race `session.log` would not have had.** An
     * event published between prompting and the subscription being established is gone.
     * That is why the supervisor does not take its *settlement* from this stream alone —
     * see `run/supervisor.ts` on why `waitForIdle` is still what says the session is over.
     *
     * **No transport bound.** Every other operation here is wrapped in a timeout; this
     * one deliberately is not, because it is meant to stay open for as long as the session
     * runs, which is unbounded by design (DECISIONS.md §5, "no deadline-triggered worker
     * settlement"). The consuming fiber owns its lifetime instead: interrupting that fiber
     * aborts the request at the socket, because the client is built on `FetchHttpClient`
     * and the fiber's `AbortSignal` reaches `fetch`.
     *
     * **A stream that ends is not an outcome** (DECISIONS.md §15). This one ends whenever
     * the harness restarts or the socket drops — in the probe above, with an `ECONNRESET`
     * at teardown — so a consumer must reconcile against {@link SessionStatus} rather than
     * conclude anything from the end of it. What *is* an outcome is an entry, and
     * {@link HarnessNarration.outcome} carries that and nothing else.
     */
    readonly sessionEvents: (
      sessionId: string,
    ) => Stream.Stream<
      HarnessNarration,
      HarnessTransportError | HarnessDecodeError
    >;
  }
>()("bit/harness/OpenCodeClient") {
  static readonly layer = (timeouts: ClientTimeouts = DEFAULT_TIMEOUTS) =>
    Layer.effect(
      OpenCodeClient,
      Effect.gen(function* () {
        const { server } = yield* OpenCodeServer;

        /**
         * The transport every generated call runs on.
         *
         * The credential is attached here, once, rather than per call: the generated
         * client builds its own requests, so an operation we have not wrapped is
         * authenticated too. `filterStatusOk` is deliberately **not** applied — the
         * client reads non-2xx bodies to produce its own tagged errors, and discarding
         * them here would flatten `UnauthorizedError` and friends into a bare status.
         */
        const http = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.setHeader(
                "authorization",
                Redacted.value(server.authorization),
              ),
              HttpClientRequest.acceptJson,
            ),
          ),
        );

        const api = yield* OpenCode.make({ baseUrl: server.baseUrl }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );

        /**
         * Collapses the client's failures into this application's two.
         *
         * The distinction that has to survive is transport versus shape, because they
         * mean different things to a caller: a transport failure leaves the harness's
         * state *uncertain*, while a decode failure means we are talking to something
         * that does not answer the way this build expects. A `SchemaError` — raised
         * directly or wrapped in the client's `ClientError` — is the second kind;
         * everything else is the first.
         */
        const fail = (operation: string) => (cause: unknown) => {
          // The client wraps a transport or schema failure in its own `ClientError`,
          // so the useful one is a level down. Unwrap exactly one level — more would
          // be guessing at a chain whose shape is not ours.
          const outer = cause as { readonly cause?: unknown };
          const inner = outer.cause ?? cause;
          const status = HttpClientError.isHttpClientError(inner)
            ? inner.response?.status
            : undefined;
          const tag = (inner as { _tag?: string })._tag ?? "error";
          const detail =
            (inner as { message?: string }).message ?? String(inner);

          // Official predicates rather than tag strings: a decode failure is whatever
          // Effect calls a decode failure, in this version and the next.
          return Schema.isSchemaError(inner)
            ? new HarnessDecodeError({
                operation,
                status,
                detail,
                cause,
              })
            : new HarnessTransportError({
                operation,
                status,
                tag,
                detail: `${tag}: ${detail}`,
                cause,
              });
        };

        /** Applies this application's transport bound to one generated call. */
        const bounded = <A>(
          operation: string,
          timeout: Duration.Input,
          effect: Effect.Effect<A, unknown>,
        ): Effect.Effect<A, HarnessTransportError | HarnessDecodeError> =>
          effect.pipe(
            Effect.mapError(fail(operation)),
            Effect.timeout(timeout),
            Effect.catchTag(
              "TimeoutError",
              (cause) =>
                new HarnessTransportError({
                  operation,
                  status: undefined,
                  tag: "TimeoutError",
                  detail:
                    "request exceeded its transport bound and was aborted; " +
                    "this does not mean the harness stopped working",
                  cause,
                }),
            ),
          );

        /**
         * Brands a directory as the absolute path the client's types require.
         *
         * `AbsolutePath` is a branded string, so this is the one place the brand is
         * applied; `decodeUnknownSync` rather than a cast so that whatever validation
         * the brand carries now or later actually runs, and a bad path fails here with
         * the path in the message instead of somewhere inside a request body.
         */
        const directoryOf = (directory: string) =>
          Schema.decodeUnknownSync(AbsolutePath)(directory);

        const registerMcpServer: OpenCodeClient["Service"]["registerMcpServer"] =
          Effect.fn("OpenCodeClient.registerMcpServer")(
            function* (name, config) {
              yield* bounded(
                "mcp.add",
                timeouts.control,
                api.mcp.add({
                  server: name,
                  location: { directory: directoryOf(config.directory) },
                  config: new Mcp.RemoteConfig({
                    type: "remote",
                    url: config.url,
                    // Pinned, not negotiated: our endpoint serves only the stateless
                    // 2026-07-28 revision, and this field's default value would open
                    // with an `initialize` handshake the server does not implement.
                    // "auto" would probe and silently fall back; there is nothing to
                    // fall back to. Typed by the schema, so a typo here is a compile
                    // error rather than a connection failure at run time.
                    protocol: "2026-07-28",
                    // Unwrapped only here, at the one call that delivers it.
                    headers: Object.fromEntries(
                      Object.entries(config.headers).map(([key, value]) => [
                        key,
                        Redacted.value(value),
                      ]),
                    ),
                    timeout: new Mcp.TimeoutConfig({
                      startup: 20_000,
                      catalog: 20_000,
                      execution: 60_000,
                    }),
                  }),
                }),
              );
            },
          );

        const createSession: OpenCodeClient["Service"]["createSession"] =
          Effect.fn("OpenCodeClient.createSession")(function* (input) {
            const session = yield* bounded(
              "session.create",
              timeouts.control,
              api.session.create({
                title: input.title,
                // The client brands these; `ModelRef` is this application's own shape
                // and the ids inside it come from our configuration, so they are
                // branded at the boundary rather than threaded through the codebase.
                model: {
                  providerID: Schema.decodeUnknownSync(ProviderID)(
                    input.model.providerID,
                  ),
                  id: Schema.decodeUnknownSync(ModelID)(input.model.id),
                },
                location: { directory: directoryOf(input.directory) },
                // Spread rather than passed as `undefined` so the call site reads as
                // "no parent" rather than "parent: nothing". On the wire both are the
                // same: the generated client encodes an absent optional as an explicit
                // `null`, which is what the server reads as parentless.
                ...(input.parentSessionId === undefined
                  ? {}
                  : { parentID: input.parentSessionId as Session.ID }),
                ...(input.sessionId === undefined
                  ? {}
                  : { id: input.sessionId as Session.ID }),
              }),
            );
            return { id: session.id };
          });

        const prompt: OpenCodeClient["Service"]["prompt"] = Effect.fn(
          "OpenCodeClient.prompt",
        )(function* (sessionId, text) {
          yield* bounded(
            "session.prompt",
            timeouts.control,
            api.session.prompt({
              sessionID: sessionId as Session.ID,
              text,
            }),
          );
        });

        /**
         * Blocks until the session settles.
         *
         * A failure here means the outcome is **uncertain**, not that execution
         * stopped: the wait call losing its connection, or being interrupted, says
         * nothing about the harness (DECISIONS.md §15 "Recovery"). Callers must
         * reconcile against `sessionStatus` and must never resubmit the prompt.
         */
        const waitForIdle: OpenCodeClient["Service"]["waitForIdle"] = Effect.fn(
          "OpenCodeClient.waitForIdle",
        )(function* (sessionId) {
          yield* bounded(
            "session.wait",
            timeouts.wait,
            api.session.wait({ sessionID: sessionId as Session.ID }),
          );
        });

        const sessionStatus: OpenCodeClient["Service"]["sessionStatus"] =
          Effect.fn("OpenCodeClient.sessionStatus")(function* (sessionId) {
            const session = yield* bounded(
              "session.get",
              timeouts.control,
              api.session.get({ sessionID: sessionId as Session.ID }),
            );
            const outcome = (session as { outcome?: unknown }).outcome;
            return {
              outcome: Schema.is(TerminalOutcome)(outcome)
                ? outcome
                : undefined,
              cost: session.cost,
              tokens: session.tokens as Record<string, unknown> | undefined,
            };
          });

        const messages: OpenCodeClient["Service"]["messages"] = Effect.fn(
          "OpenCodeClient.messages",
        )(function* (sessionId) {
          const listed = yield* bounded(
            "message.list",
            timeouts.control,
            api.message.list({ sessionID: sessionId as Session.ID }),
          );
          return listed.data.map(flatten);
        });

        const interruptSession: OpenCodeClient["Service"]["interruptSession"] =
          Effect.fn("OpenCodeClient.interruptSession")(function* (sessionId) {
            const result = yield* bounded(
              "session.interrupt",
              timeouts.control,
              api.session.interrupt({ sessionID: sessionId as Session.ID }),
            );
            return result.interrupted;
          });

        /**
         * The generated subscription, filtered and reduced.
         *
         * `Stream.mapError` rather than the `bounded` helper the others use: `bounded`
         * applies `Effect.timeout`, which is the one thing a followed stream must not
         * have. The failure mapping is the same `fail` the rest of this service uses, so a
         * consumer sees the same two errors here as everywhere else.
         *
         * `filterMap` rather than `filter` then `map`: an event belonging to another
         * session and an event with no session on it are both dropped by the same step
         * that reads the id, so there is no second place for the two to disagree.
         */
        const sessionEvents: OpenCodeClient["Service"]["sessionEvents"] = (
          sessionId,
        ) =>
          api.event
            .subscribe()
            .pipe(
              Stream.mapError(fail("event.subscribe")),
              Stream.filterMap(
                Filter.make((event: unknown) =>
                  sessionOf(event) === sessionId
                    ? Result.succeed(narrate(event))
                    : Result.fail(event),
                ),
              ),
            );

        return OpenCodeClient.of({
          registerMcpServer,
          createSession,
          prompt,
          waitForIdle,
          sessionStatus,
          messages,
          interruptSession,
          sessionEvents,
        });
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
}

/**
 * A session id this application mints, in the harness's own format.
 *
 * `@opencode/schema`'s `Session.ID.create()` rather than a string of our own: the format
 * is `ses_` plus the harness's descending identifier, the brand's check enforces the
 * prefix, and a value built by hand would be our guess at someone else's id scheme. This
 * is the only place it is called, so if the scheme changes there is one line to follow.
 *
 * Minting an id here is only useful because the harness honours it; see
 * `createSession`'s `sessionId` for the window that closes and how it was verified.
 */
export const newHarnessSessionId = (): string => SessionID.create();

/** The assistant's final text, or an empty string when it produced none. */
export const finalAssistantText = (entries: readonly MessageEntry[]): string =>
  entries.find((entry) => entry.type === "assistant")?.text ?? "";

/** The first error any entry reported, used to explain a `failed` outcome. */
export const firstError = (
  entries: readonly MessageEntry[],
): string | undefined =>
  entries.find((entry) => entry.error !== undefined)?.error;
