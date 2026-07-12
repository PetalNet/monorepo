//! Fleet control plane — the Manager's brains (fleet-manager-spec v2 §2).
//!
//! Token/credential authority over a file vault, cost/rate governance
//! (traffic light, tier downgrade before 429, cascade detection, lease-based
//! quota reclaim), tracker-discipline enforcement, and the agent capacity
//! registry. See DECISIONS-control-plane.md.

pub mod config;
pub mod discipline;
pub mod governance;
pub mod registry;
pub mod tokens;
pub mod vault;
