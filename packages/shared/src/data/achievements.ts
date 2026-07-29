/**
 * Achievements and the daily/weekly challenge system.
 *
 * Both are driven by the same "stat counter" model: a match produces a bag of
 * counters, the server folds them into the player's lifetime counters, then
 * evaluates every achievement/challenge against them.  Adding a new one is a
 * data change.
 */

export type StatCounter =
  | 'kills'
  | 'deaths'
  | 'assists'
  | 'headshots'
  | 'wins'
  | 'losses'
  | 'matches'
  | 'damage'
  | 'shotsFired'
  | 'shotsHit'
  | 'objectiveCaptures'
  | 'objectiveTicks'
  | 'coreScores'
  | 'roundWins'
  | 'meleeKills'
  | 'longshotKills'
  | 'wallbangKills'
  | 'noscopeKills'
  | 'multiKills'
  | 'streak5'
  | 'streak10'
  | 'abilityKills'
  | 'turretKills'
  | 'healingDone'
  | 'reviveAssists'
  | 'timePlayedSec'
  | 'distanceTravelled'
  | 'slideKills'
  | 'airKills'
  | 'pickupsCollected';

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  counter: StatCounter;
  target: number;
  /** Optional filter: only count towards this weapon/class. */
  scope?: { kind: 'weapon' | 'class' | 'mode'; id: string };
  xpReward: number;
  /** Cosmetic unlocked on completion. */
  unlocks?: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  hidden: boolean;
}

const a = (
  id: string,
  name: string,
  description: string,
  counter: StatCounter,
  target: number,
  tier: AchievementDef['tier'],
  xpReward: number,
  extra: Partial<AchievementDef> = {},
): AchievementDef => ({ id, name, description, counter, target, tier, xpReward, icon: extra.icon ?? counter, hidden: false, ...extra });

export const ACHIEVEMENTS: AchievementDef[] = [
  a('first_blood', 'First Contact', 'Get your first elimination.', 'kills', 1, 'bronze', 200),
  a('kills_50', 'Contractor', 'Eliminate 50 enemies.', 'kills', 50, 'bronze', 400),
  a('kills_250', 'Operator', 'Eliminate 250 enemies.', 'kills', 250, 'silver', 900, { unlocks: 'charm_skullchip' }),
  a('kills_1000', 'Veteran', 'Eliminate 1000 enemies.', 'kills', 1000, 'gold', 2500),
  a('kills_5000', 'Legend', 'Eliminate 5000 enemies.', 'kills', 5000, 'platinum', 8000),

  a('headshots_50', 'Precise', 'Land 50 headshots.', 'headshots', 50, 'bronze', 400),
  a('headshots_500', 'Marksman', 'Land 500 headshots.', 'headshots', 500, 'gold', 2200, { unlocks: 'icon_marksman' }),

  a('wins_1', 'On the Board', 'Win a match.', 'wins', 1, 'bronze', 250),
  a('wins_25', 'Contender', 'Win 25 matches.', 'wins', 25, 'silver', 1000),
  a('wins_100', 'Champion', 'Win 100 matches.', 'wins', 100, 'gold', 3000),

  a('matches_100', 'Regular', 'Play 100 matches.', 'matches', 100, 'silver', 1200, { unlocks: 'armor_veteran' }),

  a('melee_25', 'Up Close', 'Get 25 melee eliminations.', 'meleeKills', 25, 'silver', 800),
  a('longshot_25', 'Long Range', 'Get 25 eliminations beyond 60 metres.', 'longshotKills', 25, 'silver', 800),
  a('wallbang_10', 'Through the Glass', 'Get 10 eliminations through penetrable cover.', 'wallbangKills', 10, 'gold', 1500),
  a('noscope_10', 'Hipfire Hero', 'Get 10 sniper eliminations without aiming.', 'noscopeKills', 10, 'gold', 1500),
  a('slide_25', 'Momentum', 'Get 25 eliminations while sliding.', 'slideKills', 25, 'silver', 900),
  a('air_15', 'Airborne', 'Get 15 eliminations while airborne.', 'airKills', 15, 'silver', 900),

  a('multikill_50', 'Chain Reaction', 'Get 50 multi-kills.', 'multiKills', 50, 'gold', 1800),
  a('streak5_25', 'Rampage', 'Reach a 5 elimination streak 25 times.', 'streak5', 25, 'silver', 900),
  a('streak10_10', 'Unstoppable', 'Reach a 10 elimination streak 10 times.', 'streak10', 10, 'gold', 2000),

  a('ability_100', 'Force Multiplier', 'Get 100 ability-assisted eliminations.', 'abilityKills', 100, 'silver', 1000),
  a('turret_50', 'Automated', 'Get 50 turret eliminations.', 'turretKills', 50, 'silver', 1000, {
    scope: { kind: 'class', id: 'engineer' },
  }),
  a('healing_10000', 'Field Hospital', 'Heal 10,000 health as Warden.', 'healingDone', 10000, 'gold', 1800, {
    scope: { kind: 'class', id: 'warden' },
  }),

  a('captures_100', 'Objective First', 'Capture 100 objectives.', 'objectiveCaptures', 100, 'silver', 1200),
  a('cores_25', 'Core Runner', 'Score 25 cores.', 'coreScores', 25, 'gold', 1600),
  a('rounds_100', 'Round Winner', 'Win 100 elimination rounds.', 'roundWins', 100, 'gold', 1600),

  a('damage_100k', 'Attrition', 'Deal 100,000 damage.', 'damage', 100000, 'gold', 2000),
  a('distance_100km', 'Marathon', 'Travel 100 kilometres.', 'distanceTravelled', 100000, 'gold', 1600),
  a('pickups_500', 'Scavenger', 'Collect 500 pickups.', 'pickupsCollected', 500, 'silver', 800),
];

export const ACHIEVEMENTS_BY_ID: Record<string, AchievementDef> = {};
for (const ach of ACHIEVEMENTS) ACHIEVEMENTS_BY_ID[ach.id] = ach;

export interface AchievementProgress {
  id: string;
  current: number;
  target: number;
  complete: boolean;
  progress: number;
}

export function evaluateAchievements(
  counters: Partial<Record<StatCounter, number>>,
  completed: ReadonlySet<string>,
): { progress: AchievementProgress[]; newlyCompleted: AchievementDef[] } {
  const progress: AchievementProgress[] = [];
  const newlyCompleted: AchievementDef[] = [];
  for (const ach of ACHIEVEMENTS) {
    const current = counters[ach.counter] ?? 0;
    const complete = current >= ach.target;
    progress.push({
      id: ach.id,
      current: Math.min(current, ach.target),
      target: ach.target,
      complete,
      progress: Math.min(1, current / ach.target),
    });
    if (complete && !completed.has(ach.id)) newlyCompleted.push(ach);
  }
  return { progress, newlyCompleted };
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export type ChallengePeriod = 'daily' | 'weekly';

export interface ChallengeTemplate {
  id: string;
  name: string;
  description: string;
  counter: StatCounter;
  /** Target for daily; weekly multiplies by weeklyScale. */
  target: number;
  xpReward: number;
  scope?: AchievementDef['scope'];
  weight: number;
}

export const CHALLENGE_TEMPLATES: ChallengeTemplate[] = [
  { id: 'ch_kills', name: 'Clear the Deck', description: 'Get {n} eliminations.', counter: 'kills', target: 15, xpReward: 600, weight: 10 },
  { id: 'ch_headshots', name: 'Aim Small', description: 'Land {n} headshots.', counter: 'headshots', target: 6, xpReward: 700, weight: 8 },
  { id: 'ch_assists', name: 'Team Player', description: 'Get {n} assists.', counter: 'assists', target: 8, xpReward: 500, weight: 7 },
  { id: 'ch_wins', name: 'Take the Round', description: 'Win {n} matches.', counter: 'wins', target: 2, xpReward: 800, weight: 8 },
  { id: 'ch_matches', name: 'Clock In', description: 'Play {n} matches.', counter: 'matches', target: 4, xpReward: 450, weight: 9 },
  { id: 'ch_damage', name: 'Grind It Out', description: 'Deal {n} damage.', counter: 'damage', target: 4000, xpReward: 550, weight: 7 },
  { id: 'ch_melee', name: 'Close Quarters', description: 'Get {n} melee eliminations.', counter: 'meleeKills', target: 3, xpReward: 700, weight: 5 },
  { id: 'ch_longshot', name: 'Reach Out', description: 'Get {n} eliminations past 60m.', counter: 'longshotKills', target: 3, xpReward: 700, weight: 5 },
  { id: 'ch_objectives', name: 'Hold the Point', description: 'Capture {n} objectives.', counter: 'objectiveCaptures', target: 5, xpReward: 650, weight: 6 },
  { id: 'ch_slide', name: 'Keep Moving', description: 'Get {n} eliminations while sliding.', counter: 'slideKills', target: 3, xpReward: 700, weight: 5 },
  { id: 'ch_air', name: 'Off the Ground', description: 'Get {n} airborne eliminations.', counter: 'airKills', target: 2, xpReward: 750, weight: 4 },
  { id: 'ch_ability', name: 'Use Your Kit', description: 'Get {n} ability-assisted eliminations.', counter: 'abilityKills', target: 5, xpReward: 600, weight: 6 },
  { id: 'ch_multikill', name: 'Two Birds', description: 'Get {n} multi-kills.', counter: 'multiKills', target: 3, xpReward: 700, weight: 5 },
  { id: 'ch_pickups', name: 'Resupply', description: 'Collect {n} pickups.', counter: 'pickupsCollected', target: 12, xpReward: 400, weight: 6 },
];

export const WEEKLY_SCALE = 5;
export const DAILY_CHALLENGE_COUNT = 3;
export const WEEKLY_CHALLENGE_COUNT = 3;

export interface ChallengeInstance {
  key: string;
  templateId: string;
  period: ChallengePeriod;
  name: string;
  description: string;
  counter: StatCounter;
  target: number;
  xpReward: number;
  scope?: AchievementDef['scope'];
  /** Period identifier: `YYYY-MM-DD` for daily, `YYYY-Www` for weekly. */
  periodKey: string;
}

/** Deterministic day key in UTC. */
export function dayKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Deterministic ISO-ish week key in UTC. */
export function weekKey(nowMs: number): string {
  const d = new Date(nowMs);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = target - dayNum * 86400000 + 3 * 86400000;
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = 1 + Math.floor((thursday - jan1) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministically choose challenges for a period + player.  Same inputs
 * always give the same set, so no server-side state is needed to keep a
 * player's challenge list stable across reconnects.
 */
export function rollChallenges(
  playerKey: string,
  period: ChallengePeriod,
  periodKey: string,
  count: number,
): ChallengeInstance[] {
  const seedBase = hashString(`${playerKey}|${period}|${periodKey}`);
  const pool = [...CHALLENGE_TEMPLATES];
  const chosen: ChallengeInstance[] = [];
  let seed = seedBase;
  const next = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2545f491) + 0x9e3779b1) >>> 0;
    return seed / 4294967296;
  };
  const scale = period === 'weekly' ? WEEKLY_SCALE : 1;

  for (let k = 0; k < count && pool.length > 0; k++) {
    const totalWeight = pool.reduce((s, t) => s + t.weight, 0);
    let pick = next() * totalWeight;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      pick -= pool[i].weight;
      if (pick <= 0) {
        idx = i;
        break;
      }
    }
    const t = pool.splice(idx, 1)[0];
    const target = Math.round(t.target * scale);
    chosen.push({
      key: `${period}:${periodKey}:${t.id}`,
      templateId: t.id,
      period,
      name: t.name,
      description: t.description.replace('{n}', String(target)),
      counter: t.counter,
      target,
      xpReward: Math.round(t.xpReward * (period === 'weekly' ? 3.2 : 1)),
      scope: t.scope,
      periodKey,
    });
  }
  return chosen;
}

export function activeChallenges(playerKey: string, nowMs: number): ChallengeInstance[] {
  return [
    ...rollChallenges(playerKey, 'daily', dayKey(nowMs), DAILY_CHALLENGE_COUNT),
    ...rollChallenges(playerKey, 'weekly', weekKey(nowMs), WEEKLY_CHALLENGE_COUNT),
  ];
}
