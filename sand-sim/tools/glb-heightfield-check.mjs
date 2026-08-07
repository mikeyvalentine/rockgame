// TERRAIN READINESS GATE — is pond.0.glb's Landscape clean enough to be the
// world's ground? Bakes it (draco-decoded) through shared/glbHeightfield with
// the world's ENV_OFFSET, no GPU, and asserts the grid describes a pond with a
// shore: floor below the waterline, deepening from rim to centre, rim near the
// waterline, walkable strip sane, and no C4D spikes.
//
// NOT in `npm test` on purpose: the world is still being authored, and this
// gates the ASSET, not the code. Run it after each terrain re-export
// (`npm run test:glbterrain`). While it fails, the mesh is not yet a clean
// heightfield — as of 2026-08-07 the Landscape is mostly land at ~+2.4 m with
// a noisy central pond cavity (±80 m spikes) and a ragged rim, so baking it as
// ground gives messy terrain. When it passes, wiring it in (stage 2) is safe.
// The bake infrastructure (shared/glbHeightfield.js) is done and correct; this
// is waiting on the mesh, not the code.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { bakeHeightGrid, makeHeightSampler } from "../../shared/glbHeightfield.js";
import { ENV_OFFSET } from "../src/scene/worldEnvParams.js";
import { POND_CENTER_X, POND_CENTER_Z, POND_RADIUS } from "../../shared/worldBounds.js";
import { WATERLINE_Z } from "../../shared/shoreRamp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GLB = join(ROOT, "public", "assets", "pond.0.glb");

let failures = 0;
const check = (name, ok, detail) => {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
};

// Draco-decode to a temp glb via the gltf-transform CLI (same one the optimize
// pipeline pins), then read the JSON + bin for the Landscape mesh.
const decoded = join(tmpdir(), "pond.hf-check.glb");
execFileSync("npx", ["--yes", "@gltf-transform/cli@4.4.2", "copy", GLB, decoded], {
    stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32",
});
const buf = readFileSync(decoded);
const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
const bin = 20 + buf.readUInt32LE(12) + 8;
const acc = (i) => {
    const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView];
    const start = bin + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * { SCALAR: 1, VEC3: 3 }[a.type];
    if (a.componentType === 5126) return new Float32Array(buf.buffer, buf.byteOffset + start, n);
    if (a.componentType === 5123) return new Uint16Array(buf.buffer, buf.byteOffset + start, n);
    if (a.componentType === 5125) return new Uint32Array(buf.buffer, buf.byteOffset + start, n);
};
const mesh = gltf.meshes.find((m) => m.name === "Landscape");
const positions = acc(mesh.primitives[0].attributes.POSITION);
const indices = acc(mesh.primitives[0].indices);

// Bake over the pond's world extent: the pond spans ±100 around its centre,
// plus shore; a 260 m grid centred on the pond covers it with margin.
const SIZE = 260, RES = 512;
const baked = bakeHeightGrid({
    positions, indices, offset: ENV_OFFSET,
    origin: { x: POND_CENTER_X - SIZE / 2, z: POND_CENTER_Z - SIZE / 2 },
    size: SIZE, res: RES, clampLo: -8, clampHi: 30,
});
const { heightAt } = makeHeightSampler(baked);

console.log(`baked ${RES}x${RES} over ${SIZE} m: ${baked.filled} real cells, ` +
    `min ${baked.min.toFixed(1)} max ${baked.max.toFixed(1)}`);

check("glb present", existsSync(GLB));
check("spikes clamped away", baked.min >= -8.001 && baked.max <= 30.001,
    `min ${baked.min} max ${baked.max}`);

// Sample height along the pond axis (toward the shore, -z from centre).
const H = (dist) => heightAt(POND_CENTER_X, POND_CENTER_Z - dist); // dist m from centre toward shore
const centre = H(0), rim = H(POND_RADIUS), mid = H(POND_RADIUS / 2), land = H(POND_RADIUS + 15);

console.log(`centre ${centre.toFixed(2)}  mid ${mid.toFixed(2)}  rim ${rim.toFixed(2)}  land+15 ${land.toFixed(2)} (m, water at ${WATERLINE_Z})`);

check("pond floor is below the waterline", centre < WATERLINE_Z - 0.5,
    `centre ${centre.toFixed(2)}`);
check("it deepens from rim to centre", centre < mid && mid < rim,
    `centre ${centre.toFixed(2)} mid ${mid.toFixed(2)} rim ${rim.toFixed(2)}`);
check("the shore rises to about the waterline at the rim", Math.abs(rim - WATERLINE_Z) < 2.0,
    `rim ${rim.toFixed(2)}`);
check("the land past the rim sits above water", land > WATERLINE_Z - 0.5,
    `land+15 ${land.toFixed(2)}`);

// The walkable strip (world z 0..25, |x|<35) must be sane ground, not a pit or
// a wall — heights within a metre or two of the waterline.
let wMin = Infinity, wMax = -Infinity;
for (let z = 1; z <= 24; z += 2) for (let x = -34; x <= 34; x += 4) {
    const h = heightAt(x, WATERLINE_Z + z);
    wMin = Math.min(wMin, h); wMax = Math.max(wMax, h);
}
check("the walkable strip is sane ground", wMin > -3 && wMax < 8,
    `strip heights ${wMin.toFixed(2)}..${wMax.toFixed(2)}`);

if (failures) {
    console.log(`\n${failures} failure(s) — the terrain mesh is NOT yet ground-ready.`);
    console.log("What a bakeable ground needs: a single-layer surface (no overlapping");
    console.log("cavity geometry), the pond as depressed vertices rather than a carved");
    console.log("hole, a consistent shore around the whole rim, and the walkable strip");
    console.log("at world z 0..25 sitting near the waterline. Retopo the centre flat.");
} else {
    console.log("\nall good — the terrain bakes to a clean pond+shore; safe to wire as ground.");
}
process.exit(failures ? 1 : 0);
