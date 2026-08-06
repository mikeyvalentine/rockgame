# sand-sim

First-person beach sand simulation lab for **Rock Game** (see
`../docs/09-sand-sim.md`). Walk a shore, leave footprints, dig, kick up loose
grains — a deformable-heightfield sand sim with a pebble/sand material split,
built to prove the look and feel of the game's walkable beach zone.

Standalone Vite project; not wired into the game app that lives one folder up.

## Running

```bash
# from the REPO ROOT — the labs are npm workspaces, one install covers all.
# Running `npm install` in here creates a nested node_modules and a second
# copy of Babylon, which is the bug the workspace exists to prevent.
npm install
npm run dev      # vite dev server on http://localhost:5185
npm run build    # production build into dist/
npm test         # headless checks (node tools/*.mjs)
```

Requires a WebGPU-capable browser for the full renderer (Chrome/Edge 113+).
A reduced-fidelity WebGL2 fallback is part of the project (force it with
`?webgl=1`; force WebGPU with `?webgpu=1`).

## Status

All ten conversion phases are in:

- **First person** — pointer lock, WASD, Shift sprint; footprints synthesized
  from the locomotion controller's own gait events.
- **HDRI environment** — `autumn_field_puresky_4k.hdr` drives the visible sky
  (a LUT skybox), the SH ambient, the fog inscatter and the water's
  reflections; the sun direction is found automatically from the HDRI's
  brightest texel, so shadows and light shafts match the baked sun disc.
- **Beach** — parametric shore profile (`src/terrain/beachParams.js`): foreshore
  crossing y=0 exactly at the waterline, flat seabed, berm, dune backdrop.
  Static PBR water plane (no water sim).
- **Sand** — SNOWFLOW's deformable-heightfield state buffer restyled: pale cool
  grey-beige, wet band at the waterline (analytic + a dynamic wetness channel),
  quartz sparkle, warm rim scatter, footprints that persist (sand barely
  self-heals; wet sand holds its shape).
- **Pebbles** — a shingle band hugging the waterline (same deformation sim,
  different skin: procedural voronoi cobbles), paintable at runtime with the
  overlay's mask brush.
- **Hybrid grains** — a capped, budgeted pool of persistent grains that fly,
  roll downslope past the angle of repose, then settle and deposit their mass
  back into the heightfield. Slider to zero; the sim never depends on them.
- **Dig** — hold LMB: carve a rimmed hollow, fling grains, expose damp sand.
- **Pausable sim** — the deformation pass only dispatches while something
  disturbs the sand (the F1 overlay shows `stepping / asleep`).
- **WebGL2 fallback** — first-class, reduced fidelity: same JS systems, GLSL
  twin of the deformation ping-pong at half resolution, PBR sand with a tonal
  deformation plugin, stock post. Force it with `?webgl=1`.

## Controls

Click to lock · WASD move · Shift sprint · **hold LMB to dig** · F1 settings &
performance overlay (every post stage and system toggleable; mask brush under
"Mask brush" — pick a mode, then click-drag on the sand while unlocked).

## Attribution

Derived from **SNOWFLOW** by Maksymilian Dendura —
[github.com/Noniv/snowflow_demo](https://github.com/Noniv/snowflow_demo),
MIT license (see `LICENSE`, kept verbatim). The terrain clipmap, deformation
state buffer, shading architecture, WGSL library, post chain, and settings/perf
overlay originate there; this project subtracts the character/spells/surf
systems, converts to first person, swaps the analytic sky for an HDRI, reshapes
the terrain into a beach, and restyles snow into sand and pebbles with a
loose-grain hybrid layer and a WebGL2 fallback path.

HDRI: `autumn_field_puresky_4k.hdr` (Poly Haven, CC0) — arrives in phase 2.
