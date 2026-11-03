/**
 * The agents a conversation can run as: one generic definition, one registry.
 *
 * An agent is **what** a conversation is, as distinct from what runs it. The harness and the
 * model are chosen in the harness modal and can change; the agent is the prompt the
 * conversation is opened with and the authority its MCP credential grants, and it is fixed
 * once the first message is sent. A session row records it (`import_sessions.agent_id`,
 * `0002`), and a reopen reads it back from there instead of choosing again.
 *
 * ## What a definition holds
 *
 * - **`id`**, stable, because a row stores it. Renaming one strands every session recorded
 *   under the old id: {@link agentById} answers `undefined` for it and the reopen refuses.
 * - **`label`** and **`writes`**, which are all the browser sees of it (`AgentView`).
 * - **`prompt`**, the three messages a conversation can receive that are this server's
 *   rather than the operator's: the opener, a later message, and the first message into a
 *   session taken back over after a restart. Code, today: the importer's opener is assembled
 *   from the target, its pages and the operator's first words (`import/importerPrompt.ts`),
 *   and its text is unchanged by being reached through here.
 * - **`authority`**, the MCP grant its credential carries: the caller kind the credential is
 *   minted as, which is what an endpoint admits (`mcp/server.ts`'s `serves`), and the tools
 *   that endpoint serves. The tool list is read off the toolkit itself, not written out
 *   again here, so it cannot claim a tool the endpoint does not serve or miss one it does.
 *
 * ## One entry, and why the opener's input is the importer's
 *
 * The only conversation that records an agent is the importer's, so the only opener input
 * there is today is {@link ImporterPromptInput}. A definition is generic over it so that an
 * agent opened on something else declares its own input rather than bending this one; the
 * registry's own type pins the importer's because that is what its one caller passes.
 *
 * V2(chat): agents are defined in code and pinned per session. Proper V2: prompts stored as
 * editable, versioned data (the agent dashboard), and switching agent per message — which
 * means re-scoping the session's MCP credential to the new agent's authority and sending the
 * new agent's prompt mid-session, with the new agent reading the transcript so far.
 */
import type { AgentView } from "@bit/contracts";

import {
  assembleImporterFollowUpPrompt,
  assembleImporterPrompt,
  assembleImporterResumePrompt,
  type ImporterPromptInput,
} from "../import/importerPrompt";
import { ImporterToolkit } from "../mcp/importerTools";
import type { CallerContext } from "../persistence/store";

/** The messages a conversation receives that this server writes rather than the operator. */
export interface AgentPrompt<Opening> {
  /** The first message into a new session: the agent's whole framing, sent once. */
  readonly opening: (input: Opening) => string;
  /** A later message into the same session. The framing is already in its history. */
  readonly followUp: (input: { readonly message: string }) => string;
  /** The first message into a session resumed under a new grant after a restart. */
  readonly resume: (input: { readonly message: string }) => string;
}

/** The MCP grant an agent's session credential carries. */
export interface AgentAuthority {
  /**
   * The caller kind its credential is minted as. Each MCP endpoint admits one kind and
   * refuses every other with the same `401` as an unknown token, so this decides which
   * endpoint — and therefore which toolkit — the session can reach at all.
   */
  readonly role: CallerContext["_tag"];
  /** The tools that endpoint serves, by their bare names, in the toolkit's order. */
  readonly tools: readonly string[];
}

export interface AgentDefinition<Opening> {
  readonly id: string;
  readonly label: string;
  /** What it can write, in one line: the chip's list shows it. */
  readonly writes: string;
  readonly prompt: AgentPrompt<Opening>;
  readonly authority: AgentAuthority;
}

/**
 * The scope importer: reads a bug bounty program's pages and writes the scope it finds.
 *
 * Its authority is the importer endpoint's toolkit, unchanged: `add_scope_entry`,
 * `record_imported_asset` and `read_scope`, and no other tool anywhere (D13).
 */
export const IMPORTER_AGENT: AgentDefinition<ImporterPromptInput> = {
  id: "importer",
  label: "Importer",
  writes:
    "Scope entries and the hosts they name, from the program pages you give it",
  prompt: {
    opening: assembleImporterPrompt,
    followUp: assembleImporterFollowUpPrompt,
    resume: assembleImporterResumePrompt,
  },
  authority: {
    role: "importer",
    tools: Object.keys(ImporterToolkit.tools),
  },
};

/** Every agent this server defines, in the order a chip lists them. */
export const AGENTS: readonly AgentDefinition<ImporterPromptInput>[] = [
  IMPORTER_AGENT,
];

/**
 * The agent a session opens as when nothing chose another, and the one a row written before
 * agents were recorded reads as (`0002`'s column default).
 */
export const DEFAULT_AGENT_ID = IMPORTER_AGENT.id;

/** The definition with this id, or `undefined` for one this server does not define. */
export const agentById = (
  id: string,
): AgentDefinition<ImporterPromptInput> | undefined =>
  AGENTS.find((agent) => agent.id === id);

/** What the browser is shown of an agent: its id, its name and what it can write. */
export const agentView = (
  agent: Pick<AgentDefinition<never>, "id" | "label" | "writes">,
): AgentView => ({
  id: agent.id,
  label: agent.label,
  writes: agent.writes,
});
