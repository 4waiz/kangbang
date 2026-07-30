/**
 * Network connection.
 *
 * Owns the WebSocket, the handshake, the input send loop, snapshot decoding and
 * clock synchronisation. Exposes plain callbacks rather than an event emitter so
 * the game loop's data flow stays traceable.
 *
 * Clock sync: we measure RTT with binary time-sync packets and keep the lowest
 * observed offset (the sample least affected by queueing delay). Render time is
 * `serverTime - INTERP_DELAY`, which is what makes remote interpolation smooth.
 */

import {
  INTERP_DELAY,
  MAX_INPUTS_PER_PACKET,
  Msg,
  PROTOCOL_VERSION,
  PacketType,
  createSnapshot,
  decodeSnapshot,
  decodeTimeSync,
  encodeInput,
  encodeTimeSync,
  packetTypeOf,
  type InputCommand,
  type KillFeedEntry,
  type MatchResultsPayload,
  type MatchStatePayload,
  type PlayerPublicState,
  type Snapshot,
} from '@kang/shared';
import { store } from '../state/store.js';
import { WS_URL } from './api.js';

export type ConnectionState = 'idle' | 'connecting' | 'handshaking' | 'joining' | 'live' | 'closed' | 'error';

export interface JoinOptions {
  mode?: string;
  map?: string;
  roomId?: string;
  code?: string;
  create?: boolean;
  privateRoom?: boolean;
  config?: Record<string, unknown>;
  loadout?: unknown;
}

export interface WelcomePayload {
  entityId: number;
  mapId: string;
  mode: string;
  tickRate: number;
  snapshotRate: number;
  room: Record<string, unknown>;
  friendlyFire: boolean;
  botDifficulty: string;
}

export interface ChatEntry {
  from: string;
  fromId: number;
  team: number;
  teamOnly: boolean;
  text: string;
  timeMs: number;
}

export interface ConnectionHandlers {
  onState(state: ConnectionState, detail?: string): void;
  onWelcome(payload: WelcomePayload): void;
  onSnapshot(snapshot: Snapshot): void;
  onMatchState(state: MatchStatePayload): void;
  onPlayerList(players: PlayerPublicState[]): void;
  onKillFeed(entries: KillFeedEntry[]): void;
  onChat(entry: ChatEntry): void;
  onNotice(text: string, extra?: Record<string, unknown>): void;
  onResults(results: MatchResultsPayload): void;
  onRoomState(room: Record<string, unknown>, mapChanged: boolean): void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private snapshot: Snapshot = createSnapshot();
  private handlers: ConnectionHandlers;
  private stateValue: ConnectionState = 'idle';

  /** Unsent + unacknowledged inputs, replayed by the predictor. */
  readonly pendingInputs: InputCommand[] = [];
  private nextSeq = 1;
  private lastAck = 0;

  /** Clock sync. */
  private clockOffsetMs = 0;
  private bestRtt = Infinity;
  private rttSamples: number[] = [];
  private syncId = 1;
  private syncTimer: number | null = null;
  private pendingSync = new Map<number, number>();

  /** Diagnostics surfaced by the net graph. */
  pingMs = 0;
  jitterMs = 0;
  packetsIn = 0;
  packetsOut = 0;
  bytesIn = 0;
  bytesOut = 0;
  snapshotGapMs = 0;
  private lastSnapshotAt = 0;
  private joinOptions: JoinOptions = {};
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;

  constructor(handlers: ConnectionHandlers) {
    this.handlers = handlers;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.handlers.onState(state, detail);
  }

  // ---------------------------------------------------------------------

  connect(options: JoinOptions): void {
    this.joinOptions = options;
    this.intentionalClose = false;
    this.open();
  }

  private open(): void {
    this.close(true);
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      this.setState('error', String(err));
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.setState('handshaking');
      this.sendJson({
        t: Msg.Hello,
        protocol: PROTOCOL_VERSION,
        token: store.token,
        name: store.name || 'Recruit',
      });
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.bytesIn += ev.data.length;
        this.handleJson(ev.data);
      } else {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        this.bytesIn += buf.byteLength;
        this.handleBinary(buf);
      }
    };

    ws.onclose = (ev) => {
      this.stopSync();
      if (this.intentionalClose) {
        this.setState('closed');
        return;
      }
      // 4001 = protocol mismatch, 4002 = auth: retrying will not help.
      if (ev.code === 4001 || ev.code === 4002 || ev.code === 4010) {
        this.setState('error', ev.reason || 'connection refused');
        return;
      }
      this.setState('closed', ev.reason);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; keep the message for the UI.
      this.setState('error', 'network error');
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= 5) return;
    const delay = Math.min(8000, 700 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  close(silent = false): void {
    this.intentionalClose = !silent;
    this.stopSync();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'client leaving');
        else ws.close();
      } catch {
        /* already closed */
      }
    }
    if (!silent) this.setState('idle');
  }

  // ---------------------------------------------------------------------

  private handleJson(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.t) {
      case Msg.Joined: {
        this.setState('joining');
        this.sendJson({
          t: Msg.JoinRoom,
          mode: this.joinOptions.mode,
          map: this.joinOptions.map,
          roomId: this.joinOptions.roomId,
          code: this.joinOptions.code,
          create: this.joinOptions.create,
          privateRoom: this.joinOptions.privateRoom,
          config: this.joinOptions.config,
          loadout: this.joinOptions.loadout,
        });
        break;
      }
      case Msg.Welcome: {
        this.reconnectAttempts = 0;
        this.setState('live');
        this.startSync();
        this.handlers.onWelcome({
          entityId: Number(msg.entityId ?? 0),
          mapId: String(msg.mapId ?? 'neon_foundry'),
          mode: String(msg.mode ?? 'tdm'),
          tickRate: Number(msg.tickRate ?? 60),
          snapshotRate: Number(msg.snapshotRate ?? 20),
          room: (msg.room ?? {}) as Record<string, unknown>,
          friendlyFire: Boolean(msg.friendlyFire),
          botDifficulty: String(msg.botDifficulty ?? 'normal'),
        });
        break;
      }
      case Msg.Rejected: {
        this.setState('error', String(msg.reason ?? 'rejected'));
        break;
      }
      case Msg.Kicked: {
        this.intentionalClose = true;
        this.setState('error', String(msg.reason ?? 'removed from match'));
        break;
      }
      case Msg.MatchState:
        this.handlers.onMatchState(msg.state as MatchStatePayload);
        break;
      case Msg.PlayerList:
        this.handlers.onPlayerList(msg.players as PlayerPublicState[]);
        break;
      case Msg.KillFeed:
        this.handlers.onKillFeed(msg.entries as KillFeedEntry[]);
        break;
      case Msg.ChatMsg:
        this.handlers.onChat({
          from: String(msg.from ?? ''),
          fromId: Number(msg.fromId ?? 0),
          team: Number(msg.team ?? 0),
          teamOnly: Boolean(msg.teamOnly),
          text: String(msg.text ?? ''),
          timeMs: Number(msg.timeMs ?? Date.now()),
        });
        break;
      case Msg.Notice:
        this.handlers.onNotice(String(msg.text ?? ''), msg);
        break;
      case Msg.MatchResults:
        this.handlers.onResults(msg.results as MatchResultsPayload);
        break;
      case Msg.RoomState:
        this.handlers.onRoomState((msg.room ?? {}) as Record<string, unknown>, Boolean(msg.mapChanged));
        break;
      case Msg.Pong: {
        const clientTime = Number(msg.clientTime ?? 0);
        if (clientTime > 0) this.recordRtt(performance.now() - clientTime, Number(msg.serverTime ?? 0));
        break;
      }
      default:
        break;
    }
  }

  private handleBinary(data: Uint8Array): void {
    const type = packetTypeOf(data);
    if (type === PacketType.Snapshot) {
      const snap = decodeSnapshot(data, this.snapshot);
      if (!snap) return;
      this.packetsIn++;
      const now = performance.now();
      if (this.lastSnapshotAt > 0) {
        const gap = now - this.lastSnapshotAt;
        this.snapshotGapMs = this.snapshotGapMs * 0.85 + gap * 0.15;
      }
      this.lastSnapshotAt = now;
      this.lastAck = snap.ackSeq;
      // Drop inputs the server has already applied.
      while (this.pendingInputs.length > 0 && this.pendingInputs[0].seq <= snap.ackSeq) {
        this.pendingInputs.shift();
      }
      this.handlers.onSnapshot(snap);
      return;
    }
    if (type === PacketType.TimeSyncReply) {
      const ts = decodeTimeSync(data);
      if (!ts) return;
      const sentAt = this.pendingSync.get(ts.id);
      if (sentAt === undefined) return;
      this.pendingSync.delete(ts.id);
      this.recordRtt(performance.now() - sentAt, ts.serverTimeMs);
    }
  }

  private recordRtt(rtt: number, serverTimeMs: number): void {
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return;
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > 20) this.rttSamples.shift();
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    this.pingMs = sorted[Math.floor(sorted.length / 2)];
    this.jitterMs = sorted.length > 2 ? sorted[sorted.length - 1] - sorted[0] : 0;
    if (rtt < this.bestRtt && serverTimeMs > 0) {
      this.bestRtt = rtt;
      // The reply left the server roughly rtt/2 ago.
      this.clockOffsetMs = serverTimeMs + rtt / 2 - performance.now();
    }
    // Let the best sample age out so a route change is picked up.
    this.bestRtt *= 1.0006;
  }

  private startSync(): void {
    this.stopSync();
    const tick = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const id = this.syncId++;
      this.pendingSync.set(id, performance.now());
      if (this.pendingSync.size > 8) {
        // Drop the oldest outstanding probe.
        const first = this.pendingSync.keys().next().value;
        if (first !== undefined) this.pendingSync.delete(first);
      }
      this.sendBinary(encodeTimeSync(Math.round(performance.now()), id));
    };
    tick();
    this.syncTimer = window.setInterval(tick, 1200);
  }

  private stopSync(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingSync.clear();
  }

  /** Best estimate of the server clock, in the server's ms timebase. */
  serverTimeMs(): number {
    return performance.now() + this.clockOffsetMs;
  }

  /** The time remote entities should be rendered at. */
  renderTimeMs(): number {
    return this.serverTimeMs() - INTERP_DELAY * 1000;
  }

  // ---------------------------------------------------------------------

  /** Queue an input and immediately send the unacknowledged window. */
  sendInput(cmd: Omit<InputCommand, 'seq'>): InputCommand {
    const full: InputCommand = { ...cmd, seq: this.nextSeq++ };
    this.pendingInputs.push(full);
    // Cap the replay window; beyond this the player is so far behind that a
    // hard correction is preferable to a long replay.
    if (this.pendingInputs.length > 180) this.pendingInputs.shift();
    const window = this.pendingInputs.slice(-MAX_INPUTS_PER_PACKET);
    this.sendBinary(encodeInput(window, Math.round(performance.now())));
    return full;
  }

  get acknowledgedSeq(): number {
    return this.lastAck;
  }

  sendJson(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(payload);
    this.bytesOut += text.length;
    this.packetsOut++;
    ws.send(text);
  }

  private sendBinary(data: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.bytesOut += data.byteLength;
    this.packetsOut++;
    ws.send(data);
  }

  // -- convenience senders ------------------------------------------------

  setLoadout(loadout: unknown): void {
    this.sendJson({ t: Msg.SetLoadout, loadout });
  }

  setReady(ready: boolean): void {
    this.sendJson({ t: Msg.SetReady, ready });
  }

  selectTeam(team: number): void {
    this.sendJson({ t: Msg.SelectTeam, team });
  }

  chat(text: string, teamOnly: boolean): void {
    this.sendJson({ t: Msg.Chat, text, teamOnly });
  }

  requestSpawn(): void {
    this.sendJson({ t: Msg.RequestSpawn });
  }

  mute(targetId: number, muted: boolean): void {
    this.sendJson({ t: Msg.Mute, targetId, muted });
  }

  report(targetId: number, reason: string, note: string): void {
    this.sendJson({ t: Msg.Report, targetId, reason, note });
  }

  rematch(want: boolean): void {
    this.sendJson({ t: Msg.Rematch, want });
  }

  emote(emote: string): void {
    this.sendJson({ t: Msg.Emote, emote });
  }

  spectate(targetId = -1): void {
    this.sendJson({ t: Msg.Spectate, targetId });
  }

  leave(): void {
    this.sendJson({ t: Msg.LeaveRoom });
    this.close();
  }
}
