import { defineConfig } from "vite";

// The chart workspace is the single source of truth in `UI/web`; pointing
// publicDir at it keeps the legacy Qt app and the Tauri shell on identical
// assets (no duplicated 5k-line workspace.js that could drift).
export default defineConfig({
  root: __dirname,
  publicDir: "../UI/web",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
