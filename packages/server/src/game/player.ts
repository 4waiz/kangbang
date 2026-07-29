/**
 * Server-side player entity.
 *
 * This is the authoritative record: health, ammo, position, ability charge and
 * every anti-cheat counter live here, and nothing a client sends is written
 * into it without validation.  Clients receive a filtered projection via the
 * snapshot encoder.
 */

import {
  ASSIST_WINDOW,
  BASE_HEALTH,
  CLASSES,
  DEFAULT_MOVE_PARAMS,
  EntFlag,
  HEALTH_REGEN_DELAY,
  HEALTH_REGEN_RATE,
  LAG_COMP_HISTORY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RESPAWN_PROTECTION,
  SHIELD_REGEN_DELAY,
  SHIELD_REGEN_RATE,
  applyPerks,
  clamp,
  createMoveContext,
  createMoveState,
  getClass,
  getWeapon,
  isClassId,
  isWeaponId,
  shotInterval,
  weaponIndex,
  type AbilityDef,
  type ClassDef,
  type InputCommand,
  type LoadoutSelection,
  type MoveContext,
  type MoveState,
  type WeaponDef,
} from '@neon/shared';

export const SLOT_PRIMARY = 0;
export const SLOT_SECONDARY = 1;
export const SLOT_MELEE = 2;
export const SLOT_COUNT = 3;

export interface WeaponRuntime {
  /** Base definition with perks already folded in. */
  def: WeaponDef;
  ammo: number;
  reserve: number;
  /** Seconds until the next shot is allowed. */
  cooldown: number;
  /** Seconds remaining on the current reload, 0 when not reloading. */
  reloadTimer: number;
  /** Accumulated bloom in radians. */
  bloom: number;
  /** Index within the current burst/spray, used for the recoil pattern. */
  shotIndex: number;
  /** Rounds left in the current burst. */
  burstRemaining: number;
  burstTimer: number;
  /** Server timestamp of the last shot, for fire-rate validation. */
  lastShotMs: number;
  /** Stats for the results screen. */
  shotsFired: number;
  shotsHit: number;
  headshots: number;
  kills: number;
  damage: number;
  timeUsedSec: number;
}

export interface DamageMemory {
  attackerId: number;
  amount: number;
  atMs: number;
}

export interface DeployableRef {
  id: number;
  kind: string;
}

export interface AbilityRuntime {
  def: AbilityDef;
  /** 0..1 charge. Ability fires at 1. */
  charge: number;
  /** Seconds of active effect remaining. */
  activeFor: number;
  charges: number;
  /** Cooldown between uses when multiple charges are held. */
  useCooldown: number;
}

export class ServerPlayer {
  // --- identity ----------------------------------------------------------
  readonly id: number;
  profileId: string;
  name: string;
  team = 0;
  bot = false;
  botDifficulty: 'easy' | 'normal' | 'hard' = 'normal';
  connected = true;
  ready = false;
  spectating = false;
  ping = 0;
  accountLevel = 1;
  banner = 'banner_grid';
  icon = 'icon_recruit';

  // --- loadout -----------------------------------------------------------
  classDef: ClassDef;
  loadout: LoadoutSelection;
  weapons: WeaponRuntime[] = [];
  slot = SLOT_PRIMARY;
  lastSlot = SLOT_SECONDARY;
  /** Seconds remaining before the weapon is raised and usable. */
  equipTimer = 0;
  /** Slot we are switching to once the holster finishes. */
  pendingSlot = -1;

  // --- simulation --------------------------------------------------------
  move: MoveState;
  ctx: MoveContext;
  alive = false;
  health = BASE_HEALTH;
  maxHealth = BASE_HEALTH;
  shield = 0;
  maxShield = 0;
  /** Temporary overshield from ultimates, decays with the effect. */
  overshield = 0;
  respawnTimer = 0;
  protectionTimer = 0;
  lastDamagedAtMs = 0;
  aiming = false;
  adsProgress = 0;
  /** Trigger state last tick, so semi-auto weapons require a fresh pull. */
  lastFireHeld = false;
  /**
   * Temporary speed allowance (m/s) granted by an ability impulse - a dash or a
   * launch legitimately exceeds the walking cap. It decays so the allowance
   * cannot be banked, which is what a speed hack would need.
   */
  speedGrant = 0;

  // --- abilities ---------------------------------------------------------
  ability!: AbilityRuntime;
  ultimate!: AbilityRuntime;
  cloaked = false;
  scannedUntilMs = 0;
  /** Hides the HUD when hit by an Engineer EMP. */
  empUntilMs = 0;
  deployables: DeployableRef[] = [];

  // --- scoring -----------------------------------------------------------
  kills = 0;
  deaths = 0;
  assists = 0;
  score = 0;
  objectiveScore = 0;
  streak = 0;
  longestStreak = 0;
  damageDealt = 0;
  headshots = 0;
  multiKillWindowMs = 0;
  multiKillCount = 0;
  /** Gun-progression tier or elimination lives, depending on mode. */
  modeValue = 0;
  carryingCore = false;

  /** Counters folded into the profile at match end. */
  counters: Record<string, number> = {};

  // --- networking --------------------------------------------------------
  lastProcessedSeq = 0;
  /** Highest sequence number ever accepted, to reject replays. */
  highestSeq = 0;
  pendingInputs: InputCommand[] = [];
  /** Ring buffer of past positions for lag compensation. */
  history: { tick: number; x: number; y: number; z: number; yaw: number; height: number }[] = [];
  historyIndex = 0;

  // --- anti-cheat --------------------------------------------------------
  suspicion = 0;
  violations: Record<string, number> = {};
  messageBudget = 0;
  lastMessageWindowMs = 0;

  // --- misc --------------------------------------------------------------
  recentDamage: DamageMemory[] = [];
  mutedBy = new Set<number>();
  spawnedAtMs = 0;
  /** Distance travelled this match, for the Marathon achievement. */
  distanceTravelled = 0;
  timeAliveSec = 0;

  constructor(id: number, profileId: string, name: string, loadout: LoadoutSelection) {
    this.id = id;
    this.profileId = profileId;
    this.name = name;
    this.loadout = sanitiseLoadout(loadout);
    this.classDef = getClass(this.loadout.classId);
    this.move = createMoveState();
    this.ctx = createMoveContext({ ...this.classDef.move });
    for (let i = 0; i < LAG_COMP_HISTORY; i++) {
      this.history.push({ tick: -1, x: 0, y: 0, z: 0, yaw: 0, height: PLAYER_HEIGHT });
    }
    this.applyLoadout(this.loadout);
  }

  // ---------------------------------------------------------------------
  // Loadout
  // ---------------------------------------------------------------------

  applyLoadout(loadout: LoadoutSelection): void {
    this.loadout = sanitiseLoadout(loadout);
    this.classDef = getClass(this.loadout.classId);
    this.ctx.params = { ...this.classDef.move };
    this.maxHealth = this.classDef.health;
    this.maxShield = this.classDef.shield;
    this.ability = makeAbility(this.classDef.ability);
    this.ultimate = makeAbility(this.classDef.ultimate);
    this.weapons = [
      makeWeapon(this.loadout.primary, this.loadout.perks),
      makeWeapon(this.loadout.secondary, this.loadout.perks),
      makeWeapon(this.loadout.melee, this.loadout.perks),
    ];
    this.slot = SLOT_PRIMARY;
    this.lastSlot = SLOT_SECONDARY;
    this.equipTimer = 0;
    this.pendingSlot = -1;
  }

  /** Replace a single slot's weapon (pickups, gun progression). */
  setWeapon(slot: number, weaponId: string, keepAmmo = false): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    const prev = this.weapons[slot];
    const next = makeWeapon(weaponId, this.loadout.perks);
    if (keepAmmo && prev) {
      next.ammo = Math.min(next.def.magazine, prev.ammo);
      next.reserve = Math.min(next.def.reserve, prev.reserve);
    }
    this.weapons[slot] = next;
    if (this.slot === slot) this.equipTimer = next.def.equipTime;
  }

  get weapon(): WeaponRuntime {
    return this.weapons[this.slot] ?? this.weapons[0];
  }

  get radius(): number {
    return this.classDef.visual.build === 'heavy' ? PLAYER_RADIUS * 1.12 : PLAYER_RADIUS;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  spawn(x: number, y: number, z: number, yaw: number, nowMs: number): void {
    this.move = createMoveState({ x, y, z });
    this.move.yaw = yaw;
    this.move.height = PLAYER_HEIGHT;
    this.ctx = createMoveContext({ ...this.classDef.move });
    this.alive = true;
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.overshield = 0;
    this.respawnTimer = 0;
    this.protectionTimer = RESPAWN_PROTECTION;
    this.lastDamagedAtMs = 0;
    this.aiming = false;
    this.adsProgress = 0;
    this.cloaked = false;
    this.carryingCore = false;
    this.spawnedAtMs = nowMs;
    this.recentDamage.length = 0;
    for (const w of this.weapons) {
      w.ammo = w.def.magazine;
      w.reserve = w.def.reserve;
      w.cooldown = 0;
      w.reloadTimer = 0;
      w.bloom = 0;
      w.shotIndex = 0;
      w.burstRemaining = 0;
      w.burstTimer = 0;
    }
    this.slot = SLOT_PRIMARY;
    this.equipTimer = this.weapons[SLOT_PRIMARY].def.equipTime;
    this.pendingSlot = -1;
    for (let i = 0; i < this.history.length; i++) this.history[i].tick = -1;
  }

  die(): void {
    this.alive = false;
    this.deaths++;
    this.streak = 0;
    this.cloaked = false;
    this.carryingCore = false;
    this.aiming = false;
  }

  addScore(points: number, objective = false): void {
    this.score += points;
    if (objective) this.objectiveScore += points;
  }

  bump(counter: string, by = 1): void {
    this.counters[counter] = (this.counters[counter] ?? 0) + by;
  }

  // ---------------------------------------------------------------------
  // Per-tick upkeep that is independent of input
  // ---------------------------------------------------------------------

  tickTimers(dt: number, nowMs: number): void {
    this.protectionTimer = Math.max(0, this.protectionTimer - dt);
    // Ground friction bleeds a dash off in well under a second; decay the
    // allowance a little slower so a legitimate slide-dash is never flagged.
    this.speedGrant = Math.max(0, this.speedGrant - 9 * dt);
    if (this.equipTimer > 0) {
      this.equipTimer = Math.max(0, this.equipTimer - dt);
      if (this.equipTimer === 0 && this.pendingSlot >= 0) {
        this.slot = this.pendingSlot;
        this.pendingSlot = -1;
        this.equipTimer = this.weapon.def.equipTime;
      }
    }

    const w = this.weapon;
    w.cooldown = Math.max(0, w.cooldown - dt);
    w.timeUsedSec += dt;
    if (w.reloadTimer > 0) {
      w.reloadTimer = Math.max(0, w.reloadTimer - dt);
      if (w.reloadTimer === 0) this.finishReload(w);
    }
    if (w.burstTimer > 0) w.burstTimer = Math.max(0, w.burstTimer - dt);
    // Bloom decays once the trigger is released or between bursts.
    w.bloom = Math.max(0, w.bloom - w.def.spread.decay * dt);

    // ADS transition.
    const adsRate = w.def.adsTime > 0 ? dt / w.def.adsTime : 1;
    this.adsProgress = clamp(this.adsProgress + (this.aiming ? adsRate : -adsRate * 1.6), 0, 1);

    // Ability charge.
    tickAbility(this.ability, dt);
    tickAbility(this.ultimate, dt);

    // Regeneration.
    const sinceHit = (nowMs - this.lastDamagedAtMs) / 1000;
    const regenScale = this.classDef.id === 'warden' ? 1.6 : 1;
    if (this.alive) {
      const shieldDelay = this.classDef.shieldRegenDelay || SHIELD_REGEN_DELAY;
      if (this.shield < this.maxShield && sinceHit >= shieldDelay) {
        this.shield = Math.min(this.maxShield, this.shield + SHIELD_REGEN_RATE * regenScale * dt);
      }
      if (this.health < this.maxHealth && sinceHit >= HEALTH_REGEN_DELAY) {
        this.health = Math.min(this.maxHealth, this.health + HEALTH_REGEN_RATE * dt);
      }
      this.timeAliveSec += dt;
    }

    if (this.overshield > 0 && this.ultimate.activeFor <= 0) {
      this.overshield = Math.max(0, this.overshield - 40 * dt);
    }

    // Multi-kill window.
    if (this.multiKillWindowMs > 0) {
      this.multiKillWindowMs = Math.max(0, this.multiKillWindowMs - dt * 1000);
      if (this.multiKillWindowMs === 0) this.multiKillCount = 0;
    }

    // Prune assist memory.
    if (this.recentDamage.length > 0) {
      const cutoff = nowMs - ASSIST_WINDOW * 1000;
      this.recentDamage = this.recentDamage.filter((d) => d.atMs >= cutoff);
    }
  }

  // ---------------------------------------------------------------------
  // Weapon handling
  // ---------------------------------------------------------------------

  canFire(nowMs: number): boolean {
    if (!this.alive) return false;
    const w = this.weapon;
    if (this.equipTimer > 0) return false;
    if (w.reloadTimer > 0) return false;
    if (w.cooldown > 0) return false;
    if (w.burstTimer > 0) return false;
    if (w.def.slot !== 'melee' && w.ammo <= 0) return false;
    void nowMs;
    return true;
  }

  /** Consume a round and start the cooldown. Returns the shot index used. */
  consumeShot(nowMs: number): number {
    const w = this.weapon;
    const idx = w.shotIndex;
    if (w.def.slot !== 'melee') w.ammo = Math.max(0, w.ammo - 1);
    w.shotsFired++;
    w.shotIndex++;
    w.lastShotMs = nowMs;
    w.bloom = Math.min(w.def.spread.max, w.bloom + w.def.spread.perShot);

    if (w.def.fireMode === 'burst') {
      if (w.burstRemaining <= 0) w.burstRemaining = w.def.burstCount;
      w.burstRemaining--;
      if (w.burstRemaining > 0) {
        w.burstTimer = w.def.burstInterval;
        w.cooldown = 0;
      } else {
        w.cooldown = shotInterval(w.def);
        w.shotIndex = 0;
      }
    } else {
      w.cooldown = shotInterval(w.def);
    }
    return idx;
  }

  startReload(): boolean {
    const w = this.weapon;
    if (w.def.slot === 'melee') return false;
    if (w.reloadTimer > 0) return false;
    if (w.ammo >= w.def.magazine) return false;
    if (w.reserve <= 0) return false;
    const tactical = w.ammo > 0;
    let time = tactical ? w.def.reloadTimeTactical : w.def.reloadTime;
    if (this.classDef.id === 'titan' && w.def.category === 'lmg') time *= 0.75;
    if (this.ultimate.activeFor > 0 && this.classDef.id === 'vanguard') time *= 0.8;
    w.reloadTimer = time;
    w.shotIndex = 0;
    w.burstRemaining = 0;
    return true;
  }

  cancelReload(): void {
    const w = this.weapon;
    if (w.reloadTimer > 0 && w.def.reloadCancellable) w.reloadTimer = 0;
  }

  private finishReload(w: WeaponRuntime): void {
    const need = w.def.magazine - w.ammo;
    const take = Math.min(need, w.reserve);
    w.ammo += take;
    w.reserve -= take;
    w.bloom = 0;
  }

  /** Request a slot change; honours the holster time of the current weapon. */
  requestSlot(slot: number): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    if (slot === this.slot && this.pendingSlot < 0) return;
    if (this.pendingSlot === slot) return;
    const current = this.weapon;
    this.lastSlot = this.slot;
    this.cancelReload();
    this.pendingSlot = slot;
    this.equipTimer = Math.max(this.equipTimer, current.def.holsterTime);
  }

  addAmmo(amount: number): boolean {
    let added = false;
    const scale = this.classDef.id === 'engineer' ? 1.4 : 1;
    for (const w of this.weapons) {
      if (w.def.slot === 'melee') continue;
      const cap = w.def.reserve;
      if (w.reserve >= cap) continue;
      w.reserve = Math.min(cap, w.reserve + Math.round(w.def.ammoPickup * amount * scale));
      added = true;
    }
    return added;
  }

  heal(amount: number): number {
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  addShield(amount: number): number {
    const before = this.shield;
    this.shield = Math.min(this.maxShield, this.shield + amount);
    return this.shield - before;
  }

  // ---------------------------------------------------------------------
  // Snapshot projection
  // ---------------------------------------------------------------------

  entityFlags(nowMs: number): number {
    let f = 0;
    if (this.alive) f |= EntFlag.Alive;
    if (this.move.crouching) f |= EntFlag.Crouching;
    if (this.move.sliding) f |= EntFlag.Sliding;
    if (this.move.onGround) f |= EntFlag.OnGround;
    if (this.aiming) f |= EntFlag.Aiming;
    if (this.weapon.reloadTimer > 0) f |= EntFlag.Reloading;
    if (this.bot) f |= EntFlag.Bot;
    if (this.protectionTimer > 0) f |= EntFlag.Protected;
    if (this.cloaked) f |= EntFlag.Cloaked;
    if (this.overshield > 0) f |= EntFlag.Overshield;
    if (this.carryingCore) f |= EntFlag.CarryingCore;
    if (this.scannedUntilMs > nowMs) f |= EntFlag.Scanned;
    if (Math.hypot(this.move.vel.x, this.move.vel.z) > 7.5 && this.move.onGround) f |= EntFlag.Sprinting;
    return f;
  }

  recordHistory(tick: number): void {
    const slotIdx = tick % this.history.length;
    const h = this.history[slotIdx];
    h.tick = tick;
    h.x = this.move.pos.x;
    h.y = this.move.pos.y;
    h.z = this.move.pos.z;
    h.yaw = this.move.yaw;
    h.height = this.move.height;
  }

  /** Position at a past tick for lag compensation; falls back to current. */
  historyAt(tick: number): { x: number; y: number; z: number; yaw: number; height: number } {
    const slotIdx = ((tick % this.history.length) + this.history.length) % this.history.length;
    const h = this.history[slotIdx];
    if (h.tick === tick) return h;
    return { x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z, yaw: this.move.yaw, height: this.move.height };
  }

  flagSuspicion(kind: string, weight: number): void {
    this.violations[kind] = (this.violations[kind] ?? 0) + 1;
    this.suspicion += weight;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWeapon(id: string, perks: readonly string[]): WeaponRuntime {
  const base = isWeaponId(id) ? getWeapon(id) : getWeapon('pulse_ar');
  const def = applyPerks(base, perks);
  return {
    def,
    ammo: def.magazine,
    reserve: def.reserve,
    cooldown: 0,
    reloadTimer: 0,
    bloom: 0,
    shotIndex: 0,
    burstRemaining: 0,
    burstTimer: 0,
    lastShotMs: 0,
    shotsFired: 0,
    shotsHit: 0,
    headshots: 0,
    kills: 0,
    damage: 0,
    timeUsedSec: 0,
  };
}

function makeAbility(def: AbilityDef): AbilityRuntime {
  return { def, charge: 1, activeFor: 0, charges: def.charges, useCooldown: 0 };
}

function tickAbility(a: AbilityRuntime, dt: number): void {
  a.useCooldown = Math.max(0, a.useCooldown - dt);
  if (a.activeFor > 0) a.activeFor = Math.max(0, a.activeFor - dt);
  if (a.charges < a.def.charges) {
    a.charge = Math.min(1, a.charge + dt / a.def.cooldown);
    if (a.charge >= 1) {
      a.charges = Math.min(a.def.charges, a.charges + 1);
      if (a.charges < a.def.charges) a.charge = 0;
    }
  }
}

/** Coerce a client-supplied loadout into something legal. */
export function sanitiseLoadout(raw: Partial<LoadoutSelection> | undefined): LoadoutSelection {
  const classId = raw?.classId && isClassId(raw.classId) ? raw.classId : 'vanguard';
  const cls = CLASSES[classId];
  const pick = (id: string | undefined, slot: 'primary' | 'secondary' | 'melee'): string => {
    if (id && isWeaponId(id) && getWeapon(id).slot === slot) return id;
    return cls.defaultLoadout[slot];
  };
  const perks = Array.isArray(raw?.perks) ? raw.perks.filter((p) => typeof p === 'string').slice(0, 8) : [];
  const skins: Record<string, string> = {};
  if (raw?.skins && typeof raw.skins === 'object') {
    for (const [k, v] of Object.entries(raw.skins)) {
      if (typeof v === 'string' && v.length < 48) skins[k.slice(0, 32)] = v;
    }
  }
  return {
    classId,
    primary: pick(raw?.primary, 'primary'),
    secondary: pick(raw?.secondary, 'secondary'),
    melee: pick(raw?.melee, 'melee'),
    perks,
    skins,
    charm: typeof raw?.charm === 'string' ? raw.charm.slice(0, 48) : undefined,
    killEffect: typeof raw?.killEffect === 'string' ? raw.killEffect.slice(0, 48) : undefined,
    banner: typeof raw?.banner === 'string' ? raw.banner.slice(0, 48) : undefined,
    icon: typeof raw?.icon === 'string' ? raw.icon.slice(0, 48) : undefined,
    bodyColor: typeof raw?.bodyColor === 'string' ? raw.bodyColor.slice(0, 48) : undefined,
    armorVariant: typeof raw?.armorVariant === 'string' ? raw.armorVariant.slice(0, 48) : undefined,
    crosshair: typeof raw?.crosshair === 'string' ? raw.crosshair.slice(0, 48) : undefined,
  };
}

export function defaultLoadoutFor(classId: string): LoadoutSelection {
  const cls = CLASSES[isClassId(classId) ? classId : 'vanguard'];
  return {
    classId: cls.id,
    primary: cls.defaultLoadout.primary,
    secondary: cls.defaultLoadout.secondary,
    melee: cls.defaultLoadout.melee,
    perks: [],
    skins: {},
  };
}

export { DEFAULT_MOVE_PARAMS, weaponIndex };
