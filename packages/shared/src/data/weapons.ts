/**
 * Data-driven weapon definitions.
 *
 * Nothing about a weapon is hard-coded in the client or server: both read
 * these tables. Balance is therefore a single-file change, and the unit tests
 * in packages/shared/src/__tests__/weapons.test.ts assert the invariants
 * (time-to-kill windows, DPS ordering, magazine sanity).
 */

export type WeaponCategory = 'ar' | 'smg' | 'sniper' | 'shotgun' | 'lmg' | 'carbine' | 'pistol' | 'revolver' | 'melee' | 'launcher';
export type WeaponSlot = 'primary' | 'secondary' | 'melee';
export type FireMode = 'auto' | 'burst' | 'single' | 'bolt' | 'pump' | 'swing' | 'charge';
export type ProjectileKind = 'hitscan' | 'plasma' | 'rocket' | 'arc' | 'none';

export interface RecoilPattern {
  /** Vertical camera kick per shot, radians. */
  up: number;
  /** Horizontal camera kick magnitude, radians. */
  side: number;
  /** Fraction of the kick returned to the original aim, 0..1. */
  recovery: number;
  /** How quickly the camera returns, higher = snappier. */
  recoverRate: number;
  /** Multiplier applied to camera kick while aiming down sights. */
  adsScale: number;
  /** View-model punch back along -Z, metres. */
  viewKick: number;
  /** View-model roll, radians. */
  viewRoll: number;
  /** Deterministic horizontal pattern; cycled per shot for learnable spray. */
  pattern: number[];
}

export interface WeaponSpread {
  /** Base cone half-angle when standing still and hip firing, radians. */
  hip: number;
  /** Cone while aiming down sights. */
  ads: number;
  /** Extra cone added at full movement speed. */
  moving: number;
  /** Extra cone while airborne. */
  air: number;
  /** Cone growth per shot while sustaining fire. */
  perShot: number;
  /** Maximum accumulated bloom. */
  max: number;
  /** Bloom decay per second once firing stops. */
  decay: number;
  /** Reduction multiplier while crouching. */
  crouchScale: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  /** Short label used in HUD/kill feed. */
  short: string;
  category: WeaponCategory;
  slot: WeaponSlot;
  fireMode: FireMode;
  projectile: ProjectileKind;
  description: string;
  /** Unlock level on the account track; 0 = available from the start. */
  unlockLevel: number;

  damage: number;
  /** Damage at maximum falloff distance. */
  damageMin: number;
  /** Distance where falloff begins (m). */
  falloffStart: number;
  /** Distance where damage reaches damageMin (m). */
  falloffEnd: number;
  /** Maximum useful range (m); beyond this the trace stops. */
  range: number;
  headshotMultiplier: number;
  /** Rounds per minute (per trigger pull for burst weapons). */
  rpm: number;
  /** Pellets per shot (shotguns). */
  pellets: number;
  /** Rounds per burst (burst weapons). */
  burstCount: number;
  /** Seconds between rounds inside a burst. */
  burstInterval: number;
  /** Extra delay after a burst completes. */
  burstCooldown: number;

  magazine: number;
  reserve: number;
  reloadTime: number;
  /** Reload time when the magazine still had a round chambered. */
  reloadTimeTactical: number;
  /** True if the reload can be cancelled by sprinting/switching. */
  reloadCancellable: boolean;
  /** Time to raise the weapon after switching. */
  equipTime: number;
  /** Time to lower the weapon when switching away. */
  holsterTime: number;
  /** Aim-down-sights transition time. */
  adsTime: number;
  /** ADS field-of-view multiplier (lower = more zoom). */
  adsZoom: number;
  /** True for scoped weapons that use a dedicated scope overlay. */
  scoped: boolean;

  /** Movement speed multiplier while holding this weapon. */
  moveScale: number;
  /** Movement speed multiplier while aiming. */
  adsMoveScale: number;

  spread: WeaponSpread;
  recoil: RecoilPattern;

  /** Projectile speed (m/s) for non-hitscan weapons. */
  projectileSpeed: number;
  /** Projectile gravity multiplier. */
  projectileGravity: number;
  /** Explosion radius (m); 0 for non-explosive. */
  explosionRadius: number;
  explosionDamage: number;
  /** Self-damage fraction from own explosions. */
  selfDamageScale: number;

  /** Melee reach (m) and swing time for melee weapons. */
  meleeRange: number;
  meleeSwingTime: number;
  /** Backstab multiplier for melee. */
  backstabMultiplier: number;

  /** Charge-up time for charge weapons (rail sniper quick-scope penalty). */
  chargeTime: number;

  /** Ammo pickups grant this many rounds. */
  ammoPickup: number;

  /** Visual/audio identity. */
  audio: {
    fire: string;
    reload: string;
    dryFire: string;
    equip: string;
    tail: string;
    pitch: number;
  };
  fx: {
    muzzle: 'plasma' | 'ion' | 'rail' | 'arc' | 'kinetic' | 'blade';
    muzzleScale: number;
    tracer: 'beam' | 'bolt' | 'streak' | 'none';
    tracerColor: number;
    tracerWidth: number;
    impact: 'spark' | 'plasma' | 'rail' | 'blast' | 'slash';
    shells: boolean;
    shellColor: number;
    lightColor: number;
    lightIntensity: number;
  };
  /** Kill-feed / UI icon key drawn by the client's icon renderer. */
  icon: string;
  /** GLB asset base name; `<asset>_fp.glb` and `<asset>_world.glb` exist. */
  asset: string;
  /** First-person view-model transform. */
  viewModel: {
    pos: [number, number, number];
    rot: [number, number, number];
    /** ADS pose. */
    adsPos: [number, number, number];
    adsRot: [number, number, number];
    scale: number;
    /** Muzzle tip in view-model local space. */
    muzzle: [number, number, number];
    /** Shell ejection port. */
    eject: [number, number, number];
    /** Left hand IK target. */
    leftHand: [number, number, number];
  };
  /** Weapon perk slots this weapon supports. */
  perkSlots: string[];
  /** Recommended classes. */
  classes: string[];
  /** XP required per mastery level for this weapon. */
  masteryStep: number;
}

const defaultSpread = (over: Partial<WeaponSpread> = {}): WeaponSpread => ({
  hip: 0.026,
  ads: 0.004,
  moving: 0.024,
  air: 0.03,
  perShot: 0.0034,
  max: 0.07,
  decay: 0.19,
  crouchScale: 0.7,
  ...over,
});

const defaultRecoil = (over: Partial<RecoilPattern> = {}): RecoilPattern => ({
  up: 0.0105,
  side: 0.0042,
  recovery: 0.82,
  recoverRate: 9,
  adsScale: 0.72,
  viewKick: 0.028,
  viewRoll: 0.02,
  pattern: [0, 0.25, -0.3, 0.55, -0.45, 0.8, -0.7, 0.4, -0.9, 0.65],
  ...over,
});

const noSpread = (): WeaponSpread => defaultSpread({ hip: 0, ads: 0, moving: 0, air: 0, perShot: 0, max: 0, decay: 1, crouchScale: 1 });

export const WEAPONS: Record<string, WeaponDef> = {
  // -------------------------------------------------------------------------
  pulse_ar: {
    id: 'pulse_ar',
    name: 'Pulse Assault Rifle',
    short: 'PULSE-AR',
    category: 'ar',
    slot: 'primary',
    fireMode: 'auto',
    projectile: 'hitscan',
    description: 'Balanced full-auto rifle. Four-shot kill up close, controllable spray, forgiving at every range.',
    unlockLevel: 0,
    damage: 26,
    damageMin: 18,
    falloffStart: 26,
    falloffEnd: 58,
    range: 180,
    headshotMultiplier: 2.0,
    rpm: 660,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 30,
    reserve: 180,
    reloadTime: 2.05,
    reloadTimeTactical: 1.72,
    reloadCancellable: true,
    equipTime: 0.42,
    holsterTime: 0.24,
    adsTime: 0.19,
    adsZoom: 0.76,
    scoped: false,
    moveScale: 1,
    adsMoveScale: 0.52,
    spread: defaultSpread(),
    recoil: defaultRecoil(),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 60,
    audio: { fire: 'fire_ar', reload: 'reload_mag', dryFire: 'dry', equip: 'equip', tail: 'tail_mid', pitch: 1 },
    fx: {
      muzzle: 'plasma',
      muzzleScale: 1,
      tracer: 'streak',
      tracerColor: 0x6ff0ff,
      tracerWidth: 0.035,
      impact: 'spark',
      shells: true,
      shellColor: 0xd8b25a,
      lightColor: 0x66e6ff,
      lightIntensity: 1.5,
    },
    icon: 'ar',
    asset: 'wpn_pulse_ar',
    viewModel: {
      pos: [0.19, -0.185, -0.42],
      rot: [0.01, 0.05, 0],
      adsPos: [0, -0.115, -0.28],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.045, -0.62],
      eject: [0.055, 0.01, -0.16],
      leftHand: [-0.03, -0.04, -0.34],
    },
    perkSlots: ['barrel', 'sight', 'mag', 'grip'],
    classes: ['vanguard', 'warden', 'engineer'],
    masteryStep: 900,
  },

  // -------------------------------------------------------------------------
  plasma_smg: {
    id: 'plasma_smg',
    name: 'Plasma SMG',
    short: 'PLASMA-SMG',
    category: 'smg',
    slot: 'primary',
    fireMode: 'auto',
    projectile: 'hitscan',
    description: 'Blistering rate of fire and the best hip-fire in the game. Falls off hard past twenty metres.',
    unlockLevel: 0,
    damage: 19,
    damageMin: 10,
    falloffStart: 14,
    falloffEnd: 34,
    range: 110,
    headshotMultiplier: 1.75,
    rpm: 940,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 35,
    reserve: 210,
    reloadTime: 1.78,
    reloadTimeTactical: 1.44,
    reloadCancellable: true,
    equipTime: 0.34,
    holsterTime: 0.2,
    adsTime: 0.15,
    adsZoom: 0.84,
    scoped: false,
    moveScale: 1.06,
    adsMoveScale: 0.66,
    spread: defaultSpread({ hip: 0.021, ads: 0.007, moving: 0.012, perShot: 0.004, max: 0.082, decay: 0.24 }),
    recoil: defaultRecoil({
      up: 0.0079,
      side: 0.0055,
      recoverRate: 11,
      viewKick: 0.021,
      pattern: [0, -0.35, 0.4, -0.55, 0.7, -0.5, 0.85, -0.8, 0.55, -0.95],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 70,
    audio: { fire: 'fire_smg', reload: 'reload_mag', dryFire: 'dry', equip: 'equip', tail: 'tail_short', pitch: 1.12 },
    fx: {
      muzzle: 'plasma',
      muzzleScale: 0.82,
      tracer: 'bolt',
      tracerColor: 0x9dff5e,
      tracerWidth: 0.03,
      impact: 'plasma',
      shells: false,
      shellColor: 0x9dff5e,
      lightColor: 0x9dff5e,
      lightIntensity: 1.2,
    },
    icon: 'smg',
    asset: 'wpn_plasma_smg',
    viewModel: {
      pos: [0.185, -0.17, -0.36],
      rot: [0.015, 0.06, 0],
      adsPos: [0, -0.105, -0.25],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.04, -0.5],
      eject: [0.05, 0.005, -0.14],
      leftHand: [-0.02, -0.05, -0.28],
    },
    perkSlots: ['barrel', 'sight', 'mag', 'stock'],
    classes: ['phantom', 'vanguard'],
    masteryStep: 900,
  },

  // -------------------------------------------------------------------------
  rail_sniper: {
    id: 'rail_sniper',
    name: 'Rail Sniper',
    short: 'RAIL',
    category: 'sniper',
    slot: 'primary',
    fireMode: 'bolt',
    projectile: 'hitscan',
    description: 'Magnetically accelerated slug. One shot to the upper chest or head, punishing bolt cycle.',
    unlockLevel: 4,
    damage: 96,
    damageMin: 88,
    falloffStart: 120,
    falloffEnd: 220,
    range: 320,
    headshotMultiplier: 2.5,
    rpm: 46,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 5,
    reserve: 30,
    reloadTime: 2.9,
    reloadTimeTactical: 2.55,
    reloadCancellable: true,
    equipTime: 0.62,
    holsterTime: 0.34,
    adsTime: 0.34,
    adsZoom: 0.26,
    scoped: true,
    moveScale: 0.9,
    adsMoveScale: 0.34,
    spread: defaultSpread({ hip: 0.075, ads: 0, moving: 0.05, air: 0.09, perShot: 0.02, max: 0.13, decay: 0.4, crouchScale: 0.55 }),
    recoil: defaultRecoil({
      up: 0.052,
      side: 0.006,
      recovery: 0.95,
      recoverRate: 5.4,
      adsScale: 0.85,
      viewKick: 0.11,
      viewRoll: 0.05,
      pattern: [0, 0.2, -0.2, 0.15, -0.15],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 10,
    audio: { fire: 'fire_rail', reload: 'reload_bolt', dryFire: 'dry', equip: 'equip_heavy', tail: 'tail_long', pitch: 0.94 },
    fx: {
      muzzle: 'rail',
      muzzleScale: 1.5,
      tracer: 'beam',
      tracerColor: 0xcfe9ff,
      tracerWidth: 0.05,
      impact: 'rail',
      shells: true,
      shellColor: 0xbfd6e8,
      lightColor: 0xbfe4ff,
      lightIntensity: 3.4,
    },
    icon: 'sniper',
    asset: 'wpn_rail_sniper',
    viewModel: {
      pos: [0.2, -0.175, -0.5],
      rot: [0.008, 0.04, 0],
      adsPos: [0, -0.087, -0.2],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.05, -0.86],
      eject: [0.06, 0.02, -0.2],
      leftHand: [-0.04, -0.06, -0.44],
    },
    perkSlots: ['barrel', 'scope', 'mag', 'bipod'],
    classes: ['spectre'],
    masteryStep: 1100,
  },

  // -------------------------------------------------------------------------
  ion_shotgun: {
    id: 'ion_shotgun',
    name: 'Ion Shotgun',
    short: 'ION-SG',
    category: 'shotgun',
    slot: 'primary',
    fireMode: 'pump',
    projectile: 'hitscan',
    description: 'Eight ionised pellets. Deletes anything inside eight metres and nothing outside twenty.',
    unlockLevel: 2,
    damage: 15,
    damageMin: 3,
    falloffStart: 7,
    falloffEnd: 21,
    range: 45,
    headshotMultiplier: 1.4,
    rpm: 74,
    pellets: 8,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 6,
    reserve: 36,
    reloadTime: 2.6,
    reloadTimeTactical: 2.6,
    reloadCancellable: true,
    equipTime: 0.5,
    holsterTime: 0.28,
    adsTime: 0.22,
    adsZoom: 0.9,
    scoped: false,
    moveScale: 0.97,
    adsMoveScale: 0.6,
    spread: defaultSpread({ hip: 0.062, ads: 0.042, moving: 0.014, air: 0.02, perShot: 0.006, max: 0.09, decay: 0.3, crouchScale: 0.85 }),
    recoil: defaultRecoil({
      up: 0.036,
      side: 0.008,
      recoverRate: 6.5,
      viewKick: 0.085,
      viewRoll: 0.045,
      pattern: [0, 0.4, -0.4, 0.5, -0.5, 0.3],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 12,
    audio: { fire: 'fire_shotgun', reload: 'reload_pump', dryFire: 'dry', equip: 'equip_heavy', tail: 'tail_mid', pitch: 0.9 },
    fx: {
      muzzle: 'ion',
      muzzleScale: 1.7,
      tracer: 'streak',
      tracerColor: 0xffc46b,
      tracerWidth: 0.026,
      impact: 'spark',
      shells: true,
      shellColor: 0xd23a3a,
      lightColor: 0xffb45a,
      lightIntensity: 2.6,
    },
    icon: 'shotgun',
    asset: 'wpn_ion_shotgun',
    viewModel: {
      pos: [0.2, -0.18, -0.44],
      rot: [0.012, 0.05, 0],
      adsPos: [0, -0.12, -0.3],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.04, -0.7],
      eject: [0.05, 0.0, -0.18],
      leftHand: [-0.02, -0.07, -0.4],
    },
    perkSlots: ['choke', 'sight', 'mag', 'stock'],
    classes: ['phantom', 'titan', 'vanguard'],
    masteryStep: 950,
  },

  // -------------------------------------------------------------------------
  particle_lmg: {
    id: 'particle_lmg',
    name: 'Heavy Particle LMG',
    short: 'PARTICLE-LMG',
    category: 'lmg',
    slot: 'primary',
    fireMode: 'auto',
    projectile: 'hitscan',
    description: 'Hundred-round belt with brutal sustained output. Spins up before reaching full rate.',
    unlockLevel: 8,
    damage: 24,
    damageMin: 16,
    falloffStart: 30,
    falloffEnd: 70,
    range: 200,
    headshotMultiplier: 1.7,
    rpm: 720,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 100,
    reserve: 300,
    reloadTime: 4.35,
    reloadTimeTactical: 4.1,
    reloadCancellable: false,
    equipTime: 0.78,
    holsterTime: 0.42,
    adsTime: 0.32,
    adsZoom: 0.82,
    scoped: false,
    moveScale: 0.86,
    adsMoveScale: 0.4,
    spread: defaultSpread({ hip: 0.045, ads: 0.006, moving: 0.03, air: 0.055, perShot: 0.0022, max: 0.062, decay: 0.16, crouchScale: 0.6 }),
    recoil: defaultRecoil({
      up: 0.0088,
      side: 0.0062,
      recovery: 0.74,
      recoverRate: 7.2,
      viewKick: 0.03,
      pattern: [0, 0.3, -0.4, 0.6, -0.55, 0.9, -0.85, 0.7, -1, 0.8, -0.6, 0.95],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 100,
    audio: { fire: 'fire_lmg', reload: 'reload_belt', dryFire: 'dry', equip: 'equip_heavy', tail: 'tail_long', pitch: 0.88 },
    fx: {
      muzzle: 'kinetic',
      muzzleScale: 1.25,
      tracer: 'streak',
      tracerColor: 0xff9a4a,
      tracerWidth: 0.04,
      impact: 'spark',
      shells: true,
      shellColor: 0xc9a44e,
      lightColor: 0xffa04a,
      lightIntensity: 2,
    },
    icon: 'lmg',
    asset: 'wpn_particle_lmg',
    viewModel: {
      pos: [0.215, -0.2, -0.46],
      rot: [0.01, 0.045, 0],
      adsPos: [0, -0.13, -0.3],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.055, -0.78],
      eject: [0.07, -0.02, -0.2],
      leftHand: [-0.05, -0.09, -0.4],
    },
    perkSlots: ['barrel', 'sight', 'belt', 'bipod'],
    classes: ['titan'],
    masteryStep: 1000,
  },

  // -------------------------------------------------------------------------
  burst_carbine: {
    id: 'burst_carbine',
    name: 'Burst Carbine',
    short: 'CARBINE',
    category: 'carbine',
    slot: 'primary',
    fireMode: 'burst',
    projectile: 'hitscan',
    description: 'Three-round burst with near-zero recoil inside the burst. Rewards precise mid-range aim.',
    unlockLevel: 6,
    damage: 30,
    damageMin: 22,
    falloffStart: 34,
    falloffEnd: 72,
    range: 210,
    headshotMultiplier: 2.1,
    rpm: 260,
    pellets: 1,
    burstCount: 3,
    burstInterval: 0.062,
    burstCooldown: 0.2,
    magazine: 27,
    reserve: 162,
    reloadTime: 1.95,
    reloadTimeTactical: 1.62,
    reloadCancellable: true,
    equipTime: 0.4,
    holsterTime: 0.22,
    adsTime: 0.2,
    adsZoom: 0.7,
    scoped: false,
    moveScale: 1.01,
    adsMoveScale: 0.54,
    spread: defaultSpread({ hip: 0.03, ads: 0.0022, moving: 0.02, perShot: 0.0016, max: 0.05, decay: 0.28 }),
    recoil: defaultRecoil({
      up: 0.0082,
      side: 0.0026,
      recovery: 0.93,
      recoverRate: 12,
      viewKick: 0.024,
      pattern: [0, 0.15, -0.18],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 54,
    audio: { fire: 'fire_carbine', reload: 'reload_mag', dryFire: 'dry', equip: 'equip', tail: 'tail_mid', pitch: 1.05 },
    fx: {
      muzzle: 'plasma',
      muzzleScale: 0.95,
      tracer: 'streak',
      tracerColor: 0xc7a2ff,
      tracerWidth: 0.032,
      impact: 'spark',
      shells: true,
      shellColor: 0xd8b25a,
      lightColor: 0xb794ff,
      lightIntensity: 1.6,
    },
    icon: 'carbine',
    asset: 'wpn_burst_carbine',
    viewModel: {
      pos: [0.19, -0.18, -0.4],
      rot: [0.01, 0.05, 0],
      adsPos: [0, -0.11, -0.27],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.045, -0.6],
      eject: [0.055, 0.01, -0.16],
      leftHand: [-0.03, -0.05, -0.33],
    },
    perkSlots: ['barrel', 'sight', 'mag', 'grip'],
    classes: ['vanguard', 'spectre', 'warden'],
    masteryStep: 950,
  },

  // -------------------------------------------------------------------------
  energy_pistol: {
    id: 'energy_pistol',
    name: 'Energy Pistol',
    short: 'E-PISTOL',
    category: 'pistol',
    slot: 'secondary',
    fireMode: 'single',
    projectile: 'hitscan',
    description: 'Fast semi-auto sidearm. Always there when the primary runs dry.',
    unlockLevel: 0,
    damage: 25,
    damageMin: 15,
    falloffStart: 18,
    falloffEnd: 42,
    range: 120,
    headshotMultiplier: 2.0,
    rpm: 400,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 15,
    reserve: 90,
    reloadTime: 1.42,
    reloadTimeTactical: 1.18,
    reloadCancellable: true,
    equipTime: 0.26,
    holsterTime: 0.16,
    adsTime: 0.14,
    adsZoom: 0.88,
    scoped: false,
    moveScale: 1.1,
    adsMoveScale: 0.72,
    spread: defaultSpread({ hip: 0.019, ads: 0.0035, moving: 0.014, perShot: 0.0058, max: 0.055, decay: 0.35 }),
    recoil: defaultRecoil({
      up: 0.014,
      side: 0.005,
      recovery: 0.94,
      recoverRate: 13,
      viewKick: 0.032,
      pattern: [0, 0.3, -0.35, 0.45, -0.4],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 30,
    audio: { fire: 'fire_pistol', reload: 'reload_mag', dryFire: 'dry', equip: 'equip_light', tail: 'tail_short', pitch: 1.18 },
    fx: {
      muzzle: 'plasma',
      muzzleScale: 0.7,
      tracer: 'streak',
      tracerColor: 0x7ff2d8,
      tracerWidth: 0.028,
      impact: 'spark',
      shells: true,
      shellColor: 0xd8b25a,
      lightColor: 0x7ff2d8,
      lightIntensity: 1.2,
    },
    icon: 'pistol',
    asset: 'wpn_energy_pistol',
    viewModel: {
      pos: [0.155, -0.155, -0.3],
      rot: [0.02, 0.06, 0],
      adsPos: [0, -0.1, -0.22],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.035, -0.32],
      eject: [0.04, 0.02, -0.1],
      leftHand: [0.1, -0.06, -0.2],
    },
    perkSlots: ['barrel', 'sight', 'mag'],
    classes: ['vanguard', 'phantom', 'titan', 'warden', 'spectre', 'engineer'],
    masteryStep: 800,
  },

  // -------------------------------------------------------------------------
  tactical_revolver: {
    id: 'tactical_revolver',
    name: 'Tactical Revolver',
    short: 'REVOLVER',
    category: 'revolver',
    slot: 'secondary',
    fireMode: 'single',
    projectile: 'hitscan',
    description: 'Six heavy slugs. Two body shots or one headshot, if you can land them.',
    unlockLevel: 10,
    damage: 58,
    damageMin: 40,
    falloffStart: 30,
    falloffEnd: 62,
    range: 180,
    headshotMultiplier: 1.95,
    rpm: 155,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 6,
    reserve: 36,
    reloadTime: 2.35,
    reloadTimeTactical: 2.35,
    reloadCancellable: true,
    equipTime: 0.34,
    holsterTime: 0.2,
    adsTime: 0.19,
    adsZoom: 0.72,
    scoped: false,
    moveScale: 1.05,
    adsMoveScale: 0.62,
    spread: defaultSpread({ hip: 0.028, ads: 0.001, moving: 0.022, perShot: 0.014, max: 0.08, decay: 0.4, crouchScale: 0.62 }),
    recoil: defaultRecoil({
      up: 0.033,
      side: 0.009,
      recovery: 0.9,
      recoverRate: 7,
      viewKick: 0.075,
      viewRoll: 0.04,
      pattern: [0, 0.5, -0.45, 0.6, -0.55, 0.35],
    }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 12,
    audio: { fire: 'fire_revolver', reload: 'reload_cylinder', dryFire: 'dry', equip: 'equip', tail: 'tail_long', pitch: 0.92 },
    fx: {
      muzzle: 'kinetic',
      muzzleScale: 1.35,
      tracer: 'streak',
      tracerColor: 0xffd76b,
      tracerWidth: 0.038,
      impact: 'spark',
      shells: false,
      shellColor: 0xd8b25a,
      lightColor: 0xffc860,
      lightIntensity: 2.4,
    },
    icon: 'revolver',
    asset: 'wpn_tactical_revolver',
    viewModel: {
      pos: [0.165, -0.16, -0.33],
      rot: [0.018, 0.055, 0],
      adsPos: [0, -0.1, -0.24],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.045, -0.4],
      eject: [0.045, 0.01, -0.12],
      leftHand: [0.09, -0.07, -0.22],
    },
    perkSlots: ['barrel', 'sight', 'grip'],
    classes: ['spectre', 'vanguard', 'warden'],
    masteryStep: 950,
  },

  // -------------------------------------------------------------------------
  plasma_blade: {
    id: 'plasma_blade',
    name: 'Plasma Blade',
    short: 'BLADE',
    category: 'melee',
    slot: 'melee',
    fireMode: 'swing',
    projectile: 'none',
    description: 'Contained plasma edge. Lethal from behind, two hits from the front, silent either way.',
    unlockLevel: 0,
    damage: 62,
    damageMin: 62,
    falloffStart: 100,
    falloffEnd: 100,
    range: 2.6,
    headshotMultiplier: 1.35,
    rpm: 105,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 0,
    reserve: 0,
    reloadTime: 0,
    reloadTimeTactical: 0,
    reloadCancellable: true,
    equipTime: 0.24,
    holsterTime: 0.14,
    adsTime: 0.12,
    adsZoom: 1,
    scoped: false,
    moveScale: 1.14,
    adsMoveScale: 1.1,
    spread: noSpread(),
    recoil: defaultRecoil({ up: 0, side: 0, viewKick: 0.09, viewRoll: 0.1, pattern: [0] }),
    projectileSpeed: 0,
    projectileGravity: 0,
    explosionRadius: 0,
    explosionDamage: 0,
    selfDamageScale: 0,
    meleeRange: 2.6,
    meleeSwingTime: 0.32,
    backstabMultiplier: 2.1,
    chargeTime: 0,
    ammoPickup: 0,
    audio: { fire: 'melee_swing', reload: 'dry', dryFire: 'dry', equip: 'equip_light', tail: 'tail_short', pitch: 1 },
    fx: {
      muzzle: 'blade',
      muzzleScale: 0,
      tracer: 'none',
      tracerColor: 0x2ce8ff,
      tracerWidth: 0,
      impact: 'slash',
      shells: false,
      shellColor: 0,
      lightColor: 0x2ce8ff,
      lightIntensity: 0.8,
    },
    icon: 'blade',
    asset: 'wpn_plasma_blade',
    viewModel: {
      pos: [0.2, -0.2, -0.34],
      rot: [0.1, 0.12, -0.08],
      adsPos: [0.2, -0.2, -0.34],
      adsRot: [0.1, 0.12, -0.08],
      scale: 1,
      muzzle: [0, 0.2, -0.6],
      eject: [0, 0, 0],
      leftHand: [0.12, -0.1, -0.2],
    },
    perkSlots: ['edge'],
    classes: ['phantom', 'vanguard', 'titan', 'warden', 'spectre', 'engineer'],
    masteryStep: 700,
  },

  // -------------------------------------------------------------------------
  arc_launcher: {
    id: 'arc_launcher',
    name: 'Arc Launcher',
    short: 'ARC',
    category: 'launcher',
    slot: 'primary',
    fireMode: 'single',
    projectile: 'arc',
    description: 'Lobs an unstable arc charge. Area denial, terrible against a moving target at range.',
    unlockLevel: 14,
    damage: 42,
    damageMin: 42,
    falloffStart: 100,
    falloffEnd: 100,
    range: 260,
    headshotMultiplier: 1,
    rpm: 52,
    pellets: 1,
    burstCount: 1,
    burstInterval: 0,
    burstCooldown: 0,
    magazine: 4,
    reserve: 16,
    reloadTime: 3.1,
    reloadTimeTactical: 2.85,
    reloadCancellable: true,
    equipTime: 0.7,
    holsterTime: 0.38,
    adsTime: 0.3,
    adsZoom: 0.86,
    scoped: false,
    moveScale: 0.9,
    adsMoveScale: 0.46,
    spread: defaultSpread({ hip: 0.012, ads: 0.002, moving: 0.008, air: 0.012, perShot: 0.004, max: 0.03, decay: 0.4 }),
    recoil: defaultRecoil({
      up: 0.042,
      side: 0.007,
      recovery: 0.92,
      recoverRate: 6,
      viewKick: 0.1,
      viewRoll: 0.05,
      pattern: [0, 0.3, -0.3, 0.2],
    }),
    projectileSpeed: 52,
    projectileGravity: 0.62,
    explosionRadius: 4.2,
    explosionDamage: 78,
    selfDamageScale: 0.45,
    meleeRange: 0,
    meleeSwingTime: 0,
    backstabMultiplier: 1,
    chargeTime: 0,
    ammoPickup: 6,
    audio: { fire: 'fire_launcher', reload: 'reload_tube', dryFire: 'dry', equip: 'equip_heavy', tail: 'tail_long', pitch: 0.85 },
    fx: {
      muzzle: 'arc',
      muzzleScale: 1.6,
      tracer: 'none',
      tracerColor: 0x8dd8ff,
      tracerWidth: 0,
      impact: 'blast',
      shells: false,
      shellColor: 0,
      lightColor: 0x6fd0ff,
      lightIntensity: 3,
    },
    icon: 'launcher',
    asset: 'wpn_arc_launcher',
    viewModel: {
      pos: [0.21, -0.19, -0.48],
      rot: [0.01, 0.05, 0],
      adsPos: [0.02, -0.13, -0.32],
      adsRot: [0, 0, 0],
      scale: 1,
      muzzle: [0, 0.06, -0.8],
      eject: [0, 0, 0],
      leftHand: [-0.04, -0.08, -0.42],
    },
    perkSlots: ['warhead', 'sight', 'tube'],
    classes: ['titan', 'engineer', 'vanguard'],
    masteryStep: 1000,
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/** Stable numeric ids for the binary protocol. Order must never change. */
export const WEAPON_ORDER: readonly string[] = [
  'pulse_ar',
  'plasma_smg',
  'rail_sniper',
  'ion_shotgun',
  'particle_lmg',
  'burst_carbine',
  'energy_pistol',
  'tactical_revolver',
  'plasma_blade',
  'arc_launcher',
];

const weaponIndexMap = new Map<string, number>();
WEAPON_ORDER.forEach((id, i) => weaponIndexMap.set(id, i));

export function weaponIndex(id: string): number {
  return weaponIndexMap.get(id) ?? 0;
}

export function weaponFromIndex(index: number): WeaponDef {
  return WEAPONS[WEAPON_ORDER[index] ?? 'pulse_ar'];
}

export function getWeapon(id: string): WeaponDef {
  const w = WEAPONS[id];
  if (!w) throw new Error(`Unknown weapon: ${id}`);
  return w;
}

export function isWeaponId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(WEAPONS, id);
}

export function weaponsInSlot(slot: WeaponSlot): WeaponDef[] {
  return WEAPON_ORDER.map((id) => WEAPONS[id]).filter((w) => w.slot === slot);
}

// ---------------------------------------------------------------------------
// Derived stats (used by the loadout UI and the balance tests)
// ---------------------------------------------------------------------------

/** Seconds between shots (or bursts). */
export function shotInterval(w: WeaponDef): number {
  return 60 / w.rpm;
}

/** Damage per second assuming perfect body shots and ignoring reloads. */
export function dps(w: WeaponDef): number {
  if (w.fireMode === 'burst') {
    const perBurst = w.damage * w.burstCount * w.pellets;
    const cycle = shotInterval(w);
    return perBurst / cycle;
  }
  return (w.damage * w.pellets) / shotInterval(w);
}

/** Shots needed to kill a target with the given effective health. */
export function shotsToKill(w: WeaponDef, effectiveHealth: number, headshot = false, distance = 0): number {
  const per = damageAtRange(w, distance) * (headshot ? w.headshotMultiplier : 1) * w.pellets;
  if (per <= 0) return Infinity;
  return Math.ceil(effectiveHealth / per);
}

/** Time to kill in seconds (first shot at t=0). */
export function timeToKill(w: WeaponDef, effectiveHealth: number, headshot = false, distance = 0): number {
  const shots = shotsToKill(w, effectiveHealth, headshot, distance);
  if (!Number.isFinite(shots)) return Infinity;
  if (w.fireMode === 'burst') {
    const bursts = Math.ceil(shots / w.burstCount);
    const inBurst = ((shots - 1) % w.burstCount) * w.burstInterval;
    return (bursts - 1) * shotInterval(w) + inBurst;
  }
  return (shots - 1) * shotInterval(w);
}

/** Linear damage falloff between falloffStart and falloffEnd. */
export function damageAtRange(w: WeaponDef, distance: number): number {
  if (distance <= w.falloffStart) return w.damage;
  if (distance >= w.falloffEnd) return w.damageMin;
  const t = (distance - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return w.damage + (w.damageMin - w.damage) * t;
}

/** Magazine + reserve. */
export function totalAmmo(w: WeaponDef): number {
  return w.magazine + w.reserve;
}
