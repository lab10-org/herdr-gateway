---
name: herdr-gateway-ops
description: "Check the health, metrics, alerts, cleanups and tasks of the herdr-gateway host (devbox.lab10.ai). Use when the user asks about machine/server status, RAM/disk/load, alerts, what the hourly cleanup deleted, gateway logs, or active tasks/agents. All data comes from journald (herdr-monitor, herdr-gateway units) and the gateway HTTP API on localhost:4040."
---

# herdr-gateway ops

Observability for the devbox host. Two systemd units write to journald:

- `herdr-monitor` — heartbeat JSON every 10s (RAM, swap, PSI, disk, worktrees, load, service states) + alerts with hysteresis pushed to ntfy.
- `herdr-gateway` — task lifecycle logs + one structured JSON line per cleanup removal (`[cleanup] {...}`).

Helper scripts live next to this file (resolve relative paths against the skill directory). All scripts are read-only.

## Quick answers

```bash
# Machine status right now (latest heartbeat, pretty-printed)
bash scripts/status.sh

# Machine status over time (one metric, e.g. disk or RAM trend)
bash scripts/metric.sh mem_used_pct 6h
bash scripts/metric.sh disk_root_avail_mb 24h

# Alerts in a window (empty output = no alerts)
bash scripts/alerts.sh 24h

# What did the cleanup delete? (one line per removal: kind, id, deleted resources)
bash scripts/cleanups.sh 24h

# Live tasks known to the gateway
bash scripts/tasks.sh
```

## Manual equivalents (if scripts are unavailable)

```bash
journalctl -u herdr-monitor -n 1 --no-pager -o cat | python3 -m json.tool
journalctl -u herdr-monitor --since "-24h" -o cat | grep '"level":"ALERT"'
journalctl -u herdr-gateway --since "-24h" -o cat | grep '^\[cleanup\]'
journalctl -u herdr-gateway -f              # live gateway log
TOKEN=$(grep -oP 'GATEWAY_TOKEN=\K.*' /etc/systemd/system/herdr-gateway.service)
curl -s localhost:4040/tasks -H "Authorization: Bearer $TOKEN"
curl -s localhost:4040/health               # no auth
systemctl status herdr-gateway herdr-monitor caddy --no-pager
herdr agent list                            # agents alive in Herdr
du -sh /root/.herdr/worktrees               # worktree disk usage
```

## Interpreting results

See [references/runbook.md](references/runbook.md) for heartbeat fields, alert
thresholds, cleanup JSON schema (`kind`: task | orphan | stale_branch |
manual_delete), and common failure modes (gateway down, agent blocked, disk
filling from worktrees, state file lost after restart).
