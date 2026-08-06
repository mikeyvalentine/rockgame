# wgsl-probe

Compiles the WGSL this project *generates* on a real WebGPU device, and reports
`getCompilationInfo()`.

It exists because the generated shader had no coverage of any kind. `siftPadWGSL()`
emits WGSL from JS constants and nothing checked it was even valid — the headless
checks compare it to the JS twin, which a syntax error passes cleanly.

Run it by hand; it needs a browser, so it is not in `npm test`:

    npx vite                       # from sand-sim/
    # then open /tools/wgsl-probe/ in a WebGPU browser and read the console

Why only the generated includes and not the bed material: `createShaderModule`
needs no buffers, which is the one WebGPU call the software adapter in CI and in
the dev container will accept. Anything that has to *upload a texture* fails
there — every `mappedAtCreation` buffer is refused, at any size — so the forge
material cannot be compiled without real hardware.
