#!/usr/bin/env node
/**
 * Open several real browser windows against the dev client so you can play a
 * multiplayer match against yourself.
 *
 *   node tools/open-clients.mjs                 # 2 windows, tiled
 *   node tools/open-clients.mjs --count=4
 *   node tools/open-clients.mjs --url=http://localhost:4173
 *   node tools/open-clients.mjs --code=ABCD     # every window joins one room
 *
 * Each window gets its own Chrome profile directory. That matters: the guest
 * identity is stored in localStorage, so windows sharing a profile would all be
 * the same player and the server would treat the second one as a reconnect.
 *
 * The profiles live under the OS temp directory and are removed on exit unless
 * --keep is passed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const COUNT = Math.max(1, Math.min(8, Number(argOf('count', '2')) || 2));
const URL_BASE = argOf('url', process.env.NEON_CLIENT_URL ?? 'http://localhost:5173');
const ROOM_CODE = argOf('code', '');
const KEEP = args.includes('--keep');

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
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : platform() === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Tile the windows across a 1920x1080-ish desktop without overlapping much. */
function layout(index, total) {
  const cols = total <= 2 ? 2 : total <= 4 ? 2 : 3;
  const rows = Math.ceil(total / cols);
  const w = Math.floor(1600 / cols);
  const h = Math.floor(980 / rows);
  return {
    width: Math.max(900, w),
    height: Math.max(620, h),
    x: 40 + (index % cols) * (w + 12),
    y: 40 + Math.floor(index / cols) * (h + 40),
  };
}

const browser = findBrowser();
if (!browser) {
  console.error('No Chrome or Edge found. Set CHROME_PATH to a browser executable.');
  process.exit(1);
}

// Fail fast with a useful message rather than opening N windows onto nothing.
try {
  const res = await fetch(URL_BASE, { method: 'GET', signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`Cannot reach the client at ${URL_BASE} (${err.message}).`);
  console.error('Start it first with `npm run dev`, or pass --url=<address>.');
  process.exit(1);
}

const profileRoot = join(tmpdir(), 'kang-bang-clients');
mkdirSync(profileRoot, { recursive: true });

const children = [];
const profiles = [];

for (let i = 0; i < COUNT; i++) {
  const box = layout(i, COUNT);
  const profile = join(profileRoot, `client-${i + 1}-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  profiles.push(profile);

  const url = ROOM_CODE ? `${URL_BASE}/?code=${encodeURIComponent(ROOM_CODE)}` : URL_BASE;
  const child = spawn(
    browser,
    [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      `--window-size=${box.width},${box.height}`,
      `--window-position=${box.x},${box.y}`,
      // Autoplay would otherwise gate the Web Audio context behind a click in
      // every single window.
      '--autoplay-policy=no-user-gesture-required',
      url,
    ],
    { stdio: 'ignore', detached: false },
  );
  children.push(child);
  console.log(`client ${i + 1}/${COUNT}  ${box.width}x${box.height} at ${box.x},${box.y}  ->  ${url}`);
}

console.log('');
console.log(`${COUNT} client window(s) open. Each is a separate guest player.`);
console.log('In one window: QUICK PLAY (or CREATE ROOM and share the code).');
console.log('In the others: SERVER BROWSER -> join, or JOIN BY CODE.');
console.log('');
console.log('Press Ctrl+C here to close every window.');

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  if (!KEEP) {
    for (const dir of profiles) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Chrome can still hold a lock for a moment; leaving a temp dir behind
        // is not worth failing the command over.
      }
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Exit once every window has been closed by hand.
let alive = children.length;
for (const child of children) {
  child.on('exit', () => {
    alive -= 1;
    if (alive === 0) shutdown();
  });
}
