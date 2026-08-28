import test from "node:test";
import assert from "node:assert/strict";
import { observe, AGENT_STATES } from "../lib/agentState.js";

// Regression: a freshly booted agent sits at its prompt box, which Herdr reports
// as `idle`. The gateway used to map `idle || done` to `done`, so every task was
// declared complete ~1s after dispatch while its agent was still starting up.
// The consumer marked it terminal, stopped polling, and the real work -- which
// finished ~30min later -- never reached the user. (task t-c48d9568)
test("a booting agent reporting idle does NOT complete the task", () => {
  const bootingTask = { sawWorking: false };
  const next = observe("idle", bootingTask);
  assert.equal(next.status, null, "idle at startup must not settle the task");
  assert.equal(next.sawWorking, false);
});

test("idle never means done, even after work was observed", () => {
  // Claude Code renders its prompt box between turns too; only Herdr's own
  // `done` (idle *after* observed work) may settle a task.
  const next = observe("idle", { sawWorking: true });
  assert.equal(next.status, null);
});

test("done without observed work is ignored", () => {
  // Guards against a state-machine flap, and against a follow-up inheriting the
  // previous turn's `done` before the agent has read the new message.
  const next = observe("done", { sawWorking: false });
  assert.equal(next.status, null);
  assert.equal(next.sawWorking, false);
});

test("done after observed work completes the task", () => {
  const next = observe("done", { sawWorking: true });
  assert.equal(next.status, "done");
});

test("working arms the gate that done depends on", () => {
  const task = { sawWorking: false };
  const working = observe("working", task);
  assert.equal(working.status, "working");
  assert.equal(working.sawWorking, true);
  // ...and only now can a subsequent `done` settle it.
  assert.equal(observe("done", { sawWorking: working.sawWorking }).status, "done");
});

test("blocked arms the gate without passing through working", () => {
  // The agent asking for input proves it read the prompt. Reporting `working`
  // first would emit a phantom transition to the consumer.
  const next = observe("blocked", { sawWorking: false });
  assert.equal(next.status, "blocked");
  assert.equal(next.sawWorking, true);
});

test("unknown proves nothing and preserves what we know", () => {
  assert.equal(observe("unknown", { sawWorking: false }).status, null);
  assert.equal(observe("unknown", { sawWorking: true }).status, null);
  assert.equal(observe("unknown", { sawWorking: true }).sawWorking, true);
});

test("an unrecognised state is treated like unknown, never as completion", () => {
  const next = observe("completed", { sawWorking: true });
  assert.equal(next.status, null);
});

test("no state settles a task that has not been observed working", () => {
  // The core invariant: `done` is unreachable without observed work.
  for (const state of AGENT_STATES) {
    assert.notEqual(
      observe(state, { sawWorking: false }).status,
      "done",
      `${state} must not complete a task with no observed work`
    );
  }
});

test("observe is pure: it does not mutate the task it inspects", () => {
  const task = { sawWorking: false };
  observe("working", task);
  assert.equal(task.sawWorking, false, "arming is the caller's job (armWorking)");
});
