# Bundled AI runtime (build artifact)

This directory is populated by:

```bash
node backend/scripts/build-ai-runtime.mjs
```

Layout: `<target>/node/node`, `<target>/pi/node_modules/...`, the read-only
analysis extension, the analysis system prompt and `manifest.json`. The staged
files are git-ignored; only this README is tracked so `tauri dev` finds the
resource root before the runtime is built.
