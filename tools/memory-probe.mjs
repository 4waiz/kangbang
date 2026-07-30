#!/usr/bin/env node
/**
 * Memory probe.
 *
 * Loads the game, joins a match, plays for a while, then reports where the
 * memory actually went: JS heap, Three.js resource counts, and an estimate of
 * texture and geometry bytes on the GPU. Also re-samples after a forced GC to
 * separate live memory from garbage, and after two map loads to catch leaks.
 *
 *   node tools/memory-probe.mjs [--url http://localhost:5173] [--seconds 30]
 *
 * The point of this file is that "it uses too much memory" is not actionable
 * until you know which of those four numbers is the large one.
 */

import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const URL_BASE = argOf('url', process.env.KANG_CLIENT_URL ?? 'http://localhost:5173');
const SECONDS = Number(argOf('seconds', '25'));

function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const home = homedir();
  const candidates =
    platform() === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : platform() === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Walk the live Three.js scenes and total up what they actually hold. */
const SAMPLE = () => {
  const out = {
    heapUsed: performance.memory?.usedJSHeapSize ?? 0,
    heapTotal: performance.memory?.totalJSHeapSize ?? 0,
    info: null,
    textures: { count: 0, bytes: 0, list: [] },
    geometry: { count: 0, bytes: 0, verts: 0, tris: 0 },
    materials: { count: 0, byType: {} },
    meshes: 0,
    lods: 0,
  };

  const dbg = window.__kangDebug;
  if (!dbg) return out;

  const r = dbg.renderer;
  if (r?.info) {
    out.info = {
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
      programs: r.info.programs?.length ?? 0,
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
    };
  }

  const seenTex = new Set();
  const seenGeo = new Set();
  const seenMat = new Set();

  // Bytes per pixel including the full mip chain (x1.334).
  const texBytes = (t) => {
    const img = t.image;
    const w = img?.width ?? img?.videoWidth ?? 0;
    const h = img?.height ?? img?.videoHeight ?? 0;
    if (!w || !h) return 0;
    const faces = t.isCubeTexture ? 6 : 1;
    return Math.round(w * h * 4 * faces * (t.generateMipmaps === false ? 1 : 1.334));
  };

  const eatTexture = (t, label) => {
    if (!t || seenTex.has(t.uuid)) return;
    seenTex.add(t.uuid);
    const b = texBytes(t);
    out.textures.count++;
    out.textures.bytes += b;
    const w = t.image?.width ?? 0;
    const h = t.image?.height ?? 0;
    if (b > 0) out.textures.list.push({ label: label || t.name || 'unnamed', w, h, bytes: b });
  };

  const eatMaterial = (m) => {
    if (!m || seenMat.has(m.uuid)) return;
    seenMat.add(m.uuid);
    out.materials.count++;
    out.materials.byType[m.type] = (out.materials.byType[m.type] ?? 0) + 1;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'envMap', 'lightMap', 'bumpMap', 'displacementMap']) {
      if (m[key]) eatTexture(m[key], `${m.type}.${key}`);
    }
  };

  const eatGeometry = (g) => {
    if (!g || seenGeo.has(g.uuid)) return;
    seenGeo.add(g.uuid);
    out.geometry.count++;
    let bytes = 0;
    for (const name of Object.keys(g.attributes ?? {})) {
      const a = g.attributes[name];
      bytes += (a.array?.byteLength ?? 0);
    }
    if (g.index) bytes += g.index.array?.byteLength ?? 0;
    out.geometry.bytes += bytes;
    const pos = g.attributes?.position;
    if (pos) out.geometry.verts += pos.count;
    out.geometry.tris += g.index ? g.index.count / 3 : (pos ? pos.count / 3 : 0);
  };

  for (const scene of [dbg.scene, dbg.viewScene].filter(Boolean)) {
    if (scene.environment) eatTexture(scene.environment, 'scene.environment (PMREM)');
    if (scene.background) eatTexture(scene.background, 'scene.background (sky)');
    scene.traverse((o) => {
      if (o.isLOD) out.lods++;
      if (o.isMesh || o.isInstancedMesh || o.isSprite || o.isPoints || o.isLine) {
        out.meshes++;
        eatGeometry(o.geometry);
        const m = o.material;
        if (Array.isArray(m)) m.forEach(eatMaterial);
        else eatMaterial(m);
      }
    });
  }

  out.textures.list.sort((a, b) => b.bytes - a.bytes);
  out.textures.list = out.textures.list.slice(0, 12);
  return out;
};

function report(title, s) {
  console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 56 - title.length))}`);
  console.log(`  JS heap used      ${mb(s.heapUsed)}   (total ${mb(s.heapTotal)})`);
  if (s.info) {
    console.log(`  three.info        geometries=${s.info.geometries} textures=${s.info.textures} programs=${s.info.programs}`);
    console.log(`  draw calls        ${s.info.calls}  triangles=${s.info.triangles.toLocaleString()}`);
  }
  console.log(`  GPU textures      ${s.textures.count} textures  ~${mb(s.textures.bytes)}`);
  console.log(`  GPU geometry      ${s.geometry.count} geometries ~${mb(s.geometry.bytes)}  (${s.geometry.verts.toLocaleString()} verts, ${Math.round(s.geometry.tris).toLocaleString()} tris)`);
  console.log(`  meshes / LODs     ${s.meshes} / ${s.lods}`);
  console.log(`  materials         ${s.materials.count}  ${JSON.stringify(s.materials.byType)}`);
  if (s.textures.list.length) {
    console.log('  biggest textures:');
    for (const t of s.textures.list) console.log(`      ${mb(t.bytes).padStart(9)}  ${String(t.w)}x${t.h}  ${t.label}`);
  }
}

const executablePath = findBrowser();
if (!executablePath) {
  console.error('No Chrome or Edge found. Set CHROME_PATH.');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
    '--js-flags=--expose-gc',
    '--window-size=1280,720',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));

  console.log(`target: ${URL_BASE}`);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the menu, then measure the idle baseline.
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!document.querySelector('.menu__nav'))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const atMenu = await page.evaluate(SAMPLE);
  report('at main menu (no map loaded)', atMenu);

  // Join a match. QUICK PLAY opens a mode picker, so a card has to be clicked
  // too - measuring without that gives you the menu, not a loaded map.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.btn')].find((n) => (n.textContent ?? '').includes('QUICK PLAY'));
    b?.click();
  });
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !!document.querySelector('.cards .card'))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.evaluate(() => {
    document.querySelector('.cards .card')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  let joined = false;
  for (let i = 0; i < 160; i++) {
    joined = await page.evaluate(() => document.getElementById('hud')?.hidden === false);
    if (joined) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!joined) {
    console.error('\nFAILED to join a match - the numbers would be the menu, not a map. Aborting.');
    await browser.close();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const inMatch = await page.evaluate(SAMPLE);
  report(`in match, after ${SECONDS}s of play`, inMatch);

  // Forced GC separates live memory from garbage.
  await page.evaluate(() => {
    if (typeof globalThis.gc === 'function') globalThis.gc();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const afterGc = await page.evaluate(SAMPLE);
  report('after forced GC', afterGc);

  console.log('\n=== summary ===');
  console.log(`  menu -> match heap growth   ${mb(inMatch.heapUsed - atMenu.heapUsed)}`);
  console.log(`  garbage reclaimed by GC     ${mb(Math.max(0, inMatch.heapUsed - afterGc.heapUsed))}`);
  console.log(`  live heap in a match        ${mb(afterGc.heapUsed)}`);
  console.log(`  GPU textures                ~${mb(afterGc.textures.bytes)}`);
  console.log(`  GPU geometry                ~${mb(afterGc.geometry.bytes)}`);
  console.log(`  estimated total footprint   ~${mb(afterGc.heapUsed + afterGc.textures.bytes + afterGc.geometry.bytes)}`);
  if (errors.length) console.log(`\n  page errors: ${errors.slice(0, 3).join(' | ')}`);
  if (!afterGc.info) {
    console.log('\n  NOTE: window.__kangDebug was not found, so only the JS heap is real.');
    console.log('  Expose the renderer and scenes on it to get the GPU breakdown.');
  }
} finally {
  await browser.close();
}
