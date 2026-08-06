// node tools/pinned-cdn-check.mjs
//
// Every third-party script a page loads at runtime must name an exact version,
// and Babylon's must be the SAME version the workspace resolves.
//
// Two separate failures this exists to prevent, both of which had already
// happened:
//
//   1. `cdn.babylonjs.com/babylon.js` serves *latest*. Two pages loaded it, so
//      their behaviour could change overnight with no commit — in a project whose
//      leaderboard rests on "identical inputs, identical results", and whose
//      physics is deliberately fixed-timestep for exactly that reason.
//   2. Even pinned, a hand-written URL drifts from the version the rest of the
//      repo installs. The labs had already split across Babylon 8.56 and 9.18
//      without anyone deciding to.
//
// So this asserts both: pinned, and pinned to the resolved workspace version.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pages that load Babylon from a CDN rather than through a bundler. */
// Was two: the solver demo had its own copy of this script tag until the two
// labs were collapsed into one page.
const PAGES = [
  'babylon-water/index.html',
];

/** The version of record: whatever the workspace root declares. */
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const declared = (rootPkg.dependencies || {})['@babylonjs/core'];
assert.ok(declared, 'root package.json must declare @babylonjs/core');
const wanted = declared.replace(/^[\^~]/, '');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

/**
 * Remote script URLs a page actually LOADS.
 *
 * Deliberately parsed out of `src` attributes rather than grepped for over the
 * raw file: the pages carry comments explaining what they used to load and why,
 * and a naive text search fails on its own documentation.
 */
const remoteScriptSrcs = (html) =>
  [...html.matchAll(/<script[^>]+\bsrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);

for (const page of PAGES) {
  const html = readFileSync(join(root, page), 'utf8');
  const srcs = remoteScriptSrcs(html);

  test(`${page} loads no unpinned Babylon`, () => {
    assert.ok(
      !srcs.some((u) => /cdn\.babylonjs\.com/.test(u)),
      `${page} loads cdn.babylonjs.com, which serves *latest*. Pin an exact ` +
      `version: https://cdn.jsdelivr.net/npm/babylonjs@${wanted}/babylon.js`
    );
  });

  test(`${page} pins Babylon to ${wanted}`, () => {
    const m = srcs.join(' ').match(/babylonjs@([0-9]+\.[0-9]+\.[0-9]+)\/babylon\.js/);
    assert.ok(m, `${page} has no pinned babylonjs@<version>/babylon.js script tag`);
    assert.equal(
      m[1], wanted,
      `${page} pins Babylon ${m[1]} but the workspace resolves ${wanted}. ` +
      `These must match, or the standalone pages run different engine code ` +
      `from the bundled labs.`
    );
  });

  // A pinned URL is only worth having if nothing else on the page is unpinned.
  test(`${page} has no other floating CDN script`, () => {
    const floating = srcs.filter((u) => !/@[0-9]+\.[0-9]+\.[0-9]+\//.test(u));
    assert.deepEqual(
      floating, [],
      `unpinned third-party script(s): ${floating.join(', ')}`
    );
  });
}

console.log(`\npinned-cdn: ${passed} passed`);
