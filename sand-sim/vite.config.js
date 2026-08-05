import { defineConfig } from "vite";

export default defineConfig({
    server: {
        port: 5185,
        strictPort: true,
        // The shared scribble dials live one level up, at the repo root.
        fs: { allow: [".."] },
    },
    build: {
        target: "esnext",
        sourcemap: true,
    },
    // .wgsl imported via ?raw
    assetsInclude: ["**/*.hdr", "**/*.env"],
});
