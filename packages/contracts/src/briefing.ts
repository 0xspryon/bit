/**
 * The deterministic briefing contract (DECISIONS.md §17 lines 1631-1639).
 *
 * A briefing is rendered from control-plane state at a recorded graph sequence, not
 * from a previous session's transcript. Absent content must never imply absent graph
 * knowledge, so omissions are disclosed explicitly rather than silently truncated.
 *
 * Browser-safe: Effect Schema only.
 */
import { Schema } from "effect";

import { Observation } from "./observation";

export const Briefing = Schema.Struct({
  targetId: Schema.String,
  intentId: Schema.String,
  /** The broad objective. Finishing a slice does not settle it. */
  goal: Schema.String,
  /** The actionable investigation direction under that goal. */
  intent: Schema.String,
  /** The graph sequence this briefing was prepared at. */
  preparedAtSequence: Schema.Number,
  /** Bounded observations included in full. */
  observations: Schema.Array(Observation),
  /**
   * Observation IDs known to the graph but omitted from this briefing, so a reader
   * can tell truncation from absence of knowledge.
   */
  omittedObservationIds: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  /** Union of untested dimensions across included observations, deduplicated. */
  openQuestions: Schema.Array(Schema.String),
});
export type Briefing = typeof Briefing.Type;
