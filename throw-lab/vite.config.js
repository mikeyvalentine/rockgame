export default {
  // fs.allow one level up: shared assets (the vendored draco decoder, and later
  // the shared dials) live at the repo root — same as the other labs.
  server: { port: 5186, strictPort: true, fs: { allow: [".."] } },
  // The one shared assets folder at the repo root — see rock-forge/vite.config.js.
  publicDir: "../public",
  build: { copyPublicDir: false },
};
