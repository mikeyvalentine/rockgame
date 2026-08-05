import { defineConfig } from "vite";

export default defineConfig({
    server: {
        port: 5185,
        strictPort: true,
        // The shared scribble dials live one level up, at the repo root.
        fs: { allow: [".."] },
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
