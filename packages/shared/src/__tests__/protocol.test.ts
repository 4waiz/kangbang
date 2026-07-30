/**
 * Wire protocol tests.
 *
 * The binary codec is the one place where a silent off-by-one produces a game
 * that half-works: players teleporting, damage landing on the wrong person,
 * events firing with the wrong weapon. Every field is round-tripped, every
 * decoder is fed garbage, and the quantisation error is bounded explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  EvType,
  MAX_INPUTS_PER_PACKET,
  MAX_JSON_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  POS_QUANT,
  PacketType,
  createDecodedInput,
  createSnapshot,
  decodeInput,
  decodeSnapshot,
  decodeTimeSync,
  encodeInput,
  encodeSnapshot,
  encodeTimeSync,
  encodeTimeSyncReply,
  packPitch,
  packYaw,
  packetTypeOf,
  readBool,
  readEnum,
  readNumber,
  readString,
  sanitiseName,
  sanitiseText,
  unpackPitch,
  unpackYaw,
  SURFACES,
  surfaceFromIndex,
  surfaceIndex,
  validateJsonMessage,
  type EntitySnapshot,
  type InputCommand,
  type SelfState,
  type WireEvent,
} from '../index.js';

/**
 * The surface order this protocol version promises.
 *
 * Surfaces travel as a single byte, so reordering this list silently changes what
 * every already-deployed client hears: a glass impact on concrete, with no error
 * anywhere. The table now lives in `shared` and is imported by both sides, so the
 * two cannot diverge - this literal is the separate guard against *reordering*,
 * which sharing the table does not prevent.
 */
const WIRE_SURFACE_ORDER = [
  'metal',
  'concrete',
  'glass',
  'grate',
  'energy',
  'holo',
  'panel',
  'rubber',
  'sand',
  'flesh',
  'air',
];

/** Build strings containing control/invisible codepoints without embedding them. */
const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0x00);
const BEL = ch(0x07);
const DEL = ch(0x7f);
const SOFT_HYPHEN = ch(0x00ad);
const ZERO_WIDTH_SPACE = ch(0x200b);
const RTL_MARK = ch(0x200f);
const RTL_OVERRIDE = ch(0x202e);
const WORD_JOINER = ch(0x2060);
const ISOLATE_OPEN = ch(0x2066);
const ISOLATE_CLOSE = ch(0x2069);
const BOM = ch(0xfeff);

function cmd(seq: number, over: Partial<InputCommand> = {}): InputCommand {
  return {
    seq,
    dt: 1 / 60,
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    slot: 0,
    shotSeed: 0,
    ...over,
  };
}

describe('angle quantisation', () => {
  it('round-trips yaw across the full circle within a quantisation step', () => {
    for (let a = -Math.PI; a <= Math.PI; a += 0.01) {
      expect(Math.abs(unpackYaw(packYaw(a)) - a)).toBeLessThan(0.0002);
    }
  });

  it('round-trips pitch within its clamped range', () => {
    for (let a = -Math.PI / 2; a <= Math.PI / 2; a += 0.01) {
      expect(Math.abs(unpackPitch(packPitch(a)) - a)).toBeLessThan(0.0002);
    }
  });

  it('clamps pitch beyond straight up and down', () => {
    expect(unpackPitch(packPitch(3))).toBeCloseTo(Math.PI / 2, 3);
    expect(unpackPitch(packPitch(-3))).toBeCloseTo(-Math.PI / 2, 3);
  });

  it('wraps yaw rather than clamping it', () => {
    expect(unpackYaw(packYaw(Math.PI * 3))).toBeCloseTo(Math.PI, 2);
  });
});

describe('input packet', () => {
  it('round-trips a single command exactly enough to simulate with', () => {
    const original = cmd(42, {
      moveX: 0.5,
      moveZ: -1,
      yaw: 1.2,
      pitch: -0.4,
      buttons: 0b1010101,
      slot: 2,
      shotSeed: 0xdeadbeef,
    });
    const out = decodeInput(encodeInput([original], 1234), createDecodedInput());
    expect(out).not.toBeNull();
    const got = out!.commands[0];
    expect(got.seq).toBe(42);
    expect(got.moveX).toBeCloseTo(0.5, 2);
    expect(got.moveZ).toBeCloseTo(-1, 2);
    expect(got.yaw).toBeCloseTo(1.2, 4);
    expect(got.pitch).toBeCloseTo(-0.4, 4);
    expect(got.buttons).toBe(0b1010101);
    expect(got.slot).toBe(2);
    expect(got.shotSeed).toBe(0xdeadbeef);
    expect(got.dt).toBeCloseTo(1 / 60, 2);
  });

  it('round-trips a full window with consecutive sequence numbers', () => {
    const commands = Array.from({ length: MAX_INPUTS_PER_PACKET }, (_, i) => cmd(100 + i, { yaw: i * 0.1 }));
    const out = decodeInput(encodeInput(commands, 0), createDecodedInput());
    expect(out!.commands).toHaveLength(MAX_INPUTS_PER_PACKET);
    expect(out!.commands.map((c) => c.seq)).toEqual(commands.map((c) => c.seq));
  });

  it('sends only the newest window when given more than fits', () => {
    const commands = Array.from({ length: 40 }, (_, i) => cmd(i + 1));
    const out = decodeInput(encodeInput(commands, 0), createDecodedInput());
    expect(out!.commands).toHaveLength(MAX_INPUTS_PER_PACKET);
    // The newest command must always be present or the server runs a frame behind.
    expect(out!.commands[out!.commands.length - 1].seq).toBe(40);
  });

  it('reports its packet type', () => {
    expect(packetTypeOf(encodeInput([cmd(1)], 0))).toBe(PacketType.Input);
  });

  it('rejects a truncated packet instead of reading past the buffer', () => {
    const full = encodeInput([cmd(1), cmd(2), cmd(3)], 0);
    for (let cut = 1; cut < full.byteLength; cut++) {
      const out = decodeInput(full.slice(0, cut), createDecodedInput());
      if (out !== null) expect(out.commands.length * 14 + 8).toBeLessThanOrEqual(cut);
    }
  });

  it('rejects a wrong packet type', () => {
    const bogus = new Uint8Array(32);
    bogus[0] = 99;
    bogus[1] = 1;
    expect(decodeInput(bogus, createDecodedInput())).toBeNull();
  });

  it('rejects a zero or oversized command count', () => {
    const zero = encodeInput([cmd(1)], 0).slice();
    zero[1] = 0;
    expect(decodeInput(zero, createDecodedInput())).toBeNull();
    const huge = encodeInput([cmd(1)], 0).slice();
    huge[1] = 200;
    expect(decodeInput(huge, createDecodedInput())).toBeNull();
  });

  it('rejects an empty buffer', () => {
    expect(decodeInput(new Uint8Array(0), createDecodedInput())).toBeNull();
    expect(decodeInput(new ArrayBuffer(0), createDecodedInput())).toBeNull();
  });
});

describe('snapshot packet', () => {
  const self: SelfState = {
    x: 12.5,
    y: 3.25,
    z: -40.75,
    vx: 5.5,
    vy: -2.25,
    vz: 0.5,
    health: 87,
    shield: 22,
    flags: 0b101010,
    ammo: 27,
    reserve: 153,
    slot: 1,
    abilityCharge: 0.5,
    ultimateCharge: 0.25,
  };

  const entity = (id: number): EntitySnapshot => ({
    id,
    flags: 0b11,
    x: id * 1.5,
    y: 2,
    z: -id * 2.25,
    vx: 1,
    vy: 0,
    vz: -1,
    yaw: 0.5,
    pitch: -0.2,
    health: 100,
    shield: 25,
    weapon: 3,
    team: (id % 2) + 1,
  });

  const event = (t: number): WireEvent => ({
    t,
    a: 7,
    b: 9,
    x: 1.5,
    y: 2.5,
    z: -3.5,
    u: 0.4,
    v: -0.2,
    i: 1234,
    j: 7,
  });

  it('round-trips the self block', () => {
    const out = decodeSnapshot(encodeSnapshot(900, 123456, 42, self, [], []), createSnapshot());
    expect(out).not.toBeNull();
    expect(out!.tick).toBe(900);
    expect(out!.serverTimeMs).toBe(123456);
    expect(out!.ackSeq).toBe(42);
    const s = out!.self!;
    expect(s.x).toBeCloseTo(self.x, 2);
    expect(s.y).toBeCloseTo(self.y, 2);
    expect(s.z).toBeCloseTo(self.z, 2);
    expect(s.vx).toBeCloseTo(self.vx, 2);
    expect(s.health).toBe(87);
    expect(s.shield).toBe(22);
    expect(s.flags).toBe(0b101010);
    expect(s.ammo).toBe(27);
    expect(s.reserve).toBe(153);
    expect(s.slot).toBe(1);
    expect(s.abilityCharge).toBeCloseTo(0.5, 2);
    expect(s.ultimateCharge).toBeCloseTo(0.25, 2);
  });

  it('omits the self block for a spectator', () => {
    const out = decodeSnapshot(encodeSnapshot(1, 1, 0, null, [entity(1)], []), createSnapshot());
    expect(out!.self).toBeNull();
    expect(out!.entities).toHaveLength(1);
  });

  it('round-trips a full lobby of entities in order', () => {
    const entities = Array.from({ length: 16 }, (_, i) => entity(i + 1));
    const out = decodeSnapshot(encodeSnapshot(1, 1, 0, self, entities, []), createSnapshot());
    expect(out!.entities).toHaveLength(16);
    for (let i = 0; i < 16; i++) {
      const got = out!.entities[i];
      const want = entities[i];
      expect(got.id).toBe(want.id);
      expect(got.x).toBeCloseTo(want.x, 2);
      expect(got.z).toBeCloseTo(want.z, 2);
      expect(got.yaw).toBeCloseTo(want.yaw, 3);
      expect(got.pitch).toBeCloseTo(want.pitch, 3);
      expect(got.weapon).toBe(want.weapon);
      expect(got.team).toBe(want.team);
      expect(got.flags).toBe(want.flags);
    }
  });

  it('round-trips every event type', () => {
    const events = Object.values(EvType).map((t) => event(t as number));
    const out = decodeSnapshot(encodeSnapshot(1, 1, 0, null, [], events), createSnapshot());
    expect(out!.events).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(out!.events[i].t).toBe(events[i].t);
      expect(out!.events[i].a).toBe(7);
      expect(out!.events[i].b).toBe(9);
      expect(out!.events[i].i).toBe(1234);
      expect(out!.events[i].j).toBe(7);
      expect(out!.events[i].x).toBeCloseTo(1.5, 2);
    }
  });

  it('reuses its output object without leaking stale entries', () => {
    const out = createSnapshot();
    decodeSnapshot(encodeSnapshot(1, 1, 0, self, [entity(1), entity(2), entity(3)], [event(0)]), out);
    expect(out.entities).toHaveLength(3);
    decodeSnapshot(encodeSnapshot(2, 2, 0, self, [entity(1)], []), out);
    expect(out.entities).toHaveLength(1);
    expect(out.events).toHaveLength(0);
  });

  it('keeps position error inside half a quantisation step', () => {
    const limit = 1 / POS_QUANT / 2 + 1e-9;
    for (const value of [0, 0.01, -0.01, 5.333, -120.777, 400.5, -400.5]) {
      const out = decodeSnapshot(encodeSnapshot(1, 1, 0, { ...self, x: value }, [], []), createSnapshot());
      expect(Math.abs(out!.self!.x - value), `x=${value}`).toBeLessThanOrEqual(limit);
    }
  });

  it('clamps rather than wrapping a position beyond the encodable range', () => {
    const out = decodeSnapshot(encodeSnapshot(1, 1, 0, { ...self, x: 99999 }, [], []), createSnapshot());
    expect(out!.self!.x).toBeGreaterThan(400);
  });

  it('stays well under an MTU for a full 16-player snapshot', () => {
    const entities = Array.from({ length: 16 }, (_, i) => entity(i + 1));
    const events = Array.from({ length: 12 }, () => event(EvType.Shot));
    expect(encodeSnapshot(1, 1, 0, self, entities, events).byteLength).toBeLessThan(700);
  });

  it('rejects truncated and malformed snapshots', () => {
    const full = encodeSnapshot(1, 1, 0, self, [entity(1), entity(2)], [event(0)]);
    for (let cut = 1; cut < full.byteLength; cut++) {
      const out = decodeSnapshot(full.slice(0, cut), createSnapshot());
      if (out !== null) {
        const needed = 16 + 24 + out.entities.length * 23 + out.events.length * 17;
        expect(needed).toBeLessThanOrEqual(cut);
      }
    }
    expect(decodeSnapshot(new Uint8Array([2, 99, 99, 1]), createSnapshot())).toBeNull();
    expect(decodeSnapshot(new Uint8Array(0), createSnapshot())).toBeNull();
  });
});

describe('time sync', () => {
  it('round-trips a probe and its reply', () => {
    const probe = decodeTimeSync(encodeTimeSync(500, 7));
    expect(probe).not.toBeNull();
    expect(probe!.clientTimeMs).toBe(500);
    expect(probe!.id).toBe(7);

    const reply = decodeTimeSync(encodeTimeSyncReply(500, 7, 999999));
    expect(reply!.clientTimeMs).toBe(500);
    expect(reply!.id).toBe(7);
    expect(reply!.serverTimeMs).toBe(999999);
  });

  it('rejects a non-timesync packet', () => {
    expect(decodeTimeSync(encodeInput([cmd(1)], 0))).toBeNull();
  });
});

describe('surface index table', () => {
  it('preserves the wire order this protocol version promises', () => {
    expect([...SURFACES]).toEqual(WIRE_SURFACE_ORDER);
  });

  it('round-trips every surface through its wire index', () => {
    for (const surface of SURFACES) {
      expect(surfaceFromIndex(surfaceIndex(surface))).toBe(surface);
    }
  });

  it('falls back to metal rather than throwing on a bad value', () => {
    expect(surfaceIndex('not-a-surface')).toBe(0);
    expect(surfaceFromIndex(-1)).toBe('metal');
    expect(surfaceFromIndex(999)).toBe('metal');
    expect(surfaceFromIndex(SURFACES.length)).toBe('metal');
  });

  it('fits in the single byte the event channel allocates', () => {
    expect(SURFACES.length).toBeLessThanOrEqual(256);
  });
});

describe('JSON channel validation', () => {
  it('accepts a well-formed message', () => {
    const r = validateJsonMessage(JSON.stringify({ t: 'chat', text: 'hello' }));
    expect(r.ok).toBe(true);
    expect(r.value!.t).toBe('chat');
  });

  it('rejects malformed JSON, arrays, primitives and missing types', () => {
    expect(validateJsonMessage('{not json').ok).toBe(false);
    expect(validateJsonMessage('[1,2,3]').ok).toBe(false);
    expect(validateJsonMessage('"a string"').ok).toBe(false);
    expect(validateJsonMessage('null').ok).toBe(false);
    expect(validateJsonMessage(JSON.stringify({ text: 'no type' })).ok).toBe(false);
    expect(validateJsonMessage(JSON.stringify({ t: 42 })).ok).toBe(false);
    expect(validateJsonMessage(JSON.stringify({ t: '' })).ok).toBe(false);
  });

  it('rejects an oversized payload before parsing it', () => {
    const huge = JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_JSON_MESSAGE_BYTES) });
    expect(validateJsonMessage(huge).ok).toBe(false);
  });

  it('reads numbers with clamping and a fallback', () => {
    const obj = { t: 'x', a: 5, b: 'nope', c: NaN, d: 1e9 };
    expect(readNumber(obj, 'a', 0, 10, -1)).toBe(5);
    expect(readNumber(obj, 'b', 0, 10, -1)).toBe(-1);
    expect(readNumber(obj, 'c', 0, 10, -1)).toBe(-1);
    expect(readNumber(obj, 'd', 0, 10, -1)).toBe(10);
    expect(readNumber(obj, 'missing', 0, 10, 7)).toBe(7);
  });

  it('reads booleans and enums safely', () => {
    const obj = { t: 'x', flag: true, notFlag: 'true', mode: 'tdm', bad: 'hack' };
    expect(readBool(obj, 'flag')).toBe(true);
    expect(readBool(obj, 'notFlag')).toBe(false);
    expect(readEnum(obj, 'mode', ['ffa', 'tdm'] as const, 'ffa')).toBe('tdm');
    expect(readEnum(obj, 'bad', ['ffa', 'tdm'] as const, 'ffa')).toBe('ffa');
    expect(readEnum(obj, 'missing', ['ffa', 'tdm'] as const, 'ffa')).toBe('ffa');
  });

  it('truncates strings to the declared limit', () => {
    expect(readString({ t: 'x', s: 'abcdefghij' }, 's', 4)).toHaveLength(4);
    expect(readString({ t: 'x' }, 's', 4)).toBe('');
  });
});

describe('text sanitisation', () => {
  it('turns control characters into spaces so words do not fuse', () => {
    expect(sanitiseText(`a${NUL}b${BEL}c`, 40)).toBe('a b c');
    expect(sanitiseText('line1\nline2', 40)).toBe('line1 line2');
    expect(sanitiseText('tab\there', 40)).toBe('tab here');
    expect(sanitiseText(`del${DEL}char`, 40)).toBe('del char');
  });

  it('strips zero-width and bidi characters used to spoof names', () => {
    expect(sanitiseText(`a${ZERO_WIDTH_SPACE}b`, 40)).toBe('ab');
    expect(sanitiseText(`a${RTL_OVERRIDE}b`, 40)).toBe('ab');
    expect(sanitiseText(`a${RTL_MARK}b`, 40)).toBe('ab');
    expect(sanitiseText(`${BOM}hello`, 40)).toBe('hello');
    expect(sanitiseText(`a${ISOLATE_OPEN}b${ISOLATE_CLOSE}c`, 40)).toBe('abc');
    expect(sanitiseText(`a${WORD_JOINER}b`, 40)).toBe('ab');
    expect(sanitiseText(`soft${SOFT_HYPHEN}hyphen`, 40)).toBe('softhyphen');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitiseText('   lots    of    space   ', 40)).toBe('lots of space');
  });

  it('clamps to the maximum length', () => {
    expect(sanitiseText('x'.repeat(500), 16)).toHaveLength(16);
  });

  it('returns an empty string for non-strings', () => {
    expect(sanitiseText(undefined, 10)).toBe('');
    expect(sanitiseText(42, 10)).toBe('');
    expect(sanitiseText({}, 10)).toBe('');
  });

  it('rejects names that impersonate the server', () => {
    expect(sanitiseName('Server', 16)).toBe('');
    expect(sanitiseName('ADMIN', 16)).toBe('');
    expect(sanitiseName('system', 16)).toBe('');
    expect(sanitiseName('moderator', 16)).toBe('');
  });

  it('keeps normal names and allows tag punctuation', () => {
    expect(sanitiseName('Recruit_42', 16)).toBe('Recruit_42');
    expect(sanitiseName('[NS] Ion.Drift', 16)).toBe('[NS] Ion.Drift');
    expect(sanitiseName('<Vex>', 16)).toBe('<Vex>');
  });

  it('strips characters that would break HTML or the kill feed', () => {
    const cleaned = sanitiseName(`a"b'c&d`, 16);
    expect(cleaned).not.toContain('"');
    expect(cleaned).not.toContain("'");
    expect(cleaned).not.toContain('&');
  });
});

describe('protocol version', () => {
  it('is a positive integer both sides compile against', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
