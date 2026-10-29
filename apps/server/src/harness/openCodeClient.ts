/**
 * The OpenCode implementation of {@link AgentHarness}: a typed client over the OpenCode 2
 * HTTP API, plus the identity and the gate installer that go with it.
 *
 * This used to *be* the harness seam. It declared `OpenCodeClient` as the service the
 * supervisor required, and so OpenCode's vocabulary — a `{ providerID, id }` model pair, a
 * `ses_`-prefixed session id, a remote-MCP registration body with headers — was the
 * application's vocabulary too. A second harness moved the seam to
 * `harness/agentHarness.ts` and left this as one implementation of it. Nothing about the
 * wire changed; what changed is that none of the three shapes above is visible above this
 * file any more.
 *
 * Built on Effect's own `HttpClient` (`effect/http`), not on bare `fetch`. That is what
 * makes two properties true rather than aspirational:
 *
 * - **Cancellation reaches the socket.** `FetchHttpClient` passes the fiber's
 *   `AbortSignal` into `fetch`, so interrupting a client fiber — or letting a timeout
 *   interrupt it — aborts the in-flight request. Cancelling *our* request still says
 *   nothing about whether the harness stopped working; see `waitForIdle`.
 * - **The typed boundary is real.** Every response body is decoded through an Effect
 *   Schema. A 2xx answer in an unexpected shape is a typed {@link HarnessDecodeError}, not
 *   a cast that lies about what we have and dies somewhere downstream.
 *
 * **Routes and payload shapes are the generated client's, not ours.**
 * `@opencode/client/effect` is the Effect client OpenCode publishes from the same source
 * as the server, and it is what T3Code uses
 * (`packages/provider-opencode/src/server/v2/OpenCode2Client.ts:1-15`). The six routes
 * this service needs are `api.session.create`, `api.session.prompt`, `api.session.wait`,
 * `api.session.get`, `api.message.list` and `api.mcp.add`. Pinning a URL or re-deriving a
 * response shape is no longer our job, so it can no longer drift from the server we are
 * talking to.
 *
 * What stays ours is everything above the wire:
 *
 * - **The authenticated, bounded transport.** We build the `HttpClient` the generated
 *   client runs on, so the Basic credential, the base URL and the per-operation timeouts
 *   below apply to every call it makes — including any we have not wrapped.
 * - **Our error taxonomy.** The client's failures are its own tagged errors; `fail` below
 *   collapses them into {@link HarnessTransportError} and {@link HarnessDecodeError},
 *   keeping "the transport broke" distinct from "the answer was not the shape we were
 *   promised". Callers and tests depend on that distinction.
 * - **The narrow surface.** Nine operations with domain-shaped results, not 200 routes.
 *
 * One dependency note, because it cost an afternoon to find: the package declares
 * `effect: "4.0.1"` as an **exact** peer. Without intervention bun installs a second copy
 * of Effect, and Schema internals from two instances interleave and throw
 * (`s.startsWith is not a function` out of `SchemaAST`). The root `package.json` therefore
 * pins `overrides: { effect: "4.0.5" }` so one copy is resolved for the whole workspace.
 * Check that override on any Effect or client upgrade.
 *
 * `POST /api/experimental/mcp/{server}` — `api.mcp.add` — is how our bearer credential
 * reaches the harness: in a request body, never in the server's argv and never in the
 * environment the agent's own shell commands inherit (DECISIONS.md §6 "credentials off
 * argv").
 */
import {
  MODEL_OPTION_DEFAULT_CHOICE,
  type HarnessModelView,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
} from "@bit/contracts";
import { OpenCode } from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import {
  ID as ModelID,
  VariantID as ModelVariantID,
} from "@opencode/schema/model";
import { ID as ProviderID } from "@opencode/schema/provider";
import { AbsolutePath } from "@opencode/schema/schema";
import { ID as SessionID, type Session } from "@opencode/schema/session";
import {
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

import { installOpenCodeGate } from "../policy/install";
import {
  AgentHarness,
  TerminalOutcome,
  truncateNarration,
  type HarnessNarration,
  type MessageEntry,
  type NarrationDetail,
} from "./agentHarness";
import { HarnessDecodeError, HarnessTransportError } from "./errors";
import {
  defaultInstanceIdForDriver,
  OPENCODE_DRIVER,
  type HarnessInstance,
  type ModelProvenance,
} from "./identity";
import { OpenCodeServer } from "./openCodeServer";

/**
 * The model a worker runs on when nothing names one.
 *
 * `openai` here is OpenCode's OAuth-authenticated ChatGPT subscription provider, which the
 * spawned server reads from the user's own stored credentials. No API key is read, passed
 * or held by this process (DECISIONS.md §12).
 *
 * Verified on 2026-10-19 against opencode v2.0.32, and again on 2026-10-24 against v2.1.2:
 * `gpt-5.6-sol` and `gpt-6-astra` complete; `gpt-5.5` and `gpt-5.3-codex-spark` are
 * refused by the provider with "not supported when using Codex with a ChatGPT account", so
 * model availability is narrower than the catalogue suggests.
 *
 * Written in OpenCode's own `provider/model` form, which is the form its configuration
 * files use, so that one string is the whole of what a caller has to name — the harness
 * splits it for the wire and for provenance (see {@link openCodeModelProvenance}).
 */
export const OPENCODE_DEFAULT_MODEL = "openai/gpt-5.6-sol";

/**
 * Splits OpenCode's `provider/model` into the two columns an attempt row records.
 *
 * On the first slash, not the last: a model id may contain slashes and a provider id may
 * not. A string with no slash has no provider to name, and `unknown` is recorded rather
 * than an empty string, because an empty provider column reads as a bug and this is a
 * configuration mistake with a name.
 */
export const openCodeModelProvenance = (model: string): ModelProvenance => {
  const slash = model.indexOf("/");
  return slash === -1
    ? { providerId: "unknown", modelId: model }
    : { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

/**
 * The option id a run carries for OpenCode's reasoning choice: OpenCode's own word.
 *
 * `variant` and not `reasoningEffort`, because that is what the API field is called
 * (`Model.Ref.variant`) and the id a selection names is the harness's rather than ours —
 * see `@bit/contracts`'s `modelOption.ts`. The value is a variant id and nothing else:
 * OpenCode keeps the settings overlay server-side and merges it per request
 * (`core/src/model-resolver.ts`'s `withVariant`), so sending the overlay would be sending
 * it the thing it is about to look up.
 */
export const OPENCODE_VARIANT_OPTION = "variant";

/**
 * What the picker shows for each variant id.
 *
 * OpenCode's own composer labels a variant with its raw id, and the ids are minted from
 * provider *reasoning* support (`core/src/variant.ts` builds them out of
 * `ConfigProvider.Reasoning`: the effort ladder, or a `none`/`thinking` toggle), which is
 * what makes "Reasoning" an honest label for the descriptor rather than an interpretation.
 *
 * An id this map does not know is shown **verbatim**. A provider that mints a variant for
 * something other than reasoning would therefore read as itself rather than being dressed
 * up as a level — and that is the signal to revisit the descriptor's label, not something
 * to paper over here.
 */
const OPENCODE_VARIANT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  thinking: "Thinking",
};

/**
 * One model's catalogue entry, as the picker reads it.
 *
 * A model with no variants gets no descriptor at all rather than a descriptor with one
 * choice: "this model offers nothing to choose" and "this model offers only its default"
 * are the same fact, and the second spelling would put an inert control on the screen.
 */
const openCodeModelView = (
  id: string,
  variants: readonly { readonly id: string }[],
): HarnessModelView => {
  if (variants.length === 0) return { id };
  const descriptor: ModelOptionDescriptor = {
    id: OPENCODE_VARIANT_OPTION,
    label: "Reasoning",
    type: "select",
    options: [
      // The way back to the model's own behaviour, and OpenCode's own spelling for it:
      // `withVariant` reads `"default"` as "no variant" (`core/src/model-resolver.ts`).
      { id: MODEL_OPTION_DEFAULT_CHOICE, label: "Default", isDefault: true },
      ...variants.map((variant) => ({
        id: variant.id,
        label: OPENCODE_VARIANT_LABELS[variant.id] ?? variant.id,
      })),
    ],
  };
  return { id, optionDescriptors: [descriptor] };
};

/**
 * The variant a session should be created on, from the resolved selections.
 *
 * Returns nothing for the default choice rather than passing it through. OpenCode would
 * accept `"default"` and read it as "no variant", but a request that names no variant is
 * the honest expression of "the operator did not pin one", and it is also what keeps the
 * session's stored `ModelRef` free of a value an operator never chose.
 */
const openCodeVariantOf = (
  options: readonly ModelOptionSelection[] | undefined,
): { variant?: typeof ModelVariantID.Type } => {
  const value = options?.find(
    (option) => option.id === OPENCODE_VARIANT_OPTION,
  )?.value;
  return value === undefined || value === MODEL_OPTION_DEFAULT_CHOICE
    ? {}
    : // Branded here rather than cast, like every other id this client puts on the wire:
      // whatever validation the brand carries now or later actually runs, and a bad value
      // fails with the value in the message instead of inside a request body.
      { variant: Schema.decodeUnknownSync(ModelVariantID)(value) };
};

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
 * One `{ type: "text", text }` / `{ type: "file", uri }` list, as one string.
 *
 * `session.tool.success` carries its output as that union
 * (`@opencode/protocol@2.1.0`'s `event.d.ts`), and a file part has no text to show — so it
 * is named by its uri rather than dropped, because "the tool answered with a file" and
 * "the tool answered with nothing" are different results.
 */
const partsText = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = (part ?? {}) as {
        type?: unknown;
        text?: unknown;
        uri?: unknown;
      };
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "file" && typeof record.uri === "string") {
        return `[file ${record.uri}]`;
      }
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
};

/** `JSON.stringify` that answers with something for a value it cannot serialise. */
const asJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // A cyclic or non-serialisable argument object. The call still happened and still has
    // to appear, so it appears with its arguments unavailable rather than not at all.
    return "";
  }
};

/**
 * What this application reads one OpenCode event as.
 *
 * ## The tool name arrives on a different event from the arguments
 *
 * Verified against `@opencode/protocol@2.1.0`'s generated event union: a call is five
 * events, keyed by `data.id`, and only the first of them carries the tool's name.
 *
 * | event                        | `data` carries                        |
 * | ---------------------------- | ------------------------------------- |
 * | `session.tool.input.started` | `id`, **`name`**                      |
 * | `session.tool.input.delta`   | `id`, `delta`                         |
 * | `session.tool.input.ended`   | `id`, `text`                          |
 * | `session.tool.called`        | `id`, **`input`**, `executed`         |
 * | `session.tool.success`       | `id`, **`content`**, `metadata`       |
 * | `session.tool.failed`        | `id`, **`error`**, `content`          |
 *
 * So `names` is a join table for the length of one session's stream: the name is remembered
 * when it is seen and read when the arguments or the result arrive. It is **per stream**,
 * created by the caller, which is what keeps one run's tool names out of another's — and
 * entries are deleted when the call resolves, so the map is bounded by the calls in flight
 * rather than by the length of the run.
 *
 * A name that was never seen stays `undefined` and is carried as such. Guessing one from
 * the arguments, or reusing the last name seen, would put the wrong tool next to a real
 * set of arguments, which is worse than an unnamed call.
 *
 * ## Text comes from `ended`, never from `delta`
 *
 * `session.text.delta` is one event per token-ish chunk and is read as `opaque`:
 * `session.text.ended` carries the whole block once (`data.text`), so taking the reply from
 * there means one entry per block instead of hundreds per reply, with no reassembly to get
 * wrong. The deltas are still published — they are what the supervisor's outcome watch
 * reads the stream for — they just carry nothing to render.
 *
 * Reads defensively off an already-decoded value, for the same reason {@link flatten}
 * does: the entry union is wide and version-specific, and re-asserting a shape the
 * generated client has already validated would only add a second place for it to be wrong.
 *
 * **Exported for the tests, and that is the honest reason.** Driving this through
 * `sessionEvents` would mean stubbing an SSE transport to assert a mapping that has nothing
 * to do with transport — and the five-event tool sequence above is the part most likely to
 * be wrong on an `opencode` upgrade, so it is the part that wants a direct test.
 */
export const openCodeNarration = (
  entry: unknown,
  names: Map<string, string>,
): HarnessNarration => {
  const record = (entry ?? {}) as {
    type?: unknown;
    created?: unknown;
    durable?: { seq?: unknown } | undefined;
    data?: Record<string, unknown> | undefined;
  };
  const type = typeof record.type === "string" ? record.type : "unknown";
  const sequence = record.durable?.seq;
  const data = record.data ?? {};
  const callId = typeof data["id"] === "string" ? data["id"] : undefined;

  const detail = ((): NarrationDetail => {
    switch (type) {
      case "session.text.ended":
        return typeof data["text"] === "string"
          ? { _tag: "reply", text: truncateNarration(data["text"]) }
          : { _tag: "opaque" };
      case "session.tool.input.started": {
        if (callId !== undefined && typeof data["name"] === "string") {
          names.set(callId, data["name"]);
        }
        return { _tag: "opaque" };
      }
      case "session.tool.called":
        return callId === undefined
          ? { _tag: "opaque" }
          : {
              _tag: "toolCall",
              callId,
              tool: names.get(callId),
              input: truncateNarration(asJson(data["input"])),
            };
      case "session.tool.success": {
        if (callId === undefined) return { _tag: "opaque" };
        const tool = names.get(callId);
        names.delete(callId);
        return {
          _tag: "toolResult",
          callId,
          tool,
          output: truncateNarration(partsText(data["content"])),
          failed: false,
        };
      }
      case "session.tool.failed": {
        if (callId === undefined) return { _tag: "opaque" };
        const tool = names.get(callId);
        names.delete(callId);
        const error = (data["error"] ?? {}) as { message?: unknown };
        const content = partsText(data["content"]);
        const message =
          typeof error.message === "string" ? error.message : "the tool failed";
        return {
          _tag: "toolResult",
          callId,
          tool,
          output: truncateNarration(
            content === "" ? message : `${message}\n${content}`,
          ),
          failed: true,
        };
      }
      default:
        return { _tag: "opaque" };
    }
  })();

  return {
    type,
    sequence: typeof sequence === "number" ? sequence : undefined,
    at: typeof record.created === "number" ? record.created : 0,
    outcome: EXECUTION_OUTCOMES[type],
    detail,
  };
};

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

/**
 * A session id this application mints, in OpenCode's own format.
 *
 * `@opencode/schema`'s `Session.ID.create()` rather than a string of our own: the format is
 * `ses_` plus the harness's descending identifier, the brand's check enforces the prefix,
 * and a value built by hand would be our guess at someone else's id scheme. This is the
 * only place it is called, so if the scheme changes there is one line to follow.
 *
 * Minting an id here is only useful because the harness honours it. `SessionCreateInput.id`
 * is `Session.ID | undefined` in `@opencode/client@2.1.0`, and `opencode` 2.1.2 returning
 * the id it is handed was checked against a live `opencode serve` rather than inferred
 * from the type.
 */
export const newOpenCodeSessionId = (): string => SessionID.create();

/** What a caller may vary about this harness. */
export interface OpenCodeHarnessOptions {
  readonly timeouts?: ClientTimeouts;
  /** The model a run gets when it names none. OpenCode's `provider/model` form. */
  readonly defaultModel?: string;
}

/**
 * The OpenCode harness over an already-running `opencode serve`.
 *
 * Requires {@link OpenCodeServer}, which is what makes "this deployment can start runs" a
 * layer question rather than a runtime one: a process whose harness will not spawn never
 * builds this, and `main.ts` serves without it.
 */
export const openCodeHarness = (
  options: OpenCodeHarnessOptions = {},
): Layer.Layer<AgentHarness, never, OpenCodeServer> => {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const defaultModel = options.defaultModel ?? OPENCODE_DEFAULT_MODEL;
  return Layer.effect(
    AgentHarness,
    Effect.gen(function* () {
      const { server } = yield* OpenCodeServer;

      /**
       * The transport every generated call runs on.
       *
       * The credential is attached here, once, rather than per call: the generated client
       * builds its own requests, so an operation we have not wrapped is authenticated too.
       * `filterStatusOk` is deliberately **not** applied — the client reads non-2xx bodies
       * to produce its own tagged errors, and discarding them here would flatten
       * `UnauthorizedError` and friends into a bare status.
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
       * The distinction that has to survive is transport versus shape, because they mean
       * different things to a caller: a transport failure leaves the harness's state
       * *uncertain*, while a decode failure means we are talking to something that does not
       * answer the way this build expects. A `SchemaError` — raised directly or wrapped in
       * the client's `ClientError` — is the second kind; everything else is the first.
       */
      const fail = (operation: string) => (cause: unknown) => {
        // The client wraps a transport or schema failure in its own `ClientError`, so the
        // useful one is a level down. Unwrap exactly one level — more would be guessing at
        // a chain whose shape is not ours.
        const outer = cause as { readonly cause?: unknown };
        const inner = outer.cause ?? cause;
        const status = HttpClientError.isHttpClientError(inner)
          ? inner.response?.status
          : undefined;
        const tag = (inner as { _tag?: string })._tag ?? "error";
        const detail = (inner as { message?: string }).message ?? String(inner);

        // Official predicates rather than tag strings: a decode failure is whatever Effect
        // calls a decode failure, in this version and the next.
        return Schema.isSchemaError(inner)
          ? new HarnessDecodeError({ operation, status, detail, cause })
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
       * The catalogue, read once, as the strings a run actually names a model with.
       *
       * `api.model.list()` answers every model this server's configured providers expose,
       * and `providerID/id` is the one form that is also what `createSession` is handed
       * and what `openCodeModelProvenance` splits — so the picker, the attempt row and the
       * wire all agree on one spelling with nothing in between to get it wrong.
       *
       * **A failure degrades to the default model and does not refuse the harness.** A
       * catalogue is for choosing with; being unable to read it is a reason the picker has
       * one entry, not a reason this deployment cannot run anything. Contrast
       * `claudeCodeClient.ts`'s version read, which *does* refuse — because that one is the
       * evidence for a safety property rather than a convenience.
       *
       * The default is kept at the front and deduplicated into the list, so the model a
       * run gets when it names none is always pickable and never listed twice.
       */
      const listed = yield* Effect.result(
        bounded("model.list", timeouts.control, api.model.list()),
      );
      if (listed._tag === "Failure") {
        yield* Effect.logWarning(
          "could not read OpenCode's model catalogue; the picker will offer this instance's default model only",
          { detail: listed.failure.message },
        );
      }
      const catalogue =
        listed._tag === "Success"
          ? listed.success.data.map((model) =>
              openCodeModelView(
                `${model.providerID}/${model.id}`,
                model.variants,
              ),
            )
          : [];
      // The default's own entry when the catalogue has one, so the model a run gets when
      // it names none carries its variants like any other; a bare entry when the
      // catalogue could not be read, which offers nothing rather than guessing.
      const models: readonly HarnessModelView[] = [
        catalogue.find((model) => model.id === defaultModel) ?? {
          id: defaultModel,
        },
        ...catalogue
          .filter((model) => model.id !== defaultModel)
          .sort((left, right) => left.id.localeCompare(right.id)),
      ];

      const instance: HarnessInstance = {
        instanceId: defaultInstanceIdForDriver(OPENCODE_DRIVER),
        driver: OPENCODE_DRIVER,
        displayName: "OpenCode",
        // Read off `/api/info` during readiness, so it is the build that answered rather
        // than the one on the PATH when somebody last looked.
        version: server.version,
        installed: true,
        // See `identity.ts` on why this is not probed: `opencode serve` starts without
        // provider credentials and only fails at prompt time, so anything else here would
        // be a guess.
        auth: "unknown",
        defaultModel,
        models,
      };

      /**
       * Brands a directory as the absolute path the client's types require.
       *
       * `AbsolutePath` is a branded string, so this is the one place the brand is applied;
       * `decodeUnknownSync` rather than a cast so that whatever validation the brand
       * carries now or later actually runs, and a bad path fails here with the path in the
       * message instead of somewhere inside a request body.
       */
      const directoryOf = (directory: string) =>
        Schema.decodeUnknownSync(AbsolutePath)(directory);

      /**
       * Brands a `provider/model` string as the pair the wire wants.
       *
       * `decodeUnknownSync` dies on a malformed id rather than failing, and that is
       * correct here: the model is *configuration*, not a request payload, so a bad one is
       * a deployment mistake to be surfaced loudly and not a condition a run should report
       * as "the harness is unreachable".
       */
      const modelOf = (model: string) => {
        const { providerId, modelId } = openCodeModelProvenance(model);
        return {
          providerID: Schema.decodeUnknownSync(ProviderID)(providerId),
          id: Schema.decodeUnknownSync(ModelID)(modelId),
        };
      };

      const registerMcpServer: AgentHarness["Service"]["registerMcpServer"] =
        Effect.fn("openCodeHarness.registerMcpServer")(
          // `_sessionId` is unused, and that is the whole point of the parameter: OpenCode
          // registers an MCP server into a directory and has no per-session channel, so
          // the session the credential is for is implicit here. The interface takes it
          // anyway because Claude Code cannot register without it; see
          // `AgentHarness.registerMcpServer` for what this implementation is therefore
          // wider than.
          function* (_sessionId, name, config) {
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
                  // 2026-07-28 revision, and this field's default value would open with an
                  // `initialize` handshake the server does not implement. "auto" would
                  // probe and silently fall back; there is nothing to fall back to. Typed
                  // by the schema, so a typo here is a compile error rather than a
                  // connection failure at run time.
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

      const createSession: AgentHarness["Service"]["createSession"] = Effect.fn(
        "openCodeHarness.createSession",
      )(function* (input) {
        const session = yield* bounded(
          "session.create",
          timeouts.control,
          api.session.create({
            title: input.title,
            // The variant rides on the session's model reference, which is where OpenCode
            // keeps it: `session.create` takes it here and `session.switchModel` is the
            // only other way in. A prompt carries no model at all, so there is nothing
            // per-turn to set and nothing to re-send before each prompt.
            model: {
              ...modelOf(input.model),
              ...openCodeVariantOf(input.options),
            },
            location: { directory: directoryOf(input.directory) },
            // Spread rather than passed as `undefined` so the call site reads as "no
            // parent" rather than "parent: nothing". On the wire both are the same: the
            // generated client encodes an absent optional as an explicit `null`, which is
            // what the server reads as parentless.
            //
            // `parentSessionId` exists for provider prompt caching: OpenCode derives one
            // cache key per lineage — `parentID ?? fork.sessionID ?? id`
            // (`core/src/session/affinity.ts`) — so sessions naming the same parent reach
            // the same cached prefix. A child is *not* a fork: only the fork path copies
            // messages across, so the new session starts empty.
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

      const prompt: AgentHarness["Service"]["prompt"] = Effect.fn(
        "openCodeHarness.prompt",
      )(function* (sessionId, text) {
        yield* bounded(
          "session.prompt",
          timeouts.control,
          api.session.prompt({ sessionID: sessionId as Session.ID, text }),
        );
      });

      /**
       * Blocks until the session settles.
       *
       * A failure here means the outcome is **uncertain**, not that execution stopped: the
       * wait call losing its connection, or being interrupted, says nothing about the
       * harness (DECISIONS.md §15 "Recovery"). Callers must reconcile against
       * `sessionStatus` and must never resubmit the prompt.
       */
      const waitForIdle: AgentHarness["Service"]["waitForIdle"] = Effect.fn(
        "openCodeHarness.waitForIdle",
      )(function* (sessionId) {
        yield* bounded(
          "session.wait",
          timeouts.wait,
          api.session.wait({ sessionID: sessionId as Session.ID }),
        );
      });

      const sessionStatus: AgentHarness["Service"]["sessionStatus"] = Effect.fn(
        "openCodeHarness.sessionStatus",
      )(function* (sessionId) {
        const session = yield* bounded(
          "session.get",
          timeouts.control,
          api.session.get({ sessionID: sessionId as Session.ID }),
        );
        const outcome = (session as { outcome?: unknown }).outcome;
        return {
          outcome: Schema.is(TerminalOutcome)(outcome) ? outcome : undefined,
          cost: session.cost,
          tokens: session.tokens as Record<string, unknown> | undefined,
        };
      });

      const messages: AgentHarness["Service"]["messages"] = Effect.fn(
        "openCodeHarness.messages",
      )(function* (sessionId) {
        const listed = yield* bounded(
          "message.list",
          timeouts.control,
          api.message.list({ sessionID: sessionId as Session.ID }),
        );
        return listed.data.map(flatten);
      });

      const interruptSession: AgentHarness["Service"]["interruptSession"] =
        Effect.fn("openCodeHarness.interruptSession")(function* (sessionId) {
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
       * ## Why `event.subscribe()` and not `session.log`
       *
       * Both calls exist on the generated client; `session.log({ sessionID, follow: true })`
       * is per session by construction and replays a durable log, which on paper makes it
       * the unambiguous choice. Against a live `opencode` 2.1.2 it carries **no narration
       * at all**: a session that was prompted, ran, replied and settled `succeeded`
       * produced exactly one entry, `log.synced`, both while following and on a
       * non-following replay afterwards. That build's durable per-session log is simply not
       * where execution is written. Checked on 2026-10-24.
       *
       * `event.subscribe()` carries all of it — `session.execution.started`,
       * `session.inbox.*`, `session.step.*`, `session.text.*`, `session.tool.*`,
       * `session.usage.updated` and the terminal
       * `session.execution.{succeeded,failed,interrupted}`.
       *
       * It is one stream for the whole server, so events have to be attributed, but the
       * attribution is a single field read at the same position in every event; see
       * {@link sessionOf}. An event carrying neither field is dropped rather than guessed
       * at — a misattributed entry would publish one target's narration under another's
       * key, which is the one failure worth being strict about.
       *
       * **One subscription per watched session, not one shared and demultiplexed.** N
       * concurrent runs open N streams to a local server, which is a cost worth paying for
       * the lifetime it buys: each belongs to one supervisor fiber and is cancelled at the
       * socket when that fiber is interrupted.
       *
       * `Stream.mapError` rather than the `bounded` helper the others use: `bounded`
       * applies `Effect.timeout`, which is the one thing a followed stream must not have.
       *
       * `filterMap` rather than `filter` then `map`: an event belonging to another session
       * and an event with no session on it are both dropped by the same step that reads the
       * id, so there is no second place for the two to disagree.
       */
      const sessionEvents: AgentHarness["Service"]["sessionEvents"] = (
        sessionId,
      ) => {
        /**
         * The tool-name join table for this stream, and nothing wider.
         *
         * Created per call, so N concurrent runs have N maps and one run's tool names can
         * never be read for another's call id. {@link openCodeNarration} deletes an entry when the
         * call succeeds or fails, which bounds this by the calls in flight.
         */
        const names = new Map<string, string>();
        return api.event
          .subscribe()
          .pipe(
            Stream.mapError(fail("event.subscribe")),
            Stream.filterMap(
              Filter.make((event: unknown) =>
                sessionOf(event) === sessionId
                  ? Result.succeed(openCodeNarration(event, names))
                  : Result.fail(event),
              ),
            ),
          );
      };

      return AgentHarness.of({
        instance,
        newSessionId: newOpenCodeSessionId,
        modelProvenance: openCodeModelProvenance,
        installGate: installOpenCodeGate,
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
};
