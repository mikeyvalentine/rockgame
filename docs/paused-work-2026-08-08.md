# Paused work — aiming/throwing + skin customization, 2026-08-08

Where the arm feature stands, written so the next session can pick up without
re-deriving anything. Everything here is read out of the committed code, not
assumed. Companion to `03-throwing.md` (the spec) — this is the *implementation*
state.

All of this is on branch **`feature/aiming-throwing`**, merged to `main`
(merge `3d38308`) and deployed. It lives in a separate worktree
`C:\Users\MichaelLawrence\rockgame-arms` so the water/terrain work on the main
clone is untouched. Two new Vite workspaces:

| Lab | Port | Dev | What |
| --- | --- | --- | --- |
| `throw-lab` | 5186 | `npm run dev:throw` | The aim-pose editor + swing + grip |
| `skin-lab`  | 5187 | `npm run dev:skin`  | Character skin customization |

Both are in the hub menu (`src/screens/menu.js`) and the deploy build
(`tools/build-site.mjs`). `npm run dev` at the worktree root starts everything.

---

## 1. The arm rig

`public/assets/arms/FpsArmsLow-optimized.glb` (51 KB, draco). **Rigged** — skin
with 51 joints, `JOINTS_0/WEIGHTS_0`. Hierarchy per side:
`…Shoulder → …Arm → …ForeArm_ → …ForearmRoll → …Hand → [5 fingers ×4]`.

- The FIRST upload (`FpsArmsLow-compressed.glb`) was a **static mesh** —
  convert3d.org stripped the armature. Compression does not strip rigs; the
  online tool did. Use the `-optimized` one.
- The mesh has **no UVs** (attributes are only `POSITION/NORMAL/JOINTS_0/WEIGHTS_0`)
  and its baked material is a flat `baseColorFactor`. This is why the skin lab
  projects its texture triplanar-ly (§4) — there are no UVs to map onto.
- GOTCHA — the tree-shaken ES build exposes `scene.transformNodes` as an **array**,
  not `scene.getTransformNodes()`.
- After posing a bone, force a **2-pass** `computeWorldMatrix(true)` over all
  transform nodes or the finger grandchildren keep bind-pose world positions and
  the framing blows up.

Only one arm is posed; the other is collapsed by scaling its shoulder bone to
`1e-3` (not 0 — a singular bone matrix NaNs the skin). `SIDE="Right"`;
`?side=Right|Left` and `?flip=1` (view the far face) exist because the two arms
are mirror images across X and the side camera flattens that axis.

---

## 2. throw-lab — the pose editor, swing, grip

**Layout.** Four orthographic panels (2×2, `scene.activeCameras` + per-cam
`viewport`): whole-arm SIDE + TOP, and a wrist close-up of each. Cameras are
fitted to the right-arm joint world positions projected onto the screen axes, so
the framing follows whatever pose the arm holds — not a hand-tuned box. Rest pose
= upper arm straight down, forearm forward (a 90° elbow), set by `aimSegment`
(rotate a bone so its segment points along a world direction — orientation-agnostic).

**Layer-1 pose = `pivot.js`.** Per-joint drag handles, one DOF per panel plane:
side panels rotate about world **X** (fore/back swing), top panels about world
**Y** (left/right aim). Handles: shoulder/elbow/wrist in arm·side (X) and
arm·top (Y), plus fine wrist control in the wrist panels. Drag a joint dot to
pivot (drag sign auto-calibrated per grab so it feels direct through the mirror);
a `− NN° +` readout with ±1° nudge buttons appears by each joint. **Anatomical
`LIMITS`** clamp cumulative rotation per DOF (e.g. elbow X `[-55°, +90°]`, +90 =
straight arm, no hyperextension). Console/automation: `LAB_PIVOT.rotate(joint,
"X"|"Y", deg)` drives the same clamped path; `LAB_PIVOT.angles()` reads the pose.
**This answers a docs/03 OPEN: the pose is DIRECT joint manipulation, not IK.**

**Swing = `swing.js`** (docs/03 "Model B", first slice). An arc drawn around the
shoulder in arm·side with a knob dragged back to wind up; the whole aimed arm
rotates rigidly about the shoulder (elbow/wrist keep their aimed angles). On
release it whips forward through the aim pose (marked by a release tick), a
symmetric follow-through, then a smoothstep settle back to the aim.
**DETERMINISM (docs/03, non-negotiable rule 4):** release speed is analytic —
`v = SPEED_PER_DEG × windup°` at the hand, tangent to the swing circle — NOT a
framerate-measured velocity; the animation is presentation only. `SPEED_PER_DEG`
= 0.15 is a **feel value (decide in engine)**. Output for the solver hookup:
`LAB_SWING.lastRelease = {speed, elevationDeg, dir{x,y,z}, windupDeg}`, plus an
on-screen `release  N m/s @ N°` readout (rule 2: variables that decide an outcome
are shown).

**Grip = `grip.js`** (v4). Procedural, surface-driven, re-fits any rock. Contact
is **pure-JS two-sided Möller–Trumbore ray-tri** from the rock centre —
`mesh.intersects` NEVER hits in this tree-shaken build (that was the root cause
of an early "claw" grip). Size bands: **≤8 cm PINCH** (front crook, between thumb
and index, other fingers into a supporting fist), **9–15 cm WRAP** (thumb-index
web, sliding palmward as it grows), **≥16 cm POWER** (palm centre, no web-fit).
Fingers adduct together (converge to the middle fingertip) so there are no
sideways gaps; the thumb presses the **side face**, not the top (its curl budget
is cut short of a full wrap); `closeFinger` skips the thumb's own proximal
phalanx in the penetration check (it sits at the seat) and has a DRAPE floor so a
finger over a too-big rock bends on instead of kicking straight. Rock comes from
rock-forge geometry (`rock.js`, pure-JS bake → Babylon VertexData), parented to
the hand. Flags: `?size=` (metres, default 0.10), `?rock=`, `?seed=`, `?nogrip`.

---

## 3. What the throw still needs (where to put your hands)

The pieces exist but are **not yet joined into a throw**:

1. **Feed the solver.** `LAB_SWING.lastRelease` gives speed + elevation + a 3D
   `dir`, but only in the **side plane**. The **line/heading** lives in the
   top-panel Y aim (`LAB_PIVOT.angles()`), and is not yet combined into the
   release vector. Assemble the full `StoneSkipSim.throwStone({speed,
   elevationDeg, headingDeg, attackAngleDeg, bankAngleDeg, spinRPS,
   spinAxisTiltDeg, …})` call from pose + swing. `stone-skipping-physics` is
   dependency-free; only its `babylonAdapter.js` touches Babylon.
2. **Layer 2 sweet spot** (docs/03). The swing has a deterministic wind-up→release
   arc, but release currently fires at the aim-pose crossing. The *sweet spot =
   the arc point where hand velocity points at the intended target*, plus the
   learnable early/late error model, is not built.
3. **Layer 3 attack angle** — the keyboard counter-steer against a daily-seeded
   drift is not started.
4. **Spin** — from arc flatness (speed) and pose (axis), perturbed by rock
   shape; not started.

---

## 4. skin-lab — character skin customization

Two live controls previewed on the posed arm and a sphere swatch. All the look is
in `skin-lab/src/skin-material.js`; `main.js` loads geometry and wires the DOM.

- **Triplanar** projection (the arm has no UVs) from **object-space** position, so
  pores stay put under skinning. One self-contained `ShaderMaterial` (not the PBR
  pipeline) with bone skinning via the Babylon includes
  (`#include<bonesDeclaration|bonesVertex>`, defines `NUM_BONE_INFLUENCERS 4` +
  `BonesPerMesh bones+1`, `mBones` bound each draw from
  `skeleton.getTransformMatrices(mesh)`). A plain sphere uses the same shader with
  `NUM_BONE_INFLUENCERS 0`.
- **Colour** — the photo diffuse is reduced to neutral pore/cell **detail** and the
  chosen albedo is multiplied through it, so ANY colour (natural or not) reads
  cleanly. A natural light→dark **tone slider** (a realistic skin locus) plus a
  free **Custom** colour picker.
- **Age** — one height field (map pores + procedural ridged-fbm **macro wrinkles**)
  drives a tangent-free derivative bump (Mikkelsen, `dFdx/dFdy`, WebGL2); age also
  ramps AO, roughness and a sallow desaturation. Young → smooth; old → deep pores,
  emergent wrinkles, desaturated.
- Textures: `public/assets/skin/1K-human_skin_3_*` (`smoothness` = INVERTED
  roughness). Controls seedable via URL for headless capture:
  `?preview=arm|sphere|both&tone=&age=&color=RRGGBB&scale=`. Console: `SKIN`,
  `SKIN_CTL`.

**Feel/polish left:** young skin is a touch plasticky; aged spec runs a little
hot; the wrinkles read as rough relief more than directional creases (a directed
wrinkle field along the limb is the follow-up); `detail` (pore size) default 22.
**Not yet wired into a saved character-customization state** — it's a preview lab.

---

## 5. Environment notes

- **Dev-server gotcha:** `dev:throw`/`dev:skin` orphan and die on this machine
  (exit 255) whether backgrounded by the harness or `Start-Process`. Reliable
  pattern: guard every probe with `if server !200 { Start-Job {npm run dev:…};
  sleep ~11 }` and then probe **in the same shell call**.
- **Rendering/inspection** is done headless via a Playwright chromium imported
  from `C:\QA-Automation\node_modules` (WebGL2 path). `globalThis.LAB` /
  `LAB_PIVOT` / `LAB_SWING` / `SKIN` expose the internals for probes.
- **Deploy:** push to `main` → Cloudflare Pages auto-builds (`build:site`, Node
  22) → live at `https://rockgame.pages.dev/<lab>/`. Only `git ls-files
  public/assets` ships — a runtime-fetched asset MUST be tracked under
  `public/assets/` or it 404s in prod. `gh` CLI is not installed here, so PRs are
  completed as a no-ff merge to `main` + push.
