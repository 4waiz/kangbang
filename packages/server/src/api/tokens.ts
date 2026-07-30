/**
 * Session tokens.
 *
 * Deliberately minimal: an HMAC-signed, URL-safe payload. It carries only the
 * profile id, display name and a guest flag - no permissions, no secrets - so
 * the worst a leaked token can do is let someone play as that profile until it
 * expires.  Swapping this for real OAuth/JWT later only touches this file plus
 * the two routes in router.ts that mint tokens.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export interface TokenClaims {
  /** Profile id. */
  sub: string;
  name: string;
  guest: boolean;
  /** Issued-at, ms. */
  iat: number;
  /** Expiry, ms. */
  exp: number;
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function issueToken(sub: string, name: string, guest: boolean): string {
  const now = Date.now();
  const claims: TokenClaims = { sub, name, guest, iat: now, exp: now + TOKEN_TTL_MS };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): TokenClaims | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(payload);
  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 64) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Opaque, collision-resistant guest id. */
export function newGuestId(): string {
  return `g_${randomBytes(12).toString('base64url')}`;
}

/**
 * Read a bearer token from the Authorization header or a `token` query param.
 *
 * The scheme name is matched case-insensitively, as RFC 7235 requires: a client
 * sending `bearer <token>` must not be silently downgraded to anonymous.
 */
export function extractToken(authHeader: string | undefined, queryToken: string | null): string {
  if (authHeader && authHeader.length > 7 && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
    return authHeader.slice(7).trim();
  }
  return queryToken ?? '';
}
