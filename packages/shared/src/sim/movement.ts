/**
 * Deterministic movement step, shared verbatim by the client predictor and the
 * server authority.  Given the same MoveState + InputCommand + world, both
 * sides must produce bit-identical results, so:
 *
 *   - no Math.random()
 *   - no wall-clock time
 *   - no reads of renderer / DOM state
 *   - fixed dt supplied by the caller
 */

import {
  AIR_ACCEL,
  AIR_SPEED_CAP,
  COYOTE_TIME,
  CROUCH_SPEED,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_BUFFER,
  JUMP_COOLDOWN,
  JUMP_VELOCITY,
  MAX_SLOPE_COS,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SLIDE_BOOST_SPEED,
  SLIDE_COOLDOWN,
  SLIDE_FRICTION,
  SLIDE_JUMP_RETAIN,
  SLIDE_MAX_TIME,
  SLIDE_MIN_ENTRY_SPEED,
  SLIDE_SLOPE_ACCEL,
  SPRINT_SPEED,
  STEP_HEIGHT,
  TERMINAL_VELOCITY,
  WALK_SPEED,
} from '../constants.js';
import { clamp } from '../math.js';
import { Btn, hasBtn, type InputCommand, type MoveState } from '../types.js';
import {
  overlapBrush,
  worldCeiling,
  worldGround,
  worldSolid,
  type CollisionWorld,
  type GroundInfo,
  type OverlapInfo,
} from './world.js';

/** Per-class movement tuning applied on top of the base numbers. */
export interface MoveParams {
  speedScale: number;
  accelScale: number;
  jumpScale: number;
  airControlScale: number;
  /** Extra slide duration multiplier (Phantom slides further). */
  slideScale: number;
  /** 1 = normal gravity. Titan is heavier. */
  gravityScale: number;
  /** Multiplier applied while aiming down sights. */
  adsSpeedScale: number;
  /** Multiplier from the equipped weapon. */
  weaponSpeedScale: number;
  /** True while the player may not slide (e.g. ability lock). */
  noSlide: boolean;
  /** Momentum multiplier applied once on double jump; 0 disables double jump. */
  doubleJump: boolean;
}

export const DEFAULT_MOVE_PARAMS: MoveParams = {
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
};

export interface MoveOutput {
  /** Surface key the player is standing on, for footstep audio. */
  groundSurface: string;
  /** Impact speed if the player landed this step, else 0. */
  landingSpeed: number;
  /** True if a jump was executed this step. */
  jumped: boolean;
  /** True if a slide started this step. */
  slideStarted: boolean;
  /** True if the player is below the map kill plane. */
  outOfBounds: boolean;
  /** Horizontal speed after the step. */
  speed: number;
  /** Whether the player got stuck and had to be nudged. */
  unstuck: boolean;
}

const groundInfo: GroundInfo = { y: 0, normalY: 1, surface: 'metal', found: false, brushIndex: -1 };
const overlapInfo: OverlapInfo = { hit: false, nx: 0, nz: 0, depth: 0, brush: null };

const out: MoveOutput = {
  groundSurface: 'metal',
  landingSpeed: 0,
  jumped: false,
  slideStarted: false,
  outOfBounds: false,
  speed: 0,
  unstuck: false,
};

/** Extra state that lives alongside MoveState but is not networked per-tick. */
export interface MoveContext {
  params: MoveParams;
  /** Second jump availability, reset on landing. */
  airJumps: number;
  /** True if a movement-affecting ability is active (dash / hover). */
  externalVelX: number;
  externalVelY: number;
  externalVelZ: number;
  /** Seconds of forced-crouch remaining (e.g. under a low ceiling). */
  crouchLock: number;
}

export function createMoveContext(params: MoveParams = DEFAULT_MOVE_PARAMS): MoveContext {
  return {
    params,
    airJumps: 0,
    externalVelX: 0,
    externalVelY: 0,
    externalVelZ: 0,
    crouchLock: 0,
  };
}

/**
 * Advance one movement step.
 *
 * @returns a reused MoveOutput - copy fields you need before the next call.
 */
export function movementStep(
  world: CollisionWorld,
  s: MoveState,
  cmd: InputCommand,
  ctx: MoveContext,
  dt: number,
): MoveOutput {
  const p = ctx.params;
  out.landingSpeed = 0;
  out.jumped = false;
  out.slideStarted = false;
  out.outOfBounds = false;
  out.unstuck = false;
  s.justLanded = false;
  s.justJumped = false;

  s.yaw = cmd.yaw;
  s.pitch = cmd.pitch;

  const wantJump = hasBtn(cmd.buttons, Btn.Jump);
  const wantCrouch = hasBtn(cmd.buttons, Btn.Crouch);
  const wantSprint = hasBtn(cmd.buttons, Btn.Sprint);
  const aiming = hasBtn(cmd.buttons, Btn.Aim);

  // ---- timers -------------------------------------------------------------
  s.slideCooldown = Math.max(0, s.slideCooldown - dt);
  s.jumpCooldown = Math.max(0, s.jumpCooldown - dt);
  ctx.crouchLock = Math.max(0, ctx.crouchLock - dt);
  if (wantJump && !s.jumpHeld) s.jumpBuffer = JUMP_BUFFER;
  else s.jumpBuffer = Math.max(0, s.jumpBuffer - dt);
  s.jumpHeld = wantJump;

  // ---- ground probe -------------------------------------------------------
  const radius = PLAYER_RADIUS;
  const probeMax = s.pos.y + (s.onGround ? STEP_HEIGHT : 0.06);
  worldGround(world, s.pos.x, s.pos.z, probeMax, radius, groundInfo);
  const supportY = groundInfo.found ? groundInfo.y : -Infinity;
  const nearGround = groundInfo.found && s.pos.y - supportY <= (s.onGround ? STEP_HEIGHT : 0.12) + 1e-3;
  const walkable = groundInfo.normalY >= MAX_SLOPE_COS;

  const wasOnGround = s.onGround;
  let onGround = nearGround && walkable && s.vel.y <= 0.6;

  if (onGround) {
    s.coyote = COYOTE_TIME;
    ctx.airJumps = p.doubleJump ? 1 : 0;
  } else {
    s.coyote = Math.max(0, s.coyote - dt);
  }

  if (onGround && !wasOnGround) {
    const impact = -s.vel.y;
    if (impact > 0.5) {
      out.landingSpeed = impact;
      s.lastImpactSpeed = impact;
      s.justLanded = true;
    }
  }

  // ---- crouch / slide -----------------------------------------------------
  const horizSpeed = Math.hypot(s.vel.x, s.vel.z);

  if (s.sliding) {
    s.slideTime -= dt;
    const tooSlow = horizSpeed < SLIDE_MIN_ENTRY_SPEED * 0.42;
    if (s.slideTime <= 0 || !wantCrouch || tooSlow || !onGround) {
      s.sliding = false;
      s.slideCooldown = SLIDE_COOLDOWN;
    }
  } else if (
    wantCrouch &&
    onGround &&
    !p.noSlide &&
    s.slideCooldown <= 0 &&
    horizSpeed >= SLIDE_MIN_ENTRY_SPEED
  ) {
    s.sliding = true;
    s.slideTime = SLIDE_MAX_TIME * p.slideScale;
    out.slideStarted = true;
    // Boost along the current direction, never above the slide cap.
    const boost = Math.min(SLIDE_BOOST_SPEED * p.speedScale, Math.max(horizSpeed * 1.28, SLIDE_BOOST_SPEED * 0.8 * p.speedScale));
    const inv = horizSpeed > 1e-4 ? boost / horizSpeed : 0;
    s.vel.x *= inv;
    s.vel.z *= inv;
  }

  const wantsCrouchHeight = s.sliding || wantCrouch || ctx.crouchLock > 0;
  const targetHeight = wantsCrouchHeight ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;

  if (targetHeight > s.height) {
    // Standing up: only if there is room.
    const ceil = worldCeiling(world, s.pos.x, s.pos.z, s.pos.y + s.height - 0.05, radius);
    const room = ceil - s.pos.y;
    const allowed = Math.min(targetHeight, room - 0.02);
    if (allowed <= s.height) {
      ctx.crouchLock = Math.max(ctx.crouchLock, 0.05);
    } else {
      s.height = Math.min(allowed, s.height + 7.5 * dt);
    }
  } else if (targetHeight < s.height) {
    s.height = Math.max(targetHeight, s.height - 10 * dt);
  }
  s.crouching = s.height < (PLAYER_HEIGHT + PLAYER_CROUCH_HEIGHT) * 0.5;

  // ---- desired direction --------------------------------------------------
  let ix = cmd.moveX;
  let iz = cmd.moveZ;
  const inputLen = Math.hypot(ix, iz);
  if (inputLen > 1) {
    ix /= inputLen;
    iz /= inputLen;
  }
  const cosY = Math.cos(s.yaw);
  const sinY = Math.sin(s.yaw);
  // right = (cos yaw, 0, -sin yaw), forward = (-sin yaw, 0, -cos yaw)
  const dirX = ix * cosY - iz * sinY;
  const dirZ = -ix * sinY - iz * cosY;

  const wishLen = Math.hypot(dirX, dirZ);
  const hasInput = wishLen > 1e-4;
  const wishNX = hasInput ? dirX / wishLen : 0;
  const wishNZ = hasInput ? dirZ / wishLen : 0;

  // ---- target speed -------------------------------------------------------
  const sprinting = wantSprint && !s.crouching && !aiming && iz > 0.1 && onGround;
  let base = WALK_SPEED;
  if (s.sliding) base = SLIDE_BOOST_SPEED;
  else if (s.crouching) base = CROUCH_SPEED;
  else if (sprinting) base = SPRINT_SPEED;
  let maxSpeed = base * p.speedScale * p.weaponSpeedScale;
  if (aiming && !s.sliding) maxSpeed *= p.adsSpeedScale;
  maxSpeed *= Math.min(1, wishLen || 1);

  // ---- acceleration -------------------------------------------------------
  if (onGround) {
    if (s.sliding) {
      applyFriction(s, SLIDE_FRICTION, dt);
      // Downhill acceleration keeps slides feeling alive on wedges.
      if (groundInfo.normalY < 0.999) {
        const slope = Math.sqrt(Math.max(0, 1 - groundInfo.normalY * groundInfo.normalY));
        const sp = Math.hypot(s.vel.x, s.vel.z);
        if (sp > 1e-4) {
          s.vel.x += (s.vel.x / sp) * slope * SLIDE_SLOPE_ACCEL * dt;
          s.vel.z += (s.vel.z / sp) * slope * SLIDE_SLOPE_ACCEL * dt;
        }
      }
      // Reduced steering while sliding.
      if (hasInput) accelerate(s, wishNX, wishNZ, maxSpeed, GROUND_ACCEL * 0.22 * p.accelScale, dt);
    } else {
      applyFriction(s, hasInput ? GROUND_FRICTION : GROUND_FRICTION * 1.35, dt);
      if (hasInput) accelerate(s, wishNX, wishNZ, maxSpeed, GROUND_ACCEL * p.accelScale, dt);
    }
  } else if (hasInput) {
    // Quake-style air control: only the component of wish velocity that is not
    // already present is added, capped at AIR_SPEED_CAP. This is what makes
    // strafe-jumping feel good without breaking the speed ceiling.
    accelerate(s, wishNX, wishNZ, Math.min(maxSpeed, AIR_SPEED_CAP * 6.2), AIR_ACCEL * p.airControlScale * p.accelScale, dt, AIR_SPEED_CAP);
  }

  // ---- external velocity (dashes, launches) -------------------------------
  if (ctx.externalVelX !== 0 || ctx.externalVelY !== 0 || ctx.externalVelZ !== 0) {
    s.vel.x += ctx.externalVelX;
    s.vel.y += ctx.externalVelY;
    s.vel.z += ctx.externalVelZ;
    ctx.externalVelX = 0;
    ctx.externalVelY = 0;
    ctx.externalVelZ = 0;
    if (s.vel.y > 0.1) onGround = false;
  }

  // ---- jump ---------------------------------------------------------------
  const canGroundJump = (onGround || s.coyote > 0) && s.jumpCooldown <= 0;
  if (s.jumpBuffer > 0 && canGroundJump) {
    const retain = s.sliding ? SLIDE_JUMP_RETAIN : 1;
    s.vel.x *= retain;
    s.vel.z *= retain;
    s.vel.y = JUMP_VELOCITY * p.jumpScale;
    s.sliding = false;
    if (s.slideTime > 0) s.slideCooldown = SLIDE_COOLDOWN * 0.5;
    s.slideTime = 0;
    s.jumpBuffer = 0;
    s.coyote = 0;
    s.jumpCooldown = JUMP_COOLDOWN;
    onGround = false;
    out.jumped = true;
    s.justJumped = true;
  } else if (s.jumpBuffer > 0 && !onGround && ctx.airJumps > 0 && s.jumpCooldown <= 0) {
    ctx.airJumps--;
    s.vel.y = JUMP_VELOCITY * p.jumpScale * 0.92;
    s.jumpBuffer = 0;
    s.jumpCooldown = JUMP_COOLDOWN;
    out.jumped = true;
    s.justJumped = true;
  }

  // ---- gravity ------------------------------------------------------------
  if (!onGround) {
    s.vel.y -= GRAVITY * p.gravityScale * dt;
    if (s.vel.y < -TERMINAL_VELOCITY) s.vel.y = -TERMINAL_VELOCITY;
  } else if (s.vel.y < 0) {
    s.vel.y = 0;
  }

  // ---- integrate ----------------------------------------------------------
  s.onGround = onGround;
  s.groundNormalY = onGround ? groundInfo.normalY : 1;
  out.groundSurface = groundInfo.found ? groundInfo.surface : 'metal';

  moveVertical(world, s, dt, radius);
  moveHorizontal(world, s, dt, radius, groundInfo);

  // Re-evaluate ground after the move so the flag we report matches the pose.
  worldGround(world, s.pos.x, s.pos.z, s.pos.y + (s.onGround ? STEP_HEIGHT : 0.06), radius, groundInfo);
  if (groundInfo.found && s.pos.y - groundInfo.y <= 0.08 && groundInfo.normalY >= MAX_SLOPE_COS) {
    if (s.vel.y <= 0.01) {
      if (!s.onGround) {
        const impact = -s.vel.y;
        if (impact > 0.5) {
          out.landingSpeed = Math.max(out.landingSpeed, impact);
          s.lastImpactSpeed = impact;
          s.justLanded = true;
        }
      }
      s.pos.y = groundInfo.y;
      s.vel.y = 0;
      s.onGround = true;
      s.groundNormalY = groundInfo.normalY;
      out.groundSurface = groundInfo.surface;
    }
  } else if (s.pos.y - (groundInfo.found ? groundInfo.y : -Infinity) > 0.09) {
    s.onGround = false;
  }

  // ---- stuck recovery -----------------------------------------------------
  if (worldSolid(world, s.pos.x, s.pos.y, s.pos.z, radius, s.height, 0)) {
    if (nudgeOut(world, s, radius)) out.unstuck = true;
  }

  const speed = Math.hypot(s.vel.x, s.vel.z);
  out.speed = speed;
  if (s.onGround && speed > 0.05) s.stepDistance += speed * dt;
  out.outOfBounds = s.pos.y < world.killY;
  return out;
}

function applyFriction(s: MoveState, friction: number, dt: number): void {
  const speed = Math.hypot(s.vel.x, s.vel.z);
  if (speed < 1e-4) {
    s.vel.x = 0;
    s.vel.z = 0;
    return;
  }
  const drop = Math.max(speed, 1.2) * friction * dt;
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;
  s.vel.x *= scale;
  s.vel.z *= scale;
}

/**
 * Quake acceleration. `cap` limits how much of the wish speed counts towards
 * the projection, which is what enables air-strafe acceleration.
 */
function accelerate(
  s: MoveState,
  dirX: number,
  dirZ: number,
  wishSpeed: number,
  accel: number,
  dt: number,
  cap = 0,
): void {
  const effectiveWish = cap > 0 ? Math.min(wishSpeed, cap) : wishSpeed;
  const current = s.vel.x * dirX + s.vel.z * dirZ;
  const addSpeed = effectiveWish - current;
  if (addSpeed <= 0) return;
  let accelSpeed = accel * dt * wishSpeed;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;
  s.vel.x += dirX * accelSpeed;
  s.vel.z += dirZ * accelSpeed;
}

function moveVertical(world: CollisionWorld, s: MoveState, dt: number, radius: number): void {
  if (s.vel.y === 0) return;
  const dy = s.vel.y * dt;
  if (dy > 0) {
    const ceil = worldCeiling(world, s.pos.x, s.pos.z, s.pos.y + s.height - 0.02, radius);
    const maxY = ceil - s.height - 0.005;
    const target = s.pos.y + dy;
    if (target > maxY) {
      s.pos.y = Math.max(s.pos.y, maxY);
      s.vel.y = 0;
    } else {
      s.pos.y = target;
    }
  } else {
    const target = s.pos.y + dy;
    worldGround(world, s.pos.x, s.pos.z, s.pos.y + 0.02, radius, groundInfo);
    if (groundInfo.found && target <= groundInfo.y) {
      s.pos.y = groundInfo.y;
      // vel.y is zeroed by the caller's landing pass
    } else {
      s.pos.y = target;
    }
  }
}

function moveHorizontal(
  world: CollisionWorld,
  s: MoveState,
  dt: number,
  radius: number,
  ground: GroundInfo,
): void {
  let dx = s.vel.x * dt;
  let dz = s.vel.z * dt;
  if (dx === 0 && dz === 0) return;

  // Sub-step long moves so we cannot tunnel through thin walls at high speed.
  const dist = Math.hypot(dx, dz);
  const steps = dist > radius * 0.75 ? Math.ceil(dist / (radius * 0.75)) : 1;
  dx /= steps;
  dz /= steps;

  const stepTol = s.onGround ? STEP_HEIGHT : 0.04;

  for (let step = 0; step < steps; step++) {
    const startY = s.pos.y;
    s.pos.x += dx;
    s.pos.z += dz;

    // Ghost-step: if the terrain ahead rises within step height, lift the
    // capsule before resolving collisions so stairs/wedges are walkable.
    if (s.onGround) {
      worldGround(world, s.pos.x, s.pos.z, startY + STEP_HEIGHT, radius, ground);
      if (ground.found && ground.y > startY + 1e-3 && ground.y - startY <= STEP_HEIGHT) {
        const lifted = ground.y;
        if (!worldSolid(world, s.pos.x, lifted, s.pos.z, radius, s.height, 0)) {
          s.pos.y = lifted;
        }
      }
    }

    // Depenetration - up to 4 passes, slide velocity along each contact normal.
    for (let pass = 0; pass < 4; pass++) {
      const y0 = s.pos.y + 0.02;
      const y1 = s.pos.y + s.height - 0.02;
      const list = world.query(s.pos.x - radius, s.pos.z - radius, s.pos.x + radius, s.pos.z + radius);
      let deepest = 0;
      let nx = 0;
      let nz = 0;
      for (let i = 0; i < list.length; i++) {
        const b = world.brushes[list[i]];
        const o = overlapBrush(b, s.pos.x, y0, y1, s.pos.z, radius, stepTol, overlapInfo);
        if (o.hit && o.depth > deepest) {
          deepest = o.depth;
          nx = o.nx;
          nz = o.nz;
        }
      }
      if (deepest <= 1e-5) break;
      s.pos.x += nx * (deepest + 1e-4);
      s.pos.z += nz * (deepest + 1e-4);
      const along = s.vel.x * nx + s.vel.z * nz;
      if (along < 0) {
        s.vel.x -= nx * along;
        s.vel.z -= nz * along;
      }
    }
  }
}

/** Last-resort unstick: probe outwards in a small spiral. */
function nudgeOut(world: CollisionWorld, s: MoveState, radius: number): boolean {
  const probes: readonly [number, number, number][] = [
    [0, 0.25, 0],
    [0, 0.6, 0],
    [0.35, 0.1, 0],
    [-0.35, 0.1, 0],
    [0, 0.1, 0.35],
    [0, 0.1, -0.35],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, -0.5],
    [0, 1.4, 0],
  ];
  for (const [ox, oy, oz] of probes) {
    const x = s.pos.x + ox;
    const y = s.pos.y + oy;
    const z = s.pos.z + oz;
    if (!worldSolid(world, x, y, z, radius, s.height, 0)) {
      s.pos.x = x;
      s.pos.y = y;
      s.pos.z = z;
      s.vel.x *= 0.3;
      s.vel.z *= 0.3;
      return true;
    }
  }
  return false;
}

/** Theoretical maximum horizontal speed, used by the server's speed check. */
export function maxTheoreticalSpeed(p: MoveParams): number {
  return Math.max(SPRINT_SPEED, SLIDE_BOOST_SPEED) * p.speedScale * Math.max(1, p.weaponSpeedScale) + 3.5;
}

/** Eye position for a given move state. */
export function eyePosition(s: MoveState, outVec: { x: number; y: number; z: number }): void {
  outVec.x = s.pos.x;
  outVec.y = s.pos.y + Math.max(0.35, s.height - 0.2);
  outVec.z = s.pos.z;
}

export { clamp, STEP_HEIGHT, PLAYER_RADIUS };
