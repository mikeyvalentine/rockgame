/**
 * The crouch — integration slice 3.
 *
 * Walk onto a pile, crouch, and you are sifting. Standing up puts you back on
 * the beach where you left off.
 *
 * Sifting is its own environment
 * ------------------------------
 * The sift world is a whole second Babylon scene — rock-sift's, built by
 * `rock-sift/src/world.js`, physics and all — sharing this page's engine and
 * nothing else. While it is up the beach is *paused*: not rendered, not
 * stepped, not listening. That is the arrangement docs/10 asks for ("the sand
 * sim must be pausable — it only steps while the player disturbs it") and it is
 * what makes a full Havok bed affordable at all, because the two never run at
 * once.
 *
 * It is also why this is a handoff rather than a merge. The beach is 512 m of
 * terrain in metres; the bed is 80 cm of stones modelled at 4x. Trying to hold
 * both in one scene means reconciling two world scales and two lighting rigs
 * for a view that only ever shows one of them.
 *
 * This became possible when rock-sift moved to Babylon 9.18 — it was on 8.56,
 * and two Babylon majors in one page is two Scene registries and two sets of
 * class identities. Its five Havok tests pass on 9.18 unchanged, so the two
 * labs now share one engine.
 *
 * Which bed you get
 * -----------------
 * sand-sim's spots and rock-sift's spots are different lists — four along the
 * shingle band here, three along the lab's shore there. They are matched by
 * index, so crouching at a given pile always brings up the same bed.
 */

import { spotAt, SIFT_SPOTS } from "../../../shared/pileField.js";

/** Re-exported so the apps can do proximity tests without a second import. */
export { spotAt };

/**
 * Open the sift world for a spot, pausing the beach behind it.
 *
 * @param engine       the shared Babylon engine
 * @param beachScene   the sand-sim scene to pause
 * @param spot         a SIFT_SPOTS entry
 * @param onClosed     called after the world is disposed and the beach is live
 * @returns {Promise<{scene: object, close: () => void}>}
 */
export async function openSift(engine, beachScene, spot, onClosed) {
    // Imported here, not at module load: the sift world drags in Havok's wasm
    // and the whole forge, and a player who never crouches should never pay for
    // it. The beach is what has to start quickly.
    const { createSiftWorld, nullHud } = await import("../../../rock-sift/src/world.js");

    // Index-matched — see the header. rock-sift has three spots to our four, so
    // the last pile shares a bed with the first, which is invisible from the
    // beach because you can only ever be at one.
    const index = SIFT_SPOTS.indexOf(spot);

    let closed = false;
    const world = await createSiftWorld(engine, {
        hud: nullHud,
        enterSpotIndex: index,
        // Standing up in the sift world is the signal to come back out. Deferred
        // by a frame: `onModeChange` fires from inside the shore's own update,
        // and disposing the scene from there would pull the ground out from
        // under the rest of that frame.
        onLeave: () => queueMicrotask(close),
    });

    function close() {
        if (closed) return;
        closed = true;
        world.dispose();
        beachScene.attachControl?.();
        onClosed?.();
    }

    return { scene: world.scene, world, close };
}

/**
 * The prompt shown when the player is standing on a pile.
 *
 * Deliberately one line and no explanation — docs/00's barebones-UI rule. It
 * says what the control is, and the bed you are standing on says the rest.
 */
export function createCrouchPrompt() {
    const el = document.createElement("div");
    el.id = "crouch-prompt";
    el.style.cssText = [
        "position:fixed", "left:50%", "bottom:12%", "transform:translateX(-50%)",
        "padding:6px 14px", "border-radius:4px",
        "background:rgba(7,11,18,0.62)", "color:#dbe6f2",
        "font:500 13px/1.4 var(--stefan-tight, ui-sans-serif), ui-sans-serif",
        "letter-spacing:0.06em", "text-transform:lowercase",
        "pointer-events:none", "opacity:0", "transition:opacity 160ms ease",
        "z-index:60",
    ].join(";");
    el.textContent = "press e to sift";
    document.body.appendChild(el);
    return {
        show: (on) => { el.style.opacity = on ? "1" : "0"; },
        dispose: () => el.remove(),
    };
}
