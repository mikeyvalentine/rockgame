// The ambient wave field — the CANONICAL water surface, in plain JS.
//
// Lives in shared/ because three things need the same surface and none of them
// should have to depend on a lab to get it: babylon-water renders it,
// the skip solver planes on it, and the game will need to place the cairn and
// read conditions against it. It has no imports and must keep none — that is
// what lets the dependency-free solver package be tested against it.
//
// This is the SAME analytic function as AMBIENT_GLSL in index.html: four
// directional octaves turned into the wind, deep-water dispersion per octave
// (c = sqrt(gL/2pi), longer waves genuinely travel faster), amplitudes scaled
// so steepness holds under waveScale. It exists so the stone-skipping solver
// can plane on the water the player actually sees:
//
//   import { sampleAmbient } from "/shared/ambientWater.js";
//   const sim = new StoneSkipSim({
//     water: (x, z, t) => sampleAmbient(x, z, t, { windStrength, windDirDeg, waveScale }),
//   });
//
// The interaction sim (drops/ripples) is deliberately NOT included: it lives
// in a GPU window around the stone and is visual detail; what the solver needs
// is the metre-scale ambient surface, which is this, exactly.
//
// DRIFT GUARD: the octave table below must match AMBIENT_GLSL in
// babylon-water/index.html verbatim. babylon-water/tools/ambient-sync-check.mjs
// parses that GLSL and fails the test run if the two ever disagree — edit them
// together. The guard stays in babylon-water because that is where the GLSL is.

/**
 * THE POND'S CONDITIONS — one definition, because three places need them and
 * they had already drifted once.
 *
 * From the 2026-08-06 dialled look: near-glass. Strength 0.01 is the hero-calm
 * morning docs/11 names, with the swell stretched long (waveScale 8 puts the
 * octaves at 7.2 m down to 1.2 m) so what little motion remains is a slow heavy
 * roll rather than chop. Wind out of 93 degrees.
 *
 * These are the conditions the skill ladder in docs/04 is measured against, so
 * moving them moves every score in the game. They are also what the sampler
 * falls back to when a caller passes no wind — the old fallback was 0.55 / 25 /
 * 4, which matched neither lab and quietly described a much choppier pond than
 * either one renders.
 *
 * The daily challenge will roll conditions around this baseline
 * (docs/05-scoring.md); this is the still-water centre they vary from.
 */
export const POND_CONDITIONS = Object.freeze({
  windStrength: 0.01,
  windDirDeg: 93,
  waveScale: 8.0,
});

/** [wavelength x S, amplitude x A x S, direction (pre-wind-rotation)] */
export const OCTAVES = [
  [0.90, 0.0045, [1.00, 0.15]],
  [0.55, 0.0028, [0.80, -0.60]],
  [0.28, 0.0014, [-0.40, 0.90]],
  [0.15, 0.0007, [0.20, 1.00]],
];

const TAU = 6.2831853;
const G = 9.81;

/**
 * Ambient water surface at world (x, z), time t seconds.
 *
 * @param {number} x  world metres
 * @param {number} z  world metres
 * @param {number} t  seconds (the page uses performance.now() * 0.001)
 * @param {object} [w] wind — same numbers as the page's WIND panel state
 * @param {number} [w.windStrength=0.01]  0 glass … 1 choppy (POND_CONDITIONS)
 * @param {number} [w.windDirDeg=93]      wind heading, degrees (POND_CONDITIONS)
 * @param {number} [w.waveScale=8]        stretches all wavelengths together (POND_CONDITIONS)
 * @returns {{height:number, slope:{x:number,z:number},
 *            normal:{x:number,y:number,z:number},
 *            flow:{x:number,y:number,z:number}}}
 *          height in metres; normal unit-length; flow zero (no current —
 *          docs/01 cut it). Shape matches StoneSkipSim's `water` option.
 */
export function sampleAmbient(x, z, t, w = {}) {
  const A = w.windStrength !== undefined ? w.windStrength : POND_CONDITIONS.windStrength;
  const S = w.waveScale !== undefined ? w.waveScale : POND_CONDITIONS.waveScale;
  const dirRad = ((w.windDirDeg !== undefined ? w.windDirDeg : POND_CONDITIONS.windDirDeg) * Math.PI) / 180;

  // GLSL: w = normalize(windDir + vec2(1e-6, 0)); mat2(w.x, w.y, -w.y, w.x).
  // windDir on the page is (cos, sin) of the heading, so the matrix is a plain
  // rotation by dirRad; the 1e-6 nudge only matters at exactly zero wind.
  const wx = Math.cos(dirRad), wy = Math.sin(dirRad);

  let height = 0, sx = 0, sz = 0;
  for (let i = 0; i < OCTAVES.length; i++) {
    const L = OCTAVES[i][0] * S;
    const amp = OCTAVES[i][1] * A * S;
    const d = OCTAVES[i][2];
    // rot * normalize(d)
    const dl = Math.hypot(d[0], d[1]);
    const nx = d[0] / dl, ny = d[1] / dl;
    const dx = wx * nx - wy * ny;
    const dz = wy * nx + wx * ny;

    const k = TAU / L;
    const c = Math.sqrt((G * L) / TAU);
    const ph = k * (dx * x + dz * z) - k * c * t;
    const sin = Math.sin(ph), cos = Math.cos(ph);
    height += amp * sin;
    sx += amp * cos * k * dx;   // dh/dx — matches ambientWave's .y component
    sz += amp * cos * k * dz;   // dh/dz — matches ambientWave's .z component
  }

  const inv = 1 / Math.hypot(sx, 1, sz);
  return {
    height,
    slope: { x: sx, z: sz },
    normal: { x: -sx * inv, y: inv, z: -sz * inv },
    flow: { x: 0, y: 0, z: 0 },
  };
}

/** Bind wind once, get the solver-shaped callback. Defaults to POND_CONDITIONS. */
export function makeAmbientWater(w = {}) {
  return (x, z, t) => sampleAmbient(x, z, t, w);
}
