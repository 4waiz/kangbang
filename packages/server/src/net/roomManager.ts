/**
 * Room lifecycle and matchmaking.
 *
 * One process hosts many rooms on a single fixed-rate loop; each room advances
 * its own Match. Quick Play prefers the fullest joinable room for the requested
 * mode so players group up instead of scattering across empty lobbies.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_PLAYERS,
  isMapId,
  isModeId,
  mapsForMode,
  quickPlayModes,
  sanitiseName,
  type CustomMatchConfig,
} from '@neon/shared';
import { config } from '../config.js';
import type { Database } from '../db/index.js';
import { log } from '../logger.js';
import { Room, generateRoomCode, type Connection, type RoomConfig, type RoomSummary } from './room.js';

export interface JoinRequest {
  mode?: string;
  map?: string;
  roomId?: string;
  code?: string;
  create?: boolean;
  privateRoom?: boolean;
  custom?: Partial<CustomMatchConfig>;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private byCode = new Map<string, Room>();
  private connRoom = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;
  private lastTickMs = 0;
  private accumulator = 0;
  /** Rolling tick-duration samples for the health endpoint. */
  private tickCostMs: number[] = [];

  constructor(private db: Database) {}

  start(): void {
    if (this.timer) return;
    this.lastTickMs = Date.now();
    const stepMs = 1000 / config.tickRate;
    this.timer = setInterval(() => this.pump(stepMs), Math.max(4, Math.floor(stepMs / 2)));
    log.info('rooms', `simulation loop started at ${config.tickRate}Hz`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const room of this.rooms.values()) room.close('server shutting down');
    this.rooms.clear();
    this.byCode.clear();
    this.connRoom.clear();
  }

  /**
   * Fixed-step pump. Uses an accumulator so a slow tick catches up rather than
   * silently slowing the whole simulation, but caps catch-up so a long GC pause
   * cannot produce a burst of 50 steps.
   */
  private pump(stepMs: number): void {
    const now = Date.now();
    let delta = now - this.lastTickMs;
    this.lastTickMs = now;
    if (delta > 250) delta = 250;
    this.accumulator += delta;

    const dt = stepMs / 1000;
    let steps = 0;
    const started = performance.now();
    while (this.accumulator >= stepMs && steps < 6) {
      this.accumulator -= stepMs;
      steps++;
      for (const room of this.rooms.values()) {
        try {
          room.update(dt, Date.now());
        } catch (err) {
          log.error('rooms', `room ${room.id} threw during update`, { error: String(err) });
        }
      }
    }
    if (steps > 0) {
      const cost = performance.now() - started;
      this.tickCostMs.push(cost / steps);
      if (this.tickCostMs.length > 120) this.tickCostMs.shift();
    }

    this.reapRooms();
  }

  private reapRooms(): void {
    for (const [id, room] of [...this.rooms]) {
      // Empty rooms live for a minute so a rejoin lands in the same lobby.
      if (room.isEmpty && room.idleMs > 60000 && room.botCountLive >= 0) {
        room.close('room closed');
        this.rooms.delete(id);
        this.byCode.delete(room.code);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Matchmaking
  // ---------------------------------------------------------------------

  listRooms(includePrivate = false): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      if (room.cfg.privateRoom && !includePrivate) continue;
      out.push(room.summary());
    }
    // Fullest first so the browser shows live games at the top.
    out.sort((a, b) => b.humans - a.humans || a.name.localeCompare(b.name));
    return out;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  playerCount(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.humanCount;
    return n;
  }

  averageTickMs(): number {
    if (this.tickCostMs.length === 0) return 0;
    return this.tickCostMs.reduce((s, v) => s + v, 0) / this.tickCostMs.length;
  }

  findRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  findByCode(code: string): Room | undefined {
    return this.byCode.get(code.toUpperCase());
  }

  /** Resolve a join request into a room, creating one when needed. */
  resolveRoom(req: JoinRequest): Room | null {
    if (req.code) {
      const room = this.byCode.get(req.code.toUpperCase());
      return room && room.canAccept() ? room : null;
    }
    if (req.roomId) {
      const room = this.rooms.get(req.roomId);
      return room && room.canAccept() ? room : null;
    }
    if (req.create) {
      return this.createRoom(req);
    }

    // Quick Play: pick the fullest joinable public room for the mode.
    const mode = req.mode && isModeId(req.mode) ? req.mode : this.randomQuickPlayMode();
    let best: Room | null = null;
    for (const room of this.rooms.values()) {
      if (room.cfg.privateRoom) continue;
      if (room.cfg.mode !== mode) continue;
      if (!room.canAccept()) continue;
      if (room.humanCount >= room.cfg.maxPlayers) continue;
      if (!best || room.humanCount > best.humanCount) best = room;
    }
    if (best) return best;
    return this.createRoom({ mode, map: req.map, privateRoom: false });
  }

  private randomQuickPlayMode(): string {
    const modes = quickPlayModes();
    return modes[Math.floor(Math.random() * modes.length)].id;
  }

  createRoom(req: JoinRequest): Room | null {
    if (this.rooms.size >= config.maxRooms) {
      log.warn('rooms', 'room limit reached', { limit: config.maxRooms });
      return null;
    }
    const mode = req.mode && isModeId(req.mode) ? req.mode : 'tdm';
    const allowedMaps = mapsForMode(mode === 'custom' ? (req.custom?.mode ?? 'tdm') : mode);
    const map = req.map && isMapId(req.map) && allowedMaps.includes(req.map) ? req.map : allowedMaps[0];
    const code = generateRoomCode((c) => this.byCode.has(c));
    const custom = req.custom ?? {};

    const cfg: RoomConfig = {
      id: randomUUID(),
      code,
      name: sanitiseName(custom.name, 28) || defaultRoomName(mode, code),
      mode,
      map,
      privateRoom: !!(req.privateRoom ?? custom.privateRoom),
      maxPlayers: clampInt(custom.maxPlayers ?? config.maxPlayersPerRoom, 2, MAX_PLAYERS),
      botCount: clampInt(custom.botCount ?? defaultBotCount(mode), 0, 31),
      botDifficulty: (custom.botDifficulty ?? config.bots.difficulty) as RoomConfig['botDifficulty'],
      friendlyFire: !!custom.friendlyFire,
      scoreLimit: custom.scoreLimit,
      timeLimitSec: custom.timeLimitSec,
      weaponSet: custom.weaponSet,
    };

    const room = new Room(cfg, this.db);
    this.rooms.set(room.id, room);
    this.byCode.set(room.code, room);
    log.info('rooms', 'created room', { id: room.id, code: room.code, mode, map });
    return room;
  }

  // ---------------------------------------------------------------------
  // Connection routing
  // ---------------------------------------------------------------------

  attach(conn: Connection, room: Room, loadout: unknown): number {
    const entityId = room.join(conn, loadout as never);
    if (entityId === 0) return 0;
    this.connRoom.set(conn.id, room);
    return entityId;
  }

  roomForConnection(connId: string): Room | undefined {
    return this.connRoom.get(connId);
  }

  detach(connId: string, graceful: boolean): void {
    const room = this.connRoom.get(connId);
    if (!room) return;
    room.leave(connId, graceful);
    this.connRoom.delete(connId);
  }
}

function defaultRoomName(mode: string, code: string): string {
  return `${mode.toUpperCase()} ${code}`;
}

function defaultBotCount(mode: string): number {
  if (!config.bots.fill) return 0;
  try {
    const m = isModeId(mode) ? mode : 'tdm';
    const def = quickPlayModes().find((x) => x.id === m);
    return def?.defaultBots ?? config.bots.fillTarget;
  } catch {
    return config.bots.fillTarget;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
