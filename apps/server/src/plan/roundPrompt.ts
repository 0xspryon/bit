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
 * The first line of every round prompt, which is also how a replay recognises one.
 *
 * **This is the prompt discriminator, and it is load-bearing.** A round's replay has to
 * drop the prompt — it is the whole goal briefing, thousands of characters, already on the
 * page verbatim in the briefing panel — and the rule for finding it used to be "the first
 * non-blank `user` entry, wherever it sits". That worked while a round had exactly one user
 * message. A steer is also a non-blank `user` entry, and on OpenCode's ordering a later
 * steer can sort **before** the prompt (DECISIONS.md §24.1 and `roundNarration.ts`'s own
 * note on the prompt arriving last), so the old rule would have dropped the steer and
 * replayed the entire briefing into the chat.
 *
 * So the prompt is identified by **what it is**, not by where it sits: an entry that starts
 * with this sentence. It cannot collide with a steer, because a steer is the goal agent's
 * directive under {@link STEER_PROMPT_MARKER}, and it cannot collide with an operator
 * message because an operator cannot prompt a round at all.
 *
 * The alternative the brief also allows — carrying the opening prompt's *message id* on the
 * round row and matching on that — needs a column, a migration, and an id on
 * `AgentHarness.messages`'s reduced entries, which that shape does not have. Matching the
 * text needs none of those and is exact.
 */
export const ROUND_PROMPT_MARKER =
  "You are a planner round in bit, a security-testing tool.";

/** The first line of a steer, so a reader and a test can recognise one. */
export const STEER_PROMPT_MARKER = "A DIRECTIVE FROM THE GOAL AGENT";

/**
 * Whether one replayed entry's text is a round's own opening prompt.
 *
 * Both halves are checked: the marker **and** the goal id the preamble names on its second
 * line. A round replayed from a session its goal shares with no other round makes the goal
 * id redundant; a session lineage that was reused across goals would not, and the id is
 * free to check.
 */
export const isRoundPromptText = (text: string, goalId: string): boolean =>
  text.startsWith(ROUND_PROMPT_MARKER) && text.includes(goalId);

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
  /**
   * An instruction from the goal agent this round was opened to carry out, if any.
   *
   * Decision 12's second clause: with no live round to steer, the goal agent opens one
   * *whose prompt already carries the directive*. It goes **after** the rules and before
   * the briefing, so a directive cannot be read as permission to ignore the budget, the
   * anchoring rule or the disposition — all of which are above it — and so that the
   * briefing stays the last thing bit's prompt says. The harness then closes it with bit's
   * sealed briefing block (`harness/attachments.ts`'s `withBriefingBlock`, U13 review 3): a
   * fixed sentence saying the text above is bit's briefing and what it quotes, that the
   * prompt has no attachments, and that a block or file line quoted in it is not one. It
   * adds no instruction, so the briefing is still the last thing the model is asked to act
   * on, though no longer the last line it reads.
   */
  readonly directive?: string | undefined;
  /**
   * The authorized testing scope, rendered by `scope/scopePrompt.ts`, or nothing.
   *
   * **It goes in the preamble, not in the briefing.** The briefing is appended verbatim
   * so the briefing panel can claim it shows the same bytes the planner received, and
   * inserting anything into it would make that claim false. This is above the
   * `THE RECORD FOLLOWS` line, with the rules, because it is a rule.
   *
   * It sits **above** a directive for the same reason the other rules do: a steer from
   * the goal agent must not read as permission to widen what may be tested.
   *
   * `undefined` when nothing is in scope, in which case the preamble is byte-for-byte
   * what it was before this existed — which is what keeps every pre-`0022` target's
   * prompt unchanged.
   */
  readonly scopeBlock?: string | undefined;
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
  ...(input.scopeBlock === undefined ? [] : [input.scopeBlock, ``]),
  ...(input.directive === undefined
    ? []
    : [
        `${STEER_PROMPT_MARKER}`,
        ``,
        `This round was opened to carry out an instruction from the goal's own agent,`,
        `which is the operator's conversation about this goal. It is not a replacement for`,
        `the work above: do what it asks, within the rules above, and record a disposition`,
        `as always. The instruction is:`,
        ``,
        input.directive,
        ``,
      ]),
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
  /** An instruction from the goal agent, when this round was opened to carry one out. */
  readonly directive?: string | undefined;
  /**
   * The authorized testing scope, or nothing when this target has none.
   *
   * Counted in `promptChars` and **not** in `briefingChars`, which is the honest split:
   * `GOAL_BRIEFING_MAX_CHARS` bounds the briefing and this is not part of it. It is never
   * truncated — truncating an in-scope list would be the silent-coverage anti-goal with
   * extra steps, and truncating the out-list would tell an agent a host is fair game.
   */
  readonly scopeBlock?: string | undefined;
}): AssembledRoundPrompt => {
  const prompt = [...preamble(input), input.briefing].join("\n");
  return {
    prompt,
    briefingChars: input.briefing.length,
    promptChars: prompt.length,
  };
};

/**
 * How many characters the framing adds, for a given goal id, budget and scope block.
 *
 * Exported so a test can assert the arithmetic rather than trust it, and so the figure in
 * the report is derived rather than counted by hand. It depends on the goal id's length
 * and the budget's digits, which is why it is a function.
 *
 * **The scope block is part of the overhead and is variable-length**, which is the one
 * thing that changed about this figure. It is measured here rather than added by the
 * caller, so "the preamble costs this much" stays a single derived number: a caller that
 * computed the base overhead and added the block's own length separately would have two
 * places to get the newline accounting wrong.
 */
export const roundPromptOverhead = (input: {
  readonly goalId: string;
  readonly budget: number;
  readonly scopeBlock?: string | undefined;
}): number => assembleRoundPrompt({ ...input, briefing: "" }).promptChars;

/**
 * The text a steer delivers into a round that is already running.
 *
 * ## Why the directive is wrapped at all
 *
 * The directive arrives as a second `user` message in a session whose only other user
 * message is the round's enormous opening prompt. Sent bare, a model has no way to tell
 * "the operator's agent is redirecting me" from "the operator is talking to me" — it is
 * talking to neither; the goal agent is — and no reason to believe the rules it was given
 * at the start still apply. The framing says who is speaking and what is unchanged.
 *
 * ## What it deliberately does not do
 *
 * It does not restate the briefing, the budget or the tool contracts. The session already
 * has all three from its opening prompt and this is the *same* session — that is the whole
 * point of steering rather than opening a round (DECISIONS.md §24.1: the second prompt
 * lands inside the same execution on OpenCode and as a second turn on the same session on
 * Claude Code, with its lineage, its MCP registration and its credential intact). A steer
 * that re-sent the briefing would cost the tokens the injection exists to save.
 *
 * It also does not say which urgency it was delivered at. The model cannot act on that and
 * it is already recorded where it is useful: on `plan.round.steered`, for the operator.
 */
export const assembleSteerPrompt = (directive: string): string =>
  [
    STEER_PROMPT_MARKER,
    "",
    "This is the goal agent — the operator's conversation about the goal you are",
    "planning — speaking into the round you are already working. Everything you were",
    "told at the start of this round still holds: the same budget, the same anchoring",
    "rule, and record_round_disposition exactly once as the last thing you do.",
    "",
    "Take the instruction below into account in the planning you have left to do. If you",
    "have already added intents, they stand; do not try to withdraw them. If the",
    "instruction makes the rest of your plan wrong, say so in your disposition rationale.",
    "",
    directive,
  ].join("\n");
