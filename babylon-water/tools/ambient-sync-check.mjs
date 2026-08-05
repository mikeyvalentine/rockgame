// Does ambient.js still agree with AMBIENT_GLSL in index.html?
//
// The CPU twin exists so the skip solver planes on the surface the player
// sees; the moment the two drift, the stone skips on water that is not there.
// This parses the GLSL octave table straight out of index.html and compares
// it against the exported OCTAVES, then sanity-checks the sampler itself:
// the analytic slope must match a numeric derivative of the height, the
// normal must be unit length, and the field must be deterministic in t.
//
//   node babylon-water/tools/ambient-sync-check.mjs   (part of `npm test`)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OCTAVES, sampleAmbient } from "../ambient.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- GLSL parse
const html = readFileSync(
  fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

// L0 = 0.90 * S, L1 = 0.55 * S, ...
const lDefs = [...html.matchAll(/L([0-3]) = ([\d.]+) \* S/g)]
  .map((m) => [Number(m[1]), Number(m[2])]);
check("four wavelength defs found in AMBIENT_GLSL", lDefs.length === 4, `${lDefs.length}`);
for (const [i, L] of lDefs) {
  check(`GLSL L${i} matches OCTAVES[${i}]`, OCTAVES[i][0] === L,
    `${L} vs ${OCTAVES[i][0]}`);
}

// ambientWave(wp, rot * normalize(vec2(1.00,  0.15)), L0, 0.0045 * A * S * ...
const waveCalls = [...html.matchAll(
  /ambientWave\(wp, rot \* normalize\(vec2\((-?[\d.]+),\s*(-?[\d.]+)\)\), L([0-3]), ([\d.]+) \* A \* S/g)];
check("four ambientWave calls found", waveCalls.length === 4, `${waveCalls.length}`);
for (const m of waveCalls) {
  const [, dx, dy, li, amp] = m;
  const i = Number(li);
  check(`GLSL octave ${i} amplitude matches`, Number(amp) === OCTAVES[i][1],
    `${amp} vs ${OCTAVES[i][1]}`);
  check(`GLSL octave ${i} direction matches`,
    Number(dx) === OCTAVES[i][2][0] && Number(dy) === OCTAVES[i][2][1],
    `(${dx},${dy}) vs (${OCTAVES[i][2]})`);
}

// dispersion + phase forms present and unchanged
check("dispersion term intact", html.includes("sqrt(9.81 * L / 6.2831853)"));
check("phase form intact", html.includes("k * dot(dir, wp) - k * c * t"));

// ------------------------------------------------------------ sampler sanity
const W = { windStrength: 0.7, windDirDeg: 40, waveScale: 4 };

// analytic slope vs numeric derivative of height
const EPS = 1e-4;
let worst = 0;
for (const [x, z, t] of [[0, 0, 0], [3.7, -1.2, 5.5], [-80, 55, 123.4], [40.01, 40.02, 999]]) {
  const s = sampleAmbient(x, z, t, W);
  const nx = (sampleAmbient(x + EPS, z, t, W).height - sampleAmbient(x - EPS, z, t, W).height) / (2 * EPS);
  const nz = (sampleAmbient(x, z + EPS, t, W).height - sampleAmbient(x, z - EPS, t, W).height) / (2 * EPS);
  worst = Math.max(worst, Math.abs(nx - s.slope.x), Math.abs(nz - s.slope.z));
}
check("slope = d(height)/d(x,z) to 1e-5", worst < 1e-5, `worst ${worst.toExponential(1)}`);

// normal unit length, y up
const n = sampleAmbient(12.3, -4.5, 77, W).normal;
const len = Math.hypot(n.x, n.y, n.z);
check("normal is unit length", Math.abs(len - 1) < 1e-9, `${len}`);
check("normal points up", n.y > 0.9);

// height bounded by total amplitude
const maxAmp = OCTAVES.reduce((a, o) => a + o[1], 0) * W.windStrength * W.waveScale;
let maxSeen = 0;
for (let i = 0; i < 4000; i++) {
  const h = Math.abs(sampleAmbient(i * 1.37, i * -0.91, i * 0.113, W).height);
  if (h > maxSeen) maxSeen = h;
}
check("height bounded by summed amplitudes", maxSeen <= maxAmp + 1e-9,
  `${maxSeen.toFixed(4)} <= ${maxAmp.toFixed(4)}`);

// deterministic
const a = sampleAmbient(5, 5, 42, W).height, b = sampleAmbient(5, 5, 42, W).height;
check("deterministic in (x,z,t)", a === b);

// flat when wind is zero-strength
check("windStrength 0 is glass",
  sampleAmbient(9, 9, 9, { ...W, windStrength: 0 }).height === 0);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nambient twin: all checks passed");
process.exit(failures ? 1 : 0);
