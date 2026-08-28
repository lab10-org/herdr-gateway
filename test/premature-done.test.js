// End-to-end regression test: drives the real server.js against a stubbed
// `herdr` binary whose agent stays `idle` (the startup state) for many poll
// ticks before it ever starts working.
//
// Before the fix, the first poll after dispatch mapped that `idle` to `done`
// and fired a terminal webhook while the agent was still booting.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stub reports whatever agent_status this file holds, so the test drives the
// agent's lifecycle: idle (booting) -> working -> done.
function writeStub(binDir, phaseFile) {
  const stub = `#!/usr/bin/env node
// CommonJS on purpose: an extensionless file is loaded as CJS.
const fs = require("node:fs");
const a = process.argv.slice(2);
// writeSync, not console.log: process.exit can truncate a piped stdout.
const ok = (result) => { fs.writeSync(1, JSON.stringify({ id: "stub", result })); process.exit(0); };
const boom = (msg) => { fs.writeSync(2, msg); process.exit(1); };
const phase = () => fs.readFileSync(${JSON.stringify(phaseFile)}, "utf8").trim();
if (a[0] === "workspace" && a[1] === "list") ok({ workspaces: [{ workspace_id: "w1", label: "http-tasks" }] });
if (a[0] === "tab" && a[1] === "create") ok({ tab: { tab_id: "t1" }, root_pane: { pane_id: "p1" } });
if (a[0] === "tab" && a[1] === "close") ok({});
if (a[0] === "agent" && a[1] === "start") ok({});
if (a[0] === "agent" && a[1] === "prompt") {
  // Faithful to the real CLI: without --wait it returns as soon as the keys are
  // submitted (~7ms), regardless of what the agent is doing. With --wait it
  // blocks until the requested state is actually observed, or times out.
  if (!a.includes("--wait")) ok({});
  const want = a.includes("--until") ? a[a.indexOf("--until") + 1] : null;
  const ms = a.includes("--timeout") ? Number(a[a.indexOf("--timeout") + 1]) : 5000;
  const deadline = Date.now() + ms;
  const block = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const p = phase();
    if (want ? p === want : ["idle", "done", "blocked"].includes(p)) ok({ agent_status: p });
    Atomics.wait(block, 0, 0, 25);
  }
  boom("agent_prompt_stalled");
}
if (a[0] === "agent" && a[1] === "get") {
  const p = phase();
  if (p === "__crash__") boom("agent not found");   // Herdr unreachable
  ok({ agent: { agent_status: p, name: a[2] } });
}
if (a[0] === "agent" && a[1] === "read") ok("stub output");
boom("unexpected: " + a.join(" "));
`;
  const p = path.join(binDir, "herdr");
  fs.writeFileSync(p, stub);
  fs.chmodSync(p, 0o755);
}

async function startHarness(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, "bin");
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(binDir);
  fs.mkdirSync(repo);
  const phaseFile = path.join(tmp, "phase");
  fs.writeFileSync(phaseFile, "idle"); // the agent boots into its prompt box
  writeStub(binDir, phaseFile);

  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "test");
  fs.writeFileSync(path.join(repo, "f.txt"), "hi\n");
  g("add", "."); g("commit", "-qm", "init");

  // Capture every webhook the gateway fires, in order.
  const hooks = [];
  const hookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { hooks.push(JSON.parse(body)); res.writeHead(200).end("{}"); });
  });
  await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
  t.after(() => hookServer.close());
  const port = 4100 + Math.floor(Math.random() * 400);

  const child = spawn(process.execPath, [path.join(repoRoot, "server.js")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      PORT: String(port),
      HOST: "127.0.0.1",
      GATEWAY_TOKEN: "test-token",
      DEFAULT_REPO: repo,
      WORKTREE_ROOT: path.join(tmp, "worktrees"),
      STATE_FILE: path.join(tmp, "state.json"),
      WEBHOOK_URL: `http://127.0.0.1:${hookServer.address().port}/`,
      POLL_INTERVAL_MS: "200",
      PROMPT_WAIT_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  t.after(() => child.kill("SIGKILL"));

  const api = async (p, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer test-token", ...init.headers },
    });
    return res.json();
  };

  for (let i = 0; i < 100; i++) {           // wait for listen
    try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
  const setPhase = (p) => fs.writeFileSync(phaseFile, p);
  const waitFor = async (id, status, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const t2 = await api(`/tasks/${id}`);
      if (t2.status === status) return t2;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${status}; logs:\n${logs.join("")}`);
  };
  return { api, hooks, setPhase, waitFor, logs };
}

test("an agent idling through startup never reports done", async (t) => {
  const { api, hooks, setPhase, waitFor } = await startHarness(t);

  const task = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ prompt: "read several files and report back" }),
  });
  // POST /tasks dispatches synchronously when a slot is free.
  assert.ok(["queued", "dispatching"].includes(task.status), `unexpected ${task.status}`);

  // The agent sits at its prompt box for ~15 poll ticks. This is the exact
  // window in which the bug fired (it took one tick, ~1.3s in production).
  await sleep(3000);

  const during = await api(`/tasks/${task.id}`);
  assert.notEqual(during.status, "done", "a booting agent must not be reported done");
  assert.equal(during.status, "starting", "it should still be starting up");
  assert.equal(
    hooks.filter((h) => h.status === "done").length, 0,
    "no done webhook may be delivered while the agent is booting"
  );

  // Now the agent actually starts working, then finishes.
  setPhase("working");
  await waitFor(task.id, "working", 5000);
  assert.equal(hooks.filter((h) => h.status === "done").length, 0);

  setPhase("done");
  const finished = await waitFor(task.id, "done", 5000);
  assert.equal(finished.status, "done");

  const order = hooks.map((h) => h.status);
  assert.deepEqual(order, ["starting", "working", "done"], "done must come last, not first");
});

test("a herdr lookup failure is not reported as completion", async (t) => {
  const { api, hooks, setPhase, waitFor } = await startHarness(t);
  const task = await api("/tasks", { method: "POST", body: JSON.stringify({ prompt: "work" }) });

  setPhase("working");
  await waitFor(task.id, "working", 8000);

  // Herdr goes away mid-task: the old code answered `done` on the very next poll.
  setPhase("__crash__"); // the stub exits non-zero for an unrecognised phase
  await sleep(1500);

  const after = await api(`/tasks/${task.id}`);
  assert.notEqual(after.status, "done", "an unreachable agent is not a finished agent");
  assert.equal(hooks.filter((h) => h.status === "done").length, 0);
});
