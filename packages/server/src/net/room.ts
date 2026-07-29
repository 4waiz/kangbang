/**
 * A Room owns one Match, its connections and its bots, and drives the fixed
 * simulation loop.
 *
 * Trust boundary: everything arriving from a socket lands in `handleJson` /
 * `handleBinary`, is validated, and is then *queued* for the simulation. The
 * simulation itself never reads a socket.
 */

import { randomUUID } from 'node:crypto';
import {
  CLIENT_TIMEOUT_MS,
  COUNTDOWN_SECONDS,
  MATCH_END_SECONDS,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MIN_PLAYERS_TO_START,
  MatchPhase,
  Msg,
  PROTOCOL_VERSION,
  PacketType,
  RECONNECT_GRACE_MS,
  ROOM_CODE_LENGTH,
  SUSPICION_KICK_THRESHOLD,
  Team,
  createDecodedInput,
  decodeInput,
  decodeTimeSync,
  encodeSnapshot,
  encodeTimeSyncReply,
  getMode,
  isMapId,
  isModeId,
  levelFromXp,
  mapsForMode,
  packetTypeOf,
  readBool,
  readEnum,
  readNumber,
  readString,
  sanitiseName,
  sanitiseText,
  validateJsonMessage,
  weaponIndex,
  type EntitySnapshot,
  type KillFeedEntry,
  type MatchResultsPayload,
  type PlayerPublicState,
  type SelfState,
} from '@neon/shared';
import { config } from '../config.js';
import type { Database } from '../db/index.js';
import { BotController, botClassFor, botName, type BotDifficulty } from '../game/bots.js';
import { Match, type MatchOptions } from '../game/match.js';
import { ServerPlayer, defaultLoadoutFor, sanitiseLoadout } from '../game/player.js';
import { awardMatch, buildResultRow, type AwardResult } from '../game/progression.js';
import { logSuspicious } from '../logger.js';

export interface Connection {
  id: string;
  profileId: string;
  name: string;
  accountLevel: number;
  banner: string;
  icon: string;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  readyState(): number;
  remoteAddress: string;
}

interface ClientRecord {
  conn: Connection;
  entityId: number;
  lastSeenMs: number;
  lastPingMs: number;
  /** Rolling message counter for rate limiting. */
  msgCount: number;
  msgWindowStart: number;
  /** Sequence of the last input we accepted. */
  lastInputSeq: number;
  wantsRematch: boolean;
  muted: Set<number>;
  /** Set when the socket dropped; the slot is held briefly for reconnects. */
  disconnectedAtMs: number;
}

export interface RoomConfig {
  id: string;
  code: string;
  name: string;
  mode: string;
  map: string;
  privateRoom: boolean;
  maxPlayers: number;
  botCount: number;
  botDifficulty: BotDifficulty;
  friendlyFire: boolean;
  scoreLimit?: number;
  timeLimitSec?: number;
  weaponSet?: string;
  ownerProfileId?: string;
}

export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  mode: string;
  modeName: string;
  map: string;
  mapName: string;
  players: number;
  humans: number;
  bots: number;
  maxPlayers: number;
  phase: string;
  privateRoom: boolean;
  timeRemaining: number;
  scores: [number, number];
}

const inputScratch = createDecodedInput();

export class Room {
  readonly id: string;
  readonly code: string;
  cfg: RoomConfig;
  match: Match;
  private clients = new Map<number, ClientRecord>();
  private byConnId = new Map<string, number>();
  private bots = new Map<number, BotController>();
  private db: Database;
  private countdown = 0;
  private snapshotAccumulator = 0;
  private killFeedCursor = 0;
  private lastStateBroadcast = 0;
  private closed = false;
  private nextBotIndex = 0;
  private resultsSent = false;
  private createdAtMs = Date.now();
  private lastActivityMs = Date.now();
  private matchId = randomUUID();

  constructor(cfg: RoomConfig, db: Database) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.code = cfg.code;
    this.db = db;
    this.match = new Match(this.matchOptions());
    this.ensureBots();
  }

  private matchOptions(): MatchOptions {
    return {
      mode: this.cfg.mode,
      map: this.cfg.map,
      friendlyFire: this.cfg.friendlyFire,
      custom: {
        mode: this.cfg.mode === 'custom' ? 'tdm' : this.cfg.mode,
        scoreLimit: this.cfg.scoreLimit,
        timeLimitSec: this.cfg.timeLimitSec,
        friendlyFire: this.cfg.friendlyFire,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------

  get humanCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.disconnectedAtMs === 0) n++;
    return n;
  }

  get botCountLive(): number {
    return this.bots.size;
  }

  get isEmpty(): boolean {
    return this.humanCount === 0;
  }

  get idleMs(): number {
    return Date.now() - this.lastActivityMs;
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      code: this.code,
      name: this.cfg.name,
      mode: this.cfg.mode,
      modeName: getMode(this.cfg.mode === 'custom' ? 'custom' : this.cfg.mode).name,
      map: this.cfg.map,
      mapName: this.match.mapDef.name,
      players: this.match.playerCount(),
      humans: this.humanCount,
      bots: this.bots.size,
      maxPlayers: this.cfg.maxPlayers,
      phase: this.match.phase,
      privateRoom: this.cfg.privateRoom,
      timeRemaining: Math.round(this.match.timeRemaining),
      scores: [Math.round(this.match.teamScores[0]), Math.round(this.match.teamScores[1])],
    };
  }

  canAccept(): boolean {
    return !this.closed && this.match.playerCount() < this.cfg.maxPlayers + this.cfg.botCount + 4;
  }

  /** Attach a socket. Returns the entity id, or 0 when the room is full. */
  join(conn: Connection, loadout: Parameters<typeof sanitiseLoadout>[0]): number {
    if (this.closed) return 0;
    // Reconnect: reuse the slot if the same profile dropped recently.
    for (const [entityId, rec] of this.clients) {
      if (rec.conn.profileId === conn.profileId && rec.disconnectedAtMs > 0) {
        rec.conn = conn;
        rec.disconnectedAtMs = 0;
        rec.lastSeenMs = Date.now();
        this.byConnId.set(conn.id, entityId);
        const p = this.match.getPlayer(entityId);
        if (p) {
          p.connected = true;
          p.name = conn.name;
        }
        this.sendWelcome(conn, entityId);
        this.broadcastPlayerList();
        return entityId;
      }
    }

    if (this.humanCount >= this.cfg.maxPlayers) {
      // Kick a bot to make room rather than refusing a real player.
      if (!this.removeOneBot()) return 0;
    }

    const entityId = this.match.allocateEntityId();
    if (entityId === 0) return 0;

    const player = new ServerPlayer(entityId, conn.profileId, conn.name, sanitiseLoadout(loadout ?? defaultLoadoutFor('vanguard')));
    player.accountLevel = conn.accountLevel;
    player.banner = conn.banner;
    player.icon = conn.icon;
    player.team = this.pickTeam();
    this.match.addPlayer(player);

    this.clients.set(entityId, {
      conn,
      entityId,
      lastSeenMs: Date.now(),
      lastPingMs: 0,
      msgCount: 0,
      msgWindowStart: Date.now(),
      lastInputSeq: 0,
      wantsRematch: false,
      muted: new Set(),
      disconnectedAtMs: 0,
    });
    this.byConnId.set(conn.id, entityId);
    this.lastActivityMs = Date.now();

    this.sendWelcome(conn, entityId);
    // Spawn immediately unless the match is on the results screen: warmup is
    // meant to be playable, and a player staring at a dead camera for eight
    // seconds after clicking Play is not an acceptable first impression.
    if (this.match.phase !== MatchPhase.Ended) {
      this.match.spawnPlayer(player, Date.now());
    }
    this.ensureBots();
    this.rebalanceTeams();
    this.broadcastPlayerList();
    this.broadcastMatchState();
    this.pushNotice(`${player.name} joined`);
    return entityId;
  }

  leave(connId: string, graceful: boolean): void {
    const entityId = this.byConnId.get(connId);
    if (entityId === undefined) return;
    this.byConnId.delete(connId);
    const rec = this.clients.get(entityId);
    if (!rec) return;
    const p = this.match.getPlayer(entityId);
    if (graceful) {
      this.clients.delete(entityId);
      this.match.removePlayer(entityId);
      if (p) this.pushNotice(`${p.name} left`);
    } else {
      // Hold the slot briefly so a refresh or blip does not lose the match.
      rec.disconnectedAtMs = Date.now();
      if (p) {
        p.connected = false;
        p.pendingInputs.length = 0;
      }
    }
    this.lastActivityMs = Date.now();
    this.ensureBots();
    this.broadcastPlayerList();
  }

  private pickTeam(): number {
    if (getMode(this.cfg.mode === 'custom' ? 'tdm' : this.cfg.mode).teams === 1) return Team.None;
    let ion = 0;
    let ember = 0;
    for (const p of this.match.playerList()) {
      if (p.spectating) continue;
      if (p.team === Team.Ion) ion++;
      else if (p.team === Team.Ember) ember++;
    }
    if (ion === ember) return Math.random() < 0.5 ? Team.Ion : Team.Ember;
    return ion < ember ? Team.Ion : Team.Ember;
  }

  /** Move bots (never humans mid-match) to keep the teams even. */
  private rebalanceTeams(): void {
    if (getMode(this.cfg.mode === 'custom' ? 'tdm' : this.cfg.mode).teams === 1) return;
    for (let pass = 0; pass < 8; pass++) {
      const ion = this.match.playerList().filter((p) => !p.spectating && p.team === Team.Ion);
      const ember = this.match.playerList().filter((p) => !p.spectating && p.team === Team.Ember);
      const diff = ion.length - ember.length;
      if (Math.abs(diff) <= 1) return;
      const from = diff > 0 ? ion : ember;
      const to = diff > 0 ? Team.Ember : Team.Ion;
      const movable = from.find((p) => p.bot) ?? from[from.length - 1];
      if (!movable) return;
      movable.team = to;
      if (movable.alive) this.match.spawnPlayer(movable, Date.now());
    }
  }

  // ---------------------------------------------------------------------
  // Bots
  // ---------------------------------------------------------------------

  private ensureBots(): void {
    const target = this.desiredBotCount();
    while (this.bots.size > target) {
      if (!this.removeOneBot()) break;
    }
    while (this.bots.size < target && this.match.playerCount() < this.cfg.maxPlayers + this.cfg.botCount) {
      if (!this.addBot()) break;
    }
    this.rebalanceTeams();
  }

  private desiredBotCount(): number {
    if (!config.bots.fill && this.cfg.botCount === 0) return 0;
    const wanted = this.cfg.botCount;
    const humans = this.humanCount;
    // Bots top the match up to the configured count; humans replace them.
    return Math.max(0, Math.min(wanted, this.cfg.maxPlayers - humans + wanted - Math.max(0, humans - 1)));
  }

  private addBot(): boolean {
    const entityId = this.match.allocateEntityId();
    if (entityId === 0) return false;
    const index = this.nextBotIndex++;
    const classId = botClassFor(index);
    const p = new ServerPlayer(entityId, `bot:${entityId}`, botName(index, this.id.charCodeAt(0)), defaultLoadoutFor(classId));
    p.bot = true;
    p.botDifficulty = this.cfg.botDifficulty;
    p.accountLevel = 1 + ((index * 7) % 40);
    p.team = this.pickTeam();
    p.ready = true;
    this.match.addPlayer(p);
    this.bots.set(entityId, new BotController(p, this.match.nav, this.cfg.botDifficulty, entityId * 7919 + index));
    if (this.match.phase !== MatchPhase.Ended) this.match.spawnPlayer(p, Date.now());
    return true;
  }

  private removeOneBot(): boolean {
    // Remove the bot with the lowest score so the match stays competitive.
    let worst: number | null = null;
    let worstScore = Infinity;
    for (const id of this.bots.keys()) {
      const p = this.match.getPlayer(id);
      const s = p ? p.score : 0;
      if (s < worstScore) {
        worstScore = s;
        worst = id;
      }
    }
    if (worst === null) return false;
    this.bots.delete(worst);
    this.match.removePlayer(worst);
    return true;
  }

  setBotCount(n: number): void {
    this.cfg.botCount = Math.max(0, Math.min(31, Math.round(n)));
    this.ensureBots();
  }

  setBotDifficulty(d: BotDifficulty): void {
    this.cfg.botDifficulty = d;
    for (const bot of this.bots.values()) bot.setDifficulty(d);
    for (const p of this.match.playerList()) if (p.bot) p.botDifficulty = d;
  }

  // ---------------------------------------------------------------------
  // Simulation loop
  // ---------------------------------------------------------------------

  update(dt: number, nowMs: number): void {
    if (this.closed) return;

    // Bots think first so their inputs are processed this tick.
    for (const [id, bot] of this.bots) {
      const p = this.match.getPlayer(id);
      if (!p) {
        this.bots.delete(id);
        continue;
      }
      p.pendingInputs.push(bot.think(this.match, dt, nowMs));
      if (p.pendingInputs.length > 4) p.pendingInputs.splice(0, p.pendingInputs.length - 2);
    }

    this.advancePhase(dt, nowMs);
    this.match.step(dt, nowMs);
    this.enforceAntiCheat();

    // Reap stale connections and expired reconnect grace.
    for (const [entityId, rec] of [...this.clients]) {
      if (rec.disconnectedAtMs > 0) {
        if (nowMs - rec.disconnectedAtMs > RECONNECT_GRACE_MS) {
          this.clients.delete(entityId);
          this.match.removePlayer(entityId);
          this.broadcastPlayerList();
        }
        continue;
      }
      if (nowMs - rec.lastSeenMs > CLIENT_TIMEOUT_MS) {
        rec.conn.close(4008, 'timeout');
        this.leave(rec.conn.id, false);
      }
    }

    this.snapshotAccumulator += dt;
    const snapshotInterval = 1 / config.snapshotRate;
    if (this.snapshotAccumulator >= snapshotInterval) {
      this.snapshotAccumulator -= snapshotInterval;
      this.broadcastSnapshot(nowMs);
    }

    if (nowMs - this.lastStateBroadcast > 250) {
      this.lastStateBroadcast = nowMs;
      this.broadcastMatchState();
      this.flushKillFeed();
      this.flushNotices();
    }

    if (this.match.resultsPending) {
      this.match.resultsPending = false;
      void this.finishMatch(nowMs);
    }
  }

  private advancePhase(dt: number, nowMs: number): void {
    const m = this.match;
    switch (m.phase) {
      case MatchPhase.Warmup: {
        const active = m.activePlayerCount();
        if (active >= MIN_PLAYERS_TO_START && m.timeRemaining <= 0) {
          m.phase = MatchPhase.Countdown;
          this.countdown = COUNTDOWN_SECONDS;
          this.pushNotice('MATCH STARTING');
        }
        break;
      }
      case MatchPhase.Countdown: {
        this.countdown -= dt;
        m.timeRemaining = Math.max(0, this.countdown);
        if (this.countdown <= 0) {
          this.matchId = randomUUID();
          this.resultsSent = false;
          m.begin(nowMs);
        }
        break;
      }
      case MatchPhase.Ended: {
        if (m.endTimer <= 0) this.resetForNextMatch(nowMs);
        break;
      }
      default:
        break;
    }
  }

  private resetForNextMatch(nowMs: number): void {
    const rematchWanted = [...this.clients.values()].filter((c) => c.disconnectedAtMs === 0 && c.wantsRematch).length;
    const humans = this.humanCount;
    // Rotate the map unless everyone asked for a rematch on this one.
    if (humans === 0 || rematchWanted < Math.ceil(humans / 2)) {
      const maps = mapsForMode(this.cfg.mode === 'custom' ? 'tdm' : this.cfg.mode);
      const idx = maps.indexOf(this.cfg.map);
      this.cfg.map = maps[(idx + 1) % maps.length];
      this.match = new Match(this.matchOptions());
      // Re-add everyone to the new match instance.
      for (const rec of this.clients.values()) {
        const old = rec.entityId;
        const conn = rec.conn;
        const p = new ServerPlayer(old, conn.profileId, conn.name, defaultLoadoutFor('vanguard'));
        p.accountLevel = conn.accountLevel;
        p.banner = conn.banner;
        p.icon = conn.icon;
        this.match.addPlayer(p);
        this.sendJson(conn, { t: Msg.RoomState, room: this.summary(), mapChanged: true });
      }
      this.bots.clear();
      this.nextBotIndex = 0;
      this.ensureBots();
    } else {
      this.match = new Match(this.matchOptions());
      for (const rec of this.clients.values()) {
        const conn = rec.conn;
        const p = new ServerPlayer(rec.entityId, conn.profileId, conn.name, defaultLoadoutFor('vanguard'));
        p.accountLevel = conn.accountLevel;
        this.match.addPlayer(p);
      }
      this.bots.clear();
      this.nextBotIndex = 0;
      this.ensureBots();
    }
    for (const rec of this.clients.values()) rec.wantsRematch = false;
    this.killFeedCursor = 0;
    this.match.phase = MatchPhase.Warmup;
    this.match.timeRemaining = 3;
    this.rebalanceTeams();
    this.broadcastPlayerList();
    this.broadcastMatchState();
    void nowMs;
  }

  private enforceAntiCheat(): void {
    for (const [entityId, rec] of this.clients) {
      const p = this.match.getPlayer(entityId);
      if (!p) continue;
      if (p.suspicion >= SUSPICION_KICK_THRESHOLD) {
        logSuspicious({
          room: this.id,
          player: p.name,
          profileId: p.profileId,
          address: rec.conn.remoteAddress,
          suspicion: p.suspicion,
          violations: p.violations,
          action: 'kick',
        });
        this.sendJson(rec.conn, { t: Msg.Kicked, reason: 'Automated integrity check failed' });
        rec.conn.close(4010, 'integrity');
        this.leave(rec.conn.id, true);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Match completion
  // ---------------------------------------------------------------------

  private async finishMatch(nowMs: number): Promise<void> {
    if (this.resultsSent) return;
    this.resultsSent = true;
    const m = this.match;
    const durationSec = Math.max(1, (nowMs - m.startedAtMs) / 1000);
    const leader = m.rules.leader(m);
    const teams = getMode(this.cfg.mode === 'custom' ? 'tdm' : this.cfg.mode).teams;

    const rows = [];
    for (const p of m.playerList()) {
      if (p.spectating) continue;
      const won =
        teams === 2 ? m.winningTeam === p.team : leader ? leader.id === p.id : false;
      const drew = teams === 2 ? m.winningTeam === Team.None : false;
      const mvp = leader ? leader.id === p.id : false;
      let award: AwardResult | null = null;
      if (!p.bot) {
        try {
          award = await awardMatch(this.db, {
            player: p,
            mode: this.cfg.mode,
            map: this.cfg.map,
            durationSec,
            won,
            drew,
            mvp,
            matchId: this.matchId,
          });
        } catch (err) {
          // Never let a persistence failure block the results screen.
          // eslint-disable-next-line no-console
          console.error('[room] failed to award match', err);
        }
      }
      rows.push(buildResultRow(p, award, won, drew));
    }
    rows.sort((a, b) => b.score - a.score);

    const payload: MatchResultsPayload = {
      mode: this.cfg.mode,
      map: this.cfg.map,
      winningTeam: m.winningTeam,
      teamScores: [Math.round(m.teamScores[0]), Math.round(m.teamScores[1])],
      players: rows,
      durationSec: Math.round(durationSec),
      mvpId: leader ? leader.id : -1,
    };
    this.broadcastJson({ t: Msg.MatchResults, results: payload });
  }

  // ---------------------------------------------------------------------
  // Inbound messages
  // ---------------------------------------------------------------------

  handleBinary(connId: string, data: ArrayBuffer | Uint8Array): void {
    const entityId = this.byConnId.get(connId);
    if (entityId === undefined) return;
    const rec = this.clients.get(entityId);
    if (!rec) return;
    rec.lastSeenMs = Date.now();
    if (!this.checkRate(rec)) return;

    const type = packetTypeOf(data);
    if (type === PacketType.Input) {
      const decoded = decodeInput(data, inputScratch);
      if (!decoded) {
        const p = this.match.getPlayer(entityId);
        p?.flagSuspicion('bad-input-packet', 5);
        return;
      }
      const p = this.match.getPlayer(entityId);
      if (!p) return;
      for (const cmd of decoded.commands) {
        // Reject replayed or out-of-order sequences.
        if (cmd.seq <= p.highestSeq) continue;
        p.highestSeq = cmd.seq;
        p.pendingInputs.push({ ...cmd });
      }
      if (p.pendingInputs.length > 64) {
        p.pendingInputs.splice(0, p.pendingInputs.length - 32);
        p.flagSuspicion('input-backlog', 1);
      }
      return;
    }

    if (type === PacketType.TimeSync) {
      const ts = decodeTimeSync(data);
      if (!ts) return;
      rec.conn.send(encodeTimeSyncReply(ts.clientTimeMs, ts.id, Date.now() & 0xffffffff));
      return;
    }
  }

  handleJson(connId: string, raw: string): void {
    const entityId = this.byConnId.get(connId);
    if (entityId === undefined) return;
    const rec = this.clients.get(entityId);
    if (!rec) return;
    rec.lastSeenMs = Date.now();
    if (!this.checkRate(rec)) return;

    const parsed = validateJsonMessage(raw);
    if (!parsed.ok || !parsed.value) {
      const p = this.match.getPlayer(entityId);
      p?.flagSuspicion('bad-json', 3);
      return;
    }
    const msg = parsed.value;
    const p = this.match.getPlayer(entityId);
    if (!p) return;
    this.lastActivityMs = Date.now();

    switch (msg.t) {
      case Msg.SetLoadout: {
        const loadout = sanitiseLoadout(msg.loadout as Parameters<typeof sanitiseLoadout>[0]);
        p.applyLoadout(loadout);
        // Applying mid-life would let a player swap kit in a fight; only take
        // effect on the next spawn unless they are already dead or in warmup.
        if (!p.alive || this.match.phase === MatchPhase.Warmup) {
          this.match.applyModeWeapon(p);
          if (this.match.phase === MatchPhase.Warmup && p.alive) this.match.spawnPlayer(p, Date.now());
        }
        this.broadcastPlayerList();
        break;
      }
      case Msg.SetReady: {
        rec.wantsRematch = false;
        p.ready = readBool(msg, 'ready', false);
        this.broadcastPlayerList();
        break;
      }
      case Msg.SelectTeam: {
        const teams = getMode(this.cfg.mode === 'custom' ? 'tdm' : this.cfg.mode).teams;
        if (teams !== 2) break;
        const want = readNumber(msg, 'team', 0, 2, 0);
        if (want !== Team.Ion && want !== Team.Ember) break;
        const counts = [0, 0];
        for (const o of this.match.playerList()) {
          if (o.spectating || o.id === p.id) continue;
          if (o.team === Team.Ion) counts[0]++;
          else if (o.team === Team.Ember) counts[1]++;
        }
        const idx = want - 1;
        // Only allow a switch that does not make the teams more lopsided.
        if (counts[idx] <= counts[1 - idx]) {
          p.team = want;
          if (p.alive) this.match.spawnPlayer(p, Date.now());
          this.rebalanceTeams();
          this.broadcastPlayerList();
        } else {
          this.sendJson(rec.conn, { t: Msg.Notice, text: 'That team is full' });
        }
        break;
      }
      case Msg.Chat: {
        const text = sanitiseText(msg.text, MAX_CHAT_LENGTH);
        if (!text) break;
        const teamOnly = readBool(msg, 'teamOnly', false);
        const entry = {
          t: Msg.ChatMsg,
          from: p.name,
          fromId: p.id,
          team: p.team,
          teamOnly,
          text,
          timeMs: Date.now(),
        };
        for (const [otherId, other] of this.clients) {
          if (other.disconnectedAtMs > 0) continue;
          if (other.muted.has(p.id)) continue;
          const op = this.match.getPlayer(otherId);
          if (teamOnly && op && op.team !== p.team) continue;
          this.sendJson(other.conn, entry);
        }
        break;
      }
      case Msg.Ping: {
        const id = readNumber(msg, 'id', 0, 1e9, 0);
        const clientTime = readNumber(msg, 'clientTime', 0, Number.MAX_SAFE_INTEGER, 0);
        this.sendJson(rec.conn, { t: Msg.Pong, id, clientTime, serverTime: Date.now() });
        break;
      }
      case Msg.RequestSpawn: {
        if (!p.alive && p.respawnTimer <= 0 && this.match.rules.canRespawn(this.match, p)) {
          this.match.spawnPlayer(p, Date.now());
        }
        break;
      }
      case Msg.Mute: {
        const targetId = readNumber(msg, 'targetId', 0, 255, -1);
        const muted = readBool(msg, 'muted', true);
        if (targetId < 0) break;
        if (muted) rec.muted.add(targetId);
        else rec.muted.delete(targetId);
        this.sendJson(rec.conn, { t: Msg.Notice, text: muted ? 'Player muted' : 'Player unmuted' });
        break;
      }
      case Msg.Report: {
        const targetId = readNumber(msg, 'targetId', 0, 255, -1);
        const reason = readEnum(msg, 'reason', ['cheating', 'abuse', 'griefing', 'name', 'other'] as const, 'other');
        const note = readString(msg, 'note', 240);
        const target = targetId >= 0 ? this.match.getPlayer(targetId) : undefined;
        logSuspicious({
          room: this.id,
          player: target?.name ?? String(targetId),
          profileId: target?.profileId ?? 'unknown',
          address: 'n/a',
          suspicion: target?.suspicion ?? 0,
          violations: target?.violations ?? {},
          action: 'player-report',
          extra: { reporter: p.name, reason, note },
        });
        this.sendJson(rec.conn, { t: Msg.Notice, text: 'Report submitted. Thank you.' });
        break;
      }
      case Msg.Rematch: {
        rec.wantsRematch = readBool(msg, 'want', true);
        break;
      }
      case Msg.Emote: {
        const emote = readString(msg, 'emote', 40);
        if (emote) this.broadcastJson({ t: Msg.Notice, emote, fromId: p.id, silent: true });
        break;
      }
      case Msg.Spectate: {
        p.spectating = !p.spectating;
        if (p.spectating) {
          p.alive = false;
          p.pendingInputs.length = 0;
        } else if (this.match.phase === MatchPhase.Live) {
          this.match.spawnPlayer(p, Date.now());
        }
        this.broadcastPlayerList();
        break;
      }
      case Msg.LeaveRoom: {
        rec.conn.close(1000, 'left');
        this.leave(connId, true);
        break;
      }
      default:
        break;
    }
  }

  private checkRate(rec: ClientRecord): boolean {
    const now = Date.now();
    if (now - rec.msgWindowStart >= 1000) {
      rec.msgWindowStart = now;
      rec.msgCount = 0;
    }
    rec.msgCount++;
    if (rec.msgCount > config.antiCheat.msgRateLimit) {
      const p = this.match.getPlayer(rec.entityId);
      p?.flagSuspicion('rate-limit', 2);
      if (rec.msgCount > config.antiCheat.msgRateLimit * 3) {
        rec.conn.close(4009, 'rate limit');
        this.leave(rec.conn.id, true);
      }
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------

  private sendWelcome(conn: Connection, entityId: number): void {
    this.sendJson(conn, {
      t: Msg.Welcome,
      protocol: PROTOCOL_VERSION,
      entityId,
      room: this.summary(),
      mapId: this.cfg.map,
      mode: this.cfg.mode,
      tickRate: config.tickRate,
      snapshotRate: config.snapshotRate,
      serverTime: Date.now(),
      friendlyFire: this.cfg.friendlyFire,
      botDifficulty: this.cfg.botDifficulty,
    });
    this.sendJson(conn, { t: Msg.MatchState, state: this.match.matchState(Date.now()) });
    this.sendJson(conn, { t: Msg.PlayerList, players: this.playerStates() });
  }

  private playerStates(): PlayerPublicState[] {
    return this.match.playerList().map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      classId: p.classDef.id,
      bot: p.bot,
      ready: p.ready,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      score: Math.round(p.score),
      ping: p.ping,
      streak: p.streak,
      alive: p.alive,
      connected: p.connected,
      spectating: p.spectating,
      accountLevel: p.accountLevel,
      banner: p.banner,
      icon: p.icon,
      modeValue: p.modeValue,
    }));
  }

  private broadcastSnapshot(nowMs: number): void {
    const events = this.match.drainEvents();
    const entities: EntitySnapshot[] = [];
    for (const p of this.match.playerList()) {
      if (p.spectating) continue;
      entities.push({
        id: p.id,
        flags: p.entityFlags(nowMs),
        x: p.move.pos.x,
        y: p.move.pos.y,
        z: p.move.pos.z,
        vx: p.move.vel.x,
        vy: p.move.vel.y,
        vz: p.move.vel.z,
        yaw: p.move.yaw,
        pitch: p.move.pitch,
        health: Math.ceil(p.health),
        shield: Math.ceil(p.shield + p.overshield),
        weapon: weaponIdx(p),
        team: p.team,
      });
    }

    for (const [entityId, rec] of this.clients) {
      if (rec.disconnectedAtMs > 0) continue;
      if (rec.conn.readyState() !== 1) continue;
      const p = this.match.getPlayer(entityId);
      const self: SelfState | null = p
        ? {
            x: p.move.pos.x,
            y: p.move.pos.y,
            z: p.move.pos.z,
            vx: p.move.vel.x,
            vy: p.move.vel.y,
            vz: p.move.vel.z,
            health: Math.ceil(p.health),
            shield: Math.ceil(p.shield + p.overshield),
            flags: p.entityFlags(nowMs),
            ammo: p.weapon.ammo,
            reserve: p.weapon.reserve,
            slot: p.slot,
            abilityCharge: p.ability.charges > 0 ? 1 : p.ability.charge,
            ultimateCharge: p.ultimate.charges > 0 ? 1 : p.ultimate.charge,
          }
        : null;
      const packet = encodeSnapshot(
        this.match.tick,
        nowMs & 0xffffffff,
        p ? p.lastProcessedSeq : 0,
        self,
        entities,
        events,
      );
      // encodeSnapshot returns a view over a shared buffer, so copy per send.
      rec.conn.send(packet.slice());
    }
  }

  private broadcastMatchState(): void {
    this.broadcastJson({ t: Msg.MatchState, state: this.match.matchState(Date.now()) });
    this.broadcastPlayerList();
  }

  private broadcastPlayerList(): void {
    this.broadcastJson({ t: Msg.PlayerList, players: this.playerStates() });
  }

  private flushKillFeed(): void {
    const feed = this.match.killFeed;
    const fresh: KillFeedEntry[] = [];
    for (const entry of feed) {
      if (entry.id > this.killFeedCursor) fresh.push(entry);
    }
    if (fresh.length === 0) return;
    this.killFeedCursor = fresh[fresh.length - 1].id;
    this.broadcastJson({ t: Msg.KillFeed, entries: fresh });
  }

  private flushNotices(): void {
    if (this.match.notices.length === 0) return;
    const notices = this.match.notices.splice(0, this.match.notices.length);
    for (const text of notices) this.broadcastJson({ t: Msg.Notice, text });
  }

  private pushNotice(text: string): void {
    this.broadcastJson({ t: Msg.Notice, text });
  }

  broadcastJson(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    for (const rec of this.clients.values()) {
      if (rec.disconnectedAtMs > 0) continue;
      if (rec.conn.readyState() !== 1) continue;
      rec.conn.send(data);
    }
  }

  private sendJson(conn: Connection, payload: Record<string, unknown>): void {
    if (conn.readyState() !== 1) return;
    conn.send(JSON.stringify(payload));
  }

  /** Called by the manager when a client's measured RTT changes. */
  setPing(connId: string, ping: number): void {
    const entityId = this.byConnId.get(connId);
    if (entityId === undefined) return;
    const p = this.match.getPlayer(entityId);
    if (p) p.ping = Math.round(ping);
  }

  updateAccountLevel(connId: string, xp: number): void {
    const entityId = this.byConnId.get(connId);
    if (entityId === undefined) return;
    const p = this.match.getPlayer(entityId);
    if (p) p.accountLevel = levelFromXp(xp).level;
  }

  close(reason: string): void {
    this.closed = true;
    for (const rec of this.clients.values()) {
      this.sendJson(rec.conn, { t: Msg.Kicked, reason });
      rec.conn.close(1001, reason);
    }
    this.clients.clear();
    this.byConnId.clear();
    this.bots.clear();
  }

  get ageMs(): number {
    return Date.now() - this.createdAtMs;
  }

  /** Change the map/mode from the lobby (custom rooms only). */
  reconfigure(patch: Partial<RoomConfig>): void {
    if (patch.mode && isModeId(patch.mode)) this.cfg.mode = patch.mode;
    if (patch.map && isMapId(patch.map)) this.cfg.map = patch.map;
    if (typeof patch.botCount === 'number') this.cfg.botCount = Math.max(0, Math.min(31, patch.botCount));
    if (patch.botDifficulty) this.cfg.botDifficulty = patch.botDifficulty;
    if (typeof patch.friendlyFire === 'boolean') this.cfg.friendlyFire = patch.friendlyFire;
    if (typeof patch.scoreLimit === 'number') this.cfg.scoreLimit = patch.scoreLimit;
    if (typeof patch.timeLimitSec === 'number') this.cfg.timeLimitSec = patch.timeLimitSec;
    if (patch.name) this.cfg.name = sanitiseName(patch.name, 28) || this.cfg.name;
    this.match = new Match(this.matchOptions());
    for (const rec of this.clients.values()) {
      const conn = rec.conn;
      const p = new ServerPlayer(rec.entityId, conn.profileId, conn.name, defaultLoadoutFor('vanguard'));
      p.accountLevel = conn.accountLevel;
      this.match.addPlayer(p);
    }
    this.bots.clear();
    this.nextBotIndex = 0;
    this.ensureBots();
    this.match.phase = MatchPhase.Warmup;
    this.match.timeRemaining = 3;
    this.broadcastJson({ t: Msg.RoomState, room: this.summary(), mapChanged: true });
    this.broadcastMatchState();
  }
}

function weaponIdx(p: ServerPlayer): number {
  return weaponIndex(p.weapon.def.id);
}

export function generateRoomCode(existing: (code: string) => boolean): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!existing(code)) return code;
  }
  return randomUUID().slice(0, ROOM_CODE_LENGTH).toUpperCase();
}

export { MATCH_END_SECONDS };
