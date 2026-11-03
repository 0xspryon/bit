/**
 * The agents a conversation can run as, as the browser sees them.
 *
 * An agent is **what** a conversation is: the prompt it is opened with and the tools its
 * credential reaches. Which harness and model run it is a separate choice, made in the
 * harness modal. The server's registry (`apps/server/src/agent/registry.ts`) holds the
 * definitions; this is the part of one that a screen may show — its name and what it can
 * write — and nothing about its prompt or its grant, which are the server's to apply.
 *
 * Browser-safe: Effect Schema only.
 */
import { Schema } from "effect";

export const AgentView = Schema.Struct({
  /**
   * The agent's stable id, as a session row records it (`import_sessions.agent_id`).
   *
   * A string rather than a closed set of literals: the list is the server's and grows
   * without a contract change, and a session row naming an agent this build does not define
   * is something to show and refuse, not a decode failure.
   */
  id: Schema.String,
  /** Its name on the chip, for example "Importer". */
  label: Schema.String,
  /** What it can write, in one line, for the chip's list. */
  writes: Schema.String,
});
export type AgentView = typeof AgentView.Type;

export const AgentsView = Schema.Struct({
  /** Every agent this server defines, in the registry's order. */
  agents: Schema.Array(AgentView),
});
export type AgentsView = typeof AgentsView.Type;
