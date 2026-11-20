/**
 * Which harness instances this server drives, from a file the operator names.
 *
 * `HARNESS` names *drivers*, and a driver named there gets exactly one stock instance
 * (`identity.ts`, `defaultInstanceIdForDriver`). That is the world before instances were
 * configurable, and it stays exactly as it was when {@link HARNESS_INSTANCES_SETTING} is
 * unset. When it is set, the file it names decides — every instance, its id, its name and,
 * for Claude Code, the configuration folder it runs from — and `HARNESS` is ignored, which
 * the startup log says.
 *
 * ## What an instance is, for Claude Code
 *
 * One `CLAUDE_CONFIG_DIR` (operator decision, 2026-11-10). The CLI reads its login, its
 * provider settings (`settings.json`'s `env`, which is how a z.ai instance points the CLI at
 * another API) and its transcripts from that folder, and nothing else differs between two
 * instances. Measured on this branch (`spike/ccInstancesProbe.ts`): two sessions on two
 * folders run side by side in one process when each CLI gets its own `CLAUDE_CONFIG_DIR`.
 *
 * **The file holds no secrets, and bit reads none.** Only paths and labels: an instance's
 * key stays in its own folder, which only the CLI that bit spawns reads. Nothing here opens
 * `settings.json`; the folder is checked to exist and is otherwise passed on as a path.
 *
 * ## The shape
 *
 * ```json
 * { "instances": [
 *   { "id": "claude-code", "driver": "claude-code" },
 *   { "id": "cc-zai", "driver": "claude-code", "displayName": "Claude Code · z.ai",
 *     "configDir": "/abs/path/cc_z_ai", "provider": "zai",
 *     "models": [ { "id": "opus", "label": "GLM-5.3", "reportedAs": "glm-5.3" },
 *                 { "id": "sonnet", "label": "GLM-5.3 Flash", "reportedAs": "glm-5.3-flash" } ],
 *     "defaultModel": "sonnet", "maxRetries": 1 },
 *   { "id": "opencode", "driver": "opencode" },
 *   { "id": "pi-zai", "driver": "pi", "displayName": "Pi · z.ai",
 *     "models": [ { "id": "zai/glm-5.3-flash", "label": "GLM-5.3 Flash" } ] }
 * ] }
 * ```
 *
 * - **Order is preference.** The resolver's default is the first *ready* instance, so the
 *   first entry is the default whenever it comes up.
 * - `id` follows `identity.ts`'s slug rule and is unique; it is what every attempt and
 *   conversation row stores, so renaming one strands what was recorded under the old id.
 * - `displayName` is what the picker and the model chip show. Unique (case ignored), so two
 *   instances of one driver never read the same. Defaults to the driver's own name for the
 *   instance whose id *is* the driver slug, and to `Name (id)` otherwise.
 * - `configDir` (Claude Code): an absolute path to an existing folder, handed to the CLI
 *   as `CLAUDE_CONFIG_DIR`. Absent: the CLI uses whatever the server's environment says,
 *   which is today's behaviour.
 * - `provider` (Claude Code): the label provenance records as the provider. `anthropic`
 *   when absent.
 * - `models` (Claude Code): the picker's catalogue, in the spelling a run asks with — for
 *   an aliasing instance the aliases (`sonnet`), since those are what the instance's
 *   settings map. `label` is what a screen shows; `reportedAs` is the spelling the CLI's
 *   frames name the model by (`glm-5.3-flash`), so a frame can be matched back to the
 *   entry before any session has said it (see `claudeCodeClient.ts`'s model spellings).
 *   Absent: the driver's own written-down list.
 * - `defaultModel`: one of `models` when both are given; the first model when only
 *   `models` is.
 * - `maxRetries` (Claude Code): handed to the CLI as `CLAUDE_CODE_MAX_RETRIES`. A provider
 *   that refuses with a 429 (z.ai's code 1113, no balance) is otherwise retried ten times
 *   over three minutes and more before the turn fails.
 *
 * - `agentDir` (Pi): an absolute path to an existing folder, handed to Pi as
 *   `PI_CODING_AGENT_DIR` — its `auth.json`, `models.json` and settings. Absent: the
 *   operator's own `~/.pi/agent`, as for Claude Code's `configDir`. bit never opens it.
 * - `binary` (Pi): the `pi` command to run; `pi` on the server's `PATH` when absent.
 * - `models` (Pi): `provider/model` ids as Pi names them (`zai/glm-5.3-flash`), with
 *   labels. Absent: every model Pi lists for the providers it holds credentials for, read
 *   once at startup (`piClient.ts`). Pi's frames name a model the way it was asked for, so
 *   there is no `reportedAs`.
 * - `memoryMax` (Pi): a cap on each session's systemd scope — Pi and everything it starts —
 *   in systemd's spelling (`2G`, `512M`: a whole number, then K, M, G or T), with no swap.
 *   A session over it is stopped whole and ends as a process death that says so
 *   (`userScopes.ts`). Absent: no cap. Not applied when the server runs without systemd.
 *
 * Unknown keys are refused rather than ignored: a misspelt `configdir` would otherwise run
 * the instance on the operator's default login without a word.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Schema } from "effect";

import {
  CLAUDE_CODE_DRIVER,
  InstanceId,
  OPENCODE_DRIVER,
  PI_DRIVER,
  type DriverKind,
} from "./identity";

/** The environment variable naming the file. Listed in `agentEnvironment.ts`'s catalogue. */
export const HARNESS_INSTANCES_SETTING = "HARNESS_INSTANCES";

const Trimmed = Schema.NonEmptyString.check(Schema.isTrimmed());

/** One model in a configured catalogue. */
const ConfiguredModel = Schema.Struct({
  id: Trimmed,
  label: Schema.optionalKey(Trimmed),
  reportedAs: Schema.optionalKey(Trimmed),
});
export type ConfiguredModel = typeof ConfiguredModel.Type;

const ClaudeCodeEntry = Schema.Struct({
  id: InstanceId,
  driver: Schema.Literal("claude-code"),
  displayName: Schema.optionalKey(Trimmed),
  configDir: Schema.optionalKey(Trimmed),
  provider: Schema.optionalKey(Trimmed),
  models: Schema.optionalKey(Schema.NonEmptyArray(ConfiguredModel)),
  defaultModel: Schema.optionalKey(Trimmed),
  maxRetries: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});

const OpenCodeEntry = Schema.Struct({
  id: InstanceId,
  driver: Schema.Literal("opencode"),
  displayName: Schema.optionalKey(Trimmed),
  defaultModel: Schema.optionalKey(Trimmed),
});

/** A Pi model: `provider/model`, as Pi's `--model` takes it. */
const PiModel = Schema.Struct({
  id: Trimmed.check(
    Schema.isPattern(/^[^/\s]+\/\S+$/, {
      message: "a Pi model is named provider/model, like zai/glm-5.3-flash",
    }),
  ),
  label: Schema.optionalKey(Trimmed),
});
export type PiModel = typeof PiModel.Type;

const PiEntry = Schema.Struct({
  id: InstanceId,
  driver: Schema.Literal("pi"),
  displayName: Schema.optionalKey(Trimmed),
  binary: Schema.optionalKey(Trimmed),
  agentDir: Schema.optionalKey(Trimmed),
  models: Schema.optionalKey(Schema.NonEmptyArray(PiModel)),
  defaultModel: Schema.optionalKey(Trimmed),
  memoryMax: Schema.optionalKey(
    Trimmed.check(
      Schema.isPattern(/^[1-9][0-9]*[KMGT]?$/, {
        message:
          "a memory limit is a whole number of bytes, or of K, M, G or T, like 2G",
      }),
    ),
  ),
});

/** The file's outer shape. Entries are decoded one at a time, by driver, for the sentence. */
const InstancesFile = Schema.Struct({
  instances: Schema.Array(Schema.Unknown),
});

/** A Claude Code instance, as configured. */
export interface ClaudeCodeInstanceConfig {
  readonly driver: "claude-code";
  readonly id: InstanceId;
  readonly displayName: string;
  readonly configDir: string | undefined;
  readonly provider: string | undefined;
  readonly models: readonly ConfiguredModel[] | undefined;
  readonly defaultModel: string | undefined;
  readonly maxRetries: number | undefined;
}

/** An OpenCode instance, as configured. At most one: it is one `opencode serve`. */
export interface OpenCodeInstanceConfig {
  readonly driver: "opencode";
  readonly id: InstanceId;
  readonly displayName: string;
  readonly defaultModel: string | undefined;
}

/** A Pi instance, as configured. Any number: each session is its own process. */
export interface PiInstanceConfig {
  readonly driver: "pi";
  readonly id: InstanceId;
  readonly displayName: string;
  readonly binary: string | undefined;
  readonly agentDir: string | undefined;
  readonly models: readonly PiModel[] | undefined;
  readonly defaultModel: string | undefined;
  /** The cap on each session's scope (`2G`); `undefined` for none. */
  readonly memoryMax: string | undefined;
}

export type InstanceConfig =
  ClaudeCodeInstanceConfig | OpenCodeInstanceConfig | PiInstanceConfig;

/**
 * The models of a Claude Code instance with its own config folder that name no
 * `reportedAs`, per instance, for a startup line (slice 1 review, L1).
 *
 * Such an instance's settings may map a model to a provider's own name (z.ai answers
 * `glm-5.3-flash` for `sonnet`). bit learns that from a live session, but a replay after a
 * restart runs before the session says anything, so its turns show the provider's name
 * until the session runs again. bit never opens the folder's settings to find out, so all
 * it can do is say which models it has no spelling for. An instance whose models are the
 * provider's own names needs none; the line is a prompt to check, not an error.
 */
export const modelsWithoutSpelling = (
  config: readonly InstanceConfig[],
  /**
   * The provider names a session has already reported for an instance's models, kept across
   * restarts (`learnedModelNames.ts`). A model named there is not listed: its name is known
   * (follow-ups B review, finding 2). Absent: nothing has been learned.
   */
  learned: (instanceId: string) => ReadonlyMap<string, string> = () =>
    new Map(),
): readonly { readonly id: string; readonly models: readonly string[] }[] =>
  config.flatMap((entry) => {
    if (entry.driver !== "claude-code" || entry.configDir === undefined)
      return [];
    const names = learned(entry.id);
    // No `models` at all: the stock catalogue, which declares no spellings either. Said as
    // an empty list, for the caller to word — unless a session has already reported names.
    if (entry.models === undefined)
      return names.size > 0 ? [] : [{ id: entry.id, models: [] }];
    const missing = entry.models
      .filter((model) => model.reportedAs === undefined && !names.has(model.id))
      .map((model) => model.id);
    return missing.length === 0 ? [] : [{ id: entry.id, models: missing }];
  });

/** What reading the file came to: the instances, or one sentence naming what is wrong. */
export type InstanceConfigResult =
  | {
      readonly _tag: "configured";
      readonly instances: readonly InstanceConfig[];
    }
  | { readonly _tag: "invalid"; readonly sentence: string };

/** What a folder check answers. Injected so a test need not lay out folders. */
export type FolderCheck = (path: string) => "folder" | "missing" | "not_folder";

const liveFolderCheck: FolderCheck = (path) => {
  try {
    return statSync(path).isDirectory() ? "folder" : "not_folder";
  } catch {
    return "missing";
  }
};

const DRIVER_NAMES: ReadonlyMap<string, string> = new Map([
  [CLAUDE_CODE_DRIVER, "Claude Code"],
  [OPENCODE_DRIVER, "OpenCode"],
  [PI_DRIVER, "Pi"],
]);

/**
 * `["instances"][1]["models"][0]["id"]` → `instances[1].models[0].id`: the path a Schema
 * failure names, in the spelling an operator reads a JSON file in.
 */
const readablePath = (path: string): string =>
  path.replace(/\["([^"]*)"\]/g, ".$1").replace(/^\./, "");

/** A Schema failure's message as `<path>: <what was expected>`. */
const schemaSentence = (prefix: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const [expected = message, ...rest] = message.split("\n");
  const at = rest
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  const path = at === undefined ? "" : readablePath(at.slice(3));
  const where = [prefix, path]
    .filter((part) => part !== "")
    .join(prefix !== "" && path !== "" ? "." : "");
  return `${where === "" ? "" : `${where}: `}${expected.trim()}`;
};

const decodeFile = Schema.decodeUnknownSync(InstancesFile);
const decodeClaudeCode = Schema.decodeUnknownSync(ClaudeCodeEntry);
const decodeOpenCode = Schema.decodeUnknownSync(OpenCodeEntry);
const decodePi = Schema.decodeUnknownSync(PiEntry);
const STRICT = { onExcessProperty: "error" } as const;

/**
 * Decodes the file's text. Pure but for the folder check, so a test drives every refusal.
 *
 * `source` is the file's path, for the sentence. Every refusal is one sentence that names
 * the file and the field, because it is printed once at startup and the server stops.
 */
export const decodeInstanceConfig = (
  text: string,
  source: string,
  folder: FolderCheck = liveFolderCheck,
): InstanceConfigResult => {
  const invalid = (detail: string): InstanceConfigResult => ({
    _tag: "invalid",
    sentence: `${HARNESS_INSTANCES_SETTING} names ${source}, which is not a usable instance file: ${detail}`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid(
      `it is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let entries: readonly unknown[];
  try {
    entries = decodeFile(parsed, STRICT).instances;
  } catch (error) {
    return invalid(schemaSentence("", error));
  }
  if (entries.length === 0) {
    return invalid(
      "instances: lists no instance; name at least one, or unset the variable to use HARNESS",
    );
  }

  const instances: InstanceConfig[] = [];
  for (const [index, raw] of entries.entries()) {
    const at = `instances[${String(index)}]`;
    const driver =
      typeof raw === "object" && raw !== null && "driver" in raw
        ? (raw as { driver: unknown }).driver
        : undefined;
    if (driver === CLAUDE_CODE_DRIVER) {
      let entry: typeof ClaudeCodeEntry.Type;
      try {
        entry = decodeClaudeCode(raw, STRICT);
      } catch (error) {
        return invalid(schemaSentence(at, error));
      }
      if (entry.configDir !== undefined) {
        if (!isAbsolute(entry.configDir)) {
          return invalid(
            `${at}.configDir: '${entry.configDir}' is not an absolute path`,
          );
        }
        const found = folder(entry.configDir);
        if (found !== "folder") {
          return invalid(
            `${at}.configDir: '${entry.configDir}' ${found === "missing" ? "does not exist" : "is not a folder"}`,
          );
        }
      }
      const models = entry.models;
      if (models !== undefined) {
        const seen = new Set<string>();
        for (const [position, model] of models.entries()) {
          if (seen.has(model.id)) {
            return invalid(
              `${at}.models[${String(position)}].id: '${model.id}' is listed twice`,
            );
          }
          seen.add(model.id);
        }
        if (entry.defaultModel !== undefined && !seen.has(entry.defaultModel)) {
          return invalid(
            `${at}.defaultModel: '${entry.defaultModel}' is not one of the instance's models (${[...seen].join(", ")})`,
          );
        }
      }
      instances.push({
        driver: "claude-code",
        id: entry.id,
        displayName:
          entry.displayName ?? defaultDisplayName(entry.id, entry.driver),
        configDir: entry.configDir,
        provider: entry.provider,
        models,
        defaultModel: entry.defaultModel ?? models?.[0]?.id,
        maxRetries: entry.maxRetries,
      });
    } else if (driver === OPENCODE_DRIVER) {
      let entry: typeof OpenCodeEntry.Type;
      try {
        entry = decodeOpenCode(raw, STRICT);
      } catch (error) {
        return invalid(schemaSentence(at, error));
      }
      if (instances.some((each) => each.driver === "opencode")) {
        return invalid(
          `${at}.driver: only one opencode instance can be configured, since it is one 'opencode serve' this server owns`,
        );
      }
      instances.push({
        driver: "opencode",
        id: entry.id,
        displayName:
          entry.displayName ?? defaultDisplayName(entry.id, entry.driver),
        defaultModel: entry.defaultModel,
      });
    } else if (driver === PI_DRIVER) {
      let entry: typeof PiEntry.Type;
      try {
        entry = decodePi(raw, STRICT);
      } catch (error) {
        return invalid(schemaSentence(at, error));
      }
      if (entry.agentDir !== undefined) {
        if (!isAbsolute(entry.agentDir)) {
          return invalid(
            `${at}.agentDir: '${entry.agentDir}' is not an absolute path`,
          );
        }
        const found = folder(entry.agentDir);
        if (found !== "folder") {
          return invalid(
            `${at}.agentDir: '${entry.agentDir}' ${found === "missing" ? "does not exist" : "is not a folder"}`,
          );
        }
      }
      const models = entry.models;
      if (models !== undefined) {
        const seen = new Set<string>();
        for (const [position, model] of models.entries()) {
          if (seen.has(model.id)) {
            return invalid(
              `${at}.models[${String(position)}].id: '${model.id}' is listed twice`,
            );
          }
          seen.add(model.id);
        }
        if (entry.defaultModel !== undefined && !seen.has(entry.defaultModel)) {
          return invalid(
            `${at}.defaultModel: '${entry.defaultModel}' is not one of the instance's models (${[...seen].join(", ")})`,
          );
        }
      }
      instances.push({
        driver: "pi",
        id: entry.id,
        displayName:
          entry.displayName ?? defaultDisplayName(entry.id, entry.driver),
        binary: entry.binary,
        agentDir: entry.agentDir,
        models,
        defaultModel: entry.defaultModel ?? models?.[0]?.id,
        memoryMax: entry.memoryMax,
      });
    } else {
      return invalid(
        `${at}.driver: ${
          typeof driver === "string"
            ? `'${driver}' is not a driver this build has`
            : "missing"
        } (it has ${[...DRIVER_NAMES.keys()].join(", ")})`,
      );
    }
  }

  const ids = new Map<string, number>();
  const names = new Map<string, number>();
  for (const [index, instance] of instances.entries()) {
    const sameId = ids.get(instance.id);
    if (sameId !== undefined) {
      return invalid(
        `instances[${String(index)}].id: '${instance.id}' is already the id of instances[${String(sameId)}]; ids must be unique`,
      );
    }
    ids.set(instance.id, index);
    const name = instance.displayName.toLowerCase();
    const sameName = names.get(name);
    if (sameName !== undefined) {
      return invalid(
        `instances[${String(index)}].displayName: '${instance.displayName}' is already the name of instances[${String(sameName)}]; give each instance its own, so the picker can tell them apart`,
      );
    }
    names.set(name, index);
  }
  return { _tag: "configured", instances };
};

const defaultDisplayName = (
  id: string,
  driver: DriverKind | string,
): string => {
  const name = DRIVER_NAMES.get(driver) ?? driver;
  return id === driver ? name : `${name} (${id})`;
};

/**
 * Reads {@link HARNESS_INSTANCES_SETTING}'s file, or says there is none to read.
 *
 * `undefined` when the variable is unset or blank: today's `HARNESS` behaviour applies.
 */
export const readInstanceConfig = (
  path: string | undefined,
  // Synchronous: the composition root reads its configuration at module scope, like every
  // other variable.
  read: (path: string) => string = (file) => readFileSync(file, "utf8"),
  folder: FolderCheck = liveFolderCheck,
): InstanceConfigResult | undefined => {
  if (path === undefined || path.trim() === "") return undefined;
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    return {
      _tag: "invalid",
      sentence: `${HARNESS_INSTANCES_SETTING} names ${path}, which could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return decodeInstanceConfig(text, path, folder);
};
