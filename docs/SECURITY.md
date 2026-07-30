# Security and anti-cheat

## The explicit decision: no invasive anti-cheat

KANG BANG ships **no kernel driver, no ring-0 component, no process scanner, no
memory scanner and no hardware fingerprinting.** This is a deliberate design
choice, not an omission.

A browser game cannot meaningfully attest to the client anyway — the client is
JavaScript the user can read, patch and re-run. Pretending otherwise leads to a
security theatre that costs players privacy and stability while stopping nobody
determined. The honest position is:

> **Treat the client as hostile. Validate everything on the server.**

Everything below follows from that. The result is that the *worst* a modified
client achieves is behaviour a very good player could produce anyway — plus a
suspicion score that gets them removed from the room.

---

## Threat model

| Threat | Mitigation | Where |
| --- | --- | --- |
| Speed hacking | Every tick, horizontal speed is clamped to the class's theoretical maximum plus any active ability grant, times one tolerance. Clamping is silent; the violation is recorded. | `match.ts` |
| Teleporting | A single-tick position delta above 6 m is reverted to the pre-tick position and heavily penalised. | `match.ts` |
| Flying / noclip | Position is produced by the server's own `movementStep()` against the server's collision world. The client's reported position is never used. | `movement.ts` |
| Rapid fire | Shots are gated on a server-side cooldown from the weapon's RPM, with an 0.88 tolerance for legitimate jitter. Extra requests are dropped, not queued. | `match.ts` |
| Infinite ammo | Ammo, reserve and reload timers live on the server. | `player.ts` |
| Damage modification | Damage is computed on the server from the server's weapon table, the server's hitbox resolution and the server's falloff maths. The client sends buttons and angles, never results. | `ballistics.ts`, `match.ts` |
| Instant kill / one-shot | Same path. There is no client-authored damage value anywhere in the protocol. | — |
| Aimbot | Not preventable client-side, and not claimed to be. The hit is still resolved server-side against real hitboxes, so an aimbot cannot hit through a wall or beyond a weapon's range. Impossible accuracy raises suspicion. | `match.ts` |
| Wallhack | **Not mitigated.** Snapshots contain every non-spectating player's position, so a modified client can render enemies through walls. See Known limitations. | `room.ts` |
| Banking inputs then spending them | The server consumes at most 6 commands per tick; a banked backlog is dropped, not replayed. Tested. | `match.ts` |
| Malformed / hostile packets | Every JSON message is shape- and type-validated before reaching game logic; unknown fields are dropped. Binary packets are length-checked. | `protocol.ts` |
| Non-finite values | `NaN`/`Infinity` in angles or movement is rejected and the command discarded. Tested. | `match.ts` |
| Message flooding | 180 messages/second, then throttled; sustained abuse closes the socket. | `room.ts` |
| Chat abuse | Length cap, cooldown, control/zero-width/bidi sanitisation, client-side mute, and reporting. | `protocol.ts`, `room.ts` |
| XSS via names and chat | Player-supplied text is never inserted as HTML. The one place a DOM subtree is built from a template escapes it explicitly. | `hud.ts` |
| Session forgery | Tokens are HMAC-signed; a tampered payload or signature is rejected. | `api/tokens.ts` |
| Cross-origin socket hijack | The WebSocket upgrade checks `Origin` against an allow-list and rejects with 403. | `net/server.ts` |
| Profile tampering | Progression is written by the server from server-side match state. The client cannot post XP, kills or unlocks. | `progression.ts` |
| Equipping unowned cosmetics | Every equip is checked against what the profile actually owns. | `api/router.ts` |
| Impersonation via name | Names are sanitised and length-capped; identity is the profile id, not the display name. | `room.ts` |

---

## Movement validation in detail

The interesting part is the speed clamp, because a naive version of it is worse
than none.

```ts
const speed = Math.hypot(p.move.vel.x, p.move.vel.z);
const cap = (maxTheoreticalSpeed(params) + p.speedGrant) * SPEED_CHECK_TOLERANCE * config.antiCheat.moveTolerance;
if (speed > cap) {
  const scale = cap / speed;
  p.move.vel.x *= scale;
  p.move.vel.z *= scale;
  p.flagSuspicion('speed', 3);
}
```

Three things this gets right:

**One tolerance, not two.** An earlier version multiplied two independent
tolerances together and produced a 1.8× ceiling — enough for a speed hack to hide
inside while never tripping the check. Tolerances now compound exactly once
(`SPEED_CHECK_TOLERANCE` 1.35, times a deployment-tunable `MOVE_TOLERANCE`
defaulting to 1.05).

**Abilities grant, then decay.** Vanguard's Thruster Dash legitimately puts a
player well above sprint speed. Rather than raising the ceiling permanently, the
ability records a `speedGrant` that decays over the following ticks. The window is
wide only while the dash is actually happening. Verified in `match.test.ts`: the
dash raises no suspicion, and a synthetic 400 m/s velocity is clamped and flagged.

**Clamp, do not kick.** A single frame over the limit is far more likely to be
float drift or a lag spike than a cheat. The velocity is corrected and a score is
incremented; only a sustained pattern removes the player.

### Suspicion

Violations accumulate a weighted score per player:

| Violation | Weight |
| --- | --- |
| Speed over cap | 3 |
| Non-finite angles | 5 |
| Fire rate too fast | 4 |
| Position teleport | 25 |

At **120** the player is removed from the room. Every violation is logged as
structured JSON when `LOG_SUSPICIOUS=true`:

```json
{"ts":"2026-07-30T07:18:34Z","level":"warn","scope":"anticheat",
 "message":"suspicion","room":"r_8fA2","player":"Runner",
 "profileId":"g_xY…","suspicion":34,"violations":{"speed":8,"teleport":1}}
```

The log carries the profile id, so patterns across sessions are visible without
any device fingerprinting.

Player reports are logged the same way and deliberately reveal nothing about the
reported player to the reporter — the acknowledgement is identical whether or not
the target exists. Tested in `room.test.ts`.

---

## Input sanitisation

`sanitiseText()` in `packages/shared/src/protocol.ts` handles every piece of
player-supplied text (names, chat, room names, report reasons):

- C0/C1 control characters → replaced with a space
- soft hyphen (`U+00AD`) → removed
- zero-width and directional marks (`U+200B`–`U+200F`) → removed
- bidirectional overrides (`U+202A`–`U+202E`, `U+2066`–`U+2069`) → removed
- invisible operators (`U+2060`–`U+2064`) → removed
- BOM (`U+FEFF`) → removed
- runs of whitespace collapsed, trimmed, length-capped

It iterates codepoints rather than using a regex character class, deliberately:
writing those ranges as literal characters in a source file put actual NUL bytes
into the file twice during development. Codepoint arithmetic cannot do that.

Bidirectional overrides matter specifically because they let a name render
right-to-left and visually impersonate another player in the kill feed and
scoreboard.

---

## Secrets

**No secret is ever committed.** `.env` is gitignored; `.env.example` contains only
placeholders, and the `SESSION_SECRET` in it is literally named
`dev-only-insecure-secret-change-me`.

In production the server **refuses to start** without a real secret:

```
Error: SESSION_SECRET must be set when NODE_ENV=production
```

Verified by running the production bundle with the variable unset. `docker
compose` enforces the same thing at the compose layer, so `docker compose up`
fails with an actionable message rather than booting insecurely.

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Tokens are checked for what they must *not* contain, too: `persistence.test.ts`
asserts no password hash or email appears in a token payload.

`.dockerignore` excludes `.env` and `.env.*` (keeping only `.env.example`), so a
secret cannot reach an image layer even by accident.

---

## Transport and origin

- **Origin allow-list.** `CORS_ORIGIN` is a comma-separated list checked on both
  REST requests and the WebSocket upgrade. `*` is documented as development-only.
- **TLS terminates at the proxy.** The app speaks plain HTTP inside the network;
  nginx or your load balancer holds the certificate. `wss://` works without any
  application change — the client derives its scheme from `window.location`.
- **Single origin in production.** nginx serves the client and proxies `/api` and
  `/ws` to the server, so there is no cross-origin request to permit at all.

---

## Data handling

The only personal data stored is what a player types: a display name, and an
email plus password hash if they register. No IP addresses are persisted (they
appear in operational logs only), no device identifiers, no telemetry, no
third-party analytics, and no third-party scripts of any kind — the Content
Security Policy posture is "self only", which is also why the client has zero
external asset requests.

Guest play stores nothing but a random opaque id in the player's own
`localStorage`.

---

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
Include reproduction steps and the affected version. Please do not test against a
server you do not operate.

---

## Known limitations

Stated plainly, because a security document that claims completeness is not
trustworthy:

- **Aimbots cannot be prevented in a browser.** Server-side hit validation limits
  what one achieves — no hits through walls, none beyond a weapon's range, none
  faster than its fire rate — but the aiming itself happens on a client we cannot
  trust.

- **There is no snapshot culling, so wallhacks work.** `broadcastSnapshot()` sends
  every non-spectating player's exact position to every client. Interest
  management (distance and line-of-sight culling) is the standard mitigation and
  is not implemented here.

  It is listed as a limitation rather than shipped late because culling changes
  gameplay, not just bandwidth: a cloaked Phantom is *meant* to be a faint shimmer
  rather than absent, footstep audio depends on knowing about enemies you cannot
  see, and the minimap and spectator view need positions the local player does
  not. Getting that wrong makes enemies pop into existence at close range, which
  is worse to play against than a wallhack is to play against. Doing it properly
  means a per-client visibility set derived from the same brush geometry the
  navmesh uses, plus a decision about what each of those systems is allowed to
  know — a design change, not a patch.
- **There is no account-level ban system yet.** Suspicion removes a player from a
  room; it does not persist a ban. The schema and the logging support adding one.
- **Guest ids are transferable.** Copying a `localStorage` value moves a guest
  profile to another browser. Real accounts exist for players who care.
- **No rate limit on account creation.** Guest profiles are cheap by design; a
  deployment exposed to the public internet should put a rate limiter at the edge.
- **Postgres persistence is not exercised in the default CI run.** The driver
  implements the same tested interface as SQLite, and the contract suite runs
  against it where a server is available, but a fresh clone tests SQLite only.
