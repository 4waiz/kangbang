/**
 * Class definitions. Each class is a movement profile + a passive + an active
 * ability + an ultimate.  Everything is unlocked by playing; nothing is
 * purchasable, and no class has a strictly-better statline than another.
 */

import type { MoveParams } from '../sim/movement.js';

export type AbilityKind =
  | 'dash'
  | 'cloak'
  | 'overshield'
  | 'barrier'
  | 'scan'
  | 'turret'
  | 'heal_field'
  | 'grapple'
  | 'emp'
  | 'blink';

export interface AbilityDef {
  id: string;
  name: string;
  kind: AbilityKind;
  description: string;
  /** Seconds to recharge from empty. */
  cooldown: number;
  /** How long the effect lasts. 0 = instant. */
  duration: number;
  /** Charges held at once. */
  charges: number;
  /** Radius for area abilities. */
  radius: number;
  /** Magnitude - meaning depends on kind (dash speed, shield HP, heal/sec...). */
  power: number;
  icon: string;
  audio: string;
  /** Deployable asset for turret/barrier abilities. */
  asset?: string;
  /** Deployable health. */
  deployableHealth?: number;
}

export interface PassiveDef {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface ClassDef {
  id: string;
  name: string;
  role: string;
  tagline: string;
  description: string;
  unlockLevel: number;
  health: number;
  shield: number;
  /** Shield regen delay override, seconds. */
  shieldRegenDelay: number;
  move: MoveParams;
  passive: PassiveDef;
  ability: AbilityDef;
  ultimate: AbilityDef;
  /** Weapon categories this class is tuned around (UI recommendation only). */
  preferredCategories: string[];
  /** Default loadout. */
  defaultLoadout: { primary: string; secondary: string; melee: string };
  /** Silhouette + colour identity. */
  visual: {
    asset: string;
    /** Primary accent colour used when team colours are off (FFA). */
    accent: number;
    /** Body proportions used by the procedural fallback rig. */
    build: 'light' | 'medium' | 'heavy';
    height: number;
    /** Distinctive helmet shape drawn on the character model. */
    helmet: 'visor' | 'hood' | 'dome' | 'crest' | 'optic' | 'rig';
  };
  masteryStep: number;
}

const move = (over: Partial<MoveParams> = {}): MoveParams => ({
  speedScale: 1,
  accelScale: 1,
  jumpScale: 1,
  airControlScale: 1,
  slideScale: 1,
  gravityScale: 1,
  adsSpeedScale: 0.52,
  weaponSpeedScale: 1,
  noSlide: false,
  doubleJump: false,
  ...over,
});

export const CLASSES: Record<string, ClassDef> = {
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    role: 'Assault',
    tagline: 'No bad matchups, no free wins.',
    description:
      'The baseline every other class is measured against. Full mobility, full health, and a combat dash that turns a lost duel into a won one.',
    unlockLevel: 0,
    health: 100,
    shield: 25,
    shieldRegenDelay: 4.5,
    move: move(),
    passive: {
      id: 'combat_momentum',
      name: 'Second Wind',
      description: 'Eliminations refund 35% of your ability charge and instantly restart shield regeneration.',
      icon: 'momentum',
    },
    ability: {
      id: 'thruster_dash',
      name: 'Tactical Sprint',
      kind: 'dash',
      description: 'Explosive burst of speed in your movement direction. Keeps momentum on landing.',
      cooldown: 8,
      duration: 0,
      charges: 2,
      radius: 0,
      power: 13.5,
      icon: 'dash',
      audio: 'ability_dash',
    },
    ultimate: {
      id: 'overdrive',
      name: 'Adrenaline',
      kind: 'overshield',
      description: '8 seconds of +75 overshield, 20% faster reloads and no movement penalty while aiming.',
      cooldown: 90,
      duration: 8,
      charges: 1,
      radius: 0,
      power: 75,
      icon: 'overdrive',
      audio: 'ability_overdrive',
    },
    preferredCategories: ['ar', 'carbine', 'shotgun'],
    defaultLoadout: { primary: 'pulse_ar', secondary: 'energy_pistol', melee: 'plasma_blade' },
    visual: { asset: 'char_vanguard', accent: 0x2ce8ff, build: 'medium', height: 1.82, helmet: 'visor' },
    masteryStep: 1200,
  },

  phantom: {
    id: 'phantom',
    name: 'Phantom',
    role: 'Scout',
    tagline: 'Seen once, never twice.',
    description:
      'Fastest legs on the roster with an extra air jump and a short refraction cloak. Dies to two good bursts, so do not be there for the second.',
    unlockLevel: 0,
    health: 80,
    shield: 15,
    shieldRegenDelay: 3.4,
    move: move({ speedScale: 1.14, accelScale: 1.12, jumpScale: 1.06, airControlScale: 1.25, slideScale: 1.35, doubleJump: true }),
    passive: {
      id: 'silent_step',
      name: 'Light Footed',
      description: 'Footsteps are inaudible to enemies and you take no fall damage.',
      icon: 'silent',
    },
    ability: {
      id: 'refraction_cloak',
      name: 'Refraction Cloak',
      kind: 'cloak',
      description: '3.5s of near invisibility. Firing or taking damage breaks it early.',
      cooldown: 14,
      duration: 3.5,
      charges: 1,
      radius: 0,
      power: 0.88,
      icon: 'cloak',
      audio: 'ability_cloak',
    },
    ultimate: {
      id: 'phase_blink',
      name: 'Phase Blink',
      kind: 'blink',
      description: 'Teleport up to 18m along your view, leaving a decoy that draws fire.',
      cooldown: 75,
      duration: 0,
      charges: 1,
      radius: 0,
      power: 18,
      icon: 'blink',
      audio: 'ability_blink',
    },
    preferredCategories: ['smg', 'shotgun', 'melee'],
    defaultLoadout: { primary: 'plasma_smg', secondary: 'energy_pistol', melee: 'plasma_blade' },
    visual: { asset: 'char_phantom', accent: 0x9dff5e, build: 'light', height: 1.76, helmet: 'hood' },
    masteryStep: 1200,
  },

  titan: {
    id: 'titan',
    name: 'Titan',
    role: 'Heavy',
    tagline: 'Hold the line. Become the line.',
    description:
      'Walking suppression platform. Highest effective health in the game and the only class that reloads an LMG without punishment, but slow and easy to out-manoeuvre.',
    unlockLevel: 3,
    health: 140,
    shield: 50,
    shieldRegenDelay: 5.5,
    move: move({ speedScale: 0.86, accelScale: 0.9, jumpScale: 0.94, airControlScale: 0.75, slideScale: 0.7, gravityScale: 1.12, adsSpeedScale: 0.62 }),
    passive: {
      id: 'braced',
      name: 'Heavy Plate',
      description: 'Takes 15% less explosive damage and cannot be staggered. LMG reloads 25% faster.',
      icon: 'braced',
    },
    ability: {
      id: 'bulwark',
      name: 'Ballistic Shield',
      kind: 'barrier',
      description: 'Deploys a 3m energy barrier that blocks enemy fire and can be shot down.',
      cooldown: 18,
      duration: 12,
      charges: 1,
      radius: 3,
      power: 400,
      icon: 'barrier',
      audio: 'ability_barrier',
      asset: 'dep_barrier',
      deployableHealth: 400,
    },
    ultimate: {
      id: 'siege_mode',
      name: 'Dig In',
      kind: 'overshield',
      description: '10s of +150 overshield and zero recoil, at the cost of 40% movement speed.',
      cooldown: 100,
      duration: 10,
      charges: 1,
      radius: 0,
      power: 150,
      icon: 'siege',
      audio: 'ability_siege',
    },
    preferredCategories: ['lmg', 'shotgun', 'launcher'],
    defaultLoadout: { primary: 'particle_lmg', secondary: 'energy_pistol', melee: 'plasma_blade' },
    visual: { asset: 'char_titan', accent: 0xffa62c, build: 'heavy', height: 1.95, helmet: 'dome' },
    masteryStep: 1200,
  },

  warden: {
    id: 'warden',
    name: 'Warden',
    role: 'Support',
    tagline: 'Everyone gets home.',
    description:
      'Objective anchor. Projects a healing field, revives teammate shields faster and scores extra for defending. Middling raw damage - the value is in the field.',
    unlockLevel: 5,
    health: 110,
    shield: 35,
    shieldRegenDelay: 3.8,
    move: move({ speedScale: 0.96, accelScale: 1, slideScale: 0.95 }),
    passive: {
      id: 'field_medic',
      name: 'Combat Medic',
      description: 'Nearby allies within 8m regenerate shields 60% faster. You score for every ally healed.',
      icon: 'medic',
    },
    ability: {
      id: 'aegis_field',
      name: 'Deployable Cover',
      kind: 'heal_field',
      description: 'Drops a 5m field that restores 22 health per second to allies inside it.',
      cooldown: 16,
      duration: 8,
      charges: 1,
      radius: 5,
      power: 22,
      icon: 'field',
      audio: 'ability_field',
      asset: 'dep_field',
      deployableHealth: 180,
    },
    ultimate: {
      id: 'guardian_lattice',
      name: 'Squad Armour',
      kind: 'barrier',
      description: 'Raises a 7m dome for 9s. Blocks all incoming fire, allies can shoot out.',
      cooldown: 95,
      duration: 9,
      charges: 1,
      radius: 7,
      power: 900,
      icon: 'lattice',
      audio: 'ability_lattice',
      asset: 'dep_dome',
      deployableHealth: 900,
    },
    preferredCategories: ['ar', 'carbine'],
    defaultLoadout: { primary: 'pulse_ar', secondary: 'tactical_revolver', melee: 'plasma_blade' },
    visual: { asset: 'char_warden', accent: 0x4fe0ff, build: 'medium', height: 1.85, helmet: 'crest' },
    masteryStep: 1200,
  },

  spectre: {
    id: 'spectre',
    name: 'Spectre',
    role: 'Marksman',
    tagline: 'One angle is all it takes.',
    description:
      'Long-range specialist. Steadier scope, a wall-piercing pulse scan, and the lowest effective health of any non-Phantom class.',
    unlockLevel: 7,
    health: 90,
    shield: 20,
    shieldRegenDelay: 4.2,
    move: move({ speedScale: 1.02, airControlScale: 1.1, adsSpeedScale: 0.44 }),
    passive: {
      id: 'steady_optic',
      name: 'Steady Hands',
      description: 'Scoped sway is halved and scoped movement penalty reduced by 30%. Headshots refund 20% ability charge.',
      icon: 'optic',
    },
    ability: {
      id: 'pulse_scan',
      name: 'Motion Sensor',
      kind: 'scan',
      description: 'Emits a 26m pulse that outlines enemies through walls for 4 seconds.',
      cooldown: 15,
      duration: 4,
      charges: 1,
      radius: 26,
      power: 1,
      icon: 'scan',
      audio: 'ability_scan',
    },
    ultimate: {
      id: 'lattice_lock',
      name: 'Recon Sweep',
      kind: 'scan',
      description: '10s global enemy outline for your whole team, plus instant rail charge for you.',
      cooldown: 105,
      duration: 10,
      charges: 1,
      radius: 200,
      power: 1,
      icon: 'lock',
      audio: 'ability_lock',
    },
    preferredCategories: ['sniper', 'revolver', 'carbine'],
    defaultLoadout: { primary: 'rail_sniper', secondary: 'tactical_revolver', melee: 'plasma_blade' },
    visual: { asset: 'char_spectre', accent: 0xc7a2ff, build: 'light', height: 1.86, helmet: 'optic' },
    masteryStep: 1200,
  },

  engineer: {
    id: 'engineer',
    name: 'Engineer',
    role: 'Tech',
    tagline: 'Let the hardware hold the angle.',
    description:
      'Deploys an auto-turret and an EMP that shuts down enemy abilities and deployables. Strong at map control, weak in a straight duel.',
    unlockLevel: 9,
    health: 105,
    shield: 30,
    shieldRegenDelay: 4.5,
    move: move({ speedScale: 0.98 }),
    passive: {
      id: 'field_repair',
      name: 'Field Repair',
      description: 'Your deployables self-repair 12 HP/s out of combat and you resupply ammo 40% faster from pickups.',
      icon: 'repair',
    },
    ability: {
      id: 'sentry_turret',
      name: 'Sentry Turret',
      kind: 'turret',
      description: 'Places a turret that tracks and fires on enemies within 22m for 20 seconds.',
      cooldown: 22,
      duration: 20,
      charges: 1,
      radius: 22,
      power: 11,
      icon: 'turret',
      audio: 'ability_turret',
      asset: 'dep_turret',
      deployableHealth: 220,
    },
    ultimate: {
      id: 'system_purge',
      name: 'EMP Burst',
      kind: 'emp',
      description: '18m EMP: destroys enemy deployables, drains enemy ability charge and disables HUD for 5s.',
      cooldown: 90,
      duration: 5,
      charges: 1,
      radius: 18,
      power: 1,
      icon: 'emp',
      audio: 'ability_emp',
    },
    preferredCategories: ['ar', 'launcher', 'smg'],
    defaultLoadout: { primary: 'pulse_ar', secondary: 'energy_pistol', melee: 'plasma_blade' },
    visual: { asset: 'char_engineer', accent: 0x8dff4a, build: 'medium', height: 1.8, helmet: 'rig' },
    masteryStep: 1200,
  },
};

export const CLASS_ORDER: readonly string[] = ['vanguard', 'phantom', 'titan', 'warden', 'spectre', 'engineer'];

const classIndexMap = new Map<string, number>();
CLASS_ORDER.forEach((id, i) => classIndexMap.set(id, i));

export function classIndex(id: string): number {
  return classIndexMap.get(id) ?? 0;
}

export function classFromIndex(i: number): ClassDef {
  return CLASSES[CLASS_ORDER[i] ?? 'vanguard'];
}

export function getClass(id: string): ClassDef {
  const c = CLASSES[id];
  if (!c) throw new Error(`Unknown class: ${id}`);
  return c;
}

export function isClassId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLASSES, id);
}

/** Effective health used by the TTK tests and the loadout UI. */
export function effectiveHealth(c: ClassDef): number {
  return c.health + c.shield;
}

// ---------------------------------------------------------------------------
// Weapon perks - modular, side-grade only (every perk has a real downside)
// ---------------------------------------------------------------------------

export interface PerkDef {
  id: string;
  name: string;
  slot: string;
  description: string;
  unlockLevel: number;
  icon: string;
  /** Multiplicative or additive modifiers applied to a WeaponDef at runtime. */
  mods: Partial<{
    damage: number;
    rpm: number;
    magazine: number;
    reserve: number;
    reloadTime: number;
    adsTime: number;
    moveScale: number;
    adsMoveScale: number;
    spreadHip: number;
    spreadAds: number;
    spreadPerShot: number;
    recoilUp: number;
    recoilSide: number;
    falloffStart: number;
    falloffEnd: number;
    range: number;
    adsZoom: number;
    equipTime: number;
    projectileSpeed: number;
    explosionRadius: number;
  }>;
}

/** All modifiers are multipliers; 1 = unchanged. */
export const PERKS: Record<string, PerkDef> = {
  barrel_long: {
    id: 'barrel_long',
    name: 'Extended Barrel',
    slot: 'barrel',
    description: '+18% effective range, -8% ADS speed.',
    unlockLevel: 2,
    icon: 'barrel',
    mods: { falloffStart: 1.18, falloffEnd: 1.18, adsTime: 1.08 },
  },
  barrel_compensator: {
    id: 'barrel_compensator',
    name: 'Compensator',
    slot: 'barrel',
    description: '-22% vertical recoil, +12% hip spread.',
    unlockLevel: 3,
    icon: 'comp',
    mods: { recoilUp: 0.78, spreadHip: 1.12 },
  },
  barrel_shroud: {
    id: 'barrel_shroud',
    name: 'Light Shroud',
    slot: 'barrel',
    description: '+6% move speed, -8% effective range.',
    unlockLevel: 5,
    icon: 'shroud',
    mods: { moveScale: 1.06, falloffStart: 0.92, falloffEnd: 0.92 },
  },
  sight_micro: {
    id: 'sight_micro',
    name: 'Micro Reflex',
    slot: 'sight',
    description: '-15% ADS time, slightly less zoom.',
    unlockLevel: 1,
    icon: 'reflex',
    mods: { adsTime: 0.85, adsZoom: 1.06 },
  },
  sight_holo: {
    id: 'sight_holo',
    name: 'Holo Ring',
    slot: 'sight',
    description: '-20% ADS spread, +8% ADS time.',
    unlockLevel: 4,
    icon: 'holo',
    mods: { spreadAds: 0.8, adsTime: 1.08 },
  },
  scope_variable: {
    id: 'scope_variable',
    name: 'Variable Scope',
    slot: 'scope',
    description: 'Extra zoom and +10% range, -12% ADS speed.',
    unlockLevel: 6,
    icon: 'scope',
    mods: { adsZoom: 0.8, falloffEnd: 1.1, adsTime: 1.12 },
  },
  mag_extended: {
    id: 'mag_extended',
    name: 'Extended Cell',
    slot: 'mag',
    description: '+40% magazine, +14% reload time.',
    unlockLevel: 2,
    icon: 'mag',
    mods: { magazine: 1.4, reloadTime: 1.14 },
  },
  mag_fast: {
    id: 'mag_fast',
    name: 'Quick Cell',
    slot: 'mag',
    description: '-22% reload time, -15% reserve ammo.',
    unlockLevel: 3,
    icon: 'fastmag',
    mods: { reloadTime: 0.78, reserve: 0.85 },
  },
  grip_tactical: {
    id: 'grip_tactical',
    name: 'Tactical Grip',
    slot: 'grip',
    description: '-20% horizontal recoil, -4% move speed.',
    unlockLevel: 3,
    icon: 'grip',
    mods: { recoilSide: 0.8, moveScale: 0.96 },
  },
  stock_light: {
    id: 'stock_light',
    name: 'Skeleton Stock',
    slot: 'stock',
    description: '+8% ADS move speed, +10% recoil.',
    unlockLevel: 4,
    icon: 'stock',
    mods: { adsMoveScale: 1.08, recoilUp: 1.1, recoilSide: 1.1 },
  },
  choke_tight: {
    id: 'choke_tight',
    name: 'Tight Choke',
    slot: 'choke',
    description: '-25% pellet spread, -10% fire rate.',
    unlockLevel: 5,
    icon: 'choke',
    mods: { spreadHip: 0.75, spreadAds: 0.75, rpm: 0.9 },
  },
  belt_heavy: {
    id: 'belt_heavy',
    name: 'Heavy Belt',
    slot: 'belt',
    description: '+25% magazine, -5% move speed.',
    unlockLevel: 6,
    icon: 'belt',
    mods: { magazine: 1.25, moveScale: 0.95 },
  },
  bipod_stabiliser: {
    id: 'bipod_stabiliser',
    name: 'Stabiliser',
    slot: 'bipod',
    description: '-30% ADS spread growth, -10% ADS move speed.',
    unlockLevel: 7,
    icon: 'bipod',
    mods: { spreadPerShot: 0.7, adsMoveScale: 0.9 },
  },
  warhead_dense: {
    id: 'warhead_dense',
    name: 'Dense Warhead',
    slot: 'warhead',
    description: '+15% blast radius, -12% projectile speed.',
    unlockLevel: 8,
    icon: 'warhead',
    mods: { explosionRadius: 1.15, projectileSpeed: 0.88 },
  },
  tube_light: {
    id: 'tube_light',
    name: 'Light Tube',
    slot: 'tube',
    description: '-18% equip time, -1 magazine.',
    unlockLevel: 9,
    icon: 'tube',
    mods: { equipTime: 0.82, magazine: 0.75 },
  },
  edge_honed: {
    id: 'edge_honed',
    name: 'Honed Edge',
    slot: 'edge',
    description: '+12% swing speed, -8% damage.',
    unlockLevel: 2,
    icon: 'edge',
    mods: { rpm: 1.12, damage: 0.92 },
  },
};

export const PERK_IDS = Object.keys(PERKS);

export function perksForSlot(slot: string): PerkDef[] {
  return PERK_IDS.map((id) => PERKS[id]).filter((p) => p.slot === slot);
}
