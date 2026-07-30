/**
 * Visual effects.
 *
 * Everything here is pooled. A busy 16-player fight produces hundreds of
 * tracers, impacts and shells per second; allocating meshes for those would
 * cause a GC pause every few seconds, which in an FPS reads as the game
 * stuttering exactly when it matters most.
 *
 * Pools are fixed-size and oldest-wins: when a pool is exhausted the oldest
 * live effect is recycled rather than growing the pool, so memory is bounded
 * no matter how chaotic the match gets.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import { clamp } from '@kang/shared';
import { store } from '../state/store.js';
import { decalTexture, ringTexture, sparkTexture } from './textures.js';

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpQ = new Quaternion();

// ---------------------------------------------------------------------------
// Generic pool
// ---------------------------------------------------------------------------

interface Poolable {
  object: Object3D;
  life: number;
  maxLife: number;
  active: boolean;
}

class Pool<T extends Poolable> {
  readonly items: T[] = [];
  private cursor = 0;

  constructor(
    readonly size: number,
    factory: (index: number) => T,
  ) {
    for (let i = 0; i < size; i++) {
      const item = factory(i);
      item.object.visible = false;
      item.active = false;
      this.items.push(item);
    }
  }

  /** Next free slot, recycling the oldest if all are busy. */
  acquire(): T {
    for (let i = 0; i < this.items.length; i++) {
      const idx = (this.cursor + i) % this.items.length;
      const item = this.items[idx];
      if (!item.active) {
        this.cursor = (idx + 1) % this.items.length;
        item.active = true;
        item.object.visible = true;
        return item;
      }
    }
    const item = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    item.active = true;
    item.object.visible = true;
    return item;
  }

  release(item: T): void {
    item.active = false;
    item.object.visible = false;
  }

  get liveCount(): number {
    let n = 0;
    for (const i of this.items) if (i.active) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Effect records
// ---------------------------------------------------------------------------

interface Tracer extends Poolable {
  object: Mesh;
  from: Vector3;
  to: Vector3;
  width: number;
}

interface Impact extends Poolable {
  object: Group;
  sprite: Mesh;
  points: Points;
  velocities: Float32Array;
  basePositions: Float32Array;
  light: PointLight | null;
}

interface Muzzle extends Poolable {
  object: Group;
  core: Mesh;
  flare: Mesh;
  light: PointLight;
}

interface Shell extends Poolable {
  object: Mesh;
  vel: Vector3;
  spin: Vector3;
}

interface Decal extends Poolable {
  object: Mesh;
}

interface Blast extends Poolable {
  object: Group;
  shell: Mesh;
  ring: Mesh;
  light: PointLight;
}

interface Burst extends Poolable {
  object: Points;
  velocities: Float32Array;
  basePositions: Float32Array;
  gravity: number;
}

interface Beam extends Poolable {
  object: Mesh;
  from: Vector3;
  to: Vector3;
}

export interface FxStats {
  tracers: number;
  impacts: number;
  decals: number;
  particles: number;
}

// ---------------------------------------------------------------------------

export class FxSystem {
  private root = new Group();
  private tracers: Pool<Tracer>;
  private impacts: Pool<Impact>;
  private muzzles: Pool<Muzzle>;
  private shells: Pool<Shell>;
  private decals: Pool<Decal>;
  private blasts: Pool<Blast>;
  private bursts: Pool<Burst>;
  private beams: Pool<Beam>;
  private quality: 'low' | 'medium' | 'high';
  private decalLimit: number;

  constructor(private scene: Scene) {
    this.root.name = 'fx';
    scene.add(this.root);
    this.quality = store.str('effectsQuality') as 'low' | 'medium' | 'high';
    this.decalLimit = store.num('decalLimit');

    const budget = this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.75 : 1;
    const sparkMap = sparkTexture();

    // -- tracers ---------------------------------------------------------
    const tracerGeo = new CylinderGeometry(1, 1, 1, 5, 1, true);
    tracerGeo.translate(0, 0.5, 0);
    tracerGeo.rotateX(Math.PI / 2);
    this.tracers = new Pool<Tracer>(Math.round(96 * budget), () => {
      const mat = new MeshBasicMaterial({
        color: 0x7ff0ff,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new Mesh(tracerGeo, mat);
      mesh.frustumCulled = false;
      this.root.add(mesh);
      return { object: mesh, life: 0, maxLife: 0.06, active: false, from: new Vector3(), to: new Vector3(), width: 0.03 };
    });

    // -- impacts ---------------------------------------------------------
    const impactSpriteGeo = new PlaneGeometry(1, 1);
    const particlesPerImpact = this.quality === 'low' ? 4 : this.quality === 'medium' ? 8 : 12;
    this.impacts = new Pool<Impact>(Math.round(56 * budget), () => {
      const group = new Group();
      const sprite = new Mesh(
        impactSpriteGeo,
        new MeshBasicMaterial({
          map: sparkMap,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          side: DoubleSide,
        }),
      );
      group.add(sprite);

      const positions = new Float32Array(particlesPerImpact * 3);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(positions, 3));
      const points = new Points(
        geo,
        new PointsMaterial({
          size: 0.07,
          map: sparkMap,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
          toneMapped: false,
        }),
      );
      points.frustumCulled = false;
      group.add(points);

      let light: PointLight | null = null;
      if (this.quality === 'high') {
        light = new PointLight(0xffffff, 0, 4, 2);
        group.add(light);
      }
      this.root.add(group);
      return {
        object: group,
        life: 0,
        maxLife: 0.24,
        active: false,
        sprite,
        points,
        velocities: new Float32Array(particlesPerImpact * 3),
        basePositions: positions,
        light,
      };
    });

    // -- muzzle flashes --------------------------------------------------
    const flashCore = new SphereGeometry(1, 6, 4);
    const flashFlare = new PlaneGeometry(1, 1);
    this.muzzles = new Pool<Muzzle>(14, () => {
      const group = new Group();
      const core = new Mesh(
        flashCore,
        new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
      );
      const flare = new Mesh(
        flashFlare,
        new MeshBasicMaterial({
          map: sparkMap,
          color: 0xffffff,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          side: DoubleSide,
        }),
      );
      group.add(core, flare);
      const light = new PointLight(0xffffff, 0, 7, 2);
      group.add(light);
      this.root.add(group);
      return { object: group, life: 0, maxLife: 0.055, active: false, core, flare, light };
    });

    // -- shells ----------------------------------------------------------
    const shellGeo = new CylinderGeometry(0.006, 0.006, 0.024, 5);
    this.shells = new Pool<Shell>(this.quality === 'low' ? 0 : Math.round(40 * budget), () => {
      const mesh = new Mesh(shellGeo, new MeshBasicMaterial({ color: 0xd8b25a, toneMapped: false }));
      this.root.add(mesh);
      return { object: mesh, life: 0, maxLife: 1.6, active: false, vel: new Vector3(), spin: new Vector3() };
    });

    // -- decals ----------------------------------------------------------
    const decalGeo = new PlaneGeometry(1, 1);
    const decalMap = decalTexture();
    this.decals = new Pool<Decal>(Math.max(0, Math.round(this.decalLimit)), () => {
      const mesh = new Mesh(
        decalGeo,
        new MeshBasicMaterial({
          map: decalMap,
          transparent: true,
          depthWrite: false,
          opacity: 0.9,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      );
      this.root.add(mesh);
      return { object: mesh, life: 0, maxLife: 22, active: false };
    });

    // -- explosions ------------------------------------------------------
    const blastShell = new SphereGeometry(1, 10, 6);
    const ringGeo = new PlaneGeometry(1, 1);
    const ringMap = ringTexture();
    this.blasts = new Pool<Blast>(8, () => {
      const group = new Group();
      const shell = new Mesh(
        blastShell,
        new MeshBasicMaterial({ color: 0xffd08a, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
      );
      const ring = new Mesh(
        ringGeo,
        new MeshBasicMaterial({
          map: ringMap,
          color: 0xffe0b0,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          side: DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      const light = new PointLight(0xffb060, 0, 18, 2);
      group.add(shell, ring, light);
      this.root.add(group);
      return { object: group, life: 0, maxLife: 0.55, active: false, shell, ring, light };
    });

    // -- generic particle bursts (deaths, ability effects) ---------------
    const burstCount = this.quality === 'low' ? 10 : this.quality === 'medium' ? 20 : 34;
    this.bursts = new Pool<Burst>(Math.round(18 * budget), () => {
      const positions = new Float32Array(burstCount * 3);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(positions, 3));
      const points = new Points(
        geo,
        new PointsMaterial({
          size: 0.12,
          map: sparkMap,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
          toneMapped: false,
        }),
      );
      points.frustumCulled = false;
      this.root.add(points);
      return {
        object: points,
        life: 0,
        maxLife: 0.9,
        active: false,
        velocities: new Float32Array(burstCount * 3),
        basePositions: positions,
        gravity: 6,
      };
    });

    // -- beams (rail shots, scan pulses) --------------------------------
    const beamGeo = new CylinderGeometry(1, 1, 1, 6, 1, true);
    beamGeo.translate(0, 0.5, 0);
    beamGeo.rotateX(Math.PI / 2);
    this.beams = new Pool<Beam>(10, () => {
      const mesh = new Mesh(
        beamGeo,
        new MeshBasicMaterial({ color: 0xcfe9ff, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
      );
      mesh.frustumCulled = false;
      this.root.add(mesh);
      return { object: mesh, life: 0, maxLife: 0.22, active: false, from: new Vector3(), to: new Vector3() };
    });
  }

  // -----------------------------------------------------------------------
  // Spawners
  // -----------------------------------------------------------------------

  tracer(from: Vector3, to: Vector3, color: number, width: number, kind: 'beam' | 'bolt' | 'streak' | 'none'): void {
    if (kind === 'none') return;
    if (kind === 'beam') {
      this.beam(from, to, color, width * 1.6, 0.24);
      return;
    }
    const t = this.tracers.acquire();
    t.life = 0;
    t.maxLife = kind === 'bolt' ? 0.09 : 0.055;
    t.from.copy(from);
    t.to.copy(to);
    t.width = width;
    const mat = t.object.material as MeshBasicMaterial;
    mat.color.setHex(color);
    mat.opacity = 0.95;
    this.orient(t.object, from, to, width);
  }

  beam(from: Vector3, to: Vector3, color: number, width: number, life: number): void {
    const b = this.beams.acquire();
    b.life = 0;
    b.maxLife = life;
    b.from.copy(from);
    b.to.copy(to);
    (b.object.material as MeshBasicMaterial).color.setHex(color);
    (b.object.material as MeshBasicMaterial).opacity = 1;
    this.orient(b.object, from, to, width);
  }

  private orient(mesh: Mesh, from: Vector3, to: Vector3, width: number): void {
    tmpV.subVectors(to, from);
    const len = tmpV.length();
    if (len < 1e-4) {
      mesh.visible = false;
      return;
    }
    mesh.position.copy(from);
    tmpV.normalize();
    tmpQ.setFromUnitVectors(new Vector3(0, 0, 1), tmpV);
    mesh.quaternion.copy(tmpQ);
    mesh.scale.set(width, width, len);
  }

  impact(position: Vector3, normal: Vector3, color: number, surface: string): void {
    const i = this.impacts.acquire();
    i.life = 0;
    i.maxLife = surface === 'flesh' ? 0.18 : 0.26;
    i.object.position.copy(position).addScaledVector(normal, 0.02);
    i.sprite.scale.setScalar(surface === 'flesh' ? 0.22 : 0.34);
    (i.sprite.material as MeshBasicMaterial).color.setHex(color);
    (i.sprite.material as MeshBasicMaterial).opacity = 1;
    (i.points.material as PointsMaterial).color.setHex(color);
    (i.points.material as PointsMaterial).opacity = 1;

    // Scatter sparks into the hemisphere around the surface normal.
    const pos = i.basePositions;
    const vel = i.velocities;
    const count = pos.length / 3;
    for (let p = 0; p < count; p++) {
      const o = p * 3;
      pos[o] = 0;
      pos[o + 1] = 0;
      pos[o + 2] = 0;
      tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      tmpV.addScaledVector(normal, 1.2).normalize();
      const speed = 1.8 + Math.random() * 3.4;
      vel[o] = tmpV.x * speed;
      vel[o + 1] = tmpV.y * speed;
      vel[o + 2] = tmpV.z * speed;
    }
    (i.points.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    if (i.light) {
      i.light.color.setHex(color);
      i.light.intensity = store.bool('flashReduction') ? 1.2 : 3;
    }

    if (surface !== 'flesh' && surface !== 'air') this.decal(position, normal);
  }

  private decal(position: Vector3, normal: Vector3): void {
    if (this.decals.size === 0) return;
    const d = this.decals.acquire();
    d.life = 0;
    d.maxLife = 22;
    d.object.position.copy(position).addScaledVector(normal, 0.012);
    // Align the quad to the surface and give it a random roll so repeated hits
    // on one wall do not look like a stamped pattern.
    tmpQ.setFromUnitVectors(new Vector3(0, 0, 1), normal);
    d.object.quaternion.copy(tmpQ);
    d.object.rotateZ(Math.random() * Math.PI * 2);
    const s = 0.16 + Math.random() * 0.1;
    d.object.scale.set(s, s, s);
    (d.object.material as MeshBasicMaterial).opacity = 0.9;
  }

  muzzleFlash(position: Vector3, direction: Vector3, color: number, scale: number): void {
    const m = this.muzzles.acquire();
    m.life = 0;
    m.maxLife = 0.055;
    m.object.position.copy(position);
    const reduce = store.bool('flashReduction') ? 0.45 : 1;
    m.core.scale.setScalar(0.055 * scale * reduce);
    m.flare.scale.setScalar(0.4 * scale * reduce);
    m.flare.lookAt(tmpV.copy(position).sub(direction));
    (m.core.material as MeshBasicMaterial).color.setHex(0xffffff);
    (m.core.material as MeshBasicMaterial).opacity = 1;
    (m.flare.material as MeshBasicMaterial).color.setHex(color);
    (m.flare.material as MeshBasicMaterial).opacity = 0.9;
    m.light.color.setHex(color);
    m.light.intensity = 6 * scale * reduce;
  }

  ejectShell(position: Vector3, right: Vector3, up: Vector3, color: number): void {
    if (this.shells.size === 0) return;
    const s = this.shells.acquire();
    s.life = 0;
    s.maxLife = 1.6;
    s.object.position.copy(position);
    (s.object.material as MeshBasicMaterial).color.setHex(color);
    s.vel
      .copy(right)
      .multiplyScalar(1.6 + Math.random() * 1.2)
      .addScaledVector(up, 1.4 + Math.random() * 0.8);
    s.spin.set(Math.random() * 24 - 12, Math.random() * 24 - 12, Math.random() * 24 - 12);
  }

  explosion(position: Vector3, radius: number, color = 0xffb060): void {
    const b = this.blasts.acquire();
    b.life = 0;
    b.maxLife = 0.55;
    b.object.position.copy(position);
    b.shell.scale.setScalar(radius * 0.25);
    b.ring.scale.setScalar(radius * 0.4);
    (b.shell.material as MeshBasicMaterial).color.setHex(color);
    (b.shell.material as MeshBasicMaterial).opacity = 1;
    (b.ring.material as MeshBasicMaterial).opacity = 1;
    b.light.color.setHex(color);
    b.light.intensity = store.bool('flashReduction') ? 6 : 16;
    b.light.distance = radius * 4;
    this.burst(position, radius * 3.2, color, 1.1, 9);
  }

  /** Generic particle burst. `spread` is the initial speed. */
  burst(position: Vector3, spread: number, color: number, life = 0.9, gravity = 6): void {
    const b = this.bursts.acquire();
    b.life = 0;
    b.maxLife = life;
    b.gravity = gravity;
    b.object.position.copy(position);
    (b.object.material as PointsMaterial).color.setHex(color);
    (b.object.material as PointsMaterial).opacity = 1;
    const pos = b.basePositions;
    const vel = b.velocities;
    const count = pos.length / 3;
    for (let p = 0; p < count; p++) {
      const o = p * 3;
      pos[o] = 0;
      pos[o + 1] = 0;
      pos[o + 2] = 0;
      tmpV.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize();
      const speed = spread * (0.4 + Math.random() * 0.6);
      vel[o] = tmpV.x * speed;
      vel[o + 1] = tmpV.y * speed;
      vel[o + 2] = tmpV.z * speed;
    }
    (b.object.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  }

  /** Death effect chosen by the victim's equipped kill effect cosmetic. */
  deathEffect(position: Vector3, effect: string, color: number): void {
    switch (effect) {
      case 'shards':
        this.burst(position, 7, color, 1.1, 9);
        this.burst(position, 3.5, 0xffffff, 0.7, 5);
        break;
      case 'ember':
        this.burst(position, 5, 0xff7a3c, 1.4, 3);
        this.burst(position, 2.5, 0xffd08a, 1.0, 2);
        break;
      case 'collapse':
        this.beam(tmpV.copy(position).setY(position.y - 1), tmpV2.copy(position).setY(position.y + 3.4), color, 0.28, 0.35);
        this.burst(position, 2.2, color, 0.6, -4);
        break;
      case 'apex':
        this.explosion(position, 1.4, 0xffb03a);
        this.burst(position, 6, 0xffd76b, 1.2, 5);
        break;
      default:
        this.burst(position, 4.5, color, 0.9, 7);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  update(dt: number): void {
    // Tracers: shrink towards the impact point so they read as travelling.
    for (const t of this.tracers.items) {
      if (!t.active) continue;
      t.life += dt;
      const k = t.life / t.maxLife;
      if (k >= 1) {
        this.tracers.release(t);
        continue;
      }
      const mat = t.object.material as MeshBasicMaterial;
      mat.opacity = 0.95 * (1 - k);
      const head = tmpV.lerpVectors(t.from, t.to, Math.min(1, k * 2.4));
      const tail = tmpV2.lerpVectors(t.from, t.to, Math.max(0, k * 2.4 - 0.45));
      this.orient(t.object, tail, head, t.width * (1 - k * 0.4));
    }

    for (const b of this.beams.items) {
      if (!b.active) continue;
      b.life += dt;
      const k = b.life / b.maxLife;
      if (k >= 1) {
        this.beams.release(b);
        continue;
      }
      const mat = b.object.material as MeshBasicMaterial;
      mat.opacity = 1 - k * k;
      b.object.scale.x = b.object.scale.y = Math.max(0.001, b.object.scale.x * (1 - dt * 3));
    }

    for (const i of this.impacts.items) {
      if (!i.active) continue;
      i.life += dt;
      const k = i.life / i.maxLife;
      if (k >= 1) {
        this.impacts.release(i);
        if (i.light) i.light.intensity = 0;
        continue;
      }
      (i.sprite.material as MeshBasicMaterial).opacity = 1 - k;
      i.sprite.scale.multiplyScalar(1 + dt * 4);
      const attr = i.points.geometry.attributes.position as BufferAttribute;
      const pos = i.basePositions;
      const vel = i.velocities;
      for (let p = 0; p < pos.length; p += 3) {
        vel[p + 1] -= 14 * dt;
        pos[p] += vel[p] * dt;
        pos[p + 1] += vel[p + 1] * dt;
        pos[p + 2] += vel[p + 2] * dt;
      }
      attr.needsUpdate = true;
      (i.points.material as PointsMaterial).opacity = 1 - k;
      if (i.light) i.light.intensity *= 1 - k;
    }

    for (const m of this.muzzles.items) {
      if (!m.active) continue;
      m.life += dt;
      const k = m.life / m.maxLife;
      if (k >= 1) {
        this.muzzles.release(m);
        m.light.intensity = 0;
        continue;
      }
      (m.core.material as MeshBasicMaterial).opacity = 1 - k;
      (m.flare.material as MeshBasicMaterial).opacity = 0.9 * (1 - k);
      m.flare.scale.multiplyScalar(1 + dt * 9);
      m.light.intensity *= 1 - k * 1.4;
    }

    for (const s of this.shells.items) {
      if (!s.active) continue;
      s.life += dt;
      if (s.life >= s.maxLife) {
        this.shells.release(s);
        continue;
      }
      s.vel.y -= 22 * dt;
      s.object.position.addScaledVector(s.vel, dt);
      s.object.rotation.x += s.spin.x * dt;
      s.object.rotation.y += s.spin.y * dt;
      s.object.rotation.z += s.spin.z * dt;
    }

    for (const d of this.decals.items) {
      if (!d.active) continue;
      d.life += dt;
      if (d.life >= d.maxLife) {
        this.decals.release(d);
        continue;
      }
      // Fade only over the last two seconds so walls stay marked during a fight.
      const remaining = d.maxLife - d.life;
      if (remaining < 2) (d.object.material as MeshBasicMaterial).opacity = 0.9 * (remaining / 2);
    }

    for (const b of this.blasts.items) {
      if (!b.active) continue;
      b.life += dt;
      const k = b.life / b.maxLife;
      if (k >= 1) {
        this.blasts.release(b);
        b.light.intensity = 0;
        continue;
      }
      b.shell.scale.multiplyScalar(1 + dt * 5.5);
      b.ring.scale.multiplyScalar(1 + dt * 9);
      (b.shell.material as MeshBasicMaterial).opacity = 1 - k;
      (b.ring.material as MeshBasicMaterial).opacity = (1 - k) * 0.8;
      b.light.intensity *= 1 - k * 1.6;
    }

    for (const b of this.bursts.items) {
      if (!b.active) continue;
      b.life += dt;
      const k = b.life / b.maxLife;
      if (k >= 1) {
        this.bursts.release(b);
        continue;
      }
      const attr = b.object.geometry.attributes.position as BufferAttribute;
      const pos = b.basePositions;
      const vel = b.velocities;
      for (let p = 0; p < pos.length; p += 3) {
        vel[p + 1] -= b.gravity * dt;
        pos[p] += vel[p] * dt;
        pos[p + 1] += vel[p + 1] * dt;
        pos[p + 2] += vel[p + 2] * dt;
      }
      attr.needsUpdate = true;
      (b.object.material as PointsMaterial).opacity = 1 - k * k;
    }
  }

  /** Camera-facing sprites need the camera each frame. */
  faceCamera(cameraPosition: Vector3): void {
    for (const i of this.impacts.items) {
      if (i.active) i.sprite.lookAt(cameraPosition);
    }
  }

  stats(): FxStats {
    let particles = 0;
    for (const i of this.impacts.items) if (i.active) particles += i.basePositions.length / 3;
    for (const b of this.bursts.items) if (b.active) particles += b.basePositions.length / 3;
    return {
      tracers: this.tracers.liveCount,
      impacts: this.impacts.liveCount,
      decals: this.decals.liveCount,
      particles,
    };
  }

  clearTransient(): void {
    for (const pool of [this.tracers, this.impacts, this.muzzles, this.shells, this.blasts, this.bursts, this.beams]) {
      for (const item of pool.items) {
        item.active = false;
        item.object.visible = false;
      }
    }
  }

  clearAll(): void {
    this.clearTransient();
    for (const d of this.decals.items) {
      d.active = false;
      d.object.visible = false;
    }
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh || (child as Points).isPoints) {
        mesh.geometry?.dispose();
        const m = mesh.material as MeshBasicMaterial;
        m?.dispose();
      }
    });
  }
}

export { clamp, Color };
