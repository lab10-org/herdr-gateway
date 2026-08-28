// Mapping from a Herdr `agent_status` observation to a gateway task status.
//
// Herdr's AgentStatus enum is: idle | working | blocked | done | unknown.
// The two states that matter here are easy to confuse and mean opposite things:
//
//   idle  -> the agent sits at its prompt box with no work observed. A freshly
//            booted Claude Code is idle: splash screen, prompt not yet read.
//            This is the STARTUP state. It never proves completion.
//   done  -> idle *after* Herdr observed the agent working. Only this can mean
//            the turn finished.
//
// The gateway used to treat `idle || done` as completion, so every task was
// declared done ~1s after dispatch, while its agent was still booting. On top
// of Herdr's own distinction we keep `sawWorking`: a task may only reach `done`
// once we have positively observed it working (or blocked, which implies the
// prompt was read). Startup can never be mistaken for completion again.

/** Herdr agent_status values we know how to interpret. */
export const AGENT_STATES = ["idle", "working", "blocked", "done", "unknown"];

/**
 * Decide what an observation implies for a task.
 *
 * @param {string} state         agent_status reported by Herdr
 * @param {{sawWorking: boolean}} task  current task knowledge
 * @returns {{status: string|null, sawWorking: boolean, reason: string}}
 *          `status` is the new task status, or null to leave it unchanged.
 */
export function observe(state, { sawWorking = false } = {}) {
  switch (state) {
    case "working":
      // Positive evidence of work: this is what unlocks `done` later.
      return { status: "working", sawWorking: true, reason: "agent is working" };

    case "blocked":
      // The agent read the prompt and is asking for input: work has begun.
      return { status: "blocked", sawWorking: true, reason: "agent needs input" };

    case "done":
      // Herdr saw this agent work and go idle. Trust it only if we did too.
      return sawWorking
        ? { status: "done", sawWorking: true, reason: "work finished" }
        : { status: null, sawWorking: false, reason: "done without observed work; ignoring" };

    case "idle":
      // Startup, or an agent that never received its prompt. Not completion.
      return { status: null, sawWorking, reason: "idle is the startup state, not completion" };

    default:
      // `unknown` (and anything unrecognised) proves nothing either way.
      return { status: null, sawWorking, reason: `state ${state} proves nothing` };
  }
}
