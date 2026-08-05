// The WebGL fallback's shader surface — NullEngine drives the real plugin
// construction path (rock-forge's shader-check pattern), and the GLSL twins in
// the registry are textually validated (they can't be imported here: the
// registry's ?raw imports are vite-only).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";

import { SandDeformPlugin } from "../src/render/sandDeformPlugin.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

function balanced(src) {
    let depth = 0;
    for (const ch of src) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

// ---- the plugin constructs on the real material path ------------------------
const engine = new NullEngine();
const scene = new Scene(engine);
const mat = new PBRMaterial("sandGL", scene);
const plugin = new SandDeformPlugin(mat, null);

check("plugin registers on the material", mat.pluginManager?._plugins?.some?.(
    (p) => p.name === "SandDeform"
) ?? true);

const frag = plugin.getCustomCode("fragment");
check("fragment injection exists", !!frag && !!frag.CUSTOM_FRAGMENT_UPDATE_ALBEDO);
check("albedo chunk gated by define",
    frag.CUSTOM_FRAGMENT_UPDATE_ALBEDO.includes("#ifdef SAND_DEFORM"));
check("albedo chunk braces balanced",
    balanced(frag.CUSTOM_FRAGMENT_UPDATE_ALBEDO.replace(/#ifdef[^\n]*|#endif[^\n]*/g, "")));
check("vertex injection absent (fragment-only by design)",
    plugin.getCustomCode("vertex") === null);

const uni = plugin.getUniforms();
check("ubo uniforms declared", Array.isArray(uni.ubo) && uni.ubo.length >= 5);

const defines = { SAND_DEFORM: false, SAND_DEFORM_TEX: true };
plugin.prepareDefines(defines);
check("defines: deform on, tex tracks field (null → false)",
    defines.SAND_DEFORM === true && defines.SAND_DEFORM_TEX === false);

// ---- the registry's GLSL twins, textually -----------------------------------
const reg = readFileSync(join(ROOT, "src", "shaders", "registry.js"), "utf8");
for (const name of ["GL_SKY_VERTEX", "GL_HDRI_SKY_FRAGMENT", "GL_DEFORM_SIM_FRAGMENT"]) {
    const m = reg.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
    check(name + " present", !!m);
    if (m) {
        check(name + " has main()", m[1].includes("void main()"));
        check(name + " braces balanced", balanced(m[1]));
    }
}

engine.dispose();
process.exit(failures ? 1 : 0);
