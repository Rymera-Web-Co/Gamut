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

    #[error("updater error: {0}")]
    Updater(#[from] tauri_plugin_updater::Error),

    /// Not authenticated with GitHub. A typed variant rather than a stringly
    /// `Other` for a common, distinguishable case (#138); it serializes to the
    /// same message it always did, so the frontend is unaffected.
    #[error("not signed in to GitHub")]
    NotSignedIn,

    /// A repo-relative path resolved outside the repository root (`..` traversal
    /// or symlink escape) — see `commands::files::safe_join`.
    #[error("path escapes the repository root")]
    PathEscapesRoot,

    /// GitHub returned a primary or secondary rate-limit response (#138).
    /// A typed variant rather than a stringly `Other` for a common,
    /// distinguishable case the frontend (and retry logic) can switch on; it
    /// serializes to the same message it always did, so the UI is unaffected.
    /// `context` is what we were doing ("listing pull requests"); `retry` is the
    /// already-formatted wait hint ("retry in 42s" / "retry shortly").
    #[error("GitHub rate limit reached while {context} — {retry}")]
    RateLimited { context: String, retry: String },

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
