import { defineConfig } from "vite";

export default defineConfig({
    server: {
        port: 5185,
        strictPort: true,
        // The shared scribble dials live one level up, at the repo root.
        fs: { allow: [".."] },
    },
    resolve: {
        // One Babylon, not two.
        //
        // The crouch loads `rock-sift/src/world.js`, which imports
        // `@babylonjs/core` bare — and node resolution finds that in
        // rock-sift's own node_modules. Left alone, the page ends up with two
        // copies of the same version: two ShaderStores, two Engine classes,
        // and an `instanceof` that quietly answers false. Deduping collapses
        // them onto this project's copy.
        //
        // This is also why rock-sift was moved from Babylon 8.56 to 9.18 —
        // deduping can only merge copies that are actually the same library.
        dedupe: ["@babylonjs/core", "@babylonjs/loaders", "@babylonjs/havok"],
    },
    // The one shared assets folder at the repo root — see rock-sift/vite.config.js.
    publicDir: "../public",
    build: {
        target: "esnext",
        sourcemap: true,
        copyPublicDir: false,
    },
    // .wgsl imported via ?raw
    assetsInclude: ["**/*.hdr", "**/*.env"],
});
