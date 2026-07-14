//! Foundation crate for the relay bot. Reliability primitives are the point
//! and everything else builds on them:
//!
//! - [`bound`] — a deadline and bounded retries for EVERY external call.
//!   Nothing in the workspace is allowed to await the network without one.
//! - [`health`] — per-destination delivery health. Whether each relay leg is
//!   actually receiving messages is a first-class, queryable fact, not an
//!   inference from log noise.
//! - [`supervise`] — panic/timeout isolation for plugin work plus capped
//!   exponential backoff. One bad event or plugin can log an error at worst;
//!   it can never stall or kill the process.
//! - [`watchdog`] — an out-of-band OS-thread liveness watchdog (and startup
//!   guard) that still works when the async runtime itself is wedged.
//! - [`plugin`] — the plugin contract and registry.
//! - [`config`] — the YAML config schema (compatible with the previous
//!   generation's `config.yaml`).
//! - [`send`] / [`text`] — bounded room sends and small text helpers.

pub mod bound;
pub mod config;
pub mod health;
pub mod plugin;
pub mod send;
pub mod supervise;
pub mod text;
pub mod watchdog;
