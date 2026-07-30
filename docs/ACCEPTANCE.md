# Final acceptance checklist

Every item below was verified by running it, on this commit. Commands are given so
any of it can be re-run.

```bash
npm run typecheck                       # clean
npm run lint                            # clean
npm test                                # 415 passed (9 files)
npm run assets:check                    # 59 GLBs, all 39 required present
npm run build                           # server 385 KB, client 894 KB / 244 KB gz
npm run bots                            # PASS
node tools/browser-check.mjs            # 24/24
docker compose up --build               # 24/24 through nginx at :8080
```

---

## Playability

- [x] **The game is genuinely playable in a browser** — 24/24 browser checks pass
      against both the dev client and the production bundle, and against the
      containerised stack over the nginx proxy.
- [x] **Boot to shooting in seconds** — enter a name, press QUICK PLAY, spawn into
      a match against bots.
- [x] **Real multiplayer proven** — headless: 2 socket clients + 4 bots, damage in
      both directions, 6 kill-feed entries, respawns, reloads. In-browser: 8-player
      scoreboard with bots fighting each other.
- [x] **No fake buttons, no dead menu items, no "coming soon"** — all 11 menu
      screens open and function; mid-match class and loadout changes work.
- [x] **No missing textures** — every texture is drawn procedurally, so a missing
      file is not expressible.
- [x] **No invisible collision** — brushes are simultaneously the render mesh and
      the collision hull. One geometry.
- [x] **No unhandled runtime errors** — the browser check fails on any page error,
      console error or failed request. Zero of each.

## Client

- [x] TypeScript + Vite + Three.js
- [x] WebGL2 required, WebGPU probed and reported (deliberate single render path —
      documented in ARCHITECTURE.md)
- [x] Pointer Lock mouse look, with correct release attribution
- [x] Web Audio, everything synthesised
- [x] 60 FPS target at 1080p medium; pooling, frustum culling, LODs, instancing,
      capped decals, explicit disposal

## Server

- [x] Node + TypeScript, authoritative
- [x] 60 Hz simulation, 20 Hz snapshots
- [x] Client prediction + rewind-and-replay reconciliation (soft 0.35 m / hard snap)
- [x] Entity interpolation at `serverTime − 100 ms`, extrapolation capped at 120 ms
- [x] Lag compensation, 250 ms rewind including interpolation delay
- [x] Binary wire protocol, quantised, versioned (`PROTOCOL_VERSION = 7`)

## Persistence

- [x] Abstraction with three drivers: memory, SQLite (dev), Postgres (prod)
- [x] Guest mode — no account needed, progression survives a refresh
- [x] Contract tested against two drivers so they cannot drift
- [x] **Verified across a container restart**: name, settings (`fov: 118`,
      `sensitivity: 3.3`), bindings (`forward: KeyI`) and loadouts
      (`primary: burst_carbine`) all survived

## Deployment

- [x] Docker: two multi-stage images, both healthchecked, server port unpublished
- [x] `docker compose up --build` → playable at `http://localhost:8080`
- [x] Postgres profile available
- [x] `.env.example` complete, with no real secret
- [x] Production builds verified booting and serving
- [x] Server **refuses to start** in production without `SESSION_SECRET` — verified

## Content

- [x] **10 weapons** — Pulse AR, Plasma SMG, Rail Sniper, Ion Shotgun, Heavy
      Particle LMG, Burst Carbine, Energy Pistol, Tactical Revolver, Plasma Blade,
      Arc Launcher. Each with FP + world model, full stat block, audio, FX, icon.
- [x] **6 classes** — Vanguard, Phantom, Titan, Warden, Spectre, Engineer. Each
      with passive + ability + ultimate.
- [x] **8 modes** — FFA, TDM, Domination, Hardpoint, Capture the Core, Gun
      Progression, Elimination, Custom. All seven fixed modes played to a real win
      condition in tests.
- [x] **3 maps** — Neon Foundry, Orbital Nexus, Mirage District. Spawns,
      objectives, cover, routes, lighting, skybox, ambience, minimap.
- [x] **No unfair spawn traps** — spawn scoring on enemy distance, recency and line
      of sight; every spawn verified not embedded, not ejecting, on solid ground.

## Movement feel

- [x] Sprint, jump, crouch, slide, slide-hop, air control, momentum, step-up,
      slope handling, head bob, FOV shift, recoil, sway, tracers, decals, hit
      markers, damage direction, screen shake, spectator

## Multiplayer features

- [x] Guest name, quick play, server browser, room codes, private rooms, teams,
      ready, countdown, join/leave, reconnect (30 s grace), ping, chat, team chat,
      mute, report, scoreboard, kill feed, results, rematch, bots

## Bots

- [x] Navmesh pathing, aim modelling, cover, objectives, abilities
- [x] Three difficulties differing only in reaction and aim — health and damage
      verified identical; hard demonstrably lands more hits than easy

## Progression

- [x] Levels, XP, weapon and class mastery, cosmetics, daily/weekly challenges,
      achievements, career stats, leaderboards
- [x] **Non-pay-to-win enforced by test** — a cosmetic that gained a gameplay stat
      field fails the suite

## UI

- [x] 17 screens, cohesive sci-fi design system, readable 1366×768 → ultrawide
- [x] Full settings: controls, graphics, audio, accessibility, crosshair
- [x] Accessibility: colourblind presets, enemy outlines, reduced motion, flash
      reduction, head-bob toggle, subtitles, UI scale, damage numbers, hit-marker
      style

## Security

- [x] Server-authoritative damage, scoring, position, ammo
- [x] Speed clamp, teleport revert, fire-rate gating, non-finite rejection, banked
      input dropped
- [x] Rate limits, text sanitisation (control/zero-width/bidi), origin allow-list
- [x] Suspicion scoring with structured logging
- [x] **No invasive or kernel-level anti-cheat** — explicit decision, documented
- [x] **No secret in the repository** — `.env` gitignored, `.env.example` is a
      template, `.dockerignore` excludes both

## Originality

- [x] **No copied branding, maps, characters, weapon models, UI, sounds, textures,
      code or names**
- [x] **No copyrighted game assets** — 59 models generated by Blender Python in
      this repo; regenerating produces no diff
- [x] **No copyrighted sounds** — every sound synthesised at runtime
- [x] Zero binary media files in the client source tree — verified by search

## Documentation

- [x] README with exact commands for install, asset generation, client, server,
      bots, multiple test clients, tests, production build, Docker
- [x] ARCHITECTURE, GAMEPLAY_SYSTEMS, NETWORKING, BLENDER_PIPELINE,
      ASSET_MANIFEST, DEVELOPMENT, DEPLOYMENT, TESTING, PERFORMANCE, SECURITY,
      CONTROLS, CREDITS
- [x] LICENSE (MIT)

---

## Known limitations

Stated because a checklist with no gaps is not a credible one.

1. **No snapshot interest management, so wallhacks work.** Every client receives
   every player's position. Culling changes gameplay (cloak, footstep audio,
   minimap, spectator), so it is a design change rather than a late patch. Reasoned
   through in [SECURITY.md](SECURITY.md).
2. **Aimbots cannot be prevented in a browser.** Server-side hit validation bounds
   what one achieves; it does not eliminate them.
3. **No persistent ban system.** Suspicion removes a player from a room but does
   not persist. The schema and logging support adding it.
4. **Postgres is not exercised in the default test run.** It implements the same
   tested interface as SQLite and shares the contract suite, but a fresh clone
   tests SQLite only.
5. **WebGPU is probed, not used.** One render path is deliberate; see
   [ARCHITECTURE.md](ARCHITECTURE.md).
6. **Frame rate is not measured in CI.** Headless Chrome uses software
   rasterisation, so its ~10 FPS is meaningless. Real-GPU measurement is manual via
   Settings → Graphics → Show FPS.
7. **Synthesised audio cannot sound recorded.** It is designed to be *readable* —
   every weapon distinguishable by ear — which is the competitive requirement, and
   it is what keeps the game free of third-party samples.

---

## Bugs found and fixed during verification

The last pass was not a formality. It found and fixed:

| Bug | How it surfaced |
| --- | --- |
| SVG icon markup rendered as literal text in 11 menu buttons and the map cards — the icon helpers returned HTML strings and were passed into child positions | A screenshot. Nothing automated could see it: no error, no missing element, correct button count. Now guarded by a markup-leak check, and the helpers return elements. |
| Seven character GLBs drew their full-detail and decimated meshes overlapping — the `*_LOD1` siblings were exported into the same file and never paired | Reading the GLB while writing BLENDER_PIPELINE.md. Now paired into `THREE.LOD` with a bounding-sphere-derived switch distance. |
| The server Docker image failed to build: the runtime stage copied the workspace manifest, which declares `@kang/shared` — inlined by esbuild and absent from any registry | `docker compose build`. Now derives a runtime-only manifest. |
| A shared test imported from the **client** package, so the server image could not typecheck | The same Docker build. The surface table now lives in `shared` as one definition, and `rootDir` makes a cross-package import a compile error. |
| `docker compose up` failed on a missing `POSTGRES_PASSWORD` even with the postgres profile inactive, because compose interpolates every service | `docker compose config` |
| `browser-check` accepted only `--url value` while `open-clients` used `--url=value` | Running them side by side |
| The bearer scheme was matched case-sensitively, silently downgrading a lowercase `authorization: bearer` to anonymous | `persistence.test.ts` |
| `npm run clients` pointed at a `tools/open-clients.mjs` that did not exist | Reading the README as written |
| `.env.example` had stray keyboard input in the middle of it | Reading the file |
| The reported server bundle size counted the source map, roughly tripling it | Reading the build output |
