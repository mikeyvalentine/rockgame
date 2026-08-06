// Compile the generated WGSL on a real WebGPU device. `createShaderModule` needs
// no buffers, which is the only reason this works where everything else here
// does not.
import { siftPadWGSL } from "../../../shared/siftPad.js";

const out = [];
const say = (s) => { out.push(s); console.log("WGSL " + s); };
window.WGSL = out;

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();

async function compile(label, code) {
    const mod = device.createShaderModule({ code });
    const info = await mod.getCompilationInfo();
    const bad = info.messages.filter((m) => m.type === "error");
    say(`${label}: ${bad.length ? "FAILED" : "ok"}`);
    for (const m of info.messages) {
        say(`  ${m.type} line ${m.lineNum}:${m.linePos} ${m.message}`);
    }
    return bad.length === 0;
}

// The pad field exactly as `registry.js` injects it, plus the smallest possible
// caller — the height bake uses padDominant, the aux bake used to use padMask.
const pad = siftPadWGSL();
await compile("siftPadWGSL (as generated)", pad + `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let p = uv * 512.0 - 256.0;
    let d = padDominant(p);
    return vec4f(d.x, d.y, padCoverage(p), padLevel(p));
}
`);

window.WGSL_DONE = true;
