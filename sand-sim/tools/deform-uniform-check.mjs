// Every uniform and sampler the deformation sim declares must be registered on
// the ProceduralTexture BEFORE its effect is compiled.
//
// This is not a style rule. `ProceduralTexture.isReady()` hands `_uniforms` and
// `_samplers` to `createEffect` once and never rebuilds the effect unless the
// defines change, and `Effect.setFloat` on a name that was not in that list is
// a silent no-op. A uniform first mentioned after warm-up therefore never
// arrives — which is exactly how the WebGL sand ran for weeks with `size` 0 and
// `brushCount` 0: a deformation buffer that no brush could ever reach, with
// every other diagnostic reporting health.
//
// WebGPU cannot catch this: there the bindings come from reflecting the WGSL,
// not from the JS name list. So the check has to be here.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";

import { DeformationField } from "../src/terrain/deformation.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

// ---- what the shaders ask for ----------------------------------------------
const glsl = readFileSync(join(ROOT, "src/shaders/registry.js"), "utf8");
const simStart = glsl.indexOf("const GL_DEFORM_SIM_FRAGMENT");
const simSrc = glsl.slice(simStart, glsl.indexOf("`;", simStart));

const wantSamplers = [...simSrc.matchAll(/uniform\s+sampler2D\s+(\w+)\s*;/g)].map((m) => m[1]);
const wantUniforms = [...simSrc.matchAll(/uniform\s+(?!sampler)(\w+)\s+(\w+)\s*;/g)].map((m) => m[2]);

check("the GLSL sim declares samplers", wantSamplers.length >= 2, wantSamplers.join(","));
check("the GLSL sim declares uniforms", wantUniforms.length >= 8, wantUniforms.join(","));

// The WGSL twin must agree, or the two renderers diverge silently.
const wgsl = readFileSync(join(ROOT, "src/shaders/deformSim.fragment.wgsl"), "utf8");
const missingInWGSL = wantUniforms.filter((n) => !new RegExp("\\b" + n + "\\b").test(wgsl));
check("WGSL twin names the same uniforms", missingInWGSL.length === 0, missingInWGSL.join(","));

// ---- what the field actually registers, before anything is compiled ---------
const engine = new NullEngine();
const scene = new Scene(engine);
const field = new DeformationField(scene);

for (const [i, pt] of field._targets.entries()) {
    const missingS = wantSamplers.filter((n) => !pt._samplers.includes(n));
    const missingU = wantUniforms.filter((n) => !pt._uniforms.includes(n));
    check(`target ${i} registers every sampler up front`, missingS.length === 0, missingS.join(","));
    check(`target ${i} registers every uniform up front`, missingU.length === 0, missingU.join(","));
}

// And the per-frame path must not introduce a name the constructor missed —
// that would compile fine and silently do nothing.
const before = field._targets.map((pt) => [...pt._uniforms, ...pt._samplers].sort().join(","));
field.center.set(3, 4);
field.brush(3, 4, 1, 0.05, 0.02, 0.3, 0, 0, 1, 0.9);
field._targets.forEach((pt) => {
    pt.setTexture("prevTex", field.brushTex);
    pt.setVector2("center", field.center);
    pt.setVector2("prevCenter", field._prevCenter);
    pt.setFloat("size", field.size);
    pt.setFloat("res", field.res);
    pt.setFloat("dt", 0.016);
    pt.setFloat("brushCount", 1);
    pt.setFloat("refillRate", 1);
    pt.setFloat("maxDepth", 0.3);
    pt.setFloat("maxBerm", 0.34);
    pt.setFloat("windAngle", 0);
});
const after = field._targets.map((pt) => [...pt._uniforms, ...pt._samplers].sort().join(","));
check("a frame's binds add no new names", before.every((s, i) => s === after[i]),
    after.map((s, i) => s.split(",").filter((n) => !before[i].includes(n)).join("|")).join(" / "));

field.dispose();
scene.dispose();
engine.dispose();

console.log(failures ? `\n${failures} check(s) failed` : "\nall deform-uniform checks passed");
process.exit(failures ? 1 : 0);
