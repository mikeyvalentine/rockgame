import { defineConfig } from "vite";

export default defineConfig({
  // fs.allow one level up: the shared scribble dials live at the repo root.
  server: { port: 5183, strictPort: false, fs: { allow: [".."] } },
  // Havok ships a large .wasm; keep it as a real file rather than an inlined blob.
  assetsInclude: ["**/*.wasm"],
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
