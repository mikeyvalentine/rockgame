// Does the pond world export still match what scene/worldEnv.js aligns it by?
// Pure node — the GLB's JSON chunk off disk, no Babylon, no draco decode
// (node transforms and accessor bounds live in the JSON; only the vertex data
// is compressed).
//
// worldEnv.js positions the whole export with ONE translation, derived from
// three measured facts in worldEnvParams.js: where the export keeps its water
// surface, the radius of its pond disc, and its landscape's half-extent. A
// re-export from C4D that moves any of those silently sinks the world or
// floats it — this holds the file to them, and holds the vendored draco
// decoder in place, since without it the load dies at runtime with the GLB
// untouched.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    GLB_WATER_Y, GLB_POND_RADIUS, GLB_HALF_EXTENT, ENV_OFFSET,
    ENV_URL, DRACO_FILES,
} from "../src/scene/worldEnvParams.js";
import { POND_RADIUS, SHORE_DEPTH, POND_CENTER_Z } from "../../shared/worldBounds.js";
import { WATER_LEVEL_Y } from "../../shared/shoreRamp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = join(ROOT, "public");

let failures = 0;
function check(name, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + name + (ok || !detail ? "" : " — " + detail));
    if (!ok) failures++;
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// The file, and the decoder it cannot load without
// ---------------------------------------------------------------------------

const glbPath = join(PUBLIC, ...ENV_URL.split("/").filter(Boolean));
check("world export exists at " + ENV_URL, existsSync(glbPath));
for (const f of DRACO_FILES) {
    check("draco file vendored: " + f, existsSync(join(PUBLIC, ...f.split("/").filter(Boolean))));
}
if (failures) { process.exit(1); }

const buf = readFileSync(glbPath);
check("GLB magic", buf.readUInt32LE(0) === 0x46546c67);
const gltf = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));

// ---------------------------------------------------------------------------
// Required extensions are exactly the ones the loader is configured for
// ---------------------------------------------------------------------------

const SUPPORTED = new Set(["EXT_texture_webp", "KHR_draco_mesh_compression"]);
for (const ext of gltf.extensionsRequired ?? []) {
    check("required extension supported: " + ext, SUPPORTED.has(ext));
}

// ---------------------------------------------------------------------------
// The measured facts the alignment is derived from
// ---------------------------------------------------------------------------

const { nodes = [], meshes = [], accessors = [] } = gltf;
const boundsOf = (name) => {
    const mesh = meshes.find((m) => m.name === name);
    const a = accessors[mesh?.primitives?.[0]?.attributes?.POSITION];
    return a?.min && a?.max ? { min: a.min, max: a.max } : null;
};

const waterNode = nodes.find((n) => n.name === "water");
check("water node present", !!waterNode);
check(
    "water surface at GLB_WATER_Y",
    !!waterNode && near(waterNode.translation?.[1] ?? 0, GLB_WATER_Y),
    `node y=${waterNode?.translation?.[1]} vs ${GLB_WATER_Y}`
);

const water = boundsOf("water");
check("water disc radius = GLB_POND_RADIUS", !!water &&
    near(-water.min[0], GLB_POND_RADIUS) && near(water.max[0], GLB_POND_RADIUS) &&
    near(-water.min[2], GLB_POND_RADIUS) && near(water.max[2], GLB_POND_RADIUS),
    water && `x ${water.min[0]}..${water.max[0]}, z ${water.min[2]}..${water.max[2]}`);
check("water disc is flat", !!water && near(water.min[1], water.max[1]));

const land = boundsOf("Landscape");
check("Landscape present with bounds", !!land);
check("Landscape half-extent = GLB_HALF_EXTENT", !!land &&
    near(-land.min[0], GLB_HALF_EXTENT, 0.01) && near(land.max[0], GLB_HALF_EXTENT, 0.01) &&
    near(-land.min[2], GLB_HALF_EXTENT, 0.01) && near(land.max[2], GLB_HALF_EXTENT, 0.01),
    land && `x ${land.min[0]}..${land.max[0]}, z ${land.min[2]}..${land.max[2]}`);

// ---------------------------------------------------------------------------
// The derived alignment: pond onto pond, water onto waterline
// ---------------------------------------------------------------------------

check("GLB pond radius matches the world's", near(GLB_POND_RADIUS, POND_RADIUS));
check(
    "GLB landscape reaches exactly the shore's back edge",
    near(GLB_HALF_EXTENT, POND_RADIUS + SHORE_DEPTH)
);
check("offset lands water on the waterline", near(ENV_OFFSET.y + GLB_WATER_Y, WATER_LEVEL_Y));
check("offset lands pond centre on pond centre", near(ENV_OFFSET.z, POND_CENTER_Z));

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
