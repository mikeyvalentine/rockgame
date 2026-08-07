#!/usr/bin/env node
// key-atlas-alpha.mjs — reconstruct the leaf-card alpha the world export lost.
//
//   node tools/key-atlas-alpha.mjs <in.glb> [out.glb]   (out defaults to in)
//
// The C4D → glTF export flattened every branch-atlas texture's opacity onto
// its background: the shipped pond.0.glb has 3-channel atlases, alphaMode
// OPAQUE everywhere, and canopies that draw as solid card silhouettes. The
// raw export is not around to re-do, but the flattening was onto EXACT black
// (measured: 50-56% of atlas pixels are 0,0,0 with a narrow compression ramp
// above it), so the mask is recoverable:
//
//   alpha = ramp of max(r,g,b) over 4..24     — 0 at the backing, 1 by the
//                                               time real bark/leaf colour
//                                               starts (darkest bark ~40+)
//   rgb   = rgb / alpha                       — the flatten premultiplied
//                                               against black; without this
//                                               every leaf keeps a dark rim
//
// A texture is keyed when BOTH signals agree: it is >25% exact-black
// (measured backing) AND every material using it is foliage-named
// (branch/atlas/leaf/shrub). Two signals because neither alone is safe — the
// boulder textures are UV atlases on black gutters, so they read 40-49%
// black without being alpha cards, and keying them would make solid rock
// double-sided and fringe the island edges. A keyed material becomes
// alphaMode MASK (cutoff 0.3) and doubleSided, so the loader needs no
// name-based material surgery. sand-sim's env-glb-check asserts the atlases
// stay MASK from here on, which is what catches a future re-export
// flattening them again.
//
// Same decode → edit → recompress arrangement as optimize-glb.mjs, and for
// the same reason: reading draco needs the CLI, textures need our sharp.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, renameSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";

const CLI = "@gltf-transform/cli@4.4.2"; // keep in sync with optimize-glb.mjs

const [input, outArg] = process.argv.slice(2);
if (!input) {
  console.error("usage: node tools/key-atlas-alpha.mjs <in.glb> [out.glb]");
  process.exit(1);
}
if (!existsSync(input)) { console.error(`input not found: ${input}`); process.exit(1); }
const output = outArg ?? input;

const BLACK_FRACTION = 0.25; // a texture this black-backed may be an atlas
const FOLIAGE = /branch|atlas|leaf|shrub/i; // must also be foliage — see header
const RAMP_LO = 4, RAMP_HI = 24;
const CUTOFF = 0.3;

const outDir = dirname(output);
const stem = basename(output).replace(/\.glb$/i, "");
const tmp = (n) => join(outDir, `${stem}.__${n}.glb`);
const mb = (p) => (statSync(p).size / 1048576).toFixed(2) + " MB";

function gt(args) {
  execFileSync("npx", ["--yes", CLI, ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
}

console.log(`input      ${mb(input)}`);
const decoded = tmp("decoded");
gt(["copy", input, decoded]); // decodes draco on read, writes uncompressed

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(decoded);
const root = doc.getRoot();

// texture -> materials that use it as base colour
const users = new Map();
for (const mat of root.listMaterials()) {
  const tex = mat.getBaseColorTexture();
  if (!tex) continue;
  if (!users.has(tex)) users.set(tex, []);
  users.get(tex).push(mat);
}

let keyed = 0;
for (const [tex, mats] of users) {
  // Both signals: every material on this texture must be foliage-named, and
  // the image must be black-backed. Boulders pass the second, not the first.
  if (!mats.every((m) => FOLIAGE.test(m.getName()))) continue;
  const img = tex.getImage();
  if (!img) continue;
  const { data, info } = await sharp(Buffer.from(img))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let black = 0;
  const n = info.width * info.height;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) black++;
  }
  if (black / n < BLACK_FRACTION) continue;

  for (let i = 0; i < data.length; i += 4) {
    const m = Math.max(data[i], data[i + 1], data[i + 2]);
    const a = m <= RAMP_LO ? 0
      : m >= RAMP_HI ? 255
      : Math.round(((m - RAMP_LO) / (RAMP_HI - RAMP_LO)) * 255);
    if (a > 0 && a < 255) {
      const inv = 255 / a;
      data[i] = Math.min(255, Math.round(data[i] * inv));
      data[i + 1] = Math.min(255, Math.round(data[i + 1] * inv));
      data[i + 2] = Math.min(255, Math.round(data[i + 2] * inv));
    }
    data[i + 3] = a;
  }

  // Bleed the leaf colour outward into the transparent background. The atlas
  // backs onto black, so without this the RGB of every transparent texel is
  // (0,0,0) and bilinear/mip filtering — and the hard alpha-test edge — pull
  // that black into the leaf rims: a dark OUTLINE at rest, and crawling STATIC
  // as the camera moves and the edge samples shift. Dilation replaces the black
  // under the mask with the nearest leaf colour, so the fringe is leaf-on-leaf.
  dilateColor(data, info.width, info.height);

  const webp = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .webp({ quality: 92, effort: 5 })
    .toBuffer();
  tex.setImage(webp).setMimeType("image/webp");
  for (const mat of mats) {
    mat.setAlphaMode("MASK").setAlphaCutoff(CUTOFF).setDoubleSided(true);
  }
  keyed++;
  console.log(`  keyed    ${tex.getName() || mats[0].getName()}  (${(100 * black / n).toFixed(0)}% backing, ${mats.length} material(s))`);
}
if (!keyed) { console.error("nothing looked like a black-backed atlas — refusing to write"); process.exit(1); }

const edited = tmp("edited");
await io.write(edited, doc);
const packed = tmp("packed");
gt(["draco", edited, packed]);

renameSync(packed, output);
for (const f of [decoded, edited]) { try { rmSync(f); } catch {} }
console.log(`\n${keyed} atlas(es) keyed`);
console.log(`FINAL      ${mb(output)}   ${output}`);

/**
 * Bleed opaque colour outward into the transparent background, in place, one
 * pixel ring per pass. RGBA8, alpha untouched — only the RGB under transparent
 * texels is filled, from the nearest solid neighbours, so edge filtering never
 * pulls the black backing into a leaf rim.
 */
function dilateColor(data, w, h, passes = 20) {
  const n = w * h;
  const solid = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (data[p * 4 + 3] >= 8) solid[p] = 1;

  for (let pass = 0; pass < passes; pass++) {
    const filled = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (solid[p]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (!solid[q]) continue;
            r += data[q * 4]; g += data[q * 4 + 1]; b += data[q * 4 + 2]; c++;
          }
        }
        if (c) {
          data[p * 4] = Math.round(r / c);
          data[p * 4 + 1] = Math.round(g / c);
          data[p * 4 + 2] = Math.round(b / c);
          filled.push(p);
        }
      }
    }
    if (!filled.length) break;         // background fully bled — done early
    for (const p of filled) solid[p] = 1; // deferred, so a pass spreads one ring
  }
}
