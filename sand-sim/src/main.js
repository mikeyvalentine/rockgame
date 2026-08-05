/**
 * sand-sim — boot loader.
 *
 * Selects a renderer, then hands the canvas to the matching app module. The
 * full SNOWFLOW-derived WGSL pipeline lives in `app/webgpuApp.js`; the
 * reduced-fidelity fallback lives in `app/webglApp.js`. Everything that is not
 * shader-bound (input, controller, gait, settings, overlay, HDRI environment)
 * is shared between them — that boundary is the project's architecture rule.
 *
 * If WebGPU device creation itself fails on a machine the probe accepted, the
 * loader retries the page on the WebGL path rather than dying — unless the URL
 * explicitly forced WebGPU.
 */

import { selectRenderer, rendererForced } from "./boot/selectEngine.js";
import * as loading from "./core/loading.js";

async function boot() {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    const kind = await selectRenderer();

    try {
        if (kind === "webgpu") {
            const { run } = await import("./app/webgpuApp.js");
            await run(canvas);
        } else {
            const { run } = await import("./app/webglApp.js");
            await run(canvas);
        }
    } catch (err) {
        console.error(err);
        // Device-level WebGPU failure → one shot at the fallback, by reload so
        // the canvas is clean (a canvas that has been configured for WebGPU
        // cannot hand out a WebGL context afterwards).
        if (err && err.webgpuInit && !rendererForced()) {
            location.search = "?webgl=1";
            return;
        }
        loading.fail("Startup failed — see console.");
    }
}

boot();
