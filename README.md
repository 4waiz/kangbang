# KANG BANG

A fast, original browser-based competitive sci-fi FPS. Six classes, ten weapons,
eight modes, three maps, real multiplayer with an authoritative server, bots that
actually navigate, and a full progression system. No plugins, no downloads —
it runs in a browser tab.

Built with TypeScript, Three.js and Node. Every model is generated from Blender
Python source in this repository; every sound is synthesised at runtime with the
Web Audio API; every texture is drawn procedurally to a canvas. There are no
third-party game assets of any kind.

```
┌──────────────────────────────────────────────────────────────────┐
│  1. npm install                                                  │
│  2. cp .env.example .env                                         │
│  3. npm run dev          →  http://localhost:5173                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Contents

- [Quick start](#quick-start)
- [Every command](#every-command)
- [What is in the box](#what-is-in-the-box)
- [Controls](#controls)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [Licence and originality](#licence-and-originality)

---

## Quick start

### 1. Install

```bash
npm install
```

Installs all three workspaces. There are no native dependencies and no build
step for the shared package — the client and server both consume its TypeScript
source directly, which is what guarantees the client predicts with byte-identical
simulation code to the server's authority.

### 2. Configure

```bash
cp .env.example .env
```

The defaults work out of the box: SQLite persistence into `./data/kangbang.db`,
bots filling matches, guest accounts enabled. Nothing in `.env.example` is a real
secret. Before deploying, generate your own:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The server **refuses to start** with `NODE_ENV=production` unless `SESSION_SECRET`
is set.

### 3. Play

```bash
npm run dev
```

Starts the game server on **:2567** and the client on **:5173**. Open
<http://localhost:5173>, enter a name, and press **QUICK PLAY**. You will be
dropped into a match against bots within a couple of seconds.

---

## Every command

### Running the game

| Command | What it does |
| --- | --- |
| `npm run dev` | Server + client together with hot reload. Play at <http://localhost:5173>. |
| `npm run dev:server` | Authoritative game server only, on `:2567`. |
| `npm run dev:client` | Vite dev client only, on `:5173`. Expects a server on `:2567`. |
| `npm start` | Run the built production server (`npm run build` first). |

### Multiple test clients

```bash
npm run clients                 # 2 tiled browser windows, separate guest identities
npm run clients -- --count=4    # 4 windows
npm run clients -- --code=ABCD  # every window deep-links into one room
```

Each window gets its own Chrome profile directory, so each is a genuinely
separate player — sharing a profile would make the server treat the second
window as a reconnect of the first. Press `Ctrl+C` in the terminal to close them
all.

To play across two machines on a LAN, start the server with `HOST=0.0.0.0` and
open `http://<your-ip>:5173` on the other machine.

### Bots and automated verification

```bash
npm run bots                    # headless: 2 socket clients + bots, 25s of real combat
node tools/bot-match.mjs --clients 4 --bots 6 --mode tdm --seconds 40
node tools/browser-check.mjs                       # 24 checks in real Chrome
node tools/browser-check.mjs --url http://localhost:4173 --shots ./screenshots
```

`bots` connects real WebSocket clients that aim, fire, reload and die, then
asserts the server produced damage in both directions, kill-feed entries and
respawns. `browser-check` drives actual Chrome through the boot sequence, all
eleven menu screens, a live match, the HUD, the scoreboard and the pause menu,
and fails on any console error, page error or failed request.

### Assets

```bash
npm run assets          # regenerate all 59 GLB models from Blender source (~20s)
npm run assets:check    # verify all required models exist, without rebuilding
```

Requires Blender. Set `BLENDER_PATH` if it is not on your `PATH`. The exported
`.glb` files are committed, so this is only needed when changing a model. See
[BLENDER_PIPELINE.md](docs/BLENDER_PIPELINE.md).

### Tests, linting, types

```bash
npm test                # 415 tests across 9 suites
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
npm run typecheck       # tsc --noEmit over all three packages
npm run lint            # eslint
npm run lint:fix
npm run verify          # typecheck + test + build, in that order
```

### Production build

```bash
npm run build           # server bundle + client static bundle
npm run build:server    # → packages/server/dist/index.mjs  (385 KB, single file)
npm run build:client    # → packages/client/dist/           (895 KB, 244 KB gzipped)
npm start               # serve the built server
```

To sanity-check the built client against the built server:

```bash
npm run build
npm start &
npm run preview -w @kang/client        # → http://localhost:4173
```

### Docker

```bash
# A secret is required; generate one and export it (or put it in .env):
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")

npm run docker:up       # or: docker compose up --build
```

Play at **<http://localhost:8080>**. nginx serves the client and reverse-proxies
`/api` and `/ws` to the server container, so the browser only ever talks to one
origin — no CORS, no second hostname. Progression persists in a named volume.

```bash
docker compose --profile postgres up --build   # exercise the Postgres path
npm run docker:down                            # stop
```

See [DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## What is in the box

**Movement** — sprint, crouch, slide, slide-hop, air control with a speed cap,
momentum preservation, automatic step-up, slope handling, ledge grab-free clean
collision, head bob, FOV shift under sprint, weapon sway and recoil. The whole
thing is one deterministic fixed-step function shared by client and server.

**10 weapons** — Pulse Assault Rifle, Plasma SMG, Rail Sniper, Ion Shotgun,
Heavy Particle LMG, Burst Carbine, Energy Pistol, Tactical Revolver, Plasma Blade,
Arc Launcher. Each has a first-person model, a world model, a full stat block
(damage, falloff, RPM, spread, recoil pattern, magazine, reload, ADS behaviour,
penetration), synthesised audio, muzzle flash, tracers, impact decals and an icon.

**6 classes** — Vanguard, Phantom, Titan, Warden, Spectre, Engineer. Each has a
passive, an active ability and an ultimate, plus its own movement profile and
effective-health band. Tested to be non-degenerate: the tankiest class is never
also the fastest.

**8 modes** — Free-for-All, Team Deathmatch, Domination, Hardpoint, Capture the
Core, Gun Progression, Elimination, and Custom (every rule adjustable). All eight
are played to completion in the test suite.

**3 maps** — Neon Foundry, Orbital Nexus, Mirage District. Each is authored as
brush geometry that is simultaneously the render mesh, the collision hull, the
navmesh source and the Blender export. Every map is verified to have a single
connected navmesh component, no spawn embedded in geometry, no spawn that ejects
the player, and full pathability between all spawns and objectives.

**Netcode** — 60 Hz authoritative simulation, 20 Hz binary snapshots, client
prediction with rewind-and-replay reconciliation, entity interpolation with
capped extrapolation, and lag compensation that rewinds hitboxes to the shooter's
view of the world.

**Bots** — real navmesh pathfinding, cover use, objective play, ability usage,
and three difficulties that differ in reaction time and aim error, never in
health or damage.

**Progression** — account levels, per-weapon and per-class mastery, daily and
weekly challenges, achievements, career statistics, leaderboards, and cosmetics
that are enforced by test to carry no gameplay stat whatsoever.

Full detail in [GAMEPLAY_SYSTEMS.md](docs/GAMEPLAY_SYSTEMS.md).

---

## Controls

`W A S D` move · `Space` jump · `Shift` sprint · `Ctrl` crouch/slide ·
`Mouse1` fire · `Mouse2` aim · `R` reload · `1` `2` `3` weapons · `Q` ability ·
`F` ultimate · `V` melee · `E` interact · `Tab` scoreboard · `T` chat ·
`Y` team chat · `Esc` pause

Every binding is remappable in Settings → Controls, with conflict detection.
Full reference including accessibility options: [CONTROLS.md](docs/CONTROLS.md).

---

## Repository layout

```
kangbang/
├── packages/
│   ├── shared/          Simulation, wire protocol, data tables. No I/O.
│   │   └── src/
│   │       ├── sim/         movement, ballistics, collision world, navmesh
│   │       ├── data/        weapons, classes, modes, maps, cosmetics, progression
│   │       ├── protocol.ts  binary + JSON codecs, input sanitisation
│   │       └── __tests__/   movement, weapons, maps, spawns, protocol, progression
│   ├── server/          Authoritative Node server.
│   │   └── src/
│   │       ├── game/        match, modes, players, bots, progression awards
│   │       ├── net/         room, room manager, WebSocket server
│   │       ├── db/          memory | sqlite | postgres behind one interface
│   │       ├── api/         REST router, session tokens
│   │       └── __tests__/   match/modes/scoring, rooms, persistence
│   └── client/          Browser client.
│       └── src/
│           ├── engine/      renderer, textures, audio, input, FX pools, assets
│           ├── game/        prediction, reconciliation, interpolation, viewmodel
│           ├── ui/          HUD + 17 screens, icons, DOM helpers
│           └── styles/      design system
├── assets/
│   └── scripts/         Blender Python that generates every model
├── docker/              Dockerfiles + nginx config
├── docs/                The 12 documents below
└── tools/               asset build, bot match, browser check, multi-client launcher
```

Roughly 32,000 lines of TypeScript across 69 files, plus the Blender generators.

---

## Documentation

| Document | Covers |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Package boundaries, data flow, why the shared package is consumed as source, key design decisions and their trade-offs. |
| [GAMEPLAY_SYSTEMS.md](docs/GAMEPLAY_SYSTEMS.md) | Movement model, weapons, classes, abilities, modes, maps, bots, progression — with the actual numbers. |
| [NETWORKING.md](docs/NETWORKING.md) | Tick and snapshot rates, the binary wire format byte by byte, prediction, reconciliation, interpolation, lag compensation, reconnect. |
| [BLENDER_PIPELINE.md](docs/BLENDER_PIPELINE.md) | How models are generated, the Z-up→Y-up problem and its fix, adding a new model, regenerating everything. |
| [ASSET_MANIFEST.md](docs/ASSET_MANIFEST.md) | Every asset, its source, its size, its licence. Confirms zero third-party content. |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Day-to-day workflow, adding a weapon/class/mode/map, debugging, conventions. |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, Postgres, TLS, scaling, environment variables, health checks, backups. |
| [TESTING.md](docs/TESTING.md) | What each suite covers, how to run it, how the browser and bot verification work, bugs the tests have actually caught. |
| [PERFORMANCE.md](docs/PERFORMANCE.md) | Frame budget, measured numbers, pooling, culling, LODs, instancing, leak avoidance, quality presets. |
| [SECURITY.md](docs/SECURITY.md) | Threat model, server authority, validation, rate limits, anti-cheat design — and the explicit decision not to ship invasive anti-cheat. |
| [CONTROLS.md](docs/CONTROLS.md) | Every binding, every setting, accessibility options. |
| [CREDITS.md](docs/CREDITS.md) | Dependencies and their licences, originality statement. |
| [ACCEPTANCE.md](docs/ACCEPTANCE.md) | The verified acceptance checklist, known limitations, and the bugs the final verification pass caught. |

---

## Requirements

**To play:** any browser with WebGL2 — Chrome, Edge, Firefox or Safari, released
in the last few years. Pointer Lock is used for mouse look, so a mouse and
keyboard are needed.

**To develop:** Node 20 or newer (Node 22+ recommended; `node:sqlite` is used for
local persistence). Blender 4.x only if you intend to regenerate models.

---

## Licence and originality

MIT — see [LICENSE](LICENSE).

KANG BANG is an independent, original work. It contains no code, art, audio,
text, names, branding or design assets taken from any other game. All 3D models
are generated by the Blender Python scripts in `assets/scripts/`; all audio is
synthesised at runtime by `packages/client/src/engine/audio.ts`; all textures are
drawn procedurally by `packages/client/src/engine/textures.ts`. The full
accounting is in [ASSET_MANIFEST.md](docs/ASSET_MANIFEST.md) and
[CREDITS.md](docs/CREDITS.md).
