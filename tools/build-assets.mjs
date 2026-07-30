#!/usr/bin/env node
/**
 * Asset build orchestrator.
 *
 * Finds Blender, runs the three generator scripts headlessly, then writes an
 * asset manifest that the client uses to know what exists (and therefore when
 * to fall back to a procedural placeholder instead of requesting a 404).
 *
 * Blender discovery order:
 *   1. BLENDER_PATH environment variable
 *   2. tools/.blender-path (written by this script once found)
 *   3. `blender` on PATH
 *   4. Common install locations, including the portable extraction this repo
 *      documents in BLENDER_PIPELINE.md
 *
 * Usage:
 *   node tools/build-assets.mjs                 # everything
 *   node tools/build-assets.mjs weapons props   # subset
 *   node tools/build-assets.mjs --check         # verify only, no Blender run
 *   node tools/build-assets.mjs --only pulse_ar # single model
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPTS_DIR = join(ROOT, 'assets', 'scripts');
const EXPORT_DIR = join(ROOT, 'packages', 'client', 'public', 'assets', 'models');
const MANIFEST_PATH = join(ROOT, 'packages', 'client', 'public', 'assets', 'manifest.json');
const BLENDER_HINT = join(HERE, '.blender-path');

const GENERATORS = {
  weapons: 'gen_weapons.py',
  characters: 'gen_characters.py',
  props: 'gen_props.py',
};

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const onlyIndex = args.indexOf('--only');
const onlyValue = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const requested = args.filter((a) => !a.startsWith('--') && a !== onlyValue);
const targets = requested.length > 0 ? requested : Object.keys(GENERATORS);

// ---------------------------------------------------------------------------

function candidateBlenderPaths() {
  const out = [];
  if (process.env.BLENDER_PATH) out.push(process.env.BLENDER_PATH);
  if (existsSync(BLENDER_HINT)) {
    const hinted = readFileSync(BLENDER_HINT, 'utf8').trim();
    if (hinted) out.push(hinted);
  }
  out.push('blender');

  const home = homedir();
  if (platform() === 'win32') {
    const roots = [
      'C:\\Program Files\\Blender Foundation',
      'C:\\Program Files (x86)\\Blender Foundation',
      join(home, 'AppData', 'Local', 'Programs', 'Blender Foundation'),
      join(home, 'AppData', 'Local', 'Programs', 'blender-portable'),
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      let entries = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const direct = join(root, entry, 'blender.exe');
        if (existsSync(direct)) out.push(direct);
      }
    }
  } else if (platform() === 'darwin') {
    out.push('/Applications/Blender.app/Contents/MacOS/Blender');
    out.push(join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  } else {
    out.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  return out;
}

function probe(cmd) {
  return new Promise((res) => {
    const child = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => res(null));
    child.on('close', (code) => {
      if (code === 0 && /blender/i.test(out)) res(out.split('\n')[0].trim());
      else res(null);
    });
  });
}

async function findBlender() {
  for (const cmd of candidateBlenderPaths()) {
    const version = await probe(cmd);
    if (version) return { cmd, version };
  }
  return null;
}

function runBlender(cmd, script, only) {
  return new Promise((res, rej) => {
    const argv = ['--background', '--factory-startup', '--python', join(SCRIPTS_DIR, script)];
    if (only) argv.push('--', `--only=${only}`);
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      for (const line of text.split('\n')) {
        if (line.includes('[kang]')) console.log('  ' + line.replace(/^.*\[neon\]\s*/, ''));
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code === 0) res({ stdout, stderr });
      else {
        const detail = [stdout, stderr]
          .join('\n')
          .split('\n')
          .filter((l) => /error|Error|Traceback|File "/.test(l))
          .slice(-25)
          .join('\n');
        rej(new Error(`${script} exited ${code}\n${detail}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------

function writeManifest() {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const files = existsSync(EXPORT_DIR) ? readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.glb')) : [];
  const models = {};
  let totalBytes = 0;
  for (const file of files.sort()) {
    const full = join(EXPORT_DIR, file);
    const size = statSync(full).size;
    totalBytes += size;
    models[file.replace(/\.glb$/, '')] = { file: `models/${file}`, bytes: size };
  }
  const manifest = {
    generated: 'blender',
    generator: 'assets/scripts/gen_*.py',
    note: 'Every model here is generated from source by the Blender scripts in assets/scripts. Regenerate with: npm run assets',
    count: files.length,
    totalBytes,
    models,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function verify(manifest) {
  // Expected keys are derived from the same data the game uses, so a renamed
  // weapon shows up as a missing asset instead of silently 404ing in game.
  const weapons = [
    'pulse_ar',
    'plasma_smg',
    'rail_sniper',
    'ion_shotgun',
    'particle_lmg',
    'burst_carbine',
    'energy_pistol',
    'tactical_revolver',
    'plasma_blade',
    'arc_launcher',
  ];
  const classes = ['vanguard', 'phantom', 'titan', 'warden', 'spectre', 'engineer'];
  const expected = [
    ...weapons.map((w) => `wpn_${w}`),
    ...weapons.map((w) => `wpn_${w}_world`),
    ...classes.map((c) => `char_${c}`),
    'char_arms_fp',
    'pickup_health',
    'pickup_shield',
    'pickup_ammo',
    'pickup_pedestal',
    'obj_zone_marker',
    'obj_core',
    'dep_turret',
    'dep_barrier',
    'dep_field',
    'dep_dome',
    'dep_grenade',
    'team_marker',
  ];
  const missing = expected.filter((k) => !manifest.models[k]);
  return { expected: expected.length, missing };
}

async function main() {
  console.log('KANG BANG asset build');

  if (checkOnly) {
    const manifest = writeManifest();
    const { expected, missing } = verify(manifest);
    console.log(`${manifest.count} GLB files, ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MB total`);
    if (missing.length > 0) {
      console.log(`MISSING ${missing.length}/${expected}: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log(`all ${expected} required models present`);
    return;
  }

  const blender = await findBlender();
  if (!blender) {
    console.error('Blender not found.');
    console.error('Install it, or set BLENDER_PATH, or extract the portable build:');
    console.error('  see docs/BLENDER_PIPELINE.md for the exact commands');
    console.error('The game still runs without this step: the client falls back to');
    console.error('procedural placeholder meshes for any model that is missing.');
    process.exit(1);
  }
  console.log(`using ${blender.version}`);
  console.log(`  ${blender.cmd}`);
  try {
    writeFileSync(BLENDER_HINT, blender.cmd);
  } catch {
    /* hint file is a convenience only */
  }

  mkdirSync(EXPORT_DIR, { recursive: true });
  const started = Date.now();
  for (const target of targets) {
    const script = GENERATORS[target];
    if (!script) {
      console.error(`unknown target "${target}". Valid: ${Object.keys(GENERATORS).join(', ')}`);
      process.exit(2);
    }
    console.log(`\n>> ${target}`);
    await runBlender(blender.cmd, script, onlyValue);
  }

  const manifest = writeManifest();
  const { expected, missing } = verify(manifest);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\ndone in ${secs}s - ${manifest.count} models, ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MB`,
  );
  if (missing.length > 0 && requested.length === 0 && !onlyValue) {
    console.log(`WARNING missing ${missing.length}/${expected}: ${missing.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nasset build failed:\n' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
