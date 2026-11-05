//! Integrated, read-only Pi analysis runtime.

pub mod auth;
pub mod commands;
pub mod context;
pub mod lines;
pub mod manager;
pub mod paths;
pub mod probe;
pub mod runtime;
pub mod spawn;
pub mod store;

pub use manager::AiManager;
