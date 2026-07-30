/**
 * NEON FOUNDRY
 *
 * Compact three-level industrial map built around a live reactor column.
 * Design intent:
 *   - Ground floor: tight, crate-heavy, shotgun/SMG territory.
 *   - Mezzanine (y=5.5): perimeter catwalk ring - rotation route, mid range.
 *   - Gantry (y=10): two crossing walkways - sniper perch, exposed on purpose.
 *   - Two conveyor lanes give fast, noisy flanks that skilled players slide.
 *
 * Symmetry: mirrored across Z so Ion (north) and Ember (south) are identical.
 */

import { MapBuilder } from '../mapkit.js';
import type { MapDef } from '../../sim/world.js';

const HALF = 36;
const WALL_H = 17;
/**
 * The mezzanine ring passes over the spawn bays and the two side rooms, so it
 * has to clear their roofs (bays are 6m tall with a 0.6m slab). At 5.5 the
 * catwalk ran *inside* the bay with half a metre of headroom.
 */
const MEZZ = 7.2;
const GANTRY = 11.6;
const CRANE = GANTRY + 2.6;

export function buildNeonFoundry(): MapDef {
  const b = new MapBuilder(
    'neon_foundry',
    'Foundry',
    'Working steel mill. Three levels, no long walks.',
    ['ffa', 'tdm', 'domination', 'hardpoint', 'progression', 'elimination', 'core'],
  );

  // ---------------------------------------------------------------- shell
  b.floor(0, 0, HALF * 2, HALF * 2, 0, 'floorPlate', 1.2);
  b.ceiling(0, 0, HALF * 2, HALF * 2, WALL_H, 'wallDark', 1);
  for (const [x1, z1, x2, z2] of [
    [-HALF, -HALF, HALF, -HALF],
    [-HALF, HALF, HALF, HALF],
    [-HALF, -HALF, -HALF, HALF],
    [HALF, -HALF, HALF, HALF],
  ] as const) {
    b.wall(x1, z1, x2, z2, 0, WALL_H, 1.2, 'wallDark');
    b.neon(x1, z1, x2, z2, 4.2, 'neonCyan', 0.16);
    b.neon(x1, z1, x2, z2, WALL_H - 1.4, 'neonAmber', 0.12);
  }

  // Corner support columns.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      b.pillar(sx * 33, sz * 33, 0, WALL_H, 1.4, 'hull');
    }
  }

  // ------------------------------------------------------- central reactor
  // Raised octagonal dais with four approach ramps.
  b.block(0, 0, 16, 16, 0, 1.6, 'floorLight');
  b.block(0, 0, 12.6, 12.6, 0, 1.62, 'floorLight', { ry: 45 });
  b.ramp(0, -11.5, 6, 7, 0, 1.6, '+z', 'floorPlate');
  b.ramp(0, 11.5, 6, 7, 0, 1.6, '-z', 'floorPlate');
  b.ramp(-11.5, 0, 7, 6, 0, 1.6, '+x', 'floorPlate');
  b.ramp(11.5, 0, 7, 6, 0, 1.6, '-x', 'floorPlate');
  b.neon(-8, -8, 8, -8, 1.68, 'neonCyan', 0.12);
  b.neon(-8, 8, 8, 8, 1.68, 'neonCyan', 0.12);
  b.neon(-8, -8, -8, 8, 1.68, 'neonCyan', 0.12);
  b.neon(8, -8, 8, 8, 1.68, 'neonCyan', 0.12);

  // Reactor column - blocks the centre sightline, glows, doubles as cover.
  b.pillar(0, 0, 1.6, 10.4, 2.4, 'reactor', { glow: 1.8 });
  b.block(0, 0, 7.4, 7.4, 1.6, 0.5, 'trim');
  b.block(0, 0, 6.4, 6.4, 10.6, 0.8, 'trim');
  b.light('point', 0, 6, 0, 0x39d9ff, 2.6, 24);
  b.prop('prop_reactor_ring', 0, 6.4, 0, 0, 1.2);

  // Four coolant tanks around the dais (chest-high cover).
  for (const [dx, dz] of [
    [-6.4, -6.4],
    [6.4, -6.4],
    [-6.4, 6.4],
    [6.4, 6.4],
  ] as const) {
    b.block(dx, dz, 2.2, 2.2, 1.6, 2.1, 'hull', { ry: 45 });
    b.block(dx, dz, 2.4, 2.4, 3.6, 0.24, 'neonAmber', { ghost: true });
    b.prop('prop_coolant_tank', dx, 1.6, dz, 0, 1);
  }

  // -------------------------------------------------------- conveyor lanes
  // Kept to |z| <= 18 so the corner approaches to the mezzanine ramps stay open.
  for (const sx of [-1, 1] as const) {
    const x = sx * 22;
    b.block(x, 0, 4, 36, 0, 1, 'hull');
    b.boxAt(x, 1.02, 0, 3.4, 0.12, 35, 'conveyor', { ghost: true });
    // Wedge on-ramps so the lane can be entered at speed from either end.
    b.ramp(x, -20, 4, 4, 0, 1, '+z', 'hull');
    b.ramp(x, 20, 4, 4, 0, 1, '-z', 'hull');
    // Roller housings every 6m.
    for (let z = -15; z <= 15; z += 6) {
      b.block(x, z, 4.4, 1, 1, 0.36, 'trim');
    }
    // Machinery wall behind each lane, with a gap that becomes a flank hole.
    b.wall(x + sx * 3.2, -18, x + sx * 3.2, -8, 0, 4.2, 1, 'wallLight');
    b.wall(x + sx * 3.2, 8, x + sx * 3.2, 18, 0, 4.2, 1, 'wallLight');
    b.neon(x + sx * 3.2, -18, x + sx * 3.2, -8, 4.3, 'neonMagenta', 0.12);
    b.neon(x + sx * 3.2, 8, x + sx * 3.2, 18, 4.3, 'neonMagenta', 0.12);
    b.prop('prop_conveyor_arm', x + sx * 3.4, 1, -14, sx > 0 ? 90 : -90, 1);
    b.prop('prop_conveyor_arm', x + sx * 3.4, 1, 14, sx > 0 ? 90 : -90, 1);
  }

  // ------------------------------------------------------------ side rooms
  for (const sx of [-1, 1] as const) {
    const cx = sx * 30;
    // The door faces the arena; the far wall stays solid against the shell.
    b.room(cx, 0, 10, 20, 0, 5.2, 'wallLight', {
      floorMat: 'concrete',
      ceilingMat: 'wallDark',
      doorNorth: 3.2,
      doorSouth: 3.2,
      doorEast: sx > 0 ? 0 : 4,
      doorWest: sx > 0 ? 4 : 0,
    });
    b.cover(cx, -6, 3.2, 1.2, 0, 1.2, 'hull');
    b.cover(cx, 6, 3.2, 1.2, 0, 1.2, 'hull');
    b.lightPanel(cx, 5.0, 0, 4, 8, 0xdff2ff, 1.1, 14);
    b.prop('prop_terminal', cx + sx * -3.6, 0, 3, sx > 0 ? -90 : 90, 1);
    b.prop('prop_crate_stack', cx + sx * 3.2, 0, -4, 0, 1);
  }

  // ------------------------------------------------------- mezzanine ring
  const ring = 30;
  b.catwalk(-ring, -ring, ring, -ring, MEZZ, 4.4);
  b.catwalk(-ring, ring, ring, ring, MEZZ, 4.4);
  b.catwalk(-ring, -ring, -ring, ring, MEZZ, 4.4);
  b.catwalk(ring, -ring, ring, ring, MEZZ, 4.4);
  // Support struts.
  for (let i = -28; i <= 28; i += 8) {
    b.block(i, -ring, 0.5, 0.5, 0, MEZZ, 'trim', { ghost: true });
    b.block(i, ring, 0.5, 0.5, 0, MEZZ, 'trim', { ghost: true });
    b.block(-ring, i, 0.5, 0.5, 0, MEZZ, 'trim', { ghost: true });
    b.block(ring, i, 0.5, 0.5, 0, MEZZ, 'trim', { ghost: true });
  }

  // Access to the mezzanine: four wedge ramps that run INWARD from the ring and
  // stop exactly at the catwalk's inner edge. Running them underneath the deck
  // would leave less than a metre of headroom near the top.
  const inner = ring - 2.2; // catwalk inner edge
  b.ramp(16, -(inner - 5), 4.4, 10, 0, MEZZ, '-z', 'grate');
  b.ramp(-16, inner - 5, 4.4, 10, 0, MEZZ, '+z', 'grate');
  b.ramp(-(inner - 5), 22, 10, 4.4, 0, MEZZ, '-x', 'grate');
  b.ramp(inner - 5, -22, 10, 4.4, 0, MEZZ, '+x', 'grate');

  // Mezzanine cover pods, offset from the deck midpoints so they never sit on
  // top of a spawn point or a weapon pickup.
  for (const s of [-1, 1] as const) {
    b.cover(-ring, s * 10, 1.2, 4, MEZZ, 1.1, 'hull');
    b.cover(ring, s * 10, 1.2, 4, MEZZ, 1.1, 'hull');
    b.cover(s * 10, -ring, 4, 1.2, MEZZ, 1.1, 'hull');
    b.cover(s * 10, ring, 4, 1.2, MEZZ, 1.1, 'hull');
  }

  // -------------------------------------------------------------- gantry
  // Spans stop at x = +-23.5 so the access ramps from the mezzanine ring have
  // open sky above them.
  const gEnd = 23.5;
  b.catwalk(-gEnd, -14, gEnd, -14, GANTRY, 3.4);
  b.catwalk(-gEnd, 14, gEnd, 14, GANTRY, 3.4);
  for (const sz of [-1, 1] as const) {
    b.ramp(-27, sz * 14, 7, 3.4, MEZZ, GANTRY - MEZZ, '+x', 'grate');
    b.ramp(27, sz * 14, 7, 3.4, MEZZ, GANTRY - MEZZ, '-x', 'grate');
  }
  // Crane walkway across the centre; its approach ramps sit outside the span.
  b.catwalk(0, -10, 0, 10, CRANE, 2.6, 'grate', false);
  b.ramp(0, -12, 2.6, 4, GANTRY, 2.6, '+z', 'grate');
  b.ramp(0, 12, 2.6, 4, GANTRY, 2.6, '-z', 'grate');
  b.prop('prop_crane', 0, CRANE, 0, 0, 1);

  // ------------------------------------------------------------ spawn bays
  for (const [sz, team] of [
    [-1, 1],
    [1, 2],
  ] as const) {
    const z = sz * 32;
    const mat = team === 1 ? 'teamIon' : 'teamEmber';
    // The arena-facing side is a wide doorway; the back wall closes the bay.
    b.room(0, z, 22, 8, 0, 6, 'wallLight', {
      floorMat: 'floorLight',
      ceilingMat: 'wallDark',
      doorNorth: sz < 0 ? 0 : 12,
      doorSouth: sz < 0 ? 12 : 0,
    });
    b.wall(-11, z - sz * 4, 11, z - sz * 4, 0, 0.4, 0.5, mat, { ghost: true });
    b.neon(-10, z + sz * 3.4, 10, z + sz * 3.4, 5.4, team === 1 ? 'neonCyan' : 'neonAmber', 0.18);
    b.lightPanel(0, 5.8, z, 12, 4, team === 1 ? 0x9ff0ff : 0xffc39a, 1.4, 18);
    b.prop('prop_spawn_arch', 0, 0, z + sz * -4.2, sz < 0 ? 0 : 180, 1);
    // Face the arena centre, never the back wall of the bay. The bay is 8m deep
    // so the Z spread has to stay well inside +-4.
    b.spawnCluster(0, 0, z, [0, 0], team, 5, 7.5, 2.2, 'base');
    // FFA reuses the bays plus the neutral points below.
    b.spawnCluster(0, 0, z, [0, 0], 0, 3, 5.5, 1.8);
  }

  // Neutral FFA spawn points spread around the ring and mezzanine, all facing
  // inwards so nobody opens their eyes looking at concrete.
  for (const [x, y, z] of [
    [-28, 0, -14],
    [28, 0, 14],
    [-28, 0, 14],
    [28, 0, -14],
    [-30, MEZZ, 0],
    [30, MEZZ, 0],
    [0, MEZZ, -30],
    [0, MEZZ, 30],
    // Corner pockets, clear of all four mezzanine access wedges.
    [-26, 0, -26],
    [26, 0, 26],
    [-26, 0, 26],
    [26, 0, -26],
  ] as const) {
    b.spawnLookingAt(x, y, z, 0, 0, 0);
  }

  // ------------------------------------------------------------ crate cover
  const crates: readonly [number, number, number, number][] = [
    [-14, -20, 0, 1.5],
    [-11.4, -20, 0, 1.5],
    [-12.7, -20, 1.5, 1.5],
    [14, 20, 0, 1.5],
    [11.4, 20, 0, 1.5],
    [12.7, 20, 1.5, 1.5],
    [-16, 8, 0, 1.8],
    [16, -8, 0, 1.8],
    [-8, 24, 0, 1.6],
    [8, -24, 0, 1.6],
    [-26, -12, 0, 1.4],
    [26, 12, 0, 1.4],
    [-26, 12, 0, 1.4],
    [26, -12, 0, 1.4],
  ];
  crates.forEach(([x, z, y, s], i) => b.crate(x, z, y, s, i % 3 === 0 ? 'crateAlt' : 'crate', (i * 17) % 90));

  // Half-height cover slabs along the main lanes.
  for (const [x, z, w, d, ry] of [
    [-18, -6, 4, 1.2, 0],
    [18, 6, 4, 1.2, 0],
    [-6, -18, 1.2, 4, 0],
    [6, 18, 1.2, 4, 0],
    [-18, 6, 3, 1.2, 30],
    [18, -6, 3, 1.2, -30],
  ] as const) {
    b.cover(x, z, w, d, 0, 1.15, 'hull', ry);
  }

  // ------------------------------------------------------------- lighting
  for (let x = -24; x <= 24; x += 16) {
    for (let z = -24; z <= 24; z += 16) {
      if (Math.abs(x) < 9 && Math.abs(z) < 9) continue;
      b.lightPanel(x, WALL_H - 0.8, z, 5, 2, 0xe8f4ff, 1.05, 20);
    }
  }
  b.light('point', -22, 3, -18, 0xff3ec8, 0.9, 14);
  b.light('point', 22, 3, 18, 0xff3ec8, 0.9, 14);
  b.light('point', 0, 12, 0, 0x39d9ff, 1.6, 26);

  // ------------------------------------------------------------- objectives
  b.objective({ id: 'A', kind: 'zone', p: [-22, 1, 0], radius: 5.5, label: 'A', order: 0 });
  b.objective({ id: 'B', kind: 'zone', p: [0, 1.6, 0], radius: 6.5, label: 'B', order: 1 });
  b.objective({ id: 'C', kind: 'zone', p: [22, 1, 0], radius: 5.5, label: 'C', order: 2 });
  b.objective({ id: 'H1', kind: 'hardpoint', p: [0, 1.6, 0], radius: 6.5, label: 'CORE', order: 0 });
  b.objective({ id: 'H2', kind: 'hardpoint', p: [-22, 1, -14], radius: 5.5, label: 'WEST LANE', order: 1 });
  b.objective({ id: 'H3', kind: 'hardpoint', p: [0, MEZZ, 30], radius: 5, label: 'SOUTH DECK', order: 2 });
  b.objective({ id: 'H4', kind: 'hardpoint', p: [22, 1, 14], radius: 5.5, label: 'EAST LANE', order: 3 });
  b.objective({ id: 'H5', kind: 'hardpoint', p: [0, MEZZ, -30], radius: 5, label: 'NORTH DECK', order: 4 });
  b.objective({ id: 'CORE_ION', kind: 'core', p: [0, 0, -30], radius: 2.4, label: 'ION CORE', team: 1 });
  b.objective({ id: 'CORE_EMBER', kind: 'core', p: [0, 0, 30], radius: 2.4, label: 'EMBER CORE', team: 2 });

  // -------------------------------------------------------------- pickups
  b.weaponPickup('pk_rail', 'rail_sniper', 0, CRANE, 0, 32);
  b.weaponPickup('pk_shotgun', 'ion_shotgun', -30, 0, 0, 24);
  b.weaponPickup('pk_launcher', 'arc_launcher', 30, 0, 0, 30);
  b.weaponPickup('pk_lmg', 'particle_lmg', 0, MEZZ, -30, 28);
  b.weaponPickup('pk_revolver', 'tactical_revolver', 0, MEZZ, 30, 24);
  b.healthPickup('hp_w', -22, 1, -20, 50, 20);
  b.healthPickup('hp_e', 22, 1, 20, 50, 20);
  b.shieldPickup('sh_c', 0, 1.7, -6, 40, 26);
  b.shieldPickup('sh_c2', 0, 1.7, 6, 40, 26);
  b.ammoPickup('am_1', -16, 0, 0);
  b.ammoPickup('am_2', 16, 0, 0);
  b.ammoPickup('am_3', 0, 0, -22);
  b.ammoPickup('am_4', 0, 0, 22);
  b.ammoPickup('am_5', -30, MEZZ, -8);
  b.ammoPickup('am_6', 30, MEZZ, 8);

  // ---------------------------------------------------------------- props
  b.prop('prop_pipe_run', -34, 11, 0, 0, 1);
  b.prop('prop_pipe_run', 34, 11, 0, 180, 1);
  b.prop('prop_vent', -34, 8.5, -20, 90, 1);
  b.prop('prop_vent', 34, 8.5, 20, -90, 1);
  b.prop('prop_holo_sign', -35.2, 6.5, -10, 90, 1, 0x2ce8ff);
  b.prop('prop_holo_sign', 35.2, 6.5, 10, -90, 1, 0xff5a3c);
  b.prop('prop_barrel', -19, 0, -26, 0, 1);
  b.prop('prop_barrel', -20.4, 0, -25, 25, 1);
  b.prop('prop_barrel', 19, 0, 26, 0, 1);
  b.prop('prop_barrel', 20.4, 0, 25, -25, 1);
  b.prop('prop_terminal', -8, 1.6, -8, 45, 1);
  b.prop('prop_terminal', 8, 1.6, 8, -135, 1);

  return b.finish(
    { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    -24,
    {
      skybox: 'foundry',
      // Overcast daylight through roof glazing. Pale fog rather than dark: haze
      // that lightens with distance reads as air, haze that darkens reads as a
      // wall, and a shooter needs to see down its own sightlines.
      fogColor: 0xc8d2dc,
      fogDensity: 0.006,
      hemiSky: 0xdfe8f0,
      hemiGround: 0x9aa0a6,
      // Enclosed interior: the hemisphere does the work a sky would do outdoors,
      // so it stays strong or the floor goes flat.
      hemiIntensity: 1.85,
      sunColor: 0xfff8ec,
      sunIntensity: 1.25,
      sunDir: [-0.4, -1, -0.35],
      ambientLoop: 'amb_foundry',
      // Accent materials are painted signage now, not neon, so there is nothing
      // to boost.
      neonBoost: 1,
    },
  );
}
