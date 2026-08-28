import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { observe } from "./lib/agentState.js";

const run = promisify(execFile);

// ---------- Config ----------
const config = {
  port: Number(process.env.PORT || 4040),
  host: process.env.HOST || "0.0.0.0",
  token: process.env.GATEWAY_TOKEN || "change-me",
  workspaceLabel: process.env.WORKSPACE_LABEL || "http-tasks",
  defaultRepo: process.env.DEFAULT_REPO || "",
  defaultAgentKind: process.env.AGENT_KIND || "claude",
  defaultAgentArgs: (process.env.AGENT_ARGS || "").split(" ").filter(Boolean),
  worktreeRoot: process.env.WORKTREE_ROOT || "/root/.herdr/worktrees",
  globalWebhook: process.env.WEBHOOK_URL || "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  sessionIdleTtlMs: Number(process.env.SESSION_IDLE_TTL_MS || 2 * 3600 * 1000),
  cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 3600 * 1000),
  cleanupIdleMs: Number(process.env.CLEANUP_IDLE_MS || 24 * 3600 * 1000),
  stateFile: process.env.STATE_FILE || "/root/.herdr/gateway-state.json",
  maxInFlight: Number(process.env.MAX_IN_FLIGHT || 4),
  startStallMs: Number(process.env.START_STALL_MS || 15 * 60 * 1000),
  promptWaitMs: Number(process.env.PROMPT_WAIT_MS || 120000),
};
if (!Number.isInteger(config.maxInFlight) || config.maxInFlight < 0) {
  console.error(`[config] invalid MAX_IN_FLIGHT "${process.env.MAX_IN_FLIGHT}", using default 4`);
  config.maxInFlight = 4;
}
if (config.maxInFlight === 0) {
  console.warn("[config] MAX_IN_FLIGHT=0: dispatch paused, tasks will pile up in queue");
}

// ---------- Helpers ----------
async function herdr(args, { raw = false } = {}) {
  const { stdout } = await run("herdr", args, { maxBuffer: 16 * 1024 * 1024 });
  return raw ? stdout : JSON.parse(stdout).result;
}

async function git(repoPath, args) {
  const { stdout } = await run("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

const newId = () => "t-" + crypto.randomBytes(4).toString("hex");

// ---------- State ----------
/** @type {Map<string, object>} */
const tasks = new Map();
const knownRepos = new Set();
let workspaceId = null;

async function ensureWorkspace() {
  if (workspaceId) return workspaceId;
  const list = await herdr(["workspace", "list"]);
  const workspaces = list.workspaces || list || [];
  const existing = workspaces.find((w) => w.label === config.workspaceLabel);
  if (existing) {
    workspaceId = existing.workspace_id;
  } else {
    const res = await herdr([
      "workspace", "create",
      "--cwd", "/root",
      "--label", config.workspaceLabel,
      "--no-focus",
    ]);
    workspaceId = res.workspace.workspace_id;
  }
  console.log(`[gateway] workspace ${config.workspaceLabel}: ${workspaceId}`);
  return workspaceId;
}

// ---------- Task lifecycle ----------
// Tasks are enqueued as lightweight records (status "queued", no resources).
// Resources (worktree/tab/agent) are only created on dispatch, so a burst of
// POSTs never overwhelms the host. In-flight = dispatching|starting|working|blocked.
const IN_FLIGHT = new Set(["dispatching", "starting", "working", "blocked"]);
const inFlightCount = () => [...tasks.values()].filter((t) => IN_FLIGHT.has(t.status)).length;

function createTask({ prompt, repo, agentKind, agentArgs, branch, webhookUrl }) {
  const id = newId();
  repo = repo || config.defaultRepo;
  if (!repo) throw httpError(400, "repo is required (or set DEFAULT_REPO)");
  if (!fs.existsSync(path.join(repo, ".git"))) throw httpError(400, `not a git repo: ${repo}`);
  agentKind = agentKind || config.defaultAgentKind;
  agentArgs = agentArgs || config.defaultAgentArgs;
  branch = branch || `task/${id}`;

  const task = {
    id, prompt, repo, branch, worktree: null,
    agentKind, agentArgs, status: "queued", events: [], webhookUrl,
    tabId: null, paneId: null, promptSubmitted: false, error: null,
    doneAt: null, sessionClosed: false,
    // `done` is gated on this: no observed work, no completion.
    sawWorking: false, pollFailures: 0, workStartedAt: null, startingAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  tasks.set(id, task);
  knownRepos.add(repo);
  log(task, "enqueued");
  return task;
}

// Start the oldest queued tasks while in-flight < MAX_IN_FLIGHT.
// Synchronous: "dispatching" occupies a slot immediately and startTask runs
// fire-and-forget, so no reentrancy is possible (single-threaded JS) and all
// free slots fill in parallel instead of serially awaiting slow agent boots.
function dispatchQueue() {
  if (config.maxInFlight <= 0) return; // dispatch disabled
  for (const task of tasks.values()) {
    if (inFlightCount() >= config.maxInFlight) break;
    if (task.status !== "queued") continue;
    task.status = "dispatching";
    log(task, "dispatching");
    startTask(task).catch((e) => fail(task, e.message));
  }
}

async function startTask(task) {
  const { id, prompt, repo, branch, agentKind, agentArgs } = task;

  // 1. Sync origin main (best-effort pull of the main checkout, always fetch)
  const sync = { fetched: false, pulled: false, baseRef: "main" };
  try {
    await git(repo, ["fetch", "origin", "main"]);
    sync.fetched = true;
    try {
      await git(repo, ["merge", "--ff-only", "origin/main"]);
      sync.pulled = true;
    } catch { /* main checkout dirty or not on main; base ref still fresh */ }
    sync.baseRef = "origin/main";
  } catch { /* no origin; fall back to local main */ }

  // 2. Create worktree from fresh base (idempotent: reuse a leftover from a
  //    crashed previous dispatch instead of dying with "branch already exists")
  const repoName = path.basename(repo);
  const wtPath = path.join(config.worktreeRoot, repoName, branch.replaceAll("/", "-"));
  if (fs.existsSync(wtPath)) {
    log(task, `reusing existing worktree ${wtPath}`);
  } else {
    await git(repo, ["worktree", "add", "-b", branch, wtPath, sync.baseRef]);
    log(task, `worktree created at ${wtPath} (base ${sync.baseRef})`);
  }
  task.worktree = wtPath;

  // 3. Tab in the dedicated workspace -> pane -> agent -> prompt
  const ws = await ensureWorkspace();
  const tab = await herdr(["tab", "create", "--workspace", ws, "--cwd", wtPath, "--label", id, "--no-focus"]);
  task.tabId = tab.tab.tab_id;
  task.paneId = tab.root_pane.pane_id;
  await herdr(["agent", "start", id, "--kind", agentKind, "--pane", task.paneId, "--", ...agentArgs]);
  setStatus(task, "starting");
  // Without --wait, `agent prompt` returns as soon as the keystrokes are
  // submitted (~7ms), long before the agent has read them: reporting "working"
  // there was fabricated. --wait is event-driven on Herdr's side, so unlike our
  // 5s poll it cannot miss a short turn. On timeout we do NOT fail the task --
  // it stays "starting" and the poll decides; only observed work moves it on.
  herdr(["agent", "prompt", id, prompt,
         "--wait", "--until", "working", "--timeout", String(config.promptWaitMs)])
    .then(() => { task.promptSubmitted = true; armWorking(task); setStatus(task, "working"); })
    .catch((e) => {
      task.promptSubmitted = true;
      log(task, `prompt submitted but "working" was not observed: ${e.message}`);
    });
  // The task may have been deleted/cleaned up while we were starting: don't
  // leave a live agent over a destroyed worktree.
  if (!tasks.has(task.id)) {
    await destroyResources(task);
    cleanupLog("aborted_dispatch", {
      id: task.id, repo: task.repo, branch: task.branch, worktree: task.worktree,
      deleted: ["tab:" + task.tabId, "worktree:" + task.worktree, "branch:" + task.branch],
      errors: [],
    });
  }
}

function httpError(code, msg) { return Object.assign(new Error(msg), { code }); }

// ---------- Persistence (survive restarts so cleanup can find old tasks) ----------
function saveState() {
  try {
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    fs.writeFileSync(config.stateFile, JSON.stringify({ tasks: [...tasks.values()], repos: [...knownRepos] }, null, 1));
  } catch (e) { console.error("[state]", e.message); }
}
function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    const list = Array.isArray(data) ? data : data.tasks || []; // legacy: bare array
    for (const t of list) if (t && t.id) tasks.set(t.id, t);
    for (const r of data.repos || []) knownRepos.add(r);
    if (tasks.size) console.log(`[state] restored ${tasks.size} task(s)`);
  } catch { /* no state file yet */ }
}

// Reconcile persisted tasks after a restart: crash mid-dispatch leaves zombies
// that would occupy in-flight slots forever (nobody polls promptSubmitted:false).
function reconcileState() {
  for (const t of tasks.values()) {
    if (t.status === "created" || t.status === "dispatching") {
      // pre-queue legacy / crash mid-start: resources may or may not exist
      t.status = "queued";
      t.promptSubmitted = false;
      log(t, "reconciled after restart -> queued (will retry idempotently)");
    } else if (t.status === "starting") {
      t.error = "gateway restarted during agent start";
      t.status = "error";
      log(t, "reconciled after restart -> error");
    } else if (t.status === "working" && !t.promptSubmitted) {
      t.error = "gateway restarted while submitting prompt";
      t.status = "error";
      log(t, "reconciled after restart -> error");
    } else if (t.status === "working" || t.status === "blocked") {
      // A persisted working/blocked status is itself the record that work was
      // observed; re-arm the gate or the poll could never settle this task.
      t.sawWorking = true;
      t.pollFailures = 0;
      log(t, "reconciled after restart; poll will refresh status");
    }
  }
}

function log(task, msg) {
  task.events.push({ at: new Date().toISOString(), msg });
  task.updatedAt = new Date().toISOString();
  saveState();
}
function setStatus(task, status) {
  if (task.status === status) return;
  task.status = status;
  if (status === "starting") task.startingAt = Date.now();
  if (status === "done") task.doneAt = Date.now();
  else task.doneAt = null;
  log(task, `status -> ${status}`);
  notify(task);
  // A slot freed up -> start the next queued task.
  if (!IN_FLIGHT.has(status)) dispatchQueue();
}
// The one place `sawWorking` is armed: `done` is unreachable until this runs.
// Arming only -- the caller decides the status, so observing `blocked` does not
// emit a phantom `working` on the way.
function armWorking(task) {
  if (task.sawWorking) return;
  task.sawWorking = true;
  task.workStartedAt = new Date().toISOString();
}
function fail(task, msg) {
  task.error = msg;
  setStatus(task, "error");
}

// ---------- Webhooks ----------
async function notify(task) {
  const url = task.webhookUrl || config.globalWebhook;
  if (!url) return;
  const body = JSON.stringify({
    task_id: task.id, status: task.status, error: task.error,
    branch: task.branch, worktree: task.worktree,
    updated_at: task.updatedAt,
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body, signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return;
    } catch { /* retry once */ }
  }
  log(task, "webhook delivery failed");
}

// ---------- Monitor (poll Herdr agent states) ----------
const TERMINAL = new Set(["done", "completed", "error"]);
async function pollAgents() {
  for (const task of tasks.values()) {
    if (TERMINAL.has(task.status) || !task.promptSubmitted) continue;
    try {
      const info = await herdr(["agent", "get", task.id]);
      const state = (info.agent || info).agent_status || "unknown";
      task.pollFailures = 0;
      // `idle` is the agent sitting at its prompt box: that is how a booting
      // agent looks, so it can never mean completion. See lib/agentState.js.
      const next = observe(state, task);
      if (next.sawWorking) armWorking(task);
      if (next.status) setStatus(task, next.status);
    } catch (e) {
      // A failed lookup is `unknown`, not success. Reporting `done` here handed
      // the consumer a false completion on any Herdr hiccup.
      task.pollFailures = (task.pollFailures || 0) + 1;
      if (task.pollFailures === 1) log(task, `poll failed: ${e.message}`);
      if (task.pollFailures >= 12) fail(task, `agent unreachable for ${task.pollFailures} consecutive polls`);
    }
    // Gating `done` on observed work means a prompt that never lands would hold
    // an in-flight slot forever. Bound it, and report it as the error it is.
    if (!task.sawWorking && task.status === "starting"
        && task.startingAt && Date.now() - task.startingAt > config.startStallMs) {
      fail(task, `agent never started working within ${Math.round(config.startStallMs / 1000)}s of dispatch`);
    }
  }
  // Close idle session tabs after TTL so follow-ups have a bounded window.
  for (const task of tasks.values()) {
    if (task.status === "done" && !task.sessionClosed && task.doneAt
        && Date.now() - task.doneAt > config.sessionIdleTtlMs) {
      task.sessionClosed = true;
      log(task, "session idle TTL reached; closing tab");
      if (task.tabId) {
        try { await herdr(["tab", "close", task.tabId]); } catch { /* already closed */ }
      }
    }
  }
}

// ---------- Hourly cleanup: idle >24h resources (tabs, worktrees, branches) ----------
const CLEANABLE = new Set(["done", "error", "blocked"]);

// One structured log line per removal, so journald tells exactly what was deleted.
function cleanupLog(kind, info) {
  console.log(`[cleanup] ${JSON.stringify({ at: new Date().toISOString(), kind, ...info })}`);
}

async function destroyResources(task) {
  const deleted = [];
  const errors = [];
  if (task.tabId) {
    try { await herdr(["tab", "close", task.tabId]); deleted.push("tab:" + task.tabId); }
    catch (e) { errors.push("tab: " + e.message); }
  }
  try { await git(task.repo, ["worktree", "remove", "--force", task.worktree]); deleted.push("worktree:" + task.worktree); }
  catch (e) { errors.push("worktree: " + e.message); }
  if (task.branch) {
    try { await git(task.repo, ["branch", "-D", task.branch]); deleted.push("branch:" + task.branch); }
    catch (e) { errors.push("branch: " + e.message); }
  }
  return { deleted, errors };
}

async function cleanup() {
  const now = Date.now();
  let removed = 0;

  // 1. Known tasks: terminal/blocked and idle beyond threshold
  for (const [id, task] of tasks) {
    if (!CLEANABLE.has(task.status)) continue;
    if (now - new Date(task.updatedAt) <= config.cleanupIdleMs) continue;
    const idleMs = now - new Date(task.updatedAt);
    const { deleted, errors } = await destroyResources(task);
    tasks.delete(id);
    removed++;
    cleanupLog("task", {
      id, status: task.status, repo: task.repo, branch: task.branch,
      worktree: task.worktree, prompt: (task.prompt || "").slice(0, 120),
      created_at: task.createdAt, updated_at: task.updatedAt,
      idle_hours: +(idleMs / 3600000).toFixed(2), deleted, errors,
    });
  }

  // 1b. Tasks stuck in queue too long (dispatch paused, huge backlog): expire
  //     with an explicit error + webhook instead of vanishing silently.
  for (const [id, task] of tasks) {
    if (task.status !== "queued") continue;
    if (now - new Date(task.createdAt) <= config.cleanupIdleMs) continue;
    fail(task, "expired in queue (never dispatched)");
    removed++;
    cleanupLog("queue_expired", {
      id, repo: task.repo, branch: task.branch, prompt: (task.prompt || "").slice(0, 120),
      created_at: task.createdAt,
      queued_hours: +((now - new Date(task.createdAt)) / 3600000).toFixed(2),
      deleted: [], errors: [],
    });
  }

  // 2. Orphans: worktree dirs task-t-* with no live task (e.g. after a restart
  //    with an older state file) whose dir mtime exceeds the idle threshold.
  let tabLabels = new Map();
  try {
    const ws = await ensureWorkspace();
    const tabs = await herdr(["tab", "list", "--workspace", ws]);
    for (const t of tabs.tabs || []) tabLabels.set(t.label, t.tab_id);
  } catch { /* herdr unavailable; skip tab closing for orphans */ }

  for (const t of tasks.values()) knownRepos.add(t.repo);
  if (config.defaultRepo) knownRepos.add(config.defaultRepo);

  let repoDirs = [];
  try { repoDirs = fs.readdirSync(config.worktreeRoot); } catch { /* no root yet */ }
  for (const repoName of repoDirs) {
    const repoPath = path.join(config.worktreeRoot, repoName);
    let entries = [];
    try { entries = fs.readdirSync(repoPath); } catch { continue; }
    for (const entry of entries) {
      const m = entry.match(/^task-(t-[0-9a-f]+)$/);
      if (!m || tasks.has(m[1])) continue;
      const wtPath = path.join(repoPath, entry);
      let mtime;
      try { mtime = fs.statSync(wtPath).mtimeMs; } catch { continue; }
      if (now - mtime <= config.cleanupIdleMs) continue;
      // Resolve the real repo from the worktree's gitdir pointer
      let repo = null;
      try {
        const gitdir = fs.readFileSync(path.join(wtPath, ".git"), "utf8");
        const gm = gitdir.match(/gitdir: (.+)\/\.git\/worktrees\//);
        if (gm) repo = gm[1];
      } catch { continue; }
      if (repo) knownRepos.add(repo);
      if (repo && fs.existsSync(repo)) {
        const branch = `task/${m[1]}`;
        const { deleted, errors } = await destroyResources({
          repo, worktree: wtPath, branch, tabId: tabLabels.get(m[1]) || null,
        });
        removed++;
        cleanupLog("orphan", {
          id: m[1], repo, branch, worktree: wtPath,
          idle_hours: +((now - mtime) / 3600000).toFixed(2), deleted, errors,
        });
      } else {
        // Origin repo is gone: drop the stale dir and tab directly.
        const deleted = [];
        try { fs.rmSync(wtPath, { recursive: true, force: true }); deleted.push("worktree:" + wtPath); } catch { /* ignore */ }
        const tabId = tabLabels.get(m[1]);
        if (tabId) { try { await herdr(["tab", "close", tabId]); deleted.push("tab:" + tabId); } catch { /* ignore */ } }
        removed++;
        cleanupLog("orphan", {
          id: m[1], repo, branch: `task/${m[1]}`, worktree: wtPath,
          idle_hours: +((now - mtime) / 3600000).toFixed(2),
          origin_repo_missing: true, deleted, errors: [],
        });
      }
    }
  }

  // 3. Stale branches: task/t-* with no live task, tip commit older than the idle threshold
  for (const repo of knownRepos) {
    if (!fs.existsSync(repo)) continue;
    let refs;
    try {
      refs = await git(repo, ["for-each-ref", "refs/heads/task", "--format", "%(refname:short) %(committerdate:unix)"]);
    } catch { continue; }
    for (const line of refs.split("\n").filter(Boolean)) {
      const [branch, ts] = line.split(" ");
      const id = branch.replace(/^task\//, "");
      if (tasks.has(id)) continue;
      if (now - Number(ts) * 1000 <= config.cleanupIdleMs) continue;
      // Only delete if no worktree still uses it
      let inUse = false;
      try {
        const wts = await git(repo, ["worktree", "list", "--porcelain"]);
        inUse = wts.includes(`refs/heads/${branch}`);
      } catch { continue; }
      if (inUse) continue;
      try {
        await git(repo, ["branch", "-D", branch]);
        removed++;
        cleanupLog("stale_branch", {
          id, repo, branch,
          idle_hours: +((now - Number(ts) * 1000) / 3600000).toFixed(2),
          deleted: ["branch:" + branch], errors: [],
        });
      } catch (e) {
        cleanupLog("stale_branch", { id, repo, branch, deleted: [], errors: [e.message] });
      }
    }
  }
  if (removed) saveState();
  dispatchQueue();
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.headers.authorization !== `Bearer ${config.token}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const queuedList = () => [...tasks.values()].filter((t) => t.status === "queued");

const publicTask = (t, queued) => {
  const q = queued || queuedList();
  return {
    id: t.id, status: t.status, prompt: t.prompt, repo: t.repo, branch: t.branch,
    worktree: t.worktree, agent_kind: t.agentKind, error: t.error,
    queue_position: t.status === "queued" ? q.indexOf(t) + 1 : null,
    created_at: t.createdAt, updated_at: t.updatedAt, events: t.events,
  };
};

app.post("/tasks", async (req, res) => {
  const { prompt, repo, agent_kind, agent_args, branch, webhook_url } = req.body || {};
  if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt is required" });
  try {
    const task = createTask({
      prompt, repo, agentKind: agent_kind, agentArgs: agent_args, branch, webhookUrl: webhook_url,
    });
    dispatchQueue();
    res.status(201).json(publicTask(task));
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

app.get("/queue", (_req, res) => {
  const inFlight = [...tasks.values()].filter((t) => IN_FLIGHT.has(t.status));
  res.json({
    max_in_flight: config.maxInFlight,
    in_flight: inFlight.length,
    in_flight_by_status: inFlight.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] || 0) + 1 }), {}),
    queued: queuedList().map((t) => publicTask(t, queuedList())),
  });
});

app.get("/tasks", (_req, res) => {
  const q = queuedList();
  res.json({ tasks: [...tasks.values()].map((t) => publicTask(t, q)) });
});

app.get("/tasks/:id", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  res.json(publicTask(task));
});

// Follow-up message on the same agent session (conversation continues in-context).
app.post("/tasks/:id/messages", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  const { message } = req.body || {};
  if (!message || typeof message !== "string") return res.status(400).json({ error: "message is required" });
  if (task.status === "queued" || task.status === "dispatching") {
    return res.status(409).json({ error: "task is still queued; wait for it to start" });
  }
  if (task.sessionClosed) return res.status(409).json({ error: "session closed (idle TTL reached); create a new task" });
  if (!task.promptSubmitted) return res.status(409).json({ error: "agent is busy with a previous message" });
  try {
    const info = await herdr(["agent", "get", task.id]);
    const state = (info.agent || info).agent_status || "unknown";
    if (state === "working") return res.status(409).json({ error: "agent is busy" });
  } catch {
    return res.status(409).json({ error: "agent process is no longer running; create a new task" });
  }
  log(task, `follow-up message (${message.length} chars)`);
  task.promptSubmitted = false;
  // Re-arm the gate: Herdr still reports `done` from the previous turn, and
  // inheriting sawWorking would settle this follow-up on the very next poll.
  task.sawWorking = false;
  task.workStartedAt = null;
  setStatus(task, "starting");
  herdr(["agent", "prompt", task.id, message,
         "--wait", "--until", "working", "--timeout", String(config.promptWaitMs)])
    .then(() => { task.promptSubmitted = true; armWorking(task); setStatus(task, "working"); })
    .catch((e) => {
      task.promptSubmitted = true;
      log(task, `follow-up submitted but "working" was not observed: ${e.message}`);
    });
  res.status(202).json(publicTask(task));
});

app.get("/tasks/:id/output", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  const lines = Math.min(Number(req.query.lines || 200), 2000);
  try {
    const out = await herdr(["agent", "read", task.id, "--source", "recent-unwrapped", "--lines", String(lines)], { raw: true });
    res.json({ id: task.id, status: task.status, output: out });
  } catch (e) {
    res.json({ id: task.id, status: task.status, output: null, error: e.message });
  }
});

// Manual cleanup: close tab + remove worktree + delete branch.
// Note: MAX_IN_FLIGHT caps task STARTS, not active agents: follow-up messages
// on done tasks re-enter "working" without consuming a queue slot (the agent
// already exists; nothing new is spawned).
app.delete("/tasks/:id", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  if (task.status === "queued") {
    // No resources exist yet; just drop it from the queue.
    tasks.delete(task.id);
    saveState();
    cleanupLog("manual_delete", {
      id: task.id, status: task.status, repo: task.repo, branch: task.branch,
      worktree: null, deleted: [], errors: [],
    });
    return res.json({ deleted: task.id, removed: [], errors: [] });
  }
  const { deleted, errors } = await destroyResources(task);
  cleanupLog("manual_delete", {
    id: task.id, status: task.status, repo: task.repo, branch: task.branch,
    worktree: task.worktree, deleted, errors,
  });
  tasks.delete(task.id);
  saveState();
  dispatchQueue();
  res.json({ deleted: task.id, removed: deleted, errors });
});

// ---------- Boot ----------
loadState();
reconcileState();
ensureWorkspace()
  .then(() => {
    setInterval(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), config.cleanupIntervalMs);
    setTimeout(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), 60000);

    setInterval(() => pollAgents().catch((e) => console.error("[poll]", e.message)), config.pollIntervalMs);
    dispatchQueue(); // drain persisted queue
    console.log(`[gateway] max in flight: ${config.maxInFlight}`);
    app.listen(config.port, config.host, () => console.log(`[gateway] listening on ${config.host}:${config.port}`));
  })
  .catch((e) => { console.error("[boot]", e); process.exit(1); });
