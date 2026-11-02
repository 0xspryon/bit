/**
 * The "Agent sessions" list: three kinds of session folded into one shape at read time.
 *
 * **There is no table behind this**, and the reason is the one the importer-conversation
 * design's S8.2 gives: each kind's index row is written inside its own surface's
 * transaction — a goal session with the goal, an import session with the import, an attempt
 * with its attempt — so a shared table would make one write path the owner of three
 * surfaces' invariants, and its subject column would be a nullable triple with a `CHECK`
 * standing in for a type. This is a *read* concern. If a fourth table ever earns itself, this
 * file is the only thing that changes; the route's shape does not.
 *
 * Pure on purpose: the route does the reading and the asking of this process's registries,
 * and this function only decides what the answers *mean* — in particular which of `live`,
 * `ended` and `dormant` each kind's evidence supports. `AgentSessionState` says what each
 * claims.
 */
import type {
  AgentSessionView,
  AgentSessionsView,
  ImporterSessionEndReason,
} from "@bit/contracts";

/**
 * How many worker sessions are listed. Goal and importer sessions grow by an operator's
 * action; worker attempts grow with every intent the hunt runs, so this is the one kind that
 * is bounded, and `workersOmitted` says what the bound hid.
 */
export const WORKER_SESSIONS_LISTED = 100;

/** What `unionAgentSessions` needs from the three reads and from this process's registries. */
export interface AgentSessionSources {
  readonly goals: readonly {
    readonly goalId: string;
    readonly goalName: string;
    readonly harnessSessionId: string;
    readonly harnessInstanceId: string | null;
    readonly openedAt: number;
  }[];
  /** The goal conversation registry's answer for one goal, or `undefined` when not held. */
  readonly goalLive: (
    goalId: string,
  ) => { readonly sessionId: string; readonly model: string } | undefined;
  readonly importers: readonly {
    readonly harnessSessionId: string;
    readonly harnessInstanceId: string | null;
    readonly model: string;
    readonly openedAt: number;
    readonly latestImportId: string;
    /**
     * Whether this process **holds** the session: its scope, credential and MCP registration
     * are live. True between turns too, which is the point — slice 2 made the session outlive
     * a turn. Not "a run is in flight", which is a lower bound that calls an idle conversation
     * "not running".
     */
    readonly held: boolean;
    readonly endedAt: number | null;
    readonly endedReason: ImporterSessionEndReason | null;
    readonly entriesIn: number;
    readonly entriesOut: number;
    readonly assets: number;
  }[];
  readonly workers: {
    readonly sessions: readonly {
      readonly attemptId: string;
      readonly question: string;
      readonly harnessSessionId: string;
      readonly harnessInstanceId: string | null;
      readonly model: string;
      readonly status: string;
      readonly startedAt: number;
    }[];
    readonly total: number;
  };
}

export const unionAgentSessions = (
  sources: AgentSessionSources,
): AgentSessionsView => {
  const goals = sources.goals.map((goal): AgentSessionView => {
    const held = sources.goalLive(goal.goalId);
    // The registry holds a session; the index names the one the goal's conversation was last
    // opened on. They agree whenever the registry holds anything (opening records the id), and
    // a mismatch would be a held session that is not the indexed one — not live *as listed*.
    const live = held !== undefined && held.sessionId === goal.harnessSessionId;
    return {
      kind: "goal",
      key: `goal:${goal.goalId}`,
      sessionId: goal.harnessSessionId,
      subject: goal.goalName,
      subjectId: goal.goalId,
      harnessInstanceId: goal.harnessInstanceId,
      // Only a conversation this process holds can say; `goal_sessions` records no model.
      model: live ? held.model : null,
      startedAt: goal.openedAt,
      // A goal conversation has no ending of its own: the goal's status is its authority and
      // ending a goal interrupts nothing (`plan/goalConversation.ts`). So a goal row is live
      // or dormant, never ended.
      state: live ? "live" : "dormant",
      detail: null,
      tally: null,
    };
  });

  const importers = sources.importers.map((session): AgentSessionView => ({
    kind: "importer",
    key: `importer:${session.latestImportId}`,
    sessionId: session.harnessSessionId,
    subject: "Scope import",
    subjectId: session.latestImportId,
    harnessInstanceId: session.harnessInstanceId,
    model: session.model,
    startedAt: session.openedAt,
    // Three readings, and `ended` is only the one that is final. An operator's end is the one
    // end that refuses every write and is never reopened (`0027`); a shutdown, a refused
    // prompt or a failed open recorded that *a* period closed, and a message to the session
    // opens a fresh one. So those read `dormant` — this server does not hold it — with the
    // recorded reason beside it, never `ended`. A held session beats a stored ending: the
    // ending is for the session's *latest* authority period and a held one means a newer is open.
    state: session.held
      ? "live"
      : session.endedReason === "operator"
        ? "ended"
        : "dormant",
    detail: session.held ? null : session.endedReason,
    tally: {
      entriesIn: session.entriesIn,
      entriesOut: session.entriesOut,
      assets: session.assets,
    },
  }));

  const workers = sources.workers.sessions.map((attempt): AgentSessionView => ({
    kind: "worker",
    key: `worker:${attempt.attemptId}`,
    sessionId: attempt.harnessSessionId,
    subject: attempt.question,
    subjectId: attempt.attemptId,
    harnessInstanceId: attempt.harnessInstanceId,
    model: attempt.model,
    startedAt: attempt.startedAt,
    // `running` is the only status that still has authority; `uncertain` is terminal for
    // authority too (see `AttemptExecutionStatus`), so it is `ended` with the word beside it.
    state: attempt.status === "running" ? "live" : "ended",
    detail: attempt.status,
    tally: null,
  }));

  return {
    sessions: [...goals, ...importers, ...workers].sort(
      (a, b) => b.startedAt - a.startedAt || (a.key < b.key ? 1 : -1),
    ),
    workersOmitted: Math.max(
      0,
      sources.workers.total - sources.workers.sessions.length,
    ),
  };
};
