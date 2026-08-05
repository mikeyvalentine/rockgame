import { defineConfig } from "vite";

export default defineConfig({
  // fs.allow one level up: the shared scribble dials live at the repo root.
  server: { port: 5183, strictPort: false, fs: { allow: [".."] } },
  // All labs pull from the ONE assets folder at the repo root: /assets/* here
  // resolves to ../public/assets in dev, and to the site root's /assets in the
  // deployed single-origin build (which copies it exactly once — hence
  // copyPublicDir off, or every lab's dist would re-bundle 200MB of assets).
  publicDir: "../public",
  // Havok ships a large .wasm; keep it as a real file rather than an inlined blob.
  assetsInclude: ["**/*.wasm"],
  build: { target: "es2022", chunkSizeWarningLimit: 4000, copyPublicDir: false },
});
