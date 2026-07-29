/**
 * Game mode definitions.  The server's mode framework
 * (packages/server/src/game/modes/*) reads these to configure scoring, spawn
 * rules, objectives and win conditions - adding a mode is a data change plus
 * one small rule class.
 */

export type ModeScoring = 'kills' | 'team-kills' | 'zones' | 'hardpoint' | 'captures' | 'progression' | 'rounds';

export interface ModeDef {
  id: string;
  name: string;
  short: string;
  description: string;
  /** Teams: 1 = free for all, 2 = team based. */
  teams: 1 | 2;
  scoring: ModeScoring;
  /** Score needed to win. For round modes this is rounds won. */
  scoreLimit: number;
  timeLimitSec: number;
  /** Seconds added when scores are level at time expiry. 0 = no overtime. */
  overtimeSec: number;
  respawnDelay: number;
  /** Players respawn at all during a round? (Elimination = false) */
  respawnEnabled: boolean;
  /** Rounds needed to win for round-based modes. */
  roundsToWin: number;
  /** Seconds per round for round-based modes. */
  roundTimeSec: number;
  /** Score awarded per event. */
  points: {
    kill: number;
    assist: number;
    headshot: number;
    objectiveCapture: number;
    objectiveTick: number;
    objectiveDefend: number;
    coreCarry: number;
    coreScore: number;
    roundWin: number;
    revive: number;
    heal: number;
  };
  /** Team score awarded per event (0 = does not affect team score). */
  teamPoints: {
    kill: number;
    capture: number;
    tick: number;
    coreScore: number;
    roundWin: number;
  };
  /** Objective anchors this mode uses from the map definition. */
  objectiveKind: 'none' | 'zone' | 'hardpoint' | 'core';
  /** Number of simultaneous active objectives. */
  activeObjectives: number;
  /** Hardpoint rotation interval. */
  rotationSec: number;
  /** HUD widget set. */
  hud: 'ffa' | 'team' | 'zones' | 'hardpoint' | 'core' | 'progression' | 'elimination';
  icon: string;
  /** Weapon behaviour override. */
  weaponRule: 'loadout' | 'progression-ladder';
  /** Ladder used by Gun Progression. */
  ladder?: string[];
  /** Minimum players before the match will start counting down. */
  minPlayers: number;
  /** Default bot fill target. */
  defaultBots: number;
  /** Should the mode be offered in Quick Play? */
  quickPlay: boolean;
}

const basePoints = {
  kill: 100,
  assist: 40,
  headshot: 25,
  objectiveCapture: 0,
  objectiveTick: 0,
  objectiveDefend: 0,
  coreCarry: 0,
  coreScore: 0,
  roundWin: 0,
  revive: 60,
  heal: 2,
};

const baseTeamPoints = { kill: 0, capture: 0, tick: 0, coreScore: 0, roundWin: 0 };

export const MODES: Record<string, ModeDef> = {
  ffa: {
    id: 'ffa',
    name: 'Free For All',
    short: 'FFA',
    description: 'Everyone against everyone. First to 30 eliminations takes it.',
    teams: 1,
    scoring: 'kills',
    scoreLimit: 30,
    timeLimitSec: 600,
    overtimeSec: 0,
    respawnDelay: 2.4,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints },
    teamPoints: { ...baseTeamPoints },
    objectiveKind: 'none',
    activeObjectives: 0,
    rotationSec: 0,
    hud: 'ffa',
    icon: 'ffa',
    weaponRule: 'loadout',
    minPlayers: 1,
    defaultBots: 7,
    quickPlay: true,
  },

  tdm: {
    id: 'tdm',
    name: 'Team Deathmatch',
    short: 'TDM',
    description: 'Ion versus Ember. 75 eliminations wins the round.',
    teams: 2,
    scoring: 'team-kills',
    scoreLimit: 75,
    timeLimitSec: 600,
    overtimeSec: 90,
    respawnDelay: 3.0,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints },
    teamPoints: { ...baseTeamPoints, kill: 1 },
    objectiveKind: 'none',
    activeObjectives: 0,
    rotationSec: 0,
    hud: 'team',
    icon: 'tdm',
    weaponRule: 'loadout',
    minPlayers: 1,
    defaultBots: 9,
    quickPlay: true,
  },

  domination: {
    id: 'domination',
    name: 'Domination',
    short: 'DOM',
    description: 'Three zones. Hold more than the enemy and tick to 200.',
    teams: 2,
    scoring: 'zones',
    scoreLimit: 200,
    timeLimitSec: 720,
    overtimeSec: 90,
    respawnDelay: 4.0,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints, kill: 80, objectiveCapture: 200, objectiveTick: 8, objectiveDefend: 60 },
    teamPoints: { ...baseTeamPoints, capture: 0, tick: 1 },
    objectiveKind: 'zone',
    activeObjectives: 3,
    rotationSec: 0,
    hud: 'zones',
    icon: 'dom',
    weaponRule: 'loadout',
    minPlayers: 2,
    defaultBots: 9,
    quickPlay: true,
  },

  hardpoint: {
    id: 'hardpoint',
    name: 'Hardpoint',
    short: 'HP',
    description: 'One rotating capture point. Hold it to tick towards 250.',
    teams: 2,
    scoring: 'hardpoint',
    scoreLimit: 250,
    timeLimitSec: 600,
    overtimeSec: 60,
    respawnDelay: 4.5,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints, kill: 80, objectiveTick: 10, objectiveDefend: 70 },
    teamPoints: { ...baseTeamPoints, tick: 1 },
    objectiveKind: 'hardpoint',
    activeObjectives: 1,
    rotationSec: 60,
    hud: 'hardpoint',
    icon: 'hp',
    weaponRule: 'loadout',
    minPlayers: 2,
    defaultBots: 9,
    quickPlay: true,
  },

  core: {
    id: 'core',
    name: 'Capture the Core',
    short: 'CTC',
    description: 'Steal the enemy power core and bring it to your reactor. Three captures wins.',
    teams: 2,
    scoring: 'captures',
    scoreLimit: 3,
    timeLimitSec: 720,
    overtimeSec: 120,
    respawnDelay: 6.0,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints, kill: 80, coreCarry: 25, coreScore: 500, objectiveDefend: 120 },
    teamPoints: { ...baseTeamPoints, coreScore: 1 },
    objectiveKind: 'core',
    activeObjectives: 2,
    rotationSec: 0,
    hud: 'core',
    icon: 'ctc',
    weaponRule: 'loadout',
    minPlayers: 2,
    defaultBots: 9,
    quickPlay: true,
  },

  progression: {
    id: 'progression',
    name: 'Gun Progression',
    short: 'GUNS',
    description: 'Every elimination promotes you up the weapon ladder. Win with the Plasma Blade.',
    teams: 1,
    scoring: 'progression',
    scoreLimit: 10,
    timeLimitSec: 720,
    overtimeSec: 0,
    respawnDelay: 2.2,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints, kill: 120 },
    teamPoints: { ...baseTeamPoints },
    objectiveKind: 'none',
    activeObjectives: 0,
    rotationSec: 0,
    hud: 'progression',
    icon: 'guns',
    weaponRule: 'progression-ladder',
    ladder: [
      'energy_pistol',
      'plasma_smg',
      'burst_carbine',
      'pulse_ar',
      'ion_shotgun',
      'particle_lmg',
      'tactical_revolver',
      'arc_launcher',
      'rail_sniper',
      'plasma_blade',
    ],
    minPlayers: 1,
    defaultBots: 7,
    quickPlay: true,
  },

  elimination: {
    id: 'elimination',
    name: 'Elimination',
    short: 'ELIM',
    description: 'One life per round. First team to six round wins.',
    teams: 2,
    scoring: 'rounds',
    scoreLimit: 6,
    timeLimitSec: 0,
    overtimeSec: 0,
    respawnDelay: 0,
    respawnEnabled: false,
    roundsToWin: 6,
    roundTimeSec: 120,
    points: { ...basePoints, kill: 150, assist: 60, roundWin: 300 },
    teamPoints: { ...baseTeamPoints, roundWin: 1 },
    objectiveKind: 'none',
    activeObjectives: 0,
    rotationSec: 0,
    hud: 'elimination',
    icon: 'elim',
    weaponRule: 'loadout',
    minPlayers: 2,
    defaultBots: 9,
    quickPlay: true,
  },

  custom: {
    id: 'custom',
    name: 'Custom Match',
    short: 'CUSTOM',
    description: 'Your rules: any mode base, any map, any bot count, private or public.',
    teams: 2,
    scoring: 'team-kills',
    scoreLimit: 50,
    timeLimitSec: 600,
    overtimeSec: 60,
    respawnDelay: 3.0,
    respawnEnabled: true,
    roundsToWin: 0,
    roundTimeSec: 0,
    points: { ...basePoints },
    teamPoints: { ...baseTeamPoints, kill: 1 },
    objectiveKind: 'none',
    activeObjectives: 0,
    rotationSec: 0,
    hud: 'team',
    icon: 'custom',
    weaponRule: 'loadout',
    minPlayers: 1,
    defaultBots: 5,
    quickPlay: false,
  },
};

export const MODE_ORDER: readonly string[] = [
  'ffa',
  'tdm',
  'domination',
  'hardpoint',
  'core',
  'progression',
  'elimination',
  'custom',
];

export function getMode(id: string): ModeDef {
  const m = MODES[id];
  if (!m) throw new Error(`Unknown mode: ${id}`);
  return m;
}

export function isModeId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODES, id);
}

export function quickPlayModes(): ModeDef[] {
  return MODE_ORDER.map((id) => MODES[id]).filter((m) => m.quickPlay);
}

/** Modes that place players on two teams. */
export function isTeamMode(id: string): boolean {
  return getMode(id).teams === 2;
}
