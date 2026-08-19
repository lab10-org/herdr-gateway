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

`blocked` = el agente pide aprobación/input (revísalo en Herdr o mándale input por su pane).

### `GET /tasks/:id/output?lines=200`
Transcripción reciente del agente (recent-unwrapped).

### `DELETE /tasks/:id`
Cierra el tab en Herdr y elimina el worktree (mantiene la rama).

## Webhooks

POST JSON a `webhook_url` en cada transición de estado:
```json
{"task_id":"t-...","status":"done","error":null,"branch":"task/t-...","worktree":"...","updated_at":"..."}
```

## Systemd

```bash
cp herdr-gateway.service /etc/systemd/system/
# editar Environment= al gusto
systemctl enable --now herdr-gateway
```
