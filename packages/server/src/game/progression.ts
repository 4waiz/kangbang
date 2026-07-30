/**
 * Match -> profile progression.
 *
 * Called once when a match ends. Folds each human player's performance into
 * their persisted profile: XP, career totals, per-weapon and per-class mastery,
 * achievement counters, challenge progress and cosmetic unlocks.
 *
 * Bots are skipped entirely - they have no profile.
 */

import {
  ACHIEVEMENTS_BY_ID,
  COSMETICS,
  activeChallenges,
  classMasteryXp,
  computeMatchXp,
  dayKey,
  evaluateAchievements,
  levelFromXp,
  masteryLevel,
  weaponMasteryXp,
  type MatchResultPlayer,
  type StatCounter,
} from '@neon/shared';
import type { Database, MatchRecord, PlayerProfile } from '../db/index.js';
import { emptyClassStats, emptyWeaponStats } from '../db/index.js';
import type { ServerPlayer } from './player.js';

export interface AwardInput {
  player: ServerPlayer;
  mode: string;
  map: string;
  durationSec: number;
  won: boolean;
  drew: boolean;
  mvp: boolean;
  matchId: string;
}

export interface AwardResult {
  xpEarned: number;
  breakdown: { label: string; amount: number }[];
  levelBefore: number;
  levelAfter: number;
  newAchievements: string[];
  newUnlocks: string[];
  completedChallenges: string[];
}

/**
 * Apply one player's match to their profile and persist it.
 * Returns the numbers the results screen shows.
 */
export async function awardMatch(db: Database, input: AwardInput): Promise<AwardResult> {
  const { player: p } = input;
  const profile = await db.ensureProfile(p.profileId, p.name, true);
  const levelBefore = levelFromXp(profile.xp).level;

  const counters = p.counters;
  const today = dayKey(Date.now());
  const firstWinOfDay = input.won && profile.lastWinDay !== today;

  const xp = computeMatchXp({
    kills: p.kills,
    assists: p.assists,
    headshots: p.headshots,
    score: Math.max(0, Math.round(p.score)),
    objectiveCaptures: counters.objectiveCaptures ?? 0,
    objectiveTicks: counters.objectiveTicks ?? 0,
    objectiveDefends: counters.objectiveDefends ?? 0,
    coreScores: counters.coreScores ?? 0,
    roundWins: counters.roundWins ?? 0,
    durationSec: input.durationSec,
    won: input.won,
    drew: input.drew,
    mvp: input.mvp,
    firstWinOfDay,
    multiplier: 1,
  });

  profile.xp += xp.total;
  if (input.won) profile.lastWinDay = today;

  // --- career totals ---------------------------------------------------
  const t = profile.totals;
  const shotsFired = p.weapons.reduce((s, w) => s + w.shotsFired, 0);
  const shotsHit = p.weapons.reduce((s, w) => s + w.shotsHit, 0);
  t.kills += p.kills;
  t.deaths += p.deaths;
  t.assists += p.assists;
  t.shotsFired += shotsFired;
  t.shotsHit += shotsHit;
  t.headshots += p.headshots;
  t.matchesPlayed += 1;
  if (input.won) t.wins += 1;
  else if (!input.drew) t.losses += 1;
  t.damageDealt += p.damageDealt;
  t.timePlayedSec += input.durationSec;
  t.score += Math.max(0, Math.round(p.score));
  t.longestStreak = Math.max(t.longestStreak, p.longestStreak);

  // --- achievement counters --------------------------------------------
  const bump = (key: StatCounter, by: number) => {
    if (by <= 0) return;
    profile.counters[key] = (profile.counters[key] ?? 0) + by;
  };
  bump('kills', p.kills);
  bump('deaths', p.deaths);
  bump('assists', p.assists);
  bump('headshots', p.headshots);
  bump('matches', 1);
  bump('wins', input.won ? 1 : 0);
  bump('losses', !input.won && !input.drew ? 1 : 0);
  bump('damage', Math.round(p.damageDealt));
  bump('shotsFired', shotsFired);
  bump('shotsHit', shotsHit);
  bump('timePlayedSec', Math.round(input.durationSec));
  bump('distanceTravelled', Math.round(p.distanceTravelled));
  for (const [key, value] of Object.entries(counters)) {
    if (['kills', 'deaths', 'assists', 'headshots'].includes(key)) continue;
    bump(key as StatCounter, value);
  }

  // --- weapon mastery ---------------------------------------------------
  for (const w of p.weapons) {
    if (w.shotsFired === 0 && w.kills === 0 && w.damage === 0) continue;
    const row = profile.weaponStats[w.def.id] ?? emptyWeaponStats();
    row.kills += w.kills;
    row.headshots += w.headshots;
    row.shotsFired += w.shotsFired;
    row.shotsHit += w.shotsHit;
    row.damage += w.damage;
    row.timeUsedSec += w.timeUsedSec;
    row.masteryXp += weaponMasteryXp(w.kills, w.headshots, w.damage);
    profile.weaponStats[w.def.id] = row;
  }

  // --- class mastery ----------------------------------------------------
  const cls = profile.classStats[p.classDef.id] ?? emptyClassStats();
  cls.matches += 1;
  if (input.won) cls.wins += 1;
  cls.kills += p.kills;
  cls.deaths += p.deaths;
  cls.score += Math.max(0, Math.round(p.score));
  cls.timePlayedSec += input.durationSec;
  cls.masteryXp += classMasteryXp(p.score, input.won, input.durationSec);
  profile.classStats[p.classDef.id] = cls;

  // --- achievements -----------------------------------------------------
  const done = new Set(profile.achievements);
  const { newlyCompleted } = evaluateAchievements(profile.counters, done);
  const newAchievements: string[] = [];
  const newUnlocks: string[] = [];
  for (const ach of newlyCompleted) {
    profile.achievements.push(ach.id);
    newAchievements.push(ach.id);
    profile.xp += ach.xpReward;
    if (ach.unlocks && !profile.cosmetics.unlocked.includes(ach.unlocks)) {
      profile.cosmetics.unlocked.push(ach.unlocks);
      newUnlocks.push(ach.unlocks);
    }
  }

  // --- challenges -------------------------------------------------------
  const completedChallenges: string[] = [];
  for (const ch of activeChallenges(profile.id, Date.now())) {
    if (profile.challengesClaimed.includes(ch.key)) continue;
    const before = profile.challengeProgress[ch.key] ?? 0;
    const gained = counterForChallenge(ch.counter, p, input);
    if (gained <= 0) continue;
    const after = Math.min(ch.target, before + gained);
    profile.challengeProgress[ch.key] = after;
    if (after >= ch.target) {
      profile.challengesClaimed.push(ch.key);
      profile.xp += ch.xpReward;
      completedChallenges.push(ch.key);
    }
  }

  // --- level-gated cosmetics -------------------------------------------
  const levelAfter = levelFromXp(profile.xp).level;
  const unlockCtx = {
    level: levelAfter,
    weaponMastery: masteryMap(profile, 'weapon'),
    classMastery: masteryMap(profile, 'class'),
    achievements: new Set(profile.achievements),
    totals: profile.totals,
  };
  for (const [id, def] of Object.entries(COSMETICS)) {
    if (!def.unlock) continue;
    if (profile.cosmetics.unlocked.includes(id)) continue;
    if (cosmeticUnlocked(def.unlock, unlockCtx)) {
      profile.cosmetics.unlocked.push(id);
      newUnlocks.push(id);
    }
  }

  await db.saveProfile(profile);

  const record: MatchRecord = {
    id: `${input.matchId}:${p.profileId}`,
    playerId: p.profileId,
    mode: input.mode,
    map: input.map,
    classId: p.classDef.id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    score: Math.round(p.score),
    damage: Math.round(p.damageDealt),
    headshots: p.headshots,
    shotsFired,
    shotsHit,
    won: input.won,
    drew: input.drew,
    mvp: input.mvp,
    xpEarned: xp.total,
    durationSec: input.durationSec,
    playedAt: Date.now(),
  };
  await db.recordMatch(record);

  return {
    xpEarned: xp.total,
    breakdown: xp.breakdown,
    levelBefore,
    levelAfter,
    newAchievements,
    newUnlocks,
    completedChallenges,
  };
}

function masteryMap(profile: PlayerProfile, kind: 'weapon' | 'class'): Record<string, number> {
  const out: Record<string, number> = {};
  if (kind === 'weapon') {
    for (const [id, row] of Object.entries(profile.weaponStats)) out[id] = masteryLevel(row.masteryXp, 900);
  } else {
    for (const [id, row] of Object.entries(profile.classStats)) out[id] = masteryLevel(row.masteryXp, 1200);
  }
  return out;
}

interface UnlockCtxLike {
  level: number;
  weaponMastery: Record<string, number>;
  classMastery: Record<string, number>;
  achievements: Set<string>;
  totals: PlayerProfile['totals'];
}

/**
 * Cosmetic unlock evaluation.  `weaponMastery` with target 'any' means the
 * highest mastery across all weapons, which is how the skin ladder works.
 */
function cosmeticUnlocked(req: NonNullable<(typeof COSMETICS)[string]['unlock']>, ctx: UnlockCtxLike): boolean {
  // Achievement unlocks carry no threshold; the others default to "any amount".
  const need = req.value ?? 0;
  switch (req.kind) {
    case 'level':
      return ctx.level >= need;
    case 'weaponMastery': {
      if (req.target === 'any') {
        const best = Math.max(0, ...Object.values(ctx.weaponMastery));
        return best >= need;
      }
      return (ctx.weaponMastery[req.target ?? ''] ?? 0) >= need;
    }
    case 'classMastery': {
      if (req.target === 'any') {
        const best = Math.max(0, ...Object.values(ctx.classMastery));
        return best >= need;
      }
      return (ctx.classMastery[req.target ?? ''] ?? 0) >= need;
    }
    case 'achievement':
      return ctx.achievements.has(req.target ?? '');
    case 'stat': {
      const key = (req.target ?? '') as keyof PlayerProfile['totals'];
      return (ctx.totals[key] ?? 0) >= need;
    }
    default:
      return false;
  }
}

function counterForChallenge(counter: StatCounter, p: ServerPlayer, input: AwardInput): number {
  switch (counter) {
    case 'kills':
      return p.kills;
    case 'deaths':
      return p.deaths;
    case 'assists':
      return p.assists;
    case 'headshots':
      return p.headshots;
    case 'wins':
      return input.won ? 1 : 0;
    case 'losses':
      return !input.won && !input.drew ? 1 : 0;
    case 'matches':
      return 1;
    case 'damage':
      return Math.round(p.damageDealt);
    case 'shotsFired':
      return p.weapons.reduce((s, w) => s + w.shotsFired, 0);
    case 'shotsHit':
      return p.weapons.reduce((s, w) => s + w.shotsHit, 0);
    default:
      return p.counters[counter] ?? 0;
  }
}

/** Build the results-screen row for one player. */
export function buildResultRow(p: ServerPlayer, award: AwardResult | null, won: boolean, drew: boolean): MatchResultPlayer {
  const weaponUsage: Record<string, number> = {};
  for (const w of p.weapons) {
    if (w.shotsFired > 0 || w.kills > 0) weaponUsage[w.def.id] = w.kills;
  }
  return {
    id: p.id,
    name: p.name,
    team: p.team,
    classId: p.classDef.id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    score: Math.round(p.score),
    damage: Math.round(p.damageDealt),
    headshots: p.headshots,
    shotsFired: p.weapons.reduce((s, w) => s + w.shotsFired, 0),
    shotsHit: p.weapons.reduce((s, w) => s + w.shotsHit, 0),
    objectiveScore: Math.round(p.objectiveScore),
    longestStreak: p.longestStreak,
    bot: p.bot,
    xpEarned: award?.xpEarned ?? 0,
    xpBreakdown: award?.breakdown ?? [],
    won: won && !drew,
    accountLevel: award?.levelBefore ?? p.accountLevel,
    accountLevelAfter: award?.levelAfter ?? p.accountLevel,
    weaponUsage,
  };
}

/** Achievement metadata lookup used by the REST API. */
export function achievementName(id: string): string {
  return ACHIEVEMENTS_BY_ID[id]?.name ?? id;
}
