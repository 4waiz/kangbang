# Testing

Three layers, each catching a different class of failure:

1. **Unit and integration tests** (Vitest) — 415 tests over the simulation, data
   tables, protocol, maps, spawns, match rules, rooms and persistence.
2. **Headless multiplayer** (`npm run bots`) — real WebSocket clients fighting real
   bots against a real server, asserting the server actually produced combat.
3. **Real browser** (`node tools/browser-check.mjs`) — Chrome driven through boot,
   every menu screen, a live match, the HUD and the pause flow, failing on any
   console error.

```bash
npm test                 # 415 tests, ~3 s
npm run test:watch
npm run test:coverage
npm run typecheck        # tsc --noEmit over all three packages
npm run lint
npm run verify           # typecheck + test + build
```

---

## Suites

| Suite | Tests | Covers |
| --- | --- | --- |
| `shared/__tests__/movement.test.ts` | 52 | Collision primitives, ground and ceiling queries, walk/sprint/crouch speeds, acceleration, friction, jump arc, coyote time, jump buffer, slide entry/exit/cooldown, slide-hop retention, air control and its cap, step-up, slope limits, depenetration, fall damage thresholds, trace distance limits, and **determinism** — identical inputs must produce bit-identical output, because prediction depends on it. |
| `shared/__tests__/weapons.test.ts` | 50 | Every weapon's stat block for internal consistency, damage falloff maths across the whole range, headshot multipliers, time-to-kill inside a sane band, spread and recoil determinism from a shot seed, magazine/reserve/reload coherence, fire modes, and slot legality. |
| `shared/__tests__/maps.test.ts` | 41 | Per map: navmesh forms a single connected component, all spawns and objectives mutually pathable, no ramp over the 48° walkable limit, at least 1 m headroom on every vertical route, geometry inside bounds, objectives reachable, pickups on solid ground. |
| `shared/__tests__/spawns.test.ts` | 15 | Every spawn on every map for all six classes: not embedded in geometry, does not eject the player, settles within a metre, lands on solid ground and not near the kill plane. |
| `shared/__tests__/protocol.test.ts` | 42 | Binary round-trip for inputs and snapshots including extreme values, quantisation error bounds, header integrity, truncated and oversized packet handling, JSON message validation, text sanitisation against control characters, zero-width characters and bidirectional overrides, and the surface index table (wire order, round-trip, out-of-range fallback). |
| `shared/__tests__/progression.test.ts` | 73 | XP curve monotonicity and level thresholds, match XP breakdown summing to the total, farm-resistance caps, weapon and class mastery, career stat derivations with zero denominators, unlock requirements, achievements and their tiers, deterministic challenge rolls, the full settings schema with clamping and JSON round-trip, key bindings with conflict detection, class balance invariants, and **the no-pay-to-win rule**. |
| `server/__tests__/match.test.ts` | 61 | Match lifecycle, spawn separation and protection, damage/shield/death/respawn, assists and their window, streaks, friendly fire, self-inflicted death penalties, weapon firing through the authority, anti-cheat (speed clamp, teleport revert, non-finite angles, banked input backlog, legitimate ability dash), all seven modes played to a real win condition, overtime and draws, custom rules, every mode run for 20 s with eight bots, bot difficulty scaling, and progression persistence. |
| `server/__tests__/room.test.ts` | 35 | Join and welcome contents, player-list broadcast, team auto-balance, player cap and bot eviction, server-browser summary, reconnect within grace versus graceful leave, ready flow and warmup skip, chat and team chat, sanitisation, mute, report, spectate, rate limiting, and decodable binary snapshots with a self block. |
| `server/__tests__/persistence.test.ts` | 46 | The whole `Database` contract run twice — once against the in-memory driver and once against real `node:sqlite` on a temp file — plus SQLite durability across close/reopen, nested-path creation, leaderboard metrics and minimums, and session tokens (round-trip, URL safety, tamper rejection, no secrets in the payload, unique guest ids, header extraction). |

The persistence suite is parameterised over drivers on purpose: a contract tested
against one implementation is a contract that drifts. Postgres implements the same
interface and is verified the same way where a server is available.

---

## Headless multiplayer

```bash
npm run dev:server                                     # in one terminal
npm run bots                                           # in another
node tools/bot-match.mjs --clients 4 --bots 6 --mode tdm --seconds 40
```

Real WebSocket clients that aim at the nearest enemy, fire, jump, crouch, reload
and use abilities. It fails unless the server actually produced:

- snapshots at close to the configured rate
- meaningful movement (a client that barely moves means movement or collision is
  broken)
- shots confirmed server-side, not just sent
- damage in **both** directions
- kills, deaths and respawns
- kill-feed entries

Sample output:

```
Probe-1  id=  5 phase=live  snaps= 531 (21.2/s) self= 531 moved= 210.8m peak=27.71m/s @y=1.2 vy=-1.16 flags=3
         shots= 979 serverShots= 140 dmgOut=  438 dmgIn=  196 K=2 D=1 spawns=3 hp=78 ammo=0 reload=true
PASS - all acceptance checks satisfied
```

The peak-speed context (`flags`, `y`, `vy`) exists because a bare number is not
diagnosable. A 27.7 m/s peak is nearly 3x sprint speed and looks exactly like a
speed exploit — but `flags=3` (alive, crouched, **not** on the ground) plus the
airborne descent identifies it as a slide-jump into a Thruster Dash: 13.4 slide
boost, 94% retained through the jump (12.6), plus 13.5 of dash, plus air-strafe
gain. Legitimate, and correctly whitelisted by the anti-cheat's decaying speed
grant. Without the context there would have been nothing to distinguish it from a
cheat.

---

## Real browser

```bash
npm run dev                                            # or a built client
node tools/browser-check.mjs
node tools/browser-check.mjs --url http://localhost:4173 --shots ./screenshots
node tools/browser-check.mjs --headful                 # watch it run
```

Drives an installed Chrome or Edge through `puppeteer-core` (no bundled
Chromium download). **24 checks:**

page loads · WebGL context available · boot sequence runs · reaches main menu ·
main menu has navigation · all 11 menu screens open · no markup rendered as text ·
joins a match · HUD shows health · ammo · weapon · match timer · ability ·
crosshair rendered to overlay · 3D canvas sized · WebGL context not lost ·
pause menu opens · scoreboard lists players · bots fight each other ·
class/loadout reachable mid-match · no markup rendered as text in the HUD ·
no uncaught page errors · no console errors · no failed network requests

With `--shots` it writes a screenshot per screen, which is the fastest way to
review a visual change.

Two implementation notes:

- **Polling happens in Node, not in the page.** `page.waitForFunction` runs inside
  the page's event loop, which a software-WebGL render loop starves — the check
  timed out while the game was working fine. Waiting from the Node side fixed it.
- **The markup-leak scanner walks visible text nodes** looking for serialised
  markup, skipping `<noscript>`, `<script>`, `<style>` and `<template>`, whose
  contents are text by definition. See below for why it exists.

---

## Bugs these tests actually caught

Not hypothetical — each of these was a real defect found by the suite it names.

| Bug | Found by |
| --- | --- |
| Two weapons had `falloffEnd === falloffStart`, making the damage-falloff divisor zero | `weapons.test.ts` |
| Four Mirage District street strips were disconnected — an 18 cm kerb deleted the nav nodes joining them | `maps.test.ts` (single-component assertion) |
| A 50.2° stairwell and 50° tower ramps exceeded the 48° walkable limit | `maps.test.ts` |
| Ramps ran underneath their own catwalks with under 1 m of headroom | `maps.test.ts` |
| A street ramp on Mirage ran outside the map bounds | `maps.test.ts` |
| Spawn yaw was inverted — players faced their own back wall, and sprinting covered 3 m in 2 s | map tests plus the bot match's distance-moved assertion |
| Players never spawned during warmup, so `stepRespawns` was missing from the warmup branch and death was permanent | `match.test.ts` |
| Peak speed reached 27.8 m/s because two independent tolerances compounded into a 1.8× ceiling a speed hack could hide inside | `npm run bots` |
| SVG icon markup rendered as literal text in eleven menu buttons and the map cards, because the icon helpers returned HTML strings and were passed into child positions | the new markup-leak check (nothing else could see it: no error, no missing element, correct button count) |
| Character GLBs rendered their full-detail and decimated meshes overlapping, because the `*_LOD1` siblings were exported into the same file and never paired into a `THREE.LOD` | GLB inspection while documenting the pipeline; now verified by the pairing check |
| The death overlay was permanently visible because an author `display` rule beat the UA `[hidden]` rule | browser check screenshots |
| Menus bounced to the pause screen because a game-initiated Pointer Lock release was indistinguishable from the user pressing Escape | browser check |
| The scene rendered near-black: metallic PBR materials with no environment map | browser check screenshots |
| First-person weapons pointed at the floor — authored +Y-up in Blender's Z-up space, so the glTF Y-up conversion rotated them 90° | browser check screenshots |

Several of the movement-test failures during development were errors in the test
arena itself rather than in the game — a ceiling slab below the crouched head
height, start positions inside geometry, a trace-limit ray grazing a ledge. Those
are worth mentioning because "the test failed" and "the code is wrong" are not the
same claim, and the arena is code too.

---

## Writing a test

Simulation tests build a small purpose-made arena rather than loading a real map,
so a failure points at the movement code and not at level geometry:

```ts
const world = new CollisionWorld(
  new MapBuilder('test')
    .box(-20, 20, -0.5, 0, -20, 20, 'metal')   // floor
    .box(-2, 2, 0, 1.5, 8, 10, 'metal')        // a ledge to step onto
    .build(),
);

const state = createMoveState({ x: 0, y: 0, z: 0 });
const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
for (let i = 0; i < 60; i++) {
  movementStep(world, state, input({ seq: i, moveZ: 1 }), ctx, TICK_DT);
}
expect(state.pos.z).toBeGreaterThan(5);
```

Server tests drive a real `Match` with real `ServerPlayer`s and a controllable
clock — no mocks, so they exercise the same path a live game does:

```ts
const match = new Match({ mode: 'tdm', map: 'neon_foundry' });
const a = addPlayer(match, 'A', Team.Ion);
match.begin(now());
run(match, 20, () => a.pendingInputs.push(idle(a, { buttons: Btn.Fire })));
```

Two conventions worth keeping:

- **Assert the behaviour, not the implementation.** The step-up test originally
  checked `onGround`, which legitimately goes false when you walk off the far edge
  of the step. It now checks that vertical velocity stays at zero, which is the
  actual requirement ("stepping up must not launch the player").
- **Put the reason in the assertion message.** `expect(ejected, 'spawns eject the
  player:\n...').toEqual([])` prints exactly which spawn and by how much, which is
  the difference between a two-minute fix and an afternoon.

---

## Continuous verification

```bash
npm run verify          # typecheck → tests → builds
npm run assets:check    # 39 required models present, no Blender needed
```

A full pre-release pass adds the two runtime layers:

```bash
npm run build
npm start &
npm run preview -w @kang/client &
npm run bots
node tools/browser-check.mjs --url http://localhost:4173 --shots ./screenshots
```
