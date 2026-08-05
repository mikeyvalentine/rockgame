// Static checks on the GLSL the rock material actually emits.
//
//   node tools/shader-check.mjs
//
// Every shader bug in this project so far has been one of four things, none of
// which a bundler or a linter can see, and all of which cost a browser round
// trip to find:
//
//   1. ES 1.00 syntax. Babylon's processor rewrites `attribute`, `varying` and
//      `texture2D` for WebGL 2 — but plugin code is injected through
//      `processFinalCode`, which runs *after* that pass. ES 1.00 written here
//      reaches the compiler untouched inside a `#version 300 es` shader.
//   2. Comments. ShaderCodeCursor splits any line whose semicolon is not the
//      last character, on every semicolon in it, with no idea what a comment
//      is. `// tighten the blend; a linear one smears` becomes a bare statement.
//   3. Mid-line semicolons in real code, for the same reason.
//   4. Plugin construction order — `super()` runs getCustomCode before the
//      subclass has assigned its options.
//
// This drives the real plugin through a NullEngine, so it exercises the actual
// construction path rather than a regex over the source.

import { NullEngine, PBRMaterial, Scene } from "@babylonjs/core";
import { createRockMaterials } from "../src/babylon/rockMaterial.js";
import { ARCHETYPE_NAMES } from "../src/forge/archetypes.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`  ok    ${name}${detail ? " — " + detail : ""}`);
};

const scene = new Scene(new NullEngine());

// Stand-ins: getCustomCode only tests these for truthiness, and bindForSubMesh
// never runs without a render.
const stub = (name) => ({ name, isReady: () => true });
const lib = { width: 642, count: 96 };

function emit({ photo }) {
  const surfaces = {};
  for (const a of ARCHETYPE_NAMES) {
    surfaces[a] = { colour: stub("col"), normal: stub("nrm"), surf: stub("arm"), repeat: 0.42 };
  }
  const mats = createRockMaterials(scene, lib, {
    shapeTex: stub("shape"),
    grainTex: stub("grain"),
    surfaces: photo ? surfaces : null,
    heightTex: photo ? stub("height") : null,
    varTex: stub("var"),
    heightAspect: 0.438,
    heightWidth: 2048,
    dispMetres: 0.0012,
  });

  const out = [];
  for (const [name, mat] of Object.entries(mats)) {
    const plugin = mat.pluginManager?._plugins?.find((p) => p.name === "RockShape");
    if (!plugin) { check(`${name}: plugin registered`, false); continue; }
    for (const stage of ["vertex", "fragment"]) {
      const chunks = plugin.getCustomCode(stage) || {};
      for (const [point, code] of Object.entries(chunks)) {
        out.push({ name, stage, point, code });
      }
    }
    mat.dispose();
  }
  return out;
}

for (const photo of [true, false]) {
  const label = photo ? "photo surfaces" : "procedural grain";
  console.log(`\n${label}`);
  const chunks = emit({ photo });
  check("emits code for every archetype and stage", chunks.length >= ARCHETYPE_NAMES.length * 2,
    `${chunks.length} injected chunks`);

  const problems = { es1: [], comment: [], semicolon: [], empty: [] };
  for (const { name, stage, point, code } of chunks) {
    if (!code.trim()) problems.empty.push(`${name}/${stage}/${point}`);
    if (/\battribute\s/.test(code) || /\bvarying\s/.test(code) || /\btexture2D\s*\(/.test(code)) {
      problems.es1.push(`${name}/${stage}/${point}`);
    }
    for (const line of code.split("\n")) {
      const t = line.trim();
      if (t.includes("//")) problems.comment.push(`${point}: ${t}`);
      const i = t.indexOf(";");
      if (i !== -1 && i !== t.length - 1) problems.semicolon.push(`${point}: ${t}`);
    }
  }

  check("no ES 1.00 syntax reaches the compiler", problems.es1.length === 0, problems.es1.join(", "));
  check("no comments survive stripping", problems.comment.length === 0, problems.comment.slice(0, 3).join(" | "));
  check("no line will be split by the semicolon rule", problems.semicolon.length === 0,
    problems.semicolon.slice(0, 3).join(" | "));
  check("no chunk is empty", problems.empty.length === 0, problems.empty.join(", "));

  // Balanced braces, so an injected block cannot swallow the rest of main().
  for (const { point, code } of chunks) {
    const open = (code.match(/\{/g) || []).length;
    const close = (code.match(/\}/g) || []).length;
    if (open !== close) check(`${point}: braces balanced`, false, `${open} open, ${close} close`);
  }
}

// The construction-order trap: the plugin must know its options by the time the
// manager asks for code, or the shader is emitted with `undefined` baked in.
console.log("\nconstruction order");
{
  const mats = createRockMaterials(scene, lib, { shapeTex: stub("s"), grainTex: stub("g") });
  const mat = Object.values(mats)[0];
  const plugin = mat.pluginManager._plugins.find((p) => p.name === "RockShape");
  const code = Object.values(plugin.getCustomCode("vertex")).join("\n");
  check("no 'undefined' or 'NaN' baked into the shader",
    !/undefined|NaN/.test(code));
  check("shape texture dimensions were known at emit time", /0\.0015576/.test(code),
    "1/642 present");
  for (const m of Object.values(mats)) m.dispose();
}

// The effect-cache collision trap — the fifth class of shader bug, found in a
// full audit rather than on screen because its symptom is subtle: everything
// renders, just with the wrong family's constants. Babylon keys compiled
// programs on `shaderName + "@" + defines` and consults that cache BEFORE
// processFinalCode runs, so the per-material injected code is invisible to it.
// Any two materials with identical define strings share one program, and the
// loser silently wears the winner's baked texture repeat, vein colours and gem
// ramp. Every material must therefore carry a define that distinguishes it.
console.log("\neffect-cache identity");
{
  const mats = createRockMaterials(scene, lib, {
    shapeTex: stub("s"), grainTex: stub("g"), varTex: stub("v"),
  });
  const names = Object.keys(mats);
  const variants = [];
  let registered = true;
  for (const name of names) {
    const plugin = mats[name].pluginManager._plugins.find((p) => p.name === "RockShape");
    if (!("ROCKFORGE_VARIANT" in (plugin._pluginDefineNames ?? {}))) registered = false;
    const d = {};
    plugin.prepareDefines(d);
    variants.push(d.ROCKFORGE_VARIANT);
  }
  check("ROCKFORGE_VARIANT is registered with the plugin manager", registered);
  check("every material carries a distinct variant define",
    new Set(variants).size === names.length,
    `${new Set(variants).size} distinct across ${names.length} materials`);
  for (const m of Object.values(mats)) m.dispose();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
