/**
 * Audio.
 *
 * Every sound is synthesised at runtime with the Web Audio API - no sample
 * files at all. That guarantees the whole set is original, adds nothing to the
 * download, and lets each weapon derive its own timbre from its data (a heavier
 * weapon gets a lower fundamental and a longer tail automatically).
 *
 * Architecture:
 *   master -> compressor -> destination
 *   buses: sfx, ui, music, ambience, voice  (each with its own gain)
 *   3D sounds route through a PannerNode; 2D sounds go straight to the bus.
 *
 * Impulse responses for the convolution tail are generated as decaying noise.
 */

import { clamp, type WeaponDef } from '@neon/shared';
import { store } from '../state/store.js';

export type Bus = 'sfx' | 'ui' | 'music' | 'ambience' | 'voice';

interface Buses {
  sfx: GainNode;
  ui: GainNode;
  music: GainNode;
  ambience: GainNode;
  voice: GainNode;
}

export interface PlayOptions {
  bus?: Bus;
  volume?: number;
  /** World position; omit for a 2D sound. */
  x?: number;
  y?: number;
  z?: number;
  /** Playback pitch multiplier. */
  pitch?: number;
  /** Max audible distance, metres. */
  maxDistance?: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private buses: Buses | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private ambienceGain: GainNode | null = null;
  private musicNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private started = false;
  private suspendedByFocus = false;
  /** Rate limiter so 8 shotgun pellets do not queue 8 identical impacts. */
  private lastPlayAt = new Map<string, number>();

  /** True once the browser has allowed audio to start. */
  get ready(): boolean {
    return this.started && this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Must be called from a user gesture. Browsers refuse to start an AudioContext
   * otherwise, which is why this is not done at boot.
   */
  async unlock(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.started = true;
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 22;
    this.compressor.ratio.value = 5;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.2;

    this.master = ctx.createGain();
    this.master.gain.value = store.num('masterVolume');
    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    const mk = (initial: number) => {
      const g = ctx.createGain();
      g.gain.value = initial;
      g.connect(this.master as GainNode);
      return g;
    };
    this.buses = {
      sfx: mk(store.num('sfxVolume')),
      ui: mk(store.num('uiVolume')),
      music: mk(store.num('musicVolume')),
      ambience: mk(store.num('ambienceVolume')),
      voice: mk(store.num('voiceVolume')),
    };

    // Shared white-noise buffer, reused by every noise-based sound.
    const noiseLen = Math.floor(ctx.sampleRate * 2);
    const noise = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < noiseLen; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      nd[i] = (seed / 2147483648 - 1) * 0.8;
    }
    this.noiseBuffer = noise;

    // Reverb: exponentially decaying stereo noise, short and metallic.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(1.5, 3.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.16;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.buses.sfx);

    if (ctx.state === 'suspended') await ctx.resume();
    this.started = true;

    store.on('settings', () => this.applyVolumes());
    document.addEventListener('visibilitychange', () => {
      if (!store.bool('muteWhenUnfocused')) return;
      if (document.hidden) {
        this.suspendedByFocus = true;
        void this.ctx?.suspend();
      } else if (this.suspendedByFocus) {
        this.suspendedByFocus = false;
        void this.ctx?.resume();
      }
    });
  }

  private applyVolumes(): void {
    if (!this.master || !this.buses || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(store.num('masterVolume'), t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(store.num('sfxVolume'), t, 0.05);
    this.buses.ui.gain.setTargetAtTime(store.num('uiVolume'), t, 0.05);
    this.buses.music.gain.setTargetAtTime(store.num('musicVolume'), t, 0.05);
    this.buses.ambience.gain.setTargetAtTime(store.num('ambienceVolume'), t, 0.05);
    this.buses.voice.gain.setTargetAtTime(store.num('voiceVolume'), t, 0.05);
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 987654321;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const n = seed / 2147483648 - 1;
        data[i] = n * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Listener pose, called every frame from the camera. */
  setListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, 0.02);
      l.positionY.setTargetAtTime(py, t, 0.02);
      l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setTargetAtTime(0, t, 0.02);
      l.upY.setTargetAtTime(1, t, 0.02);
      l.upZ.setTargetAtTime(0, t, 0.02);
    } else {
      // Deprecated API path for older Safari.
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(px, py, pz);
      legacy.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // -- routing helpers ----------------------------------------------------

  private destinationFor(opts: PlayOptions): AudioNode | null {
    if (!this.ctx || !this.buses) return null;
    const bus = this.buses[opts.bus ?? 'sfx'];
    if (opts.x === undefined) return bus;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 2.5;
    panner.maxDistance = opts.maxDistance ?? 110;
    panner.rolloffFactor = 1.1;
    panner.positionX.value = opts.x;
    panner.positionY.value = opts.y ?? 0;
    panner.positionZ.value = opts.z ?? 0;
    panner.connect(bus);
    if (this.reverbSend) panner.connect(this.reverbSend);
    return panner;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    const last = this.lastPlayAt.get(key) ?? 0;
    if (now - last < ms) return false;
    this.lastPlayAt.set(key, now);
    return true;
  }

  private envGain(dest: AudioNode, peak: number, attack: number, decay: number, at = this.now()): GainNode {
    const ctx = this.ctx as AudioContext;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(dest);
    return g;
  }

  private noiseSource(playbackRate = 1): AudioBufferSourceNode {
    const ctx = this.ctx as AudioContext;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    return src;
  }

  // -- weapon sounds ------------------------------------------------------

  /**
   * Gunshot: a body (filtered noise burst), a transient click, and a pitched
   * tail. The weapon's own numbers drive the timbre so ten weapons sound like
   * ten weapons without ten hand-authored patches.
   */
  weaponFire(weapon: WeaponDef, opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const dest = this.destinationFor({ ...opts, maxDistance: opts.maxDistance ?? 160 });
    if (!dest) return;
    const at = this.now();
    const heavy = weapon.damage / 60; // 0.3 .. 1.6
    const pitch = (weapon.audio.pitch || 1) * (opts.pitch ?? 1);
    const vol = (opts.volume ?? 1) * clamp(0.35 + heavy * 0.45, 0.3, 1);

    // Body: band-passed noise, wider and lower for heavier weapons.
    const body = this.noiseSource(1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = clamp(2600 / (0.6 + heavy) * pitch, 220, 6000);
    bp.Q.value = 0.8;
    const bodyGain = this.envGain(dest, vol * 0.9, 0.004, clamp(0.1 + heavy * 0.16, 0.06, 0.42), at);
    body.connect(bp);
    bp.connect(bodyGain);
    body.start(at);
    body.stop(at + 0.6);

    // Transient: a fast square blip that gives the shot its attack.
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.setValueAtTime(clamp(900 * pitch, 180, 2400), at);
    click.frequency.exponentialRampToValueAtTime(clamp(120 * pitch, 60, 600), at + 0.05);
    const clickGain = this.envGain(dest, vol * 0.5, 0.001, 0.06, at);
    click.connect(clickGain);
    click.start(at);
    click.stop(at + 0.1);

    // Sub thump for anything heavier than an SMG.
    if (heavy > 0.4) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(clamp(120 * pitch, 40, 200), at);
      sub.frequency.exponentialRampToValueAtTime(clamp(48 * pitch, 30, 120), at + 0.14);
      const subGain = this.envGain(dest, vol * 0.55 * heavy, 0.004, 0.18, at);
      sub.connect(subGain);
      sub.start(at);
      sub.stop(at + 0.3);
    }

    // Energy weapons get a descending resonant sweep instead of a crack.
    if (weapon.fx.muzzle === 'plasma' || weapon.fx.muzzle === 'ion' || weapon.fx.muzzle === 'arc') {
      const zap = ctx.createOscillator();
      zap.type = 'sawtooth';
      zap.frequency.setValueAtTime(clamp(1800 * pitch, 400, 4000), at);
      zap.frequency.exponentialRampToValueAtTime(clamp(300 * pitch, 100, 900), at + 0.1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(5200, at);
      lp.frequency.exponentialRampToValueAtTime(700, at + 0.12);
      const zapGain = this.envGain(dest, vol * 0.32, 0.003, 0.13, at);
      zap.connect(lp);
      lp.connect(zapGain);
      zap.start(at);
      zap.stop(at + 0.2);
    }

    // Rail weapons get a long metallic ring.
    if (weapon.fx.muzzle === 'rail') {
      const ring = ctx.createOscillator();
      ring.type = 'triangle';
      ring.frequency.setValueAtTime(2400 * pitch, at);
      ring.frequency.exponentialRampToValueAtTime(900 * pitch, at + 0.5);
      const ringGain = this.envGain(dest, vol * 0.22, 0.01, 0.55, at);
      ring.connect(ringGain);
      ring.start(at);
      ring.stop(at + 0.7);
    }
  }

  dryFire(opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    if (!this.throttle('dry', 120)) return;
    const dest = this.destinationFor(opts);
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1600, at);
    osc.frequency.exponentialRampToValueAtTime(420, at + 0.03);
    const g = this.envGain(dest, 0.2 * (opts.volume ?? 1), 0.001, 0.05, at);
    osc.connect(g);
    osc.start(at);
    osc.stop(at + 0.08);
  }

  /** Reload: a mechanical sequence of clicks rather than one blob. */
  reload(weapon: WeaponDef, opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    const dest = this.destinationFor({ ...opts, maxDistance: 40 });
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();
    const steps =
      weapon.category === 'revolver'
        ? [0, 0.18, 0.34, 0.5, 0.68, 0.9]
        : weapon.category === 'shotgun'
          ? [0, 0.22, 0.46, 0.7, 0.94, 1.2]
          : weapon.category === 'lmg'
            ? [0, 0.5, 1.1, 1.7, 2.4, 3.1]
            : [0, 0.35, 0.75, 1.1];
    steps.forEach((offset, i) => {
      const t = at + offset * Math.min(1, weapon.reloadTime / 1.6);
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'square' : 'triangle';
      const base = 260 + i * 40;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.4, t + 0.05);
      const g = this.envGain(dest, 0.16 * (opts.volume ?? 1), 0.002, 0.07, t);
      osc.connect(g);
      osc.start(t);
      osc.stop(t + 0.12);

      const clack = this.noiseSource(1);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const cg = this.envGain(dest, 0.1 * (opts.volume ?? 1), 0.001, 0.04, t);
      clack.connect(hp);
      hp.connect(cg);
      clack.start(t);
      clack.stop(t + 0.06);
    });
  }

  /** Surface-specific bullet impact. */
  impact(surface: string, opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    if (!this.throttle(`impact:${surface}`, 28)) return;
    const dest = this.destinationFor({ ...opts, maxDistance: 70 });
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();

    const profiles: Record<string, { freq: number; q: number; decay: number; type: BiquadFilterType; vol: number }> = {
      metal: { freq: 3200, q: 4, decay: 0.16, type: 'bandpass', vol: 0.3 },
      concrete: { freq: 900, q: 1, decay: 0.1, type: 'lowpass', vol: 0.26 },
      glass: { freq: 5200, q: 6, decay: 0.28, type: 'bandpass', vol: 0.3 },
      grate: { freq: 2400, q: 8, decay: 0.22, type: 'bandpass', vol: 0.26 },
      energy: { freq: 1800, q: 3, decay: 0.2, type: 'bandpass', vol: 0.24 },
      holo: { freq: 2600, q: 5, decay: 0.18, type: 'bandpass', vol: 0.2 },
      panel: { freq: 1400, q: 2, decay: 0.12, type: 'bandpass', vol: 0.26 },
      rubber: { freq: 500, q: 1, decay: 0.08, type: 'lowpass', vol: 0.22 },
      sand: { freq: 700, q: 0.7, decay: 0.09, type: 'lowpass', vol: 0.2 },
      flesh: { freq: 400, q: 1.2, decay: 0.1, type: 'lowpass', vol: 0.34 },
    };
    const p = profiles[surface] ?? profiles.metal;

    const src = this.noiseSource(1);
    const filter = ctx.createBiquadFilter();
    filter.type = p.type;
    filter.frequency.value = p.freq;
    filter.Q.value = p.q;
    const g = this.envGain(dest, p.vol * (opts.volume ?? 1), 0.001, p.decay, at);
    src.connect(filter);
    filter.connect(g);
    src.start(at);
    src.stop(at + p.decay + 0.1);

    if (surface === 'glass') {
      // Shards: a few short high blips after the break.
      for (let i = 0; i < 4; i++) {
        const t = at + 0.04 + i * 0.05;
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 4200 + i * 900;
        const sg = this.envGain(dest, 0.07, 0.001, 0.05, t);
        osc.connect(sg);
        osc.start(t);
        osc.stop(t + 0.08);
      }
    }
  }

  /** Hit confirmation: two tones, higher for a headshot. */
  hitMarker(headshot: boolean): void {
    if (!this.ready || !this.ctx || !this.buses) return;
    const vol = store.num('hitSoundVolume');
    if (vol <= 0) return;
    const ctx = this.ctx;
    const at = this.now();
    const dest = this.buses.ui;
    const freqs = headshot ? [1180, 1760] : [760, 1140];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = this.envGain(dest, vol * (headshot ? 0.3 : 0.22), 0.001, 0.07, at + i * 0.035);
      osc.connect(g);
      osc.start(at + i * 0.035);
      osc.stop(at + i * 0.035 + 0.12);
    });
  }

  /** Footstep, pitched by surface. */
  footstep(surface: string, opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    const dest = this.destinationFor({ ...opts, maxDistance: 34 });
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();
    const map: Record<string, { freq: number; decay: number; vol: number }> = {
      metal: { freq: 1800, decay: 0.1, vol: 0.16 },
      grate: { freq: 2600, decay: 0.14, vol: 0.18 },
      concrete: { freq: 700, decay: 0.08, vol: 0.14 },
      panel: { freq: 1200, decay: 0.09, vol: 0.14 },
      glass: { freq: 3200, decay: 0.11, vol: 0.13 },
      rubber: { freq: 380, decay: 0.07, vol: 0.11 },
      sand: { freq: 520, decay: 0.1, vol: 0.12 },
      energy: { freq: 1500, decay: 0.12, vol: 0.12 },
    };
    const p = map[surface] ?? map.metal;
    const src = this.noiseSource(1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = p.freq * (0.9 + Math.random() * 0.2);
    bp.Q.value = 1.4;
    const g = this.envGain(dest, p.vol * (opts.volume ?? 1), 0.002, p.decay, at);
    src.connect(bp);
    bp.connect(g);
    src.start(at);
    src.stop(at + p.decay + 0.05);
  }

  jump(opts: PlayOptions = {}): void {
    this.sweep(180, 340, 0.12, 0.16, 'triangle', opts);
  }

  land(hard: boolean, opts: PlayOptions = {}): void {
    this.sweep(hard ? 160 : 220, hard ? 60 : 110, hard ? 0.22 : 0.12, hard ? 0.3 : 0.16, 'sine', opts);
    if (hard) this.impact('concrete', { ...opts, volume: 0.5 });
  }

  slide(opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    const dest = this.destinationFor({ ...opts, maxDistance: 40 });
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();
    const src = this.noiseSource(1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600, at);
    bp.frequency.exponentialRampToValueAtTime(500, at + 0.6);
    bp.Q.value = 1.2;
    const g = this.envGain(dest, 0.22 * (opts.volume ?? 1), 0.03, 0.65, at);
    src.connect(bp);
    bp.connect(g);
    src.start(at);
    src.stop(at + 0.8);
  }

  ability(kind: string, opts: PlayOptions = {}): void {
    const table: Record<string, [number, number, OscillatorType]> = {
      dash: [320, 1200, 'sawtooth'],
      cloak: [1400, 220, 'sine'],
      overshield: [220, 880, 'triangle'],
      barrier: [140, 520, 'square'],
      scan: [700, 2400, 'sine'],
      turret: [400, 260, 'square'],
      heal_field: [520, 980, 'sine'],
      emp: [1800, 90, 'sawtooth'],
      blink: [2200, 400, 'triangle'],
    };
    const [from, to, type] = table[kind] ?? [400, 900, 'triangle'];
    this.sweep(from, to, 0.32, 0.26, type, opts);
  }

  pickup(kind: string): void {
    const base = kind === 'weapon' ? 520 : kind === 'health' ? 700 : kind === 'shield' ? 840 : 620;
    this.sweep(base, base * 1.6, 0.16, 0.16, 'sine', { bus: 'ui' });
  }

  explosion(radius: number, opts: PlayOptions = {}): void {
    if (!this.ready || !this.ctx) return;
    const dest = this.destinationFor({ ...opts, maxDistance: 200 });
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();
    const scale = clamp(radius / 4, 0.6, 2);

    const src = this.noiseSource(0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, at);
    lp.frequency.exponentialRampToValueAtTime(160, at + 0.7 * scale);
    const g = this.envGain(dest, 0.75 * (opts.volume ?? 1), 0.006, 0.8 * scale, at);
    src.connect(lp);
    lp.connect(g);
    src.start(at);
    src.stop(at + 1.2 * scale);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(110, at);
    sub.frequency.exponentialRampToValueAtTime(32, at + 0.5 * scale);
    const sg = this.envGain(dest, 0.6 * (opts.volume ?? 1), 0.008, 0.55 * scale, at);
    sub.connect(sg);
    sub.start(at);
    sub.stop(at + 0.9 * scale);
  }

  death(opts: PlayOptions = {}): void {
    this.sweep(520, 70, 0.5, 0.55, 'sawtooth', opts);
  }

  // -- UI + stingers ------------------------------------------------------

  uiHover(): void {
    if (!this.throttle('hover', 40)) return;
    this.sweep(1250, 1450, 0.05, 0.05, 'sine', { bus: 'ui', volume: 0.35 });
  }

  uiClick(): void {
    this.sweep(760, 1180, 0.09, 0.07, 'square', { bus: 'ui', volume: 0.4 });
  }

  uiBack(): void {
    this.sweep(700, 420, 0.09, 0.08, 'square', { bus: 'ui', volume: 0.35 });
  }

  uiError(): void {
    this.sweep(300, 180, 0.16, 0.16, 'sawtooth', { bus: 'ui', volume: 0.4 });
  }

  countdownTick(final: boolean): void {
    this.sweep(final ? 1320 : 880, final ? 1760 : 880, 0.16, 0.14, 'sine', { bus: 'ui', volume: 0.5 });
  }

  /** Match start / victory / defeat stingers built from short chord arpeggios. */
  stinger(kind: 'start' | 'victory' | 'defeat' | 'roundwin' | 'roundloss'): void {
    if (!this.ready || !this.ctx || !this.buses) return;
    const ctx = this.ctx;
    const at = this.now();
    const chords: Record<string, number[]> = {
      start: [220, 330, 440, 660],
      victory: [262, 330, 392, 523, 659],
      defeat: [262, 233, 196, 147],
      roundwin: [330, 415, 494],
      roundloss: [330, 262, 208],
    };
    const notes = chords[kind];
    const dest = this.buses.music;
    notes.forEach((f, i) => {
      const t = at + i * (kind === 'defeat' ? 0.16 : 0.1);
      const osc = ctx.createOscillator();
      osc.type = kind === 'defeat' ? 'triangle' : 'sawtooth';
      osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      const g = this.envGain(dest, 0.22, 0.02, 0.8, t);
      osc.connect(lp);
      lp.connect(g);
      osc.start(t);
      osc.stop(t + 1);
    });
  }

  /** Simple two-voice menu drone; stops as soon as a match starts. */
  startMenuMusic(): void {
    if (!this.ready || !this.ctx || !this.buses) return;
    if (this.musicNodes.length > 0) return;
    const ctx = this.ctx;
    const dest = this.buses.music;
    for (const [freq, detune, gain] of [
      [55, 0, 0.09],
      [82.5, 6, 0.06],
      [110, -5, 0.045],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      lp.Q.value = 3;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 160;
      lfo.connect(lfoGain);
      lfoGain.connect(lp.frequency);
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(gain, ctx.currentTime, 1.5);
      osc.connect(lp);
      lp.connect(g);
      g.connect(dest);
      osc.start();
      lfo.start();
      this.musicNodes.push({ osc, gain: g });
      this.musicNodes.push({ osc: lfo, gain: g });
    }
  }

  stopMenuMusic(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const node of this.musicNodes) {
      node.gain.gain.setTargetAtTime(0, t, 0.4);
      try {
        node.osc.stop(t + 1.6);
      } catch {
        /* already stopped */
      }
    }
    this.musicNodes = [];
  }

  /** Looping map ambience: filtered noise plus a slow pulsing tone. */
  startAmbience(kind: string): void {
    if (!this.ready || !this.ctx || !this.buses) return;
    this.stopAmbience();
    const ctx = this.ctx;
    const src = this.noiseSource(0.35);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = kind === 'amb_orbital' ? 220 : kind === 'amb_mirage' ? 520 : 380;
    filter.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(kind === 'amb_orbital' ? 0.5 : 0.36, ctx.currentTime, 2);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.buses.ambience);
    src.start();
    this.ambienceSource = src;
    this.ambienceGain = g;

    // A slow machine hum layered on top.
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = kind === 'amb_foundry' ? 48 : kind === 'amb_mirage' ? 62 : 38;
    const hg = ctx.createGain();
    hg.gain.value = 0.16;
    const trem = ctx.createOscillator();
    trem.frequency.value = 0.13;
    const tremGain = ctx.createGain();
    tremGain.gain.value = 0.08;
    trem.connect(tremGain);
    tremGain.connect(hg.gain);
    hum.connect(hg);
    hg.connect(this.buses.ambience);
    hum.start();
    trem.start();
    this.musicNodes.push({ osc: hum, gain: hg });
    this.musicNodes.push({ osc: trem, gain: hg });
  }

  stopAmbience(): void {
    if (this.ambienceSource) {
      try {
        this.ambienceSource.stop();
      } catch {
        /* already stopped */
      }
      this.ambienceSource = null;
    }
    this.ambienceGain = null;
  }

  // -- primitive ---------------------------------------------------------

  private sweep(
    from: number,
    to: number,
    attackDecay: number,
    decay: number,
    type: OscillatorType,
    opts: PlayOptions = {},
  ): void {
    if (!this.ready || !this.ctx) return;
    const dest = this.destinationFor(opts);
    if (!dest) return;
    const ctx = this.ctx;
    const at = this.now();
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, from), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + attackDecay);
    const g = this.envGain(dest, 0.25 * (opts.volume ?? 1), 0.004, decay, at);
    osc.connect(g);
    osc.start(at);
    osc.stop(at + attackDecay + decay + 0.1);
  }
}

export const audio = new AudioEngine();
