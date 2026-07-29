/**
 * NEON STRIKE - global simulation constants.
 *
 * Every value here is authoritative and is consumed identically by the client
 * predictor and the server simulation.  Do not fork these numbers: if the two
 * sides disagree the reconciliation loop will fight itself.
 *
 * Units: metres, seconds, metres/second.  Angles: radians.
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Fixed simulation step. 60 Hz => 16.666ms. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
/** Snapshot broadcast rate. Clients render ~2 snapshots in the past. */
export const SNAPSHOT_RATE = 20;
export const SNAPSHOT_DT = 1 / SNAPSHOT_RATE;
/** Interpolation buffer, in seconds, used for remote entity smoothing. */
export const INTERP_DELAY = 2 / SNAPSHOT_RATE;
/** How far back the server will rewind hitboxes for lag compensation. */
export const MAX_LAG_COMP_MS = 250;
/** Ring buffer length for the server-side player position history. */
export const LAG_COMP_HISTORY = Math.ceil((MAX_LAG_COMP_MS / 1000) * TICK_RATE) + 4;
/** Client keeps this many unacknowledged inputs for replay. */
export const INPUT_BUFFER_SIZE = 180;
/** Maximum inputs the server will process for one client in a single tick. */
export const MAX_INPUTS_PER_TICK = 6;
/** Inputs batched into a single packet. */
export const MAX_INPUTS_PER_PACKET = 12;

// ---------------------------------------------------------------------------
// Player capsule
// ---------------------------------------------------------------------------

export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT = 1.82;
export const PLAYER_CROUCH_HEIGHT = 1.12;
export const EYE_OFFSET = 0.2; // distance from top of capsule to eye
export const STEP_HEIGHT = 0.46;
/** cos of the steepest walkable slope (~48 degrees). */
export const MAX_SLOPE_COS = Math.cos((48 * Math.PI) / 180);

export function eyeHeightFor(height: number): number {
  return Math.max(0.35, height - EYE_OFFSET);
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export const GRAVITY = 26.5;
export const TERMINAL_VELOCITY = 65;

export const WALK_SPEED = 6.5;
export const SPRINT_SPEED = 9.3;
export const CROUCH_SPEED = 3.3;
export const AIR_SPEED_CAP = 1.35; // Quake-style air acceleration cap
export const GROUND_ACCEL = 92;
export const AIR_ACCEL = 42;
export const GROUND_FRICTION = 9.4;
export const AIR_FRICTION = 0.02;

export const JUMP_VELOCITY = 8.75;
/** Grace period after leaving a ledge during which a jump is still allowed. */
export const COYOTE_TIME = 0.09;
/** Jump buffered before landing still fires. */
export const JUMP_BUFFER = 0.11;
/** Minimum time between jumps (prevents auto-bhop being frame-perfect free). */
export const JUMP_COOLDOWN = 0.09;

export const SLIDE_BOOST_SPEED = 13.4;
export const SLIDE_MIN_ENTRY_SPEED = 5.4;
export const SLIDE_FRICTION = 2.15;
export const SLIDE_MAX_TIME = 0.85;
export const SLIDE_COOLDOWN = 0.55;
/** Velocity kept when jumping out of a slide. */
export const SLIDE_JUMP_RETAIN = 0.94;
/** Downhill slide acceleration multiplier. */
export const SLIDE_SLOPE_ACCEL = 12;

/** Speed below which footsteps stop playing. */
export const FOOTSTEP_MIN_SPEED = 1.6;
export const FOOTSTEP_INTERVAL_WALK = 0.44;
export const FOOTSTEP_INTERVAL_SPRINT = 0.31;

/** Fall damage begins above this impact speed and scales to lethal. */
export const FALL_DAMAGE_MIN_SPEED = 21;
export const FALL_DAMAGE_LETHAL_SPEED = 42;
export const FALL_DAMAGE_MAX = 100;

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export const BASE_HEALTH = 100;
/** Seconds after last damage before shield/armour regeneration begins. */
export const SHIELD_REGEN_DELAY = 4.5;
export const SHIELD_REGEN_RATE = 18;
export const HEALTH_REGEN_DELAY = 6.5;
export const HEALTH_REGEN_RATE = 12;

export const RESPAWN_DELAY = 3.0;
export const RESPAWN_PROTECTION = 1.6;
/** Damage multiplier applied while a player still has respawn protection. */
export const RESPAWN_PROTECTION_DAMAGE_SCALE = 0;

export const ASSIST_WINDOW = 6.0;
export const HEADSHOT_MULTIPLIER_DEFAULT = 2.0;

/** Maximum hitscan trace distance. */
export const MAX_TRACE_DISTANCE = 320;

// ---------------------------------------------------------------------------
// Hit boxes (relative to capsule bottom, scaled by capsule height ratio)
// ---------------------------------------------------------------------------

export const HITBOX_HEAD_RADIUS = 0.155;
/** Head centre as a fraction of capsule height. */
export const HITBOX_HEAD_FRACTION = 0.915;
export const HITBOX_TORSO_TOP = 0.86;
export const HITBOX_TORSO_BOTTOM = 0.5;
export const HITBOX_LEGS_TOP = 0.5;
export const HITBOX_ARM_HALF_WIDTH = 0.56;

// ---------------------------------------------------------------------------
// Match / room
// ---------------------------------------------------------------------------

export const MAX_PLAYERS = 16;
export const MIN_PLAYERS_TO_START = 1; // bots fill the rest
export const WARMUP_SECONDS = 8;
export const MATCH_END_SECONDS = 14;
export const ROOM_CODE_LENGTH = 5;
export const MAX_NAME_LENGTH = 16;
export const MAX_CHAT_LENGTH = 140;

// ---------------------------------------------------------------------------
// Anti-cheat
// ---------------------------------------------------------------------------

/** Multiplier applied to theoretical max speed before flagging. */
export const SPEED_CHECK_TOLERANCE = 1.35;
/** Allowed positional divergence before the server hard-corrects the client. */
export const POSITION_DESYNC_LIMIT = 0.35;
/** Divergence above which we treat the client as teleporting/cheating. */
export const POSITION_TELEPORT_LIMIT = 6.0;
/** Fire-rate slack: clients may be this fraction early on a shot. */
export const FIRE_RATE_TOLERANCE = 0.88;
/** Suspicion score at which a player is kicked from the room. */
export const SUSPICION_KICK_THRESHOLD = 120;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

export const POS_QUANT = 64; // 1/64 m ~= 1.5cm, i16 range +-512m
export const VEL_QUANT = 64;
export const PROTOCOL_VERSION = 7;
export const WS_PATH = '/ws';
export const HEARTBEAT_INTERVAL_MS = 5000;
export const CLIENT_TIMEOUT_MS = 20000;
export const RECONNECT_GRACE_MS = 30000;
