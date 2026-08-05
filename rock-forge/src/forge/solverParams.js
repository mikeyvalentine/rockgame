// The forge -> skip-solver bridge: turn a generated rock into a stone the physics
// can throw, and into the stats the player is graded on.
//
// The link this closes is the one that makes a rock's *appearance* and its
// *behaviour* the same thing. Everything the solver needs — mass, centre of mass,
// the inertia tensor, the surface the water pushes on — is measured off the same
// geometry that gets drawn, so a stone that looks warped throws warped, with nothing
// authored twice and nothing to keep in sync.
//
// Deliberately coarse. The physics does not need the rock's fine detail: pits,
// cracks and small holes are below the resolution that matters to a bounce, and the
// solver decimates whatever it is given down to ~192 pressure panels regardless. So
// the mesh handed to the physics is a low LOD, and it is chosen by measurement — see
// SOLVER_LOD.

import { buildDetailMesh } from "./bake.js";
import { skipRating } from "./metrics.js";
import { shapeDescriptors } from "../../../shared/meshMassProperties.js";

/**
 * Icosphere level used for the physics mesh. 3 = 642 verts / 1280 triangles.
 *
 * Measured, not guessed — and the measurement corrected a wrong guess. Level 2 looks
 * like plenty for something that gets decimated to ~192 pressure panels anyway, but
 * against a level-4 reference it comes out **6.7% light on volume and 9.4% off on
 * spin inertia**. That is not surface detail being lost, it is a systematic bias: a
 * polyhedron inscribed in the shape cuts every corner, so it under-reads volume in
 * one direction. Mass is not something to be approximate about, because it sets m/R,
 * which sets balance, which sets how long a run lasts.
 *
 * Level 3 lands at 1.4% on volume and 2.3% on inertia, and costs nothing that
 * matters: it runs once per rock, lazily, and the panel decimation collapses it to
 * ~192 panels immediately afterwards.
 *
 * What IS safely coarse is everything below this scale — pits, cracks, small holes.
 * Those are volume integrals' blind spot by nature and never reach the water.
 *
 * The rock the player SEES is unaffected and still built at whatever level the
 * renderer wants; this is only the copy the water reads.
 * `tools/solver-bridge-test.mjs` holds the convergence table.
 */
export const SOLVER_LOD = 3;

/** Coarser level, for bulk work where a few percent on mass is acceptable. */
export const SOLVER_LOD_COARSE = 2;

const cache = new WeakMap();

/**
 * Geometry + measured properties for one forged rock, computed once and memoised.
 *
 * Lazy on purpose: a sift bed holds hundreds of rocks the player never touches, and
 * this is a full mesh pass. Call it when a stone is picked up, inspected or thrown —
 * not when the field loads.
 */
export function rockPhysics(shape, archetypeParams, sizeMetres, { level = SOLVER_LOD } = {}) {
  let perShape = cache.get(shape);
  if (!perShape) { perShape = new Map(); cache.set(shape, perShape); }
  const key = `${sizeMetres.toFixed(6)}:${level}`;
  const hit = perShape.get(key);
  if (hit) return hit;

  const mesh = buildDetailMesh(shape, archetypeParams, level, sizeMetres);
  // positions/indices are already metres in body axes, and the shape model puts the
  // SHORT axis on Y (`ay = min(axes[1], axes[2])` in shape.js) — which is exactly the
  // solver's convention that body Y is the face normal the stone spins about. So no
  // re-alignment: the rock is handed over in the frame it was generated in, and a
  // stone whose weight sits off that axis keeps the wobble that causes.
  const geometry = { positions: mesh.positions, indices: mesh.indices };
  const descriptors = shapeDescriptors(mesh.positions, mesh.indices, shape.density);

  const out = { geometry, descriptors, level, sizeMetres };
  perShape.set(key, out);
  return out;
}

/**
 * A stone object ready to hand to `new StoneSkipSim({ stone })`.
 *
 * `mesh` makes the solver measure everything off the geometry instead of treating
 * the rock as an idealised disc. `density` comes from the archetype, so slate and
 * quartz differ by weight as well as by looks.
 */
export function solverStone(shape, archetypeParams, sizeMetres, opts = {}) {
  const { geometry } = rockPhysics(shape, archetypeParams, sizeMetres, opts);
  return {
    mesh: geometry,
    density: shape.density,
    // Balance is derived from the mesh rather than authored; 'auto' tells the solver
    // to read it off the geometry it was just given.
    balanceRetention: "auto",
  };
}

/**
 * Full player-facing metrics for one rock, graded from its real geometry.
 *
 * `instanceMetrics()` in bake.js stays the cheap path — analytic span and volume, no
 * mesh — and is what the field uses. This is the expensive one, for the stone in the
 * player's hand: it measures flatness, asymmetry and the true centre-of-mass offset,
 * the last of which bounding dimensions cannot see at all.
 */
export function detailedMetrics(shape, archetypeParams, sizeMetres, opts = {}) {
  const { descriptors } = rockPhysics(shape, archetypeParams, sizeMetres, opts);
  const sortedCm = [descriptors.extent.x, descriptors.extent.y, descriptors.extent.z]
    .map((v) => v * 100)
    .sort((a, b) => b - a);
  const metrics = {
    sortedCm,
    massGrams: descriptors.mass * 1000,
    massKg: descriptors.mass,
    volume: descriptors.volume,
    shape: descriptors,
  };
  metrics.rating = skipRating(metrics);
  return metrics;
}
