// The shore: a stretch of lake coast with a few places worth crouching down at.
//
// One scene, two framings. Standing back you see the whole shore and three rings
// marking spots you can sift; click one and the camera moves in and down until
// you are crouched over it, which is the scene the rest of this project is about.
//
// Only the spot you are at has physics bodies. The others are their baked beds
// drawn as plain instances — the stones are all still there to look at, they just
// are not being simulated. That is what makes more spots cheap: 540 dynamic
// bodies cost about 4.6 ms a substep whether or not anything is touching them,
// and the same stones as scenery cost none of it.
//
// Swapping a spot between the two is just spawning the bed the other way, which
// takes about 30 ms — comfortably inside one frame of a transition that lasts
// about a second, so there is nothing to hide behind a loading screen.

import { Color3, MeshBuilder, StandardMaterial, Vector3 } from "@babylonjs/core";
import { captureBed, spawnBed, spawnBedVisual } from "./bed.js";
import { clearField } from "./field.js";
import { U } from "./config.js";
import { mulberry32 } from "./noise.js";

// AUDIT #A6 (docs/04 "no Math.random anywhere in the sim"): reshuffles draw
// from a seeded stream so the sequence of beds a player digs through is
// replayable. The daily seed threads in here when the game wires up.
const reshuffleRand = mulberry32(7331);

/** Where you can crouch down, in metres along the shore. */
export const SPOTS = [
  { id: "west", x: -2.6, z: 0.15 },
  { id: "middle", x: 0.1, z: -0.35 },
  { id: "east", x: 2.5, z: 0.25 },
];

// Where the bucket stands relative to its spot, in metres. Off to one side and
// slightly nearer the camera: far enough not to be in the bed, close enough to
// stay in frame when crouched.
const BUCKET_OFFSET = { x: 0.46, z: -0.2 };

const MARKER_RADIUS = 0.62;   // metres
const TRANSITION_SECONDS = 1.1;

// Standing back from the water, and crouched over one spot.
const STANDING = { alpha: -Math.PI / 2, beta: 1.05, radius: 6.4, height: 0.0 };
const CROUCHED = { alpha: -Math.PI / 2, beta: 0.58, radius: 1.05 };

const smoothstep = (t) => t * t * (3 - 2 * t);

export function createShore(scene, camera, { archetypes, beds, bucket, onModeChange }) {
  const markerMat = new StandardMaterial("markerMat", scene);
  markerMat.disableLighting = true;
  markerMat.emissiveColor = new Color3(1, 0.94, 0.78);
  markerMat.alpha = 0.22;

  const hotMat = markerMat.clone("markerHotMat");
  hotMat.alpha = 0.55;

  // Each spot owns a bed and is in exactly one of two states.
  const spots = SPOTS.map((spot, i) => {
    const origin = new Vector3(spot.x * U, 0, spot.z * U);
    const marker = MeshBuilder.CreateTorus(`marker_${spot.id}`, {
      diameter: MARKER_RADIUS * 2 * U, thickness: 0.012 * U, tessellation: 64,
    }, scene);
    marker.position.copyFrom(origin);
    marker.position.y = 0.006 * U;
    marker.material = markerMat;
    marker.metadata = { spotIndex: i };

    if (bucket) {
      bucket.place(new Vector3(
        (spot.x + BUCKET_OFFSET.x) * U, 0, (spot.z + BUCKET_OFFSET.z) * U
      ));
    }

    return {
      ...spot, origin, marker,
      bed: beds[i % beds.length],
      still: null,  // instances, when not being sifted
      rocks: null,  // bodies, when it is
    };
  });

  let active = null;              // the spot being sifted, or null
  let tween = null;               // { from, to, t }
  const target = new Vector3();

  function framing(spot) {
    return spot
      ? { ...CROUCHED, target: spot.origin.clone() }
      : { ...STANDING, target: new Vector3(0, STANDING.height, 0) };
  }

  function startTween(to) {
    tween = {
      from: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() },
      to, t: 0,
    };
  }

  /** Draw the bed but do not simulate it. */
  function makeStill(spot) {
    if (spot.still) return;
    spot.still = spawnBedVisual(scene, archetypes, spot.bed, { origin: spot.origin });
  }

  function clearStill(spot) {
    if (!spot.still) return;
    for (const n of spot.still) n.dispose();
    spot.still = null;
  }

  for (const spot of spots) makeStill(spot);

  // Start stood back, looking at the whole shore.
  const standing = framing(null);
  camera.alpha = standing.alpha;
  camera.beta = standing.beta;
  camera.radius = standing.radius * U;
  camera.target.copyFrom(standing.target);

  return {
    spots,
    get active() { return active; },
    get isMoving() { return tween !== null; },

    /** The spot under the pointer, or null. Markers are the only things picked. */
    spotAt(x, y) {
      const hit = scene.pick(x, y, (m) => m.metadata?.spotIndex !== undefined, false, camera);
      const i = hit?.pickedMesh?.metadata?.spotIndex;
      return i === undefined ? null : spots[i];
    },

    hover(spot) {
      for (const s of spots) s.marker.material = s === spot ? hotMat : markerMat;
    },

    /** Crouch down at a spot: its bed becomes real, everything else stays scenery. */
    enter(spot) {
      if (active || tween) return;
      clearStill(spot);
      spot.rocks = spawnBed(scene, archetypes, spot.bed, { origin: spot.origin });
      for (const s of spots) s.marker.setEnabled(false);
      active = spot;
      startTween(framing(spot));
      onModeChange?.("sift", spot);
    },

    /**
     * Swap the current spot for a different baked bed. The pristine variants are
     * kept, so this undoes any digging rather than re-pouring — which would cost
     * three seconds for a result already sitting in a file.
     */
    reshuffle() {
      if (!active || tween || beds.length < 2) return;
      const spot = active;
      const others = beds.filter((b) => b !== spot.bed);
      spot.bed = others[Math.floor(reshuffleRand() * others.length)] ?? beds[0];
      clearField(spot.rocks);
      spot.rocks = spawnBed(scene, archetypes, spot.bed, { origin: spot.origin });
    },

    /**
     * Stand back up. The spot keeps whatever arrangement it was left in — the
     * live bed is read back out and becomes the scenery version, so a shore you
     * have dug through stays dug through.
     */
    leave() {
      if (!active || tween) return;
      const spot = active;
      spot.bed = captureBed(spot.rocks, archetypes, spot.origin);
      clearField(spot.rocks);
      spot.rocks = null;
      makeStill(spot);
      for (const s of spots) s.marker.setEnabled(true);
      active = null;
      startTween(framing(null));
      onModeChange?.("shore", null);
    },

    update(dt) {
      if (!tween) return;
      tween.t = Math.min(1, tween.t + dt / TRANSITION_SECONDS);
      const k = smoothstep(tween.t);
      camera.alpha = tween.from.alpha + (tween.to.alpha - tween.from.alpha) * k;
      camera.beta = tween.from.beta + (tween.to.beta - tween.from.beta) * k;
      camera.radius = tween.from.radius + (tween.to.radius * U - tween.from.radius) * k;
      Vector3.LerpToRef(tween.from.target, tween.to.target, k, target);
      // Mutated in place, NOT via setTarget: on an ArcRotateCamera setTarget
      // rebuilds alpha, beta and radius from the camera's current position, so
      // it would immediately undo the three lines above and the move would
      // scramble instead of easing.
      camera.target.copyFrom(target);
      if (tween.t >= 1) tween = null;
    },
  };
}
