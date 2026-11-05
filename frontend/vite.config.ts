import { defineConfig } from "vite";

// The chart workspace is the single source of truth in `frontend/web`; pointing
// publicDir at it keeps the shared chart assets in one place (no duplicated
// 5k-line workspace.js that could drift).
export default defineConfig({
  root: __dirname,
  publicDir: "./web",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      // The hidden AI snapshot renderer is a second page in the same bundle.
      input: {
        main: "index.html",
        snapshot: "snapshot.html",
      },
    },
  },
});
