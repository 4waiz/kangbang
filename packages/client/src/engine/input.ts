/**
 * Input.
 *
 * Owns pointer lock, key/mouse state, rebindable actions and the raw mouse
 * delta accumulator. Mouse deltas are accumulated between simulation steps
 * rather than sampled, so sensitivity is frame-rate independent and no motion
 * is ever dropped.
 *
 * `movementX` from Pointer Lock is already OS-accelerated on some platforms;
 * when `unadjustedMovement` is available we ask for the raw signal instead,
 * which is what the "Raw mouse input" setting exposes.
 */

import { ACTIONS, clamp } from '@kang/shared';
import { store } from '../state/store.js';

export type ActionId = string;

interface PointerLockOptions {
  unadjustedMovement?: boolean;
}

export class InputManager {
  /** Accumulated look delta in raw device units, consumed by the camera. */
  private lookDx = 0;
  private lookDy = 0;
  /** Wheel notches accumulated since the last read. */
  private wheelDelta = 0;

  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();
  private actionToCodes = new Map<ActionId, string[]>();
  private locked = false;
  private lockRequested = false;
  private enabled = false;
  private canvas: HTMLElement;
  /** Set while a rebinding capture is in progress. */
  private captureResolver: ((code: string) => void) | null = null;
  private listeners: (() => void)[] = [];
  /** Suppressed while a text field has focus. */
  private textFocus = false;

  onLockChange: (locked: boolean) => void = () => undefined;
  onEscape: () => void = () => undefined;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    this.rebuildBindings();
    store.on('bindings', () => this.rebuildBindings());
    this.install();
  }

  private rebuildBindings(): void {
    this.actionToCodes.clear();
    for (const action of ACTIONS) {
      const code = store.bindings[action.id] ?? action.default;
      const list = this.actionToCodes.get(action.id) ?? [];
      list.push(code);
      this.actionToCodes.set(action.id, list);
    }
  }

  private install(): void {
    const add = <K extends keyof DocumentEventMap>(
      target: EventTarget,
      type: K | string,
      fn: (ev: Event) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.listeners.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    add(window, 'keydown', (ev) => this.onKeyDown(ev as KeyboardEvent));
    add(window, 'keyup', (ev) => this.onKeyUp(ev as KeyboardEvent));
    add(window, 'mousedown', (ev) => this.onMouseDown(ev as MouseEvent));
    add(window, 'mouseup', (ev) => this.onMouseUp(ev as MouseEvent));
    add(window, 'wheel', (ev) => this.onWheel(ev as WheelEvent), { passive: false });
    add(document, 'mousemove', (ev) => this.onMouseMove(ev as MouseEvent));
    add(document, 'pointerlockchange', () => this.onPointerLockChange());
    add(document, 'pointerlockerror', () => {
      this.lockRequested = false;
    });
    add(window, 'blur', () => this.releaseAll());
    add(document, 'contextmenu', (ev) => {
      if (this.locked) ev.preventDefault();
    });
    add(document, 'focusin', (ev) => {
      const t = ev.target as HTMLElement | null;
      this.textFocus = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    });
    add(document, 'focusout', () => {
      this.textFocus = false;
    });
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
  }

  // -- pointer lock -------------------------------------------------------

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    if (this.locked || this.lockRequested) return;
    this.lockRequested = true;
    const el = this.canvas as HTMLElement & {
      requestPointerLock(options?: PointerLockOptions): Promise<void> | void;
    };
    try {
      const wantRaw = store.bool('rawInput');
      const result = el.requestPointerLock(wantRaw ? { unadjustedMovement: true } : undefined);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {
          // unadjustedMovement is not supported everywhere; retry plain.
          try {
            (el as HTMLElement).requestPointerLock();
          } catch {
            this.lockRequested = false;
          }
        });
      }
    } catch {
      this.lockRequested = false;
    }
  }

  /**
   * Release pointer lock deliberately (opening a menu).
   *
   * The `selfReleased` flag matters: losing the lock is normally the signal
   * that the player hit Escape, and the UI reacts by opening the pause menu.
   * When *we* drop the lock to show a screen, that reaction would immediately
   * bounce the player from the screen they just opened back to pause.
   */
  releaseLock(): void {
    this.lockRequested = false;
    if (document.pointerLockElement) {
      this.selfReleased = true;
      document.exitPointerLock();
    }
  }

  private selfReleased = false;

  private onPointerLockChange(): void {
    const wasLocked = this.locked;
    this.locked = document.pointerLockElement === this.canvas;
    this.lockRequested = false;
    if (!this.locked) {
      this.releaseAll();
      const userInitiated = wasLocked && !this.selfReleased;
      this.selfReleased = false;
      if (userInitiated) this.onEscape();
    } else {
      this.selfReleased = false;
    }
    this.onLockChange(this.locked);
  }

  /** Gameplay input is only read while enabled AND locked. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  // -- raw events ---------------------------------------------------------

  private onKeyDown(ev: KeyboardEvent): void {
    if (this.captureResolver) {
      ev.preventDefault();
      const resolver = this.captureResolver;
      this.captureResolver = null;
      resolver(ev.code);
      return;
    }
    if (ev.code === 'Escape') {
      // Escape always reaches the UI, locked or not.
      this.onEscape();
      return;
    }
    if (this.textFocus) return;
    if (this.down.has(ev.code)) return;
    this.down.add(ev.code);
    this.pressedThisFrame.add(ev.code);
    // Stop the browser scrolling / activating shortcuts during play.
    if (this.enabled && SWALLOW_KEYS.has(ev.code)) ev.preventDefault();
  }

  private onKeyUp(ev: KeyboardEvent): void {
    if (this.textFocus) return;
    if (this.down.delete(ev.code)) this.releasedThisFrame.add(ev.code);
  }

  private onMouseDown(ev: MouseEvent): void {
    const code = `Mouse${ev.button}`;
    if (this.captureResolver) {
      ev.preventDefault();
      const resolver = this.captureResolver;
      this.captureResolver = null;
      resolver(code);
      return;
    }
    if (!this.locked) return;
    if (!this.down.has(code)) this.pressedThisFrame.add(code);
    this.down.add(code);
    if (ev.button === 1 || ev.button === 2) ev.preventDefault();
  }

  private onMouseUp(ev: MouseEvent): void {
    const code = `Mouse${ev.button}`;
    if (this.down.delete(code)) this.releasedThisFrame.add(code);
  }

  private onWheel(ev: WheelEvent): void {
    /*
     * A wheel event is only a weapon switch if it actually moved vertically.
     *
     * `deltaY < 0 ? 1 : -1` treated deltaY === 0 as a scroll DOWN, so every
     * zero-delta event cycled the weapon backwards - and zero-delta events are
     * common: horizontal trackpad swipes and tilt wheels both emit them. That
     * is a weapon changing with nothing touched, which is exactly what it
     * looked like in game.
     */
    if (ev.deltaY === 0) return;
    const code = ev.deltaY < 0 ? 'WheelUp' : 'WheelDown';

    if (this.captureResolver) {
      ev.preventDefault();
      const resolver = this.captureResolver;
      this.captureResolver = null;
      resolver(code);
      return;
    }
    if (!this.locked) return;
    ev.preventDefault();
    /*
     * The wheel is reported ONLY as a rebindable button press, not also as a
     * raw delta. It used to be both, and `nextWeapon`/`prevWeapon` default to
     * WheelUp/WheelDown - so a single notch cycled twice: once from the raw
     * delta and once from the binding. Going through the binding alone also
     * means a player who rebinds the wheel actually gets what they asked for.
     */
    this.pressedThisFrame.add(code);
  }

  private onMouseMove(ev: MouseEvent): void {
    if (!this.locked || !this.enabled) return;
    this.lookDx += ev.movementX;
    this.lookDy += ev.movementY;
  }

  private releaseAll(): void {
    for (const code of this.down) this.releasedThisFrame.add(code);
    this.down.clear();
    this.lookDx = 0;
    this.lookDy = 0;
  }

  // -- queries ------------------------------------------------------------

  isDown(action: ActionId): boolean {
    if (!this.enabled) return false;
    const codes = this.actionToCodes.get(action);
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(action: ActionId): boolean {
    if (!this.enabled) return false;
    const codes = this.actionToCodes.get(action);
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  wasReleased(action: ActionId): boolean {
    if (!this.enabled) return false;
    const codes = this.actionToCodes.get(action);
    if (!codes) return false;
    for (const c of codes) if (this.releasedThisFrame.has(c)) return true;
    return false;
  }

  /** Raw code query, for UI shortcuts that are not rebindable actions. */
  isCodeDown(code: string): boolean {
    return this.down.has(code);
  }

  /**
   * Consume the accumulated look delta as yaw/pitch radians.
   * `zoomScale` applies the ADS/scoped sensitivity multiplier.
   */
  consumeLook(zoomScale: number): { yaw: number; pitch: number } {
    const sens = store.num('sensitivity');
    const invert = store.bool('invertY') ? -1 : 1;
    // 0.0022 rad per device unit at sensitivity 1.0 - tuned so 1.0 feels like
    // a typical 800 DPI / 2.0 in-game setting in other shooters.
    const k = 0.0022 * sens * zoomScale;
    const yaw = -this.lookDx * k;
    const pitch = -this.lookDy * k * invert;
    this.lookDx = 0;
    this.lookDy = 0;
    return { yaw, pitch };
  }

  consumeWheel(): number {
    const v = this.wheelDelta;
    this.wheelDelta = 0;
    return clamp(v, -4, 4);
  }

  /** Call once per frame AFTER reading edge state. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }

  /** Capture the next key/mouse/wheel input, for the rebinding UI. */
  captureNext(): Promise<string> {
    return new Promise((resolve) => {
      this.captureResolver = resolve;
    });
  }

  cancelCapture(): void {
    this.captureResolver = null;
  }

  get capturing(): boolean {
    return this.captureResolver !== null;
  }
}

/** Keys the browser would otherwise act on while the player is shooting. */
const SWALLOW_KEYS = new Set([
  'Space',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'F1',
  'F3',
  'F5',
  'Backquote',
  'Slash',
  'Quote',
]);
