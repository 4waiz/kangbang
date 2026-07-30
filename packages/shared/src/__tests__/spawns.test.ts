/**
 * Spawn-integrity tests.
 *
 * A spawn point that intersects geometry gets pushed out by depenetration, and
 * the player is flung sideways at several times sprint speed the instant they
 * respawn. That is invisible in a screenshot and unpleasant to play, so every
 * spawn on every map is simulated here with zero input: it must settle where it
 * was placed, standing still, on the ground.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASSES,
  CLASS_ORDER,
  CollisionWorld,
  DEFAULT_MOVE_PARAMS,
  MAP_ORDER,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  TICK_DT,
  createMoveContext,
  createMoveState,
  getMap,
  movementStep,
  worldSolid,
  type InputCommand,
  type SpawnPointDef,
} from '../index.js';

function idleInput(seq: number, yaw: number): InputCommand {
  return { seq, dt: TICK_DT, moveX: 0, moveZ: 0, yaw, pitch: 0, buttons: 0, slot: 0, shotSeed: 0 };
}

/** Drop a player at a spawn and let physics settle with no input at all. */
function settle(world: CollisionWorld, spawn: SpawnPointDef, classId: string) {
  const [sx, sy, sz] = spawn.p;
  const state = createMoveState({ x: sx, y: sy, z: sz });
  state.yaw = spawn.yaw;
  const profile = CLASSES[classId].move;
  const ctx = createMoveContext({
    ...DEFAULT_MOVE_PARAMS,
    speedScale: profile.speedScale,
    accelScale: profile.accelScale,
    airControlScale: profile.airControlScale,
    jumpScale: profile.jumpScale,
  });

  let peakSpeed = 0;
  let peakTick = -1;
  for (let i = 0; i < 120; i++) {
    movementStep(world, state, idleInput(i + 1, state.yaw), ctx, TICK_DT);
    const speed = Math.hypot(state.vel.x, state.vel.z);
    if (speed > peakSpeed) {
      peakSpeed = speed;
      peakTick = i;
    }
  }
  return {
    peakSpeed,
    peakTick,
    drift: Math.hypot(state.pos.x - sx, state.pos.z - sz),
    fell: sy - state.pos.y,
    onGround: state.onGround,
    pos: { ...state.pos },
  };
}

describe.each(MAP_ORDER)('%s spawns', (mapId) => {
  const def = getMap(mapId);
  const world = new CollisionWorld(def);

  it('has spawn points', () => {
    expect(def.spawns.length).toBeGreaterThanOrEqual(8);
  });

  it('never places a spawn inside solid geometry', () => {
    const stuck: string[] = [];
    for (const sp of def.spawns) {
      // Check the volume the player body will actually occupy, lifted clear of
      // the floor so resting on it does not read as a collision.
      if (worldSolid(world, sp.p[0], sp.p[1] + 0.08, sp.p[2], PLAYER_RADIUS * 0.95, PLAYER_HEIGHT - 0.12, 0)) {
        stuck.push(`${sp.tag ?? 'spawn'} team=${sp.team} at ${sp.p.join(',')}`);
      }
    }
    expect(stuck, `spawns embedded in geometry:\n${stuck.join('\n')}`).toEqual([]);
  });

  it('does not eject a player who spawns and stands still', () => {
    const ejected: string[] = [];
    for (const sp of def.spawns) {
      for (const classId of CLASS_ORDER) {
        const r = settle(world, sp, classId);
        // Standing still must not produce meaningful horizontal speed. A small
        // amount is fine (settling onto a ramp), but anything approaching sprint
        // speed means depenetration is doing the pushing.
        if (r.peakSpeed > SPRINT_SPEED * 0.5) {
          ejected.push(
            `${sp.tag ?? 'spawn'} team=${sp.team} ${classId}: ${r.peakSpeed.toFixed(2)} m/s at tick ${r.peakTick}` +
              ` (drift ${r.drift.toFixed(2)}m, fell ${r.fell.toFixed(2)}m)`,
          );
        }
      }
    }
    expect(ejected, `spawns eject the player:\n${ejected.join('\n')}`).toEqual([]);
  });

  it('leaves a standing player within a metre of where they spawned', () => {
    const drifted: string[] = [];
    for (const sp of def.spawns) {
      const r = settle(world, sp, 'vanguard');
      if (r.drift > 1) {
        drifted.push(`${sp.tag ?? 'spawn'} team=${sp.team}: drifted ${r.drift.toFixed(2)}m`);
      }
    }
    expect(drifted, `spawns slide the player away:\n${drifted.join('\n')}`).toEqual([]);
  });

  it('puts every spawn on solid ground, not in a pit or mid-air', () => {
    const airborne: string[] = [];
    for (const sp of def.spawns) {
      const r = settle(world, sp, 'vanguard');
      if (!r.onGround) airborne.push(`${sp.tag ?? 'spawn'} team=${sp.team}: never landed`);
      // A spawn more than a short hop above its floor makes players eat a fall.
      else if (r.fell > 1.5) airborne.push(`${sp.tag ?? 'spawn'} team=${sp.team}: fell ${r.fell.toFixed(2)}m`);
      else if (r.pos.y < def.killY + 2) airborne.push(`${sp.tag ?? 'spawn'} team=${sp.team}: settled near the kill plane`);
    }
    expect(airborne, `bad spawn footing:\n${airborne.join('\n')}`).toEqual([]);
  });
});
