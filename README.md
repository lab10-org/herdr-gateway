# herdr-gateway

Entrypoint HTTP para ejecutar tareas en coding agents gestionados por Herdr.

Cada tarea:
1. Hace `git fetch origin main` + merge ff-only del checkout principal (best-effort).
2. Crea un **git worktree** nuevo (`task/<id>`) desde `origin/main` fresco.
3. Abre un **tab** en el workspace dedicado de Herdr (`http-tasks`).
4. Arranca un agente (`claude` por defecto) y le envía el prompt.
5. Reporta estado por **polling** (`GET /tasks/:id`) y **webhooks salientes**.

## Config (variables de entorno)

| Var | Default | Descripción |
|---|---|---|
| `PORT` | `4040` | Puerto HTTP |
| `GATEWAY_TOKEN` | `change-me` | Bearer token (auth estática) |
| `WORKSPACE_LABEL` | `http-tasks` | Workspace de Herdr dedicado |
| `DEFAULT_REPO` | — | Repo git por defecto |
| `AGENT_KIND` | `claude` | Agente por defecto (`pi`, `claude`, ...) |
| `AGENT_ARGS` | — | Args nativos del agente, separados por espacio |
| `WORKTREE_ROOT` | `/root/.herdr/worktrees` | Raíz de worktrees |
| `WEBHOOK_URL` | — | Webhook global (si la tarea no define uno) |
| `POLL_INTERVAL_MS` | `5000` | Intervalo de sondeo de estados |
| `SESSION_IDLE_TTL_MS` | `7200000` (2h) | Tiempo que la sesión del agente queda abierta para follow-ups tras `done` |
| `CLEANUP_INTERVAL_MS` | `3600000` (1h) | Intervalo del cleanup de recursos idle |
| `CLEANUP_IDLE_MS` | `86400000` (24h) | Antigüedad sin interacción para que el cleanup elimine recursos |
| `STATE_FILE` | `/root/.herdr/gateway-state.json` | Estado persistido (tareas + repos conocidos) |

## API

Auth: `Authorization: Bearer <GATEWAY_TOKEN>` (todo excepto `/health`).

### `POST /tasks`
```json
{
  "prompt": "Fix the failing tests",       // requerido
  "repo": "/path/to/repo",                  // opcional si DEFAULT_REPO
  "agent_kind": "claude",                   // opcional
  "agent_args": ["--model", "opus"],        // opcional
  "branch": "feat/x",                       // opcional (default task/<id>)
  "webhook_url": "https://..."              // opcional
}
```
→ `201` con la tarea (`id`, `status`, `worktree`, `branch`, ...).

### `GET /tasks` / `GET /tasks/:id`
Estado actual + historial de eventos.

Estados: `created` → `starting` → `working` → `done` | `blocked` | `error`.

`blocked` = el agente pide aprobación/input (respóndele con `POST /tasks/:id/messages`
o directamente en su pane de Herdr).

### `POST /tasks/:id/messages`
Continúa la conversación de una tarea: envía un mensaje de seguimiento al **mismo agente**
(misma sesión, mismo worktree/branch, contexto completo del diálogo previo).

```json
{ "message": "Now add tests for that fix" }
```
→ `202` con la tarea; el ciclo vuelve a `working` → `done` | `blocked`, disparando
webhooks como en una tarea nueva. Se puede encadenar cualquier número de mensajes.

Errores:
- `400` — falta `message`.
- `404` — tarea inexistente.
- `409` — el agente está ocupado con un mensaje anterior, la sesión expiró
  (idle TTL tras `done`, ver `SESSION_IDLE_TTL_MS`) o el proceso ya no corre.
  En esos casos, crea una tarea nueva.

Notas:
- También funciona cuando la tarea está `blocked`: el mensaje se entrega como input
  al agente (p. ej. una aprobación).
- Tras `done`, la sesión permanece disponible durante `SESSION_IDLE_TTL_MS`;
  pasado ese tiempo el tab se cierra automáticamente.

### `GET /tasks/:id/output?lines=200`
Transcripción reciente del agente (recent-unwrapped).

### `DELETE /tasks/:id`
Cierra el tab en Herdr, elimina el worktree y borra la rama local.

## Cleanup automático

Cada `CLEANUP_INTERVAL_MS` (1h por defecto) el gateway barre los recursos que llevan
más de `CLEANUP_IDLE_MS` (24h) sin interacción:

1. **Tareas conocidas** en estado `done` | `error` | `blocked` → cierra el tab,
   elimina el worktree y borra la rama local. Nunca toca tareas `working`/`starting`.
2. **Worktrees huérfanos** (`WORKTREE_ROOT/*/task-t-*`, p. ej. olvidados tras un
   reinicio): usa el mtime del dir como última actividad; si el repo origen ya no
   existe, borra el dir directamente. También cierra el tab asociado por label.
3. **Ramas stale** `task/t-*` sin tarea viva ni worktree que las use, con tip commit
   más viejo que el umbral.

La "última interacción" de una tarea es su `updated_at` (cambios de estado,
mensajes de follow-up, eventos). El estado se persiste en `STATE_FILE` en cada
evento, así el cleanup funciona aunque el gateway se reinicie. El cleanup corre
una primera vez ~1 min después del arranque y luego cada intervalo.

### Logs del cleanup

Cada recurso eliminado deja **una línea JSON** en journald (`journalctl -u herdr-gateway | grep '\[cleanup\]'`)
con el detalle exacto de lo borrado:

```json
{"at":"...","kind":"task","id":"t-e5cd...","status":"done","repo":"/root/lab10/lab10",
 "branch":"task/t-e5cd...","worktree":"/root/.herdr/worktrees/lab10/task-t-e5cd...",
 "prompt":"...","idle_hours":24.3,
 "deleted":["tab:wB:tB","worktree:/root/.herdr/...","branch:task/t-e5cd..."],"errors":[]}
```

`kind` puede ser: `task` (tarea conocida), `orphan` (worktree sin tarea viva,
incluye `origin_repo_missing` si el repo ya no existe), `stale_branch` (rama sin
worktree) y `manual_delete` (borrado vía `DELETE /tasks/:id`). `deleted` lista los
recursos efectivamente eliminados y `errors` los fallos parciales.

## Webhooks

POST JSON a `webhook_url` en cada transición de estado:
```json
{"task_id":"t-...","status":"done","error":null,"branch":"task/t-...","worktree":"...","updated_at":"..."}
```

## Exposición

Endpoint público: `https://devbox.lab10.ai` (Cloudflare proxied → Caddy → 127.0.0.1:4040).
Caddyfile versionado en `caddy/Caddyfile`. Detalles y checklist de seguridad en `RUNBOOK.md §1b`.

## Systemd

```bash
cp herdr-gateway.service /etc/systemd/system/
# editar Environment= al gusto
systemctl enable --now herdr-gateway
```
