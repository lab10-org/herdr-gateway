#!/usr/bin/env bash
# Usage: metric.sh <field> [window]   e.g. metric.sh mem_used_pct 6h
# Prints "<ts> <value>" lines from herdr-monitor heartbeats.
set -u
FIELD="${1:?usage: metric.sh <field> [window e.g. 6h]}"
WINDOW="${2:-24h}"
journalctl -u herdr-monitor --since "-$WINDOW" -o cat | python3 -c "
import sys, json
field = '''$FIELD'''
for line in sys.stdin:
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get('level') == 'ALERT' or field not in d:
        continue
    print(d.get('ts', '?'), d[field])
"
