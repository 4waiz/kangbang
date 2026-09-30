/**
 * Asset loading: LOD pairing, the shadow policy, and the load timeout.
 *
 * The GLBs are Draco-compressed, so they cannot be parsed here without the
 * decoder. What is reconstructed instead is the exact node graph GLTFLoader
 * builds from them, which is where the LOD bug lived: a multi-material mesh
 * comes back as a Group named after the glTF *node* (`char_titan_LOD1`) whose
 * children are named after the *mesh data* (`char_titan_LOD1_mesh`,
 * `..._mesh_1`, ...). The names below are taken from the real files - see
 * packages/client/public/assets/models.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, LOD, Mesh } from 'three';

import { applyShadowPolicy, attachLods, findLodNodes, lodBaseName, withTimeout } from '../assets.js';

function unitMesh(name: string): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  const mesh = new Mesh(geometry);
  mesh.name = name;
  return mesh;
}

/** A model of a given size, so the shadow policy has bounds to measure. */
function sizedModel(name: string, radius: number): Group {
  const group = new Group();
  group.name = name;
  // A triangle whose bounding box is a cube of half-extent `r` about the origin.
  // Box3.getBoundingSphere returns half the diagonal, so the sphere comes out at
  // `r * sqrt(3)`; dividing through lands it on the radius the caller asked for.
  const r = radius / Math.sqrt(3);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-r, -r, -r, r, -r, -r, r, r, r]), 3),
  );
  const mesh = new Mesh(geometry);
  mesh.name = `${name}_mesh`;
  group.add(mesh);
  return group;
}

function casters(scene: Group): number {
  let n = 0;
  scene.traverse((child) => {
    if ((child as Mesh).isMesh && child.castShadow) n++;
  });
  return n;
}

/** One glTF node whose mesh has `primitives` materials, as the loader builds it. */
function loaderNode(nodeName: string, primitives: number): Group | Mesh {
  if (primitives === 1) {
    // A single primitive collapses: the Mesh *is* the node and takes its name.
    return unitMesh(nodeName);
  }
  const group = new Group();
  group.name = nodeName;
  for (let i = 0; i < primitives; i++) {
    // GLTFLoader de-duplicates repeated names by appending `_1`, `_2`, ...
    group.add(unitMesh(i === 0 ? `${nodeName}_mesh` : `${nodeName}_mesh_${i}`));
  }
  return group;
}

function sceneWith(base: string, primitives: number): Group {
  const scene = new Group();
  scene.add(loaderNode(base, primitives));
  scene.add(loaderNode(`${base}_LOD1`, primitives));
  return scene;
}

describe('lodBaseName', () => {
  it('matches the node name of a single-material LOD', () => {
    expect(lodBaseName('prop_pipe_run_LOD1')).toBe('prop_pipe_run');
  });

  it('matches the mesh names inside a multi-material LOD', () => {
    expect(lodBaseName('char_titan_LOD1_mesh')).toBe('char_titan');
    expect(lodBaseName('char_titan_LOD1_mesh_6')).toBe('char_titan');
  });

  it('ignores full-detail nodes and their meshes', () => {
    expect(lodBaseName('char_titan')).toBeNull();
    expect(lodBaseName('char_titan_mesh')).toBeNull();
    expect(lodBaseName('char_titan_mesh_6')).toBeNull();
    expect(lodBaseName('SOCKET_weapon')).toBeNull();
  });
});

describe('attachLods', () => {
  // 7 primitives is the real shape of every character GLB; 2 is prop_pipe_run.
  for (const primitives of [1, 2, 7]) {
    it(`pairs a ${primitives}-material model into one LOD`, () => {
      const scene = sceneWith('char_titan', primitives);
      const lods = findLodNodes(scene);

      expect(lods.nodes.size).toBe(1);
      expect(attachLods(scene, lods.nodes)).toBe(1);

      // One LOD in place of the two siblings, with a near and a far level.
      expect(scene.children.length).toBe(1);
      const lod = scene.children[0] as LOD;
      expect(lod).toBeInstanceOf(LOD);
      expect(lod.levels.length).toBe(2);
      expect(lod.levels[0].distance).toBe(0);
      expect(lod.levels[1].distance).toBeGreaterThan(0);
      expect(lod.levels[0].object.name).toBe('char_titan');
      expect(lod.levels[1].object.name).toBe('char_titan_LOD1');
    });
  }

  it('counts the reduced copy separately from the original', () => {
    const scene = sceneWith('char_titan', 7);
    const lods = findLodNodes(scene);

    // The LOD group and its seven meshes, and nothing from the full-detail side.
    expect(lods.reduced.size).toBe(8);
    for (const object of lods.reduced) expect(object.name).toContain('_LOD1');
  });

  it('drops a reduced copy whose original is missing', () => {
    const scene = new Group();
    scene.add(loaderNode('char_titan_LOD1', 7));

    const lods = findLodNodes(scene);
    expect(attachLods(scene, lods.nodes)).toBe(0);
    // Left in place it would draw as a duplicate with no original behind it.
    expect(scene.children.length).toBe(0);
  });

  it('leaves a model with no reduced copy alone', () => {
    const scene = new Group();
    scene.add(loaderNode('wpn_pulse_ar', 5));

    const lods = findLodNodes(scene);
    expect(lods.nodes.size).toBe(0);
    expect(attachLods(scene, lods.nodes)).toBe(0);
    expect(scene.children.length).toBe(1);
    expect(scene.children[0]).not.toBeInstanceOf(LOD);
  });

  it('does not re-flag the levels as shadow casters', () => {
    // attachLods used to set `castShadow = true` on every mesh it touched, which
    // silently overrode the per-asset policy for exactly the assets that have an
    // LOD: the six characters and the pipe run.
    const scene = sceneWith('wpn_rail_sniper', 2);
    attachLods(scene, findLodNodes(scene).nodes);
    expect(casters(scene)).toBe(0);
  });
});

describe('applyShadowPolicy', () => {
  it('always casts for a character, whatever its size', () => {
    const scene = sizedModel('char_spectre', 0.3);
    applyShadowPolicy('char_spectre', scene);
    expect(casters(scene)).toBe(1);
  });

  it('never casts for the first-person arms', () => {
    // They render from viewScene, which has no shadow map for them to cast into.
    const scene = sizedModel('char_arms_fp', 2);
    applyShadowPolicy('char_arms_fp', scene);
    expect(casters(scene)).toBe(0);
  });

  it('casts for a large prop and not for a small one', () => {
    // Real measurements: a crate stack is 1.44m, a dropped pickup 0.43m.
    const big = sizedModel('prop_crate_stack', 1.44);
    applyShadowPolicy('prop_crate_stack', big);
    expect(casters(big)).toBe(1);

    const small = sizedModel('pickup_health', 0.43);
    applyShadowPolicy('pickup_health', small);
    expect(casters(small)).toBe(0);
  });

  it('never casts for a weapon, held or dropped', () => {
    // The largest weapon in the set is the rail sniper at 0.46m.
    for (const name of ['wpn_rail_sniper', 'wpn_rail_sniper_world']) {
      const scene = sizedModel(name, 0.46);
      applyShadowPolicy(name, scene);
      expect(casters(scene)).toBe(0);
    }
  });

  it('does not cast for an empty scene', () => {
    const scene = new Group();
    applyShadowPolicy('prop_nothing', scene);
    expect(casters(scene)).toBe(0);
  });
});

/**
 * The boot freeze.
 *
 * A hung fetch never settles, so the loader worker awaiting it never takes
 * another name and `loadAll` never resolves - the boot bar stops at 35% with no
 * error and no Retry. Making a stall look like a rejection is the whole fix,
 * because rejection was already handled: the asset falls back to a placeholder.
 */
describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a value through when the work wins', async () => {
    await expect(withTimeout(Promise.resolve('gltf'), 10_000, 'x.glb')).resolves.toBe('gltf');
  });

  it('passes a rejection through unchanged', async () => {
    const boom = new Error('404');
    await expect(withTimeout(Promise.reject(boom), 10_000, 'x.glb')).rejects.toBe(boom);
  });

  it('rejects a promise that never settles, naming the asset', async () => {
    vi.useFakeTimers();
    const hung = withTimeout(new Promise<string>(() => undefined), 10_000, 'char_titan.glb');
    const caught = hung.catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(caught).resolves.toContain('char_titan.glb');
  });

  it('clears its timer when the work settles first', async () => {
    vi.useFakeTimers();
    // A pending timer per successful load would keep 59 of them alive through
    // the whole boot, and in Node would hold the process open.
    await withTimeout(Promise.resolve(1), 10_000, 'x.glb');
    expect(vi.getTimerCount()).toBe(0);
  });
});
