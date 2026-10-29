/**
 * The control plane, as the browser sees it.
 *
 * Named `client.ts` rather than `server.ts` because SvelteKit reserves the latter: a
 * module called `server` under `$lib` is treated as server-only and refused to any code
 * that runs in the browser. This is the opposite — it is the browser's half.
 *
 * Nothing in here describes an endpoint. Every path, payload, status code and error
 * member comes from `@bit/contracts`, and the client is *derived* from that declaration
 * by `HttpApiClient.make` — so renaming an endpoint or changing a field breaks this file
 * at compile time instead of at click time. That is the whole reason the API is declared
 * once rather than written as a route table on one side and a `fetch` wrapper on the
 * other.
 *
 * **Three things this module owns, and nothing else does.**
 *
 * 1. **The bearer.** The session token lives here, in one module-level variable, and the
 *    client middleware reads it on every request. Not in Svelte state: a reactive
 *    dependency would make "which token did that request use" depend on when the effect
 *    happened to run, and the answer has to be "whatever is current", always.
 * 2. **`sessionStorage`.** Chosen over `localStorage` deliberately — a session that
 *    outlives the tab is a credential sitting on disk for a tool whose whole point is
 *    handling other people's systems. Closing the tab ends it, and the server's own
 *    registry is in memory too, so restarting the server ends it from the other side.
 * 3. **Classifying a failure.** The one judgement the browser is allowed to make: a
 *    `SessionRefused` is an answer from the server, and *anything else* — a refused
 *    connection, a dev-proxy 502, a body that will not decode — is "no server answered
 *    at this address". The Connect screen renders those against two different fields, and
 *    a client that guessed which one would be attaching a reason to the wrong input.
 *
 * `baseUrl` is the page's own origin by default, because the browser reaches the server
 * same-origin: through the Vite dev server's `/api` proxy in development, and from the
 * server itself in a packaged deployment. The control plane serves no CORS headers on
 * purpose — the only way to add them is `HttpRouter.cors`, which is global and would
 * change what `/api/v1/mcp` and `/api/v1/policy/decide` answer to a cross-origin caller.
 */
import {
  BitApi,
  SessionGuard,
  type LiveFrame,
  type ModelOptionSelection,
  type TargetDraft,
} from "@bit/contracts";
import { Effect, Fiber, Layer, Result, Stream } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";

/** Where the token is parked so a reload can find it. */
const TOKEN_KEY = "bit.session.token";

/** The live bearer. `undefined` means "not signed in". */
let bearer: string | undefined;

/**
 * `sessionStorage` can throw — a private window, blocked site data, an embedded
 * context — so every touch of it is guarded and the app works without it. The cost of
 * losing it is one extra sign-in after a reload, which is not worth a crash.
 */
const readStoredToken = (): string | undefined => {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const writeStoredToken = (token: string | undefined): void => {
  try {
    if (token === undefined) globalThis.sessionStorage?.removeItem(TOKEN_KEY);
    else globalThis.sessionStorage?.setItem(TOKEN_KEY, token);
  } catch {
    /* no storage: the session simply does not survive a reload. */
  }
};

/** The token a reload should try, before anything has been verified. */
const storedToken = (): string | undefined => readStoredToken();

/** Holds a token in memory and in `sessionStorage`. `undefined` signs out. */
const setToken = (token: string | undefined): void => {
  bearer = token;
  writeStoredToken(token);
};

/**
 * The client half of {@link SessionGuard}.
 *
 * Declared `requiredForClient` in the contract, so this is not optional: without it the
 * generated client would not compile. A request made while signed out goes out with no
 * `Authorization` header at all, and the server reports `missing` rather than `unknown` —
 * which is what lets the UI tell a first visit from a stale token.
 */
const guardClient = HttpApiMiddleware.layerClient(
  SessionGuard,
  ({ next, request }) =>
    next(
      bearer === undefined
        ? request
        : HttpClientRequest.bearerToken(request, bearer),
    ),
);

const clientLayer = Layer.mergeAll(guardClient, FetchHttpClient.layer);

const client = (baseUrl: string) =>
  HttpApiClient.make(BitApi, { baseUrl }).pipe(Effect.provide(clientLayer));

/**
 * How a live connection ended.
 *
 * Three cases rather than a string, because the screens have to do three different things
 * and the distinction is not recoverable from prose:
 *
 * - `ended` — the stream finished without an error. On this endpoint that means the server
 *   went away cleanly. Not news, and not a reason to put up an alert.
 * - `unauthenticated` — the session is gone. **This is the one that must not be flattened.**
 *   The server answered the typed `Unauthenticated` the contract declares, and the only
 *   correct response is to sign out as expired: a tab that reported it as "the connection
 *   dropped" would sit on a target list it can no longer refresh, holding a dead token, and
 *   still looking signed in. An earlier version stringified the failure and the app did
 *   exactly that.
 * - `failed` — anything else, with whatever can be said about it. A refused connection, a
 *   dev-proxy 502, a target that stopped being openable, a frame that would not decode.
 *   From the operator's seat those are one situation: what is on screen is what arrived.
 *
 * It is the same judgement {@link Call} makes about a round trip — an answer from the server
 * is not the same thing as no answer — applied to a connection instead of a request.
 */
export type LiveClosed =
  | { readonly _tag: "ended" }
  | { readonly _tag: "unauthenticated" }
  | { readonly _tag: "failed"; readonly detail: string };

/**
 * Classifies whatever ended a live connection.
 *
 * `Unauthenticated` is matched by its tag, which is the contract's own and survives
 * `HttpApiClient`'s decoding intact — the same test {@link isRefusal} applies to a round
 * trip, for the same reason: it is the one failure on this endpoint that is an *answer*
 * with a consequence. Everything else keeps its own text and nothing further is inferred.
 */
const closedBy = (failure: unknown): LiveClosed => {
  const tagged =
    typeof failure === "object" && failure !== null
      ? (failure as { _tag?: unknown; message?: unknown })
      : undefined;
  if (tagged?._tag === "Unauthenticated") return { _tag: "unauthenticated" };
  return {
    _tag: "failed",
    detail:
      typeof tagged?.message === "string" ? tagged.message : String(failure),
  };
};

/**
 * What a call to the server came back as.
 *
 * `Refused` carries the server's own typed error; `Unreachable` is everything else, with
 * whatever the transport said kept for the console. Two cases rather than an error union
 * because the screens branch on exactly this distinction.
 */
export type Call<A, E> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Refused"; readonly error: E }
  | { readonly _tag: "Unreachable"; readonly detail: string };

/** Tags the server defines. Anything else in the error channel is transport trouble. */
const REFUSAL_TAGS = new Set([
  "SessionRefused",
  "Unauthenticated",
  "PathRefused",
  "PathNotFound",
  "TargetRefused",
  // Opening a target: a stale deep link and a target whose file will not open are both
  // answers from the server, not transport trouble, and the hunt view says which.
  "TargetNotFound",
  "TargetUnavailable",
  // Starting and stopping a run: every reason the server gives is an answer the compose
  // box shows next to itself, not transport trouble.
  "RunRefused",
  // Asking for a transcript: an attempt this target does not hold is an answer. A
  // transcript nobody kept is *not* in this list, because it is not an error at all — it
  // comes back `200` with `source: "absent"`.
  "AttemptNotFound",
]);

const isRefusal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag: unknown })._tag === "string" &&
  REFUSAL_TAGS.has((error as { _tag: string })._tag);

/**
 * Runs one call and sorts the outcome into {@link Call}.
 *
 * `Effect.result` rather than letting the promise reject, so a refusal is a value the
 * caller must look at rather than an exception it might forget to catch. A defect — a
 * bug in this file, or a 500 from the server — is reported as unreachable with its text,
 * because from the operator's seat a server that answers with a stack trace and a server
 * that does not answer are the same problem.
 */
const run = async <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<Call<A, E>> => {
  try {
    const result = await Effect.runPromise(Effect.result(effect));
    if (Result.isSuccess(result)) {
      return { _tag: "Ok", value: result.success };
    }
    const error = result.failure;
    return isRefusal(error)
      ? { _tag: "Refused", error }
      : {
          _tag: "Unreachable",
          detail: error instanceof Error ? error.message : String(error),
        };
  } catch (cause) {
    return {
      _tag: "Unreachable",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

/**
 * Every call the three screens make, each already sorted into {@link Call}.
 *
 * The error type of each is left to inference rather than narrowed with a cast: it is the
 * union the contract declares plus whatever the transport can raise, and a caller that
 * wants one member of it tests `_tag`. Asserting a narrower type here would be claiming
 * the transport cannot fail.
 */
export const server = {
  /**
   * The token a reload should try, before anything has been verified.
   *
   * On the same seam as the calls, not beside it, because it is the same fact: the
   * bearer is whatever this client will put on the next request, and `sessionStorage` is
   * only where this particular client happens to park it. A caller that reached past the
   * client to a module-level setter would be asserting that *every* client stores its
   * token in the tab — which is exactly what a test one does not do, and the reason
   * classifying a wrong password used to need a working `sessionStorage`.
   */
  storedToken,

  /** Holds a token in memory and in `sessionStorage`. `undefined` signs out. */
  setToken,

  /** Exchanges the password for a token. Does not store it — the caller decides. */
  openSession: (baseUrl: string, password: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.session.open({ payload: { password } }),
      ),
    ),

  /** Confirms the current bearer still opens a session. */
  probe: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.probe())),

  targets: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.targets())),

  /**
   * Opens one target: its row, and the counts from its own database.
   *
   * The id travels as a path parameter the generated client fills in, so there is no
   * place here to build a URL out of string pieces — which is what keeps an id that
   * could not name a target from reaching the server as a path at all.
   */
  target: (baseUrl: string, targetId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.target({ params: { targetId } }),
      ),
    ),

  folders: (baseUrl: string, path?: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.folders({ query: path === undefined ? {} : { path } }),
      ),
    ),

  createTarget: (baseUrl: string, draft: TargetDraft) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.createTarget({ payload: draft }),
      ),
    ),

  /**
   * Starts a run against one target.
   *
   * It answers as soon as the run is going, not when it finishes, so this call is short
   * however long the run turns out to be. The attempt id it hands back is the handle for
   * stopping it and for recognising it in {@link runs} after a reload.
   */
  startRun: (
    baseUrl: string,
    targetId: string,
    instruction: string,
    /**
     * Which harness and model, when the operator has picked.
     *
     * Both optional and both omitted rather than sent as `undefined`: the contract's
     * fields are optional, and an explicitly-null field would be the browser asserting
     * "no instance" where it means "whatever you would choose". The response says which
     * were actually used either way.
     */
    pick?: {
      readonly instanceId?: string;
      readonly model?: string;
      /**
       * What was chosen of the model, already resolved against its descriptors.
       *
       * Omitted rather than sent empty when nothing was set, for the reason the contract
       * states: an empty list would claim an opinion, and a harness told nothing is the
       * only one free to apply its own default.
       */
      readonly modelOptions?: readonly ModelOptionSelection[];
    },
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.startRun({
          params: { targetId },
          payload: {
            instruction,
            ...(pick?.instanceId === undefined
              ? {}
              : { instanceId: pick.instanceId }),
            ...(pick?.model === undefined ? {} : { model: pick.model }),
            ...(pick?.modelOptions === undefined
              ? {}
              : { modelOptions: pick.modelOptions }),
          },
        }),
      ),
    ),

  /**
   * Which agent harnesses the server configures, ready or not.
   *
   * Includes the unusable ones with their reason, which is the whole point: the picker
   * keeps a configured harness visible and says why it cannot be used, rather than
   * leaving an operator to wonder where it went.
   */
  harnesses: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.harnesses())),

  /**
   * One past attempt's transcript — the server's own copy, or the harness's.
   *
   * `source` says which, and `ephemeral` says whether it can disappear. A transcript
   * nobody kept comes back as a success with `source: "absent"`, because for an older
   * attempt that is the expected answer rather than a fault.
   */
  transcript: (baseUrl: string, targetId: string, attemptId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.transcript({ params: { targetId, attemptId } }),
      ),
    ),

  stopRun: (baseUrl: string, targetId: string, attemptId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.stopRun({ params: { targetId, attemptId } }),
      ),
    ),

  /**
   * What the server is running right now, across every target.
   *
   * The only way a reloaded tab finds a run it started: the start response is the one
   * other place an attempt id appears, and it does not survive a refresh.
   */
  runs: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.runs())),

  /**
   * Watches one target's live transcript, and hands back the way to stop.
   *
   * **The one call on this seam that is not a round trip**, which is why it is shaped
   * differently from every other method here. The rest return a {@link Call} and are
   * `await`ed once; this one opens a connection that stays open, delivers frames until
   * something ends it, and has to be cancellable from a Svelte lifecycle that knows nothing
   * about Effect. So it takes callbacks and returns a function: a fiber is forked for the
   * stream and interrupting it is what closes the socket.
   *
   * `cursor` is where to resume the record channel. Omitted means "the server picks", and
   * the opening frame says what it picked and what it skipped; a client that has watched
   * before passes the highest sequence it saw. An empty view passes zero to reconstruct
   * committed history; a view with items resumes from its last delivered position.
   *
   * **`onClosed` is called exactly once, whatever ends the stream**, and it is handed a
   * typed {@link LiveClosed} rather than a sentence — see that type for why the
   * `Unauthenticated` case in particular may not be flattened into one. It is not called
   * for a caller that stopped it itself: interrupting is not an error and a screen that
   * put up "connection lost" because the operator navigated would be lying about its own
   * doing.
   */
  watchLive: (
    baseUrl: string,
    targetId: string,
    options: {
      readonly cursor?: number | undefined;
      readonly onFrame: (frame: LiveFrame) => void;
      readonly onClosed: (closed: LiveClosed) => void;
    },
  ): (() => void) => {
    let stopped = false;
    const fiber = Effect.runFork(
      Effect.flatMap(client(baseUrl), (api) =>
        Effect.flatMap(
          api.fleet.live({
            params: { targetId },
            query:
              options.cursor === undefined ? {} : { cursor: options.cursor },
          }),
          (stream) =>
            Stream.runForEach(stream, (frame) =>
              Effect.sync(() => {
                options.onFrame(frame);
              }),
            ),
        ),
      ).pipe(
        Effect.result,
        Effect.flatMap((outcome) =>
          Effect.sync(() => {
            // The caller's own stop interrupts this fiber, and an interruption is not news.
            if (stopped) return;
            options.onClosed(
              Result.isSuccess(outcome)
                ? { _tag: "ended" }
                : closedBy(outcome.failure),
            );
          }),
        ),
      ),
    );
    return () => {
      stopped = true;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  },
};

/**
 * What {@link App} needs from a control plane, which is exactly what {@link server} is.
 *
 * Written as `typeof server` rather than spelled out as an interface, and that is the
 * honest choice rather than the lazy one. Each method's error channel is *inferred*: it
 * is the union the contract declares for that endpoint plus whatever the transport can
 * raise, and nobody has written it down anywhere — on purpose, as the comment above
 * {@link server} says. Spelling it out here would mean restating a union that only the
 * compiler knows, and the restatement would be the thing that rots when an endpoint gains
 * an error member, in the one place a compile error would not point at it.
 *
 * Deriving it has the variance working for a fake too. {@link Call} holds its error
 * covariantly, so a hand-written double may answer with just the one refusal a test is
 * about — `Refused` carrying a `SessionRefused` and nothing else — and still satisfy a
 * method whose real error channel is six members wide. What it cannot do is invent a
 * success shape, because those are the contract's own types, named and checked.
 */
export type ServerClient = typeof server;
