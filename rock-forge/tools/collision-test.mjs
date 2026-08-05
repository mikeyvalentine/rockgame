// How far is the collision surface from the surface you can see?
//
// The worry this answers: the rendered rock is displaced on the GPU, so is the
// physics shape actually the same object, or a stand-in that happens to look
// right? Two separate things can go wrong, and they are measured separately.
//
//   1. Scale agreement. The hull is re-sampled from the same analytic shape
//      function at a lower resolution. If that re-sampling re-derives its own
//      bounding-box normalisation it finds different extremes and comes out a
//      different size. This checks the hull and the rendered mesh agree exactly.
//
//   2. Hull error. A convex hull of N points on a star-shaped surface is not
//      the surface: it cuts corners between sample points and fills in every
//      concavity. That error is real and is reported here in millimetres at
//      pebble scale, per archetype, so it can be judged rather than assumed.
//
//   node tools/collision-test.mjs

import { bakeLibrary, buildHullPoints, buildDetailMesh } from "../src/forge/bake.js";
import { ARCHETYPES, ARCHETYPE_NAMES } from "../src/forge/archetypes.js";
import { buildIcosphere } from "../src/forge/icosphere.js";
import { meshVolume } from "../src/forge/metrics.js";
import { convexHull, hullRadius, hullVolume } from "./quickhull.mjs";

const SIZE = 0.07;        // 7 cm — a typical stone
const LOD0 = 3;           // the level the field actually renders up close
const SAMPLES = 24;       // rocks per archetype

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`  ok    ${name}${detail ? " — " + detail : ""}`);
};

const ico = buildIcosphere(LOD0);
const lvl = ico.levels[LOD0];
const NDIR = lvl.vertexCount;

/* -- 0. is the measuring instrument itself correct? ---------------------- */

console.log("\nconvex hull implementation");
{
  const cube = new Float32Array([
    -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
    -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
  ]);
  const h = convexHull(cube);
  check("cube volume", Math.abs(hullVolume(h) - 8) < 1e-9, hullVolume(h).toFixed(9));
  check("cube face distance", Math.abs(hullRadius(h, 1, 0, 0) - 1) < 1e-9);
  check("cube body diagonal", Math.abs(hullRadius(h, 0.5773503, 0.5773503, 0.5773503) - Math.sqrt(3)) < 1e-6);

  // A hull of points on a unit sphere is inscribed, so it must come in just
  // under the sphere and converge upward as the point count rises.
  const vols = [2, 3].map((l) => {
    const s = buildIcosphere(l);
    const n = s.levels[l].vertexCount;
    return hullVolume(convexHull(s.dirs.subarray(0, n * 3)));
  });
  const sphere = (4 / 3) * Math.PI;
  check("sphere hull is inscribed and converges",
    vols[0] < vols[1] && vols[1] < sphere && vols[1] / sphere > 0.98,
    `${(vols[0] / sphere * 100).toFixed(1)}% -> ${(vols[1] / sphere * 100).toFixed(1)}% of a sphere`);
}

/** Exact radial distance to the hull of `pts` along every direction in `dirs`. */
function hullRadii(pts, dirs, n) {
  const h = convexHull(pts);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = hullRadius(h, dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
  }
  out.volume = hullVolume(h);
  out.faces = h.faces.length;
  return out;
}

/* -- 1. does the hull agree with the rendered mesh about scale? ---------- */

console.log("\nscale agreement (hull and detail mesh vs the baked, rendered shape)");
{
  const lib = bakeLibrary({ count: 24, seed: 3, lod0Level: LOD0 });
  let worstDetail = 0, worstBox = 0, worstUnder = 0, worstAbsMm = 0;

  for (const shape of lib.shapes) {
    const params = ARCHETYPES[shape.archetype];

    // The detail mesh uses plain icosphere directions, so level 2's 162
    // vertices are a prefix shared with the baked LOD0 and compare directly.
    const detail = buildDetailMesh(shape, params, 5, SIZE);
    for (let i = 0; i < 162; i++) {
      const r = Math.hypot(detail.positions[i * 3], detail.positions[i * 3 + 1], detail.positions[i * 3 + 2]);
      worstDetail = Math.max(worstDetail, Math.abs(r - shape.radii[i] * SIZE));
    }

    // The hull's directions are warped, so compare what actually matters: does
    // the collision shape come out the same *size* as the drawn one. Built at
    // the shipped default level, since that is the thing whose behaviour needs
    // guaranteeing.
    const hull = buildHullPoints(shape, params, SIZE);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < hull.length / 3; i++) {
      for (let c = 0; c < 3; c++) {
        const v = hull[i * 3 + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    for (let c = 0; c < 3; c++) {
      const drawn = shape.unitSpan[c] * SIZE;
      const err = (max[c] - min[c]) / drawn - 1;
      worstBox = Math.max(worstBox, err);
      worstUnder = Math.max(worstUnder, -err);
      worstAbsMm = Math.max(worstAbsMm, Math.abs((max[c] - min[c]) - drawn) * 1000);
    }
  }

  check("hand-held detail mesh matches the field rock",
    worstDetail < 1e-6, `worst ${(worstDetail * 1000).toFixed(6)} mm`);

  // Direction matters, and the original version of this check ignored it.
  //
  // A hull *smaller* than the drawn rock is the bad case: stones visibly sink
  // into each other. A hull slightly larger is benign — it is the hull sampling
  // more densely than the render and finding extremes the 642-vertex mesh
  // misses. Measured over 48 stones, undershoot never occurs at all, and the
  // overshoot is worst on the thin axis, where a few percent is a few tenths of
  // a millimetre. Testing the *signed* error rather than its magnitude is what
  // separates that from the systematic normalisation bug this was written to
  // catch, which scaled the whole hull and would show up here as undershoot.
  check("physics hull is never smaller than the drawn rock",
    worstUnder < 1e-6, `worst undershoot ${(worstUnder * 100).toFixed(2)}%`);
  // 1.5 mm, from measurement rather than aspiration: the observed worst is
  // 1.04 mm, and it sits well inside the hull's own inherent 2-4 mm error, so a
  // tighter bound here would be guarding a rounding detail while the real
  // approximation is an order of magnitude larger. The guarantee that matters
  // is the one above, and it holds exactly.
  check("hull overshoot under 1.5 mm",
    worstAbsMm < 1.5, `worst ${worstAbsMm.toFixed(2)} mm (${(worstBox * 100).toFixed(2)}%, thin axis)`);
}

/* -- 2. how much does convexification cost? ------------------------------ */

console.log(`\nhull vs rendered surface, ${(SIZE * 100).toFixed(0)} cm stones, ${SAMPLES} per family`);
console.log("  family      hull pts   faces   mean dev   max out   max in   volume");

const summary = {};
for (const name of ARCHETYPE_NAMES) {
  const lib = bakeLibrary({ count: SAMPLES, seed: 17, lod0Level: LOD0, only: name });
  const params = ARCHETYPES[name];
  // Radii are stored per vertex *index*, and each archetype is baked against
  // its own axis-warped direction set — so index i only means the same point on
  // the surface if the same directions are used to read it back.
  const dirs = lib.dirsByArchetype[name];

  for (const hullLevel of [2, 3]) {
    let meanAcc = 0, maxOut = 0, maxIn = 0, volAcc = 0, faceAcc = 0, n = 0;

    for (const shape of lib.shapes) {
      const pts = buildHullPoints(shape, params, SIZE, hullLevel);
      const hr = hullRadii(pts, dirs, NDIR);

      const scaled = new Float32Array(NDIR);
      for (let i = 0; i < NDIR; i++) scaled[i] = shape.radii[i] * SIZE;

      let acc = 0;
      for (let i = 0; i < NDIR; i++) {
        const d = hr[i] - scaled[i];      // positive = hull outside the visible rock
        acc += Math.abs(d);
        if (d > maxOut) maxOut = d;
        if (-d > maxIn) maxIn = -d;
      }
      meanAcc += acc / NDIR;
      volAcc += hr.volume / meshVolume(dirs, scaled, lvl.indices);
      faceAcc += hr.faces;
      n++;
    }

    const row = {
      pts: buildHullPoints(lib.shapes[0], params, SIZE, hullLevel).length / 3,
      faces: faceAcc / n,
      mean: (meanAcc / n) * 1000,
      out: maxOut * 1000,
      in: maxIn * 1000,
      vol: (volAcc / n - 1) * 100,
    };
    (summary[hullLevel] ||= {})[name] = row;
    console.log(
      `  ${name.padEnd(10)}  ${String(row.pts).padStart(7)}  ${row.faces.toFixed(0).padStart(5)}   ` +
      `${row.mean.toFixed(2).padStart(6)} mm  ${row.out.toFixed(2).padStart(6)} mm  ` +
      `${row.in.toFixed(2).padStart(5)} mm  ${(row.vol >= 0 ? "+" : "") + row.vol.toFixed(1)}%`
    );
  }
}

console.log("\n  (max in > 0 means the hull is *inside* the drawn surface somewhere:");
console.log("   sample points are on the surface, so this is the chord cutting a convex bulge.)");

/* -- 3. is it good enough? ----------------------------------------------- */

console.log("\nverdict");
{
  // The thresholds below are set against what each kind of error actually does
  // in the game, not against a round number.
  //
  // The reassuring structural fact first: a convex hull's *vertices* are sample
  // points, and every sample point sits exactly on the drawn surface. Contact
  // between two stones happens at whichever point is extreme along the contact
  // normal — which is a hull vertex. So the places where stones actually touch
  // are the places where the hull is exact, and the error lives in the spans
  // between vertices, which are by construction not the first thing to touch.
  const L = summary[3];   // the shipped default

  // Conchoidally fractured stones are excluded from the bounds and reported
  // instead. A single convex hull cannot represent a scooped flake — the whole
  // point of a conchoidal fracture is a concave shell — so holding obsidian and
  // flint to a convexity bound would be asking the geometry not to be what it
  // is. They collide as their convex envelope, which for a small treasure the
  // player picks up is an acceptable trade; a proper fix is convex
  // decomposition, not a tighter number here.
  const scooped = ARCHETYPE_NAMES.filter((n) => ARCHETYPES[n].scoops);
  for (const n of scooped) {
    if (L[n]) console.log(`  note  ${n}: conchoidal, hull fills its scoops — ` +
      `${L[n].out.toFixed(1)} mm outward, volume ${L[n].vol >= 0 ? "+" : ""}${L[n].vol.toFixed(1)}%`);
  }
  const vals = (k) => Object.entries(L).filter(([n]) => !scooped.includes(n)).map(([, r]) => r[k]);

  // Outward error is the one you can see: it holds a stone off its neighbour.
  // It rose from 0.9 mm to ~4.7 mm when lobes were added to the shape model,
  // and unlike every other figure here it does not fall with sample density —
  // it is the hull bridging the concave saddle where a lobe meets the body, not
  // a sampling artefact. Deliberately traded for shapes that are not ellipsoids.
  check("worst outward error under 5 mm on a 7 cm stone",
    Math.max(...vals("out")) < 5, `${Math.max(...vals("out")).toFixed(2)} mm`);

  // Inward error lets stones interpenetrate slightly. Less visible, and the
  // solver pushes them apart anyway.
  check("worst inward error under 5 mm",
    Math.max(...vals("in")) < 5, `${Math.max(...vals("in")).toFixed(2)} mm`);

  // Typical, rather than worst, is what decides whether a whole bed sits right.
  check("mean deviation under 0.8 mm",
    Math.max(...vals("mean")) < 0.8, `${Math.max(...vals("mean")).toFixed(2)} mm`);

  // Volume gap is convexification filling the dished faces of the flat stones.
  // It does not affect displayed mass or the skip rating, both of which are
  // computed from the drawn mesh in instanceMetrics(), never from the hull.
  check("hull volume within 15% of the drawn volume",
    Math.max(...vals("vol").map(Math.abs)) < 15,
    `${Math.max(...vals("vol").map(Math.abs)).toFixed(1)}% (slate's dished faces)`);

  // Guards the sampler itself: if a future change breaks the rim weighting,
  // throwing points at the problem will stop helping and this will catch it.
  const better = ARCHETYPE_NAMES.every((n) => summary[3][n].in < summary[2][n].in);
  check("error converges as sample density rises", better,
    `worst in: ${Math.max(...vals("in")).toFixed(2)} mm -> ` +
    `${Math.max(...Object.values(summary[3]).map((r) => r.in)).toFixed(2)} mm`);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
