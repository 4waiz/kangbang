/**
 * HTTP + WebSocket transport.
 *
 * The WebSocket handshake carries a guest/session token; the socket is not
 * attached to a room until the client sends a valid `hello` + `join`. Origin is
 * checked on upgrade so a hostile page cannot drive a session from a browser.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_NAME_LENGTH,
  Msg,
  PROTOCOL_VERSION,
  WS_PATH,
  levelFromXp,
  sanitiseName,
  validateJsonMessage,
} from '@kang/shared';
import { config, isOriginAllowed } from '../config.js';
import type { Database } from '../db/index.js';
import { log } from '../logger.js';
import { createApiRouter } from '../api/router.js';
import { verifyToken } from '../api/tokens.js';
import { RoomManager } from './roomManager.js';
import type { Connection } from './room.js';

interface PendingSocket {
  id: string;
  ws: WebSocket;
  profileId: string;
  name: string;
  accountLevel: number;
  banner: string;
  icon: string;
  helloDone: boolean;
  createdAtMs: number;
  remoteAddress: string;
}

export interface GameServer {
  close(): Promise<void>;
  readonly port: number;
  readonly rooms: RoomManager;
}

export async function startServer(db: Database): Promise<GameServer> {
  const rooms = new RoomManager(db);
  const api = createApiRouter(db, rooms);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void api.handle(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16 });
  const pending = new Map<string, PendingSocket>();
  /** When the last ping frame was sent, per connection, for RTT measurement. */
  const pingSentAt = new Map<string, number>();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined)) {
      log.warn('ws', 'rejected upgrade from disallowed origin', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const id = randomUUID();
    const remoteAddress = normaliseAddress(req);
    // Tag the socket so the heartbeat can attribute RTT back to this id.
    (ws as WebSocket & { __neonId?: string }).__neonId = id;
    const record: PendingSocket = {
      id,
      ws,
      profileId: '',
      name: '',
      accountLevel: 1,
      banner: 'banner_grid',
      icon: 'icon_recruit',
      helloDone: false,
      createdAtMs: Date.now(),
      remoteAddress,
    };
    pending.set(id, record);

    const conn: Connection = {
      id,
      get profileId() {
        return record.profileId;
      },
      get name() {
        return record.name;
      },
      get accountLevel() {
        return record.accountLevel;
      },
      get banner() {
        return record.banner;
      },
      get icon() {
        return record.icon;
      },
      send(data) {
        if (ws.readyState !== ws.OPEN) return;
        try {
          ws.send(data);
        } catch {
          /* socket closing */
        }
      },
      close(code, reason) {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      },
      readyState() {
        return ws.readyState;
      },
      remoteAddress,
    };

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const room = rooms.roomForConnection(id);
        if (!room) return;
        const buf = raw as Buffer;
        room.handleBinary(id, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return;
      }

      const text = raw.toString('utf8');
      const room = rooms.roomForConnection(id);
      if (room) {
        room.handleJson(id, text);
        return;
      }

      // Pre-room handshake: hello then join.
      const parsed = validateJsonMessage(text);
      if (!parsed.ok || !parsed.value) {
        sendJson(ws, { t: Msg.Rejected, reason: 'malformed handshake' });
        ws.close(4000, 'bad handshake');
        return;
      }
      const msg = parsed.value;

      if (msg.t === Msg.Hello) {
        if (msg.protocol !== PROTOCOL_VERSION) {
          sendJson(ws, {
            t: Msg.Rejected,
            reason: `Protocol mismatch. Server speaks v${PROTOCOL_VERSION}. Reload the page.`,
            protocol: PROTOCOL_VERSION,
          });
          ws.close(4001, 'protocol');
          return;
        }
        const token = typeof msg.token === 'string' ? msg.token : '';
        const claims = token ? verifyToken(token) : null;
        if (!claims) {
          sendJson(ws, { t: Msg.Rejected, reason: 'Session expired. Reload to continue.' });
          ws.close(4002, 'auth');
          return;
        }
        record.profileId = claims.sub;
        const requestedName = sanitiseName(msg.name, MAX_NAME_LENGTH);
        void (async () => {
          const profile = await db.ensureProfile(claims.sub, requestedName || claims.name, claims.guest);
          record.name = profile.name || requestedName || 'Recruit';
          record.accountLevel = levelFromXp(profile.xp).level;
          record.banner = profile.banner;
          record.icon = profile.icon;
          record.helloDone = true;
          sendJson(ws, {
            t: Msg.Joined,
            profileId: profile.id,
            name: record.name,
            accountLevel: record.accountLevel,
            protocol: PROTOCOL_VERSION,
          });
        })();
        return;
      }

      if (msg.t === Msg.JoinRoom) {
        if (!record.helloDone) {
          sendJson(ws, { t: Msg.Rejected, reason: 'Say hello first' });
          return;
        }
        const target = rooms.resolveRoom({
          mode: typeof msg.mode === 'string' ? msg.mode : undefined,
          map: typeof msg.map === 'string' ? msg.map : undefined,
          roomId: typeof msg.roomId === 'string' ? msg.roomId : undefined,
          code: typeof msg.code === 'string' ? msg.code : undefined,
          create: msg.create === true,
          privateRoom: msg.privateRoom === true,
          custom: (msg.config ?? undefined) as never,
        });
        if (!target) {
          sendJson(ws, { t: Msg.Rejected, reason: 'No room available. Try creating one.' });
          return;
        }
        const entityId = rooms.attach(conn, target, msg.loadout);
        if (entityId === 0) {
          sendJson(ws, { t: Msg.Rejected, reason: 'Room is full' });
          return;
        }
        pending.delete(id);
        return;
      }

      sendJson(ws, { t: Msg.Rejected, reason: 'Unexpected message before join' });
    });

    ws.on('close', () => {
      pending.delete(id);
      pingSentAt.delete(id);
      rooms.detach(id, false);
    });

    ws.on('error', (err) => {
      log.debug('ws', 'socket error', { error: String(err) });
    });

    ws.on('pong', () => {
      const room = rooms.roomForConnection(id);
      if (!room) return;
      const sent = pingSentAt.get(id);
      if (sent !== undefined) room.setPing(id, Date.now() - sent);
    });
  });

  // Application-level heartbeat: measures RTT and prunes dead sockets.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) continue;
      const tagged = client as WebSocket & { __neonId?: string };
      if (tagged.__neonId) pingSentAt.set(tagged.__neonId, now);
      try {
        client.ping();
      } catch {
        /* ignore */
      }
    }
    for (const [id, rec] of pending) {
      // A socket that never completes the handshake is dropped.
      if (now - rec.createdAtMs > 20000) {
        rec.ws.close(4003, 'handshake timeout');
        pending.delete(id);
      }
    }
  }, 5000);

  rooms.start();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  log.info('server', `KANG BANG server listening on http://${config.host}:${port}`, {
    db: db.driver,
    tickRate: config.tickRate,
    snapshotRate: config.snapshotRate,
  });

  return {
    port,
    rooms,
    async close() {
      clearInterval(heartbeat);
      rooms.stop();
      for (const client of wss.clients) {
        try {
          client.close(1001, 'shutdown');
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* socket closing */
  }
}

function normaliseAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}
