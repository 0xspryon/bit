/**
 * Who ran a run: driver, instance, model.
 *
 * Three names, kept apart because they answer three different questions and collapsing
 * any two of them is how a tool starts routing by the wrong thing. The shape is T3Code's
 * (`packages/contracts/src/providerInstance.ts`), adopted rather than invented because
 * slice C's picker and the later quota work both have to read it, and a shape chosen here
 * for one slice's convenience is a shape they would both have to undo.
 *
 * - **Driver** — *what kind of harness is this?* `opencode`, `claude-code`. It names an
 *   implementation of the agent-harness seam.
 * - **Instance** — *which configured one?* One account, one login, one configuration of a
 *   driver. **This is the identity everything routes by.** A stock instance uses the
 *   driver's own slug as its id ({@link defaultInstanceIdForDriver}), which is why a
 *   single-instance installation reads as `opencode` or `claude-code` in both positions
 *   and nothing has to know the difference yet.
 * - **Model** — chosen *within* an instance, and meaningful only there. A bare string,
 *   deliberately: `gpt-5.6-sol` is a name OpenCode's catalogue gives, `claude-sonnet-4-5`
 *   is one Claude Code's does, and neither is resolvable without knowing which instance
 *   was asked.
 *
 * ## Why the driver is an open branded slug and not a literal union
 *
 * A union of `"opencode" | "claude-code"` would make adding a third harness a type change
 * in this file, in the persistence layer, in the contract and in every exhaustive `switch`
 * the compiler then demanded — and the whole point of this slice is that adding a harness
 * should be one new module providing {@link AgentHarness}. So it is a validated slug with
 * a brand on top: the brand keeps a driver from being passed where an instance id is
 * wanted (they are structurally identical and semantically unrelated), and the validation
 * keeps the slug to something safe to put in a filename, a log line or a database column.
 *
 * The brand is a *type*-level guard and adds no runtime check of its own
 * (`effect/src/Schema.ts`, `brand`: "only narrows the TypeScript output type"), which is
 * why the checks hang off the slug schema underneath it rather than off the brand.
 *
 * ## What is persisted, and what is re-derived
 *
 * An attempt row stores `{ instanceId, model }` — see `persistence/migrations.ts`'s
 * `0014_attempt_harness_instance` — and **never the driver**. The driver is re-derived
 * from the instance in the process's current snapshot, because it is a fact about
 * configuration rather than about the run: an operator who renames or reconfigures an
 * instance has not changed what that attempt did, and a stored driver would be a second
 * copy of the same fact, free to disagree with the first.
 *
 * What that costs is stated rather than hidden: an attempt whose instance is no longer
 * configured in *this* process has no derivable driver, and the honest answer there is "we
 * cannot tell", which is exactly what `recovery/harnessStatus.ts` records. Storing the
 * driver would have turned that into a confident answer about a harness nobody can ask.
 */
import type { HarnessModelView } from "@bit/contracts";
import { Schema } from "effect";

/**
 * The shape both identities share: a short, trimmed, filename-safe slug.
 *
 * Bounded at 64 characters and opened with a letter so a value is usable unquoted in a
 * path, a log line and a SQL column without anybody having to think about escaping. The
 * pattern is deliberately narrow — an instance id an operator will configure by hand is
 * better refused early than silently accepted and then found in a directory name.
 */
const HARNESS_SLUG_MAX_CHARS = 64;

const slug = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(HARNESS_SLUG_MAX_CHARS),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);

/** The kind of harness. Open: a new one is a new slug, not a type change. */
export const DriverKind = slug.pipe(Schema.brand("HarnessDriverKind"));
export type DriverKind = typeof DriverKind.Type;

/** One configured account or configuration of a driver. The routing key. */
export const InstanceId = slug.pipe(Schema.brand("HarnessInstanceId"));
export type InstanceId = typeof InstanceId.Type;

/** `opencode serve` plus a client over it (`harness/openCodeClient.ts`). */
export const OPENCODE_DRIVER: DriverKind = DriverKind.make("opencode");

/** The Claude Agent SDK (`harness/claudeCodeClient.ts`). */
export const CLAUDE_CODE_DRIVER: DriverKind = DriverKind.make("claude-code");

/** `pi --mode rpc`, one process per session (`harness/piClient.ts`). */
export const PI_DRIVER: DriverKind = DriverKind.make("pi");

/**
 * The instance id a driver's one stock configuration gets: the driver slug itself.
 *
 * T3Code's `defaultInstanceIdForDriver` does the same thing and for the same reason
 * (`packages/contracts/src/providerInstance.ts:92`): it makes a world that has never
 * configured a second account indistinguishable from one that has no concept of accounts,
 * so the step from one to many is configuration rather than a migration. The two brands
 * stay distinct, so this conversion has to be written down where it happens.
 */
export const defaultInstanceIdForDriver = (driver: DriverKind): InstanceId =>
  InstanceId.make(driver);

/**
 * Whether the instance can actually talk to its provider.
 *
 * `unknown` is a real answer and the common one, which is why it is a third case rather
 * than a `false`. Neither harness offers a cheap, non-destructive "am I logged in" probe:
 * `opencode serve` starts happily without provider credentials and only fails at prompt
 * time, and the Claude Agent SDK's `accountInfo()` needs a live session. Reporting
 * `unauthenticated` on that basis would be a guess, and reporting `authenticated` would be
 * worse.
 */
export type HarnessAuthStatus = "authenticated" | "unauthenticated" | "unknown";

/**
 * One configured harness, as this process found it.
 *
 * **Capability flags live here, not on the driver**, because what varies is the
 * configuration: two OpenCode instances can disagree about whether they are logged in,
 * and nothing about the driver can say which.
 *
 * The set is deliberately small. Every field below is either identity, or a value this
 * process actually observed while building the harness, or the one piece of configuration
 * a run cannot proceed without. Nothing here is a flag added in anticipation of a branch:
 * a flag nobody reads is a claim nobody checks.
 */
export interface HarnessInstance {
  /** What everything routes by, and what an attempt row stores. */
  readonly instanceId: InstanceId;
  /** Re-derived from {@link instanceId}; never stored against a run. */
  readonly driver: DriverKind;
  /** For an operator's screen. Never an identity. */
  readonly displayName: string;
  /**
   * The harness's own version string, as it reported it.
   *
   * Observed, not configured: `opencode serve`'s `/api/info` answers one, and the Claude
   * Agent SDK package declares the Claude Code build it carries. It is here because
   * "which build ran this" is the first question asked of a run that behaved oddly.
   */
  readonly version: string;
  /**
   * Whether the harness was brought up at all.
   *
   * Always `true` on an instance this process is holding — a driver that could not be
   * started never produces one, and `main.ts` logs that and serves without it. The field
   * exists so slice C's picker can show a configured-but-unusable instance without
   * inventing a representation for it.
   */
  readonly installed: boolean;
  /** See {@link HarnessAuthStatus} on why this is usually `unknown`. */
  readonly auth: HarnessAuthStatus;
  /**
   * The model a run gets when the caller names none.
   *
   * Configuration rather than capability, and required rather than optional: an instance
   * that could not answer "which model" could not run anything, and the picker's initial
   * selection for a newly chosen instance is this.
   */
  readonly defaultModel: string;
  /**
   * Every model name this instance will accept, in the form a run names one.
   *
   * **A value this process observed while building the harness, like {@link version}** —
   * which is why it is here rather than a thirteenth operation on `AgentHarness`. The
   * picker needs a list to search; the *seam* needs nothing of the sort, and a `models`
   * member on it would be a round trip per repaint for a fact that only changes when the
   * harness's own configuration does.
   *
   * What that costs, stated rather than hidden: a model added to the harness's catalogue
   * while this process is running is not in this list until a restart. For OpenCode that
   * means logging into a new provider needs a restart before its models can be picked; for
   * Claude Code the list is the SDK's own and does not move at all.
   *
   * Never empty: an instance that could not be asked reports `[defaultModel]`, because
   * "we could not read the catalogue" must not become "this instance can run nothing".
   * An operator may still name a model that is not here — the harness refuses it, and that
   * refusal is the harness's to give rather than ours to guess at.
   *
   * **Entries carry what each model offers**, not just its name: a model's option
   * descriptors are observed in the same breath as the model itself and belong to it
   * (`@bit/contracts`'s `modelOption.ts`). The contract's shape is reused verbatim here
   * rather than restated, because this list is passed to the browser unchanged and a
   * second declaration would be a second thing to keep true.
   */
  readonly models: readonly HarnessModelView[];
  /**
   * Something the operator should know about a *ready* instance, in a sentence: today, a
   * Pi instance whose sessions run uncontained because the server could not reach the
   * systemd user manager (`piClient.ts`). Absent when there is nothing to say.
   */
  readonly notice?: string | undefined;
}

/**
 * Which provider and which model actually ran, for an attempt row.
 *
 * Kept as two fields because that is what the evidence already records, and because the
 * two harnesses genuinely disagree about where the split lives: OpenCode routes a model
 * through a named provider of its own (`openai/gpt-5.6-sol`), while Claude Code has one.
 * Deriving it is therefore the harness's job and not the supervisor's — see
 * {@link AgentHarness.modelProvenance}.
 */
export interface ModelProvenance {
  readonly providerId: string;
  readonly modelId: string;
}
