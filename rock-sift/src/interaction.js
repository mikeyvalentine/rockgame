// Pointer and keyboard: sweeping the bed, dragging a stone, picking one up.
//
// Three gestures share one pointer, told apart by WHAT IS UNDER THE PRESS:
//
//   press bare sand,  drag      sweep the hand through the bed
//   press a stone,    drag      carry that stone
//   press a stone,    release   lift it to the camera and read it
//
// Reaching a stone is the gesture that has to feel immediate, so pressing one
// commits to it straight away: no sweep is started, and the smallest drag picks
// it up. Sweeping is what happens when you press a gap.
//
// This was briefly the other way round — sweep by default, hold still on a stone
// to carry it — on the theory that a bed this dense leaves nowhere to press that
// is not a stone. In the hand that theory was wrong twice over: there are plenty
// of gaps to start a sweep in, and any hold at all makes picking a stone up feel
// like a fight.

import { Color3, MeshBuilder, PhysicsMotionType, Quaternion, StandardMaterial, Vector3 } from "@babylonjs/core";
import { createCarrier } from "./carry.js";
import { surfaceTopNear, teleport } from "./field.js";
import { clamp } from "./noise.js";
import {
  BED_RADIUS, CARRY, DIG_MAX, DIG_MIN, HAND, PHYSICS_SUBSTEP_MS, SWEEP_PROBE_RADIUS,
  SWEEP_REACH, U,
} from "./config.js";

// Movement under this many pixels counts as a click rather than a drag. Kept
// tight: it is the distance you have to travel before a stone you have pressed
// starts to move, and anything larger reads as the stone being stuck.
const TAP_PIXELS = 3;
const START_DIG = 0.045;

// Babylon's PointerEventTypes, spelled out so the switch reads without a lookup.
const DOWN = 1, UP = 2, MOVE = 4, WHEEL = 8;

/** @param onRepour async () => void — rebuild the bed, for the R key */
export function createInteraction(scene, {
  camera, hand, examine, hud, getRocks, getOrigin, getClearance, onRepour, onToggleAO,
  // World units per metre. Defaults to the lab's own 4x, so nothing here
  // changes for rock-sift; sand-sim hosts the same bed at 1:1 and passes 1.
  // Everything below is authored in metres and scaled at the point of use,
  // which is what made this a parameter rather than a rewrite — except HAND,
  // which config.js already scaled, so it is re-scaled by the ratio instead.
  unitScale = U,
}) {
  const handScale = unitScale / U;
  // Where the sweep is riding, in metres. Owned here because the pointer wheel
  // sets it, the hand consumes it, and the cursor ring is drawn at it.
  let dig = START_DIG;

  let pointerDownPx = { x: 0, y: 0 };
  let movedPx = 0;
  let pending = null; // a stone pressed but not yet committed to carry or tap
  // Off while standing back on the shore: the sweep and the pick belong to the
  // crouched view, and the markers own the pointer the rest of the time.
  let enabled = true;

  const carrier = createCarrier(scene);
  // Where the carried stone was last aimed, so the aiming plane can be chosen
  // from where it is rather than from where the pointer happens to hit first.
  const carriedAt = new Vector3();

  const ring = MeshBuilder.CreateTorus(
    "ring", { diameter: HAND.width * 1.2 * handScale, thickness: 0.004 * unitScale, tessellation: 40 }, scene
  );
  const ringMat = new StandardMaterial("ringMat", scene);
  ringMat.disableLighting = true;
  ringMat.emissiveColor = new Color3(1, 0.97, 0.9);
  ringMat.alpha = 0;
  ring.material = ringMat;
  ring.isPickable = false;

  /** Where the pointer meets a horizontal plane at world height `y`. */
  function planePointAt(px, py, y) {
    const ray = scene.createPickingRay(px, py, null, camera);
    if (Math.abs(ray.direction.y) < 1e-5) return null;
    const t = (y - ray.origin.y) / ray.direction.y;
    if (t < 0) return null;
    return ray.origin.add(ray.direction.scale(t));
  }

  const pickRock = () => {
    const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => !!m.metadata?.rock, false, camera);
    return hit?.pickedMesh?.metadata?.rock ?? null;
  };

  /**
   * The height the sweep actually rides at.
   *
   * Never above whatever is beneath it. Held at the dig depth alone, the hand
   * floats over a stone lying by itself on open sand — the bank is 15 cm deep so
   * a 4.5 cm sweep is buried in it, but out on the flat the same 4.5 cm passes
   * clean over a 3 cm pebble and nothing moves. Riding on the local surface
   * means the sweep parts the bank where there is one and skims the sand where
   * there is not, which is what a hand does.
   */
  function sweepHeight() {
    const top = surfaceTopNear(getRocks(), hand.position.x, hand.position.z, SWEEP_PROBE_RADIUS * unitScale);
    return Math.max(HAND.height * 0.5 * handScale, Math.min(dig * unitScale, top));
  }

  function endSweep() {
    if (!hand.isActive) return;
    ringMat.alpha = 0;
    hand.release(); // lift it straight out; never sweep it back down
  }

  function inspect(rock) {
    rock.restore = {
      position: rock.node.position.clone(),
      rotation: (rock.node.rotationQuaternion || Quaternion.Identity()).clone(),
    };
    // enter() reads the stone's live position to start the lift from, so it has
    // to run before the body is parked out of the world.
    examine.enter(rock);
    rock.body.setMotionType(PhysicsMotionType.STATIC);
    teleport(scene, rock.body, rock.node, new Vector3(0, -30 * unitScale, 0), Quaternion.Identity());

    hud.showStone(rock.arch.metrics);
    endSweep();
  }

  function putBack() {
    // The stone flies back down to where it came from first; physics only takes
    // over once it has landed, or it would pop into the bed while the mesh is
    // still on its way.
    const rock = examine.exit(() => {
      rock.body.setMotionType(PhysicsMotionType.DYNAMIC);
      // A little above its old spot, so it settles rather than interpenetrating
      // whatever has rolled into the gap while it was out.
      teleport(scene, rock.body, rock.node,
        rock.restore.position.add(new Vector3(0, 0.05 * unitScale, 0)), rock.restore.rotation);
    });
    if (!rock) return;
    hud.hideStone();
  }

  scene.onPointerObservable.add((info) => {
    if (!enabled) return;
    const ev = info.event;
    switch (info.type) {
      case DOWN: {
        pointerDownPx = { x: scene.pointerX, y: scene.pointerY };
        movedPx = 0;
        pending = null;
        if (examine.isActive) break;

        // A stone under the press means this gesture is about that stone. No
        // sweep is started — the hand would shove it out from under the pointer
        // before the drag had even begun.
        pending = pickRock();
        if (pending) break;

        // Reach is measured from the bed you are crouched at, not from the world
        // origin — at a spot along the beach every point is far from the origin
        // and no sweep could ever start.
        const o = getOrigin?.() ?? null;
        const p = planePointAt(scene.pointerX, scene.pointerY, dig * unitScale);
        if (p && Math.hypot(p.x - (o?.x ?? 0), p.z - (o?.z ?? 0)) < BED_RADIUS * SWEEP_REACH * unitScale) {
          hand.grab(p);
          ringMat.alpha = 0.25;
        }
        break;
      }

      case MOVE: {
        movedPx = Math.max(movedPx, Math.hypot(scene.pointerX - pointerDownPx.x, scene.pointerY - pointerDownPx.y));
        if (examine.isActive) {
          if (ev.buttons & 1) examine.rotate(ev.movementX || 0, ev.movementY || 0);
          break;
        }
        if (pending && !carrier.isActive && movedPx > TAP_PIXELS) {
          carriedAt.copyFrom(pending.node.position);
          carrier.pick(pending);
          ringMat.alpha = 0;
        }
        if (carrier.isActive) {
          // Aimed on the plane the stone is actually riding at, so it stays
          // under the pointer as it lifts over a rim rather than sliding out
          // from under it. The height comes from where the stone is now; once
          // the new point is known the height it should rise to is read there.
          const here = Math.max(CARRY.height * unitScale, getClearance?.(carriedAt.x, carriedAt.z) ?? 0);
          const p = planePointAt(scene.pointerX, scene.pointerY, here);
          if (p) {
            carriedAt.copyFrom(p);
            carrier.aim(p, Math.max(CARRY.height * unitScale, getClearance?.(p.x, p.z) ?? 0));
          }
        } else if (hand.isActive) {
          const p = planePointAt(scene.pointerX, scene.pointerY, dig * unitScale);
          if (p) hand.aim(p);
        }
        break;
      }

      case UP: {
        // Distance only, no time limit: resting on a stone for a moment and
        // letting go without moving it is plainly a click, however long you took
        // over it.
        const still = movedPx < TAP_PIXELS;
        if (examine.isActive) {
          if (still) putBack();
        } else if (carrier.isActive) {
          carrier.release();
        } else if (pending && still) {
          inspect(pending);
        } else {
          endSweep();
        }
        pending = null;
        break;
      }

      case WHEEL: {
        if (examine.isActive) {
          examine.zoom(ev.deltaY);
        } else {
          dig = clamp(dig + ev.deltaY * 0.00005, DIG_MIN, DIG_MAX);
          hud.setDepth(dig);
        }
        ev.preventDefault?.();
        break;
      }
    }
  });

  window.addEventListener("keydown", async (e) => {
    const k = e.key.toLowerCase();
    if (e.key === "Escape" && examine.isActive) putBack();
    if (k === "r" && !examine.isActive) {
      carrier.release(); // or the carrier keeps driving a body the repour disposed
      await onRepour();
    }
    if (k === "o") onToggleAO();
    if (k === "h") hand.node.isVisible = !hand.node.isVisible;
  });

  // A kinematic body reaches its target transform within one *solver* step, not
  // one rendered frame. Set once per frame, it covers the whole frame's travel
  // inside the first substep and then stands still for the rest — a shove
  // instead of a sweep. Both the hand and a carried stone are kinematic, so both
  // are advanced here.
  scene.onBeforePhysicsObservable.add(() => {
    if (!enabled) return;
    const dt = PHYSICS_SUBSTEP_MS / 1000;
    carrier.advance(dt);
    if (!hand.isActive) return;
    const y = sweepHeight();
    hand.advance(dt, y);
    ring.position.set(hand.position.x, y + 0.015 * unitScale, hand.position.z);
  });

  return {
    get dig() { return dig; },
    get carrying() { return carrier.isActive; },
    putBack,
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      // Never leave a sweep or a carry running into a mode that cannot end it.
      if (!enabled) {
        endSweep();
        carrier.release();
      }
    },
  };
}
