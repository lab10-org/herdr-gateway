#!/usr/bin/env bash
# herdr-monitor: heartbeat de métricas cada INTERVAL (default 10s) -> journald
# + alertas con histéresis y cooldown, push vía ntfy.sh
# Ver métricas:  journalctl -u herdr-monitor -f -o json
# Ver alertas:   journalctl -u herdr-monitor -f | grep ALERT
# Test 1 línea:  RUN_ONCE=1 ./monitor.sh

set -u
INTERVAL="${INTERVAL:-10}"
WORKTREE_ROOT="${WORKTREE_ROOT:-/root/.herdr/worktrees}"
HOSTNAME="$(hostname -s 2>/dev/null || hostname)"

# --- Alertas ---
NTFY_TOPIC="${NTFY_TOPIC:-lab10-herdr-devbox-health}"
NTFY_URL="${NTFY_URL:-https://ntfy.sh}"
ALERT_COOLDOWN_S="${ALERT_COOLDOWN_S:-1800}"   # no repetir la misma alerta en 30min
ALERT_STRIKES="${ALERT_STRIKES:-3}"            # N lecturas seguidas superando umbral

# Umbrales
TH_MEM_PCT="${TH_MEM_PCT:-90}"          # % RAM usada
TH_DISK_FREE_MB="${TH_DISK_FREE_MB:-5120}"   # MB libres en /
TH_PSI_MEM="${TH_PSI_MEM:-20}"          # PSI memory some avg10
TH_SWAP_PCT="${TH_SWAP_PCT:-50}"        # % swap usada (si hay swap)
TH_LOAD15="${TH_LOAD15:-$(( $(nproc) * 2 ))}"  # load15 sostenido (default 2x CPUs)

# Estado interno de alertas (contadores de strikes y último envío)
declare -A STRIKES=()
declare -A LAST_SENT=()

now_epoch() { date +%s; }

# alert_check <key> <condición 0/1> <mensaje>
alert_check() {
  local key="$1" breached="$2" msg="$3"
  if [ "$breached" = "1" ]; then
    STRIKES[$key]=$(( ${STRIKES[$key]:-0} + 1 ))
  else
    STRIKES[$key]=0
  fi

  if [ "${STRIKES[$key]}" -ge "$ALERT_STRIKES" ]; then
    local now last
    now=$(now_epoch)
    last=${LAST_SENT[$key]:-0}
    if [ $(( now - last )) -ge "$ALERT_COOLDOWN_S" ]; then
      LAST_SENT[$key]=$now
      STRIKES[$key]=0
      echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"level\":\"ALERT\",\"alert\":\"$key\",\"msg\":\"$msg\"}"
      # Push a ntfy (no bloquear el loop si falla)
      curl -s -m 5 \
        -H "Title: herdr-devbox: $key" \
        -H "Priority: high" \
        -H "Tags: warning" \
        -d "$msg" \
        "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1 || true
    fi
  fi
}

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # --- RAM ---
  mem_total_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  mem_avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  mem_used_mb=$((mem_total_mb - mem_avail_mb))
  mem_used_pct=$(( (mem_used_mb * 100) / mem_total_mb ))

  # Swap
  swap_total_mb=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
  swap_free_mb=$(awk '/SwapFree/{print int($2/1024)}' /proc/meminfo)
  swap_used_mb=$((swap_total_mb - swap_free_mb))
  swap_used_pct=0
  [ "$swap_total_mb" -gt 0 ] && swap_used_pct=$(( (swap_used_mb * 100) / swap_total_mb ))

  # --- PSI ---
  psi_mem_some=$(awk '/some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/memory 2>/dev/null || echo 0)
  psi_io_some=$(awk '/some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/io 2>/dev/null || echo 0)
  psi_cpu_some=$(awk '/some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/cpu 2>/dev/null || echo 0)

  # --- Disco ---
  disk_root_avail_mb=$(df -m / --output=avail 2>/dev/null | tail -1 | tr -d ' ')
  disk_root_used_pct=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')

  if [ -d "$WORKTREE_ROOT" ]; then
    worktree_count=$(find "$WORKTREE_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    worktree_size_mb=$(du -sm "$WORKTREE_ROOT" 2>/dev/null | awk '{print $1}')
  else
    worktree_count=0
    worktree_size_mb=0
  fi

  # --- Carga ---
  read -r load1 load5 load15 procs _ < /proc/loadavg
  procs_running="${procs%/*}"
  procs_total="${procs#*/}"

  # --- Servicios ---
  gateway_up=$(systemctl is-active herdr-gateway 2>/dev/null || echo unknown)
  caddy_up=$(systemctl is-active caddy 2>/dev/null || echo unknown)

  agent_procs=$(pgrep -c -f 'claude|node.*server\.js' 2>/dev/null || echo 0)

  # --- Heartbeat JSON ---
  printf '{"ts":"%s","host":"%s","mem_used_mb":%s,"mem_used_pct":%s,"mem_avail_mb":%s,"swap_used_mb":%s,"psi_mem_some":%s,"psi_io_some":%s,"psi_cpu_some":%s,"disk_root_avail_mb":%s,"disk_root_used_pct":%s,"worktree_count":%s,"worktree_size_mb":%s,"load1":%s,"load5":%s,"load15":%s,"procs_running":%s,"procs_total":%s,"agent_procs":%s,"gateway":"%s","caddy":"%s"}\n' \
    "$ts" "$HOSTNAME" \
    "$mem_used_mb" "$mem_used_pct" "$mem_avail_mb" "$swap_used_mb" \
    "${psi_mem_some:-0}" "${psi_io_some:-0}" "${psi_cpu_some:-0}" \
    "${disk_root_avail_mb:-0}" "${disk_root_used_pct:-0}" \
    "${worktree_count:-0}" "${worktree_size_mb:-0}" \
    "$load1" "$load5" "$load15" \
    "${procs_running:-0}" "${procs_total:-0}" "${agent_procs:-0}" \
    "$gateway_up" "$caddy_up"

  # --- Evaluación de alertas ---
  [ "$mem_used_pct" -ge "$TH_MEM_PCT" ] && c=1 || c=0
  alert_check "mem_high" "$c" "RAM al ${mem_used_pct}% (${mem_avail_mb} MB libres) durante ${ALERT_STRIKES} lecturas"

  [ "$disk_root_avail_mb" -le "$TH_DISK_FREE_MB" ] && c=1 || c=0
  alert_check "disk_low" "$c" "Disco / con ${disk_root_avail_mb} MB libres (worktrees: ${worktree_size_mb} MB en ${worktree_count} dirs)"

  psi_breached=0
  awk -v v="$psi_mem_some" -v th="$TH_PSI_MEM" 'BEGIN{exit !(v>=th)}' && psi_breached=1
  alert_check "psi_mem" "$psi_breached" "Presión de memoria sostenida (PSI some avg10=${psi_mem_some})"

  [ "$swap_used_pct" -ge "$TH_SWAP_PCT" ] && [ "$swap_total_mb" -gt 0 ] && c=1 || c=0
  alert_check "swap_high" "$c" "Swap al ${swap_used_pct}% (${swap_used_mb}/${swap_total_mb} MB)"

  [ "$gateway_up" != "active" ] && c=1 || c=0
  alert_check "gateway_down" "$c" "herdr-gateway no está activo (estado: $gateway_up)"

  [ "$caddy_up" != "active" ] && c=1 || c=0
  alert_check "caddy_down" "$c" "caddy no está activo (estado: $caddy_up)"

  load_breached=0
  awk -v v="$load15" -v th="$TH_LOAD15" 'BEGIN{exit !(v>=th)}' && load_breached=1
  alert_check "load_high" "$load_breached" "Carga sostenida: load15=${load15} (umbral ${TH_LOAD15}, procs=${procs_total}, agentes=${agent_procs})"

  [ -n "${RUN_ONCE:-}" ] && exit 0   # modo test: RUN_ONCE=1 ./monitor.sh
  sleep "$INTERVAL"
done
