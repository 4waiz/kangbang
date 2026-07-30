/**
 * Client entry point.
 *
 * Order matters: styles first (so the boot screen renders correctly on the very
 * first frame), then the renderer, then input, then the app which owns
 * everything else.
 */

import './styles/base.css';
import './styles/hud.css';
import './styles/menu.css';

import { InputManager } from './engine/input.js';
import { Renderer } from './engine/renderer.js';
import { audio } from './engine/audio.js';
import { App } from './ui/app.js';
import { store } from './state/store.js';

function fail(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[kang]', message, detail);
  const ui = document.getElementById('ui');
  if (!ui) return;
  ui.innerHTML = `
    <div class="screen">
      <div class="boot">
        <h1>KANG BANG</h1>
        <div class="plate plate--ember" style="max-width:560px;text-align:left">
          <h3>${message}</h3>
          <p>${detail ? String(detail) : ''}</p>
          <p class="faint">
            This game needs a browser with WebGL2 and Web Audio. Try a recent
            Chrome, Edge, Firefox or Safari, and make sure hardware acceleration
            is enabled.
          </p>
        </div>
      </div>
    </div>`;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  const overlay = document.getElementById('overlay') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud');
  const uiRoot = document.getElementById('ui');
  if (!canvas || !overlay || !hudRoot || !uiRoot) {
    fail('Page failed to initialise', 'Expected canvas and UI containers are missing.');
    return;
  }

  // Load settings before anything reads them (UI scale, colourblind mode).
  store.load();

  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    fail('Could not create a WebGL context', err);
    return;
  }

  // Handle for tooling only: `tools/memory-probe.mjs` walks these to total up
  // what the GPU is actually holding. Read-only, and nothing in the game reads
  // it back, so it is safe to leave in the production bundle - "it uses too much
  // memory" is not actionable without a way to measure from outside.
  (window as unknown as { __kangDebug?: unknown }).__kangDebug = {
    renderer: renderer.renderer,
    scene: renderer.scene,
    viewScene: renderer.viewScene,
    rig: renderer,
  };

  const input = new InputManager(canvas);
  const app = new App(renderer, input, hudRoot, overlay, uiRoot);
  app.installKeyUp();

  // Audio must start from a gesture; the first click anywhere unlocks it.
  const unlock = () => {
    void audio.unlock();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: false });
  window.addEventListener('keydown', unlock, { once: false });

  // Clicking the canvas re-acquires pointer lock after an accidental release.
  canvas.addEventListener('pointerdown', () => {
    if (!input.isLocked && hudRoot.hidden === false) input.requestLock();
  });

  await app.boot();

  // Keep the render loop alive in menus too, so the 3D scene stays live behind
  // the UI instead of freezing on the last frame.
  const idleLoop = () => {
    requestAnimationFrame(idleLoop);
    if (!document.getElementById('hud')?.hidden) return; // session drives it
    renderer.render();
  };
  requestAnimationFrame(idleLoop);
}

void main().catch((err) => fail('Startup failed', err));
