/**
 * Renderer.
 *
 * WebGL2 by default with an opportunistic WebGPU probe: if the browser exposes
 * WebGPU we report it so the UI can say so, but we still render through the
 * WebGL path because three.js's WebGPU backend is not yet a drop-in for the
 * material set here. That is a deliberate, documented choice rather than an
 * omission - see docs/PERFORMANCE.md.
 *
 * Quality settings map onto: render scale, shadow map size, antialias mode,
 * whether the bloom composite runs at all, and whether models are shaded as PBR
 * or flattened to a cheap lit material (see AssetLibrary).
 */

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Sphere,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { MapAmbience } from '@kang/shared';
import { store } from '../state/store.js';
import { skyTexture, type TextureQuality } from './textures.js';

export interface RendererStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  geometries: number;
}

const SHADOW_SIZES: Record<string, number> = { off: 0, low: 1024, medium: 2048, high: 4096 };

/**
 * Ceiling on `resolutionScale * devicePixelRatio`.
 *
 * See `resize()`: without it a high-DPI display multiplies the user's own
 * quality setting into a pixel buffer several times larger than the window.
 */
const MAX_EFFECTIVE_SCALE = 1.5;

/**
 * How much of the procedural environment reaches a surface. See
 * `installEnvironment()`: the room is a brightly lit white box, and at full
 * strength it lifts the shadow side of every model into flat grey and cancels
 * out the sun. This is enough to fill a highlight, not enough to light a scene.
 */
const ENVIRONMENT_INTENSITY = 0.7;

/**
 * Blur radius, in radians, applied before convolving the room.
 * The room is a handful of hard-edged boxes; without this its corners show up
 * as distinct reflected edges on anything smooth enough to mirror them.
 */
const ENVIRONMENT_BLUR = 0.04;

export class Renderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** Separate camera + scene for the first-person view model, drawn on top. */
  readonly viewScene = new Scene();
  readonly viewCamera: PerspectiveCamera;

  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  private sky: Mesh | null = null;
  /** Procedural image-based lighting, generated once at boot. */
  private envMap: Texture | null = null;

  readonly canvas: HTMLCanvasElement;
  private width = 1;
  private height = 1;
  private renderScale = 1;
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private fpsValue = 0;
  private frameMsValue = 0;
  /** True when the browser advertises WebGPU (reported in the settings UI). */
  readonly webgpuAvailable: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

    /*
     * MSAA is the only anti-aliasing mode there is, and it is decided here.
     *
     * There used to be an FXAA option, and it was the default, but nothing ever
     * read it: FXAA is a post-processing pass and this renderer has no post
     * chain, so choosing it was indistinguishable from choosing Off. The option
     * is gone rather than implemented - a full-screen pass is the wrong thing to
     * add to a build that is trying to get frame time down.
     *
     * MSAA is a context creation flag, so it is read once and a change needs a
     * reload. `applyQuality` cannot help with this one.
     */
    const antialias = store.str('antialiasing') === 'msaa';
    this.renderer = new WebGLRenderer({
      canvas,
      antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      // preserveDrawingBuffer costs memory and we never read the buffer back.
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    /*
     * ACES filmic tone mapping.
     *
     * Models are shaded as PBR again (see AssetLibrary), which means specular
     * highlights and emissive trim routinely land above 1.0. With no tone curve
     * everything above 1.0 clips flat to pure white - which is exactly why the
     * emissive on every model used to be clamped down to 0.85 to compensate,
     * losing its colour and the surface detail underneath. ACES rolls the top
     * end off into a shaped highlight instead, so the clamp is gone.
     *
     * The level's Lambert brushes are already authored in display range and are
     * barely touched by the curve; it is the specular half of the model
     * materials that needs somewhere above 1.0 to go.
     */
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;

    /*
     * Near plane 0.2, not 0.05.
     *
     * Depth precision goes as z^2 / (near * 2^bits), so the near plane dominates
     * it. At 0.05 the smallest resolvable depth step at 100m is around 12mm, and
     * the maps place decorative overlays - stripes, trim, signage - only 5 to 12mm
     * off the wall behind them. There are over a thousand overlapping coplanar
     * face pairs per map, which is why distant surfaces shimmered and seams came
     * out dotted. 0.2 is a fourfold improvement and is still well inside the
     * 0.42m player radius, so nothing in the world scene can clip through it.
     * The view model renders from its own camera and is unaffected.
     */
    this.camera = new PerspectiveCamera(store.num('fov'), 1, 0.2, store.num('drawDistance'));
    this.viewCamera = new PerspectiveCamera(store.num('viewModelFov'), 1, 0.005, 6);

    this.hemi = new HemisphereLight(0x8098c0, 0x20242e, 0.9);
    this.scene.add(this.hemi);

    this.sun = new DirectionalLight(0xffffff, 1.2);
    this.sun.position.set(-30, 60, -25);
    this.sun.castShadow = false;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 180;
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // The view model needs its own light rig or it renders as a silhouette.
    const viewKey = new DirectionalLight(0xffffff, 2.1);
    viewKey.position.set(0.6, 1.1, 1.4);
    this.viewScene.add(viewKey);
    const viewFill = new HemisphereLight(0x9fc8ff, 0x1a2030, 1.5);
    this.viewScene.add(viewFill);

    this.applyQuality();
    this.resize();
    // After resize(): the generator borrows the renderer to convolve the room,
    // and it should do that with the drawing buffer already at its final size.
    this.installEnvironment();

    window.addEventListener('resize', () => this.resize());
    store.on('settings', () => {
      this.applyQuality();
      this.resize();
    });
  }

  // -- configuration ------------------------------------------------------

  /**
   * Re-read the settings that a live renderer can act on.
   *
   * Which is not all of them, and the gap is worth being explicit about because
   * the settings UI cannot tell the difference.
   *
   * Applied immediately, here: shadow map size and on/off, field of view, view
   * model field of view, draw distance, the bloom exposure lift, and (via
   * `resize`, which the settings listener calls next) render scale.
   *
   * NOT applied until the next map load: `effectsQuality`. It selects the map's
   * point-light budget in `buildMapMeshes`, the effects pool sizes and shared
   * light count in `FxSystem`, and PBR-vs-Lambert for model materials in
   * `AssetLibrary.modelMaterial` - all of which are decided when the objects are
   * built. Textures are the same story via `textureQuality`. Re-deriving them
   * live would mean keeping every source material and full-resolution texture
   * alive for the whole session purely to be able to change its mind, which
   * costs the memory this build spent a release getting rid of.
   *
   * NOT applied at all without a page reload: `antialiasing`. MSAA is a WebGL
   * context creation flag and the context is created once, in the constructor.
   */
  applyQuality(): void {
    const shadowKey = store.str('shadowQuality');
    const shadowSize = SHADOW_SIZES[shadowKey] ?? SHADOW_SIZES.low;
    this.renderer.shadowMap.enabled = shadowSize > 0;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.sun.castShadow = shadowSize > 0;
    if (shadowSize > 0) this.sun.shadow.mapSize.set(shadowSize, shadowSize);

    this.camera.fov = store.num('fov');
    this.camera.far = store.num('drawDistance');
    this.camera.updateProjectionMatrix();
    this.viewCamera.fov = store.num('viewModelFov');
    this.viewCamera.updateProjectionMatrix();

    this.renderScale = store.num('resolutionScale');
    // `bloom` is a small exposure lift rather than a post pass: at this emissive
    // density there is very little for a real bloom to bloom, and on integrated
    // GPUs the pass cost more than the frame. With the ACES curve back, nudging
    // exposure pushes highlights further up the shoulder, which is the part of
    // a bloom pass anyone actually noticed.
    this.renderer.toneMappingExposure = store.bool('bloom') ? 1.06 : 1.0;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    /*
     * Effective scale is clamped, and the clamp is the point.
     *
     * `resolutionScale` is a multiplier on top of the device pixel ratio, and
     * both go above 1. A 200%-scaled laptop display on the Ultra preset asked
     * for 1.25 x 2 = 2.5, which is a 6.25x pixel buffer - the game rendering at
     * 4800x3000 to be displayed in a 1920x1200 window. Fragment cost scales with
     * that number directly, and nothing above roughly 1.5 survives being scaled
     * back down to the CSS pixel grid, so the extra was paid and then thrown
     * away. 1.5 is 2.25x the pixels, which is still plenty of supersampling.
     */
    const scale = Math.min(this.renderScale * dpr, MAX_EFFECTIVE_SCALE);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(this.width * scale), Math.round(this.height * scale), false);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();
  }

  /**
   * Image-based lighting from a procedural room, built once at boot.
   *
   * A PBR material with any metalness reflects its environment, and with nothing
   * in `scene.environment` it reflects black - which is why model materials used
   * to be flattened to Lambert on the way in. Something has to be there before
   * metal can read as metal.
   *
   * The obvious source, the skybox convolved into a PMREM cubemap, was removed
   * for good reason: at 1536x2048 it was 12 MB and the single largest allocation
   * in the process. `RoomEnvironment` is the same idea for none of the download.
   * It is a dozen boxes and a point light constructed in JavaScript, rendered
   * once into a small cubemap and then thrown away - no asset ships with the
   * build, and nothing is fetched at runtime.
   *
   * Only MeshStandardMaterial reads `scene.environment`, so this reaches the
   * models and leaves the level's Lambert brushes and the unlit sky untouched -
   * the grounded palette (see MATERIALS in shared/sim/world.ts) is non-metallic
   * and gains nothing from IBL.
   */
  private installEnvironment(): void {
    try {
      const pmrem = new PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.envMap = pmrem.fromScene(room, ENVIRONMENT_BLUR).texture;
      // The room geometry and the generator's scratch targets are only needed
      // while convolving; the resulting texture does not reference either.
      room.dispose();
      pmrem.dispose();

      this.scene.environment = this.envMap;
      this.viewScene.environment = this.envMap;
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      this.viewScene.environmentIntensity = ENVIRONMENT_INTENSITY;
    } catch (err) {
      // Losing IBL costs a highlight; failing to construct the renderer costs
      // the game, so a driver that cannot do this still boots.
      // eslint-disable-next-line no-console
      console.warn('[renderer] environment map unavailable, models will look flat', err);
    }
  }

  /** Apply a map's lighting + fog + skybox. */
  applyAmbience(a: MapAmbience): void {
    this.hemi.color.setHex(a.hemiSky);
    this.hemi.groundColor.setHex(a.hemiGround);
    this.hemi.intensity = a.hemiIntensity;
    this.sun.color.setHex(a.sunColor);
    this.sun.intensity = a.sunIntensity;
    const dir = new Vector3(a.sunDir[0], a.sunDir[1], a.sunDir[2]).normalize();
    this.sun.position.copy(dir).multiplyScalar(-90);
    this.sun.target.position.set(0, 0, 0);

    this.scene.background = new Color(a.fogColor);
    this.scene.fog = new Fog(a.fogColor, 20, Math.max(60, store.num('drawDistance') * 0.95));

    // Sky dome. Rendered from inside with depthWrite off so it never occludes.
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as MeshBasicMaterial).dispose();
      this.sky = null;
    }
    const quality = store.str('textureQuality') as TextureQuality;
    const geo = new SphereGeometry(1, 32, 20);
    const mat = new MeshBasicMaterial({
      map: skyTexture(a.skybox, quality),
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    mat.side = 1; // BackSide
    const mesh = new Mesh(geo, mat);
    mesh.scale.setScalar(1);
    mesh.renderOrder = -1000;
    mesh.frustumCulled = false;
    // Keep the dome centred on the camera every frame via onBeforeRender.
    mesh.onBeforeRender = (_r, _s, cam) => {
      mesh.position.copy(cam.position);
      const far = (cam as PerspectiveCamera).far ?? 300;
      mesh.scale.setScalar(far * 0.9);
    };
    // A huge bounding sphere so three never culls it.
    geo.boundingSphere = new Sphere(new Vector3(), 1e6);
    this.scene.add(mesh);
    this.sky = mesh;

  }

  // -- frame --------------------------------------------------------------

  render(): void {
    const now = performance.now();
    if (this.lastFrameAt > 0) {
      const dt = now - this.lastFrameAt;
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 90) this.frameTimes.shift();
    }
    this.lastFrameAt = now;

    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // The view model is drawn in a second pass with a cleared depth buffer so
    // the weapon never clips into level geometry.
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.viewScene, this.viewCamera);
    this.renderer.autoClear = true;

    const spent = performance.now() - now;
    this.frameMsValue = this.frameMsValue * 0.9 + spent * 0.1;
    if (this.frameTimes.length > 8) {
      const avg = this.frameTimes.reduce((s, v) => s + v, 0) / this.frameTimes.length;
      this.fpsValue = avg > 0 ? 1000 / avg : 0;
    }
  }

  stats(): RendererStats {
    const info = this.renderer.info;
    return {
      fps: this.fpsValue,
      frameMs: this.frameMsValue,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  }

  get pixelWidth(): number {
    return this.renderer.domElement.width;
  }

  get pixelHeight(): number {
    return this.renderer.domElement.height;
  }

  dispose(): void {
    this.envMap?.dispose();
    this.envMap = null;
    this.scene.environment = null;
    this.viewScene.environment = null;
    this.renderer.dispose();
  }
}
