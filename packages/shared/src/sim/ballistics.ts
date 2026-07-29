/**
 * Weapon resolution: perk application, spread, hitbox traces and damage.
 *
 * The server owns the authoritative version of every function here.  The
 * client calls the same code purely to draw tracers and predict hit markers -
 * if the two disagree, the server's DamageEvent wins.
 */

import {
  HITBOX_ARM_HALF_WIDTH,
  HITBOX_HEAD_FRACTION,
  HITBOX_HEAD_RADIUS,
  HITBOX_LEGS_TOP,
  HITBOX_TORSO_BOTTOM,
  HITBOX_TORSO_TOP,
  MAX_TRACE_DISTANCE,
  PLAYER_RADIUS,
  RESPAWN_PROTECTION_DAMAGE_SCALE,
} from '../constants.js';
import { Rng, clamp, hashSeed } from '../math.js';
import { PERKS, type PerkDef } from '../data/classes.js';
import { damageAtRange, type WeaponDef } from '../data/weapons.js';
import { BODY_PART_MULTIPLIER, BodyPart, type BodyPartId } from '../types.js';
import { worldRaycast, type CollisionWorld, type RayHit } from './world.js';

// ---------------------------------------------------------------------------
// Perk application
// ---------------------------------------------------------------------------

const perkCache = new Map<string, WeaponDef>();

/**
 * Returns a WeaponDef with the given perks applied.  Results are memoised on
 * the weapon id + sorted perk list, so the hot path never rebuilds objects.
 */
export function applyPerks(base: WeaponDef, perkIds: readonly string[]): WeaponDef {
  const valid = perkIds
    .filter((id) => {
      const p: PerkDef | undefined = PERKS[id];
      return !!p && base.perkSlots.includes(p.slot);
    })
    .sort();
  if (valid.length === 0) return base;

  const key = `${base.id}|${valid.join(',')}`;
  const cached = perkCache.get(key);
  if (cached) return cached;

  const w: WeaponDef = {
    ...base,
    spread: { ...base.spread },
    recoil: { ...base.recoil, pattern: base.recoil.pattern.slice() },
    audio: { ...base.audio },
    fx: { ...base.fx },
    viewModel: {
      ...base.viewModel,
      pos: [...base.viewModel.pos] as [number, number, number],
      rot: [...base.viewModel.rot] as [number, number, number],
      adsPos: [...base.viewModel.adsPos] as [number, number, number],
      adsRot: [...base.viewModel.adsRot] as [number, number, number],
      muzzle: [...base.viewModel.muzzle] as [number, number, number],
      eject: [...base.viewModel.eject] as [number, number, number],
      leftHand: [...base.viewModel.leftHand] as [number, number, number],
    },
    perkSlots: [...base.perkSlots],
    classes: [...base.classes],
  };

  // One perk per slot; later entries in the sorted list lose ties.
  const usedSlots = new Set<string>();
  for (const id of valid) {
    const p = PERKS[id];
    if (usedSlots.has(p.slot)) continue;
    usedSlots.add(p.slot);
    const m = p.mods;
    if (m.damage) w.damage *= m.damage;
    if (m.damage) w.damageMin *= m.damage;
    if (m.rpm) w.rpm *= m.rpm;
    if (m.magazine) w.magazine = Math.max(1, Math.round(w.magazine * m.magazine));
    if (m.reserve) w.reserve = Math.max(0, Math.round(w.reserve * m.reserve));
    if (m.reloadTime) {
      w.reloadTime *= m.reloadTime;
      w.reloadTimeTactical *= m.reloadTime;
    }
    if (m.adsTime) w.adsTime *= m.adsTime;
    if (m.moveScale) w.moveScale *= m.moveScale;
    if (m.adsMoveScale) w.adsMoveScale *= m.adsMoveScale;
    if (m.spreadHip) w.spread.hip *= m.spreadHip;
    if (m.spreadAds) w.spread.ads *= m.spreadAds;
    if (m.spreadPerShot) w.spread.perShot *= m.spreadPerShot;
    if (m.recoilUp) w.recoil.up *= m.recoilUp;
    if (m.recoilSide) w.recoil.side *= m.recoilSide;
    if (m.falloffStart) w.falloffStart *= m.falloffStart;
    if (m.falloffEnd) w.falloffEnd *= m.falloffEnd;
    if (m.range) w.range *= m.range;
    if (m.adsZoom) w.adsZoom = clamp(w.adsZoom * m.adsZoom, 0.15, 1);
    if (m.equipTime) w.equipTime *= m.equipTime;
    if (m.projectileSpeed) w.projectileSpeed *= m.projectileSpeed;
    if (m.explosionRadius) w.explosionRadius *= m.explosionRadius;
  }
  if (w.falloffEnd <= w.falloffStart) w.falloffEnd = w.falloffStart + 1;
  perkCache.set(key, w);
  return w;
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

export interface SpreadInput {
  aiming: boolean;
  crouching: boolean
  onGround: boolean;
  /** Horizontal speed / max speed, 0..1. */
  speedRatio: number;
  /** Accumulated bloom from sustained fire, radians. */
  bloom: number;
}

/** Current cone half-angle in radians. */
export function currentSpread(w: WeaponDef, i: SpreadInput): number {
  const s = w.spread;
  let cone = i.aiming ? s.ads : s.hip;
  cone += s.moving * clamp(i.speedRatio, 0, 1.2);
  if (!i.onGround) cone += s.air;
  cone += i.bloom;
  if (i.crouching) cone *= s.crouchScale;
  return Math.min(cone, s.max + (i.aiming ? s.ads : s.hip) + s.air);
}

/**
 * Deterministic spread direction.
 *
 * The client sends its shot seed with the fire command; the server recomputes
 * the identical cone offsets so predicted tracers land where the authoritative
 * trace went.  Pellet index keeps shotgun patterns consistent.
 */
export function applySpread(
  dirX: number,
  dirY: number,
  dirZ: number,
  cone: number,
  seed: number,
  pellet: number,
  out: { x: number; y: number; z: number },
): void {
  if (cone <= 1e-6) {
    out.x = dirX;
    out.y = dirY;
    out.z = dirZ;
    return;
  }
  const rng = spreadRng;
  rng.reseed(hashSeed(seed, pellet + 1));
  // Uniform disc sample -> cone.
  const r = Math.sqrt(rng.next()) * cone;
  const theta = rng.next() * Math.PI * 2;
  const ox = Math.cos(theta) * r;
  const oy = Math.sin(theta) * r;

  // Build an orthonormal basis around the direction.
  let ux: number;
  let uy: number;
  let uz: number;
  if (Math.abs(dirY) < 0.99) {
    // right = normalize(cross(dir, up))
    ux = dirZ;
    uy = 0;
    uz = -dirX;
  } else {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // up = cross(right, dir)
  const vx = uy * dirZ - uz * dirY;
  const vy = uz * dirX - ux * dirZ;
  const vz = ux * dirY - uy * dirX;

  let nx = dirX + ux * ox + vx * oy;
  let ny = dirY + uy * ox + vy * oy;
  let nz = dirZ + uz * ox + vz * oy;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  out.x = nx;
  out.y = ny;
  out.z = nz;
}

const spreadRng = new Rng(1);

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------

export interface HitTarget {
  id: number;
  /** Capsule bottom position. */
  x: number;
  y: number;
  z: number;
  /** Current capsule height (crouch aware). */
  height: number;
  yaw: number;
  team: number;
  alive: boolean;
  /** Radius override for heavy classes. */
  radius: number;
}

export interface HitboxHit {
  hit: boolean;
  t: number;
  part: BodyPartId;
  px: number;
  py: number;
  pz: number;
}

const hitScratch: HitboxHit = { hit: false, t: 0, part: BodyPart.Torso, px: 0, py: 0, pz: 0 };

/** Ray vs sphere; returns entry t or -1. */
function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  maxT: number,
): number {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  if (t > maxT) return -1;
  return t;
}

/** Ray vs axis-aligned box slab test; returns entry t or -1. */
function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxT: number,
): number {
  let tmin = 0;
  let tmax = maxT;
  // X
  if (Math.abs(dx) < 1e-8) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y
  if (Math.abs(dy) < 1e-8) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z
  if (Math.abs(dz) < 1e-8) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Ray vs a player's three-part hitbox: head sphere, torso box (narrow), and a
 * wider box that covers arms/legs.  Boxes are yaw-aligned to the target so
 * shoulders read correctly from the side.
 */
export function rayHitbox(
  target: HitTarget,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  out: HitboxHit = hitScratch,
): HitboxHit {
  out.hit = false;
  const h = target.height;
  const r = target.radius;

  // Broad reject: sphere around the whole capsule.
  const bcy = target.y + h * 0.5;
  const bRad = Math.max(h * 0.5, r) + 0.1;
  if (raySphere(ox, oy, oz, dx, dy, dz, target.x, bcy, target.z, bRad, maxT) < 0) return out;

  // Head
  const headY = target.y + h * HITBOX_HEAD_FRACTION;
  const tHead = raySphere(ox, oy, oz, dx, dy, dz, target.x, headY, target.z, HITBOX_HEAD_RADIUS * (r / PLAYER_RADIUS), maxT);

  // Transform ray into target-yaw space for the boxes.
  const cos = Math.cos(-target.yaw);
  const sin = Math.sin(-target.yaw);
  const rx = ox - target.x;
  const rz = oz - target.z;
  const lox = rx * cos + rz * sin;
  const loz = -rx * sin + rz * cos;
  const ldx = dx * cos + dz * sin;
  const ldz = -dx * sin + dz * cos;

  const torsoHalfX = r * 0.78;
  const torsoHalfZ = r * 0.5;
  const tTorso = rayAabb(
    lox,
    oy,
    loz,
    ldx,
    dy,
    ldz,
    -torsoHalfX,
    target.y + h * HITBOX_TORSO_BOTTOM,
    -torsoHalfZ,
    torsoHalfX,
    target.y + h * HITBOX_TORSO_TOP,
    torsoHalfZ,
    maxT,
  );

  const armHalfX = HITBOX_ARM_HALF_WIDTH * (r / PLAYER_RADIUS);
  const tArm = rayAabb(
    lox,
    oy,
    loz,
    ldx,
    dy,
    ldz,
    -armHalfX,
    target.y + h * HITBOX_TORSO_BOTTOM,
    -torsoHalfZ * 0.95,
    armHalfX,
    target.y + h * (HITBOX_TORSO_TOP - 0.03),
    torsoHalfZ * 0.95,
    maxT,
  );

  const tLeg = rayAabb(
    lox,
    oy,
    loz,
    ldx,
    dy,
    ldz,
    -r * 0.62,
    target.y,
    -r * 0.52,
    r * 0.62,
    target.y + h * HITBOX_LEGS_TOP,
    r * 0.52,
    maxT,
  );

  let best = Infinity;
  let part: BodyPartId = BodyPart.Torso;
  if (tHead >= 0 && tHead < best) {
    best = tHead;
    part = BodyPart.Head;
  }
  if (tTorso >= 0 && tTorso < best) {
    best = tTorso;
    part = BodyPart.Torso;
  }
  if (tArm >= 0 && tArm < best) {
    best = tArm;
    part = BodyPart.Arm;
  }
  if (tLeg >= 0 && tLeg < best) {
    best = tLeg;
    part = BodyPart.Leg;
  }
  if (!Number.isFinite(best)) return out;

  out.hit = true;
  out.t = best;
  out.part = part;
  out.px = ox + dx * best;
  out.py = oy + dy * best;
  out.pz = oz + dz * best;
  return out;
}

// ---------------------------------------------------------------------------
// Full trace
// ---------------------------------------------------------------------------

export interface TraceOutcome {
  /** Distance travelled before stopping. */
  distance: number;
  endX: number;
  endY: number;
  endZ: number;
  nx: number;
  ny: number;
  nz: number;
  /** -1 when no player was hit. */
  targetId: number;
  part: BodyPartId | null;
  surface: string;
  /** True when the shot passed through penetrable geometry (glass). */
  wallbang: boolean;
  hitWorld: boolean;
}

export function createTraceOutcome(): TraceOutcome {
  return {
    distance: 0,
    endX: 0,
    endY: 0,
    endZ: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    targetId: -1,
    part: null,
    surface: 'metal',
    wallbang: false,
    hitWorld: false,
  };
}

const worldHit: RayHit = { hit: false, t: 0, nx: 0, ny: 1, nz: 0, surface: 'metal', brushIndex: -1, penetrable: false };
const hbHit: HitboxHit = { hit: false, t: 0, part: BodyPart.Torso, px: 0, py: 0, pz: 0 };

/**
 * Single hitscan trace.  Glass and other `penetrable` brushes are passed
 * through (and flagged as a wallbang) but still register an impact effect.
 */
export function traceShot(
  world: CollisionWorld,
  targets: readonly HitTarget[],
  shooterId: number,
  /** Team to ignore, or 0 to hit everyone (FFA / friendly fire). */
  ignoreTeam: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  out: TraceOutcome,
): TraceOutcome {
  const limit = Math.min(maxDist, MAX_TRACE_DISTANCE);
  out.targetId = -1;
  out.part = null;
  out.wallbang = false;
  out.hitWorld = false;

  // World first: bullets stop at solid geometry.
  worldRaycast(world, ox, oy, oz, dx, dy, dz, limit, worldHit, false);
  let stopT = worldHit.hit ? worldHit.t : limit;
  let surface = worldHit.hit ? worldHit.surface : 'air';
  let nx = worldHit.hit ? worldHit.nx : -dx;
  let ny = worldHit.hit ? worldHit.ny : -dy;
  let nz = worldHit.hit ? worldHit.nz : -dz;
  out.hitWorld = worldHit.hit;

  if (worldHit.hit && worldHit.penetrable) {
    // Pass through glass: continue the trace past the pane.
    out.wallbang = true;
    const past = worldHit.t + 0.12;
    worldRaycast(world, ox + dx * past, oy + dy * past, oz + dz * past, dx, dy, dz, limit - past, worldHit, true);
    if (worldHit.hit) {
      stopT = past + worldHit.t;
      surface = worldHit.surface;
      nx = worldHit.nx;
      ny = worldHit.ny;
      nz = worldHit.nz;
      out.hitWorld = true;
    } else {
      stopT = limit;
      surface = 'air';
      out.hitWorld = false;
    }
  }

  // Players.
  let bestT = stopT;
  let bestId = -1;
  let bestPart: BodyPartId | null = null;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t.alive) continue;
    if (t.id === shooterId) continue;
    if (ignoreTeam !== 0 && t.team === ignoreTeam) continue;
    if (rayHitbox(t, ox, oy, oz, dx, dy, dz, bestT, hbHit).hit) {
      if (hbHit.t < bestT) {
        bestT = hbHit.t;
        bestId = t.id;
        bestPart = hbHit.part;
      }
    }
  }

  if (bestId >= 0) {
    out.distance = bestT;
    out.targetId = bestId;
    out.part = bestPart;
    out.surface = 'flesh';
    out.nx = -dx;
    out.ny = -dy;
    out.nz = -dz;
    out.hitWorld = false;
  } else {
    out.distance = stopT;
    out.surface = surface;
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
  }
  out.endX = ox + dx * out.distance;
  out.endY = oy + dy * out.distance;
  out.endZ = oz + dz * out.distance;
  return out;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export interface DamageContext {
  /** Class/ability damage taken multiplier (Titan explosive resist etc). */
  resistance: number;
  /** True while the target still has spawn protection. */
  protected: boolean;
  /** Extra multiplier from behind (melee backstab). */
  backstab: boolean;
}

/** Final damage for a single hit. */
export function computeDamage(
  w: WeaponDef,
  distance: number,
  part: BodyPartId | null,
  ctx: DamageContext,
): { amount: number; headshot: boolean } {
  if (ctx.protected) return { amount: w.damage * RESPAWN_PROTECTION_DAMAGE_SCALE, headshot: false };
  let dmg = damageAtRange(w, distance);
  const headshot = part === BodyPart.Head;
  if (headshot) dmg *= w.headshotMultiplier;
  else if (part) dmg *= BODY_PART_MULTIPLIER[part];
  if (ctx.backstab) dmg *= w.backstabMultiplier;
  dmg *= ctx.resistance;
  return { amount: Math.max(1, Math.round(dmg * 100) / 100), headshot };
}

/** Explosion damage with linear falloff from the centre. */
export function explosionDamage(radius: number, maxDamage: number, distance: number): number {
  if (distance >= radius) return 0;
  const t = 1 - distance / radius;
  // Slightly front-loaded so direct hits feel decisive.
  return maxDamage * (0.35 + 0.65 * t * t);
}

/**
 * Apply damage to a health/shield pair.  Shields absorb first at 1:1 and never
 * carry damage over partially - overflow goes to health.
 */
export function applyDamage(
  health: number,
  shield: number,
  amount: number,
): { health: number; shield: number; absorbed: number; killed: boolean } {
  let remaining = amount;
  let s = shield;
  let absorbed = 0;
  if (s > 0) {
    absorbed = Math.min(s, remaining);
    s -= absorbed;
    remaining -= absorbed;
  }
  const h = Math.max(0, health - remaining);
  return { health: h, shield: s, absorbed, killed: h <= 0 };
}

/** Recoil kick for shot `n` of a spray, using the weapon's deterministic pattern. */
export function recoilForShot(w: WeaponDef, shotIndex: number, aiming: boolean): { pitch: number; yaw: number } {
  const p = w.recoil;
  const scale = aiming ? p.adsScale : 1;
  const idx = p.pattern.length > 0 ? shotIndex % p.pattern.length : 0;
  const lateral = p.pattern.length > 0 ? p.pattern[idx] : 0;
  // Vertical kick eases off deeper into the spray so the pattern is learnable.
  const ramp = 1 - Math.min(0.4, shotIndex * 0.02);
  return {
    pitch: p.up * scale * ramp,
    yaw: p.side * lateral * scale,
  };
}

export { MAX_TRACE_DISTANCE };
