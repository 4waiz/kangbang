import { describe, expect, it } from 'vitest';

import { getMap, MAP_ORDER } from '../data/maps/index.js';
import type { BrushDef } from '../sim/world.js';

/**
 * Prop placement invariant.
 *
 * Props are authored as bare coordinates and never collide, so nothing at
 * runtime objects when one is put somewhere impossible - it just renders
 * wrong. This guards the mistake that actually happened: cover was placed on
 * two maps by reading the layout by eye, and a boulder ended up standing
 * halfway through a tower wall.
 *
 * Scope is deliberately narrow, because the obvious wider checks are all false
 * positives here:
 *
 *   "a prop must rest on the surface beneath it" flags every `rockCover` /
 *   `treeCover`, since those emit a collider at the prop's own position by
 *   design, and flags anything standing under a roof, since the highest
 *   surface below a barn barrel is the barn roof.
 *
 *   "a prop must not intersect any brush" flags deliberate embeds - vents sunk
 *   into a catwalk, struts hanging under a bridge.
 *
 * So this asserts only the unambiguous case: a prop standing at ground level
 * whose position is inside a TALL solid - a wall or a building - which is
 * never intentional. Floating props are prevented structurally instead, by
 * `MapBuilder.propOnGround`.
 */
describe.each(MAP_ORDER)('%s prop placement', (id) => {
  it('never buries a prop inside a wall or building', () => {
    const def = getMap(id);
    /*
     * Yawed brushes are skipped: testing a point against a rotated box needs
     * the inverse rotation, and the only yawed solids are the 45-degree halves
     * of `pillar()`, which always have an axis-aligned twin this still catches.
     */
    const solid = def.brushes.filter((b: BrushDef) => !b.ghost && !b.ry);
    const buried: string[] = [];

    for (const prop of def.props) {
      const [x, y, z] = prop.p;
      // Sample half a metre up, inside the body of anything ground-resting.
      const sampleY = y + 0.5;

      for (const brush of solid) {
        // Skip the prop's own collider. The cover helpers emit a brush at the
        // prop's exact position on purpose, and a tree's trunk collider is
        // over 4 m tall, so height alone cannot tell it from a wall.
        const dx = brush.p[0] - x;
        const dz = brush.p[2] - z;
        if (dx * dx + dz * dz < 0.36) continue;

        // Only walls and buildings count: something rising 2.5 m above the
        // prop's base. Thin decks and kerbs a prop legitimately sits in or on
        // are below that.
        if (brush.p[1] + brush.s[1] < y + 2.5) continue;

        const inside =
          x > brush.p[0] - brush.s[0] && x < brush.p[0] + brush.s[0] &&
          z > brush.p[2] - brush.s[2] && z < brush.p[2] + brush.s[2] &&
          sampleY > brush.p[1] - brush.s[1] && sampleY < brush.p[1] + brush.s[1];

        if (inside) {
          buried.push(`${prop.asset} at (${x}, ${y}, ${z}) is inside a '${brush.m}' brush`);
          break;
        }
      }
    }

    expect(buried, `props buried in geometry:\n${buried.join('\n')}`).toEqual([]);
  });
});
