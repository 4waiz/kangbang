/**
 * Movement, collision and hit-detection tests.
 *
 * These run the exact function the server runs (`movementStep`) against a small
 * purpose-built test map, so they cover the shared simulation that both the
 * authority and the client predictor depend on. Determinism is asserted
 * explicitly, because the whole prediction/reconciliation design collapses if
 * the same inputs can produce different outputs.
 */

import { describe, expect, it } from 'vitest';
import {
  BodyPart,
  Btn,
  CollisionWorld,
  DEFAULT_MOVE_PARAMS,
  GRAVITY,
  JUMP_VELOCITY,
  MapBuilder,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  STEP_HEIGHT,
  TICK_DT,
  WALK_SPEED,
  createMoveContext,
  createMoveState,
  createTraceOutcome,
  eyeHeightFor,
  movementStep,
  rayHitbox,
  traceShot,
  worldGround,
  worldLineOfSight,
  worldRaycast,
  worldSolid,
  type HitTarget,
  type InputCommand,
  type MapDef,
  type MoveState,
} from '../index.js';

/**
 * A deliberately small test arena with one of everything the collision code
 * has to handle: flat ground, a wall, a step, a ramp, a low ceiling and a pit.
 */
function buildTestMap(): MapDef {
  const b = new MapBuilder('test_arena', 'Test Arena', 'unit tests', ['tdm']);
  // Ground, with a pit at x > 30.
  b.slab(-40, 30, -40, 40, 0, 'concrete', 1);
  // Solid wall across z = 10, from x = -10 to 10.
  b.wall(-10, 10, 10, 10, 0, 4, 1, 'concrete');
  // A 0.3m step (below STEP_HEIGHT) at z = -10.
  b.slab(-10, 10, -12, -10, 0.3, 'concrete', 0.6);
  // A 1.5m ledge (above STEP_HEIGHT) at z = -20.
  b.slab(-10, 10, -22, -20, 1.5, 'concrete', 1);
  // A walkable ramp rising +x from y=0 to y=3 over 8m, at z = 20.
  b.ramp(20, 20, 8, 6, 0, 3, '+x', 'concrete');
  // A low ceiling forcing a crouch, at x = -20. `ceiling` places the BOTTOM
  // face at the given height, which is what "1.4m of headroom" means.
  b.ceiling(-20, 0, 8, 8, 1.4, 'concrete');
  b.spawn(0, 0, 0, 0, 1);
  b.spawn(0, 0, 5, 180, 2);
  return b.finish({ minX: -44, maxX: 44, minZ: -44, maxZ: 44 }, -20, {
    skybox: 'orbital',
    fogColor: 0,
    fogDensity: 0,
    hemiSky: 0,
    hemiGround: 0,
    hemiIntensity: 1,
    sunColor: 0xffffff,
    sunIntensity: 1,
    sunDir: [0, -1, 0],
    ambientLoop: 'amb_orbital',
    neonBoost: 1,
  });
}

const world = new CollisionWorld(buildTestMap());

function input(over: Partial<InputCommand> = {}): InputCommand {
  return {
    seq: 1,
    dt: TICK_DT,
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    slot: 0,
    shotSeed: 0,
    ...over,
  };
}

/** Run `ticks` steps with a constant input and return the final state. */
function simulate(
  start: { x: number; y: number; z: number },
  cmd: Partial<InputCommand>,
  ticks: number,
  params = { ...DEFAULT_MOVE_PARAMS },
): MoveState {
  const state = createMoveState(start);
  const ctx = createMoveContext(params);
  for (let i = 0; i < ticks; i++) {
    movementStep(world, state, input({ ...cmd, seq: i + 1 }), ctx, TICK_DT);
  }
  return state;
}

describe('collision primitives', () => {
  it('finds the ground under a point', () => {
    const g = worldGround(world, 0, 0, 5, PLAYER_RADIUS, {
      y: 0,
      normalY: 1,
      surface: '',
      found: false,
      brushIndex: -1,
    });
    expect(g.found).toBe(true);
    expect(g.y).toBeCloseTo(0, 3);
    expect(g.normalY).toBeCloseTo(1, 3);
  });

  it('finds no ground over the pit', () => {
    const g = worldGround(world, 35, 0, 5, PLAYER_RADIUS, {
      y: 0,
      normalY: 1,
      surface: '',
      found: false,
      brushIndex: -1,
    });
    expect(g.found).toBe(false);
  });

  it('reports a wall as solid and open floor as not', () => {
    expect(worldSolid(world, 0, 0, 10, PLAYER_RADIUS, PLAYER_HEIGHT, 0)).toBe(true);
    expect(worldSolid(world, 0, 0, 0, PLAYER_RADIUS, PLAYER_HEIGHT, 0)).toBe(false);
  });

  it('does not treat a step within reach as a wall', () => {
    // Standing just before the 0.3m step, with step tolerance applied.
    expect(worldSolid(world, 0, 0, -10.4, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_HEIGHT)).toBe(false);
    // The 1.5m ledge is a wall no matter the tolerance.
    expect(worldSolid(world, 0, 0, -19.6, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_HEIGHT)).toBe(true);
  });

  it('raycasts hit the wall and miss the open floor', () => {
    const hit = worldRaycast(world, 0, 1.5, 0, 0, 0, 1, 40);
    expect(hit.hit).toBe(true);
    expect(hit.t).toBeCloseTo(9.5, 1);
    const miss = worldRaycast(world, 0, 1.5, 0, 0, 0, -1, 5);
    expect(miss.hit).toBe(false);
  });

  it('reports a blocked and a clear line of sight', () => {
    expect(worldLineOfSight(world, { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1.5, z: 20 })).toBe(false);
    expect(worldLineOfSight(world, { x: 0, y: 1.5, z: 0 }, { x: 5, y: 1.5, z: 5 })).toBe(true);
  });

  it('gives a wedge a walkable surface normal', () => {
    const g = worldGround(world, 20, 20, 4, PLAYER_RADIUS, {
      y: 0,
      normalY: 1,
      surface: '',
      found: false,
      brushIndex: -1,
    });
    expect(g.found).toBe(true);
    expect(g.normalY).toBeGreaterThan(0.6);
    expect(g.normalY).toBeLessThan(1);
  });
});

describe('basic movement', () => {
  it('settles onto the ground from a small drop', () => {
    const s = simulate({ x: 0, y: 2, z: 0 }, {}, 90);
    expect(s.pos.y).toBeCloseTo(0, 2);
    expect(s.onGround).toBe(true);
    expect(s.vel.y).toBeCloseTo(0, 3);
  });

  it('reaches walk speed and stops accelerating', () => {
    const s = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1 }, 120);
    const speed = Math.hypot(s.vel.x, s.vel.z);
    expect(speed).toBeGreaterThan(WALK_SPEED * 0.95);
    expect(speed).toBeLessThan(WALK_SPEED * 1.05);
  });

  it('sprints faster than it walks', () => {
    const walk = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1 }, 120);
    const sprint = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1, buttons: Btn.Sprint }, 120);
    expect(Math.hypot(sprint.vel.x, sprint.vel.z)).toBeGreaterThan(Math.hypot(walk.vel.x, walk.vel.z) * 1.2);
    expect(Math.hypot(sprint.vel.x, sprint.vel.z)).toBeLessThan(SPRINT_SPEED * 1.05);
  });

  it('does not sprint backwards', () => {
    const back = simulate({ x: 0, y: 0, z: 0 }, { moveZ: -1, buttons: Btn.Sprint }, 120);
    expect(Math.hypot(back.vel.x, back.vel.z)).toBeLessThan(WALK_SPEED * 1.05);
  });

  it('moves forward along -Z at yaw 0', () => {
    const s = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1 }, 60);
    expect(s.pos.z).toBeLessThan(-2);
    expect(Math.abs(s.pos.x)).toBeLessThan(0.2);
  });

  it('strafes right along +X at yaw 0', () => {
    const s = simulate({ x: 0, y: 0, z: 0 }, { moveX: 1 }, 60);
    expect(s.pos.x).toBeGreaterThan(2);
  });

  it('normalises diagonal input so it is not faster', () => {
    const straight = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1 }, 120);
    const diagonal = simulate({ x: 0, y: 0, z: 0 }, { moveX: 1, moveZ: 1 }, 120);
    const a = Math.hypot(straight.vel.x, straight.vel.z);
    const bSpeed = Math.hypot(diagonal.vel.x, diagonal.vel.z);
    expect(bSpeed).toBeLessThan(a * 1.03);
  });

  it('decelerates to a stop when input is released', () => {
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (let i = 0; i < 60; i++) movementStep(world, state, input({ moveZ: 1, seq: i }), ctx, TICK_DT);
    for (let i = 0; i < 90; i++) movementStep(world, state, input({ seq: 100 + i }), ctx, TICK_DT);
    expect(Math.hypot(state.vel.x, state.vel.z)).toBeLessThan(0.05);
  });
});

describe('jumping', () => {
  it('leaves the ground and reaches roughly the expected apex', () => {
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    // Release then press so the jump buffer registers an edge.
    movementStep(world, state, input({ seq: 1 }), ctx, TICK_DT);
    let apex = 0;
    for (let i = 0; i < 120; i++) {
      movementStep(world, state, input({ seq: 2 + i, buttons: i < 3 ? Btn.Jump : 0 }), ctx, TICK_DT);
      apex = Math.max(apex, state.pos.y);
    }
    const theoretical = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
    expect(apex).toBeGreaterThan(theoretical * 0.8);
    expect(apex).toBeLessThan(theoretical * 1.15);
    // And it must come back down and be standing on something.
    expect(state.onGround).toBe(true);
    expect(state.pos.y).toBeLessThan(0.2);
  });

  it('cannot jump repeatedly while holding the key mid-air', () => {
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    movementStep(world, state, input({ seq: 1 }), ctx, TICK_DT);
    let jumps = 0;
    for (let i = 0; i < 240; i++) {
      const out = movementStep(world, state, input({ seq: 2 + i, buttons: Btn.Jump }), ctx, TICK_DT);
      if (out.jumped) jumps++;
    }
    // Auto-bhop is allowed on landing, but a 4-second hold must not produce
    // anything close to one jump per tick.
    expect(jumps).toBeLessThan(12);
    expect(jumps).toBeGreaterThan(0);
  });

  it('gives a double jump only to classes that have it', () => {
    const countJumps = (doubleJump: boolean) => {
      const state = createMoveState({ x: 0, y: 0, z: 0 });
      const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS, doubleJump });
      movementStep(world, state, input({ seq: 1 }), ctx, TICK_DT);
      let jumps = 0;
      // Press, release, press again while airborne.
      const pattern = [Btn.Jump, Btn.Jump, 0, 0, 0, 0, 0, 0, Btn.Jump, Btn.Jump, 0, 0];
      for (let i = 0; i < 60; i++) {
        const out = movementStep(world, state, input({ seq: 2 + i, buttons: pattern[i] ?? 0 }), ctx, TICK_DT);
        if (out.jumped) jumps++;
      }
      return jumps;
    };
    expect(countJumps(false)).toBe(1);
    expect(countJumps(true)).toBe(2);
  });
});

describe('crouching and ceilings', () => {
  it('shrinks the capsule when crouching', () => {
    const s = simulate({ x: 0, y: 0, z: 0 }, { buttons: Btn.Crouch }, 60);
    expect(s.height).toBeCloseTo(PLAYER_CROUCH_HEIGHT, 2);
    expect(s.crouching).toBe(true);
    expect(eyeHeightFor(s.height)).toBeLessThan(eyeHeightFor(PLAYER_HEIGHT));
  });

  it('stands back up when the key is released', () => {
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (let i = 0; i < 40; i++) movementStep(world, state, input({ seq: i, buttons: Btn.Crouch }), ctx, TICK_DT);
    for (let i = 0; i < 60; i++) movementStep(world, state, input({ seq: 100 + i }), ctx, TICK_DT);
    expect(state.height).toBeCloseTo(PLAYER_HEIGHT, 2);
  });

  it('refuses to stand up under a low ceiling', () => {
    // Crouch, walk under the 1.4m ceiling, then release crouch.
    const state = createMoveState({ x: -20, y: 0, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (let i = 0; i < 40; i++) movementStep(world, state, input({ seq: i, buttons: Btn.Crouch }), ctx, TICK_DT);
    expect(state.height).toBeCloseTo(PLAYER_CROUCH_HEIGHT, 2);
    for (let i = 0; i < 60; i++) movementStep(world, state, input({ seq: 100 + i }), ctx, TICK_DT);
    // Still crouched, and crucially not clipped into the ceiling.
    expect(state.height).toBeLessThan(1.4);
    expect(state.pos.y + state.height).toBeLessThanOrEqual(1.42);
  });

  it('crouch-walks slower than it walks', () => {
    const walk = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1 }, 120);
    const crouch = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1, buttons: Btn.Crouch }, 120);
    expect(Math.hypot(crouch.vel.x, crouch.vel.z)).toBeLessThan(Math.hypot(walk.vel.x, walk.vel.z));
  });
});

describe('sliding', () => {
  it('boosts speed when entered at a sprint', () => {
    // Sprint east across open floor, then add crouch.
    const state = createMoveState({ x: -20, y: 0, z: 30 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (let i = 0; i < 90; i++) {
      movementStep(world, state, input({ seq: i, moveZ: 1, yaw: -Math.PI / 2, buttons: Btn.Sprint }), ctx, TICK_DT);
    }
    const sprintSpeed = Math.hypot(state.vel.x, state.vel.z);
    expect(sprintSpeed, 'must be sprinting before the slide').toBeGreaterThan(6);
    let started = false;
    let peak = sprintSpeed;
    for (let i = 0; i < 4; i++) {
      const out = movementStep(
        world,
        state,
        input({ seq: 200 + i, moveZ: 1, yaw: -Math.PI / 2, buttons: Btn.Sprint | Btn.Crouch }),
        ctx,
        TICK_DT,
      );
      if (out.slideStarted) started = true;
      peak = Math.max(peak, Math.hypot(state.vel.x, state.vel.z));
    }
    expect(started).toBe(true);
    expect(state.sliding).toBe(true);
    expect(peak).toBeGreaterThan(sprintSpeed);
  });

  it('cannot be entered from standing still', () => {
    const state = createMoveState({ x: 0, y: 0, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    const out = movementStep(world, state, input({ buttons: Btn.Crouch }), ctx, TICK_DT);
    expect(out.slideStarted).toBe(false);
    expect(state.sliding).toBe(false);
  });

  it('ends on its own and cannot be held forever', () => {
    const state = createMoveState({ x: -20, y: 0, z: 30 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (let i = 0; i < 90; i++) {
      movementStep(world, state, input({ seq: i, moveZ: 1, yaw: -Math.PI / 2, buttons: Btn.Sprint }), ctx, TICK_DT);
    }
    for (let i = 0; i < 240; i++) {
      movementStep(world, state, input({ seq: 200 + i, moveZ: 1, yaw: -Math.PI / 2, buttons: Btn.Crouch }), ctx, TICK_DT);
    }
    expect(state.sliding).toBe(false);
  });
});

describe('geometry traversal', () => {
  it('walks up a small step without jumping', () => {
    // Walk north onto the 0.3m step (z from -10 to -12). Rather than guess how
    // far the walk gets in N ticks, assert that the player was lifted onto the
    // step at some point while crossing it and never left the ground.
    const state = createMoveState({ x: 0, y: 0, z: -8 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    let liftedOnStep = false;
    let launched = false;
    for (let i = 0; i < 60; i++) {
      movementStep(world, state, input({ seq: i, moveZ: 1 }), ctx, TICK_DT);
      if (state.pos.z <= -10.4 && state.pos.z >= -11.6 && state.pos.y > 0.25) liftedOnStep = true;
      // Stepping up must not impart upward velocity. (Walking off the far edge
      // of the step legitimately leaves the ground, so onGround is not the
      // signal here - a positive vertical velocity is.)
      if (state.vel.y > 0.01) launched = true;
    }
    expect(liftedOnStep, 'never stepped up onto the 0.3m ledge').toBe(true);
    expect(launched, 'stepping up must not launch the player').toBe(false);
    expect(state.pos.z).toBeLessThan(-11);
  });

  it('is blocked by a ledge taller than the step height', () => {
    const s = simulate({ x: 0, y: 0.3, z: -14 }, { moveZ: 1, buttons: Btn.Sprint }, 180);
    // Must not have climbed the 1.5m ledge by walking into it.
    expect(s.pos.y).toBeLessThan(1.4);
  });

  it('walks up a ramp', () => {
    // The ramp occupies x 16..24 at z 17..23, rising towards +x. Strafing right
    // at yaw 0 moves along +X.
    const s = simulate({ x: 14, y: 0, z: 20 }, { moveX: 1 }, 90);
    expect(s.pos.x).toBeGreaterThan(17);
    expect(s.pos.y).toBeGreaterThan(0.5);
  });

  it('is stopped by a wall and does not tunnel through at full speed', () => {
    const s = simulate({ x: 0, y: 0, z: 4 }, { moveZ: -1, buttons: Btn.Sprint }, 240);
    // The wall face is at z = 9.5; the capsule radius keeps us short of it.
    expect(s.pos.z).toBeLessThan(9.6);
    expect(s.pos.z).toBeGreaterThan(8.5);
  });

  it('slides along a wall instead of sticking to it', () => {
    // Push diagonally into the wall (+Z) while also pushing +X: the component
    // along the wall must survive the depenetration.
    const s = simulate({ x: -6, y: 0, z: 4 }, { moveX: 1, moveZ: -1 }, 150);
    expect(s.pos.z).toBeLessThan(9.6);
    expect(s.pos.x).toBeGreaterThan(-2);
  });

  it('falls into the pit and reports out of bounds', () => {
    const state = createMoveState({ x: 35, y: 1, z: 0 });
    const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    let outOfBounds = false;
    for (let i = 0; i < 240; i++) {
      const out = movementStep(world, state, input({ seq: i }), ctx, TICK_DT);
      if (out.outOfBounds) outOfBounds = true;
    }
    expect(outOfBounds).toBe(true);
  });

  it('never ends a step embedded in solid geometry', () => {
    // Drive into every wall from several angles and assert we stay outside.
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const s = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1, yaw, buttons: Btn.Sprint }, 240);
      expect(worldSolid(world, s.pos.x, s.pos.y, s.pos.z, PLAYER_RADIUS, s.height, 0), `yaw=${yaw}`).toBe(false);
    }
  });
});

describe('determinism', () => {
  it('produces identical results for identical inputs', () => {
    const run = () => {
      const state = createMoveState({ x: 1.234, y: 0, z: -5.678 });
      const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
      for (let i = 0; i < 300; i++) {
        movementStep(
          world,
          state,
          input({
            seq: i,
            moveX: Math.sin(i * 0.11),
            moveZ: Math.cos(i * 0.07),
            yaw: i * 0.03,
            buttons: (i % 17 === 0 ? Btn.Jump : 0) | (i % 23 === 0 ? Btn.Crouch : 0) | Btn.Sprint,
          }),
          ctx,
          TICK_DT,
        );
      }
      return state;
    };
    const a = run();
    const b = run();
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.height).toBe(b.height);
    expect(a.onGround).toBe(b.onGround);
  });

  it('a replayed input sequence reproduces the same position (reconciliation)', () => {
    const commands = Array.from({ length: 120 }, (_, i) =>
      input({ seq: i + 1, moveZ: 1, moveX: Math.sin(i * 0.2), yaw: i * 0.01, buttons: Btn.Sprint }),
    );
    const live = createMoveState({ x: 0, y: 0, z: 0 });
    const liveCtx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (const c of commands) movementStep(world, live, c, liveCtx, c.dt);

    // Replay from the same start, as the client does after a correction.
    const replay = createMoveState({ x: 0, y: 0, z: 0 });
    const replayCtx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
    for (const c of commands) movementStep(world, replay, c, replayCtx, c.dt);

    expect(replay.pos.x).toBeCloseTo(live.pos.x, 10);
    expect(replay.pos.y).toBeCloseTo(live.pos.y, 10);
    expect(replay.pos.z).toBeCloseTo(live.pos.z, 10);
  });
});

describe('class movement profiles', () => {
  it('a faster speed scale actually moves faster', () => {
    // Run along +X across open floor so neither run meets geometry.
    const cmd = { moveZ: 1, yaw: -Math.PI / 2, buttons: Btn.Sprint };
    const base = simulate({ x: -30, y: 0, z: 30 }, cmd, 120);
    const fast = simulate({ x: -30, y: 0, z: 30 }, cmd, 120, { ...DEFAULT_MOVE_PARAMS, speedScale: 1.14 });
    expect(Math.hypot(fast.vel.x, fast.vel.z)).toBeGreaterThan(Math.hypot(base.vel.x, base.vel.z) * 1.05);
    expect(fast.pos.x).toBeGreaterThan(base.pos.x);
  });

  it('a heavier gravity scale falls faster', () => {
    const light = simulate({ x: 0, y: 6, z: 0 }, {}, 20);
    const heavy = simulate({ x: 0, y: 6, z: 0 }, {}, 20, { ...DEFAULT_MOVE_PARAMS, gravityScale: 1.4 });
    expect(heavy.pos.y).toBeLessThan(light.pos.y);
  });

  it('aiming slows movement by the weapon and class factor', () => {
    const hip = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1 }, 150);
    const ads = simulate({ x: 0, y: 0, z: 0 }, { moveZ: 1, buttons: Btn.Aim }, 150);
    expect(Math.hypot(ads.vel.x, ads.vel.z)).toBeLessThan(Math.hypot(hip.vel.x, hip.vel.z) * 0.7);
  });
});

describe('hit detection', () => {
  const target: HitTarget = {
    id: 1,
    x: 0,
    y: 0,
    z: -10,
    height: PLAYER_HEIGHT,
    yaw: 0,
    team: 2,
    alive: true,
    radius: PLAYER_RADIUS,
  };

  it('registers a headshot on the head sphere', () => {
    const out = rayHitbox(target, 0, PLAYER_HEIGHT * 0.915, 0, 0, 0, -1, 40);
    expect(out.hit).toBe(true);
    expect(out.part).toBe(BodyPart.Head);
  });

  it('registers a torso hit at chest height', () => {
    const out = rayHitbox(target, 0, PLAYER_HEIGHT * 0.68, 0, 0, 0, -1, 40);
    expect(out.hit).toBe(true);
    expect(out.part).toBe(BodyPart.Torso);
  });

  it('registers a leg hit low down', () => {
    const out = rayHitbox(target, 0, 0.4, 0, 0, 0, -1, 40);
    expect(out.hit).toBe(true);
    expect(out.part).toBe(BodyPart.Leg);
  });

  it('registers an arm hit out at the shoulder', () => {
    const out = rayHitbox(target, 0.45, PLAYER_HEIGHT * 0.7, 0, 0, 0, -1, 40);
    expect(out.hit).toBe(true);
    expect(out.part).toBe(BodyPart.Arm);
  });

  it('misses cleanly beside and above the target', () => {
    expect(rayHitbox(target, 3, 1, 0, 0, 0, -1, 40).hit).toBe(false);
    expect(rayHitbox(target, 0, 4, 0, 0, 0, -1, 40).hit).toBe(false);
  });

  it('misses a target behind the maximum range', () => {
    expect(rayHitbox(target, 0, 1, 0, 0, 0, -1, 5).hit).toBe(false);
  });

  it('shrinks the hitbox when the target crouches', () => {
    const crouched: HitTarget = { ...target, height: PLAYER_CROUCH_HEIGHT };
    // A ray at standing head height must now pass over a crouched player.
    expect(rayHitbox(crouched, 0, PLAYER_HEIGHT * 0.915, 0, 0, 0, -1, 40).hit).toBe(false);
    expect(rayHitbox(crouched, 0, PLAYER_CROUCH_HEIGHT * 0.915, 0, 0, 0, -1, 40).part).toBe(BodyPart.Head);
  });
});

describe('shot tracing', () => {
  const enemy: HitTarget = {
    id: 2,
    x: 0,
    y: 0,
    z: 5,
    height: PLAYER_HEIGHT,
    yaw: 0,
    team: 2,
    alive: true,
    radius: PLAYER_RADIUS,
  };
  const ally: HitTarget = { ...enemy, id: 3, team: 1, x: 2 };

  it('hits an enemy in the open', () => {
    const out = traceShot(world, [enemy], 1, 1, 0, 1.5, 0, 0, 0, 1, 100, createTraceOutcome());
    expect(out.targetId).toBe(2);
    expect(out.part).toBeTruthy();
    expect(out.distance).toBeGreaterThan(4);
  });

  it('ignores a teammate when friendly fire is off', () => {
    const out = traceShot(world, [ally], 1, 1, 0, 1.5, 0, 0.37, 0, 0.93, 100, createTraceOutcome());
    expect(out.targetId).toBe(-1);
  });

  it('hits a teammate when friendly fire is on (ignoreTeam 0)', () => {
    const straightAtAlly: HitTarget = { ...ally, x: 0 };
    const out = traceShot(world, [straightAtAlly], 1, 0, 0, 1.5, 0, 0, 0, 1, 100, createTraceOutcome());
    expect(out.targetId).toBe(3);
  });

  it('never hits the shooter', () => {
    const self: HitTarget = { ...enemy, id: 1, z: 0 };
    const out = traceShot(world, [self], 1, 1, 0, 1.5, 0, 0, 0, 1, 100, createTraceOutcome());
    expect(out.targetId).toBe(-1);
  });

  it('is blocked by a wall standing between shooter and target', () => {
    const behindWall: HitTarget = { ...enemy, z: 15 };
    const out = traceShot(world, [behindWall], 1, 1, 0, 1.5, 0, 0, 0, 1, 100, createTraceOutcome());
    expect(out.targetId).toBe(-1);
    expect(out.hitWorld).toBe(true);
  });

  it('ignores a dead target', () => {
    const dead: HitTarget = { ...enemy, alive: false };
    const out = traceShot(world, [dead], 1, 1, 0, 1.5, 0, 0, 0, 1, 100, createTraceOutcome());
    expect(out.targetId).toBe(-1);
  });

  it('picks the nearest of two stacked targets', () => {
    const near: HitTarget = { ...enemy, id: 5, z: 4 };
    const far: HitTarget = { ...enemy, id: 6, z: 8 };
    const out = traceShot(world, [far, near], 1, 1, 0, 1.5, 0, 0, 0, 1, 100, createTraceOutcome());
    expect(out.targetId).toBe(5);
  });

  it('stops at the trace limit when nothing is hit', () => {
    // Straight up: the only direction in this arena with nothing in the way.
    const out = traceShot(world, [], 1, 1, 0, 2, 0, 0, 1, 0, 25, createTraceOutcome());
    expect(out.targetId).toBe(-1);
    expect(out.distance).toBeCloseTo(25, 3);
    expect(out.surface).toBe('air');
    expect(out.hitWorld).toBe(false);
  });
});
