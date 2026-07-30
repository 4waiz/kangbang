# Gameplay systems

Every number here is read from the source in `packages/shared/src/` and is the
same number the server enforces. Units are metres, seconds and metres per second.

---

## Movement

Quake-lineage movement, tuned for a fast browser shooter: high acceleration,
meaningful air control, and a slide that rewards chaining rather than spamming.
It is one deterministic function — `movementStep()` in
`packages/shared/src/sim/movement.ts` — run at a fixed 60 Hz on both sides.

### Core numbers

| | Value |
| --- | --- |
| Gravity | 26.5 m/s² |
| Terminal velocity | 65 m/s |
| Walk speed | 6.5 m/s |
| Sprint speed | 9.3 m/s |
| Crouch speed | 3.3 m/s |
| Jump velocity | 8.75 m/s (≈1.44 m apex) |
| Ground acceleration | 92 m/s² |
| Air acceleration | 42 m/s² |
| Air speed cap | 1.35 m/s per tick of wish velocity |
| Ground friction | 9.4 |
| Air friction | 0.02 |
| Step height | 0.46 m |
| Max walkable slope | 48° |
| Player capsule | 0.42 m radius, 1.82 m tall (1.12 m crouched) |

### Slide

| | Value |
| --- | --- |
| Boost speed | 13.4 m/s |
| Minimum entry speed | 5.4 m/s |
| Slide friction | 2.15 (vs 9.4 standing) |
| Maximum duration | 0.85 s |
| Cooldown | 0.55 s |
| Velocity retained on slide-jump | 94% |
| Downhill acceleration | 12 m/s² × slope |

Crouching above 5.4 m/s enters a slide, boosting to 13.4 m/s with heavily reduced
friction and reduced steering authority. Jumping out of a slide keeps 94% of the
speed, so **slide → jump → air-strafe → land → slide** chains carry momentum. The
0.55 s cooldown is what stops it degenerating into a hold-crouch exploit.

### Quality-of-life

- **Coyote time** (0.09 s) — a jump still fires just after walking off a ledge.
- **Jump buffer** (0.11 s) — a jump pressed just before landing still fires.
- **Jump cooldown** (0.09 s) — auto-bhop is possible but not frame-perfect free.
- **Step-up** — obstacles up to 0.46 m are climbed with no vertical velocity
  added, so stairs and kerbs never launch you. Asserted in `movement.test.ts`.
- **Depenetration** — if a player ends a tick inside geometry they are pushed out
  along the shallowest axis. Every spawn on every map is tested to confirm this
  never fires at rest (`spawns.test.ts`).

### Camera feel

Head bob scales with speed, FOV widens slightly under sprint, the view model
sways against mouse movement and lags behind turns, and landing produces a short
dip. Every one of these is individually disableable in Settings →
Accessibility. `screenShake`, `headBob`, `motionBlur` and `reducedMotion` are
separate switches, not one lump.

### Fall damage

Below 21 m/s impact speed: none. From 21 to 42 m/s it ramps linearly to lethal.
Phantom is immune (its passive). 42 m/s corresponds to roughly a 33 m drop.

---

## Weapons

Ten weapons, fully data-driven from `packages/shared/src/data/weapons.ts`. Adding
one is a table entry plus a Blender generator function — no engine changes.

| Weapon | Slot | Damage | HS × | RPM | Mag / reserve | Reload | Falloff | Fire | Unlock |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pulse Assault Rifle | primary | 26 | 2.0 | 660 | 30 / 180 | 2.05 s | 26→58 m | auto | 0 |
| Plasma SMG | primary | 19 | 1.75 | 940 | 35 / 210 | 1.78 s | 14→34 m | auto | 0 |
| Rail Sniper | primary | 96 | 2.5 | 46 | 5 / 30 | 2.90 s | 120→220 m | bolt | 4 |
| Ion Shotgun | primary | 15 ×8 | 1.4 | 74 | 6 / 36 | 2.60 s | 7→21 m | pump | 2 |
| Heavy Particle LMG | primary | 24 | 1.7 | 720 | 100 / 300 | 4.35 s | 30→70 m | auto | 8 |
| Burst Carbine | primary | 30 | 2.1 | 260 | 27 / 162 | 1.95 s | 34→72 m | 3-burst | 6 |
| Arc Launcher | primary | 42 + splash | — | 52 | 4 / 16 | 3.10 s | — | projectile | 14 |
| Energy Pistol | secondary | 25 | 2.0 | 400 | 15 / 90 | 1.42 s | 18→42 m | single | 0 |
| Tactical Revolver | secondary | 58 | 1.95 | 155 | 6 / 36 | 2.35 s | 30→62 m | single | 10 |
| Plasma Blade | melee | 62 | 1.35 | 105 | — | — | — | swing | 0 |

**Time to kill** against a 125 EHP Vanguard, body shots, point blank:
Pulse AR 5 shots / 0.36 s · Plasma SMG 7 / 0.38 s · Burst Carbine 5 / 0.92 s ·
Revolver 3 / 0.77 s · Rail Sniper 2 / 1.30 s (1 to the head) ·
Ion Shotgun 2 / 0.81 s. Asserted to stay inside a sane band in `weapons.test.ts`.

### Damage model

- **Falloff** — full damage to `falloffStart`, linear to `minDamage` at
  `falloffEnd`, flat beyond. The zero-width-window bug that made two weapons
  divide by zero was caught by `weapons.test.ts` and fixed.
- **Hitboxes** — head (0.155 m sphere at 91.5% of capsule height), torso, legs
  and arms, each with its own multiplier. Scaled by the capsule height ratio, so
  crouching genuinely shrinks the target.
- **Penetration** — some weapons keep a fraction of their damage through one
  thin surface.
- **Spread and recoil** — every weapon has a deterministic recoil pattern seeded
  by shot index, so it is learnable, plus bloom that grows while firing and
  decays when you stop. ADS tightens both.

### Feedback

Muzzle flash, tracer, impact spark, surface-appropriate decal, hit marker, and a
distinct kill confirmation. Damage taken shows a directional indicator. All of it
runs from pre-allocated pools — see [PERFORMANCE.md](PERFORMANCE.md).

---

## Classes

Six classes. Each has a passive, an ability and an ultimate, and its own movement
profile. Effective health is tested to stay between 95 and 200, and the tankiest
class is tested never to also be the fastest.

| Class | Role | HP | Shield | EHP | Speed | Unlock |
| --- | --- | --- | --- | --- | --- | --- |
| **Vanguard** | Assault | 100 | 25 | 125 | 1.00× | 0 |
| **Phantom** | Scout | 80 | 15 | 95 | 1.14× | 0 |
| **Titan** | Heavy | 140 | 50 | 190 | 0.86× | 3 |
| **Warden** | Support | 110 | 35 | 145 | 0.96× | 5 |
| **Spectre** | Marksman | 90 | 20 | 110 | 1.02× | 7 |
| **Engineer** | Tech | 105 | 30 | 135 | 0.98× | 9 |

### Abilities

| Class | Passive | Ability (cooldown) | Ultimate (cooldown) |
| --- | --- | --- | --- |
| Vanguard | **Combat Momentum** — kills refund ability charge | **Thruster Dash** (8 s, 2 charges) — burst dash along your movement vector, keeps momentum on landing | **Overdrive** (90 s) — no ADS movement penalty, faster handling |
| Phantom | **Silent Step** — no footstep audio, no fall damage | **Refraction Cloak** (14 s) — near-invisible until you fire | **Phase Blink** (75 s) — teleport to where you are aiming |
| Titan | **Braced Frame** — reduced explosive and fall damage | **Bulwark** (18 s) — deployable directional barrier | **Siege Mode** (100 s) — heavy damage resistance, reduced speed |
| Warden | **Field Medic** — nearby allies regenerate faster | **Aegis Field** (16 s) — dome that absorbs incoming fire | **Guardian Lattice** (95 s) — team-wide overshield |
| Spectre | **Steady Optic** — reduced scope sway, faster ADS | **Pulse Scan** (15 s) — reveals enemies through walls briefly | **Lattice Lock** (105 s) — team-wide enemy tracking |
| Engineer | **Field Repair** — repairs own deployables passively | **Sentry Turret** (22 s) — auto-targeting turret | **System Purge** (90 s) — destroys enemy deployables in range |

Ultimates charge from damage, objective work and time, not from purchase.

Every class defaults to a loadout you can change; primary/secondary/melee slots
are independent and validated server-side (a "melee" in the primary slot is
rejected, not trusted).

---

## Game modes

| Mode | Teams | Target | Time | Respawn |
| --- | --- | --- | --- | --- |
| **Free For All** | — | 30 eliminations | 10 min | 2.4 s |
| **Team Deathmatch** | 2 | 75 eliminations | 10 min | 3.0 s |
| **Domination** | 2 | 200 ticks | 12 min | 4.0 s |
| **Hardpoint** | 2 | 250 ticks | 10 min | 4.5 s |
| **Capture the Core** | 2 | 3 captures | 12 min | 6.0 s |
| **Gun Progression** | — | finish the 10-weapon ladder | 12 min | 2.2 s |
| **Elimination** | 2 | 6 rounds | — | none in round |
| **Custom** | either | configurable | configurable | configurable |

Each mode is a `ModeRules` subclass in `packages/server/src/game/modes.ts`
overriding scoring, win conditions, respawn policy and objective setup. All eight
are played to a real conclusion in `match.test.ts`.

- **Domination** — three zones. Standing in one alone captures it over time;
  both teams present makes it contested and nothing happens. Holding more zones
  than the enemy ticks score.
- **Hardpoint** — exactly one point is active at a time, rotating every 60 s.
  Tested to have exactly one active point at all times and to actually rotate.
- **Capture the Core** — each team's core sits at their reactor. Walk over the
  enemy core to carry it; carrying is visible to everyone and slows you. Dying
  drops it where you fell; it returns home after 12 s untouched.
- **Gun Progression** — every elimination promotes you one rung up the weapon
  ladder, ending at the Plasma Blade. First to finish wins.
- **Elimination** — one life per round. Wiping a team ends the round; a short
  intermission then resets everyone.
- **Overtime** — team modes that finish level enter overtime rather than ending
  in a tie; still level at the end of overtime is a draw.

---

## Maps

Three maps, each authored as brush geometry that simultaneously produces the
render mesh, collision, navmesh and Blender export.

| Map | Size | Brushes | Spawns | Pickups | Character |
| --- | --- | --- | --- | --- | --- |
| **Neon Foundry** | 72 × 72 m | 613 | 28 | 15 | Reactor-lit ore works. Three levels, no long walks. |
| **Orbital Nexus** | 78 × 78 m | 614 | 30 | 17 | Deep-orbit transfer station. Mind the gaps. |
| **Mirage District** | 96 × 96 m | 706 | 28 | 19 | Rain-slick neon streets. Take the rooftops. |

Every map supports all seven fixed modes plus Custom.

### Verified properties

`maps.test.ts` and `spawns.test.ts` assert, for every map:

- the navmesh forms a **single connected component** — nowhere is unreachable
- every spawn and every objective is **mutually pathable**
- no spawn is **embedded in geometry**
- no spawn **ejects** the player (this caught a real depenetration launch)
- every spawn lands on **solid ground**, not mid-air or in a pit
- no ramp exceeds the **48° walkable limit** (caught a 50.2° stairwell)
- every vertical route has **at least 1 m of headroom** (caught ramps running
  under their own catwalks)
- geometry stays **inside map bounds** (caught a street ramp leaving the map)

### Spawn safety

Spawn selection scores candidates on distance from living enemies, recency of use,
and enemy line of sight. There is no per-map hard-coded safe zone; the scoring is
what prevents spawn trapping, and it is the same code on every map.

---

## Bots

`BotController` in `packages/server/src/game/bots.ts`. Bots are real players from
the simulation's point of view — they submit `InputCommand`s through the identical
path a human does, and are subject to the same movement, damage and anti-cheat
code.

- **Navigation** — A* over the generated navmesh, with jump and drop links.
- **Combat** — target selection weighted by distance, line of sight and threat;
  modelled reaction time; aim error that converges over time rather than snapping;
  burst discipline appropriate to the weapon.
- **Cover** — retreats to cover and reloads when low, instead of dying in the open.
- **Objectives** — captures zones, contests hardpoints, carries and defends cores.
- **Abilities** — uses class abilities in situations where they help.

| Difficulty | Reaction | Aim error | Tracking |
| --- | --- | --- | --- |
| Easy | slow | wide | loose |
| Normal | moderate | moderate | moderate |
| Hard | fast | tight | tight |

Difficulty changes **only** reaction time, aim error and decision speed. Bot
health and damage are tested to be identical to a human's at every difficulty —
no stat inflation. `match.test.ts` also asserts hard bots land measurably more
hits than easy bots over the same window, so the difficulty setting demonstrably
does something.

Bots have original callsigns generated from an internal word list.

---

## Progression

Nothing in progression affects combat power. This is enforced by test: a cosmetic
that gained a `damage`, `health`, `speed` or similar field fails
`progression.test.ts`.

### Account levels

XP per level rises monotonically to level 100. Reaching level 10 takes roughly
6–8 good matches. A match pays out for: completion, eliminations, assists,
headshots, score, objective captures, objective ticks, core scores and round wins,
plus a victory bonus, an MVP bonus and a once-daily first-win bonus. The time
bonus is capped so sitting in a long match is not farmable.

### Mastery

Every weapon and every class has its own mastery track to level 20, earned from
kills, headshots and damage with that weapon, or matches and wins with that class.
Mastery gates cosmetic unlocks.

### Challenges

Three daily and three weekly challenges, deterministically rolled per player per
period — the same player on the same day always gets the same set, different
players get different sets, and the set rotates. Weekly challenges have larger
targets and larger rewards than their daily equivalents.

### Achievements

Tiered achievements over lifetime counters (eliminations, headshots, objectives,
wins, per-weapon and per-class milestones). Tiers escalate in both target and
reward. Some unlock a specific cosmetic. Progress is reported as a fraction and
clamped, so the UI can never show 130%.

### Cosmetics

Body colours, armour variants, weapon skins, charms, banners, profile icons,
crosshair presets and trails. Every slot has at least three options, every slot's
default is free and already owned, and every unlockable states a requirement that
is actually reachable. Equipping is validated server-side against what the profile
owns.

### Career and leaderboards

Lifetime totals, derived rates (K/D, accuracy, headshot rate, score per minute),
per-weapon and per-class breakdowns, and recent match history. Leaderboards cover
XP, eliminations, score, wins, K/D, headshot rate and accuracy — with a minimum
sample per ratio board, so one lucky match cannot top K/D forever.

---

## Persistence and guests

Playing requires no account. On first load the client mints a guest id, the server
issues an HMAC-signed token, and a profile is created. Progression, settings,
bindings, loadouts and cosmetics all persist against that id, surviving refreshes.
The same interface supports real accounts (email + password hash columns already
exist) without changing anything downstream.
