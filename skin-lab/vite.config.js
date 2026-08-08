export default {
  // fs.allow one level up: shared assets (the vendored draco decoder, the skin
  // textures) live at the repo root — same as the other labs.
  server: { port: 5187, strictPort: true, fs: { allow: [".."] } },
  publicDir: "../public",
  build: { copyPublicDir: false },
};
