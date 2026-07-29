/**
 * MIRAGE DISTRICT
 *
 * Neon city block. Two crossing streets, four quadrant blocks, enterable
 * ground floors, connected rooftops and a sunken central plaza.
 *
 * Movement-first design:
 *   - Street level is the safe-but-slow route.
 *   - Alleys cut between buildings for flanks.
 *   - Roof level (y=12) is a continuous circuit if you can make the jumps;
 *     two catwalk bridges cover the gaps you cannot.
 *   - The sunken plaza is a death trap with three exits - great objective.
 */

import { MapBuilder } from '../mapkit.js';
import type { MapDef } from '../../sim/world.js';

const HALF = 48;
const ROOF = 12;
const LOW_ROOF = 7;
const PLAZA_Y = -3;

export function buildMirageDistrict(): MapDef {
  const b = new MapBuilder(
    'mirage_district',
    'Mirage District',
    'Rain-slick neon streets. Take the rooftops.',
    ['ffa', 'tdm', 'domination', 'hardpoint', 'progression', 'elimination', 'core'],
  );

  // ------------------------------------------------------------ street deck
  b.floor(0, 0, HALF * 2, HALF * 2, 0, 'asphalt', 1.5);
  // Street markings + kerbs along the two avenues.
  for (const s of [-1, 1] as const) {
    b.boxAt(0, 0.02, s * 6.4, HALF * 2, 0.04, 0.24, 'neonCyan', { ghost: true, noMinimap: true });
    b.boxAt(s * 6.4, 0.02, 0, 0.24, 0.04, HALF * 2, 'neonCyan', { ghost: true, noMinimap: true });
    b.block(0, s * 6.9, HALF * 2, 0.5, 0, 0.18, 'concrete', { noMinimap: true });
    b.block(s * 6.9, 0, 0.5, HALF * 2, 0, 0.18, 'concrete', { noMinimap: true });
  }

  // ----------------------------------------------------------- sunken plaza
  b.floor(0, 0, 13, 13, PLAZA_Y, 'concrete', 1.2);
  for (const [x1, z1, x2, z2] of [
    [-6.5, -6.5, 6.5, -6.5],
    [-6.5, 6.5, 6.5, 6.5],
    [-6.5, -6.5, -6.5, 6.5],
    [6.5, -6.5, 6.5, 6.5],
  ] as const) {
    b.wall(x1, z1, x2, z2, PLAZA_Y, 3, 0.5, 'cityWall');
  }
  // Three stair exits (north, east, west) - south stays a wall, so the plaza
  // is enterable but never a free rotation.
  b.stairs(0, -9.2, 5, 5.4, PLAZA_Y, 3, '-z', 'concrete', 7);
  b.stairs(-9.2, 0, 5.4, 5, PLAZA_Y, 3, '-x', 'concrete', 7);
  b.stairs(9.2, 0, 5.4, 5, PLAZA_Y, 3, '+x', 'concrete', 7);
  b.railing(-6.5, 7.1, 6.5, 7.1, 0);
  b.neon(-6.2, -6.2, 6.2, -6.2, PLAZA_Y + 2.7, 'neonMagenta', 0.14);
  b.neon(-6.2, 6.2, 6.2, 6.2, PLAZA_Y + 2.7, 'neonMagenta', 0.14);
  b.cover(-3.4, 0, 1.2, 3.4, PLAZA_Y, 1.15, 'hull');
  b.cover(3.4, 0, 1.2, 3.4, PLAZA_Y, 1.15, 'hull');
  b.prop('prop_holo_sign', 0, PLAZA_Y + 1.4, 6.1, 180, 1.4, 0xff3ec8);
  b.light('point', 0, PLAZA_Y + 2.4, 0, 0xff3ec8, 1.6, 14);

  // ---------------------------------------------------------- quadrant blocks
  // Each quadrant gets a tall main tower (enterable, roof access) and a low
  // annex, separated by an alley.
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      buildQuadrant(b, sx, sz);
    }
  }

  // --------------------------------------------------------- roof bridges
  // Cross the two avenues so the roof circuit is completable without a
  // pixel-perfect jump, but the bridges are exposed from the street.
  b.catwalk(-15, -20.5, 15, -20.5, ROOF, 3, 'grate');
  b.catwalk(-15, 20.5, 15, 20.5, ROOF, 3, 'grate');
  b.catwalk(-20.5, -15, -20.5, 15, ROOF, 3, 'grate');
  b.catwalk(20.5, -15, 20.5, 15, ROOF, 3, 'grate');
  for (const s of [-1, 1] as const) {
    b.block(0, s * 20.5, 3, 3, ROOF - 0.3, 0.3, 'grate');
    b.block(s * 20.5, 0, 3, 3, ROOF - 0.3, 0.3, 'grate');
  }
  // Central skybridge hub over the plaza - the map's power position.
  b.block(0, 0, 9, 9, ROOF - 0.35, 0.35, 'grate');
  b.railing(-4.5, -4.5, 4.5, -4.5, ROOF);
  b.railing(-4.5, 4.5, 4.5, 4.5, ROOF);
  b.railing(-4.5, -4.5, -4.5, 4.5, ROOF);
  b.railing(4.5, -4.5, 4.5, 4.5, ROOF);
  b.cover(0, 0, 2.2, 2.2, ROOF, 1.2, 'hull', 45);
  b.catwalk(0, -4.5, 0, -20.5, ROOF, 3, 'grate', false);
  b.catwalk(0, 4.5, 0, 20.5, ROOF, 3, 'grate', false);
  b.catwalk(-4.5, 0, -20.5, 0, ROOF, 3, 'grate', false);
  b.catwalk(4.5, 0, 20.5, 0, ROOF, 3, 'grate', false);
  b.prop('prop_holo_billboard', 0, ROOF + 0.4, 0, 45, 1.6, 0x4fe0ff);

  // Street-level access to the roof circuit: two exterior stair towers.
  for (const [sx, sz] of [
    [-1, 1],
    [1, -1],
  ] as const) {
    const x = sx * 20.5;
    const z = sz * 20.5;
    b.block(x, z, 5, 5, 0, 0.4, 'concrete');
    b.stairs(x, z - sz * 2.2, 4.6, 4.4, 0.4, LOW_ROOF - 0.4, sz > 0 ? '-z' : '+z', 'concrete', 9);
    b.block(x, z - sz * 4.6, 4.6, 4.6, LOW_ROOF - 0.3, 0.3, 'concrete');
    b.stairs(x + sx * 2.2, z - sz * 4.6, 4.4, 4.6, LOW_ROOF, ROOF - LOW_ROOF, sx > 0 ? '-x' : '+x', 'concrete', 7);
    b.railing(x - 2.5, z + sz * 2.4, x + 2.5, z + sz * 2.4, 0.4);
    b.prop('prop_ac_unit', x, LOW_ROOF, z - sz * 4.6, 0, 1);
  }

  // ------------------------------------------------------------- skyline
  // Non-enterable perimeter towers give the map a horizon and block the map
  // edge without an invisible wall.
  for (let i = -5; i <= 5; i++) {
    const off = i * 8.6;
    for (const s of [-1, 1] as const) {
      const h = 22 + ((i * 7 + (s > 0 ? 3 : 0)) % 5) * 4;
      b.block(off, s * (HALF + 6), 8, 12, 0, h, 'cityWall', { noMinimap: true });
      b.block(s * (HALF + 6), off, 12, 8, 0, h - 3, 'cityWall', { noMinimap: true });
      if (i % 2 === 0) {
        b.boxAt(off, h * 0.55, s * (HALF + 0.2), 6, 5, 0.2, 'cityGlass', { ghost: true, noMinimap: true });
        b.boxAt(s * (HALF + 0.2), (h - 3) * 0.55, off, 0.2, 5, 6, 'cityGlass', { ghost: true, noMinimap: true });
      }
    }
  }
  // Boundary wall at the play edge.
  for (const s of [-1, 1] as const) {
    b.wall(-HALF, s * HALF, HALF, s * HALF, 0, 26, 1, 'cityWall');
    b.wall(s * HALF, -HALF, s * HALF, HALF, 0, 26, 1, 'cityWall');
    b.neon(-HALF + 1, s * (HALF - 0.6), HALF - 1, s * (HALF - 0.6), 4, 'neonMagenta', 0.16);
    b.neon(s * (HALF - 0.6), -HALF + 1, s * (HALF - 0.6), HALF - 1, 4, 'neonCyan', 0.16);
  }

  // ---------------------------------------------------------- team spawns
  for (const [sz, team] of [
    [-1, 1],
    [1, 2],
  ] as const) {
    const z = sz * 42;
    b.block(0, z, 26, 8, 0, 0.35, 'floorLight');
    b.wall(-13, z + sz * 4, 13, z + sz * 4, 0, 8, 0.6, team === 1 ? 'teamIon' : 'teamEmber');
    b.wall(-13, z - sz * 4, -6, z - sz * 4, 0, 8, 0.6, 'cityWall');
    b.wall(6, z - sz * 4, 13, z - sz * 4, 0, 8, 0.6, 'cityWall');
    b.wall(-13.3, z - 4, -13.3, z + 4, 0, 8, 0.6, 'cityWall');
    b.wall(13.3, z - 4, 13.3, z + 4, 0, 8, 0.6, 'cityWall');
    b.ceiling(0, z, 26, 8, 8, 'cityWall');
    b.neon(-12, z + sz * 3.6, 12, z + sz * 3.6, 7.2, team === 1 ? 'neonCyan' : 'neonAmber', 0.2);
    b.lightPanel(0, 7.7, z, 16, 4, team === 1 ? 0x9ff0ff : 0xffc39a, 1.5, 22);
    b.prop('prop_spawn_arch', 0, 0.35, z + sz * 3.9, sz < 0 ? 180 : 0, 1);
    b.spawnCluster(0, 0.35, z, [0, 0], team, 5, 7.5, 'base');
    b.spawnCluster(0, 0.35, z, [0, 0], 0, 3, 6);
  }

  // Neutral spawns for FFA / progression, all facing the plaza.
  for (const [x, y, z] of [
    [-30, 0, 0],
    [30, 0, 0],
    [0, 0, -24],
    [0, 0, 24],
    [-20.5, LOW_ROOF, -16],
    [20.5, LOW_ROOF, 16],
    [-32, ROOF, -32],
    [32, ROOF, 32],
    [-32, ROOF, 32],
    [32, ROOF, -32],
    [-16, 0, -34],
    [16, 0, 34],
  ] as const) {
    b.spawnLookingAt(x, y, z, 0, 0, 0);
  }

  // ---------------------------------------------------------- street cover
  const streetCover: readonly [number, number, number, number, number][] = [
    [-16, 0, 3.4, 1.2, 0],
    [16, 0, 3.4, 1.2, 0],
    [0, -16, 1.2, 3.4, 0],
    [0, 16, 1.2, 3.4, 0],
    [-26, 4, 1.2, 3.4, 0],
    [26, -4, 1.2, 3.4, 0],
    [4, -26, 3.4, 1.2, 0],
    [-4, 26, 3.4, 1.2, 0],
    [-36, -2, 3, 1.2, 25],
    [36, 2, 3, 1.2, -25],
  ];
  streetCover.forEach(([x, z, w, d, ry]) => b.cover(x, z, w, d, 0, 1.15, 'hull', ry));

  const vehicles: readonly [number, number, number][] = [
    [-11, -18, 20],
    [11, 18, -160],
    [-18, 11, 105],
    [18, -11, -75],
    [-34, -14, 8],
    [34, 14, 188],
  ];
  vehicles.forEach(([x, z, ry], i) => {
    b.block(x, z, 2.3, 5, 0, 1.5, i % 2 ? 'crateAlt' : 'hull', { ry });
    b.block(x, z, 2, 2.6, 1.5, 0.8, 'cityGlass', { ry });
    b.prop('prop_hovercar', x, 0, z, ry, 1);
  });

  // ------------------------------------------------------------- lighting
  for (let i = -4; i <= 4; i++) {
    const off = i * 10;
    if (Math.abs(off) < 9) continue;
    b.light('point', off, 6, 0, 0xbfe0ff, 0.8, 16);
    b.light('point', 0, 6, off, 0xbfe0ff, 0.8, 16);
    b.prop('prop_streetlight', off, 0, 7.4, 0, 1);
    b.prop('prop_streetlight', off, 0, -7.4, 180, 1);
  }
  b.light('point', 0, ROOF + 3, 0, 0x4fe0ff, 1.8, 26);

  // ----------------------------------------------------------- objectives
  b.objective({ id: 'A', kind: 'zone', p: [-24, 0, 0], radius: 6, label: 'A', order: 0 });
  b.objective({ id: 'B', kind: 'zone', p: [0, PLAZA_Y, 0], radius: 7, label: 'B', order: 1 });
  b.objective({ id: 'C', kind: 'zone', p: [24, 0, 0], radius: 6, label: 'C', order: 2 });
  b.objective({ id: 'H1', kind: 'hardpoint', p: [0, PLAZA_Y, 0], radius: 7, label: 'PLAZA', order: 0 });
  b.objective({ id: 'H2', kind: 'hardpoint', p: [-24, 0, -16], radius: 6, label: 'NW MARKET', order: 1 });
  b.objective({ id: 'H3', kind: 'hardpoint', p: [24, 0, -16], radius: 6, label: 'NE YARD', order: 2 });
  b.objective({ id: 'H4', kind: 'hardpoint', p: [24, 0, 16], radius: 6, label: 'SE DOCK', order: 3 });
  b.objective({ id: 'H5', kind: 'hardpoint', p: [-24, 0, 16], radius: 6, label: 'SW LOT', order: 4 });
  b.objective({ id: 'CORE_ION', kind: 'core', p: [0, 0.35, -41], radius: 2.4, label: 'ION CORE', team: 1 });
  b.objective({ id: 'CORE_EMBER', kind: 'core', p: [0, 0.35, 41], radius: 2.4, label: 'EMBER CORE', team: 2 });

  // -------------------------------------------------------------- pickups
  b.weaponPickup('pk_rail', 'rail_sniper', 0, ROOF, 0, 36);
  b.weaponPickup('pk_rail2', 'rail_sniper', -32, ROOF, -32, 34);
  b.weaponPickup('pk_shotgun', 'ion_shotgun', 0, PLAZA_Y, 0, 22);
  b.weaponPickup('pk_smg', 'plasma_smg', -24, 0, -24, 20);
  b.weaponPickup('pk_lmg', 'particle_lmg', 24, 0, 24, 28);
  b.weaponPickup('pk_launcher', 'arc_launcher', 24, 0, -24, 30);
  b.weaponPickup('pk_carbine', 'burst_carbine', -24, 0, 24, 22);
  b.healthPickup('hp_w', -30, 0, 0, 50, 20);
  b.healthPickup('hp_e', 30, 0, 0, 50, 20);
  b.healthPickup('hp_n', 0, 0, -30, 50, 20);
  b.healthPickup('hp_s', 0, 0, 30, 50, 20);
  b.shieldPickup('sh_roof', -20.5, ROOF, 0, 40, 26);
  b.shieldPickup('sh_roof2', 20.5, ROOF, 0, 40, 26);
  b.ammoPickup('am_1', -16, 0, -6);
  b.ammoPickup('am_2', 16, 0, 6);
  b.ammoPickup('am_3', -6, 0, 16);
  b.ammoPickup('am_4', 6, 0, -16);
  b.ammoPickup('am_5', 0, ROOF, -20.5);
  b.ammoPickup('am_6', 0, ROOF, 20.5);

  return b.finish(
    { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    -20,
    {
      skybox: 'mirage',
      fogColor: 0x160f24,
      fogDensity: 0.014,
      hemiSky: 0x5f6ec4,
      hemiGround: 0x241a2e,
      hemiIntensity: 0.75,
      sunColor: 0xffd0e8,
      sunIntensity: 0.75,
      sunDir: [0.35, -0.85, 0.4],
      ambientLoop: 'amb_mirage',
      neonBoost: 1.45,
    },
  );
}

/**
 * One city quadrant: a tall enterable tower with interior stairs to the roof,
 * a low annex, and the alley between them.
 */
function buildQuadrant(b: MapBuilder, sx: 1 | -1, sz: 1 | -1): void {
  const bx = sx * 24;
  const bz = sz * 20;

  // --- main tower (18 x 16, enterable ground floor + roof at y=12) --------
  const w = 18;
  const d = 16;
  b.floor(bx, bz, w, d, 0.05, 'concrete', 0.2);
  // Outer walls with a doorway on the two street-facing sides.
  b.doorway(bx - w / 2, bz - d / 2, bx + w / 2, bz - d / 2, 0, ROOF, 0.6, 'cityWall', sz < 0 ? 0 : 4);
  b.doorway(bx - w / 2, bz + d / 2, bx + w / 2, bz + d / 2, 0, ROOF, 0.6, 'cityWall', sz > 0 ? 0 : 4);
  b.doorway(bx - w / 2, bz - d / 2, bx - w / 2, bz + d / 2, 0, ROOF, 0.6, 'cityWall', sx < 0 ? 0 : 4);
  b.doorway(bx + w / 2, bz - d / 2, bx + w / 2, bz + d / 2, 0, ROOF, 0.6, 'cityWall', sx > 0 ? 0 : 4);

  // Windows on the upper storey - shootable through, sniper angles.
  b.window(bx - w / 2 + 2, bz - d / 2, bx + w / 2 - 2, bz - d / 2, 7.4, 2.4, 0.18);
  b.window(bx - w / 2, bz - d / 2 + 2, bx - w / 2, bz + d / 2 - 2, 7.4, 2.4, 0.18);

  // Mid floor at y=6 covering half the footprint, reached by interior stairs.
  b.floor(bx + sx * 4, bz, w / 2 - 0.6, d - 1.2, 6, 'concrete', 0.4);
  b.railing(bx + sx * 0.4, bz - d / 2 + 0.6, bx + sx * 0.4, bz + d / 2 - 0.6, 6);
  b.stairs(bx - sx * 5, bz - sz * 4.5, 4.4, 7, 0.05, 6, sz > 0 ? '-z' : '+z', 'concrete', 9);
  b.stairs(bx - sx * 5, bz + sz * 4.5, 4.4, 7, 6, ROOF - 6, sz > 0 ? '+z' : '-z', 'concrete', 9);

  // Roof slab + parapet.
  b.floor(bx, bz, w, d, ROOF, 'concrete', 0.5);
  for (const [x1, z1, x2, z2] of [
    [bx - w / 2, bz - d / 2, bx + w / 2, bz - d / 2],
    [bx - w / 2, bz + d / 2, bx + w / 2, bz + d / 2],
    [bx - w / 2, bz - d / 2, bx - w / 2, bz + d / 2],
    [bx + w / 2, bz - d / 2, bx + w / 2, bz + d / 2],
  ] as const) {
    b.wall(x1, z1, x2, z2, ROOF, 1.05, 0.35, 'cityWall');
  }
  // Roof furniture for cover.
  b.cover(bx - sx * 5, bz - sz * 4, 3.2, 2.4, ROOF, 1.4, 'hull');
  b.crate(bx + sx * 5.5, bz + sz * 4.5, ROOF, 1.7, 'crateAlt', 20);
  b.prop('prop_ac_unit', bx + sx * 2, ROOF, bz - sz * 5, 15, 1.1);
  b.prop('prop_antenna', bx - sx * 7, ROOF, bz + sz * 6, 0, 1.3);

  // Interior lighting + cover.
  b.lightPanel(bx, 5.6, bz - sz * 4, 6, 4, 0xd8ecff, 0.9, 14);
  b.lightPanel(bx + sx * 4, ROOF - 0.5, bz, 5, 8, 0xd8ecff, 0.8, 14);
  b.cover(bx - sx * 6.5, bz + sz * 5.5, 2.6, 1.2, 0.05, 1.2, 'hull');
  b.prop('prop_terminal', bx + sx * 7.4, 0.05, bz, sx > 0 ? -90 : 90, 1);
  b.prop('prop_crate_stack', bx - sx * 1.5, 0.05, bz + sz * 5.5, 0, 1);

  // --- low annex (12 x 10, roof at y=7) ----------------------------------
  const ax = sx * 38;
  const az = sz * 32;
  b.block(ax, az, 12, 10, 0, LOW_ROOF, 'cityWall');
  b.block(ax, az, 12.4, 10.4, LOW_ROOF, 0.4, 'concrete');
  for (const [x1, z1, x2, z2] of [
    [ax - 6.2, az - 5.2, ax + 6.2, az - 5.2],
    [ax - 6.2, az + 5.2, ax + 6.2, az + 5.2],
    [ax - 6.2, az - 5.2, ax - 6.2, az + 5.2],
    [ax + 6.2, az - 5.2, ax + 6.2, az + 5.2],
  ] as const) {
    b.wall(x1, z1, x2, z2, LOW_ROOF + 0.4, 0.9, 0.3, 'cityWall');
  }
  b.boxAt(ax - sx * 6.1, LOW_ROOF * 0.55, az, 0.2, 3.4, 6, 'cityGlass', { ghost: true, noMinimap: true });
  b.prop('prop_holo_billboard', ax, LOW_ROOF + 1.4, az - sz * 5, sz > 0 ? 0 : 180, 1.5, sx > 0 ? 0xff3ec8 : 0x4fe0ff);
  b.prop('prop_ac_unit', ax + sx * 3, LOW_ROOF + 0.4, az + sz * 3, 40, 1);

  // Ramp from street to the annex roof - the entry to the roof circuit.
  b.ramp(ax - sx * 10, az, 8, 5, 0, LOW_ROOF + 0.4, sx > 0 ? '+x' : '-x', 'concrete');
  // Annex roof to tower roof: a jump you can make with a slide-hop, plus a
  // short catwalk for players who cannot.
  b.catwalk(ax - sx * 6, az - sz * 5, bx + sx * 9, bz + sz * 8, LOW_ROOF + 0.4, 2.4, 'grate', false);
  b.ramp(bx + sx * 11, bz + sz * 9.5, 5, 5, LOW_ROOF + 0.4, ROOF - LOW_ROOF - 0.4, sx > 0 ? '-x' : '+x', 'grate');

  // --- alley ------------------------------------------------------------
  b.crate(bx + sx * 11, bz + sz * 2, 0, 1.6, 'crate', 12);
  b.crate(bx + sx * 11, bz - sz * 2, 0, 1.4, 'crateAlt', -18);
  b.prop('prop_barrel', bx + sx * 12, 0, bz, 0, 1);
  b.prop('prop_vent', bx + sx * 9.2, 4, bz + sz * 3, sx > 0 ? -90 : 90, 1);
  b.light('point', bx + sx * 11, 3, bz, sx * sz > 0 ? 0xff3ec8 : 0x8dff4a, 0.9, 12);
  b.neon(bx + sx * 9.4, bz - sz * 6, bx + sx * 9.4, bz + sz * 6, 5.2, sx * sz > 0 ? 'neonMagenta' : 'neonLime', 0.12);
}
