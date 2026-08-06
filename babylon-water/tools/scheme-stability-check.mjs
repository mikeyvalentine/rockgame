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

const DAMPING = num(/RIPPLE\s*=\s*window\.RIPPLE\s*=\s*\{\s*damping:\s*([0-9.]+)/, "RIPPLE.damping");
const SIZE     = num(/const SPAN_BASE\s*=\s*([0-9.]+)/, "SPAN_BASE");
const SPAN_MAX = num(/const SPAN_MAX\s*=\s*([0-9.]+)/, "SPAN_MAX");
const STEPS    = num(/const STEPS\s*=\s*([0-9]+)/, "STEPS");
const WAVE_SPEED = num(/const WAVE_SPEED\s*=\s*([0-9.]+)/, "WAVE_SPEED");
/**
 * RES is a URL flag now, so there is no single value to check — every option
 * the page will accept has to hold up, because each one re-derives WAVE_C.
 * That is the whole reason WAVE_C stopped being a literal: a hand-typed
 * constant is correct for exactly one resolution.
 */
const RES_OPTIONS = (html.match(/\[512,\s*1024,\s*2048\]/) ? [512, 1024, 2048] : [1024]);
const RES_DEFAULT = num(/\?\s*q\s*:\s*(\d+);/, "default RES");
/** The page's own derivation, duplicated here on purpose — if the two drift,
 *  the wave-speed check below catches it. */
const waveCFor = (res, span = SIZE) =>
  2 * Math.pow(WAVE_SPEED / ((span / res) * STEPS * 60), 2);
const WAVE_C = waveCFor(RES_DEFAULT);

/**
 * The window is sized per throw now (placeRun), so the span is not one number
 * either — it runs from SPAN_BASE up to SPAN_MAX. WAVE_C rises as cells shrink,
 * so the NARROWEST window is the dangerous one, and SPAN_BASE is it.
 *
 * That is the check worth having: it is what says the page may only ever widen
 * the window, and it is the reason placeRun() does not shrink it for short
 * throws even though smaller cells would look better.
 */
const SPANS = [SIZE, (SIZE + SPAN_MAX) / 2, SPAN_MAX];

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

console.log(`\n  WAVE_SPEED ${WAVE_SPEED} m/s · damping ${DAMPING} · STEPS ${STEPS}`);
console.log(`  window span ${SIZE}-${SPAN_MAX} m (placeRun widens, never narrows)`);
console.log(`  RES options ${RES_OPTIONS.join(", ")} (default ${RES_DEFAULT})\n`);

// THE ONE THAT MATTERS. Across the whole slider range, not just today's value:
// a look knob must not be able to destabilise the integrator. And now across
// every RES the page will accept, because each picks a different WAVE_C.
const SLIDER_MAX = 0.9999;
for (const res of RES_OPTIONS) {
  for (const span of SPANS) {
    const C = waveCFor(res, span);
    let worst = 0, worstAt = 0;
    for (const d of [0.99, 0.995, 0.999, 0.9992, 0.9995, SLIDER_MAX]) {
      const p = gridModePeak(C, d);
      if (p > worst) { worst = p; worstAt = d; }
    }
    const at = `RES ${res} / ${span} m`;
    check(`${at}: grid-scale mode bounded across the damping slider`,
      worst < 4, `WAVE_C ${C.toFixed(4)}, worst ${worst.toFixed(2)}x at damping ${worstAt}` +
      (worst >= 4 ? ` — too close to the CFL limit; 2.0 gives 49x` : ""));

    // Waves must still travel at a physical speed. This is also what catches
    // the derivation drifting from the page's: the formula is small-C only, so
    // a span/RES pair that pushed WAVE_C toward the CFL limit would predict one
    // speed and measure another.
    const cps = cellsPerStep(C);
    const mps = (span / res) * cps * STEPS * 60;
    check(`${at}: wave speed inside the physical 0.7-1.0 m/s band`,
      mps >= 0.7 && mps <= 1.0, `${mps.toFixed(2)} m/s (${cps.toFixed(3)} cells/step)`);
  }
}

check("today's damping is in the safe region",
  gridModePeak(WAVE_C, DAMPING) < 4,
  `${gridModePeak(WAVE_C, DAMPING).toFixed(2)}x at ${DAMPING}`);

/**
 * Does ONE impact launch a TRAIN of rings, or a single ring?
 *
 * A real splash resolves into 3-5 visible concentric rings within the first
 * half-second, because water is dispersive and different wavelengths leave the
 * impact at different speeds. This scheme is dispersive too — short waves
 * travel slower on the grid than long ones — so the train is not something that
 * has to be drawn, it is what the integrator does with a crater.
 *
 * But only with a CRATER. Wallace's original drop is a smooth positive mound
 * with no structure to disperse, and a mound is what this page stamped until
 * the profile was replaced. If the crater-plus-rim shape were ever reverted the
 * water would go back to one ring per bounce and nothing else here would
 * notice, which is what this check is for.
 *
 * 1D slice through the middle of the domain, so the source is not pinned
 * against a boundary — with the crater at index 0 the update loop never touches
 * it, it acts as a driven wall, and nothing radiates at all.
 */
{
  const RIM = Number((html.match(/const RIM_NEUTRAL\s*=\s*([^;]+);/) || [])[1]
    ? eval(html.match(/const RIM_NEUTRAL\s*=\s*([^;]+);/)[1].replace("CRATER_KAPPA", "(0.5 - 2/(Math.PI*Math.PI))"))
    : NaN);
  const CELLS = num(/const MIN_DROP_CELLS\s*=\s*([0-9]+)/, "MIN_DROP_CELLS");
  const N = 1400, MID = 700;
  const h = new Float64Array(N), v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const u = Math.min(1, Math.abs(i - MID) / CELLS);
    const w = 0.5 - 0.5 * Math.cos((1 - u) * Math.PI);
    const ring = Math.sin(u * Math.PI);
    h[i] = -w + RIM * ring * ring;
  }
  const C = waveCFor(RES_DEFAULT);
  const lobesAfter = (frames) => {
    for (let s = 0; s < frames; s++) {
      const hp = h.slice();
      for (let i = 1; i < N - 1; i++) {
        const avg = (hp[i - 1] + hp[i + 1]) * 0.5;
        v[i] = DAMPING * (v[i] + (avg - hp[i]) * C);
        h[i] = hp[i] + v[i];
      }
    }
    const half = h.slice(MID);
    const pk = Math.max(...half.map(Math.abs));
    let n = 0, prev = 0;
    for (const x of half) {
      const s = Math.abs(x) > pk * 0.10 ? Math.sign(x) : 0;
      if (s !== 0 && s !== prev) n++;
      prev = s;
    }
    return n;
  };
  const quarter = lobesAfter(15);
  const half = lobesAfter(15);   // cumulative: 30 frames total
  check("one impact launches a ring TRAIN, not a single ring",
    quarter >= 3 && half > quarter,
    `${quarter} rings at 0.25 s, ${half} at 0.5 s` +
    (quarter < 3 ? " — a smooth mound disperses into one ring; is the crater profile still there?" : ""));
}

// Ripples have to actually last, or the whole point of the damping value is lost.
const perSec = Math.pow(DAMPING, 60 * STEPS);
const at10s = Math.pow(perSec, 10);
check("a ripple is still visible after 10 s",
  at10s > 0.25, `${(at10s * 100).toFixed(0)}% of amplitude`);

console.log(failures
  ? `\n${failures} CHECK(S) FAILED`
  : "\nwater scheme: all checks passed");
process.exit(failures ? 1 : 0);
