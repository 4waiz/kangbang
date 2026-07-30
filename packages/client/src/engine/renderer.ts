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
 * and whether the bloom composite runs at all.
 */

import {
  NoToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Sphere,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
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
    // No tone curve: the palette is already in display range, and a filmic
    // curve on flat lit surfaces just muddies them.
    this.renderer.toneMapping = NoToneMapping;
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

    window.addEventListener('resize', () => this.resize());
    store.on('settings', () => {
      this.applyQuality();
      this.resize();
    });
  }

  // -- configuration ------------------------------------------------------

  applyQuality(): void {
    const shadowKey = store.str('shadowQuality');
    const shadowSize = SHADOW_SIZES[shadowKey] ?? 2048;
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
    // `bloom` is now a small exposure lift rather than a post pass: with no
    // tone curve and few emissive surfaces there is nothing for a real bloom
    // to bloom, and on integrated GPUs the pass cost more than the frame.
    this.renderer.toneMappingExposure = store.bool('bloom') ? 1.06 : 1.0;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    const scale = this.renderScale * dpr;
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
   * There is deliberately no environment map.
   *
   * The previous art direction was metallic sci-fi, and a metallic PBR material
   * with nothing to reflect renders black, so the skybox had to be convolved into
   * a PMREM cubemap to make the level readable. That cubemap measured 1536x2048
   * and was the single largest allocation in the process at 12 MB - more than the
   * entire rest of the texture budget.
   *
   * The grounded palette is non-metallic (see MATERIALS in shared/sim/world.ts),
   * so image-based lighting buys nothing: painted concrete and coated steel are
   * described completely by albedo plus a hemisphere and a sun. Removing it costs
   * one specular highlight nobody was looking at and returns 12 MB.
   */


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
    this.renderer.dispose();
  }
}
