/**
 * In-memory database. Used by the test suite and by `DB_DRIVER=memory`.
 * Behaviour is identical to the SQL drivers; only durability differs.
 */

import {
  metricValue,
  meetsLeaderboardMinimum,
  newProfile,
  normaliseProfile,
  type Database,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type MatchRecord,
  type PlayerProfile,
} from './types.js';
import { levelFromXp } from '@kang/shared';

export class MemoryDatabase implements Database {
  readonly driver = 'memory';
  private profiles = new Map<string, PlayerProfile>();
  private matches: MatchRecord[] = [];

  async init(): Promise<void> {
    /* nothing to do */
  }

  async close(): Promise<void> {
    this.profiles.clear();
    this.matches.length = 0;
  }

  async getProfile(id: string): Promise<PlayerProfile | null> {
    const p = this.profiles.get(id);
    // Normalised on read like the SQL drivers, so all three honour the same
    // contract and tests written against one hold for the others.
    return p ? normaliseProfile(structuredClone(p)) : null;
  }

  async ensureProfile(id: string, name: string, guest: boolean): Promise<PlayerProfile> {
    let p = this.profiles.get(id);
    if (!p) {
      p = newProfile(id, name, guest, Date.now());
      this.profiles.set(id, p);
    } else if (name && p.name !== name) {
      p.name = name;
    }
    p.lastSeenAt = Date.now();
    return structuredClone(p);
  }

  async saveProfile(profile: PlayerProfile): Promise<void> {
    this.profiles.set(profile.id, structuredClone(profile));
  }

  async findProfileByEmail(email: string): Promise<PlayerProfile | null> {
    for (const p of this.profiles.values()) {
      if (p.email && p.email.toLowerCase() === email.toLowerCase()) return structuredClone(p);
    }
    return null;
  }

  async setName(id: string, name: string): Promise<void> {
    const p = this.profiles.get(id);
    if (p) p.name = name;
  }

  async recordMatch(record: MatchRecord): Promise<void> {
    this.matches.push({ ...record });
    // Keep the dev store bounded.
    if (this.matches.length > 20000) this.matches.splice(0, 5000);
  }

  async recentMatches(playerId: string, limit: number): Promise<MatchRecord[]> {
    return this.matches
      .filter((m) => m.playerId === playerId)
      .sort((a, b) => b.playedAt - a.playedAt)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  async leaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardEntry[]> {
    const rows = [...this.profiles.values()]
      .filter((p) => meetsLeaderboardMinimum(p, metric))
      .map((p) => ({ p, value: metricValue(p, metric) }))
      .sort((a, b) => b.value - a.value || a.p.name.localeCompare(b.p.name))
      .slice(0, limit);
    return rows.map(({ p, value }, i) => ({
      playerId: p.id,
      name: p.name,
      value,
      rank: i + 1,
      level: levelFromXp(p.xp).level,
      icon: p.icon,
      banner: p.banner,
    }));
  }

  async playerRank(playerId: string, metric: LeaderboardMetric): Promise<number> {
    const me = this.profiles.get(playerId);
    if (!me || !meetsLeaderboardMinimum(me, metric)) return 0;
    const mine = metricValue(me, metric);
    let better = 0;
    for (const p of this.profiles.values()) {
      if (p.id === playerId) continue;
      if (!meetsLeaderboardMinimum(p, metric)) continue;
      if (metricValue(p, metric) > mine) better++;
    }
    return better + 1;
  }

  async playerCount(): Promise<number> {
    return this.profiles.size;
  }
}
