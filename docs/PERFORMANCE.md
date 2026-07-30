# Performance

## Target and measured

**Target:** 60 FPS at 1080p on medium settings, on integrated graphics.

| Measurement | Value |
| --- | --- |
| Client bundle, raw | 894 KB |
| Client bundle, gzipped | **244 KB** |
| — of which Three.js | 576 KB raw / 147 KB gz (separate chunk) |
| — of which shared simulation | 105 KB raw / 33 KB gz (separate chunk) |
| — of which game + UI | 179 KB raw / 57 KB gz |
| CSS | 33 KB raw / 6.8 KB gz |
| All 3D models | **604 KB** for 59 GLBs |
| Textures | 0 bytes downloaded — drawn to canvas at boot |
| Audio | 0 bytes downloaded — synthesised at runtime |
| Server bundle | 385 KB, one file |
| Server tick cost | ~0.01 ms average per room, idle-to-light load (`/api/health` reports it live) |
| Asset generation | 59 models in ~20 s |

Total first load is roughly **850 KB** over the wire for a complete game with
three maps, ten weapons, six classes and eight modes. There is no second download,
no asset streaming and no CDN dependency.

Chunking is deliberate: Three.js and the shared simulation are stable, so a
gameplay patch invalidates only the 57 KB game chunk in players' caches.

> **A note on measuring in headless Chrome:** the browser check reports ~10 FPS,
> because headless Chrome falls back to SwiftShader software rasterisation. That
> number says nothing about real performance. Measure on a real GPU with
> Settings → Graphics → Show FPS.

---

## Frame budget at 60 FPS

16.67 ms total. The client's own work has to fit in roughly half of it, because
the browser needs the rest for compositing, GC and the event loop.

| Stage | Budget |
| --- | --- |
| Input sampling | < 0.1 ms |
| Prediction (`movementStep`) | ~0.05 ms — one fixed step, no allocation |
| Snapshot decode + interpolation | ~0.3 ms for 16 entities |
| View model, FX, HUD update | ~1.5 ms |
| Three.js render | 4–8 ms depending on preset |
| **Total** | **~7–10 ms** |

---

## What keeps it there

### Geometry is merged and instanced

A map is 600–700 brushes. Drawn naively that is 600+ draw calls before a single
player appears. Instead `mapRenderer.ts` merges all brushes sharing a material
into one `BufferGeometry` per material, and instances anything repeated (light
panels, railings, crates) with `InstancedMesh`.

Static level geometry therefore costs **one draw call per material**, not per
brush — a handful for a whole map.

### LODs

Anything over ~500 triangles is exported with a decimated sibling mesh in the same
GLB. At load time `attachLods()` pairs each `*_LOD1` mesh with its full-detail
original into a `THREE.LOD`, with a switch distance derived from the mesh's own
bounding sphere (`max(12, radius × 14)`) rather than a fixed number — a 2 m
character and a 0.4 m pickup should not swap at the same distance.

This is worth spelling out because getting it wrong is silent: the generators put
both meshes in the GLB at the same origin, so **without** the pairing step the
renderer draws full detail and reduced detail overlapping — double the triangles
plus depth artefacts, and no error anywhere. Seven character models were doing
exactly that. `assets.ts` now logs the LOD count at boot so the number is visible.

An orphaned `*_LOD1` with no matching original is removed rather than left in the
scene, so a generator rename cannot reintroduce the duplicate.

### Everything hot is pooled

`engine/fx.ts` pre-allocates fixed-size pools and never allocates during play:

Sizes scale with an effects budget of 0.45 (Low), 0.75 (Medium) or 1.0
(High/Ultra):

| Pool | High / Ultra | Medium | Low |
| --- | --- | --- | --- |
| Tracers | 96 | 72 | 43 |
| Impact sparks | 56 | 42 | 25 |
| Particle bursts | 18 | 14 | 8 |
| Ejected shells | 40 | 30 | 0 |
| Muzzle flashes | 14 | 14 | 14 |
| Explosion blasts | 8 | 8 | 8 |
| Beams | 10 | 10 | 10 |
| Bullet decals | 220 (400 Ultra) | 120 | 40 |

Muzzle flashes, blasts and beams are not scaled: there is a hard ceiling on how
many can be on screen at once regardless of quality, so shrinking them would only
drop effects the player is looking directly at. Shells go to zero on Low because
they are pure decoration.

Exhausting a pool recycles the oldest entry. That is a visual compromise under
extreme load, and it is the right one: a dropped tracer is invisible, a GC pause
is not.

Decals are ring-buffered with a hard cap. Uncapped decals are the classic
browser-FPS memory leak — they accumulate for the whole match and never get
collected.

### Culling and draw distance

Frustum culling is on for every mesh. Draw distance is a user setting (80–400 m,
default 260) applied to the camera far plane and to FX spawning, so distant
impacts do not cost anything at all.

### The HUD is one canvas

Crosshair, health, ammo, minimap, damage direction and hit markers are drawn to a
single 2D canvas, not composed from DOM nodes. Menus are DOM because they are
static; the HUD is canvas because it changes every frame and DOM reflow at 60 Hz
is not free.

The HUD also caches every string it draws and skips the redraw when nothing
changed, so a static HUD costs almost nothing.

### No allocation in the simulation

`movementStep()` takes and mutates a state object, uses module-level scratch
vectors, and allocates nothing. The same is true of the collision sweeps and the
ballistics resolution. This matters twice over: it runs 60 times a second on the
client and 60 times a second per player on the server, and reconciliation may
replay dozens of steps in a single frame.

### Textures are procedural, and cached

Every texture is drawn once to an offscreen canvas at boot and cached by key.
Texture quality scales the canvas resolution, so Low genuinely costs less VRAM
rather than just looking softer.

### Environment map

One PMREM environment map is generated from the procedural sky per map ambience
and shared by every material. Without it, metallic PBR materials render
near-black — which is exactly what happened before it existed. Generated once per
map load, not per frame.

---

## Quality presets

| | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| Resolution scale | 0.70 | 0.90 | 1.00 | 1.25 |
| Textures | Low | Medium | High | High |
| Shadows | Off | Low | Medium | High |
| Effects | Low | Medium | High | High |
| Anti-aliasing | Off | FXAA | FXAA | MSAA 4× |
| Bloom | off | on | on | on |
| Motion blur | off | off | off | on |
| Draw distance | 120 m | 190 m | 260 m | 400 m |
| Decal limit | 40 | 120 | 220 | 400 |

Resolution scale is the biggest single lever — Low renders at 49% of the pixels of
High. Shadows are the second: Off removes the entire shadow pass.

Changing any individual setting switches the preset to **Custom** rather than
leaving a label that contradicts the settings.

---

## Server performance

- **One room, one tick loop.** `roomManager` ticks every room from a single
  interval. There is no per-room timer to drift.
- **Snapshots at a third of the tick rate.** 20 Hz instead of 60 Hz cuts encode
  and send cost by two thirds, and interpolation makes it indistinguishable.
- **The encode buffer is reused.** `encodeSnapshot()` writes into one shared
  `ArrayBuffer` and returns a view; the room copies per send. Encoding a snapshot
  allocates nothing.
- **Bounded history.** Lag compensation keeps a fixed 19-tick ring buffer per
  player, pre-allocated. It cannot grow.
- **Bounded input.** At most 6 commands per player per tick, so one client cannot
  make the server do unbounded work.

`/api/health` reports `avgTickMs`. If that approaches 16 ms the process is at
capacity and needs either fewer rooms or another process.

---

## Avoiding leaks

The specific things checked:

- **Pools never grow.** Fixed allocation, oldest-recycled.
- **Decals are capped.** Ring buffer, user-configurable limit.
- **Disposal on map change.** Geometries, materials, textures and render targets
  from the previous map are explicitly disposed. Three.js does not free GPU
  resources on garbage collection, so dropping a reference is not enough.
- **Listeners are removed.** Every screen tears down its own listeners; the input
  layer releases all held keys on Pointer Lock loss, so a key cannot be stuck down
  after tabbing away.
- **Disconnected players are reaped.** A held slot expires after the 30 s
  reconnect grace and the `ServerPlayer` is dropped.
- **Kill-feed and notice rows expire.** Both are time-bounded and removed from the
  DOM, not hidden.
- **`localStorage` writes are idempotent.** Settings are keyed and versioned;
  nothing appends.

To check for a leak yourself: play a full match, take a heap snapshot, play
another, take a second snapshot and compare retained size. Watch particularly for
`BufferGeometry` and `Material` counts — those growing across map changes means a
disposal was missed.

---

## If it is slow

In the order actually worth trying:

1. **Show FPS** (Settings → Graphics) and read the frame time, not the FPS. Frame
   time tells you how far over budget you are.
2. **Drop the preset to Medium.** If that fixes it, it is GPU-bound.
3. **Drop resolution scale to 0.7** on its own. Biggest single win.
4. **Shadows off.** Second biggest.
5. **Check hardware acceleration is on** in the browser. Software rasterisation
   turns a 200 FPS game into a 10 FPS one — this is the single most common cause.
6. **Check ping, not FPS.** Rubber-banding and enemies that teleport are network
   symptoms; the network graph (Settings → Graphics → Show network graph) shows
   snapshot arrival and reconciliation corrections.
7. **Close other tabs.** A browser game shares a GPU process.
