# Networking

## Budget

| | Value | Why |
| --- | --- | --- |
| Simulation tick | **60 Hz** (16.67 ms) | Matches the frame rate target, so prediction and authority step in lockstep. |
| Snapshot rate | **20 Hz** (50 ms) | Three ticks per snapshot. Enough for smooth interpolation at a third of the bandwidth of per-tick updates. |
| Interpolation delay | **100 ms** (2 snapshots) | One snapshot of jitter buffer plus one in hand, so a single dropped packet does not stall remote players. |
| Lag compensation window | **250 ms** | Covers the great majority of real connections. Beyond it, the shooter is asked to lead. |
| Position history depth | 19 ticks | `ceil(250 ms × 60 Hz) + 4`. |
| Client input buffer | 180 commands (3 s) | Enough to replay through a long stall. |
| Inputs per packet | up to 12 | One packet per frame at 60 fps carries the backlog after a hiccup. |
| Inputs consumed per tick | max 6 | Caps how much a client can bank and then spend at once. |
| Heartbeat | 5 s | Cheap liveness. |
| Client timeout | 20 s | Silence beyond this drops the socket. |
| Reconnect grace | 30 s | The slot and score survive a refresh or a brief network drop. |
| Protocol version | **7** | Sent in `hello`; a mismatch is rejected with a clear message rather than desyncing. |

---

## Transport

One WebSocket at `/ws`, carrying two kinds of traffic:

- **Binary** for the hot path — input commands up, snapshots down. Hand-packed,
  quantised, no framing overhead beyond the packet header.
- **JSON** for everything else — hello, join, loadout, ready, team, chat, ping,
  mute, report, rematch, emote, vote, spectate; and downstream welcome, joined,
  rejected, room state, match state, player list, kill feed, chat, pong, results,
  notice, correction, kicked.

Mixing them on one socket keeps ordering guarantees between "you joined a team"
and the snapshots that follow, which two sockets would not give.

REST is used only for things that are not per-match: guest auth, profile,
settings, cosmetics, loadouts, achievements, challenges, match history,
leaderboards, room listings, health.

---

## Wire format

### Quantisation

| Field | Encoding | Precision | Range |
| --- | --- | --- | --- |
| Position | `i16`, ×64 | 1.6 cm | ±512 m |
| Velocity | `i16`, ×64 | 1.6 cm/s | ±512 m/s |
| Yaw | `u16` over 2π | 0.0055° | full turn |
| Pitch | `i16` over ±π/2 | 0.0027° | full range |
| Move axis | `i8`, ×100 | 0.01 | −1…1 |
| Health / shield | `u8` | 1 | 0…255 |
| Ability charge | `u8`, ×200 | 0.5% | 0…1 |

1.6 cm is well below the 0.42 m player radius, so quantisation never changes a
hit into a miss. All multi-byte fields are little-endian.

### Input packet (client → server)

```
u8   type
u8   commandCount
u16  reserved
[commandCount × 12 bytes]:
  i8   moveX          (×100)
  i8   moveZ          (×100)
  u16  yaw            (packed)
  i16  pitch          (packed)
  u16  buttons        (bitfield)
  u8   slot
  u8   padding
  u32  shotSeed
```

`seq` is derived from a base sequence in the header plus the index, so it costs
nothing per command. `shotSeed` is what makes spread deterministic: the client
predicts its own bullet pattern and the server reproduces it exactly.

**Buttons:** fire, aim, jump, crouch, sprint, reload, ability, ultimate, melee,
interact, use — one bit each.

### Snapshot packet (server → client)

```
u8   type
u8   entityCount
u8   eventCount
u8   flags            (bit0: self block present)
u32  tick
u32  serverTimeMs
u32  ackSeq           ← last input this client had processed

[self block, 24 bytes, when flags bit0]:
  i16 x, y, z         (packed position)
  i16 vx, vy, vz      (packed velocity)
  u8  health
  u8  shield
  u16 flags
  u16 ammo
  u16 reserve
  u8  slot
  u8  abilityCharge   (×200)
  u8  ultimateCharge  (×200)
  u8  padding

[entityCount × 23 bytes]:
  u8  id
  u16 flags
  i16 x, y, z
  i16 vx, vy, vz
  u16 yaw
  i16 pitch
  u8  health
  u8  shield
  u8  weapon
  u8  team

[eventCount × 17 bytes]:
  u8  type            (shot, impact, damage dealt/taken, kill, death,
                       spawn, reload, ability, explosion, pickup, …)
  u8  a, b            (entity ids)
  i16 x, y, z         (packed position)
  i16 dx, dy, dz      (packed direction)
  u8  i               (magnitude / damage)
  u8  k               (kind / weapon index)
  u8  flags
```

A full 16-player snapshot with a dozen events is around 500 bytes, so 20 Hz costs
roughly **10 KB/s down** per client. Inputs cost about **1.5 KB/s up**.

**Entity flags** (`EntFlag`): alive, crouching, sliding, sprinting, firing,
onGround, aiming, reloading, bot, protected, cloaked, shielded, carryingCore,
overshield, scanned. Fifteen bits of remote-player state in two bytes — enough for
the client to pick the right animation, material and nameplate treatment without
any extra messages.

---

## Client prediction

```
frame N:
  cmd = sampleInput()
  cmd.seq = ++localSeq
  movementStep(world, predictedState, cmd, ctx, TICK_DT)   ← same function the server runs
  unacked.push(cmd)
  send(unacked.slice(-12))
  render(predictedState)
```

The local player is drawn from predicted state, so input latency is zero. Weapon
fire is predicted too: the muzzle flash, tracer, recoil, ammo decrement and
crosshair bloom all happen on the frame you clicked. Only *damage* waits for the
server — a predicted hit marker that turned out to be a miss would be worse than a
late one.

## Reconciliation

Every snapshot carries `ackSeq` and the authoritative self state at that sequence.

```
onSnapshot(snap):
  drop every unacked command with seq <= snap.ackSeq
  error = distance(predictedAt(snap.ackSeq), snap.self)

  if error < 0.35 m:                       ← POSITION_DESYNC_LIMIT
      blend the difference away over the next few frames
  else:
      predictedState = snap.self           ← hard snap
      for cmd of unacked:
          movementStep(world, predictedState, cmd, ctx, TICK_DT)
```

Two thresholds rather than one, deliberately:

- **Soft (< 0.35 m)** — the usual case. Float drift and a one-tick timing
  difference produce centimetres of error every snapshot. Snapping on that would
  make the camera vibrate constantly. Blending is invisible.
- **Hard (≥ 0.35 m)** — something real happened: a collision the client got
  wrong, an explosion knockback, a server-side clamp. Snap and replay.

Because the replay uses the identical `movementStep()`, the replayed result
converges to what the server will compute next tick, instead of oscillating.

The server can also push an explicit `correction` message for events the client
cannot possibly predict — a teleport ultimate, a spawn, an anti-cheat revert.

## Interpolation of remote players

Remote entities are **never** predicted. Each is a small ring buffer of
timestamped snapshot states, rendered at `serverTime − 100 ms`, which is normally
between two known real states.

```
renderTime = estimatedServerTime() - INTERP_DELAY
find the two buffered states bracketing renderTime
lerp position, slerp-equivalent on yaw/pitch through the shortest arc
```

`estimatedServerTime()` tracks `serverTimeMs` from snapshots against the local
clock with a smoothed offset, so it survives clock drift.

If the buffer runs dry (packet loss), the last known velocity extrapolates
forward — but for **at most 120 ms**. Beyond that the entity holds position.
Unbounded extrapolation is how players slide through walls in a lossy match.

## Lag compensation

The server keeps 19 ticks of position history per player. When a client fires:

1. take the client's reported latency, clamped to 250 ms
2. rewind every *other* player's hitboxes to where they were at
   `now − latency − INTERP_DELAY` — that is, to what the shooter actually saw
3. resolve the trace against those rewound hitboxes
4. apply damage in the present

`INTERP_DELAY` is part of the rewind because the shooter was looking at
interpolated positions 100 ms in the past, not at live ones. Omitting it makes
every shot feel like it needs leading.

This is the standard trade: the shooter's experience is honest ("I hit what I
aimed at") at the cost of the target occasionally taking damage just after
reaching cover. For a fast browser shooter, favouring the shooter is right.

---

## Rooms, joining and reconnect

```
client                              server
  │  ws connect /ws                   │  origin allow-listed, else 403
  │─────────────────────────────────► │
  │  hello {protocol, token, name}    │  verify HMAC token, resolve profile
  │─────────────────────────────────► │  reject on protocol mismatch
  │  join {mode|code|roomId, loadout} │  find or create room, balance teams
  │─────────────────────────────────► │
  │ ◄───────────────────────────────  │  welcome {entityId, mapId, mode, tick}
  │ ◄───────────────────────────────  │  players, room, match
  │ ◄═══════════════════════════════  │  snapshots at 20 Hz
```

- **Quick Play** picks the emptiest joinable room and creates one if none fits.
- **Room codes** are 5 characters, generated from an unambiguous alphabet.
- **Private rooms** are excluded from the browser but joinable by code.
- **Teams** auto-balance on join; a manual switch is refused if it would unbalance
  the sides, with a notice explaining why.
- **Bot eviction** — a full room evicts a bot rather than turning a human away.
- **Ready** — everyone ready skips the rest of warmup; the warmup clock starts the
  match anyway so one idle player cannot hold a lobby hostage.

### Reconnect

A dropped socket does **not** delete the player. The `ServerPlayer` stays for
30 seconds with `connected = false`, holding its slot, team, score and
progression. A new socket presenting the same profile id inside that window is
handed the same entity id and receives a fresh welcome. A deliberate leave frees
the slot immediately — the distinction is the `graceful` flag.

---

## Rate limiting and validation

Every JSON message is validated for shape and type before it reaches game logic;
unknown fields are dropped rather than passed through. Text is sanitised for
control characters, zero-width characters and bidirectional overrides, then
collapsed and length-capped.

| Limit | Value |
| --- | --- |
| Messages per second | 180, then throttled |
| Chat | 140 chars, with a cooldown |
| Name | 16 chars, sanitised |
| Inputs consumed per tick | 6 |
| Entities per snapshot | 32 |
| Events per snapshot | 48 |

A client that banks 200 input commands and sends them at once does not get 200
ticks of movement — the backlog is dropped to the cap. Tested in
`match.test.ts`.

See [SECURITY.md](SECURITY.md) for the anti-cheat model.

---

## Debugging netcode

- `/api/health` reports uptime, room count, player count and average tick time.
- Settings → Graphics → **Show FPS** adds a live overlay with frame time, ping,
  snapshot rate and reconciliation corrections per second.
- `npm run bots` prints, per client: snapshots received and their real rate,
  distance moved, peak speed with the flag state at that moment, shots fired
  client-side versus shot events the server confirmed, damage in and out, kills,
  deaths, respawns and which message types arrived. A prediction bug usually
  shows up as a rate mismatch between client shots and server shot events.
