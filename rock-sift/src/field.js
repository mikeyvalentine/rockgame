// Laying out and settling the bed of stones. Deliberately free of any DOM or
// rendering dependency so tools/settle-test.mjs can run it under NullEngine.

import { PhysicsBody, PhysicsMotionType, Quaternion, Vector3 } from "@babylonjs/core";
import { mulberry32 } from "./noise.js";
import {
  FINAL_STEPS, LAYER_STEPS, POOL_HALF_X, POOL_HALF_Z, SETTLE_DT, SPAWN_GAP, U,
} from "./config.js";

/** Largest distance from the origin over a centred vertex set. */
export function boundingRadius(positions) {
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const d = positions[i] ** 2 + positions[i + 1] ** 2 + positions[i + 2] ** 2;
    if (d > r2) r2 = d;
  }
  return Math.sqrt(r2);
}

/**
 * Move a body without the solver reading the jump as an enormous velocity.
 *
 * The body is handed the new transform directly, rather than via the usual
 * recipe of clearing `disablePreStep`, moving the node, and restoring the flag
 * in `onAfterRender`. That recipe only works if the caller is outside the frame:
 * Babylon steps physics inside `scene.animate()`, which runs *before*
 * `onBeforeRender`, so a teleport issued from `onBeforeRender` has its flag put
 * back before any step ever reads it. The prestep is skipped and the body syncs
 * its old transform straight back over the node — the move silently does not
 * happen. That is what stranded every stone the recovery pass tried to bring
 * back into the dish. Setting it directly works from anywhere.
 */
export function teleport(scene, body, node, position, rotation) {
  node.position.copyFrom(position);
  node.rotationQuaternion = (rotation || Quaternion.Identity()).clone();
  node.computeWorldMatrix(true);

  const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
  const wasDisabled = body.disablePreStep;
  body.disablePreStep = false; // -> PhysicsPrestepType.TELEPORT
  plugin?.setPhysicsBodyTransformation(body, node);
  body.disablePreStep = wasDisabled;

  body.setLinearVelocity(Vector3.Zero());
  body.setAngularVelocity(Vector3.Zero());
}

/**
 * Shelf-pack every stone into a rectangle of half-extents `hx` by `hz`, spilling
 * into further layers once a layer is full. Spacing uses each stone's bounding
 * sphere — a randomly tumbled rock sweeps out its diagonal, not its longest
 * axis, and packing by the latter leaves a third of the bed interpenetrating.
 *
 * The whole field is laid out up front and then poured a *layer* at a time,
 * rather than a fixed-size batch at a time. A batch only ever fills the first
 * couple of rows, so batch pouring drops every stone into the same strip of
 * ground and builds a cone in the middle of the beach. Pouring by layer rains an
 * even sheet over the whole pool each time, which is what makes a field instead
 * of a heap.
 *
 * The pool was a disc until the bed became a single layer; see POOL_HALF_X.
 * A rectangle also drops the per-slot "am I inside the circle" rejection, so a
 * sheet now fills to its own edges rather than to an inscribed circle.
 */
function layOutField(archs, hx, hz) {
  const slots = [];
  let x = -hx, z = -hz, rowMax = 0, layer = 0;
  let i = 0;
  for (let guard = 0; i < archs.length && guard < archs.length * 60; guard++) {
    const r = archs[i].radius * 1.06;
    if (x + 2 * r > hx) { x = -hx; z += 2 * rowMax; rowMax = 0; }
    if (z + 2 * r > hz) { x = -hx; z = -hz; rowMax = 0; layer++; }

    const cx = x + r, cz = z + r;
    x += 2 * r;
    rowMax = Math.max(rowMax, r);

    slots.push({ arch: archs[i], x: cx, z: cz, r, layer });
    i++;
  }
  return slots;
}

/**
 * One stone in the world. `asleep` matters for beds restored from a bake: the
 * stones are already at rest, so waking them only invites the solver to resolve
 * contacts that are already resolved.
 */
export function addRock(scene, arch, position, rotation, index, asleep = false) {
  // Always an instance, never the archetype's own mesh. Using the source as the
  // first stone works fine for one bed and falls apart the moment there is more
  // than one: the source is shared, so whichever bed claimed it owns a stone the
  // others are also drawing instances of, and disposing that bed takes the mesh
  // every other bed is rendering with it. The sources are parked out of sight
  // instead — see parkArchetypeSources.
  const node = arch.mesh.createInstance(`${arch.mesh.name}_i${index}`);
  node.receiveShadows = true;
  node.position.copyFrom(position);
  node.rotationQuaternion = rotation;

  const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, asleep, scene);
  body.shape = arch.shape;
  body.setMassProperties({ mass: arch.metrics.massKgWorld });
  body.setLinearDamping(0.2);
  body.setAngularDamping(0.4);

  const rock = { node, body, arch, unitScale: U };
  node.metadata = { rock };
  return rock;
}

export const pileTopOf = (rocks) =>
  rocks.reduce((top, r) => Math.max(top, r.node.position.y + r.arch.radius), 0);

/**
 * Pour `count` stones in shallow batches, stepping the simulation between each
 * so nothing ever falls more than a few centimetres, and run a final settle.
 * Nothing is rendered during this — the bed is already at rest when it appears.
 *
 * @param onProgress optional async (fraction, label) called between batches
 */
export async function pourAndSettle(scene, archetypes, {
  count, seed, onProgress,
  // How still the bed has to be before settling stops, and how long to keep
  // trying. The defaults are what a runtime pour can afford. Baking is offline
  // and should hand these down hard: a bed left creeping at the default 2 cm/s
  // is still visibly rearranging itself two seconds after it is restored, which
  // is the whole thing baking was meant to avoid.
  restSpeed = 0.02, finalSteps = FINAL_STEPS,
} = {}) {
  const physics = scene.getPhysicsEngine();
  const rng = mulberry32(seed);

  const picks = [];
  for (let i = 0; i < count; i++) {
    picks.push(i < archetypes.length ? archetypes[i] : archetypes[Math.floor(rng() * archetypes.length)]);
  }
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }

  const rocks = [];
  const slots = layOutField(picks, POOL_HALF_X * U, POOL_HALF_Z * U);
  const layers = slots.length ? slots[slots.length - 1].layer + 1 : 0;

  for (let layer = 0; layer < layers; layer++) {
    // Each sheet starts just clear of whatever is already down, so no stone ever
    // falls more than a couple of centimetres however deep the field gets.
    const baseY = Math.max(pileTopOf(rocks), 0) + SPAWN_GAP * U;
    for (const slot of slots) {
      if (slot.layer !== layer) continue;
      rocks.push(addRock(scene, slot.arch, new Vector3(slot.x, baseY + slot.r, slot.z),
        Quaternion.RotationYawPitchRoll(rng() * 6.283, rng() * 6.283, rng() * 6.283),
        rocks.length));
    }
    for (let s = 0; s < LAYER_STEPS; s++) physics._step(SETTLE_DT);
    if (onProgress) await onProgress((layer + 1) / layers, "pouring");
  }

  const v = new Vector3();
  for (let s = 0; s < finalSteps; s++) {
    physics._step(SETTLE_DT);
    if (s % 40 === 0) {
      if (onProgress) await onProgress(1, "settling");
      let fastest = 0;
      for (const r of rocks) {
        r.body.getLinearVelocityToRef(v);
        fastest = Math.max(fastest, v.length());
      }
      if (fastest < restSpeed * U) break;
    }
  }

  return rocks;
}

/**
 * Static instanced stones strewn over the shore around the dish. No physics
 * bodies and no per-frame cost beyond drawing them — they exist because a tiled
 * ground texture is flat no matter how good the normal map is, and the eye reads
 * that as fake immediately. Real geometry breaking the silhouette fixes it.
 */
export function scatterGravel(scene, archetypes, { count, innerRadius, outerRadius, heightAt, origin = null, seed = 4242 }) {
  const rng = mulberry32(seed);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const arch = archetypes[Math.floor(rng() * archetypes.length)];
    // sqrt keeps the density even over the annulus instead of crowding the middle.
    const t = Math.sqrt(rng());
    const r = (innerRadius + (outerRadius - innerRadius) * t) * U;
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r + (origin?.x ?? 0);
    const z = Math.sin(a) * r + (origin?.z ?? 0);

    const node = arch.mesh.createInstance(`gravel_${i}`);
    // Sunk by a random fraction of its own size, so they sit in the ground
    // rather than on it.
    node.position.set(x, heightAt(x, z) - arch.radius * (0.35 + rng() * 0.4), z);
    node.rotationQuaternion = Quaternion.RotationYawPitchRoll(
      rng() * 6.283, rng() * 6.283, rng() * 6.283
    );
    node.receiveShadows = true;
    node.isPickable = false;
    node.freezeWorldMatrix();
    nodes.push(node);
  }
  return nodes;
}

/**
 * Height of the top of the pile near a point, in world units, or 0 (the sand)
 * where there is nothing. Used to keep the sweep riding on whatever is actually
 * under it: held at a fixed height it sails over a lone stone lying on open
 * ground, which is exactly where you most want to be able to nudge one.
 */
export function surfaceTopNear(rocks, x, z, radius) {
  const r2 = radius * radius;
  let top = 0;
  for (const rock of rocks) {
    const p = rock.node.position;
    const dx = p.x - x, dz = p.z - z;
    if (dx * dx + dz * dz > r2) continue;
    const t = p.y + rock.arch.radius;
    if (t > top) top = t;
  }
  return top;
}

export function clearField(rocks) {
  for (const r of rocks) {
    r.body.dispose();
    r.node.dispose();
  }
}

/**
 * Move every archetype's own mesh out of the world.
 *
 * An instance is only drawn if its source mesh is enabled, so the sources have
 * to stay alive and enabled — they just must not be seen. Parked far below the
 * sand they are frustum-culled and cost nothing.
 */
export function parkArchetypeSources(archetypes) {
  for (const arch of archetypes) {
    arch.mesh.position.set(0, -50 * U, 0);
    arch.mesh.isPickable = false;
  }
}
