/**
 * Crouching down at a spot — the transition, in one scene.
 *
 * The whole thing is a camera move. The player is already standing on the pad;
 * crouching lowers the eye to the stones, tips the view down, and wakes that
 * spot's bed into physics behind the move. There is no scene to build, nothing
 * to fetch, and nothing to hide behind a loading screen: `siftPhysics` measures
 * the wake at ~100 ms for a whole bed, against a transition of about a second.
 *
 * That is the point of doing it this way rather than swapping scenes, which is
 * what this replaces. Because it is the beach's own scene:
 *
 *   - the bed rests on the beach's terrain, not on a lab floor;
 *   - the sand under it is the sand the player walked over;
 *   - anything a stone does reaches the sand — `scene/imprints.js` presses
 *     every landing into the beach and draws it through the deformation field.
 *
 * What "pausing the sim" means here
 * ---------------------------------
 * Not freezing the world — freezing the *walker*. Input, locomotion and footfall
 * contact stop, because the player is knelt down. Everything the stones touch
 * keeps running, which is the whole reason for being in this scene at all.
 * docs/10 asks for a sand sim that "only steps while the player disturbs it",
 * and while crouched the disturbance is the bed rather than the boots.
 *
 * The camera, and why the mouse has to come back
 * ----------------------------------------------
 * Walking the beach is mouse-look under pointer lock. Sifting is not: rock-sift
 * drives every interaction — sweeping, dragging a stone, lifting one to look at
 * it — from `scene.pointerX/Y`, which is to say from where the cursor IS. Under
 * pointer lock there is no cursor and those coordinates never move, so the bed
 * cannot be touched at all. That was the bug: the camera kept turning and
 * nothing in the bed responded.
 *
 * So crouching releases pointer lock and the cursor comes back. The view is
 * pinned at that point — a knelt player is looking at the bed under their hands,
 * not turning around — with a small amount of look left in it so the far edge of
 * the bed is reachable without standing up. `beginLook`/`applyLook` are what the
 * rig asks before it turns; while crouched they clamp instead of refusing, so
 * the difference reads as leaning rather than as a camera that has stopped
 * working.
 */

import { spotAt } from "../../../shared/siftPad.js";

export { spotAt };

/** Eye height above the feet while crouched, metres. Kneeling over the bed. */
const CROUCH_EYE = 0.52;

/**
 * Looking down at the stones, radians. The rig's convention: positive is down.
 *
 * 65 degrees, not straight down. Steep enough that the bed fills the view from
 * kneeling height and the horizon is gone, shallow enough that the stones are
 * seen at a raking angle rather than in plan — which is what makes their relief,
 * and the dents they sit in, legible at all.
 */
const CROUCH_PITCH = (65 * Math.PI) / 180;

/** How far the view may be leaned from that pose while crouched, radians. */
const LOOK_YAW_LIMIT = (22 * Math.PI) / 180;
const LOOK_PITCH_LIMIT = (14 * Math.PI) / 180;

/**
 * Seconds for the move.
 *
 * rock-sift's own crouch runs 1.1 s and that reads well, so it is matched
 * rather than re-guessed. Long enough to feel like kneeling, short enough that
 * nobody waits.
 */
const TRANSITION = 1.1;

const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Crouch {
    /**
     * @param rig        the FpsRig — `eyeHeight`, `pitch` and `yaw` are what move
     * @param character  the walker, frozen while crouched
     * @param physics    a SiftPhysics
     * @param beds       the handle from `buildSiftingBeds`
     * @param pointer    `{ release(), restore() }` — pointer lock, so the cursor
     *                   can drive the sifting. See the header.
     */
    constructor({ rig, character, physics, beds, interaction = null, examine = null, imprints = null, pointer = null }) {
        this.imprints = imprints;
        this.interaction = interaction;
        this.examine = examine;
        this.rig = rig;
        this.character = character;
        this.physics = physics;
        this.beds = beds;
        this.pointer = pointer;

        /** The spot being sifted, or null. */
        this.spot = null;
        /** @type {{from: object, to: object, t: number, leaving: boolean}|null} */
        this.tween = null;

        this.standEye = rig.eyeHeight;
        /** The pose the lean is measured against, set when the crouch lands. */
        this.anchor = null;
    }

    /** True while the camera is travelling — input should stay off. */
    get isMoving() { return this.tween !== null; }

    /** True from the moment the crouch starts until the player is back up. */
    get engaged() { return this.spot !== null || this.tween !== null; }

    /** True while the view is pinned to a bed — the rig asks before it turns. */
    get locked() { return this.engaged; }

    /**
     * E, whichever way it is meant.
     *
     * One key for both directions, because from the player's side there is one
     * thing happening — you are at the bed or you are not — and a separate exit
     * key is something to be told rather than something to find. Escape still
     * works, and still means "give me the pointer back", which is what a browser
     * does with it anyway.
     *
     * @param nearSpot the spot the player is standing at, if any
     * @returns whether anything happened
     */
    toggle(nearSpot) {
        if (this.tween) return false;                 // mid-move: ignore
        if (this.spot) return this.leave();
        return nearSpot ? this.enter(nearSpot) : false;
    }

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
        // The field has long since relaxed away anything dug here before. Replay
        // it, so a bed you excavated yesterday still looks excavated.
        this.imprints?.restamp(spot.id);
        // The cursor is the tool. See the header.
        this.pointer?.release();
        const to = {
            eye: CROUCH_EYE,
            pitch: CROUCH_PITCH,
            yaw: this.rig.yaw,
            x: spot.x,
            z: spot.z,
        };
        this.anchor = { pitch: to.pitch, yaw: to.yaw };
        this.tween = { from: this._pose(), to, t: 0, leaving: false };
        return true;
    }

    /**
     * Stand back up.
     *
     * The bed goes back to scenery immediately, keeping whatever arrangement it
     * was left in, so a bed dug through stays dug through. It is not left
     * simulating through the rise: hundreds of bodies cost solver time whether
     * or not anyone is looking at them.
     */
    leave() {
        if (!this.spot || this.tween) return false;
        this.physics.sleep(this.beds);
        this.anchor = null;
        this.tween = {
            from: this._pose(),
            to: {
                eye: this.standEye, pitch: 0.06, yaw: this.rig.yaw,
                x: this.character.position.x, z: this.character.position.z,
            },
            t: 0,
            leaving: true,
        };
        this.spot = null;
        return true;
    }

    /**
     * Clamp a look the rig is about to apply.
     *
     * Called by the app in place of writing yaw/pitch straight from the mouse.
     * While walking this is the identity. While crouched it holds the view
     * inside a cone around the pose the crouch landed in — and while the camera
     * is still travelling it refuses outright, because a player nudging the
     * mouse mid-transition should not be fighting the tween for the same two
     * numbers.
     *
     * @param pose {{yaw: number, pitch: number}} mutated in place
     */
    clampLook(pose) {
        if (!this.engaged) return pose;
        if (this.tween || !this.anchor) {
            pose.yaw = this.rig.yaw;
            pose.pitch = this.rig.pitch;
            return pose;
        }
        pose.yaw = this.anchor.yaw + clamp(pose.yaw - this.anchor.yaw, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
        pose.pitch = clamp(pose.pitch, this.anchor.pitch - LOOK_PITCH_LIMIT, this.anchor.pitch + LOOK_PITCH_LIMIT);
        return pose;
    }

    _pose() {
        return {
            eye: this.rig.eyeHeight,
            pitch: this.rig.pitch,
            yaw: this.rig.yaw,
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
            // Stones landing press the sand, permanently. Only while crouched:
            // it is the only time anything is moving stones around.
            this.imprints?.pressImpacts(this.physics.awake);
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

        if (tw.t >= 1) {
            const leaving = tw.leaving;
            this.tween = null;
            // Pointer lock comes back on the way UP, not on the way down: taking
            // it at the start of the rise would swallow the click that the
            // player is still using on the bed.
            if (leaving) this.pointer?.restore();
        }
        return true;
    }
}
