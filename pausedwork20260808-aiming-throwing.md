# Paused work — aiming + throwing feature, 2026-08-08

Branch `feature/aiming-throwing`, worktree `C:\Users\MichaelLawrence\rockgame-arms`
(shares `.git` with the main clone; needs its own `npm install`). Everything below
is committed. Written so the next session can pick up without re-deriving anything.

**Where we are in one line:** the throw-lab poses an aimed arm with clamped joint
pivots, procedurally grips any forge rock at any size, and has a working wind-up →
release swing with a deterministic hand velocity — the next step is feeding
`LAB_SWING.lastRelease` into `StoneSkipSim.throwStone(...)`.

---

## 1. The throw lab (`throw-lab/`, port 5186, `npm run dev:throw`)

A new Vite workspace, the arm-pose editor for docs/03. Four orthographic panels
(2×2 via `scene.activeCameras` + per-camera `viewport`):

- **arm · side** — sagittal profile (looks along X). The throwing plane.
- **arm · top** — overhead (looks along −Y). The left/right aim plane.
- **wrist · side / wrist · top** — close-ups for fine wrist work.

The rig is `FpsArmsLow-optimized.glb` (repo root, also `public/assets/arms/`,
draco decoder vendored at `public/assets/vendor/draco/`). 51 joints,
`RightShoulder→RightArm→RightForeArm_→RightForearmRoll→RightHand→[5 fingers ×4]`.
The unused arm is hidden by scaling its Shoulder node to 1e-3 (one skinned mesh
covers both arms; a true 0 scale NaNs the skin).

Rest pose: shoulder down, forearm forward — 90° at the elbow — set by aiming bone
segments at world directions (`aimSegment`), so it doesn't depend on bind pose.

URL flags: `?rock=name&seed=N&size=0.10` (rock), `?side=Left|Right`, `?mirror=0`,
`?nogrip`. Consoles: `LAB` (scene/cams/rock/findNode), `LAB_PIVOT`, `LAB_SWING`,
`LAB_GRIP`.

### The outside view is a MIRROR, not a camera or arm choice

Decided with Michael (2026-08-08): we look at the **outside** of the arm (back of
hand) with the arm still pointing screen-right. Two findings force the mirror:

1. **Swapping arms does not change these views.** The two arms are mirror images
   across X, and the side camera looks *along* X — it flattens exactly the axis
   they differ on. Proven with renders: left vs right were visually identical.
2. Seeing the far face with the arm still pointing right is a *reflection*, which
   no rigid camera move can produce.

So `main.js` mirrors the rig root (`scaling.x *= -1`) **after** posing and grip
(they use the rig's real handedness; the mirror is display-only), and turns off
`backFaceCulling` because a reflection flips triangle winding. The hand reads
mirror-handed on screen by design — the real left/right player choice is a later
feature.

---

## 2. Procedural grip (`throw-lab/src/grip.js`) — DONE for the target range

Reads the actual rock surface and poses the fingers around it. Any forge rock,
any seed, any size. Key decisions, each fought for:

- **Contact is pure JS** — two-sided Möller–Trumbore from the rock centre
  (surface radius per direction; signed gap). Babylon `mesh.intersects` NEVER
  hits in this tree-shaken build; do not go back to it.
- **Natural curl**: the three joints of each finger bend in fixed anatomical
  proportions about the measured across-the-knuckles hinge, stepping until the
  fingertip reaches the rock, a phalanx would penetrate (back off), or the tip
  reaches the palm (a supporting fist). Fingers always end on rock-or-fist,
  never floating.
- **Adduction closes the gaps**: before curling, each finger's base joint swings
  about the palm normal so its tip aims at the middle fingertip (ring 0.55,
  index/pinky 0.9). Aiming *parallel* is not enough — the model fans the
  fingers apart. Do not aim at the rock point either; that splays them.
- **Size bands** (Michael's spec): ≤8 cm **pinch** (seated forward at the
  thumb–index crook, others fist); 9–15 cm **wrap** (seated in the thumb–index
  web, sliding palm-ward with size); ≥16 cm **power** (palm centre, flatter
  tilt, no web-fitting).
- **Thumb** opposes on its own axis with a deliberately short curl budget
  (`THUMB_TARGET [32,30,18]°`) so it presses the stone's **side face** instead
  of rolling over the top. Its penetration check skips its own proximal phalanx
  (`penFrom=2`) — that joint sits AT the web where the rock is seated and
  otherwise trips on step one, leaving the thumb stuck extended.
- Rock is tilted on edge (~55–60°, 25° for power grips) about the knuckle line.

Known cosmetic artifacts, both outside the 9–12 cm gameplay range: the index
kicks out slightly at 9 cm; the pinky at 16 cm.

---

## 3. Aim pose — pivot handles + limits (`throw-lab/src/pivot.js`)

Click-and-hold a blue joint dot, drag around it; the bone follows the cursor
(drag sign calibrated per grab by test-rotating and projecting, so it stays
direct through the mirror). Each panel edits the DOF in its own plane — the
axis pointing into the screen:

| panel | joints | axis |
| --- | --- | --- |
| arm · side | shoulder (`Arm`), elbow (`ForeArm_`), wrist (`Hand`) | world X |
| arm · top | same three | world Y |
| wrist · side | wrist only (fine) | world X |
| wrist · top | wrist only (fine) | world Y |

A `− NN° +` readout appears at the joint on first grab and stays; buttons nudge
±1°. Wrist X/Y are shared DOFs, so their readouts sync across panels.

**Anatomical limits**, clamped in the single shared rotation path (drag, nudge,
and `LAB_PIVOT.rotate` all pass through it — nothing can over-rotate): shoulder
X −170..+45, shoulder Y ±90, elbow X −55..+90 (+90 parks at a dead-straight arm,
no hyperextension), elbow Y ±80, wrist X −70..+75, wrist Y ±40. Signs verified
empirically (+X swings the hand down/back).

**Framing never loses the arm**: whole-arm panels frame the reachable envelope
(shoulder-centred, radius = sum of segment lengths); wrist close-ups frame a
hand-reach envelope centred on the wrist and re-centre on it every frame.

CSS gotcha that will bite again: a class with `display:flex` beats the `hidden`
attribute — `.pivot-readout[hidden]{display:none}` is load-bearing.

---

## 4. Swing gesture (`throw-lab/src/swing.js`) — the hand-velocity input

Michael's spec: "a simple arc with a button/circle the user can drag."

A dashed arc around the **shoulder** in arm·side; an amber knob rides it at the
hand. Drag the knob back = wind-up (the whole aimed arm rotates rigidly about
the shoulder; elbow/wrist keep their aimed angles — `w` is tracked as an offset
from the aim pose so `w=0` restores it exactly). Mouse-up fires: constant-α whip
forward, **release at the aim pose** (amber tick), symmetric follow-through,
smoothstep settle back to aim. Verified: returns to the aim pose to the mm.

**Determinism (docs/04 rule):** release speed is analytic —
`v = SPEED_PER_DEG × windup°` at the hand, tangent to the swing circle, captured
at fire time. NOT integrated from frames; the animation is presentation only.
`SPEED_PER_DEG = 0.15` m/s per degree (90° ≈ 13.5 m/s) is a feel value — decide
in engine. Verified: 70.3° wind-up → exactly 10.5 m/s @ 38° elevation.

Release readout persists on screen (legible-physics rule), and
`LAB_SWING.lastRelease = {speed, elevationDeg, dir, windupDeg}`.

---

## 5. Next steps, in order

1. **`throwStone` hookup** — feed `LAB_SWING.lastRelease` into
   `StoneSkipSim.throwStone({speed, elevationDeg, headingDeg, ...})`.
   `stone-skipping-physics` is dependency-free; only its `babylonAdapter.js`
   may touch Babylon. Heading comes from the top-plane aim (shoulder/elbow Y);
   attack/bank angles from the wrist pose. Show the skip result in the lab.
2. **Release timing as gameplay** — currently release is always exactly at the
   aim pose; the sweet-spot window (docs/03, decide-in-engine) comes later.
3. **Wrist twist / spin axis** — `RightForearmRoll` is rigged and unused; it is
   the sidearm/overhand → spin-axis control.
4. **Left/right player hand choice** — deferred; see the mirror note in §1.
5. Cosmetic grip artifacts (§2) if they ever matter.

---

## 6. Lab-environment gotchas (will cost an hour each if forgotten)

- **The dev server dies orphaned on this machine** (exit 255). Guard every
  headless probe: `if server !200 { Start-Job {npm run dev:throw}; sleep ~10 }`
  then probe **in the same PowerShell call**. And beware the opposite trap: a
  *stale* server serving old code — two "identical" renders in this session
  were that, not a real no-op. When a change mysteriously does nothing,
  kill the listener on 5186 and restart before debugging the code.
- Tree-shaken Babylon: `scene.transformNodes` (array), not `getTransformNodes()`;
  `mesh.intersects()` never hits (see §2).
- After posing bones, force **two passes** of `computeWorldMatrix(true)` over
  all transform nodes, or finger grandchildren keep bind-pose world positions.
- Headless probes run Playwright's chromium from `C:/QA-Automation/node_modules`
  (this repo deliberately has no Playwright dep).
