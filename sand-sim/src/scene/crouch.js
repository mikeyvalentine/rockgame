/**
 * Crouching down at a spot — the transition, in one scene.
 *
 * The whole thing is a camera move. The player is already standing on the pile;
 * crouching lowers the eye to the stones, tips the view down, and wakes that
 * spot's bed into physics behind the move. There is no scene to build, nothing
 * to fetch, and nothing to hide behind a loading screen: `siftPhysics` measures
 * the wake at ~100 ms for 540 bodies, against a transition of about a second.
 *
 * That is the point of doing it this way rather than swapping scenes, which is
 * what this replaces. Because it is the beach's own scene:
 *
 *   - the bed rests on the beach's terrain, not on a lab floor;
 *   - the sand under it is the sand the player walked over;
 *   - anything a stone does *can* reach the sand — the deformation field and
 *     `shared/spotImprint.js` are both in this scene's reach.
 *
 * That last one is potential, not behaviour: nothing yet feeds stone contacts
 * into either. Being in one scene is what makes it possible; the wiring is
 * still to come, and this comment says so rather than describing a beach that
 * dents when you throw a stone across it.
 *
 * What "pausing the sim" means here
 * ---------------------------------
 * Not freezing the world — freezing the *walker*. Input, locomotion and footfall
 * contact stop, because the player is knelt down. Everything the stones touch
 * keeps running, which is the whole reason for being in this scene at all.
 * docs/10 asks for a sand sim that "only steps while the player disturbs it",
 * and while crouched the disturbance is the bed rather than the boots.
 */

import { spotAt } from "../../../shared/pileField.js";

export { spotAt };

/** Eye height above the feet while crouched, metres. Kneeling over the bed. */
const CROUCH_EYE = 0.52;

/** Looking down at the stones, radians. The rig's convention: positive is down. */
const CROUCH_PITCH = 0.95;

/**
 * Seconds for the move.
 *
 * rock-sift's own crouch runs 1.1 s and that reads well, so it is matched
 * rather than re-guessed. Long enough to feel like kneeling, short enough that
 * nobody waits.
 */
const TRANSITION = 1.1;

const smoothstep = (t) => t * t * (3 - 2 * t);

export class Crouch {
    /**
     * @param rig        the FpsRig — `eyeHeight` and `pitch` are what move
     * @param character  the walker, frozen while crouched
     * @param physics    a SiftPhysics
     * @param beds       the handle from `buildSiftingBeds`
     */
    constructor({ rig, character, physics, beds, interaction = null, examine = null }) {
        this.interaction = interaction;
        this.examine = examine;
        this.rig = rig;
        this.character = character;
        this.physics = physics;
        this.beds = beds;

        /** The spot being sifted, or null. */
        this.spot = null;
        /** @type {{from: object, to: object, t: number, leaving: boolean}|null} */
        this.tween = null;

        this.standEye = rig.eyeHeight;
    }

    /** True while the camera is travelling — input should stay off. */
    get isMoving() { return this.tween !== null; }

    /** True from the moment the crouch starts until the player is back up. */
    get engaged() { return this.spot !== null || this.tween !== null; }

    /**
     * Crouch at a spot.
     *
     * The bed wakes at the *start* of the move rather than the end, so the
     * stones are real by the time the camera arrives — and the cost of waking
     * them lands while the view is still travelling, which is what hides it.
     */
    enter(spot) {
        if (this.engaged) return false;
        this.spot = spot;
        this.physics.wake(this.beds, spot);
        this.tween = {
            from: this._pose(),
            to: {
                eye: CROUCH_EYE,
                pitch: CROUCH_PITCH,
                x: spot.x,
                z: spot.z,
            },
            t: 0,
            leaving: false,
        };
        return true;
    }

    /**
     * Stand back up.
     *
     * The bed goes back to scenery immediately, keeping whatever arrangement it
     * was left in, so a bed dug through stays dug through. It is not left
     * simulating through the rise: 540 bodies cost solver time whether or not
     * anyone is looking at them.
     */
    leave() {
        if (!this.spot || this.tween) return false;
        this.physics.sleep(this.beds);
        this.tween = {
            from: this._pose(),
            to: { eye: this.standEye, pitch: 0.06, x: this.character.position.x, z: this.character.position.z },
            t: 0,
            leaving: true,
        };
        this.spot = null;
        return true;
    }

    _pose() {
        return {
            eye: this.rig.eyeHeight,
            pitch: this.rig.pitch,
            x: this.character.position.x,
            z: this.character.position.z,
        };
    }

    /**
     * Advance the move.
     * @returns true while the walker should stay frozen.
     */
    update(dt) {
        // Sifting is live only once the camera has arrived: dragging the bed
        // around while the view is still travelling reads as the scene
        // fighting you. rock-sift gates its own the same way.
        //
        // Only touched while the crouch is engaged. Walking the beach is the
        // common case by a wide margin, and it has no business calling into the
        // sweep sixty times a second to tell it something it already knows.
        if (this.engaged) {
            this.interaction?.setEnabled(this.spot !== null && !this.tween);
            this.examine?.update(dt);
        }

        if (!this.tween) return this.spot !== null;

        const tw = this.tween;
        tw.t = Math.min(1, tw.t + dt / TRANSITION);
        const k = smoothstep(tw.t);

        this.rig.eyeHeight = tw.from.eye + (tw.to.eye - tw.from.eye) * k;
        this.rig.pitch = tw.from.pitch + (tw.to.pitch - tw.from.pitch) * k;
        // Slide the feet onto the spot so the bed is centred under the view.
        // Written straight to the controller's position rather than steered,
        // because the walker is frozen and nothing else is moving it.
        this.character.position.x = tw.from.x + (tw.to.x - tw.from.x) * k;
        this.character.position.z = tw.from.z + (tw.to.z - tw.from.z) * k;

        if (tw.t >= 1) this.tween = null;
        return true;
    }
}
