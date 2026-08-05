/**
 * PostgreSQL driver for production.
 *
 * `pg` is imported dynamically so it is NOT a hard dependency of local
 * development: run `npm i pg` in packages/server and set
 * DB_DRIVER=postgres + DATABASE_URL to use it.  The schema mirrors the SQLite
 * one exactly, so a dev database can be dumped and loaded with minimal fuss.
 */

import { levelFromXp } from '@kang/shared';
import {
  metricValue,
  meetsLeaderboardMinimum,
  newProfile,
  normaliseProfile,
  type ClassStatRow,
  type Database,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type MatchRecord,
  type PlayerProfile,
  type WeaponStatRow,
} from './types.js';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT,
  password_hash     TEXT,
  guest             BOOLEAN NOT NULL DEFAULT TRUE,
  xp                BIGINT NOT NULL DEFAULT 0,
  created_at        BIGINT NOT NULL,
  last_seen_at      BIGINT NOT NULL,
  kills             BIGINT NOT NULL DEFAULT 0,
  deaths            BIGINT NOT NULL DEFAULT 0,
  assists           BIGINT NOT NULL DEFAULT 0,
  shots_fired       BIGINT NOT NULL DEFAULT 0,
  shots_hit         BIGINT NOT NULL DEFAULT 0,
  headshots         BIGINT NOT NULL DEFAULT 0,
  matches_played    BIGINT NOT NULL DEFAULT 0,
  wins              BIGINT NOT NULL DEFAULT 0,
  losses            BIGINT NOT NULL DEFAULT 0,
  damage_dealt      DOUBLE PRECISION NOT NULL DEFAULT 0,
  time_played_sec   DOUBLE PRECISION NOT NULL DEFAULT 0,
  score             BIGINT NOT NULL DEFAULT 0,
  longest_streak    INTEGER NOT NULL DEFAULT 0,
  banner            TEXT NOT NULL DEFAULT 'banner_grid',
  icon              TEXT NOT NULL DEFAULT 'icon_recruit',
  last_win_day      TEXT,
  settings_json     JSONB NOT NULL DEFAULT '{}',
  bindings_json     JSONB NOT NULL DEFAULT '{}',
  loadouts_json     JSONB NOT NULL DEFAULT '{}',
  cosmetics_json    JSONB NOT NULL DEFAULT '{}',
  counters_json     JSONB NOT NULL DEFAULT '{}',
  weapon_json       JSONB NOT NULL DEFAULT '{}',
  class_json        JSONB NOT NULL DEFAULT '{}',
  achievements_json JSONB NOT NULL DEFAULT '[]',
  challenges_json   JSONB NOT NULL DEFAULT '{}',
  claimed_json      JSONB NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS players_email ON players(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS players_xp    ON players(xp DESC);
CREATE INDEX IF NOT EXISTS players_kills ON players(kills DESC);
CREATE INDEX IF NOT EXISTS players_score ON players(score DESC);
CREATE INDEX IF NOT EXISTS players_wins  ON players(wins DESC);

CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL,
  map           TEXT NOT NULL,
  class_id      TEXT NOT NULL,
  kills         INTEGER NOT NULL,
  deaths        INTEGER NOT NULL,
  assists       INTEGER NOT NULL,
  score         INTEGER NOT NULL,
  damage        DOUBLE PRECISION NOT NULL,
  headshots     INTEGER NOT NULL,
  shots_fired   INTEGER NOT NULL,
  shots_hit     INTEGER NOT NULL,
  won           BOOLEAN NOT NULL,
  drew          BOOLEAN NOT NULL,
  mvp           BOOLEAN NOT NULL,
  xp_earned     INTEGER NOT NULL,
  duration_sec  DOUBLE PRECISION NOT NULL,
  played_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_player ON matches(player_id, played_at DESC);
`;

function obj<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

export class PostgresDatabase implements Database {
  readonly driver = 'postgres';
  private pool!: PgPool;

  constructor(private url: string) {}

  async init(): Promise<void> {
    let pgModule: { Pool: new (cfg: { connectionString: string; max: number }) => PgPool };
    // Indirect specifier: `pg` is an optional runtime dependency, so it must not
    // be resolved at compile time or a local dev install would fail to build.
    const specifier: string = 'pg';
    try {
      pgModule = (await import(specifier)) as unknown as typeof pgModule;
    } catch {
      throw new Error(
        'DB_DRIVER=postgres requires the `pg` package. Install it with: npm i pg -w @kang/server',
      );
    }
    this.pool = new pgModule.Pool({ connectionString: this.url, max: 10 });
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private rowToProfile(r: Record<string, unknown>): PlayerProfile {
    return normaliseProfile({
      id: String(r.id),
      name: String(r.name),
      email: r.email == null ? null : String(r.email),
      passwordHash: r.password_hash == null ? null : String(r.password_hash),
      guest: Boolean(r.guest),
      xp: Number(r.xp),
      createdAt: Number(r.created_at),
      lastSeenAt: Number(r.last_seen_at),
      settings: obj<Record<string, unknown>>(r.settings_json, {}),
      bindings: obj<Record<string, string>>(r.bindings_json, {}),
      loadouts: obj<Record<string, unknown>>(r.loadouts_json, {}),
      cosmetics: obj(r.cosmetics_json, { unlocked: [] as string[], equipped: {} as Record<string, string> }),
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
      counters: obj(r.counters_json, {}),
      weaponStats: obj<Record<string, WeaponStatRow>>(r.weapon_json, {}),
      classStats: obj<Record<string, ClassStatRow>>(r.class_json, {}),
      achievements: obj<string[]>(r.achievements_json, []),
      challengeProgress: obj<Record<string, number>>(r.challenges_json, {}),
      challengesClaimed: obj<string[]>(r.claimed_json, []),
      lastWinDay: r.last_win_day == null ? null : String(r.last_win_day),
      banner: String(r.banner ?? 'banner_grid'),
      icon: String(r.icon ?? 'icon_recruit'),
    });
  }

  async getProfile(id: string): Promise<PlayerProfile | null> {
    const res = await this.pool.query('SELECT * FROM players WHERE id = $1', [id]);
    return res.rows[0] ? this.rowToProfile(res.rows[0]) : null;
  }

  async ensureProfile(id: string, name: string, guest: boolean): Promise<PlayerProfile> {
    const now = Date.now();
    const p = newProfile(id, name, guest, now);
    await this.pool.query(
      // cosmetics_json is written explicitly: its column default of '{}' has no
      // `unlocked` array, and ensureProfile re-reads the row it just inserted.
      `INSERT INTO players (id, name, guest, created_at, last_seen_at, banner, icon, cosmetics_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = $5,
         name = CASE WHEN $2 <> '' THEN $2 ELSE players.name END`,
      [id, name, guest, now, now, p.banner, p.icon, JSON.stringify(p.cosmetics)],
    );
    return (await this.getProfile(id)) ?? p;
  }

  async saveProfile(p: PlayerProfile): Promise<void> {
    const t = p.totals;
    await this.pool.query(
      `UPDATE players SET
        name=$2, email=$3, password_hash=$4, guest=$5, xp=$6, last_seen_at=$7,
        kills=$8, deaths=$9, assists=$10, shots_fired=$11, shots_hit=$12, headshots=$13,
        matches_played=$14, wins=$15, losses=$16, damage_dealt=$17, time_played_sec=$18,
        score=$19, longest_streak=$20, banner=$21, icon=$22, last_win_day=$23,
        settings_json=$24, bindings_json=$25, loadouts_json=$26, cosmetics_json=$27,
        counters_json=$28, weapon_json=$29, class_json=$30, achievements_json=$31,
        challenges_json=$32, claimed_json=$33
       WHERE id=$1`,
      [
        p.id,
        p.name,
        p.email,
        p.passwordHash,
        p.guest,
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
        JSON.stringify(p.settings),
        JSON.stringify(p.bindings),
        JSON.stringify(p.loadouts),
        JSON.stringify(p.cosmetics),
        JSON.stringify(p.counters),
        JSON.stringify(p.weaponStats),
        JSON.stringify(p.classStats),
        JSON.stringify(p.achievements),
        JSON.stringify(p.challengeProgress),
        JSON.stringify(p.challengesClaimed),
      ],
    );
  }

  async findProfileByEmail(email: string): Promise<PlayerProfile | null> {
    const res = await this.pool.query('SELECT * FROM players WHERE email = $1', [email.toLowerCase()]);
    return res.rows[0] ? this.rowToProfile(res.rows[0]) : null;
  }

  async setName(id: string, name: string): Promise<void> {
    await this.pool.query('UPDATE players SET name = $2 WHERE id = $1', [id, name]);
  }

  async recordMatch(m: MatchRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO matches
        (id, player_id, mode, map, class_id, kills, deaths, assists, score, damage,
         headshots, shots_fired, shots_hit, won, drew, mvp, xp_earned, duration_sec, played_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO NOTHING`,
      [
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
        m.won,
        m.drew,
        m.mvp,
        Math.round(m.xpEarned),
        m.durationSec,
        m.playedAt,
      ],
    );
  }

  async recentMatches(playerId: string, limit: number): Promise<MatchRecord[]> {
    const res = await this.pool.query(
      'SELECT * FROM matches WHERE player_id = $1 ORDER BY played_at DESC LIMIT $2',
      [playerId, limit],
    );
    return res.rows.map((r) => ({
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
      won: Boolean(r.won),
      drew: Boolean(r.drew),
      mvp: Boolean(r.mvp),
      xpEarned: Number(r.xp_earned),
      durationSec: Number(r.duration_sec),
      playedAt: Number(r.played_at),
    }));
  }

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
        return { expr: 'kills::float / GREATEST(deaths, 1)', having: 'kills + deaths >= 30' };
      case 'headshotRate':
        return { expr: 'headshots::float / GREATEST(shots_hit, 1)', having: 'shots_hit >= 200' };
      case 'accuracy':
        return { expr: 'shots_hit::float / GREATEST(shots_fired, 1)', having: 'shots_fired >= 500' };
      default:
        return { expr: 'xp', having: 'TRUE' };
    }
  }

  async leaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardEntry[]> {
    const { expr, having } = this.metricSql(metric);
    const res = await this.pool.query(
      `SELECT id, name, xp, icon, banner, (${expr}) AS value
       FROM players WHERE ${having}
       ORDER BY value DESC, name ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r, i) => ({
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
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM players WHERE (${having}) AND (${expr}) > $1 AND id <> $2`,
      [metricValue(me, metric), playerId],
    );
    return Number(res.rows[0]?.n ?? 0) + 1;
  }

  async playerCount(): Promise<number> {
    const res = await this.pool.query('SELECT COUNT(*)::int AS n FROM players');
    return Number(res.rows[0]?.n ?? 0);
  }
}
