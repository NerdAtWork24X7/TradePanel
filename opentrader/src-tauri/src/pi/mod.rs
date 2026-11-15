//! Integrated, read-only Pi analysis runtime ("Analyze chart").
//!
//! The bundled `ai/runtime` stage (Node + `@earendil-works/pi-coding-agent`)
//! runs as one supervised subprocess. The window sends a versioned context
//! snapshot and the rendered chart; the extension exposes only the five
//! `panel_*` tools, and the host validates every level the model proposes.
//! Nothing here can place or change an order: the trade card is a suggestion
//! the user copies into the ticket themselves.

pub mod commands;
pub mod context;
pub mod lines;
pub mod manager;
pub mod paths;
pub mod runtime;
pub mod settings;
pub mod spawn;

pub use manager::PiManager;
