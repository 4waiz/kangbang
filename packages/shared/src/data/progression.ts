/**
 * Progression maths.
 *
 * Everything here is pure so the server can award XP authoritatively and the
 * client can render the same numbers in the results screen without a round trip.
 * Unlocks gate cosmetics and *sidegrade* weapons/perks only - there is no stat
 * advantage behind any level.
 */

export const MAX_ACCOUNT_LEVEL = 100;

/**
 * XP required to advance FROM `level` TO `level + 1`.
 * Gentle early curve, flattening into a steady grind so late levels stay
 * reachable in a session or two.
 */
export function xpForLevel(level: number): number {
  if (level < 1) return 0;
  if (level >= MAX_ACCOUNT_LEVEL) return Infinity;
  return Math.round(900 + 220 * (level - 1) + 14 * (level - 1) * (level - 1));
}

/** Cumulative XP needed to reach `level` from zero. */
export function totalXpForLevel(level: number): number {
  let sum = 0;
  for (let l = 1; l < Math.min(level, MAX_ACCOUNT_LEVEL); l++) sum += xpForLevel(l);
  return sum;
}

export interface LevelState {
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
  progress: number;
}

/** Convert lifetime XP into a level + progress bar state. */
export function levelFromXp(totalXp: number): LevelState {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < MAX_ACCOUNT_LEVEL) {
    const need = xpForLevel(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  const xpForNext = level >= MAX_ACCOUNT_LEVEL ? 0 : xpForLevel(level);
  return {
    level,
    xpIntoLevel: remaining,
    xpForNext,
    progress: xpForNext > 0 ? remaining / xpForNext : 1,
  };
}

// ---------------------------------------------------------------------------
// Match XP
// ---------------------------------------------------------------------------

export const XP_RATES = {
  perKill: 100,
  perAssist: 40,
  perHeadshot: 30,
  perObjectiveCapture: 150,
  perObjectiveTick: 4,
  perObjectiveDefend: 60,
  perCoreScore: 300,
  perRoundWin: 120,
  /** XP per point of match score, on top of the event bonuses. */
  perScorePoint: 0.25,
  matchComplete: 250,
  win: 500,
  loss: 150,
  draw: 250,
  mvp: 300,
  /** Per-minute participation bonus, capped at matchTimeCap minutes. */
  perMinute: 40,
  matchTimeCapMinutes: 15,
  /** First win of the day. */
  firstWinBonus: 750,
} as const;

export interface MatchXpInput {
  kills: number;
  assists: number;
  headshots: number;
  score: number;
  objectiveCaptures: number;
  objectiveTicks: number;
  objectiveDefends: number;
  coreScores: number;
  roundWins: number;
  durationSec: number;
  won: boolean;
  drew: boolean;
  mvp: boolean;
  firstWinOfDay: boolean;
  /** Applied last: 1 = normal. Used by challenges / double-XP windows. */
  multiplier: number;
}

export interface XpLine {
  label: string;
  amount: number;
}

export interface MatchXpResult {
  total: number;
  breakdown: XpLine[];
}

export function computeMatchXp(i: MatchXpInput): MatchXpResult {
  const lines: XpLine[] = [];
  const add = (label: string, amount: number) => {
    const v = Math.round(amount);
    if (v > 0) lines.push({ label, amount: v });
  };

  add('Eliminations', i.kills * XP_RATES.perKill);
  add('Assists', i.assists * XP_RATES.perAssist);
  add('Headshots', i.headshots * XP_RATES.perHeadshot);
  add('Objective captures', i.objectiveCaptures * XP_RATES.perObjectiveCapture);
  add('Objective time', i.objectiveTicks * XP_RATES.perObjectiveTick);
  add('Objective defence', i.objectiveDefends * XP_RATES.perObjectiveDefend);
  add('Core captures', i.coreScores * XP_RATES.perCoreScore);
  add('Rounds won', i.roundWins * XP_RATES.perRoundWin);
  add('Combat score', i.score * XP_RATES.perScorePoint);
  add('Match completed', XP_RATES.matchComplete);

  const minutes = Math.min(i.durationSec / 60, XP_RATES.matchTimeCapMinutes);
  add('Time played', minutes * XP_RATES.perMinute);

  if (i.drew) add('Draw', XP_RATES.draw);
  else if (i.won) add('Victory', XP_RATES.win);
  else add('Defeat', XP_RATES.loss);

  if (i.mvp) add('Match MVP', XP_RATES.mvp);
  if (i.firstWinOfDay && i.won) add('First win of the day', XP_RATES.firstWinBonus);

  let total = lines.reduce((s, l) => s + l.amount, 0);
  const mult = Number.isFinite(i.multiplier) && i.multiplier > 0 ? i.multiplier : 1;
  if (mult !== 1) {
    const bonus = Math.round(total * (mult - 1));
    if (bonus !== 0) lines.push({ label: `Bonus x${mult.toFixed(2)}`, amount: bonus });
    total += bonus;
  }
  return { total: Math.max(0, Math.round(total)), breakdown: lines };
}

// ---------------------------------------------------------------------------
// Mastery (per weapon and per class)
// ---------------------------------------------------------------------------

export const MAX_MASTERY_LEVEL = 30;

export function masteryLevel(xp: number, step: number): number {
  if (step <= 0) return 0;
  // Each level costs `step` plus 6% compounding, so mastery keeps meaning.
  let level = 0;
  let remaining = Math.max(0, xp);
  let cost = step;
  while (level < MAX_MASTERY_LEVEL && remaining >= cost) {
    remaining -= cost;
    level++;
    cost = Math.round(cost * 1.06);
  }
  return level;
}

export function masteryProgress(xp: number, step: number): { level: number; into: number; need: number; progress: number } {
  let level = 0;
  let remaining = Math.max(0, xp);
  let cost = step;
  while (level < MAX_MASTERY_LEVEL && remaining >= cost) {
    remaining -= cost;
    level++;
    cost = Math.round(cost * 1.06);
  }
  if (level >= MAX_MASTERY_LEVEL) return { level, into: 0, need: 0, progress: 1 };
  return { level, into: remaining, need: cost, progress: cost > 0 ? remaining / cost : 1 };
}

/** XP earned towards a weapon's mastery from a single match. */
export function weaponMasteryXp(kills: number, headshots: number, damage: number): number {
  return Math.round(kills * 60 + headshots * 25 + damage * 0.35);
}

/** XP earned towards a class's mastery from a single match. */
export function classMasteryXp(score: number, won: boolean, durationSec: number): number {
  return Math.round(score * 0.4 + (won ? 300 : 100) + Math.min(durationSec, 900) * 0.25);
}

// ---------------------------------------------------------------------------
// Derived career statistics
// ---------------------------------------------------------------------------

export interface CareerTotals {
  kills: number;
  deaths: number;
  assists: number;
  shotsFired: number;
  shotsHit: number;
  headshots: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  damageDealt: number;
  timePlayedSec: number;
  score: number;
  longestStreak: number;
}

export function kdRatio(t: Pick<CareerTotals, 'kills' | 'deaths'>): number {
  return t.deaths === 0 ? t.kills : t.kills / t.deaths;
}

export function accuracy(t: Pick<CareerTotals, 'shotsFired' | 'shotsHit'>): number {
  return t.shotsFired === 0 ? 0 : t.shotsHit / t.shotsFired;
}

export function headshotRate(t: Pick<CareerTotals, 'shotsHit' | 'headshots'>): number {
  return t.shotsHit === 0 ? 0 : t.headshots / t.shotsHit;
}

export function winRate(t: Pick<CareerTotals, 'wins' | 'matchesPlayed'>): number {
  return t.matchesPlayed === 0 ? 0 : t.wins / t.matchesPlayed;
}

export function scorePerMinute(t: Pick<CareerTotals, 'score' | 'timePlayedSec'>): number {
  return t.timePlayedSec === 0 ? 0 : (t.score / t.timePlayedSec) * 60;
}

// ---------------------------------------------------------------------------
// Unlock resolution
// ---------------------------------------------------------------------------

export interface UnlockRequirement {
  kind: 'level' | 'weaponMastery' | 'classMastery' | 'achievement' | 'stat';
  /** Weapon/class/achievement id, or a CareerTotals key for 'stat'. */
  target?: string;
  value: number;
}

export interface UnlockContext {
  level: number;
  weaponMastery: Record<string, number>;
  classMastery: Record<string, number>;
  achievements: Set<string>;
  totals: CareerTotals;
}

export function isUnlocked(req: UnlockRequirement | undefined, ctx: UnlockContext): boolean {
  if (!req) return true;
  switch (req.kind) {
    case 'level':
      return ctx.level >= req.value;
    case 'weaponMastery':
      return (ctx.weaponMastery[req.target ?? ''] ?? 0) >= req.value;
    case 'classMastery':
      return (ctx.classMastery[req.target ?? ''] ?? 0) >= req.value;
    case 'achievement':
      return ctx.achievements.has(req.target ?? '');
    case 'stat': {
      const key = (req.target ?? '') as keyof CareerTotals;
      return (ctx.totals[key] ?? 0) >= req.value;
    }
    default:
      return false;
  }
}

export function describeRequirement(req: UnlockRequirement | undefined): string {
  if (!req) return 'Available';
  switch (req.kind) {
    case 'level':
      return `Account level ${req.value}`;
    case 'weaponMastery':
      return `${req.target} mastery ${req.value}`;
    case 'classMastery':
      return `${req.target} mastery ${req.value}`;
    case 'achievement':
      return `Achievement: ${req.target}`;
    case 'stat':
      return `${req.value} ${req.target}`;
    default:
      return 'Locked';
  }
}
