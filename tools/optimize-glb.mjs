#!/usr/bin/env node
// optimize-glb.mjs — shrink a raw DCC-exported GLB (e.g. a Cinema 4D world env)
// into a web-ready asset. Built for the pond.0 world drop, but general.
//
//   node tools/optimize-glb.mjs <input.glb> <output.glb> [options]
//
//   --tex <px>        max texture edge, downscaled to fit (default 1024)
//   --color-q <n>     WebP quality for color/base maps (default 85)
//   --normal-q <n>    WebP quality for normal maps       (default 92)
//   --keep-temp       leave the intermediate *.glb files next to the output
//
// Why this exists instead of a plain `gltf-transform` one-liner:
//
//  1. The real weight in these exports is DUPLICATED GEOMETRY, not textures.
//     C4D scatters (hundreds of identical shrubs/trees/boulders) come out as
//     separate meshes holding full copies of f32 vertex data. `dedup` +
//     `instance` (EXT_mesh_gpu_instancing) collapse them — on pond.0 that step
//     alone did 1.27 GB -> 170 MB. Draco is almost an afterthought here.
//
//  2. The gltf-transform CLI's BUNDLED sharp/libvips chokes on the ICC profiles
//     C4D embeds in its PNGs ("VipsInterpretation 32 / space not set"), so its
//     `resize`/`webp` commands abort. We do the texture pass ourselves with a
//     directly-installed sharp (0.35+), which reads them fine. The geometry
//     steps don't touch sharp, so we still run those via the CLI.
//
// Deps (devDependencies): sharp, @gltf-transform/core, @gltf-transform/extensions.
// The geometry steps shell out to `npx @gltf-transform/cli` (pinned below).

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';

const CLI = '@gltf-transform/cli@4.4.2'; // keep in sync with sharp/core in package.json

// ---- args -------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (flag, def) => {
  const i = argv.indexOf(flag);
  return i === -1 ? def : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--keep-temp'));
const [input, output] = positional;
if (!input || !output) {
  console.error('usage: node tools/optimize-glb.mjs <input.glb> <output.glb> [--tex 1024] [--color-q 85] [--normal-q 92] [--keep-temp]');
  process.exit(1);
}
if (!existsSync(input)) { console.error(`input not found: ${input}`); process.exit(1); }
const MAX = Number(opt('--tex', 1024));
const COLOR_Q = Number(opt('--color-q', 85));
const NORMAL_Q = Number(opt('--normal-q', 92));
const KEEP = argv.includes('--keep-temp');

const outDir = dirname(output);
const stem = basename(output).replace(/\.glb$/i, '');
const tmp = (n) => join(outDir, `${stem}.__${n}.glb`);
const mb = (p) => (statSync(p).size / 1048576).toFixed(2) + ' MB';
const temps = [];

function gt(args, label) {
  // Big exports need headroom; the CLI otherwise OOMs on the vertex buffers.
  execFileSync('npx', ['--yes', CLI, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=12288' },
    shell: process.platform === 'win32', // npx.cmd on Windows
  });
  if (label) console.log(`  ${label.padEnd(9)} ${mb(args[args.length - 1])}`);
}

// ---- geometry (CLI; no sharp involved) --------------------------------
console.log(`input      ${mb(input)}`);
const dedup = tmp('dedup'); temps.push(dedup);
gt(['dedup', input, dedup], 'dedup');            // collapse duplicated meshes + textures
const inst = tmp('inst'); temps.push(inst);
gt(['instance', dedup, inst], 'instance');       // repeated nodes -> GPU instances
const weld = tmp('weld'); temps.push(weld);
gt(['weld', inst, weld], 'weld');                // merge coincident verts

// ---- textures (our sharp; CLI's bundled one can't read C4D ICC PNGs) ---
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(weld);
const root = doc.getRoot();
const normals = new Set();
for (const m of root.listMaterials()) { const n = m.getNormalTexture(); if (n) normals.add(n); }
doc.createExtension(EXTTextureWebP).setRequired(true);

let before = 0, after = 0;
for (const tex of root.listTextures()) {
  const img = tex.getImage(); if (!img) continue;
  const buf = Buffer.from(img);
  before += buf.length;
  const isNormal = normals.has(tex);
  const out = await sharp(buf, { failOn: 'none' })
    .resize(MAX, MAX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: isNormal ? NORMAL_Q : COLOR_Q, effort: 5 })
    .toBuffer();
  tex.setImage(out).setMimeType('image/webp'); // strips the ICC profile too
  after += out.length;
}
const texGlb = tmp('tex'); temps.push(texGlb);
await io.write(texGlb, doc);
console.log(`  textures  ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(2)} MB (webp, max ${MAX}px)`);

// ---- finish (CLI) -----------------------------------------------------
const pruned = tmp('prune'); temps.push(pruned);
gt(['prune', texGlb, pruned], 'prune');
gt(['draco', pruned, output], 'draco');

console.log(`\nFINAL      ${mb(output)}   ${output}`);

// validate; surface any structural errors
try {
  execFileSync('npx', ['--yes', CLI, 'validate', output], { stdio: 'inherit', shell: process.platform === 'win32' });
} catch { /* validate prints its own report */ }

if (!KEEP) for (const f of temps) { try { rmSync(f); } catch {} }
