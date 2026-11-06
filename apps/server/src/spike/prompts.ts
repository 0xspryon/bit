/**
 * Worker and planner prompts for the spike.
 *
 * These deliberately state *what to test* and *how to report*, never what will be
 * found. The worker runs the requests itself and fills in what it saw; handing it the
 * expected answer would prove nothing about the seam.
 */

export interface WorkerPromptInput {
  readonly fixtureUrl: string;
  readonly account: string;
  readonly requestBudget: number;
  readonly toolName: string;
}

/** The shared rules about what an observation record must and must not contain. */
const recordingRules = (toolName: string): readonly string[] => [
  `Rules that matter more than being conclusive:`,
  `- \`outcome\` is relative to that one \`tested_claim\` only. "positive" means your`,
  `  requests supported it under the cases you recorded. "negative" means they did`,
  `  not support it under those cases — never a general "not vulnerable". If something`,
  `  broke, timed out, or you could not decide, use "inconclusive".`,
  `- An action's \`observed_behavior\` holds only what you actually saw for that step:`,
  `  status codes, counts, response bodies. Your reasoning goes in the top-level`,
  `  \`interpretation\`, across the cases. Keep them separate.`,
  `- \`client_identity\` must describe what you actually varied. You are changing a`,
  `  request header. That is not an IP address and must not be described as one.`,
  `- Each action's \`request_count\` is the number of requests that step sent, not a`,
  `  total for the whole task.`,
  `- \`setup\` describes the arrangement all your cases ran against, including whether`,
  `  you reset the fixture first.`,
  `- Some tool calls may be refused before they run. A refusal is`,
  `  information: report it, do not work around it. If the refusal stops you deciding`,
  `  the claim, record what you did reach and use "inconclusive".`,
  `- Call \`${toolName}\` to record. If it refuses with reason "stale", stop: your`,
  `  attempt is no longer the live one and nothing further will be recorded.`,
];

/**
 * The worker's assignment: probe the per-client limiter only.
 *
 * The account-level threshold is deliberately left alone. That uncertainty is what the
 * fresh session is later asked to pick up, so the briefing proof has somewhere real to
 * go (DECISIONS.md §15 steps 3-4).
 */
export const workerPrompt = (input: WorkerPromptInput): string =>
  [
    `You are a security testing worker on a local, purpose-built test fixture. Everything`,
    `you touch is on 127.0.0.1 and exists only for this experiment. Stay on it.`,
    ``,
    `# Broad objective (NOT yours to settle)`,
    `Determine whether authentication rate limits on this service can be bypassed, and`,
    `with what impact. You are not answering this. You are testing one narrow slice of it.`,
    ``,
    `# Your assignment`,
    `Investigate the PER-CLIENT request limiter on \`POST ${input.fixtureUrl}/login\`.`,
    ``,
    `The endpoint takes JSON \`{"account":"...","password":"..."}\` and reads a client`,
    `identity from the \`X-Client-Id\` request header. Credentials are always wrong by`,
    `design, so a \`401\` means your request was ADMITTED by the limiter and a \`429\``,
    `means it was REFUSED. Use account \`${input.account}\` throughout.`,
    ``,
    `Two specific claims to test, in order:`,
    ``,
    `1. "Sending a different X-Client-Id header value evades the per-client request`,
    `    limit observed on POST /login."`,
    `2. "Varying only the User-Agent header, with X-Client-Id held constant, evades that`,
    `    same per-client limit."`,
    ``,
    `Find the limit empirically. Do not assume a number.`,
    ``,
    `# Hard bounds`,
    `- Send at most ${input.requestBudget} requests in total across the whole task.`,
    `- Use \`curl\` from the shell. Count your requests as you go.`,
    `- \`POST ${input.fixtureUrl}/__fixture/reset\` clears all counters. It is a fixture`,
    `  control, not part of the system under test; do not treat using it as a finding.`,
    `- \`GET ${input.fixtureUrl}/__fixture/state\` shows the counters.`,
    `- Do NOT investigate any per-account limit. It is out of scope for this attempt,`,
    `  and leaving it untested is the correct outcome, not an omission.`,
    ``,
    `# Recording your work`,
    `Call the \`${input.toolName}\` tool exactly once per claim: two calls in total.`,
    `Use a distinct \`operation_id\` for each.`,
    ``,
    `Each call records ONE claim with one or more CASES under it. A case is one identity`,
    `or one ordering you tested the claim under. For claim 1, the saturation of a fixed`,
    `X-Client-Id and the request you then sent under a different one are naturally two`,
    `cases, or one case with the steps in order — your call, but the association between`,
    `each identity and what it got back must survive.`,
    ``,
    `Per case: give it an \`id\` and a \`purpose\`; list the \`actors\` you used, each with`,
    `an \`id\`, the \`account\` it acted as, its \`role\` (use null if that does not apply),`,
    `and \`client_identity\`; list \`actions\` IN THE ORDER YOU PERFORMED THEM, each naming`,
    `the \`actor_id\` that performed it, the \`endpoint\`, the \`method\`, its own`,
    `\`request_count\` and its own \`observed_behavior\`; then \`configuration\`,`,
    `\`window_start\`, \`window_end\`, \`test_bounds\` and any case \`limitations\`.`,
    ``,
    ...recordingRules(input.toolName),
    `- In \`untested_dimensions\`, record what you did not cover — including the`,
    `  per-account limit you were told to leave alone. Each line you put there becomes`,
    `  an open question with its own address that later work can take on, so write one`,
    `  dimension per entry rather than a paragraph.`,
    `- Send \`addresses_dimensions\` as an empty list. There are no earlier open`,
    `  questions for you to take on.`,
    ``,
    `Work through it with the shell, then record both observations. Finish by stating in`,
    `one or two sentences what you recorded.`,
  ].join("\n");

export interface FollowUpPromptInput {
  readonly fixtureUrl: string;
  readonly account: string;
  readonly requestBudget: number;
  readonly toolName: string;
  /** The address to cite, exactly as the control plane holds it. */
  readonly address: string;
  /** The recorded wording of the open question, verbatim. */
  readonly dimension: string;
}

/**
 * The follow-up worker's assignment: one named open question.
 *
 * The address is handed over verbatim rather than described, because the point of the
 * mechanism is that the worker cites an address it was given and nothing is matched by
 * wording. A worker that paraphrases its way to a different address gets a refusal.
 */
export const followUpPrompt = (input: FollowUpPromptInput): string =>
  [
    `You are a security testing worker on a local, purpose-built test fixture. Everything`,
    `you touch is on 127.0.0.1 and exists only for this experiment. Stay on it.`,
    ``,
    `# Broad objective (NOT yours to settle)`,
    `Determine whether authentication rate limits on this service can be bypassed, and`,
    `with what impact. You are not answering this. You are closing one recorded gap in it.`,
    ``,
    `# Your assignment: one open question from the control plane`,
    `An earlier attempt recorded this dimension as untested. Its address is`,
    `\`${input.address}\` and its recorded wording is:`,
    ``,
    `    ${input.dimension}`,
    ``,
    `Investigate that, and only that, on \`POST ${input.fixtureUrl}/login\`.`,
    ``,
    `The endpoint takes JSON \`{"account":"...","password":"..."}\` and reads a client`,
    `identity from the \`X-Client-Id\` request header. Credentials are always wrong by`,
    `design, so a \`401\` means your request was ADMITTED by the limiter and a \`429\``,
    `means it was REFUSED. The 429 body names which limiter refused you. Use account`,
    `\`${input.account}\` throughout.`,
    ``,
    `# Hard bounds`,
    `- Send at most ${input.requestBudget} requests in total across the whole task.`,
    `- Use \`curl\` from the shell. Count your requests as you go.`,
    `- \`POST ${input.fixtureUrl}/__fixture/reset\` clears all counters. It is a fixture`,
    `  control, not part of the system under test; do not treat using it as a finding.`,
    `- \`GET ${input.fixtureUrl}/__fixture/state\` shows the counters.`,
    `- If the budget runs out before you can decide, that is a real result: record what`,
    `  you reached as "inconclusive" and say what remains. Do not exceed the budget.`,
    ``,
    `# Recording your work`,
    `Call the \`${input.toolName}\` tool exactly once, with one \`tested_claim\` that states`,
    `what you actually tested about that dimension, and one or more cases under it.`,
    ``,
    `You MUST include this in the call, exactly as written:`,
    ``,
    `    "addresses_dimensions": ["${input.address}"]`,
    ``,
    `That is what records your work against that open question. The address is checked:`,
    `a value you invent, reword or truncate is refused and nothing is stored. Including`,
    `it does not close the question — it records that you took it on, and your outcome`,
    `says what came of it.`,
    ``,
    `Per case: give it an \`id\` and a \`purpose\`; list the \`actors\` you used, each with`,
    `an \`id\`, the \`account\` it acted as, its \`role\` (use null if that does not apply),`,
    `and \`client_identity\`; list \`actions\` IN THE ORDER YOU PERFORMED THEM, each naming`,
    `the \`actor_id\` that performed it, the \`endpoint\`, the \`method\`, its own`,
    `\`request_count\` and its own \`observed_behavior\`; then \`configuration\`,`,
    `\`window_start\`, \`window_end\`, \`test_bounds\` and any case \`limitations\`.`,
    ``,
    ...recordingRules(input.toolName),
    `- In \`untested_dimensions\`, record what this run still did not cover. One`,
    `  dimension per entry.`,
    ``,
    `Work through it with the shell, then record the observation. Finish by stating in`,
    `one or two sentences what you recorded and which address you cited.`,
  ].join("\n");

export interface PlannerPromptInput {
  readonly briefing: string;
}

/**
 * The fresh session's prompt.
 *
 * It gets the rendered briefing and nothing else — no transcript, no summary written
 * by the first session, no list of candidate follow-ups to pick from. It must read the
 * observations and propose its own next step, citing what it relied on.
 */
export const plannerPrompt = (input: PlannerPromptInput): string =>
  [
    `You are a planner picking up an in-progress investigation. You have no memory of`,
    `any earlier session and there is no conversation to read. The briefing below is the`,
    `complete record.`,
    ``,
    `---`,
    input.briefing,
    `---`,
    ``,
    `# Your task`,
    `Decide what to investigate next, then answer with exactly these five sections:`,
    ``,
    `NEXT: one sentence naming the single next investigation you would run.`,
    `CITES: the observation IDs your decision rests on.`,
    `GAP: the specific untested dimension your proposed work would close.`,
    `ADDRESSES: the exact address of that dimension, copied from the briefing's open`,
    `  questions — the bracketed value, for example obs_000003_attempt-x#u1. Copy it`,
    `  character for character; do not invent, shorten or reword one. If no open`,
    `  question matches what you propose, write NONE and say why in WHY.`,
    `WHY: two or three sentences. State what the recorded observations do and do not`,
    `  establish about the broad objective.`,
    ``,
    `Do not propose re-running work the briefing already covers unless you say what`,
    `changed condition makes it worth repeating. Do not treat any single recorded`,
    `observation as settling the broad objective. A question listed as "addressed with`,
    `evidence" is not settled: it has been worked on, and whether that is enough is part`,
    `of what you are judging.`,
  ].join("\n");
