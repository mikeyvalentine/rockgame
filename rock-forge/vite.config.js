export default {
  // fs.allow one level up: the shared scribble dials live at the repo root.
  server: { port: 5184, strictPort: true, fs: { allow: [".."] } },
  // The one shared assets folder at the repo root — see rock-sift/vite.config.js.
  publicDir: "../public",
  build: { copyPublicDir: false },
};
