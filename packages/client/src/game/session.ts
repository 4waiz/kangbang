/**
 * The gameplay session: the frame loop, prediction and reconciliation.
 *
 * Prediction model
 * ----------------
 * The client runs the SAME movement code as the server (`movementStep` from
 * @neon/shared) at a fixed 60Hz. Each step produces an InputCommand that is
 * sent immediately and kept in a pending list. When a snapshot arrives with an
 * `ackSeq`, we:
 *   1. compare our predicted position at that sequence to the authoritative one
 *   2. if the error is small, blend it away over a few frames (no visible snap)
 *   3. if the error is large, hard-set to the server state and replay every
 *      unacknowledged input on top
 *
 * That is the whole trick: because the simulation is shared code, replaying is
 * exact, so step 3 is rare and step 2 is invisible.
 */

import { Euler, Group, MathUtils, Scene, Vector3 } from 'three';
import {
  Btn,
  CLASSES,
  CollisionWorld,
  DEFAULT_MOVE_PARAMS,
  EntFlag,
  EvType,
  POSITION_DESYNC_LIMIT,
  POSITION_TELEPORT_LIMIT,
  PLAYER_HEIGHT,
  TEAM_COLORS,
  TICK_DT,
  WEAPONS,
  WEAPON_ORDER,
  applyPerks,
  clamp,
  copyMoveState,
  createMoveContext,
  createMoveState,
  currentSpread,
  damp,
  eyeHeightFor,
  forwardFromAngles,
  getClass,
  getMap,
  getMode,
  hashSeed,
  lerp,
  movementStep,
  recoilForShot,
  shotInterval,
  wrapAngle,
  type InputCommand,
  type KillFeedEntry,
  type LoadoutSelection,
  type MapDef,
  type MatchStatePayload,
  type MoveContext,
  type MoveState,
  type PlayerPublicState,
  type Snapshot,
  type WeaponDef,
  type WireEvent,
} from '@neon/shared';
import { assets } from '../engine/assets.js';
import { audio } from '../engine/audio.js';
import { FxSystem } from '../engine/fx.js';
import { InputManager } from '../engine/input.js';
import { buildMapMeshes, type MapMeshes } from '../engine/mapRenderer.js';
import { Renderer } from '../engine/renderer.js';
import { surfaceFromIndexClient } from './surfaces.js';
import { ActorSet } from './actors.js';
import { ViewModel } from './viewmodel.js';
import { WorldEntities } from './world.js';
import type { Connection } from '../net/connection.js';
import { store } from '../state/store.js';

export interface HudSnapshot {
  alive: boolean;
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  ammo: number;
  reserve: number;
  weapon: WeaponDef | null;
  slot: number;
  abilityCharge: number;
  ultimateCharge: number;
  abilityName: string;
  ultimateName: string;
  spreadPixels: number;
  respawnIn: number;
  killedBy: string;
  ping: number;
  fps: number;
  speed: number;
  damageDirections: { angle: number; strength: number }[];
  hitMarker: number;
  hitMarkerHeadshot: boolean;
  streak: number;
  modeValue: number;
  protectedUntil: number;
  emp: boolean;
}

interface DamageIndicator {
  angle: number;
  strength: number;
}

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpDir = { x: 0, y: 0, z: 0 };
const tmpEuler = new Euler(0, 0, 0, 'YXZ');

/**
 * The shared simulation uses plain `{x,y,z}` objects, not three.js Vector3s, so
 * that it can run on the server with no renderer dependency. This assigns into
 * one without allocating.
 */
function setVec(v: { x: number; y: number; z: number }, x: number, y: number, z: number): void {
  v.x = x;
  v.y = y;
  v.z = z;
}

export class GameSession {
  // -- scene ------------------------------------------------------------
  private mapMeshes: MapMeshes | null = null;
  private world: CollisionWorld | null = null;
  private mapDef: MapDef | null = null;
  readonly fx: FxSystem;
  readonly entities: WorldEntities;
  readonly actors: ActorSet;
  readonly viewModel: ViewModel;

  // -- local player -----------------------------------------------------
  private move: MoveState = createMoveState();
  private ctx: MoveContext = createMoveContext({ ...DEFAULT_MOVE_PARAMS });
  private selfId = 0;
  private team = 0;
  private loadout: LoadoutSelection | null = null;
  private classId = 'vanguard';
  private weapons: WeaponDef[] = [];
  private slot = 0;
  private pendingSlot = -1;
  private equipTimer = 0;
  private ammo = [0, 0, 0];
  private reserve = [0, 0, 0];
  private reloadTimer = 0;
  private fireCooldown = 0;
  private burstRemaining = 0;
  private burstTimer = 0;
  private bloom = 0;
  private shotIndex = 0;
  private aiming = false;
  private aimToggle = false;
  private crouchToggle = false;
  private alive = false;
  private health = 100;
  private shield = 0;
  private abilityCharge = 1;
  private ultimateCharge = 0;
  private respawnIn = 0;
  private killedBy = '';
  private streak = 0;
  private modeValue = 0;
  private empUntil = 0;
  private protectedUntil = 0;

  // -- camera -----------------------------------------------------------
  private camYaw = 0;
  private camPitch = 0;
  /** Recoil applied to the camera, recovered towards zero. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilRecoverPitch = 0;
  private recoilRecoverYaw = 0;
  private shakeAmount = 0;
  private shakeTime = 0;
  private fovCurrent = 96;
  private eyeHeightCurrent = 1.62;
  private lastLookDx = 0;
  private lastLookDy = 0;

  // -- reconciliation ---------------------------------------------------
  private predictionHistory = new Map<number, { x: number; y: number; z: number }>();
  private correction = new Vector3();
  private hardCorrections = 0;
  private softCorrections = 0;

  // -- timing -----------------------------------------------------------
  private accumulator = 0;
  private lastFrameAt = 0;
  private running = false;
  private rafHandle = 0;
  private timeSec = 0;
  private lastFootstepAt = 0;
  private nextFrameBudget = 0;

  // -- hud state --------------------------------------------------------
  private damageIndicators: DamageIndicator[] = [];
  private hitMarkerUntil = 0;
  private hitMarkerHeadshot = false;
  private roster = new Map<number, PlayerPublicState>();
  private matchState: MatchStatePayload | null = null;
  private mode = getMode('tdm');

  onHud: (hud: HudSnapshot) => void = () => undefined;
  onKill: (entry: KillFeedEntry) => void = () => undefined;
  onDeath: (killedBy: string) => void = () => undefined;
  onSpawn: () => void = () => undefined;

  constructor(
    private renderer: Renderer,
    private input: InputManager,
    private connection: Connection,
  ) {
    this.fx = new FxSystem(renderer.scene);
    this.entities = new WorldEntities(renderer.scene);
    this.actors = new ActorSet(renderer.scene);
    this.viewModel = new ViewModel(renderer.viewScene);
  }

  // ---------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------

  loadMap(mapId: string): void {
    if (this.mapDef?.id === mapId && this.mapMeshes) return;
    if (this.mapMeshes) {
      this.renderer.scene.remove(this.mapMeshes.root);
      this.mapMeshes.dispose();
      this.mapMeshes = null;
    }
    const def = getMap(mapId);
    this.mapDef = def;
    this.world = new CollisionWorld(def);
    this.mapMeshes = buildMapMeshes(def);
    this.renderer.scene.add(this.mapMeshes.root);
    this.renderer.applyAmbience(def.ambience);
    this.entities.build(def);
    this.fx.clearAll();
    audio.startAmbience(def.ambience.ambientLoop);
  }

  setSelf(entityId: number): void {
    this.selfId = entityId;
  }

  setLoadout(loadout: LoadoutSelection): void {
    this.loadout = loadout;
    this.classId = loadout.classId;
    const cls = getClass(loadout.classId);
    this.ctx.params = { ...cls.move };
    const perks = loadout.perks ?? [];
    this.weapons = [
      applyPerks(WEAPONS[loadout.primary] ?? WEAPONS.pulse_ar, perks),
      applyPerks(WEAPONS[loadout.secondary] ?? WEAPONS.energy_pistol, perks),
      applyPerks(WEAPONS[loadout.melee] ?? WEAPONS.plasma_blade, perks),
    ];
    for (let i = 0; i < 3; i++) {
      this.ammo[i] = this.weapons[i].magazine;
      this.reserve[i] = this.weapons[i].reserve;
    }
    this.slot = 0;
    this.equipWeapon(0, true);
  }

  setMode(modeId: string): void {
    this.mode = getMode(modeId === 'custom' ? 'custom' : modeId);
  }

  setRoster(players: PlayerPublicState[]): void {
    this.roster.clear();
    for (const p of players) {
      this.roster.set(p.id, p);
      if (p.id === this.selfId) {
        this.team = p.team;
        this.streak = p.streak;
        this.modeValue = p.modeValue;
        if (p.classId && p.classId !== this.classId && this.loadout) {
          // The server may have corrected our class (mode restriction).
          this.classId = p.classId;
        }
      }
    }
  }

  setMatchState(state: MatchStatePayload): void {
    this.matchState = state;
    this.entities.syncObjectives(state.objectives, this.team);
  }

  // ---------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameAt = performance.now();
    this.accumulator = 0;
    const frame = () => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(frame);
      this.frame();
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    audio.stopAmbience();
  }

  private frame(): void {
    const now = performance.now();
    let delta = (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    // Clamp so an alt-tab does not produce a 30-second physics step.
    if (delta > 0.25) delta = 0.25;
    this.timeSec += delta;

    // Optional FPS cap for players who prefer a stable frame time to a high one.
    const limit = store.bool('vsync') ? 0 : store.num('fpsLimit');
    if (limit > 0 && limit < 300) {
      this.nextFrameBudget -= delta;
      if (this.nextFrameBudget > 0) {
        this.input.endFrame();
        return;
      }
      this.nextFrameBudget += 1 / limit;
    }

    // -- fixed-step simulation ------------------------------------------
    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 5) {
      this.accumulator -= TICK_DT;
      steps++;
      this.simulate(TICK_DT);
    }
    // If we could not keep up, drop the backlog rather than compounding it.
    if (this.accumulator > TICK_DT * 5) this.accumulator = 0;

    this.updateCamera(delta);
    this.updatePresentation(delta);
    this.renderer.render();
    this.emitHud();
    this.input.endFrame();
  }

  // ---------------------------------------------------------------------
  // Simulation step
  // ---------------------------------------------------------------------

  private simulate(dt: number): void {
    if (!this.world) return;

    // -- read input ------------------------------------------------------
    const look = this.input.consumeLook(this.lookScale());
    this.lastLookDx = look.yaw;
    this.lastLookDy = look.pitch;
    this.camYaw = wrapAngle(this.camYaw + look.yaw);
    this.camPitch = clamp(this.camPitch + look.pitch, -1.54, 1.54);

    const wheel = this.input.consumeWheel();
    if (wheel !== 0) this.cycleWeapon(wheel > 0 ? 1 : -1);
    if (this.input.wasPressed('slot1')) this.requestSlot(0);
    if (this.input.wasPressed('slot2')) this.requestSlot(1);
    if (this.input.wasPressed('slot3')) this.requestSlot(2);
    if (this.input.wasPressed('lastWeapon')) this.requestSlot(this.slot === 0 ? 1 : 0);
    if (this.input.wasPressed('nextWeapon')) this.cycleWeapon(1);
    if (this.input.wasPressed('prevWeapon')) this.cycleWeapon(-1);

    // Hold vs toggle for aim and crouch.
    const aimHeld = this.input.isDown('aim');
    if (store.str('holdToAim') === 'toggle') {
      if (this.input.wasPressed('aim')) this.aimToggle = !this.aimToggle;
      this.aiming = this.aimToggle;
    } else {
      this.aiming = aimHeld;
    }
    if (this.weapon.slot === 'melee') this.aiming = false;

    let crouchHeld = this.input.isDown('crouch');
    if (store.str('holdToCrouch') === 'toggle') {
      if (this.input.wasPressed('crouch')) this.crouchToggle = !this.crouchToggle;
      crouchHeld = this.crouchToggle;
    }

    const forward = (this.input.isDown('forward') ? 1 : 0) - (this.input.isDown('back') ? 1 : 0);
    const strafe = (this.input.isDown('right') ? 1 : 0) - (this.input.isDown('left') ? 1 : 0);
    const sprint = store.bool('autoSprint') ? forward > 0 : this.input.isDown('sprint');

    let buttons = 0;
    if (this.input.isDown('jump')) buttons |= Btn.Jump;
    if (crouchHeld) buttons |= Btn.Crouch;
    if (sprint) buttons |= Btn.Sprint;
    if (this.input.isDown('fire')) buttons |= Btn.Fire;
    if (this.aiming) buttons |= Btn.Aim;
    if (this.input.isDown('reload')) buttons |= Btn.Reload;
    if (this.input.wasPressed('ability')) buttons |= Btn.Ability;
    if (this.input.wasPressed('ultimate')) buttons |= Btn.Ultimate;
    if (this.input.wasPressed('melee')) buttons |= Btn.Melee;
    if (this.input.isDown('interact')) buttons |= Btn.Interact;

    // -- build and send the command --------------------------------------
    const shotSeed = hashSeed(this.selfId, Math.floor(this.timeSec * 1000)) >>> 0;
    const cmd = this.connection.sendInput({
      dt,
      moveX: strafe,
      moveZ: forward,
      yaw: this.camYaw + this.recoilYaw,
      pitch: clamp(this.camPitch + this.recoilPitch, -1.54, 1.54),
      buttons,
      slot: this.pendingSlot >= 0 ? this.pendingSlot : this.slot,
      shotSeed,
    });

    // -- predict ---------------------------------------------------------
    if (this.alive) {
      this.applyLocalWeaponLogic(dt, buttons, shotSeed);
      const out = movementStep(this.world, this.move, cmd, this.ctx, dt);
      this.predictionHistory.set(cmd.seq, { x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z });
      if (this.predictionHistory.size > 240) {
        const oldest = this.predictionHistory.keys().next().value;
        if (oldest !== undefined) this.predictionHistory.delete(oldest);
      }

      // Local feedback that does not need the server.
      if (out.jumped) audio.jump({ volume: 0.5 });
      if (out.landingSpeed > 3) {
        const hard = out.landingSpeed > 14;
        audio.land(hard, { volume: 0.6 });
        this.viewModel.land(out.landingSpeed);
        if (hard) this.addShake(clamp(out.landingSpeed / 40, 0, 0.6));
      }
      if (out.slideStarted) audio.slide({ volume: 0.7 });
      this.footsteps(out.speed, out.groundSurface);
    } else {
      this.respawnIn = Math.max(0, this.respawnIn - dt);
    }

    // -- timers ----------------------------------------------------------
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.burstTimer = Math.max(0, this.burstTimer - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer === 0) this.finishReloadLocal();
    }
    if (this.equipTimer > 0) {
      this.equipTimer = Math.max(0, this.equipTimer - dt);
      if (this.equipTimer === 0 && this.pendingSlot >= 0) {
        this.slot = this.pendingSlot;
        this.pendingSlot = -1;
        this.equipWeapon(this.slot, false);
      }
    }
    this.bloom = Math.max(0, this.bloom - this.weapon.spread.decay * dt);

    // Recoil recovery: return the camera towards where the player was aiming.
    const rec = this.weapon.recoil;
    const recover = rec.recoverRate * dt;
    this.recoilRecoverPitch = damp(this.recoilRecoverPitch, 0, rec.recoverRate * 0.8, dt);
    this.recoilRecoverYaw = damp(this.recoilRecoverYaw, 0, rec.recoverRate * 0.8, dt);
    const returnable = rec.recovery;
    this.recoilPitch = damp(this.recoilPitch, this.recoilPitch * (1 - returnable), recover * 4, dt);
    this.recoilYaw = damp(this.recoilYaw, this.recoilYaw * (1 - returnable), recover * 4, dt);

    // Damage indicators fade.
    for (const d of this.damageIndicators) d.strength -= dt * 0.55;
    this.damageIndicators = this.damageIndicators.filter((d) => d.strength > 0);
  }

  private lookScale(): number {
    if (!this.aiming) return 1;
    const scoped = this.weapon.scoped;
    return scoped ? store.num('scopedSensitivityMultiplier') : store.num('adsSensitivityMultiplier');
  }

  // ---------------------------------------------------------------------
  // Local weapon prediction (visual + audio only; server owns damage)
  // ---------------------------------------------------------------------

  private get weapon(): WeaponDef {
    return this.weapons[this.slot] ?? this.weapons[0] ?? WEAPONS.pulse_ar;
  }

  private applyLocalWeaponLogic(dt: number, buttons: number, shotSeed: number): void {
    void dt;
    const w = this.weapon;
    const wantFire = (buttons & Btn.Fire) !== 0;
    const wantReload = (buttons & Btn.Reload) !== 0;

    if ((buttons & Btn.Melee) !== 0) {
      this.viewModel.meleeAttack();
      audio.weaponFire(this.weapons[2], { volume: 0.5 });
    }

    if (wantReload) this.startReloadLocal();

    if (w.slot === 'melee') {
      if (wantFire && this.fireCooldown <= 0) {
        this.fireCooldown = shotInterval(w);
        this.viewModel.meleeAttack();
        audio.weaponFire(w, { volume: 0.6 });
      }
      return;
    }

    const semi = w.fireMode === 'single' || w.fireMode === 'bolt' || w.fireMode === 'pump';
    const triggerEdge = this.input.wasPressed('fire');
    const canShoot =
      this.fireCooldown <= 0 &&
      this.burstTimer <= 0 &&
      this.reloadTimer <= 0 &&
      this.equipTimer <= 0 &&
      this.ammo[this.slot] > 0;

    const wantsShot = this.burstRemaining > 0 || (semi ? triggerEdge : wantFire);
    if (wantsShot && canShoot) {
      this.localShot(shotSeed);
    } else if (wantFire && this.ammo[this.slot] <= 0 && this.fireCooldown <= 0 && this.reloadTimer <= 0) {
      audio.dryFire({ volume: 0.5 });
      this.fireCooldown = 0.25;
      if (store.bool('autoReload')) this.startReloadLocal();
    }
  }

  private localShot(shotSeed: number): void {
    const w = this.weapon;
    this.ammo[this.slot] = Math.max(0, this.ammo[this.slot] - 1);
    this.bloom = Math.min(w.spread.max, this.bloom + w.spread.perShot);

    if (w.fireMode === 'burst') {
      if (this.burstRemaining <= 0) this.burstRemaining = w.burstCount;
      this.burstRemaining--;
      if (this.burstRemaining > 0) {
        this.burstTimer = w.burstInterval;
        this.fireCooldown = 0;
      } else {
        this.fireCooldown = shotInterval(w);
        this.shotIndex = 0;
      }
    } else {
      this.fireCooldown = shotInterval(w);
    }

    // Camera + view-model recoil.
    const kick = recoilForShot(w, this.shotIndex, this.aiming && this.viewModel.adsAmount > 0.6);
    this.recoilPitch += kick.pitch;
    this.recoilYaw += kick.yaw;
    this.shotIndex++;
    this.viewModel.fire(this.timeSec);
    this.addShake(w.recoil.viewKick * 1.6);

    audio.weaponFire(w, { volume: 1 });

    // Muzzle flash + shell in the view scene.
    this.viewModel.muzzleWorld(tmpV);
    // The muzzle lives in the view scene; convert to world space in front of
    // the camera so tracers start where the weapon appears to.
    const camPos = this.renderer.camera.position;
    forwardFromAngles(tmpDir, this.camYaw + this.recoilYaw, clamp(this.camPitch + this.recoilPitch, -1.54, 1.54));
    tmpV2.copy(camPos).addScaledVector(new Vector3(tmpDir.x, tmpDir.y, tmpDir.z), 0.55);
    tmpV2.y -= 0.06;
    this.fx.muzzleFlash(tmpV2, new Vector3(tmpDir.x, tmpDir.y, tmpDir.z), w.fx.lightColor, w.fx.muzzleScale);

    if (w.fx.shells) {
      this.viewModel.ejectWorld(tmpV);
      const right = new Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
      this.fx.ejectShell(tmpV2.clone().addScaledVector(right, 0.14), right, new Vector3(0, 1, 0), w.fx.shellColor);
    }

    if (store.bool('autoReload') && this.ammo[this.slot] === 0) this.startReloadLocal();
    void shotSeed;
  }

  private startReloadLocal(): void {
    const w = this.weapon;
    if (w.slot === 'melee') return;
    if (this.reloadTimer > 0) return;
    if (this.ammo[this.slot] >= w.magazine) return;
    if (this.reserve[this.slot] <= 0) return;
    const tactical = this.ammo[this.slot] > 0;
    let time = tactical ? w.reloadTimeTactical : w.reloadTime;
    if (this.classId === 'titan' && w.category === 'lmg') time *= 0.75;
    this.reloadTimer = time;
    this.burstRemaining = 0;
    this.shotIndex = 0;
    this.viewModel.startReload(time);
    audio.reload(w, { volume: 0.8 });
  }

  private finishReloadLocal(): void {
    const w = this.weapon;
    const need = w.magazine - this.ammo[this.slot];
    const take = Math.min(need, this.reserve[this.slot]);
    this.ammo[this.slot] += take;
    this.reserve[this.slot] -= take;
    this.bloom = 0;
  }

  private requestSlot(slot: number): void {
    if (slot < 0 || slot > 2) return;
    if (slot === this.slot && this.pendingSlot < 0) return;
    if (this.mode.weaponRule !== 'loadout' && slot !== 0) return;
    this.pendingSlot = slot;
    this.equipTimer = Math.max(this.equipTimer, this.weapon.holsterTime);
    this.viewModel.holster(this.weapon.holsterTime);
    this.reloadTimer = 0;
    this.viewModel.cancelReload();
  }

  private cycleWeapon(dir: number): void {
    const next = (this.slot + dir + 3) % 3;
    this.requestSlot(next);
  }

  private equipWeapon(slot: number, immediate: boolean): void {
    const w = this.weapons[slot];
    if (!w) return;
    const skinId = this.loadout?.skins?.[w.id];
    const skin = skinId ? (WEAPON_SKIN_TINTS[skinId] ?? undefined) : undefined;
    this.viewModel.setWeapon(w, skin);
    this.equipTimer = immediate ? 0 : w.equipTime;
    this.burstRemaining = 0;
    this.shotIndex = 0;
    this.bloom = 0;
    audio.uiClick();
  }

  // ---------------------------------------------------------------------
  // Snapshot handling
  // ---------------------------------------------------------------------

  onSnapshot(snap: Snapshot): void {
    const serverTime = snap.serverTimeMs;
    this.actors.ingest(snap.entities, serverTime, this.selfId, this.roster);

    if (snap.self) {
      const s = snap.self;
      const wasAlive = this.alive;
      this.alive = (s.flags & EntFlag.Alive) !== 0;
      this.health = s.health;
      this.shield = s.shield;
      this.ammo[s.slot] = s.ammo;
      this.reserve[s.slot] = s.reserve;
      this.abilityCharge = s.abilityCharge;
      this.ultimateCharge = s.ultimateCharge;
      if (s.slot !== this.slot && this.pendingSlot < 0) {
        // Server changed our weapon (pickup / gun progression).
        this.slot = clamp(s.slot, 0, 2);
        this.equipWeapon(this.slot, false);
      }
      if ((s.flags & EntFlag.Protected) !== 0) this.protectedUntil = performance.now() + 200;

      if (this.alive && !wasAlive) {
        this.onSpawn();
        this.viewModel.setVisible(true);
        this.killedBy = '';
        this.recoilPitch = 0;
        this.recoilYaw = 0;
        this.bloom = 0;
        this.damageIndicators.length = 0;
      } else if (!this.alive && wasAlive) {
        this.viewModel.setVisible(false);
      }

      // -- reconciliation ------------------------------------------------
      const predicted = this.predictionHistory.get(snap.ackSeq);
      if (predicted) {
        const dx = s.x - predicted.x;
        const dy = s.y - predicted.y;
        const dz = s.z - predicted.z;
        const error = Math.hypot(dx, dy, dz);
        if (error > POSITION_TELEPORT_LIMIT) {
          // Teleport, respawn or a hard server correction: accept it outright.
          setVec(this.move.pos, s.x, s.y, s.z);
          setVec(this.move.vel, s.vx, s.vy, s.vz);
          this.correction.set(0, 0, 0);
          this.hardCorrections++;
          this.replayPending();
        } else if (error > POSITION_DESYNC_LIMIT) {
          // Rewind to the authoritative state and replay unacked inputs, then
          // carry the residual as a smooth visual offset.
          const before = tmpV.copy(this.move.pos);
          setVec(this.move.pos, s.x, s.y, s.z);
          setVec(this.move.vel, s.vx, s.vy, s.vz);
          this.replayPending();
          this.correction.add(before.sub(this.move.pos));
          this.softCorrections++;
        }
        // Below the threshold we trust the prediction entirely: correcting
        // sub-centimetre drift every 50ms is what makes movement feel mushy.
      } else if (!this.alive) {
        setVec(this.move.pos, s.x, s.y, s.z);
        setVec(this.move.vel, 0, 0, 0);
      }
      // Drop acknowledged history.
      for (const seq of this.predictionHistory.keys()) {
        if (seq <= snap.ackSeq) this.predictionHistory.delete(seq);
      }
    }

    for (const ev of snap.events) this.handleEvent(ev, serverTime);
  }

  private replayPending(): void {
    if (!this.world) return;
    for (const cmd of this.connection.pendingInputs) {
      movementStep(this.world, this.move, cmd, this.ctx, cmd.dt);
      this.predictionHistory.set(cmd.seq, { x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z });
    }
  }

  private handleEvent(ev: WireEvent, serverTime: number): void {
    void serverTime;
    const at = tmpV.set(ev.x, ev.y, ev.z);
    switch (ev.t) {
      case EvType.Shot: {
        if (ev.a === this.selfId) {
          // Our own shot: draw the tracer to where the server said it landed.
          const w = this.weapon;
          if (w.fx.tracer !== 'none') {
            const camPos = this.renderer.camera.position;
            forwardFromAngles(tmpDir, this.camYaw, this.camPitch);
            const start = tmpV2.copy(camPos).addScaledVector(new Vector3(tmpDir.x, tmpDir.y, tmpDir.z), 0.7);
            start.y -= 0.08;
            this.fx.tracer(start, at.clone(), w.fx.tracerColor, w.fx.tracerWidth, w.fx.tracer);
          }
          break;
        }
        const idx = ev.i - 1;
        const w = WEAPONS[WEAPON_ORDER[idx] ?? 'pulse_ar'];
        const actor = this.actors.get(ev.a);
        if (actor) {
          const from = actor.position.clone();
          from.y += 1.4;
          if (w.fx.tracer !== 'none') this.fx.tracer(from, at.clone(), w.fx.tracerColor, w.fx.tracerWidth, w.fx.tracer);
          this.fx.muzzleFlash(from, new Vector3(0, 0, -1), w.fx.lightColor, w.fx.muzzleScale * 0.7);
          audio.weaponFire(w, { x: from.x, y: from.y, z: from.z, volume: 0.85 });
        }
        break;
      }
      case EvType.Impact: {
        const surface = surfaceFromIndexClient(ev.i);
        const idx = ev.j - 1;
        const w = WEAPONS[WEAPON_ORDER[idx] ?? 'pulse_ar'];
        // The event packs the surface normal as yaw/pitch.
        forwardFromAngles(tmpDir, ev.u, ev.v);
        const normal = new Vector3(tmpDir.x, tmpDir.y, tmpDir.z);
        this.fx.impact(at.clone(), normal, w.fx.tracerColor, surface);
        audio.impact(surface, { x: ev.x, y: ev.y, z: ev.z, volume: 0.7 });
        break;
      }
      case EvType.DamageDealt: {
        if (ev.a !== this.selfId) break;
        this.hitMarkerUntil = performance.now() + 190;
        this.hitMarkerHeadshot = ev.j === 1;
        audio.hitMarker(ev.j === 1);
        this.fx.impact(at.clone(), new Vector3(0, 1, 0), 0xff8080, 'flesh');
        break;
      }
      case EvType.DamageTaken: {
        if (ev.b !== this.selfId) break;
        // Direction indicator relative to where we are looking.
        const dx = ev.x - this.move.pos.x;
        const dz = ev.z - this.move.pos.z;
        const worldAngle = Math.atan2(-dx, -dz);
        const relative = wrapAngle(worldAngle - this.camYaw);
        this.damageIndicators.push({ angle: relative, strength: 1 });
        if (this.damageIndicators.length > 6) this.damageIndicators.shift();
        this.addShake(clamp(ev.i / 90, 0.06, 0.5));
        audio.impact('flesh', { volume: 0.5 });
        break;
      }
      case EvType.Kill: {
        if (ev.a === this.selfId) {
          this.streak++;
          audio.hitMarker(ev.j === 1);
        }
        break;
      }
      case EvType.Death: {
        const victim = this.roster.get(ev.a);
        const killer = this.roster.get(ev.b);
        const effect = 'default';
        const color = TEAM_COLORS[victim?.team ?? 0] ?? 0x9aa7bd;
        this.fx.deathEffect(at.clone().setY(ev.y + 0.9), effect, color);
        audio.death({ x: ev.x, y: ev.y, z: ev.z, volume: 0.7 });
        if (ev.a === this.selfId) {
          this.killedBy = killer?.name ?? '';
          this.respawnIn = this.mode.respawnDelay;
          this.streak = 0;
          this.onDeath(this.killedBy);
        }
        break;
      }
      case EvType.Spawn: {
        if (ev.a === this.selfId) {
          setVec(this.move.pos, ev.x, ev.y, ev.z);
          setVec(this.move.vel, 0, 0, 0);
          this.camYaw = ev.u;
          this.camPitch = 0;
          this.correction.set(0, 0, 0);
          this.predictionHistory.clear();
        } else {
          this.fx.burst(at.clone().setY(ev.y + 1), 3, TEAM_COLORS[ev.i] ?? 0x2ce8ff, 0.6, 2);
        }
        break;
      }
      case EvType.Explosion: {
        const radius = ev.i / 10;
        this.fx.explosion(at.clone(), radius);
        audio.explosion(radius, { x: ev.x, y: ev.y, z: ev.z });
        const dist = Math.hypot(this.move.pos.x - ev.x, this.move.pos.y - ev.y, this.move.pos.z - ev.z);
        if (dist < radius * 3) this.addShake(clamp(1 - dist / (radius * 3), 0, 1) * 0.9);
        break;
      }
      case EvType.Pickup: {
        this.entities.consumePickupAt(ev.x, ev.y, ev.z);
        if (ev.a === this.selfId) audio.pickup(['weapon', 'ammo', 'health', 'shield'][ev.i] ?? 'ammo');
        break;
      }
      case EvType.AbilityUsed: {
        const kind = ABILITY_NAMES[ev.j] ?? 'dash';
        audio.ability(kind, ev.a === this.selfId ? {} : { x: ev.x, y: ev.y, z: ev.z });
        const color = ev.a === this.selfId ? 0x2ce8ff : (TEAM_COLORS[this.roster.get(ev.a)?.team ?? 0] ?? 0x2ce8ff);
        this.fx.burst(at.clone().setY(ev.y + 1), 4, color, 0.7, 3);
        if (kind === 'scan' || kind === 'emp') {
          this.fx.explosion(at.clone().setY(ev.y + 1), 4, color);
        }
        break;
      }
      case EvType.Reload: {
        if (ev.a === this.selfId) audio.dryFire({ volume: 0.4 });
        break;
      }
      case EvType.Melee: {
        if (ev.a !== this.selfId) {
          audio.weaponFire(WEAPONS.plasma_blade, { x: ev.x, y: ev.y, z: ev.z, volume: 0.5 });
        }
        break;
      }
      case EvType.Footstep: {
        if (ev.a === this.selfId) break;
        audio.footstep(surfaceFromIndexClient(ev.j), { x: ev.x, y: ev.y, z: ev.z, volume: 0.6 });
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Camera + presentation
  // ---------------------------------------------------------------------

  private addShake(amount: number): void {
    const intensity = store.num('screenShake');
    if (intensity <= 0 || store.bool('reducedMotion')) return;
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount * intensity);
  }

  private updateCamera(dt: number): void {
    const cam = this.renderer.camera;

    // Smoothly retire any residual reconciliation error.
    if (this.correction.lengthSq() > 1e-8) {
      const k = Math.min(1, dt * 9);
      tmpV.copy(this.correction).multiplyScalar(k);
      this.correction.sub(tmpV);
      if (this.correction.lengthSq() < 1e-6) this.correction.set(0, 0, 0);
    }

    // Eye height follows the crouch/slide state with a spring.
    const targetEye = eyeHeightFor(this.move.height);
    this.eyeHeightCurrent = damp(this.eyeHeightCurrent, targetEye, 14, dt);

    cam.position.set(
      this.move.pos.x + this.correction.x,
      this.move.pos.y + this.eyeHeightCurrent + this.correction.y,
      this.move.pos.z + this.correction.z,
    );

    // Head bob applied to the camera, separate from the view model's bob.
    if (store.bool('headBob') && !store.bool('reducedMotion') && this.move.onGround) {
      const speed = Math.hypot(this.move.vel.x, this.move.vel.z);
      const amp = clamp(speed / 9.3, 0, 1) * 0.022 * (1 - this.viewModel.adsAmount * 0.7);
      cam.position.y += Math.abs(Math.sin(this.timeSec * 9)) * amp;
      cam.position.x += Math.sin(this.timeSec * 4.5) * amp * 0.4;
    }

    // Screen shake.
    if (this.shakeAmount > 0.001) {
      this.shakeTime += dt * 40;
      const s = this.shakeAmount * 0.05;
      cam.position.x += Math.sin(this.shakeTime * 1.7) * s;
      cam.position.y += Math.sin(this.shakeTime * 2.3) * s;
      this.shakeAmount = damp(this.shakeAmount, 0, 9, dt);
    }

    // Orientation. Slide adds a roll for a sense of speed.
    const slideRoll = this.move.sliding ? 0.09 : 0;
    const strafeRoll = clamp(-this.lastLookDx * 1.2, -0.03, 0.03);
    tmpEuler.set(
      clamp(this.camPitch + this.recoilPitch, -1.54, 1.54),
      this.camYaw + this.recoilYaw,
      slideRoll + strafeRoll,
      'YXZ',
    );
    cam.quaternion.setFromEuler(tmpEuler);

    // FOV: base + sprint boost, pulled in while aiming.
    const baseFov = store.num('fov');
    const sprintBoost = store.num('sprintFovBoost');
    const speedRatio = clamp(Math.hypot(this.move.vel.x, this.move.vel.z) / 9.3, 0, 1.3);
    const sprinting = this.move.onGround && speedRatio > 0.85;
    const target = this.aiming
      ? baseFov * this.weapon.adsZoom
      : baseFov + (sprinting || this.move.sliding ? sprintBoost * clamp(speedRatio, 0, 1.2) : 0);
    this.fovCurrent = damp(this.fovCurrent, target, 10, dt);
    if (Math.abs(cam.fov - this.fovCurrent) > 0.05) {
      cam.fov = this.fovCurrent;
      cam.updateProjectionMatrix();
    }

    // Audio listener rides the camera.
    forwardFromAngles(tmpDir, this.camYaw + this.recoilYaw, this.camPitch + this.recoilPitch);
    audio.setListener(cam.position.x, cam.position.y, cam.position.z, tmpDir.x, tmpDir.y, tmpDir.z);
  }

  private updatePresentation(dt: number): void {
    const cam = this.renderer.camera;
    this.viewModel.update(dt, {
      aiming: this.aiming,
      speed: Math.hypot(this.move.vel.x, this.move.vel.z),
      maxSpeed: 9.3,
      onGround: this.move.onGround,
      sliding: this.move.sliding,
      lookDeltaX: this.lastLookDx,
      lookDeltaY: this.lastLookDy,
      nowSec: this.timeSec,
      alive: this.alive,
    });
    this.viewModel.setVisible(this.alive);

    this.actors.update(this.connection.renderTimeMs(), dt, cam.position, this.team);
    this.entities.update(dt, this.timeSec, cam.position);
    this.fx.update(dt);
    this.fx.faceCamera(cam.position);
  }

  private footsteps(speed: number, surface: string): void {
    if (!this.move.onGround || speed < 1.6 || this.move.sliding) return;
    const interval = speed > 7.5 ? 0.31 : 0.44;
    if (this.timeSec - this.lastFootstepAt < interval) return;
    this.lastFootstepAt = this.timeSec;
    audio.footstep(surface, { volume: 0.45 });
  }

  private emitHud(): void {
    const cls = CLASSES[this.classId] ?? CLASSES.vanguard;
    const w = this.weapon;
    const spreadRad = currentSpread(w, {
      aiming: this.aiming,
      crouching: this.move.crouching,
      onGround: this.move.onGround,
      speedRatio: Math.hypot(this.move.vel.x, this.move.vel.z) / 9.3,
      bloom: this.bloom,
    });
    // Convert the cone half-angle to a screen radius in pixels.
    const halfHeight = window.innerHeight / 2;
    const fovRad = (this.fovCurrent * Math.PI) / 180;
    const spreadPixels = Math.tan(spreadRad) * (halfHeight / Math.tan(fovRad / 2));

    this.onHud({
      alive: this.alive,
      health: this.health,
      maxHealth: cls.health,
      shield: this.shield,
      maxShield: cls.shield,
      ammo: this.ammo[this.slot] ?? 0,
      reserve: this.reserve[this.slot] ?? 0,
      weapon: w,
      slot: this.slot,
      abilityCharge: this.abilityCharge,
      ultimateCharge: this.ultimateCharge,
      abilityName: cls.ability.name,
      ultimateName: cls.ultimate.name,
      spreadPixels,
      respawnIn: this.respawnIn,
      killedBy: this.killedBy,
      ping: Math.round(this.connection.pingMs),
      fps: this.renderer.stats().fps,
      speed: Math.hypot(this.move.vel.x, this.move.vel.z),
      damageDirections: this.damageIndicators.map((d) => ({ angle: d.angle, strength: d.strength })),
      hitMarker: Math.max(0, this.hitMarkerUntil - performance.now()) / 190,
      hitMarkerHeadshot: this.hitMarkerHeadshot,
      streak: this.streak,
      modeValue: this.modeValue,
      protectedUntil: this.protectedUntil,
      emp: this.empUntil > performance.now(),
    });
  }

  // ---------------------------------------------------------------------

  get position(): Vector3 {
    return this.renderer.camera.position;
  }

  get yaw(): number {
    return this.camYaw;
  }

  get currentMapDef(): MapDef | null {
    return this.mapDef;
  }

  get selfTeam(): number {
    return this.team;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get netStats(): { hard: number; soft: number } {
    return { hard: this.hardCorrections, soft: this.softCorrections };
  }

  get rosterMap(): Map<number, PlayerPublicState> {
    return this.roster;
  }

  get currentMatchState(): MatchStatePayload | null {
    return this.matchState;
  }

  dispose(): void {
    this.stop();
    this.fx.dispose();
    this.entities.dispose();
    this.actors.clear();
    this.viewModel.dispose();
    if (this.mapMeshes) {
      this.renderer.scene.remove(this.mapMeshes.root);
      this.mapMeshes.dispose();
    }
  }
}

const ABILITY_NAMES = ['dash', 'cloak', 'overshield', 'barrier', 'scan', 'turret', 'heal_field', 'grapple', 'emp', 'blink'];

/** Emissive tint per weapon skin; the body colour never changes. */
const WEAPON_SKIN_TINTS: Record<string, number> = {
  skin_default: 0x2ce8ff,
  skin_carbon: 0x4a5364,
  skin_arctic: 0xdfe6ef,
  skin_ionflow: 0x2ce8ff,
  skin_emberline: 0xff5a3c,
  skin_toxin: 0x8dff4a,
  skin_nebula: 0xc7a2ff,
  skin_shatter: 0x4fd8ff,
  skin_apex: 0xffb03a,
};

export { Group, MathUtils, Scene, lerp, PLAYER_HEIGHT, copyMoveState };
