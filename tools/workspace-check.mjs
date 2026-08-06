// node tools/workspace-check.mjs
//
// Guards the workspace invariants. Every one of these has already been violated
// once, and each violation was silent — the labs kept building and the tests kept
// passing while two copies of Babylon loaded into one process.
//
// The rules:
//
//   1. Every lab with a package.json is declared in the root `workspaces`.
//      A lab left out installs into its own node_modules and gets its own copy
//      of every shared dependency.
//   2. No lab carries a package-lock.json. A workspace has exactly one, at the
//      root; a stray child lockfile means somebody ran `npm install` inside a
//      lab, which is what creates the nested tree.
//   3. Every lab that declares a @babylonjs/* package agrees on the version.
//      npm will not hoist conflicting versions — it nests them — so a single
//      disagreement silently rebuilds the duplicate-copy problem.
//   4. Babylon versions are pinned EXACTLY, no caret. The caret is how the labs
//      drifted apart unnoticed in the first place, and how a fresh install of
//      ^9.18.0 resolved 9.20.0.
//   5. No script tells anyone to install inside a lab.
//
// Rule 3 is the one that actually bit: sand-sim (9.18) imports rock-forge source
// (8.56), Node resolved each from its own nearest node_modules, and the two
// Scene classes failed instanceof against each other.

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const rootPkg = readJson(join(root, 'package.json'));

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

/** Directories that hold a package.json, i.e. everything npm could treat as a package. */
const labDirs = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' &&
    e.name !== 'dist' && existsSync(join(root, e.name, 'package.json')))
  .map((e) => e.name)
  .sort();

const declared = rootPkg.workspaces || [];

test('every lab with a package.json is a declared workspace', () => {
  const undeclared = labDirs.filter((d) => !declared.includes(d));
  assert.deepEqual(
    undeclared, [],
    `not in root "workspaces": ${undeclared.join(', ')}. An undeclared lab installs ` +
    `its own node_modules and gets its own copy of every shared dependency.`
  );
});

test('no declared workspace is missing from disk', () => {
  const ghosts = declared.filter((d) => !existsSync(join(root, d, 'package.json')));
  assert.deepEqual(ghosts, [], `declared but absent: ${ghosts.join(', ')}`);
});

test('exactly one lockfile, at the root', () => {
  const strays = labDirs.filter((d) => existsSync(join(root, d, 'package-lock.json')));
  assert.deepEqual(
    strays, [],
    `stray lockfile(s) in ${strays.join(', ')} — somebody ran \`npm install\` inside ` +
    `a lab. Delete them and install from the root.`
  );
  assert.ok(existsSync(join(root, 'package-lock.json')), 'root package-lock.json is missing');
});

/* --- Babylon version agreement, the rule that actually bit ----------------- */

const babylonVersions = new Map();   // package -> Map(version -> [labs])
for (const dir of ['.', ...labDirs]) {
  const pkg = readJson(join(root, dir, 'package.json'));
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[section] || {})) {
      if (!name.startsWith('@babylonjs/')) continue;
      if (!babylonVersions.has(name)) babylonVersions.set(name, new Map());
      const byVer = babylonVersions.get(name);
      if (!byVer.has(range)) byVer.set(range, []);
      byVer.get(range).push(dir);
    }
  }
}

test('all labs agree on every @babylonjs/* version', () => {
  const split = [...babylonVersions.entries()].filter(([, byVer]) => byVer.size > 1);
  assert.deepEqual(
    split.map(([n]) => n), [],
    split.map(([name, byVer]) =>
      `${name} is split: ` +
      [...byVer.entries()].map(([v, labs]) => `${v} (${labs.join(', ')})`).join(' vs ')
    ).join('; ')
  );
});

test('@babylonjs/* versions are pinned exactly (no caret)', () => {
  const loose = [];
  for (const [name, byVer] of babylonVersions)
    for (const [range, labs] of byVer)
      if (/^[\^~]/.test(range)) loose.push(`${name}@${range} in ${labs.join(', ')}`);
  assert.deepEqual(
    loose, [],
    `unpinned: ${loose.join('; ')}. A caret is how the labs drifted to 8.56 vs 9.18, ` +
    `and how a fresh install of ^9.18.0 resolved 9.20.0.`
  );
});

/* --- nobody should be told to install inside a lab ------------------------- */

test('no script installs inside a lab', () => {
  const bad = Object.entries(rootPkg.scripts || {})
    .filter(([, cmd]) => /--prefix\s+\S+\s+(install|ci)\b/.test(cmd) || /--prefix\s+\S+\s+i\b/.test(cmd))
    .map(([k]) => k);
  assert.deepEqual(
    bad, [],
    `script(s) ${bad.join(', ')} install into a lab, which creates a nested ` +
    `node_modules. One install at the root covers every workspace.`
  );
});

/* --- and if node_modules exists, prove the hoist actually happened --------- */

if (existsSync(join(root, 'node_modules'))) {
  test('Babylon is installed exactly once', () => {
    const copies = ['.', ...labDirs]
      .filter((d) => existsSync(join(root, d, 'node_modules', '@babylonjs', 'core')))
      .map((d) => (d === '.' ? '<root>' : d));
    assert.deepEqual(
      copies, ['<root>'],
      `@babylonjs/core is installed in: ${copies.join(', ')}. More than one copy means ` +
      `cross-lab imports resolve to different Scene classes.`
    );
  });
}

console.log(`\nworkspace: ${passed} passed`);
