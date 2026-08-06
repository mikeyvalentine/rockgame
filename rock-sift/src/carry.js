// Dragging a single stone around, as opposed to sweeping through them.
//
// The stone STAYS DYNAMIC and is pulled toward the pointer by a force. It is not
// switched to a kinematic body, and that is the whole design:
//
// A kinematic body has infinite mass. Every contact it makes is resolved purely
// by moving the other thing, at whatever speed closes the penetration — so
// lifting a stone out of a packed bank fires its neighbours away in a burst.
// Nothing resists it, which is exactly what makes it read as fake, and no amount
// of extra weight on the neighbours changes it: infinite mass wins every time.
//
// Pulled by a force instead, the stone has to negotiate. It shoulders neighbours
// aside if it can and is held up by them if it cannot, and a wedged stone has to
// be worked loose rather than teleporting out. The acceleration cap is what
// bounds how hard it is ever allowed to shove.
//
// tools/carry-test.mjs measures this directly: the peak speed of any stone other
// than the one in hand.

import { Vector3 } from "@babylonjs/core";
import { CARRY, GRAVITY, U } from "./config.js";

export function createCarrier(scene, { unitScale = U, gravity = GRAVITY } = {}) {
  // Both of these are here because sand-sim carries stones at 1:1 metres while
  // this lab models at 4x, and getting them wrong is not subtle.
  //
  // `gravity` MUST be the gravity of the scene the stone is actually in. The
  // spring cancels the stone's weight so a heavy stone and a light one follow
  // the pointer alike; cancelling by 4x the weight the scene applies leaves
  // +29 m/s^2 of NET LIFT, and a clicked stone launches. That is what it did.
  //
  // `maxAccel` is an acceleration, which is a length over a time squared, so it
  // scales with the world. `stiffness` (1/T^2) and `damping` (1/T) do not, and
  // scaling them would be the opposite mistake — a carry that feels sluggish at
  // 1:1 for no reason anyone could name.
  const accelScale = unitScale / U;
  const maxAccel = CARRY.maxAccel * accelScale;
  const target = new Vector3();
  const accel = new Vector3();
  const vel = new Vector3();
  let rock = null;
  // AUDIT #B6: getMassProperties() builds a fresh {mass, Vector3, Quaternion}
  // bundle on every call, and advance() runs per physics substep — cache the
  // mass once at pick() instead.
  let rockMass = 0.1;

  return {
    get isActive() { return rock !== null; },
    get rock() { return rock; },

    /** Take hold of a stone where it lies. */
    pick(picked) {
      rock = picked;
      rockMass = picked.body.getMassProperties().mass || 0.1;
      // The stone stays dynamic and inside the bed's radius checks, so it has to
      // announce itself: carried well past the shore it would otherwise be
      // collected as a stray and teleported back into the middle mid-drag.
      rock.carried = true;
      target.copyFrom(rock.node.position);
      target.y = CARRY.height * U;
    },

    /**
     * Follow a new point. Only the horizontal part comes from the pointer; the
     * height is the usual carry height, or higher where something has to be
     * cleared — a bucket rim, for instance.
     */
    aim(point, height = CARRY.height * U) {
      if (!rock) return;
      target.x = point.x;
      target.z = point.z;
      target.y = Math.max(CARRY.height * U, height);
    },

    /**
     * Let go. Nothing to undo — the stone was never taken out of the simulation,
     * so it simply carries on with whatever velocity it had, and a stone swung
     * across the shore keeps going.
     */
    release() {
      const dropped = rock;
      if (dropped) dropped.carried = false;
      rock = null;
      return dropped;
    },

    /** Advance one physics substep. `dt` is that substep in seconds. */
    advance(dt) {
      if (!rock) return;
      const body = rock.body;
      const p = rock.node.position;
      body.getLinearVelocityToRef(vel);

      // Spring toward the pointer, damped, holding its own weight up. Written in
      // acceleration and multiplied by mass at the end, so a heavy stone and a
      // light one follow the pointer the same way instead of the big ones
      // lagging — the weight difference should show in what they do to the bed,
      // not in how they handle.
      accel.set(target.x - p.x, target.y - p.y, target.z - p.z);
      accel.scaleInPlace(CARRY.stiffness);
      accel.x -= vel.x * CARRY.damping;
      accel.y -= vel.y * CARRY.damping;
      accel.z -= vel.z * CARRY.damping;
      accel.y -= gravity; // negative, so this cancels the stone's weight

      const a = accel.length();
      if (a > maxAccel) accel.scaleInPlace(maxAccel / a);

      accel.scaleInPlace(rockMass);
      // At the centre of mass: applied off-centre this would spin the stone up
      // as well as move it.
      body.applyForce(accel, p);

      // Bleed off spin while it is in hand. A stone dragged by one point
      // otherwise windmills, and a windmilling stone beats the bed up.
      body.getAngularVelocityToRef(vel);
      vel.scaleInPlace(CARRY.spinDamping);
      body.setAngularVelocity(vel);

      void dt; // the spring is expressed in acceleration; the solver integrates
    },
  };
}
