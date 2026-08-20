#!/usr/bin/env bash
# Latest heartbeat from herdr-monitor + service states, pretty-printed.
set -u
echo "== services =="
systemctl is-active herdr-gateway herdr-monitor caddy 2>/dev/null | paste -d' ' \
  <(printf 'herdr-gateway\nherdr-monitor\ncaddy\n') -
echo
echo "== latest heartbeat =="
journalctl -u herdr-monitor -n 1 --no-pager -o cat | python3 -m json.tool
echo
echo "== worktrees on disk =="
du -sh /root/.herdr/worktrees 2>/dev/null || echo "no worktree root"
