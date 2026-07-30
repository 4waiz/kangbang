/**
 * Room / multiplayer-plumbing tests.
 *
 * Drives a real Room through a fake Connection so join, teams, ready, chat,
 * mute, report, spectate, reconnect and rate limiting are exercised end to end
 * without opening a socket.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  COUNTDOWN_SECONDS,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MatchPhase,
  Msg,
  PROTOCOL_VERSION,
  Team,
  WARMUP_SECONDS,
  createSnapshot,
  decodeSnapshot,
  sanitiseText,
  validateJsonMessage,
} from '@neon/shared';
import { Room, generateRoomCode, type Connection, type RoomConfig } from '../net/room.js';
import { MemoryDatabase } from '../db/memory.js';
import { config } from '../config.js';

class FakeConnection implements Connection {
  readonly json: Record<string, unknown>[] = [];
  readonly binary: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | null = null;
  readonly accountLevel = 1;
  readonly banner = 'banner_grid';
  readonly icon = 'icon_recruit';
  readonly remoteAddress = '127.0.0.1';
  private state = 1;

  constructor(
    readonly id: string,
    readonly profileId: string,
    readonly name: string,
    readonly guest = true,
  ) {}

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      this.json.push(JSON.parse(data) as Record<string, unknown>);
    } else {
      this.binary.push(data.slice());
    }
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.state = 3;
  }

  readyState(): number {
    return this.state;
  }

  /** Most recent message of a type, or undefined. */
  last(type: string): Record<string, unknown> | undefined {
    for (let i = this.json.length - 1; i >= 0; i--) if (this.json[i].t === type) return this.json[i];
    return undefined;
  }

  all(type: string): Record<string, unknown>[] {
    return this.json.filter((m) => m.t === type);
  }
}

const LOADOUT = { classId: 'vanguard', primary: 'pulse_ar', secondary: 'energy_pistol', melee: 'plasma_blade' };

function roomConfig(over: Partial<RoomConfig> = {}): RoomConfig {
  return {
    id: 'room-test',
    code: 'ABCD',
    name: 'Test Room',
    mode: 'tdm',
    map: 'neon_foundry',
    privateRoom: false,
    maxPlayers: 8,
    botCount: 0,
    botDifficulty: 'normal',
    friendlyFire: false,
    ...over,
  };
}

let db: MemoryDatabase;
let room: Room;

async function makeRoom(over: Partial<RoomConfig> = {}): Promise<Room> {
  db = new MemoryDatabase();
  await db.init();
  return new Room(roomConfig(over), db);
}

function joinAs(r: Room, name: string): { conn: FakeConnection; entityId: number } {
  const conn = new FakeConnection(`conn-${name}`, `profile-${name}`, name);
  const entityId = r.join(conn, LOADOUT);
  return { conn, entityId };
}

/** Advance a room by wall-clock-free steps. */
function tick(r: Room, seconds: number): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) r.update(dt, Date.now());
}

beforeEach(async () => {
  room = await makeRoom();
});

describe('joining', () => {
  it('assigns an entity id and sends a welcome with the map and mode', () => {
    const { conn, entityId } = joinAs(room, 'Alpha');
    expect(entityId).toBeGreaterThan(0);
    const welcome = conn.last(Msg.Welcome);
    expect(welcome).toBeTruthy();
    expect(welcome!.entityId).toBe(entityId);
    expect(welcome!.protocol).toBe(PROTOCOL_VERSION);
    expect(welcome!.mapId).toBe('neon_foundry');
    expect(welcome!.mode).toBe('tdm');
  });

  it('broadcasts a player list that includes everyone', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    const list = b.conn.last(Msg.PlayerList);
    expect(list).toBeTruthy();
    const names = (list!.players as { name: string }[]).map((p) => p.name).sort();
    expect(names).toEqual(['Alpha', 'Bravo']);
    expect(a.conn.all(Msg.PlayerList).length).toBeGreaterThan(0);
  });

  it('auto-balances teams as players arrive', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (const n of names) joinAs(room, n);
    const ion = room.match.playerList().filter((p) => p.team === Team.Ion).length;
    const ember = room.match.playerList().filter((p) => p.team === Team.Ember).length;
    expect(Math.abs(ion - ember)).toBeLessThanOrEqual(1);
    expect(ion + ember).toBe(names.length);
  });

  it('refuses to exceed the player cap when there are no bots to evict', async () => {
    const small = await makeRoom({ maxPlayers: 2, botCount: 0 });
    expect(joinAs(small, 'A').entityId).toBeGreaterThan(0);
    expect(joinAs(small, 'B').entityId).toBeGreaterThan(0);
    expect(joinAs(small, 'C').entityId).toBe(0);
    expect(small.humanCount).toBe(2);
  });

  it('evicts a bot rather than turning a real player away', async () => {
    const full = await makeRoom({ maxPlayers: 2, botCount: 4 });
    expect(full.botCountLive).toBeGreaterThan(0);
    joinAs(full, 'A');
    joinAs(full, 'B');
    const botsBefore = full.botCountLive;
    const third = joinAs(full, 'C');
    expect(third.entityId).toBeGreaterThan(0);
    expect(full.botCountLive).toBeLessThan(botsBefore);
  });

  it('reports an accurate summary for the server browser', () => {
    joinAs(room, 'Alpha');
    const s = room.summary();
    expect(s.code).toBe('ABCD');
    expect(s.humans).toBe(1);
    expect(s.maxPlayers).toBe(8);
    expect(s.modeName.length).toBeGreaterThan(2);
    expect(s.mapName.length).toBeGreaterThan(2);
    expect(s.privateRoom).toBe(false);
    expect(s.scores).toEqual([0, 0]);
  });
});

describe('leaving and reconnecting', () => {
  it('holds the slot for a dropped player and restores it on reconnect', () => {
    const a = joinAs(room, 'Alpha');
    joinAs(room, 'Bravo');
    room.leave(a.conn.id, false);
    expect(room.humanCount).toBe(1);
    // The player object survives so the score is not lost.
    expect(room.match.getPlayer(a.entityId)).toBeTruthy();
    expect(room.match.getPlayer(a.entityId)!.connected).toBe(false);

    const again = new FakeConnection('conn-Alpha-2', 'profile-Alpha', 'Alpha');
    const restored = room.join(again, LOADOUT);
    expect(restored).toBe(a.entityId);
    expect(room.humanCount).toBe(2);
    expect(room.match.getPlayer(a.entityId)!.connected).toBe(true);
    expect(again.last(Msg.Welcome)).toBeTruthy();
  });

  it('frees the slot entirely on a graceful leave', () => {
    const a = joinAs(room, 'Alpha');
    joinAs(room, 'Bravo');
    room.leave(a.conn.id, true);
    expect(room.match.getPlayer(a.entityId)).toBeUndefined();
    expect(room.humanCount).toBe(1);
  });

  it('reports empty once the last human leaves', () => {
    const a = joinAs(room, 'Solo');
    expect(room.isEmpty).toBe(false);
    room.leave(a.conn.id, true);
    expect(room.isEmpty).toBe(true);
  });
});

describe('lobby flow', () => {
  it('skips the rest of warmup once everyone is ready', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    expect(room.match.phase).toBe(MatchPhase.Warmup);
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    room.handleJson(b.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    expect(room.readyCount()).toEqual([2, 2]);
    tick(room, 0.2);
    expect(room.match.phase).toBe(MatchPhase.Countdown);
    tick(room, COUNTDOWN_SECONDS + 0.5);
    expect(room.match.phase).toBe(MatchPhase.Live);
  });

  it('waits out the warmup clock while a player is not ready', () => {
    const a = joinAs(room, 'Alpha');
    joinAs(room, 'Bravo');
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    expect(room.readyCount()).toEqual([1, 2]);
    tick(room, 1);
    expect(room.match.phase).toBe(MatchPhase.Warmup);
    // ...but the warmup clock still starts the match on its own.
    tick(room, WARMUP_SECONDS + COUNTDOWN_SECONDS + 1);
    expect(room.match.phase).toBe(MatchPhase.Live);
  });

  it('lets a solo player start immediately against bots', async () => {
    const solo = await makeRoom({ botCount: 3 });
    const a = joinAs(solo, 'Alpha');
    solo.handleJson(a.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    tick(solo, COUNTDOWN_SECONDS + 0.5);
    expect(solo.match.phase).toBe(MatchPhase.Live);
    expect(solo.botCountLive).toBe(3);
  });

  it('un-readying cancels an early start', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    room.handleJson(b.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    room.handleJson(b.conn.id, JSON.stringify({ t: Msg.SetReady, ready: false }));
    expect(room.readyCount()).toEqual([1, 2]);
    tick(room, 1);
    expect(room.match.phase).toBe(MatchPhase.Warmup);
  });

  it('refuses a team switch that would unbalance the sides', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    const pa = room.match.getPlayer(a.entityId)!;
    const pb = room.match.getPlayer(b.entityId)!;
    expect(pa.team).not.toBe(pb.team);
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.SelectTeam, team: pb.team }));
    expect(pa.team).not.toBe(pb.team);
    expect(String(a.conn.last(Msg.Notice)?.text)).toMatch(/full/i);
  });

  it('allows a team switch that evens the sides up', () => {
    // Three players means one side has two: the odd player out may move over.
    const a = joinAs(room, 'Alpha');
    joinAs(room, 'Bravo');
    joinAs(room, 'Charlie');
    const pa = room.match.getPlayer(a.entityId)!;
    const counts = [0, 0];
    for (const p of room.match.playerList()) {
      if (p.team === Team.Ion) counts[0]++;
      else if (p.team === Team.Ember) counts[1]++;
    }
    const smaller = counts[0] <= counts[1] ? Team.Ion : Team.Ember;
    const mover = room.match.playerList().find((p) => p.team !== smaller && !p.bot)!;
    const conn = mover.id === pa.id ? a.conn.id : `conn-${mover.name}`;
    room.handleJson(conn, JSON.stringify({ t: Msg.SelectTeam, team: smaller }));
    const after = [0, 0];
    for (const p of room.match.playerList()) {
      if (p.team === Team.Ion) after[0]++;
      else if (p.team === Team.Ember) after[1]++;
    }
    expect(Math.abs(after[0] - after[1])).toBeLessThanOrEqual(1);
  });

  it('ignores team selection in a free-for-all', async () => {
    const ffa = await makeRoom({ mode: 'ffa' });
    const a = joinAs(ffa, 'Alpha');
    ffa.handleJson(a.conn.id, JSON.stringify({ t: Msg.SelectTeam, team: Team.Ion }));
    expect(ffa.match.getPlayer(a.entityId)!.team).toBe(Team.None);
  });

  it('toggles spectator mode both ways', () => {
    const a = joinAs(room, 'Alpha');
    const p = room.match.getPlayer(a.entityId)!;
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Spectate }));
    expect(p.spectating).toBe(true);
    expect(p.alive).toBe(false);
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Spectate }));
    expect(p.spectating).toBe(false);
  });
});

describe('chat', () => {
  it('delivers a public message to everyone', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: 'good luck' }));
    for (const c of [a.conn, b.conn]) {
      const m = c.last(Msg.ChatMsg);
      expect(m, `${c.name} did not receive the message`).toBeTruthy();
      expect(m!.text).toBe('good luck');
      expect(m!.from).toBe('Alpha');
    }
  });

  it('keeps team chat inside the team', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    const pa = room.match.getPlayer(a.entityId)!;
    const pb = room.match.getPlayer(b.entityId)!;
    expect(pa.team).not.toBe(pb.team);
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: 'rotating B', teamOnly: true }));
    expect(a.conn.last(Msg.ChatMsg)).toBeTruthy();
    expect(b.conn.last(Msg.ChatMsg)).toBeUndefined();
  });

  it('strips control characters and clamps the length', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    const nasty = `hi${String.fromCharCode(7)}there${String.fromCharCode(0x202e)}${'x'.repeat(400)}`;
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: nasty }));
    const text = b.conn.last(Msg.ChatMsg)!.text as string;
    expect(text.length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
    expect(text).not.toContain(String.fromCharCode(7));
    expect(text).not.toContain(String.fromCharCode(0x202e));
  });

  it('drops an empty or whitespace-only message', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: '   ' }));
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: '' }));
    expect(b.conn.all(Msg.ChatMsg)).toHaveLength(0);
  });

  it('silences a muted player for the muter only', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    const c = joinAs(room, 'Charlie');
    room.handleJson(b.conn.id, JSON.stringify({ t: Msg.Mute, targetId: a.entityId, muted: true }));
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: 'spam' }));
    expect(b.conn.all(Msg.ChatMsg)).toHaveLength(0);
    // Everyone else still hears them (subject to team filtering).
    const heard = [a.conn, c.conn].some((conn) => conn.all(Msg.ChatMsg).length > 0);
    expect(heard).toBe(true);
    // Unmuting restores delivery.
    room.handleJson(b.conn.id, JSON.stringify({ t: Msg.Mute, targetId: a.entityId, muted: false }));
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: 'again' }));
    expect(b.conn.all(Msg.ChatMsg)).toHaveLength(1);
  });

  it('acknowledges a report without exposing anything about the target', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    room.handleJson(
      a.conn.id,
      JSON.stringify({ t: Msg.Report, targetId: b.entityId, reason: 'cheating', note: 'shooting through walls' }),
    );
    const notice = a.conn.last(Msg.Notice);
    expect(notice).toBeTruthy();
    expect(String(notice!.text)).toMatch(/report/i);
    expect(JSON.stringify(notice)).not.toContain('suspicion');
  });

  it('answers a ping with the client timestamp echoed back', () => {
    const a = joinAs(room, 'Alpha');
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Ping, id: 42, clientTime: 123456 }));
    const pong = a.conn.last(Msg.Pong)!;
    expect(pong.id).toBe(42);
    expect(pong.clientTime).toBe(123456);
    expect(Number(pong.serverTime)).toBeGreaterThan(0);
  });
});

describe('abuse resistance', () => {
  it('ignores a message flood and eventually closes the socket', () => {
    const a = joinAs(room, 'Alpha');
    const b = joinAs(room, 'Bravo');
    const limit = config.antiCheat.msgRateLimit;
    for (let i = 0; i < limit * 4; i++) {
      room.handleJson(a.conn.id, JSON.stringify({ t: Msg.Chat, text: `spam ${i}` }));
    }
    expect(b.conn.all(Msg.ChatMsg).length).toBeLessThanOrEqual(limit);
    expect(a.conn.closedWith?.code).toBe(4009);
  });

  it('flags malformed JSON without throwing', () => {
    const a = joinAs(room, 'Alpha');
    expect(() => room.handleJson(a.conn.id, '{not json')).not.toThrow();
    expect(() => room.handleJson(a.conn.id, 'null')).not.toThrow();
    expect(() => room.handleJson(a.conn.id, '[1,2,3]')).not.toThrow();
    expect(() => room.handleJson(a.conn.id, JSON.stringify({ t: 'nope' }))).not.toThrow();
    expect(room.match.getPlayer(a.entityId)!.suspicion).toBeGreaterThan(0);
  });

  it('survives arbitrary binary garbage', () => {
    const a = joinAs(room, 'Alpha');
    const junk = new Uint8Array(64);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 0xff;
    expect(() => room.handleBinary(a.conn.id, junk)).not.toThrow();
    expect(() => room.handleBinary(a.conn.id, new Uint8Array(0))).not.toThrow();
    expect(() => room.handleBinary(a.conn.id, new Uint8Array(3))).not.toThrow();
  });

  it('ignores messages from a connection that never joined', () => {
    expect(() => room.handleJson('ghost', JSON.stringify({ t: Msg.Chat, text: 'hi' }))).not.toThrow();
    expect(() => room.handleBinary('ghost', new Uint8Array(8))).not.toThrow();
    expect(() => room.leave('ghost', true)).not.toThrow();
  });

  it('rejects a loadout referencing weapons that do not exist', () => {
    const a = joinAs(room, 'Alpha');
    room.handleJson(
      a.conn.id,
      JSON.stringify({ t: Msg.SetLoadout, loadout: { classId: 'god', primary: 'bfg', secondary: 'x', melee: 'y' } }),
    );
    const p = room.match.getPlayer(a.entityId)!;
    expect(p.classDef.id).not.toBe('god');
    for (const w of p.weapons) expect(w.def.id.length).toBeGreaterThan(0);
  });
});

describe('snapshots', () => {
  it('sends decodable binary snapshots once the match is running', () => {
    const a = joinAs(room, 'Alpha');
    joinAs(room, 'Bravo');
    room.handleJson(a.conn.id, JSON.stringify({ t: Msg.SetReady, ready: true }));
    room.handleJson(`conn-Bravo`, JSON.stringify({ t: Msg.SetReady, ready: true }));
    tick(room, 6);
    expect(a.conn.binary.length).toBeGreaterThan(0);
    const snap = decodeSnapshot(a.conn.binary[a.conn.binary.length - 1], createSnapshot());
    expect(snap).not.toBeNull();
    expect(snap!.entities.length).toBeGreaterThanOrEqual(1);
    expect(snap!.self, 'no authoritative self state for reconciliation').not.toBeNull();
    expect(Number.isFinite(snap!.self!.x)).toBe(true);
    expect(Number.isFinite(snap!.entities[0].x)).toBe(true);
    expect(snap!.tick).toBeGreaterThan(0);
  });

  it('broadcasts match state as JSON with the fields the HUD needs', () => {
    const a = joinAs(room, 'Alpha');
    tick(room, 1);
    const envelope = a.conn.last(Msg.MatchState)!;
    expect(envelope).toBeTruthy();
    const state = envelope.state as Record<string, unknown>;
    expect(typeof state.phase).toBe('string');
    expect(typeof state.timeRemaining).toBe('number');
    expect(Array.isArray(state.teamScores)).toBe(true);
    expect(Number(state.scoreLimit)).toBeGreaterThan(0);
  });
});

describe('room codes', () => {
  it('generates unique, readable, unambiguous codes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode((c) => seen.has(c));
      expect(code).toMatch(/^[A-Z0-9]{4,6}$/);
      // Characters that read alike must not appear.
      expect(code).not.toMatch(/[OI10]/);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });
});

describe('message validation', () => {
  it('accepts a well-formed message and rejects everything else', () => {
    expect(validateJsonMessage(JSON.stringify({ t: Msg.Chat, text: 'hi' })).ok).toBe(true);
    expect(validateJsonMessage('not json').ok).toBe(false);
    expect(validateJsonMessage('"a string"').ok).toBe(false);
    expect(validateJsonMessage('123').ok).toBe(false);
    expect(validateJsonMessage('null').ok).toBe(false);
    expect(validateJsonMessage('[]').ok).toBe(false);
    expect(validateJsonMessage(JSON.stringify({ noType: true })).ok).toBe(false);
  });

  it('rejects an oversized payload before parsing it', () => {
    const huge = JSON.stringify({ t: Msg.Chat, text: 'x'.repeat(200_000) });
    expect(validateJsonMessage(huge).ok).toBe(false);
  });

  it('clamps player names to the advertised limit', () => {
    expect(sanitiseText('x'.repeat(500), MAX_NAME_LENGTH).length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });
});
