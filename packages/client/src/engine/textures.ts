/**
 * Procedural textures.
 *
 * All surface detail is generated into canvases at load time rather than shipped
 * as image files. That keeps the initial download tiny (the whole texture set is
 * a few hundred lines of code instead of megabytes of PNGs), makes every
 * material original by construction, and lets texture quality be a real setting
 * because we just render the same patterns at a smaller resolution.
 */

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { MATERIALS, type MaterialDef } from '@neon/shared';

export type TextureQuality = 'low' | 'medium' | 'high';

const SIZES: Record<TextureQuality, number> = { low: 128, medium: 256, high: 512 };

const cache = new Map<string, Texture>();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('2D canvas unavailable - cannot generate textures');
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement, repeat = 1): Texture {
  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Deterministic value noise so textures are identical across sessions. */
function noise2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    const xi = Math.floor(x * freq);
    const yi = Math.floor(y * freq);
    const fx = x * freq - xi;
    const fy = y * freq - yi;
    const a = noise2(xi, yi, seed + o);
    const b = noise2(xi + 1, yi, seed + o);
    const c = noise2(xi, yi + 1, seed + o);
    const d = noise2(xi + 1, yi + 1, seed + o);
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const top = a + (b - a) * ux;
    const bottom = c + (d - c) * ux;
    sum += (top + (bottom - top) * uy) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function shade(color: number, amount: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount * 255)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

// ---------------------------------------------------------------------------
// Pattern painters
// ---------------------------------------------------------------------------

function paintPlain(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  ctx.fillStyle = hex(def.color);
  ctx.fillRect(0, 0, size, size);
  // Very light grain so flat surfaces are not perfectly uniform under lights.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const p = (i / 4) | 0;
    const n = (noise2(p % size, (p / size) | 0, seed) - 0.5) * 12;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

function paintPanel(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  paintPlain(ctx, size, def, seed);
  const cell = size / 4;
  ctx.lineWidth = Math.max(1, size / 128);
  // Panel seams.
  ctx.strokeStyle = shade(def.color, -0.16);
  for (let i = 0; i <= 4; i++) {
    const p = Math.round(i * cell);
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  // Highlight along the top-left of each panel for a bevelled read.
  ctx.strokeStyle = shade(def.color, 0.1);
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x = gx * cell + 1.5;
      const y = gy * cell + 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + cell - 3);
      ctx.lineTo(x, y);
      ctx.lineTo(x + cell - 3, y);
      ctx.stroke();
      // Occasional recessed vent or bolt cluster.
      if (noise2(gx, gy, seed) > 0.62) {
        ctx.fillStyle = shade(def.color, -0.22);
        const vw = cell * 0.42;
        const vh = cell * 0.18;
        ctx.fillRect(x + cell * 0.28, y + cell * 0.34, vw, vh);
        ctx.fillStyle = shade(def.color, -0.05);
        for (let s = 0; s < 3; s++) {
          ctx.fillRect(x + cell * 0.3 + s * (vw / 3), y + cell * 0.36, vw / 8, vh * 0.7);
        }
      } else if (noise2(gx + 7, gy + 3, seed) > 0.7) {
        ctx.fillStyle = shade(def.color, -0.3);
        for (const [bx, by] of [
          [0.18, 0.18],
          [0.82, 0.18],
          [0.18, 0.82],
          [0.82, 0.82],
        ]) {
          ctx.beginPath();
          ctx.arc(x + cell * bx, y + cell * by, Math.max(1, cell * 0.035), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
}

function paintGrid(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  paintPlain(ctx, size, def, seed);
  const cell = size / 8;
  ctx.strokeStyle = shade(def.color, -0.2);
  ctx.lineWidth = Math.max(1, size / 200);
  for (let i = 0; i <= 8; i++) {
    const p = Math.round(i * cell);
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  if (def.emissive !== 0) {
    ctx.strokeStyle = hex(def.emissive);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(1, size / 160);
    for (let i = 0; i <= 8; i += 4) {
      const p = Math.round(i * cell);
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function paintGrate(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  ctx.fillStyle = shade(def.color, -0.34);
  ctx.fillRect(0, 0, size, size);
  const bar = size / 10;
  ctx.fillStyle = hex(def.color);
  for (let i = 0; i < 10; i++) {
    ctx.fillRect(Math.round(i * bar), 0, Math.max(1, bar * 0.6), size);
  }
  ctx.fillStyle = shade(def.color, -0.1);
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(0, Math.round(i * (size / 4)), size, Math.max(1, size / 40));
  }
  // Wear along the bar edges.
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = shade(def.color, 0.12);
  for (let i = 0; i < 10; i++) {
    if (noise2(i, 3, seed) > 0.55) ctx.fillRect(Math.round(i * bar), 0, 1, size);
  }
  ctx.globalAlpha = 1;
}

function paintHazard(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  ctx.fillStyle = hex(def.color);
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.fillStyle = '#161616';
  const stripe = size / 6;
  ctx.translate(-size, 0);
  ctx.rotate(-Math.PI / 4);
  for (let i = -4; i < 20; i++) {
    ctx.fillRect(i * stripe * 2, -size, stripe, size * 4);
  }
  ctx.restore();
  // Scuffs.
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#000';
  for (let i = 0; i < 24; i++) {
    const x = noise2(i, 1, seed) * size;
    const y = noise2(i, 2, seed) * size;
    ctx.fillRect(x, y, size * 0.06, size * 0.02);
  }
  ctx.globalAlpha = 1;
}

function paintCircuit(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  paintPlain(ctx, size, def, seed);
  const step = size / 16;
  ctx.lineWidth = Math.max(1, size / 170);
  ctx.strokeStyle = def.emissive !== 0 ? hex(def.emissive) : shade(def.color, 0.2);
  ctx.globalAlpha = 0.5;
  // Manhattan traces that wander then terminate at a pad.
  for (let t = 0; t < 14; t++) {
    let x = Math.floor(noise2(t, 11, seed) * 16) * step;
    let y = Math.floor(noise2(t, 22, seed) * 16) * step;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 3 + Math.floor(noise2(t, 33, seed) * 4);
    for (let s = 0; s < segs; s++) {
      const horizontal = noise2(t * 10 + s, 44, seed) > 0.5;
      const len = (1 + Math.floor(noise2(t * 10 + s, 55, seed) * 3)) * step;
      if (horizontal) x += noise2(t * 10 + s, 66, seed) > 0.5 ? len : -len;
      else y += noise2(t * 10 + s, 77, seed) > 0.5 ? len : -len;
      x = Math.max(0, Math.min(size, x));
      y = Math.max(0, Math.min(size, y));
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, step * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function paintGlass(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = hex(def.color);
  ctx.globalAlpha = 0.22;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = 1;
  // Frame mullions.
  ctx.strokeStyle = shade(def.color, -0.4);
  ctx.lineWidth = Math.max(2, size / 64);
  ctx.strokeRect(0, 0, size, size);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  // Specular streak.
  const g = ctx.createLinearGradient(0, size, size, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, `rgba(255,255,255,${0.1 + noise2(1, 1, seed) * 0.08})`);
  g.addColorStop(0.55, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

function paintNoise(ctx: CanvasRenderingContext2D, size: number, def: MaterialDef, seed: number): void {
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const r = (def.color >> 16) & 0xff;
  const g = (def.color >> 8) & 0xff;
  const b = def.color & 0xff;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size * 6, y / size * 6, seed, 5);
      const v = (n - 0.5) * 52;
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, r + v));
      data[i + 1] = Math.max(0, Math.min(255, g + v));
      data[i + 2] = Math.max(0, Math.min(255, b + v));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Occasional crack / expansion joint.
  ctx.strokeStyle = shade(def.color, -0.25);
  ctx.lineWidth = Math.max(1, size / 220);
  for (let c = 0; c < 3; c++) {
    ctx.beginPath();
    let x = noise2(c, 90, seed) * size;
    let y = 0;
    ctx.moveTo(x, y);
    while (y < size) {
      y += size / 12;
      x += (noise2(c * 20 + y, 91, seed) - 0.5) * size * 0.12;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function materialTexture(key: string, quality: TextureQuality): Texture {
  const cacheKey = `${key}:${quality}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const def = MATERIALS[key] ?? MATERIALS.concrete;
  const size = SIZES[quality];
  const { canvas, ctx } = makeCanvas(size);
  const seed = hashKey(key);

  switch (def.pattern) {
    case 'panel':
      paintPanel(ctx, size, def, seed);
      break;
    case 'grid':
      paintGrid(ctx, size, def, seed);
      break;
    case 'grate':
      paintGrate(ctx, size, def, seed);
      break;
    case 'hazard':
      paintHazard(ctx, size, def, seed);
      break;
    case 'circuit':
      paintCircuit(ctx, size, def, seed);
      break;
    case 'glass':
      paintGlass(ctx, size, def, seed);
      break;
    case 'noise':
      paintNoise(ctx, size, def, seed);
      break;
    default:
      paintPlain(ctx, size, def, seed);
      break;
  }

  const tex = toTexture(canvas, 1);
  cache.set(cacheKey, tex);
  return tex;
}

/** Radial sprite used by every additive particle. */
export function sparkTexture(): Texture {
  const hit = cache.get('spark');
  if (hit) return hit;
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = toTexture(canvas);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  cache.set('spark', tex);
  return tex;
}

/** Soft ring used for shockwaves and capture-zone floors. */
export function ringTexture(): Texture {
  const hit = cache.get('ring');
  if (hit) return hit;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = size * 0.05;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = size * 0.14;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  ctx.stroke();
  const tex = toTexture(canvas);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  cache.set('ring', tex);
  return tex;
}

/** Bullet hole decal: a dark core with a bright rim and radial cracks. */
export function decalTexture(): Texture {
  const hit = cache.get('decal');
  if (hit) return hit;
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(6,8,12,0.95)');
  g.addColorStop(0.45, 'rgba(18,22,30,0.8)');
  g.addColorStop(0.72, 'rgba(90,110,140,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,190,220,0.4)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + noise2(i, 5, 7) * 0.5;
    const len = c * (0.42 + noise2(i, 6, 7) * 0.4);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * c * 0.2, c + Math.sin(a) * c * 0.2);
    ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
    ctx.stroke();
  }
  const tex = toTexture(canvas);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  cache.set('decal', tex);
  return tex;
}

/**
 * Skybox: a 2:1 equirectangular gradient with stars, nebula bands and a horizon
 * glow tuned per map. Cheap, and it sells the setting far better than a flat
 * clear colour.
 */
export function skyTexture(kind: string, quality: TextureQuality): Texture {
  const cacheKey = `sky:${kind}:${quality}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const h = quality === 'low' ? 256 : quality === 'medium' ? 512 : 1024;
  const w = h * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  const palettes: Record<string, { top: string; mid: string; bottom: string; accent: string; stars: number }> = {
    foundry: { top: '#0a1220', mid: '#182a3c', bottom: '#2a1c14', accent: '#ff8a3c', stars: 260 },
    orbital: { top: '#02040c', mid: '#080f22', bottom: '#0d1830', accent: '#4fd8ff', stars: 1400 },
    mirage: { top: '#120a20', mid: '#2a1240', bottom: '#4a1a3a', accent: '#ff3ec8', stars: 520 },
  };
  const p = palettes[kind] ?? palettes.orbital;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, p.top);
  grad.addColorStop(0.55, p.mid);
  grad.addColorStop(1, p.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Nebula bands.
  for (let band = 0; band < 4; band++) {
    const y = h * (0.25 + band * 0.16);
    const g2 = ctx.createLinearGradient(0, y - h * 0.1, 0, y + h * 0.1);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(0.5, `${p.accent}22`);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, y - h * 0.1, w, h * 0.2);
  }

  // Cloud/dust using fbm, sparse so it reads as depth not fog.
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const n = fbm((x / w) * 8, (y / h) * 4, 31, 4);
      if (n < 0.56) continue;
      const a = (n - 0.56) * 0.9;
      const i = (y * w + x) * 4;
      data[i] = Math.min(255, data[i] + 90 * a);
      data[i + 1] = Math.min(255, data[i + 1] + 100 * a);
      data[i + 2] = Math.min(255, data[i + 2] + 130 * a);
    }
  }
  ctx.putImageData(img, 0, 0);

  // Stars, denser near the zenith.
  for (let i = 0; i < p.stars; i++) {
    const x = noise2(i, 101, 5) * w;
    const yn = noise2(i, 202, 5);
    const y = yn * yn * h * 0.85;
    const r = 0.4 + noise2(i, 303, 5) * 1.4;
    const a = 0.25 + noise2(i, 404, 5) * 0.75;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // A couple of distant structures on the horizon for scale.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = p.accent;
  for (let i = 0; i < 3; i++) {
    const x = (0.2 + i * 0.3) * w;
    const r = h * (0.02 + noise2(i, 9, 3) * 0.03);
    ctx.beginPath();
    ctx.arc(x, h * 0.78, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  cache.set(cacheKey, tex);
  return tex;
}

function hashKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Drop every cached texture; used when texture quality changes. */
export function clearTextureCache(): void {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}
