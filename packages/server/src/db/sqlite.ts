/**
 * SQLite driver built on Node's built-in `node:sqlite`.
 *
 * Chosen over better-sqlite3 deliberately: no native compilation, no prebuilt
 * binary mismatch on Windows, and it ships with the runtime we already require.
 *
 * Schema strategy: a small number of columns for anything we sort or filter on
 * (so leaderboards are indexable) plus JSON columns for the bags of data we
 * only ever read whole (settings, cosmetics, per-weapon stats).  That keeps
 * migrations rare while staying honestly relational where it matters.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { levelFromXp } from '@neon/shared';
import {
  emptyTotals,
  metricValue,
  meetsLeaderboardMinimum,
  newProfile,
  type Database,
  type ClassStatRow,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type MatchRecord,
  type PlayerProfile,
  type WeaponStatRow,
} from './types.js';

interface Row {
  [key: string]: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT,
  password_hash     TEXT,
  guest             INTEGER NOT NULL DEFAULT 1,
  xp                INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  kills             INTEGER NOT NULL DEFAULT 0,
  deaths            INTEGER NOT NULL DEFAULT 0,
  assists           INTEGER NOT NULL DEFAULT 0,
  shots_fired       INTEGER NOT NULL DEFAULT 0,
  shots_hit         INTEGER NOT NULL DEFAULT 0,
  headshots         INTEGER NOT NULL DEFAULT 0,
  matches_played    INTEGER NOT NULL DEFAULT 0,
  wins              INTEGER NOT NULL DEFAULT 0,
  losses            INTEGER NOT NULL DEFAULT 0,
  damage_dealt      REAL    NOT NULL DEFAULT 0,
  time_played_sec   REAL    NOT NULL DEFAULT 0,
  score             INTEGER NOT NULL DEFAULT 0,
  longest_streak    INTEGER NOT NULL DEFAULT 0,
  banner            TEXT NOT NULL DEFAULT 'banner_grid',
  icon              TEXT NOT NULL DEFAULT 'icon_recruit',
  last_win_day      TEXT,
  settings_json     TEXT NOT NULL DEFAULT '{}',
  bindings_json     TEXT NOT NULL DEFAULT '{}',
  loadouts_json     TEXT NOT NULL DEFAULT '{}',
  cosmetics_json    TEXT NOT NULL DEFAULT '{}',
  counters_json     TEXT NOT NULL DEFAULT '{}',
  weapon_json       TEXT NOT NULL DEFAULT '{}',
  class_json        TEXT NOT NULL DEFAULT '{}',
  achievements_json TEXT NOT NULL DEFAULT '[]',
  challenges_json   TEXT NOT NULL DEFAULT '{}',
  claimed_json      TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS players_email ON players(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS players_xp     ON players(xp DESC);
CREATE INDEX IF NOT EXISTS players_kills  ON players(kills DESC);
CREATE INDEX IF NOT EXISTS players_score  ON players(score DESC);
CREATE INDEX IF NOT EXISTS players_wins   ON players(wins DESC);

CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL,
  mode          TEXT NOT NULL,
  map           TEXT NOT NULL,
  class_id      TEXT NOT NULL,
  kills         INTEGER NOT NULL,
  deaths        INTEGER NOT NULL,
  assists       INTEGER NOT NULL,
  score         INTEGER NOT NULL,
  damage        REAL    NOT NULL,
  headshots     INTEGER NOT NULL,
  shots_fired   INTEGER NOT NULL,
  shots_hit     INTEGER NOT NULL,
  won           INTEGER NOT NULL,
  drew          INTEGER NOT NULL,
  mvp           INTEGER NOT NULL,
  xp_earned     INTEGER NOT NULL,
  duration_sec  REAL    NOT NULL,
  played_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_player ON matches(player_id, played_at DESC);
`;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export class SqliteDatabase implements Database {
  readonly driver = 'sqlite';
  private db!: DatabaseSync;

  constructor(private path: string) {}

  async init(): Promise<void> {
    const full = isAbsolute(this.path) ? this.path : resolve(process.cwd(), this.path);
    if (full !== ':memory:') mkdirSync(dirname(full), { recursive: true });
    this.db = new DatabaseSync(full);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  private rowToProfile(r: Row): PlayerProfile {
    return {
      id: String(r.id),
      name: String(r.name),
      email: r.email === null || r.email === undefined ? null : String(r.email),
      passwordHash: r.password_hash === null || r.password_hash === undefined ? null : String(r.password_hash),
      guest: Number(r.guest) !== 0,
      xp: Number(r.xp),
      createdAt: Number(r.created_at),
      lastSeenAt: Number(r.last_seen_at),
      settings: parseJson<Record<string, unknown>>(r.settings_json, {}),
      bindings: parseJson<Record<string, string>>(r.bindings_json, {}),
      loadouts: parseJson<Record<string, unknown>>(r.loadouts_json, {}),
      cosmetics: parseJson(r.cosmetics_json, { unlocked: [] as string[], equipped: {} as Record<string, string> }),
      totals: {
        kills: Number(r.kills),
        deaths: Number(r.deaths),
        assists: Number(r.assists),
        shotsFired: Number(r.shots_fired),
        shotsHit: Number(r.shots_hit),
        headshots: Number(r.headshots),
        matchesPlayed: Number(r.matches_played),
        wins: Number(r.wins),
        losses: Number(r.losses),
        damageDealt: Number(r.damage_dealt),
        timePlayedSec: Number(r.time_played_sec),
        score: Number(r.score),
        longestStreak: Number(r.longest_streak),
      },
      counters: parseJson(r.counters_json, {}),
      weaponStats: parseJson<Record<string, WeaponStatRow>>(r.weapon_json, {}),
      classStats: parseJson<Record<string, ClassStatRow>>(r.class_json, {}),
      achievements: parseJson<string[]>(r.achievements_json, []),
      challengeProgress: parseJson<Record<string, number>>(r.challenges_json, {}),
      challengesClaimed: parseJson<string[]>(r.claimed_json, []),
      lastWinDay: r.last_win_day === null || r.last_win_day === undefined ? null : String(r.last_win_day),
      banner: String(r.banner ?? 'banner_grid'),
      icon: String(r.icon ?? 'icon_recruit'),
    };
  }

  async getProfile(id: string): Promise<PlayerProfile | null> {
    const row = this.db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Row | undefined;
    return row ? this.rowToProfile(row) : null;
  }

  async ensureProfile(id: string, name: string, guest: boolean): Promise<PlayerProfile> {
    const existing = await this.getProfile(id);
    if (existing) {
      const now = Date.now();
      if (name && name !== existing.name) {
        this.db.prepare('UPDATE players SET name = ?, last_seen_at = ? WHERE id = ?').run(name, now, id);
        existing.name = name;
      } else {
        this.db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(now, id);
      }
      existing.lastSeenAt = now;
      return existing;
    }
    const p = newProfile(id, name, guest, Date.now());
    this.db
      .prepare(
        `INSERT INTO players (id, name, guest, xp, created_at, last_seen_at, banner, icon)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, guest ? 1 : 0, p.createdAt, p.lastSeenAt, p.banner, p.icon);
    return p;
  }

  async saveProfile(p: PlayerProfile): Promise<void> {
    const t = p.totals ?? emptyTotals();
    this.db
      .prepare(
        `UPDATE players SET
          name = ?, email = ?, password_hash = ?, guest = ?, xp = ?, last_seen_at = ?,
          kills = ?, deaths = ?, assists = ?, shots_fired = ?, shots_hit = ?, headshots = ?,
          matches_played = ?, wins = ?, losses = ?, damage_dealt = ?, time_played_sec = ?,
          score = ?, longest_streak = ?, banner = ?, icon = ?, last_win_day = ?,
          settings_json = ?, bindings_json = ?, loadouts_json = ?, cosmetics_json = ?,
          counters_json = ?, weapon_json = ?, class_json = ?, achievements_json = ?,
          challenges_json = ?, claimed_json = ?
         WHERE id = ?`,
      )
      .run(
        p.name,
        p.email,
        p.passwordHash,
        p.guest ? 1 : 0,
        Math.round(p.xp),
        Date.now(),
        t.kills,
        t.deaths,
        t.assists,
        t.shotsFired,
        t.shotsHit,
        t.headshots,
        t.matchesPlayed,
        t.wins,
        t.losses,
        t.damageDealt,
        t.timePlayedSec,
        Math.round(t.score),
        t.longestStreak,
        p.banner,
        p.icon,
        p.lastWinDay,
        JSON.stringify(p.settings ?? {}),
        JSON.stringify(p.bindings ?? {}),
        JSON.stringify(p.loadouts ?? {}),
        JSON.stringify(p.cosmetics ?? { unlocked: [], equipped: {} }),
        JSON.stringify(p.counters ?? {}),
        JSON.stringify(p.weaponStats ?? {}),
        JSON.stringify(p.classStats ?? {}),
        JSON.stringify(p.achievements ?? []),
        JSON.stringify(p.challengeProgress ?? {}),
        JSON.stringify(p.challengesClaimed ?? []),
        p.id,
      );
  }

  async findProfileByEmail(email: string): Promise<PlayerProfile | null> {
    const row = this.db.prepare('SELECT * FROM players WHERE email = ?').get(email.toLowerCase()) as Row | undefined;
    return row ? this.rowToProfile(row) : null;
  }

  async setName(id: string, name: string): Promise<void> {
    this.db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
  }

  async recordMatch(m: MatchRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO matches
          (id, player_id, mode, map, class_id, kills, deaths, assists, score, damage,
           headshots, shots_fired, shots_hit, won, drew, mvp, xp_earned, duration_sec, played_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id,
        m.playerId,
        m.mode,
        m.map,
        m.classId,
        m.kills,
        m.deaths,
        m.assists,
        Math.round(m.score),
        m.damage,
        m.headshots,
        m.shotsFired,
        m.shotsHit,
        m.won ? 1 : 0,
        m.drew ? 1 : 0,
        m.mvp ? 1 : 0,
        Math.round(m.xpEarned),
        m.durationSec,
        m.playedAt,
      );
  }

  async recentMatches(playerId: string, limit: number): Promise<MatchRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM matches WHERE player_id = ? ORDER BY played_at DESC LIMIT ?')
      .all(playerId, limit) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      playerId: String(r.player_id),
      mode: String(r.mode),
      map: String(r.map),
      classId: String(r.class_id),
      kills: Number(r.kills),
      deaths: Number(r.deaths),
      assists: Number(r.assists),
      score: Number(r.score),
      damage: Number(r.damage),
      headshots: Number(r.headshots),
      shotsFired: Number(r.shots_fired),
      shotsHit: Number(r.shots_hit),
      won: Number(r.won) !== 0,
      drew: Number(r.drew) !== 0,
      mvp: Number(r.mvp) !== 0,
      xpEarned: Number(r.xp_earned),
      durationSec: Number(r.duration_sec),
      playedAt: Number(r.played_at),
    }));
  }

  /**
   * Ratio metrics (K/D, accuracy) are computed in SQL with their sample-size
   * floor applied, so the sort happens in the database rather than in JS.
   */
  private metricSql(metric: LeaderboardMetric): { expr: string; having: string } {
    switch (metric) {
      case 'xp':
        return { expr: 'xp', having: 'xp > 0 OR matches_played > 0' };
      case 'kills':
        return { expr: 'kills', having: 'matches_played > 0' };
      case 'score':
        return { expr: 'score', having: 'matches_played > 0' };
      case 'wins':
        return { expr: 'wins', having: 'matches_played > 0' };
      case 'kd':
        return { expr: 'CAST(kills AS REAL) / MAX(deaths, 1)', having: 'kills + deaths >= 30' };
      case 'headshotRate':
        return { expr: 'CAST(headshots AS REAL) / MAX(shots_hit, 1)', having: 'shots_hit >= 200' };
      case 'accuracy':
        return { expr: 'CAST(shots_hit AS REAL) / MAX(shots_fired, 1)', having: 'shots_fired >= 500' };
      default:
        return { expr: 'xp', having: '1=1' };
    }
  }

  async leaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardEntry[]> {
    const { expr, having } = this.metricSql(metric);
    const rows = this.db
      .prepare(
        `SELECT id, name, xp, icon, banner, (${expr}) AS value
         FROM players WHERE ${having}
         ORDER BY value DESC, name ASC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r, i) => ({
      playerId: String(r.id),
      name: String(r.name),
      value: Number(r.value),
      rank: i + 1,
      level: levelFromXp(Number(r.xp)).level,
      icon: String(r.icon),
      banner: String(r.banner),
    }));
  }

  async playerRank(playerId: string, metric: LeaderboardMetric): Promise<number> {
    const me = await this.getProfile(playerId);
    if (!me || !meetsLeaderboardMinimum(me, metric)) return 0;
    const { expr, having } = this.metricSql(metric);
    const mine = metricValue(me, metric);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM players WHERE (${having}) AND (${expr}) > ? AND id != ?`)
      .get(mine, playerId) as Row | undefined;
    return Number(row?.n ?? 0) + 1;
  }

  async playerCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM players').get() as Row | undefined;
    return Number(row?.n ?? 0);
  }
}
