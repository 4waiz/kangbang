/**
 * Server match, mode and scoring tests.
 *
 * These drive the real Match simulation with real ServerPlayers and real bots -
 * no mocks - so they exercise the same code path a live game does. Every game
 * mode's win condition is played out to completion, which is the only way to
 * know a mode actually ends rather than running forever.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS_BY_ID,
  BodyPart,
  Btn,
  DamageCause,
  EvType,
  MatchPhase,
  RESPAWN_PROTECTION,
  TICK_DT,
  Team,
  getMode,
  type InputCommand,
} from '@kang/shared';
import { Match } from '../game/match.js';
import { ServerPlayer, defaultLoadoutFor } from '../game/player.js';
import { BotController, botClassFor, botName } from '../game/bots.js';
import { MemoryDatabase } from '../db/memory.js';
import { awardMatch, buildResultRow } from '../game/progression.js';

let clock = 1_000_000;
const now = () => clock;
const advance = (ms: number) => (clock += ms);

function makeMatch(mode: string, map = 'neon_foundry', custom?: Record<string, unknown>): Match {
  return new Match({ mode, map, custom: custom as never });
}

function addPlayer(match: Match, name: string, team: number, classId = 'vanguard'): ServerPlayer {
  const id = match.allocateEntityId();
  const p = new ServerPlayer(id, `profile:${name}`, name, defaultLoadoutFor(classId));
  p.team = team;
  match.addPlayer(p);
  return p;
}

function idle(p: ServerPlayer, over: Partial<InputCommand> = {}): InputCommand {
  return {
    seq: ++p.highestSeq,
    dt: TICK_DT,
    moveX: 0,
    moveZ: 0,
    yaw: p.move.yaw,
    pitch: 0,
    buttons: 0,
    slot: p.slot,
    shotSeed: 0,
    ...over,
  };
}

/** Advance the match by `seconds` of simulated time. */
function run(match: Match, seconds: number, perTick?: (tick: number) => void): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    perTick?.(i);
    advance(TICK_DT * 1000);
    match.step(TICK_DT, now());
    match.drainEvents();
  }
}

beforeEach(() => {
  clock = 1_000_000;
});

// ---------------------------------------------------------------------------

describe('match lifecycle', () => {
  it('starts in warmup and spawns nobody until told to', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'A', Team.Ion);
    expect(match.phase).toBe(MatchPhase.Warmup);
    expect(p.alive).toBe(false);
  });

  it('spawns everyone, resets scores and goes live on begin()', () => {
    const match = makeMatch('tdm');
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    a.kills = 99;
    a.score = 12345;
    match.begin(now());
    expect(match.phase).toBe(MatchPhase.Live);
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
    expect(a.kills).toBe(0);
    expect(a.score).toBe(0);
    expect(match.teamScores).toEqual([0, 0]);
  });

  it('spawns players apart from each other', () => {
    const match = makeMatch('tdm');
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    const dist = Math.hypot(a.move.pos.x - b.move.pos.x, a.move.pos.z - b.move.pos.z);
    expect(dist).toBeGreaterThan(20);
  });

  it('grants spawn protection that expires', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    expect(p.protectionTimer).toBeCloseTo(RESPAWN_PROTECTION, 2);
    run(match, RESPAWN_PROTECTION + 0.5);
    expect(p.protectionTimer).toBe(0);
  });

  it('counts the match clock down and ends the match at zero', () => {
    const match = makeMatch('tdm', 'neon_foundry', { mode: 'tdm', timeLimitSec: 2, scoreLimit: 9999 });
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    expect(match.timeRemaining).toBeCloseTo(2, 1);
    // Break the tie so the clock ends the match instead of forcing overtime.
    b.protectionTimer = 0;
    match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    run(match, 3);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.resultsPending).toBe(true);
    expect(match.winningTeam).toBe(Team.Ion);
  });

  it('goes to overtime rather than ending a tied match', () => {
    const match = makeMatch('tdm', 'neon_foundry', { mode: 'tdm', timeLimitSec: 2, scoreLimit: 9999 });
    addPlayer(match, 'A', Team.Ion);
    addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    run(match, 3);
    expect(match.phase).toBe(MatchPhase.Overtime);
    expect(match.overtime).toBe(true);
    expect(match.timeRemaining).toBeGreaterThan(0);
  });

  it('ends a still-tied overtime as a draw', () => {
    const match = makeMatch('tdm', 'neon_foundry', { mode: 'tdm', timeLimitSec: 1, scoreLimit: 9999 });
    addPlayer(match, 'A', Team.Ion);
    addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    run(match, 2);
    expect(match.phase).toBe(MatchPhase.Overtime);
    run(match, getMode('tdm').overtimeSec + 1);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.winningTeam).toBe(Team.None);
  });

  it('honours a custom score limit instead of the mode default', () => {
    const match = makeMatch('custom', 'neon_foundry', { mode: 'tdm', scoreLimit: 2 });
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    expect(match.effectiveScoreLimit).toBe(2);
    expect(getMode('tdm').scoreLimit).toBeGreaterThan(2);
    match.begin(now());
    for (let i = 0; i < 2; i++) {
      if (!b.alive) match.spawnPlayer(b, now());
      b.protectionTimer = 0;
      match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    }
    run(match, 0.1);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.winningTeam).toBe(Team.Ion);
  });

  it('honours a custom respawn delay and friendly fire toggle', () => {
    const match = makeMatch('custom', 'neon_foundry', { mode: 'tdm', respawnDelay: 0.25, friendlyFire: true });
    const a = addPlayer(match, 'A', Team.Ion);
    const ally = addPlayer(match, 'Ally', Team.Ion);
    match.begin(now());
    ally.protectionTimer = 0;
    match.damagePlayer(ally, a, 40, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(ally.shield + ally.health).toBeLessThan(ally.maxShield + ally.maxHealth);
    match.damagePlayer(ally, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(ally.respawnTimer).toBeCloseTo(0.25, 3);
    run(match, 0.6);
    expect(ally.alive).toBe(true);
  });

  it('is playable during warmup: players spawn, take damage and respawn', () => {
    const match = makeMatch('tdm');
    const a = addPlayer(match, 'A', Team.Ion);
    match.spawnPlayer(a, now());
    expect(a.alive).toBe(true);
    a.protectionTimer = 0;
    match.damagePlayer(a, null, 9999, DamageCause.Fall, null, 'pulse_ar', now(), false);
    expect(a.alive).toBe(false);
    // Warmup must run respawns or the player is stuck on a death screen.
    run(match, getMode('tdm').respawnDelay + 1.5);
    expect(a.alive).toBe(true);
  });
});

describe('damage and death', () => {
  let match: Match;
  let attacker: ServerPlayer;
  let victim: ServerPlayer;

  beforeEach(() => {
    match = makeMatch('tdm');
    attacker = addPlayer(match, 'Attacker', Team.Ion);
    victim = addPlayer(match, 'Victim', Team.Ember);
    match.begin(now());
    attacker.protectionTimer = 0;
    victim.protectionTimer = 0;
  });

  it('takes shield before health', () => {
    const shield = victim.shield;
    expect(shield).toBeGreaterThan(0);
    match.damagePlayer(victim, attacker, 10, DamageCause.Weapon, BodyPart.Torso, 'pulse_ar', now(), true);
    expect(victim.shield).toBe(shield - 10);
    expect(victim.health).toBe(victim.maxHealth);
  });

  it('kills, credits the attacker and starts a respawn timer', () => {
    match.damagePlayer(victim, attacker, 9999, DamageCause.Weapon, BodyPart.Head, 'pulse_ar', now(), true);
    expect(victim.alive).toBe(false);
    expect(victim.deaths).toBe(1);
    expect(attacker.kills).toBe(1);
    expect(attacker.score).toBeGreaterThan(0);
    expect(victim.respawnTimer).toBeGreaterThan(0);
    expect(match.killFeed).toHaveLength(1);
    expect(match.killFeed[0].attacker).toBe('Attacker');
    expect(match.killFeed[0].victim).toBe('Victim');
    expect(match.killFeed[0].headshot).toBe(true);
  });

  it('respawns the victim after the delay', () => {
    match.damagePlayer(victim, attacker, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    run(match, getMode('tdm').respawnDelay + 1);
    expect(victim.alive).toBe(true);
    expect(victim.health).toBe(victim.maxHealth);
  });

  it('ignores damage to a spawn-protected player', () => {
    victim.protectionTimer = 1;
    match.damagePlayer(victim, attacker, 500, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(victim.health).toBe(victim.maxHealth);
    expect(victim.alive).toBe(true);
  });

  it('blocks friendly fire by default', () => {
    const ally = addPlayer(match, 'Ally', Team.Ion);
    match.spawnPlayer(ally, now());
    ally.protectionTimer = 0;
    match.damagePlayer(ally, attacker, 50, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(ally.health).toBe(ally.maxHealth);
  });

  it('tracks streaks and resets them on death', () => {
    for (let i = 0; i < 3; i++) {
      match.damagePlayer(victim, attacker, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
      match.spawnPlayer(victim, now());
      victim.protectionTimer = 0;
    }
    expect(attacker.kills).toBe(3);
    expect(attacker.streak).toBe(3);
    expect(attacker.longestStreak).toBe(3);
    match.damagePlayer(attacker, victim, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(attacker.streak).toBe(0);
    expect(attacker.longestStreak).toBe(3);
  });

  it('awards an assist to a third party who did damage recently', () => {
    const helper = addPlayer(match, 'Helper', Team.Ion);
    match.spawnPlayer(helper, now());
    match.damagePlayer(victim, helper, 30, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    advance(500);
    match.damagePlayer(victim, attacker, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(helper.assists).toBe(1);
    expect(attacker.assists).toBe(0);
  });

  it('does not award an assist after the window has passed', () => {
    const helper = addPlayer(match, 'Helper', Team.Ion);
    match.spawnPlayer(helper, now());
    match.damagePlayer(victim, helper, 30, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    advance(20_000);
    match.damagePlayer(victim, attacker, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    expect(helper.assists).toBe(0);
  });

  it('penalises a self-inflicted death instead of rewarding it', () => {
    victim.score = 500;
    match.damagePlayer(victim, null, 9999, DamageCause.OutOfBounds, null, 'pulse_ar', now(), true);
    expect(victim.deaths).toBe(1);
    expect(victim.score).toBeLessThan(500);
    expect(match.killFeed[0].attacker).toBe('');
  });

  it('records contextual counters used by achievements', () => {
    victim.move.pos.x = attacker.move.pos.x + 90;
    match.damagePlayer(victim, attacker, 9999, DamageCause.Weapon, BodyPart.Head, 'pulse_ar', now(), true, false, 90);
    expect(attacker.counters.kills).toBe(1);
    expect(attacker.counters.longshotKills).toBe(1);
    expect(attacker.counters.headshots).toBeGreaterThan(0);
  });
});

describe('weapon firing through the authority', () => {
  it('consumes ammo, respects the fire rate and reloads', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    const w = p.weapon;
    const magazine = w.def.magazine;
    expect(w.ammo).toBe(magazine);

    // Hold fire until the magazine runs dry. The magazine must not fire more
    // rounds than it holds before the reload kicks in.
    let emptiedAfterShots = -1;
    run(match, 6, () => {
      if (emptiedAfterShots < 0 && w.ammo === 0) emptiedAfterShots = w.shotsFired;
      p.pendingInputs.push(idle(p, { buttons: Btn.Fire }));
    });
    expect(emptiedAfterShots, 'magazine never emptied').toBeGreaterThan(0);
    expect(emptiedAfterShots).toBe(magazine);

    // Release and let the auto-reload finish: rounds come out of the reserve.
    run(match, 4, () => p.pendingInputs.push(idle(p)));
    expect(p.weapon.ammo).toBeGreaterThan(0);
    expect(p.weapon.reserve).toBeLessThan(w.def.reserve);
    expect(p.weapon.ammo + p.weapon.reserve).toBeLessThanOrEqual(magazine + w.def.reserve);
  });

  it('never fires faster than the weapon allows', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    const rpm = p.weapon.def.rpm;
    const seconds = 3;
    run(match, seconds, () => p.pendingInputs.push(idle(p, { buttons: Btn.Fire })));
    const maxShots = Math.ceil((rpm / 60) * seconds) + 2;
    expect(p.weapon.shotsFired).toBeLessThanOrEqual(maxShots);
  });

  it('cannot fire while dead', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    p.protectionTimer = 0;
    match.damagePlayer(p, null, 9999, DamageCause.Fall, null, 'pulse_ar', now(), false);
    const before = p.weapon.shotsFired;
    run(match, 1, () => p.pendingInputs.push(idle(p, { buttons: Btn.Fire })));
    expect(p.weapon.shotsFired).toBe(before);
  });
});

describe('anti-cheat', () => {
  it('clamps an impossible speed and flags it', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Cheater', Team.Ion);
    match.begin(now());
    p.move.vel.x = 400;
    p.move.vel.z = 400;
    run(match, 0.2, () => p.pendingInputs.push(idle(p)));
    expect(Math.hypot(p.move.vel.x, p.move.vel.z)).toBeLessThan(40);
    expect(p.suspicion).toBeGreaterThan(0);
    expect(p.violations.speed).toBeGreaterThan(0);
  });

  it('reverts a teleport and flags it heavily', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Cheater', Team.Ion);
    match.begin(now());
    const before = { ...p.move.pos };
    // A single step cannot move the player 500 metres.
    p.move.vel.x = 30000;
    run(match, TICK_DT, () => p.pendingInputs.push(idle(p)));
    const moved = Math.hypot(p.move.pos.x - before.x, p.move.pos.z - before.z);
    expect(moved).toBeLessThan(10);
    expect(p.suspicion).toBeGreaterThan(10);
  });

  it('rejects a command with non-finite angles', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Cheater', Team.Ion);
    match.begin(now());
    const before = { ...p.move.pos };
    p.pendingInputs.push(idle(p, { yaw: NaN }));
    run(match, TICK_DT);
    expect(p.move.pos.x).toBe(before.x);
    expect(p.violations['nan-angles']).toBeGreaterThan(0);
  });

  it('drops a banked input backlog instead of letting it run', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Cheater', Team.Ion);
    match.begin(now());
    for (let i = 0; i < 200; i++) p.pendingInputs.push(idle(p, { moveZ: 1, buttons: Btn.Sprint }));
    run(match, TICK_DT * 2);
    expect(p.pendingInputs.length).toBeLessThan(40);
  });

  it('allows a legitimate ability dash above walking speed', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'A', Team.Ion, 'vanguard');
    match.begin(now());
    p.pendingInputs.push(idle(p, { moveZ: 1, buttons: Btn.Sprint }));
    run(match, 1.5, () => p.pendingInputs.push(idle(p, { moveZ: 1, buttons: Btn.Sprint })));
    const suspicionBefore = p.suspicion;
    p.pendingInputs.push(idle(p, { moveZ: 1, buttons: Btn.Sprint | Btn.Ability }));
    run(match, 0.4, () => p.pendingInputs.push(idle(p, { moveZ: 1, buttons: Btn.Sprint })));
    // The dash must not be treated as speed hacking.
    expect(p.suspicion).toBe(suspicionBefore);
  });
});

describe('team deathmatch', () => {
  it('adds a team point per kill and ends at the score limit', () => {
    const match = makeMatch('tdm', 'neon_foundry', { mode: 'tdm', scoreLimit: 3 });
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    b.protectionTimer = 0;
    for (let i = 0; i < 3; i++) {
      match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
      match.spawnPlayer(b, now());
      b.protectionTimer = 0;
    }
    expect(match.teamScores[0]).toBe(3);
    run(match, 0.1);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.winningTeam).toBe(Team.Ion);
  });

  it('does not credit a team point for a suicide', () => {
    const match = makeMatch('tdm');
    const a = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    a.protectionTimer = 0;
    match.damagePlayer(a, null, 9999, DamageCause.OutOfBounds, null, 'pulse_ar', now(), true);
    expect(match.teamScores).toEqual([0, 0]);
  });
});

describe('free for all', () => {
  it('ends when a single player reaches the kill limit', () => {
    const match = makeMatch('ffa', 'neon_foundry', { mode: 'ffa', scoreLimit: 4 });
    const a = addPlayer(match, 'A', Team.None);
    const b = addPlayer(match, 'B', Team.None);
    match.begin(now());
    b.protectionTimer = 0;
    for (let i = 0; i < 4; i++) {
      match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
      match.spawnPlayer(b, now());
      b.protectionTimer = 0;
    }
    run(match, 0.1);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.rules.leader(match)?.name).toBe('A');
  });
});

describe('domination', () => {
  it('creates exactly three zones from the map', () => {
    const match = makeMatch('domination');
    expect(match.objectives).toHaveLength(3);
    expect(match.objectives.every((o) => o.kind === 'zone')).toBe(true);
    expect(match.objectives.every((o) => o.owner === Team.None)).toBe(true);
  });

  it('captures a zone when a team stands in it alone, and scores over time', () => {
    const match = makeMatch('domination');
    const p = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    const zone = match.objectives[0];
    // Teleport onto the objective and hold it.
    p.move.pos.x = zone.x;
    p.move.pos.y = zone.y;
    p.move.pos.z = zone.z;
    run(match, 10, () => {
      p.move.pos.x = zone.x;
      p.move.pos.y = zone.y;
      p.move.pos.z = zone.z;
      p.pendingInputs.push(idle(p));
    });
    expect(zone.owner).toBe(Team.Ion);
    expect(match.teamScores[0]).toBeGreaterThan(0);
    expect(p.objectiveScore).toBeGreaterThan(0);
    expect(p.counters.objectiveCaptures).toBeGreaterThanOrEqual(1);
  });

  it('does not capture while contested by both teams', () => {
    const match = makeMatch('domination');
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    const zone = match.objectives[0];
    run(match, 12, () => {
      for (const p of [a, b]) {
        p.move.pos.x = zone.x;
        p.move.pos.y = zone.y;
        p.move.pos.z = zone.z;
        p.pendingInputs.push(idle(p));
      }
    });
    expect(zone.owner).toBe(Team.None);
    expect(zone.contestedBy).toBe(3);
  });

  it('ends the match at the tick limit', () => {
    const match = makeMatch('domination', 'neon_foundry', { mode: 'domination', scoreLimit: 5 });
    const p = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    const zone = match.objectives[0];
    run(match, 30, () => {
      p.move.pos.x = zone.x;
      p.move.pos.y = zone.y;
      p.move.pos.z = zone.z;
      p.pendingInputs.push(idle(p));
    });
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.winningTeam).toBe(Team.Ion);
  });
});

describe('hardpoint', () => {
  it('activates exactly one point at a time and rotates it', () => {
    const match = makeMatch('hardpoint', 'neon_foundry', { mode: 'hardpoint' });
    const active = () => match.objectives.filter((o) => o.active);
    expect(active()).toHaveLength(1);
    const first = active()[0].id;
    addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    expect(active()).toHaveLength(1);
    run(match, getMode('hardpoint').rotationSec + 1);
    expect(active()).toHaveLength(1);
    expect(active()[0].id).not.toBe(first);
  });

  it('ticks score only for the team holding the active point', () => {
    const match = makeMatch('hardpoint');
    const a = addPlayer(match, 'A', Team.Ion);
    match.begin(now());
    const point = match.objectives.find((o) => o.active)!;
    run(match, 6, () => {
      a.move.pos.x = point.x;
      a.move.pos.y = point.y;
      a.move.pos.z = point.z;
      a.pendingInputs.push(idle(a));
    });
    expect(match.teamScores[0]).toBeGreaterThan(0);
    expect(match.teamScores[1]).toBe(0);
  });
});

describe('capture the core', () => {
  it('sets up one core per team at home', () => {
    const match = makeMatch('core');
    expect(match.objectives).toHaveLength(2);
    expect(match.objectives.every((o) => o.atHome)).toBe(true);
    expect(new Set(match.objectives.map((o) => o.team))).toEqual(new Set([Team.Ion, Team.Ember]));
  });

  it('lets an enemy steal a core and score it at their own reactor', () => {
    const match = makeMatch('core', 'neon_foundry', { mode: 'core', scoreLimit: 1 });
    const thief = addPlayer(match, 'Thief', Team.Ember);
    match.begin(now());
    const ionCore = match.objectives.find((o) => o.team === Team.Ion)!;
    const emberHome = match.objectives.find((o) => o.team === Team.Ember)!;

    // Walk onto the Ion core to pick it up.
    run(match, 0.5, () => {
      thief.move.pos.x = ionCore.x;
      thief.move.pos.y = ionCore.y;
      thief.move.pos.z = ionCore.z;
      thief.pendingInputs.push(idle(thief));
    });
    expect(ionCore.carrier).toBe(thief.id);
    expect(thief.carryingCore).toBe(true);

    // Carry it home.
    run(match, 0.5, () => {
      thief.move.pos.x = emberHome.homeX ?? emberHome.x;
      thief.move.pos.y = emberHome.y;
      thief.move.pos.z = emberHome.homeZ ?? emberHome.z;
      thief.pendingInputs.push(idle(thief));
    });
    expect(match.teamScores[1]).toBeGreaterThanOrEqual(1);
    expect(thief.counters.coreScores).toBe(1);
    expect(ionCore.atHome).toBe(true);
    expect(ionCore.carrier).toBe(-1);
  });

  it('drops the core when the carrier dies', () => {
    const match = makeMatch('core');
    const thief = addPlayer(match, 'Thief', Team.Ember);
    const guard = addPlayer(match, 'Guard', Team.Ion);
    match.begin(now());
    thief.protectionTimer = 0;
    const ionCore = match.objectives.find((o) => o.team === Team.Ion)!;
    run(match, 0.5, () => {
      thief.move.pos.x = ionCore.x;
      thief.move.pos.y = ionCore.y;
      thief.move.pos.z = ionCore.z;
      thief.pendingInputs.push(idle(thief));
    });
    expect(ionCore.carrier).toBe(thief.id);
    match.damagePlayer(thief, guard, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    run(match, 0.1);
    expect(ionCore.carrier).toBe(-1);
    expect(ionCore.atHome).toBe(false);
    expect(thief.carryingCore).toBe(false);
  });

  it('returns a dropped core after its timer', () => {
    const match = makeMatch('core');
    const thief = addPlayer(match, 'Thief', Team.Ember);
    match.begin(now());
    thief.protectionTimer = 0;
    const ionCore = match.objectives.find((o) => o.team === Team.Ion)!;
    run(match, 0.5, () => {
      thief.move.pos.x = ionCore.x;
      thief.move.pos.y = ionCore.y;
      thief.move.pos.z = ionCore.z;
      thief.pendingInputs.push(idle(thief));
    });
    match.damagePlayer(thief, null, 9999, DamageCause.OutOfBounds, null, 'pulse_ar', now(), true);
    // Move the thief far away so they cannot re-take it while dead.
    thief.move.pos.x = 0;
    thief.move.pos.z = 0;
    run(match, 14);
    expect(ionCore.atHome).toBe(true);
  });
});

describe('gun progression', () => {
  it('starts everyone on the first ladder weapon', () => {
    const match = makeMatch('progression');
    const p = addPlayer(match, 'A', Team.None);
    match.begin(now());
    const ladder = getMode('progression').ladder!;
    expect(p.weapons[0].def.id).toBe(ladder[0]);
    expect(p.modeValue).toBe(0);
  });

  it('promotes the killer up the ladder on each elimination', () => {
    const match = makeMatch('progression');
    const a = addPlayer(match, 'A', Team.None);
    const b = addPlayer(match, 'B', Team.None);
    match.begin(now());
    const ladder = getMode('progression').ladder!;
    b.protectionTimer = 0;
    match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, a.weapon.def.id, now(), true);
    expect(a.modeValue).toBe(1);
    expect(a.weapons[0].def.id).toBe(ladder[1]);
  });

  it('ends the match when someone finishes the ladder', () => {
    const match = makeMatch('progression');
    const a = addPlayer(match, 'A', Team.None);
    const b = addPlayer(match, 'B', Team.None);
    match.begin(now());
    const ladder = getMode('progression').ladder!;
    for (let i = 0; i < ladder.length; i++) {
      b.protectionTimer = 0;
      if (!b.alive) match.spawnPlayer(b, now());
      b.protectionTimer = 0;
      match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, a.weapon.def.id, now(), true);
    }
    expect(a.modeValue).toBeGreaterThanOrEqual(ladder.length);
    run(match, 0.1);
    expect(match.phase).toBe(MatchPhase.Ended);
  });
});

describe('elimination', () => {
  it('does not respawn players inside a round', () => {
    const match = makeMatch('elimination');
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    const b2 = addPlayer(match, 'B2', Team.Ember);
    match.begin(now());
    b.protectionTimer = 0;
    match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    run(match, 8);
    // b must stay dead while b2 keeps the round alive.
    expect(b.alive).toBe(false);
    expect(b2.alive).toBe(true);
  });

  it('awards a round when one team is wiped, then starts the next round', () => {
    const match = makeMatch('elimination');
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    expect(match.roundNumber).toBe(1);
    b.protectionTimer = 0;
    match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
    run(match, 0.2);
    expect(match.teamScores[0]).toBe(1);
    expect(match.roundResolved).toBe(true);
    // After the intermission a fresh round begins with everyone alive.
    run(match, 6);
    expect(match.roundNumber).toBe(2);
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
  });

  it('ends the match once a team wins enough rounds', () => {
    const match = makeMatch('elimination', 'neon_foundry', { mode: 'elimination' });
    const a = addPlayer(match, 'A', Team.Ion);
    const b = addPlayer(match, 'B', Team.Ember);
    match.begin(now());
    const target = getMode('elimination').roundsToWin;
    for (let round = 0; round < target; round++) {
      if (!b.alive) match.spawnPlayer(b, now());
      b.protectionTimer = 0;
      match.damagePlayer(b, a, 9999, DamageCause.Weapon, null, 'pulse_ar', now(), true);
      run(match, 6.5);
    }
    expect(match.teamScores[0]).toBeGreaterThanOrEqual(target);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.winningTeam).toBe(Team.Ion);
  });
});

describe('every mode is playable end to end', () => {
  for (const modeId of ['ffa', 'tdm', 'domination', 'hardpoint', 'core', 'progression', 'elimination']) {
    it(`${modeId} runs 20 seconds with eight bots and produces combat`, () => {
      const match = makeMatch(modeId);
      const teams = getMode(modeId).teams;
      const bots: BotController[] = [];
      for (let i = 0; i < 8; i++) {
        const p = addPlayer(match, botName(i), teams === 2 ? (i % 2 === 0 ? Team.Ion : Team.Ember) : Team.None, botClassFor(i));
        p.bot = true;
        bots.push(new BotController(p, match.nav, 'hard', 7919 * (i + 1)));
      }
      match.begin(now());

      let shots = 0;
      let deaths = 0;
      const ticks = Math.round(20 / TICK_DT);
      for (let t = 0; t < ticks; t++) {
        for (const bot of bots) bot.player.pendingInputs.push(bot.think(match, TICK_DT, now()));
        advance(TICK_DT * 1000);
        match.step(TICK_DT, now());
        for (const ev of match.drainEvents()) {
          if (ev.t === EvType.Shot) shots++;
          if (ev.t === EvType.Death) deaths++;
        }
      }

      expect(shots, `${modeId}: bots never fired`).toBeGreaterThan(0);
      expect(deaths, `${modeId}: nobody died`).toBeGreaterThan(0);
      // Bots must actually move around the map.
      const moved = bots.filter((b) => b.player.distanceTravelled > 5).length;
      expect(moved, `${modeId}: bots did not navigate`).toBeGreaterThanOrEqual(4);
      // No player may end up out of bounds or inside geometry.
      for (const b of bots) {
        expect(b.player.move.pos.y, `${modeId}: ${b.player.name} fell out`).toBeGreaterThan(match.mapDef.killY);
      }
    });
  }
});

describe('bots', () => {
  it('scale difficulty without changing health or damage', () => {
    const match = makeMatch('tdm');
    const easy = addPlayer(match, 'Easy', Team.Ion);
    const hard = addPlayer(match, 'Hard', Team.Ember);
    easy.bot = true;
    hard.bot = true;
    new BotController(easy, match.nav, 'easy', 1);
    new BotController(hard, match.nav, 'hard', 2);
    match.begin(now());
    expect(easy.maxHealth).toBe(hard.maxHealth);
    expect(easy.weapons[0].def.damage).toBe(hard.weapons[0].def.damage);
  });

  it('produce more hits on hard than on easy over the same window', () => {
    const measure = (difficulty: 'easy' | 'hard') => {
      clock = 1_000_000;
      const match = makeMatch('tdm');
      const bots: BotController[] = [];
      for (let i = 0; i < 6; i++) {
        const p = addPlayer(match, `${difficulty}-${i}`, i % 2 === 0 ? Team.Ion : Team.Ember, botClassFor(i));
        p.bot = true;
        bots.push(new BotController(p, match.nav, difficulty, 4241 * (i + 1)));
      }
      match.begin(now());
      const ticks = Math.round(25 / TICK_DT);
      for (let t = 0; t < ticks; t++) {
        for (const bot of bots) bot.player.pendingInputs.push(bot.think(match, TICK_DT, now()));
        advance(TICK_DT * 1000);
        match.step(TICK_DT, now());
        match.drainEvents();
      }
      return bots.reduce((sum, b) => sum + b.player.weapons.reduce((s, w) => s + w.shotsHit, 0), 0);
    };
    const easyHits = measure('easy');
    const hardHits = measure('hard');
    expect(hardHits).toBeGreaterThan(easyHits);
  });
});

describe('match results and progression persistence', () => {
  it('writes XP, career totals and a match record for a human player', async () => {
    const db = new MemoryDatabase();
    await db.init();
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Human', Team.Ion);
    match.begin(now());
    p.kills = 12;
    p.deaths = 5;
    p.assists = 3;
    p.headshots = 4;
    p.score = 1500;
    p.damageDealt = 2400;
    p.longestStreak = 5;
    p.weapons[0].shotsFired = 200;
    p.weapons[0].shotsHit = 70;
    p.weapons[0].kills = 12;
    p.weapons[0].damage = 2400;

    const award = await awardMatch(db, {
      player: p,
      mode: 'tdm',
      map: 'neon_foundry',
      durationSec: 600,
      won: true,
      drew: false,
      mvp: true,
      matchId: 'match-1',
    });

    expect(award.xpEarned).toBeGreaterThan(0);
    expect(award.breakdown.length).toBeGreaterThan(4);
    expect(award.levelAfter).toBeGreaterThanOrEqual(award.levelBefore);

    const profile = await db.getProfile('profile:Human');
    expect(profile).not.toBeNull();
    expect(profile!.xp).toBe(award.xpEarned + sumAchievementXp(award.newAchievements));
    expect(profile!.totals.kills).toBe(12);
    expect(profile!.totals.wins).toBe(1);
    expect(profile!.totals.shotsFired).toBe(200);
    expect(profile!.weaponStats.pulse_ar.kills).toBe(12);
    expect(profile!.classStats.vanguard.matches).toBe(1);
    expect(profile!.counters.kills).toBe(12);

    const matches = await db.recentMatches('profile:Human', 10);
    expect(matches).toHaveLength(1);
    expect(matches[0].won).toBe(true);
    expect(matches[0].mode).toBe('tdm');
  });

  it('accumulates across matches rather than overwriting', async () => {
    const db = new MemoryDatabase();
    await db.init();
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Human', Team.Ion);
    match.begin(now());
    p.kills = 5;
    await awardMatch(db, { player: p, mode: 'tdm', map: 'neon_foundry', durationSec: 300, won: false, drew: false, mvp: false, matchId: 'm1' });
    await awardMatch(db, { player: p, mode: 'tdm', map: 'neon_foundry', durationSec: 300, won: true, drew: false, mvp: false, matchId: 'm2' });
    const profile = await db.getProfile('profile:Human');
    expect(profile!.totals.kills).toBe(10);
    expect(profile!.totals.matchesPlayed).toBe(2);
    expect(profile!.totals.wins).toBe(1);
    expect(profile!.totals.losses).toBe(1);
  });

  it('unlocks a cosmetic when its achievement completes', async () => {
    const db = new MemoryDatabase();
    await db.init();
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Grinder', Team.Ion);
    match.begin(now());
    p.kills = 300;
    p.counters.kills = 300;
    const award = await awardMatch(db, {
      player: p,
      mode: 'tdm',
      map: 'neon_foundry',
      durationSec: 600,
      won: true,
      drew: false,
      mvp: false,
      matchId: 'm1',
    });
    expect(award.newAchievements).toContain('kills_250');
    expect(award.newUnlocks.length).toBeGreaterThan(0);
    const profile = await db.getProfile('profile:Grinder');
    expect(profile!.cosmetics.unlocked).toContain('charm_skullchip');
  });

  it('builds a results row with a consistent XP breakdown', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Human', Team.Ion);
    match.begin(now());
    p.kills = 4;
    p.deaths = 2;
    p.score = 500;
    const row = buildResultRow(p, null, false, false);
    expect(row.name).toBe('Human');
    expect(row.kills).toBe(4);
    expect(row.won).toBe(false);
    expect(row.xpEarned).toBe(0);
    const withAward = buildResultRow(
      p,
      { xpEarned: 1000, breakdown: [{ label: 'Eliminations', amount: 400 }], levelBefore: 1, levelAfter: 2, newAchievements: [], newUnlocks: [], completedChallenges: [] },
      true,
      false,
    );
    expect(withAward.xpEarned).toBe(1000);
    expect(withAward.accountLevelAfter).toBe(2);
    expect(withAward.won).toBe(true);
  });

  it('reports a draw as not-won', () => {
    const match = makeMatch('tdm');
    const p = addPlayer(match, 'Human', Team.Ion);
    match.begin(now());
    expect(buildResultRow(p, null, true, true).won).toBe(false);
  });
});

/** Achievement rewards are paid on top of the match XP by awardMatch. */
function sumAchievementXp(ids: string[]): number {
  return ids.reduce((sum, id) => sum + (ACHIEVEMENTS_BY_ID[id]?.xpReward ?? 0), 0);
}
