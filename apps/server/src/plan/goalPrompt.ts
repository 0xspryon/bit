/**
 * What the goal agent is told before the operator's first word, and nothing after it.
 *
 * ## One preamble, on the first message only
 *
 * A goal conversation is **one session**, created on the first message and prompted again
 * for every later one (`plan/goalConversation.ts`). So this framing is sent exactly once,
 * ahead of the operator's first message, and every message after it travels **verbatim** —
 * no wrapper, no restated rules, no "the operator says". The session already has this text
 * in its own history, which is the whole reason it is a session and not a fresh prompt per
 * turn, and a preamble repeated per turn would be both a cost and an invitation to drift
 * from the copy above it.
 *
 * ## Why it is this short
 *
 * It does not restate what each tool does: the MCP client puts every tool's own description
 * and schema in front of the model, and those descriptions are written to be read
 * (`mcp/goalTools.ts`). Repeating them here would be two sources for one rule and the copy
 * is what drifts. What this says is the part no tool description can: who the agent is
 * talking to, which goal it is on, that it cannot create intents itself, and what it must
 * not claim.
 *
 * It does **not** paste the briefing in either, unlike a planner round's prompt. A round is
 * prompted once and never again, so its one prompt has to carry everything; this agent can
 * call `get_goal_briefing` when the conversation needs it, and a first message of
 * "is anything running?" should not cost a full record.
 */

/**
 * Where the framing stops and the operator starts, as one string.
 *
 * **It is a delimiter rather than a convention, and it is load-bearing in two directions.**
 * Downwards, it is the last thing the agent reads before the operator's words, so the model
 * is told plainly which half of its first prompt is this server's and which is a person's.
 * Upwards, it is what lets `plan/goalNarration.ts` **trim the framing out of a replay**: the
 * harness stores the whole first prompt as one `user` message, and replaying it put ~2.4 KB
 * of preamble into the operator's chat as a conversation turn, with their own sentence at
 * the bottom of it.
 *
 * That is the same technique `plan/roundPrompt.ts` uses for a round's prompt
 * (`ROUND_PROMPT_MARKER`), and the reason it is the right one here too: there is nothing to
 * guess. The boundary is a fixed string this module writes and the operator's text is
 * appended after it unaltered, so {@link operatorTextOf} is an exact split rather than a
 * heuristic over somebody's prose.
 *
 * Built from constants and used by {@link goalAgentPreamble} rather than written twice, so
 * the split cannot drift from the text it splits.
 */
export const GOAL_PROMPT_DELIMITER = `THE OPERATOR'S MESSAGE FOLLOWS.\n\n${"-".repeat(70)}\n\n`;

/**
 * The operator's own words out of a stored first prompt, or `undefined`.
 *
 * `undefined` for anything that is not one of this module's opening prompts — a later
 * message, which travels verbatim and has no framing to remove, or an entry from some other
 * build. A caller that gets `undefined` must show the text as it is: inventing a boundary
 * would be rewriting a stored message.
 */
export const operatorTextOf = (text: string): string | undefined => {
  const at = text.indexOf(GOAL_PROMPT_DELIMITER);
  return at < 0 ? undefined : text.slice(at + GOAL_PROMPT_DELIMITER.length);
};

/**
 * The opening framing, above the operator's first message.
 *
 * `objective` is the goal's own `description` — the operator's words for what they are
 * trying to establish — and `name` is the short label, which is often empty. Both are
 * included rather than one, because the label is what the operator calls the goal in
 * conversation and the objective is what the goal *is*.
 */
export const goalAgentPreamble = (input: {
  readonly goalId: string;
  readonly targetName: string;
  readonly name: string;
  readonly objective: string;
}): readonly string[] => [
  `You are the goal agent in bit, a security-testing tool. You are talking to the`,
  `operator — a person — about one goal, and this conversation is the surface they`,
  `opened to work it.`,
  ``,
  `THE TARGET is '${input.targetName}'. THE GOAL is ${input.goalId}${
    input.name === "" ? "" : `, which they call "${input.name}"`
  }.`,
  `Its objective, in their words:`,
  ``,
  input.objective,
  ``,
  `WHAT YOU DO`,
  ``,
  `You hold the long view of this goal and you steer the work. The investigation runs`,
  `in two other kinds of agent, and you are neither of them: a PLANNER ROUND decides`,
  `what to investigate next and creates intents, and a WORKER runs one intent and`,
  `records what it observed. You talk to the operator, read the record, and tell the`,
  `planner what to take into account.`,
  ``,
  `YOU CANNOT CREATE AN INTENT. There is no tool here that does it, and that is`,
  `deliberate: the rules that make an intent worth having — a round's budget, the rule`,
  `that an intent anchors only to recorded evidence, and the refusal of a second live`,
  `intent on one question — are enforced where intents are written. Use steer_planner`,
  `and say what you want investigated. The planner decides, and may disagree with you;`,
  `that is a legitimate outcome to report rather than something to work around.`,
  ``,
  `HOW TO WORK`,
  ``,
  `1. When the operator asks what is happening, read before answering: list_intents`,
  `   and list_attempts say what work exists and what is out, list_observations says`,
  `   what has been established, and list_open_questions says what is left.`,
  `2. When they want something investigated, call steer_planner with it in your own`,
  `   full sentences. It reaches a round that is already running, or opens one.`,
  `3. Tell them what actually happened, including a refusal. "A round is already`,
  `   planning this goal, so I steered that one" is an answer; silence is not.`,
  ``,
  `WHAT YOU MUST NOT CLAIM`,
  ``,
  `An observation's outcome speaks to its own tested claim under the cases that were`,
  `run. 'negative' means that claim was not supported in those cases — it is NEVER`,
  `"the system is safe", and reporting it that way to the operator would be the worst`,
  `mistake available to you. 'inconclusive' means the test could not decide. An`,
  `attempt that is 'uncertain' is one nobody could get an answer about, not one that`,
  `failed.`,
  ``,
  `Do not say work is underway because you asked for it. A steer is taken into account`,
  `by a planner; an intent is run by a worker later. list_attempts is what says`,
  `something is actually running.`,
  ``,
  `IF YOUR TOOLS ARE NOT THERE`,
  ``,
  `Your tools arrive over MCP and there is a known timing fault in the harness: on a`,
  `first turn they are occasionally not yet in your tool list. Say so plainly and ask`,
  `the operator to send the message again. Do not answer from guesswork about the`,
  `goal's state — you have no other source for it, and a guess is indistinguishable`,
  `from a reading to the person asking.`,
  ``,
  // The one place the framing ends. Spelled from {@link GOAL_PROMPT_DELIMITER} so the
  // string a replay splits on is the string this prompt actually contains.
  ...GOAL_PROMPT_DELIMITER.split("\n").slice(0, -1),
];

/**
 * The whole first prompt: the framing, then the operator's words.
 *
 * The operator's text is appended **unaltered and last**. Nothing is inserted into it and
 * nothing is wrapped around it, so an instruction that looks like part of the framing
 * cannot be made to look like part of the framing by where it sits — it is always below the
 * separator line, and the preamble says so.
 */
export const assembleGoalOpeningPrompt = (input: {
  readonly goalId: string;
  readonly targetName: string;
  readonly name: string;
  readonly objective: string;
  readonly message: string;
}): string => [...goalAgentPreamble(input), input.message].join("\n");
