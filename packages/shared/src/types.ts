/**
 * Core shared types.  Anything that crosses the network or is referenced by
 * both the simulation and the presentation layer lives here.
 */

import type { Vec3 } from './math.js';

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const Team = {
  None: 0,
  Ion: 1, // violet / purple
  Ember: 2, // orange / ember
} as const;
export type TeamId = (typeof Team)[keyof typeof Team];

export const TEAM_NAMES: Record<number, string> = {
  0: 'Unassigned',
  1: 'ION',
  2: 'EMBER',
};

/**
 * Team hues, mirrored from the client design system: unassigned is --ink-dim,
 * ION is --ion and EMBER is --ember. The renderer needs ints and the HUD needs
 * CSS strings, and neither can read a stylesheet variable, so both forms are
 * restated here. Keep them in step with packages/client/src/styles/base.css.
 */
export const TEAM_COLORS: Record<number, number> = {
  0: 0xa79cba,
  1: 0xa855f7,
  2: 0xff5a3c,
};

export const TEAM_COLORS_CSS: Record<number, string> = {
  0: '#a79cba',
  1: '#a855f7',
  2: '#ff5a3c',
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const Btn = {
  Jump: 1 << 0,
  Crouch: 1 << 1,
  Sprint: 1 << 2,
  Fire: 1 << 3,
  Aim: 1 << 4,
  Reload: 1 << 5,
  Ability: 1 << 6,
  Melee: 1 << 7,
  Interact: 1 << 8,
  Ultimate: 1 << 9,
} as const;
export type ButtonMask = number;

export interface InputCommand {
  /** Monotonic sequence number assigned by the client. */
  seq: number;
  /** Simulation delta for this command (always TICK_DT in practice). */
  dt: number;
  /** Strafe axis, -1 (left) .. 1 (right). */
  moveX: number;
  /** Forward axis, -1 (back) .. 1 (forward). */
  moveZ: number;
  yaw: number;
  pitch: number;
  buttons: ButtonMask;
  /** Slot the client wants to be holding (0..3). */
  slot: number;
  /**
   * Per-command random seed. The client generates it, predicts spread with it,
   * and the server recomputes the identical cone so predicted tracers match the
   * authoritative trace. It never influences damage, only direction jitter.
   */
  shotSeed?: number;
}

export function hasBtn(buttons: number, mask: number): boolean {
  return (buttons & mask) !== 0;
}

// ---------------------------------------------------------------------------
// Movement state (shared by predictor and authority)
// ---------------------------------------------------------------------------

export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  height: number;
  onGround: boolean;
  groundNormalY: number;
  crouching: boolean;
  sliding: boolean;
  slideTime: number;
  slideCooldown: number;
  coyote: number;
  jumpBuffer: number;
  jumpCooldown: number;
  jumpHeld: boolean;
  /** Speed at which the player last touched the ground (for landing FX / fall damage). */
  lastImpactSpeed: number;
  /** Set for exactly one step after touching down. */
  justLanded: boolean;
  /** Set for exactly one step after leaving the ground via jump. */
  justJumped: boolean;
  /** Accumulated distance travelled on foot, drives footstep audio. */
  stepDistance: number;
}

export function createMoveState(pos?: Vec3): MoveState {
  return {
    pos: pos ? { ...pos } : { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    height: 1.82,
    onGround: false,
    groundNormalY: 1,
    crouching: false,
    sliding: false,
    slideTime: 0,
    slideCooldown: 0,
    coyote: 0,
    jumpBuffer: 0,
    jumpCooldown: 0,
    jumpHeld: false,
    lastImpactSpeed: 0,
    justLanded: false,
    justJumped: false,
    stepDistance: 0,
  };
}

export function copyMoveState(dst: MoveState, src: MoveState): MoveState {
  dst.pos.x = src.pos.x;
  dst.pos.y = src.pos.y;
  dst.pos.z = src.pos.z;
  dst.vel.x = src.vel.x;
  dst.vel.y = src.vel.y;
  dst.vel.z = src.vel.z;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.height = src.height;
  dst.onGround = src.onGround;
  dst.groundNormalY = src.groundNormalY;
  dst.crouching = src.crouching;
  dst.sliding = src.sliding;
  dst.slideTime = src.slideTime;
  dst.slideCooldown = src.slideCooldown;
  dst.coyote = src.coyote;
  dst.jumpBuffer = src.jumpBuffer;
  dst.jumpCooldown = src.jumpCooldown;
  dst.jumpHeld = src.jumpHeld;
  dst.lastImpactSpeed = src.lastImpactSpeed;
  dst.justLanded = src.justLanded;
  dst.justJumped = src.justJumped;
  dst.stepDistance = src.stepDistance;
  return dst;
}

// ---------------------------------------------------------------------------
// Hit detection
// ---------------------------------------------------------------------------

export const BodyPart = {
  Head: 'head',
  Torso: 'torso',
  Arm: 'arm',
  Leg: 'leg',
} as const;
export type BodyPartId = (typeof BodyPart)[keyof typeof BodyPart];

export const BODY_PART_MULTIPLIER: Record<BodyPartId, number> = {
  head: 2.0,
  torso: 1.0,
  arm: 0.85,
  leg: 0.78,
};

export interface TraceResult {
  hit: boolean;
  /** Distance along the ray. */
  distance: number;
  point: Vec3;
  normal: Vec3;
  /** Entity id when a player was hit, -1 for world geometry. */
  entityId: number;
  part: BodyPartId | null;
  /** Surface material key of the geometry hit, used to pick impact FX/audio. */
  surface: string;
}

export function createTraceResult(): TraceResult {
  return {
    hit: false,
    distance: 0,
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    entityId: -1,
    part: null,
    surface: 'metal',
  };
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export const DamageCause = {
  Weapon: 0,
  Melee: 1,
  Explosion: 2,
  Fall: 3,
  Ability: 4,
  OutOfBounds: 5,
  Deployable: 6,
} as const;
export type DamageCauseId = (typeof DamageCause)[keyof typeof DamageCause];

export interface DamageEvent {
  attackerId: number;
  targetId: number;
  amount: number;
  part: BodyPartId | null;
  weaponId: string;
  cause: DamageCauseId;
  /** World position where the damage originated (for direction indicators). */
  from: Vec3;
  headshot: boolean;
  killed: boolean;
}

// ---------------------------------------------------------------------------
// Player-facing snapshot data
// ---------------------------------------------------------------------------

export const EntFlag = {
  Alive: 1 << 0,
  Crouching: 1 << 1,
  Sliding: 1 << 2,
  Sprinting: 1 << 3,
  Firing: 1 << 4,
  OnGround: 1 << 5,
  Aiming: 1 << 6,
  Reloading: 1 << 7,
  Bot: 1 << 8,
  Protected: 1 << 9,
  Cloaked: 1 << 10,
  Shielded: 1 << 11,
  CarryingCore: 1 << 12,
  Overshield: 1 << 13,
  Scanned: 1 << 14,
} as const;

export interface EntitySnapshot {
  id: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  health: number;
  shield: number;
  weapon: number;
  team: number;
}

export interface Snapshot {
  tick: number;
  serverTimeMs: number;
  ackSeq: number;
  /** Authoritative state for the receiving client, used for reconciliation. */
  self: SelfState | null;
  entities: EntitySnapshot[];
  events: WireEvent[];
}

export interface SelfState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  health: number;
  shield: number;
  flags: number;
  ammo: number;
  reserve: number;
  slot: number;
  abilityCharge: number;
  ultimateCharge: number;
}

// ---------------------------------------------------------------------------
// High frequency events packed into the binary snapshot
// ---------------------------------------------------------------------------

export const EvType = {
  Shot: 0,
  Impact: 1,
  DamageDealt: 2,
  DamageTaken: 3,
  Kill: 4,
  Spawn: 5,
  Reload: 6,
  Melee: 7,
  AbilityUsed: 8,
  Explosion: 9,
  Pickup: 10,
  ObjectiveTick: 11,
  Footstep: 12,
  Death: 13,
} as const;

export interface WireEvent {
  t: number;
  /** Source entity (shooter / owner). */
  a: number;
  /** Target entity or -1. */
  b: number;
  x: number;
  y: number;
  z: number;
  /** Direction / normal packed as yaw+pitch, or generic payload. */
  u: number;
  v: number;
  /** Small integer payload: weapon index, damage, surface index, part index. */
  i: number;
  j: number;
}

// ---------------------------------------------------------------------------
// Reliable JSON channel
// ---------------------------------------------------------------------------

export const Msg = {
  // client -> server
  Hello: 'hello',
  JoinRoom: 'join',
  LeaveRoom: 'leave',
  SetLoadout: 'loadout',
  SetReady: 'ready',
  SelectTeam: 'team',
  Chat: 'chat',
  Ping: 'ping',
  RequestSpawn: 'spawn',
  Mute: 'mute',
  Report: 'report',
  Rematch: 'rematch',
  Emote: 'emote',
  Vote: 'vote',
  Spectate: 'spectate',
  // server -> client
  Welcome: 'welcome',
  Joined: 'joined',
  Rejected: 'rejected',
  RoomState: 'room',
  MatchState: 'match',
  PlayerList: 'players',
  KillFeed: 'feed',
  ChatMsg: 'chatmsg',
  Pong: 'pong',
  MatchResults: 'results',
  Notice: 'notice',
  Correction: 'correct',
  Kicked: 'kicked',
} as const;

export type ClientMessage =
  | { t: typeof Msg.Hello; protocol: number; token?: string; name: string }
  | {
      t: typeof Msg.JoinRoom;
      roomId?: string;
      code?: string;
      mode?: string;
      map?: string;
      create?: boolean;
      privateRoom?: boolean;
      name?: string;
      config?: Partial<CustomMatchConfig>;
    }
  | { t: typeof Msg.LeaveRoom }
  | { t: typeof Msg.SetLoadout; loadout: LoadoutSelection }
  | { t: typeof Msg.SetReady; ready: boolean }
  | { t: typeof Msg.SelectTeam; team: number }
  | { t: typeof Msg.Chat; text: string; teamOnly: boolean }
  | { t: typeof Msg.Ping; id: number; clientTime: number }
  | { t: typeof Msg.RequestSpawn }
  | { t: typeof Msg.Mute; targetId: number; muted: boolean }
  | { t: typeof Msg.Report; targetId: number; reason: string; note?: string }
  | { t: typeof Msg.Rematch; want: boolean }
  | { t: typeof Msg.Emote; emote: string }
  | { t: typeof Msg.Spectate; targetId: number };

export interface LoadoutSelection {
  classId: string;
  primary: string;
  secondary: string;
  melee: string;
  perks: string[];
  skins: Record<string, string>;
  charm?: string;
  killEffect?: string;
  banner?: string;
  icon?: string;
  bodyColor?: string;
  armorVariant?: string;
  crosshair?: string;
}

export interface CustomMatchConfig {
  mode: string;
  map: string;
  scoreLimit: number;
  timeLimitSec: number;
  botCount: number;
  botDifficulty: 'easy' | 'normal' | 'hard';
  friendlyFire: boolean;
  respawnDelay: number;
  weaponSet: 'all' | 'primary-only' | 'snipers' | 'pistols' | 'melee';
  maxPlayers: number;
  privateRoom: boolean;
  name: string;
}

// ---------------------------------------------------------------------------
// Room / match state pushed on the reliable channel
// ---------------------------------------------------------------------------

export const MatchPhase = {
  Warmup: 'warmup',
  Countdown: 'countdown',
  Live: 'live',
  Overtime: 'overtime',
  Ended: 'ended',
} as const;
export type MatchPhaseId = (typeof MatchPhase)[keyof typeof MatchPhase];

export interface PlayerPublicState {
  id: number;
  name: string;
  team: number;
  classId: string;
  bot: boolean;
  ready: boolean;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  ping: number;
  streak: number;
  alive: boolean;
  connected: boolean;
  spectating: boolean;
  accountLevel: number;
  banner?: string;
  icon?: string;
  /** Gun-progression tier or elimination lives, mode dependent. */
  modeValue: number;
}

export interface ObjectiveState {
  id: string;
  kind: 'zone' | 'hardpoint' | 'core' | 'flagpoint';
  x: number;
  y: number;
  z: number;
  radius: number;
  owner: number;
  /** 0..1 capture progress by the contesting team. */
  progress: number;
  contestedBy: number;
  active: boolean;
  label: string;
  /** For core mode: entity currently carrying, else -1. */
  carrier: number;
  homeX?: number;
  homeZ?: number;
}

export interface MatchStatePayload {
  phase: MatchPhaseId;
  mode: string;
  map: string;
  timeRemaining: number;
  scoreLimit: number;
  teamScores: [number, number];
  objectives: ObjectiveState[];
  roundNumber: number;
  overtime: boolean;
  serverTimeMs: number;
}

export interface KillFeedEntry {
  id: number;
  attacker: string;
  attackerTeam: number;
  victim: string;
  victimTeam: number;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  cause: DamageCauseId;
  timeMs: number;
}

export interface MatchResultsPayload {
  mode: string;
  map: string;
  winningTeam: number;
  teamScores: [number, number];
  players: MatchResultPlayer[];
  durationSec: number;
  mvpId: number;
}

export interface MatchResultPlayer {
  id: number;
  name: string;
  team: number;
  classId: string;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  damage: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  objectiveScore: number;
  longestStreak: number;
  bot: boolean;
  xpEarned: number;
  xpBreakdown: { label: string; amount: number }[];
  won: boolean;
  accountLevel: number;
  accountLevelAfter: number;
  weaponUsage: Record<string, number>;
}
