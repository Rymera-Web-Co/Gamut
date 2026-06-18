//! In-app updater commands with runtime channel selection (stable | nightly).
//!
//! These replace direct frontend use of `@tauri-apps/plugin-updater`'s `check()`
//! so the update endpoint can be chosen at runtime from the `pref.updateChannel`
//! setting — the JS `check()` has no runtime endpoint override.
//!
//! `check_for_update` builds a channel-aware updater via
//! `tauri_plugin_updater::UpdaterExt`, pointing it at the stable
//! (`releases/latest/download/latest.json`) or nightly
//! (`releases/download/nightly/latest.json`) signed manifest, and reports whether
//! a newer version is available. `download_and_install_update` downloads and
//! installs the update, emitting `UPDATER_DOWNLOAD_EVENT` progress as bytes
//! arrive. The frontend (`src/lib/updater.ts`) invokes both and listens for
//! progress; relaunch is left to `tauri-plugin-process`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::commands::settings;
use crate::error::AppResult;
use crate::state::AppState;

/// Event name carrying download progress to the frontend (payload: `DownloadProgress`).
pub const UPDATER_DOWNLOAD_EVENT: &str = "updater://download";

/// Settings key holding the active update channel ("stable" | "nightly").
const SETTING_CHANNEL: &str = "pref.updateChannel";

/// Signed manifest for the latest stable release.
const STABLE_ENDPOINT: &str =
    "https://github.com/Rymera-Web-Co/Gamut/releases/latest/download/latest.json";
/// Signed manifest published under the rolling `nightly` release tag.
const NIGHTLY_ENDPOINT: &str =
    "https://github.com/Rymera-Web-Co/Gamut/releases/download/nightly/latest.json";

/// Build a channel-aware updater. Reads `pref.updateChannel` from the settings
/// table (defaulting to — and falling back for any unknown value to — `stable`)
/// and points the updater at that channel's signed manifest. Signature
/// verification is identical for both channels (same minisign keypair).
fn build_updater(app: &AppHandle, state: &AppState) -> AppResult<Updater> {
    let channel = settings::get(state, SETTING_CHANNEL)?.unwrap_or_default();
    let endpoint = match channel.as_str() {
        "nightly" => NIGHTLY_ENDPOINT,
        _ => STABLE_ENDPOINT,
    };
    let url = url::Url::parse(endpoint)
        .map_err(|e| crate::error::AppError::Other(format!("invalid updater endpoint: {e}")))?;
    Ok(app.updater_builder().endpoints(vec![url])?.build()?)
}

/// Map a resolved update to the frontend-facing `UpdateInfo`.
fn update_info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|d| d.to_string()),
    }
}

/// Metadata for an available update (camelCase for the frontend).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Download progress payload emitted on `UPDATER_DOWNLOAD_EVENT`.
/// `total` is 0 when the content length is unknown; `done` marks completion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub done: bool,
}

/// Check the active channel's endpoint for an available update.
///
/// Reads `pref.updateChannel` and queries the matching signed manifest (stable →
/// `releases/latest/download/latest.json`, nightly → `releases/download/nightly/latest.json`).
/// Returns `Some(UpdateInfo)` when an update is available, `None` otherwise.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<UpdateInfo>> {
    let updater = build_updater(&app, &state)?;
    Ok(updater.check().await?.map(|u| update_info(&u)))
}

/// Download + install the pending update for the active channel, emitting
/// `UPDATER_DOWNLOAD_EVENT` with `DownloadProgress` as bytes arrive and a final
/// `done: true` event on completion.
///
/// Returns `true` when an update was found and installed, `false` when the
/// channel's manifest reports no available update (e.g. the rolling release
/// changed between the frontend's check and this download) — the caller uses
/// this to avoid a false "restart to finish" prompt when nothing was installed.
///
/// Does not relaunch — the frontend triggers relaunch via `tauri-plugin-process`
/// after the install replaces the running bundle.
#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<bool> {
    let updater = build_updater(&app, &state)?;
    let Some(update) = updater.check().await? else {
        return Ok(false);
    };

    // Shared between the two callbacks: the chunk callback accumulates bytes and
    // records the content length, the finish callback reads them for the terminal
    // event. Atomics keep the command future `Send` (required by Tauri's IPC).
    let downloaded = Arc::new(AtomicU64::new(0));
    let total = Arc::new(AtomicU64::new(0));
    let on_chunk = {
        let downloaded = Arc::clone(&downloaded);
        let total = Arc::clone(&total);
        let app = app.clone();
        move |chunk_length: usize, content_length: Option<u64>| {
            let downloaded =
                downloaded.fetch_add(chunk_length as u64, Ordering::Relaxed) + chunk_length as u64;
            let total_val = content_length.unwrap_or(0);
            total.store(total_val, Ordering::Relaxed);
            let _ = app.emit(
                UPDATER_DOWNLOAD_EVENT,
                DownloadProgress {
                    downloaded,
                    total: total_val,
                    done: false,
                },
            );
        }
    };
    let on_finish = {
        let downloaded = Arc::clone(&downloaded);
        let total = Arc::clone(&total);
        let app = app.clone();
        move || {
            let _ = app.emit(
                UPDATER_DOWNLOAD_EVENT,
                DownloadProgress {
                    downloaded: downloaded.load(Ordering::Relaxed),
                    total: total.load(Ordering::Relaxed),
                    done: true,
                },
            );
        }
    };

    update.download_and_install(on_chunk, on_finish).await?;

    Ok(true)
}
