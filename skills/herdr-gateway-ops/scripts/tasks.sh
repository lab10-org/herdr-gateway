#!/usr/bin/env bash
# Live tasks known to the gateway (id, status, updated_at).
set -u
TOKEN=$(grep -oP 'GATEWAY_TOKEN=\K.*' /etc/systemd/system/herdr-gateway.service)
curl -s -m 5 localhost:4040/tasks -H "Authorization: Bearer $TOKEN" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tasks = d.get('tasks', [])
if not tasks:
    print('(no tasks in gateway memory)')
for t in tasks:
    print(t['id'], t['status'], t.get('updated_at', ''), t.get('branch', ''))
"
