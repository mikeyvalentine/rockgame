export default {
  // fs.allow one level up: the shared scribble dials live at the repo root.
  server: { port: 5184, strictPort: true, fs: { allow: [".."] } },
};
