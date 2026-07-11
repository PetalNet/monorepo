#[derive(Debug, thiserror::Error)]
pub enum PointCryptoError {
    #[error("MLS error: {0}")]
    Mls(String),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Group not found: {0}")]
    GroupNotFound(String),

    #[error("Key package error: {0}")]
    KeyPackage(String),

    #[error("Decryption failed")]
    DecryptionFailed,

    #[error("Invalid state: {0}")]
    InvalidState(String),
}

pub type Result<T> = std::result::Result<T, PointCryptoError>;
