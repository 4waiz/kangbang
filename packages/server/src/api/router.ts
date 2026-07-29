/**
 * REST API.
 *
 * A tiny hand-rolled router rather than a framework: the surface is ~15 routes
 * and avoiding a dependency keeps the container small and the request path
 * obvious.  Every route validates its inputs and every write requires a token.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ACHIEVEMENTS,
  CLASSES,
  CLASS_ORDER,
  COSMETICS,
  MODE_ORDER,
  MODES,
  PERKS,
  PROTOCOL_VERSION,
  WEAPONS,
  WEAPON_ORDER,
  accuracy,
  activeChallenges,
  coerceBindings,
  coerceSettings,
  defaultUnlockedCosmetics,
  evaluateAchievements,
  headshotRate,
  kdRatio,
  levelFromXp,
  mapSummaries,
  masteryProgress,
  sanitiseName,
  scorePerMinute,
  winRate,
  type LoadoutSelection,
} from '@neon/shared';
import { config, isOriginAllowed } from '../config.js';
import type { Database, LeaderboardMetric } from '../db/index.js';
import { log } from '../logger.js';
import type { RoomManager } from '../net/roomManager.js';
import { extractToken, issueToken, newGuestId, verifyToken } from './tokens.js';

const MAX_BODY_BYTES = 64 * 1024;

const LEADERBOARD_METRICS: LeaderboardMetric[] = ['xp', 'kills', 'score', 'kd', 'wins', 'headshotRate', 'accuracy'];

export interface ApiRouter {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createApiRouter(db: Database, rooms: RoomManager): ApiRouter {
  const startedAt = Date.now();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    applyCors(res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (origin && !isOriginAllowed(origin)) {
      json(res, 403, { error: 'origin not allowed' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/api/health') return json(res, 200, health());
      if (path === '/api/meta') return json(res, 200, meta());
      if (path === '/api/rooms' && req.method === 'GET') {
        return json(res, 200, { rooms: rooms.listRooms(false) });
      }
      if (path === '/api/guest' && req.method === 'POST') return await guest(req, res);
      if (path === '/api/profile' && req.method === 'GET') return await getProfile(req, res, url);
      if (path === '/api/profile' && req.method === 'PATCH') return await patchProfile(req, res);
      if (path === '/api/profile/settings' && req.method === 'PUT') return await putSettings(req, res);
      if (path === '/api/profile/loadouts' && req.method === 'PUT') return await putLoadouts(req, res);
      if (path === '/api/profile/cosmetics' && req.method === 'PUT') return await putCosmetics(req, res);
      if (path === '/api/profile/matches' && req.method === 'GET') return await getMatches(req, res, url);
      if (path === '/api/profile/challenges' && req.method === 'GET') return await getChallenges(req, res);
      if (path === '/api/profile/achievements' && req.method === 'GET') return await getAchievements(req, res);
      if (path === '/api/leaderboard' && req.method === 'GET') return await getLeaderboard(req, res, url);

      // Static client (single-container deployments).
      if (config.serveClient) {
        const served = await serveStatic(path, res);
        if (served) return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('api', 'unhandled error', { path, error: String(err) });
      json(res, 500, { error: 'internal error' });
    }
  }

  // -------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------

  function health() {
    return {
      ok: true,
      name: 'NEON STRIKE',
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rooms: rooms.roomCount(),
      players: rooms.playerCount(),
      tickRate: config.tickRate,
      snapshotRate: config.snapshotRate,
      avgTickMs: Math.round(rooms.averageTickMs() * 100) / 100,
      db: db.driver,
      env: config.env,
    };
  }

  /** Everything the client needs to render menus without hard-coding data. */
  function meta() {
    return {
      protocol: PROTOCOL_VERSION,
      modes: MODE_ORDER.map((id) => {
        const m = MODES[id];
        return {
          id: m.id,
          name: m.name,
          short: m.short,
          description: m.description,
          teams: m.teams,
          scoreLimit: m.scoreLimit,
          timeLimitSec: m.timeLimitSec,
          icon: m.icon,
          quickPlay: m.quickPlay,
          hud: m.hud,
          defaultBots: m.defaultBots,
        };
      }),
      maps: mapSummaries(),
      classes: CLASS_ORDER.map((id) => {
        const c = CLASSES[id];
        return {
          id: c.id,
          name: c.name,
          role: c.role,
          tagline: c.tagline,
          description: c.description,
          unlockLevel: c.unlockLevel,
          health: c.health,
          shield: c.shield,
          speed: Math.round(c.move.speedScale * 100),
          passive: c.passive,
          ability: c.ability,
          ultimate: c.ultimate,
          preferredCategories: c.preferredCategories,
          defaultLoadout: c.defaultLoadout,
          visual: c.visual,
        };
      }),
      weapons: WEAPON_ORDER.map((id) => {
        const w = WEAPONS[id];
        return {
          id: w.id,
          name: w.name,
          short: w.short,
          category: w.category,
          slot: w.slot,
          fireMode: w.fireMode,
          description: w.description,
          unlockLevel: w.unlockLevel,
          damage: w.damage,
          rpm: w.rpm,
          magazine: w.magazine,
          reserve: w.reserve,
          reloadTime: w.reloadTime,
          range: w.falloffEnd,
          headshotMultiplier: w.headshotMultiplier,
          moveScale: w.moveScale,
          pellets: w.pellets,
          icon: w.icon,
          perkSlots: w.perkSlots,
          classes: w.classes,
        };
      }),
      perks: Object.values(PERKS).map((p) => ({
        id: p.id,
        name: p.name,
        slot: p.slot,
        description: p.description,
        unlockLevel: p.unlockLevel,
        icon: p.icon,
      })),
      cosmetics: Object.values(COSMETICS).map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        rarity: c.rarity,
        description: c.description,
        unlock: c.unlock ?? null,
        color: c.color ?? null,
        accent: c.accent ?? null,
        emissive: c.emissive ?? null,
        pattern: c.pattern ?? null,
        crosshair: c.crosshair ?? null,
        glyph: c.glyph ?? null,
        effect: c.effect ?? null,
        anim: c.anim ?? null,
      })),
      achievements: ACHIEVEMENTS.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        target: a.target,
        tier: a.tier,
        xpReward: a.xpReward,
        unlocks: a.unlocks ?? null,
      })),
    };
  }

  async function guest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (body === null) return json(res, 400, { error: 'invalid body' });

    // An existing guest can present their previous id to keep progression.
    let id = typeof body.id === 'string' && /^g_[A-Za-z0-9_-]{8,32}$/.test(body.id) ? body.id : '';
    if (id) {
      const existing = await db.getProfile(id);
      if (!existing) id = '';
    }
    if (!id) id = newGuestId();

    const requested = sanitiseName(body.name, 16);
    const name = requested || `Recruit${id.slice(-4)}`;
    const profile = await db.ensureProfile(id, name, true);
    if (requested && profile.name !== requested) {
      await db.setName(id, requested);
      profile.name = requested;
    }
    if (profile.cosmetics.unlocked.length === 0) {
      profile.cosmetics.unlocked = defaultUnlockedCosmetics();
      await db.saveProfile(profile);
    }
    const token = issueToken(profile.id, profile.name, true);
    return json(res, 200, { token, profile: publicProfile(profile) });
  }

  async function authed(req: IncomingMessage, url?: URL) {
    const token = extractToken(req.headers.authorization, url?.searchParams.get('token') ?? null);
    const claims = verifyToken(token);
    if (!claims) return null;
    const profile = await db.getProfile(claims.sub);
    return profile ? { claims, profile } : null;
  }

  async function getProfile(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = await authed(req, url);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    return json(res, 200, { profile: publicProfile(auth.profile) });
  }

  async function patchProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await authed(req);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const body = await readJsonBody(req);
    if (body === null) return json(res, 400, { error: 'invalid body' });
    const { profile } = auth;

    if (typeof body.name === 'string') {
      const name = sanitiseName(body.name, 16);
      if (name.length < 2) return json(res, 400, { error: 'Name must be at least 2 characters' });
      profile.name = name;
    }
    if (typeof body.banner === 'string' && COSMETICS[body.banner] && profile.cosmetics.unlocked.includes(body.banner)) {
      profile.banner = body.banner;
    }
    if (typeof body.icon === 'string' && COSMETICS[body.icon] && profile.cosmetics.unlocked.includes(body.icon)) {
      profile.icon = body.icon;
    }
    await db.saveProfile(profile);
    return json(res, 200, { profile: publicProfile(profile) });
  }

  async function putSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await authed(req);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const body = await readJsonBody(req);
    if (body === null) return json(res, 400, { error: 'invalid body' });
    auth.profile.settings = coerceSettings(body.settings);
    auth.profile.bindings = coerceBindings(body.bindings);
    await db.saveProfile(auth.profile);
    return json(res, 200, { settings: auth.profile.settings, bindings: auth.profile.bindings });
  }

  async function putLoadouts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await authed(req);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const body = await readJsonBody(req);
    if (body === null || typeof body.loadouts !== 'object' || body.loadouts === null) {
      return json(res, 400, { error: 'invalid body' });
    }
    const out: Record<string, LoadoutSelection> = {};
    for (const [classId, raw] of Object.entries(body.loadouts as Record<string, unknown>)) {
      if (!CLASSES[classId]) continue;
      out[classId] = sanitiseLoadoutPayload(raw, classId);
    }
    auth.profile.loadouts = out;
    await db.saveProfile(auth.profile);
    return json(res, 200, { loadouts: out });
  }

  async function putCosmetics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await authed(req);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const body = await readJsonBody(req);
    if (body === null || typeof body.equipped !== 'object' || body.equipped === null) {
      return json(res, 400, { error: 'invalid body' });
    }
    const equipped: Record<string, string> = {};
    for (const [slot, id] of Object.entries(body.equipped as Record<string, unknown>)) {
      if (typeof id !== 'string') continue;
      const def = COSMETICS[id];
      if (!def) continue;
      // Only equip what the player has actually unlocked.
      if (def.unlock && !auth.profile.cosmetics.unlocked.includes(id)) continue;
      equipped[slot.slice(0, 32)] = id;
    }
    auth.profile.cosmetics.equipped = equipped;
    await db.saveProfile(auth.profile);
    return json(res, 200, { equipped });
  }

  async function getMatches(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = await authed(req, url);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const limit = clampInt(url.searchParams.get('limit'), 1, 50, 20);
    const matches = await db.recentMatches(auth.profile.id, limit);
    return json(res, 200, { matches });
  }

  async function getChallenges(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await authed(req);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const list = activeChallenges(auth.profile.id, Date.now()).map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description,
      period: c.period,
      target: c.target,
      xpReward: c.xpReward,
      progress: Math.min(c.target, auth.profile.challengeProgress[c.key] ?? 0),
      claimed: auth.profile.challengesClaimed.includes(c.key),
    }));
    return json(res, 200, { challenges: list });
  }

  async function getAchievements(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = await authed(req);
    if (!auth) return json(res, 401, { error: 'unauthorised' });
    const { progress } = evaluateAchievements(auth.profile.counters, new Set(auth.profile.achievements));
    return json(res, 200, { achievements: progress });
  }

  async function getLeaderboard(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const raw = url.searchParams.get('metric') ?? 'xp';
    const metric = (LEADERBOARD_METRICS.includes(raw as LeaderboardMetric) ? raw : 'xp') as LeaderboardMetric;
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 50);
    const entries = await db.leaderboard(metric, limit);
    let myRank = 0;
    const auth = await authed(req, url);
    if (auth) myRank = await db.playerRank(auth.profile.id, metric);
    return json(res, 200, { metric, entries, myRank, totalPlayers: await db.playerCount() });
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publicProfile(p: Awaited<ReturnType<Database['getProfile']>>) {
  if (!p) return null;
  const level = levelFromXp(p.xp);
  const weaponMastery: Record<string, ReturnType<typeof masteryProgress>> = {};
  for (const [id, row] of Object.entries(p.weaponStats)) {
    weaponMastery[id] = masteryProgress(row.masteryXp, WEAPONS[id]?.masteryStep ?? 900);
  }
  const classMastery: Record<string, ReturnType<typeof masteryProgress>> = {};
  for (const [id, row] of Object.entries(p.classStats)) {
    classMastery[id] = masteryProgress(row.masteryXp, CLASSES[id]?.masteryStep ?? 1200);
  }
  return {
    id: p.id,
    name: p.name,
    guest: p.guest,
    xp: p.xp,
    level: level.level,
    levelProgress: level.progress,
    xpIntoLevel: level.xpIntoLevel,
    xpForNext: level.xpForNext,
    createdAt: p.createdAt,
    settings: p.settings,
    bindings: p.bindings,
    loadouts: p.loadouts,
    cosmetics: p.cosmetics,
    banner: p.banner,
    icon: p.icon,
    totals: p.totals,
    derived: {
      kd: round2(kdRatio(p.totals)),
      accuracy: round2(accuracy(p.totals) * 100),
      headshotRate: round2(headshotRate(p.totals) * 100),
      winRate: round2(winRate(p.totals) * 100),
      scorePerMinute: round2(scorePerMinute(p.totals)),
    },
    weaponStats: p.weaponStats,
    classStats: p.classStats,
    weaponMastery,
    classMastery,
    achievements: p.achievements,
  };
}

function sanitiseLoadoutPayload(raw: unknown, classId: string): LoadoutSelection {
  const cls = CLASSES[classId];
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pickWeapon = (value: unknown, slot: 'primary' | 'secondary' | 'melee'): string => {
    if (typeof value === 'string' && WEAPONS[value] && WEAPONS[value].slot === slot) return value;
    return cls.defaultLoadout[slot];
  };
  const perks = Array.isArray(obj.perks)
    ? (obj.perks as unknown[]).filter((p): p is string => typeof p === 'string' && !!PERKS[p]).slice(0, 8)
    : [];
  const skins: Record<string, string> = {};
  if (typeof obj.skins === 'object' && obj.skins !== null) {
    for (const [k, v] of Object.entries(obj.skins as Record<string, unknown>)) {
      if (typeof v === 'string' && COSMETICS[v]) skins[k.slice(0, 32)] = v;
    }
  }
  const pickCosmetic = (value: unknown): string | undefined =>
    typeof value === 'string' && COSMETICS[value] ? value : undefined;
  return {
    classId,
    primary: pickWeapon(obj.primary, 'primary'),
    secondary: pickWeapon(obj.secondary, 'secondary'),
    melee: pickWeapon(obj.melee, 'melee'),
    perks,
    skins,
    charm: pickCosmetic(obj.charm),
    killEffect: pickCosmetic(obj.killEffect),
    banner: pickCosmetic(obj.banner),
    icon: pickCosmetic(obj.icon),
    bodyColor: pickCosmetic(obj.bodyColor),
    armorVariant: pickCosmetic(obj.armorVariant),
    crosshair: pickCosmetic(obj.crosshair),
  };
}

function applyCors(res: ServerResponse, origin: string | undefined): void {
  const allow = origin && isOriginAllowed(origin) ? origin : config.corsOrigins[0] ?? '*';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Optional static file serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
};

async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
  const root = resolve(process.cwd(), config.clientDist);
  // Normalise and confine to the dist root: no path traversal.
  const rel = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (rel.startsWith('..')) return false;
  let file = join(root, rel);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    // SPA fallback so deep links work.
    file = join(root, 'index.html');
  }
  if (!file.startsWith(root)) return false;
  try {
    const data = await readFile(file);
    const ext = extname(file).toLowerCase();
    const immutable = /\.[0-9a-f]{8,}\./i.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
