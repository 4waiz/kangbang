/**
 * Wire protocol.
 *
 * Two channels over a single WebSocket:
 *
 *  1. BINARY - the hot path. Input commands (client->server, 60Hz) and world
 *     snapshots (server->client, 20Hz). Hand-rolled little-endian codec with
 *     quantised positions/angles. A 16-player snapshot with 12 events is
 *     ~450 bytes, versus ~4KB of equivalent JSON.
 *
 *  2. JSON - everything else: lobby, chat, match state, results. Low frequency,
 *     so readability and forward compatibility win over bytes.
 *
 * Every decoder is defensive: a malformed or truncated packet returns null
 * rather than throwing, and the caller treats that as a protocol violation.
 */

import { MAX_INPUTS_PER_PACKET, POS_QUANT, VEL_QUANT } from './constants.js';
import { clamp, packPitch, packYaw, unpackPitch, unpackYaw } from './math.js';
import type { EntitySnapshot, InputCommand, SelfState, Snapshot, WireEvent } from './types.js';

export const PacketType = {
  Input: 1,
  Snapshot: 2,
  /** Client -> server: RTT probe on the binary channel (cheaper than JSON). */
  TimeSync: 4,
  TimeSyncReply: 5,
} as const;

const MAX_ENTITIES = 32;
const MAX_EVENTS = 64;

const SELF_BYTES = 24;
const ENTITY_BYTES = 23;
const EVENT_BYTES = 17;
const HEADER_BYTES = 16;
const CMD_BYTES = 14;

// ---------------------------------------------------------------------------
// Shared scratch buffers - encoding never allocates on the hot path.
// ---------------------------------------------------------------------------

const INPUT_BUF = new ArrayBuffer(8 + MAX_INPUTS_PER_PACKET * CMD_BYTES);
const inputView = new DataView(INPUT_BUF);

const SNAP_BUF = new ArrayBuffer(HEADER_BYTES + SELF_BYTES + MAX_ENTITIES * ENTITY_BYTES + MAX_EVENTS * EVENT_BYTES);
const snapView = new DataView(SNAP_BUF);

function packPos(v: number): number {
  return clamp(Math.round(v * POS_QUANT), -32768, 32767) | 0;
}
function unpackPos(v: number): number {
  return v / POS_QUANT;
}
function packVel(v: number): number {
  return clamp(Math.round(v * VEL_QUANT), -32768, 32767) | 0;
}
function unpackVel(v: number): number {
  return v / VEL_QUANT;
}

// ---------------------------------------------------------------------------
// Input packet (client -> server)
// ---------------------------------------------------------------------------

/**
 * Layout:
 *   u8   type
 *   u8   count
 *   u32  baseSeq          (seq of the first command; the rest are +1 each)
 *   u16  clientTimeLow    (ms & 0xffff, for one-way delay estimation)
 *   per command (14 bytes):
 *     i8  moveX * 100
 *     i8  moveZ * 100
 *     u16 yaw
 *     i16 pitch
 *     u16 buttons
 *     u8  slot
 *     u8  dtMs
 *     u32 shotSeed
 */
export function encodeInput(commands: readonly InputCommand[], clientTimeMs: number): Uint8Array {
  const count = Math.min(commands.length, MAX_INPUTS_PER_PACKET);
  const start = commands.length - count;
  inputView.setUint8(0, PacketType.Input);
  inputView.setUint8(1, count);
  inputView.setUint32(2, count > 0 ? commands[start].seq >>> 0 : 0, true);
  inputView.setUint16(6, clientTimeMs & 0xffff, true);
  let o = 8;
  for (let i = 0; i < count; i++) {
    const c = commands[start + i];
    inputView.setInt8(o, clamp(Math.round(c.moveX * 100), -100, 100));
    inputView.setInt8(o + 1, clamp(Math.round(c.moveZ * 100), -100, 100));
    inputView.setUint16(o + 2, packYaw(c.yaw), true);
    inputView.setInt16(o + 4, packPitch(c.pitch), true);
    inputView.setUint16(o + 6, c.buttons & 0xffff, true);
    inputView.setUint8(o + 8, clamp(c.slot | 0, 0, 7));
    inputView.setUint8(o + 9, clamp(Math.round(c.dt * 1000), 1, 255));
    inputView.setUint32(o + 10, (c.shotSeed ?? 0) >>> 0, true);
    o += CMD_BYTES;
  }
  return new Uint8Array(INPUT_BUF, 0, o);
}

export interface DecodedInput {
  commands: InputCommand[];
  clientTimeLow: number;
}

export function createDecodedInput(): DecodedInput {
  return { commands: [], clientTimeLow: 0 };
}

export function decodeInput(data: ArrayBuffer | Uint8Array, out: DecodedInput): DecodedInput | null {
  const view = toView(data);
  if (!view || view.byteLength < 8) return null;
  if (view.getUint8(0) !== PacketType.Input) return null;
  const count = view.getUint8(1);
  if (count === 0 || count > MAX_INPUTS_PER_PACKET) return null;
  if (view.byteLength < 8 + count * CMD_BYTES) return null;
  const baseSeq = view.getUint32(2, true);
  out.clientTimeLow = view.getUint16(6, true);
  out.commands.length = 0;
  let o = 8;
  for (let i = 0; i < count; i++) {
    const dtMs = view.getUint8(o + 9);
    out.commands.push({
      seq: (baseSeq + i) >>> 0,
      dt: dtMs / 1000,
      moveX: view.getInt8(o) / 100,
      moveZ: view.getInt8(o + 1) / 100,
      yaw: unpackYaw(view.getUint16(o + 2, true)),
      pitch: unpackPitch(view.getInt16(o + 4, true)),
      buttons: view.getUint16(o + 6, true),
      slot: view.getUint8(o + 8),
      shotSeed: view.getUint32(o + 10, true),
    });
    o += CMD_BYTES;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot packet (server -> client)
// ---------------------------------------------------------------------------

/**
 * Layout:
 *   u8   type
 *   u8   entityCount
 *   u8   eventCount
 *   u8   flags (bit0: self block present)
 *   u32  tick
 *   u32  serverTimeMs
 *   u32  ackSeq
 *   [self block, 24 bytes, if flags bit0]
 *   [entityCount x 23 bytes]
 *   [eventCount x 17 bytes]
 */
export function encodeSnapshot(
  tick: number,
  serverTimeMs: number,
  ackSeq: number,
  self: SelfState | null,
  entities: readonly EntitySnapshot[],
  events: readonly WireEvent[],
): Uint8Array {
  const entityCount = Math.min(entities.length, MAX_ENTITIES);
  const eventCount = Math.min(events.length, MAX_EVENTS);
  snapView.setUint8(0, PacketType.Snapshot);
  snapView.setUint8(1, entityCount);
  snapView.setUint8(2, eventCount);
  snapView.setUint8(3, self ? 1 : 0);
  snapView.setUint32(4, tick >>> 0, true);
  snapView.setUint32(8, serverTimeMs >>> 0, true);
  snapView.setUint32(12, ackSeq >>> 0, true);
  let o = HEADER_BYTES;

  if (self) {
    snapView.setInt16(o, packPos(self.x), true);
    snapView.setInt16(o + 2, packPos(self.y), true);
    snapView.setInt16(o + 4, packPos(self.z), true);
    snapView.setInt16(o + 6, packVel(self.vx), true);
    snapView.setInt16(o + 8, packVel(self.vy), true);
    snapView.setInt16(o + 10, packVel(self.vz), true);
    snapView.setUint8(o + 12, clamp(Math.round(self.health), 0, 255));
    snapView.setUint8(o + 13, clamp(Math.round(self.shield), 0, 255));
    snapView.setUint16(o + 14, self.flags & 0xffff, true);
    snapView.setUint16(o + 16, clamp(self.ammo, 0, 65535), true);
    snapView.setUint16(o + 18, clamp(self.reserve, 0, 65535), true);
    snapView.setUint8(o + 20, clamp(self.slot, 0, 7));
    snapView.setUint8(o + 21, clamp(Math.round(self.abilityCharge * 200), 0, 255));
    snapView.setUint8(o + 22, clamp(Math.round(self.ultimateCharge * 200), 0, 255));
    snapView.setUint8(o + 23, 0);
    o += SELF_BYTES;
  }

  for (let i = 0; i < entityCount; i++) {
    const e = entities[i];
    snapView.setUint8(o, e.id & 0xff);
    snapView.setUint16(o + 1, e.flags & 0xffff, true);
    snapView.setInt16(o + 3, packPos(e.x), true);
    snapView.setInt16(o + 5, packPos(e.y), true);
    snapView.setInt16(o + 7, packPos(e.z), true);
    snapView.setInt16(o + 9, packVel(e.vx), true);
    snapView.setInt16(o + 11, packVel(e.vy), true);
    snapView.setInt16(o + 13, packVel(e.vz), true);
    snapView.setUint16(o + 15, packYaw(e.yaw), true);
    snapView.setInt16(o + 17, packPitch(e.pitch), true);
    snapView.setUint8(o + 19, clamp(Math.round(e.health), 0, 255));
    snapView.setUint8(o + 20, clamp(Math.round(e.shield), 0, 255));
    snapView.setUint8(o + 21, e.weapon & 0xff);
    snapView.setUint8(o + 22, e.team & 0xff);
    o += ENTITY_BYTES;
  }

  for (let i = 0; i < eventCount; i++) {
    const ev = events[i];
    snapView.setUint8(o, ev.t & 0xff);
    snapView.setUint8(o + 1, ev.a & 0xff);
    snapView.setUint8(o + 2, ev.b & 0xff);
    snapView.setInt16(o + 3, packPos(ev.x), true);
    snapView.setInt16(o + 5, packPos(ev.y), true);
    snapView.setInt16(o + 7, packPos(ev.z), true);
    snapView.setUint16(o + 9, packYaw(ev.u), true);
    snapView.setInt16(o + 11, packPitch(ev.v), true);
    snapView.setUint16(o + 13, clamp(Math.round(ev.i), 0, 65535), true);
    snapView.setUint16(o + 15, clamp(Math.round(ev.j), 0, 65535), true);
    o += EVENT_BYTES;
  }

  return new Uint8Array(SNAP_BUF, 0, o);
}

/** Reusable snapshot object so decoding a stream never allocates. */
export function createSnapshot(): Snapshot {
  return { tick: 0, serverTimeMs: 0, ackSeq: 0, self: null, entities: [], events: [] };
}

const selfScratch: SelfState = {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  health: 0,
  shield: 0,
  flags: 0,
  ammo: 0,
  reserve: 0,
  slot: 0,
  abilityCharge: 0,
  ultimateCharge: 0,
};

export function decodeSnapshot(data: ArrayBuffer | Uint8Array, out: Snapshot): Snapshot | null {
  const view = toView(data);
  if (!view || view.byteLength < HEADER_BYTES) return null;
  if (view.getUint8(0) !== PacketType.Snapshot) return null;
  const entityCount = view.getUint8(1);
  const eventCount = view.getUint8(2);
  const flags = view.getUint8(3);
  if (entityCount > MAX_ENTITIES || eventCount > MAX_EVENTS) return null;
  const hasSelf = (flags & 1) !== 0;
  const needed = HEADER_BYTES + (hasSelf ? SELF_BYTES : 0) + entityCount * ENTITY_BYTES + eventCount * EVENT_BYTES;
  if (view.byteLength < needed) return null;

  out.tick = view.getUint32(4, true);
  out.serverTimeMs = view.getUint32(8, true);
  out.ackSeq = view.getUint32(12, true);
  let o = HEADER_BYTES;

  if (hasSelf) {
    const s = selfScratch;
    s.x = unpackPos(view.getInt16(o, true));
    s.y = unpackPos(view.getInt16(o + 2, true));
    s.z = unpackPos(view.getInt16(o + 4, true));
    s.vx = unpackVel(view.getInt16(o + 6, true));
    s.vy = unpackVel(view.getInt16(o + 8, true));
    s.vz = unpackVel(view.getInt16(o + 10, true));
    s.health = view.getUint8(o + 12);
    s.shield = view.getUint8(o + 13);
    s.flags = view.getUint16(o + 14, true);
    s.ammo = view.getUint16(o + 16, true);
    s.reserve = view.getUint16(o + 18, true);
    s.slot = view.getUint8(o + 20);
    s.abilityCharge = view.getUint8(o + 21) / 200;
    s.ultimateCharge = view.getUint8(o + 22) / 200;
    out.self = s;
    o += SELF_BYTES;
  } else {
    out.self = null;
  }

  // Grow/shrink in place; entries are reused objects.
  while (out.entities.length < entityCount) {
    out.entities.push({
      id: 0,
      flags: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      pitch: 0,
      health: 0,
      shield: 0,
      weapon: 0,
      team: 0,
    });
  }
  out.entities.length = entityCount;
  for (let i = 0; i < entityCount; i++) {
    const e = out.entities[i];
    e.id = view.getUint8(o);
    e.flags = view.getUint16(o + 1, true);
    e.x = unpackPos(view.getInt16(o + 3, true));
    e.y = unpackPos(view.getInt16(o + 5, true));
    e.z = unpackPos(view.getInt16(o + 7, true));
    e.vx = unpackVel(view.getInt16(o + 9, true));
    e.vy = unpackVel(view.getInt16(o + 11, true));
    e.vz = unpackVel(view.getInt16(o + 13, true));
    e.yaw = unpackYaw(view.getUint16(o + 15, true));
    e.pitch = unpackPitch(view.getInt16(o + 17, true));
    e.health = view.getUint8(o + 19);
    e.shield = view.getUint8(o + 20);
    e.weapon = view.getUint8(o + 21);
    e.team = view.getUint8(o + 22);
    o += ENTITY_BYTES;
  }

  while (out.events.length < eventCount) {
    out.events.push({ t: 0, a: 0, b: 0, x: 0, y: 0, z: 0, u: 0, v: 0, i: 0, j: 0 });
  }
  out.events.length = eventCount;
  for (let i = 0; i < eventCount; i++) {
    const ev = out.events[i];
    ev.t = view.getUint8(o);
    ev.a = view.getUint8(o + 1);
    ev.b = view.getUint8(o + 2);
    ev.x = unpackPos(view.getInt16(o + 3, true));
    ev.y = unpackPos(view.getInt16(o + 5, true));
    ev.z = unpackPos(view.getInt16(o + 7, true));
    ev.u = unpackYaw(view.getUint16(o + 9, true));
    ev.v = unpackPitch(view.getInt16(o + 11, true));
    ev.i = view.getUint16(o + 13, true);
    ev.j = view.getUint16(o + 15, true);
    o += EVENT_BYTES;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time sync
// ---------------------------------------------------------------------------

const TS_BUF = new ArrayBuffer(13);
const tsView = new DataView(TS_BUF);

export function encodeTimeSync(clientTimeMs: number, id: number): Uint8Array {
  tsView.setUint8(0, PacketType.TimeSync);
  tsView.setUint32(1, clientTimeMs >>> 0, true);
  tsView.setUint32(5, id >>> 0, true);
  return new Uint8Array(TS_BUF.slice(0, 9));
}

export function encodeTimeSyncReply(clientTimeMs: number, id: number, serverTimeMs: number): Uint8Array {
  tsView.setUint8(0, PacketType.TimeSyncReply);
  tsView.setUint32(1, clientTimeMs >>> 0, true);
  tsView.setUint32(5, id >>> 0, true);
  tsView.setUint32(9, serverTimeMs >>> 0, true);
  return new Uint8Array(TS_BUF.slice(0, 13));
}

export interface TimeSyncPacket {
  clientTimeMs: number;
  id: number;
  serverTimeMs: number;
}

export function decodeTimeSync(data: ArrayBuffer | Uint8Array): TimeSyncPacket | null {
  const view = toView(data);
  if (!view || view.byteLength < 9) return null;
  const t = view.getUint8(0);
  if (t !== PacketType.TimeSync && t !== PacketType.TimeSyncReply) return null;
  return {
    clientTimeMs: view.getUint32(1, true),
    id: view.getUint32(5, true),
    serverTimeMs: view.byteLength >= 13 ? view.getUint32(9, true) : 0,
  };
}

export function packetTypeOf(data: ArrayBuffer | Uint8Array): number {
  const view = toView(data);
  if (!view || view.byteLength < 1) return 0;
  return view.getUint8(0);
}

function toView(data: ArrayBuffer | Uint8Array): DataView | null {
  if (data instanceof Uint8Array) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new DataView(data);
  return null;
}

// ---------------------------------------------------------------------------
// JSON channel validation
// ---------------------------------------------------------------------------

export const MAX_JSON_MESSAGE_BYTES = 4096;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * Strip control characters and invisible/bidi codepoints, collapse whitespace
 * and clamp length.  Implemented with codepoint arithmetic rather than a regex
 * literal so this source file never has to contain the characters it removes.
 */
export function sanitiseText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number;
    // C0 / DEL / C1 control ranges become spaces so words do not fuse.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      out += ' ';
      continue;
    }
    // Soft hyphen, zero-width set, bidi overrides/isolates, invisible ops, BOM.
    if (c === 0x00ad) continue;
    if (c >= 0x200b && c <= 0x200f) continue;
    if (c >= 0x202a && c <= 0x202e) continue;
    if (c >= 0x2060 && c <= 0x2064) continue;
    if (c >= 0x2066 && c <= 0x2069) continue;
    if (c === 0xfeff) continue;
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) out = out.slice(0, maxLength);
  return out;
}

/**
 * Player names: printable ASCII-ish, no impersonation of the server, length
 * limited.  Rejected names fall back to a generated guest tag upstream rather
 * than erroring, so a bad name never blocks a join.
 */
export function sanitiseName(raw: unknown, maxLength: number): string {
  let s = sanitiseText(raw, maxLength);
  s = s.replace(/[^\w \-.[\]|<>]/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (/^(server|admin|system|console|moderator)$/i.test(s)) s = '';
  return s;
}

export function validateJsonMessage(raw: string): ValidationResult<Record<string, unknown>> {
  if (raw.length > MAX_JSON_MESSAGE_BYTES) return { ok: false, error: 'message too large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'expected object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.t !== 'string' || obj.t.length === 0 || obj.t.length > 24) {
    return { ok: false, error: 'missing type' };
  }
  return { ok: true, value: obj };
}

/** Numeric field guard used across the reliable channel. */
export function readNumber(
  obj: Record<string, unknown>,
  key: string,
  lo: number,
  hi: number,
  fallback: number,
): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return clamp(v, lo, hi);
}

export function readBool(obj: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = obj[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function readString(obj: Record<string, unknown>, key: string, maxLength: number): string {
  return sanitiseText(obj[key], maxLength);
}

export function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = obj[key];
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  return fallback;
}
