/**
 * Progression, cosmetics, achievements, challenges and settings tests.
 *
 * The XP curve and unlock gates are player-facing promises, so they are
 * asserted rather than assumed. The "no pay-to-win" rule is also enforced here:
 * a cosmetic that gained a stat field would fail this suite.
 */

import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_ID,
  ACTIONS,
  CHALLENGE_TEMPLATES,
  CLASSES,
  CLASS_ORDER,
  COSMETICS,
  DEFAULT_COSMETICS,
  GRAPHICS_PRESETS,
  MAX_ACCOUNT_LEVEL,
  MAX_MASTERY_LEVEL,
  SETTINGS_BY_KEY,
  SETTINGS_SPEC,
  WEAPONS,
  WEAPON_ORDER,
  XP_RATES,
  accuracy,
  activeChallenges,
  applyPreset,
  classMasteryXp,
  coerceBindings,
  coerceSetting,
  coerceSettings,
  computeMatchXp,
  cosmeticsOfKind,
  dayKey,
  defaultBindings,
  defaultSettings,
  defaultUnlockedCosmetics,
  describeRequirement,
  evaluateAchievements,
  findBindingConflicts,
  headshotRate,
  isUnlocked,
  kdRatio,
  keyLabel,
  levelFromXp,
  masteryLevel,
  masteryProgress,
  rollChallenges,
  scorePerMinute,
  settingsInGroup,
  totalXpForLevel,
  weaponMasteryXp,
  weekKey,
  winRate,
  xpForLevel,
  type CareerTotals,
} from '../index.js';

const emptyTotals = (): CareerTotals => ({
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
});

describe('account level curve', () => {
  it('starts at level 1 with no XP', () => {
    const s = levelFromXp(0);
    expect(s.level).toBe(1);
    expect(s.xpIntoLevel).toBe(0);
    expect(s.progress).toBe(0);
  });

  it('increases monotonically and never skips a level', () => {
    let previous = 1;
    for (let xp = 0; xp < 400_000; xp += 977) {
      const level = levelFromXp(xp).level;
      expect(level).toBeGreaterThanOrEqual(previous);
      expect(level - previous).toBeLessThanOrEqual(1);
      previous = level;
    }
  });

  it('levels up exactly at the cumulative threshold', () => {
    for (let level = 1; level < 12; level++) {
      const need = totalXpForLevel(level + 1);
      expect(levelFromXp(need - 1).level, `just below ${level + 1}`).toBe(level);
      expect(levelFromXp(need).level, `exactly at ${level + 1}`).toBe(level + 1);
    }
  });

  it('gets progressively more expensive', () => {
    for (let level = 1; level < 40; level++) {
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
    }
  });

  it('caps at the maximum level and reports a full bar', () => {
    const s = levelFromXp(50_000_000);
    expect(s.level).toBe(MAX_ACCOUNT_LEVEL);
    expect(s.progress).toBe(1);
    expect(s.xpForNext).toBe(0);
    expect(xpForLevel(MAX_ACCOUNT_LEVEL)).toBe(Infinity);
  });

  it('reaches level 10 in a plausible number of matches', () => {
    // A decent 10-minute match is worth roughly 3-5k XP; level 10 should be
    // a handful of sessions, not a grind wall.
    const need = totalXpForLevel(10);
    expect(need / 4000).toBeGreaterThan(3);
    expect(need / 4000).toBeLessThan(20);
  });

  it('handles negative and fractional XP without breaking', () => {
    expect(levelFromXp(-500).level).toBe(1);
    expect(levelFromXp(1234.7).level).toBeGreaterThanOrEqual(1);
  });
});

describe('match XP', () => {
  const base = {
    kills: 0,
    assists: 0,
    headshots: 0,
    score: 0,
    objectiveCaptures: 0,
    objectiveTicks: 0,
    objectiveDefends: 0,
    coreScores: 0,
    roundWins: 0,
    durationSec: 600,
    won: false,
    drew: false,
    mvp: false,
    firstWinOfDay: false,
    multiplier: 1,
  };

  it('always awards something for finishing a match', () => {
    const r = computeMatchXp(base);
    expect(r.total).toBeGreaterThan(0);
    expect(r.breakdown.some((l) => l.label === 'Match completed')).toBe(true);
    expect(r.breakdown.some((l) => l.label === 'Defeat')).toBe(true);
  });

  it('pays more for a win than a loss, all else equal', () => {
    const loss = computeMatchXp({ ...base, kills: 10 });
    const win = computeMatchXp({ ...base, kills: 10, won: true });
    expect(win.total).toBeGreaterThan(loss.total);
  });

  it('scales with eliminations, assists and headshots', () => {
    const none = computeMatchXp(base).total;
    expect(computeMatchXp({ ...base, kills: 10 }).total).toBe(none + 10 * XP_RATES.perKill);
    expect(computeMatchXp({ ...base, assists: 5 }).total).toBe(none + 5 * XP_RATES.perAssist);
    expect(computeMatchXp({ ...base, headshots: 4 }).total).toBe(none + 4 * XP_RATES.perHeadshot);
  });

  it('rewards objective play', () => {
    const flat = computeMatchXp({ ...base, kills: 20 }).total;
    const objective = computeMatchXp({ ...base, kills: 5, objectiveCaptures: 4, objectiveTicks: 200 }).total;
    // Fifteen fewer kills but real objective work should stay competitive.
    expect(objective).toBeGreaterThan(flat * 0.6);
  });

  it('adds the MVP and first-win bonuses only when earned', () => {
    const plain = computeMatchXp({ ...base, won: true }).total;
    expect(computeMatchXp({ ...base, won: true, mvp: true }).total).toBe(plain + XP_RATES.mvp);
    expect(computeMatchXp({ ...base, won: true, firstWinOfDay: true }).total).toBe(plain + XP_RATES.firstWinBonus);
    // First win of the day must not pay out on a loss.
    expect(computeMatchXp({ ...base, won: false, firstWinOfDay: true }).total).toBe(computeMatchXp(base).total);
  });

  it('caps the time bonus so idling in a long match is not farmable', () => {
    const capped = computeMatchXp({ ...base, durationSec: XP_RATES.matchTimeCapMinutes * 60 }).total;
    const absurd = computeMatchXp({ ...base, durationSec: 60 * 60 * 5 }).total;
    expect(absurd).toBe(capped);
  });

  it('applies a multiplier as a separate visible line', () => {
    const single = computeMatchXp({ ...base, kills: 10 });
    const doubled = computeMatchXp({ ...base, kills: 10, multiplier: 2 });
    expect(doubled.total).toBe(single.total * 2);
    expect(doubled.breakdown.some((l) => l.label.startsWith('Bonus'))).toBe(true);
  });

  it('ignores a nonsensical multiplier', () => {
    const normal = computeMatchXp({ ...base, kills: 5 }).total;
    expect(computeMatchXp({ ...base, kills: 5, multiplier: 0 }).total).toBe(normal);
    expect(computeMatchXp({ ...base, kills: 5, multiplier: NaN }).total).toBe(normal);
    expect(computeMatchXp({ ...base, kills: 5, multiplier: -3 }).total).toBe(normal);
  });

  it('never returns a negative total', () => {
    expect(computeMatchXp({ ...base, score: -99999 }).total).toBeGreaterThanOrEqual(0);
  });

  it('breakdown lines sum to the total', () => {
    const r = computeMatchXp({ ...base, kills: 7, assists: 3, headshots: 2, score: 1200, won: true, mvp: true });
    const sum = r.breakdown.reduce((s, l) => s + l.amount, 0);
    expect(sum).toBe(r.total);
  });

  it('shows a draw instead of a win or a loss', () => {
    const r = computeMatchXp({ ...base, drew: true });
    expect(r.breakdown.some((l) => l.label === 'Draw')).toBe(true);
    expect(r.breakdown.some((l) => l.label === 'Victory' || l.label === 'Defeat')).toBe(false);
  });
});

describe('mastery', () => {
  it('starts at zero and climbs with XP', () => {
    expect(masteryLevel(0, 900)).toBe(0);
    expect(masteryLevel(900, 900)).toBe(1);
    expect(masteryLevel(1_000_000, 900)).toBe(MAX_MASTERY_LEVEL);
  });

  it('costs more per level as it goes', () => {
    const l5 = masteryProgress(masteryCost(900, 5), 900);
    const l6 = masteryProgress(masteryCost(900, 6), 900);
    expect(l5.level).toBe(5);
    expect(l6.level).toBe(6);
    expect(l6.need).toBeGreaterThan(l5.need);
  });

  it('reports a sane progress fraction', () => {
    const p = masteryProgress(1200, 900);
    expect(p.level).toBe(1);
    expect(p.progress).toBeGreaterThan(0);
    expect(p.progress).toBeLessThan(1);
    expect(p.into).toBeLessThan(p.need);
  });

  it('reports a full bar at max level', () => {
    const p = masteryProgress(10_000_000, 900);
    expect(p.level).toBe(MAX_MASTERY_LEVEL);
    expect(p.progress).toBe(1);
  });

  it('handles a zero step without dividing by zero', () => {
    expect(masteryLevel(500, 0)).toBe(0);
  });

  it('awards weapon mastery for kills, headshots and damage', () => {
    expect(weaponMasteryXp(0, 0, 0)).toBe(0);
    expect(weaponMasteryXp(5, 2, 800)).toBeGreaterThan(weaponMasteryXp(5, 0, 800));
    expect(weaponMasteryXp(5, 2, 1600)).toBeGreaterThan(weaponMasteryXp(5, 2, 800));
  });

  it('awards class mastery more for a win', () => {
    expect(classMasteryXp(1000, true, 600)).toBeGreaterThan(classMasteryXp(1000, false, 600));
  });
});

function masteryCost(step: number, targetLevel: number): number {
  let total = 0;
  let cost = step;
  for (let i = 0; i < targetLevel; i++) {
    total += cost;
    cost = Math.round(cost * 1.06);
  }
  return total;
}

describe('derived career statistics', () => {
  it('treats zero deaths as the kill count rather than dividing by zero', () => {
    expect(kdRatio({ kills: 7, deaths: 0 })).toBe(7);
    expect(kdRatio({ kills: 10, deaths: 5 })).toBe(2);
  });

  it('returns zero for accuracy and headshot rate with no shots', () => {
    expect(accuracy({ shotsFired: 0, shotsHit: 0 })).toBe(0);
    expect(headshotRate({ shotsHit: 0, headshots: 0 })).toBe(0);
  });

  it('computes rates correctly', () => {
    expect(accuracy({ shotsFired: 200, shotsHit: 50 })).toBeCloseTo(0.25, 6);
    expect(headshotRate({ shotsHit: 100, headshots: 20 })).toBeCloseTo(0.2, 6);
    expect(winRate({ wins: 3, matchesPlayed: 12 })).toBeCloseTo(0.25, 6);
    expect(scorePerMinute({ score: 6000, timePlayedSec: 600 })).toBeCloseTo(600, 6);
  });

  it('returns zero rather than NaN for an empty career', () => {
    const t = emptyTotals();
    expect(winRate(t)).toBe(0);
    expect(scorePerMinute(t)).toBe(0);
    expect(Number.isNaN(kdRatio(t))).toBe(false);
  });
});

describe('unlock requirements', () => {
  const ctx = {
    level: 10,
    weaponMastery: { pulse_ar: 5 },
    classMastery: { vanguard: 3 },
    achievements: new Set(['first_blood']),
    totals: { ...emptyTotals(), kills: 250 },
  };

  it('treats a missing requirement as already available', () => {
    expect(isUnlocked(undefined, ctx)).toBe(true);
  });

  it('gates on account level', () => {
    expect(isUnlocked({ kind: 'level', value: 10 }, ctx)).toBe(true);
    expect(isUnlocked({ kind: 'level', value: 11 }, ctx)).toBe(false);
  });

  it('gates on weapon and class mastery', () => {
    expect(isUnlocked({ kind: 'weaponMastery', target: 'pulse_ar', value: 5 }, ctx)).toBe(true);
    expect(isUnlocked({ kind: 'weaponMastery', target: 'pulse_ar', value: 6 }, ctx)).toBe(false);
    expect(isUnlocked({ kind: 'weaponMastery', target: 'rail_sniper', value: 1 }, ctx)).toBe(false);
    expect(isUnlocked({ kind: 'classMastery', target: 'vanguard', value: 3 }, ctx)).toBe(true);
  });

  it('gates on achievements and lifetime stats', () => {
    expect(isUnlocked({ kind: 'achievement', target: 'first_blood' }, ctx)).toBe(true);
    expect(isUnlocked({ kind: 'achievement', target: 'kills_1000' }, ctx)).toBe(false);
    expect(isUnlocked({ kind: 'stat', target: 'kills', value: 250 }, ctx)).toBe(true);
    expect(isUnlocked({ kind: 'stat', target: 'kills', value: 251 }, ctx)).toBe(false);
  });

  it('describes every requirement kind in words', () => {
    expect(describeRequirement(undefined)).toBe('Available');
    expect(describeRequirement({ kind: 'level', value: 12 })).toContain('12');
    expect(describeRequirement({ kind: 'stat', target: 'kills', value: 50 })).toContain('kills');
  });
});

describe('cosmetics are cosmetic only', () => {
  it('no cosmetic carries a gameplay stat', () => {
    const banned = [
      'damage',
      'health',
      'shield',
      'speed',
      'rpm',
      'magazine',
      'reload',
      'accuracy',
      'recoil',
      'range',
      'armor',
      'defense',
      'multiplier',
    ];
    for (const [id, c] of Object.entries(COSMETICS)) {
      for (const key of Object.keys(c)) {
        expect(banned, `${id} exposes "${key}"`).not.toContain(key.toLowerCase());
      }
    }
  });

  it('covers every cosmetic slot with at least three options', () => {
    for (const kind of Object.keys(DEFAULT_COSMETICS) as (keyof typeof DEFAULT_COSMETICS)[]) {
      expect(cosmeticsOfKind(kind).length, kind).toBeGreaterThanOrEqual(3);
    }
  });

  it('has a default for every slot, and every default is free', () => {
    const free = new Set(defaultUnlockedCosmetics());
    for (const [kind, id] of Object.entries(DEFAULT_COSMETICS)) {
      expect(COSMETICS[id], `${kind} default ${id} does not exist`).toBeTruthy();
      expect(free.has(id), `${kind} default ${id} is locked`).toBe(true);
    }
  });

  it('every crosshair preset is fully specified', () => {
    for (const c of cosmeticsOfKind('crosshair')) {
      expect(c.crosshair, c.id).toBeTruthy();
      expect(c.crosshair!.size, c.id).toBeGreaterThan(0);
      expect(c.crosshair!.thickness, c.id).toBeGreaterThan(0);
      expect(c.crosshair!.color, c.id).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('every unlockable cosmetic states a reachable requirement', () => {
    for (const [id, c] of Object.entries(COSMETICS)) {
      if (!c.unlock) continue;
      if (c.unlock.kind === 'level') expect(c.unlock.value, id).toBeLessThanOrEqual(MAX_ACCOUNT_LEVEL);
      if (c.unlock.kind === 'achievement') expect(ACHIEVEMENTS_BY_ID[c.unlock.target ?? ''], id).toBeTruthy();
      if (c.unlock.kind === 'weaponMastery' || c.unlock.kind === 'classMastery') {
        expect(c.unlock.value, id).toBeLessThanOrEqual(MAX_MASTERY_LEVEL);
      }
    }
  });
});

describe('achievements', () => {
  it('are all well formed and uniquely identified', () => {
    const ids = new Set<string>();
    for (const a of ACHIEVEMENTS) {
      expect(ids.has(a.id), `duplicate ${a.id}`).toBe(false);
      ids.add(a.id);
      expect(a.name.length).toBeGreaterThan(2);
      expect(a.description.length).toBeGreaterThan(10);
      expect(a.target).toBeGreaterThan(0);
      expect(a.xpReward).toBeGreaterThan(0);
      if (a.unlocks) expect(COSMETICS[a.unlocks], `${a.id} unlocks unknown ${a.unlocks}`).toBeTruthy();
      if (a.scope?.kind === 'class') expect(CLASS_ORDER).toContain(a.scope.id);
      if (a.scope?.kind === 'weapon') expect(WEAPON_ORDER).toContain(a.scope.id);
    }
  });

  it('reports progress and completion from counters', () => {
    const { progress, newlyCompleted } = evaluateAchievements({ kills: 1 }, new Set());
    const first = progress.find((p) => p.id === 'first_blood')!;
    expect(first.complete).toBe(true);
    expect(newlyCompleted.map((a) => a.id)).toContain('first_blood');
    const big = progress.find((p) => p.id === 'kills_5000')!;
    expect(big.complete).toBe(false);
    expect(big.progress).toBeLessThan(0.01);
  });

  it('does not re-award something already completed', () => {
    const { newlyCompleted } = evaluateAchievements({ kills: 1 }, new Set(['first_blood']));
    expect(newlyCompleted.map((a) => a.id)).not.toContain('first_blood');
  });

  it('clamps reported progress to the target', () => {
    const { progress } = evaluateAchievements({ kills: 999999 }, new Set());
    for (const p of progress) {
      expect(p.current).toBeLessThanOrEqual(p.target);
      expect(p.progress).toBeLessThanOrEqual(1);
    }
  });

  it('has escalating tiers for the same counter', () => {
    const killTiers = ACHIEVEMENTS.filter((a) => a.counter === 'kills').sort((a, b) => a.target - b.target);
    expect(killTiers.length).toBeGreaterThan(3);
    for (let i = 1; i < killTiers.length; i++) {
      expect(killTiers[i].target).toBeGreaterThan(killTiers[i - 1].target);
      expect(killTiers[i].xpReward).toBeGreaterThanOrEqual(killTiers[i - 1].xpReward);
    }
  });
});

describe('challenges', () => {
  const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

  it('produces a stable set for the same player and period', () => {
    const a = rollChallenges('player-1', 'daily', dayKey(NOW), 3);
    const b = rollChallenges('player-1', 'daily', dayKey(NOW), 3);
    expect(a.map((c) => c.templateId)).toEqual(b.map((c) => c.templateId));
  });

  it('gives different players different challenges', () => {
    const a = rollChallenges('player-1', 'daily', dayKey(NOW), 3);
    const b = rollChallenges('player-2', 'daily', dayKey(NOW), 3);
    // Not guaranteed to differ entirely, but the full set should not match.
    expect(a.map((c) => c.templateId).join()).not.toBe(b.map((c) => c.templateId).join());
  });

  it('rotates between days', () => {
    const today = rollChallenges('p', 'daily', dayKey(NOW), 3);
    const tomorrow = rollChallenges('p', 'daily', dayKey(NOW + 86400000), 3);
    expect(today.map((c) => c.templateId).join()).not.toBe(tomorrow.map((c) => c.templateId).join());
  });

  it('never repeats a template within one roll', () => {
    for (const player of ['a', 'b', 'c', 'd', 'e']) {
      const rolled = rollChallenges(player, 'daily', dayKey(NOW), 3);
      expect(new Set(rolled.map((c) => c.templateId)).size).toBe(rolled.length);
    }
  });

  it('scales weekly targets and rewards above daily', () => {
    const daily = rollChallenges('p', 'daily', dayKey(NOW), 3);
    const weekly = rollChallenges('p', 'weekly', weekKey(NOW), 3);
    for (const w of weekly) {
      const template = CHALLENGE_TEMPLATES.find((t) => t.id === w.templateId)!;
      expect(w.target).toBeGreaterThan(template.target);
      expect(w.xpReward).toBeGreaterThan(template.xpReward);
    }
    expect(daily.length).toBe(3);
  });

  it('returns both daily and weekly sets with unique keys', () => {
    const all = activeChallenges('player-1', NOW);
    expect(all.length).toBe(6);
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length);
    expect(all.filter((c) => c.period === 'daily')).toHaveLength(3);
    expect(all.filter((c) => c.period === 'weekly')).toHaveLength(3);
  });

  it('substitutes the target into the description', () => {
    for (const c of activeChallenges('p', NOW)) {
      expect(c.description).not.toContain('{n}');
      expect(c.description).toContain(String(c.target));
    }
  });

  it('produces stable period keys in UTC', () => {
    expect(dayKey(Date.UTC(2026, 0, 5))).toBe('2026-01-05');
    expect(weekKey(Date.UTC(2026, 0, 5))).toMatch(/^\d{4}-W\d{2}$/);
    // Same day, different times of day, must be the same key.
    expect(dayKey(Date.UTC(2026, 0, 5, 1))).toBe(dayKey(Date.UTC(2026, 0, 5, 23)));
  });
});

describe('settings schema', () => {
  it('has a default for every declared setting', () => {
    const defaults = defaultSettings();
    for (const spec of SETTINGS_SPEC) {
      expect(defaults[spec.key], spec.key).not.toBeUndefined();
      expect(SETTINGS_BY_KEY[spec.key]).toBe(spec);
    }
  });

  it('declares every accessibility and control option the game promises', () => {
    const keys = new Set(SETTINGS_SPEC.map((s) => s.key));
    for (const required of [
      'sensitivity',
      'adsSensitivityMultiplier',
      'invertY',
      'rawInput',
      'holdToAim',
      'holdToCrouch',
      'resolutionScale',
      'textureQuality',
      'shadowQuality',
      'effectsQuality',
      'antialiasing',
      'vsync',
      'fpsLimit',
      'fov',
      'viewModelFov',
      'motionBlur',
      'screenShake',
      'showFps',
      'preset',
      'masterVolume',
      'musicVolume',
      'sfxVolume',
      'voiceVolume',
      'uiVolume',
      'colorblindMode',
      'subtitles',
      'reducedMotion',
      'flashReduction',
      'headBob',
      'enemyOutlines',
      'uiScale',
    ]) {
      expect(keys.has(required), `missing setting: ${required}`).toBe(true);
    }
  });

  it('groups every setting into a real tab', () => {
    const groups = ['controls', 'graphics', 'audio', 'accessibility', 'gameplay'] as const;
    let counted = 0;
    for (const g of groups) counted += settingsInGroup(g).length;
    expect(counted).toBe(SETTINGS_SPEC.length);
  });

  it('clamps sliders to their declared range', () => {
    expect(coerceSetting('sensitivity', 999)).toBe(SETTINGS_BY_KEY.sensitivity.max);
    expect(coerceSetting('sensitivity', -5)).toBe(SETTINGS_BY_KEY.sensitivity.min);
    expect(coerceSetting('fov', 100)).toBe(100);
  });

  it('rejects a value of the wrong type and falls back to the default', () => {
    expect(coerceSetting('invertY', 'yes')).toBe(false);
    expect(coerceSetting('sensitivity', 'fast')).toBe(SETTINGS_BY_KEY.sensitivity.default);
    expect(coerceSetting('colorblindMode', 'not-a-mode')).toBe('off');
    expect(coerceSetting('crosshairColor', 'red')).toBe('#7dffd0');
    expect(coerceSetting('crosshairColor', '#ABCDEF')).toBe('#ABCDEF');
  });

  it('drops unknown keys entirely rather than storing junk', () => {
    expect(coerceSetting('definitely_not_a_setting', 1)).toBeUndefined();
    const coerced = coerceSettings({ sensitivity: 2, hacks: true, aimbot: 'on' });
    expect(coerced.sensitivity).toBe(2);
    expect('hacks' in coerced).toBe(false);
    expect('aimbot' in coerced).toBe(false);
  });

  it('fills in defaults for a partial or invalid blob', () => {
    const fromNothing = coerceSettings(undefined);
    expect(Object.keys(fromNothing).length).toBe(SETTINGS_SPEC.length);
    expect(coerceSettings('a string').fov).toBe(SETTINGS_BY_KEY.fov.default);
    expect(coerceSettings(null).fov).toBe(SETTINGS_BY_KEY.fov.default);
  });

  it('round-trips a full settings object unchanged (persistence)', () => {
    const original = defaultSettings();
    original.sensitivity = 2.75;
    original.fov = 110;
    original.headBob = false;
    original.colorblindMode = 'deuteranopia';
    const revived = coerceSettings(JSON.parse(JSON.stringify(original)));
    expect(revived).toEqual(original);
  });

  it('applies a graphics preset across every affected key', () => {
    const applied = applyPreset(defaultSettings(), 'low');
    for (const [key, value] of Object.entries(GRAPHICS_PRESETS.low)) {
      expect(applied[key], key).toBe(value);
    }
    expect(applied.preset).toBe('low');
  });

  it('has presets that genuinely differ in cost', () => {
    expect(Number(GRAPHICS_PRESETS.low.resolutionScale)).toBeLessThan(Number(GRAPHICS_PRESETS.ultra.resolutionScale));
    expect(Number(GRAPHICS_PRESETS.low.drawDistance)).toBeLessThan(Number(GRAPHICS_PRESETS.ultra.drawDistance));
    expect(GRAPHICS_PRESETS.low.shadowQuality).toBe('off');
    expect(GRAPHICS_PRESETS.ultra.shadowQuality).toBe('high');
  });

  it('ignores an unknown preset', () => {
    const before = defaultSettings();
    expect(applyPreset(before, 'nonsense')).toBe(before);
  });
});

describe('key bindings', () => {
  it('binds every action by default with no conflicts', () => {
    const bindings = defaultBindings();
    expect(Object.keys(bindings).length).toBe(ACTIONS.length);
    for (const action of ACTIONS) expect(bindings[action.id], action.id).toBeTruthy();
    expect(findBindingConflicts(bindings)).toEqual([]);
  });

  it('covers movement, combat, utility and social actions', () => {
    for (const category of ['movement', 'combat', 'utility', 'social'] as const) {
      expect(ACTIONS.filter((a) => a.category === category).length, category).toBeGreaterThan(0);
    }
  });

  it('rejects unknown actions and malformed codes', () => {
    const coerced = coerceBindings({ forward: 'KeyZ', notAnAction: 'KeyQ', jump: 42, fire: '' });
    expect(coerced.forward).toBe('KeyZ');
    expect('notAnAction' in coerced).toBe(false);
    expect(coerced.jump).toBe('Space');
    expect(coerced.fire).toBe('Mouse0');
  });

  it('detects a deliberate conflict', () => {
    const bindings = defaultBindings();
    bindings.jump = 'KeyW';
    const conflicts = findBindingConflicts(bindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].actions.sort()).toEqual(['forward', 'jump']);
  });

  it('renders human-readable key labels', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('ControlLeft')).toBe('L Ctrl');
    expect(keyLabel('Mouse0')).toBe('Left Click');
    expect(keyLabel('Mouse2')).toBe('Right Click');
    expect(keyLabel('WheelUp')).toBe('Wheel Up');
    expect(keyLabel('F7')).toBe('F7');
  });

  it('round-trips bindings through JSON (persistence)', () => {
    const bindings = defaultBindings();
    bindings.forward = 'KeyI';
    bindings.reload = 'KeyP';
    expect(coerceBindings(JSON.parse(JSON.stringify(bindings)))).toEqual(bindings);
  });
});

describe('class balance', () => {
  it('has six classes, each with a passive, ability and ultimate', () => {
    expect(CLASS_ORDER).toHaveLength(6);
    for (const id of CLASS_ORDER) {
      const c = CLASSES[id];
      expect(c.passive.description.length, id).toBeGreaterThan(20);
      expect(c.ability.cooldown, id).toBeGreaterThan(0);
      expect(c.ultimate.cooldown, id).toBeGreaterThan(c.ability.cooldown);
      expect(c.defaultLoadout.primary, id).toBeTruthy();
      expect(WEAPONS[c.defaultLoadout.primary], id).toBeTruthy();
      expect(WEAPONS[c.defaultLoadout.secondary].slot, id).toBe('secondary');
      expect(WEAPONS[c.defaultLoadout.melee].slot, id).toBe('melee');
    }
  });

  it('trades effective health against mobility', () => {
    // The tankiest class must not also be the fastest.
    const byHealth = [...CLASS_ORDER].sort((a, b) => CLASSES[b].health - CLASSES[a].health);
    const bySpeed = [...CLASS_ORDER].sort((a, b) => CLASSES[b].move.speedScale - CLASSES[a].move.speedScale);
    expect(byHealth[0]).not.toBe(bySpeed[0]);
    expect(CLASSES.titan.health).toBeGreaterThan(CLASSES.phantom.health);
    expect(CLASSES.phantom.move.speedScale).toBeGreaterThan(CLASSES.titan.move.speedScale);
  });

  it('keeps every class inside a sane effective-health band', () => {
    for (const id of CLASS_ORDER) {
      const ehp = CLASSES[id].health + CLASSES[id].shield;
      expect(ehp, id).toBeGreaterThanOrEqual(95);
      expect(ehp, id).toBeLessThanOrEqual(200);
    }
  });

  it('unlocks at levels a new player can reach', () => {
    for (const id of CLASS_ORDER) {
      expect(CLASSES[id].unlockLevel, id).toBeLessThanOrEqual(12);
    }
    // At least two classes must be available immediately.
    expect(CLASS_ORDER.filter((id) => CLASSES[id].unlockLevel === 0).length).toBeGreaterThanOrEqual(2);
  });
});
