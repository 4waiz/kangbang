#!/usr/bin/env node
/**
 * Headless match driver.
 *
 * Spawns N WebSocket clients that behave like real players (they send input
 * packets, fire, and move) against a running server, then reports what the
 * server actually did: snapshots received, damage taken, kills, respawns and
 * match progression.
 *
 * This is the automated stand-in for "open two browsers and shoot each other",
 * and it exercises the exact same protocol path the browser client uses.
 *
 * Usage:
 *   node tools/bot-match.mjs [--clients 2] [--seconds 25] [--mode tdm]
 *                            [--map neon_foundry] [--url http://127.0.0.1:2567]
 *                            [--bots 4] [--difficulty normal] [--json]
 */

import { WebSocket } from 'ws';

const args = parseArgs(process.argv.slice(2));
const URL_BASE = args.url ?? process.env.NEON_URL ?? 'http://127.0.0.1:2567';
const WS_BASE = URL_BASE.replace(/^http/, 'ws') + '/ws';
const CLIENT_COUNT = int(args.clients, 2, 1, 16);
const SECONDS = int(args.seconds, 25, 3, 600);
const MODE = args.mode ?? 'tdm';
const MAP = args.map ?? undefined;
const BOTS = int(args.bots, 4, 0, 24);
const DIFFICULTY = args.difficulty ?? 'normal';
const AS_JSON = !!args.json;

const PROTOCOL_VERSION = 7;
const PacketType = { Input: 1, Snapshot: 2, TimeSync: 4, TimeSyncReply: 5 };
const Btn = {
  Jump: 1 << 0,
  Crouch: 1 << 1,
  Sprint: 1 << 2,
  Fire: 1 << 3,
  Aim: 1 << 4,
  Reload: 1 << 5,
  Ability: 1 << 6,
  Melee: 1 << 7,
  Interact: 1 << 8,
  Ultimate: 1 << 9,
};
const TAU = Math.PI * 2;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function int(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Binary codecs (mirrors packages/shared/src/protocol.ts)
// ---------------------------------------------------------------------------

function packYaw(yaw) {
  let x = yaw;
  while (x > Math.PI) x -= TAU;
  while (x < -Math.PI) x += TAU;
  return Math.round(((x + Math.PI) / TAU) * 65535) & 0xffff;
}
function unpackYaw(v) {
  return (v / 65535) * TAU - Math.PI;
}
function packPitch(p) {
  const c = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));
  return Math.round((c / (Math.PI / 2)) * 32767);
}
function unpackPitch(v) {
  return (v / 32767) * (Math.PI / 2);
}
const POS_QUANT = 64;
const VEL_QUANT = 64;

function encodeInput(commands, clientTimeMs) {
  const count = Math.min(commands.length, 12);
  const start = commands.length - count;
  const buf = new ArrayBuffer(8 + count * 14);
  const v = new DataView(buf);
  v.setUint8(0, PacketType.Input);
  v.setUint8(1, count);
  v.setUint32(2, count > 0 ? commands[start].seq >>> 0 : 0, true);
  v.setUint16(6, clientTimeMs & 0xffff, true);
  let o = 8;
  for (let i = 0; i < count; i++) {
    const c = commands[start + i];
    v.setInt8(o, Math.max(-100, Math.min(100, Math.round(c.moveX * 100))));
    v.setInt8(o + 1, Math.max(-100, Math.min(100, Math.round(c.moveZ * 100))));
    v.setUint16(o + 2, packYaw(c.yaw), true);
    v.setInt16(o + 4, packPitch(c.pitch), true);
    v.setUint16(o + 6, c.buttons & 0xffff, true);
    v.setUint8(o + 8, c.slot & 7);
    v.setUint8(o + 9, Math.max(1, Math.min(255, Math.round(c.dt * 1000))));
    v.setUint32(o + 10, c.shotSeed >>> 0, true);
    o += 14;
  }
  return new Uint8Array(buf);
}

function decodeSnapshot(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.byteLength < 16 || v.getUint8(0) !== PacketType.Snapshot) return null;
  const entityCount = v.getUint8(1);
  const eventCount = v.getUint8(2);
  const flags = v.getUint8(3);
  const hasSelf = (flags & 1) !== 0;
  const needed = 16 + (hasSelf ? 24 : 0) + entityCount * 23 + eventCount * 17;
  if (v.byteLength < needed) return null;
  const snap = {
    tick: v.getUint32(4, true),
    serverTimeMs: v.getUint32(8, true),
    ackSeq: v.getUint32(12, true),
    self: null,
    entities: [],
    events: [],
  };
  let o = 16;
  if (hasSelf) {
    snap.self = {
      x: v.getInt16(o, true) / POS_QUANT,
      y: v.getInt16(o + 2, true) / POS_QUANT,
      z: v.getInt16(o + 4, true) / POS_QUANT,
      vx: v.getInt16(o + 6, true) / VEL_QUANT,
      vy: v.getInt16(o + 8, true) / VEL_QUANT,
      vz: v.getInt16(o + 10, true) / VEL_QUANT,
      health: v.getUint8(o + 12),
      shield: v.getUint8(o + 13),
      flags: v.getUint16(o + 14, true),
      ammo: v.getUint16(o + 16, true),
      reserve: v.getUint16(o + 18, true),
      slot: v.getUint8(o + 20),
      abilityCharge: v.getUint8(o + 21) / 200,
      ultimateCharge: v.getUint8(o + 22) / 200,
    };
    o += 24;
  }
  for (let i = 0; i < entityCount; i++) {
    snap.entities.push({
      id: v.getUint8(o),
      flags: v.getUint16(o + 1, true),
      x: v.getInt16(o + 3, true) / POS_QUANT,
      y: v.getInt16(o + 5, true) / POS_QUANT,
      z: v.getInt16(o + 7, true) / POS_QUANT,
      yaw: unpackYaw(v.getUint16(o + 15, true)),
      pitch: unpackPitch(v.getInt16(o + 17, true)),
      health: v.getUint8(o + 19),
      shield: v.getUint8(o + 20),
      weapon: v.getUint8(o + 21),
      team: v.getUint8(o + 22),
    });
    o += 23;
  }
  for (let i = 0; i < eventCount; i++) {
    snap.events.push({
      t: v.getUint8(o),
      a: v.getUint8(o + 1),
      b: v.getUint8(o + 2),
      x: v.getInt16(o + 3, true) / POS_QUANT,
      y: v.getInt16(o + 5, true) / POS_QUANT,
      z: v.getInt16(o + 7, true) / POS_QUANT,
      i: v.getUint16(o + 13, true),
      j: v.getUint16(o + 15, true),
    });
    o += 17;
  }
  return snap;
}

const EvType = { Shot: 0, Impact: 1, DamageDealt: 2, DamageTaken: 3, Kill: 4, Spawn: 5, Death: 13 };

// ---------------------------------------------------------------------------
// Test client
// ---------------------------------------------------------------------------

class TestClient {
  constructor(index) {
    this.index = index;
    this.name = `Probe-${index + 1}`;
    this.seq = 1;
    this.commands = [];
    this.entityId = 0;
    this.snapshots = 0;
    this.selfSeen = 0;
    this.lastSelf = null;
    this.kills = 0;
    this.deaths = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.spawns = 0;
    this.shots = 0;
    this.serverShotEvents = 0;
    this.jsonMessages = {};
    this.matchStates = 0;
    this.killFeed = 0;
    this.errors = [];
    this.positions = [];
    this.maxSpeedSeen = 0;
    this.maxSpeedContext = null;
    this.phase = '';
    this.roomInfo = null;
    this.resultsPayload = null;
    this.playerListSize = 0;
    this.ready = false;
    this.token = null;
    this.aliveTicks = 0;
    this.movedDistance = 0;
    this.ammoLow = false;
    this.reloadSeen = false;
    this.lastEntities = null;
    this.entityCountSeen = 0;
    this.engagedTicks = 0;
    this.rng = mulberry(index * 7919 + 13);
  }

  async connect() {
    const res = await fetch(`${URL_BASE}/api/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.name }),
    });
    if (!res.ok) throw new Error(`guest endpoint failed: ${res.status}`);
    const data = await res.json();
    this.token = data.token;
    this.profile = data.profile;

    await new Promise((resolveConn, rejectConn) => {
      this.ws = new WebSocket(WS_BASE, { origin: 'http://localhost:5173' });
      this.ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => rejectConn(new Error('ws timeout')), 10000);
      this.ws.on('open', () => {
        clearTimeout(timer);
        this.send({ t: 'hello', protocol: PROTOCOL_VERSION, token: this.token, name: this.name });
        resolveConn();
      });
      this.ws.on('error', (err) => {
        clearTimeout(timer);
        rejectConn(err);
      });
    });

    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        this.onBinary(buf);
      } else {
        this.onJson(raw.toString('utf8'));
      }
    });
    this.ws.on('close', (code) => {
      if (code !== 1000 && code !== 1001 && code !== 1005) this.errors.push(`closed ${code}`);
    });
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onJson(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.errors.push('bad json from server');
      return;
    }
    this.jsonMessages[msg.t] = (this.jsonMessages[msg.t] ?? 0) + 1;
    switch (msg.t) {
      case 'joined':
        this.send({
          t: 'join',
          mode: MODE,
          map: MAP,
          create: this.index === 0,
          config: this.index === 0 ? { botCount: BOTS, botDifficulty: DIFFICULTY, mode: MODE } : undefined,
        });
        break;
      case 'welcome':
        this.entityId = msg.entityId;
        this.roomInfo = msg.room;
        this.ready = true;
        this.send({ t: 'ready', ready: true });
        break;
      case 'rejected':
        this.errors.push(`rejected: ${msg.reason}`);
        break;
      case 'kicked':
        this.errors.push(`kicked: ${msg.reason}`);
        break;
      case 'match':
        this.matchStates++;
        this.phase = msg.state.phase;
        this.matchState = msg.state;
        break;
      case 'players':
        this.playerListSize = msg.players.length;
        this.players = msg.players;
        break;
      case 'feed':
        this.killFeed += msg.entries.length;
        break;
      case 'results':
        this.resultsPayload = msg.results;
        break;
      default:
        break;
    }
  }

  onBinary(buf) {
    const snap = decodeSnapshot(buf);
    if (!snap) return;
    this.snapshots++;
    this.lastEntities = snap.entities;
    this.entityCountSeen = Math.max(this.entityCountSeen, snap.entities.length);
    if (snap.self) {
      this.selfSeen++;
      const prev = this.lastSelf;
      if (prev) {
        this.movedDistance += Math.hypot(snap.self.x - prev.x, snap.self.z - prev.z);
      }
      const speed = Math.hypot(snap.self.vx, snap.self.vz);
      if (speed > this.maxSpeedSeen) {
        this.maxSpeedSeen = speed;
        // Capture the context so an unexpected peak can be diagnosed rather
        // than merely reported: air/ground and slide state explain most of it.
        this.maxSpeedContext = {
          y: +snap.self.y.toFixed(2),
          vy: +snap.self.vy.toFixed(2),
          flags: snap.self.flags,
        };
      }
      if (snap.self.health > 0) this.aliveTicks++;
      if (snap.self.ammo <= 2) this.ammoLow = true;
      this.lastSelf = snap.self;
      if (this.positions.length < 4000) this.positions.push([snap.self.x, snap.self.y, snap.self.z]);
    }
    for (const ev of snap.events) {
      if (ev.t === EvType.Shot && ev.a === this.entityId) this.serverShotEvents++;
      if (ev.t === EvType.DamageDealt && ev.a === this.entityId) this.damageDealt += ev.i;
      if (ev.t === EvType.DamageTaken && ev.b === this.entityId) this.damageTaken += ev.i;
      if (ev.t === EvType.Kill && ev.a === this.entityId) this.kills++;
      if (ev.t === EvType.Death && ev.a === this.entityId) this.deaths++;
      if (ev.t === EvType.Spawn && ev.a === this.entityId) this.spawns++;
    }
  }

  /** Nearest visible enemy from the latest snapshot, or null. */
  nearestEnemy() {
    if (!this.lastSelf || !this.lastEntities) return null;
    const me = this.lastEntities.find((e) => e.id === this.entityId);
    const myTeam = me ? me.team : 0;
    let best = null;
    let bestD = Infinity;
    for (const e of this.lastEntities) {
      if (e.id === this.entityId) continue;
      if ((e.flags & 1) === 0) continue; // not alive
      if (myTeam !== 0 && e.team === myTeam) continue;
      const d = Math.hypot(e.x - this.lastSelf.x, e.z - this.lastSelf.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ? { ...best, dist: bestD } : null;
  }

  /**
   * One simulated frame of player intent.
   *
   * The client hunts: it walks towards the nearest enemy the server told it
   * about and aims at their chest. That is what makes this a real end-to-end
   * combat test rather than a movement test - hit registration, damage,
   * kills, the kill feed and respawns all have to work for it to pass.
   */
  tick(elapsed) {
    if (!this.ready) return;
    const t = elapsed + this.index * 1.7;
    let yaw = (t * 0.55) % TAU - Math.PI;
    let pitch = Math.sin(t * 0.4) * 0.18;
    let moveZ = Math.cos(t * 0.55) > -0.35 ? 1 : -1;
    let moveX = Math.sin(t * 0.8) * 0.9;
    let buttons = Btn.Sprint;

    const enemy = this.nearestEnemy();
    if (enemy && this.lastSelf) {
      const dx = enemy.x - this.lastSelf.x;
      const dy = enemy.y + 1.1 - (this.lastSelf.y + 1.6);
      const dz = enemy.z - this.lastSelf.z;
      yaw = Math.atan2(-dx, -dz);
      pitch = Math.atan2(dy, Math.hypot(dx, dz));
      // Close the distance, then hold position and shoot.
      moveZ = enemy.dist > 9 ? 1 : enemy.dist < 4 ? -0.6 : 0;
      moveX = Math.sin(t * 2.2) * 0.7;
      if (enemy.dist < 60) buttons |= Btn.Fire;
      this.engagedTicks++;
    } else if (Math.sin(t * 3.1) > 0.15) {
      buttons |= Btn.Fire;
    }

    if (Math.sin(t * 1.3) > 0.9) buttons |= Btn.Jump;
    if (Math.sin(t * 0.9) > 0.95) buttons |= Btn.Crouch;
    if (Math.sin(t * 0.7) > 0.97) buttons |= Btn.Ability;
    if (this.lastSelf && this.lastSelf.ammo === 0) {
      buttons |= Btn.Reload;
      this.reloadSeen = true;
    }
    if (buttons & Btn.Fire) this.shots++;

    this.commands.push({
      seq: this.seq++,
      dt: 1 / 60,
      moveX,
      moveZ,
      yaw,
      pitch,
      buttons,
      slot: 0,
      shotSeed: Math.floor(this.rng() * 0x7fffffff),
    });
    if (this.commands.length > 12) this.commands.splice(0, this.commands.length - 12);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeInput(this.commands, Date.now()));
    }
  }

  close() {
    try {
      this.send({ t: 'leave' });
      this.ws.close(1000, 'done');
    } catch {
      /* ignore */
    }
  }
}

function mulberry(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main() {
  const health = await fetch(`${URL_BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) {
    console.error(`Cannot reach a KANG BANG server at ${URL_BASE}. Start it with: npm run dev:server`);
    process.exit(2);
  }
  if (!AS_JSON) {
    console.log(`server ok  protocol=${health.protocol} tick=${health.tickRate}Hz db=${health.db}`);
    console.log(`launching ${CLIENT_COUNT} client(s), mode=${MODE} bots=${BOTS} for ${SECONDS}s`);
  }

  const clients = [];
  for (let i = 0; i < CLIENT_COUNT; i++) {
    const c = new TestClient(i);
    await c.connect();
    clients.push(c);
    // Stagger joins so the first client creates the room.
    await sleep(i === 0 ? 700 : 220);
  }

  const start = Date.now();
  const frame = 1000 / 60;
  await new Promise((done) => {
    const timer = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      for (const c of clients) c.tick(elapsed);
      if (elapsed >= SECONDS) {
        clearInterval(timer);
        done();
      }
    }, frame);
  });

  // Give the server a moment to flush the final state.
  await sleep(600);

  const report = {
    server: health,
    seconds: SECONDS,
    clients: clients.map((c) => ({
      name: c.name,
      entityId: c.entityId,
      phase: c.phase,
      snapshots: c.snapshots,
      selfStates: c.selfSeen,
      snapshotRate: +(c.snapshots / SECONDS).toFixed(1),
      inputsSent: c.seq - 1,
      shotsRequested: c.shots,
      serverShotEvents: c.serverShotEvents,
      kills: c.kills,
      deaths: c.deaths,
      damageDealt: c.damageDealt,
      damageTaken: c.damageTaken,
      spawns: c.spawns,
      engagedTicks: c.engagedTicks,
      entitiesSeen: c.entityCountSeen,
      distanceMoved: +c.movedDistance.toFixed(1),
      maxSpeed: +c.maxSpeedSeen.toFixed(2),
      maxSpeedContext: c.maxSpeedContext,
      finalHealth: c.lastSelf ? c.lastSelf.health : null,
      finalAmmo: c.lastSelf ? c.lastSelf.ammo : null,
      reloaded: c.reloadSeen,
      playersInRoom: c.playerListSize,
      killFeedEntries: c.killFeed,
      matchStates: c.matchStates,
      results: c.resultsPayload ? { winningTeam: c.resultsPayload.winningTeam, rows: c.resultsPayload.players.length } : null,
      jsonMessageTypes: Object.keys(c.jsonMessages).sort(),
      errors: c.errors,
    })),
  };

  for (const c of clients) c.close();

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  const failed = evaluate(report);
  process.exit(failed.length === 0 ? 0 : 1);
}

function printReport(report) {
  console.log('');
  console.log('--- results ---------------------------------------------------');
  for (const c of report.clients) {
    console.log(
      `${c.name.padEnd(9)} id=${String(c.entityId).padStart(3)} phase=${c.phase.padEnd(9)} ` +
        `snaps=${String(c.snapshots).padStart(4)} (${c.snapshotRate}/s) self=${String(c.selfStates).padStart(4)} ` +
        `moved=${String(c.distanceMoved).padStart(6)}m peak=${c.maxSpeed}m/s${
          c.maxSpeedContext ? ` @y=${c.maxSpeedContext.y} vy=${c.maxSpeedContext.vy} flags=${c.maxSpeedContext.flags}` : ''
        }`,
    );
    console.log(
      `          shots=${String(c.shotsRequested).padStart(4)} serverShots=${String(c.serverShotEvents).padStart(4)} ` +
        `dmgOut=${String(c.damageDealt).padStart(5)} dmgIn=${String(c.damageTaken).padStart(5)} ` +
        `K=${c.kills} D=${c.deaths} spawns=${c.spawns} hp=${c.finalHealth} ammo=${c.finalAmmo} reload=${c.reloaded}`,
    );
    console.log(
      `          players=${c.playersInRoom} feed=${c.killFeedEntries} states=${c.matchStates} ` +
        `msgs=[${c.jsonMessageTypes.join(',')}]${c.errors.length ? ` ERRORS=${c.errors.join('; ')}` : ''}`,
    );
  }
  const failures = evaluate(report);
  console.log('');
  if (failures.length === 0) {
    console.log('PASS - all acceptance checks satisfied');
  } else {
    console.log('FAIL:');
    for (const f of failures) console.log(`  - ${f}`);
  }
}

function evaluate(report) {
  const fails = [];
  for (const c of report.clients) {
    if (c.errors.length) fails.push(`${c.name}: ${c.errors.join('; ')}`);
    if (c.entityId === 0) fails.push(`${c.name}: never joined a room`);
    if (c.snapshots < report.seconds * 8) fails.push(`${c.name}: only ${c.snapshots} snapshots (expected >= ${report.seconds * 8})`);
    if (c.selfStates < report.seconds * 8) fails.push(`${c.name}: missing self state in snapshots`);
    if (c.distanceMoved < 5) fails.push(`${c.name}: barely moved (${c.distanceMoved}m) - movement or collision broken`);
    if (c.maxSpeed < 3) fails.push(`${c.name}: never reached walking speed`);
    if (c.serverShotEvents < 5) fails.push(`${c.name}: server acknowledged only ${c.serverShotEvents} shots`);
    if (c.playersInRoom < 2) fails.push(`${c.name}: room only had ${c.playersInRoom} players (bots did not fill)`);
    if (!c.jsonMessageTypes.includes('match')) fails.push(`${c.name}: never received match state`);
    if (!c.jsonMessageTypes.includes('players')) fails.push(`${c.name}: never received the player list`);
  }
  const anyDamage = report.clients.some((c) => c.damageDealt > 0 || c.damageTaken > 0);
  if (!anyDamage) fails.push('no damage was dealt or taken by anyone - combat is not working');
  const anyFeed = report.clients.some((c) => c.killFeedEntries > 0);
  if (!anyFeed) fails.push('kill feed never populated - nothing died in the whole match');
  return fails;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('driver failed:', err);
  process.exit(2);
});
