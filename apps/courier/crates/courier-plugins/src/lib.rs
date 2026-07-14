//! The small built-in plugins: ping, echo, mode, diagnostics, and the
//! plugin manager.

mod diag;
mod echo;
mod manager;
mod mode;
mod ping;

pub use diag::DiagTool;
pub use echo::EchoTool;
pub use manager::ToolsManager;
pub use mode::ModeTool;
pub use ping::Ping;
