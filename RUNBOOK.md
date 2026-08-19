# Runbook — exposición de herdr-gateway

Checklist previo a exponer el gateway fuera de localhost.

## 1. Seguridad (obligatorio)

- [ ] **Token fuerte**: regenerar y fijar en el unit de systemd
      `openssl rand -hex 32` → `GATEWAY_TOKEN` en `/etc/systemd/system/herdr-gateway.service`
- [ ] **TLS**: si sale de localhost/Tailscale → Caddy/nginx delante. Sin TLS el token
      equivale a tus credenciales en claro.
- [ ] **Firewall**: solo el puerto del proxy (443) abierto; 4040 jamás expuesto directo.
      `ufw allow 443; ufw deny 4040` (el proxy usa loopback)
- [ ] **Entender el impacto**: quien tenga el token puede ejecutar código arbitrario
      vía agentes en esta VPS. Valora un sudoers/alias o usuario dedicado si quieres acotar.
- [ ] **Sin DEFAULT_REPO sensible**: deja `DEFAULT_REPO` vacío; obliga a pasar `repo`
      explícito por petición (menos superficie de error).

## 2. Persistencia y arranque

- [ ] Instalar unit: `cp herdr-gateway.service /etc/systemd/system/`
- [ ] Editar `Environment=` (token, puerto; `AGENT_KIND` si no es claude)
- [ ] `systemctl daemon-reload && systemctl enable --now herdr-gateway`
- [ ] Verificar que el **server de Herdr está arriba** (dependencia dura):
      `herdr status` — el gateway falla si no hay sesión de Herdr corriendo.
- [ ] Comprobar reinicio: `systemctl restart herdr-gateway && curl localhost:4040/health`

## 3. Estado operativo conocido (limitaciones actuales)

- [ ] Tareas en memoria: un reinicio del gateway olvida las tareas (los agentes siguen
      en Herdr y los worktrees en disco). Si importa → añadir persistencia antes de exponer.
- [ ] Webhooks: 1 reintento y se abandona; sin guarantee de entrega. El consumidor debe
      hacer polling de respaldo (`GET /tasks/:id`).
- [ ] Recursos: cada tarea = 1 tab + 1 agente + 1 worktree. Sin límite de concurrencia
      ni cuota → un consumidor bugueado puede llenar la VPS. Valora rate-limit en el proxy
      o un tope de tareas activas en el gateway.
- [ ] GC: tareas terminales se purgan a las 24h (`MAX_TASK_AGE_MS`); worktrees NO se
      borran solos (solo vía `DELETE /tasks/:id`) → monitorizar disco en
      `/root/.herdr/worktrees`.

## 4. Smoke test pre-exposición

```bash
TOKEN=...   # el real
curl -s localhost:4040/health
curl -s -X POST localhost:4040/tasks -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt":"echo ok","repo":"<repo-de-prueba>","agent_kind":"pi"}'
curl -s localhost:4040/tasks -H "Authorization: Bearer $TOKEN"
curl -s localhost:4040/tasks -H "Authorization: Bearer wrong"   # debe dar 401
```

- [ ] Tarea completa llega a `done`
- [ ] Webhook de prueba recibido (si se usa)
- [ ] 401 con token erróneo / sin header
- [ ] Tras `systemctl restart`, el workspace `http-tasks` se reutiliza (no duplica)

## 5. Monitorización mínima

- [ ] Logs: `journalctl -u herdr-gateway -f`
- [ ] Healthcheck externo contra `/health` (sin auth) desde el consumidor o un cron
- [ ] Disco: worktrees acumulados (`du -sh /root/.herdr/worktrees`)
- [ ] Procesos agente vivos: `herdr agent list`

## 6. Rollback

```bash
systemctl disable --now herdr-gateway   # para el servicio
ufw delete allow 443                     # cierra el puerto si se abrió
rm /etc/systemd/system/herdr-gateway.service
herdr tab list --workspace <ws>          # revisar/agentes huérfanos
git -C <repo> worktree list              # limpiar worktrees si hace falta
```

## 7. Post-exposición

- [ ] Documentar en el consumidor: URL, token (en gestor de secretos), flujo
      `POST → poll GET → fallback`, y que `blocked` requiere intervención humana en Herdr.
- [ ] Rotación del token: editar unit + `systemctl restart` (downtime ~1s).
