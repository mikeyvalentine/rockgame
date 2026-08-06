// node babylon-water/tools/scheme-stability-check.mjs   (part of `npm test`)
//
// Is the water integrator stable at the constants the page is actually using,
// and are its waves still the right speed?
//
// ## The regression this exists to prevent, because it already happened
//
// The height-field solver is Evan Wallace's: `v += (average - h) * C; h += v`,
// with a global velocity damping. Two constants govern it, and they are not
// independent — which is exactly what got missed.
//
// For the CHECKERBOARD mode (alternating every texel) the 4-neighbour average is
// exactly `-h`, so the update collapses to `v' = damp * (v - 2*C*h)`. At C = 2 —
// Wallace's value — the eigenvalues are a DEFECTIVE double root at -1. That is
// marginal stability with `n * lambda^n` transient growth, and it grows at every
// damping value: measured peak 13x over 600 steps at the original damp 0.990.
//
// Nobody saw it, because 0.990 flattened the field in about three seconds and
// the growth never had time to show. Then the damping was raised to 0.9992 so
// ripples would last a run — and the same mode reached 49x and rendered as a
// full-screen two-pixel hatch across the pond.
//
// The lesson is the assertion below: it is not enough for the scheme to be
// bounded, and it is not enough to test it at one damping. The GRID-SCALE mode
// has to stay bounded across the whole range the slider can reach, because a
// look knob must not be able to break the integrator.
//
// Constants are parsed out of index.html rather than duplicated here, so this
// tests the page as shipped.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const num = (re, label) => {
  const m = html.match(re);
  if (!m) { check(`parse ${label}`, false, "not found in index.html"); return NaN; }
  return Number(m[1]);
};

const WAVE_C  = num(/const WAVE_C\s*=\s*([0-9.]+)/, "WAVE_C");
const DAMPING = num(/RIPPLE\s*=\s*window\.RIPPLE\s*=\s*\{\s*damping:\s*([0-9.]+)/, "RIPPLE.damping");
const SIZE    = num(/const SIZE\s*=\s*([0-9.]+)/, "SIZE");
const RES     = num(/const RES\s*=\s*([0-9]+)/, "RES");
const STEPS   = num(/const STEPS\s*=\s*([0-9]+)/, "STEPS");

/**
 * Peak excursion of the checkerboard mode over `n` steps.
 *
 * Two states are enough: at theta = pi the spatial operator is exactly -2h, so
 * the whole 2D field reduces to this scalar recurrence. No grid needed.
 */
function gridModePeak(C, damp, n = 600) {
  let h = 1, v = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    v = damp * (v - 2 * C * h);
    h = h + v;
    peak = Math.max(peak, Math.abs(h));
  }
  return peak;
}

/** Cells per step, by tracking the peak of a pulse — the way the 0.694 in
 *  index.html's coupling comment was originally measured. */
function cellsPerStep(C, n = 400) {
  const N = 800;
  const h = new Float64Array(N), v = new Float64Array(N);
  for (let i = 60; i < 66; i++) h[i] = 1;
  for (let s = 0; s < n; s++) {
    const hp = h.slice();
    for (let i = 1; i < N - 1; i++) {
      const avg = (hp[i - 1] + hp[i + 1]) * 0.5;
      v[i] = 0.999 * (v[i] + (avg - hp[i]) * C);
      h[i] = hp[i] + v[i];
    }
  }
  let best = 63, bv = 0;
  for (let i = 64; i < N - 1; i++) if (Math.abs(h[i]) > bv) { bv = Math.abs(h[i]); best = i; }
  return (best - 63) / n;
}

console.log(`\n  WAVE_C ${WAVE_C} · damping ${DAMPING} · SIZE ${SIZE} m · RES ${RES} · STEPS ${STEPS}\n`);

// THE ONE THAT MATTERS. Across the whole slider range, not just today's value:
// a look knob must not be able to destabilise the integrator.
const SLIDER_MAX = 0.9999;
let worst = 0, worstAt = 0;
for (const d of [0.99, 0.995, 0.999, 0.9992, 0.9995, SLIDER_MAX]) {
  const p = gridModePeak(WAVE_C, d);
  if (p > worst) { worst = p; worstAt = d; }
}
check("grid-scale mode stays bounded across the damping slider",
  worst < 4, `worst ${worst.toFixed(2)}x at damping ${worstAt}` +
  (worst >= 4 ? ` — WAVE_C ${WAVE_C} is too close to the CFL limit; 2.0 gives 49x` : ""));

check("today's damping is in the safe region",
  gridModePeak(WAVE_C, DAMPING) < 4,
  `${gridModePeak(WAVE_C, DAMPING).toFixed(2)}x at ${DAMPING}`);

// Waves must still travel at a physical speed — the whole reason the cell size
// was pinned at ~25 mm in the first place.
const cps = cellsPerStep(WAVE_C);
const mps = (SIZE / RES) * cps * STEPS * 60;
check("wave speed inside the physical 0.7-1.0 m/s band",
  mps >= 0.7 && mps <= 1.0, `${mps.toFixed(2)} m/s (${cps.toFixed(3)} cells/step)`);

// Ripples have to actually last, or the whole point of the damping value is lost.
const perSec = Math.pow(DAMPING, 60 * STEPS);
const at10s = Math.pow(perSec, 10);
check("a ripple is still visible after 10 s",
  at10s > 0.25, `${(at10s * 100).toFixed(0)}% of amplitude`);

console.log(failures
  ? `\n${failures} CHECK(S) FAILED`
  : "\nwater scheme: all checks passed");
process.exit(failures ? 1 : 0);
