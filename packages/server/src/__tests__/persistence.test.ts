/**
 * Persistence and session-token tests.
 *
 * The Database contract is exercised twice - once against the in-memory driver
 * (guest / no-config mode) and once against the real `node:sqlite` driver on a
 * temporary file - so the two cannot drift. Postgres implements the same
 * interface and is covered by the same expectations in CI where a server is
 * available; see DEPLOYMENT.md.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levelFromXp } from '@kang/shared';
import { MemoryDatabase } from '../db/memory.js';
import { SqliteDatabase } from '../db/sqlite.js';
import { emptyClassStats, emptyWeaponStats, metricValue, meetsLeaderboardMinimum } from '../db/types.js';
import type { Database, MatchRecord, PlayerProfile } from '../db/types.js';
import { extractToken, issueToken, newGuestId, verifyToken } from '../api/tokens.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'kang-db-'));
let dbFileSeq = 0;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function matchRecord(over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: `match-${Math.round(over.playedAt ?? 0)}-${over.playerId ?? 'p'}`,
    playerId: 'p1',
    mode: 'tdm',
    map: 'neon_foundry',
    classId: 'vanguard',
    kills: 10,
    deaths: 4,
    assists: 2,
    score: 1500,
    damage: 2000,
    headshots: 3,
    shotsFired: 120,
    shotsHit: 48,
    won: true,
    drew: false,
    mvp: false,
    xpEarned: 900,
    durationSec: 480,
    playedAt: 1_700_000_000_000,
    ...over,
  };
}

/** Give a profile a career good enough to appear on every leaderboard. */
function seedCareer(p: PlayerProfile, kills: number, deaths: number): PlayerProfile {
  p.xp = kills * 200;
  p.totals.kills = kills;
  p.totals.deaths = deaths;
  p.totals.score = kills * 150;
  p.totals.wins = Math.floor(kills / 10);
  p.totals.matchesPlayed = Math.max(1, Math.floor(kills / 5));
  p.totals.shotsFired = kills * 40;
  p.totals.shotsHit = kills * 14;
  p.totals.headshots = kills * 3;
  return p;
}

// ---------------------------------------------------------------------------
// The same contract, run against every driver.
// ---------------------------------------------------------------------------

const drivers: { name: string; make: () => Database }[] = [
  { name: 'memory', make: () => new MemoryDatabase() },
  { name: 'sqlite', make: () => new SqliteDatabase(join(tmpRoot, `t${dbFileSeq++}.db`)) },
];

for (const driver of drivers) {
  describe(`${driver.name} driver`, () => {
    let db: Database;

    beforeEach(async () => {
      db = driver.make();
      await db.init();
    });

    afterEach(async () => {
      await db.close();
    });

    it('is idempotent to initialise', async () => {
      await expect(db.init()).resolves.not.toThrow();
    });

    it('returns null for a profile that does not exist', async () => {
      expect(await db.getProfile('nobody')).toBeNull();
    });

    it('creates a guest profile with sane defaults', async () => {
      const p = await db.ensureProfile('guest-1', 'Runner', true);
      expect(p.id).toBe('guest-1');
      expect(p.name).toBe('Runner');
      expect(p.guest).toBe(true);
      expect(p.xp).toBe(0);
      expect(p.email).toBeNull();
      expect(p.passwordHash).toBeNull();
      expect(p.totals.kills).toBe(0);
      expect(Array.isArray(p.achievements)).toBe(true);
      expect(p.cosmetics.unlocked.length).toBeGreaterThan(0);
      expect(levelFromXp(p.xp).level).toBe(1);
    });

    it('returns the same profile on a second ensure, not a fresh one', async () => {
      const first = await db.ensureProfile('guest-1', 'Runner', true);
      first.xp = 5000;
      await db.saveProfile(first);
      const second = await db.ensureProfile('guest-1', 'Runner', true);
      expect(second.xp).toBe(5000);
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('round-trips every field of a profile', async () => {
      const p = await db.ensureProfile('p1', 'Tester', false);
      p.email = 'tester@example.com';
      p.passwordHash = 'not-a-real-hash';
      p.xp = 123_456;
      p.lastWinDay = '2026-07-30';
      p.banner = 'banner_circuit';
      p.icon = 'icon_ace';
      p.settings = { sensitivity: 2.5, fov: 106, colorblindMode: 'deuteranopia' };
      p.bindings = { forward: 'KeyI', jump: 'KeyN' };
      p.loadouts = { vanguard: { primary: 'burst_carbine', secondary: 'tactical_revolver', melee: 'plasma_blade' } };
      p.cosmetics = { unlocked: ['skin_default', 'trail_ion'], equipped: { skin: 'skin_default', trail: 'trail_ion' } };
      p.counters = { kills: 40, headshots: 9, objectiveCaptures: 3 };
      p.achievements = ['first_blood', 'kills_100'];
      p.challengesClaimed = ['2026-07-30:daily:kills'];
      p.challengeProgress = { '2026-07-30:daily:kills': 7 };
      p.weaponStats = { pulse_ar: { ...emptyWeaponStats(), kills: 22, headshots: 5, masteryXp: 3300 } };
      p.classStats = { vanguard: { ...emptyClassStats(), matches: 6, wins: 4, masteryXp: 2100 } };
      seedCareer(p, 40, 25);
      p.xp = 123_456; // seedCareer derives xp from kills; the explicit value wins.
      await db.saveProfile(p);

      const back = await db.getProfile('p1');
      expect(back).not.toBeNull();
      expect(back!.email).toBe('tester@example.com');
      expect(back!.passwordHash).toBe('not-a-real-hash');
      expect(back!.xp).toBe(123_456);
      expect(back!.lastWinDay).toBe('2026-07-30');
      expect(back!.banner).toBe('banner_circuit');
      expect(back!.icon).toBe('icon_ace');
      expect(back!.settings).toEqual(p.settings);
      expect(back!.bindings).toEqual(p.bindings);
      expect(back!.loadouts).toEqual(p.loadouts);
      expect(back!.cosmetics).toEqual(p.cosmetics);
      expect(back!.counters).toEqual(p.counters);
      expect(back!.achievements.sort()).toEqual(['first_blood', 'kills_100']);
      expect(back!.challengesClaimed).toEqual(p.challengesClaimed);
      expect(back!.challengeProgress).toEqual(p.challengeProgress);
      expect(back!.weaponStats.pulse_ar.kills).toBe(22);
      expect(back!.classStats.vanguard.wins).toBe(4);
      expect(back!.totals.kills).toBe(40);
      expect(back!.guest).toBe(false);
    });

    it('does not let one profile see another profile s data', async () => {
      const a = await db.ensureProfile('a', 'A', true);
      a.xp = 999;
      await db.saveProfile(a);
      const b = await db.ensureProfile('b', 'B', true);
      expect(b.xp).toBe(0);
      expect((await db.getProfile('a'))!.xp).toBe(999);
    });

    it('finds a registered profile by email, case-insensitively', async () => {
      const p = await db.ensureProfile('p1', 'Tester', false);
      p.email = 'Mixed.Case@Example.COM'.toLowerCase();
      await db.saveProfile(p);
      expect((await db.findProfileByEmail('mixed.case@example.com'))?.id).toBe('p1');
      expect((await db.findProfileByEmail('MIXED.CASE@EXAMPLE.COM'))?.id).toBe('p1');
      expect(await db.findProfileByEmail('someone@else.com')).toBeNull();
    });

    it('never returns a guest profile from an email lookup', async () => {
      await db.ensureProfile('guest-1', 'Guest', true);
      expect(await db.findProfileByEmail('')).toBeNull();
    });

    it('renames a profile without touching anything else', async () => {
      const p = await db.ensureProfile('p1', 'Old', true);
      p.xp = 4321;
      await db.saveProfile(p);
      await db.setName('p1', 'New');
      const back = await db.getProfile('p1');
      expect(back!.name).toBe('New');
      expect(back!.xp).toBe(4321);
    });

    it('stores match history newest first and honours the limit', async () => {
      await db.ensureProfile('p1', 'Tester', true);
      for (let i = 0; i < 12; i++) {
        await db.recordMatch(matchRecord({ playerId: 'p1', playedAt: 1000 + i * 1000, kills: i }));
      }
      const recent = await db.recentMatches('p1', 5);
      expect(recent).toHaveLength(5);
      expect(recent[0].kills).toBe(11);
      for (let i = 1; i < recent.length; i++) {
        expect(recent[i].playedAt).toBeLessThanOrEqual(recent[i - 1].playedAt);
      }
      expect(await db.recentMatches('p1', 100)).toHaveLength(12);
      expect(await db.recentMatches('someone-else', 10)).toHaveLength(0);
    });

    it('preserves every field of a match record', async () => {
      await db.ensureProfile('p1', 'Tester', true);
      const rec = matchRecord({ playerId: 'p1', mode: 'domination', map: 'mirage_district', drew: true, won: false, mvp: true });
      await db.recordMatch(rec);
      const [back] = await db.recentMatches('p1', 1);
      expect(back.mode).toBe('domination');
      expect(back.map).toBe('mirage_district');
      expect(back.won).toBe(false);
      expect(back.drew).toBe(true);
      expect(back.mvp).toBe(true);
      expect(back.xpEarned).toBe(rec.xpEarned);
      expect(back.durationSec).toBe(rec.durationSec);
      expect(back.shotsHit).toBe(rec.shotsHit);
    });

    it('ranks the leaderboard by the requested metric', async () => {
      const seeds: [string, number, number][] = [
        ['low', 20, 40],
        ['mid', 60, 40],
        ['high', 200, 50],
      ];
      for (const [id, kills, deaths] of seeds) {
        const p = await db.ensureProfile(id, id.toUpperCase(), true);
        await db.saveProfile(seedCareer(p, kills, deaths));
      }
      const byKills = await db.leaderboard('kills', 10);
      expect(byKills.map((e) => e.name)).toEqual(['HIGH', 'MID', 'LOW']);
      expect(byKills[0].value).toBe(200);
      expect(byKills[0].rank).toBe(1);
      expect(byKills[2].rank).toBe(3);
      expect(byKills[0].level).toBe(levelFromXp(200 * 200).level);

      const byXp = await db.leaderboard('xp', 10);
      expect(byXp[0].name).toBe('HIGH');
      const byKd = await db.leaderboard('kd', 10);
      expect(byKd[0].name).toBe('HIGH');
    });

    it('honours the leaderboard limit', async () => {
      for (let i = 0; i < 8; i++) {
        const p = await db.ensureProfile(`p${i}`, `P${i}`, true);
        await db.saveProfile(seedCareer(p, 10 + i * 5, 10));
      }
      expect(await db.leaderboard('kills', 3)).toHaveLength(3);
    });

    it('keeps thin careers off the ratio boards', async () => {
      const rookie = await db.ensureProfile('rookie', 'Rookie', true);
      rookie.xp = 100;
      rookie.totals.kills = 1;
      rookie.totals.deaths = 0;
      rookie.totals.matchesPlayed = 1;
      rookie.totals.shotsFired = 3;
      rookie.totals.shotsHit = 1;
      rookie.totals.headshots = 1;
      await db.saveProfile(rookie);
      const veteran = await db.ensureProfile('vet', 'Vet', true);
      await db.saveProfile(seedCareer(veteran, 300, 200));

      const kd = await db.leaderboard('kd', 10);
      expect(kd.map((e) => e.name)).not.toContain('Rookie');
      expect(kd.map((e) => e.name)).toContain('Vet');
      const acc = await db.leaderboard('accuracy', 10);
      expect(acc.map((e) => e.name)).not.toContain('Rookie');
    });

    it('reports a player rank, and 0 when unranked', async () => {
      for (const [id, kills] of [
        ['a', 300],
        ['b', 200],
        ['c', 100],
      ] as [string, number][]) {
        const p = await db.ensureProfile(id, id, true);
        await db.saveProfile(seedCareer(p, kills, 100));
      }
      expect(await db.playerRank('a', 'kills')).toBe(1);
      expect(await db.playerRank('b', 'kills')).toBe(2);
      expect(await db.playerRank('c', 'kills')).toBe(3);
      expect(await db.playerRank('ghost', 'kills')).toBe(0);
    });

    it('counts players', async () => {
      expect(await db.playerCount()).toBe(0);
      await db.ensureProfile('a', 'A', true);
      await db.ensureProfile('b', 'B', true);
      await db.ensureProfile('a', 'A', true);
      expect(await db.playerCount()).toBe(2);
    });

    it('survives absurd values without corrupting the row', async () => {
      const p = await db.ensureProfile('p1', 'Tester', true);
      p.xp = Number.MAX_SAFE_INTEGER;
      p.totals.damageDealt = 1e12;
      p.name = 'ünïcödé 名前 🎯';
      await db.saveProfile(p);
      const back = await db.getProfile('p1');
      expect(back!.xp).toBe(Number.MAX_SAFE_INTEGER);
      expect(back!.name).toBe('ünïcödé 名前 🎯');
      expect(levelFromXp(back!.xp).level).toBeGreaterThan(1);
    });
  });
}

describe('sqlite durability', () => {
  it('persists across a close and reopen', async () => {
    const path = join(tmpRoot, 'durable.db');
    const first = new SqliteDatabase(path);
    await first.init();
    const p = await first.ensureProfile('p1', 'Tester', true);
    p.xp = 77_000;
    p.achievements = ['first_blood'];
    await first.saveProfile(p);
    await first.recordMatch(matchRecord({ playerId: 'p1' }));
    await first.close();

    const second = new SqliteDatabase(path);
    await second.init();
    const back = await second.getProfile('p1');
    expect(back!.xp).toBe(77_000);
    expect(back!.achievements).toEqual(['first_blood']);
    expect(await second.recentMatches('p1', 10)).toHaveLength(1);
    await second.close();
  });

  it('creates the parent directory for a nested database path', async () => {
    const db = new SqliteDatabase(join(tmpRoot, 'nested', 'deeper', 'game.db'));
    await expect(db.init()).resolves.not.toThrow();
    await db.ensureProfile('p1', 'Tester', true);
    expect(await db.playerCount()).toBe(1);
    await db.close();
  });
});

describe('leaderboard metric helpers', () => {
  const profile = (over: Partial<PlayerProfile['totals']>, xp = 0): PlayerProfile => ({
    id: 'x',
    name: 'X',
    email: null,
    passwordHash: null,
    guest: true,
    xp,
    createdAt: 0,
    lastSeenAt: 0,
    settings: {},
    bindings: {},
    loadouts: {},
    cosmetics: { unlocked: [], equipped: {} },
    totals: {
      kills: 0,
      deaths: 0,
      assists: 0,
      shotsFired: 0,
      shotsHit: 0,
      headshots: 0,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      damageDealt: 0,
      timePlayedSec: 0,
      score: 0,
      longestStreak: 0,
      ...over,
    },
    counters: {},
    weaponStats: {},
    classStats: {},
    achievements: [],
    challengesClaimed: [],
    challengeProgress: {},
    lastWinDay: null,
    banner: 'banner_grid',
    icon: 'icon_recruit',
  });

  it('computes each metric', () => {
    expect(metricValue(profile({}, 5000), 'xp')).toBe(5000);
    expect(metricValue(profile({ kills: 12 }), 'kills')).toBe(12);
    expect(metricValue(profile({ score: 900 }), 'score')).toBe(900);
    expect(metricValue(profile({ wins: 4 }), 'wins')).toBe(4);
    expect(metricValue(profile({ kills: 10, deaths: 5 }), 'kd')).toBe(2);
    expect(metricValue(profile({ shotsHit: 100, headshots: 25 }), 'headshotRate')).toBeCloseTo(0.25, 6);
    expect(metricValue(profile({ shotsFired: 200, shotsHit: 50 }), 'accuracy')).toBeCloseTo(0.25, 6);
  });

  it('never divides by zero', () => {
    expect(metricValue(profile({ kills: 7, deaths: 0 }), 'kd')).toBe(7);
    expect(metricValue(profile({}), 'headshotRate')).toBe(0);
    expect(metricValue(profile({}), 'accuracy')).toBe(0);
  });

  it('enforces a minimum sample per ratio metric', () => {
    expect(meetsLeaderboardMinimum(profile({ kills: 1, deaths: 0 }), 'kd')).toBe(false);
    expect(meetsLeaderboardMinimum(profile({ kills: 20, deaths: 20 }), 'kd')).toBe(true);
    expect(meetsLeaderboardMinimum(profile({ shotsHit: 10 }), 'headshotRate')).toBe(false);
    expect(meetsLeaderboardMinimum(profile({ shotsHit: 500 }), 'headshotRate')).toBe(true);
    expect(meetsLeaderboardMinimum(profile({ shotsFired: 100 }), 'accuracy')).toBe(false);
    expect(meetsLeaderboardMinimum(profile({ shotsFired: 900 }), 'accuracy')).toBe(true);
    // Absolute metrics only need one match played.
    expect(meetsLeaderboardMinimum(profile({}), 'kills')).toBe(false);
    expect(meetsLeaderboardMinimum(profile({ matchesPlayed: 1 }), 'kills')).toBe(true);
  });
});

describe('session tokens', () => {
  it('round-trips the claims it was issued with', () => {
    const token = issueToken('profile-123', 'Runner', true);
    const claims = verifyToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('profile-123');
    expect(claims!.name).toBe('Runner');
    expect(claims!.guest).toBe(true);
  });

  it('is URL-safe so it can travel in a query string', () => {
    const token = issueToken('profile-123', 'Runner', false);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('rejects a tampered payload', () => {
    const token = issueToken('profile-123', 'Runner', true);
    const [payload, sig] = token.split('.');
    // Flip a character in the payload; the signature must no longer match.
    const flipped = (payload[0] === 'a' ? 'b' : 'a') + payload.slice(1);
    expect(verifyToken(`${flipped}.${sig}`)).toBeNull();
    expect(verifyToken(`${payload}.${sig.slice(0, -1)}x`)).toBeNull();
  });

  it('rejects an unsigned or malformed token', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('garbage')).toBeNull();
    expect(verifyToken('a.b.c.d')).toBeNull();
    expect(verifyToken('.')).toBeNull();
    // A payload with a valid shape but no signature must not be accepted.
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', name: 'admin', guest: false })).toString('base64url');
    expect(verifyToken(`${forged}.`)).toBeNull();
    expect(verifyToken(forged)).toBeNull();
  });

  it('does not carry a password hash or email in the payload', () => {
    const token = issueToken('profile-123', 'Runner', false);
    const decoded = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    expect(decoded).not.toMatch(/password|hash|email/i);
  });

  it('mints unique guest ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = newGuestId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it('extracts a token from a bearer header or a query parameter', () => {
    expect(extractToken('Bearer abc123', null)).toBe('abc123');
    expect(extractToken('bearer abc123', null)).toBe('abc123');
    expect(extractToken(undefined, 'q-token')).toBe('q-token');
    // An explicit header wins over the query string.
    expect(extractToken('Bearer header-token', 'query-token')).toBe('header-token');
    expect(extractToken(undefined, null)).toBe('');
    expect(extractToken('Basic abc', null)).toBe('');
  });
});
