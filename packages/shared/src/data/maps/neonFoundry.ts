/**
 * MEADOW
 *
 * Open outdoor arena. Rebuilt from a sealed three-level steel mill, because no
 * amount of recolouring made that read as outdoors: it was a 17 m walled box
 * with a lid, and from anywhere inside it you saw wall, not sky.
 *
 * What actually produces the open feeling, in order of how much it mattered:
 *
 *   1. THE BOUNDARY IS 7 m, NOT 17 m. From the centre, 36 m away, a 7 m
 *      embankment subtends about 11 degrees - so the top two-thirds of the
 *      frame is sky and treeline. At 17 m it was 25 degrees and the wall
 *      filled the view. This single number is most of the difference.
 *   2. NO ROOF, ANYWHERE. Cover is rock, timber and canopy that you go around,
 *      never a corridor you go through.
 *   3. HEIGHT COMES FROM TERRAIN, NOT FLOORS. A rock plateau, two barn roofs
 *      and two watchtower decks, all reachable, none stacked over each other.
 *      Stacked floors are what made the old map feel indoors even where it had
 *      no ceiling.
 *
 * Containment still works. The embankment is unjumpable, every reachable deck
 * is 6 m or lower and set well back from it, and there is no floor brush
 * outside the bounds - so anything that does get out falls to killY.
 *
 * Layout, mirrored across Z so Ion (north, -Z) and Ember (south, +Z) are
 * identical:
 *   - Centre: raised rock plateau, four ramps, the power weapon and both
 *     shield pickups. The most contested ground on the map.
 *   - East/west: open meadow lanes with timber barns you can get on top of.
 *   - North/south: watchtowers over each team's ground, holding the deck
 *     hardpoints and each team's core.
 */

import { MapBuilder } from '../mapkit.js';
import type { MapDef } from '../../sim/world.js';

const HALF = 36;
/**
 * 7 m, down from 17. Tall enough that nothing on the map can jump it - the
 * highest reachable surface is the 6 m tower deck, and that sits 6 m inboard -
 * and low enough that the treeline beyond it is visible from the floor.
 */
const BANK_H = 7;
const PLATEAU = 2.6; // central rock shelf
const BARN = 4.2; // barn roof, reachable by ramp
const TOWER = 6.0; // watchtower deck, reachable by stairs

export function buildNeonFoundry(): MapDef {
  const b = new MapBuilder(
    'neon_foundry',
    'Meadow',
    'Open ground under a wide sky. Rock, timber and long sightlines.',
    ['ffa', 'tdm', 'domination', 'hardpoint', 'progression', 'elimination', 'core'],
  );

  // ---------------------------------------------------------------- ground
  b.floor(0, 0, HALF * 2, HALF * 2, 0, 'floorPlate', 1.2);

  // Embankment. Stone below, timber rail along the top, so the edge of the
  // world reads as a bank you should not climb rather than as a room wall.
  for (const [x1, z1, x2, z2] of [
    [-HALF, -HALF, HALF, -HALF],
    [-HALF, HALF, HALF, HALF],
    [-HALF, -HALF, -HALF, HALF],
    [HALF, -HALF, HALF, HALF],
  ] as const) {
    b.wall(x1, z1, x2, z2, 0, BANK_H, 1.2, 'cityWall');
    b.railing(x1, z1, x2, z2, BANK_H, 'trim', 1.1);
    // Timber revetment posts and a capping rail. All ghost: the bank already
    // stops the player, and a bare 72 m stone face is the flattest surface on
    // the map without something to break its length.
    b.wall(x1, z1, x2, z2, BANK_H - 0.34, 0.34, 1.34, 'trim', { ghost: true });
    const px = x2 - x1;
    const pz = z2 - z1;
    const posts = Math.max(2, Math.round(Math.hypot(px, pz) / 4.5));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      b.block(x1 + px * t, z1 + pz * t, 0.46, 0.46, 0, BANK_H - 0.3, 'hull', { ghost: true });
    }
  }

  // Gentle rises so the floor is not one flat plane. Shallow enough to walk
  // straight over - these shape sightlines, they are not obstacles.
  for (const s of [-1, 1] as const) {
    b.block(s * 26, s * -26, 22, 18, 0, 0.9, 'floorLight');
    b.ramp(s * 26, s * -15.5, 22, 5, 0, 0.9, s > 0 ? '-z' : '+z', 'floorLight');
    b.ramp(s * 13.5, s * -26, 5, 18, 0, 0.9, s > 0 ? '-x' : '+x', 'floorLight');
  }

  // --------------------------------------------------------- rock plateau
  // The centre. Four ramps, one per approach, all 7 m long for a 2.6 m rise -
  // about 20 degrees, well under the 48.5 the slope test allows.
  b.block(0, 0, 17, 17, 0, PLATEAU, 'concrete');
  b.block(0, 0, 13.4, 13.4, 0, PLATEAU + 0.02, 'concrete', { ry: 45 });
  b.ramp(0, -12, 6.5, 7, 0, PLATEAU, '+z', 'concrete');
  b.ramp(0, 12, 6.5, 7, 0, PLATEAU, '-z', 'concrete');
  b.ramp(-12, 0, 7, 6.5, 0, PLATEAU, '+x', 'concrete');
  b.ramp(12, 0, 7, 6.5, 0, PLATEAU, '-x', 'concrete');
  // Standing stones on the shelf: cover on top so the plateau is holdable
  // rather than a killing floor.
  for (const s of [-1, 1] as const) {
    b.rockCover(s * 5.6, s * 5.6, PLATEAU, 1.0, s * 30);
    b.rockCover(s * -6.2, s * 5.0, PLATEAU, 0.85, s * -50);
  }
  b.prop('prop_rock_spire', 0, PLATEAU, 0, 20, 1.5);
  b.light('point', 0, PLATEAU + 4, 0, 0xffd9a0, 1.6, 26);

  // ---------------------------------------------------------------- barns
  // Open-sided timber barns on the east and west lanes. Roof is reachable, so
  // each lane has a high seat without a corridor attached to it.
  for (const s of [-1, 1] as const) {
    const cx = s * -24;
    const cz = s * -10;
    // Four corner posts and a roof slab: no walls, so it never becomes a room.
    for (const px of [-5, 5] as const) {
      for (const pz of [-4, 4] as const) {
        b.pillar(cx + px, cz + pz, 0, BARN, 0.42, 'hull');
      }
    }
    b.slab(cx - 6, cx + 6, cz - 5, cz + 5, BARN, 'hull', 0.5);
    // Back wall only, giving the lane a sightline break without enclosing it.
    b.wall(cx - 6, cz + s * 5, cx + 6, cz + s * 5, 0, BARN, 0.5, 'wallDark');
    // Ramp up the open side.
    b.ramp(cx, cz - s * 8.5, 5, 7, 0, BARN, s > 0 ? '+z' : '-z', 'hull');
    b.railing(cx - 6, cz - 5, cx + 6, cz - 5, BARN, 'trim', 1.05);
    b.railing(cx - 6, cz + 5, cx + 6, cz + 5, BARN, 'trim', 1.05);

    /*
     * Timber detail. All of it is `ghost`, so the barn plays exactly as before
     * - four posts, a walkable deck and a back wall - while reading as a built
     * structure rather than a slab on stilts.
     *
     * The roof stays FLAT rather than pitched, deliberately: it is a reachable
     * firing position with an ammo pickup on it, and a pitch would make it
     * unwalkable. The fascia and rafters give it the read of a roof without
     * taking that away.
     */
    // Fascia band round the deck edge, and rafters showing under it.
    b.wall(cx - 6.1, cz - 5.1, cx + 6.1, cz - 5.1, BARN - 0.42, 0.42, 0.18, 'trim', { ghost: true });
    b.wall(cx - 6.1, cz + 5.1, cx + 6.1, cz + 5.1, BARN - 0.42, 0.42, 0.18, 'trim', { ghost: true });
    b.wall(cx - 6.1, cz - 5.1, cx - 6.1, cz + 5.1, BARN - 0.42, 0.42, 0.18, 'trim', { ghost: true });
    b.wall(cx + 6.1, cz - 5.1, cx + 6.1, cz + 5.1, BARN - 0.42, 0.42, 0.18, 'trim', { ghost: true });
    for (let i = -2; i <= 2; i++) {
      b.block(cx + i * 2.6, cz, 0.22, 10.2, BARN - 0.62, 0.22, 'trim', { ghost: true });
    }
    // Horizontal planking across the back wall.
    for (let i = 0; i < 4; i++) {
      b.wall(cx - 6, cz + s * 5.28, cx + 6, cz + s * 5.28, 0.5 + i * 1.0, 0.14, 0.1, 'trim', { ghost: true });
    }
    // Diagonal corner braces - the detail that most says "timber frame".
    for (const px of [-5, 5] as const) {
      for (const pz of [-4, 4] as const) {
        b.boxAt(cx + px - Math.sign(px) * 0.75, BARN - 0.85, cz + pz, 2.1, 0.2, 0.2, 'trim', {
          ghost: true,
          ry: 0,
        });
        b.boxAt(cx + px, BARN - 0.85, cz + pz - Math.sign(pz) * 0.75, 0.2, 0.2, 2.1, 'trim', {
          ghost: true,
        });
      }
    }
    b.lightPanel(cx, BARN - 0.3, cz, 6, 4, 0xffd9a0, 1.2, 16);
    b.prop('prop_barrel_wood', cx + 4.4, 0, cz - 3.2, 20, 1);
    b.prop('prop_crate_stack', cx - 4.2, 0, cz + 2.6, -15, 1);
  }

  // ----------------------------------------------------------- watchtowers
  // One over each team's ground. Stairs rather than a ramp, because 6 m of
  // ramp would reach halfway across the lane; eight steps is 0.75 m each,
  // comfortably under the 1.45 m the nav-link test allows.
  for (const s of [-1, 1] as const) {
    const cz = s * 30;
    for (const px of [-4.5, 4.5] as const) {
      for (const pz of [-4.5, 4.5] as const) {
        b.pillar(px, cz + pz, 0, TOWER, 0.45, 'hull');
      }
    }
    b.slab(-5.4, 5.4, cz - 5.4, cz + 5.4, TOWER, 'hull', 0.5);
    // Ramp up the SIDE, not the arena-facing edge. A 6 m climb in front of the
    // tower would sit directly on the line every team spawn sprints along, and
    // the spawn test - rightly - fails a spawn that cannot travel 4 m forward.
    // 12 m of run for 6 m of rise is about 27 degrees, well inside the limit.
    b.ramp(s * -11, cz, 12, 5, 0, TOWER, s > 0 ? '+x' : '-x', 'hull');
    for (const [x1, z1, x2, z2] of [
      [-5.4, cz - 5.4, 5.4, cz - 5.4],
      [-5.4, cz + 5.4, 5.4, cz + 5.4],
      [-5.4, cz - 5.4, -5.4, cz + 5.4],
      [5.4, cz - 5.4, 5.4, cz + 5.4],
    ] as const) {
      b.railing(x1, z1, x2, z2, TOWER, 'trim', 1.05);
    }
    b.lightPanel(0, TOWER - 0.3, cz, 5, 5, s < 0 ? 0xbcd8ff : 0xffc39a, 1.3, 18);
    b.prop('prop_signpost', s * 3.6, 0, cz - s * 7.2, s < 0 ? 0 : 180, 1.1);
  }

  // ----------------------------------------------------------- team ground
  for (const [team, s] of [
    [1, -1],
    [2, 1],
  ] as const) {
    const cz = s * 30;
    // A low banner wall behind each spawn: identifies the ground and stops a
    // spawn-killer standing directly behind the tower.
    b.wall(-9, cz + s * 4.6, 9, cz + s * 4.6, 0, 2.4, 0.6, team === 1 ? 'teamIon' : 'teamEmber');
    b.prop('prop_spawn_arch', 0, 0, cz + s * 4.2, s < 0 ? 0 : 180, 1);
    // Clear of the tower footprint, which reaches to cz -+ 5.4. Spawning under
    // the deck leaves the outermost players facing a support post rather than
    // the arena.
    b.spawnCluster(0, 0, cz - s * 8, [0, 0], team, 5, 7.5, 2.2, 'base');
    b.spawnCluster(0, 0, cz - s * 8, [0, 0], 0, 3, 5.5, 1.8);
  }

  // Neutral FFA points, all facing the centre so nobody opens their eyes
  // looking at the bank.
  // Y here is the surface the spawn stands on, so it has to match the mounds:
  // they cover x -37..-15 / z 17..35 and x 15..37 / z -35..-17, topping out at
  // 0.9. Off the mound is 0. Getting this wrong spawns a player 0.9 m in the
  // air or 0.9 m inside the ground, and the spawn tests catch both.
  for (const [x, y, z] of [
    [-28, 0, -28],
    [28, 0, 28],
    [-28, 0.9, 20],
    [28, 0.9, -20],
    [-30, 0, 0],
    [30, 0, 0],
    [-16, 0, -26],
    [16, 0, 26],
    [-24, BARN, -10],
    [24, BARN, 10],
    [-20, 0, 8],
    [20, 0, -8],
  ] as const) {
    b.spawnLookingAt(x, y, z, 0, 0, 0);
  }

  // ---------------------------------------------------------- natural cover
  // Real cover: each of these emits a solid brush alongside its prop, so they
  // stop players and bullets where they look like they should. Mirrored,
  // because a boulder one team has and the other does not is a balance bug.
  //
  // Three heights on purpose - a log breaks a sightline while sliding, a
  // boulder is crouch cover you peek over, a trunk is something you strafe
  // around. One height everywhere gives every fight the same shape.
  //
  // Twelve pieces, not eighteen. The denser pass measurably hurt play: with
  // cover through the middle band, bot engagements broke down badly enough
  // that hard bots landed fewer hits than easy ones over the same window - the
  // better bots were spending the fight repositioning between obstacles
  // instead of shooting. Cover belongs on the flanks and the approaches; the
  // middle of an arena this size wants to stay readable.
  for (const s of [-1, 1] as const) {
    b.rockCover(s * -19, s * -17, 0, 1.05, s * 25);
    b.rockCover(s * -30, s * 9, 0, 1.0, s * 70);
    b.treeCover(s * -13, s * -24, 0, 1.7, s * 40);
    b.treeCover(s * -31, s * -6, 0, 1.5, s * 95);
    b.logCover(s * 20, s * 4, 0, 1.2, s * -20);
    b.logCover(s * 30, s * -28, 0.9, 1.2, s * 35);
  }

  // ------------------------------------------------------------ objectives
  b.objective({ id: 'A', kind: 'zone', p: [-22, 0, 0], radius: 5.5, label: 'A', order: 0 });
  b.objective({ id: 'B', kind: 'zone', p: [0, PLATEAU, 0], radius: 6.5, label: 'B', order: 1 });
  b.objective({ id: 'C', kind: 'zone', p: [22, 0, 0], radius: 5.5, label: 'C', order: 2 });
  b.objective({ id: 'H1', kind: 'hardpoint', p: [0, PLATEAU, 0], radius: 6.5, label: 'PLATEAU', order: 0 });
  b.objective({ id: 'H2', kind: 'hardpoint', p: [-24, 0, -10], radius: 5.5, label: 'WEST BARN', order: 1 });
  b.objective({ id: 'H3', kind: 'hardpoint', p: [0, TOWER, -30], radius: 5, label: 'NORTH TOWER', order: 2 });
  b.objective({ id: 'H4', kind: 'hardpoint', p: [24, 0, 10], radius: 5.5, label: 'EAST BARN', order: 3 });
  b.objective({ id: 'H5', kind: 'hardpoint', p: [0, TOWER, 30], radius: 5, label: 'SOUTH TOWER', order: 4 });
  b.objective({ id: 'CORE_ION', kind: 'core', p: [0, 0, -26], radius: 2.4, label: 'ION CORE', team: 1 });
  b.objective({ id: 'CORE_EMBER', kind: 'core', p: [0, 0, 26], radius: 2.4, label: 'EMBER CORE', team: 2 });

  // --------------------------------------------------------------- pickups
  // The power weapon sits on the most contested ground rather than on a perch,
  // now that there is no crane to put it on.
  b.weaponPickup('pk_rail', 'rail_sniper', 0, PLATEAU, 0, 32);
  b.weaponPickup('pk_shotgun', 'ion_shotgun', -30, 0, 0, 24);
  b.weaponPickup('pk_launcher', 'arc_launcher', 30, 0, 0, 30);
  b.weaponPickup('pk_lmg', 'particle_lmg', 0, TOWER, -30, 28);
  b.weaponPickup('pk_revolver', 'tactical_revolver', 0, TOWER, 30, 24);
  b.healthPickup('hp_w', -22, 0, -20, 50, 20);
  b.healthPickup('hp_e', 22, 0, 20, 50, 20);
  b.shieldPickup('sh_c', 0, PLATEAU, -5.5, 40, 26);
  b.shieldPickup('sh_c2', 0, PLATEAU, 5.5, 40, 26);
  b.ammoPickup('am_1', -16, 0, 0);
  b.ammoPickup('am_2', 16, 0, 0);
  // Off the spawn centreline and well clear of it. At (0, -20) this sat two
  // metres in front of the Ion spawn, so a player refilled to full reserve
  // just by standing still - which quietly broke the ammo-consumption test and
  // would have made the north lane a free resupply.
  b.ammoPickup('am_3', -9, 0, -17);
  b.ammoPickup('am_4', 9, 0, 17);
  b.ammoPickup('am_5', -24, BARN, -10);
  b.ammoPickup('am_6', 24, BARN, 10);

  // ---------------------------------------------------------------- lights
  b.light('point', -24, 5, -10, 0xffd9a0, 1.0, 18);
  b.light('point', 24, 5, 10, 0xffd9a0, 1.0, 18);
  b.light('point', -22, 3, 18, 0xffcf8a, 0.8, 15);
  b.light('point', 22, 3, -18, 0xffcf8a, 0.8, 15);
  b.light('point', 0, 4, -22, 0xbcd8ff, 0.9, 16);
  b.light('point', 0, 4, 22, 0xffc39a, 0.9, 16);

  // ------------------------------------------------------------- landscape
  //
  // Everything below is DECORATION - `prop()` emits a GLB and nothing else, so
  // none of it collides or blocks a bullet. Large scenery therefore lives
  // outside the boundary where it is unreachable, and the only props inside
  // the arena are ankle height. Anything waist-high in here would read as
  // cover without being cover; use the cover helpers above for that.
  //
  // Scaled 4-6x. The bank is 7 m, so at this size the canopies clear it and
  // read as a treeline on the horizon - which is the whole point of dropping
  // the wall from 17 m in the first place.
  const treeRing: Array<[number, number, number, number]> = [
    [-52, -46, 5.2, 20], [-30, -58, 4.4, -35], [4, -60, 5.6, 65],
    [34, -55, 4.8, 130], [55, -34, 5.4, -70], [60, -4, 4.6, 15],
    [54, 30, 5.0, 95], [33, 54, 4.4, -20], [2, 61, 5.6, 40],
    [-32, 56, 4.8, 160], [-55, 33, 5.2, -110], [-61, 2, 4.4, 75],
  ];
  for (const [x, z, s, ry] of treeRing) {
    b.propOnGround('prop_tree_round', x, z, ry, s);
  }
  for (const [x, z, s, ry] of [
    [-72, -30, 4.6, 0], [-40, -76, 4.2, 40], [30, -74, 4.8, -25],
    [74, -26, 4.4, 90], [70, 34, 4.6, 15], [26, 76, 4.2, -60],
    [-36, 72, 4.8, 120], [-76, 28, 4.4, -15],
  ] as const) {
    b.propOnGround('prop_tree_pine', x, z, ry, s);
  }
  for (const [x, z, s, ry] of [
    [-64, -62, 3.6, 25], [66, -60, 3.2, -40], [62, 64, 3.8, 70], [-66, 60, 3.4, 110],
  ] as const) {
    b.propOnGround('prop_rock_spire', x, z, ry, s);
  }
  // Understory at the base of the treeline. All of this is knee-to-waist
  // height and would read as false cover inside the arena.
  for (const [asset, x, z, s, ry] of [
    ['prop_rock_large', -46, -30, 2.6, 20],
    ['prop_rock_large', 48, 26, 2.2, -55],
    ['prop_bush', -40, -50, 2.8, 0],
    ['prop_bush', 44, -40, 2.4, 60],
    ['prop_bush', 20, 48, 2.6, -30],
    ['prop_bush', -48, 18, 2.2, 140],
    ['prop_tree_stump', -38, 40, 2.4, 15],
    ['prop_log', 30, 44, 2.6, 35],
    ['prop_fence_wood', -20, -44, 2.4, 8],
    ['prop_fence_wood', 22, 44, 2.4, -6],
  ] as const) {
    b.propOnGround(asset, x, z, ry, s);
  }

  // Ankle-height scatter inside, kept off the lanes and off the plateau ramps.
  for (const [x, z, ry] of [
    [-27, -6, 20], [27, 6, 75], [-6, 27, 140], [6, -27, -50],
    [-33, -20, 0], [33, 20, 100], [-18, 15, 55], [18, -15, -25],
    [-12, 31, 165], [12, -31, 30], [-31, 26, 45], [31, -26, -85],
  ] as const) {
    b.propOnGround('prop_grass_tuft', x, z, ry, 1.35);
  }
  for (const [x, z, ry] of [
    [-23, -13, 40], [23, 13, -80], [-10, 20, 120], [10, -20, 15],
    [-29, 2, 60], [29, -2, -35],
  ] as const) {
    b.propOnGround('prop_flower_patch', x, z, ry, 1.25);
  }
  for (const [x, z, ry] of [
    [-15, -9, 30], [15, 9, -60], [-9, 15, 95], [9, -15, 145],
  ] as const) {
    b.propOnGround('prop_rock_cluster', x, z, ry, 1.0);
  }

  return b.finish(
    { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    -24,
    {
      skybox: 'foundry',
      // Open midday. Fog is pale and thin: haze that lightens with distance
      // reads as air, haze that darkens reads as a wall, and a shooter needs
      // to see down its own sightlines.
      fogColor: 0xcfe9f7,
      fogDensity: 0.004,
      // The ground half of the hemisphere is GREEN. It stands in for light
      // bouncing off the meadow and is what ties every surface to the ground
      // it stands on - a grey bounce is most of why this used to read as an
      // interior no matter what colour the walls were.
      hemiSky: 0x9ed4f2,
      hemiGround: 0x6f9c3f,
      hemiIntensity: 1.25,
      sunColor: 0xfff4dd,
      sunIntensity: 2.0,
      sunDir: [-0.4, -1, -0.35],
      ambientLoop: 'amb_foundry',
      // Accents are painted cloth and banners, so there is nothing to boost.
      neonBoost: 1,
    },
  );
}
