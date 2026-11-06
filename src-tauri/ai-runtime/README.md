# Bundled AI runtime (build artifact)

This directory is populated by:

```bash
node backend/scripts/build-ai-runtime.mjs
```

Layout: `<target>/node/node`, `<target>/npm/` (npm CLI from the same Node
distribution), `<target>/pi/node_modules/...`, the read-only analysis extension,
the analysis system prompt and `manifest.json`. The staged files are git-ignored;
only this README is tracked so `tauri dev` finds the resource root before the
runtime is built.

`npm/` exists so Settings → Updates can refresh Pi and its npm dependencies in a
writable app-data overlay (`<app-data>/ai/runtime/<target>`) without requiring
Node/npm on the user's machine and without writing into the read-only bundle.
