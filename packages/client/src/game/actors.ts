/**
 * Remote players and world entities.
 *
 * Remote players are rendered from a snapshot history buffer at
 * `serverTime - INTERP_DELAY`, which trades ~100ms of latency for motion that
 * is completely free of jitter. Extrapolation past the newest snapshot is
 * capped at 120ms: beyond that a player who stopped moving would keep sliding,
 * which is far more misleading than a brief stall.
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Vector3,
} from 'three';
import {
  COSMETICS,
  EntFlag,
  INTERP_DELAY,
  PLAYER_HEIGHT,
  TEAM_COLORS,
  WEAPON_ORDER,
  clamp,
  lerpAngle,
  type EntitySnapshot,
  type PlayerPublicState,
} from '@neon/shared';
import { store } from '../state/store.js';
import { assets } from '../engine/assets.js';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  health: number;
  shield: number;
  weapon: number;
  team: number;
}

const MAX_SAMPLES = 24;
const MAX_EXTRAPOLATE_MS = 120;

export class RemoteActor {
  readonly id: number;
  readonly root = new Group();
  private body: Group | null = null;
  private weaponMesh: Group | null = null;
  private outline: Mesh | null = null;
  private nameplate: Sprite | null = null;
  private samples: Sample[] = [];
  private classId = '';
  private weaponIndex = -1;
  private renderYaw = 0;
  private legPhase = 0;
  /** Smoothed values used for animation rather than raw snapshot deltas. */
  private speed = 0;
  private lastX = 0;
  private lastZ = 0;
  private teamColor = 0x9aa7bd;
  private visibleAlive = true;
  public info: PlayerPublicState | null = null;

  constructor(id: number, scene: Scene) {
    this.id = id;
    this.root.name = `actor:${id}`;
    scene.add(this.root);
  }

  setClass(classId: string, team: number, accent: number): void {
    if (this.classId === classId && this.teamColor === (TEAM_COLORS[team] ?? accent)) return;
    this.classId = classId;
    this.teamColor = TEAM_COLORS[team] || accent;
    if (this.body) {
      this.root.remove(this.body);
      this.body = null;
    }
    const model = assets.instantiate(`char_${classId}`);
    // Team colour is applied to the emissive channel of the `ns_team` material
    // only; body albedo stays constant so silhouettes remain readable.
    model.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = store.str('shadowQuality') !== 'off';
      mesh.receiveShadow = false;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as MeshBasicMaterial & { emissive?: Color; emissiveIntensity?: number; name?: string };
        if (mat?.emissive && (mat.emissiveIntensity ?? 0) > 0.5) {
          mat.emissive.setHex(this.teamColor);
        }
      }
    });
    this.root.add(model);
    this.body = model;
    this.ensureOutline();
  }

  setWeapon(weaponIdx: number): void {
    if (this.weaponIndex === weaponIdx) return;
    this.weaponIndex = weaponIdx;
    if (this.weaponMesh) {
      this.root.remove(this.weaponMesh);
      this.weaponMesh = null;
    }
    const id = WEAPON_ORDER[weaponIdx];
    if (!id) return;
    const mesh = assets.instantiate(`wpn_${id}_world`);
    // Held at the right hand, angled forward.
    mesh.position.set(0.26, 1.28, -0.18);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.setScalar(1);
    this.root.add(mesh);
    this.weaponMesh = mesh;
  }

  /** High-contrast enemy outline for the accessibility setting. */
  private ensureOutline(): void {
    if (!store.bool('enemyOutlines')) {
      if (this.outline) {
        this.root.remove(this.outline);
        this.outline = null;
      }
      return;
    }
    if (this.outline) return;
    const geo = new PlaneGeometry(1.0, PLAYER_HEIGHT);
    const mat = new MeshBasicMaterial({
      color: new Color(this.teamColor),
      transparent: true,
      opacity: 0.22,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const mesh = new Mesh(geo, mat);
    mesh.position.y = PLAYER_HEIGHT / 2;
    mesh.renderOrder = 900;
    this.root.add(mesh);
    this.outline = mesh;
  }

  setNameplate(name: string, team: number, level: number): void {
    if (this.nameplate) {
      this.root.remove(this.nameplate);
      this.nameplate.material.map?.dispose();
      this.nameplate.material.dispose();
      this.nameplate = null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const color = `#${(TEAM_COLORS[team] ?? 0x9aa7bd).toString(16).padStart(6, '0')}`;
    ctx.font = '600 26px "Bahnschrift", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(name, 128, 34);
    ctx.fillStyle = color;
    ctx.fillText(name, 128, 34);
    ctx.font = '500 15px "Cascadia Mono", monospace';
    ctx.strokeText(`LV ${level}`, 128, 12);
    ctx.fillStyle = 'rgba(230,240,255,0.75)';
    ctx.fillText(`LV ${level}`, 128, 12);

    const tex = new CanvasTexture(canvas);
    const sprite = new Sprite(
      new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    sprite.scale.set(1.6, 0.4, 1);
    sprite.position.y = PLAYER_HEIGHT + 0.42;
    sprite.renderOrder = 950;
    this.root.add(sprite);
    this.nameplate = sprite;
  }

  push(sample: EntitySnapshot, serverTimeMs: number): void {
    const s: Sample = {
      t: serverTimeMs,
      x: sample.x,
      y: sample.y,
      z: sample.z,
      yaw: sample.yaw,
      pitch: sample.pitch,
      flags: sample.flags,
      health: sample.health,
      shield: sample.shield,
      weapon: sample.weapon,
      team: sample.team,
    };
    // Snapshots can arrive out of order over a lossy link.
    if (this.samples.length > 0 && s.t <= this.samples[this.samples.length - 1].t) return;
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Interpolate to `renderTimeMs` and update animation. */
  update(renderTimeMs: number, dt: number, cameraPos: Vector3, isEnemy: boolean): void {
    if (this.samples.length === 0) {
      this.root.visible = false;
      return;
    }

    let a: Sample | null = null;
    let b: Sample | null = null;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i].t <= renderTimeMs) {
        a = this.samples[i];
        b = this.samples[i + 1] ?? null;
        break;
      }
    }

    let x: number;
    let y: number;
    let z: number;
    let yaw: number;
    let pitch: number;
    let flags: number;

    if (a && b) {
      const span = b.t - a.t;
      const t = span > 0 ? clamp((renderTimeMs - a.t) / span, 0, 1) : 0;
      x = a.x + (b.x - a.x) * t;
      y = a.y + (b.y - a.y) * t;
      z = a.z + (b.z - a.z) * t;
      yaw = lerpAngle(a.yaw, b.yaw, t);
      pitch = a.pitch + (b.pitch - a.pitch) * t;
      flags = t < 0.5 ? a.flags : b.flags;
    } else if (a) {
      // Ahead of the newest sample: hold, with a short capped extrapolation.
      const newest = this.samples[this.samples.length - 1];
      const ahead = clamp(renderTimeMs - newest.t, 0, MAX_EXTRAPOLATE_MS) / 1000;
      const prev = this.samples[this.samples.length - 2];
      let vx = 0;
      let vz = 0;
      let vy = 0;
      if (prev) {
        const span = (newest.t - prev.t) / 1000;
        if (span > 0.001) {
          vx = (newest.x - prev.x) / span;
          vy = (newest.y - prev.y) / span;
          vz = (newest.z - prev.z) / span;
        }
      }
      x = newest.x + vx * ahead;
      y = newest.y + vy * ahead;
      z = newest.z + vz * ahead;
      yaw = newest.yaw;
      pitch = newest.pitch;
      flags = newest.flags;
    } else {
      const oldest = this.samples[0];
      x = oldest.x;
      y = oldest.y;
      z = oldest.z;
      yaw = oldest.yaw;
      pitch = oldest.pitch;
      flags = oldest.flags;
    }

    const alive = (flags & EntFlag.Alive) !== 0;
    const cloaked = (flags & EntFlag.Cloaked) !== 0;
    const scanned = (flags & EntFlag.Scanned) !== 0;
    this.visibleAlive = alive;
    this.root.visible = alive;
    if (!alive) return;

    // Movement speed from actual rendered motion, so animation matches what the
    // player sees rather than what the server said.
    const moved = Math.hypot(x - this.lastX, z - this.lastZ);
    this.speed = this.speed * 0.8 + (dt > 0 ? (moved / dt) * 0.2 : 0);
    this.lastX = x;
    this.lastZ = z;

    this.root.position.set(x, y, z);
    // Yaw is smoothed further: raw quantised yaw at 20Hz snaps visibly.
    this.renderYaw = lerpAngle(this.renderYaw, yaw, clamp(dt * 14, 0, 1));
    this.root.rotation.y = this.renderYaw;

    const crouching = (flags & EntFlag.Crouching) !== 0;
    const sliding = (flags & EntFlag.Sliding) !== 0;
    // Crouch/slide by squashing the model: cheap, and it reads instantly.
    const targetScaleY = sliding ? 0.6 : crouching ? 0.72 : 1;
    if (this.body) {
      this.body.scale.y += (targetScaleY - this.body.scale.y) * clamp(dt * 12, 0, 1);
      // Lean into the direction of travel.
      const lean = clamp(this.speed / 14, 0, 1) * 0.12;
      this.body.rotation.x = sliding ? -0.5 : -lean;
      // Walk cycle: bob the whole body since the mesh is not skinned.
      this.legPhase += dt * (4 + clamp(this.speed, 0, 12) * 0.9);
      const bob = Math.abs(Math.sin(this.legPhase)) * clamp(this.speed / 9, 0, 1) * 0.055;
      this.body.position.y = sliding ? -0.15 : bob;
    }
    if (this.weaponMesh) {
      this.weaponMesh.rotation.x = clamp(pitch, -1.2, 1.2);
      this.weaponMesh.position.y = 1.28 * (this.body?.scale.y ?? 1);
      this.weaponMesh.visible = !sliding;
    }

    // Cloak: fade rather than vanish, so a Phantom is beatable.
    const cloakOpacity = cloaked ? 0.13 : 1;
    if (this.body) {
      this.body.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const mat = m as MeshBasicMaterial;
          if (!mat) continue;
          if (cloaked) {
            mat.transparent = true;
            mat.opacity = cloakOpacity;
            mat.depthWrite = false;
          } else if (mat.opacity < 1 && mat.transparent) {
            mat.opacity = 1;
            mat.depthWrite = true;
          }
        }
      });
    }

    if (this.outline) {
      const show = isEnemy && (!cloaked || scanned);
      this.outline.visible = show;
      this.outline.lookAt(cameraPos);
      this.outline.position.y = (PLAYER_HEIGHT / 2) * (this.body?.scale.y ?? 1);
    }
    // Scanned enemies get a bright pulse regardless of the outline setting.
    if (scanned && this.body) {
      const pulse = 0.5 + Math.sin(performance.now() / 140) * 0.5;
      this.body.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as MeshBasicMaterial & { emissiveIntensity?: number };
        if (mat && mat.emissiveIntensity !== undefined && mat.emissiveIntensity > 0.5) {
          mat.emissiveIntensity = 1.4 + pulse * 2.2;
        }
      });
    }

    if (this.nameplate) {
      this.nameplate.visible = !isEnemy || scanned;
      this.nameplate.position.y = PLAYER_HEIGHT * (this.body?.scale.y ?? 1) + 0.42;
    }
  }

  get alive(): boolean {
    return this.visibleAlive;
  }

  get position(): Vector3 {
    return this.root.position;
  }

  dispose(scene: Scene): void {
    scene.remove(this.root);
    this.nameplate?.material.map?.dispose();
    this.nameplate?.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Actor registry
// ---------------------------------------------------------------------------

export class ActorSet {
  private actors = new Map<number, RemoteActor>();

  constructor(private scene: Scene) {}

  ingest(entities: EntitySnapshot[], serverTimeMs: number, selfId: number, roster: Map<number, PlayerPublicState>): void {
    const seen = new Set<number>();
    for (const e of entities) {
      if (e.id === selfId) continue;
      seen.add(e.id);
      let actor = this.actors.get(e.id);
      if (!actor) {
        actor = new RemoteActor(e.id, this.scene);
        this.actors.set(e.id, actor);
      }
      const info = roster.get(e.id);
      if (info && info !== actor.info) {
        actor.info = info;
        const accent = 0x9aa7bd;
        actor.setClass(info.classId || 'vanguard', e.team, accent);
        actor.setNameplate(info.name, e.team, info.accountLevel);
      } else if (!info) {
        actor.setClass('vanguard', e.team, 0x9aa7bd);
      }
      actor.setWeapon(e.weapon);
      actor.push(e, serverTimeMs);
    }
    // Remove actors that dropped out of the snapshot entirely.
    for (const [id, actor] of this.actors) {
      if (!seen.has(id)) {
        actor.dispose(this.scene);
        this.actors.delete(id);
      }
    }
  }

  update(renderTimeMs: number, dt: number, cameraPos: Vector3, selfTeam: number): void {
    for (const actor of this.actors.values()) {
      const team = actor.info?.team ?? 0;
      const isEnemy = selfTeam === 0 || team !== selfTeam;
      actor.update(renderTimeMs, dt, cameraPos, isEnemy);
    }
  }

  get(id: number): RemoteActor | undefined {
    return this.actors.get(id);
  }

  values(): IterableIterator<RemoteActor> {
    return this.actors.values();
  }

  get count(): number {
    return this.actors.size;
  }

  clear(): void {
    for (const actor of this.actors.values()) actor.dispose(this.scene);
    this.actors.clear();
  }
}

export { COSMETICS, INTERP_DELAY, Object3D };
