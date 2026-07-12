//! Layer-0 bus / dispatcher — the only producer of task-cards.
//!
//! Turns inbound messages (Matrix, tracker transitions, system conditions)
//! into contract task-cards, enforces the LOCKED interrupt model, and runs
//! the hybrid push/pull wanted board (CAS claim, fenced leases,
//! priority+aging). See DECISIONS-dispatcher.md for the design log and
//! `apps/manager/docs/contracts/` for the contracts this implements.

pub mod board;
pub mod card;
pub mod config;
pub mod deliver;
pub mod digest;
pub mod dispatch;
pub mod envelope;
pub mod glitchtip;
pub mod policy;
pub mod roster;
pub mod tracker;
pub mod wake;
