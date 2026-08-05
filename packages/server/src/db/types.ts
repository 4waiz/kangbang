/**
 * Persistence abstraction.
 *
 * One interface, three implementations:
 *   memory   - tests and ephemeral servers
 *   sqlite   - local development (Node's built-in node:sqlite, zero native deps)
 *   postgres - production (lazy-loads `pg`, so it is not required to run locally)
 *
 * Everything is keyed by an opaque `playerId`.  Guests get a generated id
 * persisted in the browser, so progression survives refreshes without an
 * account; wiring real auth later means issuing the same ids from a login flow.
 */

import { DEFAULT_COSMETICS, defaultUnlockedCosmetics } from '@kang/shared';
import type { CareerTotals, StatCounter } from '@kang/shared';

export interface PlayerProfile {
  id: string;
  name: string;
  /** null for guests. */
  email: string | null;
  /** Argon2/bcrypt hash placeholder; null for guests. */
  passwordHash: string | null;
  guest: boolean;
  xp: number;
  createdAt: number;
  lastSeenAt: number;
  /** JSON blobs, validated on read. */
  settings: Record<string, unknown>;
  bindings: Record<string, string>;
  loadouts: Record<string, unknown>;
  cosmetics: {
    unlocked: string[];
    equipped: Record<string, string>;
  };
  totals: CareerTotals;
  counters: Partial<Record<StatCounter, number>>;
  weaponStats: Record<string, WeaponStatRow>;
  classStats: Record<string, ClassStatRow>;
  achievements: string[];
  challengeProgress: Record<string, number>;
  challengesClaimed: string[];
  /** Day key of the last recorded win, for the first-win-of-day bonus. */
  lastWinDay: string | null;
  banner: string;
  icon: string;
}

export interface WeaponStatRow {
  kills: number;
  deaths: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  damage: number;
  masteryXp: number;
  timeUsedSec: number;
}

export interface ClassStatRow {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  score: number;
  masteryXp: number;
  timePlayedSec: number;
}

export interface MatchRecord {
  id: string;
  playerId: string;
  mode: string;
  map: string;
  classId: string;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  damage: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  won: boolean;
  drew: boolean;
  mvp: boolean;
  xpEarned: number;
  durationSec: number;
  playedAt: number;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  value: number;
  rank: number;
  level: number;
  icon: string;
  banner: string;
}

export type LeaderboardMetric = 'xp' | 'kills' | 'score' | 'kd' | 'wins' | 'headshotRate' | 'accuracy';

export interface Database {
  readonly driver: string;
  init(): Promise<void>;
  close(): Promise<void>;

  getProfile(id: string): Promise<PlayerProfile | null>;
  /** Create if missing; used by the guest flow and by tests. */
  ensureProfile(id: string, name: string, guest: boolean): Promise<PlayerProfile>;
  saveProfile(profile: PlayerProfile): Promise<void>;
  findProfileByEmail(email: string): Promise<PlayerProfile | null>;
  /** Rename with uniqueness handled by the caller. */
  setName(id: string, name: string): Promise<void>;

  recordMatch(record: MatchRecord): Promise<void>;
  recentMatches(playerId: string, limit: number): Promise<MatchRecord[]>;

  leaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardEntry[]>;
  /** Rank of a single player for a metric, 1-based; 0 when unranked. */
  playerRank(playerId: string, metric: LeaderboardMetric): Promise<number>;

  /** Total registered profiles - shown on the main menu. */
  playerCount(): Promise<number>;
}

export function emptyTotals(): CareerTotals {
  return {
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
  };
}

export function emptyWeaponStats(): WeaponStatRow {
  return { kills: 0, deaths: 0, headshots: 0, shotsFired: 0, shotsHit: 0, damage: 0, masteryXp: 0, timeUsedSec: 0 };
}

export function emptyClassStats(): ClassStatRow {
  return { matches: 0, wins: 0, kills: 0, deaths: 0, score: 0, masteryXp: 0, timePlayedSec: 0 };
}

export function newProfile(id: string, name: string, guest: boolean, now: number): PlayerProfile {
  return {
    id,
    name,
    email: null,
    passwordHash: null,
    guest,
    xp: 0,
    createdAt: now,
    lastSeenAt: now,
    settings: {},
    bindings: {},
    loadouts: {},
    // The free cosmetics are owned from the start, so a fresh profile is already
    // internally consistent: everything it has equipped, it also owns.
    cosmetics: { unlocked: defaultUnlockedCosmetics(), equipped: { ...DEFAULT_COSMETICS } },
    totals: emptyTotals(),
    counters: {},
    weaponStats: {},
    classStats: {},
    achievements: [],
    challengeProgress: {},
    challengesClaimed: [],
    lastWinDay: null,
    banner: 'banner_grid',
    icon: 'icon_recruit',
  };
}

function record<T>(v: unknown): Record<string, T> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Force a profile read back from storage into the shape the rest of the server
 * assumes.  Every driver runs its rows through this on the way out.
 *
 * This exists because a JSON column and a TypeScript interface cannot be kept
 * in sync by the type system: a column default of `'{}'`, a row written by an
 * older schema, or a blob truncated by hand all deserialise to something that
 * type-checks as `PlayerProfile` and then throws on first property access.
 * Repairing on read means such a row degrades to defaults instead of 500ing,
 * and the next `saveProfile` writes the repaired shape back.
 */
export function normaliseProfile(p: PlayerProfile): PlayerProfile {
  const cosmetics = record<unknown>(p.cosmetics);
  p.cosmetics = {
    unlocked: stringList(cosmetics.unlocked),
    equipped: record<string>(cosmetics.equipped),
  };
  // A profile must own whatever it can equip, or the equip endpoints reject the
  // cosmetics the menu is already showing.
  if (p.cosmetics.unlocked.length === 0) p.cosmetics.unlocked = defaultUnlockedCosmetics();
  if (Object.keys(p.cosmetics.equipped).length === 0) p.cosmetics.equipped = { ...DEFAULT_COSMETICS };

  p.totals = { ...emptyTotals(), ...record<number>(p.totals) };
  p.settings = record<unknown>(p.settings);
  p.bindings = record<string>(p.bindings);
  p.loadouts = record<unknown>(p.loadouts);
  p.counters = record<number>(p.counters);
  p.weaponStats = record<WeaponStatRow>(p.weaponStats);
  p.classStats = record<ClassStatRow>(p.classStats);
  p.challengeProgress = record<number>(p.challengeProgress);
  p.achievements = stringList(p.achievements);
  p.challengesClaimed = stringList(p.challengesClaimed);
  return p;
}

/** Metric extraction shared by every driver so ordering is consistent. */
export function metricValue(p: PlayerProfile, metric: LeaderboardMetric): number {
  const t = p.totals;
  switch (metric) {
    case 'xp':
      return p.xp;
    case 'kills':
      return t.kills;
    case 'score':
      return t.score;
    case 'wins':
      return t.wins;
    case 'kd':
      return t.deaths === 0 ? t.kills : t.kills / t.deaths;
    case 'headshotRate':
      return t.shotsHit === 0 ? 0 : t.headshots / t.shotsHit;
    case 'accuracy':
      return t.shotsFired === 0 ? 0 : t.shotsHit / t.shotsFired;
    default:
      return 0;
  }
}

/**
 * Leaderboards need a minimum sample or a player with 1 kill and 0 deaths tops
 * the K/D board forever.
 */
export function meetsLeaderboardMinimum(p: PlayerProfile, metric: LeaderboardMetric): boolean {
  const t = p.totals;
  switch (metric) {
    case 'kd':
      return t.kills + t.deaths >= 30;
    case 'headshotRate':
      return t.shotsHit >= 200;
    case 'accuracy':
      return t.shotsFired >= 500;
    default:
      return t.matchesPlayed >= 1 || p.xp > 0;
  }
}
