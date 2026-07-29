/**
 * Structured logging.
 *
 * Suspicious-behaviour events are emitted as single-line JSON so they can be
 * shipped to a log aggregator without a parser. Nothing sensitive is logged:
 * no tokens, no secrets, and IP addresses only for integrity events.
 */

import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = config.isProd ? LEVEL_ORDER.info : LEVEL_ORDER.debug;

function emit(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const line = { ts: new Date().toISOString(), level, scope, message, ...extra };
  const text = config.isProd ? JSON.stringify(line) : `[${scope}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(text);
  // eslint-disable-next-line no-console
  else if (level === 'warn') console.warn(text);
  // eslint-disable-next-line no-console
  else console.log(text);
}

export const log = {
  debug: (scope: string, message: string, extra?: Record<string, unknown>) => emit('debug', scope, message, extra),
  info: (scope: string, message: string, extra?: Record<string, unknown>) => emit('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: Record<string, unknown>) => emit('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: Record<string, unknown>) => emit('error', scope, message, extra),
};

export interface SuspiciousEvent {
  room: string;
  player: string;
  profileId: string;
  address: string;
  suspicion: number;
  violations: Record<string, number>;
  action: string;
  extra?: Record<string, unknown>;
}

export function logSuspicious(event: SuspiciousEvent): void {
  if (!config.antiCheat.logSuspicious) return;
  emit('warn', 'anticheat', event.action, {
    room: event.room,
    player: event.player,
    profileId: event.profileId,
    address: event.address,
    suspicion: Math.round(event.suspicion),
    violations: event.violations,
    ...(event.extra ?? {}),
  });
}
