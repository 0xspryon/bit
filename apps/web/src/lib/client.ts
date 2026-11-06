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
  GoalMessageDraft,
  IMPORTER_MESSAGE_MAX_CHARS,
  ImporterConversationDraft,
  ImporterMessageDraft,
  MESSAGE_FIELD,
  MESSAGE_FILES_FIELD,
  SessionGuard,
  type AGENT_SESSION_PAGE_SIZES,
  type AgentSessionKind,
  type AgentSessionsTab,
  type ConversationModelDraft,
  type GoalDraft,
  type GoalEndDraft,
  type IntentAbandonDraft,
  type IntentDraft,
  type LiveFrame,
  type ModelOptionSelection,
  type QuestionAnswers,
  type ScopeEntryDraft,
  type ScopeImportDraft,
  type ScopeLabelDraft,
  type SteerUrgency,
  type TargetDraft,
} from "@bit/contracts";
import { Effect, Fiber, Layer, Result, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";

import { messageTooLong } from "./importerChat";

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

/**
 * Tags the server defines. Anything else in the error channel is transport trouble.
 *
 * **This is an allow-list, and that is its one hazard.** A typed error the contract
 * declares and this set omits is not a compile error: it is a well-formed answer from the
 * server reported to the operator as "No server answered at this address", with the
 * server's own carefully written sentence thrown away. Three tags were missing when that
 * was first noticed — `GoalBriefingRefused`, `IntentRefused` and `IntentNotFound` — and
 * each produced exactly that.
 *
 * So the set is no longer maintained by hand alone. `clientRefusals.test.ts` reads every
 * tagged error the contract exports and asserts that this set and {@link NOT_REFUSALS}
 * together account for all of them, with nothing stale in either. Exported for that test.
 */
export const REFUSAL_TAGS = new Set([
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
  // transcript the harness has purged, or could not be asked about, is *not* in this list,
  // because it is not an error at all — it comes back `200` with `source: "absent"` or
  // `"unreachable"`.
  "AttemptNotFound",
  // Goals: a goal this target does not hold, and a goal that is already ended, are both
  // answers the goals screen puts in a sentence next to the control that caused them.
  "GoalNotFound",
  "GoalRefused",
  // A goal briefing over the configured ceiling. **It has to be here or the panel lies.**
  // The server built the briefing, measured it, and declined to hand it over — that is an
  // answer carrying two numbers the panel prints, and classifying it as transport trouble
  // would tell an operator no server answered when one answered precisely.
  "GoalBriefingRefused",
  // Scope: every reason is a sentence the Scope tab prints beside the control that caused
  // it. `contradiction` names the entry an operator would have to remove first and is the
  // one danger-red banner in that screen; `invalid` carries the normaliser's own words,
  // which name the remedy rather than the rule — "write the apex alone", "add it as a CIDR
  // entry instead". Classifying either as transport trouble would replace the one
  // instruction the operator needs with a connectivity complaint about a server that
  // answered precisely.
  "ScopeRefused",
  // Intents: an intent this target does not hold, and one that cannot be changed because a
  // run holds it or it is already answered or abandoned. `IntentRefused`'s `detail` is the
  // store's own sentence and **is written to teach** — it says what an offending anchor id
  // actually is and what to do instead — so classifying it as transport trouble replaced
  // the one instruction an operator needed with a connectivity complaint.
  "IntentNotFound",
  "IntentRefused",
  // Opening a planner round. **Every reason on `PlanRefused` is a sentence the goal
  // screen puts next to the "Plan next" button** — a round already working this goal, a
  // goal that has ended, a harness that is not configured, a directory the policy gate
  // would not install into. Classifying any of them as transport trouble would replace
  // "a round is already planning this goal; wait for it or stop it" with "No server
  // answered at this address", which is both wrong and unactionable. A briefing over the
  // ceiling comes back as `GoalBriefingRefused`, already listed above, because it is the
  // same fact the panel reports and the round started nothing.
  "PlanRefused",
  // Stopping a planner round: a round id this goal does not hold. Kept apart from
  // `PlanRefused`'s `unknown_round` on purpose — one says the row is not here, the other
  // says this process is not driving it, which is the ordinary state of every settled
  // round — and both are sentences the round's own controls print rather than transport
  // trouble. A goal's narration replay declares no error at all: a round the harness has
  // forgotten is a `200` that says so, because for an older round that is the expected
  // answer and not a fault.
  "RoundNotFound",
  // Saying something to a goal's agent. **Every reason is a sentence the composer prints
  // beside itself**: no harness configured, a harness that would not take a session, a goal
  // that has ended, a directory the policy gate would not install into. Classifying any of
  // them as transport trouble would replace "this goal has ended, so its agent's authority
  // has ended with it" with "No server answered at this address", which is wrong and
  // unactionable. Reading the conversation declares no error at all: a conversation nobody
  // has started, and one the harness has deleted, are both a `200` that says which.
  "GoalConversationRefused",
  // A message's files (A6 F9), on the importer's and a goal's message endpoints: a HEIC
  // image, a file over its cap, too many, too much together. Each names the file and the
  // figure, and nothing was stored or sent — the F2 error modal prints it.
  "MessageUploadRefused",
  // A stored upload a replayed attachment asked for (A6 U13): the path is not one of this
  // target's uploads, or nothing is stored there any more. The chip says so instead of
  // drawing a thumbnail; as transport trouble it would read "No server answered".
  "UploadedFileRefused",
  // The scope import panel. An import this process has forgotten is a real answer and the
  // panel acts on it by sending the operator to Assets, where what the import *wrote* is —
  // the entries and the assets are durable rows, and only the receipt was ever in memory.
  // Classifying it as transport trouble would say "No server answered at this address"
  // about a server that answered precisely, and would strand the operator on a panel
  // watching an import that is over.
  "ScopeImportNotFound",
  // Which model an import would run on. `no_harness` is the server saying there is no
  // catalogue to resolve D15's rule against, which is what disables the autoload checkbox
  // on the create-target screen and says why. A connectivity complaint here would leave the
  // checkbox enabled and the operator pasting links nothing will ever read.
  "ImporterModelUnavailable",
  // A message to the importer. Every reason is a sentence about the conversation — the
  // operator ended this import, the harness would not take the message and the session was
  // closed, no harness is ready — that the composer prints beside itself. As transport
  // trouble it would read "No server answered" about a server that answered precisely.
  "ImporterConversationRefused",
  // Switching a running conversation's model (A6 F4), importer or goal. A `409` carrying a
  // sentence — a model outside the pinned harness's catalogue, a switch already in flight,
  // an uncertain harness answer that names the model the session may still be on — which
  // the F2 error modal prints with its one dismiss action. As transport trouble it would
  // say "No server answered" while the picker kept showing a model the session is not on.
  "ConversationModelRefused",
  // Stopping a conversation's turn (A6 F5), importer or goal. A harness that would not
  // acknowledge the stop, so whether the turn stopped is uncertain and the server let go of
  // the session: a sentence the error modal prints. As transport trouble it would say "No
  // server answered" about a stop the server tried and could not confirm.
  "ConversationStopRefused",
  // A7-Q: a question no longer waiting, answers that do not fit, a harness that did not answer.
  "QuestionRefused",
]);

/**
 * Error tags the contract declares that this client deliberately does **not** treat as
 * refusals, each against the reason why.
 *
 * **Empty, and that is a claim rather than a placeholder.** Every error any endpoint
 * declares is an answer one of the screens puts in a sentence, so there is nothing to put
 * here, and `clientRefusals.test.ts` asserts that this is still true. The map exists so a
 * genuine exception has to be written down by name with its reason — rather than left out
 * of {@link REFUSAL_TAGS}, which is indistinguishable from forgetting, and which is how all
 * three of the missing tags came to be missing.
 */
export const NOT_REFUSALS: Readonly<Record<string, string>> = {};

const isRefusal = (error: unknown): boolean =>
  error instanceof RequestNotSent ||
  error instanceof RequestTooLarge ||
  (typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string" &&
    REFUSAL_TAGS.has((error as { _tag: string })._tag));

/**
 * A request this client would not send, because its payload does not encode against the
 * contract (U8 review 5): **nothing left the browser**, so it is a refusal the screen words
 * as one, never "No server answered". Not one of the server's tags, so not in
 * {@link REFUSAL_TAGS}; {@link isRefusal} knows it by class.
 *
 * Why it is checked here before the typed client is called: the typed client encodes the
 * payload inside the same effect that sends the request and decodes the answer, and its
 * failure is one `SchemaError` either way. A failed *answer* decode is a server that may
 * have acted — for a message, one that may have delivered it — and must stay `Unreachable`;
 * only a failed *request* encode is known to have sent nothing. A message over
 * `IMPORTER_MESSAGE_MAX_CHARS` was the case: filed as `Unreachable`, the importer page said
 * whether it was sent was not known, of a message no server ever saw.
 */
export class RequestNotSent {
  readonly _tag = "RequestNotSent";
  constructor(readonly detail: string) {}
}

/**
 * A message whose request body was over what the server's listener takes at all (A6 U13):
 * Bun answers a body over its ceiling (128 MiB by default) that declares its length with an
 * **empty `413`**, before the server's own handler — and its sentence — ever runs. The
 * browser's `FormData` always declares its length, so a message with that much in files
 * gets exactly this. It is a refusal, in a sentence this client words from what it sent:
 * nothing was read, stored or said to the agent.
 */
export class RequestTooLarge {
  readonly _tag = "RequestTooLarge";
  constructor(readonly detail: string) {}
}

/** The sentence for a {@link RequestTooLarge}, from the files the message carried. */
export const requestTooLargeSentence = (files: readonly File[]): string => {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const mib = (total / (1024 * 1024)).toFixed(1);
  return `The server refused this message before reading any of it: with its ${String(files.length)} ${files.length === 1 ? "file" : "files"} (${mib} MiB together) the request is over the most its listener takes in one request. Nothing was stored, and nothing was said to the agent. Send the files over several messages.`;
};

/** Whether a failure is the listener's empty `413`, which no declared error decodes. */
const isTooLarge = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const reason = (error as { reason?: { response?: { status?: unknown } } })
    .reason;
  return reason?.response?.status === 413;
};

/**
 * A message's body: its JSON as the contract encodes it, or — with files — the multipart
 * form the endpoint takes beside JSON (A6 F9): that same JSON under {@link MESSAGE_FIELD}
 * and each file under {@link MESSAGE_FILES_FIELD}. One request either way.
 */
const messageBody = <S extends Schema.Top>(
  schema: S,
  draft: S["Type"],
  files: readonly File[] | undefined,
): Effect.Effect<S["Type"] | FormData, never, S["EncodingServices"]> =>
  files === undefined || files.length === 0
    ? Effect.succeed(draft)
    : Effect.map(
        Effect.orDie(Schema.encodeUnknownEffect(schema)(draft)),
        (encoded) => {
          const form = new FormData();
          form.append(MESSAGE_FIELD, JSON.stringify(encoded));
          for (const file of files)
            form.append(MESSAGE_FILES_FIELD, file, file.name);
          return form;
        },
      );

/**
 * {@link run} for a message that may carry files: the listener's empty `413` becomes a
 * {@link RequestTooLarge} refusal naming what was sent.
 */
const runMessage = <A, E>(
  effect: Effect.Effect<A, E, never>,
  files: readonly File[] | undefined,
): Promise<Call<A, E | RequestTooLarge>> =>
  run(
    Effect.catch(effect, (error): Effect.Effect<never, E | RequestTooLarge> =>
      isTooLarge(error)
        ? Effect.fail(new RequestTooLarge(requestTooLargeSentence(files ?? [])))
        : Effect.fail(error),
    ),
  );

/**
 * The payload as the contract encodes it, or {@link RequestNotSent} with a sentence: the
 * length of a message over the importer's limit, the schema's own words otherwise.
 */
const encodedOrNotSent = <S extends Schema.Top>(
  schema: S,
  payload: S["Type"] & { readonly text: string },
): Effect.Effect<void, RequestNotSent, S["EncodingServices"]> =>
  Schema.encodeUnknownEffect(schema)(payload).pipe(
    Effect.asVoid,
    Effect.mapError((issue) => {
      const length = payload.text.trim().length;
      return new RequestNotSent(
        length > IMPORTER_MESSAGE_MAX_CHARS
          ? messageTooLong(length)
          : `This message could not be sent as written, so nothing left this browser: ${issue.message}`,
      );
    }),
  );

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
    /**
     * The intent to run. A run claims an intent that exists; it does not create one, and
     * there is no free text here for the server to turn into one.
     */
    intentId: string,
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
            intentId,
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
   * The open target's goals, newest first, each with its counts.
   *
   * An object with a `goals` field rather than a bare array, because that is what the
   * contract declares and a client that unwrapped it here would be a second place to learn
   * the shape.
   */
  goals: (baseUrl: string, targetId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goals({ params: { targetId } }),
      ),
    ),

  /**
   * Every asset recorded on the open target, oldest first.
   *
   * The whole estate in one answer, with nothing filtered: an asset no in-scope entry
   * covers comes back like any other, and the state it is shown under is decided from the
   * scope rather than by the server deciding what the operator may see.
   */
  assets: (baseUrl: string, targetId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.assets({ params: { targetId } }),
      ),
    ),

  /**
   * The open target's authored scope, with the block an agent would be given now.
   *
   * `promptBlock` is the server's own rendering, from the same function both prompt paths
   * call. The preview panel shows it verbatim rather than rebuilding it here, because a
   * preview assembled by a second renderer is the drift the one-renderer rule exists to
   * stop — and the panel's whole purpose is to be the place an operator can trust.
   */
  scope: (baseUrl: string, targetId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.scope({ params: { targetId } }),
      ),
    ),

  /**
   * Adds one scope entry. The value goes as typed; the server normalises and may refuse.
   *
   * Deliberately not normalised here: a browser copy of the rule would be a second
   * implementation of it, and the refusals are worth more than the round trip saves.
   */
  addScopeEntry: (baseUrl: string, targetId: string, draft: ScopeEntryDraft) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.addScopeEntry({ params: { targetId }, payload: draft }),
      ),
    ),

  removeScopeEntry: (baseUrl: string, targetId: string, entryId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.removeScopeEntry({ params: { targetId, entryId } }),
      ),
    ),

  /**
   * Promotes, excludes or withdraws a label on one host or one asset.
   *
   * One call for all six combinations, because the operator is using one control with two
   * directions and an undo. It never touches the typed entries.
   */
  labelScope: (baseUrl: string, targetId: string, draft: ScopeLabelDraft) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.labelScope({ params: { targetId }, payload: draft }),
      ),
    ),

  /**
   * Creates a goal. The draft carries an objective and an optional label and **no id**:
   * the server mints the goal id and the operation id, and this client has no way to name
   * either.
   */
  createGoal: (baseUrl: string, targetId: string, draft: GoalDraft) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.createGoal({ params: { targetId }, payload: draft }),
      ),
    ),

  /** One goal, with its counts. Refused if the target does not hold it. */
  goal: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goal({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * Ends a goal as the operator. Records that it is over and stops nothing: a run already
   * going under it is left alone.
   */
  endGoal: (
    baseUrl: string,
    targetId: string,
    goalId: string,
    draft: GoalEndDraft,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.endGoal({ params: { targetId, goalId }, payload: draft }),
      ),
    ),

  /** The intents under one goal, oldest first. Refused if the target lacks the goal. */
  intents: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.intents({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * The observations under one goal, as a digest to pick an anchor and a dimension from.
   * Not the record: see `GoalObservationView`.
   */
  goalObservations: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goalObservations({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * The briefing a planner round would be given for one goal: the rendered text, its size
   * and the ceiling.
   *
   * Refused as `GoalBriefingRefused` when the briefing would exceed the ceiling, and that
   * refusal carries no briefing — the server never shortens one.
   */
  goalBriefing: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goalBriefing({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * Adds an intent under a goal. The draft carries a question, anchors, a dimension and an
   * optional suggestion and **no id**: the server mints the intent id and the operation id.
   */
  createIntent: (
    baseUrl: string,
    targetId: string,
    goalId: string,
    draft: IntentDraft,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.createIntent({
          params: { targetId, goalId },
          payload: draft,
        }),
      ),
    ),

  /** Abandons an open intent as the operator. Refused if a run holds it. */
  abandonIntent: (
    baseUrl: string,
    targetId: string,
    intentId: string,
    draft: IntentAbandonDraft,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.abandonIntent({
          params: { targetId, intentId },
          payload: draft,
        }),
      ),
    ),

  /**
   * Opens a planner round on one goal, and answers without waiting for it.
   *
   * **There is no payload at all**, which is the shape of this call rather than an
   * omission: the round's directory, its audit path and the harness it runs on are the
   * server's, and the prompt is the goal's objective plus the goal briefing assembled
   * server-side. A browser that could name any of them would be choosing where an agent
   * runs.
   *
   * It returns as soon as the round is durable and prompted, the way {@link startRun}
   * does. A round takes minutes; the round id it hands back is how a reloaded tab
   * recognises it in {@link rounds}.
   */
  plan: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.plan({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * The planner rounds of one goal, newest first, with what each concluded.
   *
   * The rows, which is where a disposition survives a refresh. Not the same question as
   * {@link rounds}: a row saying `running` can be one a dead process left behind.
   */
  goalRounds: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goalRounds({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * The planner rounds this server is supervising right now, across every target.
   *
   * The sibling of {@link runs} and the only way a reloaded tab knows a round is still in
   * flight on the goal it is looking at — the start response is the one other place a
   * round id appears, and it does not survive a refresh.
   */
  rounds: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.rounds())),

  /**
   * One goal's planner narration, replayed from the harness.
   *
   * The companion of {@link goalRounds} and the half that cannot be promised: a round's
   * prose is never stored, so this is the harness's own copy and each round says whether it
   * still had one. Every answer is a success, including a goal whose rounds the harness has
   * deleted — `source` is what distinguishes "nothing yet" from "forgotten" from "this
   * round said nothing", and a client that treated an empty list as an error would report
   * three different facts as one fault.
   */
  goalNarration: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goalNarration({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * One goal's conversation, replayed from the harness.
   *
   * {@link goalNarration}'s sibling for the other agent, and the same promise: every answer
   * is a success. `source` is what distinguishes a goal nobody has talked to (`absent`)
   * from one whose words the harness has deleted (`forgotten`) from a live conversation
   * that has not said anything yet (`pending`), and a client that treated an empty list as
   * a fault would report four different facts as one.
   */
  goalConversation: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.goalConversation({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * Says something to one goal's agent, answering once the session has it.
   *
   * `202`: the turn is the model's to take, and what the agent says arrives on the live
   * stream. The payload is the operator's words and nothing else — no model, no harness, no
   * session — because the session is the server's and a browser that could name any of
   * that would be choosing where an agent runs.
   */
  sendGoalMessage: (
    baseUrl: string,
    targetId: string,
    goalId: string,
    text: string,
    /** `queued` when absent, which is what the server defaults to as well. */
    urgency?: SteerUrgency,
    /** The files the message carries (A6 U13), in the same request. */
    files?: readonly File[],
  ) =>
    runMessage(
      Effect.flatMap(
        messageBody(
          GoalMessageDraft,
          { text, ...(urgency === undefined ? {} : { urgency }) },
          files,
        ),
        (payload) =>
          Effect.flatMap(client(baseUrl), (api) =>
            payload instanceof FormData
              ? api.fleet.sendGoalMessage({
                  params: { targetId, goalId },
                  payload,
                })
              : api.fleet.sendGoalMessage({
                  params: { targetId, goalId },
                  payload,
                }),
          ),
      ),
      files,
    ),

  /**
   * Stops the turn running in one goal's conversation, and keeps the conversation (A6 F5).
   *
   * A conversation with nothing running, or none held by the server, is a success that
   * says so (`outcome`); a harness that would not acknowledge the stop is a refusal.
   */
  stopGoalTurn: (baseUrl: string, targetId: string, goalId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.stopGoalTurn({ params: { targetId, goalId } }),
      ),
    ),

  /**
   * Stops one planner round, answering with the round's own row once it has settled.
   *
   * The round is named under its goal because that is where it is recorded. Both refusals
   * are sentences the planner view prints beside the control: `RoundNotFound` for a round
   * this goal does not hold, and `PlanRefused`'s `unknown_round` for one this process is
   * not driving — which is what an operator gets for pressing stop on a round that settled
   * while the page was open.
   */
  stopRound: (
    baseUrl: string,
    targetId: string,
    goalId: string,
    roundId: string,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.stopRound({ params: { targetId, goalId, roundId } }),
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
   * Which model a scope import would run on right now (D15).
   *
   * **A request rather than a constant in this bundle, and that is the whole point of the
   * endpoint.** `modelOption.ts` is explicit that a descriptor is observed when the server
   * built the harness and replaced wholesale when it is rebuilt. A preferred model id
   * written down here would outlive the catalogue entry it names, and the Auto-load
   * screen would keep offering a choice the server could not honour.
   */
  importerModel: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.importerModel())),

  /**
   * The agents a conversation can run as, for the agent chip: each one's name and what it
   * can write. The server's registry, asked rather than compiled into this bundle, so the
   * chip never offers an agent the server no longer defines.
   */
  agents: (baseUrl: string) =>
    run(Effect.flatMap(client(baseUrl), (api) => api.fleet.agents())),

  /**
   * One page of this target's long-running agent sessions (A7 U8b): a tab, filtered,
   * grouped and paged by the server, with the tabs' unfiltered counts. A read-time union on
   * the server: there is no table of "agent sessions" behind it.
   */
  agentSessions: (
    baseUrl: string,
    targetId: string,
    query: AgentSessionsRequest = {},
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.agentSessions({
          params: { targetId },
          query: {
            ...(query.tab === undefined ? {} : { tab: query.tab }),
            ...(query.needsYou === true ? { needsYou: "1" as const } : {}),
            ...(query.agent === undefined ? {} : { agent: query.agent }),
            ...(query.q === undefined || query.q.trim() === ""
              ? {}
              : { q: query.q.trim() }),
            ...(query.page === undefined ? {} : { page: query.page }),
            ...(query.pageSize === undefined
              ? {}
              : { pageSize: String(query.pageSize) as "25" | "50" | "100" }),
            ...(query.timeZone === undefined ? {} : { tz: query.timeZone }),
            ...(query.titles === true ? { titles: "1" as const } : {}),
          },
        }),
      ),
    ),

  /**
   * The harness sessions this target's imports have run on, newest first, with what each
   * wrote. An index of the harness's storage: nothing that was said in them.
   */
  importerSessions: (baseUrl: string, targetId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.importerSessions({ params: { targetId } }),
      ),
    ),

  /**
   * Starts a scope import on a target that already exists.
   *
   * The Auto-load page's only write. It answers as soon as the session is going, with the
   * import to watch or the reason none started — a refusal to start is a value, so the
   * form can stay on screen beside it.
   */
  startScopeImport: (
    baseUrl: string,
    targetId: string,
    draft: ScopeImportDraft,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.startScopeImport({ params: { targetId }, payload: draft }),
      ),
    ),

  /**
   * Opens a conversation with the importer, its first turn the operator's message.
   *
   * `202` once the session has the message, with the new import's id — which is what the
   * next message is addressed to. No links: a page the operator wants read is in the text.
   */
  openImporterConversation: (
    baseUrl: string,
    targetId: string,
    draft: ImporterConversationDraft,
    /** The files the message carries (A6 U13), in the same request. */
    files?: readonly File[],
  ) =>
    runMessage(
      Effect.andThen(
        encodedOrNotSent(ImporterConversationDraft, draft),
        Effect.flatMap(
          messageBody(ImporterConversationDraft, draft, files),
          (payload) =>
            Effect.flatMap(client(baseUrl), (api) =>
              payload instanceof FormData
                ? api.fleet.openImporterConversation({
                    params: { targetId },
                    payload,
                  })
                : api.fleet.openImporterConversation({
                    params: { targetId },
                    payload,
                  }),
            ),
        ),
      ),
      files,
    ),

  /**
   * Says something to one import's session.
   *
   * The answer's `importId` is the one the next message goes to: the same on a `continued`
   * turn, a new one when the server had to open a fresh session in place of one it no
   * longer held.
   */
  sendImporterMessage: (
    baseUrl: string,
    targetId: string,
    importId: string,
    text: string,
    /** `queued` when absent, which is what the server defaults to as well. */
    urgency?: SteerUrgency,
    /** The files the message carries (A6 U13), in the same request. */
    files?: readonly File[],
  ) => {
    const draft = { text, ...(urgency === undefined ? {} : { urgency }) };
    return runMessage(
      Effect.andThen(
        encodedOrNotSent(ImporterMessageDraft, draft),
        Effect.flatMap(
          messageBody(ImporterMessageDraft, draft, files),
          (payload) =>
            Effect.flatMap(client(baseUrl), (api) =>
              payload instanceof FormData
                ? api.fleet.sendImporterMessage({
                    params: { targetId, importId },
                    payload,
                  })
                : api.fleet.sendImporterMessage({
                    params: { targetId, importId },
                    payload,
                  }),
            ),
        ),
      ),
      files,
    );
  },

  /**
   * One stored upload's bytes, for an attachment a replay drew from its path alone (A6
   * U13). The path is only a request: the server serves it only from a session's own
   * `uploads/` folder on this target (`UploadedFileRefused` otherwise).
   */
  uploadedFile: (baseUrl: string, targetId: string, path: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.uploadedFile({ params: { targetId }, query: { path } }),
      ),
    ),

  /**
   * Stops the turn running in one import's session, and keeps the conversation (A6 F5).
   *
   * **Not {@link stopScopeImport}**, which ends the import for good. The answer's
   * `conversationId` is the import the stop landed on and `working` whether the session is
   * still busy — on Claude Code, with a message queued behind the stopped turn.
   */
  stopImporterTurn: (baseUrl: string, targetId: string, importId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.stopImporterTurn({ params: { targetId, importId } }),
      ),
    ),

  /**
   * Answers the question one import's agent is waiting on (A7-Q), by the harness's id for
   * it, with the answers by field key. A question no longer waiting is `QuestionRefused`.
   */
  answerImporterQuestion: (
    baseUrl: string,
    targetId: string,
    importId: string,
    questionId: string,
    answers: QuestionAnswers,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.answerImporterQuestion({
          params: { targetId, importId, questionId },
          payload: { answers },
        }),
      ),
    ),

  /** Dismisses the question one import's agent is waiting on (A7-Q): the agent is told. */
  dismissImporterQuestion: (
    baseUrl: string,
    targetId: string,
    importId: string,
    questionId: string,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.dismissImporterQuestion({
          params: { targetId, importId, questionId },
        }),
      ),
    ),

  /**
   * Whether a turn, or background work, is running in one import's session (A6 U6): what
   * the chat polls to offer Stop. `conversationId` is the import holding the session now.
   */
  importerActivity: (baseUrl: string, targetId: string, importId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.importerActivity({ params: { targetId, importId } }),
      ),
    ),

  /**
   * How full one import's context window is (A6 U9); `breakdown` asks for the categories
   * too, which the server counts only when asked.
   */
  importerContext: (
    baseUrl: string,
    targetId: string,
    importId: string,
    breakdown: boolean,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.importerContext({
          params: { targetId, importId },
          query: breakdown ? { breakdown: "1" } : {},
        }),
      ),
    ),

  /**
   * Moves one import's session onto another model of its harness, or other options of its
   * model (A6 F4). The answer's `applied` says whether the harness took it live — from its
   * next model call — or only the record changed, for the next message to reopen on; a
   * `ConversationModelRefused` carries the sentence the error dialog prints.
   */
  switchImporterModel: (
    baseUrl: string,
    targetId: string,
    importId: string,
    draft: ConversationModelDraft,
  ) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.switchImporterModel({
          params: { targetId, importId },
          payload: draft,
        }),
      ),
    ),

  /**
   * One importer session's conversation, replayed from the harness (S6).
   *
   * {@link goalConversation}'s sibling for the importer, and the same promise: every answer
   * but a `404` is a success. `source` distinguishes an import nobody ever said anything in
   * (`absent`) from one whose words the harness has deleted (`forgotten`) from a live session
   * that has not spoken yet (`pending`), and `continuation` says what the composer's next
   * message will actually do — which is the one field a browser must not guess.
   */
  importerMessages: (baseUrl: string, targetId: string, importId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.importerMessages({ params: { targetId, importId } }),
      ),
    ),

  /** One import's links, tool calls and totals, for the "Loading the scope" panel. */
  scopeImport: (baseUrl: string, targetId: string, importId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.scopeImport({ params: { targetId, importId } }),
      ),
    ),

  /** Stops one import, keeping everything it has already written. */
  stopScopeImport: (baseUrl: string, targetId: string, importId: string) =>
    run(
      Effect.flatMap(client(baseUrl), (api) =>
        api.fleet.stopScopeImport({ params: { targetId, importId } }),
      ),
    ),

  /**
   * One past attempt's transcript, asked of the harness: the server keeps no copy.
   *
   * `source` says what asking found, and `ephemeral` says whether what is shown can
   * disappear. A transcript the harness has purged comes back as a success with
   * `source: "absent"`, because for an older attempt that is the expected answer rather
   * than a fault; one the harness could not be asked about is `"unreachable"`, which says
   * nothing about whether it still exists.
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
            /*
             * Partials asked for (A6 U5): `App.applyLiveFrame` replaces a block's partial
             * by its `blockId` and never dedupes one by id, which is what the server needs
             * to know before it sends them (`live.ts`, "Partial items").
             */
            query: {
              partials: "1",
              ...(options.cursor === undefined
                ? {}
                : { cursor: options.cursor }),
            },
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

/** What the Agent sessions page asks the server for (`agentSessions`), decoded. */
export interface AgentSessionsRequest {
  readonly tab?: AgentSessionsTab | undefined;
  readonly needsYou?: boolean | undefined;
  readonly agent?: AgentSessionKind | undefined;
  readonly q?: string | undefined;
  readonly page?: number | undefined;
  readonly pageSize?: (typeof AGENT_SESSION_PAGE_SIZES)[number] | undefined;
  readonly timeZone?: string | undefined;
  readonly titles?: boolean | undefined;
}
