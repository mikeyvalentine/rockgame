/**
 * Renderer selection, once, at boot.
 *
 * `?webgl=1` / `?webgpu=1` force a path — the dev harness for exercising the
 * fallback on a WebGPU-capable machine. Otherwise: WebGPU if the adapter
 * actually answers (not merely if `navigator.gpu` exists — Chrome exposes the
 * object on machines whose adapter then refuses), else WebGL2.
 */

/** @returns {Promise<"webgpu"|"webgl2">} */
export async function selectRenderer() {
    const q = new URLSearchParams(location.search);
    if (q.has("webgl")) return "webgl2";
    if (q.has("webgpu")) return "webgpu";

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
