use serde::{Serialize, Serializer};

/// Application-wide error type. Implements `Serialize` so it can be returned
/// directly from `#[tauri::command]` functions and surfaced to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("not a git repository: {0}")]
    NotARepo(String),

    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("keychain error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
