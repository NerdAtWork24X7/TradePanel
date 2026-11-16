//! Host-owned directories for the Pi process.
//!
//! Everything the child can see lives under `<app-data>/ai`: an isolated home,
//! Pi's agent directory (`models.json`), an empty working directory so project
//! instructions cannot be discovered, and the latest context snapshot.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct PiPaths {
    /// `<app-data>/ai` (also the child's HOME).
    pub root: PathBuf,
    /// Pi's agent directory: `models.json`, auth data.
    pub agent: PathBuf,
    /// Pi's session files (unused with `--no-session`, kept for diagnostics).
    pub sessions: PathBuf,
    /// Empty working directory: no AGENTS.md, no project trust.
    pub workspace: PathBuf,
    /// The read-only snapshot the `panel_*` tools read.
    pub context_file: PathBuf,
}

impl PiPaths {
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        let root = app.path().app_data_dir().map_err(|e| format!("app data directory: {e}"))?.join("ai");
        Ok(Self {
            agent: root.join("agent"),
            sessions: root.join("sessions"),
            workspace: root.join("workspace"),
            context_file: root.join("context.json"),
            root,
        })
    }

    pub fn create(&self) -> Result<(), String> {
        for dir in [&self.root, &self.agent, &self.sessions, &self.workspace] {
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        Ok(())
    }
}
