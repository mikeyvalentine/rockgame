// World constants, kept DOM-free so the physics can be exercised headlessly.

// One world unit = 1/U metres. Modelling the beach at 4x real size keeps the
// stones well clear of Havok's collision margins; scaling gravity by the same
// factor means the motion still plays back at real-world speed.
export const U = 4;
export const GRAVITY = -9.81 * U;

// The shore is flat. There used to be a dish scooped out of it, 13 cm deep,
// which held the pile in a neat heap — and read on screen as the stones sitting
// at the bottom of a pit. A real bank of pebbles is a shallow spread on flat
// ground, so the ground is flat and the pile is allowed to find its own angle of
// repose. BED_RADIUS is no longer a wall, just the radius the bed is expected to
// occupy: it sizes the gravel ring, the region a sweep can start in, and the
// distance past which a stone counts as having left the shore.
export const BED_RADIUS = 0.42;   // metres
// Stones rain over this whole disc rather than being tipped into the middle, so
// the bed comes out as a broad field a few stones deep instead of a cone.
export const POOL_RADIUS = 0.38;  // metres
export const ROCK_COUNT = 540;

// Havok is stepped at a fixed rate rather than at the frame delta. A variable
// step is what makes a dense pile detonate: at 30 fps the solver gets a single
// 33 ms step, stones move further than their own thickness inside one step, end
// up deeply overlapped, and the next step fires them apart. Frames slower than
// MAX_FRAME_MS make the simulation run in slow motion instead of blowing up.
//
// AUDIT #B6: 1/60 rather than 1/120 — half the solver work per frame over a
// bed that is at rest almost always. tools/sift-test.mjs validates the bed
// still settles and sweeps cleanly at this rate; if a future bed detonates,
// this is the first number to revisit.
export const PHYSICS_SUBSTEP_MS = 1000 / 60;
export const MAX_FRAME_MS = 40;

// Stones are poured one even sheet over the whole field at a time, each sheet
// settling before the next lands. Dropping the whole bed at once builds a column
// about a metre tall, and stones arriving at 4 m/s move further per step than
// their own thickness — so they tunnel straight through the ground.
export const LAYER_STEPS = 110;  // substeps of SETTLE_DT between sheets
export const FINAL_STEPS = 400;  // substeps once the last sheet is down
export const SETTLE_DT = 1 / 240;
export const SPAWN_GAP = 0.02;   // metres of clearance above the current pile

// Fingertips rather than a shovel: 3.3 x 1.8 x 2.3 cm, a quarter of the size the
// sweep used to be on every axis. It is now smaller than most of the stones it
// is pushing, so it parts them instead of scooping the whole bed.
export const HAND = { width: 0.0325 * U, height: 0.0175 * U, depth: 0.0225 * U };
// The field settles about 10 cm deep, so the sweep spans from the sand under it
// to just over the top of it.
export const DIG_MIN = 0.01, DIG_MAX = 0.12;
export const HAND_SPEED = 1.25 * U; // 1.25 m/s — an unhurried sweep
// How far out a sweep can be started, as a multiple of BED_RADIUS. Generous on
// purpose: strays end up well outside the bank, and being unable to start a
// sweep on top of one is the difference between a hand and a fixed turntable.
export const SWEEP_REACH = 4;
// The sweep rides at whichever is lower, the dig depth you chose or the top of
// whatever is actually beneath it — sampled within this radius, in metres.
export const SWEEP_PROBE_RADIUS = 0.05;

// Dragging a stone rather than sweeping through them. It is carried kinematically
// so it shoulders the bed aside on the way, and keeps that momentum when let go —
// which is what will make it possible to lob one into a bucket.
export const CARRY = {
  height: 0.13,      // metres above the sand, clear of the bank
  // A damped spring, in acceleration terms. `damping` near 2*sqrt(stiffness) is
  // critical — under it the stone overshoots the pointer and wobbles.
  stiffness: 260,
  damping: 30,
  // The ceiling on how hard the stone can ever be pulled, and so on how hard it
  // can shove the bed. Gravity here is 39.2, so this is about 4.5 g: enough to
  // work a stone up out of the bank, not enough to rip it free.
  maxAccel: 180,
  spinDamping: 0.85, // per substep, so a dragged stone does not windmill
};

// Nothing in a bed of pebbles has any business moving faster than this.
export const MAX_SPEED = 5 * U;
export const MAX_SPIN = 30;
