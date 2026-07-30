# Deployment

## Docker (recommended)

```bash
# A real secret is required. The stack refuses to start without one.
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")

docker compose up --build      # play at http://localhost:8080
docker compose down
```

Two containers:

```
                    ┌──────────────────────────┐
  browser  ────────►│ client   nginx:alpine    │
   :8080            │  /            static     │
                    │  /api/  ──┐              │
                    │  /ws    ──┤ proxy        │
                    └───────────┼──────────────┘
                                ▼
                    ┌──────────────────────────┐
                    │ server   node:22-alpine  │
                    │  one bundled .mjs, :2567 │
                    │  SQLite on a volume      │
                    └──────────────────────────┘
```

The server port is **not published**. Only the client container reaches it, over
the internal compose network. That means:

- one origin for the browser, so no CORS in production
- `wss://` works with no application change — the client derives its scheme from
  `window.location`
- no separate WebSocket hostname to configure or certify

Progression persists in the `kang-data` named volume, so `docker compose down`
and back up keeps player profiles. `docker compose down -v` deletes them.

### Images

| | Base | Contents |
| --- | --- | --- |
| Server | `node:22-alpine` | One 385 KB `.mjs` plus `ws`. esbuild inlines `@kang/shared`; `node:sqlite` is built into Node. Runs as the non-root `node` user. |
| Client | `nginx:1.27-alpine` | The static Vite bundle and `docker/nginx.conf`. |

Both are multi-stage: the toolchain stays in the build stage. Both typecheck
before building, so a broken image fails at build time rather than at runtime.

Both declare a `HEALTHCHECK`. The server's hits `/api/health`, which reflects the
simulation loop — a process that still holds the port but has stopped ticking is
correctly unhealthy. The client waits on the server being healthy before starting,
so there is no window where the page loads and cannot connect.

`.dockerignore` excludes `.env`, `.env.*` (keeping only `.env.example`), Blender
sources and the portable Blender install. A secret cannot reach an image layer,
and the build context stays small.

### Overriding configuration

Every value has a default; override with environment variables or a `.env` file
next to `docker-compose.yml`:

```bash
WEB_PORT=80 \
CORS_ORIGIN=https://play.example.com \
BOT_FILL_TARGET=10 \
BOT_DIFFICULTY=hard \
docker compose up --build
```

### Postgres

```bash
export SESSION_SECRET=...
export DB_DRIVER=postgres
export DATABASE_URL=postgres://kang:kang@postgres:5432/kangbang
docker compose --profile postgres up --build
```

The bundled Postgres container is for exercising that code path on a laptop. Its
password defaults to a throwaway value on purpose — compose interpolates every
service regardless of profile, so a `?required` marker there would break the
default SQLite stack. It is never published outside the compose network.

**A real deployment points `DATABASE_URL` at a managed database and does not run
that container at all.** The `pg` driver is lazy-loaded, so it is not needed
locally:

```bash
npm install pg -w @kang/server
```

---

## Single container (Fly.io, Railway, Render, Cloud Run)

Platforms that give you one container and one port cannot run the two-service
compose stack. For those, `docker/allinone.Dockerfile` builds one image in which
the game server also serves the client bundle (`SERVE_CLIENT=true`), with an SPA
fallback for deep links, long cache headers on fingerprinted assets, and the
served path confined to the bundle root.

```bash
docker build -f docker/allinone.Dockerfile -t kangbang:allinone .
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
docker run -p 8080:8080 \
  -e SESSION_SECRET="$SESSION_SECRET" \
  -e CORS_ORIGIN=http://localhost:8080 \
  kangbang:allinone
```

Verified: 24/24 browser checks pass against this image on a single port, including
the WebSocket.

The two-container compose stack is still the better shape for a real deployment —
nginx is a better static server than Node, and the two scale independently. Use
the single image when a second service costs more than nginx is worth.

### Fly.io

`fly.toml` is committed and ready. Fly suits this well: a long-lived process for
the 60 Hz tick loop, WebSockets with no configuration, and a volume for SQLite.

```bash
fly auth login
fly launch --no-deploy --copy-config --name kang-bang
fly volumes create kang_data --size 1 --region lhr
fly secrets set SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
fly deploy
fly open
```

Two settings in `fly.toml` are deliberate and worth not changing casually:

- `auto_stop_machines = false` — a game server must not be stopped between
  matches, and a cold start mid-session drops everyone in the room.
- `min_machines_running = 1` — same reason.

Update `CORS_ORIGIN` in `fly.toml` when you attach a custom domain.

### Why serverless does not work

Vercel, Netlify Functions, Lambda and friends cannot host the server. A function
cannot hold a persistent WebSocket or run a continuous 60 Hz simulation loop; both
are load-bearing here. The *client* is static and can go on any of them — point
`VITE_SERVER_URL` at wherever the server actually runs, and add that origin to
`CORS_ORIGIN`.

---

## Without Docker

```bash
npm ci
npm run build                  # server bundle + client static bundle

# Server
SESSION_SECRET=<real-secret> NODE_ENV=production npm start

# Client: serve packages/client/dist with any static host
```

The server refuses to start in production without a secret:

```
Error: SESSION_SECRET must be set when NODE_ENV=production
```

If the client is served from a **different** origin than the server, set both:

```bash
# server
CORS_ORIGIN=https://play.example.com

# client, at build time
VITE_SERVER_URL=https://api.example.com npm run build:client
```

Leaving `VITE_SERVER_URL` blank makes the client use its own origin, which is what
you want behind a proxy.

### systemd

```ini
[Unit]
Description=KANG BANG game server
After=network.target

[Service]
Type=simple
User=kang
WorkingDirectory=/opt/kangbang
EnvironmentFile=/etc/kangbang/env      # chmod 600, holds SESSION_SECRET
ExecStart=/usr/bin/node packages/server/dist/index.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/kangbang/data

[Install]
WantedBy=multi-user.target
```

---

## Reverse proxy

The WebSocket needs `Upgrade` and `Connection` forwarded verbatim and a read
timeout that outlasts a whole match. This is the single most common deployment
mistake — with a default 60 s read timeout, players get disconnected mid-match for
no visible reason.

### nginx

```nginx
location /ws {
    proxy_pass http://127.0.0.1:2567;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering     off;
}

location /api/ {
    proxy_pass http://127.0.0.1:2567;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}

location / {
    root /var/www/kangbang;
    try_files $uri $uri/ /index.html;
}

location = /index.html {
    add_header Cache-Control "no-cache, must-revalidate";
}

location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

`index.html` must not be cached, or players keep a stale client pointing at hashed
bundles that no longer exist. `/assets/` is fingerprinted by Vite, so it is safe
to cache forever. The shipped `docker/nginx.conf` does all of this already.

### Caddy

```
play.example.com {
    handle /ws* { reverse_proxy 127.0.0.1:2567 }
    handle /api/* { reverse_proxy 127.0.0.1:2567 }
    handle { root * /var/www/kangbang; try_files {path} /index.html; file_server }
}
```

### TLS

Terminate at the proxy; the app speaks plain HTTP inside the network. `wss://`
then works with no application change.

---

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `2567` | HTTP + WebSocket |
| `HOST` | `0.0.0.0` | `127.0.0.1` for local-only |
| `NODE_ENV` | `development` | `production` enables the strict secret check |
| `SESSION_SECRET` | — | **Required in production.** |
| `CORS_ORIGIN` | localhost list | Comma-separated allow-list; `*` is dev-only |
| `TICK_RATE` | `60` | Lower to save CPU; changes game feel |
| `SNAPSHOT_RATE` | `20` | |
| `MAX_ROOMS` | `64` | Per process |
| `MAX_PLAYERS_PER_ROOM` | `16` | Bots included |
| `DB_DRIVER` | `sqlite` | `sqlite` \| `postgres` \| `memory` |
| `SQLITE_PATH` | `./data/kangbang.db` | Parent directories are created |
| `DATABASE_URL` | — | Required when `DB_DRIVER=postgres` |
| `MOVE_TOLERANCE` | `1.05` | Extra anti-cheat slack. Raise only if legitimate players are flagged |
| `MSG_RATE_LIMIT` | `180` | Messages/second before throttling |
| `LOG_SUSPICIOUS` | `true` | Structured anti-cheat logging |
| `BOT_FILL` | `true` | Top matches up with bots |
| `BOT_FILL_TARGET` | `8` | |
| `BOT_DIFFICULTY` | `normal` | `easy` \| `normal` \| `hard` |
| `VITE_SERVER_URL` | *(blank)* | Client build-time. Blank = same origin |
| `VITE_BUILD_LABEL` | `local-dev` | Shown on the main menu |

---

## Scaling

A room lives entirely in the process that created it, and `roomManager` ticks all
of them from one loop. So:

- **Vertical first.** A single process handles many concurrent rooms; measure
  `avgTickMs` from `/api/health` and add capacity when it approaches 16 ms.
- **Horizontal by process, with sticky routing.** A player must reach the process
  holding their room, so route by IP hash or a session cookie. A round-robin load
  balancer will scatter a party across processes and they will not find each other.
- **Rooms do not shard.** One match never spans two processes. For ≤16 players per
  match this is the right shape; a persistent world would need a different one.
- **Shared Postgres for progression.** Any number of game processes can point at
  one database — profiles and leaderboards are global, matches are local.
- **The client is static.** Put `packages/client/dist` on a CDN and scale it for
  free.

A sketch for multiple game processes behind one hostname:

```nginx
upstream kang_game {
    hash $remote_addr consistent;   # sticky: a player keeps their process
    server 127.0.0.1:2567;
    server 127.0.0.1:2568;
    server 127.0.0.1:2569;
}
```

---

## Operations

### Health

```bash
curl -s http://localhost:2567/api/health
```

```json
{"ok":true,"name":"KANG BANG","protocol":7,"uptimeSec":4,"rooms":0,
 "players":0,"tickRate":60,"snapshotRate":20,"avgTickMs":0.01,
 "db":"sqlite","env":"production"}
```

Use it as the readiness probe. `ok:false` or a non-200 means the simulation loop
is not running.

### Logs

Structured JSON on stdout — ship it wherever you collect logs.

```json
{"ts":"2026-07-30T07:18:34.697Z","level":"info","scope":"server",
 "message":"KANG BANG server listening on http://0.0.0.0:2567",
 "db":"sqlite","tickRate":60,"snapshotRate":20}
```

Scopes: `boot`, `server`, `rooms`, `ws`, `anticheat`, `db`, `api`.

### Backups

**SQLite** — the file plus its WAL sidecars:

```bash
docker compose exec server sh -c 'cp /app/data/kangbang.db /app/data/backup.db'
docker compose cp server:/app/data/backup.db ./backup.db
```

Copying the `.db` alone while the server is running can miss committed
transactions still in the WAL.

**Postgres** — `pg_dump` as usual.

### Upgrading

```bash
git pull
docker compose up --build -d
```

The client is fingerprinted, so returning players get the new bundle on reload.
If `PROTOCOL_VERSION` changed, an old client is rejected with a message telling
them to refresh rather than silently desyncing — so a protocol bump is safe to
deploy without draining first, but expect players mid-match to be disconnected.

---

## Pre-deployment checklist

- [ ] `SESSION_SECRET` generated, and not the value from `.env.example`
- [ ] `CORS_ORIGIN` set to real origins, not `*`
- [ ] `NODE_ENV=production`
- [ ] TLS terminating at the proxy, `wss://` reachable
- [ ] Proxy read timeout ≥ one match length
- [ ] `index.html` not cached; `/assets/` cached long
- [ ] Persistence on a volume or a managed database, with a backup taken
- [ ] `/api/health` wired to the load balancer
- [ ] Logs shipped somewhere
- [ ] `npm run verify` clean on the deployed commit
- [ ] `docker compose up --build` verified locally against the same commit
