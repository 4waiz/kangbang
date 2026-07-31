/**
 * LOD pairing.
 *
 * The GLBs are Draco-compressed, so they cannot be parsed here without the
 * decoder. What is reconstructed instead is the exact node graph GLTFLoader
 * builds from them, which is where the bug lived: a multi-material mesh comes
 * back as a Group named after the glTF *node* (`char_titan_LOD1`) whose children
 * are named after the *mesh data* (`char_titan_LOD1_mesh`, `..._mesh_1`, ...).
 * The names below are taken from the real files - see
 * packages/client/public/assets/models.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, LOD, Mesh } from 'three';

import { attachLods, findLodNodes, lodBaseName } from '../assets.js';

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
});
