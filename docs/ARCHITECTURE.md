# Architecture

## The one idea that shapes everything

A competitive shooter needs the client to *predict* movement — waiting a round
trip before you turn would be unplayable — and needs the server to be the *only*
authority on what actually happened. Those two requirements collide the moment
the two sides run different code. A 0.001 difference in ground friction produces
a visible rubber-band within a second of sprinting.

So the simulation lives in exactly one place, `packages/shared`, and both sides
import it. Not a copy, not a compiled artefact that could be stale — the actual
TypeScript source:

- the **client** aliases `@kang/shared` to `packages/shared/src/index.ts` in
  `vite.config.ts`
- the **server** runs it through `tsx` in development and inlines it with esbuild
  for production
- **tests** alias it the same way in `vitest.config.ts`

There is no `packages/shared/dist`. There is no build step that could be skipped.
`movementStep()` is byte-identical on both sides because it is literally the same
file.

```
                     packages/shared
        ┌────────────────────────────────────────┐
        │  sim/       movement, ballistics,      │
        │             collision world, navmesh   │
        │  data/      weapons, classes, modes,   │
        │             maps, cosmetics, progression│
        │  protocol   binary + JSON codecs       │
        │  constants  every tunable number       │
        └────────────────────────────────────────┘
             ▲                            ▲
             │ imports source             │ imports source
             │                            │
    ┌────────┴─────────┐        ┌─────────┴──────────┐
    │ packages/client  │        │  packages/server   │
    │                  │  WS    │                    │
    │  predicts with   │◄──────►│  authoritative     │
    │  the same code   │  REST  │  with the same code│
    └──────────────────┘        └────────────────────┘
```

`packages/shared` has **no I/O and no platform dependencies**. It does not import
`three`, `ws`, `node:fs` or anything DOM. That is what makes it runnable in both
places and testable in isolation.

---

## Packages

### `packages/shared`

| Module | Responsibility |
| --- | --- |
| `constants.ts` | Every tunable number: tick rate, gravity, speeds, hitbox fractions, anti-cheat tolerances, quantisation. One definition, no forks. |
| `math.ts` | Vector helpers, angle wrapping, deterministic seeded RNG. |
| `types.ts` | Wire and domain types, flag bitfields, event type enum, message enum. |
| `protocol.ts` | Binary snapshot/input codecs and JSON message validation + text sanitisation. |
| `sim/world.ts` | `CollisionWorld`: brush geometry, sweeps, ground queries, line of sight. |
| `sim/movement.ts` | `movementStep()` — the deterministic fixed-step movement function. |
| `sim/ballistics.ts` | Spread, recoil patterns, damage falloff, hitbox resolution, penetration. |
| `sim/navmesh.ts` | Navmesh generation from brushes and reusable A*. |
| `data/*` | Weapons, classes, modes, maps, cosmetics, achievements, challenges, settings schema, key bindings. |

### `packages/server`

| Module | Responsibility |
| --- | --- |
| `game/match.ts` | The simulation: ticks players, weapons, projectiles, objectives, pickups, respawns, and owns all damage. |
| `game/modes.ts` | One `ModeRules` subclass per mode: scoring, win conditions, respawn policy, objective setup. |
| `game/player.ts` | `ServerPlayer` — per-player authoritative state, weapon runtime, input queue, suspicion counters. |
| `game/bots.ts` | `BotController` — navmesh pathing, target selection, aim modelling, cover, objectives, abilities. |
| `game/progression.ts` | Converts end-of-match stats into XP, mastery, achievements, unlocks; persists them. |
| `net/room.ts` | One room: join/leave/reconnect, teams, ready, chat, mute, report, spectate, rate limiting, snapshot fan-out. |
| `net/roomManager.ts` | Room lifecycle, matchmaking for Quick Play, room codes, the global tick loop. |
| `net/server.ts` | HTTP + WebSocket listener, origin checks, upgrade handling. |
| `db/*` | `Database` interface with `memory`, `sqlite` and `postgres` implementations. |
| `api/router.ts` | REST endpoints for guest auth, profile, cosmetics, leaderboards, room listings. |
| `api/tokens.ts` | HMAC-signed stateless session tokens. |

### `packages/client`

| Module | Responsibility |
| --- | --- |
| `engine/renderer.ts` | Three.js scene, camera rig, PMREM environment map, post state, quality presets. |
| `engine/mapRenderer.ts` | Turns brush geometry into merged, instanced meshes with procedural materials. |
| `engine/textures.ts` | Every texture, drawn to a canvas at load time. No image files. |
| `engine/audio.ts` | Web Audio synthesis for every sound, plus a positional bus and mixer. |
| `engine/fx.ts` | Pooled tracers, impacts, decals, muzzle flashes, explosions, hit markers. |
| `engine/input.ts` | Pointer Lock, raw mouse deltas, rebindable actions, gamepad-free by design. |
| `engine/assets.ts` | GLB loading, LOD selection, material application, cosmetic tinting. |
| `game/session.ts` | The client's authority mirror: prediction, reconciliation, interpolation, event dispatch. |
| `game/viewmodel.ts` | First-person weapon rig: sway, bob, recoil, ADS, reload and fire animation. |
| `game/actors.ts` | Remote player rendering, interpolation, nameplates, outlines. |
| `ui/hud.ts` | Canvas HUD: crosshair, health, ammo, minimap, kill feed, damage direction, hit markers. |
| `ui/app.ts` | All 17 screens and the navigation between them. |
| `state/store.ts` | Settings, bindings, loadouts, profile cache, localStorage persistence. |

---

## Frame and tick flow

### Client frame

```
requestAnimationFrame
  ├─ sample input            → build InputCommand for this frame
  ├─ predict                 → movementStep() locally, push to unacked buffer
  ├─ send                    → batch up to 12 inputs into one binary packet
  ├─ interpolate remotes     → render at serverTime - INTERP_DELAY (100ms)
  ├─ update viewmodel/FX     → sway, recoil decay, pooled particles
  └─ render                  → Three.js draw + canvas HUD composite
```

### Server tick (60 Hz)

```
for each room:
  for each player:
    ├─ drain up to 6 queued inputs
    ├─ validate  (finite angles, dt bounds, sequence monotonic)
    ├─ movementStep()
    ├─ clamp speed against theoretical max + ability grant
    ├─ revert impossible position deltas
    └─ resolve weapon fire with lag-compensated hitboxes
  ├─ step projectiles, deployables, pickups, objectives, respawns
  ├─ apply mode scoring and check win conditions
  └─ every 3rd tick (20 Hz): encode and broadcast snapshots
```

### Reconciliation

Each snapshot carries `ackSeq` — the last input the server processed for this
client — plus the authoritative post-state. The client:

1. discards acknowledged inputs from its buffer
2. compares its predicted position at that sequence with the authoritative one
3. if the error is under `POSITION_DESYNC_LIMIT` (0.35 m), smooths it away over a
   few frames — the player never sees it
4. if the error is larger, snaps to the authoritative state and **replays** every
   remaining unacknowledged input through `movementStep()`

Because the replay uses the same function the server used, the result converges
rather than oscillating. Details and the wire format in
[NETWORKING.md](NETWORKING.md).

---

## Key decisions and their trade-offs

### Three.js over Babylon.js

**Chosen because** the renderer needs are modest (no physically based pipeline, no
editor, no scene graph tooling) while bundle size and cold-start time matter a
great deal for a browser game people click into from a link. Three.js in its own
chunk is 576 KB raw / 147 KB gzipped, and gameplay patches do not invalidate it.

**Cost:** more hand-written engine code — the PMREM environment map, the FX
pools, the LOD selection and the material system are all bespoke here, whereas
Babylon ships equivalents.

### WebGL2 required, WebGPU probed but not used

The renderer probes for WebGPU and reports it in diagnostics, but **all rendering
goes through WebGL2**. Maintaining two render paths would double the surface area
of every visual bug for a benefit that only lands on a subset of browsers. When
WebGPU support is universal enough that WebGL2 can be dropped rather than
duplicated, this becomes a single migration instead of a permanent fork.

### Brushes as the single source of truth

A map is a list of yaw-rotated boxes and wedges. That one list produces:

- the render mesh (merged by material, instanced where repeated)
- the collision hull (swept directly, no separate collision geometry to desync)
- the navmesh (sampled on a grid, then linked)
- the Blender export (same primitives, same transforms)

**Benefit:** "invisible wall" and "collision does not match the visuals" are
structurally impossible — there is only one geometry.

**Cost:** no arbitrary meshes for level geometry. Curved and organic shapes have
to be approximated with boxes and wedges, or added as non-colliding props.

### `node:sqlite` over better-sqlite3

Node's built-in SQLite needs no native compilation, no prebuilt binary matching,
and no `node-gyp` on Windows. It emits an experimental warning, which is the
whole cost. Production uses Postgres via the same `Database` interface.

Because bundlers do not yet know `node:sqlite`, it is loaded through
`process.getBuiltinModule()` rather than a static import — see the comment in
`db/sqlite.ts`.

### Hand-rolled binary protocol

Positions are quantised to `i16` at 1/64 m (1.5 cm precision, ±512 m range), yaw
to `u16`, pitch to `i16`. A snapshot for 16 players is a few hundred bytes rather
than several kilobytes of JSON.

**Cost:** the codec is manual and must be kept in step with the types. This is
mitigated by `PROTOCOL_VERSION`, which the client sends in `hello` and the server
rejects on mismatch, plus round-trip tests over the full value range including
extremes.

### JSON for everything that is not per-tick

Room state, chat, match results and the lobby all travel as validated JSON on the
same socket. Only the hot path — inputs up, snapshots down — is binary. This keeps
the readable 90% readable.

### Rooms are in-process

A room lives in the Node process that created it; `roomManager` ticks all of them
in one loop. Horizontal scaling is therefore per-process, with a load balancer
routing whole rooms rather than sharding one room across processes. For a browser
FPS with ≤16 players per match this is the right shape; a persistent-world game
would need a different one. See [DEPLOYMENT.md](DEPLOYMENT.md).

### Procedural assets

Every texture is drawn to a canvas, every sound is synthesised, every icon is
SVG, every model is generated by Blender Python in this repository. The load is
a few hundred KB of GLB rather than tens of MB of images and audio, and the
originality guarantee is structural rather than a promise: there is no third-party
asset to accidentally include. **Cost:** the visual style is constrained to what
is expressible procedurally.

---

## Where state lives

| State | Owner | Notes |
| --- | --- | --- |
| Player position, health, ammo, score | Server (`ServerPlayer`) | Client's copy is a prediction, always reconciled. |
| Match phase, scores, objectives, clock | Server (`Match`) | Broadcast as JSON on change, not per tick. |
| Room membership, teams, ready | Server (`Room`) | Broadcast as a player list on change. |
| Settings, bindings, loadout choices | Client (`localStorage`) then mirrored to the profile | Playable offline-first; syncs when signed in. |
| XP, mastery, achievements, cosmetics | Database | Written once at match end, never trusted from the client. |
| Guest identity | Client `localStorage` + HMAC token | Progression survives a refresh without an account. |

The rule: **anything that affects the outcome of a match is server-owned.** The
client sends intent (buttons, angles) and never results.
