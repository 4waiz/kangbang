/**
 * Map integrity tests.
 *
 * These caught (and now guard against) a whole family of real level bugs:
 *   - spawns facing into their own back wall
 *   - spawns floating above or buried inside geometry
 *   - a sunken plaza roofed over by its own street slab
 *   - access ramps running underneath the walkway they feed, leaving <1m of
 *     headroom at the top of the climb
 *   - staircases whose individual steps exceeded the player's step height
 *
 * Every one of those presents in-game as "invisible collision" or a bot that
 * refuses to move, so they are asserted rather than eyeballed.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  CollisionWorld,
  DEFAULT_MOVE_PARAMS,
  MAP_ORDER,
  MODE_ORDER,
  NavPathfinder,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  TICK_DT,
  buildNavGraph,
  createMoveContext,
  createMoveState,
  getMap,
  isModeId,
  isWeaponId,
  movementStep,
  navStats,
  nearestNode,
  worldCeiling,
  worldGround,
  worldSolid,
  type MapDef,
  type NavGraph,
} from '../index.js';

interface Compiled {
  def: MapDef;
  world: CollisionWorld;
  nav: NavGraph;
}

const cache = new Map<string, Compiled>();
function compile(id: string): Compiled {
  let c = cache.get(id);
  if (!c) {
    const def = getMap(id);
    const world = new CollisionWorld(def);
    const nav = buildNavGraph(world, 2.0);
    c = { def, world, nav };
    cache.set(id, c);
  }
  return c;
}

const freshGround = () => ({ y: 0, normalY: 1, surface: '', found: false, brushIndex: -1 });

describe('map catalogue', () => {
  it('exposes exactly the three shipped maps', () => {
    expect(MAP_ORDER).toEqual(['neon_foundry', 'orbital_nexus', 'mirage_district']);
  });

  for (const id of MAP_ORDER) {
    it(`${id} declares only real modes`, () => {
      const { def } = compile(id);
      expect(def.modes.length).toBeGreaterThan(0);
      for (const m of def.modes) expect(isModeId(m)).toBe(true);
    });

    it(`${id} references only real weapons in pickups`, () => {
      const { def } = compile(id);
      for (const p of def.pickups) {
        if (p.kind === 'weapon') expect(isWeaponId(p.weapon ?? '')).toBe(true);
      }
    });

    it(`${id} has team spawns for both teams and neutral spawns for FFA`, () => {
      const { def } = compile(id);
      expect(def.spawns.filter((s) => s.team === 1).length).toBeGreaterThanOrEqual(4);
      expect(def.spawns.filter((s) => s.team === 2).length).toBeGreaterThanOrEqual(4);
      expect(def.spawns.filter((s) => s.team === 0).length).toBeGreaterThanOrEqual(8);
    });

    it(`${id} has objective anchors for every objective mode it advertises`, () => {
      const { def } = compile(id);
      if (def.modes.includes('domination')) {
        expect(def.objectives.filter((o) => o.kind === 'zone').length).toBe(3);
      }
      if (def.modes.includes('hardpoint')) {
        expect(def.objectives.filter((o) => o.kind === 'hardpoint').length).toBeGreaterThanOrEqual(3);
      }
      if (def.modes.includes('core')) {
        const cores = def.objectives.filter((o) => o.kind === 'core');
        expect(cores.length).toBe(2);
        expect(new Set(cores.map((c) => c.team))).toEqual(new Set([1, 2]));
      }
    });
  }
});

describe('spawn placement', () => {
  for (const id of MAP_ORDER) {
    it(`${id}: every spawn stands on walkable ground with headroom`, () => {
      const { def, world } = compile(id);
      const bad: string[] = [];
      for (const s of def.spawns) {
        const [x, y, z] = s.p;
        const g = worldGround(world, x, z, y + 1.0, PLAYER_RADIUS, freshGround());
        if (!g.found) {
          bad.push(`(${x},${y},${z}) no ground`);
          continue;
        }
        if (Math.abs(g.y - y) > 1.2) bad.push(`(${x},${y},${z}) ground=${g.y.toFixed(2)}`);
        const ceil = worldCeiling(world, x, z, g.y + 0.1, PLAYER_RADIUS);
        if (ceil - g.y < PLAYER_HEIGHT) bad.push(`(${x},${y},${z}) headroom=${(ceil - g.y).toFixed(2)}`);
        if (worldSolid(world, x, g.y + 0.05, z, PLAYER_RADIUS, PLAYER_HEIGHT, 0.05)) {
          bad.push(`(${x},${y},${z}) inside geometry`);
        }
      }
      expect(bad).toEqual([]);
    });

    it(`${id}: nobody falls out of the world from a standing start`, () => {
      const { def, world } = compile(id);
      const fell: string[] = [];
      for (const s of def.spawns) {
        const st = createMoveState({ x: s.p[0], y: s.p[1] + 0.4, z: s.p[2] });
        const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
        for (let i = 0; i < 150; i++) {
          movementStep(world, st, { seq: i, dt: TICK_DT, moveX: 0, moveZ: 0, yaw: s.yaw, pitch: 0, buttons: 0, slot: 0 }, ctx, TICK_DT);
        }
        if (st.pos.y < def.killY + 1) fell.push(`(${s.p[0]},${s.p[1]},${s.p[2]})`);
      }
      expect(fell).toEqual([]);
    });

    it(`${id}: every team spawn can sprint forward without hitting a wall`, () => {
      const { def, world } = compile(id);
      const blocked: string[] = [];
      for (const s of def.spawns.filter((x) => x.team !== 0)) {
        const st = createMoveState({ x: s.p[0], y: s.p[1] + 0.2, z: s.p[2] });
        const ctx = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
        for (let i = 0; i < 20; i++) {
          movementStep(world, st, { seq: i, dt: TICK_DT, moveX: 0, moveZ: 0, yaw: s.yaw, pitch: 0, buttons: 0, slot: 0 }, ctx, TICK_DT);
        }
        const sx = st.pos.x;
        const sz = st.pos.z;
        for (let i = 0; i < 45; i++) {
          movementStep(world, st, { seq: i, dt: TICK_DT, moveX: 0, moveZ: 1, yaw: s.yaw, pitch: 0, buttons: Btn.Sprint, slot: 0 }, ctx, TICK_DT);
        }
        const travelled = Math.hypot(st.pos.x - sx, st.pos.z - sz);
        if (travelled < 4) blocked.push(`(${s.p[0]},${s.p[1]},${s.p[2]}) only ${travelled.toFixed(1)}m`);
      }
      expect(blocked).toEqual([]);
    });
  }
});

describe('navigation graph', () => {
  for (const id of MAP_ORDER) {
    it(`${id}: forms a single connected component`, () => {
      const { nav } = compile(id);
      const stats = navStats(nav);
      expect(stats.nodes).toBeGreaterThan(500);
      // Pruning to the spawn-reachable set means everything left must be joined.
      expect(stats.largestComponent).toBe(stats.nodes);
      expect(stats.isolated).toBe(0);
    });

    it(`${id}: every spawn, objective and pickup is mutually reachable`, () => {
      const { def, nav } = compile(id);
      const pf = new NavPathfinder(nav);
      const path: number[] = [];
      const anchors: { label: string; p: readonly [number, number, number] }[] = [
        ...def.spawns.map((s, i) => ({ label: `spawn${i}`, p: s.p })),
        ...def.objectives.map((o) => ({ label: `obj:${o.id}`, p: o.p })),
        ...def.pickups.map((p) => ({ label: `pickup:${p.id}`, p: p.p })),
      ];
      const ids = anchors.map((a) => nearestNode(nav, a.p[0], a.p[1], a.p[2]));
      expect(ids.every((i) => i >= 0)).toBe(true);

      const failures: string[] = [];
      // Full pairwise is O(n^2) A* runs; sample origins to keep it fast while
      // still covering every destination from several directions.
      const origins = ids.filter((_, i) => i % 5 === 0);
      for (const from of origins) {
        for (let j = 0; j < ids.length; j++) {
          if (ids[j] === from) continue;
          if (pf.find(from, ids[j], path) === 0) failures.push(anchors[j].label);
        }
      }
      expect([...new Set(failures)]).toEqual([]);
    });
  }
});

describe('vertical routes are walkable', () => {
  for (const id of MAP_ORDER) {
    it(`${id}: no wedge is steeper than the walkable slope limit`, () => {
      const { def } = compile(id);
      const tooSteep: string[] = [];
      for (const br of def.brushes) {
        if (br.t !== 'ramp') continue;
        const [hx, hy, hz] = br.s;
        const run = br.d === '+x' || br.d === '-x' ? hx : hz;
        const angle = (Math.atan2(hy, run) * 180) / Math.PI;
        if (angle > 48.5) tooSteep.push(`${br.m} at (${br.p.join(',')}) = ${angle.toFixed(1)}deg`);
      }
      expect(tooSteep).toEqual([]);
    });

    it(`${id}: nav links never require more than one jump height`, () => {
      const { nav } = compile(id);
      let worst = 0;
      for (const n of nav.nodes) {
        for (const l of n.links) {
          const o = nav.nodes[l.to];
          const rise = o.y - n.y;
          if (rise > worst) worst = rise;
        }
      }
      // JUMP_VELOCITY^2 / (2 * GRAVITY) with a small margin.
      expect(worst).toBeLessThan(1.5);
    });
  }
});

describe('map performance envelope', () => {
  for (const id of MAP_ORDER) {
    it(`${id}: brush count stays inside the browser budget`, () => {
      const { def } = compile(id);
      expect(def.brushes.length).toBeLessThan(1800);
      // Collision brushes drive the server cost; ghosts are render-only.
      const solid = def.brushes.filter((br) => !br.ghost).length;
      expect(solid).toBeLessThan(1200);
    });

    it(`${id}: declares lighting and ambience`, () => {
      const { def } = compile(id);
      expect(def.lights.length).toBeGreaterThan(4);
      expect(def.ambience.ambientLoop.length).toBeGreaterThan(0);
      expect(def.ambience.skybox.length).toBeGreaterThan(0);
    });
  }

  it('every mode has at least one map', () => {
    for (const mode of MODE_ORDER) {
      if (mode === 'custom') continue;
      const any = MAP_ORDER.some((m) => getMap(m).modes.includes(mode));
      expect(any, `no map supports ${mode}`).toBe(true);
    }
  });
});
