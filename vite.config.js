import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  preview: { port: 5180 },
  build: {
    target: 'esnext',
    // tools/build-site.mjs assembles the deployed site: it copies only the
    // git-tracked slice of public/assets (the local folder also holds the
    // full 167MB texture library, which stays out of the repo and the deploy).
    copyPublicDir: false,
    rollupOptions: {
      output: {
        // Babylon is the bulk of the bundle and is only needed once the player
        // starts a throw. Keeping it in its own chunk is what makes the loading
        // screen's progress bar mean something.
        manualChunks(id) {
          if (id.includes('@babylonjs')) return 'babylon';
          if (id.includes('@supabase')) return 'supabase';
        },
      },
    },
  },
});
