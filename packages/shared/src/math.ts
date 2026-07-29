/**
 * Small allocation-conscious math helpers.
 *
 * The simulation runs 60 times per second for up to 16 entities, so we avoid
 * allocating vectors inside hot loops.  Every function that returns a vector
 * accepts an optional output parameter.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function vcopy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function vset(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vadd(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function vsub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function vscale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

export function vaddScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vlen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vlenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function vlen2(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

export function vnorm(out: Vec3, a: Vec3): Vec3 {
  const l = vlen(a);
  if (l < EPSILON) return vset(out, 0, 0, 0);
  return vscale(out, a, 1 / l);
}

export function vdist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vdistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function vdist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function vlerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function vcross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return vset(out, x, y, z);
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  if (Math.abs(b - a) < EPSILON) return 0;
  return (v - a) / (b - a);
}

export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return lerp(outA, outB, clamp01(invLerp(inA, inB, v)));
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function dampVec(out: Vec3, current: Vec3, target: Vec3, rate: number, dt: number): Vec3 {
  const k = Math.exp(-rate * dt);
  out.x = target.x + (current.x - target.x) * k;
  out.y = target.y + (current.y - target.y) * k;
  out.z = target.z + (current.z - target.z) * k;
  return out;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle into [-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= TAU;
  while (x < -Math.PI) x += TAU;
  return x;
}

export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDelta(a, b) * t);
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) - used for spread patterns and bot jitter so
// the client and server can agree on a shot's spread from a shared seed.
// ---------------------------------------------------------------------------

export class Rng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  reseed(seed: number): void {
    this.state = seed >>> 0 || 1;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Gaussian-ish value in [-1, 1], concentrated near the centre. */
  bell(): number {
    return (this.next() + this.next() + this.next() - 1.5) / 1.5;
  }
}

/** Hash two ints into a stable 32-bit seed. */
export function hashSeed(a: number, b: number): number {
  let h = (a * 0x9e3779b1) ^ (b * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  return (h ^ (h >>> 15)) >>> 0;
}

// ---------------------------------------------------------------------------
// Direction helpers (yaw = rotation about +Y, 0 looking down -Z)
// ---------------------------------------------------------------------------

export function forwardFromAngles(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function rightFromYaw(out: Vec3, yaw: number): Vec3 {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

export function yawFromDirection(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export function pitchFromDirection(dx: number, dy: number, dz: number): number {
  const horiz = Math.sqrt(dx * dx + dz * dz);
  return Math.atan2(dy, horiz);
}

/** Rotate (x, z) by -yaw, i.e. world -> yaw-local space. */
export function rotateY(x: number, z: number, angle: number, out: { x: number; z: number }): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out.x = x * c - z * s;
  out.z = x * s + z * c;
}

// ---------------------------------------------------------------------------
// Quantisation used by the wire protocol
// ---------------------------------------------------------------------------

export function quantise(value: number, scale: number, min: number, max: number): number {
  return clamp(Math.round(value * scale), min, max) | 0;
}

export function packYaw(yaw: number): number {
  return (Math.round(((wrapAngle(yaw) + Math.PI) / TAU) * 65535) & 0xffff) >>> 0;
}

export function unpackYaw(v: number): number {
  return (v / 65535) * TAU - Math.PI;
}

export function packPitch(pitch: number): number {
  const p = clamp(pitch, -Math.PI / 2, Math.PI / 2);
  return clamp(Math.round((p / (Math.PI / 2)) * 32767), -32767, 32767) | 0;
}

export function unpackPitch(v: number): number {
  return (v / 32767) * (Math.PI / 2);
}
