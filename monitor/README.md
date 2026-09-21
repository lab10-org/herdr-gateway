# herdr-monitor

Servicio systemd independiente que emite un heartbeat JSON de métricas del host
cada 10s a journald, y dispara alertas push (ntfy.sh) cuando se superan umbrales.

**Diseño deliberado**: vive fuera del proceso del gateway. Si el gateway muere
por OOM, el monitor sigue logeando hasta el final — eso es lo que queremos
medir en producción ("¿hasta dónde tolera la máquina?").

## Instalación

```bash
cp monitor/herdr-monitor.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now herdr-monitor
```

## Métricas (heartbeat, cada 10s)

| Campo | Fuente | Por qué |
|---|---|---|
| `mem_used_pct`, `mem_avail_mb` | `/proc/meminfo` (MemAvailable) | memoria utilizable real |
| `swap_used_mb` | `/proc/meminfo` | swapping = presión real |
| `psi_mem/io/cpu_some` | `/proc/pressure/*` | detecta contención ANTES del OOM |
| `disk_root_avail_mb` | `df /` | worktrees crecen aquí |
| `worktree_count`, `worktree_size_mb` | `du` en WORKTREE_ROOT | fugas de worktrees del gateway |
| `load1/5/15` | `/proc/loadavg` | saturación CPU |
| `agent_procs` | `pgrep claude/node` | nº de agentes vivos |
| `gateway`, `caddy` | `systemctl is-active` | salud de servicios clave |

## Alertas

Cada alerta necesita **3 lecturas seguidas** superando el umbral (histéresis,
~30s) y tiene **cooldown de 30min** para no spamear.

| Alerta | Umbral | Significado |
|---|---|---|
| `mem_high` | RAM ≥ 90% (default; **80% en producción** tras drop-in) | cerca de OOM |
| `disk_low` | / libre ≤ 5 GB | llenarse = todo falla |
| `psi_mem` | PSI some ≥ 20 | memoria contendeda sostenida |
| `swap_high` | swap ≥ 50% | RAM insuficiente, rindiendo mal |
| `load_high` | load15 ≥ 2×CPUs (**16 aquí**) | saturación CPU sostenida |
| `gateway_down` | is-active ≠ active | el servicio cayó |
| `caddy_down` | is-active ≠ active | el proxy cayó |

Canal de push: `https://ntfy.sh/lab10-herdr-devbox-health`
(suscríbete con la app ntfy en el móvil; topic público pero no listado —
cámbialo con `NTFY_TOPIC` si quieres rotarlo).

## Config (variables de entorno en el unit)

`INTERVAL` (10s), `ALERT_STRIKES` (3), `ALERT_COOLDOWN_S` (1800),
`TH_MEM_PCT` (90), `TH_DISK_FREE_MB` (5120), `TH_PSI_MEM` (20),
`TH_SWAP_PCT` (50), `TH_LOAD15` (2×nproc), `NTFY_TOPIC`, `NTFY_URL` (self-hosteable).

Overrides en producción (no editar el unit base directamente):
`/etc/systemd/system/herdr-monitor.service.d/alerts.conf`
(el repo trae el archivo en `monitor/herdr-monitor.service.d/alerts.conf`):

```bash
systemctl daemon-reload && systemctl restart herdr-monitor
```

Valores actuales: `TH_MEM_PCT=80` (antes 90, el freeze llegó más rápido que
los 3 strikes a 90%), `ALERT_STRIKES=2` (~20s en vez de ~30s),
`TH_LOAD15=16` en esta VM de 8 vCPU.

## Consultas útiles

```bash
# Seguir métricas en vivo
journalctl -u herdr-monitor -f -o cat

# Solo alertas
journalctl -u herdr-monitor --since today -o cat | grep '"level":"ALERT"'

# Última hora de RAM (máx/media) con jq
journalctl -u herdr-monitor --since "1h ago" -o cat --no-pager \
  | jq -s 'map(.mem_used_pct) | {max: max, avg: (add/length)}'

# Crecimiento de worktrees hoy
journalctl -u herdr-monitor --since today -o cat --no-pager \
  | jq -r '[.ts[11:19], .worktree_count, .worktree_size_mb] | @tsv'

# Post-mortem de un OOM: qué pasó en los 10 min antes de que cayera
journalctl -u herdr-monitor --since "2026-08-20 19:00" --until "2026-08-20 19:10" -o cat

# Test manual de una pasada
RUN_ONCE=1 /root/herdr-gateway/monitor/monitor.sh

# Test E2E de alerta (fuerza umbral, 1 strike, sin cooldown)
TH_MEM_PCT=1 ALERT_STRIKES=1 ALERT_COOLDOWN_S=0 RUN_ONCE=1 \
  /root/herdr-gateway/monitor/monitor.sh | grep ALERT
```

## Limitaciones conocidas

- Si la **máquina entera** muere, el monitor también (no puede avisar).
  Complementar con un healthcheck externo a `https://devbox.lab10.ai/health`
  (Uptime Kuma / Better Stack / cron externo).
- `du -sm` de worktrees cada 10s es barato hoy (GBs); si crece a cientos de GB
  con muchos dirs, subir `INTERVAL` o cachear.
- Estado de alertas en memoria: un restart del monitor resetea strikes/cooldowns
  (puede reenviar una alerta activa una vez; aceptable).
