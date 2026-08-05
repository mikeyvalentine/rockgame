// Headless checks on the forge core. Nothing here touches Babylon, so a broken
// shape function is caught in a second instead of showing up as a black screen.
//
//   node tools/shape-test.mjs

import { bakeLibrary, instanceMetrics, buildDetailMesh, buildHullPoints, toHalf } from "../src/forge/bake.js";
import { ARCHETYPES, ARCHETYPE_NAMES, ROCK_NAMES } from "../src/forge/archetypes.js";
import { buildIcosphere, computeRadialNormals } from "../src/forge/icosphere.js";
import { makeShape, sampleShape } from "../src/forge/shape.js";
import { meshVolume, meshSpan } from "../src/forge/metrics.js";

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`  ok    ${name}${detail ? " — " + detail : ""}`);
}
const fmtKB = (b) => `${(b / 1024).toFixed(1)} KB`;

/* -- icosphere ---------------------------------------------------------- */
console.log("\nicosphere");
{
  const ico = buildIcosphere(5);
  const expectV = [12, 42, 162, 642, 2562, 10242];
  const expectT = [20, 80, 320, 1280, 5120, 20480];
  let vOk = true, tOk = true, prefixOk = true;
  for (let l = 0; l <= 5; l++) {
    if (ico.levels[l].vertexCount !== expectV[l]) vOk = false;
    if (ico.levels[l].indices.length / 3 !== expectT[l]) tOk = false;
    // Every index at level l must address a vertex below level l's count —
    // that is the prefix property the shared shape texture depends on.
    for (const i of ico.levels[l].indices) if (i >= ico.levels[l].vertexCount) prefixOk = false;
  }
  check("vertex counts", vOk);
  check("triangle counts", tOk);
  check("levels are vertex prefixes of each other", prefixOk);

  let unit = true;
  for (let i = 0; i < ico.levels[5].vertexCount; i++) {
    const l = Math.hypot(ico.dirs[i * 3], ico.dirs[i * 3 + 1], ico.dirs[i * 3 + 2]);
    if (Math.abs(l - 1) > 1e-5) unit = false;
  }
  check("directions are unit length", unit);

  // Closed surface: every edge shared by exactly two triangles.
  const idx = ico.levels[3].indices;
  const edges = new Map();
  for (let f = 0; f < idx.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[f + e], b = idx[f + ((e + 1) % 3)];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  check("level 3 is watertight", [...edges.values()].every((v) => v === 2),
    `${edges.size} edges`);
}

/* -- shape function ------------------------------------------------------ */
console.log("\nshape model");
{
  const ico = buildIcosphere(3);
  const lvl = ico.levels[3];
  const sphereVol = (4 / 3) * Math.PI * 0.5 ** 3;

  for (const name of ARCHETYPE_NAMES) {
    const a = ARCHETYPES[name];
    let bad = 0, minR = Infinity, volSum = 0, flatSum = 0;
    const N = 24;
    for (let s = 0; s < N; s++) {
      const sh = makeShape(a, 1000 + s * 977);
      const { radii } = sampleShape(sh, ico.dirs, lvl.vertexCount, 1);
      for (let i = 0; i < lvl.vertexCount; i++) {
        if (!Number.isFinite(radii[i]) || radii[i] <= 0) bad++;
        if (radii[i] < minR) minR = radii[i];
      }
      const span = meshSpan(ico.dirs, radii, lvl.vertexCount);
      if (Math.abs(Math.max(...span) - 1) > 1e-4) bad++;
      volSum += meshVolume(ico.dirs, radii, lvl.indices);
      flatSum += Math.min(...span) / Math.max(...span);
    }
    const vol = volSum / N;
    check(`${name}`, bad === 0 && vol > 0.005 && vol < sphereVol,
      `vol ${vol.toFixed(4)} (sphere ${sphereVol.toFixed(4)}), flatness ${(flatSum / N).toFixed(2)}, min r ${minR.toFixed(3)}`);
  }
}

/* -- resolution independence -------------------------------------------- */
console.log("\nresolution independence");
{
  // The rock in your hand is rebuilt at level 5 from the same seed as the
  // level-3 instance in the field. If those two disagree, the stone visibly
  // changes shape as you pick it up.
  const a = ARCHETYPES.granite;
  const sh = makeShape(a, 4242);
  const lo = buildIcosphere(2), hi = buildIcosphere(5);

  // Every re-sampling in the real code path reuses the scale the shape was
  // baked with — that is what `unitScale` is for. Sampling each level with its
  // own bounding-box normalisation instead is the bug that fix exists to
  // prevent, so testing it that way would be testing nothing the code does.
  const baked = sampleShape(sh, buildIcosphere(3).dirs, buildIcosphere(3).levels[3].vertexCount, 1);
  const rLo = sampleShape(sh, lo.dirs, lo.levels[2].vertexCount, 1, baked.scale);
  const rHi = sampleShape(sh, hi.dirs, hi.levels[5].vertexCount, 1, baked.scale);

  // Level 2's vertices are a prefix of level 5's, so compare them directly.
  // With a shared scale these are the same numbers, not merely close.
  let maxDelta = 0;
  for (let i = 0; i < lo.levels[2].vertexCount; i++) {
    maxDelta = Math.max(maxDelta, Math.abs(rLo.radii[i] - rHi.radii[i]));
  }
  check("level 2 vs level 5 radii are identical", maxDelta < 1e-6,
    `max delta ${maxDelta.toExponential(2)}`);

  // Volume still differs: a coarse polyhedron inscribed in a curved surface
  // under-estimates it, and must approach the fine one from below.
  const vLo = meshVolume(lo.dirs, rLo.radii, lo.levels[2].indices);
  const vHi = meshVolume(hi.dirs, rHi.radii, hi.levels[5].indices);
  check("coarse volume converges from below", vLo < vHi && (vHi - vLo) / vHi < 0.12,
    `${vLo.toFixed(4)} vs ${vHi.toFixed(4)} (${((vLo / vHi - 1) * 100).toFixed(1)}%)`);
}

/* -- rim smoothness ------------------------------------------------------ */

console.log("\nrim smoothness (the sawtooth regression)");
{
  // A vertex whose radius differs sharply from the average of its neighbours is
  // a spike, and a rim of them is the sawtooth edge that isotropic tessellation
  // produced on flat stones. The surface underneath is smooth — this is purely
  // whether the tessellation can describe it.
  //
  // Before the axis-ratio warp: 75% of slate's rim vertices deviated by more
  // than a millimetre on a 7 cm stone, the worst by 12 mm.
  // Sampled per family. A single mixed bake of 16 shapes gave roughly one stone
  // per family once there were fifteen of them, which measured noise rather
  // than tessellation.
  const SIZE = 0.07;
  const lvl = bakeLibrary({ count: 1, seed: 1, lod0Level: 3 }).ico.levels[3];
  const N = lvl.vertexCount;

  const adj = Array.from({ length: N }, () => new Set());
  for (let f = 0; f < lvl.indices.length; f += 3) {
    const [a, b, c] = [lvl.indices[f], lvl.indices[f + 1], lvl.indices[f + 2]];
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }

  // A stone the model deliberately leaves angular has real edges, and a real
  // edge is a legitimate jump in radius between neighbouring vertices. Only the
  // families meant to be smooth can be held to a smoothness bound; the rest are
  // measured and reported, because a change there is still worth seeing.
  const SMOOTH = 0.5;   // wear at or above which a family should have no edges
  let worstPct = 0, worstP99 = 0, worstMax = 0;

  for (const name of ARCHETYPE_NAMES) {
    const lib = bakeLibrary({ count: 12, seed: 17, lod0Level: 3, only: name });
    const dirs = lib.dirsByArchetype[name];
    const devs = [];
    for (const s of lib.shapes) {
      for (let i = 0; i < N; i++) {
        if (Math.abs(dirs[i * 3 + 1]) > 0.35) continue;   // rim band
        let sum = 0;
        for (const j of adj[i]) sum += s.radii[j];
        devs.push(Math.abs(s.radii[i] - sum / adj[i].size) * SIZE * 1000);
      }
    }
    devs.sort((a, b) => a - b);
    const pct = (100 * devs.filter((d) => d > 1).length) / devs.length;
    // The 99th percentile, not the maximum. Over ~7,700 rim vertices a single
    // extreme one says nothing about whether the surface reads as smooth, and
    // gating on it means the bound moves every time the sampling changes — which
    // is exactly what happened when this went from one stone per family to
    // twelve and the "worst" doubled without any geometry changing.
    const p99 = devs[Math.floor(devs.length * 0.99)];
    const max = devs[devs.length - 1];
    const smooth = (ARCHETYPES[name].wear ?? 1) >= SMOOTH;
    if (smooth) {
      worstPct = Math.max(worstPct, pct);
      worstP99 = Math.max(worstP99, p99);
      worstMax = Math.max(worstMax, max);
    }
    console.log(`  ${name.padEnd(10)} ${pct.toFixed(1).padStart(5)}% spike, p99 ${p99.toFixed(2)} mm, max ${max.toFixed(2).padStart(5)} mm` +
      (smooth ? "" : `   (angular by design, wear ${ARCHETYPES[name].wear})`));
  }
  check("under 15% of rim vertices spike, on families meant to be smooth",
    worstPct < 15, `worst ${worstPct.toFixed(1)}%`);
  check("99th-percentile rim spike under 2.5 mm, on families meant to be smooth",
    worstP99 < 2.5, `p99 ${worstP99.toFixed(2)} mm (single worst vertex ${worstMax.toFixed(2)} mm)`);
}

/* -- normals ------------------------------------------------------------- */
console.log("\nnormals");
{
  const ico = buildIcosphere(3);
  const lvl = ico.levels[3];
  const sh = makeShape(ARCHETYPES.flint, 909);
  const { radii } = sampleShape(sh, ico.dirs, lvl.vertexCount, 1);
  const n = computeRadialNormals(ico.dirs, radii, lvl.indices, lvl.vertexCount);
  let unit = true, outward = 0;
  for (let i = 0; i < lvl.vertexCount; i++) {
    const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
    if (Math.abs(l - 1) > 1e-4) unit = false;
    const d = n[i * 3] * ico.dirs[i * 3] + n[i * 3 + 1] * ico.dirs[i * 3 + 1] + n[i * 3 + 2] * ico.dirs[i * 3 + 2];
    if (d > 0) outward++;
  }
  check("normals are unit length", unit);
  // A star-shaped surface's normal always has a positive component along its
  // own direction. If most do not, the winding is inside out.
  check("normals face outward", outward / lvl.vertexCount > 0.97,
    `${((outward / lvl.vertexCount) * 100).toFixed(1)}% outward`);
}

/* -- half float ---------------------------------------------------------- */
console.log("\nhalf-float encoding");
{
  const dec = (h) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
  };
  let worst = 0;
  for (const v of [0, 1, -1, 0.5, 0.0125, 0.9987, -0.3333, 2.5, 0.001]) {
    worst = Math.max(worst, Math.abs(dec(toHalf(v)) - v) / Math.max(1e-3, Math.abs(v)));
  }
  check("relative error under 0.1%", worst < 1e-3, `worst ${(worst * 100).toFixed(4)}%`);
}

/* -- library bake -------------------------------------------------------- */
console.log("\nlibrary");
{
  const lib = bakeLibrary({ count: 96, seed: 7, lod0Level: 3 });
  check("shape count", lib.shapes.length === 96);
  check("texture sized to LOD0 vertices", lib.texel.length === 642 * 96 * 4);
  check("no NaN in texture", lib.texel.every((v) => (v & 0x7c00) !== 0x7c00 || (v & 0x3ff) === 0));

  const fam = {};
  for (const s of lib.shapes) fam[s.archetype] = (fam[s.archetype] || 0) + 1;
  // Treasures are deliberately rare — opal is under a fifth of a percent — so a
  // 96-shape library is not expected to contain one of each. Requiring that was
  // requiring rarity not to work.
  check("every rock family represented", ROCK_NAMES.every((n) => fam[n] > 0),
    ROCK_NAMES.map((n) => `${n} ${fam[n] || 0}`).join(", "));

  const big = bakeLibrary({ count: 3000, seed: 5, lod0Level: 3 });
  const seen = new Set(big.shapes.map((s) => s.archetype));
  const treasures = ARCHETYPE_NAMES.filter((n) => ARCHETYPES[n].treasure);
  check("every treasure eventually appears", treasures.every((n) => seen.has(n)),
    `${treasures.filter((n) => seen.has(n)).length}/${treasures.length} in 3000 shapes`);
  const rate = big.shapes.filter((s) => ARCHETYPES[s.archetype].treasure).length / big.shapes.length;
  check("treasure rate is rare but findable", rate > 0.01 && rate < 0.12,
    `${(rate * 100).toFixed(1)}% — about 1 in ${Math.round(1 / rate)}`);

  // Distinctness: two shapes should not be near-duplicates.
  let minRms = Infinity;
  for (let i = 0; i < 24; i++) {
    for (let j = i + 1; j < 24; j++) {
      let acc = 0;
      for (let k = 0; k < 642; k++) acc += (lib.shapes[i].radii[k] - lib.shapes[j].radii[k]) ** 2;
      minRms = Math.min(minRms, Math.sqrt(acc / 642));
    }
  }
  check("shapes are distinct", minRms > 0.01, `closest pair rms ${minRms.toFixed(4)}`);

  console.log(`\n  bake              ${lib.stats.bakeMs.toFixed(0)} ms for 96 shapes`);
  console.log(`  shape texture     ${fmtKB(lib.stats.shapeTextureBytes)} (${(lib.stats.bytesPerShape / 1024).toFixed(2)} KB/shape)`);
  console.log(`  shared base mesh  ${fmtKB(lib.stats.baseVertexBytes + lib.stats.indexBytes)} (all LODs)`);

  // What the same 96 shapes would cost as ordinary meshes: 1280 tris, indexed,
  // position + normal + uv at float32, plus a uint16 index buffer.
  const perMesh = 642 * (3 + 3 + 2) * 4 + 1280 * 3 * 2;
  const naive = perMesh * 96;
  const forge = lib.stats.shapeTextureBytes + lib.stats.baseVertexBytes + lib.stats.indexBytes;
  console.log(`  as plain meshes   ${fmtKB(naive)}  ->  forge ${fmtKB(forge)}  (${(naive / forge).toFixed(1)}x smaller)`);

  const m = instanceMetrics(lib.shapes[0], 0.07);
  check("instance metrics sane", m.massGrams > 5 && m.massGrams < 3000 && m.rating.score >= 0 && m.rating.score <= 1,
    `${lib.shapes[0].archetype} 7 cm -> ${m.massGrams.toFixed(0)} g, ${m.rating.stars}*`);

  const detail = buildDetailMesh(lib.shapes[0], ARCHETYPES[lib.shapes[0].archetype], 5, 0.07);
  check("detail mesh builds", detail.vertexCount === 10242 && detail.positions.every(Number.isFinite));

  const hull = buildHullPoints(lib.shapes[0], ARCHETYPES[lib.shapes[0].archetype], 0.07);
  // Fidelity against the rendered surface is tools/collision-test.mjs's job;
  // here we only care that the point cloud is well formed.
  check("hull points build", hull.length === (42 + 642 + 6) * 3 && hull.every(Number.isFinite));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
