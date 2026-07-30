# Credits

## Originality statement

**KANG BANG is an independent, original work.**

It is not associated with, endorsed by, or derived from any other game. It
contains no code, geometry, texture, sound, music, font, icon, name, character,
map, logo, colour scheme, user-interface layout or design asset taken from any
other product.

Reference material was used only to understand a *genre*: what a first-person
camera and weapon placement look like, what "low-poly with bright lighting" means
as a visual target, and what makes a browser shooter feel fast and immediately
playable. Those are conventions of the form, in the same sense that a platformer
has a jump button. Nothing was copied.

Everything shipped is produced from source in this repository:

| | How |
| --- | --- |
| 59 3D models | Blender Python in `assets/scripts/` |
| ~30 textures | Canvas 2D at runtime, `packages/client/src/engine/textures.ts` |
| ~45 sounds | Web Audio synthesis at runtime, `packages/client/src/engine/audio.ts` |
| ~45 icons | Inline SVG paths, `packages/client/src/ui/icons.ts` |
| 3 maps | Brush geometry in `packages/shared/src/data/maps/` |
| Every name | Original — weapons, classes, abilities, maps, modes, bot callsigns |
| Fonts | None bundled; system stack only |

Verification steps are in [ASSET_MANIFEST.md](ASSET_MANIFEST.md), including the
strongest one: regenerate every model from source and confirm no diff.

---

## Licence

KANG BANG is released under the **MIT Licence** — see [LICENSE](../LICENSE).

---

## Dependencies

Deliberately few. There is no game engine, no UI framework, no state-management
library, no CSS framework, no icon library, no audio library and no physics
library. The engine, the netcode, the movement simulation, the collision system,
the navmesh generator, the UI layer and the audio synthesis are all written here.

### Runtime

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| [three](https://threejs.org/) | 0.171.0 | MIT | WebGL rendering. Scene graph, materials, GLTF loading, PMREM environment generation. Chosen over Babylon.js for bundle size and cold-start time — see [ARCHITECTURE.md](ARCHITECTURE.md). |
| [ws](https://github.com/websockets/ws) | 8.21.1 | MIT | Server-side WebSocket. The only runtime dependency of the server bundle. |

That is the entire runtime dependency list. Node's built-in `node:sqlite` provides
local persistence, so there is no native module to compile.

Optional, lazy-loaded, and only needed if you choose Postgres:

| Package | Licence | Used for |
| --- | --- | --- |
| [pg](https://node-postgres.com/) | MIT | Production persistence. Loaded through an indirect specifier so it is not required to run locally. |

### Development

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| [typescript](https://www.typescriptlang.org/) | 5.9.3 | Apache-2.0 | Types across all three packages |
| [vite](https://vite.dev/) | 6.4.3 | MIT | Client dev server and production bundle |
| [vitest](https://vitest.dev/) | 2.1.9 | MIT | Test runner for all 415 tests |
| [esbuild](https://esbuild.github.io/) | 0.24.2 | MIT | Single-file server bundle |
| [tsx](https://tsx.is/) | 4.23.1 | MIT | Running TypeScript directly in development |
| [eslint](https://eslint.org/) | 8.57.1 | MIT | Linting |
| [@typescript-eslint](https://typescript-eslint.io/) | 8.x | MIT | TypeScript ESLint parser and rules |
| [puppeteer-core](https://pptr.dev/) | 23.11.1 | Apache-2.0 | Browser verification. `-core`, so it drives an already-installed Chrome or Edge rather than downloading Chromium. |
| [concurrently](https://github.com/open-cli-tools/concurrently) | 9.2.4 | MIT | Running server and client from one command |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 22.x | MIT | Node type definitions |
| [@types/three](https://github.com/DefinitelyTyped/DefinitelyTyped) | 0.171.x | MIT | Three.js type definitions |
| [@types/ws](https://github.com/DefinitelyTyped/DefinitelyTyped) | 8.5.x | MIT | ws type definitions |

### Tools, not dependencies

| Tool | Licence | Used for |
| --- | --- | --- |
| [Blender](https://www.blender.org/) | GPL-2.0-or-later | Generating the models. **Not redistributed and not linked against.** Blender is run as an external program to produce GLB output; the GLB files are data, and the GPL does not extend to them. Blender is only needed to *change* a model — the outputs are committed. |
| Docker / Docker Compose | Apache-2.0 | Containerised deployment |
| nginx | BSD-2-Clause | Serving the client and proxying in production |
| PostgreSQL | PostgreSQL Licence | Optional production persistence |

---

## Standards and specifications

Implemented against public specifications, with no reference implementation
copied:

- **WebGL 2.0** — Khronos
- **WebGPU** — W3C (probed for diagnostics; rendering is WebGL2, see
  [ARCHITECTURE.md](ARCHITECTURE.md))
- **Web Audio API** — W3C
- **Pointer Lock API** — W3C
- **WebSocket** — RFC 6455
- **HTTP Authentication** — RFC 7235, which is why the bearer scheme is matched
  case-insensitively
- **glTF 2.0 / GLB** — Khronos
- **HMAC** — RFC 2104

## Techniques

Well-documented, widely published approaches, implemented from first principles:

- **Quake-lineage movement** — ground friction, air acceleration with a per-tick
  wish-velocity cap, and the strafe-jumping that emerges from it. The behaviour is
  a decades-old convention of the genre; the implementation in
  `packages/shared/src/sim/movement.ts` is written here.
- **Client prediction with rewind-and-replay reconciliation** — the standard
  solution to input latency in authoritative multiplayer, as described in the
  public literature on the subject.
- **Entity interpolation with bounded extrapolation** — rendering remote players
  slightly in the past, extrapolating only briefly on packet loss.
- **Server-side lag compensation** — rewinding hitboxes to the shooter's view of
  the world.
- **A\* pathfinding** over a grid-sampled navmesh with slope, step, jump and drop
  links.
- **PMREM prefiltered environment mapping** for image-based lighting.

---

## Acknowledgements

To the maintainers of Three.js, Vite, Vitest, esbuild, tsx, ws and Blender, whose
work made a project this size feasible for a small team — and to the authors of
the public writing on netcode, without which client prediction would be far harder
to get right than it needs to be.
