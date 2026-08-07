// TERRAIN READINESS GATE — is pond.0.glb's Landscape clean enough to be the
// world's ground? Bakes it (draco-decoded) through shared/glbHeightfield with
// the world's ENV_OFFSET, no GPU, and asserts the grid describes a pond with a
// shore: floor below the waterline, deepening from rim to centre, rim near the
// waterline, walkable strip sane, and no C4D spikes.
//
// NOT in `npm test` on purpose: the world is still being authored, and this
// gates the ASSET, not the code. Run it after each terrain re-export
// (`npm run test:glbterrain`); green means the mesh bakes to a clean pond+shore
// and is safe to wire as the ground.
//
// As of 2026-08-07 the current Landscape PASSES: a clean depression, floor
// ~-6 m, shore rising through the waterline to ~+2 m land. (An earlier version
// of this gate reported it "not ready" with ±80 m spikes — that was a parser
// bug here: the decoded glb interleaves position/normal/uv at byteStride 32 and
// the reader below now de-interleaves. There were never any spikes.)

import { readFileSync, existsSync, statSync } from "node:fs";
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
// pipeline pins), then read the JSON + bin for the Landscape mesh. Cached on
// the source's mtime — the decode is slow (npx cold start + draco), and this is
// a gate meant to be re-run after every terrain export, so only re-decode when
// the glb has actually changed.
const decoded = join(tmpdir(), "pond.hf-check.glb");
const fresh = existsSync(decoded) &&
    statSync(decoded).mtimeMs >= statSync(GLB).mtimeMs;
if (!fresh) {
    execFileSync("npx", ["--yes", "@gltf-transform/cli@4.4.2", "copy", GLB, decoded], {
        stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32",
    });
}
const buf = readFileSync(decoded);
const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
const bin = 20 + buf.readUInt32LE(12) + 8;
// Honour bufferView.byteStride: the decoded glb INTERLEAVES position/normal/uv
// (stride 32), so a tightly-packed read walks into the wrong bytes and invents
// spikes. De-interleave to a tight typed array.
const dv = new DataView(buf.buffer, buf.byteOffset);
const acc = (i) => {
    const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView];
    const base = bin + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const comps = { SCALAR: 1, VEC3: 3 }[a.type];
    const f32 = a.componentType === 5126, u32 = a.componentType === 5125;
    const compBytes = f32 || u32 ? 4 : 2;
    const stride = bv.byteStride || comps * compBytes;
    const out = f32 ? new Float32Array(a.count * comps)
        : u32 ? new Uint32Array(a.count * comps)
        : new Uint16Array(a.count * comps);
    for (let e = 0; e < a.count; e++) {
        for (let c = 0; c < comps; c++) {
            const off = base + e * stride + c * compBytes;
            out[e * comps + c] = f32 ? dv.getFloat32(off, true)
                : u32 ? dv.getUint32(off, true) : dv.getUint16(off, true);
        }
    }
    return out;
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
    // clampLo well below the real basin (~-13 m world) so it only catches insane
    // spikes, never the legitimate pond floor.
    size: SIZE, res: RES, clampLo: -20, clampHi: 30,
});
const { heightAt } = makeHeightSampler(baked);

console.log(`baked ${RES}x${RES} over ${SIZE} m: ${baked.filled} real cells, ` +
    `min ${baked.min.toFixed(1)} max ${baked.max.toFixed(1)}`);

check("glb present", existsSync(GLB));
// A clean pond sits well inside the clamp band; values pinned AT a clamp bound
// are the signature of a real spike being cut off. The authored basin reaches
// ~-13 m and the shore ~+2.5 m, both clear of the [-20, 30] clamps.
check("no spikes (nothing pinned at the clamp bounds)",
    baked.min > -19.5 && baked.max < 25,
    `min ${baked.min.toFixed(1)} max ${baked.max.toFixed(1)}`);

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

// The walkable strip is on the LAND side of the waterline — shoreDistance 0..25,
// which along the near axis is world z from 0 down to -25 (the pond centre is at
// +z, so landward is -z). It must be sane ground near the waterline, not a pit
// or a wall.
let wMin = Infinity, wMax = -Infinity;
for (let z = -1; z >= -24; z -= 2) for (let x = -34; x <= 34; x += 4) {
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
