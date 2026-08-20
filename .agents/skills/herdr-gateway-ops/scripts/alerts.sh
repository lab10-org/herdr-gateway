#!/usr/bin/env bash
# Usage: alerts.sh [window]   e.g. alerts.sh 24h
# Prints ALERT lines from herdr-monitor. Empty output = no alerts in window.
set -u
WINDOW="${1:-24h}"
journalctl -u herdr-monitor --since "-$WINDOW" -o cat | grep '"level":"ALERT"' || \
  echo "(no alerts in last $WINDOW)"
