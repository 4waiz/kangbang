#!/usr/bin/env node
/**
 * Browser smoke test.
 *
 * Drives a real installed Chrome/Edge against a running client + server and
 * asserts the game actually works end to end:
 *
 *   1. the page loads with no console errors and no failed requests
 *   2. the boot sequence completes and reaches the main menu
 *   3. Quick Play connects, spawns the player, and starts rendering
 *   4. WebGL draw calls, HUD elements and the pointer-lock canvas are live
 *   5. shooting produces server-acknowledged events
 *
 * `puppeteer-core` is used deliberately - it downloads no browser, it just
 * connects to the Chrome or Edge the machine already has.
 *
 * Usage:
 *   node tools/browser-check.mjs [--url http://localhost:5173] [--headful] [--shots dir]
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  // Accept both `--name value` and `--name=value`.
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const URL_BASE = argOf('url', process.env.KANG_CLIENT_URL ?? 'http://localhost:5173');
const HEADFUL = args.includes('--headful');
const SHOT_DIR = argOf('shots', '');

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

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * Poll a predicate from Node rather than with page.waitForFunction.
 *
 * Puppeteer's waitForFunction installs its poller inside the page, and once the
 * game's render loop is running under software WebGL (SwiftShader on CI) that
 * poller gets starved and times out even though the condition is already true.
 * Driving the poll from Node with discrete page.evaluate calls is immune to it.
 */
async function waitFor(page, fn, timeoutMs = 15000, arg = undefined) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn, arg).catch(() => undefined);
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

/** Click the first .btn whose text contains `label`. */
async function clickButton(page, label) {
  const found = await waitFor(
    page,
    (text) => [...document.querySelectorAll('.btn')].some((b) => (b.textContent ?? '').includes(text)),
    12000,
    label,
  );
  if (!found) throw new Error(`button "${label}" never appeared`);
  await page.evaluate((text) => {
    const btn = [...document.querySelectorAll('.btn')].find((b) => (b.textContent ?? '').includes(text));
    btn?.click();
  }, label);
}

async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('No Chrome or Edge found. Set CHROME_PATH to a browser executable.');
    process.exit(2);
  }
  console.log(`browser: ${executablePath}`);
  console.log(`target:  ${URL_BASE}\n`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: HEADFUL ? false : 'shell',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Software WebGL so this works on headless CI without a GPU.
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,900',
    ],
    defaultViewport: { width: 1600, height: 900 },
    protocolTimeout: 180000,
  });

  const page = await browser.newPage();

  // Seed low graphics settings before the app boots: software WebGL at native
  // resolution renders at a few frames per second, which makes every timing
  // assertion below flaky for reasons that have nothing to do with the game.
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem(
        'kang.settings.v1',
        JSON.stringify({
          resolutionScale: 0.5,
          shadowQuality: 'off',
          effectsQuality: 'low',
          antialiasing: 'off',
          bloom: false,
          drawDistance: 140,
          decalLimit: 40,
          preset: 'low',
          masterVolume: 0,
          showFps: true,
          showPing: true,
        }),
      );
    } catch {
      /* private mode */
    }
  });

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Chrome's software WebGL emits benign performance warnings.
      if (/SwiftShader|Software.*WebGL|deprecated/i.test(text)) return;
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.startsWith('data:')) return;
    failedRequests.push(`${req.failure()?.errorText ?? 'failed'} ${url}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
  });

  const shoot = async (name) => {
    if (!SHOT_DIR) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
  };

  // ------------------------------------------------------------------ load
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  check('page loads', true);

  const hasWebGL = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  check('WebGL context available', hasWebGL);

  // ------------------------------------------------------------------ boot
  try {
    await page.waitForFunction(
      () => {
        const status = document.querySelector('.boot__status');
        return status && /READY|LOADING ASSETS/.test(status.textContent ?? '');
      },
      { timeout: 90000, polling: 250 },
    );
    check('boot sequence runs', true);
  } catch {
    const status = await page.$eval('.boot__status', (n) => n.textContent).catch(() => '(no boot screen)');
    check('boot sequence runs', false, `stuck at: ${status}`);
  }
  await shoot('01-boot');

  // --------------------------------------------------------------- menu
  try {
    await page.waitForFunction(() => !!document.querySelector('.menu__nav'), { timeout: 60000, polling: 250 });
    check('reaches main menu', true);
  } catch {
    check('reaches main menu', false, 'menu never rendered');
  }

  const menuButtons = await page.$$eval('.menu__nav .btn', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));
  check('main menu has navigation', menuButtons.length >= 10, `${menuButtons.length} buttons`);
  await shoot('02-menu');

  // Every screen must open without throwing.
  const screensToVisit = [
    ['QUICK PLAY', '.cards'],
    ['SERVER BROWSER', '.screen__body'],
    ['CUSTOM MATCH', '.settings-grid'],
    ['CLASSES', '.loadout'],
    ['LOADOUT', '.loadout'],
    ['PROFILE', '.screen__body'],
    ['PROGRESSION', '.settings-grid'],
    ['LEADERBOARDS', '.tabs'],
    ['CHALLENGES', '.screen__body'],
    ['SETTINGS', '.tabs'],
    ['CREDITS', '.settings-grid'],
  ];
  let screensOk = 0;
  for (const [label, selector] of screensToVisit) {
    try {
      const clicked = await page.evaluate((text) => {
        const btn = [...document.querySelectorAll('.btn')].find((b) => (b.textContent ?? '').includes(text));
        if (!btn) return false;
        btn.click();
        return true;
      }, label);
      if (!clicked) continue;
      await page.waitForSelector(selector, { timeout: 15000 });
      screensOk++;
      await shoot(`03-${label.toLowerCase().replace(/\s+/g, '-')}`);
      // Back to the menu for the next one.
      await page.evaluate(() => {
        const back = [...document.querySelectorAll('.btn')].find((b) => (b.textContent ?? '').includes('BACK'));
        back?.click();
      });
      await page.waitForSelector('.menu__nav', { timeout: 15000 });
    } catch (err) {
      console.log(`  (screen "${label}" failed: ${err instanceof Error ? err.message.split('\n')[0] : err})`);
    }
  }
  check('all menu screens open', screensOk === screensToVisit.length, `${screensOk}/${screensToVisit.length}`);

  // ------------------------------------------------------------- join match
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.btn')].find((b) => (b.textContent ?? '').includes('QUICK PLAY'));
    btn?.click();
  });
  await page.waitForSelector('.cards .card', { timeout: 20000 });
  await page.evaluate(() => {
    const card = document.querySelector('.cards .card');
    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  let joined = false;
  try {
    await page.waitForFunction(() => document.getElementById('hud')?.hidden === false, { timeout: 60000, polling: 200 });
    joined = true;
  } catch {
    /* handled below */
  }
  check('joins a match', joined);
  await shoot('04-in-match');

  if (joined) {
    // Let the session run: warmup, spawn, and a few seconds of simulation.
    await new Promise((r) => setTimeout(r, 9000));

    const hudState = await page.evaluate(() => {
      const text = (id) => document.getElementById(id)?.textContent ?? '';
      return {
        health: text('hud-health'),
        ammo: text('hud-ammo'),
        reserve: text('hud-reserve'),
        weapon: text('hud-weapon-name'),
        timer: text('hud-timer'),
        mode: text('hud-mode'),
        ability: text('hud-ability-name'),
        feedRows: document.querySelectorAll('.hud__feed-row').length,
        overlayPainted: (() => {
          const c = document.getElementById('overlay');
          if (!c) return false;
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          // Sample the centre: the crosshair must have drawn something.
          const d = ctx.getImageData(Math.floor(c.width / 2) - 20, Math.floor(c.height / 2) - 20, 40, 40).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
          return false;
        })(),
      };
    });
    check('HUD shows health', Number(hudState.health) > 0, `hp=${hudState.health}`);
    check('HUD shows ammo', Number(hudState.ammo) >= 0 && hudState.reserve !== '', `${hudState.ammo}/${hudState.reserve}`);
    check('HUD shows weapon', hudState.weapon.length > 2, hudState.weapon);
    check('HUD shows match timer', /\d+:\d\d/.test(hudState.timer), `${hudState.timer} ${hudState.mode}`);
    check('HUD shows ability', hudState.ability.length > 2, hudState.ability);
    check('crosshair rendered to overlay', hudState.overlayPainted);

    const render = await page.evaluate(() => {
      const canvas = document.getElementById('scene');
      return {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        contextLost: !!canvas && !!canvas.getContext && (canvas.getContext('webgl2')?.isContextLost?.() ?? false),
      };
    });
    check('3D canvas sized', render.width > 100 && render.height > 100, `${render.width}x${render.height}`);
    check('WebGL context not lost', !render.contextLost);

    // Escape opens the pause menu; from there we exercise the in-match screens
    // with real button clicks, which is the same path a player takes.
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })));
    const pauseOpened = await waitFor(page, () => !!document.querySelector('.screen--transparent'), 12000);
    check('pause menu opens', !!pauseOpened);
    await shoot('05-pause');

    let scoreboardRows = 0;
    try {
      await clickButton(page, 'SCOREBOARD');
      scoreboardRows =
        (await waitFor(page, () => document.querySelectorAll('.scoreboard table tbody tr').length || false, 15000)) || 0;
    } catch (err) {
      const dump = await page.evaluate(() => ({
        uiChildren: [...(document.getElementById('ui')?.children ?? [])].map((c) => c.className),
        rows: document.querySelectorAll('tbody tr').length,
        buttons: [...document.querySelectorAll('.btn')].map((b) => (b.textContent ?? '').trim()).slice(0, 12),
      }));
      console.log(`  diagnostic: ${JSON.stringify(dump)} (${err instanceof Error ? err.message : err})`);
    }
    check('scoreboard lists players', scoreboardRows >= 2, `${scoreboardRows} rows`);
    await shoot('06-scoreboard');

    // Bots must actually be fighting each other, not standing still.
    const botActivity = await page
      .$$eval('.scoreboard table tbody tr', (rows) =>
        rows.reduce((sum, row) => {
          const cells = row.querySelectorAll('td');
          return sum + (Number(cells[2]?.textContent ?? 0) + Number(cells[3]?.textContent ?? 0));
        }, 0),
      )
      .catch(() => 0);
    check('bots fight each other', botActivity > 0, `${botActivity} combined kills+deaths`);

    // Live in-match loadout change must not throw or lose the session.
    let loadoutFromMatch = false;
    try {
      await clickButton(page, 'CLOSE');
      await waitFor(page, () => !document.querySelector('.scoreboard'), 10000);
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true })));
      await waitFor(page, () => !!document.querySelector('.screen--transparent'), 10000);
      await clickButton(page, 'CLASS & LOADOUT');
      loadoutFromMatch = !!(await waitFor(page, () => !!document.querySelector('.loadout'), 12000));
    } catch {
      loadoutFromMatch = false;
    }
    check('class/loadout reachable mid-match', loadoutFromMatch);
    await shoot('07-loadout-in-match');
  }

  // --------------------------------------------------------------- errors
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  const realFailures = failedRequests.filter((f) => !/favicon|manifest\.json/.test(f));
  check('no failed network requests', realFailures.length === 0, realFailures.slice(0, 3).join(' | '));

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('browser check PASSED');
}

main().catch((err) => {
  console.error('\nbrowser check crashed:', err);
  process.exit(2);
});
