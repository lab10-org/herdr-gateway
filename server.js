import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
};

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
async function createTask({ prompt, repo, agentKind, agentArgs, branch, webhookUrl }) {
  const id = newId();
  repo = repo || config.defaultRepo;
  if (!repo) throw httpError(400, "repo is required (or set DEFAULT_REPO)");
  if (!fs.existsSync(path.join(repo, ".git"))) throw httpError(400, `not a git repo: ${repo}`);
  agentKind = agentKind || config.defaultAgentKind;
  agentArgs = agentArgs || config.defaultAgentArgs;
  branch = branch || `task/${id}`;

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

  // 2. Create worktree from fresh base
  const repoName = path.basename(repo);
  const wtPath = path.join(config.worktreeRoot, repoName, branch.replaceAll("/", "-"));
  await git(repo, ["worktree", "add", "-b", branch, wtPath, sync.baseRef]);

  const task = {
    id, prompt, repo, branch, worktree: wtPath,
    agentKind, status: "created", events: [], webhookUrl,
    tabId: null, paneId: null, promptSubmitted: false, error: null,
    doneAt: null, sessionClosed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  tasks.set(id, task);
  knownRepos.add(repo);
  log(task, `worktree created at ${wtPath} (base ${sync.baseRef})`);

  // 3. Tab in the dedicated workspace -> pane -> agent -> prompt
  try {
    const ws = await ensureWorkspace();
    const tab = await herdr(["tab", "create", "--workspace", ws, "--cwd", wtPath, "--label", id, "--no-focus"]);
    task.tabId = tab.tab.tab_id;
    task.paneId = tab.root_pane.pane_id;
    await herdr(["agent", "start", id, "--kind", agentKind, "--pane", task.paneId, "--", ...agentArgs]);
    setStatus(task, "starting");
    // agent prompt resolves once a lifecycle change is observed (~working)
    herdr(["agent", "prompt", id, prompt])
      .then(() => { task.promptSubmitted = true; setStatus(task, "working"); })
      .catch((e) => fail(task, `prompt failed: ${e.message}`));
  } catch (e) {
    fail(task, e.message);
  }
  return task;
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

function log(task, msg) {
  task.events.push({ at: new Date().toISOString(), msg });
  task.updatedAt = new Date().toISOString();
  saveState();
}
function setStatus(task, status) {
  if (task.status === status) return;
  task.status = status;
  if (status === "done") task.doneAt = Date.now();
  else task.doneAt = null;
  log(task, `status -> ${status}`);
  notify(task);
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
      if (state === "blocked") setStatus(task, "blocked");
      else if (state === "idle" || state === "done") setStatus(task, "done");
    } catch {
      // agent name cleared -> process exited
      if (task.status === "working") setStatus(task, "done");
      else if (task.status === "blocked") setStatus(task, "done");
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

async function destroyResources(task) {
  const errors = [];
  if (task.tabId) {
    try { await herdr(["tab", "close", task.tabId]); } catch (e) { errors.push(e.message); }
  }
  try { await git(task.repo, ["worktree", "remove", "--force", task.worktree]); } catch (e) { errors.push(e.message); }
  if (task.branch) {
    try { await git(task.repo, ["branch", "-D", task.branch]); } catch (e) { errors.push(e.message); }
  }
  return errors;
}

async function cleanup() {
  const now = Date.now();
  let removed = 0;

  // 1. Known tasks: terminal/blocked and idle beyond threshold
  for (const [id, task] of tasks) {
    if (!CLEANABLE.has(task.status)) continue;
    if (now - new Date(task.updatedAt) <= config.cleanupIdleMs) continue;
    const errors = await destroyResources(task);
    tasks.delete(id);
    removed++;
    console.log(`[cleanup] task ${id} (${task.status}) removed`, errors.length ? `errors: ${errors.join("; ")}` : "");
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
        const errors = await destroyResources({
          repo, worktree: wtPath, branch: `task/${m[1]}`, tabId: tabLabels.get(m[1]) || null,
        });
        removed++;
        console.log(`[cleanup] orphan ${m[1]} removed`, errors.length ? `errors: ${errors.join("; ")}` : "");
      } else {
        // Origin repo is gone: drop the stale dir and tab directly.
        try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
        const tabId = tabLabels.get(m[1]);
        if (tabId) { try { await herdr(["tab", "close", tabId]); } catch { /* ignore */ } }
        removed++;
        console.log(`[cleanup] orphan ${m[1]} removed (origin repo missing)`);
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
        console.log(`[cleanup] stale branch ${branch} deleted`);
      } catch (e) { console.log(`[cleanup] stale branch ${branch}: ${e.message}`); }
    }
  }
  if (removed) saveState();
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

const publicTask = (t) => ({
  id: t.id, status: t.status, prompt: t.prompt, repo: t.repo, branch: t.branch,
  worktree: t.worktree, agent_kind: t.agentKind, error: t.error,
  created_at: t.createdAt, updated_at: t.updatedAt, events: t.events,
});

app.post("/tasks", async (req, res) => {
  const { prompt, repo, agent_kind, agent_args, branch, webhook_url } = req.body || {};
  if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "prompt is required" });
  try {
    const task = await createTask({
      prompt, repo, agentKind: agent_kind, agentArgs: agent_args, branch, webhookUrl: webhook_url,
    });
    res.status(201).json(publicTask(task));
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

app.get("/tasks", (_req, res) => {
  res.json({ tasks: [...tasks.values()].map(publicTask) });
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
  setStatus(task, "working");
  herdr(["agent", "prompt", task.id, message])
    .then(() => { task.promptSubmitted = true; })
    .catch((e) => fail(task, `follow-up failed: ${e.message}`));
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

// Manual cleanup: close tab + remove worktree + delete branch
app.delete("/tasks/:id", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  const errors = await destroyResources(task);
  tasks.delete(task.id);
  saveState();
  res.json({ deleted: task.id, errors });
});

// ---------- Boot ----------
loadState();
ensureWorkspace()
  .then(() => {
    setInterval(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), config.cleanupIntervalMs);
    setTimeout(() => cleanup().catch((e) => console.error("[cleanup]", e.message)), 60000);

    setInterval(() => pollAgents().catch((e) => console.error("[poll]", e.message)), config.pollIntervalMs);
    app.listen(config.port, config.host, () => console.log(`[gateway] listening on ${config.host}:${config.port}`));
  })
  .catch((e) => { console.error("[boot]", e); process.exit(1); });
