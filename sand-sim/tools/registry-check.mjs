// Shader registry integrity — pure fs/regex, no Babylon, no vite.
//
// Catches the failure modes that are otherwise browser-only: a WGSL file
// deleted but still imported, an include used that nothing registers, an
// orphaned shader file the registry forgot.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHADER_DIR = join(ROOT, "src", "shaders");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const registrySrc = readFileSync(join(SHADER_DIR, "registry.js"), "utf8");
const postSrc = readFileSync(join(ROOT, "src", "post", "postChain.js"), "utf8");

// ---- every ?raw import resolves to a real file ------------------------------
const importRe = /import\s+(\w+)\s+from\s+"(\.[^"]+?)\?raw"/g;
const imported = new Map(); // varName -> abs path
for (const src of [registrySrc, postSrc]) {
    const base = src === registrySrc ? SHADER_DIR : join(ROOT, "src", "post");
    for (const m of src.matchAll(importRe)) {
        imported.set(m[1], join(base, m[2]));
    }
}
let missing = [];
for (const [v, p] of imported) {
    try {
        statSync(p);
    } catch {
        missing.push(v + " -> " + relative(ROOT, p));
    }
}
check("all ?raw imports resolve", missing.length === 0, missing.join(", "));

// ---- no orphaned .wgsl files ------------------------------------------------
const wgslFiles = walk(SHADER_DIR).filter((p) => p.endsWith(".wgsl"));
const importedPaths = new Set([...imported.values()].map((p) => p.replace(/\\/g, "/")));
const orphans = wgslFiles.filter((p) => !importedPaths.has(p.replace(/\\/g, "/")));
check("no orphaned .wgsl files", orphans.length === 0,
    orphans.map((p) => relative(ROOT, p)).join(", "));

// ---- every #include<> used is registered ------------------------------------
const includeKeys = new Set();
for (const src of [registrySrc, postSrc]) {
    for (const m of src.matchAll(/IncludesShadersStoreWGSL\["(\w+)"\]/g)) includeKeys.add(m[1]);
    for (const m of src.matchAll(/^\s*(\w+):\s*\w+Lib,/gm)) includeKeys.add(m[1]);
}
const usedIncludes = new Set();
for (const f of wgslFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(/#include<(\w+)>/g)) {
        usedIncludes.add(m[1]);
    }
}
const unregistered = [...usedIncludes].filter((n) => !includeKeys.has(n));
check("every used #include is registered", unregistered.length === 0, unregistered.join(", "));

// ---- the GLSL twins exist ---------------------------------------------------
check("GLSL sky twin registered", registrySrc.includes('ShadersStore["skyVertexShader"]'));
check("GLSL hdriSky twin registered", registrySrc.includes('ShadersStore["hdriSkyPixelShader"]'));
check("GLSL deformSim twin registered", registrySrc.includes('ShadersStore["deformSimPixelShader"]'));

process.exit(failures ? 1 : 0);
