// "Pick one up and look at it" mode.
//
// The stone is lifted to just in front of the main camera as a child of it. It
// keeps the exact orientation it was lying in, and turns back to that same
// orientation on the way down when you put it back.
//
// There used to be a black alpha plane parked behind the held stone to dim the
// beach. It is gone: a full-screen dark quad fading in behind the stone reads as
// a silhouette dropped over the scene rather than as depth of field. If the
// background ever needs knocking back again, do it with the rendering
// pipeline's depth of field rather than with a plane.

import {
  Color3,
  DirectionalLight,
  Matrix,
  Mesh,
  Quaternion,
  TmpVectors,
  Vector3,
} from "@babylonjs/core";

const FILL_FRACTION = 0.46; // share of the viewport height the stone should occupy
const ROTATE_GAIN = 0.011;  // radians of tumble per pixel dragged
const LIFT_SECONDS = 0.75;  // picking a stone up
const RETURN_SECONDS = 0.6; // putting it back

const smoothstep = (t) => t * t * (3 - 2 * t);

export function createExamineStage(scene, { camera }) {
  // Lights the held stone and nothing else, so it reads clearly against the
  // beach without anything being drawn over the beach.
  const key = new DirectionalLight("examineKey", new Vector3(-0.35, -0.55, 0.75), scene);
  key.intensity = 1.6;
  key.diffuse = new Color3(1.0, 0.97, 0.93);
  // Deliberately left empty until prewarm() fills it in, and never touched
  // again after that. Assigning to includedOnlyMeshes re-hooks the array and
  // marks every mesh the light's membership changed for as dirty — which, the
  // first time a stone was inspected, meant recompiling the shader for the
  // entire bed at once. That is the stall and the flash: a frame or two where
  // the stones have no effect to draw with.
  key.includedOnlyMeshes = [];

  const meshCache = new Map();
  // { rock, mesh, baseDistance, from, to, fromRot, toRot, t, seconds, returning, onDone }
  let held = null;

  function meshFor(arch) {
    let m = meshCache.get(arch);
    if (!m) {
      m = new Mesh(`examine_${arch.mesh.name}`, scene);
      arch.vertexData.applyToMesh(m, false);
      m.material = arch.material;
      m.isPickable = false;
      m.receiveShadows = false;
      m.parent = camera;
      m.setEnabled(false);
      meshCache.set(arch, m);
    }
    return m;
  }

  /**
   * Build every examine mesh and compile its shader up front.
   *
   * Two separate first-use costs are being paid here rather than mid-gesture.
   * One is the light membership above. The other is that an examine mesh is a
   * different shader permutation from the bed stones no matter what — it is not
   * an instance and it does not receive shadows — so its effect has to be
   * compiled the first time one is inspected. Both together are what makes the
   * first click lag and flash.
   *
   * Cheap: the geometry already exists as vertex data, and there are only as
   * many of these as there are archetypes.
   */
  async function prewarm(archetypes) {
    const meshes = archetypes.map(meshFor);
    // Set once, for the life of the scene. The key light lights exactly these
    // and nothing else, whether or not any of them is currently enabled.
    key.includedOnlyMeshes = meshes;

    for (const m of meshes) {
      m.setEnabled(true);
      await m.material.forceCompilationAsync(m);
      m.setEnabled(false);
    }
  }

  /** Distance at which a stone of `size` world units fills FILL_FRACTION of the view. */
  function framingDistance(size) {
    return size / FILL_FRACTION / (2 * Math.tan(camera.fov / 2));
  }

  /**
   * A world pose expressed in the camera's own space.
   *
   * The examine mesh is a child of the camera, so a world pose has to be
   * converted before it can be assigned. Doing that for the *position* is what
   * makes the pick-up read as picking something up — the stone leaves the bed
   * from exactly where it was lying, at true size, and grows as it approaches.
   *
   * Doing it for the *rotation* is what stops the stone snapping. Assigning the
   * world quaternion straight onto a camera-parented mesh, which is what this
   * used to do, leaves the camera's own rotation multiplied in on top: the stone
   * flicked to a different orientation the instant you picked it up, and flicked
   * back when you let go. Babylon composes world = local x parent, so
   * local = world x inverse(parent); doing it on the full matrix gets position
   * and rotation together and cannot get the order wrong.
   */
  function toCameraSpace(worldPosition, worldRotation, outPosition, outRotation) {
    const pose = TmpVectors.Matrix[0];
    const inverse = TmpVectors.Matrix[1];
    Matrix.ComposeToRef(Vector3.OneReadOnly, worldRotation, worldPosition, pose);
    camera.getWorldMatrix().invertToRef(inverse);
    pose.multiplyToRef(inverse, pose);
    pose.decompose(undefined, outRotation, outPosition);
  }

  /** Land a stone that is still on its way back, right now. */
  function finishReturn() {
    if (!held || !held.returning) return;
    held.mesh.setEnabled(false);
    const done = held.onDone;
    held = null;
    done?.();
  }

  function enter(rock) {
    // If the last stone is still flying back, put it down before starting.
    // Otherwise its callback never runs and it stays parked outside the world
    // forever — and if the two share an archetype they also share the mesh.
    finishReturn();

    const mesh = meshFor(rock.arch);
    const size = (Math.max(...rock.arch.metrics.sortedCm) / 100) * rock.unitScale;
    const base = framingDistance(size);

    const from = new Vector3();
    const fromRot = new Quaternion();
    toCameraSpace(
      rock.node.absolutePosition,
      rock.node.rotationQuaternion || Quaternion.Identity(),
      from, fromRot
    );

    mesh.position.copyFrom(from);
    mesh.rotationQuaternion = fromRot.clone();
    mesh.setEnabled(true);
    held = {
      rock, mesh, baseDistance: base,
      from, to: new Vector3(0, 0, base),
      // The lift does not touch the orientation at all: the stone comes up
      // exactly as it was lying.
      fromRot, toRot: fromRot.clone(),
      t: 0, seconds: LIFT_SECONDS, returning: false, onDone: null,
    };
  }

  /**
   * Start putting the stone back. Returns the rock immediately and stops
   * counting as active, so the pointer is free again, but keeps animating the
   * mesh down to where the stone came from and calls `onDone` when it lands —
   * that is the moment the caller should hand it back to the physics engine.
   */
  function exit(onDone) {
    if (!held || held.returning) return null;
    const rock = held.rock;

    // Back to the pose it was lying in, orientation included — however far you
    // tumbled it, it turns back over on the way down rather than snapping the
    // moment the physics body takes over again.
    const to = new Vector3();
    const toRot = new Quaternion();
    const restore = rock.restore ?? { position: rock.node.absolutePosition, rotation: Quaternion.Identity() };
    toCameraSpace(restore.position, restore.rotation, to, toRot);

    held.from = held.mesh.position.clone();
    held.fromRot = held.mesh.rotationQuaternion.clone();
    held.to = to;
    held.toRot = toRot;
    held.t = 0;
    held.seconds = RETURN_SECONDS;
    held.returning = true;
    held.onDone = onDone;
    return rock;
  }

  /** Drag to tumble the stone. Deltas are in pixels; axes are camera-local. */
  function rotate(dx, dy) {
    if (!held || held.returning) return;
    // Both axes are negated, and both need to be.
    //
    // The mesh is a child of the camera and the camera looks down its own +Z, so
    // the face you are looking at is the stone's -Z side. Rotating +theta about
    // Up sends that face left, and +theta about Right sends it up — while a
    // browser's dy is positive downwards. Taken straight, dragging right turned
    // the stone left and dragging down tipped it up. Negating both makes the
    // near face follow the pointer, which is what turning something over in your
    // hand feels like.
    const q = Quaternion.RotationAxis(Vector3.Up(), -dx * ROTATE_GAIN)
      .multiply(Quaternion.RotationAxis(Vector3.Right(), -dy * ROTATE_GAIN));
    held.mesh.rotationQuaternion = q.multiply(held.mesh.rotationQuaternion);
    // Tumbling replaces the pose the return would otherwise slerp from.
    held.fromRot.copyFrom(held.mesh.rotationQuaternion);
  }

  function zoom(delta) {
    if (!held || held.returning) return;
    const z = held.mesh.position.z * (1 + delta * 0.0012);
    held.mesh.position.z = Math.min(Math.max(z, held.baseDistance * 0.45), held.baseDistance * 2.0);
  }

  function update(dt) {
    if (!held || held.t >= 1) return;
    held.t = Math.min(1, held.t + dt / held.seconds);
    const k = smoothstep(held.t);
    Vector3.LerpToRef(held.from, held.to, k, held.mesh.position);
    if (held.returning) {
      Quaternion.SlerpToRef(held.fromRot, held.toRot, k, held.mesh.rotationQuaternion);
    }
    if (held.t >= 1 && held.returning) finishReturn();
  }

  return {
    prewarm,
    enter,
    exit,
    rotate,
    zoom,
    update,
    get isActive() { return held !== null && !held.returning; },
    // True while a stone is in the air in EITHER direction. isActive goes false
    // the instant a stone starts flying back, but its onDone callback has not
    // run yet and still holds the rock — tearing the bed down in that window
    // leaves the callback to touch a disposed body.
    get isBusy() { return held !== null; },
    get heldRock() { return held && !held.returning ? held.rock : null; },
  };
}
