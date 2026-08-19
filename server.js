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
  maxTaskAgeMs: Number(process.env.MAX_TASK_AGE_MS || 24 * 3600 * 1000),
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
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  tasks.set(id, task);
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
function log(task, msg) {
  task.events.push({ at: new Date().toISOString(), msg });
  task.updatedAt = new Date().toISOString();
}
function setStatus(task, status) {
  if (task.status === status) return;
  task.status = status;
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
  // GC old terminal tasks
  for (const [id, task] of tasks) {
    if (TERMINAL.has(task.status) && Date.now() - new Date(task.updatedAt) > config.maxTaskAgeMs) {
      tasks.delete(id);
    }
  }
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

// Optional cleanup: close tab + remove worktree (keeps branch)
app.delete("/tasks/:id", async (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: "not found" });
  const errors = [];
  if (task.tabId) {
    try { await herdr(["tab", "close", task.tabId]); } catch (e) { errors.push(e.message); }
  }
  try { await git(task.repo, ["worktree", "remove", "--force", task.worktree]); } catch (e) { errors.push(e.message); }
  tasks.delete(task.id);
  res.json({ deleted: task.id, errors });
});

// ---------- Boot ----------
ensureWorkspace()
  .then(() => {
    setInterval(() => pollAgents().catch((e) => console.error("[poll]", e.message)), config.pollIntervalMs);
    app.listen(config.port, config.host, () => console.log(`[gateway] listening on ${config.host}:${config.port}`));
  })
  .catch((e) => { console.error("[boot]", e); process.exit(1); });
