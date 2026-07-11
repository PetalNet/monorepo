//! WebSocket transport: live location stream (JSON frames carrying MLS
//! ciphertext). Auth is the first message, never in the URL.

// The hub is consumed by the WS/location wave (M0 wave B).
#[allow(dead_code)]
pub mod hub;
