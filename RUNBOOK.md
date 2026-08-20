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

## 1b. Exposición pública (ejecutada 2026-08-20)

Estado actual: **expuesto en `https://devbox.lab10.ai`**.

Cadena: Internet → Cloudflare (proxied, SSL Full) → Caddy (`/etc/caddy/Caddyfile`,
copia versionada en `caddy/Caddyfile`) → `127.0.0.1:4040` (systemd `HOST=127.0.0.1`).

- **TLS**: certificado automático de Caddy (Let's Encrypt). El challenge ACME pasa
  por Cloudflare sin problema.
- **Firewall (ufw)**: `deny (incoming)` por defecto; permite 22/tcp (SSH) y 80/443
  **solo desde rangos IPv4 de Cloudflare**
  (`curl -s https://www.cloudflare.com/ips-v4/`). Refresca rangos si CF los cambia.
- **4040**: solo loopback; jamás expuesto directo (y ufw lo denegaría de todas formas).
- **Token**: rotado el 2026-08-20 tras el cambio de exposición. Está en el unit de
  systemd (`/etc/systemd/system/herdr-gateway.service`); NO en este repo.
- **Rate limiting**: sin soporte en Caddy stock → debe configurarse como regla en
  Cloudflare (el gateway no tiene límite de concurrencia propio).

Verificación periódica:
```bash
curl -s https://devbox.lab10.ai/health                        # debe dar {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer wrong" \
  https://devbox.lab10.ai/tasks                               # debe dar 401
ufw status numbered | head                                     # reglas CF presentes
```

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

Para retirar la exposición pública (volver a Tailscale-only):
```bash
sed -i 's/HOST=127.0.0.1/HOST=100.93.130.60/' /etc/systemd/system/herdr-gateway.service
systemctl daemon-reload && systemctl restart herdr-gateway
systemctl disable --now caddy
ufw delete allow 80/tcp && ufw delete allow 443/tcp   # y el resto de reglas CF
```


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
