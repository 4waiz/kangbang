/**
 * World entities: static props, pickups, objective markers and deployables.
 *
 * Props are instantiated once from the map data and never touched again.
 * Pickups and objectives animate, so they are kept in small lists that the
 * session updates each frame.
 */

import { AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry, Scene, Vector3 } from 'three';
import { TEAM_COLORS, type MapDef, type ObjectiveState, type PickupDef } from '@kang/shared';
import { assets } from '../engine/assets.js';
import { ringTexture } from '../engine/textures.js';
import { store } from '../state/store.js';

interface PickupEntity {
  def: PickupDef;
  root: Group;
  model: Group;
  glow: Mesh;
  available: boolean;
  phase: number;
}

interface ObjectiveEntity {
  id: string;
  root: Group;
  marker: Group;
  zone: Mesh;
  progress: Mesh;
  state: ObjectiveState | null;
}

export class WorldEntities {
  private root = new Group();
  private pickups: PickupEntity[] = [];
  private objectives = new Map<string, ObjectiveEntity>();
  private deployables = new Map<number, Group>();

  constructor(private scene: Scene) {
    this.root.name = 'world-entities';
    scene.add(this.root);
  }

  build(def: MapDef): void {
    this.clear();

    // -- static props ----------------------------------------------------
    const propGroup = new Group();
    propGroup.name = 'props';
    for (const p of def.props) {
      const mesh = assets.instantiate(p.asset);
      mesh.position.set(p.p[0], p.p[1], p.p[2]);
      mesh.rotation.y = p.ry ?? 0;
      const s = p.scale ?? 1;
      mesh.scale.setScalar(s);
      if (p.tint !== undefined) {
        mesh.traverse((child) => {
          const m = child as Mesh;
          if (!m.isMesh) return;
          const mat = m.material as MeshBasicMaterial & { emissive?: Color; emissiveIntensity?: number };
          if (mat?.emissive && (mat.emissiveIntensity ?? 0) > 0.4) mat.emissive.setHex(p.tint as number);
        });
      }
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      propGroup.add(mesh);
    }
    this.root.add(propGroup);

    // -- pickups ---------------------------------------------------------
    for (const pk of def.pickups) {
      const root = new Group();
      root.position.set(pk.p[0], pk.p[1], pk.p[2]);

      const pedestal = assets.instantiate('pickup_pedestal');
      root.add(pedestal);

      const modelName =
        pk.kind === 'weapon' && pk.weapon
          ? `wpn_${pk.weapon}_world`
          : pk.kind === 'health'
            ? 'pickup_health'
            : pk.kind === 'shield'
              ? 'pickup_shield'
              : 'pickup_ammo';
      const model = assets.instantiate(modelName);
      model.position.y = 0.95;
      root.add(model);

      // Ground glow ring so pickups are visible from across the map.
      const color = pk.kind === 'health' ? 0x8dff4a : pk.kind === 'shield' ? 0x2ce8ff : pk.kind === 'weapon' ? 0xffb03a : 0xffd76b;
      const glow = new Mesh(
        new PlaneGeometry(2.2, 2.2),
        new MeshBasicMaterial({
          map: ringTexture(),
          color: new Color(color),
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = 0.06;
      root.add(glow);

      this.root.add(root);
      this.pickups.push({ def: pk, root, model, glow, available: true, phase: Math.random() * Math.PI * 2 });
    }

    // -- objective anchors ----------------------------------------------
    for (const o of def.objectives) {
      const root = new Group();
      root.position.set(o.p[0], o.p[1], o.p[2]);
      root.visible = false;

      const marker = assets.instantiate(o.kind === 'core' ? 'obj_core' : 'obj_zone_marker');
      root.add(marker);

      const zone = new Mesh(
        new RingGeometry(o.radius * 0.92, o.radius, 40, 1),
        new MeshBasicMaterial({
          color: new Color(0x9aa7bd),
          transparent: true,
          opacity: 0.5,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
      );
      zone.rotation.x = -Math.PI / 2;
      zone.position.y = 0.06;
      root.add(zone);

      const progress = new Mesh(
        new RingGeometry(o.radius * 0.7, o.radius * 0.86, 40, 1, 0, 0.001),
        new MeshBasicMaterial({
          color: new Color(0x2ce8ff),
          transparent: true,
          opacity: 0.8,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          toneMapped: false,
        }),
      );
      progress.rotation.x = -Math.PI / 2;
      progress.position.y = 0.08;
      root.add(progress);

      this.root.add(root);
      this.objectives.set(o.id, { id: o.id, root, marker, zone, progress, state: null });
    }
  }

  /** Server told us a pickup was taken (or respawned). */
  setPickupAvailable(id: string, available: boolean): void {
    const p = this.pickups.find((x) => x.def.id === id);
    if (!p) return;
    p.available = available;
  }

  /** Hide a pickup for its respawn window based on a collection event. */
  consumePickupAt(x: number, y: number, z: number): void {
    let best: PickupEntity | null = null;
    let bestD = 3.5;
    for (const p of this.pickups) {
      const d = Math.hypot(p.def.p[0] - x, p.def.p[1] - y, p.def.p[2] - z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best) {
      best.available = false;
      // Re-arm on the map's own timer; the server is authoritative but this
      // keeps the visual honest without an extra message per pickup.
      const seconds = best.def.respawnSec;
      const target = best;
      window.setTimeout(() => {
        target.available = true;
      }, seconds * 1000);
    }
  }

  syncObjectives(states: ObjectiveState[], selfTeam: number): void {
    const live = new Set(states.map((s) => s.id));
    for (const [id, ent] of this.objectives) {
      const state = states.find((s) => s.id === id) ?? null;
      ent.state = state;
      ent.root.visible = !!state && state.active;
      if (!state) continue;
      ent.root.position.set(state.x, state.y, state.z);

      const ownerColor = state.owner !== 0 ? (TEAM_COLORS[state.owner] ?? 0x9aa7bd) : 0x9aa7bd;
      (ent.zone.material as MeshBasicMaterial).color.setHex(ownerColor);
      (ent.zone.material as MeshBasicMaterial).opacity = state.contestedBy === 3 ? 0.9 : 0.45;

      // Progress arc: cyan when we are taking it, red when they are.
      const takingTeam = state.contestedBy === 3 ? 0 : state.contestedBy;
      const progressColor =
        takingTeam === 0 ? 0xffffff : takingTeam === selfTeam ? (TEAM_COLORS[selfTeam] ?? 0x2ce8ff) : 0xff5a3c;
      (ent.progress.material as MeshBasicMaterial).color.setHex(progressColor);
      const geo = ent.progress.geometry as RingGeometry;
      const angle = Math.max(0.001, state.progress * Math.PI * 2);
      // Rebuilding a 40-segment ring is cheap and happens at most a few times
      // per second per objective.
      ent.progress.geometry.dispose();
      ent.progress.geometry = new RingGeometry(
        geo.parameters.innerRadius,
        geo.parameters.outerRadius,
        40,
        1,
        Math.PI / 2,
        angle,
      );

      ent.marker.traverse((child) => {
        const m = child as Mesh;
        if (!m.isMesh) return;
        const mat = m.material as MeshBasicMaterial & { emissive?: Color; emissiveIntensity?: number };
        if (mat?.emissive && (mat.emissiveIntensity ?? 0) > 0.4) mat.emissive.setHex(ownerColor);
      });
      // A carried core rides on its carrier, so hide the world marker.
      if (state.kind === 'core' && state.carrier >= 0) ent.root.visible = false;
    }
    for (const id of live) {
      if (!this.objectives.has(id)) {
        // Objective sets are fixed per map; an unknown id means the server is
        // running a different map build. Ignore rather than crash.
      }
    }
  }

  /** Spawn or refresh a deployable's visual. */
  syncDeployable(id: number, kind: string, x: number, y: number, z: number, yaw: number, team: number): void {
    let g = this.deployables.get(id);
    if (!g) {
      const asset =
        kind === 'turret' ? 'dep_turret' : kind === 'barrier' ? 'dep_barrier' : kind === 'heal_field' ? 'dep_field' : 'dep_dome';
      g = assets.instantiate(asset);
      const color = TEAM_COLORS[team] ?? 0x2ce8ff;
      g.traverse((child) => {
        const m = child as Mesh;
        if (!m.isMesh) return;
        const mat = m.material as MeshBasicMaterial & { emissive?: Color; emissiveIntensity?: number };
        if (mat?.emissive && (mat.emissiveIntensity ?? 0) > 0.4) mat.emissive.setHex(color);
      });
      this.root.add(g);
      this.deployables.set(id, g);
    }
    g.position.set(x, y, z);
    g.rotation.y = yaw;
  }

  removeDeployable(id: number): void {
    const g = this.deployables.get(id);
    if (!g) return;
    this.root.remove(g);
    this.deployables.delete(id);
  }

  clearDeployables(): void {
    for (const g of this.deployables.values()) this.root.remove(g);
    this.deployables.clear();
  }

  update(dt: number, time: number, cameraPos: Vector3): void {
    const drawDistance = store.num('drawDistance');
    for (const p of this.pickups) {
      const visible = p.available;
      p.root.visible = visible;
      if (!visible) continue;
      // Cull distant pickups by hand: they are small and numerous, and this is
      // cheaper than letting three test each child.
      const dist = cameraPos.distanceTo(p.root.position);
      if (dist > drawDistance * 0.6) {
        p.root.visible = false;
        continue;
      }
      p.phase += dt;
      p.model.rotation.y += dt * 1.1;
      p.model.position.y = 0.95 + Math.sin(p.phase * 2) * 0.07;
      (p.glow.material as MeshBasicMaterial).opacity = 0.35 + Math.sin(p.phase * 3) * 0.15;
    }

    for (const ent of this.objectives.values()) {
      if (!ent.root.visible) continue;
      ent.marker.rotation.y += dt * 0.5;
      const pulse = 0.4 + Math.sin(time * 2.4) * 0.2;
      (ent.zone.material as MeshBasicMaterial).opacity = pulse + (ent.state?.contestedBy === 3 ? 0.4 : 0);
    }

    for (const g of this.deployables.values()) {
      g.rotation.y += dt * 0.2;
    }
  }

  clear(): void {
    this.root.clear();
    this.pickups.length = 0;
    this.objectives.clear();
    this.deployables.clear();
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.root);
  }
}
