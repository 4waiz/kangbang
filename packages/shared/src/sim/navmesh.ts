/**
 * Navigation graph generation.
 *
 * Rather than hand-authoring waypoints per map (which rots the moment geometry
 * changes) we sample the compiled collision world on a grid, find every
 * standable surface in each column, and link neighbours that a player could
 * actually traverse.  Bots then A* over this graph.
 *
 * This runs once per map on server start (~15ms for the largest map) and the
 * result is shared by every room using that map.
 */

import { JUMP_VELOCITY, GRAVITY, MAX_SLOPE_COS, PLAYER_HEIGHT, PLAYER_RADIUS, STEP_HEIGHT } from '../constants.js';
import { clamp } from '../math.js';
import { worldCeiling, worldGround, worldSolid, type CollisionWorld } from './world.js';

export const LINK_WALK = 0;
export const LINK_STEP = 1;
export const LINK_JUMP = 2;
export const LINK_DROP = 3;

export interface NavLink {
  to: number;
  cost: number;
  kind: number;
}

export interface NavNode {
  id: number;
  x: number;
  y: number;
  z: number;
  links: NavLink[];
  /** How enclosed this node is (0 open, 1 fully surrounded) - bots prefer cover. */
  coverScore: number;
  /** Height rank used to bias sniper bots upward. */
  elevation: number;
  /** Grid coordinates for fast spatial lookup. */
  col: number;
  row: number;
}

export interface NavGraph {
  nodes: NavNode[];
  spacing: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** node ids per grid cell */
  cells: number[][];
}

const MAX_JUMP_HEIGHT = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY) - 0.12;

/** All standable surface heights in one column, lowest first. */
function columnSurfaces(world: CollisionWorld, x: number, z: number, out: number[]): number[] {
  out.length = 0;
  const r = PLAYER_RADIUS * 0.75;
  const list = world.query(x - r, z - r, x + r, z + r);
  for (let i = 0; i < list.length; i++) {
    const b = world.brushes[list[i]];
    if (!b.solid) continue;
    if (x + r <= b.minX || x - r >= b.maxX) continue;
    if (z + r <= b.minZ || z - r >= b.maxZ) continue;
    const g = worldGround(world, x, z, b.maxY + 0.02, r, scratchGround);
    if (!g.found) continue;
    if (g.normalY < MAX_SLOPE_COS) continue;
    let dup = false;
    for (let k = 0; k < out.length; k++) {
      if (Math.abs(out[k] - g.y) < 0.4) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(g.y);
  }
  out.sort((a, b2) => a - b2);
  return out;
}

const scratchGround = { y: 0, normalY: 1, surface: 'metal', found: false, brushIndex: -1 };
const surfBuf: number[] = [];

export function buildNavGraph(world: CollisionWorld, spacing = 2.6): NavGraph {
  const minX = world.def.bounds.minX;
  const maxX = world.def.bounds.maxX;
  const minZ = world.def.bounds.minZ;
  const maxZ = world.def.bounds.maxZ;
  const cols = Math.max(1, Math.floor((maxX - minX) / spacing));
  const rows = Math.max(1, Math.floor((maxZ - minZ) / spacing));

  const nodes: NavNode[] = [];
  const cells: number[][] = new Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = [];

  // --- sample -------------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * spacing;
      const z = minZ + (r + 0.5) * spacing;
      const surfaces = columnSurfaces(world, x, z, surfBuf);
      for (let s = 0; s < surfaces.length; s++) {
        const y = surfaces[s];
        if (y < world.killY + 0.5) continue;
        // Need headroom for a crouched player at minimum.
        const ceil = worldCeiling(world, x, z, y + 0.1, PLAYER_RADIUS);
        if (ceil - y < 1.25) continue;
        if (worldSolid(world, x, y + 0.05, z, PLAYER_RADIUS * 0.9, Math.min(PLAYER_HEIGHT, ceil - y - 0.05), 0)) continue;
        const id = nodes.length;
        nodes.push({
          id,
          x,
          y,
          z,
          links: [],
          coverScore: 0,
          elevation: y,
          col: c,
          row: r,
        });
        cells[r * cols + c].push(id);
      }
    }
  }

  const graph: NavGraph = { nodes, spacing, minX, minZ, cols, rows, cells };

  // --- link ---------------------------------------------------------------
  const neighbourOffsets: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  for (const n of nodes) {
    for (const [dc, dr] of neighbourOffsets) {
      const c2 = n.col + dc;
      const r2 = n.row + dr;
      if (c2 < 0 || c2 >= cols || r2 < 0 || r2 >= rows) continue;
      const bucket = cells[r2 * cols + c2];
      for (const oid of bucket) {
        const o = nodes[oid];
        const dy = o.y - n.y;
        const horiz = Math.hypot(o.x - n.x, o.z - n.z);
        let kind: number;
        let cost: number;
        if (Math.abs(dy) <= 0.22) {
          kind = LINK_WALK;
          cost = horiz;
        } else if (dy > 0 && dy <= STEP_HEIGHT) {
          kind = LINK_STEP;
          cost = horiz + dy * 0.5;
        } else if (dy > 0 && dy <= MAX_JUMP_HEIGHT) {
          kind = LINK_JUMP;
          cost = horiz + dy * 2.2 + 1.4;
        } else if (dy < 0 && dy > -6.5) {
          kind = LINK_DROP;
          cost = horiz + 0.6;
        } else {
          continue;
        }
        if (!traversable(world, n, o, kind)) continue;
        n.links.push({ to: oid, cost, kind });
      }
    }
  }

  // --- cover scoring ------------------------------------------------------
  // A node with few walk links and a nearby wall is good cover.
  for (const n of nodes) {
    let blocked = 0;
    const probes = 8;
    for (let i = 0; i < probes; i++) {
      const a = (i / probes) * Math.PI * 2;
      const px = n.x + Math.cos(a) * 1.5;
      const pz = n.z + Math.sin(a) * 1.5;
      if (worldSolid(world, px, n.y + 0.4, pz, PLAYER_RADIUS, 1.2, 0)) blocked++;
    }
    n.coverScore = clamp(blocked / probes, 0, 1);
  }

  return graph;
}

function traversable(
  world: CollisionWorld,
  a: NavNode,
  b: NavNode,
  kind: number,
): boolean {
  // Walk the segment and make sure a crouched capsule fits at every step.
  const steps = 3;
  const testY = kind === LINK_DROP ? a.y : Math.max(a.y, b.y);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (worldSolid(world, x, testY + 0.05, z, PLAYER_RADIUS * 0.85, 1.2, kind === LINK_WALK ? STEP_HEIGHT : 0.05)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function nearestNode(graph: NavGraph, x: number, y: number, z: number): number {
  const c = clamp(Math.floor((x - graph.minX) / graph.spacing), 0, graph.cols - 1);
  const r = clamp(Math.floor((z - graph.minZ) / graph.spacing), 0, graph.rows - 1);
  let best = -1;
  let bestD = Infinity;
  for (let radius = 0; radius <= 4 && best < 0; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (radius > 0 && Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || cc >= graph.cols || rr < 0 || rr >= graph.rows) continue;
        for (const id of graph.cells[rr * graph.cols + cc]) {
          const n = graph.nodes[id];
          const dy = Math.abs(n.y - y);
          const d = Math.hypot(n.x - x, n.z - z) + dy * 2.4;
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
  }
  return best;
}

/** Reusable A* workspace so pathfinding never allocates per query. */
export class NavPathfinder {
  private gScore: Float64Array;
  private fScore: Float64Array;
  private cameFrom: Int32Array;
  private stamp: Int32Array;
  private current = 1;
  private open: number[] = [];

  constructor(private graph: NavGraph) {
    const n = graph.nodes.length;
    this.gScore = new Float64Array(n);
    this.fScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Int32Array(n);
  }

  /** Straight-line heuristic with a mild vertical penalty. */
  private h(a: number, b: number): number {
    const na = this.graph.nodes[a];
    const nb = this.graph.nodes[b];
    return Math.hypot(na.x - nb.x, na.z - nb.z) + Math.abs(na.y - nb.y) * 1.6;
  }

  /**
   * A* from `start` to `goal`.  Writes node ids into `outPath` (start first)
   * and returns the path length, or 0 when unreachable.
   */
  find(start: number, goal: number, outPath: number[], maxExpansions = 3000): number {
    outPath.length = 0;
    if (start < 0 || goal < 0) return 0;
    if (start === goal) {
      outPath.push(start);
      return 1;
    }
    const nodes = this.graph.nodes;
    const s = ++this.current;
    const open = this.open;
    open.length = 0;
    this.stamp[start] = s;
    this.gScore[start] = 0;
    this.fScore[start] = this.h(start, goal);
    this.cameFrom[start] = -1;
    open.push(start);

    let expansions = 0;
    while (open.length > 0 && expansions++ < maxExpansions) {
      // Linear scan is faster than a binary heap at these open-set sizes.
      let bestIdx = 0;
      let bestF = this.fScore[open[0]];
      for (let i = 1; i < open.length; i++) {
        const f = this.fScore[open[i]];
        if (f < bestF) {
          bestF = f;
          bestIdx = i;
        }
      }
      const cur = open[bestIdx];
      open[bestIdx] = open[open.length - 1];
      open.pop();

      if (cur === goal) {
        let n = goal;
        while (n !== -1) {
          outPath.push(n);
          n = this.cameFrom[n];
        }
        outPath.reverse();
        return outPath.length;
      }

      const links = nodes[cur].links;
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const tentative = this.gScore[cur] + l.cost;
        if (this.stamp[l.to] !== s) {
          this.stamp[l.to] = s;
          this.gScore[l.to] = tentative;
          this.fScore[l.to] = tentative + this.h(l.to, goal);
          this.cameFrom[l.to] = cur;
          open.push(l.to);
        } else if (tentative < this.gScore[l.to]) {
          this.gScore[l.to] = tentative;
          this.fScore[l.to] = tentative + this.h(l.to, goal);
          this.cameFrom[l.to] = cur;
          if (!open.includes(l.to)) open.push(l.to);
        }
      }
    }
    return 0;
  }
}

/** Nodes with good cover within `radius` of a point, best first. */
export function coverNodesNear(
  graph: NavGraph,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: number[],
  limit = 8,
): number[] {
  out.length = 0;
  const cellRadius = Math.ceil(radius / graph.spacing);
  const c = clamp(Math.floor((x - graph.minX) / graph.spacing), 0, graph.cols - 1);
  const r = clamp(Math.floor((z - graph.minZ) / graph.spacing), 0, graph.rows - 1);
  const scored: { id: number; s: number }[] = [];
  for (let dr = -cellRadius; dr <= cellRadius; dr++) {
    for (let dc = -cellRadius; dc <= cellRadius; dc++) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || cc >= graph.cols || rr < 0 || rr >= graph.rows) continue;
      for (const id of graph.cells[rr * graph.cols + cc]) {
        const n = graph.nodes[id];
        const d = Math.hypot(n.x - x, n.z - z);
        if (d > radius) continue;
        if (Math.abs(n.y - y) > 5) continue;
        if (n.coverScore < 0.25) continue;
        scored.push({ id, s: n.coverScore * 2 - d / radius });
      }
    }
  }
  scored.sort((a, b) => b.s - a.s);
  for (let i = 0; i < Math.min(limit, scored.length); i++) out.push(scored[i].id);
  return out;
}

/** Diagnostic used by the map traversal tests. */
export function navStats(graph: NavGraph): {
  nodes: number;
  links: number;
  isolated: number;
  largestComponent: number;
} {
  let links = 0;
  for (const n of graph.nodes) links += n.links.length;

  const seen = new Int32Array(graph.nodes.length);
  let largest = 0;
  let isolated = 0;
  let comp = 0;
  const stack: number[] = [];
  for (const n of graph.nodes) {
    if (n.links.length === 0) isolated++;
    if (seen[n.id]) continue;
    comp++;
    let size = 0;
    stack.length = 0;
    stack.push(n.id);
    seen[n.id] = comp;
    while (stack.length) {
      const cur = stack.pop() as number;
      size++;
      for (const l of graph.nodes[cur].links) {
        if (!seen[l.to]) {
          seen[l.to] = comp;
          stack.push(l.to);
        }
      }
    }
    if (size > largest) largest = size;
  }
  return { nodes: graph.nodes.length, links, isolated, largestComponent: largest };
}
