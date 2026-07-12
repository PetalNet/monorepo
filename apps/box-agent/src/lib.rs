//! Box-agent — the persistent per-machine fleet agent (DAG N2.3,
//! fleet-manager-spec §3/§8): receives task-cards over the backchannel,
//! spawns/supervises disposable worker processes (OS-neutral), advertises
//! capacity, and emits fleet events. See DECISIONS-box-agent.md.

pub mod config;
pub mod events;
pub mod inbox;
pub mod worker;
