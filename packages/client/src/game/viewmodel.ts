/**
 * First-person view model.
 *
 * Arms + weapon live in a separate scene rendered with a cleared depth buffer,
 * so the weapon can never clip through level geometry no matter how close the
 * player stands to a wall.
 *
 * The pose is a stack of additive offsets on top of the weapon's authored rest
 * pose, each solving one problem:
 *   sway        - mouse movement lags the weapon behind the camera (weight)
 *   bob         - walk cycle, disabled by the head-bob accessibility setting
 *   recoil      - per-shot kick back + up + roll, spring-damped return
 *   ads         - blend to the authored ADS pose
 *   equip       - draw/holster animation driven by the weapon's own timings
 *   reload      - a real 3-phase animation (drop, insert, seat) per weapon class
 *   land/jump   - vertical impulse on landing
 *   inspect     - idle flourish after several seconds of no input
 */

import { Euler, Group, MathUtils, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { clamp, damp, type WeaponDef } from '@kang/shared';
import { store } from '../state/store.js';
import { assets } from '../engine/assets.js';

const tmpV = new Vector3();
const tmpQ = new Quaternion();
const tmpEuler = new Euler();

export type ReloadStyle = 'mag' | 'pump' | 'cylinder' | 'belt' | 'tube' | 'none';

function reloadStyleFor(weapon: WeaponDef): ReloadStyle {
  switch (weapon.category) {
    case 'shotgun':
      return 'pump';
    case 'revolver':
      return 'cylinder';
    case 'lmg':
      return 'belt';
    case 'launcher':
      return 'tube';
    case 'melee':
      return 'none';
    default:
      return 'mag';
  }
}

export class ViewModel {
  readonly root = new Group();
  private armsRoot = new Group();
  private weaponRoot = new Group();
  private arms: Group | null = null;
  private weaponMesh: Group | null = null;
  private weapon: WeaponDef | null = null;
  private reloadStyle: ReloadStyle = 'mag';

  /** Authored rest / ADS poses from the weapon data. */
  private restPos = new Vector3();
  private restRot = new Vector3();
  private adsPos = new Vector3();
  private adsRot = new Vector3();
  private muzzleLocal = new Vector3();
  private ejectLocal = new Vector3();

  // -- animation state ---------------------------------------------------
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private bobAmount = 0;
  private recoilPos = 0;
  private recoilPitch = 0;
  private recoilRoll = 0;
  private recoilVelPos = 0;
  private recoilVelPitch = 0;
  private adsBlend = 0;
  private equipTimer = 0;
  private equipDuration = 0.4;
  private holsterTimer = 0;
  private reloadTimer = 0;
  private reloadDuration = 0;
  private landImpulse = 0;
  private idleTime = 0;
  private inspectPhase = -1;
  private lastFireAt = -999;
  private meleeSwing = 0;

  constructor(private scene: Scene) {
    this.root.add(this.armsRoot);
    this.root.add(this.weaponRoot);
    scene.add(this.root);
  }

  /** Swap in a weapon; plays the equip animation. */
  setWeapon(weapon: WeaponDef, skinTint?: number): void {
    this.weapon = weapon;
    this.reloadStyle = reloadStyleFor(weapon);

    if (this.weaponMesh) {
      this.weaponRoot.remove(this.weaponMesh);
      this.weaponMesh = null;
    }
    const mesh = assets.instantiate(`wpn_${weapon.id}`);
    // The generators author weapons pointing down -Z at the grip origin, which
    // is exactly the view-model convention, so no correction is needed.
    this.weaponRoot.add(mesh);
    this.weaponMesh = mesh;

    if (skinTint !== undefined) this.applyTint(mesh, skinTint);

    if (!this.arms) {
      this.arms = assets.instantiate('char_arms_fp');
      this.armsRoot.add(this.arms);
    }

    const vm = weapon.viewModel;
    this.restPos.set(vm.pos[0], vm.pos[1], vm.pos[2]);
    this.restRot.set(vm.rot[0], vm.rot[1], vm.rot[2]);
    this.adsPos.set(vm.adsPos[0], vm.adsPos[1], vm.adsPos[2]);
    this.adsRot.set(vm.adsRot[0], vm.adsRot[1], vm.adsRot[2]);

    // Prefer the socket baked into the model; fall back to the data table.
    this.muzzleLocal.copy(
      assets.socketOf(`wpn_${weapon.id}`, 'muzzle', new Vector3(vm.muzzle[0], vm.muzzle[1], vm.muzzle[2])),
    );
    this.ejectLocal.copy(
      assets.socketOf(`wpn_${weapon.id}`, 'eject', new Vector3(vm.eject[0], vm.eject[1], vm.eject[2])),
    );

    this.equipDuration = Math.max(0.12, weapon.equipTime);
    this.equipTimer = this.equipDuration;
    this.reloadTimer = 0;
    this.recoilPos = 0;
    this.recoilPitch = 0;
    this.recoilRoll = 0;
    this.idleTime = 0;
    this.inspectPhase = -1;
  }

  private applyTint(root: Object3D, color: number): void {
    root.traverse((child) => {
      const mesh = child as { isMesh?: boolean; material?: { color?: { setHex(v: number): void }; emissive?: { setHex(v: number): void } } };
      if (!mesh.isMesh || !mesh.material) return;
      // Only the emissive channel is tinted: recolouring the body would make
      // the weapon silhouette unreadable, which is a competitive problem.
      mesh.material.emissive?.setHex(color);
    });
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Begin a holster; call setWeapon when it finishes. */
  holster(duration: number): void {
    this.holsterTimer = Math.max(0.08, duration);
  }

  startReload(duration: number): void {
    this.reloadDuration = Math.max(0.2, duration);
    this.reloadTimer = this.reloadDuration;
  }

  cancelReload(): void {
    this.reloadTimer = 0;
  }

  /** Called on every shot: adds recoil and returns the world muzzle position. */
  fire(nowSec: number): void {
    if (!this.weapon) return;
    const r = this.weapon.recoil;
    const scale = 1 - this.adsBlend * 0.35;
    this.recoilVelPos += r.viewKick * 34 * scale;
    this.recoilVelPitch += r.up * 26 * scale;
    this.recoilRoll += (Math.random() - 0.5) * r.viewRoll * 2.2 * scale;
    this.lastFireAt = nowSec;
    this.idleTime = 0;
    this.inspectPhase = -1;
    this.reloadTimer = 0;
  }

  meleeAttack(): void {
    this.meleeSwing = 1;
    this.idleTime = 0;
  }

  land(impactSpeed: number): void {
    this.landImpulse = clamp(impactSpeed / 26, 0, 1) * 0.05;
  }

  /** World-space muzzle position for FX. */
  muzzleWorld(out: Vector3): Vector3 {
    if (!this.weaponMesh) return out.set(0, 0, 0);
    this.weaponRoot.updateMatrixWorld(true);
    return out.copy(this.muzzleLocal).applyMatrix4(this.weaponRoot.matrixWorld);
  }

  ejectWorld(out: Vector3): Vector3 {
    if (!this.weaponMesh) return out.set(0, 0, 0);
    this.weaponRoot.updateMatrixWorld(true);
    return out.copy(this.ejectLocal).applyMatrix4(this.weaponRoot.matrixWorld);
  }

  get isReloading(): boolean {
    return this.reloadTimer > 0;
  }

  get adsAmount(): number {
    return this.adsBlend;
  }

  // -----------------------------------------------------------------------

  update(
    dt: number,
    opts: {
      aiming: boolean;
      speed: number;
      maxSpeed: number;
      onGround: boolean;
      sliding: boolean;
      lookDeltaX: number;
      lookDeltaY: number;
      nowSec: number;
      alive: boolean;
    },
  ): void {
    if (!this.weapon) return;
    const w = this.weapon;
    const reduceMotion = store.bool('reducedMotion');
    const headBob = store.bool('headBob') && !reduceMotion;

    // -- ADS blend -------------------------------------------------------
    const adsTarget = opts.aiming && w.slot !== 'melee' && this.reloadTimer <= 0 ? 1 : 0;
    const adsRate = dt / Math.max(0.05, w.adsTime);
    this.adsBlend = clamp(this.adsBlend + (adsTarget ? adsRate : -adsRate * 1.5), 0, 1);

    // -- sway ------------------------------------------------------------
    // Mouse movement drags the weapon; sniper sway is halved by the Spectre
    // passive, which the caller folds into lookDelta before we see it.
    const swayScale = (1 - this.adsBlend * 0.7) * (reduceMotion ? 0.35 : 1);
    this.swayX = damp(this.swayX, clamp(-opts.lookDeltaX * 2.2, -0.055, 0.055) * swayScale, 9, dt);
    this.swayY = damp(this.swayY, clamp(-opts.lookDeltaY * 2.2, -0.045, 0.045) * swayScale, 9, dt);

    // -- bob -------------------------------------------------------------
    const speedRatio = clamp(opts.speed / Math.max(1, opts.maxSpeed), 0, 1.4);
    const bobTarget = opts.onGround && opts.alive ? speedRatio * (headBob ? 1 : 0.25) : 0;
    this.bobAmount = damp(this.bobAmount, bobTarget, 6, dt);
    this.bobPhase += dt * (7.5 + speedRatio * 6);

    // -- recoil spring ---------------------------------------------------
    // Critically damped: the weapon settles without oscillating, which is what
    // makes a spray pattern learnable.
    const r = w.recoil;
    const stiffness = 120 + r.recoverRate * 12;
    const damping = 2 * Math.sqrt(stiffness) * 0.9;
    this.recoilVelPos += (-stiffness * this.recoilPos - damping * this.recoilVelPos) * dt;
    this.recoilPos += this.recoilVelPos * dt;
    this.recoilVelPitch += (-stiffness * this.recoilPitch - damping * this.recoilVelPitch) * dt;
    this.recoilPitch += this.recoilVelPitch * dt;
    this.recoilRoll = damp(this.recoilRoll, 0, r.recoverRate, dt);

    // -- landing / melee -------------------------------------------------
    this.landImpulse = damp(this.landImpulse, 0, 11, dt);
    this.meleeSwing = Math.max(0, this.meleeSwing - dt / Math.max(0.12, w.meleeSwingTime || 0.3));

    // -- equip / holster -------------------------------------------------
    if (this.equipTimer > 0) this.equipTimer = Math.max(0, this.equipTimer - dt);
    if (this.holsterTimer > 0) this.holsterTimer = Math.max(0, this.holsterTimer - dt);
    if (this.reloadTimer > 0) this.reloadTimer = Math.max(0, this.reloadTimer - dt);

    // -- idle inspect ----------------------------------------------------
    const idle = opts.speed < 0.4 && !opts.aiming && this.reloadTimer <= 0 && this.equipTimer <= 0;
    this.idleTime = idle ? this.idleTime + dt : 0;
    if (this.idleTime > 7 && this.inspectPhase < 0 && !reduceMotion) this.inspectPhase = 0;
    if (this.inspectPhase >= 0) {
      this.inspectPhase += dt / 1.6;
      if (this.inspectPhase >= 1) {
        this.inspectPhase = -1;
        this.idleTime = 0;
      }
    }

    // -- compose the pose ------------------------------------------------
    const pos = tmpV.copy(this.restPos).lerp(this.adsPos, this.adsBlend);
    const rotX = MathUtils.lerp(this.restRot.x, this.adsRot.x, this.adsBlend);
    const rotY = MathUtils.lerp(this.restRot.y, this.adsRot.y, this.adsBlend);
    const rotZ = MathUtils.lerp(this.restRot.z, this.adsRot.z, this.adsBlend);

    // Sway.
    pos.x += this.swayX;
    pos.y += this.swayY;

    // Bob: a figure-eight so the weapon does not just slide up and down.
    const bobX = Math.sin(this.bobPhase) * 0.012 * this.bobAmount;
    const bobY = Math.abs(Math.sin(this.bobPhase * 2)) * -0.010 * this.bobAmount;
    pos.x += bobX;
    pos.y += bobY;

    // Slide drops the weapon and rolls it.
    const slideDrop = opts.sliding ? 0.05 : 0;

    // Recoil pushes back along +Z (towards the camera) and pitches up.
    pos.z += this.recoilPos;
    pos.y += this.landImpulse * -1 + slideDrop * -1;

    // Equip: swing up from below.
    let equipOffset = 0;
    let equipRot = 0;
    if (this.equipTimer > 0) {
      const k = this.equipTimer / this.equipDuration; // 1 -> 0
      const eased = k * k;
      equipOffset = -0.28 * eased;
      equipRot = 0.9 * eased;
    }
    if (this.holsterTimer > 0) {
      const k = 1 - this.holsterTimer / Math.max(0.08, this.holsterTimer + dt);
      equipOffset -= 0.3 * (1 - k);
      equipRot += 0.8 * (1 - k);
    }
    pos.y += equipOffset;

    // Reload: three phases, shaped by the weapon family.
    let reloadPosY = 0;
    let reloadPosX = 0;
    let reloadRotX = 0;
    let reloadRotZ = 0;
    if (this.reloadTimer > 0) {
      const t = 1 - this.reloadTimer / this.reloadDuration; // 0 -> 1
      const phase = t < 0.3 ? 0 : t < 0.72 ? 1 : 2;
      const local = phase === 0 ? t / 0.3 : phase === 1 ? (t - 0.3) / 0.42 : (t - 0.72) / 0.28;
      switch (this.reloadStyle) {
        case 'mag':
          // Tilt in, drop the magazine, slap a new one, snap back.
          reloadPosY = -0.075 * Math.sin(t * Math.PI);
          reloadRotZ = 0.5 * Math.sin(t * Math.PI);
          reloadRotX = -0.22 * Math.sin(t * Math.PI);
          if (phase === 1) reloadPosX = 0.02 * Math.sin(local * Math.PI * 3);
          break;
        case 'pump':
          // Pump the fore-end once per shell.
          reloadPosY = -0.04 * Math.sin(t * Math.PI);
          reloadPosX = 0.015 * Math.sin(t * Math.PI * 6);
          reloadRotX = -0.12 * Math.abs(Math.sin(t * Math.PI * 6));
          break;
        case 'cylinder':
          // Swing the cylinder out, load, flick it shut.
          reloadRotZ = 0.9 * Math.sin(t * Math.PI);
          reloadPosY = -0.06 * Math.sin(t * Math.PI);
          if (phase === 2) reloadRotZ *= 1 - local;
          break;
        case 'belt':
          // Lift the feed cover, lay the belt, drop the cover.
          reloadPosY = -0.1 * Math.sin(t * Math.PI);
          reloadRotX = -0.35 * Math.sin(t * Math.PI);
          reloadPosX = 0.03 * Math.sin(t * Math.PI * 2);
          break;
        case 'tube':
          reloadPosY = -0.09 * Math.sin(t * Math.PI);
          reloadRotZ = -0.4 * Math.sin(t * Math.PI);
          reloadPosX = -0.04 * Math.sin(t * Math.PI);
          break;
        default:
          break;
      }
    }
    pos.x += reloadPosX;
    pos.y += reloadPosY;

    // Inspect flourish: rotate the weapon to look at it.
    let inspectRotY = 0;
    let inspectRotZ = 0;
    let inspectPosY = 0;
    if (this.inspectPhase >= 0) {
      const s = Math.sin(this.inspectPhase * Math.PI);
      inspectRotY = -0.55 * s;
      inspectRotZ = 0.35 * s;
      inspectPosY = -0.035 * s;
    }
    pos.y += inspectPosY;

    // Melee swing: a sweeping arc.
    let meleeRotZ = 0;
    let meleeRotX = 0;
    let meleePosZ = 0;
    if (this.meleeSwing > 0) {
      const s = Math.sin((1 - this.meleeSwing) * Math.PI);
      meleeRotZ = -1.15 * s;
      meleeRotX = 0.55 * s;
      meleePosZ = -0.18 * s;
    }
    pos.z += meleePosZ;

    // Apply.
    this.root.position.copy(pos);
    tmpEuler.set(
      rotX + this.recoilPitch + reloadRotX + equipRot + meleeRotX,
      rotY + inspectRotY,
      rotZ + this.recoilRoll + reloadRotZ + inspectRotZ + meleeRotZ + (opts.sliding ? 0.12 : 0),
      'XYZ',
    );
    tmpQ.setFromEuler(tmpEuler);
    this.root.quaternion.copy(tmpQ);

    // Arms trail the weapon slightly for a sense of weight.
    this.armsRoot.position.set(0, 0, 0);
    this.armsRoot.rotation.set(0, 0, 0);
    this.armsRoot.position.y += this.recoilPos * 0.4;
  }

  dispose(): void {
    this.scene.remove(this.root);
  }
}
