/**
 * Server configuration, read once from the environment.
 *
 * Every knob has a working default so `npm run dev:server` needs no .env at
 * all; production overrides come from real environment variables (see
 * .env.example).  Secrets are never written back out or logged.
 */

import { randomBytes } from 'node:crypto';
import { MAX_PLAYERS, SNAPSHOT_RATE, TICK_RATE } from '@neon/shared';

function num(name: string, fallback: number, lo = -Infinity, hi = Infinity): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const isProd = str('NODE_ENV', 'development') === 'production';

let sessionSecret = str('SESSION_SECRET', '');
if (!sessionSecret) {
  if (isProd) {
    // Fail loudly rather than silently signing tokens with a known value.
    throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
  }
  sessionSecret = randomBytes(32).toString('base64url');
  // eslint-disable-next-line no-console
  console.warn('[config] SESSION_SECRET not set - generated an ephemeral dev secret');
}

export const config = {
  env: str('NODE_ENV', 'development'),
  isProd,
  host: str('HOST', '0.0.0.0'),
  port: Math.round(num('PORT', 2567, 1, 65535)),

  tickRate: Math.round(num('TICK_RATE', TICK_RATE, 20, 120)),
  snapshotRate: Math.round(num('SNAPSHOT_RATE', SNAPSHOT_RATE, 10, 60)),
  maxRooms: Math.round(num('MAX_ROOMS', 64, 1, 512)),
  maxPlayersPerRoom: Math.round(num('MAX_PLAYERS_PER_ROOM', MAX_PLAYERS, 2, 32)),

  corsOrigins: str('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  sessionSecret,

  db: {
    driver: str('DB_DRIVER', 'sqlite') as 'sqlite' | 'postgres' | 'memory',
    sqlitePath: str('SQLITE_PATH', './data/neonstrike.db'),
    url: str('DATABASE_URL', ''),
  },

  antiCheat: {
    moveTolerance: num('MOVE_TOLERANCE', 1.05, 1, 4),
    msgRateLimit: Math.round(num('MSG_RATE_LIMIT', 180, 20, 2000)),
    logSuspicious: bool('LOG_SUSPICIOUS', true),
  },

  bots: {
    fill: bool('BOT_FILL', true),
    fillTarget: Math.round(num('BOT_FILL_TARGET', 8, 0, 31)),
    difficulty: str('BOT_DIFFICULTY', 'normal') as 'easy' | 'normal' | 'hard',
  },

  /** Serve the built client from the server process (single-container deploys). */
  serveClient: bool('SERVE_CLIENT', false),
  clientDist: str('CLIENT_DIST', '../client/dist'),
} as const;

export type Config = typeof config;

/** True when the origin is allowed to open a WebSocket / call the REST API. */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients (bots, tests, curl)
  if (config.corsOrigins.includes('*')) return true;
  if (config.corsOrigins.includes(origin)) return true;
  if (!config.isProd) {
    // Local development: any loopback port is fine.
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  }
  return false;
}
