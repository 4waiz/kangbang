# Controls and settings

Every binding is remappable in **Settings → Controls**, with conflict detection:
assigning a key that is already taken shows both actions rather than silently
stealing it. Bindings persist to `localStorage` and sync to the profile.

---

## Default bindings

### Movement

| Action | Default |
| --- | --- |
| Move forward | `W` |
| Move backward | `S` |
| Strafe left | `A` |
| Strafe right | `D` |
| Jump | `Space` |
| Crouch / slide | `Left Ctrl` |
| Sprint | `Left Shift` |

### Combat

| Action | Default |
| --- | --- |
| Fire | `Left Click` |
| Aim | `Right Click` |
| Reload | `R` |
| Melee | `V` |
| Ability | `Q` |
| Ultimate | `F` |
| Primary weapon | `1` |
| Secondary weapon | `2` |
| Melee weapon | `3` |
| Last weapon | `X` |
| Next weapon | `Wheel Up` |
| Previous weapon | `Wheel Down` |

### Utility

| Action | Default |
| --- | --- |
| Interact | `E` |
| Scoreboard (hold) | `Tab` |
| Map | `M` |
| Pause / back | `Escape` |

### Social

| Action | Default |
| --- | --- |
| Chat | `T` |
| Team chat | `Y` |
| Emote | `B` |
| Ping | `G` |

`Escape` is reserved: it is how you leave Pointer Lock, so the browser owns it and
it cannot be rebound.

---

## Movement techniques

| Technique | How |
| --- | --- |
| **Sprint** | Hold `Shift` while moving forward. Widens FOV slightly. |
| **Slide** | Crouch while moving above 5.4 m/s. Boosts to 13.4 m/s. |
| **Slide-hop** | Jump out of a slide to keep 94% of the speed, then air-strafe. Chaining this is the fastest way across a map. |
| **Air strafe** | While airborne, hold a strafe key and turn smoothly in that direction. Quake-style air acceleration adds speed. |
| **Step-up** | Automatic for anything up to 0.46 m. No jump needed for stairs or kerbs, and it never launches you. |
| **Coyote jump** | A jump pressed within 0.09 s of leaving a ledge still fires. |
| **Buffered jump** | A jump pressed within 0.11 s of landing fires on touchdown. |

---

## Settings

### Controls

| Setting | Default | Range |
| --- | --- | --- |
| Mouse sensitivity | 1.4 | 0.05 – 8 |
| ADS sensitivity multiplier | 0.72 | 0.1 – 1.5 |
| Scoped sensitivity multiplier | 0.5 | 0.1 – 1.5 |
| Invert Y axis | off | |
| Raw mouse input | on | |
| Aim mode | Hold | Hold / Toggle |
| Crouch mode | Hold | Hold / Toggle |
| Auto sprint | off | |
| Slide on crouch while sprinting | on | |

Raw input uses unaccelerated pointer deltas where the browser exposes them, so
sensitivity means the same thing regardless of OS mouse acceleration.

### Graphics

| Setting | Default | Range |
| --- | --- | --- |
| Performance preset | High | Low / Medium / High / Ultra / Custom |
| Resolution scale | 1.0 | 0.5 – 1.5 |
| Texture quality | High | Low / Medium / High |
| Shadow quality | Medium | Off / Low / Medium / High |
| Effects quality | High | Low / Medium / High |
| Anti-aliasing | FXAA | Off / FXAA / MSAA 4× |
| Bloom | on | |
| V-Sync | on | |
| FPS limit | 300 | 30 – 300 |
| Field of view | 96 | 70 – 120 |
| View-model FOV | 68 | 45 – 90 |
| Motion blur | off | |
| Screen shake intensity | 0.85 | 0 – 1.5 |
| Draw distance | 260 m | 80 – 400 |
| Bullet decal limit | 220 | 0 – 400 |
| Show FPS counter | off | |
| Show ping | on | |
| Show network graph | off | |

Changing any individual graphics setting moves the preset to **Custom** rather
than silently contradicting the preset label. Resolution scale above 1.0 is
supersampling — useful on a strong GPU at a low resolution.

### Audio

| Setting | Default |
| --- | --- |
| Master volume | 0.75 |
| Music volume | 0.35 |
| Effects volume | 0.90 |
| Voice volume | 0.80 |
| UI volume | 0.60 |
| Ambience volume | 0.45 |
| Hit confirmation volume | 0.70 |
| Mute when tab loses focus | on |

All seven are independent buses, so you can turn music off and keep footsteps
loud — which is what a competitive player actually wants.

### Accessibility

| Setting | Default | Options |
| --- | --- | --- |
| Colourblind preset | Off | Off / Protanopia / Deuteranopia / Tritanopia / High contrast |
| High-contrast enemy outlines | off | |
| Reduced motion | off | |
| Flash reduction | off | |
| Head bob | on | |
| Subtitles | off | |
| Interface scale | 1.0 | 0.75 – 1.5 |
| Damage numbers | on | |
| Hit marker style | Cross | Cross / Dot / Brackets |

Notes on the choices here:

- **Colourblind presets** recolour team indicators, objective states, health bars
  and the hit marker together — not just one of them, which would leave the
  others unreadable.
- **Reduced motion** removes screen shake, camera kick, head bob and UI
  transitions in one switch, for players who need it. The individual switches
  remain for finer control.
- **Flash reduction** caps muzzle flash and explosion brightness, for
  photosensitivity.
- **Interface scale** is a real scale on the whole HUD and menu system, tested at
  1366×768 through ultrawide.
- **Subtitles** caption ability callouts and objective announcements.

### Gameplay / crosshair

| Setting | Default | Range |
| --- | --- | --- |
| Crosshair preset | Cross | any unlocked crosshair |
| Crosshair colour | `#7dffd0` | any hex colour |
| Crosshair size | 10 | 2 – 24 |
| Crosshair thickness | 2 | 1 – 6 |
| Crosshair gap | 4 | 0 – 16 |
| Centre dot | off | |
| Dynamic crosshair | on | |
| Minimap size | 170 px | 100 – 260 |

Dynamic crosshair expands with weapon bloom, so the crosshair tells you your
actual accuracy. Turning it off gives a static reference.

---

## Persistence and validation

Settings and bindings are written to `localStorage` immediately and mirrored to
the profile when signed in, so they survive a refresh and follow you between
devices on the same guest id or account.

Every value is re-validated on read: sliders clamp to range, enums fall back to
their default if unrecognised, unknown keys are dropped entirely, and a corrupt
or missing blob yields the full default set rather than a half-configured game.
This is covered by 30 tests in `progression.test.ts`, including a full
JSON round-trip.

---

## Pointer Lock

Mouse look requires Pointer Lock, which browsers only grant from a user gesture.
Clicking the game canvas requests it; `Escape` releases it.

One detail worth knowing, because it caused a real bug: a browser-initiated
release (the user pressing `Escape`) and a game-initiated release (opening a menu
in code) look identical to `pointerlockchange`. Treating both as "the user pressed
Escape" made every menu bounce straight to the pause screen. The input layer now
tracks which release it asked for. See `engine/input.ts`.
