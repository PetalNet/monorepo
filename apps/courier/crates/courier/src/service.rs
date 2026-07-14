//! The service's name, in one place.
//!
//! "courier" is a placeholder. To rename the deployment-visible identity
//! (CLI name, default device display name), change [`SERVICE_NAME`]; crate
//! names and deploy files are covered in README.md § Renaming.

/// The service name used for the CLI and the default device display name.
pub const SERVICE_NAME: &str = "courier";
