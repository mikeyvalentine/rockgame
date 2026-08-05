// The sifting hand: a kinematic box swept through the bed.
//
// Kept DOM-free and free of any rendering concern so tools/sift-test.mjs can
// drive exactly the collider the browser drives — the sift was the part of this
// scene that came apart, and it is not something a screenshot can measure.
//
// Two rules matter here, and breaking either one detonates the bed:
//
//  1. An animated body reaches its target transform within one *solver* step,
//     not one rendered frame. `advance` must therefore be called once per
//     physics substep, with the substep's dt — not from onBeforeRender.
//  2. Moving the body without also moving its target leaves the solver driving
//     the hand back to where it was, as fast as one step allows. `snap` sets
//     both.

import {
  MeshBuilder, PhysicsBody, PhysicsMotionType, PhysicsShapeBox, Quaternion, Vector3,
} from "@babylonjs/core";
import { HAND, HAND_SPEED, U } from "./config.js";
import { teleport } from "./field.js";

// Far enough below the sand that the parked hand touches nothing.
export const PARK = new Vector3(0, -20 * U, 0);

// The hand enters from above rather than materialising inside the pile.
const ENTRY_HEIGHT = 0.16 * U;

export function createSiftHand(scene) {
  const node = MeshBuilder.CreateBox(
    "hand", { width: HAND.width, height: HAND.height, depth: HAND.depth }, scene
  );
  node.isVisible = false; // 'H' reveals it for debugging the collider
  node.isPickable = false;
  node.position.copyFrom(PARK);
  node.rotationQuaternion = Quaternion.Identity();

  const shape = new PhysicsShapeBox(
    Vector3.Zero(), Quaternion.Identity(),
    new Vector3(HAND.width, HAND.height, HAND.depth), scene
  );
  shape.material = { friction: 0.5, restitution: 0.0 };
  const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
  body.shape = shape;

  const at = PARK.clone();
  const target = PARK.clone();
  const step = new Vector3();
  const rot = Quaternion.Identity();
  let yaw = 0;
  let active = false;

  /** Hard-set the body *and* its kinematic target, so the solver does not chase. */
  function snap(position) {
    at.copyFrom(position);
    teleport(scene, body, node, position, rot);
    body.setTargetTransform(position, rot);
  }

  return {
    node,
    body,
    get position() { return at; },
    get isActive() { return active; },

    /** Begin a sweep at a ground point, dropping in from above it. */
    grab(point) {
      active = true;
      target.copyFrom(point);
      snap(point.add(new Vector3(0, ENTRY_HEIGHT, 0)));
    },

    /** Aim at a new ground point. */
    aim(point) {
      target.copyFrom(point);
    },

    /** Lift straight out; never sweep back down through the bed on the way. */
    release() {
      active = false;
      snap(PARK);
    },

    /**
     * Advance one physics substep. `dt` is that substep in seconds, `digY` the
     * height the hand is being held at, in world units.
     */
    advance(dt, digY) {
      if (!active) return;
      target.y = digY;
      target.subtractToRef(at, step);
      step.scaleInPlace(Math.min(1, dt * 16));
      const maxStep = HAND_SPEED * dt;
      const len = step.length();
      if (len > maxStep) step.scaleInPlace(maxStep / len);

      const prevX = at.x, prevZ = at.z;
      at.addInPlace(step);
      const vx = at.x - prevX, vz = at.z - prevZ;
      if (Math.hypot(vx, vz) > 1e-4) yaw = Math.atan2(vx, vz);
      Quaternion.RotationAxisToRef(Vector3.Up(), yaw, rot);
      body.setTargetTransform(at, rot);

      // Animated bodies do not sync back to their node, so the debug box has to
      // be moved by hand or 'H' shows it parked under the world.
      node.position.copyFrom(at);
      node.rotationQuaternion.copyFrom(rot);
    },
  };
}
