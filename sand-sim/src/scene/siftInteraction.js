/**
 * The sweep, wired to the beach.
 *
 * Nothing here reimplements sifting. `hand.js`, `examine.js` and
 * `interaction.js` are rock-sift's, tuned against its own `sift-test` and
 * `carry-test`, and they are constructed here against sand-sim's camera and the
 * bed the crouch woke. A second implementation of dragging a stone out of a
 * pile is the last thing this project needs.
 *
 * They are reusable at all because their scale turned out to be a parameter in
 * all but name: every constant is authored in metres and multiplied by `U` at
 * the point of use, so passing `unitScale: 1` puts the whole interaction in the
 * beach's units with rock-sift's own behaviour unchanged (its five Havok tests
 * still pass at the default).
 *
 * What is deliberately not wired yet: the bucket, and the HUD. Sweeping,
 * carrying and examining a stone are the verbs that make a bed a bed; keeping
 * what you found is the economy, and that wants docs/02 read properly first.
 */

import { createSiftHand } from "../../../rock-sift/src/hand.js";
import { createExamineStage } from "../../../rock-sift/src/examine.js";
import { createInteraction } from "../../../rock-sift/src/interaction.js";
import { GRAVITY } from "./siftPhysics.js";

/** A HUD that says nothing — the beach has no sift HUD yet. */
const nullHud = {
    setStatus() {}, setHint() {}, setKept() {}, setDepth() {}, hideLoading() {},
    setRock() {}, clearRock() {},
};

/**
 * @param scene     the beach scene
 * @param camera    the first-person camera — picking happens through it
 * @param physics   a SiftPhysics; the awake spot is what the sweep acts on
 */
export function createSiftInteraction(scene, camera, physics, opts = {}) {
    const hand = createSiftHand(scene, { unitScale: 1 });
    const examine = createExamineStage(scene, { camera });

    const interaction = createInteraction(scene, {
        camera, hand, examine,
        hud: opts.hud ?? nullHud,
        unitScale: 1,
        // The beach's gravity, not rock-sift's. Its constant is -9.81 * U for a
        // 4x world; the carry spring cancels the stone's weight with it, so
        // handing it -39.24 in a -9.81 scene left +29 m/s^2 of net lift and a
        // clicked stone launched. See rock-sift/src/carry.js.
        gravity: GRAVITY,
        // Read live rather than captured: which bed is awake changes as the
        // player walks the beach and crouches somewhere else.
        getRocks: () => physics.awake?.rocks ?? [],
        getOrigin: () => physics.awake
            ? { x: physics.awake.spot.x, z: physics.awake.spot.z }
            : null,
        // No bucket on the beach yet, so nothing stands in the way of a carry.
        getClearance: () => 0,
        onToggleAO: () => {},
        onRepour: () => {},
    });

    // Off until the crouch says otherwise — the sweep must not act on a bed
    // that is not there.
    interaction.setEnabled(false);
    return { hand, examine, interaction };
}
