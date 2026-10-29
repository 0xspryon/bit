/**
 * The one prompt a planner round is opened with.
 *
 * It replaces slice 5's `STUB_ROUND_PROMPT`, which existed so the lifecycle could be
 * exercised end to end and which told the model, accurately for the time, that anything it
 * could see would refuse its credential. Both halves of that are now false: the round has
 * its own endpoint with its own tools, and those tools accept its credential.
 *
 * ## It is sent once, and that is the constraint everything here is shaped by
 *
 * `plan/planSupervisor.ts` never resubmits a prompt, on any path. So this text is the
 * round's only instruction: there is no second turn in which to correct it, no
 * clarification, and no operator in the loop. Three consequences, each visible below.
 *
 * - **The tool contracts are not restated.** Each tool's own description carries its
 *   rules, and the MCP client puts those in front of the model beside the schema.
 *   Repeating them here would be two sources for one rule, and the one that drifts is the
 *   copy. What this prompt does instead is say what the *round* is for and in what order
 *   to work.
 * - **It names what to do if the tools are absent.** DECISIONS.md §24.2 caveat 1 measured
 *   that an OpenCode registration can be connected and not yet callable — in 3 of 8 first
 *   prompts after a registration the model reported the tool was not exposed and the
 *   endpoint saw no call — and there is no API to read that registry, so the round cannot
 *   confirm exposure before prompting. It therefore has to **tolerate** a first-turn
 *   absence, which is a decision rather than a gap: the planner is told to say so and stop
 *   rather than to improvise, the round settles with `disposition: null`, and that is a
 *   distinguishable state. `McpCallCounter.countFor` is the other half, and
 *   `planSupervisor.ts`'s `settle` is what reads it: a round that settled with no
 *   disposition and made zero authenticated requests never had its tools, where one that
 *   made some had them and chose to say nothing. **That distinction reaches the settlement
 *   log line and `PlanRoundStopped`, and nothing durable** — the tally is in-process
 *   memory, so it is there for an operator reading logs when the round settles and is not
 *   recoverable from the rows later.
 * - **It insists on the disposition.** A round that adds intents and records nothing
 *   leaves an operator unable to tell "the planner is still thinking" from "the planner
 *   finished". The disposition is the round's answer and the prompt's last instruction.
 *
 * ## The briefing is pasted in, and the ceiling does not measure this
 *
 * `briefing/goalBriefing.ts` renders the goal at 100% and refuses above
 * `GOAL_BRIEFING_MAX_CHARS`. **That ceiling bounds the briefing, not this prompt.** The
 * framing below wraps it, so what the model receives is strictly larger than the number an
 * operator watched on the briefing panel. Rather than leave that to be inferred,
 * {@link assembleRoundPrompt} reports both lengths and `PlanRoundStarted` carries both
 * (`briefingChars`, `promptChars`); {@link roundPromptOverhead} is the difference for an
 * empty briefing, which is what makes the claim checkable in a test rather than a sentence
 * in a comment.
 */

/**
 * The framing above the briefing.
 *
 * `budget` and `goalId` are the two facts about *this* round that a planner cannot read
 * out of the graph: the budget is a column on the round row, and the goal is carried by
 * the credential rather than by any argument, so a model that could not see it named here
 * would have no way to talk about what it is planning.
 */
const preamble = (input: {
  readonly goalId: string;
  readonly budget: number;
}): readonly string[] => [
  `You are a planner round in bit, a security-testing tool. You are planning one goal:`,
  `${input.goalId}. One round is one bounded unit of planning work, and this is yours.`,
  ``,
  `WHAT A ROUND DOES`,
  ``,
  `Read the record below, decide what is worth investigating next, create intents for`,
  `those directions, and record what you concluded. You do not run anything: a worker`,
  `agent picks up each intent later and records observations under it. An intent is a`,
  `question a bounded test could speak to, not a task list and not a plan of work.`,
  ``,
  `You may create at most ${String(input.budget)} intent(s) in this round. Fewer is a`,
  `legitimate answer and zero is a legitimate answer. The budget is a property of this`,
  `round and cannot be raised; add_intent tells you how many remain, and refuses once`,
  `they are spent.`,
  ``,
  `HOW TO WORK`,
  ``,
  `1. Read the briefing below. It is the complete record of this goal — every intent`,
  `   and every observation under it, with nothing omitted.`,
  `2. Call list_open_questions. The briefing's open questions and this tool's answer`,
  `   agree, but the tool reads the graph LIVE: a worker may have recorded something`,
  `   since the briefing was built, and it gives you the exact dimension addresses`,
  `   add_intent takes.`,
  `3. If you are going to suggest a harness or a model on an intent, call`,
  `   list_harnesses first so the suggestion names something real. Suggestions are`,
  `   advisory and omitting them is fine.`,
  `4. Create your intents with add_intent, anchoring each to the observation it came`,
  `   out of, or to nothing at all if it is a new top-level direction.`,
  `5. Call record_round_disposition exactly once, last. THIS IS NOT OPTIONAL. A round`,
  `   that adds intents and records no disposition leaves nobody able to tell whether`,
  `   you finished. Record it even if you added nothing — 'waiting' and`,
  `   'no_useful_next_action' are the answers for that, and they are answers.`,
  ``,
  `WHAT TO AVOID`,
  ``,
  `Do not re-ask a question an intent already covers: list_open_questions shows which`,
  `dimensions already have work out, and add_intent refuses a second live intent on`,
  `one dimension naming what it collided with. Do not anchor an intent to another`,
  `intent — only a recorded observation may anchor one. Do not read 'negative' as`,
  `'safe': an outcome speaks to its own tested claim under the cases that were run.`,
  ``,
  `IF YOUR TOOLS ARE NOT THERE`,
  ``,
  `Your tools are registered with this session over MCP. If add_intent and`,
  `record_round_disposition are not in your tool list on this turn, the registration`,
  `has not reached you yet — it is a known timing fault in the harness, not something`,
  `you can fix and not something to work around. Say plainly that the planner tools`,
  `were not available and stop. Do not describe intents in prose instead: prose is not`,
  `a record, nobody will act on it, and a round that says so honestly is one an`,
  `operator can simply run again.`,
  ``,
  `THE RECORD FOLLOWS. Everything below this line is the briefing.`,
  ``,
  `----------------------------------------------------------------------`,
  ``,
];

/**
 * The prompt a planner round receives, and the two lengths that describe it.
 *
 * Both lengths are returned rather than recomputed by the caller, because the point of
 * carrying them is that they are measured on the string that was actually sent.
 */
export interface AssembledRoundPrompt {
  /** What is sent to the harness, once. */
  readonly prompt: string;
  /** The briefing's own length — the number `GOAL_BRIEFING_MAX_CHARS` bounds. */
  readonly briefingChars: number;
  /** The whole prompt's length. Always greater than {@link briefingChars}. */
  readonly promptChars: number;
}

/**
 * Wraps a rendered goal briefing in the round's framing.
 *
 * The briefing is appended verbatim and nothing is inserted into it, which is what lets
 * the briefing panel claim it shows the same bytes the planner gets. The objective is not
 * repeated above it either: `renderGoalBriefing` already prints it in the first lines,
 * under a heading that says it is the broad aim and is not settled by any single
 * observation, and a second copy in the preamble would be a second wording of the one
 * thing the round is about.
 */
export const assembleRoundPrompt = (input: {
  readonly goalId: string;
  readonly budget: number;
  readonly briefing: string;
}): AssembledRoundPrompt => {
  const prompt = [...preamble(input), input.briefing].join("\n");
  return {
    prompt,
    briefingChars: input.briefing.length,
    promptChars: prompt.length,
  };
};

/**
 * How many characters the framing adds, for a given goal id and budget.
 *
 * Exported so a test can assert the arithmetic rather than trust it, and so the figure in
 * the report is derived rather than counted by hand. It depends on the goal id's length
 * and the budget's digits, which is why it is a function.
 */
export const roundPromptOverhead = (input: {
  readonly goalId: string;
  readonly budget: number;
}): number => assembleRoundPrompt({ ...input, briefing: "" }).promptChars;
