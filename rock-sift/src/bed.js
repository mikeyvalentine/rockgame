// Reading and writing a settled bed.
//
// A bed that has come to rest is just a list of transforms, and nothing about it
// varies once it has settled — so simulating the pour on the player's machine
// pays, every launch, for an answer that never changes. It is poured once by
// tools/bake-bed.mjs and shipped.
//
// Measured on a 540-stone bed: settling costs 3440 ms, placing stones at stored
// transforms costs 28 ms, and the restored bed drifts 0.00 mm. See
// tools/bake-bench.mjs.
//
// The format is deliberately small and dull. Positions quantise into the bed's
// own bounding box at 16 bits an axis — about 0.03 mm over a 2 m bed — and each
// quaternion component into 16 bits, which is far finer than a stone's silhouette
// can show. 15 bytes a stone, so 5000 stones is 73 KB.
//
// The archetype NAMES are stored, not just indices. If the source GLB is ever
// reordered or replaced, a bed keyed on indices would silently map every stone to
// the wrong shape — every collider mismatched, and nothing to say why. Names make
// that a loud failure instead.
//
// This file is DOM-free and engine-agnostic apart from `spawnBed`, so the baker
// and the browser share one implementation of the format.

import { Quaternion, Vector3 } from "@babylonjs/core";
import { addRock } from "./field.js";
import { MAGIC, VERSION, HEADER_BYTES, STONE_BYTES, decodeBed } from "../../shared/bedFormat.js";

// The format itself is canonical in shared/bedFormat.js — sand-sim reads beds
// too, and it cannot import anything from here that drags Babylon 8 with it.
// Re-exported so this module stays the one import site for rock-sift.
export { decodeBed };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * @param rocks      as returned by pourAndSettle
 * @param archetypes the archetype list those rocks index into
 * @returns ArrayBuffer
 */
export function encodeBed(rocks, archetypes) {
  const names = archetypes.map((a) => a.mesh.name);
  const encoder = new TextEncoder();
  const nameBytes = names.map((n) => encoder.encode(n));
  const tableBytes = nameBytes.reduce((n, b) => n + 2 + b.length, 0);

  // Bounding box of the bed, with any degenerate axis given a little room so the
  // quantisation never divides by zero.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const r of rocks) {
    const p = [r.node.position.x, r.node.position.y, r.node.position.z];
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  for (let k = 0; k < 3; k++) {
    if (!(max[k] > min[k])) { min[k] -= 0.5; max[k] += 0.5; }
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + tableBytes + rocks.length * STONE_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC);
  view.setUint16(4, VERSION);
  view.setUint16(6, archetypes.length);
  view.setUint32(8, rocks.length);
  for (let k = 0; k < 3; k++) {
    view.setFloat32(12 + k * 4, min[k]);
    view.setFloat32(24 + k * 4, max[k]);
  }

  let at = HEADER_BYTES;
  for (const b of nameBytes) {
    view.setUint16(at, b.length);
    at += 2;
    new Uint8Array(buffer, at, b.length).set(b);
    at += b.length;
  }

  const index = new Map(archetypes.map((a, i) => [a, i]));
  for (const r of rocks) {
    view.setUint8(at, index.get(r.arch) ?? 0);
    at += 1;

    const p = r.node.position;
    for (const [k, value] of [p.x, p.y, p.z].entries()) {
      const t = clamp01((value - min[k]) / (max[k] - min[k]));
      view.setUint16(at, Math.round(t * 65535));
      at += 2;
    }

    const q = r.node.rotationQuaternion ?? Quaternion.Identity();
    for (const c of [q.x, q.y, q.z, q.w]) {
      view.setInt16(at, Math.round(Math.max(-1, Math.min(1, c)) * 32767));
      at += 2;
    }
  }
  return buffer;
}

/**
 * Match a bed's stone names to loaded archetypes, loudly.
 *
 * Silently accepting an unknown name gives `undefined` here and a bare
 * "cannot read mesh of undefined" hundreds of stones later, with nothing to say
 * that the real problem is a bed baked against a different model.
 */
function resolveArchetypes(archetypes, bed) {
  const byName = new Map(archetypes.map((a) => [a.mesh.name, a]));
  return bed.names.map((n) => {
    const arch = byName.get(n);
    if (!arch) {
      throw new Error(
        `bed references stone "${n}", which is not in the loaded archetypes. ` +
        `The source model has changed since this bed was baked — re-bake it.`
      );
    }
    return arch;
  });
}

/**
 * Place a decoded bed into the scene.
 *
 * Bodies are created ASLEEP. They are already at rest, so waking them only
 * invites the solver to resolve contacts that are already resolved — which is
 * the difference between a bed that appears settled and one that visibly
 * twitches as the player arrives.
 */
export function spawnBed(scene, archetypes, bed, { asleep = true, origin = null } = {}) {
  const order = resolveArchetypes(archetypes, bed);

  const ox = origin?.x ?? 0, oz = origin?.z ?? 0;
  const position = new Vector3();
  const rocks = [];
  for (let i = 0; i < bed.count; i++) {
    position.set(bed.positions[i * 3] + ox, bed.positions[i * 3 + 1], bed.positions[i * 3 + 2] + oz);
    const q = new Quaternion(
      bed.quaternions[i * 4], bed.quaternions[i * 4 + 1],
      bed.quaternions[i * 4 + 2], bed.quaternions[i * 4 + 3]
    );
    rocks.push(addRock(scene, order[bed.archIndex[i]], position, q, i, asleep));
  }
  return rocks;
}

/**
 * The same bed, drawn but not simulated.
 *
 * A shore has several sifting spots and the player is only ever crouched at one.
 * The rest are scenery: instances at the baked transforms with no physics body
 * at all, which is free — measured, 540 dynamic bodies cost 4.6 ms a substep
 * doing nothing, and this costs none of it.
 */
export function spawnBedVisual(scene, archetypes, bed, { origin = null } = {}) {
  const order = resolveArchetypes(archetypes, bed);
  const ox = origin?.x ?? 0, oz = origin?.z ?? 0;

  const nodes = [];
  for (let i = 0; i < bed.count; i++) {
    const arch = order[bed.archIndex[i]];
    const node = arch.mesh.createInstance(`still_${i}`);
    node.position.set(bed.positions[i * 3] + ox, bed.positions[i * 3 + 1], bed.positions[i * 3 + 2] + oz);
    node.rotationQuaternion = new Quaternion(
      bed.quaternions[i * 4], bed.quaternions[i * 4 + 1],
      bed.quaternions[i * 4 + 2], bed.quaternions[i * 4 + 3]
    );
    node.receiveShadows = true;
    node.isPickable = false;
    node.freezeWorldMatrix();
    nodes.push(node);
  }
  return nodes;
}

/** Read a live bed back out, so a spot keeps the arrangement it was left in. */
export function captureBed(rocks, archetypes, origin = null) {
  const ox = origin?.x ?? 0, oz = origin?.z ?? 0;
  const count = rocks.length;
  const bed = {
    version: VERSION,
    names: archetypes.map((a) => a.mesh.name),
    count,
    archIndex: new Uint8Array(count),
    positions: new Float32Array(count * 3),
    quaternions: new Float32Array(count * 4),
  };
  const index = new Map(archetypes.map((a, i) => [a, i]));
  for (const [i, r] of rocks.entries()) {
    bed.archIndex[i] = index.get(r.arch) ?? 0;
    bed.positions[i * 3] = r.node.position.x - ox;
    bed.positions[i * 3 + 1] = r.node.position.y;
    bed.positions[i * 3 + 2] = r.node.position.z - oz;
    const q = r.node.rotationQuaternion ?? Quaternion.Identity();
    bed.quaternions[i * 4] = q.x;
    bed.quaternions[i * 4 + 1] = q.y;
    bed.quaternions[i * 4 + 2] = q.z;
    bed.quaternions[i * 4 + 3] = q.w;
  }
  return bed;
}

/**
 * Fetch a baked bed, choosing one of the available variants.
 *
 * Several are baked so that not everyone gets the same beach. Pass a `pick` in
 * 0..1 derived from the save — the same save then gets the same shore every time
 * it is loaded, which matters once the player has rearranged it.
 *
 * @returns the decoded bed, or null if there is nothing baked to load
 */
// AUDIT #A6: `pick` is required. It used to default to Math.random(), and a
// silent random default is the worst kind of determinism break — two players
// on the same daily seed sifting different beds. Every real caller already
// passes a pick.
export async function fetchBakedBed(manifestUrl, pick, { expectSource = null } = {}) {
  if (typeof pick !== "number") {
    throw new Error("fetchBakedBed: pass a deterministic pick in [0,1) — the Math.random default is gone (docs/04)");
  }
  const res = await fetch(manifestUrl);
  if (!res.ok) return null;
  const manifest = await res.json();
  if (!manifest.variants?.length) return null;

  // A baked bed is a SNAPSHOT of one cast of stones. Rock generation is not
  // finished and should not have to be: change the seed, the archetype count, or
  // anything inside the forge, and these beds describe stones that no longer exist.
  //
  // Detected here rather than exploding later. `resolveArchetypes` fails loudly on
  // an unknown stone name, which is right when a bed is SUPPOSED to match — but a
  // deliberately changed generator is not a bug, and it should not hard-stop the
  // lab. Returning null lets the caller pour a fresh bed, so iterating on rock
  // generation never requires re-baking first.
  if (expectSource && manifest.world?.source && manifest.world.source !== expectSource) {
    console.warn(
      `Baked beds are stale: built from "${manifest.world.source}", now generating ` +
      `"${expectSource}". Pouring a fresh bed instead — run \`npm run bake\` to make ` +
      `startup quick again once the generator settles.`
    );
    return null;
  }

  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  const chosen = manifest.variants[Math.min(manifest.variants.length - 1,
    Math.floor(clamp01(pick) * manifest.variants.length))];

  const bed = await fetch(base + chosen);
  if (!bed.ok) return null;
  return { ...decodeBed(await bed.arrayBuffer()), variant: chosen };
}
