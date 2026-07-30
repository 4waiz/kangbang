# Development

## Setup

```bash
npm install
cp .env.example .env
npm run dev            # server :2567 + client :5173
```

Node 20 minimum; Node 22+ recommended, because local persistence uses the
built-in `node:sqlite`. Blender 4.x only if you are changing a model.

There is no build step for `packages/shared` — the client aliases it to source in
`vite.config.ts`, the server runs it through `tsx`, and tests alias it in
`vitest.config.ts`. Editing a shared file hot-reloads both sides at once, and it
is impossible to ship a client predicting with different code than the server
simulates with. See [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Daily loop

```bash
npm run dev                    # both
npm run dev:server             # server only
npm run dev:client             # client only, expects a server on :2567

npm run clients                # 2 real browser windows, separate guest identities
npm run clients -- --count=4

npm test                       # 415 tests, ~3 s
npm run test:watch
npm run typecheck
npm run lint
npm run verify                 # typecheck + test + build

npm run bots                   # headless multiplayer combat assertions
node tools/browser-check.mjs   # 24 checks in real Chrome
```

The tight loop for gameplay work is `npm run dev` plus `npm run test:watch` on the
relevant suite. The tight loop for netcode work is `npm run dev:server` plus
`npm run bots`, because the bot driver prints exactly what the server did.

---

## Where things live

| Change | File |
| --- | --- |
| A tuning number (speed, gravity, tick rate, tolerance) | `packages/shared/src/constants.ts` |
| Movement feel | `packages/shared/src/sim/movement.ts` |
| Weapon stats | `packages/shared/src/data/weapons.ts` |
| Class stats and abilities | `packages/shared/src/data/classes.ts` |
| Mode rules and limits | `packages/shared/src/data/modes.ts` + `packages/server/src/game/modes.ts` |
| Map geometry | `packages/shared/src/data/maps/*.ts` |
| Cosmetics, achievements, challenges | `packages/shared/src/data/{cosmetics,progression}.ts` |
| Settings and key bindings schema | `packages/shared/src/data/settings.ts` |
| Wire format | `packages/shared/src/protocol.ts` (bump `PROTOCOL_VERSION`) |
| Damage, scoring, abilities in flight | `packages/server/src/game/match.ts` |
| Bot behaviour | `packages/server/src/game/bots.ts` |
| Lobby, chat, teams, reconnect | `packages/server/src/net/room.ts` |
| REST endpoints | `packages/server/src/api/router.ts` |
| Rendering, materials, lighting | `packages/client/src/engine/{renderer,mapRenderer}.ts` |
| Textures | `packages/client/src/engine/textures.ts` |
| Sounds | `packages/client/src/engine/audio.ts` |
| Muzzle flash, tracers, decals | `packages/client/src/engine/fx.ts` |
| First-person weapon feel | `packages/client/src/game/viewmodel.ts` |
| Prediction and reconciliation | `packages/client/src/game/session.ts` |
| HUD | `packages/client/src/ui/hud.ts` |
| Menus and screens | `packages/client/src/ui/app.ts` |
| Design system | `packages/client/src/styles/*.css` |
| Models | `assets/scripts/gen_*.py` |

---

## Adding a weapon

1. **Stats** — add an entry to `WEAPONS` and `WEAPON_ORDER` in
   `packages/shared/src/data/weapons.ts`. Every field is required; the tests will
   tell you if the block is internally inconsistent.

   Two traps worth knowing: `falloffEnd` must be strictly greater than
   `falloffStart` (equal values made the falloff divisor zero for two weapons
   during development), and `slot` must match where you intend it to be equippable.

2. **Model** — add a builder to `assets/scripts/gen_weapons.py` for both the
   first-person and world variants, with `muzzle`, `eject` and `grip` sockets.
   Register the model id in `tools/build-assets.mjs`. See
   [BLENDER_PIPELINE.md](BLENDER_PIPELINE.md).

3. **Icon** — add an SVG path to `WEAPON_PATHS` in
   `packages/client/src/ui/icons.ts` and map the weapon id to it. Silhouette
   first — it has to read at 22 px in the kill feed.

4. **Audio** — add a synthesis recipe in `packages/client/src/engine/audio.ts`.

5. Run `npm run assets && npm test`.

## Adding a class

1. Add to `CLASSES` and `CLASS_ORDER` in `packages/shared/src/data/classes.ts`:
   health, shield, movement profile, passive, ability, ultimate, default loadout,
   unlock level.
2. If the ability is a new *kind*, handle it in `useAbility()` in
   `packages/server/src/game/match.ts`. Existing kinds (`dash`, `cloak`, `barrier`,
   `dome`, `turret`, `scan`, …) need no server change.
3. Add a body builder to `assets/scripts/gen_characters.py`.
4. Add a class icon to `icons.ts`.
5. Run `npm test`. `progression.test.ts` enforces the balance invariants — effective
   health between 95 and 200, and the tankiest class must not also be the fastest.

## Adding a mode

1. Add a `ModeDef` to `packages/shared/src/data/modes.ts`.
2. Add a `ModeRules` subclass in `packages/server/src/game/modes.ts` overriding
   what differs — `setupObjectives`, `onKill`, `tickScoring`, `checkWin`,
   `canRespawn`, `leader`.
3. List the mode in each map's `modes` array.
4. Add a test to `match.test.ts` that plays the mode to a real win condition. Every
   existing mode has one; a mode that cannot end is the failure this catches.

## Adding a map

1. Create `packages/shared/src/data/maps/myMap.ts` using `MapBuilder`, and register
   it in `packages/shared/src/data/maps/index.ts` plus `MAP_ORDER`.
2. Build geometry from brushes. The `mapkit` helpers do most of the work:
   `box`, `wedge`, `ramp`, `stairs`, `slab`, `pillar`, `railing`, `lightPanel`,
   `neon`, `spawnCluster`, `spawnLookingAt`.
3. Place spawns with `spawnLookingAt(x, y, z, target)` rather than a raw yaw.
   Hand-written yaw was inverted during development and every player faced their own
   back wall — a bug that is invisible until you notice sprinting covers 3 m in
   2 s.
4. Place objectives, pickups, lighting, skybox and ambience.
5. Run `npm test`. `maps.test.ts` and `spawns.test.ts` will fail on: a fragmented
   navmesh, an unreachable objective, a ramp over 48°, under 1 m of headroom on a
   vertical route, geometry outside bounds, a spawn inside geometry, a spawn that
   ejects the player, or a spawn that is not on solid ground.

Expect to iterate here. Every one of those checks caught something real on the
three shipped maps.

---

## Changing the wire format

1. Edit the encoder **and** decoder in `packages/shared/src/protocol.ts`.
2. Bump `PROTOCOL_VERSION` in `constants.ts`. The server rejects a mismatched
   client with a clear message instead of desyncing silently.
3. Update the byte-layout comment above the function — it is the only
   documentation of the format that is guaranteed to be next to the code.
4. Add round-trip cases to `protocol.test.ts`, including extremes: a position at
   ±512 m, yaw at exactly 2π, a truncated packet, an oversized packet.

---

## Conventions

**Comments explain why, not what.** `// clamp speed` is noise. `// Compounding two
independent tolerances (as an earlier version did) produced a 1.8x ceiling that a
speed hack could hide inside` is the comment that stops someone reintroducing the
bug.

**No magic numbers in logic.** Anything tunable belongs in `constants.ts` or a data
table. If both sides of the network need it, it belongs in `shared`.

**Never fork a simulation constant.** Two definitions of gravity means the
reconciliation loop fights itself, and the symptom (occasional rubber-banding)
looks like a network problem for days.

**Server owns outcomes; the client sends intent.** Buttons and angles up, results
down. No exceptions.

**Return elements, not HTML strings, from UI helpers.** The icon helpers used to
return markup strings; passing one into a child position made the DOM builder
render `<svg width="22"...>` as visible text in eleven menu buttons. There is no
error and no missing element, so nothing catches it except looking. Elements
cannot be mistaken for text.

**Pool anything that spawns during play.** Fixed size, oldest recycled. See
[PERFORMANCE.md](PERFORMANCE.md).

**Assert behaviour, not implementation.** A test that checks `onGround` when the
requirement is "does not gain upward velocity" fails for the wrong reason later.

---

## Debugging

| Symptom | Where to look |
| --- | --- |
| Rubber-banding, position snapping | Reconciliation. Enable the network graph (Settings → Graphics) and watch corrections per second. A constant stream means client and server disagree systematically — usually a forked constant or a movement change on one side only. |
| Shots not registering | `npm run bots` and compare `shots` (client-side) with `serverShots` (confirmed). A gap means fire-rate gating or the trace. |
| Enemies teleporting | Interpolation. Check snapshot arrival rate; extrapolation is capped at 120 ms on purpose. |
| Player stuck in geometry | Depenetration. `spawns.test.ts` covers spawns; for mid-map cases, log the brush index the sweep reports. |
| Nowhere to walk / bots idle | The navmesh. `maps.test.ts` asserts a single connected component — if it passes but bots stand still, look at the A* start-node lookup. |
| Model wrong way round | `reorient()` in `lib_kang.py`. See [BLENDER_PIPELINE.md](BLENDER_PIPELINE.md). |
| Model black | Metallic material with no environment map. |
| UI element always visible | The UA `[hidden]` rule loses to any author rule that sets `display`. `base.css` has a global `[hidden] { display: none !important }` for exactly this. |
| Menus bounce to pause | Pointer Lock release attribution — a game-initiated release must not be treated as the user pressing Escape. |
| Markup visible as text | A helper returned an HTML string into a child position. The browser check now scans for this. |

`/api/health` gives uptime, rooms, players, average tick time and the active DB
driver. `LOG_SUSPICIOUS=true` prints anti-cheat events as structured JSON.

---

## Before opening a PR

```bash
npm run verify                 # typecheck + tests + builds
npm run lint
npm run bots                   # if you touched netcode, movement or combat
node tools/browser-check.mjs   # if you touched the client
npm run assets                 # if you touched a generator; commit the GLBs
```

Commit generated `.glb` files — contributors and CI must not need Blender.
