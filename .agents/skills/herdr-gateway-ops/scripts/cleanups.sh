#!/usr/bin/env bash
# Usage: cleanups.sh [window]   e.g. cleanups.sh 24h
# One readable line per cleanup removal: ts kind id -> deleted resources (errors)
set -u
WINDOW="${1:-24h}"
journalctl -u herdr-gateway --since "-$WINDOW" -o cat | grep '^\[cleanup\]' | python3 -c "
import sys, json
found = False
for line in sys.stdin:
    try:
        d = json.loads(line[len('[cleanup] '):])
    except Exception:
        continue  # pre-JSON cleanup log format
    errs = (' ERRORS: ' + '; '.join(d.get('errors', []))) if d.get('errors') else ''
    print(d.get('at'), d.get('kind'), d.get('id', ''), '->', ', '.join(d.get('deleted', [])) or '(nothing)', errs)
    found = True
if not found:
    print('(no cleanup removals in window)')
"
