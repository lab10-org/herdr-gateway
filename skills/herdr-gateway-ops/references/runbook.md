# herdr-gateway ops reference

## Data sources

| What | Where | Notes |
|---|---|---|
| Host metrics heartbeat (every 10s) | `journalctl -u herdr-monitor -o cat` | one JSON object per line |
| Alerts | same unit, lines with `"level":"ALERT"` | hysteresis: 3 consecutive breaches + 30min cooldown; pushed to ntfy topic `lab10-herdr-devbox-health` |
| Cleanup removals | `journalctl -u herdr-gateway -o cat`, lines starting `[cleanup] ` | one JSON object per removal |
| Gateway task lifecycle | `journalctl -u herdr-gateway` | `[poll]`, `[boot]`, `[state]`, webhook failures |
| Live tasks | `GET localhost:4040/tasks` (Bearer token) | token in `/etc/systemd/system/herdr-gateway.service` (`GATEWAY_TOKEN=`) |
| Agents in Herdr | `herdr agent list` / `herdr tab list --workspace wB` | workspace label: `http-tasks` |

## Heartbeat fields (herdr-monitor)

`ts`, `host`, `mem_used_mb`, `mem_used_pct`, `mem_avail_mb`, `swap_used_mb`,
`psi_mem_some`, `psi_io_some`, `psi_cpu_some`, `disk_root_avail_mb`,
`disk_root_used_pct`, `worktree_count`, `worktree_size_mb`, `load1/5/15`,
`procs_running`, `procs_total`, `agent_procs`, `gateway`, `caddy`.

Healthy baseline (observed): mem ~30%, disk_root_used_pct ~8%, PSI 0, load < 1,
gateway/caddy `active`.

## Alert thresholds (env-configurable in the herdr-monitor unit)

| Alert | Condition | Default |
|---|---|---|
| `mem_high` | `mem_used_pct` >= 90 | 3 strikes |
| `disk_low` | `disk_root_avail_mb` <= 5120 | 3 strikes |
| `psi_mem` | `psi_mem_some` >= 20 | 3 strikes |
| `swap_high` | swap >= 50% (if swap exists) | 3 strikes |
| `gateway_down` | unit not active | 3 strikes |
| `caddy_down` | unit not active | 3 strikes |

## Cleanup JSON schema (herdr-gateway)

```json
{"at": "ISO8601", "kind": "task|orphan|stale_branch|manual_delete",
 "id": "t-xxxxxxxx", "status": "done", "repo": "...", "branch": "task/t-...",
 "worktree": "...", "idle_hours": 24.3,
 "deleted": ["tab:wB:tB", "worktree:/path", "branch:task/t-..."],
 "errors": []}
```

- `task`: known task in done/error/blocked, idle > `CLEANUP_IDLE_MS` (default 24h).
- `orphan`: worktree dir `task-t-*` with no live task (e.g. lost state file);
  may include `origin_repo_missing: true`.
- `stale_branch`: `task/t-*` branch with no task and no worktree using it.
- `manual_delete`: via `DELETE /tasks/:id`.
- Cleanup cadence: first run ~1 min after boot, then every `CLEANUP_INTERVAL_MS`
  (default 1h). Never touches `working`/`starting` tasks.

## Gateway config reference

Env vars in `/etc/systemd/system/herdr-gateway.service`:
`PORT=4040`, `HOST=127.0.0.1`, `GATEWAY_TOKEN`, `WORKSPACE_LABEL=http-tasks`,
`WORKTREE_ROOT=/root/.herdr/worktrees`, `SESSION_IDLE_TTL_MS` (2h),
`CLEANUP_INTERVAL_MS` (1h), `CLEANUP_IDLE_MS` (24h),
`STATE_FILE=/root/.herdr/gateway-state.json`.
Overrides live in `/etc/systemd/system/herdr-gateway.service.d/*.conf`.

Public URL: https://devbox.lab10.ai (Cloudflare → Caddy → 127.0.0.1:4040).

## Common failure modes

- **Gateway down**: `systemctl status herdr-gateway`; logs
  `journalctl -u herdr-gateway -n 100`. Boot fails if Herdr server is not
  running (`herdr status`).
- **Task blocked**: agent asks for approval; answer via
  `POST /tasks/:id/messages` or in the Herdr pane.
- **Disk filling from worktrees**: check `worktree_size_mb` trend; cleanup
  should reclaim idle ones — verify with `cleanups.sh`. Manual:
  `DELETE /tasks/:id`.
- **State file lost**: gateway forgets tasks on restart without it; orphan
  sweep still reclaims worktrees by mtime (>24h).
- **Journald not persistent**: if `/var/log/journal` is missing, history is
  lost on reboot: `mkdir -p /var/log/journal && systemctl restart systemd-journald`.
