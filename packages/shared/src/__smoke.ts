import {
  CollisionWorld,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  buildNavGraph,
  getMap,
  worldCeiling,
  worldGround,
  worldSolid,
} from './index.js';

const def = getMap('orbital_nexus');
const world = new CollisionWorld(def);
const nav = buildNavGraph(world, 2.0);

console.log('--- north access ramp column probe (x=0) ---');
for (let z = -33; z <= -17; z += 1) {
  const g = worldGround(world, 0, z, 40, PLAYER_RADIUS * 0.75, {
    y: 0,
    normalY: 1,
    surface: '',
    found: false,
    brushIndex: -1,
  });
  const ceil = worldCeiling(world, 0, z, g.y + 0.1, PLAYER_RADIUS);
  const solid = worldSolid(world, 0, g.y + 0.05, z, PLAYER_RADIUS * 0.9, Math.min(PLAYER_HEIGHT, ceil - g.y - 0.05), 0);
  const near = nav.nodes.filter((n) => Math.abs(n.x) < 1.2 && Math.abs(n.z - z) < 1.1);
  console.log(
    `z=${String(z).padStart(4)} ground=${g.found ? g.y.toFixed(2) : 'none'} normalY=${g.normalY.toFixed(3)} ceil=${ceil === Infinity ? 'inf' : ceil.toFixed(2)} solid=${solid} nodes=[${near.map((n) => `${n.y.toFixed(2)}:${n.links.length}`).join(' ')}]`,
  );
}
