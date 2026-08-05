// rock-forge — the lab.
//
// Two modes:
//   field    a whole shingle bank, to prove the thing scales and to find where
//            it stops scaling on your hardware;
//   inspect  one stone, big, with a LOD selector, a wireframe toggle and an
//            optional 20,480-triangle reference sitting next to it — because
//            the only honest test of "is the low-poly one good enough" is
//            looking at both at once.

import {
  Color3, Mesh, PBRMaterial, Quaternion, SceneInstrumentation, Vector3, VertexData,
} from "@babylonjs/core";

import { bakeLibrary, buildDetailMesh, instanceMetrics } from "./forge/bake.js";
import { ARCHETYPES, ARCHETYPE_NAMES } from "./forge/archetypes.js";
import { mulberry32, hash32, lerp } from "./forge/rng.js";
import { packDisc } from "./forge/scatter.js";
import { drawSize, sizeReport } from "./forge/sizes.js";
import {
  createShapeTexture, createRockMaterials,
  ROCK_RAW_SPECULAR, ROCK_POLISHED_SPECULAR, ROCK_POLISHED_ROUGHNESS,
} from "./babylon/rockMaterial.js";
import { makeGrainTexture, makeVariationTexture } from "./babylon/detailTextures.js";
import { loadRockTextures } from "./babylon/rockTextures.js";
import { RockField } from "./babylon/rockField.js";
import { createEngine, createScene, createGround, createShadows } from "./babylon/scene.js";
import { createScribble } from "./babylon/scribbleEnv.js";
import { loadScribbleSettings, watchAndSave } from "../../shared/scribble-dials.js";
import { panel, hud, showError } from "./lab/ui.js";

const state = {
  mode: "field",
  libCount: 96,
  rockCount: 2000,
  seed: 7,
  family: "mixed",
  lod: -1,
  lodStep0: 16,
  lodStep1: 48,
  lodDebug: false,
  wireframe: false,
  shadows: true,
  tumbled: false,
  grain: 1.0,
  reference: false,
  inspectSeed: 0,
  bypass: false,
  packing: 0.55,        // fraction of ground the stones' footprints cover
  medianMm: 55,         // median clast diameter
  sorting: 0.85,        // standard deviation in phi units — see forge/sizes.js
  photo: true,          // real photographed surfaces vs the procedural grain
  dispMm: 1.2,          // vertex displacement amplitude, millimetres
  adders: 1.0,          // veins / mottling / spots / bedding bands
  polish: -1,           // -1 = each treasure's natural state; 0 = raw, 1 = tumbled
  envWarmth: 28,        // [Look] warmth — the water sim's own live tuning
  envExposure: 1.0,     // [Look] exposure
  // [Pastel pass], the water sim's live tuning handed over directly — every
  // default below is the exact value from that dump, not an approximation.
  // On by default because the dump says so (pastel on = 1.00): this is the
  // game's look, shared with the water sim, not a lab affectation. The dump's
  // `outline width` and `edge depth` entries have no counterpart here any
  // more: depth-edge outlines were removed from the shader itself, at the
  // user's request, after they inked each rock's undisplaced sphere silhouette
  // as a halo floating outside the visible stone. The depth pre-pass survives
  // only to mask the sky back to photography.
  // Re-tuned 2026-08-04: the user dialled a universal look on the shared
  // panel and set it as every lab's default (superseding the dump values the
  // comments above describe). Keep in step with shared/scribble-dials.js.
  scribble: true,
  scribbleLevels: 50,         // value steps
  scribbleSat: 1.02,          // saturation
  scribbleStrokeAmount: 0.02, // stroke amount
  scribbleStrokeFreq: 10,     // stroke density
  scribbleStrokeAngle: 0.5,   // stroke angle
  scribbleIgnoreSky: true,    // ignore sky
  scribblePaperScale: 37.25,  // paper scale
  scribbleGrain: 0.14,        // paper grain
  scribbleBleed: 0.0,         // colour bleed
  scribbleWarp: 0.0,          // paper warp
};

let engine, scene, camera, sun, ground, instrumentation, envSetup, scribbleFx;
let lib = null, shapeTex = null, grainTex = null, varTex = null, materials = null, field = null, shadows = null;
let shadowsRefresh = null; // AUDIT #B6 — shadow map is render-once; call after field rebuilds
let textures = null;   // { perArchetype, height, bytes, notes } from loadRockTextures
let referenceMesh = null, referenceMat = null;
let bench = null;

const H = hud(document.getElementById("hud"));

/* ---------------------------------------------------------------- library */

function rebuildLibrary() {
  field?.dispose();
  if (materials) for (const m of Object.values(materials)) m.dispose();
  shapeTex?.dispose();

  lib = bakeLibrary({
    count: state.libCount,
    seed: state.seed,
    lod0Level: 3,
    only: state.family === "mixed" ? null : state.family,
  });

  // Prove the baked data is non-empty before blaming the GPU for empty output.
  let rMin = Infinity, rMax = -Infinity;
  for (const s of lib.shapes) for (const r of s.radii) { if (r < rMin) rMin = r; if (r > rMax) rMax = r; }
  H.set("baked radius", `${rMin.toFixed(3)} – ${rMax.toFixed(3)}`);

  shapeTex = createShapeTexture(scene, lib);
  materials = createRockMaterials(scene, lib, {
    shapeTex, grainTex, grainStrength: state.grain,
    bypassShapeTexture: state.bypass,
    surfaces: state.photo ? textures?.perArchetype : null,
    heightTex: state.photo ? textures?.height : null,
    heightAspect: textures?.heightAspect ?? 1,
    heightWidth: textures?.heightWidth ?? 1024,
    dispMetres: state.dispMm / 1000,
    varTex,
    adders: state.adders,
    polish: state.polish < 0 ? null : state.polish,
  });
  for (const m of Object.values(materials)) m.wireframe = state.wireframe;

  field = new RockField(scene, lib, materials, {
    lodLevels: [3, 2, 1],
    lodSteps: [state.lodStep0, state.lodStep1],
  });
  field.lodDebug = state.lodDebug;
  field.forcedLod = state.lod;

  if (state.shadows) applyShadows();
  rebuildInstances();
}

function applyShadows() {
  shadows?.dispose();
  const r = createShadows(scene, sun, materials);
  shadows = r.generator;
  shadowsRefresh = r.refresh;
  for (const group of field.groups.values()) {
    for (const b of group.buckets) shadows.addShadowCaster(b.mesh, false);
  }
  ground.receiveShadows = true;
  if (r.failures.length) {
    console.warn("shadow depth wrapper failed:", r.failures);
    H.set("shadows", "failed — see console");
  }
}

/* -------------------------------------------------------------- instances */

/**
 * Per-instance albedo multiplier.
 *
 * In procedural mode the tint *is* the rock's colour, multiplied onto a white
 * albedo. In photo mode the photograph already carries the colour, so the tint
 * is renormalised to average 1: it keeps the archetype's hue bias and the
 * per-stone brightness variation without darkening every rock a second time by
 * an albedo the texture has already applied.
 */
function tintFor(shape, jitter) {
  const c = shape.colour;
  // A treasure has no photograph behind it — its colour comes from the gem ramp
  // multiplied by this tint — so normalising to average 1 would wash it out.
  if (ARCHETYPES[shape.archetype]?.gem) {
    return c.map((v) => Math.min(1.4, v * (0.9 + (jitter - 1) * 0.5)));
  }
  if (!state.photo || !textures?.perArchetype?.[shape.archetype]?.colour) {
    return c.map((v) => Math.min(1, v * jitter));
  }
  const mean = (c[0] + c[1] + c[2]) / 3 || 1;
  return c.map((v) => (0.55 + 0.45 * (v / mean)) * jitter);
}

/**
 * A shingle bank: stones laid over a disc without interpenetrating.
 *
 * There is no physics here — settling is rock-sift's job, and this lab exists to
 * judge geometry and throughput. But "no physics" is not why the first version
 * of this looked wrong. It allotted 0.62 * size^2 of ground per stone, and a
 * stone lying on its flat face has a footprint of about 0.64 * size^2, so it was
 * asking for ~100% coverage from independent random placement. Random sequential
 * adsorption saturates near 54%: at that density every stone overlaps its
 * neighbours, and no amount of physics afterwards would untangle it.
 *
 * So placement is rejection-sampled against a spatial grid instead. Each stone
 * gets a footprint radius from its own baked extents, and a candidate position
 * is rejected if it would sit inside a neighbour. `touch` below 1 lets stones
 * just interlock at the edges, which is what real shingle does.
 */
function scatterField(count) {
  const rng = mulberry32(hash32(state.seed * 31 + count));
  const shapes = lib.shapes;

  // Draw every stone up front so the disc can be sized from the real footprint
  // area rather than an average, and so packing is stable as count changes.
  const picks = new Array(count);
  const radii = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const si = Math.floor(rng() * shapes.length);
    const s = shapes[si];
    const size = drawSize(rng, {
      median: state.medianMm / 1000,
      sorting: state.sorting,
      bias: s.sizeBias,
    });
    // Lying flat, the footprint is the long axis by the middle one; the
    // geometric mean of the two is the radius of the disc of equal area.
    radii[i] = 0.5 * size * Math.sqrt(s.unitSpan[0] * s.unitSpan[2]);
    picks[i] = { si, s, size };
  }

  const packed = packDisc({ radii, packing: state.packing, rng });

  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const { si, s, size } = picks[i];

    let rot;
    if (state.tumbled) {
      rot = Quaternion.RotationYawPitchRoll(rng() * 6.283, rng() * 6.283, rng() * 6.283);
    } else {
      // A stone at rest lies on its flattest face. The shape model puts the
      // short axis on y, so a yaw plus a small tilt is the resting pose — and
      // it is what makes a field of slate read as a shingle beach rather than a
      // bag of gravel tipped out.
      rot = Quaternion.RotationYawPitchRoll(
        rng() * 6.283, (rng() - 0.5) * 0.55, (rng() - 0.5) * 0.55);
      if (rng() < 0.08) rot = Quaternion.RotationYawPitchRoll(rng() * 6.283, rng() * 6.283, rng() * 6.283);
    }

    out[i] = {
      shape: si,
      size,
      // Sunk by a fraction of its own thickness so stones sit *in* the sand
      // rather than balanced on it. Without a solver this is the only thing
      // standing in for settling, and it is enough at a glance.
      position: [packed.x[i], s.unitSpan[1] * size * (0.30 + rng() * 0.14), packed.z[i]],
      rotation: rot,
      tint: tintFor(s, 0.86 + rng() * 0.28),
    };
  }

  return { instances: out, radius: packed.radius, coverage: packed.coverage, grew: packed.grew };
}

function inspectInstances() {
  const s = lib.shapes[state.inspectSeed % lib.count];
  return {
    instances: [{
      shape: s.index,
      size: (s.sizeRange[0] + s.sizeRange[1]) / 2,
      position: [0, 0, 0],
      rotation: Quaternion.Identity(),
      tint: tintFor(s, 1),
    }],
    radius: 0.2,
    shape: s,
  };
}

function rebuildInstances() {
  disposeReference();

  if (state.mode === "inspect") {
    const { instances, shape } = inspectInstances();
    field.setInstances(instances);
    ground.setEnabled(false);
    if (state.reference) buildReference(shape);
    const size = instances[0].size;
    const m = instanceMetrics(shape, size);
    H.set("stone", `${shape.label} #${shape.index}`);
    H.set("size", `${m.sortedCm.map((v) => v.toFixed(1)).join(" x ")} cm`);
    H.set("mass", `${m.massGrams.toFixed(0)} g`);
    H.set("skip", `${m.rating.rarity.label} — ${m.rating.verdict}`);
    camera.setTarget(Vector3.Zero());
    camera.radius = size * 3.4;
  } else {
    const { instances, radius, coverage, grew } = scatterField(state.rockCount);
    H.set("packing", `${(coverage * 100).toFixed(0)}% covered${grew ? `, disc grew ${grew}x` : ""}`);

    // Report the distribution by count *and* by area. A bed is dominated by
    // small stones numerically and by large ones visually, and only reporting
    // one of those hides whichever is wrong.
    const rep = sizeReport(instances.map((i) => i.size));
    H.set("size d10/50/90", `${(rep.d10 * 1000).toFixed(0)} / ${(rep.median * 1000).toFixed(0)} / ${(rep.d90 * 1000).toFixed(0)} mm`);
    H.set("size range", `${(rep.min * 1000).toFixed(0)} – ${(rep.max * 1000).toFixed(0)} mm`);
    H.set("grades by count", Object.entries(rep.byCount).map(([k, v]) =>
      `${k.slice(0, 3)} ${Math.round(100 * v / rep.n)}%`).join("  "));
    H.set("grades by area", Object.entries(rep.byArea).map(([k, v]) =>
      `${k.slice(0, 3)} ${Math.round(100 * v)}%`).join("  "));
    field.setInstances(instances);
    ground.setEnabled(true);
    ground.scaling.setAll(Math.max(1, (radius * 1.35) / 12));
    H.set("stone", "—");
    H.set("size", "—");
    H.set("mass", "—");
    H.set("skip", "—");
    camera.setTarget(Vector3.Zero());
    camera.radius = Math.min(6, Math.max(0.7, radius * 0.55));
  }
  field.update(camera.position, true);
  shadowsRefresh?.(); // the field genuinely changed — re-render the map once
}

/* ------------------------------------------------- high-poly reference */

function buildReference(shape) {
  const size = (shape.sizeRange[0] + shape.sizeRange[1]) / 2;
  const d = buildDetailMesh(shape, ARCHETYPES[shape.archetype], 5, size);

  referenceMesh = new Mesh("reference", scene);
  const vd = new VertexData();
  vd.positions = d.positions;
  vd.normals = d.normals;
  vd.indices = Array.from(d.indices);
  vd.applyToMesh(referenceMesh, false);
  referenceMesh.position.x = size * 1.5;

  // Matched to the field material's own polish curve (rockMaterial.js), rather
  // than a fixed roughness/specularIntensity, so the side-by-side comparison
  // does not quietly go stale or read shinier/duller than the low-poly rocks
  // standing right next to it.
  const arch = ARCHETYPES[shape.archetype];
  const pol = state.polish < 0 ? (arch.gem?.startPolish ?? arch.startPolish ?? 0) : state.polish;

  referenceMat = new PBRMaterial("referenceMat", scene);
  referenceMat.albedoColor = new Color3(...shape.colour);
  referenceMat.metallic = 0;
  referenceMat.environmentIntensity = 0.9;
  if (arch.gem) {
    referenceMat.roughness = lerp(arch.gem.roughRaw, arch.gem.roughPolished, pol);
    referenceMat.specularIntensity = lerp(0.5, 1.0, pol);
  } else {
    referenceMat.roughness = lerp(shape.roughness, ROCK_POLISHED_ROUGHNESS, pol);
    referenceMat.specularIntensity = lerp(ROCK_RAW_SPECULAR, ROCK_POLISHED_SPECULAR, pol);
  }
  referenceMat.wireframe = state.wireframe;
  referenceMesh.material = referenceMat;
  if (shadows) { shadows.addShadowCaster(referenceMesh, false); shadowsRefresh?.(); }

  // Move the instanced one out of the way so they sit side by side.
  field.setInstances([{
    shape: shape.index,
    size,
    position: [-size * 1.5, 0, 0],
    rotation: Quaternion.Identity(),
    tint: tintFor(shape, 1),
  }]);
  H.set("reference", `${d.indices.length / 3} tris (no grain map)`);
}

function disposeReference() {
  referenceMesh?.dispose();
  referenceMat?.dispose();
  referenceMesh = referenceMat = null;
  H.set("reference", "—");
}

/* ------------------------------------------------------------------ HUD */

const KB = (b) => `${(b / 1024).toFixed(1)} KB`;
const MB = (b) => `${(b / 1048576).toFixed(2)} MB`;

/**
 * Surface shader compile failures.
 *
 * A material whose effect fails to compile is silently skipped: the meshes just
 * do not draw, the frame rate stays at 60 because there is nothing to draw, and
 * every counter in the HUD keeps reporting healthy numbers because they are
 * counting instances, not pixels. That is exactly how a whole field of rocks
 * can go missing with no visible complaint. Check for it explicitly.
 */
function checkShaders() {
  const bad = [];
  for (const [name, mat] of Object.entries(materials)) {
    const err = mat.getEffect()?.getCompilationError?.();
    if (err) bad.push(`rock material "${name}":\n${err}`);
  }
  if (bad.length) showError("Shader compilation failed — no rocks will be drawn.\n\n" + bad.join("\n\n"));
  return bad.length === 0;
}

let hudTick = 0;
function updateHud() {
  if (hudTick++ % 10) return;   // the DOM writes cost more than the stats do
  if (hudTick === 31) checkShaders();   // give the effects a few frames to compile
  const s = field.stats();
  H.set("fps", engine.getFps().toFixed(0));
  H.set("rocks", s.total.toLocaleString());
  H.set("triangles", s.triangles.toLocaleString());
  // Two separate numbers on purpose. `buckets` is what this code *intends* to
  // draw; `gl draw calls` is what the driver was actually asked to draw. When a
  // material fails to compile the first stays healthy and the second collapses,
  // which is the difference between "no rocks" and "rocks I cannot see".
  H.set("buckets", `${s.draws} / ${Object.keys(materials).length * field.lodLevels.length}`);
  H.set("gl draw calls", instrumentation?.drawCallsCounter?.current ?? "—");
  H.set("lod split", s.perLod.join(" / "));
  H.set("rebucket", `${s.rebucketMs.toFixed(2)} ms`);

  const shapeBytes = lib.stats.shapeTextureBytes;
  const baseBytes = lib.stats.baseVertexBytes + lib.stats.indexBytes;
  // Per drawn rock: one 4x4 matrix plus the 4-float instance record.
  const instBytes = s.total * (16 + 4) * 4;
  H.set("shape texture", `${KB(shapeBytes)} (${lib.count} shapes)`);
  H.set("base meshes", KB(baseBytes));
  H.set("instance data", KB(instBytes));
  H.set("geometry total", MB(shapeBytes + baseBytes + instBytes));
  // Called out separately because it is the one cost that does *not* scale with
  // rock count: six surfaces plus one height map, shared by every stone alive.
  if (state.photo && textures) H.set("surface textures", MB(textures.bytes));

  // What the same field would cost with one unique 1,280-tri mesh per rock.
  const perMesh = 642 * (3 + 3 + 2) * 4 + 1280 * 3 * 2;
  H.set("if unique meshes", MB(perMesh * s.total));
}

/* ------------------------------------------------------------ benchmark */

function startBenchmark(btn) {
  if (bench) return;
  const steps = [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000];
  bench = { i: 0, frames: 0, acc: 0, results: [], btn, prevCount: state.rockCount, prevMode: state.mode };
  state.mode = "field";
  state.rockCount = steps[0];
  bench.steps = steps;
  rebuildInstances();
  btn.textContent = "benchmarking…";
}

function tickBenchmark() {
  if (!bench) return;
  // Skip the first 20 frames of each step: buffer uploads and shader compiles
  // land there and would be charged to the wrong rock count.
  bench.frames++;
  if (bench.frames < 20) return;
  bench.acc += engine.getFps();

  if (bench.frames >= 70) {
    const fps = bench.acc / (bench.frames - 19);
    bench.results.push({ count: bench.steps[bench.i], fps });
    bench.i++;
    bench.frames = 0;
    bench.acc = 0;

    if (fps < 30 || bench.i >= bench.steps.length) {
      const lines = bench.results.map((r) => `${r.count.toLocaleString().padStart(7)} rocks  ${r.fps.toFixed(0).padStart(4)} fps`);
      const last60 = [...bench.results].reverse().find((r) => r.fps >= 58);
      console.log("rock-forge benchmark\n" + lines.join("\n"));
      bench.btn.textContent = "run benchmark";
      const summary = last60
        ? `${last60.count.toLocaleString()} rocks at 60 fps`
        : `under ${bench.results[0].count.toLocaleString()} at 60 fps`;
      H.set("benchmark", summary);
      state.rockCount = bench.prevCount;
      state.mode = bench.prevMode;
      bench = null;
      rebuildInstances();
      return;
    }
    state.rockCount = bench.steps[bench.i];
    rebuildInstances();
  }
}

/* ----------------------------------------------------------------- boot */

async function boot() {
  // Shared scribble store (the labs hub): only keys the user has touched
  // anywhere exist in it, and they override this lab's defaults before the
  // scene is built — so this panel's sliders seat on the carried-over values.
  // This lab's own dials write back through watchAndSave below.
  const scribStored = loadScribbleSettings();
  const SCRIB_TO_STATE = {
    on: "scribble", levels: "scribbleLevels", satAmount: "scribbleSat",
    strokeAmount: "scribbleStrokeAmount", strokeFreq: "scribbleStrokeFreq",
    strokeAngle: "scribbleStrokeAngle", ignoreSky: "scribbleIgnoreSky",
    paperScale: "scribblePaperScale", grain: "scribbleGrain",
    bleed: "scribbleBleed", warp: "scribbleWarp",
    exposure: "envExposure", warmth: "envWarmth",
  };
  for (const [key, sk] of Object.entries(SCRIB_TO_STATE)) {
    if (!(key in scribStored)) continue;
    state[sk] = (sk === "scribble" || sk === "scribbleIgnoreSky")
      ? scribStored[key] > 0.5
      : scribStored[key];
  }

  const canvas = document.getElementById("view");
  engine = createEngine(canvas);
  const built = createScene(engine);
  scene = built.scene; camera = built.camera; sun = built.sun; envSetup = built.envSetup;
  // createScene hardcodes the dump's env values; carried-over dials override
  // them here, right after the pipeline exists.
  if ("exposure" in scribStored) envSetup.setExposure(state.envExposure);
  if ("warmth" in scribStored) envSetup.setWarmth(state.envWarmth);
  if ("warmthHue" in scribStored) envSetup.curves.globalHue = scribStored.warmthHue;
  if ("envSaturation" in scribStored) envSetup.curves.globalSaturation = scribStored.envSaturation;
  ground = createGround(scene);

  // Constructed here, enabled nowhere yet. ORDER MATTERS for this one: the
  // environment's tone-mapping pipeline was already attached to the camera
  // inside createScene (above), so the scribble pass — attached lazily on
  // first enable() — lands after it in the post-process chain. Reverse that
  // and the ink paints onto pre-tone-mapped HDR values and turns to mud.
  scribbleFx = createScribble(scene, camera, engine, {
    grain: state.scribbleGrain,
    warp: state.scribbleWarp, bleed: state.scribbleBleed,
    levels: state.scribbleLevels, satAmount: state.scribbleSat,
    strokeAmount: state.scribbleStrokeAmount, strokeFreq: state.scribbleStrokeFreq,
    strokeAngle: state.scribbleStrokeAngle,
    ignoreSky: state.scribbleIgnoreSky, paperScale: state.scribblePaperScale,
  });
  if (state.scribble) scribbleFx.enable(true);

  // Draw calls live on SceneInstrumentation, not EngineInstrumentation, which
  // only carries GPU frame time and shader compilation time.
  instrumentation = new SceneInstrumentation(scene);
  instrumentation.captureRenderTime = false;

  varTex = makeVariationTexture(scene, { size: 512, seed: 4711 });
  grainTex = makeGrainTexture(scene, { size: 512, grit: 64, strength: 1.25, seed: 11 });

  // Photographed surfaces are the good path, but the lab has to survive without
  // them — a missing or malformed manifest should cost you realism, not the
  // whole scene.
  try {
    textures = await loadRockTextures(scene);
    H.set("surfaces", `${Object.keys(textures.perArchetype).length} loaded, ${MB(textures.bytes)}`);
    if (textures.notes.length) console.warn("rock textures:", textures.notes);
  } catch (e) {
    console.warn("rock textures unavailable, falling back to procedural grain:", e);
    H.set("surfaces", "unavailable — procedural");
    state.photo = false;
  }

  rebuildLibrary();
  buildPanel();

  // Write this lab's dial changes back into the shared store — but only the
  // keys that actually moved from their boot values, so an untouched slider
  // never overwrites another lab's own baseline.
  const snapshotScribble = () => ({
    on: state.scribble ? 1 : 0,
    levels: state.scribbleLevels, satAmount: state.scribbleSat,
    strokeAmount: state.scribbleStrokeAmount, strokeFreq: state.scribbleStrokeFreq,
    strokeAngle: state.scribbleStrokeAngle,
    ignoreSky: state.scribbleIgnoreSky ? 1 : 0,
    paperScale: state.scribblePaperScale, grain: state.scribbleGrain,
    bleed: state.scribbleBleed, warp: state.scribbleWarp,
    exposure: state.envExposure, warmth: state.envWarmth,
    warmthHue: envSetup.curves.globalHue, envSaturation: envSetup.curves.globalSaturation,
  });
  const scribBase = snapshotScribble();
  watchAndSave(document.getElementById("panel"), () => {
    const now = snapshotScribble();
    const diff = {};
    for (const k in now) if (now[k] !== scribBase[k]) diff[k] = now[k];
    Object.assign(scribBase, diff);
    return diff;
  });

  engine.runRenderLoop(() => {
    field.update(camera.position);
    scene.render();
    updateHud();
    tickBenchmark();
  });
  window.addEventListener("resize", () => engine.resize());
}

function buildPanel() {
  const p = panel(document.getElementById("panel"));

  p.section("mode");
  p.select("mode", {
    options: ["field", "inspect"], value: state.mode,
    onChange: (v) => { state.mode = v; rebuildInstances(); },
  });
  p.select("family", {
    options: ["mixed", ...ARCHETYPE_NAMES], value: state.family,
    onChange: (v) => { state.family = v; rebuildLibrary(); },
  });

  p.section("field");
  p.slider("rocks", {
    min: 100, max: 40000, step: 100, value: state.rockCount,
    format: (v) => v.toLocaleString(),
    onChange: (v) => { state.rockCount = v; if (state.mode === "field") rebuildInstances(); },
  });
  p.slider("median size", {
    min: 12, max: 160, step: 1, value: state.medianMm,
    format: (v) => `${v} mm`,
    onChange: (v) => { state.medianMm = v; if (state.mode === "field") rebuildInstances(); },
  });
  p.slider("sorting", {
    min: 0.15, max: 2.2, step: 0.05, value: state.sorting,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.sorting = v; if (state.mode === "field") rebuildInstances(); },
  });
  p.note("Sorting is the spread of clast size, in phi units — the sedimentologist's own measure. One phi unit is a doubling of diameter. Below 0.35 is a storm beach ridge; 0.5–1.0 a pond margin; 1.0–2.0 an active river bed, cobbles among granules.");
  p.slider("packing", {
    min: 0.2, max: 0.6, step: 0.01, value: state.packing,
    format: (v) => `${(v * 100).toFixed(0)}%`,
    onChange: (v) => { state.packing = v; if (state.mode === "field") rebuildInstances(); },
  });
  p.note("Fraction of the ground the stones' footprints cover. Placement is rejection-sampled, so they no longer interpenetrate — but there is no solver here, so rejection sampling saturates near 59%, past which the disc grows rather than packing tighter. Real settling is rock-sift's job.");
  p.toggle("fully tumbled rotations", {
    value: state.tumbled,
    onChange: (v) => { state.tumbled = v; rebuildInstances(); },
  });
  p.button("run benchmark", startBenchmark);

  p.section("library");
  p.slider("shapes", {
    min: 8, max: 512, step: 8, value: state.libCount,
    onChange: (v) => { state.libCount = v; rebuildLibrary(); },
  });
  p.slider("seed", {
    min: 1, max: 200, step: 1, value: state.seed,
    onChange: (v) => { state.seed = v; rebuildLibrary(); },
  });
  p.note("Shapes is how many distinct rocks exist. Everything on screen is one of them, rotated, scaled and tinted — drop it to 8 and watch repetition appear.");

  p.section("inspect");
  p.slider("which stone", {
    min: 0, max: 511, step: 1, value: state.inspectSeed,
    onChange: (v) => { state.inspectSeed = v; if (state.mode === "inspect") rebuildInstances(); },
  });
  p.toggle("show 20k-tri reference", {
    value: state.reference,
    onChange: (v) => { state.reference = v; if (state.mode === "inspect") rebuildInstances(); },
  });

  p.section("lod");
  p.select("force lod", {
    options: [
      { value: "-1", label: "automatic" },
      { value: "0", label: "0 — 1280 tris" },
      { value: "1", label: "1 — 320 tris" },
      { value: "2", label: "2 — 80 tris" },
    ],
    value: String(state.lod),
    onChange: (v) => { state.lod = parseInt(v, 10); field.forcedLod = state.lod; field.update(camera.position, true); },
  });
  p.slider("lod0 → 1 at", {
    min: 4, max: 60, step: 1, value: state.lodStep0,
    format: (v) => `${v}x`,
    onChange: (v) => { state.lodStep0 = v; field.lodSteps[0] = v; field.update(camera.position, true); },
  });
  p.slider("lod1 → 2 at", {
    min: 10, max: 200, step: 2, value: state.lodStep1,
    format: (v) => `${v}x`,
    onChange: (v) => { state.lodStep1 = v; field.lodSteps[1] = v; field.update(camera.position, true); },
  });
  p.toggle("colour by lod", {
    value: state.lodDebug,
    onChange: (v) => { state.lodDebug = v; field.lodDebug = v; field.update(camera.position, true); },
  });
  p.note("Switch distances are multiples of each rock's own size, so a big cobble holds detail further out than a pebble.");

  p.section("surface");
  p.toggle("photographed rock surfaces", {
    value: state.photo,
    onChange: (v) => { state.photo = v; rebuildLibrary(); },
  });
  p.slider("displacement", {
    min: 0, max: 4, step: 0.1, value: state.dispMm,
    format: (v) => `${v.toFixed(1)} mm`,
    onChange: (v) => { state.dispMm = v; rebuildLibrary(); },
  });
  p.note("Displacement is real geometry, not a lighting trick — but LOD0 triangles are ~3 mm on a 7 cm stone, so it only carries relief coarser than that. Anything finer stays in the normal map. Past ~2 mm it drifts outside what the physics hull knows about.");

  p.section("treasure");
  p.slider("polish", {
    min: -1, max: 1, step: 0.05, value: state.polish,
    format: (v) => (v < 0 ? "natural" : v.toFixed(2)),
    onChange: (v) => { state.polish = v; rebuildLibrary(); },
  });
  p.note("Rough to tumbled — every rock and treasure now, not just the minerals. Drives roughness, specular sheen, a clear coat, how much light passes through, and how strongly the grain/normal detail and vertex displacement show, since tumbling wears down fine relief as well as putting a shine on. 'natural' leaves each kind in the state it is found in: unpolished for almost everything, obsidian starts a little glassy since its fracture faces already are, sea glass starts frosted rather than jagged. This is the hook a tumbling mechanic drives later.");
  p.note("Pick a single kind from the family list at the top to inspect it — treasures are about 1 in 21 of a mixed field, so they are easy to miss.");

  p.section("shading");
  p.slider("veins / mottle", {
    min: 0, max: 2, step: 0.05, value: state.adders,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.adders = v; rebuildLibrary(); },
  });
  p.note("proc-rock's texture adders: low-frequency mottling, quartz veins from the minimum of two billow noises, Voronoi mineral spots, and bedding bands aligned to the shape's own layering. At 0 every stone of a family wears the same photograph.");
  p.slider("grain", {
    min: 0, max: 2, step: 0.05, value: state.grain,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.grain = v; rebuildLibrary(); },
  });
  p.toggle("wireframe", {
    value: state.wireframe,
    onChange: (v) => {
      state.wireframe = v;
      for (const m of Object.values(materials)) m.wireframe = v;
      if (referenceMat) referenceMat.wireframe = v;
    },
  });
  p.note("Grain is the shared triplanar normal map. At 0 you are looking at the raw 1,280-triangle silhouette.");

  p.section("environment");
  p.slider("exposure", {
    min: 0.4, max: 2.0, step: 0.05, value: state.envExposure,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.envExposure = v; envSetup.setExposure(v); },
  });
  p.slider("warmth", {
    min: 0, max: 60, step: 1, value: state.envWarmth,
    onChange: (v) => { state.envWarmth = v; envSetup.setWarmth(v); },
  });
  p.note("ACES tone mapping is always on — without it a linear HDR sky clips to flat white. Warmth, hue and saturation default to the water sim's own [Look] tuning (28 / 30 / 6), so both scenes sit on one grade; exposure 1.00 comes from the same dump.");

  p.section("pastel pass");
  p.toggle("pastel on", {
    value: state.scribble,
    onChange: (v) => { state.scribble = v; scribbleFx.enable(v); },
  });
  p.slider("value steps", {
    min: 2, max: 64, step: 1, value: state.scribbleLevels,
    onChange: (v) => { state.scribbleLevels = v; scribbleFx.set("levels", v); },
  });
  p.slider("saturation", {
    min: 0, max: 1.4, step: 0.02, value: state.scribbleSat,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.scribbleSat = v; scribbleFx.set("satAmount", v); },
  });
  p.slider("stroke amount", {
    min: 0, max: 1, step: 0.02, value: state.scribbleStrokeAmount,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.scribbleStrokeAmount = v; scribbleFx.set("strokeAmount", v); },
  });
  p.slider("stroke density", {
    min: 4, max: 140, step: 2, value: state.scribbleStrokeFreq,
    onChange: (v) => { state.scribbleStrokeFreq = v; scribbleFx.set("strokeFreq", v); },
  });
  p.slider("stroke angle", {
    min: 0, max: 3.14, step: 0.05, value: state.scribbleStrokeAngle,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.scribbleStrokeAngle = v; scribbleFx.set("strokeAngle", v); },
  });
  p.toggle("ignore sky", {
    value: state.scribbleIgnoreSky,
    onChange: (v) => { state.scribbleIgnoreSky = v; scribbleFx.set("ignoreSky", v); },
  });
  p.slider("paper scale", {
    min: 0.5, max: 40, step: 0.25, value: state.scribblePaperScale,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.scribblePaperScale = v; scribbleFx.set("paperScale", v); },
  });
  p.slider("paper grain", {
    min: 0, max: 0.8, step: 0.02, value: state.scribbleGrain,
    format: (v) => v.toFixed(2),
    onChange: (v) => { state.scribbleGrain = v; scribbleFx.set("grain", v); },
  });
  p.slider("colour bleed", {
    min: 0, max: 0.03, step: 0.001, value: state.scribbleBleed,
    format: (v) => v.toFixed(3),
    onChange: (v) => { state.scribbleBleed = v; scribbleFx.set("bleed", v); },
  });
  p.slider("paper warp", {
    min: 0, max: 0.02, step: 0.001, value: state.scribbleWarp,
    format: (v) => v.toFixed(3),
    onChange: (v) => { state.scribbleWarp = v; scribbleFx.set("warp", v); },
  });
  p.note("The universal pastel look, dialled in on the shared panel 2026-08-04 — value steps 50, saturation 1.02, strokes 0.02 at density 10, paper scale 37.25, grain 0.14, warp 0, bleed 0. Depth-edge outlines have been removed from the shader entirely: they traced each rock's undisplaced sphere silhouette as a halo floating outside the stone. The depth pass survives only to hand the sky back as photography.");

  p.section("debug");
  p.toggle("bypass shape texture", {
    value: state.bypass,
    onChange: (v) => { state.bypass = v; rebuildLibrary(); },
  });
  p.button("log field state to console", () => {
    for (const [name, group] of field.groups) {
      group.buckets.forEach((b, i) => {
        console.log(`${name} lod${i}`, {
          bucketCount: b.count,
          thinInstanceCount: b.mesh.thinInstanceCount,
          enabled: b.mesh.isEnabled(),
          verts: b.mesh.getTotalVertices(),
          hasVertIndex: !!b.mesh.getVertexBuffer("vertIndex"),
          hasRockInst: !!b.mesh.getVertexBuffer("rockInst"),
          matReady: b.mesh.material?.isReady(b.mesh),
          firstMatrix: Array.from(b.matrices?.subarray(0, 16) || []),
        });
      });
    }
    console.log("camera", camera.position.toString(), "radius", camera.radius);
  });
  p.note("Bypass draws the shared sphere at a fixed radius, ignoring the shape texture. Rocks appearing only with it on means the texture fetch is at fault.");
}

boot().catch((e) => { console.error(e); showError(e); });
