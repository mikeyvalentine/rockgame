/**
 * Renderer selection, once, at boot.
 *
 * **WebGL2 is the default.** `?webgpu=1` opts into the WGSL path; `?webgl=1`
 * still forces the default explicitly, so existing links keep working.
 *
 * This is a reversal, and the reason is development rather than rendering.
 * WebGPU cannot be run where this project is worked on: a software adapter
 * refuses every `createBuffer({mappedAtCreation})` at any size, so no texture
 * uploads, no material compiles, and nothing can be looked at. Every WebGPU
 * change was therefore going out unseen — which is how a scene with no lights,
 * an unimported `Vector3`, and stones rendering in the sky's rendering group
 * all reached the deployed site inside one afternoon, each found by a person
 * loading the page rather than by anything here.
 *
 * WebGL2 runs headlessly, screenshots, and can be driven by a test. Being able
 * to SEE a change is worth more right now than the fidelity difference, so the
 * work happens on the path that can be verified and WebGPU is opted into.
 *
 * Nothing about the WebGPU path is removed or deprecated by this, and
 * `docs/09-sand-sim.md` records it as a working decision rather than a change
 * of rendering target. `CLAUDE.md`'s stack rule still names WebGPU as the
 * target for the particle sim, and that has not been relitigated here.
 */

/** @returns {Promise<"webgpu"|"webgl2">} */
export async function selectRenderer() {
    const q = new URLSearchParams(location.search);
    if (q.has("webgl")) return "webgl2";
    if (!q.has("webgpu")) return "webgl2";

    // Asked for explicitly — but still only if the adapter actually answers.
    // Chrome exposes `navigator.gpu` on machines whose adapter then refuses.
    if (!navigator.gpu) return "webgl2";
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return "webgl2";
    } catch {
        return "webgl2";
    }
    return "webgpu";
}

/** True when the current URL explicitly forced a renderer. */
export function rendererForced() {
    const q = new URLSearchParams(location.search);
    return q.has("webgl") || q.has("webgpu");
}
